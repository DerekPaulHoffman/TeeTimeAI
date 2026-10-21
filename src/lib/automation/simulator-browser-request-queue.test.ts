// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimulatorBrowserRequestQueue } from "./simulator-browser-request-queue";

afterEach(() => vi.useRealTimers());
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe("interactive browser request capacity", () => {
  it("serializes a host while allowing a second host and never exceeds two active lanes", async () => {
    const controller = new AbortController();
    const release = deferred();
    const starts: string[] = [];
    let active = 0, maximum = 0;
    const lease = async <T>(host: string, work: () => Promise<T>) => {
      starts.push(host); active++; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    };
    const queue = createSimulatorBrowserRequestQueue(lease, controller.signal);
    try {
      const first = queue.run("same.test", async () => { await release.promise; return 1; });
      const second = queue.run("same.test", async () => 2);
      const other = queue.run("other.test", async () => { await release.promise; return 3; });
      const thirdHost = queue.run("third.test", async () => 4);
      expect(starts).toEqual(["same.test", "other.test"]);
      release.resolve();
      expect(await Promise.all([first, second, other, thirdHost])).toEqual([1, 2, 3, 4]);
      expect(starts.filter(host => host === "same.test")).toHaveLength(2);
      expect(maximum).toBe(2);
    } finally { controller.abort(); queue.dispose(); }
  });

  it("waits for external capacity without executing or replaying provider I/O", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let available = false;
    const work = vi.fn(async () => "calendar");
    const lease = vi.fn(async <T>(_host: string, run: () => Promise<T>) => available
      ? { acquired: true as const, value: await run() } : { acquired: false as const });
    const queue = createSimulatorBrowserRequestQueue(lease, controller.signal);
    try {
      const result = queue.run("same.test", work);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(work).not.toHaveBeenCalled();
      available = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toBe("calendar");
      expect(work).toHaveBeenCalledOnce();
    } finally { controller.abort(); queue.dispose(); }
  });

  it("cancels queued and capacity-waiting work without starting another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = vi.fn(async () => "must not run");
    const lease = vi.fn(async () => ({ acquired: false as const }));
    const queue = createSimulatorBrowserRequestQueue(lease, controller.signal);
    try {
      const first = expect(queue.run("same.test", work)).rejects.toThrow("original deadline");
      const second = expect(queue.run("same.test", work)).rejects.toThrow("original deadline");
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error("original deadline"));
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(lease).toHaveBeenCalledOnce();
      expect(work).not.toHaveBeenCalled();
    } finally { queue.dispose(); }
  });

  it("does not start network work when cancellation occurs during lease acquisition", async () => {
    const controller = new AbortController();
    const work = vi.fn(async () => "must not run");
    const lease = async <T>(_host: string, run: () => Promise<T>) => {
      controller.abort(new Error("owner stopped"));
      return { acquired: true as const, value: await run() };
    };
    const queue = createSimulatorBrowserRequestQueue(lease, controller.signal);
    try {
      await expect(queue.run("same.test", work)).rejects.toThrow("owner stopped");
      expect(work).not.toHaveBeenCalled();
    } finally { queue.dispose(); }
  });

  it("cancels only a retired document's queued work and preserves current peers and the original session signal", async () => {
    const session = new AbortController(), old = new AbortController(), release = deferred();
    const work = vi.fn(async () => "retired must not dispatch");
    const queue = createSimulatorBrowserRequestQueue(async (_host, run) => ({ acquired: true as const, value: await run() }), session.signal);
    try {
      const holding = queue.run("same.test", async () => { await release.promise; return "old terminal ACK"; });
      const retired = expect(queue.run("same.test", work, old.signal)).rejects.toThrow("retired document");
      const current = queue.run("same.test", async () => "new document");
      old.abort(new Error("retired document")); release.resolve();
      await expect(holding).resolves.toBe("old terminal ACK"); await retired;
      await expect(current).resolves.toBe("new document");
      expect(work).not.toHaveBeenCalled(); expect(session.signal.aborted).toBe(false);
    } finally { session.abort(); queue.dispose(); }
  });

  it("checks exact request cancellation after real lease acquisition before dispatch", async () => {
    const session = new AbortController(), old = new AbortController(), work = vi.fn();
    const queue = createSimulatorBrowserRequestQueue(async (_host, run) => {
      old.abort(new Error("terminal old read")); return { acquired: true as const, value: await run() };
    }, session.signal);
    try { await expect(queue.run("same.test", work, old.signal)).rejects.toThrow("terminal old read"); expect(work).not.toHaveBeenCalled(); }
    finally { session.abort(); queue.dispose(); }
  });
});
