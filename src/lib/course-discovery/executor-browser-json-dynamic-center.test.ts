// @vitest-environment node
// Actual local Chrome uses exclusively in-memory HTTP and request-lease fixtures.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { browserJsonAncillaryCalendarRequestMatches, browserJsonParticipantRequestMatches } from "./browser-json-response";
import { executeAccessRecipe, matchesAvailabilityResponse } from "./executor";
import { expandRecipeTemplate, hashAccessRecipe, isSafeRecipeUrl, parseAccessRecipe, type AccessExecutionInput } from "./recipe";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input: AccessExecutionInput = { date: "2030-10-23", timeZone: "America/New_York", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const changed: AccessExecutionInput = { ...input, date: "2030-10-24", players: 3, durationMinutes: 120, startTime: "11:00", endTime: "19:00" };
const entry = "https://www.sevenrooms.com/reservations/examplegolf";
const range = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=18:00&party_size={{players}}&halo_size_interval=32&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration={{durationMinutes}}";
function saved(stale = false) {
  const parsed = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_JSON", browserTransport: "PINNED_HTTP",
    target: { courseId: "fixture", offeringId: "fixture-offering", kind: "SIMULATOR" },
    source: { officialUrl: "https://examplegolf.com/", bookingUrl: entry, venueName: "Example Golf", providerFamily: "FIXTURE", timeZone: input.timeZone }, pageUrl: entry,
    permittedRoutes: [{ origin: "https://www.sevenrooms.com", path: "/reservations/examplegolf", methods: ["GET"], queryKeys: [] },
      { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"], queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "selected_lang_code", "picked_duration"] }],
    steps: [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" },
      ...(stale ? [{ action: "waitFor", selector: "#primary-complete" }, { action: "select", selector: "#duration", value: "{{durationMinutes}}", purpose: "DURATION" }] : [])],
    availabilityResponse: { url: range, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" }, success: { path: "status", equals: 200 } },
    requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS",
    responseRows: { path: "data.availability", dateKey: "REQUESTED_DATE", rowsPath: "times", typePath: "type", excludeType: "request", availableTypes: ["book"], accessIdPath: "access_persistent_id", labelPath: "public_time_slot_description", expectedRentalLabel: "Golf Rental", startsAtPath: "time", durationMinutesPath: "duration" },
    proof: { venue: { selector: "#venue", format: "VENUE_SELECT_TIME" }, date: { availabilityDateKey: true }, complete: { availabilityResponse: true } },
  });
  if (parsed.engine !== "BROWSER_JSON") throw Error("WRONG_FIXTURE_ENGINE");
  return parsed;
}
const wire = (value = input) => expandRecipeTemplate(range, value, true);
const centered = (center = "16:00", value = input) => wire(value).replace("time_slot=18:00", `time_slot=${center}`);
const responseBody = JSON.stringify({ status: 200 });

describe("SevenRooms primary dynamic public clock binding", () => {
  it("accepts a different center only when both strict requests cover the full requested window", () => {
    const request = { url: centered(), method: "GET" };
    expect(browserJsonParticipantRequestMatches(request, entry, input, isSafeRecipeUrl)).toBe(true);
    expect(matchesAvailabilityResponse(saved(), input, request, 200, responseBody)).toBe(true);
    expect(matchesAvailabilityResponse(saved(), changed, { url: centered("17:00", changed), method: "GET" }, 200, responseBody)).toBe(true);
  });
  it.each(["11:00", "19:00"])("rejects center %s when its halo misses an edge of the requested window", center => {
    expect(matchesAvailabilityResponse(saved(), input, { url: centered(center), method: "GET" }, 200, responseBody)).toBe(false);
  });
  it.each([
    ["tenant", "venue=examplegolf", "venue=othergolf"], ["date", "start_date=10-23-2030", "start_date=10-24-2030"],
    ["players", "party_size=2", "party_size=3"], ["duration", "picked_duration=60", "picked_duration=90"],
    ["halo", "halo_size_interval=32", "halo_size_interval=64"], ["channel", "channel=SEVENROOMS_WIDGET", "channel=web"],
    ["language", "selected_lang_code=en", "selected_lang_code=fr"], ["calendar", "num_days=1", "num_days=3"],
    ["origin", "www.sevenrooms.com", "other.example"], ["path", "/widget/range?", "/widget/ranges?"],
    ["encoded clock", "time_slot=16:00", "time_slot=16%3A00"], ["encoded key", "time_slot=", "%74ime_slot="],
    ["clock padding", "time_slot=16:00", "time_slot=016:00"], ["port alias", "www.sevenrooms.com", "www.sevenrooms.com:443"],
  ])("keeps every other fence and strict grammar exact: %s", (_name, from, to) => {
    expect(matchesAvailabilityResponse(saved(), input, { url: centered().replace(from, to), method: "GET" }, 200, responseBody)).toBe(false);
  });
  it.each(["&time_slot=16:00", "&party_size=2", "&debug=true", "#fragment"])("rejects unknown or duplicate suffix %s", suffix => {
    expect(matchesAvailabilityResponse(saved(), input, { url: centered() + suffix, method: "GET" }, 200, responseBody)).toBe(false);
  });
  it("does not normalize other raw serialization, methods, response success, or the saved halo", () => {
    const [path, query] = centered().split("?");
    const reordered = `${path}?${query.split("&").reverse().join("&")}`;
    expect(browserJsonParticipantRequestMatches({ url: reordered, method: "GET" }, entry, input, isSafeRecipeUrl)).toBe(true);
    for (const request of [{ url: reordered, method: "GET" }, { url: centered(), method: "POST" }, { url: centered(), method: "HEAD" }])
      expect(matchesAvailabilityResponse(saved(), input, request, 200, responseBody)).toBe(false);
    expect(matchesAvailabilityResponse(saved(), input, { url: centered(), method: "GET" }, 500, responseBody)).toBe(false);
    expect(matchesAvailabilityResponse(saved(), input, { url: centered(), method: "GET" }, 200, JSON.stringify({ status: 400 }))).toBe(false);
    const recipe = saved(); recipe.availabilityResponse.url = recipe.availabilityResponse.url.replace("halo_size_interval=32", "halo_size_interval=1");
    expect(matchesAvailabilityResponse(recipe, input, { url: centered(), method: "GET" }, 200, responseBody)).toBe(false);
  });
});

describe("dynamic public calendar clock remains ancillary only", () => {
  const primary = { url: wire(), method: "GET" };
  const ancillary = (center = "17:00") => ({ url: centered(center).replace("start_date=10-23-2030", "start_date=10-24-2030").replace("num_days=1", "num_days=3"), method: "GET", resourceType: "fetch" });
  it("allows only a separately full-window clock while retaining the existing finite calendar role", () => {
    const request = ancillary();
    expect(browserJsonAncillaryCalendarRequestMatches(request, primary, entry, input, isSafeRecipeUrl)).toBe(true);
    expect(matchesAvailabilityResponse(saved(), input, request, 200, responseBody)).toBe(false);
    expect(browserJsonAncillaryCalendarRequestMatches(request, primary, entry, input, () => false)).toBe(false);
    for (const center of ["11:00", "19:00"])
      expect(browserJsonAncillaryCalendarRequestMatches(ancillary(center), primary, entry, input, isSafeRecipeUrl)).toBe(false);
  });
  it.each([
    ["offset", "start_date=10-24-2030", "start_date=10-25-2030"], ["date", "start_date=10-24-2030", "start_date=02-30-2030"],
    ["party", "party_size=2", "party_size=3"], ["duration", "picked_duration=60", "picked_duration=90"],
    ["halo", "halo_size_interval=32", "halo_size_interval=64"], ["tenant", "venue=examplegolf", "venue=othergolf"],
    ["channel", "channel=SEVENROOMS_WIDGET", "channel=web"], ["language", "selected_lang_code=en", "selected_lang_code=fr"],
    ["days", "num_days=3", "num_days=1"], ["encoded clock", "time_slot=17:00", "time_slot=17%3A00"],
    ["encoded key", "time_slot=", "%74ime_slot="], ["origin", "www.sevenrooms.com", "foreign.example"],
    ["path", "/widget/range?", "/widget/ranges?"],
  ])("keeps %s changes relevant rather than suppressing them as calendar reads", (_name, from, to) => {
    const request = ancillary(); request.url = request.url.replace(from, to);
    expect(browserJsonAncillaryCalendarRequestMatches(request, primary, entry, input, isSafeRecipeUrl)).toBe(false);
  });
  it.each(["&time_slot=17:00", "&party_size=2", "&debug=true"])("rejects duplicate or unknown calendar keys %s", suffix => {
    const request = ancillary(); request.url += suffix;
    expect(browserJsonAncillaryCalendarRequestMatches(request, primary, entry, input, isSafeRecipeUrl)).toBe(false);
  });
});

async function replay(value: AccessExecutionInput, stale = false, calendar = false, calendarCenter = "17:00") {
  const requests: string[] = [], actual = centered("17:00", value);
  const nextDay = new Date(`${value.date}T00:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const mdy = `${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDay.getUTCDate()).padStart(2, "0")}-${nextDay.getUTCFullYear()}`;
  const ancillary = actual.replace(/start_date=\d{2}-\d{2}-\d{4}/u, `start_date=${mdy}`).replace("num_days=1", "num_days=3").replace("time_slot=17:00", `time_slot=${calendarCenter}`);
  const result = await executeAccessRecipe(saved(stale), value, {
    fetch: (async (url: string | URL | Request) => {
      const request = String(url); requests.push(request);
      if (request === entry) return new Response(`<h1 id="venue">Select a time at Example Golf</h1><select id="players" aria-label="Players"><option value="2">2</option><option value="3">3</option></select><select id="duration" aria-label="Duration"><option value="60">60</option><option value="120">120</option></select><script>document.querySelector('#players').onchange=()=>fetch(${JSON.stringify(actual)}).then(r=>r.json()).then(()=>{document.body.insertAdjacentHTML('beforeend','<p id="primary-complete">ready</p>');${calendar ? `return fetch(${JSON.stringify(ancillary)});` : ""}});</script>`, { headers: { "content-type": "text/html" } });
      if (calendar && request === ancillary) return new Response(JSON.stringify({ status: 200, data: { availability: {} } }), { headers: { "content-type": "application/json" } });
      if (request !== actual) throw Error("UNEXPECTED_FIXTURE_URL");
      return new Response(JSON.stringify({ status: 200, data: { availability: { [value.date]: [{ times: [{ type: "book", access_persistent_id: "public-fixture", public_time_slot_description: "Golf Rental", time: "4:15 PM", duration: value.durationMinutes }] }] } } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    now: () => new Date("2030-10-22T12:00:00Z"), deadlineAt: new Date("2030-10-22T12:00:06Z"),
  });
  return { result, requests, actual, ancillary };
}
describe.runIf(existsSync(chrome))("dynamic-clock replay with isolated in-memory browser wire", () => {
  it("reuses the same immutable recipe for baseline and changed date, party, duration, and window", async () => {
    const recipeHash = hashAccessRecipe(saved());
    for (const value of [input, changed]) {
      const { result, requests, actual } = await replay(value);
      expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE");
      expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1);
      expect(result.evidence.recipeHash).toBe(recipeHash);
      expect(requests).toEqual([entry, actual]);
    }
  }, 15000);
  it("does not reuse a matching dynamic response after a later filter mutation", async () => {
    const { result, requests, actual } = await replay(input, true);
    expect(requests).toEqual([entry, actual]);
    expect(result.complete, JSON.stringify(result.evidence)).toBe(false);
    expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
  }, 10000);
  it("retains verified primary proof when a same-window dynamic-center calendar prefetch completes", async () => {
    const { result, requests, actual, ancillary } = await replay(input, false, true);
    expect(requests).toEqual([entry, actual, ancillary]);
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE");
    expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1);
  }, 10000);
  it.each(["11:00", "19:00"])("does not retain proof after an ancillary center %s misses the full requested window", async center => {
    const { result, requests, actual, ancillary } = await replay(input, false, true, center);
    expect(requests).toEqual([entry, actual, ancillary]);
    expect(result.complete, JSON.stringify(result.evidence)).toBe(false);
    expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
  }, 10000);
  it("retires primary proof after a filter mutation even when dynamic calendar reads were ancillary", async () => {
    const { result, requests, actual, ancillary } = await replay(input, true, true);
    expect(requests).toEqual([entry, actual, ancillary]);
    expect(result.complete, JSON.stringify(result.evidence)).toBe(false);
    expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
  }, 10000);
});
