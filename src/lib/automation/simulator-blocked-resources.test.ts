import { describe, expect, it } from "vitest";
import { blockedResourceDiagnosticsSchema, createBlockedResourceDiagnostics, simulatorCredentialHeaderKind, summarizeBlockedRequestBody } from "./simulator-blocked-resources";

describe("blocked resource diagnostics", () => {
  it("retains only an explicitly screened blocked POST origin and keeps destinations distinct", () => {
    const recorder = createBlockedResourceDiagnostics();
    const shape = summarizeBlockedRequestBody('{"date":"private-date"}', "application/json");
    for (const origin of ["https://first.example.test", "https://second.example.test"]) {
      recorder.record({ url: `${origin}/api/availability/private-id?date=private-date`, kind: "xhr", method: "POST",
        reason: "METHOD_NOT_ALLOWED", originRelation: "OTHER_ORIGIN", bodyShape: shape, declaredOrigin: origin });
    }
    recorder.record({ url: "https://first.example.test/api/availability/private-id", kind: "xhr", method: "POST",
      reason: "METHOD_NOT_ALLOWED", originRelation: "OTHER_ORIGIN", bodyShape: shape });
    const rows = recorder.fields().blockedResourceDiagnostics!;
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.declaredOrigin)).toEqual(["https://first.example.test", "https://second.example.test", undefined]);
    expect(blockedResourceDiagnosticsSchema.parse(rows)).toEqual(rows);
    expect(JSON.stringify(rows)).not.toMatch(/private-id|private-date|\?date/u);
  });
  it.each([
    { url: "https://user:private@api.example.test/path" },
    { url: "https://api.example.test/path?token=private" },
    { url: "http://api.example.test/path" },
    { declaredOrigin: "https://different.example.test" },
    { kind: "script" }, { method: "GET" }, { method: "PUT" },
    { reason: "SENSITIVE_HEADERS", headerKinds: ["TOKEN"] },
    { originRelation: "SAME_SITE" },
    { bodyShape: { format: "JSON", fieldKinds: ["AUTH"], operationHints: [] } },
    { bodyShape: { format: "JSON", fieldKinds: ["CONTACT"], operationHints: [] } },
    { bodyShape: { format: "OVERSIZED", fieldKinds: [], operationHints: [] } },
    { bodyShape: { format: "JSON", fieldKinds: ["ACTION"], operationHints: ["WRITE"] } },
    { bodyShape: { format: "FORM", fieldKinds: ["ACTION"], operationHints: ["FORM"] } },
    { bodyShape: { format: "JSON", fieldKinds: ["ACTION"], operationHints: ["BOOKING"] } },
    { bodyShape: undefined },
  ])("withholds the origin from unscreened or unrelated input %j", patch => {
    const recorder = createBlockedResourceDiagnostics();
    recorder.record({ url: "https://api.example.test/path", kind: "xhr", method: "POST", reason: "METHOD_NOT_ALLOWED",
      originRelation: "OTHER_ORIGIN", declaredOrigin: "https://api.example.test",
      bodyShape: { format: "EMPTY", fieldKinds: [], operationHints: [] }, ...patch } as Parameters<typeof recorder.record>[0]);
    expect(recorder.fields().blockedResourceDiagnostics?.[0].declaredOrigin).toBeUndefined();
  });
  it("rejects forged persisted origin shapes or diagnostic contexts", () => {
    const entry = { state: "NOT_EXECUTED", resourceKind: "XHR", method: "POST", reason: "METHOD_NOT_ALLOWED",
      originRelation: "OTHER_ORIGIN", pathShape: "/api/availability", count: 1,
      bodyShape: { format: "EMPTY", fieldKinds: [], operationHints: [] }, declaredOrigin: "https://api.example.test" };
    expect(blockedResourceDiagnosticsSchema.safeParse([entry]).success).toBe(true);
    for (const patch of [{ declaredOrigin: "https://api.example.test/path" }, { declaredOrigin: "https://api.example.test?token=private" },
      { declaredOrigin: "http://127.0.0.1" }, { reason: "UNSAFE_URL" }, { bodyShape: undefined }, { method: "DELETE" }]) {
      expect(blockedResourceDiagnosticsSchema.safeParse([{ ...entry, ...patch }]).success).toBe(false);
    }
  });
  it("keeps closed body field classes and lexical hints while discarding every submitted value", () => {
    const form = summarizeBlockedRequestBody("action=submit_newsletter_form&email=private%40example.test&nonce=private-secret", "application/x-www-form-urlencoded; charset=utf-8");
    expect(form).toEqual({ format: "FORM", fieldKinds: ["ACTION", "AUTH", "CONTACT"], operationHints: ["FORM", "WRITE"] });
    expect(JSON.stringify(form)).not.toMatch(/private|newsletter|nonce|email/u);
    expect(summarizeBlockedRequestBody("", "text/plain").format).toBe("EMPTY");
    expect(summarizeBlockedRequestBody("{broken", "application/json").format).toBe("OTHER");
    expect(summarizeBlockedRequestBody("x".repeat(16385), "application/json").format).toBe("OVERSIZED");
    expect(summarizeBlockedRequestBody('"private"', "application/json").format).toBe("OTHER");
    expect(summarizeBlockedRequestBody(JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field${i}`, "private"]))), "application/json").truncated).toBe(true);
    expect(summarizeBlockedRequestBody(JSON.stringify({ action: "a".repeat(513) }), "application/json").truncated).toBe(true);
  });
  it("handles bounded multipart field labels without retaining file or form contents", () => {
    const body = '--boundary\r\nContent-Disposition: form-data; name="action"\r\n\r\nget_slots\r\n--boundary\r\nContent-Disposition: form-data; name="email"\r\n\r\nprivate@example.test\r\n--boundary\r\nContent-Disposition: form-data; name="attachment"; filename="private.txt"\r\n\r\nprivate-file-content\r\n--boundary--\r\n';
    const shape = summarizeBlockedRequestBody(body, 'multipart/form-data; boundary="boundary"');
    expect(shape).toEqual({ format: "FORM", fieldKinds: ["ACTION", "CONTACT", "OTHER"], operationHints: ["AVAILABILITY", "READ"] });
    expect(JSON.stringify(shape)).not.toMatch(/private|boundary|attachment/u);
    expect(summarizeBlockedRequestBody(body, "multipart/form-data").format).toBe("OTHER");
  });
  it.each([
    ["getAvailability", ["AVAILABILITY", "READ"]],
    ["GetCalendarSlots", ["AVAILABILITY", "READ"]],
    ["createBooking", ["BOOKING", "WRITE"]],
  ])("retains only closed lexical hints for camel-case operation %s", (operation, hints) => {
    const shape = summarizeBlockedRequestBody(JSON.stringify({ operation, customerEmail: "private@example.test", token: "private-token" }), "application/json");
    expect(shape.operationHints).toEqual(hints);
    expect(JSON.stringify(shape)).not.toMatch(/private|customer|token|getAvailability|GetCalendarSlots|createBooking/u);
  });
  it("projects credential classes without retaining arbitrary header names or values", () => {
    expect(["Cookie", "authorization", "x-api-key", "x-auth-token", "private-secret", "accept", "x-cookie"].map(simulatorCredentialHeaderKind))
      .toEqual(["COOKIE", "AUTHORIZATION", "API_KEY", "TOKEN", "OTHER_CREDENTIAL", undefined, "OTHER_CREDENTIAL"]);
    const recorder = createBlockedResourceDiagnostics();
    recorder.record({ url: "https://source.test/script", kind: "script", method: "GET", reason: "SENSITIVE_HEADERS",
      originRelation: "SAME_SITE", headerKinds: ["TOKEN", "COOKIE", "TOKEN"] });
    const entry = recorder.fields().blockedResourceDiagnostics![0];
    expect(entry.headerKinds).toEqual(["COOKIE", "TOKEN"]);
    expect(blockedResourceDiagnosticsSchema.parse([entry])).toEqual([entry]);
    expect(() => blockedResourceDiagnosticsSchema.parse([{ ...entry, reason: "UNSCOPED_DESTINATION" }])).toThrow();
    expect(() => blockedResourceDiagnosticsSchema.parse([{ ...entry, headerKinds: ["private-secret"] }])).toThrow();
  });
  it("distinguishes a blocked data request from passive assets without retaining private request material", () => {
    const recorder = createBlockedResourceDiagnostics();
    recorder.record({ url: "https://private.example/owner-123/photo?token=secret", kind: "image", method: "GET",
      reason: "RESOURCE_KIND_NOT_ALLOWED", originRelation: "OTHER_ORIGIN" });
    expect(recorder.hasUnresolvedActiveResource()).toBe(false);
    recorder.record({ url: "https://private.example/api/availability/owner-123?email=private@example.test", kind: "fetch", method: "GET",
      reason: "UNSCOPED_DESTINATION", originRelation: "OTHER_ORIGIN" });
    expect(recorder.hasUnresolvedActiveResource()).toBe(true);
    expect(recorder.fields().blockedResourceDiagnostics).toEqual([
      { state: "NOT_EXECUTED", resourceKind: "OTHER", method: "GET", reason: "RESOURCE_KIND_NOT_ALLOWED", originRelation: "OTHER_ORIGIN", pathShape: "/:value/:value", count: 1 },
      { state: "NOT_EXECUTED", resourceKind: "FETCH", method: "GET", reason: "UNSCOPED_DESTINATION", originRelation: "OTHER_ORIGIN", pathShape: "/api/availability/:value", count: 1 },
    ]);
    expect(JSON.stringify(recorder.fields())).not.toMatch(/private|owner-123|token|secret|email|example/u);
    expect(blockedResourceDiagnosticsSchema.parse(recorder.fields().blockedResourceDiagnostics)).toHaveLength(2);
  });

  it("caps retained counts and still recognizes active failures after diagnostics truncate", () => {
    const recorder = createBlockedResourceDiagnostics();
    for (let i = 0; i < 40; i++) recorder.record({ url: "https://source.test/image", kind: "image", method: "GET",
      reason: "RESOURCE_KIND_NOT_ALLOWED", originRelation: "SAME_SITE" });
    recorder.record({ url: "https://source.test/api", kind: "script", method: "GET", reason: "SENSITIVE_HEADERS", originRelation: "SAME_SITE" });
    expect(recorder.fields()).toMatchObject({ blockedResourceDiagnosticsTruncated: true,
      blockedResourceDiagnostics: [{ resourceKind: "OTHER", count: 32 }] });
    expect(recorder.hasUnresolvedActiveResource()).toBe(true);
  });

  it("rejects raw fields, forged reasons, duplicate shapes and over-budget counts", () => {
    const recorder = createBlockedResourceDiagnostics();
    recorder.record({ url: "not a url", kind: "fetch", method: "CUSTOM", reason: "UNSAFE_URL", originRelation: "UNKNOWN" });
    const entry = recorder.fields().blockedResourceDiagnostics![0];
    expect(entry).toMatchObject({ method: "OTHER", pathShape: "/" });
    for (const invalid of [[{ ...entry, url: "https://private.test" }], [{ ...entry, reason: "PRIVATE_REASON" }],
      [entry, entry], [{ ...entry, count: 33 }]]) expect(() => blockedResourceDiagnosticsSchema.parse(invalid)).toThrow();
  });
});
