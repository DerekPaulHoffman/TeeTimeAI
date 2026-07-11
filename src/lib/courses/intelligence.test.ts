import { describe, expect, it } from "vitest";

import {
  getAlertSupportDescription,
  getAlertSupportLabel,
  getCourseAlertSupport,
  isCourseIntelligenceReviewDue,
  isManualOnlyAlertSupport
} from "./intelligence";

describe("course intelligence", () => {
  it("keeps phone-only booking separate from generic blocked access", () => {
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "PHONE_ONLY"
      })
    ).toBe("PHONE_ONLY");
    expect(getAlertSupportLabel("PHONE_ONLY")).toBe("Phone only");
    expect(getAlertSupportDescription("PHONE_ONLY")).toContain("Call the course");
  });

  it("uses stable manual-only categories for other direct booking modes", () => {
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "CONTACT_COURSE"
      })
    ).toBe("CONTACT_COURSE");
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "WALK_IN"
      })
    ).toBe("WALK_IN_ONLY");
    expect(
      getCourseAlertSupport({
        automationEligibility: "BLOCKED",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toBe("OFFICIAL_SITE_ONLY");
  });

  it("does not mark monitorable courses as manual-only", () => {
    expect(
      getCourseAlertSupport({
        automationEligibility: "ALLOWED",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toBeUndefined();
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
