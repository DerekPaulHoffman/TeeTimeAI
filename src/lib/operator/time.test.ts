import { describe, expect, it } from "vitest";

import {
  formatOperatorDayKey,
  getOperatorDateRange,
  parseOperatorRange
} from "./time";

describe("operator date range", () => {
  it("defaults to seven days and accepts the thirty-day option", () => {
    expect(parseOperatorRange(undefined)).toBe(7);
    expect(parseOperatorRange("7d")).toBe(7);
    expect(parseOperatorRange("anything")).toBe(7);
    expect(parseOperatorRange("30d")).toBe(30);
  });

  it("uses America/New_York calendar boundaries", () => {
    const range = getOperatorDateRange(
      7,
      new Date("2026-07-23T15:00:00.000Z")
    );

    expect(range.todayStart.toISOString()).toBe("2026-07-23T04:00:00.000Z");
    expect(range.start.toISOString()).toBe("2026-07-17T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-24T04:00:00.000Z");
    expect(range.dayKeys).toEqual([
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23"
    ]);
  });

  it("handles the spring daylight-saving transition", () => {
    const range = getOperatorDateRange(
      7,
      new Date("2026-03-09T16:00:00.000Z")
    );

    expect(range.start.toISOString()).toBe("2026-03-03T05:00:00.000Z");
    expect(range.todayStart.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-10T04:00:00.000Z");
  });

  it("buckets timestamps by Eastern calendar day", () => {
    expect(formatOperatorDayKey(new Date("2026-07-23T03:30:00.000Z"))).toBe(
      "2026-07-22"
    );
  });
});
