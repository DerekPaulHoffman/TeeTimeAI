// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeChronogolf, inspectChronogolf } from "./chronogolf-executor";
import { CHRONOGOLF_READ_CLIENTS, parseChronogolfProfile } from "./chronogolf-source";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";

// Tiny inert clients qualify offline wiring only. Production verifies the
// reviewed bytes; an unknown or changed body still hashes normally and fails.
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import type { NativeOfficialPageReader } from "./native-official-page-reader";

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
  it("accepts a public round label and an unpadded morning hour with exact public identity", async () => {
    const value = row(1);
    value.starts_at = `${input.date}T16:30:00Z`; value.start_time = "9:30";
    value.default_price.affiliation_type = "Public 9 Holes";
    expect(await execute(dependencies({ pages: [[value]], perPage: 24 }))).toHaveLength(1);
    for (const change of [
      (r: Row) => { r.default_price.affiliation_type = "Public 18 Holes"; },
      (r: Row) => { r.default_price.affiliation_type = "Public 9 Holes Members"; },
      (r: Row) => { r.default_price.player_type_id++; },
      (r: Row) => { r.start_time = "9:31"; },
    ]) {
      const conflict = structuredClone(value); change(conflict);
      await expect(execute(dependencies({ pages: [[conflict]], perPage: 24 }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
    }
  });
  it("forwards private phone corroboration through the fixed inspector and revalidates it on replay", async () => {
    const identity = { ...source, venueName: "Exampleton", venueAddress: "123 Fairway Drive, Example City, MA 01234, USA", timeZone: "America/New_York" };
    const profile = { ...club(), name: "Exampleton Golf Links", city: "Example City", province: "Massachusetts", postcode: "1234",
      timezone: identity.timeZone, phone: "(413) 555-0100", courses: [{ ...course, name: "Exampleton Golf Links" }] };
    const trustedContext = { canonicalCoursePhone: "+14135550100" }, inspection = dependencies({ profile: html(profile) });
    const saved = await inspectChronogolf(identity, { ...inspection, trustedContext });
    expect(inspection.reads).toHaveLength(3);
    expect(saved).toEqual(parseChronogolfProfile(html(profile), identity.bookingUrl, identity, undefined, trustedContext));
    const bridge = await inspectExistingAdapter(identity, { ...dependencies({ profile: html(profile) }), trustedContext, venueMatches: (a, b) => a === b });
    expect(bridge.adapter).toEqual(saved);
    for (const context of [undefined, { canonicalCoursePhone: "+14135550101" }]) {
      const rejected = dependencies({ profile: html(profile) });
      await expect(inspectChronogolf(identity, { ...rejected, trustedContext: context })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
      expect(rejected.reads).toHaveLength(1);
      const rejectedReplay = dependencies({ profile: html(profile) });
      await expect(executeChronogolf(identity, saved, target, { ...input, timeZone: identity.timeZone }, { ...rejectedReplay, trustedContext: context })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
      expect(rejectedReplay.reads).toHaveLength(1);
    }
    const requested = { ...input, timeZone: identity.timeZone }, replay = dependencies({ profile: html(profile), pages: [[]], total: 0, perPage: 24 });
    expect(await executeChronogolf(identity, saved, target, requested, { ...replay, trustedContext })).toEqual([]);
    expect(replay.reads.at(-1)!.pathname).toBe("/marketplace/v2/teetimes");
    const changedProfile = { ...profile, phone: "(413) 555-0101" }, changedContext = { canonicalCoursePhone: "+14135550101" };
    const changed = dependencies({ profile: html(changedProfile) });
    await expect(executeChronogolf(identity, saved, target, requested, { ...changed, trustedContext: changedContext })).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(changed.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
    const changedSource = dependencies({ profile: html(profile) });
    await expect(executeChronogolf({ ...identity, venueName: "Other Exampleton" }, saved, target, requested, { ...changedSource, trustedContext })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(changedSource.reads).toHaveLength(1);
    expect(identity.venueName).toBe("Exampleton");
  });
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
    for (const affiliation_type of ["Members only", "VIP", "Visitors", "Public member", "Public - Preferred", "Public - Member", "Public - Resident",
      "Public - Promotion", "Public - Other", "Public - Standard member", "Public - Standard*", "Publicly - Standard"]) {
      const value = row(1); value.default_price.affiliation_type = affiliation_type;
      await expect(execute(dependencies({ pages: [[value]], perPage: 24 }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
    }
    const value = row(1); value.default_price.affiliation_type = " Public* ";
    expect(await execute(dependencies({ pages: [[value]], perPage: 24 }))).toHaveLength(1);
  });
  it("reads every page of the exact standard public class while retaining the profile's public type ID fence", async () => {
    const rows = Array.from({ length: 27 }, (_, i) => { const value = row(i + 1); value.default_price.affiliation_type = "Public - Standard"; return value; });
    const deps = dependencies({ pages: [rows.slice(0, 24), rows.slice(24)], perPage: 24 });
    expect(await execute(deps)).toHaveLength(27);
    expect(deps.reads.filter(url => url.pathname.includes("/marketplace/")).map(url => url.searchParams.get("page"))).toEqual(["1", "2"]);
    const wrongType = structuredClone(rows[0]); wrongType.default_price.player_type_id++;
    await expect(execute(dependencies({ pages: [[wrongType]], perPage: 24 }))).rejects.toThrow("ADAPTER_SLOT_MISMATCH");
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
  it("reads only the derived same-club profile for an observed public widget and rebinds it on warm replay", async () => {
    const widgetUrl = "https://www.chronogolf.com/club/10/widget?target=_blank&source=chronogolf&medium=profile";
    const widgetSource = { ...source, bookingUrl: widgetUrl };
    const inspection = dependencies(), saved = await inspectChronogolf(widgetSource, inspection);
    expect(saved).toMatchObject({ clubId: 10, profileUrl: source.bookingUrl, widgetSourceUrl: widgetUrl });
    expect(inspection.reads.map(url => url.href)).toEqual(["https://www.chronogolf.com/club/10", ...CHRONOGOLF_READ_CLIENTS.map(client => client.url)]);
    const fixed = await inspectExistingAdapter(widgetSource, { ...dependencies(), venueMatches: (a, b) => a === b });
    expect(fixed.adapter).toEqual(saved);
    const parsed = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: target.courseId, kind: "OUTDOOR" },
      source: { ...widgetSource, providerFamily: "CHRONOGOLF" }, adapter: fixed.adapter });
    expect(parsed.engine).toBe("EXISTING_ADAPTER");
    const changed = { ...input, date: "2026-10-24", players: 3 }, replay = dependencies({ pages: [[row(1, changed.date)]], total: 1, perPage: 24 });
    const slots = await executeChronogolf(widgetSource, saved, target, changed, replay);
    expect(slots).toHaveLength(1);
    expect(slots[0].bookingUrl).toBe(`${source.bookingUrl}?date=${changed.date}&step=teetimes`);
    expect(replay.reads.every(url => url.href !== widgetUrl)).toBe(true);
    expect(replay.reads.at(-1)!.searchParams.get("free_slots")).toBe("3");
    for (const changedSource of [{ ...widgetSource, bookingUrl: widgetUrl.replace("/10/", "/11/") },
      { ...widgetSource, bookingUrl: source.bookingUrl },
      { ...widgetSource, bookingUrl: widgetUrl.replace("medium=profile", "medium=booking") }]) {
      const deps = dependencies();
      await expect(executeChronogolf(changedSource, saved, target, input, deps)).rejects.toThrow();
      expect(deps.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
    }
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

describe("Chronogolf canonical-root host corroboration on every configuration read", () => {
  const outdated = () => ({ ...club(), website: "http://outdated-public.example.net/" });
  function official(mutate?: (page: OfficialIdentityPage) => void) {
    const page: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME",
      html: `<html><head><title>${source.venueName}</title></head><body><h1>${source.venueName}</h1><address>${source.venueAddress}</address><a href="${source.bookingUrl}">Book Tee Times</a></body></html>`,
      visibleEvidence: { title: source.venueName, headings: [source.venueName], addressTexts: [source.venueAddress], linkUrls: [source.bookingUrl] } };
    mutate?.(page);return registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30000));
  }
  const nativeReader = (mutate?: (page: OfficialIdentityPage) => void) => vi.fn<NativeOfficialPageReader>(async (identity, url, end) => {
    expect(identity).toEqual(source);expect(url).toBe(source.officialUrl);expect(end.getTime()).toBeGreaterThan(Date.now());return official(mutate);
  });
  it("leaves same-host HTTP inspection unchanged and never invokes a native reader", async () => {
    const readNativeOfficialPage = nativeReader(), deps = { ...dependencies(), readNativeOfficialPage };
    expect(await inspectChronogolf(source, deps)).toEqual(metadata());expect(readNativeOfficialPage).not.toHaveBeenCalled();
  });
  it("uses the canonical root only after all other identity checks and returns unchanged typed metadata", async () => {
    const readNativeOfficialPage = nativeReader(), deps = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
    const adapter = await inspectChronogolf(source, deps);
    expect(adapter).toMatchObject({ family: "CHRONOGOLF", clubId: club().id, profileUrl: source.bookingUrl });
    expect(Object.keys(adapter).sort()).toEqual(Object.keys(metadata()).sort());
    expect(readNativeOfficialPage).toHaveBeenCalledTimes(1);expect(deps.reads.every(url => url.origin === "https://www.chronogolf.com")).toBe(true);
    expect(deps.reads.some(url => url.hostname === "outdated-public.example.net")).toBe(false);
    const inspected = await inspectExistingAdapter(source, { ...deps, venueMatches: (a, b) => a === b });
    expect(inspected.adapter).toEqual(adapter);
  });
  it("re-earns the official root for each warm date/player execution rather than trusting saved metadata", async () => {
    const first = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage: nativeReader() };
    const saved = await inspectChronogolf(source, first);
    for (const requested of [input, { ...input, date: "2026-10-24", players: 3 }]) {
      const readNativeOfficialPage = nativeReader(), deps = { ...dependencies({ profile: html(outdated()), pages: [[row(1, requested.date)]], perPage: 24 }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
      expect(await executeChronogolf(source, saved, target, requested, deps)).toHaveLength(1);
      expect(readNativeOfficialPage).toHaveBeenCalledTimes(1);
      expect(deps.reads.at(-1)!.searchParams.get("start_date")).toBe(requested.date);expect(deps.reads.at(-1)!.searchParams.get("free_slots")).toBe(String(requested.players));
    }
    const readNativeOfficialPage = nativeReader(page => { page.visibleEvidence!.linkUrls = []; });
    const deps = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
    await expect(executeChronogolf(source, saved, target, input, deps)).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(deps.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
  });
  it("inspects and re-earns a heading-free two-scalar footer through both fresh date/player reads", async () => {
    const printedFooter = (page: OfficialIdentityPage) => {
      page.html = `<html><head><title>Welcome to ${source.venueName}</title></head><body><footer><address><span class="h5">${source.venueName}</span><span>${source.venueAddress}</span></address></footer><a href="${source.bookingUrl}">Book Tee Times</a></body></html>`;
      page.visibleEvidence!.headings = [];page.visibleEvidence!.publicBusinessLabels = [source.venueName];page.visibleEvidence!.addressTexts = [source.venueName + ", " + source.venueAddress];
    };
    const make = (requested = input) => ({ ...dependencies({ profile: html(outdated()), pages: [[row(1, requested.date)]], perPage: 24 }),
      now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage: nativeReader(printedFooter) });
    const inspection = make(), saved = await inspectChronogolf(source, inspection);expect(inspection.readNativeOfficialPage).toHaveBeenCalledTimes(1);
    for (const requested of [input, { ...input, date: "2026-10-24", players: 3 }]) {
      const deps = make(requested);expect(await executeChronogolf(source, saved, target, requested, deps)).toHaveLength(1);expect(deps.readNativeOfficialPage).toHaveBeenCalledTimes(1);
      expect(deps.reads.at(-1)!.searchParams.get("start_date")).toBe(requested.date);expect(deps.reads.at(-1)!.searchParams.get("free_slots")).toBe(String(requested.players));
    }
    const changed = make();changed.readNativeOfficialPage = nativeReader(page => { printedFooter(page);page.visibleEvidence!.publicBusinessLabels = []; });
    await expect(executeChronogolf(source, saved, target, input, changed)).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(changed.reads.every(url => !url.pathname.includes("/marketplace/"))).toBe(true);
  });
  it("requires local capability only for a host mismatch and does not ask native Chrome to repair other identity failures", async () => {
    const readNativeOfficialPage = nativeReader(), deps = { ...dependencies({ profile: html(outdated()) }), readNativeOfficialPage };
    await expect(inspectChronogolf(source, deps)).rejects.toThrow("LOCAL_CHROME_REQUIRED");expect(readNativeOfficialPage).not.toHaveBeenCalled();
    for (const change of [{ name: "Other Public Club" }, { address: "124 Fairway Drive" }, { slug: "other-club" }, { timezone: "America/New_York" }]) {
      const current = { ...dependencies({ profile: html({ ...outdated(), ...change }) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
      await expect(inspectChronogolf(source, current)).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
      expect(readNativeOfficialPage).not.toHaveBeenCalled();expect(current.reads).toHaveLength(1);
    }
    const duplicate = outdated();duplicate.courses.push(structuredClone(duplicate.courses[0]));
    const ambiguous = { ...dependencies({ profile: html(duplicate) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, readNativeOfficialPage };
    await expect(inspectChronogolf(source, ambiguous)).rejects.toThrow("ADAPTER_CATALOG_AMBIGUOUS");expect(readNativeOfficialPage).not.toHaveBeenCalled();
  });
  it("can reuse only an already fresh original canonical-page object; a copy requires a new owned read", async () => {
    const page = official(), readNativeOfficialPage = nativeReader(), deps = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const, officialIdentityPage: page, readNativeOfficialPage };
    await inspectChronogolf(source, deps);expect(readNativeOfficialPage).not.toHaveBeenCalled();
    await inspectChronogolf(source, { ...deps, officialIdentityPage: structuredClone(page) });expect(readNativeOfficialPage).toHaveBeenCalledTimes(1);
  });
  it("preserves the existing deadline and propagates a failed owned native read before any client or date request", async () => {
    const failed = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(), localCapabilities: ["LOCAL_CHROME"] as const,
      readNativeOfficialPage: vi.fn(async () => { throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED"); }) };
    await expect(inspectChronogolf(source, failed)).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");expect(failed.reads).toHaveLength(1);
    let now = Date.now();
    const expired = { ...dependencies({ profile: html(outdated()) }), now: () => new Date(now), localCapabilities: ["LOCAL_CHROME"] as const,
      readNativeOfficialPage: vi.fn(async () => { now += 90000;return official(); }) };
    await expect(inspectChronogolf(source, expired)).rejects.toThrow("DEADLINE_EXCEEDED");expect(expired.reads).toHaveLength(1);
  });
});
