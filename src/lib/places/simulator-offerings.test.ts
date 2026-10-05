import { describe, expect, it } from "vitest";
import { buildSimulatorOfferingIndex, getPersistedSimulatorCandidates, mapSimulatorCandidate, type SimulatorOfferingRecord } from "./simulator-offerings";

export function rental(overrides: Partial<SimulatorOfferingRecord> = {}): SimulatorOfferingRecord {
  return {
    id: "rental-1", courseId: "venue-1", active: true, publicAccessStatus: "PUBLIC",
    bookingUrl: "https://booking.example/simulator", evidenceUrl: "https://venue.example/indoor-golf",
    verifiedAt: new Date("2026-10-05T12:00:00Z"), updatedAt: new Date("2026-10-05T12:00:00Z"),
    maxPartySize: 6, supportedDurationsMinutes: [60, 90, 120], automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN",
    course: { id: "venue-1", googlePlaceId: "place-1", name: "Example Golf Center", address: "10 Main St",
      latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", website: "https://venue.example", phone: null },
    ...overrides
  };
}

describe("simulator offering discovery evidence", () => {
  it("uses reviewed rental identity while stripping every outdoor capability", () => {
    const index = buildSimulatorOfferingIndex([rental()]);
    const candidate = mapSimulatorCandidate({
      googlePlaceId: "place-1", name: "Example Golf Center", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York",
      website: "https://outdoor.example/tee-times", courseId: "outdoor-1", publicAccessStatus: "PUBLIC",
      monitoringSupport: "AUTOMATIC", monitoringReadiness: "READY", profileUrl: "/courses/outdoor",
      layoutHoleCounts: [18], par: 72, bookableHoleCounts: [18]
    }, index);
    expect(candidate).toMatchObject({ mode: "SIMULATOR", offeringId: "rental-1", website: "https://booking.example/simulator",
      publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60, 90, 120], maxPartySize: 6, monitoringReadiness: "VERIFYING" });
    expect(candidate).not.toHaveProperty("layoutHoleCounts");
    expect(candidate).not.toHaveProperty("bookableHoleCounts");
    expect(candidate).not.toHaveProperty("par");
    expect(candidate).not.toHaveProperty("profileUrl");
  });

  it("never promotes an unverified rental using outdoor readiness", () => {
    const index = buildSimulatorOfferingIndex([rental({ verifiedAt: null })]);
    expect(getPersistedSimulatorCandidates(index)).toEqual([]);
    expect(mapSimulatorCandidate({ googlePlaceId: "place-1", name: "Venue", latitude: 0, longitude: 0, timeZone: "UTC",
      monitoringSupport: "AUTOMATIC", monitoringReadiness: "READY" }, index)).toMatchObject({
        publicAccessStatus: "UNVERIFIED", monitoringSupport: "UNCONFIRMED", monitoringReadiness: "VERIFYING"
      });
  });

  it("includes inactive changes in the version but never uses them for fallback", () => {
    const active = rental();
    const inactive = rental({ active: false, updatedAt: new Date("2026-10-06T12:00:00Z") });
    expect(buildSimulatorOfferingIndex([inactive]).reviewVersion).not.toBe(buildSimulatorOfferingIndex([active]).reviewVersion);
    expect(getPersistedSimulatorCandidates(buildSimulatorOfferingIndex([inactive]))).toEqual([]);
  });

  it("does not invalidate Places discovery for a monitoring heartbeat", () => {
    const before = rental();
    const heartbeat = rental({ updatedAt: new Date(Date.now()), monitoringState: "HEALTHY", monitoringVerifiedAt: new Date() });
    expect(buildSimulatorOfferingIndex([heartbeat]).reviewVersion).toBe(buildSimulatorOfferingIndex([before]).reviewVersion);
    expect(buildSimulatorOfferingIndex([{ ...heartbeat, maxPartySize: 8 }]).reviewVersion).not.toBe(buildSimulatorOfferingIndex([before]).reviewVersion);
  });

  it("requires fresh offering-specific success before showing ready", () => {
    const index = buildSimulatorOfferingIndex([rental({ automationEligibility: "ALLOWED", monitoringState: "HEALTHY",
      monitoringVerifiedAt: new Date() })]);
    expect(getPersistedSimulatorCandidates(index)[0].monitoringReadiness).toBe("READY");
    const stale = buildSimulatorOfferingIndex([rental({ automationEligibility: "ALLOWED", monitoringState: "HEALTHY",
      monitoringVerifiedAt: new Date(Date.now() - 31 * 60_000) })]);
    expect(getPersistedSimulatorCandidates(stale)[0].monitoringReadiness).toBe("VERIFYING");
  });

  it("withholds readiness while a new observation is running or a later failure supersedes success", () => {
    const verifiedAt = new Date(Date.now() - 1_000);
    const success = rental({ automationEligibility: "ALLOWED", monitoringState: "HEALTHY", monitoringVerifiedAt: verifiedAt });
    for (const override of [
      { observationToken: "active-observation" },
      { lastFailureAt: verifiedAt },
      { lastFailureAt: new Date() },
    ]) {
      expect(getPersistedSimulatorCandidates(buildSimulatorOfferingIndex([{ ...success, ...override }]))[0].monitoringReadiness).toBe("VERIFYING");
    }
    expect(getPersistedSimulatorCandidates(buildSimulatorOfferingIndex([{ ...success, observationToken: null,
      lastFailureAt: new Date(verifiedAt.getTime() - 1_000) }]))[0].monitoringReadiness).toBe("READY");
  });
});
