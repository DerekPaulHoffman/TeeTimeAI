// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GOLFVX_ORIGIN, golfVxEnvelopeRows, golfVxMetadataSchema, golfVxRoomScopes, parseGolfVxConfiguration, parseGolfVxSource } from "./golfvx-source";

const storeId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const source = { officialUrl: "https://examplegolf.org/", bookingUrl: `${GOLFVX_ORIGIN}/book/${storeId}`,
  venueName: "Golf VX Example City", venueAddress: "123 Fairway Drive, Example City, GA 30000, USA", timeZone: "America/New_York" };
const envelope = (rows: unknown[]) => ({ code: 0, msg: "", output: {}, affected: -1, dataset: [rows], timestamp: "2026-10-21T18:39:22Z" });
function store() { return { store_id: storeId, store_name: source.venueName, industry_code: "GOLF", currency: "USD", timezone: source.timeZone,
  booking_period_days: 7, operating_hours: JSON.stringify(Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index, { open: "08:00", close: "24:00" }]))),
  slot_duration_minutes: 30, default_break_times: null }; }
function rental() { return { id: 101, store_id: storeId, name: "Bay rental", product_type: "TIMED", booking_type: "PURCHASE", duration_minutes: 5,
  resource_type: "SCREEN_GOLF", secondary_resource_type: null, min_party_size: 1, max_party_size: 4, available_online: 1, status: "ACTIVE",
  sale_start_date: null, sale_end_date: null, metadata: null, plan_id: null, grant_type: null, tier_code: null, external_ref_id: null,
  total_count: null, total_minutes: null, period_minutes: null, period_unit: null, validity_period_value: null, validity_period_unit: null,
  billing_interval: null, plan_name: null, plan_subtitle: null }; }
function rooms() { return { has_unassigned: 1, room_types: [{ code: "private", name: "Private Room", surcharge: 0, confirm_policy: "INSTANT" }] }; }
const parse = (stores = [store()], products = [rental()], room = rooms(), identity = source) =>
  parseGolfVxConfiguration(envelope(stores), envelope(products), envelope([room]), identity);

