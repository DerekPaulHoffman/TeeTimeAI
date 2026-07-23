import { prisma } from "@/lib/prisma";
import type {
  BookableHoleCount,
  CoursePriceEstimate,
  CoursePriceRange
} from "@/lib/pricing/course-prices";

export async function recordCourseBookingFacts(input: {
  courseId: string;
  pricing?: CoursePriceEstimate;
  bookableHoleCounts: readonly BookableHoleCount[];
  observedAt?: Date;
}) {
  const observedAt = input.observedAt ?? new Date();
  const ranges = new Map<BookableHoleCount, CoursePriceRange>();
  if (input.pricing?.nineHoles) ranges.set(9, input.pricing.nineHoles);
  if (input.pricing?.eighteenHoles) ranges.set(18, input.pricing.eighteenHoles);

  const observedHoles = new Set<BookableHoleCount>([
    ...input.bookableHoleCounts,
    ...ranges.keys()
  ]);
  if (observedHoles.size === 0) return [];

  return prisma.$transaction(
    [...observedHoles].map((holes) => {
      const range = ranges.get(holes);
      const bookableObservedAt =
        input.bookableHoleCounts.includes(holes) || range ? observedAt : undefined;
      const priceObservedAt = range
        ? readPriceObservedAt(input.pricing, observedAt)
        : undefined;

      return prisma.courseBookingFact.upsert({
        where: { courseId_holes: { courseId: input.courseId, holes } },
        create: {
          courseId: input.courseId,
          holes,
          ...(range
            ? {
                minPriceCents: range.minPriceCents,
                maxPriceCents: range.maxPriceCents,
                priceSampleSize: range.sampleSize,
                priceObservedAt
              }
            : {}),
          ...(bookableObservedAt ? { bookableObservedAt } : {})
        },
        update: {
          ...(range
            ? {
                minPriceCents: range.minPriceCents,
                maxPriceCents: range.maxPriceCents,
                priceSampleSize: range.sampleSize,
                priceObservedAt
              }
            : {}),
          ...(bookableObservedAt ? { bookableObservedAt } : {})
        }
      });
    })
  );
}

function readPriceObservedAt(
  pricing: CoursePriceEstimate | undefined,
  fallback: Date
) {
  if (!pricing) return fallback;
  const observedAt = new Date(pricing.observedAt);
  return Number.isNaN(observedAt.getTime()) ? fallback : observedAt;
}
