import { describe, expect, it } from "vitest";
import { blockedResourceDiagnosticsSchema, createBlockedResourceDiagnostics } from "./simulator-blocked-resources";

describe("blocked resource diagnostics", () => {
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
