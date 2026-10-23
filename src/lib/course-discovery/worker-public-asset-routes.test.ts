// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryPublicAssetInventory } from "../../../scripts/automation/course-discovery-public-assets.mjs";
import { createDiscoverySnapshotCompactor, runCourseDiscoveryWorker } from "../../../scripts/automation/course-discovery-worker.mjs";

const transport = "NATIVE_CHROME";
const official = "https://example.org/";
const booking = "https://booking.example.org/availability";
// Real omission-shaped public asset grammar, without provider configuration.
const parentAsset = "https://apis.google.com/js/client:platform.js?onload=publicReady";
const childAsset = "https://apis.google.com/_/scs/abc-static/_/js/k=gapi.gapi.en.publicbuild/m=client/rt=j/sv=1/d=1/ed=1/cb=gapi.loaded_0?le=public";
const asset = (url = parentAsset, change = {}) => ({ url, method: "GET", resourceType: "script", status: 200, ...change });
const proposal = (engine = "BROWSER_JSON") => ({ engine, browserTransport: "model-choice", source: { bookingUrl: booking },
  permittedRoutes: [{ origin: "https://booking.example.org", path: "/availability", methods: ["GET"], queryKeys: [] }] });
const collect = (requests = [asset()]) => {
  const inventory = createDiscoveryPublicAssetInventory(), browser = {};
  inventory.begin(browser, transport); inventory.observe(browser, { browserTransport: transport, requests });
  return { inventory, browser };
};
const routeOf = (url: string, kind = "script") => { const value = new URL(url); return { origin: value.origin, path: value.pathname,
  methods: ["GET"], queryKeys: [...new Set(value.searchParams.keys())].sort(), resourceTypes: [kind] }; };

