import { createHash } from "node:crypto";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";

const publicId = z.string().regex(/^(?:[1-9]\d{0,9}|[a-fA-F0-9]{24}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/u);
const label = z.string().trim().min(2).max(200);
const zone = z.string().max(100).refine(value => {
  try { return value.includes("/") && new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value; } catch { return false; }
});
const tenant = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
export type RexSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export const rexMetadataSchema = z.object({ family: z.literal("REX"), tenant, venueId: publicId, packageId: publicId,
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type RexMetadata = z.infer<typeof rexMetadataSchema>;
export function rexFailure(code: string): never { throw new Error(code); }

/** Only the actually observed neutral public package landing is durable.
 * Date/party/product state cannot become a stale customer link on reuse. */
export function parseRexSource(value: string) {
  try {
    const url = new URL(value), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.reservewithrex\.com$/u.exec(url.hostname);
    if (url.protocol !== "https:" || !match || url.username || url.password || url.port || url.hash || url.pathname !== "/package" ||
        value.length > 2048 || url.href !== value || /[\u0000-\u0020\u007f]/u.test(value) || !getSafeCustomerBookingUrl(value) ||
        [...url.searchParams.keys()].some(key => key !== "venue") ||
        [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) || !label.safeParse(url.searchParams.get("venue")).success) return;
    return { tenant: match[1], origin: url.origin, venueName: url.searchParams.get("venue")! };
  } catch { return; }
}
export function rexLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}
export function validateRexIdentity(source: RexSource) {
  const entry = parseRexSource(source.bookingUrl);
  try {
    const url = new URL(source.bookingUrl);
    if (!entry && /^([a-z0-9-]+)\.reservewithrex\.com$/u.test(url.hostname) && url.pathname === "/package" &&
        [...url.searchParams.keys()].some(key => ["date", "guests", "currentPackage"].includes(key))) rexFailure("REX_STATIC_SOURCE_REQUIRED");
  } catch (error) { if (error instanceof Error && error.message === "REX_STATIC_SOURCE_REQUIRED") throw error; }
  let officialHttps = false;
  try { officialHttps = new URL(source.officialUrl).protocol === "https:"; } catch { /* Missing identity fails below. */ }
  if (!entry || !officialHttps || !getSafeCustomerBookingUrl(source.officialUrl) ||
      !label.safeParse(source.venueName).success || nameKey(source.venueName).length < 8 || nameKey(entry.venueName) !== nameKey(source.venueName) ||
      !zone.safeParse(source.timeZone).success || !source.venueAddress || !teeItUpCompleteStreetAddress(source.venueAddress)) rexFailure("ADAPTER_IDENTITY_MISSING");
  return entry;
}
const directoryVenue = z.object({ id: publicId, name: label, address: z.string().trim().min(5).max(400), timeZone: zone,
  closed: z.boolean(), isComingSoon: z.boolean() });
export function selectRexVenue(value: unknown, source: RexSource) {
  validateRexIdentity(source);
  const parsed = z.array(directoryVenue).min(1).max(100).safeParse(value);
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) rexFailure("REX_DIRECTORY_INVALID");
  const matches = parsed.data.filter(row => nameKey(row.name) === nameKey(source.venueName));
  if (matches.length !== 1 || matches[0].timeZone !== source.timeZone || matches[0].closed || matches[0].isComingSoon) rexFailure("ADAPTER_IDENTITY_MISMATCH");
  return matches[0];
}
const rental = z.object({ id: publicId, name: label, status: z.boolean(), isHidden: z.boolean(), contactOnly: z.boolean(), isMemberOnlyPackage: z.boolean(),
  numberOfLanes: z.number().int().min(1).max(20), minGuests: z.number().int().min(1).max(200), maxGuests: z.number().int().min(1).max(200),
  method: z.string().max(50), countLanesByGuest: z.boolean(), flexibleByResource: z.boolean(), allowAdditionalGuests: z.boolean(),
  enableDurationChoice: z.boolean(), duration: z.number().finite().min(0).max(480), durationInSlots: z.string().max(400),
  isTimeSlotsInPackage: z.boolean(), enableAssignDuration: z.boolean(), fillToEndOfDay: z.boolean(), shiftingForReservationStart: z.number().finite(),
  preBufferTimeForReservation: z.number().int().min(0).max(96), bufferTimeForReservation: z.number().int().min(0).max(96),
  ageGroups: z.array(z.unknown()).max(20), hasActivities: z.boolean().optional() }).refine(row => row.minGuests <= row.maxGuests);
const venueBody = z.object({ id: publicId, name: label, address: z.string().trim().min(5).max(200), address2: z.string().max(100),
  city: z.string().trim().min(2).max(100), state: z.string().regex(/^[A-Z]{2}$/u), zipCode: z.string().regex(/^\d{5}(?:-\d{4})?$/u), timeZone: zone,
  closed: z.boolean(), isComingSoon: z.boolean(), timeSlotDuration: z.literal(30), timeSlotShifting: z.tuple([z.literal("0"), z.literal("0"), z.literal("0"),
    z.literal("0"), z.literal("0"), z.literal("0"), z.literal("0")]), isStartTimeOnly: z.boolean().optional(),
  packages: z.array(rental).min(1).max(100), timeSlots: z.array(z.unknown()).max(500) });
function unpaged(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key =>
    /^(?:error|errors|hasmore|nextpage|nextcursor|cursor|page|pages|pagenumber|pagesize|totalcount|offset|limit)$/iu.test(key.replace(/[_-]/gu, "")))) rexFailure("REX_RESPONSE_INCOMPLETE");
}
function durationUnits(value: string) {
  if (!/^\s*[1-9]\d?(?:\s*,\s*[1-9]\d?)*\s*$/u.test(value)) rexFailure("REX_DURATION_UNSUPPORTED");
  const units = value.split(",").map(Number);
  if (units.length > 32 || units.some(unit => unit > 16) || new Set(units).size !== units.length) rexFailure("REX_DURATION_UNSUPPORTED");
  return units.sort((a, b) => a - b);
}
function supported(row: z.infer<typeof rental>) {
  return /\bgolf\b/iu.test(row.name) && /\b(?:simulators?|bays?)\b/iu.test(row.name) &&
    !/\b(?:party|tournament|event|lesson|class|member|coaching|league|fitting|bowling|darts|tennis|baseball|batting|karaoke|axe|soccer|hockey|multi[-\s]?sport)\b/iu.test(row.name) && row.status && !row.isHidden && !row.contactOnly && !row.isMemberOnlyPackage &&
    row.numberOfLanes === 1 && row.method === "Per Lane" && !row.countLanesByGuest && !row.flexibleByResource && !row.allowAdditionalGuests &&
    row.enableDurationChoice && !row.isTimeSlotsInPackage && !row.enableAssignDuration && !row.fillToEndOfDay && row.shiftingForReservationStart === 0 &&
    row.ageGroups.length === 0 && !row.hasActivities;
}
function plausiblePublicRental(row: z.infer<typeof rental>) {
  return /\bgolf\b/iu.test(row.name) && /\b(?:simulators?|bays?)\b/iu.test(row.name) &&
    !/\b(?:party|tournament|event|lesson|class|member|coaching|league)\b/iu.test(row.name) &&
    row.status && !row.isHidden && !row.contactOnly && !row.isMemberOnlyPackage;
}
export type RexConfiguration = ReturnType<typeof parseRexConfiguration>;
/** Controller provenance binds official->booking. Independent fresh public data
 * must still match the whole canonical venue, complete postal address and IANA.
 * Unknown commerce/credential fields are never projected or persisted. */
