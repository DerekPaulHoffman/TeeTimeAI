// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoverySupervisor } from "../../../scripts/automation/course-discovery-supervisor.mjs";

const originTime = Date.parse("2026-10-21T20:00:00Z");
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const assignedJob = (overrides = {}) => ({ id: "activation-job", leaseToken: "private-owned-lease", attempts: 1,
  firstPickedUpAt: new Date(originTime).toISOString(), deadlineAt: new Date(originTime + 900_000).toISOString(),
  leaseExpiresAt: new Date(originTime + 90_000).toISOString(),
  request: { target: { courseId: "course", kind: "OUTDOOR" }, identity: { name: "Public golf" }, input: { date: "2026-10-23" } },
  ...overrides });
type WorkerOptions = { signal: AbortSignal; beforeActivate: () => Promise<void>; afterActivate?: (value: { metrics: typeof metrics }) => void };
const cancelled = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const metrics = { model: "gpt-6.1-sol", tokenUsage: { totalTokens: 123, cachedInputTokens: 100 }, replayDurationsMs: [10, 20] };
const clientFor = (job: ReturnType<typeof assignedJob>, heartbeat: () => Promise<unknown> = vi.fn(async () => ({}))) => ({
  next: vi.fn().mockResolvedValueOnce({ job }).mockResolvedValue({ job: null }), heartbeat, fail: vi.fn(async () => ({})),
});
afterEach(() => { vi.useRealTimers(); });

