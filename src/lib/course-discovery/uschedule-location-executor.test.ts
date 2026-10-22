import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { recipeTimeToInstant } from "./executor";
import type { ExistingAdapterRecipe } from "./existing-adapter-schema";
import { executeUSchedulePublicLocation, inspectUSchedulePublicLocation } from "./uschedule-location-executor";
import { deriveUScheduleOfficialLocation, readUScheduleLocationCatalog } from "@/lib/simulators/providers/uschedule-location-source";
import { prepareUScheduleLocationCatalog } from "@/lib/simulators/providers/uschedule";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";

// Only the static client byte witness is synthetic. Production still requires
// its reviewed literal pin; transport, catalog, policy and replay remain real.
vi.mock("@/lib/simulators/providers/uschedule-location-source", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/simulators/providers/uschedule-location-source")>();
  return { ...actual, USCHEDULE_LOCATION_CLIENT: { ...actual.USCHEDULE_LOCATION_CLIENT,
    sha256: createHash("sha256").update("synthetic reviewed public client").digest("hex") } };
});

const source = { officialUrl: "https://example.org/", bookingUrl: "https://clients.uschedule.com/examplegolf/booking",
  venueName: "Example Indoor Golf Club", venueAddress: "10 Main Street Suite 102, Example, WA 98000, USA",
  providerFamily: "USCHEDULE", timeZone: "America/Los_Angeles" };
const entry = `${source.bookingUrl}?filter=loc[82]`, client = `https://clients.uschedule.com/bundles/js/bookingBS5?v=${"a".repeat(44)}`;
const officialHtml = `<html><body><h1>${source.venueName}</h1><p>${source.venueAddress}</p><a href="${entry}">Book tee times</a></body></html>`;
const officialPage = { url: source.officialUrl, html: officialHtml, visibleEvidence: { title: source.venueName,
  headings: [source.venueName], linkUrls: [entry], addressTexts: [source.venueAddress] } };
