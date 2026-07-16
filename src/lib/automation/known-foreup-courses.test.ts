import { describe, expect, it } from "vitest";

import { isForeupMetadata } from "@/lib/adapters/foreup";
import {
  KNOWN_FOREUP_COURSES,
  reconcileKnownForeupMonitoring,
  selectKnownForeupCourses
} from "@/lib/automation/known-foreup-courses";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";

describe("known ForeUP course evidence", () => {
  it("keeps configured metadata runnable and source-only identities non-runnable", () => {
    for (const course of KNOWN_FOREUP_COURSES) {
      const provider = resolveProviderCapability({
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        detectedBookingUrl: course.detectedBookingUrl,
        website: course.officialWebsite,
        bookingMetadata: course.bookingMetadata
      });

      expect(provider.providerFamilyKey).toBe("FOREUP");
      expect(provider.isRunnable).toBe(Boolean(course.bookingMetadata));
      expect(isForeupMetadata(course.bookingMetadata)).toBe(
        Boolean(course.bookingMetadata)
      );
    }
  });

  it("records Westwoods as an official ForeUP identity without guessing schedule metadata", () => {
    const [westwoods] = selectKnownForeupCourses(" westwoods golf course ");

    expect(westwoods).toMatchObject({
      name: "Westwoods Golf Course",
      officialWebsite: "https://westwoodsgc.com/",
      layoutHoleCounts: [18]
    });
    expect(westwoods).not.toHaveProperty("bookingMetadata");
    expect(westwoods?.detectedBookingUrl).toContain(
      "foreupsoftware.com/index.php/booking/22518"
    );
  });

  it("never overwrites a newer access-control disposition with static source evidence", () => {
    const [westwoods] = selectKnownForeupCourses("Westwoods Golf Course");

    const monitoring = reconcileKnownForeupMonitoring(westwoods!, {
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      bookingMetadata: null,
      policyNotes: "Current provider access-control evidence.",
      intelligenceConfidence: 0.95
    });

    expect(monitoring).toMatchObject({
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      bookingMetadata: undefined,
      policyNotes: "Current provider access-control evidence.",
      confidence: 0.95
    });
  });

  it("preserves learned metadata when a source-only configuration is rerun", () => {
    const [westwoods] = selectKnownForeupCourses("Westwoods Golf Course");
    const learnedMetadata = {
      scheduleId: 6123,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/22518#/teetimes"
    };

    const monitoring = reconcileKnownForeupMonitoring(westwoods!, {
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingMetadata: learnedMetadata,
      policyNotes: "Fresh learned provider evidence.",
      intelligenceConfidence: 0.95
    });

    expect(monitoring).toMatchObject({
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingMetadata: learnedMetadata,
      policyNotes: "Fresh learned provider evidence.",
      confidence: 0.95
    });
  });

  it("preserves newer learned metadata over a configured static seed", () => {
    const [longshore] = selectKnownForeupCourses("Longshore Golf Course");
    const learnedMetadata = {
      scheduleId: 24680,
      bookingClassId: 13579,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/23148/24680#/teetimes"
    };

    const monitoring = reconcileKnownForeupMonitoring(longshore!, {
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingMetadata: learnedMetadata,
      policyNotes: "Fresh browser-learned ForeUP metadata.",
      intelligenceConfidence: 0.96
    });

    expect(monitoring).toMatchObject({
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingMetadata: learnedMetadata,
      detectedBookingUrl: learnedMetadata.bookingBaseUrl,
      policyNotes: "Fresh browser-learned ForeUP metadata.",
      confidence: 0.96
    });
    expect(monitoring.bookingMetadata).not.toEqual(longshore?.bookingMetadata);
  });

  it("does not preserve a legacy policy-only block as monitoring authority", () => {
    const [westwoods] = selectKnownForeupCourses("Westwoods Golf Course");

    const monitoring = reconcileKnownForeupMonitoring(westwoods!, {
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      bookingMetadata: null,
      policyNotes: "Historical booking-policy evidence.",
      intelligenceConfidence: 0.99
    });

    expect(monitoring).toMatchObject({
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      bookingMetadata: undefined
    });
  });
});
