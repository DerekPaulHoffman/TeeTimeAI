import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { BrowserContext, BrowserContextOptions, Page, Route } from "@playwright/test";
import { createAddressPinnedPublicFetchTransport, isOwnedOfficialSiteBodyLimitError } from "./address-pinned-public-fetch";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { sanitizeResponderText } from "./course-support-responder-policy";
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
  venue: { id: string; slug: string; timeZone: string; status: string; maintenanceMode: boolean };
  ranges: Array<{ id: string; venueId: string; slug: string; bookable: boolean; slotDurationMinutes: number; slotIntervalMinutes: number; slotIntervalStart: number; assumeOpen: boolean; bookingUi: string; customerBookingUi: string; maxBookAheadValue: number; maxBookAheadUnit: string; openingHours: string; hasOpeningTimeRestrictions: boolean }>;
  rentals: Array<{ id: string; venueId: string; name: string; type: "simulator"; category: "baytime"; adminOnly: false; disabled: boolean; waitlisted: boolean; duration: number; durationType: string; minDurationSlots: number; maxDurationSlots: number; minPlayers: number | null; maxPlayers: number | null; bufferMinutes: number; hasRestrictions: boolean; requiresPerks: boolean }>;
  resources: Array<{ id: string; venueId: string; rangeId: string; type: "simulator"; bookable: boolean; optionIds: string[]; appliedOptionIds: string[]; hasRestrictedTimes: boolean }>;
};
export type SimulatorResearchResult = {
  requestedUrl: string; url: string; observedAt: string; httpStatus: number; text: string; links: string[];
  method: "HTTP" | "BROWSER"; initialHttpStatus?: number;
  bookingLinks?: string[];
  calendar?: SimulatorPublicCalendar;
  jsonShape?: Array<{ path: string; type: string; count?: number }>;
  blockedRequests?: number;
  admittedRequests?: number;
  renderComplete?: boolean;
  renderWarning?: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" | "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED";
  contentProvenance?: "MAIN_DOCUMENT_HTTP" | "RENDERED_DOM";
  accessControls?: Array<"CAPTCHA_OR_CHALLENGE" | "ACCOUNT_REQUIRED" | "QUEUE">;
  accessControlsObserved?: true;
  responseContracts?: Array<{ pathShape: string; queryKeys: string[]; httpStatus: number; shape: NonNullable<SimulatorResearchResult["jsonShape"]> }>;
};

function publicUrl(value: unknown) {
  const safe = getSafeCustomerBookingUrl(value);
  if (!safe) throw new Error("SIMULATOR_RESEARCH_UNSAFE_URL");
  return new URL(safe);
}

const ownedPerResponseBodyLimits = new WeakSet<object>();
function ownBodyLimitError() {
  const error = new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
  ownedPerResponseBodyLimits.add(error);
  return error;
}
function isOwnedPerResponseBodyLimit(error: unknown) {
  return error !== null && typeof error === "object" && ownedPerResponseBodyLimits.has(error);
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

function record(value: unknown): Json { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONFIG_SHAPE"); return value as Json; }
function number(value: unknown, min = 0, max = 1_000_000_000) { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error("CONFIG_NUMBER"); return Number(value); }
function id(value: unknown) { return String(number(value, 1)); }
function string(value: unknown, max = 80) { if (typeof value !== "string" || value.length > max || /[<>\r\n\x00-\x1f]/u.test(value)) throw new Error("CONFIG_STRING"); return value; }
function bool(value: unknown) { if (typeof value !== "boolean") throw new Error("CONFIG_BOOLEAN"); return value; }
function array(value: unknown, max = 100): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error("CONFIG_ARRAY"); return value; }
function optionalNumber(value: unknown, max = 20) { return value === null || value === undefined ? null : number(value, 1, max); }

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
    return venue.slug === slug && venue.status === "live" && venue.maintenanceMode === false ? slug : undefined;
  } catch { return undefined; }
}

