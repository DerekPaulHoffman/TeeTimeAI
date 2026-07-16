import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import { getBookingWindowFromEvidence } from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { providerHttpError } from "./fetch-with-timeout";

const CHELSEA_REQUEST_TIMEOUT_MS = 10_000;
const CHELSEA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ChelseaMetadata = {
  provider: "CHELSEA";
  bookingBaseUrl: string;
  courseCode: number;
  courseLabel: string;
  bookingWindowDaysAhead?: number;
  bookingWindowEvidenceUrl?: string;
};

export type ChelseaTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

type ChelseaPage = {
  html: string;
  url: string;
};

export function isChelseaMetadata(value: unknown): value is ChelseaMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<ChelseaMetadata>;
  return (
    metadata.provider === "CHELSEA" &&
    isChelseaPublicUrl(metadata.bookingBaseUrl) &&
    Number.isInteger(metadata.courseCode) &&
    (metadata.courseCode ?? 0) > 0 &&
    typeof metadata.courseLabel === "string" &&
    metadata.courseLabel.trim().length > 0 &&
    (metadata.bookingWindowDaysAhead === undefined ||
      (Number.isInteger(metadata.bookingWindowDaysAhead) &&
        metadata.bookingWindowDaysAhead >= 0 &&
        metadata.bookingWindowDaysAhead <= 90)) &&
    (metadata.bookingWindowEvidenceUrl === undefined ||
      isPublicHttpUrl(metadata.bookingWindowEvidenceUrl))
  );
}

export async function fetchChelseaTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    timeZone?: string;
    metadata: ChelseaMetadata;
  },
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<ChelseaTeeSheetResult> {
  const targetDate = input.date.toISOString().slice(0, 10);
  const bookingWindowEvidence = getBookingWindowEvidence(input.metadata);
  if (bookingWindowEvidence) {
    const bookingWindow = getBookingWindowFromEvidence(
      input.date,
      input.timeZone ?? "America/New_York",
      bookingWindowEvidence
    );
    if (bookingWindow && bookingWindow.opensAt > now) {
      return {
        slots: [],
        targetDateStatus: "NOT_OPEN",
        bookingWindowEvidence
      };
    }
  }

  const bookingPageUrl = new URL(
    "/GPInprocess/code/Booking/booking1.aspx",
    input.metadata.bookingBaseUrl
  ).toString();
  const cookies = new Map<string, string>();
  let page = await requestChelseaPage(bookingPageUrl, undefined, cookies, fetchImpl);

  let dayButton = findTargetDayButton(page.html, targetDate);
  if (!dayButton) {
    page = await postChelseaForm(
      page,
      {
        ...baseSearchFields(input.metadata, input.players),
        __EVENTTARGET: "gaNextWeek",
        __EVENTARGUMENT: ""
      },
      cookies,
      fetchImpl
    );
    dayButton = findTargetDayButton(page.html, targetDate);
  }

  if (!dayButton) {
    return {
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence
    };
  }

  page = await postChelseaForm(
    page,
    {
      ...baseSearchFields(input.metadata, input.players),
      [dayButton]: ""
    },
    cookies,
    fetchImpl
  );
  if (normalizeChelseaDate(readHiddenValue(page.html, "hdSelectedDate")) !== targetDate) {
    throw new Error("Chelsea tee sheet did not select the requested date");
  }

  page = await postChelseaForm(
    page,
    {
      ...baseSearchFields(input.metadata, input.players),
      btnDisplayTimes: "GO >"
    },
    cookies,
    fetchImpl
  );

  const slots = parseChelseaSlots({
    html: page.html,
    targetDate,
    courseId: input.courseId,
    bookingUrl: input.metadata.bookingBaseUrl,
    evidenceUrl: bookingPageUrl,
    providerKey: new URL(input.metadata.bookingBaseUrl).hostname.split(".")[0],
    courseLabel: input.metadata.courseLabel
  });

  return {
    slots,
    targetDateStatus: slots.length > 0 ? "OPEN" : "UNKNOWN",
    bookingWindowEvidence
  };
}

function getBookingWindowEvidence(metadata: ChelseaMetadata): BookingWindowEvidence | null {
  if (
    metadata.bookingWindowDaysAhead === undefined ||
    !metadata.bookingWindowEvidenceUrl
  ) {
    return null;
  }
  return {
    daysAhead: metadata.bookingWindowDaysAhead,
    releaseTimeLocal: null,
    source: "OFFICIAL_BOOKING_PAGE",
    confidence: 0.98,
    evidenceUrl: metadata.bookingWindowEvidenceUrl
  };
}

function baseSearchFields(metadata: ChelseaMetadata, players: number) {
  return {
    ddlCourse1: String(metadata.courseCode),
    ddlTime: "05:00",
    ddlTimeEnd: "18:00",
    ddlQuantity: String(Math.min(4, Math.max(1, players))),
    ddlMemberType: "05"
  };
}

