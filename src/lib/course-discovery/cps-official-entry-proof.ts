import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { fullCourseName, type OfficialIdentityPage } from "./teeitup-official-identity";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { freshNativeCanonicalRootDocument, isFreshNativeDelegatedDocument } from "./native-official-page-attestation";

type Source = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(row => row.name === key)?.value;
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const restricted = /\b(?:mailing|corporate|billing|headquarters|account|members?|profile|customer|checkout|payment|password|login|fax)\b/iu;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "input", "textarea", "select", "button"].includes(node.tagName) ||
  node.attrs.some(row => ["hidden", "inert"].includes(row.name) || row.name === "aria-hidden" && row.value === "true") ||
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/iu.test(attr(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/iu.test(attr(node, "class") ?? "") ||
  restricted.test(["id", "class", "title", "aria-label"].map(key => attr(node, key) ?? "").join(" "));
const text = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value :
  element(node) && excluded(node) ? "" : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ?
  `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const fail = (): never => { throw new Error("CPS_OFFICIAL_ENTRY_UNVERIFIED"); };
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const publicUrl = z.string().url().max(2048).refine(value => { try { const u = new URL(value); return u.href === value && u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash; } catch { return false; } });
const providerAddress = z.object({ canonicalAddress: z.object({ street: z.string(), locality: z.string(), region: z.string().regex(/^[A-Z]{2}$/u), postalCode: z.string().regex(/^\d{5}$/u), country: z.literal("US") }).strict(), unit: z.null() }).strict();
export const cpsOfficialEntryProofSchema = z.object({ kind: z.literal("OFFICIAL_TITLE_PHYSICAL_ENTRY"),
  officialUrl: publicUrl, officialPageUrl: publicUrl, bookingDocumentUrl: publicUrl, bookingUrl: publicUrl,
  venueName: z.string().min(3).max(200), canonicalAddressInput: z.string().min(15).max(1024), timeZone: z.string().min(1).max(100),
  canonicalCoursePhone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u), publishedTitle: z.string().min(3).max(500),
  rootIdentitySha256: digest, rootEntrySha256: digest, widgetEntrySha256: digest,
  entryKind: z.literal("CPS_CMS_PUBLIC_GET_V1"), providerVenueName: z.string().min(3).max(200), providerAddress,
  tenant: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), courseIds: z.array(z.number().int().positive()).length(1), catalogHash: digest,
  warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME") }).strict().refine(value => {
    try { const target = new URL(value.bookingUrl); return new URL(value.officialUrl).origin === new URL(value.bookingDocumentUrl).origin &&
      value.bookingDocumentUrl !== value.officialUrl && target.hostname === `${value.tenant}.cps.golf` && target.pathname === "/onlineresweb/search-teetime" &&
      canonical(parsePublicUSBusinessAddress(value.canonicalAddressInput)) === canonical(value.providerAddress) &&
      fullCourseName(value.venueName).replace(/\s+(?:country club|golf course)$/u, "") ===
        fullCourseName(value.providerVenueName).replace(/\s+(?:country club|golf course)$/u, "") &&
      fullCourseName(value.venueName).replace(/\s+(?:country club|golf course)$/u, "").replace(/\s/gu, "").length >= 8; } catch { return false; }
  });
export type CpsOfficialEntryProof = z.infer<typeof cpsOfficialEntryProofSchema>;
export type CpsOfficialEntryContext = { root: OfficialIdentityPage; entry: OfficialIdentityPage; source: Source;
  publishedTitle: string; rootIdentitySha256: string; rootEntrySha256: string; widgetEntrySha256: string };
const contexts = new WeakMap<CpsOfficialEntryContext, { root: OfficialIdentityPage; entry: OfficialIdentityPage; digest: string }>();
function nodes(html: string, includeForms = false) {
  if (Buffer.byteLength(html, "utf8") > 600_000) return fail();
  const all: Element[] = []; let count = 0;
  const walk = (node: Node, depth = 0) => {
    if (++count > 20_000 || depth > 64) return fail();
    if (element(node)) { if (excluded(node) || !includeForms && node.tagName === "form") return; all.push(node); }
    if ("childNodes" in node) node.childNodes.forEach(child => walk(child, depth + 1));
  }; walk(parse(html)); return all;
}
function exactTitle(title: string, source: Source) {
  const parts = title.split("|").map(clean), address = parsePublicUSBusinessAddress(source.venueAddress);
  if (!address || address.unit || parts.length > 3 || parts.filter(part => fullCourseName(part) === fullCourseName(source.venueName)).length !== 1) return false;
  const city = `${address.canonicalAddress.locality}, ${address.canonicalAddress.region}`.toLowerCase();
  return parts.every(part => fullCourseName(part) === fullCourseName(source.venueName) ||
    /^(?:public )?golf (?:course|club)$/iu.test(part) || part.toLowerCase() === city);
}
/** Additive identity: exact published title plus one complete physical contact.
 * This is deliberately separate from the existing heading/phone proof. */
export function deriveCpsRootEntry(source: Source, root: OfficialIdentityPage, canonicalPhone: unknown) {
  const native = freshNativeCanonicalRootDocument(root, source.officialUrl), visible = root.visibleEvidence,
    phone = normalizePublicCoursePhone(canonicalPhone), address = parsePublicUSBusinessAddress(source.venueAddress);
  if (!native || !visible || !phone || !address || address.unit || root.url !== source.officialUrl ||
      !exactTitle(visible.title, source) || visible.phoneTextsOmitted || visible.contactPhoneLinksOmitted ||
      visible.publicBookingEntryLinksOmitted || !visible.publicBookingEntryLinks?.length ||
      !Array.isArray(visible.phoneTexts) || !Array.isArray(visible.contactPhoneLinks)) return fail();
  const all = nodes(root.html), titles = all.filter(node => node.tagName === "title").map(node => clean(text(node)));
  if (titles.length !== 1 || titles[0] !== clean(visible.title)) return fail();
  const addresses = new Set(visible.addressTexts.map(parsePublicUSBusinessAddress).filter(Boolean).map(canonical));
  const phones = new Set(visible.phoneTexts.map(normalizePublicCoursePhone));
  const contactPairs = visible.contactPhoneLinks.map(row => {
    if (!row.href.startsWith("tel:") || normalizePublicCoursePhone(row.href.slice(4)) !== phone || normalizePublicCoursePhone(row.text) !== phone) return fail();
    return canonical([row.href, clean(row.text)]);
  });
  if (addresses.size !== 1 || !addresses.has(canonical(address)) || phones.size !== 1 || !phones.has(phone) || !contactPairs.length || contactPairs.length > 20) return fail();
  const rawContacts = new Set<string>();
  for (const anchor of all.filter(node => node.tagName === "a" && (attr(node, "href") ?? "").startsWith("tel:"))) {
    if (!contactPairs.includes(canonical([attr(anchor, "href"), clean(text(anchor))]))) continue;
    let parent: Node | undefined = anchor.parentNode ?? undefined;
    for (let depth = 0; parent && depth < 8; depth++, parent = "parentNode" in parent ? parent.parentNode ?? undefined : undefined) {
      if (!element(parent) || ["html", "body", "form"].includes(parent.tagName) || excluded(parent)) break;
      const value = clean(text(parent)); if (value.length > 700 || restricted.test(value)) continue;
      const descendants: Element[] = []; const visit = (node: Node) => { if (element(node)) { if (excluded(node) || node.tagName === "form") return; descendants.push(node); } if ("childNodes" in node) node.childNodes.forEach(visit); }; visit(parent);
      if (!descendants.some(node => /^h[1-6]$/u.test(node.tagName) && /^contact us$/iu.test(clean(text(node))))) continue;
      const found = new Set(descendants.filter(node => ["p", "span", "address"].includes(node.tagName)).map(node => parsePublicUSBusinessAddress(clean(text(node)))).filter(Boolean).map(canonical));
      const tel = descendants.filter(node => node.tagName === "a" && (attr(node, "href") ?? "").startsWith("tel:"));
      if (found.size === 1 && found.has(canonical(address)) && tel.length > 0 && tel.every(node =>
        normalizePublicCoursePhone((attr(node, "href") ?? "").slice(4)) === phone && normalizePublicCoursePhone(clean(text(node))) === phone)) rawContacts.add(canonical({ address, phone }));
    }
  }
  if (rawContacts.size !== 1) return fail();
  const pairs = visible.publicBookingEntryLinks.map(row => {
    if (!/^(?:book(?:\s+a)?\s+tee\s*time|tee\s*times?|online\s+reservations)$/iu.test(clean(row.text))) return fail();
    const target = publicUrl.safeParse(row.href); if (!target.success || row.href === root.url || new URL(row.href).origin !== new URL(root.url).origin || restricted.test(new URL(row.href).pathname)) return fail();
    if (!all.some(node => node.tagName === "a" && !attr(node, "onclick") && !attr(node, "download") &&
      new URL(attr(node, "href") ?? "", root.url).href === row.href && clean(text(node)) === clean(row.text))) return fail();
    return { href: row.href, text: clean(row.text) };
  });
  const urls = [...new Set(pairs.map(pair => pair.href))]; if (urls.length !== 1) return fail();
  return { bookingDocumentUrl: urls[0], publishedTitle: clean(visible.title), rootIdentitySha256: hash({ scope: "CANONICAL_ROOT_TITLE_PHYSICAL_CONTACT_V1", title: clean(visible.title), address, phone }),
    rootEntrySha256: hash([...new Set(pairs.map(canonical))].sort()), phone, address };
}
function configuration(encoded: string) {
  if (encoded.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return fail();
  const bytes = Buffer.from(encoded, "base64"); if (bytes.toString("base64") !== encoded) return fail();
  let value: Record<string, unknown>; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
  if (!value || Array.isArray(value) || value.newBookingEngine !== true || typeof value.baseURL !== "string" ||
      !publicUrl.safeParse(value.baseURL).success || !/^[a-z][a-z0-9-]*\.cps\.golf$/u.test(new URL(value.baseURL).hostname) ||
      new URL(value.baseURL).pathname !== "/onlineresweb/search-teetime" || !Array.isArray(value.locations) || !value.locations.length || value.locations.length > 40) return fail();
  for (const [key, item] of Object.entries(value)) {
    if (["baseURL", "newBookingEngine", "locations"].includes(key)) continue;
    if (/^show[A-Z]/u.test(key) || key === "openInNewWindow") { if (typeof item !== "boolean") return fail(); }
    else if (!/^(?:buttonText|orientation|defaultHoles|defaultPlayers|defaultTeeTime|daysInAdvance|theme|titleText|colorPicker\d+)$/u.test(key) ||
      !(item === null || typeof item === "string" && item.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(item))) return fail();
  }
  for (const location of value.locations) if (!location || typeof location !== "object" || Array.isArray(location) ||
    Object.keys(location).sort().join(",") !== "courseId,name" || typeof location.name !== "string" || location.name.length > 200 || restricted.test(location.name) ||
    typeof location.courseId !== "string" || !/^(?:0|[1-9]\d{0,9})$/u.test(location.courseId)) return fail();
  return value as Record<string, unknown> & { baseURL: string };
}
function fieldShape(fields: Array<{ name: string; tag: string; type: string }>) {
  const keys = fields.map(row => row.name).sort();
  if (!["course-id,date,players,submit,time", "course-id,date,holes,players,submit,time"].includes(keys.join(",")) ||
      fields.some(row => row.name === "date" ? row.tag !== "INPUT" || row.type !== "date" : row.name === "submit" ? row.tag !== "BUTTON" || row.type !== "submit" : row.tag !== "SELECT" || row.type !== "")) return fail();
  return [...fields].sort((a, b) => a.name.localeCompare(b.name));
}
export function registerCpsOfficialEntryContext(source: Source, root: OfficialIdentityPage, entry: OfficialIdentityPage, canonicalPhone: unknown) {
  const identity = deriveCpsRootEntry(source, root, canonicalPhone), visible = entry.visibleEvidence;
  if (!isFreshNativeDelegatedDocument(entry, source.officialUrl) || entry.url !== identity.bookingDocumentUrl ||
      !visible || visible.cpsBookingWidgetsOmitted || !visible.cpsBookingWidgets?.length || visible.cpsBookingWidgets.length > 20) return fail();
  const all = nodes(entry.html, true), witnesses: unknown[] = [], urls = new Set<string>();
  for (const widget of visible.cpsBookingWidgets) {
    const config = configuration(widget.configuration), fields = fieldShape(widget.fields);
    const raw = all.filter(node => attr(node, "data-widget-config") === widget.configuration);
    if (raw.length !== 1 || raw[0].attrs.some(row => row.name.startsWith("on")) || !raw[0].childNodes.some(node => element(node) && node.tagName === "form" &&
        (attr(node, "class") ?? "").split(/\s/u).includes("tee-time-form") && !attr(node, "action") && !attr(node, "method") && !attr(node, "onsubmit"))) return fail();
    const form = raw[0].childNodes.find(node => element(node) && node.tagName === "form")!;
    const rawFields: Array<{ name: string; tag: string; type: string }> = []; const scan = (node: Node) => {
      if (element(node) && node.attrs.some(row => row.name.startsWith("on"))) return fail();
      if (element(node) && ["input", "textarea", "select", "button"].includes(node.tagName)) rawFields.push({ name: attr(node, "name") ?? "", tag: node.tagName.toUpperCase(), type: attr(node, "type") ?? "" });
      if ("childNodes" in node) node.childNodes.forEach(scan);
    }; scan(form);
    if (canonical(fieldShape(rawFields)) !== canonical(fields)) return fail();
    urls.add(config.baseURL); witnesses.push({ config, fields });
  }
  if (urls.size !== 1) return fail();
  const context: CpsOfficialEntryContext = { root, entry, source: { ...source, bookingUrl: [...urls][0] }, publishedTitle: identity.publishedTitle,
    rootIdentitySha256: identity.rootIdentitySha256, rootEntrySha256: identity.rootEntrySha256, widgetEntrySha256: hash({ protocol: "CPS_CMS_PUBLIC_GET_V1", widgets: witnesses.map(canonical).sort() }) };
  contexts.set(context, { root, entry, digest: hash({ source: context.source, publishedTitle: context.publishedTitle, rootIdentitySha256: context.rootIdentitySha256, rootEntrySha256: context.rootEntrySha256, widgetEntrySha256: context.widgetEntrySha256 }) });
  return context;
}
export function verifyCpsOfficialEntryContext(context: CpsOfficialEntryContext, source: Source, canonicalPhone: unknown) {
  const known = contexts.get(context);
  if (!known || known.root !== context.root || known.entry !== context.entry || !freshNativeCanonicalRootDocument(context.root, source.officialUrl) ||
      !isFreshNativeDelegatedDocument(context.entry, source.officialUrl) || canonical(context.source) !== canonical(source) || known.digest !== hash({ source: context.source,
        publishedTitle: context.publishedTitle, rootIdentitySha256: context.rootIdentitySha256, rootEntrySha256: context.rootEntrySha256, widgetEntrySha256: context.widgetEntrySha256 })) return fail();
  deriveCpsRootEntry(source, context.root, canonicalPhone); return context;
}
export function bindCpsOfficialEntryProof(context: CpsOfficialEntryContext, source: Source, canonicalPhone: unknown,
  catalog: { tenant: string; courseIds: number[]; catalogHash: string }, providerVenueName: string, providerAddressValue: unknown) {
  verifyCpsOfficialEntryContext(context, source, canonicalPhone);
  return cpsOfficialEntryProofSchema.parse({ kind: "OFFICIAL_TITLE_PHYSICAL_ENTRY", officialUrl: source.officialUrl, officialPageUrl: context.root.url,
    bookingDocumentUrl: context.entry.url, bookingUrl: source.bookingUrl, venueName: source.venueName, canonicalAddressInput: source.venueAddress,
    timeZone: source.timeZone, canonicalCoursePhone: normalizePublicCoursePhone(canonicalPhone), publishedTitle: context.publishedTitle,
    rootIdentitySha256: context.rootIdentitySha256, rootEntrySha256: context.rootEntrySha256, widgetEntrySha256: context.widgetEntrySha256,
    entryKind: "CPS_CMS_PUBLIC_GET_V1", providerVenueName, providerAddress: providerAddressValue,
    tenant: catalog.tenant, courseIds: catalog.courseIds, catalogHash: catalog.catalogHash, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
}
