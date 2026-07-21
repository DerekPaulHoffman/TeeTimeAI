import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  applyCourseProfileDraft,
  createCourseProfileSlugAlias,
  ensurePendingCourseProfile,
  getPublishedCourseProfile,
  getRelatedSupportedCourses,
  queuePendingCourseProfiles
} from "./service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: { findMany: vi.fn(), findUnique: vi.fn() },
    courseProfile: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    courseProfileSlugAlias: { create: vi.fn(), findUnique: vi.fn() }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("course profile service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a stable suffixed slug when the readable slug already exists", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-ABC123",
      name: "Example Golf Course",
      city: "Fairfield",
      stateCode: "CT",
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue({ id: "existing-profile" } as never);
    mockedPrisma.courseProfile.create.mockResolvedValue({ id: "new-profile" } as never);

    await ensurePendingCourseProfile("course-ABC123");

    expect(mockedPrisma.courseProfile.create).toHaveBeenCalledWith({
      data: {
        courseId: "course-ABC123",
        canonicalSlug: "example-golf-course-fairfield-ct-abc123"
      }
    });
  });

  it("keeps a public stale profile and its aliases visible while refresh is queued", async () => {
    mockedPrisma.courseProfile.findFirst.mockResolvedValue({
      status: "STALE",
      canonicalSlug: "current-course-fairfield-ct",
      course: { isPublic: true }
    } as never);

    expect(await getPublishedCourseProfile("current-course-fairfield-ct")).toMatchObject({
      redirectSlug: null,
      profile: { status: "STALE" }
    });
    expect(mockedPrisma.courseProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        canonicalSlug: "current-course-fairfield-ct",
        status: { in: ["PUBLISHED", "STALE"] },
        course: { isPublic: true }
      }
    }));

    mockedPrisma.courseProfile.findFirst.mockResolvedValue(null);
    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue({
      courseProfile: {
        status: "STALE",
        canonicalSlug: "current-course-fairfield-ct",
        course: { isPublic: true }
      }
    } as never);

    expect(await getPublishedCourseProfile("old-course-fairfield-ct")).toMatchObject({
      redirectSlug: "current-course-fairfield-ct"
    });
  });

  it("hides a stale profile after the course is no longer public", async () => {
    mockedPrisma.courseProfile.findFirst.mockResolvedValue(null);

    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue({
      courseProfile: {
        status: "STALE",
        canonicalSlug: "current-course-fairfield-ct",
        course: { isPublic: false }
      }
    } as never);
    expect(await getPublishedCourseProfile("old-course-fairfield-ct")).toBeNull();
  });

  it("creates a collision-checked redirect alias only with an explicit apply", async () => {
    mockedPrisma.courseProfile.findUnique
      .mockResolvedValueOnce({ id: "profile-1", canonicalSlug: "current-course-url" } as never)
      .mockResolvedValueOnce(null);
    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue(null);
    mockedPrisma.courseProfileSlugAlias.create.mockResolvedValue({ id: "alias-1" } as never);

    expect(await createCourseProfileSlugAlias("course-1", "retired-course-url", true)).toEqual({
      mode: "applied",
      valid: true,
      errors: [],
      slug: "retired-course-url"
    });
    expect(mockedPrisma.courseProfileSlugAlias.create).toHaveBeenCalledWith({
      data: { courseProfileId: "profile-1", slug: "retired-course-url" }
    });
  });

  it("allows a clearly blocked public course to publish an honest limitation page", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "blocked-course",
      name: "Phone Only Golf Course",
      isPublic: true,
      automationEligibility: "BLOCKED",
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);

    expect(await applyCourseProfileDraft(validDraft("blocked-course"))).toMatchObject({
      mode: "dry-run",
      valid: true,
      canonicalSlug: "phone-only-golf-course-example-ct"
    });
  });

  it("keeps an existing canonical slug immutable when location copy changes", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "existing-course",
      name: "Existing Golf Course",
      isPublic: true,
      automationEligibility: "ALLOWED",
      profile: { canonicalSlug: "original-course-url", contentVersion: 2 }
    } as never);

    expect(await applyCourseProfileDraft(validDraft("existing-course"))).toMatchObject({
      mode: "dry-run",
      valid: true,
      canonicalSlug: "original-course-url"
    });
  });

  it("never fails alert creation when post-response queueing cannot reach profile storage", async () => {
    mockedPrisma.course.findUnique.mockRejectedValue(new Error("profile storage unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(queuePendingCourseProfiles(["course-1"])).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "Course profile queueing failed for 1 course",
      ["profile storage unavailable"]
    );
    warning.mockRestore();
  });

  it("prefers nearby supported profiles and falls back only within the same state", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      candidate("near", 41.01, -73.01, "CT"),
      candidate("same-state", 42, -73, "CT"),
      candidate("other-state", 42, -73, "MA")
    ] as never);

    const related = await getRelatedSupportedCourses({
      id: "origin",
      latitude: 41,
      longitude: -73,
      stateCode: "CT"
    });

    expect(related.map((course) => course.id)).toEqual(["near", "same-state"]);
  });
});

function candidate(id: string, latitude: number, longitude: number, stateCode: string) {
  return {
    id,
    name: id,
    city: "Example",
    stateCode,
    latitude,
    longitude,
    profile: { canonicalSlug: `${id}-example-${stateCode.toLowerCase()}` }
  };
}

function validDraft(courseId: string) {
  return {
    courseId,
    location: {
      city: "Example",
      stateCode: "CT",
      stateName: "Connecticut",
      county: "Fairfield",
      countryCode: "US"
    },
    courseType: "DAILY_FEE",
    accessSummary: "A verified public course with daily access.",
    overview: "This public course provides a full golf round in Example, Connecticut.",
    courseCharacter: "The layout combines varied holes with an approachable public booking experience.",
    notableFacts: [],
    profileVerifiedAt: "2026-07-15T12:00:00.000Z",
    sources: [{
      url: "https://example.com/course",
      title: "Official course page",
      publisher: "Example Golf",
      sourceType: "OFFICIAL_COURSE",
      claimKeys: ["access", "course_type", "overview", "course_character"],
      evidenceSummary: "The official page supports public access, course type, overview, and layout character.",
      accessedAt: "2026-07-15T12:00:00.000Z"
    }]
  };
}
