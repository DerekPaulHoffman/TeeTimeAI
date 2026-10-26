import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { fullCourseName, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import type { OfficialSourceDiagnostic } from "./official-source-diagnostics";
import { normalizePublicUSState } from "./public-us-business-address";

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const url = z.string().max(2048).refine(value => Boolean(publicDocumentUrl(value)));
const id = z.number().int().min(1).max(2_147_483_647);
export const teeItUpOfficialBookingSourceProofSchema = z.object({ kind: z.literal("OFFICIAL_BOOKING_SOURCE"),
  officialUrl: url, officialDocumentUrl: url, bookingPageUrl: url, iframeEntryUrl: url, bookingSourceUrl: url,
  homeWitnessSha256: sha, pageWitnessSha256: sha, iframeRedirectStatus: z.union([z.literal(301), z.literal(302), z.literal(303), z.literal(307), z.literal(308)]),
  initialVisibility: z.literal("RENDERED_CONTROLLER_OBSERVATION"), warmVisibility: z.literal("INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED"),
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u), facilityId: id, courseId: z.string().min(1).max(128),
  venueName: z.string().min(3).max(200), timeZone: z.string().min(1).max(100), canonicalAddress: z.string().min(15).max(1024),
  providerAddress: z.string().min(15).max(1024), providerAddressVerified: z.literal(false),
}).strict();
export type TeeItUpOfficialBookingSourceProof = z.infer<typeof teeItUpOfficialBookingSourceProofSchema>;
export type TeeItUpObservedSourceChain = Pick<TeeItUpOfficialBookingSourceProof, "officialUrl" | "officialDocumentUrl" | "bookingPageUrl" |
  "iframeEntryUrl" | "bookingSourceUrl" | "homeWitnessSha256" | "pageWitnessSha256" | "iframeRedirectStatus">;
