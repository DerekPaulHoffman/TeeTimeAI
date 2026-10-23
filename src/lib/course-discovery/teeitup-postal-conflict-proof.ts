import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, deriveTeeItUpOfficialIdentityProof, fullCourseName, teeItUpOfficialIdentityProofSchema,
  type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import { teeItUpBookAlias, teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";

const phone = z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u);
const id = z.number().int().min(1).max(2_147_483_647);
const address = z.string().min(15).max(1024);
const wholeBrandSourceProof = teeItUpOfficialIdentityProofSchema.extend({ kind: z.literal("OFFICIAL_WHOLE_BRAND_ADDRESS") });
export const teeItUpPostalConflictProofSchema = z.object({
  kind: z.literal("OFFICIAL_POSTAL_CONFLICT"), officialUrl: teeItUpOfficialIdentityProofSchema.shape.officialPageUrl,
  officialSourceProof: z.union([teeItUpOfficialIdentityProofSchema, wholeBrandSourceProof]),
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u), facilityId: id,
  courseId: z.string().min(1).max(128), timeZone: z.string().min(1).max(100), canonicalAddress: address, providerAddress: address,
  postalConflict: z.object({ canonical: z.string().regex(/^\d{5}$/u), provider: z.string().regex(/^\d{5}$/u) }).strict()
    .refine(value => value.canonical !== value.provider),
  publicCoursePhone: phone, phoneWitnessSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  providerAddressVerified: z.literal(false), initialVisibility: z.literal("RENDERED_CONTROLLER_OBSERVATION"),
  warmVisibility: z.enum(["INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED", "RENDERED_CONTROLLER_OBSERVATION"]),
  warmTransport: z.literal("NATIVE_CHROME").optional(), requiredCapability: z.literal("LOCAL_CHROME").optional(),
}).strict().refine(value => (value.warmTransport === "NATIVE_CHROME") === (value.requiredCapability === "LOCAL_CHROME") &&
  (value.warmTransport === "NATIVE_CHROME") === (value.warmVisibility === "RENDERED_CONTROLLER_OBSERVATION"));
export type TeeItUpPostalConflictProof = z.infer<typeof teeItUpPostalConflictProofSchema>;

/** Only one published US course telephone, never arbitrary contact/account text. */
export function normalizePublicCoursePhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 ||
      !/^(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}$/u.test(value.trim())) return;
  const digits = value.replace(/\D/gu, "");
  const parsed = phone.safeParse(`+${digits.length === 10 ? "1" : ""}${digits}`);
  return parsed.success ? parsed.data : undefined;
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const restricted = /(?:account|member|profile|customer|checkout|payment|billing|corporate|mailing|fax)/iu;
function excluded(node: Element) {
  return ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button"].includes(node.tagName) ||
    attr(node, "hidden") !== undefined || attr(node, "inert") !== undefined || attr(node, "aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(node, "class") ?? "") ||
    restricted.test(["id", "class", "aria-label", "title", "name"].map(key => attr(node, key) ?? "").join(" "));
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function officialEntries(page: OfficialIdentityPage) {
  if (Buffer.byteLength(page.html, "utf8") > 600_000) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  const entries: Element[] = [];
  function visit(node: Node, depth = 0) {
    if (depth > 64 || entries.length > 20_000) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
    if (element(node) && excluded(node)) return;
    if (element(node)) entries.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
  }
  visit(parse(page.html));
  return entries;
}
function witness(entries: Element[]) {
  return createHash("sha256").update(JSON.stringify(entries.map(node => {
    const ancestry: unknown[] = [];
    for (let current: Node | undefined = node, depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
      if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value =>
        ["id", "class", "style", "hidden", "inert", "aria-hidden", "href", "title", "aria-label"].includes(value.name)).map(value => [value.name, value.value]).sort()]);
    }
    return [clean(text(node)), ancestry];
  }))).digest("hex");
}
function publicPhoneWitness(page: OfficialIdentityPage, requireVisibleEvidence: boolean) {
  const entries = officialEntries(page);
  const anchors = entries.filter(node => node.tagName === "a" && /^tel:/u.test(attr(node, "href") ?? ""));
  const numbers = anchors.map(node => {
    const number = normalizePublicCoursePhone((attr(node, "href") ?? "").slice(4));
    if (!number || normalizePublicCoursePhone(clean(text(node))) !== number) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
    return number;
  });
  if (!numbers.length || new Set(numbers).size !== 1 || requireVisibleEvidence &&
      !page.visibleEvidence?.phoneTexts?.some(value => normalizePublicCoursePhone(value) === numbers[0]))
    throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  return { number: numbers[0], sha256: witness(anchors) };
}

