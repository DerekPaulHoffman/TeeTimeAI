import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createCourseDiscoveryBrowserSession, discoveryBrowserActionSchema, discoveryPublicAnchorKind, discoveryPublicChoiceKind, normalizeDiscoveryNavigationUrl, redactDiscoveryFailureUrl, redactDiscoveryJson, redactDiscoveryRequestUrl, sameDiscoveryMainDocument } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";
import { deriveTeeItUpOfficialIdentityProof } from "./teeitup-official-identity";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
vi.mock("@/lib/automation/address-pinned-public-fetch", () => ({ createAddressPinnedPublicFetchTransport: vi.fn() }));

describe("discovery browser public protocol", () => {
  it("admits public reservation navigation while excluding slot and transaction controls", () => {
    const control = { tag: "a", name: "Click here to reserve a tee time", label: "", href: "https://example.org/tee-times", sensitiveForm: false };
    expect(discoveryPublicAnchorKind(control)).toBe("link");
    expect(discoveryPublicAnchorKind({ ...control, name: "Reserve 09:30" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/checkout" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?slot=123" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?Time=AnyTime&Player=99" })).toBe("link");
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?Time=09:30" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/tee-times?teeTimeId=123" })).toBeNull();
    expect(discoveryPublicAnchorKind({ ...control, href: "https://example.org/review" })).toBeNull();
  });
  it("normalizes only the known observed ForeUP public bootstrap login bookmark", () => {
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/index.php/booking/21017#/login")).toBe("https://foreupsoftware.com/index.php/booking/21017");
    expect(normalizeDiscoveryNavigationUrl("https://other.example.org/index.php/booking/21017#/login")).toContain("#/login");
    expect(normalizeDiscoveryNavigationUrl("https://foreupsoftware.com/account#/login")).toContain("#/login");
  });
  it("matches a main document across fragments without borrowing another path, query, or origin status", () => {
    const observed = "https://example.org/booking?course=12";
    expect(sameDiscoveryMainDocument(observed, `${observed}#teetimes`)).toBe(true);
    expect(sameDiscoveryMainDocument(`${observed}#old`, `${observed}#new`)).toBe(true);
    for (const current of ["https://example.org/booking?course=13#teetimes", "https://example.org/other?course=12#teetimes",
      "https://another.example.org/booking?course=12#teetimes", "http://example.org/booking?course=12#teetimes", ""]) {
      expect(sameDiscoveryMainDocument(observed, current)).toBe(false);
    }
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
  it("exposes only safe session-free diagnostic paths without query or fragment values", () => {
    expect(redactDiscoveryFailureUrl("https://public.example.org/calendar?token=secret&date=2030-10-23#private", "fetch")).toBe("https://public.example.org/calendar");
    expect(redactDiscoveryFailureUrl("https://sc.cps.golf/ExampleV3/(S(abc123abc123abc123abc123))/Home/nIndex?CourseId=1", "document"))
      .toBe("https://sc.cps.golf/ExampleV3/Home/nIndex");
    for (const value of ["https://user:secret@example.org/calendar", "https://127.0.0.1/calendar", "https://example.org/account/token-secret", "not-url"])
      expect(redactDiscoveryFailureUrl(value, "fetch")).toBeUndefined();
  });
  it("requires prebound safe sources before launching a browser", async () => {
    const launchBrowser = vi.fn();
    await expect(createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://127.0.0.1/"] }, { launchBrowser })).rejects.toThrow("INVALID_INITIAL_URLS");
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executablePath))("isolated discovery browser", () => {
  it("uses the exact observed document href instead of unrelated delegated click handlers", async () => {
    const source = "https://example.org/", destination = "https://example.org/tee-times";
    const fetcher = vi.fn(async value => new Response(String(value) === source
      ? `<html><body><h1>Public golf</h1><a id="book" href="${destination}">Book tee times</a><script>document.addEventListener('click',e=>{e.preventDefault();document.body.append(' delegated click ran');});</script></body></html>`
      : "<html><body><h1>Next booking page</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now()+20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless:true }),
      requestLease: async (_family, work) => ({ acquired:true, value:await work() }),
    });
    try {
      const snapshot = await session.execute({id:1,action:"open",url:source});
      const link = snapshot.controls.find(control=>control.name==="Book tee times")!;
      const next = await session.execute({id:2,action:"click",target:link.target});
      expect(next.url).toBe(destination); expect(next.text).toContain("Next booking page");
      expect(next.text).not.toContain("delegated click ran");
    } finally { await session.close(); }
  },25_000);
  it.each(["https://public-rentals.book.teeitup.com/", "https://public-rentals.book-v2.teeitup.golf/"])("opens only an exact visible official iframe source as a separate guarded main page: %s", async visible => {
    const official = "https://example.org/", hidden = "https://hidden-rentals.book.teeitup.com/";
    const fetcher = vi.fn(async value => new Response(String(value) === official
      ? `<html><body><h1>Public golf rentals</h1><iframe src="${visible}" style="width:400px;height:200px"></iframe><iframe hidden src="${hidden}"></iframe></body></html>`
      : "<html><body><h1>Public availability page</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], venueOfficialUrl: official, deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.frames).toContainEqual({ url: visible, source: "OFFICIAL_IFRAME_SRC" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(session.execute({ id: 2, action: "open", url: hidden })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      const standalone = await session.execute({ id: 3, action: "open", url: visible });
      expect(standalone.text).toContain("Public availability page");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await session.close(); }
  }, 25_000);
  it("loads observed public versioned scripts while blocking credential-bearing companions", async () => {
    const official = "https://example.org/", asset = "https://example.org/wp-includes/js/dist/hooks.min.js?ver=f0f188028580e8dc1255";
    const denied = `${asset}&token=private`;
    const fetcher = vi.fn(async value => String(value) === official
      ? new Response(`<html><body><h1>Public Golf</h1><script src="${asset}"></script><script src="${denied}"></script></body></html>`, { headers: { "content-type": "text/html" } })
      : new Response('document.querySelector("h1").textContent="Public availability loaded"', { headers: { "content-type": "application/javascript" } })) as unknown as typeof fetch;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 20_000) }, {
      fetch: fetcher, launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.text).toContain("Public availability loaded");
      expect(fetcher.mock.calls.map(args => String(args[0]))).toEqual([official, asset]);
      expect(snapshot.requestFailures).toContainEqual(expect.objectContaining({ url: "https://example.org/wp-includes/js/dist/hooks.min.js", reason: "UNSAFE_URL" }));
      expect(JSON.stringify(snapshot.requestFailures)).not.toContain("private");
    } finally { await session.close(); }
  }, 25_000);
  it("retains body-free request diagnostics after the first navigation fails", async () => {
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 15_000) }, {
      fetch: vi.fn(async () => { throw new Error("FIXTURE_NETWORK_FAILURE"); }) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await expect(session.execute({ id: 1, action: "open", url: "https://example.org/" })).rejects.toThrow();
      expect(session.diagnostics()).toMatchObject({ requests: [expect.objectContaining({ url: "https://example.org/", blockedReason: "FIXTURE_NETWORK_FAILURE" })],
        requestFailures: [expect.objectContaining({ reason: "FIXTURE_NETWORK_FAILURE" })] });
      expect(session.diagnostics()).not.toHaveProperty("text");
      expect(session.diagnostics().requests[0]).not.toHaveProperty("body");
    } finally { await session.close(); }
  }, 20_000);
  it("bounds a 3000-control scan before per-control inspection without losing its lower public link", async () => {
    const fixture = '<h1>Public Golf</h1>' + Array.from({ length: 2999 }, (_, index) => `<button>Decorative ${index}</button>`).join('') +
      '<a href="https://booking.example.org/calendar">Book Your Tee Time</a>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch: async () => new Response(fixture, { headers: { 'content-type': 'text/html' } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const startedAt = Date.now();
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(initial.controls).toHaveLength(1);
      expect(initial.controls[0]).toMatchObject({ name: 'Book Your Tee Time', href: 'https://booking.example.org/calendar' });
    } finally { await session.close(); }
  }, 30_000);
  it("rebuilds a snapshot after client navigation replaces an enumerated control list without repeating the click", async () => {
    const fixture = `<html><body><h1>Public Golf</h1><a href="/times" onclick="event.preventDefault();window.publicClicks=(window.publicClicks||0)+1;history.pushState({},'',this.href);document.body.innerHTML='<h1>Loading public choices</h1>'+Array.from({length:120},(_,i)=>'<button>Next '+i+'</button>').join('');setTimeout(()=>{document.body.innerHTML='<h1>Public availability ready</h1><button>Next date</button>'},425)">Book Your Tee Time</a></body></html>`;
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      const startedAt = Date.now();
      const followed = await session.execute({ id: 2, action: 'click', target: link.target });
      expect(Date.now() - startedAt).toBeLessThan(6000);
      expect(followed.url).toBe('https://example.org/times');
      expect(followed.text).toBe('Public availability ready\nNext date');
      expect(followed.controls.map(control => control.name)).toEqual(['Next date']);
      expect(await browser!.contexts()[0].pages()[0].evaluate(() => (window as unknown as { publicClicks: number }).publicClicks)).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  }, 30_000);
  it("preserves safe same-tab client navigation while following a public any-time filter", async () => {
    const fixture = '<html><body><h1>Public Golf</h1><a href="/times?Time=AnyTime" onclick="event.preventDefault();history.pushState({},\'\',this.href);document.querySelector(\'h1\').textContent=\'Client rendered availability\'">Book Your Tee Time</a></body></html>';
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 25_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      const followed = await session.execute({ id: 2, action: 'click', target: link.target });
      expect(followed.url).toBe('https://example.org/times?Time=AnyTime');
      expect(followed.text).toContain('Client rendered availability');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
  }, 30_000);
  it("finds a public booking link beyond 180 hidden, irrelevant and ordinary navigation controls", async () => {
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<button hidden>Hidden${i}</button><button>Decorative${i}</button><a href="/section${i}">Section${i}</a>`).join('') +
      '<a id="book-link" href="https://booking.example.org/calendar">Book Your Tee Time</a></body></html>';
    const fetch = vi.fn(async value => new Response(String(value).includes('booking.example.org') ? '<h1>Public tee times</h1>' : fixture,
      { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 45_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(initial.controls.length).toBeLessThanOrEqual(180);
      const link = initial.controls.find(control => control.name === 'Book Your Tee Time')!;
      expect(link).toMatchObject({ kind: 'link', href: 'https://booking.example.org/calendar' });
      expect((await session.execute({ id: 2, action: 'click', target: link.target })).url).toBe(link.href);
    } finally { await session.close(); }
  }, 50_000);
  it.each(['follow', 'stale'])("promotes a unique rendered inspected public link beyond the output cap: %s", async mode => {
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<a href="/booking${i}">Book a session${i}</a>`).join('') +
      '<a id="late-public-link" href="https://booking.example.org/calendar">Golf Tee Times</a></body></html>';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 45_000), initialUrls: ['https://example.org/'] }, {
      fetch: async value => new Response(String(value).includes('booking.example.org') ? '<h1>Public tee times</h1>' : fixture, { headers: { 'content-type': 'text/html' } }),
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const initial = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      expect(initial.controls.some(control => control.name === 'Golf Tee Times')).toBe(false);
      const observed = initial.elements.find(element => element.text === 'Golf Tee Times')!;
      expect(observed).toBeDefined();
      await expect(session.execute({ id: 10, action: 'open', url: 'https://booking.example.org/calendar' })).rejects.toThrow('UNOBSERVED_NAVIGATION');
      const inspected = await session.execute({ id: 2, action: 'inspect', selector: observed.selector });
      const link = inspected.controls.find(control => control.selector === observed.selector)!;
      expect(link).toMatchObject({ kind: 'link', href: 'https://booking.example.org/calendar' });
      expect(inspected.controls).toHaveLength(180);
      expect(inspected.structure?.ancestors[0]).toMatchObject({ href: link.href, target: link.target });
      if (mode === 'follow') expect((await session.execute({ id: 3, action: 'click', target: link.target })).url).toBe(link.href);
      else {
        await browser!.contexts()[0].pages()[0].evaluate(() => { (document.getElementById('late-public-link') as HTMLAnchorElement).href = 'https://example.org/checkout'; });
        await expect(session.execute({ id: 3, action: 'click', target: link.target })).rejects.toThrow('STALE_OR_UNKNOWN_CONTROL');
      }
    } finally { await session.close(); }
  }, 50_000);
  it("does not promote inspected unsafe, private, transaction or hidden links", async () => {
    const urls = ['https://127.0.0.1/private', 'https://example.org/login', 'https://example.org/checkout', 'https://example.org/calendar?slot=123'];
    const fixture = '<html><body><h1>Public Golf</h1>' +
      Array.from({ length: 190 }, (_, i) => `<a href="/booking${i}">Book a session${i}</a>`).join('') +
      urls.map((url, i) => `<a id="denied${i}" href="${url}">Golf availability${i}</a>`).join('') +
      '<a id="hidden-link" hidden href="https://hidden.example.org/calendar">Hidden golf availability</a></body></html>';
    const fetch = vi.fn(async () => new Response(fixture, { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 60_000), initialUrls: ['https://example.org/'] }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      let current = await session.execute({ id: 1, action: 'open', url: 'https://example.org/' });
      for (let index = 0; index < urls.length; index++) {
        const node = current.elements.find(element => element.text === `Golf availability${index}`)!;
        current = await session.execute({ id: index + 2, action: 'inspect', selector: node.selector });
        expect(current.controls.some(control => control.href === urls[index])).toBe(false);
        expect(current.structure?.ancestors[0].href).toBeUndefined();
        await expect(session.execute({ id: 10 + index, action: 'open', url: urls[index] })).rejects.toThrow('UNOBSERVED_NAVIGATION');
      }
      expect(current.elements.some(element => element.text === 'Hidden golf availability')).toBe(false);
      await expect(session.execute({ id: 20, action: 'inspect', selector: '[id="hidden-link"]' })).rejects.toThrow('STALE_OR_UNKNOWN_ELEMENT');
    } finally { await session.close(); }
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 65_000);
  it.each([false, true])("corroborates official address visibility, including transparent ancestors: %s", async hidden => {
    const officialUrl = "https://example.org/", bookingUrl = "https://harbor.book.teeitup.com/";
    const fixture = '<html><head><title>Harbor Golf Club</title></head><body><h1>Harbor Golf Club</h1>' +
      `<div${hidden ? ' style="opacity:0"' : ''}><p>20 Harbor Road<br>Example, NY 12345, US</p></div>` +
      `<a href="${bookingUrl}">Tee Times</a><script>document.querySelector("p").className="browser-added-layout";</script></body></html>`;
    const inspectAdapter = vi.fn(async (source, deps) => ({ adapter: { family: "TEEITUP" as const, alias: "harbor", facilityIds: [11],
      officialIdentityProof: deriveTeeItUpOfficialIdentityProof(source, deps.officialIdentityPage!, { requireVisibleEvidence: true }) } }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [officialUrl],
      venueOfficialUrl: officialUrl, venueName: "Harbor Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, US", timeZone: "America/New_York" }, {
      fetch: async () => new Response(fixture, { headers: { "content-type": "text/html" } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }), inspectAdapter,
    });
    try {
      await session.execute({ id: 1, action: "open", url: officialUrl });
      const result = session.execute({ id: 2, action: "inspect_adapter", url: bookingUrl });
      if (hidden) await expect(result).rejects.toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
      else expect((await result).adapter).toMatchObject({ officialIdentityProof: deriveTeeItUpOfficialIdentityProof({ officialUrl, bookingUrl,
        venueName: "Harbor Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, US", timeZone: "America/New_York" }, { url: officialUrl, html: fixture }) });
    } finally { await session.close(); }
  }, 25_000);
  it("exposes proven numeric div dates as opaque controls and clicks only the current calendar", async () => {
    const fixture = '<!doctype html><html><body><h1>Public simulator</h1><div data-testid="variable-week-calendar"><h2>October 2030</h2><div>Mo Tu We Th Fr Sa Su</div>' +
      '<div data-testid="calendar-day-2030-10-23" aria-label="2030-10-23 AvailabilityLoaded"><span>23</span></div></div><p id="result">Unselected</p>' +
      '<script>document.querySelector("[data-testid=calendar-day-2030-10-23]").onclick=()=>document.querySelector("#result").textContent="Selected October 23";</script></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const dates = snapshot.controls.filter(control => control.kind === "calendar" && control.name === "23");
      expect(dates).toHaveLength(1);
      const selected = await session.execute({ id: 2, action: "click", target: dates[0].target });
      expect(selected.text).toContain("Selected October 23");
      await expect(session.execute({ id: 3, action: "click", target: dates[0].target })).rejects.toThrow("STALE_OR_UNKNOWN_CONTROL");
    } finally { await session.close(); }
  }, 25_000);
  it.each([
    { text: "You must sign in to view tee times.", expected: true },
    { text: "You must sign in to book. Public tee times are shown below.", expected: false },
  ])("reports observed access requirements without treating booking policy as access: $expected", async ({ text, expected }) => {
    const url = "https://example.org/";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      fetch: async () => new Response(`<!doctype html><html><body><h1>Public golf</h1><p>${text}</p></body></html>`,
        { headers: { "content-type": "text/html" } }),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try { expect((await session.execute({ id: 1, action: "open", url })).accessRequirementObserved).toBe(expected); }
    finally { await session.close(); }
  }, 20_000);
  it.each([403, 429])("retains main-document HTTP %i for a hash-routed public link", async status => {
    const url = "https://example.org/booking?course=12#teetimes";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      browserTransport: "PINNED_HTTP",
      fetch: vi.fn(async () => new Response("<!doctype html><html><body><h1>Public booking document unavailable</h1></body></html>",
        { status, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url });
      expect(result.url).toBe(url);
      expect(result.navigationStatus).toBe(status);
    } finally { await session.close(); }
  }, 20_000);
  it("does not reuse a document's status after a client-side query change", async () => {
    const url = "https://example.org/booking?course=12#teetimes";
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: [url] }, {
      browserTransport: "PINNED_HTTP",
      fetch: vi.fn(async () => new Response('<!doctype html><html><body><h1>Public booking document unavailable</h1><script>history.replaceState(null,"","?course=13#teetimes")</script></body></html>',
        { status: 403, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const result = await session.execute({ id: 1, action: "open", url });
      expect(result.url).toBe("https://example.org/booking?course=13#teetimes");
      expect(result.navigationStatus).toBeUndefined();
    } finally { await session.close(); }
  }, 20_000);
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
  it("keeps a rendered page loading until native response capture finishes after the shared handler", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf availability ready</h1><a href="/times">View tee times</a><script>fetch("/api/public").catch(()=>{})</script></body></html>';
    let release: () => void = () => {}, pending = 0;
    const captured = new Promise<void>(resolve => { release = resolve; });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, close: async () => {}, get lastFailure() { return undefined; },
      get pendingReads() { return pending; },
      releasePlaywrightRoute: async route => {
        pending++;
        try {
          // Unit transport seam: real CDP owns this invocation in production.
          await handler(route);
          if (route.request().url().endsWith("/api/public")) await captured;
        } finally { pending--; }
      },
    }));
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const isJson = route.request().url().endsWith("/api/public");
      const body = Buffer.from(isJson ? '{"complete":true}' : fixture), headers = { "content-type": isJson ? "application/json" : "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { status: 200, url: route.request().url(), headers, body };
    });
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 20_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.text).toContain("Public golf availability ready");
      expect(opened.loading).toBe(true); expect(opened.pendingRequestCount).toBe(1);
      expect(session.diagnostics()).toMatchObject({ loading: true, pendingRequestCount: 1 });
      expect(opened.requestCount).toBe(2);
      expect(opened.responses).toContainEqual(expect.objectContaining({ url: "https://example.org/api/public", status: 200 }));
      release();
      const settled = await session.execute({ id: 2, action: "observe" });
      expect(settled.loading).toBe(false); expect(settled.pendingRequestCount).toBe(0);
      expect(settled.requestCount).toBe(2);
      expect(settled.responses).toEqual([]); // Each response snapshot drains once.
    } finally { release(); await session?.close(); native.mockRestore(); routing.mockRestore(); }
  }, 25_000);
  it("retains the first fatal native guard projection when later open and observe calls fail", async () => {
    const fatal = { code: "NATIVE_REDIRECT_POST_BODY_MISSING", url: "https://example.org/collect", method: "POST", resourceType: "xhr",
      interceptedRequests: 12, recordCount: 8, requestLimit: 1024, hasPostData: true, postDataPresent: false, postDataBytes: 0 };
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, _handler, options) => {
      options?.onFailure?.(fatal.code);
      return { prepare: () => {}, close: async () => {}, pendingReads: 0, lastFailure: fatal.code,
        get firstFatal() { return { ...fatal }; }, releasePlaywrightRoute: async route => { await route.abort(); } };
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 10_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      await expect(session.execute({ id: 1, action: "open", url: "https://example.org/" })).rejects.toThrow(fatal.code);
      expect(session.diagnostics().nativeFirstFatal).toEqual(fatal);
      await expect(session.execute({ id: 2, action: "observe" })).rejects.toThrow(fatal.code);
      expect(session.diagnostics().nativeFirstFatal).toEqual(fatal);
    } finally { await session?.close(); routing.mockRestore(); }
  }, 15_000);
  it("keeps oversized POST rejection diagnostics nonterminal while public controls render", async () => {
    const rejected = { code: "NATIVE_REDIRECT_POST_BODY_LIMIT", url: "https://example.org/collect", method: "POST", resourceType: "xhr", postDataBytes: 40000 };
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler, options) => {
      options?.onRequestRejected?.(rejected);
      return { prepare: () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined,
        get rejectedRequests() { return [{ ...rejected }]; }, releasePlaywrightRoute: route => handler(route) };
    });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from('<!doctype html><h1>Public golf availability</h1><a href="/times">View tee times</a>'), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body }); return { status: 200, url: route.request().url(), headers, body };
    });
    let session: Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>> | undefined;
    try {
      session = await createCourseDiscoveryBrowserSession({ initialUrls: ["https://example.org/"], deadlineAt: new Date(Date.now() + 10_000) }, {
        browserTransport: "NATIVE_CHROME", launchBrowser: () => chromium.launch({ executablePath, headless: true }),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      const observed = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(observed.controls).toContainEqual(expect.objectContaining({ name: "View tee times", kind: "link" }));
      expect(observed.nativeFirstFatal).toBeUndefined(); expect(observed.nativeRejectedRequests).toEqual([rejected]);
      expect(observed.requestFailures).toContainEqual({ reason: rejected.code, url: rejected.url, resourceType: "xhr" });
      const again = await session.execute({ id: 2, action: "observe" });
      expect(again.nativeFirstFatal).toBeUndefined(); expect(session.diagnostics().nativeRejectedRequests).toEqual([rejected]);
    } finally { await session?.close(); native.mockRestore(); routing.mockRestore(); }
  }, 15_000);
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
  it("inspects returned focusable controls and continues through returned ancestors without accepting stale or unseen nodes", async () => {
    const fixture = '<!doctype html><html><body><section id="layout"><div id="outer"><div id="middle"><div id="field">' +
      '<div>Duration</div><div tabindex="0" aria-haspopup="listbox"><span>1 Hr</span></div>' +
      '</div></div></div></section><aside><div><b id="unseen">Neutral content</b></div></aside></body></html>';
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const duration = opened.controls.find(control => control.label === "Duration");
      expect(duration).toBeDefined();
      const inspected = await session.execute({ id: 2, action: "inspect", selector: duration!.selector });
      expect(inspected.structure?.ancestors[0].text).toBe("1 Hr");
      const outer = inspected.structure!.ancestors.find(row => row.selector === '[id="outer"]');
      expect(outer).toBeDefined();
      const continued = await session.execute({ id: 3, action: "inspect", selector: outer!.selector });
      expect(continued.structure?.ancestors[0].selector).toBe('[id="outer"]');
      await expect(session.execute({ id: 4, action: "inspect", selector: '[id="unseen"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
      await browser!.contexts()[0].pages()[0].locator('[id="outer"]').evaluate(element => element.setAttribute("id", "changed"));
      await expect(session.execute({ id: 5, action: "inspect", selector: '[id="outer"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
    } finally { await session.close(); }
  }, 25_000);
  it("observes and inspects public time and rental leaves despite generated CSS without granting slot clicks", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><main><div id="grid"><div class="r-abc">' +
      '<div>10:00 am</div><div>Sims</div><div>30 min-3 hr</div></div></div></main>' +
      '<div hidden><span>11:00 am</span></div><form><input type="email" value="private@example.org"><div>Private Bay</div><div>12:00 pm</div></form>' +
      '<div>Reserve Bay</div><div id="unseen">Neutral content</div></body></html>';
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "10:00 am" }), expect.objectContaining({ text: "Sims" }), expect.objectContaining({ text: "30 min-3 hr" }),
      ]));
      expect(opened.elements.some(element => /Private Bay|11:00 am|12:00 pm|Reserve Bay/u.test(element.text))).toBe(false);
      expect(opened.controls.some(control => /10:00 am|Sims|30 min-3 hr/u.test(control.name))).toBe(false);
      const rental = opened.elements.find(element => element.text === "Sims")!;
      const inspected = await session.execute({ id: 2, action: "inspect", selector: rental.selector });
      expect(inspected.structure?.ancestors.some(row => row.text.includes("10:00 am") && row.text.includes("Sims"))).toBe(true);
      await expect(session.execute({ id: 3, action: "inspect", selector: '[id="unseen"]' })).rejects.toThrow("STALE_OR_UNKNOWN_ELEMENT");
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
  it("adds bounded structural evidence for deeply nested public JSON while retaining value redaction", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>fetch("/api/public");</script></body></html>';
    const payload = { data: { node: { agendas: { edges: [{ node: { availableTimes: [{ startsAt: "2030-10-23T10:00:00-04:00", id: "private-opaque-id", session: { token: "private-token" } }] } }] } } } };
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async url => new Response(String(url).endsWith("/api/public") ? JSON.stringify(payload) : fixture,
        { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const response = opened.responses.find(item => item.url.endsWith("/api/public"))!;
      expect(JSON.stringify(response.body)).toContain("[depth limit]");
      expect(response.schemaEvidence?.kind).toBe("SAMPLED_SCHEMA_ONLY");
      expect(response.schemaEvidence?.fields).toContainEqual(expect.objectContaining({
        path: "data.node.agendas.edges[].node.availableTimes[].startsAt", examples: ["2030-10-23T10:00:00-04:00"],
      }));
      expect(JSON.stringify(response)).not.toMatch(/private-opaque-id|private-token/u);
    } finally { await session.close(); }
  }, 25_000);
  it("caps schema evidence at 24KB across one response snapshot and explicitly marks omitted evidence", async () => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>Promise.all([1,2,3,4].map(n=>fetch("/api/"+n)));</script></body></html>';
    const payload = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field_${String(index).padStart(3, "0")}_${"a".repeat(60)}`, "value"]));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async url => new Response(String(url).includes("/api/") ? JSON.stringify(payload) : fixture,
        { headers: { "content-type": String(url).includes("/api/") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(opened.responses).toHaveLength(4);
      expect(opened.responses.reduce((sum, response) => sum + (response.schemaEvidence ? JSON.stringify(response.schemaEvidence).length : 0), 0)).toBeLessThanOrEqual(24_000);
      expect(opened.responses.some(response => response.schemaEvidenceOmitted === true)).toBe(true);
      expect(opened.responses.every(response => response.body && (response.schemaEvidence || response.schemaEvidenceOmitted))).toBe(true);
    } finally { await session.close(); }
  }, 25_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("retains a bounded %s schema when the projected public body exceeds its limit", async browserTransport => {
    const fixture = '<!doctype html><html><body><h1>Public golf</h1><script>fetch("/api/public");</script></body></html>';
    const payload = JSON.stringify({ publicRows: Array.from({ length: 100 }, () => ({ label: "x".repeat(600), startsAt: "2030-10-23T10:00:00-04:00" })),
      token: "never-expose-token" });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const json = route.request().url().endsWith("/api/public");
      const body = Buffer.from(json ? payload : fixture), headers = { "content-type": json ? "application/json" : "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { status: 200, url: route.request().url(), headers, body };
    });
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, close: async () => {}, get lastFailure() { return undefined; }, get pendingReads() { return 0; },
      releasePlaywrightRoute: route => handler(route),
    }));
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      browserTransport,
      fetch: (async url => new Response(String(url).endsWith("/api/public") ? payload : fixture,
        { headers: { "content-type": String(url).endsWith("/api/public") ? "application/json" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      const response = opened.responses.find(item => item.url.endsWith("/api/public"))!;
      expect(response.body).toBeUndefined();
      expect(response.bodyOmitted).toBe(true);
      expect(response.schemaEvidence?.fields).toContainEqual(expect.objectContaining({ path: "publicRows[].startsAt", examples: ["2030-10-23T10:00:00-04:00"] }));
      expect(JSON.stringify(response.schemaEvidence).length).toBeLessThanOrEqual(12_000);
      expect(JSON.stringify(response)).not.toContain("never-expose-token");
    } finally { await session.close(); native.mockRestore(); routing.mockRestore(); }
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
  it("loads a fourteen MB pinned script while retaining six MB styles and two MB data limits", async () => {
    const fixture = '<!doctype html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body><h1>Public venue</h1>' +
      '<script src="/assets/app.js"></script><script>fetch("/large-data").catch(()=>{});</script></body></html>';
    const largeComment = '/*' + 'x'.repeat(3_000_000) + '*/';
    const limits = new Map<string, number>();
    vi.mocked(createAddressPinnedPublicFetchTransport).mockImplementation(options => async value => {
      const url = options.parseUrl(String(value));
      limits.set(url.pathname, options.maxResponseBytes!);
      const script = url.pathname.endsWith(".js"), style = url.pathname.endsWith(".css"), data = url.pathname === "/large-data";
      return new Response(script ? `/*${"x".repeat(14_500_000)}*/;document.body.append(" script loaded");` : style ? largeComment : data ? JSON.stringify({ text: largeComment }) : fixture,
        { headers: { "content-type": script ? "application/javascript" : style ? "text/css" : data ? "application/json" : "text/html" } });
    });
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 30_000), initialUrls: ["https://example.org/"] }, {
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: "https://example.org/" });
      expect(snapshot.text).toContain("script loaded");
      expect(limits.get("/assets/app.js")).toBe(16_000_000);
      expect(limits.get("/assets/style.css")).toBe(6_000_000);
      expect(limits.get("/large-data")).toBe(2_000_000);
      expect(snapshot.requests).toContainEqual(expect.objectContaining({ url: "https://example.org/large-data", blockedReason: "BODY_LIMIT" }));
      expect(snapshot.responseBytes).toBeGreaterThan(6_000_000);
    } finally { await session.close(); vi.mocked(createAddressPinnedPublicFetchTransport).mockReset(); }
  }, 25_000);
  it("stops cumulative decoded responses at the finite session budget", async () => {
    const fixture = '<!doctype html><html><body><h1>Public venue</h1>' + [1, 2, 3, 4].map(id => `<script src="/bundle-${id}.js"></script>`).join("") + '</body></html>';
    const body = `/*${"x".repeat(14_000_000)}*/`;
    const failures: string[] = [];
    const session = await createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 20_000), initialUrls: ["https://example.org/"] }, {
      fetch: (async value => new Response(String(value).endsWith('.js') ? body : fixture,
        { headers: { "content-type": String(value).endsWith('.js') ? "application/javascript" : "text/html" } })) as typeof fetch,
      launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      onRequestFailure: failure => failures.push(failure.reason),
    });
    try {
      await session.execute({ id: 1, action: "open", url: "https://example.org/" }).catch(() => {});
      expect(failures).toContain("PUBLIC_READ_BYTE_LIMIT");
    } finally { await session.close(); }
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
