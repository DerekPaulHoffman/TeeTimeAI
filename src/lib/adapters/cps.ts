import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";
import {
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  normalizeReleaseTime,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";
import { getTimeZoneOffsetMinutes, zonedDateTimeToDate } from "@/lib/timezones";

export type CpsMetadata = {
  provider: "CPS";
  siteName: string;
  bookingBaseUrl: string;
  courseIds: number[];
  holes?: number[];
  clientId?: string;
  websiteId?: string;
  onlineApi?: string;
  authorityBaseUrl?: string;
};

type CpsConfiguration = {
  clientId: string;
  authorityBaseUrl: string;
  onlineApi: string;
  websiteId: string;
  siteName: string;
  apiKey?: string;
  buildNumber?: string;
  terminalId?: number;
};

type CpsTokenResponse = {
  access_token?: string;
};

type CpsSearchResponse =
  | {
      transactionId?: string;
      content?: CpsApiSlot[] | unknown;
    }
  | CpsApiSlot[];

type CpsBookingRule = {
  courseId?: number;
  daysInAdvance?: number;
  daysInAdvanceWeekend?: number;
  time?: string;
};

type CpsBookingRuleResponse = {
  bookingRuleByClass?: Array<{
    classCode?: string;
    bookingRuleByCourse?: CpsBookingRule[];
  }>;
  bookingRuleByCourses?: CpsBookingRule[];
  weekends?: string[];
};

type CpsApiSlot = {
  teeSheetId?: number;
  startTime?: string;
  courseId?: number;
  availableParticipantNo?: number[];
  participants?: number;
  minPlayer?: number;
  maxPlayer?: number;
  holes?: number;
  defaultHoles?: number;
  teeSheetPrice?: number;
  displayPrice?: number;
  shItemPrices?: Array<{
    displayPrice?: number;
    shItemCode?: string;
  }>;
};

type CpsFetchInput = {
  courseId: string;
  date: Date;
  players: number;
  timeZone?: string;
  metadata: CpsMetadata;
};

const CPS_READ_ATTEMPTS = 2;
const CPS_CONFIGURATION_MAX_BYTES = 64 * 1024;
const CPS_AUTHORITY_PATH = "/identityapi";
const CPS_ONLINE_API_PATH =
  "/onlineres/onlineapi/api/v1/onlinereservation";
const CPS_TIMEOUT_ERROR_INSPECTION_LIMIT = 16;
const CPS_TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);
const CPS_TIMEOUT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT"
]);
const CPS_TRANSIENT_TOKEN_HTTP_STATUSES = new Set([502, 503, 504]);
const CPS_NO_TEE_TIMES_MESSAGE_KEY = "NO_TEETIMES";
const CPS_NO_TEE_TIMES_MESSAGE_TEMPLATE = "No tee times available";
const CPS_NO_TEE_TIMES_MESSAGE_APPEARANCE =
  "Appears on the tee sheet when there are no tee times available on a selected day";
const CPS_NO_TEE_TIMES_MESSAGE_DETAIL =
  "No tee times available,please try different criteria.";
const CPS_NO_TEE_TIMES_MESSAGE_TYPE = "Attention";
const CPS_NO_TEE_TIMES_TRANSACTION_ID_MAX_LENGTH = 128;
const CPS_RESPONSE_DIAGNOSTIC_KEY_LIMIT = 8;
const CPS_RESPONSE_DIAGNOSTIC_KEYS = new Set([
  "content",
  "data",
  "error",
  "errors",
  "isSuccess",
  "messageAppearance",
  "messageDetail",
  "messageKey",
  "messageTemplate",
  "messageType",
  "result",
  "status",
  "transactionId"
]);
const CPS_RESPONSE_DIAGNOSTIC_MESSAGE_KEYS = new Set([
  CPS_NO_TEE_TIMES_MESSAGE_KEY
]);

export type CpsTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function isCpsMetadata(value: unknown): value is CpsMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<CpsMetadata>;
  return (
    metadata.provider === "CPS" &&
    typeof metadata.siteName === "string" &&
    typeof metadata.bookingBaseUrl === "string" &&
    Boolean(getSafeCpsTenantRoot(metadata.siteName, metadata.bookingBaseUrl)) &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every(
      (courseId) => Number.isSafeInteger(courseId) && courseId >= 0
    ) &&
    (metadata.holes === undefined ||
      (Array.isArray(metadata.holes) &&
        metadata.holes.length > 0 &&
        metadata.holes.every((holes) => holes === 9 || holes === 18)))
  );
}

