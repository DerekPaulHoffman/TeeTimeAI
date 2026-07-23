import { describe, expect, it } from "vitest";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";
import {
  buildObservedBookableHoleCounts,
  buildCoursePriceEstimate,
  getHeadlineBookableHoleCount,
  getHeadlineCoursePrice,
  hasPriceForView,
  summarizeBookableHoleCounts,
  summarizeCourseSlotPrices
} from "./course-prices";

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

  it("rejects one extreme provider price against a well-supported course range", () => {
    const ordinarySlots = Array.from({ length: 10 }, (_, index) =>
      slot({
        sourceId: `ordinary-${index}`,
        holes: 9,
        priceCents: index % 2 === 0 ? 3900 : 4300,
        priceOptions: [
          { holes: 9, priceCents: index % 2 === 0 ? 3900 : 4300 }
        ]
      })
    );
    const estimate = summarizeCourseSlotPrices([
      ...ordinarySlots,
      slot({
        sourceId: "extreme",
        holes: 9,
        priceCents: 50000,
        priceOptions: [
          { holes: 9, priceCents: 50000 },
          { holes: 18, priceCents: 50000 }
        ]
      })
    ]);

    expect(estimate?.nineHoles).toMatchObject({
      minPriceCents: 3900,
      maxPriceCents: 4300,
      sampleSize: 10
    });
    expect(estimate?.eighteenHoles).toBeUndefined();
  });

  it("retains consistently observed high prices", () => {
    const estimate = summarizeCourseSlotPrices(
      Array.from({ length: 5 }, (_, index) =>
        slot({
          sourceId: `premium-${index}`,
          holes: 18,
          priceCents: 50000
        })
      )
    );

    expect(estimate?.eighteenHoles).toMatchObject({
      minPriceCents: 50000,
      maxPriceCents: 50000,
      sampleSize: 5
    });
  });

  it("captures bookable hole options even when the provider omits prices", () => {
    expect(summarizeBookableHoleCounts([
      slot({ bookableHoleCounts: [9, 18] }),
      slot({ holes: 18, sourceId: "two" })
    ])).toEqual([9, 18]);
  });

  it("uses the longest observed bookable round in the card metadata", () => {
    expect(getHeadlineBookableHoleCount([9, 18])).toBe(18);
    expect(getHeadlineBookableHoleCount([9])).toBe(9);
    expect(getHeadlineBookableHoleCount(undefined)).toBeUndefined();
  });

  it("restores bookable options from probes, legacy pricing, and matches", () => {
    expect(buildObservedBookableHoleCounts({
      probes: [
        {
          observedAt: new Date("2026-07-10T14:00:00Z"),
          rawSummary: { bookableHoleCounts: [9] }
        },
        {
          observedAt: new Date("2026-07-10T13:00:00Z"),
          rawSummary: {
            pricing: {
              eighteenHoles: { minPriceCents: 4800, maxPriceCents: 4800, sampleSize: 1 }
            }
          }
        }
      ],
      matches: [{ holes: 18, priceCents: null, lastConfirmedAt: new Date("2026-07-10T12:00:00Z") }]
    })).toEqual([9, 18]);
  });

  it("keeps durable price and hole observations regardless of age", () => {
    const observedAt = new Date("2024-01-10T14:00:00Z");
    const evidence = {
      bookingFacts: [{
        holes: 18,
        minPriceCents: 8500,
        maxPriceCents: 9800,
        priceSampleSize: 6,
        priceObservedAt: observedAt,
        bookableObservedAt: observedAt
      }],
      probes: [],
      matches: []
    };

    expect(buildCoursePriceEstimate(evidence)?.eighteenHoles).toEqual({
      minPriceCents: 8500,
      maxPriceCents: 9800,
      sampleSize: 6,
      observedAt: "2024-01-10T14:00:00.000Z"
    });
    expect(buildObservedBookableHoleCounts(evidence)).toEqual([18]);
  });

  it("uses legacy evidence for a hole count that has not been durably observed", () => {
    const estimate = buildCoursePriceEstimate({
      bookingFacts: [{
        holes: 9,
        minPriceCents: 3200,
        maxPriceCents: 3800,
        priceSampleSize: 2,
        priceObservedAt: new Date("2026-07-10T14:00:00Z"),
        bookableObservedAt: new Date("2026-07-10T14:00:00Z")
      }],
      probes: [],
      matches: [{
        holes: 18,
        priceCents: 7500,
        lastConfirmedAt: new Date("2025-05-10T14:00:00Z")
      }]
    });

    expect(estimate?.nineHoles?.minPriceCents).toBe(3200);
    expect(estimate?.eighteenHoles).toEqual({
      minPriceCents: 7500,
      maxPriceCents: 7500,
      sampleSize: 1,
      observedAt: "2025-05-10T14:00:00.000Z"
    });
  });

  it("does not restore an extreme low-support legacy price beside a durable range", () => {
    const estimate = buildCoursePriceEstimate({
      bookingFacts: [{
        holes: 9,
        minPriceCents: 3900,
        maxPriceCents: 4300,
        priceSampleSize: 53,
        priceObservedAt: new Date("2026-07-22T08:08:52Z"),
        bookableObservedAt: new Date("2026-07-22T08:08:52Z")
      }],
      probes: [{
        observedAt: new Date("2026-07-21T18:07:53Z"),
        rawSummary: {
          pricing: {
            observedAt: "2026-07-21T18:07:53Z",
            eighteenHoles: {
              minPriceCents: 50000,
              maxPriceCents: 50000,
              sampleSize: 1
            }
          }
        }
      }],
      matches: []
    });

    expect(estimate?.nineHoles).toMatchObject({
      minPriceCents: 3900,
      maxPriceCents: 4300
    });
    expect(estimate?.eighteenHoles).toBeUndefined();
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

  it("uses the price matching a preferred observed booking option for the card headline", () => {
    const estimate = {
      currency: "USD" as const,
      observedAt: "2026-07-10T14:00:00.000Z",
      nineHoles: { minPriceCents: 2800, maxPriceCents: 3400, sampleSize: 2 },
      eighteenHoles: { minPriceCents: 4800, maxPriceCents: 4800, sampleSize: 1 }
    };

    expect(getHeadlineCoursePrice(estimate, [18])).toEqual({
      holes: 18,
      range: estimate.eighteenHoles
    });
    expect(getHeadlineCoursePrice(estimate, [9])).toEqual({
      holes: 9,
      range: estimate.nineHoles
    });
  });

  it("does not label a nine-hole price as an eighteen-hole estimate", () => {
    const estimate = {
      currency: "USD" as const,
      observedAt: "2026-07-10T14:00:00.000Z",
      nineHoles: { minPriceCents: 2800, maxPriceCents: 3400, sampleSize: 2 }
    };

    expect(getHeadlineCoursePrice(estimate, [18])).toBeUndefined();
  });

  it("prefers an eighteen-hole observation when no booking option is preferred", () => {
    const estimate = {
      currency: "USD" as const,
      observedAt: "2026-07-10T14:00:00.000Z",
      nineHoles: { minPriceCents: 2800, maxPriceCents: 3400, sampleSize: 2 },
      eighteenHoles: { minPriceCents: 4800, maxPriceCents: 4800, sampleSize: 1 }
    };

    expect(getHeadlineCoursePrice(estimate)).toEqual({
      holes: 18,
      range: estimate.eighteenHoles
    });
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
