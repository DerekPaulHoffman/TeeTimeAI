import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const WEBTRAC_SEARCH_PATH = "/navyeast/webtrac/web/search.html";

export type WebTracMetadata = {
  provider: "WEBTRAC";
  bookingBaseUrl: string;
  courseCode: string;
  bookingWindowDaysAhead?: number;
  bookingWindowEvidenceUrl?: string;
};

export type WebTracTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function isWebTracMetadata(value: unknown): value is WebTracMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<WebTracMetadata>;
  if (
    metadata.provider !== "WEBTRAC" ||
    typeof metadata.bookingBaseUrl !== "string" ||
    typeof metadata.courseCode !== "string" ||
    !/^[a-z0-9_-]{1,24}$/i.test(metadata.courseCode) ||
    (metadata.bookingWindowDaysAhead !== undefined &&
      (!Number.isInteger(metadata.bookingWindowDaysAhead) ||
        metadata.bookingWindowDaysAhead < 0 ||
        metadata.bookingWindowDaysAhead > 31))
  ) {
    return false;
  }

  try {
    const url = new URL(metadata.bookingBaseUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "navyaims.com" || url.hostname.endsWith(".navyaims.com")) &&
      url.pathname.toLowerCase() === WEBTRAC_SEARCH_PATH &&
      url.searchParams.get("module")?.toUpperCase() === "GR" &&
      url.searchParams.get("secondarycode") === metadata.courseCode
    );
  } catch {
    return false;
  }
}

export async function fetchWebTracTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: WebTracMetadata;
    discoverBookingWindow?: boolean;
  },
  fetchImpl: typeof fetch = fetch
): Promise<WebTracTeeSheetResult> {
  const url = buildSearchUrl(input.metadata, input.date, input.players);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
    },
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(`WebTrac tee times returned ${response.status}`);
  }

  const html = await response.text();
  const slots = parseWebTracSlots(html, input, url);
  const bookingWindowEvidence =
    input.discoverBookingWindow && input.metadata.bookingWindowDaysAhead !== undefined
      ? {
          daysAhead: input.metadata.bookingWindowDaysAhead,
          releaseTimeLocal: null,
          source: "OFFICIAL_BOOKING_PAGE" as const,
          confidence: 0.9,
          evidenceUrl:
            input.metadata.bookingWindowEvidenceUrl ?? input.metadata.bookingBaseUrl
        }
      : null;

  return {
    slots,
    targetDateStatus: /Tee Time Search Results/i.test(html) ? "OPEN" : "UNKNOWN",
    bookingWindowEvidence
  };
}

function buildSearchUrl(metadata: WebTracMetadata, date: Date, players: number) {
  const url = new URL(metadata.bookingBaseUrl);
  const targetDate = date.toISOString().slice(0, 10);
  const [year, month, day] = targetDate.split("-");
  url.searchParams.set("Action", "Start");
  url.searchParams.set("begindate", `${month}/${day}/${year}`);
  url.searchParams.set("begintime", "07:00 am");
  url.searchParams.set("display", "Detail");
  url.searchParams.set("grwebsearch_buttonsearch", "yes");
  url.searchParams.set("module", "GR");
  url.searchParams.set("numberofplayers", String(Math.max(1, Math.min(5, players))));
  url.searchParams.set("page", "1");
  url.searchParams.set("search", "yes");
  url.searchParams.set("secondarycode", metadata.courseCode);
  return url.toString();
}

function parseWebTracSlots(
  html: string,
  input: { courseId: string; players: number; metadata: WebTracMetadata },
  evidenceUrl: string
) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(
    (row): TeeTimeSlot[] => {
      const rowHtml = row[1];
      const providerId = /GRFMIDList=(\d+)/i.exec(rowHtml)?.[1];
      const time = cellText(rowHtml, "Time");
      const date = cellText(rowHtml, "Date");
      const openSlots = Number.parseInt(cellText(rowHtml, "Open Slots"), 10);
      const holesText = cellText(rowHtml, "Holes");
      const startsAt = parseLocalDateTime(date, time);
      const holes = /\b9\b/.test(holesText) ? 9 : /\b18\b/.test(holesText) ? 18 : undefined;
      if (!providerId || !startsAt || !Number.isFinite(openSlots) || openSlots < input.players) {
        return [];
      }
      return [{
        sourceId: `webtrac-${input.metadata.courseCode}-${providerId}`,
        courseId: input.courseId,
        startsAt,
        availableSpots: openSlots,
        bookingUrl: input.metadata.bookingBaseUrl,
        holes,
        bookableHoleCounts: holes ? [holes] : [],
        evidenceUrl
      }];
    }
  );
}

function cellText(rowHtml: string, title: string) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<td\\b[^>]*data-title=["']${escapedTitle}["'][^>]*>([\\s\\S]*?)<\\/td>`,
    "i"
  ).exec(rowHtml);
  return decodeHtml(match?.[1]?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
}

function parseLocalDateTime(date: string, time: string) {
  const dateMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  const timeMatch = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(time);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  let hour = Number(timeMatch[1]) % 12;
  if (timeMatch[3].toLowerCase() === "pm") {
    hour += 12;
  }
  return `${dateMatch[3]}-${dateMatch[1].padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}T${String(hour).padStart(2, "0")}:${timeMatch[2]}`;
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
