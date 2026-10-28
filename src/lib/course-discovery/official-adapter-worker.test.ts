// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { isOfficialAdapterJob, inspectOfficialAdapter } from "../../../scripts/automation/course-discovery-official-adapter.mjs";
import { runCourseDiscoveryStagehandWorker } from "../../../scripts/automation/course-discovery-stagehand-worker.mjs";
import { discoveryProcessEnvironment } from "../../../scripts/automation/course-discovery-worker.mjs";
import { accessRecipeSchema, hashAccessRecipe } from "./recipe";

const root = "https://public-fixture.teesnap.net/";
const job = () => {
  const first = Date.now() - 1000;
  return { id: "official-root-job", leaseToken: "synthetic-private-lease", attempts: 1, sourceFingerprint: "a".repeat(64),
    firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900000).toISOString(),
    request: { target: { kind: "OUTDOOR", courseId: "fixture-course" },
      identity: { officialUrl: root, bookingUrl: null as string | null, name: "Public Fixture Golf Course", address: "531 Pine Drive, Fairhaven, MA 02719, USA", timeZone: "America/New_York" },
      input: { date: "2030-06-12", players: 2, timeZone: "America/New_York", startTime: "09:00", endTime: "16:00" } } };
};
const descriptor = () => ({ adapter: { family: "TEESNAP", tenant: "public-fixture", courseId: 81, defaultHoles: 18, defaultAddons: "off",
  timeZone: "America/New_York", catalogHash: "b".repeat(64) }, observation: { transport: "FIXED_PUBLIC_ROOT", publicRequests: 1, publicResponseBytes: 3200 } });
afterEach(() => vi.useRealTimers());

function helper(options: { result?: unknown; error?: Error; closeError?: boolean; afterRead?: () => void } = {}) {
  const close = vi.fn(async () => { if (options.closeError) throw Error("synthetic close failure"); });
  const request = vi.fn(async () => { options.afterRead?.(); if (options.error) throw options.error; return options.result ?? descriptor(); });
  const processFactory = vi.fn(() => ({ request, close }));
  return { close, request, processFactory, inspect: (value = job(), extra = {}) => inspectOfficialAdapter({ job: value, cwd: process.cwd(),
    deadlineAt: value.deadlineAt, processFactory, ...extra }) };
}

describe("fixed canonical official adapter root routing", () => {
  it("routes the exact current official root without needing a saved booking URL", () => {
    const value = job(); expect(isOfficialAdapterJob(value)).toBe(true);
    value.request.identity.bookingUrl = root; expect(isOfficialAdapterJob(value)).toBe(true);
  });
  it.each(["http://public-fixture.teesnap.net/", "https://public-fixture.teesnap.net", "https://public-fixture.teesnap.net:443/",
    "https://PUBLIC-FIXTURE.teesnap.net/", "https://www.teesnap.net/", "https://admin.teesnap.net/", "https://www.public-fixture.teesnap.net/",
    "https://public-fixture.teesnap.net/customer-api/teetimes-day", "https://public-fixture.teesnap.net/?date=2030-06-12",
    "https://user:pass@public-fixture.teesnap.net/", "https://public-fixture.teesnap.net/#booking", "https://public-fixture.example/"])(
    "leaves noncanonical or unrelated root %s to the existing strategy", value => {
      const current = job(); current.request.identity.officialUrl = value; expect(isOfficialAdapterJob(current)).toBe(false);
    });
  it.each(["offering", "simulator", "address", "zone", "duration", "booking", "control-text"])("rejects mismatched %s context before helper startup", async mismatch => {
    const current = job() as ReturnType<typeof job> & { request: { target: Record<string, unknown>; input: Record<string, unknown> } };
    if (mismatch === "offering") current.request.target.offeringId = "unowned-offering";
    if (mismatch === "simulator") current.request.target.kind = "SIMULATOR";
    if (mismatch === "address") current.request.identity.address = "";
    if (mismatch === "zone") current.request.input.timeZone = "America/Chicago";
    if (mismatch === "duration") current.request.input.durationMinutes = 60;
    if (mismatch === "booking") current.request.identity.bookingUrl = "https://different-fixture.teesnap.net/";
    if (mismatch === "control-text") current.request.identity.name += "\nprivate";
    const h = helper(); expect(isOfficialAdapterJob(current)).toBe(false);
    await expect(h.inspect(current)).rejects.toMatchObject({ code: "OFFICIAL_ADAPTER_SCOPE_INVALID" });
    expect(h.processFactory).not.toHaveBeenCalled();
  });
});

