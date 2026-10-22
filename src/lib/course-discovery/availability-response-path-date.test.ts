// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { parseAccessRecipe } from "./recipe";
import { executeAccessRecipe, matchesAvailabilityResponse } from "./executor";

const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const template = "https://example.org/api/dates/{{date}}/{{date}}";
const recipe = () => ({ schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/times", steps: [{ action: "select", selector: "#players", purpose: "PLAYERS", value: "{{players}}" }],
  permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"], queryKeys: [] },
    { origin: "https://example.org", path: "/api/dates/*", methods: ["GET"], queryKeys: [] }],
  availabilityResponse: { url: template, method: "GET", date: { source: "PATH", path: "2" }, endDatePath: "3" },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#ready" }, players: { selector: "#players", attribute: "value" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } } });
const actual = template.replaceAll("{{date}}", input.date);

describe("exact path-date browser response fence", () => {
  it("binds zero-based nonempty URI segments only after exact URL equality", () => {
    const value = parseAccessRecipe(recipe());
    if (value.engine !== "BROWSER_DOM") throw Error("fixture");
    expect(matchesAvailabilityResponse(value, input, { url: actual, method: "GET" }, 200)).toBe(true);
    for (const request of [{ url: actual + "?extra=1", method: "GET" }, { url: actual, method: "POST" },
      { url: actual.replaceAll(input.date, "2030-10-24"), method: "GET" }])
      expect(matchesAvailabilityResponse(value, input, request, 200)).toBe(false);
    for (const path of ["0", "1", "4", "63"])
      expect(matchesAvailabilityResponse({ ...value, availabilityResponse: { ...value.availabilityResponse, date: { source: "PATH", path } } }, input, { url: actual, method: "GET" }, 200)).toBe(false);
    expect(matchesAvailabilityResponse(value, input, { url: actual, method: "GET" }, 503)).toBe(false);
  });
  it.each(["-1", "01", "64", "1.0", "date", "1.date"])("rejects an invalid segment index %s", path => {
    const value = recipe(); value.availabilityResponse.date.path = path;
    expect(() => parseAccessRecipe(value)).toThrow();
    const end = recipe(); end.availabilityResponse.endDatePath = path;
    expect(() => parseAccessRecipe(end)).toThrow();
  });
  it.each(["/api//dates/{{date}}/{{date}}", "/api/dates/{{date}}/{{date}}/", "/api/dates%2Fhidden/{{date}}/{{date}}",
    "/api/dates%5Chidden/{{date}}/{{date}}", "/api/dates/%32{{date}}/{{date}}", "/api/dates/{{date}}/2030-10-24"])("rejects ambiguous or contradictory raw path %s", pathname => {
    const value = parseAccessRecipe({ ...recipe(), availabilityResponse: { ...recipe().availabilityResponse, url: `https://example.org${pathname}` } });
    if (value.engine !== "BROWSER_DOM") throw Error("fixture");
    expect(matchesAvailabilityResponse(value, input, { url: `https://example.org${pathname.replaceAll("{{date}}", input.date)}`, method: "GET" }, 200)).toBe(false);
  });
  it("requires an explicit month-day-year format and preserves server-document query-only proof", () => {
    const value = parseAccessRecipe({ ...recipe(), availabilityResponse: { ...recipe().availabilityResponse,
      url: template.replaceAll("{{date}}", "{{dateMdy}}"), date: { source: "PATH", path: "2", format: "MM-DD-YYYY" } } });
    if (value.engine !== "BROWSER_DOM") throw Error("fixture");
    const url = actual.replaceAll(input.date, "10-23-2030");
    expect(matchesAvailabilityResponse(value, input, { url, method: "GET" }, 200)).toBe(true);
    expect(matchesAvailabilityResponse({ ...value, availabilityResponse: { ...value.availabilityResponse, date: { source: "PATH", path: "2" } } }, input, { url, method: "GET" }, 200)).toBe(false);
    expect(() => parseAccessRecipe({ ...recipe(), availabilityResponse: { ...recipe().availabilityResponse, kind: "SERVER_DOCUMENT" } })).toThrow();
  });
});

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe.runIf(existsSync(chrome))("path-date freshness with isolated in-memory Chrome", () => {
  it.each([false, true])("requires a completed path response after the latest filter (stale=%s)", async stale => {
    const html = `<h1>Example Golf</h1><p id="date">${input.date}</p><p id="ready">Ready</p><label>Players<select id="players" name="players"><option value="1">1</option><option value="2">2</option></select></label><div class="slot"><span class="time">09:00</span><span class="capacity">4</span></div><script>${stale ? `fetch('${actual}')` : `document.querySelector('#players').addEventListener('change',()=>fetch('${actual}'))`}</script>`;
    let dataReads = 0;
    const result = await executeAccessRecipe(recipe(), input, {
      now: () => new Date("2030-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      fetch: (async url => {
        if (String(url) === actual) { dataReads++; return new Response("{}", { headers: { "content-type": "application/json" } }); }
        if (String(url) !== "https://example.org/times") throw Error("UNEXPECTED_FIXTURE_URL");
        return new Response(html, { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
    });
    expect(dataReads).toBe(1);
    expect(result).toMatchObject({ status: stale ? "INCOMPLETE" : "AVAILABLE", complete: !stale });
    if (stale) { expect(result.slots).toEqual([]); expect(result.evidence.reason).toBe("AVAILABILITY_RESPONSE_UNCONFIRMED"); }
  }, 20_000);
});
