import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGooglePlacePhoto } from "@/lib/places/google";

const mocks = vi.hoisted(() => ({
  cacheGooglePlacePhoto: vi.fn(),
  readCachedGooglePlacePhoto: vi.fn()
}));

vi.mock("@/lib/places/course-photo-metadata", () => ({
  cacheGooglePlacePhoto: mocks.cacheGooglePlacePhoto,
  readCachedGooglePlacePhoto: mocks.readCachedGooglePlacePhoto
}));

describe("Google place photo lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCachedGooglePlacePhoto.mockResolvedValue(null);
    mocks.cacheGooglePlacePhoto.mockImplementation(async (_googlePlaceId, photo) => photo);
  });

  it("uses cached search photo metadata without calling Google again", async () => {
    const cachedPhoto = {
      photoReference: "places/course-1/photos/photo-1",
      authorAttributions: [{ displayName: "Course Photographer" }]
    };
    mocks.readCachedGooglePlacePhoto.mockResolvedValue(cachedPhoto);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getGooglePlacePhoto("course-1")).resolves.toEqual(cachedPhoto);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
