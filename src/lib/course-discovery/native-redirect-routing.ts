import type { Frame, Page, Response, Route } from "@playwright/test";
import { canonicalPublicReadUrl } from "./public-request-url";
import { PUBLIC_BROWSER_TOTAL_BYTES } from "./browser-resource-limits";

/** Requests and responses come from the current browser's CDP events. No
 * secondary HTTP client or model-authored response participates in evidence. */
export interface NativeReadRequest {
  url(): string; method(): string; headers(): Record<string, string>; postData(): string | null;
  resourceType(): string; isNavigationRequest(): boolean; frame(): Frame;
  redirectedFrom(): NativeReadRequest | null; response(): Promise<NativeReadResponse | null>;
}
export type NativeReadResponse = Pick<Response, "url" | "status" | "allHeaders" | "finished" | "body">;
export type NativeReadRoute = Pick<Route, "continue" | "abort" | "fulfill"> & { request(): NativeReadRequest };
function pending<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
type RecordEntry = { id: string; networkId: string; url: string; method: string; headers: Record<string, string>; body: string | null;
  kind: string; parent: RecordEntry | null; depth: number; paused: boolean; wrapped?: boolean; redirected?: boolean; adapter: NativeReadRequest;
  response: ReturnType<typeof pending<NativeReadResponse | Error>>; finished: ReturnType<typeof pending<Error | null>>;
  metadata?: { url: string; status: number; headers: Record<string, string> } };
const resourceKinds: Record<string, string> = { Document: "document", Stylesheet: "stylesheet", Image: "image", Media: "media",
  Font: "font", Script: "script", XHR: "xhr", Fetch: "fetch", EventSource: "eventsource", WebSocket: "websocket",
  Manifest: "manifest", Other: "other", Ping: "ping", Preflight: "other" };
function headers(value: Record<string, string | number>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 128 || JSON.stringify(entries).length > 65_536) throw new Error("NATIVE_REDIRECT_HEADERS_LIMIT");
  return Object.fromEntries(entries.map(([key, item]) => [key.toLowerCase(), String(item)]));
}

