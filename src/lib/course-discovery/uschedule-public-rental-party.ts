import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { parseUScheduleLocationSource } from "@/lib/simulators/providers/uschedule-location-source";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";
import { fullCourseName, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";

export const uschedulePublicRentalPartyProofSchema = z.object({
  kind: z.literal("OFFICIAL_PUBLIC_RENTAL_PARTY_V1"), officialPageUrl: z.string().url().max(2048),
  bookingUrl: z.string().url().max(2048), venueName: z.string().min(3).max(200), addressSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  maxPartySize: z.number().int().min(1).max(4), markupWitnessSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type USchedulePublicRentalPartyProof = z.infer<typeof uschedulePublicRentalPartyProofSchema>;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const clean = (v: string) => v.normalize("NFKC").replace(/\s+/gu, " ").trim();
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const headingName = (v: string) => fullCourseName(clean(v).replace(/^welcome to\s+/iu, ""));
const address = (v: string) => parsePublicUSBusinessAddress(clean(v).replace(/^Address(?:\s*[:,]\s*|\s+)/iu, ""));
const element = (v: Node): v is Element => "tagName" in v;
const attr = (v: Element, key: string) => v.attrs.find(a => a.name === key)?.value;
function hidden(v: Element, publicForm?: Element) {
  let current: Node | undefined = v;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current)) {
      const node = current;
      if (["script", "style", "template", "noscript", "iframe", "input", "button", "select", "textarea", "label"].includes(node.tagName) || node.tagName === "form" && node !== publicForm ||
        ["hidden", "inert", "contenteditable"].some(k => attr(node, k) !== undefined) || attr(node, "aria-hidden") === "true" ||
        /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:[.;]|$)/iu.test(attr(node, "style") ?? "") ||
        /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only)(?:\s|$)/iu.test(attr(node, "class") ?? "") ||
        /\b(?:account|profile|checkout|payment|billing|login|sign-in|members-only)\b/iu.test(["id", "class", "aria-label", "title"].map(k => attr(node, k) ?? "").join(" "))) return true;
    }
  }
  return false;
}
function text(node: Node, publicForm?: Element): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && hidden(node, publicForm)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(child => text(child, publicForm)).join(" ") : "";
}
function containsControl(node: Node): boolean {
  return element(node) && (["input", "textarea", "select", "button", "label"].includes(node.tagName) || attr(node, "contenteditable") !== undefined) ||
    "childNodes" in node && node.childNodes.some(containsControl);
}
export function publicRentalPartySize(value: string): number | undefined {
  const v = clean(value);
  if (v.length > 500 || !/\bpublic simulator rental\b/iu.test(v) || !/\bper bay\b/iu.test(v) ||
      /\b(?:not|no|unavailable|prohibited|cannot|closed|members? only|private event|party package|additional guest|extra guest|per person)\b/iu.test(v)) return;
  const matches = [...v.matchAll(/\b(?:up to|max(?:imum)?(?: of)?)\s+([1-4])\s+(?:golfers|players|people)\b/giu)];
  if (matches.length !== 1) return;
  return Number(matches[0][1]);
}
/** Initial proof uses independently captured native raw and computed-visible
 * official evidence. Warm reads recheck the same bounded public witnesses. */
