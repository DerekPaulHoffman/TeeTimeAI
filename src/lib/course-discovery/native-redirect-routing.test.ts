// @vitest-environment node
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Page, type Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { installNativeRedirectRouting, isNativeReadSupersededFailure, isNativeReadTerminalFailure, type NativeReadRoute, type NativeRequestDiagnostic } from "./native-redirect-routing";
import { continueNativeBrowserRead, isObservedNativeRedirect, isObservedNativeRedirectTarget } from "./native-public-browser";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function installed(maxRequests?: number, signal?: AbortSignal) {
  const events = new Map<string, (event: unknown) => void>(), routes: NativeReadRoute[] = [];
  const close = vi.fn(async () => {}), detach = vi.fn(async () => {}), failures: string[] = [], subframes: object[] = [], rejections: NativeRequestDiagnostic[] = [];
  const main = { page: () => page };
  const cdp = { on: (name: string, listener: (event: unknown) => void) => { events.set(name, listener); },
    send: vi.fn(async (name: string, value?: { requestId?: string }) => name === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } }
      : name === "Fetch.getResponseBody" ? { body: `body-${value?.requestId}`, base64Encoded: false } : {}), detach };
  const page = { context: () => ({ newCDPSession: async () => cdp }), mainFrame: () => main, close } as unknown as Page;
  const handler = vi.fn(async (route: NativeReadRoute) => { routes.push(route); });
  const guard = await installNativeRedirectRouting(page, handler, { timeoutMs: 100, maxRequests, signal,
    onFailure: code => failures.push(code), onSubframeBlocked: request => subframes.push(request), onRequestRejected: request => rejections.push(request) });
  const request = (id: string, values: object = {}) => events.get("Fetch.requestPaused")!({ requestId: id, networkId: `network-${id}`,
    frameId: "main", resourceType: "XHR", request: { url: "https://example.org/data", method: "GET", headers: {} }, ...values });
  const response = (id: string, values: object = {}) => request(id, { responseStatusCode: 200, responseHeaders: [], ...values });
  return { guard, events, close, failures, main, cdp, subframes, rejections, handler, routes, request, response };
}
function playwrightRoute(test: Awaited<ReturnType<typeof installed>>) {
  return { request: () => ({ frame: () => test.main }), continue: vi.fn(async () => {}), abort: vi.fn(async () => {}), fulfill: vi.fn() } as unknown as Route;
}

