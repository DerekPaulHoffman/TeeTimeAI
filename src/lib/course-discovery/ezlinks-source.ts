import { createHash } from "node:crypto";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

const tenantName = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const privateTenant = /^(?:www|api|admin|auth|login|account|portal|private|member|config|dev|qa|staging|sandbox|test)/u;
const publicId = z.number().int().min(1).max(9_999_999_999);
const tenant = z.string().regex(tenantName).refine(value => !privateTenant.test(value));
const clientsSchema = z.tuple([
  z.object({ path: z.literal("/assets/index-DsLbHQvf.js"),
    sha256: z.literal("4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb") }).strict(),
  z.object({ path: z.literal("/assets/index-CvL6jQuU.js"),
    sha256: z.literal("6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f") }).strict(),
]);
const reviewedClients = () => clientsSchema.parse([
  { path: "/assets/index-DsLbHQvf.js", sha256: "4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb" },
  { path: "/assets/index-CvL6jQuU.js", sha256: "6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f" },
]);

/** Durable configuration contains public identity/catalog facts only. Fresh
 * document/init policy tokens, sessions and reservation identifiers must never
 * become serialized recipe authority. Date/window bounds remain fresh context,
 * not stable catalog identity. */
export const ezlinksMetadataSchema = z.object({
  family: z.literal("EZLINKS"), browserTransport: z.literal("NATIVE_CHROME"), tenant, sponsorId: publicId,
  courseIds: z.array(publicId).min(1).max(40).refine(values =>
    values.every((value, index) => index === 0 || values[index - 1] < value)),
  clients: clientsSchema,
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type EzLinksMetadata = z.infer<typeof ezlinksMetadataSchema>;
export type EzLinksSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };

/** Only an exact already-observed public tenant document is a recipe source.
 * API routes, credentials, aliases and inferred sibling tenants are excluded.
 * Keep this pure module independent of recipe.ts to avoid schema cycles. */
export function parseEzLinksSource(value: string): { bookingUrl: string; origin: string; tenant: string } | undefined {
  try {
    if (value.length > 2048 || !getSafeCustomerBookingUrl(value)) return;
    const url = new URL(value), match = /^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ezlinksgolf\.com$/u.exec(url.hostname);
    if (!match || !tenant.safeParse(match[1]).success || url.href !== value || url.protocol !== "https:" || url.username ||
        url.password || url.port || url.search || url.hash || !["/", "/search", "/index.html"].includes(url.pathname)) return;
    return { bookingUrl: url.href, origin: url.origin, tenant: match[1] };
  } catch { return; }
}

function fail(code: string): never { throw new Error(code); }
/** Completeness depends on these reviewed clients' unpaged search contract.
 * Only the controller can attest their actual current-document native bytes;
 * metadata pins alone never establish that fresh proof. */
export function verifyEzLinksReadContract(value: unknown): void {
  if (!z.object({ kind: z.literal("EZLINKS_UNPAGED_SEARCH_V1"), assets: clientsSchema }).strict().safeParse(value).success)
    fail("EZLINKS_READ_CONTRACT_UNVERIFIED");
}
const label = z.string().trim().min(1).max(240).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const courseSchema = z.object({ CourseID: publicId, RegionName: label, AreaName: label, CourseName: label,
  CityName: label, CityID: publicId, CountryName: label }).strict();
const localDateTime = /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/u;
const configuredClock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:00$/u);
const iconName = z.enum(["18 holes", "Include Cart", "Include Caddy", "Pre-paid", "Resident Fee", "Member Fee", "Senior Fee", "Junior Fee",
  "9 holes", "All you can play", "Practice Balls", "Beverage", "Food", "Gift", "Alert", "GPS Included", "Tax Included", "Aerification", "OverSeeding", "Course Closed", "Walking"]);
