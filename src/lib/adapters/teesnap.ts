import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";
import {
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  normalizeReleaseTime,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";

export type TeesnapMetadata = {
  provider: "TEESNAP";
  courseId: number;
  bookingBaseUrl: string;
  defaultHoles?: 9 | 18;
  defaultAddons?: string;
  publicApiVersion?: "BOOKINGSITE_V1";
};

export const TEESNAP_PUBLIC_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

type TeesnapBooking = {
  bookingId?: number;
  golfers?: unknown[];
};

type TeesnapPrice = {
  roundType?: "NINE_HOLE" | "EIGHTEEN_HOLE";
  price?: string;
};

type TeesnapSection = {
  teeOff?: string;
  bookings?: number[];
  isHeld?: boolean;
};

type TeesnapApiSlot = {
  teeTime?: string;
  prices?: TeesnapPrice[];
  teeOffSections?: TeesnapSection[];
};

type TeesnapResponse = {
  errors?: string;
  teeTimes?: {
    bookings?: TeesnapBooking[];
    teeTimes?: TeesnapApiSlot[];
  };
};

type TeesnapCourseConfig = {
  id?: number;
  advance?: number;
  start_availability_time?: string;
};

export type TeesnapTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export type TeesnapTeeSheetInput = {
  courseId: string;
  date: Date;
  players: number;
  metadata: TeesnapMetadata;
  discoverBookingWindow?: boolean;
  /** Learned recipes must prove the complete public day before returning slots. */
  strictPublicEvidence?: true;
};

export const TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE = "TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE";

export function isTeesnapMetadata(value: unknown): value is TeesnapMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<TeesnapMetadata>;
  return (
    metadata.provider === "TEESNAP" &&
    typeof metadata.courseId === "number" &&
    typeof metadata.bookingBaseUrl === "string" &&
    (metadata.defaultHoles === undefined || metadata.defaultHoles === 9 || metadata.defaultHoles === 18) &&
    (metadata.defaultAddons === undefined || typeof metadata.defaultAddons === "string") &&
    (metadata.publicApiVersion === undefined || metadata.publicApiVersion === "BOOKINGSITE_V1")
  );
}

export async function fetchTeesnapSlots(input: TeesnapTeeSheetInput, fetchImpl: typeof fetch = fetch): Promise<TeeTimeSlot[]> {
  return (await fetchTeesnapTeeSheet(input, fetchImpl)).slots;
}

export async function fetchTeesnapTeeSheet(input: TeesnapTeeSheetInput, fetchImpl: typeof fetch = fetch): Promise<TeesnapTeeSheetResult> {
  const availability = await fetchTeesnapAvailability(input, fetchImpl);
  const bookingWindowEvidence = input.discoverBookingWindow
    ? await fetchTeesnapBookingWindow(input.metadata, fetchImpl)
    : null;

  return {
    ...availability,
    bookingWindowEvidence
  };
}

async function fetchTeesnapAvailability(input: TeesnapTeeSheetInput, fetchImpl: typeof fetch): Promise<Pick<TeesnapTeeSheetResult, "slots" | "targetDateStatus">> {
  const modern = input.metadata.publicApiVersion === "BOOKINGSITE_V1";
  if (input.metadata.publicApiVersion !== undefined && !modern) incomplete();
  if ((input.strictPublicEvidence || modern) && !Number.isFinite(input.date.getTime())) incomplete();
  if (modern && (!positiveId(input.metadata.courseId) || !Number.isInteger(input.players) || input.players < 1 || input.players > 4 ||
      !isTeesnapMetadata(input.metadata))) incomplete();
  const holes = input.metadata.defaultHoles ?? 18;
  const url = buildTeeTimesUrl(input.metadata, input.date, input.players, holes);
  const response = await fetchWithProviderTimeout(url, {
    headers: teesnapHeaders(input.metadata.bookingBaseUrl)
  }, fetchImpl);
  let payload = (await response.json().catch(() => null)) as TeesnapResponse | null;

  if (!response.ok) {
    if (!modern && payload?.errors === "date_not_allowed") {
      return { slots: [], targetDateStatus: "NOT_OPEN" };
    }
    throw providerHttpError("Teesnap tee times", response);
  }

  if (input.strictPublicEvidence || modern) {
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) incomplete();
    payload = strictPublicDay(payload, input.date, modern);
  }

  const teeTimes = payload?.teeTimes?.teeTimes;
  if (!Array.isArray(teeTimes)) {
    return { slots: [], targetDateStatus: "UNKNOWN" };
  }

  const bookingSizes = new Map(
    (payload?.teeTimes?.bookings ?? [])
      .filter((booking) => typeof booking.bookingId === "number")
      .map((booking) => [booking.bookingId as number, booking.golfers?.length ?? 0])
  );
  const slots: TeeTimeSlot[] = [];

  for (const teeTime of teeTimes) {
    if (!teeTime.teeTime) {
      continue;
    }

    const availableSpots = Math.max(
      0,
      ...(teeTime.teeOffSections ?? [])
        .filter((section) => !section.isHeld)
        .map((section) => getAvailableSpots(section, bookingSizes))
    );
    if (availableSpots < 1) {
      continue;
    }

    const priceOptions = getPriceOptions(teeTime.prices);
    if (modern && !priceOptions.some(option => option.holes === holes && option.priceCents > 0)) continue;

    slots.push({
      courseId: input.courseId,
      sourceId: `teesnap-${input.metadata.courseId}-${teeTime.teeTime}`,
      startsAt: teeTime.teeTime.slice(0, 16),
      availableSpots,
      bookingUrl: withDateParam(input.metadata.bookingBaseUrl, input.date),
      priceCents: priceOptions.find((option) => option.holes === holes)?.priceCents,
      holes,
      priceOptions,
      evidenceUrl: url
    });
  }

  return { slots, targetDateStatus: "OPEN" };
}

