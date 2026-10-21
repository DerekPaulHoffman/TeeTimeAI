import type { Frame, Page, Response, Route } from "@playwright/test";
import { canonicalPublicReadUrl } from "./public-request-url";
import { PUBLIC_BROWSER_TOTAL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl } from "./recipe";

/** One CDP owner validates every initial/redirected read. Evidence comes from
 * that exact request's paused Chrome response, independently of page body use. */
export interface NativeReadRequest {
  url(): string; method(): string; headers(): Record<string, string>; postData(): string | null;
  resourceType(): string; isNavigationRequest(): boolean; frame(): Frame;
  redirectedFrom(): NativeReadRequest | null; response(): Promise<NativeReadResponse | null>;
}
export type NativeReadResponse = Pick<Response, "url" | "status" | "allHeaders" | "finished" | "body">;
export type NativeReadRoute = Pick<Route, "continue" | "abort" | "fulfill"> & { request(): NativeReadRequest };
export type NativeRequestDiagnostic = {
  code: string; url?: string; method?: string; resourceType?: string;
  phase?: "RESPONSE_WAIT" | "CONTINUE_RESPONSE_ACK";
  interceptedRequests?: number; recordCount?: number; requestLimit?: number; postDataBytes?: number;
  framePresent?: boolean; rootFrame?: boolean; networkIdPresent?: boolean; duplicateRequestId?: boolean;
  hasPostData?: boolean; postDataPresent?: boolean;
};
export type NativeFirstFatal = NativeRequestDiagnostic;
export type NativeRedirectRouting = {
  prepare(frame: Frame): void; releasePlaywrightRoute(route: Route): Promise<void>; close(): Promise<void>;
  readonly pendingReads: number; readonly lastFailure: string | undefined; readonly firstFatal?: NativeFirstFatal;
  readonly rejectedRequests?: NativeRequestDiagnostic[];
};
// Only this controller can attest that Chrome has terminated the exact read.
// A provider string or an unrelated Error with the same message grants no such
// lifecycle authority and must retain the caller's normal network cleanup.
const terminalNetworkFailures = new WeakSet<Error>();
export function isNativeReadTerminalFailure(value: unknown): value is Error {
  return value instanceof Error && terminalNetworkFailures.has(value);
}
function terminalNetworkFailure() {
  const error = new Error("NATIVE_REDIRECT_NETWORK_FAILED");
  terminalNetworkFailures.add(error);
  return error;
}
function pending<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
type RecordEntry = {
  id: string; networkId: string; url: string; transportUrl: string; method: string; headers: Record<string, string>; body: string | null;
  kind: string; parent: RecordEntry | null; depth: number; paused: boolean; admitted: boolean; failed: boolean; responseStarted: boolean; complete: boolean;
  failureCode?: string; failure?: Error;
  redirect?: { status: number; target: string }; redirectChildId?: string;
  adapter: NativeReadRequest; response: ReturnType<typeof pending<NativeReadResponse | Error>>;
};
type NativeRecordOwner = { closed: boolean };
// Only adapters minted by this controller have redirect provenance. A model,
// Playwright lookalike, diagnostic or caller-supplied redirectedFrom chain does
// not gain authority by exposing the same methods or URL strings.
const nativeRequestRecords = new WeakMap<object, { record: RecordEntry; owner: NativeRecordOwner }>();
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
function releasedRedirect(record: RecordEntry, target: string) {
  return record.admitted && record.complete && !record.failed && record.redirect?.target === target;
}
function trustedDocumentChain(record: RecordEntry, owner: NativeRecordOwner, roots: ReadonlySet<string>) {
  if (owner.closed || record.depth > 5) return false;
  let current = record;
  for (;;) {
    if (current.kind !== "document" || !["GET", "HEAD"].includes(current.method) || current.failed ||
        !isSafeRecipeUrl(current.url) || !isSafeRecipeUrl(current.transportUrl)) return false;
    if (!current.parent) return current.admitted && roots.has(current.url);
    if (current.method !== current.parent.method || !releasedRedirect(current.parent, current.url)) return false;
    current = current.parent;
  }
}
/** Exact completed HTTP provenance only; callers still apply their URL, route,
 * CPS session, DNS and provider-lease policies to every individual hop. */
