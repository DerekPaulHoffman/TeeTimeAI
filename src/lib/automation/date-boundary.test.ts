import { describe, expect, it } from "vitest";

import {
  earliestPotentiallyActiveSearchDate,
  getCourseLocalDateStorageBoundary,
  calculateSearchWindowEnd,
  isSearchWindowActive,
  startOfUtcCalendarDay
} from "./date-boundary";

describe("startOfUtcCalendarDay", () => {
  it("includes a same-day UTC-midnight search during an Eastern-time run", () => {
    const runStartedAt = new Date("2026-07-11T08:02:00-04:00");
    const sameDaySearchDate = new Date("2026-07-11T00:00:00.000Z");
    const dateFloor = startOfUtcCalendarDay(runStartedAt);

    expect(runStartedAt.toISOString()).toBe("2026-07-11T12:02:00.000Z");
    expect(dateFloor.toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(sameDaySearchDate.getTime()).toBeGreaterThanOrEqual(
      dateFloor.getTime()
    );
  });
});

describe("earliestPotentiallyActiveSearchDate", () => {
  it("keeps the prior UTC date eligible for a current western local day", () => {
    expect(
      earliestPotentiallyActiveSearchDate(
        new Date("2026-07-21T01:00:00.000Z")
      ).toISOString()
    ).toBe("2026-07-20T00:00:00.000Z");
  });
});

describe("getCourseLocalDateStorageBoundary", () => {
  it("keeps the western local day after UTC midnight", () => {
    expect(
      getCourseLocalDateStorageBoundary(
        "America/Los_Angeles",
        new Date("2026-07-21T01:00:00.000Z")
      ).toISOString()
    ).toBe("2026-07-20T00:00:00.000Z");
  });

  it("uses the normalized product fallback for a missing timezone", () => {
    expect(
      getCourseLocalDateStorageBoundary(
        null,
        new Date("2026-07-21T01:00:00.000Z")
      ).toISOString()
    ).toBe("2026-07-20T00:00:00.000Z");
  });
});

describe("isSearchWindowActive", () => {
  it.each([
    ["spring", "2026-03-08", "2026-03-09T04:00:00.000Z"],
    ["fall", "2026-11-01", "2026-11-02T05:00:00.000Z"],
  ])("ends 24:00 at next course-local midnight across %s DST", (_name, date, expected) => {
    expect(calculateSearchWindowEnd(new Date(`${date}T00:00:00Z`), "24:00",
      ["America/New_York"], "America/New_York").toISOString()).toBe(expected);
  });
  it("keeps a target-day Eastern search active after UTC midnight", () => {
    const input = {
      date: new Date("2026-07-20T00:00:00.000Z"),
      endTime: "23:00",
      courseTimeZones: ["America/New_York"],
      fallbackTimeZone: "America/New_York"
    };

    expect(
      isSearchWindowActive({
        ...input,
        now: new Date("2026-07-21T02:00:00.000Z")
      })
    ).toBe(true);
    expect(
      isSearchWindowActive({
        ...input,
        now: new Date("2026-07-21T03:00:00.000Z")
      })
    ).toBe(false);
  });

  it("uses the latest course-local expiry for a multi-course search", () => {
    expect(
      isSearchWindowActive({
        date: new Date("2026-07-20T00:00:00.000Z"),
        endTime: "22:00",
        courseTimeZones: ["America/New_York", "America/Los_Angeles"],
        fallbackTimeZone: "America/New_York",
        now: new Date("2026-07-21T04:00:00.000Z")
      })
    ).toBe(true);
  });
});
