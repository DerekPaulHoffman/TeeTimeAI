import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { courseSelectionKey } from "./shared-facility";
import { readSharedFacilityScope } from "./shared-facility-scope";
import { loadSharedFacilityCourses } from "./shared-facility-store";

vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: vi.fn() } } }));
const scope = { rootCourseId: "knolls", courseIds: ["knolls", "glen"] };
const root = { id: "knolls", name: "Tashua Knolls", googlePlaceId: "facility-place", isPublic: true,
  latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", layoutHoleCounts: [18],
  layoutHolesVerifiedAt: new Date("2026-10-28"), bookingMetadata: { sharedFacility: scope },
  detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes" } as Course;
const child = { ...root, id: "glen", name: "Tashua Glen", googlePlaceId: null, layoutHoleCounts: [9],
  detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017/6463#/teetimes" };

beforeEach(() => vi.clearAllMocks());
describe("shared facility course boundaries", () => {
  it("keeps physical layouts, ids, and booking links separate without inheriting monitoring claims", async () => {
    vi.mocked(prisma.course.findMany).mockResolvedValue([child, root]);
    const members = await loadSharedFacilityCourses(root);
    expect(members.map(course => [course.courseId, course.layoutHoleCounts])).toEqual([["knolls", [18]], ["glen", [9]]]);
    expect(new Set(members.map(courseSelectionKey)).size).toBe(2);
    expect(members[0].website).not.toBe(members[1].website);
    expect(members.every(course => course.monitoringReadiness === undefined && course.priceEstimate === undefined)).toBe(true);
  });
  it.each(["missing", "private", "conflicting"])("fails closed for %s members", async mode => {
    vi.mocked(prisma.course.findMany).mockResolvedValue(mode === "missing" ? [root] : [root,
      { ...child, ...(mode === "private" ? { isPublic: false } : { bookingMetadata: { sharedFacility: { ...scope, rootCourseId: "glen" } } }) }]);
    expect(await loadSharedFacilityCourses(root)).toEqual([]);
  });
  it("does not query a database or infer membership without an explicit stored manifest", async () => {
    expect(await loadSharedFacilityCourses({ ...root, bookingMetadata: {} })).toEqual([]);
    expect(prisma.course.findMany).not.toHaveBeenCalled();
    expect(readSharedFacilityScope({ sharedFacility: scope }, "foreign")).toBeNull();
    expect(readSharedFacilityScope({ sharedFacility: { ...scope, courseIds: ["knolls", "knolls"] } }, "knolls")).toBeNull();
  });
});
