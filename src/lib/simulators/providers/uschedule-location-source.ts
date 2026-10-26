import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import type { OfficialIdentityPage } from "@/lib/course-discovery/teeitup-official-identity";
import type { OfficialSourceDiagnostic } from "@/lib/course-discovery/official-source-diagnostics";
import { isUSchedulePublicHost } from "./public-configuration";
import { parsePublicUSBusinessAddress } from "@/lib/course-discovery/public-us-business-address";
import { normalizePublicCoursePhone } from "@/lib/course-discovery/teeitup-postal-conflict-proof";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const id = z.string().regex(/^[1-9]\d{0,9}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const nameKey = (value: string) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(): never { throw new Error("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED"); }
export const USCHEDULE_LOCATION_CLIENT = Object.freeze({ path: "/bundles/js/bookingBS5",
  sha256: "569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e" });

/** A public location filter is source context, never a selected appointment. */
export function parseUScheduleLocationSource(value: string) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return;
  try {
    const url = new URL(value), tenant = /^\/([a-z](?:[a-z0-9-]{1,61}[a-z0-9]))\/booking$/u.exec(url.pathname)?.[1];
    if (!tenant || url.protocol !== "https:" || !isUSchedulePublicHost(url.hostname) || url.port || url.username || url.password || url.hash ||
        url.hostname === "iframe.uschedule.com" && url.search) return;
    const keys = [...url.searchParams.keys()];
    if (keys.length > 1 || keys.some(key => key !== "filter")) return;
    const filter = url.searchParams.get("filter");
    const locationId = filter === null ? undefined : /^loc\[([1-9]\d{0,9})\]$/u.exec(filter)?.[1];
    if (filter !== null && !locationId) return;
    return { tenant, url: url.href, canonicalUrl: `${url.origin}${url.pathname}`, locationId };
  } catch { return; }
}

const legacyOfficialLocationProofSchema = z.object({
  kind: z.literal("OFFICIAL_PUBLIC_LOCATION_V1"), officialPageUrl: z.string().url().max(2048),
  entryUrl: z.string().max(2048).refine(value => Boolean(parseUScheduleLocationSource(value)?.locationId)),
  locationId: id, venueName: z.string().min(3).max(200), addressKey: z.string().min(15).max(1024), markupWitnessSha256: sha,
}).strict();
const contactOfficialLocationProofSchema = z.object({
  kind: z.literal("OFFICIAL_PUBLIC_LOCATION_CONTACT_V1"), officialPageUrl: z.string().url().max(2048),
  entryUrl: z.string().max(2048).refine(value => Boolean(parseUScheduleLocationSource(value)?.locationId)), locationId: id,
  venueName: z.string().min(3).max(200), addressKey: z.string().min(15).max(1024), locality: z.string().min(2).max(80),
  region: z.string().regex(/^[A-Z]{2}$/u), phoneSha256: sha, markupWitnessSha256: sha,
}).strict();
export const uscheduleOfficialLocationProofSchema = z.discriminatedUnion("kind", [legacyOfficialLocationProofSchema, contactOfficialLocationProofSchema]);
export type UScheduleOfficialLocationProof = z.infer<typeof uscheduleOfficialLocationProofSchema>;
const legacyPublicLocationProofSchema = z.object({
  kind: z.literal("PUBLIC_LOCATION_RENTAL_V1"), official: legacyOfficialLocationProofSchema,
  locationId: id, locationName: z.string().min(3).max(200), catalogHash: sha,
  includedPartySize: z.literal(2), maxPartySize: z.literal(4),
  resourceGroups: z.array(z.object({ id, resources: z.array(z.object({ id, name: z.string().min(3).max(200) }).strict()).min(1).max(20) }).strict()).length(1),
  client: z.object({ path: z.literal("/bundles/js/bookingBS5"),
    sha256: z.literal("569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e") }).strict(),
}).strict();
const publicLocationServicePoolProofSchema = z.object({
  kind: z.literal("PUBLIC_LOCATION_SERVICE_POOL_V1"), official: contactOfficialLocationProofSchema,
  locationId: id, locationName: z.string().min(3).max(200), catalogHash: sha,
  serviceId: id, serviceName: z.string().min(3).max(200), maxPartySize: z.number().int().min(1).max(99).nullable(),
  client: z.object({ path: z.literal("/bundles/js/bookingBS5"), sha256: z.literal("569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e") }).strict(),
}).strict().refine(value => value.locationId === value.official.locationId && nameKey(value.locationName) === nameKey(`${value.official.locality} - ${value.official.venueName}`) &&
  nameKey(value.serviceName) === nameKey(`Simulator Rental - ${value.official.locality}`));
