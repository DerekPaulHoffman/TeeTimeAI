// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRexPublicReadPost } from "../automation/rex-public-read-policy";
import { bindDiscoveryRecipeBrowserTransport, runCourseDiscoveryWorker, shouldUseRexPinnedFallback } from "../../../scripts/automation/course-discovery-worker.mjs";

const official = "https://example.org/";
const entry = "https://example.reservewithrex.com/package?venue=Example&date=2026-10-23&guests=2&currentPackage=Golf%20Simulator";
const catalog = "https://example.reservewithrex.com/api/venue/get";
const hash = "a".repeat(64);
const firstPickup = "2026-10-22T14:00:00.000Z";
const workDeadline = "2026-10-22T14:12:00.000Z";
const denied = () => ({ url: catalog, method: "POST", resourceType: "xhr", blockedReason: "REX_READ_HEADER_COOKIE" });
const native = () => ({ url: entry, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
  loading: true, pendingRequestCount: 1, text: "Example", controls: [{ target: "old-native-control", label: "Calendar" }],
  requests: [denied()], requestFailures: [], requestCount: 10, responseBytes: 1000 });
const inputJob = () => ({ id: "job-1", leaseToken: "private-test-lease", attempts: 1,
  firstPickedUpAt: firstPickup, deadlineAt: "2026-10-22T14:15:00.000Z",
  request: { target: { courseId: "course-1", offeringId: "rental-1", kind: "SIMULATOR" },
    identity: { name: "Example", address: "123 Example St, Example, CA 95678", officialUrl: official, bookingUrl: null },
    input: { date: "2026-10-23", players: 2, windowStart: "10:00", windowEnd: "20:00", durationMinutes: 60, timeZone: "America/Los_Angeles" } } });
