import { z } from "zod";

const publicId = z.string().regex(/^[1-9]\d{0,9}$/u);
const timeZone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; }
  catch { return false; }
});
const uniqueIds = z.array(publicId).min(1).max(40).refine(ids => new Set(ids).size === ids.length);
const duration = z.number().int().min(30).max(240).multipleOf(30);
const acuityTenantHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.as\.me$/u;
const acuitySchedulePath = /^\/schedule\/[a-zA-Z0-9]{4,40}$/u;
const uschedulePath = /^\/([a-z][a-z0-9-]{2,62})\/booking$/u;

export function teeSheetPublicTenant(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash
      ? /^([a-z][a-z0-9-]{0,62})\.teesheet\.ai$/u.exec(url.hostname)?.[1] : undefined;
  } catch { return undefined; }
}

/** Canonical signed-out catalog/detail routes. Purchase/account paths never fit. */
export function upperHandPublicSource(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (url.origin !== "https://app.upperhand.io" || url.username || url.password || url.search || url.hash) return;
    const route = /^(\/customers\/([1-9]\d{0,9})-[a-z0-9-]+)\/events(?:\/([1-9]\d{0,9})-[a-z0-9-]+)?$/u.exec(url.pathname);
    return route ? { customerId: route[2], customerPath: route[1], ...(route[3] ? { eventId: route[3] } : {}) } : undefined;
  } catch { return undefined; }
}

export function yourGolfBookingPublicSource(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
      !["booking.trackmangolf.com", "yourgolfbooking.com"].includes(url.hostname)) return;
    return /^\/venues\/([a-z0-9]+(?:-[a-z0-9]+)*)\/booking\/bays$/u.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export function uschedulePublicTenant(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" && url.hostname === "clients.uschedule.com" && !url.port &&
      !url.username && !url.password && !url.search && !url.hash
      ? uschedulePath.exec(url.pathname)?.[1] : undefined;
  } catch { return undefined; }
}

export function isAcuityPublicResearchRoot(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      acuityTenantHost.test(url.hostname) && url.pathname === "/";
  } catch { return false; }
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Exact source contexts understood by the two existing public readers. */
export function knownSimulatorPublicConfigurationFamily(sourceUrl: string): "ACUITY" | "GOLFBOOK" | "USCHEDULE" | "TEESHEET" | "UPPER_HAND" | "YOUR_GOLF_BOOKING" | undefined {
  if (teeSheetPublicTenant(sourceUrl)) return "TEESHEET";
  if (upperHandPublicSource(sourceUrl)) return "UPPER_HAND";
  if (yourGolfBookingPublicSource(sourceUrl)) return "YOUR_GOLF_BOOKING";
  if (uschedulePublicTenant(sourceUrl)) return "USCHEDULE";
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return;
    if ((url.hostname === "app.acuityscheduling.com" || acuityTenantHost.test(url.hostname)) &&
        !url.search && acuitySchedulePath.test(url.pathname)) return "ACUITY";
    if (!/^[a-z][a-z0-9-]{0,62}\.golfbook\.in$/u.test(url.hostname)) return;
    if (url.pathname === "/calendar.php" && !url.search) return "GOLFBOOK";
    const keys = [...url.searchParams.keys()];
    if (url.pathname === "/bookingsheet.php" && keys.length === 2 && keys.includes("date") && url.searchParams.get("lang") === "en" &&
      validDate(url.searchParams.get("date") ?? "")) return "GOLFBOOK";
  } catch { return undefined; }
}

/** Only public configuration facts used by an existing signed-out reader.
 * No source payload, arbitrary text, credentials or availability are retained. */
export const simulatorPublicConfigurationSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("ACUITY"), ownerKey: z.string().regex(/^[a-zA-Z0-9]{4,40}$/u), businessId: publicId,
    timeZone, maxPartySize: z.number().int().min(1).max(20).nullable(),
    rentals: z.array(z.object({ id: publicId, durationMinutes: duration, calendarIds: uniqueIds,
      calendarKind: z.literal("OPAQUE_AGGREGATE").optional() }).strict()).min(1).max(20),
    resources: z.array(z.object({ id: publicId, timeZone }).strict()).min(1).max(40),
  }).strict().refine(value => new Set(value.rentals.map(row => row.id)).size === value.rentals.length &&
    new Set(value.resources.map(row => row.id)).size === value.resources.length &&
    value.resources.every(row => row.timeZone === value.timeZone) &&
    value.rentals.every(row => row.calendarIds.every(id => value.resources.some(resource => resource.id === id)) &&
      (!row.calendarKind || row.calendarIds.length === 1 && row.durationMinutes >= 60 && row.durationMinutes % 60 === 0))),
  z.object({
    family: z.literal("GOLFBOOK"), templateId: publicId,
    date: z.string().refine(validDate),
    minDurationMinutes: z.number().int().min(30).max(1440), maxDurationMinutes: z.number().int().min(30).max(1440),
    incrementMinutes: z.literal(30), resourceIds: uniqueIds,
  }).strict().refine(value => value.maxDurationMinutes >= value.minDurationMinutes),
  z.object({ family: z.literal("USCHEDULE"), tenant: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
    serviceId: publicId, durationMinutes: z.literal(60), availabilityKind: z.literal("OPAQUE_POOLED") }).strict(),
  z.object({ family: z.literal("TEESHEET"), tenant: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
    durationMinutes: z.literal(60), minDurationMinutes: z.number().int().min(1).max(60),
    maxDurationMinutes: z.number().int().min(60).max(1440), incrementMinutes: z.number().int().min(1).max(60),
    bookingWindowDaysAhead: z.number().int().min(1).max(365).nullable(), maxPartySize: z.null(),
  }).strict().refine(value => 60 % value.incrementMinutes === 0),
  z.object({ family: z.literal("UPPER_HAND"), customerId: publicId, eventId: publicId,
    bookingUrl: z.string().refine(value => Boolean(upperHandPublicSource(value)?.eventId)),
    durationMinutes: z.literal(60), resourceIds: uniqueIds, maxPartySize: z.null(),
  }).strict().refine(value => {
    const source = upperHandPublicSource(value.bookingUrl);
    return source?.customerId === value.customerId && source.eventId === value.eventId;
  }),
  z.object({ family: z.literal("YOUR_GOLF_BOOKING"), venueSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(100),
    venueId: publicId, rangeId: publicId, publicOptionId: publicId, resourceIds: uniqueIds,
    durationMinutes: z.literal(60), maxPartySize: z.number().int().min(1).max(8).nullable(),
    rentalContract: z.literal("PUBLIC_SLOT_V1"), category: z.null(), maintenanceMode: z.boolean().nullable(),
    slotIntervalStart: z.union([z.literal(0), z.literal(30)]), bookingWindowDaysAhead: z.number().int().min(1).max(365),
  }).strict(),
]);

export type SimulatorPublicConfiguration = z.infer<typeof simulatorPublicConfigurationSchema>;
export type AcuityPublicConfiguration = Extract<SimulatorPublicConfiguration, { family: "ACUITY" }>;
export type GolfBookPublicConfiguration = Extract<SimulatorPublicConfiguration, { family: "GOLFBOOK" }>;
export type USchedulePublicConfiguration = Extract<SimulatorPublicConfiguration, { family: "USCHEDULE" }>;

export function isSimulatorPublicConfigurationSource(configuration: SimulatorPublicConfiguration, sourceUrl: string) {
  if (knownSimulatorPublicConfigurationFamily(sourceUrl) !== configuration.family) return false;
  const url = new URL(sourceUrl);
  if (configuration.family === "ACUITY") return configuration.ownerKey === url.pathname.split("/").at(-1);
  if (configuration.family === "USCHEDULE") return configuration.tenant === uschedulePublicTenant(sourceUrl);
  if (configuration.family === "TEESHEET") return configuration.tenant === teeSheetPublicTenant(sourceUrl);
  if (configuration.family === "YOUR_GOLF_BOOKING") return configuration.venueSlug === yourGolfBookingPublicSource(sourceUrl);
  if (configuration.family === "UPPER_HAND") {
    const source = upperHandPublicSource(sourceUrl);
    const booking = upperHandPublicSource(configuration.bookingUrl);
    return Boolean(source && booking && source.customerId === configuration.customerId &&
      source.customerPath === booking.customerPath && (!source.eventId || source.eventId === configuration.eventId));
  }
  return url.pathname !== "/bookingsheet.php" || configuration.date === url.searchParams.get("date");
}
