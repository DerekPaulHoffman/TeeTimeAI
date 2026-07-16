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

  const payload = (await response.json()) as GolfBackTeeTimeResponse;
  if (!Array.isArray(payload.data)) {
    return { slots: [], targetDateStatus: "UNKNOWN", bookingWindowEvidence };
  }

  const slots = payload.data.flatMap((teeTime): TeeTimeSlot[] => {
    if (
      teeTime.isAvailable !== true ||
      !teeTime.id ||
      !teeTime.localDateTime ||
      !Number.isInteger(teeTime.playersMax) ||
      (teeTime.playersMax ?? 0) < input.players
    ) {
      return [];
    }

    const playersMax = teeTime.playersMax as number;
    const bookableHoleCounts = (teeTime.holes ?? []).filter(
      (holes): holes is 9 | 18 => holes === 9 || holes === 18
    );
    const priceOptions = (teeTime.primaryPrices ?? []).flatMap(
      (
        price
      ): Array<{
        holes: 9 | 18;
        priceCents: number;
      }> => {
        if (
          (price.holes !== 9 && price.holes !== 18) ||
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
