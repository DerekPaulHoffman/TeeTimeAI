import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { teeItUpCompleteStreetAddress, teeItUpBookAlias, publicDocumentUrl } from "./teeitup-official-booking-source";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { parseNamedContactAddress, readNamedPublicContacts } from "./public-named-contact";

const url = z.string().max(2048).refine(v => Boolean(publicDocumentUrl(v))), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(3).max(200), address = z.string().min(15).max(1024), locality = z.string().min(2).max(80);
const sourceSchema = z.object({ officialUrl: url, officialDocumentUrl: url, bookingUrl: url, bookingEntryUrl: url.optional(),
  canonicalName: name, officialBrandName: name, publicLocationName: name, brandLocationLabel: z.string().regex(/^[A-Z0-9]{2,8}$/u).nullable(),
  canonicalNameRelation: z.enum(["EXACT_PUBLIC_LOCATION_NAME", "PUBLIC_LOCATION_AND_OBSERVED_SERVICE"]), serviceRemainder: z.string().min(2).max(40).nullable(), observedServiceLabel: z.string().min(2).max(120).nullable(),
  canonicalAddress: address, officialAddress: address, canonicalLocality: locality, officialLocality: locality,
  publicCoursePhone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u),
  warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME"),
}).strict();
export type NativePhysicalContactSource = z.infer<typeof sourceSchema> & { sourceWitnessSha256: string };
export const teeItUpPhysicalContactProofSchema = sourceSchema.extend({ kind: z.literal("OFFICIAL_PHYSICAL_CONTACT_BINDING_V1"),
  providerName: name, providerAddress: address, providerLocality: locality, providerLocalityRelation: z.enum(["SAME_RECORDED", "DIFFERENT_RECORDED"]),
  sourceWitnessSha256: sha, semanticDigest: sha,
}).strict().refine(value => {
  const fields = Object.fromEntries(Object.keys(sourceSchema.shape).map(key => [key, value[key as keyof typeof value]]));
  const { semanticDigest, ...rest } = value;
  const a = teeItUpCompleteStreetAddress(value.canonicalAddress), b = parseNamedContactAddress(value.officialAddress), c = teeItUpCompleteStreetAddress(value.providerAddress);
  const relation = nameRelation(value.canonicalName, value.publicLocationName, value.observedServiceLabel ? [value.observedServiceLabel] : []);
  return (!value.bookingEntryUrl || value.bookingEntryUrl !== value.bookingUrl && value.bookingEntryUrl !== value.officialDocumentUrl) &&
    value.sourceWitnessSha256 === physicalContactDigest(fields) && semanticDigest === physicalContactDigest(rest) && Boolean(a && b && c &&
    sameExceptLocality(a, b) && sameExceptLocality(a, c) && a.locality === b.locality && a.locality === value.canonicalLocality && b.locality === value.officialLocality &&
    c.locality === value.providerLocality && value.providerLocalityRelation === (b.locality === c.locality ? "SAME_RECORDED" : "DIFFERENT_RECORDED") &&
    literal(value.providerName) === literal(value.officialBrandName) && brandLocation(value.officialBrandName, value.publicLocationName)?.label === value.brandLocationLabel &&
    relation?.canonicalNameRelation === value.canonicalNameRelation && relation?.serviceRemainder === value.serviceRemainder && relation?.observedServiceLabel === value.observedServiceLabel);
});
export type TeeItUpPhysicalContactProof = z.infer<typeof teeItUpPhysicalContactProofSchema>;
/** JSON-only binding data. This does not register a page, grant a GET or renew
 * native authority; the executor separately rebuilds the original root. */
export function physicalContactSourceData(proof: TeeItUpPhysicalContactProof): NativePhysicalContactSource {
  const parsed = teeItUpPhysicalContactProofSchema.parse(proof);
  return { ...sourceSchema.parse(Object.fromEntries(Object.keys(sourceSchema.shape).map(key => [key, parsed[key as keyof typeof parsed]]))), sourceWitnessSha256: parsed.sourceWitnessSha256 };
}
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
}
export function physicalContactDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
const clean = (v: string) => v.normalize("NFKC").replace(/\s+/gu, " ").trim();
const literal = (v: string) => clean(v).toLowerCase();
const reject = (): never => { throw new Error("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED"); };
const gateKeys = ["sourceCurrent", "canonicalAddressValid", "canonicalPhoneValid", "rawTitleUnique", "titleRawVisibleEqual", "rawBrandUnique", "brandRawVisibleMatch", "titleBrandBinding",
  "physicalBlockUnique", "physicalBrandBinding", "canonicalAddressExact", "visiblePhysicalBlockMatches", "observedServiceBinding", "rawBookingLinkPresent", "visibleBookingLinkPresent",
  "rawPhonesPresent", "rawPhoneHrefsMatch", "rawPhoneTextsMatch", "visiblePhonesPresent", "visiblePhonesMatch"] as const;
