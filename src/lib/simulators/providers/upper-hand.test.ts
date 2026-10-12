import { describe, expect, it, vi } from "vitest";
import { fetchSimulatorAvailability } from "./index";
import type { SimulatorAvailabilityInput } from "./types";

const input: SimulatorAvailabilityInput = { date: "2026-10-13", durationMinutes: 60, partySize: 4, timeZone: "America/New_York",
  offering: { id: "fixture", courseId: "venue", bookingUrl: "https://app.upperhand.io/customers/1683-full-circle-golf/events/100948-virtual-golf-1-hour",
    providerFamilyKey: "UPPER_HAND", providerMetadata: { customerId: "1683", eventId: "100948", resourceIds: ["3859", "3860"] },
    maxPartySize: null, supportedDurationsMinutes: [60] } };
const event = () => ({ id: 100948, url: input.offering.bookingUrl, privacy: false, status: "active", schedule_type: "open_booking",
  exclusive_membership_ids: [], exclusive_membership_tier_ids: [], schedules: [{ event_id: 100948, status: "standard", duration: 3600,
    resource_usage_mode: "use_one", max_size: 1, staff_member_ids: [], staff_admin_ids: [], resource_ids: [3859, 3860] }] });
const row = () => ({ date: input.date, start_time: "10:00:00", end_time: "11:00:00", spots_remaining: 2, staff: [],
  resources: [{ resource_id: 3859, spots_remaining: 1 }, { resource_id: 3860, spots_remaining: 1 }] });
const inventory = () => ({ spots_remaining: 0, available_times: [row()], request_hash: null });
const reader = (rental = event(), data: unknown = inventory()) => vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response(JSON.stringify(rental), { headers: { "content-type": "application/json" } }))
  .mockResolvedValueOnce(new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));

describe("public Upper Hand simulator calendar", () => {
  it("reads the verified rental then date-specific inventory without using purchase/account operations", async () => {
    const fetch = reader();
    const result = await fetchSimulatorAvailability(input, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toBe("https://api.upperhand.io/api/events/100948/availability?date=2026-10-13");
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual",
      headers: { Accept: "application/json", "X-Customer-Id": "1683" } });
    expect(result).toMatchObject({ complete: true, slots: [{ resourceId: "3859", startsAt: new Date("2026-10-13T14:00:00Z"), maxPartySize: null }, { resourceId: "3860" }] });
  });
  it("uses per-resource counts even when top-level spots remaining is zero", async () => {
    expect((await fetchSimulatorAvailability(input, reader())).slots).toHaveLength(2);
    expect((await fetchSimulatorAvailability(input, reader(event(), { spots_remaining: 0, available_times: [] }))).slots).toEqual([]);
  });
  it("does not mistake one bay reservation for a one-golfer capacity", async () => {
    const result = await fetchSimulatorAvailability(input, reader());
    expect(result.slots.every(slot => slot.maxPartySize === null)).toBe(true);
  });
  it.each([
    { date: "2026-10-14" }, { end_time: "10:30:00" }, { spots_remaining: 0 },
    { staff: [{ id: 5 }] }, { resources: [{ resource_id: 999, spots_remaining: 1 }] },
    { resources: [{ resource_id: 3859, spots_remaining: 2 }] },
    { resources: [{ resource_id: 3859, spots_remaining: 1 }, { resource_id: 3859, spots_remaining: 1 }] },
  ])("rejects ambiguous or changed inventory %j", async change => {
    await expect(fetchSimulatorAvailability(input, reader(event(), { ...inventory(), available_times: [{ ...row(), ...change }] }))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it.each([{ privacy: true }, { status: "draft" }, { id: 123 }, { exclusive_membership_ids: [1] },
    { schedules: [{ ...event().schedules[0], resource_usage_mode: "use_all" }] },
    { schedules: [{ ...event().schedules[0], duration: 1800 }] }])("rejects changed rental identity before inventory I/O %j", async change => {
    const fetch = reader({ ...event(), ...change });
    await expect(fetchSimulatorAvailability(input, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a wrong tenant or purchase route before network work", async () => {
    const fetch = reader();
    for (const offering of [{ ...input.offering, providerMetadata: { customerId: "999", eventId: "100948", resourceIds: ["3859"] } },
      { ...input.offering, bookingUrl: "https://app.upperhand.io/customers/1683-full-circle-golf/checkout" }]) {
      await expect(fetchSimulatorAvailability({ ...input, offering }, fetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