export async function fetchCpsSlots(input: CpsFetchInput): Promise<TeeTimeSlot[]> {
  return (await fetchCpsTeeSheet(input)).slots;
}

export async function fetchCpsTeeSheet(
  input: CpsFetchInput & { discoverBookingWindow?: boolean }
): Promise<CpsTeeSheetResult> {
  if (!isCpsMetadata(input.metadata)) {
    throw new Error("CPS metadata is invalid");
  }
  let configuration = await loadConfiguration(input.metadata);
  let credential: { token?: string; apiKey?: string };
  let recoveredTokenError: { error: unknown } | null = null;
  const publishedApiKey = normalizeCpsApiKey(configuration.apiKey);
  if (publishedApiKey) {
    credential = { apiKey: publishedApiKey };
  } else {
    try {
      credential = { token: await fetchShortLivedToken(configuration) };
    } catch (tokenError) {
      if (!canRecoverCpsTokenErrorWithPublishedKey(tokenError)) {
        throw tokenError;
      }
      const recoveredApiKey = await tryLoadPublishedCpsApiKey(
        input.metadata,
        configuration
      );
      if (!recoveredApiKey) {
        throw tokenError;
      }
      credential = { apiKey: recoveredApiKey };
      recoveredTokenError = { error: tokenError };
    }
  }
  if (credential.apiKey) {
    try {
      configuration = await loadPublicOptions(
        configuration,
        credential,
        input.timeZone ?? "America/New_York",
        input.date
      );
    } catch (setupError) {
      if (recoveredTokenError) {
        throw recoveredTokenError.error;
      }
      throw setupError;
    }
  }
  let headers = cpsHeaders(
    configuration,
    credential,
    input.timeZone ?? "America/New_York",
    input.date
  );
  let slots: TeeTimeSlot[];
  try {
    slots = await fetchCpsAvailability(input, configuration, credential, headers);
  } catch (availabilityError) {
    if (
      !credential.token ||
      !isCpsTransactionCredentialRejection(availabilityError)
    ) {
      throw availabilityError;
    }
    const recoveredApiKey = await tryLoadPublishedCpsApiKey(
      input.metadata,
      configuration
    );
    if (!recoveredApiKey) {
      throw availabilityError;
    }
    const recoveredCredential = { apiKey: recoveredApiKey };
    let recoveredConfiguration: CpsConfiguration;
    try {
      recoveredConfiguration = await loadPublicOptions(
        configuration,
        recoveredCredential,
        input.timeZone ?? "America/New_York",
        input.date
      );
    } catch {
      throw availabilityError;
    }
    configuration = recoveredConfiguration;
    credential = recoveredCredential;
    headers = cpsHeaders(
      configuration,
      credential,
      input.timeZone ?? "America/New_York",
      input.date
    );
    slots = await fetchCpsAvailability(input, configuration, credential, headers);
  }
  const bookingWindowEvidence = input.discoverBookingWindow
    ? await fetchCpsBookingWindow(input, configuration, credential)
    : null;

  return {
    slots,
    targetDateStatus: slots.length > 0 ? "OPEN" : "UNKNOWN",
    bookingWindowEvidence
  };
}

