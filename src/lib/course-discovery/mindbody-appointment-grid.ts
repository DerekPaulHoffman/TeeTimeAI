import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";
import { getTimeZoneOffsetMinutes } from "@/lib/timezones";

const id = z.string().regex(/^[1-9]\d{0,9}$/u).refine(value => Number(value) <= 2_147_483_647);
const label = z.string().trim().min(2).max(240);
const timeZone = z.string().max(80).refine(value => value.includes("/") && (() => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
})());
const clean = (value: string) => value.replace(/\u00c2(?=\u00a0)/gu, "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const fail = (code: string): never => { throw new Error(code); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicUrl = (value: string) => {
  try { const url = new URL(value); return value.length <= 2048 && url.href === value && url.protocol === "https:" &&
    !url.username && !url.password && !url.port && !isIP(url.hostname) && url.hostname.includes(".") &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/iu.test(url.hostname) &&
    ![...url.searchParams].some(([key, item]) => /token|password|secret|session|cookie|credential|authorization|email|phone|api.?key/iu.test(key) || /[\r\n]/u.test(item)); }
  catch { return false; }
};
export type MindbodyAppointmentSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress: string; timeZone: string };
/** Recognizes only the existing observed public classic entry. It invents no route. */
export function parseMindbodyAppointmentSource(value: string) {
  try {
    const url = new URL(value);
    if (!publicUrl(value) || url.origin !== "https://clients.mindbodyonline.com" || url.pathname !== "/classic/ws" || url.hash ||
        url.searchParams.size !== 2 || url.searchParams.getAll("studioid").length !== 1 || url.searchParams.getAll("stype").length !== 1 ||
        !id.safeParse(url.searchParams.get("studioid")).success || url.searchParams.get("stype") !== "-9" ||
        !/^\?(?:studioid=[1-9]\d{0,9}&stype=-9|stype=-9&studioid=[1-9]\d{0,9})$/u.test(url.search)) return;
    return { studioId: url.searchParams.get("studioid")! };
  } catch { return; }
}
function sourceKey(source: MindbodyAppointmentSource) {
  const address = completeUSAddress(source.venueAddress);
  if (!publicUrl(source.officialUrl) || !parseMindbodyAppointmentSource(source.bookingUrl) || !address ||
      !timeZone.safeParse(source.timeZone).success || fullCourseName(source.venueName).replaceAll(" ", "").length < 8)
    fail("MINDBODY_CANONICAL_IDENTITY_REQUIRED");
  return digest([source.officialUrl, source.bookingUrl, fullCourseName(source.venueName), address, source.timeZone]);
}
export function validateMindbodyAppointmentSource(source: MindbodyAppointmentSource): void { sourceKey(source); }
function observedAddress(value: string) {
  // A plain named-building qualifier is not a different street or unit.
  // Numbers, suite/unit/floor markers and arbitrary extra prose do not qualify.
  const physical = clean(value).replace(/\b(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd)\s+(?:The\s+)?(?:[A-Za-z]+\s+){1,4}Building(?=,)/iu, "$1")
    .replace(/,\s*([^,]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:,\s*(?:USA|US))?$/u, ", $1, $2 $3");
  return completeUSAddress(physical);
}
function rentalLabel(value: string) {
  return /\b(?:golf|simulator|bay|putting|chipping)\b/iu.test(value) &&
    !/\b(?:lesson|coaching|class|league|membership|private|package|event|account)\b/iu.test(value);
}
export const mindbodyAppointmentMetadataSchema = z.object({
  family: z.literal("MINDBODY"), protocol: z.literal("CLASSIC_APPOINTMENT_GRID"),
  browserTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME"),
  studioId: id, locationId: id, categoryId: id, serviceId: id,
  serviceName: label.refine(rentalLabel), durationMinutes: z.number().int().min(15).max(480),
  capacity: z.number().int().min(1).max(20), resourceIds: z.array(id).min(1).max(16)
    .refine(values => new Set(values).size === values.length && values.every((value, index) => !index || Number(values[index - 1]) < Number(value))),
  timeZone, catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type MindbodyAppointmentMetadata = z.infer<typeof mindbodyAppointmentMetadataSchema>;
const catalogSchema = z.object({
  captureId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), url: z.string().max(2048),
  venueName: label, venueAddress: z.string().min(10).max(1024), studioId: id, locationId: id,
  category: z.object({ id, label, enabled: z.literal(true), selected: z.literal(true) }).strict(),
  service: z.object({ id, label, description: z.string().min(1).max(4000), enabled: z.literal(true), selected: z.literal(true) }).strict(),
  resources: z.array(z.object({ id, label, enabled: z.literal(true) }).strict()).min(1).max(16),
}).strict();
export type MindbodyCatalogEvidence = z.infer<typeof catalogSchema>;
export type MindbodyCatalogObservation = { metadata: MindbodyAppointmentMetadata; captureId: string; sourceIdentityKey: string };
function publicDocument(value: string) {
  try { const url = new URL(value); return publicUrl(value) && url.origin === "https://clients.mindbodyonline.com" &&
    ["/ASP/adm/adm_appt_search.asp", "/ASP/adm/adm_appt_search_p.asp", "/ASP/main_appts.asp"].includes(url.pathname); }
  catch { return false; }
}
/** Pure interpretation of a fixed browser's current public catalog capture.
 * The captureId is ephemeral controller context, never accepted recipe proof. */
export function inspectMindbodyPublicRentalCatalog(source: MindbodyAppointmentSource, value: unknown): MindbodyCatalogObservation {
  const evidence = catalogSchema.parse(value), identity = sourceKey(source), descriptor = parseMindbodyAppointmentSource(source.bookingUrl)!;
  const canonicalAddress = completeUSAddress(source.venueAddress), providerAddress = observedAddress(evidence.venueAddress);
  if (!publicDocument(evidence.url) || descriptor.studioId !== evidence.studioId ||
      fullCourseName(evidence.venueName) !== fullCourseName(source.venueName) || !providerAddress ||
      JSON.stringify(providerAddress) !== JSON.stringify(canonicalAddress)) fail("MINDBODY_CATALOG_IDENTITY_MISMATCH");
  const duration = /^(.+?)\s*-\s*(\d+(?:\/\d+)?)\s+(hour|minute)s?\s+session$/iu.exec(clean(evidence.service.label));
  if (!duration || fullCourseName(duration[1]) !== fullCourseName(evidence.category.label) || !rentalLabel(duration[1]))
    fail("MINDBODY_RENTAL_DURATION_UNPROVED");
  const parts = duration![2].split("/").map(Number), amount = parts.length === 2 ? parts[0] / parts[1] : parts[0];
  const durationMinutes = amount * (duration![3].toLowerCase() === "hour" ? 60 : 1);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) fail("MINDBODY_RENTAL_DURATION_UNPROVED");
  const capacities = [...evidence.service.description.matchAll(/\bBring ([0-9]|1[0-9]) guests? at no additional charge\./gu)];
  if (capacities.length !== 1) fail("MINDBODY_RENTAL_CAPACITY_UNPROVED");
  if (new Set(evidence.resources.map(resource => resource.id)).size !== evidence.resources.length ||
      evidence.resources.some(resource => !rentalLabel(resource.label))) fail("MINDBODY_RESOURCE_CATALOG_UNPROVED");
  const resourceIds = evidence.resources.map(resource => resource.id).sort((a, b) => Number(a) - Number(b));
  const semantic = { family: "MINDBODY" as const, protocol: "CLASSIC_APPOINTMENT_GRID" as const,
    browserTransport: "NATIVE_CHROME" as const, requiredCapability: "LOCAL_CHROME" as const,
    studioId: evidence.studioId, locationId: evidence.locationId, categoryId: evidence.category.id,
    serviceId: evidence.service.id, serviceName: clean(evidence.service.label), durationMinutes,
    capacity: Number(capacities[0][1]) + 1, resourceIds, timeZone: source.timeZone };
  return { metadata: mindbodyAppointmentMetadataSchema.parse({ ...semantic, catalogHash: digest([identity, semantic]) }),
    captureId: evidence.captureId, sourceIdentityKey: identity };
}
function usDate(value: string) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (!match) return;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  if (date.getUTCFullYear() !== Number(match[3]) || date.getUTCMonth() !== Number(match[1]) - 1 || date.getUTCDate() !== Number(match[2])) return;
  return date.toISOString().slice(0, 10);
}
function clock(value: string) {
  const match = /^(1[0-2]|[1-9]):([0-5]\d)(?::00)? ([AP]M)$/u.exec(clean(value).toUpperCase());
  return match ? (Number(match[1]) % 12 + (match[3] === "PM" ? 12 : 0)) * 60 + Number(match[2]) : undefined;
}
export type MindbodyAppointmentCell = { date: string; locationId: string; categoryId: string; resourceId: string; startMinutes: number; freeUntilMinutes: number };
/** READ ATTRIBUTE ONLY. This URL must never be requested, followed or used as a customer link. */
export function parseMindbodyAppointmentCellHref(value: string, requestedDate: string): MindbodyAppointmentCell {
  const keys = ["loc", "tgid", "trnid", "date", "mask", "Stime", "Etime", "localDate"];
  let url: URL;
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
  try {
    // Attribute decoding only: no request/action authority. This fixed public
    // calendar document base cannot be supplied by a model or provider query.
    if (typeof value !== "string" || value.length > 2048 || value.trim() !== value || /[\u0000-\u001f\u007f\\]/u.test(value) || value.startsWith("//") ||
        decodeURIComponent(value.split(/[?#]/u, 1)[0]).split("/").includes("..")) fail("MINDBODY_GRID_CELL_URL_INVALID");
    url = new URL(value, "https://clients.mindbodyonline.com/ASP/main_appts.asp");
  } catch { return fail("MINDBODY_GRID_CELL_URL_INVALID"); }
  if (!publicUrl(absolute ? value : url.href) || url.origin !== "https://clients.mindbodyonline.com" || url.pathname !== "/ASP/appt_req.asp" || url.hash)
    fail("MINDBODY_GRID_CELL_URL_INVALID");
  if (url.searchParams.size !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1) ||
      [...url.searchParams.keys()].some(key => !keys.includes(key)) || url.searchParams.get("mask") !== "False" ||
      !["loc", "tgid", "trnid"].every(key => id.safeParse(url.searchParams.get(key)).success)) fail("MINDBODY_GRID_CELL_QUERY_INVALID");
  const date = usDate(url.searchParams.get("date")!), localDate = usDate(url.searchParams.get("localDate")!),
    startMinutes = clock(url.searchParams.get("Stime")!), freeUntilMinutes = clock(url.searchParams.get("Etime")!);
  if (!date || date !== requestedDate) fail("MINDBODY_GRID_CELL_DATE_INVALID");
  if (!localDate || localDate !== date) fail("MINDBODY_GRID_CELL_LOCAL_DATE_INVALID");
  if (startMinutes === undefined || freeUntilMinutes === undefined) fail("MINDBODY_GRID_CELL_CLOCK_INVALID");
  if (freeUntilMinutes! <= startMinutes!) fail("MINDBODY_GRID_CELL_INTERVAL_INVALID");
  return { date: date!, locationId: url.searchParams.get("loc")!, categoryId: url.searchParams.get("tgid")!,
    resourceId: url.searchParams.get("trnid")!, startMinutes: startMinutes!, freeUntilMinutes: freeUntilMinutes! };
}
export function parseMindbodyResourceHeaderHref(value: string) {
  const match = /^javascript:autoSubmitToDayTrn\('([1-9]\d{0,9})'\);$/u.exec(value);
  return match && id.safeParse(match[1]).success ? match[1] : undefined;
}
type Anchor = { href: string; label: string; visible: boolean };
export type MindbodyGridEvidence = { captureId: string; url: string; title: string; text: string;
  anchors: Anchor[]; resourceHeaders: Anchor[];
  completion?: { responseUrl: string; status: number; contentType: string; rawHtml: string; renderedHtml: string;
    bodyComplete: boolean; documentUnchanged: boolean; pendingRelevantRequests: number; truncated: boolean; signedOut: boolean } };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attribute = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value;
const concealed = (node: Element) => attribute(node, "hidden") !== undefined || attribute(node, "inert") !== undefined ||
  attribute(node, "aria-hidden") === "true" || /\b(?:hidden|d-none|invisible|sr-only)\b/u.test(attribute(node, "class") ?? "") ||
  /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\s*[;!]|\s*$)/iu.test(attribute(node, "style") ?? "");
function dateCaption(text: string) {
  const found = [...clean(text).matchAll(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/gu)];
  if (found.length !== 1) return;
  const date = usDate(found[0][2]);
  return date && new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z")) === found[0][1] ? date : undefined;
}
function publicProjection(html: string) {
  if (Buffer.byteLength(html) > 2_000_000 || !/<\/body\s*>/iu.test(html) || !/<\/html\s*>/iu.test(html)) fail("MINDBODY_GRID_DOCUMENT_INCOMPLETE");
  const anchors: Anchor[] = [], headers: Anchor[] = [], texts: string[] = [], clocks: number[] = [];
  const anchorNodes: Element[] = [], headerNodes: Element[] = [], tables: Element[] = [];
  let count = 0, hiddenAppointment = false, pagination = false;
  const nodeText = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value :
    "childNodes" in node ? node.childNodes.map(nodeText).join(" ") : "";
  const visit = (node: Node, hidden = false) => {
    if (++count > 30_000) fail("MINDBODY_GRID_NODE_LIMIT");
    if (element(node)) {
      hidden ||= concealed(node);
      if (["script", "style", "template", "noscript"].includes(node.tagName)) return;
      const classes = (attribute(node, "class") ?? "").split(/\s+/u);
      if (!hidden && node.tagName === "table") tables.push(node);
      if (node.tagName === "a" && classes.includes("apptLink")) {
        if (hidden) hiddenAppointment = true;
        else { anchors.push({ href: attribute(node, "href") ?? "", label: clean(nodeText(node)), visible: true }); anchorNodes.push(node); }
      }
      if (!hidden && node.tagName === "a" && classes.includes("instructorLink")) {
        headers.push({ href: attribute(node, "href") ?? "", label: clean(nodeText(node)), visible: true }); headerNodes.push(node);
      }
      if (!hidden && ["a", "button", "input"].includes(node.tagName) &&
          /^(?:load more|more results|next page|previous page|next instructors|previous instructors|next resources|previous resources)$/iu.test(clean(nodeText(node) || attribute(node, "value") || ""))) pagination = true;
    }
    if (node.nodeName === "#text" && !hidden) {
      const value = clean((node as DefaultTreeAdapterMap["textNode"]).value); texts.push(value);
      const minutes = clock(value); if (minutes !== undefined) clocks.push(minutes);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, hidden);
  };
  visit(parse(html));
  const inside = (parent: Element, child: Node) => {
    for (let node: Node | null = child; node; node = "parentNode" in node ? node.parentNode : null) if (node === parent) return true;
    return false;
  };
  if (!tables.some(table => [...anchorNodes, ...headerNodes].every(node => inside(table, node))))
    fail("MINDBODY_GRID_TABLE_SCOPE_MISSING");
  if (anchors.length > 500 || headers.length > 16 || hiddenAppointment || pagination) fail("MINDBODY_GRID_NOT_WHOLE_VISIBLE_DATE");
  const text = clean(texts.join(" ")), date = dateCaption(text), range = /\bInstructors (\d+)-(\d+)\b/u.exec(text);
  return { anchors, headers, date, range: range ? [Number(range[1]), Number(range[2])] : undefined, clocks: [...new Set(clocks)].sort((a, b) => a - b) };
}
const anchorKey = (rows: Anchor[]) => JSON.stringify(rows.map(row => [row.href, clean(row.label)]).sort((a, b) => a[0].localeCompare(b[0])));
function localInstant(date: string, minutes: number, zone: string) {
  const guess = Date.parse(date + "T00:00:00Z") + minutes * 60_000;
  const offsets = [...new Set([-36, -12, 0, 12, 36].map(hours => getTimeZoneOffsetMinutes(new Date(guess + hours * 3_600_000), zone)))];
  const expected = date + "T" + String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  const matches = offsets.map(offset => new Date(guess - offset * 60_000)).filter(value => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
    const part = (type: string) => parts.find(row => row.type === type)?.value;
    return part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute") === expected;
  });
  if (matches.length !== 1) fail("MINDBODY_GRID_LOCAL_TIME_AMBIGUOUS");
  return matches[0];
}
export type MindbodyGridInput = { date: string; timeZone: string; durationMinutes: number; players: number; startTime: string; endTime: string };
export type MindbodyGridResult = { complete: boolean; reason?: string; observedStartCount: number; requestedDurationStartCount: number;
  slots: Array<{ startsAt: string; endsAt: string; durationMinutes: number; resourceId: string; capacity: number; officialBookingUrl: string }> };
/** Pure interpretation used by the fixed native Mindbody reader.
 * Only that controller reader may supply raw/current rendered completion captures;
 * framework/model reports and uploaded proof must never supply them. */
export function readMindbodyPublicAppointmentGrid(source: MindbodyAppointmentSource, observation: MindbodyCatalogObservation,
  input: MindbodyGridInput, evidence: MindbodyGridEvidence): MindbodyGridResult {
  const metadata = mindbodyAppointmentMetadataSchema.parse(observation.metadata);
  if (sourceKey(source) !== observation.sourceIdentityKey || evidence.captureId !== observation.captureId ||
      !publicDocument(evidence.url) || fullCourseName(evidence.title) !== fullCourseName(source.venueName) ||
      input.timeZone !== source.timeZone || input.timeZone !== metadata.timeZone || input.durationMinutes !== metadata.durationMinutes ||
      !Number.isInteger(input.players) || input.players < 1 || input.players > metadata.capacity ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || dateCaption(evidence.text) !== input.date) fail("MINDBODY_GRID_CONTEXT_MISMATCH");
  if (evidence.anchors.length > 500 || evidence.resourceHeaders.length > 16 || !evidence.anchors.length ||
      evidence.anchors.some(row => !row.visible) || evidence.resourceHeaders.some(row => !row.visible)) fail("MINDBODY_GRID_NOT_WHOLE_VISIBLE_DATE");
  const headerIds = evidence.resourceHeaders.map(row => parseMindbodyResourceHeaderHref(row.href));
  if (headerIds.some(value => !value) || new Set(headerIds).size !== headerIds.length ||
      metadata.resourceIds.some(value => !headerIds.includes(value))) fail("MINDBODY_GRID_RESOURCE_SCOPE_MISMATCH");
  const rows = evidence.anchors.map(anchor => ({ ...parseMindbodyAppointmentCellHref(anchor.href, input.date), label: clean(anchor.label) }));
  const selected = rows.filter(row => row.categoryId === metadata.categoryId);
  if (rows.some(row => row.locationId !== metadata.locationId || !headerIds.includes(row.resourceId)) ||
      selected.some(row => !metadata.resourceIds.includes(row.resourceId) ||
        fullCourseName(row.label) !== fullCourseName(metadata.serviceName.replace(/\s*-\s*.*$/u, ""))) ||
      rows.some(row => row.categoryId !== metadata.categoryId && metadata.resourceIds.includes(row.resourceId)) ||
      new Set(rows.map(row => row.resourceId + ":" + row.startMinutes)).size !== rows.length) fail("MINDBODY_GRID_RESOURCE_SCOPE_MISMATCH");
  const eligible = selected.filter(row => row.freeUntilMinutes - row.startMinutes >= input.durationMinutes);
  const result: MindbodyGridResult = { complete: false, reason: "MINDBODY_GRID_COMPLETION_WITNESS_MISSING", observedStartCount: selected.length,
    requestedDurationStartCount: eligible.length, slots: [] };
  const witness = evidence.completion;
  if (!witness) return result;
  if (!publicDocument(witness.responseUrl) || new URL(witness.responseUrl).pathname !== "/ASP/main_appts.asp" || witness.status !== 200 ||
      !/^text\/html(?:;|$)/iu.test(witness.contentType) || !witness.bodyComplete || !witness.documentUnchanged ||
      witness.pendingRelevantRequests !== 0 || witness.truncated || !witness.signedOut) fail("MINDBODY_GRID_DOCUMENT_INCOMPLETE");
  const raw = publicProjection(witness.rawHtml), visible = publicProjection(witness.renderedHtml);
  if (JSON.stringify(raw) !== JSON.stringify(visible) || raw.date !== input.date || !raw.range || raw.range[0] !== 1 ||
      raw.range[1] !== headerIds.length || anchorKey(raw.anchors) !== anchorKey(evidence.anchors) ||
      anchorKey(raw.headers) !== anchorKey(evidence.resourceHeaders) || raw.clocks.length < 2)
    fail("MINDBODY_GRID_RAW_VISIBLE_MISMATCH");
  const minute = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/u.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : value === "24:00" ? 1440 : NaN;
  const start = minute(input.startTime), end = minute(input.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || raw.clocks[0] > start || raw.clocks.at(-1)! < end)
    fail("MINDBODY_GRID_WINDOW_NOT_COVERED");
  const slots = eligible.filter(row => row.startMinutes >= start && row.startMinutes + input.durationMinutes <= end).map(row => {
    const begins = localInstant(row.date, row.startMinutes, input.timeZone), until = localInstant(row.date, row.freeUntilMinutes, input.timeZone);
    const ends = new Date(begins.getTime() + input.durationMinutes * 60_000);
    if (ends > until) fail("MINDBODY_GRID_DURATION_NOT_COVERED");
    return { startsAt: begins.toISOString(), endsAt: ends.toISOString(), durationMinutes: input.durationMinutes,
      resourceId: row.resourceId, capacity: metadata.capacity, officialBookingUrl: source.bookingUrl };
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || Number(a.resourceId) - Number(b.resourceId));
  return { ...result, complete: true, reason: undefined, slots };
}

