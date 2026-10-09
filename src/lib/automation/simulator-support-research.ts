import { parse, type DefaultTreeAdapterMap } from "parse5";
import { parse as parseJavaScript } from "acorn";
import type { BrowserContext, BrowserContextOptions, Page, Route } from "@playwright/test";
import { bodySizeBand, createAddressPinnedPublicFetchTransport, getOwnedOfficialSiteBodyLimitDiagnostic, type OwnedBodySizeBand } from "./address-pinned-public-fetch";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { sanitizeResponderText } from "./course-support-responder-policy";
import { projectAcuityPublicConfiguration } from "@/lib/simulators/providers/acuity";
import { projectGolfBookPublicConfiguration } from "@/lib/simulators/providers/golfbook";
import { projectUSchedulePublicConfiguration } from "@/lib/simulators/providers/uschedule";
import type { SimulatorPublicConfiguration } from "@/lib/simulators/providers/public-configuration";
import { tagSimulatorResearchFailure, tagSimulatorResearchResourceKind, type SimulatorResearchFailurePhase,
  type SimulatorResearchResourceKind } from "./simulator-support-failure";

const MAX_BODY_BYTES = 1_500_000;
const MAX_RENDER_BYTES = 6_000_000;
const MAX_REQUESTS = 32;
const DEADLINE_MS = 20_000;
type Json = Record<string, unknown>;
type Node = DefaultTreeAdapterMap["node"];
type PublicNode = { nodeName?: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: PublicNode[] };
type ResearchPage = Pick<Page, "goto" | "content" | "url" | "mainFrame">;
type ResearchContext = Pick<BrowserContext, "route" | "routeWebSocket" | "close"> & { newPage(): Promise<ResearchPage> };
type ResearchBrowser = { newContext(options: BrowserContextOptions): Promise<ResearchContext>; close(): Promise<void> };
export type SimulatorResearchDependencies = {
  fetch?: typeof fetch;
  lease?: typeof runWithProviderRequestLease;
  browser?: () => Promise<ResearchBrowser>;
  now?: () => Date;
};

export type SimulatorPublicCalendar = {
  family: "YOUR_GOLF_BOOKING";
  venue: { id: string; slug: string; timeZone: string; status: string; maintenanceMode: boolean | null };
  ranges: Array<{ id: string; venueId: string; slug: string; bookable: boolean; slotDurationMinutes: number; slotIntervalMinutes: number; slotIntervalStart: number; assumeOpen: boolean; bookingUi: string; customerBookingUi: string; maxBookAheadValue: number; maxBookAheadUnit: string; openingHours: string; hasOpeningTimeRestrictions: boolean }>;
  rentals: Array<{ id: string; venueId: string; name: string; type: "simulator"; category: "baytime"; adminOnly: false; disabled: boolean; waitlisted: boolean; duration: number; durationType: string; minDurationSlots: number; maxDurationSlots: number; minPlayers: number | null; maxPlayers: number | null; bufferMinutes: number; hasRestrictions: boolean; requiresPerks: boolean }>;
  resources: Array<{ id: string; venueId: string; rangeId: string; type: "simulator"; bookable: boolean; optionIds: string[]; appliedOptionIds: string[]; hasRestrictedTimes: boolean }>;
};
export type SimulatorConfigurationDiagnostic = {
  phase: "CONFIG" | "VENUE" | "RANGES" | "RENTALS" | "RESOURCES";
  reason: "CONFIG_SHAPE" | "CONFIG_NUMBER" | "CONFIG_STRING" | "CONFIG_BOOLEAN" | "CONFIG_ARRAY" | "CONFIG_IDENTITY" | "CONFIG_NO_ELIGIBLE_RENTALS";
  maintenanceModeState?: "FALSE" | "TRUE" | "NULL" | "MISSING" | "INVALID";
  field?: {
    path: "props" | "props.pageProps" | "initialReduxState" | "venue" | "ranges" | "ranges.items" | "ranges.items[]" | "bays" | "bays.bayOptions" | "bays.bayOptions[]" | "bays.bayOptions[].restrictions" | "bays.bayOptions[].appliedRequiredPerks" | "bays.items" | "bays.items[]";
    expectedType: "OBJECT" | "ARRAY";
    actualType: "MISSING" | "NULL" | "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "BOOLEAN" | "OTHER";
  };
  rejectedRentalOptions?: Array<{
    publicOptionId?: string;
    adminOnlyState: "FALSE" | "TRUE" | "NULL" | "MISSING" | "INVALID";
    typeToken?: string;
    categoryToken?: string;
    categoryState?: "MISSING" | "NULL" | "NON_STRING" | "FILTERED_STRING" | "TOKEN";
    reason: "ADMIN_ONLY_NOT_FALSE" | "TYPE_NOT_SIMULATOR" | "CATEGORY_NOT_BAYTIME" | "VENUE_MISMATCH";
  }>;
  optionCount?: number;
  rejectedRentalOptionsTruncated?: boolean;
  candidateMetadata?: {
    /** Validated on this exact document; absent on older receipts. */
    venueId?: string;
    candidateCount: number;
    candidatesTruncated: boolean;
    candidates: Array<{
      publicOptionId: string;
      nameMatchesPublicRate: boolean;
      disabled: boolean;
      waitlisted: boolean;
      duration: number;
      durationTypeToken: string;
      minDurationSlots: number;
      maxDurationSlots: number;
      minPlayers?: number | null;
      maxPlayers?: number | null;
      bufferMinutes: number;
      hasRestrictions: boolean;
      requiresPerks: boolean;
    }>;
    resourceCount: number;
    resourcesTruncated: boolean;
    resources: Array<{ id: string; rangeId: string; optionIds: string[]; appliedOptionIds: string[]; hasRestrictedTimes: boolean }>;
    rangeCount: number;
    rangesTruncated: boolean;
    ranges: Array<{
      id: string;
      slugIsBays: boolean;
      bookable: boolean;
      slotDurationMinutes: number;
      slotIntervalMinutes: number;
      slotIntervalStart: number;
      assumeOpen: boolean;
      bookingUiIsStandard: boolean;
      customerBookingUiIsSlots: boolean;
      maxBookAheadValue: number;
      maxBookAheadUnitToken: string;
      hasOpeningTimeRestrictions: boolean;
      openingHoursFormat?: "EMPTY" | "WEEKLY_OR_DATED" | "OTHER";
    }>;
  };
};
export type SimulatorBodyLimitDiagnostic = {
  resourceKind: "SECONDARY_SCRIPT" | "SECONDARY_STYLESHEET";
  phase: "TRANSPORT_HEADERS" | "TRANSPORT_BODY" | "COLLECTOR_HEADERS" | "COLLECTOR_BODY";
  observedSizeBand: OwnedBodySizeBand;
  count: number;
};
export type SimulatorBlockedRequestDiagnostic = {
  state: "NOT_EXECUTED";
  resourceKind: "XHR" | "FETCH";
  method: "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER";
  reason: "METHOD_NOT_ALLOWED";
  pathShape: string;
  count: number;
};
export type SimulatorResearchResult = {
  requestedUrl: string; url: string; observedAt: string; httpStatus: number; text: string; links: string[];
  method: "HTTP" | "BROWSER"; initialHttpStatus?: number;
  bookingLinks?: string[];
  calendar?: SimulatorPublicCalendar;
  publicConfiguration?: SimulatorPublicConfiguration;
  jsonShape?: Array<{ path: string; type: string; count?: number }>;
  configurationDiagnostic?: SimulatorConfigurationDiagnostic;
  blockedRequests?: number;
  blockedRequestDiagnostics?: SimulatorBlockedRequestDiagnostic[];
  blockedRequestDiagnosticsTruncated?: true;
  admittedRequests?: number;
  renderComplete?: boolean;
  renderWarning?: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" | "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" | "SECONDARY_STYLESHEET_URL_REJECTED" | "MAIN_DOCUMENT_HTTP_ERROR";
  bodyLimitDiagnostics?: SimulatorBodyLimitDiagnostic[];
  bodyLimitDiagnosticsTruncated?: true;
  contentProvenance?: "MAIN_DOCUMENT_HTTP" | "RENDERED_DOM";
  accessControls?: Array<"CAPTCHA_OR_CHALLENGE" | "ACCOUNT_REQUIRED" | "QUEUE">;
  accessControlsObserved?: true;
  responseContracts?: Array<{ pathShape: string; queryKeys: string[]; httpStatus: number; shape: NonNullable<SimulatorResearchResult["jsonShape"]> }>;
};

