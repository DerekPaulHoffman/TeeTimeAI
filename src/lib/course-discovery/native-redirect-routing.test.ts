// @vitest-environment node
import type { Page, Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { installNativeRedirectRouting, isNativeReadTerminalFailure, type NativeReadRoute, type NativeRequestDiagnostic } from "./native-redirect-routing";
import { continueNativeBrowserRead } from "./native-public-browser";
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
      test.request("two", { redirectedRequestId: "one" }); expect(test.routes[1].request().redirectedFrom()).toBe(test.routes[0].request());
      test.request("three", { redirectedRequestId: "missing" });
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_PROVENANCE_REJECTED"));
      expect(test.routes).toHaveLength(2);
    } finally { await test.guard.close(); }
  });

  it("denies subframes before policy/dispatch without invalidating main evidence", async () => {
    const test = await installed();
    try {
      test.request("child", { frameId: "child", redirectedRequestId: "unknown" });
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
