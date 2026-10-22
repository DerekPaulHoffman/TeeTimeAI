import type { Frame, Page, Response, Route } from "@playwright/test";
import { isNonEvidenceBrowserResource } from "@/lib/automation/passfactory-public-read-policy";
import { canonicalPublicReadUrl } from "./public-request-url";
import { PUBLIC_BROWSER_TOTAL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl } from "./recipe";
import { createPublicClientReadHeaderScope, type PublicClientReadHeaderProof, type PublicClientReadHeaderFailureReason } from "./public-client-read-headers";

/** One CDP owner validates every initial/redirected read. Evidence comes from
 * that exact request's paused Chrome response, independently of page body use. */
export interface NativeReadRequest {
  readonly signal?: AbortSignal;
  url(): string; method(): string; headers(): Record<string, string>; postData(): string | null;
  resourceType(): string; isNavigationRequest(): boolean; frame(): Frame;
  redirectedFrom(): NativeReadRequest | null; response(): Promise<NativeReadResponse | null>;
}
export type NativeReadResponse = Pick<Response, "url" | "status" | "allHeaders" | "finished" | "body">;
export type NativeReadRoute = Pick<Route, "continue" | "abort" | "fulfill"> & { request(): NativeReadRequest };
export type NativeRequestDiagnostic = {
  code: string; url?: string; method?: string; resourceType?: string;
  requestedPreflightMethod?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "CONNECT" | "TRACE" | "OTHER";
  preflightCandidatePresent?: boolean; preflightCandidateInvalid?: boolean; preflightSourceKnown?: boolean;
  preflightSourceMethod?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "CONNECT" | "TRACE" | "OTHER";
  preflightSourceCurrentGeneration?: boolean; preflightSourceFailed?: boolean; preflightSourceBodyPresent?: boolean;
  preflightSourceRootFrame?: boolean; preflightSourceLoaderKnown?: boolean; preflightSourceUrlMatches?: boolean;
  phase?: "RESPONSE_WAIT" | "CONTINUE_RESPONSE_ACK" | "LOADER_IDENTITY_WAIT" | "LOADER_IDENTITY" | "LOADER_OWNER" | "REDIRECT_GENERATION" | "DOCUMENT_INTENT" | "DOCUMENT_DRAIN";
  interceptedRequests?: number; recordCount?: number; requestLimit?: number; postDataBytes?: number;
  framePresent?: boolean; rootFrame?: boolean; networkIdPresent?: boolean; duplicateRequestId?: boolean;
  hasPostData?: boolean; postDataPresent?: boolean;
  identityPresent?: boolean; loaderPresent?: boolean; loaderKnown?: boolean; identityFresh?: boolean;
  identityUrlMatches?: boolean; identityMethodMatches?: boolean; identityKindMatches?: boolean; identityFrameMatches?: boolean;
  parentPresent?: boolean; awaitingDocument?: boolean; parentCurrentGeneration?: boolean;
  documentCommitted?: boolean; documentIntentPresent?: boolean; documentIntentUsed?: boolean;
  sourceResponseComplete?: boolean; successorTerminalFailed?: boolean;
};
export type NativeFirstFatal = NativeRequestDiagnostic;
export type NativeRedirectRouting = {
  prepare(frame: Frame): void; releasePlaywrightRoute(route: Route): Promise<void>; close(): Promise<void>;
  beginDocumentNavigation(frame: Frame): Promise<void>;
  readonly pendingReads: number; readonly lastFailure: string | undefined; readonly firstFatal?: NativeFirstFatal;
  readonly rejectedRequests?: NativeRequestDiagnostic[];
};
// Only this controller can attest that Chrome has terminated the exact read.
// A provider string or an unrelated Error with the same message grants no such
// lifecycle authority and must retain the caller's normal network cleanup.
const terminalNetworkFailures = new WeakSet<Error>();
const supersededFailures = new WeakSet<Error>();
export function isNativeReadSupersededFailure(value: unknown): value is Error {
  return value instanceof Error && supersededFailures.has(value);
}
export function isNativeReadTerminalFailure(value: unknown): value is Error {
  return value instanceof Error && terminalNetworkFailures.has(value);
}
function terminalNetworkFailure() {
  const error = new Error("NATIVE_REDIRECT_NETWORK_FAILED");
  terminalNetworkFailures.add(error);
  return error;
}
function supersededFailure() {
  const error = new Error("NATIVE_READ_SUPERSEDED");
  terminalNetworkFailures.add(error); supersededFailures.add(error);
  return error;
}
function pending<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
type RecordEntry = {
  id: string; networkId: string; url: string; transportUrl: string; method: string; headers: Record<string, string>; body: string | null;
  headerEntries: Array<[string, string]>; publicHeaderProof?: PublicClientReadHeaderProof;
  kind: string; parent: RecordEntry | null; depth: number; paused: boolean; admitted: boolean; failed: boolean; responseStarted: boolean; complete: boolean;
  failureCode?: string; failure?: Error;
  generation: DocumentGeneration; loaderId?: string; networkIdentityRevision?: number; responseStatus?: number; responseMimeType?: string;
  preflight?: PreflightSource;
  cancellation: AbortController; handlerDone: boolean; responsePaused: boolean;
  retirementAck?: Promise<void>;
  retirementAcks?: Partial<Record<"request" | "response", Promise<void>>>;
  redirect?: { status: number; target: string }; redirectChildId?: string;
  adapter: NativeReadRequest; response: ReturnType<typeof pending<NativeReadResponse | Error>>;
};
type DocumentGeneration = { id: number; retired: boolean; loaderId?: string };
type PreflightSource = { networkId: string; identity: NetworkIdentity; generation: DocumentGeneration; used: boolean };
type NetworkIdentity = { id: string; revision: number; loaderId: string; frameId?: string; url: string; method: string; kind: string; kindKnown: boolean;
  hasBody: boolean; headerEntries: Array<[string, string]>; generation: DocumentGeneration; preflight?: PreflightSource };
type PendingPreflightIdentity = { identity: NetworkIdentity; sourceNetworkId: string; generation: DocumentGeneration; createdAt: number; invalid: boolean };
type PendingInitialPause = { id: string; generation: DocumentGeneration; retired: boolean;
  networkId: string; url: string; method: string; kind: string; networkFailed: ReturnType<typeof pending<void>>;
  successorIdentity?: NetworkIdentity; terminalFailed?: boolean;
  retirementAck?: Promise<void>; cancelled: ReturnType<typeof pending<void>> };
type CommittedDocument = { record: RecordEntry; loaderId: string };
type DocumentIntent = { source: CommittedDocument; target: string; networkRevision: number; createdAt: number; used: boolean };
type NativeRecordOwner = { closed: boolean; authorizeHeaders?: (record: RecordEntry) => Promise<PublicClientReadHeaderProof | null> };
// Only adapters minted by this controller have redirect provenance. A model,
// Playwright lookalike, diagnostic or caller-supplied redirectedFrom chain does
// not gain authority by exposing the same methods or URL strings.
const nativeRequestRecords = new WeakMap<object, { record: RecordEntry; owner: NativeRecordOwner }>();
export const nativePublicHeaderFailureFactKeys = ["nativeDocumentCurrent", "nativeRecordPresent", "nativeRecordFailed", "nativeRequestCancelled",
  "nativeGenerationCurrent", "nativeGenerationRetired", "nativeLoaderCurrent", "nativeIdentityPresent", "nativeIdentityRevisionCurrent",
  "nativeIdentityFailed", "nativeSourceIdentityCurrent", "nativeSourceFailed", "nativeSourceGenerationCurrent", "nativeSourceLoaderCurrent", "nativeSourceRootFrame"] as const;
