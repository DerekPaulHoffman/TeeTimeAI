import {
  fetchWithProviderTimeout,
  ProviderHttpError
} from "@/lib/adapters/fetch-with-timeout";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const AGILYSYS_ORIGIN = "https://book.onagilysys.com";
const AGILYSYS_REQUEST_TIMEOUT_MS = 10_000;
const AGILYSYS_TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;
const AGILYSYS_TEE_SHEET_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const AGILYSYS_PUBLIC_MONITOR_USER_AGENT =
  "TeeTimeSpot/1.0 (+https://teetimespot.com)";

export type AgilysysMetadata = {
  provider: "AGILYSYS";
  tenantId: number;
  propertyId: string;
  courseId: number;
  playerTypeId: number;
  bookingBaseUrl: string;
};

type AgilysysRate = {
  id?: unknown;
  name?: unknown;
  holeType?: unknown;
  isPrivate?: unknown;
  rates?: {
    greenFee?: unknown;
    cartFee?: unknown;
    otherFee?: unknown;
  };
};

type AgilysysSlot = {
  scheduleDateTime?: unknown;
  availability?: unknown;
  teeTimeId?: unknown;
  rateType?: unknown;
};

type AgilysysTeeSheetResponse = {
  success?: unknown;
  availableTeeSlots?: unknown;
};

export function isAgilysysMetadata(value: unknown): value is AgilysysMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<AgilysysMetadata>;
  const booking = normalizeAgilysysBookingUrl(metadata.bookingBaseUrl);
  const identity = booking ? getAgilysysBookingIdentity(booking) : null;
  return Boolean(
    metadata.provider === "AGILYSYS" &&
      isPositiveBoundedInteger(metadata.tenantId) &&
      isSafeAgilysysPropertyId(metadata.propertyId) &&
      isPositiveBoundedInteger(metadata.courseId) &&
      isPositiveBoundedInteger(metadata.playerTypeId) &&
      identity?.tenantId === metadata.tenantId &&
      identity.propertyId === metadata.propertyId
  );
}

export function normalizeAgilysysBookingUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/onecart\/golf\/courses\/([1-9]\d{0,9})\/([a-z0-9][a-z0-9_-]{0,63})\/?$/iu
    );
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "book.onagilysys.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !match ||
      !hasOnlyAgilysysLandingQuery(url)
    ) {
      return null;
    }
    url.pathname = `/onecart/golf/courses/${match[1]}/${match[2]}`;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function getAgilysysBookingIdentity(value: string) {
  const booking = normalizeAgilysysBookingUrl(value);
  if (!booking) {
    return null;
  }
  const match = new URL(booking).pathname.match(
    /^\/onecart\/golf\/courses\/([1-9]\d{0,9})\/([a-z0-9][a-z0-9_-]{0,63})$/iu
  );
  const tenantId = Number(match?.[1]);
  return match && isPositiveBoundedInteger(tenantId)
    ? { tenantId, propertyId: match[2] }
    : null;
}

export async function fetchAgilysysTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: AgilysysMetadata;
  },
  fetchImpl: typeof fetch = fetch
) {
  if (!isAgilysysMetadata(input.metadata)) {
    throw new Error("Agilysys metadata is invalid");
  }
  if (
    !Number.isInteger(input.players) ||
    input.players < 1 ||
    input.players > 4
  ) {
    throw new Error("Agilysys player count must be between 1 and 4");
  }

  const targetDate = input.date.toISOString().slice(0, 10);
  const token = await fetchAgilysysPublicToken(input.metadata, fetchImpl);
  const endpoint = buildAgilysysTeeSheetUrl(input.metadata, targetDate);
  const response = await fetchWithProviderTimeout(
    endpoint,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        referer: input.metadata.bookingBaseUrl,
        "user-agent": AGILYSYS_PUBLIC_MONITOR_USER_AGENT
      },
      redirect: "error"
    },
    fetchImpl,
    AGILYSYS_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new ProviderHttpError("Agilysys tee times", response);
  }
  const payload = await readJsonResponse<AgilysysTeeSheetResponse>(
    response,
    AGILYSYS_TEE_SHEET_RESPONSE_LIMIT_BYTES,
    "Agilysys tee times"
  );
  if (payload.success !== true || !Array.isArray(payload.availableTeeSlots)) {
    throw new Error("Agilysys tee times returned an invalid response");
  }

  const slots = payload.availableTeeSlots
    .flatMap((group) =>
      group &&
      typeof group === "object" &&
      Array.isArray((group as { slots?: unknown }).slots)
        ? (group as { slots: AgilysysSlot[] }).slots
        : []
    )
    .flatMap((slot) =>
      normalizeAgilysysSlot(slot, {
        courseId: input.courseId,
        players: input.players,
        targetDate,
        endpoint,
        metadata: input.metadata
      })
    );

  return {
    slots,
    targetDateStatus:
      slots.length > 0 ? ("OPEN" as const) : ("UNKNOWN" as const),
    bookingWindowEvidence: null
  };
}