const iconSchema = z.object({ IconId: z.number().int().min(-1).max(1000).refine(value => value !== 0), IconName: iconName }).passthrough();
const initSchema = z.object({
  MasterSponsorID: z.string().regex(/^[1-9]\d{0,9}$/u), AllCourseIDs: z.string().regex(/^[1-9]\d{0,9}(?:,[1-9]\d{0,9})*$/u),
  Courses: z.array(courseSchema).min(1).max(40), SponsorPageTitle: label, SponsorSearchType: z.literal("1"),
  Icons: z.array(iconSchema).min(1).max(40),
  NumPlayersList: z.array(z.enum(["1", "2", "3", "4"])).min(1).max(4),
  HolesList: z.array(z.enum(["Any", "18", "9"])).min(1).max(3),
  StartTime: configuredClock, EndTime: configuredClock, StartTimeSet: configuredClock, EndTimeSet: configuredClock,
  SearchMinDate: z.string().regex(localDateTime), SearchMaxDate: z.string().regex(localDateTime),
  // The anonymous init publishes a site UserID, also used by the excluded move
  // reservation path. It is not the authenticated ContactID/login state and is
  // shape-checked only: never an eligibility signal, request field or recipe.
  HoldAndReturnOne: z.literal(false), RedirectTo: z.null(), UserID: z.number().int().min(0).max(9_999_999_999), ContactFirstName: z.null(),
  PreFilteredCourses: z.array(z.never()).max(0), PreFilteredStates: z.array(z.never()).max(0), PreFilteredCities: z.array(z.never()).max(0),
}).passthrough();
export type EzLinksConfiguration = {
  metadata: EzLinksMetadata; courses: z.infer<typeof courseSchema>[]; players: number[]; holesIndex: 0;
  firstDate: string; lastDate: string; startTime: string; endTime: string; icons: Array<{ id: number; name: z.infer<typeof iconName> }>;
};

/** Whole-name comparison only. A terminal Golf Course/Golf Club category can
 * accompany an already complete Golf name; no prefix or city alias is added. */
export function ezlinksVenueMatches(expected: string, observed: string): boolean {
  const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
  const a = key(expected), b = key(observed);
  if (a === b) return a.length >= 8;
  const golf = (value: string) => value.replace(/golf(?:course|club)$/u, "golf");
  const normalized = golf(a);
  return normalized === golf(b) && normalized.endsWith("golf") && normalized.slice(0, -4).length >= 8;
}
export function validateEzLinksIdentity(source: EzLinksSource) {
  if (!parseEzLinksSource(source.bookingUrl) || !getSafeCustomerBookingUrl(source.officialUrl) ||
      new URL(source.officialUrl).protocol !== "https:" || !source.venueAddress || source.venueAddress.length < 10 ||
      source.venueAddress.length > 1024 || /[\u0000-\u001f\u007f]/u.test(source.venueAddress) ||
      !label.safeParse(source.venueName).success) fail("ADAPTER_IDENTITY_MISSING");
  try { if (!source.timeZone.includes("/")) fail("ADAPTER_IDENTITY_MISSING"); new Intl.DateTimeFormat("en-US", { timeZone: source.timeZone }); }
  catch { fail("ADAPTER_IDENTITY_MISSING"); }
}
function validDay(value: string) {
  const day = value.slice(0, 10), time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

/** The official -> exact observed tenant link is controller provenance. The
 * public init independently proves its unique whole venue/catalog. Address and
 * IANA timezone remain canonical controller context: init publishes neither. */
export function parseEzLinksConfiguration(value: unknown, source: EzLinksSource): EzLinksConfiguration {
  validateEzLinksIdentity(source);
  const parsed = initSchema.safeParse(value);
  if (!parsed.success) fail("EZLINKS_CONFIGURATION_INVALID");
  const data = parsed.data, context = parseEzLinksSource(source.bookingUrl)!;
  const title = data.SponsorPageTitle.replace(/ - Daily Fee - Online tee times made EZ$/u, "");
  const ids = data.Courses.map(course => course.CourseID).sort((a, b) => a - b), declared = data.AllCourseIDs.split(",").map(Number).sort((a, b) => a - b);
  const players = data.NumPlayersList.map(Number);
  if (title === data.SponsorPageTitle || !ezlinksVenueMatches(source.venueName, title) ||
      data.Courses.some(course => !ezlinksVenueMatches(source.venueName, course.CourseName)) ||
      /(?:USA|United States(?: of America)?)$/iu.test(source.venueAddress!.trim()) && data.Courses.some(course =>
        !["United States", "United States of America", "US", "USA"].includes(course.CountryName)) ||
      new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(declared) ||
      players.some((player, index) => index > 0 && players[index - 1] >= player) || data.HolesList[0] !== "Any" ||
      new Set(data.HolesList).size !== data.HolesList.length || !validDay(data.SearchMinDate) || !validDay(data.SearchMaxDate) ||
      new Set(data.Icons.map(icon => icon.IconId)).size !== data.Icons.length ||
      data.SearchMinDate.slice(0, 10) > data.SearchMaxDate.slice(0, 10) || data.StartTime >= data.EndTime ||
      data.StartTime !== data.StartTimeSet || data.EndTime !== data.EndTimeSet) fail("EZLINKS_CONFIGURATION_UNVERIFIED");
  const courses = [...data.Courses].sort((a, b) => a.CourseID - b.CourseID);
  const icons = data.Icons.map(icon => ({ id: icon.IconId, name: icon.IconName })).sort((a, b) => a.id - b.id);
  const stable = { tenant: context.tenant, sponsorId: Number(data.MasterSponsorID), courses, players, holes: data.HolesList, icons };
  const metadata = ezlinksMetadataSchema.parse({ family: "EZLINKS", browserTransport: "NATIVE_CHROME", tenant: context.tenant,
    sponsorId: stable.sponsorId, courseIds: ids, clients: reviewedClients(), catalogHash: createHash("sha256").update(JSON.stringify(stable)).digest("hex") });
  return { metadata, courses, players, holesIndex: 0, firstDate: data.SearchMinDate.slice(0, 10), lastDate: data.SearchMaxDate.slice(0, 10),
    startTime: data.StartTime.slice(0, 5), endTime: data.EndTime.slice(0, 5), icons };
}

/** Exact reviewed client hourMinFilter, within the supported 00:00–23:59
 * configuration domain. No guessed UTC or AM/PM abbreviation conversion. */
export function ezlinksRequestClock(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) fail("EZLINKS_CLOCK_INVALID");
  const hour = Number(value.slice(0, 2));
  return `${hour > 12 ? hour - 12 : hour}:${value.slice(3)} ${hour >= 12 ? "PM" : "AM"}`;
}
export function ezlinksAvailabilityBody(configuration: EzLinksConfiguration, input: { date: string; players: number }) {
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(input.date) || !validDay(input.date) || input.date < configuration.firstDate ||
      input.date > configuration.lastDate || !configuration.players.includes(input.players)) fail("EZLINKS_REQUEST_OUTSIDE_CONFIGURATION");
  const [year, month, day] = input.date.split("-");
  return { p01: [...configuration.metadata.courseIds], p02: `${month}/${day}/${year}`,
    p03: ezlinksRequestClock(configuration.startTime), p04: ezlinksRequestClock(configuration.endTime),
    p05: configuration.holesIndex, p06: input.players, p07: false as const };
}

