import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor, discoveryBrowserFeedback, discoveryCheckpointDisposition, inspectedAdapterSourceEvidence, noVerifiedRecipeDiagnostic, readDiscoveryControllerCheckpoint, safeBrowserFailureDiagnostics, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";
import { describePublicUrlRejection, safeBrowserActionIssues } from "../../../scripts/automation/course-discovery-diagnostics.mjs";

describe("durable discovery browser diagnostics", () => {
  it("keeps only closed response abort and terminal facts in browser failure evidence", () => {
    const raw = { code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_METADATA", responseFailureBranch: "RETIRED_RESPONSE_ABORT",
      recordGenerationRetired: true, responseIdentityMatched: true, correlatedNetworkLoadingFailed: false,
      correlatedNetworkLoadingFinished: false, requestId: "PRIVATE", body: "PRIVATE" };
    const closed = safeBrowserFailureDiagnostics({ nativeFirstFatal: raw }).nativeFirstFatal;
    expect(closed).toMatchObject({ responseFailureBranch: "RETIRED_RESPONSE_ABORT", recordGenerationRetired: true,
      responseIdentityMatched: true, correlatedNetworkLoadingFailed: false, correlatedNetworkLoadingFinished: false });
    expect(JSON.stringify(closed)).not.toMatch(/PRIVATE|requestId|body/u);
    expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { ...raw, operation: "REQUEST_METADATA" } }).nativeFirstFatal).not.toHaveProperty("responseFailureBranch");
  });
  it.each(["script", "stylesheet"])("preserves only opaque GET %s fingerprints when no public URL survives", resourceType => {
    const requestUrlFingerprint = { originSha256: "a".repeat(64), pathnameSha256: "b".repeat(64) };
    const diagnostic = { code: "UNSCOPED_REQUEST", method: "GET", resourceType, url: "https://private.internal/opaque-path?secret=never-emitted",
      requestUrlFingerprint: { ...requestUrlFingerprint, rawOrigin: "private-origin", rawPathname: "private-path" },
      earlierRequestFailure: { code: "UNSAFE_URL", method: "GET", resourceType, requestUrlFingerprint } };
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
      lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "UNSCOPED_REQUEST", diagnostic } } } }, "https://venue.example/");
    expect(restored.lastFailure.details.diagnostic).toEqual({ code: "UNSCOPED_REQUEST", method: "GET", resourceType, requestUrlFingerprint,
      earlierRequestFailure: { code: "UNSAFE_URL", method: "GET", resourceType, requestUrlFingerprint } });
    expect(JSON.stringify(restored)).not.toMatch(/private|opaque-path|secret|rawOrigin|rawPathname/);
    diagnostic.requestUrlFingerprint.originSha256 = "c".repeat(64);
    expect(restored.lastFailure.details.diagnostic.requestUrlFingerprint.originSha256).toBe("a".repeat(64));
  });
  it.each([
    { requestUrlFingerprint: null }, { requestUrlFingerprint: { originSha256: "a".repeat(64) } },
    { requestUrlFingerprint: { originSha256: "A".repeat(64), pathnameSha256: "b".repeat(64) } },
    { requestUrlFingerprint: { originSha256: "a".repeat(63), pathnameSha256: "b".repeat(64) } },
    { requestUrlFingerprint: { originSha256: ["a".repeat(64)], pathnameSha256: "b".repeat(64) } },
    { method: "HEAD" }, { method: "POST" }, { resourceType: "xhr" }, { resourceType: "fetch" }, { resourceType: "document" },
    { url: "https://venue.example/public.js" },
  ])("omits ineligible fingerprints without changing the primary or retaining extra fields (%j)", change => {
    const diagnostic = { code: "STEP_TIMEOUT", method: "GET", resourceType: "script",
      requestUrlFingerprint: { originSha256: "a".repeat(64), pathnameSha256: "b".repeat(64) }, ...change };
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
      lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "STEP_TIMEOUT", diagnostic: { ...diagnostic,
        earlierRequestFailure: { ...diagnostic, code: "UNSAFE_URL" } } } } } }, "https://venue.example/");
    expect(restored.lastFailure.details.diagnostic).not.toHaveProperty("requestUrlFingerprint");
    expect(restored.lastFailure.details.diagnostic.earlierRequestFailure).not.toHaveProperty("requestUrlFingerprint");
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("STEP_TIMEOUT");
  });
  it.each([{ pendingReads: 0, currentDocumentPendingHandlers: 0 }, { pendingReads: 1024, currentDocumentPendingHandlers: 1 },
    { pendingReads: "OVER_LIMIT", currentDocumentPendingHandlers: "OVER_LIMIT" }])(
    "preserves bounded primary requestState through checkpoint without exposing supplied extras (%j)", requestState => {
      const feedback = { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "STEP_TIMEOUT", diagnostic: { code: "STEP_TIMEOUT",
        requestState: { ...requestState, queueOwner: "private-owner", url: "https://private.example/?token=private", body: "private-body" },
        earlierRequestFailure: { code: "UNSCOPED_REQUEST", requestState: { pendingReads: 99, currentDocumentPendingHandlers: 99 } } } } };
      const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
        lastFailure: feedback } }, "https://venue.example/");
      expect(restored.lastFailure.details.diagnostic).toEqual({ code: "STEP_TIMEOUT", requestState,
        earlierRequestFailure: { code: "UNSCOPED_REQUEST" } });
      expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("STEP_TIMEOUT");
      expect(JSON.stringify(restored)).not.toMatch(/private|queueOwner|body/);
      feedback.details.diagnostic.requestState.pendingReads = "MUTATED";
      feedback.details.diagnostic.requestState.currentDocumentPendingHandlers = 1024;
      expect(restored.lastFailure.details.diagnostic.requestState).toEqual(requestState);
    });
  it.each([null, [], "private", {}, Object.create({ pendingReads: 0, currentDocumentPendingHandlers: 0 }), { pendingReads: 0 }, { pendingReads: 0, currentDocumentPendingHandlers: -1 },
    { pendingReads: 1025, currentDocumentPendingHandlers: 0 }, { pendingReads: 1.5, currentDocumentPendingHandlers: 0 },
    { pendingReads: "1024", currentDocumentPendingHandlers: 0 }, { pendingReads: "OVER_LIMIT_PRIVATE", currentDocumentPendingHandlers: 0 }])(
    "omits malformed requestState without changing terminal outcome (%j)", requestState => {
      const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
        lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "PROVIDER_THROTTLED", diagnostic: { code: "HTTP_429", requestState } } } } }, "https://venue.example/");
      expect(restored.lastFailure.details.diagnostic).toEqual({ code: "HTTP_429" });
      expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("PROVIDER_THROTTLED");
    });
  it("preserves one bounded earlier request failure through replay and checkpoint without changing the terminal diagnostic", async () => {
    const hash = "a".repeat(64), primary = { code: "STEP_TIMEOUT", stepIndex: 2, method: "GET", resourceType: "document",
      url: "https://venue.example/calendar?date=private-date#private-fragment",
      earlierRequestFailure: { code: "UNSCOPED_REQUEST", url: "https://assets.example/calendar.js?build=private-build#private-fragment",
        method: "GET", resourceType: "script", stepIndex: 30, headers: { authorization: "private-authorization" }, body: "private-body",
        earlierRequestFailure: { code: "PRIVATE_NESTED", url: "https://private.example/" } } };
    let result;
    try {
      await verifyDiscoveryCandidate({ job: { id: "job", leaseToken: "synthetic-lease", deadlineAt: "2026-10-23T10:15:00Z" }, recipe: {},
        client: { candidate: async () => ({ recipeHash: hash, challenges: [{ id: "one", recipeHash: hash, input: {} }, { id: "two", recipeHash: hash, input: {} }] }) },
        executeRecipe: async () => ({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "STEP_TIMEOUT", diagnostic: primary } }) });
    } catch (error) { result = error; }
    const expected = { code: "STEP_TIMEOUT", stepIndex: 2, method: "GET", resourceType: "document", url: "https://venue.example/calendar",
      earlierRequestFailure: { code: "UNSCOPED_REQUEST", url: "https://assets.example/calendar.js", method: "GET", resourceType: "script" } };
    expect(result).toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "STEP_TIMEOUT", diagnostic: expected } });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
      lastFailure: { code: result.code, details: result.details } } }, "https://venue.example/");
    expect(restored.lastFailure.details.diagnostic).toEqual(expected);
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("STEP_TIMEOUT");
    primary.earlierRequestFailure.code = "MUTATED";
    expect(restored.lastFailure.details.diagnostic.earlierRequestFailure.code).toBe("UNSCOPED_REQUEST");
    expect(JSON.stringify(restored)).not.toMatch(/private|headers|authorization|body|PRIVATE_NESTED/);
  });
  it.each([null, [], "private", { code: ["UNSCOPED_REQUEST"] }, { code: "private-value" }, { code: "A".repeat(81) }])(
    "drops malformed earlier request diagnostics while preserving the primary and throttle precedence (%j)", earlierRequestFailure => {
      const feedback = { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { status: "INCOMPLETE", reason: "PROVIDER_THROTTLED",
        diagnostic: { code: "PROVIDER_THROTTLED", method: "GET", resourceType: "fetch", earlierRequestFailure } } };
      const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
        lastFailure: feedback } }, "https://venue.example/");
      expect(restored.lastFailure.details.diagnostic).toEqual({ code: "PROVIDER_THROTTLED", method: "GET", resourceType: "fetch" });
      expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("PROVIDER_THROTTLED");
    });
  it("retains only closed fields for an earlier request and never treats it as a terminal reason", () => {
    const feedback = { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { status: "INCOMPLETE", reason: "STEP_TIMEOUT",
      diagnostic: { code: "STEP_TIMEOUT", earlierRequestFailure: { code: "HTTP_403", url: "https://user:private@venue.example/read",
        method: "DELETE", resourceType: "private", arbitrary: "private", stepIndex: 3 } } } };
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
      lastFailure: feedback } }, "https://venue.example/");
    expect(restored.lastFailure.details.diagnostic).toEqual({ code: "STEP_TIMEOUT", earlierRequestFailure: { code: "HTTP_403" } });
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("STEP_TIMEOUT");
  });
  it.each(["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "other"])(
    "preserves the closed earlier request kind %s without changing existing primary-kind projection", resourceType => {
      const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [],
        lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "STEP_TIMEOUT", diagnostic: { code: "STEP_TIMEOUT",
          earlierRequestFailure: { code: "HTTP_403", method: "OPTIONS", resourceType } } } } } }, "https://venue.example/");
      expect(restored.lastFailure.details.diagnostic).toEqual({ code: "STEP_TIMEOUT", earlierRequestFailure: { code: "HTTP_403", method: "OPTIONS", resourceType } });
    });
  it("retains only typed simulator classifications through a failed replay checkpoint", () => {
    const feedback = { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { status: "INCOMPLETE", reason: "ADAPTER_HTTP_ERROR",
      diagnostic: { code: "ADAPTER_HTTP_ERROR", simulatorError: { code: "HTTP_ERROR", retryable: true, httpStatus: 503,
        message: "private provider text", retryAfter: "private", body: "private" } } } };
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: feedback } }, "https://venue.example/");
    expect(restored.lastFailure.details.diagnostic).toEqual({ code: "ADAPTER_HTTP_ERROR",
      simulatorError: { code: "HTTP_ERROR", retryable: true, httpStatus: 503 } });
    expect(JSON.stringify(restored)).not.toMatch(/private|message|retryAfter|body/);
    for (const simulatorError of [{ code: "PRIVATE_VALUE", retryable: true }, { code: "HTTP_ERROR", retryable: "true" }]) {
      const invalid = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
        observedNavigationUrls: [], lastFeedback: { ...feedback, details: { ...feedback.details,
          diagnostic: { code: "ADAPTER_READ_FAILED", simulatorError } } } } }, "https://venue.example/");
      expect(invalid.lastFeedback.details.diagnostic).toEqual({ code: "ADAPTER_READ_FAILED" });
    }
  });
  it.each(["FOREUP", "ACUITY", "TEEITUP", "USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "CHRONOGOLF", "GOLFVX", "EZLINKS", "REX", "CPS"])("binds current %s inspection evidence to exact job, source, input and typed metadata", family => {
    const job = { id: "job", request: { identity: { name: "Public golf", officialUrl: "https://official.example.org/" },
      target: { courseId: "course", kind: "OUTDOOR" }, input: { date: "2026-10-23", players: 2 } } };
    const bookingUrl = "https://booking.example.org/availability", context = job.request.identity.officialUrl;
    const adapter = { family, resources: [1, 2], configuration: { duration: 60, active: true } };
    const observation = createDiscoveryAdapterObservation(job, bookingUrl, adapter, context);
    const recipe = bindDiscoveryRecipeIdentity({ engine: "EXISTING_ADAPTER", source: { bookingUrl },
      adapter: { configuration: { active: true, duration: 60 }, resources: [1, 2], family } }, job, observation);
    expect(inspectedAdapterSourceEvidence(recipe, job, observation, true, context)).toEqual({ officialUrl: context, observedBookingUrl: bookingUrl });
    expect(inspectedAdapterSourceEvidence(recipe, job, observation, false, context)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(recipe, { ...job, id: "other" }, observation, true, context)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(recipe, { ...job, request: { ...job.request, input: { date: "2026-10-24", players: 2 } } }, observation, true, context)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(recipe, { ...job, request: { ...job.request, target: { courseId: "other", kind: "OUTDOOR" } } }, observation, true, context)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(recipe, job, observation, true, "https://official.example.org/changed")).toBeUndefined();
    expect(inspectedAdapterSourceEvidence({ ...recipe, source: { bookingUrl: `${bookingUrl}/other` } }, job, observation, true, context)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence({ ...recipe, adapter: { ...adapter, resources: [1, 3] } }, job, observation, true, context)).toBeUndefined();
    for (const engine of ["HTTP_JSON", "BROWSER_DOM"]) expect(inspectedAdapterSourceEvidence({ ...recipe, engine }, job, observation, true, context)).toBeUndefined();
    adapter.resources[0] = 9;
    expect(observation.adapter.resources).toEqual([1, 2]);
    expect(readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: context, officialSourceObserved: true,
      observedNavigationUrls: [], adapterObservation: observation } }, context)).not.toHaveProperty("adapterObservation");
  });

  it("retains failed first-navigation facts without bodies, credentials or query values", () => {
    const safe = safeBrowserFailureDiagnostics({ loading: true, pendingRequestCount: 5000,
      text: "private page text", requests: [null, { url: "https://venue.example/read?token=private", method: "GET", resourceType: "document", status: 403, body: "private" },
        { url: "https://venue.example/read?date=2026-10-23", method: "GET", resourceType: "document", blockedReason: "NATIVE_RESPONSE_TIMEOUT", body: "private" }],
      requestFailures: [{ reason: "NATIVE_RESPONSE_TIMEOUT", resourceType: "document", url: "https://venue.example/read?date=2026-10-23" }] });
    const feedback = discoveryBrowserFeedback(safe, "open", { code: "BROWSER_NAVIGATION_FAILED" });
    expect(feedback.details).toMatchObject({ loading: true, pendingRequestCount: 1024,
      requests: expect.arrayContaining([{ code: "NATIVE_RESPONSE_TIMEOUT", url: "https://venue.example/read", method: "GET", resourceType: "document" }]) });
    expect(JSON.stringify(safe)).not.toMatch(/private|token|2026|body|text/);
    expect(safeBrowserFailureDiagnostics(null)).toBeUndefined();
  });
  it("preserves exact native first-fatal facts through feedback and checkpoint without retaining source objects", () => {
    const firstFatal = { code: "NATIVE_REDIRECT_NETWORK_ID_MISSING", phase: "RESPONSE_WAIT", url: "https://venue.example/public?date=2026-10-23#private",
      method: "GET", resourceType: "script", interceptedRequests: 71, recordCount: 70, requestLimit: 1024, postDataBytes: 0,
      framePresent: true, rootFrame: true, networkIdPresent: false, duplicateRequestId: false, hasPostData: false, postDataPresent: false,
      headers: { authorization: "private" }, postData: "private", networkId: "private", frameId: "private", requestId: "private" };
    const rejected = { ...firstFatal, code: "NATIVE_REDIRECT_POST_BODY_LIMIT", method: "POST", resourceType: "xhr", postDataBytes: 90_512 };
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: firstFatal, nativeRejectedRequests: [rejected] });
    const feedback = discoveryBrowserFeedback(safe, "open", { code: firstFatal.code });
    const checkpoint = { controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } };
    const restored = readDiscoveryControllerCheckpoint(checkpoint, "https://venue.example/");
    expect(restored.lastFeedback.details.nativeFirstFatal).toEqual({
      code: firstFatal.code, phase: "RESPONSE_WAIT", url: "https://venue.example/public", method: "GET", resourceType: "script",
      interceptedRequests: 71, recordCount: 70, requestLimit: 1024, postDataBytes: 0,
      framePresent: true, rootFrame: true, networkIdPresent: false, duplicateRequestId: false, hasPostData: false, postDataPresent: false,
    });
    expect(restored.lastFeedback.details.nativeRejectedRequests).toEqual([expect.objectContaining({ code: rejected.code, postDataBytes: 90_512 })]);
    firstFatal.code = "NATIVE_CHANGED"; rejected.postDataBytes = 1;
    safe.nativeFirstFatal.code = "NATIVE_CHANGED_AGAIN";
    expect(feedback.details.nativeFirstFatal.code).toBe("NATIVE_REDIRECT_NETWORK_ID_MISSING");
    feedback.details.nativeRejectedRequests[0].postDataBytes = 2;
    expect(restored.lastFeedback.details.nativeRejectedRequests[0].postDataBytes).toBe(90_512);
    expect(restored).toMatchObject({ urls: [], readUrls: [], entryUrls: [], officialObserved: false });
    expect(JSON.stringify(restored)).not.toMatch(/private|2026|headers|postData"|networkId"|frameId|requestId/);
  });
  it.each(["LOADER_IDENTITY_WAIT", "LOADER_IDENTITY", "LOADER_OWNER", "REDIRECT_GENERATION", "REDIRECT_PROVENANCE", "DOCUMENT_INTENT", "DOCUMENT_DRAIN"])("keeps bounded %s facts without retaining native IDs or supplied values", phase => {
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase,
      identityPresent: true, loaderPresent: true, loaderKnown: false, identityFresh: false, identityUrlMatches: false,
      identityMethodMatches: true, identityKindMatches: true, identityFrameMatches: true,
      parentPresent: false, awaitingDocument: false, parentCurrentGeneration: false, documentCommitted: true,
      documentIntentPresent: true, documentIntentUsed: true, sourceResponseComplete: true, successorTerminalFailed: false,
      loaderId: "private", networkId: "private", revision: 123, url: "https://venue.example/read?secret=private" } });
    expect(safe.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase,
      identityPresent: true, loaderPresent: true, loaderKnown: false, identityFresh: false, identityUrlMatches: false,
      identityMethodMatches: true, identityKindMatches: true, identityFrameMatches: true,
      parentPresent: false, awaitingDocument: false, parentCurrentGeneration: false, documentCommitted: true,
      documentIntentPresent: true, documentIntentUsed: true, sourceResponseComplete: true, successorTerminalFailed: false });
    expect(JSON.stringify(safe)).not.toMatch(/private|loaderId|networkId|revision|secret/);
    const malformed = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "private",
      identityPresent: "true", loaderPresent: "private", loaderKnown: 1, identityFresh: 0, identityUrlMatches: {},
      identityMethodMatches: [], identityKindMatches: null, identityFrameMatches: "private", parentPresent: "private", awaitingDocument: 1,
      parentCurrentGeneration: {}, documentCommitted: [], documentIntentPresent: null, documentIntentUsed: 0,
      sourceResponseComplete: "true", successorTerminalFailed: "false" } });
    expect(malformed.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_MISMATCH" });
  });
  it("retains only finite OPTIONS preflight categories in worker evidence", () => {
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_TIMEOUT", method: "OPTIONS",
      preflightOriginPresent: true, preflightOriginSafe: false, preflightRequestedHeadersCategory: "SENSITIVE",
      headers: { authorization: "PRIVATE" }, origin: "https://private.invalid", networkId: "PRIVATE" } });
    expect(safe.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT", method: "OPTIONS",
      preflightOriginPresent: true, preflightOriginSafe: false, preflightRequestedHeadersCategory: "SENSITIVE" });
    const invalid = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_TIMEOUT",
      preflightOriginPresent: "PRIVATE", preflightOriginSafe: 1, preflightRequestedHeadersCategory: "PRIVATE" } });
    expect(invalid.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT" });
  });
  it("retains only finite exact preflight registration facts", () => {
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_TIMEOUT", method: "OPTIONS",
      preflightRegistrationGate: "SOURCE_LOADER", preflightGateGenerationCurrent: true,
      preflightGateParentKnown: true, preflightGateParentLoaderCurrent: false,
      sourceNetworkId: "PRIVATE", requestHeaders: { authorization: "SECRET" } } });
    expect(safe.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT", method: "OPTIONS",
      preflightRegistrationGate: "SOURCE_LOADER", preflightGateGenerationCurrent: true,
      preflightGateParentKnown: true, preflightGateParentLoaderCurrent: false });
    const invalid = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_TIMEOUT",
      preflightRegistrationGate: "PRIVATE", preflightGateParentKnown: "PRIVATE" } });
    expect(invalid.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_LOADER_TIMEOUT" });
  });
  it("projects only bounded native response-limit evidence and admission bits", () => {
    const raw = { code: "NATIVE_RESPONSE_LIMIT", method: "GET", resourceType: "xhr", limitKind: "DECODED_BODY",
      limitOrigin: "NATIVE_ROUTER", allowedBytes: 2_000_000, declaredBytes: 128, bodyBytes: 15_187_944, totalBytes: 17_000_000,
      officialRenderDataLimit: false, recordGenerationCurrent: false, recordGenerationRetired: true,
      url: "https://venue.example/private/?token=SECRET", headers: { cookie: "SECRET" } };
    const projected = safeBrowserFailureDiagnostics({ nativeFirstFatal: raw }).nativeFirstFatal;
    expect(projected).toMatchObject({ code: raw.code, limitKind: raw.limitKind, limitOrigin: raw.limitOrigin,
      allowedBytes: raw.allowedBytes, bodyBytes: raw.bodyBytes, officialRenderDataLimit: false,
      recordGenerationCurrent: false, recordGenerationRetired: true });
    expect(JSON.stringify(projected)).not.toMatch(/private|SECRET|headers/iu);
    const invalid = safeBrowserFailureDiagnostics({ nativeFirstFatal: { ...raw, limitOrigin: "PRIVATE", allowedBytes: -1,
      bodyBytes: Infinity, officialRenderDataLimit: "true" } }).nativeFirstFatal;
    expect(invalid.limitOrigin).toBeUndefined(); expect(invalid.allowedBytes).toBeUndefined();
    expect(invalid.bodyBytes).toBeUndefined(); expect(invalid.officialRenderDataLimit).toBeUndefined();
  });
  it("keeps complete closed render gates and removes raw fields", () => {
    const officialRenderGate = { nativeTransport: true, mainFrame: true, navigationRequestPresent: true, navigationStatus200: true,
      witnessPresent: true, witnessRequestMatches: true, witnessUrlMatches: true, completedDocumentRead: true,
      officialRootProof: false, officialSubpageProof: false, pendingSubpagePresent: false, subpageTokenPresent: false,
      linkCount: "MULTIPLE", linkFailure: "LINK_COUNT", anchorFailure: "SIGNATURE_CHANGED", anchorOrdinal: "SECOND",
      url: "https://private.example/?token=SECRET" };
    const projected = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_RESPONSE_LIMIT", officialRenderGate } }).nativeFirstFatal;
    expect(projected.officialRenderGate).toMatchObject({ linkCount: "MULTIPLE", linkFailure: "LINK_COUNT",
      anchorFailure: "SIGNATURE_CHANGED", anchorOrdinal: "SECOND" });
    expect(JSON.stringify(projected)).not.toMatch(/private|SECRET|https:|"url":/iu);
    const malformed = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_RESPONSE_LIMIT",
      officialRenderGate: { ...officialRenderGate, mainFrame: "true" } } }).nativeFirstFatal;
    expect(malformed.officialRenderGate).toBeUndefined();
    const invalidReason = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_RESPONSE_LIMIT",
      officialRenderGate: { ...officialRenderGate, anchorFailure: "PRIVATE" } } }).nativeFirstFatal;
    expect(invalidReason.officialRenderGate?.anchorFailure).toBeUndefined();
  });
  it("preserves closed redirect provenance through feedback, checkpoint and compact snapshots", () => {
    const expected = { code: "NATIVE_REDIRECT_PROVENANCE_REJECTED", phase: "REDIRECT_PROVENANCE", method: "GET", resourceType: "document",
      parentPresent: true, redirectParentMethod: "POST", redirectParentStatus: 302, redirectParentComplete: true,
      redirectLocationMatches: false, redirectNetworkMatches: true, redirectChildBodyAbsent: true, redirectBootstrapAttested: true };
    const diagnostic = { ...expected, body: "private-body", headers: { authorization: "private-authorization" },
      parentUrl: "https://venue.example/read?token=private-value", requestId: "private-id", arbitrary: "private-extra" };
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: diagnostic, nativeRejectedRequests: [diagnostic] });
    expect(safe.nativeFirstFatal).toEqual(expected); expect(safe.nativeRejectedRequests).toEqual([expected]);
    const feedback = discoveryBrowserFeedback(safe, "open", { code: expected.code });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } }, "https://venue.example/");
    expect(restored.lastFeedback.details.nativeFirstFatal).toEqual(expected);
    const compact = createDiscoverySnapshotCompactor(), state = { url: "https://venue.example/", text: "Same public page", controls: [], loading: false, nativeFirstFatal: diagnostic };
    expect(compact(state).nativeFirstFatal).toEqual(expected);
    compact(state);
    expect(compact(state)).toMatchObject({ unchanged: true, nativeFirstFatal: expected });
    expect(compact({ ...state, nativeFirstFatal: { ...diagnostic, redirectParentStatus: 303 } })).toHaveProperty("text");
    diagnostic.redirectParentStatus = 999;
    expect(feedback.details.nativeFirstFatal).toEqual(expected); expect(restored.lastFeedback.details.nativeFirstFatal).toEqual(expected);
    expect(JSON.stringify(safe)).not.toMatch(/private|body|headers|parentUrl|requestId|arbitrary/);
    for (const method of ["GET", "HEAD", "POST", "OTHER"])
      expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: expected.code, redirectParentMethod: method } }).nativeFirstFatal)
        .toEqual({ code: expected.code, redirectParentMethod: method });
    for (const status of [100, 302, 303, 599])
      expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: expected.code, redirectParentStatus: status } }).nativeFirstFatal)
        .toEqual({ code: expected.code, redirectParentStatus: status });
  });
  it("omits malformed redirect provenance without copying supplied values", () => {
    const code = "NATIVE_REDIRECT_PROVENANCE_REJECTED";
    for (const redirectParentMethod of ["PUT", "post", "POST private", ["POST"], {}, null])
      expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { code, redirectParentMethod } }).nativeFirstFatal).toEqual({ code });
    for (const redirectParentStatus of [99, 600, 302.5, "302", NaN, Infinity, null, [302]])
      expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { code, redirectParentStatus } }).nativeFirstFatal).toEqual({ code });
    for (const value of ["true", "private", 1, [], {}, null]) {
      const diagnostic = { code, phase: ["REDIRECT_PROVENANCE"], redirectParentComplete: value, redirectLocationMatches: value,
        redirectNetworkMatches: value, redirectChildBodyAbsent: value, redirectBootstrapAttested: value, body: "private-body", headers: "private-headers" };
      const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: diagnostic, nativeRejectedRequests: [diagnostic] });
      expect(safe.nativeFirstFatal).toEqual({ code }); expect(safe.nativeRejectedRequests).toEqual([{ code }]);
    }
  });
  it("bounds native diagnostics and omits malformed metadata and unsafe URLs", () => {
    const safe = safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_ID_MISSING",
      method: "GET private", resourceType: "script private", interceptedRequests: 1026, recordCount: -1, requestLimit: Infinity,
      postDataBytes: 1_000_001, framePresent: "true", networkIdPresent: 0, phase: "private", arbitrary: "private" },
    nativeRejectedRequests: Array.from({ length: 100 }, (_, index) => ({ code: "NATIVE_REDIRECT_POST_BODY_LIMIT",
      url: `https://venue.example/read-${index}?value=private`, method: "POST", resourceType: "xhr" })) });
    expect(safe.nativeFirstFatal).toEqual({ code: "NATIVE_REDIRECT_NETWORK_ID_MISSING" });
    expect(safe.nativeRejectedRequests).toHaveLength(12);
    expect(safe.nativeRejectedRequests[0].url).toBe("https://venue.example/read-88");
    for (const url of ["https://venue.example/read?token=private", "https://venue.example/login", "https://user:private@venue.example/read",
      "https://venue.example/session/private-id", "https://venue.example/token/private-id", "https://venue.example/secret/private-id",
      "https://venue.example/%73ession/private-id", "https://venue.example/read%2Fcredentials%2Fprivate-id",
      "http://venue.example/read", "https://127.0.0.1/read", "https://sc.cps.golf/Example/(S(abc123abc123abc123abc123))/Home/nIndex"]) {
      expect(safeBrowserFailureDiagnostics({ nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_ID_MISSING", url } }).nativeFirstFatal)
        .toEqual({ code: "NATIVE_REDIRECT_NETWORK_ID_MISSING" });
    }
    for (const value of [null, [], "private", { code: "private" }, { code: "HTTP_403" }, { code: ["NATIVE_REDIRECT_NETWORK_ID_MISSING"] }]) {
      const invalid = safeBrowserFailureDiagnostics({ nativeFirstFatal: value, nativeRejectedRequests: [value] });
      expect(invalid).not.toHaveProperty("nativeFirstFatal");
      expect(invalid).not.toHaveProperty("nativeRejectedRequests");
    }
    expect(JSON.stringify(safe)).not.toMatch(/private|arbitrary|Infinity/);
  });
  it("keeps sanitized native diagnostics in initial and compact snapshots and detects new first-fatal evidence", () => {
    const compact = createDiscoverySnapshotCompactor();
    const state = { url: "https://venue.example/", text: "Same public page", controls: [], loading: false,
      nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_ID_MISSING", method: "GET", resourceType: "document", body: "private" },
      nativeRejectedRequests: [{ code: "NATIVE_REDIRECT_POST_BODY_LIMIT", url: "https://venue.example/read?date=private", headers: "private" }] };
    expect(JSON.stringify(compact(state))).not.toContain("private");
    compact(state);
    expect(compact(state)).toMatchObject({ unchanged: true, nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_ID_MISSING" },
      nativeRejectedRequests: [{ code: "NATIVE_REDIRECT_POST_BODY_LIMIT", url: "https://venue.example/read" }] });
    expect(compact({ ...state, nativeFirstFatal: { code: "NATIVE_REDIRECT_FRAME_MISSING" } })).toHaveProperty("text");
    expect(state.nativeFirstFatal.body).toBe("private");
    expect(JSON.stringify(createDiscoverySnapshotCompactor()({ ...state, structure: { nodes: [] } }))).not.toContain("private");
  });
  it.each([false, true, undefined, "true"])("never turns model unsupported prose into a terminal verdict, access flag %s", access => {
    expect(discoveryCheckpointDisposition("UNSUPPORTED", access)).toBe("RETRYABLE_LIMITATION");
    expect(discoveryCheckpointDisposition(undefined, access)).toBe("CONTINUE");
  });
  it("keeps terminal access dependent on the current exact boolean observation", () => {
    expect(discoveryCheckpointDisposition("ACCESS_REQUIRED", true)).toBe("TERMINAL_ACCESS");
    for (const value of [undefined, false, "true", 1, {}])
      expect(() => discoveryCheckpointDisposition("ACCESS_REQUIRED", value)).toThrow("DISCOVERY_ACCESS_NOT_CONFIRMED");
    for (const value of ["TOOL_FAILURE", "ALL_ENGINES_UNSUPPORTED", null, { outcome: "UNSUPPORTED" }])
      expect(() => discoveryCheckpointDisposition(value, true)).toThrow("DISCOVERY_CHECKPOINT_INVALID");
  });
  it("retains sanitized adapter identity evidence without interpreting an unverified result as a tool crash or access wall", () => {
    const feedback = discoveryBrowserFeedback({ url: "https://venue.example/times?date=2026-10-23", requests: [] }, "inspect_adapter",
      { code: "ADAPTER_IDENTITY_MISMATCH", message: "secret raw provider response" });
    const diagnostic = noVerifiedRecipeDiagnostic(feedback);
    expect(diagnostic).toEqual({ code: "NO_VERIFIED_RECIPE", reason: "ADAPTER_IDENTITY_MISMATCH", evidence: {
      code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "inspect_adapter", failure: {
        code: "ADAPTER_IDENTITY_MISMATCH", url: "https://venue.example/times" }, requests: [] } } });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: feedback } }, "https://venue.example/");
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|2026|ACCESS_REQUIRED|TOOL_FAILURE/);
    expect(noVerifiedRecipeDiagnostic({ code: "injected", details: { reason: "PRIVATE_VALUE" } }))
      .toEqual({ code: "NO_VERIFIED_RECIPE", reason: "NO_RECIPE_VERIFIED" });
    expect(noVerifiedRecipeDiagnostic(discoveryBrowserFeedback({ loading: true, pendingRequestCount: 1, requests: [] }, "observe")))
      .toEqual({ code: "NO_VERIFIED_RECIPE", reason: "NO_RECIPE_VERIFIED" });
  });
  it("keeps model capability reports unverified and ignores invented terminal evidence", () => {
    const diagnostic = noVerifiedRecipeDiagnostic({ code: "DISCOVERY_CAPABILITY_UNVERIFIED", details: {
      reason: "ALL_ENGINES_UNSUPPORTED", rawBody: "private provider text", outcome: "UNSUPPORTED" } });
    expect(diagnostic).toEqual({ code: "NO_VERIFIED_RECIPE", reason: "CAPABILITY_LIMITATION_UNVERIFIED",
      evidence: { code: "DISCOVERY_CAPABILITY_UNVERIFIED", details: { reason: "CAPABILITY_LIMITATION_UNVERIFIED" } } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|ALL_ENGINES_UNSUPPORTED|rawBody|outcome/);
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: diagnostic.evidence } }, "https://venue.example/");
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure)).toEqual(diagnostic);
  });
  it("retains a passive denied POST after a healthy first open without making it the causal terminal reason", () => {
    const feedback = discoveryBrowserFeedback({ url: "https://venue.example/", loading: false, pendingRequestCount: 0,
      requests: [{ url: "https://venue.example/telemetry?value=private", method: "POST", resourceType: "fetch",
        blockedReason: "UNSAFE_METHOD", body: "private" }] }, "open");
    expect(feedback.details).toMatchObject({ action: "open", loading: false, pendingRequestCount: 0,
      requests: [{ code: "UNSAFE_METHOD", url: "https://venue.example/telemetry", method: "POST", resourceType: "fetch" }] });
    expect(feedback.details).not.toHaveProperty("failure");
    expect(discoveryCheckpointDisposition("UNSUPPORTED", false)).toBe("RETRYABLE_LIMITATION");
    const diagnostic = noVerifiedRecipeDiagnostic(feedback);
    expect(diagnostic).toEqual({ code: "NO_VERIFIED_RECIPE", reason: "NO_RECIPE_VERIFIED", evidence: feedback });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: feedback } }, "https://venue.example/");
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });
  it("keeps an explicit stale action causal while retaining separate passive request denials", () => {
    const feedback = discoveryBrowserFeedback({ loading: false, pendingRequestCount: 0,
      requests: [{ url: "https://venue.example/telemetry", method: "POST", resourceType: "fetch", blockedReason: "UNSAFE_METHOD" }] },
    "click", { code: "STALE_OR_UNKNOWN_ELEMENT" });
    expect(noVerifiedRecipeDiagnostic(feedback)).toMatchObject({ reason: "STALE_OR_UNKNOWN_ELEMENT", evidence: {
      details: { failure: { code: "STALE_OR_UNKNOWN_ELEMENT" }, requests: [{ code: "UNSAFE_METHOD" }] } } });
  });
  it("uses an actual native fatal before passive denials while preserving explicit tool failure precedence", () => {
    const snapshot = { loading: false, requests: [{ url: "https://venue.example/telemetry", method: "POST",
      resourceType: "fetch", blockedReason: "UNSAFE_METHOD" }],
    nativeFirstFatal: { code: "NATIVE_REDIRECT_DRAIN_FAILED", phase: "DOCUMENT_DRAIN" } };
    expect(noVerifiedRecipeDiagnostic(discoveryBrowserFeedback(snapshot, "observe"))).toMatchObject({
      reason: "NATIVE_REDIRECT_DRAIN_FAILED", evidence: { details: { nativeFirstFatal: snapshot.nativeFirstFatal,
        requests: [{ code: "UNSAFE_METHOD" }] } } });
    expect(noVerifiedRecipeDiagnostic(discoveryBrowserFeedback(snapshot, "click", { code: "STALE_OR_UNKNOWN_ELEMENT" })))
      .toMatchObject({ reason: "STALE_OR_UNKNOWN_ELEMENT" });
  });
  it("preserves explicit replay failure classification without promoting unrelated request evidence", () => {
    const diagnostic = noVerifiedRecipeDiagnostic({ code: "DISCOVERY_REPLAY_INCOMPLETE", details: {
      status: "INCOMPLETE", reason: "ADAPTER_HTTP_ERROR", diagnostic: { code: "ADAPTER_HTTP_ERROR",
        simulatorError: { code: "HTTP_ERROR", retryable: true, httpStatus: 503 } },
      requests: [{ code: "UNSAFE_METHOD", body: "private" }] } });
    expect(diagnostic).toMatchObject({ reason: "ADAPTER_HTTP_ERROR", evidence: { code: "DISCOVERY_REPLAY_INCOMPLETE",
      details: { status: "INCOMPLETE", reason: "ADAPTER_HTTP_ERROR", diagnostic: { simulatorError: { httpStatus: 503 } } } } });
    expect(diagnostic.evidence.details).not.toHaveProperty("requests");
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });
  it("preserves bounded rejected URL facts and method through current and historical request checkpoints", () => {
    const url = "https://venue.example/api/options?version=1.2.3&api_key=private-value#private-fragment";
    const urlRejection = describePublicUrlRejection(url, url, "GET", "xhr", "BROWSER_REQUEST_URL", {
      recipe: () => true, asset: () => false });
    const snapshot = { loading: false, pendingRequestCount: 0,
      requests: [{ url: "https://venue.example/api/options", method: "GET", resourceType: "xhr", blockedReason: "UNSAFE_URL", urlRejection }],
      requestFailures: [{ url: "https://venue.example/api/options", method: "GET", resourceType: "xhr", reason: "UNSAFE_URL", urlRejection }] };
    const safe = safeBrowserFailureDiagnostics(snapshot);
    expect(safe.requests[0].urlRejection).toEqual(urlRejection);
    expect(safe.requestFailures[0]).toMatchObject({ method: "GET", url: "https://venue.example/api/options", urlRejection });
    const feedback = discoveryBrowserFeedback(safe, "observe");
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: feedback } }, "https://venue.example/");
    expect(restored.lastFailure.details.requests).toHaveLength(1);
    expect(restored.lastFailure.details.requests[0]).toMatchObject({ code: "UNSAFE_URL", method: "GET", urlRejection });
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure).reason).toBe("NO_RECIPE_VERIFIED");
    expect(JSON.stringify(restored)).not.toMatch(/private|api_key=|version=|fragment/);
    const compact = createDiscoverySnapshotCompactor()({ ...snapshot, requests: safe.requests, requestFailures: safe.requestFailures });
    expect(compact.requestFailures[0].urlRejection).toEqual(urlRejection);
    safe.requests[0].urlRejection.queryKeys[0].valueClasses.push("EMPTY");
    expect(restored.lastFailure.details.requests[0].urlRejection.queryKeys[0].valueClasses).toEqual(["DOTTED_VERSION"]);
  });
  it("preserves bounded argument schema issues without rejected values or unknown property names", () => {
    const issues = [{ path: ["target"], code: "invalid_type", input: "private-value", message: "private-value" },
      { path: [], code: "unrecognized_keys", keys: ["selector", "private@example.org"] }];
    const sanitized = safeBrowserActionIssues(issues);
    expect(safeBrowserActionIssues(sanitized)).toEqual(sanitized);
    const feedback = discoveryBrowserFeedback(undefined, "click", { code: "BROWSER_ACTION_SCHEMA_INVALID", details: { issues } });
    expect(feedback.details.issues).toEqual([{ path: "target", code: "invalid_type" },
      { path: "", code: "unrecognized_keys", keys: ["selector", "field"] }]);
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } }, "https://venue.example/");
    expect(restored.lastFeedback).toEqual(feedback);
    expect(JSON.stringify(feedback)).not.toMatch(/private|input|message/);
  });
  it("binds adapter address evidence to trusted demand and discards a model-supplied address when demand has none", () => {
    const proposed = { source: { venueAddress: "Untrusted address", bookingUrl: "https://venue.example/booking" } };
    const job = { request: { target: { courseId: "course" }, identity: { name: "Public course", officialUrl: "https://venue.example/", address: "12 Public Road" }, input: { timeZone: "America/New_York" } } };
    expect(bindDiscoveryRecipeIdentity(proposed, job).source.venueAddress).toBe("12 Public Road");
    const withoutAddress = { ...job, request: { ...job.request, identity: { ...job.request.identity, address: undefined } } };
    expect(bindDiscoveryRecipeIdentity(proposed, withoutAddress).source).not.toHaveProperty("venueAddress");
  });
  it("copies an alternate-address proof only from the current exact controller observation", () => {
    const job = { id: "job-1", request: { target: { courseId: "course" }, identity: { name: "Public course", officialUrl: "https://venue.example/" }, input: { timeZone: "UTC" } } };
    const proposed = { source: { bookingUrl: "https://public.book.teeitup.com/" },
      adapter: { family: "TEEITUP", alias: "public", facilityIds: [7], officialIdentityProof: { forged: true } } };
    const observed = { jobId: job.id, officialUrl: job.request.identity.officialUrl, bookingUrl: proposed.source.bookingUrl,
      adapter: { family: "TEEITUP", alias: "public", facilityIds: [7], officialIdentityProof: { source: "https://venue.example/", digest: "trusted" } } };
    expect(bindDiscoveryRecipeIdentity(proposed, job).adapter).not.toHaveProperty("officialIdentityProof");
    expect(bindDiscoveryRecipeIdentity(proposed, job, observed).adapter.officialIdentityProof).toEqual(observed.adapter.officialIdentityProof);
    for (const mismatch of [
      { ...observed, jobId: "another-job" },
      { ...observed, officialUrl: "https://other.example/" },
      { ...observed, bookingUrl: "https://other.book.teeitup.com/" },
      { ...observed, adapter: { ...observed.adapter, alias: "other" } },
      { ...observed, adapter: { ...observed.adapter, facilityIds: [8] } },
      { ...observed, adapter: { ...observed.adapter, officialIdentityProof: "malformed" } },
    ]) expect(bindDiscoveryRecipeIdentity(proposed, job, mismatch).adapter).not.toHaveProperty("officialIdentityProof");
    expect(proposed.adapter.officialIdentityProof).toEqual({ forged: true });
  });
  it("retains public bootstrap failures across a checkpoint without retaining bodies, query values or page text", () => {
    const feedback = discoveryBrowserFeedback({ url: "https://venue.example/", text: "do not retain this text",
      loading: true, pendingRequestCount: 2, requests: [{ url: "https://api.example/services?site=private-value",
        method: "POST", resourceType: "fetch", blockedReason: "UNSAFE_METHOD", body: { email: "private@example.org" }, headers: { secret: "private-key" } }] }, "open");
    const checkpoint = { controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } };
    expect(readDiscoveryControllerCheckpoint(checkpoint, "https://venue.example/").lastFeedback).toEqual({
      code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "open", loading: true, pendingRequestCount: 2,
        requests: [{ code: "UNSAFE_METHOD", url: "https://api.example/services", method: "POST", resourceType: "fetch" }] } });
    expect(JSON.stringify(feedback)).not.toMatch(/private|retain this|headers|email/);
  });

  it("retains a failed navigation with only the last public path", () => {
    expect(discoveryBrowserFeedback({ url: "https://venue.example/times?date=2026-10-23", requests: [] }, "click",
      { code: "BROWSER_NAVIGATION_FAILED", message: "sensitive details" })).toEqual({ code: "DISCOVERY_BROWSER_INCOMPLETE", details: {
      action: "click", failure: { code: "BROWSER_NAVIGATION_FAILED", url: "https://venue.example/times" }, requests: [] } });
  });

  it("retains bounded recent failures after the per-observation request journal drains", () => {
    const feedback = discoveryBrowserFeedback({ loading: false, requests: [], requestFailures: [
      { reason: "UNSAFE_METHOD", resourceType: "fetch", url: "https://venue.example/public-read?value=private", body: "private" },
      { reason: "UNOBSERVED_CPS_SESSION", resourceType: "document", url: "https://sc.cps.golf/Example/(S(abc123abc123abc123abc123))/Home/nIndex" },
      { reason: "unsafe private text", resourceType: "fetch", url: "https://venue.example/" },
    ] }, "observe");
    expect(feedback.details.requests).toEqual([
      { code: "UNOBSERVED_CPS_SESSION", resourceType: "document" },
      { code: "UNSAFE_METHOD", resourceType: "fetch", url: "https://venue.example/public-read" },
    ]);
    expect(JSON.stringify(feedback)).not.toMatch(/private|abc123|body/);
    const bounded = discoveryBrowserFeedback({ requests: [], requestFailures: Array.from({ length: 100 }, (_, index) => ({
      reason: "UNSAFE_METHOD", resourceType: "fetch", url: `https://venue.example/read-${index}`,
    })) }, "observe");
    expect(bounded.details.requests).toHaveLength(8);
    expect(bounded.details.requests[0].url).toBe("https://venue.example/read-99");
  });

  it("bounds hostile diagnostic collections and discards arbitrary fields", () => {
    const requests = Array.from({ length: 100 }, () => ({ url: "https://venue.example/api", method: "POST", resourceType: "fetch",
      blockedReason: "UNSAFE_METHOD", body: { secret: "must not survive" } }));
    const feedback = discoveryBrowserFeedback({ loading: true, pendingRequestCount: 99_999, requests }, "untrusted-action");
    expect(feedback.details).toMatchObject({ action: "observe", pendingRequestCount: 1024 });
    expect(feedback.details.requests).toHaveLength(1);
    expect(feedback.details.requests[0]).toMatchObject({ code: "UNSAFE_METHOD", url: "https://venue.example/api" });
    expect(JSON.stringify(feedback)).not.toContain("secret");
  });

  it("does not treat successful completed reads or denied incidental media as failed availability", () => {
    expect(discoveryBrowserFeedback({ loading: false, pendingRequestCount: 0, requests: [
      { url: "https://venue.example/times", method: "GET", resourceType: "fetch", status: 200 },
      { url: "https://venue.example/image", method: "GET", resourceType: "image", blockedReason: "DENIED" },
    ] }, "observe")).toBeUndefined();
  });
});
