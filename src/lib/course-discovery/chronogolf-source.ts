import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName, type OfficialIdentityPage } from "./teeitup-official-identity";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import { delegatedCanonicalVenueWitness, delegatedBookingHop } from "./teeitup-delegated-booking-source";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import { discoveryTrustedContextSchema, type DiscoveryTrustedContext } from "./trusted-context";

const id = z.number().int().min(1).max(2_147_483_647);
const uuid = z.string().uuid();
const holes = z.union([z.literal(9), z.literal(18)]);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const holeOptions = z.array(holes).min(1).max(2).refine(unique);
const timeZone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } });
function fail(code = "ADAPTER_CONFIGURATION_UNVERIFIED"): never { throw new Error(code); }
// Only an actual otherwise-matching public profile may request a fresh official-root read.
const officialHostMismatches = new WeakSet<Error>();
export function chronogolfOfficialHostMismatch(error: unknown): boolean {
  return error instanceof Error && officialHostMismatches.has(error);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const name = z.string().trim().min(3).max(200);
/** The observed TeeTimeView passes every published round option, and the
 * serializer joins both course UUIDs and holes as CSV on the public read. */
export const CHRONOGOLF_READ_CLIENTS = Object.freeze([
  { url: "https://www.chronogolf.com/_next/static/chunks/1710-f188e4d712d51c74.js", sha256: "3d7f020bc8c0a795d8132b1951cc2be2c50ada2983458c9aa98df02e5631b340" },
  { url: "https://www.chronogolf.com/_next/static/chunks/1805-4ebe7f1b7a704cab.js", sha256: "78bb211875897af6f24bbec9f39600786543482678d32d7dedc0335ccacaae78" },
] as const);
const clientSchema = z.tuple([
  z.object({ url: z.literal(CHRONOGOLF_READ_CLIENTS[0].url), sha256: z.literal(CHRONOGOLF_READ_CLIENTS[0].sha256) }).strict(),
  z.object({ url: z.literal(CHRONOGOLF_READ_CLIENTS[1].url), sha256: z.literal(CHRONOGOLF_READ_CLIENTS[1].sha256) }).strict(),
]);

/** Only public club profiles, never widgets, marketplace APIs, member routes or
 * a URL already carrying customer/selected-time state. */
export function normalizeChronogolfProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["chronogolf.com", "www.chronogolf.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash ||
        !/^\/club\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|[1-9]\d{0,9})\/?$/u.test(url.pathname)) return null;
    url.hostname = "www.chronogolf.com"; url.pathname = url.pathname.replace(/\/$/u, "");
    return url.href;
  } catch { return null; }
}
/** An observed public embed is a source identity, never a fetch target. The
 * only accepted parameters are the published, non-customer widget markers. */
export function parseChronogolfPublicWidget(value: string): { widgetUrl: string; profileUrl: string; numericClubId: number } | null {
  try {
    const url = new URL(value);
    const match = /^\/club\/([1-9]\d{0,9})\/widget$/u.exec(url.pathname);
    if (url.href !== value || url.protocol !== "https:" || url.hostname !== "www.chronogolf.com" || url.username || url.password || url.port || url.hash ||
        !match || url.search !== "?target=_blank&source=chronogolf&medium=profile") return null;
    const numericClubId = Number(match[1]);
    if (!id.safeParse(numericClubId).success) return null;
    return { widgetUrl: value, profileUrl: `https://www.chronogolf.com/club/${numericClubId}`, numericClubId };
  } catch { return null; }
}
export function parseChronogolfSource(value: string): { profileUrl: string; slug: string; numericClubId?: number; widgetUrl?: string } | null {
  const widget = parseChronogolfPublicWidget(value);
  if (widget) return { profileUrl: widget.profileUrl, slug: String(widget.numericClubId), numericClubId: widget.numericClubId, widgetUrl: widget.widgetUrl };
  const profileUrl = normalizeChronogolfProfileUrl(value);
  if (!profileUrl) return null;
  const slug = new URL(profileUrl).pathname.slice("/club/".length);
  return { profileUrl, slug, ...(/^[1-9]\d{0,9}$/u.test(slug) ? { numericClubId: Number(slug) } : {}) };
}