describe("private fixed inspection helper boundaries", () => {
  it("closes the one helper before returning mechanically bound recipe metadata", async () => {
    const h = helper(), current = job(), prepared = await h.inspect(current, { helperEnvironment: { LOCAL_READER_DEVICE_TOKEN: "private-test-value" } });
    expect(h.close).toHaveBeenCalledOnce(); expect(h.request).toHaveBeenCalledExactlyOnceWith({ target: current.request.target,
      source: { officialUrl: root, bookingUrl: root, venueName: current.request.identity.name, venueAddress: current.request.identity.address, timeZone: current.request.identity.timeZone }, input: current.request.input });
    expect(accessRecipeSchema.safeParse(prepared.recipe).success).toBe(true);
    expect(prepared.sourceEvidence).toEqual({ officialUrl: root, observedBookingUrl: root });
    expect(prepared.receipt).toMatchObject({ transport: "FIXED_PUBLIC_ROOT", modelCalls: 0, helperClosed: true, outcome: "INSPECTED" });
    const invocation = h.processFactory.mock.calls[0][0];
    expect(invocation.args.slice(-3)).toEqual(["--inspect-official-adapter", "--deadline", current.deadlineAt]);
    expect(invocation.timeoutMs).toBeLessThanOrEqual(30000);
    expect(JSON.stringify(invocation.args)).not.toContain("private-test-value");
  });
  it.each(["expired", "cancelled", "input-limit"])("does not launch a helper for %s work", async mode => {
    const h = helper(), current = job(), controller = new AbortController();
    if (mode === "expired") current.deadlineAt = new Date(Date.now() - 1).toISOString();
    if (mode === "cancelled") controller.abort();
    if (mode === "input-limit") Object.assign(current.request.input, { unexpected: "x".repeat(17000) });
    await expect(h.inspect(current, { signal: controller.signal })).rejects.toBeDefined();
    expect(h.processFactory).not.toHaveBeenCalled();
  });
  it.each(["tenant", "bytes", "requests", "extra", "zone"])("rejects unbound or out-of-budget %s metadata and closes its helper", async invalid => {
    const result = descriptor();
    if (invalid === "tenant") result.adapter.tenant = "different-fixture";
    if (invalid === "bytes") result.observation.publicResponseBytes = 600001;
    if (invalid === "requests") result.observation.publicRequests = 2;
    if (invalid === "extra") Object.assign(result.adapter, { arbitrarySourceUrl: "https://unobserved.example/" });
    if (invalid === "zone") result.adapter.timeZone = "America/Chicago";
    const h = helper({ result }); await expect(h.inspect()).rejects.toMatchObject({ code: "OFFICIAL_ADAPTER_RESULT_INVALID" });
    expect(h.close).toHaveBeenCalledOnce();
  });
  it("preserves an identity failure without inventing empty availability", async () => {
    const h = helper({ error: Object.assign(Error("ADAPTER_IDENTITY_MISMATCH"), { code: "ADAPTER_IDENTITY_MISMATCH" }) });
    await expect(h.inspect()).rejects.toMatchObject({ code: "ADAPTER_IDENTITY_MISMATCH", officialAdapterReceipt: { outcome: "FAILED", helperClosed: true, modelCalls: 0 } });
    expect(h.close).toHaveBeenCalledOnce();
  });
  it("does not hand off inspected metadata when helper cleanup fails", async () => {
    await expect(helper({ closeError: true }).inspect()).rejects.toMatchObject({ code: "OFFICIAL_ADAPTER_CLOSE_FAILED" });
  });
  it("rechecks cancellation after inspection while still closing the helper", async () => {
    const controller = new AbortController(), h = helper({ afterRead: () => controller.abort() });
    await expect(h.inspect(job(), { signal: controller.signal })).rejects.toBeDefined(); expect(h.close).toHaveBeenCalledOnce();
  });
});

