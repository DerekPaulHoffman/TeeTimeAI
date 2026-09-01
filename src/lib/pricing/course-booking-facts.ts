import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  BookableHoleCount,
  CoursePriceEstimate,
  CoursePriceRange,
} from "@/lib/pricing/course-prices";

export async function recordCourseBookingFacts(input: {
  courseId: string;
  pricing?: CoursePriceEstimate;
  bookableHoleCounts: readonly BookableHoleCount[];
  observedAt?: Date;
  transaction?: Prisma.TransactionClient;
}) {
  const observedAt = input.observedAt ?? new Date();
  const ranges = new Map<BookableHoleCount, CoursePriceRange>();
  if (input.pricing?.nineHoles) ranges.set(9, input.pricing.nineHoles);
  if (input.pricing?.eighteenHoles) ranges.set(18, input.pricing.eighteenHoles);

  const observedHoles = new Set<BookableHoleCount>([
    ...input.bookableHoleCounts,
    ...ranges.keys(),
  ]);
  if (observedHoles.size === 0) return [];

  const persist = async (client: Prisma.TransactionClient) =>
    Promise.all(
      [...observedHoles].map(async (holes) => {
        const range = ranges.get(holes);
        const bookableObservedAt =
          input.bookableHoleCounts.includes(holes) || range
            ? observedAt
            : undefined;
        const priceObservedAt = range
          ? readPriceObservedAt(input.pricing, observedAt)
          : undefined;

        const current = await client.courseBookingFact.findUnique({
          where: { courseId_holes: { courseId: input.courseId, holes } },
        });
        const shouldApplyPrice = Boolean(
          range &&
          priceObservedAt &&
          (!(current?.priceObservedAt instanceof Date) ||
            current.priceObservedAt <= priceObservedAt),
        );
        const shouldApplyBookability = Boolean(
          bookableObservedAt &&
          (!(current?.bookableObservedAt instanceof Date) ||
            current.bookableObservedAt <= bookableObservedAt),
        );
        if (current && !shouldApplyPrice && !shouldApplyBookability) {
          return current;
        }

        return client.courseBookingFact.upsert({
          where: { courseId_holes: { courseId: input.courseId, holes } },
          create: {
            courseId: input.courseId,
            holes,
            ...(range
              ? {
                  minPriceCents: range.minPriceCents,
                  maxPriceCents: range.maxPriceCents,
                  priceSampleSize: range.sampleSize,
                  priceObservedAt,
                }
              : {}),
            ...(bookableObservedAt ? { bookableObservedAt } : {}),
          },
          update: {
            ...(range && shouldApplyPrice
              ? {
                  minPriceCents: range.minPriceCents,
                  maxPriceCents: range.maxPriceCents,
                  priceSampleSize: range.sampleSize,
                  priceObservedAt,
                }
              : {}),
            ...(bookableObservedAt && shouldApplyBookability
              ? { bookableObservedAt }
              : {}),
          },
        });
      }),
    );

  return input.transaction
    ? persist(input.transaction)
    : prisma.$transaction((transaction) => persist(transaction));
}

function readPriceObservedAt(
  pricing: CoursePriceEstimate | undefined,
  fallback: Date,
) {
  if (!pricing) return fallback;
  const observedAt = new Date(pricing.observedAt);
  return Number.isNaN(observedAt.getTime()) ? fallback : observedAt;
}
