import { describe, expect, it } from "vitest";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";
import { buildCoursePriceEstimate, hasPriceForView, summarizeCourseSlotPrices } from "./course-prices";

describe("course prices", () => {
  it("keeps separate nine and eighteen hole ranges", () => {
    expect(summarizeCourseSlotPrices([
      slot({ holes: 9, priceCents: 2800 }),
      slot({ holes: 9, priceCents: 3400, sourceId: "two" }),
      slot({ holes: 18, priceCents: 4800, sourceId: "three" })
    ], new Date("2026-07-10T14:00:00Z"))).toEqual({
      currency: "USD",
      observedAt: "2026-07-10T14:00:00.000Z",
      nineHoles: { minPriceCents: 2800, maxPriceCents: 3400, sampleSize: 2 },
      eighteenHoles: { minPriceCents: 4800, maxPriceCents: 4800, sampleSize: 1 }
    });
  });

  it("captures provider alternatives without double-counting the selected rate", () => {
    const estimate = summarizeCourseSlotPrices([slot({
      holes: 18,
      priceCents: 4800,
      priceOptions: [{ holes: 9, priceCents: 2800 }, { holes: 18, priceCents: 4800 }]
    })]);
    expect(estimate?.nineHoles?.sampleSize).toBe(1);
    expect(estimate?.eighteenHoles?.sampleSize).toBe(1);
  });

  it("uses confirmed matches to bootstrap existing data", () => {
    expect(buildCoursePriceEstimate({
      probes: [],
      matches: [{ holes: 18, priceCents: 5500, lastConfirmedAt: new Date("2026-07-10T13:00:00Z") }]
    })?.eighteenHoles).toEqual({ minPriceCents: 5500, maxPriceCents: 5500, sampleSize: 1 });
  });

  it("keeps unknown-price courses in the all-courses view", () => {
    expect(hasPriceForView(undefined, "any")).toBe(true);
    expect(hasPriceForView(undefined, "9")).toBe(false);
  });
});

function slot(overrides: Partial<TeeTimeSlot> = {}): TeeTimeSlot {
  return {
    sourceId: "one",
    courseId: "course",
    startsAt: "2026-07-11T12:30",
    availableSpots: 4,
    bookingUrl: "https://example.com/book",
    ...overrides
  };
}
