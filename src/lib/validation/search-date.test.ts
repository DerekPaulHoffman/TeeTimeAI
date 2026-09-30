import { describe, expect, it } from "vitest";

import { assertFutureCourseSearchDate, isValidSearchCalendarDate } from "./search-date";

describe("course-local search date eligibility", () => {
  const afterUtcMidnight = new Date("2026-09-30T03:16:30.000Z");

  it("accepts tomorrow in Eastern time after the UTC day has advanced", () => {
    expect(() => assertFutureCourseSearchDate(
      "2026-09-30", ["America/New_York"], afterUtcMidnight,
    )).not.toThrow();
  });

  it.each(["2026-09-28", "2026-09-29"])("rejects past or same course-local day %s", (date) => {
    expect(() => assertFutureCourseSearchDate(
      date, ["America/New_York"], afterUtcMidnight,
    )).toThrow(/future/);
  });

  it("requires a future local date for every selected course", () => {
    expect(() => assertFutureCourseSearchDate(
      "2026-09-30", ["America/New_York", "Asia/Tokyo"], afterUtcMidnight,
    )).toThrow(/every selected course/);
  });

  it("rejects same-day immediately at the course's local midnight", () => {
    expect(() => assertFutureCourseSearchDate(
      "2026-09-30", ["America/New_York"], new Date("2026-09-30T04:00:00.000Z"),
    )).toThrow(/future/);
  });

  it("uses the product fallback when canonical timezone is missing", () => {
    expect(() => assertFutureCourseSearchDate(
      "2026-09-30", [undefined], afterUtcMidnight,
    )).not.toThrow();
  });

  it("accepts leap dates without rolling an invalid date into another month", () => {
    expect(isValidSearchCalendarDate("2028-02-29")).toBe(true);
    expect(isValidSearchCalendarDate("2026-02-29")).toBe(false);
    expect(() => assertFutureCourseSearchDate("2026-09-31", ["America/New_York"], afterUtcMidnight))
      .toThrow(/valid YYYY-MM-DD/);
  });
});
