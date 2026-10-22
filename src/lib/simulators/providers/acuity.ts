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
type PublicProduct = { id: string; calendarIds: string[]; calendarKind: "NAMED_BAY" | "OPAQUE_AGGREGATE" | "OPAQUE_POOLED";
  aggregateRentalIdentity?: "DURATION_LABELLED_SIM_RENTAL" };
export type AcuityResourceIdentityDiagnostic = {
  reason: "RENTAL_CALENDARS_INVALID" | "CALENDAR_CATALOG_INVALID" | "CALENDAR_MATCH_AMBIGUOUS" |
    "CALENDAR_NAME_UNVERIFIED" | "CALENDAR_TIMEZONE_MISMATCH" |
    "AGGREGATE_CORROBORATION_MISSING" | "AGGREGATE_CALENDAR_MISMATCH";
  calendarNameKind?: "MISSING_OR_INVALID" | "VENUE_NAME" | "OTHER";
};
const resourceIdentityFailures = new WeakMap<SimulatorAvailabilityError, AcuityResourceIdentityDiagnostic>();
function resourceIdentityError(error: SimulatorAvailabilityError, diagnostic: AcuityResourceIdentityDiagnostic) {
  resourceIdentityFailures.set(error, diagnostic);
  return error;
}

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
  const aggregate = product.calendarKind === "OPAQUE_AGGREGATE" || product.calendarKind === "OPAQUE_POOLED";
  const readUrl = new URL("/api/scheduling/v1/availability/times", aggregate ? url.origin : ORIGIN);
  readUrl.search = new URLSearchParams(aggregate
    ? { owner: ownerKey, appointmentTypeId: product.id, calendarId: product.calendarIds[0], startDate: input.date,
        maxDays: "1", timezone: input.timeZone }
    : { owner: ownerKey, calendarId: "any", appointmentTypeId: product.id, startDate: input.date, timezone: input.timeZone }).toString();
  let payload: unknown;
  try { payload = JSON.parse(await publicRead(readUrl, "application/json", fetchImpl)); }
  catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw schemaError("The public simulator calendar returned an invalid availability response"); }
  const envelope = record(payload);
  if (!envelope) throw schemaError("The public simulator calendar did not return a date-keyed response");
  const slots = aggregate ? parseAggregateDates(input, envelope, product.id, maxPartySize) : parseLegacyDate(input, envelope, product.id, maxPartySize);
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
  const namedBay = namedBayRental(name, durationMinutes);
  const aggregateHours = aggregateRentalHours(name);
  const aggregate = aggregateHours > 0 && aggregateHours * 60 === durationMinutes;
  if (!namedBay && !aggregate) throw sourceError("The reviewed simulator product is not a public rental");
  const calendarIds = Array.isArray(product.calendarIDs) ? product.calendarIDs.map(String) : [];
  if (calendarIds.includes("any")) {
    // This synthetic public resource is an opaque pool, never a named bay or
    // a numeric calendar. Its blank synthetic timezone inherits only the
    // independently verified business timezone under this exact contract.
    const calendars = flattenPublicGroups(business.calendars);
    const rentals = types.filter(item => item.active === true && item.private === false && item.type === "service" &&
      item.classSize === null && item.canChooseQuantity === false && typeof item.name === "string" &&
      namedBayRental(item.name, Number(item.duration)));
    if (calendarIds.length !== 1 || !pooledRentalDuration(name, durationMinutes) || product.paddingBefore !== 0 || product.paddingAfter !== 0 ||
        calendars.length !== 1 || calendars[0].id !== "any" || calendars[0].name !== "Any available" || calendars[0].timezone !== "" ||
        !rentals.length || rentals.some(item => !PUBLIC_ID.test(String(item.id)) || !pooledRentalDuration(String(item.name), Number(item.duration)) ||
          item.paddingBefore !== 0 || item.paddingAfter !== 0 || !Array.isArray(item.calendarIDs) ||
          item.calendarIDs.length !== 1 || item.calendarIDs[0] !== "any") ||
        new Set(rentals.map(item => String(item.id))).size !== rentals.length || new Set(rentals.map(item => item.duration)).size !== rentals.length) {
      throw resourceIdentityError(sourceError("The public simulator pooled calendar contract is not corroborated"),
        { reason: "RENTAL_CALENDARS_INVALID" });
    }
    return { id: String(product.id), calendarIds, calendarKind: "OPAQUE_POOLED" };
  }
  if (!calendarIds.length || calendarIds.length > 40 || calendarIds.some((id) => !PUBLIC_ID.test(id)) || new Set(calendarIds).size !== calendarIds.length) throw resourceIdentityError(
    schemaError("The public simulator rental calendars are missing or ambiguous"), { reason: "RENTAL_CALENDARS_INVALID" });
  let calendars: Record<string, unknown>[];
  try { calendars = flattenPublicGroups(business.calendars).filter((item) => String(item.id) !== "any"); }
  catch (error) {
    if (error instanceof SimulatorAvailabilityError) resourceIdentityFailures.set(error, { reason: "CALENDAR_CATALOG_INVALID" });
    throw error;
  }
  const businessName = normalizePlainName(business.name, 120);
  const venueRental = durationMinutes >= 60 && durationLabelledSimRental(name, durationMinutes) &&
    calendarIds.length === 1 && businessName !== undefined && calendars.filter(item => String(item.id) === calendarIds[0]).length === 1 &&
    calendars.some(item => String(item.id) === calendarIds[0] && !numberedBayName(item.name) && normalizePlainName(item.name, 120) === businessName);
  if (aggregate && !namedBay || venueRental) {
    if (!businessName || !venueRental && !hasExplicitHourlyPerBayPricing(business.description) || calendarIds.length !== 1 ||
        types.filter(item => normalizePlainName(item.name, 80) === normalizePlainName(name, 80) && item.duration === durationMinutes).length !== 1) {
      throw resourceIdentityError(sourceError("The public aggregate rental identity is not corroborated"),
        { reason: "AGGREGATE_CORROBORATION_MISSING" });
    }
    const matching = calendars.filter(item => String(item.id) === calendarIds[0]);
    if (matching.length !== 1 || normalizePlainName(matching[0].name, 120) !== businessName ||
        matching[0].timezone !== business.timezone) throw resourceIdentityError(
          sourceError("The public aggregate rental calendar is not the venue calendar"), { reason: "AGGREGATE_CALENDAR_MISMATCH" });
    return { id: String(product.id), calendarIds, calendarKind: "OPAQUE_AGGREGATE",
      ...(venueRental ? { aggregateRentalIdentity: "DURATION_LABELLED_SIM_RENTAL" as const } : {}) };
  }
  for (const id of calendarIds) {
    const matches = calendars.filter((item) => String(item.id) === id);
    if (matches.length !== 1) throw resourceIdentityError(sourceError("The public simulator product belongs to an unverified resource calendar"),
      { reason: "CALENDAR_MATCH_AMBIGUOUS" });
    if (!numberedBayName(matches[0].name)) {
      const name = normalizePlainName(matches[0].name, 120), venueName = normalizePlainName(business.name, 120);
      throw resourceIdentityError(sourceError("The public simulator product belongs to an unverified resource calendar"),
        { reason: "CALENDAR_NAME_UNVERIFIED", calendarNameKind: !name ? "MISSING_OR_INVALID" : venueName && name === venueName ? "VENUE_NAME" : "OTHER" });
    }
    if (matches[0].timezone !== business.timezone) throw resourceIdentityError(
      sourceError("The public simulator product belongs to an unverified resource calendar"), { reason: "CALENDAR_TIMEZONE_MISMATCH" });
  }
  return { id: String(product.id), calendarIds, calendarKind: "NAMED_BAY" };
}

