import { stagehandNativeRouterCodes } from "./stagehand-native-router-diagnostic";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown, max = 1_000_000_000_000): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const budgetKeys = ["toolOperations", "totalTokens", "uncachedInputTokens", "outputTokens"] as const;
const tokenKeys = ["totalTokens", "inputTokens", "cachedInputTokens", "uncachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
const actions = new Set(["BROWSER_OPEN", "BROWSER_OBSERVE", "BROWSER_CLICK", "BROWSER_SELECT", "BROWSER_FILL", "BROWSER_SCROLL",
  "BROWSER_INSPECT_ADAPTER", "BROWSER_INSPECT", "BROWSER_FINISH", "BROWSER_UNKNOWN", "SCHEMA", "CHECKPOINT", "PROPOSE_RECIPE", "UNKNOWN_TOOL"]);
const errors = new Set(["UNSUPPORTED_ADAPTER_SOURCE", "STALE_OR_UNKNOWN_ELEMENT", "STALE_OR_UNKNOWN_CONTROL", "DISCOVERY_RETRY_SAME_ADAPTER",
  "ADAPTER_IDENTITY_MISMATCH", "ADAPTER_CONFIGURATION_UNVERIFIED", "ADAPTER_TRANSPORT_FAILED", "OFFICIAL_BOOKING_SOURCE_UNVERIFIED",
  "UNOBSERVED_NAVIGATION", "BROWSER_SESSION_CLOSED", "BROWSER_UNAVAILABLE", "BROWSER_NAVIGATION_FAILED", "DISCOVERY_SOURCE_NOT_OBSERVED",
  "DISCOVERY_RECIPE_INVALID", "DISCOVERY_REPLAY_INCOMPLETE", "DISCOVERY_PROPOSAL_INVALID", "DISCOVERY_RECIPE_ENGINE_NOT_ALLOWED",
  "DISCOVERY_BROWSER_ACTION_INVALID", "DISCOVERY_CHECKPOINT_INVALID", "DISCOVERY_ACCESS_NOT_CONFIRMED", "DISCOVERY_NO_BROWSER_PROGRESS",
  "DISCOVERY_GENERIC_BUDGET_EXHAUSTED", "DISCOVERY_NATIVE_TRANSPORT_FATAL", "DISCOVERY_WORK_DEADLINE", "DISCOVERY_CANCELLED",
  "DISCOVERY_LEASE_REJECTED", "DISCOVERY_TRANSPORT_FALLBACK_FAILED", "OTHER_TOOL_ERROR"]);
function counts(value: unknown, keys: readonly string[]) {
  const input = record(value);
  return Object.fromEntries(keys.filter(key => count(input[key])).map(key => [key, input[key] as number]));
}
type Entry = { action: string; status: string; modelPreviewBytes: number; previewOmitted: boolean; errorCode?: string; schemaEngine?: string };
const staleReasons = new Set(["ELEMENT_NOT_OBSERVED", "TARGET_OR_DOCUMENT_CHANGED", "NATIVE_DOCUMENT_CHANGED", "CONTROL_NOT_RENDERED",
  "CONTROL_DISABLED", "CONTROL_SIGNATURE_CHANGED", "PUBLIC_DATE_CHOICE_CHANGED", "ENTRY_DISCLOSURE_CHANGED", "PUBLIC_ENTRY_SOURCE_UNVERIFIED",
  "PUBLIC_ENTRY_CONTROL_CHANGED", "GESTURE_CONTROL_MISSING", "GESTURE_CONTROL_AMBIGUOUS", "GESTURE_NATIVE_SOURCE_CHANGED",
  "GESTURE_LABEL_INVALID", "GESTURE_BOOKING_INTENT_MISSING", "GESTURE_INTENT_MISSING"]);
const requestErrors = new Set(["UNSAFE_URL", "UNSAFE_REDIRECT", "GUARDED_HOST", "NON_READ_METHOD", "METHOD_NOT_ALLOWED",
  "ACCOUNT_REQUIRED", "ACCESS_REQUIRED", "CAPTCHA_OR_QUEUE", "PUBLIC_READ_BYTE_LIMIT", "PUBLIC_READ_REQUEST_LIMIT",
  "REQUEST_FAILED", "HTTP_ERROR", "SUBFRAME_UNSUPPORTED", "BODY_LIMIT", ...stagehandNativeRouterCodes]);
function publicOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return;
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password) return url.origin; } catch { /* Unknown stays unknown. */ }
}
function feedback(value: unknown, officialOrigin?: string) {
  const input = record(value), details = record(input.details), failure = record(details.failure);
  if (input.code !== "DISCOVERY_BROWSER_INCOMPLETE") return;
  return { feedbackKind: "DISCOVERY_BROWSER_INCOMPLETE" as const,
    ...(typeof details.action === "string" && actions.has(`BROWSER_${details.action.toUpperCase()}`) && details.action === details.action.toLowerCase()
      ? { action: details.action } : {}),
    ...(typeof failure.code === "string" && errors.has(failure.code) ? { failureCode: failure.code } : {}),
    ...(typeof details.staleControlReason === "string" && staleReasons.has(details.staleControlReason) ? { staleControlReason: details.staleControlReason } : {}),
    ...(typeof details.loading === "boolean" ? { loading: details.loading } : {}),
    ...(count(details.pendingRequestCount, 1024) ? { pendingRequestCount: details.pendingRequestCount } : {}),
    ...(Array.isArray(details.requests) && details.requests.length <= 8 ? { requestFailures: details.requests.map(value => {
      const request = record(value);
      const requestOrigin = publicOrigin(request.url);
      return { failureCode: typeof request.code === "string" && requestErrors.has(request.code) ? request.code : "OTHER_REQUEST_ERROR",
        originCategory: !officialOrigin || !requestOrigin ? "UNAVAILABLE" : requestOrigin === officialOrigin ? "OFFICIAL_ORIGIN" : "OTHER_ORIGIN",
        ...(["GET", "HEAD", "POST", "OPTIONS"].includes(String(request.method)) ? { method: request.method as string } : {}),
        ...(["document", "script", "stylesheet", "xhr", "fetch", "other"].includes(String(request.resourceType))
          ? { resourceType: request.resourceType as string } : {}) };
    }) } : {}),
  };
}

