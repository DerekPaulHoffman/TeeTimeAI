/** Private error-origin transport facts. These facts never confer source or availability authority. */
export type FixedAdapterReadDiagnostic = {
  stage: "TRANSPORT" | "RESPONSE_HEADERS" | "RESPONSE_BODY";
  role: "TEEITUP_DIRECTORY";
  httpStatus: number | null;
  responseRedirected: boolean | null;
  responseUrlMatches: boolean | null;
  elapsedMs: number;
  responseBytes: number | null;
  transportCode: "NONE" | "UNKNOWN" | "ABORT" | "TIMEOUT" | "ENOTFOUND" | "EAI_AGAIN" | "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" | "TLS_CERTIFICATE" | "BODY_LIMIT";
};
const failures = new WeakMap<object, FixedAdapterReadDiagnostic>();
export function fixedAdapterTransportCode(error: unknown): FixedAdapterReadDiagnostic["transportCode"] {
  try {
    if (!error || typeof error !== "object") return "UNKNOWN";
    const e = error as { name?: unknown; code?: unknown };
    if (e.name === "AbortError") return "ABORT";
    if (e.name === "TimeoutError") return "TIMEOUT";
    if (["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(String(e.code)))
      return e.code as FixedAdapterReadDiagnostic["transportCode"];
    if (["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(String(e.code))) return "TLS_CERTIFICATE";
    if (e.code === "OFFICIAL_SITE_BODY_LIMIT") return "BODY_LIMIT";
  } catch { /* Diagnostic access cannot replace a transport error. */ }
  return "UNKNOWN";
}
export function rememberFixedAdapterReadFailure(error: unknown, diagnostic: FixedAdapterReadDiagnostic): void {
  if (error && typeof error === "object") failures.set(error, { ...diagnostic });
}
export function getFixedAdapterReadDiagnostic(error: unknown): FixedAdapterReadDiagnostic | undefined {
  if (!error || typeof error !== "object") return;
  const value = failures.get(error);
  return value ? { ...value } : undefined;
}
