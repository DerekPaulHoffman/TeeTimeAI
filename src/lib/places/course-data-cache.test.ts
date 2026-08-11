import { describe, expect, it } from "vitest";

import {
  courseDataSuccessCacheHeaders,
  coursePhotoFallbackCacheHeaders,
  coursePhotoSuccessCacheHeaders
} from "@/lib/places/course-data-cache";

describe("course data cache headers", () => {
  it("keeps review-sensitive course data out of browser and shared CDN caches", () => {
    expect(courseDataSuccessCacheHeaders).toEqual({
      "Cache-Control": "private, no-store, max-age=0",
      "Vercel-CDN-Cache-Control": "no-store"
    });
  });

  it("keeps successful course photos in the shared cache for one year", () => {
    expect(coursePhotoSuccessCacheHeaders["Vercel-CDN-Cache-Control"]).toContain(
      "max-age=31536000"
    );
    expect(coursePhotoSuccessCacheHeaders["Cache-Control"]).toContain("max-age=31536000");
  });

  it("keeps temporary photo fallbacks short-lived", () => {
    expect(coursePhotoFallbackCacheHeaders["Vercel-CDN-Cache-Control"]).toContain("max-age=900");
  });
});
