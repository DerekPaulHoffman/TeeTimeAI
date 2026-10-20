import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGooglePlacePhoto } from "@/lib/places/google";
import { fetchGooglePlacesWithRetry } from "./google-places-request";

const mocks = vi.hoisted(() => ({
  cacheGooglePlacePhoto: vi.fn(),
  readCachedGooglePlacePhoto: vi.fn()
}));

vi.mock("@/lib/places/course-photo-metadata", async (original) => ({
  ...await original<typeof import("./course-photo-metadata")>(),
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

  it("does not retry decorative 429s or apply their cooldown to critical requests", async () => {
    const previousKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "confirmed" }));
    try {
      expect(await getGooglePlacePhoto("optional-rate-limited")).toBeNull();
      expect(await getGooglePlacePhoto("different-optional-photo")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const critical = await fetchGooglePlacesWithRetry("https://example.test/essential-place-details");
      expect(critical.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      if (previousKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
      else process.env.GOOGLE_PLACES_API_KEY = previousKey;
      fetchMock.mockRestore();
    }
  });
});