async function postChelseaForm(
  page: ChelseaPage,
  fields: Record<string, string>,
  cookies: Map<string, string>,
  fetchImpl: typeof fetch
) {
  const form = new URLSearchParams({
    ...extractHiddenFields(page.html),
    ...fields
  });
  return requestChelseaPage(page.url, form, cookies, fetchImpl);
}

async function requestChelseaPage(
  url: string,
  body: URLSearchParams | undefined,
  cookies: Map<string, string>,
  fetchImpl: typeof fetch
): Promise<ChelseaPage> {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9",
      "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)",
      ...(cookies.size > 0 ? { Cookie: serializeCookies(cookies) } : {}),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(CHELSEA_REQUEST_TIMEOUT_MS)
  });
  updateCookies(cookies, response.headers);
  if (!response.ok) {
    throw providerHttpError("Chelsea tee sheet", response);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > CHELSEA_MAX_RESPONSE_BYTES) {
    throw new Error("Chelsea tee sheet response exceeded the size limit");
  }
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > CHELSEA_MAX_RESPONSE_BYTES) {
    throw new Error("Chelsea tee sheet response exceeded the size limit");
  }
  return { html, url: response.url || url };
}

function extractHiddenFields(html: string) {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*\btype=["']hidden["'][^>]*>/gi)) {
    const name = readTagAttribute(match[0], "name");
    if (name) {
      fields[name] = decodeHtmlEntities(readTagAttribute(match[0], "value") ?? "");
    }
  }
  return fields;
}

function findTargetDayButton(html: string, targetDate: string) {
  const [, targetMonth, targetDay] = targetDate.split("-").map(Number);
  for (let index = 1; index <= 7; index += 1) {
    const monthText = html.match(
      new RegExp(`<span[^>]+id=["']lblDowMonth${index}["'][^>]*>([^<]+)<\\/span>`, "i")
    )?.[1];
    const dayText = html.match(
      new RegExp(`<span[^>]+id=["']lblDowDay${index}["'][^>]*>([^<]+)<\\/span>`, "i")
    )?.[1];
    if (monthNumber(monthText) === targetMonth && Number(dayText) === targetDay) {
      return `gaDOWButton${index}`;
    }
  }
  return null;
}

function parseChelseaSlots(input: {
  html: string;
  targetDate: string;
  courseId: string;
  bookingUrl: string;
  evidenceUrl: string;
  providerKey: string;
  courseLabel: string;
}) {
  const slots: TeeTimeSlot[] = [];
  const slotPattern =
    /<div[^>]+class=["']garesultTime["'][^>]*>([^<]+)<\/div>[\s\S]*?<div[^>]+class=["']garesultCourseName["'][^>]*>([^<]+)[\s\S]*?<select[^>]+class=["']garesultPlayerSelect["'][^>]*>([\s\S]*?)<\/select>[\s\S]*?<img[^>]+(?:alt|title)=["']([^"']*Hole Time)["'][^>]*>[\s\S]*?<button([^>]*)>\s*Reserve\s*<\/button>/gi;
  for (const match of input.html.matchAll(slotPattern)) {
    const time = parseChelseaTime(match[1]);
    const courseName = decodeHtmlEntities(match[2]).trim();
    const availableSpots = Math.max(
      0,
      ...[...match[3].matchAll(/<option[^>]*>\s*(\d+)\s*<\/option>/gi)].map((option) =>
        Number(option[1])
      )
    );
    const holes = Number(match[4].match(/\b(9|18)\b/)?.[1]);
    const reserveId = readTagAttribute(match[5], "id");
    if (
      !time ||
      availableSpots < 1 ||
      !reserveId ||
      !courseName.toLowerCase().includes(input.courseLabel.toLowerCase())
    ) {
      continue;
    }
    slots.push({
      courseId: input.courseId,
      sourceId: `chelsea-${input.providerKey}-${reserveId}`,
      startsAt: `${input.targetDate}T${time}`,
      availableSpots,
      bookingUrl: input.bookingUrl,
      ...(holes === 9 || holes === 18 ? { holes } : {}),
      evidenceUrl: input.evidenceUrl
    });
  }
  return slots;
}

function parseChelseaTime(value: string) {
  const match = decodeHtmlEntities(value).match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === "AM") {
    hour = hour === 12 ? 0 : hour;
  } else {
    hour = hour === 12 ? 12 : hour + 12;
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function readHiddenValue(html: string, id: string) {
  const tag = html.match(new RegExp(`<input[^>]+id=["']${id}["'][^>]*>`, "i"))?.[0];
  return tag ? decodeHtmlEntities(readTagAttribute(tag, "value") ?? "") : "";
}

function readTagAttribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1];
}

function normalizeChelseaDate(value: string) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match
    ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`
    : value;
}

function monthNumber(value?: string) {
  return value
    ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
        value.trim().slice(0, 3).toLowerCase()
      ) + 1
    : 0;
}

function updateCookies(cookies: Map<string, string>, headers: Headers) {
  const setCookies =
    "getSetCookie" in headers && typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function serializeCookies(cookies: Map<string, string>) {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function isChelseaPublicUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /(^|\.)chelseareservations\.com$/i.test(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
