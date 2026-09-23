import type { TeeTimeSlot } from "@/lib/tee-times/matching";
import type { BookingWindowEvidence } from "@/lib/courses/booking-window";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const API_ORIGIN = "https://xq8v7un6ad.execute-api.us-east-1.amazonaws.com";
const API_ROOT = `${API_ORIGIN}/prod`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type GolfGeekMetadata = {
  provider: "GOLF_GEEK";
  courseId: string;
  bookingBaseUrl: string;
  officialWebsite: string;
  bookingWindowDaysAhead?: number;
};

function safeOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

export function isGolfGeekMetadata(value: unknown): value is GolfGeekMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<GolfGeekMetadata>;
  if (metadata.provider !== "GOLF_GEEK" || typeof metadata.courseId !== "string" ||
      !UUID.test(metadata.courseId) || typeof metadata.bookingBaseUrl !== "string" ||
      typeof metadata.officialWebsite !== "string") return false;
  const booking = safeOrigin(metadata.bookingBaseUrl);
  const official = safeOrigin(metadata.officialWebsite);
  if (!booking || !official ||
      booking.hostname !== `booking.${official.hostname.replace(/^www\./u, "")}`) return false;
  return metadata.bookingWindowDaysAhead === undefined ||
    (Number.isInteger(metadata.bookingWindowDaysAhead) &&
      metadata.bookingWindowDaysAhead >= 0 && metadata.bookingWindowDaysAhead <= 365);
}

export function golfGeekCourseUrl(courseId: string) {
  return `${API_ROOT}/courses/${courseId}`;
}

export function golfGeekTeeTimesUrl(courseId: string, date: string) {
  return `${API_ROOT}/course/${courseId}/tee-times?cached=false&date=${date}`;
}

export function parseGolfGeekCourse(value: unknown): {
  id: string; name: string; city: string; state: string;
  website: string; subdomain: string; bookingAllowedDays?: number;
} | null {
  const data = (value as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string" || !UUID.test(row.id) ||
      typeof row.name !== "string" || !row.name.trim() ||
      typeof row.city !== "string" || !row.city.trim() ||
      typeof row.state !== "string" || !/^[A-Z]{2}$/u.test(row.state) ||
      typeof row.website !== "string" || typeof row.subdomain !== "string") return null;
  let website: URL | null;
  let subdomain: URL | null;
  try {
    website = safeOrigin(new URL("/", row.website).toString());
    subdomain = safeOrigin(new URL("/", row.subdomain).toString());
  } catch {
    return null;
  }
  if (!website || !subdomain ||
      subdomain.hostname !== `booking.${website.hostname.replace(/^www\./u, "")}`) return null;
  return {
    id: row.id, name: row.name, city: row.city, state: row.state,
    website: website.toString(), subdomain: subdomain.toString(),
    ...(typeof row.bookingAllowedDays === "number" && Number.isInteger(row.bookingAllowedDays) &&
      row.bookingAllowedDays >= 0 && row.bookingAllowedDays <= 365
      ? { bookingAllowedDays: row.bookingAllowedDays } : {})
  };
}

export async function fetchGolfGeekTeeSheet(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: GolfGeekMetadata;
  discoverBookingWindow?: boolean;
}): Promise<{ slots: TeeTimeSlot[]; targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null }> {
  if (!isGolfGeekMetadata(input.metadata)) throw new Error("Invalid Golf Geek course metadata");
  const date = input.date.toISOString().slice(0, 10);
  const url = golfGeekTeeTimesUrl(input.metadata.courseId, date);
  const response = await fetchWithProviderTimeout(url, {
    redirect: "error", credentials: "omit", headers: { accept: "application/json" }
  });
  if (!response.ok) throw providerHttpError("Golf Geek tee times", response);
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (!Array.isArray(data) || data.length > 500) {
    return { slots: [], targetDateStatus: "UNKNOWN", bookingWindowEvidence: null };
  }
  const slots: TeeTimeSlot[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || !UUID.test(item.id ?? "") ||
        item.date !== date || typeof item.startTime !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(item.startTime) ||
        !Number.isInteger(item.freeSlots) || item.freeSlots < input.players ||
        !Array.isArray(item.allowedSlots) || !item.allowedSlots.includes(input.players) ||
        !Array.isArray(item.rates)) continue;
    const publicRate = item.rates.find((rate: unknown) => {
      const row = rate as Record<string, unknown> | null;
      return row?.name === "Public" && typeof row.id === "string" && UUID.test(row.id) &&
        typeof row.price === "number" && Number.isFinite(row.price) && row.price >= 0;
    });
    if (!publicRate) continue;
    slots.push({
      courseId: input.courseId,
      sourceId: `golf-geek-${item.id}`,
      startsAt: `${date}T${item.startTime}`,
      availableSpots: item.freeSlots,
      bookingUrl: `${input.metadata.bookingBaseUrl}booking/${date}/${item.startTime}/${publicRate.id}/details/`,
      priceCents: Math.round(publicRate.price * 100),
      evidenceUrl: url
    });
  }
  const bookingWindowEvidence: BookingWindowEvidence | null =
    input.discoverBookingWindow && input.metadata.bookingWindowDaysAhead !== undefined
      ? { daysAhead: input.metadata.bookingWindowDaysAhead, releaseTimeLocal: null,
          source: "PROVIDER_CONFIG", confidence: 1,
          evidenceUrl: golfGeekCourseUrl(input.metadata.courseId) }
      : null;
  return { slots, targetDateStatus: "OPEN", bookingWindowEvidence };
}
