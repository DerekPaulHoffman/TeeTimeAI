import { describe, expect, it } from "vitest";

import {
  getTimeZoneForCoordinates,
  getTimeZoneOffsetMinutes,
  zonedDateTimeToDate
} from "./timezones";

describe("time zone helpers", () => {
  it("resolves course time zones from coordinates", () => {
    expect(getTimeZoneForCoordinates(41.242, -73.209)).toBe("America/New_York");
    expect(getTimeZoneForCoordinates(34.0522, -118.2437)).toBe("America/Los_Angeles");
  });

  it("stores the same course-local clock time as different UTC instants", () => {
    expect(
      zonedDateTimeToDate("2026-07-11T08:00", "America/New_York").toISOString()
    ).toBe("2026-07-11T12:00:00.000Z");
    expect(
      zonedDateTimeToDate("2026-07-11T08:00", "America/Los_Angeles").toISOString()
    ).toBe("2026-07-11T15:00:00.000Z");
  });

  it("uses the target date when calculating daylight-saving offsets", () => {
    expect(
      getTimeZoneOffsetMinutes(new Date("2026-07-11T16:00:00.000Z"), "America/New_York")
    ).toBe(-240);
    expect(
      getTimeZoneOffsetMinutes(new Date("2026-01-11T17:00:00.000Z"), "America/New_York")
    ).toBe(-300);
  });
});
