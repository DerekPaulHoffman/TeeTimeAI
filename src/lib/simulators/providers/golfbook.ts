import { parse, type DefaultTreeAdapterMap } from "parse5";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { zonedDateTimeToDate } from "@/lib/timezones";

import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult, type SimulatorAvailabilitySlot } from "./types";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const PUBLIC_ID = /^[1-9]\d{0,9}$/u;
const MAX_RESPONSE_BYTES = 600_000;

export function isGolfBookPublicBookingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      /^[a-z][a-z0-9-]{0,62}\.golfbook\.in$/u.test(url.hostname) &&
      url.pathname === "/calendar.php" && !url.search && !url.hash;
  } catch { return false; }
}

/** Only the signed-out, date-specific HTML calendar is requested. Inert cell
 * attributes identify inventory; no reserve, waitlist or checkout URL is used. */
export async function fetchGolfBookAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  validateInput(input);
  const metadata = input.offering.providerMetadata;
  const templateId = metadata && typeof metadata === "object" && "templateId" in metadata ? String(metadata.templateId) : "";
  if (!PUBLIC_ID.test(templateId)) throw sourceError("The simulator calendar template is not verified");
  const url = new URL("/bookingsheet.php", input.offering.bookingUrl);
  url.search = new URLSearchParams({ date: input.date, lang: "en" }).toString();
  let response: Response;
  try {
    response = await fetchWithProviderTimeout(url, { method: "GET", redirect: "manual", cache: "no-store", headers: { Accept: "text/html" } }, fetchImpl);
  } catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true); }
  if (!response.ok) throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be read", response.status === 429 || response.status >= 500, response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.toString()) throw sourceError("The simulator calendar changed its requested destination");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/html") throw schemaError("The public simulator calendar returned an unexpected response type");
  const slots = parseGolfBookSlots(await readBoundedText(response), input, templateId);
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.toString() };
}

export function parseGolfBookSlots(html: string, input: SimulatorAvailabilityInput, templateId: string): SimulatorAvailabilitySlot[] {
  const elements = descendants(parse(html));
  const hidden = (id: string) => {
    const found = elements.filter((element) => element.tagName === "input" && attr(element, "id") === id);
    if (found.length !== 1) throw schemaError("The public simulator calendar settings are missing or ambiguous");
    return attr(found[0], "value");
  };
  if (hidden("waitlist_date") !== input.date || hidden("waitlist_template") !== templateId) throw sourceError("The public simulator calendar did not confirm the requested date and template");
  const min = Number(hidden("template_min_booking_mins"));
  const max = Number(hidden("template_max_booking_mins"));
  const increment = Number(hidden("template_booking_increment_mins"));
  if (!Number.isInteger(min) || !Number.isInteger(max) || !Number.isInteger(increment) || min < 30 || max < min || max > 1440 || increment !== 30) throw schemaError("The official simulator session lengths are not verified");
  if (input.durationMinutes < min || input.durationMinutes > max || (input.durationMinutes - min) % increment !== 0) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The official simulator scheduler does not offer the requested session length");
  const tables = elements.filter((element) => element.tagName === "table" && attr(element, "id") === "bookingsheet");
  if (tables.length !== 1) throw schemaError("The public simulator calendar grid is missing or ambiguous");
  const table = tables[0];
  const heads = descendants(table).filter((element) => element.tagName === "th" && attr(element, "id").startsWith("th_"));
  if (!heads.length || heads.length > 40) throw schemaError("The public simulator bay list is missing or invalid");
  const resources = heads.map((head) => {
    const id = attr(head, "id").slice(3);
    const capacityText = descendants(head).map((element) => attr(element, "onclick")).join(" ");
    const capacities = [...capacityText.matchAll(/up\s+to\s+(\d{1,2})\s+players/giu)].map((match) => Number(match[1]));
    if (!PUBLIC_ID.test(id) || !capacities.length || capacities.some((value) => value !== capacities[0]) || capacities[0] < 1 || capacities[0] > 20) throw schemaError("The official simulator bay capacity is not verified");
    return { id, maxPartySize: Math.min(input.offering.maxPartySize ?? capacities[0], capacities[0]), free: new Set<number>() };
  });
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) throw schemaError("The public simulator bay identifiers are ambiguous");
  const bodies = descendants(table).filter((element) => element.tagName === "tbody");
  if (bodies.length !== 1) throw schemaError("The public simulator calendar rows are missing or ambiguous");
  const rows = childElements(bodies[0]).filter((element) => element.tagName === "tr");
  if (!rows.length || rows.length > 96) throw schemaError("The public simulator calendar rows are missing or invalid");
  const rowMinutes: number[] = [];
  for (const row of rows) {
    const cells = childElements(row).filter((element) => element.tagName === "td");
    if (cells.length !== resources.length + 1 || !attr(cells[0], "class").split(/\s+/u).includes("time-col")) throw schemaError("The public simulator calendar columns changed");
    const minute = parseClock(textContent(cells[0]).trim());
    if (rowMinutes.length && minute - rowMinutes.at(-1)! !== increment) throw schemaError("The public simulator calendar time grid changed");
    rowMinutes.push(minute);
    for (let column = 0; column < resources.length; column += 1) {
      const cell = cells[column + 1];
      const status = attr(cell, "class").split(/\s+/u).filter((value) => /^status_/u.test(value));
      if (status.length !== 1 || !/^status_[0-4]$/u.test(status[0])) throw schemaError("The public simulator calendar availability state changed");
      if (status[0] !== "status_1") continue; // Includes phone-only cells: never assume they are publicly available.
      const action = attr(cell, "onclick").match(/^redirect\('reserve','date=(\d{10})&lane=([1-9]\d{0,9})&templateId=([1-9]\d{0,9})'\);?$/u);
      if (!action || action[2] !== resources[column].id || action[3] !== templateId) throw sourceError("The public simulator cell belongs to an unexpected bay or template");
      // GolfBook encodes venue wall time as a UTC epoch. Treating it as an
      // absolute instant would shift every opening by the venue's UTC offset.
      const wallClock = new Date(Number(action[1]) * 1000).toISOString();
      const expected = `${input.date}T${clock(minute)}:00.000Z`;
      if (wallClock !== expected) throw sourceError("The public simulator cell does not match its displayed venue time");
      resources[column].free.add(minute);
    }
  }
  const slots: SimulatorAvailabilitySlot[] = [];
  for (const resource of resources) {
    if (input.partySize > resource.maxPartySize) continue;
    for (const minute of rowMinutes) {
      let fullInterval = true;
      for (let offset = 0; offset < input.durationMinutes; offset += increment) {
        if (!resource.free.has(minute + offset)) { fullInterval = false; break; }
      }
      if (!fullInterval) continue;
      const startsAt = venueTime(input.date, minute, input.timeZone);
      const endsAt = venueTime(input.date, minute + input.durationMinutes, input.timeZone);
      if (endsAt.getTime() - startsAt.getTime() !== input.durationMinutes * 60_000) throw schemaError("The simulator calendar interval crosses an ambiguous timezone transition");
      slots.push({ sourceId: `golfbook:${input.offering.id}:${templateId}:${resource.id}:${startsAt.toISOString()}`, offeringId: input.offering.id, resourceId: resource.id, productId: templateId, startsAt, endsAt, maxPartySize: resource.maxPartySize, bookingUrl: input.offering.bookingUrl });
    }
  }
  if (!resources.some((resource) => input.partySize <= resource.maxPartySize)) throw new SimulatorAvailabilityError("PARTY_TOO_LARGE", "This simulator bay cannot accommodate the requested group");
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.resourceId.localeCompare(b.resourceId));
}

