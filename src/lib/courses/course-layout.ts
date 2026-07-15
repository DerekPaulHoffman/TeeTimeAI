export type CourseLayoutHoleCount = 9 | 18;

export type CourseLayoutCompatibility = "compatible" | "incompatible" | "unknown";

export function normalizeRequestedLayoutHoles(
  value: unknown
): CourseLayoutHoleCount | null {
  return isCourseLayoutHoleCount(value) ? value : null;
}

export function normalizeLayoutHoleCounts(
  values: readonly unknown[] | null | undefined
): CourseLayoutHoleCount[] {
  if (!values) {
    return [];
  }

  return [...new Set(values.filter(isCourseLayoutHoleCount))].sort(
    (left, right) => left - right
  );
}

export function getCourseLayoutCompatibility(
  layoutHoleCounts: readonly unknown[] | null | undefined,
  requestedLayoutHoles: CourseLayoutHoleCount | null | undefined
): CourseLayoutCompatibility {
  if (requestedLayoutHoles === null || requestedLayoutHoles === undefined) {
    return "compatible";
  }

  const normalizedCounts = normalizeLayoutHoleCounts(layoutHoleCounts);
  if (normalizedCounts.length === 0) {
    return "unknown";
  }

  return normalizedCounts.includes(requestedLayoutHoles) ? "compatible" : "incompatible";
}

export function getCourseLayoutLabel(
  layoutHoleCounts: readonly unknown[] | null | undefined
) {
  const normalizedCounts = normalizeLayoutHoleCounts(layoutHoleCounts);
  if (normalizedCounts.length === 0) {
    return "Hole count unverified";
  }

  return normalizedCounts.map((holes) => `${holes}-hole`).join(" and ");
}

export function getCourseHeadlineHoleCount(
  layoutHoleCounts: readonly unknown[] | null | undefined,
  bookableHoleCounts: readonly unknown[] | null | undefined
): CourseLayoutHoleCount | undefined {
  const verifiedLayouts = normalizeLayoutHoleCounts(layoutHoleCounts);
  if (verifiedLayouts.includes(18)) return 18;
  if (verifiedLayouts.includes(9)) return 9;

  const observedBookingOptions = normalizeLayoutHoleCounts(bookableHoleCounts);
  if (observedBookingOptions.includes(18)) return 18;
  if (observedBookingOptions.includes(9)) return 9;
  return undefined;
}

export function normalizeCoursePar(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 27 && value <= 90
    ? value
    : undefined;
}

function isCourseLayoutHoleCount(value: unknown): value is CourseLayoutHoleCount {
  return value === 9 || value === 18;
}
