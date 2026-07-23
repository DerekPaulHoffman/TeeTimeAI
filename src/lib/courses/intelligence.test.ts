import { describe, expect, it } from "vitest";

import {
  getAlertSupportDescription,
  getAlertSupportLabel,
  getCourseAlertSupport,
  getCourseMonitoringSupport,
  getUnavailableAlertCoverageCopy,
  isCourseIntelligenceReviewDue,
  isManualOnlyAlertSupport,
  resolveBookingAccessMode,
  type BookingAccessMode
} from "./intelligence";

describe("course intelligence", () => {
  it.each([
    {
      mode: "ACCOUNT_REQUIRED",
      label: "Golfer account required",
      copy: "Use the official site and contact the course if you need access"
    },
    {
      mode: "ACCOUNT_SELF_SERVICE",
      label: "Golfer account required",
      copy: "Golfers can create or use their own account"
    },
    {
      mode: "ACCOUNT_STAFF_PROVISIONED",
      label: "First-time access setup",
      copy: "first-time online booking access must be set up by course staff"
    },
    {
      mode: "PHONE_ONLY",
      label: "Phone only",
      copy: "Call the course directly"
    },
    {
      mode: "CONTACT_COURSE",
      label: "Contact course",
      copy: "contact it directly"
    },
    {
      mode: "WALK_IN",
      label: "Walk-in only",
      copy: "handles tee-time access in person"
    },
    {
      mode: "CAPTCHA_OR_QUEUE",
      label: "Captcha or queue",
      copy: "does not bypass those controls"
    }
  ] as const)(
    "uses accurate customer wording for $mode",
    ({ mode, label, copy }) => {
      const support = getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingAccessMode: mode
      });

      expect(support).toBeDefined();
      expect(getAlertSupportLabel(support!)).toBe(label);
      expect(getAlertSupportDescription(support!)).toContain(copy);
      expect(
        getUnavailableAlertCoverageCopy({ bookingAccessMode: mode })
      ).toContain(copy);
    }
  );

  it("keeps a public signed-out success stronger than older account evidence", () => {
    expect(
      resolveBookingAccessMode({
        automationEligibility: "ALLOWED",
        automationReason: "ACCOUNT_REQUIRED",
        bookingAccessMode: "ACCOUNT_STAFF_PROVISIONED"
      })
    ).toBe("PUBLIC_SIGNED_OUT");
    expect(
      getCourseAlertSupport({
        automationEligibility: "ALLOWED",
        bookingMethod: "PUBLIC_ONLINE",
        bookingAccessMode: "ACCOUNT_STAFF_PROVISIONED"
      })
    ).toBeUndefined();
  });

  it("falls back to existing technical and manual facts during migration", () => {
    const scenarios: Array<{
      input: Parameters<typeof resolveBookingAccessMode>[0];
      expected: BookingAccessMode;
    }> = [
      {
        input: { automationReason: "ACCOUNT_REQUIRED" },
        expected: "ACCOUNT_REQUIRED"
      },
      {
        input: { automationReason: "CAPTCHA_OR_QUEUE" },
        expected: "CAPTCHA_OR_QUEUE"
      },
      {
        input: { bookingMethod: "PHONE_ONLY" },
        expected: "PHONE_ONLY"
      },
      {
        input: { bookingMethod: "CONTACT_COURSE" },
        expected: "CONTACT_COURSE"
      },
      {
        input: { bookingMethod: "WALK_IN" },
        expected: "WALK_IN"
      },
      {
        input: {},
        expected: "UNKNOWN"
      }
    ];

    for (const scenario of scenarios) {
      expect(resolveBookingAccessMode(scenario.input)).toBe(scenario.expected);
    }
  });

  it("preserves direct-booking fallbacks when access evidence is unknown", () => {
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toBe("DIRECT_ONLINE");
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "UNKNOWN"
      })
    ).toBe("OFFICIAL_SITE_ONLY");
    expect(getAlertSupportLabel("DIRECT_ONLINE")).toBe("Book online directly");
  });

  it("only presents automatic monitoring after support is confirmed", () => {
    expect(getCourseMonitoringSupport({ automationEligibility: "ALLOWED" })).toBe(
      "AUTOMATIC"
    );
    expect(getCourseMonitoringSupport({ automationEligibility: "BLOCKED" })).toBe(
      "MANUAL_ONLY"
    );
    expect(getCourseMonitoringSupport({ automationEligibility: "UNKNOWN" })).toBe(
      "UNCONFIRMED"
    );
    expect(getCourseMonitoringSupport()).toBe("UNCONFIRMED");
    expect(isManualOnlyAlertSupport(undefined)).toBe(false);
    expect(isManualOnlyAlertSupport("PHONE_ONLY")).toBe(true);
  });

  it("surfaces stale intelligence for review without returning it to normal probing", () => {
    const now = new Date("2026-07-11T00:00:00.000Z");

    expect(isCourseIntelligenceReviewDue("2026-07-01T00:00:00.000Z", now)).toBe(true);
    expect(isCourseIntelligenceReviewDue("2026-08-01T00:00:00.000Z", now)).toBe(false);
    expect(isCourseIntelligenceReviewDue(null, now)).toBe(false);
  });
});
