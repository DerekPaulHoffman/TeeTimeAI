import { expect, it } from "vitest";
import { createStagehandNativeRouterFailureCapture, projectStagehandNativeRouterFailure, stagehandNativeRouterBooleanKeys, stagehandNativeRouterCodes, stagehandSourceRequestGuards, recordStagehandSourceNavigationFailure, stagehandRedirectRejections, classifyNativeRouterError, nativeRouterOperations, nativeRouterErrorNames, nativeRouterErrorCategories, createStagehandHostGuardFailureCapture, stagehandHostGuardReasons } from "./stagehand-native-router-diagnostic";
import { stagehandSourceDomGuardReason, stagehandNativeFrameDocumentUrl } from "./stagehand-source-browser";
import { sourceFailureDiagnostic } from "../../../scripts/automation/stagehand/source-diagnostic.mjs";
it("captures only the first actual closed host guard separately from native failures", () => {
  for (const [stage, reasons] of Object.entries(stagehandHostGuardReasons)) for (const reason of reasons) {
    const capture = createStagehandHostGuardFailureCapture();
    capture.record({ stage, reason } as Parameters<typeof capture.record>[0]);
    capture.record({ stage: "CHECK", reason: "TERMINAL" });
    const copy = capture.snapshot()!; copy.reason = "ABORTED";
    const diagnostic = sourceFailureDiagnostic({ phase: "EVIDENCE", hostGuardFailure: capture.snapshot() });
    expect(diagnostic.hostGuardFailure).toEqual({ stage, reason });
    expect(diagnostic.nativeRouterFailure).toBeUndefined();
  }
  expect(createStagehandHostGuardFailureCapture().snapshot()).toBeUndefined();
});
it("matches the full paired native frame URL including its separately attested fragment", () => {
  const frame = { id: "private-frame", loaderId: "private-loader", url: "https://public.example.org/" };
  expect(stagehandSourceDomGuardReason(frame, frame, { url: frame.url }, false)).toBeUndefined();
  for (const [changed, reason] of [[{ id: "" }, "FRAME_MISSING"], [{ loaderId: "" }, "LOADER_MISSING"]] as const)
    expect(stagehandSourceDomGuardReason({ ...frame, ...changed }, frame, { url: frame.url }, false)).toBe(reason);
  for (const [changed, reason] of [[{ id: "another-frame" }, "FRAME_CHANGED"], [{ loaderId: "another-loader" }, "LOADER_CHANGED"], [{ url: "https://public.example.org/next" }, "NATIVE_URL_CHANGED"]] as const)
    expect(stagehandSourceDomGuardReason(frame, { ...frame, ...changed }, { url: frame.url }, false)).toBe(reason);
  // Actual CDP shape: Page.Frame.url excludes its separate urlFragment, while
  // native DOM location.href includes it. Both full values must agree exactly.
  const native = { ...frame, urlFragment: "#public-section" }, dom = { url: frame.url + "#public-section" };
  expect(stagehandSourceDomGuardReason(native, native, dom, false)).toBeUndefined();
  expect(stagehandSourceDomGuardReason(native, native, dom, true)).toBeUndefined();
  expect(stagehandSourceDomGuardReason(native, { ...native, urlFragment: "#changed" }, dom, false)).toBe("NATIVE_URL_CHANGED");
  expect(stagehandSourceDomGuardReason(native, { ...native, urlFragment: "#changed" }, dom, true)).toBe("NATIVE_URL_CHANGED");
  expect(stagehandSourceDomGuardReason(native, native, { url: frame.url }, false)).toBe("DOM_URL_CHANGED");
  expect(stagehandSourceDomGuardReason(native, native, { url: frame.url + "#unobserved" }, false)).toBe("DOM_URL_CHANGED");
  for (const url of ["https://foreign.example.org/", frame.url + "next", frame.url + "?changed=1"])
    expect(stagehandSourceDomGuardReason(native, { ...native, url }, dom, false)).toBe("NATIVE_URL_CHANGED");
  for (const changed of [{ id: "foreign-frame" }, { loaderId: "new-loader" }])
    expect(stagehandSourceDomGuardReason(native, { ...native, ...changed }, dom, false)).not.toBeUndefined();
  const capture = createStagehandHostGuardFailureCapture();
  capture.record({ stage: "SOURCE_DOM", reason: "DOM_URL_CHANGED", nativeFrameHasFragment: true, domHasFragment: true });
  expect(sourceFailureDiagnostic({ hostGuardFailure: capture.snapshot() }).hostGuardFailure).toEqual(capture.snapshot());
});
it("reconstructs only valid native frame fragment fields without stripping or guessing", () => {
  const url = "https://public.example.org/path?view=public";
  for (const fragment of [undefined, "", "#public-section", "#"])
    expect(stagehandNativeFrameDocumentUrl({ url, ...(fragment === undefined ? {} : { urlFragment: fragment }) })).toBe(url + (fragment ?? ""));
  expect(stagehandNativeFrameDocumentUrl({ url: url + "#already-complete" })).toBe(url + "#already-complete");
  for (const frame of [{ url, urlFragment: null }, { url, urlFragment: 7 }, { url, urlFragment: "missing-hash" },
    { url, urlFragment: "#bad\nfragment" }, { url, urlFragment: "#" + "x".repeat(2048) },
    { url: url + "#first", urlFragment: "#first" }, { url: url + "#first", urlFragment: "" },
    { url: "https://user:private@public.example.org/", urlFragment: "#public" },
    { url: "javascript:void(0)", urlFragment: "#public" }, { url: "about:blank", urlFragment: "#public" },
    { url: "https://public.example.org", urlFragment: "#public" }, { url: "https://public.example.org/\n", urlFragment: "#public" }])
    expect(stagehandNativeFrameDocumentUrl(frame)).toBeUndefined();
  // Neither a forged DOM fragment nor an invalid native fragment repairs the
  // other side. The same native source must attest both captures exactly.
  const native = { id: "frame", loaderId: "loader", url, urlFragment: "not-a-fragment" };
  expect(stagehandSourceDomGuardReason(native, native, { url: url + "#from-dom" }, false)).toBe("NATIVE_URL_CHANGED");
});
it("carries only finite operation and exception facts through both native diagnostic projections", () => {
  for (const operation of nativeRouterOperations) for (const errorName of nativeRouterErrorNames) for (const errorCategory of nativeRouterErrorCategories) {
    const projected = projectStagehandNativeRouterFailure("NATIVE_REDIRECT_ROUTING_FAILED", { operation, errorName, errorCategory,
      requestUrlSha256: "a".repeat(64), message: "PRIVATE", headers: { cookie: "PRIVATE" } });
    expect(sourceFailureDiagnostic({ nativeRouterFailure: projected }).nativeRouterFailure).toEqual(projected);
  }
  expect(projectStagehandNativeRouterFailure("NATIVE_REDIRECT_ROUTING_FAILED", { operation: "PRIVATE", errorName: "PRIVATE", errorCategory: "PRIVATE", requestUrlSha256: "PRIVATE" })).toEqual({ code: "NATIVE_REDIRECT_ROUTING_FAILED" });
  expect(classifyNativeRouterError(new TypeError("PRIVATE https://private.example/?secret=PRIVATE"))).toEqual({ errorName: "TypeError", errorCategory: "UNKNOWN" });
  expect(classifyNativeRouterError(Error("Protocol error: No data found for resource with given identifier PRIVATE"))).toEqual({ errorName: "Error", errorCategory: "BODY_UNAVAILABLE" });
});
it("preserves every closed redirect rejection before cleanup and strips forged or unrelated reasons", () => {
  for (const redirectRejection of stagehandRedirectRejections) {
    const capture = createStagehandNativeRouterFailureCapture();
    capture.record("NATIVE_REDIRECT_PROVENANCE_REJECTED", { phase: "REDIRECT_PROVENANCE", redirectRejection, method: "GET", resourceType: "xhr",
      url: "https://private.example/?token=SECRET", requestId: "PRIVATE", headers: { cookie: "PRIVATE" } });
    capture.record("NATIVE_REDIRECT_CANCELLED", {});
    const projected = capture.snapshot()!;
    expect(projected.redirectRejection).toBe(redirectRejection);
    expect(sourceFailureDiagnostic({ nativeRouterFailure: projected }).nativeRouterFailure).toEqual(projected);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|SECRET|https:|requestId|headers/u);
  }
  expect(projectStagehandNativeRouterFailure("NATIVE_REDIRECT_PROVENANCE_REJECTED", { phase: "REDIRECT_PROVENANCE", redirectRejection: "PRIVATE" })).not.toHaveProperty("redirectRejection");
  expect(projectStagehandNativeRouterFailure("NATIVE_REDIRECT_CANCELLED", { phase: "REDIRECT_PROVENANCE", redirectRejection: "CROSS_HOST" })).not.toHaveProperty("redirectRejection");
  expect(projectStagehandNativeRouterFailure("NATIVE_REDIRECT_PROVENANCE_REJECTED", { phase: "RESPONSE_WAIT", redirectRejection: "CROSS_HOST" })).not.toHaveProperty("redirectRejection");
});
it("ignores subframe, foreign page, ancillary and teardown rejections before capturing an owned main navigation", () => {
  const capture = createStagehandNativeRouterFailureCapture(), frame = {}, page = {}, foreign = {};
  const state = { navigationRequest: true, frame, page, ownedFrame: frame, ownedPage: page, closed: false, aborted: false };
  for (const delta of [{ frame: foreign }, { page: foreign }, { navigationRequest: false }, { closed: true }, { aborted: true }]) {
    recordStagehandSourceNavigationFailure(capture, { ...state, ...delta }, "FRAME_OWNERSHIP", "GET", "document");
    expect(capture.snapshot()).toBeUndefined();
  }
  recordStagehandSourceNavigationFailure(capture, state, "TRANSACTION_URL", "GET", "document");
  expect(capture.snapshot()).toEqual({ code: "STAGEHAND_GUARDED_SOURCE_REJECTED", phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: "TRANSACTION_URL", method: "GET", resourceType: "document", rootFrame: true });
});
it("retains only the actual earliest closed source navigation guard without URL or error payload", () => {
  for (const guard of stagehandSourceRequestGuards) {
    const capture = createStagehandNativeRouterFailureCapture();
    capture.record("STAGEHAND_GUARDED_SOURCE_REJECTED", { phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: guard, method: "GET", resourceType: "document", rootFrame: true,
      url: "https://private.example/?token=SECRET", message: "PRIVATE", headers: { cookie: "PRIVATE" } });
    capture.record("NATIVE_REDIRECT_CANCELLED", {});
    const projected = capture.snapshot()!;
    expect(projected.sourceRequestGuard).toBe(guard);
    expect(sourceFailureDiagnostic({ phase: "OPEN", nativeRouterFailure: projected }).nativeRouterFailure).toEqual(projected);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|SECRET|https:|headers|message|url/u);
  }
  expect(projectStagehandNativeRouterFailure("STAGEHAND_GUARDED_SOURCE_REJECTED", { phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: "PRIVATE" })).not.toHaveProperty("sourceRequestGuard");
  expect(projectStagehandNativeRouterFailure("NATIVE_REDIRECT_CANCELLED", { phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: "STATE" })).not.toHaveProperty("sourceRequestGuard");
  expect(sourceFailureDiagnostic({ nativeRouterFailure: { code: "STAGEHAND_GUARDED_SOURCE_REJECTED", phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: "PRIVATE" } }).nativeRouterFailure).toBeUndefined();
});
it("preserves only actual closed continuation role/lifecycle booleans", () => {
  const facts = { phase: "CONTINUE_REQUEST_ACK", method: "GET", resourceType: "document", rootFrame: true,
    recordGenerationCurrent: false, recordGenerationRetired: true, recordAdmitted: true, recordPaused: false,
    recordResponsePaused: false, recordFailed: true, recordComplete: false, recordHandlerDone: false, recordTerminalObserved: true,
    url: "https://private.example/", requestId: "PRIVATE", headers: { cookie: "PRIVATE" } };
  const d = projectStagehandNativeRouterFailure("OWNED_STAGEHAND_CDP_UNAVAILABLE", facts);
  expect(d.phase).toBe("CONTINUE_REQUEST_ACK"); expect(d.recordGenerationRetired).toBe(true);
  expect(sourceFailureDiagnostic({ nativeRouterFailure: d }).nativeRouterFailure).toEqual(d);
  expect(JSON.stringify(d)).not.toMatch(/PRIVATE|https:|requestId|headers/u);
  expect(projectStagehandNativeRouterFailure("UNKNOWN", { recordGenerationCurrent: "true" })).not.toHaveProperty("recordGenerationCurrent");
});