export function deriveUSchedulePublicRentalParty(source: OfficialIdentitySource, page: OfficialIdentityPage, requireVisible = true): USchedulePublicRentalPartyProof {
  const fail = (): never => { throw new Error("USCHEDULE_PUBLIC_PARTY_UNVERIFIED"); };
  if (!source.officialUrl || !source.venueAddress || Buffer.byteLength(page.html) > 600_000 || page.url !== source.officialUrl) return fail();
  const current = new URL(page.url), booking = parseUScheduleLocationSource(source.bookingUrl);
  if (current.protocol !== "https:" || current.username || current.password || current.port || current.hash || !booking || booking.locationId || booking.url !== booking.canonicalUrl) return fail();
  const canonicalAddress = parsePublicUSBusinessAddress(source.venueAddress), expectedName = fullCourseName(source.venueName);
  if (!canonicalAddress || expectedName.length < 8) return fail();
  const entries: Element[] = [], stack: Array<{ node: Node; depth: number }> = [{ node: parse(page.html), depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 80 || entries.length > 20_000) return fail();
    if (element(node)) entries.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
  }
  const forms = entries.filter(n => n.tagName === "form");
  let publicForm: Element | undefined;
  if (forms.length === 1 && forms[0].parentNode?.nodeName === "body" && (attr(forms[0], "method") ?? "get").toLowerCase() === "post") {
    const form = forms[0];
    try {
      const inForm = (n: Node): boolean => n === form || "parentNode" in n && Boolean(n.parentNode && inForm(n.parentNode));
      if (new URL(attr(form, "action") ?? "", current).href === current.href &&
          entries.some(n => (n.tagName === "footer" || attr(n, "role") === "contentinfo") && inForm(n)) &&
          entries.some(n => ["h1", "h2"].includes(n.tagName) && inForm(n) && !hidden(n, form) && !containsControl(n) && headingName(text(n, form)) === expectedName)) publicForm = form;
    } catch { /* A form action cannot supply missing document identity. */ }
  }
  const readText = (n: Node) => text(n, publicForm), eligible = (n: Element) => !hidden(n, publicForm) && !containsControl(n);
  const title = entries.filter(n => n.tagName === "title"), headings = entries.filter(n => ["h1", "h2"].includes(n.tagName) && eligible(n));
  if (title.length !== 1 || !clean(readText(title[0])).split(/\s*[|–—]\s*/u).some(v => fullCourseName(v) === expectedName) ||
      !headings.some(n => headingName(readText(n)) === expectedName)) return fail();
  const links = entries.filter(n => n.tagName === "a" && eligible(n) && /\b(?:book|rental|reservation)\b/iu.test(readText(n))).filter(n => {
    try { return new URL(attr(n, "href") ?? "", current).href === source.bookingUrl; } catch { return false; }
  });
  const addresses = entries.filter(n => ["address", "p", "div", "li", "td"].includes(n.tagName) && eligible(n)).filter(n => {
    const value = clean(readText(n)); return value.length <= 500 && JSON.stringify(address(value)) === JSON.stringify(canonicalAddress);
  });
  const capacity = entries.filter(n => ["p", "div", "section", "li"].includes(n.tagName) && eligible(n)).flatMap(n => {
    const size = publicRentalPartySize(readText(n)); return size ? [{ n, size, value: clean(readText(n)) }] : [];
  });
  const sizes = new Set(capacity.map(v => v.size));
  if (!links.length || !addresses.length || sizes.size !== 1) return fail();
  const maxPartySize = [...sizes][0];
  if (requireVisible) {
    const visible = page.visibleEvidence;
    if (page.browserTransport !== "NATIVE_CHROME" || !visible || clean(visible.title) !== clean(readText(title[0])) ||
        !visible.headings.some(v => headingName(v) === expectedName) || !visible.linkUrls.includes(source.bookingUrl) ||
        !visible.addressTexts.some(v => JSON.stringify(address(v)) === JSON.stringify(canonicalAddress)) ||
        !visible.publicRentalTexts?.some(v => publicRentalPartySize(v) === maxPartySize) ||
        visible.publicRentalTexts.some(v => publicRentalPartySize(v) !== undefined && publicRentalPartySize(v) !== maxPartySize)) return fail();
  }
  // Store semantic public witnesses, not the page, selectors or executable code.
  return uschedulePublicRentalPartyProofSchema.parse({ kind: "OFFICIAL_PUBLIC_RENTAL_PARTY_V1", officialPageUrl: page.url,
    bookingUrl: source.bookingUrl, venueName: source.venueName, addressSha256: digest(canonicalAddress), maxPartySize,
    markupWitnessSha256: digest({ name: expectedName, address: canonicalAddress, bookingUrl: source.bookingUrl,
      rentalScope: "PUBLIC_SIMULATOR_RENTAL_PER_BAY", capacityStatement: { maximum: maxPartySize, unit: "PEOPLE" } }) });
}
