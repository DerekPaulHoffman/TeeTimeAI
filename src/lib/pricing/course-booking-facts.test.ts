import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { recordCourseBookingFacts } from "./course-booking-facts";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseBookingFact: { findUnique: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn()
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("durable course booking facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.courseBookingFact.findUnique.mockResolvedValue(null);
  });

  it("updates every observed hole option without clearing unobserved facts", async () => {
    const observedAt = new Date("2026-07-23T16:00:00.000Z");
    await recordCourseBookingFacts({
      courseId: "course-1",
      observedAt,
      bookableHoleCounts: [9, 18],
      pricing: {
        currency: "USD",
        observedAt: observedAt.toISOString(),
        eighteenHoles: {
          minPriceCents: 8500,
          maxPriceCents: 9800,
          sampleSize: 6
        }
      }
    });

    expect(mockedPrisma.courseBookingFact.upsert).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.courseBookingFact.upsert).toHaveBeenCalledWith({
      where: { courseId_holes: { courseId: "course-1", holes: 9 } },
      create: {
        courseId: "course-1",
        holes: 9,
        bookableObservedAt: observedAt
      },
      update: {
        bookableObservedAt: observedAt
      }
    });
    expect(mockedPrisma.courseBookingFact.upsert).toHaveBeenCalledWith({
      where: { courseId_holes: { courseId: "course-1", holes: 18 } },
      create: {
        courseId: "course-1",
        holes: 18,
        minPriceCents: 8500,
        maxPriceCents: 9800,
        priceSampleSize: 6,
        priceObservedAt: observedAt,
        bookableObservedAt: observedAt
      },
      update: {
        minPriceCents: 8500,
        maxPriceCents: 9800,
        priceSampleSize: 6,
        priceObservedAt: observedAt,
        bookableObservedAt: observedAt
      }
    });
  });

  it("does not erase retained facts after a successful read with no options", async () => {
    await expect(
      recordCourseBookingFacts({
        courseId: "course-1",
        bookableHoleCounts: []
      })
    ).resolves.toEqual([]);

    expect(mockedPrisma.courseBookingFact.upsert).not.toHaveBeenCalled();
  });

  it("does not let older price or bookability evidence overwrite newer facts", async () => {
    const observedAt = new Date("2026-07-23T16:00:00.000Z");
    mockedPrisma.courseBookingFact.findUnique.mockResolvedValue({
      courseId: "course-1",
      holes: 18,
      minPriceCents: 9000,
      maxPriceCents: 9900,
      priceSampleSize: 4,
      priceObservedAt: new Date("2026-07-23T16:05:00.000Z"),
      bookableObservedAt: new Date("2026-07-23T16:05:00.000Z")
    } as never);

    await expect(
      recordCourseBookingFacts({
        courseId: "course-1",
        observedAt,
        bookableHoleCounts: [18],
        pricing: {
          currency: "USD",
          observedAt: observedAt.toISOString(),
          eighteenHoles: {
            minPriceCents: 5000,
            maxPriceCents: 6000,
            sampleSize: 2
          }
        }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        priceObservedAt: new Date("2026-07-23T16:05:00.000Z"),
        bookableObservedAt: new Date("2026-07-23T16:05:00.000Z")
      })
    ]);

    expect(mockedPrisma.courseBookingFact.upsert).not.toHaveBeenCalled();
  });
});