async function fetchCpsAvailability(
  input: CpsFetchInput,
  configuration: CpsConfiguration,
  credential: { token?: string; apiKey?: string },
  headers: Record<string, string>
) {
  const slots: TeeTimeSlot[] = [];
  const seen = new Set<string>();

  const holeSearches = credential.apiKey ? [0] : (input.metadata.holes ?? [18, 9]);
  for (const holes of holeSearches) {
    const transactionId = credential.token ? crypto.randomUUID() : undefined;
    if (transactionId) {
      await registerTransactionId(configuration.onlineApi, headers, transactionId);
    }
    const url = buildTeeTimesUrl(configuration.onlineApi, {
      date: input.date,
      players: credential.apiKey ? 0 : input.players,
      cpsCourseIds: input.metadata.courseIds,
      holes,
      transactionId
    });
    const payload = await retryCpsReadOnTimeout(async () => {
      const response = await fetchWithProviderTimeout(url, {
        headers
      });

      if (!response.ok) {
        throw providerHttpError("CPS tee times", response);
      }

      return (await response.json()) as CpsSearchResponse;
    });
    const content = getCpsSearchContent(payload);

    for (const slot of content) {
      if (!slot.startTime || !slot.teeSheetId) {
        continue;
      }

      const availableSpots = getAvailableSpots(slot);
      if (availableSpots < 1) {
        continue;
      }

      const sourceId = `cps-${configuration.siteName}-${slot.teeSheetId}`;
      if (seen.has(sourceId)) {
        continue;
      }

      seen.add(sourceId);
      const resolvedHoles = slot.holes ?? slot.defaultHoles ?? holes;
      slots.push({
        courseId: input.courseId,
        sourceId,
        startsAt: normalizeCpsTime(slot.startTime),
        availableSpots,
        bookingUrl: withDateParam(input.metadata.bookingBaseUrl, input.date),
        priceCents: getPriceCents(slot),
        ...(resolvedHoles === 9 || resolvedHoles === 18 ? { holes: resolvedHoles } : {}),
        evidenceUrl: url
      });
    }
  }

  return slots;
}

async function fetchCpsBookingWindow(
  input: CpsFetchInput,
  configuration: CpsConfiguration,
  credential: { token?: string; apiKey?: string }
): Promise<BookingWindowEvidence | null> {
  try {
    const timeZone = input.timeZone ?? "America/New_York";
    const optionsConfiguration = credential.token
      ? await loadPublicOptions(configuration, credential, timeZone, input.date)
      : configuration;
    const url = new URL(`${optionsConfiguration.onlineApi}/BookingRuleModels`);
    url.searchParams.set("classcode", "R");
    url.searchParams.set("courseIds", input.metadata.courseIds.join(","));
    url.searchParams.set("searchDate", formatCpsDate(input.date));

    const payload = await retryCpsReadOnTimeout(async () => {
      const response = await fetchWithProviderTimeout(url, {
        headers: cpsHeaders(optionsConfiguration, credential, timeZone, input.date)
      });
      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CpsBookingRuleResponse;
    });
    if (!payload) {
      return null;
    }
    const publicRules =
      payload.bookingRuleByClass?.find((group) => group.classCode?.toUpperCase() === "R")
        ?.bookingRuleByCourse ?? [];
    const rules = publicRules.length > 0 ? publicRules : (payload.bookingRuleByCourses ?? []);
    const normalizedRules = rules
      .filter(
        (rule) =>
          rule.courseId === undefined || input.metadata.courseIds.includes(rule.courseId)
      )
      .map((rule) => normalizeCpsBookingRule(rule, payload.weekends, input.date))
      .filter((rule): rule is { daysAhead: number; releaseTimeLocal: string | null } => Boolean(rule));

    if (normalizedRules.length === 0) {
      return null;
    }

    const daysAhead = new Set(normalizedRules.map((rule) => rule.daysAhead));
    const releaseTimes = new Set(normalizedRules.map((rule) => rule.releaseTimeLocal));
    if (daysAhead.size !== 1 || releaseTimes.size !== 1) {
      return null;
    }

    return {
      daysAhead: normalizedRules[0].daysAhead,
      releaseTimeLocal: normalizedRules[0].releaseTimeLocal,
      source: "PROVIDER_CONFIG",
      confidence: 1,
      evidenceUrl: url.toString()
    };
  } catch {
    return null;
  }
}

function normalizeCpsBookingRule(
  rule: CpsBookingRule,
  weekends: string[] | undefined,
  targetDate: Date
) {
  const weekday = FULL_WEEKDAYS[targetDate.getUTCDay()];
  const usesWeekendRule = weekends?.some(
    (candidate) => candidate.toLowerCase() === weekday.toLowerCase()
  );
  const daysAhead = usesWeekendRule
    ? (rule.daysInAdvanceWeekend ?? rule.daysInAdvance)
    : rule.daysInAdvance;
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
    releaseTimeLocal: normalizeCpsReleaseTime(rule.time)
  };
}

function normalizeCpsReleaseTime(value: string | undefined) {
  if (!value) {
    return null;
  }

  const localTime = value.match(/(?:T|\s)(\d{1,2}:\d{2})(?::\d{2})?/i)?.[1] ?? value;
  return normalizeReleaseTime(localTime);
}

