import { describe, expect, it } from "vitest";
import {
  getSimulatorResearchGuide, isProtectedSimulatorResearchDenial,
  readSimulatorResearchFailureMemory, readSimulatorResearchState, selectSimulatorResearchTarget,
} from "./simulator-support-research-policy";

const fingerprint = "a".repeat(64);
const now = new Date("2026-10-29T16:42:25.777Z");
const bookingUrl = "https://calendar.example.test/booking";
const diagnostics = [{ state: "NOT_EXECUTED", resourceKind: "FETCH", method: "POST", reason: "METHOD_NOT_ALLOWED",
  originRelation: "OTHER_ORIGIN", pathShape: "/:value/:value", count: 2 }];
const receipt = (httpStatus: number) => ({ source: "booking", requestedUrl: bookingUrl, sourceUrl: bookingUrl,
  requestId: "11111111-1111-4111-8111-111111111111", sourceFingerprint: fingerprint,
  observedAt: now.toISOString(), collectorObservedAt: new Date(now.getTime() - 1000).toISOString(),
  httpStatus, rendered: true, outcome: "READ", renderWarning: "SECONDARY_REQUESTS_BLOCKED",
  publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true, accessControls: [], method: "BROWSER", renderComplete: false },
  blockedResourceDiagnostics: diagnostics });
const state = (entry: unknown) => ({ ...readSimulatorResearchState(undefined, fingerprint), readCount: 1, history: [entry] });

describe("failed rendered receipts retained by older responder writers", () => {
  it.each([301, 403, 429, 503])("keeps %i diagnostics as failure metadata without granting a successful page", httpStatus => {
    const entry = receipt(httpStatus), original = state(entry);
    const parsed = readSimulatorResearchState(original, fingerprint);
    expect(parsed.readCount).toBe(1);
    expect(parsed.history).toHaveLength(1);
    const { blockedResourceDiagnostics: retainedDiagnostics, ...receiptFields } = entry;
    expect(parsed.history[0]).toMatchObject({ ...receiptFields,
      failedReadDiagnostics: { blockedResourceDiagnostics: diagnostics } });
    expect(retainedDiagnostics).toEqual(diagnostics);
    expect(parsed.history[0].blockedResourceDiagnostics).toBeUndefined();
    expect(original.history[0]).toEqual(entry);
    const guide = getSimulatorResearchGuide({ state: parsed, officialUrl: "https://venue.example.test", bookingUrl, now, priorFailedRoutes: [] });
    expect(guide.blockedResourceDiagnostics).toEqual([]);
    expect(() => selectSimulatorResearchTarget({ state: parsed, officialUrl: "https://venue.example.test", bookingUrl,
      source: "booking", rendered: true, now })).toThrow();
    const inherited = readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes: [{
      url: bookingUrl, rendered: true, httpStatus, observedAt: now.toISOString(), requestId: entry.requestId,
      outcome: "READ", accessControlsObserved: true, accessControls: [], blockedResourceDiagnostics: diagnostics,
    }] })!;
    expect(inherited.routes[0].failedReadDiagnostics).toEqual({ blockedResourceDiagnostics: diagnostics });
    if (httpStatus === 403) expect(isProtectedSimulatorResearchDenial(inherited.routes[0])).toBe(true);
  });

  it("preserves the complete spent budget and rejects malformed private diagnostics", () => {
    const entry = receipt(301);
    const history = Array.from({ length: 6 }, (_, index) => ({ ...entry, observedAt: new Date(now.getTime() - index * 1000).toISOString() }));
    const parsed = readSimulatorResearchState({ ...state(entry), readCount: 6, history }, fingerprint);
    expect(parsed.readCount).toBe(6);
    expect(parsed.history.map(row => row.observedAt)).toEqual(history.map(row => row.observedAt));
    expect(() => selectSimulatorResearchTarget({ state: parsed, officialUrl: "https://venue.example.test", bookingUrl,
      source: "official", rendered: false, now })).toThrow("budget");
    for (const invalid of [
      { ...entry, blockedResourceDiagnostics: [{ ...diagnostics[0], url: "https://private.example.test/?token=secret" }] },
      { ...entry, publicReadEvidence: undefined },
      { ...entry, publicReadEvidence: { ...entry.publicReadEvidence, accessControls: ["ACCOUNT_REQUIRED"] } },
      { ...entry, rendered: false }, { ...entry, readAuthority: "invented" },
    ]) expect(() => readSimulatorResearchState(state(invalid), fingerprint)).toThrow();
  });

  it("removes challenge credentials while keeping official public URL selectors and denial status", () => {
    const sourceUrl = "https://calendar.example.test/classic/ws?studioid=1234&stype=-9&__cf_chl_rt_tk=private-challenge";
    const parsed = readSimulatorResearchState(state({ ...receipt(403), sourceUrl }), fingerprint);
    expect(parsed.history[0].sourceUrl).toBe("https://calendar.example.test/classic/ws?studioid=1234&stype=-9");
    expect(parsed.history[0].httpStatus).toBe(403);
    expect(JSON.stringify(parsed)).not.toContain("private-challenge");
    expect(readSimulatorResearchState(parsed, fingerprint)).toEqual(parsed);
  });
});