/** Only the optional Address label's empty BR delimiter is normalized. */
function postalSourceAddress(value: string) { return completeUSAddress(clean(value).replace(/^Address\s*:\s*,?\s*/iu, "")); }
function hasNonPhysicalAddressContext(node: Element) {
  let current: Node | undefined = node;
  // Match the legacy identity parser's bounded semantic address context.
  for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!element(current)) continue;
    const context = [attr(current, "aria-label"), attr(current, "title"), ...current.childNodes.filter(child =>
      element(child) && /^h[1-6]$/u.test(child.tagName)).map(text)].join(" ");
    if (/\b(?:mailing|corporate|billing|headquarters)\b/iu.test(context)) return true;
  }
  return false;
}
function derivePostalSource(source: OfficialIdentitySource, page: OfficialIdentityPage, requireVisibleEvidence: boolean) {
  try { return deriveTeeItUpOfficialIdentityProof(source, page, { requireVisibleEvidence }); } catch { /* Separate strict brand grammar below. */ }
  const fail = (): never => { throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED"); };
  if (!source.officialUrl || !source.venueAddress || new URL(page.url).origin !== new URL(source.officialUrl).origin) return fail();
  const entries = officialEntries(page), canonical = completeUSAddress(source.venueAddress), expected = fullCourseName(source.venueName);
  if (!canonical || expected.replace(/\bgolf course\b/gu, "").trim().length < 5) return fail();
  const titles = entries.filter(node => node.tagName === "title"), root = new URL("/", source.officialUrl).href;
  const titleParts = titles.length === 1 ? clean(text(titles[0])).split(/\s*(?:\||–|—| - )\s*/u) : [];
  if (!titleParts.length || titleParts.length > 3 || !titleParts.some(value => fullCourseName(value) === expected) ||
      titleParts.some(value => fullCourseName(value) !== expected && !/^(?:home|welcome)$/iu.test(value))) return fail();
  const brands = entries.filter(node => node.tagName === "a" && [node, node.parentNode].some(value => value && element(value) &&
    /(?:^|\s)site-title(?:\s|$)/u.test(attr(value, "class") ?? "")));
  if (!brands.length || brands.length > 8 || brands.some(node => fullCourseName(text(node)) !== expected ||
      new URL(attr(node, "href") ?? "", page.url).href !== root)) return fail();
  if (entries.some(node => node.tagName === "h1" && fullCourseName(text(node).replace(/^welcome to /iu, "")) !== expected)) return fail();
  const addresses = entries.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName) && clean(text(node)).length <= 500 &&
    !hasNonPhysicalAddressContext(node) && postalSourceAddress(text(node)));
  const distinct = new Set(addresses.map(node => JSON.stringify(postalSourceAddress(text(node)))));
  if (distinct.size !== 1 || !distinct.has(JSON.stringify(canonical))) return fail();
  const bookingLinks = entries.filter(node => node.tagName === "a" && /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text(node))).flatMap(node => {
    try { const url = new URL(attr(node, "href") ?? "", page.url); return teeItUpBookAlias(url.href) ? [{ node, url: url.href, alias: teeItUpBookAlias(url.href) }] : []; }
    catch { return []; }
  });
  if (!bookingLinks.some(link => link.url === source.bookingUrl) || bookingLinks.some(link => link.alias !== teeItUpBookAlias(source.bookingUrl))) return fail();
  if (requireVisibleEvidence && (!page.visibleEvidence || clean(page.visibleEvidence.title) !== clean(text(titles[0])) ||
      !page.visibleEvidence.brandLinks?.some(link => link.href === root && fullCourseName(link.text) === expected) ||
      !page.visibleEvidence.addressTexts.some(value => JSON.stringify(postalSourceAddress(value)) === JSON.stringify(canonical)) ||
      !page.visibleEvidence.linkUrls.includes(source.bookingUrl))) return fail();
  return wholeBrandSourceProof.parse({ kind: "OFFICIAL_WHOLE_BRAND_ADDRESS", officialPageUrl: page.url, bookingUrl: source.bookingUrl,
    venueName: expected, alternateAddress: canonical, markupWitnessSha256: witness([...titles, ...brands, ...addresses, ...bookingLinks.map(link => link.node)]) });
}

