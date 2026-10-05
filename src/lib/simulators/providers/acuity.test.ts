// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fetchAcuitySimulatorAvailability, isAcuityPublicBookingUrl } from "./acuity";
import { fetchSimulatorAvailability } from "./index";
import type { SimulatorAvailabilityInput } from "./types";

const input: SimulatorAvailabilityInput = {
  offering: { id: "xgolf-offering", courseId: "xgolf", bookingUrl: "https://app.acuityscheduling.com/schedule/2991fba2", providerFamilyKey: "ACUITY", providerMetadata: { ownerKey: "2991fba2", rentalProductIds: ["73234482", "73234480"] }, maxPartySize: 6, supportedDurationsMinutes: [60, 120] },
  date: "2026-10-10", durationMinutes: 120, partySize: 6, timeZone: "America/New_York"
};
function business() {
  return { id: 34536426, ownerKey: "2991fba2", timezone: "America/New_York", includesAdminOnly: false, isExpired: false,
    description: "<p><strong>Up to 8 People Per Bay</strong></p>",
    calendars: { "X-Golf Stratford": [{ id: 11388341, name: " Bay 1", timezone: "America/New_York" }, { id: 11402955, name: "Bay 8 (Private)", timezone: "America/New_York" }], "": [{ id: "any", name: "Any available" }] },
    appointmentTypes: { "": [
      { id: 73234482, name: "Simulator Booking 1 HR", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341, 11402955], price: "0.00" },
      { id: 73234480, name: "Simulator Booking 2 HR", duration: 120, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341, 11402955], price: "0.00" },
      { id: 77657142, name: "FREE LEAGUE HANDICAP ROUND", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] }
    ] }
  };
}
function landing(value = business()) { return `<html><script>var BUSINESS = ${JSON.stringify(value)}; var CLIENT_INFO = {};</script></html>`; }
function mockReads(payload: unknown = { "2026-10-10": [{ time: "2026-10-10T08:00:00-0400", slotsAvailable: 1 }] }, html = landing()) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
}

