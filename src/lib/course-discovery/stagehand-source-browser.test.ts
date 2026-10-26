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

async function ownedPopupFixture(workerCase: boolean, ackMode: AckMode) {
  popupAck.mode = ackMode; popupAck.armed = false; popupAck.pending = 0; popupAck.earlySuccessor = false; popupAck.forked = false; popupAck.oversized = false;
  popupAck.delayed = 0;
  const hosts = new Set(["owned-source.example", "owned-booking.example", "owned-final.example", "owned-assets.example"]);
  const cancellation = new AbortController(), families = new Set<string>();
  let active = 0, maxGlobal = 0, maxFamily = 0, acquired = 0, released = 0, unleased = 0;
  let successorBeforeParentRelease = false;
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
    cancellation.abort(); await attached?.close().catch(() => {}); await host?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    popupAck.mode = "NORMAL"; popupAck.armed = false;
  }
}
it.each([false, true])("guards isolated popup/inline reads and per-family concurrency; worker-denial mode %s",
  workerCase => ownedPopupFixture(workerCase, workerCase ? "NORMAL" : "DELAY"), 90_000);
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
