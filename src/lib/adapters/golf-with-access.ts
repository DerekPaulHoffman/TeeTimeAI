import { createHash } from "node:crypto";

import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const GOLF_WITH_ACCESS_HOST = "golfwithaccess.com";
const GOLF_WITH_ACCESS_COURSE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GOLF_WITH_ACCESS_BOOKING_PATH =
  /^\/course\/[a-z0-9][a-z0-9-]{0,127}\/reserve-tee-time\/?$/iu;

export type GolfWithAccessMetadata = {
  provider: "GOLF_WITH_ACCESS";
  courseIds: string[];
  bookingBaseUrl: string;
};

type GolfWithAccessDayTime = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
};

type GolfWithAccessMoney = {
  cents?: number;
  code?: string;
};

type GolfWithAccessRate = {
  isAvailableToUser?: boolean;
  holesOption?: string;
  price?: {
    dollars?: GolfWithAccessMoney | null;
  };
};

type GolfWithAccessTeeTime = {
  id?: string;
  dayTime?: GolfWithAccessDayTime;
  players?: {
    min?: number;
    max?: number;
  };
  holesOption?: string;
  course?: {
    id?: string;
  };
  displayRate?: GolfWithAccessRate | null;
};

type GolfWithAccessResponse = {
  teeTimes?: GolfWithAccessTeeTime[];
};

export type GolfWithAccessTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: null;
};

export function isGolfWithAccessMetadata(
  value: unknown
): value is GolfWithAccessMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<GolfWithAccessMetadata>;
  if (
    metadata.provider !== "GOLF_WITH_ACCESS" ||
    !Array.isArray(metadata.courseIds) ||
    metadata.courseIds.length < 1 ||
    metadata.courseIds.length > 12 ||
    !metadata.courseIds.every(
      (courseId) =>
        typeof courseId === "string" &&
        GOLF_WITH_ACCESS_COURSE_ID.test(courseId)
    ) ||
    new Set(metadata.courseIds.map((courseId) => courseId.toLowerCase())).size !==
      metadata.courseIds.length ||
    typeof metadata.bookingBaseUrl !== "string"
  ) {
    return false;
  }

  try {
    const bookingUrl = new URL(metadata.bookingBaseUrl);
    return Boolean(
      bookingUrl.protocol === "https:" &&
        bookingUrl.hostname === GOLF_WITH_ACCESS_HOST &&
        !bookingUrl.username &&
        !bookingUrl.password &&
        !bookingUrl.port &&
        !bookingUrl.search &&
        !bookingUrl.hash &&
        GOLF_WITH_ACCESS_BOOKING_PATH.test(bookingUrl.pathname)
    );
  } catch {
    return false;
  }
}

export async function fetchGolfWithAccessTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: GolfWithAccessMetadata;
  },
  fetchImpl: typeof fetch = fetch
): Promise<GolfWithAccessTeeSheetResult> {
  if (
    !isGolfWithAccessMetadata(input.metadata) ||
    !Number.isInteger(input.players) ||
    input.players < 1 ||
    input.players > 4
  ) {
    return {
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    };
  }

  const targetDate = input.date.toISOString().slice(0, 10);
  const requestUrl = new URL("/api/v1/tee-times", input.metadata.bookingBaseUrl);
  for (const providerCourseId of input.metadata.courseIds) {
    requestUrl.searchParams.append("courseIds", providerCourseId);
  }
  requestUrl.searchParams.set("players", String(input.players));
  requestUrl.searchParams.set("startAt", "00:00:00");
  requestUrl.searchParams.set("endAt", "23:59:59");
  requestUrl.searchParams.set("day", targetDate);

  const response = await fetchWithProviderTimeout(
    requestUrl,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
      }
    },
    fetchImpl
  );
  if (!response.ok) {
    throw providerHttpError("Golf with Access tee times", response);
  }

  const payload = (await response.json()) as GolfWithAccessResponse;
  if (!Array.isArray(payload.teeTimes)) {
    return {
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    };
  }

  let recognizedRecordCount = 0;
  const allowedCourseIds = new Set(
    input.metadata.courseIds.map((courseId) => courseId.toLowerCase())
  );
  const slots = payload.teeTimes.flatMap((teeTime): TeeTimeSlot[] => {
    const startsAt = parseGolfWithAccessDayTime(teeTime.dayTime, targetDate);
    const providerCourseId = teeTime.course?.id?.toLowerCase();
    const playersMax = teeTime.players?.max;
    if (
      !teeTime.id ||
      teeTime.id.length > 4_096 ||
      !startsAt ||
      !providerCourseId ||
      !allowedCourseIds.has(providerCourseId) ||
      !Number.isInteger(playersMax) ||
      (playersMax ?? 0) < 1 ||
      (playersMax ?? 0) > 8 ||
      typeof teeTime.displayRate?.isAvailableToUser !== "boolean"
    ) {
      return [];
    }
    recognizedRecordCount += 1;
    if (
      teeTime.displayRate.isAvailableToUser !== true ||
      (playersMax as number) < input.players
    ) {
      return [];
    }

    const holes = parseGolfWithAccessHoles(
      teeTime.displayRate.holesOption ?? teeTime.holesOption
    );
    const priceCents = parseGolfWithAccessPrice(
      teeTime.displayRate.price?.dollars
    );
    return [
      {
        sourceId: `golf-with-access-${createHash("sha256")
          .update(teeTime.id)
          .digest("hex")}`,
        courseId: input.courseId,
        startsAt,
        availableSpots: playersMax as number,
        bookingUrl: input.metadata.bookingBaseUrl,
        ...(priceCents === undefined ? {} : { priceCents }),
        ...(holes ? { holes, bookableHoleCounts: [holes] } : {}),
        evidenceUrl: requestUrl.toString()
      }
    ];
  });

  if (payload.teeTimes.length > 0 && recognizedRecordCount === 0) {
    throw new Error("Golf with Access returned an unexpected tee-time schema");
  }
  return {
    slots,
    targetDateStatus: "OPEN",
    bookingWindowEvidence: null
  };
}

function parseGolfWithAccessDayTime(
  dayTime: GolfWithAccessDayTime | undefined,
  targetDate: string
) {
  if (!dayTime) {
    return null;
  }
  const values = [
    dayTime.year,
    dayTime.month,
    dayTime.day,
    dayTime.hour,
    dayTime.minute,
    dayTime.second
  ];
  if (!values.every((value) => Number.isInteger(value))) {
    return null;
  }
  const [year, month, day, hour, minute, second] = values as number[];
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  const date = `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (
    date !== targetDate ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    return null;
  }
  return `${date}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

function parseGolfWithAccessHoles(value: string | undefined): 9 | 18 | undefined {
  if (value === "NINE") {
    return 9;
  }
  if (value === "EIGHTEEN") {
    return 18;
  }
  return undefined;
}

function parseGolfWithAccessPrice(value: GolfWithAccessMoney | null | undefined) {
  if (
    !value ||
    value.code !== "USD" ||
    !Number.isInteger(value.cents) ||
    (value.cents ?? -1) < 0 ||
    (value.cents ?? 0) > 10_000_000
  ) {
    return undefined;
  }
  return value.cents as number;
}
