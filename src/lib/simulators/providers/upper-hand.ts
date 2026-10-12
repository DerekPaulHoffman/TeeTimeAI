import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { zonedDateTimeToDate } from "@/lib/timezones";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult, type SimulatorAvailabilitySlot } from "./types";

const ID = /^[1-9]\d{0,9}$/u;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const schemaError = () => new SimulatorAvailabilityError("SCHEMA_CHANGED", "The public simulator rental calendar changed shape or identity");

/** Public event configuration and date-specific resource inventory only.
 * The purchase/account drawer is never opened; X-Customer-Id is the public
 * tenant selector used by the signed-out application, not a credential. */
export async function fetchUpperHandAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  const metadata = object(input.offering.providerMetadata);
  const customerId = metadata?.customerId;
  const eventId = metadata?.eventId;
  const resources = metadata?.resourceIds;
  let booking: URL;
  try { booking = new URL(input.offering.bookingUrl); } catch { throw schemaError(); }
  const route = /^\/customers\/([1-9]\d{0,9})-[a-z0-9-]+\/events\/([1-9]\d{0,9})-[a-z0-9-]+$/u.exec(booking.pathname);
  if (booking.origin !== "https://app.upperhand.io" || booking.username || booking.password || booking.search || booking.hash ||
      !route || customerId !== route[1] || eventId !== route[2] || typeof customerId !== "string" || typeof eventId !== "string" ||
      !ID.test(customerId) || !ID.test(eventId) || !Array.isArray(resources) || resources.length < 1 || resources.length > 40 ||
      resources.some(id => typeof id !== "string" || !ID.test(id)) || new Set(resources).size !== resources.length ||
      Object.keys(metadata!).some(key => !["customerId", "eventId", "resourceIds"].includes(key))) {
    throw new SimulatorAvailabilityError("INVALID_SOURCE", "The public simulator tenant, rental or resources are not verified");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) ||
      new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 ||
      !input.offering.id || input.offering.id.length > 200 || input.offering.maxPartySize !== null &&
        (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1 || input.offering.maxPartySize > 20)) {
    throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator date or party size is invalid");
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 60 || input.durationMinutes > 240 ||
      !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) {
    throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The requested simulator session length is not verified");
  }
  if (input.offering.maxPartySize !== null && input.partySize > input.offering.maxPartySize) {
    throw new SimulatorAvailabilityError("PARTY_TOO_LARGE", "The party exceeds the verified simulator capacity");
  }
  const eventUrl = new URL(`https://api.upperhand.io/api/events/${eventId}`);
  eventUrl.search = new URLSearchParams([["fields[]", "image"], ["fields[]", "exclusive_membership_ids"]]).toString();
  const event = object(await publicJson(eventUrl, customerId, fetchImpl));
  const schedules = event?.schedules;
  if (!event || String(event.id) !== eventId || event.url !== booking.toString() || event.privacy !== false || event.status !== "active" ||
      event.schedule_type !== "open_booking" || !Array.isArray(event.exclusive_membership_ids) || event.exclusive_membership_ids.length ||
      !Array.isArray(event.exclusive_membership_tier_ids) || event.exclusive_membership_tier_ids.length ||
      !Array.isArray(schedules) || schedules.length !== 1) throw schemaError();
  const schedule = object(schedules[0]);
  if (!schedule || String(schedule.event_id) !== eventId || schedule.status !== "standard" || schedule.duration !== input.durationMinutes * 60 ||
      schedule.resource_usage_mode !== "use_one" || schedule.max_size !== 1 || !Array.isArray(schedule.staff_member_ids) || schedule.staff_member_ids.length ||
      !Array.isArray(schedule.staff_admin_ids) || schedule.staff_admin_ids.length || !Array.isArray(schedule.resource_ids) ||
      schedule.resource_ids.length !== resources.length || schedule.resource_ids.some(id => !resources.includes(String(id))) ||
      new Set(schedule.resource_ids).size !== resources.length) throw schemaError();
  const url = new URL(`https://api.upperhand.io/api/events/${eventId}/availability`);
  url.searchParams.set("date", input.date);
  const payload = object(await publicJson(url, customerId, fetchImpl));
  if (!payload || !Number.isInteger(payload.spots_remaining) || Number(payload.spots_remaining) < 0 ||
      !Array.isArray(payload.available_times) || payload.available_times.length > 100) throw schemaError();
  const slots: SimulatorAvailabilitySlot[] = [];
  const identities = new Set<string>();
  for (const value of payload.available_times) {
    const row = object(value);
    if (!row || row.date !== input.date || typeof row.start_time !== "string" || !CLOCK.test(row.start_time) ||
        typeof row.end_time !== "string" || !CLOCK.test(row.end_time) || !Number.isInteger(row.spots_remaining) || Number(row.spots_remaining) < 0 ||
        !Array.isArray(row.staff) || row.staff.length || !Array.isArray(row.resources) || row.resources.length > resources.length) throw schemaError();
    const startsAt = zonedDateTimeToDate(`${input.date}T${row.start_time}`, input.timeZone);
    const endsAt = zonedDateTimeToDate(`${input.date}T${row.end_time}`, input.timeZone);
    if (endsAt.getTime() - startsAt.getTime() !== input.durationMinutes * 60_000) throw schemaError();
    const bayIds = new Set<string>();
    let remaining = 0;
    for (const value of row.resources) {
      const bay = object(value);
      const resourceId = String(bay?.resource_id);
      if (!bay || !resources.includes(resourceId) || bayIds.has(resourceId) || ![0, 1].includes(Number(bay.spots_remaining)) || typeof bay.spots_remaining !== "number") throw schemaError();
      bayIds.add(resourceId);
      remaining += bay.spots_remaining;
      const sourceId = `upper-hand:${input.offering.id}:${customerId}:${eventId}:${resourceId}:${startsAt.toISOString()}`;
      if (identities.has(sourceId)) throw schemaError();
      identities.add(sourceId);
      if (bay.spots_remaining === 0) continue;
      slots.push({ sourceId, offeringId: input.offering.id, resourceId, productId: eventId, startsAt, endsAt,
        maxPartySize: input.offering.maxPartySize, bookingUrl: input.offering.bookingUrl });
    }
    if (remaining !== row.spots_remaining) throw schemaError();
  }
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.toString() };
}

async function publicJson(url: URL, customerId: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json", "X-Customer-Id": customerId } }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true); }
  if (!response.ok) throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be read", response.status === 429 || response.status >= 500, response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.toString() || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw schemaError();
  const reader = response.body?.getReader();
  if (!reader) throw schemaError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 600_000) { await reader.cancel(); throw schemaError(); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw schemaError(); }
  finally { reader.releaseLock(); }
}