async function loadConfiguration(metadata: CpsMetadata): Promise<CpsConfiguration> {
  if (metadata.onlineApi && metadata.authorityBaseUrl && metadata.websiteId) {
    const persistedConfiguration = sanitizeCpsConfiguration(
      {
        clientId: metadata.clientId ?? "onlineresweb",
        authorityBaseUrl: metadata.authorityBaseUrl,
        onlineApi: metadata.onlineApi,
        websiteId: metadata.websiteId,
        siteName: metadata.siteName
      },
      metadata
    );
    if (!persistedConfiguration) {
      throw new Error("CPS persisted configuration is invalid");
    }
    return persistedConfiguration;
  }

  const bookingBase = getSafeCpsTenantRoot(
    metadata.siteName,
    metadata.bookingBaseUrl
  );
  if (!bookingBase) {
    throw new Error("CPS metadata is invalid");
  }
  const url = new URL("/onlineresweb/Home/Configuration", bookingBase);
  return retryCpsReadOnTimeout(async () => {
    const response = await fetchWithProviderTimeout(url, {
      redirect: "manual"
    });
    if (!response.ok) {
      throw providerHttpError("CPS configuration", response);
    }
    if (
      response.status !== 200 ||
      !isExpectedCpsConfigurationResponse(response, url)
    ) {
      throw new Error("CPS configuration returned an invalid response");
    }

    const value = await readBoundedCpsConfiguration(response);
    const configuration = sanitizeCpsConfiguration(value, metadata);
    if (!configuration) {
      throw new Error("CPS configuration returned an invalid response");
    }
    return configuration;
  });
}

async function tryLoadPublishedCpsApiKey(
  metadata: CpsMetadata,
  baseline: CpsConfiguration
): Promise<string | null> {
  // This is a single best-effort public read after the short-lived token path
  // exhausts its narrow transient retry budget. It may contribute only a key:
  // persisted tenant identity and endpoints remain authoritative.
  try {
    const url = getSafeCpsConfigurationUrl(metadata, baseline);
    if (!url) {
      return null;
    }
    const response = await fetchWithProviderTimeout(url, { redirect: "manual" });
    if (
      !response.ok ||
      response.status !== 200 ||
      !isExpectedCpsConfigurationResponse(response, url)
    ) {
      return null;
    }
    return getMatchingPublishedCpsApiKey(
      await readBoundedCpsConfiguration(response),
      baseline,
      metadata
    );
  } catch {
    return null;
  }
}

function getSafeCpsConfigurationUrl(
  metadata: CpsMetadata,
  baseline: CpsConfiguration
) {
  const bookingBase = getSafeCpsTenantRoot(
    metadata.siteName,
    metadata.bookingBaseUrl
  );
  const authorityBase = parseExpectedCpsEndpoint(
    baseline.authorityBaseUrl,
    bookingBase,
    CPS_AUTHORITY_PATH
  );
  const onlineApi = parseExpectedCpsEndpoint(
    baseline.onlineApi,
    bookingBase,
    CPS_ONLINE_API_PATH
  );
  if (!bookingBase || !authorityBase || !onlineApi) {
    return null;
  }
  return new URL("/onlineresweb/Home/Configuration", bookingBase);
}

function getMatchingPublishedCpsApiKey(
  value: unknown,
  baseline: CpsConfiguration,
  metadata: CpsMetadata
) {
  const configuration = sanitizeCpsConfiguration(value, metadata);
  if (!configuration) {
    return null;
  }
  if (
    !configuration.apiKey ||
    configuration.clientId !== baseline.clientId ||
    configuration.websiteId !== baseline.websiteId ||
    configuration.siteName !== baseline.siteName ||
    configuration.authorityBaseUrl !== baseline.authorityBaseUrl ||
    configuration.onlineApi !== baseline.onlineApi
  ) {
    return null;
  }
  return configuration.apiKey;
}

function normalizeCpsApiKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sanitizeCpsConfiguration(
  value: unknown,
  metadata: Pick<CpsMetadata, "siteName" | "bookingBaseUrl">
): CpsConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const bookingBase = getSafeCpsTenantRoot(
    metadata.siteName,
    metadata.bookingBaseUrl
  );
  if (!bookingBase) {
    return null;
  }
  const raw = value as Partial<CpsConfiguration>;
  const siteName = normalizeCpsConfigurationText(raw.siteName, 80);
  const clientId = normalizeCpsConfigurationText(raw.clientId, 200);
  const websiteId = normalizeCpsConfigurationText(raw.websiteId, 200);
  const authorityBaseUrl = parseExpectedCpsEndpoint(
    raw.authorityBaseUrl,
    bookingBase,
    CPS_AUTHORITY_PATH
  );
  const onlineApi = parseExpectedCpsEndpoint(
    raw.onlineApi,
    bookingBase,
    CPS_ONLINE_API_PATH
  );
  if (
    !siteName ||
    siteName.toLowerCase() !== metadata.siteName.trim().toLowerCase() ||
    !clientId ||
    !websiteId ||
    !authorityBaseUrl ||
    !onlineApi
  ) {
    return null;
  }

  const apiKey = normalizeCpsApiKey(raw.apiKey);
  const buildNumber = normalizeCpsConfigurationText(raw.buildNumber, 200);
  const terminalId =
    Number.isSafeInteger(raw.terminalId) && (raw.terminalId as number) >= 0
      ? (raw.terminalId as number)
      : undefined;
  return {
    clientId,
    authorityBaseUrl,
    onlineApi,
    websiteId,
    siteName,
    ...(apiKey ? { apiKey } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(terminalId !== undefined ? { terminalId } : {})
  };
}

function normalizeCpsConfigurationText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function getSafeCpsTenantRoot(siteNameValue: unknown, bookingBaseUrl: unknown) {
  if (typeof siteNameValue !== "string") {
    return null;
  }
  const siteName = siteNameValue.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(siteName)) {
    return null;
  }
  const bookingBase = parseSafeCpsHttpsUrl(bookingBaseUrl);
  if (
    !bookingBase ||
    bookingBase.hostname.toLowerCase() !== `${siteName}.cps.golf` ||
    bookingBase.hostname.toLowerCase() === "sc.cps.golf" ||
    bookingBase.pathname !== "/"
  ) {
    return null;
  }
  return bookingBase;
}

function parseExpectedCpsEndpoint(
  value: unknown,
  bookingBase: URL | null,
  expectedPath: string
) {
  const endpoint = parseSafeCpsHttpsUrl(value);
  if (
    !bookingBase ||
    !endpoint ||
    endpoint.origin !== bookingBase.origin ||
    endpoint.pathname.replace(/\/+$/, "") !== expectedPath
  ) {
    return null;
  }
  return `${bookingBase.origin}${expectedPath}`;
}

function isExpectedCpsConfigurationResponse(response: Response, expectedUrl: URL) {
  if (response.redirected) {
    return false;
  }
  if (!response.url) {
    return true;
  }
  try {
    const responseUrl = new URL(response.url);
    return responseUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

async function readBoundedCpsConfiguration(response: Response) {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    !contentType?.endsWith("+json")
  ) {
    return null;
  }
  const declaredLength = response.headers.get("content-length")?.trim();
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > CPS_CONFIGURATION_MAX_BYTES)
  ) {
    return null;
  }
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      byteLength += chunk.byteLength;
      if (byteLength > CPS_CONFIGURATION_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseSafeCpsHttpsUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      hasUrlUserInfo(trimmed) ||
      url.search ||
      url.hash ||
      hasExplicitUrlPort(trimmed) ||
      !isPublicHostname(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function hasUrlUserInfo(value: string) {
  return getRawUrlAuthority(value)?.includes("@") ?? true;
}

function hasExplicitUrlPort(value: string) {
  const authority = getRawUrlAuthority(value);
  if (!authority) {
    return true;
  }
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host.startsWith("[") ? host.includes("]:") : host.includes(":");
}

function getRawUrlAuthority(value: string) {
  return value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i)?.[1] ?? null;
}

function isPublicHostname(value: string) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  return Boolean(
    hostname.includes(".") &&
      /[a-z]/.test(hostname) &&
      !hostname.includes(":") &&
      !hostname.endsWith(".") &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal") &&
      !hostname.endsWith(".lan")
  );
}

async function fetchShortLivedToken(configuration: CpsConfiguration) {
  return retryCpsTokenRequest(async () => {
    const response = await fetchWithProviderTimeout(
      `${configuration.authorityBaseUrl}/myconnect/token/short`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: "onlinereswebshortlived",
          client_secret: "v4secret",
          grant_type: "client_credentials"
        })
      }
    );

    if (!response.ok) {
      throw providerHttpError("CPS token", response);
    }

    const token = (await response.json()) as CpsTokenResponse;
    if (!token.access_token) {
      throw new Error("CPS token response did not include an access token");
    }

    return token.access_token;
  });
}

