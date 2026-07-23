import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type CoursePriceRange = {
  minPriceCents: number;
  maxPriceCents: number;
  sampleSize: number;
  observedAt?: string;
};

export type CoursePriceEstimate = {
  currency: "USD";
  observedAt: string;
  nineHoles?: CoursePriceRange;
  eighteenHoles?: CoursePriceRange;
};

export type CoursePriceView = "any" | "9" | "18";
export type BookableHoleCount = 9 | 18;

export type CourseBookingFactRecord = {
  holes: number;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  priceSampleSize: number | null;
  priceObservedAt: Date | null;
  bookableObservedAt: Date | null;
};

type CoursePriceEvidence = {
  bookingFacts?: CourseBookingFactRecord[];
  probes: Array<{ observedAt: Date; rawSummary: unknown }>;
  matches: Array<{
    priceCents: number | null;
    holes: number | null;
    lastConfirmedAt: Date;
  }>;
};

export function summarizeCourseSlotPrices(
  slots: TeeTimeSlot[],
  observedAt = new Date()
): CoursePriceEstimate | undefined {
  const pricesByHoles = new Map<9 | 18, number[]>([[9, []], [18, []]]);

  for (const slot of slots) {
    const seenForSlot = new Set<string>();
    const options = [
      ...(slot.priceOptions ?? []),
      ...(isSupportedHoles(slot.holes) && isPrice(slot.priceCents)
        ? [{ holes: slot.holes, priceCents: slot.priceCents }]
        : [])
    ];

    for (const option of options) {
      if (!isSupportedHoles(option.holes) || !isPrice(option.priceCents)) continue;
      const key = `${option.holes}:${option.priceCents}`;
      if (seenForSlot.has(key)) continue;
      seenForSlot.add(key);
      pricesByHoles.get(option.holes)?.push(option.priceCents);
    }
  }

  return buildEstimateFromPrices(pricesByHoles, observedAt);
}

export function summarizeBookableHoleCounts(slots: TeeTimeSlot[]) {
  const observed = new Set<BookableHoleCount>();
  for (const slot of slots) {
    for (const holes of [
      ...(slot.bookableHoleCounts ?? []),
      slot.holes,
      ...(slot.priceOptions ?? []).map((option) => option.holes)
    ]) {
      if (isSupportedHoles(holes)) observed.add(holes);
    }
  }
  return ([9, 18] as const).filter((holes) => observed.has(holes));
}

export function hasPriceForView(
  estimate: CoursePriceEstimate | undefined,
  priceView: CoursePriceView
) {
  if (priceView === "any") return true;
  return priceView === "9" ? Boolean(estimate?.nineHoles) : Boolean(estimate?.eighteenHoles);
}

export function getHeadlineBookableHoleCount(holeCounts: readonly number[] | undefined) {
  if (holeCounts?.includes(18)) return 18 as const;
  if (holeCounts?.includes(9)) return 9 as const;
  return undefined;
}

export function getHeadlineCoursePrice(
  estimate: CoursePriceEstimate | undefined,
  preferredHoleCounts: readonly number[] = []
) {
  if (!estimate) return undefined;

  if (preferredHoleCounts.includes(18) && estimate.eighteenHoles) {
    return { holes: 18 as const, range: estimate.eighteenHoles };
  }
  if (preferredHoleCounts.includes(9) && estimate.nineHoles) {
    return { holes: 9 as const, range: estimate.nineHoles };
  }
  if (preferredHoleCounts.length > 0) return undefined;

  if (estimate.eighteenHoles) {
    return { holes: 18 as const, range: estimate.eighteenHoles };
  }
  return estimate.nineHoles
    ? { holes: 9 as const, range: estimate.nineHoles }
    : undefined;
}

