import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GooglePlaceReviewsUnavailableError } from "@/lib/places/google-place-reviews";

import { GET } from "./route";
import { courseDataSuccessCacheHeaders } from "@/lib/places/course-data-cache";

const mocks = vi.hoisted(() => ({
  cacheCourseCandidatePhotos: vi.fn(),
  enrichCoursesWithAlertSupport: vi.fn(),
  enrichCoursesWithHoleLayouts: vi.fn(),
  enrichCoursesWithBookingEvidence: vi.fn(),
  findPersistedNearbyCourseCandidates: vi.fn(),
  getCourseDiscoveryCacheKey: vi.fn(),
  loadActiveGooglePlaceReviewIndex: vi.fn(),
  readCourseRuntimeCache: vi.fn(),
  searchNearbyGolfCourses: vi.fn(),
  writeCourseRuntimeCache: vi.fn()
}));

vi.mock("@/lib/places/course-photo-metadata", () => ({
  cacheCourseCandidatePhotos: mocks.cacheCourseCandidatePhotos
}));

vi.mock("@/lib/places/alert-support", () => ({
  enrichCoursesWithAlertSupport: mocks.enrichCoursesWithAlertSupport
}));

vi.mock("@/lib/places/hole-layout-enrichment", () => ({
  enrichCoursesWithHoleLayouts: mocks.enrichCoursesWithHoleLayouts
}));

vi.mock("@/lib/pricing/course-price-enrichment", () => ({
  enrichCoursesWithBookingEvidence: mocks.enrichCoursesWithBookingEvidence
}));

vi.mock("@/lib/places/google", () => ({
  searchNearbyGolfCourses: mocks.searchNearbyGolfCourses
}));

vi.mock("@/lib/places/google-place-reviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/places/google-place-reviews")>();
  return {
    ...actual,
    loadActiveGooglePlaceReviewIndex: mocks.loadActiveGooglePlaceReviewIndex
  };
});

vi.mock("@/lib/places/course-runtime-cache", () => ({
  getCourseDiscoveryCacheKey: mocks.getCourseDiscoveryCacheKey,
  readCourseRuntimeCache: mocks.readCourseRuntimeCache,
  writeCourseRuntimeCache: mocks.writeCourseRuntimeCache
}));

vi.mock("@/lib/places/persisted-course-fallback", () => ({
  findPersistedNearbyCourseCandidates: mocks.findPersistedNearbyCourseCandidates
}));

const originalEnv = {
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
  VERCEL_ENV: process.env.VERCEL_ENV
};

const testReviewIndex = {
  byPlaceId: new Map(),
  verifiedPublicCourses: [],
  reviewVersion: "reviews-1"
};

