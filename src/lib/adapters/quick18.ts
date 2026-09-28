import { parse, type DefaultTreeAdapterMap } from "parse5";

import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const MAX_HTML_BYTES = 256_000;
const MAX_SLOTS = 200;
const TENANT_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.quick18\.com$/u;
const RESERVED_TENANTS = new Set(["api", "admin", "auth", "cdn", "dev", "www"]);

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

export type Quick18Metadata = {
  provider: "QUICK18";
  bookingBaseUrl: string;
};

export function isQuick18PublicSearchUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const tenant = url.hostname.match(TENANT_HOST)?.[1];
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !tenant ||
      RESERVED_TENANTS.has(tenant) ||
      url.pathname !== "/teetimes/searchmatrix" ||
      url.hash
    ) {
      return false;
    }
    const entries = [...url.searchParams.entries()];
    return (
      entries.length === 0 ||
      (entries.length === 1 &&
        entries[0][0] === "teedate" &&
        isCompactDate(entries[0][1]))
    );
  } catch {
    return false;
  }
}

export function isQuick18Metadata(value: unknown): value is Quick18Metadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<Quick18Metadata>;
  return (
    metadata.provider === "QUICK18" &&
    typeof metadata.bookingBaseUrl === "string" &&
    isQuick18PublicSearchUrl(metadata.bookingBaseUrl)
  );
}

export async function fetchQuick18TeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: Quick18Metadata;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN";
  bookingWindowEvidence: null;
}> {
  if (!isQuick18Metadata(input.metadata)) {
    throw schemaError("Quick18 booking source is not a public search page");
  }
  if (!Number.isInteger(input.players) || input.players < 1 || input.players > 4) {
    throw schemaError("Quick18 player count is outside the supported range");
  }
  const targetDate = input.date.toISOString().slice(0, 10);
  const compactDate = targetDate.replaceAll("-", "");
  const evidenceUrl = new URL(input.metadata.bookingBaseUrl);
  evidenceUrl.search = "";
  evidenceUrl.searchParams.set("teedate", compactDate);

  const response = await fetchWithProviderTimeout(
    evidenceUrl.toString(),
    {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
      }
    },
    fetchImpl
  );
  if (!response.ok) throw providerHttpError("Quick18 tee times", response);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/^text\/html(?:\s*;|$)/iu.test(contentType)) {
    throw schemaError("Quick18 tee sheet did not return HTML");
  }
  if (response.url && !isExpectedResponseUrl(response.url, evidenceUrl)) {
    throw schemaError("Quick18 tee sheet changed the requested destination");
  }

  const html = await readBoundedHtml(response);
  const slots = parseQuick18Slots({
    html,
    courseId: input.courseId,
    targetDate,
    players: input.players,
    evidenceUrl: evidenceUrl.toString()
  });
  return {
    slots,
    targetDateStatus: "OPEN",
    bookingWindowEvidence: null
  };
}

export function parseQuick18Slots(input: {
  html: string;
  courseId: string;
  targetDate: string;
  players: number;
  evidenceUrl: string;
}): TeeTimeSlot[] {
  const document = parse(input.html);
  const selectedDate = findElements(document, "input").find(
    (element) => attribute(element, "id") === "SearchForm_Date"
  );
  if (!selectedDate || parseDisplayedDate(attribute(selectedDate, "value")) !== input.targetDate) {
    throw schemaError("Quick18 tee sheet did not select the requested date");
  }
  const matrixContainer = findElements(document, "div").find(
    (element) => attribute(element, "id") === "searchMatrix"
  );
  if (!matrixContainer) throw schemaError("Quick18 public tee-time matrix is missing");
  const expectedDate = input.targetDate.replaceAll("-", "");
  const expectedOrigin = new URL(input.evidenceUrl).origin;
  const hasRequestedDay = findElements(matrixContainer, "a").some((link) => {
    try {
      const url = new URL(attribute(link, "href") ?? "", expectedOrigin);
      return (
        url.origin === expectedOrigin &&
        isQuick18PublicSearchUrl(url) &&
        url.searchParams.get("teedate") === expectedDate
      );
    } catch {
      return false;
    }
  });
  if (!hasRequestedDay) {
    throw schemaError("Quick18 tee sheet did not show the requested date");
  }
  const matrix = findElements(matrixContainer, "table").find((element) =>
    (attribute(element, "class") ?? "").split(/\s+/u).includes("matrixTable")
  );
  if (!matrix) throw schemaError("Quick18 public tee-time table is missing");
  if (findElements(matrix, "tbody").length !== 1) {
    throw schemaError("Quick18 public tee-time table body is missing");
  }

  const headers = findElements(matrix, "th").map((element) => textContent(element).trim());
  if (headers[0] !== "Tee Time" || headers[1] !== "Players") {
    throw schemaError("Quick18 tee-time table columns changed");
  }
  const publicColumns = headers.flatMap((header, index) =>
    index >= 2 && isPublicRateHeader(header) ? [index] : []
  );
  if (publicColumns.length === 0) {
    throw schemaError("Quick18 public rate column is missing");
  }

  const origin = new URL(input.evidenceUrl).origin;
  const compactDate = input.targetDate.replaceAll("-", "");
  const slots: TeeTimeSlot[] = [];
  let sawTimeRow = false;
  let explicitNoTimes = false;
  for (const row of findElements(matrix, "tr")) {
    const cells = children(row, "td");
    if (cells.length === 0) continue;
    if (
      cells.length === 1 &&
      /\b(?:no tee times|no availability|no times available)\b/iu.test(
        textContent(cells[0])
      )
    ) {
      explicitNoTimes = true;
      continue;
    }
    if (cells.length !== headers.length) {
      throw schemaError("Quick18 tee-time row columns changed");
    }
    const time = parseLocalTime(textContent(cells[0]));
    const range = parsePlayerRange(textContent(cells[1]));
    if (!time || !range) {
      throw schemaError("Quick18 tee-time row could not be read");
    }
    sawTimeRow = true;
    if (input.players < range.min || input.players > range.max) continue;

    const publicBookings: Array<{ url: string; priceCents: number | null }> = [];
    for (const index of publicColumns) {
      for (const link of findElements(cells[index], "a")) {
        const href = attribute(link, "href");
        const url = href
          ? parsePublicSelectionUrl(href, origin, compactDate, time)
          : null;
        if (!url) {
          throw schemaError("Quick18 public rate exposed an unsafe booking link");
        }
        const priceCents = parsePriceCents(textContent(cells[index]));
        publicBookings.push({ url, priceCents });
      }
    }
    const booking = publicBookings[0];
    if (!booking) continue;
    const providerCourseId = new URL(booking.url).pathname.match(
      /^\/teetimes\/course\/([1-9]\d{0,9})\/teetime\//u
    )?.[1];
    if (!providerCourseId) continue;
    slots.push({
      sourceId: `quick18-${new URL(origin).hostname.split(".")[0]}-${providerCourseId}-${compactDate}${time.replace(":", "")}`,
      courseId: input.courseId,
      startsAt: `${input.targetDate}T${time}`,
      availableSpots: range.max,
      bookingUrl: booking.url,
      ...(booking.priceCents === null ? {} : { priceCents: booking.priceCents }),
      evidenceUrl: input.evidenceUrl
    });
    if (slots.length > MAX_SLOTS) {
      throw schemaError("Quick18 tee sheet exceeded the supported slot count");
    }
  }
  if (slots.length === 0) {
    if (/\b(?:loading tee times|please wait|updating tee times|unable to load|error loading|temporarily unavailable)\b/iu.test(visibleText(document))) {
      throw schemaError("Quick18 tee sheet is still loading or unavailable");
    }
    if (!sawTimeRow && !explicitNoTimes) {
      throw schemaError("Quick18 empty tee-time matrix has no completed no-times evidence");
    }
  }
  return slots;
}

