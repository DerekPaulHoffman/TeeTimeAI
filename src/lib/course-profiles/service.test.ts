import { beforeEach, describe, expect, it, vi } from "vitest";

const monitoringMocks = vi.hoisted(() => ({
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction: vi.fn(),
  runSerializedCourseMonitoringWrite: vi.fn()
}));

vi.mock("@/lib/automation/course-monitoring", () => monitoringMocks);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    courseProfile: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn()
    },
    courseProfileSlugAlias: { create: vi.fn(), findUnique: vi.fn() },
    courseProfileSource: { createMany: vi.fn(), deleteMany: vi.fn() }
  }
}));

import { prisma } from "@/lib/prisma";
import {
  applyCourseProfileDraft,
  createCourseProfileSlugAlias,
  ensurePendingCourseProfile,
  getPublishedCourseProfile,
  getRelatedSupportedCourses,
  listPublishedDirectCourseProfiles,
  listCourseProfileLocationEnrichmentQueue,
  listCourseProfileQueue,
  queuePendingCourseProfiles
} from "./service";

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("course profile service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitoringMocks.runSerializedCourseMonitoringWrite.mockImplementation(
      async (_courseId, worker) => worker(mockedPrisma as never)
    );
    monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction.mockResolvedValue({
      outcome: "IMMATERIAL",
      changedFields: [],
      searchesQueued: 0
    });
  });

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

  it("lists public Course Guides without automatic alert support separately", async () => {
    mockedPrisma.courseProfile.findMany.mockResolvedValue([]);

    await listPublishedDirectCourseProfiles();

    expect(mockedPrisma.courseProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["PUBLISHED", "STALE"] },
          course: {
            isPublic: true,
            automationEligibility: { not: "ALLOWED" }
          }
        }
      })
    );
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

  it("publishes an official website change through serialized monitoring revalidation", async () => {
    const current = {
      id: "course-website",
      name: "Website Golf Course",
      website: "https://old.example.com/course",
      timeZone: "America/New_York",
      detectedBookingUrl: "https://booking.example.com/course",
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "PUBLIC_ONLINE",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      isPublic: true,
      intelligenceConfidence: 1,
      bookingMetadata: null,
      updatedAt: new Date("2026-08-17T12:00:00.000Z")
    };
    const applied = {
      ...current,
      website: "https://example.com/course",
      updatedAt: new Date("2026-08-18T12:00:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: current.id,
        name: current.name,
        isPublic: true,
        automationEligibility: "ALLOWED",
        profile: null
      } as never)
      .mockResolvedValueOnce(current as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    mockedPrisma.course.update.mockResolvedValue(applied as never);
    mockedPrisma.courseProfile.upsert.mockResolvedValue({
      id: "profile-website",
      canonicalSlug: "website-golf-course-example-ct"
    } as never);

    await expect(
      applyCourseProfileDraft({
        ...validDraft(current.id),
        officialWebsiteUrl: applied.website
      }, true)
    ).resolves.toMatchObject({
      mode: "applied",
      valid: true,
      courseId: current.id
    });

    expect(monitoringMocks.runSerializedCourseMonitoringWrite).toHaveBeenCalledWith(
      current.id,
      expect.any(Function)
    );
    expect(mockedPrisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: current.id, updatedAt: current.updatedAt },
        data: expect.objectContaining({ website: applied.website })
      })
    );
    expect(
      monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction
    ).toHaveBeenCalledWith(
      mockedPrisma,
      expect.objectContaining({
        courseId: current.id,
        before: current,
        after: applied,
        source: "OPERATOR_CLI",
        now: expect.any(Date)
      })
    );
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

  it("keeps previously published content stale after a failed refresh", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-1",
      name: "Existing Golf Course",
      city: "Fairfield",
      stateCode: "CT",
      profile: {
        canonicalSlug: "existing-golf-course-fairfield-ct",
        publishedAt: new Date("2026-07-01T12:00:00.000Z")
      }
    } as never);

    await applyCourseProfileDraft({ courseId: "course-1" }, true);

    expect(mockedPrisma.courseProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "STALE",
          failureReason: expect.any(String)
        })
      })
    );
  });

  it("serves the oldest profile maintenance work first", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      queuedCourse("newer", "2026-07-22T12:00:00.000Z"),
      queuedCourse("older", "2026-07-20T12:00:00.000Z")
    ] as never);

    const queue = await listCourseProfileQueue(2);

    expect(queue.map((course) => course.id)).toEqual(["older", "newer"]);
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          city: { not: null },
          stateCode: { not: null }
        })
      })
    );
  });

  it("keeps courses with missing city or state in a separate enrichment queue", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      { ...queuedCourse("missing-location", "2026-07-19T12:00:00.000Z"), city: null, profile: undefined }
    ] as never);

    const queue = await listCourseProfileLocationEnrichmentQueue(3);

    expect(queue[0]?.id).toBe("missing-location");
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profile: null,
          OR: [{ city: null }, { stateCode: null }]
        }),
        orderBy: { createdAt: "asc" }
      })
    );
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
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profile: { status: { in: ["PUBLISHED", "STALE"] } }
        })
      })
    );
  });
});

function queuedCourse(id: string, createdAt: string) {
  const date = new Date(createdAt);
  return {
    id,
    createdAt: date,
    name: id,
    city: "Example",
    stateCode: "CT",
    county: "Fairfield",
    website: `https://${id}.example.com`,
    detectedBookingUrl: null,
    automationEligibility: "ALLOWED",
    profile: {
      status: "PENDING",
      createdAt: date,
      reviewDueAt: null,
      failureReason: null
    }
  };
}

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