async function run(options: { helperError?: Error; helperResult?: unknown; rejectAt?: string; invalidRecipe?: boolean; mutate?: (value: ReturnType<typeof job>) => void } = {}) {
  const current = job(); options.mutate?.(current);
  const h = helper({ error: options.helperError, result: options.helperResult }), sourceDiscover = vi.fn(), browserFactory = vi.fn(), guardedBrowserFactory = vi.fn(), genericWorker = vi.fn();
  let recipeHash = "";
  const client = { helperEnvironment: vi.fn(() => ({})), checkpoint: vi.fn(async () => ({})),
    candidate: vi.fn(async (_id, _lease, recipe) => {
      expect(h.close).toHaveBeenCalledOnce(); if (options.rejectAt === "candidate") throw Error("BACKEND_REJECTED");
      recipeHash = hashAccessRecipe(recipe);
      return { recipeHash, challenges: [{ id: "backend-one", recipeHash, input: current.request.input },
        { id: "backend-two", recipeHash, input: { ...current.request.input, players: 3 } }] };
    }), verification: vi.fn(async () => { if (options.rejectAt === "verification") throw Error("BACKEND_REJECTED"); return {}; }),
    activate: vi.fn(async () => { if (options.rejectAt === "activate") throw Error("BACKEND_REJECTED"); return { recipeId: "new-saved-method" }; }) };
  const executeRecipe = vi.fn(async () => ({ complete: true, status: "AVAILABLE", observedAt: new Date().toISOString(), slots: [],
    evidence: { recipeHash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } }));
  const afterActivate = vi.fn();
  const outcome = await runCourseDiscoveryStagehandWorker({ job: current, cwd: process.cwd(), sourceDiscover, browserFactory, guardedBrowserFactory, genericWorker,
    officialAdapterInspector: args => h.inspect(args.job, args), client, executeRecipe, afterActivate,
    validateRecipe: async ({ recipe }) => ({ valid: !options.invalidRecipe && accessRecipeSchema.safeParse(recipe).success }) }).catch(error => error);
  return { outcome, current, h, client, executeRecipe, afterActivate, sourceDiscover, browserFactory, guardedBrowserFactory, genericWorker };
}

