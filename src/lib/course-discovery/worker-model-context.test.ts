// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor, DISCOVERY_GENERIC_LIMITS, fillCurrentInspectedAdapter, inspectedAdapterSourceEvidence } from "../../../scripts/automation/course-discovery-worker.mjs";
import { previewDiscoverySnapshot, selectDiscoveryRecipeSchema } from "../../../scripts/automation/course-discovery-prompt-schema.mjs";
import { AMELIA_CLIENT_HASHES, ameliaMetadataSchema } from "./amelia-source";
import { executeAccessRecipe, type AccessExecutorDependencies } from "./executor";
import { parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const controls = (count = 180) => Array.from({ length: count }, (_, i) => ({
  target: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, selector: `.control-${i}`, tag: i === 179 ? "select" : "button",
  name: i === 179 ? "Players" : `Public choice ${i}`, label: i === 179 ? "Players" : "Public choice", filterPurpose: i === 179 ? "PLAYERS" : undefined,
  options: i === 179 ? [{ value: "1", label: "1 Player" }, { value: "2", label: "2 Players" }, { value: "3", label: "3 Players" }, { value: "4", label: "4 Players" }] : undefined,
}));
const bigSnapshot = () => ({ url: "https://context-fixture.example/tee-times", navigationStatus: 200, browserTransport: "NATIVE_CHROME",
  loading: false, pendingRequestCount: 0, text: "Public fixture availability ".repeat(580), controls: controls(),
  elements: Array.from({ length: 100 }, (_, i) => ({ selector: `.row-${i}`, text: "Public row ".repeat(30) })),
  responses: Array.from({ length: 12 }, (_, i) => ({ url: `https://context-fixture.example/day-${i}`, status: 200, method: "GET",
    body: { complete: true, rows: Array.from({ length: 45 }, (_, j) => ({ publicLabel: "Public rental ".repeat(30), start: "10:00", spots: 4, index: j })) } })),
});

describe("model-only discovery context bounds", () => {
  it("bounds a full public response packet while preserving every opaque target, useful player options and original private data", () => {
    const original = bigSnapshot(), before = JSON.stringify(original), compact = createDiscoverySnapshotCompactor()(original);
    expect(bytes(original)).toBeGreaterThan(280_000); expect(bytes(compact)).toBeLessThanOrEqual(24_000);
    expect(compact.modelPreview).toMatchObject({ kind: "BOUNDED_MODEL_ONLY_PREVIEW", isAvailabilityEvidence: false, originalUtf8Bytes: bytes(original) });
    expect(compact.modelPreview.truncations.length).toBeGreaterThan(0);
    expect(Object.keys(compact.controlTargets)).toEqual(original.controls.map(control => control.target));
    expect(compact.controls).toContainEqual(expect.objectContaining({ target: original.controls[179].target, selector: ".control-179",
      name: "Players", options: original.controls[179].options }));
    expect(JSON.stringify(original)).toBe(before); expect(original.responses[11].body.rows).toHaveLength(45);
  });

  it("keeps small exact observations and targeted inspect structures unchanged", () => {
    const small = { text: "Public golf", controls: controls(2), responses: [{ body: { date: "2030-01-02", complete: true, rows: [] } }] };
    expect(previewDiscoverySnapshot(small)).toBe(small);
    const inspection = { structure: { selector: ".players", controls: controls().slice(179), children: [{ text: "3 Players", selector: ".player-3" }] } };
    expect(previewDiscoverySnapshot(inspection)).toBe(inspection);
  });

  it("keeps the private native routing chain out of both small and bounded model snapshots", () => {
    for (const original of [{ text: "Public page", controls: controls(2) }, bigSnapshot()]) {
      const source = { ...original, nativeRoutingDocumentRedirects: [{ source: "PRIVATE_ROUTING_CHAIN" }],
        nativeDocumentRedirects: [{ source: "PRIVATE_ROUTING_CHAIN" }] };
      const view = createDiscoverySnapshotCompactor()(source);
      expect(view).not.toHaveProperty("nativeRoutingDocumentRedirects");
      expect(view).not.toHaveProperty("nativeDocumentRedirects"); expect(JSON.stringify(view)).not.toContain("PRIVATE_ROUTING_CHAIN");
      expect(source.nativeRoutingDocumentRedirects).toHaveLength(1);
    }
  });

  it.each(["😀", "\\\"\n", "é"])("enforces the final serialized UTF8 bound for escaped or multibyte data %j", value => {
    const original = bigSnapshot();
    original.text = value.repeat(20_000);
    original.controls.forEach(control => { control.name = value.repeat(200); control.label = value.repeat(200); });
    const compact = previewDiscoverySnapshot(original);
    expect(bytes(compact)).toBeLessThanOrEqual(24_000);
    expect(Object.keys(compact.controlTargets)).toEqual(original.controls.map(control => control.target));
    expect(compact.modelPreview.isAvailabilityEvidence).toBe(false);
  });

  it("leaves exact inspected adapter metadata intact when an unrelated public response needs sampling", () => {
    const original = { ...bigSnapshot(), adapter: { family: "EXAMPLE", courseId: 73, catalogHash: "a".repeat(64), supportedPlayers: [1, 2, 3, 4] } };
    expect(previewDiscoverySnapshot(original).adapter).toEqual(original.adapter);
  });

  it("fails closed when a large legitimate adapter catalog is only sampled, without rehydrating omitted metadata", () => {
    const adapter = ameliaMetadataSchema.parse({ family: "AMELIA", apiUrl: "https://context-fixture.example/api", timeZone: "America/New_York",
      shortcode: { form: "sbsNew", counter: "1000", category: null, service: null, employee: null, location: null, package: null },
      settings: { timeZone: "America/New_York", showClientTimeZone: true, slotLengthSeconds: 1800, startOfWeek: 0,
        bringingAnyoneLogic: "additional", bookMultipleTimes: false, employeeSelection: "random", isGloballyBusySlot: false },
      ...Object.fromEntries(["public", "step", "event"].flatMap(kind => [[`${kind}ClientUrl`, `https://context-fixture.example/${kind}.js`],
        [`${kind}ClientSha256`, AMELIA_CLIENT_HASHES[kind as keyof typeof AMELIA_CLIENT_HASHES]]])),
      services: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, name: "Public golf simulator ".repeat(9), durationSeconds: 3600,
        timeBeforeSeconds: 0, timeAfterSeconds: 0, minCapacity: 1, maxCapacity: 4, bringingAnyone: true, aggregatedPrice: false,
        hasDurationExtras: false, providerIds: [1] })), providers: [{ id: 1, serviceIds: Array.from({ length: 40 }, (_, index) => index + 1) }],
      catalogHash: "a".repeat(64) });
    expect(bytes(adapter)).toBeGreaterThan(8_000);
    const original = { ...bigSnapshot(), adapter }, before = JSON.stringify(original), view = previewDiscoverySnapshot(original);
    expect(bytes(view)).toBeLessThanOrEqual(24_000); expect(view.adapter).not.toEqual(adapter);
    expect(view.modelPreview.isAvailabilityEvidence).toBe(false);
    // A prefix can still satisfy the structural schema. Exact fresh observation
    // equality below must reject it instead of treating that as source proof.
    expect(ameliaMetadataSchema.safeParse(view.adapter).success).toBe(true);
    const job = { id: "large-catalog", request: { identity: { officialUrl: original.url }, target: { courseId: "fixture", kind: "SIMULATOR" }, input: {} } };
    const observation = createDiscoveryAdapterObservation(job, original.url, adapter, original.url);
    const recipe = { engine: "EXISTING_ADAPTER", source: { bookingUrl: original.url }, adapter };
    expect(inspectedAdapterSourceEvidence(recipe, job, observation, true, original.url)).toBeDefined();
    expect(inspectedAdapterSourceEvidence({ ...recipe, adapter: view.adapter }, job, observation, true, original.url)).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before); expect(observation.adapter).toEqual(adapter);
  });

  it("copies only exact owned current inspection data and rejects stale, foreign, overridden or uploaded references", () => {
    const adapter = { family: "AMELIA", services: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: "Public simulator ".repeat(20) })) };
    const job = { id: "owned-inspection", leaseToken: "lease", sourceFingerprint: "a".repeat(64), attempts: 1,
      firstPickedUpAt: "2030-01-01T12:00:00Z", deadlineAt: "2030-01-01T12:15:00Z",
      request: { identity: { officialUrl: "https://context-fixture.example/" }, target: { kind: "SIMULATOR", courseId: "fixture" }, input: { players: 2 } } };
    const context = "https://context-fixture.example/book", owner = {};
    const observation = createDiscoveryAdapterObservation(job, context, adapter, context, undefined, owner);
    const proposal = { engine: "EXISTING_ADAPTER", source: { bookingUrl: context } };
    const fill = (recipe = proposal, currentJob = job, currentObservation = observation, currentOwner = owner, url = context, current = true, official = true) =>
      fillCurrentInspectedAdapter(recipe, currentJob, currentObservation, official, url, currentOwner, current);
    const filled = fill(); expect(filled.adapter).toEqual(adapter); expect(filled.adapter).not.toBe(observation.adapter);
    expect(proposal).not.toHaveProperty("adapter");
    for (const changed of [{ ...job, id: "foreign" }, { ...job, leaseToken: "next-lease" }, { ...job, attempts: 2 },
      { ...job, sourceFingerprint: "b".repeat(64) }, { ...job, request: { ...job.request, input: { players: 3 } } }])
      expect(() => fill(proposal, changed)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    for (const recipe of [{ ...proposal, adapter }, { ...proposal, adapter: undefined }, { ...proposal, engine: "HTTP_JSON" },
      { ...proposal, source: { bookingUrl: "https://foreign-fixture.example/" } }])
      expect(() => fill(recipe)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    expect(() => fill(proposal, job, JSON.parse(JSON.stringify(observation)))).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    expect(() => fill(proposal, job, observation, {})).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    expect(() => fill(proposal, job, observation, owner, `${context}/changed`)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    expect(() => fill(proposal, job, observation, owner, context, false)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    expect(() => fill(proposal, job, observation, owner, context, true, false)).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
    observation.adapter.services.pop(); expect(() => fill()).toThrow("DISCOVERY_CURRENT_INSPECTION_REQUIRED");
  });

  it("preserves current access/fatal/loading state through large structure, adapter and response early-return paths", () => {
    for (const extra of [{ structure: { text: "Public structure ".repeat(10_000) } }, { adapter: { family: "EXAMPLE" } }, {}]) {
      const original = { ...bigSnapshot(), ...extra, accessRequirementObserved: true, loading: true, pendingRequestCount: 3,
        nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_OWNER", rootFrame: true } };
      const view = createDiscoverySnapshotCompactor()(original);
      expect(bytes(view)).toBeLessThanOrEqual(24_000);
      expect(view).toMatchObject({ url: original.url, navigationStatus: 200, browserTransport: "NATIVE_CHROME", accessRequirementObserved: true,
        loading: true, pendingRequestCount: 3, nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_MISMATCH" } });
      expect(Object.keys(view.controlTargets)).toEqual(original.controls.map(control => control.target));
    }
  });

  it("does not change the existing operation, token or output guards", () => {
    expect(DISCOVERY_GENERIC_LIMITS).toEqual({ toolOperations: 8, totalTokens: 128_000, uncachedInputTokens: 32_000, outputTokens: 8_192 });
  });

  it("fails documentation selection closed for reference scopes or nondiscriminated schema branches", () => {
    const leaf = { type: "object", properties: { engine: { const: "BROWSER_DOM" } }, required: ["engine"] };
    for (const schema of [{ oneOf: [{ ...leaf, $ref: "#/elsewhere" }] }, { oneOf: [leaf, {}] }, { $id: "https://fixture.example/schema", oneOf: [leaf] }])
      expect(() => selectDiscoveryRecipeSchema(schema, { engine: "BROWSER_DOM" })).toThrow("DISCOVERY_PROMPT_SCHEMA_SELECTION_UNAVAILABLE");
  });
});

const input = { date: "2030-01-02", timeZone: "America/New_York", players: 2, startTime: "10:00", endTime: "20:00" };
const httpRecipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { courseId: "context-course", kind: "OUTDOOR" },
  source: { officialUrl: "https://context-fixture.example/", bookingUrl: "https://context-fixture.example/tee-times", venueName: "Context Fixture Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  permittedRoutes: [{ origin: "https://context-fixture.example", path: "/day", methods: ["GET"], queryKeys: ["date", "players"] }],
  request: { url: "https://context-fixture.example/day?date={{date}}&players={{players}}", method: "GET" },
  proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" }, players: { path: "players" } },
  slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "capacity" }, holes: { path: "holes" } } });
