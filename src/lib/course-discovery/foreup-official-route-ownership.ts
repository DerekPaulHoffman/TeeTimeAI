import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { hasCompleteForeupPublicScheduleScope, type ForeupPublicConfiguration } from "@/lib/automation/foreup-public-configuration";
import { fullCourseName, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { freshNativeCanonicalRootDocument, isFreshNativeOfficialIdentityPage, nativeCanonicalRootDocumentProofSchema } from "./native-official-page-attestation";

const failure = (): never => { throw new Error("FOREUP_OFFICIAL_ROUTE_UNVERIFIED"); };
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
export const foreupOwnershipDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const url = z.string().url().max(2048).refine(value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; } });
const label = z.string().min(3).max(300).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/u), id = z.number().int().min(1).max(2_147_483_647);
const sourceSchema = z.object({ officialUrl: url, officialDocumentUrl: url, bookingUrl: url, venueName: label,
  officialTitle: label, publicLocationName: label, canonicalAddress: z.string().min(8).max(1024), timeZone: z.string().min(3).max(80),
  publicCoursePhone: z.string().regex(/^\+1[2-9]\d{9}$/u), rootDocumentProof: nativeCanonicalRootDocumentProofSchema.optional(),
  sourceWitnessSha256: sha, requiredCapability: z.literal("LOCAL_CHROME"), warmTransport: z.literal("NATIVE_CHROME") }).strict();
export const foreupOfficialRouteOwnershipProofSchema = sourceSchema.extend({ kind: z.literal("OFFICIAL_FOREUP_ROUTE_OWNERSHIP_V1"),
  providerName: label, sheetTitle: label, providerAddress: z.string().min(8).max(1024), facilityId: id, scheduleId: id, bookingClassId: id,
  providerWitnessSha256: sha, semanticDigest: sha }).strict().refine(value => {
    const { semanticDigest, ...body } = value;
    const source = Object.fromEntries(Object.keys(sourceSchema.shape).filter(key => key !== "sourceWitnessSha256" && Object.hasOwn(value, key)).map(key => [key, value[key as keyof typeof value]]));
    const provider = { providerName: value.providerName, sheetTitle: value.sheetTitle, providerAddress: value.providerAddress,
      facilityId: value.facilityId, scheduleId: value.scheduleId, bookingClassId: value.bookingClassId, phone: value.publicCoursePhone, timeZone: value.timeZone };
    const selected = route(value.bookingUrl), physical = parsePublicUSBusinessAddress(value.providerAddress), canonicalAddress = parsePublicUSBusinessAddress(value.canonicalAddress);
    return Boolean(selected && selected.facilityId === value.facilityId && selected.scheduleId === value.scheduleId && physical && canonicalAddress &&
      JSON.stringify(physical) === JSON.stringify(canonicalAddress) && value.sourceWitnessSha256 === foreupOwnershipDigest(source) &&
      value.providerWitnessSha256 === foreupOwnershipDigest(provider) && semanticDigest === foreupOwnershipDigest(body));
  });
