import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { FOREUP_STANDARD_PUBLIC_SCOPE, foreupPublicScheduleCatalogSha256, hasCompleteForeupPublicScheduleScope, type ForeupPublicConfiguration } from "@/lib/automation/foreup-public-configuration";
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
function titleParts(value: string, expected: string) {
  const parts = value.split(/\s*[|–—]\s*/u);
  // Preserve a canonical name containing a spaced hyphen before treating that
  // punctuation as a title separator. Matching remains exact in either form.
  return parts.some(part => fullCourseName(part) === expected) ? parts : parts.flatMap(part => part.split(/\s+-\s+/u));
}
export const FOREUP_COMPACT_CONTACT_FACILITY_SCOPE = "CANONICAL_ROOT_COMPACT_CONTACT_FACILITY_V1" as const;
const sourceSchema = z.object({ officialUrl: url, officialDocumentUrl: url, bookingUrl: url, venueName: label,
  officialTitle: label, publicLocationName: label, canonicalAddress: z.string().min(8).max(1024), timeZone: z.string().min(3).max(80),
  publicCoursePhone: z.string().regex(/^\+1[2-9]\d{9}$/u), rootDocumentProof: nativeCanonicalRootDocumentProofSchema.optional(),
  contactScope: z.literal(FOREUP_COMPACT_CONTACT_FACILITY_SCOPE).optional(),
  sourceWitnessSha256: sha, requiredCapability: z.literal("LOCAL_CHROME"), warmTransport: z.literal("NATIVE_CHROME") }).strict();
