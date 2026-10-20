// @vitest-environment node
import type { Page, Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { installNativeRedirectRouting, type NativeReadRoute } from "./native-redirect-routing";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function installed(maxRequests?: number, signal?: AbortSignal) {
  const events = new Map<string, (event: unknown) => void>(), routes: NativeReadRoute[] = [];
  const close = vi.fn(async () => {}), detach = vi.fn(async () => {}), failures: string[] = [], subframes: object[] = [];
  const main = { page: () => page };
  const cdp = { on: (name: string, listener: (event: unknown) => void) => { events.set(name, listener); },
    send: vi.fn(async (name: string, value?: { requestId?: string }) => name === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } }
      : name === "Fetch.getResponseBody" ? { body: `body-${value?.requestId}`, base64Encoded: false } : {}), detach };
  const page = { context: () => ({ newCDPSession: async () => cdp }), mainFrame: () => main, close } as unknown as Page;
  const handler = vi.fn(async (route: NativeReadRoute) => { routes.push(route); });
  const guard = await installNativeRedirectRouting(page, handler, { timeoutMs: 100, maxRequests, signal,
    onFailure: code => failures.push(code), onSubframeBlocked: request => subframes.push(request) });
  const request = (id: string, values: object = {}) => events.get("Fetch.requestPaused")!({ requestId: id, networkId: `network-${id}`,
    frameId: "main", resourceType: "XHR", request: { url: "https://example.org/data", method: "GET", headers: {} }, ...values });
  const response = (id: string, values: object = {}) => request(id, { responseStatusCode: 200, responseHeaders: [], ...values });
  return { guard, events, close, failures, main, cdp, subframes, handler, routes, request, response };
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

  it.each(["cap", "missing-network", "missing-body", "oversized-body", "duplicate-id"])("fails closed for malformed/bounded request %s", async kind => {
    const test = await installed(kind === "cap" ? 1 : undefined);
    try {
      if (kind === "cap" || kind === "duplicate-id") test.request("one");
      test.request(kind === "cap" ? "two" : "one", kind === "missing-network" ? { networkId: undefined }
        : kind === "missing-body" ? { request: { url: "https://example.org/data", method: "POST", hasPostData: true, headers: {} } }
          : kind === "oversized-body" ? { request: { url: "https://example.org/data", method: "POST", postData: "x".repeat(32769), headers: {} } } : {});
      await vi.waitFor(() => expect(test.failures).toContain("NATIVE_REDIRECT_REQUEST_REJECTED"));
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
