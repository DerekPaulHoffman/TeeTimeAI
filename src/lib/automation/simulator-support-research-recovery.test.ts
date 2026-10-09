import { describe, expect, it } from "vitest";
import { getSimulatorResearchImplementationVersion, type SimulatorResearchBlockedRoute } from "./simulator-support-research-policy";
import { getSimulatorPostRepairResearchBoundary, selectRecoveredSimulatorResearchRoutes } from "./simulator-support-research-recovery";
import type { SimulatorSupportClaim } from "./simulator-support-policy";

const now = new Date("2026-10-08T17:00:00.000Z");
const url = "https://yourgolfbooking.com/venues/public-golf/booking/bays";
const receiptId = "11111111-1111-4111-8111-111111111111";
const failed: SimulatorResearchBlockedRoute = { url, rendered: true, httpStatus: 0,
  observedAt: "2026-10-08T03:00:00.000Z", requestId: receiptId,
  failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "HTTP_READ" } };
const positive: SimulatorResearchBlockedRoute = { url, rendered: true, httpStatus: 200,
  observedAt: "2026-10-08T04:00:00.000Z", requestId: "22222222-2222-4222-8222-222222222222", outcome: "READ",
  accessControlsObserved: true, accessControls: [], renderComplete: false,
  renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" };
const complete: SimulatorResearchBlockedRoute = { ...positive, observedAt: "2026-10-08T05:00:00.000Z",
  requestId: "44444444-4444-4444-8444-444444444444", renderComplete: true, renderWarning: undefined };
const recover = (actualRoutes: SimulatorResearchBlockedRoute[], inheritedRoutes: SimulatorResearchBlockedRoute[] = []) =>
  selectRecoveredSimulatorResearchRoutes({ actualRoutes, inheritedRoutes, now });

describe("server-owned parser release boundary", () => {
  const baseSha = "a".repeat(40), releaseSha = "b".repeat(40), sourceFingerprint = "c".repeat(64);
  const claim = (): SimulatorSupportClaim => ({
    token: "synthetic-owned-token", revision: 3, phase: "VERIFYING",
    claimedAt: "2026-10-08T16:30:00.000Z", leaseExpiresAt: "2026-10-08T17:15:00.000Z",
    sourceFingerprint, originalSourceFingerprint: sourceFingerprint, offeringRevision: 1,
    plannedPaths: ["src/lib/automation/simulator-support-research.ts"], releaseSha,
    branch: "fix/recheck-public-rental-details", recheckQueuedAt: null, verificationCycle: 0,
    deployment: { source: "git", state: "READY", branch: "main", commitSha: releaseSha,
      deployedAt: "2026-10-08T16:55:00.125Z", deploymentId: "dpl_fixture",
      deploymentUrl: "https://fixture.vercel.app", aliases: ["teetimespot.com", "www.teetimespot.com"] },
  });
  const boundary = (current = claim(), rest = {}) =>
    getSimulatorPostRepairResearchBoundary({ claim: current, baseSha, sourceFingerprint, now, ...rest });

  it("returns the registered deployment creation clock without substituting the later Ready observation or current time", () => {
    expect(boundary()).toEqual(new Date("2026-10-08T16:55:00.125Z"));
    expect(boundary(claim(), { now: new Date("2026-10-08T17:10:00.000Z") })).toEqual(boundary());
    const equal = claim();
    equal.deployment!.deployedAt = equal.claimedAt;
    expect(boundary(equal)).toEqual(new Date(equal.claimedAt));
  });

  it("requires the registered newer VERIFYING research release and the unchanged server source", () => {
    for (const delta of [
      { phase: "CLAIMED" as const }, { phase: "IMPLEMENTING" as const }, { releaseSha: null },
      { releaseSha: "invalid" }, { releaseSha: baseSha }, { revision: 0 },
      { plannedPaths: ["src/lib/simulators/providers/your-golf-booking.ts"] },
      { sourceFingerprint: "d".repeat(64) }, { deployment: null },
    ]) expect(boundary({ ...claim(), ...delta })).toBeNull();
    expect(boundary(claim(), { baseSha: releaseSha.toUpperCase() })).toBeNull();
    expect(boundary(claim(), { baseSha: "invalid" })).toBeNull();
    expect(boundary(claim(), { sourceFingerprint: "invalid" })).toBeNull();
    expect(boundary(claim(), { now: new Date("invalid") })).toBeNull();
  });

  it("applies every existing Git/main/Ready/commit/alias/clock deployment guard", () => {
    const current = claim();
    for (const delta of [
      { source: "cli" }, { state: "BUILDING" }, { branch: "feature/other" },
      { commitSha: "d".repeat(40) }, { deploymentId: "" },
      { deploymentUrl: "https://untrusted.example.test" }, { aliases: ["teetimespot.com"] },
      { aliases: ["www.teetimespot.com"] }, { aliases: undefined },
      { deployedAt: "invalid" }, { deployedAt: "2026-10-08T17:00:00.001Z" },
      { deployedAt: "2026-10-08T16:29:59.999Z" },
    ]) expect(boundary({ ...current, deployment: { ...current.deployment!, ...delta } } as SimulatorSupportClaim)).toBeNull();
  });
});

describe("post-repair public read recovery", () => {
  const postRepairResearchBoundary = new Date("2026-10-08T16:55:00.125Z");
  const recent: SimulatorResearchBlockedRoute = { ...complete, observedAt: "2026-10-08T16:50:00.000Z",
    requestId: "55555555-5555-4555-8555-555555555555", researchImplementationVersion: getSimulatorResearchImplementationVersion(url) };
  const copied = { ...failed, observedAt: undefined, requestId: undefined };
  const afterRepair = (actualRoutes: SimulatorResearchBlockedRoute[], inheritedRoutes: SimulatorResearchBlockedRoute[] = [copied]) => {
    const input = { actualRoutes, inheritedRoutes, now, postRepairResearchBoundary };
    return selectRecoveredSimulatorResearchRoutes(input);
  };

  it("recovers the same-route original tooling failure for one useful read after a newer owned parser deployment", () => {
    expect(recover([recent, failed], [copied]).size).toBe(0);
    expect([...afterRepair([recent, failed]).values()]).toEqual([recent]);
    expect([...afterRepair([{ ...recent, observedAt: "2026-10-08T15:00:00.000Z" }, failed]).values()])
      .toEqual([{ ...recent, observedAt: "2026-10-08T15:00:00.000Z" }]);
    expect(recent.renderComplete).toBe(true);
    expect(copied.observedAt).toBeUndefined();
  });

  it("withholds the early permission after the newest same-route receipt, even when it cannot qualify as a positive", () => {
    const next = { ...recent, observedAt: "2026-10-08T16:56:00.000Z",
      requestId: "66666666-6666-4666-8666-666666666666" };
    for (const newer of [next, { ...next, accessControlsObserved: undefined },
      { ...next, accessControls: undefined }, { ...next, renderComplete: false, renderWarning: undefined }]) {
      expect(afterRepair([recent, failed, newer]).size).toBe(0);
      expect(afterRepair([newer, failed, recent]).size).toBe(0);
    }
    expect(afterRepair([recent, failed, { ...next, observedAt: recent.observedAt }]).size).toBe(0);
  });

  it("does not waive unknown receipts, modes, versions, warnings, copied-original proof or stronger failure and access denials", () => {
    for (const delta of [
      { requestId: undefined }, { requestId: "invalid" }, { observedAt: undefined },
      { observedAt: postRepairResearchBoundary.toISOString() }, { observedAt: "2026-10-08T17:01:00.000Z" },
      { rendered: false }, { outcome: undefined }, { researchImplementationVersion: undefined },
      { researchImplementationVersion: "obsolete-reader" }, { researchImplementationVersion: "public-calendar-resource-local-v3" }, { renderComplete: false },
      { renderComplete: undefined }, { renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const },
      { accessControlsObserved: undefined }, { accessControls: undefined },
    ]) expect(afterRepair([{ ...recent, ...delta }, failed]).size).toBe(0);
    for (const denied of [
      ...[401, 403, 404].map(httpStatus => ({ ...failed, httpStatus, failure: undefined })),
      ...(["ACCOUNT_REQUIRED", "CAPTCHA_OR_CHALLENGE", "QUEUE"] as const).map(control => ({ ...recent, accessControls: [control] })),
      ...(["ACCESS", "SOURCE", "OWNERSHIP", "DATABASE", "NETWORK"] as const).map(category =>
        ({ ...failed, failure: { ...failed.failure!, category } })),
      { ...failed, observedAt: "2026-10-08T16:51:00.000Z", requestId: "77777777-7777-4777-8777-777777777777" },
    ]) {
      expect(afterRepair([recent, failed, denied]).size).toBe(0);
      expect(afterRepair([recent, failed], [copied, denied]).size).toBe(0);
    }
    expect(afterRepair([recent], [copied]).size).toBe(0);
    expect(afterRepair([recent, { ...failed, requestId: undefined }]).size).toBe(0);
    expect(afterRepair([recent, failed], [{ ...copied, failure: { ...failed.failure!, researchPhase: "BROWSER_DOCUMENT" } }]).size).toBe(0);
    expect(afterRepair([recent, failed, { ...recent, observedAt: undefined, requestId: undefined }]).size).toBe(0);
    expect(afterRepair([{ ...recent, url: url.replace("/bays", "") }, failed]).size).toBe(0);
  });
});

describe("later owned public research recovery", () => {
  it("revalidates an actual legacy partial receipt without inventing a missing warning or reader version", () => {
    const legacyPartial = { ...positive, renderWarning: undefined };
    const copied = { ...failed, observedAt: undefined, requestId: undefined };
    expect([...recover([legacyPartial, failed], [copied]).values()]).toEqual([legacyPartial]);
    expect(legacyPartial.renderWarning).toBeUndefined();
    expect(legacyPartial.researchImplementationVersion).toBeUndefined();
    expect(legacyPartial.renderComplete).toBe(false);
  });

  it("uses only a later actual partial receipt without relabeling the original failure or collector version", () => {
    const copied = { ...failed, observedAt: undefined, requestId: undefined };
    const actual = [positive, failed];
    expect([...recover(actual, [copied]).values()]).toEqual([positive]);
    expect(actual).toEqual([positive, failed]);
    expect(copied.observedAt).toBeUndefined();
    expect(positive.researchImplementationVersion).toBeUndefined();
    expect(positive.renderComplete).toBe(false);
  });

  it.each([401, 403, 404])("retains every explicit HTTP%s denial for the same route", httpStatus => {
    const denied = { ...failed, httpStatus, failure: undefined };
    expect(recover([positive, failed, denied]).size).toBe(0);
    expect(recover([positive, failed], [denied]).size).toBe(0);
    expect([...recover([positive, failed, { ...denied, rendered: false }]).values()]).toEqual([positive]);
  });

  it.each(["ACCOUNT_REQUIRED", "CAPTCHA_OR_CHALLENGE", "QUEUE"] as const)("retains a positively observed %s even before the partial recovery", control => {
    for (const httpStatus of [200, 503]) {
      const denied = { ...positive, httpStatus, observedAt: failed.observedAt, accessControls: [control] };
      expect(recover([positive, failed, denied]).size).toBe(0);
      expect(recover([positive, failed], [denied]).size).toBe(0);
    }
  });

  it.each(["ACCESS", "SOURCE", "OWNERSHIP", "DATABASE", "NETWORK"] as const)("cannot supersede a %s failure", category => {
    const denied = { ...failed, failure: { ...failed.failure!, category } };
    expect(recover([positive, denied]).size).toBe(0);
    expect(recover([positive, failed], [denied]).size).toBe(0);
  });

  it.each([
    { requestId: undefined }, { requestId: "invented" }, { requestId: receiptId }, { observedAt: undefined },
    { observedAt: "2026-10-08T17:01:00.000Z" }, { observedAt: "2026-10-08T16:00:00.001Z" },
    { observedAt: failed.observedAt }, { rendered: false }, { httpStatus: 403 },
    { accessControlsObserved: undefined }, { accessControls: undefined }, { accessControls: ["ACCOUNT_REQUIRED" as const] },
    { renderComplete: true }, { renderComplete: undefined }, { renderWarning: "MAIN_DOCUMENT_HTTP_ERROR" as const }, { outcome: undefined },
  ])("withholds recovery without the exact actual later partial receipt: %j", delta => {
    expect(recover([{ ...positive, ...delta }, failed]).size).toBe(0);
  });

  it("requires actual clocks for every copied tooling failure and keeps newer or ambiguous failures", () => {
    for (const delta of [{ failure: { ...failed.failure!, researchPhase: "BROWSER_DOCUMENT" as const } },
      { researchImplementationVersion: "unknown-version" }, { requestId: "invalid" },
      { failure: undefined }]) {
      expect(recover([positive, failed], [{ ...failed, observedAt: undefined, ...delta }]).size).toBe(0);
    }
    expect(recover([positive, failed], [{ ...failed, observedAt: "2026-10-08T05:00:00.000Z" }]).size).toBe(0);
    expect(recover([positive, { ...failed, observedAt: positive.observedAt }]).size).toBe(0);
    expect(recover([positive, { ...failed, observedAt: undefined }]).size).toBe(0);
    expect(recover([positive], [{ ...failed, observedAt: undefined }]).size).toBe(0);
    expect(recover([], [positive, failed]).size).toBe(0);
  });

  it("does not borrow another destination's success or supersede a later failure", () => {
    expect(recover([{ ...positive, url: url.replace("/bays", "") }, failed]).size).toBe(0);
    expect(recover([positive, failed, { ...failed, observedAt: "2026-10-08T05:00:00.000Z" }]).size).toBe(0);
  });

  it.each([positive.renderWarning, undefined])("uses the newest actual partial observation before evaluating cooldown, with warning %s", renderWarning => {
    const recent = { ...positive, renderWarning, observedAt: "2026-10-08T16:45:00.000Z", requestId: "33333333-3333-4333-8333-333333333333" };
    expect(recover([positive, failed, recent], [positive]).size).toBe(0);
    expect([...selectRecoveredSimulatorResearchRoutes({ actualRoutes: [positive, failed, recent],
      inheritedRoutes: [positive], now: new Date("2026-10-08T17:45:00.000Z") }).values()]).toEqual([recent]);
    expect(recover([positive, failed, { ...recent, observedAt: "2026-10-08T17:01:00.000Z" }], [positive]).size).toBe(0);
  });

  it("keeps legacy recovery fenced by access, missing originals or a later failure", () => {
    const legacyPartial = { ...positive, renderWarning: undefined };
    for (const denied of [
      { ...failed, httpStatus: 403, failure: undefined },
      { ...positive, httpStatus: 503, accessControls: ["CAPTCHA_OR_CHALLENGE" as const] },
      { ...failed, observedAt: "2026-10-08T05:00:00.000Z" },
    ]) expect(recover([legacyPartial, failed, denied]).size).toBe(0);
    expect(recover([legacyPartial], [failed]).size).toBe(0);
    expect(recover([failed], [legacyPartial]).size).toBe(0);
  });

  it("uses a later complete owned public receipt to retire the same-route tooling failure after cooldown", () => {
    const copied = { ...failed, observedAt: undefined, requestId: undefined };
    const actual = [complete, failed];
    expect([...recover(actual, [copied]).values()]).toEqual([complete]);
    expect(actual).toEqual([complete, failed]);
    expect(copied.observedAt).toBeUndefined();
    expect(complete.renderWarning).toBeUndefined();
    expect(complete.renderComplete).toBe(true);
  });

  it("uses the newest actual complete receipt before cooldown instead of an older partial one", () => {
    const recentComplete = { ...complete, observedAt: "2026-10-08T16:45:00.000Z",
      requestId: "55555555-5555-4555-8555-555555555555" };
    const copied = { ...failed, observedAt: undefined, requestId: undefined };
    expect(recover([positive, failed, recentComplete], [copied]).size).toBe(0);
    expect([...selectRecoveredSimulatorResearchRoutes({ actualRoutes: [positive, failed, recentComplete],
      inheritedRoutes: [copied], now: new Date("2026-10-08T17:45:00.000Z") }).values()]).toEqual([recentComplete]);
    expect(recover([positive, failed, { ...recentComplete, observedAt: "2026-10-08T17:01:00.000Z" }], [copied]).size).toBe(0);
  });

  it.each([
    { renderComplete: undefined }, { renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const },
    { renderWarning: "MAIN_DOCUMENT_HTTP_ERROR" as const }, { outcome: undefined },
    { requestId: undefined }, { requestId: receiptId }, { observedAt: undefined },
    { observedAt: "2026-10-08T17:01:00.000Z" }, { observedAt: failed.observedAt },
    { accessControlsObserved: undefined }, { accessControls: undefined },
    { accessControls: ["ACCOUNT_REQUIRED" as const] }, { httpStatus: 403 }, { rendered: false },
  ])("does not infer complete recovery from an incomplete or unsafe actual receipt: %j", delta => {
    expect(recover([{ ...complete, ...delta }, failed]).size).toBe(0);
  });

  it("keeps complete-read recovery fenced by later failures, protected denials, route identity and original receipts", () => {
    const copied = { ...failed, observedAt: undefined, requestId: undefined };
    const laterFailure = { ...failed, observedAt: "2026-10-08T06:00:00.000Z",
      requestId: "66666666-6666-4666-8666-666666666666" };
    expect(recover([complete, failed, laterFailure], [copied]).size).toBe(0);
    for (const denied of [
      { ...failed, httpStatus: 403, failure: undefined },
      { ...complete, accessControls: ["CAPTCHA_OR_CHALLENGE" as const] },
      { ...failed, failure: { ...failed.failure!, category: "ACCESS" as const } },
    ]) {
      expect(recover([complete, failed, denied], [copied]).size).toBe(0);
      expect(recover([complete, failed], [denied]).size).toBe(0);
    }
    expect(recover([{ ...complete, url: url.replace("/bays", "") }, failed], [copied]).size).toBe(0);
    expect(recover([{ ...complete, rendered: false }, failed], [copied]).size).toBe(0);
    expect(recover([complete], [copied]).size).toBe(0);
    expect(recover([complete, failed], [{ ...copied, failure: { ...failed.failure!, researchPhase: "BROWSER_DOCUMENT" } }]).size).toBe(0);
  });
});
