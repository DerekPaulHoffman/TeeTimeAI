import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type CoursePriceRange = {
  minPriceCents: number;
  maxPriceCents: number;
  sampleSize: number;
};

export type CoursePriceEstimate = {
  currency: "USD";
  observedAt: string;
  nineHoles?: CoursePriceRange;
  eighteenHoles?: CoursePriceRange;
};

export type CoursePriceView = "any" | "9" | "18";

type CoursePriceEvidence = {
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

export function hasPriceForView(
  estimate: CoursePriceEstimate | undefined,
  priceView: CoursePriceView
) {
  if (priceView === "any") return true;
  return priceView === "9" ? Boolean(estimate?.nineHoles) : Boolean(estimate?.eighteenHoles);
}

export function buildCoursePriceEstimate(
  evidence: CoursePriceEvidence
): CoursePriceEstimate | undefined {
  const probeSnapshots = evidence.probes
    .map((probe) => parseStoredPriceSnapshot(probe.rawSummary, probe.observedAt))
    .filter((snapshot): snapshot is CoursePriceEstimate => snapshot !== undefined);

  if (probeSnapshots.length > 0) return mergePriceEstimates(probeSnapshots);

  const pricesByHoles = new Map<9 | 18, number[]>([[9, []], [18, []]]);
  let observedAt: Date | undefined;
  for (const match of evidence.matches) {
    if (!isSupportedHoles(match.holes) || !isPrice(match.priceCents)) continue;
    pricesByHoles.get(match.holes)?.push(match.priceCents);
    if (!observedAt || match.lastConfirmedAt > observedAt) observedAt = match.lastConfirmedAt;
  }

  return observedAt ? buildEstimateFromPrices(pricesByHoles, observedAt) : undefined;
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
