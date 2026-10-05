import { describe, expect, it } from "vitest";

import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

const source = {
  kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC",
  bookingUrl: "https://venue.example/book", evidenceUrl: "https://venue.example/rentals",
  verifiedAt: new Date("2026-10-05T10:00:00.000Z"), providerFamilyKey: "GOLFBOOK",
  providerMetadata: { tenant: "venue", resources: { second: 2, first: 1 } },
  maxPartySize: 8, supportedDurationsMinutes: [120, 60],
  bookingWindowDaysAhead: 14, bookingReleaseTimeLocal: "08:00", monitoringMode: "AUTOMATIC",
};

describe("simulator source fingerprint", () => {
  it("is stable across metadata key order and duration order", () => {
    const reordered = { ...source, providerMetadata: { resources: { first: 1, second: 2 }, tenant: "venue" },
      supportedDurationsMinutes: [60, 120] };
    expect(getSimulatorOfferingSourceFingerprint(reordered)).toBe(getSimulatorOfferingSourceFingerprint(source));
  });

  it("changes when provider configuration changes under the same booking URL", () => {
    expect(getSimulatorOfferingSourceFingerprint({ ...source, providerMetadata: { tenant: "another" } }))
      .not.toBe(getSimulatorOfferingSourceFingerprint(source));
    expect(getSimulatorOfferingSourceFingerprint({ ...source, maxPartySize: 4 }))
      .not.toBe(getSimulatorOfferingSourceFingerprint(source));
  });
});
