// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fetchAcuitySimulatorAvailability, isAcuityPublicBookingUrl, projectAcuityPublicConfiguration } from "./acuity";
import { fetchSimulatorAvailability } from "./index";
import type { SimulatorAvailabilityInput } from "./types";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";
import { simulatorPublicConfigurationSchema } from "./public-configuration";

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

const aggregateUrl = "https://onegolfhaven.as.me/schedule/a66e63ac";
const aggregateInput: SimulatorAvailabilityInput = { ...input, durationMinutes: 60, partySize: 4,
  offering: { ...input.offering, bookingUrl: aggregateUrl, providerMetadata: { ownerKey: "a66e63ac", rentalProductIds: ["73234482"] },
    maxPartySize: null, supportedDurationsMinutes: [60] } };
function aggregateBusiness() {
  return { id: 34536426, name: "One Golf Haven", ownerKey: "a66e63ac", timezone: "America/New_York", includesAdminOnly: false,
    isExpired: false, description: "<p>Playing Costs are Per Bay: $50 per hour, per bay.</p>",
    calendars: { "": [{ id: 11388341, name: "One Golf Haven", timezone: "America/New_York" }] },
    appointmentTypes: { "": [{ id: 73234482, name: "Golf Time 1 HOUR", duration: 60, active: true, private: false,
      type: "service", classSize: null as number | null, canChooseQuantity: false, calendarIDs: [11388341] }] } };
}
function aggregateDays() {
  return { "2026-10-10": Array.from({ length: 11 }, (_, index) => ({ time: `2026-10-10T${String(index + 11).padStart(2, "0")}:00:00-0400`, slotsAvailable: 5 })),
    "2026-10-11": [], "2026-10-12": [], "2026-10-13": [] };
}