const ownedUnsafeUrlErrors = new WeakSet<object>();
function publicUrl(value: unknown) {
  const safe = getSafeCustomerBookingUrl(value);
  if (!safe) {
    const error = new Error("SIMULATOR_RESEARCH_UNSAFE_URL");
    ownedUnsafeUrlErrors.add(error);
    throw error;
  }
  return new URL(safe);
}
function isOwnedUnsafeUrlError(error: unknown) {
  return error !== null && typeof error === "object" && ownedUnsafeUrlErrors.has(error);
}

type OwnedCollectorBodyLimitDiagnostic = Pick<SimulatorBodyLimitDiagnostic, "phase" | "observedSizeBand">;
const ownedPerResponseBodyLimits = new WeakMap<object, OwnedCollectorBodyLimitDiagnostic>();
function ownBodyLimitError(phase: "COLLECTOR_HEADERS" | "COLLECTOR_BODY", observedBytes: number, maxBodyBytes = MAX_BODY_BYTES) {
  const error = new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
  ownedPerResponseBodyLimits.set(error, { phase, observedSizeBand: bodySizeBand(observedBytes, maxBodyBytes) });
  return error;
}
function ownedPerResponseBodyLimit(error: unknown) {
  return error !== null && typeof error === "object" ? ownedPerResponseBodyLimits.get(error) : undefined;
}

export function summarizeSimulatorSupportPublicHtml(html: string, sourceUrl: string) {
  const text: string[] = [], anchors = new Set<string>();
  const walk = (node: PublicNode) => {
    if (node.tagName && ["script", "style", "form", "input", "textarea", "select", "noscript"].includes(node.tagName)) return;
    if (node.nodeName === "#text" && node.value) text.push(node.value);
    if (node.tagName === "a" && anchors.size < 30) {
      const href = node.attrs?.find(attribute => attribute.name === "href")?.value;
      if (href) { try { anchors.add(publicUrl(new URL(href, sourceUrl).href).href); } catch { /* Unsafe access/transaction links are omitted. */ } }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return { text: sanitizeResponderText(text.join(" ").replace(/\s+/g, " ").trim()).slice(0, 12_000), links: [...anchors] };
}

function hasEmptyClientAppRoot(html: string) {
  let empty = false;
  const visit = (node: PublicNode) => {
    if (node.tagName === "div" && node.attrs?.some(attr => attr.name === "id" && attr.value === "app")) {
      empty = (node.childNodes ?? []).every(child => child.nodeName === "#comment" ||
        child.nodeName === "#text" && !child.value?.trim());
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html));
  return empty;
}

function hasVisibleBodyContent(html: string) {
  const visit = (node: PublicNode, inBody: boolean): boolean => {
    if (node.tagName && ["head", "script", "style", "form", "input", "textarea", "select", "noscript"].includes(node.tagName)) return false;
    const body = inBody || node.tagName === "body";
    if (body && node.nodeName === "#text" && sanitizeResponderText(node.value ?? "").trim()) return true;
    if (body && node.tagName === "a" && node.attrs?.some(attr => attr.name === "href")) return true;
    return (node.childNodes ?? []).some(child => visit(child, body));
  };
  return visit(parse(html), false);
}

const sensitiveField = /(?:user|customer|owner|account|contact|session|token|secret|password|credential|api.?key|csrf|xsrf|auth|cookie|header|email|phone|address|payment|card|checkout|cart|perk|profile|member|player|booking|reservation)/iu;
export function summarizeSimulatorPublicJsonShape(value: unknown) {
  const shape: NonNullable<SimulatorResearchResult["jsonShape"]> = [];
  const visit = (node: unknown, path: string, depth: number) => {
    if (shape.length >= 80 || depth > 5) return;
    if (Array.isArray(node)) { shape.push({ path, type: "array", count: Math.min(node.length, 10_000) }); if (node.length) visit(node[0], `${path}[]`, depth + 1); return; }
    if (node && typeof node === "object") {
      shape.push({ path, type: "object" });
      for (const [key, child] of Object.entries(node).slice(0, 40)) {
        if (sensitiveField.test(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) continue;
        visit(child, `${path}.${key}`, depth + 1);
      }
      return;
    }
    shape.push({ path, type: node === null ? "null" : typeof node });
  };
  visit(value, "$", 0);
  return shape;
}

const ownedConfigurationErrors = new WeakMap<object, SimulatorConfigurationDiagnostic["reason"]>();
function configurationError(reason: SimulatorConfigurationDiagnostic["reason"]): never {
  const error = new Error(reason);
  ownedConfigurationErrors.set(error, reason);
  throw error;
}
function record(value: unknown): Json { if (!value || typeof value !== "object" || Array.isArray(value)) configurationError("CONFIG_SHAPE"); return value as Json; }
function number(value: unknown, min = 0, max = 1_000_000_000) { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) configurationError("CONFIG_NUMBER"); return Number(value); }
function id(value: unknown) { return String(number(value, 1)); }
function string(value: unknown, max = 80) { if (typeof value !== "string" || value.length > max || /[<>\r\n\x00-\x1f]/u.test(value)) configurationError("CONFIG_STRING"); return value; }
function bool(value: unknown) { if (typeof value !== "boolean") configurationError("CONFIG_BOOLEAN"); return value; }
function array(value: unknown, max = 100): unknown[] { if (!Array.isArray(value) || value.length > max) configurationError("CONFIG_ARRAY"); return value; }
function optionalNumber(value: unknown, max = 20) { return value === null || value === undefined ? null : number(value, 1, max); }
function maintenanceModeState(value: unknown): NonNullable<SimulatorConfigurationDiagnostic["maintenanceModeState"]> {
  return value === false ? "FALSE" : value === true ? "TRUE" : value === null ? "NULL" : value === undefined ? "MISSING" : "INVALID";
}
function uniqueConfigurationRows(rows: { id: string }[]) {
  if (!rows.length) configurationError("CONFIG_ARRAY");
  if (new Set(rows.map(row => row.id)).size !== rows.length) configurationError("CONFIG_IDENTITY");
}

function readInertNextData(html: string) {
  const scripts: string[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node && node.tagName === "script" && node.attrs.some(attribute => attribute.name === "id" && attribute.value === "__NEXT_DATA__") && node.attrs.some(attribute => attribute.name === "type" && attribute.value === "application/json")) {
      scripts.push("childNodes" in node ? node.childNodes.map(child => "value" in child ? child.value : "").join("") : "");
    } else if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html));
  if (scripts.length !== 1 || Buffer.byteLength(scripts[0], "utf8") > MAX_BODY_BYTES) return undefined;
  try { return JSON.parse(scripts[0]) as unknown; } catch { return undefined; }
}

function publicVenueSlug(sourceUrl: string, includeYourGolfBooking = false) {
  const url = publicUrl(sourceUrl);
  if (url.protocol !== "https:" || url.search || url.hash || !(["booking.trackmangolf.com", ...(includeYourGolfBooking ? ["yourgolfbooking.com", "www.yourgolfbooking.com"] : [])].includes(url.hostname))) return undefined;
  return url.pathname.match(/^\/venues\/([a-z0-9]+(?:-[a-z0-9]+)*)\/booking(?:\/bays)?\/?$/u)?.[1];
}

function publishedYourGolfBookingSlug(html: string, sourceUrl: string) {
  try {
    const slug = publicVenueSlug(sourceUrl, true);
    if (!slug) return undefined;
    const parsed = readInertNextData(html);
    const venue = record(record(record(record(record(parsed).props).pageProps).initialReduxState).venue);
    id(venue.id);
    new Intl.DateTimeFormat("en-US", { timeZone: string(venue.timezone) }).format();
    // Research observes only the existing anonymous endpoint. Explicit null is
    // retained as unknown configuration; it never establishes runtime eligibility.
    return venue.slug === slug && venue.status === "live" && (venue.maintenanceMode === false || venue.maintenanceMode === null) ? slug : undefined;
  } catch { return undefined; }
}

/** Closed syntax evidence only: no raw hours, weekday coverage or availability claim. */
function openingHoursFormat(value: string): "EMPTY" | "WEEKLY_OR_DATED" | "OTHER" {
  if (!value.trim()) return "EMPTY";
  const seen = new Set<string>();
  for (const part of value.split(";")) {
    const match = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su|\d{4} [A-Z][a-z]{2} \d{1,2}) (off|\d{2}:\d{2}-\d{2}:\d{2} open)$/u);
    if (!match || seen.has(match[1])) return "OTHER";
    seen.add(match[1]);
  }
  return "WEEKLY_OR_DATED";
}

