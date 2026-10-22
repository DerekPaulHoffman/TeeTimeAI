import { createServer, type IncomingMessage } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { hasAttestedNativeDocumentRedirect, hasAttestedNativeDocumentRedirectTarget, isNativeReadTerminalFailure, type NativeReadRoute } from "./native-redirect-routing";
import { resolvePinnedPublicAddress, type ResolvedPublicAddress } from "@/lib/automation/address-pinned-public-fetch";
import { isSafeRecipeUrl } from "./recipe";
import { canonicalPublicReadUrl } from "./public-request-url";

export type NativePublicProxyDependencies = {
  resolveAddresses?: (hostname: string) => Promise<ResolvedPublicAddress[]>;
  connect?: (options: { host: string; family: 4 | 6; port: number }) => Socket;
};

export type NativePublicProxy = {
  server: string;
  close(): Promise<void>;
  allowHostConnections(hostname: string): void;
  cancelHostConnections(hostname: string): Promise<void>;
  stats(): { connections: number; activeSockets: number; bytes: number };
};

/** OPTIONS only discovers whether the browser may issue a separately guarded
 * read. It does not authorize the eventual POST or expand a recipe route. */
export function nativeReadPreflightMethod(headers: Record<string, string>): "GET" | "HEAD" | "POST" | null {
  const method = headers["access-control-request-method"]?.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST" || !headers.origin || !isSafeRecipeUrl(headers.origin)) return null;
  const requested = headers["access-control-request-headers"] ?? "";
  if (requested && !/^[a-z0-9_, -]+$/iu.test(requested) || /authorization|cookie|token|secret|api[-_]?key/iu.test(requested)) return null;
  return method;
}

type RedirectRequest = { url(): string; method(): string; redirectedFrom(): RedirectRequest | null };
/** Actual controller-owned HTTP redirect proof, rooted in an exact explicit
 * navigation or observed public link. Origin membership is never sufficient. */
export function isObservedNativeRedirect(request: RedirectRequest, observedRootUrls: ReadonlySet<string>) {
  return hasAttestedNativeDocumentRedirect(request, observedRootUrls);
}
export function isObservedNativeRedirectTarget(request: RedirectRequest, target: string, observedRootUrls: ReadonlySet<string>) {
  return hasAttestedNativeDocumentRedirectTarget(request, target, observedRootUrls);
}

function connectHost(request: IncomingMessage) {
  if (request.headers.authorization || request.headers["proxy-authorization"] || request.headers.cookie ||
    request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) return null;
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):443$/iu.exec(request.url ?? "");
  return match?.[1].toLowerCase() ?? null;
}

/** A loopback-only HTTPS tunnel. It never terminates TLS: Chrome talks directly
 * to the checked public address using its own TLS and anonymous cookie state. */
