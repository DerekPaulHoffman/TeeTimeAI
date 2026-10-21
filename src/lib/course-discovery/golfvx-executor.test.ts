// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeGolfVx, inspectGolfVx, normalizeGolfVxAvailability } from "./golfvx-executor";
import { GOLFVX_GUEST_ROOT, GOLFVX_ORIGIN, parseGolfVxConfiguration } from "./golfvx-source";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { executeAccessRecipe, venueProofMatches } from "./executor";
import { parseAccessRecipe } from "./recipe";

const storeId = "11111111-1111-4111-8111-111111111111";
const source = { officialUrl: "https://examplegolf.org/", bookingUrl: `${GOLFVX_ORIGIN}/book/${storeId}`,
  venueName: "Golf VX Example City", venueAddress: "123 Fairway Drive, Example City, GA 30000, USA", timeZone: "America/New_York" };
const input = { date: "2026-10-23", timeZone: source.timeZone, players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const target = { courseId: "course", offeringId: "simulator" };
const envelope = (rows: unknown[]) => ({ code: 0, msg: "", output: {}, affected: -1, dataset: [rows], timestamp: "2026-10-21T18:39:22Z" });
function store() { return { store_id: storeId, store_name: source.venueName, industry_code: "GOLF", currency: "USD", timezone: source.timeZone,
  booking_period_days: 7, operating_hours: JSON.stringify(Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index, { open: "08:00", close: "24:00" }]))),
  slot_duration_minutes: 30, default_break_times: null }; }
function rental(id = 101, base = 5) { return { id, store_id: storeId, name: "Bay rental", product_type: "TIMED", booking_type: "PURCHASE", duration_minutes: base,
  resource_type: "SCREEN_GOLF", secondary_resource_type: null, min_party_size: 1, max_party_size: 4, available_online: 1, status: "ACTIVE",
  sale_start_date: null, sale_end_date: null, metadata: null, plan_id: null, grant_type: null, tier_code: null, external_ref_id: null,
  total_count: null, total_minutes: null, period_minutes: null, period_unit: null, validity_period_value: null, validity_period_unit: null,
  billing_interval: null, plan_name: null, plan_subtitle: null }; }
function membership(id = 201) { return { ...rental(), id, name: "Practice Membership", product_type: "PASS", duration_minutes: null,
  resource_type: null, min_party_size: null, max_party_size: null, plan_id: 31, billing_interval: "monthly", base_price: 99,
  plan_name: "Practice Membership", sale_start_date: "2026-10-21 00:00:00", metadata: { membership: { pricing: { monthly: { enabled: true, price: 99 } } } } }; }
const rooms = () => ({ has_unassigned: 1, room_types: [{ code: "private", name: "Private Room", surcharge: 0, confirm_policy: "INSTANT" }] });
function availability() { return { slot_minutes: 15, min_booking_minutes: 60, max_booking_minutes: null, max_party_size: 6, store_timezone: source.timeZone,
  store_now: "2026-10-21T14:39:22-04:00", business_date: "2026-10-21", booking_start_date: "2026-10-21", booking_end_date: "2026-10-27", reason: null,
  slots: Array.from({ length: 64 }, (_, index) => { const minute = 480 + index * 15, remaining = 1440 - minute;
    return { start: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, available: remaining >= 60,
      max_available_minutes: remaining, bays: 9, bays_for_full: remaining >= 60 ? 9 : 0, zone: "OFFPEAK", is_peak: false }; }) }; }
const metadata = () => parseGolfVxConfiguration(envelope([store()]), envelope([rental()]), envelope([rooms()]), source);
type Options = { products?: unknown[]; stores?: ReturnType<typeof store>[]; room?: ReturnType<typeof rooms>;
  availability?: (url: URL) => unknown; transform?: (url: URL, response: Response) => Response };
