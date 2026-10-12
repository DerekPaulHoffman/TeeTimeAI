import { describe, expect, it, vi } from "vitest";
import { fetchSimulatorAvailability } from "./index";
import type { SimulatorAvailabilityInput } from "./types";

const input: SimulatorAvailabilityInput = { date: "2026-11-06", durationMinutes: 60, partySize: 4, timeZone: "America/New_York",
  offering: { id: "fixture", courseId: "venue", bookingUrl: "https://oakwood.teesheet.ai/", providerFamilyKey: "TEESHEET",
    providerMetadata: { venueSlug: "oakwood" }, maxPartySize: 6, supportedDurationsMinutes: [60, 90, 120] } };
const slot = { simulator_id: "3fb6ce8b-7df0-4d99-b032-25b41ccf773f", start_time: "09:00", end_time: "10:00", taken: false, is_training_bay: false };
const payload = () => ({ date: input.date, duration_mins: 60, priced_for: "me", request_mode: false, would_be_closed: false, slots: [slot] });
const reader = (data: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));

describe("public TeeSheet availability", () => {
  it("uses only the observed unsigned GET and preserves venue-local time and bay identity", async () => {
    const fetch = reader(payload());
    const result = await fetchSimulatorAvailability(input, fetch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual" }));
    expect(String(fetch.mock.calls[0][0])).toBe("https://qdp9jvb6p6.execute-api.us-east-1.amazonaws.com/prod/availability/slots?date=2026-11-06&duration=60&price_for=me&venue=oakwood");
    expect(result).toMatchObject({ complete: true, slots: [{ resourceId: slot.simulator_id, productId: "60", startsAt: new Date("2026-11-06T14:00:00Z"), endsAt: new Date("2026-11-06T15:00:00Z"), bookingUrl: input.offering.bookingUrl }] });
  });
  it("returns checked-empty for an explicitly closed exact date", async () => {
    expect(await fetchSimulatorAvailability(input, reader({ date: input.date, closed: true, slots: [] }))).toMatchObject({ complete: true, slots: [] });
  });
  it("omits occupied intervals without suppressing available bays", async () => {
    const result = await fetchSimulatorAvailability(input, reader({ ...payload(), slots: [{ ...slot, taken: true }, { ...slot, simulator_id: "fc4e572d-b4f4-4b2c-8933-5672e5d0c820" }] }));
    expect(result.slots).toHaveLength(1);
  });
  it.each([
    { date: "2026-11-07" }, { duration_mins: 90 }, { request_mode: true }, { would_be_closed: true },
    { slots: [slot, slot] }, { slots: [{ ...slot, taken: undefined }] }, { slots: [{ ...slot, end_time: "09:30" }] },
    { closed: true }, { slots: [{ ...slot, simulator_id: "unknown" }] },
  ])("fails closed on incomplete or conflicting public inventory %j", async change => {
    await expect(fetchSimulatorAvailability(input, reader({ ...payload(), ...change }))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it.each(["https://oakwood.teesheet.ai.attacker.example/", "http://oakwood.teesheet.ai/", "https://oakwood.teesheet.ai/checkout"])("rejects unsafe source %s before I/O", async bookingUrl => {
    const fetch = reader(payload());
    await expect(fetchSimulatorAvailability({ ...input, offering: { ...input.offering, bookingUrl } }, fetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not infer a tenant, capacity or supported duration", async () => {
    const fetch = reader(payload());
    await expect(fetchSimulatorAvailability({ ...input, offering: { ...input.offering, providerMetadata: {} } }, fetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(fetchSimulatorAvailability({ ...input, partySize: 7 }, fetch)).rejects.toMatchObject({ code: "PARTY_TOO_LARGE" });
    await expect(fetchSimulatorAvailability({ ...input, durationMinutes: 180 }, fetch)).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