function isPublicRateHeader(header: string) {
  return (
    /\b(?:daily rate|public|non[- ]?member|guest)\b/iu.test(header) &&
    !/\b(?:members?|membership|league|resident|staff|private|employee|passholder|season pass|corporate)\b/iu.test(
      header.replace(/non[- ]?member/iu, "")
    )
  );
}

function isExpectedResponseUrl(value: string, requested: URL) {
  try {
    const actual = new URL(value);
    return actual.toString() === requested.toString();
  } catch {
    return false;
  }
}

function parsePublicSelectionUrl(
  href: string,
  origin: string,
  compactDate: string,
  time: string
) {
  try {
    const url = new URL(href, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/teetimes\/course\/[1-9]\d{0,9}\/teetime\/[0-9]{12}$/u.test(url.pathname) ||
      !url.pathname.endsWith(`${compactDate}${time.replace(":", "")}`)
    ) {
      return null;
    }
    const entries = [...url.searchParams.entries()];
    if (
      entries.length !== 2 ||
      !/^[1-9]\d{0,9}$/u.test(url.searchParams.get("psid") ?? "") ||
      !/^[0-4]$/u.test(url.searchParams.get("p") ?? "") ||
      entries.some(([key]) => key !== "psid" && key !== "p")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseDisplayedDate(value: string | null) {
  const match = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (!match) return null;
  const [, month, day, year] = match;
  const compact = `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
  return isCompactDate(compact)
    ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
    : null;
}

function isCompactDate(value: string) {
  if (!/^\d{8}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function parseLocalTime(value: string) {
  const match = value.replace(/\s+/gu, " ").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/iu);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return `${String((hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${match[2]}`;
}

function parsePlayerRange(value: string) {
  const text = value.replace(/\s+/gu, " ").trim();
  const range = text.match(/^(\d)\s+(?:to|or)\s+(\d)\s+players?$/iu);
  const single = text.match(/^(\d)\s+players?$/iu);
  const min = Number(range?.[1] ?? single?.[1]);
  const max = Number(range?.[2] ?? single?.[1]);
  return min >= 1 && max <= 4 && min <= max ? { min, max } : null;
}

function parsePriceCents(value: string) {
  const match = value.match(/\$\s*(\d{1,5})(?:\.(\d{2}))?\b/u);
  return match ? Number(match[1]) * 100 + Number(match[2] ?? "0") : null;
}

function findElements(node: HtmlNode, tagName: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  if ("tagName" in node && node.tagName === tagName) found.push(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) found.push(...findElements(child, tagName));
  }
  return found;
}

function children(node: HtmlElement, tagName: string) {
  return node.childNodes.filter(
    (child): child is HtmlElement => "tagName" in child && child.tagName === tagName
  );
}

function attribute(element: HtmlElement, name: string) {
  return element.attrs.find((entry) => entry.name === name)?.value ?? null;
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(textContent).join(" ") : "";
}

function visibleText(node: HtmlNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if ("tagName" in node && ["script", "style", "noscript", "template"].includes(node.tagName)) {
    return "";
  }
  return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : "";
}

async function readBoundedHtml(response: Response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) {
    throw schemaError("Quick18 tee sheet exceeded the response limit");
  }
  if (!response.body) throw schemaError("Quick18 tee sheet body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        await reader.cancel();
        throw schemaError("Quick18 tee sheet exceeded the response limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function schemaError(message: string) {
  return Object.assign(new Error(message), { failureClass: "SCHEMA" as const });
}