/** Parse published inert JSON only. Never evaluate inline scripts or retain the original state. */
export function extractSimulatorPublicCalendar(html: string, sourceUrl: string): Pick<SimulatorResearchResult, "calendar" | "jsonShape"> {
  const parsed = readInertNextData(html);
  if (parsed === undefined) return {};
  const shape = { jsonShape: summarizeSimulatorPublicJsonShape(parsed) };
  try {
    const url = publicUrl(sourceUrl);
    const slug = publicVenueSlug(sourceUrl, true);
    if (!slug || url.search || url.hash) return shape;
    const config = record(record(record(record(parsed).props).pageProps).initialReduxState);
    const venue = record(config.venue), bays = record(config.bays);
    const venueId = id(venue.id), venueSlug = string(venue.slug), timeZone = string(venue.timezone);
    if (venueSlug !== slug) return shape;
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    const ranges = array(record(config.ranges).items, 20).map(value => {
      const row = record(value);
      if (id(row.venue) !== venueId) throw new Error("CONFIG_IDENTITY");
      return { id: id(row.id), venueId, slug: string(row.slug), bookable: bool(row.bookable), slotDurationMinutes: number(row.slotDuration, 1, 240), slotIntervalMinutes: number(row.slotInterval, 1, 240), slotIntervalStart: number(row.slotIntervalStart, 0, 1440), assumeOpen: bool(row.assumeOpen), bookingUi: string(row.bookingUi), customerBookingUi: string(row.customerBookingUi), maxBookAheadValue: number(row.maxBookAheadValue, 1, 365), maxBookAheadUnit: string(row.maxBookAheadUnit), openingHours: string(row.openingHours, 2000), hasOpeningTimeRestrictions: array(row.openingTimes).length > 0 };
    });
    const rentals = array(bays.bayOptions).flatMap(value => {
      const row = record(value);
      if (row.adminOnly !== false || row.type !== "simulator" || row.category !== "baytime" || id(row.venue) !== venueId) return [];
      return [{ id: id(row.id), venueId, name: string(row.name), type: "simulator" as const, category: "baytime" as const, adminOnly: false as const, disabled: bool(row.disabled), waitlisted: bool(row.waitlisted), duration: number(row.duration, 1, 48), durationType: string(row.durationType), minDurationSlots: number(row.minBookingDuration, 1, 48), maxDurationSlots: number(row.maxBookingDuration, 1, 48), minPlayers: optionalNumber(row.minPlayers), maxPlayers: optionalNumber(row.maxPlayers), bufferMinutes: number(row.bufferPeriodMinutes, 0, 1440), hasRestrictions: array(row.restrictions).length > 0, requiresPerks: array(row.appliedRequiredPerks, 20).length > 0 }];
    });
    const resourceRows = array(bays.items).map(record).filter(row => row.type === "simulator");
    if (resourceRows.length > 40) return shape;
    const resources = resourceRows.map(row => {
      if (id(row.venue) !== venueId || !ranges.some(range => range.id === id(row.range))) throw new Error("CONFIG_IDENTITY");
      return { id: id(row.id), venueId, rangeId: id(row.range), type: "simulator" as const, bookable: bool(row.bookable), optionIds: array(row.options).map(id).filter(value => rentals.some(rental => rental.id === value)), appliedOptionIds: array(row.appliedOptions).map(id).filter(value => rentals.some(rental => rental.id === value)), hasRestrictedTimes: array(row.restrictedTimes).length > 0 };
    });
    if (!ranges.length || !rentals.length || !resources.length || [ranges, rentals, resources].some(rows => new Set(rows.map(row => row.id)).size !== rows.length)) return shape;
    return { calendar: { family: "YOUR_GOLF_BOOKING", venue: { id: venueId, slug, timeZone, status: string(venue.status), maintenanceMode: bool(venue.maintenanceMode) }, ranges, rentals, resources } };
  } catch { return shape; }
}

