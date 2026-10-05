import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";

export function getSimulatorBookingOpening(date: string, offering: {
  bookingWindowDaysAhead: number | null;
  bookingReleaseTimeLocal: string | null;
  verifiedAt: Date | null;
  evidenceUrl: string | null;
}, timeZone: string): Date | null {
  if (!offering.verifiedAt || !offering.evidenceUrl || offering.bookingWindowDaysAhead === null ||
    offering.bookingWindowDaysAhead < 0 || !Number.isInteger(offering.bookingWindowDaysAhead)) return null;
  const openingDate = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(openingDate.getTime())) return null;
  openingDate.setUTCDate(openingDate.getUTCDate() - offering.bookingWindowDaysAhead);
  return parseCourseLocalDateTime(`${openingDate.toISOString().slice(0, 10)}T${offering.bookingReleaseTimeLocal ?? "00:00"}`, timeZone);
}