describe("discovery activation and heartbeat handoff", () => {
  it.each(["LEASE_EXPIRY", "WORK_DEADLINE"] as const)("does not turn a successful activation ACK into %s during local cleanup", async fence => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const cleanup = deferred<void>();
    const job = fence === "LEASE_EXPIRY"
      ? assignedJob({ leaseExpiresAt: new Date(originTime + 1_000).toISOString() })
      : assignedJob({ firstPickedUpAt: new Date(originTime - 719_000).toISOString(), deadlineAt: new Date(originTime + 181_000).toISOString() });
    const client = clientFor(job), onEvent = vi.fn();
    const finalActivate = vi.fn(async () => ({ jobId: job.id, recipeId: "persisted-recipe", hash: "a".repeat(64) }));
    const startWorker = vi.fn(async ({ beforeActivate, afterActivate }: WorkerOptions) => {
      await beforeActivate();
      await finalActivate(); // Trusted final server CAS has acknowledged success.
      afterActivate?.({ metrics });
      await cleanup.promise;
      return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(0);
    try {
      expect(finalActivate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(startWorker.mock.calls[0][0].signal.aborted).toBe(false);
      cleanup.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "activated",
        activationAcknowledgedAt: new Date(originTime).toISOString(), metrics: { ...metrics, metricsFinal: true } }));
      expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "attempt_ended" }));
    } finally { cleanup.resolve(); await vi.advanceTimersByTimeAsync(0); await supervisor.stop(); }
  });

  it("releases wedged post-ACK cleanup at five seconds with copied partial metrics and no second wait", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const cleanup = deferred<void>(), partial = structuredClone(metrics), onEvent = vi.fn();
    const job = assignedJob({ leaseExpiresAt: new Date(originTime + 1_000).toISOString() }), client = clientFor(job);
    const startWorker = vi.fn(async ({ beforeActivate, afterActivate }: WorkerOptions) => {
      await beforeActivate(); afterActivate?.({ metrics: partial });
      partial.tokenUsage.totalTokens = 999; // A later worker update cannot rewrite the ACK snapshot.
      await cleanup.promise; return { outcome: "activated", metrics: partial };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(4_999);
    expect(supervisor.activeCount).toBe(1); expect(startWorker.mock.calls[0][0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.activeCount).toBe(0); expect(startWorker.mock.calls[0][0].signal.aborted).toBe(true);
    const activated = onEvent.mock.calls.map(([event]) => event).filter(event => event.event === "activated");
    expect(activated).toEqual([expect.objectContaining({ firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt,
      completedAt: new Date(originTime + 5_000).toISOString(), activationAcknowledgedAt: new Date(originTime).toISOString(),
      metrics: { ...metrics, metricsFinal: false, cleanupWarning: "POST_ACTIVATION_CLEANUP_PENDING" } })]);
    expect(client.fail).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "attempt_ended" }));
    cleanup.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(activated[0].metrics.tokenUsage.totalTokens).toBe(123);
    expect(activated[0].metrics.metricsFinal).toBe(false);
    await supervisor.stop();
  });

  it("rejects afterActivate before beforeActivate has established the final-CAS phase", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const client = clientFor(assignedJob()), onEvent = vi.fn();
    const startWorker = vi.fn(async ({ afterActivate }: WorkerOptions) => {
      afterActivate?.({ metrics }); return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", code: "DISCOVERY_ACTIVATION_ACK_INVALID" }));
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "activated" }));
    expect(client.fail).toHaveBeenCalledWith("activation-job", "private-owned-lease", "TOOL_FAILURE", true);
    await supervisor.stop();
  });

  it("rejects afterActivate while the pre-activation heartbeat is still draining", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const heartbeat = deferred<unknown>(), ready = deferred<void>(), onEvent = vi.fn();
    const client = clientFor(assignedJob(), vi.fn(() => heartbeat.promise));
    let phaseFailure: unknown;
    const startWorker = vi.fn(async ({ beforeActivate, afterActivate }: WorkerOptions) => {
      await ready.promise; const draining = beforeActivate();
      try { afterActivate?.({ metrics }); } catch (error) { phaseFailure = error; }
      heartbeat.resolve({ job: { leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() } });
      await draining; afterActivate?.({ metrics }); return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(15_000); ready.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(phaseFailure).toMatchObject({ code: "DISCOVERY_ACTIVATION_ACK_INVALID" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "activated", metrics: { ...metrics, metricsFinal: true } }));
    expect(client.fail).not.toHaveBeenCalled(); await supervisor.stop();
  });

  it("never resurrects an already-expired pre-ACK lease when a late response arrives", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const acknowledgement = deferred<void>(), onEvent = vi.fn();
    const job = assignedJob({ leaseExpiresAt: new Date(originTime + 1_000).toISOString() }), client = clientFor(job);
    let lateAckFailure: unknown;
    const startWorker = vi.fn(async ({ beforeActivate, afterActivate }: WorkerOptions) => {
      await beforeActivate(); await acknowledgement.promise;
      try { afterActivate?.({ metrics }); } catch (error) { lateAckFailure = error; throw error; }
      return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(1_001);
    acknowledgement.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(lateAckFailure).toMatchObject({ code: "DISCOVERY_LEASE_EXPIRED" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", code: "DISCOVERY_LEASE_EXPIRED" }));
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "activated" }));
    expect(client.fail).not.toHaveBeenCalled(); await supervisor.stop();
  });

  it("drains the in-flight heartbeat before activation and sends none during post-commit cleanup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const heartbeat = deferred<unknown>(), activateRequested = deferred<void>(), cleanup = deferred<void>();
    const client = clientFor(assignedJob(), vi.fn(() => heartbeat.promise));
    const activated = vi.fn(), onEvent = vi.fn();
    const startWorker = vi.fn(async ({ beforeActivate }: WorkerOptions) => {
      await activateRequested.promise;
      await beforeActivate();
      activated();
      await cleanup.promise;
      return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(15_000);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    activateRequested.resolve(); await vi.advanceTimersByTimeAsync(30_000);
    expect(activated).not.toHaveBeenCalled();
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    heartbeat.resolve({ job: { leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() } });
    await vi.advanceTimersByTimeAsync(0);
    expect(activated).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    cleanup.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "activated", jobId: "activation-job", metrics }));
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ code: "DISCOVERY_LEASE_REJECTED" }));
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("preserves a pre-activation heartbeat 409 and never reaches final activation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const heartbeat = deferred<unknown>(), activateRequested = deferred<void>();
    const client = clientFor(assignedJob(), vi.fn(() => heartbeat.promise));
    const activated = vi.fn(), onEvent = vi.fn();
    const startWorker = vi.fn(async ({ beforeActivate }: WorkerOptions) => {
      await activateRequested.promise;
      try { await beforeActivate(); activated(); return { outcome: "activated", metrics }; }
      catch (error) { throw Object.assign(error as Error, { discoveryMetrics: metrics }); }
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(15_000);
    activateRequested.resolve(); await vi.advanceTimersByTimeAsync(0);
    heartbeat.reject(Object.assign(new Error("conflict"), { status: 409 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(activated).not.toHaveBeenCalled();
    expect(startWorker.mock.calls[0][0].signal.reason.code).toBe("DISCOVERY_LEASE_REJECTED");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", code: "DISCOVERY_LEASE_REJECTED", metrics }));
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("keeps the acknowledged lease expiry while an in-flight heartbeat never finishes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const heartbeat = deferred<unknown>(), activateRequested = deferred<void>(), activated = vi.fn();
    const client = clientFor(assignedJob({ leaseExpiresAt: new Date(originTime + 31_000).toISOString() }), vi.fn(() => heartbeat.promise));
    const startWorker = vi.fn(async ({ beforeActivate }: WorkerOptions) => {
      await activateRequested.promise; await beforeActivate(); activated(); return { outcome: "activated", metrics };
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(15_000);
    activateRequested.resolve(); await vi.advanceTimersByTimeAsync(16_001);
    expect(startWorker.mock.calls[0][0].signal.reason.code).toBe("DISCOVERY_LEASE_EXPIRED");
    expect(activated).not.toHaveBeenCalled();
    expect(client.fail).not.toHaveBeenCalled();
    heartbeat.resolve({}); await supervisor.stop();
  });

  it("keeps the original work deadline after quiescing heartbeats", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const firstPickedUpAt = new Date(originTime - 710_000).toISOString();
    const job = assignedJob({ firstPickedUpAt, deadlineAt: new Date(originTime + 190_000).toISOString() });
    const client = clientFor(job), onEvent = vi.fn();
    const startWorker = vi.fn(async ({ beforeActivate, signal }: WorkerOptions) => {
      await beforeActivate(); return cancelled(signal);
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(10_001);
    expect(startWorker.mock.calls[0][0].signal.reason.code).toBe("DISCOVERY_DEADLINE");
    expect(client.heartbeat).not.toHaveBeenCalled();
    expect(client.fail).toHaveBeenCalledWith(job.id, job.leaseToken, "DEADLINE", false);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", firstPickedUpAt,
      deadlineAt: job.deadlineAt, code: "DISCOVERY_DEADLINE" }));
    await supervisor.stop();
  });

  it("keeps lease expiry live after the heartbeat drain has completed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const job = assignedJob({ leaseExpiresAt: new Date(originTime + 20_000).toISOString() });
    const client = clientFor(job);
    const startWorker = vi.fn(async ({ beforeActivate, signal }: WorkerOptions) => {
      await beforeActivate(); return cancelled(signal);
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(20_001);
    expect(startWorker.mock.calls[0][0].signal.reason.code).toBe("DISCOVERY_LEASE_EXPIRED");
    expect(client.heartbeat).not.toHaveBeenCalled();
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("retains final worker metrics when lease cancellation wins before cooperative cleanup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const cleanup = deferred<void>(), client = clientFor(assignedJob(), vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); }));
    const onEvent = vi.fn();
    const startWorker = vi.fn(async ({ signal }: WorkerOptions) => {
      try { await cancelled(signal); }
      catch (error) { await cleanup.promise; throw Object.assign(error as Error, { discoveryMetrics: metrics }); }
    });
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(15_000);
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "attempt_ended" }));
    await vi.advanceTimersByTimeAsync(1_000); cleanup.resolve(); await vi.advanceTimersByTimeAsync(0);
    const ended = onEvent.mock.calls.map(([event]) => event).filter(event => event.event === "attempt_ended");
    expect(ended).toEqual([expect.objectContaining({ code: "DISCOVERY_LEASE_REJECTED", metrics,
      completedAt: new Date(originTime + 15_000).toISOString(), deadlineAt: new Date(originTime + 900_000).toISOString() })]);
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "activated" }));
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("retains the five-second cleanup bound without inventing metrics or activation for a wedged worker", async () => {
    vi.useFakeTimers(); vi.setSystemTime(originTime);
    const work = deferred<unknown>(), onEvent = vi.fn();
    const client = clientFor(assignedJob(), vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); }));
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker: () => work.promise, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(19_999);
    expect(supervisor.activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.activeCount).toBe(0);
    const ended = onEvent.mock.calls.map(([event]) => event).find(event => event.event === "attempt_ended");
    expect(ended.code).toBe("DISCOVERY_LEASE_REJECTED"); expect(ended).not.toHaveProperty("metrics");
    work.resolve({ outcome: "activated", metrics }); await vi.advanceTimersByTimeAsync(0);
    expect(onEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ event: "activated" }));
    await supervisor.stop();
  });
});
