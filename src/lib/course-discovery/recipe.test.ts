import { describe, expect, it } from "vitest";
import { z } from "zod";
import { venueProofMatches } from "./executor";
import { matchesPublicVenueGreeting } from "./public-venue-greeting";
import { accessExecutionInputSchema, accessExecutionResultSchema, accessRecipeSchema, expandRecipeTemplate, hashAccessRecipe,
  isActiveBrowserAccessChallenge, isSafeBrowserAssetUrl, isSafeBrowserBootstrapReadUrl, isSafeBrowserAvailabilityReadUrl, isSafeRecipeUrl, parseAccessRecipe, recipeAllowsRequest, recipeSelectorSchema, readRecipeFieldFormat,
  SERVER_DOCUMENT_SELECTOR_MESSAGE } from "./recipe";

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
const serverDocumentRecipe = () => ({
  schemaVersion: 1, engine: "BROWSER_DOM", target: httpRecipe().target, source: httpRecipe().source,
  pageUrl: "https://example.org/teetimes?teedate={{dateCompact}}", steps: [],
  permittedRoutes: [{ origin: "https://example.org", path: "/teetimes", methods: ["GET"], queryKeys: ["teedate"] }],
  availabilityResponse: { kind: "SERVER_DOCUMENT", url: "https://example.org/teetimes?teedate={{dateCompact}}",
    method: "GET", date: { source: "QUERY", path: "teedate" } },
  proof: { venue: { selector: ".be_search_message_body p", format: "VENUE_GREETING" },
    date: { selector: "#SearchForm_Date", attribute: "value" }, complete: { serverDocument: true } },
  slots: { collection: { selector: ".matrixTable tbody tr" }, startsAt: { selector: ".mtrxTeeTimes" },
    availableSpots: { selector: ".matrixPlayers" }, minimumPlayers: { selector: ".matrixPlayers" } },
});

