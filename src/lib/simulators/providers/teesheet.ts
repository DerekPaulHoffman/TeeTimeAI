import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { zonedDateTimeToDate } from "@/lib/timezones";
import { teeSheetPublicTenant } from "./public-configuration";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult } from "./types";

// Public endpoints observed in the provider's signed-out booking application.
// Credentials, contact forms, bookings and waitlists are never requested.
const API = "https://qdp9jvb6p6.execute-api.us-east-1.amazonaws.com/prod";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const schemaError = () => new SimulatorAvailabilityError("SCHEMA_CHANGED", "The public simulator calendar changed shape or identity");

export async function fetchTeeSheetAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  const tenant = teeSheetPublicTenant(input.offering.bookingUrl);
  const metadata = object(input.offering.providerMetadata);
  if (!tenant || metadata?.venueSlug !== tenant || Object.keys(metadata).some(key => key !== "venueSlug")) {
    throw new SimulatorAvailabilityError("INVALID_SOURCE", "The public simulator tenant is not verified");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) ||
      new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date ||
      !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 ||
      !input.offering.id || input.offering.id.length > 200 || input.offering.maxPartySize !== null &&
        (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1 || input.offering.maxPartySize > 20)) {
    throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator date or party size is invalid");
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 60 || input.durationMinutes > 240 ||
      input.durationMinutes % 30 !== 0 || !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) {
    throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The requested simulator session length is not verified");
  }
  if (input.offering.maxPartySize !== null && input.partySize > input.offering.maxPartySize) {
    throw new SimulatorAvailabilityError("PARTY_TOO_LARGE", "The party exceeds the verified simulator capacity");
  }
  const url = new URL(`${API}/availability/slots`);
  url.search = new URLSearchParams({ date: input.date, duration: String(input.durationMinutes), price_for: "me", venue: tenant }).toString();
  const payload = object(await readTeeSheetPublicJson(url, fetchImpl));
  if (!payload || payload.date !== input.date || !Array.isArray(payload.slots) || payload.slots.length > 2000) throw schemaError();
  if (payload.closed === true) {
    if (payload.slots.length) throw schemaError();
    return { slots: [], complete: true, observedAt: new Date(), evidenceUrl: url.toString() };
  }
  if (payload.closed !== undefined && payload.closed !== false || payload.duration_mins !== input.durationMinutes ||
      payload.priced_for !== "me" || payload.request_mode !== false || payload.would_be_closed !== false) throw schemaError();
  const identities = new Set<string>();
  const slots = payload.slots.flatMap(value => {
    const slot = object(value);
    if (!slot || typeof slot.simulator_id !== "string" || !UUID.test(slot.simulator_id) ||
        typeof slot.start_time !== "string" || !CLOCK.test(slot.start_time) ||
        typeof slot.end_time !== "string" || !CLOCK.test(slot.end_time) ||
        typeof slot.taken !== "boolean" || typeof slot.is_training_bay !== "boolean") throw schemaError();
    const startMinute = Number(slot.start_time.slice(0, 2)) * 60 + Number(slot.start_time.slice(3));
    const endMinute = Number(slot.end_time.slice(0, 2)) * 60 + Number(slot.end_time.slice(3));
    if (endMinute - startMinute !== input.durationMinutes) throw schemaError();
    const startsAt = zonedDateTimeToDate(`${input.date}T${slot.start_time}:00`, input.timeZone);
    const endsAt = zonedDateTimeToDate(`${input.date}T${slot.end_time}:00`, input.timeZone);
    if (endsAt.getTime() - startsAt.getTime() !== input.durationMinutes * 60_000) throw schemaError();
    const sourceId = `teesheet:${input.offering.id}:${tenant}:${slot.simulator_id}:${startsAt.toISOString()}:${input.durationMinutes}`;
    if (identities.has(sourceId)) throw schemaError();
    identities.add(sourceId);
    if (slot.taken) return [];
    return [{ sourceId, offeringId: input.offering.id, resourceId: slot.simulator_id,
      productId: `${input.durationMinutes}`, startsAt, endsAt, maxPartySize: input.offering.maxPartySize,
      bookingUrl: input.offering.bookingUrl }];
  });
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.toString() };
}

async function readTeeSheetPublicJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", headers: { Accept: "application/json" } }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true); }
  if (!response.ok) throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be read", response.status === 429 || response.status >= 500, response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.toString() || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw schemaError();
  const reader = response.body?.getReader();
  if (!reader) throw schemaError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 600_000) { await reader.cancel(); throw schemaError(); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof SimulatorAvailabilityError) throw error; throw schemaError(); }
  finally { reader.releaseLock(); }
}
