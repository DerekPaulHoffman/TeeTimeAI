// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import { inspectMindbodyPublicRentalCatalog, type MindbodyCatalogEvidence } from "./mindbody-appointment-grid";
import { executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { accessExecutionDiagnosticSchema, parseAccessRecipe } from "./recipe";
import type { ExistingAdapterRecipe } from "./existing-adapter-schema";
import { discoveryReplayDetails, readDiscoveryControllerCheckpoint, discoveryRecipeExecutionBudgetMs, executeDiscoveryRecipe } from "../../../scripts/automation/course-discovery-worker.mjs";

const code = "MINDBODY_NATIVE_CAPTURE_FAILURE";
const facts = () => ({ stage: "WAIT_GRID", elapsedMs: 13235, pendingReads: 31, nativeDocumentCurrent: true, rawBytes: 209217,
  rawBodyClosed: true, rawHtmlClosed: true, readyState: "loading", timeOriginFinite: true });
function feedback(value: unknown) {
  return discoveryReplayDetails({ status: "INCOMPLETE", complete: false, slots: [], evidence: {
    reason: "MINDBODY_PUBLIC_GRID_UNAVAILABLE", diagnostic: { code, mindbodyReplay: value } } });
}
afterEach(() => vi.useRealTimers());
describe("closed native Mindbody replay diagnostics", () => {
  it("retains actual reader error facts before cleanup through the executor, worker receipt and checkpoint without changing proof", async () => {
    const catalog: MindbodyCatalogEvidence = { ...structuredClone(observed.catalogObserved), captureId: "fixed-capture",
      category: { ...observed.catalogObserved.category, enabled: true, selected: true }, service: { ...observed.catalogObserved.service, enabled: true, selected: true },
      resources: observed.catalogObserved.resources.map(row => ({ ...row, enabled: true })) };
    const adapter = inspectMindbodyPublicRentalCatalog(observed.source, catalog).metadata;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "canonical", offeringId: "rental", kind: "SIMULATOR" },
      source: { ...observed.source, providerFamily: "MINDBODY" }, adapter }) as ExistingAdapterRecipe;
    const captured = { ...facts(), token: "PRIVATE_TOKEN", url: "https://private.example/", rawHtml: "PRIVATE_HTML" }, primary = new Error("MINDBODY_PUBLIC_GRID_UNAVAILABLE");
    const close = vi.fn(async () => { captured.pendingReads = 0; throw new Error("PRIVATE_CLEANUP"); });
    const result = await executeExistingAdapterRecipe(recipe, observed.input, { now: () => new Date("2026-10-23T00:00:00Z"),
      recipeHash: "a".repeat(64), venueMatches: venueProofMatches, toInstant: recipeTimeToInstant, localCapabilities: ["LOCAL_CHROME"],
      createMindbodySession: async () => ({ execute: async () => ({ navigationStatus: 200 }), readMindbodyPublicCatalog: async () => catalog,
        readMindbodyPublicGrid: async () => { throw primary; }, diagnostics: () => ({ mindbodyCapture: captured }), close }) });
    expect(close).toHaveBeenCalledOnce(); expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: {
      reason: primary.message, venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false,
      diagnostic: { code, mindbodyReplay: facts() } } });
    const projected = discoveryReplayDetails(result), restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://official.example/",
      observedNavigationUrls: [], lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: projected } } }, "https://official.example/");
    expect(restored.lastFailure.details.diagnostic.mindbodyReplay).toEqual(facts());
    expect(JSON.stringify(restored)).not.toMatch(/PRIVATE|private.example|"rawHtml":|"token":/u);
  });
  it("accepts every enum and optional field boundary equally in schema and actual worker projection", () => {
    const stages = ["IDLE", "WAIT_DOCUMENT", "WAIT_RENDERED", "RAW_CATALOG", "RENDERED_CATALOG", "COMPARE_CATALOG", "CATALOG_READY", "FILTER_SETTLEMENT",
      "WAIT_GRID", "WAIT_GRID_RENDERED", "RAW_GRID", "GRID_READY", "DAY_FORM", "BROWSE_LOCATE", "BROWSE_VALIDATE", "BROWSE_ACTION", "BROWSE_DONE", "DAY_ACTION"];
    const values = [...stages.map(stage => ({ stage })), ...["loading", "interactive", "complete", "UNKNOWN"].map(readyState => ({ ...facts(), readyState })),
      { ...facts(), elapsedMs: 180000, pendingReads: 2048, rawBytes: 4000000, renderedBytes: 4000000, renderedBodyClosed: true, renderedHtmlClosed: false,
        timeOriginChangedFromPrior: true, timeOriginMatchesAccepted: false }];
    for (const value of values) { expect(accessExecutionDiagnosticSchema.safeParse({ code, mindbodyReplay: value }).success).toBe(true);
      expect(feedback(value).diagnostic.mindbodyReplay).toEqual(value); }
  });
  it("requires the fixed native diagnostic code rather than attaching facts to another provider failure", () => {
    const diagnostic = { code: "HTTP_ERROR", mindbodyReplay: facts() };
    expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
    const result = discoveryReplayDetails({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "HTTP_ERROR", diagnostic } });
    expect(result.diagnostic).toEqual({ code: "HTTP_ERROR" }); expect(result.reason).toBe("HTTP_ERROR");
  });
  it.each([null, [], "PRIVATE_SENTINEL", {}, { ...facts(), stage: "PRIVATE_SENTINEL" }, { ...facts(), pendingReads: -1 },
    { ...facts(), pendingReads: 2049 }, { ...facts(), pendingReads: 1.5 }, { ...facts(), elapsedMs: 180001 }, { ...facts(), rawBytes: 4000001 },
    { ...facts(), readyState: "PRIVATE_SENTINEL" }, { ...facts(), nativeDocumentCurrent: "true" }, { ...facts(), token: "PRIVATE_SENTINEL" }])(
    "rejects malformed facts without erasing the original reason or inventing proof (%j)", value => {
      expect(accessExecutionDiagnosticSchema.safeParse({ code, mindbodyReplay: value }).success).toBe(false);
      const projected = feedback(value); expect(projected.reason).toBe("MINDBODY_PUBLIC_GRID_UNAVAILABLE"); expect(projected.complete).toBe(false);
      expect(projected.diagnostic.code).toBe(code); expect(projected.diagnostic).not.toHaveProperty("mindbodyReplay");
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_SENTINEL");
    });
});

