import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deriveUScheduleOfficialLocation, readUScheduleLocationCatalog } from "./uschedule-location-source";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "@/lib/course-discovery/existing-adapter-executor";
import { parseAccessRecipe } from "@/lib/course-discovery/recipe";
import { registerFreshNativeOfficialIdentityPage } from "@/lib/course-discovery/native-official-page-attestation";
import { recipeTimeToInstant } from "@/lib/course-discovery/executor";
import type { OfficialIdentityPage } from "@/lib/course-discovery/teeitup-official-identity";
import type { ExistingAdapterRecipe } from "@/lib/course-discovery/existing-adapter-schema";

vi.mock("./uschedule-location-source", async original => {
  const value = await original<typeof import("./uschedule-location-source")>();
  return { ...value, USCHEDULE_LOCATION_CLIENT: { ...value.USCHEDULE_LOCATION_CLIENT, sha256: createHash("sha256").update("owned client").digest("hex") } };
});
const source = { officialUrl: "https://example.org/Locations/Example", bookingUrl: "https://clients.uschedule.com/examplegolf/booking?filter=loc[82]",
  venueName: "Example Indoor Golf Club", venueAddress: "10 Main Dr C, Example, WA 98000, USA", timeZone: "America/Los_Angeles", providerFamily: "USCHEDULE" };