describe("trusted current-browser public asset inventory", () => {
  it("serializes exact colon/equals paths and query names, with no values, headers or bodies", () => {
    const { inventory, browser } = collect([asset(parentAsset, { headers: { authorization: "private-sentinel" }, body: "private-body" }),
      asset(childAsset), asset("https://cdn.example.org/site.css?z=secret-value-sentinel&a=build", { resourceType: "stylesheet" })]);
    const input = proposal(), before = structuredClone(input), result = inventory.enrich(input, browser, transport);
    expect(result.permittedRoutes).toEqual([input.permittedRoutes[0], ...[routeOf(parentAsset), routeOf(childAsset),
      routeOf("https://cdn.example.org/site.css?a=ignored&z=ignored", "stylesheet")].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    expect(input).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/private-sentinel|private-body|secret-value-sentinel|publicReady|publicbuild.*le=public/u);
    expect(result.permittedRoutes.every(route => !route.path.includes("*"))).toBe(true);
  });

  it("unions only exact same-kind GET asset routes and preserves all original legacy authority", () => {
    const { inventory, browser } = collect([asset("https://cdn.example.org/site.js?a=1")]);
    const legacy = { origin: "https://cdn.example.org", path: "/site.js", methods: ["GET"], queryKeys: ["legacy"] };
    const head = { ...routeOf("https://cdn.example.org/site.js?head=1"), methods: ["HEAD"] };
    const style = routeOf("https://cdn.example.org/site.js?style=1", "stylesheet");
    const exact = routeOf("https://cdn.example.org/site.js?b=1");
    const input = { ...proposal(), permittedRoutes: [legacy, head, style, exact] };
    const result = inventory.enrich(input, browser, transport);
    expect(result.permittedRoutes.slice(0, 3)).toEqual([legacy, head, style]);
    expect(result.permittedRoutes[3]).toEqual({ ...exact, queryKeys: ["a", "b"] });
    expect(input.permittedRoutes[3].queryKeys).toEqual(["b"]);
  });

  it("retains over forty exact assets, accepts 128 with forty legacy routes, and rejects 129 without truncation", () => {
    const requests = Array.from({ length: 128 }, (_, i) => asset(`https://cdn.example.org/chunk-${i}.js`));
    const { inventory, browser } = collect(requests);
    const legacy = Array.from({ length: 40 }, (_, i) => ({ origin: "https://booking.example.org", path: `/public-${i}`, methods: ["GET"], queryKeys: [] }));
    expect(inventory.enrich({ ...proposal(), permittedRoutes: legacy }, browser, transport).permittedRoutes).toHaveLength(168);
    expect(() => inventory.enrich({ ...proposal(), permittedRoutes: [...legacy, legacy[0]] }, browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
    inventory.observe(browser, { browserTransport: transport, requests: [asset("https://cdn.example.org/chunk-129.js")] });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
  });

  it.each([
    ["pending", asset(parentAsset, { status: undefined })], ["redirect", asset(parentAsset, { status: 302 })],
    ["failed", asset(parentAsset, { status: 404 })], ["blocked", asset(parentAsset, { blockedReason: "UNSAFE_URL" })],
    ["HEAD", asset(parentAsset, { method: "HEAD" })], ["POST", asset(parentAsset, { method: "POST" })],
    ...["xhr", "fetch", "document", "image"].map(kind => [kind, asset(parentAsset, { resourceType: kind })]),
    ["inherited", Object.create(asset())], ["inherited denial", Object.assign(Object.create({ blockedReason: "UNSAFE_URL" }), asset())],
    ["redacted", asset("https://cdn.example.org/site.js?v=REDACTED")],
    ["secret key", asset("https://cdn.example.org/site.js?access_token=opaque")], ["encoded secret", asset("https://cdn.example.org/site.js?%74oken=opaque")],
    ["userinfo", asset("https://user:private@cdn.example.org/site.js")], ["port", asset("https://cdn.example.org:444/site.js")],
    ["fragment", asset("https://cdn.example.org/site.js#fragment")], ["private host", asset("https://cdn.internal/site.js")],
    ["IP", asset("https://127.0.0.1/site.js")], ["noncanonical", asset("https://CDN.example.org/site.js")],
    ["wildcard", asset("https://cdn.example.org/site*.js")], ["template", asset("https://cdn.example.org/{{name}}.js")],
    ["transaction", asset("https://cdn.example.org/checkout/site.js")], ["path control", asset("https://cdn.example.org/site%0a.js")],
  ])("ignores %s rather than constructing new saved authority", (_name, request) => {
    const { inventory, browser } = collect([request]);
    const input = proposal(); expect(inventory.enrich(input, browser, transport)).toBe(input);
  });

  it("deduplicates query names but fails closed when combined shape or byte budgets overflow", () => {
    const { inventory, browser } = collect([asset("https://cdn.example.org/site.js?a=1&a=2")]);
    expect(inventory.enrich(proposal(), browser, transport).permittedRoutes.at(-1).queryKeys).toEqual(["a"]);
    inventory.observe(browser, { browserTransport: transport, requests: Array.from({ length: 31 }, (_, i) => asset(`https://cdn.example.org/site.js?k${i}=1`)) });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
    const large = collect(Array.from({ length: 80 }, (_, i) => asset(`https://cdn.example.org/${"a".repeat(850)}${i}.js`)));
    expect(() => large.inventory.enrich(proposal(), large.browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
  });

  it("never transfers assets to another browser, stale transport, checkpoint or retired session", () => {
    const { inventory, browser } = collect(); const next = {};
    expect(() => inventory.enrich(proposal(), next, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
    inventory.observe(next, { browserTransport: transport, requests: [asset(childAsset)] });
    expect(inventory.enrich(proposal(), browser, transport).permittedRoutes).toHaveLength(2);
    inventory.observe(browser, { browserTransport: "PINNED_HTTP", requests: [asset(childAsset)] });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
    inventory.observe(browser, { browserTransport: transport, requests: [asset(childAsset)] });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
    inventory.begin(next, "PINNED_HTTP"); inventory.observe(browser, { browserTransport: transport, requests: [asset(childAsset)] });
    expect(inventory.enrich(proposal(), next, "PINNED_HTTP").permittedRoutes).toHaveLength(1);
    inventory.clear(); expect(() => inventory.enrich(proposal(), next, "PINNED_HTTP")).toThrow("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
    const typed = { engine: "EXISTING_ADAPTER" }; expect(inventory.enrich(typed, next, transport)).toBe(typed);
  });

  it("does not silently truncate an oversized snapshot or recover overflow without a fresh browser lifetime", () => {
    const { inventory, browser } = collect(Array.from({ length: 1025 }, () => asset()));
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
    inventory.observe(browser, { browserTransport: transport, requests: [] });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
    inventory.begin(browser, transport);
    expect(inventory.enrich(proposal(), browser, transport).permittedRoutes).toHaveLength(1);
  });
});

type Action = { tool: string; arguments: Record<string, unknown> };
const open = (url: string): Action => ({ tool: "discovery_browser", arguments: { action: "open", url } });
const finish: Action = { tool: "discovery_browser", arguments: { action: "finish" } };
const propose = (engine = "BROWSER_JSON"): Action => ({ tool: "discovery_propose_recipe", arguments: { recipe: proposal(engine) } });
type Config = { helperEnvironment: Record<string, string> };
const job = () => ({ id: "job", leaseToken: "synthetic-lease", attempts: 1, firstPickedUpAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 900_000).toISOString(),
  request: { target: { courseId: "course", offeringId: "rental", kind: "SIMULATOR" },
    identity: { name: "Example", address: "123 Example St, Example, CA 95678", officialUrl: official, bookingUrl: null },
    input: { date: "2026-10-23", players: 2, windowStart: "10:00", windowEnd: "20:00", durationMinutes: 60, timeZone: "America/Los_Angeles" } } });

/** All process, browser and service boundaries are in-memory doubles. */
async function run(options: { engine?: string; actions?: Action[]; checkpoint?: unknown; replayFailure?: boolean;
  snapshot?: (config: Config, input: Record<string, unknown>, index: number) => Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "worker-public-assets-")), original = job();
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
  writeFileSync(join(home, "auth.json"), "synthetic-test-auth");
  const replies: unknown[] = [], checkpoints: unknown[] = [], browsers: object[] = [], closed: number[] = [];
  const client = { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: transport }),
    checkpoint: vi.fn(async (_id, _lease, data) => { checkpoints.push(structuredClone(data)); return {}; }),
    candidate: vi.fn(async () => ({ recipeHash: "a".repeat(64), challenges: [
      { id: "original", recipeHash: "a".repeat(64), input: original.request.input },
      { id: "changed", recipeHash: "a".repeat(64), input: { ...original.request.input, date: "2026-10-24", players: 3 } },
    ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({ recipeId: "saved" })) };
  const validateRecipe = vi.fn(async () => ({ valid: true }));
  const executeRecipe = vi.fn(async () => options.replayFailure ? { status: "INCOMPLETE", complete: false, slots: [] } :
    { status: "AVAILABLE", complete: true, slots: [{ sourceId: "opening" }] });
  let toolsDone = Promise.resolve();
  try {
    const result = await runCourseDiscoveryWorker({ job: { ...original, ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) }, client,
      cwd: process.cwd(), sourceHome: home, recipeSchema: {}, resolveCli: () => "synthetic-no-process", validateRecipe, executeRecipe,
      processFactory: config => ({ close: async () => {}, notify: () => {}, request: async method => {
        if (method === "thread/start") return { thread: { id: "thread" }, approvalPolicy: "never", sandbox: { type: "readOnly" } };
        if (method === "turn/start") {
          toolsDone = Promise.resolve().then(async () => {
            await config.onMessage({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }, () => {});
            for (const [index, action] of (options.actions ?? [open(official), open(booking), propose(options.engine)]).entries())
              await config.onMessage({ id: index + 1, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", ...action } }, reply => replies.push(reply));
            await config.onMessage({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }, () => {});
          }); return { turn: { id: "turn" } };
        } return {};
      } }), browserFactory: config => {
        const index = browsers.length, browser = { close: async () => { closed.push(index); }, request: async input =>
          options.snapshot?.(config, input, index) ?? { url: input.url ?? booking, browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT,
            navigationStatus: 200, accessRequirementObserved: false, loading: false, pendingRequestCount: 0,
            requests: input.url === booking ? [asset(), asset(childAsset)] : [] } };
        browsers.push(browser); return browser;
      } }).catch(error => error);
    await toolsDone; return { result, client, validateRecipe, executeRecipe, checkpoints, replies, browsers, closed };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("worker asset serialization before validation and independent replay", () => {
  it("uses completed private asset deltas before compaction without returning them to the model or checkpoint", async () => {
    const outcome = await run({ snapshot: (config, input) => ({ url: input.url ?? booking, text: "Public booking", controls: [], elements: [], frames: [],
      browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT, navigationStatus: 200, loading: false,
      requests: [], completedPublicAssetRequests: input.url === booking ? [asset(parentAsset), asset(childAsset)] : [], completedPublicAssetRequestsOverflow: false }) });
    expect(outcome.result.outcome).toBe("activated");
    expect(outcome.client.candidate.mock.calls[0][2].permittedRoutes).toContainEqual(routeOf(parentAsset));
    expect(outcome.client.candidate.mock.calls[0][2].permittedRoutes).toContainEqual(routeOf(childAsset));
    for (const value of [...outcome.replies, ...outcome.checkpoints]) expect(JSON.stringify(value)).not.toContain("completedPublicAssetRequests");
  });
  it("does not let compatibility request rows override sticky private-channel overflow", async () => {
    const outcome = await run({ snapshot: (config, input) => ({ url: input.url ?? booking,
      browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT, navigationStatus: 200,
      requests: [asset()], completedPublicAssetRequests: [], completedPublicAssetRequestsOverflow: true }) });
    expect(outcome.validateRecipe).not.toHaveBeenCalled(); expect(outcome.client.candidate).not.toHaveBeenCalled();
    expect(outcome.executeRecipe).not.toHaveBeenCalled(); expect(JSON.stringify(outcome.replies)).toContain("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
  });
  it.each(["BROWSER_JSON", "BROWSER_DOM"])("enriches a %s omission-shaped proposal identically for validation, candidate and both replays", async engine => {
    const outcome = await run({ engine });
    expect(outcome.result.outcome).toBe("activated");
    const saved = outcome.client.candidate.mock.calls[0][2];
    expect(saved.permittedRoutes).toHaveLength(3);
    expect(saved.permittedRoutes).toContainEqual(routeOf(parentAsset)); expect(saved.permittedRoutes).toContainEqual(routeOf(childAsset));
    expect(outcome.validateRecipe.mock.calls.at(-1)[0].recipe).toEqual(saved);
    expect(outcome.executeRecipe).toHaveBeenCalledTimes(2);
    for (const [args] of outcome.executeRecipe.mock.calls) expect(args.recipe).toEqual(saved);
    expect(saved.browserTransport).toBe(transport);
    expect(outcome.checkpoints.every(value => !JSON.stringify(value).includes("client:platform") && !JSON.stringify(value).includes("abc-static"))).toBe(true);
  });

  it.each(["finish", "replay failure", "fallback"])("does not inherit old assets after %s", async mode => {
    const actions = [open(official), open(booking), ...(mode === "finish" ? [finish] : mode === "replay failure" ? [propose()] : []), open(booking), propose()];
    let bookingOpens = 0;
    const outcome = await run({ actions, replayFailure: mode === "replay failure", snapshot: (config, input, index) => {
      if (input.url === booking) bookingOpens++;
      return { url: input.url ?? booking, browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT,
        navigationStatus: mode === "fallback" && bookingOpens === 2 && index === 0 ? 403 : 200,
        accessRequirementObserved: false, requests: [], completedPublicAssetRequests: index === 0 && bookingOpens === 1 ? [asset()] : [],
        completedPublicAssetRequestsOverflow: false };
    } });
    const candidates = outcome.client.candidate.mock.calls;
    expect(candidates.at(-1)[2].permittedRoutes).toEqual(proposal().permittedRoutes);
    expect(outcome.browsers).toHaveLength(2);
    expect(outcome.closed).toContain(0);
  });

  it("ignores checkpoint asset-looking fields and never enriches without current transport proof", async () => {
    const outcome = await run({ checkpoint: { controller: { version: 1, officialUrl: official, observedNavigationUrls: [booking],
      browserTransport: transport, publicAssetRoutes: [routeOf(parentAsset)] } }, snapshot: (_config, input) => ({ url: input.url, requests: [asset()] }) });
    expect(outcome.client.candidate).not.toHaveBeenCalled(); expect(outcome.client.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.replies)).toContain("DISCOVERY_BROWSER_TRANSPORT_UNVERIFIED");
    expect(outcome.validateRecipe.mock.calls.at(-1)[0].recipe.permittedRoutes).toEqual(proposal().permittedRoutes);
  });

  it("rejects overflow before validation, candidate persistence or either replay", async () => {
    const outcome = await run({ snapshot: (config, input) => ({ url: input.url, browserTransport: config.helperEnvironment.COURSE_DISCOVERY_BROWSER_TRANSPORT,
      navigationStatus: 200, requests: Array.from({ length: 129 }, (_, i) => asset(`https://cdn.example.org/chunk-${i}.js`)) }) });
    expect(outcome.validateRecipe).not.toHaveBeenCalled(); expect(outcome.client.candidate).not.toHaveBeenCalled();
    expect(outcome.executeRecipe).not.toHaveBeenCalled(); expect(JSON.stringify(outcome.replies)).toContain("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
  });
});

describe("private completed asset channel", () => {
  it.each(["count", "bytes", "malformed"])("rejects a private-channel %s overflow without compatibility fallback", kind => {
    const inventory = createDiscoveryPublicAssetInventory(), browser = {};
    inventory.begin(browser, transport);
    const completedPublicAssetRequests = kind === "count" ? Array.from({ length: 129 }, (_, index) => asset(`https://cdn.example.org/chunk-${index}.js`)) :
      kind === "bytes" ? Array.from({ length: 80 }, (_, index) => asset(`https://cdn.example.org/${"a".repeat(850)}${index}.js`)) : {};
    inventory.observe(browser, { browserTransport: transport, requests: [asset()], completedPublicAssetRequests });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
  });
  it("does not transfer private deltas across browser owners or transport changes", () => {
    const inventory = createDiscoveryPublicAssetInventory(), browser = {}, other = {};
    inventory.begin(browser, transport);
    inventory.observe(other, { browserTransport: transport, requests: [], completedPublicAssetRequests: [asset()] });
    expect(inventory.enrich(proposal(), browser, transport)).toBeDefined();
    expect(inventory.enrich(proposal(), browser, transport).permittedRoutes).toHaveLength(1);
    inventory.observe(browser, { browserTransport: "PINNED_HTTP", requests: [], completedPublicAssetRequests: [asset()] });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
  });
  it.each(["ordinary", "no-text", "structure", "adapter", "response", "unchanged"])("strips private metadata before the compactor %s return", kind => {
    const compact = createDiscoverySnapshotCompactor();
    const base = { url: booking, text: "Public page", controls: [], elements: [], frames: [], loading: false, requests: [] };
    if (kind === "unchanged") { compact(base); compact(base); }
    const snapshot = { ...base, ...(kind === "no-text" ? { text: undefined } : {}),
      ...(kind === "structure" ? { structure: { selected: "#public" } } : {}), ...(kind === "adapter" ? { adapter: { family: "EXAMPLE" } } : {}),
      ...(kind === "response" ? { responses: [{ status: 200 }] } : {}),
      completedPublicAssetRequests: [asset("https://cdn.example.org/site.js?build=private-channel-sentinel")], completedPublicAssetRequestsOverflow: true };
    const result = compact(snapshot);
    expect(result).not.toHaveProperty("completedPublicAssetRequests"); expect(result).not.toHaveProperty("completedPublicAssetRequestsOverflow");
    expect(JSON.stringify(result)).not.toContain("private-channel-sentinel"); expect(snapshot.completedPublicAssetRequests).toHaveLength(1);
  });
  it("accumulates private completed deltas, ignores uncompleted kinds and keeps overflow sticky until a new owner", () => {
    const inventory = createDiscoveryPublicAssetInventory(), browser = {};
    inventory.begin(browser, transport);
    inventory.observe(browser, { browserTransport: transport, requests: [], completedPublicAssetRequests: [asset(), asset(childAsset)] });
    inventory.observe(browser, { browserTransport: transport, requests: [], completedPublicAssetRequests: [asset("https://cdn.example.org/pending.js", { status: undefined }),
      asset("https://cdn.example.org/redirect.js", { status: 302 }), asset("https://cdn.example.org/failed.js", { status: 500 }),
      asset("https://cdn.example.org/blocked.js", { blockedReason: "UNSAFE_URL" }), asset("https://cdn.example.org/data", { resourceType: "fetch" })] });
    expect(inventory.enrich(proposal(), browser, transport).permittedRoutes).toHaveLength(3);
    inventory.observe(browser, { browserTransport: transport, requests: [], completedPublicAssetRequests: [], completedPublicAssetRequestsOverflow: true });
    inventory.observe(browser, { browserTransport: transport, requests: [asset()], completedPublicAssetRequestsOverflow: false });
    expect(() => inventory.enrich(proposal(), browser, transport)).toThrow("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
    inventory.begin(browser, transport); expect(inventory.enrich(proposal(), browser, transport).permittedRoutes).toHaveLength(1);
  });
});