async function loadPublicOptions(
  configuration: CpsConfiguration,
  credential: { token?: string; apiKey?: string },
  timeZone: string,
  date: Date
) {
  const url = new URL(`${configuration.onlineApi}/GetAllOptions/${configuration.siteName}`);
  if (configuration.buildNumber?.trim()) {
    url.searchParams.set("version", configuration.buildNumber.trim());
  }
  url.searchParams.set("product", "3");
  const payload = await retryCpsReadOnTimeout(async () => {
    const response = await fetchWithProviderTimeout(url, {
      headers: cpsHeaders(configuration, credential, timeZone, date)
    });
    if (!response.ok) {
      throw providerHttpError("CPS public options", response);
    }
    return (await response.json()) as {
      webSiteId?: string;
      reservationOptions?: { terminalId?: number };
    };
  });
  if (!payload.webSiteId) {
    throw new Error("CPS public options did not include a website id");
  }
  return {
    ...configuration,
    websiteId: payload.webSiteId,
    terminalId: payload.reservationOptions?.terminalId ?? configuration.terminalId ?? 1
  };
}

async function registerTransactionId(onlineApi: string, headers: Record<string, string>, transactionId: string) {
  const response = await fetchWithProviderTimeout(`${onlineApi}/RegisterTransactionId`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      transactionId,
      action: "homepage"
    })
  });

  if (!response.ok) {
    throw providerHttpError("CPS transaction registration", response);
  }
}

function isCpsTransactionCredentialRejection(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    const record = error as {
      name?: unknown;
      message?: unknown;
      status?: unknown;
    };
    return Boolean(
      record.name === "ProviderHttpError" &&
        (record.status === 401 || record.status === 403) &&
        record.message ===
          `CPS transaction registration returned ${record.status}`
    );
  } catch {
    return false;
  }
}

async function retryCpsReadOnTimeout<T>(read: () => Promise<T>): Promise<T> {
  // Only idempotent public reads use this helper. Transaction registration
  // remains single-attempt so a timeout can never duplicate that POST.
  for (let attempt = 1; attempt <= CPS_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt === CPS_READ_ATTEMPTS || !isCpsTimeoutError(error)) {
        throw error;
      }
    }
  }

  throw new Error("CPS read retry exhausted without an error");
}

async function retryCpsTokenRequest<T>(request: () => Promise<T>): Promise<T> {
  // This POST only mints the short-lived read credential. Keep its retry budget
  // to one and never retry client, rate-limit, schema, or credential failures.
  for (let attempt = 1; attempt <= CPS_READ_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (
        attempt === CPS_READ_ATTEMPTS ||
        (!isCpsTimeoutError(error) && !isTransientCpsTokenHttpError(error))
      ) {
        throw error;
      }
    }
  }

  throw new Error("CPS token retry exhausted without an error");
}

function canRecoverCpsTokenErrorWithPublishedKey(error: unknown) {
  return (
    isCpsTimeoutError(error) ||
    isTransientCpsTokenHttpError(error) ||
    isCpsTokenCredentialRejection(error)
  );
}

function isCpsTokenCredentialRejection(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    const record = error as { name?: unknown; status?: unknown };
    return Boolean(
      record.name === "ProviderHttpError" &&
        (record.status === 401 || record.status === 403)
    );
  } catch {
    return false;
  }
}

function isTransientCpsTokenHttpError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    const record = error as { name?: unknown; status?: unknown };
    return Boolean(
      record.name === "ProviderHttpError" &&
        typeof record.status === "number" &&
        CPS_TRANSIENT_TOKEN_HTTP_STATUSES.has(record.status)
    );
  } catch {
    return false;
  }
}

