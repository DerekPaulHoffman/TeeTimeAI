import { createHash } from "node:crypto";
import { parse as parseScript } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { fullCourseName, completeUSAddress } from "./teeitup-official-identity";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";

export const SSA_PUBLIC_CLIENT_VERSION = "4.6.12.37";
export const SSA_PUBLIC_CLIENT_SHA256 = "796f8d207d962568641be36c2f7fed78e001ac123ec146ca7b277d588e9a6f43";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code = "SSA_PUBLIC_CONFIGURATION_UNVERIFIED"): never { throw Error(code); }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
export const publicSsaUrl = (value: string): boolean => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && u.href === value; }
  catch { return false; }
};
const id = z.number().int().min(1).max(2_147_483_647);
export const simplyScheduleMetadataSchema = z.object({ family: z.literal("SIMPLY_SCHEDULE_APPOINTMENTS"),
  bookingUrl: z.string().max(2048).refine(publicSsaUrl), appointmentTypeId: id, resourceGroupId: id,
  durationMinutes: z.number().int().min(30).max(480), title: z.string().min(5).max(200),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/u), clientSha256: z.literal(SSA_PUBLIC_CLIENT_SHA256),
  clientVersion: z.literal(SSA_PUBLIC_CLIENT_VERSION),
}).strict();
export type SimplyScheduleMetadata = z.infer<typeof simplyScheduleMetadataSchema>;
export type SimplyScheduleSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(a => a.name === key)?.value ?? "";
const excluded = (node: Element) => ["form", "template", "noscript"].includes(node.tagName) ||
  node.attrs.some(a => ["hidden", "inert"].includes(a.name)) || attr(node, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?(?:\s*!important)?\s*(?:;|$)/iu.test(attr(node, "style")) ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/u.test(attr(node, "class"));
function nodes(html: string) {
  if (Buffer.byteLength(html) > 600_000) fail("SSA_DOCUMENT_LIMIT");
  const all: Element[] = [];
  const walk = (node: Node, depth: number) => {
    if (depth > 80 || all.length > 20_000) fail("SSA_DOCUMENT_LIMIT");
    if (element(node)) { if (excluded(node)) return; all.push(node); }
    if ("childNodes" in node) node.childNodes.forEach(child => walk(child, depth + 1));
  };
  walk(parse(html), 0); return all;
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && (["script", "style", "template", "noscript", "form", "iframe"].includes(node.tagName) || excluded(node))) return "";
  return "childNodes" in node ? clean(node.childNodes.map(text).join(" ")) : "";
}
const physicalWords = (value: string) => value.toLowerCase().replace(/\bstreet\b/gu, "st").replace(/\broad\b/gu, "rd")
  .replace(/\bdrive\b/gu, "dr").replace(/[^a-z0-9]+/gu, " ").trim();
export function verifySimplyScheduleOfficial(html: string, source: SimplyScheduleSource) {
  const all = nodes(html), name = fullCourseName(source.venueName), address = completeUSAddress(source.venueAddress ?? "");
  if (!address || name.length < 5 || !all.some(n => /^h[1-6]$/u.test(n.tagName) && fullCourseName(text(n)) === name ||
      n.tagName === "img" && fullCourseName(attr(n, "alt")) === name)) fail("SSA_OFFICIAL_IDENTITY_UNVERIFIED");
  const expected = physicalWords(`${address.street} ${address.locality} ${address.region} ${address.postalCode}`);
  if (!all.some(n => ["address", "p", "div", "li"].includes(n.tagName) && text(n).length <= 500 &&
      (` ${physicalWords(text(n))} `).includes(` ${expected} `))) fail("SSA_OFFICIAL_IDENTITY_UNVERIFIED");
  const links = all.filter(n => n.tagName === "a").flatMap(n => {
    try { return [new URL(attr(n, "href"), source.officialUrl).href]; } catch { return []; }
  });
  if (!links.includes(source.bookingUrl)) fail("SSA_OFFICIAL_ENTRY_UNVERIFIED");
}
/** The full current parent page, not a retained iframe query, owns this GET. */
export function simplyScheduleFrame(html: string, bookingUrl: string): string | null {
  const frames = nodes(html).filter(n => n.tagName === "iframe" && attr(n, "name") === "ssa_booking");
  if (!frames.length) return null;
  if (frames.length !== 1) fail("SSA_PUBLIC_CATALOG_INCOMPLETE");
  let u: URL; try { u = new URL(attr(frames[0], "src"), bookingUrl); } catch { return fail(); }
  if (u.protocol !== "https:" || u.origin !== new URL(bookingUrl).origin || u.username || u.password || u.port ||
      u.pathname !== "/wp-json/ssa/v1/embed-inner" || u.hash !== "#/" || u.searchParams.get("booking_url") !== bookingUrl ||
      ["edit", "view", "mepr_membership_id", "payment_provider"].some(k => Boolean(u.searchParams.get(k)))) fail();
  u.hash = ""; return u.href;
}
const bootstrapNames = ["ssa", "ssa_settings", "ssa_appointment_types", "ssa_translations", "ssa_customer_information_defaults", "ssa_booking_url_settings", "ssa_token",
  "ssa_embed_settings", "ssa_availability_edge_cache_timestamp", "ssa_availability_edge_cache", "ssa_availability_query_args", "ssa_defer_init", "ssa_hide_header"];
