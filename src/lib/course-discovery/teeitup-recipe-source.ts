import { z } from "zod";
import { resolveTeeItUpFacilityIdentity } from "@/lib/adapters/teeitup-facility-identity";
import { isSafeRecipeUrl } from "./recipe";
import { fullCourseName, matchesOfficialFacility, type TeeItUpOfficialIdentityProof } from "./teeitup-official-identity";
import { parseTeeItUpV2PublicSource } from "@/lib/adapters/teeitup-public-source";
import { bindTeeItUpOfficialBookingFacility, type TeeItUpOfficialBookingSourceProof } from "./teeitup-official-booking-source";
import { normalizePublicCoursePhone, type TeeItUpPostalConflictProof } from "./teeitup-postal-conflict-proof";
import { bindDelegatedFacility, type TeeItUpDelegatedBookingProof } from "./teeitup-delegated-booking-source";
import { matchesTeeItUpStreetTypeOmittedDirectory, type TeeItUpStreetTypeOmittedProof } from "./teeitup-street-type-omitted-proof";
import type { TeeItUpBookingConfiguration } from "./teeitup-booking-configuration";

const id = z.number().int().min(1).max(2_147_483_647);
const facility = z.object({ id, courseId: z.string().min(1).max(128), name: z.string().min(2).max(256),
  address: z.string().min(3).max(1024), timeZone: z.string().min(1).max(100), isSimulator: z.boolean().optional() });
export type TeeItUpRecipeFacility = z.infer<typeof facility>;

/** Scope comes from the actual public booking URL, never proposed identifiers. */
export function parseTeeItUpRecipeSource(value: string) {
  if (!isSafeRecipeUrl(value)) return null;
  const v2 = parseTeeItUpV2PublicSource(value);
  if (v2) return { alias: v2.alias, origin: v2.origin, selectedIds: v2.selectedIds };
  const url = new URL(value), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.book\.teeitup\.(?:com|golf)$/u.exec(url.hostname);
  if (!match || url.pathname !== "/" || url.hash || [...url.searchParams.keys()].some(key => !["course", "date"].includes(key)) ||
    url.searchParams.getAll("course").length > 1 || url.searchParams.getAll("date").length > 1) return null;
  const selected = url.searchParams.get("course");
  if (selected !== null && !/^[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,19}$/u.test(selected)) return null;
  const ids = selected?.split(",").map(Number);
  if (ids && (ids.some(value => !id.safeParse(value).success) || new Set(ids).size !== ids.length)) return null;
  const date = url.searchParams.get("date");
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) return null;
  return { alias: match[1], origin: url.origin, selectedIds: ids?.sort((a, b) => a - b) };
}