export function parseRexConfiguration(venuesBody: unknown, catalogBody: unknown, source: RexSource) {
  const entry = validateRexIdentity(source), directory = selectRexVenue(venuesBody, source);
  unpaged(catalogBody);
  const parsed = venueBody.safeParse(catalogBody);
  if (!parsed.success) rexFailure("REX_CATALOG_INVALID");
  const data = parsed.data, address = `${data.address}${data.address2.trim() ? ` ${data.address2.trim()}` : ""}, ${data.city}, ${data.state} ${data.zipCode}`;
  if (data.isStartTimeOnly) rexFailure("REX_PUBLIC_RENTAL_UNVERIFIED");
  const canonical = teeItUpCompleteStreetAddress(source.venueAddress!), provider = teeItUpCompleteStreetAddress(address);
  if (data.id !== directory.id || nameKey(data.name) !== nameKey(source.venueName) || data.timeZone !== source.timeZone || data.closed || data.isComingSoon ||
      !provider || JSON.stringify(canonical) !== JSON.stringify(provider) || new Set(data.packages.map(row => row.id)).size !== data.packages.length) rexFailure("ADAPTER_IDENTITY_MISMATCH");
  if (data.packages.some(row => plausiblePublicRental(row) && !supported(row))) rexFailure("REX_PUBLIC_RENTAL_UNVERIFIED");
  const matches = data.packages.filter(supported);
  if (matches.length !== 1) rexFailure("REX_PUBLIC_RENTAL_UNVERIFIED");
  const selected = matches[0], units = durationUnits(selected.durationInSlots);
  const stable = { tenant: entry.tenant, venueId: data.id, source: { officialUrl: source.officialUrl, venueName: source.venueName,
    address: canonical, timeZone: source.timeZone }, directoryAddress: directory.address, providerAddress: provider,
    slotMinutes: data.timeSlotDuration, timeSlotShifting: data.timeSlotShifting,
    catalog: data.packages.map(row => ({ id: row.id, name: row.name, status: row.status, isHidden: row.isHidden, contactOnly: row.contactOnly,
      isMemberOnlyPackage: row.isMemberOnlyPackage, numberOfLanes: row.numberOfLanes, minGuests: row.minGuests, maxGuests: row.maxGuests,
      method: row.method, countLanesByGuest: row.countLanesByGuest, flexibleByResource: row.flexibleByResource, allowAdditionalGuests: row.allowAdditionalGuests,
      enableDurationChoice: row.enableDurationChoice, duration: row.duration, durationInSlots: row.durationInSlots,
      isTimeSlotsInPackage: row.isTimeSlotsInPackage, enableAssignDuration: row.enableAssignDuration, fillToEndOfDay: row.fillToEndOfDay,
      shiftingForReservationStart: row.shiftingForReservationStart, preBufferTimeForReservation: row.preBufferTimeForReservation,
      bufferTimeForReservation: row.bufferTimeForReservation, ageGroupCount: row.ageGroups.length, hasActivities: row.hasActivities ?? false })).sort((a, b) => a.id.localeCompare(b.id)) };
  const metadata = rexMetadataSchema.parse({ family: "REX", tenant: entry.tenant, venueId: data.id, packageId: selected.id,
    catalogHash: createHash("sha256").update(JSON.stringify(stable)).digest("hex") });
  return { metadata, directory, data, selected, durationUnits: units, address };
}
/** Complete successful dated JSON, not displayed chips or array length alone,
 * owns completeness. The reviewed client maps full timeSlots locally; sold-out
 * chips are sourced from !!row.isDisabled, including clickable sold-out chips. */
export function parseRexAvailability(value: unknown, current: RexConfiguration, source: RexSource) {
  const rechecked = parseRexConfiguration([current.directory], value, source);
  if (JSON.stringify(rechecked.metadata) !== JSON.stringify(current.metadata)) rexFailure("ADAPTER_CONFIGURATION_CHANGED");
  const slot = z.object({ id: z.string().regex(/^\d{1,2}$/u), time: z.number().int().min(0).max(47), isDisabled: z.boolean().optional(), is21plus: z.boolean().optional() });
  const rows = rechecked.data.timeSlots.map(value => {
    const parsed = slot.safeParse(value); if (!parsed.success || parsed.data.id !== String(parsed.data.time)) rexFailure("REX_SLOT_INVALID"); return parsed.data;
  });
  if (new Set(rows.map(row => row.time)).size !== rows.length) rexFailure("REX_SLOT_INVALID");
  return rows;
}
