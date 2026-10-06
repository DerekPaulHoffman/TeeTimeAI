import { describe, expect, it } from "vitest";
import { assertSimulatorResearchFallbackBeforeRetry, readSimulatorResearchState, selectSimulatorResearchTarget } from "./simulator-support-research-policy";

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
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...distinct, history: [...distinct.history].reverse() }, bookingUrl)).toThrow("booking read");
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 429 }] }, bookingUrl)).not.toThrow();
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