/** Optional research facts for a rejected public-looking rental, never a calendar or eligibility decision. */
function rejectedRentalCandidateMetadata(
  ranges: SimulatorPublicCalendar["ranges"], venueId: string, bays: Json, optionRows: unknown[],
): SimulatorConfigurationDiagnostic["candidateMetadata"] {
  try {
    const machineToken = (value: unknown) => {
      const observed = string(value, 32);
      if (!/^[a-z0-9_-]{1,32}$/u.test(observed)) configurationError("CONFIG_STRING");
      return observed;
    };
    const candidates: NonNullable<SimulatorConfigurationDiagnostic["candidateMetadata"]>["candidates"] = [];
    const seenOptionIds = new Set<string>();
    const allCandidateIds = new Set<string>();
    let candidateCount = 0;
    for (const [index, value] of optionRows.entries()) {
      const row = record(value);
      const optionId = id(row.id);
      if (seenOptionIds.has(optionId)) configurationError("CONFIG_IDENTITY");
      seenOptionIds.add(optionId);
      if (row.adminOnly !== false || row.type !== "simulator" || row.category !== null) continue;
      if (id(row.venue) !== venueId) configurationError("CONFIG_IDENTITY");
      const publicOptionId = optionId;
      candidateCount += 1;
      allCandidateIds.add(publicOptionId);
      const nameMatchesPublicRate = string(row.name) === "Public Rate";
      const minDurationSlots = number(row.minBookingDuration, 1, 48);
      const maxDurationSlots = number(row.maxBookingDuration, 1, 48);
      if (minDurationSlots > maxDurationSlots) configurationError("CONFIG_NUMBER");
      const minPlayers = row.minPlayers === null ? null : row.minPlayers === undefined ? undefined : number(row.minPlayers, 1, 20);
      const maxPlayers = row.maxPlayers === null ? null : row.maxPlayers === undefined ? undefined : number(row.maxPlayers, 1, 20);
      if (typeof minPlayers === "number" && typeof maxPlayers === "number" && minPlayers > maxPlayers) configurationError("CONFIG_NUMBER");
      const candidate = {
        publicOptionId, nameMatchesPublicRate, disabled: bool(row.disabled), waitlisted: bool(row.waitlisted),
        duration: number(row.duration, 1, 48), durationTypeToken: machineToken(row.durationType),
        minDurationSlots, maxDurationSlots,
        ...(minPlayers === undefined ? {} : { minPlayers }), ...(maxPlayers === undefined ? {} : { maxPlayers }),
        bufferMinutes: number(row.bufferPeriodMinutes, 0, 1440),
        hasRestrictions: array(row.restrictions).length > 0,
        requiresPerks: array(row.appliedRequiredPerks, 20).length > 0,
      };
      // Validate every candidate, including those past the bounded rejection
      // prefix, but project only rows the existing rejection list can attest.
      if (index < 8) candidates.push(candidate);
    }
    if (!candidates.length) return undefined;
    const projectedIds = new Set(candidates.map(row => row.publicOptionId));
    const rangeIds = new Set(ranges.map(row => row.id));
    const seenResourceIds = new Set<string>();
    const linkedResources: NonNullable<SimulatorConfigurationDiagnostic["candidateMetadata"]>["resources"] = [];
    let simulatorResourceCount = 0;
    for (const value of array(bays.items)) {
      const row = record(value);
      const resourceId = id(row.id);
      if (seenResourceIds.has(resourceId)) configurationError("CONFIG_IDENTITY");
      seenResourceIds.add(resourceId);
      if (row.type !== "simulator") continue;
      simulatorResourceCount += 1;
      if (simulatorResourceCount > 40) configurationError("CONFIG_ARRAY");
      const rangeId = id(row.range);
      if (id(row.venue) !== venueId || !rangeIds.has(rangeId)) configurationError("CONFIG_IDENTITY");
      const bookable = bool(row.bookable);
      const options = array(row.options).map(id), appliedOptions = array(row.appliedOptions).map(id);
      if (new Set(options).size !== options.length || new Set(appliedOptions).size !== appliedOptions.length) configurationError("CONFIG_IDENTITY");
      const allListed = options.filter(optionId => allCandidateIds.has(optionId));
      const allApplied = appliedOptions.filter(optionId => allCandidateIds.has(optionId));
      const listed = allListed.filter(optionId => projectedIds.has(optionId));
      const applied = allApplied.filter(optionId => projectedIds.has(optionId));
      // A bookable resource linked only to candidates outside the retained
      // prefix cannot be counted honestly in this bounded projection.
      if (bookable && (allListed.length || allApplied.length) && !(listed.length || applied.length)) configurationError("CONFIG_IDENTITY");
      const hasRestrictedTimes = array(row.restrictedTimes).length > 0;
      if (bookable && (listed.length || applied.length)) linkedResources.push({ id: resourceId, rangeId, optionIds: listed, appliedOptionIds: applied, hasRestrictedTimes });
    }
    const referencedIds = [...new Set(linkedResources.map(row => row.rangeId))];
    const resources = linkedResources.slice(0, 8);
    const projectedRangeIds = new Set(resources.map(row => row.rangeId));
    const projectedRanges = ranges.filter(row => projectedRangeIds.has(row.id)).slice(0, 8).map(row => ({
      id: row.id, slugIsBays: row.slug === "bays", bookable: row.bookable,
      slotDurationMinutes: row.slotDurationMinutes, slotIntervalMinutes: row.slotIntervalMinutes,
      slotIntervalStart: row.slotIntervalStart, assumeOpen: row.assumeOpen,
      bookingUiIsStandard: row.bookingUi === "standard", customerBookingUiIsSlots: row.customerBookingUi === "slots",
      maxBookAheadValue: row.maxBookAheadValue, maxBookAheadUnitToken: machineToken(row.maxBookAheadUnit),
      hasOpeningTimeRestrictions: row.hasOpeningTimeRestrictions,
      openingHoursFormat: openingHoursFormat(row.openingHours),
    }));
    return {
      venueId,
      candidateCount, candidatesTruncated: candidateCount > candidates.length, candidates,
      resourceCount: linkedResources.length, resourcesTruncated: linkedResources.length > resources.length, resources,
      rangeCount: referencedIds.length, rangesTruncated: referencedIds.length > projectedRanges.length, ranges: projectedRanges,
    };
  } catch {
    // Metadata is optional. A malformed extra field must not replace the
    // original no-eligible-rentals diagnosis or become a false zero count.
    return undefined;
  }
}

