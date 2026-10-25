import { isDeepStrictEqual } from "node:util";

type Venue = { courseId: string; offeringId?: string | null; sourceFingerprint?: string; availability: string };
const statuses = new Set(["CHECK_PENDING", "MATCH_FOUND", "NO_MATCH", "OFFICIAL_SITE_ONLY", "UNAVAILABLE", "SUPPORT_PENDING", "BOOKING_NOT_OPEN"]);

/** An in-flight read does not announce that a previously checked source broke.
 * This stabilizes notification state only; it neither supplies availability
 * evidence nor changes the real check result, matches or retry scheduling. */
export function preserveSimulatorStatusDuringProgress<T extends Venue>(venues: T[], prior: unknown): T[] {
  if (!Array.isArray(prior)) return venues;
  return venues.map(venue => {
    if (venue.availability !== "CHECK_PENDING" || !/^[a-f0-9]{64}$/u.test(venue.sourceFingerprint ?? "")) return venue;
    const matches = prior.filter(value => value && typeof value === "object" && !Array.isArray(value) &&
      value.courseId === venue.courseId && value.offeringId === venue.offeringId);
    if (matches.length !== 1) return venue;
    const previous = matches[0] as Record<string, unknown>;
    if (typeof previous.availability !== "string" || !statuses.has(previous.availability)) return venue;
    const { availability: previousStatus, ...before } = previous;
    const { availability: currentStatus, ...after } = venue;
    void currentStatus;
    // JSON persistence omits undefined optional fields. Property order is not
    // meaningful (Postgres JSONB may return a different order).
    if (!isDeepStrictEqual(before, JSON.parse(JSON.stringify(after)))) return venue;
    return { ...venue, availability: previousStatus as T["availability"] };
  });
}
