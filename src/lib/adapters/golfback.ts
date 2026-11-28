import {
  getBookingWindowFromEvidence,
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const GOLFBACK_API_BASE_URL = "https://api.golfback.com";
const GOLFBACK_COURSE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOLFBACK_LOCAL_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/u;

export type GolfBackMetadata = {
  provider: "GOLFBACK";
  courseId: string;
  bookingBaseUrl: string;
};

type GolfBackCourseResponse = {
  data?: {
    teeTimesDaysOut?: number;
  };
};

type GolfBackPrice = {
  holes?: number;
  price?: number | null;
};

type GolfBackTeeTime = {
  id?: string;
  courseId?: string;
  localDateTime?: string;
  isAvailable?: boolean;
  playersMax?: number;
  holes?: number[];
  primaryPrices?: GolfBackPrice[];
};

type GolfBackTeeTimeResponse = {
  data?: GolfBackTeeTime[];
};

export type GolfBackTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function isGolfBackMetadata(value: unknown): value is GolfBackMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<GolfBackMetadata>;
  if (
    metadata.provider !== "GOLFBACK" ||
    typeof metadata.courseId !== "string" ||
    !GOLFBACK_COURSE_ID.test(metadata.courseId) ||
    typeof metadata.bookingBaseUrl !== "string"
  ) {
    return false;
  }

  try {
    const bookingUrl = new URL(metadata.bookingBaseUrl);
    return (
      bookingUrl.protocol === "https:" &&
      bookingUrl.hostname === "golfback.com" &&
      bookingUrl.hash.toLowerCase() === `#/course/${metadata.courseId.toLowerCase()}`
    );
  } catch {
    return false;
  }
}

export async function fetchGolfBackTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    timeZone?: string;
    metadata: GolfBackMetadata;
    discoverBookingWindow?: boolean;
  },
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<GolfBackTeeSheetResult> {
  if (!isGolfBackMetadata(input.metadata)) throw new Error("Invalid GolfBack course metadata");
  const bookingWindowEvidence = input.discoverBookingWindow
    ? await fetchGolfBackBookingWindow(input.metadata, fetchImpl)
    : null;
  if (bookingWindowEvidence) {
    const bookingWindow = getBookingWindowFromEvidence(
      input.date,
      input.timeZone ?? "America/New_York",
      bookingWindowEvidence
    );
    if (bookingWindow && bookingWindow.opensAt > now) {
      return { slots: [], targetDateStatus: "NOT_OPEN", bookingWindowEvidence };
    }
  }

  const targetDate = input.date.toISOString().slice(0, 10);
  const evidenceUrl = `${GOLFBACK_API_BASE_URL}/api/v1/courses/${input.metadata.courseId}/date/${targetDate}/teetimes`;
  const response = await fetchWithProviderTimeout(evidenceUrl, {
    method: "POST",
    headers: golfBackHeaders(true),
    body: JSON.stringify({ sessionId: null })
  }, fetchImpl);
  if (!response.ok) {
    throw providerHttpError("GolfBack tee times", response);
  }

  const payload = (await response.json().catch(() => null)) as GolfBackTeeTimeResponse | null;
  if (!Array.isArray(payload?.data)) {
    throw new Error("GolfBack returned an unexpected tee-time schema");
  }

  const slots = payload.data.flatMap((teeTime): TeeTimeSlot[] => {
    if (
      !teeTime || typeof teeTime.id !== "string" || !teeTime.id.trim() ||
      typeof teeTime.localDateTime !== "string" || !GOLFBACK_LOCAL_DATE_TIME.test(teeTime.localDateTime) ||
      teeTime.localDateTime.slice(0, 10) !== targetDate ||
      (teeTime.courseId !== undefined && (typeof teeTime.courseId !== "string" ||
        teeTime.courseId.toLowerCase() !== input.metadata.courseId.toLowerCase())) ||
      typeof teeTime.isAvailable !== "boolean"
    ) {
      throw new Error("GolfBack returned an unexpected tee-time schema");
    }
    if (!teeTime.isAvailable) return [];
    const playersMax = teeTime.playersMax;
    if (typeof playersMax !== "number" || !Number.isInteger(playersMax) || playersMax < 0) {
      throw new Error("GolfBack returned an unexpected tee-time schema");
    }
    if (playersMax < input.players) return [];

    if (teeTime.holes != null && !Array.isArray(teeTime.holes)) {
      throw new Error("GolfBack returned an unexpected tee-time schema");
    }
    const bookableHoleCounts = (teeTime.holes ?? []).filter(
      (holes): holes is 9 | 18 => holes === 9 || holes === 18
    );
    const priceOptions = (Array.isArray(teeTime.primaryPrices) ? teeTime.primaryPrices : []).flatMap(
      (
        price
      ): Array<{
        holes: 9 | 18;
        priceCents: number;
      }> => {
        if (
          (price?.holes !== 9 && price?.holes !== 18) ||
          typeof price.price !== "number" ||
          !Number.isFinite(price.price)
        ) {
          return [];
        }
        return [{ holes: price.holes, priceCents: Math.round(price.price * 100) }];
      }
    );

    return [
      {
        sourceId: `golfback-${teeTime.id}`,
        courseId: input.courseId,
        startsAt: teeTime.localDateTime.slice(0, 16),
        availableSpots: playersMax,
        bookingUrl: input.metadata.bookingBaseUrl,
        priceCents:
          priceOptions.find((price) => price.holes === 18)?.priceCents ??
          priceOptions[0]?.priceCents,
        bookableHoleCounts,
        priceOptions,
        evidenceUrl
      }
    ];
  });

  return { slots, targetDateStatus: "OPEN", bookingWindowEvidence };
}

async function fetchGolfBackBookingWindow(
  metadata: GolfBackMetadata,
  fetchImpl: typeof fetch
): Promise<BookingWindowEvidence | null> {
  const evidenceUrl = `${GOLFBACK_API_BASE_URL}/api/v1/courses/${metadata.courseId}`;
  const response = await fetchWithProviderTimeout(evidenceUrl, {
    headers: golfBackHeaders(false)
  }, fetchImpl);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as GolfBackCourseResponse;
  const daysAhead = payload.data?.teeTimesDaysOut;
  if (
    !Number.isInteger(daysAhead) ||
    daysAhead == null ||
    daysAhead < 0 ||
    daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD
  ) {
    return null;
  }

  return {
    daysAhead,
    releaseTimeLocal: null,
    source: "PROVIDER_CONFIG",
    confidence: 1,
    evidenceUrl
  };
}

function golfBackHeaders(includeContentType: boolean) {
  return {
    Accept: "application/json",
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
  };
}
