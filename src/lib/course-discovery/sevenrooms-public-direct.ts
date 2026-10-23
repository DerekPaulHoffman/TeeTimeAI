import { browserJsonParticipantRequestMatches, extractBrowserJsonRows, type BrowserJsonResponseRows } from "./browser-json-response";
import { isPublicRentalLabel } from "./public-rental-label";
import { verifySevenRoomsPublicIdentity } from "./sevenrooms-public-identity";
import type { AccessExecutionInput } from "./recipe";

type Source = { bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export type SevenRoomsPublicJsonRead = (url: string) => Promise<{ body: unknown; status: number }>;
type VenueMatches = (expected: string, actual: unknown) => boolean;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key) ? value[key] : undefined;
// This new protocol exposes only public resource labels. Keep the legacy
// predicate unchanged while refusing private-shaped text before projection.
function observableRentalLabel(value: string) {
  return value === value.trim() && value.length >= 2 && value.length <= 200 && isPublicRentalLabel(value) &&
    /^[\p{L}\p{N} '&().,/-]+$/u.test(value) &&
    !/@|https?:|\b(?:account|login|password|secret|token|email|phone|contact|customer|payment|card|credit|billing|birth|dob|member|checkout)\b|(?:\+?\d[\d ()-]{7,}\d)|\b[A-Za-z0-9_-]{24,}\b/iu.test(value);
}

/** Fixed public protocol, never a URL/body/header program supplied by a model. */
export function sevenRoomsPublicRequests(bookingUrl: string) {
  const entry = new URL(bookingUrl);
  const tenant = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(entry.pathname)?.[1];
  if (entry.origin !== "https://www.sevenrooms.com" || !tenant || tenant.length > 128 || entry.username || entry.password || entry.port || entry.hash ||
      !bookingUrl.startsWith(`https://www.sevenrooms.com/reservations/${tenant}`) || new URL(bookingUrl).href !== bookingUrl)
    throw new Error("SEVENROOMS_INVALID_PUBLIC_SOURCE");
  return {
    metadataUrl: `https://www.sevenrooms.com/api-yoa/dining/venue_info?venue_url_key=${tenant}&widget_type=RESERVATIONS&modify_upgrades=false`,
    rangeTemplate: `https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=${tenant}&time_slot=12:00&party_size={{players}}&halo_size_interval=64&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration={{durationMinutes}}`,
    permittedRoutes: [
      { origin: entry.origin, path: "/api-yoa/dining/venue_info", methods: ["GET" as const], queryKeys: ["venue_url_key", "widget_type", "modify_upgrades"] },
      { origin: entry.origin, path: "/api-yoa/availability/widget/range", methods: ["GET" as const], queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "selected_lang_code", "picked_duration"] },
    ],
  };
}

export function sevenRoomsPublicRangeUrl(bookingUrl: string, input: AccessExecutionInput, strictUrl: (url: string) => boolean) {
  const { rangeTemplate } = sevenRoomsPublicRequests(bookingUrl);
  const url = rangeTemplate.replace("{{players}}", String(input.players)).replace("{{durationMinutes}}", String(input.durationMinutes))
    .replace("{{dateMdy}}", `${input.date.slice(5, 7)}-${input.date.slice(8)}-${input.date.slice(0, 4)}`);
  if (!browserJsonParticipantRequestMatches({ url, method: "GET" }, bookingUrl, input, strictUrl)) throw new Error("SEVENROOMS_INPUT_UNVERIFIED");
  return url;
}

export function sevenRoomsPublicRows(expectedRentalLabels: string[]): BrowserJsonResponseRows {
  if (expectedRentalLabels.length < 1 || expectedRentalLabels.length > 8 || new Set(expectedRentalLabels).size !== expectedRentalLabels.length ||
      expectedRentalLabels.some(value => !observableRentalLabel(value)))
    throw new Error("SEVENROOMS_RENTAL_LABELS_UNVERIFIED");
  return { path: "data.availability", dateKey: "REQUESTED_DATE", rowsPath: "times", typePath: "type", excludeType: "request", availableTypes: ["book"],
    accessIdPath: "access_persistent_id", labelPath: "public_time_slot_description", expectedRentalLabels,
    startsAtPath: "time_iso", durationMinutesPath: "duration" };
}

/** Inspect the full requested-date collection before constructing a saved plan.
 * The unchanged interpreter subsequently validates every original book row. */
function observedRentalLabels(body: unknown, input: AccessExecutionInput) {
  const data = object(body) ? own(body, "data") : undefined;
  const availability = object(data) ? own(data, "availability") : undefined;
  const groups = object(availability) ? own(availability, input.date) : undefined;
  if (!Array.isArray(groups) || groups.length > 500) throw new Error("BROWSER_JSON_INCOMPLETE_COLLECTION");
  const labels = new Set<string>();
  let visited = groups.length;
  for (const group of groups) {
    const times = object(group) ? own(group, "times") : undefined;
    if (!Array.isArray(times) || (visited += times.length) > 500) throw new Error("BROWSER_JSON_INCOMPLETE_COLLECTION");
    for (const row of times) {
      if (!object(row)) throw new Error("BROWSER_JSON_MALFORMED_ROW");
      if (own(row, "type") === "request") continue;
      const label = own(row, "public_time_slot_description");
      if (own(row, "type") !== "book" || typeof label !== "string" || !observableRentalLabel(label))
        throw new Error("BROWSER_JSON_MALFORMED_ROW");
      labels.add(label);
      if (labels.size > 8) throw new Error("SEVENROOMS_RENTAL_LABELS_UNVERIFIED");
    }
  }
  return [...labels].sort();
}

export async function inspectSevenRoomsPublicProtocol(source: Source, input: AccessExecutionInput, readJson: SevenRoomsPublicJsonRead,
  venueMatches: VenueMatches, strictUrl: (url: string) => boolean) {
  const requests = sevenRoomsPublicRequests(source.bookingUrl);
  const rangeUrl = sevenRoomsPublicRangeUrl(source.bookingUrl, input, strictUrl);
  const metadata = await readJson(requests.metadataUrl);
  const identity = verifySevenRoomsPublicIdentity(metadata.body, source, { url: requests.metadataUrl, method: "GET", status: metadata.status }, venueMatches);
  const availability = await readJson(rangeUrl);
  if (availability.status !== 200 || !object(availability.body) || own(availability.body, "status") !== 200)
    throw new Error("SEVENROOMS_AVAILABILITY_UNVERIFIED");
  const responseRows = sevenRoomsPublicRows(observedRentalLabels(availability.body, input));
  const extracted = extractBrowserJsonRows(availability.body, responseRows, input);
  if (!extracted.rows.length || extracted.duration !== input.durationMinutes) throw new Error("SEVENROOMS_RENTAL_IDENTITY_UNVERIFIED");
  return { request: { url: requests.rangeTemplate, method: "GET" as const }, metadataRequest: { url: requests.metadataUrl }, responseRows,
    proof: { venue: { publicVenueMetadata: true as const }, date: { availabilityDateKey: true as const }, complete: { availabilityResponse: true as const } },
    permittedRoutes: requests.permittedRoutes, identity,
    observation: { completeRequestedDate: true, requestedDate: input.date, availableRentalRows: extracted.rows.length,
      observedRentalLabels: responseRows.expectedRentalLabels, durationMinutes: extracted.duration, publicRequests: 2 } };
}
