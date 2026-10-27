export const stagehandNativeRouterCodes = ["NATIVE_REDIRECT_ABORT_TIMEOUT", "NATIVE_REDIRECT_BODY_TIMEOUT", "NATIVE_REDIRECT_CANCELLED", "NATIVE_REDIRECT_CONTINUE_REJECTED",
  "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", "NATIVE_REDIRECT_DRAIN_FAILED", "NATIVE_REDIRECT_DRAIN_TIMEOUT", "NATIVE_REDIRECT_DUPLICATE_FETCH_ID",
  "NATIVE_REDIRECT_FRAME_MISSING", "NATIVE_REDIRECT_FRAME_UNGUARDED", "NATIVE_REDIRECT_FULFILL_REJECTED", "NATIVE_REDIRECT_HANDLER_FAILED", "NATIVE_REDIRECT_HEADERS_LIMIT",
  "NATIVE_REDIRECT_INSTALL_FAILED", "NATIVE_REDIRECT_INTERCEPT_LIMIT", "NATIVE_REDIRECT_LOADER_MISMATCH", "NATIVE_REDIRECT_LOADER_TIMEOUT", "NATIVE_REDIRECT_NAVIGATION_REJECTED",
  "NATIVE_REDIRECT_NETWORK_FAILED", "NATIVE_REDIRECT_NETWORK_ID_MISSING", "NATIVE_REDIRECT_PING_UNSUPPORTED", "NATIVE_REDIRECT_POST_BODY_LIMIT", "NATIVE_REDIRECT_POST_BODY_MISSING",
  "NATIVE_REDIRECT_PROVENANCE_REJECTED", "NATIVE_REDIRECT_PROVENANCE_TIMEOUT", "NATIVE_REDIRECT_RECORD_LIMIT", "NATIVE_REDIRECT_REQUEST_REJECTED", "NATIVE_REDIRECT_REQUEST_TIMEOUT",
  "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED", "NATIVE_REDIRECT_RESOURCE_REJECTED", "NATIVE_REDIRECT_RESPONSE_DUPLICATE", "NATIVE_REDIRECT_RESPONSE_FRAME_MISMATCH",
  "NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT", "NATIVE_REDIRECT_RESPONSE_METHOD_MISMATCH", "NATIVE_REDIRECT_RESPONSE_MISMATCH", "NATIVE_REDIRECT_RESPONSE_NETWORK_MISMATCH",
  "NATIVE_REDIRECT_RESPONSE_PRIOR_FAILURE", "NATIVE_REDIRECT_RESPONSE_REQUEST_PAUSED", "NATIVE_REDIRECT_RESPONSE_STATUS_INVALID", "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
  "NATIVE_REDIRECT_RESPONSE_UNADMITTED", "NATIVE_REDIRECT_RESPONSE_UNKNOWN", "NATIVE_REDIRECT_RESPONSE_URL_MISMATCH", "NATIVE_REDIRECT_RETIRED_DISPATCH", "NATIVE_REDIRECT_ROUTING_FAILED",
  "NATIVE_RESPONSE_LIMIT", "OWNED_STAGEHAND_CDP_UNAVAILABLE", "STAGEHAND_GUARDED_SOURCE_REJECTED", "UNKNOWN"] as const;