const metadataCourseSchema = z.object({ id, uuid, name, layoutHoles: holes, bookableHoles: holeOptions }).strict();
export const chronogolfMetadataSchema = z.object({ family: z.literal("CHRONOGOLF"), clubId: id,
  profileUrl: z.string().refine(value => normalizeChronogolfProfileUrl(value) === value), timeZone, publicPlayerTypeId: id,
  widgetSourceUrl: z.string().refine(value => parseChronogolfPublicWidget(value) !== null).optional(),
  courses: z.array(metadataCourseSchema).min(1).max(20).refine(values => unique(values.map(value => value.id)) && unique(values.map(value => value.uuid))),
  clients: clientSchema, catalogHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().refine(value => {
    const widget = value.widgetSourceUrl ? parseChronogolfPublicWidget(value.widgetSourceUrl) : null;
    return !value.widgetSourceUrl || Boolean(widget && widget.numericClubId === value.clubId);
  });
export type ChronogolfMetadata = z.infer<typeof chronogolfMetadataSchema>;
export type ChronogolfIdentitySource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };

/** The fresh profile proves numeric-ID/slug equivalence. Only that saved typed
 * mapping may produce a canonical dated link from an observed numeric source. */
export function chronogolfRecipeBookingUrl(sourceBookingUrl: string, metadata: ChronogolfMetadata, requestedDate: string): string {
  const saved = chronogolfMetadataSchema.safeParse(metadata), source = parseChronogolfSource(sourceBookingUrl);
  if (!saved.success || !source || !dateOnlySchema.safeParse(requestedDate).success) fail("ADAPTER_SLOT_LINK_UNVERIFIED");
  const canonical = parseChronogolfSource(saved.data.profileUrl);
  if (!canonical || canonical.profileUrl !== saved.data.profileUrl ||
      (source.widgetUrl ?? undefined) !== saved.data.widgetSourceUrl ||
      canonical.numericClubId !== undefined && canonical.numericClubId !== saved.data.clubId ||
      (source.numericClubId !== undefined ? source.numericClubId !== saved.data.clubId : source.profileUrl !== canonical.profileUrl)) fail("ADAPTER_SLOT_LINK_UNVERIFIED");
  const url = new URL(canonical.profileUrl);
  url.searchParams.set("date", requestedDate); url.searchParams.set("step", "teetimes");
  return url.href;
}

/** Narrow exception for the existing adapter's verified canonical booking link.
 * This grants no URL authority to generic recipes or malformed persisted JSON. */
export function isChronogolfRecipeSlotLink(sourceBookingUrl: string, metadata: unknown, requestedDate: string,
  slot: { sourceId: string; resourceId?: string; bookingUrl: string; holes?: number }): boolean {
  try {
    const saved = chronogolfMetadataSchema.safeParse(metadata);
    if (!saved.success || !slot || typeof slot.sourceId !== "string" || typeof slot.resourceId !== "string" || typeof slot.bookingUrl !== "string") return false;
    const legacy = /^chronogolf-(.+)$/u.exec(slot.sourceId);
    if (!legacy || !uuid.safeParse(legacy[1]).success) return false;
    const resource = saved.data.courses.find(course => slot.resourceId === `chronogolf-course:${course.uuid}`);
    return !!resource && slot.holes === undefined &&
      slot.bookingUrl === chronogolfRecipeBookingUrl(sourceBookingUrl, saved.data, requestedDate);
  } catch { return false; }
}

const stateNames: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};
const profileCourseSchema = z.object({ id, uuid, name, holes, bookableHoles: holeOptions });
const profileClubSchema = z.object({ id, uuid, name, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), active: z.literal(true), state: z.literal("published"),
  website: z.string().url().max(2048), address: z.string().min(5).max(200), city: z.string().min(2).max(100),
  province: z.string().min(2).max(100), postcode: z.string().regex(/^(?:[0-9]{4}|[0-9]{5}(?:-[0-9]{4})?)$/u), country: z.string().min(2).max(100), timezone: timeZone,
  phone: z.unknown().optional(),
  defaultAffiliationTypeId: id, features: z.object({ onlineBookingEnabled: z.literal(true) }), courses: z.array(profileCourseSchema).min(1).max(20) });
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (value: Node): value is Element => "tagName" in value;
const attr = (value: Element, key: string) => value.attrs.find(entry => entry.name === key)?.value;
function nextData(html: string): { data: unknown; clients: ChronogolfMetadata["clients"] } {
  if (Buffer.byteLength(html) > 2_000_000) fail("ADAPTER_RESPONSE_LIMIT");
  const scripts: Element[] = [], assets: Element[] = []; let count = 0;
  const walk = (node: Node, depth: number) => {
    if (++count > 20_000 || depth > 80) fail("ADAPTER_DOCUMENT_LIMIT");
    if (element(node) && attr(node, "id") === "__NEXT_DATA__") scripts.push(node);
    if (element(node) && node.tagName === "script" && attr(node, "src")) assets.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) walk(child, depth + 1);
  };
  walk(parse(html), 0);
  if (scripts.length !== 1 || scripts[0].tagName !== "script" || attr(scripts[0], "src") || attr(scripts[0], "type") !== "application/json") fail("ADAPTER_PROFILE_SCHEMA_CHANGED");
  const body = scripts[0].childNodes.map(child => child.nodeName === "#text" ? (child as DefaultTreeAdapterMap["textNode"]).value : "").join("");
  const clients = CHRONOGOLF_READ_CLIENTS.map(client => {
    const matches = assets.filter(node => { try { return new URL(attr(node, "src")!, "https://www.chronogolf.com").href === client.url; } catch { return false; } });
    if (matches.length !== 1) fail("ADAPTER_CLIENT_UNSUPPORTED");
    return { ...client };
  });
  try { return { data: JSON.parse(body), clients: clientSchema.parse(clients) }; } catch { return fail("ADAPTER_PROFILE_SCHEMA_CHANGED"); }
}
function officialHost(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash && !url.search &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(url.hostname) && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(url.hostname) ? url.hostname.replace(/^www\./u, "") : null; } catch { return null; }
}
/** Provider profile website text is identity evidence, never a fetch target.
 * A legacy HTTP spelling may name the exact canonical HTTPS host; this does
 * not change the canonical source requirement or any reader URL authority. */
