import {
  fetchWithProviderTimeout,
  ProviderHttpError
} from "@/lib/adapters/fetch-with-timeout";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const GOLFNOW_ORIGIN = "https://www.golfnow.com";
const GOLFNOW_SEARCH_ENDPOINT = `${GOLFNOW_ORIGIN}/api/tee-times/tee-time-search-results`;
const GOLFNOW_REQUEST_TIMEOUT_MS = 10_000;
const GOLFNOW_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const GOLFNOW_PUBLIC_MONITOR_USER_AGENT =
  "TeeTimeSpot/1.0 (+https://teetimespot.com)";

export type GolfNowMetadata = {
  provider: "GOLFNOW";
  facilityId: number;
  bookingBaseUrl: string;
};

type GolfNowMoney = { value?: unknown };

type GolfNowRate = {
  teeTimeRateId?: unknown;
  holeCount?: unknown;
  isNine?: unknown;
  isEighteen?: unknown;
  displayRate?: GolfNowMoney;
  singlePlayerPrice?: {
    greensFees?: GolfNowMoney;
  };
};

type GolfNowTeeTime = {
  facilityId?: unknown;
  time?: {
    date?: unknown;
    formatted?: unknown;
  };
  teeTimeRates?: unknown;
  isReservationRestricted?: unknown;
};

type GolfNowResponse = {
  ttResults?: {
    teeTimes?: unknown;
  };
  ttException?: {
    errorType?: unknown;
  };
};

export function isGolfNowMetadata(value: unknown): value is GolfNowMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<GolfNowMetadata>;
  const booking = normalizeGolfNowBookingUrl(metadata.bookingBaseUrl);
  return Boolean(
    metadata.provider === "GOLFNOW" &&
      Number.isSafeInteger(metadata.facilityId) &&
      (metadata.facilityId ?? 0) > 0 &&
      (metadata.facilityId ?? 0) <= 2_147_483_647 &&
      booking &&
      getGolfNowFacilityId(booking) === metadata.facilityId
  );
}

export function normalizeGolfNowBookingUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "www.golfnow.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/tee-times\/facility\/[1-9]\d{0,9}(?:-[a-z0-9-]+)?\/search\/?$/i.test(
        url.pathname
      )
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function getGolfNowFacilityId(value: string) {
  const booking = normalizeGolfNowBookingUrl(value);
  if (!booking) {
    return null;
  }
  const id = Number(
    new URL(booking).pathname.match(/^\/tee-times\/facility\/([1-9]\d{0,9})/i)?.[1]
  );
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}

export async function fetchGolfNowTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: GolfNowMetadata;
  },
  fetchImpl: typeof fetch = fetch
) {
  if (!isGolfNowMetadata(input.metadata)) {
    throw new Error("GolfNow metadata is invalid");
  }
  if (!Number.isInteger(input.players) || input.players < 1 || input.players > 4) {
    throw new Error("GolfNow player count must be between 1 and 4");
  }

  const targetDate = input.date.toISOString().slice(0, 10);
  const response = await fetchWithProviderTimeout(
    GOLFNOW_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: GOLFNOW_ORIGIN,
        referer: input.metadata.bookingBaseUrl,
        "user-agent": GOLFNOW_PUBLIC_MONITOR_USER_AGENT
      },
      redirect: "error",
      body: JSON.stringify(buildGolfNowRequest(input.metadata.facilityId, targetDate, input.players))
    },
    fetchImpl,
    GOLFNOW_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new ProviderHttpError("GolfNow tee times", response);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel();
    throw new Error("GolfNow tee times returned a non-JSON response");
  }

  const payload = await readGolfNowResponse(response);
  const teeTimes = Array.isArray(payload.ttResults?.teeTimes)
    ? (payload.ttResults.teeTimes as GolfNowTeeTime[])
    : [];
  const slots = teeTimes.flatMap((teeTime) =>
    normalizeGolfNowSlot(teeTime, {
      courseId: input.courseId,
      targetDate,
      players: input.players,
      metadata: input.metadata
    })
  );

  return {
    slots,
    targetDateStatus: slots.length > 0 ? ("OPEN" as const) : ("UNKNOWN" as const),
    bookingWindowEvidence: null
  };
}