const phases = ["RESPONSE_WAIT", "CONTINUE_REQUEST_ACK", "CONTINUE_RESPONSE_ACK", "LOADER_IDENTITY_WAIT", "LOADER_IDENTITY", "LOADER_OWNER", "REDIRECT_GENERATION", "REDIRECT_PROVENANCE", "DOCUMENT_INTENT", "DOCUMENT_DRAIN", "SOURCE_HOST_REQUEST"] as const;
export const stagehandSourceRequestGuards = ["STATE", "TRANSACTION_URL", "FRAME_OWNERSHIP", "URL_POLICY", "HEADER_POLICY", "NAVIGATION_PROVENANCE", "METHOD_POLICY", "REQUEST_BUDGET", "LEASE", "NATIVE_RESPONSE"] as const;
export type StagehandSourceRequestGuard = typeof stagehandSourceRequestGuards[number];
const methods = ["GET", "HEAD", "POST", "OPTIONS", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"] as const;
const kinds = ["document", "stylesheet", "script", "image", "media", "font", "xhr", "fetch", "preflight", "other", "ping", "websocket", "eventsource"] as const;
export const stagehandNativeRouterBooleanKeys = ["framePresent", "rootFrame", "networkIdPresent", "duplicateRequestId", "hasPostData", "postDataPresent",
  "identityPresent", "loaderPresent", "loaderKnown", "identityFresh", "identityUrlMatches", "identityMethodMatches", "identityKindMatches", "identityFrameMatches",
  "parentPresent", "awaitingDocument", "parentCurrentGeneration", "documentCommitted", "documentIntentPresent", "documentIntentUsed", "sourceResponseComplete", "successorTerminalFailed",
  "declaredLengthPresent", "documentResponse", "ancillaryResponse", "recordGenerationCurrent", "recordGenerationRetired", "recordAdmitted", "recordPaused", "recordResponsePaused",
  "recordFailed", "recordComplete", "recordHandlerDone", "recordTerminalObserved"] as const;
const limitKinds = ["DECLARED_INVALID", "DECLARED_TOO_LARGE", "DECODED_BODY", "TOTAL_DECODED"] as const;
export const stagehandRedirectRejections = ["PARENT_MISSING", "PARENT_UNADMITTED", "PARENT_FAILED", "PARENT_DEPTH_LIMIT", "PARENT_CHILD_RESERVED",
  "PARENT_RESPONSE_MISSING", "PARENT_RESPONSE_FAILED", "CHILD_RECORD_EXISTS", "PARENT_RESPONSE_INCOMPLETE", "LOCATION_MISSING", "LOCATION_MISMATCH",
  "KIND_NETWORK_MISMATCH", "METHOD_MISMATCH", "DOCUMENT_PARENT_KIND", "DOCUMENT_PARENT_METHOD", "CROSS_HOST"] as const;
export type StagehandRedirectRejection = typeof stagehandRedirectRejections[number];
const byteKeys = ["allowedBytes", "declaredBytes", "bodyBytes", "totalBytes"] as const;
export const nativeRouterOperations = ["REQUEST_METADATA", "RESPONSE_METADATA", "LOADER_CORRELATION", "REDIRECT_PROVENANCE", "RESPONSE_WAIT", "RESPONSE_BODY", "RESPONSE_RELEASE", "REQUEST_RELEASE", "HANDLER"] as const;
export const nativeRouterErrorNames = ["Error", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "AbortError", "ProtocolError", "CDPError", "UNKNOWN"] as const;
export const nativeRouterErrorCategories = ["INVALID_INTERCEPTION_ID", "REQUEST_NOT_PAUSED", "TARGET_CLOSED", "SESSION_CLOSED", "CONTEXT_DESTROYED", "BODY_UNAVAILABLE", "PROTOCOL_ERROR", "UNKNOWN"] as const;
export const stagehandHostGuardReasons = {
  CHECK: ["ABORTED", "CLOSED", "TERMINAL"],
  GUARDED_TARGETS: ["IDS_INVALID", "TARGET_MISSING", "TARGET_NOT_ATTESTED"],
  SOURCE_DOM: ["VALUE_INVALID", "JSON_INVALID", "FRAME_MISSING", "LOADER_MISSING", "FRAME_CHANGED", "LOADER_CHANGED", "NATIVE_URL_CHANGED", "DOM_URL_CHANGED"],
  BEFORE_ACTION: ["HREF_SHAPE", "LINK_INVENTORY_MISSING", "HREF_NOT_OBSERVED", "HREF_URL_POLICY", "HREF_TRANSACTION", "OBSERVED_URL_LIMIT"],
  GESTURE: ["DESCRIPTOR_INVALID", "NOT_PLACEHOLDER", "DOCUMENT_REQUEST_MISSING", "SOURCE_NOT_SETTLED", "VISIBLE_LINK_MISSING", "INTENT_MISSING", "INTENT_EXPIRED", "INTENT_USED", "SOURCE_CHANGED", "NATIVE_PROVENANCE_MISSING"],
} as const;
export type StagehandHostGuardFailure = { [K in keyof typeof stagehandHostGuardReasons]: { stage: K; reason: typeof stagehandHostGuardReasons[K][number] } &
  (K extends "SOURCE_DOM" ? { nativeFrameHasFragment?: boolean; domHasFragment?: boolean } : object) }[keyof typeof stagehandHostGuardReasons];
export function createStagehandHostGuardFailureCapture() {
  let first: StagehandHostGuardFailure | undefined;
  return { record(value: StagehandHostGuardFailure) {
    if (first || !value || !Object.hasOwn(stagehandHostGuardReasons, value.stage) || !(stagehandHostGuardReasons[value.stage] as readonly string[]).includes(value.reason)) return;
    const projected = { stage: value.stage, reason: value.reason } as StagehandHostGuardFailure;
    if (value.stage === "SOURCE_DOM" && projected.stage === "SOURCE_DOM") {
      if (typeof value.nativeFrameHasFragment === "boolean") projected.nativeFrameHasFragment = value.nativeFrameHasFragment;
      if (typeof value.domHasFragment === "boolean") projected.domHasFragment = value.domHasFragment;
    }
    first = projected;
  }, snapshot: () => first ? { ...first } : undefined };
}
export function classifyNativeRouterError(error: unknown): Required<Pick<StagehandNativeRouterFailure, "errorName" | "errorCategory">> {
  const value = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : {};
  const message = typeof value.message === "string" ? value.message.slice(0, 4000) : "";
  const errorCategory = /\bInvalid InterceptionId\b/iu.test(message) ? "INVALID_INTERCEPTION_ID" :
    /\bCan only perform operation while paused\b/iu.test(message) ? "REQUEST_NOT_PAUSED" :
    /\b(?:Target|page) (?:has been )?closed\b/iu.test(message) ? "TARGET_CLOSED" :
    /\bSession (?:with given id not found|(?:has been )?closed)\b/iu.test(message) ? "SESSION_CLOSED" :
    /\b(?:Execution context was destroyed|Cannot find context with specified id)\b/iu.test(message) ? "CONTEXT_DESTROYED" :
    /\b(?:No resource with given identifier found|No data found for resource with given identifier|Could not load body for this request)\b/iu.test(message) ? "BODY_UNAVAILABLE" :
    /\bProtocol error\b/iu.test(message) ? "PROTOCOL_ERROR" : "UNKNOWN";
  return { errorName: typeof value.name === "string" && nativeRouterErrorNames.includes(value.name as typeof nativeRouterErrorNames[number])
    ? value.name as typeof nativeRouterErrorNames[number] : "UNKNOWN" as const, errorCategory };
}
export type StagehandNativeRouterFailure = { code: typeof stagehandNativeRouterCodes[number]; phase?: typeof phases[number]; method?: typeof methods[number]; resourceType?: typeof kinds[number]; limitKind?: typeof limitKinds[number]; sourceRequestGuard?: StagehandSourceRequestGuard; redirectRejection?: StagehandRedirectRejection } &
  { operation?: typeof nativeRouterOperations[number]; errorName?: typeof nativeRouterErrorNames[number]; errorCategory?: typeof nativeRouterErrorCategories[number]; requestUrlSha256?: string } &
  Partial<Record<typeof byteKeys[number], number>> &
  Partial<Record<typeof stagehandNativeRouterBooleanKeys[number], boolean>>;
const allowed = <T extends readonly string[]>(values: T, raw: unknown): T[number] | undefined => typeof raw === "string" && values.includes(raw) ? raw : undefined;
/** No URL, query, payload, headers, IDs, or arbitrary string may cross this boundary. */
export function projectStagehandNativeRouterFailure(code: unknown, facts: unknown): StagehandNativeRouterFailure {
  const source = facts && typeof facts === "object" && !Array.isArray(facts) ? facts as Record<string, unknown> : {};
  const value: StagehandNativeRouterFailure = { code: allowed(stagehandNativeRouterCodes, code) ?? "UNKNOWN" };
  const phase = allowed(phases, source.phase), method = allowed(methods, source.method), resourceType = allowed(kinds, source.resourceType);
  if (phase) value.phase = phase; if (method) value.method = method; if (resourceType) value.resourceType = resourceType;
  const operation = allowed(nativeRouterOperations, source.operation), errorName = allowed(nativeRouterErrorNames, source.errorName), errorCategory = allowed(nativeRouterErrorCategories, source.errorCategory);
  if (operation) value.operation = operation; if (errorName) value.errorName = errorName; if (errorCategory) value.errorCategory = errorCategory;
  if (typeof source.requestUrlSha256 === "string" && /^[a-f0-9]{64}$/u.test(source.requestUrlSha256)) value.requestUrlSha256 = source.requestUrlSha256;
  const sourceRequestGuard = allowed(stagehandSourceRequestGuards, source.sourceRequestGuard);
  if (value.code === "STAGEHAND_GUARDED_SOURCE_REJECTED" && phase === "SOURCE_HOST_REQUEST" && sourceRequestGuard) value.sourceRequestGuard = sourceRequestGuard;
  const redirectRejection = allowed(stagehandRedirectRejections, source.redirectRejection);
  if (value.code === "NATIVE_REDIRECT_PROVENANCE_REJECTED" && phase === "REDIRECT_PROVENANCE" && redirectRejection) value.redirectRejection = redirectRejection;
  if (value.code === "NATIVE_RESPONSE_LIMIT") {
    const limitKind = allowed(limitKinds, source.limitKind); if (limitKind) value.limitKind = limitKind;
    for (const key of byteKeys) if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0 && source[key] <= Number.MAX_SAFE_INTEGER) value[key] = source[key];
  }
  for (const key of stagehandNativeRouterBooleanKeys) if (typeof source[key] === "boolean") value[key] = source[key];
  return value;
}
export function createStagehandNativeRouterFailureCapture() {
  let first: StagehandNativeRouterFailure | undefined;
  return { record(code: unknown, facts: unknown) { first ??= projectStagehandNativeRouterFailure(code, facts); },
    snapshot: () => first ? { ...first } : undefined };
}
/** Only an actual current owned main navigation may occupy this failure slot. */
export function recordStagehandSourceNavigationFailure(capture: { record(code: unknown, facts: unknown): void },
  state: { navigationRequest: boolean; frame: object; page: object; ownedFrame: object; ownedPage: object; closed: boolean; aborted: boolean },
  guard: StagehandSourceRequestGuard, method: string, resourceType: string) {
  if (state.navigationRequest !== true || state.closed !== false || state.aborted !== false ||
      !state.frame || !state.page || state.frame !== state.ownedFrame || state.page !== state.ownedPage) return;
  capture.record("STAGEHAND_GUARDED_SOURCE_REJECTED", { phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: guard, method, resourceType, rootFrame: true });
}
