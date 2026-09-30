import { normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezones";

export const MIN_INVENTORY_HORIZON_SAMPLES = 3;
export const MIN_TRAILING_UNAVAILABLE_DAYS = 2;
export const MIN_INVENTORY_HORIZON_CONFIDENCE = 0.8;
export const MAX_INVENTORY_HORIZON_DAYS_AHEAD = 45;

export type InventoryDateObservation = {
  targetDate: string;
  status: "AVAILABLE" | "NO_AVAILABILITY";
};

export type InventoryHorizonSnapshot = {
  observedLocalDate: string;
  inventoryThroughDate: string;
  daysAhead: number;
  trailingUnavailableDays: number;
  observedAt: Date;
  evidenceUrl: string;
};

export type LearnedInventoryHorizon = {
  daysAhead: number;
  confidence: number;
  sampleCount: number;
  observedAt: Date;
};

export type CourseObservedInventoryHorizonFields = {
  timeZone?: string | null;
  observedInventoryHorizonDaysAhead?: number | null;
  observedInventoryHorizonConfidence?: number | null;
  observedInventoryHorizonSampleCount?: number | null;
  observedInventoryHorizonObservedAt?: Date | null;
};

export function buildInventoryHorizonSnapshot(input: {
  observedLocalDate: string;
  observations: InventoryDateObservation[];
  observedAt: Date;
  evidenceUrl: string;
}): InventoryHorizonSnapshot | null {
  if (!isIsoDate(input.observedLocalDate) || !isPublicHttpUrl(input.evidenceUrl)) return null;

  const byDate = new Map<string, InventoryDateObservation["status"]>();
  for (const observation of input.observations) {
    if (!isIsoDate(observation.targetDate)) continue;
    byDate.set(observation.targetDate, observation.status);
  }
  const availableDates = [...byDate.entries()]
    .filter(([, status]) => status === "AVAILABLE")
    .map(([date]) => date)
    .filter((date) => differenceInIsoCalendarDays(date, input.observedLocalDate) >= 0)
    .sort();
  const inventoryThroughDate = availableDates.at(-1);
  if (!inventoryThroughDate) return null;

  let trailingUnavailableDays = 0;
  for (let offset = 1; offset <= MAX_INVENTORY_HORIZON_DAYS_AHEAD; offset += 1) {
    const status = byDate.get(addIsoDateDays(inventoryThroughDate, offset));
    if (status !== "NO_AVAILABILITY") break;
    trailingUnavailableDays += 1;
  }
  const daysAhead = differenceInIsoCalendarDays(
    inventoryThroughDate,
    input.observedLocalDate
  );
  if (
    daysAhead < 0 ||
    daysAhead > MAX_INVENTORY_HORIZON_DAYS_AHEAD ||
    trailingUnavailableDays < MIN_TRAILING_UNAVAILABLE_DAYS
  ) {
    return null;
  }

  return {
    observedLocalDate: input.observedLocalDate,
    inventoryThroughDate,
    daysAhead,
    trailingUnavailableDays,
    observedAt: input.observedAt,
    evidenceUrl: input.evidenceUrl
  };
}

export function inferLearnedInventoryHorizon(
  snapshots: InventoryHorizonSnapshot[]
): LearnedInventoryHorizon | null {
  const distinct = new Map<string, InventoryHorizonSnapshot>();
  for (const snapshot of snapshots) {
    const current = distinct.get(snapshot.observedLocalDate);
    if (!current || current.observedAt < snapshot.observedAt) {
      distinct.set(snapshot.observedLocalDate, snapshot);
    }
  }
  const ordered = [...distinct.values()].sort((left, right) =>
    left.observedLocalDate.localeCompare(right.observedLocalDate)
  );
  const latest = ordered.at(-1);
  if (!latest) return null;

  const matching: InventoryHorizonSnapshot[] = [latest];
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const candidate = ordered[index];
    const newer = matching[0];
    if (
      differenceInIsoCalendarDays(newer.observedLocalDate, candidate.observedLocalDate) !== 1 ||
      differenceInIsoCalendarDays(newer.inventoryThroughDate, candidate.inventoryThroughDate) !== 1 ||
      candidate.daysAhead !== latest.daysAhead
    ) {
      break;
    }
    matching.unshift(candidate);
  }
  if (matching.length < MIN_INVENTORY_HORIZON_SAMPLES) return null;

  return {
    daysAhead: latest.daysAhead,
    confidence: Math.min(0.95, 0.8 + (matching.length - MIN_INVENTORY_HORIZON_SAMPLES) * 0.05),
    sampleCount: matching.length,
    observedAt: latest.observedAt
  };
}

export function getObservedInventoryReleaseForTargetDate(
  targetDate: Date | string,
  course: CourseObservedInventoryHorizonFields,
  fallbackTimeZone = "America/New_York"
) {
  const daysAhead = course.observedInventoryHorizonDaysAhead;
  const confidence = course.observedInventoryHorizonConfidence;
  const sampleCount = course.observedInventoryHorizonSampleCount ?? 0;
  if (
    !Number.isInteger(daysAhead) ||
    daysAhead == null ||
    daysAhead < 0 ||
    daysAhead > MAX_INVENTORY_HORIZON_DAYS_AHEAD ||
    confidence == null ||
    confidence < MIN_INVENTORY_HORIZON_CONFIDENCE ||
    sampleCount < MIN_INVENTORY_HORIZON_SAMPLES
  ) {
    return null;
  }
  const targetIsoDate = toIsoDate(targetDate);
  const releaseDate = addIsoDateDays(targetIsoDate, -daysAhead);
  const timeZone = normalizeTimeZone(course.timeZone, fallbackTimeZone);
  return {
    releaseDate,
    releaseTimeLocal: null,
    opensAt: zonedDateTimeToDate(`${releaseDate}T00:00:00`, timeZone),
    timeZone,
    exactTime: false,
    source: "OBSERVED_INVENTORY" as const,
    confidence,
    evidenceUrl: null,
    sampleCount
  };
}

export function getCourseLocalDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function addIsoDateDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function differenceInIsoCalendarDays(later: string, earlier: string) {
  const [laterYear, laterMonth, laterDay] = later.split("-").map(Number);
  const [earlierYear, earlierMonth, earlierDay] = earlier.split("-").map(Number);
  return Math.round(
    (Date.UTC(laterYear, laterMonth - 1, laterDay) -
      Date.UTC(earlierYear, earlierMonth - 1, earlierDay)) /
      86_400_000
  );
}

function toIsoDate(value: Date | string) {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
