import { describe, expect, it } from "vitest";

import { buildCourseProfileSlug, withStableSlugSuffix } from "@/lib/course-profiles/slug";

describe("course profile slugs", () => {
  it("builds a readable flat slug", () => {
    expect(buildCourseProfileSlug({ name: "Tashua Knolls Golf Course", city: "Trumbull", stateCode: "CT" }))
      .toBe("tashua-knolls-golf-course-trumbull-ct");
  });

  it("adds a stable collision suffix", () => {
    expect(withStableSlugSuffix("example-golf-course-fairfield-ct", "course-ABC123"))
      .toBe("example-golf-course-fairfield-ct-abc123");
  });
});
