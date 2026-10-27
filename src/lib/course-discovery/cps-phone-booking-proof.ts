import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName, type OfficialIdentityPage } from "./teeitup-official-identity";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { hasInertPublicBookingLink } from "./public-course-contact-blocks";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";

type Source = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(row => row.name === key)?.value ?? "";
const restricted = /\b(?:mailing|corporate|billing|headquarters|account|member|profile|customer|checkout|payment|fax)\b/iu;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button"].includes(node.tagName) ||
  node.attrs.some(row => ["hidden", "inert"].includes(row.name) || row.name === "aria-hidden" && row.value === "true") ||
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/iu.test(attr(node, "style")) ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/iu.test(attr(node, "class")) ||
  restricted.test(["id", "class", "title", "aria-label"].map(key => attr(node, key)).join(" "));
const text = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value :
  element(node) && excluded(node) ? "" : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (): never => { throw new Error("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED"); };
const publicUrl = z.string().url().max(2048).refine(value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash; } catch { return false; } });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const cpsPhoneBookingProofSchema = z.object({ kind: z.literal("OFFICIAL_PHONE_BOOKING_LINK"), officialUrl: publicUrl,
  officialPageUrl: publicUrl, bookingUrl: publicUrl, tenant: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  venueName: z.string().min(3).max(200), canonicalAddressInput: z.string().min(15).max(1024), timeZone: z.string().min(1).max(100),
  canonicalCoursePhone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u), providerVenueName: z.string().min(3).max(200),
  catalogHash: digest, courseIds: z.array(z.number().int().positive()).length(1), rawWitnessSha256: digest, renderedWitnessSha256: digest,
  selectedAnchorLabel: z.string().min(3).max(160).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value)).optional(),
  selectedAnchorRawWitnessSha256: digest.optional(), selectedAnchorRenderedWitnessSha256: digest.optional(),
  warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME") }).strict()
  .refine(value => [value.selectedAnchorLabel,value.selectedAnchorRawWitnessSha256,value.selectedAnchorRenderedWitnessSha256]
    .every(part => Boolean(part) === Boolean(value.selectedAnchorLabel)));
export type CpsPhoneBookingProof = z.infer<typeof cpsPhoneBookingProofSchema>;

const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
/** A course choice must be named by the official link itself. Generic booking
 * calls to action carry no authority when the public catalog has choices. */
export function cpsOfficialCourseDescriptor(value: string) {
  const label = fullCourseName(clean(value));
  const match = /^(.{3,100}) tee times?$/u.exec(label) ?? /^tee times? (?:for|at) (.{3,100})$/u.exec(label);
  if (!match || /^(?:book(?: a| this)?|booking|reserve|reservation|course|golf course|a|the)(?:\s|$)/u.test(match[1])) return undefined;
  return match[1];
}
export function cpsOfficialSelectedCourseName(venueName: string, descriptor: string) {
  const canonical = fullCourseName(venueName), stem = canonical.replace(/\s+(?:country club|golf course)$/u, "");
  if (stem === canonical || stem.replace(/\s/gu, "").length < 6 || !cpsOfficialCourseDescriptor(descriptor + " Tee Times")) return undefined;
  return fullCourseName(stem + " " + descriptor);
}

export function hasCpsObservedSelectedCourseLabel(source: Source, page: OfficialIdentityPage) {
  return page.visibleEvidence?.publicLinkLabels?.some(row => row.href === source.bookingUrl &&
    typeof row.text === "string" && Boolean(cpsOfficialCourseDescriptor(row.text))) === true;
}