type PhysicalDiagnostic = { stage: "SOURCE" | "TITLE" | "BRAND" | "PHYSICAL_BLOCK" | "SERVICE" | "BOOKING_EDGE" | "PHONE" | "COMPLETE";
  gates: Record<typeof gateKeys[number], boolean | null>; rawCandidateCount: number | null; leafCandidateCount: number | null; distinctPhysicalCount: number | null };
const failures = new WeakMap<object, PhysicalDiagnostic>();
/** Diagnostic only: closed facts from the original failing call, never proof. */
export function getTeeItUpPhysicalContactDiagnostic(error: unknown): PhysicalDiagnostic | undefined {
  const value = error && typeof error === "object" ? failures.get(error) : undefined;
  return value ? { ...value, gates: { ...value.gates } } : undefined;
}
type FullAddress = NonNullable<ReturnType<typeof teeItUpCompleteStreetAddress>>;
function sameExceptLocality(a: FullAddress, b: FullAddress) {
  const { locality: _a, ...first } = a, { locality: _b, ...second } = b; void _a; void _b;
  return physicalContactDigest(first) === physicalContactDigest(second);
}
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attr = (n: Element, key: string) => n.attrs.find(v => v.name === key)?.value;
function excluded(n: Element) {
  return ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button", "label"].includes(n.tagName) ||
    ["hidden", "inert", "contenteditable"].some(key => attr(n, key) !== undefined) || attr(n, "aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(n, "style") ?? "") ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/u.test(attr(n, "class") ?? "") ||
    /(?:account|member|profile|customer|checkout|payment|billing|corporate|mailing|headquarters|fax)/iu.test(n.attrs.filter(v => ["id", "class", "title", "aria-label", "name"].includes(v.name)).map(v => v.value).join(" "));
}
function text(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  if (element(n) && excluded(n)) return "";
  if (element(n) && n.tagName === "br") return ", ";
  return "childNodes" in n ? n.childNodes.map(text).join(" ") : "";
}
function physicalContext(n: Element) {
  let current: Node | undefined = n;
  for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (element(current) && current.childNodes.some(c => element(c) && /^h[1-6]$/u.test(c.tagName) && /\b(?:mailing|corporate|billing|headquarters|fax)\b/iu.test(text(c)))) return false;
  return true;
}
function nodes(html: string) {
  if (Buffer.byteLength(html) > 600_000) return reject();
  const found: Element[] = [], pending: Array<[Node, number]> = [[parse(html), 0]]; let count = 0;
  while (pending.length) { const [n, depth] = pending.pop()!; if (++count > 20_000 || depth > 64) return reject();
    if (element(n) && excluded(n)) continue; if (element(n)) found.push(n);
    if ("childNodes" in n) for (const c of [...n.childNodes].reverse()) pending.push([c, depth + 1]); }
  return found;
}
/** One observed BR may wrap only the explicit terminal street-type token.
 * All observed lines remain in the parsed address; no component is filled. */
function physicalBlock(value: string) {
  if (value.length > 600) return;
  const parts = clean(value).replace(/,(?:\s*,)+/gu, ",").split(/\s*,\s*/u);
  let country = "";
  if (parts.length && /^(?:US|USA|United States(?: of America)?)$/iu.test(parts.at(-1)!)) country = parts.pop()!;
  if (parts.length !== 4 && parts.length !== 5) return;
  const publicName = parts.shift()!, statePostal = parts.pop()!, city = parts.pop()!;
  if (publicName.length < 8 || publicName.length > 200 || /^\d/u.test(publicName)) return;
  if (parts[1] !== undefined && !/^(?:road|rd|street|st|drive|dr|avenue|ave|boulevard|blvd|lane|ln|court|ct|parkway|pkwy|highway|hwy|way|circle|cir|trail|trl|terrace|ter)\.?$/iu.test(parts[1])) return;
  const observedAddress = `${parts.join(" ")}, ${city}, ${statePostal}${country ? `, ${country}` : ""}`;
  const parsed = teeItUpCompleteStreetAddress(observedAddress);
  return parsed ? { publicName, observedAddress, parsed } : undefined;
}
function nameRelation(canonicalName: string, publicName: string, serviceLabels: string[]) {
  const full = literal(canonicalName), base = literal(publicName);
  if (full === base) return { canonicalNameRelation: "EXACT_PUBLIC_LOCATION_NAME" as const, serviceRemainder: null, observedServiceLabel: null };
  const connector = [`${base} and `, `${base} & `].find(v => full.startsWith(v));
  if (!connector) return;
  const remainder = clean(canonicalName).slice(connector.length);
  if (!/^[\p{L}][\p{L} -]{1,39}$/u.test(remainder)) return;
  const words = literal(remainder).split(/\s+/u);
  const label = serviceLabels.find(v => v.length <= 120 && !/\b(?:not|no|without|isn['’]?t|aren['’]?t|doesn['’]?t|don['’]?t|unavailable|closed|private|members?|account|login|billing|mailing|corporate)\b/iu.test(v) &&
    literal(v).split(/\s+/u).some((_, i, all) => words.every((word, offset) => all[i + offset] === word)));
  return label ? { canonicalNameRelation: "PUBLIC_LOCATION_AND_OBSERVED_SERVICE" as const, serviceRemainder: remainder, observedServiceLabel: clean(label) } : undefined;
}
/** A literal branded name may carry an explicitly printed short location tag.
 * It is retained as data, never removed from global name comparison. */
function brandLocation(brand: string, publicName: string) {
  if (literal(brand) === literal(publicName)) return { label: null };
  const prefix = clean(publicName) + " (", raw = clean(brand);
  if (!raw.toLowerCase().startsWith(prefix.toLowerCase()) || !raw.endsWith(")")) return;
  const label = raw.slice(prefix.length, -1);
  return /^[A-Z0-9]{2,8}$/u.test(label) ? { label } : undefined;
}
export function deriveNativePhysicalContactSource(source: OfficialIdentitySource, page: OfficialIdentityPage, canonicalPhone: unknown, bookingEntryUrl?: string): NativePhysicalContactSource {
  const diagnostic: PhysicalDiagnostic = { stage: "SOURCE", gates: Object.fromEntries(gateKeys.map(key => [key, null])) as PhysicalDiagnostic["gates"], rawCandidateCount: null, leafCandidateCount: null, distinctPhysicalCount: null };
  const gate = (key: typeof gateKeys[number], value: boolean) => { diagnostic.gates[key] = value; return value; };
  try {
  if (!gate("sourceCurrent", Boolean(source.officialUrl && source.venueAddress && freshNativeCanonicalRootDocument(page, source.officialUrl) && page.visibleEvidence && teeItUpBookAlias(source.bookingUrl)))) return reject();
  const canonicalAddress = teeItUpCompleteStreetAddress(source.venueAddress!), phone = normalizePublicCoursePhone(canonicalPhone), visible = page.visibleEvidence;
  gate("canonicalAddressValid", Boolean(canonicalAddress)); gate("canonicalPhoneValid", Boolean(phone));
  if (!canonicalAddress || !phone || !visible) return reject();
  diagnostic.stage = "TITLE";
  const all = nodes(page.html), titles = all.filter(n => n.tagName === "title");
  if (!gate("rawTitleUnique", titles.length === 1) || !gate("titleRawVisibleEqual", clean(visible.title) === clean(text(titles[0])))) return reject();
  diagnostic.stage = "BRAND";
  const brands = all.filter(n => n.tagName === "a" && [n, n.parentNode].some(v => v && element(v) && (attr(v, "class") ?? "").split(/\s+/u).includes("site-title"))).flatMap(n => {
    try { return new URL(attr(n, "href") ?? "", page.url).href === page.url && clean(text(n)).length <= 200 ? [clean(text(n))] : []; } catch { return []; }
  });
  const distinctBrands = [...new Set(brands.map(literal))];
  if (brands.length === 0 && (visible.brandLinks?.length ?? 0) === 0) {
    // A semantic named address/telephone contact is an independent identity
    // path. Marketing headings and WordPress classes grant no authority here.
    const titleParts = clean(text(titles[0])).split(/\s*(?:\||–|—| - )\s*/u);
    if (!gate("titleBrandBinding", titleParts.length <= 3 && titleParts.some(v => literal(v) === literal(source.venueName)))) return reject();
    diagnostic.stage = "PHYSICAL_BLOCK";
    const raw = readNamedPublicContacts(page.html, source.venueName);
    const blockSchema = z.object({ name, addressText: address, phones: z.array(z.object({ href: z.string().max(80), text: z.string().max(40) }).strict()).min(1).max(8) }).strict();
    const rendered = z.array(blockSchema).min(1).max(40).safeParse(visible.namedContactBlocks);
    if (visible.namedContactBlocksOmitted || !rendered.success || !raw.length) return reject();
    const key = (row: typeof raw[number]) => physicalContactDigest({ name: literal(row.name), address: parseNamedContactAddress(row.addressText),
      phones: row.phones.map(v => ({ href: normalizePublicCoursePhone(v.href.slice(4)), text: normalizePublicCoursePhone(v.text) })) });
    const distinct = new Map(raw.map(row => [key(row), row]));
    diagnostic.rawCandidateCount = raw.length; diagnostic.leafCandidateCount = raw.length; diagnostic.distinctPhysicalCount = distinct.size;
    if (!gate("physicalBlockUnique", distinct.size === 1)) return reject();
    const block = [...distinct.values()][0], parsedAddress = parseNamedContactAddress(block.addressText);
    if (!gate("physicalBrandBinding", literal(block.name) === literal(source.venueName)) ||
      !gate("canonicalAddressExact", Boolean(parsedAddress && physicalContactDigest(parsedAddress) === physicalContactDigest(canonicalAddress))) ||
      !gate("visiblePhysicalBlockMatches", rendered.data.every(row => key(row) === key(block)) && new Set(rendered.data.map(key)).size === 1)) return reject();
    diagnostic.stage = "PHONE";
    const phoneMatch = (row: typeof raw[number]) => row.phones.length > 0 && row.phones.every(v => /^tel:/u.test(v.href) && normalizePublicCoursePhone(v.href.slice(4)) === phone && normalizePublicCoursePhone(v.text) === phone);
    gate("rawPhonesPresent", block.phones.length > 0); gate("rawPhoneHrefsMatch", block.phones.every(v => /^tel:/u.test(v.href) && normalizePublicCoursePhone(v.href.slice(4)) === phone));
    gate("rawPhoneTextsMatch", block.phones.every(v => normalizePublicCoursePhone(v.text) === phone)); gate("visiblePhonesPresent", rendered.data.every(v => v.phones.length > 0));
    if (!gate("visiblePhonesMatch", raw.every(phoneMatch) && rendered.data.every(phoneMatch))) return reject();
    diagnostic.stage = "BOOKING_EDGE";
    const bookingEdge = bookingEntryUrl ?? source.bookingUrl;
    if (bookingEntryUrl && (!publicDocumentUrl(bookingEntryUrl) || bookingEntryUrl === source.bookingUrl || bookingEntryUrl === page.url)) return reject();
    const links = all.filter(n => n.tagName === "a" && /\b(?:tee\s*times?|book|reservations?|reserve)\b/iu.test(text(n)) &&
      !/\b(?:lesson|member|login|sign in|checkout|purchase|payment|confirm|account)\b/iu.test(text(n))).filter(n => {
      try { return new URL(attr(n, "href") ?? "", page.url).href === bookingEdge; } catch { return false; }
    });
    if (!gate("rawBookingLinkPresent", links.length > 0) || !gate("visibleBookingLinkPresent", visible.linkUrls.includes(bookingEdge))) return reject();
    gate("observedServiceBinding", true);
    const data = sourceSchema.parse({ officialUrl: source.officialUrl, officialDocumentUrl: page.url, bookingUrl: source.bookingUrl, ...(bookingEntryUrl ? { bookingEntryUrl } : {}),
      canonicalName: source.venueName, officialBrandName: block.name, publicLocationName: block.name, brandLocationLabel: null,
      canonicalNameRelation: "EXACT_PUBLIC_LOCATION_NAME", serviceRemainder: null, observedServiceLabel: null,
      canonicalAddress: source.venueAddress, officialAddress: block.addressText, canonicalLocality: canonicalAddress.locality, officialLocality: parsedAddress!.locality,
      publicCoursePhone: phone, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
    diagnostic.stage = "COMPLETE";
    return { ...data, sourceWitnessSha256: physicalContactDigest(data) };
  }
  if (!gate("rawBrandUnique", brands.length > 0 && distinctBrands.length === 1) || !gate("brandRawVisibleMatch", Boolean(visible.brandLinks?.some(v => v.href === page.url && literal(v.text) === distinctBrands[0])))) return reject();
  const brand = brands[0], titleParts = clean(text(titles[0])).split(/\s*(?:\||–|—| - )\s*/u);
  if (!gate("titleBrandBinding", titleParts.length <= 3 && titleParts.some(v => literal(v) === literal(brand)) && titleParts.every(v => [literal(brand), "home", "welcome"].includes(literal(v))))) return reject();
  diagnostic.stage = "PHYSICAL_BLOCK";
  const carriers = all.filter(n => ["address", "p", "div", "li", "td"].includes(n.tagName) && physicalContext(n)).flatMap(n => { const block = physicalBlock(clean(text(n))); return block ? [{ node: n, block }] : []; });
  // An independently complete named child is the physical contact carrier.
  // Ancestor text concatenation (for example a section heading plus that
  // complete child) is not a second physical location. Separate leaf blocks
  // remain separate and must still agree uniquely.
  const carrierNodes = new Set(carriers.map(v => v.node));
  const ancestors = new Set<Element>();
  for (const { node } of carriers) { let parent: Node | undefined = node.parentNode ?? undefined;
    while (parent) { if (element(parent) && carrierNodes.has(parent)) ancestors.add(parent); parent = "parentNode" in parent ? parent.parentNode ?? undefined : undefined; } }
  const blocks = carriers.filter(v => !ancestors.has(v.node)).map(v => v.block);
  diagnostic.rawCandidateCount = carriers.length; diagnostic.leafCandidateCount = blocks.length;
  const distinct = new Map(blocks.map(v => [physicalContactDigest({ name: literal(v.publicName), address: v.parsed }), v]));
  diagnostic.distinctPhysicalCount = distinct.size;
  if (!gate("physicalBlockUnique", distinct.size === 1)) return reject();
  const physical = [...distinct.values()][0], label = brandLocation(brand, physical.publicName);
  if (!gate("physicalBrandBinding", Boolean(label)) || !gate("canonicalAddressExact", physicalContactDigest(physical.parsed) === physicalContactDigest(canonicalAddress)) ||
      !gate("visiblePhysicalBlockMatches", visible.addressTexts.some(v => { const b = physicalBlock(v); return b && literal(b.publicName) === literal(physical.publicName) && physicalContactDigest(b.parsed) === physicalContactDigest(physical.parsed); }))) return reject();
  if (!label) return reject();
  diagnostic.stage = "SERVICE";
  const publicLabels = all.filter(n => n.tagName === "a" && !nonBusinessLabel(text(n))).map(n => clean(text(n)))
    .filter(v => visible.publicBusinessLabels?.some(item => literal(item) === literal(v)));
  const relation = nameRelation(source.venueName, physical.publicName, publicLabels);
  if (!gate("observedServiceBinding", Boolean(relation)) || !relation) return reject();
  diagnostic.stage = "BOOKING_EDGE";
  const links = all.filter(n => n.tagName === "a" && /\b(?:tee\s*times?|book|reservations?|reserve)\b/iu.test(text(n)) &&
    !/\b(?:lesson|member|login|sign in|checkout|purchase|payment|confirm|account)\b/iu.test(text(n))).filter(n => {
    try { return new URL(attr(n, "href") ?? "", page.url).href === source.bookingUrl; } catch { return false; }
  });
  if (!gate("rawBookingLinkPresent", links.length > 0) || !gate("visibleBookingLinkPresent", visible.linkUrls.includes(source.bookingUrl))) return reject();
  diagnostic.stage = "PHONE";
  const contacts = all.filter(n => n.tagName === "a" && /^tel:/u.test(attr(n, "href") ?? ""));
  gate("rawPhonesPresent", contacts.length > 0); gate("rawPhoneHrefsMatch", contacts.every(n => normalizePublicCoursePhone((attr(n, "href") ?? "").slice(4)) === phone));
  gate("rawPhoneTextsMatch", contacts.every(n => normalizePublicCoursePhone(clean(text(n))) === phone)); gate("visiblePhonesPresent", Boolean(visible.phoneTexts?.length));
  gate("visiblePhonesMatch", Boolean(visible.phoneTexts?.every(v => normalizePublicCoursePhone(v) === phone)));
  if (!diagnostic.gates.rawPhonesPresent || !diagnostic.gates.rawPhoneHrefsMatch || !diagnostic.gates.rawPhoneTextsMatch || !diagnostic.gates.visiblePhonesPresent || !diagnostic.gates.visiblePhonesMatch) return reject();
  const data = sourceSchema.parse({ officialUrl: source.officialUrl, officialDocumentUrl: page.url, bookingUrl: source.bookingUrl,
    canonicalName: source.venueName, officialBrandName: brand, publicLocationName: physical.publicName, brandLocationLabel: label.label, ...relation,
    canonicalAddress: source.venueAddress, officialAddress: physical.observedAddress, canonicalLocality: canonicalAddress.locality, officialLocality: physical.parsed.locality,
    publicCoursePhone: phone, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
  diagnostic.stage = "COMPLETE";
  return { ...data, sourceWitnessSha256: physicalContactDigest(data) };
  } catch (error) { if (error && typeof error === "object") failures.set(error, { ...diagnostic, gates: { ...diagnostic.gates } }); throw error; }
}
function nonBusinessLabel(value: string) { return value.length < 2 || value.length > 120 || /\b(?:account|member|checkout|login|payment|billing|mailing|corporate|fax)\b/iu.test(value); }
export function bindTeeItUpPhysicalContactFacility(source: OfficialIdentitySource, contact: NativePhysicalContactSource, directory: unknown): { physicalContactProof: TeeItUpPhysicalContactProof; facilityId: number; courseId: string } {
  const fields = sourceSchema.safeParse(Object.fromEntries(Object.keys(sourceSchema.shape).map(key => [key, contact[key as keyof NativePhysicalContactSource]])));
  if (!fields.success || physicalContactDigest(fields.data) !== contact.sourceWitnessSha256 || contact.officialUrl !== source.officialUrl || contact.bookingUrl !== source.bookingUrl || contact.canonicalName !== source.venueName || contact.canonicalAddress !== source.venueAddress) return reject();
  const rows = z.array(z.object({ id: z.number().int().min(1).max(2147483647), courseId: z.string().min(1).max(128), name: name, address,
    timeZone: z.string().min(1).max(100), isSimulator: z.literal(false), country: z.literal("US"), phone: z.string().max(40),
    locality: locality.optional(), region: z.string().max(40).optional(), postalCode: z.string().max(10).optional() })).min(1).max(100).safeParse(directory);
  const canonicalAddress = teeItUpCompleteStreetAddress(contact.canonicalAddress);
  if (!rows.success || !canonicalAddress || new Set(rows.data.map(v => v.id)).size !== rows.data.length || new Set(rows.data.map(v => v.courseId)).size !== rows.data.length) return reject();
  const matches = rows.data.filter(v => { const a = teeItUpCompleteStreetAddress(v.address); return a && sameExceptLocality(canonicalAddress, a) &&
    v.timeZone === source.timeZone && normalizePublicCoursePhone(v.phone) === contact.publicCoursePhone; });
  if (matches.length !== 1) return reject();
  const row = matches[0], provider = teeItUpCompleteStreetAddress(row.address);
  if (!provider || literal(row.name) !== literal(contact.officialBrandName) || row.locality !== undefined && literal(row.locality) !== provider.locality ||
      row.region !== undefined && row.region.toUpperCase() !== provider.region || row.postalCode !== undefined && row.postalCode !== provider.postalCode) return reject();
  const data = { ...fields.data, kind: "OFFICIAL_PHYSICAL_CONTACT_BINDING_V1" as const, providerName: row.name, providerAddress: row.address,
    providerLocality: provider.locality, providerLocalityRelation: provider.locality === contact.officialLocality ? "SAME_RECORDED" as const : "DIFFERENT_RECORDED" as const,
    sourceWitnessSha256: contact.sourceWitnessSha256 };
  return { physicalContactProof: teeItUpPhysicalContactProofSchema.parse({ ...data, semanticDigest: physicalContactDigest(data) }), facilityId: row.id, courseId: row.courseId };
}
