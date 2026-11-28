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

type ChronogolfPage = {
  payload: unknown;
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
  const seen = new Set<string>();
  const targetDate = input.date.toISOString().slice(0, 10);
  let pagination: { total: number; perPage: number } | undefined;
  const activeRequest = request ?? await createChronogolfPublicRequester(
    input.metadata.bookingBaseUrl,
    fetchImpl
  );

  for (let page = 1; page <= CHRONOGOLF_MAX_PAGES; page += 1) {
    const url = buildTeeTimesUrl(targetDate, input.players, input.metadata.courseIds, page);
    const { payload, total, perPage } = await activeRequest(url, input.metadata.bookingBaseUrl);
    if (!isRecord(payload) || !Array.isArray(payload.teetimes) ||
      (payload.status !== undefined && payload.status !== "open" && payload.status !== "sold_out")) {
      throw chronogolfSchemaError("Chronogolf tee times response did not contain a verified tee sheet");
    }
    if (
      !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(perPage) || perPage < 1 ||
      Math.ceil(total / perPage) > CHRONOGOLF_MAX_PAGES ||
      (pagination && (total !== pagination.total || perPage !== pagination.perPage)) ||
      payload.teetimes.length !== Math.min(perPage, total - (page - 1) * perPage) ||
      (payload.status === "sold_out" && total !== 0)
    ) {
      throw chronogolfSchemaError("Chronogolf tee times pagination could not be verified");
    }
    pagination = { total, perPage };
    for (const row of payload.teetimes) {
      const slot = normalizeSlot(row, input, targetDate, url, seen);
      if (slot) slots.push(slot);
    }
    if (page * perPage >= total) return slots;
  }

  throw chronogolfSchemaError("Chronogolf tee times pagination could not be verified");
}

function normalizeSlot(
  row: unknown,
  input: { courseId: string; date: Date; metadata: ChronogolfMetadata },
  targetDate: string,
  evidenceUrl: string,
  seen: Set<string>
): TeeTimeSlot | null {
  if (!isRecord(row)) throw chronogolfSchemaError("Chronogolf tee time row could not be verified");
  const { uuid, date, start_time: startTime, max_player_size: spots, frozen } = row;
  const course = isRecord(row.course) ? row.course : undefined;
    if (
    typeof uuid !== "string" || !uuid.trim() || seen.has(uuid) || date !== targetDate ||
    typeof startTime !== "string" || !/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(startTime) ||
    typeof spots !== "number" || !Number.isSafeInteger(spots) || spots < 0 ||
    (frozen !== undefined && typeof frozen !== "boolean") ||
    (row.course != null && !course) ||
    (course?.uuid !== undefined && (typeof course.uuid !== "string" || !input.metadata.courseIds.includes(course.uuid)))
  ) throw chronogolfSchemaError("Chronogolf tee time row could not be verified for the requested course and date");
  seen.add(uuid);
  if (frozen || spots === 0) return null;

  const price = isRecord(row.default_price) ? row.default_price : undefined;
  const rawHoles = price?.bookable_holes ?? course?.holes;
  const holes = typeof rawHoles === "number" ? rawHoles : undefined;
  const priceCents = toPriceCents(price?.green_fee);

  return {
      courseId: input.courseId,
    sourceId: `chronogolf-${uuid}`,
    startsAt: `${targetDate}T${normalizeTime(startTime)}`,
    availableSpots: spots,
      bookingUrl: withSearchDate(input.metadata.bookingBaseUrl, input.date),
      priceCents,
      holes,
      priceOptions:
        (holes === 9 || holes === 18) && priceCents !== undefined
          ? [{ holes, priceCents }]
          : undefined,
      evidenceUrl
  };
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
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw chronogolfSchemaError("Chronogolf tee times returned invalid JSON");
  }
  if (!isRecord(decoded)) throw chronogolfSchemaError("Chronogolf tee times response did not contain a verified tee sheet");
  const payload = decoded.data ?? decoded;
  if (!isRecord(payload) || !Array.isArray(payload.teetimes)) {
    throw chronogolfSchemaError("Chronogolf tee times response did not contain a verified tee sheet");
  }
  const pagination = isRecord(decoded.pagination) ? decoded.pagination : undefined;
  const total = readPaginationNumber(0, response.headers.get("total"), pagination?.total, payload.total_count);
  const perPage = readPaginationNumber(1,
    response.headers.get("per-page"), pagination?.per_page, pagination?.perPage
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

function readPaginationNumber(minimum: number, ...values: unknown[]) {
  const [first, ...rest] = values.filter(value => value != null).map(value =>
    typeof value === "number" || typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  );
  if (!Number.isSafeInteger(first) || first < minimum || rest.some(number => number !== first)) {
    throw chronogolfSchemaError("Chronogolf tee times pagination could not be verified");
  }
  return first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chronogolfSchemaError(message: string) {
  return Object.assign(new Error(message), { failureClass: "SCHEMA" as const });
}

function buildTeeTimesUrl(date: string, players: number, courseIds: string[], page: number) {
  const url = new URL("/marketplace/v2/teetimes", CHRONOGOLF_MARKETPLACE_BASE_URL);
  url.searchParams.set("start_date", date);
  url.searchParams.set("free_slots", String(players));
  url.searchParams.set("course_ids", courseIds.join(","));
  url.searchParams.set("page", String(page));
  return url.toString();
}

function normalizeTime(value: string) {
  const [hour = "0", minute = "00"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function toPriceCents(value: unknown) {
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
