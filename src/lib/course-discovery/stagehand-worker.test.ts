// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as waitForFrame } from "node:timers/promises";
import { runCourseDiscoveryStagehandWorker, prepareCourseDiscoveryStagehandWorker } from "../../../scripts/automation/course-discovery-stagehand-worker.mjs";
import { createDiscoveryBrowser, createDiscoveryProcess, verifyDiscoveryCandidate, safeBrowserFailureDiagnostics,
  safeFixedInspectionSourceDiagnostic } from "../../../scripts/automation/course-discovery-worker.mjs";
import { createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandDataHash, publicStagehandSourceUrl,
  } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
import { observedInspectionPath, currentStagehandInspectionDiagnostic, inspectionReadability, safeInspectionReadability } from "../../../scripts/automation/course-discovery-stagehand-inspection.mjs";
import { stagehandNativeRouterCodes } from "./stagehand-native-router-diagnostic";
import { accessRecipeSchema } from "./recipe";
import { createStagehandGuardedBrowserHost } from "../../../scripts/automation/course-discovery-stagehand-host.mjs";
import { sourceDiscover as actualSourceDiscover } from "../../../scripts/automation/stagehand/source-discovery.mjs";
import { sourceFailureDiagnostic } from "../../../scripts/automation/stagehand/source-diagnostic.mjs";
import { readStagehandFailure } from "../../../scripts/automation/course-discovery-stagehand-failure.mjs";
import { createDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";
import { cpsOfficialEntryProofSchema } from "./cps-official-entry-proof";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";

vi.mock("node:timers/promises", async importOriginal => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

const first = Date.parse("2030-01-02T12:00:00.000Z");
const official = "https://unseen-course.example/";
const booking = "https://unseen-public-booking.example/public?view=public";
function fixture() {
  const job = { id: "owned-unseen-job", leaseToken: "private-new-owned-lease-token", sourceFingerprint: "a".repeat(64), attempts: 1,
    firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900_000).toISOString(), checkpoint: undefined as unknown,
    request: { target: { courseId: "unseen-course", kind: "OUTDOOR" }, demand: { searchId: "owned-search", alertGeneration: 1 },
      identity: { name: "Unseen Public Course", officialUrl: official, bookingUrl: "https://old-known.example/", providerFamily: "PRIVATE_HINT",
        timeZone: "UTC", address: "10 Public Road, Test City, CA 90001" },
      input: { date: "2030-01-03", timeZone: "UTC", players: 2, startTime: "08:00", endTime: "18:00" },
      trustedContext: { canonicalCoursePhone: "+15555550123" } } };
  const report = { framework: { name: "Stagehand", version: "4.3.0" }, jobId: job.id, firstPickedUpAt: job.firstPickedUpAt,
    deadlineAt: job.deadlineAt, workDeadlineAt: new Date(first + 120_000).toISOString(), startedAt: new Date(first + 100).toISOString(),
    finishedAt: new Date(first + 1500).toISOString(), frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY",
    frameworkExtractedTimes: false, outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
    adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking },
    visitedUrls: [official, booking], officialLinkLedger: [{ pageUrl: official, links: [{ href: booking }] }], frameLedger: [],
    actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: booking }, afterUrl: booking }],
    initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 },
    metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium", localCodexCalls: [
      { model: "gpt-6.1-sol", usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } },
      { model: "gpt-6.1-sol", usage: { totalTokens: 8, inputTokens: 6, outputTokens: 2 } },
    ] } };
  return { job, report, clock: first + 2000 };
}
function setup() {
  const f = fixture(), events: string[] = [], checkpoints: unknown[] = [], sourceCalls: unknown[] = [];
  const adapter = { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 };
  const environment = () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_ID: f.job.id,
    COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_LEASE_TOKEN: f.job.leaseToken, LOCAL_READER_DEVICE_TOKEN: "PRIVATE_BACKEND_TOKEN" });
  const request = vi.fn(async (action: { action: string; url?: string }) => {
    events.push(action.action);
    return { url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
      loading: false, controls: [{ kind: "link", href: booking }], adapter: action.action === "inspect_adapter" ? adapter : undefined };
  });
  const close = vi.fn(async () => { events.push("closed"); });
  const browserFactory = vi.fn(async () => ({ request, close }));
  const sourceDiscover = vi.fn(async (args: unknown) => { sourceCalls.push(args); events.push("source"); return f.report; });
  const client = {
    helperEnvironment: vi.fn(environment), checkpoint: vi.fn(async (_id, _token, value) => { checkpoints.push(structuredClone(value)); return {}; }),
    candidate: vi.fn(async (_id, _token, _recipe, _signal, _evidence) => {
      expect(_id).toBe(f.job.id); expect(_token).toBe(f.job.leaseToken); expect(_recipe).toBeTruthy(); void _signal; expect(_evidence).toBeTruthy();
      events.push("candidate"); expect(close).toHaveBeenCalled(); return { recipeHash: "b".repeat(64), challenges: [
        { id: "backend-one", recipeHash: "b".repeat(64), input: f.job.request.input },
        { id: "backend-two", recipeHash: "b".repeat(64), input: { ...f.job.request.input, date: "2030-01-04", players: 3 } },
      ] };
    }),
    verification: vi.fn(async () => { events.push("verification"); return {}; }),
    activate: vi.fn(async () => { events.push("activate"); return { activated: true }; }),
  };
  const validateRecipe = vi.fn(async ({ recipe }) => ({ valid: accessRecipeSchema.safeParse(recipe).success }));
  const executeRecipe = vi.fn(async () => {
    events.push("execute"); return { status: "AVAILABLE", complete: true, slots: [], evidence: {
      venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } };
  });
  const beforeActivate = vi.fn(async () => { events.push("before"); }), afterActivate = vi.fn(async () => { events.push("after"); });
  // Any newly eligible recovery must remain hermetic. Individual recovery
  // tests supply their own verifier-backed fake; legacy tests record/reject it.
  const genericWorker = vi.fn(async options => {
    expect(options.freshOfficialStart).toBe(true); expect(options.job).toBe(f.job);
    expect(options.checkpointProvenance).not.toHaveProperty("controller");
    for (const key of ["recipe", "adapter", "sourceEvidence", "initialUrls", "trustedResumeUrls"]) expect(options).not.toHaveProperty(key);
    throw Object.assign(Error("TEST_GENERIC_HANDOFF_REJECTED"), { code: "TEST_GENERIC_HANDOFF_REJECTED" });
  });
  const run = (extra = {}) => runCourseDiscoveryStagehandWorker({ job: f.job, workDeadlineAt: new Date(first + 720_000).toISOString(),
    client, cwd: process.cwd(), now: () => f.clock, sourceDiscover, browserFactory, validateRecipe, executeRecipe, genericWorker, beforeActivate, afterActivate, ...extra });
  return { f, events, checkpoints, sourceCalls, request, close, browserFactory, sourceDiscover, client, validateRecipe, executeRecipe, genericWorker, beforeActivate, afterActivate, run };
}
function modelFailureReport(t: ReturnType<typeof setup>) {
  Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "LOCAL_MODEL_TURN_FAILED" });
  const diagnostic = sourceFailureDiagnostic({ error: Object.assign(Error("PRIVATE_PROVIDER_TEXT"), { code: "LOCAL_MODEL_TURN_FAILED" }),
    phase: "EXTRACT", report: t.f.report, cleanup: { browserClosed: true, modelClosed: true }, modelAttempts: 3,
    modelFailure: { attempt: 3, completedCalls: 2, modelTurnFailure: { turnStatus: "failed", errorCategory: "responseTooManyFailedAttempts", httpStatusCode: 429 } } });
  (t.f.report as Record<string, unknown>).sourceDiagnostic = diagnostic;
  return diagnostic!;
}
function rootWidgetReport(t: ReturnType<typeof setup>, widgetKind = "PUBLIC_FILTERS") {
  Object.assign(t.f.report, { outcome: "ROOT_WIDGET_PROPOSED_UNVERIFIED", decisionOrigin: "NATIVE_PUBLIC_ROOT_WIDGET", adapterSourceProposal: null,
    visitedUrls: [official], officialLinkLedger: [], frameLedger: [], actions: [], rootWidgetWitness: { kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: official,
      observedAt: t.f.report.finishedAt, documentHash: "c".repeat(64), widgetKind } });
}
function cleanUnresolvedReport(t: ReturnType<typeof setup>) {
  Object.assign(t.f.report, { schemaVersion: 1, outcome: "UNRESOLVED", adapterSourceProposal: null, methodSaved: false, methodArtifactSaved: false,
    actionAttempts: [{ status: "EXECUTED" }] });
  const diagnostic = sourceFailureDiagnostic({ phase: "EXTRACT", report: t.f.report, startedAt: first + 100,
    cleanup: { browserClosed: true, modelClosed: true }, modelAttempts: 2,
    sourceStop: { finalDecision: "UNRESOLVED", condition: "EXPLICIT_UNRESOLVED", lastActionKind: "click" },
    documentReadiness: { readyState: "complete", bodyPresent: true, mainDocumentCurrent: true, mainDocumentComplete: true,
      mainReadPending: false, pendingReads: 0, mainDocumentStatus: 200 } });
  (t.f.report as Record<string, unknown>).sourceDiagnostic = diagnostic;
  return diagnostic!;
}