/** Exact href and label from the same current rendered anchor and inert HTML. */
export function selectedCpsOfficialBookingAnchor(source: Source, page: OfficialIdentityPage) {
  if (!freshNativeCanonicalRootDocument(page, source.officialUrl) || page.visibleEvidence?.publicLinkLabelsOmitted === true ||
      !Array.isArray(page.visibleEvidence?.publicLinkLabels)) return undefined;
  const shown = page.visibleEvidence.publicLinkLabels.filter(row => row.href === source.bookingUrl);
  if (!shown.length || shown.length > 8 || shown.some(row => typeof row.text !== "string" || row.text.length > 160)) return undefined;
  const labels = new Set(shown.map(row => clean(row.text)));
  if (labels.size !== 1) return undefined;
  const selectedAnchorLabel = [...labels][0], descriptor = cpsOfficialCourseDescriptor(selectedAnchorLabel);
  if (!descriptor || page.visibleEvidence.publicLinkLabels.some(row => row.href !== source.bookingUrl &&
      cpsOfficialCourseDescriptor(row.text) === descriptor) || Buffer.byteLength(page.html, "utf8") > 600_000) return undefined;
  const raw = parse(page.html), rawLabels: string[] = []; let visited = 0, rawMatchingHref = 0;
  const walk = (node: Node, depth = 0) => {
    if (++visited > 20_000 || depth > 64) return fail();
    if (element(node)) {
      if (excluded(node)) return;
      if (node.tagName === "a") {
        let href: string; try { href = new URL(attr(node, "href"), page.url).href; } catch { href = ""; }
        if (href === source.bookingUrl) {
          if (++rawMatchingHref > 20) return fail();
          const label = clean(text(node));
          // The raw response has no computed CSS. Bind only the exact href and
          // label independently observed in the fresh rendered document.
          if (label === selectedAnchorLabel) rawLabels.push(label);
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(child => walk(child, depth + 1));
  };
  walk(raw);
  if (new Set(rawLabels).size !== 1 || !rawLabels.includes(selectedAnchorLabel)) return undefined;
  return { selectedAnchorLabel, descriptor,
    selectedAnchorRawWitnessSha256: hash({ href: source.bookingUrl, labels: [...rawLabels].sort(), selectedAnchorLabel }),
    selectedAnchorRenderedWitnessSha256: hash({ href: source.bookingUrl,
      labels: shown.map(row=>clean(row.text)).sort(), selectedAnchorLabel }) };
}

function rawContact(html: string, expectedVenue: string, renderedContacts: Array<{ href: string; text: string }>) {
  if (Buffer.byteLength(html, "utf8") > 600_000) return fail();
  const root = parse(html), anchors: Array<{ href: string; text: string; node: Element }> = [], headings: string[] = [];
  let visited = 0;
  const walk = (node: Node, depth = 0) => {
    if (++visited > 20_000 || depth > 64) return fail();
    if (element(node)) {
      if (excluded(node)) return;
      if (/^h[1-6]$/u.test(node.tagName)) headings.push(text(node).replace(/\s+/gu, " ").trim());
      if (node.tagName === "a" && attr(node, "href").startsWith("tel:")) anchors.push({ href: attr(node, "href"), text: text(node).replace(/\s+/gu, " ").trim(), node });
    }
    if ("childNodes" in node) node.childNodes.forEach(child => walk(child, depth + 1));
  };
  walk(root);
  if (anchors.length < 1 || anchors.length > 100 || !headings.some(name => fullCourseName(name) === expectedVenue)) return fail();
  const hasContactHeading = (node: Node, depth = 0): boolean => {
    if (depth > 8 || element(node) && excluded(node)) return false;
    if (element(node) && /^h[1-6]$/u.test(node.tagName) && text(node).replace(/\s+/gu, " ").trim().toLowerCase() === "contact us") return true;
    return "childNodes" in node && node.childNodes.some(child => hasContactHeading(child, depth + 1));
  };
  // Raw HTML cannot determine computed CSS visibility. Bind only the exact
  // anchors the fresh native DOM reported visible; an uncaptured responsive
  // placeholder (including a blank tel label) grants no proof or veto.
  const visiblePairs = new Set(renderedContacts.map(row => JSON.stringify([row.href, row.text])));
  const matchedPairs = new Set<string>(), contactPhones = new Set<string>();
  for (const row of anchors) {
    const pair = JSON.stringify([row.href, row.text]);
    if (!visiblePairs.has(pair)) continue;
    if (row.href.length > 64 || row.text.length > 47) return fail();
    const target = normalizePublicCoursePhone(row.href.slice(4)), printed = normalizePublicCoursePhone(row.text);
    if (!target || target !== printed) return fail();
    let parent: Node | undefined = row.node.parentNode ?? undefined, depth = 0;
    while (parent && depth++ < 8 && !(element(parent) && parent.tagName === "body")) {
      if (hasContactHeading(parent)) { contactPhones.add(target); matchedPairs.add(pair); break; }
      parent = "parentNode" in parent ? parent.parentNode ?? undefined : undefined;
    }
  }
  if (matchedPairs.size !== visiblePairs.size) return fail();
  return { matchedPairs: [...matchedPairs].sort(), contactPhones: [...contactPhones].sort(), venueHeading: expectedVenue };
}

/** Current official root, raw and rendered venue/phone/link, never a postal claim. */
export function verifyCpsPhoneBookingContact(source: Source, page: OfficialIdentityPage, canonicalCoursePhone: unknown) {
  const root = freshNativeCanonicalRootDocument(page, source.officialUrl), expectedVenue = fullCourseName(source.venueName),
    phone = normalizePublicCoursePhone(canonicalCoursePhone), visible = page.visibleEvidence, canonicalAddress = source.venueAddress && completeUSAddress(source.venueAddress);
  if (!root || !visible || !phone || !canonicalAddress || !expectedVenue || page.browserTransport !== "NATIVE_CHROME" ||
      !visible.headings.some(name => fullCourseName(name) === expectedVenue) || !visible.linkUrls.includes(source.bookingUrl) ||
      visible.phoneTextsOmitted === true || visible.contactPhoneLinksOmitted === true ||
      !Array.isArray(visible.phoneTexts) || !Array.isArray(visible.contactPhoneLinks)) return fail();
  const renderedPhones = new Set(visible.phoneTexts.map(normalizePublicCoursePhone)), contactPhones = new Set<string>();
  for (const row of visible.contactPhoneLinks) {
    const target = typeof row.href === "string" && row.href.startsWith("tel:") ? normalizePublicCoursePhone(row.href.slice(4)) : undefined;
    const printed = normalizePublicCoursePhone(row.text);
    if (!target || target !== printed) return fail();
    contactPhones.add(target);
  }
  if (renderedPhones.size !== 1 || !renderedPhones.has(phone) || contactPhones.size !== 1 || !contactPhones.has(phone)) return fail();
  const raw = rawContact(page.html, expectedVenue, visible.contactPhoneLinks);
  if (raw.contactPhones.length !== 1 || raw.contactPhones[0] !== phone) return fail();
  try { if (!hasInertPublicBookingLink(page.html, page.url, source.bookingUrl)) return fail(); } catch { return fail(); }
  return { phone, canonicalAddressInput: source.venueAddress!, rawWitnessSha256: hash({ venue: raw.venueHeading, contactPairs: raw.matchedPairs,
      contactPhones: raw.contactPhones, bookingUrl: source.bookingUrl }), renderedWitnessSha256: hash({ venue: expectedVenue,
      phones: [...renderedPhones], contactPhones: [...contactPhones], bookingUrl: source.bookingUrl }) };
}
export function bindCpsPhoneBookingProof(source: Source, page: OfficialIdentityPage, canonicalCoursePhone: unknown,
  catalog: { tenant: string; catalogHash: string; courseIds: number[] }, providerVenueName: string): CpsPhoneBookingProof {
  const verified = verifyCpsPhoneBookingContact(source, page, canonicalCoursePhone);
  const selected = selectedCpsOfficialBookingAnchor(source, page);
  if (hasCpsObservedSelectedCourseLabel(source, page) && !selected) return fail();
  const multiCourseName = selected && cpsOfficialSelectedCourseName(source.venueName, selected.descriptor);
  if (selected && fullCourseName(selected.descriptor) !== fullCourseName(providerVenueName) &&
      multiCourseName !== fullCourseName(providerVenueName)) return fail();
  if (fullCourseName(providerVenueName) !== fullCourseName(source.venueName) &&
      (!multiCourseName || fullCourseName(providerVenueName) !== multiCourseName)) return fail();
  return cpsPhoneBookingProofSchema.parse({ kind: "OFFICIAL_PHONE_BOOKING_LINK", officialUrl: source.officialUrl, officialPageUrl: page.url,
    bookingUrl: source.bookingUrl, tenant: catalog.tenant, venueName: source.venueName, canonicalAddressInput: verified.canonicalAddressInput,
    timeZone: source.timeZone, canonicalCoursePhone: verified.phone, providerVenueName, catalogHash: catalog.catalogHash,
    courseIds: catalog.courseIds, rawWitnessSha256: verified.rawWitnessSha256, renderedWitnessSha256: verified.renderedWitnessSha256,
    ...(selected ? {
      selectedAnchorLabel: selected!.selectedAnchorLabel,
      selectedAnchorRawWitnessSha256: selected!.selectedAnchorRawWitnessSha256,
      selectedAnchorRenderedWitnessSha256: selected!.selectedAnchorRenderedWitnessSha256 } : {}),
    warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
}