export const uschedulePublicLocationProofSchema = z.discriminatedUnion("kind", [legacyPublicLocationProofSchema, publicLocationServicePoolProofSchema]);
export type USchedulePublicLocationProof = z.infer<typeof uschedulePublicLocationProofSchema>;
export function isUScheduleNonMemberRental(value: string) { return /^non-member hourly rental$/u.test(clean(value).toLowerCase()); }

const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(value => value.name === key)?.value;
const children = (node: Node) => "childNodes" in node ? node.childNodes.filter(element) : [];
const classes = (node: Element) => (attr(node, "class") ?? "").split(/\s+/u);
function within(node: Node, ancestor: Element): boolean {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (current === ancestor) return true;
  return false;
}
function hidden(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current) && (["script", "style", "template", "noscript", "iframe"].includes(current.tagName) ||
      attr(current, "hidden") !== undefined || attr(current, "inert") !== undefined || attr(current, "aria-hidden") === "true" ||
      /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only)(?:\s|$)/iu.test(attr(current, "class") ?? "") ||
      /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:[.;]|$)/iu.test(attr(current, "style") ?? ""))) return true;
  }
  return false;
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && (["script", "style", "template", "noscript", "iframe", "input", "textarea"].includes(node.tagName) || hidden(node))) return "";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function nodes(html: string) {
  if (Buffer.byteLength(html) > 600_000) return fail();
  const found: Element[] = [], stack: Array<{ node: Node; depth: number }> = [{ node: parse(html), depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 80 || found.length > 20_000) return fail();
    if (element(node)) found.push(node);
    if ("childNodes" in node) for (const child of [...node.childNodes].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  return found;
}
function addressKey(value: string) {
  return clean(value).toLowerCase().replace(/\b(?:united states of america|united states|usa)\b/gu, "us")
    .replace(/\b(?:suite|ste)\b|#/gu, " ste ")
    .replace(/\b(?:street|road|drive|avenue|boulevard)\b/gu, word => ({ street: "st", road: "rd", drive: "dr", avenue: "ave", boulevard: "blvd" })[word]!)
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/ us$/u, "");
}
function witness(node: Element) {
  const ancestry: unknown[] = []; let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value => ["id", "class", "style", "hidden", "inert", "aria-hidden", "href"].includes(value.name))
      .map(value => [value.name, value.value]).sort()]);
  return [clean(text(node)), ancestry];
}
/** A bounded suite spelling equivalence; the unit remains part of identity. */
function contactAddress(value: string) {
  const canonical = clean(value).replace(/\b((?:dr(?:ive)?|rd|road|st(?:reet)?|ave(?:nue)?|blvd|boulevard|ln|lane|ct|court|pkwy|parkway|hwy|highway|cir(?:cle)?|trl|trail|ter(?:race)?|way)\.?)\s+(?:(?:suite|ste)\.?\s+)?([A-Za-z]|\d{1,8}|[A-Za-z]\d{1,7})(?=\s*,)/iu,
    (_all, suffix: string, unit: string) => /^[NSEW]$/iu.test(unit) ? `${suffix} ${unit}` : `${suffix}, Suite ${unit}`);
  const parsed = parsePublicUSBusinessAddress(canonical), postal = /\b(\d{5}(?:-\d{4})?)(?:\s*,\s*(?:US|USA|United States(?: of America)?))?\s*$/iu.exec(canonical)?.[1];
  return parsed && postal ? { ...parsed, postalCodeFull: postal } : null;
}
function deriveBranchContact(source: Source, page: UScheduleOfficialIdentityPage, all: Element[], phone: string | undefined) {
  const address = source.venueAddress && contactAddress(source.venueAddress), canonicalPhone = normalizePublicCoursePhone(phone);
  if (!address || !canonicalPhone || page.browserTransport !== "NATIVE_CHROME" || !page.visibleEvidence || !source.officialUrl) return fail();
  const current = new URL(page.url), expectedName = nameKey(source.venueName), forms = all.filter(n => n.tagName === "form");
  const allowedForm = forms.length === 1 && forms[0].parentNode && element(forms[0].parentNode) && forms[0].parentNode.tagName === "body" &&
    (attr(forms[0], "method") ?? "get").toLowerCase() === "post" && new URL(attr(forms[0], "action") ?? current.href, current).href === current.href ? forms[0] : undefined;
  const eligible = (n: Element) => {
    let p: Node | undefined = n;
    for (let depth = 0; p && depth < 80; depth++, p = "parentNode" in p ? p.parentNode ?? undefined : undefined) if (element(p) &&
      (hidden(p) || p.tagName === "form" && p !== allowedForm || ["input", "select", "button", "textarea", "label"].includes(p.tagName) ||
       /\b(?:private|members?|account|profile|checkout|payment|billing|mailing|corporate)\b/iu.test([attr(p, "id"), attr(p, "class"), attr(p, "aria-label")].join(" ")))) return false;
    return p === undefined;
  };
  const branchHeading = (value: string) => [nameKey(address.canonicalAddress.locality), nameKey(`${address.canonicalAddress.locality} ${address.canonicalAddress.region}`)].includes(nameKey(value));
  const headings = all.filter(n => n.tagName === "h1" && eligible(n));
  if (expectedName.length < 8 || headings.length !== 1 || !branchHeading(text(headings[0]))) return fail();
  const brands = all.filter(n => n.tagName === "a" && eligible(n)).filter(n => {
    try { const u = new URL(attr(n, "href") ?? "", current); return u.origin === current.origin && u.pathname === "/" && !u.search && !u.hash &&
      all.some(i => i.tagName === "img" && within(i, n) && eligible(i) && nameKey(attr(i, "alt") ?? "") === expectedName); } catch { return false; }
  });
  if (!brands.length || new Set(brands.map(n => new URL(attr(n, "href")!, current).href)).size !== 1) return fail();
  const addressNodes = all.filter(n => ["p", "address", "div", "li", "td"].includes(n.tagName) && eligible(n) && clean(text(n)).length <= 500)
    .map(node => ({ node, parsed: contactAddress(text(node)) })).filter(row => row.parsed !== null);
  const addressIdentity = JSON.stringify(address), matching = addressNodes.filter(row => JSON.stringify(row.parsed) === addressIdentity);
  if (!matching.length || addressNodes.some(row => JSON.stringify(row.parsed!.canonicalAddress) === JSON.stringify(address.canonicalAddress) && JSON.stringify(row.parsed) !== addressIdentity)) return fail();
  const phones = all.filter(n => ["p", "a", "span", "div"].includes(n.tagName) && eligible(n) && clean(text(n)).length <= 40)
    .map(node => ({ node, phone: normalizePublicCoursePhone(clean(text(node))) })).filter(row => row.phone !== undefined);
  const contacts = all.filter(n => ["div", "section", "address", "li", "td"].includes(n.tagName) && eligible(n) && clean(text(n)).length <= 1200 &&
    matching.some(a => within(a.node, n)) && phones.some(p => p.phone === canonicalPhone && within(p.node, n)) &&
    !phones.some(p => p.phone !== canonicalPhone && within(p.node, n)));
  if (!contacts.length) return fail();
  const booking = parseUScheduleLocationSource(source.bookingUrl)!;
  const links = all.filter(n => n.tagName === "a" && eligible(n) && /\b(?:tee\s*time|book|rental|reservation)/iu.test(text(n))).flatMap(node => {
    try { const v = parseUScheduleLocationSource(new URL(attr(node, "href") ?? "", current).href); return v?.locationId && v.canonicalUrl === booking.canonicalUrl ? [{ node, value: v }] : []; } catch { return []; }
  });
  if (!links.length || new Set(links.map(l => l.value.url)).size !== 1 || booking.locationId !== links[0].value.locationId) return fail();
  const visible = page.visibleEvidence;
  if (!visible.headings.some(branchHeading) || !visible.brandLinks?.some(b => nameKey(b.text) === expectedName && b.href === new URL(attr(brands[0], "href")!, current).href) ||
      !visible.addressTexts.some(v => JSON.stringify(contactAddress(v)) === addressIdentity) || !visible.phoneTexts?.some(v => normalizePublicCoursePhone(v) === canonicalPhone) || !visible.linkUrls.includes(links[0].value.url)) return fail();
  return contactOfficialLocationProofSchema.parse({ kind: "OFFICIAL_PUBLIC_LOCATION_CONTACT_V1", officialPageUrl: current.href, entryUrl: links[0].value.url,
    locationId: links[0].value.locationId, venueName: source.venueName, addressKey: addressIdentity, locality: address.canonicalAddress.locality,
    region: address.canonicalAddress.region, phoneSha256: digest(canonicalPhone), markupWitnessSha256: digest({ address, phoneSha256: digest(canonicalPhone),
      brand: new URL(attr(brands[0], "href")!, current).href, heading: clean(text(headings[0])), entry: links[0].value.url }) });
}
type Source = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export function sameUScheduleOfficialSite(left: string, right: string) {
  try {
    const a = new URL(left), b = new URL(right);
    return [a, b].every(url => url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash) &&
      a.hostname.replace(/^www\./u, "") === b.hostname.replace(/^www\./u, "");
  } catch { return false; }
}
export type UScheduleOfficialIdentityPage = OfficialIdentityPage & { officialDocumentProof?: {
  kind: "VERIFIED_OFFICIAL_DOCUMENT"; officialUrl: string; documentUrl: string;
} };
export function deriveUScheduleOfficialLocation(source: Source, page: UScheduleOfficialIdentityPage, requireVisibleEvidence = true,
  onDiagnostic?: (value: OfficialSourceDiagnostic) => void, context: { canonicalCoursePhone?: string } = {}): UScheduleOfficialLocationProof {
  const facts: OfficialSourceDiagnostic = { stage: "SOURCE_CONTEXT" };
  const emit = () => { try { onDiagnostic?.({ ...facts }); } catch { /* Diagnostics cannot change identity validation. */ } };
  const check = (condition: unknown, stage: OfficialSourceDiagnostic["stage"], key: Exclude<keyof OfficialSourceDiagnostic, "stage" | "uscheduleConfigurationGate">) => {
    facts.stage = stage; facts[key] = Boolean(condition); emit(); if (!condition) return fail();
  };
  const booking = parseUScheduleLocationSource(source.bookingUrl);
  check(booking && source.officialUrl && source.venueAddress && /^\d/u.test(source.venueAddress) && /\b\d{5}(?:-\d{4})?\b/u.test(source.venueAddress), "SOURCE_CONTEXT", "sourceContextValid");
  if (!booking || !source.officialUrl || !source.venueAddress) return fail();
  const current = new URL(page.url), official = new URL(source.officialUrl);
  check(sameUScheduleOfficialSite(current.href, official.href), "OFFICIAL_SITE", "officialSiteMatches");
  // An alias is accepted initially only after the live controller verified the
  // actual official HTTP document. Warm reads use the exact saved URL and hash.
  if (requireVisibleEvidence) check(current.origin === official.origin || page.officialDocumentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT" &&
    page.officialDocumentProof.officialUrl === source.officialUrl && page.officialDocumentProof.documentUrl === current.href, "OFFICIAL_PROVENANCE", "officialProvenance");
  facts.stage = "RAW_DOCUMENT"; emit();
  const all = nodes(page.html), expected = nameKey(source.venueName), canonicalAddress = addressKey(source.venueAddress);
  const headings = all.filter(node => node.tagName === "h1" && !hidden(node));
  if (!(expected.length >= 8 && headings.length === 1 && nameKey(text(headings[0])) === expected) && requireVisibleEvidence && context.canonicalCoursePhone) {
    const proof = deriveBranchContact(source, page, all, context.canonicalCoursePhone); facts.stage = "LOCATION_VERIFIED"; emit(); return proof;
  }
  check(expected.length >= 8 && headings.length === 1 && nameKey(text(headings[0])) === expected, "RAW_VENUE", "rawVenueMatches");
  const links = all.filter(node => node.tagName === "a" && !hidden(node) && /\b(?:tee\s*time|book|rental|reservation)/iu.test(text(node))).flatMap(node => {
    try { const value = parseUScheduleLocationSource(new URL(attr(node, "href") ?? "", current).href);
      return value?.locationId && value.canonicalUrl === booking.canonicalUrl ? [{ node, value }] : []; } catch { return []; }
  });
  check(links.length && new Set(links.map(value => value.value.url)).size === 1, "RAW_LINK", "rawLinkMatches");
  const link = links[0].value;
  check(!booking.locationId || booking.locationId === link.locationId, "RAW_LINK", "rawLinkMatches");
  const addresses = all.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName) && !hidden(node))
    .filter(node => { const value = clean(text(node)); return value.length <= 500 && (` ${addressKey(value)} `).includes(` ${canonicalAddress} `); });
  check(addresses.length, "RAW_ADDRESS", "rawAddressMatches");
  const visible = page.visibleEvidence;
  if (requireVisibleEvidence) {
    check(visible?.headings.some(value => nameKey(value) === expected), "RENDERED_VENUE", "renderedVenueMatches");
    check(visible?.linkUrls.includes(link.url), "RENDERED_LINK", "renderedLinkMatches");
    check(visible?.addressTexts.some(value => (` ${addressKey(value)} `).includes(` ${canonicalAddress} `)), "RENDERED_ADDRESS", "renderedAddressMatches");
  }
  const markup = [...headings, ...links.map(value => value.node), ...addresses].map(witness);
  const proof = uscheduleOfficialLocationProofSchema.parse({ kind: "OFFICIAL_PUBLIC_LOCATION_V1", officialPageUrl: current.href, entryUrl: link.url,
    locationId: link.locationId, venueName: source.venueName, addressKey: canonicalAddress, markupWitnessSha256: digest(markup) });
  facts.stage = "LOCATION_VERIFIED"; emit();
  return proof;
}