export function teeItUpRecipeBookingUrl(source: string, date: string, facilityId: number) {
  const parsed = parseTeeItUpRecipeSource(source);
  if (!parsed || !id.safeParse(facilityId).success || parsed.selectedIds && !parsed.selectedIds.includes(facilityId) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("ADAPTER_SOURCE_MISMATCH");
  const url = new URL(source);
  url.searchParams.set("course", String(facilityId));
  url.searchParams.set("date", date);
  return url.href;
}

export function isTeeItUpRecipeSlotLink(source: string, date: string, allowedIds: number[], slot: { sourceId: string; resourceId?: string; bookingUrl: string }) {
  const resource = /^teeitup-facility:([1-9]\d*)(?::simulator:([1-9]\d*))?$/u.exec(slot.resourceId ?? "");
  const sourceId = /^teeitup-([1-9]\d*)-/u.exec(slot.sourceId);
  if (!resource || !sourceId || resource[1] !== sourceId[1] || !allowedIds.includes(Number(resource[1]))) return false;
  if (resource[2] && !slot.sourceId.startsWith(`teeitup-${resource[1]}-simulator-${resource[2]}-duration-`)) return false;
  try { return slot.bookingUrl === teeItUpRecipeBookingUrl(source, date, Number(resource[1])); }
  catch { return false; }
}

export function resolveTeeItUpRecipeFacilities(source: { bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string; officialUrl?: string }, value: unknown, officialProof?: TeeItUpOfficialIdentityProof,
  offeringKind: "OUTDOOR" | "SIMULATOR" | "AUTO" = "OUTDOOR", bookingProof?: TeeItUpOfficialBookingSourceProof, postalProof?: TeeItUpPostalConflictProof,
  delegatedProof?: TeeItUpDelegatedBookingProof, omittedProof?: TeeItUpStreetTypeOmittedProof, configuration?: TeeItUpBookingConfiguration) {
  const booking = parseTeeItUpRecipeSource(source.bookingUrl);
  const parsed = z.array(facility).min(1).max(100).safeParse(value);
  if (offeringKind === "SIMULATOR" && (officialProof || bookingProof || postalProof || delegatedProof || omittedProof) ||
      [officialProof, bookingProof, postalProof, delegatedProof, omittedProof].filter(Boolean).length > 1) throw new Error("ADAPTER_IDENTITY_MISMATCH");
  if (!booking || !source.venueAddress || !parsed.success ||
      new Set(parsed.data.map(row => row.id)).size !== parsed.data.length || new Set(parsed.data.map(row => row.courseId)).size !== parsed.data.length)
    throw new Error("ADAPTER_CONFIGURATION_UNVERIFIED");
  const identity = { name: source.venueName, address: source.venueAddress, timeZone: source.timeZone };
  const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const matches = (row: TeeItUpRecipeFacility) => {
    if (row.isSimulator === true) return offeringKind !== "OUTDOOR" && nameKey(row.name) === nameKey(source.venueName) &&
      resolveTeeItUpFacilityIdentity(identity, [row]).status === "MATCHED";
    return offeringKind !== "SIMULATOR" && resolveTeeItUpFacilityIdentity(identity,
      [{ ...row, name: row.name.split(/\s+-\s+/u)[0] }]).status === "MATCHED";
  };
  const alternate = officialProof ? parsed.data.filter(row => matchesOfficialFacility(officialProof, source, row)) : [];
  if (postalProof) {
    const row = parsed.data.find(row => row.id === postalProof.facilityId);
    const raw = Array.isArray(value) ? value.find(row => row?.id === postalProof.facilityId) : undefined;
    if (!row || row.courseId !== postalProof.courseId || row.address !== postalProof.providerAddress || row.timeZone !== postalProof.timeZone ||
        row.isSimulator !== false || raw?.country !== "US" || normalizePublicCoursePhone(raw?.phone) !== postalProof.publicCoursePhone ||
        booking.alias !== postalProof.alias || source.venueAddress !== postalProof.canonicalAddress || source.timeZone !== postalProof.timeZone ||
        source.officialUrl !== postalProof.officialUrl || source.bookingUrl !== postalProof.officialSourceProof.bookingUrl ||
        fullCourseName(source.venueName) !== postalProof.officialSourceProof.venueName)
      throw new Error("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
  }
  if (bookingProof && JSON.stringify(bindTeeItUpOfficialBookingFacility(source, bookingProof, value)) !== JSON.stringify(bookingProof))
    throw new Error("OFFICIAL_BOOKING_SOURCE_CHANGED");
  if (delegatedProof && JSON.stringify(bindDelegatedFacility(source, delegatedProof, value)) !== JSON.stringify(delegatedProof))
    throw new Error("OFFICIAL_DELEGATED_SOURCE_CHANGED");
  if (omittedProof && (!configuration || !matchesTeeItUpStreetTypeOmittedDirectory(omittedProof, source, value, configuration)))
    throw new Error("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
  if (officialProof && (alternate.length !== 1 || officialProof.bookingUrl !== source.bookingUrl)) throw new Error("ADAPTER_IDENTITY_MISMATCH");
  const accepted = (row: TeeItUpRecipeFacility) => matches(row) || officialProof !== undefined && alternate[0]?.id === row.id ||
    bookingProof !== undefined && row.id === bookingProof.facilityId && row.courseId === bookingProof.courseId ||
    postalProof !== undefined && row.id === postalProof.facilityId && row.courseId === postalProof.courseId ||
    delegatedProof !== undefined && row.id === delegatedProof.facilityId && row.courseId === delegatedProof.courseId ||
    omittedProof !== undefined && row.id === omittedProof.facilityId && row.courseId === omittedProof.courseId;
  const selected = booking.selectedIds ? parsed.data.filter(row => booking.selectedIds!.includes(row.id)) : parsed.data.filter(accepted);
  if (booking.selectedIds ? selected.length !== booking.selectedIds.length || !selected.every(accepted) : selected.length !== 1)
    throw new Error("ADAPTER_IDENTITY_MISMATCH");
  if (selected.some(row => row.isSimulator === true) && (selected.length !== 1 || officialProof ||
      parsed.data.filter(row => row.isSimulator === true && matches(row)).length !== 1))
    throw new Error("ADAPTER_IDENTITY_MISMATCH");
  return selected.sort((a, b) => a.id - b.id);
}

export function assertTeeItUpRecipeAvailability(value: unknown, facilities: TeeItUpRecipeFacility[], input: { date: string; timeZone: string }) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  const courses = new Set(facilities.map(row => row.courseId));
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  let count = 0;
  for (const day of value) {
    if (!day || typeof day !== "object" || !Array.isArray(day.teetimes) || day.message ||
        day.courseId !== undefined && !courses.has(day.courseId)) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    for (const slot of day.teetimes) {
      if (++count > 500 || !slot || typeof slot !== "object" || typeof slot.teetime !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(slot.teetime) ||
          !Number.isFinite(Date.parse(slot.teetime)) || localDate.format(new Date(slot.teetime)) !== input.date ||
          slot.courseId !== undefined && !courses.has(slot.courseId) ||
          slot.courseId === undefined && facilities.length !== 1 || !Array.isArray(slot.rates) ||
          slot.rates.some((rate: { allowedPlayers?: unknown }) => !rate || !Array.isArray(rate.allowedPlayers) ||
            rate.allowedPlayers.some((players: unknown) => !Number.isInteger(players) || Number(players) < 1 || Number(players) > 100)))
        throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    }
  }
}