describe("clean unresolved source fresh-root handoff", () => {
  it("retains only typed failure provenance and lets the generic verifier own the sole two challenges and activation", async () => {
    const t = setup(); cleanUnresolvedReport(t); const original = structuredClone(t.f.job), controller = new AbortController();
    t.client.candidate.mockImplementation(async (id, token) => {
      expect(id).toBe(original.id); expect(token).toBe(original.leaseToken);
      return { recipeHash: "b".repeat(64), challenges: [
        { id: "backend-one", recipeHash: "b".repeat(64), input: t.f.job.request.input },
        { id: "backend-two", recipeHash: "b".repeat(64), input: { ...t.f.job.request.input, date: "2030-01-04", players: 3 } },
      ] };
    });
    const genericWorker = vi.fn(async options => {
      expect(options.job).toBe(t.f.job); expect(options.job).toEqual(original); expect(options.signal).toBe(controller.signal);
      expect(options.freshOfficialStart).toBe(true); expect(options.workDeadlineAt).toBe(new Date(first + 720000).toISOString());
      expect(options.checkpointProvenance.stagehandSource).toBeUndefined(); expect(options.checkpointProvenance.controller).toBeUndefined();
      const failure = readStagehandFailure({ ...t.f.job, checkpoint: options.checkpointProvenance }, t.f.clock);
      expect(failure?.entries[0]).toMatchObject({ code: "STAGEHAND_SOURCE_UNRESOLVED", phase: "SOURCE_VALIDATION", diagnostic: { errorClass: "NONE" } });
      expect(t.client.checkpoint).toHaveBeenCalledOnce();
      const activation = await verifyDiscoveryCandidate({ client: options.client, job: options.job, recipe: { engine: "BROWSER_DOM" },
        sourceEvidence: { officialUrl: official, observedBookingUrl: booking }, executeRecipe: t.executeRecipe,
        beforeActivate: options.beforeActivate, afterActivate: () => options.afterActivate({ metrics: { modelCalls: 3 } }) });
      return { outcome: "activated", activation, metrics: { modelCalls: 3 } };
    });
    const result = await t.run({ genericWorker, signal: controller.signal });
    expect(result.metrics.genericFallback.trigger).toBe("SOURCE_UNRESOLVED_PUBLIC_DOCUMENT");
    expect(result.metrics.source.modelCalls).toBe(2); expect(result.metrics.genericFallback.worker.modelCalls).toBe(3);
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.afterActivate).toHaveBeenCalledOnce(); expect(t.f.job).toEqual(original);
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.validateRecipe).not.toHaveBeenCalled();
  });
  it.each(["schema", "access", "native", "host", "cdp", "guard", "model-failed", "action-rejected", "not-current", "pending", "incomplete", "status404", "step-limit", "wrong-phase", "unknown-field", "model-cleanup", "artifact", "witness", "foreign", "foreign-root", "stale", "source-expired", "work-expired", "aborted"])(
    "does not turn %s into generic exploration permission", async mode => {
      const t = setup(), diagnostic = cleanUnresolvedReport(t), report = t.f.report as Record<string, unknown>, controller = new AbortController();
      if (mode === "schema") report.schemaVersion = 2;
      if (mode === "access") diagnostic.httpStatus = 403;
      if (mode === "native") diagnostic.nativeRouterFailure = { code: "NATIVE_REDIRECT_LOADER_TIMEOUT" };
      if (mode === "host") diagnostic.hostGuardFailure = { stage: "SOURCE_DOM", reason: "DOM_URL_CHANGED" };
      if (mode === "cdp") diagnostic.ownedCdpFailure = { layer: "RPC", pendingRequests: 0 };
      if (mode === "guard") diagnostic.guardReason = "ACTION_TARGET_REJECTED";
      if (mode === "model-failed") { diagnostic.counts.failedModelCalls = 1; diagnostic.counts.attemptedModelCalls = 3; }
      if (mode === "action-rejected") diagnostic.counts.rejectedActions = 1;
      if (mode === "not-current") diagnostic.sourceDocumentReadiness.mainDocumentCurrent = false;
      if (mode === "pending") diagnostic.sourceDocumentReadiness.mainReadPending = true;
      if (mode === "incomplete") diagnostic.sourceDocumentReadiness.mainDocumentComplete = false;
      if (mode === "status404") diagnostic.sourceDocumentReadiness.mainDocumentStatus = 404;
      if (mode === "step-limit") diagnostic.sourceStop.condition = "STEP_LIMIT";
      if (mode === "wrong-phase") diagnostic.phase = "OBSERVE";
      if (mode === "unknown-field") diagnostic.private = "PRIVATE";
      if (mode === "model-cleanup") report.modelClosed = false;
      if (mode === "artifact") report.methodSaved = true;
      if (mode === "witness") report.rootWidgetWitness = { forged: true };
      if (mode === "foreign") report.jobId = "foreign-job";
      if (mode === "foreign-root") report.initialNavigation = { requestedUrl: "https://foreign.example/", status: 200 };
      if (mode === "stale") { report.startedAt = new Date(first - 10000).toISOString(); report.finishedAt = new Date(first - 9000).toISOString(); }
      if (mode === "source-expired") t.f.clock = first + 240000;
      if (mode === "work-expired") t.f.clock = first + 720000;
      if (mode === "aborted") controller.abort();
      const genericWorker = vi.fn(); await expect(t.run({ genericWorker, signal: controller.signal })).rejects.toBeDefined();
      expect(genericWorker).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    });
  it("keeps generic failure and its checkpoint instead of overwriting it with source failure", async () => {
    const t = setup(); cleanUnresolvedReport(t);
    const genericWorker = vi.fn(async options => {
      await options.client.checkpoint(options.job.id, options.job.leaseToken, { ...options.checkpointProvenance, controller: { officialObserved: true } });
      throw Object.assign(Error("generic failed"), { code: "DISCOVERY_TURN_FAILED", discoveryMetrics: { modelCalls: 1 } });
    });
    const failure = await t.run({ genericWorker }).catch(error => error);
    expect(failure.code).toBe("DISCOVERY_TURN_FAILED"); expect(failure.discoveryMetrics.genericFallback.worker.modelCalls).toBe(1);
    expect(t.checkpoints.at(-1)).toMatchObject({ controller: { officialObserved: true } });
    expect(t.client.checkpoint).toHaveBeenCalledTimes(2); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it.each(["DISCOVERY_NATIVE_TRANSPORT_FATAL", "DISCOVERY_GENERIC_BUDGET_EXHAUSTED"])("preserves %s and its bounded generic stop receipt through fallback", async code => {
    const t = setup(); cleanUnresolvedReport(t);
    const stop = { code, toolOperations: 1, tokenUsage: { totalTokens: 77 } };
    const failure = Object.assign(Error(code), { code, discoveryMetrics: { attemptedModelTurns: 1, completedModelTurns: 0,
      tokenUsage: { totalTokens: 77 }, genericBudget: { stop } } });
    const genericWorker = vi.fn(async options => {
      await options.client.checkpoint(options.job.id, options.job.leaseToken, { ...options.checkpointProvenance, genericGuard: stop });
      throw failure;
    });
    const actual = await t.run({ genericWorker }).catch(error => error);
    expect(actual).toBe(failure); expect(actual.code).toBe(code);
    expect(actual.discoveryMetrics.genericFallback.worker.genericBudget.stop).toEqual(stop);
    expect(t.checkpoints.at(-1)).toHaveProperty("genericGuard", stop);
    expect(genericWorker).toHaveBeenCalledOnce(); expect(t.client.activate).not.toHaveBeenCalled();
    expect(t.client.checkpoint).toHaveBeenCalledTimes(2);
  });
  it("does not hand off after provenance checkpoint loses the original lease", async () => {
    const t = setup(); cleanUnresolvedReport(t); const genericWorker = vi.fn();
    t.client.checkpoint.mockRejectedValue(Object.assign(Error("lease rejected"), { code: "DISCOVERY_LEASE_REJECTED" }));
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_LEASE_REJECTED" });
    expect(genericWorker).not.toHaveBeenCalled(); expect(t.client.checkpoint).toHaveBeenCalledOnce(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("does not turn a generic activated label without the actual acknowledgement into success", async () => {
    const t = setup(); cleanUnresolvedReport(t);
    await expect(t.run({ genericWorker: async () => ({ outcome: "activated", metrics: {} }) })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    expect(t.client.activate).not.toHaveBeenCalled(); expect(t.afterActivate).not.toHaveBeenCalled();
  });
});

describe("clean native root widget handoff", () => {
  it.each([[false, "PUBLIC_FILTERS"], [true, "PUBLIC_FILTERS"], [false, "SERVICE_CATALOG"], [true, "SERVICE_CATALOG"]] as const)("hands only the original job and clean routing checkpoint to fresh generic discovery (resume=%s, kind=%s)", async (resumed, widgetKind) => {
    const t = setup(); rootWidgetReport(t, widgetKind);
    if (resumed) { t.f.job.checkpoint = { stagehandSource: createStagehandSourceCheckpoint(t.f.job, t.f.report) }; t.f.job.attempts = 2; }
    const original = structuredClone(t.f.job), controller = new AbortController();
    const genericWorker = vi.fn(async options => {
      expect(options.job).toBe(t.f.job); expect(options.job).toEqual(original); expect(options.signal).toBe(controller.signal);
      expect(options.freshOfficialStart).toBe(true); expect(options.workDeadlineAt).toBe(new Date(first + 720_000).toISOString());
      expect(options.checkpointProvenance.stagehandSource.report.adapterSourceProposal).toBeNull();
      expect(options.checkpointProvenance.stagehandSource.report.outcome).toBe("ROOT_WIDGET_PROPOSED_UNVERIFIED");
      await options.beforeActivate(); await options.afterActivate({ metrics: { modelCalls: 2 } });
      return { outcome: "activated", metrics: { modelCalls: 2 } };
    });
    const result = await t.run({ genericWorker, signal: controller.signal });
    expect(result.outcome).toBe("activated"); expect(genericWorker).toHaveBeenCalledOnce(); expect(t.sourceDiscover).toHaveBeenCalledTimes(resumed ? 0 : 1);
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    expect(t.afterActivate).toHaveBeenCalledOnce(); expect(result.metrics.genericFallback.trigger).toBe("ROOT_PUBLIC_WIDGET");
  });
  it.each([{ browserClosed: false }, { modelClosed: false }, { frameworkFailureCode: "STAGEHAND_GUARDED_SOURCE_REJECTED" },
    { sourceDiagnostic: { transportCode: "LOCAL_MODEL_TURN_FAILED" } }, { outcome: "UNRESOLVED", frameworkFailureCode: "STAGEHAND_GUARDED_SOURCE_REJECTED" }])
  ("never treats a failed or unclosed root source as a handoff %#", async change => {
    const t = setup(); rootWidgetReport(t); Object.assign(t.f.report, change); const genericWorker = vi.fn();
    await expect(t.run({ genericWorker })).rejects.toBeDefined(); expect(genericWorker).not.toHaveBeenCalled();
  });
  it("keeps an expired original work clock and unacknowledged activation strict", async () => {
    const expired = setup(); rootWidgetReport(expired); expired.f.clock = first + 720_000; const genericWorker = vi.fn();
    await expect(expired.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_WORK_DEADLINE" }); expect(genericWorker).not.toHaveBeenCalled();
    const t = setup(); rootWidgetReport(t);
    await expect(t.run({ genericWorker: async () => ({ outcome: "activated", metrics: {} }) })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    expect(t.client.activate).not.toHaveBeenCalled();
  });
});

describe("regular Stagehand source worker", () => {
  it("retains the initial fixed-reader rejection when a later generic budget stop replaces controller feedback", async () => {
    const t = setup(), request = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => {
      if (action.action === "inspect_adapter") throw Object.assign(Error("private provider response must not persist"), { code: "CPS_PUBLIC_BUILD_UNSUPPORTED" });
      return request(action);
    });
    const genericWorker = vi.fn(async options => {
      expect(t.checkpoints.at(-1)).toMatchObject({ stagehandProgress: { phase: "FIXED_INSPECTION_FAILED" } });
      await options.client.checkpoint(options.job.id, options.job.leaseToken, { ...options.checkpointProvenance,
        controller: { lastFailure: { code: "LATER_BROWSER_FAILURE" } }, genericGuard: { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" } });
      throw Object.assign(Error("budget stopped"), { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" });
    });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" });
    const initial = readStagehandFailure({ ...t.f.job, checkpoint: t.checkpoints.at(-1) }, t.f.clock);
    expect(initial?.entries.at(-1)).toMatchObject({ phase: "FIXED_INSPECTION", code: "CPS_PUBLIC_BUILD_UNSUPPORTED" });
    expect(JSON.stringify(initial)).not.toContain("private provider response");
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("does not start a generic investigation after the fixed-inspection checkpoint loses its lease", async () => {
    const t = setup(), request = t.request.getMockImplementation()!, save = t.client.checkpoint.getMockImplementation()!, genericWorker = vi.fn();
    t.request.mockImplementation(async action => {
      if (action.action === "inspect_adapter") throw Object.assign(Error("unverified"), { code: "ADAPTER_CONFIGURATION_UNVERIFIED" });
      return request(action);
    });
    t.client.checkpoint.mockImplementation(async (...args) => {
      if (args[2]?.stagehandProgress?.phase === "FIXED_INSPECTION_FAILED") throw Object.assign(Error("retired"), { code: "DISCOVERY_LEASE_REJECTED" });
      return save(...args);
    });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_LEASE_REJECTED" });
    expect(genericWorker).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it.each(["UNSUPPORTED_ADAPTER_SOURCE", "CPS_PUBLIC_BUILD_UNSUPPORTED", "ADAPTER_CONFIGURATION_UNVERIFIED"])("hands only a freshly closed %s inspection to generic Sol and activates exactly once", async code => {
    const t = setup(), before = structuredClone(t.f.job);
    const request = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => {
      if (action.action === "inspect_adapter") throw Object.assign(Error("unsupported public format"), { code });
      return request(action);
    });
    const genericMetrics = { model: "gpt-6.1-sol", tokenUsage: { totalTokens: 7 }, cleanup: { browserClosed: true, modelClosed: true } };
    const genericWorker = vi.fn(async options => {
      expect(t.close).toHaveBeenCalledOnce(); expect(options.job).toBe(t.f.job);
      expect(options.job).toEqual(before); expect(options.freshOfficialStart).toBe(true);
      expect(options.recipeEngineConstraint).toBe(code === "ADAPTER_CONFIGURATION_UNVERIFIED" ? "EXISTING_ADAPTER" : undefined);
      expect(options.workDeadlineAt).toBe(new Date(first + 720000).toISOString());
      expect(options.checkpointProvenance.stagehandSource.jobId).toBe(t.f.job.id);
      expect(options.checkpointProvenance).not.toHaveProperty("controller");
      const initialFailure = readStagehandFailure({ ...options.job, checkpoint: options.checkpointProvenance }, t.f.clock);
      expect(initialFailure?.entries.at(-1)).toMatchObject({ phase: "FIXED_INSPECTION", code,
        cleanup: { inspectionBrowserClosed: true } });
      const activation = await verifyDiscoveryCandidate({ client: options.client, job: options.job,
        recipe: { engine: code === "ADAPTER_CONFIGURATION_UNVERIFIED" ? "EXISTING_ADAPTER" : "BROWSER_DOM" },
        sourceEvidence: { officialUrl: official, observedBookingUrl: booking }, executeRecipe: t.executeRecipe,
        beforeActivate: options.beforeActivate, afterActivate: () => options.afterActivate({ metrics: genericMetrics }) });
      genericMetrics.tokenUsage.totalTokens = 10;
      return { outcome: "activated", activation, metrics: genericMetrics };
    });
    const out = await t.run({ genericWorker });
    expect(out.metrics.source).toMatchObject({ modelCalls: 2, tokenUsage: { totalTokens: 20 } });
    expect(out.metrics.genericFallback.worker.tokenUsage.totalTokens).toBe(10);
    expect(t.client.candidate).toHaveBeenCalledOnce(); expect(t.client.verification).toHaveBeenCalledTimes(2);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.beforeActivate).toHaveBeenCalledOnce(); expect(t.afterActivate).toHaveBeenCalledOnce();
    expect(t.validateRecipe).not.toHaveBeenCalled(); expect(t.f.job).toEqual(before);
  });
  it.each(["ADAPTER_IDENTITY_MISMATCH", "CPS_CONFIGURATION_UNVERIFIED", "ACCESS_REQUIRED", "FRAMEWORK_INSPECTION_PATH_STALE", "NATIVE_REDIRECT_NETWORK_FAILED"])
  ("never generic-falls back for %s", async code => {
    const t = setup(), request = t.request.getMockImplementation()!, genericWorker = vi.fn();
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw Object.assign(Error(code), { code }); return request(action); });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code }); expect(genericWorker).not.toHaveBeenCalled();
  });
  it("keeps a ForeUP configuration denial inside typed-only repair with no unverified activation", async () => {
    const t = setup(), genericWorker = vi.fn(), foreup = "https://foreupsoftware.com/index.php/booking/123/456";
    t.f.report.adapterSourceProposal.bookingUrl = foreup;
    t.f.report.visitedUrls = [official, foreup];
    t.f.report.officialLinkLedger = [{ pageUrl: official, links: [{ href: foreup }] }];
    t.f.report.actions = [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: foreup }, afterUrl: foreup }];
    const request = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => {
      if (action.action === "inspect_adapter") throw Object.assign(Error("Public class coverage unverified"), { code: "ADAPTER_CONFIGURATION_UNVERIFIED" });
      return { ...await request(action), url: action.action === "open" && action.url === foreup ? foreup : official,
        controls: [{ kind: "link", href: foreup }] };
    });
    genericWorker.mockImplementation(async options => {
      expect(options.recipeEngineConstraint).toBe("EXISTING_ADAPTER");
      expect(options.freshOfficialStart).toBe(true);
      throw Object.assign(Error("typed Public scope remained unverified"), { code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    expect(genericWorker).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
  });
  it.each(["UNSUPPORTED_ADAPTER_SOURCE", "ADAPTER_CONFIGURATION_UNVERIFIED"])("does not generic-fall back when %s inspection cleanup failed or work expired", async code => {
    for (const mode of ["cleanup", "deadline"] as const) {
      const t = setup(), request = t.request.getMockImplementation()!, genericWorker = vi.fn();
      t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw Object.assign(Error("fixed inspection failed"), { code }); return request(action); });
      t.close.mockImplementation(async () => { if (mode === "cleanup") throw Error("close failed"); t.f.clock = first + 720000; });
      await expect(t.run({ genericWorker })).rejects.toBeDefined(); expect(genericWorker).not.toHaveBeenCalled();
    }
  });
  it.each(["UNSUPPORTED_ADAPTER_SOURCE", "ADAPTER_CONFIGURATION_UNVERIFIED"])("does not treat %s from source or opening a path as fixed-metadata fallback", async code => {
    for (const origin of ["source", "open"] as const) {
      const t = setup(), genericWorker = vi.fn(), failure = Object.assign(Error("outside fixed metadata"), { code });
      if (origin === "source") t.sourceDiscover.mockRejectedValue(failure); else t.request.mockRejectedValue(failure);
      await expect(t.run({ genericWorker })).rejects.toBe(failure); expect(genericWorker).not.toHaveBeenCalled();
    }
  });
  it("never writes another Stagehand checkpoint after generic activation retires the lease", async () => {
    const t = setup(), request = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw Object.assign(Error("unsupported"), { code: "UNSUPPORTED_ADAPTER_SOURCE" }); return request(action); });
    let countAtActivation = 0;
    const genericWorker = vi.fn(async options => {
      await options.beforeActivate(); await options.client.activate(options.job.id, options.job.leaseToken);
      await options.afterActivate({ metrics: { tokenUsage: { totalTokens: 4 } } }); countAtActivation = t.checkpoints.length;
      throw Object.assign(Error("cleanup after durable activation"), { code: "DISCOVERY_PROCESS_CLOSE_FAILED" });
    });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_PROCESS_CLOSE_FAILED" });
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.checkpoints).toHaveLength(countAtActivation);
  });
  it("retains generic failure checkpoints and separate partial usage after source resume beyond 240 seconds", async () => {
    const t = setup(), request = t.request.getMockImplementation()!;
    t.f.job.checkpoint = { stagehandSource: createStagehandSourceCheckpoint(t.f.job, t.f.report) }; t.f.job.attempts = 2; t.f.clock = first + 300000;
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw Object.assign(Error("unsupported"), { code: "UNSUPPORTED_ADAPTER_SOURCE" }); return request(action); });
    const genericWorker = vi.fn(async options => {
      expect(options.signal?.aborted).not.toBe(true);
      await options.client.checkpoint(options.job.id, options.job.leaseToken, { ...options.checkpointProvenance, summary: "fresh generic observation", controller: { officialObserved: true } });
      throw Object.assign(Error("partial generic turn"), { code: "DISCOVERY_TURN_FAILED", discoveryMetrics: { tokenUsage: { totalTokens: 13 }, attemptedModelTurns: 1, completedModelTurns: 0 } });
    });
    const failure = await t.run({ genericWorker }).catch(error => error);
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(genericWorker).toHaveBeenCalledOnce();
    expect(t.checkpoints.at(-1)).toMatchObject({ summary: "fresh generic observation", controller: { officialObserved: true }, stagehandSource: { jobId: t.f.job.id } });
    expect(failure.discoveryMetrics.genericFallback.worker).toMatchObject({ tokenUsage: { totalTokens: 13 }, completedModelTurns: 0 });
    expect(t.client.activate).not.toHaveBeenCalled();
  });
  const terminalReadinessCase = async (mode: "current" | "missing" | "copied" | "stale" | "wrongOriginal" |
    "changedBinding" | "revoked" | "noncurrentParent" | "missingFrame" | "invalidAdapter") => {
    const t = setup(), target = "a0000000-0000-4000-8000-000000000001";
    const frame = "https://public-course.play.teeitup.com/", source = "https://public-course.book.teeitup.com/";
    t.f.report.adapterSourceProposal.bookingUrl = source; t.f.report.visitedUrls = [official, source]; t.f.report.actions = [];
    t.f.report.officialLinkLedger = [];
    Object.assign(t.f.report, { frameLedger: [{ kind: "NATIVE_VISIBLE_FRAME", pageUrl: official, observedAt: new Date(first + 1000).toISOString(),
      documentHash: "a".repeat(64), frames: [{ src: frame, visible: true }] }], nativeFrameNavigations: [{ kind: "NATIVE_FRAME_SOURCE_OPEN",
      pageUrl: official, frameUrl: frame, observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64), finalUrl: source,
      completedAt: new Date(first + 1200).toISOString(), finalDocumentHash: "b".repeat(64),
      redirects: [{ fromUrl: frame, toUrl: source, status: 301, completed: true }] }] });
    let url = official, disclosed = false;
    t.request.mockImplementation(async action => {
      if (action.action === "click") disclosed = true;
      if (action.action === "open") url = action.url === frame ? source : action.url!;
      const terminal = url === source;
      return { url, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
        loading: disclosed || terminal, pendingRequestCount: disclosed || terminal ? 1 : 0,
        officialSourceDiagnostic: { rawOfficialCaptured: true, currentOfficialDocument: terminal ? false : mode !== "noncurrentParent",
          renderedHeadingsPresent: !disclosed && !terminal, renderedAddressesPresent: false, renderedLinksPresent: true },
        controls: !disclosed ? [{ kind: "public-entry-disclosure", target }] : [],
        frames: disclosed && !terminal && mode !== "missingFrame" ? [{ url: frame, source: "FIXED_INSPECTION_FRAME_SRC" }] : [],
        adapter: action.action === "inspect_adapter" ? mode === "invalidAdapter" ? {} : { family: "TEEITUP", alias: "public-course", facilityIds: [91] } : undefined,
        ...(terminal && mode !== "missing" ? { nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1",
          originalUrlSha256: stagehandDataHash(mode === "wrongOriginal" ? frame : source), currentUrlSha256: stagehandDataHash(url),
          documentBindingSha256: "b".repeat(64), observedAt: t.f.clock - (mode === "stale" ? 5001 : 0), status: 200 } } : {}) } as never;
    });
    if (mode !== "copied") t.browserFactory.mockImplementation(async options => {
      const browser = createDiscoveryBrowser({ ...options, processFactory: () => ({ request: t.request, close: t.close }) });
      const current = browser.currentMainDocumentContinuity.bind(browser);
      let terminalReads = 0;
      browser.currentMainDocumentContinuity = (snapshot, expected, clock) => {
        const proof = current(snapshot, expected, clock);
        if (snapshot.url === source && proof && ++terminalReads > 1) {
          if (mode === "revoked") return undefined;
          if (mode === "changedBinding" && terminalReads % 2 === 0) return { ...proof, documentBindingSha256: "c".repeat(64) };
        }
        return proof;
      };
      return browser;
    });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t.f.clock);
    if (mode === "missingFrame") {
      // Exercise the full production frame wait without sleeping in a mocked browser.
      vi.mocked(waitForFrame).mockImplementationOnce(async (milliseconds, _value, options) => {
        expect(milliseconds).toBe(8000);
        expect(options?.signal?.aborted).toBe(false);
        t.f.clock += milliseconds!;
        vi.setSystemTime(t.f.clock);
        return undefined;
      });
    }
    try {
      if (mode === "current" || mode === "noncurrentParent") {
        expect((await t.run()).outcome).toBe("activated");
        expect(t.request.mock.calls.filter(([a]) => a.action !== "finish").map(([a]) => a)).toEqual([
          { action: "open", url: official }, { action: "click", target },
          { action: "open", url: frame }, { action: "inspect_adapter", url: source },
        ]);
        expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(source); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
      } else {
        const freshRootOnly = mode === "wrongOriginal" || mode === "changedBinding";
        await expect(t.run()).rejects.toThrow(freshRootOnly ? "TEST_GENERIC_HANDOFF_REJECTED" : mode === "invalidAdapter" ? "FRAMEWORK_INSPECTION_METADATA_INVALID" :
          mode === "missingFrame" ? "FRAMEWORK_INSPECTION_PATH_STALE" : "FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED");
        // Bad frame continuity never earns source/recipe authority. A separate
        // clean current root may only request a new independent investigation.
        expect(t.genericWorker).toHaveBeenCalledTimes(freshRootOnly ? 1 : 0);
        if (mode === "missingFrame") {
          expect(waitForFrame).toHaveBeenCalledOnce();
          expect(t.request.mock.calls.filter(([a]) => a.action === "observe")).toHaveLength(1);
        }
        expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled();
      }
      expect(t.request.mock.calls.filter(([a]) => a.action === "click")).toHaveLength(1);
      expect(t.request.mock.calls.filter(([a]) => a.action !== "finish").length).toBeLessThanOrEqual(6); expect(t.close).toHaveBeenCalledOnce();
    } finally { vi.mocked(waitForFrame).mockReset(); vi.useRealTimers(); }
  };
  it.each(["current", "missing", "copied", "stale", "wrongOriginal", "changedBinding", "revoked", "noncurrentParent", "invalidAdapter", "missingFrame"] as const)
  ("requires fresh private terminal readiness after a modal's exact native frame: %s", terminalReadinessCase);
  it.each(["current", "ambiguous", "stillMissing", "movedDocument"] as const)("uses one fresh opaque public-entry disclosure within the existing inspection budget: %s", async mode => {
    const t = setup(), target = "a0000000-0000-4000-8000-000000000001";
    let disclosed = false;
    t.request.mockImplementation(async action => {
      if (action.action === "click") { expect(action).toEqual({ action: "click", target }); disclosed = true; }
      return { url: disclosed && mode === "movedDocument" ? official + "other" : official, browserTransport: "NATIVE_CHROME", navigationStatus: 200,
        accessRequirementObserved: false, loading: false,
        controls: !disclosed ? [{ kind: "public-entry-disclosure", target }, ...(mode === "ambiguous" ? [{ kind: "public-entry-disclosure", target: "a0000000-0000-4000-8000-000000000002" }] : [])] : [{ kind: "public-entry-disclosure", target }],
        frames: disclosed && mode !== "stillMissing" ? [{ url: booking, source: "OFFICIAL_IFRAME_SRC" }] : [],
        adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined } as never;
    });
    if (mode === "current") { expect((await t.run()).outcome).toBe("activated"); expect(t.request.mock.calls.filter(([a]) => a.action === "click")).toHaveLength(1); }
    else {
      await expect(t.run()).rejects.toThrow(mode === "movedDocument" ? "FRAMEWORK_INSPECTION_CONTEXT_CHANGED" : "FRAMEWORK_INSPECTION_PATH_STALE");
      expect(t.request.mock.calls.filter(([a]) => a.action === "click")).toHaveLength(mode === "ambiguous" ? 0 : 1);
      expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled();
    }
    expect(t.request.mock.calls.length).toBeLessThanOrEqual(6); expect(t.close).toHaveBeenCalledOnce();
  });
  it.each([false, true])("inspects a native frame redirect's current query without changing its canonical source (new document=%s)", async replaced => {
    const t = setup(), parent = official + "public-tee-times/", play = "https://public-course.play.teeitup.com/", bare = "https://public-course.book.teeitup.com/", current = bare + "?course=91&date=2030-01-03&max=4";
    t.f.report.adapterSourceProposal.bookingUrl = bare; t.f.report.visitedUrls = [official, parent, bare]; t.f.report.actions = [];
    t.f.report.officialLinkLedger = [{ pageUrl: official, links: [{ href: parent, visible: true }] }] as never;
    Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: new Date(first + 1000).toISOString() });
    Object.assign(t.f.report, { frameLedger: [{ kind: "NATIVE_VISIBLE_FRAME", pageUrl: parent, observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64), frames: [{ src: play, visible: true }] }],
      nativeFrameNavigations: [{ kind: "NATIVE_FRAME_SOURCE_OPEN", pageUrl: parent, frameUrl: play, observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64), finalUrl: bare,
        completedAt: new Date(first + 1200).toISOString(), finalDocumentHash: "b".repeat(64), redirects: [{ fromUrl: play, toUrl: bare, status: 301, completed: true }] }] });
    let url = official, originalUrl = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") { url = action.url === play ? bare : action.url!; originalUrl = url; }
      if (action.action === "inspect_adapter") url = current;
      return { url, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
        loading: url === bare, pendingRequestCount: url === bare ? 4 : 0,
        controls: url === official ? [{ kind: "link", href: parent }] : [], frames: url === parent ? [{ url: play, source: "FIXED_INSPECTION_FRAME_SRC" }] : [],
        adapter: action.action === "inspect_adapter" ? { family: "TEEITUP", alias: "public-course", facilityIds: [91] } : undefined,
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(originalUrl), currentUrlSha256: stagehandDataHash(url),
          documentBindingSha256: (replaced && action.action === "inspect_adapter" ? "c" : originalUrl === bare ? "b" : "a").repeat(64), observedAt: t.f.clock, status: 200 } } as never;
    });
    t.browserFactory.mockImplementation(async options => createDiscoveryBrowser({ ...options, processFactory: () => ({ request: t.request, close: t.close }) }) as never);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t.f.clock);
    try {
      if (replaced) { await expect(t.run()).rejects.toThrow("FRAMEWORK_INSPECTION_CONTEXT_CHANGED"); expect(t.client.candidate).not.toHaveBeenCalled(); }
      else { expect((await t.run()).outcome).toBe("activated"); expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(bare);
        expect(t.request.mock.calls.filter(([a]) => a.action !== "finish").map(([a]) => a)).toEqual([{ action: "open", url: official }, { action: "open", url: parent }, { action: "open", url: play }, { action: "inspect_adapter", url: bare }]); }
    } finally { vi.useRealTimers(); }
  });
  it.each(["current", "copiedOnly", "newDocument", "wrongOriginal", "stale"] as const)
  ("keeps canonical CPS source and accepts actual current context only with %s native continuity", async mode => {
    const t = setup(), source = "https://public-course.cps.golf/", firstContext = source + "public-search?view=day", inspectedContext = source + "public-search?view=public";
    t.f.report.adapterSourceProposal.bookingUrl = source; t.f.report.visitedUrls = [official];
    t.f.report.officialLinkLedger = [{ pageUrl: official, links: [{ href: source, visible: true }] }] as never;
    Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: new Date(first + 1000).toISOString() }); t.f.report.actions = [];
    let current = official, originalUrl = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") { originalUrl = action.url!; current = action.url === source ? firstContext : official; }
      if (action.action === "inspect_adapter") current = inspectedContext;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
        controls: [{ kind: "link", href: source }], adapter: action.action === "inspect_adapter" ? { family: "CPS", tenant: "public-course", courseIds: [91], catalogHash: "c".repeat(64) } : undefined,
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(mode === "wrongOriginal" ? source + "other" : originalUrl),
          currentUrlSha256: stagehandDataHash(current), documentBindingSha256: (mode === "newDocument" && action.action === "inspect_adapter" ? "d" : originalUrl === source ? "b" : "a").repeat(64),
          observedAt: t.f.clock - (mode === "stale" ? 5001 : 0), status: 200 } } as never;
    });
    if (mode !== "copiedOnly") t.browserFactory.mockImplementation(async options => createDiscoveryBrowser({ ...options,
      processFactory: () => ({ request: t.request, close: t.close }) }) as never);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t.f.clock);
    try {
      if (mode === "current") {
        const result = await t.run(); expect(result.outcome).toBe("activated");
        expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(source);
        expect(t.request.mock.calls.filter(([a]) => a.action !== "finish").map(([a]) => a)).toEqual([
          { action: "open", url: official }, { action: "open", url: source }, { action: "inspect_adapter", url: source },
        ]);
      } else {
        await expect(t.run()).rejects.toThrow(mode === "newDocument" ? "FRAMEWORK_INSPECTION_CONTEXT_CHANGED" : "FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED");
        expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled();
      }
    } finally { vi.useRealTimers(); }
  });
  it.each(["current", "copiedOnly", "stale", "wrongOriginal", "wrongIdentity", "wrongPhone", "wrongCatalog", "unrelatedSource", "prefixPath", "newDocument"] as const)
  ("adopts only the fresh privately bound CPS title/contact entry source: %s", async mode => {
    const t = setup(), source = "https://entry-course.cps.golf/", canonical = source + "onlineresweb/search-teetime";
    t.f.report.adapterSourceProposal.bookingUrl = source; t.f.report.visitedUrls = [official]; t.f.report.actions = [];
    t.f.report.officialLinkLedger = [{ pageUrl: official, links: [{ href: source, visible: true }] }] as never;
    Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: new Date(first + 1000).toISOString() });
    const proof = cpsOfficialEntryProofSchema.parse({ kind: "OFFICIAL_TITLE_PHYSICAL_ENTRY", officialUrl: official, officialPageUrl: official,
      bookingDocumentUrl: official + "tee-times", bookingUrl: canonical, venueName: t.f.job.request.identity.name,
      canonicalAddressInput: t.f.job.request.identity.address, timeZone: "UTC", canonicalCoursePhone: t.f.job.request.trustedContext.canonicalCoursePhone,
      publishedTitle: t.f.job.request.identity.name, rootIdentitySha256: "1".repeat(64), rootEntrySha256: "2".repeat(64), widgetEntrySha256: "3".repeat(64),
      entryKind: "CPS_CMS_PUBLIC_GET_V1", providerVenueName: t.f.job.request.identity.name, providerAddress: parsePublicUSBusinessAddress(t.f.job.request.identity.address),
      tenant: "entry-course", courseIds: [91], catalogHash: "c".repeat(64), warmTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" });
    const changed = { ...proof, ...(mode === "wrongIdentity" ? { venueName: "Other Public Course" } : {}),
      ...(mode === "wrongPhone" ? { canonicalCoursePhone: "+15555550124" } : {}), ...(mode === "wrongCatalog" ? { catalogHash: "d".repeat(64) } : {}),
      ...(mode === "unrelatedSource" ? { bookingUrl: "https://other-course.cps.golf/onlineresweb/search-teetime" } : {}),
      ...(mode === "prefixPath" ? { bookingUrl: canonical + "/other" } : {}) };
    let current = official, originalUrl = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") { originalUrl = action.url!; current = originalUrl; }
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
        controls: [{ kind: "link", href: source }], adapter: action.action === "inspect_adapter" ? { family: "CPS", tenant: "entry-course", courseIds: [91], catalogHash: "c".repeat(64), officialEntryProof: changed } : undefined,
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(mode === "wrongOriginal" ? source + "other" : originalUrl),
          currentUrlSha256: stagehandDataHash(current), documentBindingSha256: (mode === "newDocument" && action.action === "inspect_adapter" ? "d" : originalUrl === source ? "b" : "a").repeat(64),
          observedAt: t.f.clock - (mode === "stale" ? 5001 : 0), status: 200 } } as never;
    });
    if (mode !== "copiedOnly") t.browserFactory.mockImplementation(async options => createDiscoveryBrowser({ ...options,
      processFactory: () => ({ request: t.request, close: t.close }) }) as never);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t.f.clock);
    try {
      if (mode === "current") {
        expect((await t.run()).outcome).toBe("activated"); const saved = t.client.candidate.mock.calls[0][2];
        expect(saved.source.bookingUrl).toBe(canonical); expect(saved.adapter.officialEntryProof).toEqual(proof);
        expect(t.client.candidate.mock.calls[0][4]).toEqual({ officialUrl: official, observedBookingUrl: canonical });
        expect(t.executeRecipe).toHaveBeenCalledTimes(2);
        expect(t.request.mock.calls.filter(([action]) => action.action !== "finish").map(([action]) => action)).toEqual([
          { action: "open", url: official }, { action: "open", url: source }, { action: "inspect_adapter", url: source },
        ]);
      } else {
        await expect(t.run()).rejects.toThrow(); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled();
      }
      expect(t.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("preserves closed native exception facts through the actual helper error reply projector", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: 0, signalCode: null });
    const channel = createDiscoveryProcess({ executable: "fixture-only", args: [], cwd: ".", environment: {}, spawnProcess: () => child });
    try {
      const pending = channel.request({ action: "open" }).catch(error => error);
      child.stdout.write(JSON.stringify({ id: 1, ok: false, error: "NATIVE_REDIRECT_ROUTING_FAILED", diagnostics: { nativeFirstFatal: {
        code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY", errorName: "Error", errorCategory: "BODY_UNAVAILABLE", requestUrlSha256: "a".repeat(64),
        headers: { cookie: "PRIVATE" }, message: "PRIVATE", requestId: "PRIVATE" } } }) + "\n");
      const error = await pending;
      expect(error).toMatchObject({ code: "NATIVE_REDIRECT_ROUTING_FAILED", details: { browserDiagnostics: { nativeFirstFatal: {
        code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY", errorName: "Error", errorCategory: "BODY_UNAVAILABLE", requestUrlSha256: "a".repeat(64) } } } });
      expect(JSON.stringify(error.details)).not.toMatch(/PRIVATE|cookie|headers|message|requestId/u);
    } finally { await channel.close(); }
  });
  it.each(["known", "unknown", "absent"] as const)("retains only actual current native facts on an open throw (%s)", async mode => {
    const t = setup(), primary = Object.assign(Error("NATIVE_REDIRECT_ROUTING_FAILED"), { code: "NATIVE_REDIRECT_ROUTING_FAILED",
      details: { browserDiagnostics: mode === "absent" ? {} : { nativeFirstFatal: mode === "unknown" ? {
        code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "PRIVATE", errorName: "PRIVATE", headers: { cookie: "PRIVATE" },
      } : { code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY", errorName: "Error", errorCategory: "BODY_UNAVAILABLE",
        requestUrlSha256: "a".repeat(64), method: "GET", resourceType: "stylesheet", framePresent: true, networkIdPresent: true,
        url: "https://private.example/?token=PRIVATE", message: "PRIVATE_BODY", headers: { cookie: "PRIVATE" } } } } });
    t.request.mockRejectedValueOnce(primary);
    const error = await t.run().catch(e => e), saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(error).toBe(primary); expect(t.close).toHaveBeenCalledOnce();
    if (mode === "absent") expect(saved.stagehandFailure.entries[0]).not.toHaveProperty("fixedInspectionDiagnostic");
    else {
      const native = mode === "unknown" ? { code: "NATIVE_REDIRECT_ROUTING_FAILED" } : {
        code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY", errorName: "Error", errorCategory: "BODY_UNAVAILABLE",
        requestUrlSha256: "a".repeat(64), method: "GET", resourceType: "stylesheet", framePresent: true, networkIdPresent: true };
      const diagnostic = { nativeRouterFailure: native };
      expect(saved.stagehandFailure.entries[0]).toMatchObject({ fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
      expect(currentStagehandInspectionDiagnostic(error, t.f.job, t.f.clock, t.f.clock)).toEqual(diagnostic);
      expect(currentStagehandInspectionDiagnostic({ ...error }, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
      expect(currentStagehandInspectionDiagnostic(error, { ...t.f.job, attempts: 2 }, t.f.clock, t.f.clock)).toBeUndefined();
      const forged = structuredClone(saved), injected = { nativeRouterFailure: { ...native, message: "PRIVATE" } };
      Object.assign(forged.stagehandFailure.entries[0], { fixedInspectionDiagnostic: injected, fixedInspectionDiagnosticSha256: stagehandDataHash(injected) });
      expect(readStagehandFailure({ ...t.f.job, checkpoint: forged }, t.f.clock)).toBeUndefined();
    }
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(JSON.stringify(saved)).not.toMatch(/PRIVATE|https:\/\/private|cookie|headers|message/u);
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("does not invent a native failure during successful fixed inspection", async () => {
    const t = setup(); expect((await t.run()).outcome).toBe("activated");
    expect(t.checkpoints.every(value => !(value as { stagehandFailure?: unknown }).stagehandFailure)).toBe(true);
  });
  it.each([
    ["missingStatus", ["OPEN_STATUS_MISSING"]],
    ["badStatus", ["STATUS_REJECTED"]],
    ["access", ["ACCESS_REQUIREMENT"]],
    ["native", ["NATIVE_FATAL"]],
    ["unsafeUrl", ["PUBLIC_URL_REJECTED"]],
    ["transport", ["TRANSPORT_CHANGED"]],
  ])("persists the current early %s readability failure before the unchanged guard", async (change, failures) => {
    const t = setup();
    const snapshot: Record<string, unknown> = { url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200,
      accessRequirementObserved: false, readyState: "complete", pendingRequestCount: 0,
      officialSourceDiagnostic: { currentOfficialDocument: true }, frameId: "PRIVATE_FRAME", loaderId: "PRIVATE_LOADER", text: "PRIVATE_BODY" };
    if (change === "missingStatus") delete snapshot.navigationStatus;
    if (change === "badStatus") snapshot.navigationStatus = 503;
    if (change === "access") snapshot.accessRequirementObserved = true;
    if (change === "native") snapshot.nativeFirstFatal = { code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", url: "https://private.example/?token=PRIVATE" };
    if (change === "unsafeUrl") snapshot.url = "https://user:PRIVATE@private.example/login?token=PRIVATE";
    if (change === "transport") snapshot.browserTransport = "PINNED_HTTP";
    t.request.mockResolvedValue(snapshot as never);
    const error = await t.run().catch(e => e);
    expect(error.code).toBe(change === "transport" ? "FRAMEWORK_INSPECTION_TRANSPORT_CHANGED" : "FRAMEWORK_INSPECTION_SOURCE_UNREADABLE");
    const expected = inspectionReadability(snapshot, "open", 1, official, booking);
    expect(expected.failedPredicates).toEqual(failures);
    const diagnostic = { readability: [expected] };
    expect(error.inspectionReceipt.actions[0].readability).toEqual(expected);
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(currentStagehandInspectionDiagnostic(error, t.f.job, t.f.clock, t.f.clock)).toEqual(diagnostic);
    expect(currentStagehandInspectionDiagnostic({ ...error }, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(error, { ...t.f.job }, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(error, t.f.job, t.f.clock + 1, t.f.clock + 1)).toBeUndefined();
    for (const field of ["attempts", "sourceFingerprint", "firstPickedUpAt", "deadlineAt"] as const) {
      const prior = t.f.job[field]; Object.assign(t.f.job, { [field]: field === "attempts" ? 2 : "changed" });
      expect(currentStagehandInspectionDiagnostic(error, t.f.job, t.f.clock, t.f.clock)).toBeUndefined(); Object.assign(t.f.job, { [field]: prior });
    }
    expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_FRAME|PRIVATE_LOADER|PRIVATE_BODY|user:PRIVATE|token=PRIVATE/u);
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("retains preceding readable actions and exact closed redirect hashes without converting them into authority", async () => {
    const t = setup(), original = t.request.getMockImplementation()!;
    const snapshot = { url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
      nativeFirstFatal: { code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT" }, readyState: "complete", pendingRequestCount: 2,
      nativeDocumentRedirects: [{ fromUrl: official, toUrl: "https://public-other.example/", status: 302, completed: true, raw: "PRIVATE" }] };
    t.request.mockImplementation(async action => action.action === "inspect_adapter" ? snapshot as never : original(action));
    const error = await t.run().catch(e => e), rows = error.inspectionReceipt.actions.map((row: { readability: ReturnType<typeof inspectionReadability> }) => row.readability);
    expect(rows).toHaveLength(2); expect(rows[0].failedPredicates).toEqual([]); expect(rows[1].failedPredicates).toEqual(["NATIVE_FATAL"]);
    expect(rows[1].redirectHashes).toEqual([{ fromSha256: stagehandDataHash(official), toSha256: stagehandDataHash("https://public-other.example/"), status: 302 }]);
    expect(rows[1]).toMatchObject({ frameCorrelation: null, loaderCorrelation: null, redirectsOmitted: false });
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0].fixedInspectionDiagnostic).toEqual({ readability: rows });
    for (const change of ["unknown", "extra", "duplicate", "tooMany", "url", "hash"] as const) {
      const forged = structuredClone(saved), diagnostic = forged.stagehandFailure.entries[0].fixedInspectionDiagnostic as { readability: Array<Record<string, unknown>> };
      if (change === "unknown") diagnostic.readability[1].nativeFatalCode = "PRIVATE_ARBITRARY";
      if (change === "extra") diagnostic.readability[1].body = "PRIVATE";
      if (change === "duplicate") diagnostic.readability[1].actionIndex = 1;
      if (change === "tooMany") diagnostic.readability = Array(7).fill(diagnostic.readability[0]);
      if (change === "url") diagnostic.readability[1].currentUrlCategory = "PRIVATE_URL";
      if (change === "hash") diagnostic.readability[1].currentUrlSha256 = "PRIVATE";
      forged.stagehandFailure.entries[0].fixedInspectionDiagnosticSha256 = stagehandDataHash(diagnostic);
      expect(readStagehandFailure({ ...t.f.job, checkpoint: forged }, t.f.clock)).toBeUndefined();
    }
    expect(JSON.stringify(saved.stagehandFailure)).not.toContain("https://"); expect(t.client.candidate).not.toHaveBeenCalled();
  });
  it("persists a closed current-invocation final-frame landing failure without granting source authority", async () => {
    const t = setup(), final = "https://unseen-public-booking.example/changed";
    t.f.report.actions = []; t.f.report.visitedUrls = [official]; t.f.report.officialLinkLedger = [];
    t.f.report.frameLedger = [{ kind: "NATIVE_VISIBLE_FRAME", pageUrl: official, observedAt: new Date(first + 1000).toISOString(),
      documentHash: "a".repeat(64), frames: [{ src: booking, visible: true }] }] as never;
    t.request.mockImplementation(async action => ({ url: action.url === booking ? final : official,
      browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
      controls: [], frames: action.url === booking ? [] : [{ source: "FIXED_INSPECTION_FRAME_SRC", url: booking }] }));
    const error = await t.run().catch(e => e);
    expect(error.code).toBe("FRAMEWORK_INSPECTION_LANDING_CHANGED");
    const landing = error.inspectionReceipt.landingFailure;
    expect(landing).toMatchObject({ position: 1, pathLength: 2, snapshotPathIndex: -1, logicalPathIndex: -1,
      remainingPathIndex: -1, nativeContextPresent: false, frameParentPosition: 0, frameChildPosition: 1 });
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ code: "FRAMEWORK_INSPECTION_LANDING_CHANGED",
      fixedInspectionDiagnostic: { landing }, fixedInspectionDiagnosticSha256: stagehandDataHash({ landing }) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(currentStagehandInspectionDiagnostic({ ...error }, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(error, { ...t.f.job }, t.f.clock, t.f.clock)).toBeUndefined();
    const forged = structuredClone(saved), diagnostic = { landing: { ...landing, rawUrl: final } };
    Object.assign(forged.stagehandFailure.entries[0], { fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: forged }, t.f.clock)).toBeUndefined();
    expect(JSON.stringify(saved.stagehandFailure)).not.toContain("https:");
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalledOnce();
  });
  it.each(["CPS_PHONE_BOOKING_SOURCE_UNVERIFIED", "CPS_OFFICIAL_ENTRY_UNVERIFIED"])("preserves the finite measured %s instead of masking it", async code => {
    const t = setup(), error = Object.assign(Error("private source content"), { code });
    t.request.mockRejectedValue(error);
    await expect(t.run()).rejects.toBe(error);
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0].code).toBe(code);
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("keeps native fatal codes finite and unreadable predicate truth exact", () => {
    for (const code of stagehandNativeRouterCodes) expect(inspectionReadability({ url: official, nativeFirstFatal: { code } }, "observe", 1, official, booking).nativeFatalCode).toBe(code);
    const row = inspectionReadability({ url: booking, browserTransport: "NATIVE_CHROME", navigationStatus: null,
      accessRequirementObserved: "PRIVATE", nativeFirstFatal: { code: "PRIVATE_TOKEN" }, readyState: "PRIVATE", pendingRequestCount: 9999,
      nativeDocumentRedirects: Array(6).fill({ fromUrl: "https://user:PRIVATE@public.example/", toUrl: official, status: 302, completed: true }) }, "open", 1, official, booking);
    expect(row).toMatchObject({ currentUrlCategory: "BOOKING_ORIGIN", nativeFatalCode: "UNKNOWN", accessRequirementObserved: null,
      navigationStatusPresent: true, navigationStatus: null, pendingRequestCount: null, readyState: null, redirectsOmitted: true, redirectHashes: [] });
    expect(row.failedPredicates).toEqual(["ACCESS_REQUIREMENT", "NATIVE_FATAL", "OPEN_STATUS_MISSING", "STATUS_REJECTED"]);
    expect(safeInspectionReadability([row])).toEqual([row]); expect(JSON.stringify(row)).not.toContain("PRIVATE");
  });
  it.each(["EXTRACT", "OBSERVE", "ACT"])("propagates current closed %s model failure facts without provider text or inferred quota", async phase => {
    const t = setup(); modelFailureReport(t).phase = phase;
    const error = await t.run().catch(e => e);
    expect(error.code).toBe("LOCAL_MODEL_TURN_FAILED");
    expect(error.discoveryMetrics.modelFailure).toEqual({ turnStatus: "failed", errorCategory: "responseTooManyFailedAttempts", httpStatusCode: 429 });
    expect(JSON.stringify(error.discoveryMetrics)).not.toMatch(/PRIVATE|quota/i);
    expect(t.sourceDiscover).toHaveBeenCalledOnce(); expect(t.browserFactory).not.toHaveBeenCalled();
  });
  it.each(["foreign", "clock", "staleInvocation", "cleanup", "diagnosticCleanup", "phase", "evidencePhase", "transport", "private", "counts"])
  ("does not propagate %s source diagnostics as current model retry facts", async change => {
    const t = setup(), diagnostic = modelFailureReport(t);
    if (change === "foreign") t.f.report.jobId = "foreign-job";
    if (change === "clock") t.f.report.finishedAt = new Date(first + 240001).toISOString();
    if (change === "staleInvocation") t.f.clock = first + 100000;
    if (change === "cleanup") t.f.report.browserClosed = false;
    if (change === "diagnosticCleanup") diagnostic.cleanup.modelClosed = false;
    if (change === "phase") diagnostic.phase = "OPEN";
    if (change === "evidencePhase") diagnostic.phase = "EVIDENCE";
    if (change === "transport") diagnostic.transportCode = "LOCAL_MODEL_RPC_FAILED";
    if (change === "private") (diagnostic as Record<string, unknown>).private = "PRIVATE";
    if (change === "counts") diagnostic.counts.failedModelCalls = 0;
    const error = await t.run().catch(e => e);
    expect(error.discoveryMetrics).not.toHaveProperty("modelFailure");
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("does not copy an upstream model failure when no current source report was returned", async () => {
    const t = setup(); t.sourceDiscover.mockRejectedValue(Object.assign(Error("LOCAL_MODEL_TURN_FAILED"), { code: "LOCAL_MODEL_TURN_FAILED",
      discoveryMetrics: { modelFailure: { turnStatus: "failed", errorCategory: "responseTooManyFailedAttempts", httpStatusCode: 429 } } }));
    const error = await t.run().catch(e => e); expect(error.discoveryMetrics).not.toHaveProperty("modelFailure");
  });
  it.each([false, true])("persists only current closed adapter read facts alongside optional delegation (%s)", async combined => {
    const t = setup(), adapterRead = { stage: "RESPONSE_HEADERS", role: "TEEITUP_DIRECTORY", httpStatus: 404,
      responseRedirected: false, responseUrlMatches: true, elapsedMs: 170, responseBytes: null, transportCode: "NONE" };
    const delegation = combined ? createDelegationDiagnostic("PROVIDER_BIND") : undefined;
    const primary = Object.assign(Error("ADAPTER_TRANSPORT_FAILED"), { code: "ADAPTER_TRANSPORT_FAILED",
      details: { browserDiagnostics: { adapterRead: { ...adapterRead, body: "PRIVATE", url: "PRIVATE" },
        ...(delegation ? { teeItUpDelegation: delegation } : {}) } } });
    const original = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw primary; return original(action); });
    await expect(t.run()).rejects.toBe(primary);
    const diagnostic = { ...(delegation ? { teeItUpDelegation: delegation } : {}), adapterRead };
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ phase: "FIXED_INSPECTION", code: "ADAPTER_TRANSPORT_FAILED",
      fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock, t.f.clock)).toEqual(diagnostic);
    expect(currentStagehandInspectionDiagnostic({ ...primary }, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(primary, { ...t.f.job }, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock + 1, t.f.clock + 1)).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("PRIVATE");
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("persists only bounded official identity, postal and configuration failure gates", async () => {
    const t = setup(), original = t.request.getMockImplementation()!;
    const keys = ["noTerminalFailure", "sessionOpen", "noAccessRequirement", "noNativeFatal", "status200", "snapshotNative",
      "capturedPagePresent", "captureUrlMatches", "captureFreshWithin5s", "capturedNative", "capturedTimeOriginMatches",
      "officialDocumentVerified", "visibleAddressesPresent", "visibleLinksPresent", "currentMainDocumentMatches"];
    const gates = Object.fromEntries(keys.map(key => [key, key !== "visibleAddressesPresent"]));
    const raw = { navigationFailureKind: "TIMEOUT", officialIdentityReadDiagnostic: { captureAgeMs: 5100, gates: { ...gates, token: "PRIVATE" }, url: "PRIVATE_URL" },
      officialSourceDiagnostic: { stage: "INSPECTOR_REJECTED", uscheduleConfigurationGate: "SELECTORS", rawOfficialCaptured: true,
        currentOfficialDocument: true, body: "PRIVATE_BODY" },
      cpsPostalContact: { gates: { freshNativeOfficialPage: true, canonicalAddressValid: false, address: "PRIVATE_ADDRESS" },
        native: { attestationPresent: true, officialRootMatches: false, token: "PRIVATE" } },
      requests: [{ url: "https://private.example/?token=PRIVATE" }] };
    const transported = safeBrowserFailureDiagnostics(raw);
    expect(transported?.officialIdentityReadDiagnostic).toEqual({ captureAgeMs: 5100, gates });
    const closed = safeFixedInspectionSourceDiagnostic(transported);
    expect(closed).toEqual({ navigationFailureKind: "TIMEOUT", officialSourceDiagnostic: { stage: "INSPECTOR_REJECTED", uscheduleConfigurationGate: "SELECTORS",
      rawOfficialCaptured: true, currentOfficialDocument: true }, officialIdentityReadDiagnostic: { captureAgeMs: 5100, gates },
      cpsPostalContact: { gates: { freshNativeOfficialPage: true, canonicalAddressValid: false },
        native: { attestationPresent: true, officialRootMatches: false } } });
    const primary = Object.assign(Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED"), { code: "OFFICIAL_POSTAL_SOURCE_UNVERIFIED",
      details: { browserDiagnostics: transported } });
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw primary; return original(action); });
    await expect(t.run()).rejects.toBe(primary);
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ phase: "FIXED_INSPECTION", code: "OFFICIAL_POSTAL_SOURCE_UNVERIFIED",
      fixedInspectionDiagnostic: closed, fixedInspectionDiagnosticSha256: stagehandDataHash(closed) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock, t.f.clock)).toEqual(closed);
    expect(JSON.stringify(saved.stagehandFailure.entries[0].fixedInspectionDiagnostic)).not.toMatch(/PRIVATE|https:\/\//u);
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("retains the closed delegated gate in the failed inspection receipt without replacing its primary", async () => {
    const t = setup(), delegation = createDelegationDiagnostic("HOP_ONE_READ");
    delegation.gates.rootFresh = true; delegation.gates.hopStatus200 = false;
    const primary = Object.assign(Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED"), {
      code: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED",
      details: { browserDiagnostics: { teeItUpDelegation: { ...delegation, url: "PRIVATE", gates: { ...delegation.gates, token: "PRIVATE" } } } },
    });
    const original = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw primary; return original(action); });
    await expect(t.run()).rejects.toBe(primary);
    const receipt = (primary as typeof primary & { inspectionReceipt: { actions: Array<{ action: string; teeItUpDelegation?: unknown }> } }).inspectionReceipt;
    expect(receipt.actions.find(row => row.action === "inspect_adapter")?.teeItUpDelegation).toEqual(delegation);
    const fixedInspectionDiagnostic = { teeItUpDelegation: delegation };
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<Record<string, unknown>> } };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ phase: "FIXED_INSPECTION", code: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED",
      fixedInspectionDiagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(fixedInspectionDiagnostic) });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock, t.f.clock)).toEqual(fixedInspectionDiagnostic);
    expect(currentStagehandInspectionDiagnostic({ ...primary }, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(primary, { ...t.f.job }, t.f.clock, t.f.clock)).toBeUndefined();
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock + 1, t.f.clock + 1)).toBeUndefined();
    for (const field of ["attempts", "sourceFingerprint", "firstPickedUpAt", "deadlineAt"] as const) {
      const prior = t.f.job[field]; Object.assign(t.f.job, { [field]: field === "attempts" ? 2 : "changed" });
      expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock, t.f.clock)).toBeUndefined();
      Object.assign(t.f.job, { [field]: prior });
    }
    const oldInput = t.f.job.request.input; t.f.job.request.input = { ...oldInput, players: 3 };
    expect(currentStagehandInspectionDiagnostic(primary, t.f.job, t.f.clock, t.f.clock)).toBeUndefined(); t.f.job.request.input = oldInput;
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("preserves only a native row's bounded document hash in routing checkpoints", () => {
    const f = fixture(); Object.assign(f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64) });
    const checkpoint = createStagehandSourceCheckpoint(f.job, f.report);
    expect(checkpoint.report.officialLinkLedger[0].documentHash).toBe("a".repeat(64));
    const restored = readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: { stagehandSource: checkpoint } }, undefined, f.clock);
    expect(restored?.report.officialLinkLedger[0].documentHash).toBe("a".repeat(64));
    Object.assign(f.report.officialLinkLedger[0], { documentHash: "PRIVATE_UNBOUNDED_VALUE" });
    expect(createStagehandSourceCheckpoint(f.job, f.report).report.officialLinkLedger[0].documentHash).toBeUndefined();
    Object.assign(f.report.officialLinkLedger[0], { kind: undefined, documentHash: "a".repeat(64) });
    expect(createStagehandSourceCheckpoint(f.job, f.report).report.officialLinkLedger[0].documentHash).toBeUndefined();
  });

  it("preserves actual native frame entries and redirect path through own-source checkpoint without model evidence", () => {
    const f = fixture(), frame = "https://native-wrapper.example/start?exact=one", landing = "https://native-wrapper.example/rendered";
    const witness = { kind: "NATIVE_VISIBLE_FRAME", pageUrl: official, observedAt: f.report.startedAt, documentHash: "a".repeat(64), frames: [{ src: frame, visible: true }] };
    const entry = { kind: "NATIVE_FRAME_SOURCE_OPEN", pageUrl: official, frameUrl: frame, observedAt: witness.observedAt, documentHash: witness.documentHash,
      finalUrl: landing, completedAt: f.report.finishedAt, finalDocumentHash: "b".repeat(64), redirects: [{ fromUrl: frame, toUrl: landing, status: 302, completed: true }] };
    Object.assign(f.report, { visitedUrls: [official, landing], frameLedger: [witness], nativeFrameNavigations: [entry], actions: [],
      officialLinkLedger: [{ kind: "NATIVE_VISIBLE_DOM", pageUrl: landing, observedAt: f.report.finishedAt, links: [{ href: booking, visible: true }] }] });
    const saved = createStagehandSourceCheckpoint(f.job, f.report);
    expect(saved.report.nativeFrameNavigations).toEqual([entry]);
    expect(saved.report.frameLedger).toEqual([witness]);
    expect(observedInspectionPath(saved.report, official, booking)).toEqual([official, frame, landing, booking]);
    const restored = readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: { stagehandSource: saved } }, undefined, first + 140000);
    expect(restored.report).toEqual(saved.report);
    for (const mutation of [
      report => { report.nativeFrameNavigations[0].finalDocumentHash = "bad"; },
      report => { report.frameLedger[0].frames[0].visible = false; },
      report => { report.nativeFrameNavigations[0].redirects[0].toUrl = booking; },
      report => { report.nativeFrameNavigations.push(entry, entry); },
    ]) {
      const bad = structuredClone(f.report); mutation(bad);
      expect(() => createStagehandSourceCheckpoint(f.job, bad)).toThrow("STAGEHAND_SOURCE_GRAPH_LIMIT");
    }
  });

  it("checkpoints an honest completed unresolved source as failure without source or method authority", async () => {
    const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null });
    await expect(t.run()).rejects.toThrow("STAGEHAND_SOURCE_UNRESOLVED");
    const saved = t.checkpoints.at(-1) as { stagehandFailure: { entries: Array<{ phase: string; code: string }> }; stagehandSource?: unknown };
    expect(saved.stagehandFailure.entries[0]).toMatchObject({ phase: "SOURCE_VALIDATION", code: "STAGEHAND_SOURCE_UNRESOLVED" });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(saved.stagehandSource).toBeUndefined();
    expect(readStagehandSourceCheckpoint({ ...t.f.job, attempts: 2, checkpoint: saved }, undefined, t.f.clock)).toBeUndefined();
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it.each(["foreign", "clock", "cleanup", "model", "proposal", "slots", "recipe", "unknown"])("rejects malformed or foreign unresolved report: %s", async change => {
    const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null });
    const report = t.f.report as Record<string, unknown>;
    if (change === "foreign") report.jobId = "another-job";
    if (change === "clock") report.finishedAt = new Date(first + 240001).toISOString();
    if (change === "cleanup") report.browserClosed = false;
    if (change === "model") report.metrics = { ...t.f.report.metrics, localCodexCalls: [{ model: "foreign-model" }] };
    if (change === "proposal") report.adapterSourceProposal = { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking };
    if (change === "slots") report.matchingSlots = [{ time: "08:00" }];
    if (change === "recipe") report.recipe = { forged: true };
    if (change === "unknown") report.frameworkFailureCode = "PRIVATE_TOKEN_ABC123";
    await expect(t.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID");
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.client.activate).not.toHaveBeenCalled();
  });

  it.each(["ADAPTER_CONFIGURATION_UNVERIFIED"])("routes actual fixed-reader %s through fresh-root generic without admitting metadata as source proof", async code => {
    const t = setup(), primary = Object.assign(Error(code), { code });
    const originalRequest = t.request.getMockImplementation()!;
    t.request.mockImplementation(async action => { if (action.action === "inspect_adapter") throw primary; return originalRequest(action); });
    const genericWorker = vi.fn(async options => {
      expect(options.freshOfficialStart).toBe(true);
      expect(options.workDeadlineAt).toBe(new Date(first + 720000).toISOString());
      expect(options.checkpointProvenance.stagehandSource.report.adapterSourceProposal).toEqual(t.f.report.adapterSourceProposal);
      expect(options.checkpointProvenance).not.toHaveProperty("controller");
      throw Object.assign(Error("fresh generic could not prove a method"), { code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    });
    await expect(t.run({ genericWorker })).rejects.toMatchObject({ code: "DISCOVERY_NO_VERIFIED_RECIPE" });
    expect(genericWorker).toHaveBeenCalledOnce();
    expect(t.checkpoints.at(-1)).toMatchObject({ stagehandSource: { jobId: t.f.job.id } });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
    const forged = setup(); Object.assign(forged.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code });
    await expect(forged.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID");
    expect(forged.browserFactory).not.toHaveBeenCalled();
  });

  it("durably checkpoints only closed own-job failure facts before normal failure, never a source resume capability", async () => {
    const t = setup();
    t.f.report.sourceDiagnostic = sourceFailureDiagnostic({ error: { code: "LOCAL_MODEL_RPC_FAILED", diagnostics: { phase: "account/read", rpcCode: -32000, message: "PRIVATE_AUTH https://private.example/secret" } },
      phase: "MODEL_CLIENT", report: t.f.report, startedAt: Date.now(), cleanup: { browserClosed: true, modelClosed: true } });
    Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_SOURCE_DISCOVERY_FAILED" });
    await expect(t.run()).rejects.toThrow("STAGEHAND_SOURCE_DISCOVERY_FAILED");
    expect(t.client.checkpoint).toHaveBeenCalledOnce();
    const saved = t.checkpoints[0] as { stagehandFailure: { kind: string; entries: Array<{ diagnostic: { phase: string; transportCode: string } }> } };
    expect(saved.stagehandFailure.kind).toBe("OWN_STAGEHAND_FAILURE_DIAGNOSTIC");
    expect(saved.stagehandFailure.entries[0].diagnostic).toMatchObject({ phase: "MODEL_CLIENT", transportCode: "LOCAL_MODEL_RPC_FAILED" });
    expect(readStagehandFailure({ ...t.f.job, checkpoint: saved }, t.f.clock)).toEqual(saved.stagehandFailure);
    expect(readStagehandSourceCheckpoint({ ...t.f.job, attempts: 2, checkpoint: saved }, undefined, t.f.clock)).toBeUndefined();
    expect(JSON.stringify(saved)).not.toMatch(/https:|PRIVATE|leaseToken|selector|prompt|canonicalCoursePhone/);
    expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("retains both same-job failure attempts across a fresh lease without reusing diagnostics as routing evidence", async () => {
    const one = setup(); Object.assign(one.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_SOURCE_ACTION_UNAVAILABLE" });
    await expect(one.run()).rejects.toThrow("STAGEHAND_SOURCE_ACTION_UNAVAILABLE");
    const two = setup(); two.f.job.attempts = 2; two.f.job.leaseToken = "private-fresh-attempt-two-lease";
    two.f.job.checkpoint = one.checkpoints[0]; Object.assign(two.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_SOURCE_LOADING_INCOMPLETE" });
    await expect(two.run()).rejects.toThrow("STAGEHAND_SOURCE_LOADING_INCOMPLETE");
    const saved = two.checkpoints.at(-1) as { stagehandFailure: { entries: Array<{ attempt: number; code: string }> } };
    expect(saved.stagehandFailure.entries.map(entry => [entry.attempt, entry.code])).toEqual([[1, "STAGEHAND_SOURCE_ACTION_UNAVAILABLE"], [2, "STAGEHAND_SOURCE_LOADING_INCOMPLETE"]]);
    expect(two.sourceDiscover).toHaveBeenCalledOnce(); expect(two.client.candidate).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).not.toContain("private-fresh");
  });

  it("does not mask the primary failure if the failure checkpoint is rejected or ownership is already lost", async () => {
    const t = setup(), primary = Object.assign(Error("STAGEHAND_SOURCE_DISCOVERY_FAILED"), { code: "STAGEHAND_SOURCE_DISCOVERY_FAILED" });
    t.sourceDiscover.mockRejectedValue(primary); t.client.checkpoint.mockRejectedValue(Error("PRIVATE_CHECKPOINT_FAILURE"));
    await expect(t.run()).rejects.toBe(primary);
    expect(primary.discoveryMetrics.failureCheckpoint).toBe("NOT_PERSISTED");
    const lost = setup(), retired = Object.assign(Error("DISCOVERY_LEASE_REJECTED"), { code: "DISCOVERY_LEASE_REJECTED" });
    lost.sourceDiscover.mockRejectedValue(retired); await expect(lost.run()).rejects.toBe(retired);
    expect(lost.client.checkpoint).not.toHaveBeenCalled(); expect(retired.discoveryMetrics.failureCheckpoint).toBe("SKIPPED_RETIRED");
  });

  it("never writes failure diagnostics after global abort or original work deadline", async () => {
    const aborted = setup(), control = new AbortController(), reason = Error("owned abort");
    aborted.sourceDiscover.mockImplementation(async () => { control.abort(reason); return aborted.f.report; });
    await expect(aborted.run({ signal: control.signal })).rejects.toBe(reason); expect(aborted.client.checkpoint).not.toHaveBeenCalled();
    const expired = setup(); expired.sourceDiscover.mockImplementation(async () => { expired.f.clock = first + 720000; return expired.f.report; });
    await expect(expired.run()).rejects.toThrow("DISCOVERY_WORK_DEADLINE"); expect(expired.client.checkpoint).not.toHaveBeenCalled();
  });

  it("never checkpoints a cleanup callback failure after acknowledged activation retires the lease", async () => {
    const t = setup(), primary = Error("owned post-activation callback failure"); let callsAtAck = 0;
    t.afterActivate.mockImplementation(async () => { callsAtAck = t.client.checkpoint.mock.calls.length; throw primary; });
    await expect(t.run()).rejects.toBe(primary);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.client.checkpoint.mock.calls.length).toBe(callsAtAck);
    expect(primary.discoveryMetrics.failureCheckpoint).toBe("SKIPPED_RETIRED");
  });

  it("serializes failure persistence behind an in-flight replay checkpoint and retains its valid routing reference", async () => {
    const t = setup(), order: string[] = []; let release!: () => void;
    const blocked = new Promise<void>(done => { release = done; });
    t.client.checkpoint.mockImplementation(async (_id, _token, value) => {
      t.checkpoints.push(structuredClone(value));
      order.push(value.stagehandFailure ? "FAILURE" : value.stagehandProgress.phase);
      if (!value.stagehandFailure && value.stagehandProgress.phase === "INDEPENDENT_REPLAY") await blocked;
      return {};
    });
    t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: {} });
    const running = t.run(); void running.catch(() => {});
    await vi.waitFor(() => expect(order).toContain("INDEPENDENT_REPLAY")); expect(order).not.toContain("FAILURE");
    release(); await expect(running).rejects.toThrow("DISCOVERY_REPLAY_INCOMPLETE");
    expect(order.at(-1)).toBe("FAILURE");
    const saved = t.checkpoints.at(-1) as { stagehandSource: unknown; stagehandFailure: { entries: Array<{ phase: string }> } };
    expect(saved.stagehandSource).toEqual((t.checkpoints[0] as { stagehandSource: unknown }).stagehandSource);
    expect(saved.stagehandFailure.entries[0].phase).toBe("REPLAY"); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("remembers a retired lease from a queued replay checkpoint and never follows it with a failure write", async () => {
    const t = setup();
    t.client.checkpoint.mockImplementation(async (_id, _token, value) => {
      t.checkpoints.push(structuredClone(value));
      if (value.stagehandProgress.phase === "INDEPENDENT_REPLAY") throw Object.assign(Error("DISCOVERY_LEASE_REJECTED"), { code: "DISCOVERY_LEASE_REJECTED" });
      return {};
    });
    t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: {} });
    const error = await t.run().catch(value => value);
    expect(error.code).toBe("DISCOVERY_REPLAY_INCOMPLETE");
    expect(error.discoveryMetrics.failureCheckpoint).toBe("SKIPPED_RETIRED");
    expect(t.checkpoints.some(value => Object.hasOwn(value as object, "stagehandFailure"))).toBe(false);
    expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("preserves explicit native visible-link provenance through the source checkpoint without inventing legacy visibility", async () => {
    const t = setup(); Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: t.f.report.startedAt });
    t.f.report.officialLinkLedger[0].links[0].visible = true;
    const checkpoint = createStagehandSourceCheckpoint(t.f.job, t.f.report);
    expect(checkpoint.report.officialLinkLedger[0]).toMatchObject({ kind: "NATIVE_VISIBLE_DOM", observedAt: t.f.report.startedAt, links: [{ href: booking, visible: true }] });
    const legacy = setup(); const old = createStagehandSourceCheckpoint(legacy.f.job, legacy.f.report);
    expect(old.report.officialLinkLedger[0].links[0]).not.toHaveProperty("visible");
  });

  it.each(["STAGEHAND_SOURCE_ACTION_UNAVAILABLE", "STAGEHAND_SOURCE_ACTION_REJECTED", "STAGEHAND_SOURCE_LOADING_INCOMPLETE"])("preserves emitted own unresolved diagnostic %s without admitting source or recipe authority", async code => {
    const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code });
    await expect(t.run()).rejects.toThrow(code);
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    const foreign = setup(); Object.assign(foreign.f.report, { jobId: "foreign-job", outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code });
    await expect(foreign.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID");
    expect(foreign.browserFactory).not.toHaveBeenCalled(); expect(foreign.client.candidate).not.toHaveBeenCalled();
  });

  it("preserves a closed startup cause through actual worker→source SDK→private host failure without any model constructor", async () => {
    for (const code of ["STAGEHAND_NATIVE_HOST_DEADLINE", "STAGEHAND_NATIVE_HOST_FAILED", "OWNED_STAGEHAND_CDP_UNAVAILABLE", "PRIVATE_UNKNOWN_TOKEN"]) {
      const t = setup(), current = Date.now();
      t.f.clock = current; t.f.job.firstPickedUpAt = new Date(current + 2000).toISOString(); t.f.job.deadlineAt = new Date(current + 902000).toISOString();
      const processFactory = vi.fn(() => { throw Error(code); });
      await expect(t.run({ sourceDiscover: actualSourceDiscover, guardedBrowserFactory: args => createStagehandGuardedBrowserHost({ ...args, processFactory }) }))
        .rejects.toThrow(code === "PRIVATE_UNKNOWN_TOKEN" ? "STAGEHAND_SOURCE_DISCOVERY_FAILED" : code);
      expect(processFactory).toHaveBeenCalledOnce(); expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    }
  });
  it.each([-5000, 0, 2000, 5000])("clamps a valid %sms database-clock offset through the actual private host wrapper before spawn", async offset => {
    const t = setup(); t.f.clock = first - offset;
    const clock = vi.spyOn(Date, "now").mockReturnValue(t.f.clock);
    const request = vi.fn(async value => value.action === "start" ? { kind: "OWNED_GUARDED_STAGEHAND_CONTEXT",
      cdpUrl: "ws://127.0.0.1:51515/devtools/browser/" + "a".repeat(32), targetId: "owned-only" } : { browserClosed: true, providerRequestsDrained: true });
    const close = vi.fn(async () => {}), processFactory = vi.fn(() => ({ request, close }));
    let supplied;
    try {
      await expect(t.run({ sourceDiscover: async args => {
        supplied = args; const host = await args.createGuardedBrowser({ deadlineAt: args.deadlineAt, signal: args.signal });
        await host.close();
        return { ...t.f.report, outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_NATIVE_HOST_DEADLINE" };
      }, guardedBrowserFactory: args => createStagehandGuardedBrowserHost({ ...args, processFactory }) })).rejects.toThrow("STAGEHAND_NATIVE_HOST_DEADLINE");
      expect(Date.parse(supplied.deadlineAt)).toBe(Math.min(first + 240_000, t.f.clock + 240_000));
      expect(supplied.job.firstPickedUpAt).toBe(t.f.job.firstPickedUpAt);
      expect(supplied.job.deadlineAt).toBe(t.f.job.deadlineAt);
      expect(processFactory).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("rejects a database first pickup beyond the unchanged 5s allowance before source or host", async () => {
    const t = setup(); t.f.clock = first - 5001;
    await expect(t.run()).rejects.toThrow("DISCOVERY_JOB_INVALID"); expect(t.sourceDiscover).not.toHaveBeenCalled();
  });

  it("rejects an unclipped future-database-clock deadline above the four-minute host ceiling without spawning", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(first - 2000), processFactory = vi.fn();
    try {
      await expect(createStagehandGuardedBrowserHost({ cwd: process.cwd(), initialUrl: official, timeZone: "UTC",
        deadlineAt: new Date(first + 240_000).toISOString(), helperEnvironment: { COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME",
          COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_JOB_ID: "owned", COURSE_DISCOVERY_LEASE_TOKEN: "private" }, processFactory })).rejects.toThrow("STAGEHAND_NATIVE_HOST_DEADLINE");
      expect(processFactory).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("never forwards an unknown private failure string or another job's failure as an own primary cause", async () => {
    for (const change of ["unknown", "job", "recipe", "times"]) {
      const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_NATIVE_HOST_DEADLINE" });
      if (change === "unknown") t.f.report.frameworkFailureCode = "PRIVATE_TOKEN_ABC123";
      if (change === "job") t.f.report.jobId = "other-job";
      if (change === "recipe") t.f.report.recipe = { private: true };
      if (change === "times") t.f.report.matchingSlots = [{ time: "10:00" }];
      await expect(t.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID"); expect(t.client.candidate).not.toHaveBeenCalled();
    }
  });
  it("routes once, freshly inspects, validates real schema, closes, then independently verifies both backend challenges and activates", async () => {
    const t = setup(), result = await t.run();
    expect(result.outcome).toBe("activated"); expect(result.metrics).toMatchObject({ model: "gpt-6.1-sol", modelCalls: 2,
      tokenUsage: { totalTokens: 20, inputTokens: 16, outputTokens: 4 }, fixedInspectionModelCalls: 0, replayModelCalls: 0, sourceResumed: false });
    expect(t.sourceDiscover).toHaveBeenCalledOnce(); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
    expect(t.executeRecipe.mock.calls.map(([args]) => args.input)).toEqual([t.f.job.request.input, { ...t.f.job.request.input, date: "2030-01-04", players: 3 }]);
    expect(t.executeRecipe.mock.calls.every(([args]) => args.deadlineAt === t.f.job.deadlineAt)).toBe(true);
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
    expect(t.events.indexOf("closed")).toBeLessThan(t.events.indexOf("candidate"));
    expect(t.events.slice(-3)).toEqual(["before", "activate", "after"]);
    expect(t.afterActivate).toHaveBeenCalledWith({ metrics: result.metrics });
    expect(t.client.candidate.mock.calls[0][4]).toEqual({ officialUrl: official, observedBookingUrl: booking });
    expect(t.client.candidate.mock.calls[0][2]).toMatchObject({ target: t.f.job.request.target, source: { venueName: t.f.job.request.identity.name, providerFamily: "FOREUP" } });
  });

  it("passes only ordinary canonical public identity/target/input to the source SDK; never hints, demand, authority or trusted phone", async () => {
    const t = setup(); await t.run(); const args = t.sourceCalls[0] as { job: { request: object }; deadlineAt: string };
    expect(Object.keys(args.job).sort()).toEqual(["deadlineAt", "firstPickedUpAt", "id", "request"]);
    expect(Object.keys(args.job.request).sort()).toEqual(["identity", "input", "target"]);
    expect(JSON.stringify(args)).not.toMatch(/PRIVATE_HINT|old-known|leaseToken|private-new|canonicalCoursePhone|15555550123|PRIVATE_BACKEND_TOKEN|owned-search/);
    expect(args.deadlineAt).toBe(new Date(first + 240_000).toISOString());
    expect(t.browserFactory.mock.calls[0][0]).toMatchObject({ requestedInput: t.f.job.request.input, trustedContext: t.f.job.request.trustedContext });
  });

  it("uses same-job source checkpoint on attempt2 beyond240s, but runs a new native inspector and zero new models", async () => {
    const t = setup(); t.f.job.attempts = 2;
    t.f.job["checkpoint"] = { stagehandSource: createStagehandSourceCheckpoint({ ...t.f.job, attempts: 1 }, t.f.report) };
    t.f.clock = first + 260_000;
    const result = await t.run();
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.browserFactory).toHaveBeenCalledOnce();
    expect(result.metrics).toMatchObject({ sourceResumed: true, modelCalls: 0, sourceElapsedMs: 0, tokenUsage: {} });
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
  });

  it.each(["job", "fingerprint", "request", "clock", "report", "proof", "attempt"])("rejects a changed %s source checkpoint before source, browser or candidate", async change => {
    const t = setup(); t.f.job.attempts = 2;
    const ref = createStagehandSourceCheckpoint({ ...t.f.job, attempts: 1 }, t.f.report);
    t.f.job["checkpoint"] = { stagehandSource: ref }; t.f.clock = first + 140_000;
    if (change === "job") ref.jobId = "other-job";
    if (change === "fingerprint") ref.sourceFingerprint = "f".repeat(64);
    if (change === "request") t.f.job.request.input.players = 3;
    if (change === "clock") ref.deadlineAt = new Date(first + 900_001).toISOString();
    if (change === "report") ref.report.visitedUrls.push("https://invented.example/");
    if (change === "proof") { ref.report["adapter"] = { family: "FOREUP", proof: true }; ref.reportSha256 = stagehandDataHash(ref.report); }
    if (change === "attempt") ref.attempt = 2;
    await expect(t.run()).rejects.toThrow(); expect(t.sourceDiscover).not.toHaveBeenCalled();
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("missing checkpoint after source240s never starts another model run or resets original deadline", async () => {
    const t = setup(); t.f.job.attempts = 2; t.f.clock = first + 241_000;
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_BUDGET_EXHAUSTED" });
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.browserFactory).not.toHaveBeenCalled();
  });
  it("leaves 137 seconds after a 58-second first source and 45-second cooldown, without restarting the shared clock", async () => {
    const t = setup(); t.f.job.attempts = 2; t.f.clock = first + 103000;
    t.sourceDiscover.mockImplementation(async args => {
      const sourceArgs = args as { deadlineAt: string }; t.sourceCalls.push(args); expect(Date.parse(sourceArgs.deadlineAt) - t.f.clock).toBe(137000);
      Object.assign(t.f.report, { startedAt: new Date(t.f.clock).toISOString(), finishedAt: new Date(t.f.clock + 1000).toISOString(), workDeadlineAt: sourceArgs.deadlineAt });
      t.f.clock += 1000; return t.f.report;
    });
    const original = { firstPickedUpAt: t.f.job.firstPickedUpAt, deadlineAt: t.f.job.deadlineAt };
    await t.run(); expect(t.sourceDiscover).toHaveBeenCalledOnce();
    expect(t.f.job).toMatchObject(original); expect(t.f.job.attempts).toBe(2);
  });

  it("retains returned completed-call lower bounds when source completes at the deadline without a metrics callback", async () => {
    const t = setup(); t.sourceDiscover.mockImplementation(async () => { t.f.clock = first + 240_000; return t.f.report; });
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_BUDGET_EXHAUSTED", discoveryMetrics: {
      modelCalls: 2, tokenUsage: { totalTokens: 20, inputTokens: 16, outputTokens: 4 }, sourceUsageRecordedLowerBound: true } });
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it.each(["recipe", "times", "mode", "model", "effort", "job", "clock", "browser", "modelCleanup", "proposal", "unresolved"])("rejects %s source authority/report mismatch before fixed inspection", async change => {
    const t = setup(), r = t.f.report;
    if (change === "recipe") r.recipe = { engine: "BROWSER_DOM" };
    if (change === "times") r.matchingSlots.push({ startsAt: "2030-01-03T10:00:00Z" });
    if (change === "mode") r.frameworkMode = "NATIVE_FRAMEWORK";
    if (change === "model") r.metrics.model = "forbidden";
    if (change === "effort") r.metrics.reasoningEffort = "low";
    if (change === "job") r.jobId = "other-job";
    if (change === "clock") r.deadlineAt = new Date(first + 900_001).toISOString();
    if (change === "browser") r.browserClosed = false;
    if (change === "modelCleanup") r.modelClosed = false;
    if (change === "proposal") r.adapterSourceProposal["metadata"] = { family: "FOREUP" };
    if (change === "unresolved") r.outcome = "UNRESOLVED";
    await expect(t.run()).rejects.toThrow(); expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("source checkpoint contains exact actual provenance but no prose, hidden phone, model adapter or executable data", () => {
    const f = fixture(); f.report["evidenceSummary"] = "PRIVATE_MODEL_PROSE"; f.report["adapter"] = { proof: "PRIVATE_PROOF" };
    const value = createStagehandSourceCheckpoint(f.job, f.report), text = JSON.stringify(value);
    expect(text).not.toMatch(/PRIVATE_MODEL|PRIVATE_PROOF|canonicalCoursePhone|15555550123|leaseToken|private-new/);
    expect(value.report.officialLinkLedger).toEqual(f.report.officialLinkLedger);
    expect(value.report.actions[0].observedTarget.href).toBe(booking);
    expect(observedInspectionPath(value.report, official, booking)).toEqual([official, booking]);
    expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: { stagehandSource: value } }, undefined, first + 140_000)?.report)
      .toEqual(value.report);
  });

  it("oversized full provenance fails honestly rather than truncating selected source/path", async () => {
    const t = setup(); t.f.report.officialLinkLedger[0].links.push(...Array.from({ length: 100 }, (_, n) => ({ href: "https://extra.example/" + n + "x".repeat(400) })));
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_CHECKPOINT_LIMIT" });
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it.each(["missing", "query", "unclicked"])("does not grant source authority to an %s observed edge", async change => {
    const t = setup();
    if (change === "missing") t.f.report.officialLinkLedger = [];
    if (change === "query") t.f.report.adapterSourceProposal.bookingUrl += "&invented=1";
    if (change === "unclicked") t.f.report.actions = [];
    await expect(t.run()).rejects.toThrow(); expect(t.browserFactory).not.toHaveBeenCalled();
  });

  it("requires the exact fresh native link, not a cached source-ledger claim", async () => {
    const t = setup(); t.request.mockImplementation(async () => ({ url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [], adapter: undefined }));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_PATH_STALE" });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it.each(["valid", "ambiguous", "wrongCompletion", "missingCompletion"] as const)("fresh Bay 1 placeholder requires its private completed document: %s", async mode => {
    const t = setup(), destination = "https://public-bay.example/services", href = official + "#", target = "a0000000-0000-4000-8000-000000000001";
    const observedAt = t.f.report.startedAt, completedAt = t.f.report.finishedAt, rootBinding = "a".repeat(64), finalBinding = "b".repeat(64);
    t.f.report.adapterSourceProposal.bookingUrl = destination;
    t.f.report.visitedUrls = [official, destination];
    t.f.report.officialLinkLedger = [{ kind: "NATIVE_VISIBLE_DOM", pageUrl: official, observedAt, documentHash: "c".repeat(64),
      links: [{ href, visible: true, text: "Book Bay 1", label: "" }] }];
    t.f.report.actions = [{ sourceUrl: official, action: { method: "click" },
      observedTarget: { tag: "A", href, text: "Book Bay 1", label: "" }, afterUrl: destination, openedNewPage: false }];
    t.f.report.nativeGestureNavigations = [{ kind: "NATIVE_GESTURE_SOURCE_OPEN", pageUrl: official, href, text: "Book Bay 1", label: "",
      observedAt, documentHash: "c".repeat(64), targetUrl: destination, finalUrl: destination, finalStatus: 200, completedAt,
      finalDocumentHash: "d".repeat(64), redirects: [] }];
    expect(observedInspectionPath(t.f.report, official, destination)).toEqual([official, destination]);
    const calls: unknown[] = [];
    const processFactory = () => ({ request: async (action: { action: string; target?: string }) => {
      calls.push(action);
      const final = action.action === "click" || action.action === "inspect_adapter", url = final ? destination : official;
      if (action.action === "click") expect(action.target).toBe(target);
      return { url, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
        controls: final ? [] : [{ kind: "link", href, target, name: "Book Bay 1", label: "" },
          { kind: "link", href, target: "a0000000-0000-4000-8000-000000000002", name: mode === "ambiguous" ? "Book Bay 1" : "Book Bay 2", label: "" }],
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(url),
          currentUrlSha256: stagehandDataHash(url), documentBindingSha256: final ? finalBinding : rootBinding, observedAt: t.f.clock, status: 200 },
        ...(action.action === "click" && mode !== "missingCompletion" ? { nativeGestureCompletion: { kind: "NATIVE_GESTURE_COMPLETED_V1", sourceUrl: official, href,
          text: mode === "wrongCompletion" ? "Book Bay 2" : "Book Bay 1", label: "", targetUrl: destination, finalUrl: destination,
          redirects: [], documentBindingSha256: finalBinding, observedAt: t.f.clock } } : {}),
        adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined };
    }, close: t.close });
    t.browserFactory.mockImplementation(async options => createDiscoveryBrowser({ ...options, processFactory }));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t.f.clock);
    try {
      if (mode === "valid") await t.run();
      else {
        await expect(t.run()).rejects.toThrow(mode === "ambiguous" ? "TEST_GENERIC_HANDOFF_REJECTED" : undefined);
        expect(t.genericWorker).toHaveBeenCalledTimes(mode === "ambiguous" ? 1 : 0);
        expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
      }
      expect(calls.filter((action: { action: string }) => action.action === "click")).toEqual(mode === "ambiguous" ? [] : [{ action: "click", target }]);
      expect(calls.some((action: { action: string; url?: string }) => action.action === "open" && action.url === destination)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("treats an unclicked visible native DOM href only as routing and still requires two fresh server challenges", async () => {
    const t = setup(); t.f.report.actions = []; t.f.report.visitedUrls = [official];
    Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: t.f.report.startedAt });
    t.f.report.officialLinkLedger[0].links[0].visible = true;
    await t.run();
    expect(t.request.mock.calls[0][0]).toEqual({ action: "open", url: official });
    expect(t.request.mock.calls.some(([action]) => action.action === "inspect_adapter")).toBe(true);
    expect(t.client.candidate).toHaveBeenCalledOnce(); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
  });

  it("rejects an unclicked visible DOM proposal when its exact link is absent from the fresh native document", async () => {
    const t = setup(); t.f.report.actions = []; t.f.report.visitedUrls = [official];
    Object.assign(t.f.report.officialLinkLedger[0], { kind: "NATIVE_VISIBLE_DOM", observedAt: t.f.report.startedAt });
    t.f.report.officialLinkLedger[0].links[0].visible = true;
    t.request.mockImplementation(async () => ({ url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [], adapter: undefined }));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_PATH_STALE" });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("a currently visible observed iframe is routing evidence, but still requires fresh native frame admission and typed inspection", async () => {
    const t = setup(); t.f.report.actions = []; t.f.report.visitedUrls = [official];
    t.f.report.officialLinkLedger = []; t.f.report.frameLedger = [{ pageUrl: official, frames: [{ src: booking, visible: true }] }];
    t.request.mockImplementation(async action => ({ url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [], frames: [{ source: "OFFICIAL_IFRAME_SRC", url: booking }],
      adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined }));
    await t.run(); expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.sourceDiscover).toHaveBeenCalledOnce();
  });

  it("hands an unclicked private native frame witness to a fresh fixed inspector before two independent replays", async () => {
    const t = setup(); t.f.report.actions = []; t.f.report.visitedUrls = [official]; t.f.report.officialLinkLedger = [];
    Object.assign(t.f.report, { nativeFrameNavigations: [], frameLedger: [{ kind: "NATIVE_VISIBLE_FRAME", pageUrl: official,
      observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64), frames: [{ src: booking, visible: true }] }] });
    t.browserFactory.mockImplementation(async options => {
      expect(options).toMatchObject({ fixedInspection: true, fixedInspectionFrameWitness: {
        kind: "FIXED_INSPECTION_SOURCE_FRAME", officialUrl: official, parentUrl: official, frameUrl: booking,
        sourceReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      } });
      return createDiscoveryBrowser({ ...options, processFactory: () => ({ request: t.request, close: t.close }) }) as never;
    });
    let current = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") current = action.url!;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
        accessRequirementObserved: false, controls: [], frames: current === official ? [{ source: "FIXED_INSPECTION_FRAME_SRC", url: booking }] : [],
        officialSourceDiagnostic: { rawOfficialCaptured: true, currentOfficialDocument: false },
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(current),
          currentUrlSha256: stagehandDataHash(current), documentBindingSha256: (current === official ? "a" : "b").repeat(64), observedAt: t.f.clock, status: 200 },
        adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined } as never;
    });
    await t.run();
    expect(t.request.mock.calls.filter(([action]) => action.action !== "finish").map(([action]) => action)).toEqual([{ action: "open", url: official }, { action: "open", url: booking }, { action: "inspect_adapter", url: booking }]);
    expect(t.client.candidate).toHaveBeenCalledOnce(); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
  });

  it("opens an exact fresh officially linked CPS context before its first inspector without relabelling the official parent", async () => {
    const t = setup(), source = "https://new-public-course.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.999722222222225";
    t.f.report.adapterSourceProposal.bookingUrl = source; t.f.report.visitedUrls = [official, source];
    t.f.report.officialLinkLedger[0].links = [{ href: source }];
    t.f.report.actions[0].observedTarget.href = source; t.f.report.actions[0].afterUrl = source;
    let current = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") current = action.url ?? current;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
        controls: current === official ? [{ kind: "link", href: source }] : [],
        adapter: action.action === "inspect_adapter" ? { family: "CPS", tenant: "new-public-course", courseIds: [91], catalogHash: "c".repeat(64) } : undefined };
    });
    await t.run();
    expect(t.request.mock.calls.map(([value]) => value)).toEqual([{ action: "open", url: official }, { action: "open", url: source }, { action: "inspect_adapter", url: source }]);
    expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(source);
  });

  it.each(["valid", "unobservedRoot", "noPrivateProof", "noHttpChain", "arbitraryHop", "foreignHost", "checkout", "changedReopen", "staleProof", "incompleteReplay"])
  ("adopts only a fresh private Acuity root HTTP destination and independently binds canonical inspection/replays: %s", async mode => {
    const t = setup(), root = "https://public-rental.as.me/", canonical = root + "schedule/AbCd1234";
    const final = mode === "foreignHost" ? "https://foreign-rental.as.me/schedule/AbCd1234" : mode === "checkout" ? root + "checkout" : canonical;
    Object.assign(t.f.job.request.target, { kind: "SIMULATOR", offeringId: "unseen-offering" });
    Object.assign(t.f.job.request.input, { durationMinutes: 60 });
    t.f.report.adapterSourceProposal.bookingUrl = root; t.f.report.actions = []; t.f.report.visitedUrls = [official]; t.f.report.officialLinkLedger = [];
    Object.assign(t.f.report, { nativeFrameNavigations: [], frameLedger: mode === "unobservedRoot" ? [] : [{ kind: "NATIVE_VISIBLE_FRAME", pageUrl: official,
      observedAt: new Date(first + 1000).toISOString(), documentHash: "a".repeat(64), frames: [{ src: root, visible: true }] }] });
    t.browserFactory.mockImplementation(async options => createDiscoveryBrowser({ ...options,
      processFactory: () => ({ request: t.request, close: t.close }) }) as never);
    let current = official, original = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") {
        original = action.url!;
        current = original === root ? final : mode === "changedReopen" && original === canonical ? root + "schedule/Changed9" : original;
      }
      if (action.action === "inspect_adapter" && action.url !== canonical)
        throw Object.assign(Error("bare research root is not managed metadata"), { code: "INVALID_ADAPTER_SOURCE" });
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
        accessRequirementObserved: false, controls: [], frames: current === official ? [{ source: "FIXED_INSPECTION_FRAME_SRC", url: root }] : [],
        officialSourceDiagnostic: { rawOfficialCaptured: true, currentOfficialDocument: false },
        ...(original === root && mode !== "noHttpChain" ? { nativeRoutingDocumentRedirects: mode === "arbitraryHop" ? [
          { fromUrl: root, toUrl: root + "unreviewed-routing", status: 302, completed: true },
          { fromUrl: root + "unreviewed-routing", toUrl: final, status: 302, completed: true },
        ] : [{ fromUrl: root, toUrl: root + "schedule.php", status: 302, completed: true },
          { fromUrl: root + "schedule.php", toUrl: final, status: 302, completed: true }] } : {}),
        ...(mode === "noPrivateProof" && original === root ? {} : { nativeMainDocumentContinuity: {
          kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(original), currentUrlSha256: stagehandDataHash(current),
          documentBindingSha256: (current === official ? "a" : "b").repeat(64), observedAt: t.f.clock - (mode === "staleProof" && original === root ? 5001 : 0), status: 200 } }),
        adapter: action.action === "inspect_adapter" ? { family: "ACUITY", ownerKey: "AbCd1234", businessId: "123", rentalProductIds: ["456"] } : undefined } as never;
    });
    if (mode === "incompleteReplay") t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "SOURCE_CHANGED" } });
    const genericWorker = vi.fn(async () => { throw Error("UNEXPECTED_GENERIC_WORKER"); });
    if (mode === "valid") {
      await t.run({ genericWorker });
      expect(t.request.mock.calls.filter(([a]) => a.action !== "finish").map(([a]) => a)).toEqual([
        { action: "open", url: official }, { action: "open", url: root }, { action: "open", url: canonical }, { action: "inspect_adapter", url: canonical }]);
      expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(canonical);
      expect(t.executeRecipe).toHaveBeenCalledTimes(2);
      for (const index of [1, 2]) expect(t.executeRecipe).toHaveBeenNthCalledWith(index,
        expect.objectContaining({ recipe: expect.objectContaining({ source: expect.objectContaining({ bookingUrl: canonical }) }) }));
      expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
      expect(genericWorker).not.toHaveBeenCalled();
    } else {
      await expect(t.run({ genericWorker })).rejects.toBeTruthy();
      if (mode !== "incompleteReplay") expect(t.client.candidate).not.toHaveBeenCalled();
      expect(t.client.activate).not.toHaveBeenCalled();
    }
    if (mode === "unobservedRoot") { expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.close).not.toHaveBeenCalled(); }
    else expect(t.close).toHaveBeenCalledOnce();
  });

  it.each([true, false])("fresh official alias transition requires its exact native attestation (present=%s)", async present => {
    const t = setup(), alias = "https://fresh-official-alias.example/";
    t.request.mockImplementation(async action => ({ url: alias, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [{ kind: "link", href: booking }],
      ...(present ? { nativeDocumentRedirects: [{ fromUrl: official, toUrl: alias, status: 301, completed: true }] } : {}),
      adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined }));
    if (present) { await t.run(); expect(t.client.activate).toHaveBeenCalledOnce(); }
    else { await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_LANDING_CHANGED" }); expect(t.client.candidate).not.toHaveBeenCalled(); }
  });

  it("a failed metadata schema never reaches the candidate API, even with a valid observed source", async () => {
    const t = setup(); t.validateRecipe.mockResolvedValue({ valid: false });
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_METADATA_INVALID" });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("never downgrades native-only helper transport, even when source used a signed-out public browser", async () => {
    const t = setup(); t.client.helperEnvironment.mockImplementation(() => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "PINNED_HTTP" }));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_SCOPE_INVALID" });
    expect(t.browserFactory).not.toHaveBeenCalled();
  });

  it("preserves the primary fixed-reader failure when cleanup also fails; no method is submitted", async () => {
    const t = setup(), primary = Object.assign(Error("private body"), { code: "MINDBODY_PUBLIC_FILTER_UNSETTLED" });
    t.request.mockRejectedValue(primary); t.close.mockRejectedValue(Error("cleanup private"));
    await expect(t.run()).rejects.toBe(primary); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(JSON.stringify(primary["discoveryMetrics"])).not.toMatch(/private body|cleanup private/);
  });

  it("a cleanup failure after inspection prevents candidate/activation", async () => {
    const t = setup(); t.close.mockRejectedValue(Error("private cleanup"));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_CLOSE_FAILED" });
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("incomplete independent replay never becomes verification or activation; closed replay facts retain source routing for retry", async () => {
    const t = setup(); t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_IDENTITY_MISMATCH", raw: "PRIVATE_HTML" } });
    await expect(t.run()).rejects.toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE" });
    expect(t.client.verification).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(t.checkpoints)).not.toContain("PRIVATE_HTML");
    const last = t.checkpoints.at(-1) as { stagehandSource: { report: object }; stagehandProgress: { replay: { result: { complete: boolean } } } };
    expect(last.stagehandSource.report).toBeTruthy(); expect(last.stagehandProgress.replay.result.complete).toBe(false);
  });

  it("executes only server challenges, honors completed challenge flags, and drains replay checkpoint writes before activation hooks", async () => {
    const t = setup(); t.client.candidate.mockResolvedValue({ recipeHash: "b".repeat(64), challenges: [
      { id: "old-completed", recipeHash: "b".repeat(64), input: { players: 4 }, completed: true },
      { id: "fresh-challenge", recipeHash: "b".repeat(64), input: { ...t.f.job.request.input, date: "2030-01-05", players: 3 } },
    ] });
    await t.run(); expect(t.executeRecipe).toHaveBeenCalledOnce(); expect(t.client.verification).toHaveBeenCalledOnce();
    expect(t.executeRecipe.mock.calls[0][0].input.date).toBe("2030-01-05");
  });

  it("honors original work deadline and pre-existing cancellation without any source/model request", async () => {
    const t = setup(); t.f.clock = first + 720_000;
    await expect(t.run()).rejects.toMatchObject({ code: "DISCOVERY_WORK_DEADLINE" });
    expect(t.sourceDiscover).not.toHaveBeenCalled();
    t.f.clock = first + 2000; const abort = new AbortController(); abort.abort(Error("cancelled"));
    await expect(t.run({ signal: abort.signal })).rejects.toThrow("cancelled");
    expect(t.sourceDiscover).not.toHaveBeenCalled();
  });

  it("prepares only injected readiness before a claim, without constructing any model or browser", async () => {
    const ready = vi.fn(async args => ({ ready: true, cwd: args.cwd }));
    await expect(prepareCourseDiscoveryStagehandWorker({ cwd: "/owned-checkout", prepareSourceDiscovery: ready })).resolves.toMatchObject({ ready: true });
    expect(ready).toHaveBeenCalledWith({ cwd: "/owned-checkout" });
  });

  it("reports copied bounded metrics while diagnostic listener failure cannot alter activation", async () => {
    const t = setup(), samples: unknown[] = [];
    const result = await t.run({ onMetrics: value => { samples.push(value); value.modelCalls = 999; throw Error("listener private"); } });
    expect(samples.length).toBeGreaterThan(1); expect(result.metrics.modelCalls).toBe(2);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(JSON.stringify(samples)).not.toMatch(/PRIVATE_BACKEND_TOKEN|private-new-owned-lease/);
  });

  it.each(["https://public.example/?token=private", "https://public.example/ASP/appt_req.asp", "https://public.example/ASP%2fappt_req.asp", "https://127.0.0.1/", "https://public.example/login"])("never admits an unsafe or transaction source %s", url => {
    expect(publicStagehandSourceUrl(url)).toBe(false);
  });
  it("public integer memberStoreId routing remains exact and credential names stay denied", () => {
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=12")).toBe(true);
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=12&memberStoreId=13")).toBe(false);
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=private")).toBe(false);
  });
});