describe("GolfVX exact public source and immutable configuration", () => {
  it("binds canonical observed UUID, whole venue and zone, retaining address as controller context", () => {
    const result = parse();
    expect(parseGolfVxSource(source.bookingUrl)).toEqual({ bookingUrl: source.bookingUrl, storeId });
    expect(result).toMatchObject({ family: "GOLFVX", storeId, timeZone: source.timeZone, products: [{ durationMinutes: 5, maxPartySize: 4 }] });
    expect(result.identity).toEqual({ officialUrl: source.officialUrl, venueName: source.venueName, venueAddress: source.venueAddress });
    expect(golfVxRoomScopes(result)).toEqual(["BASE", "private"]);
    expect(result.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(golfVxMetadataSchema.parse(result)).toEqual(result);
  });
  it.each([
    `http://booking.golfvx.net/book/${storeId}`, `https://booking.golfvx.net:444/book/${storeId}`,
    `https://user@booking.golfvx.net/book/${storeId}`, `https://evil.example.org/book/${storeId}`,
    `https://booking.golfvx.net/book/${storeId}?token=a`, `https://booking.golfvx.net/book/${storeId}#x`,
    `https://booking.golfvx.net/book/${storeId}/checkout`, `https://booking.golfvx.net/api/v1/billing/guest/booking/stores`,
    `https://127.0.0.1/book/${storeId}`, `https://booking.golfvx.net/book/not-a-uuid`,
    `https://booking.golfvx.net/book/%31${storeId.slice(1)}`, `https://booking.golfvx.net/book/${storeId}/`,
  ])("rejects noncanonical or nonpublic recipe source %s", value => expect(parseGolfVxSource(value)).toBeUndefined());
  it("never substitutes another same-name store for the observed UUID", () => {
    expect(() => parse([{ ...store(), store_id: otherId }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parse([store(), { ...store(), store_id: otherId, store_name: "Other Golf VX City" }])).not.toThrow();
    expect(() => parse([store(), store()])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("accepts whole-name case/punctuation/brand spacing, without losing location tokens", () => {
    expect(parse([{ ...store(), store_name: "GolfVX Example-City" }]).store.name).toBe("GolfVX Example-City");
    expect(() => parse([{ ...store(), store_name: "GolfVX Another-City" }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["Golf VX Other City", "Example City", "Golf VX Example City Annex"])("rejects different whole venue %s", name => {
    expect(() => parse([{ ...store(), store_name: name }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("requires exact timezone, controller address context and safe official source", () => {
    expect(() => parse([{ ...store(), timezone: "America/Chicago" }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parse(undefined, undefined, undefined, { ...source, venueAddress: "" })).toThrow("ADAPTER_IDENTITY_MISSING");
    expect(() => parse(undefined, undefined, undefined, { ...source, officialUrl: "https://127.0.0.1/" })).toThrow("ADAPTER_IDENTITY_MISSING");
  });
  it("validates every returned store and bounded operating hours", () => {
    expect(() => parse([store(), { ...store(), store_id: "bad" }])).toThrow();
    expect(() => parse([{ ...store(), operating_hours: "{}" }])).toThrow();
    expect(() => parse([{ ...store(), default_break_times: "12:00" as never }])).toThrow();
  });
  it.each(["Golf Lesson", "Simulator Party", "Membership", "Bay rental with coaching"])("rejects ambiguous non-rental product %s", name => {
    expect(() => parse(undefined, [{ ...rental(), name }])).toThrow();
  });
  it.each(["plan_id", "grant_type", "tier_code", "external_ref_id", "total_count", "total_minutes", "period_minutes", "period_unit",
    "validity_period_value", "validity_period_unit", "billing_interval", "plan_name", "plan_subtitle"])("rejects unproved entitlement field %s", field => {
    expect(() => parse(undefined, [{ ...rental(), [field]: "unproved" }])).toThrow();
  });
  it("rejects foreign/duplicate products, scheduled sales and unknown nested semantics", () => {
    expect(() => parse(undefined, [{ ...rental(), store_id: otherId }])).toThrow();
    expect(() => parse(undefined, [rental(), rental()])).toThrow();
    expect(() => parse(undefined, [{ ...rental(), sale_start_date: "2026-10-01" as never }])).toThrow();
    expect(() => parse(undefined, [{ ...rental(), metadata: {} as never }])).toThrow();
  });
  it("retains all products/room scopes and hashes semantic configuration changes", () => {
    const baseline = parse();
    const current = parse(undefined, [rental(), { ...rental(), id: 102, duration_minutes: 15 }]);
    expect(current.products).toHaveLength(2); expect(current.catalogHash).not.toBe(baseline.catalogHash);
    expect(parse(undefined, undefined, { has_unassigned: 0, room_types: rooms().room_types }).catalogHash).not.toBe(baseline.catalogHash);
  });
  it("rejects duplicate/unsafe/empty room scopes and unproved confirmation policy", () => {
    expect(() => parse(undefined, undefined, { ...rooms(), room_types: [...rooms().room_types, ...rooms().room_types] })).toThrow();
    expect(() => parse(undefined, undefined, { ...rooms(), room_types: [{ ...rooms().room_types[0], code: "../member" }] })).toThrow();
    expect(() => parse(undefined, undefined, { has_unassigned: 0, room_types: [] })).toThrow();
    expect(() => parse(undefined, undefined, { ...rooms(), room_types: [{ ...rooms().room_types[0], confirm_policy: "APPROVAL" }] })).toThrow();
  });
  it("rejects nonzero, partial, extra-dataset and raw-array envelopes", () => {
    for (const value of [[], { ...envelope([]), code: 1 }, { ...envelope([]), dataset: [[], []] }, { ...envelope([]), next: "cursor" }])
      expect(() => golfVxEnvelopeRows(value)).toThrow("ADAPTER_RESPONSE_INVALID");
  });
});
