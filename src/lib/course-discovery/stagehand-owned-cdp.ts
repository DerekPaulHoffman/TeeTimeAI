/** Private loopback CDP multiplexer. No URL, frame, response, or error payload is logged. */
export type OwnedCdpEvent = Record<string, unknown>;
type Listener = (value: OwnedCdpEvent) => unknown;
type Pending = { resolve: (value: OwnedCdpEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type OwnedCdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<OwnedCdpEvent>;
  on(method: string, listener: Listener): void;
  off(method: string, listener: Listener): void;
  detach(): Promise<void>;
};
const failure = () => new Error("OWNED_STAGEHAND_CDP_UNAVAILABLE");
export async function connectOwnedSourceCdp(endpoint: string, signal: AbortSignal, onFailure: () => void = () => {}) {
  if (!/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/devtools\/browser\/[a-f0-9-]{20,80}$/u.test(endpoint) || signal.aborted) throw failure();
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, Pending>(), listeners = new Map<string, Set<Listener>>();
  let sequence = 0, closed = false;
  const key = (session: string | undefined, method: string) => (session ?? "") + "\n" + method;
  const rejectAll = () => {
    if (closed) return; closed = true;
    // The host destroys its public tunnels synchronously before closing this
    // debugger connection can release any paused request without a guardian.
    try { onFailure(); } catch { /* Never expose transport details. */ }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); }
    pending.clear(); listeners.clear(); socket.close();
  };
  signal.addEventListener("abort", rejectAll, { once: true });
  socket.addEventListener("close", rejectAll);
  socket.addEventListener("error", rejectAll);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { rejectAll(); reject(failure()); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(failure()); }, { once: true });
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(failure()); }, { once: true });
  });
  socket.addEventListener("message", event => {
    if (closed || typeof event.data !== "string" || Buffer.byteLength(event.data) > 32_000_000) { rejectAll(); return; }
    let value: { id?: number; error?: unknown; result?: OwnedCdpEvent; method?: string; sessionId?: string; params?: OwnedCdpEvent };
    try { value = JSON.parse(event.data); } catch { rejectAll(); return; }
    if (typeof value.id === "number") {
      const item = pending.get(value.id); if (!item) return;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(failure()); else item.resolve(value.result ?? {});
      return;
    }
    if (typeof value.method !== "string") return;
    for (const listener of listeners.get(key(value.sessionId, value.method)) ?? []) {
      try { void Promise.resolve(listener(value.params ?? {})).catch(() => rejectAll()); } catch { rejectAll(); }
    }
  });
  const send = (sessionId: string | undefined, method: string, params: Record<string, unknown> = {}) => {
    if (closed || signal.aborted || pending.size >= 256 || !/^[A-Za-z]+\.[A-Za-z]+$/u.test(method)) return Promise.reject(failure());
    const id = ++sequence;
    return new Promise<OwnedCdpEvent>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(failure()); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); pending.delete(id); reject(failure()); }
    });
  };
  const session = (sessionId?: string): OwnedCdpSession => ({
    send: (method, params) => send(sessionId, method, params),
    on(method, listener) { const k = key(sessionId, method); if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(listener); },
    off(method, listener) { listeners.get(key(sessionId, method))?.delete(listener); },
    async detach() { if (sessionId && !closed) await send(undefined, "Target.detachFromTarget", { sessionId }); },
  });
  return { root: session(), session, close() { signal.removeEventListener("abort", rejectAll); rejectAll(); } };
}
