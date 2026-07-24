import { describe, expect, it } from "vitest";

import {
  classifyProviderCoverage,
  recommendProviderCoverageAction
} from "./provider-coverage";

const baseCourse = {
  isPublic: true,
  website: "https://course.example",
  detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/2",
  detectedPlatform: "FOREUP",
  providerFamilyKey: "FOREUP",
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "NONE",
  bookingMetadata: {
    scheduleId: 1,
    bookingClassId: 2,
    bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/1/2"
  },
  intelligenceVerifiedAt: null,
  intelligenceReviewAt: null,
  intelligenceConfidence: null,
  probes: [{ outcome: "NO_MATCH", observedAt: new Date() }],
  supportIncident: null
};

describe("provider coverage classification", () => {
  it("counts a runnable provider with successful evidence as monitored", () => {
    expect(classifyProviderCoverage(baseCourse)).toBe("MONITORED");
  });

  it("separates supported-but-degraded providers from unknown sources", () => {
    expect(
      classifyProviderCoverage({
        ...baseCourse,
        supportIncident: {
          status: "AUTO_INVESTIGATING",
          resolvedAt: null,
          resolution: null,
          activeRealSearchCount: 0,
          engineeringOnly: true,
          failureClass: "HTTP_5XX",
          attemptCount: 1,
          firstSeenAt: new Date()
        }
      })
    ).toBe("SUPPORTED_DEGRADED");

    expect(
      classifyProviderCoverage({
        ...baseCourse,
        website: null,
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        bookingMetadata: null,
        probes: []
      })
    ).toBe("SOURCE_UNVERIFIED");
  });

  it("keeps supported courses awaiting their first demand check out of degraded", () => {
    expect(
      classifyProviderCoverage({
        ...baseCourse,
        probes: [],
        supportIncident: null
      })
    ).toBe("SUPPORTED_READY");
  });

  it("accepts a newer monitoring-restored resolution over stale failure history", () => {
    const observedAt = new Date("2026-07-22T08:00:00.000Z");
    expect(
      classifyProviderCoverage({
        ...baseCourse,
        probes: [{ outcome: "FETCH_FAILED", observedAt }],
        supportIncident: {
          status: "RESOLVED",
          resolvedAt: new Date("2026-07-22T09:00:00.000Z"),
          resolution: "MONITORING_RESTORED",
          activeRealSearchCount: 0,
          engineeringOnly: true,
          failureClass: "AUTH",
          attemptCount: 1,
          firstSeenAt: observedAt
        }
      })
    ).toBe("MONITORED");
  });

  it("keeps manual and technical final states distinct", () => {
    const now = new Date("2026-07-22T05:00:00.000Z");
    const intelligenceVerifiedAt = new Date("2026-07-21T05:00:00.000Z");
    const intelligenceReviewAt = new Date("2026-10-21T05:00:00.000Z");
    expect(
      classifyProviderCoverage(
        {
          ...baseCourse,
          bookingMethod: "WALK_IN",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          intelligenceVerifiedAt,
          intelligenceReviewAt,
          intelligenceConfidence: 0.95
        },
        now
      )
    ).toBe("PHONE_OR_WALK_IN");
    expect(
      classifyProviderCoverage(
        {
          ...baseCourse,
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          intelligenceVerifiedAt,
          intelligenceReviewAt,
          intelligenceConfidence: 0.95
        },
        now
      )
    ).toBe("TECHNICAL_CONSTRAINT");
  });

  it("reports the dynamic action behind each coverage category", () => {
    expect(recommendProviderCoverageAction(baseCourse)).toBe("RUN_TYPED_ADAPTER");
    expect(
      recommendProviderCoverageAction({
        ...baseCourse,
        detectedBookingUrl: "https://fox.tenfore.golf/example",
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "TENFORE",
        bookingMetadata: null,
        probes: [],
        supportIncident: {
          status: "AUTO_INVESTIGATING",
          resolvedAt: null,
          resolution: null,
          activeRealSearchCount: 0,
          engineeringOnly: true,
          failureClass: "UNSUPPORTED_FAMILY",
          attemptCount: 1,
          firstSeenAt: new Date()
        }
      })
    ).toBe("REPAIR_PROVIDER_ADAPTER");
    expect(
      recommendProviderCoverageAction({
        ...baseCourse,
        website: "https://unknown-course.example/",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        bookingMetadata: null,
        probes: [],
        supportIncident: {
          status: "AUTO_INVESTIGATING",
          resolvedAt: null,
          resolution: null,
          activeRealSearchCount: 0,
          engineeringOnly: true,
          failureClass: "MISSING_SOURCE",
          attemptCount: 1,
          firstSeenAt: new Date()
        }
      })
    ).toBe("DISCOVER_WITH_HTTP");
  });
});
