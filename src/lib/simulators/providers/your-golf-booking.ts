import { parse, type DefaultTreeAdapterMap } from "parse5";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { zonedDateTimeToDate } from "@/lib/timezones";

import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult, type SimulatorAvailabilitySlot } from "./types";

const BOOKING_ORIGIN = "https://booking.trackmangolf.com";
const API_ORIGIN = "https://api.yourgolfbooking.com";
const ID = /^[1-9]\d{0,9}$/u;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
type Node = DefaultTreeAdapterMap["node"];
type Json = Record<string, unknown>;

function record(value: unknown): Json | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null; }
function fail(message: string): never { throw new SimulatorAvailabilityError("SCHEMA_CHANGED", message); }
function source(message: string): never { throw new SimulatorAvailabilityError("INVALID_SOURCE", message); }
function integer(value: unknown, min = 1, max = 1_000_000_000): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail("The public simulator configuration has an invalid identifier or value");
  return Number(value);
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("The public simulator configuration has an invalid list");
  return value;
}

export function isYourGolfBookingPublicBookingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === BOOKING_ORIGIN && !url.username && !url.password && !url.search && !url.hash && /^\/venues\/[a-z0-9]+(?:-[a-z0-9]+)*\/booking\/?$/u.test(url.pathname);
  } catch { return false; }
}

/** Signed-out published configuration and occupancy only. No cart or booking operation is used. */
export async function fetchYourGolfBookingAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  validateInput(input);
  const slug = new URL(input.offering.bookingUrl).pathname.split("/")[2];
  const metadata = record(input.offering.providerMetadata);
  if (!metadata || metadata.venueSlug !== slug || !ID.test(String(metadata.venueId)) || !ID.test(String(metadata.rangeId)) || !ID.test(String(metadata.publicOptionId))) source("The public simulator venue and rental identity are not verified");
  const htmlUrl = new URL(input.offering.bookingUrl);
  htmlUrl.pathname = `${htmlUrl.pathname.replace(/\/$/u, "")}/bays`;
  const html = await publicRead(htmlUrl, "text/html", 1_500_000, fetchImpl);
  const config = parsePublicConfig(html);
  const venue = record(config.venue);
  const ranges = record(config.ranges);
  const bays = record(config.bays);
  if (!venue || String(venue.id) !== String(metadata.venueId) || venue.slug !== slug || venue.timezone !== input.timeZone || venue.status !== "live" || venue.maintenanceMode !== false) source("The public simulator venue changed identity or availability state");
  const rangeItems = list(ranges?.items, 20).map(record);
  const range = rangeItems.find(item => item && String(item.id) === String(metadata.rangeId));
  if (!range || rangeItems.filter(item => item && String(item.id) === String(metadata.rangeId)).length !== 1 || range.venue !== venue.id || range.slug !== "bays" || range.bookable !== true || range.slotDuration !== 30 || range.slotInterval !== 30 || range.slotIntervalStart !== 0 || range.assumeOpen !== true || range.bookingUi !== "standard" || range.customerBookingUi !== "slots" || range.maxBookAheadValue !== 2 || range.maxBookAheadUnit !== "week" || list(range.openingTimes, 100).length !== 0) source("The public simulator range settings changed");
  const options = list(bays?.bayOptions, 100).map(record);
  const option = options.find(item => item && String(item.id) === String(metadata.publicOptionId));
  if (!option || options.filter(item => item && String(item.id) === String(metadata.publicOptionId)).length !== 1 || option.venue !== venue.id || option.name !== "Public Rate" || option.adminOnly !== false || option.disabled !== false || option.waitlisted !== false || option.type !== "simulator" || option.category !== "baytime" || option.duration !== 1 || option.durationType !== "slot" || option.bufferPeriodMinutes !== 0 || list(option.appliedRequiredPerks, 20).length !== 0 || list(option.restrictions, 20).length !== 0) source("The published simulator rental changed");
  const minimum = integer(option.minBookingDuration, 1, 8);
  const maximum = integer(option.maxBookingDuration, minimum, 8);
  const capacity = option.maxPlayers === null ? null : integer(option.maxPlayers, 1, 20);
  if (option.minPlayers !== null && option.minPlayers !== undefined) integer(option.minPlayers, 1, 20);
  if (input.durationMinutes / 30 < minimum || input.durationMinutes / 30 > maximum) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The published simulator rental does not support this session length");
  const maxPartySize = capacity === null ? input.offering.maxPartySize : Math.min(capacity, input.offering.maxPartySize ?? capacity);
  const resourceItems = list(bays?.items, 100).map(record);
  const resources = resourceItems.filter(item => item && item.range === range.id).map(item => {
    if (!item || item.venue !== venue.id || item.type !== "simulator" || item.bookable !== true || list(item.restrictedTimes, 100).length !== 0 || !list(item.options, 100).some(id => String(id) === String(option.id)) || !list(item.appliedOptions, 100).some(id => String(id) === String(option.id))) source("The public simulator bay settings changed");
    return String(integer(item.id));
  });
  if (!resources.length || resources.length > 40 || new Set(resources).size !== resources.length) source("The public simulator bay list is missing or ambiguous");
  const hours = parseHours(range.openingHours, input.date);
  const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const localToday = `${localParts.year}-${localParts.month}-${localParts.day}`;
  const requestedDay = Date.parse(`${input.date}T00:00:00Z`);
  const today = Date.parse(`${localToday}T00:00:00Z`);
  if (requestedDay < today || requestedDay > today + 14 * 86_400_000) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The requested simulator date is outside the published booking window");
  const apiUrl = new URL(`/venue/${slug}/bookings/public`, API_ORIGIN);
  const dayStart = zonedDateTimeToDate(`${input.date}T00:00:00`, input.timeZone);
  const nextDay = new Date(`${input.date}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextLocalDay = zonedDateTimeToDate(`${nextDay.toISOString().slice(0, 10)}T00:00:00`, input.timeZone);
  const offset = (date: Date, wall: string) => {
    const minutes = Math.round((Date.parse(`${input.date}T${wall}Z`) - date.getTime()) / 60_000);
    return `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  };
  // Occupancy may start the previous day. Include every interval up to the
  // same 24-hour maximum accepted by the payload parser, across DST changes.
  const occupancyStart = new Date(dayStart.getTime() - 24 * 60 * 60_000);
  apiUrl.search = new URLSearchParams({ start_gte: occupancyStart.toISOString(), start_lte: `${input.date}T23:59:59${offset(new Date(nextLocalDay.getTime() - 1000), "23:59:59")}` }).toString();
  let payload: unknown;
  try { payload = JSON.parse(await publicRead(apiUrl, "application/json", 400_000, fetchImpl)); }
  catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; fail("The public simulator bookings response is invalid JSON"); }
  const slots = buildSlots(input, resources, option.id, range.id, venue.id, maxPartySize, hours, payload);
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: apiUrl.toString() };
}