function providerWebsiteIdentityHost(value: string) {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || /[:@]/u.test(authority)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.protocol = "https:";
    return officialHost(url.href);
  } catch { return null; }
}
function physicalAddress(value: string) {
  const parsed = completeUSAddress(value);
  if (!parsed) return null;
  const street = parsed.street.replace(/\b(?:north|south|east|west|northeast|northwest|southeast|southwest)\b/gu,
    word => ({ north:"n",south:"s",east:"e",west:"w",northeast:"ne",northwest:"nw",southeast:"se",southwest:"sw" })[word]!);
  return { ...parsed, street };
}
/** A heading-free canonical site can print its full business identity in one
 * semantic footer address. This is not title text or a provider-host alias. */
function headlessCanonicalFooter(source: ChronogolfIdentitySource, page: OfficialIdentityPage): boolean {
  const visible = page.visibleEvidence, expected = fullCourseName(source.venueName), canonical = physicalAddress(source.venueAddress ?? "");
  const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const literal = (value: string) => clean(value).replace(/\s*,\s*/gu, ", ").toLowerCase();
  if (!canonical || !visible || visible.headings.length || !visible.publicBusinessLabels?.length || visible.publicBusinessLabels.length > 20 ||
      visible.publicBusinessLabels.some(value => typeof value !== "string" || value.length > 200 || fullCourseName(value) !== expected) ||
      visible.addressTexts.length > 160 || page.html.length > 600000) return false;
  const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button", "label"].includes(node.tagName) ||
    node.attrs.some(value => ["hidden", "inert", "contenteditable"].includes(value.name)) || attr(node, "aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/u.test(attr(node, "class") ?? "") ||
    /\b(?:account|members?|profile|customer|checkout|payment|billing|mailing|corporate|headquarters|fax|login|sign-in)\b/iu.test(["id", "class", "title", "aria-label"].map(key => attr(node, key) ?? "").join(" "));
  const addresses: Element[] = []; let count = 0, heading = false;
  const walk = (node: Node, depth: number, inFooter: boolean) => {
    if (++count > 20000 || depth > 64) fail("ADAPTER_IDENTITY_MISMATCH");
    if (element(node)) {
      if (excluded(node)) return;
      if (/^h[1-6]$/u.test(node.tagName)) heading = true;
      inFooter ||= node.tagName === "footer";
      if (inFooter && node.tagName === "address") addresses.push(node);
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child, depth + 1, inFooter);
  };
  walk(parse(page.html), 0, false);
  if (heading || addresses.length !== 1) return false;
  const address = addresses[0], fields = address.childNodes.filter(element);
  if (fields.length !== 2 || fields.some(node => node.tagName !== "span" || excluded(node) || node.childNodes.some(child => child.nodeName !== "#text")) ||
      address.childNodes.some(node => node.nodeName === "#text" && clean((node as DefaultTreeAdapterMap["textNode"]).value))) return false;
  const text = (node: Element) => clean(node.childNodes.map(child => (child as DefaultTreeAdapterMap["textNode"]).value).join(" "));
  const name = text(fields[0]), printed = text(fields[1]);
  if (name.length > 200 || printed.length > 500 || fullCourseName(name) !== expected || JSON.stringify(physicalAddress(printed)) !== JSON.stringify(canonical)) return false;
  const postal = (value: string) => /,\s*[A-Z]{2}\s+(\d{5}(?:-\d{4})?)(?:,\s*(?:US|USA|United States(?: of America)?))?$/iu.exec(clean(value))?.[1];
  if (!postal(printed) || postal(printed) !== postal(source.venueAddress ?? "")) return false;
  return visible.addressTexts.some(value => typeof value === "string" && literal(value) === literal(name + ", " + printed));
}
/** Fresh complete public profile identity and catalog, not an availability or
 * all-rounds claim. Sales round lengths remain separate from physical layout. */
export function parseChronogolfProfile(html: string, actualUrl: string, source: ChronogolfIdentitySource,
  officialPage?: OfficialIdentityPage, trustedContext?: DiscoveryTrustedContext): ChronogolfMetadata {
  const requested = parseChronogolfSource(source.bookingUrl), actual = parseChronogolfSource(actualUrl);
  if (!requested || !actual || actual.widgetUrl || !source.venueAddress || !officialHost(source.officialUrl)) fail("ADAPTER_IDENTITY_MISSING");
  const document = nextData(html), data = document.data;
  if (!object(data) || !object(data.props) || !object(data.props.pageProps)) fail("ADAPTER_PROFILE_SCHEMA_CHANGED");
  const parsed = profileClubSchema.safeParse(data.props.pageProps.club);
  if (!parsed.success) fail("ADAPTER_PROFILE_SCHEMA_CHANGED");
  const club = parsed.data, expectedName = fullCourseName(source.venueName), canonical = physicalAddress(source.venueAddress),
    websiteHost = providerWebsiteIdentityHost(club.website);
  const trusted = discoveryTrustedContextSchema.safeParse(trustedContext), canonicalPhone = trusted.success ? trusted.data.canonicalCoursePhone : undefined;
  // A public profile may append this business suffix to a canonical brand.
  // Only one exact course, the same official host, complete physical identity
  // and the private canonical phone can corroborate that narrow spelling.
  const publicBrandSuffix = fullCourseName(club.name) === `${expectedName} golf links` &&
    !/\b(?:golf|links|club|course|country)$/u.test(expectedName) &&
    expectedName.split(" ").filter(word => !["the", "golf", "links", "club", "course", "country"].includes(word)).join(" ").length >= 8 &&
    club.courses.length === 1 && fullCourseName(club.courses[0].name) === fullCourseName(club.name) &&
    websiteHost === officialHost(source.officialUrl) && canonicalPhone !== undefined && normalizePublicCoursePhone(club.phone) === canonicalPhone;
  if (!canonical || expectedName.length < 8 || (fullCourseName(club.name) !== expectedName && !publicBrandSuffix) || club.timezone !== source.timeZone ||
      !websiteHost) fail("ADAPTER_IDENTITY_MISMATCH");
  const province = Object.entries(stateNames).find(([code, region]) => [code.toLowerCase(), region.toLowerCase()].includes(club.province.toLowerCase()))?.[0];
  if (!province || !/^(?:United States(?: of America)?|USA?|US)$/iu.test(club.country)) fail("ADAPTER_IDENTITY_MISMATCH");
  // The public serializer can omit one leading zero. Recover it only from the
  // exact canonical five-digit US ZIP; never fill another missing component.
  const canonicalFiveDigitZip = /,\s*[A-Z]{2}\s+([0-9]{5})(?:,\s*(?:US|USA|United States(?: of America)?))?$/iu.exec(source.venueAddress)?.[1];
  const postcode = /^[0-9]{4}$/u.test(club.postcode) && canonicalFiveDigitZip === `0${club.postcode}` ? canonicalFiveDigitZip : club.postcode;
  const observed = physicalAddress(`${club.address}, ${club.city}, ${province} ${postcode}`);
  // These two complete street spellings denote the same English word. Accept
  // only that exact substitution, with every other physical field unchanged,
  // the same official host, and the independently supplied canonical phone.
  const streetSpelling = observed && JSON.stringify(observed) !== JSON.stringify(canonical) &&
    JSON.stringify({ ...observed, street: observed.street.replace(/\btheatre\b/gu, "theater") }) ===
    JSON.stringify({ ...canonical, street: canonical.street.replace(/\btheatre\b/gu, "theater") }) &&
    websiteHost === officialHost(source.officialUrl) && canonicalPhone !== undefined && normalizePublicCoursePhone(club.phone) === canonicalPhone;
  if (!observed || JSON.stringify(observed) !== JSON.stringify(canonical) && !streetSpelling) fail("ADAPTER_IDENTITY_MISMATCH");
  const canonicalUrl = `https://www.chronogolf.com/club/${club.slug}`;
  for (const url of [requested, actual]) if (url.numericClubId !== undefined ? url.numericClubId !== club.id : url.profileUrl !== canonicalUrl) fail("ADAPTER_IDENTITY_MISMATCH");
  const courses = club.courses.map(course => ({ id: course.id, uuid: course.uuid, name: course.name, layoutHoles: course.holes,
    bookableHoles: [...course.bookableHoles].sort((a, b) => a - b) })).sort((a, b) => a.id - b.id);
  if (!unique(courses.map(course => course.id)) || !unique(courses.map(course => course.uuid))) fail("ADAPTER_CATALOG_AMBIGUOUS");
  if (websiteHost !== officialHost(source.officialUrl)) {
    if (!officialPage) {
      const error = new Error("ADAPTER_IDENTITY_MISMATCH");
      officialHostMismatches.add(error); throw error;
    }
    try {
      if (!freshNativeCanonicalRootDocument(officialPage, source.officialUrl)) fail("ADAPTER_IDENTITY_MISMATCH");
      // Reuse full raw/rendered canonical venue identity; the provider's stale
      // website text never becomes a fetch target or a domain-equivalence rule.
      try { delegatedCanonicalVenueWitness(source, officialPage); }
      catch (error) { if (!headlessCanonicalFooter(source, officialPage)) throw error; }
      const links = officialPage.visibleEvidence?.linkUrls;
      if (!links || links.length > 512) fail("ADAPTER_IDENTITY_MISMATCH");
      const profiles = [...new Set(links)].flatMap(url => {
        const parsed = parseChronogolfSource(url); return parsed ? [{ url, parsed }] : [];
      });
      if (profiles.length !== 1 || (profiles[0].parsed.numericClubId !== undefined ?
        profiles[0].parsed.numericClubId !== club.id : profiles[0].parsed.profileUrl !== canonicalUrl)) fail("ADAPTER_IDENTITY_MISMATCH");
      delegatedBookingHop(officialPage, profiles[0].url);
      if (!freshNativeCanonicalRootDocument(officialPage, source.officialUrl)) fail("ADAPTER_IDENTITY_MISMATCH");
    } catch { fail("ADAPTER_IDENTITY_MISMATCH"); }
  }
  const catalog = { clubId: club.id, clubUuid: club.uuid, profileUrl: canonicalUrl, ...(requested.widgetUrl ? { widgetSourceUrl: requested.widgetUrl } : {}), name: club.name, websiteHost: providerWebsiteIdentityHost(club.website),
    address: observed, timeZone: club.timezone, publicPlayerTypeId: club.defaultAffiliationTypeId, courses, clients: document.clients,
    ...(streetSpelling ? { canonicalStreetSpellingScope: "THEATRE_THEATER_WITH_CANONICAL_PHONE_V1",
      canonicalPhoneSha256: createHash("sha256").update(JSON.stringify(canonicalPhone)).digest("hex") } : {}),
    ...(publicBrandSuffix ? { canonicalBrandScope: "EXACT_PUBLIC_GOLF_LINKS_SUFFIX_V1", canonicalName: expectedName,
      canonicalPhoneSha256: createHash("sha256").update(JSON.stringify(canonicalPhone)).digest("hex") } : {}) };
  return chronogolfMetadataSchema.parse({ family: "CHRONOGOLF", clubId: club.id, profileUrl: canonicalUrl, timeZone: club.timezone,
    ...(requested.widgetUrl ? { widgetSourceUrl: requested.widgetUrl } : {}),
    publicPlayerTypeId: club.defaultAffiliationTypeId, courses, clients: document.clients, catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex") });
}
export function verifyChronogolfReadClients(metadata: ChronogolfMetadata, bodies: Record<string, string>): void {
  const clients = clientSchema.parse(metadata.clients);
  if (Object.keys(bodies).length !== clients.length) fail("ADAPTER_CLIENT_UNSUPPORTED");
  for (const client of clients) {
    const body = bodies[client.url];
    if (typeof body !== "string" || Buffer.byteLength(body) > 2_000_000 || createHash("sha256").update(body).digest("hex") !== client.sha256) fail("ADAPTER_CLIENT_UNSUPPORTED");
  }
}

const price = z.number().finite().min(0).max(1_000_000);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => { const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; });
export const chronogolfAvailabilityPageSchema = z.object({ status: z.enum(["open", "sold_out"]), teetimes: z.array(z.object({ id, uuid,
  course: z.object({ id, uuid, name, holes, bookable_holes: holeOptions }).strict(), hole: z.number().int().min(1).max(18), has_cart: z.boolean(),
  min_player_size: z.number().int().min(1).max(20), max_player_size: z.number().int().min(1).max(20), starts_at: z.string().datetime({ offset: true }),
  start_time: z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/u).transform(value => value.padStart(5, "0")), date: dateOnlySchema, event_id: z.null(), has_deal: z.boolean(),
  default_price: z.object({ green_fee: price, half_cart: price.nullable(), one_person_cart: price.nullable(), player_type_id: id,
    subtotal: price, bookable_holes: holes, affiliation_type: z.string().min(1).max(100) }).strict(), departure: z.null(), format: z.literal("normal"), frozen: z.boolean(),
}).strict().refine(value => value.min_player_size <= value.max_player_size)).max(500) }).strict()
  .refine(value => value.status !== "sold_out" || value.teetimes.length === 0);
export type ChronogolfAvailabilityPage = z.infer<typeof chronogolfAvailabilityPageSchema>;

/** Headers are mandatory proof. Row-count fallbacks cannot distinguish a full
 * page from a complete result, including an otherwise plausible empty array. */
export function parseChronogolfPagination(headers: Headers): { total: number; perPage: number } {
  const total = headers.get("total"), perPage = headers.get("per-page");
  if (!total || !perPage || !/^(?:0|[1-9]\d{0,5})$/u.test(total) || !/^[1-9]\d{0,2}$/u.test(perPage) || Number(perPage) > 500 || Number(total) > 5000) fail("ADAPTER_PAGINATION_UNVERIFIED");
  return { total: Number(total), perPage: Number(perPage) };
}