async function fetchTeesnapBookingWindow(
  metadata: TeesnapMetadata,
  fetchImpl: typeof fetch
): Promise<BookingWindowEvidence | null> {
  try {
    const evidenceUrl = new URL("/", metadata.bookingBaseUrl).toString();
    const response = await fetchWithProviderTimeout(evidenceUrl, {
      headers: teesnapHeaders(metadata.bookingBaseUrl)
    }, fetchImpl);
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const match = html.match(/window\.courses\s*=\s*(\[[\s\S]*?\]);\s*window\.property/i);
    if (!match) {
      return null;
    }

    const courses = JSON.parse(match[1]) as TeesnapCourseConfig[];
    const course = courses.find((candidate) => candidate.id === metadata.courseId);
    if (
      !course ||
      !Number.isInteger(course.advance) ||
      course.advance == null ||
      course.advance < 0 ||
      course.advance > MAX_BOOKING_WINDOW_DAYS_AHEAD
    ) {
      return null;
    }

    return {
      daysAhead: course.advance,
      releaseTimeLocal: normalizeReleaseTime(course.start_availability_time),
      source: "PROVIDER_CONFIG",
      confidence: 1,
      evidenceUrl
    };
  } catch {
    return null;
  }
}

function incomplete(): never { throw new Error(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

/** Validate every row before any legacy normalization can skip an invalid entry. */
function strictPublicDay(value: unknown, date: Date, modern = false): TeesnapResponse {
  if (!record(value) || value.errors !== undefined && value.errors !== "" || !record(value.teeTimes)) incomplete();
  const day = value.teeTimes;
  const globalGolfers = new Set<number>();
  if (modern) {
    if (Object.keys(value).length !== 1 || Object.keys(day).sort().join(",") !== "bookings,golfers,teeSheetPriceOverrides,teeTimes" ||
        !Array.isArray(day.golfers) || day.golfers.length > 8_000 ||
        !Array.isArray(day.teeSheetPriceOverrides) || day.teeSheetPriceOverrides.length !== 0) incomplete();
    // Only IDs are consumed. Personal roster fields never enter normalized evidence.
    for (const golfer of day.golfers) {
      if (!record(golfer) || !positiveId(golfer.id) || globalGolfers.has(golfer.id)) incomplete();
      globalGolfers.add(golfer.id);
    }
  }
  if (!Array.isArray(day.bookings) || day.bookings.length > 2_000 || !Array.isArray(day.teeTimes) || day.teeTimes.length > 500) incomplete();
  const bookingSizes = new Map<number, number>();
  const bookingGolferIds = new Map<number, unknown[]>();
  for (const booking of day.bookings) {
    if (!record(booking) || !positiveId(booking.bookingId) || bookingSizes.has(booking.bookingId) ||
        !Array.isArray(booking.golfers) || booking.golfers.length > 4 || !modern && !booking.golfers.every(record)) incomplete();
    const golferIds = modern ? booking.golfers : booking.golfers.filter(golfer => golfer.id !== undefined).map(golfer => golfer.id);
    if (golferIds.some(id => !positiveId(id)) || new Set(golferIds).size !== golferIds.length) incomplete();
    if (modern && golferIds.some(id => !globalGolfers.has(id))) incomplete();
    bookingSizes.set(booking.bookingId, booking.golfers.length);
    bookingGolferIds.set(booking.bookingId, golferIds);
  }
  const requestedDate = date.toISOString().slice(0, 10);
  const starts = new Set<string>();
  for (const row of day.teeTimes) {
    if (!record(row) || typeof row.teeTime !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(row.teeTime) ||
        row.teeTime.slice(0, 10) !== requestedDate || starts.has(row.teeTime.slice(0, 16)) ||
        modern && (typeof row.squeezeTime !== "boolean" || typeof row.shotgun !== "boolean" || !Array.isArray(row.prices)) ||
        !Array.isArray(row.teeOffSections) || row.teeOffSections.length < 1 || row.teeOffSections.length > 2) incomplete();
    starts.add(row.teeTime.slice(0, 16));
    const sections = new Set<string>();
    for (const section of row.teeOffSections) {
      if (!record(section) || typeof section.isHeld !== "boolean" ||
          section.teeOff !== "FRONT_NINE" && section.teeOff !== "BACK_NINE" || sections.has(section.teeOff)) incomplete();
      sections.add(section.teeOff);
      // The public format omits bookings for an empty section.
      const ids = section.bookings === undefined ? [] : section.bookings;
      if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length ||
          ids.some(id => !positiveId(id) || !bookingSizes.has(id))) incomplete();
      if (ids.reduce((total: number, id: number) => total + bookingSizes.get(id)!, 0) > 4) incomplete();
      const golferIds = ids.flatMap((id: number) => bookingGolferIds.get(id)!);
      if (new Set(golferIds).size !== golferIds.length) incomplete();
    }
    if (row.prices !== undefined) {
      if (!Array.isArray(row.prices) || row.prices.length > 2) incomplete();
      const rounds = new Set<string>();
      for (const price of row.prices) {
        if (!record(price) || price.roundType !== "NINE_HOLE" && price.roundType !== "EIGHTEEN_HOLE" ||
            rounds.has(price.roundType) || typeof price.price !== "string" ||
            modern && typeof price.taxInclusive !== "boolean" ||
            !/^\$?(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(price.price) || Number(price.price.replace(/^\$/u, "")) <= 0) incomplete();
        rounds.add(price.roundType);
        price.price = price.price.replace(/^\$/u, "");
      }
    }
  }
  return value as TeesnapResponse;
}

function teesnapHeaders(bookingBaseUrl: string) {
  const origin = new URL(bookingBaseUrl).origin;
  return {
    accept: "application/json, text/plain, */*",
    referer: `${origin}/`,
    "user-agent": TEESNAP_PUBLIC_USER_AGENT
  };
}

function buildTeeTimesUrl(
  metadata: TeesnapMetadata,
  date: Date,
  players: number,
  holes: 9 | 18
) {
  const modern = metadata.publicApiVersion === "BOOKINGSITE_V1";
  let base = metadata.bookingBaseUrl;
  if (modern) {
    const root = new URL(base), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.teesnap\.net$/u.exec(root.hostname);
    if (!match || ["www", "api", "admin", "account", "login"].includes(match[1]) || root.protocol !== "https:" ||
        root.username || root.password || root.port || root.pathname !== "/" || root.search || root.hash ||
        ![root.href, root.href.slice(0, -1)].includes(base)) incomplete();
    base = `https://${match[1]}.api.teesnap.net/`;
  }
  const url = new URL(modern ? "/api/bookingsite/teetimes-day" : "/customer-api/teetimes-day", base);
  url.searchParams.set("course", String(metadata.courseId));
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  url.searchParams.set("players", String(players));
  url.searchParams.set("holes", String(holes));
  url.searchParams.set("addons", metadata.defaultAddons ?? "off");
  if (!modern) url.searchParams.set("profileId", "");
  return url.toString();
}

function getAvailableSpots(section: TeesnapSection, bookingSizes: Map<number, number>) {
  const bookedPlayers = (section.bookings ?? []).reduce(
    (total, bookingId) => total + (bookingSizes.get(bookingId) ?? 0),
    0
  );
  return Math.max(0, 4 - bookedPlayers);
}

function getPriceOptions(prices: TeesnapPrice[] = []) {
  return prices.flatMap((entry) => {
    const holes = entry.roundType === "NINE_HOLE" ? 9 : entry.roundType === "EIGHTEEN_HOLE" ? 18 : null;
    const parsed = Number(entry.price);

    return holes && Number.isFinite(parsed) && parsed >= 0
      ? [{ holes: holes as 9 | 18, priceCents: Math.round(parsed * 100) }]
      : [];
  });
}

function withDateParam(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  return url.toString();
}
