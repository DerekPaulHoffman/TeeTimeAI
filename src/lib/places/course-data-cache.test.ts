import { describe, expect, it } from "vitest";

import {
  courseDataSuccessCacheHeaders,
  coursePhotoFallbackCacheHeaders,
  coursePhotoSuccessCacheHeaders
} from "@/lib/places/course-data-cache";

describe("course data cache headers", () => {
  it("keeps successful course data and photos in the shared cache for one year", () => {
    expect(courseDataSuccessCacheHeaders["Vercel-CDN-Cache-Control"]).toContain(
      "max-age=31536000"
    );
    expect(coursePhotoSuccessCacheHeaders["Vercel-CDN-Cache-Control"]).toContain(
      "max-age=31536000"
    );
    expect(coursePhotoSuccessCacheHeaders["Cache-Control"]).toContain(
      "max-age=31536000"
    );
  });

  it("keeps temporary photo fallbacks short-lived", () => {
    expect(coursePhotoFallbackCacheHeaders["Vercel-CDN-Cache-Control"]).toContain(
      "max-age=900"
    );
  });
});
