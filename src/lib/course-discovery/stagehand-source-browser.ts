import type { Browser, BrowserContext, CDPSession, Frame, LaunchOptions, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchPublicReadBrowser, ownedPublicBrowserCdp } from "./public-browser-launch";
import { connectOwnedSourceCdp, type OwnedCdpSession, type OwnedCdpFailure } from "./stagehand-owned-cdp";
import { createStagehandNativeRouterFailureCapture } from "./stagehand-native-router-diagnostic";
import { createNativePublicBrowserProxy, continueNativeBrowserRead, isObservedNativeRedirect, nativeReadPreflightMethod, type NativePublicProxyDependencies } from "./native-public-browser";
import { installNativeRedirectRouting, authorizePublicClientReadHeaders, isCurrentPublicClientReadHeaders, nativePublicClientPreflightMethod,
  nativeMindbodyBootstrapSource, attestedNativeDocumentRedirects, type NativeReadRoute, type NativeReadRequest, type NativeRedirectRouting } from "./native-redirect-routing";
import { isSafeRecipeUrl, isSafeBrowserAssetUrl, isSafeBrowserBootstrapReadUrl, isSafeBrowserAvailabilityReadUrl } from "./recipe";
import { canonicalPublicReadUrl } from "./public-request-url";
import { requestFamilyForUrl } from "./request-family";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { isIncidentalBrowserRequest, isNonEvidenceBrowserResource } from "@/lib/automation/passfactory-public-read-policy";
import { isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { isMindbodyClassicPublicBootstrapPost } from "@/lib/automation/mindbody-public-read-policy";
import { PUBLIC_BROWSER_REQUEST_LIMIT, PUBLIC_BROWSER_TOTAL_BYTES, SOURCE_ROUTING_RESPONSE_PROFILE, publicBrowserResponseLimit, assertPublicBrowserRequestBudget } from "./browser-resource-limits";

type Lease = <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
type Target = { id: string; contextId: string; cdp: OwnedCdpSession; page: Page; frame: Frame; currentUrl: string; documentRequest?: NativeReadRequest; documentStatus?: number; documentRead?: Promise<unknown>; documentReadPending?: boolean; popupReads?: Map<string, PopupRead>; router?: NativeRedirectRouting; ready: Promise<void>; installed?: boolean; discarded?: boolean; initialization?: "NETWORK" | "FETCH" | "RESUME" | "ROUTER" | "READY" };
type PopupGrant = { url: string; until: number; used: boolean };
type PopupRead = { id: string; networkId: string; url: string; method: string; frameId: string; hop: number; complete: boolean;
  redirect?: string; pendingRedirect?: string; successorId?: string; continuationAck?: Promise<void>; completion?: Promise<unknown>; queueComplete?: boolean; status?: number;
  response: Promise<Record<string, unknown>>; resolve(value: Record<string, unknown>): void };
type Dependencies = { requestLease: Lease; proxyDependencies?: NativePublicProxyDependencies; launchBrowser?: (options: LaunchOptions) => Promise<Browser>;
  contextOptions?: { ignoreHTTPSErrors?: boolean } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reject = () => new Error("STAGEHAND_GUARDED_SOURCE_REJECTED");
// Fixed controller source, never caller/model/site JavaScript. Install only on
// the owned public context; the packaged SDK extension context is untouched.
export const stagehandSourceWorkerDenialScript = `(()=>{for(const name of ['Worker','SharedWorker']){Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});const d=Object.getOwnPropertyDescriptor(globalThis,name);if(!d||d.value!==undefined||d.writable||d.configurable)throw new Error('STAGEHAND_WORKER_DENIAL_UNAVAILABLE');}})()`;
export async function registerStagehandSourceWorkerDenial(context: Pick<BrowserContext, "addInitScript">) {
  // Register once before this context has any pages. Playwright installs the
  // fixed script for every later document, including a popup's first document.
  // No command must evaluate/register in an already debugger-paused popup.
  await context.addInitScript({ content: stagehandSourceWorkerDenialScript });
}
export async function requireDeniedStagehandTargetClosed(root: Pick<OwnedCdpSession, "send">, targetId: string) {
  const closed = await root.send("Target.closeTarget", { targetId });
  if (record(closed).success !== true) throw reject();
}
/** Waiting for a native ACK grants no redirect authority. The original source
 * deadline, cancellation and existing 15-second response bound still apply. */
export async function awaitStagehandPopupContinuation(ack: Promise<unknown>, signal: AbortSignal, deadlineAt: number) {
  void ack.catch(() => undefined); // Observe rejection even if cancellation already won.
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    await Promise.race([ack, new Promise<never>((_, fail) => {
      abort = () => fail(reject());
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(reject()), Math.max(1, Math.min(15_000, deadlineAt - Date.now())));
    })]);
    signal.throwIfAborted();
    if (Date.now() >= deadlineAt) throw reject();
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
}
function transactionUrl(value: string) {
  try {
    let path = new URL(value).pathname;
    for (let i = 0; i < 4; i++) { const next = decodeURIComponent(path); if (next === path) break; path = next; }
    path = new URL(path.replace(/\\/gu, "/"), "https://public.example").pathname;
    return /^\/ASP\/appt_req\.asp\/?$/iu.test(path);
  } catch { return true; }
}
export function canonicalStagehandHostEntry(value: string) {
  if (!isSafeRecipeUrl(value) || transactionUrl(value)) throw reject();
  const url = new URL(value);
  if (url.href !== value && !(value === url.origin && url.pathname === "/" && !url.search && !url.hash)) throw reject();
  return url.href;
}
/** Fragments name a location in the same document; they never enter its native request. */
export function sameStagehandDocumentReadUrl(requestUrl: unknown, documentUrl: unknown) {
  if (typeof requestUrl !== "string" || typeof documentUrl !== "string") return false;
  return requestUrl.split("#", 1)[0] === documentUrl.split("#", 1)[0];
}
export function stagehandSourceBrowserMode(platform: NodeJS.Platform = process.platform) {
  // Extensions require the full browser's new headless mode. A bare headless
  // launch selects Playwright's extension-less chromium-headless-shell.
  return { headless: platform !== "win32", channel: platform === "win32" ? "chrome" : "chromium" };
}
export async function ownedStagehandExtension() {
  // The native helper runs in the same pinned npm checkout as the SDK driver.
  // No user extension directories, fallback installs, or global packages.
  const extensionPath = resolve(process.cwd(), "node_modules/@browserbasehq/stagehand/dist/extension");
  const packageValue = JSON.parse(await readFile(join(extensionPath, "../../package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  if (packageValue.version !== "4.3.0" || manifest.manifest_version !== 3 || manifest.key ||
      !Array.isArray(manifest.permissions) || !manifest.permissions.includes("debugger")) throw reject();
  // Chromium hashes FilePath native bytes (UTF-16 on Windows), with an upper
  // drive letter. This is the packaged extension identity, never a user ID.
  const nativePath = process.platform === "win32" ? extensionPath[0].toUpperCase() + extensionPath.slice(1) : extensionPath;
  const id = createHash("sha256").update(Buffer.from(nativePath, process.platform === "win32" ? "utf16le" : "utf8")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/gu, value => String.fromCharCode(97 + parseInt(value, 16)));
  return { path: extensionPath, id, origin: `chrome-extension://${id}` };
}

/** This browser is source-routing only. It has no adapter/proof/recipe/backend mutation surface.
 * Its private CDP attachment belongs only to the trusted SDK driver, never model data. */
export async function createGuardedStagehandSourceBrowser(input: { initialUrl: string; timeZone: string; deadlineAt: Date; signal?: AbortSignal }, deps: Dependencies) {
  const initialUrl = canonicalStagehandHostEntry(input.initialUrl);
  if (typeof deps.requestLease !== "function") throw reject();
  const remaining = input.deadlineAt.getTime() - Date.now();
  if (!(remaining > 0 && remaining <= 120_000)) throw reject();
  new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone });
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining), ...(input.signal ? [input.signal] : [])]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease, signal);
  const proxy = await createNativePublicBrowserProxy({ signal, requireHostAdmission: true }, deps.proxyDependencies);
  const allowed = new Set([initialUrl]), roots = new Set(allowed), targets = new Map<string, Target>(), activeReads = new Set<Promise<unknown>>();
  const popupGrants = new Map<string, PopupGrant>();
  const frameEntries = new Map<string, { pageUrl: string; frameUrl: string; observedAt: string; documentHash: string; until: number }>();
  let frameEntryCount = 0;
  const nativeFailure = createStagehandNativeRouterFailureCapture();
  let ownedPageCrashObserved = false, ownedPageCloseObserved = false, contextClosedObserved = false;
  let socketBoundaryState: { browserConnectedAtFailure: boolean; ownedPageCrashObserved: boolean; ownedPageCloseObserved: boolean; contextClosedObserved: boolean } | undefined;
  const cdpFailure = () => {
    const first = cdp?.failureDiagnostic();
    return first ? { ...first, ...socketBoundaryState } : undefined;
  };
  let browser: Browser | undefined, context: BrowserContext | undefined, cdp: Awaited<ReturnType<typeof connectOwnedSourceCdp>> | undefined;
  let contextId = "", targetId = "", closing: Promise<{ browserClosed: boolean; providerRequestsDrained: boolean; ownedCdpFailure?: OwnedCdpFailure }> | undefined;
  let closed = false, terminal = false, intercepted = 0, admitted = 0, rejected = 0, bytes = 0, popupCount = 0, deniedWorkers = 0;
  const check = () => { signal.throwIfAborted(); if (closed || terminal) throw reject(); };
  const close = () => closing ??= (async () => {
    // Preserve only facts observed before teardown; cleanup RPCs cannot become
    // this attempt's recorded protocol failure.
    const ownedCdpFailure = cdpFailure();
    closed = true; cancellation.abort("STAGEHAND_SOURCE_CLOSED"); queue.dispose();
    await Promise.allSettled([...targets.values()].map(target => target.router?.close()));
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await proxy.close(); cdp?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...activeReads]), new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); })]); }
    finally { clearTimeout(timer); }
    return { browserClosed: !browser?.isConnected() && activeReads.size === 0, providerRequestsDrained: activeReads.size === 0,
      ...(ownedCdpFailure ? { ownedCdpFailure } : {}) };
  })();
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });

  const handle = async (route: NativeReadRoute, target: Target) => {
    if (++intercepted > 1024) { terminal = true; await route.abort().catch(() => {}); void close(); return; }
    const request = route.request(), method = request.method(), transportUrl = canonicalPublicReadUrl(request.url(), method);
    if (isIncidentalBrowserRequest(request.url()) || isNonEvidenceBrowserResource(request.url(), request.resourceType())) { rejected++; await route.abort(); return; }
    try {
      check();
      if (transactionUrl(transportUrl)) throw reject();
      if (request.frame().page() !== target.page || request.frame() !== target.frame) throw reject();
      const url = new URL(transportUrl), headers = request.headers(), body = request.postData();
      const publicHeaders = method === "OPTIONS" || Object.keys(headers).some(key => /^(?:authorization|x-api-key)$/iu.test(key))
        ? await authorizePublicClientReadHeaders(request) : null;
      const preflight = method === "OPTIONS" ? nativeReadPreflightMethod(headers) || publicHeaders && nativePublicClientPreflightMethod(request, publicHeaders) : null;
      const purposeMethod = preflight || method, kind = preflight ? "fetch" : request.resourceType();
      if (!isSafeRecipeUrl(transportUrl) && !isSafeBrowserAssetUrl(transportUrl, request.resourceType(), method) &&
          !isSafeBrowserBootstrapReadUrl(transportUrl, kind, purposeMethod) && !isSafeBrowserAvailabilityReadUrl(transportUrl, kind, purposeMethod)) throw reject();
      if (Object.keys(headers).some(key => /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key)) && !publicHeaders) throw reject();
      const bootstrap = nativeMindbodyBootstrapSource(request);
      const bootstrapPost = method === "POST" && body !== null && bootstrap && roots.has(bootstrap.sourceUrl) &&
        isMindbodyClassicPublicBootstrapPost(url, new Headers(headers), body, bootstrap.sourceUrl);
      if (request.isNavigationRequest()) {
        if (!allowed.has(transportUrl) && !isObservedNativeRedirect(request, roots) && !bootstrapPost) throw reject();
        if (!["GET", "HEAD"].includes(method) && !bootstrapPost) throw reject();
      }
      // Preserve policy-bearing headers such as Next-Action. Removing them
      // could make a server mutation resemble an ordinary JSON read.
      const projectedHeaders = new Headers(headers);
      const publicPost = method === "POST" && body !== null && (isAnonymousBrowserReadPost(url, projectedHeaders, body) ||
        bootstrapPost);
      if (!["GET", "HEAD"].includes(method) && !preflight && !publicPost) throw reject();
      assertPublicBrowserRequestBudget(admitted, PUBLIC_BROWSER_REQUEST_LIMIT);
      if (bytes >= PUBLIC_BROWSER_TOTAL_BYTES) throw reject();
      admitted++;
      const operation = queue.run(requestFamilyForUrl(transportUrl), async () => {
        check();
        if (publicHeaders && !isCurrentPublicClientReadHeaders(publicHeaders)) throw reject();
        if (bootstrap && (!body || !isMindbodyClassicPublicBootstrapPost(url, new Headers(headers), body, bootstrap.sourceUrl))) throw reject();
        proxy.allowHostConnections(url.hostname);
        const response = await continueNativeBrowserRead(route, signal, publicBrowserResponseLimit(request.resourceType(), method, SOURCE_ROUTING_RESPONSE_PROFILE),
          () => proxy.cancelHostConnections(url.hostname), transportUrl);
        bytes += response.body.length;
        if (bytes > PUBLIC_BROWSER_TOTAL_BYTES) throw reject();
        return response;
      }, request.signal);
      if (request.isNavigationRequest() && method === "GET") { target.documentRequest = request; target.documentStatus = undefined; target.documentRead = operation; target.documentReadPending = true; }
      activeReads.add(operation);
      try {
        const response = await operation;
        if (target.documentRequest === request) target.documentStatus = response.status;
      } finally { activeReads.delete(operation); if (target.documentRead === operation) target.documentReadPending = false; }
    } catch {
      rejected++; await route.abort().catch(() => {});
    }
  };

  try {
    const extension = await ownedStagehandExtension();
    browser = await (deps.launchBrowser ?? (options => launchPublicReadBrowser(options, { localCdp: true })))({
      ...stagehandSourceBrowserMode(),
      timeout: Math.min(15_000, remaining), proxy: { server: proxy.server },
      ignoreDefaultArgs: ["--disable-extensions"], args: ["--disable-quic", "--enable-unsafe-extension-debugging", `--remote-allow-origins=${extension.origin}`],
    });
    const endpoint = ownedPublicBrowserCdp(browser);
    cdp = await connectOwnedSourceCdp(endpoint, signal, () => {
      if (!closed) {
        try { socketBoundaryState = { browserConnectedAtFailure: browser?.isConnected() === true, ownedPageCrashObserved, ownedPageCloseObserved, contextClosedObserved }; }
        catch { /* Observations cannot prevent guardian shutdown. */ }
        terminal = true; void close();
      }
    });
    const root = cdp.root;
    const installed = await root.send("Extensions.loadUnpacked", { path: extension.path, enableInIncognito: true });
    if (installed.id !== extension.id) throw reject();
    const before = new Set((record(await root.send("Target.getBrowserContexts")).browserContextIds as string[]) ?? []);
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, locale: "en-US", timezoneId: input.timeZone,
      proxy: { server: proxy.server, bypass: `127.0.0.1:${new URL(endpoint).port}` }, ...deps.contextOptions });
    await registerStagehandSourceWorkerDenial(context);
    context.on("close", () => { contextClosedObserved = true; });
    context.on("page", page => {
      page.on("crash", () => { ownedPageCrashObserved = true; });
      page.on("close", () => { ownedPageCloseObserved = true; });
    });
    const after = ((await root.send("Target.getBrowserContexts")).browserContextIds as string[]) ?? [];
    const fresh = after.filter(value => !before.has(value));
    if (fresh.length !== 1) throw reject(); contextId = fresh[0];
    await context.routeWebSocket("**/*", route => { route.close(); });
    const attachTarget = async (event: Record<string, unknown>) => {
      const info = record(event.targetInfo), sessionId = event.sessionId;
      if (typeof info.targetId !== "string" || typeof sessionId !== "string") throw reject();
      const child = cdp!.session(sessionId);
      if (info.type !== "page") {
        if (info.type === "service_worker" && info.url === `chrome-extension://${extension.id}/service-worker.js`) {
          await child.send("Runtime.runIfWaitingForDebugger").catch(() => {}); return;
        }
        deniedWorkers++; await requireDeniedStagehandTargetClosed(root, info.targetId); return;
      }
      child.on("Target.attachedToTarget", attachTarget);
      if (info.browserContextId !== contextId) {
        // SDK extension activation is internal control, never a public source page.
        if (typeof info.url === "string" && info.url.startsWith(extension.origin + "/")) {
          await child.send("Fetch.enable", { patterns: [{ urlPattern: "http://*", requestStage: "Request" }, { urlPattern: "https://*", requestStage: "Request" }] });
          child.on("Fetch.requestPaused", value => { void child.send("Fetch.failRequest", { requestId: value.requestId, errorReason: "BlockedByClient" }).catch(() => {}); });
          await child.send("Runtime.runIfWaitingForDebugger"); return;
        }
        // Leave the initial blank owned profile page until the guarded page exists.
        if (!targetId && info.url === "about:blank") { await child.send("Runtime.runIfWaitingForDebugger"); return; }
        await requireDeniedStagehandTargetClosed(root, info.targetId); return;
      }
      if (targets.size >= 8) { await root.send("Target.closeTarget", { targetId: info.targetId }); terminal = true; return; }
      const item = { id: info.targetId, contextId, cdp: child, currentUrl: typeof info.url === "string" ? info.url : "about:blank" } as Target;
      const opener = typeof info.openerId === "string" ? info.openerId : "";
      const frame = { url: () => item.currentUrl, page: () => item.page } as unknown as Frame;
      item.frame = frame;
      // A paused popup cannot answer the router's first getFrameTree until it
      // resumes. Pause ALL network first and retain the exact native events
      // until the existing router has installed its listeners. No request is
      // continued, synthesized, or admitted by this startup buffer.
      const startup: Array<{ method: string; value: Record<string, unknown> }> = [];
      const popupReads = new Map<string, PopupRead>();
      item.popupReads = popupReads;
      const deferredPopupIds = new Set<string>();
      const listeners = new Map<string, Set<(value: Record<string, unknown>) => unknown>>();
      let buffering = true, startupBytes = 0, deferredPopupBytes = 0;
      const popupDocument = (event: Record<string, unknown>) => {
        if (!opener || event.resourceType !== "Document" || typeof event.requestId !== "string") return false;
        const existing = popupReads.get(event.requestId);
        if (existing && (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined)) {
          existing.resolve(event); return true;
        }
        if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) return false;
        const request = record(event.request), method = request.method, url = request.url;
        const headers = record(request.headers), parent = typeof event.redirectedRequestId === "string" ? popupReads.get(event.redirectedRequestId) : undefined;
        const grant = popupGrants.get(opener), first = popupReads.size === 0;
        const uniqueSuccessor = !parent?.successorId || parent.successorId === event.requestId;
        const eventBytes = Buffer.byteLength(JSON.stringify(event));
        const safeRequest = typeof url === "string" && typeof event.networkId === "string" && event.frameId === item.id &&
          (method === "GET" || method === "HEAD") && request.hasPostData !== true && request.postData === undefined &&
          isSafeRecipeUrl(url) && !transactionUrl(url) && new URL(url).href === url &&
          !Object.keys(headers).some(key => /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key));
        if (safeRequest && uniqueSuccessor && !first && parent && !parent.queueComplete && parent.continuationAck && parent.completion && parent.pendingRedirect === url &&
            parent.frameId === event.frameId && parent.hop < 5 && !popupReads.has(event.requestId) && !deferredPopupIds.has(event.requestId) && deferredPopupIds.size < 5 &&
            startupBytes + deferredPopupBytes + eventBytes <= 2_000_000) {
          // Chrome can pause the exact successor before the controller sees
          // continueResponse's ACK. Retain that pause without dispatch/lease;
          // only the acknowledged, complete parent can admit it below.
          parent.successorId = event.requestId; deferredPopupIds.add(event.requestId); deferredPopupBytes += eventBytes;
          const waiting = Promise.all([parent.continuationAck, parent.completion]).then(() => {
            check(); deferredPopupIds.delete(event.requestId as string); popupDocument(event);
          }).catch(() => { if (!closed) { terminal = true; void close(); } });
          activeReads.add(waiting); void waiting.finally(() => {
            deferredPopupIds.delete(event.requestId as string); deferredPopupBytes -= eventBytes; activeReads.delete(waiting);
          });
          return true;
        }
        const valid = safeRequest && uniqueSuccessor && !popupReads.has(event.requestId) && !deferredPopupIds.has(event.requestId) &&
          (first ? targets.has(opener) && grant && !grant.used && Date.now() <= grant.until && grant.url === url :
            parent?.complete === true && parent.queueComplete === true && parent.redirect === url && parent.frameId === event.frameId && parent.hop < 5);
        if (!valid) {
          rejected++; item.discarded = true; targets.delete(item.id);
          void child.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
          void root.send("Target.closeTarget", { targetId: item.id }).catch(() => {}); return true;
        }
        if (first) grant!.used = true;
        if (parent) parent.successorId = event.requestId;
        let resolve!: PopupRead["resolve"];
        const response = new Promise<Record<string, unknown>>(done => { resolve = done; });
        const entry: PopupRead = { id: event.requestId, networkId: event.networkId as string, url: url as string, method: method as string,
          frameId: event.frameId as string, hop: parent ? parent.hop + 1 : 0, complete: false, response, resolve };
        popupReads.set(entry.id, entry);
        const operation = queue.run(requestFamilyForUrl(entry.url), async () => {
          check(); assertPublicBrowserRequestBudget(admitted, PUBLIC_BROWSER_REQUEST_LIMIT); admitted++; intercepted++;
          const host = new URL(entry.url).hostname; proxy.allowHostConnections(host);
          let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const responseDeadline = Math.min(input.deadlineAt.getTime(), Date.now() + 15_000);
            const bounded = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(reject()), Math.max(1, responseDeadline - Date.now())); });
            await child.send("Fetch.continueRequest", { requestId: entry.id });
            const value = await Promise.race([response, bounded]); check();
            if (value.responseErrorReason || value.frameId !== entry.frameId || value.networkId !== entry.networkId ||
                record(value.request).url !== entry.url || record(value.request).method !== entry.method) throw reject();
            const status = value.responseStatusCode;
            if (!Number.isInteger(status) || Number(status) < 100 || Number(status) > 599 || !Array.isArray(value.responseHeaders)) throw reject();
            entry.status = Number(status);
            const fields = value.responseHeaders as Array<{ name: string; value: string }>;
            if (fields.length > 256 || fields.some(field => typeof field.name !== "string" || typeof field.value !== "string")) throw reject();
            const declared = fields.filter(field => field.name.toLowerCase() === "content-length");
            if (declared.length > 1 || declared.length && (!/^\d{1,9}$/u.test(declared[0].value) || Number(declared[0].value) > publicBrowserResponseLimit("document"))) throw reject();
            const redirect = [301, 302, 303, 307, 308].includes(Number(status));
            const noBody = entry.method === "HEAD" || redirect || [204, 205, 304].includes(Number(status));
            const captured = noBody ? Buffer.alloc(0) : await Promise.race([child.send("Fetch.getResponseBody", { requestId: entry.id }).then(body => {
              if (typeof body.body !== "string") throw reject(); return Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
            }), bounded]);
            bytes += captured.length;
            if (captured.length > publicBrowserResponseLimit("document") || bytes > PUBLIC_BROWSER_TOTAL_BYTES) throw reject();
            const locations = fields.filter(field => field.name.toLowerCase() === "location");
            let next: string | undefined;
            if (redirect) {
              if (locations.length !== 1 || entry.hop >= 5) throw reject();
              next = new URL(locations[0].value, entry.url).href;
              if (!isSafeRecipeUrl(next) || transactionUrl(next)) throw reject();
            }
            check(); entry.pendingRedirect = next;
            entry.continuationAck = awaitStagehandPopupContinuation(child.send("Fetch.continueResponse", { requestId: entry.id }), signal,
              responseDeadline).then(() => {
              entry.redirect = next; entry.complete = true; finished = true;
            });
            await entry.continuationAck;
          } finally {
            clearTimeout(timer);
            if (!finished) { await child.send("Fetch.failRequest", { requestId: entry.id, errorReason: "BlockedByClient" }).catch(() => {}); await proxy.cancelHostConnections(host); }
          }
        }, signal).then(value => { entry.queueComplete = true; return value; });
        entry.completion = operation;
        activeReads.add(operation);
        void operation.catch(() => { if (!closed) { terminal = true; void close(); } }).finally(() => activeReads.delete(operation));
        return true;
      };
      for (const method of ["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameRequestedNavigation", "Network.requestWillBeSent", "Network.loadingFailed", "Fetch.requestPaused"]) {
        child.on(method, value => {
          if (method === "Fetch.requestPaused" && popupReads.has(value.requestId as string) && popupDocument(value)) return;
          if (buffering) {
            if (method === "Fetch.requestPaused" && popupDocument(value)) return;
            startupBytes += Buffer.byteLength(JSON.stringify(value));
            if (startup.length >= 256 || startupBytes + deferredPopupBytes > 2_000_000) { terminal = true; void close(); return; }
            startup.push({ method, value });
          } else for (const listener of listeners.get(method) ?? []) listener(value);
        });
      }
      const routedSession = { ...child,
        on(method: string, listener: (value: Record<string, unknown>) => unknown) {
          if (!listeners.has(method)) listeners.set(method, new Set()); listeners.get(method)!.add(listener);
        },
        off(method: string, listener: (value: Record<string, unknown>) => unknown) { listeners.get(method)?.delete(listener); },
      };
      item.page = { context: () => ({ newCDPSession: async () => routedSession as unknown as CDPSession }), mainFrame: () => frame,
        close: async () => { await root.send("Target.closeTarget", { targetId: item.id }).catch(() => {}); } } as unknown as Page;
      child.on("Page.frameNavigated", value => { const changed = record(value.frame); if (!changed.parentId && typeof changed.url === "string") item.currentUrl = changed.url; });
      child.on("Page.navigatedWithinDocument", value => { if (typeof value.url === "string") item.currentUrl = value.url; });
      item.ready = (async () => {
        await child.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }] });
        item.initialization = "FETCH";
        await child.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
        item.initialization = "RESUME";
        void child.send("Runtime.runIfWaitingForDebugger").catch(() => { if (!closed) { terminal = true; void close(); } });
        item.initialization = "NETWORK";
        await child.send("Network.enable", { maxTotalBufferSize: PUBLIC_BROWSER_TOTAL_BYTES, maxResourceBufferSize: 16_000_000, maxPostDataSize: 32768 });
        item.initialization = "ROUTER";
        item.router = await installNativeRedirectRouting(item.page, route => handle(route, item), { signal, maxRequests: 1024, responseProfile: SOURCE_ROUTING_RESPONSE_PROFILE,
          onCommandFailure: facts => { if (!closed) nativeFailure.record(facts.code, facts); },
          onSubframeBlocked: () => { rejected++; }, onFailure: code => {
            if (!closed) {
              try { nativeFailure.record(code, item.router?.firstFatal); } catch { /* Diagnostics cannot alter guardian failure. */ }
              terminal = true;
            }
          } });
        item.installed = true;
        item.initialization = "READY";
        buffering = false;
        for (const event of startup.splice(0)) {
          if (event.method.startsWith("Network.") && [...popupReads.values()].some(entry => entry.networkId === event.value.requestId)) continue;
          for (const listener of listeners.get(event.method) ?? []) listener(event.value);
        }
      })().catch(error => { if (!item.discarded && !closed) throw error; });
      targets.set(item.id, item); if (targetId) popupCount++;
      await item.ready;
    };
    root.on("Target.attachedToTarget", attachTarget);
    await root.send("Target.setDiscoverTargets", { discover: true });
    await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "page" }, { type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }] });
    const created = await root.send("Target.createTarget", { url: "about:blank", browserContextId: contextId, newWindow: true, background: false });
    if (typeof created.targetId !== "string") throw reject(); targetId = created.targetId;
    const until = Math.min(input.deadlineAt.getTime(), Date.now() + 5000);
    while (!targets.has(targetId) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const initial = targets.get(targetId); if (!initial) throw reject(); await initial.ready; check();
    // The unrouted default profile tab never becomes a discovery target.
    const infos = ((await root.send("Target.getTargets")).targetInfos as Array<Record<string, unknown>>) ?? [];
    for (const info of infos) if (info.type === "page" && info.browserContextId !== contextId && !String(info.url).startsWith(extension.origin + "/"))
      await requireDeniedStagehandTargetClosed(root, String(info.targetId));
    const assertGuardedTargets = async (ids: string[]) => {
      check();
      if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) return false;
      if (ids.some(id => !targets.has(id))) return false;
      await Promise.all(ids.map(id => targets.get(id)!.ready)); check();
      const live = ((await root.send("Target.getTargets")).targetInfos as Array<Record<string, unknown>>) ?? [];
      return ids.every(id => targets.get(id)?.installed === true && live.some(info => info.targetId === id && info.type === "page" && info.browserContextId === contextId));
    };
    const captureSourceDom = async (id: string, readinessOnly = false) => {
      if (!await assertGuardedTargets([id])) throw reject();
      const target = targets.get(id)!; await target.ready; check();
      const start = record((await target.cdp.send("Page.getFrameTree")).frameTree), startFrame = record(start.frame);
      const result = await target.cdp.send("Runtime.evaluate", { expression: `(()=>{const v={visible(e){if(!e.getClientRects().length)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||n.inert||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}return true;}};return JSON.stringify({url:location.href,readyState:document.readyState,bodyPresent:Boolean(document.body),links:[...document.querySelectorAll('a[href]')].filter(e=>v.visible(e)).slice(0,160).map(e=>e.href),frames:[...document.querySelectorAll('iframe[src]')].filter(e=>!e.hasAttribute('srcdoc')&&v.visible(e)).slice(0,24).map(e=>e.src)});})()`, returnByValue: true });
      const value = record(result.result).value;
      if (typeof value !== "string" || value.length > 400_000) throw reject();
      const observed = record(JSON.parse(value));
      const end = record((await target.cdp.send("Page.getFrameTree")).frameTree), endFrame = record(end.frame);
      check();
      if (typeof startFrame.id !== "string" || !startFrame.id || typeof startFrame.loaderId !== "string" || !startFrame.loaderId ||
          startFrame.id !== endFrame.id || startFrame.loaderId !== endFrame.loaderId || startFrame.url !== endFrame.url ||
          (readinessOnly ? !sameStagehandDocumentReadUrl(observed.url, endFrame.url) : observed.url !== endFrame.url)) throw reject();
      return { target, observed, documentHash: createHash("sha256").update(JSON.stringify([startFrame.id, startFrame.loaderId, startFrame.url, value])).digest("hex") };
    };
    const frameWitness = (capture: Awaited<ReturnType<typeof captureSourceDom>>, selected?: string) => ({
      kind: "NATIVE_VISIBLE_FRAME" as const, pageUrl: capture.observed.url as string, observedAt: new Date().toISOString(), documentHash: capture.documentHash,
      frames: [...new Set(Array.isArray(capture.observed.frames) ? capture.observed.frames : [])]
        .filter((url): url is string => typeof url === "string" && isSafeRecipeUrl(url) && !transactionUrl(url) && url !== capture.observed.url && (selected === undefined || url === selected))
        .map(src => ({ src, visible: true as const })),
    });
    return {
      kind: "OWNED_GUARDED_STAGEHAND_CONTEXT" as const, cdpUrl: endpoint, targetId,
      assertGuardedTargets,
      async observeSourceReadiness(id: string) {
        const { target, observed } = await captureSourceDom(id, true);
        const normal = sameStagehandDocumentReadUrl(target.documentRequest?.url(), observed.url);
        const bridge = [...(target.popupReads?.values() ?? [])].find(entry => sameStagehandDocumentReadUrl(entry.url, observed.url) && !entry.redirect);
        const mainDocumentStatus = normal ? target.documentStatus ?? null : bridge?.status ?? null;
        const mainReadPending = normal ? target.documentReadPending === true : Boolean(bridge && !(bridge.complete && bridge.queueComplete));
        return { readyState: ["loading", "interactive", "complete"].includes(String(observed.readyState)) ? observed.readyState as "loading" | "interactive" | "complete" : "UNKNOWN",
          bodyPresent: observed.bodyPresent === true, mainDocumentCurrent: normal || Boolean(bridge),
          mainDocumentComplete: normal ? target.documentReadPending === false && target.documentStatus !== undefined : Boolean(bridge?.complete && bridge.queueComplete),
          mainReadPending, pendingReads: activeReads.size, mainDocumentStatus };
      },
      async prepareNavigation(url: string) { check(); if (!allowed.has(canonicalStagehandHostEntry(url))) throw reject(); },
      async observeFrameSources(id: string) { return frameWitness(await captureSourceDom(id)); },
      async prepareFrameNavigation(id: string, url: string) {
        const capture = await captureSourceDom(id), witness = frameWitness(capture, url);
        if (frameEntryCount >= 2 || witness.frames.length !== 1 || witness.frames[0].src !== url || frameEntries.has(id)) throw reject();
        frameEntryCount++;
        frameEntries.set(id, { pageUrl: witness.pageUrl, frameUrl: url, observedAt: witness.observedAt, documentHash: witness.documentHash, until: Math.min(input.deadlineAt.getTime(), Date.now() + 30000) });
        allowed.add(url); roots.add(url); if (allowed.size > 512) throw reject();
        return witness;
      },
      async completeFrameNavigation(id: string, url: string) {
        const entry = frameEntries.get(id); frameEntries.delete(id);
        if (!entry || entry.frameUrl !== url || Date.now() >= entry.until) throw reject();
        await targets.get(id)?.documentRead; check();
        const capture = await captureSourceDom(id), finalUrl = capture.observed.url;
        const request = capture.target.documentRequest;
        if (typeof finalUrl !== "string" || !isSafeRecipeUrl(finalUrl) || !request || request.url() !== finalUrl || capture.target.documentStatus !== 200) throw reject();
        const redirects = finalUrl === url ? [] : attestedNativeDocumentRedirects(request, new Set([url]));
        if (!redirects) throw reject();
        return { kind: "NATIVE_FRAME_SOURCE_OPEN" as const, pageUrl: entry.pageUrl, frameUrl: url, observedAt: entry.observedAt, documentHash: entry.documentHash,
          finalUrl, completedAt: new Date().toISOString(), finalDocumentHash: capture.documentHash, redirects };
      },
      async beforeAction(id: string, actionHref?: string) {
        const capture = await captureSourceDom(id), { observed } = capture;
        popupGrants.delete(id);
        if (actionHref !== undefined) {
          if (typeof actionHref !== "string" || !Array.isArray(observed.links) || !observed.links.includes(actionHref) || !isSafeRecipeUrl(actionHref) || transactionUrl(actionHref)) throw reject();
          popupGrants.set(id, { url: actionHref, until: Math.min(input.deadlineAt.getTime(), Date.now() + 5000), used: false });
        }
        for (const url of [...(Array.isArray(observed.links) ? observed.links : []), ...(Array.isArray(observed.frames) ? observed.frames : [])])
          if (typeof url === "string" && isSafeRecipeUrl(url) && !transactionUrl(url)) { allowed.add(url); roots.add(url); }
        if (allowed.size > 512) throw reject();
        if (actionHref !== undefined) return {
          kind: "NATIVE_VISIBLE_DOM" as const, pageUrl: observed.url as string, observedAt: new Date().toISOString(),
          // Bind the stable native document identity and observed public DOM;
          // private frame/loader identifiers never leave this host.
          documentHash: capture.documentHash,
          links: [{ href: actionHref, visible: true as const }],
        };
      },
      diagnostics: () => ({ interceptedRequests: intercepted, admittedRequests: admitted, rejectedRequests: rejected, responseBytes: bytes,
        guardedPageCount: targets.size, installedPageCount: [...targets.values()].filter(target => target.installed).length,
        initialization: [...targets.values()].map(target => target.initialization), deniedWorkerTargets: deniedWorkers, popupCount, activeRequests: activeReads.size, terminalFailure: terminal, closed }),
      snapshotFailure: () => cdpFailure(),
      snapshotFailures: () => ({ ownedCdpFailure: cdpFailure(), nativeRouterFailure: nativeFailure.snapshot() }),
      async close() { signal.removeEventListener("abort", abort); return close(); },
    };
  } catch (error) { await close(); throw error instanceof Error && error.message === "STAGEHAND_GUARDED_SOURCE_REJECTED" ? error : reject(); }
}
