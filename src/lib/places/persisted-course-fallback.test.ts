import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  findPersistedCourseCandidatesByName,
  findPersistedNearbyCourseCandidates
} from "@/lib/places/persisted-course-fallback";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: {
      findMany: mocks.findMany
    }
  }
}));

describe("persisted course fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only persisted courses inside the requested radius", async () => {
    mocks.findMany.mockResolvedValue([
      persistedCourse({ name: "Nearby Golf Course", latitude: 41.25, longitude: -73.2 }),
      persistedCourse({
        id: "far-course",
        googlePlaceId: "far-place",
        name: "Far Golf Course",
        latitude: 42,
        longitude: -74
      })
    ]);

    const courses = await findPersistedNearbyCourseCandidates({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 24_140
    });

    expect(courses).toHaveLength(1);
    expect(courses[0]).toEqual(
      expect.objectContaining({
        googlePlaceId: "place-1",
        name: "Nearby Golf Course",
        distanceMeters: expect.any(Number)
      })
    );
  });

  it("matches persisted courses by normalized name and location terms", async () => {
    mocks.findMany.mockResolvedValue([
      persistedCourse({ name: "Bethpage Black Golf Course", city: "Farmingdale" }),
      persistedCourse({
        id: "other-course",
        googlePlaceId: "other-place",
        name: "Tashua Knolls Golf Course",
        city: "Trumbull"
      })
    ]);

    const courses = await findPersistedCourseCandidatesByName(
      "Bethpage Black, Farmingdale"
    );

    expect(courses).toHaveLength(1);
    expect(courses[0]?.name).toBe("Bethpage Black Golf Course");
  });
});

function persistedCourse(
  overrides: Partial<ReturnType<typeof basePersistedCourse>> = {}
) {
  return { ...basePersistedCourse(), ...overrides };
}

function basePersistedCourse() {
  return {
    id: "course-1",
    googlePlaceId: "place-1",
    name: "Public Golf Course",
    address: "1 Fairway Drive",
    city: "Trumbull",
    stateCode: "CT",
    stateName: "Connecticut",
    county: "Fairfield County",
    countryCode: "US",
    latitude: 41.242,
    longitude: -73.209,
    timeZone: "America/New_York",
    rating: 4.4,
    ratingObservedAt: new Date("2026-07-01T00:00:00.000Z"),
    website: "https://course.example",
    detectedBookingUrl: "https://book.course.example",
    phone: "+12035550100"
  };
}
