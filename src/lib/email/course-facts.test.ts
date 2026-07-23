import { describe, expect, it } from "vitest";

import { buildCourseFactLine, formatCourseDistance } from "./course-facts";

describe("course email facts", () => {
  it("keeps the reusable strip in product order with stale-safe observations", () => {
    expect(
      buildCourseFactLine({
        isPublic: true,
        rating: 4.1,
        ratingObservedAt: "2026-07-20T12:00:00.000Z",
        distanceMeters: 2092,
        layoutHoleCounts: [18],
        priceEstimate: {
          currency: "USD",
          observedAt: "2026-07-22T12:00:00.000Z",
          eighteenHoles: {
            minPriceCents: 8500,
            maxPriceCents: 9800,
            sampleSize: 3,
            observedAt: "2026-07-22T12:00:00.000Z"
          }
        }
      })
    ).toBe(
      "Public · 4.1 rating (observed Jul 20, 2026) · 1.3 mi · 18H verified layout · $85–$98 last observed Jul 22, 2026"
    );
  });

  it("formats nearby and farther selection distances consistently", () => {
    expect(formatCourseDistance(161)).toBe("0.1 mi");
    expect(formatCourseDistance(20_000)).toBe("12 mi");
  });
});