export const foreupOfficialRouteOwnershipProofSchema = sourceSchema.extend({ kind: z.literal("OFFICIAL_FOREUP_ROUTE_OWNERSHIP_V1"),
  providerName: label, sheetTitle: label, providerAddress: z.string().min(8).max(1024), facilityId: id, scheduleId: id, bookingClassId: id,
  inventoryScope: z.literal(FOREUP_STANDARD_PUBLIC_SCOPE).optional(), publicCatalogSha256: sha.optional(),
  providerWitnessSha256: sha, semanticDigest: sha }).strict().refine(value => {
    const { semanticDigest, ...body } = value;
    const source = Object.fromEntries(Object.keys(sourceSchema.shape).filter(key => key !== "sourceWitnessSha256" && Object.hasOwn(value, key)).map(key => [key, value[key as keyof typeof value]]));
    const provider = { providerName: value.providerName, sheetTitle: value.sheetTitle, providerAddress: value.providerAddress,
      facilityId: value.facilityId, scheduleId: value.scheduleId, bookingClassId: value.bookingClassId, phone: value.publicCoursePhone, timeZone: value.timeZone };
    const selected = route(value.bookingUrl), facility = facilityRoute(value.bookingUrl), physical = parsePublicUSBusinessAddress(value.providerAddress), canonicalAddress = parsePublicUSBusinessAddress(value.canonicalAddress);
    const routeMatches = value.contactScope ? facility?.facilityId === value.facilityId && !value.rootDocumentProof &&
      value.inventoryScope === FOREUP_STANDARD_PUBLIC_SCOPE && value.officialDocumentUrl === value.officialUrl && canonicalRootUrl(value.officialUrl) &&
      titleParts(value.officialTitle, coreName(value.venueName)).filter(part => fullCourseName(part) === coreName(value.venueName)).length === 1 &&
      titleParts(value.officialTitle, coreName(value.venueName)).includes(value.publicLocationName) && fullCourseName(value.publicLocationName) === coreName(value.venueName) :
      selected?.facilityId === value.facilityId && selected.scheduleId === value.scheduleId;
    return Boolean(Boolean(value.inventoryScope) === Boolean(value.publicCatalogSha256) &&
      routeMatches && physical && canonicalAddress &&
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
function facilityRoute(value: string) {
  try { const u = new URL(value), match = /^\/index\.php\/booking\/([1-9]\d{0,9})\/?$/u.exec(u.pathname);
    return u.protocol === "https:" && u.hostname === "foreupsoftware.com" && !u.port && !u.username && !u.password && !u.search &&
      ["", "#/teetimes", "#teetimes"].includes(u.hash) && match ? { facilityId: Number(match[1]) } : undefined;
  } catch { return; }
}
function canonicalRootUrl(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password && !u.port; } catch { return false; }
}
function coreName(name: string) { return fullCourseName(name).replace(/ golf course$/u, "").trim(); }
const phoneScalar = /(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/gu;
function contactText(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  const value = "childNodes" in node ? node.childNodes.map(child => {
    const value = contactText(child);
    return element(child) && blocks.has(child.tagName) && value ? `, ${value}, ` : value;
  }).join(" ") : "";
  return clean(value).replace(/(?:,\s*){2,}/gu, ", ").replace(/^,\s*|,\s*$/gu, "");
}
function cardName(value: string, expected: string) {
  const separator = value.indexOf(",");
  const location = separator < 0 ? "" : clean(value.slice(0, separator));
  return location.length <= 200 && fullCourseName(location) === expected ? location : undefined;
}
/** All three independently printed scalars must occupy one bounded contact,
 * never a canonical-field substitution or a search across the document. */
function publicContactEmail(node: Element) {
  if (node.tagName !== "a") return;
  const match = /^mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63})$/iu.exec(attr(node, "href") ?? "");
  return match && match[1].length <= 254 && text(node).toLowerCase() === match[1].toLowerCase() ? match[1].toLowerCase() : undefined;
}
function withoutPublicContactEmail(value: string, email: string) {
  const matches = [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/giu)];
  if (matches.length !== 1 || matches[0][0].toLowerCase() !== email) return;
  const before = value.slice(0, matches[0].index).replace(/(?:^|[,\s])e-?mail\s*:?\s*$/iu, "");
  return clean(`${before} ${value.slice(matches[0].index! + matches[0][0].length)}`).replace(/(?:,\s*){2,}/gu, ", ").replace(/^,\s*|,\s*$/gu, "");
}
function semanticCard(value: string, expected: string, email?: string) {
  if (email) { const physicalContact = withoutPublicContactEmail(value, email); if (!physicalContact) return; value = physicalContact; }
  const location = cardName(value, expected);
  if (!location || value.length > 700) return;
  const parsed = semanticCompactContact(value.slice(value.indexOf(",") + 1));
  return parsed ? { location, ...parsed } : undefined;
}
function semanticCompactContact(remainder: string) {
  if (remainder.length > 700 || /\b(?:mailing|corporate|billing|headquarters|private|members?|customer|account|fax)\b/iu.test(remainder)) return;
  const phones = [...remainder.matchAll(phoneScalar)];
  if (phones.length !== 1) return;
  const phone = normalizePublicCoursePhone(phones[0][0]);
  const physicalText = clean(remainder.replace(phones[0][0], "").replace(/(?:^|,\s*)(?:phone|tel(?:ephone)?)\s*:\s*(?:,\s*)?/iu, ", "))
    .replace(/(?:,\s*){2,}/gu, ", ").replace(/^,\s*|,\s*$/gu, "").trim();
  const address = parsePublicUSBusinessAddress(physicalText);
  return phone && address ? { phone, address } : undefined;
}
function within(node: Node, ancestor: Node) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (current === ancestor) return true;
  return false;
}
/** Native original-object ownership only; a copied page or serialized contact is not authority. */
export function deriveForeupOfficialRouteContact(source: OfficialIdentitySource, page: OfficialIdentityPage, privatePhone: unknown): Contact {
  if (!source.officialUrl || !source.venueAddress || !route(source.bookingUrl) && !facilityRoute(source.bookingUrl) || Buffer.byteLength(page.html) > 600_000 || !isFreshNativeOfficialIdentityPage(page, source.officialUrl)) return failure();
  const root = freshNativeCanonicalRootDocument(page, source.officialUrl), phone = normalizePublicCoursePhone(privatePhone), address = parsePublicUSBusinessAddress(source.venueAddress);
  const visible = page.visibleEvidence, expected = coreName(source.venueName), entries = nodes(parse(page.html));
  if (!root || !phone || !address || !visible || expected.length < 3 || expected.length > 200) return failure();
  const titles = entries.filter(n => n.tagName === "title");
  if (titles.length !== 1 || clean(visible.title) !== text(titles[0]) || titleParts(text(titles[0]), expected).filter(value => fullCourseName(value) === expected).length !== 1) return failure();
  if (facilityRoute(source.bookingUrl)) {
    if (root.rootDocumentProof || !canonicalRootUrl(source.officialUrl) || page.url !== source.officialUrl || visible.phoneTextsOmitted ||
        visible.contactPhoneLinksOmitted || visible.addressTexts.length >= 160) return failure();
    const allPhones = entries.filter(node => node.tagName === "a" && (attr(node, "href") ?? "").startsWith("tel:"));
    if (allPhones.length !== 1 || normalizePublicCoursePhone((attr(allPhones[0], "href") ?? "").slice(4)) !== phone ||
        normalizePublicCoursePhone(text(allPhones[0])) !== phone) return failure();
    const candidates = entries.filter(node => blocks.has(node.tagName) && semanticCompactContact(contactText(node)));
    if (candidates.length > 40) return failure();
    const minimal = candidates.filter(node => !candidates.some(other => other !== node && within(other, node)));
    if (minimal.length !== 1 || !within(allPhones[0], minimal[0])) return failure();
    const descendants = nodes(minimal[0]);
    if (descendants.length > 80 || descendants.some(node => /^h[1-6]$/u.test(node.tagName) ||
        node !== minimal[0] && ["section", "article", "footer"].includes(node.tagName) ||
        node.tagName === "a" && node !== allPhones[0])) return failure();
    const contact = semanticCompactContact(contactText(minimal[0]));
    if (!contact || contact.phone !== phone || JSON.stringify(contact.address) !== JSON.stringify(address)) return failure();
    const rendered = visible.addressTexts.map(value => semanticCompactContact(clean(value))).filter(value => value !== undefined);
    if (!rendered.length || new Set(rendered.map(value => JSON.stringify(value))).size !== 1 ||
        JSON.stringify(rendered[0]) !== JSON.stringify(contact) || !visible.phoneTexts?.length ||
        visible.phoneTexts.some(value => normalizePublicCoursePhone(value) !== phone) || !visible.linkUrls.includes(source.bookingUrl)) return failure();
    const bookingLinks = entries.filter(node => node.tagName === "a" && /\b(?:tee\s*times?|book(?:\s+(?:a|your))?|reservations?)\b/iu.test(text(node)))
      .flatMap(node => { try { const href = new URL(attr(node, "href") ?? "", page.url).href; return facilityRoute(href) ? [href] : []; } catch { return []; } });
    if (!bookingLinks.length || new Set(bookingLinks).size !== 1 || bookingLinks[0] !== source.bookingUrl) return failure();
    const publicLocationName = titleParts(text(titles[0]), expected).find(value => fullCourseName(value) === expected)!;
    const body = { officialUrl: source.officialUrl, officialDocumentUrl: page.url, bookingUrl: source.bookingUrl, venueName: source.venueName,
      officialTitle: clean(visible.title), publicLocationName, canonicalAddress: source.venueAddress, timeZone: source.timeZone,
      publicCoursePhone: phone, contactScope: FOREUP_COMPACT_CONTACT_FACILITY_SCOPE,
      requiredCapability: "LOCAL_CHROME" as const, warmTransport: "NATIVE_CHROME" as const };
    const witness = sourceSchema.parse({ ...body, sourceWitnessSha256: foreupOwnershipDigest(body) }); contacts.set(witness, page); return witness;
  }
  const candidates = entries.filter(node => blocks.has(node.tagName) && contactText(node).length <= 700 && cardName(contactText(node), expected) &&
    nodes(node).some(n => n.tagName === "a" && (attr(n, "href") ?? "").startsWith("tel:")));
  if (candidates.length > 40) return failure();
  // Wrappers around a contact do not create another card. Separate same-name
  // contacts remain separate, including contradictory ones.
  const minimal = candidates.filter(node => !candidates.some(other => other !== node && within(other, node)));
  if (minimal.length !== 1) return failure();
  const cards: Array<NonNullable<ReturnType<typeof semanticCard>>> = [];
  let contactEmail: string | undefined;
  for (const node of minimal) {
    const descendants = nodes(node), links = descendants.filter(n => n.tagName === "a" && (attr(n, "href") ?? "").startsWith("tel:"));
    const emails = descendants.filter(n => n.tagName === "a" && /^mailto:/iu.test(attr(n, "href") ?? ""));
    if (emails.length > 1 || emails.some(n => !publicContactEmail(n))) return failure();
    contactEmail = emails[0] ? publicContactEmail(emails[0]) : undefined;
    // A page wrapper, navigation section or multiple business blocks cannot
    // become a contact by collecting its individually convenient descendants.
    if (descendants.some(n => n.tagName === "h1" || n !== node && ["section", "article", "footer"].includes(n.tagName) ||
        n.tagName === "a" && !(attr(n, "href") ?? "").startsWith("tel:") && !publicContactEmail(n)) || descendants.length > 80) return failure();
    // A second named physical contact is contradictory evidence, not an
    // unrelated row to discard until one convenient match survives.
    if (links.length !== 1 || normalizePublicCoursePhone((attr(links[0], "href") ?? "").slice(4)) !== phone || normalizePublicCoursePhone(text(links[0])) !== phone) return failure();
    const parsed = semanticCard(contactText(node), expected, contactEmail);
    if (!parsed || parsed.phone !== phone || JSON.stringify(parsed.address) !== JSON.stringify(address)) return failure();
    cards.push(parsed);
  }
  const visibleCards = visible.addressTexts.filter(value => cardName(clean(value), expected) && [...value.matchAll(phoneScalar)].length > 0);
  if (cards.length !== 1 || visibleCards.length !== 1 ||
      JSON.stringify(semanticCard(clean(visibleCards[0]), expected, contactEmail)) !== JSON.stringify(cards[0]) ||
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
export function bindForeupOfficialRouteConfiguration(contact: Contact, html: string,
  inventoryScope?: typeof FOREUP_STANDARD_PUBLIC_SCOPE): { config: ForeupPublicConfiguration; proof: ForeupOfficialRouteOwnershipProof } {
  const page = contacts.get(contact), facilityOnly = facilityRoute(contact.bookingUrl);
  let selectedRoute = route(contact.bookingUrl);
  const facilityId = selectedRoute?.facilityId ?? facilityOnly?.facilityId;
  if (!page || !facilityId || Boolean(contact.contactScope) !== Boolean(facilityOnly) ||
      !isFreshNativeOfficialIdentityPage(page, contact.officialUrl) || Buffer.byteLength(html) > 512_000) return failure();
  const { sourceWitnessSha256, ...sourceBody } = contact;
  if (sourceWitnessSha256 !== foreupOwnershipDigest(sourceBody)) return failure();
  const courses = assignment(html, "COURSES", "["), current = assignment(html, "COURSE", "{"), schedules = assignment(html, "SCHEDULES", "[");
  if (!Array.isArray(courses) || courses.length < 1 || courses.length > 30 || !Array.isArray(schedules) || schedules.length < 1 || schedules.length > 30 || !record(current)) return failure();
  if (contact.contactScope) {
    if (inventoryScope !== FOREUP_STANDARD_PUBLIC_SCOPE || courses.some(row => !record(row) || !providerId(row.course_id)) ||
        new Set(courses.map(row => providerId((row as Record<string, unknown>).course_id))).size !== courses.length ||
        schedules.some(row => !record(row) || !providerId(row.course_id) || !providerId(row.teesheet_id)) ||
        new Set(schedules.map(row => `${providerId((row as Record<string, unknown>).course_id)}:${providerId((row as Record<string, unknown>).teesheet_id)}`)).size !== schedules.length) return failure();
    const candidates = schedules.filter(row => record(row) && providerId(row.course_id) === facilityId && Array.isArray(row.booking_classes) &&
      row.booking_classes.filter(value => record(value) && providerId(value.teesheet_id) === providerId(row.teesheet_id) &&
        String(value.active) === "1" && String(value.hidden) === "0" && typeof value.name === "string" &&
        /^(?:public|public play|public tee times|online tee times)$/iu.test(value.name.trim())).length === 1);
    if (candidates.length !== 1 || !record(candidates[0])) return failure();
    selectedRoute = { facilityId, scheduleId: providerId(candidates[0].teesheet_id)! };
  }
  if (!selectedRoute) return failure();
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
  if (!hasCompleteForeupPublicScheduleScope({ html, ...selectedRoute, inventoryScope, isProvenForeignSchedule: row => {
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
  const publicCatalogSha256 = inventoryScope ? foreupPublicScheduleCatalogSha256(html) : null;
  if (inventoryScope && !publicCatalogSha256) return failure();
  const bookingClassId = providerId(publicClasses[0].booking_class_id)!;
  const provider = { providerName: String(facility.name), sheetTitle: String(sheet.title), providerAddress, ...selectedRoute, bookingClassId };
  const body = { kind: "OFFICIAL_FOREUP_ROUTE_OWNERSHIP_V1" as const, ...contact, ...provider,
    ...(inventoryScope && publicCatalogSha256 ? { inventoryScope, publicCatalogSha256 } : {}),
    providerWitnessSha256: foreupOwnershipDigest({ ...provider, phone: contact.publicCoursePhone, timeZone: contact.timeZone }) };
  return { proof: foreupOfficialRouteOwnershipProofSchema.parse({ ...body, semanticDigest: foreupOwnershipDigest(body) }),
    config: { sourceBookingUrl: contact.bookingUrl, bookingBaseUrl: contact.bookingUrl, scheduleId: selectedRoute.scheduleId, bookingClassId } };
}