export type NativePublicHeaderProofFailure = { reason: PublicClientReadHeaderFailureReason | "OWNER_CLOSED" | "CONTEXT_CHANGED" | "NATIVE_RECORD_NOT_CURRENT" } &
  Partial<Record<typeof nativePublicHeaderFailureFactKeys[number], boolean>>;
const publicHeaderProofs = new WeakMap<object, { record: RecordEntry; owner: NativeRecordOwner;
  current: () => boolean; method: "GET" | "HEAD" | null; firstFailure?: Readonly<NativePublicHeaderProofFailure> }>();
function rejectPublicHeaderProof(proof: PublicClientReadHeaderProof, failure: NativePublicHeaderProofFailure) {
  const value = publicHeaderProofs.get(proof);
  if (value && !value.firstFailure) value.firstFailure = Object.freeze({ ...failure });
  return false;
}
/** Only an adapter minted by the native controller can ask for a publicity
 * proof. It grants no cookie, URL, DNS, route, response, or lease authority. */
export async function authorizePublicClientReadHeaders(request: NativeReadRequest): Promise<PublicClientReadHeaderProof | null> {
  const value = nativeRequestRecords.get(request);
  return value && !value.owner.closed ? await value.owner.authorizeHeaders?.(value.record) ?? null : null;
}
export function isCurrentPublicClientReadHeaders(proof: PublicClientReadHeaderProof) {
  const value = publicHeaderProofs.get(proof);
  if (!value) return false;
  if (value.owner.closed) return rejectPublicHeaderProof(proof, { reason: "OWNER_CLOSED" });
  return Boolean(value.current());
}
/** Returns the cached first failed check, without touching current state. */
export function publicClientReadHeaderProofFailure(proof: PublicClientReadHeaderProof): NativePublicHeaderProofFailure | null {
  const value = publicHeaderProofs.get(proof)?.firstFailure;
  return value ? { ...value } : null;
}
export function nativePublicClientPreflightMethod(request: NativeReadRequest, proof: PublicClientReadHeaderProof): "GET" | "HEAD" | null {
  const value = publicHeaderProofs.get(proof);
  return value && value.record.adapter === request && value.record.method === "OPTIONS" && isCurrentPublicClientReadHeaders(proof) ? value.method : null;
}
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
function releasedRedirect(record: RecordEntry, target: string) {
  return record.admitted && record.complete && !record.failed && record.redirect?.target === target;
}
function trustedDocumentChain(record: RecordEntry, owner: NativeRecordOwner, roots: ReadonlySet<string>) {
  if (owner.closed || record.depth > 5) return false;
  let current = record;
  for (;;) {
    if (current.generation.retired || current.kind !== "document" || !["GET", "HEAD"].includes(current.method) || current.failed ||
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
function rawHeaderEntries(value: Record<string, string | number>): Array<[string, string]> {
  const entries = Object.entries(value);
  if (entries.length > 128 || JSON.stringify(entries).length > 65_536) throw new Error("NATIVE_REDIRECT_HEADERS_LIMIT");
  return entries.map(([key, item]) => [key, String(item)]);
}
function headers(value: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(rawHeaderEntries(value).map(([key, item]) => [key.toLowerCase(), item]));
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
  const networkIdentities = new Map<string, NetworkIdentity>();
  const failedNetworkIdentities = new WeakSet<NetworkIdentity>();
  const pendingPreflightIdentities = new Map<string, PendingPreflightIdentity>();
  const preflightSources = new Set<NetworkIdentity>();
  const networkWaiters = new Map<string, ReturnType<typeof pending<void>>>();
  const initialPauses = new Map<string, PendingInitialPause>();
  const loaderOwners = new Map<string, DocumentGeneration>();
  let generation: DocumentGeneration = { id: 0, retired: false }, generationTracking = false, boundaryPending = false, awaitingDocument = false;
  let committedDocument: CommittedDocument | undefined, documentIntent: DocumentIntent | undefined;
  let currentDocumentUrl = "";
  const owner: NativeRecordOwner = { closed: false };
  type HeaderContext = { document: RecordEntry; loader: object; scope: ReturnType<typeof createPublicClientReadHeaderScope> };
  let headerContext: HeaderContext | undefined;
  const headerScripts = new Map<RecordEntry, string>();
  const witnessedHeaderScripts = new WeakSet<RecordEntry>();
  const rejectedRequests: NativeRequestDiagnostic[] = [];
  let closing: Promise<void> | undefined, closed = false, enabled = false, lastFailure: string | undefined, firstFatal: NativeFirstFatal | undefined;
  let interceptedRequests = 0, pendingReads = 0, responseBytes = 0, networkIdentityRevision = 0;
  const failure = (code: string) => { lastFailure = code; try { options.onFailure?.(code); } catch { /* Diagnostics cannot authorize work. */ } };
  const retireHeaderContext = () => { headerContext?.scope.close(); headerContext = undefined; };
  const liveHeaderDocument = (context: HeaderContext) => !closed && !options.signal?.aborted && !boundaryPending &&
    committedDocument?.record === context.document && context.document.generation === generation && !generation.retired &&
    !context.document.failed && context.document.admitted && context.document.complete && context.document.responseStatus === 200 &&
    networkIdentities.get(context.document.networkId)?.revision === context.document.networkIdentityRevision &&
    !failedNetworkIdentities.has(networkIdentities.get(context.document.networkId)!) &&
    /^text\/html(?:\s*;|$)/iu.test(context.document.responseMimeType ?? "") &&
    context.document.loaderId === committedDocument.loaderId && loaderOwners.get(committedDocument.loaderId) === generation &&
    isSafeRecipeUrl(currentDocumentUrl);
  const liveHeaderIdentity = (identity: NetworkIdentity, context: HeaderContext) => liveHeaderDocument(context) &&
    networkIdentities.get(identity.id) === identity && !failedNetworkIdentities.has(identity) && identity.generation === generation &&
    identity.frameId === rootFrameId && identity.loaderId === committedDocument?.loaderId && loaderOwners.get(identity.loaderId) === generation;
  const liveHeaderRecord = (record: RecordEntry, context: HeaderContext) => {
    const identity = networkIdentities.get(record.networkId);
    return Boolean(identity && records.get(record.id) === record && !record.failed && !record.cancellation.signal.aborted && record.generation === generation &&
      !record.generation.retired && record.loaderId === committedDocument?.loaderId && identity?.revision === record.networkIdentityRevision &&
      (record.preflight ? liveHeaderDocument(context) && !failedNetworkIdentities.has(identity) &&
        record.preflight.generation === generation && liveHeaderIdentity(record.preflight.identity, context)
        : liveHeaderIdentity(identity, context)) && identity.url === record.url && identity.method === record.method);
  };
  const headerRecordFailureFacts = (record: RecordEntry, context: HeaderContext) => {
    const identity = networkIdentities.get(record.networkId), source = record.preflight?.identity;
    return { nativeDocumentCurrent: liveHeaderDocument(context), nativeRecordPresent: records.get(record.id) === record,
      nativeRecordFailed: record.failed, nativeRequestCancelled: record.cancellation.signal.aborted,
      nativeGenerationCurrent: record.generation === generation, nativeGenerationRetired: record.generation.retired,
      nativeLoaderCurrent: record.loaderId === committedDocument?.loaderId, nativeIdentityPresent: Boolean(identity),
      nativeIdentityRevisionCurrent: Boolean(identity && identity.revision === record.networkIdentityRevision),
      nativeIdentityFailed: Boolean(identity && failedNetworkIdentities.has(identity)),
      ...(source ? { nativeSourceIdentityCurrent: networkIdentities.get(source.id) === source, nativeSourceFailed: failedNetworkIdentities.has(source),
        nativeSourceGenerationCurrent: source.generation === generation, nativeSourceLoaderCurrent: source.loaderId === committedDocument?.loaderId && loaderOwners.get(source.loaderId) === generation,
        nativeSourceRootFrame: source.frameId === rootFrameId } : {}) };
  };
  const currentHeaderContext = () => {
    const document = committedDocument?.record;
    if (!document || !document.complete || document.failed || document.generation !== generation || generation.retired || boundaryPending || closed) return null;
    if (headerContext && headerContext.document !== document) retireHeaderContext();
    if (!headerContext) {
      const context = { document, loader: {} } as HeaderContext;
      context.scope = createPublicClientReadHeaderScope(document, {
        document: value => value === document ? { url: currentDocumentUrl, loader: context.loader,
          live: liveHeaderDocument(context), rootFrame: true } : null,
        script: value => {
          const record = value as RecordEntry, body = headerScripts.get(record);
          return body === undefined ? null : { document, loader: context.loader, url: record.transportUrl, method: record.method,
            resourceType: record.kind, rootFrame: true, live: liveHeaderRecord(record, context), hasBody: record.body !== null,
            status: record.responseStatus, mimeType: record.responseMimeType, admitted: record.admitted, complete: record.complete,
            redirected: Boolean(record.parent), body };
        },
        request: value => {
          const record = value as RecordEntry;
          if (records.get(record.id) === record) {
            return { document, loader: context.loader, url: record.url, method: record.method,
              resourceType: record.preflight?.identity.kind ?? record.kind, rootFrame: true,
              live: liveHeaderRecord(record, context), hasBody: record.body !== null, headers: record.headerEntries,
              ...(record.preflight ? { sourceRequest: record.preflight.identity } : {}) };
          }
          const identity = value as NetworkIdentity;
          return networkIdentities.get(identity.id) === identity ? { document, loader: context.loader, url: identity.url, method: identity.method,
            resourceType: identity.kind, rootFrame: identity.frameId === rootFrameId, live: liveHeaderIdentity(identity, context),
            hasBody: identity.hasBody, headers: identity.headerEntries } : null;
        },
      });
      headerContext = context;
      // A commit event may arrive after an already acknowledged script. Use
      // only its existing bounded captured body; no new browser/network read.
      for (const record of headerScripts.keys()) if (context.scope.captureScript(record)) witnessedHeaderScripts.add(record);
    }
    return liveHeaderDocument(headerContext) ? headerContext : null;
  };
  owner.authorizeHeaders = async record => {
    let context = currentHeaderContext();
    const attempt = () => context && liveHeaderRecord(record, context) ? record.preflight
      ? context.scope.provePreflight(record, record.preflight.identity) : context.scope.proveRead(record) : null;
    let proof = attempt();
    if (!proof && !closed && !record.failed) {
      const inFlight = [...records.values()].filter(source => source.generation === generation && !source.failed && source.responseStarted && !source.complete &&
        (source === committedDocument?.record || source.kind === "script" && source.method === "GET" && source.loaderId === committedDocument?.loaderId &&
          source.responseStatus === 200 && (() => { try { return new URL(source.transportUrl).origin === new URL(currentDocumentUrl).origin; } catch { return false; } })()));
      if (inFlight.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // The browser may emit an XHR after response release but before CDP's
          // ACK resolves. Wait only for already intercepted completions, outside
          // the provider lane; no new request or recursive lease acquisition.
          await Promise.race([Promise.all(inFlight.map(source => source.response.promise)), record.response.promise,
            new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        } finally { clearTimeout(timer); }
        context = currentHeaderContext(); proof = attempt();
      }
    }
    if (!proof || !context) return null;
    const captured = context;
    publicHeaderProofs.set(proof, { record, owner, method: record.preflight ? record.preflight.identity.method as "GET" | "HEAD" : null,
      current: () => {
        if (headerContext !== captured) return rejectPublicHeaderProof(proof, { reason: "CONTEXT_CHANGED" });
        if (!liveHeaderRecord(record, captured)) {
          const facts = headerRecordFailureFacts(record, captured);
          return rejectPublicHeaderProof(proof, { reason: facts.nativeDocumentCurrent ? "NATIVE_RECORD_NOT_CURRENT" : "DOCUMENT_NOT_CURRENT", ...facts });
        }
        if (!captured.scope.isCurrent(proof)) return rejectPublicHeaderProof(proof, { reason: captured.scope.failureReason(proof) ?? "PROOF_NOT_ATTESTED" });
        return true;
      } });
    record.publicHeaderProof = proof;
    return proof;
  };
  const onAbort = () => { void close("NATIVE_REDIRECT_CANCELLED"); };
  function close(code = "NATIVE_REDIRECT_CLOSED") {
    if (closing) return closing;
    closed = true;
    retireHeaderContext(); headerScripts.clear();
    committedDocument = undefined; documentIntent = undefined;
    owner.closed = true;
    pendingPreflightIdentities.clear();
    if (code !== "NATIVE_REDIRECT_CLOSED") { firstFatal ??= { code }; failure(code); }
    options.signal?.removeEventListener("abort", onAbort);
    for (const record of records.values()) { record.failed = true; record.response.settle(new Error(code)); }
    for (const waiter of networkWaiters.values()) waiter.settle();
    for (const pause of initialPauses.values()) pause.cancelled.settle();
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
      if (record.generation.retired && record.retirementAck) await record.retirementAck;
      if (record.failure && isNativeReadTerminalFailure(record.failure)) throw record.failure;
      throw error;
    }
  };
  const failRecord = (record: RecordEntry, code: string) => {
    // Cleanup must not replace the exact terminal cause while this read waits
    // for its provider lane, or turn it into another host-wide cancellation.
    if (record.failed) return;
    record.failed = true; record.failureCode = code;
    record.failure = code === "NATIVE_READ_SUPERSEDED" ? supersededFailure() : code === "NATIVE_REDIRECT_NETWORK_FAILED" ? terminalNetworkFailure() : new Error(code);
    if (isNativeReadTerminalFailure(record.failure)) record.cancellation.abort(record.failure);
    record.response.settle(record.failure);
  };
  const abortRetiredPause = (record: RecordEntry, stage: "request" | "response", command: () => Promise<unknown>) => {
    // The boundary and a late response event can observe the same pause while
    // another abort ACK is pending. Dispatch one command for that exact stage;
    // a genuinely later response pause still needs its own bounded ACK.
    const acks = record.retirementAcks ??= {};
    const existing = acks[stage];
    if (existing) return existing;
    const ack = bounded(Promise.resolve().then(command), "NATIVE_REDIRECT_ABORT_TIMEOUT").then(() => {
      if (stage === "request") record.paused = false;
      else record.responsePaused = false;
      if (!record.complete) failRecord(record, "NATIVE_READ_SUPERSEDED");
    });
    acks[stage] = ack; record.retirementAck = ack;
    return ack;
  };
  const abortInitialPause = (pause: PendingInitialPause) => {
    pause.retired = true;
    if (!pause.retirementAck) {
      // stopLoading can invalidate a newly arriving retired interception. A
      // rejected command proves nothing; await either its actual ACK or the
      // independently correlated terminal Network event, under the same cap.
      const acknowledged = Promise.resolve().then(() => cdp.send("Fetch.failRequest", { requestId: pause.id, errorReason: "BlockedByClient" }))
        .then(() => {}, () => new Promise<never>(() => {}));
      pause.retirementAck = bounded(Promise.race([acknowledged, pause.networkFailed.promise]),
        "NATIVE_REDIRECT_ABORT_TIMEOUT").then(() => { pause.cancelled.settle(); });
    }
    return pause.retirementAck;
  };
  const retireGeneration = async (previous: DocumentGeneration, stopLoading: boolean) => {
    previous.retired = true;
    retireHeaderContext();
    for (const record of headerScripts.keys()) if (record.generation === previous) headerScripts.delete(record);
    for (const [id, pending] of pendingPreflightIdentities) if (pending.generation === previous) pendingPreflightIdentities.delete(id);
    for (const record of records.values()) if (record.generation === previous && record.complete)
      record.cancellation.abort(supersededFailure());
    const old = [...records.values()].filter(record => record.generation === previous && !record.complete && !record.failed);
    await Promise.all([...initialPauses.values()].filter(pause => pause.generation === previous).map(abortInitialPause));
    await Promise.all(old.filter(record => record.paused || record.responsePaused).map(async record => {
      if (record.complete || record.failed) return;
      await abortRetiredPause(record, record.responsePaused ? "response" : "request",
        () => cdp.send("Fetch.failRequest", { requestId: record.id, errorReason: "BlockedByClient" }));
    }));
    // An automatic successor is already paused in Chrome. stopLoading would
    // cancel that exact new document too; only explicit boundaries issue it.
    // In-flight old reads still need their actual terminal event/response.
    if (stopLoading) await bounded(cdp.send("Page.stopLoading"), "NATIVE_REDIRECT_DRAIN_TIMEOUT");
    await bounded((async () => {
      while ([...initialPauses.values()].some(pause => pause.generation === previous) ||
        [...records.values()].some(record => record.generation === previous && (record.responsePaused || !record.handlerDone || !record.complete && !record.failed))) {
        if (closed || options.signal?.aborted) throw new Error("NATIVE_REDIRECT_CLOSED");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      // A fatal abort can close the controller just before its pause's finally
      // removes the last row. An empty set is not a successful closed drain.
      if (closed || options.signal?.aborted) throw new Error("NATIVE_REDIRECT_CLOSED");
    })(), "NATIVE_REDIRECT_DRAIN_TIMEOUT");
  };
  cdp.on("Page.frameNavigated", event => {
    if (!generationTracking || closed || event.frame.id !== rootFrameId) return;
    documentIntent = undefined;
    const matches = [...records.values()].filter(record => record.kind === "document" && record.admitted && !record.failed &&
      record.generation === generation && !record.generation.retired && record.loaderId === event.frame.loaderId &&
      record.transportUrl === event.frame.url && record.responseStatus !== undefined && record.responseStatus >= 200 && record.responseStatus < 300);
    const next = matches.length === 1 ? { record: matches[0], loaderId: event.frame.loaderId } : undefined;
    if (next?.record !== committedDocument?.record) retireHeaderContext();
    committedDocument = next; currentDocumentUrl = event.frame.url;
  });
  cdp.on("Page.navigatedWithinDocument", event => {
    if (event.frameId !== rootFrameId || !committedDocument) return;
    try {
      if (!isSafeRecipeUrl(event.url) || new URL(event.url).origin !== new URL(currentDocumentUrl).origin) { retireHeaderContext(); headerScripts.clear(); }
    } catch { retireHeaderContext(); headerScripts.clear(); }
    currentDocumentUrl = event.url;
  });
  cdp.on("Page.frameRequestedNavigation", event => {
    if (event.frameId !== rootFrameId) return;
    documentIntent = undefined;
    if (!generationTracking || closed || boundaryPending || awaitingDocument || !committedDocument ||
      committedDocument.record.generation !== generation || generation.retired || committedDocument.record.failed ||
      event.reason !== "scriptInitiated" || event.disposition !== "currentTab" || typeof event.url !== "string" || event.url.length > 2048) return;
    // This private one-use event binds ownership, never navigation permission.
    // The exact successor still passes the caller's ordinary public-read guard.
    documentIntent = { source: committedDocument, target: event.url, networkRevision: networkIdentityRevision, createdAt: Date.now(), used: false };
  });
  const publishNetworkIdentity = (id: string, identity: NetworkIdentity) => {
    networkIdentities.set(id, identity); networkWaiters.get(id)?.settle();
  };
  const bindPendingPreflight = (id: string, pending: PendingPreflightIdentity, source: NetworkIdentity) => {
    if (pending.invalid) return;
    const identity = pending.identity;
    if (pending.generation !== generation || generation.retired || boundaryPending || awaitingDocument ||
        Date.now() - pending.createdAt > timeoutMs || networkIdentities.get(pending.sourceNetworkId) !== source ||
        failedNetworkIdentities.has(source) || source.preflight || source.hasBody && source.method !== "POST" || !["GET", "HEAD", "POST"].includes(source.method) || !["xhr", "fetch"].includes(source.kind) ||
        source.frameId !== rootFrameId || source.url !== identity.url || !source.loaderId ||
        loaderOwners.get(source.loaderId) !== generation || identity.loaderId && identity.loaderId !== source.loaderId || preflightSources.has(source)) {
      // A first conflicting source revision cannot heal into later authority.
      pending.invalid = true; return;
    }
    if (preflightSources.size >= limit) { void close("NATIVE_REDIRECT_RECORD_LIMIT"); return; }
    preflightSources.add(source); pendingPreflightIdentities.delete(id);
    identity.preflight = { networkId: pending.sourceNetworkId, identity: source, generation, used: false };
    publishNetworkIdentity(id, identity);
  };
  cdp.on("Network.requestWillBeSent", event => {
    if (!generationTracking || closed) return;
    const existingPending = pendingPreflightIdentities.get(event.requestId);
    if (existingPending) { existingPending.invalid = true; return; }
    const nativePreflight = event.request.method === "OPTIONS" && event.initiator?.type === "preflight";
    if (nativePreflight) {
      if (networkIdentities.has(event.requestId) || !event.initiator.requestId || event.initiator.requestId === event.requestId ||
          generation.retired || boundaryPending || awaitingDocument || event.frameId !== undefined && event.frameId !== rootFrameId ||
          !["Other", "Preflight"].includes(event.type ?? "") || event.request.hasPostData || event.request.postData !== undefined) return;
    } else if (event.frameId !== rootFrameId) {
      for (const pending of pendingPreflightIdentities.values()) if (pending.sourceNetworkId === event.requestId) pending.invalid = true;
      return;
    }
    if (!networkIdentities.has(event.requestId) && networkIdentities.size + pendingPreflightIdentities.size >= limit) {
      void close("NATIVE_REDIRECT_RECORD_LIMIT"); return;
    }
    let entries: Array<[string, string]>;
    try { entries = rawHeaderEntries(event.request.headers ?? {}); } catch { void close("NATIVE_REDIRECT_HEADERS_LIMIT"); return; }
    const identity: NetworkIdentity = { id: event.requestId, revision: ++networkIdentityRevision, loaderId: event.loaderId, frameId: event.frameId,
      url: event.request.url, method: event.request.method, kind: resourceKinds[event.type ?? ""] ?? "other",
      kindKnown: Object.hasOwn(resourceKinds, event.type ?? ""), hasBody: event.request.hasPostData === true || event.request.postData !== undefined,
      headerEntries: entries, generation };
    if (nativePreflight) {
      // Chrome can emit raw loaderless OPTIONS metadata before its exact read
      // initiator. Retain only bounded current-generation facts until that read
      // arrives; neither pause can bypass its ordinary policy or provider lease.
      // POST ownership only allows the caller to evaluate its ordinary OPTIONS
      // policy. It grants no body/header/readPost authority to the actual POST.
      const pending: PendingPreflightIdentity = { identity, sourceNetworkId: event.initiator.requestId!, generation, createdAt: Date.now(), invalid: false };
      pendingPreflightIdentities.set(event.requestId, pending);
      const source = networkIdentities.get(pending.sourceNetworkId);
      if (source) bindPendingPreflight(event.requestId, pending, source);
      return;
    }
    publishNetworkIdentity(event.requestId, identity);
    for (const [id, pending] of pendingPreflightIdentities) if (pending.sourceNetworkId === event.requestId) bindPendingPreflight(id, pending, identity);
  });
  cdp.on("Network.loadingFailed", event => {
    for (const record of headerScripts.keys()) if (record.networkId === event.requestId && witnessedHeaderScripts.has(record)) headerContext?.scope.invalidate();
    for (const [id, pending] of pendingPreflightIdentities) if (id === event.requestId || pending.sourceNetworkId === event.requestId) pending.invalid = true;
    for (const record of records.values()) if (record.networkId === event.requestId && !record.complete && !record.failed)
      failRecord(record, record.generation.retired ? "NATIVE_READ_SUPERSEDED" : "NATIVE_REDIRECT_NETWORK_FAILED");
    const identity = networkIdentities.get(event.requestId);
    if (identity) failedNetworkIdentities.add(identity);
    for (const pause of initialPauses.values()) if (pause.successorIdentity && pause.networkId === event.requestId &&
      identity === pause.successorIdentity && identity.frameId === rootFrameId && identity.url === pause.url && identity.method === pause.method &&
      identity.kind === "document" && pause.kind === "document") {
      // An independently owned terminal event can cancel only this protected
      // successor while its predecessor drains. It never authorizes dispatch.
      pause.terminalFailed = true; pause.networkFailed.settle(); pause.cancelled.settle();
    }
    for (const pause of initialPauses.values()) if (pause.generation.retired && pause.networkId === event.requestId && identity &&
      identity.frameId === rootFrameId && identity.url === pause.url && identity.method === pause.method && identity.kindKnown &&
      (identity.kind === pause.kind || [identity.kind, pause.kind].every(kind => kind === "xhr" || kind === "fetch")) &&
      loaderOwners.get(identity.loaderId) === pause.generation) pause.networkFailed.settle();
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  cdp.on("Fetch.requestPaused", event => {
    // Include dispatch and capture before any await, so ready DOM cannot hide
    // an incomplete native read before the shared handler starts or resumes.
    pendingReads++;
    let pendingInitialPause: PendingInitialPause | undefined;
    void (async () => {
      if (closed) return;
      const reject = () => cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      const requestDiagnostic = (code: string): NativeRequestDiagnostic => {
        let url: string | undefined;
        let requestedPreflightMethod: NativeRequestDiagnostic["requestedPreflightMethod"];
        const kind = resourceKinds[event.resourceType] ?? "other";
        const method = /^(?:GET|HEAD|POST|OPTIONS|PUT|PATCH|DELETE|CONNECT|TRACE)$/u.test(event.request.method) ? event.request.method : "OTHER";
        if (event.request.method === "OPTIONS") try {
          const entries = Object.entries(event.request.headers ?? {});
          const requested = entries.filter(([name]) => name.toLowerCase() === "access-control-request-method");
          if (requested.length) {
            const value = entries.length <= 128 && requested.length === 1 && typeof requested[0][1] === "string" ? requested[0][1] : "";
            requestedPreflightMethod = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/u.test(value)
              ? value as NonNullable<NativeRequestDiagnostic["requestedPreflightMethod"]> : "OTHER";
          }
        } catch { /* Diagnostic projection never changes request handling. */ }
        try {
          const value = new URL(event.request.url); value.search = ""; value.hash = "";
          if (value.protocol === "https:" && value.href.length <= 2048 && (isSafeRecipeUrl(value.href) || isSafeBrowserAssetUrl(value.href, kind, method)))
            url = `${value.origin}${value.pathname}`;
        } catch { /* Unsafe/private/session paths stay absent from diagnostics. */ }
        // Never retain raw IDs, headers, body, query values or source events.
        return { code, ...(url ? { url } : {}), method, resourceType: kind,
          ...(requestedPreflightMethod ? { requestedPreflightMethod } : {}),
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
        if (record?.generation.retired) {
          // Retired reads are tombstones, never response/redirect evidence.
          // An unrelated or malformed late event is still fatal.
          if (record.networkId !== event.networkId || record.transportUrl !== event.request.url || record.method !== event.request.method ||
              record.kind !== resourceKinds[event.resourceType] || event.frameId !== rootFrameId || record.responseStarted)
            { await close("NATIVE_REDIRECT_RESPONSE_MISMATCH"); return; }
          record.responseStarted = true; record.responsePaused = true;
          await abortRetiredPause(record, "response", reject);
          return;
        }
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
        record.responseStarted = true; record.responsePaused = true;
        if (event.responseErrorReason) {
          // Chrome has failed this exact admitted read. Do not create response
          // evidence or close unrelated documents/reads because an optional
          // resource failed. The root page.goto still reports navigation failure.
          record.paused = false;
          failRecord(record, "NATIVE_REDIRECT_NETWORK_FAILED");
          await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
          record.responsePaused = false;
          return;
        }
        try {
          const status = event.responseStatusCode!, values = responseHeaders(event.responseHeaders ?? []);
          record.responseStatus = status; record.responseMimeType = values["content-type"];
          const maxBytes = publicBrowserResponseLimit(record.kind), declared = Number(values["content-length"] ?? 0);
          if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) { await close("NATIVE_RESPONSE_LIMIT"); return; }
          const noBody = record.method === "HEAD" || [204, 205, 304].includes(status) || status >= 300 && status < 400;
          // Network.loadingFinished can wait for page JavaScript to consume a
          // Fetch body, deadlocking Promise.all behind a serialized provider lease.
          const body = noBody ? Buffer.alloc(0) : await recordCommand(record, cdp.send("Fetch.getResponseBody", { requestId: record.id }), "NATIVE_REDIRECT_BODY_TIMEOUT")
            .then(value => Buffer.from(value.body, value.base64Encoded ? "base64" : "utf8"));
          responseBytes += body.length;
          if (body.length > maxBytes || responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) { await close("NATIVE_RESPONSE_LIMIT"); return; }
          if (closed || options.signal?.aborted || record.failed || record.generation.retired) return;
          // Preserve the actual status, headers and body. Completion follows the
          // successful unchanged release, never a fabricated/fulfilled response.
          await recordCommand(record, cdp.send("Fetch.continueResponse", { requestId: record.id }), "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
            () => responseTimeoutDiagnostic(record, "CONTINUE_RESPONSE_ACK"));
          record.responsePaused = false;
          if (closed || options.signal?.aborted || record.failed || record.generation.retired) return;
          // Publish redirect authority only after Chrome acknowledges the
          // unchanged response release. A Location alone, failed release, or
          // duplicate header never attests a navigation.
          if (redirectStatuses.has(status) && (event.responseHeaders ?? []).filter(item => item.name.toLowerCase() === "location").length === 1) {
            try { record.redirect = { status, target: new URL(values.location, record.transportUrl).href }; }
            catch { /* An invalid Location cannot authorize a child request. */ }
          }
          record.complete = true;
          if (record.kind === "script" && record.method === "GET" && status === 200 && body.length <= 2 * 1024 * 1024 &&
              /^(?:application|text)\/(?:javascript|ecmascript)(?:\s*;[^\r\n]*)?$/iu.test(record.responseMimeType ?? "")) {
            headerScripts.set(record, body.toString("utf8"));
            if (currentHeaderContext()?.scope.captureScript(record)) witnessedHeaderScripts.add(record);
          }
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
      const excludedResource = isNonEvidenceBrowserResource(event.request.url, resourceKinds[event.resourceType] ?? "other");
      if (event.resourceType === "Ping" || excludedResource) {
        // Beacons and resources already excluded from browser evidence never
        // need read identity. Abort only this pause without creating a record.
        // Cap/frame/duplicate checks above and bounded abort failure still win.
        // Match the caller's quiet decorative skip: it is neither a failed
        // availability read nor model feedback. Unclassified Ping diagnostics
        // stay separate; known analytics remain a quiet denial for every kind.
        const diagnostic = event.resourceType === "Ping" && !excludedResource ? requestDiagnostic("NATIVE_REDIRECT_PING_UNSUPPORTED") : undefined;
        await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT");
        if (diagnostic) {
          rejectedRequests.push(diagnostic);
          if (rejectedRequests.length > 12) rejectedRequests.shift();
          try { options.onRequestRejected?.({ ...diagnostic }); } catch { /* Diagnostics cannot authorize work. */ }
        }
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
      // Reserve the exact single child before waiting for independently ordered
      // Network metadata. A second pause cannot share this parent's authority.
      if (parent) parent.redirectChildId = event.requestId;
      const kind = resourceKinds[event.resourceType];
      if (!kind) { await reject(); await close("NATIVE_REDIRECT_RESOURCE_REJECTED"); return; }
      let requestGeneration = generation;
      let requestLoaderId: string | undefined;
      let requestIdentityRevision: number | undefined;
      let requestPreflight: PreflightSource | undefined;
      let denyResourceKind = false;
      pendingInitialPause = { id: event.requestId, generation: parent?.generation ?? generation, retired: false, cancelled: pending(),
        networkId: event.networkId!, url: event.request.url, method: event.request.method, kind, networkFailed: pending() };
      initialPauses.set(event.requestId, pendingInitialPause);
      if (pendingInitialPause.generation.retired) { await abortInitialPause(pendingInitialPause); return; }
      if (generationTracking) {
        const sameKind = (identity: NetworkIdentity | undefined) => identity?.kind === kind ||
          [identity?.kind, kind].every(value => value === "xhr" || value === "fetch");
        const fresh = (identity: NetworkIdentity | undefined) => Boolean(identity &&
          (!parent?.networkIdentityRevision || identity.revision > parent.networkIdentityRevision));
        const diagnostic = (phase: NativeRequestDiagnostic["phase"]): NativeRequestDiagnostic => {
          const identity = networkIdentities.get(networkId);
          const candidate = pendingPreflightIdentities.get(networkId);
          const preflightSource = candidate ? networkIdentities.get(candidate.sourceNetworkId) : identity?.preflight?.identity;
          return { ...requestDiagnostic("NATIVE_REDIRECT_LOADER_MISMATCH"), phase,
            ...(event.request.method === "OPTIONS" ? {
              preflightCandidatePresent: Boolean(candidate),
              ...(candidate ? { preflightCandidateInvalid: candidate.invalid } : {}),
              preflightSourceKnown: Boolean(preflightSource),
              ...(preflightSource ? {
                preflightSourceMethod: /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/u.test(preflightSource.method)
                  ? preflightSource.method as NonNullable<NativeRequestDiagnostic["preflightSourceMethod"]> : "OTHER",
                preflightSourceCurrentGeneration: preflightSource.generation === generation && !generation.retired,
                preflightSourceFailed: failedNetworkIdentities.has(preflightSource),
                preflightSourceBodyPresent: preflightSource.hasBody,
                preflightSourceRootFrame: preflightSource.frameId === rootFrameId,
                preflightSourceLoaderKnown: loaderOwners.get(preflightSource.loaderId) === generation,
                preflightSourceUrlMatches: preflightSource.url === event.request.url,
              } : {}),
            } : {}),
            identityPresent: Boolean(identity), loaderPresent: Boolean(identity?.loaderId),
            loaderKnown: Boolean(identity?.loaderId && loaderOwners.has(identity.loaderId)), identityFresh: fresh(identity),
            identityUrlMatches: identity?.url === event.request.url, identityMethodMatches: identity?.method === event.request.method,
            identityKindMatches: sameKind(identity), identityFrameMatches: identity?.frameId === rootFrameId,
            parentPresent: Boolean(parent), awaitingDocument,
            parentCurrentGeneration: Boolean(parent && parent.generation === generation && !parent.generation.retired),
            documentCommitted: Boolean(committedDocument), documentIntentPresent: Boolean(documentIntent), documentIntentUsed: documentIntent?.used === true,
            sourceResponseComplete: committedDocument?.record.complete === true, successorTerminalFailed: pendingInitialPause?.terminalFailed === true };
        };
        const current = networkIdentities.get(networkId);
        // CDP reuses Network.requestId across HTTP redirects. Fetch can pause
        // the child before requestWillBeSent publishes its next hop. Only the
        // exact consumed parent revision may wait; a fresh mismatch is fatal.
        const parentHopPending = parent && networkId === parent.networkId && current?.revision === parent.networkIdentityRevision;
        if (!current || parentHopPending) {
          const waiter = networkWaiters.get(networkId) ?? pending<void>(); networkWaiters.set(networkId, waiter);
          try { await bounded(Promise.race([waiter.promise, pendingInitialPause.cancelled.promise]), "NATIVE_REDIRECT_LOADER_TIMEOUT",
            () => diagnostic("LOADER_IDENTITY_WAIT")); }
          finally { networkWaiters.delete(networkId); }
        }
        if (pendingInitialPause.retired) { await pendingInitialPause.retirementAck; return; }
        if (closed || options.signal?.aborted) return;
        const identity = networkIdentities.get(networkId);
        const preflight = identity?.preflight;
        const preflightHeaders = preflight ? headers(event.request.headers) : undefined;
        const source = preflight?.identity;
        const exactPreflight = Boolean(preflight && identity && !failedNetworkIdentities.has(identity) && !preflight.used && !parent && event.request.method === "OPTIONS" &&
          event.request.hasPostData !== true && event.request.postData === undefined && ["xhr", "fetch", "other"].includes(kind) &&
          preflightHeaders?.["access-control-request-method"] === source?.method &&
          networkIdentities.get(preflight.networkId) === source && preflight.generation === generation && !generation.retired && !boundaryPending &&
          source && ["GET", "HEAD", "POST"].includes(source.method) && !failedNetworkIdentities.has(source) && (!source.hasBody || source.method === "POST") && source.frameId === rootFrameId && source.url === event.request.url &&
          loaderOwners.get(source.loaderId) === generation);
        if (preflight && !exactPreflight) {
          firstFatal ??= diagnostic("LOADER_IDENTITY"); await reject(); await close("NATIVE_REDIRECT_LOADER_MISMATCH"); return;
        }
        const ownership = exactPreflight ? source : identity;
        const kindMismatch = !exactPreflight && !sameKind(identity);
        if (!identity || !ownership?.loaderId || !exactPreflight && identity.frameId !== rootFrameId || identity.url !== event.request.url || identity.method !== event.request.method || !fresh(identity) ||
            kindMismatch && (!identity.kindKnown || kind === "document" || identity.kind === "document" || !["GET", "HEAD"].includes(event.request.method))) {
          firstFatal ??= diagnostic("LOADER_IDENTITY"); await reject(); await close("NATIVE_REDIRECT_LOADER_MISMATCH"); return;
        }
        const known = loaderOwners.get(ownership.loaderId);
        if (kind === "document" && !parent && awaitingDocument && !known) {
          generation.loaderId = identity.loaderId; loaderOwners.set(identity.loaderId, generation); awaitingDocument = false;
        } else if (!known) {
          const intent = documentIntent;
          const eligible = kind === "document" && !parent && !boundaryPending && !awaitingDocument && intent && !intent.used &&
            intent.source === committedDocument && intent.source.record.generation === generation && !generation.retired &&
            !intent.source.record.failed && loaderOwners.get(intent.source.loaderId) === generation &&
            event.request.url === intent.target && ["GET", "HEAD"].includes(event.request.method) &&
            event.request.hasPostData !== true && event.request.postData === undefined &&
            identity.revision > intent.networkRevision && Date.now() - intent.createdAt <= timeoutMs;
          if (!eligible || !intent) {
            firstFatal ??= diagnostic("LOADER_OWNER"); await reject(); await close("NATIVE_REDIRECT_LOADER_MISMATCH"); return;
          }
          intent.used = true; boundaryPending = true;
          const previous = generation, successor: DocumentGeneration = { id: previous.id + 1, retired: false, loaderId: identity.loaderId };
          // Protect this exact pause from old-generation retirement; it has no
          // handler, lease, response evidence or loader ownership until drain.
          pendingInitialPause.generation = successor; pendingInitialPause.successorIdentity = identity;
          let phase: NonNullable<NativeRequestDiagnostic["phase"]> = "DOCUMENT_INTENT";
          try {
            const sourceResponse = await bounded(Promise.race([intent.source.record.response.promise, pendingInitialPause.cancelled.promise]),
              "NATIVE_REDIRECT_PROVENANCE_TIMEOUT");
            if (pendingInitialPause.terminalFailed) throw new Error("NATIVE_REDIRECT_NETWORK_FAILED");
            if (!sourceResponse || sourceResponse instanceof Error || !intent.source.record.complete || intent.source.record.failed ||
              sourceResponse.status() < 200 || sourceResponse.status() >= 300 || committedDocument !== intent.source || documentIntent !== intent ||
              generation !== previous || previous.retired || closed || options.signal?.aborted)
              throw new Error("NATIVE_REDIRECT_LOADER_MISMATCH");
            phase = "DOCUMENT_DRAIN";
            await retireGeneration(previous, false);
            if (pendingInitialPause.terminalFailed) throw new Error("NATIVE_REDIRECT_NETWORK_FAILED");
            if (closed || options.signal?.aborted || pendingInitialPause.retired || generation !== previous ||
              committedDocument !== intent.source || documentIntent !== intent || networkIdentities.get(networkId) !== identity)
              throw new Error("NATIVE_REDIRECT_LOADER_MISMATCH");
            generation = successor; loaderOwners.set(identity.loaderId, successor); awaitingDocument = false;
            committedDocument = undefined; documentIntent = undefined;
          } catch (error) {
            const code = error instanceof Error && /^[A-Z_0-9]+$/u.test(error.message) ? error.message : "NATIVE_REDIRECT_LOADER_MISMATCH";
            firstFatal ??= { ...diagnostic(phase), code };
            if (!closed) await abortInitialPause(pendingInitialPause);
            throw error;
          } finally { boundaryPending = false; }
        }
        requestGeneration = loaderOwners.get(ownership.loaderId)!;
        requestLoaderId = ownership.loaderId;
        if (parent && requestGeneration !== parent.generation) {
          firstFatal ??= diagnostic("REDIRECT_GENERATION"); await reject(); await close("NATIVE_REDIRECT_LOADER_MISMATCH"); return;
        }
        if (kindMismatch && (requestGeneration !== generation || requestGeneration.retired)) {
          firstFatal ??= diagnostic("LOADER_OWNER"); await reject(); await close("NATIVE_REDIRECT_LOADER_MISMATCH"); return;
        }
        denyResourceKind = kindMismatch;
        requestIdentityRevision = identity.revision;
        if (exactPreflight && preflight) { preflight.used = true; requestPreflight = preflight; }
      }
      if (parent) {
        // A redirected child may pause before the parent's route handler
        // resumes. Wait outside the child handler/provider lane for that exact
        // parent's successful release; no FIFO/URL inference or origin grant.
        const result = await bounded(Promise.race([parent.response.promise, pendingInitialPause.cancelled.promise]), "NATIVE_REDIRECT_PROVENANCE_TIMEOUT");
        if (pendingInitialPause.retired) { await pendingInitialPause.retirementAck; return; }
        if (closed || options.signal?.aborted) return;
        const document = kind === "document";
        let sameHost = false;
        try { sameHost = new URL(parent.transportUrl).hostname.replace(/^www\./u, "") === new URL(event.request.url).hostname.replace(/^www\./u, ""); }
        catch { /* Invalid URLs fail the provenance check. */ }
        if (!result || result instanceof Error || records.has(event.requestId) || !releasedRedirect(parent, event.request.url) ||
            denyResourceKind && (parent.kind !== kind || networkId !== parent.networkId) ||
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
      if (denyResourceKind) {
        // A current, exact public GET can be classified differently by two
        // Chrome event streams. This grants NO read: abort its tracked pause
        // before any handler/lease/response. Independent replay must treat the
        // rejection as incomplete; discovery can still inspect the document.
        const diagnostic = requestDiagnostic("NATIVE_REDIRECT_RESOURCE_KIND_REJECTED");
        await abortInitialPause(pendingInitialPause);
        if (closed || options.signal?.aborted || pendingInitialPause.generation.retired) return;
        rejectedRequests.push(diagnostic);
        if (rejectedRequests.length > 12) rejectedRequests.shift();
        try { options.onRequestRejected?.({ ...diagnostic }); } catch { /* No diagnostic authorizes data. */ }
        return;
      }
      const record: RecordEntry = { id: event.requestId, networkId, url: event.request.url, transportUrl: event.request.url,
        method: event.request.method, headers: headers(event.request.headers), headerEntries: rawHeaderEntries(event.request.headers), body: event.request.postData ?? null, kind,
        parent: parent ?? null, depth: parent ? parent.depth + 1 : 0, paused: true, admitted: false, failed: false, responseStarted: false, complete: false,
        generation: requestGeneration, loaderId: requestLoaderId, networkIdentityRevision: requestIdentityRevision, preflight: requestPreflight,
        cancellation: new AbortController(), handlerDone: false, responsePaused: false,
        response: pending(), adapter: undefined as unknown as NativeReadRequest };
      record.adapter = { signal: record.cancellation.signal, url: () => record.url, method: () => record.method, headers: () => ({ ...record.headers }), postData: () => record.body,
        resourceType: () => record.kind, isNavigationRequest: () => record.kind === "document", frame: () => page.mainFrame(),
        redirectedFrom: () => record.parent?.adapter ?? null, response: async () => {
          const value = await bounded(record.response.promise, "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
            () => responseTimeoutDiagnostic(record, "RESPONSE_WAIT")); if (value instanceof Error) throw value; return value;
        } };
      nativeRequestRecords.set(record.adapter, { record, owner });
      records.set(record.id, record);
      initialPauses.delete(event.requestId); pendingInitialPause = undefined;
      if (requestGeneration.retired) {
        await bounded(reject(), "NATIVE_REDIRECT_ABORT_TIMEOUT"); record.paused = false;
        failRecord(record, "NATIVE_READ_SUPERSEDED"); record.handlerDone = true; return;
      }
      const route: NativeReadRoute = { request: () => record.adapter,
        continue: async values => {
          if (record.failure && isNativeReadTerminalFailure(record.failure)) throw record.failure;
          if (record.generation.retired) {
            const value = await bounded(record.response.promise, "NATIVE_REDIRECT_DRAIN_TIMEOUT");
            if (value instanceof Error) throw value;
            throw new Error("NATIVE_REDIRECT_RETIRED_DISPATCH");
          }
          if (!record.paused || closed || record.failed || options.signal?.aborted || values && Object.keys(values).some(key => key !== "url") ||
              record.publicHeaderProof && !isCurrentPublicClientReadHeaders(record.publicHeaderProof) ||
              record.preflight && (failedNetworkIdentities.has(record.preflight.identity) || networkIdentities.get(record.preflight.networkId) !== record.preflight.identity || record.preflight.generation !== generation ||
                record.generation.retired || loaderOwners.get(record.preflight.identity.loaderId) !== record.generation) ||
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
          if (record.generation.retired && record.retirementAck) { await record.retirementAck; return; }
          if (record.paused && !closed) { record.paused = false; failRecord(record, "NATIVE_REDIRECT_REQUEST_REJECTED"); await reject(); }
        },
        fulfill: async () => { throw new Error("NATIVE_REDIRECT_FULFILL_REJECTED"); },
      };
      try { await handler(route); }
      catch (error) {
        await route.abort().catch(() => {});
        if (record.failure && isNativeReadTerminalFailure(record.failure) && error === record.failure) return;
        await close("NATIVE_REDIRECT_HANDLER_FAILED");
      } finally { record.handlerDone = true; }
    })().catch(error => { void close(error instanceof Error && /^[A-Z_0-9]+$/u.test(error.message) ? error.message : "NATIVE_REDIRECT_ROUTING_FAILED"); })
      .finally(() => { if (pendingInitialPause) initialPauses.delete(pendingInitialPause.id); pendingReads--; });
  });
  try {
    await cdp.send("Page.enable");
    await cdp.send("Network.enable", { maxTotalBufferSize: PUBLIC_BROWSER_TOTAL_BYTES, maxResourceBufferSize: 16_000_000, maxPostDataSize: 32768 });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    enabled = true;
    if (options.signal?.aborted) { await close("NATIVE_REDIRECT_CANCELLED"); options.signal.throwIfAborted(); }
  } catch (error) { await close("NATIVE_REDIRECT_INSTALL_FAILED"); throw error; }
  return {
    prepare(frame: Frame) {
      if (closed || !enabled || frame !== page.mainFrame()) { failure("NATIVE_REDIRECT_FRAME_UNGUARDED"); throw new Error("NATIVE_REDIRECT_FRAME_UNGUARDED"); }
    },
    async beginDocumentNavigation(frame: Frame) {
      if (closed || !enabled || frame !== page.mainFrame() || boundaryPending || options.signal?.aborted)
        throw new Error("NATIVE_REDIRECT_NAVIGATION_REJECTED");
      boundaryPending = true;
      const previous = generation;
      committedDocument = undefined; documentIntent = undefined;
      try {
        // Stop dispatch before the successor document starts. Only an exact
        // paused-abort ACK or Network.loadingFailed can settle an old lease.
        await retireGeneration(previous, true);
        if (closed || options.signal?.aborted) throw new Error("NATIVE_REDIRECT_CLOSED");
        generation = { id: previous.id + 1, retired: false }; generationTracking = true; awaitingDocument = true;
      } catch (error) { await close("NATIVE_REDIRECT_DRAIN_FAILED"); throw error; }
      finally { boundaryPending = false; }
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
