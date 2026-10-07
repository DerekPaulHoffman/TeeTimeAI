import { describe, expect, it } from "vitest";
import { assertSimulatorResearchFallbackBeforeRetry, getSimulatorResearchGuide, getSimulatorResearchRetryGuide, readSimulatorResearchState, selectSimulatorResearchTarget } from "./simulator-support-research-policy";

const fingerprint = "a".repeat(64), now = new Date("2026-10-06T20:00:00Z");
const officialUrl = "https://venue.example.test", bookingUrl = "https://calendar.example.test/booking/bays";
const empty = () => readSimulatorResearchState(undefined, fingerprint);
const select = (state = empty(), rest = {}) => selectSimulatorResearchTarget({ state, officialUrl, bookingUrl, source: "official", rendered: false, now, ...rest });
const failedHomepage = () => ({ ...empty(), readCount: 1, history: [{ source: "official" as const, requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(), httpStatus: 403, rendered: false, outcome: "READ" as const }] });

describe("owned simulator research navigation", () => {
  it("chooses only saved sources or a fresh indexed official handoff", () => {
    expect(select().url).toBe(officialUrl);
    const state = { ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 200 }], links: [bookingUrl, "https://unrelated.example.test/simulators"], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(select(state, { source: undefined, linkIndex: 1 }).url).toBe(bookingUrl);
    expect(() => select(state, { source: undefined, linkIndex: 2 })).toThrow("handoff");
    expect(() => select(state, { source: undefined, linkIndex: 0 })).toThrow();
    expect(() => select(state, { source: undefined, linkIndex: 3 })).toThrow();
    expect(() => select(state, { source: undefined, linkIndex: 1, now: new Date(now.getTime() + 31 * 60_000) })).toThrow("fresh");
  });
  it("rejects malformed audit evidence instead of resetting budgets", () => {
    expect(() => readSimulatorResearchState({}, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...empty(), readCount: 1 }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...empty(), links: ["http://localhost"] }, fingerprint)).toThrow();
    expect(readSimulatorResearchState({ source: "official", requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(), httpStatus: 403, sourceFingerprint: fingerprint }, fingerprint).readCount).toBe(1);
  });
  it("does not repeat a failed request and permits a bounded rendered fallback", () => {
    expect(() => select(failedHomepage())).toThrow("identical");
    expect(select(failedHomepage(), { rendered: true }).url).toBe(officialUrl);
    expect(() => assertSimulatorResearchFallbackBeforeRetry(failedHomepage(), bookingUrl)).toThrow("booking read");
    const distinct = { ...failedHomepage(), readCount: 2, history: [...failedHomepage().history, { ...failedHomepage().history[0], source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl }] };
    expect(() => assertSimulatorResearchFallbackBeforeRetry(distinct, bookingUrl)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...distinct, history: [...distinct.history].reverse() }, bookingUrl)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 429 }] }, bookingUrl)).not.toThrow();
  });
  it("requires the saved calendar after an unclassified legacy rendered-homepage failure while retaining capacity backoff", () => {
    const renderedFailure = { ...failedHomepage(), readCount: 2, history: [...failedHomepage().history,
      { ...failedHomepage().history[0], rendered: true, httpStatus: 0, outcome: "NETWORK_FAILED" as const }] };
    expect(() => assertSimulatorResearchFallbackBeforeRetry(renderedFailure, bookingUrl)).toThrow("failed rendered homepage");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(renderedFailure, null)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...renderedFailure, history: [...renderedFailure.history.slice(0, 1),
      { ...renderedFailure.history[1], outcome: "CAPACITY_BUSY" as const }] }, bookingUrl)).not.toThrow();
  });
  it("suggests saved booking commands first and exposes prior structural denials before another read", () => {
    const priorFailedRoutes = [{ url: officialUrl, rendered: false, httpStatus: 403 }];
    const guide = getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl, now, priorFailedRoutes });
    expect(guide).toMatchObject({ readsRemaining: 6, inFlight: false, priorBlockedRoutes: priorFailedRoutes });
    expect(guide.suggestedReads).toEqual([{ source: "booking", rendered: false }, { source: "booking", rendered: true },
      { source: "official", rendered: true }]);
    expect(getSimulatorResearchGuide({ state: { ...empty(), readCount: 6 }, officialUrl, bookingUrl, now, priorFailedRoutes }).suggestedReads).toEqual([]);
    expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl: officialUrl, now, priorFailedRoutes: [] }).suggestedReads)
      .toEqual([{ source: "booking", rendered: false }, { source: "booking", rendered: true }]);
  });
  it("keeps another fresh successful booking handoff usable after one linked destination fails", () => {
    const success = { ...failedHomepage().history[0], httpStatus: 200 };
    const other = "https://other.example.test/booking/bays";
    const failedLink = { ...success, source: "link" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl, httpStatus: 403 };
    const state = { ...empty(), readCount: 2, history: [success, failedLink], linkBaseUrl: officialUrl,
      links: [bookingUrl, other], bookingLinks: [bookingUrl, other] };
    expect(select(state, { source: undefined, linkIndex: 2 }).url).toBe(other);
    expect(() => select(state, { source: undefined, linkIndex: 1 })).toThrow("identical");
    expect(() => select(state, { source: undefined, linkIndex: 2, now: new Date(now.getTime() + 31 * 60_000) })).toThrow("fresh");
  });
  it("retains in-flight and attempt capacity rather than allowing overlapping reads", () => {
    const state = { ...empty(), readCount: 1, inFlight: { requestId: "11111111-1111-4111-8111-111111111111", startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), source: "official" as const, url: officialUrl, rendered: false } };
    expect(() => select(state)).toThrow("in flight");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(state, null)).toThrow("original");
    expect(() => select({ ...empty(), readCount: 6 })).toThrow("budget");
  });
  it("preserves a hard-failed reservation as a spent read and permits a bounded alternate route", () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const hard = readSimulatorResearchState({ ...empty(), readCount: 1, history: [{
      source: "official", requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(),
      httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId,
      failure: { stage: "PUBLIC_READ", category: "TOOLING", code: "INVALID_TOOL_DATA" },
    }] }, fingerprint);
    expect(hard.readCount).toBe(1);
    expect(select(hard, { source: "booking" }).url).toBe(bookingUrl);
    expect(() => select(hard, { rendered: true })).toThrow("identical");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(hard, bookingUrl, officialUrl)).not.toThrow();
    expect(() => readSimulatorResearchState({ ...hard, history: [{ ...hard.history[0], failure: { stage: "PUBLIC_READ", category: "TOOLING", code: "RAW_URL", sourceLocation: "https://secret.example.test" } }] }, fingerprint)).toThrow();
  });
  it("allows incomplete retry after all six reads are spent, while an ordinary failed homepage still requires its saved booking route", () => {
    const failed = failedHomepage();
    expect(() => assertSimulatorResearchFallbackBeforeRetry(failed, bookingUrl, officialUrl)).toThrow("booking read");
    const exhausted = readSimulatorResearchState({ ...failed, readCount: 6,
      history: Array.from({ length: 6 }, (_, index) => ({ ...failed.history[0], observedAt: new Date(now.getTime() + index).toISOString() })),
    }, fingerprint);
    expect(getSimulatorResearchGuide({ state: exhausted, officialUrl, bookingUrl, now, priorFailedRoutes: [] }).suggestedReads).toEqual([]);
    expect(() => assertSimulatorResearchFallbackBeforeRetry(exhausted, bookingUrl, officialUrl)).not.toThrow();
    expect(() => select(exhausted, { source: "booking" })).toThrow("budget");
  });
  it("stops after three different public booking destinations", () => {
    const history = [1, 2, 3].map(i => ({ ...failedHomepage().history[0], source: "booking" as const, requestedUrl: `https://calendar.example.test/booking/${i}`, sourceUrl: `https://calendar.example.test/booking/${i}` }));
    expect(() => select({ ...empty(), readCount: 3, history }, { source: "booking" })).toThrow("destination budget");
  });
});

