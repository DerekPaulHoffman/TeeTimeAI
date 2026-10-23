import { createHash } from "node:crypto";
import { isSafePublicAvailabilityReadUrl } from "./public-availability-read-url";
import { isPublicRentalLabel } from "./public-rental-label";

export type BrowserJsonResponseRows = {
  path: string; dateKey: "REQUESTED_DATE"; rowsPath: string;
  typePath: string; excludeType: "request"; availableTypes: string[]; accessIdPath: string;
  labelPath: string; startsAtPath: string; durationMinutesPath: string;
} & ({ expectedRentalLabel: string; expectedRentalLabels?: never } | { expectedRentalLabel?: never; expectedRentalLabels: string[] });
type Input = { date: string; players: number; durationMinutes?: number; startTime: string; endTime: string };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function field(value: unknown, path: string): unknown {
  if (path.length > 240 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path)) throw new Error("BROWSER_JSON_INVALID_PATH");
  const keys = path.split(".");
  if (keys.some(key => ["__proto__", "prototype", "constructor"].includes(key) || /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|contact|card|customer|user|person|attendee|member|profile|account|notes?|payment/iu.test(key))) throw new Error("BROWSER_JSON_INVALID_PATH");
  for (const key of keys) {
    if (!object(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function coversRequestedWindow(url: URL, input: Input) {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const center = minutes(url.searchParams.get("time_slot")!), radius = Number(url.searchParams.get("halo_size_interval")) * 15;
  // The pinned public client divides a minute halo by 15 for the wire and
  // compares the same halo with moment.add/subtract(..., "minutes").
  return center - radius <= minutes(input.startTime) && center + radius >= minutes(input.endTime);
}

/** This is the published public range role only. It grants no URL, credential,
 * transport or transaction permission; callers still apply every normal fence. */
export function browserJsonParticipantRequestMatches(request: { url: string; method: string }, bookingUrl: string,
  input: Input, strictUrl: (value: string) => boolean) {
  if (!isSafePublicAvailabilityReadUrl(request.url, "fetch", request.method, strictUrl)) return false;
  try {
    const entry = new URL(bookingUrl), url = new URL(request.url);
    const venue = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(entry.pathname)?.[1];
    if (entry.origin !== "https://www.sevenrooms.com" || !venue || entry.username || entry.password || entry.port || entry.hash ||
        url.searchParams.get("venue") !== venue || !Number.isInteger(input.players) || input.players < 1 || input.players > 4 ||
        !Number.isInteger(input.durationMinutes) || input.durationMinutes! < 15 || input.durationMinutes! > 480 ||
        url.searchParams.get("party_size") !== String(input.players) || url.searchParams.get("picked_duration") !== String(input.durationMinutes) ||
        url.searchParams.get("start_date") !== `${input.date.slice(5, 7)}-${input.date.slice(8)}-${input.date.slice(0, 4)}` ||
        url.searchParams.get("num_days") !== "1") return false;
    return coversRequestedWindow(url, input);
  } catch { return false; }
}

/** The public client chooses its clock center dynamically. Only that scalar may
 * differ from the saved primary fence, and both halos must cover the full input.
 * All other original URL bytes remain exact; this is not request admission. */
export function browserJsonPrimaryRequestMatches(request: { url: string; method: string }, primary: { url: string; method: string },
  bookingUrl: string, input: Input, strictUrl: (value: string) => boolean) {
  if (!browserJsonParticipantRequestMatches(request, bookingUrl, input, strictUrl) ||
      !browserJsonParticipantRequestMatches(primary, bookingUrl, input, strictUrl)) return false;
  const withoutCenter = (url: string) => url.replace(/([?&]time_slot=)\d{2}:\d{2}(?=&|$)/u, "$1PUBLIC_CLOCK");
  return withoutCenter(request.url) === withoutCenter(primary.url);
}

/** A finite observed calendar-prefetch shape, not a provider range limit or
 * inventory proof. Callers still admit/account for the request normally. */
export function browserJsonAncillaryCalendarRequestMatches(request: { url: string; method: string; resourceType?: string },
  primary: { url: string; method: string }, bookingUrl: string, input: Input, strictUrl: (value: string) => boolean) {
  if (!browserJsonParticipantRequestMatches(primary, bookingUrl, input, strictUrl) ||
      !["xhr", "fetch"].includes(request.resourceType ?? "") ||
      !isSafePublicAvailabilityReadUrl(request.url, request.resourceType!, request.method, strictUrl)) return false;
  try {
    const candidate = new URL(request.url), planned = new URL(primary.url);
    if (candidate.origin !== planned.origin || candidate.pathname !== planned.pathname || candidate.searchParams.get("num_days") !== "3") return false;
    const pairs = (url: URL) => [...url.searchParams.entries()].filter(([key]) => !["start_date", "num_days", "time_slot"].includes(key))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    if (JSON.stringify(pairs(candidate)) !== JSON.stringify(pairs(planned))) return false;
    const day = (value: string) => {
      const [month, date, year] = value.split("-").map(Number);
      return Date.UTC(year, month - 1, date);
    };
    // Strict URL validation above already proves both real calendar dates.
    // These eight offsets were observed across a month boundary; no claim is
    // made about a universal client loop or provider maximum.
    const offset = (day(candidate.searchParams.get("start_date")!) - day(planned.searchParams.get("start_date")!)) / 86_400_000;
    // The published range caller passes its searchDateCursor moment to the
    // same builder. Its original clock may differ, but its unchanged halo must
    // independently cover the full input; the calendar response proves no rows.
    return [1, 4, 7, 10, 13, 16, 19, 22].includes(offset) && coversRequestedWindow(candidate, input);
  } catch { return false; }
}

/** Full original response interpretation, never the model's sampled schema.
 * Only the requested own date key and one group/child-array level are read. */
export function extractBrowserJsonRows(body: unknown, plan: BrowserJsonResponseRows, input: Input) {
  const single = Object.hasOwn(plan, "expectedRentalLabel"), multiple = Object.hasOwn(plan, "expectedRentalLabels");
  const labels: unknown = single && !multiple ? [plan.expectedRentalLabel] : multiple && !single ? plan.expectedRentalLabels : undefined;
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > 8 ||
      labels.some(label => typeof label !== "string" || label.trim() !== label || label.length < 2 || label.length > 200 || !isPublicRentalLabel(label)) ||
      new Set(labels).size !== labels.length) throw new Error("BROWSER_JSON_INVALID_RENTAL_LABELS");
  const dates = field(body, plan.path);
  if (!object(dates) || !Object.prototype.hasOwnProperty.call(dates, input.date)) throw new Error("BROWSER_JSON_DATE_MISSING");
  const groups = dates[input.date];
  if (!Array.isArray(groups) || groups.length > 500) throw new Error("BROWSER_JSON_INCOMPLETE_COLLECTION");
  const rows: Array<Record<string, unknown>> = [];
  let visited = groups.length;
  for (const group of groups) {
    if (!object(group)) throw new Error("BROWSER_JSON_INCOMPLETE_COLLECTION");
    const children = field(group, plan.rowsPath);
    if (!Array.isArray(children) || (visited += children.length) > 500) throw new Error("BROWSER_JSON_INCOMPLETE_COLLECTION");
    for (const child of children) {
      if (!object(child)) throw new Error("BROWSER_JSON_MALFORMED_ROW");
      const type = field(child, plan.typePath);
      if (typeof type !== "string" || !/^[A-Za-z][A-Za-z_-]{0,31}$/u.test(type)) throw new Error("BROWSER_JSON_MALFORMED_ROW");
      // The public client keeps request-only times separately. Their flags do
      // not make them instantly available rentals, so no request row is emitted.
      if (type === plan.excludeType) continue;
      if (!plan.availableTypes.includes(type)) throw new Error("BROWSER_JSON_UNKNOWN_ROW_TYPE");
      const identity = field(child, plan.accessIdPath), label = field(child, plan.labelPath);
      const startsAt = field(child, plan.startsAtPath), duration = field(child, plan.durationMinutesPath);
      if (typeof identity !== "string" || !identity || identity.length > 256 || identity.trim() !== identity || /\p{Cc}/u.test(identity) ||
          typeof label !== "string" || !labels.includes(label) ||
          typeof startsAt !== "string" || !startsAt || startsAt.length > 100 ||
          !Number.isInteger(duration) || Number(duration) < 15 || Number(duration) > 480 || duration !== input.durationMinutes)
        throw new Error("BROWSER_JSON_MALFORMED_ROW");
      rows.push({ startsAt, resourceId: `public-json:${createHash("sha256").update(identity).digest("hex")}` });
    }
  }
  // An empty map or request-only response cannot independently attest rental
  // identity or duration. Never fill those missing facts from the saved input.
  return { date: input.date, complete: true, empty: false, players: input.players,
    duration: rows.length ? input.durationMinutes : undefined, rows };
}
