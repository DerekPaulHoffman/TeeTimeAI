// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryAdapterObservation, createDiscoverySnapshotCompactor, createDiscoveryToolTrace, DISCOVERY_GENERIC_LIMITS, fillCurrentInspectedAdapter, inspectedAdapterSourceEvidence, safeFixedInspectionSourceDiagnostic } from "../../../scripts/automation/course-discovery-worker.mjs";
import { DISCOVERY_MODEL_SNAPSHOT_BYTES, DISCOVERY_MODEL_SNAPSHOT_HARD_BYTES, previewDiscoverySnapshot, selectDiscoveryRecipeSchema } from "../../../scripts/automation/course-discovery-prompt-schema.mjs";
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
  it("records only closed reply metadata with exact UTF8 bytes, omission and selected engine", () => {
    const trace = createDiscoveryToolTrace(), payload = JSON.stringify({ modelPreview: { kind: "BOUNDED_MODEL_ONLY_PREVIEW" }, text: "é😀 PRIVATE_BODY" });
    trace.record("discovery_browser", { action: "observe", url: "https://private.example/?token=SECRET", selector: "PRIVATE_SELECTOR" }, "SUCCESS", undefined, payload);
    trace.record("discovery_recipe_schema", { engine: "BROWSER_DOM", family: "PRIVATE_FAMILY" }, "SUCCESS", undefined, '{"schema":{}}');
    trace.record("discovery_browser", { action: "inspect", selector: "PRIVATE_SELECTOR" }, "ERROR", "STALE_OR_UNKNOWN_ELEMENT", '{"error":"STALE_OR_UNKNOWN_ELEMENT","details":"PRIVATE_DETAIL"}');
    expect(trace.snapshot()).toEqual({ lostEntries: 0, entries: [
      { action: "BROWSER_OBSERVE", status: "SUCCESS", modelPreviewBytes: Buffer.byteLength(payload), previewOmitted: true },
      { action: "SCHEMA", status: "SUCCESS", modelPreviewBytes: 13, previewOmitted: false, schemaEngine: "BROWSER_DOM" },
      { action: "BROWSER_INSPECT", status: "ERROR", errorCode: "STALE_OR_UNKNOWN_ELEMENT", modelPreviewBytes: 63, previewOmitted: false },
    ] });
    expect(JSON.stringify(trace.snapshot())).not.toMatch(/PRIVATE|SECRET|https|selector|token|body/iu);
    const copied = trace.snapshot(); copied.entries[0].action = "PRIVATE_MUTATION";
    expect(trace.snapshot().entries[0].action).toBe("BROWSER_OBSERVE");
  });
  it("bounds trace entries and counts lost replies without retaining unknown errors, actions or schema values", () => {
    const trace = createDiscoveryToolTrace();
    for (let index = 0; index < 11; index++) trace.record("PRIVATE_TOOL", { action: "PRIVATE_ACTION", engine: "PRIVATE_ENGINE" }, "PRIVATE_STATUS", "PRIVATE_ERROR");
    expect(trace.snapshot().lostEntries).toBe(3); expect(trace.snapshot().entries).toHaveLength(8);
    expect(trace.snapshot().entries[0]).toEqual({ action: "UNKNOWN_TOOL", status: "NO_REPLY", errorCode: "OTHER_TOOL_ERROR", modelPreviewBytes: 0, previewOmitted: false });
    expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE");
  });
  it("projects only the three precise inspect-stale conjunct reasons", () => {
    for (const staleControlReason of ["ELEMENT_NOT_OBSERVED", "CONTROL_NOT_RENDERED", "CONTROL_SIGNATURE_CHANGED"])
      expect(safeFixedInspectionSourceDiagnostic({ staleControlReason, selector: "PRIVATE", body: "PRIVATE" })).toEqual({ staleControlReason });
    expect(safeFixedInspectionSourceDiagnostic({ staleControlReason: "PRIVATE_ERROR" })).toBeUndefined();
  });
  it("bounds a full public response packet while preserving every opaque target, useful player options and original private data", () => {
    const original = bigSnapshot(), before = JSON.stringify(original), compact = createDiscoverySnapshotCompactor()(original);
    expect(bytes(original)).toBeGreaterThan(280_000); expect(bytes(compact)).toBeLessThan(10_000);
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
    // Catalogs may now be omitted entirely to keep action context small. Neither
    // an omitted catalog nor a structurally valid prefix earns source proof.
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
    expect(DISCOVERY_MODEL_SNAPSHOT_BYTES).toBe(8_000);
    expect(DISCOVERY_GENERIC_LIMITS).toEqual({ toolOperations: 8, totalTokens: 128_000, uncachedInputTokens: 32_000, outputTokens: 8_192 });
  });

  it.each([7, 8])("cuts a %i-reply discovery sequence below half its former context without changing current controls or private evidence", count => {
    const source = Array.from({ length: count }, (_, index) => ({ url: "https://context-fixture.example/public-times",
      navigationStatus: 200, browserTransport: "NATIVE_CHROME", loading: false, pendingRequestCount: 0, accessRequirementObserved: false,
      text: ("Published public date/player controls and availability rows. ").repeat(285),
      controls: [{ ...controls(1)[0], kind: "input", tag: "input", name: "Date", readOnly: true, currentValue: "2030-01-02" }, controls()[179]],
      responses: [{ status: 200, method: "GET", body: { date: "2030-01-02", players: 2, complete: true,
        slots: [{ start: "10:00", spots: 4, publicRow: index }] } }] }));
    const before = JSON.stringify(source), views = source.map(previewDiscoverySnapshot);
    expect(source.every(s => bytes(s) > 16_000 && bytes(s) <= 24_000)).toBe(true); // Previously returned unchanged.
    expect(views.every(s => bytes(s) <= 8_000)).toBe(true);
    expect(views.reduce((sum, s) => sum + bytes(s), 0)).toBeLessThan(source.reduce((sum, s) => sum + bytes(s), 0) / 2);
    for (const [index, view] of views.entries()) {
      expect(Object.keys(view.controlTargets)).toEqual(source[index].controls.map(c => c.target));
      expect(view.controls).toContainEqual(source[index].controls[0]); expect(view.controls).toContainEqual(source[index].controls[1]);
      expect(view).toMatchObject({ loading: false, pendingRequestCount: 0, navigationStatus: 200, accessRequirementObserved: false,
        modelPreview: { isAvailabilityEvidence: false } });
    }
    expect(JSON.stringify(source)).toBe(before); expect(source[0].responses[0].body.slots).toHaveLength(1);
  });

  it("bounds model-only error feedback while retaining the failure code and full private diagnostic", () => {
    const original = { error: "UNOBSERVED_NAVIGATION", details: { action: "inspect_adapter", failure: { code: "UNOBSERVED_NAVIGATION" },
      loading: false, pendingRequestCount: 0, officialSourceDiagnostic: { sourceContextValid: true, currentOfficialDocument: false },
      nativeRejectedRequests: Array.from({ length: 20 }, () => ({ code: "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED", operation: "REQUEST_METADATA", method: "GET", resourceType: "Image", publicExplanation: "Public resource diagnostic ".repeat(25) })) } };
    const before = JSON.stringify(original), view = previewDiscoverySnapshot(original);
    expect(bytes(original)).toBeGreaterThan(8_000); expect(bytes(view)).toBeLessThanOrEqual(8_000);
    expect(view).toMatchObject({ error: original.error, details: { failure: { code: original.error }, officialSourceDiagnostic: { currentOfficialDocument: false } },
      modelPreview: { isAvailabilityEvidence: false } });
    expect(JSON.stringify(original)).toBe(before); expect(original.details.nativeRejectedRequests).toHaveLength(20);
  });

  it.each(["😀", "\\\"\n"])("never lets 180 long target IDs and twelve option-rich filters raise the hard ceiling (%j)", text => {
    const richControls = controls().map((control, index) => ({ ...control,
      target: `${"a".repeat(70)}${String(index).padStart(10, "0")}`,
      ...(index < 12 ? { kind: "select", tag: "select", name: text.repeat(200), label: text.repeat(200),
        options: Array.from({ length: 8 }, (_, option) => ({ value: String(option) + text.repeat(199), label: text.repeat(200) })),
        ...Object.fromEntries(Array.from({ length: 24 }, (_, key) => [`extra${key}`, text.repeat(2000)])) } : {}) }));
    const original = { ...bigSnapshot(), controls: richControls, error: "DISCOVERY_REPLAY_INCOMPLETE", browserSessionClosed: true,
      hint: "Independent replay closed the discovery browser. Open an already observed public URL to obtain fresh controls before correcting the recipe; the original deadline is unchanged.",
      continuation: "Preserve canonical identity and inspect fresh observed public evidence. Missing proof stays incomplete." };
    const before = JSON.stringify(original), view = previewDiscoverySnapshot(original);
    expect(bytes(view)).toBeLessThanOrEqual(24_000); expect(DISCOVERY_MODEL_SNAPSHOT_HARD_BYTES).toBe(24_000);
    expect(view.modelPreview.budgetUtf8Bytes).toBeLessThanOrEqual(24_000);
    expect(bytes(view)).toBeLessThanOrEqual(view.modelPreview.budgetUtf8Bytes);
    expect(view.modelPreview.requiredCatalogFloorBytes).toBeGreaterThan(8_000);
    expect(view.modelPreview.requiredCatalogFloorBytes).toBeLessThan(18_000);
    expect(Object.keys(view.controlTargets)).toEqual(original.controls.map(control => control.target));
    expect(view).toMatchObject({ error: original.error, browserSessionClosed: true, hint: original.hint, continuation: original.continuation,
      loading: false, pendingRequestCount: 0, navigationStatus: 200, modelPreview: { isAvailabilityEvidence: false } });
    const plain = previewDiscoverySnapshot({ ...original, controls: richControls.map(control => ({ target: control.target, kind: "select", name: "Public filter" })) });
    expect(Math.abs(view.modelPreview.requiredCatalogFloorBytes - plain.modelPreview.requiredCatalogFloorBytes)).toBeLessThan(16);
    expect(JSON.stringify(original)).toBe(before); expect(original.controls[0].options).toHaveLength(8);
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
