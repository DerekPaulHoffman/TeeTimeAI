/** Private loopback CDP multiplexer. No URL, frame, response, or error payload is logged. */
import WebSocket from "ws";
export type OwnedCdpEvent = Record<string, unknown>;
type Listener = (value: OwnedCdpEvent) => unknown;
type Pending = { method: string; resolve: (value: OwnedCdpEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const methods = ["Extensions.loadUnpacked", "Fetch.continueRequest", "Fetch.continueResponse", "Fetch.enable", "Fetch.failRequest", "Fetch.getResponseBody",
  "Network.enable", "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.getFrameTree", "Page.stopLoading", "Runtime.enable", "Runtime.evaluate", "Runtime.runIfWaitingForDebugger",
  "Target.closeTarget", "Target.createTarget", "Target.detachFromTarget", "Target.getBrowserContexts", "Target.getTargets", "Target.setAutoAttach", "Target.setDiscoverTargets"] as const;
const events = ["Target.attachedToTarget", "Target.detachedFromTarget", "Target.targetDestroyed", "Fetch.requestPaused", "Network.loadingFailed",
  "Network.requestWillBeSent", "Page.frameNavigated", "Page.frameRequestedNavigation", "Page.navigatedWithinDocument"] as const;
export type OwnedCdpFailure = { layer: "RPC" | "ASYNC_LISTENER" | "SYNC_LISTENER" | "SEND" | "TIMEOUT" | "SOCKET_ERROR" | "SOCKET_CLOSE" | "OPEN_TIMEOUT" | "PROTOCOL" | "ABORT";
  method?: typeof methods[number] | "UNKNOWN"; event?: typeof events[number] | "UNKNOWN"; rpcCode?: number;
  lifecycle?: "SESSION_NOT_FOUND" | "TARGET_CLOSED" | "CONTEXT_DESTROYED" | "FRAME_NOT_FOUND" | "UNKNOWN"; pendingRequests: number;
  socketErrorName?: string; socketErrorCode?: string; socketCauseCode?: string; socketFailureCategory?: "DECOMPRESSED_MESSAGE_LIMIT" | "UNKNOWN"; socketCloseCode?: number; socketWasClean?: boolean };
const errorNames = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "DOMException", "NetworkError", "WebSocketError", "MessageSizeExceededError"];
const errorCodes = ["UND_ERR_WS_MESSAGE_SIZE_EXCEEDED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_DESTROYED", "UND_ERR_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Z_DATA_ERROR", "Z_BUF_ERROR", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND"];
export function projectOwnedSocketError(error: unknown) {
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; cause?: unknown; message?: unknown } : {};
  const cause = value.cause && typeof value.cause === "object" ? value.cause as { code?: unknown } : {};
  const code = (raw: unknown) => typeof raw === "string" && errorCodes.includes(raw) ? raw : "UNKNOWN";
  return { socketErrorName: typeof value.name === "string" && errorNames.includes(value.name) ? value.name : "UNKNOWN",
    socketFailureCategory: value.message === "Max decompressed message size exceeded" ? "DECOMPRESSED_MESSAGE_LIMIT" as const : "UNKNOWN" as const,
    ...(value.code !== undefined ? { socketErrorCode: code(value.code) } : {}), ...(cause.code !== undefined ? { socketCauseCode: code(cause.code) } : {}) };
}
export type OwnedCdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<OwnedCdpEvent>;
  on(method: string, listener: Listener): void;
  off(method: string, listener: Listener): void;
  detach(): Promise<void>;
};
const failure = () => new Error("OWNED_STAGEHAND_CDP_UNAVAILABLE");
export async function connectOwnedSourceCdp(endpoint: string, signal: AbortSignal, onFailure: () => void = () => {}) {
  if (!/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/devtools\/browser\/[a-f0-9-]{20,80}$/u.test(endpoint) || signal.aborted) throw failure();
  const socket = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 32_000_000, followRedirects: false, handshakeTimeout: 5000 });
  const pending = new Map<number, Pending>(), listeners = new Map<string, Set<Listener>>();
  let sequence = 0, closed = false;
  let firstFailure: OwnedCdpFailure | undefined;
  const remember = (layer: OwnedCdpFailure["layer"], method?: string, event?: string, error?: unknown) => {
    if (firstFailure) return;
    const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
    const message = typeof value.message === "string" ? value.message.slice(0, 4000) : "";
    const lifecycle = /\bSession with given id not found\b/u.test(message) ? "SESSION_NOT_FOUND" : /\b(?:Target|target) (?:has been )?closed\b/u.test(message) ? "TARGET_CLOSED"
      : /\b(?:Execution context was destroyed|Cannot find context with specified id)\b/u.test(message) ? "CONTEXT_DESTROYED" : /\b(?:Frame|frame) (?:with given id )?not found\b/u.test(message) ? "FRAME_NOT_FOUND" : "UNKNOWN";
    firstFailure = { layer, pendingRequests: pending.size,
      ...(method ? { method: methods.includes(method as typeof methods[number]) ? method as typeof methods[number] : "UNKNOWN" } : {}),
      ...(event ? { event: events.includes(event as typeof events[number]) ? event as typeof events[number] : "UNKNOWN" } : {}),
      ...(layer === "RPC" ? { lifecycle } : {}),
      ...(Number.isInteger(value.code) && Number(value.code) >= -2147483648 && Number(value.code) <= 2147483647 ? { rpcCode: Number(value.code) } : {}) };
  };
  const key = (session: string | undefined, method: string) => (session ?? "") + "\n" + method;
  const rejectAll = () => {
    if (closed) return; closed = true;
    // The host destroys its public tunnels synchronously before closing this
    // debugger connection can release any paused request without a guardian.
    try { onFailure(); } catch { /* Never expose transport details. */ }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); }
    pending.clear(); listeners.clear(); socket.close();
  };
  const aborted = () => { if (signal.reason !== "STAGEHAND_SOURCE_CLOSED") remember("ABORT"); rejectAll(); };
  signal.addEventListener("abort", aborted, { once: true });
  socket.addEventListener("close", event => {
    try { if (!closed) {
      remember("SOCKET_CLOSE");
      if (firstFailure?.layer === "SOCKET_CLOSE") {
        const value = event;
        if (Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999) firstFailure.socketCloseCode = value.code;
        if (typeof value.wasClean === "boolean") firstFailure.socketWasClean = value.wasClean;
      }
    } } catch { /* Diagnostic access cannot prevent guardian shutdown. */ }
    finally { rejectAll(); }
  });
  socket.addEventListener("error", event => {
    try { if (!closed) { remember("SOCKET_ERROR"); if (firstFailure?.layer === "SOCKET_ERROR") Object.assign(firstFailure, projectOwnedSocketError(event.error)); } }
    catch { /* Diagnostic access cannot prevent guardian shutdown. */ }
    finally { rejectAll(); }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { remember("OPEN_TIMEOUT"); rejectAll(); reject(failure()); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(failure()); }, { once: true });
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(failure()); }, { once: true });
  });
  socket.addEventListener("message", event => {
    if (closed) return;
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 32_000_000) { remember("PROTOCOL"); rejectAll(); return; }
    let value: { id?: number; error?: unknown; result?: OwnedCdpEvent; method?: string; sessionId?: string; params?: OwnedCdpEvent };
    try { value = JSON.parse(event.data); } catch { remember("PROTOCOL"); rejectAll(); return; }
    if (typeof value.id === "number") {
      const item = pending.get(value.id); if (!item) return;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) { remember("RPC", item.method, undefined, value.error); item.reject(failure()); } else item.resolve(value.result ?? {});
      return;
    }
    if (typeof value.method !== "string") return;
    for (const listener of listeners.get(key(value.sessionId, value.method)) ?? []) {
      try { void Promise.resolve(listener(value.params ?? {})).catch(() => { remember("ASYNC_LISTENER", undefined, value.method); rejectAll(); }); }
      catch { remember("SYNC_LISTENER", undefined, value.method); rejectAll(); }
    }
  });
  const send = (sessionId: string | undefined, method: string, params: Record<string, unknown> = {}) => {
    if (closed || signal.aborted || pending.size >= 256 || !/^[A-Za-z]+\.[A-Za-z]+$/u.test(method)) { if (!closed) remember("SEND", method); return Promise.reject(failure()); }
    const id = ++sequence;
    return new Promise<OwnedCdpEvent>((resolve, reject) => {
      const timer = setTimeout(() => { remember("TIMEOUT", method); pending.delete(id); reject(failure()); }, 15_000);
      pending.set(id, { method, resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { remember("SEND", method); clearTimeout(timer); pending.delete(id); reject(failure()); }
    });
  };
  const session = (sessionId?: string): OwnedCdpSession => ({
    send: (method, params) => send(sessionId, method, params),
    on(method, listener) { const k = key(sessionId, method); if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(listener); },
    off(method, listener) { listeners.get(key(sessionId, method))?.delete(listener); },
    async detach() { if (sessionId && !closed) await send(undefined, "Target.detachFromTarget", { sessionId }); },
  });
  return { root: session(), session, failureDiagnostic: () => firstFailure ? { ...firstFailure } : undefined,
    close() { signal.removeEventListener("abort", aborted); rejectAll(); } };
}