export function parseSimplyScheduleBootstrap(html: string, frameUrl: string, source: SimplyScheduleSource, durationMinutes: number) {
  const all = nodes(html), scripts = all.filter(n => n.tagName === "script" && !attr(n, "src"));
  const candidates = scripts.map(n => n.childNodes.filter(c => c.nodeName === "#text").map(c => (c as DefaultTreeAdapterMap["textNode"]).value).join(""))
    .filter(s => /\bvar\s+ssa_appointment_types\s*=/u.test(s));
  if (candidates.length !== 1) fail();
  const script = candidates[0]; let ast: ReturnType<typeof parseScript>;
  try { ast = parseScript(script, { ecmaVersion: 2022 }); } catch { return fail(); }
  const values = new Map<string, unknown>();
  if (ast.body.length !== bootstrapNames.length) fail();
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration" || node.kind !== "var" || node.declarations.length !== 1) fail();
    const declaration = node.declarations[0];
    if (declaration.id.type !== "Identifier" || !bootstrapNames.includes(declaration.id.name) || values.has(declaration.id.name) || !declaration.init) fail();
    const init = declaration.init;
    try { values.set(declaration.id.name, init.type === "Literal" && ["string", "boolean", "number"].includes(typeof init.value) ? init.value :
      JSON.parse(script.slice(init.start, init.end))); } catch { fail(); }
  }
  const ssa = object(values.get("ssa")), api = object(ssa.api), user = object(ssa.user), settings = object(values.get("ssa_settings")), global = object(settings.global);
  const booking = object(values.get("ssa_booking_url_settings")), expectedRoot = new URL("/wp-json/ssa/v1", source.bookingUrl).href;
  const capabilities = user.capabilities;
  if (user.user_id !== 0 || user.staff_id !== 0 || capabilities === null || typeof capabilities !== "object" || Object.keys(capabilities).length || api.root !== expectedRoot ||
      fullCourseName(String(global.company_name)) !== fullCourseName(source.venueName) ||
      new URL(frameUrl).origin !== new URL(source.bookingUrl).origin || booking.booking_url !== source.bookingUrl || values.get("ssa_token") !== "" && values.get("ssa_token") !== null)
    fail("SSA_ANONYMOUS_SOURCE_UNVERIFIED");
  let zone: string;
  try { zone = new Intl.DateTimeFormat("en-US", { timeZone: String(global.timezone_string) }).resolvedOptions().timeZone;
    if (zone !== new Intl.DateTimeFormat("en-US", { timeZone: source.timeZone }).resolvedOptions().timeZone) fail("SSA_TIME_ZONE_CHANGED");
  } catch { return fail("SSA_TIME_ZONE_CHANGED"); }
  const publicNonce = api.public_nonce;
  if (typeof publicNonce !== "string" || !/^[a-zA-Z0-9]{8,64}$/u.test(publicNonce)) fail();
  const types = values.get("ssa_appointment_types");
  if (!Array.isArray(types) || types.length < 1 || types.length > 60) fail("SSA_PUBLIC_CATALOG_INCOMPLETE");
  const frame = new URL(frameUrl), slugs = frame.searchParams.get("types")?.split(",").filter(Boolean);
  const published = types.map(object).filter(t => t.status === "publish" && (!slugs?.length || slugs.includes(String(t.slug))));
  const rentals = published.filter(t => typeof t.title === "string" && /\bsimulators?\b/iu.test(t.title) && !/\b(?:draft|watch|party|lesson|coaching|membership)\b/iu.test(t.title));
  const services = rentals.map(t => {
    const resources = t.resources_settings, objects = t.resources_objects;
    if (!Array.isArray(resources) || resources.length !== 1 || !Array.isArray(objects) || objects.length !== 1 ||
        object(resources[0]).resource_option !== "any" || object(resources[0]).assigned_resource_id !== 0 ||
        object(objects[0]).resource_type !== "identical" || !/\bsimulator\b/iu.test(String(object(objects[0]).title)) ||
        Number(object(resources[0]).resource_group_id) !== Number(object(objects[0]).id) ||
        t.capacity_type !== "individual" || t.has_max_capacity !== "0" || t.resource_capacity !== "1" || t.timezone_style !== "localized") fail("SSA_RENTAL_RESOURCE_UNVERIFIED");
    const duration = Number(t.duration), typeId = id.parse(Number(t.id)), resourceGroupId = id.parse(Number(object(resources[0]).resource_group_id));
    if (!Number.isInteger(duration) || duration < 30 || duration > 480 || !new RegExp(`(?:^|\\s|-)${duration / 60}\\s*(?:hr|hour)s?(?:$|\\s)`, "iu").test(String(t.title))) fail("SSA_RENTAL_DURATION_UNVERIFIED");
    return { appointmentTypeId: typeId, resourceGroupId, title: String(t.title), durationMinutes: duration };
  });
  const selected = services.filter(t => t.durationMinutes === durationMinutes);
  if (selected.length !== 1 || new Set(services.map(t => t.appointmentTypeId)).size !== services.length) fail("SSA_PUBLIC_CATALOG_INCOMPLETE");
  const clientPath = `/wp-content/plugins/simply-schedule-appointments/booking-app-new/dist/static/js/app.js?ver=${SSA_PUBLIC_CLIENT_VERSION}`;
  const clients = all.filter(n => n.tagName === "script" && attr(n, "src")).map(n => new URL(attr(n, "src"), frameUrl).href)
    .filter(url => new URL(url).pathname.endsWith("/static/js/app.js"));
  const clientUrl = new URL(clientPath, source.bookingUrl).href;
  if (clients.length !== 1 || clients[0] !== clientUrl) fail("SSA_PUBLIC_CLIENT_UNSUPPORTED");
  return { metadata: simplyScheduleMetadataSchema.parse({ family: "SIMPLY_SCHEDULE_APPOINTMENTS", bookingUrl: source.bookingUrl, ...selected[0],
    catalogSha256: digest({ zone, services }), clientVersion: SSA_PUBLIC_CLIENT_VERSION, clientSha256: SSA_PUBLIC_CLIENT_SHA256 }),
    apiRoot: expectedRoot, publicNonce, clientUrl };
}
export function parseSimplyScheduleSlots(value: unknown, metadata: SimplyScheduleMetadata, input: AccessExecutionInput, now: Date): AccessExecutionResult["slots"] {
  const reply = object(value);
  if (reply.response_code !== 200 || reply.error !== "" || typeof reply.message !== "string" || !Array.isArray(reply.data) || reply.data.length > 5000 ||
      input.durationMinutes !== metadata.durationMinutes) fail("SSA_AVAILABILITY_UNVERIFIED");
  const local = (date: Date) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map(p => [p.type, p.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const upperDate = new Date(input.date + "T00:00:00Z"); upperDate.setUTCDate(upperDate.getUTCDate() + 1);
  const lower = input.date + "T" + input.startTime, upper = input.endTime === "24:00" ? upperDate.toISOString().slice(0, 10) + "T00:00" : input.date + "T" + input.endTime;
  let previous = -Infinity;
  return reply.data.flatMap(raw => {
    const row = object(raw), printed = row.start_date;
    if (typeof printed !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/u.test(printed) ||
        Object.keys(row).some(k => !["start_date", "capacity_available"].includes(k))) fail("SSA_AVAILABILITY_UNVERIFIED");
    const start = new Date(printed.replace(" ", "T") + "Z"), at = start.getTime();
    if (!Number.isFinite(at) || start.toISOString() !== printed.replace(" ", "T") + ".000Z" || at <= previous ||
        row.capacity_available !== undefined && (!Number.isInteger(row.capacity_available) || Number(row.capacity_available) < 1)) fail("SSA_AVAILABILITY_UNVERIFIED");
    previous = at;
    const end = new Date(at + metadata.durationMinutes * 60000);
    if (at <= now.getTime() || local(start) < lower || local(start) >= upper || local(end) > upper) return [];
    const key = `ssa:${metadata.appointmentTypeId}:${metadata.resourceGroupId}`;
    return [{ sourceId: `${key}:${at}`, resourceId: `ssa-resource:${metadata.resourceGroupId}`, productId: `ssa-type:${metadata.appointmentTypeId}`,
      startsAt: start.toISOString(), endsAt: end.toISOString(), availableSpots: 1, capacity: null, bookingUrl: metadata.bookingUrl }];
  });
}