export function buildCoursePriceEstimate(
  evidence: CoursePriceEvidence
): CoursePriceEstimate | undefined {
  const durableEstimate = buildDurableCoursePriceEstimate(evidence.bookingFacts ?? []);
  const probeSnapshots = evidence.probes
    .map((probe) => parseStoredPriceSnapshot(probe.rawSummary, probe.observedAt))
    .filter((snapshot): snapshot is CoursePriceEstimate => snapshot !== undefined);

  const probeEstimate =
    probeSnapshots.length > 0 ? mergePriceEstimates(probeSnapshots) : undefined;

  const pricesByHoles = new Map<9 | 18, number[]>([[9, []], [18, []]]);
  let matchObservedAt: Date | undefined;
  for (const match of evidence.matches) {
    if (!isSupportedHoles(match.holes) || !isPrice(match.priceCents)) continue;
    pricesByHoles.get(match.holes)?.push(match.priceCents);
    if (!matchObservedAt || match.lastConfirmedAt > matchObservedAt) {
      matchObservedAt = match.lastConfirmedAt;
    }
  }
  const matchEstimate = matchObservedAt
    ? buildEstimateFromPrices(pricesByHoles, matchObservedAt)
    : undefined;
  const legacyEstimate = mergePriceEstimateCoverage(probeEstimate, matchEstimate);

  return mergePriceEstimateCoverage(durableEstimate, legacyEstimate);
}

export function buildObservedBookableHoleCounts(evidence: CoursePriceEvidence) {
  return buildObservedBookableHoleSummary(evidence).holeCounts;
}

export function buildObservedBookableHoleSummary(evidence: CoursePriceEvidence) {
  const observed = new Set<BookableHoleCount>();
  let observedAt: Date | undefined;

  for (const fact of evidence.bookingFacts ?? []) {
    if (
      isSupportedHoles(fact.holes) &&
      (fact.bookableObservedAt || fact.priceObservedAt)
    ) {
      observed.add(fact.holes);
      const factObservedAt = fact.bookableObservedAt ?? fact.priceObservedAt;
      if (factObservedAt && (!observedAt || factObservedAt > observedAt)) {
        observedAt = factObservedAt;
      }
    }
  }

  for (const probe of evidence.probes) {
    if (!isRecord(probe.rawSummary)) continue;
    let probeObservedBookableHoles = false;
    for (const holes of Array.isArray(probe.rawSummary.bookableHoleCounts)
      ? probe.rawSummary.bookableHoleCounts
      : []) {
      if (isSupportedHoles(holes)) {
        observed.add(holes);
        probeObservedBookableHoles = true;
      }
    }

    if (isRecord(probe.rawSummary.pricing)) {
      if (parseRange(probe.rawSummary.pricing.nineHoles)) {
        observed.add(9);
        probeObservedBookableHoles = true;
      }
      if (parseRange(probe.rawSummary.pricing.eighteenHoles)) {
        observed.add(18);
        probeObservedBookableHoles = true;
      }
    }
    if (probeObservedBookableHoles && (!observedAt || probe.observedAt > observedAt)) {
      observedAt = probe.observedAt;
    }
  }

  for (const match of evidence.matches) {
    if (isSupportedHoles(match.holes)) {
      observed.add(match.holes);
      if (!observedAt || match.lastConfirmedAt > observedAt) {
        observedAt = match.lastConfirmedAt;
      }
    }
  }

  return {
    holeCounts: ([9, 18] as const).filter((holes) => observed.has(holes)),
    observedAt: observedAt?.toISOString()
  };
}