/** Parse published inert JSON only. Never evaluate inline scripts or retain the original state. */
export function extractSimulatorPublicCalendar(html: string, sourceUrl: string): Pick<SimulatorResearchResult, "calendar" | "jsonShape" | "configurationDiagnostic"> {
  const parsed = readInertNextData(html);
  if (parsed === undefined) return {};
  const shape = { jsonShape: summarizeSimulatorPublicJsonShape(parsed) };
  let phase: SimulatorConfigurationDiagnostic["phase"] = "CONFIG";
  let observedMaintenanceMode: SimulatorConfigurationDiagnostic["maintenanceModeState"];
  let failedField: SimulatorConfigurationDiagnostic["field"];
  let rejectedRentalOptions: SimulatorConfigurationDiagnostic["rejectedRentalOptions"];
  let optionCount: number | undefined;
  let rejectedRentalOptionsTruncated: boolean | undefined;
  let candidateMetadata: SimulatorConfigurationDiagnostic["candidateMetadata"];
  const actualType = (value: unknown): NonNullable<SimulatorConfigurationDiagnostic["field"]>["actualType"] =>
    value === undefined ? "MISSING" : value === null ? "NULL" : Array.isArray(value) ? "ARRAY" :
      typeof value === "object" ? "OBJECT" : typeof value === "string" ? "STRING" :
        typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOLEAN" : "OTHER";
  const readObject = (value: unknown, path: NonNullable<SimulatorConfigurationDiagnostic["field"]>["path"]) => {
    try { return record(value); }
    catch (error) { failedField = { path, expectedType: "OBJECT", actualType: actualType(value) }; throw error; }
  };
  const readArray = (value: unknown, path: NonNullable<SimulatorConfigurationDiagnostic["field"]>["path"], max = 100) => {
    try { return array(value, max); }
    catch (error) { failedField = { path, expectedType: "ARRAY", actualType: actualType(value) }; throw error; }
  };
  try {
    const url = publicUrl(sourceUrl);
    const slug = publicVenueSlug(sourceUrl, true);
    if (!slug || url.search || url.hash) return shape;
    const props = readObject(record(parsed).props, "props");
    const pageProps = readObject(props.pageProps, "props.pageProps");
    const config = readObject(pageProps.initialReduxState, "initialReduxState");
    phase = "VENUE";
    const venue = readObject(config.venue, "venue");
    observedMaintenanceMode = maintenanceModeState(venue.maintenanceMode);
    const venueId = id(venue.id), venueSlug = string(venue.slug), timeZone = string(venue.timezone);
    if (venueSlug !== slug) configurationError("CONFIG_IDENTITY");
    const status = string(venue.status);
    const maintenanceMode = venue.maintenanceMode === null ? null : bool(venue.maintenanceMode);
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    phase = "RANGES";
    const ranges = readArray(readObject(config.ranges, "ranges").items, "ranges.items", 20).map(value => {
      const row = readObject(value, "ranges.items[]");
      if (id(row.venue) !== venueId) configurationError("CONFIG_IDENTITY");
      return { id: id(row.id), venueId, slug: string(row.slug), bookable: bool(row.bookable), slotDurationMinutes: number(row.slotDuration, 1, 240), slotIntervalMinutes: number(row.slotInterval, 1, 240), slotIntervalStart: number(row.slotIntervalStart, 0, 1440), assumeOpen: bool(row.assumeOpen), bookingUi: string(row.bookingUi), customerBookingUi: string(row.customerBookingUi), maxBookAheadValue: number(row.maxBookAheadValue, 1, 365), maxBookAheadUnit: string(row.maxBookAheadUnit), openingHours: string(row.openingHours, 2000), hasOpeningTimeRestrictions: array(row.openingTimes).length > 0 };
    });
    uniqueConfigurationRows(ranges);
    phase = "RENTALS";
    const bays = readObject(config.bays, "bays");
    const excludedOptions: NonNullable<SimulatorConfigurationDiagnostic["rejectedRentalOptions"]> = [];
    const optionRows = readArray(bays.bayOptions, "bays.bayOptions");
    const rentals = optionRows.flatMap(value => {
      const row = readObject(value, "bays.bayOptions[]");
      const rejectionReason: NonNullable<SimulatorConfigurationDiagnostic["rejectedRentalOptions"]>[number]["reason"] | null =
        row.adminOnly !== false ? "ADMIN_ONLY_NOT_FALSE" : row.type !== "simulator" ? "TYPE_NOT_SIMULATOR" :
          row.category !== "baytime" ? "CATEGORY_NOT_BAYTIME" : id(row.venue) !== venueId ? "VENUE_MISMATCH" : null;
      if (rejectionReason) {
        // Project only closed facts, and return them only if no rental survives.
        if (excludedOptions.length < 8) {
          const publicOption = row.adminOnly === false;
          const token = (value: unknown) => typeof value === "string" && /^[a-z0-9_-]{1,32}$/u.test(value) ? value : undefined;
          excludedOptions.push({
            adminOnlyState: row.adminOnly === false ? "FALSE" : row.adminOnly === true ? "TRUE" :
              row.adminOnly === null ? "NULL" : row.adminOnly === undefined ? "MISSING" : "INVALID",
            ...(publicOption && typeof row.id === "number" && Number.isInteger(row.id) && row.id >= 1 && row.id <= 1_000_000_000 ? { publicOptionId: String(row.id) } : {}),
            ...(publicOption && token(row.type) ? { typeToken: token(row.type) } : {}),
            ...(publicOption && token(row.category) ? { categoryToken: token(row.category) } : {}),
            ...(rejectionReason === "CATEGORY_NOT_BAYTIME" ? { categoryState:
              row.category === undefined ? "MISSING" as const : row.category === null ? "NULL" as const :
                typeof row.category !== "string" ? "NON_STRING" as const :
                  token(row.category) ? "TOKEN" as const : "FILTERED_STRING" as const } : {}),
            reason: rejectionReason,
          });
        }
        return [];
      }
      return [{ id: id(row.id), venueId, name: string(row.name), type: "simulator" as const, category: "baytime" as const, adminOnly: false as const, disabled: bool(row.disabled), waitlisted: bool(row.waitlisted), duration: number(row.duration, 1, 48), durationType: string(row.durationType), minDurationSlots: number(row.minBookingDuration, 1, 48), maxDurationSlots: number(row.maxBookingDuration, 1, 48), minPlayers: optionalNumber(row.minPlayers), maxPlayers: optionalNumber(row.maxPlayers), bufferMinutes: number(row.bufferPeriodMinutes, 0, 1440), hasRestrictions: readArray(row.restrictions, "bays.bayOptions[].restrictions").length > 0, requiresPerks: readArray(row.appliedRequiredPerks, "bays.bayOptions[].appliedRequiredPerks", 20).length > 0 }];
    });
    if (!rentals.length) {
      rejectedRentalOptions = excludedOptions;
      optionCount = optionRows.length;
      rejectedRentalOptionsTruncated = optionRows.length > excludedOptions.length;
      candidateMetadata = rejectedRentalCandidateMetadata(ranges, venueId, bays, optionRows);
      configurationError("CONFIG_NO_ELIGIBLE_RENTALS");
    }
    uniqueConfigurationRows(rentals);
    phase = "RESOURCES";
    const resourceRows = readArray(bays.items, "bays.items").map(value => readObject(value, "bays.items[]")).filter(row => row.type === "simulator");
    if (resourceRows.length > 40) configurationError("CONFIG_ARRAY");
    const resources = resourceRows.map(row => {
      if (id(row.venue) !== venueId || !ranges.some(range => range.id === id(row.range))) configurationError("CONFIG_IDENTITY");
      return { id: id(row.id), venueId, rangeId: id(row.range), type: "simulator" as const, bookable: bool(row.bookable), optionIds: array(row.options).map(id).filter(value => rentals.some(rental => rental.id === value)), appliedOptionIds: array(row.appliedOptions).map(id).filter(value => rentals.some(rental => rental.id === value)), hasRestrictedTimes: array(row.restrictedTimes).length > 0 };
    });
    uniqueConfigurationRows(resources);
    return { calendar: { family: "YOUR_GOLF_BOOKING", venue: { id: venueId, slug, timeZone, status, maintenanceMode }, ranges, rentals, resources } };
  } catch (error) {
    const reason = error !== null && typeof error === "object" ? ownedConfigurationErrors.get(error) : undefined;
    return reason ? { ...shape, configurationDiagnostic: { phase, reason, ...(failedField ? { field: failedField } : {}), ...(observedMaintenanceMode ? { maintenanceModeState: observedMaintenanceMode } : {}), ...(rejectedRentalOptions ? { rejectedRentalOptions, optionCount, rejectedRentalOptionsTruncated } : {}), ...(candidateMetadata ? { candidateMetadata } : {}) } } : shape;
  }
}

async function boundedBody(response: Response, maxBodyBytes = MAX_BODY_BYTES) {
  const declaredBytes = Number(response.headers.get("content-length"));
  if (declaredBytes > maxBodyBytes) throw ownBodyLimitError("COLLECTOR_HEADERS", declaredBytes, maxBodyBytes);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBodyBytes) { await reader.cancel(); throw ownBodyLimitError("COLLECTOR_BODY", bytes, maxBodyBytes); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function resultFromBody(requestedUrl: string, url: string, status: number, contentType: string, body: Buffer, observedAt: Date): SimulatorResearchResult {
  const base = { requestedUrl, url, httpStatus: status, observedAt: observedAt.toISOString(), method: "HTTP" as const, text: "", links: [] as string[] };
  if (status < 200 || status >= 300) return base;
  if (contentType.includes("application/json")) { try { return { ...base, jsonShape: summarizeSimulatorPublicJsonShape(JSON.parse(body.toString("utf8"))) }; } catch { return base; } }
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)) return base;
  const html = body.toString("utf8");
  const summary = summarizeSimulatorSupportPublicHtml(html, url);
  const publishedRoles = publishedBootstrapBookingRoles(html);
  const bookingLinks = [...publicBookingLinkRoles(html, url, summary.links), ...publishedRoles];
  // Preserve an observed booking CTA when the ordinary anchor list already
  // fills the saved-link cap. Every role must also survive in that same list.
  summary.links = [...new Set([...publishedRoles, ...summary.links])].slice(0, 30);
  const slug = publicVenueSlug(url) ?? publishedYourGolfBookingSlug(html, url);
  // This is the platform's fixed public configuration route. It is a
  // research destination, never evidence of inventory or runnable monitoring.
  if (slug && /\/booking\/?$/u.test(new URL(url).pathname)) {
    const bays = `${new URL(url).origin}/venues/${slug}/booking/bays`;
    summary.links = [...new Set([bays, ...summary.links])].slice(0, 30);
    bookingLinks.unshift(bays);
  }
  const publicConfiguration = projectAcuityPublicConfiguration(html, url) ?? projectGolfBookPublicConfiguration(html, url) ??
    projectUSchedulePublicConfiguration(html, url);
  const retainedLinks = new Set(summary.links);
  const retainedBookingLinks = [...new Set(bookingLinks)].filter(link => retainedLinks.has(link));
  return { ...base, ...summary, ...(retainedBookingLinks.length ? { bookingLinks: retainedBookingLinks } : {}),
    ...(publicConfiguration ? { publicConfiguration } : {}), ...extractSimulatorPublicCalendar(html, url) };
}

