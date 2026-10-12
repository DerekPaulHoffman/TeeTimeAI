import { simulatorPublicConfigurationSchema, teeSheetPublicTenant, upperHandPublicSource, yourGolfBookingPublicSource, type SimulatorPublicConfiguration } from "@/lib/simulators/providers/public-configuration";
import type { SimulatorConfigurationDiagnostic } from "./simulator-support-research";

const TEE_API = "https://qdp9jvb6p6.execute-api.us-east-1.amazonaws.com/prod";
const UPPER_API = "https://api.upperhand.io/api";
const ID = /^[1-9]\d{0,9}$/u;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
export type PublicApiConfigurationDiagnostic = {
  phase: "CONFIG";
  reason: "PUBLIC_PROVIDER_HTTP_ERROR" | "PUBLIC_PROVIDER_CONFIG_REJECTED" | "PUBLIC_PROVIDER_CATALOG_AMBIGUOUS" | "PUBLIC_PROVIDER_NO_ONE_HOUR_RENTAL";
  publicProviderFamily: "TEESHEET" | "UPPER_HAND";
  httpStatus?: number;
  contractField?: "SETTINGS" | "CATALOG" | "RENTAL_IDENTITY" | "PUBLIC_ACCESS" | "DURATION" | "RESOURCE_IDENTITY";
};
type Result = { publicConfiguration?: SimulatorPublicConfiguration; configurationDiagnostic?: PublicApiConfigurationDiagnostic };
type PublicRead = (url: string, headers: Record<string, string>) => Promise<{ url: string; status: number; contentType: string; body: Buffer }>;

