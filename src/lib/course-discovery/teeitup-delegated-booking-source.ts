import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName, matchesOfficialFacility, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import { publicDocumentUrl, teeItUpBookAlias, teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { createDelegationDiagnostic, rememberTeeItUpDelegationFailure, type DelegatedDiagnosticGate } from "./teeitup-delegated-booking-diagnostic";

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export function safeDelegatedBookingUrl(value: string) {
  const parsed = publicDocumentUrl(value);
  if (!parsed || parsed.href !== value || /\\/u.test(value) || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu.test(parsed.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(parsed.hostname)) return false;
  let path = parsed.pathname;
  try { for (let count = 0; count < 4; count++) { const next = decodeURIComponent(path); if (next === path) break; path = next; } } catch { return false; }
  if (/\\/u.test(path) || /(?:^|\/)(?:login|signin|signup|auth|account|checkout|cart|payment|pay|purchase|orders?|confirm|admin)(?:\/|$)/iu.test(path) ||
      /^\/ASP\/appt_req\.asp\/?$/iu.test(path)) return false;
  return [...parsed.searchParams.keys()].every(key => !/password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|profile|account|member|user/iu.test(key));
}
const url = z.string().max(2048).refine(safeDelegatedBookingUrl);
export const teeItUpDelegatedBookingProofSchema = z.object({
  kind: z.literal("OFFICIAL_DELEGATED_BOOKING_SOURCE"), officialUrl: url, bookingUrl: url,
  venueName: z.string().min(3).max(200), canonicalAddress: z.string().min(15).max(1024), timeZone: z.string().min(1).max(100),
  rootWitnessSha256: sha,
  hops: z.array(z.object({ pageUrl: url, nextUrl: url, witnessSha256: sha }).strict()).min(1).max(2),
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  facilityId: z.number().int().min(1).max(2147483647), courseId: z.string().min(1).max(128),
  providerAddress: z.string().min(3).max(1024),
  warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME"),
}).strict().refine(value => value.hops.at(-1)?.nextUrl === value.bookingUrl &&
  value.hops.every((hop, index) => index === 0 || value.hops[index - 1].nextUrl === hop.pageUrl) &&
  new Set([value.hops[0].pageUrl, ...value.hops.map(hop => hop.nextUrl)]).size === value.hops.length + 1 &&
  teeItUpBookAlias(value.bookingUrl) === value.alias);
export type TeeItUpDelegatedBookingProof = z.infer<typeof teeItUpDelegatedBookingProofSchema>;
export type DelegatedHop = TeeItUpDelegatedBookingProof["hops"][number];
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
const fail = (): never => { throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED"); };
export const delegatedWitnessHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function hidden(node: Element) {
  return ["script", "style", "template", "noscript", "iframe", "form"].includes(node.tagName) ||
    ["hidden", "inert"].some(key => attr(node, key) !== undefined) || attr(node, "aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(node, "class") ?? "");
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && hidden(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function entries(page: OfficialIdentityPage) {
  if (page.html.length > 600000 || !page.visibleEvidence || page.browserTransport !== "NATIVE_CHROME") return fail();
  const all: Element[] = [];
  const visit = (node: Node) => {
    if (element(node) && hidden(node)) return;
    if (element(node)) all.push(node);
    if (all.length > 20000) fail();
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(page.html)); return all;
}
function physicalContext(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!element(current)) continue;
    const context = [attr(current, "aria-label"), attr(current, "title"), ...current.childNodes.filter(child => element(child) && /^h[1-6]$/u.test(child.tagName)).map(text)].join(" ");
    if (/\b(?:mailing|corporate|billing|headquarters)\b/iu.test(context)) return false;
  }
  return true;
}
/** Canonical venue identity is proved only on the actual official root. This
 * does not assert that a delegated URL occurs directly on that document. */
export function delegatedCanonicalVenueWitness(source: OfficialIdentitySource, page: OfficialIdentityPage,
  onGate?: (key: DelegatedDiagnosticGate, value: boolean) => void) {
  const gate = (key: DelegatedDiagnosticGate, value: boolean) => { try { onGate?.(key, value); } catch { /* Observation cannot change validation. */ } return value; };
  if (!source.officialUrl || !source.venueAddress || page.url !== source.officialUrl) { gate("rootUrlExact", false); return fail(); }
  gate("rootUrlExact", true);
  const all = entries(page), expected = fullCourseName(source.venueName), address = teeItUpCompleteStreetAddress(source.venueAddress);
  if (!gate("canonicalAddressValid", Boolean(address && expected.replace(/\bgolf course$/u, "").trim().length >= 5))) return fail();
  const headings = all.filter(node => /^(?:h1|h2)$/u.test(node.tagName)).map(node => fullCourseName(clean(text(node)).replace(/^Welcome to\s+/iu, "")));
  if (!gate("rootRawVenue", headings.includes(expected) && !all.some(node => node.tagName === "h1" && fullCourseName(clean(text(node)).replace(/^Welcome to\s+/iu, "")) !== expected)) ||
      !gate("rootRenderedVenue", page.visibleEvidence!.headings.some(value => fullCourseName(clean(value).replace(/^Welcome to\s+/iu, "")) === expected))) return fail();
  const addresses = all.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName) && physicalContext(node) && clean(text(node)).length <= 500)
    .map(node => teeItUpCompleteStreetAddress(clean(text(node)).replace(/^Address\s*:\s*/iu, ""))).filter(Boolean);
  const canonical = JSON.stringify(address);
  // Preserve the existing official-home predicate: a public government page
  // may also display an unrelated agency footer address. Only the exact full
  // canonical physical address can corroborate this venue's identity.
  if (!gate("rootRawAddress", addresses.some(value => JSON.stringify(value) === canonical)) ||
      !gate("rootRenderedAddress", page.visibleEvidence!.addressTexts.some(value => JSON.stringify(teeItUpCompleteStreetAddress(clean(value).replace(/^Address\s*:\s*/iu, ""))) === canonical))) return fail();
  return delegatedWitnessHash({ venueName: expected, address });
}
/** Every exact edge must occur in both nonhidden inert markup and its own
 * current rendered document; neither a report nor a URL set is authority. */
export function delegatedBookingHop(page: OfficialIdentityPage, requestedNext?: string,
  onGate?: (key: DelegatedDiagnosticGate, value: boolean) => void): DelegatedHop {
  const note = (key: DelegatedDiagnosticGate, value: boolean) => { try { onGate?.(key, value); } catch { /* Observation cannot change validation. */ } };
  note("hopNative", page.browserTransport === "NATIVE_CHROME" && Boolean(page.visibleEvidence));
  note("hopRawBounded", page.html.length <= 600000);
  const all = entries(page);
  const links = all.filter(node => node.tagName === "a" && /\b(?:tee\s*times?|book|reservations?|reserve)\b/iu.test(text(node)) &&
    !/\b(?:lesson|member|login|sign in|checkout|purchase|payment|confirm|account)\b/iu.test(text(node))).flatMap(node => {
    try { const next = new URL(attr(node, "href") ?? "", page.url).href; return safeDelegatedBookingUrl(next) && next !== page.url &&
      page.visibleEvidence!.linkUrls.includes(next) ? [next] : []; } catch { return []; }
  });
  const candidates = [...new Set(links)].filter(value => requestedNext === undefined || value === requestedNext);
  note("hopRawLinkPresent", all.some(node => node.tagName === "a" && (() => { try { return requestedNext === undefined || new URL(attr(node, "href") ?? "", page.url).href === requestedNext; } catch { return false; } })()));
  note("hopRenderedLinkPresent", requestedNext === undefined ? Boolean(page.visibleEvidence?.linkUrls.length) : Boolean(page.visibleEvidence?.linkUrls.includes(requestedNext)));
  note("hopUnique", candidates.length === 1);
  if (candidates.length !== 1) return fail();
  return { pageUrl: page.url, nextUrl: candidates[0], witnessSha256: delegatedWitnessHash({ pageUrl: page.url, nextUrl: candidates[0] }) };
}

/** Physical directory matching uses the existing official-facility predicate.
 * Delegation does not excuse any street, ZIP, name or timezone discrepancy. */
export function bindDelegatedFacility(source: OfficialIdentitySource, chain: { rootWitnessSha256: string; hops: DelegatedHop[] }, directory: unknown): TeeItUpDelegatedBookingProof {
  const diagnostic = createDelegationDiagnostic("PROVIDER_BIND");
  try {
  const rows = z.array(z.object({ id: z.number().int().min(1).max(2147483647), courseId: z.string().min(1).max(128), name: z.string().min(3).max(256),
    address: z.string().min(3).max(1024), timeZone: z.string().min(1).max(100), isSimulator: z.boolean().optional() })).min(1).max(100).safeParse(directory);
  const address = source.venueAddress && completeUSAddress(source.venueAddress), alias = teeItUpBookAlias(source.bookingUrl);
  diagnostic.gates.directoryValid = rows.success;
  diagnostic.gates.canonicalAddressValid = Boolean(address);
  diagnostic.gates.directoryIdsUnique = rows.success ? new Set(rows.data.map(row => row.id)).size === rows.data.length && new Set(rows.data.map(row => row.courseId)).size === rows.data.length : null;
  if (!rows.success || !address || !alias || !source.officialUrl || new Set(rows.data.map(row => row.id)).size !== rows.data.length ||
      new Set(rows.data.map(row => row.courseId)).size !== rows.data.length) return fail();
  const matching = rows.data.filter(row => row.isSimulator === false && matchesOfficialFacility({ venueName: fullCourseName(source.venueName), alternateAddress: address }, source, row));
  diagnostic.gates.providerUniqueMatch = matching.length === 1;
  if (matching.length !== 1) return fail();
  const selected = matching[0];
  return teeItUpDelegatedBookingProofSchema.parse({ kind: "OFFICIAL_DELEGATED_BOOKING_SOURCE", officialUrl: source.officialUrl, bookingUrl: source.bookingUrl,
    venueName: source.venueName, canonicalAddress: source.venueAddress, timeZone: source.timeZone,
    rootWitnessSha256: chain.rootWitnessSha256, hops: chain.hops, alias,
    facilityId: selected.id, courseId: selected.courseId, providerAddress: selected.address, warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
  } catch (error) { rememberTeeItUpDelegationFailure(error, diagnostic); throw error; }
}
