// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { expect, it } from "vitest";
import { canonicalStagehandHostEntry, createGuardedStagehandSourceBrowser, stagehandSourceBrowserMode } from "./stagehand-source-browser";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { requestFamilyForUrl } from "./request-family";

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

it.each([false, true])("guards isolated popup/inline reads and per-family concurrency; worker-denial mode %s", async workerCase => {
  const hosts = new Set(["owned-source.example", "owned-booking.example", "owned-final.example", "owned-assets.example"]);
  const cancellation = new AbortController(), families = new Set<string>();
  let active = 0, maxGlobal = 0, maxFamily = 0, acquired = 0, released = 0, unleased = 0;
  const seen: string[] = [], concurrent: number[] = [];
  const server = createServer({ key: certificate("fixtureKey"), cert: certificate("fixtureCertificate") }, (request, response) => {
    const host = (request.headers.host ?? "").split(":")[0], path = request.url ?? "/";
    if (!hosts.has(host)) { response.writeHead(403).end(); return; }
    seen.push(host + path);
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
        finally { active--; families.delete(family); released++; }
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
    await host.beforeAction(host.targetId, "https://owned-booking.example/landing?keep=full");
    const popupPromise = page.waitForEvent("popup"); await page.locator("#book span").click(); const popup = await popupPromise;
    await popup.waitForURL("https://owned-final.example/calendar?keep=full");
    await popup.waitForFunction(() => (globalThis as unknown as { inlineReadFinished?: boolean }).inlineReadFinished === true);
    const ids = await Promise.all(page.context().pages().map(async current => { const cdp = await current.context().newCDPSession(current); const value = await cdp.send("Target.getTargetInfo"); await cdp.detach(); return value.targetInfo.targetId; }));
    expect(await host.assertGuardedTargets(ids)).toBe(true);
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
      await page.evaluate(() => { new Worker("/escape-worker.js"); new SharedWorker("/escape-worker.js"); });
      for (let attempt = 0; host.diagnostics().deniedWorkerTargets < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(host.diagnostics().deniedWorkerTargets).toBeGreaterThanOrEqual(2);
      expect(seen.some(value => value.endsWith("/worker-escape"))).toBe(false);
    } else {
      const pending = page.evaluate(async () => { await Promise.allSettled([fetch("/slow-one"), fetch("/slow-two"), fetch("/slow-three")]); });
      void pending.catch(() => {});
      for (let attempt = 0; !active && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(active, JSON.stringify(host.diagnostics())).toBeGreaterThan(0);
    }
    cancellation.abort();
    expect(await host.close()).toEqual({ browserClosed: true, providerRequestsDrained: true });
    expect(unleased).toBe(0); expect(active).toBe(0); expect(acquired).toBe(released);
  } finally {
    cancellation.abort(); await attached?.close().catch(() => {}); await host?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90_000);
