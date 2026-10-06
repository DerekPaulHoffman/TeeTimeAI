// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "@playwright/test";
import { fetchYourGolfBookingAvailability } from "@/lib/simulators/providers/your-golf-booking";
import { collectSimulatorSupportResearch, detectSimulatorResearchAccessControls, extractSimulatorPublicCalendar, summarizeSimulatorPublicJsonShape, summarizeSimulatorSupportPublicHtml, type SimulatorResearchDependencies } from "./simulator-support-research";

const source = "https://venue.example.test";
const booking = "https://booking.trackmangolf.com/venues/golf-oasis/booking/bays";
const instant = new Date("2026-10-06T16:00:00Z");
const lease = vi.fn(async (_host: string, worker: () => Promise<unknown>) => ({ acquired: true as const, value: await worker() })) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
const response = (body: string, status = 200, type = "text/html") => new Response(body, { status, headers: { "content-type": type } });

function publishedConfig(patch: Record<string, unknown> = {}) {
  const config = {
    venue: { id: 1357, slug: "golf-oasis", timezone: "America/New_York", status: "live", maintenanceMode: false, owner: { email: "secret@example.test" } },
    ranges: { items: [{ id: 1397, venue: 1357, slug: "bays", bookable: true, slotDuration: 30, slotInterval: 30, slotIntervalStart: 0, assumeOpen: true, bookingUi: "standard", customerBookingUi: "slots", maxBookAheadValue: 2, maxBookAheadUnit: "week", openingTimes: [], openingHours: "Mo 09:00-20:00 open" }] },
    bays: { items: [{ id: 9224, venue: 1357, range: 1397, type: "simulator", bookable: true, options: [21451, 9999], appliedOptions: [21451], restrictedTimes: [] }],
      bayOptions: [{ id: 21451, venue: 1357, name: "Public Rate", adminOnly: false, disabled: false, waitlisted: false, type: "simulator", category: "baytime", duration: 1, durationType: "slot", minBookingDuration: 1, maxBookingDuration: 8, minPlayers: 1, maxPlayers: 4, bufferPeriodMinutes: 0, restrictions: [], appliedRequiredPerks: [] },
        { id: 9999, name: "Private Member", adminOnly: true, customerEmail: "secret@example.test" }] },
    user: { token: "never-return-this", email: "secret@example.test" },
    ...patch,
  };
  return `<h1>Hourly simulator bays</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialReduxState: config } } })}</script>`;
}

