import { describe, expect, it } from "vitest";

import {
  DEFAULT_COURSE_SEARCH_RADIUS_MILES,
  MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS,
  milesToMeters,
  normalizeCourseSearchRadiusMeters
} from "./radius";

describe("course search radius", () => {
  it("defaults to 15 miles when the request omits or invalidates the radius", () => {
    const defaultRadius = milesToMeters(DEFAULT_COURSE_SEARCH_RADIUS_MILES);

    expect(normalizeCourseSearchRadiusMeters(null)).toBe(defaultRadius);
    expect(normalizeCourseSearchRadiusMeters("not-a-number")).toBe(defaultRadius);
    expect(normalizeCourseSearchRadiusMeters("0")).toBe(defaultRadius);
  });

  it("converts miles to whole meters and keeps valid request values", () => {
    expect(milesToMeters(15)).toBe(24140);
    expect(normalizeCourseSearchRadiusMeters("24140")).toBe(24140);
  });

  it("caps requests at the Google Nearby Search maximum", () => {
    expect(normalizeCourseSearchRadiusMeters("999999")).toBe(
      MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS
    );
  });
});
