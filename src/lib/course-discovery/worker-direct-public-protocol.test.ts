// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoveryDirectProtocolSource, inspectDiscoveryPublicProtocol, runCourseDiscoveryWorker } from "../../../scripts/automation/course-discovery-worker.mjs";

const booking = "https://www.sevenrooms.com/reservations/examplegolf?duration-picker=true";
const descriptor = { request: { url: "https://www.sevenrooms.com/public-range", method: "GET" },
  metadataRequest: { url: "https://www.sevenrooms.com/public-metadata" }, responseRows: { expectedRentalLabels: ["Happy Hour Rental", "Peak Rental"] },
  proof: { venue: { publicVenueMetadata: true } }, permittedRoutes: [], identity: { verified: true }, observation: { publicRequests: 2, publicResponseBytes: 1234 } };
type Action = { tool: string; arguments: Record<string, unknown> };
const inspect = (url = booking, extra = {}): Action => ({ tool: "discovery_browser", arguments: { action: "inspect_adapter", url, ...extra } });
const proposal: Action = { tool: "discovery_propose_recipe", arguments: { recipe: { engine: "HTTP_JSON", requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS",
  target: { courseId: "forged-target" }, source: { bookingUrl: booking, venueName: "forged-name", timeZone: "UTC" }, ...descriptor } } };
const job = () => ({ id: "current-job", leaseToken: "synthetic-lease", deadlineAt: new Date(Date.now() + 900_000).toISOString(), request: {
  target: { kind: "SIMULATOR", courseId: "course", offeringId: "rental" },
  identity: { officialUrl: "https://examplegolf.org/", bookingUrl: booking, name: "Example Indoor Golf", address: "12 Public Road, Springfield, NC 27601, USA" },
  input: { date: "2030-01-02", players: 2, durationMinutes: 60, timeZone: "America/New_York", startTime: "10:00", endTime: "20:00" },
} });

/** Controller/process/transport boundaries are synthetic; no application, browser,
 * provider or database operation is performed by these worker flow fixtures. */
async function run(options: { actions?: Action[]; mutate?: (value: ReturnType<typeof job>) => void; inspectError?: Error; checkpoint?: object; observation?: object } = {}) {
  const home = mkdtempSync(join(tmpdir(), "worker-direct-protocol-")), original = job();
  options.mutate?.(original);
  writeFileSync(join(home, "auth.json"), "synthetic-test-auth");
  const replies: unknown[] = [], checkpoints: unknown[] = [];
  const client = { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_ID: original.id }),
    checkpoint: vi.fn(async (_id, _lease, value) => { checkpoints.push(structuredClone(value)); return {}; }),
    candidate: vi.fn(async () => ({ recipeHash: "a".repeat(64), challenges: [
      { id: "one", recipeHash: "a".repeat(64), input: original.request.input },
      { id: "two", recipeHash: "a".repeat(64), input: { ...original.request.input, date: "2030-01-03", players: 3 } },
    ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({ recipeId: "saved" })) };
  const inspectProtocol = vi.fn(async () => { if (options.inspectError) throw options.inspectError;
    return structuredClone({ ...descriptor, ...(options.observation ? { observation: options.observation } : {}) }); });
  const browserFactory = vi.fn(() => ({ close: async () => {}, request: async input => ({ url: input.url, text: "Public page",
    browserTransport: "NATIVE_CHROME", loading: false, requests: [], controls: [], frames: [] }) }));
  const validateRecipe = vi.fn(async () => ({ valid: true }));
  const executeRecipe = vi.fn(async () => ({ status: "AVAILABLE", complete: true, slots: [{ sourceId: "synthetic-opening" }] }));
  let toolsDone = Promise.resolve();
  try {
    const result = await runCourseDiscoveryWorker({ job: { ...original, ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) },
      client, cwd: process.cwd(), sourceHome: home, recipeSchema: {}, modelCatalogJson: JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }),
      resolveCli: () => "synthetic-no-process", inspectProtocol, validateRecipe, executeRecipe, browserFactory,
      processFactory: config => ({ close: async () => {}, notify: () => {}, request: async method => {
        if (method === "thread/start") return { thread: { id: "thread" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
        if (method === "turn/start") {
          toolsDone = Promise.resolve().then(async () => {
            await config.onMessage({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }, () => {});
            for (const [index, action] of (options.actions ?? [inspect(), proposal]).entries())
              await config.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", ...action } }, value => replies.push(value));
            await config.onMessage({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }, () => {});
          });
          return { turn: { id: "turn" } };
        }
        return {};
      } }),
    }).catch(error => error);
    await toolsDone;
    return { result, original, replies, checkpoints, client, inspectProtocol, browserFactory, validateRecipe, executeRecipe };
  } finally {
    if (dirname(home) !== resolve(tmpdir()) || !home.startsWith(join(tmpdir(), "worker-direct-protocol-"))) throw new Error("UNOWNED_TEST_DIRECTORY");
    rmSync(home, { recursive: true, force: true });
  }
}