const recipe = () => ({ engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME", source: { bookingUrl: entry } });
type Action = { tool: string; arguments: Record<string, unknown> };
type Snapshot = Record<string, unknown>;
type Config = { deadlineAt: string; initialUrls: string[]; signal?: AbortSignal; helperEnvironment: Record<string, string> };
type Checkpoint = { controller: { browserTransport: string; transportFallbackUsed: boolean; observedNavigationUrls: string[] } };
const open = (url: string): Action => ({ tool: "discovery_browser", arguments: { action: "open", url } });
const propose = (): Action => ({ tool: "discovery_propose_recipe", arguments: { recipe: recipe() } });

/** Every transport/process/service operation is an in-memory double. No app,
 * browser, provider, database or model process is launched by these tests. */
async function run(options: {
  actions?: Action[]; job?: ReturnType<typeof inputJob> & { checkpoint?: unknown }; signal?: AbortSignal;
  snapshot?: (config: Config, input: Record<string, unknown>, index: number) => Snapshot | Promise<Snapshot>;
  checkpoint?: (payload: Checkpoint) => Promise<void>; close?: (index: number) => Promise<void>;
  created?: (config: Config, index: number) => void; afterAction?: (index: number) => void;
  replay?: () => Promise<unknown>;
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "rex-worker-fallback-"));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }));
  writeFileSync(join(home, "auth.json"), "synthetic-test-auth");
  const events: string[] = [], configs: Config[] = [], requests: Array<{ index: number; input: Record<string, unknown> }> = [];
  const checkpoints: Checkpoint[] = [], replies: unknown[] = [], closed: number[] = [];
  const client = {
    helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME" }),
    checkpoint: vi.fn(async (_id, _token, payload) => {
      checkpoints.push(structuredClone(payload)); events.push(`checkpoint:${payload.controller.browserTransport}:${payload.controller.transportFallbackUsed}`);
      await options.checkpoint?.(payload); return {};
    }),
    candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [
      { id: "original", recipeHash: hash, input: { ...inputJob().request.input } },
      { id: "changed", recipeHash: hash, input: { ...inputJob().request.input, date: "2026-10-24" } },
    ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({ recipeId: "saved-recipe" })),
  };
  const validateRecipe = vi.fn(async () => ({ valid: true }));
  const executeRecipe = vi.fn(options.replay ?? (async () => ({ status: "AVAILABLE", complete: true, slots: [{ sourceId: "opening" }] })));
  const actions = options.actions ?? [open(official), open(entry)];
  let toolsDone: Promise<void> = Promise.resolve();
  const processFactory = config => ({ close: vi.fn(async () => {}), notify: vi.fn(), request: async method => {
    if (method === "thread/start") return { thread: { id: "thread" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
    if (method === "turn/start") {
      toolsDone = Promise.resolve().then(async () => {
        await config.onMessage({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }, () => {});
        for (const [index, action] of actions.entries()) {
          await config.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", ...action } }, reply => replies.push(reply));
          options.afterAction?.(index);
        }
        await config.onMessage({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }, () => {});
      });
      return { turn: { id: "turn" } };
    }
    return {};
  } });
  try {
    const result = await runCourseDiscoveryWorker({ job: options.job ?? inputJob(), client, cwd: process.cwd(), sourceHome: home,
      recipeSchema: {}, resolveCli: () => "synthetic-no-process", processFactory, validateRecipe, executeRecipe, signal: options.signal,
      browserFactory: config => {
        const index = configs.length; events.push(`create:${index}`); configs.push(config); options.created?.(config, index);
        return { close: async () => { events.push(`close:${index}`); await options.close?.(index); closed.push(index); },
          request: async input => {
            events.push(`request:${index}:${input.action}`); requests.push({ index, input });
            if (options.snapshot) return options.snapshot(config, input, index);
            if (input.url === official) return { ...native(), url: official, requests: [], requestCount: 2, responseBytes: 100 };
            return config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "NATIVE_CHROME" ? native() : {
              ...native(), browserTransport: "PINNED_HTTP", loading: false, pendingRequestCount: 0,
              controls: [{ target: "new-pinned-control", label: "Calendar" }], requests: [{ url: catalog, method: "POST", resourceType: "xhr", status: 200 }],
              requestCount: 12, responseBytes: 2000,
            };
          } };
      } }).catch(error => error);
    await toolsDone;
    return { result, events, configs, requests, checkpoints, replies, closed, client, validateRecipe, executeRecipe };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("trusted REX anonymous transport selection", () => {
  it.each(["open", "observe"])("uses the current native cookie denial on %s, including an unsettled OPEN", action => {
    expect(shouldUseRexPinnedFallback(native(), "NATIVE_CHROME", false, action)).toBe(true);
    expect(shouldUseRexPinnedFallback({ ...native(), loading: false, pendingRequestCount: 0 }, "NATIVE_CHROME", false, action)).toBe(true);
  });

  it.each([
    ["already used", { used: true }], ["active pinned", { transport: "PINNED_HTTP" }], ["other action", { action: "click" }],
    ["snapshot pinned", { snapshot: { ...native(), browserTransport: "PINNED_HTTP" } }],
    ["missing actual transport", { snapshot: { ...native(), browserTransport: undefined } }],
    ["403", { snapshot: { ...native(), navigationStatus: 403 } }], ["429", { snapshot: { ...native(), navigationStatus: 429 } }],
    ["access", { snapshot: { ...native(), accessRequirementObserved: true } }],
    ["missing access fact", { snapshot: { ...native(), accessRequirementObserved: undefined } }],
    ["fatal", { snapshot: { ...native(), nativeFirstFatal: { code: "NATIVE_REDIRECT_PROVENANCE_REJECTED" } } }],
    ["recent 429", { snapshot: { ...native(), requests: [denied(), { url: catalog, method: "GET", resourceType: "xhr", status: 429 }] } }],
    ["throttled read", { snapshot: { ...native(), requests: [denied(), { ...denied(), blockedReason: "PROVIDER_THROTTLED" }] } }],
    ["throttle failure", { snapshot: { ...native(), requestFailures: [{ reason: "HTTP_429" }] } }],
    ["request not array", { snapshot: { ...native(), requests: {} } }], ["null request", { snapshot: { ...native(), requests: [null, denied()] } }],
    ["unsafe status", { snapshot: { ...native(), requests: [{ ...denied(), status: "200" }] } }],
    ["inherited snapshot", { snapshot: Object.create(native()) }],
    ["inherited request", { snapshot: { ...native(), requests: [Object.create(denied())] } }],
    ["inherited denial", { snapshot: { ...native(), requests: [Object.assign(Object.create({ blockedReason: "REX_READ_HEADER_COOKIE" }), { url: catalog, method: "POST", resourceType: "xhr" })] } }],
    ["malformed failure", { snapshot: { ...native(), requestFailures: [null] } }],
  ])("does not switch for %s", (_name, change) => {
    expect(shouldUseRexPinnedFallback(change.snapshot ?? native(), change.transport ?? "NATIVE_CHROME", change.used ?? false, change.action ?? "open")).toBe(false);
  });

  it.each([
    "http://example.reservewithrex.com/package", "https://reservewithrex.com/package", "https://sub.example.reservewithrex.com/package",
    "https://example.reservewithrex.com/account", "https://example.reservewithrex.com/package#calendar",
    "https://example.reservewithrex.com/package?token=private", "https://user:private@example.reservewithrex.com/package",
    "https://example.reservewithrex.com:444/package", "https://example.reservewithrex.com/package?other=1",
  ])("does not switch from an unrelated or unsafe document %s", url => {
    expect(shouldUseRexPinnedFallback({ ...native(), url }, "NATIVE_CHROME", false, "open")).toBe(false);
  });
  it.each([
    { url: "https://foreign.reservewithrex.com/api/venue/get" }, { url: `${catalog}?date=2026-10-23` }, { url: `${catalog}#x` },
    { url: "https://example.reservewithrex.com/api/venue/get-venue-with-package" }, { method: "GET" }, { resourceType: "document" },
    { blockedReason: "REX_READ_HEADER_AUTHORIZATION" }, { blockedReason: "REX_READ_BODY_GUESTS_STRING_TYPE" },
  ])("does not authorize any other request shape (%j)", change => {
    expect(shouldUseRexPinnedFallback({ ...native(), requests: [{ ...denied(), ...change }] }, "NATIVE_CHROME", false, "open")).toBe(false);
  });
  it("binds only the actual enum without mutating a model proposal or typed recipe", () => {
    const proposal = recipe();
    expect(bindDiscoveryRecipeBrowserTransport(proposal, "PINNED_HTTP")).toMatchObject({ browserTransport: "PINNED_HTTP" });
    expect(proposal.browserTransport).toBe("NATIVE_CHROME");
    expect(bindDiscoveryRecipeBrowserTransport({ engine: "BROWSER_DOM" }, "NATIVE_CHROME")).toEqual({ engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME" });
    expect(() => bindDiscoveryRecipeBrowserTransport(proposal, "model-choice")).toThrow("DISCOVERY_BROWSER_TRANSPORT_UNVERIFIED");
    const typed = { engine: "EXISTING_ADAPTER" };
    expect(bindDiscoveryRecipeBrowserTransport(typed, undefined)).toBe(typed);
  });
  it("binds response-backed browser proposals to the actual transport and rejects an unverified one", () => {
    const proposal = { engine: "BROWSER_JSON", browserTransport: "model-choice", responseRows: { path: "data.availability" } };
    expect(bindDiscoveryRecipeBrowserTransport(proposal, "NATIVE_CHROME")).toEqual({ ...proposal, browserTransport: "NATIVE_CHROME" });
    expect(bindDiscoveryRecipeBrowserTransport(proposal, "PINNED_HTTP")).toEqual({ ...proposal, browserTransport: "PINNED_HTTP" });
    expect(proposal.browserTransport).toBe("model-choice");
    expect(() => bindDiscoveryRecipeBrowserTransport(proposal, undefined)).toThrow("DISCOVERY_BROWSER_TRANSPORT_UNVERIFIED");
  });
});

describe("worker fallback persistence, lifetime and independent replay", () => {
  // Keep real timers for asynchronous tool/checkpoint/close delivery. Only the
  // fixture's wall clock is controlled, including explicit retry time advances.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(firstPickup); });
  afterEach(() => { vi.useRealTimers(); });

  it("persists the one-way choice and drains the old helper before dispatch, with original clocks and summed counters", async () => {
    const controller = new AbortController(), signal = controller.signal, job = inputJob(), originalJob = structuredClone(job);
    const outcome = await run({ signal, job });
    expect(outcome.result.code).toBe("DISCOVERY_NO_VERIFIED_RECIPE");
    expect(outcome.events.indexOf("checkpoint:PINNED_HTTP:true")).toBeLessThan(outcome.events.indexOf("close:0"));
    expect(outcome.events.indexOf("close:0")).toBeLessThan(outcome.events.indexOf("create:1"));
    expect(outcome.requests).toEqual([{ index: 0, input: { action: "open", url: official } },
      { index: 0, input: { action: "open", url: entry } }, { index: 1, input: { action: "open", url: entry } }]);
    for (const config of outcome.configs) expect(config).toMatchObject({ deadlineAt: workDeadline,
      venueName: inputJob().request.identity.name, venueAddress: inputJob().request.identity.address, venueOfficialUrl: official });
    expect(job).toEqual(originalJob);
    expect(outcome.configs[0].signal).toBeInstanceOf(AbortSignal);
    expect(outcome.configs[0].signal).not.toBe(signal);
    expect(outcome.configs[1].signal).toBe(outcome.configs[0].signal);
    expect(outcome.configs[0].signal?.aborted).toBe(false);
    controller.abort();
    expect(outcome.configs.every(config => config.signal?.aborted)).toBe(true);
    expect(outcome.configs[1].initialUrls).toContain(entry);
    expect(outcome.checkpoints.find(checkpoint => checkpoint.controller.transportFallbackUsed)?.controller).toMatchObject({
      browserTransport: "PINNED_HTTP", observedNavigationUrls: [official, entry], transportFallbackUsed: true,
    });
    expect(outcome.result.discoveryMetrics).toMatchObject({ browserActions: 3, providerRequestsObserved: 22, responseBytesObserved: 3000,
      browserTransportsTried: ["NATIVE_CHROME", "PINNED_HTTP"] });
    expect(outcome.closed).toEqual([0, 1]);
  });

  it("awaits checkpoint and close completion rather than only starting them", async () => {
    let releaseCheckpoint!: () => void, releaseClose!: () => void;
    const checkpointWait = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
    const closeWait = new Promise<void>(resolve => { releaseClose = resolve; });
    let checkpointStarted!: () => void, closeStarted!: () => void;
    const checkpointObserved = new Promise<void>(resolve => { checkpointStarted = resolve; });
    const closeObserved = new Promise<void>(resolve => { closeStarted = resolve; });
    const created: number[] = [];
    const running = run({ checkpoint: async payload => { if (payload.controller.transportFallbackUsed) { checkpointStarted(); await checkpointWait; } },
      close: async index => { if (index === 0) { closeStarted(); await closeWait; } }, created: (_config, index) => { created.push(index); } });
    await checkpointObserved;
    expect(created).toEqual([0]);
    vi.setSystemTime(Date.parse(firstPickup) + 1000);
    releaseCheckpoint(); await closeObserved;
    expect(created).toEqual([0]);
    vi.setSystemTime(Date.parse(firstPickup) + 2000);
    releaseClose(); const outcome = await running;
    expect(created).toEqual([0, 1]);
    expect(outcome.configs.map(config => config.deadlineAt)).toEqual([workDeadline, workDeadline]);
  });

  it.each(["checkpoint", "close"])("never dispatches a successor after failed %s", async failure => {
    const outcome = await run({ checkpoint: async payload => { if (failure === "checkpoint" && payload.controller.transportFallbackUsed) throw new Error("synthetic persistence unavailable"); },
      close: async () => { if (failure === "close") throw new Error("synthetic cleanup unavailable"); } });
    expect(outcome.result.code).toBe("DISCOVERY_TRANSPORT_FALLBACK_FAILED");
    expect(outcome.configs).toHaveLength(1);
    expect(outcome.checkpoints.some(checkpoint => checkpoint.controller.transportFallbackUsed && checkpoint.controller.browserTransport === "PINNED_HTTP")).toBe(true);
  });

  it("binds a stale model NATIVE proposal to fresh PINNED in candidate and both independent replays", async () => {
    const outcome = await run({ actions: [open(official), open(entry), propose()] });
    expect(outcome.result.outcome).toBe("activated");
    expect(outcome.validateRecipe).toHaveBeenLastCalledWith(expect.objectContaining({ recipe: expect.objectContaining({ browserTransport: "PINNED_HTTP" }) }));
    expect(outcome.client.candidate).toHaveBeenCalledWith("job-1", "private-test-lease", expect.objectContaining({ browserTransport: "PINNED_HTTP" }), outcome.configs[0].signal,
      { officialUrl: official, observedBookingUrl: entry });
    expect(outcome.executeRecipe).toHaveBeenCalledTimes(2);
    for (const [args] of outcome.executeRecipe.mock.calls) expect(args).toMatchObject({ recipe: { browserTransport: "PINNED_HTTP" }, deadlineAt: workDeadline, signal: outcome.configs[0].signal });
    expect(outcome.client.verification).toHaveBeenCalledTimes(2); expect(outcome.client.activate).toHaveBeenCalledOnce();
  });

  it("returns only successor controls and sends an old target only to the fresh helper, where it is rejected", async () => {
    const outcome = await run({ actions: [open(official), open(entry), { tool: "discovery_browser", arguments: { action: "click", target: "old-native-control" } }],
      snapshot: (config, action) => {
        const pinned = config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "PINNED_HTTP";
        if (pinned && action.action === "click") throw Object.assign(new Error("synthetic stale target"), { code: "STALE_OR_UNKNOWN_ELEMENT" });
        return { ...native(), url: action.url, requests: action.url === official ? [] : [denied()],
          browserTransport: pinned ? "PINNED_HTTP" : "NATIVE_CHROME",
          controls: [{ target: pinned ? "new-pinned-control" : "old-native-control", label: "Calendar" }] };
      } });
    expect(JSON.stringify(outcome.replies[1])).toContain("new-pinned-control");
    expect(JSON.stringify(outcome.replies[1])).not.toContain("old-native-control");
    expect(outcome.requests.at(-1)).toEqual({ index: 1, input: { action: "click", target: "old-native-control" } });
    expect(JSON.stringify(outcome.replies.at(-1))).toContain("STALE_OR_UNKNOWN_ELEMENT");
  });

  it("drops a same-URL controller adapter proof before the new transport can propose it", async () => {
    const adapter = { family: "TEEITUP", alias: "example", facilityIds: [1], officialIdentityProof: { kind: "old-controller-proof" } };
    const outcome = await run({ actions: [open(official), open(entry),
      { tool: "discovery_browser", arguments: { action: "inspect_adapter", url: entry } },
      { tool: "discovery_browser", arguments: { action: "observe" } },
      { tool: "discovery_propose_recipe", arguments: { recipe: { engine: "EXISTING_ADAPTER", source: { bookingUrl: entry }, adapter } } }],
      snapshot: (config, action) => {
        const pinned = config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "PINNED_HTTP";
        return { ...native(), url: action.url ?? entry, browserTransport: pinned ? "PINNED_HTTP" : "NATIVE_CHROME",
          requests: action.action === "observe" && !pinned ? [denied()] : [],
          ...(action.action === "inspect_adapter" ? { adapter } : {}) };
      } });
    expect(outcome.result.outcome).toBe("activated");
    expect(outcome.client.candidate).toHaveBeenCalledOnce();
    const persisted = outcome.client.candidate.mock.calls[0][2];
    expect(persisted.adapter).toEqual({ family: "TEEITUP", alias: "example", facilityIds: [1] });
    expect(outcome.checkpoints.every(checkpoint => !JSON.stringify(checkpoint).includes("old-controller-proof"))).toBe(true);
  });

  it.each(["finish", "failed successor open"])("cannot reuse an old snapshot for a proposal after %s", async mode => {
    const actions = [open(official), open(entry), ...(mode === "finish" ? [{ tool: "discovery_browser", arguments: { action: "finish" } }] : []), propose()];
    const outcome = await run({ actions, snapshot: (config, action) => {
      if (config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "PINNED_HTTP" && mode !== "finish") throw Object.assign(new Error("synthetic open failure"), { code: "BROWSER_NAVIGATION_FAILED" });
      return { ...native(), url: action.url ?? entry, requests: action.url === official ? [] : [denied()], browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT };
    } });
    expect(outcome.client.candidate).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.replies)).toContain("DISCOVERY_BROWSER_TRANSPORT_UNVERIFIED");
  });

  it("retains a failed-open checkpoint on resume and shares the once flag with HTTP403", async () => {
    const first = await run({ snapshot: (config, action) => {
      if (config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "PINNED_HTTP") throw Object.assign(new Error("synthetic open failure"), { code: "BROWSER_NAVIGATION_FAILED" });
      return { ...native(), url: action.url, requests: action.url === official ? [] : [denied()] };
    } });
    const saved = first.checkpoints.find(checkpoint => checkpoint.controller.transportFallbackUsed)!;
    vi.setSystemTime(Date.parse(firstPickup) + 60000);
    const job = { ...inputJob(), attempts: 2, checkpoint: saved }, originalJob = structuredClone(job);
    const resumed = await run({ job, actions: [open(entry)],
      snapshot: config => ({ ...native(), browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT, navigationStatus: 403 }) });
    expect(resumed.configs).toHaveLength(1);
    expect(resumed.configs[0].helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT).toBe("PINNED_HTTP");
    expect(resumed.configs[0].deadlineAt).toBe(workDeadline);
    expect(job).toEqual(originalJob);
    expect(resumed.requests).toHaveLength(1);
    expect(resumed.result.discoveryMetrics.browserTransportsTried).toEqual(["PINNED_HTTP"]);
  });

  it("still refuses a resumed job at its original work deadline without creating a transport", async () => {
    vi.setSystemTime(workDeadline);
    const job = { ...inputJob(), attempts: 2 }, originalJob = structuredClone(job);
    const outcome = await run({ job });
    expect(outcome.result.code).toBe("DISCOVERY_WORK_DEADLINE");
    expect(outcome.configs).toEqual([]);
    expect(outcome.client.checkpoint).not.toHaveBeenCalled();
    expect(outcome.client.candidate).not.toHaveBeenCalled();
    expect(job).toEqual(originalJob);
  });

  it("does not forget a previously observed throttle when later incremental evidence only contains a cookie denial", async () => {
    const outcome = await run({ snapshot: (_config, action) => action.url === official ? {
      ...native(), url: official, requests: [{ url: official, method: "GET", resourceType: "document", status: 429 }], navigationStatus: 200,
    } : native() });
    expect(outcome.configs).toHaveLength(1);
    expect(outcome.checkpoints.every(checkpoint => !checkpoint.controller.transportFallbackUsed)).toBe(true);
  });

  it("does not turn a cookie denial into body authority or accept a blocked required read as EMPTY", async () => {
    const headers = new Headers({ origin: new URL(catalog).origin, "content-type": "application/json" });
    expect(isRexPublicReadPost(new URL(catalog), headers, JSON.stringify({ venueId: "123", date: "2026-10-23", guests: 2 }))).toBe(true);
    expect(isRexPublicReadPost(new URL(catalog), headers, JSON.stringify({ venueId: "123", date: "2026-10-23", guests: "private-test-value" }))).toBe(false);
    const outcome = await run({ actions: [open(official), open(entry), propose()],
      snapshot: (config, action) => ({ ...native(), url: action.url,
        browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT,
        requests: action.url === official ? [] : [{ ...denied(), blockedReason: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT === "PINNED_HTTP"
          ? "REX_READ_BODY_GUESTS_STRING_TYPE" : "REX_READ_HEADER_COOKIE" }] }),
      replay: async () => ({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "UNSCOPED_OR_FAILED_RESOURCE" } }) });
    expect(outcome.executeRecipe).toHaveBeenCalledOnce();
    expect(outcome.client.verification).not.toHaveBeenCalled(); expect(outcome.client.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.replies)).toContain("DISCOVERY_REPLAY_INCOMPLETE");
    expect(JSON.stringify(outcome.replies)).toContain("UNSCOPED_OR_FAILED_RESOURCE");
    expect(JSON.stringify(outcome.replies)).toContain("REX_READ_BODY_GUESTS_STRING_TYPE");
  });
});
