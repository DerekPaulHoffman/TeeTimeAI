type RequestLease = <T>(hostname: string, work: () => Promise<T>) => Promise<
  { acquired: true; value: T } | { acquired: false }
>;
type PendingRequest = {
  hostname: string;
  signal: AbortSignal;
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function waitForCapacity(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, 500);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Queue this browser's resources before claiming the shared one-host/two-global
 * leases. A busy lease is backpressure, not a failed public page. The caller's
 * original response/session signal bounds both queued and capacity-waiting work.
 */
export function createSimulatorBrowserRequestQueue(lease: RequestLease, signal: AbortSignal) {
  const pending: PendingRequest[] = [];
  const activeHosts = new Set<string>();
  const abortPending = () => {
    for (const request of pending.splice(0)) request.reject(signal.reason);
  };
  signal.addEventListener("abort", abortPending, { once: true });

  const execute = async (request: PendingRequest) => {
    try {
      for (;;) {
        request.signal.throwIfAborted();
        const result = await lease(request.hostname, async () => {
          // Cancellation while the durable lease was being acquired must not
          // start another provider request; the lease helper still releases it.
          request.signal.throwIfAborted();
          return request.work();
        });
        request.signal.throwIfAborted();
        if (result.acquired) { request.resolve(result.value); return; }
        await waitForCapacity(request.signal);
      }
    } catch (error) { request.reject(error); }
    finally { activeHosts.delete(request.hostname); drain(); }
  };

  const drain = () => {
    if (signal.aborted) { abortPending(); return; }
    while (activeHosts.size < 2) {
      // Preserve per-host order without letting that host block another lane.
      const index = pending.findIndex(request => !activeHosts.has(request.hostname));
      if (index < 0) return;
      const [request] = pending.splice(index, 1);
      if (request.signal.aborted) { request.reject(request.signal.reason); continue; }
      activeHosts.add(request.hostname);
      void execute(request);
    }
  };

  return {
    run<T>(hostname: string, work: () => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
      const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      combined.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        pending.push({ hostname: hostname.toLowerCase(), signal: combined, work, resolve: value => resolve(value as T), reject });
        drain();
      });
    },
    dispose() { signal.removeEventListener("abort", abortPending); },
  };
}
