import { afterEach, describe, expect, it, vi } from "vitest";

import { geocodeLocation, LocationNotFoundError } from "./geocode";

const originalKey = process.env.GOOGLE_PLACES_API_KEY;

describe("Google Places text geocoding", () => {
  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_PLACES_API_KEY;
    } else {
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
    vi.unstubAllGlobals();
  });

  it("returns demo coordinates until Google Places is configured", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;

    await expect(geocodeLocation("Trumbull, CT")).resolves.toEqual({
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    });
  });

  it("maps the first Places text-search location to coordinates", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF test-key ";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            id: "places/trumbull",
            displayName: { text: "Trumbull" },
            formattedAddress: "Trumbull, CT 06611",
            location: {
              latitude: 41.2428563,
              longitude: -73.2006639
            }
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeLocation("Trumbull, CT")).resolves.toEqual({
      latitude: 41.2428563,
      longitude: -73.2006639,
      demo: false
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Goog-Api-Key": "test-key",
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
        }),
        body: JSON.stringify({
          textQuery: "Trumbull, CT",
          maxResultCount: 1,
          regionCode: "US"
        })
      })
    );
  });

  it("rejects text-search responses without a location", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ places: [{ id: "places/empty" }] })
      }))
    );

    const error = await geocodeLocation("not a place").catch((reason) => reason);

    expect(error).toBeInstanceOf(LocationNotFoundError);
    expect(error).toHaveProperty("message", "No matching location found.");
  });
});
