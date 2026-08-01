import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const SUPREME_GOLF_HOST = "sgnavigator.app";
const SUPREME_GOLF_BOOKING_PATH =
  /^\/portal\/([a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?)\/book(?:\/([1-9]\d{0,9}))?\/?$/i;
const MAX_HTML_BYTES = 512 * 1024;

export type SupremeGolfMetadata = {
  provider: "SUPREME_GOLF";
  bookingBaseUrl: string;
};

export type SupremeGolfTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "UNKNOWN";
  bookingWindowEvidence: null;
};

export function isSupremeGolfMetadata(value: unknown): value is SupremeGolfMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<SupremeGolfMetadata>;
  if (
    metadata.provider !== "SUPREME_GOLF" ||
    typeof metadata.bookingBaseUrl !== "string"
  ) {
    return false;
  }
  try {
    const url = new URL(metadata.bookingBaseUrl);
    return Boolean(
      url.protocol === "https:" &&
      url.hostname === SUPREME_GOLF_HOST &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      SUPREME_GOLF_BOOKING_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function fetchSupremeGolfTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: SupremeGolfMetadata;
  },
  fetchImpl: typeof fetch = fetch
): Promise<SupremeGolfTeeSheetResult> {
  const metadataUrl = new URL(input.metadata.bookingBaseUrl);
  const metadataMatch = SUPREME_GOLF_BOOKING_PATH.exec(metadataUrl.pathname);
  if (!metadataMatch) {
    throw new Error("Supreme Golf metadata did not include a valid booking route");
  }

  let routeId: string | null = metadataMatch[2] ?? null;
  if (!routeId) {
    const landingHtml = await fetchHtml(metadataUrl, "Supreme Golf booking page", fetchImpl);
    routeId = findCourseRouteId(landingHtml, metadataMatch[1]);
  }
  if (!routeId) {
    throw new Error("Supreme Golf booking page did not include a public course route");
  }

  const targetDate = input.date.toISOString().slice(0, 10);
  const datedUrl = new URL(
    `/portal/${metadataMatch[1]}/book/${routeId}`,
    metadataUrl.origin
  );
  const resolvedBookingUrl = datedUrl.toString();
  datedUrl.searchParams.set("day", targetDate);
  const html = await fetchHtml(datedUrl, "Supreme Golf tee times", fetchImpl);
  const slots = parseSlots(html, {
    courseId: input.courseId,
    players: input.players,
    routeId,
    targetDate,
    bookingUrl: resolvedBookingUrl,
    evidenceUrl: datedUrl.toString()
  });

  return {
    slots,
    targetDateStatus: /data-testid=["']portal-book-grid["']/i.test(html)
      ? "OPEN"
      : "UNKNOWN",
    bookingWindowEvidence: null
  };
}

async function fetchHtml(
  url: URL,
  label: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchWithProviderTimeout(
    url,
    {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
      },
      redirect: "error"
    },
    fetchImpl
  );
  if (!response.ok) {
    throw providerHttpError(label, response);
  }
  const html = await response.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new Error(`${label} exceeded the response size limit`);
  }
  return html;
}

function findCourseRouteId(html: string, slug: string) {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routeId = new RegExp(
    `(?:\\\\u002F|/)portal(?:\\\\u002F|/)${escapedSlug}(?:\\\\u002F|/)book(?:\\\\u002F|/)([1-9]\\d{0,9})(?=[?\"'\\\\]|<)`,
    "i"
  ).exec(html)?.[1];
  return routeId && Number(routeId) <= 2_147_483_647 ? routeId : null;
}

function parseSlots(
  html: string,
  input: {
    courseId: string;
    players: number;
    routeId: string;
    targetDate: string;
    bookingUrl: string;
    evidenceUrl: string;
  }
) {
  return [
    ...html.matchAll(
      /<button\b[^>]*data-testid=["']portal-book-tee-time-card-(\d{2}):(\d{2})["'][^>]*>([\s\S]*?)<\/button>/gi
    )
  ].flatMap((match): TeeTimeSlot[] => {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const playerRange = /\b(\d+)\s*-\s*(\d+)\s+players?\b/i.exec(
      stripHtml(match[3])
    );
    const maximumPlayers = Number(playerRange?.[2]);
    if (
      hour > 23 ||
      minute > 59 ||
      !Number.isInteger(maximumPlayers) ||
      maximumPlayers < input.players
    ) {
      return [];
    }
    const price = /\$\s*(\d{1,4})(?:\.(\d{2}))?/.exec(stripHtml(match[3]));
    return [{
      sourceId: `supreme-golf-${input.routeId}-${match[1]}${match[2]}`,
      courseId: input.courseId,
      startsAt: `${input.targetDate}T${match[1]}:${match[2]}`,
      availableSpots: maximumPlayers,
      bookingUrl: input.bookingUrl,
      ...(price
        ? { priceCents: Number(price[1]) * 100 + Number(price[2] ?? "0") }
        : {}),
      bookableHoleCounts: [],
      evidenceUrl: input.evidenceUrl
    }];
  });
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
