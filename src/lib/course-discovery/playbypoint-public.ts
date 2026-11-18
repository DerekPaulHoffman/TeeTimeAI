import { createHash } from "node:crypto";
import { z } from "zod";

export const PLAYBYPOINT_CLIENT_URL = "https://greenfield.playbypoint.com/assets/index-DzGwOgJj.js";
export const PLAYBYPOINT_CLIENT_HASH = "01d6ff63449aea7b0b82386704e91cc8817dbc6f8064642f8b935e67f0116f65";
// Digest of the anonymous HTTP Basic constant shipped in the reviewed public client.
// No signed-in account or copied browser credential is accepted.
const PUBLIC_HEADER_HASH = "a1467822e3fc6ab4d8a74cd7ead5f8690069a4f47a5f43ac549140cc88382b7c";
const id = z.string().regex(/^[1-9]\d{0,9}$/u);
const seconds = z.number().int().min(0).max(86400);
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
export const playbyPointMetadataSchema = z.object({
  family: z.literal("PLAYBYPOINT"), entryUrl: z.string().url(), bookingRoot: z.string().url(),
  widgetUrl: z.string().url(), facilityUuid: uuid, facilityId: id, timeZone: z.string().min(1).max(100),
  warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME"),
  resources: z.array(z.object({ id, name: z.string().min(1).max(100) }).strict()).min(1).max(12),
}).strict().refine(value => new Set(value.resources.map(resource => resource.id)).size === value.resources.length &&
  parsePlaybyPointWidget(value.widgetUrl)?.facilityUuid === value.facilityUuid);
export type PlaybyPointMetadata = z.infer<typeof playbyPointMetadataSchema>;
export type PlaybyPointSource = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };

export const PLAYBYPOINT_QUERY = `query GetPublicBookingOptions($input: BookingOptionsInput!) {
 whiteLabelFacility { id bookingOptions(input: $input) {
 timeZone schedule { dateFrom dateTo openDates date suggestedDate maximumDuration startOptions { hourStart hourEnds __typename } __typename }
 players { options { quantity requiredParticipantCount allPlayersRequired __typename } suggestedQuantity __typename }
 location { sports { value text available __typename } surfaces { value text sport available __typename }
 courts { mode options { id name surface __typename } candidateCourtId __typename } __typename }
 selection { status conflictingFields __typename } __typename } __typename } }`;
const facilityQuery = `query GetWhiteLabelFacility {
 whiteLabelFacility { id name slug logo(size: NORMAL) favicon(size: SIZE_512) mainColor
 bookingWaiverEnabled showBookingWaiverOnNewReservations openBookingImage(size: NORMAL) address phoneNumber __typename } }`;
