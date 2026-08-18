import { afterEach, describe, expect, it, vi } from "vitest";

import { geocodeLocation, LocationNotFoundError } from "./geocode";

const originalKey = process.env.GOOGLE_PLACES_API_KEY;

describe("Google Geocoding API", () => {
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

  it("maps the first geocoding result to coordinates", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF test-key ";
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "OK",
        results: [
          {
            geometry: {
              location: {
                lat: 41.2428563,
                lng: -73.2006639
              }
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeLocation("Trumbull, CT")).resolves.toEqual({
      latitude: 41.2428563,
      longitude: -73.2006639,
      demo: false
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).origin + (url as URL).pathname).toBe(
      "https://maps.googleapis.com/maps/api/geocode/json"
    );
    expect((url as URL).searchParams.get("address")).toBe("Trumbull, CT");
    expect((url as URL).searchParams.get("region")).toBe("us");
    expect((url as URL).searchParams.get("key")).toBe("test-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects zero-result geocoding responses", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "ZERO_RESULTS", results: [] }))
    );

    const error = await geocodeLocation("not a place").catch((reason) => reason);

    expect(error).toBeInstanceOf(LocationNotFoundError);
    expect(error).toHaveProperty("message", "No matching location found.");
  });

  it("rejects provider-level quota errors returned with HTTP 200", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "OVER_QUERY_LIMIT", results: [] }))
    );

    await expect(geocodeLocation("Seattle, WA")).rejects.toThrow(
      "Google Geocoding request failed with OVER_QUERY_LIMIT"
    );
  });

  it("retries one transient rate limit before returning coordinates", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "0" }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "OK",
          results: [
            {
              geometry: {
                location: {
                  lat: 43.615,
                  lng: -116.2023
                }
              }
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeLocation("83702")).resolves.toEqual({
      latitude: 43.615,
      longitude: -116.2023,
      demo: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
