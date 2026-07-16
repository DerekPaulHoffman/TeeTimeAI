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

export type CpsTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export class CpsAutomationPolicyBlockedError extends Error {
  readonly bookingUrl: string;
  readonly policyUrl: string;

  constructor(input: { bookingUrl: string; policyUrl: string }) {
    super(
      "The official CPS robots policy disallows automated access to the required reservation endpoint"
    );
    this.name = "CpsAutomationPolicyBlockedError";
    this.bookingUrl = input.bookingUrl;
    this.policyUrl = input.policyUrl;
  }
}

export function isCpsAutomationPolicyBlockedError(
  error: unknown
): error is CpsAutomationPolicyBlockedError {
  return error instanceof CpsAutomationPolicyBlockedError;
}

export function isCpsMetadata(value: unknown): value is CpsMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<CpsMetadata>;
  return (
    metadata.provider === "CPS" &&
    typeof metadata.siteName === "string" &&
    typeof metadata.bookingBaseUrl === "string" &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every((courseId) => typeof courseId === "number") &&
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
  let configuration = await loadConfiguration(input.metadata);
  const credential = configuration.apiKey
    ? { apiKey: configuration.apiKey }
    : { token: await fetchShortLivedToken(configuration) };
  if (credential.apiKey) {
    configuration = await loadPublicOptions(
      configuration,
      credential,
      input.timeZone ?? "America/New_York",
      input.date
    );
  }
  const headers = cpsHeaders(
    configuration,
    credential,
    input.timeZone ?? "America/New_York",
    input.date
  );
  const slots = await fetchCpsAvailability(input, configuration, credential, headers);
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
    const response = await fetchWithProviderTimeout(url, {
      headers
    });

    if (!response.ok) {
      throw providerHttpError("CPS tee times", response);
    }

    const payload = (await response.json()) as CpsSearchResponse;
    const content = Array.isArray(payload) ? payload : payload.content;
    if (!Array.isArray(content)) {
      continue;
    }

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

    const response = await fetchWithProviderTimeout(url, {
      headers: cpsHeaders(optionsConfiguration, credential, timeZone, input.date)
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as CpsBookingRuleResponse;
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
    return {
      clientId: metadata.clientId ?? "onlineresweb",
      authorityBaseUrl: metadata.authorityBaseUrl,
      onlineApi: metadata.onlineApi,
      websiteId: metadata.websiteId,
      siteName: metadata.siteName
    };
  }

  const url = new URL("/onlineresweb/Home/Configuration", metadata.bookingBaseUrl);
  const response = await fetchWithProviderTimeout(url);
  if (!response.ok) {
    if (
      (response.status === 401 || response.status === 403) &&
      (await isCpsPathBlockedByOfficialRobots(metadata.bookingBaseUrl, url.pathname))
    ) {
      throw new CpsAutomationPolicyBlockedError({
        bookingUrl: metadata.bookingBaseUrl,
        policyUrl: new URL("/robots.txt", metadata.bookingBaseUrl).toString()
      });
    }
    throw providerHttpError("CPS configuration", response);
  }

  return (await response.json()) as CpsConfiguration;
}

async function isCpsPathBlockedByOfficialRobots(
  bookingBaseUrl: string,
  requestPath: string
) {
  try {
    const robotsUrl = new URL("/robots.txt", bookingBaseUrl);
    const response = await fetchWithProviderTimeout(robotsUrl, {
      headers: { accept: "text/plain" }
    });
    if (!response.ok) {
      return false;
    }
    const robotsText = await response.text();
    return isPathDisallowedForWildcardAgent(robotsText, requestPath);
  } catch {
    return false;
  }
}

function isPathDisallowedForWildcardAgent(robotsText: string, requestPath: string) {
  const groups: Array<{
    agents: string[];
    rules: Array<{ kind: "allow" | "disallow"; pattern: string }>;
  }> = [];
  let agents: string[] = [];
  let rules: Array<{ kind: "allow" | "disallow"; pattern: string }> = [];
  const flushGroup = () => {
    if (agents.length > 0) {
      groups.push({ agents, rules });
    }
    agents = [];
    rules = [];
  };

  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (rules.length > 0) {
        flushGroup();
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if ((field === "allow" || field === "disallow") && agents.length > 0) {
      if (field === "allow" || value) {
        rules.push({ kind: field, pattern: value });
      }
    }
  }
  flushGroup();

  const matchingRules = groups
    .filter((group) => group.agents.includes("*"))
    .flatMap((group) => group.rules)
    .filter((rule) => robotsPatternMatches(rule.pattern, requestPath))
    .sort((left, right) => {
      const specificity = robotsPatternSpecificity(right.pattern) - robotsPatternSpecificity(left.pattern);
      if (specificity !== 0) {
        return specificity;
      }
      return left.kind === right.kind ? 0 : left.kind === "allow" ? -1 : 1;
    });

  return matchingRules[0]?.kind === "disallow";
}

function robotsPatternMatches(pattern: string, requestPath: string) {
  if (!pattern) {
    return false;
  }
  const endAnchored = pattern.endsWith("$");
  const sourcePattern = endAnchored ? pattern.slice(0, -1) : pattern;
  const source = sourcePattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}${endAnchored ? "$" : ""}`).test(requestPath);
}

function robotsPatternSpecificity(pattern: string) {
  return pattern.replace(/[*$]/g, "").length;
}

async function fetchShortLivedToken(configuration: CpsConfiguration) {
  const response = await fetchWithProviderTimeout(`${configuration.authorityBaseUrl}/myconnect/token/short`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: "onlinereswebshortlived",
      client_secret: "v4secret",
      grant_type: "client_credentials"
    })
  });

  if (!response.ok) {
    throw providerHttpError("CPS token", response);
  }

  const token = (await response.json()) as CpsTokenResponse;
  if (!token.access_token) {
    throw new Error("CPS token response did not include an access token");
  }

  return token.access_token;
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
  const response = await fetchWithProviderTimeout(url, {
    headers: cpsHeaders(configuration, credential, timeZone, date)
  });
  if (!response.ok) {
    throw providerHttpError("CPS public options", response);
  }
  const payload = (await response.json()) as {
    webSiteId?: string;
    reservationOptions?: { terminalId?: number };
  };
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
