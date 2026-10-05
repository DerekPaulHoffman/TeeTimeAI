import { createHash } from "node:crypto";

type SimulatorSourceFacts = {
  kind: string;
  active: boolean;
  publicAccessStatus: string;
  bookingUrl: string | null;
  evidenceUrl: string | null;
  verifiedAt: Date | null;
  providerFamilyKey: string | null;
  providerMetadata: unknown;
  maxPartySize: number | null;
  supportedDurationsMinutes: number[];
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  monitoringMode: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getSimulatorOfferingSourceFingerprint(offering: SimulatorSourceFacts) {
  return createHash("sha256").update(canonical({
    kind: offering.kind,
    active: offering.active,
    publicAccessStatus: offering.publicAccessStatus,
    bookingUrl: offering.bookingUrl,
    evidenceUrl: offering.evidenceUrl,
    verifiedAt: offering.verifiedAt?.toISOString() ?? null,
    providerFamilyKey: offering.providerFamilyKey,
    providerMetadata: offering.providerMetadata,
    maxPartySize: offering.maxPartySize,
    supportedDurationsMinutes: [...offering.supportedDurationsMinutes].sort((a, b) => a - b),
    bookingWindowDaysAhead: offering.bookingWindowDaysAhead,
    bookingReleaseTimeLocal: offering.bookingReleaseTimeLocal,
    monitoringMode: offering.monitoringMode,
  })).digest("hex");
}
