import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const TEEITUP_API_BASE_URL = "https://phx-api-be-east-1b.kenna.io";

export type TeeItUpMetadata = {
  aliases: string[];
  bookingBaseUrl: string;
};

type TeeItUpFacility = {
  id?: number;
  courseId?: string;
  name?: string;
  timeZone?: string;
};

type TeeItUpRate = {
  _id?: number | string;
  allowedPlayers?: number[];
  holes?: number;
  greenFeeCart?: number;
};

type TeeItUpApiSlot = {
  courseId?: string;
  teetime?: string;
  rates?: TeeItUpRate[];
};

type TeeItUpApiDay = {
  teetimes?: TeeItUpApiSlot[];
};

export function isTeeItUpMetadata(value: unknown): value is TeeItUpMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<TeeItUpMetadata>;
  return (
    Array.isArray(metadata.aliases) &&
    metadata.aliases.length > 0 &&
    metadata.aliases.every((alias) => typeof alias === "string" && alias.length > 0) &&
    typeof metadata.bookingBaseUrl === "string"
  );
}

export async function fetchTeeItUpSlots(input: {
  courseId: string;
  date: Date;
  metadata: TeeItUpMetadata;
}): Promise<TeeTimeSlot[]> {
  const slots: TeeTimeSlot[] = [];

  for (const alias of input.metadata.aliases) {
    const facilities = await fetchFacilities(alias, input.metadata.bookingBaseUrl);
    if (facilities.length === 0) {
      continue;
    }

    const facilityIds = facilities
      .map((facility) => facility.id)
      .filter((id): id is number => typeof id === "number");
    if (facilityIds.length === 0) {
      continue;
    }

    const daySlots = await fetchFacilitySlots(
      alias,
      input.date,
      facilityIds,
      input.metadata.bookingBaseUrl
    );
    const facilityByCourseId = new Map(
      facilities
        .filter((facility) => facility.courseId)
        .map((facility) => [facility.courseId as string, facility])
    );
    const defaultFacility = facilities[0];

    for (const day of daySlots) {
      for (const slot of day.teetimes ?? []) {
        if (!slot.teetime) {
          continue;
        }

        const rate = pickBestRate(slot.rates);
        const availableSpots = getAvailableSpots(slot.rates);
        if (availableSpots < 1) {
          continue;
        }

        const facility = (slot.courseId && facilityByCourseId.get(slot.courseId)) || defaultFacility;
        if (!facility?.id) {
          continue;
        }

        slots.push({
          courseId: input.courseId,
          sourceId: `teeitup-${facility.id}-${slot.courseId ?? "course"}-${slot.teetime}`,
          startsAt: toLocalDateTime(slot.teetime, facility.timeZone ?? "America/New_York"),
          availableSpots,
          bookingUrl: withDateParam(input.metadata.bookingBaseUrl, input.date),
          priceCents: rate?.greenFeeCart,
          holes: rate?.holes,
          evidenceUrl: buildTeeTimesUrl(input.date, facilityIds).toString()
        });
      }
    }
  }

  return slots;
}

async function fetchFacilities(alias: string, bookingBaseUrl: string) {
  const url = `${TEEITUP_API_BASE_URL}/alias/${alias}/facilities`;
  const response = await fetch(url, {
    headers: teeItUpHeaders(alias, bookingBaseUrl)
  });

  if (!response.ok) {
    throw new Error(`TeeItUp facilities returned ${response.status}`);
  }

  return (await response.json()) as TeeItUpFacility[];
}

async function fetchFacilitySlots(
  alias: string,
  date: Date,
  facilityIds: number[],
  bookingBaseUrl: string
) {
  const url = buildTeeTimesUrl(date, facilityIds);
  const response = await fetch(url.toString(), {
    headers: teeItUpHeaders(alias, bookingBaseUrl)
  });

  if (!response.ok) {
    throw new Error(`TeeItUp tee times returned ${response.status}`);
  }

  return (await response.json()) as TeeItUpApiDay[];
}

function buildTeeTimesUrl(date: Date, facilityIds: number[]) {
  const url = new URL(`${TEEITUP_API_BASE_URL}/v2/tee-times`);
  url.searchParams.set("date", formatDate(date));
  url.searchParams.set("facilityIds", facilityIds.join(","));
  url.searchParams.set("returnPromotedRates", "true");
  return url;
}

function teeItUpHeaders(alias: string, bookingBaseUrl: string) {
  const bookingOrigin = getBookingOrigin(alias, bookingBaseUrl);

  return {
    accept: "application/json",
    "x-be-alias": alias,
    origin: bookingOrigin,
    referer: `${bookingOrigin}/`
  };
}

function getBookingOrigin(alias: string, bookingBaseUrl: string) {
  try {
    const bookingUrl = new URL(bookingBaseUrl);
    const domainMatch = bookingUrl.hostname.match(/\.book\.teeitup\.(golf|com)$/i);
    if (domainMatch?.[1]) {
      return `https://${alias}.book.teeitup.${domainMatch[1].toLowerCase()}`;
    }
  } catch {
    // Metadata validation only guarantees a string; keep the legacy provider origin as fallback.
  }

  return `https://${alias}.book.teeitup.golf`;
}

function pickBestRate(rates: TeeItUpRate[] = []) {
  return [...rates].sort((a, b) => (b.holes ?? 0) - (a.holes ?? 0))[0];
}

function getAvailableSpots(rates: TeeItUpRate[] = []) {
  return Math.max(0, ...rates.flatMap((rate) => rate.allowedPlayers ?? []));
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toLocalDateTime(isoTime: string, timeZone: string) {
  const date = new Date(isoTime);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}T${byType.get("hour")}:${byType.get("minute")}`;
}

function withDateParam(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", formatDate(date));
  return url.toString();
}
