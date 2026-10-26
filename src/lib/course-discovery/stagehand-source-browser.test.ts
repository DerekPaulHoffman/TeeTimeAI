// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { awaitStagehandPopupContinuation, canonicalStagehandHostEntry, createGuardedStagehandSourceBrowser, stagehandSourceBrowserMode } from "./stagehand-source-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { requestFamilyForUrl } from "./request-family";

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