describe("native document-generation retirement", () => {
  const identity = (test: Awaited<ReturnType<typeof installed>>, id: string, loaderId: string, kind = "XHR", url = "https://example.org/data") =>
    test.events.get("Network.requestWillBeSent")!({ requestId: `network-${id}`, loaderId, frameId: "main", type: kind, request: { url, method: "GET" } });
  const startDocument = async (test: Awaited<ReturnType<typeof installed>>, id = "document", loader = "loader-one") => {
    await test.guard.beginDocumentNavigation(test.main as never);
    identity(test, id, loader, "Document"); test.request(id, { resourceType: "Document" });
  };

  it("waits for exact old-network terminal ACK and handler/lease drain; queued/late old reads never dispatch or become evidence", async () => {
    const test = await installed(), session = new AbortController(), stop = vi.fn(async () => {});
    let active = 0, released = 0; const completed: string[] = [], errors: unknown[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; try { return { acquired: true as const, value: await work() }; } finally { active--; released++; }
    }, session.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { const value = await queue.run("example.org", () => continueNativeBrowserRead(route, session.signal, 1000, stop), route.request().signal); completed.push(value.body.toString()); }
      catch (error) { errors.push(error); if (!isNativeReadSupersededFailure(error)) throw error; }
    });
    try {
      await startDocument(test); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(completed).toEqual(["body-document"]));
      identity(test, "active", "loader-one", "Script"); test.request("active", { resourceType: "Script" });
      identity(test, "queued", "loader-one", "Script"); test.request("queued", { resourceType: "Script" });
      await vi.waitFor(() => expect(active).toBe(1));
      let boundaryComplete = false;
      const boundary = test.guard.beginDocumentNavigation(test.main as never).then(() => { boundaryComplete = true; });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "queued")).toBe(true));
      expect(boundaryComplete).toBe(false); expect(active).toBe(1); expect(released).toBe(1);
      test.events.get("Network.loadingFailed")!({ requestId: "network-active" });
      await boundary;
      expect(active).toBe(0); expect(errors).toHaveLength(2); expect(errors.every(isNativeReadSupersededFailure)).toBe(true);
      // An old loader's late request/response is denied, never offered to the shared handler.
      identity(test, "late", "loader-one", "Script"); test.request("late", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.response("late", { resourceType: "Script", responseStatusCode: undefined, responseErrorReason: "Failed" });
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.routes).toHaveLength(4)); test.response("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(completed).toEqual(["body-document", "body-next"]));
      const dispatches = test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest").map(([, value]) => value?.requestId);
      expect(dispatches).toEqual(["document", "active", "next"]); expect(stop).not.toHaveBeenCalled();
      expect(test.failures).toEqual([]); expect(test.guard.firstFatal).toBeUndefined();
    } finally { session.abort(); queue.dispose(); await test.guard.close(); }
  });

  it("never treats stopLoading ACK as terminal proof for an active read", async () => {
    const test = await installed();
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue(); });
    try {
      await startDocument(test); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "held", "loader-one", "Script"); test.request("held", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "held")).toBe(true));
      await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow("NATIVE_REDIRECT_DRAIN_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce(); expect(test.failures).toContain("NATIVE_REDIRECT_DRAIN_TIMEOUT");
    } finally { await test.guard.close(); }
  });

  it.each(["unknown loader", "wrong URL", "wrong method", "wrong kind"])("fails closed on %s, even for an otherwise public read", async mismatch => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.events.get("Network.requestWillBeSent")!({ requestId: "network-other", loaderId: mismatch === "unknown loader" ? "unknown" : "loader-one",
        frameId: "main", type: mismatch === "wrong kind" ? "Script" : "XHR", request: { url: mismatch === "wrong URL" ? "https://example.org/other" : "https://example.org/data", method: mismatch === "wrong method" ? "POST" : "GET" } });
      test.request("other"); await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_LOADER_MISMATCH"));
      expect(test.routes).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it("retains the cumulative request cap across boundaries", async () => {
    const test = await installed(2);
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" });
      await test.routes[1].continue(); test.response("next", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "over", "loader-two"); test.request("over");
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RECORD_LIMIT"));
      expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it("still closes for an uncompleted response on the current successor document", async () => {
    const test = await installed();
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      await test.guard.beginDocumentNavigation(test.main as never);
      identity(test, "next", "loader-two", "Document"); test.request("next", { resourceType: "Document" }); await test.routes[1].continue();
      await expect(test.routes[1].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT", resourceType: "document" });
      expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("closes if the exact paused-read cancellation %s cannot be acknowledged", async mode => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    try {
      await startDocument(test); await test.routes[0].continue(); test.response("document", { resourceType: "Document" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      identity(test, "queued", "loader-one"); test.request("queued");
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" ? mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("offline abort rejection")) : send(name, value));
      await expect(test.guard.beginDocumentNavigation(test.main as never)).rejects.toThrow(mode === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "offline abort rejection");
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueRequest" && value?.requestId === "queued")).toBe(false);
    } finally { await test.guard.close(); }
  });
});

const nativeChromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(nativeChromePath))("offline Chrome document ownership", () => {
  it("terminates an old real document's active/queued assets before the next document uses the same lease lane", async () => {
    const reads: string[] = [], closed: string[] = [], bodies: string[] = [], failures: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url!; reads.push(path);
      if (path === "/old.js" || path === "/queued.js") { request.on("close", () => closed.push(path)); return; }
      response.setHeader("Content-Type", "text/html");
      response.end(path === "/" ? '<h1>Public old golf document</h1><a href="/next">Book tee times</a><script defer src="/old.js"></script><script defer src="/queued.js"></script>' : '<h1>Public successor golf document</h1>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: nativeChromePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage(), session = new AbortController();
    let active = 0, maximum = 0, releases = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; releases++; }
    }, session.signal);
    // Only this isolated local fixture admits loopback; production still runs
    // the unchanged public URL/DNS/provider checks in its shared route handler.
    const guard = await installNativeRedirectRouting(page, async route => {
      try {
        const reply = await queue.run("fixture", () => continueNativeBrowserRead(route, session.signal, 10_000), route.request().signal);
        if (!route.request().signal?.aborted) bodies.push(reply.body.toString());
      } catch (error) { if (!isNativeReadSupersededFailure(error)) throw error; }
    }, { timeoutMs: 5_000, maxRequests: 16, onFailure: value => failures.push(value) });
    try {
      await guard.beginDocumentNavigation(page.mainFrame()); await page.goto(`${url}/`, { waitUntil: "commit" });
      await vi.waitFor(() => { expect(reads).toContain("/old.js"); expect(guard.pendingReads).toBeGreaterThanOrEqual(2); });
      expect(reads).not.toContain("/queued.js");
      await guard.beginDocumentNavigation(page.mainFrame());
      expect(active).toBe(0); expect(releases).toBeGreaterThanOrEqual(2);
      await vi.waitFor(() => expect(closed).toContain("/old.js"));
      await page.goto(`${url}/next`, { waitUntil: "commit" });
      await expect(page.locator("h1").innerText()).resolves.toBe("Public successor golf document");
      await vi.waitFor(() => expect(guard.pendingReads).toBe(0));
      expect(bodies.some(body => body.includes("Public successor"))).toBe(true);
      expect(reads).not.toContain("/queued.js"); expect(failures).toEqual([]); expect(maximum).toBe(1);
      expect(guard.firstFatal).toBeUndefined();
    } finally {
      session.abort(); await guard.close(); queue.dispose(); await browser.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);
});

describe("native exact request and response ownership", () => {
  it("gives two identical reads distinct exact response/body identities without Playwright matching", async () => {
    const test = await installed();
    try {
      test.request("one"); test.request("two"); expect(test.routes).toHaveLength(2);
      await Promise.all(test.routes.map(route => route.continue()));
      const responses = test.routes.map(route => route.request().response());
      test.response("two"); test.response("one");
      expect(await Promise.all(responses.map(async promise => (await (await promise)?.body())?.toString()))).toEqual(["body-one", "body-two"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest").map(([, value]) => value?.requestId)).toEqual(["one", "two"]);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("preserves exact POST bodies and all Chrome request headers on independent records", async () => {
    const test = await installed();
    try {
      for (const date of ["2026-10-23", "2026-10-24"]) test.request(date, { request: { url: "https://example.org/data", method: "POST",
        headers: { "Next-Action": date, Cookie: `anonymous=${date}`, "X-Requested-With": "XMLHttpRequest" }, hasPostData: true, postData: JSON.stringify({ date }) } });
      expect(test.routes.map(route => JSON.parse(route.request().postData()!).date)).toEqual(["2026-10-23", "2026-10-24"]);
      expect(test.routes[1].request().headers()).toMatchObject({ "next-action": "2026-10-24", cookie: "anonymous=2026-10-24", "x-requested-with": "XMLHttpRequest" });
      await test.routes[0].abort(); await test.routes[1].continue();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["Document", "Script", "XHR", "Fetch", "Other"])("retains exact Chrome resource kind %s", async kind => {
    const test = await installed();
    try { test.request(kind, { resourceType: kind }); expect(test.routes[0].request().resourceType()).toBe(kind.toLowerCase()); }
    finally { await test.guard.close(); }
  });

  it("holds completion and pending reads through body capture and successful unchanged response release", async () => {
    const test = await installed(), body = deferred<{ body: string; base64Encoded: boolean }>(), released = deferred<object>();
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? body.promise : name === "Fetch.continueResponse" ? released.promise : send(name, value));
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue(); await route.request().response(); });
    try {
      test.request("one"); expect(test.guard.pendingReads).toBe(1);
      await vi.waitFor(() => expect(test.routes).toHaveLength(1));
      let complete = false; const response = test.routes[0].request().response().then(value => { complete = true; return value; });
      test.response("one"); expect(test.guard.pendingReads).toBe(2);
      body.resolve({ body: "source bytes", base64Encoded: false });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
      expect(complete).toBe(false); expect(test.guard.pendingReads).toBe(2);
      released.resolve({}); const value = await response;
      expect(await value?.finished()).toBeNull(); expect((await value?.body())?.toString()).toBe("source bytes");
      expect(test.cdp.send.mock.calls.find(([name]) => name === "Fetch.continueResponse")?.[1]).toEqual({ requestId: "one" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
    } finally { await test.guard.close(); }
  });

  it("binds response to the exact permitted canonical continuation while preserving original provenance", async () => {
    const test = await installed(), original = "https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-23&api_key=public",
      continued = "https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-23";
    try {
      test.request("one", { request: { url: original, method: "GET", headers: {} } });
      await test.routes[0].continue({ url: continued }); const response = test.routes[0].request().response();
      test.response("one", { request: { url: continued, method: "GET", headers: {} } });
      expect((await response)?.url()).toBe(continued); expect(test.routes[0].request().url()).toBe(original);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "method", "frame", "unknown", "unadmitted"])("rejects mismatched response %s", async kind => {
    const test = await installed();
    try {
      test.request("one"); if (kind !== "unadmitted") await test.routes[0].continue();
      const values = kind === "network" ? { networkId: "other" } : kind === "url" ? { request: { url: "https://example.org/other", method: "GET", headers: {} } }
        : kind === "method" ? { request: { url: "https://example.org/data", method: "POST", headers: {} } }
          : kind === "frame" ? { frameId: "child" } : {};
      test.response(kind === "unknown" ? "other" : "one", values);
      const codes: Record<string, string> = { network: "NETWORK_MISMATCH", url: "URL_MISMATCH", method: "METHOD_MISMATCH", frame: "FRAME_MISMATCH",
        unknown: "UNKNOWN", unadmitted: "UNADMITTED" };
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${codes[kind]}`));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.getResponseBody")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each([false, true])("settles only the exact failed optional read while independent document/data evidence completes (prior loadingFailed: %s)", async loadingFailed => {
    const test = await installed(), results: string[] = [];
    test.handler.mockImplementation(async route => { test.routes.push(route); await route.continue();
      const response = await route.request().response(); results.push((await response?.body())?.toString() ?? "missing"); });
    try {
      test.request("document", { resourceType: "Document" }); test.request("optional", { resourceType: "Script" }); test.request("availability");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(3));
      if (loadingFailed) test.events.get("Network.loadingFailed")!({ requestId: "network-optional" });
      test.response("optional", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      test.response("document"); test.response("availability");
      await vi.waitFor(() => { expect(results.sort()).toEqual(["body-availability", "body-document"]); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, values]) => values?.requestId)).toEqual(["optional"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody").map(([, values]) => values?.requestId)).not.toContain("optional");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueResponse").map(([, values]) => values?.requestId)).not.toContain("optional");
    } finally { await test.guard.close(); }
  });

  it("keeps same-host queued peers alive when Chrome terminates one read before its provider lane opens", async () => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let active = 0, maxActive = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maxActive = Math.max(maxActive, active);
      try { return { acquired: true as const, value: await work() }; }
      finally { active--; }
    }, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try {
        const value = await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop));
        completed.push(value.body.toString());
      } catch (error) {
        errors.push(error);
        // This is the production discovery handler's cleanup path. It must not
        // overwrite the controller's original terminal Network failure.
        await route.abort();
      }
    });
    try {
      test.request("holding", { resourceType: "Document" });
      test.request("failed", { resourceType: "Script" });
      test.request("later");
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      expect(test.guard.pendingReads).toBe(3);
      test.response("holding");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["holding", "later"]));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      test.response("failed", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      test.response("later");
      await vi.waitFor(() => {
        expect(test.guard.pendingReads).toBe(0);
        expect(errors.map(error => (error as Error).message)).toEqual(["NATIVE_REDIRECT_NETWORK_FAILED"]);
        expect(completed).toEqual(["body-holding", "body-later"]);
      });
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(maxActive).toBe(1); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")
        .map(([, value]) => value?.requestId)).not.toContain("failed");
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("does not cancel host peers for an exact terminal response failure after dispatch", async () => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("optional", { resourceType: "Script" });
      test.response("optional", { responseStatusCode: undefined, responseErrorReason: "Failed" });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "method", "frame"])("still rejects a queued terminal callback with wrong %s identity", async kind => {
    const test = await installed();
    try {
      test.request("queued");
      test.events.get("Network.loadingFailed")!({ requestId: "network-queued" });
      const values = kind === "network" ? { networkId: "foreign" } : kind === "frame" ? { frameId: "foreign" }
        : { request: { url: kind === "url" ? "https://example.org/foreign" : "https://example.org/data",
          method: kind === "method" ? "POST" : "GET", headers: {} } };
      test.response("queued", { responseStatusCode: undefined, responseErrorReason: "Failed", ...values });
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${kind.toUpperCase()}_MISMATCH`));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest" || name === "Fetch.getResponseBody" || name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("preserves a terminal read failure while its continuation command is pending and then %ss", async kind => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let rejectCommand!: (error: Error) => void;
    const command = new Promise<object>((_resolve, reject) => { rejectCommand = reject; });
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" && value?.requestId === "failed" ? command : send(name, value));
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { completed.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString()); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("failed", { resourceType: "Script" }); test.request("later");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      if (kind === "reject") rejectCommand(new Error("CDP_COMMAND_REJECTED"));
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["failed", "later"]));
      test.response("later");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(completed).toEqual(["body-later"]); });
      // Leave the command hanging past its old timer. The trusted terminal
      // attestation must clear that timer instead of closing healthy peers.
      if (kind === "hang") await new Promise(resolve => setTimeout(resolve, 125));
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")
        .map(([, value]) => value?.requestId)).toEqual(["later"]);
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it("still closes a hanging continuation when no exact terminal read is attested", async () => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueRequest" ? new Promise(() => {}) : send(name, value));
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); }
    });
    try {
      test.request("hanging");
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(false);
      // response() is observed before dispatch, so its unchanged bounded
      // response timer wins before the continuation-command timer here.
      expect(stop).toHaveBeenCalledOnce(); expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
    } finally { await test.guard.close(); }
  });

  it.each([
    ["Fetch.getResponseBody", "reject"], ["Fetch.getResponseBody", "hang"], ["Fetch.getResponseBody", "resolve"],
    ["Fetch.continueResponse", "reject"], ["Fetch.continueResponse", "hang"], ["Fetch.continueResponse", "resolve"],
  ])("drains an exact terminal read during %s while its command later %ss without affecting queued peers", async (phase, kind) => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {});
    const completed: string[] = [], errors: unknown[] = [];
    let rejectCommand!: (error: Error) => void, resolveCommand!: (value: object) => void;
    const command = new Promise<object>((resolve, reject) => { rejectCommand = reject; resolveCommand = resolve; });
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === phase && value?.requestId === "failed" ? command : send(name, value));
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { completed.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString()); }
      catch (error) { errors.push(error); await route.abort(); }
    });
    try {
      test.request("failed", { resourceType: "Script" }); test.request("later");
      test.response("failed");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name, value]) => name === phase && value?.requestId === "failed")).toBe(true));
      test.events.get("Network.loadingFailed")!({ requestId: "network-failed" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["failed", "later"]));
      test.response("later");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(completed).toEqual(["body-later"]); });
      // A late protocol rejection remains observed, even after the failed read
      // released its provider lane. A hang may not leave a stale close timer.
      if (kind === "reject") { rejectCommand(new Error("CDP_COMMAND_REJECTED")); await new Promise<void>(resolve => setImmediate(resolve)); }
      else if (kind === "resolve") {
        resolveCommand(phase === "Fetch.getResponseBody" ? { body: "late body is not evidence", base64Encoded: false } : {});
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      else await new Promise(resolve => setTimeout(resolve, 125));
      expect(completed).toEqual(["body-later"]);
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(true);
      expect((errors[0] as Error).message).toBe("NATIVE_REDIRECT_NETWORK_FAILED");
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      if (phase === "Fetch.getResponseBody") expect(test.cdp.send.mock.calls.some(([name, value]) => name === "Fetch.continueResponse" && value?.requestId === "failed")).toBe(false);
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each([
    ["Fetch.getResponseBody", "reject"], ["Fetch.getResponseBody", "hang"],
    ["Fetch.continueResponse", "reject"], ["Fetch.continueResponse", "hang"],
  ])("keeps fail-closed cleanup for an unattested %s command that %ss", async (phase, kind) => {
    const test = await installed(), stop = vi.fn(async () => {}), errors: unknown[] = [];
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === phase
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("CDP_COMMAND_REJECTED")) : send(name, value));
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      try { await continueNativeBrowserRead(route, new AbortController().signal, 1000, stop); }
      catch (error) { errors.push(error); }
    });
    try {
      test.request("failed"); test.response("failed");
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(errors).toHaveLength(1); expect(isNativeReadTerminalFailure(errors[0])).toBe(false);
      expect(stop).toHaveBeenCalledOnce(); expect(test.failures.length).toBeGreaterThan(0);
    } finally { await test.guard.close(); }
  });

  it("never creates response evidence for failed root navigation", async () => {
    const test = await installed();
    try {
      test.request("root", { resourceType: "Document" }); await test.routes[0].continue();
      const response = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_NETWORK_FAILED");
      test.response("root", { responseStatusCode: undefined, responseErrorReason: "Failed" }); await response;
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
      expect(test.failures).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["network", "url", "frame", "unknown"])("still closes failed responses with wrong %s identity", async kind => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      test.response(kind === "unknown" ? "other" : "one", { responseStatusCode: undefined, responseErrorReason: "Failed",
        ...(kind === "network" ? { networkId: "other" } : kind === "url" ? { request: { url: "https://example.org/other", method: "GET", headers: {} } }
          : kind === "frame" ? { frameId: "child" } : {}) });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.failures.some(code => code.startsWith("NATIVE_REDIRECT_RESPONSE_"))).toBe(true);
    } finally { await test.guard.close(); }
  });

  it.each(["failed", "duplicate", "status"])("diagnoses rejected response state %s without granting response authority", async kind => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      if (kind === "failed") test.events.get("Network.loadingFailed")!({ requestId: "network-one" });
      if (kind === "duplicate") { test.response("one"); await test.routes[0].request().response(); }
      const previousBodyReads = test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody").length;
      test.response("one", kind === "status" ? { responseStatusCode: 0 } : {});
      const suffix = kind === "failed" ? "PRIOR_FAILURE" : kind === "duplicate" ? "DUPLICATE" : "STATUS_INVALID";
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_RESPONSE_${suffix}`));
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.getResponseBody")).toHaveLength(previousBodyReads);
    } finally { await test.guard.close(); }
  });

  it.each([204, 205, 300, 302, 304, 305])("completes bodyless HTTP%s from response stage without Network fallback", async status => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue(); const promise = test.routes[0].request().response();
      test.response("one", { responseStatusCode: status }); const response = await promise;
      expect(response?.status()).toBe(status); expect(await response?.body()).toEqual(Buffer.alloc(0));
      expect(test.events.has("Network.responseReceived")).toBe(false); expect(test.events.has("Network.loadingFinished")).toBe(false);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.getResponseBody")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("preserves a non-success status/body and decodes actual base64 bytes", async () => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? Promise.resolve({ body: Buffer.from("source unavailable").toString("base64"), base64Encoded: true }) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); const promise = test.routes[0].request().response();
      test.response("one", { responseStatusCode: 503 }); const response = await promise;
      expect(response?.status()).toBe(503); expect((await response?.body())?.toString()).toBe("source unavailable");
    } finally { await test.guard.close(); }
  });

  it.each(["declared", "decoded", "malformed", "conflicting"])("rejects invalid response size/headers %s", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    if (kind === "decoded") test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? Promise.resolve({ body: "x".repeat(2_000_001), base64Encoded: false }) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); const rejected = expect(test.routes[0].request().response()).rejects.toThrow();
      test.response("one", { responseHeaders: kind === "declared" ? [{ name: "Content-Length", value: "2000001" }]
        : kind === "malformed" ? [{ name: "Content-Length", value: "invalid" }]
          : kind === "conflicting" ? [{ name: "Content-Type", value: "text/html" }, { name: "content-type", value: "application/json" }] : [] });
      await rejected; expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
      if (kind === "conflicting") expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT");
    } finally { await test.guard.close(); }
  });

  it("fails body capture on timeout and clears its pending operation", async () => {
    vi.useFakeTimers(); const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? new Promise(() => {}) : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); test.response("one");
      await vi.advanceTimersByTimeAsync(101);
      expect(test.failures).toContain("NATIVE_REDIRECT_BODY_TIMEOUT"); expect(test.guard.pendingReads).toBe(0);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("retains copied request facts and response-wait phase before timeout cleanup", async () => {
    vi.useFakeTimers(); const test = await installed();
    try {
      test.request("private-fetch-id", { networkId: "private-network-id", resourceType: "Script", request: {
        url: "https://example.org/public.js?token=private-query#private-fragment", method: "GET",
        headers: { Authorization: "private-header" },
      } });
      await test.routes[0].continue();
      const rejected = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      await vi.advanceTimersByTimeAsync(101); await rejected;
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT",
        url: "https://example.org/public.js", method: "GET", resourceType: "script", interceptedRequests: 1,
        recordCount: 1, requestLimit: 256, framePresent: true, rootFrame: true, networkIdPresent: true,
        duplicateRequestId: false, hasPostData: false, postDataPresent: false, postDataBytes: 0 });
      const copy = test.guard.firstFatal!; copy.phase = "CONTINUE_RESPONSE_ACK"; copy.url = "https://mutated.example/";
      expect(test.guard.firstFatal?.phase).toBe("RESPONSE_WAIT"); expect(test.guard.firstFatal?.url).toBe("https://example.org/public.js");
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/private-|Authorization|token|networkId"|frameId"|headers|postData"/u);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.failures).toEqual(["NATIVE_REDIRECT_RESPONSE_TIMEOUT"]);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false);
      expect(test.guard.pendingReads).toBe(0);
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("distinguishes a timed-out unchanged response acknowledgement and produces no response proof", async () => {
    vi.useFakeTimers(); const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" ? new Promise(() => {}) : send(name, value));
    try {
      test.request("one", { resourceType: "Script" }); await test.routes[0].continue(); test.response("one", { resourceType: "Script" });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true), { interval: 1, timeout: 50 });
      await vi.advanceTimersByTimeAsync(101);
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "CONTINUE_RESPONSE_ACK",
        url: "https://example.org/data", method: "GET", resourceType: "script", duplicateRequestId: false });
      await expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0);
      expect(test.failures[0]).toBe("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it.each(["https://example.org/account/session-secret/collect", "https://sc.cps.golf/(S(abcdefghijklmnopqrstuvwx))/v3.5/teetimes"])("omits unsafe response-timeout URLs %s", async url => {
    vi.useFakeTimers(); const test = await installed();
    try {
      test.request("one", { request: { url, method: "GET", headers: {} } }); await test.routes[0].continue();
      const rejected = expect(test.routes[0].request().response()).rejects.toThrow("NATIVE_REDIRECT_RESPONSE_TIMEOUT");
      await vi.advanceTimersByTimeAsync(101); await rejected;
      expect(test.guard.firstFatal).toMatchObject({ code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT" });
      expect(test.guard.firstFatal?.url).toBeUndefined(); expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); vi.useRealTimers(); }
  });

  it("does not release a captured response after cancellation", async () => {
    const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal), body = deferred<{ body: string; base64Encoded: boolean }>();
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.getResponseBody" ? body.promise : send(name, value));
    try {
      test.request("one"); await test.routes[0].continue(); test.response("one"); cancellation.abort(); body.resolve({ body: "late", base64Encoded: false });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(false); expect(test.failures).toContain("NATIVE_REDIRECT_CANCELLED");
    } finally { await test.guard.close(); }
  });

  it("preserves an exact admitted redirect parent and rejects unknown or denied provenance", async () => {
    const test = await installed();
    try {
      test.request("one"); await test.routes[0].continue();
      test.response("one", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "/data" }] });
      await test.routes[0].request().response();
      test.request("two", { redirectedRequestId: "one" });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.routes[1].request().redirectedFrom()).toBe(test.routes[0].request());
      test.request("three", { redirectedRequestId: "missing" });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it.each([301, 302, 303, 307, 308])("attests only the exact released %i document Location rooted at an authorized full URL", async status => {
    const test = await installed(), root = "https://book.example.org/booking?course=7", target = "https://booking.example.net/booking?course=7";
    const roots = new Set([root]);
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } });
      const original = test.routes[0].request(); await test.routes[0].continue();
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(false);
      test.response("root", { responseStatusCode: status, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await original.response();
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(true);
      expect(isObservedNativeRedirectTarget(original, `${target}&other=1`, roots)).toBe(false);
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      const child = test.routes[1].request();
      expect(isObservedNativeRedirect(child, roots)).toBe(true);
      expect(isObservedNativeRedirect(child, new Set([new URL(root).origin]))).toBe(false);
      expect(isObservedNativeRedirect(child, new Set([`${root}&different=1`]))).toBe(false);
      expect(isObservedNativeRedirect({ ...child }, roots)).toBe(false);
      await test.guard.close();
      expect(isObservedNativeRedirect(child, roots)).toBe(false);
      expect(isObservedNativeRedirectTarget(original, target, roots)).toBe(false);
    } finally { await test.guard.close(); }
  });

  it("holds a child outside its handler until its exact parent response is successfully released", async () => {
    const test = await installed(), released = deferred<object>(), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    const send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.continueResponse" ? released.promise : send(name, value));
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } });
      const original = test.routes[0].request(); await test.routes[0].continue();
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      expect(test.routes).toHaveLength(1); expect(test.guard.pendingReads).toBeGreaterThan(0);
      test.response("root", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueResponse")).toBe(true));
      expect(test.routes).toHaveLength(1); expect(isObservedNativeRedirectTarget(original, target, new Set([root]))).toBe(false);
      released.resolve({});
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(isObservedNativeRedirect(test.routes[1].request(), new Set([root]))).toBe(true);
      expect(test.failures).toEqual([]);
    } finally { released.resolve({}); await test.guard.close(); }
  });

  it.each(["wrong-target", "status-200", "missing-location", "duplicate-location", "method-change", "post", "xhr-parent", "crosshost-script"])("rejects an unattested redirected document/asset: %s", async failure => {
    const test = await installed(), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    const method = failure === "post" ? "POST" : "GET", kind = failure === "xhr-parent" ? "XHR" : "Document";
    try {
      test.request("root", { resourceType: kind, request: { url: root, method, headers: {} } }); await test.routes[0].continue();
      const location = failure === "wrong-target" ? `${target}/different` : target;
      test.response("root", { responseStatusCode: failure === "status-200" ? 200 : 302,
        responseHeaders: failure === "missing-location" ? [] : [{ name: "Location", value: location }, ...(failure === "duplicate-location" ? [{ name: "Location", value: location }] : [])],
        request: { url: root, method, headers: {} } });
      await test.routes[0].request().response();
      test.request("child", { resourceType: failure === "crosshost-script" ? "Script" : "Document", redirectedRequestId: "root",
        request: { url: target, method: failure === "method-change" ? "HEAD" : method, headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.routes).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["GET", "HEAD"])("denies only an exactly attested cross-host Script→Script %s while document/data peers finish", async method => {
    const test = await installed(), root = "https://example.org/optional.js", target = "https://cdn.example.net/optional.js?v=public-build";
    try {
      test.request("script", { resourceType: "Script", request: { url: root, method, headers: {} } });
      await test.routes[0].continue();
      test.response("script", { resourceType: "Script", responseStatusCode: 307, responseHeaders: [{ name: "Location", value: target }],
        request: { url: root, method, headers: {} } });
      await test.routes[0].request().response();
      test.request("denied-child", { networkId: "network-script", resourceType: "Script", redirectedRequestId: "script",
        request: { url: target, method, headers: {} } });
      await vi.waitFor(() => expect(test.rejections).toHaveLength(1));
      expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", resourceType: "script", method,
        url: "https://cdn.example.net/optional.js", recordCount: 1 });
      expect(JSON.stringify(test.rejections)).not.toContain("public-build");
      expect(JSON.stringify(test.rejections)).not.toContain("network-script");
      expect(test.routes).toHaveLength(1); expect(test.handler).toHaveBeenCalledTimes(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      expect(test.cdp.send.mock.calls.filter(([name, value]) => name === "Fetch.failRequest" && value?.requestId === "denied-child")).toHaveLength(1);
      test.request("document", { resourceType: "Document" }); test.request("availability");
      await Promise.all(test.routes.slice(1).map(route => route.continue()));
      test.response("document", { resourceType: "Document" }); test.response("availability");
      const values = await Promise.all(test.routes.slice(1).map(async route => (await (await route.request().response())?.body())?.toString()));
      expect(values).toEqual(["body-document", "body-availability"]);
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.failures).toEqual([]); expect(test.close).not.toHaveBeenCalled();
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.guard.rejectedRequests).toEqual(test.rejections);
    } finally { await test.guard.close(); }
  });

  it.each(["wrong-target", "status-200", "missing-location", "method", "kind", "network", "missing-parent", "denied-parent", "unsafe-target"])(
    "retains fatal provenance rejection for an invalid script redirect: %s", async failure => {
      const test = await installed(), root = "https://example.org/optional.js", target = failure === "unsafe-target" ? "https://127.0.0.1/optional.js" : "https://cdn.example.net/optional.js";
      try {
        test.request("script", { resourceType: "Script", request: { url: root, method: "GET", headers: {} } });
        if (failure === "denied-parent") await test.routes[0].abort();
        else {
          await test.routes[0].continue(); test.response("script", { resourceType: "Script", responseStatusCode: failure === "status-200" ? 200 : 302,
            responseHeaders: failure === "missing-location" ? [] : [{ name: "Location", value: failure === "wrong-target" ? `${target}/wrong` : target }],
            request: { url: root, method: "GET", headers: {} } });
          await test.routes[0].request().response();
        }
        test.request("child", { networkId: failure === "network" ? "wrong-network" : "network-script", resourceType: failure === "kind" ? "Document" : "Script",
          redirectedRequestId: failure === "missing-parent" ? "missing" : "script", request: { url: target, method: failure === "method" ? "HEAD" : "GET", headers: {} } });
        await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
        expect(test.rejections).toEqual([]); expect(test.routes).toHaveLength(1); expect(test.close).toHaveBeenCalledOnce();
      } finally { await test.guard.close(); }
    });

  it.each(["failure", "hang", "cancel"])("fails closed if attested script-hop rejection ends in %s", async outcome => {
    vi.useFakeTimers(); const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal);
    const root = "https://example.org/optional.js", target = "https://cdn.example.net/optional.js", rejected = deferred<object>();
    const send = test.cdp.send.getMockImplementation()!;
    try {
      test.request("script", { resourceType: "Script", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.response("script", { resourceType: "Script", responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }],
        request: { url: root, method: "GET", headers: {} } }); await test.routes[0].request().response();
      test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest" && value?.requestId === "child"
        ? outcome === "failure" ? Promise.reject(new Error("offline rejection failed")) : rejected.promise : send(name, value));
      test.request("child", { networkId: "network-script", resourceType: "Script", redirectedRequestId: "script", request: { url: target, method: "GET", headers: {} } });
      await Promise.resolve(); await Promise.resolve();
      if (outcome === "cancel") { cancellation.abort(); rejected.resolve({}); }
      await vi.advanceTimersByTimeAsync(101);
      expect(test.close).toHaveBeenCalledOnce(); expect(test.rejections).toEqual([]);
      expect(test.failures).toContain(outcome === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : outcome === "cancel" ? "NATIVE_REDIRECT_CANCELLED" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
      expect(test.routes).toHaveLength(1); expect(test.guard.pendingReads).toBe(0);
    } finally { rejected.resolve({}); await test.guard.close(); vi.useRealTimers(); }
  });

  it.each(["https://127.0.0.1/booking", "https://user:secret@example.net/booking", "https://booking.example.net/checkout", "http://booking.example.net/booking"])("does not grant public document authority to unsafe Location %s", async target => {
    const test = await installed(), root = "https://book.example.org/booking";
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.response("root", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: target }], request: { url: root, method: "GET", headers: {} } });
      await test.routes[0].request().response();
      expect(isObservedNativeRedirectTarget(test.routes[0].request(), target, new Set([root]))).toBe(false);
      test.handler.mockImplementation(async route => { test.routes.push(route);
        expect(isObservedNativeRedirect(route.request(), new Set([root]))).toBe(false); await route.abort(); });
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.routes).toHaveLength(2));
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it("bounds redirect depth at five actual HTTP hops and never treats the final origin as a root", async () => {
    const test = await installed(), root = "https://first.example.org/booking";
    let url = root;
    try {
      test.request("0", { resourceType: "Document", request: { url, method: "GET", headers: {} } });
      for (let index = 0; index < 5; index++) {
        const next = `https://hop${index}.example.net/booking`;
        await test.routes[index].continue(); test.response(String(index), { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: next }], request: { url, method: "GET", headers: {} } });
        await test.routes[index].request().response();
        test.request(String(index + 1), { resourceType: "Document", redirectedRequestId: String(index), request: { url: next, method: "GET", headers: {} } });
        await vi.waitFor(() => expect(test.routes).toHaveLength(index + 2)); url = next;
      }
      expect(isObservedNativeRedirect(test.routes[5].request(), new Set([root]))).toBe(true);
      await test.routes[5].continue(); test.response("5", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "https://sixth.example.net/booking" }], request: { url, method: "GET", headers: {} } });
      await test.routes[5].request().response();
      expect(isObservedNativeRedirectTarget(test.routes[5].request(), "https://sixth.example.net/booking", new Set([root]))).toBe(false);
      test.request("6", { resourceType: "Document", redirectedRequestId: "5", request: { url: "https://sixth.example.net/booking", method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED")); expect(test.routes).toHaveLength(6);
    } finally { await test.guard.close(); }
  });

  it.each(["timeout", "failure", "cancel"])("does not attest a redirect while parent release ends in %s", async outcome => {
    const cancellation = new AbortController(), test = await installed(undefined, cancellation.signal), root = "https://book.example.org/booking", target = "https://booking.example.net/booking";
    try {
      test.request("root", { resourceType: "Document", request: { url: root, method: "GET", headers: {} } }); await test.routes[0].continue();
      test.request("child", { resourceType: "Document", redirectedRequestId: "root", request: { url: target, method: "GET", headers: {} } });
      if (outcome === "failure") test.events.get("Network.loadingFailed")!({ requestId: "network-root" });
      if (outcome === "cancel") cancellation.abort();
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.routes).toHaveLength(1); expect(isObservedNativeRedirectTarget(test.routes[0].request(), target, new Set([root]))).toBe(false);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")).toHaveLength(1);
    } finally { await test.guard.close(); }
  });

  it.each(["XHR", "Ping"])("denies %s subframes before policy/dispatch without invalidating main evidence", async resourceType => {
    const test = await installed();
    try {
      test.request("child", { frameId: "child", resourceType, networkId: undefined, redirectedRequestId: "unknown" });
      await vi.waitFor(() => expect(test.subframes).toHaveLength(1));
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled(); expect(test.failures).toEqual([]);
      expect(test.cdp.send.mock.calls.some(([name]) => name === "Fetch.continueRequest")).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "missing-network", "missing-body", "oversized-body", "duplicate-id"])("fails closed with an exact bounded diagnostic for malformed request %s", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", kind === "missing-frame" ? { frameId: undefined } : kind === "missing-network" ? { networkId: undefined }
        : kind === "missing-body" ? { request: { url: "https://example.org/data", method: "POST", hasPostData: true, headers: {} } }
          : kind === "oversized-body" ? { request: { url: "https://example.org/data", method: "GET", postData: "x".repeat(32769), headers: {} } } : {});
      const suffixes: Record<string, string> = { cap: "INTERCEPT_LIMIT", "missing-frame": "FRAME_MISSING", "missing-network": "NETWORK_ID_MISSING",
        "missing-body": "POST_BODY_MISSING", "oversized-body": "POST_BODY_LIMIT", "duplicate-id": "DUPLICATE_FETCH_ID" };
      await vi.waitFor(() => expect(test.failures).toContain(`NATIVE_REDIRECT_${suffixes[kind]}`));
      expect(test.guard.firstFatal?.code).toBe(`NATIVE_REDIRECT_${suffixes[kind]}`);
      expect(test.close).toHaveBeenCalledOnce();
    } finally { await test.guard.close(); }
  });

  it("rejects an oversized POST before admission while same-host document and data peers complete", async () => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    let active = 0, maxActive = 0;
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => {
      active++; maxActive = Math.max(maxActive, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    }, signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("oversized", { request: { url: "https://example.org/collect?private=never-retain", method: "POST", hasPostData: true,
        postData: "x".repeat(32769), headers: { authorization: "never-retain-header" } } });
      test.request("document", { resourceType: "Document" }); test.request("availability");
      test.response("document");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["document", "availability"]));
      test.response("availability");
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-document", "body-availability"]); });
      expect(test.handler).toHaveBeenCalledTimes(2); expect(maxActive).toBe(1);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["oversized"]);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.guard.lastFailure).toBeUndefined(); expect(test.failures).toEqual([]);
      expect(test.rejections).toHaveLength(1); expect(test.rejections[0]).toMatchObject({ code: "NATIVE_REDIRECT_POST_BODY_LIMIT",
        url: "https://example.org/collect", method: "POST", postDataBytes: 32769, recordCount: 0, hasPostData: true, postDataPresent: true });
      expect(JSON.stringify(test.guard.rejectedRequests)).not.toMatch(/never-retain|authorization|postData"/u);
      expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each([false, true])("aborts Ping without dispatch or evidence while same-host document/data peers complete (network ID present: %s)", async networkIdPresent => {
    const test = await installed(), signal = new AbortController(), stop = vi.fn(async () => {}), bodies: string[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_host, work) => ({ acquired: true as const, value: await work() }), signal.signal);
    test.handler.mockImplementation(async route => {
      test.routes.push(route);
      bodies.push((await queue.run("example.org", () => continueNativeBrowserRead(route, signal.signal, 1000, stop))).body.toString());
    });
    try {
      test.request("ping", { resourceType: "Ping", networkId: networkIdPresent ? "network-ping" : undefined,
        request: { url: "https://example.org/collect?private=not-retained", method: "POST", hasPostData: true,
          postData: "x".repeat(672), headers: { authorization: "not-retained" } } });
      test.request("document", { resourceType: "Document" }); test.request("availability");
      test.response("document");
      await vi.waitFor(() => expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.continueRequest")
        .map(([, value]) => value?.requestId)).toEqual(["document", "availability"]));
      test.response("availability");
      test.events.get("Network.loadingFailed")!({ requestId: "network-ping" });
      await vi.waitFor(() => { expect(test.guard.pendingReads).toBe(0); expect(bodies).toEqual(["body-document", "body-availability"]); });
      expect(test.handler).toHaveBeenCalledTimes(2);
      expect(test.cdp.send.mock.calls.filter(([name]) => name === "Fetch.failRequest").map(([, value]) => value?.requestId)).toEqual(["ping"]);
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))
        .map(([, value]) => value?.requestId)).not.toContain("ping");
      expect(test.guard.rejectedRequests).toEqual([expect.objectContaining({ code: "NATIVE_REDIRECT_PING_UNSUPPORTED",
        method: "POST", resourceType: "ping", networkIdPresent, postDataBytes: 672, recordCount: 0 })]);
      expect(JSON.stringify(test.guard.rejectedRequests)).not.toMatch(/not-retained|authorization|postData"/u);
      expect(test.guard.firstFatal).toBeUndefined(); expect(test.failures).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { queue.dispose(); signal.abort(); await test.guard.close(); }
  });

  it.each(["missing", "empty", "oversized"])("never constructs a read record for Ping with %s POST data", async kind => {
    const test = await installed();
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined, request: { url: "https://example.org/collect", method: "POST",
        hasPostData: true, ...(kind === "missing" ? {} : { postData: kind === "empty" ? "" : "x".repeat(32769) }), headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
      expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_PING_UNSUPPORTED");
      expect(test.cdp.send.mock.calls.filter(([name]) => ["Fetch.continueRequest", "Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("does not let a late response fabricate evidence for a denied Ping", async () => {
    const test = await installed();
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      test.response("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_RESPONSE_UNKNOWN"));
      expect(test.handler).not.toHaveBeenCalled();
      expect(test.cdp.send.mock.calls.some(([name]) => ["Fetch.getResponseBody", "Fetch.continueResponse"].includes(name))).toBe(false);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "duplicate-id"])("retains the %s fatal guard before Ping denial", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", { resourceType: "Ping", networkId: undefined,
        ...(kind === "missing-frame" ? { frameId: undefined } : {}) });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      const suffix = kind === "cap" ? "INTERCEPT_LIMIT" : kind === "missing-frame" ? "FRAME_MISSING" : "DUPLICATE_FETCH_ID";
      expect(test.failures).toContain(`NATIVE_REDIRECT_${suffix}`); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when the exact Ping abort %ss", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest"
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Protocol abort rejected")) : send(name, value));
    try {
      test.request("ping", { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toContain(kind === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it("counts denied Pings toward the intercept limit and bounds copied diagnostics", async () => {
    const test = await installed(14);
    try {
      for (let index = 0; index < 14; index++) test.request(`ping-${index}`, { resourceType: "Ping", networkId: undefined });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.guard.rejectedRequests).toHaveLength(12);
      const copy = test.guard.rejectedRequests!; copy[0].code = "MUTATED"; copy.pop();
      expect(test.guard.rejectedRequests).toHaveLength(12); expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_PING_UNSUPPORTED");
      test.request("availability");
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_INTERCEPT_LIMIT"));
      expect(test.handler).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each(["reject", "hang"])("still closes when aborting an oversized POST %ss", async kind => {
    const test = await installed(), send = test.cdp.send.getMockImplementation()!;
    test.cdp.send.mockImplementation((name, value) => name === "Fetch.failRequest"
      ? kind === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Protocol abort rejected")) : send(name, value));
    try {
      test.request("oversized", { request: { url: "https://example.org/collect", method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => { expect(test.close).toHaveBeenCalledOnce(); expect(test.guard.pendingReads).toBe(0); });
      expect(test.failures).toContain(kind === "hang" ? "NATIVE_REDIRECT_ABORT_TIMEOUT" : "NATIVE_REDIRECT_ROUTING_FAILED");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.guard.rejectedRequests).toEqual([]);
    } finally { await test.guard.close(); }
  });

  it.each(["cap", "missing-frame", "missing-network", "duplicate-id"])("does not bypass the %s guard for oversized POSTs", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", { ...(kind === "missing-frame" ? { frameId: undefined } : {}),
        ...(kind === "missing-network" ? { networkId: undefined } : {}), request: {
          url: "https://example.org/collect", method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.rejectedRequests).toEqual([]); expect(test.failures).not.toContain("NATIVE_REDIRECT_POST_BODY_LIMIT");
    } finally { await test.guard.close(); }
  });

  it("bounds independently rejected POST diagnostics and returns copies", async () => {
    const test = await installed();
    try {
      for (let index = 0; index < 14; index++) test.request(String(index), { request: {
        url: `https://example.org/collect${index}`, method: "POST", postData: "x".repeat(32769), headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      expect(test.rejections).toHaveLength(14); expect(test.guard.rejectedRequests).toHaveLength(12);
      expect(test.guard.rejectedRequests?.[0].url).toBe("https://example.org/collect2");
      const copy = test.guard.rejectedRequests!; copy[0].code = "MUTATED"; copy.pop();
      expect(test.guard.rejectedRequests).toHaveLength(12); expect(test.guard.rejectedRequests?.[0].code).toBe("NATIVE_REDIRECT_POST_BODY_LIMIT");
      expect(test.handler).not.toHaveBeenCalled(); expect(test.close).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it.each([16384, 16385])("enforces the 32768-byte body limit without truncating multibyte text (%s characters)", async characters => {
    const test = await installed(), body = "é".repeat(characters);
    try {
      test.request("unicode", { request: { url: "https://example.org/public-read", method: "POST", hasPostData: true, postData: body, headers: {} } });
      await vi.waitFor(() => expect(test.guard.pendingReads).toBe(0));
      if (characters === 16384) {
        expect(test.handler).toHaveBeenCalledOnce(); expect(test.routes[0].request().postData()).toBe(body);
        expect(test.guard.rejectedRequests).toEqual([]);
      } else {
        expect(test.handler).not.toHaveBeenCalled();
        expect(test.guard.rejectedRequests?.[0]).toMatchObject({ code: "NATIVE_REDIRECT_POST_BODY_LIMIT", postDataBytes: 32770 });
      }
      expect(test.close).not.toHaveBeenCalled();
    } finally { await test.guard.close(); }
  });

  it("retains only the first fatal guard's public path and bounded facts without secrets or raw identifiers", async () => {
    const test = await installed();
    try {
      test.request("private-fetch-id", { networkId: "private-network-id", request: {
        url: "https://example.org/collect?token=private-query-value", method: "POST", hasPostData: true,
        headers: { Authorization: "private-header-value" },
      } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal).toEqual({ code: "NATIVE_REDIRECT_POST_BODY_MISSING", url: "https://example.org/collect", method: "POST", resourceType: "xhr",
        interceptedRequests: 1, recordCount: 0, requestLimit: 256, framePresent: true, rootFrame: true, networkIdPresent: true,
        duplicateRequestId: false, hasPostData: true, postDataPresent: false, postDataBytes: 0 });
      const copy = test.guard.firstFatal!; copy.code = "MUTATED_COPY";
      test.request("later", { networkId: undefined });
      expect(test.guard.firstFatal?.code).toBe("NATIVE_REDIRECT_POST_BODY_MISSING");
      expect(JSON.stringify(test.guard.firstFatal)).not.toMatch(/private-|Authorization|token|networkId"|frameId"|postData"/u);
    } finally { await test.guard.close(); }
  });

  it.each(["https://example.org/account/session-secret/collect", "https://sc.cps.golf/(S(abcdefghijklmnopqrstuvwx))/v3.5/teetimes"])("omits unsafe or session-bearing fatal paths %s", async url => {
    const test = await installed();
    try {
      test.request("one", { networkId: undefined, request: { url, method: "GET", headers: {} } });
      await vi.waitFor(() => expect(test.close).toHaveBeenCalledOnce());
      expect(test.guard.firstFatal?.url).toBeUndefined();
    } finally { await test.guard.close(); }
  });

  it("only releases active same-page Playwright pauses; foreign/unavailable/closed routes abort", async () => {
    const test = await installed(), same = playwrightRoute(test), foreign = playwrightRoute(test), unavailable = playwrightRoute(test), closed = playwrightRoute(test);
    vi.spyOn(foreign, "request").mockReturnValue({ frame: () => ({}) } as ReturnType<Route["request"]>);
    vi.spyOn(unavailable, "request").mockImplementation(() => { throw new Error("frame unavailable"); });
    await test.guard.releasePlaywrightRoute(same); await test.guard.releasePlaywrightRoute(foreign); await test.guard.releasePlaywrightRoute(unavailable);
    expect(same.continue).toHaveBeenCalledOnce(); expect(foreign.abort).toHaveBeenCalledOnce(); expect(unavailable.abort).toHaveBeenCalledOnce();
    expect(test.handler).not.toHaveBeenCalled(); await test.guard.close(); await test.guard.releasePlaywrightRoute(closed);
    expect(closed.continue).not.toHaveBeenCalled(); expect(closed.abort).toHaveBeenCalledOnce();
  });

  it("reports an unsupported frame explicitly", async () => {
    const test = await installed();
    expect(() => test.guard.prepare(test.main as Parameters<typeof test.guard.prepare>[0])).not.toThrow();
    expect(() => test.guard.prepare({} as Parameters<typeof test.guard.prepare>[0])).toThrow("NATIVE_REDIRECT_FRAME_UNGUARDED");
    await test.guard.close();
  });
});
