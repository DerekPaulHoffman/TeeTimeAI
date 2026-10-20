import type { Frame, Page, Response, Route } from "@playwright/test";
import { canonicalPublicReadUrl } from "./public-request-url";
import { PUBLIC_BROWSER_TOTAL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";

/** One CDP owner validates every initial/redirected read. Evidence comes from
 * that exact request's paused Chrome response, independently of page body use. */
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
type RecordEntry = {
  id: string; networkId: string; url: string; transportUrl: string; method: string; headers: Record<string, string>; body: string | null;
  kind: string; parent: RecordEntry | null; depth: number; paused: boolean; admitted: boolean; failed: boolean; responseStarted: boolean; complete: boolean;
  failureCode?: string;
  adapter: NativeReadRequest; response: ReturnType<typeof pending<NativeReadResponse | Error>>;
};
const resourceKinds: Record<string, string> = { Document: "document", Stylesheet: "stylesheet", Image: "image", Media: "media",
  Font: "font", Script: "script", XHR: "xhr", Fetch: "fetch", EventSource: "eventsource", WebSocket: "websocket",
  Manifest: "manifest", Other: "other", Ping: "ping", Preflight: "other" };
function headers(value: Record<string, string | number>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 128 || JSON.stringify(entries).length > 65_536) throw new Error("NATIVE_REDIRECT_HEADERS_LIMIT");
  return Object.fromEntries(entries.map(([key, item]) => [key.toLowerCase(), String(item)]));
}
function responseHeaders(values: Array<{ name: string; value: string }>) {
  if (!Array.isArray(values) || values.length > 128 || JSON.stringify(values).length > 65_536) throw new Error("NATIVE_REDIRECT_HEADERS_LIMIT");
  const result: Record<string, string> = {};
  for (const item of values) {
    const name = item.name.toLowerCase();
    if (Object.hasOwn(result, name)) {
      if (["content-length", "content-type", "location"].includes(name)) {
        if (result[name] !== item.value) throw new Error("NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT");
      } else result[name] += `${name === "set-cookie" ? "\n" : ", "}${item.value}`;
    } else result[name] = item.value;
  }
  return result;
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
  let closing: Promise<void> | undefined, closed = false, enabled = false, lastFailure: string | undefined;
  let interceptedRequests = 0, pendingReads = 0, responseBytes = 0;
  const failure = (code: string) => { lastFailure = code; try { options.onFailure?.(code); } catch { /* Diagnostics cannot authorize work. */ } };
  const onAbort = () => { void close("NATIVE_REDIRECT_CANCELLED"); };
  function close(code = "NATIVE_REDIRECT_CLOSED") {
    if (closing) return closing;
    closed = true;
    if (code !== "NATIVE_REDIRECT_CLOSED") failure(code);
    options.signal?.removeEventListener("abort", onAbort);
    for (const record of records.values()) { record.failed = true; record.response.settle(new Error(code)); }
    // Never detach interception while paused requests could resume.
    closing = (async () => { await page.close({ runBeforeUnload: false }).catch(() => {}); await cdp.detach().catch(() => {}); })();
    return closing;
  }
  const bounded = async <T>(promise: Promise<T>, code: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(code)); void close(code); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const failRecord = (record: RecordEntry, code: string) => { record.failed = true; record.failureCode = code; record.response.settle(new Error(code)); };
  cdp.on("Network.loadingFailed", event => {
    for (const record of records.values()) if (record.networkId === event.requestId && !record.complete && !record.failed)
      failRecord(record, "NATIVE_REDIRECT_NETWORK_FAILED");
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  cdp.on("Fetch.requestPaused", event => {
    // Include dispatch and capture before any await, so ready DOM cannot hide
    // an incomplete native read before the shared handler starts or resumes.
    pendingReads++;
    void (async () => {
      if (closed) return;
      const reject = () => cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        const record = records.get(event.requestId);
        // Enumerate the same fail-closed checks without retaining headers,
        // request bodies or provider error text in diagnostics.
        const mismatch = !record ? "NATIVE_REDIRECT_RESPONSE_UNKNOWN" : !record.admitted ? "NATIVE_REDIRECT_RESPONSE_UNADMITTED" :
          record.failed && !(record.failureCode === "NATIVE_REDIRECT_NETWORK_FAILED" && event.responseErrorReason) ? "NATIVE_REDIRECT_RESPONSE_PRIOR_FAILURE" : record.responseStarted ? "NATIVE_REDIRECT_RESPONSE_DUPLICATE" :
            record.paused ? "NATIVE_REDIRECT_RESPONSE_REQUEST_PAUSED" : record.networkId !== event.networkId ? "NATIVE_REDIRECT_RESPONSE_NETWORK_MISMATCH" :
              record.transportUrl !== event.request.url ? "NATIVE_REDIRECT_RESPONSE_URL_MISMATCH" : record.method !== event.request.method ? "NATIVE_REDIRECT_RESPONSE_METHOD_MISMATCH" :
                event.frameId !== rootFrameId ? "NATIVE_REDIRECT_RESPONSE_FRAME_MISMATCH" : !event.responseErrorReason &&
                  (!Number.isInteger(event.responseStatusCode) || event.responseStatusCode! < 100 || event.responseStatusCode! > 599) ? "NATIVE_REDIRECT_RESPONSE_STATUS_INVALID" : undefined;
        if (mismatch || !record) { await close(mismatch ?? "NATIVE_REDIRECT_RESPONSE_UNKNOWN"); return; }
        record.responseStarted = true;
        if (event.responseErrorReason) {
          // Chrome has failed this exact admitted read. Do not create response
          // evidence or close unrelated documents/reads because an optional
          // resource failed. The root page.goto still reports navigation failure.
          failRecord(record, "NATIVE_REDIRECT_NETWORK_FAILED");
          await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
          return;
        }
        const status = event.responseStatusCode!, values = responseHeaders(event.responseHeaders ?? []);
        const maxBytes = publicBrowserResponseLimit(record.kind), declared = Number(values["content-length"] ?? 0);
        if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) { await close("NATIVE_RESPONSE_LIMIT"); return; }
        const noBody = record.method === "HEAD" || [204, 205, 304].includes(status) || status >= 300 && status < 400;
        // Network.loadingFinished can wait for page JavaScript to consume a
        // Fetch body, deadlocking Promise.all behind a serialized provider lease.
        const body = noBody ? Buffer.alloc(0) : await bounded(cdp.send("Fetch.getResponseBody", { requestId: record.id }), "NATIVE_REDIRECT_BODY_TIMEOUT")
          .then(value => Buffer.from(value.body, value.base64Encoded ? "base64" : "utf8"));
        responseBytes += body.length;
        if (body.length > maxBytes || responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) { await close("NATIVE_RESPONSE_LIMIT"); return; }
        if (closed || options.signal?.aborted || record.failed) return;
        // Preserve the actual status, headers and body. Completion follows the
        // successful unchanged release, never a fabricated/fulfilled response.
        await bounded(cdp.send("Fetch.continueResponse", { requestId: record.id }), "NATIVE_REDIRECT_RESPONSE_TIMEOUT");
        if (closed || options.signal?.aborted || record.failed) return;
        record.complete = true;
        record.response.settle({ url: () => record.transportUrl, status: () => status, allHeaders: async () => ({ ...values }),
          finished: async () => null, body: async () => body });
        return;
      }
      if (++interceptedRequests > limit) { await reject(); await close("NATIVE_REDIRECT_REQUEST_REJECTED"); return; }
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
      if (event.redirectedRequestId && (!parent || !parent.admitted || parent.failed || parent.depth >= 5)) {
        await reject(); await close("NATIVE_REDIRECT_PROVENANCE_REJECTED"); return;
      }
      const kind = resourceKinds[event.resourceType];
      if (!kind) { await reject(); await close("NATIVE_REDIRECT_RESOURCE_REJECTED"); return; }
      const record: RecordEntry = { id: event.requestId, networkId: event.networkId, url: event.request.url, transportUrl: event.request.url,
        method: event.request.method, headers: headers(event.request.headers), body: event.request.postData ?? null, kind,
        parent: parent ?? null, depth: parent ? parent.depth + 1 : 0, paused: true, admitted: false, failed: false, responseStarted: false, complete: false,
        response: pending(), adapter: undefined as unknown as NativeReadRequest };
      record.adapter = { url: () => record.url, method: () => record.method, headers: () => ({ ...record.headers }), postData: () => record.body,
        resourceType: () => record.kind, isNavigationRequest: () => record.kind === "document", frame: () => page.mainFrame(),
        redirectedFrom: () => record.parent?.adapter ?? null, response: async () => {
          const value = await bounded(record.response.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT"); if (value instanceof Error) throw value; return value;
        } };
      records.set(record.id, record);
      const route: NativeReadRoute = { request: () => record.adapter,
        continue: async values => {
          if (!record.paused || closed || record.failed || options.signal?.aborted || values && Object.keys(values).some(key => key !== "url") ||
              values?.url && values.url !== record.url && canonicalPublicReadUrl(record.url, record.method) !== values.url)
            throw new Error("NATIVE_REDIRECT_CONTINUE_REJECTED");
          record.paused = false; record.admitted = true; record.transportUrl = values?.url ?? record.url;
          await bounded(cdp.send("Fetch.continueRequest", { requestId: record.id, ...(record.transportUrl !== record.url ? { url: record.transportUrl } : {}) }),
            "NATIVE_REDIRECT_REQUEST_TIMEOUT");
        },
        abort: async () => {
          if (record.paused && !closed) { record.paused = false; failRecord(record, "NATIVE_REDIRECT_REQUEST_REJECTED"); await reject(); }
        },
        fulfill: async () => { throw new Error("NATIVE_REDIRECT_FULFILL_REJECTED"); },
      };
      try { await handler(route); }
      catch (error) {
        await route.abort().catch(() => {});
        if (record.failureCode === "NATIVE_REDIRECT_NETWORK_FAILED" && error instanceof Error && error.message === record.failureCode) return;
        await close("NATIVE_REDIRECT_HANDLER_FAILED");
      }
    })().catch(error => { void close(error instanceof Error && /^[A-Z_0-9]+$/u.test(error.message) ? error.message : "NATIVE_REDIRECT_ROUTING_FAILED"); })
      .finally(() => { pendingReads--; });
  });
  try {
    await cdp.send("Network.enable", { maxTotalBufferSize: PUBLIC_BROWSER_TOTAL_BYTES, maxResourceBufferSize: 16_000_000, maxPostDataSize: 32768 });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    enabled = true;
    if (options.signal?.aborted) { await close("NATIVE_REDIRECT_CANCELLED"); options.signal.throwIfAborted(); }
  } catch (error) { await close("NATIVE_REDIRECT_INSTALL_FAILED"); throw error; }
  return {
    prepare(frame: Frame) {
      if (closed || !enabled || frame !== page.mainFrame()) { failure("NATIVE_REDIRECT_FRAME_UNGUARDED"); throw new Error("NATIVE_REDIRECT_FRAME_UNGUARDED"); }
    },
    /** Release only Playwright's independent pause. CDP owns policy, exact
     * response identity, dispatch and leases; this never supplies evidence. */
    async releasePlaywrightRoute(route: Route) {
      try {
        if (closed || !enabled || options.signal?.aborted) throw new Error("NATIVE_REDIRECT_CLOSED");
        const request = route.request();
        if (request.frame() !== page.mainFrame() || request.frame().page() !== page) throw new Error("NATIVE_REDIRECT_FRAME_UNGUARDED");
        await bounded(route.continue(), "NATIVE_REDIRECT_REQUEST_TIMEOUT");
      } catch {
        // A popup request can precede frame creation. Missing/foreign frame
        // metadata must abort; its public-looking URL grants no authority.
        await route.abort().catch(() => {});
      }
    },
    get pendingReads() { return pendingReads; },
    get lastFailure() { return lastFailure; }, close: () => close(),
  };
}
