import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { teeItUpCompleteStreetAddress, teeItUpBookAlias, sameTeeItUpOfficialHost, publicDocumentUrl } from "./teeitup-official-booking-source";
import { fullCourseName, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { teeItUpBookingConfigurationSchema, type TeeItUpBookingConfiguration } from "./teeitup-booking-configuration";
import { normalizePublicUSState } from "./public-us-business-address";

const sha = z.string().regex(/^[a-f0-9]{64}$/u), id = z.number().int().min(1).max(2_147_483_647);
const url = z.string().max(2048).refine(v => Boolean(publicDocumentUrl(v)));
const streetType = z.enum(["rd", "st", "dr", "ave", "blvd", "ln", "ct", "pkwy", "hwy", "way", "cir", "trl", "ter"]);
export const teeItUpStreetTypeOmittedProofSchema = z.object({
  kind: z.literal("OFFICIAL_STREET_TYPE_OMITTED"), officialUrl: url, officialDocumentUrl: url, bookingUrl: url,
  venueName: z.string().min(3).max(200), canonicalAddress: z.string().min(15).max(1024), providerAddress: z.string().min(15).max(1024),
  timeZone: z.string().min(1).max(100), alias: teeItUpBookingConfigurationSchema.shape.apiAlias, facilityId: id,
  courseId: z.string().min(1).max(128), configurationSha256: sha,
  canonicalStreetType: z.null(), providerStreetType: streetType,
  publicCoursePhone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u), semanticDigest: sha,
  requiredCapability: z.literal("LOCAL_CHROME"), warmTransport: z.literal("NATIVE_CHROME"),
}).strict().refine(value => {
  const { semanticDigest, ...fields } = value;
  return digest(fields) === semanticDigest;
}, "The explicit semantic witness digest must match its exact fields");
export type TeeItUpStreetTypeOmittedProof = z.infer<typeof teeItUpStreetTypeOmittedProofSchema>;
const diagnosticGates = ["officialSourcePresent", "canonicalAddressPresent", "nativeAttestationFresh", "officialUrlValid", "currentOfficialHost", "visibleEvidencePresent",
  "bookingAliasValid", "canonicalComponentsValid", "configurationValid", "canonicalPhoneValid", "venueNameValid", "directorySchemaValid", "directoryIdsUnique", "directoryCourseIdsUnique",
  "providerUniqueNameTimeZone", "configurationSoleFacilityBound", "providerComponentsValid", "nonTypeComponentsEqual", "providerPhoneMatches",
  "titleUnique", "titleNameMatches", "headingNameMatches", "foreignH1Absent", "physicalAddressPresent", "rawAddressComponentsAllMatch", "rawBookingLinkPresent", "rawBookingLinksAllExact",
  "rawTelephonePresent", "rawTelephoneAllMatch", "rawTelephoneHrefAllMatch", "rawTelephoneTextAllMatch", "visibleTitleMatches", "visibleHeadingMatches", "visibleBookingLinkMatches", "visibleAddressMatches", "visiblePhonePresent", "visiblePhoneAllMatch", "namedVisibleContactBlockPresent", "nativeAttestationFreshAfter"] as const;
export type TeeItUpStreetTypeOmittedDiagnostic = { stage: "SOURCE" | "DIRECTORY" | "COMPONENTS" | "RAW_IDENTITY" | "RAW_ADDRESS" | "BOOKING_LINK" | "RAW_PHONE" | "RENDERED" | "COMPLETE";
  gates: Record<typeof diagnosticGates[number], boolean | null> };
