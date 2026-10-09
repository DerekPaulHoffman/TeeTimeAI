import { parseExpressionAt } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";

import { parseProviderComputedSlots } from "./computed-slots";
import { knownSimulatorPublicConfigurationFamily, simulatorPublicConfigurationSchema, type AcuityPublicConfiguration } from "./public-configuration";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult } from "./types";

const ORIGIN = "https://app.acuityscheduling.com";
const PUBLIC_ID = /^[1-9]\d{0,9}$/u;
const OWNER_KEY = /^[a-zA-Z0-9]{4,40}$/u;
const MAX_RESPONSE_BYTES = 600_000;
type Node = DefaultTreeAdapterMap["node"];
type PublicProduct = { id: string; calendarIds: string[] };

export function isAcuityPublicBookingUrl(value: string) {
  return knownSimulatorPublicConfigurationFamily(value) === "ACUITY";
}

/** Reads only the published signed-out scheduler and its provider-computed
 * full-duration availability. No appointment/check-times/checkout call exists. */
export async function fetchAcuitySimulatorAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  validateInput(input);
  const url = new URL(input.offering.bookingUrl);
  const ownerKey = url.pathname.split("/").at(-1)!;
  const metadata = record(input.offering.providerMetadata);
  const rentalIds = metadata?.rentalProductIds;
  if (metadata?.ownerKey !== ownerKey || !OWNER_KEY.test(ownerKey) || !Array.isArray(rentalIds) || !rentalIds.length || rentalIds.length > 20 || rentalIds.some((id) => !PUBLIC_ID.test(String(id))) || new Set(rentalIds.map(String)).size !== rentalIds.length) throw sourceError("The public simulator owner and rental products are not verified");
  const html = await publicRead(url, "text/html", fetchImpl);
  const business = parsePublicBusiness(html);
  if (business.ownerKey !== ownerKey || !PUBLIC_ID.test(String(business.id)) || business.timezone !== input.timeZone || business.includesAdminOnly !== false || business.isExpired !== false) throw sourceError("The public simulator scheduler did not confirm the expected tenant and timezone");
  const description = typeof business.description === "string" ? textContent(parse(business.description)) : "";
  const capacity = description.match(/up\s+to\s+(\d{1,2})\s+(?:people|players|guests)\s+per\s+bay/iu);
  const liveCapacity = Number(capacity?.[1]);
  if (capacity && (!Number.isInteger(liveCapacity) || liveCapacity < 1 || liveCapacity > 20)) throw sourceError("The official simulator bay capacity is invalid");
  const maxPartySize = capacity
    ? Math.min(liveCapacity, input.offering.maxPartySize ?? liveCapacity)
    : input.offering.maxPartySize;
  const product = selectPublicRentalProduct(business, rentalIds.map(String), input.durationMinutes);
  const readUrl = new URL("/api/scheduling/v1/availability/times", ORIGIN);
  readUrl.search = new URLSearchParams({ owner: ownerKey, calendarId: "any", appointmentTypeId: product.id, startDate: input.date, timezone: input.timeZone }).toString();
  let payload: unknown;
  try { payload = JSON.parse(await publicRead(readUrl, "application/json", fetchImpl)); }
  catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw schemaError("The public simulator calendar returned an invalid availability response"); }
  const envelope = record(payload);
  if (!envelope || Object.keys(envelope).length > 1 || (Object.keys(envelope).length === 1 && !Object.hasOwn(envelope, input.date))) throw schemaError("The public simulator calendar did not return the requested date");
  const slots = parseProviderComputedSlots({ input, payload: Object.hasOwn(envelope, input.date) ? envelope[input.date] : [], productId: product.id, maxPartySize, sourcePrefix: "acuity" });
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: readUrl.toString() };
}

function selectPublicRentalProduct(business: Record<string, unknown>, rentalIds: string[], durationMinutes: number): PublicProduct {
  const types = flattenPublicGroups(business.appointmentTypes);
  const products = types.filter((item) => rentalIds.includes(String(item.id)) && item.duration === durationMinutes && item.active === true && item.private === false && item.type === "service" && item.classSize === null && item.canChooseQuantity === false);
  if (products.length !== 1) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The official simulator scheduler does not offer an unambiguous public rental for the requested session length");
  const product = products[0];
  const name = typeof product.name === "string" ? product.name : "";
  // An operator-reviewed ID still needs a current rental identity. League,
  // membership, instruction and fitting appointments are never rental stock.
  if (!/\b(?:simulator|bay)\b/iu.test(name) || !/\b(?:booking|rental|time)\b/iu.test(name) || /\b(?:league|member|lesson|fitting|handicap)\b/iu.test(name)) throw sourceError("The reviewed simulator product is not a public rental");
  const calendarIds = Array.isArray(product.calendarIDs) ? product.calendarIDs.map(String) : [];
  if (!calendarIds.length || calendarIds.length > 40 || calendarIds.some((id) => !PUBLIC_ID.test(id)) || new Set(calendarIds).size !== calendarIds.length) throw schemaError("The public simulator rental calendars are missing or ambiguous");
  const calendars = flattenPublicGroups(business.calendars).filter((item) => String(item.id) !== "any");
  for (const id of calendarIds) {
    const matches = calendars.filter((item) => String(item.id) === id);
    if (matches.length !== 1 || typeof matches[0].name !== "string" || !/^\s*bay\s+\d+\b/iu.test(matches[0].name) || matches[0].timezone !== business.timezone) throw sourceError("The public simulator product belongs to an unverified resource calendar");
  }
  return { id: String(product.id), calendarIds };
}

