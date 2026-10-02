import { describe, expect, it } from "vitest";
import { selectKnownTeeTimes, type ObservedTeeTime } from "./known-tee-times";

const now = new Date("2026-10-02T12:00:00Z");
const match: ObservedTeeTime = {
  startsAt: new Date("2026-10-03T00:30:00Z"), availableSpots: 3, holes: 18,
  priceCents: 4500, bookingUrl: "https://example.com/tee-times",
  lastConfirmedAt: new Date("2026-10-02T11:55:00Z"), lastSeenAt: new Date("2026-10-02T11:55:00Z"),
  availabilityStatus: "AVAILABLE"
};
describe("previously checked times", () => {
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
});
