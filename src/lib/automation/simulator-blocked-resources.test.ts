import { describe, expect, it } from "vitest";
import { blockedResourceDiagnosticsSchema, createBlockedResourceDiagnostics, simulatorCredentialHeaderKind, summarizeBlockedRequestBody } from "./simulator-blocked-resources";

describe("blocked resource diagnostics", () => {
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