function normalizePlainName(value: unknown, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[<>\u0000-\u001f\u007f]/u.test(value)) return;
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function namedBayRental(name: string, durationMinutes: number) {
  if (/\b(?:simulator|bay)\b/iu.test(name) && /\b(?:booking|rental|reservation|time)\b/iu.test(name) &&
      !/\b(?:league|member|lesson|fitting|handicap)\b/iu.test(name)) return true;
  return durationLabelledSimRental(name, durationMinutes);
}

function numberedBayName(value: unknown) {
  return typeof value === "string" && /^\s*bay\s+\d+\b/iu.test(value);
}

function pooledRentalDuration(name: string, durationMinutes: number) {
  // Longer published products are validated with the whole pool catalog, but
  // the independent request/configuration duration ceiling remains240minutes.
  const normalized = normalizePlainName(name, 80);
  const hours = normalized?.match(/^simulator (?:booking|rental) ([1-6]) hours?$/u)?.[1];
  const minutes = normalized?.match(/^(30|60|90|120|150|180|210|240) minute simulator reservation$/u)?.[1];
  return hours !== undefined && Number(hours) * 60 === durationMinutes || minutes !== undefined && Number(minutes) === durationMinutes;
}

function durationLabelledSimRental(name: string, durationMinutes: number) {
  // An abbreviated label is corroborated by its exact published duration;
  // other uses of "sim", extra product terms and mismatched hours stay unknown.
  const hours = normalizePlainName(name, 80)?.match(/^(0\.5|[1-4](?:\.5)?) hours? sim rental$/u)?.[1];
  return hours !== undefined && Number(hours) * 60 === durationMinutes;
}