it("captures the earliest native callback before page teardown and keeps a later socket observation separate", () => {
  const capture = createStagehandNativeRouterFailureCapture(), order: string[] = [];
  const nativeFailure = () => { capture.record("NATIVE_REDIRECT_LOADER_MISMATCH", { phase: "LOADER_OWNER", method: "GET", resourceType: "script", loaderKnown: false }); order.push("native"); };
  const pageClose = () => { order.push("page-close"); capture.record("NATIVE_REDIRECT_CANCELLED", {}); };
  nativeFailure(); pageClose();
  expect(order).toEqual(["native", "page-close"]);
  const snapshot = capture.snapshot()!; snapshot.code = "UNKNOWN";
  expect(capture.snapshot()).toEqual({ code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_OWNER", method: "GET", resourceType: "script", loaderKnown: false });
  const d = sourceFailureDiagnostic({ error: Error("SDK_PRIVATE"), phase: "EXTRACT", nativeRouterFailure: capture.snapshot(), ownedCdpFailure: { layer: "SOCKET_ERROR", pendingRequests: 2 } });
  expect(d.nativeRouterFailure.code).toBe("NATIVE_REDIRECT_LOADER_MISMATCH"); expect(d.ownedCdpFailure.layer).toBe("SOCKET_ERROR");
  expect(d.transportCode).toBeUndefined();
});
it("projects only code/phase/type/method and actual booleans, never raw native firstFatal fields", () => {
  const raw = { code: "PRIVATE", phase: "RESPONSE_WAIT", method: "GET", resourceType: "script", rootFrame: false, loaderKnown: true,
    url: "https://private.example/?token=SECRET", networkId: "PRIVATE", headers: { secret: "SECRET" }, postDataBytes: 99, recordCount: 99, stack: "SECRET" };
  const projected = projectStagehandNativeRouterFailure("NATIVE_REDIRECT_RESPONSE_TIMEOUT", raw);
  expect(projected).toEqual({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT", method: "GET", resourceType: "script", rootFrame: false, loaderKnown: true });
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|SECRET|https:|networkId|headers|stack|99/);
  expect(projectStagehandNativeRouterFailure("PRIVATE_CODE", { phase: "PRIVATE", method: "PRIVATE", resourceType: "PRIVATE", rootFrame: "false" })).toEqual({ code: "UNKNOWN" });
});
it("accepts every actual producer code/boolean in the source schema and rejects extra, malformed or private fields", () => {
  const facts = Object.fromEntries(stagehandNativeRouterBooleanKeys.map(key => [key, true]));
  for (const code of stagehandNativeRouterCodes) {
    const projected = projectStagehandNativeRouterFailure(code, facts);
    expect(sourceFailureDiagnostic({ nativeRouterFailure: projected }).nativeRouterFailure).toEqual(projected);
  }
  for (const delta of [{ url: "https://private.example/" }, { code: "PRIVATE" }, { method: "PRIVATE" }, { loaderKnown: 1 }])
    expect(sourceFailureDiagnostic({ nativeRouterFailure: { code: "NATIVE_REDIRECT_RECORD_LIMIT", ...delta } }).nativeRouterFailure).toBeUndefined();
});
it("passes only finite nonnegative limit counters and closed limit kind through the existing private projection", () => {
  const raw = { limitKind: "DECODED_BODY", allowedBytes: 2_000_000, declaredBytes: 128, bodyBytes: 6_000_000, totalBytes: 7_000_000,
    method: "GET", resourceType: "document", documentResponse: true, ancillaryResponse: false, declaredLengthPresent: true,
    url: "https://private.example/?token=SECRET", headers: { secret: "PRIVATE" } };
  const projected = projectStagehandNativeRouterFailure("NATIVE_RESPONSE_LIMIT", raw);
  expect(sourceFailureDiagnostic({ nativeRouterFailure: projected }).nativeRouterFailure).toEqual(projected);
  expect(projected.limitKind).toBe("DECODED_BODY"); expect(projected.bodyBytes).toBe(6_000_000);
  const invalid = projectStagehandNativeRouterFailure("NATIVE_RESPONSE_LIMIT", { limitKind: "PRIVATE", allowedBytes: Infinity, declaredBytes: NaN, bodyBytes: -1, totalBytes: "SECRET" });
  expect(invalid).toEqual({ code: "NATIVE_RESPONSE_LIMIT" });
  expect(sourceFailureDiagnostic({ nativeRouterFailure: { code: "NATIVE_RESPONSE_LIMIT", bodyBytes: Infinity } }).nativeRouterFailure).toBeUndefined();
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|SECRET|https:|headers|url/u);
});
