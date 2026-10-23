import { z } from "zod";
import type { NativePublicHeaderProofFailure } from "./native-redirect-routing";

// Keep these diagnostic-only literals aligned with the native producer. A
// runtime import of native routing would create a recipe/schema import cycle.
export const publicHeaderDiagnosticNativeFactKeys = ["nativeDocumentCurrent", "nativeRecordPresent", "nativeRecordFailed", "nativeRequestCancelled",
  "nativeGenerationCurrent", "nativeGenerationRetired", "nativeLoaderCurrent", "nativeIdentityPresent", "nativeIdentityRevisionCurrent",
  "nativeIdentityFailed", "nativeSourceIdentityCurrent", "nativeSourceFailed", "nativeSourceGenerationCurrent", "nativeSourceLoaderCurrent", "nativeSourceRootFrame",
  "nativeSourceFetchRecordPresent", "nativeSourceFetchAdmitted", "nativeSourceFetchFailed", "nativeSourceFetchHandlerDone",
  "nativeSourceLoadingFailedCanceledPresent", "nativeSourceLoadingFailedCanceled", "nativeSourceLoadingFailedCorsErrorPresent"] as const;
export const publicHeaderDiagnosticErrorKinds = ["ABORTED", "BLOCKED_BY_CLIENT", "TIMED_OUT", "FAILED", "OTHER"] as const;
export const publicHeaderDiagnosticCorsErrors = ["DisallowedByMode", "InvalidResponse", "WildcardOriginNotAllowed", "MissingAllowOriginHeader",
  "MultipleAllowOriginValues", "InvalidAllowOriginValue", "AllowOriginMismatch", "InvalidAllowCredentials", "CorsDisabledScheme", "PreflightInvalidStatus",
  "PreflightDisallowedRedirect", "PreflightWildcardOriginNotAllowed", "PreflightMissingAllowOriginHeader", "PreflightMultipleAllowOriginValues",
  "PreflightInvalidAllowOriginValue", "PreflightAllowOriginMismatch", "PreflightInvalidAllowCredentials", "PreflightMissingAllowExternal", "PreflightInvalidAllowExternal",
  "InvalidAllowMethodsPreflightResponse", "InvalidAllowHeadersPreflightResponse", "MethodDisallowedByPreflightResponse", "HeaderDisallowedByPreflightResponse",
  "RedirectContainsCredentials", "InsecureLocalNetwork", "InvalidLocalNetworkAccess", "NoCorsRedirectModeNotFollow", "LocalNetworkAccessPermissionDenied", "OTHER"] as const;
export const publicHeaderDiagnosticFailureReasons = ["PROOF_NOT_ATTESTED", "SCRIPT_VERSION_CHANGED", "REVOCATION_EPOCH_CHANGED",
  "DOCUMENT_NOT_CURRENT", "PUBLIC_VALUES_MISSING", "PUBLIC_SOURCE_INVALID", "REQUEST_SIGNATURE_CHANGED", "OWNER_CLOSED", "CONTEXT_CHANGED", "NATIVE_RECORD_NOT_CURRENT"] as const;
const nativeFactShape = Object.fromEntries(publicHeaderDiagnosticNativeFactKeys.map(key => [key, z.boolean().optional()])) as {
  [Key in typeof publicHeaderDiagnosticNativeFactKeys[number]]: z.ZodOptional<z.ZodBoolean>;
};

/** A projection of an observed denial, never request/admission evidence. */
export const publicHeaderFailureDiagnosticSchema = z.object({
  stage: z.enum(["HEADER_PROOF_MISSING", "HEADER_PROOF_REVOKED_AFTER_QUEUE"]),
  requestedPreflightMethod: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"]).optional(),
  ordinaryPreflightMethod: z.enum(["GET", "HEAD", "POST"]).nullable(),
  privateProofFailureReason: z.enum([...publicHeaderDiagnosticFailureReasons, "UNOBSERVED"]),
  ...nativeFactShape,
  nativeSourceLoadingFailedErrorKind: z.enum(publicHeaderDiagnosticErrorKinds).optional(),
  nativeSourceLoadingFailedCorsError: z.enum(publicHeaderDiagnosticCorsErrors).optional(),
  authorizationShape: z.enum(["MISSING", "BEARER_NULL", "OTHER_REDACTED"]),
  apiKeyPresent: z.boolean(), proxyAuthorizationPresent: z.boolean(), cookiePresent: z.boolean(),
  duplicateHeaderNames: z.boolean(), headerCount: z.number().int().min(0).max(128), headerNamesTruncated: z.boolean(),
  sensitiveCompanionPresent: z.boolean(), requestedHeaderListPresent: z.boolean(),
  requestedHeaderCount: z.number().int().min(0).max(128), requestedHeaderSyntaxValid: z.boolean(),
  requestedHeaderDuplicates: z.boolean(), requestedAuthorization: z.boolean(), requestedApiKey: z.boolean(), requestedUnknownHeader: z.boolean(),
}).strict();
export type PublicHeaderFailureDiagnostic = z.infer<typeof publicHeaderFailureDiagnosticSchema>;

