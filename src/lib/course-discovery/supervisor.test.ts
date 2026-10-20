// @vitest-environment node
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryClient } from "../../../scripts/automation/course-discovery-client.mjs";
import { createCourseDiscoverySupervisor, discoveryWorkDeadline, validateClaimedDiscoveryJob, validateClaimedRecipeExecution } from "../../../scripts/automation/course-discovery-supervisor.mjs";
import { cleanupDiscoveryDirectory, createDiscoveryBrowser, createDiscoveryProcess, createDiscoverySnapshotCompactor, discoveryProcessEnvironment, prepareDiscoveryModelCatalog, readDiscoveryControllerCheckpoint, restrictedModelCatalog, runCourseDiscoveryWorker, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";

afterEach(() => { vi.useRealTimers(); });
const now = new Date("2026-10-20T14:00:00Z").getTime();
const job = (id = "job-1") => ({ id, leaseToken: "private-lease-value", attempts: 1,
  firstPickedUpAt: new Date(now).toISOString(),
  deadlineAt: new Date(now + 15 * 60_000).toISOString(),
  request: { target: { courseId: "c1", kind: "OUTDOOR" }, identity: { name: "Public golf" }, input: { date: "2026-10-22" } },
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const untilCancelled = ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

describe("course discovery client authority", () => {
  it("signs the exact method, route, timestamp and body without disclosing the device token", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"job":null}'));
    const client = createCourseDiscoveryClient({ baseUrl: "https://example.com", deviceToken: " secret-device-token ", now: () => now, fetchImpl });
    await client.next("worker-1");
    const [, options] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    const timestamp = String(now);
    const expected = createHmac("sha256", "secret-device-token").update(`POST\n/api/course-discovery/jobs/next\n${timestamp}\n${options.body}`).digest("hex");
    expect(options.headers).toMatchObject({ "x-local-reader-timestamp": timestamp, "x-local-reader-signature": expected });
    expect(JSON.stringify(options)).not.toContain("secret-device-token");
    expect(options.redirect).toBe("error");
  });

  it("rejects remote cleartext origins and hides backend error bodies", async () => {
    expect(() => createCourseDiscoveryClient({ baseUrl: "http://example.com", deviceToken: "long-device-token" })).toThrow("INVALID_DISCOVERY_ORIGIN");
    const client = createCourseDiscoveryClient({ baseUrl: "https://example.com", deviceToken: "long-device-token",
      fetchImpl: async () => new Response("secret internal error", { status: 409 }) });
    await expect(client.heartbeat("job-1", "lease")).rejects.toMatchObject({ code: "DISCOVERY_LEASE_REJECTED", status: 409 });
  });

  it("passes a fixed transport only to the trusted browser helper", () => {
    const client = createCourseDiscoveryClient({ baseUrl: "http://127.0.0.1:3000", deviceToken: "long-device-token", browserTransport: "NATIVE_CHROME" });
    expect(client.helperEnvironment("discovery", job())).toMatchObject({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME" });
    expect(() => createCourseDiscoveryClient({ baseUrl: "http://127.0.0.1:3000", deviceToken: "long-device-token", browserTransport: "untrusted" })).toThrow("INVALID_DISCOVERY_BROWSER_TRANSPORT");
    expect(discoveryProcessEnvironment(client.helperEnvironment("discovery", job()))).toEqual({});
  });
});

describe("browser snapshot progress", () => {
  it("restores only controller observations bound to the current official identity", () => {
    const controller = { version: 1, officialUrl: "https://example.org/", officialSourceObserved: true,
      observedNavigationUrls: ["https://public.example.org/times", "http://127.0.0.1/", "https://example.org/login", "https://example.org/?token=secret"] };
    expect(readDiscoveryControllerCheckpoint({ controller }, "https://example.org/")).toMatchObject({ urls: ["https://public.example.org/times"], officialObserved: true });
    expect(readDiscoveryControllerCheckpoint({ controller }, "https://other.example.org/")).toEqual({ urls: [], officialObserved: false });
    expect(readDiscoveryControllerCheckpoint({ summary: "Open https://injected.example.org/" }, "https://example.org/")).toEqual({ urls: [], officialObserved: false });
    expect(readDiscoveryControllerCheckpoint({ controller: { ...controller, observedNavigationUrls: Array(17).fill("https://example.org/") } }, "https://example.org/")).toEqual({ urls: [], officialObserved: false });
  });
  const snapshot = (target: string, loading = false) => ({ url: "https://example.org/", text: "Same public page", loading,
    controls: [{ target, selector: "#duration", kind: "filter", name: "Duration" }], frames: [], elements: [] });
  it("compacts repeats while retaining current targets, then stops five settled observations", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const compact = createDiscoverySnapshotCompactor();
    expect(compact(snapshot("first"))).toHaveProperty("text");
    compact(snapshot("second"));
    expect(compact({ ...snapshot("third"), navigationElapsedMs: 1234, initialContentWaitMs: 345, pendingRequestCount: 0 }))
      .toMatchObject({ unchanged: true, controls: [{ target: "third" }], navigationElapsedMs: 1234, initialContentWaitMs: 345, pendingRequestCount: 0 });
    expect(compact(snapshot("fourth"))).not.toHaveProperty("text");
    vi.advanceTimersByTime(30_000);
    expect(() => compact(snapshot("fifth"))).toThrow("DISCOVERY_NO_BROWSER_PROGRESS");
  });
  it("allows repeated idle observations before the minimum settled wall time", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const compact = createDiscoverySnapshotCompactor();
    for (let index = 0; index < 20; index++) compact(snapshot(String(index)));
    vi.advanceTimersByTime(29_999);
    expect(() => compact(snapshot("still-waiting"))).not.toThrow();
  });
  it("delivers late response schema evidence and restarts the idle clock without changing the DOM", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const compact = createDiscoverySnapshotCompactor();
    for (let index = 0; index < 4; index++) compact(snapshot(String(index)));
    vi.advanceTimersByTime(30_000);
    const response = { url: "https://example.org/calendar", status: 200, method: "GET", body: {}, schemaEvidence: { kind: "SAMPLED_SCHEMA_ONLY", fields: [] } };
    expect(compact({ ...snapshot("new-response"), responses: [response] })).toMatchObject({ responses: [response] });
    expect(compact(snapshot("still-current"))).toHaveProperty("text");
    for (let index = 0; index < 3; index++) compact(snapshot(String(index)));
    expect(() => compact(snapshot("same-time"))).not.toThrow();
    vi.advanceTimersByTime(30_000);
    expect(() => compact(snapshot("later"))).toThrow("DISCOVERY_NO_BROWSER_PROGRESS");
  });
  it("does not stop a pending load and resets when content changes", () => {
    const compact = createDiscoverySnapshotCompactor();
    for (let i = 0; i < 10; i++) expect(compact(snapshot(String(i), true))).toHaveProperty("text");
    for (let i = 0; i < 4; i++) compact(snapshot(String(i)));
    expect(compact({ ...snapshot("changed"), text: "New results" })).toHaveProperty("text", "New results");
  });
});

