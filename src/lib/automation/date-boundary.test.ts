import { describe, expect, it } from "vitest";

import {
  getCourseLocalDateStorageBoundary,
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
