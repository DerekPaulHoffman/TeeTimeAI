// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ameliaCalendarRange, executeAmelia, inspectAmelia, normalizeAmeliaAvailability } from "./amelia-executor";
import { executeAccessRecipe } from "./executor";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";

// The reviewed production client bytes are hash-pinned. These small inert
// replacements qualify only offline transport wiring, not new client builds.
const clients = vi.hoisted(() => ({ public: 'import{x}from"./stepForm-abcdef01.js";import{y}from"./eventBooking-abcdef02.js";', step: "reviewed-step-fixture", event: "reviewed-event-fixture" }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const pins = new Map([[clients.public, "eeca0eb849ccf96ced5cd7b253bd1721df1775f6e426a4acd435f0d1c3381d5b"],
    [clients.step, "e1958107085afec8d43216af542b5ab656ee6ccdcff601be7b07590012ad0d1e"],
    [clients.event, "494abf35444be17abb264766c4a712ffededaafb37b982bd1e7da087d6add42c"]]);
  return { ...actual, createHash: (algorithm: string) => {
    let content = "";
    return { update(value: string) { content += value; return this; }, digest(encoding: "hex") { return pins.get(content) ?? actual.createHash(algorithm).update(content).digest(encoding); } };
  } };
});

const input = { date: "2026-10-23", timeZone: "America/Los_Angeles", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const service = { id: 1, durationSeconds: 3600, timeBeforeSeconds: 0, timeAfterSeconds: 1800, minCapacity: 1, maxCapacity: 4, providerIds: [3] };
const target = { courseId: "course", offeringId: "offering" }, booking = "https://public-golf.example.org/book/";
const resource = () => ({ e: 3, l: null, p: null });
const payload = (slots: unknown) => ({ message: "Successfully retrieved free slots", data: { minimum: "2026-10-20 22:00", maximum: "2027-10-20 22:00", duration: 90, slots } });
const normalize = (value: unknown, requested = input, rental = service, range = ameliaCalendarRange(requested.date, requested.timeZone)) =>
  normalizeAmeliaAvailability(value, rental, target, requested, range, booking);

describe("Amelia explicit calendar coverage and affirmative UTC inventory", () => {
  it("mirrors the observed Sunday-start six-week range with an interior requested day", () => {
    expect(ameliaCalendarRange("2026-10-23", input.timeZone)).toEqual({ startDateTime: "2026-09-27", endDateTime: "2026-11-08", queryTimeZone: input.timeZone });
    expect(ameliaCalendarRange("2026-11-23", input.timeZone)).toEqual({ startDateTime: "2026-11-01", endDateTime: "2026-12-13", queryTimeZone: input.timeZone });
    // A Sunday month boundary is queried through the preceding proven grid.
    expect(ameliaCalendarRange("2026-11-01", input.timeZone)).toEqual({ startDateTime: "2026-09-27", endDateTime: "2026-11-08", queryTimeZone: input.timeZone });
  });
  it.each(["2026-02-30", "2026-13-01", "2026-2-01", "invalid"])("rejects malformed requested date %s", date => {
    expect(() => ameliaCalendarRange(date, input.timeZone)).toThrow("ADAPTER_RANGE_UNVERIFIED");
  });
  it("requires exact explicit range and timezone rather than broad response booking limits", () => {
    for (const range of [undefined, { startDateTime: "2026-10-23", endDateTime: "2027-10-23", queryTimeZone: input.timeZone },
      { ...ameliaCalendarRange(input.date, input.timeZone), queryTimeZone: "UTC" }])
      expect(() => normalizeAmeliaAvailability(payload({}), service, target, input, range!, booking)).toThrow("ADAPTER_RANGE_UNVERIFIED");
  });
  it("normalizes UTC keys across the local midnight and excludes provider buffers from customer duration", () => {
    const slots = normalize(payload({ "2026-10-23": { "16:30": [resource()], "17:00": [resource()] }, "2026-10-24": { "01:00": [resource()], "02:00": [resource()], "02:30": [resource()] } }));
    expect(slots.map(row => [row.startsAt, row.endsAt])).toEqual([
      ["2026-10-23T17:00:00.000Z", "2026-10-23T18:00:00.000Z"],
      ["2026-10-24T01:00:00.000Z", "2026-10-24T02:00:00.000Z"],
      ["2026-10-24T02:00:00.000Z", "2026-10-24T03:00:00.000Z"],
    ]);
    expect(slots.every(row => row.availableSpots === 1 && row.capacity === 4 && row.resourceId === "amelia-provider:3" && row.productId === "amelia-service:1")).toBe(true);
  });
  it("uses distinct UTC instants at fall-back and keeps actual one-hour duration", () => {
    const requested = { ...input, date: "2026-11-01", startTime: "00:00", endTime: "24:00" };
    const slots = normalize(payload({ "2026-11-01": { "08:30": [resource()], "09:30": [resource()] } }), requested);
    expect(slots.map(row => row.startsAt)).toEqual(["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"]);
    expect(new Set(slots.map(row => row.sourceId)).size).toBe(2);
    expect(slots.every(row => Date.parse(row.endsAt!) - Date.parse(row.startsAt) === 3600_000)).toBe(true);
  });
  it("converts spring-forward UTC inventory without inventing nonexistent local time", () => {
    const requested = { ...input, date: "2027-03-14", startTime: "00:00", endTime: "24:00" };
    expect(normalize(payload({ "2027-03-14": { "09:30": [resource()], "10:30": [resource()] } }), requested).map(row => row.startsAt))
      .toEqual(["2027-03-14T09:30:00.000Z", "2027-03-14T10:30:00.000Z"]);
  });
  it("accepts an explicit full-range empty map, never an omitted or failed payload", () => {
    expect(normalize(payload({}))).toEqual([]);
    for (const value of [{}, { data: {} }, { message: "Failed", data: { slots: {} } }, payload([])])
      expect(() => normalize(value)).toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  });
  it("validates every row before local filtering, including foreign resources outside the desired day", () => {
    for (const changed of [{ e: 99, l: null, p: null }, { e: 3, l: 1, p: null }, { e: 3, l: null, p: 1 }, { e: 3, p: null }, { e: "3", l: null, p: null }])
      expect(() => normalize(payload({ "2026-10-22": { "17:00": [changed] }, "2026-10-23": { "17:00": [resource()] } }))).toThrow("ADAPTER_RESOURCE_MISMATCH");
  });
  it("rejects duplicate resources, malformed UTC keys and inventory outside the explicit query range", () => {
    expect(() => normalize(payload({ "2026-10-23": { "17:00": [resource(), resource()] } }))).toThrow("ADAPTER_DUPLICATE_SLOT");
    for (const value of [{ "2026-02-30": { "17:00": [resource()] } }, { "2026-10-23": { "24:00": [resource()] } },
      { "2026-10-23": { "17:00:00": [resource()] } }, { "2026-10-23": { "17:00": [] } }, { "2026-12-01": { "17:00": [resource()] } }])
      expect(() => normalize(payload(value))).toThrow();
  });
  it("requires base duration and actual party capacity; never turns an unsupported product into empty", () => {
    for (const requested of [{ ...input, durationMinutes: 90 }, { ...input, players: 5 }, { ...input, players: 0 }])
      expect(() => normalize(payload({}), requested)).toThrow("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED");
  });
});

const source = { officialUrl: "https://rental.example.org/", bookingUrl: "https://rental.example.org/book/",
  venueName: "Eagles Nest Golf LLC", venueAddress: "29 E Powell Blvd, Gresham, OR 97030, USA", timeZone: input.timeZone, providerFamily: "AMELIA" };
const settings = { wordpress: { timezone: input.timeZone, startOfWeek: 0 }, general: { showClientTimeZone: true, timeSlotLength: 1800 },
  appointments: { bringingAnyoneLogic: "additional", bookMultipleTimes: false, employeeSelection: "random", isGloballyBusySlot: false } };
const shortcode = { hasApiCall: false, trigger: "", trigger_type: "", triggered_form: "sbsNew", in_dialog: "", show: "", counter: "1000",
  category: "", service: "", employee: "", location: "", package: "", layout: "", ivy: "" };
const urls = { wpAmeliaUseUploadsAmeliaPath: "1", wpAmeliaPluginURL: "/wp-content/plugins/ameliabooking/", wpAmeliaPluginAjaxURL: "/wp-admin/admin-ajax.php?action=wpamelia_api&call=" };
function bookingHtml() { return `<div id="amelia-v2-booking-1000" class="amelia-v2-booking"></div><script>var wpAmeliaSettings=${JSON.stringify(settings)};
var wpAmeliaUrls=${JSON.stringify(urls)};ameliaShortcodeData.push(${JSON.stringify(shortcode)});</script>
<script type="module" src="/wp-content/plugins/ameliabooking/v3/public/assets/public.js?ver=9.8.1"></script>`; }
const officialHtml = `<title>Eagle’s Nest Golf | Public rentals</title><h1>Eagle’s Nest Golf</h1><a href="/book/">Book tee time</a>
<address>29 East Powell Boulevard<br>Gresham, OR 97030</address>`;
const rental = { id: 1, name: "Golf Simulator", duration: 3600, minCapacity: 1, maxCapacity: 4, bringingAnyone: true, show: true, status: "visible",
  timeBefore: null, timeAfter: 1800, aggregatedPrice: false, mandatoryExtra: false, recurringCycle: "disabled", extras: [],
  customPricing: JSON.stringify({ enabled: "person", durations: { "7200": { price: 60, rules: [] } }, persons: { "2": { price: 40, rules: [] } }, periods: { default: [], custom: [] } }) };
function entities(products = 2, providers = 2) {
  const rentals = Array.from({ length: products }, (_, index) => ({ ...rental, id: index + 1, name: index ? `Golf Bay Rental ${index + 1}` : rental.name }));
  return { message: "Successfully retrieved entities", data: { categories: [{ id: 1, status: "visible", serviceList: rentals }], locations: [],
    entitiesRelations: Object.fromEntries(Array.from({ length: providers }, (_, index) => [String(index + 3), Object.fromEntries(rentals.map(rental => [String(rental.id), [null]]))])),
    employees: Array.from({ length: providers }, (_, index) => ({ id: index + 3, type: "provider", status: "visible", serviceList: structuredClone(rentals) })) } };
}
type FixtureOptions = { official?: string; booking?: string; entities?: ReturnType<typeof entities>;
  slots?: (url: URL) => unknown; response?: (url: URL, response: Response) => Response | Promise<Response> };
function dependencies(options: FixtureOptions = {}) {
  const reads: URL[] = [], families: string[] = [], inits: RequestInit[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = new URL(String(value)); reads.push(url); inits.push(init ?? {});
    let response: Response;
    if (url.href === source.officialUrl) response = new Response(options.official ?? officialHtml, { headers: { "content-type": "text/html" } });
    else if (url.href === source.bookingUrl) response = new Response(options.booking ?? bookingHtml(), { headers: { "content-type": "text/html" } });
    else if (url.pathname.endsWith("/public.js")) response = new Response(clients.public, { headers: { "content-type": "application/javascript" } });
    else if (url.pathname.endsWith("/stepForm-abcdef01.js")) response = new Response(clients.step, { headers: { "content-type": "text/javascript" } });
    else if (url.pathname.endsWith("/eventBooking-abcdef02.js")) response = new Response(clients.event, { headers: { "content-type": "text/javascript" } });
    else if (url.pathname === "/wp-admin/admin-ajax.php" && url.searchParams.get("call") === "/entities") response = Response.json(options.entities ?? entities());
    else if (url.pathname === "/wp-admin/admin-ajax.php" && url.searchParams.get("call") === "/slots") {
      const date = new Date(`${url.searchParams.get("startDateTime")}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 26);
      response = Response.json(options.slots ? options.slots(url) : payload({ [date.toISOString().slice(0, 10)]: { "17:00": [{ e: Number(url.searchParams.get("providerIds")), l: null, p: null }] } }));
    } else throw new Error("UNEXPECTED_FIXTURE_READ");
    return options.response ? options.response(url, response) : response;
  });
  return { reads, families, inits, fetch, now: () => new Date("2026-10-20T12:00:00Z"),
    requestLease: async <T>(family: string, work: () => Promise<T>) => { families.push(family); return { acquired: true as const, value: await work() }; } };
}
const slotReads = (deps: ReturnType<typeof dependencies>) => deps.reads.filter(url => url.searchParams.get("call") === "/slots");
async function savedRecipe(deps = dependencies()) {
  const inspected = await inspectExistingAdapter(source, { ...deps, venueMatches: (expected, observed) => expected === observed });
  return parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source, target: { ...target, kind: "SIMULATOR" }, ...inspected });
}

describe("fixed Amelia public transport and independent recipe replay", () => {
  it("preserves recognized cold Amelia when decoded fetch bytes retain encoded wire headers", async () => {
    const deps = dependencies({ response: (url, response) => {
      if (url.href === source.bookingUrl) {
        response.headers.set("content-encoding", "gzip"); response.headers.set("content-length", "17");
      }
      return response;
    } });
    expect(await inspectAmelia(source, deps)).toMatchObject({ family: "AMELIA", timeZone: input.timeZone });
    expect(deps.reads).toHaveLength(6);
  });
  it("keeps identity and transport failures ahead of cold unsupported-source classification", async () => {
    const booking = '<main><h1>Public calendar</h1><p>Choose a date</p></main>';
    const wrongIdentity = dependencies({ booking, official: officialHtml.replace("29 East", "129 East") });
    await expect(inspectAmelia(source, wrongIdentity)).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(wrongIdentity.reads.map(url => url.href)).toEqual([source.officialUrl]);
    for (const status of [401, 403, 206, 429]) {
      const deps = dependencies({ booking, response: (url, response) => url.href === source.bookingUrl ? new Response(booking, { status, headers: response.headers }) : response });
      await expect(inspectAmelia(source, deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : "ADAPTER_TRANSPORT_FAILED");
      expect(deps.reads.map(url => url.href)).toEqual([source.officialUrl, source.bookingUrl]);
    }
  });
  it("never treats partial, invalid UTF-8, oversized or failed body reads as absent bootstrap", async () => {
    const booking = '<main>Public calendar</main>';
    for (const changed of [
      () => new Response(booking, { headers: { "content-type": "text/html", "content-range": "bytes 0-27/1000" } }),
      () => new Response(booking, { headers: { "content-type": "text/html", "content-length": "1000" } }),
      () => new Response(booking, { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
      () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "text/html" } }),
      () => new Response(" ".repeat(2_000_001), { headers: { "content-type": "text/html" } }),
      () => { const response = new Response(booking, { headers: { "content-type": "text/html" } }); response.arrayBuffer = async () => { throw new Error("BODY_READ_FAILED"); }; return response; },
    ]) {
      const deps = dependencies({ response: (url, response) => url.href === source.bookingUrl ? changed() : response });
      await expect(inspectAmelia(source, deps)).rejects.not.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
      expect(deps.reads.map(url => url.href)).toEqual([source.officialUrl, source.bookingUrl]);
    }
  });
  it("keeps malformed or hidden Amelia evidence strict instead of opening generic fallback", async () => {
    for (const booking of ['<script>var wpAmeliaSettings = null;</script>', '<div hidden class="amelia-v2-booking"></div>',
      '<script src="https://foreign.example.org/wp-content/plugins/ameliabooking/public.js"></script>', String.raw`<script>var wp\u0041meliaSettings = null;</script>`]) {
      const deps = dependencies({ booking });
      await expect(inspectAmelia(source, deps)).rejects.toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
      expect(deps.reads).toHaveLength(2);
    }
  });
  it("keeps a vanished bootstrap on warm execution a strict configuration failure", async () => {
    const recipe = await savedRecipe(), deps = dependencies({ booking: '<main><h1>Public calendar</h1></main>' });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_CONFIGURATION_UNVERIFIED" } });
    expect(deps.reads.map(url => url.href)).toEqual([source.officialUrl, source.bookingUrl]);
  });
  it("verifies source and pinned clients before API access, then independently replays every rental and provider", async () => {
    const deps = dependencies(), recipe = await savedRecipe(deps), hash = hashAccessRecipe(recipe);
    const result = await executeAccessRecipe(recipe, input, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hash, venueVerified: true, dateVerified: true,
      durationVerified: true, capacityVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(4);
    expect(new Set(result.slots.map(slot => `${slot.resourceId}/${slot.productId}`)).size).toBe(4);
    expect(deps.reads.slice(0, 6).map(url => url.pathname)).toEqual(["/", "/book/", "/wp-content/plugins/ameliabooking/v3/public/assets/public.js",
      "/wp-content/plugins/ameliabooking/v3/public/assets/stepForm-abcdef01.js", "/wp-content/plugins/ameliabooking/v3/public/assets/eventBooking-abcdef02.js", "/wp-admin/admin-ajax.php"]);
    expect(deps.reads.every(url => url.origin === "https://rental.example.org")).toBe(true);
    expect(deps.families.every(family => family === "rental.example.org")).toBe(true);
    expect(deps.inits.every(init => init.method === "GET" && init.credentials === "omit" && init.redirect === "manual" && init.cache === "no-store" && init.body === undefined)).toBe(true);
    for (const url of slotReads(deps)) {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ action: "wpamelia_api", call: "/slots", startDateTime: "2026-09-27", endDateTime: "2026-11-08",
        queryTimeZone: input.timeZone, monthsLoad: "1", serviceDuration: "3600", group: "1", page: "booking", structured: "true", persons: "2" });
      expect([...url.searchParams.keys()].sort()).toEqual(["action", "call", "startDateTime", "endDateTime", "queryTimeZone", "monthsLoad", "serviceId", "serviceDuration", "providerIds", "group", "page", "structured", "persons"].sort());
      expect(url.searchParams.get("providerIds")).toMatch(/^[34]$/u);
    }
  });
  it("reuses the exact immutable recipe for a changed date and party with fresh source/configuration", async () => {
    const recipe = await savedRecipe(), original = JSON.stringify(recipe), deps = dependencies({ slots: url => payload({ "2026-11-23": { "18:00": [{ e: Number(url.searchParams.get("providerIds")), l: null, p: null }] } }) });
    const result = await executeAccessRecipe(recipe, { ...input, date: "2026-11-23", players: 3 }, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true }); expect(result.slots).toHaveLength(4);
    expect(slotReads(deps).every(url => url.searchParams.get("persons") === "3" && url.searchParams.get("startDateTime") === "2026-11-01" && url.searchParams.get("endDateTime") === "2026-12-13")).toBe(true);
    expect(JSON.stringify(recipe)).toBe(original); expect(result.evidence.recipeHash).toBe(hashAccessRecipe(recipe));
  });
  it("rejects outdoor, missing offering/address, wrong-family and opaque-code recipes at the parsed boundary", async () => {
    const recipe = await savedRecipe();
    const invalid = [{ ...recipe, target: { ...target, kind: "OUTDOOR" } }, { ...recipe, target: { courseId: target.courseId, kind: "SIMULATOR" } },
      { ...recipe, source: { ...source, venueAddress: undefined } }, { ...recipe, source: { ...source, providerFamily: "FOREUP" } },
      { ...recipe, adapter: { ...recipe.adapter, script: "return fetch('/checkout')" } }, { ...recipe, javascript: "unsafe()" }];
    for (const value of invalid) expect(() => parseAccessRecipe(value)).toThrow();
  });
  it("makes no API requests without exact official identity or the supported plugin/bootstrap", async () => {
    for (const options of [{ official: officialHtml.replace("29 East", "129 East") }, { booking: bookingHtml().replace('"service":""', '"service":"1"') },
      { response: (url: URL, response: Response) => url.pathname.endsWith("/stepForm-abcdef01.js") ? new Response(`${clients.step} changed`, { headers: response.headers }) : response }]) {
      const deps = dependencies(options); await expect(inspectAmelia(source, deps)).rejects.toThrow();
      expect(deps.reads.some(url => url.pathname === "/wp-admin/admin-ajax.php")).toBe(false);
    }
  });
  it("rejects source origin substitution and expired deadlines before any provider request", async () => {
    for (const changed of [{ ...source, bookingUrl: "https://other.example.org/book/" }, { ...source, officialUrl: "https://user:pass@rental.example.org/" }]) {
      const deps = dependencies(); await expect(inspectAmelia(changed, deps)).rejects.toThrow(); expect(deps.reads).toEqual([]);
    }
    const deps = dependencies(); await expect(inspectAmelia(source, { ...deps, deadlineAt: new Date(0) })).rejects.toThrow("DEADLINE_EXCEEDED"); expect(deps.reads).toEqual([]);
  });
  it("rejects fresh catalog drift before requesting any slots", async () => {
    const recipe = await savedRecipe(), changed = entities(); changed.data.employees.pop();
    delete changed.data.entitiesRelations["4"];
    const deps = dependencies({ entities: changed });
    const result = await executeAccessRecipe(recipe, input, deps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_CONFIGURATION_CHANGED" } });
    expect(slotReads(deps)).toEqual([]);
  });
  it.each(["missing", "missing-service", "foreign-location"])("cannot complete inventory with %s service/resource relations", async mode => {
    const recipe = await savedRecipe(), catalog = entities();
    if (mode === "missing") delete (catalog.data as Record<string, unknown>).entitiesRelations;
    if (mode === "missing-service") delete catalog.data.entitiesRelations["4"]["2"];
    if (mode === "foreign-location") Object.assign(catalog.data.entitiesRelations["4"], { "2": [99] });
    const deps = dependencies({ entities: catalog });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(slotReads(deps)).toEqual([]);
  });
  it.each(["failed-resource", "foreign-resource", "missing-slots"])("never publishes earlier partial inventory after %s", async mode => {
    const recipe = await savedRecipe(), deps = dependencies({ slots: url => {
      if (url.searchParams.get("serviceId") === "2" && url.searchParams.get("providerIds") === "4") {
        if (mode === "failed-resource") throw new Error("FIXTURE_FAILED_RESOURCE");
        if (mode === "missing-slots") return { message: "Successfully retrieved free slots", data: {} };
        return payload({ "2026-10-23": { "17:00": [{ e: 99, l: null, p: null }] } });
      }
      return payload({ "2026-10-23": { "17:00": [{ e: Number(url.searchParams.get("providerIds")), l: null, p: null }] } });
    } });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] }); expect(slotReads(deps)).toHaveLength(4);
  });
  it("accepts EMPTY only when all eligible product/provider reads return explicit full-query emptiness", async () => {
    const recipe = await savedRecipe(), deps = dependencies({ slots: () => payload({}) });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "EMPTY", complete: true, slots: [] }); expect(slotReads(deps)).toHaveLength(4);
  });
  it.each([202, 206, 302, 429])("rejects HTTP %s without following or retrying the request", async status => {
    const deps = dependencies({ response: () => new Response("", { status, headers: { "content-type": "text/html", location: "https://other.example.org/" } }) });
    await expect(inspectAmelia(source, deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : "ADAPTER_TRANSPORT_FAILED"); expect(deps.reads).toHaveLength(1);
  });
  it("rejects final URL substitution, invalid MIME and declared/actual oversized bodies", async () => {
    const responses = [() => { const response = new Response(officialHtml, { headers: { "content-type": "text/html" } }); Object.defineProperty(response, "url", { value: "https://other.example.org/" }); return response; },
      () => new Response(officialHtml, { headers: { "content-type": "application/json" } }),
      () => new Response("", { headers: { "content-type": "text/html", "content-length": "2000001" } }),
      () => new Response("x".repeat(2_000_001), { headers: { "content-type": "text/html" } })];
    for (const response of responses) { const deps = dependencies({ response }); await expect(inspectAmelia(source, deps)).rejects.toThrow(); expect(deps.reads).toHaveLength(1); }
  });
  it("refuses unsupported duration/party and excessive resource coverage without returning empty or partial inventory", async () => {
    const metadata = await inspectAmelia(source, dependencies());
    for (const requested of [{ ...input, players: 5 }, { ...input, durationMinutes: 90 }]) {
      const deps = dependencies(); await expect(executeAmelia(source, metadata, target, requested, deps)).rejects.toThrow("ADAPTER_DURATION_OR_PARTY_UNSUPPORTED"); expect(slotReads(deps)).toEqual([]);
    }
    const catalog = entities(2, 30), deps = dependencies({ entities: catalog }), large = await inspectAmelia(source, deps);
    await expect(executeAmelia(source, large, target, input, deps)).rejects.toThrow("ADAPTER_REQUEST_LIMIT"); expect(slotReads(deps)).toEqual([]);
  });
  it("does not omit shorter rentals with duration extras while completing a matching longer base product", async () => {
    const catalog = entities();
    for (const list of [catalog.data.categories[0].serviceList, ...catalog.data.employees.map(provider => provider.serviceList)]) {
      Object.assign(list[0], { extras: [{ id: 7, name: "Extra hour", duration: 3600, maxQuantity: 1, type: "extra" }] });
      list[1].duration = 7200;
    }
    const deps = dependencies({ entities: catalog }), recipe = await savedRecipe(deps);
    const result = await executeAccessRecipe(recipe, { ...input, durationMinutes: 120 }, deps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_DURATION_OR_PARTY_UNSUPPORTED" } });
    expect(slotReads(deps)).toEqual([]);
  });
  it.each(["global", "provider"])("rejects enabled custom duration variants on a %s rental before reading any availability", async kind => {
    const recipe = await savedRecipe(), catalog = entities();
    const list = kind === "global" ? catalog.data.categories[0].serviceList : catalog.data.employees[1].serviceList;
    const pricing = JSON.parse(list[1].customPricing); pricing.enabled = "duration"; list[1].customPricing = JSON.stringify(pricing);
    const deps = dependencies({ entities: catalog });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_CUSTOM_PRICING_UNSUPPORTED" } });
    expect(slotReads(deps)).toEqual([]);
  });
  it("bounds aggregate response bytes across all resources and discards the complete candidate on overflow", async () => {
    const catalog = entities(1, 10), recipe = await savedRecipe(dependencies({ entities: catalog }));
    const deps = dependencies({ entities: catalog, response: (url, response) => url.searchParams.get("call") === "/slots" ?
      Response.json({ ...payload({}), unrelatedPadding: "x".repeat(1_800_000) }) : response });
    expect(await executeAccessRecipe(recipe, input, deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_RESPONSE_LIMIT" } });
    expect(slotReads(deps).length).toBeGreaterThan(1); expect(slotReads(deps).length).toBeLessThan(10);
  });
  it("aborts an in-flight read at the original deadline and releases its provider lease", async () => {
    let active = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const signal = init!.signal!; signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const requestLease = async <T>(_family: string, work: () => Promise<T>) => {
      active++; try { return { acquired: true as const, value: await work() }; } finally { active--; }
    };
    await expect(inspectAmelia(source, { fetch, requestLease, deadlineAt: new Date(Date.now() + 50) })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1); expect(active).toBe(0);
  });
});