export function isPlaybyPointPublicFacilityRead(body: string | null) {
  if (!body || body.length > 2000) return false;
  try {
    const request = z.object({ operationName: z.literal("GetWhiteLabelFacility"),
      variables: z.object({}).strict(), query: z.string() }).strict().parse(JSON.parse(body));
    return request.query.replace(/\s+/gu, "") === facilityQuery.replace(/\s+/gu, "");
  } catch { return false; }
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const inputSchema = z.object({ dateFrom: date.optional(), dateTo: date.optional(), date: date.optional(), sport: z.literal("SIMULATOR").optional(),
  hourStart: seconds.optional(), hourEnd: seconds.optional() }).strict().refine(value =>
  (value.hourStart === undefined) === (value.hourEnd === undefined) &&
  (value.hourStart === undefined || value.hourEnd! > value.hourStart && Boolean(value.date)));
export function playbyPointReadInput(body: string | null) {
  if (!body || body.length > 6000) return null;
  try {
    const request = z.object({ operationName: z.literal("GetPublicBookingOptions"),
      variables: z.object({ input: inputSchema }).strict(), query: z.string() }).strict().parse(JSON.parse(body));
    if (request.query.replace(/\s+/gu, "") !== PLAYBYPOINT_QUERY.replace(/\s+/gu, "")) return null;
    return request.variables.input;
  } catch { return null; }
}
export const playbyPointOptionsSchema = z.object({
  data: z.object({ whiteLabelFacility: z.object({ id, bookingOptions: z.object({
    timeZone: z.string(), schedule: z.object({ dateFrom: date, dateTo: date, openDates: z.array(date).max(31),
      date, suggestedDate: date, maximumDuration: seconds,
      startOptions: z.array(z.object({ hourStart: seconds, hourEnds: z.array(seconds).max(48) })).max(96) }),
    location: z.object({ sports: z.array(z.object({ value: z.string(), text: z.string(), available: z.boolean() })).max(20),
      surfaces: z.array(z.object({ value: z.string(), text: z.string(), sport: z.string(), available: z.boolean() })).max(20),
      courts: z.object({ mode: z.literal("MANUAL"), options: z.array(z.object({ id, name: z.string().min(1).max(100),
        surface: z.literal("simulator") })).max(12), candidateCourtId: id.nullable() }) }),
    selection: z.object({ status: z.enum(["INCOMPLETE", "COMPLETE", "CONFLICTING", "INVALID"]), conflictingFields: z.array(z.string()).max(20) }),
  }) }) }), errors: z.array(z.never()).max(0).optional(),
});
export type PlaybyPointOptions = z.infer<typeof playbyPointOptionsSchema>["data"]["whiteLabelFacility"];
export function parsePlaybyPointWidget(value: string) {
  try {
    const url = new URL(value);
    const facilityUuid = url.searchParams.get("whiteLabelFacilityUuid");
    if (url.origin !== "https://greenfield.playbypoint.com" || url.pathname !== "/booking/select" ||
      url.username || url.password || url.hash || url.searchParams.size !== 2 ||
      url.searchParams.get("whiteLabelHost") !== "true" || !uuid.safeParse(facilityUuid).success) return null;
    return { url: url.href, facilityUuid: facilityUuid! };
  } catch { return null; }
}
export function playbyPointPublicHeader(headers: Record<string, string>) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return normalized.fooly === "cooly" && typeof normalized.authorization === "string" &&
    createHash("sha256").update(normalized.authorization).digest("hex") === PUBLIC_HEADER_HASH &&
    !Object.keys(normalized).some(key => /^(?:cookie|x-api-key|proxy-authorization|token|x-csrf-token)$/u.test(key));
}
export function playbyPointResourceSelection(value: PlaybyPointOptions, expected: {
  facilityId?: string; date: string; timeZone: string; start?: number; end?: number;
}) {
  const options = value.bookingOptions;
  if (expected.facilityId && value.id !== expected.facilityId || options.timeZone !== expected.timeZone ||
    options.schedule.date !== expected.date || options.selection.status !== "INCOMPLETE" || options.selection.conflictingFields.length ||
    !options.schedule.openDates.includes(expected.date) || options.schedule.maximumDuration < 3600 ||
    new Set(options.schedule.startOptions.map(option => option.hourStart)).size !== options.schedule.startOptions.length ||
    options.schedule.startOptions.some(option => new Set(option.hourEnds).size !== option.hourEnds.length ||
      option.hourEnds.some(end => end <= option.hourStart)) ||
    !options.location.sports.some(sport => sport.value === "SIMULATOR" && sport.available) ||
    options.location.surfaces.length !== 1 || options.location.surfaces[0].value !== "simulator" ||
    options.location.surfaces[0].sport !== "SIMULATOR" || !options.location.surfaces[0].available ||
    new Set(options.location.courts.options.map(court => court.id)).size !== options.location.courts.options.length)
    throw Error("PLAYBYPOINT_SCOPE_UNVERIFIED");
  if (expected.start !== undefined && !options.schedule.startOptions.some(option =>
    option.hourStart === expected.start && option.hourEnds.includes(expected.end!)))
    throw Error("PLAYBYPOINT_DURATION_UNVERIFIED");
  return options.location.courts.options.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}
