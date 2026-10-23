import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicHeaderFailureDiagnostic, publicHeaderFailureDiagnosticSchema, publicHeaderDiagnosticNativeFactKeys,
  publicHeaderDiagnosticErrorKinds, publicHeaderDiagnosticCorsErrors, publicHeaderDiagnosticFailureReasons } from "./public-header-diagnostic";

const missing = () => publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", {
  "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-api-key",
}, null);

describe("public header failure diagnostics", () => {
  it("keeps initial missing proof distinct from actually observed post-queue revocation without returning private material", () => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", {
      Authorization: "Bearer null", "x-api-key": "private-key-sentinel", "x-ms-request-id": "private-correlation-sentinel",
      "X-Private-Token-Sentinel": "private-header-value", "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,x-api-key,x-private-token-sentinel",
    }, null);
    expect(diagnostic).toMatchObject({ stage: "HEADER_PROOF_MISSING", requestedPreflightMethod: "GET", ordinaryPreflightMethod: null,
      privateProofFailureReason: "UNOBSERVED", authorizationShape: "BEARER_NULL", apiKeyPresent: true,
      sensitiveCompanionPresent: true, requestedAuthorization: true, requestedApiKey: true, requestedUnknownHeader: true });
    expect(publicHeaderFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    const proof = { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceFailed: true, nativeSourceFetchRecordPresent: false,
      nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: true, nativeSourceLoadingFailedErrorKind: "ABORTED",
      nativeSourceLoadingFailedCorsErrorPresent: false, headers: "private-native-header-sentinel", digest: "private-native-digest-sentinel" };
    const before = JSON.stringify(proof), revoked = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "OPTIONS", {}, null, proof as never);
    expect(revoked).toMatchObject({ stage: "HEADER_PROOF_REVOKED_AFTER_QUEUE", privateProofFailureReason: "NATIVE_RECORD_NOT_CURRENT",
      nativeSourceFailed: true, nativeSourceFetchRecordPresent: false, nativeSourceLoadingFailedCanceled: true, nativeSourceLoadingFailedErrorKind: "ABORTED" });
    expect(publicHeaderFailureDiagnosticSchema.parse(revoked)).toEqual(revoked);expect(JSON.stringify(proof)).toBe(before);
    for (const privateText of ["private-key-sentinel", "private-correlation-sentinel", "private-header-value", "x-private-token-sentinel",
      "private-native-header-sentinel", "private-native-digest-sentinel"]) expect(JSON.stringify({ diagnostic, revoked }).toLowerCase()).not.toContain(privateText);
  });

  it("retains exactly the native producer's closed boolean/error/CORS vocabulary without importing routing at runtime", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/course-discovery/native-redirect-routing.ts"), "utf8");
    const literal = (name: string) => {
      const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`, "u"));
      expect(match, name).not.toBeNull();return JSON.parse(`[${match![1]}]`) as string[];
    };
    expect(publicHeaderDiagnosticNativeFactKeys).toEqual(literal("nativePublicHeaderFailureFactKeys"));
    expect(publicHeaderDiagnosticErrorKinds).toEqual(literal("nativeSourceLoadingFailedErrorKinds"));
    expect(publicHeaderDiagnosticCorsErrors).toEqual(literal("nativeSourceLoadingFailedCorsErrors"));
    const helper = readFileSync(join(process.cwd(), "src/lib/course-discovery/public-header-diagnostic.ts"), "utf8");
    expect(helper).toContain('import type { NativePublicHeaderProofFailure }');
    expect(helper).not.toMatch(/^import (?!type).*from "\.\/native-/mu);
  });

  it.each(publicHeaderDiagnosticFailureReasons)("preserves observed first failure %s", reason => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null, { reason });
    expect(diagnostic.privateProofFailureReason).toBe(reason);expect(publicHeaderFailureDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  });
  it.each(publicHeaderDiagnosticNativeFactKeys)("only copies an actual boolean for %s", key => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", [key]: true } as never);
    expect(diagnostic).toHaveProperty(key, true);expect(publicHeaderFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", [key]: "private-sentinel" } as never)).not.toHaveProperty(key);
  });
  it.each(publicHeaderDiagnosticErrorKinds)("retains closed loading failure kind %s", value => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceLoadingFailedErrorKind: value });
    expect(diagnostic.nativeSourceLoadingFailedErrorKind).toBe(value);expect(publicHeaderFailureDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  });
  it.each(publicHeaderDiagnosticCorsErrors)("retains closed protocol CORS enum %s", value => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceLoadingFailedCorsError: value });
    expect(diagnostic.nativeSourceLoadingFailedCorsError).toBe(value);expect(publicHeaderFailureDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  });

  it("does not infer an unobserved private failure or retain unknown producer strings", () => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "GET", {}, null,
      { reason: "private-failure-sentinel", nativeSourceLoadingFailedErrorKind: "private-error-sentinel",
        nativeSourceLoadingFailedCorsError: "private-cors-sentinel", nativeRecordFailed: "private-flag-sentinel" } as never);
    expect(diagnostic.privateProofFailureReason).toBe("UNOBSERVED");expect(publicHeaderFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(diagnostic).not.toHaveProperty("nativeSourceLoadingFailedErrorKind");expect(diagnostic).not.toHaveProperty("nativeSourceLoadingFailedCorsError");
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"])("reports only the closed actual requested method %s", method => {
    const diagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", { "access-control-request-method": method }, null);
    expect(diagnostic.requestedPreflightMethod).toBe(method);expect(publicHeaderFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "GET", { "access-control-request-method": method }, null)).not.toHaveProperty("requestedPreflightMethod");
  });
  it("bounds counts and exposes duplicates/syntax categories without listing arbitrary names", () => {
    const duplicate = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", { Authorization: "Bearer null", authorization: "Bearer null",
      "Access-Control-Request-Method": "GET", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key,x-api-key" }, null);
    expect(duplicate).toMatchObject({ duplicateHeaderNames: true, authorizationShape: "OTHER_REDACTED", requestedPreflightMethod: "OTHER", requestedHeaderDuplicates: true });
    const long = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", { "access-control-request-headers": "private-name-sentinel".repeat(30),
      ...Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`x-unused-${index}`, "private-value-sentinel"])) }, null);
    expect(long).toMatchObject({ headerCount: 128, headerNamesTruncated: true, requestedHeaderListPresent: true, requestedHeaderCount: 0, requestedHeaderSyntaxValid: false });
    expect(publicHeaderFailureDiagnosticSchema.parse(long)).toEqual(long);expect(JSON.stringify(long)).not.toContain("private-");
    expect(publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", "OPTIONS", {}, "GET")).not.toHaveProperty("requestedPreflightMethod");
  });

  it.each(["headers", "authorization", "apiKey", "body", "url", "digest", "failedParameter", "publicHeaderFailure"])("schema rejects undeclared private or recursive field %s", key => {
    expect(publicHeaderFailureDiagnosticSchema.safeParse({ ...missing(), [key]: "private-sentinel" }).success).toBe(false);
  });
  it.each([
    { stage: "REQUEST_ALLOWED" }, { ordinaryPreflightMethod: "PUT" }, { requestedPreflightMethod: "private-method" },
    { privateProofFailureReason: "private-reason" }, { authorizationShape: "Bearer private-value" },
    { nativeSourceLoadingFailedCorsError: "private-cors" }, { nativeSourceLoadingFailedErrorKind: "private-error" },
    { headerCount: -1 }, { headerCount: 129 }, { headerCount: 1.5 }, { requestedHeaderCount: 129 },
    { nativeSourceFailed: "private-value" }, { requestedApiKey: 1 },
  ])("schema rejects non-closed or out-of-range diagnostic data %#", change => {
    expect(publicHeaderFailureDiagnosticSchema.safeParse({ ...missing(), ...change }).success).toBe(false);
  });
});
