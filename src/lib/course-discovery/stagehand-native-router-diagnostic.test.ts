import { expect, it } from "vitest";
import { createStagehandNativeRouterFailureCapture, projectStagehandNativeRouterFailure, stagehandNativeRouterBooleanKeys, stagehandNativeRouterCodes, stagehandSourceRequestGuards, recordStagehandSourceNavigationFailure, stagehandRedirectRejections } from "./stagehand-native-router-diagnostic";
import { sourceFailureDiagnostic } from "../../../scripts/automation/stagehand/source-diagnostic.mjs";
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