function isCpsTimeoutError(error: unknown) {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let inspected = 0;

  while (
    pending.length > 0 &&
    inspected < CPS_TIMEOUT_ERROR_INSPECTION_LIMIT
  ) {
    const candidate = pending.shift();
    inspected += 1;
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    try {
      const record = candidate as {
        name?: unknown;
        code?: unknown;
        cause?: unknown;
        errors?: unknown;
      };
      if (
        (typeof record.name === "string" && CPS_TIMEOUT_ERROR_NAMES.has(record.name)) ||
        (typeof record.code === "string" && CPS_TIMEOUT_ERROR_CODES.has(record.code))
      ) {
        return true;
      }

      if (record.cause !== undefined) {
        pending.push(record.cause);
      }
      if (
        record.name === "AggregateError" &&
        Array.isArray(record.errors)
      ) {
        pending.push(
          ...record.errors.slice(
            0,
            CPS_TIMEOUT_ERROR_INSPECTION_LIMIT - inspected
          )
        );
      }
    } catch {
      // An exotic error object with throwing accessors is not timeout proof.
    }
  }

  return false;
}

function getCpsSearchContent(payload: unknown): CpsApiSlot[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    throw invalidCpsSearchResponseError(payload);
  }

  const content = (payload as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content;
  }
  if (isCpsNoTeeTimesSentinel(payload)) {
    return [];
  }
  throw invalidCpsSearchResponseError(payload);
}

function invalidCpsSearchResponseError(payload: unknown) {
  return new Error(
    `CPS tee times returned an invalid response schema (${describeCpsSearchResponse(payload)})`
  );
}

function describeCpsSearchResponse(payload: unknown) {
  const topLevel = describeCpsValueType(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `topLevel=${topLevel}`;
  }

  const record = payload as Record<string, unknown>;
  const content = record.content;
  const contentRecord =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : null;
  const contentHasMessageKey = Boolean(
    contentRecord && Object.hasOwn(contentRecord, "messageKey")
  );
  const contentHasMessageDetail = Boolean(
    contentRecord && Object.hasOwn(contentRecord, "messageDetail")
  );
  const messageKey = contentHasMessageKey
    ? contentRecord?.messageKey
    : record.messageKey;
  const messageDetail = contentHasMessageDetail
    ? contentRecord?.messageDetail
    : record.messageDetail;
  const hasMessageDetail =
    contentHasMessageDetail || Object.hasOwn(record, "messageDetail");

  return [
    `topLevel=${topLevel}`,
    `topKeys=${describeCpsObjectKeys(record)}`,
    `content=${describeCpsValueType(content)}`,
    ...(contentRecord ? [`contentKeys=${describeCpsObjectKeys(contentRecord)}`] : []),
    ...(messageKey !== undefined
      ? [`messageKey=${describeCpsMessageKey(messageKey)}`]
      : []),
    ...(hasMessageDetail
      ? [`messageDetail=${describeCpsDiagnosticValue(messageDetail)}`]
      : [])
  ].join(";");
}

function describeCpsValueType(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function describeCpsObjectKeys(record: Record<string, unknown>) {
  const keys = Object.keys(record);
  const safeKeys = keys
    .filter((key) => CPS_RESPONSE_DIAGNOSTIC_KEYS.has(key))
    .sort()
    .slice(0, CPS_RESPONSE_DIAGNOSTIC_KEY_LIMIT);
  const omitted = keys.length - safeKeys.length;
  return `${safeKeys.length > 0 ? safeKeys.join(",") : "none"}${
    omitted > 0 ? `,+${omitted}` : ""
  }`;
}

function describeCpsMessageKey(value: unknown) {
  return typeof value === "string" &&
    CPS_RESPONSE_DIAGNOSTIC_MESSAGE_KEYS.has(value)
    ? value
    : describeCpsDiagnosticValue(value);
}

function describeCpsDiagnosticValue(value: unknown) {
  return typeof value === "string"
    ? `string:length=${value.length}`
    : describeCpsValueType(value);
}

function isCpsNoTeeTimesSentinel(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope);
  if (
    envelopeKeys.length !== 3 ||
    envelopeKeys.some(
      (key) => key !== "transactionId" && key !== "isSuccess" && key !== "content"
    ) ||
    envelope.isSuccess !== true ||
    typeof envelope.transactionId !== "string" ||
    envelope.transactionId.length < 1 ||
    envelope.transactionId.length > CPS_NO_TEE_TIMES_TRANSACTION_ID_MAX_LENGTH ||
    !envelope.content ||
    typeof envelope.content !== "object" ||
    Array.isArray(envelope.content)
  ) {
    return false;
  }
  const content = envelope.content as Record<string, unknown>;
  const contentKeys = Object.keys(content);
  return (
    contentKeys.length === 5 &&
    contentKeys.every(
      (key) =>
        key === "messageKey" ||
        key === "messageTemplate" ||
        key === "messageAppearance" ||
        key === "messageDetail" ||
        key === "messageType"
    ) &&
    content.messageKey === CPS_NO_TEE_TIMES_MESSAGE_KEY &&
    content.messageTemplate === CPS_NO_TEE_TIMES_MESSAGE_TEMPLATE &&
    content.messageAppearance === CPS_NO_TEE_TIMES_MESSAGE_APPEARANCE &&
    content.messageDetail === CPS_NO_TEE_TIMES_MESSAGE_DETAIL &&
    content.messageType === CPS_NO_TEE_TIMES_MESSAGE_TYPE
  );
}