function parsePublicConfig(html: string): Json {
  const scripts: string[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node && node.tagName === "script" && node.attrs.some(attr => attr.name === "id" && attr.value === "__NEXT_DATA__")) scripts.push("childNodes" in node ? node.childNodes.map(child => "value" in child ? child.value : "").join("") : "");
    else if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html));
  if (scripts.length !== 1) fail("The public simulator configuration is missing or ambiguous");
  try { const data = record(JSON.parse(scripts[0])); const config = record(record(record(data?.props)?.pageProps)?.initialReduxState); if (config) return config; }
  catch { /* classified below */ }
  fail("The public simulator configuration is unreadable");
}

function parseHours(value: unknown, date: string): [number, number][] {
  if (typeof value !== "string" || value.length > 2_000) fail("The public simulator opening hours are invalid");
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  let weekly: [number, number][] | null = null;
  let dated: [number, number][] | null = null;
  const seen = new Set<string>();
  for (const part of value.split(";")) {
    const line = part.trim();
    const match = line.match(/^(Mo|Tu|We|Th|Fr|Sa|Su|\d{4} [A-Z][a-z]{2} \d{1,2}) (off|\d{2}:\d{2}-\d{2}:\d{2} open)$/u);
    if (!match || seen.has(match[1])) fail("The public simulator opening hours format changed");
    seen.add(match[1]);
    const intervals: [number, number][] = [];
    if (match[2] !== "off") {
      const times = match[2].match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2}) open$/u)!;
      const start = Number(times[1]) * 60 + Number(times[2]);
      const end = Number(times[3]) * 60 + Number(times[4]);
      if (start >= end || end > 1440 || start % 30 !== 0 || Number(times[2]) > 59 || Number(times[4]) > 59) fail("The public simulator opening interval is invalid");
      intervals.push([start, end]);
    }
    if (match[1] === weekday) weekly = intervals;
    if (match[1].length > 2) {
      const parsed = new Date(`${match[1]} 12:00:00 GMT`);
      if (!Number.isFinite(parsed.getTime())) fail("The public simulator dated hours are invalid");
      if (parsed.toISOString().slice(0, 10) === date) dated = intervals;
    }
  }
  if (!weekly) fail("The public simulator weekday hours are missing");
  return dated ?? weekly;
}

