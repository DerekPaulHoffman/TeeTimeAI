import {
  fetchWithProviderTimeout,
  ProviderHttpError
} from "@/lib/adapters/fetch-with-timeout";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const CHRONOGOLF_MARKETPLACE_BASE_URL = "https://www.chronogolf.com";
const CHRONOGOLF_REQUEST_TIMEOUT_MS = 10_000;
const CHRONOGOLF_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const CHRONOGOLF_MAX_PAGES = 10;
const CHRONOGOLF_PUBLIC_MONITOR_USER_AGENT =
  "TeeTimeSpot/1.0 (+https://teetimespot.com)";

export type ChronogolfMetadata = {
  clubId: number;
  courseIds: string[];
  bookingBaseUrl: string;
};

type ChronogolfPrice = {
  green_fee?: number;
  bookable_holes?: number;
};

type ChronogolfApiSlot = {
  uuid?: string;
  date?: string;
  start_time?: string;
  max_player_size?: number;
  frozen?: boolean;
  course?: {
    uuid?: string;
    holes?: number;
  };
  default_price?: ChronogolfPrice;
};

type ChronogolfResponse = {
  teetimes?: ChronogolfApiSlot[];
  data?: {
    teetimes?: ChronogolfApiSlot[];
  };
  pagination?: {
    total?: number;
    per_page?: number;
    perPage?: number;
  };
};

type ChronogolfPage = {
  payload: ChronogolfResponse;
  total: number;
  perPage: number;
};

type ChronogolfRequester = (
  url: string,
  bookingBaseUrl: string
) => Promise<ChronogolfPage>;

export function buildChronogolfPublicRequestHeaders(bookingBaseUrl: string) {
  const publicProfileUrl = normalizeChronogolfPublicProfileUrl(bookingBaseUrl);
  if (!publicProfileUrl) {
    throw new Error(
      "Chronogolf metadata did not include a canonical public club profile"
    );
  }

  return {
    accept: "application/json",
    referer: publicProfileUrl,
    "user-agent": CHRONOGOLF_PUBLIC_MONITOR_USER_AGENT
  };
}

export function isChronogolfMetadata(value: unknown): value is ChronogolfMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<ChronogolfMetadata>;
  return (
    typeof metadata.clubId === "number" &&
    Number.isInteger(metadata.clubId) &&
    metadata.clubId > 0 &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every(
      (courseId) => typeof courseId === "string" && courseId.length > 0
    ) &&
    typeof metadata.bookingBaseUrl === "string" &&
    normalizeChronogolfPublicProfileUrl(metadata.bookingBaseUrl) !== null
  );
}

export async function fetchChronogolfSlots(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: ChronogolfMetadata;
}, request?: ChronogolfRequester, fetchImpl: typeof fetch = fetch): Promise<TeeTimeSlot[]> {
  const slots: TeeTimeSlot[] = [];
  const activeRequest = request ?? await createChronogolfPublicRequester(
    input.metadata.bookingBaseUrl,
    fetchImpl
  );

  for (let page = 1; page <= CHRONOGOLF_MAX_PAGES; page += 1) {
    const url = buildTeeTimesUrl(input.date, input.players, input.metadata.courseIds, page);
    const response = await activeRequest(url, input.metadata.bookingBaseUrl);
    const teeTimes = Array.isArray(response.payload.teetimes)
      ? response.payload.teetimes
      : [];

    slots.push(...teeTimes.flatMap((slot) => normalizeSlot(slot, input, url)));

    if (
      teeTimes.length === 0 ||
      response.perPage < 1 ||
      page * response.perPage >= response.total
    ) {
      break;
    }
  }

  return slots;
}

function normalizeSlot(
  slot: ChronogolfApiSlot,
  input: { courseId: string; date: Date; metadata: ChronogolfMetadata },
  evidenceUrl: string
): TeeTimeSlot[] {
    if (
      slot.frozen ||
      !slot.uuid ||
      !slot.date ||
      !slot.start_time ||
      typeof slot.max_player_size !== "number" ||
      slot.max_player_size < 1
    ) {
      return [];
    }

    const holes = slot.default_price?.bookable_holes ?? slot.course?.holes;
    const priceCents = toPriceCents(slot.default_price?.green_fee);

    return [{
      courseId: input.courseId,
      sourceId: `chronogolf-${slot.uuid}`,
      startsAt: `${slot.date}T${normalizeTime(slot.start_time)}`,
      availableSpots: slot.max_player_size,
      bookingUrl: withSearchDate(input.metadata.bookingBaseUrl, input.date),
      priceCents,
      holes,
      priceOptions:
        (holes === 9 || holes === 18) && priceCents !== undefined
          ? [{ holes, priceCents }]
          : undefined,
      evidenceUrl
    }];
}

