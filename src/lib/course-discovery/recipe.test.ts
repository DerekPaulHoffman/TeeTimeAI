import { describe, expect, it } from "vitest";
import { accessExecutionInputSchema, accessExecutionResultSchema, expandRecipeTemplate, hashAccessRecipe,
  isActiveBrowserAccessChallenge, isSafeBrowserAssetUrl, isSafeRecipeUrl, parseAccessRecipe, recipeAllowsRequest, recipeSelectorSchema } from "./recipe";

export const httpRecipe = () => ({
  schemaVersion: 1 as const, engine: "HTTP_JSON" as const,
  target: { courseId: "course-1", kind: "OUTDOOR" as const },
  source: { officialUrl: "https://example.org/golf", bookingUrl: "https://example.org/tee-times",
    venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: "America/New_York" },
  permittedRoutes: [{ origin: "https://example.org", path: "/api/availability", methods: ["GET" as const], queryKeys: ["date", "players", "zone"] }],
  request: { url: "https://example.org/api/availability?date={{date}}&players={{players}}&zone={{timeZone}}", method: "GET" as const },
  proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" }, players: { path: "players" } },
  slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "capacity" }, holes: { path: "holes" } },
});
export const executionInput = { date: "2026-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };

describe("course access recipes", () => {
  it("accepts only typed existing adapter metadata without model-defined routes or extractors", () => {
    const base = httpRecipe();
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: base.target,
      source: { ...base.source, bookingUrl: "https://foreupsoftware.com/index.php/booking/1234/5678", providerFamily: "FOREUP" },
      adapter: { family: "FOREUP", facilityId: 1234, scheduleId: 5678, bookingClassId: 9 } };
    const parsed = parseAccessRecipe(recipe);
    expect(parsed.engine).toBe("EXISTING_ADAPTER");
    expect(recipeAllowsRequest(parsed, recipe.source.bookingUrl, "GET")).toBe(false);
    expect(() => parseAccessRecipe({ ...recipe, permittedRoutes: base.permittedRoutes })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, request: "https://example.org" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, providerFamily: "ACUITY" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, target: { ...base.target, kind: "SIMULATOR" } })).toThrow();
  });
  it("allows only static browser assets to use opaque build paths without weakening query or data guards", () => {
    const asset = "https://example.org/_next/static/9l1MKswa6ugeZKoWAbIS1/_buildManifest.js";
    expect(isSafeRecipeUrl(asset)).toBe(false);
    expect(isSafeBrowserAssetUrl(asset, "script", "GET")).toBe(true);
    expect(isSafeBrowserAssetUrl(asset, "fetch", "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl(asset, "script", "POST")).toBe(false);
    expect(isSafeBrowserAssetUrl(`${asset}?token=private`, "script", "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl(`${asset}?v=abcdefghijklmnopqrst1234`, "script", "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl("https://example.org/secret/runtime.js", "script", "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl("https://127.0.0.1/runtime.js", "script", "GET")).toBe(false);
    const recipe = parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [{ origin: "https://example.org", path: "/_next/static/*", methods: ["GET"], queryKeys: [] }] });
    expect(recipeAllowsRequest(recipe, asset, "GET", "script")).toBe(true);
    expect(recipeAllowsRequest(recipe, asset, "GET")).toBe(false);
    expect(recipeAllowsRequest(recipe, asset.replace("example.org", "other.example.org"), "GET", "script")).toBe(false);
  });
  it("parses a complete recipe and hashes object key order deterministically", () => {
    const recipe = parseAccessRecipe(httpRecipe());
    const reordered = Object.fromEntries(Object.entries(recipe).reverse());
    expect(hashAccessRecipe(recipe)).toBe(hashAccessRecipe(parseAccessRecipe(reordered)));
  });
  it.each(["http://example.org/tee-times", "https://127.0.0.1/", "https://localhost/", "https://example.internal/", "https://u:p@example.org/", "https://example.org:8443/", "https://example.org/checkout", "https://example.org/?token=secret"])("rejects unsafe source %s", url => {
    const recipe = httpRecipe(); recipe.source.bookingUrl = url;
    expect(() => parseAccessRecipe(recipe)).toThrow();
  });
  it("rejects code, unknown fields, arbitrary templates, wild origins and unrestricted routes", () => {
    expect(() => parseAccessRecipe({ ...httpRecipe(), script: "alert(1)" })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), request: { method: "GET", url: "https://example.org/{{process}}" } })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [{ origin: "https://example.org", path: "/*", methods: ["GET"] }] })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), request: { ...httpRecipe().request, body: { query: "bad" } } })).toThrow();
  });
  it("permits public reservation landing names while rejecting transaction operations", () => {
    for (const path of ["/reserve", "/reservation", "/reservations", "/online-reservations"])
      expect(isSafeRecipeUrl(`https://example.org${path}`)).toBe(true);
    for (const path of ["/reservation/create", "/reservations/submit", "/booking/confirm", "/cart", "/checkout"])
      expect(isSafeRecipeUrl(`https://example.org${path}`)).toBe(false);
  });
  it("distinguishes active access challenges from ordinary CAPTCHA instructions", () => {
    expect(isActiveBrowserAccessChallenge("First time, you will have to select a picture in CAPTCHA when booking.", "Public golf")).toBe(false);
    expect(isActiveBrowserAccessChallenge("Verify you are human to continue", "Just a moment...")).toBe(true);
    expect(isActiveBrowserAccessChallenge("Checking your browser before continuing", "Golf")).toBe(true);
    expect(isActiveBrowserAccessChallenge("You must sign in to book. Public tee times are shown below.", "Golf")).toBe(false);
    expect(isActiveBrowserAccessChallenge("You must sign in to view tee times.", "Golf")).toBe(true);
  });
  it.each(["script", "input[type=password]", "#token", "iframe", "div:has(script)", "x;alert(1)"])("rejects unsafe selector %s", selector => {
    expect(recipeSelectorSchema.safeParse(selector).success).toBe(false);
  });
  it("keeps query escaping and route matching separate", () => {
    const recipe = parseAccessRecipe(httpRecipe());
    const value = expandRecipeTemplate(recipe.engine === "HTTP_JSON" ? recipe.request.url : "", executionInput, true);
    expect(value).toContain("zone=America%2FNew_York");
    expect(recipeAllowsRequest(recipe, value, "GET")).toBe(true);
    expect(recipeAllowsRequest(recipe, value + "&extra=1", "GET")).toBe(false);
    expect(recipeAllowsRequest(recipe, value, "POST")).toBe(false);
    expect(recipeAllowsRequest(recipe, value.replace("example.org", "evil.example.org"), "GET")).toBe(false);
  });
  it("requires simulator identity, duration and end-time evidence", () => {
    const recipe = httpRecipe();
    expect(() => parseAccessRecipe({ ...recipe, target: { ...recipe.target, kind: "SIMULATOR" } })).toThrow();
  });
  it("requires simulator DOM resource scopes and forbids page roots or unrelated products", () => {
    const base = httpRecipe();
    const dom = { schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" }, source: base.source,
      permittedRoutes: base.permittedRoutes, pageUrl: base.source.bookingUrl, steps: [],
      availabilityResponse: { url: "https://example.org/api/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#loaded" }, durationMinutes: { selector: "#duration" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } };
    expect(() => parseAccessRecipe(dom)).toThrow(/resource-card scope/u);
    const scope = { selector: "article.resource", label: { selector: "h2" }, expectedLabel: "Golf Simulator" };
    expect(() => parseAccessRecipe({ ...dom, slots: { ...dom.slots, scope } })).not.toThrow();
    expect(() => parseAccessRecipe({ ...dom, slots: { ...dom.slots, scope: { ...scope, selector: "body" } } })).toThrow();
    expect(() => parseAccessRecipe({ ...dom, slots: { ...dom.slots, scope: { ...scope, expectedLabel: "Golf Lessons" } } })).toThrow();
    expect(() => parseAccessRecipe({ ...dom, slots: { ...dom.slots, scope: { ...scope, expectedLabel: "Multi-Sport" } } })).toThrow();
  });
  it("requires a date-response fence and explicit JSON success for response-only completion", () => {
    const base = httpRecipe();
    const dom = { schemaVersion: 1, engine: "BROWSER_DOM", target: base.target, source: base.source,
      permittedRoutes: base.permittedRoutes, pageUrl: base.source.bookingUrl, steps: [],
      proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { availabilityResponse: true } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } } };
    expect(() => parseAccessRecipe(dom)).toThrow();
    const availabilityResponse = { url: "https://example.org/api/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } };
    expect(() => parseAccessRecipe({ ...dom, availabilityResponse })).toThrow(/success guard/u);
    expect(() => parseAccessRecipe({ ...dom, availabilityResponse: { ...availabilityResponse, success: { path: "code", equals: 200 } } })).not.toThrow();
  });
  it("keeps observed date-part composition confined to the DOM date proof", () => {
    const date = { kind: "DATE_PARTS", monthYear: { selector: ".datepicker-switch" }, day: { selector: "td.active.day" } };
    expect(() => parseAccessRecipe({ ...httpRecipe(), proof: { ...httpRecipe().proof, date } })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), proof: { ...httpRecipe().proof, venue: date } })).toThrow();
  });
  it("requires outdoor capacity but forbids using saved simulator players in provider queries", () => {
    const base = httpRecipe();
    const slots = { ...base.slots }; Reflect.deleteProperty(slots, "availableSpots");
    expect(() => parseAccessRecipe({ ...base, slots })).toThrow();
    expect(() => parseAccessRecipe({ ...base, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" },
      proof: { ...base.proof, durationMinutes: { path: "duration" } }, slots: { ...slots, endsAt: { path: "end" } } })).toThrow(/saved context/u);
  });
  it("rejects invalid dates and non-forward windows", () => {
    expect(accessExecutionInputSchema.safeParse({ ...executionInput, date: "2026-02-30" }).success).toBe(false);
    expect(accessExecutionInputSchema.safeParse({ ...executionInput, startTime: "14:00" }).success).toBe(false);
    expect(accessExecutionInputSchema.safeParse({ ...executionInput, startTime: "23:00", endTime: "24:00" }).success).toBe(true);
    expect(accessExecutionInputSchema.safeParse({ ...executionInput, startTime: "24:00", endTime: "24:00" }).success).toBe(false);
  });
  it("does not accept incomplete matching results", () => {
    expect(accessExecutionResultSchema.safeParse({ status: "AVAILABLE", complete: false }).success).toBe(false);
  });
});
