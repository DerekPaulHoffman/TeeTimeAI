import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createHash } from "node:crypto";
import { parseTeeItUpV2PublicSource } from "@/lib/adapters/teeitup-public-source";
import { z } from "zod";
import type { PublicCourseContactBlock } from "./public-course-contact-blocks";

const publicUrl = z.string().url().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port; } catch { return false; }
});
const addressSchema = z.object({ street: z.string().min(3).max(140), locality: z.string().min(2).max(80),
  region: z.string().regex(/^[A-Z]{2}$/u), postalCode: z.string().regex(/^\d{5}$/u), country: z.literal("US") }).strict();
export const teeItUpOfficialIdentityProofSchema = z.object({ kind: z.literal("OFFICIAL_SOURCE_ADDRESS"),
  officialPageUrl: publicUrl, bookingUrl: publicUrl, venueName: z.string().min(3).max(200), alternateAddress: addressSchema,
  markupWitnessSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type TeeItUpOfficialIdentityProof = z.infer<typeof teeItUpOfficialIdentityProofSchema>;
export type OfficialIdentitySource = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export type OfficialIdentityPage = { url: string; html: string; visibleEvidence?: {
  title: string; headings: string[]; linkUrls: string[]; addressTexts: string[]; phoneTexts?: string[];
  brandLinks?: Array<{ href: string; text: string }>;
  publicRentalTexts?: string[];
  publicContactBlocks?: PublicCourseContactBlock[];
}; browserTransport?: "PINNED_HTTP" | "NATIVE_CHROME" };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form"].includes(node.tagName) ||
  attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr(node, "style") ?? "") ||
  attr(node, "inert") !== undefined || /(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(node, "class") ?? "");
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function nodes(root: Node) {
  const found: Element[] = [];
  function visit(node: Node) {
    if (element(node) && excluded(node)) return;
    if (element(node)) found.push(node);
    if (found.length > 20_000) throw new Error("OFFICIAL_IDENTITY_NODE_LIMIT");
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(root); return found;
}
export function fullCourseName(value: string) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .replace(/\bgolf (?:club|course)$/u, "golf course");
}
function headingCourseName(value: string, expected: string) {
  const exact = fullCourseName(value);
  return exact === expected ? exact : fullCourseName(clean(value).replace(/^welcome to /iu, ""));
}
/** Only the legacy public host suffix may vary. Tenant, selected courses, date
 * and serialized query stay exact; this does not equate V2 or other paths. */
function legacyBookingDescriptor(value: string) {
  const url = new URL(value), tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.book\.teeitup\.(?:com|golf)$/u.exec(url.hostname);
  if (!tenant || url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.pathname !== "/") return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !["course", "date"].includes(key)) || new Set(keys).size !== keys.length) return null;
  const course = url.searchParams.get("course"), date = url.searchParams.get("date");
  if (course !== null) {
    if (!/^[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,19}$/u.test(course)) return null;
    const ids = course.split(",").map(Number);
    if (ids.some(id => id > 2_147_483_647) || new Set(ids).size !== ids.length) return null;
  }
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) return null;
  url.hostname = `${tenant[1]}.book.teeitup.com`;
  return url.href;
}
function streetKey(value: string) {
  const types: Record<string, string> = { drive: "dr", road: "rd", street: "st", avenue: "ave", boulevard: "blvd", lane: "ln", court: "ct", parkway: "pkwy", highway: "hwy", circle: "cir", trail: "trl", terrace: "ter" };
  return clean(value).toLowerCase().replace(/\b(?:drive|road|street|avenue|boulevard|lane|court|parkway|highway|circle|trail|terrace)\b/gu, word => types[word])
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function completeUSAddress(value: string) {
  const normalized = clean(value).replace(/^Address\s*:\s*/iu, "").replace(/\s*,\s*/gu, ", ");
  const match = /^(\d{1,7}[A-Za-z]?\s+[^,]{2,135}), ([A-Za-z .'-]{2,80}), ([A-Z]{2}) (\d{5})(?:-\d{4})?(?:, \3 \4(?:-\d{4})?)?(?:, (?:US|USA|United States(?: of America)?))?$/iu.exec(normalized);
  if (!match || /\b(?:p\.?\s*o\.?\s*box|mailing|corporate|billing|headquarters)\b/iu.test(normalized) ||
    !/\b(?:dr(?:ive)?|rd|road|st(?:reet)?|ave(?:nue)?|blvd|boulevard|ln|lane|ct|court|pkwy|parkway|hwy|highway|cir(?:cle)?|trl|trail|ter(?:race)?|way)\.?$/iu.test(match[1])) return null;
  return { street: streetKey(match[1]), locality: clean(match[2]).toLowerCase(), region: match[3].toUpperCase(), postalCode: match[4], country: "US" as const };
}
function markupWitness(node: Element) {
  const ancestry: unknown[] = [];
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 32; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value => ["id", "class", "style", "hidden", "inert", "aria-hidden", "aria-label", "title", "href"].includes(value.name))
      .map(value => [value.name, value.value]).sort()]);
  }
  return [clean(text(node)), ancestry];
}
function hasMailingContext(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!element(current)) continue;
    const context = [attr(current, "aria-label"), attr(current, "title"), ...current.childNodes.filter(child => element(child) && /^h[1-6]$/u.test(child.tagName)).map(text)].join(" ");
    if (/\b(?:mailing|corporate|billing|headquarters)\b/iu.test(context)) return true;
  }
  return false;
}
/** A semantic public-source attestation. Discovery separately corroborates rendered
 * visibility. Warm reads recheck the same markup witnesses, not computed CSS. */
