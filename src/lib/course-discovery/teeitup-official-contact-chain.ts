import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { getNativeOfficialIdentityPageDiagnostic, isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { completeUSAddress, fullCourseName, type OfficialIdentityPage, type OfficialIdentitySource } from "./teeitup-official-identity";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attribute = (node: Element, key: string) => node.attrs.find(value => value.name === key)?.value;
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form"].includes(node.tagName) ||
  attribute(node, "hidden") !== undefined || attribute(node, "inert") !== undefined || attribute(node, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?/iu.test(attribute(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|hide)(?:\s|$)/iu.test(attribute(node, "class") ?? "");
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function nodes(root: Node) {
  const found: Element[] = [];
  function walk(node: Node) {
    if (element(node) && excluded(node)) return;
    if (element(node)) found.push(node);
    if (found.length > 20_000) throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
    if ("childNodes" in node) node.childNodes.forEach(walk);
  }
  walk(root); return found;
}
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const safeUrl = z.string().url().max(2048).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash; } catch { return false; } });
export const teeItUpOfficialContactChainProofSchema = z.object({
  kind: z.literal("TEEITUP_OFFICIAL_CONTACT_CHAIN"), officialUrl: safeUrl, contactUrl: safeUrl, bookingUrl: safeUrl,
  venueName: z.string().min(3).max(200), canonicalAddress: z.string().min(10).max(500), timeZone: z.string().min(3).max(100),
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u), facilityId: z.number().int().min(1).max(2_147_483_647),
  courseId: z.string().min(1).max(128), providerAddress: z.string().min(3).max(1024), providerAddressVerified: z.literal(false),
  rootWitnessSha256: hex, contactWitnessSha256: hex, directoryWitnessSha256: hex,
}).strict();
export type TeeItUpOfficialContactChainProof = z.infer<typeof teeItUpOfficialContactChainProofSchema>;
function directoryIdentity(row: Record<string, unknown>) {
  return { id: row.id, courseId: row.courseId, name: fullCourseName(String(row.name)), address: clean(String(row.address)),
    timeZone: row.timeZone, country: row.country, isSimulator: row.isSimulator };
}
export function matchesTeeItUpContactDirectory(proof: TeeItUpOfficialContactChainProof, source: OfficialIdentitySource, value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || source.officialUrl !== proof.officialUrl ||
      source.bookingUrl !== proof.bookingUrl || source.venueName !== proof.venueName || source.venueAddress !== proof.canonicalAddress ||
      source.timeZone !== proof.timeZone) return false;
  const rows = value.filter(row => row && typeof row === "object" && !Array.isArray(row) && row.id === proof.facilityId &&
    row.courseId === proof.courseId && row.address === proof.providerAddress && row.timeZone === proof.timeZone &&
    row.country === "US" && row.isSimulator === false && fullCourseName(row.name) === fullCourseName(proof.venueName));
  if (rows.length !== 1 || witness(directoryIdentity(rows[0])) !== proof.directoryWitnessSha256) return false;
  return value.filter(row => row && typeof row === "object" && !Array.isArray(row) &&
    row.timeZone === proof.timeZone && row.country === "US" && row.isSimulator === false &&
    fullCourseName(row.name) === fullCourseName(proof.venueName)).length === 1 &&
    !value.some(row => row && typeof row === "object" && !Array.isArray(row) && row !== rows[0] &&
      (row.id === proof.facilityId || row.courseId === proof.courseId));
}
export type TeeItUpContactChainReader = (source: OfficialIdentitySource, deadlineAt: Date) => Promise<{ root: OfficialIdentityPage; contact: OfficialIdentityPage }>;
type ContactReaderDependencies = { requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
/** Resolve the same Node/tsx CJS namespace shape as the delegated native reader. */
export async function loadNativeOfficialContactReader() {
  const loaded = await import("./native-official-page-reader");
  const native = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded :
    (loaded as unknown as { default?: typeof loaded }).default;
  if (typeof native?.readNativeOfficialIdentityPage !== "function") throw new Error("OFFICIAL_CONTACT_READER_UNAVAILABLE");
  return native.readNativeOfficialIdentityPage;
}
function legacyBooking(value: string) {
  try {
    const url = new URL(value), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.book\.teeitup\.(?:com|golf)$/u.exec(url.hostname);
    const ids = url.searchParams.get("course");
    if (!match || url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.pathname !== "/" ||
        [...url.searchParams.keys()].some(key => !["course", "date"].includes(key)) ||
        url.searchParams.getAll("course").length > 1 || url.searchParams.getAll("date").length > 1 ||
        ids !== null && !/^[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,19}$/u.test(ids)) return null;
    return { alias: match[1], selectedIds: ids?.split(",").map(Number) };
  } catch { return null; }
}
/** The second URL comes solely from a freshly captured public root anchor. */
export async function readNativeTeeItUpContactChain(source: OfficialIdentitySource, deadlineAt: Date,
  deps: ContactReaderDependencies = {}) {
  if (!source.officialUrl || !legacyBooking(source.bookingUrl)) throw new Error("OFFICIAL_CONTACT_SOURCE_UNVERIFIED");
  const readNativeOfficialIdentityPage = await loadNativeOfficialContactReader();
  const requestLease = deps.requestLease ? async <T>(family: string, work: () => Promise<T>) => {
    const reply = await deps.requestLease!(family, work);
    return reply.acquired ? { acquired: true as const, value: await reply.value } : { acquired: false as const };
  } : undefined;
  let root: OfficialIdentityPage;
  try { root = await readNativeOfficialIdentityPage(source, source.officialUrl, deadlineAt, { requestLease, allowTeeItUpContactChainRoot: true }); }
  catch { throw new Error("OFFICIAL_CONTACT_ROOT_READ_UNVERIFIED"); }
  let url: string;
  try { url = observedTeeItUpContactUrl(source, root); }
  catch { throw new Error("OFFICIAL_CONTACT_ROOT_LINK_UNVERIFIED"); }
  let contact: OfficialIdentityPage;
  try { contact = await readNativeOfficialIdentityPage(source, url, deadlineAt, { requestLease, officialContactParent: root }); }
  catch { throw new Error("OFFICIAL_CONTACT_PAGE_READ_UNVERIFIED"); }
  if (!isFreshNativeOfficialIdentityPage(root, source.officialUrl) || !isFreshNativeOfficialIdentityPage(contact, source.officialUrl))
    throw new Error("OFFICIAL_CONTACT_DOCUMENT_UNVERIFIED");
  return { root, contact };
}

function exactVisibleLinks(page: OfficialIdentityPage, predicate: (label: string) => boolean) {
  const visible = page.visibleEvidence?.officialContactLinkLabels;
  if (!visible || page.visibleEvidence?.officialContactLinkLabelsOmitted || visible.length > 120) throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  const rendered = visible.filter(link => predicate(clean(link.text))).map(link => {
    try { return { href: new URL(link.href, page.url).href, text: clean(link.text) }; }
    catch { throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED"); }
  });
  const raw = nodes(parse(page.html)).filter(node => node.tagName === "a" && predicate(clean(text(node)))).map(node => {
    try { return { href: new URL(attribute(node, "href") ?? "", page.url).href, text: clean(text(node)) }; } catch { return null; }
  }).filter((value): value is { href: string; text: string } => value !== null);
  // Raw markup cannot determine computed CSS visibility. It must corroborate
  // every current rendered pair; other raw anchors grant no authority.
  if (rendered.some(link => !raw.some(candidate => candidate.href === link.href && candidate.text === link.text)))
    throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  return rendered;
}
function sole<T>(values: T[]) { const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : null; }
function witness(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function linkWitness(links: Array<{ href: string; text: string }>) {
  return [...new Set(links.map(link => `${link.href}\u0000${link.text}`))].sort();
}
function observedAddress(value: string) {
  const raw = clean(value);
  const direct = completeUSAddress(raw);
  if (direct) return direct;
  // Preserve every public address token; only an omitted punctuation mark
  // between a printed locality and printed two-letter state may be inserted.
  const match = /^(\d{1,7}[A-Za-z]?\s+[^,]{2,135}), ([A-Za-z .'-]{2,80}) ([A-Z]{2} \d{5}(?:-\d{4})?)$/u.exec(raw);
  return match ? completeUSAddress(`${match[1]}, ${match[2]}, ${match[3]}`) : null;
}
function sameLegacyBooking(left: string, right: string) {
  const a = legacyBooking(left), b = legacyBooking(right);
  if (!a || !b || a.alias !== b.alias || JSON.stringify(a.selectedIds ?? []) !== JSON.stringify(b.selectedIds ?? [])) return false;
  const x = new URL(left), y = new URL(right);
  return x.pathname === y.pathname && x.search === y.search &&
    x.hostname.replace(/\.book\.teeitup\.golf$/u, ".book.teeitup.com") ===
      y.hostname.replace(/\.book\.teeitup\.golf$/u, ".book.teeitup.com");
}
export function observedTeeItUpContactUrl(source: Pick<OfficialIdentitySource, "officialUrl">, root: OfficialIdentityPage) {
  if (!source.officialUrl || root.html.length > 2_000_000 || !isFreshNativeOfficialIdentityPage(root, source.officialUrl)) throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  const official = new URL(source.officialUrl), current = new URL(root.url);
  if (current.href !== official.href || current.protocol !== "https:" || official.pathname !== "/" || official.search || official.hash)
    throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  const links = exactVisibleLinks(root, label => /^contact(?:\s+us)?$/iu.test(label));
  const contact = sole(links.map(link => link.href));
  if (!contact || new URL(contact).origin !== official.origin || contact === root.url) throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  return contact;
}
/** A fresh native root authorizes exactly its corroborated public Contact link.
 * The returned URL never comes from a model, recipe or same-origin guess. */
export function verifiedTeeItUpContactParent(root: OfficialIdentityPage, officialUrl: string, targetUrl: string) {
  if (!isFreshNativeOfficialIdentityPage(root, officialUrl)) return false;
  const cleanup = getNativeOfficialIdentityPageDiagnostic(root, officialUrl);
  if (!cleanup.cleanupSettled || !cleanup.cleanupSucceeded || !cleanup.freshAfterCleanup) return false;
  try {
    const official = new URL(officialUrl), target = new URL(targetUrl);
    return official.protocol === "https:" && target.protocol === "https:" && target.origin === official.origin &&
      observedTeeItUpContactUrl({ officialUrl }, root) === targetUrl;
  } catch { return false; }
}
export function bindTeeItUpOfficialContactChain(source: OfficialIdentitySource, root: OfficialIdentityPage, contact: OfficialIdentityPage, directory: unknown) {
  const fail = (): never => { throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED"); };
  if (!source.officialUrl || !source.venueAddress || !legacyBooking(source.bookingUrl) || !Array.isArray(directory) || directory.length < 1 || directory.length > 100 ||
      !isFreshNativeOfficialIdentityPage(root, source.officialUrl) || !isFreshNativeOfficialIdentityPage(contact, source.officialUrl) ||
      root.html.length > 2_000_000 || contact.html.length > 2_000_000) return fail();
  const canonical = completeUSAddress(source.venueAddress);
  if (!canonical || !fullCourseName(source.venueName) || !contact.visibleEvidence || contact.visibleEvidence.officialContactLinkLabelsOmitted) return fail();
  const contactUrl = observedTeeItUpContactUrl(source, root);
  if (contact.url !== contactUrl) return fail();
  const names = contact.visibleEvidence.officialContactBusinessNames?.map(fullCourseName) ?? [];
  if (!names.includes(fullCourseName(source.venueName)) || names.some(value => value !== fullCourseName(source.venueName))) return fail();
  const rawNodes = nodes(parse(contact.html));
  if (!rawNodes.some(node => ["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "strong", "address"].includes(node.tagName) &&
      fullCourseName(text(node)) === fullCourseName(source.venueName))) return fail();
  const rawAddresses = rawNodes.filter(node => ["address", "p", "div", "li", "td", "span"].includes(node.tagName))
    .map(node => observedAddress(text(node))).filter((value): value is NonNullable<typeof value> => value !== null);
  const renderedAddresses = contact.visibleEvidence.addressTexts.map(observedAddress).filter((value): value is NonNullable<typeof value> => value !== null);
  if (!rawAddresses.some(value => JSON.stringify(value) === JSON.stringify(canonical)) ||
      !renderedAddresses.some(value => JSON.stringify(value) === JSON.stringify(canonical)) ||
      rawAddresses.some(value => JSON.stringify(value) !== JSON.stringify(canonical)) ||
      renderedAddresses.some(value => JSON.stringify(value) !== JSON.stringify(canonical))) return fail();
  const bookingLinks = exactVisibleLinks(contact, label => /\b(?:tee\s*times?|book|reservations?)\b/iu.test(label));
  if (!bookingLinks.some(link => link.href === source.bookingUrl) ||
      bookingLinks.some(link => legacyBooking(link.href) && !sameLegacyBooking(link.href, source.bookingUrl))) return fail();
  const parsed = legacyBooking(source.bookingUrl)!;
  const candidates = directory.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Number.isInteger((value as Record<string, unknown>).id) && typeof (value as Record<string, unknown>).courseId === "string" &&
    typeof (value as Record<string, unknown>).name === "string" && typeof (value as Record<string, unknown>).address === "string" &&
    (value as Record<string, unknown>).timeZone === source.timeZone && (value as Record<string, unknown>).isSimulator === false &&
    (value as Record<string, unknown>).country === "US" && fullCourseName((value as Record<string, unknown>).name as string) === fullCourseName(source.venueName));
  if (candidates.length !== 1) return fail();
  const row = candidates[0], id = row.id as number;
  if (parsed.selectedIds && (parsed.selectedIds.length !== 1 || parsed.selectedIds[0] !== id)) return fail();
  const providerComplete = completeUSAddress(row.address as string);
  if (providerComplete && JSON.stringify(providerComplete) !== JSON.stringify(canonical)) return fail();
  if (directory.some(value => value && typeof value === "object" && !Array.isArray(value) && value !== row &&
      ((value as Record<string, unknown>).id === id || (value as Record<string, unknown>).courseId === row.courseId))) return fail();
  return teeItUpOfficialContactChainProofSchema.parse({ kind: "TEEITUP_OFFICIAL_CONTACT_CHAIN", officialUrl: source.officialUrl,
    contactUrl, bookingUrl: source.bookingUrl, venueName: source.venueName, canonicalAddress: source.venueAddress, timeZone: source.timeZone,
    alias: parsed.alias, facilityId: id, courseId: row.courseId, providerAddress: row.address, providerAddressVerified: false,
    rootWitnessSha256: witness([root.url, contactUrl, linkWitness(exactVisibleLinks(root, label => /^contact(?:\s+us)?$/iu.test(label)))]),
    contactWitnessSha256: witness([contact.url, fullCourseName(source.venueName), canonical, linkWitness(bookingLinks)]),
    directoryWitnessSha256: witness(directoryIdentity(row)) });
}
