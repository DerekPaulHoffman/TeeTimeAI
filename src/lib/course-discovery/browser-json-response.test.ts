// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { parseAccessRecipe, type AccessExecutionInput } from "./recipe";
import { executeAccessRecipe } from "./executor";
import { browserJsonAncillaryCalendarRequestMatches, browserJsonParticipantRequestMatches, extractBrowserJsonRows } from "./browser-json-response";
import { isSafeRecipeUrl } from "./recipe";

const input: AccessExecutionInput = { date: "2030-10-23", timeZone: "America/New_York", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const entry = "https://www.sevenrooms.com/reservations/examplegolf";
const range = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=18:00&party_size={{players}}&halo_size_interval=64&start_date={{dateMdy}}&num_days=1&channel=web&picked_duration={{durationMinutes}}";
const plan = { path: "data.availability", dateKey: "REQUESTED_DATE" as const, rowsPath: "times", typePath: "type", excludeType: "request" as const, availableTypes: ["book"],
  accessIdPath: "access_persistent_id", labelPath: "public_time_slot_description", expectedRentalLabel: "Golf Rental", startsAtPath: "time_iso", durationMinutesPath: "duration" };
const row = (extra: Record<string, unknown> = {}) => ({ type: "book", access_persistent_id: "public-access-1", public_time_slot_description: "Golf Rental", time_iso: "2030-10-23T17:15:00-04:00", duration: 60, ...extra });
const body = (rows: unknown[] = [row()]) => ({ status: 200, data: { availability: { "2030-10-23": [{ times: rows }] } } });
const recipe = () => ({ schemaVersion: 1, engine: "BROWSER_JSON", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
  source: { officialUrl: "https://examplegolf.com/", bookingUrl: entry, venueName: "Example Golf", providerFamily: "SEVENROOMS", timeZone: input.timeZone },
  pageUrl: `${entry}?date={{date}}&duration={{durationMinutes}}`, browserTransport: "PINNED_HTTP",
  permittedRoutes: [{ origin: "https://www.sevenrooms.com", path: "/reservations/examplegolf", methods: ["GET"], queryKeys: ["date", "duration"] },
    { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"], queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "picked_duration"] }],
  steps: [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" }],
  proof: { venue: { selector: "#venue", format: "VENUE_SELECT_TIME" }, date: { availabilityDateKey: true }, complete: { availabilityResponse: true } },
  availabilityResponse: { url: range, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" }, success: { path: "status", equals: 200 } },
  requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS", responseRows: { ...plan } });
function wire(value = input) { return range.replace("{{players}}", String(value.players)).replace("{{durationMinutes}}", String(value.durationMinutes))
  .replace("{{dateMdy}}", `${value.date.slice(5, 7)}-${value.date.slice(8)}-${value.date.slice(0, 4)}`); }
function prefetchUrl(offset: number, primary = wire()) {
  const mdy = new URL(primary).searchParams.get("start_date")!.split("-").map(Number), date = new Date(Date.UTC(mdy[2], mdy[0] - 1, mdy[1] + offset));
  const next = `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}-${date.getUTCFullYear()}`;
  return primary.replace(/start_date=\d{2}-\d{2}-\d{4}/u, `start_date=${next}`).replace("num_days=1", "num_days=3");
}

describe("finite observed calendar-prefetch classification, no read admission", () => {
  const primary = () => ({ url: wire() + "&selected_lang_code=en", method: "GET" });
  const ancillary = (url = prefetchUrl(1, primary().url), resourceType = "fetch", method = "GET") => ({ url, resourceType, method });
  it("recognizes all eight observed offsets and exact reordered pairs without making them inventory proof", () => {
    for (const offset of [1, 4, 7, 10, 13, 16, 19, 22]) {
      const request = ancillary(prefetchUrl(offset, primary().url));
      expect(browserJsonAncillaryCalendarRequestMatches(request, primary(), entry, input, isSafeRecipeUrl)).toBe(true);
      expect(browserJsonParticipantRequestMatches(request, entry, input, isSafeRecipeUrl)).toBe(false);
      expect(browserJsonAncillaryCalendarRequestMatches({ ...request, resourceType: "xhr" }, primary(), entry, input, isSafeRecipeUrl)).toBe(true);
    }
    const url = ancillary().url, [path, query] = url.split("?");
    expect(browserJsonAncillaryCalendarRequestMatches(ancillary(`${path}?${query.split("&").reverse().join("&")}`), primary(), entry, input, isSafeRecipeUrl)).toBe(true);
  });
  it.each([
    ["party_size=2", "party_size=3"], ["picked_duration=60", "picked_duration=90"],
    ["halo_size_interval=64", "halo_size_interval=63"], ["channel=web", "channel=OTHER"], ["selected_lang_code=en", "selected_lang_code=fr"],
    ["venue=examplegolf", "venue=other"], ["num_days=3", "num_days=1"], ["num_days=3", "num_days=2"],
    ["start_date=10-24-2030", "start_date=10-23-2030"], ["start_date=10-24-2030", "start_date=10-25-2030"],
    ["start_date=10-24-2030", "start_date=11-17-2030"], ["start_date=10-24-2030", "start_date=02-30-2030"],
    ["venue=", "%76enue="], ["time_slot=18:00", "time_slot=18%3A00"],
  ])("keeps changed or unrecognized pair %s relevant", (from, to) => {
    expect(browserJsonAncillaryCalendarRequestMatches(ancillary(ancillary().url.replace(from, to)), primary(), entry, input, isSafeRecipeUrl)).toBe(false);
  });
  it("requires full primary input/window/source binding and the unchanged strict callback", () => {
    for (const planned of [{ ...primary(), method: "POST" }, { ...primary(), url: primary().url.replace("num_days=1", "num_days=3") },
      { ...primary(), url: primary().url.replace("halo_size_interval=64", "halo_size_interval=1") }])
      expect(browserJsonAncillaryCalendarRequestMatches(ancillary(), planned, entry, input, isSafeRecipeUrl)).toBe(false);
    expect(browserJsonAncillaryCalendarRequestMatches(ancillary(), primary(), entry.replace("examplegolf", "other"), input, isSafeRecipeUrl)).toBe(false);
    expect(browserJsonAncillaryCalendarRequestMatches(ancillary(), primary(), entry, { ...input, players: 3 }, isSafeRecipeUrl)).toBe(false);
    expect(browserJsonAncillaryCalendarRequestMatches(ancillary(), primary(), entry, input, () => false)).toBe(false);
  });
  it("rejects document/POST/unknown context, extra/duplicate keys and URL aliases", () => {
    for (const request of [ancillary(undefined, "document"), ancillary(undefined, "fetch", "POST"), ancillary(undefined, "other"),
      ancillary(ancillary().url + "&debug=true"), ancillary(ancillary().url + "&party_size=2"), ancillary(ancillary().url + "&client_id=private"),
      ancillary(ancillary().url.replace("www.sevenrooms.com", "foreign.example")), ancillary(ancillary().url.replace("www.sevenrooms.com", "www.sevenrooms.com:443")),
      ancillary(ancillary().url.replace("/widget/range?", "/widget/%72ange?")), ancillary(ancillary().url + "#fragment")])
      expect(browserJsonAncillaryCalendarRequestMatches(request, primary(), entry, input, isSafeRecipeUrl)).toBe(false);
  });
});

describe("bounded browser JSON response contract", () => {
  it("parses the explicit response mode with no fake DOM slots", () => { expect(parseAccessRecipe(recipe()).engine).toBe("BROWSER_JSON"); });
  it.each(["missing-success", "private-success", "server-document", "outdoor", "foreign-role", "foreign-page", "different-entry", "private-path", "request-as-available", "players-in-page", "fake-slots"])("keeps the new schema closed: %s", mode => {
    const value = recipe();
    const candidate: Record<string, unknown> = structuredClone(value);
    if (mode === "missing-success") delete (candidate.availabilityResponse as Record<string, unknown>).success;
    if (mode === "private-success") (candidate.availabilityResponse as Record<string, unknown>).success = { path: "account.status", equals: 200 };
    if (mode === "server-document") (candidate.availabilityResponse as Record<string, unknown>).kind = "SERVER_DOCUMENT";
    if (mode === "outdoor") (candidate.target as Record<string, unknown>).kind = "OUTDOOR";
    if (mode === "foreign-role") (candidate.availabilityResponse as Record<string, unknown>).url = range.replace("www.sevenrooms.com", "other.example");
    if (mode === "foreign-page") candidate.pageUrl = "https://other.example/reservations/examplegolf";
    if (mode === "different-entry") candidate.pageUrl = "https://www.sevenrooms.com/reservations/othergolf";
    if (mode === "private-path") (candidate.responseRows as Record<string, unknown>).accessIdPath = "account.id";
    if (mode === "request-as-available") (candidate.responseRows as Record<string, unknown>).availableTypes = ["request"];
    if (mode === "players-in-page") candidate.pageUrl = `${entry}?party={{players}}`;
    if (mode === "fake-slots") candidate.slots = { collection: { selector: "body" } };
    expect(() => parseAccessRecipe(candidate)).toThrow();
  });
  it("flattens every group under only the requested own date and hashes public identity", () => {
    const response = body([row(), row({ type: "request", is_requestable: true })]);
    response.data.availability["2030-10-23"].push({ times: [row({ access_persistent_id: "public-access-2", time_iso: "2030-10-23T18:00:00-04:00" })] });
    const data = extractBrowserJsonRows(response, plan, input);
    expect(data.rows).toHaveLength(2); expect(data.duration).toBe(60);
    expect(JSON.stringify(data)).not.toContain("public-access-");
    const opaque = extractBrowserJsonRows(body([row({ access_persistent_id: "public:id/value==" })]), plan, input);
    expect(opaque.rows).toHaveLength(1); expect(JSON.stringify(opaque)).not.toContain("public:id/value==");
  });
  it("does not infer rental identity or duration from empty or request-only responses", () => {
    for (const value of [body([]), body([{ type: "request", is_requestable: false }])]) {
      const data = extractBrowserJsonRows(value, plan, input); expect(data.rows).toEqual([]); expect(data.duration).toBeUndefined(); expect(data.empty).toBe(false);
    }
  });
  it.each([{ type: undefined }, { type: 1 }, { access_persistent_id: null }, { access_persistent_id: "" }, { access_persistent_id: "  " },
    { access_persistent_id: "public\nline" }, { access_persistent_id: "a".repeat(257) }, { public_time_slot_description: "Lesson" }, { duration: "60" },
    { duration: 90 }, { duration: undefined }, { time_iso: null }, { time_iso: "" }])("rejects malformed nonrequest data instead of skipping %j", change => {
    expect(() => extractBrowserJsonRows(body([row(change)]), plan, input)).toThrow("BROWSER_JSON_MALFORMED_ROW");
  });
  it("rejects missing dates, malformed groups/children and aggregate overflow", () => {
    for (const value of [{ data: { availability: {} } }, { data: { availability: { [input.date]: {} } } },
      { data: { availability: { [input.date]: [null] } } }, { data: { availability: { [input.date]: [{ times: null }] } } }, body(Array.from({ length: 500 }, () => row()))])
      expect(() => extractBrowserJsonRows(value, plan, input)).toThrow();
  });
  it("does not default an unknown future row type or a private path into availability", () => {
    expect(() => extractBrowserJsonRows(body([row({ type: "held" })]), plan, input)).toThrow("BROWSER_JSON_UNKNOWN_ROW_TYPE");
    for (const path of ["account.id", "customer.name", "__proto__.id", "access_token", "data.payment"])
      expect(() => extractBrowserJsonRows(body(), { ...plan, accessIdPath: path }, input)).toThrow("BROWSER_JSON_INVALID_PATH");
  });
  it("binds participants, duration, date, venue and full-window coverage to the exact public request", () => {
    expect(browserJsonParticipantRequestMatches({ url: wire(), method: "GET" }, entry, input, isSafeRecipeUrl)).toBe(true);
    for (const url of [wire().replace("party_size=2", "party_size=1"), wire().replace("picked_duration=60", "picked_duration=90"), wire().replace("10-23-2030", "10-24-2030"),
      wire().replace("num_days=1", "num_days=3"), wire().replace("halo_size_interval=64", "halo_size_interval=1"), wire().replace("venue=examplegolf", "venue=other")])
      expect(browserJsonParticipantRequestMatches({ url, method: "GET" }, entry, input, isSafeRecipeUrl)).toBe(false);
    expect(browserJsonParticipantRequestMatches({ url: wire(), method: "POST" }, entry, input, isSafeRecipeUrl)).toBe(false);
    expect(browserJsonParticipantRequestMatches({ url: wire(), method: "GET" }, entry, input, () => false)).toBe(false);
    // The pinned client uses isSameOrAfter/isSameOrBefore at the halo edges.
    const edge = wire().replace("time_slot=18:00", "time_slot=15:00").replace("halo_size_interval=64", "halo_size_interval=20");
    expect(browserJsonParticipantRequestMatches({ url: edge, method: "GET" }, entry, input, isSafeRecipeUrl)).toBe(true);
  });
});

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe.runIf(existsSync(chrome))("fixed browser JSON replay, local fixtures only", () => {
  async function executeFixture(runInput = input, mode = "available") {
    const requests: string[] = [];
    let reads = 0;
    const fetcher = async (url: string | URL | Request) => {
      const value = String(url); requests.push(value);
      if (value.startsWith(`${entry}?`)) {
        const venue = mode === "wrong-venue" ? "Select a time at Another Golf" : mode === "extra-prose" ? "Select a time at Example Golf book now" : "Select a time at Example Golf";
        const later = mode === "later-wrong-date" ? `.then(()=>setTimeout(()=>fetch('${wire(runInput).replace("10-23-2030", "10-24-2030")}'),700))`
          : mode === "new-document" ? ".then(()=>setTimeout(()=>location.reload(),700))" : "";
        const action = mode === "superseded-response" ? `{fetch('${wire(runInput)}');setTimeout(()=>fetch('${wire(runInput).replace("10-23-2030", "10-24-2030")}'),50)}` : `fetch('${wire(runInput)}')${later}`;
        return new Response(`<h1 id="venue">${venue}</h1><label>Players<select id="players" name="players"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label><script>document.querySelector('#players').addEventListener('change',()=>${action})</script>`, { headers: { "content-type": "text/html" } });
      }
      if (value.startsWith("https://www.sevenrooms.com/api-yoa/availability/widget/range?")) {
        reads++;
        if (mode === "superseded-response" && value === wire(runInput)) await new Promise(resolve => setTimeout(resolve, 700));
        const sourceRow = row({ time_iso: `${runInput.date}T17:15:00-04:00`, duration: runInput.durationMinutes });
        const values = mode === "empty" ? [] : mode === "request-only" ? [{ type: "request", is_requestable: true }] : [sourceRow];
        if (mode === "wrong-date") sourceRow.time_iso = "2030-10-24T17:15:00-04:00";
        if (mode === "malformed") (sourceRow as Record<string, unknown>).duration = undefined;
        const response = { status: mode === "application-error" ? 400 : 200, data: { availability: { [runInput.date]: [{ times: values }] } } };
        if (mode === "partial") return new Response('{"status":200,"data":', { headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(response), { headers: { "content-type": mode === "wrong-mime" ? "text/html" : "application/json" } });
      }
      throw new Error("UNEXPECTED_FIXTURE_REQUEST");
    };
    const result = await executeAccessRecipe(parseAccessRecipe(recipe()), runInput, { fetch: fetcher as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }), now: () => new Date("2030-10-22T12:00:00Z") });
    return { result, requests, reads };
  }
  it("executes the fresh fenced response as one whole bay without selecting a slot", async () => {
    const { result, requests } = await executeFixture();
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE"); expect(result.slots).toHaveLength(1); expect(result.slots[0].availableSpots).toBe(1); expect(result.slots[0].capacity).toBeNull();
    expect(requests).toContain(wire());
  });
  it("independently replays changed date, participant count and duration from the same immutable recipe", async () => {
    const changed = { ...input, date: "2030-10-24", players: 3, durationMinutes: 90 };
    const first = await executeFixture(), second = await executeFixture(changed);
    expect(first.result.status).toBe("AVAILABLE"); expect(second.result.status, JSON.stringify(second.result.evidence)).toBe("AVAILABLE");
    expect(first.result.evidence.recipeHash).toBe(second.result.evidence.recipeHash);
    expect(second.requests).toContain(wire(changed));
    expect(second.result.slots[0]).toMatchObject({ startsAt: "2030-10-24T21:15:00.000Z", endsAt: "2030-10-24T22:45:00.000Z", availableSpots: 1, capacity: null });
  }, 10_000);
  it.each(["empty", "request-only", "wrong-venue", "extra-prose", "wrong-date", "malformed", "application-error", "wrong-mime", "partial", "later-wrong-date", "new-document", "superseded-response"])
    ("never returns a complete or nonempty result from %s evidence", async mode => {
      const { result } = await executeFixture(input, mode);
      expect(result.complete).toBe(false); expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
      if (["empty", "request-only"].includes(mode)) expect(result.status).toBe("INCOMPLETE");
    });
});