export function deriveTeeItUpOfficialIdentityProof(source: OfficialIdentitySource, page: OfficialIdentityPage,
  options: { requireVisibleEvidence?: boolean } = {}): TeeItUpOfficialIdentityProof {
  const fail = (): never => { throw new Error("OFFICIAL_IDENTITY_UNVERIFIED"); };
  if (!source.officialUrl || !source.venueAddress || page.html.length > 2_000_000) return fail();
  const official = new URL(source.officialUrl), current = new URL(page.url), booking = new URL(source.bookingUrl);
  if (official.protocol !== "https:" || official.origin !== current.origin || current.username || current.password || current.port ||
    booking.protocol !== "https:" || !(/^[a-z0-9-]+\.book\.teeitup\.(?:com|golf)$/u.test(booking.hostname) || parseTeeItUpV2PublicSource(booking.href))) return fail();
  const canonical = completeUSAddress(source.venueAddress), expected = fullCourseName(source.venueName);
  if (!canonical || expected.replace(/\bgolf course\b/gu, "").trim().length < 5) return fail();
  const entries = nodes(parse(page.html));
  const titleNodes = entries.filter(node => node.tagName === "title");
  const titles = titleNodes.map(node => clean(text(node)).split(/\s*[|–—]\s*/u)
    .flatMap(part => fullCourseName(part) === expected ? [part] : part.split(/ - /u)));
  const headings = entries.filter(node => ["h1", "h2"].includes(node.tagName)).map(node => headingCourseName(text(node), expected)).filter(Boolean);
  if (titles.length !== 1 || titles[0].length > 3 || !titles[0].some(part => fullCourseName(part) === expected) || !headings.includes(expected)) return fail();
  if (entries.filter(node => node.tagName === "h1").some(node => headingCourseName(text(node), expected) !== expected)) return fail();
  if (headings.some(name => /\bgolf course$/u.test(name) && name !== expected)) return fail();
  const linkNodes = entries.filter(node => node.tagName === "a" && /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text(node))).flatMap(node => {
    try { const url = new URL(attr(node, "href") ?? "", current); return /^[a-z0-9-]+\.book\.teeitup\.(?:com|golf)$/u.test(url.hostname) || parseTeeItUpV2PublicSource(url.href) ? [{ node, url: url.href }] : []; } catch { return []; }
  });
  if (!linkNodes.some(value => value.url === booking.href)) return fail();
  if (new Set(linkNodes.map(value => value.url)).size !== 1) {
    const descriptor = legacyBookingDescriptor(booking.href);
    if (!descriptor || linkNodes.some(value => legacyBookingDescriptor(value.url) !== descriptor)) return fail();
  }
  const addresses = new Map<string, z.infer<typeof addressSchema>>();
  const addressNodes: Element[] = [];
  for (const node of entries.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName))) {
    const value = clean(text(node));
    if (value.length > 500 || /\b(?:mailing|corporate|billing|headquarters)\b/iu.test(value) || hasMailingContext(node)) continue;
    const address = completeUSAddress(value);
    if (address) { addresses.set(JSON.stringify(address), address); addressNodes.push(node); }
  }
  if (addresses.size !== 1) return fail();
  const alternateAddress = [...addresses.values()][0];
  if (alternateAddress.locality !== canonical.locality || alternateAddress.region !== canonical.region || alternateAddress.postalCode !== canonical.postalCode) return fail();
  const headingNodes = entries.filter(node => ["h1", "h2"].includes(node.tagName) && headingCourseName(text(node), expected) === expected);
  if (options.requireVisibleEvidence) {
    const visible = page.visibleEvidence;
    if (!visible || clean(visible.title) !== clean(text(titleNodes[0])) || !visible.headings.some(value => headingCourseName(value, expected) === expected) ||
      !visible.linkUrls.includes(booking.href) || !visible.addressTexts.some(value => JSON.stringify(completeUSAddress(value)) === JSON.stringify(alternateAddress))) return fail();
  }
  const markupWitnessSha256 = createHash("sha256").update(JSON.stringify([...titleNodes, ...headingNodes, ...addressNodes, ...linkNodes.map(value => value.node)].map(markupWitness))).digest("hex");
  return teeItUpOfficialIdentityProofSchema.parse({ kind: "OFFICIAL_SOURCE_ADDRESS", officialPageUrl: current.href, bookingUrl: booking.href,
    venueName: expected, alternateAddress, markupWitnessSha256 });
}
export function matchesOfficialFacility(proof: Pick<TeeItUpOfficialIdentityProof, "venueName" | "alternateAddress">, source: OfficialIdentitySource, row: { name: string; address: string; timeZone: string; isSimulator?: boolean }) {
  return row.isSimulator !== true && row.timeZone === source.timeZone && fullCourseName(row.name) === fullCourseName(source.venueName) &&
    fullCourseName(row.name) === proof.venueName && JSON.stringify(completeUSAddress(row.address)) === JSON.stringify(proof.alternateAddress);
}
