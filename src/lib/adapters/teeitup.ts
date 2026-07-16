import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";
import {
  getBookingWindowFromEvidence,
  parseBookingReleaseMessage,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";

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
  courseId?: string;
  message?: string;
};

export type TeeItUpTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
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
  return (await fetchTeeItUpTeeSheet(input)).slots;
}

export async function fetchTeeItUpTeeSheet(input: {
  courseId: string;
  date: Date;
  metadata: TeeItUpMetadata;
}): Promise<TeeItUpTeeSheetResult> {
  const slots: TeeTimeSlot[] = [];
  let bookingWindowEvidence: BookingWindowEvidence | null = null;

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
      if (day.message) {
        const facility =
          (day.courseId && facilityByCourseId.get(day.courseId)) || defaultFacility;
        const evidence = parseBookingReleaseMessage({
          message: day.message,
          targetDate: input.date,
          timeZone: facility?.timeZone ?? "America/New_York",
          evidenceUrl: buildTeeTimesUrl(input.date, facilityIds).toString()
        });
        bookingWindowEvidence = pickEarlierBookingWindow(
          input.date,
          facility?.timeZone ?? "America/New_York",
          bookingWindowEvidence,
          evidence
        );
      }

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
          priceOptions: getPriceOptions(slot.rates),
          evidenceUrl: buildTeeTimesUrl(input.date, facilityIds).toString()
        });
      }
    }
  }

  return {
    slots,
    targetDateStatus:
      bookingWindowEvidence ? "NOT_OPEN" : slots.length > 0 ? "OPEN" : "UNKNOWN",
    bookingWindowEvidence
  };
}

function pickEarlierBookingWindow(
  targetDate: Date,
  timeZone: string,
  current: BookingWindowEvidence | null,
  candidate: BookingWindowEvidence | null
) {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentWindow = getBookingWindowFromEvidence(targetDate, timeZone, current);
  const candidateWindow = getBookingWindowFromEvidence(targetDate, timeZone, candidate);
  return candidateWindow && currentWindow && candidateWindow.opensAt < currentWindow.opensAt
    ? candidate
    : current;
}

async function fetchFacilities(alias: string, bookingBaseUrl: string) {
  const url = `${TEEITUP_API_BASE_URL}/alias/${alias}/facilities`;
  const response = await fetchWithProviderTimeout(url, {
    headers: teeItUpHeaders(alias, bookingBaseUrl)
  });

  if (!response.ok) {
    throw providerHttpError("TeeItUp facilities", response);
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
  const response = await fetchWithProviderTimeout(url.toString(), {
    headers: teeItUpHeaders(alias, bookingBaseUrl)
  });

  if (!response.ok) {
    throw providerHttpError("TeeItUp tee times", response);
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

function getPriceOptions(rates: TeeItUpRate[] = []): NonNullable<TeeTimeSlot["priceOptions"]> {
  return rates.flatMap((rate) =>
    (rate.holes === 9 || rate.holes === 18) &&
    typeof rate.greenFeeCart === "number" &&
    Number.isInteger(rate.greenFeeCart) &&
    rate.greenFeeCart >= 0
      ? [{ holes: rate.holes as 9 | 18, priceCents: rate.greenFeeCart }]
      : []
  );
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
