// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { awaitStagehandPopupContinuation, canonicalStagehandHostEntry, createGuardedStagehandSourceBrowser, stagehandGestureMintFailure, stagehandSourceBrowserMode } from "./stagehand-source-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { requestFamilyForUrl } from "./request-family";

for (const mode of ["direct", "redirect", "independent-script"] as const) it(`earns one completed JS public source from a fresh placeholder native gesture: ${mode}`, async () => {
  const initialUrl = "https://owned-source.example/", destination = "https://owned-booking.example/services?public=1";
  const finalUrl = mode === "redirect" ? "https://owned-final.example/calendar?public=1" : destination;
  const controller = new AbortController(), deadlineAt = new Date(Date.now() + 60_000);
  let active = 0, acquired = 0, released = 0; const families = new Set<string>(), reads: string[] = [];
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    reads.push(request.url ?? "");
    if (mode === "redirect" && request.headers.host === "owned-booking.example" && request.url === "/services?public=1") {
      response.writeHead(302, { location: finalUrl }).end(); return;
    }
    const body = request.url === "/" ? '<a id="public" href="#">Book Bay</a><script>document.querySelector("#public").addEventListener("click",event=>{event.preventDefault();location.assign("https://owned-booking.example/services?public=1")});</script>' : '<h1>Public service calendar</h1>';
    response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body>' + body + '</body></html>');
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (family, work) => { if (active >= 2 || families.has(family)) return { acquired: false }; acquired++; active++; families.add(family);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); } },
      proxyDependencies: { resolveAddresses: async name => { if (!["owned-source.example", "owned-booking.example", "owned-final.example"].includes(name)) throw Error("NOT_OWNED_FIXTURE"); return [{ address: "93.184.216.34", family: 4 }]; },
        connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl);
    const page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(initialUrl); await page.goto(initialUrl, { waitUntil: "load" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(await host.completeGestureNavigation(host.targetId)).toBeNull();
    const prepared = await host.beforeAction(host.targetId, initialUrl + "#", { text: "Book Bay", label: "" });
    await page.locator("#public").click(); await page.waitForURL(finalUrl);
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    const completed = await host.completeGestureNavigation(host.targetId);
    expect(completed).toMatchObject({ kind: "NATIVE_GESTURE_SOURCE_OPEN", pageUrl: initialUrl, href: initialUrl + "#", targetUrl: destination, finalUrl, finalStatus: 200,
      redirects: mode === "redirect" ? [{ fromUrl: destination, toUrl: finalUrl, status: 302, completed: true }] : [],
      observedAt: prepared!.observedAt, documentHash: prepared!.documentHash });
    expect(completed!.finalDocumentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(completed)).not.toMatch(/frameId|loaderId|nonce|leaseToken/u);
    await expect(host.completeGestureNavigation(host.targetId)).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    expect(reads).toEqual(mode === "redirect" ? ["/", "/services?public=1", "/calendar?public=1"] : ["/", "/services?public=1"]);
    expect(host.snapshotFailures().nativeRouterFailure).toBeUndefined();
    if (mode === "independent-script") {
      await page.evaluate(() => { location.assign("https://owned-final.example/other"); });
      await expect.poll(() => host!.snapshotFailures().nativeRouterFailure?.sourceRequestGuard).toBe("NAVIGATION_PROVENANCE");
      expect(reads).toEqual(["/", "/services?public=1"]);
      expect(await host.completeGestureNavigation(host.targetId).catch(() => null)).toBeNull();
      return;
    }
    await host.prepareNavigation(initialUrl); await page.goto(initialUrl, { waitUntil: "load" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200 });
    await host.beforeAction(host.targetId, initialUrl + "#", { text: "Book Bay", label: "" });
    const originalNow = Date.now, clock = vi.spyOn(Date, "now").mockImplementation(() => originalNow() + 6000);
    try {
      await page.locator("#public").click({ timeout: 3000 }).catch(() => {});
      await expect.poll(() => host!.snapshotFailures().nativeRouterFailure).toMatchObject({ sourceRequestGuard: "NAVIGATION_PROVENANCE" });
      expect(host.snapshotFailures().hostGuardFailure).toMatchObject({ stage: "GESTURE", reason: "INTENT_EXPIRED" });
      expect(reads).toEqual(mode === "redirect" ? ["/", "/services?public=1", "/calendar?public=1", "/"] : ["/", "/services?public=1", "/"]);
    } finally { clock.mockRestore(); }
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true }); expect(active).toBe(0); expect(acquired).toBe(released);
  } finally { await host?.close(); await attached?.close().catch(() => {}); controller.abort(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 60_000);

it("names only closed private reasons when a placeholder cannot mint a navigation intent", () => {
  const ready = { placeholderHrefExact: true, sourceRequestPresent: true, sourceSettled: true, visibleLinkIndexed: true };
  expect(stagehandGestureMintFailure(ready)).toBeNull();
  expect(stagehandGestureMintFailure({ ...ready, placeholderHrefExact: false })).toBe("NOT_PLACEHOLDER");
  expect(stagehandGestureMintFailure({ ...ready, sourceRequestPresent: false })).toBe("DOCUMENT_REQUEST_MISSING");
  expect(stagehandGestureMintFailure({ ...ready, sourceSettled: false })).toBe("SOURCE_NOT_SETTLED");
  expect(stagehandGestureMintFailure({ ...ready, visibleLinkIndexed: false })).toBe("VISIBLE_LINK_MISSING");
});

type AckMode = "NORMAL" | "DELAY" | "REJECT" | "NEVER" | "FORK" | "OVERSIZE";
const popupAck = vi.hoisted(() => ({ mode: "NORMAL" as AckMode, armed: false, delayed: 0, pending: 0, earlySuccessor: false, forked: false, oversized: false }));
vi.mock("./stagehand-owned-cdp", async importOriginal => {
  const actual = await importOriginal<typeof import("./stagehand-owned-cdp")>();
  return { ...actual, connectOwnedSourceCdp: async (...args: Parameters<typeof actual.connectOwnedSourceCdp>) => {
    const connection = await actual.connectOwnedSourceCdp(...args);
    return { ...connection, session: (id: string) => {
      const session = connection.session(id);
      return { ...session, on: (method: string, listener: (value: Record<string, unknown>) => unknown) => session.on(method, value => {
        if (method === "Fetch.requestPaused" && popupAck.armed && popupAck.mode === "OVERSIZE" && !popupAck.oversized &&
            typeof value.redirectedRequestId === "string" && value.responseStatusCode === undefined && value.responseErrorReason === undefined) {
          popupAck.oversized = true;
          const request = value.request as { headers: Record<string, string> };
          return listener({ ...value, request: { ...request, headers: { ...request.headers, "x-owned-padding": "x".repeat(2_000_001) } } });
        }
        const result = listener(value);
        if (method === "Fetch.requestPaused" && popupAck.armed && popupAck.mode === "FORK" && !popupAck.forked &&
            typeof value.redirectedRequestId === "string" && value.responseStatusCode === undefined && value.responseErrorReason === undefined) {
          popupAck.forked = true;
          // A second purported successor is a fixture-only protocol fault.
          // The original real request remains paused and must not dispatch.
          listener({ ...value, requestId: String(value.requestId) + "-owned-fork" });
        }
        return result;
      }), send: async (...command: Parameters<typeof session.send>) => {
        const result = await session.send(...command);
        if (command[0] === "Fetch.continueResponse" && popupAck.armed && popupAck.mode !== "NORMAL") {
          popupAck.delayed++;
          // Chrome receives the real command, while the trusted controller has
          // not yet observed its ACK. A redirect may pause in this interval.
          if (popupAck.mode === "REJECT") throw Error("OWNED_ACK_REJECTED");
          if (popupAck.mode === "NEVER") return new Promise<never>(() => {});
          popupAck.pending++;
          try { await new Promise(resolve => setTimeout(resolve, 100)); }
          finally { popupAck.pending--; }
        }
        return result;
      } };
    } };
  } };
});

// Reuse the existing public throwaway localhost certificate; never user TLS,
// browser profiles, local auth, production leases, or external provider data.
const material = readFileSync("src/lib/course-discovery/cps-browser-wiring.test.ts", "utf8");
const certificate = (name: string) => JSON.parse(new RegExp("const " + name + " = (\".*?\");").exec(material)![1]);

it("uses the full extension-capable browser in headless Linux and macOS", () => {
  expect(stagehandSourceBrowserMode("linux")).toEqual({ headless: true, channel: "chromium" });
  expect(stagehandSourceBrowserMode("darwin")).toEqual({ headless: true, channel: "chromium" });
  expect(stagehandSourceBrowserMode("win32")).toEqual({ headless: false, channel: "chrome" });
});

it("canonicalizes only a missing homepage slash without changing routes, queries, or input", () => {
  const input = { officialUrl: "https://public.example" };
  expect(canonicalStagehandHostEntry(input.officialUrl)).toBe("https://public.example/");
  expect(input.officialUrl).toBe("https://public.example");
  expect(canonicalStagehandHostEntry("https://public.example/route?two=2&one=1")).toBe("https://public.example/route?two=2&one=1");
  for (const value of ["https://public.example/a/../route", "https://public.example/%2e%2e/route", "https://PUBLIC.example", "https://public.example:443", "https://public.example\\route", "https://user@public.example/", "http://public.example/", "https://public.example/ASP/appt_req.asp"]) expect(() => canonicalStagehandHostEntry(value)).toThrow();
});

it("attests a unique native public source without dispatching provider frames and falls back for ambiguity or overflow", async () => {
  const foreup = "https://foreupsoftware.com/index.php/booking/123/456#/teetimes", tee = "https://public-course.book.teeitup.com/";
  const controller = new AbortController(); let active = 0, acquired = 0, released = 0, foreignLookups = 0;
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body><a id="source" href="${foreup}">Public times</a>
      <iframe hidden src="${tee}"></iframe><iframe src="${tee}" srcdoc=""></iframe><iframe style="width:0;height:0;border:0" src="${tee}"></iframe></body>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: "https://owned-source.example/", timeZone: "UTC", deadlineAt: new Date(Date.now() + 60_000), signal: controller.signal }, {
      requestLease: async (_family, work) => { active++; acquired++; try { return { acquired: true, value: await work() }; } finally { active--; released++; } },
      proxyDependencies: { resolveAddresses: async name => { if (name !== "owned-source.example") { foreignLookups++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    const attached = await chromium.connectOverCDP(host.cdpUrl), page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation("https://owned-source.example/"); await page.goto("https://owned-source.example/", { waitUntil: "load" });
    const selected = await host.observeUniqueSource(host.targetId);
    expect(selected).toMatchObject({ kind: "NATIVE_UNIQUE_SUPPORTED_SOURCE", url: foreup, family: "FOREUP", via: "LINK", pageUrl: "https://owned-source.example/" });
    expect(selected?.documentHash).toMatch(/^[a-f0-9]{64}$/u); expect(Date.now() - Date.parse(selected!.observedAt)).toBeLessThan(5000);
    await page.evaluate(url => { document.body.innerHTML = `<iframe style="width:200px;height:100px" src="${url}"></iframe>`; }, tee);
    expect(await host.observeUniqueSource(host.targetId)).toMatchObject({ url: tee, via: "FRAME" });
    await page.evaluate(url => { const a = document.createElement("a"); a.href = url; a.textContent = "Public times"; document.body.append(a); }, tee);
    expect(await host.observeUniqueSource(host.targetId)).toMatchObject({ url: tee, via: "LINK_AND_FRAME" });
    await page.evaluate(() => { const a = document.createElement("a"); a.id = "other"; a.href = "https://clients.uschedule.com/public-studio/booking"; a.textContent = "Other public source"; document.body.append(a); });
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();
    await page.evaluate(() => { document.getElementById("other")!.remove(); for (let i = 0; i < 160; i++) { const a = document.createElement("a"); a.className = "overflow"; a.href = "https://owned-source.example/other"; a.textContent = "Public navigation"; document.body.append(a); } });
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();
    await page.evaluate(url => { document.querySelectorAll("a").forEach(node => node.remove()); document.body.innerHTML = Array.from({ length: 25 }, () => `<iframe src="${url}"></iframe>`).join(""); }, tee);
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();
    await expect(host.observeUniqueSource("foreign-target")).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    expect(foreignLookups).toBe(0); expect(host.diagnostics().admittedRequests).toBe(1);
    controller.abort(); await expect(host.observeUniqueSource(host.targetId)).rejects.toThrow();
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
    expect(active).toBe(0); expect(acquired).toBe(released);
  } finally { controller.abort(); await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.each(["CALENDAR", "SERVICE_CATALOG"] as const)("attests only the current completed initial root widget, including a real initial redirect and same-document fragment (%s)", async widgetKind => {
  const root = "https://owned-root.example/", alias = "https://owned-root-alias.example/", controller = new AbortController();
  const deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime(), reads: string[] = [];
  let active = 0, acquired = 0, released = 0, foreign = 0;
  const widget = widgetKind === "SERVICE_CATALOG" ? '<main><div><h3>Public golf rentals</h3>' + [1, 2, 3].map(hours =>
    `<div><h4>${hours} Hour Public Practice</h4><p>${hours === 1 ? '1 hr' : `${hours - 1} hr 55 mins`}</p><p>People in your party are welcome. Reset time is separate.</p><span role="button" aria-haspopup="menu"><span role="button" aria-haspopup="menu">More</span></span><div><button type="button">BOOK</button></div></div>`).join("") + '</div><a href="/operator/">Operator</a></main>' : '<main><h1>Public golf availability</h1><div role="grid">' +
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => '<span role="columnheader">' + day + '</span>').join("") +
    Array.from({ length: 14 }, (_, i) => '<button type="button" role="gridcell">' + (i + 1) + '</button>').join("") + '</div><a href="/operator/">Operator</a></main>';
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    reads.push(request.method + " " + request.headers.host + request.url);
    if (request.headers.host === "owned-root.example") { response.writeHead(302, { location: alias }).end(); return; }
    response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><link rel="icon" href="data:,">' + widget);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: root, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (_family, work) => { active++; acquired++; try { return { acquired: true, value: await work() }; } finally { active--; released++; } },
      proxyDependencies: { resolveAddresses: async name => { if (!["owned-root.example", "owned-root-alias.example"].includes(name)) { foreign++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl); const page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(root); await page.goto(root, { waitUntil: "load" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentStatus: 200, mainDocumentCurrent: true, mainReadPending: false, pendingReads: 0 });
    const before = [...reads], leases = acquired;
    expect(await host.observeRootPublicWidget(host.targetId)).toMatchObject({ kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: alias, widgetKind });
    await page.evaluate(() => history.pushState({}, "", "#public-calendar"));
    expect(await host.observeRootPublicWidget(host.targetId)).toMatchObject({ pageUrl: alias + "#public-calendar" });
    await page.evaluate(() => history.pushState({}, "", "?different=1"));
    expect(await host.observeRootPublicWidget(host.targetId)).toBeNull();
    await page.evaluate(() => history.replaceState({}, "", "/"));
    await page.evaluate(() => { document.querySelector("main")!.setAttribute("inert", ""); });
    expect(await host.observeRootPublicWidget(host.targetId)).toBeNull();
    await page.evaluate(() => { document.querySelector("main")!.removeAttribute("inert"); });
    expect(await host.observeRootPublicWidget("foreign-target")).toBeNull();
    expect(reads).toEqual(before); expect(acquired).toBe(leases);
    await host.beforeAction(host.targetId, alias + "operator/");
    await page.locator('a[href="/operator/"]').click(); await page.waitForLoadState("load");
    expect(await host.observeRootPublicWidget(host.targetId)).toBeNull();
    expect(deadlineAt.getTime()).toBe(originalDeadline); expect(Date.now()).toBeLessThan(originalDeadline); expect(foreign).toBe(0);
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true }); expect(active).toBe(0); expect(acquired).toBe(released);
  } finally { controller.abort(); await host?.close(); await attached?.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it("renders a public source from an anonymous cross-host fetch redirect under the destination lease and rejects private or transactional reads", async () => {
  const rootUrl = "https://owned-source.example/", bootstrapUrl = "https://owned-bootstrap.example/catalog.json";
  // This existing anonymous metadata role intentionally has a broader URL
  // policy than saved recipe navigation. Redirect ownership cannot replace
  // the source handler's final public-read policy with the narrower one.
  const dataUrl = "https://owned-data.example/AuthenticationSettings?AuthenticationType=", bookingUrl = "https://clients.uschedule.com/public-studio/booking";
  const hosts = new Set(["owned-source.example", "owned-bootstrap.example", "owned-data.example"]);
  const controller = new AbortController(), deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime();
  const families = new Set<string>(), leaseFamilies: string[] = [], seen: string[] = [];
  let active = 0, acquired = 0, released = 0, maxGlobal = 0, unleased = 0, unexpectedLookup = 0, destinationBeforeParentRelease = false;
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    const name = (request.headers.host ?? "").split(":")[0], path = request.url ?? "/";
    seen.push(`${request.method} ${name}${path}`);
    if (!families.has(requestFamilyForUrl("https://" + name + path))) unleased++;
    if (!hosts.has(name)) { response.writeHead(403).end(); return; }
    const cors = { "access-control-allow-origin": "*" };
    if (name === "owned-bootstrap.example") {
      const location = path === "/transaction-redirect.json"
        ? "https://owned-data.example/ASP/appt_req.asp?Stime=10" : dataUrl;
      response.writeHead(302, { ...cors, location }).end(); return;
    }
    if (name === "owned-data.example") {
      if (families.has(requestFamilyForUrl(bootstrapUrl))) destinationBeforeParentRelease = true;
      response.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ href: bookingUrl })); return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
      <p>Public booking information</p><script>
      fetch(${JSON.stringify(bootstrapUrl)}, { credentials: 'omit' }).then(response => {
        if (!response.ok) throw Error('PUBLIC_BOOTSTRAP_FAILED'); return response.json();
      }).then(value => { const link = document.createElement('a'); link.id = 'public-booking'; link.href = value.href;
        link.textContent = 'Public booking'; document.body.append(link); });
      </script></body></html>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: rootUrl, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false };
        active++; acquired++; families.add(family); leaseFamilies.push(family); maxGlobal = Math.max(maxGlobal, active);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); }
      },
      proxyDependencies: { resolveAddresses: async name => { if (!hosts.has(name)) { unexpectedLookup++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl);
    const page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(rootUrl); await page.goto(rootUrl, { waitUntil: "load" });
    await page.locator("#public-booking").waitFor({ state: "visible" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(await host.observeUniqueSource(host.targetId)).toMatchObject({ kind: "NATIVE_UNIQUE_SUPPORTED_SOURCE", pageUrl: rootUrl, url: bookingUrl, family: "USCHEDULE", via: "LINK" });
    expect(seen).toEqual(["GET owned-source.example/", "GET owned-bootstrap.example/catalog.json", "GET owned-data.example/AuthenticationSettings?AuthenticationType="]);
    expect(leaseFamilies).toEqual([rootUrl, bootstrapUrl, dataUrl].map(requestFamilyForUrl));
    expect(destinationBeforeParentRelease).toBe(false); expect(unleased).toBe(0);
    await page.evaluate(async () => { await Promise.allSettled([
      fetch("/forbidden-post", { method: "POST", body: "fixture=only" }),
      // Deliberately synthetic header; no real credential or account is used.
      fetch("/forbidden-header", { headers: { Authorization: "owned-fixture-only" } }),
      fetch("https://127.0.0.1/private", { credentials: "omit" }),
    ]); });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(seen).toHaveLength(3); expect(leaseFamilies).toHaveLength(3); expect(host.diagnostics().closed).toBe(false);
    // The public parent may run, never its transaction successor. Depending on
    // the rejecting boundary, denial can be terminal or leave the source live.
    await page.evaluate(async () => { await fetch("https://owned-bootstrap.example/transaction-redirect.json", { credentials: "omit" }).catch(() => undefined); }).catch(() => undefined);
    await expect.poll(() => host!.diagnostics().activeRequests).toBe(0);
    if (host.diagnostics().terminalFailure) await expect(host.observeUniqueSource(host.targetId)).rejects.toThrow();
    else expect(await host.observeUniqueSource(host.targetId)).toMatchObject({ kind: "NATIVE_UNIQUE_SUPPORTED_SOURCE", pageUrl: rootUrl, url: bookingUrl, family: "USCHEDULE", via: "LINK" });
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
    const deniedParents = seen.slice(3);
    expect(deniedParents.length).toBeLessThanOrEqual(1);
    expect(deniedParents.every(value => value === "GET owned-bootstrap.example/transaction-redirect.json")).toBe(true);
    expect(leaseFamilies.slice(3)).toEqual(deniedParents.map(() => requestFamilyForUrl(bootstrapUrl)));
    expect(unleased).toBe(0); expect(unexpectedLookup).toBe(0); expect(maxGlobal).toBeLessThanOrEqual(2);
    expect(host.diagnostics().admittedRequests).toBe(3 + deniedParents.length); expect(deadlineAt.getTime()).toBe(originalDeadline);
    expect(active).toBe(0); expect(acquired).toBe(released); expect(families.size).toBe(0);
  } finally {
    controller.abort(); await attached?.close().catch(() => {}); await host?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);

it("renders a current public service catalog from four exact anonymous metadata GETs and correlated content-type preflights", async () => {
  const root = "https://owned-catalog.example/", account = "11111111-2222-4333-8444-555555555555";
  const urls = [`https://api.ola.godaddy.com/accounts/${account}/config`, `https://api.ola.godaddy.com/accounts/${account}/hivemind`,
    `https://api.ola.godaddy.com/v3/accounts/${account}/services?per_page=80&with_category_ids=true`, `https://api.ola.godaddy.com/v2/accounts/${account}/categories`];
  const hosts = new Set(["owned-catalog.example", "api.ola.godaddy.com"]), controller = new AbortController();
  const deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime();
  const seen: { url: string; method: string; requestedMethod?: string; requestedHeaders?: string; authorization: boolean; cookie: boolean }[] = [], families = new Set<string>(), leaseFamilies: string[] = [];
  let active = 0, acquired = 0, released = 0, maximumActive = 0, unleased = 0, unexpectedLookup = 0;
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    const name = (request.headers.host ?? "").split(":")[0], url = "https://" + name + (request.url ?? "/");
    seen.push({ url, method: request.method ?? "", requestedMethod: request.headers["access-control-request-method"] as string | undefined,
      requestedHeaders: request.headers["access-control-request-headers"] as string | undefined, authorization: request.headers.authorization !== undefined, cookie: request.headers.cookie !== undefined });
    if (!families.has(requestFamilyForUrl(url))) unleased++;
    if (!hosts.has(name)) { response.writeHead(403).end(); return; }
    if (url !== root) {
      const cors = { "access-control-allow-origin": root.slice(0, -1), "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" };
      if (!urls.includes(url)) { response.writeHead(403, cors).end(); return; }
      if (request.method === "OPTIONS") { response.writeHead(204, cors).end(); return; }
      response.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ complete: true, empty: true, hours: [1, 2, 3] })); return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><link rel="icon" href="data:,"><main><h1>Loading public golf services</h1></main><script>
      (async()=>{let catalog;for(const url of ${JSON.stringify(urls)})catalog=await fetch(url,{credentials:'omit',headers:{'content-type':'application/json'}}).then(response=>response.json());
      const main=document.querySelector('main');main.innerHTML='<h3>Public golf rentals</h3>'+catalog.hours.map(hours=>'<div><h4>'+hours+' Hour Public Practice</h4><p>'+hours+' hr</p><p>Public hourly golf rental</p><button type="button">BOOK</button></div>').join('');})();
      </script>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: root, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false };
        active++; acquired++; maximumActive = Math.max(maximumActive, active); families.add(family); leaseFamilies.push(family);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); }
      },
      proxyDependencies: { resolveAddresses: async name => { if (!hosts.has(name)) { unexpectedLookup++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl); const page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(root); await page.goto(root, { waitUntil: "load" });
    await page.getByRole("heading", { name: "Public golf rentals", exact: true }).waitFor({ state: "visible" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(seen.filter(row => row.method === "GET").map(row => row.url)).toEqual([root, ...urls]);
    const preflights = seen.filter(row => row.method === "OPTIONS"); expect(preflights.length).toBeGreaterThan(0);
    for (const row of preflights) { expect(urls).toContain(row.url); expect(row.requestedMethod).toBe("GET"); expect(row.requestedHeaders).toBe("content-type"); }
    expect(seen.every(row => ["GET", "OPTIONS"].includes(row.method) && !row.authorization && !row.cookie)).toBe(true);
    expect(leaseFamilies).toEqual(seen.map(row => requestFamilyForUrl(row.url))); expect(unleased).toBe(0);
    // This is current-root routing presence only: no supported source, selected slot, recipe or availability result.
    expect(await host.observeRootPublicWidget(host.targetId)).toMatchObject({ kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: root, widgetKind: "SERVICE_CATALOG" });
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();
    await expect(host.prepareNavigation(urls[0])).rejects.toThrow();
    const reads = seen.length, leases = acquired;
    await page.evaluate(async values => { await Promise.allSettled(values.map(url => fetch(url, { credentials: "omit" }))); },
      [urls[0] + "?unexpected=1", `https://api.ola.godaddy.com/accounts/${account}/customers`, "https://127.0.0.1/private"]);
    await expect.poll(() => host!.diagnostics().activeRequests).toBe(0);
    expect(seen).toHaveLength(reads); expect(acquired).toBe(leases); expect(unexpectedLookup).toBe(0); expect(maximumActive).toBeLessThanOrEqual(2);
    expect(deadlineAt.getTime()).toBe(originalDeadline); expect(Date.now()).toBeLessThan(originalDeadline);
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true }); expect(active).toBe(0); expect(acquired).toBe(released); expect(families.size).toBe(0);
  } finally { controller.abort(); await attached?.close().catch(() => {}); await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it("renders a current native calendar through distinct public date-metadata and dated-availability GETs", async () => {
  const root = "https://owned-calendar.example/", account = "11111111-2222-4333-8444-555555555555", service = `accounts/${account}/services/71`;
  const query = `?start_time=${encodeURIComponent("2030-01-02T00:00:00.000-05:00")}&end_time=${encodeURIComponent("2030-01-02T23:59:59.999-05:00")}&resource_ids[]=81&resource_ids[]=82`;
  const times = `https://api.ola.godaddy.com/v2/${service}/available_times${query}`;
  const metadata = [`https://api.ola.godaddy.com/${service}/available_dates${query}`, `https://api.ola.godaddy.com/accounts/${account}/config?fields[]=cart`,
    `https://api.ola.godaddy.com/addons/v1/${service}/addons`], urls = [...metadata, times];
  const hosts = new Set(["owned-calendar.example", "api.ola.godaddy.com"]), controller = new AbortController(), families = new Set<string>();
  const deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime(), leaseFamilies: string[] = [];
  const seen: { url: string; method: string; requestedMethod?: string; requestedHeaders?: string; credentials: boolean }[] = [];
  let active = 0, acquired = 0, released = 0, maximumActive = 0, unleased = 0, unexpectedLookup = 0;
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    const name = (request.headers.host ?? "").split(":")[0], url = "https://" + name + (request.url ?? "/");
    seen.push({ url, method: request.method ?? "", requestedMethod: request.headers["access-control-request-method"] as string | undefined,
      requestedHeaders: request.headers["access-control-request-headers"] as string | undefined, credentials: request.headers.authorization !== undefined || request.headers.cookie !== undefined });
    if (!families.has(requestFamilyForUrl(url))) unleased++;
    if (!hosts.has(name)) { response.writeHead(403).end(); return; }
    if (url !== root) {
      const cors = { "access-control-allow-origin": root.slice(0, -1), "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" };
      if (!urls.includes(url)) { response.writeHead(403, cors).end(); return; }
      if (request.method === "OPTIONS") { response.writeHead(204, cors).end(); return; }
      response.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(url === times ?
        { data: { "2030-01-02T10:00:00-05:00": [{ resource_id: 81 }, { resource_id: 82 }] } } : { complete: true, empty: true, data: [] })); return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><link rel="icon" href="data:,"><main><h1>Loading public golf calendar</h1></main><script>
      (async()=>{for(const url of ${JSON.stringify(urls)})await fetch(url,{credentials:'omit',headers:{'content-type':'application/json'}}).then(response=>response.json());
      document.querySelector('main').innerHTML='<h1>Public golf calendar ready</h1><div role="grid">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>'<span role="columnheader">'+day+'</span>').join('')+
      Array.from({length:14},(_,i)=>'<button type="button" role="gridcell">'+(i+1)+'</button>').join('')+'</div>';})();</script>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: root, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false };
        active++; acquired++; maximumActive = Math.max(maximumActive, active); families.add(family); leaseFamilies.push(family);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); }
      },
      proxyDependencies: { resolveAddresses: async name => { if (!hosts.has(name)) { unexpectedLookup++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl); const page = attached.contexts().flatMap(context => context.pages())[0];
    await host.prepareNavigation(root); await page.goto(root, { waitUntil: "load" });
    await page.getByRole("heading", { name: "Public golf calendar ready", exact: true }).waitFor({ state: "visible" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(seen.filter(row => row.method === "GET").map(row => row.url)).toEqual([root, ...urls]);
    const options = seen.filter(row => row.method === "OPTIONS"); expect(options.length).toBeGreaterThan(0);
    for (const row of options) { expect(urls).toContain(row.url); expect(row.requestedMethod).toBe("GET"); expect(row.requestedHeaders).toBe("content-type"); }
    expect(seen.every(row => !row.credentials && ["GET", "OPTIONS"].includes(row.method))).toBe(true);
    expect(leaseFamilies).toEqual(seen.map(row => requestFamilyForUrl(row.url))); expect(unleased).toBe(0);
    // Only actual current DOM presence is witnessed, never JSON completeness, dated inventory or an adapter.
    expect(await host.observeRootPublicWidget(host.targetId)).toMatchObject({ kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: root, widgetKind: "CALENDAR" });
    expect(await host.observeUniqueSource(host.targetId)).toBeNull();
    for (const url of urls) await expect(host.prepareNavigation(url)).rejects.toThrow();
    const reads = seen.length, leases = acquired;
    await page.evaluate(async values => { await Promise.allSettled(values.map(url => fetch(url, { credentials: "omit" }))); },
      [times + "&customer_id=1", `https://api.ola.godaddy.com/accounts/${account}/customers`, "https://127.0.0.1/private"]);
    await expect.poll(() => host!.diagnostics().activeRequests).toBe(0);
    expect(seen).toHaveLength(reads); expect(acquired).toBe(leases); expect(unexpectedLookup).toBe(0); expect(maximumActive).toBeLessThanOrEqual(2);
    expect(deadlineAt.getTime()).toBe(originalDeadline); expect(Date.now()).toBeLessThan(originalDeadline);
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true }); expect(active).toBe(0); expect(acquired).toBe(released); expect(families.size).toBe(0);
  } finally { controller.abort(); await attached?.close().catch(() => {}); await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it("keeps the completed owned GET current across a real history navigation without granting iframe history ownership or a new budget", async () => {
  const initialUrl = "https://owned-source.example/", bookingUrl = initialUrl + "book-a-time/";
  const controller = new AbortController(), deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime();
  let active = 0, acquired = 0, released = 0, foreignLookups = 0;
  const requests: string[] = [];
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
      <a id="book" href="/book-a-time/">Book a time</a><script>
      document.getElementById('book').addEventListener('click', event => {
        event.preventDefault(); history.pushState({}, '', '/book-a-time/');
      });</script></body></html>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (_family, work) => { active++; acquired++; try { return { acquired: true, value: await work() }; } finally { active--; released++; } },
      proxyDependencies: { resolveAddresses: async name => { if (name !== "owned-source.example") { foreignLookups++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl);
    const page = attached.contexts().flatMap(context => context.pages())[0], cdp = await page.context().newCDPSession(page);
    const historyEvents: Array<{ frameId: string; url: string }> = [];
    cdp.on("Page.navigatedWithinDocument", event => historyEvents.push(event));
    await cdp.send("Page.enable");
    await host.prepareNavigation(initialUrl); await page.goto(initialUrl, { waitUntil: "load" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({
      mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, mainReadPending: false, pendingReads: 0,
    });
    const before = (await cdp.send("Page.getFrameTree")).frameTree.frame, leasesAfterGet = acquired;
    expect(before.url).toBe(initialUrl); expect(before.loaderId).toBeTruthy(); expect(requests).toEqual(["GET /"]);
    expect(await host.beforeAction(host.targetId, bookingUrl)).toMatchObject({ pageUrl: initialUrl, links: [{ href: bookingUrl, visible: true }] });
    await page.locator("#book").click();
    await expect.poll(() => historyEvents.some(event => event.frameId === before.id && event.url === bookingUrl)).toBe(true);
    expect(page.url()).toBe(bookingUrl);
    const after = (await cdp.send("Page.getFrameTree")).frameTree.frame;
    expect({ id: after.id, loaderId: after.loaderId, url: after.url }).toEqual({ id: before.id, loaderId: before.loaderId, url: bookingUrl });
    expect(await host.observeSourceReadiness(host.targetId)).toMatchObject({
      readyState: "complete", bodyPresent: true, mainDocumentCurrent: true, mainDocumentComplete: true,
      mainDocumentStatus: 200, mainReadPending: false, pendingReads: 0,
    });
    // This is an actual child-frame history event, not a fabricated main GET.
    await page.evaluate(() => { const iframe = document.createElement("iframe"); iframe.srcdoc = "<p>Child frame</p>"; document.body.append(iframe); });
    await expect.poll(() => page.frames().length).toBe(2);
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    await child.waitForLoadState("load");
    const childUrl = await child.evaluate(() => { history.pushState({}, "", location.href + "#foreign-history"); return location.href; });
    await expect.poll(() => historyEvents.some(event => event.frameId !== before.id && event.url === childUrl)).toBe(true);
    expect(page.url()).toBe(bookingUrl);
    expect((await cdp.send("Page.getFrameTree")).frameTree.frame).toMatchObject({ id: before.id, loaderId: before.loaderId, url: bookingUrl });
    expect(await host.observeSourceReadiness(host.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(await host.beforeAction(host.targetId, bookingUrl)).toMatchObject({ pageUrl: bookingUrl });
    await expect(host.beforeAction("foreign-target", bookingUrl)).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    expect(await host.assertGuardedTargets([host.targetId])).toBe(true);
    expect(requests).toEqual(["GET /"]); expect(acquired).toBe(leasesAfterGet); expect(host.diagnostics().admittedRequests).toBe(1);
    expect(foreignLookups).toBe(0); expect(deadlineAt.getTime()).toBe(originalDeadline);
    await cdp.detach();
    // The existing absolute deadline and cancellation still own this session;
    // neither history event opens another read or constructs a new host.
    controller.abort();
    await expect(host.observeSourceReadiness(host.targetId)).rejects.toThrow();
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
    expect(active).toBe(0); expect(acquired).toBe(released);
  } finally {
    controller.abort(); await attached?.close().catch(() => {}); await host?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);

it("admits an observed native anchor GET and drains its pending old script before an explicit witnessed document GET", async () => {
  const rootUrl = "https://owned-source.example/", linkedUrl = rootUrl + "public-page/", nextUrl = rootUrl + "public-calendar/";
  const controller = new AbortController(), deadlineAt = new Date(Date.now() + 60_000), originalDeadline = deadlineAt.getTime();
  let active = 0, acquired = 0, released = 0, pendingClosed = false, pendingStarted = false, foreignLookups = 0;
  const requests: string[] = [], families = new Set<string>();
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/pending-old.js") {
      pendingStarted = true; response.on("close", () => { pendingClosed = true; });
      response.writeHead(200, { "content-type": "application/javascript" }); response.flushHeaders(); return;
    }
    const body = request.url === "/" ? '<a id="next" href="/public-page/">Public times</a>' : request.url === "/public-page/"
      ? '<iframe style="width:300px;height:150px" src="/public-calendar/"></iframe>' : "<p>Public calendar</p>";
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: rootUrl, timeZone: "UTC", deadlineAt, signal: controller.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false };
        active++; acquired++; families.add(family);
        try { return { acquired: true, value: await work() }; } finally { active--; released++; families.delete(family); }
      },
      proxyDependencies: { resolveAddresses: async name => { if (name !== "owned-source.example") { foreignLookups++; throw Error("NOT_OWNED_FIXTURE"); } return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }), contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl);
    const page = attached.contexts().flatMap(context => context.pages())[0], cdp = await page.context().newCDPSession(page);
    await host.prepareNavigation(rootUrl); await page.goto(rootUrl, { waitUntil: "load" });
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    const originalFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame;
    await host.beforeAction(host.targetId, linkedUrl);
    await page.locator("#next").click(); await page.waitForURL(linkedUrl);
    await expect.poll(() => host!.observeSourceReadiness(host!.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    const linkedFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame;
    expect(linkedFrame.id).toBe(originalFrame.id); expect(linkedFrame.loaderId).not.toBe(originalFrame.loaderId);
    expect(requests).toEqual(["GET /", "GET /public-page/"]);
    await page.evaluate(() => { const script = document.createElement("script"); script.src = "/pending-old.js"; document.head.append(script); });
    await expect.poll(() => pendingStarted).toBe(true); expect(active).toBe(1);
    expect(await host.observeSourceReadiness(host.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentStatus: 200, pendingReads: 1 });
    const witness = await host.prepareFrameNavigation(host.targetId, nextUrl);
    expect(witness).toMatchObject({ pageUrl: linkedUrl, frames: [{ src: nextUrl, visible: true }] });
    await expect.poll(() => pendingClosed).toBe(true);
    expect(active).toBe(0); expect(acquired).toBe(released);
    expect(requests).toEqual(["GET /", "GET /public-page/", "GET /pending-old.js"]);
    expect(await host.observeSourceReadiness(host.targetId)).toMatchObject({ mainDocumentCurrent: false, mainDocumentComplete: false, mainDocumentStatus: null, pendingReads: 0 });
    await page.goto(nextUrl, { waitUntil: "load" });
    expect(await host.completeFrameNavigation(host.targetId, nextUrl)).toMatchObject({ pageUrl: linkedUrl, frameUrl: nextUrl, finalUrl: nextUrl, redirects: [] });
    expect(await host.observeSourceReadiness(host.targetId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    expect(requests).toEqual(["GET /", "GET /public-page/", "GET /pending-old.js", "GET /public-calendar/"]);
    expect(deadlineAt.getTime()).toBe(originalDeadline); expect(foreignLookups).toBe(0);
    await cdp.detach();
    expect(await host.close()).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
    expect(active).toBe(0); expect(acquired).toBe(released);
  } finally {
    controller.abort(); await attached?.close().catch(() => {}); await host?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);

async function ownedPopupFixture(workerCase: boolean, ackMode: AckMode, popupSpa = false) {
  popupAck.mode = ackMode; popupAck.armed = false; popupAck.pending = 0; popupAck.earlySuccessor = false; popupAck.forked = false; popupAck.oversized = false;
  popupAck.delayed = 0;
  const hosts = new Set(["owned-source.example", "owned-booking.example", "owned-final.example", "owned-assets.example"]);
  const cancellation = new AbortController(), families = new Set<string>();
  let active = 0, maxGlobal = 0, maxFamily = 0, acquired = 0, released = 0, unleased = 0;
  let successorBeforeParentRelease = false;
  let releasePopupQueue!: () => void, popupQueueHeld = false, popupQueueReleased = false;
  const popupQueueGate = new Promise<void>(resolve => { releasePopupQueue = () => { popupQueueReleased = true; resolve(); }; });
  const seen: string[] = [], concurrent: number[] = [];
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    const host = (request.headers.host ?? "").split(":")[0], path = request.url ?? "/";
    if (!hosts.has(host)) { response.writeHead(403).end(); return; }
    seen.push(host + path);
    if (host === "owned-final.example" && popupAck.pending > 0) popupAck.earlySuccessor = true;
    if (host === "owned-final.example" && families.has(requestFamilyForUrl("https://owned-booking.example/landing?keep=full"))) successorBeforeParentRelease = true;
    if (!families.has(requestFamilyForUrl("https://" + host + path))) unleased++;
    concurrent.push(active);
    if (host === "owned-booking.example") { response.writeHead(302, { location: "https://owned-final.example/calendar?keep=full" }).end(); return; }
    if (path === "/escape-worker.js") { response.writeHead(200, { "content-type": "application/javascript" }).end("fetch('/worker-escape')"); return; }
    const source = `<!doctype html><html><head><title>Owned Source</title></head><body>
      <a id="book" target="_blank" href="https://owned-booking.example/landing?keep=full"><span>Public times</span></a>
      <a id="slot" href="https://owned-source.example/ASP/appt_req.asp?Stime=10"><span>Public display</span></a>
      <div style="opacity:0"><a href="https://owned-booking.example/hidden">Hidden</a></div></body></html>`;
    const calendar = `<!doctype html><html><head><title>Owned Public Calendar</title></head><body>
      <script>fetch('/inline.json').then(r=>r.json()).then(()=>globalThis.inlineReadFinished=true)</script><p>Public display only</p></body></html>`;
    const json = path.endsWith(".json") || path.startsWith("/read") || path.startsWith("/slow");
    const body = host === "owned-source.example" && path === "/" ? source : json ? "{}" : calendar;
    setTimeout(() => { response.writeHead(200, { "content-type": json ? "application/json" : "text/html", "access-control-allow-origin": "*" }); response.end(body); }, path.startsWith("/slow") ? 2000 : path.startsWith("/read") ? 180 : 15);
  });
  let host: Awaited<ReturnType<typeof createGuardedStagehandSourceBrowser>> | undefined, attached: Browser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("OWNED_FIXTURE_UNAVAILABLE");
    host = await createGuardedStagehandSourceBrowser({ initialUrl: "https://owned-source.example/", timeZone: "UTC", deadlineAt: new Date(Date.now() + 60_000), signal: cancellation.signal }, {
      requestLease: async (family, work) => {
        if (active >= 2 || families.has(family)) return { acquired: false };
        active++; families.add(family); acquired++; maxGlobal = Math.max(maxGlobal, active); maxFamily = Math.max(maxFamily, 1);
        try { return { acquired: true, value: await work() }; }
        finally {
          if (popupSpa && !popupQueueReleased && family === requestFamilyForUrl("https://owned-final.example/calendar?keep=full")) {
            popupQueueHeld = true; await popupQueueGate;
          }
          if (ackMode === "DELAY" && family === requestFamilyForUrl("https://owned-booking.example/landing?keep=full"))
            await new Promise(resolve => setTimeout(resolve, 50));
          active--; families.delete(family); released++;
        }
      },
      proxyDependencies: { resolveAddresses: async name => { if (!hosts.has(name)) throw Error("NOT_OWNED_FIXTURE"); return [{ address: "93.184.216.34", family: 4 }]; }, connect: () => connect({ host: "127.0.0.1", port: address.port }) },
      launchBrowser: options => launchPublicReadBrowser({ ...options, args: [...options.args ?? [], "--ignore-certificate-errors"] }, { localCdp: true }),
      contextOptions: { ignoreHTTPSErrors: true },
    });
    attached = await chromium.connectOverCDP(host.cdpUrl);
    const pages = attached.contexts().flatMap(context => context.pages());
    expect(pages).toHaveLength(1);
    const page = pages[0], session = await page.context().newCDPSession(page);
    expect((await session.send("Target.getTargetInfo")).targetInfo.targetId).toBe(host.targetId); await session.detach();
    await host.prepareNavigation("https://owned-source.example/"); await page.goto("https://owned-source.example/", { waitUntil: "load" });
    expect(await host.assertGuardedTargets(["not-an-owned-target"])).toBe(false);
    expect(await page.evaluate(async endpoint => {
      try { await fetch(new URL("/json/version", endpoint.replace("ws:", "http:")).href); return false; } catch { return true; }
    }, host.cdpUrl)).toBe(true);
    expect(await page.evaluate(endpoint => new Promise<boolean>(resolve => {
      const socket = new WebSocket(endpoint), timer = setTimeout(() => { socket.close(); resolve(false); }, 1500);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
      socket.onerror = socket.onclose = () => { clearTimeout(timer); resolve(true); };
    }), host.cdpUrl)).toBe(true);
    await expect(host.beforeAction(host.targetId, "https://owned-booking.example/hidden")).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    await expect(host.beforeAction(host.targetId, "https://owned-source.example/ASP/appt_req.asp?Stime=10")).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
    // The target can hydrate after an earlier source collector saw no link.
    await page.evaluate(() => { const a = document.createElement("a"); a.href = "https://owned-booking.example/hydrated?exact=full"; a.textContent = "Public availability"; document.body.append(a); });
    const witness = await host.beforeAction(host.targetId, "https://owned-booking.example/hydrated?exact=full");
    expect(witness).toMatchObject({ kind: "NATIVE_VISIBLE_DOM", pageUrl: "https://owned-source.example/", links: [{ href: "https://owned-booking.example/hydrated?exact=full", visible: true }] });
    expect(witness?.documentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(witness!).sort()).toEqual(["documentHash", "kind", "links", "observedAt", "pageUrl"]);
    expect(Date.now() - Date.parse(witness!.observedAt)).toBeLessThan(5000);
    await host.beforeAction(host.targetId, "https://owned-booking.example/landing?keep=full");
    popupAck.armed = true;
    const popupPromise = page.waitForEvent("popup"), clicking = page.locator("#book span").click();
    void clicking.catch(() => {});
    const popup = await popupPromise;
    if (ackMode === "NEVER") {
      for (let attempt = 0; !popupAck.delayed && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(popupAck.delayed).toBeGreaterThan(0); cancellation.abort();
    }
    if (ackMode === "REJECT" || ackMode === "NEVER" || ackMode === "FORK" || ackMode === "OVERSIZE") {
      await clicking.catch(() => {}); // Guardian closure may also end Playwright's click wait.
      await expect(popup.waitForURL("https://owned-final.example/calendar?keep=full")).rejects.toThrow();
      const closed = await host.close();
      expect(closed).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
      expect(seen.some(value => value.startsWith("owned-final.example"))).toBe(false);
      if (ackMode === "FORK") expect(popupAck.forked).toBe(true);
      if (ackMode === "OVERSIZE") expect(popupAck.oversized).toBe(true);
      expect(unleased).toBe(0); expect(active).toBe(0); expect(acquired).toBe(released);
      return;
    }
    await clicking;
    await popup.waitForURL("https://owned-final.example/calendar?keep=full");
    if (!popupSpa) await popup.waitForFunction(() => (globalThis as unknown as { inlineReadFinished?: boolean }).inlineReadFinished === true);
    const ids = await Promise.all(page.context().pages().map(async current => { const cdp = await current.context().newCDPSession(current); const value = await cdp.send("Target.getTargetInfo"); await cdp.detach(); return value.targetInfo.targetId; }));
    expect(await host.assertGuardedTargets(ids)).toBe(true);
    const popupCdp = await popup.context().newCDPSession(popup), popupId = (await popupCdp.send("Target.getTargetInfo")).targetInfo.targetId;
    if (!popupSpa) await expect.poll(() => host!.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    let popupPageUrl = "https://owned-final.example/calendar?keep=full";
    if (popupSpa) {
      await expect.poll(() => popupQueueHeld).toBe(true);
      // This native original-URL pair is retained while its lease is still held;
      // it must remain inert across SPA until the original queue really drains.
      expect(await host.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: false, mainDocumentComplete: false, mainDocumentStatus: null });
      const documentReads = () => seen.filter(value => value.startsWith("owned-final.example/") && !value.endsWith(".json")).length;
      const before = (await popupCdp.send("Page.getFrameTree")).frameTree.frame, requestsBefore = documentReads();
      const historyEvents: Array<{ frameId: string; url: string }> = [];
      await popupCdp.send("Page.enable");
      popupCdp.on("Page.navigatedWithinDocument", event => historyEvents.push(event));
      popupPageUrl = "https://owned-final.example/public/calendar?date=2026-11-01#times";
      await popup.evaluate(url => { history.pushState({}, "", url); }, popupPageUrl);
      await expect.poll(() => historyEvents.some(event => event.frameId === before.id && event.url === popupPageUrl)).toBe(true);
      expect(await host.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: false, mainDocumentComplete: false, mainDocumentStatus: null });
      releasePopupQueue();
      await popup.waitForFunction(() => (globalThis as unknown as { inlineReadFinished?: boolean }).inlineReadFinished === true);
      await expect.poll(() => host!.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
      expect((await popupCdp.send("Page.getFrameTree")).frameTree.frame).toMatchObject({ id: before.id, loaderId: before.loaderId, url: popupPageUrl.split("#", 1)[0] });
      expect(popup.url()).toBe(popupPageUrl);
      expect(documentReads()).toBe(requestsBefore);
      // Keep the separate existing frame-source proof's exact URL contract.
      popupPageUrl = popupPageUrl.split("#", 1)[0];
      await popup.evaluate(url => { history.replaceState({}, "", url); }, popupPageUrl);
      await expect.poll(() => host!.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentStatus: 200 });
      await popup.evaluate(() => { const iframe = document.createElement("iframe"); iframe.srcdoc = "<p>Popup child</p>"; document.body.append(iframe); });
      await expect.poll(() => popup.frames().length).toBe(2);
      const child = popup.frames().find(frame => frame !== popup.mainFrame())!; await child.waitForLoadState("load");
      const childUrl = await child.evaluate(() => { history.pushState({}, "", location.href + "#foreign-history"); return location.href; });
      await expect.poll(() => historyEvents.some(event => event.frameId !== before.id && event.url === childUrl)).toBe(true);
      expect((await host.observeFrameSources(popupId)).pageUrl).toBe(popupPageUrl);
      await expect(host.observeSourceReadiness("foreign-owned-target")).rejects.toThrow();
      expect(await host.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentStatus: 200 });
      expect(documentReads()).toBe(requestsBefore);
    }
    await popupCdp.detach();
    const nextPopupUrl = "https://owned-final.example/second-calendar?keep=full";
    await popup.evaluate(url => { const iframe = document.createElement("iframe"); iframe.src = url; iframe.style.cssText = "width:300px;height:150px"; document.body.append(iframe); }, nextPopupUrl);
    const beforeExplicit = seen.length;
    expect(await host.prepareFrameNavigation(popupId, nextPopupUrl)).toMatchObject({ pageUrl: popupPageUrl, frames: [{ src: nextPopupUrl, visible: true }] });
    // The old bootstrap GET cannot attest readiness between the drained
    // boundary and the next actual main-document GET, even at its old URL.
    expect(await host.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: false, mainDocumentComplete: false, mainDocumentStatus: null, pendingReads: 0 });
    expect(seen.length).toBe(beforeExplicit);
    await popup.goto(nextPopupUrl, { waitUntil: "load" });
    expect(await host.completeFrameNavigation(popupId, nextPopupUrl)).toMatchObject({ finalUrl: nextPopupUrl, redirects: [] });
    await expect.poll(() => host!.observeSourceReadiness(popupId)).toMatchObject({ mainDocumentCurrent: true, mainDocumentComplete: true, mainDocumentStatus: 200, pendingReads: 0 });
    const beforeDenied = seen.length;
    const deniedPopupPromise = page.waitForEvent("popup"); await page.locator("#book span").click(); const deniedPopup = await deniedPopupPromise;
    await deniedPopup.waitForLoadState("domcontentloaded").catch(() => {});
    expect(seen.length).toBe(beforeDenied); await deniedPopup.close();
    await page.evaluate(async () => { await Promise.allSettled([
      fetch("https://owned-source.example/forbidden-post", { method: "POST", body: "private=value" }),
      fetch("https://owned-source.example/ASP/appt_req.asp?Stime=10"),
      fetch("http://127.0.0.1:9/private"),
    ]); });
    expect(seen.slice(beforeDenied)).toEqual([]);
    await page.evaluate(async () => { await Promise.all([
      "/read-one", "/read-two", "/read-three", "https://owned-assets.example/read-four",
    ].map(async url => { if (!(await fetch(url)).ok) throw Error("OWNED_READ_FAILED"); })); });
    expect(seen.filter(value => value.startsWith("owned-source.example/read"))).toHaveLength(3);
    expect(maxGlobal).toBe(2); expect(maxFamily).toBe(1); expect(concurrent).toContain(2);
    if (workerCase) {
      expect(await page.evaluate(() => ["Worker", "SharedWorker"].map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        return Boolean(descriptor && descriptor.value === undefined && descriptor.configurable === false && descriptor.writable === false);
      }))).toEqual([true, true]);
      expect(host.diagnostics().deniedWorkerTargets).toBe(0);
      expect(seen.some(value => value.endsWith("/worker-escape"))).toBe(false);
    } else {
      const pending = page.evaluate(async () => { await Promise.allSettled([fetch("/slow-one"), fetch("/slow-two"), fetch("/slow-three")]); });
      void pending.catch(() => {});
      for (let attempt = 0; !active && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(active, JSON.stringify(host.diagnostics())).toBeGreaterThan(0);
    }
    cancellation.abort();
    const closed = await host.close();
    expect(closed).toMatchObject({ browserClosed: true, providerRequestsDrained: true });
    if (closed.ownedCdpFailure) {
      expect(closed.ownedCdpFailure.pendingRequests).toBeLessThanOrEqual(256);
      expect(JSON.stringify(closed.ownedCdpFailure)).not.toMatch(/targetId|sessionId|contextId|https?:|message|stack/u);
    }
    expect(unleased).toBe(0); expect(active).toBe(0); expect(acquired).toBe(released);
    if (ackMode === "DELAY") {
      expect(popupAck.delayed).toBeGreaterThan(0); expect(popupAck.earlySuccessor).toBe(false); expect(successorBeforeParentRelease).toBe(false);
    }
  } finally {
    releasePopupQueue();
    cancellation.abort(); await attached?.close().catch(() => {}); await host?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    popupAck.mode = "NORMAL"; popupAck.armed = false;
  }
}
it.each([false, true])("guards isolated popup/inline reads and per-family concurrency; worker-denial mode %s",
  workerCase => ownedPopupFixture(workerCase, workerCase ? "NORMAL" : "DELAY"), 90_000);
it("retains only the exact completed startup popup GET across native same-loader SPA history", () => ownedPopupFixture(false, "NORMAL", true), 90_000);
it.each(["REJECT", "NEVER", "FORK", "OVERSIZE"] as const)("denies the paused successor and drains when its parent ACK is %s",
  ackMode => ownedPopupFixture(false, ackMode), 90_000);
it("bounds an absent continuation ACK and preserves cancellation or failed ACK without dispatch", async () => {
  const dispatch = vi.fn(), error = Error("OWNED_ACK_REJECTED"), abort = new AbortController();
  await expect(awaitStagehandPopupContinuation(Promise.reject(error), abort.signal, Date.now() + 1000).then(dispatch)).rejects.toBe(error);
  await expect(awaitStagehandPopupContinuation(new Promise(() => {}), abort.signal, Date.now() + 20).then(dispatch)).rejects.toThrow("STAGEHAND_GUARDED_SOURCE_REJECTED");
  const pending = awaitStagehandPopupContinuation(new Promise(() => {}), abort.signal, Date.now() + 1000).then(dispatch);
  abort.abort(); await expect(pending).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled();
  await expect(awaitStagehandPopupContinuation(Promise.reject(error), abort.signal, Date.now() + 1000).then(dispatch)).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, 0)); expect(dispatch).not.toHaveBeenCalled();
});