describe("course access recipes", () => {
  it("keeps the public language-bearing inventory read inside explicit browser routes", () => {
    const template = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=publicrental&time_slot=12:00&party_size=1&halo_size_interval=16&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration={{durationMinutes}}";
    const url = expandRecipeTemplate(template, { ...executionInput, durationMinutes: 60 }, true);
    expect(isSafeRecipeUrl(url)).toBe(false);
    expect(isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET")).toBe(true);
    const base = serverDocumentRecipe();
    const recipe = parseAccessRecipe({ ...base, proof: { ...base.proof, complete: { selector: "#ready" } },
      availabilityResponse: { url: template, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" } },
      permittedRoutes: [...base.permittedRoutes, { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"],
        queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "selected_lang_code", "picked_duration"] }] });
    expect(recipeAllowsRequest(recipe, url, "GET", "fetch")).toBe(true);
    expect(recipeAllowsRequest(recipe, url, "GET", "document")).toBe(false);
    expect(recipeAllowsRequest(recipe, url, "POST", "fetch")).toBe(false);
    expect(recipeAllowsRequest({ ...recipe, permittedRoutes: base.permittedRoutes }, url, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(recipe, url + "&client_id=anonymous", "GET", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, bookingUrl: url } })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), request: { url: template, method: "GET" } })).toThrow();
    expect(expandRecipeTemplate("{{dateMdy}}|{{month}}|{{day}}", { date: "2030-01-02" })).toBe("01-02-2030|1|2");
  });

  it.each([".be_search_message_body p:first-child", ".be_search_message_body p:nth-of-type(1)"])(
    "identifies the exact unsupported static venue selector field for %s", selector => {
      const recipe = serverDocumentRecipe();
      for (const venue of [{ ...recipe.proof.venue, selector }, { selector }]) {
        const result = accessRecipeSchema.safeParse({ ...recipe, proof: { ...recipe.proof, venue } });
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected the static selector rejection");
        expect(result.error.issues).toEqual([{ code: "custom", path: ["proof", "venue", "selector"], message: SERVER_DOCUMENT_SELECTOR_MESSAGE }]);
        expect(JSON.stringify(result.error.issues)).not.toContain(selector);
      }
    });
  it.each(["#venue", ".venue", ".venue p", "section.venue > p.greeting", "h1#venue.title"])(
    "retains valid static selector %s and the supported value attribute reader", selector => {
      const recipe = serverDocumentRecipe();
      expect(parseAccessRecipe({ ...recipe, proof: { ...recipe.proof, venue: { ...recipe.proof.venue, selector } } }))
        .toMatchObject({ proof: { venue: { selector }, date: { selector: "#SearchForm_Date", attribute: "value" } } });
    });
  it.each(["p[class=greeting]", ".venue *", "h1,h2", "h1 + p", "h1 ~ p"])(
    "preserves the static grammar rejection for %s", selector => {
      const recipe = serverDocumentRecipe(), result = accessRecipeSchema.safeParse({ ...recipe,
        proof: { ...recipe.proof, venue: { ...recipe.proof.venue, selector } } });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected the static selector rejection");
      expect(result.error.issues).toContainEqual({ code: "custom", path: ["proof", "venue", "selector"], message: SERVER_DOCUMENT_SELECTOR_MESSAGE });
    });
  it.each([
    ["proof", "date"], ["proof", "complete"], ["proof", "empty"], ["proof", "players"], ["proof", "durationMinutes"],
    ["slots", "collection"], ["slots", "startsAt"], ["slots", "endsAt"], ["slots", "availableSpots"],
    ["slots", "minimumPlayers"], ["slots", "capacity"], ["slots", "holes"], ["slots", "resourceId"], ["slots", "productId"],
  ] as const)("reports an unsupported static selector at %s.%s.selector", (section, name) => {
    const recipe = serverDocumentRecipe(), result = accessRecipeSchema.safeParse({ ...recipe,
      [section]: { ...recipe[section], [name]: { selector: ".field:nth-of-type(1)" } } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the static selector rejection");
    expect(result.error.issues).toContainEqual({ code: "custom", path: [section, name, "selector"], message: SERVER_DOCUMENT_SELECTOR_MESSAGE });
  });
  it("does not impose static selector grammar on an ordinary browser JSON-response recipe", () => {
    const recipe = serverDocumentRecipe();
    expect(() => parseAccessRecipe({ ...recipe, availabilityResponse: { ...recipe.availabilityResponse, kind: "JSON" },
      proof: { ...recipe.proof, venue: { ...recipe.proof.venue, selector: ".venue p:first-child" }, complete: { selector: "#ready" } } })).not.toThrow();
  });
  it("emits the precise conditional static grammar in the model's actual JSON schema", () => {
    const schema = z.toJSONSchema(accessRecipeSchema, { io: "input", unrepresentable: "any" });
    const descriptions: string[] = [];
    const inspect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const node = value as { properties?: { engine?: { const?: string }; availabilityResponse?: { description?: string } } };
      if (node.properties?.engine?.const === "BROWSER_DOM") descriptions.push(node.properties.availabilityResponse?.description ?? "");
      for (const child of Object.values(value)) inspect(child);
    };
    inspect(schema);
    expect(descriptions).toHaveLength(1);
    for (const rule of ["For SERVER_DOCUMENT, every proof field selector, slot field selector and slots.collection.selector",
      SERVER_DOCUMENT_SELECTOR_MESSAGE, ":first-child and :nth-of-type(1) are unsupported", 'attribute:"value" remain available'])
      expect(descriptions[0]).toContain(rule);
    expect(JSON.stringify(schema)).toContain("SERVER_DOCUMENT proof and slot/collection readers use the stricter static grammar");
  });
  it("exposes the existing bounded venue-name equivalence in the model's greeting JSON schema", () => {
    const schema = z.toJSONSchema(accessRecipeSchema, { io: "input", unrepresentable: "any" });
    const variants: Array<Record<string, unknown>> = [];
    const inspect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if ((node.properties as { format?: { const?: string } } | undefined)?.format?.const === "VENUE_GREETING") variants.push(node);
      for (const child of Object.values(node)) inspect(child);
    };
    inspect(schema);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ required: ["selector", "format"], additionalProperties: false });
    const description = String(variants[0].description);
    for (const rule of ["main name and rate name independently", "Unicode compatibility forms, case, punctuation and spacing",
      "terminal Golf Club or Golf Course", "remaining whole-name cores match", "at least 8 letters/digits", "not generic golf/category words",
      "Example Ridge Golf Club matches Example Ridge", "arbitrary abbreviations, substring matches or another location",
      "never changes the canonical source identity", "Raw/live text equality is checked before interpretation"])
      expect(description).toContain(rule);

    const greeting = (main: string, rate: string) => `Welcome to ${main}'s online tee time engine. You are guaranteed to receive the best online rates for ${rate} when you book direct with us. We look forward to seeing on the golf course.`;
    const canonical = "Example Ridge Golf Club";
    for (const [main, rate] of [[canonical, "Example Ridge"], ["Example Ridge", canonical], ["EXAMPLE-RIDGE", "Example Ridge Golf Course"]])
      expect(matchesPublicVenueGreeting(canonical, greeting(main, rate), venueProofMatches)).toBe(true);
    for (const other of ["Example Ridge East", "Other Example Ridge", "Ridge", "ERGC"])
      for (const [main, rate] of [[canonical, other], [other, canonical]])
        expect(matchesPublicVenueGreeting(canonical, greeting(main, rate), venueProofMatches)).toBe(false);
    expect(matchesPublicVenueGreeting("Ridge Golf Club", greeting("Ridge Golf Club", "Ridge"), venueProofMatches)).toBe(false);
    expect(matchesPublicVenueGreeting("Public Golf Club", greeting("Public Golf Club", "Public"), venueProofMatches)).toBe(false);
  });
  it("allows an opt-in greeting only for DOM venue text and preserves the full raw reader value", () => {
    const greeting = { selector: "#venue", format: "VENUE_GREETING" };
    const dom = { schemaVersion: 1, target: httpRecipe().target, source: httpRecipe().source, engine: "BROWSER_DOM", pageUrl: "https://example.org/?date={{date}}", steps: [],
      permittedRoutes: [{ origin: "https://example.org", path: "/", methods: ["GET"], queryKeys: ["date"] }],
      availabilityResponse: { kind: "SERVER_DOCUMENT", url: "https://example.org/?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: greeting, date: { selector: "#date", attribute: "value" }, complete: { serverDocument: true } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } } };
    const parsed = parseAccessRecipe(dom);
    expect(parsed).toMatchObject({ engine: "BROWSER_DOM", proof: { venue: greeting } });
    expect(readRecipeFieldFormat({ selector: "#venue", format: "VENUE_GREETING" }, " Welcome to Example Golf. "))
      .toBe(" Welcome to Example Golf. ");
    expect(hashAccessRecipe(parsed)).not.toBe(hashAccessRecipe(parseAccessRecipe({ ...dom, proof: { ...dom.proof, venue: { selector: "#venue" } } })));
    for (const venue of [{ ...greeting, attribute: "aria-label" }, { ...greeting, attribute: "value" }, { ...greeting, path: "venue" }, { path: "venue", format: "VENUE_GREETING" }])
      expect(() => parseAccessRecipe({ ...dom, proof: { ...dom.proof, venue } })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), proof: { ...httpRecipe().proof, venue: greeting } })).toThrow();
    for (const key of ["date", "complete", "empty", "players", "durationMinutes"])
      expect(() => parseAccessRecipe({ ...dom, proof: { ...dom.proof, [key]: greeting } })).toThrow();
    for (const key of ["startsAt", "endsAt", "availableSpots", "minimumPlayers", "capacity", "holes", "resourceId", "productId"])
      expect(() => parseAccessRecipe({ ...dom, slots: { ...dom.slots, [key]: greeting } })).toThrow();
  });
  it("keeps TeeItUp outdoor by default and requires explicit single-facility simulator metadata", () => {
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "sim", offeringId: "rental", kind: "SIMULATOR" },
      source: { ...httpRecipe().source, bookingUrl: "https://studio.book.teeitup.com/", venueAddress: "100 Main Rd Suite A, Example, NY 12345, US", providerFamily: "TEEITUP" },
      adapter: { family: "TEEITUP", alias: "studio", facilityIds: [11], offeringKind: "SIMULATOR" } };
    expect(parseAccessRecipe(recipe)).toMatchObject({ adapter: { offeringKind: "SIMULATOR" } });
    expect(() => parseAccessRecipe({ ...recipe, adapter: { family: "TEEITUP", alias: "studio", facilityIds: [11] } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, target: { courseId: "sim", kind: "OUTDOOR" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, facilityIds: [11, 22] } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, target: { courseId: "sim", kind: "SIMULATOR" } })).toThrow();
  });
  it("keeps EZLinks recipes outdoor and persists public identity without transient request authority", () => {
    const base = httpRecipe();
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: base.target,
      source: { ...base.source, bookingUrl: "https://public-course.ezlinksgolf.com/search", providerFamily: "EZLINKS",
        venueAddress: "17 Golf Way, Example, NY 12345, US" },
      adapter: { family: "EZLINKS", tenant: "public-course", sponsorId: 901, courseIds: [17], catalogHash: "a".repeat(64), browserTransport: "NATIVE_CHROME",
        clients: [
          { path: "/assets/index-DsLbHQvf.js", sha256: "4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb" },
          { path: "/assets/index-CvL6jQuU.js", sha256: "6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f" },
        ] } };
    const parsed = parseAccessRecipe(recipe);
    expect(parsed).toMatchObject({ engine: "EXISTING_ADAPTER", adapter: { family: "EZLINKS" } });
    expect(recipeAllowsRequest(parsed, "https://public-course.ezlinksgolf.com/api/search/search", "POST")).toBe(false);
    expect(() => parseAccessRecipe({ ...recipe, target: { courseId: "course", offeringId: "rental", kind: "SIMULATOR" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, venueAddress: undefined } })).toThrow();
    for (const field of ["documentToken", "session", "request", "holdAndReturnOne"])
      expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, [field]: "not-reusable-authority" } })).toThrow();
  });

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
  it.each([
    "https://public.example.org/App/GlobalTenantSettings",
    "https://public.example.org/AuthenticationSettings",
    "https://public.example.org/AuthenticationSettings?AuthenticationType=",
    "https://public.example.org/Booking/Teetimes/GetReadOnlyTeeSheet",
    "https://public.example.org/api-yoa/dining/venue_info?venue_url_key=public-golf-studio&widget_type=embedded&modify_upgrades=false",
  ])("allows only browser GET metadata for the observed public RPC shape %s", url => {
    expect(isSafeRecipeUrl(url)).toBe(false);
    expect(isSafeBrowserBootstrapReadUrl(url, "xhr", "GET")).toBe(true);
    expect(isSafeBrowserBootstrapReadUrl(url, "fetch", "GET")).toBe(true);
    for (const kind of ["document", "script", "stylesheet", "other", ""])
      expect(isSafeBrowserBootstrapReadUrl(url, kind, "GET")).toBe(false);
    for (const method of ["POST", "HEAD", "OPTIONS", "DELETE"])
      expect(isSafeBrowserBootstrapReadUrl(url, "fetch", method)).toBe(false);
  });
  it("keeps public bootstrap permission route-scoped and outside HTTP, source, page and response proof", () => {
    const url = "https://public.example.org/api-yoa/dining/venue_info?venue_url_key=public-golf-studio&widget_type=embedded&modify_upgrades=false";
    const route = { origin: "https://public.example.org", path: "/api-yoa/dining/venue_info", methods: ["GET"], queryKeys: ["venue_url_key", "widget_type", "modify_upgrades"] };
    const browser = parseAccessRecipe({ ...serverDocumentRecipe(), permittedRoutes: [...serverDocumentRecipe().permittedRoutes, route] });
    expect(recipeAllowsRequest(browser, url, "GET", "fetch")).toBe(true);
    for (const value of [url.replace("public.example.org", "other.example.org"), url.replace("/venue_info", "/other"), `${url}&unexpected=1`])
      expect(recipeAllowsRequest(browser, value, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(browser, url, "GET", "document")).toBe(false);
    expect(recipeAllowsRequest(parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [...httpRecipe().permittedRoutes, route] }), url, "GET", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...serverDocumentRecipe(), source: { ...httpRecipe().source, bookingUrl: url } })).toThrow();
    expect(() => parseAccessRecipe({ ...serverDocumentRecipe(), pageUrl: url })).toThrow();
    expect(() => parseAccessRecipe({ ...serverDocumentRecipe(), availabilityResponse: { ...serverDocumentRecipe().availabilityResponse, url } })).toThrow();
    expect(url).toBe("https://public.example.org/api-yoa/dining/venue_info?venue_url_key=public-golf-studio&widget_type=embedded&modify_upgrades=false");
  });
  it.each([
    "/accounts/12345678-1234-4234-8234-123456789abc/config",
    "/accounts/12345678-1234-4234-8234-123456789abc/hivemind",
    "/v3/accounts/12345678-1234-4234-8234-123456789abc/services?per_page=80&with_category_ids=true",
    "/v2/accounts/12345678-1234-4234-8234-123456789abc/categories",
  ])("admits only browser GET metadata for the public service catalog role %s", path => {
    const url = "https://api.ola.godaddy.com" + path;
    expect(isSafeRecipeUrl(url)).toBe(false);
    for (const kind of ["xhr", "fetch"]) expect(isSafeBrowserBootstrapReadUrl(url, kind, "GET")).toBe(true);
    for (const kind of ["document", "script", "stylesheet", "other", ""]) expect(isSafeBrowserBootstrapReadUrl(url, kind, "GET")).toBe(false);
    for (const method of ["HEAD", "POST", "OPTIONS", "DELETE"]) expect(isSafeBrowserBootstrapReadUrl(url, "fetch", method)).toBe(false);
    const route = { origin: "https://api.ola.godaddy.com", path: path.split("?")[0], methods: ["GET"], queryKeys: path.includes("?") ? ["per_page", "with_category_ids"] : [] };
    const base = serverDocumentRecipe(), browser = parseAccessRecipe({ ...base, permittedRoutes: [...base.permittedRoutes, route] });
    expect(recipeAllowsRequest(browser, url, "GET", "fetch")).toBe(true);
    expect(recipeAllowsRequest(parseAccessRecipe(base), url, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(browser, url, "GET", "document")).toBe(false);
    expect(recipeAllowsRequest(parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [...httpRecipe().permittedRoutes, route] }), url, "GET", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...base, source: { ...base.source, bookingUrl: url } })).toThrow();
    expect(() => parseAccessRecipe({ ...base, pageUrl: url })).toThrow();
    expect(() => parseAccessRecipe({ ...base, availabilityResponse: { ...base.availabilityResponse, url } })).toThrow();
    expect(url).toBe("https://api.ola.godaddy.com" + path);
  });
  it("rejects public service metadata aliases, credentials, extra queries and customer endpoints", () => {
    const root = "https://api.ola.godaddy.com", account = "/accounts/12345678-1234-4234-8234-123456789abc";
    const config = root + account + "/config", services = root + "/v3" + account + "/services?per_page=80&with_category_ids=true";
    for (const url of [
      config.replace("https:", "http:"), config.replace("api.ola.godaddy.com", "api.ola.godaddy.com.example.org"),
      config.replace("api.ola.godaddy.com", "other.godaddy.com"), config.replace(".com/", ".com:443/"),
      config.replace("https://", "https://user:password@"), config.replace("789abc", "789ABC"),
      config.replace("12345678-", "%31" + "2345678-"), config.replace("/accounts/", "/x/../accounts/"),
      config.replace("/accounts/", "/accounts//"), config.replace("/config", "/%63onfig"), config + "/", config + "?", config + "#", config + "#fragment",
      config + "?token=private", config + "?date=2030-01-02", config + "\n", config.replace("/config", "/customers"),
      root + "/v2" + account + "/customers", root + account + "/contacts", root + account + "/services",
      root + "/v3" + account + "/config", root + "/v2" + account + "/categories?per_page=80",
      root + account + "/hivemind?", services.replace("80", "81"), services.replace("true", "false"),
      services + "&per_page=80", services + "&date=2030-01-02", services.replace("per_page", "%70er_page"),
      services.replace("=80", "=%38%30"), services.replace("&with_category_ids=true", ""),
      services.replace("12345678-1234-4234-8234-123456789abc", "not-a-uuid"),
    ]) expect(isSafeBrowserBootstrapReadUrl(url, "fetch", "GET"), url).toBe(false);
  });
  it("separates dated public service inventory from calendar and optional metadata", () => {
    const account = "/accounts/12345678-1234-4234-8234-123456789abc", origin = "https://api.ola.godaddy.com";
    const query = "?start_time=" + encodeURIComponent("2030-11-03T00:00:00.000-04:00") + "&end_time=" + encodeURIComponent("2030-11-03T23:59:59.999-05:00") + "&resource_ids[]=11&resource_ids[]=12";
    const times = origin + "/v2" + account + "/services/73/available_times" + query;
    const dates = origin + account + "/services/73/available_dates" + query;
    const metadata = [dates, origin + account + "/config?fields[]=cart", origin + "/addons/v1" + account + "/services/73/addons"];
    expect(isSafeBrowserAvailabilityReadUrl(times, "fetch", "GET")).toBe(true);
    expect(isSafeBrowserBootstrapReadUrl(times, "fetch", "GET")).toBe(false);
    for (const url of [times, ...metadata]) {
      const inventory = url === times, predicate = inventory ? isSafeBrowserAvailabilityReadUrl : isSafeBrowserBootstrapReadUrl;
      expect(isSafeRecipeUrl(url)).toBe(false);
      for (const kind of ["xhr", "fetch"]) expect(predicate(url, kind, "GET")).toBe(true);
      for (const kind of ["document", "script", "stylesheet", "other", ""]) expect(predicate(url, kind, "GET")).toBe(false);
      for (const method of ["POST", "HEAD", "OPTIONS", "DELETE"]) expect(predicate(url, "fetch", method)).toBe(false);
      if (!inventory) expect(isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET")).toBe(false);
      const base = serverDocumentRecipe(), parsed = new URL(url);
      const route = { origin, path: parsed.pathname, methods: ["GET"], queryKeys: [...new Set(parsed.searchParams.keys())] };
      const browser = parseAccessRecipe({ ...base, permittedRoutes: [...base.permittedRoutes, route] });
      expect(recipeAllowsRequest(browser, url, "GET", "fetch")).toBe(true);
      expect(recipeAllowsRequest(parseAccessRecipe(base), url, "GET", "fetch")).toBe(false);
      expect(recipeAllowsRequest(browser, url, "GET", "document")).toBe(false);
      expect(recipeAllowsRequest(parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [...httpRecipe().permittedRoutes, route] }), url, "GET", "fetch")).toBe(false);
      expect(() => parseAccessRecipe({ ...httpRecipe(), request: { url, method: "GET" } })).toThrow();
      expect(() => parseAccessRecipe({ ...base, source: { ...base.source, bookingUrl: url } })).toThrow();
      expect(() => parseAccessRecipe({ ...base, pageUrl: url })).toThrow();
      if (!inventory) expect(() => parseAccessRecipe({ ...base, availabilityResponse: { ...base.availabilityResponse, url } })).toThrow();
    }
  });
  it("validates public service calendar, offset, resource and finite raw query bounds", () => {
    const root = "https://api.ola.godaddy.com", account = "/accounts/12345678-1234-4234-8234-123456789abc";
    const dated = (role: "times" | "dates", start: string, end: string, resources = ["11", "12"]) => root + (role === "times" ? "/v2" : "") + account + "/services/73/available_" + role + "?start_time=" + encodeURIComponent(start) + "&end_time=" + encodeURIComponent(end) + resources.map(id => "&resource_ids[]=" + id).join("");
    const check = (role: "times" | "dates", start: string, end: string, expected: boolean, resources?: string[]) => {
      const url = dated(role, start, end, resources);
      expect((role === "times" ? isSafeBrowserAvailabilityReadUrl : isSafeBrowserBootstrapReadUrl)(url, "fetch", "GET"), url).toBe(expected);
    };
    check("times", "2032-02-29T12:34:56.123-05:00", "2032-02-29T23:59:59.999-05:00", true);
    check("times", "2030-11-03T00:00:00.000-04:00", "2030-11-03T23:59:59.999-05:00", true);
    check("dates", "2030-11-01T12:00:00.000-04:00", "2030-12-02T23:59:59.999-05:00", true);
    check("times", "2030-01-02T00:00:00.000+14:00", "2030-01-02T01:00:00.000+14:00", true, Array.from({ length: 32 }, (_, i) => String(i + 1)));
    for (const [start, end] of [
      ["2030-02-29T00:00:00.000-05:00", "2030-02-29T23:59:59.999-05:00"],
      ["2030-04-31T00:00:00.000-05:00", "2030-04-31T23:59:59.999-05:00"],
      ["2030-01-02T24:00:00.000-05:00", "2030-01-02T23:59:59.999-05:00"],
      ["2030-01-02T00:60:00.000-05:00", "2030-01-02T23:59:59.999-05:00"],
      ["2030-01-02T00:00:60.000-05:00", "2030-01-02T23:59:59.999-05:00"],
      ["2030-01-02T00:00:00.000+14:01", "2030-01-02T23:59:59.999+14:01"],
      ["2030-01-02T00:00:00.000-00:00", "2030-01-02T23:59:59.999-00:00"],
      ["2030-01-02T00:00:00Z", "2030-01-02T23:59:59Z"],
      ["2030-01-02T12:00:00.000-05:00", "2030-01-02T12:00:00.000-05:00"],
      ["2030-01-02T13:00:00.000-05:00", "2030-01-02T12:00:00.000-05:00"],
    ]) for (const role of ["times", "dates"] as const) check(role, start, end, false);
    check("times", "2030-01-02T00:00:00.000-05:00", "2030-01-03T00:00:00.001-05:00", false);
    check("times", "2030-01-02T00:00:00.000+14:00", "2030-01-02T23:59:59.999-14:00", false);
    check("dates", "2030-11-01T00:00:00.000-04:00", "2030-12-02T23:59:59.999-05:00", false); // Over 32 elapsed days across DST.
    check("dates", "2030-01-01T23:59:59.999-05:00", "2030-02-02T00:00:00.000-05:00", false); // 33 local dates.
    for (const resources of [[], ["11", "11"], ["0"], ["01"], ["-1"], ["2147483648"], Array.from({ length: 33 }, (_, i) => String(i + 1))])
      check("times", "2030-01-02T00:00:00.000-05:00", "2030-01-02T23:59:59.999-05:00", false, resources);
    const good = dated("times", "2030-01-02T00:00:00.000-05:00", "2030-01-02T23:59:59.999-05:00");
    for (const url of [good + "&start_time=x", good + "&end_time=x", good + "&token=private", good + "&party=2", good + "#", good + "&",
      good.replace("resource_ids[]", "resource_ids%5B%5D"), good.replace("start_time", "%73tart_time"), good.replace("%3A", ":"), good.replace("%3A", "%3a"),
      good.replace("services/73", "services/0"), good.replace("services/73", "services/2147483648"), good.replace("services/73", "services/073"),
      good.replace("/v2/", "/"), good.replace("/accounts/", "/x/../accounts/"), good.replace("789abc", "789ABC"),
      good.replace("https:", "http:"), good.replace(".com/", ".com:443/"), good.replace("https://", "https://user@"),
      good.replace("api.ola.godaddy.com", "api.ola.godaddy.com.example.org"), good.replace("/available_times?", "/available_times/?")])
      expect(isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET"), url).toBe(false);
    for (const url of [root + account + "/config?fields[]=customer", root + account + "/config?fields[]=cart&fields[]=cart",
      root + account + "/config?%66ields[]=cart", root + account + "/config?fields%5B%5D=cart", root + account + "/config?fields[]=cart&token=x",
      root + "/addons/v1" + account + "/services/0/addons", root + "/addons/v1" + account + "/services/73/addons?", root + account + "/customers"])
      expect(isSafeBrowserBootstrapReadUrl(url, "fetch", "GET"), url).toBe(false);
  });
  it("keeps public course events route-scoped and outside navigation, inventory response and HTTP authority", () => {
    const url = "https://api.membersports.com/api/v1/Events/eventsByDateForCourses/golfClubId/12679/searchDate/2026-10-23?golfCourseIds=15654";
    const route = { origin: "https://api.membersports.com", path: "/api/v1/Events/eventsByDateForCourses/golfClubId/12679/searchDate/*", methods: ["GET"], queryKeys: ["golfCourseIds"] };
    const base = serverDocumentRecipe(), recipe = parseAccessRecipe({ ...base, permittedRoutes: [...base.permittedRoutes, route] });
    expect(recipeAllowsRequest(recipe, url, "GET", "xhr")).toBe(true);
    expect(recipeAllowsRequest(recipe, url, "GET", "fetch")).toBe(true);
    expect(recipeAllowsRequest(parseAccessRecipe(base), url, "GET", "fetch")).toBe(false);
    for (const kind of ["document", "script", "stylesheet", "other", undefined]) expect(recipeAllowsRequest(recipe, url, "GET", kind)).toBe(false);
    for (const method of ["HEAD", "POST", "OPTIONS"]) expect(recipeAllowsRequest(recipe, url, method, "fetch")).toBe(false);
    expect(recipeAllowsRequest(recipe, url.replace("/12679/", "/12680/"), "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(recipe, url + "&memberProfileId=1", "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [...httpRecipe().permittedRoutes, route] }), url, "GET", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...base, source: { ...base.source, bookingUrl: url } })).toThrow();
    expect(() => parseAccessRecipe({ ...base, pageUrl: url })).toThrow();
    expect(() => parseAccessRecipe({ ...base, availabilityResponse: { url, method: "GET", date: { source: "PATH", path: "7" } } })).toThrow();
  });
  it("requires an explicit HEAD route and keeps it separate from GET and availability proof", () => {
    const source = serverDocumentRecipe();
    const url = "https://example.org/public-resource";
    const recipe = parseAccessRecipe({ ...source, permittedRoutes: [...source.permittedRoutes,
      { origin: "https://example.org", path: "/public-resource", methods: ["HEAD"], queryKeys: [] }] });
    expect(recipeAllowsRequest(recipe, url, "HEAD", "fetch")).toBe(true);
    for (const method of ["GET", "POST", "OPTIONS"])
      expect(recipeAllowsRequest(recipe, url, method, "fetch")).toBe(false);
    for (const other of [url + "/other", url + "?date=2026-10-23", url.replace("example.org", "other.example.org")])
      expect(recipeAllowsRequest(recipe, other, "HEAD", "fetch")).toBe(false);
    expect(recipeAllowsRequest(parseAccessRecipe(source), url, "HEAD", "fetch")).toBe(false);
    expect(() => parseAccessRecipe({ ...source, availabilityResponse: { ...source.availabilityResponse, method: "HEAD" } })).toThrow();
    expect(() => parseAccessRecipe({ ...httpRecipe(), request: { ...httpRecipe().request, method: "HEAD" } })).toThrow();
  });
  it.each([
    "/App/InitializationSettings", "/AuthenticationSettings/", "/authenticationSettings", "/%41uthenticationSettings", "/App/../AuthenticationSettings",
    "/account/AuthenticationSettings", "/checkout/GlobalTenantSettings", "/reservation/create/GlobalTenantSettings", "/auth/venue_info?venue_url_key=public-golf",
    "/AuthenticationSettings?AuthenticationType", "/AuthenticationSettings?AuthenticationType=password", "/AuthenticationSettings?AuthenticationType=&AuthenticationType=",
    "/AuthenticationSettings?%41uthenticationType=", "/AuthenticationSettings?authenticationType=", "/GlobalTenantSettings?AuthenticationType=",
    "/AuthenticationSettings?AuthenticationType=&token=private", "/AuthenticationSettings?AuthenticationType=&next=%2Faccount%2Flogin",
    "/venue_info?venue_url_key=public-golf&venue_url_key=public-golf", "/venue_info?%76enue_url_key=public-golf", "/venue_info?venue_url_key=%70ublic-golf",
    "/venue_info?venue_url_key=", "/venue_info?venue_url_key=publicvenue1234567890123456789", "/venue_info?venue_url_key=secret-token",
    "/venue_info?venue_url_key=https%3A%2F%2Fexample.org%2Fpublic", "/venue_info?venue_url_key=public-golf&api_key=private", "/api/availability?venue_url_key=public-golf",
    "/Booking/Teetimes/GetReadOnlyTeeSheet?date=2026-10-23", "/Booking/Teetimes/GetReadOnlyTeeSheet?",
    "/Booking/Teetimes/GetReadOnlyTeeSheet/", "/Booking/Teetimes/getReadOnlyTeeSheet", "/Booking/Teetimes/%47etReadOnlyTeeSheet",
    "/checkout/GetReadOnlyTeeSheet", "/Booking/Teetimes/ReleaseTeeTimes", "/Booking/Teetimes/GetMaxBookingDays",
  ])("keeps aliases, credentials, transaction paths and unproved metadata outside bootstrap permission: %s", path => {
    expect(isSafeBrowserBootstrapReadUrl(`https://public.example.org${path}`, "fetch", "GET")).toBe(false);
  });
  it("preserves authority checks and validates public venue values before masking their key", () => {
    const path = "/venue_info?venue_url_key=public-golf";
    for (const origin of ["http://public.example.org", "https://127.0.0.1", "https://venue.internal", "https://user:password@public.example.org", "https://public.example.org:8443"])
      expect(isSafeBrowserBootstrapReadUrl(origin + path, "fetch", "GET")).toBe(false);
    expect(isSafeBrowserBootstrapReadUrl(`https://public.example.org${path}#fragment`, "fetch", "GET")).toBe(false);
    expect(isSafeBrowserBootstrapReadUrl(`https://public.example.org/venue_info?venue_url_key=${"a".repeat(129)}`, "fetch", "GET")).toBe(false);
    expect(isSafeBrowserBootstrapReadUrl(`https://public.example.org/venue_info?venue_url_key=${"a".repeat(128)}`, "fetch", "GET")).toBe(true);
  });
  it("admits conventional public static build versions without admitting credentials or data reads", () => {
    const script = "https://public.example.org/wp-includes/js/dist/hooks.min.js?ver=f0f188028580e8dc1255";
    expect(isSafeRecipeUrl(script)).toBe(false);
    expect(isSafeBrowserAssetUrl(script, "script", "GET")).toBe(true);
    expect(isSafeBrowserAssetUrl(script.replace("hooks.min.js", "style.css"), "stylesheet", "GET")).toBe(true);
    for (const resource of ["fetch", "xhr", "document", "other"])
      expect(isSafeBrowserAssetUrl(script, resource, "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl(script, "script", "POST")).toBe(false);
    for (const unsafe of [
      script.replace("?ver=", "?token="), script.replace("?ver=", "?v="),
      `${script}&ver=1dfe7db3940c23ea9216`, `${script}&next=https%3A%2F%2Fexample.org%2F%3Ftoken%3Dprivate`,
      `${script}&other=abcdefghijklmnopqrst1234`, `${script}&api_key=private`, `${script}#fragment`,
      script.replace("f0f188028580e8dc1255", "abcdefghijklmnopqrst1234"),
      script.replace("public.example.org", "127.0.0.1"), script.replace("public.example.org", "user:password@public.example.org"),
      script.replace("/wp-includes/js/dist/hooks.min.js", "/checkout/hooks.min.js"),
      script.replace("/wp-includes/js/dist/hooks.min.js", "/account/hooks.min.js"),
      script.replace("/wp-includes/js/dist/hooks.min.js", "/api/calendar"),
    ]) expect(isSafeBrowserAssetUrl(unsafe, "script", "GET"), unsafe).toBe(false);
    const recipe = parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [{ origin: "https://public.example.org", path: "/wp-includes/js/dist/*", methods: ["GET"], queryKeys: ["ver"] }] });
    expect(recipeAllowsRequest(recipe, script, "GET", "script")).toBe(true);
    expect(recipeAllowsRequest(recipe, script, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(recipe, script.replace("public.example.org", "unobserved.example.org"), "GET", "script")).toBe(false);
  });
  it("admits only typed extensionless public bundles with one bounded version value", () => {
    const version = "Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    expect(version).toHaveLength(44);
    const script = `https://public.example.org/bundles/desktopjs?v=${version}`;
    const style = `https://public.example.org/content/css/base?v=${version}`;
    for (const [asset, kind] of [[script, "script"], [style, "stylesheet"]] as const) {
      expect(isSafeRecipeUrl(asset)).toBe(false);
      expect(isSafeBrowserAssetUrl(asset, kind, "GET")).toBe(true);
      for (const resource of ["fetch", "xhr", "document", "other"])
        expect(isSafeBrowserAssetUrl(asset, resource, "GET")).toBe(false);
      for (const method of ["HEAD", "POST", "OPTIONS"])
        expect(isSafeBrowserAssetUrl(asset, kind, method)).toBe(false);
      for (const unsafe of [
        asset.replace(version, version.slice(0, -1)), asset.replace(version, version + "H"), asset.replace(version, version.slice(0, -1) + "="),
        `${asset}&v=${version}`, `${asset}&other=1`, `${asset}&token=private`, asset.replace("?v=", "?token="), asset.replace("?v=", "?ver="),
        `${asset}#fragment`, asset.replace("public.example.org", "127.0.0.1"), asset.replace("public.example.org", "8.8.8.8"),
        asset.replace("public.example.org", "venue.internal"), asset.replace("public.example.org", "user:password@public.example.org"),
        asset.replace("public.example.org", "public.example.org:8443"), asset.replace("https:", "http:"),
        asset.replace(kind === "script" ? "desktopjs" : "base", "account"), asset.replace(kind === "script" ? "desktopjs" : "base", "secret"),
      ]) expect(isSafeBrowserAssetUrl(unsafe, kind, "GET"), unsafe).toBe(false);
    }
    expect(isSafeBrowserAssetUrl(script, "stylesheet", "GET")).toBe(false);
    expect(isSafeBrowserAssetUrl(style, "script", "GET")).toBe(false);
    for (const path of ["/bundles/account", "/bundles/token", "/bundles/desktopjs/checkout", "/account/bundles/desktopjs", "/api/calendar",
      "/content/css/secret", "/content/css/base/checkout", "/%62undles/desktopjs", "/bundles/desktop.js", `/bundles/${"a".repeat(81)}`])
      expect(isSafeBrowserAssetUrl(`https://public.example.org${path}?v=${version}`, "script", "GET"), path).toBe(false);
    const recipe = parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [{ origin: "https://public.example.org", path: "/bundles/desktopjs", methods: ["GET"], queryKeys: ["v"] }] });
    expect(recipeAllowsRequest(recipe, script, "GET", "script")).toBe(true);
    expect(recipeAllowsRequest(recipe, script, "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(recipe, script.replace("public.example.org", "other.example.org"), "GET", "script")).toBe(false);
    expect(recipeAllowsRequest(parseAccessRecipe({ ...httpRecipe(), permittedRoutes: [{ origin: "https://public.example.org", path: "/bundles/desktopjs", methods: ["GET"], queryKeys: [] }] }), script, "GET", "script")).toBe(false);
    expect(() => parseAccessRecipe({ ...httpRecipe(), source: { ...httpRecipe().source, bookingUrl: script } })).toThrow();
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
  it("keeps GolfVX guest billing data outside generic navigation and request recipes", () => {
    expect(isSafeRecipeUrl("https://booking.golfvx.net/book/11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const path of ["stores", "room-types", "availability", "quote", "reservations", "payment"])
      expect(isSafeRecipeUrl(`https://booking.golfvx.net/api/v1/billing/guest/booking/${path}`)).toBe(false);
    const recipe = httpRecipe();
    recipe.request.url = "https://booking.golfvx.net/api/v1/billing/guest/booking/availability?date={{date}}";
    expect(() => parseAccessRecipe(recipe)).toThrow();
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
  it.each(["2030-01-01", "2030-12-31", "2031-01-01"])("binds zero-padded compact dates without changing existing parts for %s", date => {
    expect(expandRecipeTemplate("{{date}}|{{dateCompact}}|{{year}}|{{month}}|{{day}}", { date }))
      .toBe(`${date}|${date.replaceAll("-", "")}|${date.slice(0, 4)}|${Number(date.slice(5, 7))}|${Number(date.slice(8))}`);
    const value = parseAccessRecipe({ ...httpRecipe(), request: { url: "https://example.org/api/availability?date={{dateCompact}}", method: "GET" } });
    expect(hashAccessRecipe(value)).not.toBe(hashAccessRecipe(parseAccessRecipe(httpRecipe())));
  });
  it("rejects invalid compact source dates, unknown names and unbound required inputs", () => {
    for (const date of ["2030-02-30", "20300101", "2030-1-01", "2030-01-01T00:00:00Z", "2030-13-01"])
      expect(() => expandRecipeTemplate("{{dateCompact}}", { date })).toThrow();
    for (const template of ["{{datecompact}}", "{{dateCompact2}}", "{{dateCompact", "{{unknown}}", "{{players}}"])
      expect(() => expandRecipeTemplate(template, { date: "2030-01-01" })).toThrow();
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