type RequestFixture = { url: string; method?: string; headers?: Record<string, string>; kind?: string; frame?: "main" | "child" | "popup" };
function renderedBrowser(requests: RequestFixture[], html = "<h1>Public rentals</h1><a href='/booking'>Book hourly</a>") {
  let handler!: (route: Route) => Promise<void>;
  let socketHandler!: (socket: { close: (options: unknown) => Promise<void> }) => Promise<unknown>;
  const mainFrame = {}, childFrame = {}, popupFrame = {};
  const routes: Array<{ abort: ReturnType<typeof vi.fn>; fulfill: ReturnType<typeof vi.fn> }> = [];
  const page = {
    mainFrame: () => mainFrame, url: () => requests[0].url,
    content: vi.fn(async () => html),
    goto: vi.fn(async () => {
      for (const request of requests) {
        const entry = { abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined) }; routes.push(entry);
        await handler({ ...entry, request: () => ({ url: () => request.url, method: () => request.method ?? "GET", allHeaders: async () => request.headers ?? { "user-agent": "Public research browser" },
          isNavigationRequest: () => !request.kind || request.kind === "document", resourceType: () => request.kind ?? "document",
          frame: () => request.frame === "child" ? childFrame : request.frame === "popup" ? popupFrame : mainFrame }) } as unknown as Route);
      }
      return { status: () => 200 };
    }),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined),
    route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }),
    routeWebSocket: vi.fn(async (_pattern: string, callback: typeof socketHandler) => { socketHandler = callback; }),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) };
  return { page, context, browser, routes, socket: async () => { const close = vi.fn(async () => undefined); await socketHandler({ close }); return close; },
    factory: async () => browser as unknown as Awaited<ReturnType<NonNullable<SimulatorResearchDependencies["browser"]>>> };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("bounded owned simulator public research transport", () => {
  it("returns exact public configuration facts without user, member, session or raw script payloads", () => {
    const result = extractSimulatorPublicCalendar(publishedConfig(), booking);
    expect(result.calendar).toMatchObject({ family: "YOUR_GOLF_BOOKING", venue: { id: "1357", slug: "golf-oasis", timeZone: "America/New_York" },
      ranges: [{ id: "1397", openingHours: "Mo 09:00-20:00 open", hasOpeningTimeRestrictions: false }],
      rentals: [{ id: "21451", name: "Public Rate", maxPlayers: 4, requiresPerks: false }], resources: [{ id: "9224", optionIds: ["21451"], appliedOptionIds: ["21451"] }] });
    expect(result.calendar?.rentals).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/secret@example|never-return|Private Member|customerEmail|owner|__NEXT_DATA__/u);
    expect(result.jsonShape).toBeUndefined();
  });
  it("does not authorize arbitrary hosts, wrong venue identity, duplicate state or executable script content", () => {
    expect(extractSimulatorPublicCalendar(publishedConfig(), "https://unrecognized.example.test/venues/golf-oasis/booking").calendar).toBeUndefined();
    expect(extractSimulatorPublicCalendar(publishedConfig({ venue: { id: 1357, slug: "other-venue" } }), booking).calendar).toBeUndefined();
    expect(extractSimulatorPublicCalendar(`${publishedConfig()}${publishedConfig()}`, booking)).toEqual({});
    expect(extractSimulatorPublicCalendar("<script id='__NEXT_DATA__' type='application/json'>window.alert('run')</script>", booking)).toEqual({});
  });
  it("reports restriction presence without retaining restriction/perk payloads or declaring availability", () => {
    const html = publishedConfig().replace('"restrictions":[]', '"restrictions":[{"email":"private@example.test"}]').replace('"appliedRequiredPerks":[]', '"appliedRequiredPerks":[{"secret":"private-perk"}]');
    expect(extractSimulatorPublicCalendar(html, booking).calendar?.rentals[0]).toMatchObject({ hasRestrictions: true, requiresPerks: true });
    expect(JSON.stringify(extractSimulatorPublicCalendar(html, booking))).not.toMatch(/private@example|private-perk|availableSlots/u);
  });
  it("returns bounded key/type shape rather than JSON values or sensitive fields", () => {
    const shape = summarizeSimulatorPublicJsonShape({ slots: [{ startsAt: "private-time", resourceId: "private-id", user: { email: "secret" } }], sessionToken: "secret", cookie: "secret", "person@example.test": "secret", status: true });
    expect(shape).toContainEqual({ path: "$.slots[].startsAt", type: "string" });
    expect(JSON.stringify(shape)).not.toMatch(/private-|secret|session|cookie|person@example/u);
    expect(summarizeSimulatorPublicJsonShape(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field_${index}`, { value: index }]))).length).toBeLessThanOrEqual(80);
  });
  it("omits interactive surfaces, credentials, forms and scripts from text/link output", () => {
    expect(summarizeSimulatorSupportPublicHtml("<p>Hourly bays</p><form>Private form</form><script>secret</script><a href='/booking'>Book</a><a href='/checkout'>Pay</a><a href='http://127.0.0.1'>Local</a><a href='/rates?token=secret'>Token</a>", source))
      .toEqual({ text: "Hourly bays Book Pay Local Token", links: [`${source}/booking`] });
  });
  it("treats a bare HTTP 403 as unresolved public-source evidence, not a final limitation", async () => {
    const fetch = vi.fn(async () => response("Forbidden", 403));
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch, lease, now: () => instant });
    expect(result).toMatchObject({ requestedUrl: `${source}/`, httpStatus: 403, text: "", links: [], method: "HTTP" });
    expect(result.accessControls).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(`${source}/`, expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual" }));
    expect(lease).toHaveBeenCalledWith("venue.example.test", expect.any(Function));
  });
  it("follows only safe same-official-host redirects and resolves relative anchors at the effective landing", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://www.venue.example.test/simulators/" } })).mockResolvedValueOnce(response("<a href='book'>Book hourly</a>"));
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch, lease });
    expect(result).toMatchObject({ url: "https://www.venue.example.test/simulators/", links: ["https://www.venue.example.test/simulators/book"] });
    expect(lease).toHaveBeenNthCalledWith(2, "www.venue.example.test", expect.any(Function));
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://unrelated.example.test" } })), lease })).rejects.toThrow("DESTINATION_CHANGED");
  });
  it.each(["http://127.0.0.1", "https://venue.example.test/login", "https://venue.example.test/cart", "https://venue.example.test/?token=secret"])("rejects unsafe input %s without I/O", async url => {
    const fetch = vi.fn(); await expect(collectSimulatorSupportResearch({ url }, { fetch, lease })).rejects.toThrow("UNSAFE_URL"); expect(fetch).not.toHaveBeenCalled();
  });
  it("renders through a fresh context and one coordinated public browser request, without repeating a static GET", async () => {
    const view = renderedBrowser([{ url: `${source}/` }]);
    const fetch = vi.fn(async () => response("<h1>Public rentals</h1>"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ method: "BROWSER", httpStatus: 200, links: [`${source}/booking`], blockedRequests: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(view.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: "block", storageState: { cookies: [], origins: [] }, acceptDownloads: false }));
    expect(await view.socket()).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
    expect(view.routes[0].fulfill.mock.calls[0][0].headers).not.toHaveProperty("set-cookie");
  });
  it("covers child frames and popups while blocking mutations, credentials, access flows and unscoped hosts before reads", async () => {
    const requests: RequestFixture[] = [{ url: `${source}/` }, { url: `${source}/frame`, frame: "child" }, { url: `${source}/popup`, frame: "popup" },
      { url: `${source}/reserve`, method: "POST" }, { url: `${source}/data`, headers: { Cookie: "session=secret" } }, { url: `${source}/data`, headers: { Authorization: "Bearer secret" } },
      { url: `${source}/login` }, { url: "https://unrelated.example.test" }];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(3); expect(result.blockedRequests).toBe(5);
    for (const route of view.routes.slice(3)) expect(route.abort).toHaveBeenCalledOnce();
    for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ credentials: "omit", method: "GET" });
  });
  it("does not execute initial challenge scripts or return challenge payloads", async () => {
    const html = "<h1>Verify you are human</h1><div class='cf-turnstile'></div><script>runChallenge()</script>";
    const view = renderedBrowser([{ url: `${source}/` }], html);
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response(html, 403)), lease, browser: view.factory });
    expect(result).toMatchObject({ httpStatus: 403, accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
    expect(String(view.routes[0].fulfill.mock.calls[0][0].body)).not.toContain("runChallenge");
    expect(view.page.content).not.toHaveBeenCalled();
    expect(detectSimulatorResearchAccessControls("<p>Sign in to continue</p>")).toContain("ACCOUNT_REQUIRED");
    expect(detectSimulatorResearchAccessControls("<p>You are in a queue</p>")).toContain("QUEUE");
  });
  it("returns only sanitized XHR response shapes, path templates and query keys", async () => {
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/venue/golf-oasis/availability?start_gte=private-date`, kind: "fetch" }]);
    const fetch = vi.fn(async (url: unknown) => String(url).includes("availability") ? response(JSON.stringify({ slots: [{ id: 9273, startsAt: "private-date", userEmail: "secret@example.test" }] }), 200, "application/json") : response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result.responseContracts?.[0]).toMatchObject({ pathShape: "/venue/:value/availability", queryKeys: ["start_gte"], httpStatus: 200 });
    expect(JSON.stringify(result.responseContracts)).not.toMatch(/golf-oasis|private-date|9273|secret@example/u);
  });
  it("permits only exact CDN script/style assets declared by the first safe public document", async () => {
    const html = "<h1>Public rentals</h1><script src='https://cdn.example.test/app.js'></script><link rel='stylesheet' href='https://styles.example.test/site.css'><script src='https://cdn.example.test/captcha.js'></script>";
    const view = renderedBrowser([{ url: `${source}/` }, { url: "https://cdn.example.test/app.js", kind: "script" }, { url: "https://styles.example.test/site.css", kind: "stylesheet" },
      { url: "https://cdn.example.test/unproven.js", kind: "script" }, { url: "https://cdn.example.test/api", kind: "fetch" }, { url: "https://cdn.example.test/captcha.js", kind: "script" }, { url: "https://cdn.example.test/app.js", kind: "fetch" }], html);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(html) : response("public asset", 200, "text/javascript"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(3); expect(result.blockedRequests).toBe(4);
    expect(lease).toHaveBeenNthCalledWith(2, "cdn.example.test", expect.any(Function));
    expect(lease).toHaveBeenNthCalledWith(3, "styles.example.test", expect.any(Function));
    for (const route of view.routes.slice(3)) expect(route.abort).toHaveBeenCalledOnce();
  });
  it("exposes the existing fixed read-only bays route for an exact published Trackman booking root", async () => {
    const root = "https://booking.trackmangolf.com/venues/golf-oasis/booking";
    const result = await collectSimulatorSupportResearch({ url: root }, { fetch: vi.fn(async () => response("<h1>Public golf calendar</h1>")), lease });
    expect(result.links).toEqual([booking]);
    expect(result.bookingLinks).toEqual([booking]);
    expect(result.calendar).toBeUndefined();
    expect((await collectSimulatorSupportResearch({ url: root.replace("booking.trackmangolf.com", "yourgolfbooking.com") }, { fetch: vi.fn(async () => response("<h1>Public venue</h1>")), lease })).links).toEqual([]);
  });
  it("gives booking roles only to explicit bounded Book/Reserve/Appointment anchor labels", async () => {
    const html = "<a href='https://marketing.example.test/simulators'>Our simulators</a><a href='https://calendar.example.test/public' aria-label='Reserve a bay'>Calendar</a><a href='/schedule' title='Appointments'>Schedule</a><a href='/booking'>BookNow</a><a href='/checkout'>Book checkout</a>";
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(html)), lease });
    expect(result.links).toContain("https://marketing.example.test/simulators");
    expect(result.bookingLinks).toEqual(["https://calendar.example.test/public", `${source}/schedule`, `${source}/booking`]);
    expect(JSON.stringify(result.bookingLinks)).not.toContain("Reserve a bay");
    expect(summarizeSimulatorSupportPublicHtml("<a href='/booking'>Book</a>", source)).toEqual({ text: "Book", links: [`${source}/booking`] });
  });
  it("observes only the exact anonymous same-venue occupancy API, without expanding other cross-origin data authority", async () => {
    const query = "?start_gte=2026-10-09T04%3A00%3A00Z&start_lte=2026-10-10T23%3A59%3A59-04%3A00";
    const api = `https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public${query}`;
    const view = renderedBrowser([{ url: booking }, { url: api, kind: "fetch", headers: { origin: "https://booking.trackmangolf.com" } },
      { url: api.replace("golf-oasis", "other-venue"), kind: "fetch" }, { url: api.replace("bookings/public", "customers"), kind: "fetch" }, { url: api, kind: "fetch", method: "POST" },
      { url: `${api}&extra=1`, kind: "fetch" }, { url: api, kind: "fetch", headers: { Cookie: "secret" } }], publishedConfig());
    const fetch = vi.fn(async (url: unknown) => String(url) === booking ? response(publishedConfig()) : new Response(JSON.stringify([{ id: 123, start: "private-time", customerEmail: "secret@example.test" }]), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.blockedRequests).toBe(5);
    expect(lease).toHaveBeenNthCalledWith(2, "api.yourgolfbooking.com", expect.any(Function));
    expect(result.responseContracts?.[0]).toMatchObject({ pathShape: "/venue/:value/bookings/public", queryKeys: ["start_gte", "start_lte"] });
    expect(JSON.stringify(result.responseContracts)).not.toMatch(/private-time|secret@example|123|golf-oasis/u);
    expect(view.routes[1].fulfill.mock.calls[0][0].headers).toHaveProperty("access-control-allow-origin", "*");
  });
  it("recognizes YourGolfBooking research and its anonymous API only after exact published venue confirmation", async () => {
    const root = "https://yourgolfbooking.com/venues/golf-oasis/booking";
    const api = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-09T04%3A00%3A00Z&start_lte=2026-10-10T23%3A59%3A59Z";
    for (const confirmed of [false, true]) {
      const html = confirmed ? publishedConfig() : "<h1>Venue page</h1>";
      const view = renderedBrowser([{ url: root }, { url: api, kind: "fetch" }], html);
      const fetch = vi.fn(async (url: unknown) => String(url) === root ? response(html) : response("[]", 200, "application/json"));
      const result = await collectSimulatorSupportResearch({ url: root, render: true }, { fetch, lease, browser: view.factory });
      expect(fetch).toHaveBeenCalledTimes(confirmed ? 2 : 1);
      if (confirmed) expect(result.calendar).toMatchObject({ family: "YOUR_GOLF_BOOKING", venue: { slug: "golf-oasis" } });
      else expect(result.calendar).toBeUndefined();
      expect(result.responseContracts?.length ?? 0).toBe(confirmed ? 1 : 0);
    }
  });
  it.each(["https://yourgolfbooking.com", "https://www.yourgolfbooking.com"])("projects a changed public regular-bay contract on %s without claiming runtime support", async origin => {
    const root = `${origin}/venues/back9-golf/booking`;
    const html = publishedConfig().replaceAll("golf-oasis", "back9-golf").replace('"slug":"bays"', '"slug":"regular"').replace('"maxBookAheadValue":2', '"maxBookAheadValue":13').replace('"maxBookAheadUnit":"week"', '"maxBookAheadUnit":"day"')
      .replace('"name":"Public Rate"', '"name":"Regular Bay Rate"').replace('"minBookingDuration":1', '"minBookingDuration":2').replace('"maxBookingDuration":8', '"maxBookingDuration":10');
    const fetch = vi.fn(async () => response(html));
    const result = await collectSimulatorSupportResearch({ url: root }, { fetch, lease });
    expect(result.calendar).toMatchObject({ venue: { id: "1357", slug: "back9-golf" }, ranges: [{ id: "1397", slug: "regular", maxBookAheadValue: 13, maxBookAheadUnit: "day", slotDurationMinutes: 30 }],
      rentals: [{ id: "21451", name: "Regular Bay Rate", minDurationSlots: 2, maxDurationSlots: 10 }] });
    expect(result.bookingLinks).toEqual([`${root}/bays`]);
    expect(JSON.stringify(result)).not.toMatch(/never-return|secret@example|Private Member/u);
    const runtimeFetch = vi.fn<typeof globalThis.fetch>();
    await expect(fetchYourGolfBookingAvailability({ offering: { id: "research-offering", courseId: "research-venue", bookingUrl: root, providerFamilyKey: "YOUR_GOLF_BOOKING",
      providerMetadata: { venueSlug: "back9-golf", venueId: "1357", rangeId: "1397", publicOptionId: "21451" }, maxPartySize: 4, supportedDurationsMinutes: [60] },
      date: "2026-10-10", durationMinutes: 60, partySize: 1, timeZone: "America/New_York" }, runtimeFetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"])("normalizes only a recognized provider network failure %s", async code => {
    const network = new TypeError("fetch failed", { cause: Object.assign(new Error("Public request failed"), { code }) });
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => { throw network; }), lease })).rejects.toThrow("SIMULATOR_RESEARCH_NETWORK_FAILED");
  });
  it("normalizes a recognized Playwright navigation network error but preserves programming and persistence errors", async () => {
    const view = renderedBrowser([{ url: `${source}/` }]);
    view.page.goto.mockRejectedValueOnce(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at public destination"));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease, browser: view.factory })).rejects.toThrow("SIMULATOR_RESEARCH_NETWORK_FAILED");
    const programming = new Error("Parser programming invariant failed");
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => { throw programming; }), lease })).rejects.toBe(programming);
    const persistence = Object.assign(new Error("Lease persistence failed"), { code: "ECONNREFUSED" });
    const brokenLease = (async () => { throw persistence; }) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(), lease: brokenLease })).rejects.toBe(persistence);
    const rendered = renderedBrowser([{ url: `${source}/` }]);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease: brokenLease, browser: rendered.factory })).rejects.toBe(persistence);
  });
  it("enforces the body and routed-request bounds and cleans up the browser on failure", async () => {
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response("x".repeat(1_500_001))), lease })).rejects.toThrow("BODY_LIMIT");
    const view = renderedBrowser(Array.from({ length: 33 }, (_, index) => ({ url: `${source}/${index}` })));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("public")), lease, browser: view.factory })).rejects.toThrow("REQUEST_LIMIT");
    expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("ends a hung render at the deadline and still closes its isolated context", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const view = renderedBrowser([{ url: `${source}/` }]);
    view.page.goto.mockImplementation(async () => new Promise<never>(() => undefined));
    const task = collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease, browser: view.factory });
    const assertion = expect(task).rejects.toThrow("DEADLINE");
    await vi.waitFor(() => expect(view.page.goto).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
});
