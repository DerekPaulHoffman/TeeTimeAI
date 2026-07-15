import { describe, expect, it } from "vitest";

import {
  getCourseHeadlineHoleCount,
  getCourseLayoutCompatibility,
  getCourseLayoutLabel,
  normalizeCoursePar,
  normalizeLayoutHoleCounts,
  normalizeRequestedLayoutHoles
} from "./course-layout";

describe("course layout helpers", () => {
  it("normalizes only supported physical layout sizes", () => {
    expect(normalizeLayoutHoleCounts([18, 9, 18, 27, null, "9"])).toEqual([9, 18]);
    expect(normalizeLayoutHoleCounts(undefined)).toEqual([]);
  });

  it("normalizes a requested layout to 9, 18, or any", () => {
    expect(normalizeRequestedLayoutHoles(9)).toBe(9);
    expect(normalizeRequestedLayoutHoles(18)).toBe(18);
    expect(normalizeRequestedLayoutHoles("18")).toBeNull();
    expect(normalizeRequestedLayoutHoles(27)).toBeNull();
    expect(normalizeRequestedLayoutHoles(undefined)).toBeNull();
  });

  it("distinguishes compatible, incompatible, and unknown layouts", () => {
    expect(getCourseLayoutCompatibility([9], 9)).toBe("compatible");
    expect(getCourseLayoutCompatibility([9], 18)).toBe("incompatible");
    expect(getCourseLayoutCompatibility([], 18)).toBe("unknown");
    expect(getCourseLayoutCompatibility([9], null)).toBe("compatible");
  });

  it("builds concise verified and unverified labels", () => {
    expect(getCourseLayoutLabel([18, 9])).toBe("9-hole and 18-hole");
    expect(getCourseLayoutLabel([])).toBe("Hole count unverified");
  });

  it("prefers verified physical layout over transient booking products", () => {
    expect(getCourseHeadlineHoleCount([18], [9])).toBe(18);
    expect(getCourseHeadlineHoleCount([9], [18])).toBe(9);
    expect(getCourseHeadlineHoleCount([], [9, 18])).toBe(18);
    expect(getCourseHeadlineHoleCount(undefined, [9])).toBe(9);
    expect(getCourseHeadlineHoleCount(undefined, undefined)).toBeUndefined();
  });

  it("normalizes plausible verified course par values", () => {
    expect(normalizeCoursePar(72)).toBe(72);
    expect(normalizeCoursePar(27)).toBe(27);
    expect(normalizeCoursePar(91)).toBeUndefined();
    expect(normalizeCoursePar("72")).toBeUndefined();
  });
});