function buildDurableCoursePriceEstimate(facts: CourseBookingFactRecord[]) {
  const nineHoles = buildDurableRange(facts.find((fact) => fact.holes === 9));
  const eighteenHoles = buildDurableRange(facts.find((fact) => fact.holes === 18));
  if (!nineHoles && !eighteenHoles) return undefined;

  const observedAt = [nineHoles?.observedAt, eighteenHoles?.observedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  if (!observedAt) return undefined;

  return {
    currency: "USD" as const,
    observedAt,
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function buildDurableRange(
  fact: CourseBookingFactRecord | undefined
): CoursePriceRange | undefined {
  if (
    !fact?.priceObservedAt ||
    !isPrice(fact.minPriceCents) ||
    !isPrice(fact.maxPriceCents) ||
    !fact.priceSampleSize ||
    fact.priceSampleSize < 1 ||
    fact.minPriceCents > fact.maxPriceCents
  ) {
    return undefined;
  }

  return {
    minPriceCents: fact.minPriceCents,
    maxPriceCents: fact.maxPriceCents,
    sampleSize: fact.priceSampleSize,
    observedAt: fact.priceObservedAt.toISOString()
  };
}

function mergePriceEstimateCoverage(
  primary: CoursePriceEstimate | undefined,
  fallback: CoursePriceEstimate | undefined
) {
  if (!primary) return fallback;
  if (!fallback) return primary;

  const nineHoles =
    primary.nineHoles ??
    addRangeObservedAt(fallback.nineHoles, fallback.observedAt);
  const eighteenHoles =
    primary.eighteenHoles ??
    addRangeObservedAt(fallback.eighteenHoles, fallback.observedAt);
  const observedAt = [nineHoles?.observedAt, eighteenHoles?.observedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

  return {
    currency: "USD" as const,
    observedAt: observedAt ?? primary.observedAt,
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function addRangeObservedAt(
  range: CoursePriceRange | undefined,
  observedAt: string
) {
  return range
    ? { ...range, observedAt: range.observedAt ?? observedAt }
    : undefined;
}

function parseStoredPriceSnapshot(rawSummary: unknown, fallbackObservedAt: Date) {
  if (!isRecord(rawSummary) || !isRecord(rawSummary.pricing)) return undefined;
  const pricing = rawSummary.pricing;
  const nineHoles = parseRange(pricing.nineHoles);
  const eighteenHoles = parseRange(pricing.eighteenHoles);
  if (!nineHoles && !eighteenHoles) return undefined;
  const observedAt =
    typeof pricing.observedAt === "string" && Number.isFinite(Date.parse(pricing.observedAt))
      ? pricing.observedAt
      : fallbackObservedAt.toISOString();
  return {
    currency: "USD" as const,
    observedAt,
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function mergePriceEstimates(estimates: CoursePriceEstimate[]) {
  const nineHoles = mergeRanges(estimates.flatMap((estimate) => estimate.nineHoles ?? []));
  const eighteenHoles = mergeRanges(estimates.flatMap((estimate) => estimate.eighteenHoles ?? []));
  const observedAt = estimates.reduce(
    (latest, estimate) => Date.parse(estimate.observedAt) > Date.parse(latest) ? estimate.observedAt : latest,
    estimates[0].observedAt
  );
  return {
    currency: "USD" as const,
    observedAt,
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function buildEstimateFromPrices(pricesByHoles: Map<9 | 18, number[]>, observedAt: Date) {
  const nineHoles = buildRange(pricesByHoles.get(9) ?? []);
  const eighteenHoles = buildRange(pricesByHoles.get(18) ?? []);
  if (!nineHoles && !eighteenHoles) return undefined;
  return {
    currency: "USD" as const,
    observedAt: observedAt.toISOString(),
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function buildRange(prices: number[]) {
  if (prices.length === 0) return undefined;
  return {
    minPriceCents: Math.min(...prices),
    maxPriceCents: Math.max(...prices),
    sampleSize: prices.length
  };
}

function mergeRanges(ranges: CoursePriceRange[]) {
  if (ranges.length === 0) return undefined;
  return {
    minPriceCents: Math.min(...ranges.map((range) => range.minPriceCents)),
    maxPriceCents: Math.max(...ranges.map((range) => range.maxPriceCents)),
    sampleSize: ranges.reduce((total, range) => total + range.sampleSize, 0)
  };
}

function parseRange(value: unknown): CoursePriceRange | undefined {
  if (!isRecord(value) || !isPrice(value.minPriceCents) || !isPrice(value.maxPriceCents) ||
    typeof value.sampleSize !== "number" || !Number.isInteger(value.sampleSize) ||
    value.sampleSize < 1 || value.minPriceCents > value.maxPriceCents) return undefined;
  return {
    minPriceCents: value.minPriceCents,
    maxPriceCents: value.maxPriceCents,
    sampleSize: value.sampleSize
  };
}

function isSupportedHoles(value: unknown): value is 9 | 18 {
  return value === 9 || value === 18;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