export function readUScheduleLocationCatalog(html: string, sourceUrl: string, official: UScheduleOfficialLocationProof) {
  const source = parseUScheduleLocationSource(sourceUrl), entry = parseUScheduleLocationSource(official.entryUrl);
  if (!source || !entry || source.canonicalUrl !== entry.canonicalUrl || entry.locationId !== official.locationId) return fail();
  const all = nodes(html), body = all.filter(node => node.tagName === "body");
  if (body.length !== 1 || !(attr(body[0], "class") ?? "").split(/\s+/u).includes(source.tenant) ||
      all.some(node => node.tagName === "input" && attr(node, "type") === "password" && !hidden(node))) return fail();
  const visible = clean(text(body[0]));
  if (/checking your browser|verify (?:that )?you are human|captcha|authentication required|(?:sign|log) in to continue/iu.test(visible)) return fail();
  const options = (selector: string) => {
    const found = all.filter(node => node.tagName === "select" && attr(node, "id") === selector);
    if (found.length !== 1 || hidden(found[0])) return fail();
    if (children(found[0]).some(node => node.tagName !== "option" || children(node).length)) return fail();
    const values = found[0].childNodes.filter(element).filter(node => node.tagName === "option").map(node => ({ id: attr(node, "value") ?? "",
      name: clean(text(node)), selected: attr(node, "selected") !== undefined }));
    if (!values.length || values.length > 40 || new Set(values.map(value => value.id)).size !== values.length || values.filter(value => value.selected).length !== 1) return fail();
    return values;
  };
  const locations = options("select_location"), services = options("select_service"), lengths = options("select_length");
  if (locations.some(value => !id.safeParse(value.id).success) || services.some(value => !id.safeParse(value.id).success) ||
      lengths.some(value => !/^(?:[1-9]\d{0,2})$/u.test(value.id) || Number(value.id) < 15 || Number(value.id) > 480) ||
      all.some(node => node.tagName === "select" && attr(node, "id") === "select_group_size")) return fail();
  if (official.kind === "OFFICIAL_PUBLIC_LOCATION_CONTACT_V1") {
    const publicSurface = (n: Element) => {
      let p: Node | undefined = n;
      for (let depth = 0; p && depth < 80; depth++, p = "parentNode" in p ? p.parentNode ?? undefined : undefined) if (element(p) &&
        (hidden(p) || ["form", "template", "script", "style", "noscript", "iframe"].includes(p.tagName) ||
         p.attrs.some(a => ["disabled", "inert"].includes(a.name) || a.name === "aria-disabled" && a.value === "true") ||
         /\b(?:private|members?|account|profile|checkout|payment|billing|login)\b/iu.test([attr(p, "id"), attr(p, "class"), attr(p, "aria-label")].join(" ")))) return false;
      return p === undefined;
    };
    const location = locations.filter(v => v.id === official.locationId), branch = official.locality;
    if (location.length !== 1 || !location[0].selected || nameKey(location[0].name) !== nameKey(`${branch} - ${official.venueName}`) ||
        locations.filter(v => nameKey(v.name) === nameKey(location[0].name)).length !== 1 || services.length !== 1 || !services[0].selected ||
        nameKey(services[0].name) !== nameKey(`Simulator Rental - ${branch}`) ||
        all.some(n => n.tagName === "select" && (classes(n).includes("resSelect") || classes(n).includes("addOnSelect") || attr(n, "id") === "select_units_to_book"))) return fail();
    const columns = all.filter(n => n.tagName === "div" && classes(n).includes("col-lg-4") && classes(n).includes("order-1"));
    const columnsOwned = columns.filter(n => all.some(s => attr(s, "id") === "select_location" && within(s, n)) && all.some(s => attr(s, "id") === "select_service" && within(s, n)) && all.some(s => attr(s, "id") === "select_length" && within(s, n)));
    if (columnsOwned.length !== 1 || !publicSurface(columnsOwned[0]) || ["select_location", "select_service", "select_length"].some(key => {
      const controls = all.filter(n => attr(n, "id") === key && publicSurface(n));
      return controls.length !== 1 || children(controls[0]).some(option => !publicSurface(option));
    }) ||
        ["location", "service"].some(part => all.filter(n => attr(n, "id") === `${part}_section` && n.parentNode === columnsOwned[0]).length !== 1)) return fail();
    const labels = all.filter(n => n.tagName === "label" && attr(n, "for") === "select_length");
    if (labels.length !== 1 || clean(text(labels[0])) !== "Choose Service Time" || hidden(labels[0])) return fail();
    const grids = all.filter(n => classes(n).includes("time_choices")), choices = grids.length === 1 ? grids[0].parentNode : undefined;
    if (!choices || !element(choices) || !classes(choices).includes("choices") || !choices.parentNode || !element(choices.parentNode) || !publicSurface(grids[0])) return fail();
    const cards = children(choices.parentNode).slice(children(choices.parentNode).indexOf(choices) + 1).filter(n => classes(n).includes("card") && publicSurface(n));
    const notes = all.filter(n => ["p", "li"].includes(n.tagName) && cards.some(c => within(n, c)) && !hidden(n) &&
      /\b(?:maximum|max|up to|only)\b/iu.test(text(n)) && /\b(?:people|players?|golfers?|persons?)\b/iu.test(text(n)) && /\bbays?\b/iu.test(text(n)));
    const limits = notes.map(n => {
      if (all.some(c => within(c, n) && ["input", "select", "button", "textarea", "a"].includes(c.tagName))) return fail();
      const match = /^\*{0,2}\s*Max of ([1-9]\d?) golfers playing per bay\s*\*{0,2}$/iu.exec(clean(text(n)));
      return match ? Number(match[1]) : fail();
    });
    if (new Set(limits).size > 1) return fail();
    const scripts = all.filter(n => n.tagName === "script" && attr(n, "src")).flatMap(n => {
      try { const u = new URL(attr(n, "src")!, source.url); return u.origin === new URL(source.url).origin && u.pathname === USCHEDULE_LOCATION_CLIENT.path && !u.username && !u.password && !u.port && !u.hash &&
        (!u.search || u.searchParams.size === 1 && /^[A-Za-z0-9_-]{44}$/u.test(u.searchParams.get("v") ?? "")) ? [u.href] : []; } catch { return []; }
    });
    if (scripts.length !== 1) return fail();
    const facts = { tenant: source.tenant, locations: locations.map(({ id, name }) => ({ id, name })), service: { serviceId: services[0].id, serviceName: services[0].name },
      durations: lengths.map(v => Number(v.id)), maxPartySize: limits[0] ?? null };
    const proof = publicLocationServicePoolProofSchema.parse({ kind: "PUBLIC_LOCATION_SERVICE_POOL_V1", official, locationId: location[0].id,
      locationName: location[0].name, catalogHash: digest(facts), ...facts.service, maxPartySize: facts.maxPartySize, client: USCHEDULE_LOCATION_CLIENT });
    return { proof, locationSelected: true, selectedServiceId: services[0].id, selectedDuration: Number(lengths.find(v => v.selected)!.id), service: facts.service,
      durations: facts.durations, clientUrl: scripts[0] };
  }
  const location = locations.find(value => value.id === official.locationId), rentals = services.filter(value => isUScheduleNonMemberRental(value.name));
  if (!location || nameKey(location.name) !== nameKey(official.venueName) || locations.filter(value => nameKey(value.name) === nameKey(official.venueName)).length !== 1 || rentals.length !== 1) return fail();
  // Initial support covers this sole public rental. An unclassified additional
  // product cannot be silently omitted from venue-wide availability.
  if (services.some(value => !isUScheduleNonMemberRental(value.name) &&
      !/\blesson\b/iu.test(value.name) && !/^(?:member|members)[\s-]/iu.test(value.name))) return fail();
  if (!rentals[0].selected) return fail();
  const columns = all.filter(node => node.tagName === "div" && classes(node).includes("col-lg-4") && classes(node).includes("order-1"));
  const column = columns.find(node => all.some(select => attr(select, "id") === "select_service" && within(select, node)));
  if (!column || columns.filter(node => all.some(select => attr(select, "id") === "select_service" && within(select, node))).length !== 1) return fail();
  for (const [section, control] of [["location_section", "select_location"], ["service_section", "select_service"]]) {
    const sections = all.filter(node => attr(node, "id") === section && node.parentNode === column);
    if (sections.length !== 1 || !all.some(node => attr(node, "id") === control && within(node, sections[0]))) return fail();
  }
  const selectedLocation = locations.find(value => value.selected)!;
  const locationStem = nameKey(selectedLocation.name.replace(/\b(?:indoor|golf|club)\b/giu, ""));
  if (locationStem.length < 3) return fail();
  const groups = all.filter(node => node.tagName === "select" && (attr(node, "class") ?? "").split(/\s+/u).includes("resSelect"));
  if (groups.length !== 1) return fail();
  const resourceGroups = groups.map(node => {
    const groupId = /^resource([1-9]\d{0,9})$/u.exec(attr(node, "id") ?? "")?.[1];
    if (!groupId || hidden(node)) return fail();
    const sections = all.filter(value => attr(value, "id") === "res_section" && value.parentNode === column && within(node, value));
    const labels = sections.length === 1 ? children(sections[0]).filter(value => value.tagName === "label" && attr(value, "for") === `resource${groupId}` && classes(value).includes("choose_label") && !hidden(value)) : [];
    const label = labels.length === 1 ? /^Simulators\s*-\s*(.+)$/iu.exec(clean(text(labels[0])))?.[1] : undefined;
    if (!label || nameKey(label) !== locationStem) return fail();
    const values = options(`resource${groupId}`), any = values.filter(value => value.selected);
    const resources = values.filter(value => value.id !== "-1").map(({ id, name }) => ({ id, name }));
    if (any[0].id !== "-1" || !/^any available$/iu.test(any[0].name) || !resources.length || resources.length > 20 ||
        resources.some(value => { const match = /^(.+)\s+-\s+Bay\s+([1-9]\d?)$/iu.exec(value.name);
          return !id.safeParse(value.id).success || !match || nameKey(match[1]) !== locationStem; })) return fail();
    return { id: groupId, resources };
  });
  if (new Set(resourceGroups.map(value => value.id)).size !== resourceGroups.length) return fail();
  const addons = all.filter(node => node.tagName === "select" && (attr(node, "class") ?? "").split(/\s+/u).includes("addOnSelect")).map(node => {
    const addonId = /^addon([1-9]\d{0,9})$/u.exec(attr(node, "id") ?? "")?.[1];
    if (!addonId) return fail();
    const values = options(`addon${addonId}`); if (values.find(value => value.selected)?.id !== "0" || values.some(value => !/^(?:0|[1-9]\d{0,2})$/u.test(value.id))) return fail();
    return { id: addonId, options: values.map(({ id, name }) => ({ id, name })) };
  });
  const cards = children(column).filter(node => classes(node).includes("card") && classes(node).includes("my-3") && !hidden(node));
  const guestCards = cards.filter(node => children(node).some(body => classes(body).includes("card-body") && !hidden(body) &&
    children(body).some(item => item.tagName === "p" && clean(text(item)) === "Simulators:") &&
    children(body).some(item => item.tagName === "p" && clean(text(item)) === "Additional Guest(s):")));
  if (guestCards.length !== 1) return fail();
  const guestItems = all.filter(node => node.tagName === "li" && within(node, guestCards[0]) && !hidden(node)).map(node => clean(text(node)));
  const included = guestItems.filter(value => /^Non-members may bring 1 guest for free\.$/iu.test(value));
  const maximum = guestItems.filter(value => /^You may add 2 additional guests if you wish\. The charge is \$\d+(?:\.\d{2})? per person\/per hour\. Max of 4 people in the bay\.$/iu.test(value));
  const descriptions = all.filter(node => attr(node, "id") === "serv_desc_section" && !hidden(node) && node.parentNode && element(node.parentNode) &&
    classes(node.parentNode).includes("serv_only_desc") && node.parentNode.parentNode && element(node.parentNode.parentNode) && attr(node.parentNode.parentNode, "id") === "right_column");
  if (included.length !== 1 || maximum.length !== 1 || descriptions.length !== 1 ||
      children(descriptions[0])[0]?.tagName !== "p" || clean(text(children(descriptions[0])[0])) !== "Non-Member Tee Time Guidelines" ||
      all.filter(node => node.tagName === "li" && within(node, descriptions[0]) && !hidden(node) &&
        clean(text(node)) === "Non-members reservations include 1 guest, for free.").length !== 1) return fail();
  const scripts = all.filter(node => node.tagName === "script" && attr(node, "src")).flatMap(node => {
    try { const url = new URL(attr(node, "src")!, source.url);
      return url.origin === new URL(source.url).origin && url.pathname === USCHEDULE_LOCATION_CLIENT.path && !url.username && !url.password && !url.port && !url.hash &&
        (url.search === "" || url.searchParams.size === 1 && /^[A-Za-z0-9_-]{44}$/u.test(url.searchParams.get("v") ?? "")) ? [url.href] : []; } catch { return []; }
  });
  if (scripts.length !== 1) return fail();
  const facts = { tenant: source.tenant, locations: locations.map(({ id, name }) => ({ id, name })), services: services.map(({ id, name }) => ({ id, name })),
    durations: lengths.map(value => Number(value.id)), resourceGroups, addons, guestContext: [...included, ...maximum].sort(), includedPartySize: 2, maxPartySize: 4 };
  const proof = uschedulePublicLocationProofSchema.parse({ kind: "PUBLIC_LOCATION_RENTAL_V1", official, locationId: location.id,
    locationName: location.name, catalogHash: digest(facts), includedPartySize: 2, maxPartySize: 4, resourceGroups, client: USCHEDULE_LOCATION_CLIENT });
  return { proof, locationSelected: location.selected, selectedServiceId: services.find(value => value.selected)!.id,
    selectedDuration: Number(lengths.find(value => value.selected)!.id), service: { serviceId: rentals[0].id, serviceName: rentals[0].name },
    durations: facts.durations, clientUrl: scripts[0] };
}
