import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCourseDiscoveryCacheKey,
  getCourseLookupCacheKey,
  getCoursePhotoMetadataCacheKey,
  readCourseRuntimeCache,
  writeCourseRuntimeCache
} from "@/lib/places/course-runtime-cache";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn()
}));

vi.mock("@vercel/functions", () => ({
  getCache: vi.fn(() => ({
    get: mocks.get,
    set: mocks.set
  }))
}));

const originalVercelEnv = process.env.VERCEL_ENV;

describe("course runtime cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_ENV = "production";
  });

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it("reuses values and writes them with a one-year lifetime", async () => {
    const courses = [{ googlePlaceId: "course-1" }];
    mocks.get.mockResolvedValue(courses);

    await expect(readCourseRuntimeCache("discover-v1:test")).resolves.toBe(courses);
    await writeCourseRuntimeCache("discover-v1:test", courses, "course-discovery");

    expect(mocks.set).toHaveBeenCalledWith("discover-v1:test", courses, {
      name: "course-discovery",
      tags: ["course-discovery"],
      ttl: 31_536_000
    });
  });

  it("groups nearby coordinates and normalized lookup text into stable keys", () => {
    expect(
      getCourseDiscoveryCacheKey({
        latitude: 41.24241,
        longitude: -73.20851,
        radiusMeters: 24140
      })
    ).toBe("discover-v1:41.242:-73.209:24140");
    expect(getCourseLookupCacheKey({ query: "  Bethpage   BLACK " })).toBe(
      "lookup-v1:bethpage black:none:none"
    );
    expect(getCoursePhotoMetadataCacheKey(" course-1 ")).toBe(
      "photo-metadata-v1:course-1"
    );
  });
});