export type ForeupOfficialRouteOwnershipProof = z.infer<typeof foreupOfficialRouteOwnershipProofSchema>;
type Contact = z.infer<typeof sourceSchema>;
const contacts = new WeakMap<Contact, OfficialIdentityPage>();
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form", "input", "button", "select", "textarea"].includes(node.tagName) ||
  node.attrs.some(a => ["hidden", "inert", "contenteditable"].includes(a.name) || a.name === "aria-hidden" && a.value === "true") ||
  /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?(?:\s*!important)?\s*(?:;|$)/iu.test(attr(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only)(?:\s|$)/u.test(attr(node, "class") ?? "") ||
  /\b(?:account|profile|checkout|payment|billing|mailing|corporate|member|customer|fax)\b/iu.test(["id", "class", "aria-label", "title"].map(k => attr(node, k) ?? "").join(" "));
const blocks = new Set(["p", "div", "li", "section", "footer", "address"]);
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  const value = "childNodes" in node ? node.childNodes.map(text).filter(value => value.trim()).join(element(node) && blocks.has(node.tagName) ? ", " : " ") : "";
  return clean(value).replace(/(?:,\s*){2,}/gu, ", ").replace(/^,\s*|,\s*$/gu, "");
}
function nodes(root: Node) {
  const found: Element[] = []; let count = 0;
  const visit = (node: Node, depth = 0) => { if (depth > 80 || ++count > 20_000) failure();
    if (element(node)) { if (excluded(node)) return; found.push(node); }
    if ("childNodes" in node) node.childNodes.forEach(child => visit(child, depth + 1)); };
  visit(root); return found;
}
function route(value: string) {
  try { const u = new URL(value), match = /^\/index\.php\/booking\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/?$/u.exec(u.pathname);
    return u.protocol === "https:" && u.hostname === "foreupsoftware.com" && !u.port && !u.username && !u.password && !u.search &&
      ["", "#/teetimes", "#teetimes"].includes(u.hash) && match ? { facilityId: Number(match[1]), scheduleId: Number(match[2]) } : undefined;
  } catch { return; }
}
function coreName(name: string) { return fullCourseName(name).replace(/ golf course$/u, "").trim(); }
/** Native original-object ownership only; a copied page or serialized contact is not authority. */
export function deriveForeupOfficialRouteContact(source: OfficialIdentitySource, page: OfficialIdentityPage, privatePhone: unknown): Contact {
  if (!source.officialUrl || !source.venueAddress || !route(source.bookingUrl) || Buffer.byteLength(page.html) > 600_000 || !isFreshNativeOfficialIdentityPage(page, source.officialUrl)) return failure();
  const root = freshNativeCanonicalRootDocument(page, source.officialUrl), phone = normalizePublicCoursePhone(privatePhone), address = parsePublicUSBusinessAddress(source.venueAddress);
  const visible = page.visibleEvidence, expected = coreName(source.venueName), entries = nodes(parse(page.html));
  if (!root || !phone || !address || !visible || expected.length < 3 || expected.length > 200) return failure();
  const titles = entries.filter(n => n.tagName === "title");
  if (titles.length !== 1 || clean(visible.title) !== text(titles[0]) || text(titles[0]).split(/\s*[|–—]\s*/u).filter(value => fullCourseName(value) === expected).length !== 1) return failure();
  const cards: Array<{ value: string; location: string }> = [];
  for (const node of entries.filter(n => blocks.has(n.tagName))) {
    const children = node.childNodes.filter(element);
    if (children.length !== 2 || node.childNodes.some(n => n.nodeName === "#text" && text(n).trim()) || fullCourseName(text(children[0])) !== expected) continue;
    const descendants = nodes(children[1]), links = descendants.filter(n => n.tagName === "a" && (attr(n, "href") ?? "").startsWith("tel:"));
    if (!links.length) continue;
    // A second named physical contact is contradictory evidence, not an
    // unrelated row to discard until one convenient match survives.
    if (links.length !== 1 || normalizePublicCoursePhone((attr(links[0], "href") ?? "").slice(4)) !== phone || normalizePublicCoursePhone(text(links[0])) !== phone) return failure();
    const displayPhone = text(links[0]), body = text(children[1]);
    if (!body.startsWith(displayPhone + ", ")) return failure();
    const remainder = body.slice(displayPhone.length + 2), physical = parsePublicUSBusinessAddress(remainder);
    if (!physical || JSON.stringify(physical) !== JSON.stringify(address)) return failure();
    cards.push({ value: clean(text(children[0]) + ", " + body), location: text(children[0]) });
  }
  if (cards.length !== 1 || visible.addressTexts.filter(value => clean(value) === cards[0].value).length !== 1 ||
      visible.addressTexts.some(value => { const parts = clean(value).split(/,\s*/u);
        return fullCourseName(parts[0]) === expected && Boolean(normalizePublicCoursePhone(parts[1])) && clean(value) !== cards[0].value; }) ||
      !visible.phoneTexts?.some(value => normalizePublicCoursePhone(value) === phone) || !visible.linkUrls.includes(source.bookingUrl)) return failure();
  const rawLinks = entries.filter(n => n.tagName === "a" && /\b(?:tee\s*times?|book(?:\s+(?:a|your))?|reservations?)\b/iu.test(text(n))).filter(n => {
    try { return new URL(attr(n, "href") ?? "", page.url).href === source.bookingUrl; } catch { return false; }
  });
  if (!rawLinks.length) return failure();
  const body = { officialUrl: source.officialUrl, officialDocumentUrl: page.url, bookingUrl: source.bookingUrl, venueName: source.venueName,
    officialTitle: clean(visible.title), publicLocationName: cards[0].location, canonicalAddress: source.venueAddress, timeZone: source.timeZone,
    publicCoursePhone: phone, ...(root.rootDocumentProof ? { rootDocumentProof: root.rootDocumentProof } : {}),
    requiredCapability: "LOCAL_CHROME" as const, warmTransport: "NATIVE_CHROME" as const };
  const contact = sourceSchema.parse({ ...body, sourceWitnessSha256: foreupOwnershipDigest(body) }); contacts.set(contact, page); return contact;
}
/** Bounded JSON literals only. Unknown operational/configuration fields are never projected. */
function assignment(html: string, name: string, open: "[" | "{"): unknown {
  const matches = [...html.matchAll(new RegExp(`\\b${name}\\s*=\\s*\\${open}`, "gu"))];
  if (matches.length !== 1) return failure();
  const start = matches[0].index! + matches[0][0].length - 1, close = open === "[" ? "]" : "}";
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length && i - start < 256_000; i++) { const c = html[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true; else if (c === open) depth++; else if (c === close && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return failure(); } }
  } return failure();
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const providerId = (value: unknown) => { const result = id.safeParse(typeof value === "string" && /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : value); return result.success ? result.data : undefined; };
export function bindForeupOfficialRouteConfiguration(contact: Contact, html: string): { config: ForeupPublicConfiguration; proof: ForeupOfficialRouteOwnershipProof } {
  const page = contacts.get(contact), selectedRoute = route(contact.bookingUrl);
  if (!page || !selectedRoute || !isFreshNativeOfficialIdentityPage(page, contact.officialUrl) || Buffer.byteLength(html) > 512_000) return failure();
  const { sourceWitnessSha256, ...sourceBody } = contact;
  if (sourceWitnessSha256 !== foreupOwnershipDigest(sourceBody)) return failure();
  const courses = assignment(html, "COURSES", "["), current = assignment(html, "COURSE", "{"), schedules = assignment(html, "SCHEDULES", "[");
  if (!Array.isArray(courses) || courses.length < 1 || courses.length > 30 || !Array.isArray(schedules) || schedules.length < 1 || schedules.length > 30 || !record(current)) return failure();
  const facilities = courses.filter(row => record(row) && providerId(row.course_id) === selectedRoute.facilityId), sheets = schedules.filter(row => record(row) &&
    providerId(row.course_id) === selectedRoute.facilityId && providerId(row.teesheet_id) === selectedRoute.scheduleId);
  if (facilities.length !== 1 || sheets.length !== 1 || !record(facilities[0]) || !record(sheets[0])) return failure();
  const facility = facilities[0], sheet = sheets[0], fields = ["course_id", "name", "address", "city", "state", "zip", "country", "phone", "timezone"];
  if (fields.some(key => current[key] !== facility[key]) || !label.safeParse(facility.name).success || !label.safeParse(sheet.title).success ||
      sheet.course_name !== facility.name || facility.timezone !== contact.timeZone || sheet.course_timezone !== contact.timeZone || !["US", "USA", "United States"].includes(String(facility.country)) ||
      normalizePublicCoursePhone(facility.phone) !== contact.publicCoursePhone || ["address", "city", "state", "zip"].some(key => typeof facility[key] !== "string" || String(facility[key]).length > 200)) return failure();
  const providerAddress = `${facility.address}, ${facility.city}, ${facility.state} ${facility.zip}, ${facility.country}`;
  const physical = parsePublicUSBusinessAddress(providerAddress), expected = parsePublicUSBusinessAddress(contact.canonicalAddress);
  if (!physical || !expected || JSON.stringify(physical) !== JSON.stringify(expected)) return failure();
  const classes = sheet.booking_classes;
  if (!Array.isArray(classes) || classes.length < 1 || classes.length > 20 || classes.some(c => !record(c) || !providerId(c.booking_class_id)) ||
      new Set(classes.map(c => providerId(c.booking_class_id))).size !== classes.length) return failure();
  const publicClasses = classes.filter(c => providerId(c.teesheet_id) === selectedRoute.scheduleId && String(c.active) === "1" && String(c.hidden) === "0" &&
    typeof c.name === "string" && /^(?:public|public play|public tee times|online tee times)$/iu.test(c.name.trim()));
  if (publicClasses.length !== 1) return failure();
  if (!hasCompleteForeupPublicScheduleScope({ html, ...selectedRoute, isProvenForeignSchedule: row => {
    if (providerId(row.course_id) === selectedRoute.facilityId) return false;
    const candidates = courses.filter(course => record(course) && providerId(course.course_id) === providerId(row.course_id));
    if (candidates.length !== 1 || !record(candidates[0])) return false;
    const other = candidates[0], phone = normalizePublicCoursePhone(other.phone);
    if (!label.safeParse(other.name).success || row.course_name !== other.name || row.course_timezone !== other.timezone ||
        typeof other.timezone !== "string" || !["US", "USA", "United States"].includes(String(other.country)) || !phone || phone === contact.publicCoursePhone ||
        ["address", "city", "state", "zip"].some(key => typeof other[key] !== "string" || String(other[key]).length > 200)) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: other.timezone }).format(); } catch { return false; }
    const address = parsePublicUSBusinessAddress(`${other.address}, ${other.city}, ${other.state} ${other.zip}, ${other.country}`);
    return Boolean(address && JSON.stringify(address) !== JSON.stringify(expected));
  } })) throw new Error("FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED");
  const bookingClassId = providerId(publicClasses[0].booking_class_id)!;
  const provider = { providerName: String(facility.name), sheetTitle: String(sheet.title), providerAddress, ...selectedRoute, bookingClassId };
  const body = { kind: "OFFICIAL_FOREUP_ROUTE_OWNERSHIP_V1" as const, ...contact, ...provider, providerWitnessSha256: foreupOwnershipDigest({ ...provider, phone: contact.publicCoursePhone, timeZone: contact.timeZone }) };
  return { proof: foreupOfficialRouteOwnershipProofSchema.parse({ ...body, semanticDigest: foreupOwnershipDigest(body) }),
    config: { sourceBookingUrl: contact.bookingUrl, bookingBaseUrl: contact.bookingUrl, scheduleId: selectedRoute.scheduleId, bookingClassId } };
}