describe("GET /api/courses/discover provider configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.VERCEL_ENV;
    mocks.enrichCoursesWithAlertSupport.mockImplementation(async (courses) => courses);
    mocks.cacheCourseCandidatePhotos.mockResolvedValue(undefined);
    mocks.enrichCoursesWithHoleLayouts.mockImplementation(async (courses) => courses);
    mocks.enrichCoursesWithBookingEvidence.mockImplementation(async (courses) => courses);
    mocks.findPersistedNearbyCourseCandidates.mockResolvedValue([]);
    mocks.getCourseDiscoveryCacheKey.mockReturnValue("discover-key");
    mocks.loadActiveGooglePlaceReviewIndex.mockResolvedValue(testReviewIndex);
    mocks.readCourseRuntimeCache.mockResolvedValue(null);
    mocks.writeCourseRuntimeCache.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreEnv("GOOGLE_PLACES_API_KEY", originalEnv.GOOGLE_PLACES_API_KEY);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
  });

  it("returns a generic 503 when Google Places is missing in Vercel production", async () => {
    process.env.VERCEL_ENV = "production";

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't load nearby courses right now. Please wait a moment and try again."
    });
    expect(mocks.searchNearbyGolfCourses).not.toHaveBeenCalled();
    expect(mocks.cacheCourseCandidatePhotos).not.toHaveBeenCalled();
  });

  it("preserves demo discovery for Vercel preview smoke tests", async () => {
    process.env.VERCEL_ENV = "preview";

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.demo).toBe(true);
    expect(body.courses.length).toBeGreaterThan(0);
    expect(mocks.searchNearbyGolfCourses).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when durable place reviews cannot be read", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    mocks.readCourseRuntimeCache.mockResolvedValue([
      { googlePlaceId: "stale-course", name: "Stale Cached Course" }
    ]);
    mocks.loadActiveGooglePlaceReviewIndex.mockRejectedValue(
      new GooglePlaceReviewsUnavailableError(new Error("database unavailable"))
    );

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't load nearby courses right now. Please wait a moment and try again."
    });
    expect(mocks.readCourseRuntimeCache).not.toHaveBeenCalled();
    expect(mocks.searchNearbyGolfCourses).not.toHaveBeenCalled();
  });

  it("returns an actionable generic 503 after provider retries and persisted fallback are exhausted", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    mocks.searchNearbyGolfCourses.mockRejectedValue(
      new Error("Google Places nearby search failed with 429")
    );

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't load nearby courses right now. Please wait a moment and try again."
    });
  });

  it("shares successful course discovery while keeping provider failures uncached", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    mocks.searchNearbyGolfCourses.mockResolvedValue([
      { googlePlaceId: "course-1", name: "Public Course" }
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      courseDataSuccessCacheHeaders["Cache-Control"]
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      courseDataSuccessCacheHeaders["Vercel-CDN-Cache-Control"]
    );
    expect(mocks.getCourseDiscoveryCacheKey).toHaveBeenCalledWith({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 24140,
      reviewVersion: "reviews-1"
    });
    expect(mocks.searchNearbyGolfCourses).toHaveBeenCalledWith(
      {
        latitude: 41.242,
        longitude: -73.209,
        radiusMeters: 24140,
        signal: expect.any(AbortSignal)
      },
      testReviewIndex
    );
  });

  it("loads reviews before serving runtime-cached discovery", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    mocks.readCourseRuntimeCache.mockResolvedValue([
      { googlePlaceId: "course-1", name: "Cached Public Course" }
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [{ googlePlaceId: "course-1", name: "Cached Public Course" }],
      demo: false
    });
    expect(mocks.searchNearbyGolfCourses).not.toHaveBeenCalled();
    expect(mocks.loadActiveGooglePlaceReviewIndex.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readCourseRuntimeCache.mock.invocationCallOrder[0]
    );
    expect(mocks.cacheCourseCandidatePhotos).toHaveBeenCalledWith([
      { googlePlaceId: "course-1", name: "Cached Public Course" }
    ]);
  });

  it("returns known persisted courses when the Google quota is exhausted", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    mocks.searchNearbyGolfCourses.mockRejectedValue(
      new Error("Google Places nearby search failed with 429")
    );
    mocks.findPersistedNearbyCourseCandidates.mockResolvedValue([
      { googlePlaceId: "course-1", name: "Known Public Course" }
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [{ googlePlaceId: "course-1", name: "Known Public Course" }],
      demo: false
    });
    expect(mocks.findPersistedNearbyCourseCandidates).toHaveBeenCalledWith(
      {
        latitude: 41.242,
        longitude: -73.209,
        radiusMeters: 24140
      },
      testReviewIndex
    );
    expect(mocks.writeCourseRuntimeCache).toHaveBeenCalledWith(
      "discover-key",
      [expect.objectContaining({ googlePlaceId: "course-1" })],
      "course-discovery"
    );
  });
});

function request() {
  return new NextRequest(
    "http://localhost/api/courses/discover?latitude=41.242&longitude=-73.209&radiusMeters=24140"
  );
}

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
