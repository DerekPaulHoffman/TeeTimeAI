import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterPersistedCoursesByPlaceReviews,
  findPersistedCourseCandidatesByName,
  findPersistedNearbyCourseCandidates
} from "@/lib/places/persisted-course-fallback";
import {
  buildGooglePlaceReviewIndex,
  type GooglePlaceReviewRecord
} from "@/lib/places/google-place-reviews";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn()
}));

const emptyReviewIndex = buildGooglePlaceReviewIndex([]);

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

    const courses = await findPersistedNearbyCourseCandidates(
      {
        latitude: 41.242,
        longitude: -73.209,
        radiusMeters: 24_140
      },
      emptyReviewIndex
    );

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
      "Bethpage Black, Farmingdale",
      emptyReviewIndex
    );

    expect(courses).toHaveLength(1);
    expect(courses[0]?.name).toBe("Bethpage Black Golf Course");
  });

  it("excludes exact and canonical identities blocked by active reviews", () => {
    const reviewIndex = buildGooglePlaceReviewIndex([
      placeReview({
        googlePlaceId: "private-place",
        accessOverride: "VERIFIED_PRIVATE"
      }),
      placeReview({
        googlePlaceId: "alias-place",
        canonicalPlaceId: "canonical-non-course"
      }),
      placeReview({
        googlePlaceId: "canonical-non-course",
        accessOverride: "VERIFIED_NON_COURSE"
      })
    ]);

    const courses = filterPersistedCoursesByPlaceReviews(
      [
        { googlePlaceId: "public-place", name: "Public Course" },
        { googlePlaceId: "private-place", name: "Private Course" },
        { googlePlaceId: "alias-place", name: "Non-course Alias" }
      ],
      reviewIndex
    );

    expect(courses).toEqual([{ googlePlaceId: "public-place", name: "Public Course" }]);
  });

  it("applies the active review filter before persisted name results are returned", async () => {
    mocks.findMany.mockResolvedValue([
      persistedCourse({ googlePlaceId: "blocked-place", name: "Blocked Pine Golf Course" }),
      persistedCourse({ googlePlaceId: "public-place", name: "Public Pine Golf Course" })
    ]);
    const reviewIndex = buildGooglePlaceReviewIndex([
      placeReview({
        googlePlaceId: "blocked-place",
        accessOverride: "VERIFIED_NON_COURSE"
      })
    ]);

    const courses = await findPersistedCourseCandidatesByName("Pine", reviewIndex);

    expect(courses.map((course) => course.googlePlaceId)).toEqual(["public-place"]);
  });
});

function placeReview(
  overrides: Partial<GooglePlaceReviewRecord> & Pick<GooglePlaceReviewRecord, "googlePlaceId">
): GooglePlaceReviewRecord {
  return {
    googlePlaceId: overrides.googlePlaceId,
    accessOverride: null,
    name: "Reviewed Place",
    classification: "REVIEWED_PLACE",
    evidenceUrl: "https://example.com/review",
    reviewedAt: new Date("2026-08-11T00:00:00.000Z"),
    active: true,
    canonicalPlaceId: null,
    canonicalName: null,
    canonicalAddress: null,
    canonicalWebsiteUrl: null,
    canonicalPhone: null,
    latitude: null,
    longitude: null,
    retainWhenCanonicalAbsent: false,
    ...overrides
  };
}

function persistedCourse(overrides: Partial<ReturnType<typeof basePersistedCourse>> = {}) {
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