const retryGuide = (state = empty(), rest = {}) => getSimulatorResearchRetryGuide({ state, officialUrl, bookingUrl, now, priorFailedRoutes: [], ...rest });
const successfulHomepage = () => ({ ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 200 }] });
const requestId = "11111111-1111-4111-8111-111111111111";

describe("calendar research required before incomplete simulator retry", () => {
  it("requires an offered saved calendar even after a successful homepage", () => {
    const state = successfulHomepage();
    expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking", rendered: false },
      skipHomepageFallback: false, closeoutReason: null });
    expect(state.readCount).toBe(1);
    expect(state.history).toHaveLength(1);
  });

  it("prioritizes the current booking role over earlier generic page links", () => {
    const state = { ...successfulHomepage(), links: [`${officialUrl}/about`, bookingUrl], bookingLinks: [bookingUrl],
      bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }], linkBaseUrl: officialUrl };
    const guide = getSimulatorResearchGuide({ state, officialUrl, bookingUrl: null, now, priorFailedRoutes: [] });
    expect(guide.suggestedReads.slice(0, 4)).toEqual([
      { linkIndex: 2, rendered: false }, { linkIndex: 2, rendered: true },
      { linkIndex: 1, rendered: false }, { linkIndex: 1, rendered: true },
    ]);
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: true,
      nextEligibleBookingRead: { linkIndex: 2, rendered: false } });
  });

  it("does not count an old recovered hard-failed calendar render as its untried plain read", () => {
    const history = [{ ...failedHomepage().history[0], source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      httpStatus: 0, rendered: true, outcome: "HARD_FAILED" as const, requestId,
      failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "RESEARCH_RESERVATION_INTERRUPTED" } }];
    const state = readSimulatorResearchState({ ...empty(), readCount: 1, history, lastRecoveredFailureRequestId: requestId }, fingerprint);
    expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking", rendered: false } });
    expect(() => select(state, { source: "booking", rendered: true })).toThrow("identical");
    expect(retryGuide({ ...state, lastRecoveredFailureRequestId: undefined })).toMatchObject({ bookingResearchRequired: false,
      skipHomepageFallback: true, closeoutReason: "HARD_FAILURE" });
  });

  it("never demands a saved URL and mode denied by the current prior-route evidence", () => {
    const priorFailedRoutes = [false, true].map(rendered => ({ url: bookingUrl, rendered, httpStatus: 403 }));
    expect(retryGuide(successfulHomepage(), { priorFailedRoutes })).toMatchObject({ bookingResearchRequired: false,
      nextEligibleBookingRead: null, skipHomepageFallback: true, closeoutReason: "NO_ELIGIBLE_BOOKING_ROUTES" });
    const plainDenied = retryGuide(successfulHomepage(), { priorFailedRoutes: priorFailedRoutes.slice(0, 1) });
    expect(plainDenied.nextEligibleBookingRead).toEqual({ source: "booking", rendered: true });
  });

  it("keeps recognized network, provider capacity, HTTP429 and current 5xx as explicit backoff", () => {
    const base = successfulHomepage().history[0];
    const network = { ...base, httpStatus: 0, outcome: "NETWORK_FAILED" as const, requestId,
      failure: { stage: "PUBLIC_READ" as const, category: "NETWORK" as const, code: "PUBLIC_FETCH_FAILED" } };
    for (const latest of [network, { ...base, httpStatus: 0, outcome: "CAPACITY_BUSY" as const },
      { ...base, httpStatus: 429 }, { ...base, httpStatus: 503 }]) {
      const state = readSimulatorResearchState({ ...empty(), readCount: 1, history: [latest] }, fingerprint);
      expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: false, skipHomepageFallback: true, closeoutReason: "PROVIDER_BACKOFF" });
    }
    // The old generic NETWORK_FAILED marker cannot invent a fresh known cause.
    expect(retryGuide({ ...empty(), readCount: 1, history: [{ ...base, httpStatus: 0, outcome: "NETWORK_FAILED" }] }))
      .toMatchObject({ bookingResearchRequired: true });
  });

  it("does not extend booking-role evidence when a newer generic page keeps its URL", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl,
      bookingLinkRoles: [{ url: bookingUrl, observedAt: new Date(now.getTime() - 31 * 60_000).toISOString() }] };
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: false, nextEligibleBookingRead: null });
    expect(getSimulatorResearchGuide({ state, officialUrl, bookingUrl: null, now, priorFailedRoutes: [] }).suggestedReads)
      .not.toContainEqual({ linkIndex: 1, rendered: false });
    const future = { ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: new Date(now.getTime() + 1).toISOString() }] };
    expect(retryGuide(future, { bookingUrl: null }).bookingResearchRequired).toBe(false);
    const current = { ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }] };
    expect(retryGuide(current, { bookingUrl: null }).bookingResearchRequired).toBe(true);
  });

  it("preserves legacy-role freshness only until its last successful source receipt expires", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(retryGuide(state, { bookingUrl: null }).bookingResearchRequired).toBe(true);
    expect(retryGuide(state, { bookingUrl: null, now: new Date(now.getTime() + 31 * 60_000) }).bookingResearchRequired).toBe(false);
    expect(retryGuide({ ...state, bookingLinkRoles: [] }, { bookingUrl: null }).bookingResearchRequired).toBe(false);
  });

  it("retains hard in-flight ownership and finite read limits", () => {
    const state = { ...empty(), readCount: 1, inFlight: { requestId, startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), source: "booking" as const, url: bookingUrl, rendered: false } };
    expect(() => retryGuide(state)).toThrow("original source research");
    const exhausted = { ...successfulHomepage(), readCount: 6,
      history: Array.from({ length: 6 }, () => successfulHomepage().history[0]) };
    expect(retryGuide(exhausted)).toMatchObject({ bookingResearchRequired: false, skipHomepageFallback: true, closeoutReason: "READ_BUDGET_EXHAUSTED" });
  });

  it("requires no guessed calendar when the only offered links are ordinary venue pages", () => {
    const state = { ...successfulHomepage(), links: [`${officialUrl}/about`], bookingLinks: [], bookingLinkRoles: [], linkBaseUrl: officialUrl };
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: false, nextEligibleBookingRead: null });
  });

  it("validates bounded unique role provenance against current discovered booking links", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(readSimulatorResearchState({ ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }] }, fingerprint).bookingLinkRoles)
      .toEqual([{ url: bookingUrl, observedAt: now.toISOString() }]);
    expect(() => readSimulatorResearchState({ ...state, bookingLinkRoles: [{ url: `${officialUrl}/about`, observedAt: now.toISOString() }] }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...state, bookingLinkRoles: Array.from({ length: 2 }, () => ({ url: bookingUrl, observedAt: now.toISOString() })) }, fingerprint)).toThrow();
  });
});