export async function createNativePublicBrowserProxy(input: {
  signal: AbortSignal;
  maxBytes?: number;
  maxConnections?: number;
}, dependencies: NativePublicProxyDependencies = {}): Promise<NativePublicProxy> {
  input.signal.throwIfAborted();
  const maxBytes = Math.min(24_000_000, Math.max(1, input.maxBytes ?? 24_000_000));
  const maxConnections = Math.min(192, Math.max(1, input.maxConnections ?? 192));
  const sockets = new Set<Socket>();
  const socketHosts = new Map<Socket, string>();
  const hostGenerations = new Map<string, number>();
  const pausedHosts = new Set<string>();
  const cancellation = new AbortController();
  const signal = AbortSignal.any([input.signal, cancellation.signal]);
  let connections = 0, bytes = 0, closed = false;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(405, { connection: "close" }); response.end();
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    cancellation.abort("NATIVE_PROXY_CLOSED");
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>(resolve => { server.close(() => resolve()); });
    return closing;
  };
  const abort = () => { void close(); };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); socketHosts.delete(socket); });
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => { bytes += chunk.length; if (bytes > maxBytes) void close(); });
    socket.setTimeout(15_000, () => socket.destroy());
  };
  server.on("connection", track);
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    const downstream = client as Socket;
    const hostname = connectHost(request);
    // Each live tunnel has a browser and upstream socket. Modern public pages
    // keep many idle CDN connections; sixteen tunnels can fail before data loads.
    if (!hostname || closed || ++connections > maxConnections || sockets.size > 128) {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    socketHosts.set(downstream, hostname);
    const generation = hostGenerations.get(hostname) ?? 0;
    if (pausedHosts.has(hostname)) { downstream.destroy(); return; }
    void (async () => {
      try {
        const address = await resolvePinnedPublicAddress(hostname, { resolveAddresses: dependencies.resolveAddresses, signal });
        signal.throwIfAborted();
        if (pausedHosts.has(hostname) || generation !== (hostGenerations.get(hostname) ?? 0)) { downstream.destroy(); return; }
        const upstream = (dependencies.connect ?? netConnect)({ host: address.address, family: address.family, port: 443 });
        track(upstream);
        socketHosts.set(upstream, hostname);
        upstream.once("error", () => downstream.destroy());
        downstream.once("close", () => upstream.destroy());
        upstream.once("close", () => downstream.destroy());
        upstream.once("connect", () => {
          if (signal.aborted || downstream.destroyed || pausedHosts.has(hostname) || generation !== (hostGenerations.get(hostname) ?? 0)) { upstream.destroy(); return; }
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) { bytes += head.length; if (bytes > maxBytes) { void close(); return; } upstream.write(head); }
          downstream.pipe(upstream); upstream.pipe(downstream);
        });
      } catch {
        if (!downstream.destroyed) downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  }).catch(async error => { await close(); throw error; });
  input.signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { await close(); throw new Error("NATIVE_PROXY_CLOSED"); }
  const port = (server.address() as AddressInfo).port;
  return { server: `http://127.0.0.1:${port}`, close: async () => { input.signal.removeEventListener("abort", abort); await close(); },
    allowHostConnections: hostname => { pausedHosts.delete(hostname.toLowerCase()); },
    cancelHostConnections: async hostname => {
      const host = hostname.toLowerCase();
      pausedHosts.add(host); hostGenerations.set(host, (hostGenerations.get(host) ?? 0) + 1);
      await Promise.all([...socketHosts].filter(([, value]) => value === host).map(([socket]) => new Promise<void>(done => {
        if (socket.destroyed) { done(); return; }
        socket.once("close", done); socket.destroy();
      })));
    },
    stats: () => ({ connections, activeSockets: sockets.size, bytes }) };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("NATIVE_REQUEST_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Call inside the provider lease. Continuing a route only dispatches it;
 * the lease remains held until the actual browser response finishes. */
export async function continueNativeBrowserRead(route: NativeReadRoute, signal: AbortSignal, maxBytes = 2_000_000,
  abortNetwork?: () => Promise<void>, canonicalUrl?: string) {
  let networkFinished = false;
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const responsePromise = route.request().response();
    // Dispatch or cleanup can fail before we await the response. Observe its
    // rejection now, while retaining the original promise and failure below.
    void responsePromise.catch(() => {});
    if (canonicalUrl && canonicalUrl !== route.request().url() &&
        canonicalPublicReadUrl(route.request().url(), route.request().method()) !== canonicalUrl) throw new Error("UNSAFE_REQUEST_REWRITE");
    await route.continue(canonicalUrl ? { url: canonicalUrl } : undefined);
    const response = await abortable(responsePromise, bounded);
    if (!response) { networkFinished = true; throw new Error("NATIVE_REQUEST_FAILED"); }
    const headers = await response.allHeaders();
    const declaredSize = Number(headers["content-length"] ?? 0);
    if (declaredSize > maxBytes) throw new Error("NATIVE_RESPONSE_LIMIT");
    const failure = await abortable(response.finished(), bounded);
    networkFinished = true;
    if (failure) throw new Error("NATIVE_REQUEST_FAILED");
    const status = response.status();
    const body = [204, 205, 304].includes(status) || status >= 300 && status < 400
      ? Buffer.alloc(0) : await abortable(response.body(), bounded);
    if (body.length > maxBytes) throw new Error("NATIVE_RESPONSE_LIMIT");
    return { url: response.url(), status, headers, body };
  } catch (error) {
    // route.abort cannot cancel an already continued request. Stop the actual
    // context/tunnel before releasing the enclosing provider request lease.
    // A controller-attested Network.loadingFailed/responseErrorReason already
    // ended this exact read. Destroying its host's tunnels would also cancel
    // independent reads paused behind the same provider queue.
    if (!networkFinished && !isNativeReadTerminalFailure(error)) await abortNetwork?.();
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("NATIVE_RESPONSE_TIMEOUT");
    throw error;
  }
}
