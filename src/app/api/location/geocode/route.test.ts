import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const originalEnv = {
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
  VERCEL_ENV: process.env.VERCEL_ENV
};

describe("geocode API errors", () => {
  beforeEach(() => {
    mockedGeocodeLocation.mockReset();
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    restoreEnv("GOOGLE_PLACES_API_KEY", originalEnv.GOOGLE_PLACES_API_KEY);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
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

  it("returns a generic 503 when Google Places is missing in Vercel production", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    process.env.VERCEL_ENV = "production";

    const response = await GET(
      new NextRequest("https://teetimespot.com/api/location/geocode?q=Trumbull%2C%20CT")
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Location search is temporarily unavailable. Try again in a moment."
    });
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
    expect(mockedGeocodeLocation).not.toHaveBeenCalled();
  });

  it("preserves demo geocoding for Vercel preview smoke tests", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    process.env.VERCEL_ENV = "preview";
    mockedGeocodeLocation.mockResolvedValue({
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    });

    const response = await GET(
      new NextRequest("https://preview.example/api/location/geocode?q=Trumbull%2C%20CT")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    });
  });
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
