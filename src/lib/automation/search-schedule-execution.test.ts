import { describe, expect, it } from "vitest";

import { calculateNextCheckAt } from "./search-schedule-execution";

describe("calculateNextCheckAt", () => {
  it("sleeps until the booking window when a search is far in the future", () => {
    const searchDate = new Date("2026-08-30T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 15, now)?.getTime()).toBe(
      searchDate.getTime() - 14 * 24 * 60 * 60 * 1000
    );
  });

  it("uses the search cadence once the booking window is open", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 30, now)?.toISOString()).toBe(
      "2026-08-01T12:30:00.000Z"
    );
  });

  it("supports five-minute launch checks inside the booking window", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 5, now)?.toISOString()).toBe(
      "2026-08-01T12:05:00.000Z"
    );
  });

  it("stops after the search date has passed", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-12T04:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 15, now)).toBeNull();
  });
});
