import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilitySlot } from "./types";

/** A single duration-specific provider result already proves a continuous
 * resource interval. Quantity is never converted into golfers or named bays. */
export function parseProviderComputedSlots({ input, payload, productId, maxPartySize, sourcePrefix, resourceId = "ANY" }: {
  input: SimulatorAvailabilityInput; payload: unknown; productId: string;
  maxPartySize: number | null; sourcePrefix: string; resourceId?: string;
}): SimulatorAvailabilitySlot[] {
  if (!Array.isArray(payload) || payload.length > 300) throw schemaError("The public simulator calendar did not return a bounded availability list");
  const seen = new Set<string>();
  const slots: SimulatorAvailabilitySlot[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || typeof item.time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:?\d{2}$/u.test(item.time) ||
      !Number.isInteger(item.slotsAvailable) || item.slotsAvailable < 0 || item.slotsAvailable > 100) throw schemaError("The public simulator calendar returned an unrecognized time or resource count");
    const startsAt = new Date(item.time);
    if (!Number.isFinite(startsAt.getTime())) throw schemaError("The simulator calendar time does not match the requested venue date and timezone");
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(startsAt);
    const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (`${local.year}-${local.month}-${local.day}` !== input.date || `${local.hour}:${local.minute}:${local.second}` !== item.time.slice(11, 19)) throw schemaError("The simulator calendar time does not match the requested venue date and timezone");
    if (item.slotsAvailable === 0 || seen.has(startsAt.toISOString())) continue;
    seen.add(startsAt.toISOString());
    slots.push({ sourceId: `${sourcePrefix}:${input.offering.id}:${productId}:${startsAt.toISOString()}`, offeringId: input.offering.id, resourceId, productId, startsAt, endsAt: new Date(startsAt.getTime() + input.durationMinutes * 60_000), maxPartySize, bookingUrl: input.offering.bookingUrl });
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
function schemaError(message: string) { return new SimulatorAvailabilityError("SCHEMA_CHANGED", message); }
