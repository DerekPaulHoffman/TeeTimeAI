import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createCourseDiscoveryBrowserSession, discoveryBrowserActionSchema, discoveryPublicAnchorKind, discoveryPublicChoiceKind, normalizeDiscoveryNavigationUrl, redactDiscoveryJson, redactDiscoveryRequestUrl } from "./browser-session";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
vi.mock("@/lib/automation/address-pinned-public-fetch", () => ({ createAddressPinnedPublicFetchTransport: vi.fn() }));

describe("discovery browser public protocol", () => {
  it("admits public reservation navigation while excluding slot and transaction controls", () => {
    const control = { tag: "a", name: "Click here to reserve a tee time", label: "", href: "https://example.org/tee-times", sensitiveForm: false };
    expect(discoveryPublicAnchorKind(control)).toBe("link");
    expect(discoveryPublicAnchorKind({ ...control, name: "Reserve 09:30" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/checkout" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?slot=123" })).toBeNull();
  });
  it("normalizes only the known observed ForeUP public bootstrap login bookmark", () => {
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/index.php/booking/21017#/login")).toBe("https://foreupsoftware.com/index.php/booking/21017");
    expect(normalizeDiscoveryNavigationUrl("https://other.example.org/index.php/booking/21017#/login")).toContain("#/login");
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/account#/login")).toContain("#/login");
  });
  it("recognizes calendar cells and bounded numeric filter choices without selecting slots", () => {
    const cell = { tag: "td", name: "22", calendar: true, sensitiveForm: false };
    expect(discoveryPublicChoiceKind(cell)).toBe("calendar");
    expect(discoveryPublicChoiceKind({ ...cell, disabledChoice: true })).toBeNull();
    const choice = { tag: "a", name: "2", calendar: false, sensitiveForm: false, choiceValue: "2", choiceContext: "Players 1 2 3 4 Any" };
    expect(discoveryPublicChoiceKind(choice)).toBe("option");
    expect(discoveryPublicChoiceKind({ ...choice, choiceContext: "Products" })).toBeNull();
    expect(discoveryPublicChoiceKind({ ...choice, name: "Reserve 09:30" })).toBeNull();
  });
  it("rejects eval and arbitrary actions", () => {
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "evaluate", code: "document.cookie" }).success).toBe(false);
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "click", target: "#book" }).success).toBe(false);
    expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "open", url: "https://example.org/", extra: true }).success).toBe(false);
  });
  it("redacts nested credentials and bounds extracted bodies", () => {
    expect(redactDiscoveryJson({ token: "secret", nested: [{ email: "a@example.org", start: "09:00", capacity: 4 }],
      text: "Contact a@example.org" })).toEqual({ token: "[redacted]", nested: [{ email: "[redacted]", start: "09:00", capacity: 4 }], text: "Contact [redacted-email]" });
    expect((redactDiscoveryJson(Array.from({ length: 300 }, (_, index) => index)) as unknown[])).toHaveLength(100);
    expect(redactDiscoveryRequestUrl("https://maps.example.org/api?key=private-value&date=2026-10-22")).toBe("https://maps.example.org/api?key=REDACTED&date=2026-10-22");
  });
  it("requires prebound safe sources before launching a browser", async () => {
    const launchBrowser = vi.fn();
    await expect(createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://127.0.0.1/"] }, { launchBrowser })).rejects.toThrow("INVALID_INITIAL_URLS");
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executablePath))("isolated discovery browser", () => {
  it("waits for initial delayed public content without a manual observe or reload", async () => {
    const fixture = '<!doctype html><html><body><a href="#">×</a><script>fetch("/api/content").then(r=>r.json()).then(()=>{document.body.innerHTML="<h1>Public golf</h1><a href=\'/times\'>Book a tee time</a>";});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async value => {
        if (String(value).endsWith("/api/content")) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }
        return new Response(fixture, { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.text).toContain("Public golf");
      expect(snapshot.controls).toContainEqual(expect.objectContaining({ name: "Book a tee time", kind: "link" }));
      expect(snapshot.initialContentWaitMs).toBeGreaterThan(900);
      expect(snapshot.navigationElapsedMs).toBeGreaterThanOrEqual(1500);
      expect(snapshot.pendingRequestCount).toBe(0);
      expect(snapshot.requests).toContainEqual(expect.objectContaining({ url: "https://example.org/api/content", status: 200 }));
    } finally { await session.close(); }
  }, 25_000);
  it("returns usable public controls promptly while unrelated reads are pending", async () => {
    const fixture = '<!doctype html><html><body><a href="/times">Book a tee time</a><script>fetch("/slow").catch(()=>{});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async (value, options) => {
        if (String(value).endsWith("/slow")) return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("{}")), 5000);
          options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("CANCELLED")); }, { once: true });
        });
        return new Response(fixture, { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const startedAt = Date.now();
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(snapshot.controls).toContainEqual(expect.objectContaining({ name: "Book a tee time", kind: "link" }));
      expect(snapshot.loading).toBe(true);
      expect(snapshot.initialContentWaitMs).toBeLessThan(500);
    } finally { await session.close(); }
  }, 25_000);
  const pageHtml = '<!doctype html><html><body><h1>Sample simulator</h1><label for="duration">Duration</label>' +
    '<p>First time, you will have to select a picture in CAPTCHA when booking.</p>' +
    '<span id="visible-date">Thursday, October 22, 2026</span>' +
    '<select id="duration"><option value="30">30 minutes</option><option value="60">60 minutes</option></select>' +
    '<button id="book">Book now</button><a href="/times">View available times</a>' +
    '<input type="date" aria-label="Date" value="2026-10-22"><script>fetch("/api/public");</script></body></html>';
  async function setup() {
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const json = String(url).endsWith("/api/public");
      return new Response(json ? JSON.stringify({ date: "2026-10-22", capacity: 4, token: "keep-private" }) : pageHtml,
        { headers: { "content-type": json ? "application/json" : "text/html" } });
    }) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 40_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    return { session, fetcher };
  }
  it("observes selectors, public JSON and safe selects, without offering Book", async () => {
    const { session } = await setup();
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(opened.text).toContain("Sample simulator");
      expect(opened.text).toContain("CAPTCHA");
      expect(opened.controls.some(control => control.name === "Book now")).toBe(false);
      const duration = opened.controls.find(control => control.selector === '[id="duration"]');
      expect(duration?.options).toEqual([{ value: "30", label: "30 minutes" }, { value: "60", label: "60 minutes" }]);
      expect(JSON.stringify(opened.responses)).not.toContain("keep-private");
      expect(opened.responses[0]?.body).toMatchObject({ capacity: 4, token: "[redacted]" });
      expect(opened.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: "https://example.org/simulator", method: "GET", resourceType: "document", status: 200 }),
        expect.objectContaining({ url: "https://example.org/api/public", method: "GET", resourceType: "fetch", status: 200 }),
      ]));
      expect(opened.requestCount).toBeGreaterThanOrEqual(2); expect(opened.responseBytes).toBeGreaterThan(0);
      expect(opened.elements).toEqual(expect.arrayContaining([expect.objectContaining({ selector: '[id="visible-date"]', text: "Thursday, October 22, 2026" })]));
      const selected = await session.execute({ id: 2, action: "select", target: duration!.target, option: "60" });
      expect(selected.controls.find(control => control.selector === '[id="duration"]')?.currentValue).toBe("60");
      await expect(session.execute({ id: 3, action: "select", target: duration!.target, option: "30" })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
    } finally { await session.close(); }
  }, 25_000);
  it("opens only initial or observed destinations and rejects fabricated options", async () => {
    const { session, fetcher } = await setup();
    try {
      await expect(session.execute({ id: 1, action: "open", url: "https://outside.example.org/" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(fetcher).not.toHaveBeenCalled();
      const opened = await session.execute({ id: 2, action: "open", url: "https://example.org/simulator" });
      const duration = opened.controls.find(control => control.selector === '[id="duration"]')!;
      await expect(session.execute({ id: 3, action: "select", target: duration.target, option: "private" })).rejects.toThrow("UNOBSERVED_OPTION");
      const linked = await session.execute({ id: 4, action: "open", url: "https://example.org/times" });
      expect(linked.url).toBe("https://example.org/times");
      const observedRead = await session.execute({ id: 5, action: "open", url: "https://example.org/api/public" });
      expect(observedRead.url).toBe("https://example.org/api/public");
    } finally { await session.close(); }
  }, 25_000);
  it("inspects only a current observed element and returns bounded real parent structure", async () => {
    const { session, fetcher } = await setup();
    try {
      await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      const before = fetcher.mock.calls.length;
      const inspected = await session.execute({ id: 2, action: "inspect", selector: '[id="visible-date"]' });
      expect(inspected.structure?.selected).toBe('[id="visible-date"]');
      expect(inspected.structure?.ancestors[0]).toMatchObject({ tag: "span", matches: 1, text: "Thursday, October 22, 2026" });
      expect(inspected.structure?.ancestors.some(row => row.tag === "body")).toBe(true);
      expect(JSON.stringify(inspected.structure).length).toBeLessThanOrEqual(6000);
      expect(fetcher).toHaveBeenCalledTimes(before);
      await expect(session.execute({ id: 3, action: "inspect", selector: "#unobserved" })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
      expect(JSON.stringify(inspected.structure)).not.toContain("fetch(");
    } finally { await session.close(); }
  }, 25_000);
  it("projects only authorized public-read JSON request bodies", async () => {
    const body = { query: "query Availability { times { startsAt } }", variables: { date: "2026-10-22" } };
    const fixture = '<!doctype html><html><body><h1>Calendar</h1><script>fetch("/graphql",{method:"POST",headers:{"content-type":"application/json"},body:' + JSON.stringify(JSON.stringify(body)) + '});</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(String(url).endsWith("/graphql") ? '{"times":[]}' : fixture, { headers: { "content-type": String(url).endsWith("/graphql") ? "application/json" : "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(snapshot.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", body })]));
      expect(JSON.stringify(snapshot.requests)).not.toContain("headers");
    } finally { await session.close(); }
  }, 25_000);
  it("inspects only observed adapter sources with the trusted venue identity", async () => {
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "FOREUP" as const, facilityId: 1, scheduleId: 2, bookingClassId: 3 } }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"], venueName: "Trusted venue", timeZone: "America/New_York" }, {
      fetch: vi.fn(async () => new Response(pageHtml, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      await expect(session.execute({ id: 1, action: "inspect_adapter", url: "https://unobserved.example.org/" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(inspectAdapter).not.toHaveBeenCalled();
      await session.execute({ id: 2, action: "open", url: "https://example.org/simulator" });
      const result = await session.execute({ id: 3, action: "inspect_adapter", url: "https://example.org/times" });
      expect(result.adapter).toMatchObject({ family: "FOREUP", facilityId: 1 });
      expect(inspectAdapter).toHaveBeenCalledWith({ bookingUrl: "https://example.org/times", venueName: "Trusted venue", timeZone: "America/New_York" }, expect.objectContaining({ venueMatches: expect.any(Function) }));
      expect(discoveryBrowserActionSchema.safeParse({ id: 4, action: "inspect_adapter", url: "https://example.org/times", venueName: "Forged venue" }).success).toBe(false);
    } finally { await session.close(); }
  }, 25_000);
  it("admits the actual public SPA route for inspection without admitting invented same-origin URLs", async () => {
    const inspectAdapter = vi.fn(async () => ({ adapter: { family: "FOREUP" as const, facilityId: 1, scheduleId: 2, bookingClassId: 3 } }));
    const fixture = '<!doctype html><html><body><h1>Public venue</h1><script>history.replaceState(null,"","/schedule/public-room");</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"], venueName: "Trusted venue", timeZone: "America/New_York" }, {
      fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.url).toBe("https://example.org/schedule/public-room");
      await expect(session.execute({ id: 2, action: "inspect_adapter", url: "https://example.org/schedule/invented" })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      await session.execute({ id: 3, action: "inspect_adapter", url: snapshot.url });
      expect(inspectAdapter).toHaveBeenCalledWith({ bookingUrl: snapshot.url, venueName: "Trusted venue", timeZone: "America/New_York" }, expect.any(Object));
    } finally { await session.close(); }
  }, 25_000);
  it("gives pinned scripts and styles six MB while retaining the two MB data limit", async () => {
    const fixture = '<!doctype html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body><h1>Public venue</h1>' +
      '<script src="/assets/app.js"></script><script>fetch("/large-data").catch(()=>{});</script></body></html>';
    const largeComment = '/*' + 'x'.repeat(3_000_000) + '*/';
    const limits = new Map<string, number>();
    vi.mocked(createAddressPinnedPublicFetchTransport).mockImplementation(options => async value => {
      const url = options.parseUrl(String(value));
      limits.set(url.pathname, options.maxResponseBytes!);
      const script = url.pathname.endsWith(".js"), style = url.pathname.endsWith(".css"), data = url.pathname === "/large-data";
      return new Response(script ? `${largeComment};document.body.append(" script loaded");` : style ? largeComment : data ? JSON.stringify({ text: largeComment }) : fixture,
        { headers: { "content-type": script ? "application/javascript" : style ? "text/css" : data ? "application/json" : "text/html" } });
    });
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.text).toContain("script loaded");
      expect(limits.get("/assets/app.js")).toBe(6_000_000);
      expect(limits.get("/assets/style.css")).toBe(6_000_000);
      expect(limits.get("/large-data")).toBe(2_000_000);
      expect(snapshot.requests).toContainEqual(expect.objectContaining({ url: "https://example.org/large-data", blockedReason: "BODY_LIMIT" }));
      expect(snapshot.responseBytes).toBeGreaterThan(6_000_000);
    } finally { await session.close(); vi.mocked(createAddressPinnedPublicFetchTransport).mockReset(); }
  }, 25_000);
  it("does not spend public-read capacity on denied POSTs or decorative images", async () => {
    const fixture = '<!doctype html><html><body><h1>Sample simulator</h1><img src="/photo.png"><script>' +
      'Promise.all(Array.from({length:200},(_,i)=>fetch("/denied/"+i,{method:"POST",body:"blocked"}).catch(()=>{}))).then(()=>{document.body.append(" settled");fetch("/api/public")});' +
      '</script></body></html>';
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(String(url).endsWith("/api/public") ? '{}' : fixture, { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      let observed = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      for (let index = 0; index < 6 && (!observed.text.includes("settled") || observed.requestCount < 2); index++) observed = await session.execute({ id: index + 2, action: "observe" });
      expect(observed.requestCount).toBe(2);
      expect(observed.interceptCount).toBeGreaterThanOrEqual(202);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(observed.navigationStatus).toBe(200);
    } finally { await session.close(); }
  }, 25_000);
  it("exposes Book only inside a proved rental product, and labels adjacent unnamed comboboxes", async () => {
    const fixture = '<!doctype html><html><body><article id="product"><h2>Simulator rental</h2>1 hour<button id="choose">Book</button></article>' +
      '<div><span class="label">Party size</span><button id="party" role="combobox" aria-haspopup="listbox">2</button></div>' +
      '<article id="slot">1 hour at 09:00<button>Book</button></article></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/simulator"] }, {
      fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(result.controls.find(control => control.selector === '[id="choose"]')).toMatchObject({ kind: "product", product: { durationMinutes: 60, selector: '[id="product"]' } });
      expect(result.controls.find(control => control.selector === '[id="party"]')).toMatchObject({ kind: "filter", label: "Party size" });
      expect(result.controls.filter(control => control.name === "Book")).toHaveLength(1);
    } finally { await session.close(); }
  }, 20_000);
});