const fullPayload = () => ({ venue: "Context Fixture Golf", date: input.date, complete: true, empty: false, players: 2,
  slots: Array.from({ length: 100 }, (_, i) => ({ start: `${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    capacity: 4 as unknown, holes: 18, publicLabel: "Public availability description ".repeat(20) })) });
function deps(body: unknown): AccessExecutorDependencies {
  return { now: () => new Date("2030-01-01T12:00:00Z"), fetch: vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })) as typeof fetch,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }) };
}

describe("full deterministic replay remains independent from model previews", () => {
  it("rejects a malformed late original row even though sampled earlier rows look available", async () => {
    const original = fullPayload(); original.slots[99].capacity = "malformed";
    const view = previewDiscoverySnapshot({ responses: [{ body: original }] });
    expect(view.modelPreview.isAvailabilityEvidence).toBe(false);
    const failed = await executeAccessRecipe(httpRecipe(), input, deps(original));
    expect(failed.complete).toBe(false); expect(failed.status).toBe("INCOMPLETE"); expect(failed.slots).toEqual([]);
    const valid = await executeAccessRecipe(httpRecipe(), input, deps(fullPayload()));
    expect(valid.complete).toBe(true); expect(valid.status).toBe("AVAILABLE"); expect(valid.slots).toHaveLength(100);
  });

  it.each(["venue", "date", "complete", "players"])("never lets preview markers replace missing or wrong full %s evidence", async key => {
    const original = fullPayload() as Record<string, unknown>;
    if (key === "players") original.players = 3; else delete original[key];
    original.modelPreview = { kind: "BOUNDED_MODEL_ONLY_PREVIEW", venueVerified: true, dateVerified: true, complete: true, slots: 100 };
    const failed = await executeAccessRecipe(httpRecipe(), input, deps(original));
    expect(failed.complete).toBe(false); expect(failed.slots).toEqual([]);
  });

  it("does not add model preview markers to the real recipe vocabulary", () => {
    const recipe = httpRecipe();
    expect(() => parseAccessRecipe({ ...recipe, modelPreview: { complete: true } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, proof: { ...recipe.proof, complete: { modelPreview: true } } })).toThrow();
  });
});
