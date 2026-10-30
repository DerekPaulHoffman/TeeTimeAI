// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { hashAccessRecipe, parseAccessRecipe, type AccessExecutionInput } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";

const source = { officialUrl: "https://cedar-fixture.teesnap.net/", bookingUrl: "https://cedar-fixture.teesnap.net/",
  venueName: "Cedar Fixture Golf Club", venueAddress: "731 Cedar Drive, Fairhaven, MA 02719, USA", timeZone: "America/New_York", providerFamily: "TEESNAP" };
const modernProperty = () => ({ success: true, data: { id: 91, name: source.venueName, enabled: true,
  address_street: "731 Cedar Drive", address_city: "Fairhaven", address_region: "MA", address_code: "02719", address_country: "US",
  time_zone: source.timeZone, phone: "+15085550123", courses: [{ id: 731, property_id: 91, name: source.venueName, enabled: true,
    course_type: null, holes_default: 18, addons_default: "off", players_array: [1, 2, 3, 4], holes_array: [9, 18], addons_array: ["off", "on"],
    min_players: 1, max_players: 4, default_players: 4 }] } });
const input = (date = "2030-05-17", players = 2): AccessExecutionInput => ({ date, players, timeZone: source.timeZone, startTime: "06:00", endTime: "18:00" });
function session(property = modernProperty()) {
  const reads: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = new URL(String(value)); reads.push(url.href);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    const headers = new Headers(init?.headers);
    for (const key of ["authorization", "cookie", "x-api-key"]) expect(headers.has(key)).toBe(false);
    expect(headers.get("user-agent")).toContain("Mozilla/5.0");
    if (url.href === source.bookingUrl) return new Response('<html><head><title>Public booking</title><script type="module" src="/main-fixture.js"></script></head><body><div id="app"></div></body></html>', { headers: { "content-type": "text/html" } });
    expect(url.origin).toBe("https://cedar-fixture.api.teesnap.net"); expect(headers.get("referer")).toBe(source.bookingUrl);
    if (url.pathname === "/api/bookingsite/property") { expect(url.search).toBe(""); return Response.json(property); }
    expect(url.pathname).toBe("/api/bookingsite/teetimes-day");
    expect([...url.searchParams.keys()].sort()).toEqual(["addons", "course", "date", "holes", "players"]);
    expect(url.searchParams.get("course")).toBe("731"); expect(url.searchParams.get("holes")).toBe("18"); expect(url.searchParams.get("addons")).toBe("off");
    const date = url.searchParams.get("date")!;
    return Response.json({ teeTimes: { golfers: [{ id: 1 }, { id: 2 }], bookings: [{ bookingId: 11, golfers: [1, 2] }], teeSheetPriceOverrides: [], teeTimes: [
      { teeTime: `${date}T12:30:00`, squeezeTime: false, shotgun: false, prices: [{ roundType: "EIGHTEEN_HOLE", price: "40.00", taxInclusive: true }],
        teeOffSections: [{ teeOff: "FRONT_NINE", bookings: [11], isHeld: false }, { teeOff: "BACK_NINE", isHeld: false }] },
      { teeTime: `${date}T14:00:00`, squeezeTime: false, shotgun: false, prices: [{ roundType: "NINE_HOLE", price: "25.00", taxInclusive: true }], teeOffSections: [{ teeOff: "FRONT_NINE", isHeld: false }] },
    ] } });
  });
  return { fetch, reads, requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
}
async function saved() {
  const helper = session(), { adapter } = await inspectExistingAdapter(source, { ...helper, venueMatches: venueProofMatches });
  expect(helper.reads).toEqual([source.bookingUrl, "https://cedar-fixture.api.teesnap.net/api/bookingsite/property"]);
  expect(adapter).toMatchObject({ family: "TEESNAP", publicApiVersion: "BOOKINGSITE_V1", supportedPlayers: [1, 2, 3, 4] });
  const recipe = parseAccessRecipe(JSON.parse(JSON.stringify({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "synthetic-modern", kind: "OUTDOOR" }, source, adapter }))) as ExistingAdapterRecipe;
  return { recipe, hash: hashAccessRecipe(recipe) };
}
async function execute(recipe: ExistingAdapterRecipe, hash: string, helper: ReturnType<typeof session>, request = input()) {
  return executeExistingAdapterRecipe(recipe, request, { ...helper, recipeHash: hash, venueMatches: venueProofMatches,
    toInstant: recipeTimeToInstant, now: () => new Date("2030-05-16T00:00:00Z") });
}
describe("modern public Teesnap saved methods", () => {
  it("replays an externally linked tenant through fresh bounded source reads and stops when that source changes", async () => {
    const linked = { ...source, officialUrl: "https://www.cedar-fixture.example/" }, canonical = "https://cedar-fixture.example/";
    let destination = linked.bookingUrl;
    const property = { ...modernProperty(), data: { ...modernProperty().data, back_url: canonical as string | undefined } };
    const base = session(property);
    const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
      const url = String(value);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
      if (url === linked.officialUrl) return new Response(null, { status: 308, headers: { location: canonical } });
      if (url === canonical) return new Response(`<title>${source.venueName}</title><a href="${destination}">Book</a>`, { headers: { "content-type": "text/html" } });
      if (url === source.bookingUrl) return new Response('<title>Public booking</title><div id="app"></div>', { headers: { "content-type": "text/html" } });
      return base.fetch(value, init);
    });
    const deps = { ...base, fetch, venueMatches: venueProofMatches };
    const { adapter } = await inspectExistingAdapter(linked, deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "synthetic-linked", kind: "OUTDOOR" }, source: linked, adapter }) as ExistingAdapterRecipe;
    const hash = hashAccessRecipe(recipe);
    for (const request of [input(), input("2030-05-18", 3)]) {
      fetch.mockClear();
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, recipeHash: hash, toInstant: recipeTimeToInstant, now: () => new Date("2030-05-16T00:00:00Z") });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hash, venueVerified: true, completeVerified: true } });
      expect(fetch.mock.calls.map(([url]) => String(url)).slice(0, 4)).toEqual([linked.officialUrl, canonical, linked.bookingUrl, "https://cedar-fixture.api.teesnap.net/api/bookingsite/property"]);
      expect(fetch).toHaveBeenCalledTimes(5); expect(hashAccessRecipe(recipe)).toBe(hash);
    }
    for (const backlink of [undefined, "https://other.example/", canonical + "?session=fixture"]) {
      property.data.back_url = backlink; fetch.mockClear();
      const incomplete = await executeExistingAdapterRecipe(recipe, input(), { ...deps, recipeHash: hash, toInstant: recipeTimeToInstant, now: () => new Date("2030-05-16T00:00:00Z") });
      expect(incomplete).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
      expect(fetch).toHaveBeenCalledTimes(4);
    }
    property.data.back_url = canonical;
    destination = "https://other-fixture.teesnap.net/"; fetch.mockClear();
    const changed = await executeExistingAdapterRecipe(recipe, input(), { ...deps, recipeHash: hash, toInstant: recipeTimeToInstant, now: () => new Date("2030-05-16T00:00:00Z") });
    expect(changed).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([linked.officialUrl, canonical]);
  });
  it("learns once then reuses fresh property and complete inventory for changed dates and players", async () => {
    const { recipe, hash } = await saved();
    for (const request of [input(), input("2030-05-18", 3)]) {
      const helper = session(), result = await execute(recipe, hash, helper, request);
      expect(result.evidence.reason).toBeUndefined();
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hash, venueVerified: true, completeVerified: true } });
      expect(result.slots).toEqual([{ sourceId: `teesnap-731-${request.date}T12:30:00`, startsAt: `${request.date}T16:30:00.000Z`, availableSpots: 4, bookingUrl: source.bookingUrl, holes: 18 }]);
      expect(helper.reads).toHaveLength(2); expect(helper.reads[0]).toBe("https://cedar-fixture.api.teesnap.net/api/bookingsite/property");
      expect(new URL(helper.reads[1]).searchParams.get("players")).toBe(String(request.players));
      expect(new URL(helper.reads[1]).searchParams.get("date")).toBe(request.date); expect(hashAccessRecipe(recipe)).toBe(hash);
    }
  });
  it("refuses changed public catalog identity before any day request", async () => {
    const { recipe, hash } = await saved(), changed = modernProperty(); changed.data.courses[0].id++;
    const helper = session(changed), result = await execute(recipe, hash, helper);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(helper.reads).toEqual(["https://cedar-fixture.api.teesnap.net/api/bookingsite/property"]);
  });
});