/** Read the existing inert BUSINESS object without evaluating its script.
 * Projection shares the runtime's public rental and resource identity checks. */
export function projectAcuityPublicConfiguration(html: string, sourceUrl: string): AcuityPublicConfiguration | undefined {
  if (!isAcuityPublicBookingUrl(sourceUrl) || Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) return;
  try {
    const ownerKey = new URL(sourceUrl).pathname.split("/").at(-1)!;
    const business = parsePublicBusiness(html);
    if (business.ownerKey !== ownerKey || !PUBLIC_ID.test(String(business.id)) || business.includesAdminOnly !== false || business.isExpired !== false) return;
    const candidates = flattenPublicGroups(business.appointmentTypes).filter(row =>
      PUBLIC_ID.test(String(row.id)) && Number.isInteger(row.duration) && Number(row.duration) >= 30 && Number(row.duration) <= 240 && Number(row.duration) % 30 === 0 &&
      row.active === true && row.private === false && row.type === "service" && row.classSize === null && row.canChooseQuantity === false &&
      typeof row.name === "string" && /\b(?:simulator|bay)\b/iu.test(row.name) && /\b(?:booking|rental|time)\b/iu.test(row.name) && !/\b(?:league|member|lesson|fitting|handicap)\b/iu.test(row.name));
    if (!candidates.length || candidates.length > 20) return;
    const rentals = candidates.map(row => {
      const product = selectPublicRentalProduct(business, [String(row.id)], Number(row.duration));
      return { id: product.id, durationMinutes: Number(row.duration), calendarIds: product.calendarIds };
    });
    const resourceIds = [...new Set(rentals.flatMap(row => row.calendarIds))];
    const description = typeof business.description === "string" ? textContent(parse(business.description)) : "";
    const capacity = description.match(/up\s+to\s+(\d{1,2})\s+(?:people|players|guests)\s+per\s+bay/iu);
    const result = simulatorPublicConfigurationSchema.safeParse({ family: "ACUITY", ownerKey, businessId: String(business.id),
      timeZone: business.timezone, maxPartySize: capacity ? Number(capacity[1]) : null, rentals,
      resources: resourceIds.map(id => ({ id, timeZone: business.timezone })) });
    return result.success && result.data.family === "ACUITY" ? result.data : undefined;
  } catch { return undefined; }
}

function parsePublicBusiness(html: string): Record<string, unknown> {
  const scripts: string[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node && node.tagName === "script") scripts.push(textContent(node));
    else if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html));
  const configs: Record<string, unknown>[] = [];
  for (const script of scripts) {
    const assignment = script.match(/\bvar\s+BUSINESS\s*=\s*/u);
    if (!assignment) continue;
    try {
      const expression = parseExpressionAt(script, assignment.index! + assignment[0].length, { ecmaVersion: "latest" });
      if (expression.type !== "ObjectExpression") throw new Error("Expected public JSON");
      const value = record(JSON.parse(script.slice(expression.start, expression.end)));
      if (!value) throw new Error("Expected public JSON");
      configs.push(value);
    } catch { throw schemaError("The public simulator configuration is not a readable JSON object"); }
  }
  if (configs.length !== 1) throw schemaError("The public simulator configuration is missing or ambiguous");
  return configs[0];
}
function flattenPublicGroups(value: unknown) {
  const groups = record(value);
  if (!groups || Object.values(groups).some((group) => !Array.isArray(group))) throw schemaError("The public simulator products or calendars changed");
  const items: unknown[] = Object.values(groups).flatMap((group) => group as unknown[]);
  if (items.length > 100 || items.some((item) => !record(item))) throw schemaError("The public simulator products or calendars are invalid");
  return items as Record<string, unknown>[];
}
function validateInput(input: SimulatorAvailabilityInput) {
  if (!isAcuityPublicBookingUrl(input.offering.bookingUrl)) throw sourceError("The simulator booking source is not an official public calendar");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) || new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date ||
    !Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 240 || input.durationMinutes % 30 !== 0 || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 ||
    !input.offering.id || input.offering.id.length > 200 || (input.offering.maxPartySize !== null && (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1))) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator availability request is invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); } catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  if (input.offering.supportedDurationsMinutes.length && !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "This simulator offering does not support the requested session length");
}
async function publicRead(url: URL, contentType: string, fetchImpl: typeof fetch) {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { method: "GET", redirect: "manual", cache: "no-store", headers: { Accept: contentType } }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true); }
  if (!response.ok) throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be read", response.status === 429 || response.status >= 500, response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.toString()) throw sourceError("The simulator calendar changed its requested destination");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) throw schemaError("The public simulator calendar returned an unexpected response type");
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
  } catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar response could not be read", true); }
  finally { reader.releaseLock(); }
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function textContent(node: Node): string { return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(textContent).join(" ") : ""; }
function schemaError(message: string) { return new SimulatorAvailabilityError("SCHEMA_CHANGED", message); }
function sourceError(message: string) { return new SimulatorAvailabilityError("INVALID_SOURCE", message); }