export type TeeItUpSourceIdentity = Omit<OfficialIdentitySource, "bookingUrl">;
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
function fail(): never { throw new Error("OFFICIAL_BOOKING_SOURCE_UNVERIFIED"); }
export function publicDocumentUrl(value: string): URL | undefined {
  try { const parsed = new URL(value); return value.length <= 2048 && !/[\u0000-\u0020\u007f]/u.test(value) && parsed.protocol === "https:" &&
    !parsed.username && !parsed.password && !parsed.port && !parsed.hash && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(parsed.hostname) ? parsed : undefined; } catch { return; }
}
export function sameTeeItUpOfficialHost(left: string, right: string) {
  const a = publicDocumentUrl(left), b = publicDocumentUrl(right);
  return Boolean(a && b && a.hostname.replace(/^www\./u, "") === b.hostname.replace(/^www\./u, ""));
}
export function teeItUpBookAlias(value: string) {
  const parsed = publicDocumentUrl(value);
  return parsed && parsed.pathname === "/" && !parsed.search ? /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.book\.teeitup\.(?:com|golf)$/u.exec(parsed.hostname)?.[1] : undefined;
}
export function isTeeItUpPlayEntry(value: string) {
  const parsed = publicDocumentUrl(value);
  return Boolean(parsed && parsed.pathname === "/" && !parsed.search && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.play\.teeitup\.com$/u.test(parsed.hostname));
}
const streetTypes: Record<string, string> = { road: "rd", rd: "rd", street: "st", st: "st", drive: "dr", dr: "dr", avenue: "ave", ave: "ave",
  boulevard: "blvd", blvd: "blvd", lane: "ln", ln: "ln", court: "ct", ct: "ct", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", way: "way", circle: "cir", cir: "cir", trail: "trl", trl: "trl", terrace: "ter", ter: "ter" };
const directions: Record<string, string> = { n: "n", north: "n", s: "s", south: "s", e: "e", east: "e", w: "w", west: "w", ne: "ne", nw: "nw", se: "se", sw: "sw" };
/** Every component except the parsed house number remains part of identity. */
export function teeItUpCompleteStreetAddress(value: string) {
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) return;
  // A printed <br> contributes a delimiter even when the preceding text
  // already ends in a comma. Collapse only empty delimiter runs; no nonempty
  // address component, direction, unit or number is discarded.
  const parts = clean(value).replace(/,(?:\s*,)+/gu, ",").split(/\s*,\s*/u);
  if (parts.length === 4 && /^(?:US|USA|United States(?: of America)?)$/iu.test(parts[3])) parts.pop();
  if (parts.length !== 3 || !/^[A-Za-z .'-]{2,80}$/u.test(parts[1])) return;
  const region = /^(.{2,40})\s+(\d{5}(?:-\d{4})?)$/iu.exec(parts[2]);
  // Preserve the existing two-letter region contract (including DC and US
  // territories); only written-out names need the existing state dictionary.
  const state = region && (/^[A-Z]{2}$/iu.test(region[1]) ? region[1].toUpperCase() : normalizePublicUSState(region[1]));
  const street = /^(\d{1,7})\s+(.+)$/u.exec(parts[0]);
  if (!region || !state || !street || /\b(?:mailing|corporate|billing|headquarters|p\s*o\s*box)\b/iu.test(value)) return;
  const words = street[2].toLowerCase().replace(/\./gu, "").split(/\s+/u);
  let unit = "", unitType = "";
  const unitIndex = words.findIndex(word => /^(?:suite|ste|apt|apartment|unit|#)$/u.test(word) || /^#[a-z0-9-]+$/u.test(word));
  if (unitIndex >= 0) {
    const token = words[unitIndex]; unitType = /^(?:suite|ste)$/u.test(token) ? "ste" : /^(?:apt|apartment)$/u.test(token) ? "apt" : "unit";
    const tail = words.splice(unitIndex); unit = tail[0].startsWith("#") && tail[0] !== "#" ? tail[0].slice(1) : tail[1];
    if (!unit || tail.length !== (tail[0].startsWith("#") && tail[0] !== "#" ? 1 : 2) || !/^[a-z0-9-]{1,20}$/u.test(unit)) return;
  }
  const before = directions[words[0]] ? directions[words.shift()!] : "";
  const after = directions[words.at(-1)!] ? directions[words.pop()!] : "";
  const type = streetTypes[words.pop()!];
  if (!type || !words.length || !words.every(word => /^[a-z0-9'-]+$/u.test(word))) return;
  return { number: street[1], before, street: words.join(" "), type, after, unitType, unit,
    locality: parts[1].toLowerCase().replace(/\./gu, ""), region: state, postalCode: region[2], country: "US" };
}
export function teeItUpNumberOnlyAddressConflict(canonical: string, provider: string) {
  const a = teeItUpCompleteStreetAddress(canonical), b = teeItUpCompleteStreetAddress(provider);
  return Boolean(a && b && a.number !== b.number && JSON.stringify({ ...a, number: "" }) === JSON.stringify({ ...b, number: "" }));
}
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
function hidden(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (element(current) && (attr(current, "hidden") !== undefined || attr(current, "inert") !== undefined || attr(current, "aria-hidden") === "true" ||
      /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:[.;]|$)/iu.test(attr(current, "style") ?? "") ||
      /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(current, "class") ?? ""))) return true;
  return false;
}
function restrictedContext(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!element(current)) continue;
    if (current.tagName === "form" || /\b(?:mailing|corporate|billing|headquarters|registered\s+office)\b/iu.test(
      current.attrs.filter(value => ["aria-label", "title", "id", "class"].includes(value.name)).map(value => value.value).join(" "))) return true;
    if (!["html", "body"].includes(current.tagName) && current.childNodes.some(child => element(child) && /^h[1-6]$/u.test(child.tagName) &&
      /\b(?:mailing|corporate|billing|headquarters|registered\s+office)\b/iu.test(text(child)))) return true;
  }
  return false;
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && (["script", "style", "template", "noscript", "iframe", "input", "textarea", "select", "button"].includes(node.tagName) || hidden(node))) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function nodes(html: string) {
  if (Buffer.byteLength(html) > 600_000) return fail();
  const result: Element[] = [], stack: Array<[Node, number]> = [[parse(html), 0]];
  while (stack.length) { const [node, depth] = stack.pop()!;
    if (depth > 64 || result.length > 20_000) return fail();
    if (element(node)) result.push(node);
    if ("childNodes" in node) for (const child of [...node.childNodes].reverse()) stack.push([child, depth + 1]);
  }
  return result;
}
export function teeItUpInertDocumentContent(html: string) {
  const all = nodes(html);
  return { text: text(all.find(node => node.tagName === "body") ?? all[0]), title: text(all.find(node => node.tagName === "title") ?? all[0]) };
}
function witness(entries: Element[]) {
  return createHash("sha256").update(JSON.stringify(entries.map(node => {
    const ancestry: unknown[] = []; let current: Node | undefined = node;
    for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
      if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value => ["id", "class", "style", "hidden", "inert", "aria-hidden", "href", "src", "title", "aria-label", "width", "height"].includes(value.name)).map(value => [value.name, value.value]).sort()]);
    return [clean(text(node)), ancestry];
  }))).digest("hex");
}
function headingName(value: string) { return fullCourseName(clean(value).replace(/^Welcome to\s+/iu, "")); }
export function readTeeItUpOfficialHome(source: TeeItUpSourceIdentity, page: OfficialIdentityPage, rendered: boolean,
  onDiagnostic?: (value: OfficialSourceDiagnostic) => void) {
  const facts: OfficialSourceDiagnostic = { stage: "SOURCE_CONTEXT" };
  const emit = () => { try { onDiagnostic?.({ ...facts }); } catch { /* Diagnostics cannot change identity validation. */ } };
  const check = (condition: unknown, stage: OfficialSourceDiagnostic["stage"], key: Exclude<keyof OfficialSourceDiagnostic, "stage">) => {
    facts.stage = stage; facts[key] = Boolean(condition); emit(); if (!condition) return fail();
  };
  check(source.officialUrl && source.venueAddress, "SOURCE_CONTEXT", "sourceContextValid");
  if (!source.officialUrl || !source.venueAddress) return fail();
  check(sameTeeItUpOfficialHost(source.officialUrl, page.url), "OFFICIAL_SITE", "officialSiteMatches");
  facts.stage = "RAW_DOCUMENT"; emit();
  const canonical = teeItUpCompleteStreetAddress(source.venueAddress), all = nodes(page.html), expected = fullCourseName(source.venueName);
  check(canonical && expected.replace(/\bgolf course$/u, "").trim().length >= 5, "SOURCE_CONTEXT", "sourceContextValid");
  const headings = all.filter(node => /^(?:h1|h2)$/u.test(node.tagName) && !hidden(node) && headingName(text(node)) === expected);
  check(headings.length && !all.some(node => node.tagName === "h1" && !hidden(node) && headingName(text(node)) !== expected), "RAW_VENUE", "rawVenueMatches");
  const addresses = all.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName) && !hidden(node) && !restrictedContext(node) && clean(text(node)).length <= 500 &&
    JSON.stringify(teeItUpCompleteStreetAddress(clean(text(node)))) === JSON.stringify(canonical));
  check(addresses.length, "RAW_ADDRESS", "rawAddressMatches");
  const links = all.filter(node => node.tagName === "a" && !hidden(node) && /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text(node)) &&
    !/\b(?:lesson|member|login|sign in|checkout|purchase|payment|confirm)\b/iu.test(text(node))).flatMap(node => {
      try { const target = publicDocumentUrl(new URL(attr(node, "href") ?? "", page.url).href);
        return target && !target.search && target.origin === new URL(page.url).origin && target.href !== page.url ? [{ node, url: target.href }] : []; } catch { return []; }
    });
  check(links.length && new Set(links.map(value => value.url)).size === 1, "RAW_LINK", "rawLinkMatches");
  const target = links[0].url, visible = page.visibleEvidence;
  if (rendered) {
    check(visible?.headings.some(value => headingName(value) === expected), "RENDERED_VENUE", "renderedVenueMatches");
    check(visible?.linkUrls.includes(target), "RENDERED_LINK", "renderedLinkMatches");
    check(visible?.addressTexts.some(value => JSON.stringify(teeItUpCompleteStreetAddress(value)) === JSON.stringify(canonical)), "RENDERED_ADDRESS", "renderedAddressMatches");
  }
  return { url: page.url, bookingPageUrl: target, witness: witness([...headings, ...addresses, ...links.map(value => value.node)]) };
}
export function readTeeItUpOfficialEmbed(page: OfficialIdentityPage, renderedFrames?: string[]) {
  const frames = nodes(page.html).filter(node => node.tagName === "iframe" && !hidden(node) && attr(node, "srcdoc") === undefined).flatMap(node => {
    try { const target = new URL(attr(node, "src") ?? "", page.url).href; return isTeeItUpPlayEntry(target) ? [{ node, url: target }] : []; } catch { return []; }
  });
  if (frames.length !== 1 || renderedFrames && !renderedFrames.includes(frames[0].url)) return fail();
  return { url: page.url, iframeEntryUrl: frames[0].url, witness: witness([frames[0].node]) };
}
export function bindTeeItUpOfficialBookingFacility(source: OfficialIdentitySource, chain: TeeItUpObservedSourceChain, directory: unknown): TeeItUpOfficialBookingSourceProof {
  const rows = z.array(z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(3).max(256), address: z.string().min(15).max(1024),
    timeZone: z.string().min(1).max(100), isSimulator: z.boolean().optional() })).min(1).max(100).safeParse(directory);
  const alias = teeItUpBookAlias(source.bookingUrl);
  if (!rows.success || !source.officialUrl || !source.venueAddress || !alias || chain.officialUrl !== source.officialUrl || chain.bookingSourceUrl !== source.bookingUrl ||
      new Set(rows.data.map(row => row.id)).size !== rows.data.length || new Set(rows.data.map(row => row.courseId)).size !== rows.data.length) return fail();
  const matching = rows.data.filter(row => fullCourseName(row.name) === fullCourseName(source.venueName));
  if (matching.length !== 1 || matching[0].isSimulator !== false || matching[0].timeZone !== source.timeZone || !teeItUpNumberOnlyAddressConflict(source.venueAddress, matching[0].address)) return fail();
  return teeItUpOfficialBookingSourceProofSchema.parse({ kind: "OFFICIAL_BOOKING_SOURCE", ...chain, alias, facilityId: matching[0].id, courseId: matching[0].courseId,
    venueName: source.venueName, timeZone: source.timeZone, canonicalAddress: source.venueAddress, providerAddress: matching[0].address, providerAddressVerified: false,
    initialVisibility: "RENDERED_CONTROLLER_OBSERVATION", warmVisibility: "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED" });
}
