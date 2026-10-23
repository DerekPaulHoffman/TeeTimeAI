import { describe, expect, it } from "vitest";
import { parseAccessRecipe, recipeAllowsRequest, recipeRouteSchema } from "./recipe";

const asset = () => ({ origin: "https://apis.google.com", path: "/js/client:platform.js", methods: ["GET"],
  queryKeys: ["onload"], resourceTypes: ["script"] });
const recipe = () => ({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
  target: { courseId: "course-1", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/tee-times", venueName: "Example Golf",
    providerFamily: "EXAMPLE", timeZone: "America/New_York" },
  pageUrl: "https://example.org/tee-times", steps: [],
  permittedRoutes: [{ origin: "https://example.org", path: "/tee-times", methods: ["GET"] }, asset()],
  availabilityResponse: { url: "https://example.org/api/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#ready" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".players" } },
});

describe("exact resource-scoped public asset routes", () => {
  const url = "https://apis.google.com/js/client:platform.js?onload=publicCallback";
  it("admits the observed script kind and preserves ordinary navigation routes", () => {
    const parsed = parseAccessRecipe(recipe());
    expect(recipeAllowsRequest(parsed, url, "GET", "script")).toBe(true);
    expect(recipeAllowsRequest(parsed, "https://example.org/tee-times", "GET", "document")).toBe(true);
    expect(recipeAllowsRequest(parsed, "https://example.org/tee-times", "GET")).toBe(true);
  });
  it.each([undefined, "document", "fetch", "xhr", "stylesheet", "image", "other"])("does not promote script authority to %s", kind => {
    expect(recipeAllowsRequest(parseAccessRecipe(recipe()), url, "GET", kind)).toBe(false);
  });
  it.each(["HEAD", "POST", "OPTIONS"])("does not promote the observed GET to %s", method => {
    expect(recipeAllowsRequest(parseAccessRecipe(recipe()), url, method, "script")).toBe(false);
  });
  it("keeps exact host/path and query-key boundaries", () => {
    const parsed = parseAccessRecipe(recipe());
    for (const other of [url.replace("apis.google.com", "other.example.org"), url.replace("platform.js", "other.js"),
      url + "&extra=public", url + "&token=private", url.replace("https:", "http:")])
      expect(recipeAllowsRequest(parsed, other, "GET", "script")).toBe(false);
  });
  it("supports literal public build-path punctuation without changing the legacy path grammar", () => {
    const scoped = { ...asset(), path: "/_/scs/abc-static/_/js/k=public-build/m=client/rt=j/sv=1/d=1/ed=1/cb=gapi.loaded_0", queryKeys: ["le"] };
    const parsed = parseAccessRecipe({ ...recipe(), permittedRoutes: [scoped] });
    expect(recipeAllowsRequest(parsed, scoped.origin + scoped.path + "?le=public", "GET", "script")).toBe(true);
    const legacy = { origin: asset().origin, path: asset().path, methods: ["GET"], queryKeys: ["onload"] };
    expect(recipeRouteSchema.safeParse(legacy).success).toBe(false);
  });
  it.each([
    { path: "/js/*" }, { path: "/*" }, { path: "/js/../platform.js" }, { path: "/js/%2e%2e/platform.js" },
    { path: "/js/public.js?key=public" }, { path: "/js/public.js#fragment" }, { path: "/js/{{date}}.js" },
    { path: "/account/profile.js" }, { path: "/checkout/pay.js" }, { path: "/js/public\n.js" },
    { methods: ["POST"] }, { methods: ["GET", "HEAD"] }, { resourceTypes: [] }, { resourceTypes: ["fetch"] },
    { resourceTypes: ["script", "script"] }, { queryKeys: ["api_key"] }, { origin: "https://127.0.0.1" },
  ])("rejects expanded or unsafe asset routes %j", override => {
    expect(recipeRouteSchema.safeParse({ ...asset(), ...override }).success).toBe(false);
  });
  it("retains the forty data-route limit while allowing up to 128 exact assets", () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ origin: "https://example.org", path: `/data/${i}`, methods: ["GET"] }));
    const assets = Array.from({ length: 128 }, (_, i) => ({ ...asset(), path: `/js/public-${i}.js` }));
    expect(parseAccessRecipe({ ...recipe(), permittedRoutes: [...data, ...assets] }).permittedRoutes).toHaveLength(168);
    expect(() => parseAccessRecipe({ ...recipe(), permittedRoutes: [...data, { ...data[0], path: "/data/extra" }] })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe(), permittedRoutes: [...assets, { ...asset(), path: "/js/extra.js" }] })).toThrow();
  });
  it("cannot attach asset-only routes to an HTTP request recipe", () => {
    const browser = recipe();
    expect(() => parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: browser.target, source: browser.source,
      permittedRoutes: [asset()], request: { url: "https://example.org/api/availability?date={{date}}", method: "GET" },
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "players" } } })).toThrow();
  });
});