describe("unattended direct public protocol inspection", () => {
  it("uses the current job before any browser and retains canonical validation plus both independent replay challenges", async () => {
    const out = await run();
    expect(out.browserFactory).not.toHaveBeenCalled();
    expect(out.inspectProtocol).toHaveBeenCalledOnce();
    expect(out.inspectProtocol).toHaveBeenCalledWith({ source: { bookingUrl: booking, venueName: out.original.request.identity.name,
      venueAddress: out.original.request.identity.address, timeZone: out.original.request.input.timeZone }, input: out.original.request.input,
      deadlineAt: out.original.deadlineAt, signal: undefined });
    expect(JSON.parse(out.replies[0].result.contentItems[0].text)).toEqual({ publicProtocol: descriptor });
    expect(JSON.stringify(out.replies[0])).not.toMatch(/browserTransport|navigationStatus|"adapter"/u);
    expect(out.result.outcome).toBe("activated");
    expect(out.result.metrics).toMatchObject({ providerRequestsObserved: 2, responseBytesObserved: 1234 });
    const saved = out.client.candidate.mock.calls[0][2];
    expect(saved.target).toEqual(out.original.request.target);
    expect(saved.source).toMatchObject({ venueName: out.original.request.identity.name, venueAddress: out.original.request.identity.address,
      officialUrl: out.original.request.identity.officialUrl, timeZone: out.original.request.input.timeZone, bookingUrl: booking });
    expect(out.validateRecipe.mock.calls.at(-1)?.[0].recipe).toEqual(saved);
    expect(out.executeRecipe).toHaveBeenCalledTimes(2);
    for (const [args] of out.executeRecipe.mock.calls) expect(args).toMatchObject({ recipe: saved, deadlineAt: out.original.deadlineAt });
    expect(out.client.verification).toHaveBeenCalledTimes(2);
    expect(out.client.activate).toHaveBeenCalledOnce();
    expect(out.checkpoints.every(value => !JSON.stringify(value).includes("publicProtocol"))).toBe(true);
  });

  it.each([{ input: { date: "2030-01-04" } }, { headers: { authorization: "never-read" } }, { option: "model-query" }, { text: "model-source" }])(
    "cannot supply protocol inputs or headers in the existing tool (%j)", async extra => {
      const out = await run({ actions: [inspect(booking, extra)] });
      expect(out.inspectProtocol).not.toHaveBeenCalled(); expect(out.browserFactory).not.toHaveBeenCalled();
      expect(out.client.candidate).not.toHaveBeenCalled();
    });

  it("rejects a different public tenant before any direct request or browser creation", async () => {
    const out = await run({ actions: [inspect("https://www.sevenrooms.com/reservations/differentgolf")] });
    expect(out.inspectProtocol).not.toHaveBeenCalled(); expect(out.browserFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(out.replies)).toContain("DISCOVERY_SOURCE_NOT_OBSERVED");
  });

  it.each(["missing address", "outdoor", "no offering"])("does not inspect incomplete current job context: %s", async kind => {
    const out = await run({ actions: [inspect()], mutate: value => {
      if (kind === "missing address") value.request.identity.address = "";
      else if (kind === "outdoor") value.request.target.kind = "OUTDOOR";
      else value.request.target.offeringId = "";
    } });
    expect(out.inspectProtocol).not.toHaveBeenCalled(); expect(out.browserFactory).not.toHaveBeenCalled();
  });

  it("does not restore direct inspection from a checkpoint or fall back to a browser after its failure", async () => {
    const out = await run({ actions: [inspect()], inspectError: Object.assign(new Error("not provider text"), { code: "SEVENROOMS_IDENTITY_UNVERIFIED" }),
      checkpoint: { controller: { version: 1, officialUrl: "https://examplegolf.org/", observedNavigationUrls: [], publicProtocol: descriptor } } });
    expect(out.inspectProtocol).toHaveBeenCalledOnce(); expect(out.browserFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(out.replies)).toContain("SEVENROOMS_IDENTITY_UNVERIFIED");
    expect(out.client.candidate).not.toHaveBeenCalled(); expect(out.client.activate).not.toHaveBeenCalled();
  });

  it("leaves non-SevenRooms inspection on its established browser/adapter path", async () => {
    const url = "https://example.reservewithrex.com/package";
    const out = await run({ actions: [inspect(url)] });
    expect(out.inspectProtocol).not.toHaveBeenCalled(); expect(out.browserFactory).toHaveBeenCalledOnce();
  });

  it("supports an actual official-derived booking navigation without minting source authority from inspection", async () => {
    const out = await run({ actions: [{ tool: "discovery_browser", arguments: { action: "open", url: "https://examplegolf.org/" } },
      { tool: "discovery_browser", arguments: { action: "open", url: booking } }, inspect(), proposal], mutate: value => { value.request.identity.bookingUrl = null; } });
    expect(out.browserFactory).toHaveBeenCalledOnce(); expect(out.inspectProtocol).toHaveBeenCalledOnce();
    expect(out.result.outcome).toBe("activated");
    expect(out.client.candidate.mock.calls[0][4]).toEqual({ officialUrl: "https://examplegolf.org/", observedBookingUrl: booking });
    expect(out.executeRecipe).toHaveBeenCalledTimes(2);
  });

  it.each([
    { officialSourceObserved: false, officialUrl: "https://examplegolf.org/", observedNavigationUrls: new Set([booking]) },
    { officialSourceObserved: true, officialUrl: "https://other-official.org/", observedNavigationUrls: new Set([booking]) },
    { officialSourceObserved: true, officialUrl: "https://examplegolf.org/", observedNavigationUrls: new Set(), observedReadUrls: new Set([booking]) },
    { officialSourceObserved: true, officialUrl: "https://examplegolf.org/", observedNavigationUrls: new Set(), observedEntryUrls: new Set([booking]) },
    { officialSourceObserved: true, officialUrl: "https://examplegolf.org/", observedNavigationUrls: new Set(), publicProtocol: descriptor },
  ])("does not grant a changed booking URL from unvisited/read/entry/foreign context (%j)", context => {
    const current = job(); current.request.identity.bookingUrl = null;
    expect(() => discoveryDirectProtocolSource(current, { action: "inspect_adapter", url: booking }, context)).toThrow("DISCOVERY_SOURCE_NOT_OBSERVED");
  });

  it.each([{ publicRequests: 2 }, { publicRequests: 3, publicResponseBytes: 4_000_001 }, { publicRequests: "2", publicResponseBytes: -1 }])(
    "records only measured bounded aggregate facts without inventing missing counts (%j)", async observation => {
      const out = await run({ observation });
      if (observation.publicRequests === 2) expect(out.result.metrics.providerRequestsObserved).toBe(2);
      else expect(out.result.metrics).not.toHaveProperty("providerRequestsObserved");
      expect(out.result.metrics).not.toHaveProperty("responseBytesObserved");
    });
});

