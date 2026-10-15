import { describe, expect, it } from "vitest";
import { assertSimulatorInteractiveFallback, getSimulatorResearchGuide, getSimulatorResearchRetryGuide,
  needsSimulatorInteractiveFallback, readSimulatorResearchState } from "./simulator-support-research-policy";
import { classifySimulatorSupportFailure, readSafeSimulatorSupportFailure } from "./simulator-support-failure";

const now = new Date("2026-10-15T16:00:00Z");
const fingerprint = "a".repeat(64);
const bookingUrl = "https://calendar.example.test/public";
const officialUrl = "https://venue.example.test/";
function incomplete() {
  return readSimulatorResearchState({
    ...readSimulatorResearchState(undefined, fingerprint), readCount: 1,
    history: [{ source: "booking", requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      sourceFingerprint: fingerprint, observedAt: now.toISOString(), httpStatus: 200,
      rendered: false, outcome: "READ", requestId: "11111111-1111-4111-8111-111111111111",
      publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP" } }],
  }, fingerprint);
}
const input = (state = incomplete()) => ({ state, bookingUrl, officialUrl, now, priorFailedRoutes: [] });

describe("interactive fallback after the first incomplete fast calendar read", () => {
  it("keeps the first read fast", () => {
    const guide = getSimulatorResearchGuide(input(readSimulatorResearchState(undefined, fingerprint)));
    expect(guide.browserFallbackRequired).toBe(false);
    expect(guide.requiredTool).toBeUndefined();
    expect(guide.suggestedReads[0]).toEqual({ source: "booking", rendered: false });
  });

  it("immediately requires a real browser instead of another passive read or retry", () => {
    const state = incomplete(), copy = structuredClone(state);
    const guide = getSimulatorResearchGuide(input(state));
    expect(guide.browserFallbackRequired).toBe(true);
    expect(guide.requiredTool).toBe("course_research_browser");
    expect(guide.suggestedReads[0]).toEqual({ source: "booking", rendered: true });
    expect(guide.suggestedReads.every(route => route.rendered)).toBe(true);
    expect(getSimulatorResearchRetryGuide(input(state))).toMatchObject({
      bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking", rendered: true },
      researchMode: "INTERACTIVE_BROWSER", closeoutReason: null,
    });
    expect(() => assertSimulatorInteractiveFallback(guide, false)).toThrow("interactive browser");
    expect(() => assertSimulatorInteractiveFallback(guide, true)).not.toThrow();
    expect(state).toEqual(copy);
  });

  it("preserves a fresh discovered booking link's fast first read", () => {
    const state = incomplete();
    state.history[0] = { ...state.history[0], source: "official", requestedUrl: officialUrl, sourceUrl: officialUrl };
    state.links = [bookingUrl]; state.bookingLinks = [bookingUrl]; state.linkBaseUrl = officialUrl;
    state.bookingLinkRoles = [{ url: bookingUrl, observedAt: now.toISOString() }];
    expect(needsSimulatorInteractiveFallback(input(state))).toBe(false);
    expect(getSimulatorResearchGuide(input(state)).suggestedReads[0]).toEqual({ source: "booking", rendered: false });
    // The previous homepage's link is not a successful result of a later blank calendar read.
    state.history.push(incomplete().history[0]); state.readCount++;
    expect(needsSimulatorInteractiveFallback(input(state))).toBe(true);
  });

  it("keeps usable public configuration on the fast path, including empty calendars", () => {
    const state = incomplete();
    state.history[0].publicConfiguration = { family: "ACUITY", ownerKey: "abcd", businessId: "1234",
      timeZone: "America/New_York", maxPartySize: null,
      rentals: [{ id: "12", durationMinutes: 60, calendarIds: ["34"] }],
      resources: [{ id: "34", timeZone: "America/New_York" }] };
    expect(needsSimulatorInteractiveFallback(input(state))).toBe(false);
    expect(getSimulatorResearchGuide(input(state)).browserFallbackRequired).toBe(false);
  });

  it("tries the browser once after a trusted fast transport failure, then retains backoff", () => {
    const state = incomplete(), row = state.history[0];
    row.outcome = "NETWORK_FAILED"; row.httpStatus = 0;
    row.failure = { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" };
    delete row.publicReadEvidence;
    expect(getSimulatorResearchRetryGuide(input(state))).toMatchObject({
      researchMode: "INTERACTIVE_BROWSER", nextEligibleBookingRead: { source: "booking", rendered: true },
    });
    row.rendered = true;
    expect(getSimulatorResearchRetryGuide(input(state))).toMatchObject({
      bookingResearchRequired: false, closeoutReason: "PROVIDER_BACKOFF",
    });
  });

  it.each([400, 403, 404])("uses a permitted browser route after fast HTTP %s without observed access controls", status => {
    const state = incomplete(); state.history[0].httpStatus = status;
    expect(getSimulatorResearchRetryGuide(input(state))).toMatchObject({
      researchMode: "INTERACTIVE_BROWSER", nextEligibleBookingRead: { source: "booking", rendered: true },
    });
    // A subsequent browser denial is spent; this never retries that route.
    state.history.push({ ...state.history[0], rendered: true,
      publicReadEvidence: { ...state.history[0].publicReadEvidence!, method: "BROWSER" } });
    state.readCount++;
    expect(getSimulatorResearchGuide(input(state)).suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
  });

  it.each(["rendered", "access", "access-unknown", "wrong-source", "missing-request", "old", "future", "exhausted", "capacity", "rate-limit", "server", "companion-rate-limit", "companion-server", "hard-failure"])(
    "does not invent browser authority for %s", reason => {
      const state = incomplete(), row = state.history[0];
      if (reason === "rendered") { row.rendered = true; row.publicReadEvidence!.method = "BROWSER"; }
      if (reason === "access") row.publicReadEvidence!.accessControls = ["ACCOUNT_REQUIRED"];
      if (reason === "access-unknown") row.publicReadEvidence!.accessControlsObserved = false;
      if (reason === "wrong-source") row.sourceFingerprint = "b".repeat(64);
      if (reason === "missing-request") delete row.requestId;
      if (reason === "old") row.observedAt = new Date(now.getTime() - 31 * 60_000).toISOString();
      if (reason === "future") row.observedAt = new Date(now.getTime() + 1).toISOString();
      if (reason === "exhausted") state.readCount = 6;
      if (reason === "capacity") row.outcome = "CAPACITY_BUSY";
      if (reason === "rate-limit") row.httpStatus = 429;
      if (reason === "server") row.httpStatus = 503;
      if (reason === "companion-rate-limit" || reason === "companion-server") row.configurationDiagnostic = {
        phase: "CONFIG", reason: "PUBLIC_PROVIDER_HTTP_ERROR", httpStatus: reason === "companion-rate-limit" ? 429 : 503,
      };
      if (reason === "hard-failure") row.outcome = "HARD_FAILED";
      expect(needsSimulatorInteractiveFallback(input(state))).toBe(false);
    });

  it("keeps denied rendered destinations denied rather than bypassing source fences", () => {
    const denied = [bookingUrl, officialUrl].map(url => ({ url, rendered: true, httpStatus: 403 }));
    const guide = getSimulatorResearchGuide({ ...input(), priorFailedRoutes: denied });
    expect(guide.browserFallbackRequired).toBe(false);
    expect(guide.suggestedReads.every(route => !route.rendered)).toBe(true);
  });

  it("returns a safe actionable failure when a worker skips the required tool", () => {
    let failure: unknown;
    try { assertSimulatorInteractiveFallback({ browserFallbackRequired: true }, false); } catch (error) { failure = error; }
    const classified = classifySimulatorSupportFailure(failure);
    expect(classified).toMatchObject({ category: "SOURCE", code: "INTERACTIVE_BROWSER_REQUIRED", stage: "TARGET_SELECTION" });
    expect(readSafeSimulatorSupportFailure(classified)).toEqual(classified);
  });
});
