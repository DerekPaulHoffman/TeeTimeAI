import type { TeeTimeSlot } from "@/lib/tee-times/matching";
import {
  parsePublicBookingWindowRule,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";

export type ForeupMetadata = {
  scheduleId: number;
  bookingClassId?: number;
  bookingBaseUrl: string;
};

type ForeupApiSlot = {
  time?: string;
  available_spots?: number;
  green_fee?: number;
  holes?: number | string;
  schedule_id?: number;
  booking_class_id?: number;
};

export type ForeupTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function isForeupMetadata(value: unknown): value is ForeupMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<ForeupMetadata>;
  return (
    typeof metadata.scheduleId === "number" &&
    (metadata.bookingClassId === undefined || typeof metadata.bookingClassId === "number") &&
    typeof metadata.bookingBaseUrl === "string"
  );
}

export async function fetchForeupSlots(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: ForeupMetadata;
}): Promise<TeeTimeSlot[]> {
  return (await fetchForeupTeeSheet(input)).slots;
}

export async function fetchForeupTeeSheet(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: ForeupMetadata;
  discoverBookingWindow?: boolean;
}): Promise<ForeupTeeSheetResult> {
  const [availability, bookingWindowEvidence] = await Promise.all([
    fetchForeupAvailability(input),
    input.discoverBookingWindow
      ? fetchForeupBookingWindow(input.metadata)
      : Promise.resolve(null)
  ]);
  return { ...availability, bookingWindowEvidence };
}

async function fetchForeupAvailability(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: ForeupMetadata;
}): Promise<Pick<ForeupTeeSheetResult, "slots" | "targetDateStatus">> {
  const dateParam = formatForeupDate(input.date);
  const url = new URL("https://foreupsoftware.com/index.php/api/booking/times");
  url.searchParams.set("time", "all");
  url.searchParams.set("date", dateParam);
  url.searchParams.set("holes", "all");
  url.searchParams.set("players", String(input.players));
  url.searchParams.set("schedule_id", String(input.metadata.scheduleId));
  if (input.metadata.bookingClassId !== undefined) {
    url.searchParams.set("booking_class", String(input.metadata.bookingClassId));
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`ForeUP returned ${response.status}`);
  }

  const slots = (await response.json()) as ForeupApiSlot[] | false;
  if (!Array.isArray(slots)) {
    return { slots: [], targetDateStatus: "UNKNOWN" };
  }

  const normalizedSlots = slots
    .filter((slot) => slot.time && slot.available_spots)
    .map((slot) => {
      const bookableHoleCounts = normalizeForeupBookableHoleCounts(slot.holes);
      return {
        courseId: input.courseId,
        sourceId: `foreup-${input.metadata.scheduleId}-${slot.time}`,
        startsAt: normalizeForeupTime(slot.time as string),
        availableSpots: slot.available_spots ?? 0,
        bookingUrl: input.metadata.bookingBaseUrl,
        priceCents:
          typeof slot.green_fee === "number" ? Math.round(slot.green_fee * 100) : undefined,
        holes: bookableHoleCounts.length === 1 ? bookableHoleCounts[0] : undefined,
        ...(bookableHoleCounts.length > 1 ? { bookableHoleCounts } : {}),
        evidenceUrl: url.toString()
      };
    });

  return {
    slots: normalizedSlots,
    targetDateStatus: normalizedSlots.length > 0 ? "OPEN" : "UNKNOWN"
  };
}

async function fetchForeupBookingWindow(
  metadata: ForeupMetadata
): Promise<BookingWindowEvidence | null> {
  try {
    const response = await fetch(metadata.bookingBaseUrl, {
      headers: { accept: "text/html,application/xhtml+xml" }
    });
    if (!response.ok) {
      return null;
    }
    return parsePublicBookingWindowRule(await response.text(), metadata.bookingBaseUrl);
  } catch {
    return null;
  }
}

function formatForeupDate(date: Date) {
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return `${month}-${day}-${year}`;
}

function normalizeForeupTime(time: string) {
  if (/^\d{4}-\d{2}-\d{2} /.test(time)) {
    return time.replace(" ", "T");
  }

  return time;
}

function normalizeForeupBookableHoleCounts(holes: ForeupApiSlot["holes"]): Array<9 | 18> {
  const values = typeof holes === "string" ? holes.match(/\b(?:9|18)\b/g) ?? [] : [holes];
  const observed = new Set(
    values
      .map(Number)
      .filter((value): value is 9 | 18 => value === 9 || value === 18)
  );
  return ([9, 18] as const).filter((value) => observed.has(value));
}