describe("bounded discovery supervisor", () => {
  it.each([2071, 2100, 2067, -2100])("accepts a valid server budget with %ims clock offset", offset => {
    const pickup = now + offset;
    const assigned = { ...job(), firstPickedUpAt: new Date(pickup).toISOString(), deadlineAt: new Date(pickup + 900_000).toISOString() };
    expect(validateClaimedDiscoveryJob(assigned, now)).toBe(assigned);
    expect(validateClaimedDiscoveryJob({ ...assigned, attempts: 2 }, now + 90_000).deadlineAt).toBe(assigned.deadlineAt);
    expect(discoveryWorkDeadline(assigned)).toBe(pickup + 720_000);
  });

  it("rejects malformed, extended or expired discovery budgets without granting a new deadline", () => {
    for (const assigned of [
      { ...job(), firstPickedUpAt: undefined }, { ...job(), firstPickedUpAt: "invalid" },
      { ...job(), deadlineAt: "invalid" }, { ...job(), deadlineAt: new Date(now + 900_001).toISOString() },
      { ...job(), firstPickedUpAt: new Date(now + 5001).toISOString(), deadlineAt: new Date(now + 905_001).toISOString() },
      { ...job(), firstPickedUpAt: new Date(now - 1000).toISOString(), deadlineAt: new Date(now).toISOString() },
      { ...job(), firstPickedUpAt: new Date(now + 1000).toISOString(), deadlineAt: new Date(now + 1000).toISOString() },
    ]) expect(() => validateClaimedDiscoveryJob(assigned, now)).toThrow("DISCOVERY_JOB_INVALID");
  });

  it("allows bounded clock offset for warm execution while rejecting expired or overlong work", () => {
    const warm = { id: "warm", leaseToken: "lease", recipe: {}, input: {}, deadlineAt: new Date(now + 182_100).toISOString() };
    expect(validateClaimedRecipeExecution(warm, now)).toBe(warm);
    expect(warm.deadlineAt).toBe(new Date(now + 182_100).toISOString());
    for (const deadline of [now, now - 1, now + 185_001]) {
      expect(() => validateClaimedRecipeExecution({ ...warm, deadlineAt: new Date(deadline).toISOString() }, now)).toThrow("DISCOVERY_EXECUTION_INVALID");
    }
    expect(() => validateClaimedRecipeExecution({ ...warm, deadlineAt: "invalid" }, now)).toThrow("DISCOVERY_EXECUTION_INVALID");
  });

  it("does not claim cold work until a required model snapshot is available", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let catalog = { models: [{ slug: "other-model" }] };
    const read = vi.fn(() => JSON.stringify(catalog));
    const prepareWorker = vi.fn(() => prepareDiscoveryModelCatalog({ read }));
    const client = { next: vi.fn(async () => ({ job: null })), nextExecution: vi.fn(async () => ({ job: null })), fail: vi.fn() };
    const startWorker = vi.fn();
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, prepareWorker, executeRecipe: vi.fn() });
    await supervisor.start();
    expect(client.next).not.toHaveBeenCalled(); expect(startWorker).not.toHaveBeenCalled(); expect(client.fail).not.toHaveBeenCalled();
    catalog = { models: [{ slug: "gpt-6-astra" }] };
    await supervisor.tick(); await supervisor.tick();
    expect(client.next).toHaveBeenCalledTimes(2);
    expect(prepareWorker).toHaveBeenCalledTimes(2); // One failed read, one successful immutable snapshot.
    await supervisor.stop();
  });

  it("runs warm recipes even when cold model preparation fails, without burning a cold attempt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const warm = { id: "warm", leaseToken: "lease", recipe: {}, input: {}, deadlineAt: new Date(now + 182_100).toISOString() };
    const client = { nextExecution: vi.fn().mockResolvedValueOnce({ job: warm }).mockResolvedValue({ job: null }),
      next: vi.fn(), executionResult: vi.fn(async () => ({})), fail: vi.fn() };
    const executeRecipe = vi.fn(async () => ({ status: "EMPTY", complete: true }));
    const prepareWorker = vi.fn(() => { throw new Error("DISCOVERY_MODEL_UNAVAILABLE"); });
    const supervisor = createCourseDiscoverySupervisor({ client, prepareWorker, startWorker: vi.fn(), executeRecipe });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(1);
    expect(executeRecipe).toHaveBeenCalledOnce(); expect(client.executionResult).toHaveBeenCalledOnce();
    expect(client.next).not.toHaveBeenCalled(); expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("reserves the last three minutes without changing the durable job deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const earlier = { ...job(), firstPickedUpAt: new Date(now - 11 * 60_000 - 59_000).toISOString(), deadlineAt: new Date(now + 181_000).toISOString() };
    const expiredWork = { ...earlier, id: "expired-work", firstPickedUpAt: new Date(now - 12 * 60_000 - 1000).toISOString(), deadlineAt: new Date(now + 179_000).toISOString() };
    expect(discoveryWorkDeadline(earlier)).toBe(now + 1000);
    const pending = [earlier, expiredWork];
    const client = { next: vi.fn(async () => ({ job: pending.shift() ?? null })), heartbeat: vi.fn(async () => ({})), fail: vi.fn(async () => ({})) };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(1001);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startWorker.mock.calls[0][0]).toMatchObject({ job: { deadlineAt: earlier.deadlineAt }, workDeadlineAt: new Date(now + 1000).toISOString() });
    expect(client.fail).toHaveBeenCalledWith("expired-work", earlier.leaseToken, "DEADLINE", false);
    await supervisor.stop();
  });
  it("claims at most three jobs and heartbeats while every model remains pending", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let count = 0;
    const client = { next: vi.fn(async () => ({ job: job(`job-${++count}`) })), heartbeat: vi.fn(async () => ({})), fail: vi.fn(async () => ({})) };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start();
    expect(startWorker).toHaveBeenCalledTimes(3);
    expect(supervisor.activeCount).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.next).toHaveBeenCalledTimes(3);
    expect(client.heartbeat).toHaveBeenCalledTimes(6);
    await supervisor.stop();
    expect(client.fail).not.toHaveBeenCalled();
    expect(supervisor.activeCount).toBe(0);
  });

  it("aborts at the original absolute deadline and never grants a fresh fifteen minutes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const original = { ...job(), firstPickedUpAt: new Date(now).toISOString(), deadlineAt: new Date(now + 20_000).toISOString(), attempts: 2 };
    const client = { next: vi.fn().mockResolvedValueOnce({ job: original }).mockResolvedValue({ job: null }), heartbeat: vi.fn(async () => ({})), fail: vi.fn(async () => ({})) };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(startWorker.mock.calls[0][0].signal.aborted).toBe(true);
    expect(client.fail).toHaveBeenCalledWith(original.id, original.leaseToken, "DEADLINE", false);
    await supervisor.stop();
    expect(() => validateClaimedDiscoveryJob({ ...job(), attempts: 3 }, now)).toThrow("DISCOVERY_JOB_INVALID");
  });

  it("drops a rejected lease without rebinding or marking a different owner's job failed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const client = { next: vi.fn().mockResolvedValueOnce({ job: job() }).mockResolvedValue({ job: null }),
      heartbeat: vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); }), fail: vi.fn() };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(startWorker.mock.calls[0][0].signal.aborted).toBe(true);
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("keeps a valid lease during a transient heartbeat failure then renews normally", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const assigned = { ...job(), leaseExpiresAt: new Date(now + 90_000).toISOString() };
    const heartbeat = vi.fn().mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))
      .mockImplementation(async () => ({ job: { leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() } }));
    const client = { next: vi.fn().mockResolvedValueOnce({ job: assigned }).mockResolvedValue({ job: null }), heartbeat, fail: vi.fn(async () => ({})) };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(startWorker.mock.calls[0][0].signal.aborted).toBe(false);
    await supervisor.stop();
  });

  it("stops at the last acknowledged lease expiry when all heartbeats fail", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const client = { next: vi.fn().mockResolvedValueOnce({ job: { ...job(), leaseExpiresAt: new Date(now + 31_000).toISOString() } }).mockResolvedValue({ job: null }),
      heartbeat: vi.fn(async () => { throw new Error("network"); }), fail: vi.fn() };
    const startWorker = vi.fn(untilCancelled);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(31_001);
    expect(startWorker.mock.calls[0][0].signal.reason.code).toBe("DISCOVERY_LEASE_EXPIRED");
    expect(client.fail).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("prioritizes warm recipes and never launches a model for them", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const warm = { id: "warm-1", leaseToken: "lease", recipe: {}, input: {}, deadlineAt: new Date(now + 60_000).toISOString() };
    const work = deferred();
    const client = { nextExecution: vi.fn().mockResolvedValueOnce({ job: warm }).mockResolvedValue({ job: null }),
      executionResult: vi.fn(async () => ({})), next: vi.fn(async () => ({ job: null })), heartbeat: vi.fn(), fail: vi.fn() };
    const startWorker = vi.fn();
    const executeRecipe = vi.fn(() => work.promise);
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker, executeRecipe });
    await supervisor.start();
    expect(executeRecipe).toHaveBeenCalledOnce(); expect(startWorker).not.toHaveBeenCalled();
    work.resolve({ status: "EMPTY", complete: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.executionResult).toHaveBeenCalledWith("warm-1", "lease", { status: "EMPTY", complete: true }, expect.any(AbortSignal));
    await supervisor.stop();
  });

  it("correlates failed model usage with the owned job and original deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const firstPickedUpAt = new Date(now - 10_000).toISOString();
    const assigned = { ...job(), firstPickedUpAt, deadlineAt: new Date(Date.parse(firstPickedUpAt) + 900_000).toISOString() };
    const onEvent = vi.fn();
    const metrics = { model: "gpt-6-astra", tokenUsage: { totalTokens: 400 } };
    const error = Object.assign(new Error("failed"), { code: "DISCOVERY_NO_VERIFIED_RECIPE", discoveryMetrics: metrics });
    const client = { next: vi.fn().mockResolvedValueOnce({ job: assigned }).mockResolvedValue({ job: null }), heartbeat: vi.fn(), fail: vi.fn(async () => ({})) };
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker: async () => { throw error; }, onEvent });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", jobId: assigned.id,
      kind: "discovery", firstPickedUpAt, deadlineAt: assigned.deadlineAt, completedAt: new Date(now).toISOString(), metrics }));
    await supervisor.stop();
  });

  it("keeps two-attempt transport compatibility while distinguishing exhausted unverified work in diagnostics", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const evidence = { code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "inspect_adapter", requests: [],
      failure: { code: "ADAPTER_IDENTITY_MISMATCH", url: "https://venue.example/calendar?private=value" } } };
    const error = Object.assign(new Error("untrusted raw provider message"), { code: "DISCOVERY_NO_VERIFIED_RECIPE",
      discoveryDiagnostic: { code: "NO_VERIFIED_RECIPE", reason: "UNTRUSTED_REASON", evidence } });
    const assigned = { ...job(), attempts: 2 };
    const client = { next: vi.fn().mockResolvedValueOnce({ job: assigned }).mockResolvedValue({ job: null }), heartbeat: vi.fn(), fail: vi.fn(async () => ({})) };
    const onEvent = vi.fn();
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker: async () => { throw error; }, onEvent });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(1);
    expect(client.fail).toHaveBeenCalledExactlyOnceWith(assigned.id, assigned.leaseToken, "TOOL_FAILURE", true);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "attempt_ended", code: "DISCOVERY_NO_VERIFIED_RECIPE",
      diagnosticCode: "NO_VERIFIED_RECIPE", diagnosticReason: "ADAPTER_IDENTITY_MISMATCH", deadlineAt: assigned.deadlineAt }));
    expect(JSON.stringify(onEvent.mock.calls)).not.toMatch(/private|untrusted|UNTRUSTED_REASON/);
    expect(client.next).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it.each(["ACCESS_REQUIRED", "UNSUPPORTED"])("persists a classified %s failure without another attempt", async outcome => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const client = { next: vi.fn().mockResolvedValueOnce({ job: job() }).mockResolvedValue({ job: null }), heartbeat: vi.fn(), fail: vi.fn(async () => ({})) };
    const supervisor = createCourseDiscoverySupervisor({ client, startWorker: async () => { throw Object.assign(new Error(outcome), { code: `DISCOVERY_${outcome}` }); } });
    await supervisor.start(); await vi.advanceTimersByTimeAsync(1);
    expect(client.fail).toHaveBeenCalledWith("job-1", "private-lease-value", outcome, false);
    await supervisor.stop();
  });
});

