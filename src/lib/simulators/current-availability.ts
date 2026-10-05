import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

export type SimulatorMatchProof = {
  offeringId: string | null;
  offeringSourceFingerprint?: string | null;
  availabilityStatus: string;
  startsAt: Date;
  endsAt: Date | null;
  lastConfirmedAt: Date;
  bookingUrl: string;
  capacity: number | null;
  offering?: Parameters<typeof getSimulatorOfferingSourceFingerprint>[0] & {
    id: string; kind: string; active: boolean; publicAccessStatus: string;
    automationEligibility: string; monitoringState: string;
    monitoringVerifiedAt: Date | null; lastFailureAt: Date | null;
    observationToken: string | null; bookingUrl: string | null;
    verifiedAt: Date | null; evidenceUrl: string | null;
    maxPartySize: number | null; supportedDurationsMinutes: number[];
  } | null;
};

/** Simulator proof never consults the venue's outdoor monitoring state. */
export function isCurrentSimulatorMatch(match: SimulatorMatchProof, now = new Date(), partySize = 1) {
  const offering = match.offering;
  if (!offering || offering.id !== match.offeringId || offering.kind !== "SIMULATOR" ||
    !offering.active || offering.publicAccessStatus !== "PUBLIC" || offering.automationEligibility !== "ALLOWED" ||
    offering.monitoringState !== "HEALTHY" || offering.observationToken ||
    !offering.verifiedAt || offering.verifiedAt > now || !offering.evidenceUrl ||
    !match.offeringSourceFingerprint || match.offeringSourceFingerprint !== getSimulatorOfferingSourceFingerprint(offering) ||
    !offering.monitoringVerifiedAt || !match.endsAt || !offering.maxPartySize ||
    !match.capacity || Math.min(offering.maxPartySize, match.capacity) < partySize ||
    match.availabilityStatus !== "AVAILABLE" || match.startsAt <= now ||
    match.bookingUrl !== offering.bookingUrl ||
    offering.monitoringVerifiedAt < match.lastConfirmedAt || offering.monitoringVerifiedAt > now ||
    match.lastConfirmedAt > now || now.getTime() - match.lastConfirmedAt.getTime() > 30 * 60_000 ||
    (offering.lastFailureAt && offering.lastFailureAt >= match.lastConfirmedAt)) return false;
  const duration = (match.endsAt.getTime() - match.startsAt.getTime()) / 60_000;
  return duration > 0 && offering.supportedDurationsMinutes.includes(duration);
}
