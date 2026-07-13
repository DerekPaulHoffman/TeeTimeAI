import { describe, expect, it } from "vitest";

import {
  formatBookingWindowRelease,
  getBookingWindowForTargetDate,
  normalizeReleaseTime,
  parseBookingReleaseMessage,
  parsePublicBookingWindowRule
} from "./booking-window";

describe("course booking windows", () => {
  it("calculates the exact course-local opening time across daylight saving time", () => {
    const window = getBookingWindowForTargetDate("2026-07-29", {
      timeZone: "America/New_York",
      bookingWindowDaysAhead: 14,
      bookingReleaseTimeLocal: "05:00",
      bookingWindowSource: "PROVIDER_CONFIG",
      bookingWindowConfidence: 1
    });

    expect(window).toMatchObject({
      releaseDate: "2026-07-15",
      releaseTimeLocal: "05:00",
      exactTime: true
    });
    expect(window?.opensAt.toISOString()).toBe("2026-07-15T09:00:00.000Z");
    expect(formatBookingWindowRelease(window!)).toBe("Wednesday, July 15 at 5:00 AM EDT");
  });

  it("parses a public-specific ForeUP booking rule instead of the member window", () => {
    const evidence = parsePublicBookingWindowRule(
      "All members can book 9 days in advance starting at 6 am and the public (all non-members) can book 8 days in advance also at 6 am.",
      "https://foreupsoftware.com/booking/example"
    );

    expect(evidence).toEqual({
      daysAhead: 8,
      releaseTimeLocal: "06:00",
      source: "OFFICIAL_BOOKING_PAGE",
      confidence: 0.98,
      evidenceUrl: "https://foreupsoftware.com/booking/example"
    });
  });

  it("does not attach an earlier unrelated public label to a member booking rule", () => {
    const evidence = parsePublicBookingWindowRule(
      "Public golf information and current rates. All members can book 9 days in advance starting at 6 am and the public (all non-members) can book 8 days in advance also at 6 am.",
      "https://foreupsoftware.com/booking/example"
    );

    expect(evidence?.daysAhead).toBe(8);
    expect(evidence?.releaseTimeLocal).toBe("06:00");
  });

  it("parses an exact TeeItUp release message", () => {
    const evidence = parseBookingReleaseMessage({
      message:
        "Tee times will be available to book from Wednesday, July 29, 2026 at 12:00 AM",
      targetDate: "2026-08-12",
      timeZone: "America/New_York",
      evidenceUrl: "https://phx-api-be-east-1b.kenna.io/v2/tee-times?date=2026-08-12"
    });

    expect(evidence).toMatchObject({
      daysAhead: 14,
      releaseTimeLocal: "00:00",
      source: "PROVIDER_MESSAGE",
      confidence: 1
    });
  });

  it("normalizes provider clock formats and rejects invalid times", () => {
    expect(normalizeReleaseTime("12:00 AM")).toBe("00:00");
    expect(normalizeReleaseTime("6 pm")).toBe("18:00");
    expect(normalizeReleaseTime("25:00")).toBeNull();
  });
});