function buildGolfNowRequest(facilityId: number, date: string, players: number) {
  const [year, month, day] = date.split("-").map(Number);
  const monthName = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ][month - 1];
  if (!monthName || !Number.isInteger(day) || !Number.isInteger(year)) {
    throw new Error("GolfNow target date is invalid");
  }
  const displayDate = `${monthName} ${day} ${year}`;

  return {
    pageSize: 1000,
    teeTimeCount: 20,
    pageNumber: 0,
    date: displayDate,
    sortBy: "Date",
    sortByRollup: "Date.MinDate",
    sortDirection: "Asc",
    hotDealsOnly: false,
    golfPassPerksOnly: false,
    bestDealsOnly: false,
    promotedCampaignsOnly: false,
    priceMin: 0,
    priceMax: 10000,
    players,
    timePeriod: "Any",
    timeMin: 0,
    timeMax: 48,
    holes: "Any",
    facilityType: "GolfCourse",
    latitude: 0,
    longitude: 0,
    radius: 0,
    facilityId,
    facilityIds: [],
    searchType: "Facility",
    view: "Grouping",
    excludeFeaturedFacilities: false,
    excludePrivateFacilities: false,
    rateType: "all",
    currentClientDate: new Date().toISOString(),
    trackmanOnly: false
  };
}

function normalizeGolfNowSlot(
  teeTime: GolfNowTeeTime,
  input: {
    courseId: string;
    targetDate: string;
    players: number;
    metadata: GolfNowMetadata;
  }
): TeeTimeSlot[] {
  if (
    teeTime.facilityId !== input.metadata.facilityId ||
    teeTime.isReservationRestricted === true ||
    typeof teeTime.time?.date !== "string" ||
    teeTime.time.date.slice(0, 10) !== input.targetDate ||
    typeof teeTime.time.formatted !== "string"
  ) {
    return [];
  }
  const time = normalizeGolfNowTime(teeTime.time.formatted);
  if (!time) {
    return [];
  }
  const rates = Array.isArray(teeTime.teeTimeRates)
    ? (teeTime.teeTimeRates as GolfNowRate[])
    : [];
  const options = rates.flatMap(normalizeGolfNowRate);
  if (options.length === 0) {
    return [];
  }
  const priceOptions = [...new Map(
    options
      .sort((left, right) => left.priceCents - right.priceCents)
      .map((option) => [option.holes, option])
  ).values()];
  const sourceRateId = rates
    .map((rate) => rate.teeTimeRateId)
    .find((value) => Number.isSafeInteger(value) && (value as number) > 0);
  const sourceSuffix = sourceRateId ?? `${input.targetDate}-${time.replace(":", "")}`;

  return [{
    courseId: input.courseId,
    sourceId: `golfnow-${input.metadata.facilityId}-${sourceSuffix}`,
    startsAt: `${input.targetDate}T${time}:00`,
    availableSpots: input.players,
    bookingUrl: input.metadata.bookingBaseUrl,
    priceCents: priceOptions[0]?.priceCents,
    holes: priceOptions[0]?.holes,
    bookableHoleCounts: priceOptions.map((option) => option.holes),
    priceOptions,
    evidenceUrl: GOLFNOW_SEARCH_ENDPOINT
  }];
}

function normalizeGolfNowRate(rate: GolfNowRate) {
  const holes = rate.holeCount === 9 || rate.isNine === true
    ? 9
    : rate.holeCount === 18 || rate.isEighteen === true
      ? 18
      : null;
  const price = firstFiniteNumber(
    rate.displayRate?.value,
    rate.singlePlayerPrice?.greensFees?.value
  );
  return holes && price !== null && price >= 0
    ? [{ holes: holes as 9 | 18, priceCents: Math.round(price * 100) }]
    : [];
}

function normalizeGolfNowTime(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : null;
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

async function readGolfNowResponse(response: Response): Promise<GolfNowResponse> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > GOLFNOW_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error("GolfNow tee times response exceeded the size limit");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > GOLFNOW_RESPONSE_LIMIT_BYTES) {
    throw new Error("GolfNow tee times response exceeded the size limit");
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as GolfNowResponse;
  } catch {
    throw new Error("GolfNow tee times returned invalid JSON");
  }
}
