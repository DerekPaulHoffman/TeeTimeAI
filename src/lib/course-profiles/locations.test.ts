import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  getLocationHub,
  loadQualifiedLocationHub,
  LOCATION_HUB_MINIMUM_COURSES
} from "./locations";

vi.mock("@/lib/prisma", () => ({
  prisma: { course: { findMany: vi.fn() } }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("location hub registry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows only the three intentionally registered Connecticut routes", () => {
    expect(getLocationHub(["connecticut"])?.path).toBe("/locations/connecticut");
    expect(getLocationHub(["connecticut", "fairfield-county"])?.county).toBe("Fairfield");
    expect(getLocationHub(["connecticut", "new-haven-county"])?.county).toBe("New Haven");
    expect(getLocationHub(["connecticut", "hartford-county"])).toBeNull();
    expect(getLocationHub(["new-york"])).toBeNull();
  });

  it("keeps a registered hub unpublished below five supported profiles", async () => {
    mockedPrisma.course.findMany.mockResolvedValue(makeCourses(LOCATION_HUB_MINIMUM_COURSES - 1) as never);
    const hub = getLocationHub(["connecticut", "fairfield-county"]);
    expect(hub && await loadQualifiedLocationHub(hub)).toBeNull();
  });

  it("publishes a registered hub at five supported current or stale profiles and uses the oldest included verification date", async () => {
    mockedPrisma.course.findMany.mockResolvedValue(makeCourses(LOCATION_HUB_MINIMUM_COURSES) as never);
    const hub = getLocationHub(["connecticut", "fairfield-county"]);
    const result = hub && await loadQualifiedLocationHub(hub);

    expect(result?.courses).toHaveLength(5);
    expect(result?.lastVerifiedAt?.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        stateCode: "CT",
        OR: [
          { county: "Fairfield" },
          { city: { in: expect.arrayContaining(["Fairfield", "Trumbull"]) } }
        ],
        automationEligibility: "ALLOWED",
        profile: { status: { in: ["PUBLISHED", "STALE"] } }
      })
    }));
  });
});

function makeCourses(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `course-${index}`,
    name: `Course ${index}`,
    city: "Fairfield",
    stateCode: "CT",
    automationEligibility: "ALLOWED",
    bookingWindowDaysAhead: index === 0 ? 7 : null,
    bookingReleaseTimeLocal: index === 0 ? "00:00" : null,
    bookingWindowEvidenceUrl: index === 0 ? "https://example.com/booking-policy" : null,
    bookingWindowCheckedAt: index === 0 ? new Date("2026-07-15T00:00:00.000Z") : null,
    profile: {
      canonicalSlug: `course-${index}-fairfield-ct`,
      accessSummary: "A verified public course.",
      profileVerifiedAt: new Date(index === 0 ? "2026-07-15T00:00:00.000Z" : "2026-07-14T00:00:00.000Z"),
      updatedAt: new Date("2026-07-15T00:00:00.000Z")
    }
  }));
}
