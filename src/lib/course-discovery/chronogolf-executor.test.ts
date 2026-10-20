// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeChronogolf, inspectChronogolf } from "./chronogolf-executor";
import { CHRONOGOLF_READ_CLIENTS, parseChronogolfProfile } from "./chronogolf-source";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";

// Tiny inert clients qualify offline wiring only. Production verifies the
// reviewed bytes; an unknown or changed body still hashes normally and fails.
const clients = vi.hoisted(() => ["reviewed-chronogolf-view", "reviewed-chronogolf-serializer"]);
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const pins = new Map([[clients[0], "3d7f020bc8c0a795d8132b1951cc2be2c50ada2983458c9aa98df02e5631b340"],
    [clients[1], "78bb211875897af6f24bbec9f39600786543482678d32d7dedc0335ccacaae78"]]);
  return { ...actual, createHash: (algorithm: string) => { let text = ""; return { update(value: string) { text += value; return this; },
    digest(encoding: "hex") { return pins.get(text) ?? actual.createHash(algorithm).update(text).digest(encoding); } }; } };
});

const course = { id: 11, uuid: "00000000-0000-4000-8000-000000000011", name: "Public Pines", holes: 18 as const, bookableHoles: [9, 18] };
const source = { officialUrl: "https://publicgolf.example.org/", bookingUrl: "https://www.chronogolf.com/club/public-pines-golf-club",
  venueName: "Public Pines Golf Club", venueAddress: "123 Fairway Drive, Portland, OR 97231, USA", timeZone: "America/Los_Angeles" };
const input = { date: "2026-10-23", timeZone: source.timeZone, players: 2, startTime: "08:00", endTime: "18:00" };
const target = { courseId: "course" };
function club() { return { id: 10, uuid: "00000000-0000-4000-8000-000000000010", name: source.venueName, slug: "public-pines-golf-club",
  active: true, state: "published", website: source.officialUrl, address: "123 Fairway Drive", city: "Portland", province: "Oregon", postcode: "97231",
  country: "United States", timezone: source.timeZone, defaultAffiliationTypeId: 90, features: { onlineBookingEnabled: true }, courses: [structuredClone(course)] }; }
function html(value = club()) { return `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { club: value } } })}</script>` +
  CHRONOGOLF_READ_CLIENTS.map(client => `<script src="${client.url}"></script>`).join(""); }
const metadata = () => parseChronogolfProfile(html(), source.bookingUrl, source);
function row(id: number, date = input.date) { return { id, uuid: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  course: { id: course.id, uuid: course.uuid, name: course.name, holes: 18, bookable_holes: [9, 18] }, hole: 1, has_cart: false,
  min_player_size: 1, max_player_size: 4, starts_at: `${date}T17:${String(id % 60).padStart(2, "0")}:00Z`, start_time: `10:${String(id % 60).padStart(2, "0")}`,
  date, event_id: null, has_deal: false, default_price: { green_fee: 40, half_cart: 10, one_person_cart: null, player_type_id: 90,
    subtotal: 40, bookable_holes: 9, affiliation_type: "Public" }, departure: null, format: "normal", frozen: false }; }
type Row = ReturnType<typeof row>;
type Options = { profile?: string; pages?: unknown[][]; total?: number; perPage?: number; status?: string;
  response?: (url: URL, response: Response) => Response | Promise<Response> };
function dependencies(options: Options = {}) {
  const reads: URL[] = [], inits: RequestInit[] = [], families: string[] = [], pages = options.pages ?? [[row(1), row(2)], [row(3)]];
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = new URL(String(value)); reads.push(url); inits.push(init ?? {}); let response: Response;
    const client = CHRONOGOLF_READ_CLIENTS.findIndex(client => client.url === url.href);
    if (client >= 0) response = new Response(clients[client], { headers: { "content-type": "application/javascript" } });
    else if (url.pathname.startsWith("/club/")) response = new Response(options.profile ?? html(), { headers: { "content-type": "text/html" } });
    else if (url.pathname === "/marketplace/v2/teetimes") response = new Response(JSON.stringify({ status: options.status ?? "open", teetimes: pages[Number(url.searchParams.get("page")) - 1] ?? [] }),
      { headers: { "content-type": "application/json", total: String(options.total ?? pages.flat().length), "per-page": String(options.perPage ?? 2) } });
    else throw new Error("UNEXPECTED_REQUEST");
    return options.response ? options.response(url, response) : response;
  });
  return { reads, inits, families, fetch, now: () => new Date("2026-10-20T12:00:00Z"),
    requestLease: async <T>(family: string, work: () => Promise<T>) => { families.push(family); return { acquired: true as const, value: await work() }; } };
}
const execute = (deps: ReturnType<typeof dependencies>, requested = input, saved = metadata(), identity = source) => executeChronogolf(identity, saved, target, requested, deps);