function aggregateRentalHours(value: unknown) {
  const match = normalizePlainName(value, 80)?.match(/^golf time ([1-4]) hours?$/u);
  return match ? Number(match[1]) : 0;
}

function hasExplicitHourlyPerBayPricing(value: unknown) {
  if (typeof value !== "string" || value.length > 4_000) return false;
  const visibleText = (node: Node): string => {
    if ("tagName" in node && ["script", "style", "noscript", "form", "input", "textarea", "select"].includes(node.tagName)) return "";
    if ("value" in node) return node.nodeName === "#text" ? node.value : "";
    return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : "";
  };
  const description = visibleText(parse(value)).replace(/\s+/gu, " ").trim();
  return description.length <= 2_000 && /\bplaying\s+costs?\s+are\s+per\s+bay\b/iu.test(description) &&
    /\bper\s+hour\s*,?\s*per\s+bay\b/iu.test(description) &&
    !/\b(?:members?[-\s]+only|lessons?|fittings?|leagues?|classes?)\b/iu.test(description);
}

function parseLegacyDate(input: SimulatorAvailabilityInput, envelope: Record<string, unknown>, productId: string, maxPartySize: number | null) {
  if (Object.keys(envelope).length > 1 || (Object.keys(envelope).length === 1 && !Object.hasOwn(envelope, input.date))) throw schemaError("The public simulator calendar did not return the requested date");
  return parseProviderComputedSlots({ input, payload: Object.hasOwn(envelope, input.date) ? envelope[input.date] : [], productId, maxPartySize, sourcePrefix: "acuity" });
}

function parseAggregateDates(input: SimulatorAvailabilityInput, envelope: Record<string, unknown>, productId: string, maxPartySize: number | null) {
  // The public client's selected-day mode returns one explicit date. Its
  // multi-day mode may skip unavailable days, so it is not a calendar span.
  if (!Object.hasOwn(envelope, input.date) || Object.keys(envelope).length !== 1) {
    throw schemaError("The public simulator calendar did not return exactly the requested date");
  }
  const rows = envelope[input.date];
  if (!Array.isArray(rows) || rows.length > 300 || rows.some(row => !record(row) ||
      Object.keys(row).length !== 2 || !Object.hasOwn(row, "time") || !Object.hasOwn(row, "slotsAvailable"))) {
    throw schemaError("The public simulator calendar returned an unrecognized date row");
  }
  return parseProviderComputedSlots({ input, payload: rows, productId, maxPartySize, sourcePrefix: "acuity" });
}

/** Read the existing inert BUSINESS object without evaluating its script.
 * Projection shares the runtime's public rental and resource identity checks. */
export function projectAcuityPublicConfiguration(html: string, sourceUrl: string): AcuityPublicConfiguration | undefined {
  return inspectAcuityPublicConfiguration(html, sourceUrl)?.publicConfiguration;
}

/** The observed public business name binds a newly learned recipe to a venue.
 * Existing configuration projection deliberately retains its original shape. */
export function parseAcuityPublicConfigurationIdentity(html: string, sourceUrl: string) {
  const configuration = projectAcuityPublicConfiguration(html, sourceUrl);
  if (!configuration) return;
  const business = parsePublicBusiness(html);
  if (typeof business.name !== "string" || business.name.trim().length < 2 || business.name.length > 200 ||
      /[<>\u0000-\u001f\u007f]/u.test(business.name)) return;
  return { configuration, venueName: business.name.replace(/\s+/gu, " ").trim() };
}

export async function readAcuityPublicConfiguration(input: { bookingUrl: string; fetchImpl?: typeof fetch }) {
  if (!isAcuityPublicBookingUrl(input.bookingUrl)) throw sourceError("The simulator source is not a public calendar");
  return parseAcuityPublicConfigurationIdentity(await publicRead(new URL(input.bookingUrl), "text/html", input.fetchImpl ?? fetch), input.bookingUrl);
}