function buildTeeTimesUrl(
  onlineApi: string,
  input: {
    date: Date;
    players: number;
    cpsCourseIds: number[];
    holes: number;
    transactionId?: string;
  }
) {
  const url = new URL(`${onlineApi}/TeeTimes`);
  url.searchParams.set("searchDate", formatCpsDate(input.date));
  url.searchParams.set("holes", String(input.holes));
  url.searchParams.set("numberOfPlayer", String(input.players));
  url.searchParams.set("courseIds", input.cpsCourseIds.join(","));
  url.searchParams.set("searchTimeType", "0");
  if (input.transactionId) {
    url.searchParams.set("transactionId", input.transactionId);
  }
  url.searchParams.set("teeOffTimeMin", "0");
  url.searchParams.set("teeOffTimeMax", "23");
  url.searchParams.set("isChangeTeeOffTime", "true");
  url.searchParams.set("teeSheetSearchView", "5");
  url.searchParams.set("classCode", "R");
  url.searchParams.set("defaultOnlineRate", "N");
  url.searchParams.set("isUseCapacityPricing", "false");
  url.searchParams.set("memberStoreId", "1");
  url.searchParams.set("searchType", "1");
  return url.toString();
}

function formatCpsDate(date: Date) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  return `${SHORT_WEEKDAYS[date.getUTCDay()]} ${months[month]} ${String(day).padStart(2, "0")} ${year}`;
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

function cpsHeaders(
  configuration: CpsConfiguration,
  credential: { token?: string; apiKey?: string },
  timeZone: string,
  date: Date
) {
  const dateValue = date.toISOString().slice(0, 10);
  const courseNoon = zonedDateTimeToDate(`${dateValue}T12:00:00`, timeZone);
  const offsetMinutes = Math.abs(getTimeZoneOffsetMinutes(courseNoon, timeZone));

  return {
    accept: "application/json, text/plain, */*",
    ...(credential.token ? { authorization: `Bearer ${credential.token}` } : {}),
    ...(credential.apiKey ? { "x-apikey": credential.apiKey } : {}),
    "client-id": configuration.clientId,
    "x-terminalid": String(configuration.terminalId ?? 1),
    "x-requestid": crypto.randomUUID(),
    "x-websiteid": configuration.websiteId,
    "x-ismobile": "false",
    "x-productid": "1",
    "x-componentid": "1",
    "x-siteid": "1",
    "x-timezone-offset": String(offsetMinutes),
    "x-timezoneid": timeZone,
    "x-moduleid": "7",
    referer: new URL(configuration.onlineApi).origin + "/"
  };
}

function getAvailableSpots(slot: CpsApiSlot) {
  if (Array.isArray(slot.availableParticipantNo) && slot.availableParticipantNo.length > 0) {
    return Math.max(...slot.availableParticipantNo);
  }

  if (typeof slot.maxPlayer === "number") {
    return slot.maxPlayer;
  }

  if (typeof slot.participants === "number") {
    return slot.participants;
  }

  return 0;
}

function getPriceCents(slot: CpsApiSlot) {
  const price =
    slot.teeSheetPrice ??
    slot.displayPrice ??
    slot.shItemPrices?.find((item) => item.shItemCode?.toLowerCase().includes("greenfee"))
      ?.displayPrice;

  return typeof price === "number" ? Math.round(price * 100) : undefined;
}

function normalizeCpsTime(value: string) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 16);
  }

  return value.replace(" ", "T").slice(0, 16);
}

function withDateParam(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  return url.toString();
}