async function boundedBody(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) throw ownBodyLimitError();
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw ownBodyLimitError(); } chunks.push(value); } }
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
  const bookingLinks = publicBookingLinkRoles(html, url, summary.links);
  const slug = publicVenueSlug(url) ?? publishedYourGolfBookingSlug(html, url);
  // This is the platform's fixed public configuration route. It is a
  // research destination, never evidence of inventory or runnable monitoring.
  if (slug && /\/booking\/?$/u.test(new URL(url).pathname)) {
    const bays = `${new URL(url).origin}/venues/${slug}/booking/bays`;
    summary.links = [...new Set([bays, ...summary.links])].slice(0, 30);
    bookingLinks.unshift(bays);
  }
  return { ...base, ...summary, ...(bookingLinks.length ? { bookingLinks: [...new Set(bookingLinks)].slice(0, 30) } : {}), ...extractSimulatorPublicCalendar(html, url) };
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
  const read = async (url: string, method: "GET" | "HEAD" = "GET", headers?: Record<string, string>, scopedRoot = requestedUrl, extraGuard?: (url: URL) => boolean) => {
    const safe = publicUrl(url);
    const allowed = (url: URL) => sameOfficialHost(scopedRoot, url.href) && (!extraGuard || extraGuard(url));
    if (!allowed(safe)) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
    const fetchImpl = dependencies.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
      const parsed = publicUrl(value);
      if (!allowed(parsed)) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      return parsed;
    }, maxResponseBytes: MAX_BODY_BYTES, redirectLimit: 4, timeoutMs: 10_000 });
    const acquired = await lease(safe.hostname, async () => {
      if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
      let response: Response;
      try { response = await fetchImpl(safe.href, { method, redirect: "manual", credentials: "omit", cache: "no-store", headers: headers ?? { Accept: "text/html,application/xhtml+xml,application/json" }, signal: deadline }); }
      catch (error) {
        if (!dependencies.fetch && isOwnedOfficialSiteBodyLimitError(error) && error && typeof error === "object") ownedPerResponseBodyLimits.add(error);
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
      try { body = await beforeDeadline(boundedBody(response), deadline); } catch (error) { throw knownPublicNetworkError(tagSimulatorResearchFailure(error, "HTTP_READ")); }
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
      return controls.length ? { ...result, text: "", links: [], bookingLinks: undefined, calendar: undefined, jsonShape: undefined, accessControls: controls } : result;
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
  let secondaryBudgetExhausted = false;
  let secondaryAssetBodyLimitExceeded = false;
  const activeRoutes = new Set<Promise<void>>();
  const hostReads = new Map<string, Promise<unknown>>();
  let page: ResearchPage | undefined;
  const accessControls = new Set<NonNullable<SimulatorResearchResult["accessControls"]>[number]>();
  const responseContracts: NonNullable<SimulatorResearchResult["responseContracts"]> = [];
  const assets = new Map<string, string>();
  let assetsObserved = false;
  let contractSlug = publicVenueSlug(requestedUrl);
  // A rendered page must not compete with its own requests for a hostname lease.
  const cappedSecondaryAsset = Symbol("CAPPED_SECONDARY_ASSET");
  const skippedAfterAssetLimit = Symbol("SKIPPED_AFTER_ASSET_LIMIT");
  const readRendered = (resourceKind: SimulatorResearchResourceKind, isSecondaryAsset: boolean, ...args: Parameters<typeof read>) => {
    const hostname = new URL(args[0]).hostname;
    const operation = (hostReads.get(hostname) ?? Promise.resolve()).then(async () => {
      if (secondaryAssetBodyLimitExceeded) return skippedAfterAssetLimit;
      if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
      if (hasRouteFailure) throw routeFailure;
      try { return await read(...args); }
      catch (error) {
        const tagged = tagSimulatorResearchResourceKind(error, resourceKind);
        if (isSecondaryAsset && safeMainDocument && isOwnedPerResponseBodyLimit(tagged) && !hasRouteFailure) {
          // Charge the existing full per-response cap for bytes rejected by transport.
          responseBytes += MAX_BODY_BYTES;
          if (responseBytes > MAX_RENDER_BYTES) {
            routeFailure = tagSimulatorResearchResourceKind(new Error("SIMULATOR_RESEARCH_BODY_LIMIT"), resourceKind);
            hasRouteFailure = true;
            throw routeFailure;
          }
          secondaryAssetBodyLimitExceeded = true;
          return cappedSecondaryAsset;
        }
        if (!hasRouteFailure) { routeFailure = tagged; hasRouteFailure = true; }
        throw routeFailure;
      }
    });
    hostReads.set(hostname, operation);
    const clear = () => { if (hostReads.get(hostname) === operation) hostReads.delete(hostname); };
    void operation.then(clear, clear);
    return beforeDeadline(operation, deadline);
  };
  const partialMainDocument = (warning: NonNullable<SimulatorResearchResult["renderWarning"]>): SimulatorResearchResult => {
    try {
      if (!safeMainDocument) throw new Error("SIMULATOR_RESEARCH_REQUEST_LIMIT");
      const main = safeMainDocument;
      return { ...resultFromBody(requestedUrl, main.url, main.status, main.contentType, main.body, main.observedAt), method: "BROWSER",
        renderComplete: false, renderWarning: warning, contentProvenance: "MAIN_DOCUMENT_HTTP",
        blockedRequests, admittedRequests: requestCount };
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
          const headers = new Headers(await request.allHeaders());
          const url = publicUrl(request.url());
          const kind = request.resourceType();
          const resourceKind: SimulatorResearchResourceKind = request.isNavigationRequest() && request.frame() === page?.mainFrame()
            ? "MAIN_DOCUMENT" : kind === "document" ? "SECONDARY_DOCUMENT" : kind === "script" ? "SECONDARY_SCRIPT"
              : kind === "stylesheet" ? "SECONDARY_STYLESHEET" : kind === "xhr" || kind === "fetch" ? "XHR_OR_FETCH" : "OTHER";
          const assetRoot = ["script", "stylesheet"].includes(kind) ? assets.get(url.href) : undefined;
          const occupancy = request.method() === "GET" && publicOccupancyUrl(url, contractSlug);
          if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(kind) || !["GET", "HEAD"].includes(request.method()) || [...headers.keys()].some(key => /authorization|cookie|token|api.?key|secret|credential/iu.test(key)) ||
              (["script", "stylesheet"].includes(kind) && /captcha|challenge|turnstile|cdn-cgi/iu.test(`${url.hostname}${url.pathname}`)) ||
              (!sameOfficialHost(requestedUrl, url.href) && !assetRoot && !occupancy)) { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
          if (secondaryAssetBodyLimitExceeded) { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
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
          if (response === cappedSecondaryAsset || response === skippedAfterAssetLimit) {
            if (response === skippedAfterAssetLimit) requestCount -= 1;
            blockedRequests += 1;
            await route.abort("blockedbyclient");
            return;
          }
          if (assetRoot && response.location) assets.set(response.location, assetRoot);
          responseBytes += response.body.length;
          if (responseBytes > MAX_RENDER_BYTES) throw new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
          if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) navigation = response;
          const controls = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.contentType) ? detectSimulatorResearchAccessControls(response.body.toString("utf8")) : [];
          controls.forEach(control => accessControls.add(control));
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
          if (error instanceof Error && error.message === "SIMULATOR_RESEARCH_UNSAFE_URL") { blockedRequests += 1; await route.abort("blockedbyclient"); return; }
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
      // A tooling budget can preserve already-read public HTTP facts. It cannot
      // turn an unrelated browser, parser, authority or lease failure into evidence.
      if (!(secondaryBudgetExhausted || secondaryAssetBodyLimitExceeded) || !safeMainDocument || accessControls.size || !expectedIncomplete) throw tagSimulatorResearchFailure(error, "BROWSER_NAVIGATION");
      await settleStartedRoutes();
      if (accessControls.size) return { requestedUrl, url: safeMainDocument.url, observedAt: now().toISOString(), httpStatus: safeMainDocument.status, text: "", links: [], method: "BROWSER", accessControls: [...accessControls], blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" };
      return partialMainDocument(secondaryAssetBodyLimitExceeded ? "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" : "SECONDARY_REQUEST_BUDGET_EXHAUSTED");
    }
    await settleStartedRoutes();
    if (hasRouteFailure) throw routeFailure;
    if (deadline.aborted) throw new Error("SIMULATOR_RESEARCH_DEADLINE");
    try {
      const url = publicUrl(page.url()).href;
      if (!sameOfficialHost(requestedUrl, url) || !navigation) throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED");
      if (accessControls.size) return { requestedUrl, url, observedAt: now().toISOString(), httpStatus: navigation.status, text: "", links: [], method: "BROWSER", accessControls: [...accessControls], blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" };
      if (secondaryBudgetExhausted || secondaryAssetBodyLimitExceeded) return partialMainDocument(
        secondaryAssetBodyLimitExceeded ? "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" : "SECONDARY_REQUEST_BUDGET_EXHAUSTED");
      const html = await beforeDeadline(page.content(), deadline);
      if (hasRouteFailure) throw routeFailure;
      if (Buffer.byteLength(html, "utf8") > MAX_BODY_BYTES) throw new Error("SIMULATOR_RESEARCH_BODY_LIMIT");
      const renderedControls = detectSimulatorResearchAccessControls(html);
      if (renderedControls.length) return { requestedUrl, url, observedAt: now().toISOString(), httpStatus: navigation.status, text: "", links: [], method: "BROWSER", accessControls: renderedControls, blockedRequests, admittedRequests: requestCount, renderComplete: false, contentProvenance: "RENDERED_DOM" };
      const rendered = resultFromBody(requestedUrl, url, response?.status() ?? navigation.status, "text/html", Buffer.from(html), now());
      return { ...rendered, method: "BROWSER", blockedRequests, admittedRequests: requestCount, renderComplete: true, contentProvenance: "RENDERED_DOM", ...(responseContracts.length ? { responseContracts } : {}) };
    } catch (error) { throw tagSimulatorResearchFailure(error, "BROWSER_DOCUMENT"); }
  } catch (error) { throw hasRouteFailure ? routeFailure : knownPublicNetworkError(error); }
  finally {
    const cleanupSignal = AbortSignal.timeout(2_000);
    await Promise.allSettled([beforeDeadline(context?.close() ?? Promise.resolve(), cleanupSignal), beforeDeadline(browser.close(), cleanupSignal)]);
  }
}
