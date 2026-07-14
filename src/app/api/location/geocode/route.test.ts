import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/places/geocode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/places/geocode")>();
  return {
    ...actual,
    geocodeLocation: vi.fn()
  };
});

import { geocodeLocation, LocationNotFoundError } from "@/lib/places/geocode";

import { GET, geocodeSuccessCacheHeaders, getGeocodeErrorResponse } from "./route";

const mockedGeocodeLocation = vi.mocked(geocodeLocation);

describe("geocode API errors", () => {
  beforeEach(() => {
    mockedGeocodeLocation.mockReset();
  });

  it("caches successful visitor-invariant geocodes only at Vercel's edge", async () => {
    mockedGeocodeLocation.mockResolvedValue({
      latitude: 46.7964299,
      longitude: -88.5243087,
      demo: false
    });

    const response = await GET(
      new NextRequest("https://teetimespot.com/api/location/geocode?q=49908")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      geocodeSuccessCacheHeaders["Cache-Control"]
    );
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe(
      geocodeSuccessCacheHeaders["Vercel-CDN-Cache-Control"]
    );
    await expect(response.json()).resolves.toEqual({
      latitude: 46.7964299,
      longitude: -88.5243087,
      demo: false
    });
  });

  it("does not cache invalid-location responses at Vercel's edge", async () => {
    mockedGeocodeLocation.mockRejectedValue(new LocationNotFoundError());

    const response = await GET(
      new NextRequest("https://teetimespot.com/api/location/geocode?q=not-a-place")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
  });

  it("treats an unmatched location as a correctable client error", () => {
    expect(getGeocodeErrorResponse(new LocationNotFoundError())).toEqual({
      message:
        "We couldn't find that location. Check the city, state, or ZIP code and try again.",
      status: 404
    });
  });

  it("keeps provider failures distinct from invalid user input", () => {
    expect(getGeocodeErrorResponse(new Error("Google Places text search failed with 503"))).toEqual({
      message: "Google Places text search failed with 503",
      status: 502
    });
  });
});
