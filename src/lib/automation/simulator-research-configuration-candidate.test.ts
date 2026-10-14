import { describe, expect, it } from "vitest";
import { buildSimulatorResearchConfigurationCandidate } from "./simulator-research-configuration-candidate";
import { readSimulatorResearchState } from "./simulator-support-research-policy";

const sourceFingerprint = "a".repeat(64);
const now = new Date("2026-10-14T15:00:00.000Z");
const sourceUrl = "https://app.acuityscheduling.com/schedule/a66e63ac";
function fixture(durations = [120, 90]) {
  const publicConfiguration = { family: "ACUITY", ownerKey: "a66e63ac", businessId: "34536426", timeZone: "UTC", maxPartySize: null,
    rentals: durations.map((durationMinutes, index) => ({ id: String(73234482 + index), durationMinutes, calendarIds: ["11388341"],
      ...(durationMinutes >= 60 ? { calendarKind: "OPAQUE_AGGREGATE", aggregateRentalIdentity: "DURATION_LABELLED_SIM_RENTAL" } : {}) })),
    resources: [{ id: "11388341", timeZone: "UTC" }] };
  const research = readSimulatorResearchState({ version: 1, sourceFingerprint, readCount: 1, history: [{ source: "booking",
    requestedUrl: sourceUrl, sourceUrl, sourceFingerprint, requestId: "11111111-1111-4111-8111-111111111111",
    observedAt: now.toISOString(), httpStatus: 200, rendered: false, outcome: "READ", publicConfiguration,
    publicReadEvidence: { sourceFingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP" } }],
    links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null }, sourceFingerprint);
  return { course: { googlePlaceId: "fixture-place", name: "Fixture", address: "1 Test Street", latitude: 41, longitude: -73,
    website: "https://official.example.test/" }, research, sourceFingerprint, offeringRevision: 7,
    claimedAt: new Date(now.getTime() - 60_000).toISOString(), now };
}

describe("owned Acuity configuration candidates", () => {
  it("retains exact supported durations and source identity without inventing an hour or capacity", () => {
    expect(buildSimulatorResearchConfigurationCandidate(fixture())).toMatchObject({ expectedFingerprint: sourceFingerprint,
      expectedOfferingRevision: 7, manifest: { bookingUrl: sourceUrl, evidenceUrl: sourceUrl, verifiedAt: now.toISOString(),
        providerFamilyKey: "ACUITY", supportedDurationsMinutes: [90, 120], maxPartySize: null,
        providerMetadata: { ownerKey: "a66e63ac", rentalProductIds: ["73234482", "73234483"] } } });
  });
  it("keeps an actual public one-hour product when present", () => {
    expect(buildSimulatorResearchConfigurationCandidate(fixture([60]))?.manifest.supportedDurationsMinutes).toEqual([60]);
  });
  it("does not configure an unsupported shorter-only catalog", () => {
    expect(buildSimulatorResearchConfigurationCandidate(fixture([30]))).toBeUndefined();
  });
  it("requires the latest rendered observation to be complete", () => {
    const input = fixture(), entry = input.research.history[0];
    entry.rendered = true;
    entry.publicReadEvidence = { ...entry.publicReadEvidence!, method: "BROWSER", renderComplete: false };
    expect(buildSimulatorResearchConfigurationCandidate(input)).toBeUndefined();
  });
  it("does not replace a newer failure with older valid facts", () => {
    const input = fixture(), entry = input.research.history[0];
    input.research.readCount = 2;
    input.research.history.push({ ...entry, requestId: "22222222-2222-4222-8222-222222222222", httpStatus: 503, publicConfiguration: undefined });
    expect(buildSimulatorResearchConfigurationCandidate(input)).toBeUndefined();
  });
  it("rejects stale, pre-claim, foreign-source and foreign-tenant facts", () => {
    for (const mode of ["stale", "pre-claim", "fingerprint", "tenant"] as const) {
      const input = fixture();
      if (mode === "stale") input.now = new Date(now.getTime() + 31 * 60_000);
      if (mode === "pre-claim") input.claimedAt = new Date(now.getTime() + 1).toISOString();
      if (mode === "fingerprint") input.sourceFingerprint = "b".repeat(64);
      if (mode === "tenant") input.research.history[0].sourceUrl = "https://app.acuityscheduling.com/schedule/other123";
      expect(buildSimulatorResearchConfigurationCandidate(input)).toBeUndefined();
    }
  });
});