function dependencies(options: Options = {}) {
  const reads: URL[] = [], inits: RequestInit[] = [], families: string[] = []; let active = 0, maximum = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = new URL(String(value)); reads.push(url); inits.push(init ?? {});
    let body: unknown;
    if (url.href === `${GOLFVX_GUEST_ROOT}/stores`) body = envelope(options.stores ?? [store()]);
    else if (url.href === `${GOLFVX_GUEST_ROOT}/stores/${storeId}/products`) body = envelope(options.products ?? [rental()]);
    else if (url.href === `${GOLFVX_GUEST_ROOT}/room-types?store_id=${storeId}`) body = envelope([options.room ?? rooms()]);
    else if (url.pathname === "/api/v1/billing/guest/booking/availability") body = options.availability?.(url) ?? envelope([availability()]);
    else throw new Error("UNEXPECTED_REQUEST");
    const response = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    return options.transform?.(url, response) ?? response;
  });
  return { fetch, reads, inits, families, now: () => new Date("2026-10-21T18:39:20Z"), maximum: () => maximum,
    requestLease: async <T>(family: string, work: () => Promise<T>) => { families.push(family); active++; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; } } };
}
const execute = (deps = dependencies(), requested = input, saved = metadata()) => executeGolfVx(source, saved, target, requested, deps);

