import { describe, expect, it } from "vitest";
import { preserveSimulatorStatusDuringProgress } from "./status-progress";

const venue = { courseId: "course", offeringId: "bay", sourceFingerprint: "a".repeat(64), courseName: "Fixture Simulator",
  bookingUrl: "https://venue.example/public", courseRank: 1, availability: "MATCH_FOUND" };
const pending = { ...venue, availability: "CHECK_PENDING" };

describe("simulator recurring-check notification progress", () => {
  it("keeps one known source stable across ready-pending-ready cycles without changing real evidence", () => {
    const before = JSON.stringify(pending);
    const current = preserveSimulatorStatusDuringProgress([pending], [venue]);
    expect(current).toEqual([venue]);
    expect(preserveSimulatorStatusDuringProgress([venue], current)).toEqual([venue]);
    expect(JSON.stringify(pending)).toBe(before);
  });
  it("leaves the first lookup and unknown legacy snapshots honest", () => {
    for (const previous of [null, {}, [], [{ ...venue, sourceFingerprint: undefined }]]) {
      expect(preserveSimulatorStatusDuringProgress([pending], previous)).toEqual([pending]);
    }
  });
  it("does not carry monitoring status across changed source, identity or booking evidence", () => {
    for (const change of [{ sourceFingerprint: "b".repeat(64) }, { offeringId: "other" }, { courseId: "other" },
      { bookingUrl: "https://other.example/public" }, { courseName: "Renamed Simulator" }, { courseRank: 2 }]) {
      expect(preserveSimulatorStatusDuringProgress([{ ...pending, ...change }], [venue])).toEqual([{ ...pending, ...change }]);
    }
  });
  it("continues reporting actual failures, empty inventory and booking-window changes", () => {
    for (const availability of ["UNAVAILABLE", "NO_MATCH", "SUPPORT_PENDING", "BOOKING_NOT_OPEN"]) {
      const next = { ...venue, availability };
      expect(preserveSimulatorStatusDuringProgress([next], [venue])).toEqual([next]);
    }
  });
  it("handles JSONB ordering and omitted optional fields without suppressing another venue's change", () => {
    const reordered = { availability: "MATCH_FOUND", courseRank: 1, bookingUrl: venue.bookingUrl, courseName: venue.courseName,
      sourceFingerprint: venue.sourceFingerprint, offeringId: venue.offeringId, courseId: venue.courseId };
    const second = { ...venue, courseId: "second", availability: "NO_MATCH" };
    expect(preserveSimulatorStatusDuringProgress([{ ...pending, optional: undefined }, second], [reordered, { ...second, availability: "MATCH_FOUND" }]))
      .toEqual([{ ...venue, optional: undefined }, second]);
  });
  it("does not trust ambiguous, malformed or unknown status snapshots", () => {
    for (const previous of [[venue, venue], [{ ...venue, availability: "UNREVIEWED" }], [false, null], [{ ...venue, availability: null }]]) {
      expect(preserveSimulatorStatusDuringProgress([pending], previous)).toEqual([pending]);
    }
  });
});