describe("controller-only verification", () => {
  it("retries temporary Windows file locks after removing copied credentials", async () => {
    const path = join(tmpdir(), "tee-discovery-worker-fixture");
    const remove = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); }).mockImplementation(() => {});
    const pause = vi.fn(async () => {});
    await expect(cleanupDiscoveryDirectory(path, { remove, pause })).resolves.toEqual({ complete: true, credentialsRemoved: true });
    expect(remove.mock.calls[0][0]).toBe(join(path, "auth.json"));
    expect(pause).toHaveBeenCalledOnce();
    const unsafeRemove = vi.fn();
    await expect(cleanupDiscoveryDirectory(resolve("."), { remove: unsafeRemove, pause })).resolves.toEqual({ complete: false, credentialsRemoved: false });
    expect(unsafeRemove).not.toHaveBeenCalled();
  });
  it("passes the trusted course timezone to the isolated browser process", async () => {
    const configurations: Array<{ args: string[] }> = [];
    const processFactory = vi.fn((options: { args: string[] }) => { configurations.push(options); return { request: vi.fn(async () => ({})), close: vi.fn(async () => {}) }; });
    const browser = createDiscoveryBrowser({ cwd: process.cwd(), deadlineAt: new Date(now + 60000).toISOString(),
      initialUrls: ["https://example.org/"], timeZone: "America/Los_Angeles", venueOfficialUrl: "https://example.org/", processFactory });
    expect(configurations[0].args.slice(-2)).toEqual(["--time-zone", "America/Los_Angeles"]);
    expect(configurations[0].args).toEqual(expect.arrayContaining(["--venue-official-url", "https://example.org/"]));
    await browser.close();
  });

  it("uses exactly the two server inputs and activates only after stored proofs", async () => {
    const recipe = { schemaVersion: 1 };
    const hash = "a".repeat(64);
    const challenges = [{ id: "a", recipeHash: hash, input: { date: "2026-10-22" } }, { id: "b", recipeHash: hash, input: { date: "2026-10-23" } }];
    const calls: string[] = [];
    const client = { candidate: vi.fn(async () => ({ recipeHash: hash, challenges })),
      verification: vi.fn(async (_id: string, challenge: string) => { calls.push(challenge); }), activate: vi.fn(async () => { calls.push("activate"); return {}; }) };
    const executeRecipe = vi.fn(async ({ input }) => ({ status: "EMPTY", complete: true, input }));
    await verifyDiscoveryCandidate({ client, job: job(), recipe, executeRecipe });
    expect(executeRecipe.mock.calls.map(([args]) => args.input)).toEqual(challenges.map(item => item.input));
    expect(calls).toEqual(["a", "b", "activate"]);
  });

  it("does not activate after rejected proof or duplicate challenges", async () => {
    const hash = "a".repeat(64);
    const challenge = { id: "a", recipeHash: hash, input: {} };
    const client = { candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [challenge, challenge] })), verification: vi.fn(), activate: vi.fn() };
    const executeRecipe = vi.fn();
    await expect(verifyDiscoveryCandidate({ client, job: job(), recipe: {}, executeRecipe })).rejects.toThrow("DISCOVERY_CHALLENGES_INVALID");
    expect(executeRecipe).not.toHaveBeenCalled(); expect(client.activate).not.toHaveBeenCalled();
  });

  it("cannot activate when a fixed replay or server verification fails", async () => {
    const hash = "b".repeat(64);
    const client = { candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [{ id: "a", recipeHash: hash, input: {} }, { id: "b", recipeHash: hash, input: {} }] })),
      verification: vi.fn(async () => { throw new Error("not verified"); }), activate: vi.fn() };
    await expect(verifyDiscoveryCandidate({ client, job: job(), recipe: {}, executeRecipe: async () => ({ status: "EMPTY", complete: true }) })).rejects.toThrow("not verified");
    expect(client.activate).not.toHaveBeenCalled();
    expect(client.verification).toHaveBeenCalledOnce();
  });

  it("returns safe incomplete replay feedback before posting any invalid proof", async () => {
    const hash = "b".repeat(64);
    const client = { candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [{ id: "a", recipeHash: hash, input: {} }, { id: "b", recipeHash: hash, input: {} }] })),
      verification: vi.fn(), activate: vi.fn() };
    const result = { status: "INCOMPLETE", complete: false, sourceUrl: "https://private.example/path", slots: [],
      evidence: { reason: "INCOMPLETE_COLLECTION", venueVerified: true, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false, private: "must-not-leak" } };
    const error = await verifyDiscoveryCandidate({ client, job: job(), recipe: {}, executeRecipe: async () => result }).catch(value => value);
    expect(error).toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE", details: { status: "INCOMPLETE", reason: "INCOMPLETE_COLLECTION", slotCount: 0,
      proof: { venueVerified: true, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false } } });
    expect(JSON.stringify(error)).not.toContain("private.example");
    expect(JSON.stringify(error)).not.toContain("must-not-leak");
    expect(client.verification).not.toHaveBeenCalled(); expect(client.activate).not.toHaveBeenCalled();
  });

  it("reuses only immutable completed challenges returned by the server", async () => {
    const hash = "b".repeat(64);
    const client = { candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [
      { id: "a", recipeHash: hash, input: { date: "2026-10-21" }, completed: true },
      { id: "b", recipeHash: hash, input: { date: "2026-10-22" }, completed: false },
    ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({})) };
    const executeRecipe = vi.fn(async () => ({ status: "EMPTY", complete: true }));
    await verifyDiscoveryCandidate({ client, job: job(), recipe: {}, executeRecipe });
    expect(executeRecipe).toHaveBeenCalledOnce();
    expect(client.verification).toHaveBeenCalledWith("job-1", "b", "private-lease-value", expect.any(Object), undefined);
    expect(client.activate).toHaveBeenCalledOnce();
  });

  it("removes model execution capabilities and product secrets", () => {
    const restricted = restrictedModelCatalog({ models: [{ slug: "gpt-6-astra", apply_patch_tool_type: "freeform", shell_type: "unified_exec", experimental_supported_tools: ["clock"] }] });
    expect(restricted.models[0]).toMatchObject({ apply_patch_tool_type: null, shell_type: "disabled", experimental_supported_tools: [], supports_search_tool: false });
    expect(discoveryProcessEnvironment({ PATH: "bin", LOCAL_READER_DEVICE_TOKEN: "private", DATABASE_URL: "private", RESEND_API_KEY: "private", AUTOMATION_API_KEY: "private" })).toEqual({ PATH: "bin" });
  });

  it("pins one restricted catalog before three workers even if the shared cache is replaced", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-catalog-test-"));
    const cache = join(sourceHome, "models_cache.json");
    writeFileSync(cache, JSON.stringify({ models: [{ slug: "gpt-6-astra", shell_type: "unified_exec", experimental_supported_tools: ["shell"] }, { slug: "other-model" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "offline-auth-fixture");
    const read = vi.fn((path: string, encoding: BufferEncoding) => readFileSync(path, encoding));
    let modelCatalogJson: string;
    const catalogs: unknown[] = [];
    const processFactory = vi.fn(options => {
      catalogs.push(JSON.parse(readFileSync(join(options.environment.CODEX_HOME, "model-catalog.json"), "utf8")));
      throw Object.assign(new Error("offline stop"), { code: "OFFLINE_STOP" });
    });
    const claims = [job("catalog-1"), job("catalog-2"), job("catalog-3")];
    const client = { next: vi.fn(async () => ({ job: claims.shift() ?? null })), fail: vi.fn(async () => ({})), helperEnvironment: () => ({}) };
    const prepareWorker = vi.fn(() => {
      modelCatalogJson = prepareDiscoveryModelCatalog({ sourceHome, read });
      writeFileSync(cache, JSON.stringify({ models: [] }));
    });
    const startWorker = vi.fn(options => runCourseDiscoveryWorker({ ...options, client, cwd: process.cwd(), sourceHome,
      modelCatalogJson, recipeSchema: {}, resolveCli: () => "offline-codex", processFactory }));
    const supervisor = createCourseDiscoverySupervisor({ client, prepareWorker, startWorker, now: () => now });
    try {
      await supervisor.start(); await supervisor.stop();
      expect(prepareWorker).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(startWorker).toHaveBeenCalledTimes(3);
      expect(processFactory).toHaveBeenCalledTimes(3);
      expect(catalogs).toEqual(Array(3).fill({ models: [expect.objectContaining({ slug: "gpt-6-astra", shell_type: "disabled", experimental_supported_tools: [] })] }));
      expect(JSON.parse(modelCatalogJson!)).toEqual(catalogs[0]);
    } finally { await supervisor.stop(); rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it.each(["not json", "null", '{"models":{}}', '{"models":[]}'])
    ("fails safely on an unusable model catalog %s", value => {
      expect(() => prepareDiscoveryModelCatalog({ read: () => value })).toThrow(/DISCOVERY_MODEL_(?:CATALOG_UNAVAILABLE|UNAVAILABLE)/u);
    });

  it("shares one in-flight preparation across concurrent ticks before any cold claim", async () => {
    const ready = deferred(), prepareWorker = vi.fn(() => ready.promise);
    const client = { next: vi.fn(async () => ({ job: null })) };
    const supervisor = createCourseDiscoverySupervisor({ client, prepareWorker, startWorker: vi.fn() });
    const started = supervisor.start();
    await supervisor.tick(); await supervisor.tick();
    expect(prepareWorker).toHaveBeenCalledOnce(); expect(client.next).not.toHaveBeenCalled();
    ready.resolve(undefined); await started;
    expect(client.next).toHaveBeenCalledOnce();
    await supervisor.tick(); expect(prepareWorker).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("rejects unrelated native requests and routes bounded NDJSON responses", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: 0, signalCode: null });
    const onMessage = vi.fn();
    const connection = createDiscoveryProcess({ executable: "fixed", args: [], cwd: ".", environment: {}, spawnProcess: () => child, onMessage });
    const result = connection.request({ action: "observe" });
    child.stdout.write('{"id":1,"ok":true,"result":{"text":"public"}}\n');
    await expect(result).resolves.toEqual({ text: "public" });
    child.stdout.write('{"id":2,"method":"unexpected"}\n');
    expect(onMessage).toHaveBeenCalled();
    await connection.close();
  });

  it("preserves bounded helper error codes while hiding arbitrary error text", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: 0, signalCode: null });
    const connection = createDiscoveryProcess({ executable: "fixed", args: [], cwd: ".", environment: {}, spawnProcess: () => child });
    const expected = expect(connection.request({ action: "observe" })).rejects.toMatchObject({ code: "STALE_OR_UNKNOWN_CONTROL" });
    child.stdout.write('{"id":1,"ok":false,"error":"STALE_OR_UNKNOWN_CONTROL"}\n');
    await expected;
    const privateError = expect(connection.request({ action: "observe" })).rejects.toMatchObject({ code: "DISCOVERY_PROCESS_REQUEST_FAILED" });
    child.stdout.write('{"id":2,"ok":false,"error":"private runtime body"}\n');
    await privateError;
    await connection.close();
  });

  it("reports the vetted browser startup failure without raw stderr", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: 0, signalCode: null });
    const connection = createDiscoveryProcess({ executable: "fixed", args: [], cwd: ".", environment: {}, spawnProcess: () => child });
    const pending = expect(connection.request({ action: "open" })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    child.stderr.write("BROWSER_UNAVAILABLE\n"); child.emit("close", 1);
    await pending;
    await connection.close();
  });

  it("keeps controller credentials out of model input and rejects model-supplied verification", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-source-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "AUTH_SECRET_SENTINEL");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const replies: unknown[] = [];
    const client = { candidate: vi.fn(), activate: vi.fn(), helperEnvironment: vi.fn(() => ({ LOCAL_READER_DEVICE_TOKEN: "DEVICE_SECRET_SENTINEL" })) };
    let workerOptions: Record<string, unknown> = {};
    const processFactory = (options) => {
      workerOptions = options;
      return {
        notify: vi.fn(), close: vi.fn(async () => {}),
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
          if (method === "turn/start") {
            queueMicrotask(async () => {
              await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
              await options.onMessage({ id: 7, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_propose_recipe",
                arguments: { recipe: {}, verification: { forged: true } } } }, reply => replies.push(reply));
              await options.onMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }, () => {});
            });
            return { turn: { id: "turn-1" } };
          }
          return {};
        },
      };
    };
    try {
      await expect(runCourseDiscoveryWorker({ job: job(), client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory })).rejects.toThrow("DISCOVERY_NO_VERIFIED_RECIPE");
      expect(client.candidate).not.toHaveBeenCalled(); expect(client.activate).not.toHaveBeenCalled();
      expect(JSON.stringify(requests)).not.toContain("private-lease-value");
      expect(JSON.stringify(requests)).not.toContain("AUTH_SECRET_SENTINEL");
      expect(JSON.stringify(workerOptions.environment)).not.toContain("DEVICE_SECRET_SENTINEL");
      expect(JSON.stringify(replies)).toContain("DISCOVERY_PROPOSAL_INVALID");
      expect(requests.find(request => request.method === "thread/start")?.params).toMatchObject({ ephemeral: true, sandbox: "read-only", environments: [], runtimeWorkspaceRoots: [] });
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it("serializes legitimate batched tool calls before independent replay", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-queue-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const order: string[] = [];
    const replies: unknown[] = [];
    const hash = "b".repeat(64);
    const inputJob = { ...job(), request: { ...job().request,
      identity: { name: "Public golf", officialUrl: "https://example.org/", bookingUrl: "https://example.org/" },
      input: { date: "2026-10-22", timeZone: "America/New_York" } } };
    const modelRecipe = { engine: "EXISTING_ADAPTER", target: { courseId: "forged", kind: "SIMULATOR", offeringId: "forged" },
      source: { venueName: "Public golf course", officialUrl: "https://wrong.example.org/", timeZone: "UTC", bookingUrl: "https://example.org/", providerFamily: "FOREUP" },
      adapter: { family: "FOREUP", facilityId: 1, scheduleId: 2, bookingClassId: 3 } };
    const expectedRecipe = { ...modelRecipe, target: inputJob.request.target,
      source: { ...modelRecipe.source, venueName: "Public golf", officialUrl: "https://example.org/", timeZone: "America/New_York" } };
    const validateRecipe = vi.fn(async () => ({ valid: true }));
    const client = {
      helperEnvironment: () => ({}),
      checkpoint: async () => { order.push("checkpoint"); },
      candidate: vi.fn(async () => { order.push("candidate"); return { recipeHash: hash, challenges: [
        { id: "a", recipeHash: hash, input: { date: "2026-10-21" } }, { id: "b", recipeHash: hash, input: { date: "2026-10-22" } },
      ] }; }),
      verification: async () => { order.push("verify"); },
      activate: async () => { order.push("activate"); return {}; },
    };
    const processFactory = (options) => ({ notify: vi.fn(), close: vi.fn(async () => {
      await options.onMessage({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: {
        totalTokens: 200, inputTokens: 180, cachedInputTokens: 100, outputTokens: 20,
      } } } }, () => {});
    }), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          await options.onMessage({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: {
            totalTokens: 100, inputTokens: 90, cachedInputTokens: 50, outputTokens: 10,
          } } } }, () => {});
          const inputs = [
            ["discovery_browser", { action: "observe" }],
            ["discovery_checkpoint", { summary: "Observed public page" }],
            ["discovery_propose_recipe", { recipe: modelRecipe }],
          ];
          await Promise.all(inputs.map(([tool, args], index) => options.onMessage({ id: index + 1, method: "item/tool/call",
            params: { threadId: "thread-1", turnId: "turn-1", tool, arguments: args } }, reply => replies.push(reply))));
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      const result = await runCourseDiscoveryWorker({ job: inputJob, client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory,
        validateRecipe,
        browserFactory: () => ({ request: async () => { order.push("browser-start"); await Promise.resolve(); order.push("browser-end"); return { url: "https://example.org/" }; }, close: async () => {} }),
        executeRecipe: async () => { order.push("replay"); return { status: "EMPTY", complete: true }; },
      });
      expect(result).toMatchObject({ outcome: "activated", metrics: { tokenUsage: { totalTokens: 200, uncachedInputTokens: 80, outputTokens: 20 } } });
      expect(validateRecipe).toHaveBeenCalledWith({ recipe: expectedRecipe, signal: undefined });
      expect(client.candidate).toHaveBeenCalledWith("job-1", "private-lease-value", expectedRecipe, undefined,
        { officialUrl: "https://example.org/", observedBookingUrl: "https://example.org/" });
      expect(modelRecipe.target.courseId).toBe("forged");
      expect(modelRecipe.source.timeZone).toBe("UTC");
      expect(order).toEqual(["browser-start", "browser-end", "checkpoint", "checkpoint", "candidate", "replay", "verify", "replay", "verify", "activate"]);
      expect(replies).toHaveLength(3);
      expect(JSON.stringify(replies)).not.toContain("DISCOVERY_FORBIDDEN_TOOL");
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it.each([
    { observed: true, failNavigation: false, reobserve: false },
    { observed: false, failNavigation: false, reobserve: false },
    { observed: true, failNavigation: true, reobserve: false },
    { observed: true, failNavigation: true, reobserve: true },
  ])("requires current browser access evidence before an access checkpoint: %j", async ({ observed, failNavigation, reobserve }) => {
    const accessAllowed = observed && (!failNavigation || reobserve);
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-access-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const checkpoint = vi.fn(async () => ({}));
    const client = { helperEnvironment: () => ({}), checkpoint, candidate: vi.fn(), activate: vi.fn() };
    const replies: unknown[] = [];
    const processFactory = (options) => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          await options.onMessage({ id: 0, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_browser",
            arguments: { action: "observe" } } }, () => {});
          if (failNavigation) await options.onMessage({ id: 3, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_browser",
            arguments: { action: "open", url: "https://example.org/other" } } }, () => {});
          if (reobserve) await options.onMessage({ id: 4, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_browser",
            arguments: { action: "observe" } } }, () => {});
          await options.onMessage({ id: 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_checkpoint",
            arguments: { summary: "The availability page requires signing in before any schedule is shown.", outcome: "ACCESS_REQUIRED" } } }, reply => replies.push(reply));
          if (!accessAllowed) await options.onMessage({ id: 2, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_checkpoint",
            arguments: { summary: "Public response did not expose a supported availability method.", outcome: "UNSUPPORTED" } } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      await expect(runCourseDiscoveryWorker({ job: job(), client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory,
        browserFactory: () => ({ close: async () => {}, request: async input => {
          if (input.action === "open") throw Object.assign(new Error("BROWSER_NAVIGATION_FAILED"), { code: "BROWSER_NAVIGATION_FAILED" });
          return { url: "https://example.org/", text: observed ? "Verify you are human" : "", controls: [], accessRequirementObserved: observed };
        } }),
      })).rejects.toMatchObject({ code: accessAllowed ? "DISCOVERY_ACCESS_REQUIRED" : "DISCOVERY_UNSUPPORTED" });
      expect(checkpoint).toHaveBeenCalledWith("job-1", "private-lease-value", expect.objectContaining({ outcome: accessAllowed ? "ACCESS_REQUIRED" : "UNSUPPORTED" }), undefined);
      if (!accessAllowed) {
        expect(JSON.stringify(replies)).toContain("DISCOVERY_ACCESS_NOT_CONFIRMED");
        expect(checkpoint.mock.calls.some(call => call[2].outcome === "ACCESS_REQUIRED")).toBe(false);
      }
      expect(client.candidate).not.toHaveBeenCalled(); expect(client.activate).not.toHaveBeenCalled();
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it("releases a failed finish and reopens within the original deadline while retaining metrics", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-reset-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const inputJob = job();
    const checkpoint = vi.fn(async () => ({}));
    const configurations: Array<{ deadlineAt: string }> = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const replies: unknown[] = [];
    const processFactory = options => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          for (const [index, args] of [{ action: "open", url: "https://example.org/" }, { action: "finish" },
            { action: "open", url: "https://example.org/" }].entries()) {
            await options.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1",
              tool: "discovery_browser", arguments: args } }, reply => replies.push(reply));
          }
          await options.onMessage({ id: 4, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1",
            tool: "discovery_checkpoint", arguments: { summary: "Verified reset", outcome: "UNSUPPORTED" } } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      const failure = await runCourseDiscoveryWorker({ job: inputJob, client: { helperEnvironment: () => ({}), checkpoint }, cwd: process.cwd(), sourceHome,
        recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory,
        browserFactory: config => {
          configurations.push(config); const ordinal = configurations.length;
          const close = vi.fn(async () => {}); closes.push(close);
          return { close, request: async action => {
            if (action.action === "finish") throw Object.assign(new Error("Page already closed"), { code: "BROWSER_UNAVAILABLE" });
            return { url: "https://example.org/", controls: [], requestCount: ordinal, responseBytes: ordinal === 1 ? 100 : 150 };
          } };
        },
      }).catch(error => error);
      expect(failure).toMatchObject({ code: "DISCOVERY_UNSUPPORTED", discoveryMetrics: { providerRequestsObserved: 3, responseBytesObserved: 250 } });
      expect(configurations).toHaveLength(2);
      expect(configurations.every(config => config.deadlineAt === inputJob.deadlineAt)).toBe(true);
      expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
      expect(JSON.stringify(replies[1])).toContain("original deadline");
      expect(checkpoint.mock.calls.at(-1)![2]).toMatchObject({ controller: { observedNavigationUrls: ["https://example.org/"] } });
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it("keeps the browser open for local validation correction and carries safe feedback to the next attempt", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-validation-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const checkpoint = vi.fn(async () => ({}));
    const candidate = vi.fn();
    const client = { helperEnvironment: () => ({}), checkpoint, candidate };
    const inputJob = { ...job(), request: { ...job().request, identity: { name: "Public golf", officialUrl: "https://example.org/", bookingUrl: "https://example.org/" } } };
    let browserClosed = false, observedAfterValidation = false;
    const processFactory = (options) => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          for (const [index, [tool, args]] of [
            ["discovery_browser", { action: "open", url: "https://example.org/" }],
            ["discovery_propose_recipe", { recipe: {} }],
            ["discovery_browser", { action: "observe" }],
            ["discovery_checkpoint", { summary: "Needs another attempt", outcome: "UNSUPPORTED" }],
          ].entries()) await options.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool, arguments: args } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      await expect(runCourseDiscoveryWorker({ job: inputJob, client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory,
        validateRecipe: async () => ({ valid: false, issues: [{ path: "proof.complete.selector", code: "custom", message: "Expected a bounded public display selector" }] }),
        browserFactory: () => ({ request: async action => { if (action.action === "observe") observedAfterValidation = !browserClosed; return { url: "https://example.org/", text: "Public golf", controls: [] }; }, close: async () => { browserClosed = true; } }),
      })).rejects.toMatchObject({ code: "DISCOVERY_UNSUPPORTED" });
      expect(candidate).not.toHaveBeenCalled(); expect(observedAfterValidation).toBe(true);
      const stored = checkpoint.mock.calls.at(-1)![2];
      expect(stored).toMatchObject({ summary: "Needs another attempt", controller: { lastFeedback: { code: "DISCOVERY_RECIPE_INVALID", details: { issues: [{ path: "proof.complete.selector" }] } } } });
      expect(readDiscoveryControllerCheckpoint(stored, "https://example.org/").lastFeedback).toEqual(stored.controller.lastFeedback);
      let retryInput: { previousDiagnostic?: unknown } | undefined;
      const retryFactory = options => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string, params: { input: Array<{ text: string }> }) => {
        if (method === "thread/start") return { thread: { id: "retry" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
        if (method === "turn/start") { retryInput = JSON.parse(params.input[0].text); queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "retry", turn: { id: "turn-2" } } }, () => {});
          await options.onMessage({ method: "turn/completed", params: { threadId: "retry", turn: { id: "turn-2", status: "completed" } } }, () => {});
        }); return { turn: { id: "turn-2" } }; }
        return {};
      } });
      await expect(runCourseDiscoveryWorker({ job: { ...inputJob, checkpoint: stored }, client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory: retryFactory })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
      expect(retryInput?.previousDiagnostic).toEqual(stored.controller.lastFeedback);
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it("persists the underlying inspector failure after a successful observation and normal model completion", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-terminal-diagnostic-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const checkpoint = vi.fn(async () => ({}));
    const client = { helperEnvironment: () => ({}), checkpoint };
    const inputJob = { ...job(), request: { ...job().request, identity: { name: "Public golf", officialUrl: "https://example.org/" } } };
    const processFactory = options => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          for (const [index, args] of [
            { action: "open", url: "https://example.org/" },
            { action: "inspect_adapter", url: "https://example.org/" },
            { action: "observe" },
          ].entries()) await options.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1",
            tool: "discovery_browser", arguments: args } }, () => {});
          await options.onMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      const failure = await runCourseDiscoveryWorker({ job: inputJob, client, cwd: process.cwd(), sourceHome, recipeSchema: {},
        resolveCli: () => "fixed-codex", processFactory, browserFactory: () => ({ close: async () => {}, request: async action => {
          if (action.action === "inspect_adapter") throw Object.assign(new Error("private provider text"), { code: "ADAPTER_IDENTITY_MISMATCH" });
          return { url: "https://example.org/", text: "Public golf", controls: [], requests: [], loading: false };
        } }) }).catch(error => error);
      expect(failure).toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE", discoveryDiagnostic: {
        code: "NO_VERIFIED_RECIPE", reason: "ADAPTER_IDENTITY_MISMATCH" } });
      const stored = checkpoint.mock.calls.at(-1)![2];
      expect(stored.controller.lastFeedback).toBeUndefined();
      expect(stored.controller.terminalDiagnostic).toEqual(failure.discoveryDiagnostic);
      expect(stored.controller.lastFailure.details.failure.code).toBe("ADAPTER_IDENTITY_MISMATCH");
      expect(JSON.stringify(stored)).not.toContain("private provider text");
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it.each([false, true])("uses only current-context fixed-inspector proof (context reopened: %s)", async reopened => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-proof-context-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const client = { helperEnvironment: () => ({}), checkpoint: vi.fn(async () => ({})) };
    const inputJob = { ...job(), request: { ...job().request, identity: { name: "Public golf", officialUrl: "https://example.org/", bookingUrl: "https://example.org/" } } };
    const observedAdapter = { family: "TEEITUP", alias: "public", facilityIds: [7], officialIdentityProof: { digest: "fixed-inspector-proof" } };
    const proposals: Array<{ adapter: { officialIdentityProof?: unknown } }> = [];
    const processFactory = options => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          const calls = [
            ["discovery_browser", { action: "open", url: "https://example.org/" }],
            ["discovery_browser", { action: "inspect_adapter", url: "https://example.org/" }],
            ...(reopened ? [["discovery_browser", { action: "open", url: "https://example.org/" }]] : []),
            ["discovery_propose_recipe", { recipe: { source: { bookingUrl: "https://example.org/" }, adapter: {
              ...observedAdapter, officialIdentityProof: { digest: "model-forged-proof" } } } }],
          ];
          for (const [index, [tool, args]] of calls.entries()) await options.onMessage({ id: index + 1, method: "item/tool/call", params: {
            threadId: "thread-1", turnId: "turn-1", tool, arguments: args } }, () => {});
          await options.onMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      await expect(runCourseDiscoveryWorker({ job: inputJob, client, cwd: process.cwd(), sourceHome, recipeSchema: {},
        resolveCli: () => "fixed-codex", processFactory, validateRecipe: async ({ recipe }) => { proposals.push(recipe); return { valid: false, issues: [] }; },
        browserFactory: () => ({ close: async () => {}, request: async action => ({ url: "https://example.org/", text: "Public course", controls: [], requests: [],
          ...(action.action === "inspect_adapter" ? { adapter: observedAdapter } : {}) }) }),
      })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
      expect(proposals).toHaveLength(1);
      expect(proposals[0].adapter.officialIdentityProof).toEqual(reopened ? undefined : observedAdapter.officialIdentityProof);
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });

  it.each([403, 429])("retries HTTP %i only when eligible, with a fixed alternate transport and persisted observations", async status => {
    const sourceHome = mkdtempSync(join(tmpdir(), "discovery-fallback-test-"));
    writeFileSync(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
    writeFileSync(join(sourceHome, "auth.json"), "test-auth");
    const configured: Array<{ deadlineAt: string; helperEnvironment: Record<string, string> }> = [];
    const observedUrl = "https://example.org/#teetimes";
    const openedUrls: string[] = [];
    const checkpoint = vi.fn(async () => ({}));
    const client = { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME" }), checkpoint };
    const inputJob = { ...job(), request: { ...job().request, identity: { name: "Public golf", officialUrl: observedUrl, bookingUrl: observedUrl } } };
    const processFactory = (options) => ({ notify: vi.fn(), close: vi.fn(async () => {}), request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await options.onMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, () => {});
          await options.onMessage({ id: 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_browser", arguments: { action: "open", url: observedUrl } } }, () => {});
          await options.onMessage({ id: 2, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "discovery_checkpoint", arguments: { summary: "Bounded test complete", outcome: "UNSUPPORTED" } } }, () => {});
        });
        return { turn: { id: "turn-1" } };
      }
      return {};
    } });
    try {
      await expect(runCourseDiscoveryWorker({ job: inputJob, client, cwd: process.cwd(), sourceHome, recipeSchema: {}, resolveCli: () => "fixed-codex", processFactory,
        browserFactory: config => { configured.push(config); return { close: async () => {}, request: async input => {
          openedUrls.push(input.url);
          return { url: observedUrl, text: "Public page", controls: [], navigationStatus: status,
            browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT, requestCount: 1, responseBytes: 100 };
        } }; },
      })).rejects.toMatchObject({ code: "DISCOVERY_UNSUPPORTED" });
      expect(configured).toHaveLength(status === 403 ? 2 : 1);
      expect(configured[0].helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT).toBe("NATIVE_CHROME");
      if (status === 403) expect(configured[1].helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT).toBe("PINNED_HTTP");
      expect(openedUrls).toEqual(Array.from({ length: status === 403 ? 2 : 1 }, () => observedUrl));
      expect(configured.every(config => config.deadlineAt === inputJob.deadlineAt)).toBe(true);
      expect(checkpoint).toHaveBeenLastCalledWith("job-1", "private-lease-value", expect.objectContaining({ controller: expect.objectContaining({ observedNavigationUrls: [observedUrl], officialSourceObserved: true,
        browserTransport: status === 403 ? "PINNED_HTTP" : "NATIVE_CHROME", transportFallbackUsed: status === 403 }) }), undefined);
    } finally { rmSync(sourceHome, { recursive: true, force: true }); }
  });
});
