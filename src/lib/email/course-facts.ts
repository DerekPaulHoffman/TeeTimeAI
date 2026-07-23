import type { CoursePriceEstimate } from "@/lib/pricing/course-prices";

export type CourseFactSource = {
  isPublic?: boolean;
  rating?: number;
  ratingObservedAt?: string;
  distanceMeters?: number;
  layoutHoleCounts?: number[];
  priceEstimate?: CoursePriceEstimate;
  bookableHoleCounts?: Array<9 | 18>;
  bookableHoleCountsObservedAt?: string;
};

export function buildCourseFactLine(course: CourseFactSource) {
  const facts: string[] = [];
  if (course.isPublic === true) facts.push("Public");
  if (typeof course.rating === "number") {
    facts.push(
      `${course.rating.toFixed(1)} rating${formatObservedSuffix(course.ratingObservedAt)}`
    );
  }
  if (typeof course.distanceMeters === "number") {
    facts.push(formatCourseDistance(course.distanceMeters));
  }
  const physicalHoles = course.layoutHoleCounts?.includes(18)
    ? 18
    : course.layoutHoleCounts?.includes(9)
      ? 9
      : undefined;
  const observedHoles = course.bookableHoleCounts?.includes(18)
    ? 18
    : course.bookableHoleCounts?.includes(9)
      ? 9
      : undefined;
  if (physicalHoles) {
    facts.push(`${physicalHoles}H verified layout`);
  } else if (observedHoles) {
    facts.push(
      `${observedHoles}H booking option${formatObservedSuffix(course.bookableHoleCountsObservedAt)}`
    );
  }
  const range =
    (physicalHoles === 9 ? course.priceEstimate?.nineHoles : undefined) ??
    (physicalHoles === 18 ? course.priceEstimate?.eighteenHoles : undefined) ??
    course.priceEstimate?.eighteenHoles ??
    course.priceEstimate?.nineHoles;
  if (range) {
    const minimum = formatEmailPrice(range.minPriceCents);
    const maximum = formatEmailPrice(range.maxPriceCents);
    facts.push(
      `${minimum === maximum ? minimum : `${minimum}–${maximum}`} last observed ${formatObservedDate(range.observedAt ?? course.priceEstimate?.observedAt)}`
    );
  }
  return facts.join(" · ");
}

export function formatCourseDistance(distanceMeters: number) {
  const miles = distanceMeters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function formatObservedSuffix(value: string | undefined) {
  return value ? ` (observed ${formatObservedDate(value)})` : "";
}

function formatObservedDate(value: string | undefined) {
  if (!value) return "earlier";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "earlier"
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
}

function formatEmailPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 100 === 0 ? 0 : 2
  }).format(value / 100);
}