export function buildSlots(input: SimulatorAvailabilityInput, resources: string[], productId: unknown, rangeId: unknown, venueId: unknown, maxPartySize: number | null, hours: [number, number][], occupancy: unknown): SimulatorAvailabilitySlot[] {
  const items = list(occupancy, 1_000).map(record);
  const blocked = new Map(resources.map(id => [id, [] as [number, number][]]));
  for (const item of items) {
    if (!item || !ID.test(String(item.id)) || item.status !== "confirmed" || item.type !== "bay" || !ID.test(String(item.bayOptionId)) || item.rangeId !== rangeId || !blocked.has(String(item.bayId)) || !ID.test(String(item.bayId)) || typeof item.bayRef !== "string" || !/^\d{1,3}$/u.test(item.bayRef)) fail("The public simulator occupancy changed shape or identity");
    const start = Date.parse(String(item.start));
    const end = Date.parse(String(item.end));
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(String(item.start)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(String(item.end)) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 24 * 60 * 60_000) fail("The public simulator occupancy interval is invalid");
    blocked.get(String(item.bayId))!.push([start, end]);
  }
  const slots: SimulatorAvailabilitySlot[] = [];
  for (const resourceId of resources) for (const [start, end] of hours) for (let minute = start; minute + input.durationMinutes <= end; minute += 30) {
    const startsAt = venueTime(input.date, minute, input.timeZone);
    const endsAt = venueTime(input.date, minute + input.durationMinutes, input.timeZone);
    if (endsAt.getTime() - startsAt.getTime() !== input.durationMinutes * 60_000) fail("The public simulator interval crosses a timezone transition");
    if (blocked.get(resourceId)!.some(([busyStart, busyEnd]) => startsAt.getTime() < busyEnd && endsAt.getTime() > busyStart)) continue;
    slots.push({ sourceId: `your-golf-booking:${input.offering.id}:${venueId}:${rangeId}:${productId}:${resourceId}:${startsAt.toISOString()}`, offeringId: input.offering.id, resourceId, productId: String(productId), startsAt, endsAt, maxPartySize, bookingUrl: input.offering.bookingUrl });
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.resourceId.localeCompare(b.resourceId));
}

function venueTime(date: string, minute: number, zone: string) {
  if (minute < 0 || minute > 1440) fail("The public simulator interval extends outside the venue date");
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCMinutes(minute);
  const wall = next.toISOString().slice(0, 19);
  const instant = zonedDateTimeToDate(wall, zone);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const format = (date: Date) => { const p = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };
  if (format(instant) !== wall || [-60, 60].some(delta => format(new Date(instant.getTime() + delta * 60_000)) === wall)) fail("The public simulator wall time is ambiguous");
  return instant;
}

function validateInput(input: SimulatorAvailabilityInput) {
  if (!isYourGolfBookingPublicBookingUrl(input.offering.bookingUrl)) source("The simulator booking URL is not a public Trackman venue calendar");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) || new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date || !Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 240 || input.durationMinutes % 30 !== 0 || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 || !input.offering.id || input.offering.id.length > 200 || (input.offering.maxPartySize !== null && (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1 || input.offering.maxPartySize > 20))) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator availability request is invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  if (input.offering.supportedDurationsMinutes.length && !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "This simulator offering does not support the requested session length");
}

async function publicRead(url: URL, contentType: string, maxBytes: number, fetchImpl: typeof fetch) {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { method: "GET", redirect: "manual", cache: "no-store", credentials: "omit", headers: { Accept: contentType } }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true); }
  if (!response.ok) throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be read", response.status === 429 || response.status >= 500, response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.toString()) source("The simulator calendar changed its requested destination");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType || Number(response.headers.get("content-length")) > maxBytes || !response.body) fail("The public simulator calendar response changed type or size");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) { await reader.cancel(); fail("The public simulator calendar response exceeded its size limit"); } text += decoder.decode(value, { stream: true }); } return text + decoder.decode(); }
  catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar response could not be read", true); }
  finally { reader.releaseLock(); }
}
