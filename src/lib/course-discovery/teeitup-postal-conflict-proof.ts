import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, deriveTeeItUpOfficialIdentityProof, fullCourseName, teeItUpOfficialIdentityProofSchema,
  type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";
import { teeItUpBookAlias, teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";

const phone = z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u);
const id = z.number().int().min(1).max(2_147_483_647);
const address = z.string().min(15).max(1024);
export const teeItUpPostalConflictProofSchema = z.object({
  kind: z.literal("OFFICIAL_POSTAL_CONFLICT"), officialUrl: teeItUpOfficialIdentityProofSchema.shape.officialPageUrl,
  officialSourceProof: teeItUpOfficialIdentityProofSchema,
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u), facilityId: id,
  courseId: z.string().min(1).max(128), timeZone: z.string().min(1).max(100), canonicalAddress: address, providerAddress: address,
  postalConflict: z.object({ canonical: z.string().regex(/^\d{5}$/u), provider: z.string().regex(/^\d{5}$/u) }).strict()
    .refine(value => value.canonical !== value.provider),
  publicCoursePhone: phone, phoneWitnessSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  providerAddressVerified: z.literal(false), initialVisibility: z.literal("RENDERED_CONTROLLER_OBSERVATION"),
  warmVisibility: z.literal("INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED"),
}).strict();
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
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function publicPhoneWitness(page: OfficialIdentityPage, requireVisibleEvidence: boolean) {
  if (Buffer.byteLength(page.html, "utf8") > 600_000) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  const entries: Element[] = [];
  function visit(node: Node, depth = 0) {
    if (depth > 64 || entries.length > 20_000) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
    if (element(node) && excluded(node)) return;
    if (element(node)) entries.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
  }
  visit(parse(page.html));
  const anchors = entries.filter(node => node.tagName === "a" && /^tel:/u.test(attr(node, "href") ?? ""));
  const numbers = anchors.map(node => {
    const number = normalizePublicCoursePhone((attr(node, "href") ?? "").slice(4));
    if (!number || normalizePublicCoursePhone(clean(text(node))) !== number) throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
    return number;
  });
  if (!numbers.length || new Set(numbers).size !== 1 || requireVisibleEvidence &&
      !page.visibleEvidence?.phoneTexts?.some(value => normalizePublicCoursePhone(value) === numbers[0]))
    throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  const witness = anchors.map(node => {
    const ancestry: unknown[] = [];
    for (let current: Node | undefined = node, depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
      if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value =>
        ["id", "class", "style", "hidden", "inert", "aria-hidden", "href", "title", "aria-label"].includes(value.name)).map(value => [value.name, value.value]).sort()]);
    }
    return [clean(text(node)), ancestry];
  });
  return { number: numbers[0], sha256: createHash("sha256").update(JSON.stringify(witness)).digest("hex") };
}

/** A separate, fail-closed rule for one conflicting postal code. All other
 * physical identity fields agree, with an independent published phone match.
 * Discovery requires rendered source evidence; warm readers refresh the same
 * inert markup witnesses and public facility directory on every execution. */
export function bindTeeItUpPostalConflictProof(source: OfficialIdentitySource, page: OfficialIdentityPage, directory: unknown,
  options: { requireVisibleEvidence?: boolean } = {}): TeeItUpPostalConflictProof {
  const fail = (): never => { throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED"); };
  const alias = teeItUpBookAlias(source.bookingUrl);
  if (!alias || !source.venueAddress || !source.officialUrl) return fail();
  const official = new URL(source.officialUrl), booking = new URL(source.bookingUrl);
  if (official.origin === booking.origin || /(?:^|\.)(?:teeitup\.(?:com|golf)|kenna\.io)$/u.test(official.hostname)) return fail();
  const officialSourceProof = deriveTeeItUpOfficialIdentityProof(source, page, options);
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
  const contact = publicPhoneWitness(page, options.requireVisibleEvidence === true);
  if (normalizePublicCoursePhone(selected.phone) !== contact.number) return fail();
  return teeItUpPostalConflictProofSchema.parse({ kind: "OFFICIAL_POSTAL_CONFLICT", officialUrl: source.officialUrl, officialSourceProof, alias, facilityId: selected.id,
    courseId: selected.courseId, timeZone: source.timeZone, canonicalAddress: source.venueAddress, providerAddress: selected.address,
    postalConflict: { canonical: canonical.postalCode, provider: provider.postalCode }, publicCoursePhone: contact.number,
    phoneWitnessSha256: contact.sha256, providerAddressVerified: false, initialVisibility: "RENDERED_CONTROLLER_OBSERVATION",
    warmVisibility: "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED" });
}