const failedDerivations = new WeakMap<object, TeeItUpStreetTypeOmittedDiagnostic>();
export function getTeeItUpStreetTypeOmittedDiagnostic(error: unknown): TeeItUpStreetTypeOmittedDiagnostic | undefined {
  const value = error && typeof error === "object" ? failedDerivations.get(error) : undefined;
  return value ? { stage: value.stage, gates: { ...value.gates } } : undefined;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
const clean = (v: string) => v.normalize("NFKC").replace(/\s+/gu, " ").trim();
const reject = (): never => { throw new Error("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED"); };
const directions: Record<string, string> = { n: "n", north: "n", s: "s", south: "s", e: "e", east: "e", w: "w", west: "w", ne: "ne", nw: "nw", se: "se", sw: "sw" };
const types = /^(?:road|rd|street|st|drive|dr|avenue|ave|boulevard|blvd|lane|ln|court|ct|parkway|pkwy|highway|hwy|way|circle|cir|trail|trl|terrace|ter)$/u;
/** A separate data grammar, used ONLY by this explicit omission proof. It
 * cannot return a typed address or alter any legacy identity resolver. */
function omittedAddress(value: string) {
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value) ||
      /\b(?:mailing|corporate|billing|headquarters|p\s*o\s*box)\b/iu.test(value)) return;
  const parts = clean(value).replace(/^Address\s*:\s*,?\s*/iu, "").replace(/,(?:\s*,)+/gu, ",").split(/\s*,\s*/u);
  if (parts.length === 4 && /^(?:US|USA|United States(?: of America)?)$/iu.test(parts[3])) parts.pop();
  if (parts.length !== 3 || !/^[A-Za-z .'-]{2,80}$/u.test(parts[1])) return;
  const region = /^(.{2,40})\s+(\d{5}(?:-\d{4})?)$/u.exec(parts[2]);
  const state = region && (/^[A-Z]{2}$/iu.test(region[1]) ? region[1].toUpperCase() : normalizePublicUSState(region[1]));
  const street = /^(\d{1,7})\s+(.+)$/u.exec(parts[0]);
  if (!region || !state || !street) return;
  const words = street[2].toLowerCase().replace(/\./gu, "").split(/\s+/u);
  let unit = "", unitType = "";
  const unitIndex = words.findIndex(v => /^(?:suite|ste|apt|apartment|unit|#)$/u.test(v) || /^#[a-z0-9-]+$/u.test(v));
  if (unitIndex >= 0) {
    const tail = words.splice(unitIndex), token = tail[0];
    unitType = /^(?:suite|ste)$/u.test(token) ? "ste" : /^(?:apt|apartment)$/u.test(token) ? "apt" : "unit";
    unit = token.startsWith("#") && token !== "#" ? token.slice(1) : tail[1];
    if (!unit || tail.length !== (token.startsWith("#") && token !== "#" ? 1 : 2) || !/^[a-z0-9-]{1,20}$/u.test(unit)) return;
  }
  const before = directions[words[0]] ? directions[words.shift()!] : "";
  const after = directions[words.at(-1)!] ? directions[words.pop()!] : "";
  if (!words.length || types.test(words.at(-1)!) || !words.every(v => /^[a-z0-9'-]+$/u.test(v))) return;
  return { number: street[1], before, street: words.join(" "), after, unitType, unit,
    locality: parts[1].toLowerCase().replace(/\./gu, ""), region: state, postalCode: region[2], country: "US" as const };
}
export function isTeeItUpStreetTypeOmissionCandidate(value: string) { return Boolean(omittedAddress(value)); }
const withoutType = (value: NonNullable<ReturnType<typeof teeItUpCompleteStreetAddress>>) => {
  const { type: _type, ...rest } = value; void _type; return rest;
};
function matchingAddress(value: string, canonical: NonNullable<ReturnType<typeof omittedAddress>>, providerType: string) {
  const typed = teeItUpCompleteStreetAddress(value.replace(/^Address\s*:\s*,?\s*/iu, ""));
  const omitted = omittedAddress(value);
  return typed ? typed.type === providerType && digest(withoutType(typed)) === digest(canonical) : Boolean(omitted && digest(omitted) === digest(canonical));
}
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attr = (n: Element, k: string) => n.attrs.find(v => v.name === k)?.value;
function excluded(n: Element) {
  return ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button", "label"].includes(n.tagName) ||
    attr(n, "hidden") !== undefined || attr(n, "inert") !== undefined || attr(n, "aria-hidden") === "true" || attr(n, "contenteditable") !== undefined ||
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
function nonPhysicalContext(n: Element) {
  let current: Node | undefined = n;
  for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current) && current.childNodes.some(child => element(child) && /^h[1-6]$/u.test(child.tagName) &&
        /\b(?:mailing|corporate|billing|headquarters|fax)\b/iu.test(text(child)))) return true;
  }
  return false;
}
function entries(html: string) {
  if (Buffer.byteLength(html) > 600_000) return reject();
  const result: Element[] = [], stack: Array<[Node, number]> = [[parse(html), 0]]; let count = 0;
  while (stack.length) {
    const [n, depth] = stack.pop()!;
    if (++count > 20_000 || depth > 64) return reject();
    if (element(n) && excluded(n)) continue;
    if (element(n)) result.push(n);
    if ("childNodes" in n) for (const child of [...n.childNodes].reverse()) stack.push([child, depth + 1]);
  }
  return result;
}
function telephoneDisplay(value: string): { kind: "PLAIN" | "COURSE" | "RESTAURANT" | "CALL_US" | "UNKNOWN"; number?: string } {
  const v = clean(value), number = normalizePublicCoursePhone(v);
  if (number) return { kind: "PLAIN", number };
  if (/^call us$/iu.test(v)) return { kind: "CALL_US" };
  const labeled = /^(.+?)\s+-\s+(Golf Course|Restaurant)$/iu.exec(v), labeledNumber = labeled && normalizePublicCoursePhone(labeled[1]);
  return labeledNumber ? { kind: /^golf course$/iu.test(labeled![2]) ? "COURSE" : "RESTAURANT", number: labeledNumber } : { kind: "UNKNOWN" };
}
const contactText = (value: string) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function within(node: Node, parent: Node) {
  for (let n: Node | undefined = node, depth = 0; n && depth < 64; depth++, n = "parentNode" in n ? n.parentNode ?? undefined : undefined) if (n === parent) return true;
  return false;
}
/** Only a complete explicitly named physical contact block can scope a label
 * such as Call Us. A separately printed Restaurant number is never course
 * phone evidence, and unknown or contradictory telephone labels fail closed. */
function scopedTelephone(all: Element[], source: OfficialIdentitySource, page: OfficialIdentityPage,
  canonical: NonNullable<ReturnType<typeof omittedAddress>>, providerType: string, phone: string) {
  const expected = fullCourseName(source.venueName);
  const anchors = all.filter(n => n.tagName === "a" && !nonPhysicalContext(n) && /^tel:/u.test(attr(n, "href") ?? ""));
  const hrefPhone = (n: Element) => normalizePublicCoursePhone((attr(n, "href") ?? "").slice(4));
  const blocks = all.filter(n => ["div", "section", "address"].includes(n.tagName) && clean(text(n)).length <= 800 &&
    n.childNodes.filter(element).filter(v => /^h[2-4]$/u.test(v.tagName)).length === 1 &&
    n.childNodes.some(v => element(v) && /^h[2-4]$/u.test(v.tagName) && fullCourseName(text(v)) === expected) &&
    all.some(v => ["address", "p"].includes(v.tagName) && within(v, n) && !nonPhysicalContext(v) && matchingAddress(clean(text(v)), canonical, providerType)) &&
    anchors.filter(v => within(v, n)).length === 1 && anchors.some(v => within(v, n) && hrefPhone(v) === phone &&
      ["CALL_US", "PLAIN", "COURSE"].includes(telephoneDisplay(text(v)).kind)));
  const block = blocks.length === 1 ? blocks[0] : undefined;
  const blockVisible = Boolean(block && page.visibleEvidence?.addressTexts.some(v => contactText(v) === contactText(text(block))) &&
    anchors.filter(v => within(v, block)).every(v => page.visibleEvidence?.linkUrls.includes(new URL(attr(v, "href")!, page.url).href)));
  const courseFields = anchors.filter(n => telephoneDisplay(text(n)).kind === "COURSE");
  const courseRaw = courseFields.length > 0 && courseFields.every(n => hrefPhone(n) === phone && telephoneDisplay(text(n)).number === phone);
  const ordinaryRaw = anchors.length > 0 && anchors.every(n => hrefPhone(n) === phone && telephoneDisplay(text(n)).kind === "PLAIN" && telephoneDisplay(text(n)).number === phone);
  const classifiedRaw = Boolean(block && blockVisible && courseRaw && anchors.every(n => {
    const label = telephoneDisplay(text(n)), href = hrefPhone(n);
    if (!href) return false;
    if (label.kind === "RESTAURANT") return label.number === href;
    if (label.kind === "CALL_US") return within(n, block) && href === phone;
    return (label.kind === "PLAIN" || label.kind === "COURSE") && label.number === phone && href === phone;
  }));
  const visible = page.visibleEvidence?.phoneTexts;
  const ordinaryVisible = Boolean(visible?.length && visible.every(v => normalizePublicCoursePhone(v) === phone));
  const courseVisible = Boolean(visible?.some(v => telephoneDisplay(v).kind === "COURSE" && telephoneDisplay(v).number === phone));
  const classifiedVisible = Boolean(classifiedRaw && courseVisible && visible?.length && visible.every(v => {
    const label = telephoneDisplay(v);
    if (label.kind === "CALL_US") return blockVisible;
    return anchors.some(n => { const raw = telephoneDisplay(text(n)); return raw.kind === label.kind && raw.number === label.number &&
      (label.kind === "RESTAURANT" || (label.kind === "COURSE" || label.kind === "PLAIN") && label.number === phone); });
  }));
  return { anchors, blockVisible, rawValid: ordinaryRaw || classifiedRaw, visibleValid: ordinaryVisible && ordinaryRaw || classifiedVisible,
    visiblePresent: Boolean(visible?.some(v => normalizePublicCoursePhone(v) === phone)) || courseVisible && blockVisible };
}
function sourceTitleMatches(value: string, expected: string, namedPhysicalContact: boolean) {
  const parts = clean(value).split(/\s*(?:\||–|—| - )\s*/u), brand = expected.replace(/\bgolf course$/u, "golf");
  return parts.length <= 3 && parts.some(v => fullCourseName(v) === expected || namedPhysicalContact && brand !== expected && fullCourseName(v) === brand) &&
    parts.every(v => [expected, ...(namedPhysicalContact ? [brand] : []), "home", "welcome"].includes(fullCourseName(v)));
}
function noForeignCourseHeading(headings: Element[], expected: string) {
  // Decorative/marketing H1s confer no venue identity. A conflicting named
  // golf course still rejects; the exact full canonical heading is required.
  return !headings.some(n => n.tagName === "h1" && /\bgolf (?:course|club)\b/u.test(fullCourseName(text(n))) &&
    fullCourseName(clean(text(n)).replace(/^welcome to\s+/iu, "")) !== expected);
}
/** Fresh native identity is controller authority; serialized proof JSON and
 * phone equality alone can never establish it. No missing suffix is invented. */
function deriveProof(source: OfficialIdentitySource, page: OfficialIdentityPage, directory: unknown,
  configuration: TeeItUpBookingConfiguration, canonicalPhone: unknown, diagnostic: TeeItUpStreetTypeOmittedDiagnostic): TeeItUpStreetTypeOmittedProof {
  const gate = (key: typeof diagnosticGates[number], value: boolean) => { diagnostic.gates[key] = value; return value; };
  if (!gate("officialSourcePresent", Boolean(source.officialUrl)) || !gate("canonicalAddressPresent", Boolean(source.venueAddress)) ||
      !gate("nativeAttestationFresh", isFreshNativeOfficialIdentityPage(page, source.officialUrl!)) ||
      !gate("officialUrlValid", Boolean(publicDocumentUrl(source.officialUrl!))) || !gate("currentOfficialHost", sameTeeItUpOfficialHost(page.url, source.officialUrl!)) ||
      !gate("visibleEvidencePresent", Boolean(page.visibleEvidence))) return reject();
  const alias = teeItUpBookAlias(source.bookingUrl), canonical = omittedAddress(source.venueAddress!), config = teeItUpBookingConfigurationSchema.safeParse(configuration);
  const phone = normalizePublicCoursePhone(canonicalPhone), expected = fullCourseName(source.venueName);
  const rows = z.array(z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(3).max(256), address: z.string().min(15).max(1024),
    timeZone: z.string().min(1).max(100), country: z.literal("US"), isSimulator: z.literal(false), phone: z.string().max(40) })).min(1).max(100).safeParse(directory);
  diagnostic.stage = "DIRECTORY";
  if (!gate("bookingAliasValid", Boolean(alias)) || !gate("canonicalComponentsValid", Boolean(canonical)) || !gate("configurationValid", config.success) ||
      !gate("canonicalPhoneValid", Boolean(phone)) || !gate("venueNameValid", expected.length >= 8) || !gate("directorySchemaValid", rows.success)) return reject();
  if (!alias || !canonical || !config.success || !phone || !rows.success) return reject(); // Type narrowing only; the same predicates are evaluated above.
  if (!gate("directoryIdsUnique", new Set(rows.data.map(v => v.id)).size === rows.data.length) ||
      !gate("directoryCourseIdsUnique", new Set(rows.data.map(v => v.courseId)).size === rows.data.length)) return reject();
  const matches = rows.data.filter(v => fullCourseName(v.name) === expected && v.timeZone === source.timeZone);
  if (!gate("providerUniqueNameTimeZone", matches.length === 1) ||
      !gate("configurationSoleFacilityBound", config.data.facilityIds.length === 1 && config.data.facilityIds[0] === matches[0].id)) return reject();
  diagnostic.stage = "COMPONENTS";
  const selected = matches[0], provider = teeItUpCompleteStreetAddress(selected.address);
  if (!gate("providerComponentsValid", Boolean(provider))) return reject();
  if (!provider) return reject();
  if (!gate("nonTypeComponentsEqual", digest(withoutType(provider)) === digest(canonical)) ||
      !gate("providerPhoneMatches", normalizePublicCoursePhone(selected.phone) === phone)) return reject();
  diagnostic.stage = "RAW_IDENTITY";
  const all = entries(page.html), titles = all.filter(n => n.tagName === "title"), headings = all.filter(n => ["h1", "h2"].includes(n.tagName));
  const contact = scopedTelephone(all, source, page, canonical, provider.type, phone);
  const heading = (v: string) => fullCourseName(clean(v).replace(/^welcome to\s+/iu, ""));
  if (!gate("titleUnique", titles.length === 1) || !gate("titleNameMatches", sourceTitleMatches(text(titles[0]), expected, contact.blockVisible)) ||
      !gate("headingNameMatches", headings.some(n => heading(text(n)) === expected)) || !gate("foreignH1Absent", noForeignCourseHeading(headings, expected))) return reject();
  diagnostic.stage = "RAW_ADDRESS";
  const addresses = all.filter(n => ["address", "p", "div", "li", "td"].includes(n.tagName) && !nonPhysicalContext(n)).map(n => clean(text(n))).filter(v => v.length <= 500 && (omittedAddress(v) || teeItUpCompleteStreetAddress(v)));
  if (!gate("physicalAddressPresent", addresses.length > 0) || !gate("rawAddressComponentsAllMatch", addresses.every(v => matchingAddress(v, canonical, provider.type)))) return reject();
  diagnostic.stage = "BOOKING_LINK";
  const bookingLinks = all.filter(n => n.tagName === "a" && /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text(n))).flatMap(n => {
    try { const href = new URL(attr(n, "href") ?? "", page.url).href; return teeItUpBookAlias(href) ? [href] : []; } catch { return []; }
  });
  if (!gate("rawBookingLinkPresent", bookingLinks.length > 0) || !gate("rawBookingLinksAllExact", bookingLinks.every(v => v === source.bookingUrl))) return reject();
  diagnostic.stage = "RAW_PHONE";
  if (!gate("rawTelephonePresent", contact.anchors.length > 0) || !gate("rawTelephoneAllMatch", contact.rawValid)) return reject();
  diagnostic.stage = "RENDERED";
  const visible = page.visibleEvidence!;
  if (!gate("visibleTitleMatches", clean(visible.title) === clean(text(titles[0]))) || !gate("visibleHeadingMatches", visible.headings.some(v => heading(v) === expected)) ||
      !gate("visibleBookingLinkMatches", visible.linkUrls.includes(source.bookingUrl)) || !gate("visibleAddressMatches", visible.addressTexts.some(v => matchingAddress(v, canonical, provider.type))) ||
      !gate("visiblePhonePresent", contact.visiblePresent) || !gate("visiblePhoneAllMatch", contact.visibleValid)) return reject();
  const proof = { kind: "OFFICIAL_STREET_TYPE_OMITTED" as const, officialUrl: source.officialUrl, officialDocumentUrl: page.url, bookingUrl: source.bookingUrl,
    venueName: source.venueName, canonicalAddress: source.venueAddress, providerAddress: selected.address, timeZone: source.timeZone,
    alias, facilityId: selected.id, courseId: selected.courseId, configurationSha256: digest(config.data), canonicalStreetType: null,
    providerStreetType: streetType.parse(provider.type), publicCoursePhone: phone, requiredCapability: "LOCAL_CHROME" as const, warmTransport: "NATIVE_CHROME" as const };
  diagnostic.stage = "COMPLETE";
  return teeItUpStreetTypeOmittedProofSchema.parse({ ...proof, semanticDigest: digest(proof) });
}
export function bindTeeItUpStreetTypeOmittedProof(source: OfficialIdentitySource, page: OfficialIdentityPage, directory: unknown,
  configuration: TeeItUpBookingConfiguration, canonicalPhone: unknown): TeeItUpStreetTypeOmittedProof {
  const diagnostic: TeeItUpStreetTypeOmittedDiagnostic = { stage: "SOURCE", gates: Object.fromEntries(diagnosticGates.map(key => [key, null])) as TeeItUpStreetTypeOmittedDiagnostic["gates"] };
  try { return deriveProof(source, page, directory, configuration, canonicalPhone, diagnostic); }
  catch (error) { if (error && typeof error === "object") failedDerivations.set(error, diagnostic); throw error; }
  finally {
    try {
      const observed = observeTeeItUpStreetTypeOmittedFacts(source, page, directory, configuration, canonicalPhone);
      for (const key of diagnosticGates) if (diagnostic.gates[key] === null) diagnostic.gates[key] = observed[key];
      diagnostic.gates.nativeAttestationFreshAfter = Boolean(source.officialUrl && isFreshNativeOfficialIdentityPage(page, source.officialUrl));
    } catch { /* Independent observations never replace the primary error. */ }
  }
}
/** All facts are evaluated independently for bounded engineering diagnosis.
 * These booleans never grant proof or replace the original rejection order. */
export function observeTeeItUpStreetTypeOmittedFacts(source: OfficialIdentitySource, page: OfficialIdentityPage, directory: unknown,
  configuration: TeeItUpBookingConfiguration, canonicalPhone: unknown): TeeItUpStreetTypeOmittedDiagnostic["gates"] {
  const gates = Object.fromEntries(diagnosticGates.map(key => [key, null])) as TeeItUpStreetTypeOmittedDiagnostic["gates"];
  const note = (key: typeof diagnosticGates[number], work: () => boolean) => { try { gates[key] = Boolean(work()); } catch { /* Unobservable stays null. */ } };
  const canonical = omittedAddress(source.venueAddress ?? ""), phone = normalizePublicCoursePhone(canonicalPhone), expected = fullCourseName(source.venueName);
  note("officialSourcePresent", () => Boolean(source.officialUrl)); note("canonicalAddressPresent", () => Boolean(source.venueAddress));
  note("nativeAttestationFresh", () => Boolean(source.officialUrl && isFreshNativeOfficialIdentityPage(page, source.officialUrl)));
  note("officialUrlValid", () => Boolean(source.officialUrl && publicDocumentUrl(source.officialUrl)));
  note("currentOfficialHost", () => Boolean(source.officialUrl && sameTeeItUpOfficialHost(page.url, source.officialUrl)));
  note("visibleEvidencePresent", () => Boolean(page.visibleEvidence)); note("bookingAliasValid", () => Boolean(teeItUpBookAlias(source.bookingUrl)));
  note("canonicalComponentsValid", () => Boolean(canonical)); note("configurationValid", () => teeItUpBookingConfigurationSchema.safeParse(configuration).success);
  note("canonicalPhoneValid", () => Boolean(phone)); note("venueNameValid", () => expected.length >= 8);
  const rows = z.array(z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(3).max(256), address: z.string().min(15).max(1024),
    timeZone: z.string().min(1).max(100), country: z.literal("US"), isSimulator: z.literal(false), phone: z.string().max(40) })).min(1).max(100).safeParse(directory);
  note("directorySchemaValid", () => rows.success);
  const matches = rows.success ? rows.data.filter(v => fullCourseName(v.name) === expected && v.timeZone === source.timeZone) : [];
  const provider = matches.length === 1 ? teeItUpCompleteStreetAddress(matches[0].address) : undefined;
  if (rows.success) {
    note("directoryIdsUnique", () => new Set(rows.data.map(v => v.id)).size === rows.data.length);
    note("directoryCourseIdsUnique", () => new Set(rows.data.map(v => v.courseId)).size === rows.data.length);
    note("providerUniqueNameTimeZone", () => matches.length === 1);
  }
  note("configurationSoleFacilityBound", () => matches.length === 1 && configuration.facilityIds.length === 1 && configuration.facilityIds[0] === matches[0].id);
  note("providerComponentsValid", () => Boolean(provider));
  if (canonical && provider) note("nonTypeComponentsEqual", () => digest(withoutType(provider)) === digest(canonical));
  if (matches.length === 1) note("providerPhoneMatches", () => Boolean(phone && normalizePublicCoursePhone(matches[0].phone) === phone));
  let all: Element[];
  try { all = entries(page.html); } catch { return gates; }
  const contact = canonical && provider && phone ? scopedTelephone(all, source, page, canonical, provider.type, phone) : undefined;
  const titles = all.filter(n => n.tagName === "title"), headings = all.filter(n => ["h1", "h2"].includes(n.tagName));
  const heading = (v: string) => fullCourseName(clean(v).replace(/^welcome to\s+/iu, ""));
  note("titleUnique", () => titles.length === 1);
  if (titles.length === 1) note("titleNameMatches", () => sourceTitleMatches(text(titles[0]), expected, contact?.blockVisible ?? false));
  note("headingNameMatches", () => headings.some(n => heading(text(n)) === expected));
  note("foreignH1Absent", () => noForeignCourseHeading(headings, expected));
  const addresses = all.filter(n => ["address", "p", "div", "li", "td"].includes(n.tagName) && !nonPhysicalContext(n)).map(n => clean(text(n)))
    .filter(v => v.length <= 500 && (omittedAddress(v) || teeItUpCompleteStreetAddress(v)));
  note("physicalAddressPresent", () => addresses.length > 0);
  if (canonical && provider) note("rawAddressComponentsAllMatch", () => addresses.every(v => matchingAddress(v, canonical, provider.type)));
  const bookingLinks = all.filter(n => n.tagName === "a" && /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text(n))).flatMap(n => {
    try { const href = new URL(attr(n, "href") ?? "", page.url).href; return teeItUpBookAlias(href) ? [href] : []; } catch { return []; }
  });
  note("rawBookingLinkPresent", () => bookingLinks.length > 0); note("rawBookingLinksAllExact", () => bookingLinks.every(v => v === source.bookingUrl));
  const anchors = all.filter(n => n.tagName === "a" && !nonPhysicalContext(n) && /^tel:/u.test(attr(n, "href") ?? ""));
  note("rawTelephonePresent", () => anchors.length > 0);
  note("rawTelephoneHrefAllMatch", () => anchors.every(n => Boolean(phone && normalizePublicCoursePhone((attr(n, "href") ?? "").slice(4)) === phone)));
  note("rawTelephoneTextAllMatch", () => anchors.every(n => Boolean(phone && normalizePublicCoursePhone(clean(text(n))) === phone)));
  note("rawTelephoneAllMatch", () => contact?.rawValid ?? (gates.rawTelephoneHrefAllMatch === true && gates.rawTelephoneTextAllMatch === true));
  const visible = page.visibleEvidence;
  if (visible) {
    if (titles.length === 1) note("visibleTitleMatches", () => clean(visible.title) === clean(text(titles[0])));
    note("visibleHeadingMatches", () => visible.headings.some(v => heading(v) === expected)); note("visibleBookingLinkMatches", () => visible.linkUrls.includes(source.bookingUrl));
    if (canonical && provider) note("visibleAddressMatches", () => visible.addressTexts.some(v => matchingAddress(v, canonical, provider.type)));
    note("visiblePhonePresent", () => contact?.visiblePresent ?? Boolean(visible.phoneTexts?.some(v => normalizePublicCoursePhone(v) === phone)));
    if (visible.phoneTexts) note("visiblePhoneAllMatch", () => contact?.visibleValid ?? visible.phoneTexts!.every(v => normalizePublicCoursePhone(v) === phone));
    note("namedVisibleContactBlockPresent", () => contact?.blockVisible ?? false);
  }
  note("nativeAttestationFreshAfter", () => Boolean(source.officialUrl && isFreshNativeOfficialIdentityPage(page, source.officialUrl)));
  return gates;
}
/** JSON-only source/directory binding, used after a fresh native derivation. */
export function matchesTeeItUpStreetTypeOmittedDirectory(proof: TeeItUpStreetTypeOmittedProof, source: OfficialIdentitySource,
  directory: unknown, configuration: TeeItUpBookingConfiguration) {
  const { semanticDigest, ...rest } = proof;
  if (digest(rest) !== semanticDigest || digest(configuration) !== proof.configurationSha256 || proof.officialUrl !== source.officialUrl ||
      proof.bookingUrl !== source.bookingUrl || proof.venueName !== source.venueName || proof.canonicalAddress !== source.venueAddress ||
      proof.timeZone !== source.timeZone || proof.alias !== teeItUpBookAlias(source.bookingUrl) || !Array.isArray(directory)) return false;
  const rows = directory.filter(v => v && typeof v === "object");
  return rows.length === directory.length && new Set(rows.map(v => v.id)).size === rows.length && new Set(rows.map(v => v.courseId)).size === rows.length &&
    rows.filter(v => fullCourseName(v.name) === fullCourseName(source.venueName)).length === 1 && rows.some(v => v.id === proof.facilityId &&
      v.courseId === proof.courseId && v.address === proof.providerAddress && v.timeZone === proof.timeZone && v.isSimulator === false && v.country === "US" &&
      normalizePublicCoursePhone(v.phone) === proof.publicCoursePhone && fullCourseName(v.name) === fullCourseName(source.venueName));
}