describe("bounded trusted direct-inspection child", () => {
  it("passes job data through the fixed stdin channel and closes it after successful or failed inspection", async () => {
    const original = job(), source = { bookingUrl: booking, venueName: original.request.identity.name,
      venueAddress: original.request.identity.address, timeZone: original.request.input.timeZone };
    for (const rejected of [false, true]) {
      const request = vi.fn(async () => { if (rejected) throw new Error("SYNTHETIC_CHILD_FAILURE"); return descriptor; });
      const close = vi.fn(async () => {}), processFactory = vi.fn(() => ({ request, close }));
      const promise = inspectDiscoveryPublicProtocol({ cwd: process.cwd(), source, input: original.request.input, deadlineAt: original.deadlineAt,
        helperEnvironment: { COURSE_DISCOVERY_JOB_ID: original.id, LOCAL_READER_DEVICE_TOKEN: "private-environment-only" }, processFactory });
      if (rejected) await expect(promise).rejects.toThrow("SYNTHETIC_CHILD_FAILURE"); else expect(await promise).toBe(descriptor);
      expect(request).toHaveBeenCalledWith({ source, input: original.request.input }); expect(close).toHaveBeenCalledOnce();
      const config = processFactory.mock.calls[0][0];
      expect(config.args.slice(-3)).toEqual(["--inspect-public-protocol", "--deadline", original.deadlineAt]);
      expect(config.timeoutMs).toBeGreaterThan(0); expect(config.timeoutMs).toBeLessThanOrEqual(45_000);
      expect(JSON.stringify(config.args)).not.toContain("private-environment-only");
      expect(config.environment.COURSE_DISCOVERY_JOB_ID).toBe(original.id);
    }
  });

  it("does not create a child for a canceled or already-expired job", async () => {
    const controller = new AbortController(); controller.abort(); const processFactory = vi.fn();
    await expect(inspectDiscoveryPublicProtocol({ cwd: process.cwd(), source: {}, input: {}, deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      signal: controller.signal, processFactory })).rejects.toMatchObject({ code: "DISCOVERY_CANCELLED" });
    await expect(inspectDiscoveryPublicProtocol({ cwd: process.cwd(), source: {}, input: {}, deadlineAt: "2020-01-01T00:00:00Z", processFactory }))
      .rejects.toMatchObject({ code: "DISCOVERY_DEADLINE" });
    expect(processFactory).not.toHaveBeenCalled();
  });
});
