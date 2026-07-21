import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseProfile: { findMany: vi.fn() },
    course: { findMany: vi.fn() }
  }
}));

import sitemap from "./sitemap";

describe("sitemap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists static routes, public current or stale profiles, and only qualified locations", async () => {
    vi.mocked(prisma.courseProfile.findMany).mockResolvedValue([
      { canonicalSlug: "tashua-knolls-golf-course-trumbull-ct", updatedAt: new Date("2026-07-15T12:00:00Z") }
    ] as never);
    vi.mocked(prisma.course.findMany)
      .mockResolvedValueOnce(qualifiedCourses() as never)
      .mockResolvedValueOnce(qualifiedCourses() as never)
      .mockResolvedValueOnce([] as never);

    const result = await sitemap();

    expect(prisma.courseProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: { in: ["PUBLISHED", "STALE"] },
        course: { isPublic: true }
      }
    }));

    expect(result).toEqual([
      { url: "https://teetimespot.com/" },
      { url: "https://teetimespot.com/search" },
      { url: "https://teetimespot.com/how-it-works" },
      { url: "https://teetimespot.com/about" },
      { url: "https://teetimespot.com/methodology" },
      { url: "https://teetimespot.com/guides" },
      { url: "https://teetimespot.com/guides/tee-time-cancellation-alerts" },
      { url: "https://teetimespot.com/guides/public-golf-booking-windows" },
      { url: "https://teetimespot.com/guides/tee-time-alerts-vs-auto-booking" },
      { url: "https://teetimespot.com/contact" },
      { url: "https://teetimespot.com/privacy" },
      { url: "https://teetimespot.com/terms" },
      { url: "https://teetimespot.com/courses/tashua-knolls-golf-course-trumbull-ct", lastModified: new Date("2026-07-15T12:00:00Z") },
      { url: "https://teetimespot.com/locations/connecticut", lastModified: new Date("2026-07-15T12:00:00Z") },
      { url: "https://teetimespot.com/locations/connecticut/fairfield-county", lastModified: new Date("2026-07-15T12:00:00Z") }
    ]);
  });
});

function qualifiedCourses() {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `course-${index}`,
    name: `Course ${index}`,
    city: "Trumbull",
    stateCode: "CT",
    automationEligibility: "ALLOWED",
    bookingWindowDaysAhead: null,
    bookingReleaseTimeLocal: null,
    bookingWindowEvidenceUrl: null,
    bookingWindowCheckedAt: null,
    profile: {
      canonicalSlug: `course-${index}-trumbull-ct`,
      accessSummary: "Public course.",
      profileVerifiedAt: new Date("2026-07-15T12:00:00Z"),
      updatedAt: new Date("2026-07-15T12:00:00Z")
    }
  }));
}
