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
const byteKeys = ["allowedBytes", "declaredBytes", "bodyBytes", "totalBytes"] as const;
export type StagehandNativeRouterFailure = { code: typeof stagehandNativeRouterCodes[number]; phase?: typeof phases[number]; method?: typeof methods[number]; resourceType?: typeof kinds[number]; limitKind?: typeof limitKinds[number]; sourceRequestGuard?: StagehandSourceRequestGuard } &
  Partial<Record<typeof byteKeys[number], number>> &
  Partial<Record<typeof stagehandNativeRouterBooleanKeys[number], boolean>>;
const allowed = <T extends readonly string[]>(values: T, raw: unknown): T[number] | undefined => typeof raw === "string" && values.includes(raw) ? raw : undefined;
/** No URL, query, payload, headers, IDs, or arbitrary string may cross this boundary. */
export function projectStagehandNativeRouterFailure(code: unknown, facts: unknown): StagehandNativeRouterFailure {
  const source = facts && typeof facts === "object" && !Array.isArray(facts) ? facts as Record<string, unknown> : {};
  const value: StagehandNativeRouterFailure = { code: allowed(stagehandNativeRouterCodes, code) ?? "UNKNOWN" };
  const phase = allowed(phases, source.phase), method = allowed(methods, source.method), resourceType = allowed(kinds, source.resourceType);
  if (phase) value.phase = phase; if (method) value.method = method; if (resourceType) value.resourceType = resourceType;
  const sourceRequestGuard = allowed(stagehandSourceRequestGuards, source.sourceRequestGuard);
  if (value.code === "STAGEHAND_GUARDED_SOURCE_REJECTED" && phase === "SOURCE_HOST_REQUEST" && sourceRequestGuard) value.sourceRequestGuard = sourceRequestGuard;
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