const publicHeaderFailureReasons = new Set<NativePublicHeaderProofFailure["reason"]>(publicHeaderDiagnosticFailureReasons);
/** Closed observations explain an unchanged header denial; none authorize a request. */
export function publicHeaderFailureDiagnostic(stage: "HEADER_PROOF_MISSING" | "HEADER_PROOF_REVOKED_AFTER_QUEUE", method: string,
  requestHeaders: Record<string, string>, ordinaryPreflightMethod: "GET" | "HEAD" | "POST" | null, proofFailure?: NativePublicHeaderProofFailure | null): PublicHeaderFailureDiagnostic {
  const entries = Object.entries(requestHeaders), names = entries.map(([name]) => name.toLowerCase());
  const values = (name: string) => entries.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  const authorization = values("authorization"), requestedMethod = values("access-control-request-method"), requested = values("access-control-request-headers");
  const requestedNames = requested.length === 1 && requested[0].length <= 512 ? requested[0].split(",").map(name => name.trim().toLowerCase()) : [];
  const knownRequested = new Set(["accept", "accept-language", "cache-control", "pragma", "content-type", "authorization", "x-api-key",
    "x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"]);
  const requestedPreflightMethod = requestedMethod.length === 1 && /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/u.test(requestedMethod[0])
    ? requestedMethod[0] as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "CONNECT" | "TRACE" : "OTHER";
  const nativeFacts: Partial<Record<typeof publicHeaderDiagnosticNativeFactKeys[number], boolean>> = {};
  for (const key of publicHeaderDiagnosticNativeFactKeys) if (typeof proofFailure?.[key] === "boolean") nativeFacts[key] = proofFailure[key];
  return { stage, ...(method === "OPTIONS" && requestedMethod.length ? { requestedPreflightMethod } : {}), ordinaryPreflightMethod,
    privateProofFailureReason: proofFailure && publicHeaderFailureReasons.has(proofFailure.reason) ? proofFailure.reason : "UNOBSERVED" as const, ...nativeFacts,
    ...(proofFailure?.nativeSourceLoadingFailedErrorKind && publicHeaderDiagnosticErrorKinds.includes(proofFailure.nativeSourceLoadingFailedErrorKind)
      ? { nativeSourceLoadingFailedErrorKind: proofFailure.nativeSourceLoadingFailedErrorKind } : {}),
    ...(proofFailure?.nativeSourceLoadingFailedCorsError && publicHeaderDiagnosticCorsErrors.includes(proofFailure.nativeSourceLoadingFailedCorsError)
      ? { nativeSourceLoadingFailedCorsError: proofFailure.nativeSourceLoadingFailedCorsError } : {}),
    authorizationShape: authorization.length === 0 ? "MISSING" as const : authorization.length === 1 && authorization[0] === "Bearer null" ? "BEARER_NULL" as const : "OTHER_REDACTED" as const,
    apiKeyPresent: names.includes("x-api-key"), proxyAuthorizationPresent: names.includes("proxy-authorization"), cookiePresent: names.includes("cookie"),
    duplicateHeaderNames: new Set(names).size !== names.length, headerCount: Math.min(entries.length, 128), headerNamesTruncated: entries.length > 128,
    sensitiveCompanionPresent: names.some(name => !["authorization", "x-api-key", "cookie"].includes(name) && /authorization|token|secret|api[-_]?key|credential|csrf|session/iu.test(name) &&
      !["x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"].includes(name)),
    requestedHeaderListPresent: requested.length > 0, requestedHeaderCount: Math.min(requestedNames.length, 128),
    requestedHeaderSyntaxValid: requested.length === 1 && requested[0].length <= 512 && requestedNames.length > 0 && requestedNames.length <= 16 &&
      requestedNames.every(name => /^[a-z0-9-]{1,80}$/u.test(name)),
    requestedHeaderDuplicates: new Set(requestedNames).size !== requestedNames.length,
    requestedAuthorization: requestedNames.includes("authorization"), requestedApiKey: requestedNames.includes("x-api-key"),
    requestedUnknownHeader: requestedNames.some(name => !knownRequested.has(name)) };
}