const integer = z.number().int().min(0).max(9_999_999_999);
const money = z.number().finite().min(-1).max(1_000_000);
const priceText = z.string().regex(/^\d{1,7}(?:\.\d{1,4})?$/u).refine(value => Number(value) <= 1_000_000);
const opaque = z.string().max(4096);
const rowSchema = z.object({ r01: opaque, r02: money, r03: integer, r04: integer, r05: integer, r06: publicId, r07: publicId,
  r08: money, r09: money, r10: integer, r11: z.number().int().min(0).max(4), r12: publicId, r13: publicId,
  r14: z.number().int().min(0).max(4), r15: z.string().regex(localDateTime), r16: label,
  r17: z.string().regex(/^20\d{2}-\d{2}-\d{2}T00:00:00$/u), r18: integer, r19: z.null(), r20: z.string().max(500),
  r21: money, r22: z.string().max(200).nullable(), r23: z.string().max(200).nullable(), r24: z.string().max(20),
  r25: priceText, r26: priceText, r27: z.string().max(500), r28: z.string().max(500), r29: z.string().max(100).nullable(),
  r30: z.string().max(30), r31: z.string().max(30), r32: money }).strict();
const pricingSchema = z.object({ r01: publicId, r02: publicId, r03: z.enum(["Daily Fee", "Senior Fee"]),
  r04: z.enum(["Pay at Course", "Pay Now"]) }).strict();
// r04 is max price, r07 is display mode, never an application success/count.
// The reviewed client receives one unpaged r06 array in this exact envelope.
const listingSchema = z.object({ r01: opaque, r02: priceText, r03: opaque, r04: priceText,
  r05: z.array(pricingSchema).min(1).max(40), r06: z.array(rowSchema).max(500), r07: z.number().int().min(0).max(10) }).strict();
