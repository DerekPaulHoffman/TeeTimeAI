import { describe, expect, it } from "vitest";
import { selectKnownCourseTimes, selectKnownTeeTimes, type ObservedTeeTime } from "./known-tee-times";

const now = new Date("2026-10-02T12:00:00Z");
const match: ObservedTeeTime = {
  startsAt: new Date("2026-10-03T00:30:00Z"), availableSpots: 3, holes: 18,
  priceCents: 4500, bookingUrl: "https://example.com/tee-times",
  lastConfirmedAt: new Date("2026-10-02T11:55:00Z"), lastSeenAt: new Date("2026-10-02T11:55:00Z"),
  availabilityStatus: "AVAILABLE"
};
describe("previously checked times", () => {
  const snapshot = (times: unknown[], confirmedAt = "2026-10-02T11:59:00Z") => ({ publicAvailability: { date: "2026-10-02", confirmedAt, times } });
  const slot = { startsAt: match.startsAt.toISOString(), availableSpots: 3, holes: 18, priceCents: 4500, bookingUrl: match.bookingUrl };
  it("shows observed public slots even when no saved alert matched them", () => {
    expect(selectKnownCourseTimes([], snapshot([slot]), "America/New_York", "2026-10-02", now)).toHaveLength(1);
  });
  it("withdraws older saved matches when a newer complete sheet is empty", () => {
    expect(selectKnownCourseTimes([match], snapshot([]), "America/New_York", "2026-10-02", now)).toEqual([]);
  });
  it("keeps later removals authoritative over a public snapshot", () => {
    expect(selectKnownCourseTimes([{ ...match, availabilityStatus: "GONE", unavailableAt: now }], snapshot([slot]), "America/New_York", "2026-10-02", now)).toEqual([]);
  });
  it("rejects stale and unsafe snapshot times and ignores snapshots for another date", () => {
    expect(selectKnownCourseTimes([], snapshot([slot], "2026-10-02T08:00:00Z"), "America/New_York", "2026-10-02", now)).toEqual([]);
    expect(selectKnownCourseTimes([], snapshot([{ ...slot, bookingUrl: "javascript:alert(1)" }]), "America/New_York", "2026-10-02", now)).toEqual([]);
    expect(selectKnownCourseTimes([], snapshot([slot]), "America/New_York", "2026-10-03", now)).toEqual([]);
  });
  it("preserves later slots so an evening filter cannot lose them to a morning display limit", () => {
    const times = Array.from({ length: 30 }, (_, index) => ({ ...match,
      startsAt: new Date(now.getTime() + (index + 1) * 10 * 60 * 1000)
    }));
    expect(selectKnownTeeTimes(times, "America/New_York", "2026-10-02", now)).toHaveLength(30);
  });
  it("uses the course-local date and publishes only slot data", () => {
    const result = selectKnownTeeTimes([match], "America/New_York", "2026-10-02", now);
    expect(result).toHaveLength(1);
    expect(Object.keys(result[0])).toEqual(["startsAt", "availableSpots", "holes", "priceCents", "bookingUrl", "confirmedAt"]);
    expect(selectKnownTeeTimes([match], "Asia/Tokyo", "2026-10-02", now)).toEqual([]);
  });
  it("deduplicates searches and lets a later unavailable observation win", () => {
    expect(selectKnownTeeTimes([match, match], "America/New_York", "2026-10-02", now)).toHaveLength(1);
    const unavailable = { ...match, availabilityStatus: "UNAVAILABLE", lastSeenAt: now };
    expect(selectKnownTeeTimes([unavailable, match], "America/New_York", "2026-10-02", now)).toEqual([]);
  });
  it("excludes stale, past, empty, and unsafe slots", () => {
    for (const change of [
      { lastConfirmedAt: new Date("2026-10-02T09:59:00Z") },
      { startsAt: now }, { availableSpots: 0 }, { bookingUrl: "javascript:alert(1)" },
      { bookingUrl: "https://user:password@example.com" }
    ]) expect(selectKnownTeeTimes([{ ...match, ...change }], "America/New_York", "2026-10-02", now)).toEqual([]);
  });
  it("uses the real removal timestamp even when lastSeenAt stays unchanged", () => {
    const gone = { ...match, availabilityStatus: "GONE", lastSeenAt: new Date("2026-10-02T11:00:00Z"), unavailableAt: now };
    expect(selectKnownTeeTimes([gone, match], "America/New_York", "2026-10-02", now)).toEqual([]);
    const reappeared = { ...match, lastSeenAt: new Date("2026-10-02T12:01:00Z"), lastConfirmedAt: new Date("2026-10-02T12:01:00Z") };
    expect(selectKnownTeeTimes([gone, reappeared], "America/New_York", "2026-10-02", new Date("2026-10-02T12:02:00Z"))).toHaveLength(1);
  });
});