describe("Chronogolf fixed public all-round reader", () => {
  it("inspects fresh profile and both reviewed clients without availability or credentials", async () => {
    const deps = dependencies(); expect(await inspectChronogolf(source, deps)).toEqual(metadata()); expect(deps.reads).toHaveLength(3);
    expect(deps.inits.every(init => init.method === "GET" && init.credentials === "omit" && init.redirect === "manual" && !new Headers(init.headers).has("cookie"))).toBe(true);
    expect(deps.families.every(family => family === deps.families[0])).toBe(true);
  });
  it("reads all explicit pages and all round options while preserving legacy source IDs", async () => {
    const deps = dependencies(), slots = await execute(deps), api = deps.reads.filter(url => url.pathname.includes("/marketplace/"));
    expect(api.map(url => Object.fromEntries(url.searchParams))).toEqual([1, 2].map(page => ({ start_date: input.date, free_slots: "2", course_ids: course.uuid, holes: "9,18", page: String(page) })));
    expect(slots).toHaveLength(3); expect(slots[0]).toMatchObject({ sourceId: `chronogolf-${row(1).uuid}`, startsAt: "2026-10-23T17:01:00.000Z", availableSpots: 4,
      bookingUrl: `${source.bookingUrl}?date=2026-10-23&step=teetimes`, resourceId: `chronogolf-course:${course.uuid}` });
    expect(slots.every(slot => slot.holes === undefined && !("priceCents" in slot) && slot.endsAt === undefined)).toBe(true);
  });
  it("filters frozen times and actual party/window eligibility only after validating every row", async () => {
    const rows = [row(1), { ...row(2), frozen: true }, { ...row(3), min_player_size: 3 }, { ...row(4), max_player_size: 1 },
      { ...row(5), starts_at: "2026-10-24T01:00:00Z", start_time: "18:00" }];
    expect(await execute(dependencies({ pages: [rows], perPage: 10 }))).toHaveLength(1);
  });
  it("normalizes one-digit public hours before exact UTC/local and inclusive-start exclusive-end window checks", async () => {
    const requested = { ...input, players: 1, startTime: "08:30", endTime: "10:00" };
    const rows = [
      { ...row(1), starts_at: "2026-10-23T15:29:00Z", start_time: "8:29" },
      { ...row(2), starts_at: "2026-10-23T15:30:00Z", start_time: "8:30" },
      { ...row(3), starts_at: "2026-10-23T16:33:00Z", start_time: "9:33" },
      { ...row(4), starts_at: "2026-10-23T17:00:00Z", start_time: "10:00" },
    ];
    const slots = await execute(dependencies({ pages: [rows], perPage: 24 }), requested);
    expect(slots.map(slot => slot.startsAt)).toEqual(["2026-10-23T15:30:00.000Z", "2026-10-23T16:33:00.000Z"]);
  });
  it("requires the observed anonymous public class label even when the numeric default class matches", async () => {
    for (const affiliation_type of ["Members only", "VIP", "Visitors", "Public member"]) {
      const value = row(1); value.default_price.affiliation_type = affiliation_type;
      await expect(execute(dependencies({ pages: [[value]], perPage: 24 }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
    }
    const value = row(1); value.default_price.affiliation_type = " Public* ";
    expect(await execute(dependencies({ pages: [[value]], perPage: 24 }))).toHaveLength(1);
  });
  it("replays the saved catalog with changed date and party using fresh reads", async () => {
    const changed = { ...input, date: "2026-10-24", players: 3 }, deps = dependencies({ pages: [[row(1, changed.date)]], perPage: 24 });
    expect(await execute(deps, changed)).toHaveLength(1);
    expect(deps.reads.at(-1)!.searchParams.get("start_date")).toBe(changed.date); expect(deps.reads.at(-1)!.searchParams.get("free_slots")).toBe("3");
  });
  it.each(["open", "sold_out"])("accepts explicit verified zero-total %s only", async status => {
    expect(await execute(dependencies({ pages: [[]], total: 0, perPage: 24, status }))).toEqual([]);
  });
  it("rejects a changed client before any availability read", async () => {
    const deps = dependencies({ response: (url, response) => url.href === CHRONOGOLF_READ_CLIENTS[1].url ? new Response("changed", { headers: response.headers }) : response });
    await expect(execute(deps)).rejects.toThrow("ADAPTER_CLIENT_UNSUPPORTED"); expect(deps.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
  });
  it("rejects changed profile metadata before an availability read", async () => {
    const changed = club(); changed.courses[0].bookableHoles = [18]; const deps = dependencies({ profile: html(changed) });
    await expect(execute(deps)).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED"); expect(deps.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
  });
  it.each([
    (r: Row) => ({ ...r, date: "2026-10-24" }), (r: Row) => ({ ...r, starts_at: "2026-10-23T18:01:00Z" }),
    (r: Row) => ({ ...r, course: { ...r.course, id: 99 } }), (r: Row) => ({ ...r, course: { ...r.course, uuid: row(99).uuid } }),
    (r: Row) => ({ ...r, course: { ...r.course, name: "Other course" } }), (r: Row) => ({ ...r, course: { ...r.course, holes: 9 } }),
    (r: Row) => ({ ...r, course: { ...r.course, bookable_holes: [18] } }),
    (r: Row) => ({ ...r, default_price: { ...r.default_price, player_type_id: 100 } }),
  ])("rejects date, UTC/local or catalog mismatch even outside the requested window %#", async mutate => {
    await expect(execute(dependencies({ pages: [[mutate(row(1))]], perPage: 24 }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
  });
  it.each([{ min_player_size: 5, max_player_size: 4 }, { uuid: "bad" }, { starts_at: "not-a-date" }, { event_id: 7 }, { format: "shotgun" }, { frozen: "false" }, { default_price: undefined }])
    ("rejects malformed/non-public rows rather than silently dropping %j", async change => {
      await expect(execute(dependencies({ pages: [[{ ...row(1), ...change }]], perPage: 24 }))).rejects.toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    });
  it.each(["id", "uuid"])("rejects duplicate %s across pages", async key => {
    const duplicate = row(3); if (key === "id") duplicate.id = 1; else duplicate.uuid = row(1).uuid;
    await expect(execute(dependencies({ pages: [[row(1), row(2)], [duplicate]] }))).rejects.toThrow("ADAPTER_DUPLICATE_SLOT");
  });
  it("rejects an early short page, unknown status and contradictory sold-out data", async () => {
    await expect(execute(dependencies({ pages: [[row(1)]], total: 3, perPage: 2 }))).rejects.toThrow("ADAPTER_PAGINATION_UNVERIFIED");
    await expect(execute(dependencies({ status: "closed" }))).rejects.toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    await expect(execute(dependencies({ status: "sold_out" }))).rejects.toThrow();
  });
  it("rejects absent or changing pagination and never falls back to returned row counts", async () => {
    for (const change of ["missing", "changed"]) {
      const deps = dependencies({ response: (url, response) => { if (!url.pathname.includes("/marketplace/")) return response;
        const headers = new Headers(response.headers); if (change === "missing") headers.delete("total"); else if (url.searchParams.get("page") === "2") headers.set("total", "4");
        return new Response(response.body, { headers }); } });
      await expect(execute(deps)).rejects.toThrow(change === "missing" ? "ADAPTER_PAGINATION_UNVERIFIED" : "ADAPTER_PAGINATION_CHANGED");
    }
  });
  it("fails closed when all-page or total-row limits cannot prove completeness", async () => {
    await expect(execute(dependencies({ total: 25, perPage: 2 }))).rejects.toThrow("ADAPTER_RESPONSE_LIMIT");
    await expect(execute(dependencies({ total: 501, perPage: 100 }))).rejects.toThrow("ADAPTER_RESPONSE_LIMIT");
  });
  it.each([202, 206, 302, 401, 403, 429, 500])("rejects HTTP %i instead of reporting empty", async status => {
    const deps = dependencies({ response: (url, response) => url.pathname.includes("/marketplace/") ? new Response("", { status, headers: response.headers }) : response });
    await expect(execute(deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : [401, 403].includes(status) ? "ACCESS_REQUIRED" : "ADAPTER_TRANSPORT_FAILED");
  });
  it("rejects oversized declarations, wrong content types and an expired original deadline", async () => {
    await expect(execute(dependencies({ response: (_url, response) => new Response(response.body, { headers: { ...Object.fromEntries(response.headers), "content-length": "2000001" } }) }))).rejects.toThrow("ADAPTER_RESPONSE_LIMIT");
    await expect(execute(dependencies({ response: (_url, response) => new Response(response.body, { headers: { "content-type": "application/octet-stream" } }) }))).rejects.toThrow("ADAPTER_RESPONSE_INVALID");
    const deps = dependencies(); await expect(executeChronogolf(source, metadata(), target, input, { ...deps, deadlineAt: new Date("2026-10-19") })).rejects.toThrow("DEADLINE_EXCEEDED"); expect(deps.reads).toHaveLength(0);
  });
  it("uses only actual bounded provider-profile redirect Locations and verifies the original numeric identity", async () => {
    const numeric = { ...source, bookingUrl: "https://www.chronogolf.com/club/10" }, deps = dependencies({ response: (url, response) => url.pathname === "/club/10" ?
      new Response(null, { status: 302, headers: { location: source.bookingUrl } }) : response });
    expect(await inspectChronogolf(numeric, deps)).toEqual(metadata());
    expect(deps.reads.slice(0, 2).map(url => url.href)).toEqual([numeric.bookingUrl, source.bookingUrl]);
    await expect(inspectChronogolf({ ...numeric, bookingUrl: "https://www.chronogolf.com/club/99" }, dependencies())).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["https://evil.example.org/club/public-pines", "/club/10/widget", "/club/public-pines-golf-club?account=1", "https://www.chronogolf.com/login", undefined, "/club/10"])
    ("rejects unsafe, missing or looping profile Location %s", async location => {
      const deps = dependencies({ response: (url, response) => url.pathname === "/club/10" ? new Response(null, { status: 302, headers: location ? { location } : {} }) : response });
      await expect(inspectChronogolf({ ...source, bookingUrl: "https://www.chronogolf.com/club/10" }, deps)).rejects.toThrow("ADAPTER_PROFILE_REDIRECT_INVALID");
      expect(deps.reads).toHaveLength(1);
    });
  it("rejects excessive profile hops and an already-followed response", async () => {
    const deps = dependencies({ response: url => new Response(null, { status: 302, headers: { location: `/club/${Number(url.pathname.split("/").at(-1)) + 1}` } }) });
    await expect(inspectChronogolf({ ...source, bookingUrl: "https://www.chronogolf.com/club/10" }, deps)).rejects.toThrow("ADAPTER_PROFILE_REDIRECT_INVALID"); expect(deps.reads).toHaveLength(3);
    const followed = dependencies({ response: (_url, response) => { Object.defineProperty(response, "redirected", { value: true }); return response; } });
    await expect(execute(followed)).rejects.toThrow("ADAPTER_TRANSPORT_FAILED");
  });
  it("cancels unused redirect, rejected status and bad-header bodies", async () => {
    for (const status of [302, 403, 200]) {
      const cancel = vi.fn(), deps = dependencies({ response: () => new Response(new ReadableStream({ cancel }), { status,
        headers: status === 302 ? { location: "https://evil.example.org/club/other" } : status === 200 ? { "content-type": "text/plain" } : {} }) });
      await expect(inspectChronogolf(source, deps)).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(1);
    }
  });
  it("integrates actual inspection/schema/fixed dispatch with unchanged slot identity across fresh edited inputs", async () => {
    const inspector = dependencies(), adapter = (await inspectExistingAdapter(source, { ...inspector, venueMatches: (a, b) => a === b })).adapter;
    const raw = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: target.courseId, kind: "OUTDOOR" }, source: { ...source, providerFamily: "CHRONOGOLF" }, adapter };
    const recipe = parseAccessRecipe(raw);
    expect(() => parseAccessRecipe({ ...raw, target: { ...raw.target, kind: "SIMULATOR", offeringId: "offering" } })).toThrow();
    expect(() => parseAccessRecipe({ ...raw, source: { ...raw.source, venueAddress: undefined } })).toThrow();
    if (recipe.engine !== "EXISTING_ADAPTER") throw new Error("WRONG_ENGINE");
    for (const requested of [input, { ...input, date: "2026-10-24", players: 3 }]) {
      const deps = dependencies({ pages: [[row(1, requested.date)]], perPage: 24 });
      const result = await executeExistingAdapterRecipe(recipe, requested, { ...deps, venueMatches: (a, b) => a === b, recipeHash: hashAccessRecipe(recipe),
        toInstant(value) { return new Date(new Date(`${String(value)}Z`).getTime() + 7 * 3600_000); } });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { completeVerified: true, dateVerified: true, venueVerified: true } });
      expect(result.slots[0]).toMatchObject({ sourceId: `chronogolf-${row(1).uuid}`, availableSpots: 4 });
      expect(result.slots[0].holes).toBeUndefined(); expect(result.slots[0]).not.toHaveProperty("priceCents");
      expect(deps.reads.at(-1)!.searchParams.get("free_slots")).toBe(String(requested.players));
    }
  });
});
