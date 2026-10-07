import { describe, expect, it } from "vitest";
import { assertSimulatorResearchFallbackBeforeRetry, getSimulatorResearchGuide, readSimulatorResearchState, selectSimulatorResearchTarget } from "./simulator-support-research-policy";

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
  it("requires the saved calendar after an unsuccessful rendered homepage while retaining provider backoff", () => {
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
  it("stops after three different public booking destinations", () => {
    const history = [1, 2, 3].map(i => ({ ...failedHomepage().history[0], source: "booking" as const, requestedUrl: `https://calendar.example.test/booking/${i}`, sourceUrl: `https://calendar.example.test/booking/${i}` }));
    expect(() => select({ ...empty(), readCount: 3, history }, { source: "booking" })).toThrow("destination budget");
  });
});