function publishedBootstrapBookingRoles(html: string) {
  const scripts: string[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node && node.tagName === "script") {
      const body = "childNodes" in node ? node.childNodes.map(child => "value" in child ? child.value : "").join("") : "";
      if (body.includes("window.__BOOTSTRAP_STATE__")) scripts.push(body);
    } else if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html));
  if (scripts.length !== 1 || Buffer.byteLength(scripts[0], "utf8") > 200_000) return [];
  const script = scripts[0];
  let bootstrap: unknown;
  try {
    const program = parseJavaScript(script, { ecmaVersion: "latest", sourceType: "script" });
    if (program.body.length !== 1 || program.body[0].type !== "ExpressionStatement") return [];
    const assignment = program.body[0].expression;
    if (assignment.type !== "AssignmentExpression" || assignment.operator !== "=" ||
        assignment.left.type !== "MemberExpression" || assignment.left.computed ||
        assignment.left.object.type !== "Identifier" || assignment.left.object.name !== "window" ||
        assignment.left.property.type !== "Identifier" || assignment.left.property.name !== "__BOOTSTRAP_STATE__" ||
        assignment.right.type !== "ObjectExpression") return [];
    bootstrap = JSON.parse(script.slice(assignment.right.start, assignment.right.end));
  } catch { return []; }
  const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const siteData = object(object(bootstrap)?.siteData);
  const navigation = object(object(siteData?.snapshot)?.properties)?.navigation;
  if (navigation !== undefined && (!Array.isArray(navigation) || navigation.length > 30)) return [];
  const links: string[] = [];
  const addExternal = (external: unknown) => {
    if (typeof external !== "string" || external.length > 2_048) return false;
    try { const url = publicUrl(external); if (url.protocol !== "https:") return false; links.push(url.href); return true; }
    catch { return false; }
  };
  for (const candidate of Array.isArray(navigation) ? navigation : []) {
    const entry = object(candidate);
    if (!entry || entry.type !== "external" || entry.tab !== false || !Array.isArray(entry.children) || entry.children.length !== 0 ||
        typeof entry.title !== "string" || sanitizeResponderText(entry.title).replace(/\s+/gu, " ").trim().toUpperCase() !== "BOOK A TEE TIME") continue;
    if (!addExternal(object(entry.link)?.external)) return [];
  }
  const banner = object(object(object(object(siteData?.page)?.properties)?.contentAreas)?.banner);
  const content = object(banner?.content);
  const elements = content?.elements;
  if (banner?.hidden === false && content?.type === "block") {
    if (!Array.isArray(elements) || elements.length > 30) return [];
    for (const candidate of elements) {
      const entry = object(candidate);
      if (entry?.purpose !== "button-1") continue;
      const properties = object(entry.properties);
      if (properties?.hidden !== false || typeof properties.label !== "string" ||
          sanitizeResponderText(properties.label).replace(/\s+/gu, " ").trim().toUpperCase() !== "BOOK NOW") continue;
      const role = object(properties.link);
      if (role?.type !== "external" || role.tab !== false || !addExternal(object(role.link)?.external)) return [];
    }
  }
  return new Set(links).size <= 1 ? links : [];
}

function publicBookingLinkRoles(html: string, sourceUrl: string, safeLinks: string[]) {
  const roles = new Set<string>();
  const label = (node: PublicNode): string => node.nodeName === "#text" ? node.value?.slice(0, 200) ?? "" : (node.childNodes ?? []).map(label).join(" ").slice(0, 200);
  const visit = (node: PublicNode) => {
    if (node.tagName && ["script", "style", "form", "input", "textarea", "select", "noscript"].includes(node.tagName)) return;
    if (node.tagName === "a" && roles.size < 30) {
      const href = node.attrs?.find(attr => attr.name === "href")?.value;
      const labels = [label(node), ...((node.attrs ?? []).filter(attr => ["aria-label", "title"].includes(attr.name)).map(attr => attr.value.slice(0, 200)))].join(" ");
      if (href && /\b(?:book(?:ing)?(?:\s*now)?|reserve|reservations?|appointments?)\b/iu.test(sanitizeResponderText(labels))) {
        try { const url = publicUrl(new URL(href, sourceUrl).href).href; if (safeLinks.includes(url)) roles.add(url); } catch { /* Roles never rescue unsafe or unobserved URLs. */ }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html));
  return [...roles];
}

async function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
  let abort!: () => void;
  const timeout = new Promise<never>((_, reject) => { abort = () => reject(new Error("SIMULATOR_RESEARCH_DEADLINE")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([operation, timeout]); } finally { signal.removeEventListener("abort", abort); }
}

async function researchOperation<T>(phase: SimulatorResearchFailurePhase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw tagSimulatorResearchFailure(error, phase); }
}

export function detectSimulatorResearchAccessControls(html: string) {
  const controls = new Set<NonNullable<SimulatorResearchResult["accessControls"]>[number]>();
  const visible = summarizeSimulatorSupportPublicHtml(html, "https://source.example.test").text;
  if (/verify (?:that )?you are human|checking your browser|complete the captcha/iu.test(visible)) controls.add("CAPTCHA_OR_CHALLENGE");
  if (/(?:sign|log) in (?:is required|to continue)|authentication required/iu.test(visible)) controls.add("ACCOUNT_REQUIRED");
  if (/you are (?:now )?in (?:a|the) queue|your (?:position|place) in (?:the )?queue/iu.test(visible)) controls.add("QUEUE");
  const visit = (node: PublicNode) => {
    const attrs = node.attrs ?? [];
    if (attrs.some(attr => attr.name === "hidden" || (attr.name === "aria-hidden" && attr.value === "true") || (attr.name === "style" && /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr.value)))) return;
    if (attrs.some(attr => ["id", "class"].includes(attr.name) && /(?:cf-chl|challenge-form|g-recaptcha|h-captcha|cf-turnstile)/iu.test(attr.value)) ||
        (node.tagName === "iframe" && attrs.some(attr => attr.name === "src" && /recaptcha|hcaptcha|challenges\.cloudflare/iu.test(attr.value)))) controls.add("CAPTCHA_OR_CHALLENGE");
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html));
  return [...controls];
}

function sameOfficialHost(left: string, right: string) {
  const a = publicUrl(left), b = publicUrl(right);
  return a.hostname.replace(/^www\./iu, "") === b.hostname.replace(/^www\./iu, "") &&
    (a.protocol === b.protocol || (a.protocol === "http:" && b.protocol === "https:"));
}

function contractPath(url: URL) {
  const words = /^(?:api|venue|venues|bookings|booking|public|availability|calendar|times|ranges|bays|configuration|slots|search|sessions|opening-hours|v[0-9])$/iu;
  const pathShape = url.pathname.split("/").map(part => !part || words.test(part) ? part : /^\d+$/u.test(part) ? ":id" : ":value").join("/").slice(0, 400);
  const queryKeys = [...new Set([...url.searchParams.keys()].filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) && !sensitiveField.test(key)))].slice(0, 20);
  return { pathShape, queryKeys };
}

/** Static route vocabulary only: no untrusted path component or query survives. */
function blockedRequestPathShape(url: URL) {
  const words = new Set(["api", "booking", "changefield", "availability", "calendar", "times", "public", "schedule", "slots"]);
  const parts = url.pathname.split("/").filter(Boolean);
  return "/" + [...parts.slice(0, 8).map(part => words.has(part.toLowerCase()) ? part.toLowerCase() : ":value"),
    ...(parts.length > 8 ? [":more"] : [])].join("/");
}

function publicAssetDestinations(html: string, sourceUrl: string) {
  const assets = new Set<string>();
  const visit = (node: PublicNode) => {
    const attrs = node.attrs ?? [];
    const path = node.tagName === "script" ? attrs.find(attr => attr.name === "src")?.value : node.tagName === "link" && attrs.some(attr => attr.name === "rel" && attr.value.toLowerCase().split(/\s+/u).includes("stylesheet")) ? attrs.find(attr => attr.name === "href")?.value : undefined;
    if (path && assets.size < 20) { try { const url = publicUrl(new URL(path, sourceUrl).href); if (!/captcha|challenge|turnstile|cdn-cgi/iu.test(`${url.hostname}${url.pathname}`)) assets.add(url.href); } catch { /* Untrusted resource declarations cannot expand request authority. */ } }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html));
  return [...assets];
}

function publicOccupancyUrl(url: URL, slug: string | undefined) {
  if (!slug || url.origin !== "https://api.yourgolfbooking.com" || url.pathname !== `/venue/${slug}/bookings/public` || url.hash) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("start_gte") || !keys.includes("start_lte")) return false;
  const start = Date.parse(url.searchParams.get("start_gte")!), end = Date.parse(url.searchParams.get("start_lte")!);
  return Number.isFinite(start) && Number.isFinite(end) && start < end && end - start <= 3 * 86_400_000;
}