describe("model-free official-root common verification path", () => {
  it("verifies both independent challenges for a freshly inspected public property API method without model calls", async () => {
    const value = descriptor(), result = { adapter: { ...value.adapter, publicApiVersion: "BOOKINGSITE_V1", supportedPlayers: [1, 2, 3, 4] },
      observation: { ...value.observation, publicRequests: 2 } };
    const t = await run({ helperResult: result });
    expect(t.outcome.outcome).toBe("activated"); expect(t.client.verification).toHaveBeenCalledTimes(2);
    expect(t.executeRecipe).toHaveBeenCalledTimes(2); expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.genericWorker).not.toHaveBeenCalled();
  });
  it.each([[], [2, 2], [3, 2], [0], [5]].map(supportedPlayers => ({ supportedPlayers })))("rejects unsupported or ambiguous public property player binding $supportedPlayers", async ({ supportedPlayers }) => {
    const value = descriptor(), t = await run({ helperResult: { adapter: { ...value.adapter, publicApiVersion: "BOOKINGSITE_V1", supportedPlayers },
      observation: { ...value.observation, publicRequests: 2 } } });
    expect(t.outcome).toBeInstanceOf(Error); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.sourceDiscover).not.toHaveBeenCalled();
  });
  it("uses both backend challenges and activation after fixed inspection without starting a model or browser", async () => {
    const t = await run(); expect(t.outcome.outcome).toBe("activated");
    expect(t.client.candidate).toHaveBeenCalledOnce(); expect(t.client.verification).toHaveBeenCalledTimes(2);
    expect(t.executeRecipe).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.afterActivate).toHaveBeenCalledOnce();
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.guardedBrowserFactory).not.toHaveBeenCalled(); expect(t.genericWorker).not.toHaveBeenCalled();
    expect(t.outcome.metrics).toMatchObject({ modelCalls: 0, fixedInspectionModelCalls: 0, replayModelCalls: 0,
      officialAdapterReceipt: { transport: "FIXED_PUBLIC_ROOT", helperClosed: true, modelCalls: 0 } });
    expect(t.current.attempts).toBe(1); expect(t.client.checkpoint.mock.calls.some(call => JSON.stringify(call).includes('"officialAdapterReceipt"'))).toBe(true);
    expect(t.client.checkpoint.mock.calls.some(call => JSON.stringify(call).includes('"stagehandSource"'))).toBe(false);
  });
  it.each(["candidate", "verification", "activate"])("cannot bypass backend %s rejection", async rejectAt => {
    const t = await run({ rejectAt }); expect(t.outcome).toBeInstanceOf(Error); expect(t.afterActivate).not.toHaveBeenCalled();
    if (rejectAt !== "activate") expect(t.client.activate).not.toHaveBeenCalled();
    expect(t.h.close).toHaveBeenCalledOnce(); expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.genericWorker).not.toHaveBeenCalled();
  });
  it("does not propose a method when fixed identity inspection or recipe validation fails", async () => {
    for (const options of [{ helperError: Object.assign(Error("ADAPTER_IDENTITY_MISMATCH"), { code: "ADAPTER_IDENTITY_MISMATCH" }) }, { invalidRecipe: true }]) {
      const t = await run(options); expect(t.outcome).toBeInstanceOf(Error); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
      expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.genericWorker).not.toHaveBeenCalled();
    }
  });
  it.each(["ACCESS_REQUIRED", "ADAPTER_CONFIGURATION_UNVERIFIED"])("keeps ordinary public browser discovery eligible after an owned HTTP %s failure", async code => {
    const t = await run({ helperError: Object.assign(Error(code), { code }) });
    expect(t.h.close).toHaveBeenCalledOnce(); expect(t.sourceDiscover).toHaveBeenCalledOnce();
    expect(t.h.close.mock.invocationCallOrder[0]).toBeLessThan(t.sourceDiscover.mock.invocationCallOrder[0]);
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("retains existing Stagehand selection for other ordinary roots", async () => {
    const t = await run({ mutate: value => { value.request.identity.officialUrl = "https://ordinary-fixture.example/"; } });
    expect(t.sourceDiscover).toHaveBeenCalledOnce(); expect(t.h.processFactory).not.toHaveBeenCalled();
  });
});

