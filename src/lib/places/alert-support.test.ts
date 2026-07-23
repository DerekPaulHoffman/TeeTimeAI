import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

import { enrichCoursesWithAlertSupport, findKnownCourse } from "./alert-support";

vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: vi.fn() } } }));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("course alert support enrichment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a known phone-only course unavailable for alerts", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        googlePlaceId: "fairview-farm",
        name: "Fairview Farm Golf Course",
        latitude: 41.815,
        longitude: -73.071,
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED"
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "fairview-farm",
        name: "Fairview Farm Golf Course",
        latitude: 41.815,
        longitude: -73.071,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.alertSupport).toBe("PHONE_ONLY");
    expect(course.monitoringSupport).toBe("MANUAL_ONLY");
  });

  it("shows staff-provisioned access for a public account-gated course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        googlePlaceId: "staff-access",
        name: "Public Resort Golf Course",
        latitude: 41.815,
        longitude: -73.071,
        bookingMethod: "PUBLIC_ONLINE",
        bookingAccessMode: "ACCOUNT_STAFF_PROVISIONED",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED"
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "staff-access",
        name: "Public Resort Golf Course",
        latitude: 41.815,
        longitude: -73.071,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.alertSupport).toBe("ACCOUNT_STAFF_PROVISIONED");
    expect(course.monitoringSupport).toBe("MANUAL_ONLY");
  });

  it("distinguishes blocked online booking from courses without a direct booking mode", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        googlePlaceId: "yale-golf",
        name: "Yale University Golf Course",
        latitude: 41.3187,
        longitude: -72.9854,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED"
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "yale-golf",
        name: "Yale University Golf Course",
        latitude: 41.3187,
        longitude: -72.9854,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.alertSupport).toBe("DIRECT_ONLINE");
    expect(course.monitoringSupport).toBe("MANUAL_ONLY");
  });

  it("keeps an unconfirmed Whoosh course selectable while linking its verified booking page", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        googlePlaceId: "yale-golf",
        name: "Yale University Golf Course",
        latitude: 41.3187,
        longitude: -72.9854,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "NEEDS_REVIEW",
        detectedBookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course"
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "yale-golf",
        name: "Yale University Golf Course",
        latitude: 41.3187,
        longitude: -72.9854,
        timeZone: "America/New_York",
        website: "http://yalegolf.yale.edu/"
      }
    ]);

    expect(course.website).toBe(
      "https://app.whoosh.io/patron/club/yale-golf-course"
    );
    expect(course.monitoringSupport).toBe("UNCONFIRMED");
    expect(course.alertSupport).toBeUndefined();
  });

  it("only claims automatic monitoring for a known allowed course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-timberlin",
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        profile: {
          canonicalSlug: "timberlin-golf-course-berlin-ct",
          status: "PUBLISHED"
        }
      }
    ] as never);

    const [knownCourse, unknownCourse] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        timeZone: "America/New_York"
      },
      {
        googlePlaceId: "not-reviewed",
        name: "Not Yet Reviewed Golf Course",
        latitude: 41.7,
        longitude: -72.8,
        timeZone: "America/New_York"
      }
    ]);

    expect(knownCourse.monitoringSupport).toBe("AUTOMATIC");
    expect(knownCourse.monitoringReadiness).toBe("READY");
    expect(knownCourse.courseId).toBe("course-timberlin");
    expect(knownCourse.profileUrl).toBe("/courses/timberlin-golf-course-berlin-ct");
    expect(unknownCourse.monitoringSupport).toBe("UNCONFIRMED");
    expect(unknownCourse.monitoringReadiness).toBe("VERIFYING");
  });

  it("warns before selection when the newest automatic check failed", async () => {
    const observedAt = new Date("2026-07-23T14:05:00.000Z");
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-windham",
        googlePlaceId: "windham",
        name: "Windham Golf Course",
        latitude: 41.72,
        longitude: -72.2,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        probes: [{ outcome: "FETCH_FAILED", observedAt }]
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "windham",
        name: "Windham Golf Course",
        latitude: 41.72,
        longitude: -72.2,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.monitoringSupport).toBe("AUTOMATIC");
    expect(course.monitoringReadiness).toBe("TEMPORARILY_UNAVAILABLE");
    expect(course.monitoringReadinessObservedAt).toBe(observedAt.toISOString());
  });

  it("keeps a stale course guide linked while its facts are refreshed", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-timberlin",
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        profile: {
          canonicalSlug: "timberlin-golf-course-berlin-ct",
          status: "STALE"
        }
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.profileUrl).toBe("/courses/timberlin-golf-course-berlin-ct");
  });

  it("uses a saved rating only when the current Places response omits one", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-timberlin",
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        rating: 4.4,
        ratingObservedAt: new Date("2026-07-20T12:00:00.000Z")
      }
    ] as never);

    const [fallback, live] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        timeZone: "America/New_York"
      },
      {
        googlePlaceId: "timberlin",
        name: "Timberlin Golf Course",
        latitude: 41.62,
        longitude: -72.75,
        timeZone: "America/New_York",
        rating: 4.7
      }
    ]);

    expect(fallback).toMatchObject({
      rating: 4.4,
      ratingObservedAt: "2026-07-20T12:00:00.000Z"
    });
    expect(live.rating).toBe(4.7);
    expect(live.ratingObservedAt).toBeUndefined();
  });

  it("uses a uniquely linked confirmed facility instead of an unreviewed exact-id duplicate", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-tashua-confirmed",
        googlePlaceId: "demo-tashua-knolls",
        name: "Tashua Knolls Golf Course",
        address: "40 Tashua Knolls Ln, Trumbull, CT",
        latitude: 41.242,
        longitude: -73.209,
        website: "https://www.tashuaknolls.com/",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
        profile: {
          canonicalSlug: "tashua-knolls-golf-course-trumbull-ct",
          status: "PUBLISHED"
        }
      },
      {
        id: "course-tashua-unreviewed",
        googlePlaceId: "google-tashua-facility",
        name: "Tashua Knolls & Tashua Glen Golf Course",
        address: "40 Tashua Knolls Ln, Trumbull, CT 06611, USA",
        latitude: 41.2888889,
        longitude: -73.2494444,
        website: "http://www.tashuaknolls.com/",
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN"
      }
    ] as never);

    const [course] = await enrichCoursesWithAlertSupport([
      {
        googlePlaceId: "google-tashua-facility",
        name: "Tashua Knolls & Tashua Glen Golf Course",
        address: "40 Tashua Knolls Ln, Trumbull, CT 06611, USA",
        latitude: 41.2888889,
        longitude: -73.2494444,
        timeZone: "America/New_York",
        website: "http://www.tashuaknolls.com/"
      }
    ]);

    expect(course.courseId).toBe("course-tashua-confirmed");
    expect(course.monitoringSupport).toBe("AUTOMATIC");
    expect(course.website).toBe(
      "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
    );
    expect(course.profileUrl).toBe("/courses/tashua-knolls-golf-course-trumbull-ct");
  });

  it("does not bypass an explicitly blocked exact course", () => {
    const blockedExact = {
      id: "blocked-exact",
      googlePlaceId: "blocked-place",
      name: "Example Golf Course",
      address: "1 Clubhouse Rd, Example, CT",
      latitude: 41.5,
      longitude: -73.2,
      website: "https://example-golf.test/",
      bookingMethod: "OFFICIAL_SITE" as const,
      automationEligibility: "BLOCKED"
    };
    const nearbyAllowed = {
      id: "nearby-allowed",
      googlePlaceId: "allowed-place",
      name: "Example Golf Course",
      address: "1 Clubhouse Rd, Example, CT",
      latitude: 41.5,
      longitude: -73.2,
      website: "https://example-golf.test/",
      bookingMethod: "PUBLIC_ONLINE" as const,
      automationEligibility: "ALLOWED"
    };

    expect(
      findKnownCourse(
        {
          googlePlaceId: "blocked-place",
          name: "Example Golf Course",
          address: "1 Clubhouse Rd, Example, CT",
          latitude: 41.5,
          longitude: -73.2,
          website: "https://example-golf.test/"
        },
        [blockedExact, nearbyAllowed]
      )
    ).toBe(blockedExact);
  });

  it("matches an alternate place id only when name and coordinates agree", () => {
    const blocked = {
      googlePlaceId: "fairview-farm",
      name: "Fairview Farm Golf Course",
      latitude: 41.815,
      longitude: -73.071,
      bookingMethod: "PHONE_ONLY" as const,
      automationEligibility: "BLOCKED"
    };

    expect(
      findKnownCourse(
        {
          googlePlaceId: "alternate-fairview-id",
          name: "Fairview Farm Golf Course",
          latitude: 41.8151,
          longitude: -73.0711
        },
        [blocked]
      )
    ).toBe(blocked);
    expect(
      findKnownCourse(
        {
          googlePlaceId: "unrelated-course",
          name: "General Store",
          latitude: 41.8151,
          longitude: -73.0711
        },
        [blocked]
      )
    ).toBeUndefined();
  });

  it("matches a generic Google label only at the blocked course location", () => {
    const blocked = {
      googlePlaceId: "fairview-farm",
      name: "Fairview Farm Golf Course",
      latitude: 41.7470436,
      longitude: -73.07518,
      bookingMethod: "PHONE_ONLY" as const,
      automationEligibility: "BLOCKED"
    };

    expect(
      findKnownCourse(
        {
          googlePlaceId: "generic-fairview",
          name: "Golf Course",
          latitude: 41.7478038,
          longitude: -73.074469
        },
        [blocked]
      )
    ).toBe(blocked);
    expect(
      findKnownCourse(
        {
          googlePlaceId: "generic-elsewhere",
          name: "Golf Course",
          latitude: 41.7578038,
          longitude: -73.074469
        },
        [blocked]
      )
    ).toBeUndefined();
  });

  it("does not assign a generic label when multiple blocked courses are equally plausible", () => {
    const generic = {
      googlePlaceId: "generic-bethpage",
      name: "Golf Course",
      latitude: 40.744,
      longitude: -73.455
    };
    const courses = [
      {
        googlePlaceId: "bethpage-black",
        name: "Bethpage Black Golf Course",
        latitude: 40.7445,
        longitude: -73.455,
        bookingMethod: "OFFICIAL_SITE" as const,
        automationEligibility: "BLOCKED"
      },
      {
        googlePlaceId: "bethpage-red",
        name: "Bethpage Red Golf Course",
        latitude: 40.7435,
        longitude: -73.455,
        bookingMethod: "OFFICIAL_SITE" as const,
        automationEligibility: "BLOCKED"
      }
    ];

    expect(findKnownCourse(generic, courses)).toBeUndefined();
  });
});
