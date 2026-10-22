import { describe, expect, it } from "vitest";
import { parseAccessRecipe, recipeAllowsRequest } from "./recipe";
import { matchesAvailabilityResponse } from "./executor";

const api = "https://example.org/api/tee-sheet";
const page = "https://example.org/times";
const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const candidate = () => ({ schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: page, venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: page, steps: [],
  permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"], queryKeys: [] },
    { origin: "https://example.org", path: "/api/tee-sheet", methods: ["POST"], queryKeys: [] }],
  availabilityResponse: { url: api, method: "POST", date: { source: "JSON_BODY", path: "date", format: "M/D/YYYY" } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#ready" }, players: { selector: "#players" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } } });

describe("explicit unpadded JSON body date fence", () => {
  it("binds the exact POST, URL, requested date and explicit format", () => {
    const recipe = parseAccessRecipe(candidate());
    if (recipe.engine !== "BROWSER_DOM") throw Error("fixture");
    const request = { url: api, method: "POST", body: JSON.stringify({ date: "10/23/2030" }) };
    expect(matchesAvailabilityResponse(recipe, input, request, 200)).toBe(true);
    expect(matchesAvailabilityResponse(recipe, { ...input, date: "2030-10-24" }, request, 200)).toBe(false);
    expect(matchesAvailabilityResponse(recipe, input, { ...request, method: "GET" }, 200)).toBe(false);
    expect(matchesAvailabilityResponse(recipe, input, { ...request, url: api + "?extra=1" }, 200)).toBe(false);
    expect(matchesAvailabilityResponse(recipe, input, request, 503)).toBe(false);
    for (const date of ["2030-10-23", "10-23-2030", "10/24/2030", " 10/23/2030", null])
      expect(matchesAvailabilityResponse(recipe, input, { ...request, body: JSON.stringify({ date }) }, 200)).toBe(false);
    const january = { ...input, date: "2030-01-02" };
    expect(matchesAvailabilityResponse(recipe, january, { ...request, body: '{"date":"1/2/2030"}' }, 200)).toBe(true);
    expect(matchesAvailabilityResponse(recipe, january, { ...request, body: '{"date":"01/02/2030"}' }, 200)).toBe(false);
  });
  it("requires a separate explicit recipe route and data resource permission", () => {
    const endpoint = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";
    const booking = "https://app.membersports.com/tee-times/21/34/0";
    const value = { ...candidate(), source: { ...candidate().source, bookingUrl: booking }, pageUrl: booking,
      permittedRoutes: [{ origin: "https://app.membersports.com", path: "/tee-times/*", methods: ["GET"], queryKeys: [] },
        { origin: "https://api.membersports.com", path: "/api/v1/golfclubs/onlineBookingTeeTimes", methods: ["POST"], queryKeys: [] }],
      availabilityResponse: { url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "date", format: "ISO_DATE" } } };
    const recipe = parseAccessRecipe(value);
    expect(recipeAllowsRequest(recipe, endpoint, "POST", "fetch")).toBe(true);
    expect(recipeAllowsRequest(recipe, endpoint, "POST", "document")).toBe(false);
    expect(recipeAllowsRequest(recipe, endpoint, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest({ ...recipe, permittedRoutes: [] }, endpoint, "POST", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...value, pageUrl: endpoint })).toThrow();
    expect(() => parseAccessRecipe({ ...value, source: { ...value.source, bookingUrl: endpoint } })).toThrow();
    expect(() => parseAccessRecipe({ ...value, availabilityResponse: { url: endpoint, method: "GET",
      date: { source: "QUERY", path: "date" } } })).toThrow();
  });
  it.each(["QUERY", "PATH"])("rejects M/D/YYYY date format on a GET %s fence", source => {
    expect(() => parseAccessRecipe({ ...candidate(), availabilityResponse: { url: "https://example.org/api/date", method: "GET",
      date: { source, path: source === "PATH" ? "1" : "date", format: "M/D/YYYY" } } })).toThrow();
  });
});
