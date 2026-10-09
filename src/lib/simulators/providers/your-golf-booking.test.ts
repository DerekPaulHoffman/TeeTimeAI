// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSimulatorAvailability } from "./index";
import { buildSlots, fetchYourGolfBookingAvailability, isYourGolfBookingPublicBookingUrl } from "./your-golf-booking";
import type { SimulatorAvailabilityInput } from "./types";

const input: SimulatorAvailabilityInput = {
  offering: { id: "oasis-offering", courseId: "oasis", bookingUrl: "https://booking.trackmangolf.com/venues/golf-oasis/booking", providerFamilyKey: "YOUR_GOLF_BOOKING", providerMetadata: { venueSlug: "golf-oasis", venueId: "1357", rangeId: "1397", publicOptionId: "21451" }, maxPartySize: null, supportedDurationsMinutes: [60, 90, 120] },
  date: "2026-10-10", durationMinutes: 60, partySize: 2, timeZone: "America/New_York"
};
const openingHours = "Mo off;Tu off;We 17:00-22:00 open;Th 17:00-22:00 open;Fr 16:00-22:00 open;Sa 16:00-22:00 open;Su 10:00-18:00 open;2025 Oct 14 00:00-23:59 open";
function config(patch: Record<string, unknown> = {}, optionPatch: Record<string, unknown> = {}) {
  const state = { venue: { id: 1357, slug: "golf-oasis", timezone: "America/New_York", status: "live", maintenanceMode: false }, ranges: { items: [{ id: 1397, slug: "bays", venue: 1357, bookable: true, slotDuration: 30, slotInterval: 30, slotIntervalStart: 0, assumeOpen: true, bookingUi: "standard", customerBookingUi: "slots", maxBookAheadValue: 2, maxBookAheadUnit: "week", openingTimes: [], openingHours, ...patch }] }, bays: { items: [9224, 9225, 9226, 9227, 9228].map(id => ({ id, venue: 1357, range: 1397, type: "simulator", bookable: true, restrictedTimes: [], options: [21451], appliedOptions: [21451] })), bayOptions: [{ id: 21451, name: "Public Rate", venue: 1357, adminOnly: false, disabled: false, waitlisted: false, type: "simulator", category: "baytime", duration: 1, durationType: "slot", bufferPeriodMinutes: 0, appliedRequiredPerks: [], restrictions: [], minBookingDuration: 1, maxBookingDuration: 8, minPlayers: 1, maxPlayers: 4, ...optionPatch }] } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialReduxState: state } } })}</script></html>`;
}
const booking = (bayId: number, start: string, end: string, bayOptionId = 21451) => ({ id: 25519452 + bayId, start, end, status: "confirmed", type: "bay", playerOptions: [], bayId, bayRef: String(bayId - 9223), bayOptionId, rangeId: 1397 });
function responses(payload: unknown = [], html = config()) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).mockResolvedValueOnce(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
  return fetchImpl;
}

describe("YourGolfBooking public simulator calendar", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-06T16:00:00.000Z")); });
  afterEach(() => vi.useRealTimers());
  it("reads only the fixed signed-out configuration and occupancy sources, then produces full same-bay sessions", async () => {
    const fetchImpl = responses();
    const result = await fetchSimulatorAvailability(input, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://booking.trackmangolf.com/venues/golf-oasis/booking/bays");
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-09T04%3A00%3A00.000Z&start_lte=2026-10-10T23%3A59%3A59-04%3A00");
    for (const [, request] of fetchImpl.mock.calls) {
      expect(request).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect(request?.body).toBeUndefined();
      expect(new Headers(request?.headers).has("Cookie")).toBe(false);
    }
    expect(result).toMatchObject({ complete: true });
    expect(result.slots).toHaveLength(55);
    expect(result.slots.filter(slot => slot.startsAt.toISOString() === "2026-10-10T20:00:00.000Z")).toHaveLength(5);
    expect(result.slots[0]).toMatchObject({ resourceId: "9224", productId: "21451", maxPartySize: 4, bookingUrl: input.offering.bookingUrl });
  });

  it("blocks a member booking on its named bay and every overlapping full interval", () => {
    const occupied = [booking(9226, "2026-10-10T21:00:00.000Z", "2026-10-10T22:00:00.000Z"), booking(9225, "2026-10-10T22:30:00.000Z", "2026-10-11T00:30:00.000Z", 22797)];
    const slots = buildSlots(input, ["9224", "9225", "9226", "9227", "9228"], 21451, 1397, 1357, 4, [[960, 1320]], occupied);
    expect(slots.some(slot => slot.resourceId === "9226" && slot.startsAt.toISOString() === "2026-10-10T20:30:00.000Z")).toBe(false);
    expect(slots.some(slot => slot.resourceId === "9225" && slot.startsAt.toISOString() === "2026-10-10T22:00:00.000Z")).toBe(false);
    expect(slots.some(slot => slot.resourceId === "9224" && slot.startsAt.toISOString() === "2026-10-10T22:00:00.000Z")).toBe(true);
  });
  it("supports reviewed public slot rentals with observed nulls and only their exact linked resources", async () => {
    const selected = { ...input, offering: { ...input.offering,
      bookingUrl: "https://yourgolfbooking.com/venues/golf-oasis/booking/bays",
      providerMetadata: { ...input.offering.providerMetadata as object, rentalContract: "PUBLIC_SLOT_V1",
        category: null, maintenanceMode: null, bookingWindowDaysAhead: 13, resourceIds: ["9224", "9225"] } } };
    const html = config({ bookingUi: "custom", maxBookAheadValue: 13, maxBookAheadUnit: "day" },
      { name: "Standard simulator", category: null, minBookingDuration: 2, maxBookingDuration: 10 })
      .replace('"maintenanceMode":false', '"maintenanceMode":null')
      .replace('"id":9226,"venue":1357,"range":1397,"type":"simulator","bookable":true,"restrictedTimes":[],"options":[21451],"appliedOptions":[21451]',
        '"id":9226,"venue":1357,"range":1397,"type":"simulator","bookable":true,"restrictedTimes":[],"options":[777],"appliedOptions":[777]');
    const fetchImpl = responses([booking(9226, "2026-10-10T21:00:00Z", "2026-10-10T22:00:00Z", 777)], html);
    const result = await fetchYourGolfBookingAvailability(selected, fetchImpl);
    expect(result.complete).toBe(true);
    expect(new Set(result.slots.map(slot => slot.resourceId))).toEqual(new Set(["9224", "9225"]));
    expect(result.slots).toHaveLength(22);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(selected.offering.bookingUrl);
  });
  it.each([undefined, true, "false"])("does not normalize an unreviewed maintenance value %j", async maintenanceMode => {
    const selected = { ...input, offering: { ...input.offering, providerMetadata: {
      ...input.offering.providerMetadata as object, rentalContract: "PUBLIC_SLOT_V1", category: null,
      maintenanceMode: null, bookingWindowDaysAhead: 13, resourceIds: ["9224"] } } };
    const html = config({ maxBookAheadValue: 13, maxBookAheadUnit: "day" }, { category: null })
      .replace('"maintenanceMode":false', `"maintenanceMode":${JSON.stringify(maintenanceMode ?? "missing")}`);
    const fetchImpl = responses([], html);
    await expect(fetchYourGolfBookingAvailability(selected, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["restricted-tail", "missing-link", "duplicate-id", "wrong-range", "unknown-category", "missing-category"])("validates every selected runtime resource and source value: %s", async change => {
    const state = JSON.parse(config().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const published = state.props.pageProps.initialReduxState;
    published.venue.maintenanceMode = null;
    Object.assign(published.ranges.items[0], { maxBookAheadValue: 13, maxBookAheadUnit: "day", bookingUi: "custom" });
    published.bays.bayOptions[0].category = null;
    const resources = published.bays.items;
    for (let index = 0; index < 6; index++) resources.push({ ...resources[0], id: 9300 + index });
    const resourceIds = resources.map((row: { id: number }) => String(row.id));
    const tail = resources[10];
    if (change === "restricted-tail") tail.restrictedTimes = [{}];
    if (change === "missing-link") tail.appliedOptions = [];
    if (change === "duplicate-id") tail.id = resources[0].id;
    if (change === "wrong-range") tail.range = 9999;
    if (change === "unknown-category") published.bays.bayOptions[0].category = "members";
    if (change === "missing-category") delete published.bays.bayOptions[0].category;
    const selected = { ...input, offering: { ...input.offering, providerMetadata: {
      ...input.offering.providerMetadata as object, rentalContract: "PUBLIC_SLOT_V1", category: null,
      maintenanceMode: null, bookingWindowDaysAhead: 13, resourceIds } } };
    const fetchImpl = responses([], `<script id="__NEXT_DATA__">${JSON.stringify(state)}</script>`);
    await expect(fetchYourGolfBookingAvailability(selected, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("requires all cells of a 90-minute session on one bay", () => {
    const ninety = { ...input, durationMinutes: 90 };
    const occupied = [booking(9224, "2026-10-10T21:00:00.000Z", "2026-10-10T21:30:00.000Z")];
    const slots = buildSlots(ninety, ["9224", "9225"], 21451, 1397, 1357, null, [[960, 1320]], occupied);
    expect(slots.some(slot => slot.resourceId === "9224" && slot.startsAt.toISOString() === "2026-10-10T20:00:00.000Z")).toBe(false);
    expect(slots.some(slot => slot.resourceId === "9225" && slot.startsAt.toISOString() === "2026-10-10T20:00:00.000Z")).toBe(true);
    expect(slots[0].maxPartySize).toBeNull();
  });

  it.each([
    ["unreviewed venue", { venueId: "9999" }],
    ["unreviewed option", { publicOptionId: "9999" }],
    ["unreviewed range", { rangeId: "9999" }]
  ])("fails closed for %s", async (_name, metadata) => {
    await expect(fetchYourGolfBookingAvailability({ ...input, offering: { ...input.offering, providerMetadata: { ...input.offering.providerMetadata as object, ...metadata } } }, responses())).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it.each([
    ["unknown hours", { openingHours: "Saturday 4pm to 10pm" }],
    ["restricted range", { openingTimes: [{ start: "16:00" }] }],
    ["nonzero interval offset", { slotIntervalStart: 15 }],
    ["hours off the published slot grid", { openingHours: openingHours.replace("Sa 16:00-22:00 open", "Sa 16:15-22:00 open") }],
    ["unbookable range", { bookable: false }]
  ])("fails closed for %s", async (_name, patch) => {
    await expect(fetchYourGolfBookingAvailability(input, responses([], config(patch)))).rejects.toThrow();
  });
  it.each([{ maxBookAheadValue: 3 }, { maxBookAheadUnit: "month" }])("rejects changed booking horizon %j", async patch => {
    await expect(fetchYourGolfBookingAvailability(input, responses([], config(patch)))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("fails closed when the public rental gains a restriction or buffer", async () => {
    await expect(fetchYourGolfBookingAvailability(input, responses([], config({}, { restrictions: [{ kind: "members" }] })))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(fetchYourGolfBookingAvailability(input, responses([], config({}, { bufferPeriodMinutes: 15 })))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
  it("preserves unknown group capacity while reporting public bay intervals", async () => {
    const result = await fetchYourGolfBookingAvailability({ ...input, partySize: 8 }, responses([], config({}, { maxPlayers: null, minPlayers: null })));
    expect(result.slots).toHaveLength(55);
    expect(result.slots[0].maxPartySize).toBeNull();
  });
  it("rejects a request outside the current venue-local two-week booking window before occupancy", async () => {
    const fetchImpl = responses();
    await expect(fetchYourGolfBookingAvailability({ ...input, date: "2026-10-21" }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses each side of the venue DST change for the anonymous occupancy date bounds", async () => {
    vi.setSystemTime(new Date("2026-10-25T16:00:00.000Z"));
    const fetchImpl = responses();
    await fetchYourGolfBookingAvailability({ ...input, date: "2026-11-01" }, fetchImpl);
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.searchParams.get("start_gte")).toBe("2026-10-31T04:00:00.000Z");
    expect(url.searchParams.get("start_lte")).toBe("2026-11-01T23:59:59-05:00");
  });
  it("rejects unrecognized occupancy instead of claiming free space", () => {
    expect(() => buildSlots(input, ["9224"], 21451, 1397, 1357, 4, [[960, 1320]], [{ ...booking(9224, "2026-10-10T21:00:00Z", "2026-10-10T22:00:00Z"), status: "mystery" }])).toThrow();
  });
  it("includes previous-day member bookings that overlap the requested day", async () => {
    const occupied = [booking(9225, "2026-10-10T01:00:00Z", "2026-10-10T21:00:00Z", 22797)];
    const fetchImpl = responses(occupied);
    const result = await fetchYourGolfBookingAvailability(input, fetchImpl);
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(new Date(url.searchParams.get("start_gte")!).getTime()).toBeLessThan(new Date(occupied[0].start).getTime());
    expect(result.slots.some(slot => slot.resourceId === "9225" && slot.startsAt.toISOString() === "2026-10-10T20:00:00.000Z")).toBe(false);
    expect(result.slots.some(slot => slot.resourceId === "9224" && slot.startsAt.toISOString() === "2026-10-10T20:00:00.000Z")).toBe(true);
    expect(result.slots.some(slot => slot.resourceId === "9225" && slot.startsAt.toISOString() === "2026-10-10T21:00:00.000Z")).toBe(true);
  });
  it.each([
    ["2026-11-01", 60],
    ["2026-03-08", 120]
  ])("rejects ambiguous or nonexistent venue time on %s", (date, minute) => {
    expect(() => buildSlots({ ...input, date }, ["9224"], 21451, 1397, 1357, 4, [[minute, minute + 120]], [])).toThrow();
  });
  it("keeps a complete empty observation when the published range is closed", async () => {
    const result = await fetchYourGolfBookingAvailability(input, responses([], config({ openingHours: openingHours.replace("Sa 16:00-22:00 open", "Sa off") })));
    expect(result.slots).toEqual([]);
  });
  it.each(["http://booking.trackmangolf.com/venues/golf-oasis/booking", "https://booking.trackmangolf.com.attacker.example/venues/golf-oasis/booking", "https://booking.trackmangolf.com/venues/golf-oasis/checkout", "https://booking.trackmangolf.com/venues/golf-oasis/booking?session=x", "https://user:secret@booking.trackmangolf.com/venues/golf-oasis/booking"]) ("rejects unsafe source %s before fetching", async bookingUrl => {
    expect(isYourGolfBookingPublicBookingUrl(bookingUrl)).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchYourGolfBookingAvailability({ ...input, offering: { ...input.offering, bookingUrl } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([302, 403, 429, 500])("classifies HTTP %s without parsing a response body", async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-body", { status, headers: { "Content-Type": "text/html", "Retry-After": "60" } }));
    await expect(fetchYourGolfBookingAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", httpStatus: status, retryable: status === 429 || status === 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong content type and an oversized public response", async () => {
    const wrongType = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    await expect(fetchYourGolfBookingAvailability(input, wrongType)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    const oversize = vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { headers: { "Content-Type": "text/html", "Content-Length": "1500001" } }));
    await expect(fetchYourGolfBookingAvailability(input, oversize)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it("rejects malformed occupancy JSON after the verified public configuration", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(config(), { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(new Response("{bad", { headers: { "Content-Type": "application/json" } }));
    await expect(fetchYourGolfBookingAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
});