async function createChronogolfPublicRequester(
  bookingBaseUrl: string,
  fetchImpl: typeof fetch
): Promise<ChronogolfRequester> {
  const publicProfileUrl = normalizeChronogolfPublicProfileUrl(bookingBaseUrl);
  if (!publicProfileUrl) {
    throw new Error(
      "Chronogolf metadata did not include a canonical public club profile"
    );
  }

  let anonymousCookie = await bootstrapChronogolfAnonymousCookie(
    publicProfileUrl,
    fetchImpl
  );

  return async (urlValue, profileUrl) => {
    try {
      return await requestChronogolfJson(
        urlValue,
        profileUrl,
        anonymousCookie,
        fetchImpl
      );
    } catch (error) {
      if (!isChronogolfAnonymousSessionRejection(error)) {
        throw error;
      }
      anonymousCookie = await bootstrapChronogolfAnonymousCookie(
        publicProfileUrl,
        fetchImpl
      );
      return requestChronogolfJson(
        urlValue,
        profileUrl,
        anonymousCookie,
        fetchImpl
      );
    }
  };
}

async function bootstrapChronogolfAnonymousCookie(
  publicProfileUrl: string,
  fetchImpl: typeof fetch
) {
  const profileResponse = await fetchWithProviderTimeout(
    publicProfileUrl,
    {
      headers: {
        ...buildChronogolfPublicRequestHeaders(publicProfileUrl),
        accept: "text/html,application/xhtml+xml"
      },
      redirect: "error"
    },
    fetchImpl,
    CHRONOGOLF_REQUEST_TIMEOUT_MS
  );
  if (!profileResponse.ok) {
    throw new ProviderHttpError("Chronogolf public profile", profileResponse);
  }

  const anonymousCookie = getChronogolfAnonymousCookie(profileResponse.headers);
  await profileResponse.body?.cancel();
  return anonymousCookie;
}

function isChronogolfAnonymousSessionRejection(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const value = error as { name?: unknown; status?: unknown };
  return Boolean(
    value.name === "ProviderHttpError" &&
    (value.status === 401 || value.status === 403)
  );
}

async function requestChronogolfJson(
  urlValue: string,
  bookingBaseUrl: string,
  anonymousCookie: string | null,
  fetchImpl: typeof fetch
): Promise<ChronogolfPage> {
  const headers: Record<string, string> = buildChronogolfPublicRequestHeaders(
    bookingBaseUrl
  );
  if (anonymousCookie) {
    headers.cookie = anonymousCookie;
  }

  const response = await fetchWithProviderTimeout(
    urlValue,
    { headers, redirect: "error" },
    fetchImpl,
    CHRONOGOLF_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new ProviderHttpError("Chronogolf tee times", response);
  }

  const body = await readChronogolfResponse(response);
  let decoded: ChronogolfResponse;
  try {
    decoded = JSON.parse(body) as ChronogolfResponse;
  } catch {
    throw new Error("Chronogolf tee times returned invalid JSON");
  }

  const payload = decoded.data ?? decoded;
  const teeTimeCount = Array.isArray(payload.teetimes)
    ? payload.teetimes.length
    : 0;
  const total = firstValidNumber(
    response.headers.get("total"),
    decoded.pagination?.total,
    teeTimeCount
  );
  const perPage = firstPositiveNumber(
    response.headers.get("per-page"),
    decoded.pagination?.per_page,
    decoded.pagination?.perPage,
    teeTimeCount
  );

  return { payload, total, perPage };
}

function getChronogolfAnonymousCookie(headers: Headers) {
  const combined = headers.get("set-cookie");
  if (!combined) {
    return null;
  }
  const match = combined.match(/(?:^|,\s*)__cf_bm=([^;,\s]+)/i);
  return match?.[1] ? `__cf_bm=${match[1]}` : null;
}

async function readChronogolfResponse(response: Response) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > CHRONOGOLF_RESPONSE_LIMIT_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("Chronogolf tee times response exceeded the size limit");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > CHRONOGOLF_RESPONSE_LIMIT_BYTES) {
    throw new Error("Chronogolf tee times response exceeded the size limit");
  }
  return new TextDecoder().decode(buffer);
}

function firstValidNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return number;
    }
  }
  return 0;
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function buildTeeTimesUrl(date: Date, players: number, courseIds: string[], page: number) {
  const url = new URL("/marketplace/v2/teetimes", CHRONOGOLF_MARKETPLACE_BASE_URL);
  url.searchParams.set("start_date", date.toISOString().slice(0, 10));
  url.searchParams.set("free_slots", String(players));
  url.searchParams.set("course_ids", courseIds.join(","));
  url.searchParams.set("page", String(page));
  return url.toString();
}

function normalizeTime(value: string) {
  const [hour = "0", minute = "00"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function toPriceCents(value?: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100)
    : undefined;
}

function withSearchDate(bookingBaseUrl: string, date: Date) {
  const publicProfileUrl = normalizeChronogolfPublicProfileUrl(bookingBaseUrl);
  if (!publicProfileUrl) {
    throw new Error(
      "Chronogolf metadata did not include a canonical public club profile"
    );
  }
  const url = new URL(publicProfileUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  url.searchParams.set("step", "teetimes");
  return url.toString();
}

function normalizeChronogolfPublicProfileUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !["chronogolf.com", "www.chronogolf.com"].includes(url.hostname.toLowerCase()) ||
      url.search ||
      url.hash ||
      !/^\/club\/[^/]+\/?$/i.test(url.pathname)
    ) {
      return null;
    }

    url.hostname = "www.chronogolf.com";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}