describe("typed Mindbody execution process budget", () => {
  it("uses135s only for existing MINDBODY and keeps all other engines/providers at90s", () => {
    expect(discoveryRecipeExecutionBudgetMs({ engine: "EXISTING_ADAPTER", adapter: { family: "MINDBODY" } })).toBe(135000);
    for (const recipe of [{}, { engine: "BROWSER_DOM", adapter: { family: "MINDBODY" } }, { engine: "EXISTING_ADAPTER", adapter: { family: "CPS" } },
      { engine: "EXISTING_ADAPTER", adapter: { family: "mindbody" } }]) expect(discoveryRecipeExecutionBudgetMs(recipe)).toBe(90000);
  });
  it.each([135000, 70000])("actual child timeout is min(provider budget, unchanged caller deadline): %s", async maximum => {
    vi.useFakeTimers(); const at = Date.now(), child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
    const controller = new AbortController(), deadlineAt = new Date(at + maximum).toISOString();
    const result = executeDiscoveryRecipe({ cwd: ".", recipe: { engine: "EXISTING_ADAPTER", adapter: { family: "MINDBODY" } }, input: {},
      deadlineAt, signal: controller.signal, spawnProcess: () => child });
    const outcome = result.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(maximum - 1);
    let settled = false; void result.then(() => { settled = true; }, () => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await outcome).toMatchObject({ code: "DISCOVERY_EXECUTION_TIMEOUT" });
    expect(deadlineAt).toBe(new Date(at + maximum).toISOString()); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
  it("already aborted or expired callers never spawn a child", async () => {
    const spawnProcess = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(executeDiscoveryRecipe({ cwd: ".", recipe: {}, input: {}, deadlineAt: new Date(Date.now() + 180000).toISOString(), signal: controller.signal, spawnProcess })).rejects.toMatchObject({ code: "DISCOVERY_CANCELLED" });
    await expect(executeDiscoveryRecipe({ cwd: ".", recipe: {}, input: {}, deadlineAt: new Date(Date.now() - 1).toISOString(), spawnProcess })).rejects.toMatchObject({ code: "DISCOVERY_DEADLINE" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("caller cancellation still interrupts the longer Mindbody child before its timeout", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
    const controller = new AbortController(), pending = executeDiscoveryRecipe({ cwd: ".", recipe: { engine: "EXISTING_ADAPTER", adapter: { family: "MINDBODY" } },
      input: {}, deadlineAt: new Date(Date.now() + 180000).toISOString(), signal: controller.signal, spawnProcess: () => child });
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: "DISCOVERY_CANCELLED" });
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
});