export async function installNativeRedirectRouting(page: Page, handler: (route: NativeReadRoute) => Promise<void>, options: {
  signal?: AbortSignal; maxRequests?: number; timeoutMs?: number; onFailure?: (code: string) => void;
  onSubframeBlocked?: (request: { url: string; resourceType: string }) => void;
} = {}) {
  options.signal?.throwIfAborted();
  const limit = Math.min(1024, Math.max(1, options.maxRequests ?? 256));
  const timeoutMs = Math.min(15_000, Math.max(100, options.timeoutMs ?? 15_000));
  const cdp = await page.context().newCDPSession(page);
  const rootFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const records = new Map<string, RecordEntry>();
  let closing: Promise<void> | undefined, closed = false, lastFailure: string | undefined, interceptedRequests = 0;
  const failure = (code: string) => { lastFailure = code; try { options.onFailure?.(code); } catch { /* Diagnostics cannot authorize work. */ } };
  const equivalent = (left: string, right: string, method: string) => left === right || canonicalPublicReadUrl(left, method) === right;
  const onAbort = () => { void close("NATIVE_REDIRECT_CANCELLED"); };
  function close(code = "NATIVE_REDIRECT_CLOSED") {
    if (closing) return closing;
    closed = true;
    if (code !== "NATIVE_REDIRECT_CLOSED") failure(code);
    options.signal?.removeEventListener("abort", onAbort);
    for (const record of records.values()) { record.response.settle(new Error(code)); record.finished.settle(new Error(code)); }
    // Never detach interception while live paused requests could resume.
    closing = (async () => { await page.close({ runBeforeUnload: false }).catch(() => {}); await cdp.detach().catch(() => {}); })();
    return closing;
  }
  const bounded = async <T>(promise: Promise<T>, code: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(code)); void close(code); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const metadata = (networkId: string, value: { url: string; status: number; headers: Record<string, string | number> }, complete = false) => {
    // Browser-local images can report Network metadata without a Fetch request.
    // They carry no public availability evidence and confer no URL permission.
    if (/^(?:data|blob):/u.test(value.url)) return;
    const matching = [...records.values()].filter(record => record.networkId === networkId && equivalent(record.url, value.url, record.method));
    if (matching.length !== 1) { void close("NATIVE_REDIRECT_RESPONSE_MISMATCH"); return; }
    const record = matching[0];
    record.metadata = { url: value.url, status: value.status, headers: headers(value.headers) };
    const snapshot = record.metadata;
    record.response.settle({ url: () => snapshot.url, status: () => snapshot.status, allHeaders: async () => ({ ...snapshot.headers }),
      finished: () => bounded(record.finished.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT"),
      body: async () => {
        const failed = await bounded(record.finished.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT");
        if (failed) throw failed;
        if (snapshot.status >= 300 && snapshot.status < 400 || [204, 205, 304].includes(snapshot.status)) return Buffer.alloc(0);
        const body = await bounded(cdp.send("Network.getResponseBody", { requestId: networkId }), "NATIVE_REDIRECT_BODY_TIMEOUT");
        return Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
      } });
    if (complete) { record.redirected = true; record.finished.settle(null); }
  };
  cdp.on("Network.responseReceived", event => {
    try { metadata(event.requestId, event.response); } catch { void close("NATIVE_REDIRECT_RESPONSE_MISMATCH"); }
  });
  cdp.on("Network.requestWillBeSent", event => {
    if (event.redirectResponse) try { metadata(event.requestId, event.redirectResponse, true); } catch { void close("NATIVE_REDIRECT_RESPONSE_MISMATCH"); }
  });
  cdp.on("Network.loadingFinished", event => {
    // Exclude only responses that actually continued as redirects. A terminal
    // 304 (and a non-followed 3xx) completes on loadingFinished like any other
    // bodyless response, without a subsequent redirectResponse event.
    const matching = [...records.values()].filter(record => record.networkId === event.requestId && record.metadata && !record.redirected);
    if (matching.length > 1) { void close("NATIVE_REDIRECT_RESPONSE_MISMATCH"); return; }
    matching[0]?.finished.settle(null);
  });
  cdp.on("Network.loadingFailed", event => {
    for (const record of records.values()) if (record.networkId === event.requestId) {
      record.response.settle(new Error("NATIVE_REDIRECT_NETWORK_FAILED")); record.finished.settle(new Error("NATIVE_REDIRECT_NETWORK_FAILED"));
    }
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  cdp.on("Fetch.requestPaused", event => {
    void (async () => {
      if (closed) return;
      const reject = () => cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      if (++interceptedRequests > limit) { await reject(); await close("NATIVE_REDIRECT_REQUEST_REJECTED"); return; }
      // Embedded frames cannot supply evidence or network authority. Deny their
      // first request and every redirect before dispatch, while retaining the
      // independently guarded top document. Malformed root metadata stays fatal.
      if (event.frameId && event.frameId !== rootFrameId) {
        await reject();
        try { options.onSubframeBlocked?.({ url: event.request.url, resourceType: resourceKinds[event.resourceType] ?? "other" }); }
        catch { /* A diagnostic must not change the denial. */ }
        return;
      }
      if (records.size >= limit || records.has(event.requestId) || event.frameId !== rootFrameId || !event.networkId ||
          event.request.hasPostData && event.request.postData === undefined || (event.request.postData?.length ?? 0) > 32768) {
        await reject(); await close("NATIVE_REDIRECT_REQUEST_REJECTED"); return;
      }
      const parent = event.redirectedRequestId ? records.get(event.redirectedRequestId) : null;
      if (event.redirectedRequestId && (!parent || parent.depth >= 5)) { await reject(); await close("NATIVE_REDIRECT_PROVENANCE_REJECTED"); return; }
      const kind = resourceKinds[event.resourceType];
      if (!kind) { await reject(); await close("NATIVE_REDIRECT_RESOURCE_REJECTED"); return; }
      const record: RecordEntry = { id: event.requestId, networkId: event.networkId, url: event.request.url, method: event.request.method,
        headers: headers(event.request.headers), body: event.request.postData ?? null, kind, parent: parent ?? null,
        depth: parent ? parent.depth + 1 : 0, paused: true, response: pending(), finished: pending(), adapter: undefined as unknown as NativeReadRequest };
      record.adapter = { url: () => record.url, method: () => record.method, headers: () => ({ ...record.headers }), postData: () => record.body,
        resourceType: () => record.kind, isNavigationRequest: () => record.kind === "document", frame: () => page.mainFrame(),
        redirectedFrom: () => record.parent?.adapter ?? null, response: async () => {
          const value = await bounded(record.response.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT"); if (value instanceof Error) throw value; return value;
        } };
      records.set(record.id, record);
      if (!parent) { record.paused = false; await cdp.send("Fetch.continueRequest", { requestId: record.id }); return; }
      const route: NativeReadRoute = { request: () => record.adapter,
        continue: async values => {
          if (!record.paused || closed || values && Object.keys(values).some(key => key !== "url") ||
              values?.url && !equivalent(record.url, values.url, record.method)) throw new Error("NATIVE_REDIRECT_CONTINUE_REJECTED");
          record.paused = false;
          await cdp.send("Fetch.continueRequest", { requestId: record.id, ...(values?.url && values.url !== record.url ? { url: values.url } : {}) });
        },
        abort: async () => { if (record.paused && !closed) { record.paused = false; await reject(); } },
        fulfill: async () => { throw new Error("NATIVE_REDIRECT_FULFILL_REJECTED"); },
      };
      try { await handler(route); }
      catch { await route.abort().catch(() => {}); await close("NATIVE_REDIRECT_HANDLER_FAILED"); }
    })().catch(() => { void close("NATIVE_REDIRECT_ROUTING_FAILED"); });
  });
  await cdp.send("Network.enable", { maxTotalBufferSize: PUBLIC_BROWSER_TOTAL_BYTES, maxResourceBufferSize: 16_000_000, maxPostDataSize: 32768 });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  if (options.signal?.aborted) await close("NATIVE_REDIRECT_CANCELLED");
  return {
    prepare(frame: Frame) {
      if (closed || frame !== page.mainFrame()) { failure("NATIVE_REDIRECT_FRAME_UNGUARDED"); throw new Error("NATIVE_REDIRECT_FRAME_UNGUARDED"); }
    },
    wrapRoute(route: Route): NativeReadRoute {
      const request = route.request();
      if (closed || request.frame() !== page.mainFrame()) throw new Error("NATIVE_REDIRECT_FRAME_UNGUARDED");
      const matching = [...records.values()].filter(record => !record.wrapped && record.url === request.url() && record.method === request.method() && !record.parent &&
        record.adapter.isNavigationRequest() === request.isNavigationRequest());
      if (matching.length !== 1) { failure("NATIVE_REDIRECT_REQUEST_MISMATCH"); throw new Error("NATIVE_REDIRECT_REQUEST_MISMATCH"); }
      matching[0].wrapped = true;
      return { request: () => matching[0].adapter, continue: route.continue.bind(route), abort: route.abort.bind(route), fulfill: route.fulfill.bind(route) };
    },
    get lastFailure() { return lastFailure; }, close: () => close(),
  };
}