describe("GolfVX fixed public all-product/all-room reader", () => {
  it("inspects using only the three fixed public GETs", async () => {
    const deps = dependencies(); expect(await inspectGolfVx(source, deps)).toEqual(metadata()); expect(deps.reads).toHaveLength(3);
    expect(deps.families).toEqual(Array(3).fill("booking.golfvx.net")); expect(deps.maximum()).toBe(1);
  });
  it("reads both resource scopes and all matching rows without turning bay counts into golfers", async () => {
    const deps = dependencies(), slots = await execute(deps);
    expect(slots).toHaveLength(74); expect(new Set(slots.map(value => value.sourceId)).size).toBe(74);
    expect(new Set(slots.map(value => value.resourceId))).toHaveLength(2);
    expect(slots.every(value => value.availableSpots === 1 && value.capacity === 4)).toBe(true);
    expect(slots[0].startsAt).toBe("2026-10-23T14:00:00.000Z"); expect(slots.at(-1)?.startsAt).toBe("2026-10-23T23:00:00.000Z");
    expect(deps.reads.slice(3).map(value => value.searchParams.get("room_type"))).toEqual(["BASE", "private"]);
    for (const [index, url] of deps.reads.entries()) {
      const init = deps.inits[index]; expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
      expect(init.body).toBeUndefined(); expect(Object.keys(init.headers!)).toEqual(["accept", "user-agent"]);
      expect(url.origin).toBe(GOLFVX_ORIGIN); expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith("/availability")) {
        expect([...url.searchParams.keys()]).toEqual(["store_id", "date", "duration_minutes", "start_interval_minutes", "product_id", "room_type"]);
        expect(url.searchParams.get("date")).toBe(input.date); expect(url.searchParams.get("duration_minutes")).toBe("60");
        expect(url.searchParams.get("start_interval_minutes")).toBe("15"); expect(url.searchParams.has("players")).toBe(false);
      }
    }
  });
  it("revalidates complete catalog then executes every eligible product × room", async () => {
    const products = [rental(), rental(102, 15)], saved = parseGolfVxConfiguration(envelope([store()]), envelope(products), envelope([rooms()]), source);
    const deps = dependencies({ products }); const slots = await execute(deps, input, saved);
    expect(deps.reads).toHaveLength(7); expect(slots).toHaveLength(148); expect(new Set(slots.map(value => value.productId))).toHaveLength(2);
  });
  it("reuses the identical saved rental method after membership passes are added or repriced, without membership reads", async () => {
    const deps = dependencies({ products: [membership(), rental(), { ...membership(202), base_price: 299, plan_id: 32 }] });
    expect(await inspectGolfVx(source, deps)).toEqual(metadata());
    const slots = await execute(deps);
    expect(slots).toHaveLength(74); expect(new Set(slots.map(slot => slot.productId))).toEqual(new Set(["golfvx-product:101"]));
    expect(deps.reads.filter(url => url.pathname.endsWith("/availability"))).toHaveLength(2);
    expect(deps.reads.filter(url => url.pathname.endsWith("/availability")).every(url => url.searchParams.get("product_id") === "101")).toBe(true);
    expect(deps.reads.every(url => !/member|plan|quote|create|hold|payment/u.test(url.pathname))).toBe(true);
  });
  it("keeps every rental × room in scope when unrelated passes are present", async () => {
    const products = [membership(), rental(), rental(102, 15)];
    const saved = parseGolfVxConfiguration(envelope([store()]), envelope(products), envelope([rooms()]), source);
    const deps = dependencies({ products }); expect(await execute(deps, input, saved)).toHaveLength(148); expect(deps.reads).toHaveLength(7);
  });
  it("rejects ambiguous or malformed passes before any availability read", async () => {
    for (const products of [[rental(), { ...membership(), resource_type: "SCREEN_GOLF" }], [rental(), membership(), membership()],
      [rental(), { ...membership(), store_id: "22222222-2222-4222-8222-222222222222" }]]) {
      const deps = dependencies({ products }); await expect(execute(deps)).rejects.toThrow(/GOLFVX_(?:NONRENTAL_SCHEMA_UNSUPPORTED|PRODUCT_IDENTITY_INVALID)/u);
      expect(deps.reads.some(url => url.pathname.endsWith("/availability"))).toBe(false);
    }
  });
  it("fails before any availability read on saved/fresh catalog or identity changes", async () => {
    for (const deps of [dependencies({ products: [rental(), rental(102)] }), dependencies({ room: { ...rooms(), has_unassigned: 0 } }),
      dependencies({ stores: [{ ...store(), store_name: "Golf VX Other City" }] })]) {
      await expect(execute(deps)).rejects.toThrow(); expect(deps.reads.some(url => url.pathname.endsWith("/availability"))).toBe(false);
    }
  });
  it("refuses unsupported duration or party instead of returning EMPTY", async () => {
    for (const requested of [{ ...input, players: 5 }, { ...input, durationMinutes: 61 }]) await expect(execute(undefined, requested)).rejects.toThrow("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
    await expect(execute(dependencies({ availability: () => envelope([{ ...availability(), min_booking_minutes: 120 }]) }))).rejects.toThrow("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
  });
  it.each(["truncated", "empty", "duplicate", "gap", "extra", "malformed"])("rejects %s daily inventory before normalization", async kind => {
    const data = availability();
    if (kind === "truncated") data.slots.pop(); if (kind === "empty") data.slots = [];
    if (kind === "duplicate") data.slots[1] = { ...data.slots[0] }; if (kind === "gap") data.slots[1].start = "08:20";
    if (kind === "extra") data.slots.push({ ...data.slots[0], start: "07:45" }); if (kind === "malformed") data.slots[0].bays_for_full = -1;
    await expect(execute(dependencies({ availability: () => envelope([data]) }))).rejects.toThrow();
  });
  it("returns EMPTY only after all complete room grids affirm no available rental", async () => {
    const data = availability(); for (const row of data.slots) { row.available = false; row.bays_for_full = 0; row.max_available_minutes = 0; }
    const deps = dependencies({ availability: () => envelope([data]) }); expect(await execute(deps)).toEqual([]); expect(deps.reads).toHaveLength(5);
  });
  it.each(["zone", "business", "outside", "reason", "badDate"])("rejects %s date/window evidence", async kind => {
    const data = availability();
    if (kind === "zone") data.store_timezone = "America/Chicago"; if (kind === "business") data.business_date = input.date;
    if (kind === "outside") data.booking_end_date = "2026-10-22"; if (kind === "reason") data.reason = "AFTER_BOOKING_WINDOW" as never;
    if (kind === "badDate") data.booking_start_date = "2026-02-30";
    await expect(execute(dependencies({ availability: () => envelope([data]) }))).rejects.toThrow();
  });
  it.each(["available", "full", "bayCount", "duration", "peak"])("rejects inconsistent %s resource facts", async kind => {
    const data = availability(), row = data.slots[0];
    if (kind === "available") row.available = false; if (kind === "full") row.bays_for_full = 0;
    if (kind === "bayCount") row.bays_for_full = 10; if (kind === "duration") row.max_available_minutes = 30; if (kind === "peak") row.is_peak = true;
    await expect(execute(dependencies({ availability: () => envelope([data]) }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
  });
  it("accepts explicit EARLY non-peak rows in a complete mixed rate-zone grid", async () => {
    const data = availability();
    data.slots.forEach((row, index) => { row.zone = index < 16 ? "EARLY" : index < 36 ? "OFFPEAK" : "PEAK"; row.is_peak = row.zone === "PEAK"; });
    const slots = await execute(dependencies({ availability: () => envelope([data]) }));
    expect(slots).toHaveLength(74); expect(slots.every(slot => slot.availableSpots === 1 && slot.capacity === 4)).toBe(true);
  });
  it("rejects EARLY rows falsely marked peak", async () => {
    const data = availability(); data.slots[0].zone = "EARLY"; data.slots[0].is_peak = true;
    await expect(execute(dependencies({ availability: () => envelope([data]) }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
  });
  it.each(["UNKNOWN", "early", "NIGHT"])("continues to reject unqualified rate-zone value %s", async zone => {
    const data = availability(); data.slots[0].zone = zone;
    await expect(execute(dependencies({ availability: () => envelope([data]) }))).rejects.toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  });
  it("fails the entire run if any required room scope fails", async () => {
    await expect(execute(dependencies({ transform: (url, response) => url.searchParams.get("room_type") === "private" ? new Response("", { status: 503 }) : response }))).rejects.toThrow("ADAPTER_TRANSPORT_FAILED");
  });
  it.each([202, 206, 301, 302, 401, 500])("rejects partial/redirect/non-success HTTP %i", async status => {
    await expect(execute(dependencies({ transform: () => new Response("", { status }) }))).rejects.toThrow("ADAPTER_TRANSPORT_FAILED");
  });
  it("preserves throttling and rejects unproved content type/bytes/response URL", async () => {
    await expect(execute(dependencies({ transform: () => new Response("", { status: 429 }) }))).rejects.toThrow("PROVIDER_THROTTLED");
    await expect(execute(dependencies({ transform: () => new Response("{}", { headers: { "content-type": "text/html" } }) }))).rejects.toThrow("ADAPTER_RESPONSE_INVALID");
    await expect(execute(dependencies({ transform: () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000001" } }) }))).rejects.toThrow("ADAPTER_RESPONSE_LIMIT");
    await expect(execute(dependencies({ transform: (_url, response) => { Object.defineProperty(response, "url", { value: "https://evil.example.org/" }); return response; } }))).rejects.toThrow("ADAPTER_TRANSPORT_FAILED");
  });
  it("refuses expired execution and unsafe source before dispatch", async () => {
    const deps = dependencies(); await expect(inspectGolfVx(source, { ...deps, deadlineAt: new Date(0) })).rejects.toThrow("DEADLINE_EXCEEDED"); expect(deps.reads).toHaveLength(0);
    await expect(inspectGolfVx({ ...source, bookingUrl: source.bookingUrl + "?token=x" }, deps)).rejects.toThrow("ADAPTER_IDENTITY_MISSING"); expect(deps.reads).toHaveLength(0);
  });
  it("rejects DST-crossing local-clock rentals rather than changing visible duration", () => {
    const saved = metadata(); for (const key of Object.keys(saved.store.operatingHours)) saved.store.operatingHours[key as "0"] = { open: "00:00", close: "04:00" };
    const data = availability(); data.booking_start_date = "2026-11-01"; data.booking_end_date = "2026-11-07";
    data.slots = Array.from({ length: 16 }, (_, index) => ({ ...availability().slots[0], start: `${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`,
      max_available_minutes: 240 - index * 15, available: index <= 4, bays_for_full: index <= 4 ? 1 : 0 }));
    expect(() => normalizeGolfVxAvailability(envelope([data]), saved, 101, "BASE", target, { ...input, date: "2026-11-01", startTime: "00:00", endTime: "04:00", durationMinutes: 180 })).toThrow("ADAPTER_DATE_MISMATCH");
  });
  it("uses real inspector → strict recipe → execution dispatch, including failure evidence", async () => {
    const deps = dependencies(), inspected = await inspectExistingAdapter(source, { ...deps, venueMatches: venueProofMatches });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { ...target, kind: "SIMULATOR" }, source: { ...source, providerFamily: "GOLFVX" }, adapter: inspected.adapter });
    const result = await executeAccessRecipe(recipe, input, deps);
    expect(result.status).toBe("AVAILABLE"); expect(result.slots).toHaveLength(74);
    expect(result.evidence).toMatchObject({ venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true });
    const failed = await executeAccessRecipe(recipe, input, dependencies({ availability: () => envelope([{ ...availability(), slots: [] }]) }));
    expect(failed).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_AVAILABILITY_INCOMPLETE" } });
    for (const changed of [{ ...recipe, target: { ...target, kind: "OUTDOOR" } }, { ...recipe, target: { courseId: target.courseId, kind: "SIMULATOR" } },
      { ...recipe, source: { ...recipe.source, venueAddress: undefined } }, { ...recipe, source: { ...recipe.source, providerFamily: "AMELIA" } }, { ...recipe, javascript: "execute()" }])
      expect(() => parseAccessRecipe(changed)).toThrow();
  });
});