async function fetchAgilysysPublicToken(
  metadata: AgilysysMetadata,
  fetchImpl: typeof fetch
) {
  const endpoint = `${AGILYSYS_ORIGIN}/wbe-admin-service/generatetoken/v2/tenants/${metadata.tenantId}/propertyId/${encodeURIComponent(metadata.propertyId)}/appName/NA`;
  const response = await fetchWithProviderTimeout(
    endpoint,
    {
      headers: {
        accept: "application/json",
        referer: metadata.bookingBaseUrl,
        "user-agent": AGILYSYS_PUBLIC_MONITOR_USER_AGENT
      },
      redirect: "error"
    },
    fetchImpl,
    AGILYSYS_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new ProviderHttpError("Agilysys public session", response);
  }
  const payload = await readJsonResponse<{ success?: unknown; token?: unknown }>(
    response,
    AGILYSYS_TOKEN_RESPONSE_LIMIT_BYTES,
    "Agilysys public session"
  );
  if (
    payload.success !== true ||
    typeof payload.token !== "string" ||
    payload.token.length < 32 ||
    payload.token.length > 8_192
  ) {
    throw new Error("Agilysys public session returned an invalid response");
  }
  return payload.token;
}

function buildAgilysysTeeSheetUrl(
  metadata: AgilysysMetadata,
  targetDate: string
) {
  const url = new URL(
    `${AGILYSYS_ORIGIN}/wbe-golf-service/golf/tenants/${metadata.tenantId}/propertyId/${encodeURIComponent(metadata.propertyId)}/getAvailableTeeSlots`
  );
  url.searchParams.set("fromDate", targetDate);
  url.searchParams.set("toDate", targetDate);
  url.searchParams.set("courseId", String(metadata.courseId));
  url.searchParams.set("playerTypeId", String(metadata.playerTypeId));
  url.searchParams.set("holes", "0");
  url.searchParams.set("appName", "golf");
  return url.toString();
}

function normalizeAgilysysSlot(
  slot: AgilysysSlot,
  input: {
    courseId: string;
    players: number;
    targetDate: string;
    endpoint: string;
    metadata: AgilysysMetadata;
  }
): TeeTimeSlot[] {
  if (
    typeof slot.scheduleDateTime !== "string" ||
    !new RegExp(`^${input.targetDate}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d$`).test(
      slot.scheduleDateTime
    ) ||
    !Number.isInteger(slot.availability) ||
    (slot.availability as number) < input.players ||
    (slot.availability as number) > 4 ||
    !Array.isArray(slot.rateType)
  ) {
    return [];
  }
  const rates = (slot.rateType as AgilysysRate[])
    .flatMap(normalizeAgilysysRate)
    .sort(compareAgilysysRates);
  if (rates.length === 0) {
    return [];
  }
  const options = rates
    .filter(
      (rate, index) =>
        rates.findIndex((candidate) => candidate.holes === rate.holes) === index
    )
    .map((rate) => ({ holes: rate.holes, priceCents: rate.priceCents }));
  const preferred = rates[0];
  const timestamp = slot.scheduleDateTime.slice(11, 16).replace(":", "");
  const sourceId = isPositiveBoundedInteger(slot.teeTimeId)
    ? slot.teeTimeId
    : `${input.targetDate}-${timestamp}`;
  const bookingUrl = new URL(input.metadata.bookingBaseUrl);
  bookingUrl.searchParams.set("date", input.targetDate);
  bookingUrl.searchParams.set("id", String(input.metadata.courseId));

  return [
    {
      courseId: input.courseId,
      sourceId: `agilysys-${input.metadata.tenantId}-${input.metadata.courseId}-${sourceId}`,
      startsAt: slot.scheduleDateTime,
      availableSpots: slot.availability as number,
      bookingUrl: bookingUrl.toString(),
      priceCents: preferred.priceCents,
      holes: preferred.holes,
      bookableHoleCounts: options.map((option) => option.holes),
      priceOptions: options,
      evidenceUrl: input.endpoint
    }
  ];
}

function normalizeAgilysysRate(rate: AgilysysRate) {
  if (rate.isPrivate === true || (rate.holeType !== 9 && rate.holeType !== 18)) {
    return [];
  }
  const parts = [rate.rates?.greenFee, rate.rates?.cartFee, rate.rates?.otherFee];
  if (
    parts.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0
    )
  ) {
    return [];
  }
  const priceCents = Math.round(
    (parts as number[]).reduce((total, value) => total + value, 0) * 100
  );
  return [
    {
      holes: rate.holeType as 9 | 18,
      priceCents,
      generalPublic:
        typeof rate.name === "string" &&
        /\b(visitor|public|non[- ]?resident)\b/iu.test(rate.name),
      rateId: isPositiveBoundedInteger(rate.id) ? rate.id : null
    }
  ];
}

function compareAgilysysRates(
  left: ReturnType<typeof normalizeAgilysysRate>[number],
  right: ReturnType<typeof normalizeAgilysysRate>[number]
) {
  return (
    Number(right.generalPublic) - Number(left.generalPublic) ||
    left.priceCents - right.priceCents ||
    (Number(left.rateId) || 0) - (Number(right.rateId) || 0)
  );
}

function hasOnlyAgilysysLandingQuery(url: URL) {
  const allowed = new Set(["date", "id"]);
  const values = new Map<string, string>();
  for (const [rawKey, value] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (values.has(key) || !allowed.has(key)) {
      return false;
    }
    if (key === "date" && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return false;
    }
    if (key === "id" && !isPositiveBoundedInteger(Number(value))) {
      return false;
    }
    values.set(key, value);
  }
  return true;
}

function isSafeAgilysysPropertyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(value)
  );
}

function isPositiveBoundedInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 2_147_483_647
  );
}

async function readJsonResponse<T>(
  response: Response,
  limit: number,
  label: string
): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel();
    throw new Error(`${label} returned a non-JSON response`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeded the size limit`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) {
    throw new Error(`${label} response exceeded the size limit`);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