function knownPublicNetworkError(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const details = current as { code?: unknown; cause?: unknown };
    if (typeof details.code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(details.code)) return new Error("SIMULATOR_RESEARCH_NETWORK_FAILED", { cause: error });
    current = details.cause;
  }
  if (error instanceof Error && /^page\.goto: net::ERR_(?:NAME_NOT_RESOLVED|TIMED_OUT|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_CLOSED|INTERNET_DISCONNECTED)\b/u.test(error.message)) return new Error("SIMULATOR_RESEARCH_NETWORK_FAILED", { cause: error });
  return error;
}

/** Caller owns and revalidates the simulator claim before/after this bounded public read. */
export async function collectSimulatorSupportResearch(input: { url: string; render?: boolean }, dependencies: SimulatorResearchDependencies = {}): Promise<SimulatorResearchResult> {
  const result = await collectOwnedSimulatorSupportResearch(input, dependencies);
  return { ...result, accessControlsObserved: true, accessControls: result.accessControls ?? [] };
}

async function collectOwnedSimulatorSupportResearch(input: { url: string; render?: boolean }, dependencies: SimulatorResearchDependencies): Promise<SimulatorResearchResult> {
  const requestedUrl = publicUrl(input.url).href;
  const now = dependencies.now ?? (() => new Date());
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const lease = dependencies.lease ?? runWithProviderRequestLease;
  const read = async (url: string, method: "GET" | "HEAD" = "GET", headers?: Record<string, string>, scopedRoot = requestedUrl, extraGuard?: (url: URL) => boolean, maxBodyBytes = MAX_BODY_BYTES) => {
    const safe = publicUrl(url);
    const allowed = (url: URL) => sameOfficialHost(scopedRoot, url.href) && (!extraGuard || extraGuard(url));
    if (!allowed(safe)) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
    const fetchImpl = dependencies.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
      const parsed = publicUrl(value);
      if (!allowed(parsed)) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      return parsed;
    }, maxResponseBytes: maxBodyBytes, redirectLimit: 4, timeoutMs: 10_000 });
    const acquired = await lease(safe.hostname, async () => {
      if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
      let response: Response;
      try { response = await fetchImpl(safe.href, { method, redirect: "manual", credentials: "omit", cache: "no-store", headers: headers ?? { Accept: "text/html,application/xhtml+xml,application/json" }, signal: deadline }); }
      catch (error) {
        const diagnostic = !dependencies.fetch ? getOwnedOfficialSiteBodyLimitDiagnostic(error) : null;
        if (diagnostic && error && typeof error === "object") ownedPerResponseBodyLimits.set(error, diagnostic);
        throw knownPublicNetworkError(tagSimulatorResearchFailure(error, "HTTP_READ"));
      }
      const effective = publicUrl(response.url || safe.href).href;
      if (!allowed(new URL(effective))) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      const location = response.status >= 300 && response.status < 400 && response.headers.get("location") ? publicUrl(new URL(response.headers.get("location")!, effective).href).href : undefined;
      if (location && !allowed(new URL(location))) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      const cors = response.headers.get("access-control-allow-origin");
      let publicCors: string | undefined;
      if (cors === "*") publicCors = cors;
      else if (cors) { try { if (sameOfficialHost(requestedUrl, cors) && new URL(cors).origin === cors) publicCors = cors; } catch { /* Never forward an unproven header value. */ } }
      let body: Buffer;
      try { body = await beforeDeadline(boundedBody(response, maxBodyBytes), deadline); } catch (error) { throw knownPublicNetworkError(tagSimulatorResearchFailure(error, "HTTP_READ")); }
      return { url: effective, status: response.status, location, publicCors, contentType: response.headers.get("content-type") ?? "", body };
    });
    if (!acquired.acquired) throw new Error("SIMULATOR_RESEARCH_PROVIDER_BUSY");
    return acquired.value;
  };
  if (!input.render) {
    let url = requestedUrl;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const readResult = await read(url).catch(error => { throw tagSimulatorResearchResourceKind(error, "MAIN_DOCUMENT"); });
      if (readResult.location) { if (redirects === 4) throw new Error("SIMULATOR_RESEARCH_REDIRECT_LIMIT"); url = readResult.location; continue; }
      const result = resultFromBody(requestedUrl, readResult.url, readResult.status, readResult.contentType, readResult.body, now());
      const controls = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(readResult.contentType) ? detectSimulatorResearchAccessControls(readResult.body.toString("utf8")) : [];
      return controls.length ? { ...result, text: "", links: [], bookingLinks: undefined, calendar: undefined, publicConfiguration: undefined, jsonShape: undefined, configurationDiagnostic: undefined, accessControls: controls } : result;
    }
    throw new Error("SIMULATOR_RESEARCH_REDIRECT_LIMIT");
  }
  const launch = dependencies.browser ?? (async () => (await import("@playwright/test")).chromium.launch({ headless: true, timeout: 10_000 }));
  let launchPromise: Promise<ResearchBrowser> | undefined;
  let browser: ResearchBrowser;
  try { launchPromise = launch(); browser = await beforeDeadline(launchPromise, deadline); }
  catch (error) {
    void launchPromise?.then(value => value.close()).catch(() => undefined);
    throw tagSimulatorResearchFailure(error, "BROWSER_LAUNCH");
  }
  let context: Awaited<ReturnType<ResearchBrowser["newContext"]>> | undefined;
  let requestCount = 0, responseBytes = 0, blockedRequests = 0, routeFailure: unknown, hasRouteFailure = false;
  let navigation: Awaited<ReturnType<typeof read>> | undefined;
  let safeMainDocument: Awaited<ReturnType<typeof read>> & { observedAt: Date } | undefined;
  let terminalMainDocument: Awaited<ReturnType<typeof read>> & { observedAt: Date } | undefined;
  let secondaryBudgetExhausted = false;
  let secondaryAssetBodyLimitExceeded = false;
  let secondaryStylesheetUrlRejected = false;
  const bodyLimitDiagnostics: SimulatorBodyLimitDiagnostic[] = [];
  const blockedRequestDiagnostics: SimulatorBlockedRequestDiagnostic[] = [];
  let blockedRequestDiagnosticsTruncated = false;
  const blockedRequestFields = () => blockedRequestDiagnostics.length ? {
    blockedRequestDiagnostics,
    ...(blockedRequestDiagnosticsTruncated ? { blockedRequestDiagnosticsTruncated: true as const } : {}),
  } : {};
  const recordBlockedMethod = (rawUrl: string, kind: string, rawMethod: string) => {
    if ((kind !== "xhr" && kind !== "fetch") || rawMethod === "GET" || rawMethod === "HEAD") return;
    let url: URL;
    try { url = new URL(rawUrl); } catch { return; }
    if (!(["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      url.origin === new URL(navigation?.url ?? requestedUrl).origin)) return;
    const method = (["POST", "PUT", "PATCH", "DELETE"].includes(rawMethod) ? rawMethod : "OTHER") as SimulatorBlockedRequestDiagnostic["method"];
    const pathShape = blockedRequestPathShape(url);
    const existing = blockedRequestDiagnostics.find(entry => entry.resourceKind === kind.toUpperCase() &&
      entry.method === method && entry.pathShape === pathShape);
    if (existing) {
      if (blockedRequestDiagnostics.reduce((sum, entry) => sum + entry.count, 0) >= MAX_REQUESTS) blockedRequestDiagnosticsTruncated = true;
      else existing.count += 1;
      return;
    }
    if (blockedRequestDiagnostics.length === 8 || blockedRequestDiagnostics.reduce((sum, entry) => sum + entry.count, 0) >= MAX_REQUESTS) {
      blockedRequestDiagnosticsTruncated = true; return;
    }
    blockedRequestDiagnostics.push({ state: "NOT_EXECUTED", resourceKind: kind.toUpperCase() as "XHR" | "FETCH",
      method, reason: "METHOD_NOT_ALLOWED", pathShape, count: 1 });
  };
  let bodyLimitDiagnosticsTruncated = false;
  const recordBodyLimit = (resourceKind: SimulatorBodyLimitDiagnostic["resourceKind"], diagnostic: OwnedCollectorBodyLimitDiagnostic) => {
    const existing = bodyLimitDiagnostics.find(entry => entry.resourceKind === resourceKind && entry.phase === diagnostic.phase &&
      entry.observedSizeBand === diagnostic.observedSizeBand);
    if (existing) { existing.count = Math.min(MAX_REQUESTS, existing.count + 1); return; }
    if (bodyLimitDiagnostics.length === 8) { bodyLimitDiagnosticsTruncated = true; return; }
    bodyLimitDiagnostics.push({ resourceKind, ...diagnostic, count: 1 });
  };
  const bodyLimitFields = (warning: NonNullable<SimulatorResearchResult["renderWarning"]>) =>
    warning.startsWith("SECONDARY_") && bodyLimitDiagnostics.length
      ? { bodyLimitDiagnostics, ...(bodyLimitDiagnosticsTruncated ? { bodyLimitDiagnosticsTruncated: true as const } : {}) } : {};
  const activeRoutes = new Set<Promise<void>>();
  let renderedReadTail: Promise<unknown> = Promise.resolve();
  let page: ResearchPage | undefined;
  const accessControls = new Set<NonNullable<SimulatorResearchResult["accessControls"]>[number]>();
  const responseContracts: NonNullable<SimulatorResearchResult["responseContracts"]> = [];
  const assets = new Map<string, string>();
  let assetsObserved = false;
  let contractSlug = publicVenueSlug(requestedUrl);
  // Serialize transport and accounting together so every host shares one page budget.
  const cappedSecondaryAsset = Symbol("CAPPED_SECONDARY_ASSET");
  const rejectedSecondaryStylesheet = Symbol("REJECTED_SECONDARY_STYLESHEET");
  const skippedAfterTerminalMain = Symbol("SKIPPED_AFTER_TERMINAL_MAIN");
  const readRendered = (resourceKind: SimulatorResearchResourceKind, isSecondaryAsset: boolean, ...args: Parameters<typeof read>) => {
    const operation = renderedReadTail.catch(() => undefined).then(async () => {
      if (terminalMainDocument) return skippedAfterTerminalMain;
      if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
      if (hasRouteFailure) throw routeFailure;
      const remainingBytes = MAX_RENDER_BYTES - responseBytes;
      const resourceCeiling = resourceKind === "SECONDARY_SCRIPT" && isSecondaryAsset && safeMainDocument ? MAX_RENDER_BYTES : MAX_BODY_BYTES;
      const maxBodyBytes = Math.min(resourceCeiling, remainingBytes);
      if (maxBodyBytes <= 0) {
        routeFailure = tagSimulatorResearchResourceKind(new Error("SIMULATOR_RESEARCH_BODY_LIMIT"), resourceKind);
        hasRouteFailure = true;
        throw routeFailure;
      }
      try {
        const response = await read(args[0], args[1], args[2], args[3], args[4], maxBodyBytes);
        responseBytes += response.body.length;
        return response;
      }
      catch (error) {
        const tagged = tagSimulatorResearchResourceKind(error, resourceKind);
        if (resourceKind === "SECONDARY_STYLESHEET" && isSecondaryAsset && safeMainDocument && isOwnedUnsafeUrlError(tagged) && !hasRouteFailure) {
          // The pinned transport may have downloaded the response before its
          // effective URL or redirect was rejected. Charge its full admitted cap.
          responseBytes += maxBodyBytes;
          if (maxBodyBytes < resourceCeiling) {
            routeFailure = tagSimulatorResearchResourceKind(new Error("SIMULATOR_RESEARCH_BODY_LIMIT"), resourceKind);
            hasRouteFailure = true;
            throw routeFailure;
          }
          secondaryStylesheetUrlRejected = true;
          return rejectedSecondaryStylesheet;
        }
        const bodyLimit = ownedPerResponseBodyLimit(tagged);
        if (isSecondaryAsset && safeMainDocument && bodyLimit && !hasRouteFailure) {
          // Charge rejected bytes conservatively; exhausting the page budget is fatal.
          responseBytes += maxBodyBytes;
          if (maxBodyBytes < resourceCeiling) {
            routeFailure = tagSimulatorResearchResourceKind(new Error("SIMULATOR_RESEARCH_BODY_LIMIT"), resourceKind);
            hasRouteFailure = true;
            throw routeFailure;
          }
          secondaryAssetBodyLimitExceeded = true;
          if (resourceKind === "SECONDARY_SCRIPT" || resourceKind === "SECONDARY_STYLESHEET") recordBodyLimit(resourceKind, bodyLimit);
          return cappedSecondaryAsset;
        }
        if (!hasRouteFailure) { routeFailure = tagged; hasRouteFailure = true; }
        throw routeFailure;
      }
    });
    renderedReadTail = operation;
    return beforeDeadline(operation, deadline);
  };
  const partialMainDocument = (warning: NonNullable<SimulatorResearchResult["renderWarning"]>): SimulatorResearchResult => {
    try {
      if (!safeMainDocument) throw new Error("SIMULATOR_RESEARCH_REQUEST_LIMIT");
      const main = safeMainDocument;
      const facts = resultFromBody(requestedUrl, main.url, main.status, main.contentType, main.body, main.observedAt);
      // These are bounded inert facts from the already validated main HTML.
      // A rejected stylesheet cannot invalidate them or prove rendering completed.
      return { ...facts, method: "BROWSER",
        renderComplete: false, renderWarning: warning, contentProvenance: "MAIN_DOCUMENT_HTTP",
        blockedRequests, admittedRequests: requestCount, ...bodyLimitFields(warning), ...blockedRequestFields() };
    } catch (error) { throw tagSimulatorResearchFailure(error, "BROWSER_DOCUMENT"); }
  };
  const terminalMainObservation = (): SimulatorResearchResult => {
    try {
      if (!terminalMainDocument || !page || !sameOfficialHost(requestedUrl, publicUrl(page.url()).href)) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      return { requestedUrl, url: terminalMainDocument.url, observedAt: terminalMainDocument.observedAt.toISOString(),
        httpStatus: terminalMainDocument.status, text: "", links: [], method: "BROWSER",
        blockedRequests, admittedRequests: requestCount, renderComplete: false,
        renderWarning: "MAIN_DOCUMENT_HTTP_ERROR", contentProvenance: "MAIN_DOCUMENT_HTTP",
        ...(accessControls.size ? { accessControls: [...accessControls] } : {}) };
    } catch (error) { throw tagSimulatorResearchFailure(error, "BROWSER_DOCUMENT"); }
  };
  const settleStartedRoutes = async () => {
    try {
      if (!activeRoutes.size) { if (hasRouteFailure) throw routeFailure; return; }
      const results = await beforeDeadline(Promise.allSettled([...activeRoutes]), deadline);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      if (hasRouteFailure) throw routeFailure;
    } catch (error) { throw tagSimulatorResearchFailure(error, "BROWSER_REQUEST"); }
  };
  try {
    if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
    context = await researchOperation("BROWSER_CONTEXT", () => beforeDeadline(browser.newContext({ serviceWorkers: "block", storageState: { cookies: [], origins: [] }, acceptDownloads: false, javaScriptEnabled: true }), deadline));
    await researchOperation("BROWSER_ROUTE_SETUP", () => context!.routeWebSocket("**/*", route => route.close({ code: 1008, reason: "Public research does not use sockets" })));
    await researchOperation("BROWSER_ROUTE_SETUP", () => context!.route("**/*", async (route: Route) => {
      const operation = (async () => {
        const request = route.request();
        try {
          const method = request.method();
          const kind = request.resourceType();
          recordBlockedMethod(request.url(), kind, method);
          const headers = new Headers(await request.allHeaders());
          const url = publicUrl(request.url());
          const resourceKind: SimulatorResearchResourceKind = request.isNavigationRequest() && request.frame() === page?.mainFrame()
            ? "MAIN_DOCUMENT" : kind === "document" ? "SECONDARY_DOCUMENT" : kind === "script" ? "SECONDARY_SCRIPT"
              : kind === "stylesheet" ? "SECONDARY_STYLESHEET" : kind === "xhr" || kind === "fetch" ? "XHR_OR_FETCH" : "OTHER";
          const assetRoot = ["script", "stylesheet"].includes(kind) ? assets.get(url.href) : undefined;
          const occupancy = method === "GET" && publicOccupancyUrl(url, contractSlug);
          if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(kind) || !["GET", "HEAD"].includes(method) || [...headers.keys()].some(key => /authorization|cookie|token|api.?key|secret|credential/iu.test(key)) ||
              (["script", "stylesheet"].includes(kind) && /captcha|challenge|turnstile|cdn-cgi/iu.test(`${url.hostname}${url.pathname}`)) ||
              (!sameOfficialHost(requestedUrl, url.href) && !assetRoot && !occupancy)) { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
          if (terminalMainDocument) { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
          if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
          if (requestCount >= MAX_REQUESTS) { secondaryBudgetExhausted = true; blockedRequests += 1; await route.abort("blockedbyclient"); return; }
          requestCount += 1;
          const publicHeaders: Record<string, string> = {};
          for (const key of ["accept", "accept-language", "user-agent"]) if (headers.has(key)) publicHeaders[key] = headers.get(key)!;
          if (headers.get("origin") === new URL(navigation?.url ?? requestedUrl).origin) publicHeaders.origin = headers.get("origin")!;
          const response = await readRendered(resourceKind, (kind === "script" || kind === "stylesheet") && !request.isNavigationRequest(),
            url.href, request.method() as "GET" | "HEAD", publicHeaders,
            assetRoot ?? (occupancy ? url.href : requestedUrl), occupancy ? target => publicOccupancyUrl(target, contractSlug) : undefined)
            .catch(error => { throw tagSimulatorResearchResourceKind(error, resourceKind); });
          if (response === cappedSecondaryAsset || response === rejectedSecondaryStylesheet || response === skippedAfterTerminalMain) {
            if (response === skippedAfterTerminalMain) requestCount -= 1;
            blockedRequests += 1;
            await route.abort("blockedbyclient");
            return;
          }
          if (assetRoot && response.location) assets.set(response.location, assetRoot);
          if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) navigation = response;
          const terminalMain = !safeMainDocument && request.isNavigationRequest() && request.frame() === page?.mainFrame() && response.status >= 400 && response.status <= 599;
          if (terminalMain) terminalMainDocument = { ...response, observedAt: now() };
          const controls = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.contentType) ? detectSimulatorResearchAccessControls(response.body.toString("utf8")) : [];
          controls.forEach(control => accessControls.add(control));
          if (terminalMain) { await route.fulfill({ status: response.status, body: "", headers: { "content-type": "text/plain" } }); return; }
          if (controls.length) { await route.fulfill({ status: response.status, body: "Public source requires interactive access.", headers: { "content-type": "text/plain" } }); return; }
          if (!assetsObserved && request.isNavigationRequest() && request.frame() === page?.mainFrame() && response.status >= 200 && response.status < 300 && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.contentType)) {
            assetsObserved = true;
            safeMainDocument = { ...response, observedAt: now() };
            for (const asset of publicAssetDestinations(response.body.toString("utf8"), response.url)) assets.set(asset, asset);
            contractSlug ??= publishedYourGolfBookingSlug(response.body.toString("utf8"), response.url);
          }
          if (["xhr", "fetch"].includes(kind) && response.contentType.includes("application/json") && responseContracts.length < 8) {
            try { responseContracts.push({ ...contractPath(url), httpStatus: response.status, shape: summarizeSimulatorPublicJsonShape(JSON.parse(response.body.toString("utf8"))) }); } catch { /* Invalid JSON is not a contract. */ }
          }
          await route.fulfill({ status: response.status, body: response.body, headers: { "content-type": response.contentType, ...(response.location ? { location: response.location } : {}), ...(response.publicCors ? { "access-control-allow-origin": response.publicCors } : {}) } });
        } catch (error) {
          if (isOwnedUnsafeUrlError(error)) { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
          if (!hasRouteFailure) { routeFailure = tagSimulatorResearchFailure(error, "BROWSER_REQUEST"); hasRouteFailure = true; }
          blockedRequests += 1;
          await route.abort("blockedbyclient");
        }
      })().catch(error => {
        const tagged = tagSimulatorResearchFailure(error, "BROWSER_REQUEST");
        if (!hasRouteFailure) { routeFailure = tagged; hasRouteFailure = true; }
        throw routeFailure;
      });
      activeRoutes.add(operation);
      try { await operation; } finally { activeRoutes.delete(operation); }
    }));
    page = await researchOperation("BROWSER_CONTEXT", () => beforeDeadline(context!.newPage(), deadline));
    let response: Awaited<ReturnType<ResearchPage["goto"]>>;
    try { response = await beforeDeadline(page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: DEADLINE_MS }), deadline); }
    catch (error) {
      if (hasRouteFailure) throw routeFailure;
      const expectedIncomplete = error instanceof Error && (error.name === "TimeoutError" || error.message === "SIMULATOR_RESEARCH_DEADLINE" || /^page\.goto: net::ERR_(?:ABORTED|BLOCKED_BY_CLIENT)\b/u.test(error.message));
      if (terminalMainDocument && expectedIncomplete) {
        await settleStartedRoutes();
        if (hasRouteFailure) throw routeFailure;
        return terminalMainObservation();
      }
      // A tooling bound or owned stylesheet rejection can preserve public HTTP facts. It cannot
      // turn an unrelated browser, parser, authority or lease failure into evidence.
      if (!(secondaryBudgetExhausted || secondaryAssetBodyLimitExceeded || secondaryStylesheetUrlRejected) || !safeMainDocument || (accessControls.size && !secondaryStylesheetUrlRejected) || !expectedIncomplete) throw tagSimulatorResearchFailure(error, "BROWSER_NAVIGATION");
      await settleStartedRoutes();
      if (hasRouteFailure) throw routeFailure;
      if (accessControls.size) return { requestedUrl, url: safeMainDocument.url, observedAt: now().toISOString(), httpStatus: safeMainDocument.status, text: "", links: [], method: "BROWSER", accessControls: [...accessControls], blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" };
      return partialMainDocument(secondaryStylesheetUrlRejected ? "SECONDARY_STYLESHEET_URL_REJECTED" : secondaryAssetBodyLimitExceeded ? "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" : "SECONDARY_REQUEST_BUDGET_EXHAUSTED");
    }
    await settleStartedRoutes();
    if (hasRouteFailure) throw routeFailure;
    if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
    try {
      const url = publicUrl(page.url()).href;
      if (!sameOfficialHost(requestedUrl, url) || !navigation) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      if (terminalMainDocument) return terminalMainObservation();
      if (accessControls.size) return { requestedUrl, url, observedAt: now().toISOString(), httpStatus: navigation.status, text: "", links: [], method: "BROWSER", accessControls: [...accessControls], blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" };
      if (secondaryBudgetExhausted) return partialMainDocument(
        secondaryStylesheetUrlRejected ? "SECONDARY_STYLESHEET_URL_REJECTED" : secondaryAssetBodyLimitExceeded ? "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" : "SECONDARY_REQUEST_BUDGET_EXHAUSTED");
      const html = await beforeDeadline(page.content(), deadline);
      if (hasRouteFailure) throw routeFailure;
      if (Buffer.byteLength(html, "utf8") > MAX_BODY_BYTES) throw new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
      const renderedControls = detectSimulatorResearchAccessControls(html);
      if (renderedControls.length) return { requestedUrl, url, observedAt: now().toISOString(), httpStatus: navigation.status, text: "", links: [], method: "BROWSER", accessControls: renderedControls, blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "RENDERED_DOM" };
      const rendered = resultFromBody(requestedUrl, url, response?.status() ?? navigation.status, "text/html", Buffer.from(html), now());
      const renderWarning = secondaryStylesheetUrlRejected ? "SECONDARY_STYLESHEET_URL_REJECTED" as const
        : secondaryAssetBodyLimitExceeded ? "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const : undefined;
      if (safeMainDocument && hasEmptyClientAppRoot(safeMainDocument.body.toString("utf8")) &&
          !hasVisibleBodyContent(html)) {
        // An empty client shell does not prove that undeclared browser chunks
        // rendered the published site. Keep inert main-document facts for the
        // next bounded source read without claiming a complete browser render.
        return { ...resultFromBody(requestedUrl, safeMainDocument.url, safeMainDocument.status,
          safeMainDocument.contentType, safeMainDocument.body, safeMainDocument.observedAt),
          method: "BROWSER", blockedRequests, admittedRequests: requestCount, ...blockedRequestFields(),
          renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP",
          ...(renderWarning ? { renderWarning, ...bodyLimitFields(renderWarning) } : {}),
          ...(responseContracts.length ? { responseContracts } : {}) };
      }
      // A rejected/capped leaf stays unavailable to the browser. Other independently
      // admitted reads and the bounded observed DOM remain useful discovery evidence;
      // neither proves that the page or calendar rendered completely.
      return { ...rendered, method: "BROWSER", blockedRequests, admittedRequests: requestCount, ...blockedRequestFields(), renderComplete: !renderWarning,
        contentProvenance: "RENDERED_DOM", ...(renderWarning ? { renderWarning, ...bodyLimitFields(renderWarning) } : {}),
        ...(responseContracts.length ? { responseContracts } : {}) };
    } catch (error) { throw tagSimulatorResearchFailure(error, "BROWSER_DOCUMENT"); }
  } catch (error) { throw hasRouteFailure ? routeFailure : knownPublicNetworkError(error); }
  finally {
    const cleanupSignal = AbortSignal.timeout(2_000);
    await Promise.allSettled([beforeDeadline(context?.close() ?? Promise.resolve(), cleanupSignal), beforeDeadline(browser.close(), cleanupSignal)]);
  }
}
