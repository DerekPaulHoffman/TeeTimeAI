import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GooglePlaceReviewsUnavailableError } from "@/lib/places/google-place-reviews";

import { GET } from "./route";
import { courseDataSuccessCacheHeaders } from "@/lib/places/course-data-cache";

const mocks = vi.hoisted(() => ({
  cacheCourseCandidatePhotos: vi.fn(),
  enrichCoursesWithAlertSupport: vi.fn(),
  enrichCoursesWithHoleLayouts: vi.fn(),
  findPersistedCourseCandidatesByName: vi.fn(),
  getGooglePlacesApiKey: vi.fn(),
  readCourseRuntimeCache: vi.fn(),
  searchGolfCoursesByName: vi.fn(),
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

vi.mock("@/lib/places/google", () => ({
  getGooglePlacesApiKey: mocks.getGooglePlacesApiKey,
  searchGolfCoursesByName: mocks.searchGolfCoursesByName
}));

vi.mock("@/lib/places/course-runtime-cache", () => ({
  getCourseLookupCacheKey: vi.fn(() => "lookup-key"),
  readCourseRuntimeCache: mocks.readCourseRuntimeCache,
  writeCourseRuntimeCache: mocks.writeCourseRuntimeCache
}));

vi.mock("@/lib/places/persisted-course-fallback", () => ({
  findPersistedCourseCandidatesByName: mocks.findPersistedCourseCandidatesByName
}));

describe("GET /api/courses/lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGooglePlacesApiKey.mockReturnValue("test-key");
    mocks.cacheCourseCandidatePhotos.mockResolvedValue(undefined);
    mocks.findPersistedCourseCandidatesByName.mockResolvedValue([]);
    mocks.readCourseRuntimeCache.mockResolvedValue(null);
    mocks.writeCourseRuntimeCache.mockResolvedValue(undefined);
    mocks.enrichCoursesWithAlertSupport.mockImplementation(async (courses) => courses);
    mocks.enrichCoursesWithHoleLayouts.mockImplementation(async (courses) =>
      courses.map((course: object) => ({
        ...course,
        layoutHolesStatus: "UNVERIFIED"
      }))
    );
  });

  it("returns matching course candidates with optional location context", async () => {
    mocks.searchGolfCoursesByName.mockResolvedValue([
      {
        googlePlaceId: "bethpage-black",
        name: "Bethpage Black Course",
        latitude: 40.744,
        longitude: -73.456
      }
    ]);

    const response = await GET(
      request("?q=Bethpage%20Black&latitude=40.73&longitude=-73.44")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      courses: [
        expect.objectContaining({
          googlePlaceId: "bethpage-black",
          name: "Bethpage Black Course",
          layoutHolesStatus: "UNVERIFIED"
        })
      ]
    });
    expect(mocks.searchGolfCoursesByName).toHaveBeenCalledWith({
      query: "Bethpage Black",
      latitude: 40.73,
      longitude: -73.44
    });
    expect(mocks.enrichCoursesWithAlertSupport).toHaveBeenCalledWith([
      expect.objectContaining({ googlePlaceId: "bethpage-black" })
    ]);
    expect(mocks.enrichCoursesWithHoleLayouts).toHaveBeenCalledWith([
      expect.objectContaining({ googlePlaceId: "bethpage-black" })
    ]);
    expect(response.headers.get("cache-control")).toBe(
      courseDataSuccessCacheHeaders["Cache-Control"]
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      courseDataSuccessCacheHeaders["Vercel-CDN-Cache-Control"]
    );
  });

  it("rejects short queries and incomplete coordinates", async () => {
    const shortResponse = await GET(request("?q=B"));
    const incompleteLocationResponse = await GET(
      request("?q=Bethpage%20Black&latitude=40.73")
    );

    expect(shortResponse.status).toBe(400);
    expect(incompleteLocationResponse.status).toBe(400);
    expect(mocks.searchGolfCoursesByName).not.toHaveBeenCalled();
    expect(mocks.cacheCourseCandidatePhotos).not.toHaveBeenCalled();
  });

  it("returns a useful temporary-unavailable response without a provider key", async () => {
    mocks.getGooglePlacesApiKey.mockReturnValue(undefined);

    const response = await GET(request("?q=Bethpage%20Black"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Course lookup is temporarily unavailable. Try the nearby search instead."
    });
  });

  it("serves year-cached lookup results without another Google search", async () => {
    mocks.readCourseRuntimeCache.mockResolvedValue([
      { googlePlaceId: "bethpage-black", name: "Bethpage Black Course" }
    ]);

    const response = await GET(request("?q=Bethpage%20Black"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [{ googlePlaceId: "bethpage-black", name: "Bethpage Black Course" }]
    });
    expect(mocks.searchGolfCoursesByName).not.toHaveBeenCalled();
    expect(mocks.cacheCourseCandidatePhotos).toHaveBeenCalledWith([
      { googlePlaceId: "bethpage-black", name: "Bethpage Black Course" }
    ]);
  });

  it("returns known persisted courses when the Google quota is exhausted", async () => {
    mocks.searchGolfCoursesByName.mockRejectedValue(
      new Error("Google Places course search failed with 429")
    );
    mocks.findPersistedCourseCandidatesByName.mockResolvedValue([
      { googlePlaceId: "bethpage-black", name: "Bethpage Black Course" }
    ]);

    const response = await GET(request("?q=Bethpage%20Black"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [
        {
          googlePlaceId: "bethpage-black",
          name: "Bethpage Black Course",
          layoutHolesStatus: "UNVERIFIED"
        }
      ]
    });
    expect(mocks.writeCourseRuntimeCache).toHaveBeenCalledWith(
      "lookup-key",
      [expect.objectContaining({ googlePlaceId: "bethpage-black" })],
      "course-lookup"
    );
  });

  it("returns a generic 503 when durable place reviews cannot be read", async () => {
    mocks.searchGolfCoursesByName.mockRejectedValue(
      new GooglePlaceReviewsUnavailableError(new Error("database unavailable"))
    );

    const response = await GET(request("?q=Bethpage%20Black"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Course lookup is temporarily unavailable. Try again in a moment."
    });
  });
});

function request(search = "") {
  return new NextRequest(`http://localhost/api/courses/lookup${search}`);
}