describe("Acuity public simulator availability", () => {
  it("uses the exact tenant calendar and witnessed four-day public mode for an opaque aggregate rental", async () => {
    const value = aggregateBusiness();
    const projected = projectAcuityPublicConfiguration(landing(value), aggregateUrl);
    expect(projected).toMatchObject({ family: "ACUITY", ownerKey: "a66e63ac", maxPartySize: null,
      rentals: [{ id: "73234482", durationMinutes: 60, calendarIds: ["11388341"], calendarKind: "OPAQUE_AGGREGATE" }],
      resources: [{ id: "11388341", timeZone: "America/New_York" }] });
    expect(JSON.stringify(projected)).not.toMatch(/One Golf Haven|Playing Costs|\$50|Golf Time/u);
    const fetchImpl = mockReads(aggregateDays(), landing(value));
    const result = await fetchAcuitySimulatorAvailability(aggregateInput, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(request.origin).toBe("https://onegolfhaven.as.me");
    expect(request.pathname).toBe("/api/scheduling/v1/availability/times");
    expect([...request.searchParams]).toEqual([["owner", "a66e63ac"], ["appointmentTypeId", "73234482"],
      ["calendarId", "11388341"], ["startDate", "2026-10-10"], ["maxDays", "4"], ["timezone", "America/New_York"]]);
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).has("Cookie")).toBe(false);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).has("Authorization")).toBe(false);
    expect(result.slots).toHaveLength(11);
    expect(new Set(result.slots.map(slot => slot.startsAt.toISOString())).size).toBe(11);
    expect(result.slots.every(slot => slot.resourceId === "ANY" && slot.maxPartySize === null &&
      slot.endsAt.getTime() - slot.startsAt.getTime() === 60 * 60_000)).toBe(true);
    const inWindow = filterSimulatorSessionsForSearch({ date: "2026-10-10", startTime: "09:00", endTime: "18:00",
      durationMinutes: 60, preferredOfferings: [{ offeringId: aggregateInput.offering.id }] },
    result.slots.map(slot => ({ ...slot, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() })), aggregateInput.timeZone);
    expect(inWindow).toHaveLength(7);
    expect(inWindow.at(-1)?.startsAt).toBe("2026-10-10T21:00:00.000Z");
    expect(inWindow).not.toContainEqual(expect.objectContaining({ startsAt: "2026-10-10T22:00:00.000Z" }));
  });
  it("accepts only bounded case and whitespace normalization of the exact venue calendar name", async () => {
    const value = aggregateBusiness(); value.calendars[""][0].name = "  ONE   GOLF HAVEN  ";
    value.appointmentTypes[""][0].name = "  GOLF   TIME  1   HOUR  ";
    expect(projectAcuityPublicConfiguration(landing(value), aggregateUrl)?.rentals[0].calendarKind).toBe("OPAQUE_AGGREGATE");
    expect((await fetchAcuitySimulatorAvailability(aggregateInput, mockReads(aggregateDays(), landing(value)))).slots).toHaveLength(11);
  });
  it("rejects contradictory typed aggregate markers while legacy Bay rows remain valid", () => {
    const projected = projectAcuityPublicConfiguration(landing(aggregateBusiness()), aggregateUrl);
    if (!projected) throw new Error("Missing synthetic aggregate projection.");
    expect(simulatorPublicConfigurationSchema.safeParse({ ...projected,
      rentals: [{ ...projected.rentals[0], durationMinutes: 90 }] }).success).toBe(false);
    expect(simulatorPublicConfigurationSchema.safeParse({ ...projected,
      rentals: [{ ...projected.rentals[0], calendarIds: ["11388341", "11402955"] }],
      resources: [...projected.resources, { id: "11402955", timeZone: projected.timeZone }] }).success).toBe(false);
    const named = projectAcuityPublicConfiguration(landing(business()), input.offering.bookingUrl);
    expect(named?.rentals[0]).not.toHaveProperty("calendarKind");
    expect(named?.rentals[0].calendarIds).toHaveLength(2);
  });
  it.each([
    ["missing per-bay context", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "Public hourly golf rentals."; }],
    ["missing hourly context", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "Playing Costs are Per Bay."; }],
    ["comment-only pricing", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "<p>Public golf.</p><!-- Playing Costs are Per Bay: per hour, per bay. -->"; }],
    ["script-only pricing", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "<p>Public golf.</p><script>Playing Costs are Per Bay: per hour, per bay.</script>"; }],
    ["style-only pricing", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "<p>Public golf.</p><style>Playing Costs are Per Bay: per hour, per bay.</style>"; }],
    ["split per-person pricing", (value: ReturnType<typeof aggregateBusiness>) => { value.description = "Playing Costs are Per Bay. Prices per hour per person. Storage costs per bay per day."; }],
    ["member-only context", (value: ReturnType<typeof aggregateBusiness>) => { value.description += " Members only."; }],
    ["lesson context", (value: ReturnType<typeof aggregateBusiness>) => { value.description += " Golf lessons."; }],
    ["blank business name", (value: ReturnType<typeof aggregateBusiness>) => { value.name = " "; }],
    ["truncated business name", (value: ReturnType<typeof aggregateBusiness>) => { value.name = "A".repeat(121); }],
    ["different calendar name", (value: ReturnType<typeof aggregateBusiness>) => { value.calendars[""][0].name = "One Golf Haven Annex"; }],
    ["different calendar timezone", (value: ReturnType<typeof aggregateBusiness>) => { value.calendars[""][0].timezone = "America/Chicago"; }],
    ["two linked calendars", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].calendarIDs = [11388341, 11388342]; }],
    ["duplicate linked calendars", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].calendarIDs = [11388341, 11388341]; }],
    ["duplicate calendar record", (value: ReturnType<typeof aggregateBusiness>) => { value.calendars[""].push({ ...value.calendars[""][0] }); }],
    ["name-duration mismatch", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].name = "Golf Time 2 HOUR"; }],
    ["lesson product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].name = "Golf Lesson 1 HOUR"; }],
    ["fitting product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].name = "Golf Fitting 1 HOUR"; }],
    ["league product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].name = "Golf League 1 HOUR"; }],
    ["member product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].name = "Member Golf Time 1 HOUR"; }],
    ["private product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].private = true; }],
    ["inactive product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].active = false; }],
    ["class product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].classSize = 6; }],
    ["quantity product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""][0].canChooseQuantity = true; }],
    ["ambiguous product", (value: ReturnType<typeof aggregateBusiness>) => { value.appointmentTypes[""].push({ ...value.appointmentTypes[""][0], id: 73234483 }); }],
    ["wrong owner", (value: ReturnType<typeof aggregateBusiness>) => { value.ownerKey = "other123"; }],
    ["wrong timezone", (value: ReturnType<typeof aggregateBusiness>) => { value.timezone = "America/Chicago"; }],
    ["expired scheduler", (value: ReturnType<typeof aggregateBusiness>) => { value.isExpired = true; }],
    ["admin-only scheduler", (value: ReturnType<typeof aggregateBusiness>) => { value.includesAdminOnly = true; }],
  ] as Array<[string, (value: ReturnType<typeof aggregateBusiness>) => void]>)
  ("rejects aggregate %s before the availability request and from public projection", async (_label, mutate) => {
    const value = aggregateBusiness(); mutate(value);
    expect(projectAcuityPublicConfiguration(landing(value), aggregateUrl)).toBeUndefined();
    const fetchImpl = mockReads(aggregateDays(), landing(value));
    await expect(fetchAcuitySimulatorAvailability(aggregateInput, fetchImpl)).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not read a tenant aggregate if the reviewed product ID is stale", async () => {
    const fetchImpl = mockReads(aggregateDays(), landing(aggregateBusiness()));
    await expect(fetchAcuitySimulatorAvailability({ ...aggregateInput, offering: { ...aggregateInput.offering,
      providerMetadata: { ownerKey: "a66e63ac", rentalProductIds: ["99999999"] } } }, fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["missing requested date", { "2026-10-11": [] }],
    ["null requested date", { "2026-10-10": null }],
    ["foreign fifth date", { ...aggregateDays(), "2026-10-14": [] }],
    ["malformed date key", { "2026-10-10": [], "2026-10-0x": [] }],
    ["adjacent mismatched local date", { "2026-10-10": [], "2026-10-11": [{ time: "2026-10-10T11:00:00-0400", slotsAvailable: 5 }] }],
    ["adjacent wrong timezone offset", { "2026-10-10": [], "2026-10-11": [{ time: "2026-10-11T11:00:00-0500", slotsAvailable: 5 }] }],
    ["adjacent negative count", { "2026-10-10": [], "2026-10-11": [{ time: "2026-10-11T11:00:00-0400", slotsAvailable: -1 }] }],
    ["selected string count", { "2026-10-10": [{ time: "2026-10-10T11:00:00-0400", slotsAvailable: "5" }] }],
    ["unrecognized row field", { "2026-10-10": [{ time: "2026-10-10T11:00:00-0400", slotsAvailable: 5, private: true }] }],
  ])("rejects aggregate %s", async (_label, payload) => {
    await expect(fetchAcuitySimulatorAvailability(aggregateInput, mockReads(payload, landing(aggregateBusiness()))))
      .rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it("deduplicates one opaque start and discards zero inventory without multiplying the public count", async () => {
    const time = "2026-10-10T11:00:00-0400";
    const payload = { "2026-10-10": [{ time, slotsAvailable: 5 }, { time, slotsAvailable: 5 },
      { time: "2026-10-10T12:00:00-0400", slotsAvailable: 0 }] };
    const result = await fetchAcuitySimulatorAvailability(aggregateInput, mockReads(payload, landing(aggregateBusiness())));
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ resourceId: "ANY", maxPartySize: null, productId: "73234482" });
    expect(result.slots[0]).not.toHaveProperty("availableSpots");
  });
  it("rejects a tenant calendar destination redirect without accepting its body", async () => {
    const redirected = new Response(JSON.stringify(aggregateDays()), { headers: { "content-type": "application/json" } });
    Object.defineProperty(redirected, "url", { value: "https://other.as.me/api/scheduling/v1/availability/times" });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(landing(aggregateBusiness()), { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(redirected);
    await expect(fetchAcuitySimulatorAvailability(aggregateInput, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
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
  it("accepts an exact public tenant scheduler while keeping the provider API and rental guards", async () => {
    const bookingUrl = "https://onegolfhaven.as.me/schedule/a66e63ac";
    const offering = { ...input.offering, bookingUrl, providerMetadata: { ownerKey: "a66e63ac", rentalProductIds: ["73234482", "73234480"] } };
    const value = business(); value.ownerKey = "a66e63ac";
    const fetchImpl = mockReads(undefined, landing(value));
    expect(isAcuityPublicBookingUrl(bookingUrl)).toBe(true);
    const result = await fetchAcuitySimulatorAvailability({ ...input, offering }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(bookingUrl);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).origin).toBe("https://app.acuityscheduling.com");
    expect(result.slots[0].bookingUrl).toBe(bookingUrl);
    value.appointmentTypes[""][1].name = "Golf Time 2 HOUR";
    await expect(fetchAcuitySimulatorAvailability({ ...input, offering }, mockReads(undefined, landing(value)))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
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
    "https://xgolfstratford.as.me/", "https://app.acuityscheduling.com.attacker.example/schedule/2991fba2", "http://app.acuityscheduling.com/schedule/2991fba2", "https://user:pass@app.acuityscheduling.com/schedule/2991fba2", "https://app.acuityscheduling.com/schedule.php?owner=34536426", "https://app.acuityscheduling.com/schedule/2991fba2?calendarId=11388341", "https://app.acuityscheduling.com/api/scheduling/v1/appointments", "https://app.acuityscheduling.com/schedule/2991fba2#reserve",
    "http://onegolfhaven.as.me/schedule/a66e63ac", "https://onegolfhaven.as.me.attacker.example/schedule/a66e63ac", "https://a.b.as.me/schedule/a66e63ac", "https://-bad.as.me/schedule/a66e63ac", "https://onegolfhaven.as.me/schedule/a66e63ac/", "https://onegolfhaven.as.me/schedule/a66e63ac?owner=other", "https://onegolfhaven.as.me/schedule/a66e63ac#book", "https://onegolfhaven.as.me/appointments"
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