/** Closed structural projection of already-persisted facts. Never retain page
 * contents, tool arguments, selectors, URLs or free-form errors. No authority. */
export function projectGenericFailureDiagnostic(guardValue: unknown, traceValue: unknown, controllerValue?: unknown) {
  const guard = record(guardValue);
  if (guard.code !== "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" && guard.code !== "DISCOVERY_NATIVE_TRANSPORT_FATAL" &&
      guard.code !== "DISCOVERY_NO_VERIFIED_RECIPE") return;
  const trace = record(traceValue), entries: Entry[] = [];
  let lostEntries = count(trace.lostEntries, 999_999) ? trace.lostEntries : 0;
  const validTrace = Array.isArray(trace.entries) && trace.entries.length <= 1024 && count(trace.lostEntries, 999_999);
  const controller = record(controllerValue), officialOrigin = publicOrigin(controller.officialUrl),
    historicalFailure = feedback(controller.lastFailure, officialOrigin), lastFeedback = feedback(controller.lastFeedback, officialOrigin);
  if (validTrace) for (const value of trace.entries as unknown[]) {
    const entry = record(value);
    if (entries.length >= 8 || !["SUCCESS", "ERROR", "NO_REPLY"].includes(String(entry.status)) ||
        !count(entry.modelPreviewBytes, 99_999_999) || typeof entry.previewOmitted !== "boolean") {
      lostEntries = Math.min(999_999, lostEntries + 1); continue;
    }
    const action = typeof entry.action === "string" && actions.has(entry.action) ? entry.action : "UNKNOWN_TOOL";
    entries.push({ action, status: entry.status as string, modelPreviewBytes: entry.modelPreviewBytes, previewOmitted: entry.previewOmitted,
      ...(entry.status === "SUCCESS" ? {} : { errorCode: typeof entry.errorCode === "string" && errors.has(entry.errorCode) ? entry.errorCode : "OTHER_TOOL_ERROR" }),
      ...(action === "SCHEMA" && ["HTTP_JSON", "BROWSER_DOM", "BROWSER_JSON", "EXISTING_ADAPTER"].includes(String(entry.schemaEngine))
        ? { schemaEngine: entry.schemaEngine as string } : {}) });
  }
  return {
    ...(guard.code === "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" && budgetKeys.some(key => key === guard.limit) ? { limit: guard.limit as string } : {}),
    ...(count(guard.toolOperations, 100_000) ? { toolOperations: guard.toolOperations } : {}),
    tokenUsage: counts(guard.tokenUsage, tokenKeys), limits: counts(guard.limits, budgetKeys),
    traceRetention: traceValue === undefined ? "NOT_RETAINED" as const : validTrace ? "PRESENT" as const : "INVALID" as const,
    ...(validTrace ? { toolTrace: { entries, lostEntries,
      ...(trace.retention === "FIRST_TWO_AND_LATEST_SIX" ? { retention: "FIRST_TWO_AND_LATEST_SIX" as const } : {}) } } : {}), evidenceAuthority: false as const,
    ...(historicalFailure ? { historicalFailure } : {}), ...(lastFeedback ? { lastFeedback } : {}),
  };
}