describe("actual private official-adapter CLI rejection", () => {
  it("rejects malformed scope and NDJSON before touching even the loopback coordination server", async () => {
    let coordinationHits = 0;
    // The server never grants a lease. Even a validation regression cannot use
    // this test authority for a real public provider request.
    const server = createServer((_request, response) => {
      coordinationHits++; response.writeHead(200, { "content-type": "application/json" }); response.end('{"lease":null}');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("LOOPBACK_COORDINATION_UNAVAILABLE");
    const secret = "synthetic-cli-coordination-secret-never-log";
    const environment = { ...discoveryProcessEnvironment(), COURSE_DISCOVERY_API_ORIGIN: `http://127.0.0.1:${address.port}`,
      LOCAL_READER_DEVICE_TOKEN: secret, COURSE_DISCOVERY_JOB_ID: "synthetic-cli-job", COURSE_DISCOVERY_LEASE_TOKEN: "synthetic-cli-lease",
      COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_BROWSER_TRANSPORT: "PINNED_HTTP" };
    const payload = () => ({ id: 1, target: job().request.target,
      source: { officialUrl: root, bookingUrl: root, venueName: job().request.identity.name,
        venueAddress: job().request.identity.address, timeZone: "America/New_York" }, input: job().request.input });
    type Input = ReturnType<typeof payload>;
    const cases: Array<{ name: string; change?: (value: Input) => void; wire?: string; extraArgs?: string[]; expected: string }> = [
      { name: "mode arguments", extraArgs: ["--unknown-mode"], expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "marketing root", change: value => { value.source.officialUrl = value.source.bookingUrl = "https://public-fixture.example/"; }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "noncanonical root", change: value => { value.source.officialUrl = value.source.bookingUrl = root.slice(0, -1); }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "API path", change: value => { value.source.officialUrl = value.source.bookingUrl = root + "customer-api/teetimes-day"; }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "source mismatch", change: value => { value.source.bookingUrl = "https://other-fixture.teesnap.net/"; }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "wrong mode", change: value => { value.target.kind = "SIMULATOR"; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "offering", change: value => { Object.assign(value.target, { offeringId: "unexpected-offering" }); }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "date", change: value => { value.input.date = "not-a-date"; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "timezone mismatch", change: value => { value.input.timeZone = "America/Chicago"; }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "invalid timezone", change: value => { value.input.timeZone = "Unknown/Fixture"; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "duration", change: value => { Object.assign(value.input, { durationMinutes: 60 }); }, expected: "OFFICIAL_ADAPTER_SCOPE_INVALID" },
      { name: "zero players", change: value => { value.input.players = 0; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "invalid players", change: value => { value.input.players = 21; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "fractional players", change: value => { value.input.players = 1.5; }, expected: "BROWSER_ACTION_SCHEMA_INVALID" },
      { name: "malformed NDJSON", wire: '{"id":1,', expected: "BROWSER_ACTION_FAILED" },
      { name: "oversized input", wire: JSON.stringify({ id: 1, unexpected: "x".repeat(17000) }), expected: "REQUEST_TOO_LARGE" },
    ];
    try {
      for (const scenario of cases) {
        const value = payload(); scenario.change?.(value);
        const wire = scenario.wire ?? JSON.stringify(value);
        const result = await new Promise<{ code: number | null; output: string; errors: string; timedOut: boolean; oversized: boolean }>((done, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/automation/course-discovery-browser.ts"),
            "--inspect-official-adapter", "--deadline", new Date(Date.now() + 30000).toISOString(), ...(scenario.extraArgs ?? [])],
          { cwd: process.cwd(), env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
          let output = "", errors = "", timedOut = false, oversized = false;
          const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
          const collect = (chunk: Buffer, stderr = false) => {
            if (stderr) errors += String(chunk); else output += String(chunk);
            if (Buffer.byteLength(output) + Buffer.byteLength(errors) > 65536) { oversized = true; child.kill("SIGKILL"); }
          };
          child.stdout.on("data", chunk => collect(chunk)); child.stderr.on("data", chunk => collect(chunk, true));
          child.once("error", () => { clearTimeout(timer); reject(Error("ACTUAL_HELPER_START_FAILED")); });
          child.once("close", code => { clearTimeout(timer); done({ code, output, errors, timedOut, oversized }); });
          child.stdin.on("error", () => {}); child.stdin.end(wire + "\n");
        });
        expect(result.timedOut, scenario.name).toBe(false); expect(result.oversized, scenario.name).toBe(false);
        expect(result.code, scenario.name).toBe(0);
        expect(result.output, scenario.name).not.toContain(secret); expect(result.errors, scenario.name).not.toContain(secret);
        const lines = result.output.trim().split(/\r?\n/u); expect(lines, scenario.name).toHaveLength(1);
        const parsed = JSON.parse(lines[0]);
        expect(parsed.ok, scenario.name).toBe(false); expect(parsed.error, scenario.name).toBe(scenario.expected);
        expect(coordinationHits, scenario.name).toBe(0);
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    }
  }, 120000);
});
