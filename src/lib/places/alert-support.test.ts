import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

import { enrichCoursesWithAlertSupport, findBlockedCourse } from "./alert-support";

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
      findBlockedCourse(
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
      findBlockedCourse(
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
      findBlockedCourse(
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
      findBlockedCourse(
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

    expect(findBlockedCourse(generic, courses)).toBeUndefined();
  });
});
