import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

import {
  enrichCoursesWithHoleLayouts,
  findCourseLayout,
  type CourseLayoutRecord
} from "./hole-layout-enrichment";

vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: vi.fn() } } }));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("course hole-layout enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.course.findMany.mockResolvedValue([]);
  });

  it("marks Woodhaven as a verified physical 9-hole course from its persisted record", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      layoutCourse({ layoutHolesVerifiedAt: new Date("2026-07-11T00:00:00.000Z") })
    ] as never);

    const [course] = await enrichCoursesWithHoleLayouts([woodhavenCandidate()]);

    expect(course).toEqual(
      expect.objectContaining({
        layoutHoleCounts: [9],
        layoutHolesStatus: "VERIFIED",
        layoutHolesEvidenceUrl: "https://www.woodhavenctgolf.com/",
        layoutHolesVerifiedAt: "2026-07-11T00:00:00.000Z"
      })
    );
  });

  it("uses persisted verified layout data", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      layoutCourse({
        googlePlaceId: "persisted-course",
        name: "Example Golf Club",
        layoutHoleCounts: [18],
        layoutHolesEvidenceUrl: "https://example.com/course",
        layoutHolesVerifiedAt: new Date("2026-07-12T12:00:00Z")
      })
    ] as never);

    const [course] = await enrichCoursesWithHoleLayouts([
      {
        ...woodhavenCandidate(),
        googlePlaceId: "persisted-course",
        name: "Example Golf Club"
      }
    ]);

    expect(course).toEqual(
      expect.objectContaining({
        layoutHoleCounts: [18],
        layoutHolesStatus: "VERIFIED",
        layoutHolesEvidenceUrl: "https://example.com/course",
        layoutHolesVerifiedAt: "2026-07-12T12:00:00.000Z"
      })
    );
  });

  it("matches an alternate place id only when name and coordinates agree", () => {
    const woodhaven = layoutCourse();

    expect(
      findCourseLayout(
        {
          ...woodhavenCandidate(),
          googlePlaceId: "alternate-woodhaven-id",
          name: "Woodhaven Country Club",
          latitude: 41.4157,
          longitude: -73.0395
        },
        [woodhaven]
      )
    ).toBe(woodhaven);
    expect(
      findCourseLayout(
        {
          ...woodhavenCandidate(),
          googlePlaceId: "unrelated-course",
          name: "Bethany General Store"
        },
        [woodhaven]
      )
    ).toBeUndefined();
  });

  it("labels courses without verified evidence as unverified", async () => {
    const [course] = await enrichCoursesWithHoleLayouts([
      {
        googlePlaceId: "unknown",
        name: "Unknown Golf Course",
        latitude: 40,
        longitude: -73,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.layoutHolesStatus).toBe("UNVERIFIED");
    expect(course.layoutHoleCounts).toBeUndefined();
  });

  it("does not trust persisted layout counts without a verification timestamp", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      layoutCourse({
        googlePlaceId: "unverified-persisted",
        name: "Unverified Persisted Golf Course",
        latitude: 40,
        longitude: -73,
        layoutHoleCounts: [9],
        layoutHolesVerifiedAt: null
      })
    ] as never);

    const [course] = await enrichCoursesWithHoleLayouts([
      {
        googlePlaceId: "unverified-persisted",
        name: "Unverified Persisted Golf Course",
        latitude: 40,
        longitude: -73,
        timeZone: "America/New_York"
      }
    ]);

    expect(course.layoutHolesStatus).toBe("UNVERIFIED");
    expect(course.layoutHoleCounts).toBeUndefined();
  });
});

function woodhavenCandidate() {
  return {
    googlePlaceId: "ChIJUypX_OHc54kRkpGKTvmSvSA",
    name: "Woodhaven Golf Course",
    latitude: 41.415596,
    longitude: -73.039627,
    timeZone: "America/New_York"
  };
}

function layoutCourse(overrides: Partial<CourseLayoutRecord> = {}): CourseLayoutRecord {
  return {
    googlePlaceId: "ChIJUypX_OHc54kRkpGKTvmSvSA",
    name: "Woodhaven Golf Course",
    latitude: 41.415596,
    longitude: -73.039627,
    layoutHoleCounts: [9],
    layoutHolesEvidenceUrl: "https://www.woodhavenctgolf.com/",
    layoutHolesVerifiedAt: null,
    ...overrides
  };
}