export function hasAttestedNativeDocumentRedirect(request: object, roots: ReadonlySet<string>) {
  const value = nativeRequestRecords.get(request);
  return Boolean(value && value.record.parent && trustedDocumentChain(value.record, value.owner, roots));
}
export function hasAttestedNativeDocumentRedirectTarget(request: object, target: string, roots: ReadonlySet<string>) {
  const value = nativeRequestRecords.get(request);
  return Boolean(value && value.record.depth < 5 && releasedRedirect(value.record, target) &&
    isSafeRecipeUrl(target) && trustedDocumentChain(value.record, value.owner, roots));
}
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
  onRequestRejected?: (request: NativeRequestDiagnostic) => void;
  onSubframeBlocked?: (request: { url: string; resourceType: string }) => void;
} = {}): Promise<NativeRedirectRouting> {
  options.signal?.throwIfAborted();
  const limit = Math.min(1024, Math.max(1, options.maxRequests ?? 256));
  const timeoutMs = Math.min(15_000, Math.max(100, options.timeoutMs ?? 15_000));
  const cdp = await page.context().newCDPSession(page);
  const rootFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const records = new Map<string, RecordEntry>();
  const owner: NativeRecordOwner = { closed: false };
  const rejectedRequests: NativeRequestDiagnostic[] = [];
  let closing: Promise<void> | undefined, closed = false, enabled = false, lastFailure: string | undefined, firstFatal: NativeFirstFatal | undefined;
  let interceptedRequests = 0, pendingReads = 0, responseBytes = 0;
  const failure = (code: string) => { lastFailure = code; try { options.onFailure?.(code); } catch { /* Diagnostics cannot authorize work. */ } };
  const onAbort = () => { void close("NATIVE_REDIRECT_CANCELLED"); };
  function close(code = "NATIVE_REDIRECT_CLOSED") {
    if (closing) return closing;
    closed = true;
    owner.closed = true;
    if (code !== "NATIVE_REDIRECT_CLOSED") { firstFatal ??= { code }; failure(code); }
    options.signal?.removeEventListener("abort", onAbort);
    for (const record of records.values()) { record.failed = true; record.response.settle(new Error(code)); }
    // Never detach interception while paused requests could resume.
    closing = (async () => { await page.close({ runBeforeUnload: false }).catch(() => {}); await cdp.detach().catch(() => {}); })();
    return closing;
  }
  const bounded = async <T>(promise: Promise<T>, code: string, timeoutDiagnostic?: () => NativeRequestDiagnostic): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Capture the exact initiating read before generic session cleanup
        // records a code-only failure. Diagnostics cannot alter fatal cleanup.
        try { if (timeoutDiagnostic) firstFatal ??= { ...timeoutDiagnostic(), code }; } catch { /* Keep the original timeout. */ }
        reject(new Error(code)); void close(code);
      }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const recordCommand = async <T>(record: RecordEntry, command: Promise<T>, code: string, timeoutDiagnostic?: () => NativeRequestDiagnostic): Promise<T> => {
    // A terminal attestation belongs only to this exact record. It ends that
    // command's wait, never authorizes a response or changes another record.
    const terminated = record.response.promise.then(value => {
      if (isNativeReadTerminalFailure(value)) throw value;
      return new Promise<never>(() => {});
    });
    try { return await bounded(Promise.race([command, terminated]), code, timeoutDiagnostic); }
    catch (error) {
      if (record.failure && isNativeReadTerminalFailure(record.failure)) throw record.failure;
      throw error;
    }
  };
  const failRecord = (record: RecordEntry, code: string) => {
    // Cleanup must not replace the exact terminal cause while this read waits
    // for its provider lane, or turn it into another host-wide cancellation.
    if (record.failed) return;
    record.failed = true; record.failureCode = code;
    record.failure = code === "NATIVE_REDIRECT_NETWORK_FAILED" ? terminalNetworkFailure() : new Error(code);
    record.response.settle(record.failure);
  };
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
      const requestDiagnostic = (code: string): NativeRequestDiagnostic => {
        let url: string | undefined;
        const kind = resourceKinds[event.resourceType] ?? "other";
        const method = /^(?:GET|HEAD|POST|OPTIONS|PUT|PATCH|DELETE|CONNECT|TRACE)$/u.test(event.request.method) ? event.request.method : "OTHER";
        try {
          const value = new URL(event.request.url); value.search = ""; value.hash = "";
          if (value.protocol === "https:" && value.href.length <= 2048 && (isSafeRecipeUrl(value.href) || isSafeBrowserAssetUrl(value.href, kind, method)))
            url = `${value.origin}${value.pathname}`;
        } catch { /* Unsafe/private/session paths stay absent from diagnostics. */ }
        // Never retain raw IDs, headers, body, query values or source events.
        return { code, ...(url ? { url } : {}), method, resourceType: kind,
          interceptedRequests, recordCount: records.size, requestLimit: limit,
          framePresent: Boolean(event.frameId), rootFrame: event.frameId === rootFrameId,
          networkIdPresent: Boolean(event.networkId), duplicateRequestId: records.has(event.requestId),
          hasPostData: event.request.hasPostData === true, postDataPresent: typeof event.request.postData === "string",
          postDataBytes: Math.min(1_000_000, typeof event.request.postData === "string" ? Buffer.byteLength(event.request.postData) : 0) };
      };
      const responseTimeoutDiagnostic = (record: RecordEntry, phase: NonNullable<NativeRequestDiagnostic["phase"]>): NativeRequestDiagnostic => ({
        ...requestDiagnostic("NATIVE_REDIRECT_RESPONSE_TIMEOUT"), phase, method: record.method, resourceType: record.kind,
        // This record already passed the initial duplicate/body checks. The
        // response pause itself is not a duplicate initial request.
        duplicateRequestId: false, hasPostData: record.body !== null, postDataPresent: record.body !== null,
        postDataBytes: Math.min(1_000_000, record.body === null ? 0 : Buffer.byteLength(record.body)),
      });
      const rejectInitial = async (code: string) => {
        // Retain one initiating classification before awaiting rejection.
        firstFatal ??= requestDiagnostic(code);
        await reject(); await close(code);
      };
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        const record = records.get(event.requestId);
        // Chrome can terminate a paused read while it waits for a provider
        // lane. Its exact error callback may be drained without admitting a
        // request or producing response evidence; all identity checks remain.
        const failedBeforeAdmission = record && !record.admitted && event.responseErrorReason &&
          isNativeReadTerminalFailure(record.failure);
        // Enumerate the same fail-closed checks without retaining headers,
        // request bodies or provider error text in diagnostics.
        const mismatch = !record ? "NATIVE_REDIRECT_RESPONSE_UNKNOWN" : !record.admitted && !failedBeforeAdmission ? "NATIVE_REDIRECT_RESPONSE_UNADMITTED" :
          record.failed && !(record.failureCode === "NATIVE_REDIRECT_NETWORK_FAILED" && event.responseErrorReason) ? "NATIVE_REDIRECT_RESPONSE_PRIOR_FAILURE" : record.responseStarted ? "NATIVE_REDIRECT_RESPONSE_DUPLICATE" :
            record.paused && !failedBeforeAdmission ? "NATIVE_REDIRECT_RESPONSE_REQUEST_PAUSED" : record.networkId !== event.networkId ? "NATIVE_REDIRECT_RESPONSE_NETWORK_MISMATCH" :
              record.transportUrl !== event.request.url ? "NATIVE_REDIRECT_RESPONSE_URL_MISMATCH" : record.method !== event.request.method ? "NATIVE_REDIRECT_RESPONSE_METHOD_MISMATCH" :
                event.frameId !== rootFrameId ? "NATIVE_REDIRECT_RESPONSE_FRAME_MISMATCH" : !event.responseErrorReason &&
                  (!Number.isInteger(event.responseStatusCode) || event.responseStatusCode! < 100 || event.responseStatusCode! > 599) ? "NATIVE_REDIRECT_RESPONSE_STATUS_INVALID" : undefined;
        if (mismatch || !record) { await close(mismatch ?? "NATIVE_REDIRECT_RESPONSE_UNKNOWN"); return; }
        record.responseStarted = true;
        if (event.responseErrorReason) {
          // Chrome has failed this exact admitted read. Do not create response
          // evidence or close unrelated documents/reads because an optional
          // resource failed. The root page.goto still reports navigation failure.
          record.paused = false;
          failRecord(record, "NATIVE_REDIRECT_NETWORK_FAILED");
          await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
          return;
        }
        try {
          const status = event.responseStatusCode!, values = responseHeaders(event.responseHeaders ?? []);
          const maxBytes = publicBrowserResponseLimit(record.kind), declared = Number(values["content-length"] ?? 0);
          if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) { await close("NATIVE_RESPONSE_LIMIT"); return; }
          const noBody = record.method === "HEAD" || [204, 205, 304].includes(status) || status >= 300 && status < 400;
          // Network.loadingFinished can wait for page JavaScript to consume a
          // Fetch body, deadlocking Promise.all behind a serialized provider lease.
          const body = noBody ? Buffer.alloc(0) : await recordCommand(record, cdp.send("Fetch.getResponseBody", { requestId: record.id }), "NATIVE_REDIRECT_BODY_TIMEOUT")
            .then(value => Buffer.from(value.body, value.base64Encoded ? "base64" : "utf8"));
          responseBytes += body.length;
          if (body.length > maxBytes || responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) { await close("NATIVE_RESPONSE_LIMIT"); return; }
          if (closed || options.signal?.aborted || record.failed) return;
          // Preserve the actual status, headers and body. Completion follows the
          // successful unchanged release, never a fabricated/fulfilled response.
          await recordCommand(record, cdp.send("Fetch.continueResponse", { requestId: record.id }), "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
            () => responseTimeoutDiagnostic(record, "CONTINUE_RESPONSE_ACK"));
          if (closed || options.signal?.aborted || record.failed) return;
          // Publish redirect authority only after Chrome acknowledges the
          // unchanged response release. A Location alone, failed release, or
          // duplicate header never attests a navigation.
          if (redirectStatuses.has(status) && (event.responseHeaders ?? []).filter(item => item.name.toLowerCase() === "location").length === 1) {
            try { record.redirect = { status, target: new URL(values.location, record.transportUrl).href }; }
            catch { /* An invalid Location cannot authorize a child request. */ }
          }
          record.complete = true;
          record.response.settle({ url: () => record.transportUrl, status: () => status, allHeaders: async () => ({ ...values }),
            finished: async () => null, body: async () => body });
          return;
        } catch (error) {
          if (error === record.failure && isNativeReadTerminalFailure(error)) return;
          throw error;
        }
      }
      if (++interceptedRequests > limit) { await rejectInitial("NATIVE_REDIRECT_INTERCEPT_LIMIT"); return; }
      if (event.frameId && event.frameId !== rootFrameId) {
        await reject();
        try { options.onSubframeBlocked?.({ url: event.request.url, resourceType: resourceKinds[event.resourceType] ?? "other" }); }
        catch { /* A diagnostic must not change the denial. */ }
        return;
      }
      const metadataRejection = records.size >= limit ? "NATIVE_REDIRECT_RECORD_LIMIT" : records.has(event.requestId) ? "NATIVE_REDIRECT_DUPLICATE_FETCH_ID" :
        event.frameId !== rootFrameId ? "NATIVE_REDIRECT_FRAME_MISSING" : undefined;
      if (metadataRejection) { await rejectInitial(metadataRejection); return; }
      if (event.resourceType === "Ping") {
        // Ancillary beacons are never availability reads. Deny the exact pause
        // without requiring network identity or creating an admitted record.
        // Cap/frame/duplicate checks above and bounded abort failure still win.
        const diagnostic = requestDiagnostic("NATIVE_REDIRECT_PING_UNSUPPORTED");
        await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
        rejectedRequests.push(diagnostic);
        if (rejectedRequests.length > 12) rejectedRequests.shift();
        try { options.onRequestRejected?.({ ...diagnostic }); } catch { /* Diagnostics cannot authorize work. */ }
        return;
      }
      const networkId = event.networkId;
      if (!networkId) { await rejectInitial("NATIVE_REDIRECT_NETWORK_ID_MISSING"); return; }
      const rejection = event.request.hasPostData && event.request.postData === undefined ? "NATIVE_REDIRECT_POST_BODY_MISSING" :
        (typeof event.request.postData === "string" ? Buffer.byteLength(event.request.postData) : 0) > 32768 ? "NATIVE_REDIRECT_POST_BODY_LIMIT" : undefined;
      if (rejection) {
        if (rejection === "NATIVE_REDIRECT_POST_BODY_LIMIT" && event.request.method === "POST") {
          // This body cannot be admitted to any public-read policy. Deny its
          // exact pause without constructing a request/response record, while
          // retaining every metadata/cap/missing-body guard above. Failed or
          // hanging rejection still closes the session through bounded().
          const diagnostic = requestDiagnostic(rejection);
          await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
          rejectedRequests.push(diagnostic);
          if (rejectedRequests.length > 12) rejectedRequests.shift();
          try { options.onRequestRejected?.({ ...diagnostic }); } catch { /* Diagnostics cannot authorize work. */ }
          return;
        }
        await rejectInitial(rejection); return;
      }
      const parent = event.redirectedRequestId ? records.get(event.redirectedRequestId) : null;
      if (event.redirectedRequestId && (!parent || !parent.admitted || parent.failed || parent.depth >= 5 || parent.redirectChildId)) {
        await reject(); await close("NATIVE_REDIRECT_PROVENANCE_REJECTED"); return;
      }
      const kind = resourceKinds[event.resourceType];
      if (!kind) { await reject(); await close("NATIVE_REDIRECT_RESOURCE_REJECTED"); return; }
      if (parent) {
        parent.redirectChildId = event.requestId;
        // A redirected child may pause before the parent's route handler
        // resumes. Wait outside the child handler/provider lane for that exact
        // parent's successful release; no FIFO/URL inference or origin grant.
        const result = await bounded(parent.response.promise, "NATIVE_REDIRECT_PROVENANCE_TIMEOUT");
        const document = kind === "document";
        let sameHost = false;
        try { sameHost = new URL(parent.transportUrl).hostname.replace(/^www\./u, "") === new URL(event.request.url).hostname.replace(/^www\./u, ""); }
        catch { /* Invalid URLs fail the provenance check. */ }
        if (result instanceof Error || closed || options.signal?.aborted || records.has(event.requestId) || !releasedRedirect(parent, event.request.url) ||
            event.request.method !== parent.method || document && (parent.kind !== "document" || !["GET", "HEAD"].includes(parent.method))) {
          await reject(); await close("NATIVE_REDIRECT_PROVENANCE_REJECTED"); return;
        }
        if (!document && !sameHost) {
          // A genuine Script->Script CDN redirect still has no cross-host
          // read permission. Deny that exact browser pause without destroying
          // unrelated public documents/data. This is not a fallback for bad
          // provenance: the exact released Location, method, frame, network
          // chain, kind and depth must all already be established.
          if (kind === "script" && parent.kind === kind && ["GET", "HEAD"].includes(parent.method) &&
              networkId === parent.networkId && (isSafeRecipeUrl(event.request.url) || isSafeBrowserAssetUrl(event.request.url, kind, "GET"))) {
            const diagnostic = requestDiagnostic("NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED");
            await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
            if (closed || options.signal?.aborted) return;
            rejectedRequests.push(diagnostic);
            if (rejectedRequests.length > 12) rejectedRequests.shift();
            try { options.onRequestRejected?.({ ...diagnostic }); } catch { /* Diagnostics cannot authorize work. */ }
            return;
          }
          await reject(); await close("NATIVE_REDIRECT_PROVENANCE_REJECTED"); return;
        }
      }
      const record: RecordEntry = { id: event.requestId, networkId, url: event.request.url, transportUrl: event.request.url,
        method: event.request.method, headers: headers(event.request.headers), body: event.request.postData ?? null, kind,
        parent: parent ?? null, depth: parent ? parent.depth + 1 : 0, paused: true, admitted: false, failed: false, responseStarted: false, complete: false,
        response: pending(), adapter: undefined as unknown as NativeReadRequest };
      record.adapter = { url: () => record.url, method: () => record.method, headers: () => ({ ...record.headers }), postData: () => record.body,
        resourceType: () => record.kind, isNavigationRequest: () => record.kind === "document", frame: () => page.mainFrame(),
        redirectedFrom: () => record.parent?.adapter ?? null, response: async () => {
          const value = await bounded(record.response.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
            () => responseTimeoutDiagnostic(record, "RESPONSE_WAIT")); if (value instanceof Error) throw value; return value;
        } };
      nativeRequestRecords.set(record.adapter, { record, owner });
      records.set(record.id, record);
      const route: NativeReadRoute = { request: () => record.adapter,
        continue: async values => {
          if (record.failure && isNativeReadTerminalFailure(record.failure)) throw record.failure;
          if (!record.paused || closed || record.failed || options.signal?.aborted || values && Object.keys(values).some(key => key !== "url") ||
              values?.url && values.url !== record.url && canonicalPublicReadUrl(record.url, record.method) !== values.url)
            throw new Error("NATIVE_REDIRECT_CONTINUE_REJECTED");
          record.paused = false; record.admitted = true; record.transportUrl = values?.url ?? record.url;
          // Chrome may terminate this exact read while its continuation command
          // is pending. End only that wait on a controller-branded terminal
          // failure; an unknown command failure or hang retains bounded cleanup.
          await recordCommand(record, cdp.send("Fetch.continueRequest", { requestId: record.id, ...(record.transportUrl !== record.url ? { url: record.transportUrl } : {}) }),
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
    get lastFailure() { return lastFailure; }, get firstFatal() { return firstFatal ? { ...firstFatal } : undefined; },
    get rejectedRequests() { return rejectedRequests.map(request => ({ ...request })); }, close: () => close(),
  };
}
