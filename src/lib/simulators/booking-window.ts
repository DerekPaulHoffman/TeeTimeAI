import type { CourseSetupReceipt } from "@prisma/client";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";
import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

export function getSimulatorBookingOpening(date: string, offering: {
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  verifiedAt: Date | null;
  evidenceUrl: string | null;
}, timeZone: string): Date | null {
  if (!offering.verifiedAt || !offering.evidenceUrl || offering.bookingWindowDaysAhead === null ||
    offering.bookingWindowDaysAhead < 0 || !Number.isInteger(offering.bookingWindowDaysAhead)) return null;
  const releaseTime = offering.bookingReleaseTimeLocal ?? "00:00";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(releaseTime)) return null;
  const openingDate = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(openingDate.getTime())) return null;
  openingDate.setUTCDate(openingDate.getUTCDate() - offering.bookingWindowDaysAhead);
  if (!Number.isFinite(openingDate.getTime())) return null;
  const opening = parseCourseLocalDateTime(`${openingDate.toISOString().slice(0, 10)}T${releaseTime}`, timeZone);
  return Number.isFinite(opening.getTime()) ? opening : null;
}

/** Read the saved opening only while its exact public source and venue clock still apply. */
export function readSavedSimulatorBookingOpening(input: {
  receipt: Pick<CourseSetupReceipt, "outcome" | "legacy" | "startedAt" | "closedAt" | "evidenceProbeId" | "evidenceObservedAt" | "request">;
  offering: Parameters<typeof getSimulatorOfferingSourceFingerprint>[0];
  targetDate: string;
  timeZone: string;
}) {
  const { receipt, offering, targetDate, timeZone } = input;
  const evidenceUrl = getSafeCustomerBookingUrl(offering.evidenceUrl);
  if (receipt.legacy || receipt.outcome !== "BOOKING_NOT_OPEN" || receipt.evidenceProbeId !== null ||
      receipt.closedAt?.getTime() !== receipt.startedAt.getTime() || offering.kind !== "SIMULATOR" ||
      !offering.active || offering.publicAccessStatus !== "PUBLIC" || !offering.verifiedAt ||
      offering.verifiedAt > receipt.startedAt || receipt.evidenceObservedAt?.getTime() !== offering.verifiedAt.getTime() ||
      !evidenceUrl || !getSafeCustomerBookingUrl(offering.bookingUrl)) return undefined;

  const request = receipt.request;
  if (!request || typeof request !== "object" || Array.isArray(request) || request.mode !== "SIMULATOR" ||
      request.targetDate !== targetDate || request.timeZone !== timeZone) return undefined;
  const facts = request.factsAtSave;
  if (!facts || typeof facts !== "object" || Array.isArray(facts) || facts.kind !== "VERIFIED_SIMULATOR_BOOKING_WINDOW" ||
      facts.evidenceUrl !== evidenceUrl || facts.sourceFingerprint !== getSimulatorOfferingSourceFingerprint(offering)) return undefined;

  const opensAt = getSimulatorBookingOpening(targetDate, offering, timeZone);
  return opensAt && opensAt > receipt.startedAt && facts.opensAt === opensAt.toISOString() ? opensAt : undefined;
}