const canonical = source.bookingUrl.split("?")[0], phone = "+14255550123", client = `https://clients.uschedule.com/bundles/js/bookingBS5?v=${"a".repeat(44)}`;
function page(): OfficialIdentityPage {
  return { url: source.officialUrl, browserTransport: "NATIVE_CHROME", html: `<body><form method="post" action="/Locations/Example"><header><a href="https://example.org/"><img alt="${source.venueName}"></a></header><h1>Example, WA</h1><div><p>425-555-0123</p><p>10 Main Drive, Suite C, Example, WA 98000</p></div><a href="${source.bookingUrl}">Book a tee time</a><footer>Public location</footer></form></body>`,
    visibleEvidence: { title: "Example", headings: ["Example, WA"], linkUrls: [source.bookingUrl], addressTexts: ["10 Main Drive, Suite C, Example, WA 98000"], phoneTexts: ["425-555-0123"], brandLinks: [{ href: "https://example.org/", text: source.venueName }] } };
}
const official = () => deriveUScheduleOfficialLocation(source, page(), true, undefined, { canonicalCoursePhone: phone });
type State = { date: string; length: number; location: string; service: string };
function catalog(state: State, max: number | null = 4) {
  const key = (hour: string) => `${state.date.slice(5, 7)}${state.date.slice(8)}${state.date.slice(0, 4)}${hour}00`;
  return `<body class="examplegolf"><div class="row"><div class="col-lg-4 order-1"><div id="location_section"><label for="select_location">Choose a Location</label><select id="select_location"><option value="82" ${state.location === "82" ? "selected" : ""}>Example - ${source.venueName}</option><option value="83" ${state.location === "83" ? "selected" : ""}>Other - ${source.venueName}</option></select></div><div id="service_section"><select id="select_service"><option value="72" selected>${state.service === "72" ? "Simulator Rental - Example" : "Golf Lesson - Example"}</option></select></div><label for="select_length">Choose Service Time</label><select id="select_length">${[60, 90, 120].map(n => `<option value="${n}" ${state.length === n ? "selected" : ""}>${n} minutes</option>`).join("")}</select></div>
    <div class="col-lg-4 order-3 order-lg-2"><div class="choices pt-2"><div class="row time_choices"><div class="col timeslot" data-time="${key("10")}"><span>10:00 AM</span></div><div class="col timeslot" data-time="${key("11")}"><span>11:00 AM</span></div></div></div><div class="card my-3"><p>${max === null ? "Public simulator rental." : `** Max of ${max} golfers playing per bay **`}</p></div></div></div>
    <script>var chosenDate = new Date(${state.date.slice(0, 4)},${Number(state.date.slice(5, 7)) - 1},${Number(state.date.slice(8))});</script><script src="${client}"></script></body>`;
}
function fixture(mutate: (html: string, state: State) => string = h => h, max: number | null = 4) {
  const state: State = { date: "2030-10-22", length: 60, location: "82", service: "72" }, posts: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url) === source.bookingUrl) return new Response("Redirect", { status: 302, headers: { location: canonical, "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=OwnedSession12345; HttpOnly" } });
    if (String(url) === client) return new Response("owned client", { headers: { "content-type": "application/javascript" } });
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body)); posts.push(Name);
      if (Name === "length") state.length = Number(Value);
      else if (Name === "start_date") state.date = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
      else throw Error("Unexpected public filter");
      return Response.json({ code: "refresh" });
    }
    return new Response(mutate(catalog(state, max), state), { headers: { "content-type": "text/html" } });
  });
  const deps = { fetch, requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }), officialIdentityPage: page(),
    trustedContext: { canonicalCoursePhone: phone }, localCapabilities: ["LOCAL_CHROME"] as const, venueMatches: () => true, now: () => new Date("2030-10-20T12:00:00Z"), toInstant: recipeTimeToInstant, recipeHash: "a".repeat(64),
    readNativeOfficialPage: async () => registerFreshNativeOfficialIdentityPage(page(), source.officialUrl, new Date(Date.now() + 30000)) };
  return { fetch, posts, deps };
}
function extraGrid(html: string, state: State, expanded: boolean) {
  const key = (hour: string) => `${state.date.slice(5, 7)}${state.date.slice(8)}${state.date.slice(0, 4)}${hour}00`;
  return html.replace('</div></div><div class="card my-3">',
    `${[12, 13].map(hour => `<div class="col timeslot ${expanded ? "" : "d-none "}extra" data-time="${key(String(hour))}"><span>${hour % 12 || 12}:00 PM</span></div>`).join("")}` +
    `<div id="show-extra-row" class="w-100"${expanded ? ' style="display:none;"' : ""}><span class="no_time">Show Additional Times (<text>2</text> more)</span></div>` +
    `<div id="hide-extra-row" class="w-100"${expanded ? "" : ' style="display:none;"'}><span class="no_time">Hide Additional Times</span></div></div></div><div class="card my-3">`);
}
describe("strict branch-contact public location service pool", () => {
  it.each([false, true])("reads every extra in a coherent expanded=%s location grid", async expanded => {
    const cold = fixture(), { adapter } = await inspectExistingAdapter(source, cold.deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }) as ExistingAdapterRecipe;
    const f = fixture((html, state) => extraGrid(html, state, expanded));
    const result = await executeExistingAdapterRecipe(recipe, { date: "2030-10-23", players: 2, durationMinutes: 60, timeZone: source.timeZone, startTime: "09:00", endTime: "18:00" }, f.deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true }); expect(result.slots).toHaveLength(4);
    expect(result.slots.every(row => row.availableSpots === 1 && row.capacity === 4 && row.resourceId === "uschedule-location:82:service:72:pooled")).toBe(true);
    expect(f.posts).toEqual(["length", "start_date"]);
  });
  it.each(["mixed extras", "both visible", "both hidden", "class hidden toggle", "private toggle", "wrong count", "show handler", "hide handler", "private extra", "wrong date", "out of order", "duplicate selected", "hidden parent", "hidden style", "orphan row"])
  ("rejects expanded location grid with %s", async change => {
    const cold = fixture(), { adapter } = await inspectExistingAdapter(source, cold.deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }) as ExistingAdapterRecipe;
    const f = fixture((html, state) => {
      let value = extraGrid(html, state, true);
      if (change === "mixed extras") value = value.replace('col timeslot extra', 'col timeslot d-none extra');
      if (change === "both visible") value = value.replace('class="w-100" style="display:none;"', 'class="w-100"');
      if (change === "both hidden") value = value.replace('id="hide-extra-row" class="w-100"', 'id="hide-extra-row" class="w-100" style="display:none;"');
      if (change === "class hidden toggle") value = value.replace('id="hide-extra-row" class="w-100"', 'id="hide-extra-row" class="w-100 d-none"');
      if (change === "private toggle") value = value.replace('id="hide-extra-row" class="w-100"', 'id="hide-extra-row" class="w-100 private"');
      if (change === "wrong count") value = value.replace('<text>2</text>', '<text>3</text>');
      if (change === "show handler") value = value.replace('id="show-extra-row"', 'id="show-extra-row" onclick="choose()"');
      if (change === "hide handler") value = value.replace('id="hide-extra-row"', 'id="hide-extra-row" onclick="choose()"');
      if (change === "private extra") value = value.replace('col timeslot extra', 'col timeslot extra private');
      if (change === "wrong date") value = value.replace(/data-time="(\d{2})\d{2}(\d{4})1200"/u, 'data-time="$101$21200"');
      if (change === "out of order") value = value.replace(/data-time="(\d{8})1200"/u, 'data-time="$11000"');
      if (change === "duplicate selected") value = value.replaceAll('col timeslot extra', 'col timeslot selected extra');
      if (change === "hidden parent") value = value.replace('class="choices pt-2"', 'class="choices pt-2" hidden');
      if (change === "hidden style") value = value.replace('display:none;', 'display:none;visibility:hidden;');
      if (change === "orphan row") value += '<div class="col timeslot" data-time="102320301400"><span>2:00 PM</span></div>';
      return value;
    });
    expect(await executeExistingAdapterRecipe(recipe, { date: "2030-10-23", players: 2, durationMinutes: 60, timeZone: source.timeZone, startTime: "09:00", endTime: "18:00" }, f.deps)).toMatchObject({ status: "INCOMPLETE", slots: [] });
  });
  it("binds an actual branch heading, canonical brand, full same suite, phone and exact location edge", () => {
    expect(official()).toMatchObject({ kind: "OFFICIAL_PUBLIC_LOCATION_CONTACT_V1", locationId: "82", locality: "example", region: "WA" });
    expect(page().visibleEvidence!.headings).toEqual(["Example, WA"]);
    expect(() => deriveUScheduleOfficialLocation(source, page(), true)).toThrow();
  });
  it.each(["unit", "postal", "phone", "brand", "branch", "hidden", "form", "edge", "visible", "duplicate unit"])("rejects wrong %s physical/location evidence", what => {
    const p = page();
    if (what === "unit") p.html = p.html.replace("Suite C", "Suite D");
    if (what === "postal") p.html = p.html.replace("98000</p>", "98000-1234</p>");
    if (what === "phone") p.html = p.html.replace("425-555-0123", "425-555-0124");
    if (what === "brand") p.html = p.html.replace(`alt="${source.venueName}"`, 'alt="Other Golf Club"');
    if (what === "branch") p.html = p.html.replace("Example, WA</h1>", "Other, WA</h1>");
    if (what === "hidden") p.html = p.html.replace("<div>", "<div hidden>");
    if (what === "form") p.html = p.html.replace('action="/Locations/Example"', 'action="/checkout"');
    if (what === "edge") p.html = p.html.replace("loc[82]", "loc[83]");
    if (what === "visible") p.visibleEvidence!.addressTexts = [];
    if (what === "duplicate unit") p.html = p.html.replace("</div>", "<p>10 Main Drive, Suite D, Example, WA 98000</p></div>");
    expect(() => deriveUScheduleOfficialLocation(source, p, true, undefined, { canonicalCoursePhone: phone })).toThrow();
  });
  it("has a distinct complete catalog with no free-guest or concrete-resource assertions", () => {
    const c = readUScheduleLocationCatalog(catalog({ date: "2030-10-22", length: 60, location: "82", service: "72" }), canonical, official());
    expect(c.proof).toMatchObject({ kind: "PUBLIC_LOCATION_SERVICE_POOL_V1", serviceId: "72", maxPartySize: 4 });
    expect(c.proof).not.toHaveProperty("includedPartySize"); expect(c.proof).not.toHaveProperty("resourceGroups");
  });
  it.each(["location hidden", "location disabled", "service hidden", "service disabled", "duration hidden", "duration disabled"])("rejects a %s selected option", change => {
    let html = catalog({ date: "2030-10-22", length: 60, location: "82", service: "72" });
    const field = change.startsWith("location") ? 'value="82" selected' : change.startsWith("service") ? 'value="72" selected' : 'value="60" selected';
    html = html.replace(field, `${field} ${change.endsWith("hidden") ? "hidden" : "disabled"}`);
    expect(() => readUScheduleLocationCatalog(html, canonical, official())).toThrow();
  });
  it("saves one method and rederives fresh native physical and live location identity for new date and people", async () => {
    const cold = fixture(), { adapter } = await inspectExistingAdapter(source, cold.deps);
    const saved = JSON.stringify(parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }));
    const recipe = JSON.parse(saved) as ExistingAdapterRecipe;
    for (const [date, players] of [["2030-10-23", 2], ["2030-10-24", 4]] as const) {
      const f = fixture(), result = await executeExistingAdapterRecipe(recipe, { date, players, timeZone: source.timeZone, durationMinutes: 60, startTime: "09:00", endTime: "18:00" }, f.deps);
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(2); expect(result.slots.every(s => s.availableSpots === 1 && s.capacity === 4 && s.resourceId === "uschedule-location:82:service:72:pooled")).toBe(true);
      expect(f.posts).toEqual(["length", "start_date"]); expect(JSON.stringify(recipe)).toBe(saved);
    }
  });
  it("keeps absent published capacity null and rejects serialized native evidence or changed backend phone", async () => {
    const cold = fixture(undefined, null), { adapter } = await inspectExistingAdapter(source, cold.deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }) as ExistingAdapterRecipe;
    const request = { date: "2030-10-23", players: 2, durationMinutes: 60, timeZone: source.timeZone, startTime: "09:00", endTime: "18:00" };
    const warm = fixture(undefined, null), result = await executeExistingAdapterRecipe(recipe, request, warm.deps);
    expect(result.status).toBe("AVAILABLE"); expect(result.slots.every(s => s.capacity === null && s.availableSpots === 1)).toBe(true);
    const serialized = fixture(undefined, null);
    serialized.deps.readNativeOfficialPage = async () => JSON.parse(JSON.stringify(page()));
    expect(await executeExistingAdapterRecipe(recipe, request, serialized.deps)).toMatchObject({ status: "INCOMPLETE", slots: [] }); expect(serialized.fetch).not.toHaveBeenCalled();
    const changed = fixture(undefined, null); changed.deps.trustedContext.canonicalCoursePhone = "+14255550124";
    expect(await executeExistingAdapterRecipe(recipe, request, changed.deps)).toMatchObject({ status: "INCOMPLETE", slots: [] }); expect(changed.fetch).not.toHaveBeenCalled();
  });
  it.each(["location", "service", "duration", "private row", "partial extras", "limit"])("rejects changed %s after a filter", async change => {
    const f = fixture((html, state) => state.date !== "2030-10-22" ? change === "location" ? html.replace('value="82" selected', 'value="82"').replace('value="83" ', 'value="83" selected ') :
      change === "service" ? html.replace("Simulator Rental - Example", "Golf Lesson - Example") : change === "duration" ? html.replace('value="60" selected', 'value="60"') :
      change === "private row" ? html.replace("col timeslot", "col timeslot private") : change === "partial extras" ? html.replace("col timeslot", "col timeslot extra") : html.replace("Max of 4", "Max of 1") : html);
    const cold = fixture(), { adapter } = await inspectExistingAdapter(source, cold.deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter }) as ExistingAdapterRecipe;
    expect(await executeExistingAdapterRecipe(recipe, { date: "2030-10-23", players: 2, durationMinutes: 60, timeZone: source.timeZone, startTime: "09:00", endTime: "18:00" }, f.deps)).toMatchObject({ status: "INCOMPLETE", slots: [] });
  });
});