function projected(value: unknown): SimulatorPublicConfiguration | undefined {
  const parsed = simulatorPublicConfigurationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Only a complete, validated null-category diagnostic can fit the reviewed
 * slot contract. A truncated prefix or older omitted fact remains unknown. */
export function projectYourGolfBookingReviewedSlotConfiguration(diagnostic: SimulatorConfigurationDiagnostic | undefined, sourceUrl: string) {
  const venueSlug = yourGolfBookingPublicSource(sourceUrl);
  const facts = diagnostic?.candidateMetadata;
  if (!venueSlug || diagnostic?.reason !== "CONFIG_NO_ELIGIBLE_RENTALS" || !facts?.venueId || facts.venueStatusState !== "LIVE" ||
    !["FALSE", "NULL"].includes(diagnostic.maintenanceModeState ?? "") || facts.candidatesTruncated || facts.resourcesTruncated || facts.rangesTruncated ||
    facts.candidateCount !== facts.candidates.length || facts.rangeCount !== facts.ranges.length ||
    facts.resourceCount !== facts.resources.length || !facts.resources.length) return;
  const eligible = facts.candidates.filter(rental => rental.nameMatchesPublicRate && !rental.disabled && !rental.waitlisted &&
    rental.duration === 1 && rental.durationTypeToken === "slot" && rental.minDurationSlots <= 2 && rental.maxDurationSlots >= 2 &&
    rental.bufferMinutes === 0 && !rental.hasRestrictions && !rental.requiresPerks);
  if (eligible.length !== 1) return;
  const rental = eligible[0];
  const resources = facts.resources.filter(resource => resource.optionIds.includes(rental.publicOptionId) && resource.appliedOptionIds.includes(rental.publicOptionId));
  const range = facts.ranges.find(range => resources.length && resources.every(resource => resource.rangeId === range.id));
  if (!range || resources.some(resource => resource.hasRestrictedTimes) ||
    !range.slugIsBays || !range.bookable || range.slotDurationMinutes !== 30 || range.slotIntervalMinutes !== 30 ||
    ![0,30].includes(range.slotIntervalStart) || !range.assumeOpen || !range.bookingUiIsStandard || !range.customerBookingUiIsSlots ||
    range.hasOpeningTimeRestrictions || range.openingHoursFormat !== "WEEKLY_OR_DATED") return;
  const days = range.maxBookAheadUnitToken === "day" ? range.maxBookAheadValue : range.maxBookAheadUnitToken === "week" ? range.maxBookAheadValue * 7 : undefined;
  return projected({ family: "YOUR_GOLF_BOOKING", venueSlug, venueId: facts.venueId, rangeId: range.id,
    publicOptionId: rental.publicOptionId, resourceIds: resources.map(resource => resource.id), durationMinutes: 60,
    maxPartySize: rental.maxPlayers ?? null, rentalContract: "PUBLIC_SLOT_V1", category: null,
    maintenanceMode: diagnostic.maintenanceModeState === "NULL" ? null : false,
    slotIntervalStart: range.slotIntervalStart, bookingWindowDaysAhead: days });
}

export function projectTeeSheetPublicConfiguration(payload: unknown, sourceUrl: string) {
  const tenant = teeSheetPublicTenant(sourceUrl);
  const settings = record(record(payload)?.booking_settings);
  if (!tenant || !settings || !integer(settings.min_duration_mins, 1, 60) || !integer(settings.max_duration_mins, 60, 1440) ||
    !integer(settings.time_increment_mins, 1, 60) || 60 % Number(settings.time_increment_mins) !== 0 ||
    settings.advance_booking_days !== undefined && settings.advance_booking_days !== null && !integer(settings.advance_booking_days, 1, 365)) return;
  return projected({ family: "TEESHEET", tenant, durationMinutes: 60, minDurationMinutes: settings.min_duration_mins,
    maxDurationMinutes: settings.max_duration_mins, incrementMinutes: settings.time_increment_mins,
    bookingWindowDaysAhead: settings.advance_booking_days ?? null, maxPartySize: null });
}

/** Reject private/changed rentals before retaining only the public reader's facts. */
export function projectUpperHandPublicConfiguration(payload: unknown, sourceUrl: string, eventId: string): Result {
  const source = upperHandPublicSource(sourceUrl);
  const event = record(payload);
  const booking = typeof event?.url === "string" ? upperHandPublicSource(event.url) : undefined;
  const rejected = (contractField: NonNullable<PublicApiConfigurationDiagnostic["contractField"]>): Result => ({ configurationDiagnostic:
    { phase: "CONFIG", reason: "PUBLIC_PROVIDER_CONFIG_REJECTED", publicProviderFamily: "UPPER_HAND", contractField } });
  if (!source || !ID.test(eventId) || source.eventId && source.eventId !== eventId || !event || String(event.id) !== eventId ||
    booking?.eventId !== eventId || booking.customerId !== source.customerId || booking.customerPath !== source.customerPath) return rejected("RENTAL_IDENTITY");
  if (event.privacy !== false || event.status !== "active" || event.schedule_type !== "open_booking" ||
    !Array.isArray(event.exclusive_membership_ids) || event.exclusive_membership_ids.length ||
    !Array.isArray(event.exclusive_membership_tier_ids) || event.exclusive_membership_tier_ids.length) return rejected("PUBLIC_ACCESS");
  if (!Array.isArray(event.schedules) || event.schedules.length !== 1) return rejected("DURATION");
  const schedule = record(event.schedules[0]);
  if (!schedule || String(schedule.event_id) !== eventId || schedule.status !== "standard" || schedule.duration !== 3600) return rejected("DURATION");
  if (schedule.resource_usage_mode !== "use_one" || schedule.max_size !== 1 ||
    !Array.isArray(schedule.staff_member_ids) || schedule.staff_member_ids.length ||
    !Array.isArray(schedule.staff_admin_ids) || schedule.staff_admin_ids.length || !Array.isArray(schedule.resource_ids) ||
    schedule.resource_ids.some(id => !(typeof id === "number" && Number.isSafeInteger(id) || typeof id === "string") || !ID.test(String(id)))) return rejected("RESOURCE_IDENTITY");
  const config = projected({ family: "UPPER_HAND", customerId: source.customerId, eventId,
    bookingUrl: event.url, durationMinutes: 60, resourceIds: schedule.resource_ids.map(String), maxPartySize: null });
  return config ? { publicConfiguration: config } : rejected("RESOURCE_IDENTITY");
}

/** Companion GETs are fixed by the validated official provider route, never caller URLs.
 * They share the collector deadline, DNS-pinned transport and provider lease. No
 * browser credential/header, purchase operation or raw payload is retained. */
export async function collectSimulatorPublicApiConfiguration(sourceUrl: string, read: PublicRead): Promise<Result> {
  const tenant = teeSheetPublicTenant(sourceUrl);
  const upper = upperHandPublicSource(sourceUrl);
  if (!tenant && !upper) return {};
  const family = tenant ? "TEESHEET" : "UPPER_HAND";
  const json = async (url: URL): Promise<{ payload?: unknown; diagnostic?: PublicApiConfigurationDiagnostic }> => {
    const response = await read(url.href, { Accept: "application/json", ...(upper ? { "X-Customer-Id": upper.customerId } : {}) });
    if (response.url !== url.href || response.status < 200 || response.status >= 300) return { diagnostic:
      { phase: "CONFIG", reason: "PUBLIC_PROVIDER_HTTP_ERROR", publicProviderFamily: family, httpStatus: response.status } };
    try {
      if (!/^application\/json(?:;|$)/iu.test(response.contentType)) throw new Error("INVALID_PUBLIC_JSON_TYPE");
      return { payload: JSON.parse(response.body.toString("utf8")) as unknown };
    } catch { return { diagnostic: { phase: "CONFIG", reason: "PUBLIC_PROVIDER_CONFIG_REJECTED", publicProviderFamily: family,
      contractField: tenant ? "SETTINGS" : "CATALOG" } }; }
  };
  if (tenant) {
    const url = new URL(`${TEE_API}/availability/pricing`);
    url.searchParams.set("venue", tenant);
    const response = await json(url);
    if (response.diagnostic) return { configurationDiagnostic: response.diagnostic };
    const config = projectTeeSheetPublicConfiguration(response.payload, sourceUrl);
    return config ? { publicConfiguration: config } : { configurationDiagnostic:
      { phase: "CONFIG", reason: "PUBLIC_PROVIDER_CONFIG_REJECTED", publicProviderFamily: "TEESHEET", contractField: "SETTINGS" } };
  }
  let eventId = upper!.eventId;
  if (!eventId) {
    const url = new URL(`${UPPER_API}/compound_objects/browse_events_list`);
    url.search = new URLSearchParams({ page: "1", per_page: "20", search: "Virtual Golf" }).toString();
    const response = await json(url);
    if (response.diagnostic) return { configurationDiagnostic: response.diagnostic };
    const catalog = record(response.payload);
    if (!catalog || catalog.page !== 1 || catalog.per_page !== 20 || !integer(catalog.total_count, 0, 20) ||
      !Array.isArray(catalog.events) || catalog.events.length !== catalog.total_count) return { configurationDiagnostic:
      { phase: "CONFIG", reason: "PUBLIC_PROVIDER_CATALOG_AMBIGUOUS", publicProviderFamily: "UPPER_HAND", contractField: "CATALOG" } };
    const events = catalog.events.map(record);
    if (events.some(event => !event || !ID.test(String(event.event_id)) || !integer(event.duration, 1, 86400) ||
      typeof event.event_title !== "string" || event.event_title.length < 1 || event.event_title.length > 200 ||
      typeof event.schedule_type !== "string" || event.schedule_type.length > 40) ||
      new Set(events.map(event => String(event!.event_id))).size !== events.length) return { configurationDiagnostic:
      { phase: "CONFIG", reason: "PUBLIC_PROVIDER_CATALOG_AMBIGUOUS", publicProviderFamily: "UPPER_HAND", contractField: "CATALOG" } };
    const candidates = events.filter(event => event && ID.test(String(event.event_id)) &&
      event.duration === 3600 && event.schedule_type === "open_booking" && typeof event.event_title === "string" &&
      event.event_title.length <= 200 && /\bvirtual\s+golf\b/iu.test(event.event_title));
    if (candidates.length !== 1) return { configurationDiagnostic: { phase: "CONFIG", reason: candidates.length ?
      "PUBLIC_PROVIDER_CATALOG_AMBIGUOUS" : "PUBLIC_PROVIDER_NO_ONE_HOUR_RENTAL", publicProviderFamily: "UPPER_HAND", contractField: "CATALOG" } };
    eventId = String(candidates[0]!.event_id);
  }
  const url = new URL(`${UPPER_API}/events/${eventId}`);
  url.search = new URLSearchParams([["fields[]", "image"], ["fields[]", "exclusive_membership_ids"]]).toString();
  const response = await json(url);
  return response.diagnostic ? { configurationDiagnostic: response.diagnostic } : projectUpperHandPublicConfiguration(response.payload, sourceUrl, eventId);
}
