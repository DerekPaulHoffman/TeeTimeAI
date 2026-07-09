import type { TeeTimeSlot } from "@/lib/tee-times/matching";

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

  const slots = (await response.json()) as ForeupApiSlot[];
  return slots
    .filter((slot) => slot.time && slot.available_spots)
    .map((slot) => ({
      courseId: input.courseId,
      sourceId: `foreup-${input.metadata.scheduleId}-${slot.time}`,
      startsAt: normalizeForeupTime(slot.time as string),
      availableSpots: slot.available_spots ?? 0,
      bookingUrl: input.metadata.bookingBaseUrl,
      priceCents:
        typeof slot.green_fee === "number" ? Math.round(slot.green_fee * 100) : undefined,
      holes: normalizeForeupHoles(slot.holes),
      evidenceUrl: url.toString()
    }));
}

function formatForeupDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}-${date.getFullYear()}`;
}

function normalizeForeupTime(time: string) {
  if (/^\d{4}-\d{2}-\d{2} /.test(time)) {
    return time.replace(" ", "T");
  }

  return time;
}

function normalizeForeupHoles(holes: ForeupApiSlot["holes"]) {
  if (Number.isInteger(holes)) {
    return holes as number;
  }

  if (typeof holes === "string" && /^\d+$/.test(holes)) {
    return Number(holes);
  }

  return undefined;
}