type AcuityConfigurationInspection = {
  publicConfiguration?: AcuityPublicConfiguration;
  configurationDiagnostic?: { phase: "CONFIG"; reason: "PUBLIC_PROVIDER_CONFIG_REJECTED"; publicProviderFamily: "ACUITY";
    contractField: "SETTINGS" | "CATALOG" | "RENTAL_IDENTITY" | "PUBLIC_ACCESS" | "RESOURCE_IDENTITY";
    resourceIdentity?: AcuityResourceIdentityDiagnostic };
};

/** Closed rejection reasons expose no raw configuration, identifiers or customer data. */
export function inspectAcuityPublicConfiguration(html: string, sourceUrl: string): AcuityConfigurationInspection | undefined {
  if (!isAcuityPublicBookingUrl(sourceUrl)) return;
  let contractField: NonNullable<AcuityConfigurationInspection["configurationDiagnostic"]>["contractField"] = "SETTINGS";
  const rejected = (): AcuityConfigurationInspection => ({ configurationDiagnostic: {
    phase: "CONFIG", reason: "PUBLIC_PROVIDER_CONFIG_REJECTED", publicProviderFamily: "ACUITY", contractField,
  } });
  if (Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) return rejected();
  try {
    const ownerKey = new URL(sourceUrl).pathname.split("/").at(-1)!;
    const business = parsePublicBusiness(html);
    if (business.ownerKey !== ownerKey || !PUBLIC_ID.test(String(business.id))) return rejected();
    contractField = "PUBLIC_ACCESS";
    if (business.includesAdminOnly !== false || business.isExpired !== false) return rejected();
    contractField = "CATALOG";
    const candidates = flattenPublicGroups(business.appointmentTypes).filter(row =>
      PUBLIC_ID.test(String(row.id)) && Number.isInteger(row.duration) && Number(row.duration) >= 30 && Number(row.duration) <= 240 && Number(row.duration) % 30 === 0 &&
      row.active === true && row.private === false && row.type === "service" && row.classSize === null && row.canChooseQuantity === false &&
      typeof row.name === "string" && (namedBayRental(row.name, Number(row.duration)) ||
        aggregateRentalHours(row.name) > 0 && aggregateRentalHours(row.name) * 60 === Number(row.duration)));
    contractField = "RENTAL_IDENTITY";
    if (!candidates.length || candidates.length > 20) return rejected();
    contractField = "RESOURCE_IDENTITY";
    const rentals = candidates.map(row => {
      const product = selectPublicRentalProduct(business, [String(row.id)], Number(row.duration));
      return { id: product.id, durationMinutes: Number(row.duration), calendarIds: product.calendarIds,
        ...(product.calendarKind !== "NAMED_BAY" ? { calendarKind: product.calendarKind } : {}),
        ...(product.aggregateRentalIdentity ? { aggregateRentalIdentity: product.aggregateRentalIdentity } : {}) };
    });
    const resourceIds = [...new Set(rentals.flatMap(row => row.calendarIds))];
    const description = typeof business.description === "string" ? textContent(parse(business.description)) : "";
    const capacity = description.match(/up\s+to\s+(\d{1,2})\s+(?:people|players|guests)\s+per\s+bay/iu);
    contractField = "SETTINGS";
    const result = simulatorPublicConfigurationSchema.safeParse({ family: "ACUITY", ownerKey, businessId: String(business.id),
      timeZone: business.timezone, maxPartySize: capacity ? Number(capacity[1]) : null, rentals,
      resources: resourceIds.map(id => ({ id, timeZone: business.timezone })) });
    return result.success && result.data.family === "ACUITY" ? { publicConfiguration: result.data } : rejected();
  } catch (error) {
    if (contractField === "RESOURCE_IDENTITY" && error instanceof SimulatorAvailabilityError && error.code === "UNSUPPORTED_DURATION") {
      contractField = "RENTAL_IDENTITY";
    }
    const result = rejected();
    const resourceIdentity = error instanceof SimulatorAvailabilityError ? resourceIdentityFailures.get(error) : undefined;
    if (contractField === "RESOURCE_IDENTITY" && resourceIdentity) result.configurationDiagnostic!.resourceIdentity = resourceIdentity;
    return result;
  }
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
  try { response = await fetchWithProviderTimeout(url, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", headers: { Accept: contentType } }, fetchImpl); }
  catch (error) {
    if (error instanceof SimulatorAvailabilityError && ["INVALID_SOURCE", "INVALID_REQUEST", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_DURATION", "PARTY_TOO_LARGE", "PUBLIC_SESSION_REQUIRED", "HTTP_ERROR", "SCHEMA_CHANGED"].includes(error.code)) throw error;
    throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true);
  }
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
