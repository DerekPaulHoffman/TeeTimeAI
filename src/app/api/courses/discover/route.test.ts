import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GooglePlaceReviewsUnavailableError } from "@/lib/places/google-place-reviews";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  enrichCoursesWithAlertSupport: vi.fn(),
  enrichCoursesWithHoleLayouts: vi.fn(),
  enrichCoursesWithPriceEstimates: vi.fn(),
  searchNearbyGolfCourses: vi.fn()
}));

vi.mock("@/lib/places/alert-support", () => ({
  enrichCoursesWithAlertSupport: mocks.enrichCoursesWithAlertSupport
}));

vi.mock("@/lib/places/hole-layout-enrichment", () => ({
  enrichCoursesWithHoleLayouts: mocks.enrichCoursesWithHoleLayouts
}));

vi.mock("@/lib/pricing/course-price-enrichment", () => ({
  enrichCoursesWithPriceEstimates: mocks.enrichCoursesWithPriceEstimates
}));

vi.mock("@/lib/places/google", () => ({
  searchNearbyGolfCourses: mocks.searchNearbyGolfCourses
}));

const originalEnv = {
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
  VERCEL_ENV: process.env.VERCEL_ENV
};

describe("GET /api/courses/discover provider configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.VERCEL_ENV;
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
      error: "Course discovery is temporarily unavailable. Try again in a moment."
    });
    expect(mocks.searchNearbyGolfCourses).not.toHaveBeenCalled();
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
    mocks.searchNearbyGolfCourses.mockRejectedValue(
      new GooglePlaceReviewsUnavailableError(new Error("database unavailable"))
    );

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Course discovery is temporarily unavailable. Try again in a moment."
    });
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