const input = { date: "2030-10-23", players: 2, durationMinutes: 60, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone };
function catalog(state: { location: string; service: string; duration: string; date: string }, options: { empty?: boolean; incomplete?: boolean } = {}) {
  const date = state.date, [year, month, day] = date.split("-");
  const later = new Date(`${date}T12:00:00Z`); later.setUTCDate(later.getUTCDate() + 1);
  const encode = (value: string, hour: string) => `${value.slice(5, 7)}${value.slice(8, 10)}${value.slice(0, 4)}${hour}00`;
  const times = [...(options.empty ? [] : [encode(date, "08")]), ...(options.incomplete ? [] : [encode(later.toISOString().slice(0, 10), "08")])];
  const location = state.location === "82" ? "Example" : "Other";
  return `<html><body class="examplegolf"><div class="col-lg-4 order-1"><div id="location_section"><select id="select_location"><option value="81" ${state.location === "81" ? "selected" : ""}>Other Indoor Golf Club</option><option value="82" ${state.location === "82" ? "selected" : ""}>${source.venueName}</option></select></div>
    <div id="service_section"><select id="select_service"><option value="73" ${state.service === "73" ? "selected" : ""}>Non-Member Hourly Rental</option><option value="74" ${state.service === "74" ? "selected" : ""}>Example Lesson</option></select></div>
    <select id="select_length"><option value="60" ${state.duration === "60" ? "selected" : ""}>1 hour</option><option value="120" ${state.duration === "120" ? "selected" : ""}>2 hours</option></select>
    <div id="res_section"><label class="choose_label" for="resource55">Simulators - ${location}</label><select id="resource55" class="resSelect"><option value="-1" selected>Any Available</option><option value="91">${location} - Bay 1</option></select></div>
    <select id="addon77" class="addOnSelect"><option value="0" selected>0</option><option value="1">1</option></select>
    <div class="card my-3"><div class="card-body"><p>Simulators:</p><p>Additional Guest(s):</p><ul><li>Non-members may bring 1 guest for free.</li><li>You may add 2 additional guests if you wish. The charge is $25 per person/per hour. Max of 4 people in the bay.</li></ul></div></div></div>
    <div id="right_column"><div class="serv_only_desc"><div id="serv_desc_section"><p>Non-Member Tee Time Guidelines</p><ul><li>Non-members reservations include 1 guest, for free.</li></ul></div></div></div>
    ${times.map(time => `<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="0"><div>Public start</div><div>Non-Member Hourly Rental - $40.00</div></div></div>`).join("")}
    <script>var chosenDate = new Date(${year},${Number(month) - 1},${Number(day)}); var lastAvailTime = '${times.at(-1) ?? ""}';</script>
    <script src="${client}"></script></body></html>`;
}
function fixture(options: { status?: number; changedClient?: boolean; changedOfficial?: boolean; empty?: boolean; incomplete?: boolean;
  redirect?: string; changedCookie?: boolean; ignoredLocation?: boolean } = {}) {
  const state = { location: "81", service: "73", duration: "60", date: "2030-10-22" };
  const posts: Array<{ Name: string; Value: string }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = String(value); expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (url === source.officialUrl) return new Response(options.changedOfficial ? officialHtml.replace("Suite 102", "Suite 103") : officialHtml,
      { headers: { "content-type": "text/html" } });
    if (options.status) return new Response("Public scheduler unavailable", { status: options.status });
    if (options.redirect && url === new URL(entry).href) return new Response("Public document moved", { status: 302, headers: {
      "content-type": "text/html", location: options.redirect, "set-cookie": "ASP.NET_SessionId=SyntheticAnonymous123; Path=/; HttpOnly" } });
    if (url === client) return new Response(options.changedClient ? "changed client" : "synthetic reviewed public client", { headers: { "content-type": "application/javascript" } });
    if (init?.method === "POST") {
      expect(url).toBe(`${source.bookingUrl}/changefield`);
      const rows = JSON.parse(String(init.body)); expect(rows).toHaveLength(1);
      const row = rows[0] as { Name: string; Value: string }; posts.push(row);
      if (row.Name === "location_id") { if (!options.ignoredLocation) state.location = row.Value; }
      else if (row.Name === "service_id") state.service = row.Value;
      else if (row.Name === "length") state.duration = row.Value;
      else if (row.Name === "start_date") { const [month, day, year] = row.Value.split("/"); state.date = `${year}-${month}-${day}`; }
      else throw new Error("Unexpected public filter");
      return Response.json({ code: "refresh" });
    }
    expect(url).toBe(options.redirect ? source.bookingUrl : new URL(entry).href);
    return new Response(catalog(state, options), { headers: { "content-type": "text/html", "set-cookie": `ASP.NET_SessionId=${options.changedCookie ? "DifferentAnonymous123" : "SyntheticAnonymous123"}; Path=/; HttpOnly` } });
  });
  let active = 0, maxActive = 0;
  const requestLease = vi.fn(async <T>(_family: string, work: () => Promise<T>) => {
    active++; maxActive = Math.max(active, maxActive);
    try { return { acquired: true as const, value: await work() }; } finally { active--; }
  });
  return { fetch, posts, requestLease, deps: { fetch, requestLease, officialIdentityPage: officialPage, venueMatches: () => true,
    now: () => new Date("2030-10-20T12:00:00Z"), toInstant: recipeTimeToInstant }, maxActive: () => maxActive, active: () => active };
}
function metadata() {
  const official = deriveUScheduleOfficialLocation(source, officialPage);
  return { family: "USCHEDULE" as const, tenant: "examplegolf", serviceId: "73", serviceName: "Non-Member Hourly Rental",
    publicLocationProof: readUScheduleLocationCatalog(catalog({ location: "82", service: "73", duration: "60", date: input.date }), entry, official).proof };
}
describe("fresh official-location public rental replay", () => {
  it("inspects the official location and replays changed date/duration without addon, group, bay or appointment mutations", async () => {
    const transport = fixture();
    const { adapter } = await inspectExistingAdapter(source, transport.deps);
    expect(adapter).toMatchObject({ family: "USCHEDULE", serviceId: "73", publicLocationProof: { locationId: "82", includedPartySize: 2, maxPartySize: 4 } });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }) as ExistingAdapterRecipe;
    for (const request of [input, { ...input, date: "2030-10-24", durationMinutes: 120 }]) {
      const result = await executeExistingAdapterRecipe(recipe, request, { ...transport.deps, recipeHash: "a".repeat(64) });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]).toMatchObject({ resourceId: "uschedule-location:82:pooled", availableSpots: 1, capacity: 4, bookingUrl: source.bookingUrl,
        startsAt: `${request.date}T15:00:00.000Z`, endsAt: `${request.date}T${request.durationMinutes === 60 ? "16" : "17"}:00:00.000Z` });
    }
    expect(new Set(transport.posts.map(row => row.Name))).toEqual(new Set(["location_id", "length", "start_date"]));
    expect(transport.maxActive()).toBe(1); expect(transport.active()).toBe(0);
    expect(() => parseAccessRecipe({ ...recipe, source: { ...source, venueAddress: undefined } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...adapter, publicLocationProof: undefined } })).toThrow();
  });
  it("limits eligibility to the two included people before any transport work", async () => {
    const transport = fixture();
    await expect(executeUSchedulePublicLocation(source, metadata(), { courseId: "course", offeringId: "offering" }, { ...input, players: 3 }, transport.deps)).rejects.toThrow("USCHEDULE_INCLUDED_PARTY_UNSUPPORTED");
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it.each([[403, "ACCESS_REQUIRED"], [429, "PROVIDER_THROTTLED"]] as const)("preserves trusted HTTP %i through local reader wrapping", async (status, expected) => {
    const transport = fixture({ status });
    await expect(inspectUSchedulePublicLocation(source, transport.deps)).rejects.toThrow(expected);
    await expect(executeUSchedulePublicLocation(source, metadata(), { courseId: "course", offeringId: "offering" }, input, transport.deps)).rejects.toThrow(expected);
    expect(transport.active()).toBe(0);
  });
  it.each(["changedClient", "changedOfficial", "incomplete"] as const)("fails closed before certifying an altered %s", async change => {
    const transport = fixture({ [change]: true });
    await expect(executeUSchedulePublicLocation(source, metadata(), { courseId: "course", offeringId: "offering" }, input, transport.deps)).rejects.toBeInstanceOf(Error);
    expect(transport.active()).toBe(0);
  });
  it("can certify EMPTY only after an actual later-date witness with the requested filters intact", async () => {
    const transport = fixture({ empty: true });
    const result = await executeUSchedulePublicLocation(source, metadata(), { courseId: "course", offeringId: "offering" }, input, transport.deps);
    expect(result).toMatchObject({ complete: true, slots: [] });
    expect(transport.posts.at(-1)).toEqual({ Name: "start_date", Value: "10/23/2030" });
  });
  it("bootstraps only the actual filtered-entry302 to canonical document and corrects a fresh other-location default", async () => {
    const transport = fixture({ redirect: "/examplegolf/booking" });
    const observed = await inspectUSchedulePublicLocation(source, transport.deps);
    expect(observed.publicLocationProof.official.entryUrl).toBe(entry);
    const available = await executeUSchedulePublicLocation(source, observed, { courseId: "course", offeringId: "offering" }, input, transport.deps);
    expect(available).toMatchObject({ complete: true, slots: [expect.objectContaining({ resourceId: "uschedule-location:82:pooled" })] });
    expect(transport.posts[0]).toEqual({ Name: "location_id", Value: "82" });
    expect(transport.fetch.mock.calls.filter(([, init]) => init?.method === "POST").every(([, init]) => new Headers(init?.headers).get("referer") === source.bookingUrl)).toBe(true);
  });
  it.each(["https://foreign.example.org/booking", "/othergolf/booking", "/examplegolf/booking?location=82", "/examplegolf/booking#time", "/examplegolf/booking/changefield"])("never follows an altered bootstrap Location: %s", async redirect => {
    const transport = fixture({ redirect });
    await expect(inspectUSchedulePublicLocation(source, transport.deps)).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledOnce(); expect(transport.posts).toEqual([]);
  });
  it.each(["changedCookie", "ignoredLocation"] as const)("rejects bootstrap continuity failure: %s", async kind => {
    const transport = fixture({ redirect: "/examplegolf/booking", [kind]: true });
    await expect(inspectUSchedulePublicLocation(source, transport.deps)).rejects.toThrow();
  });
  it("never dispatches resource, party, addon or transaction fields after valid anonymous bootstrap", async () => {
    const transport = fixture({ redirect: "/examplegolf/booking" }), official = metadata().publicLocationProof.official;
    const session = createUSchedulePublicSession(official.entryUrl, { ...transport.deps, officialLocation: official });
    try {
      await prepareUScheduleLocationCatalog(official, session.read, AbortSignal.timeout(10_000));
      const before = transport.fetch.mock.calls.length;
      for (const Name of ["group_size", "resource55", "addon77", "time", "book", "customer", "sms", "payment", "location_id", "service_id"]) {
        await expect(session.read(`${source.bookingUrl}/changefield`, { method: "POST", headers: { "content-type": "application/json",
          origin: "https://clients.uschedule.com", referer: source.bookingUrl }, body: JSON.stringify([{ Name, Value: "999" }]) })).rejects.toThrow();
      }
      expect(transport.fetch).toHaveBeenCalledTimes(before);
    } finally { session.dispose(); }
  });
});