/** A separate, fail-closed rule for one conflicting postal code. All other
 * physical identity fields agree, with an independent published phone match.
 * Discovery requires rendered source evidence. Native attestations refresh raw
 * and rendered source witnesses plus the directory on every execution. */
export function bindTeeItUpPostalConflictProof(source: OfficialIdentitySource, page: OfficialIdentityPage, directory: unknown,
  options: { requireVisibleEvidence?: boolean } = {}): TeeItUpPostalConflictProof {
  const fail = (): never => { throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED"); };
  const alias = teeItUpBookAlias(source.bookingUrl);
  if (!alias || !source.venueAddress || !source.officialUrl) return fail();
  const official = new URL(source.officialUrl), booking = new URL(source.bookingUrl);
  if (official.origin === booking.origin || /(?:^|\.)(?:teeitup\.(?:com|golf)|kenna\.io)$/u.test(official.hostname)) return fail();
  const native = page.browserTransport === "NATIVE_CHROME";
  const requireVisible = options.requireVisibleEvidence === true || native;
  const officialSourceProof = derivePostalSource(source, page, requireVisible);
  // New whole-brand grammar requires the fresh rendered warm reader. Legacy
  // heading attestations retain their existing shape and behavior.
  if (officialSourceProof.kind === "OFFICIAL_WHOLE_BRAND_ADDRESS" && !native) return fail();
  // The existing alternate-address proof may establish another street. This
  // rule never does: the official full address must equal canonical identity.
  if (JSON.stringify(completeUSAddress(source.venueAddress)) !== JSON.stringify(officialSourceProof.alternateAddress)) return fail();
  const canonical = teeItUpCompleteStreetAddress(source.venueAddress);
  const rows = z.array(z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(3).max(256), address,
    timeZone: z.string().min(1).max(100), country: z.string().max(10).optional(), isSimulator: z.boolean().optional(), phone: z.unknown().optional(),
  })).min(1).max(100).safeParse(directory);
  if (!canonical || !rows.success || new Set(rows.data.map(row => row.id)).size !== rows.data.length ||
      new Set(rows.data.map(row => row.courseId)).size !== rows.data.length) return fail();
  const matching = rows.data.filter(row => fullCourseName(row.name) === fullCourseName(source.venueName));
  if (matching.length !== 1) return fail();
  const selected = matching[0], provider = teeItUpCompleteStreetAddress(selected.address);
  if (!provider || selected.isSimulator !== false || selected.country !== "US" || selected.timeZone !== source.timeZone ||
      canonical.postalCode === provider.postalCode || !/^\d{5}$/u.test(canonical.postalCode) || !/^\d{5}$/u.test(provider.postalCode) ||
      JSON.stringify({ ...canonical, postalCode: "" }) !== JSON.stringify({ ...provider, postalCode: "" })) return fail();
  const contact = publicPhoneWitness(page, requireVisible);
  if (normalizePublicCoursePhone(selected.phone) !== contact.number) return fail();
  return teeItUpPostalConflictProofSchema.parse({ kind: "OFFICIAL_POSTAL_CONFLICT", officialUrl: source.officialUrl, officialSourceProof, alias, facilityId: selected.id,
    courseId: selected.courseId, timeZone: source.timeZone, canonicalAddress: source.venueAddress, providerAddress: selected.address,
    postalConflict: { canonical: canonical.postalCode, provider: provider.postalCode }, publicCoursePhone: contact.number,
    phoneWitnessSha256: contact.sha256, providerAddressVerified: false, initialVisibility: "RENDERED_CONTROLLER_OBSERVATION",
    warmVisibility: native ? "RENDERED_CONTROLLER_OBSERVATION" : "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED",
    ...(native ? { warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" } : {}) });
}
