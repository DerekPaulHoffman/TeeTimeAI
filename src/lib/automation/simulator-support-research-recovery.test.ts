import { describe, expect, it } from "vitest";
import type { SimulatorResearchBlockedRoute } from "./simulator-support-research-policy";
import { selectRecoveredSimulatorResearchRoutes } from "./simulator-support-research-recovery";

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
const recover = (actualRoutes: SimulatorResearchBlockedRoute[], inheritedRoutes: SimulatorResearchBlockedRoute[] = []) =>
  selectRecoveredSimulatorResearchRoutes({ actualRoutes, inheritedRoutes, now });

describe("later owned public research recovery", () => {
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
    { renderComplete: true }, { renderComplete: undefined }, { renderWarning: undefined }, { outcome: undefined },
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

  it("uses the newest actual partial observation before evaluating cooldown, even when copied memory is older", () => {
    const recent = { ...positive, observedAt: "2026-10-08T16:45:00.000Z", requestId: "33333333-3333-4333-8333-333333333333" };
    expect(recover([positive, failed, recent], [positive]).size).toBe(0);
    expect([...selectRecoveredSimulatorResearchRoutes({ actualRoutes: [positive, failed, recent],
      inheritedRoutes: [positive], now: new Date("2026-10-08T17:45:00.000Z") }).values()]).toEqual([recent]);
    expect(recover([positive, failed, { ...recent, observedAt: "2026-10-08T17:01:00.000Z" }], [positive]).size).toBe(0);
  });
});
