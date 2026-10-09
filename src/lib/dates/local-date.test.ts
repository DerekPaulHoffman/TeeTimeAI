import { describe, expect, it } from "vitest";

import {
  getMinimumSearchDateInputValue,
  getNextSearchDateRolloverAt,
  getNextSaturdayDateInputValue,
  reconcileFutureSearchDateInputValue
} from "./local-date";

describe("getNextSaturdayDateInputValue", () => {
  it.each([
    ["Saturday", new Date(2026, 6, 11, 12), "2026-07-18"],
    ["Sunday", new Date(2026, 6, 12, 12), "2026-07-18"],
    ["Friday", new Date(2026, 6, 17, 12), "2026-07-18"]
  ])("returns the strictly upcoming Saturday from %s", (_, from, expected) => {
    expect(getNextSaturdayDateInputValue(from)).toBe(expected);
  });
});

describe("selected-course calendar dates", () => {
  const utcWednesday = new Date("2026-09-30T03:16:30.000Z");

  it("allows New York's tomorrow even when UTC and a Tokyo browser are already on that date", () => {
    expect(getMinimumSearchDateInputValue(utcWednesday, ["America/New_York"])).toBe(
      "2026-09-30"
    );
    expect(reconcileFutureSearchDateInputValue("2026-09-30", utcWednesday, [
      "America/New_York"
    ])).toBe("2026-09-30");
  });

  it("requires tomorrow or later for every selected course", () => {
    expect(getMinimumSearchDateInputValue(utcWednesday, ["Asia/Tokyo"])).toBe("2026-10-01");
    expect(getMinimumSearchDateInputValue(utcWednesday, [
      "America/New_York", "Asia/Tokyo"
    ])).toBe("2026-10-01");
    expect(getMinimumSearchDateInputValue(utcWednesday, ["America/New_York"])).toBe(
      "2026-09-30"
    );
  });

  it("allows simulator today only when it is today for every selected venue", () => {
    expect(getMinimumSearchDateInputValue(utcWednesday, ["America/New_York"], true)).toBe("2026-09-29");
    expect(getMinimumSearchDateInputValue(utcWednesday, ["America/New_York", "Asia/Tokyo"], true)).toBe("2026-09-30");
    expect(reconcileFutureSearchDateInputValue("2026-09-29", utcWednesday, ["America/New_York"], true)).toBe("2026-09-29");
  });

  it("chooses the next Saturday from the latest course calendar, including a year boundary", () => {
    const from = new Date("2027-01-02T01:00:00.000Z");
    expect(getNextSaturdayDateInputValue(from, ["America/New_York"])).toBe("2027-01-02");
    expect(getNextSaturdayDateInputValue(from, ["America/New_York", "Asia/Tokyo"])).toBe(
      "2027-01-09"
    );
  });

  it("uses the existing product fallback for an invalid candidate timezone", () => {
    expect(getMinimumSearchDateInputValue(utcWednesday, ["not-a-zone"])).toBe("2026-09-30");
  });

  it.each([
    ["ordinary night", "2026-09-30T03:16:30.000Z", "2026-09-30T04:00:00.000Z"],
    ["spring's 23-hour day", "2026-03-08T05:01:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["fall's 25-hour day", "2026-11-01T04:01:00.000Z", "2026-11-02T05:00:00.000Z"]
  ])("refreshes just after course midnight on %s", (_, from, midnight) => {
    const rollover = getNextSearchDateRolloverAt(new Date(from), ["America/New_York"]);
    const delay = rollover.getTime() - new Date(midnight).getTime();
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThanOrEqual(2_000);
    expect(getMinimumSearchDateInputValue(rollover, ["America/New_York"])).toBe(
      getMinimumSearchDateInputValue(new Date(midnight), ["America/New_York"])
    );
  });

  it("wakes at the earliest selected course midnight", () => {
    const rollover = getNextSearchDateRolloverAt(utcWednesday, [
      "Asia/Tokyo", "America/New_York", "America/New_York"
    ]);
    expect(rollover.getTime()).toBeGreaterThan(new Date("2026-09-30T04:00:00.000Z").getTime());
    expect(rollover.getTime()).toBeLessThan(new Date("2026-09-30T04:00:02.000Z").getTime());
  });

  it("retains browser-local midnight before any course is selected", () => {
    const from = new Date(2026, 6, 31, 23, 59, 30);
    expect(getNextSearchDateRolloverAt(from)).toEqual(new Date(2026, 7, 1, 0, 0, 1));
  });
});

describe("search date rollover", () => {
  const fridayNight = new Date(2026, 6, 31, 23, 59, 30);
  const saturdayMorning = new Date(2026, 7, 1, 0, 1);

  it("moves the minimum date forward with the local calendar day", () => {
    expect(getMinimumSearchDateInputValue(fridayNight)).toBe("2026-08-01");
    expect(getMinimumSearchDateInputValue(saturdayMorning)).toBe("2026-08-02");
  });

  it("replaces a stale untouched date with the next upcoming Saturday", () => {
    expect(reconcileFutureSearchDateInputValue("2026-08-01", saturdayMorning)).toBe(
      "2026-08-08"
    );
  });

  it("preserves a date that remains inside the valid future range", () => {
    expect(reconcileFutureSearchDateInputValue("2026-08-15", saturdayMorning)).toBe(
      "2026-08-15"
    );
  });
});