describe("Acuity public simulator availability", () => {
  it("uses the published owner key and exact full-duration product with official pooled read", async () => {
    const fetchImpl = mockReads();
    const result = await fetchSimulatorAvailability(input, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(input.offering.bookingUrl);
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://app.acuityscheduling.com/api/scheduling/v1/availability/times?owner=2991fba2&calendarId=any&appointmentTypeId=73234480&startDate=2026-10-10&timezone=America%2FNew_York");
    for (const [, request] of fetchImpl.mock.calls) {
      expect(request).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
      expect(request?.body).toBeUndefined();
      expect(new Headers(request?.headers).has("Cookie")).toBe(false);
      expect(new Headers(request?.headers).has("Authorization")).toBe(false);
    }
    expect(result.slots).toEqual([{ sourceId: "acuity:xgolf-offering:73234480:2026-10-10T12:00:00.000Z", offeringId: "xgolf-offering", resourceId: "ANY", productId: "73234480", startsAt: new Date("2026-10-10T12:00:00Z"), endsAt: new Date("2026-10-10T14:00:00Z"), maxPartySize: 6, bookingUrl: input.offering.bookingUrl }]);
    expect(result.slots[0]).not.toHaveProperty("price");
    expect(result.slots[0]).not.toHaveProperty("availableSpots");
  });
  it("requests the independent one-hour product rather than joining shorter starts", async () => {
    const fetchImpl = mockReads();
    const result = await fetchAcuitySimulatorAvailability({ ...input, durationMinutes: 60 }, fetchImpl);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("appointmentTypeId")).toBe("73234482");
    expect(result.slots[0].endsAt.toISOString()).toBe("2026-10-10T13:00:00.000Z");
  });
  it("does not derive 90 minutes from an add-on or combine separate resource calendars", async () => {
    const fetchImpl = mockReads();
    await expect(fetchAcuitySimulatorAvailability({ ...input, durationMinutes: 90, offering: { ...input.offering, supportedDurationsMinutes: [90] } }, fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses the lower live capacity and keeps the saved conservative capacity", async () => {
    const value = business(); value.description = "Up to 4 Players Per Bay";
    const result = await fetchAcuitySimulatorAvailability({ ...input, partySize: 4 }, mockReads(undefined, landing(value)));
    expect(result.slots[0].maxPartySize).toBe(4);
    expect((await fetchAcuitySimulatorAvailability(input, mockReads(undefined, landing(value)))).slots[0].maxPartySize).toBe(4);
  });
  it.each([
    "https://xgolfstratford.as.me/", "https://app.acuityscheduling.com.attacker.example/schedule/2991fba2", "http://app.acuityscheduling.com/schedule/2991fba2", "https://user:pass@app.acuityscheduling.com/schedule/2991fba2", "https://app.acuityscheduling.com/schedule.php?owner=34536426", "https://app.acuityscheduling.com/schedule/2991fba2?calendarId=11388341", "https://app.acuityscheduling.com/api/scheduling/v1/appointments", "https://app.acuityscheduling.com/schedule/2991fba2#reserve"
  ])("rejects unsafe, legacy or wrong-tenant source before fetching: %s", async (bookingUrl) => {
    expect(isAcuityPublicBookingUrl(bookingUrl)).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchAcuitySimulatorAvailability({ ...input, offering: { ...input.offering, bookingUrl } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { ownerKey: "34536426", rentalProductIds: ["73234480"] }, { ownerKey: "2991fba2", rentalProductIds: [] }, { ownerKey: "2991fba2", rentalProductIds: ["73234480", "73234480"] }, { ownerKey: "2991fba2", rentalProductIds: ["https://other.example"] }
  ])("requires exact reviewed tenant and rental IDs", async (providerMetadata) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchAcuitySimulatorAvailability({ ...input, offering: { ...input.offering, providerMetadata } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["tenant", (value: ReturnType<typeof business>) => { value.ownerKey = "b43d0eea"; }],
    ["timezone", (value: ReturnType<typeof business>) => { value.timezone = "America/Chicago"; }],
    ["admin scheduler", (value: ReturnType<typeof business>) => { value.includesAdminOnly = true; }],
    ["paused scheduler", (value: ReturnType<typeof business>) => { value.isExpired = true; }],
    ["league product", (value: ReturnType<typeof business>) => { value.appointmentTypes[""][1].name = "Simulator League Booking"; }],
    ["unknown bay", (value: ReturnType<typeof business>) => { value.appointmentTypes[""][1].calendarIDs = [999]; }],
    ["lesson resource", (value: ReturnType<typeof business>) => { value.calendars["X-Golf Stratford"][1].name = "Lesson Room"; }],
    ["resource timezone", (value: ReturnType<typeof business>) => { value.calendars["X-Golf Stratford"][1].timezone = "America/Chicago"; }]
  ])("rejects changed public %s before the availability request", async (_label, mutate) => {
    const value = business(); mutate(value);
    const fetchImpl = mockReads(undefined, landing(value));
    await expect(fetchAcuitySimulatorAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("keeps a public bay session when group capacity is unknown", async () => {
    const value = business(); value.description = "Book your bay";
    const result = await fetchAcuitySimulatorAvailability({ ...input, offering: { ...input.offering, maxPartySize: null } }, mockReads(undefined, landing(value)));
    expect(result.slots[0].maxPartySize).toBeNull();
  });
  it.each(["private", "inactive", "class"])('rejects a reviewed rental that becomes %s', async (kind) => {
    const value = business();
    if (kind === "private") value.appointmentTypes[""][1].private = true;
    if (kind === "inactive") value.appointmentTypes[""][1].active = false;
    if (kind === "class") value.appointmentTypes[""][1].type = "class";
    await expect(fetchAcuitySimulatorAvailability(input, mockReads(undefined, landing(value)))).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
  });
  it("rejects duplicate matching duration products rather than choosing a lesson or alternate rental", async () => {
    const value = business(); value.appointmentTypes[""][0].duration = 120;
    await expect(fetchAcuitySimulatorAvailability(input, mockReads(undefined, landing(value)))).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
  });
  it.each([{}, { "2026-10-10": [] }, { "2026-10-10": [{ time: "2026-10-10T08:00:00-0400", slotsAvailable: 0 }] }])("accepts a bounded complete empty observation", async (payload) => {
    expect((await fetchAcuitySimulatorAvailability(input, mockReads(payload))).slots).toEqual([]);
  });
  it.each([
    { "2026-10-11": [] }, { "2026-10-10": null }, { "2026-10-10": [{ time: "2026-10-10T08:00:00-0500", slotsAvailable: 1 }] }, { "2026-10-10": [{ time: "2026-10-10T08:00:00+99:99", slotsAvailable: 1 }] }, { "2026-10-10": [{ time: "2026-10-10T08:00:00-0400", slotsAvailable: -1 }] }, { times: [] }
  ])("rejects foreign dates, invalid offsets and changed response shapes", async (payload) => {
    await expect(fetchAcuitySimulatorAvailability(input, mockReads(payload))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it("parses inert public JSON and never evaluates script assignments", async () => {
    const fetchImpl = mockReads(undefined, "<script>var BUSINESS = (() => { throw new Error('must not execute') })();</script>");
    await expect(fetchAcuitySimulatorAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 302, 429])("preserves observed HTTP %s without guessing membership/account access", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("provider-body", { status }));
    await expect(fetchAcuitySimulatorAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", httpStatus: status, retryable: status === 429 });
  });
  it("sanitizes public transport failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport detail"));
    await expect(fetchAcuitySimulatorAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", message: "The public simulator calendar could not be reached", retryable: true });
  });
});