export function parseEzLinksAvailability(value: unknown, configuration: EzLinksConfiguration,
  input: { date: string; players: number; startTime: string; endTime: string }, toInstant: (local: string) => Date) {
  ezlinksAvailabilityBody(configuration, input); // Even an empty result needs a valid bound request.
  const parsed = listingSchema.safeParse(value);
  if (!parsed.success) fail("EZLINKS_AVAILABILITY_INVALID");
  const data = parsed.data, rates = new Map(data.r05.map(rate => [rate.r02, rate]));
  if (Number(data.r02) > Number(data.r04) || rates.size !== data.r05.length || new Set(data.r05.map(rate => rate.r01)).size !== data.r05.length ||
      !data.r05.some(rate => rate.r02 === configuration.metadata.sponsorId && rate.r03 === "Daily Fee")) fail("EZLINKS_PUBLIC_RATE_UNVERIFIED");
  const courses = new Map(configuration.courses.map(course => [course.CourseID, course]));
  const iconMap = new Map(configuration.icons.map(icon => [icon.id, icon.name])), offers = new Set<string>();
  const physical = new Map<string, { courseId: number; local: string; capacity: number; startsAt: string; publicRate: boolean; holes?: 9 | 18 }>();
  for (const row of data.r06) {
    const course = courses.get(row.r07), rate = rates.get(row.r06), date = row.r15.slice(0, 10), time = row.r15.slice(11, 16);
    if (!course || !rate || course.CourseName !== row.r16 || date !== input.date || row.r17 !== `${input.date}T00:00:00` ||
        !validDay(row.r15) || row.r15.slice(16) !== ":00" || time < configuration.startTime || time > configuration.endTime ||
        row.r11 > row.r14 || row.r24 !== ezlinksRequestClock(time)) fail("EZLINKS_SLOT_MISMATCH");
    if (!/^-?\d+(?:,-?\d+)*$/u.test(row.r28)) fail("EZLINKS_ICON_UNVERIFIED");
    const iconIds = row.r28.split(",").map(Number), names = iconIds.map(id => iconMap.get(id));
    if (new Set(iconIds).size !== iconIds.length || names.some(name => name === undefined)) fail("EZLINKS_ICON_UNVERIFIED");
    const lengths = names.filter(name => name === "9 holes" || name === "18 holes");
    if (lengths.length > 1) fail("EZLINKS_SLOT_AMBIGUOUS");
    const holes: 9 | 18 | undefined = lengths[0] === "9 holes" ? 9 : lengths[0] === "18 holes" ? 18 : undefined;
    const restricted = names.some(name => name === "Resident Fee" || name === "Member Fee" || name === "Senior Fee" || name === "Junior Fee" || name === "Course Closed");
    const offer = JSON.stringify([row.r07, row.r15, row.r06, row.r12, row.r13, row.r03, row.r04]);
    if (offers.has(offer)) fail("EZLINKS_DUPLICATE_OFFER"); offers.add(offer);
    const instant = toInstant(row.r15), startsAt = instant.toISOString(), key = `${row.r07}:${row.r15}`;
    const previous = physical.get(key);
    if (previous && (previous.capacity !== row.r11 || previous.startsAt !== startsAt || previous.holes !== holes)) fail("EZLINKS_SLOT_AMBIGUOUS");
    physical.set(key, { courseId: row.r07, local: row.r15, capacity: row.r11, startsAt, ...(holes === undefined ? {} : { holes }),
      publicRate: previous?.publicRate === true || rate.r03 === "Daily Fee" && !restricted });
  }
  return [...physical.values()].filter(row => row.publicRate && row.capacity >= input.players && row.local.slice(11, 16) >= input.startTime &&
    row.local.slice(11, 16) < input.endTime).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.courseId - b.courseId).map(row => ({
    sourceId: `ezlinks-${createHash("sha256").update(JSON.stringify([configuration.metadata.tenant, row.courseId, row.local])).digest("hex")}`,
    startsAt: row.startsAt, availableSpots: row.capacity, resourceId: `ezlinks-course:${row.courseId}`,
    ...(row.holes === undefined ? {} : { holes: row.holes }),
  }));
}