function validateInput(input: SimulatorAvailabilityInput) {
  if (!isGolfBookPublicBookingUrl(input.offering.bookingUrl)) throw sourceError("The simulator booking source is not an official public calendar");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) || new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date ||
    !Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 240 || input.durationMinutes % 30 !== 0 || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 ||
    !input.offering.id || input.offering.id.length > 200 || (input.offering.maxPartySize !== null && (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1))) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator availability request is invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  if (input.offering.supportedDurationsMinutes.length && !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "This simulator offering does not support the requested session length");
}

function venueTime(date: string, minute: number, timeZone: string) {
  if (minute < 0 || minute >= 1440) throw schemaError("The simulator calendar interval extends outside its observed date");
  const value = `${date}T${clock(minute)}:00`;
  const instant = zonedDateTimeToDate(value, timeZone);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localValue = (candidate: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  if (localValue(instant) !== value || [-60, 60].some((offset) => localValue(new Date(instant.getTime() + offset * 60_000)) === value)) throw schemaError("The public simulator calendar time is ambiguous in its venue timezone");
  return instant;
}
function parseClock(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/u);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) > 59) throw schemaError("The public simulator row time is invalid");
  return (Number(match[1]) % 12 + (match[3] === "PM" ? 12 : 0)) * 60 + Number(match[2]);
}
function clock(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`; }
function attr(element: Element, name: string) { return element.attrs.find((item) => item.name === name)?.value ?? ""; }
function childElements(node: Node): Element[] { return "childNodes" in node ? node.childNodes.filter((child): child is Element => "tagName" in child) : []; }
function descendants(node: Node): Element[] { return childElements(node).flatMap((child) => [child, ...descendants(child)]); }
function textContent(node: Node): string { return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(textContent).join(" ") : ""; }
async function readBoundedText(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) throw schemaError("The simulator calendar response exceeds its supported size or is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw schemaError("The simulator calendar response exceeds its supported size"); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    if (error instanceof SimulatorAvailabilityError) throw error;
    throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar response could not be read", true);
  } finally { reader.releaseLock(); }
}
function schemaError(message: string) { return new SimulatorAvailabilityError("SCHEMA_CHANGED", message); }
function sourceError(message: string) { return new SimulatorAvailabilityError("INVALID_SOURCE", message); }
