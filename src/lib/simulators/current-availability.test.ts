import { describe, expect, it } from "vitest";
import { isCurrentSimulatorMatch, type SimulatorMatchProof } from "./current-availability";
import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

const now = new Date("2026-10-05T14:00:00Z");
const confirmedAt = new Date("2026-10-05T13:59:00Z");
function proof(): SimulatorMatchProof {
  const match: SimulatorMatchProof = { offeringId: "sim", availabilityStatus: "AVAILABLE", startsAt: new Date("2026-10-10T22:00:00Z"), endsAt: new Date("2026-10-10T23:30:00Z"),
    lastConfirmedAt: confirmedAt, capacity: 6, bookingUrl: "https://official.example/sim", offering: {
      id: "sim", kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC", automationEligibility: "ALLOWED", monitoringState: "HEALTHY",
      monitoringVerifiedAt: confirmedAt, verifiedAt: confirmedAt, evidenceUrl: "https://official.example/sim", lastFailureAt: null, observationToken: null, bookingUrl: "https://official.example/sim", maxPartySize: 6, supportedDurationsMinutes: [60, 90, 120],
      providerFamilyKey: "TEST", providerMetadata: { locationId: "first" }, bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, monitoringMode: "AUTOMATIC"
    } };
  match.offeringSourceFingerprint = getSimulatorOfferingSourceFingerprint(match.offering!);
  return match;
}
describe("simulator match proof", () => {
  it("accepts full-session proof for a verified bay's capacity", () => { expect(isCurrentSimulatorMatch(proof(), now, 6)).toBe(true); expect(isCurrentSimulatorMatch(proof(), now, 7)).toBe(false); });
  it("rejects stale, in-flight or later-failed sources independently of outdoor health", () => {
    for (const fields of [{ observationToken: "newer-source" }, { lastFailureAt: now }, { monitoringState: "UNKNOWN" }, { bookingUrl: "https://official.example/changed" }, { active: false }, { verifiedAt: null }, { evidenceUrl: null }]) {
      const match = proof(); Object.assign(match.offering!, fields); expect(isCurrentSimulatorMatch(match, now)).toBe(false);
    }
    expect(isCurrentSimulatorMatch(proof(), new Date("2026-10-05T15:00:00Z"))).toBe(false);
  });
  it("requires a supported duration and simulator identity", () => {
    const match = proof(); match.endsAt = new Date("2026-10-10T23:15:00Z"); expect(isCurrentSimulatorMatch(match, now)).toBe(false);
    match.endsAt = new Date("2026-10-10T23:30:00Z"); match.offering!.kind = "OUTDOOR"; expect(isCurrentSimulatorMatch(match, now)).toBe(false);
  });
  it("retains one search's fresh matches after another date's successful source check", () => {
    const match = proof(); match.offering!.monitoringVerifiedAt = new Date("2026-10-05T13:59:30Z");
    expect(isCurrentSimulatorMatch(match, now, 4)).toBe(true);
  });
  it("rejects an old match after a different source is verified at the same booking URL", () => {
    const match = proof(); match.offering!.providerMetadata = { locationId: "second" };
    match.offering!.monitoringVerifiedAt = new Date("2026-10-05T13:59:30Z");
    expect(isCurrentSimulatorMatch(match, now)).toBe(false);
  });
});
