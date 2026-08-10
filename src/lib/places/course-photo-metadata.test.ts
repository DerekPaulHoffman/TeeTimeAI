import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheCourseCandidatePhotos,
  cacheGooglePlacePhoto,
  readCachedGooglePlacePhoto
} from "@/lib/places/course-photo-metadata";

const mocks = vi.hoisted(() => ({
  readCourseRuntimeCache: vi.fn(),
  writeCourseRuntimeCache: vi.fn()
}));

vi.mock("@/lib/places/course-runtime-cache", () => ({
  getCoursePhotoMetadataCacheKey: vi.fn((googlePlaceId: string) =>
    `photo-metadata:${googlePlaceId}`
  ),
  readCourseRuntimeCache: mocks.readCourseRuntimeCache,
  writeCourseRuntimeCache: mocks.writeCourseRuntimeCache
}));

describe("course photo metadata cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCourseRuntimeCache.mockResolvedValue(null);
    mocks.writeCourseRuntimeCache.mockResolvedValue(undefined);
  });

  it("reads a valid cached photo for a saved Google place", async () => {
    mocks.readCourseRuntimeCache.mockResolvedValue({
      photoReference: "places/course-1/photos/photo-1",
      authorAttributions: [{ displayName: "Course Photographer" }]
    });

    await expect(readCachedGooglePlacePhoto(" course-1 ")).resolves.toEqual({
      photoReference: "places/course-1/photos/photo-1",
      authorAttributions: [{ displayName: "Course Photographer" }]
    });
    expect(mocks.readCourseRuntimeCache).toHaveBeenCalledWith(
      "photo-metadata:course-1"
    );
  });

  it("indexes photos from cached search results by Google place ID", async () => {
    await cacheCourseCandidatePhotos([
      {
        googlePlaceId: "course-1",
        photoReference: "places/course-1/photos/photo-1",
        photoAttributions: [{ displayName: "Course Photographer" }]
      },
      { googlePlaceId: "course-without-photo", name: "No Photo Course" }
    ]);

    expect(mocks.writeCourseRuntimeCache).toHaveBeenCalledTimes(1);
    expect(mocks.writeCourseRuntimeCache).toHaveBeenCalledWith(
      "photo-metadata:course-1",
      {
        photoReference: "places/course-1/photos/photo-1",
        authorAttributions: [{ displayName: "Course Photographer" }]
      },
      "course-photo-metadata"
    );
  });

  it("rejects malformed photo references instead of caching them", async () => {
    await expect(
      cacheGooglePlacePhoto("course-1", {
        photoReference: "https://example.com/not-a-place-photo",
        authorAttributions: []
      })
    ).resolves.toBeNull();
    expect(mocks.writeCourseRuntimeCache).not.toHaveBeenCalled();
  });
});
