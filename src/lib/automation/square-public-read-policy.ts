import { z } from "zod";
import { zonedDateTimeToDate } from "@/lib/timezones";

const publicId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const timestamp = z.string().datetime({ offset: true });
const requestSchema = z.object({ search_availability_request: z.object({ query: z.object({ filter: z.object({
  location_id: z.string().regex(/^[A-Z0-9]{13}$/u),
  start_at_range: z.object({ start_at: timestamp, end_at: timestamp }).strict(),
  segment_filters: z.array(z.object({ service_variation_id: z.string().regex(/^[A-Z0-9]{16,32}$/u),
    team_member_id_filter: z.object({ any: z.array(publicId).min(1).max(16).refine(ids => new Set(ids).size === ids.length) }).strict(),
  }).strict()).length(1),
}).strict() }).strict() }).strict() }).strict();

/** This namespace cannot fall through to generic GraphQL-shaped permission. */
export function isSquareAppointmentsNamespace(url: URL) {
  if (!["app.squareup.com", "book.squareup.com"].includes(url.hostname)) return false;
  try { return /^\/+appointments(?:\/|$)/u.test(decodeURIComponent(url.pathname)); }
  catch { return true; }
}

function publicSquareQuery(url: URL, allowService: boolean) {
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 ||
        !((key === "color" || key === "buttonTextColor") && /^[a-fA-F0-9]{6}$/u.test(value) ||
          key === "locale" && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(value) ||
          key === "referrer" && /^[a-z]{1,16}$/u.test(value) ||
          allowService && key === "service_id" && /^[A-Z0-9]{16,32}$/u.test(value))) return false;
  }
  return true;
}

function visibleLocation(source: string | undefined) {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.origin !== "https://book.squareup.com" || url.username || url.password || url.hash) return null;
    const match = /^\/appointments\/[a-z0-9]{1,64}\/location\/([A-Z0-9]{13})(?:\/(?:services(?:\/[A-Z0-9]{16,32})?|availability))?$/u.exec(url.pathname);
    if (!match) return null;
    if (!publicSquareQuery(url, true)) return null;
    return match[1];
  } catch { return null; }
}

/** Exact undated public catalog or its legacy app-host gateway; presentation
 * fields only. This never widens the availability POST's source authority.
 * The caller must separately own a fresh native calendar-entry gesture. */
export function isSquarePublicServiceCatalogUrl(value: string) {
  if (value.length > 2048 || !/^https:\/\/(?:book\.squareup\.com\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/services|app\.squareup\.com\/appointments\/book\/[A-Z0-9]{13}\/start)(?:\?[^#]*)?$/u.test(value)) return false;
  const url = new URL(value);
  return url.href === value && publicSquareQuery(url, false);
}

/** Anonymous inventory only. A caller must supply its current guarded document
 * or the independently bound recipe entry; this does not grant navigation,
 * credential headers, slot selection, customer details or booking permission. */
export function isSquarePublicAvailabilityPost(url: URL, headers: Headers, body: string, sourceDocumentUrl?: string) {
  if (url.href !== "https://app.squareup.com/appointments/api/buyer/availability" ||
      !/^(?:application\/json)(?:\s*;|$)/iu.test(headers.get("content-type") ?? "") ||
      ["authorization", "cookie", "x-api-key", "next-action"].some(key => headers.has(key)) || Buffer.byteLength(body) > 32_768) return false;
  const location = visibleLocation(sourceDocumentUrl);
  if (!location) return false;
  try {
    const parsed = requestSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return false;
    const filter = parsed.data.search_availability_request.query.filter;
    const range = Date.parse(filter.start_at_range.end_at) - Date.parse(filter.start_at_range.start_at);
    // The public month picker requests its remaining month plus adjacent days.
    return filter.location_id === location && range > 0 && range <= 40 * 86_400_000;
  } catch { return false; }
}

/** Date evidence only, after the separate request-authority gate. The public
 * month response must cover the entire requested venue-local calendar day. */
export function squarePublicAvailabilityCoversDate(request: { url: string; method: string; body?: string | null },
  sourceDocumentUrl: string, input: { date: string; timeZone: string }) {
  try {
    if (request.method !== "POST" || typeof request.body !== "string" ||
        !isSquarePublicAvailabilityPost(new URL(request.url), new Headers({ "content-type": "application/json" }), request.body, sourceDocumentUrl)) return false;
    const filter = requestSchema.parse(JSON.parse(request.body)).search_availability_request.query.filter;
    if (!/^20\d{2}-\d{2}-\d{2}$/u.test(input.date)) return false;
    const next = new Date(`${input.date}T12:00:00.000Z`);
    if (next.toISOString().slice(0, 10) !== input.date) return false;
    next.setUTCDate(next.getUTCDate() + 1);
    const start = zonedDateTimeToDate(`${input.date}T00:00:00`, input.timeZone).getTime();
    const end = zonedDateTimeToDate(`${next.toISOString().slice(0, 10)}T00:00:00`, input.timeZone).getTime() - 1;
    return Date.parse(filter.start_at_range.start_at) <= start && Date.parse(filter.start_at_range.end_at) >= end;
  } catch { return false; }
}
