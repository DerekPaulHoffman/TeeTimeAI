// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runCourseDiscoveryStagehandWorker, PUBLIC_ROUTING_FALLBACK_CODES } from "../../../scripts/automation/course-discovery-stagehand-worker.mjs";
import { inspectStagehandAdapter, currentStagehandPublicRoutingRecovery } from "../../../scripts/automation/course-discovery-stagehand-inspection.mjs";
import { createDiscoveryBrowser, createDiscoveryAdapterObservation, bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence,
  verifyDiscoveryCandidate, DISCOVERY_GENERIC_LIMITS } from "../../../scripts/automation/course-discovery-worker.mjs";
import { stagehandDataHash } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";

const first = Date.parse("2030-01-02T12:00:00.000Z"), official = "https://routing-fixture.example/", booking = "https://public-routing-fixture.example/availability";
function setup(reason: "path" | "pending", mode = "valid") {
  let clock = first + 2000;
  const job = { id: "routing-fixture-job", leaseToken: "private-owned-fixture-lease", attempts: 1, sourceFingerprint: "a".repeat(64),
    firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900000).toISOString(),
    request: { target: { courseId: "routing-fixture-course", kind: "OUTDOOR" }, demand: { searchId: "routing-fixture-search", alertGeneration: 2 },
      identity: { name: "Routing Fixture Golf", officialUrl: official, address: "10 Public Road, Example City, CA 90001", timeZone: "UTC" },
      input: { date: "2030-01-03", timeZone: "UTC", players: 2, startTime: "08:00", endTime: "18:00" } } };
  const report = { framework: { name: "Stagehand", version: "4.3.0" }, jobId: job.id, firstPickedUpAt: job.firstPickedUpAt,
    deadlineAt: job.deadlineAt, workDeadlineAt: new Date(first + 120000).toISOString(), startedAt: new Date(first + 100).toISOString(), finishedAt: new Date(first + 1500).toISOString(),
    frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY", frameworkExtractedTimes: false,
    outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
    adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking }, visitedUrls: [official, booking],
    officialLinkLedger: [{ pageUrl: official, links: [{ href: booking }] }], frameLedger: [],
    actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: booking }, afterUrl: booking }],
    initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 }, metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium",
      localCodexCalls: [{ model: "gpt-6.1-sol", usage: { totalTokens: 20, inputTokens: 16, outputTokens: 4 } }] } };
  const abort = new AbortController(), checkpoints: unknown[] = [];
  let current = official;
  const request = vi.fn(async (action: { action: string; url?: string }) => {
    if (mode === "forgedError") throw Object.assign(Error("PRIVATE"), { code: "FRAMEWORK_INSPECTION_PATH_STALE", inspectionReceipt: { browserClosed: true, outcome: "FAILED" } });
    if (mode === "network") throw Object.assign(Error("PRIVATE"), { code: "BROWSER_NAVIGATION_FAILED" });
    if (mode === "identity") throw Object.assign(Error("PRIVATE"), { code: "ADAPTER_IDENTITY_MISMATCH" });
    if (action.action === "open") current = action.url!;
    if (action.action === "inspect_adapter") throw Object.assign(Error("PRIVATE"), { code: "FRAMEWORK_INSPECTION_PATH_STALE" });
    return { url: current, browserTransport: mode === "transport" ? "PINNED_HTTP" : "NATIVE_CHROME", navigationStatus: mode === "non200" ? 403 : 200,
      accessRequirementObserved: mode === "access", ...(mode === "fatal" ? { nativeFirstFatal: { code: "NATIVE_REDIRECT_NETWORK_FAILED" } } : {}),
      loading: reason === "pending", pendingRequestCount: reason === "pending" ? 1 : 0,
      controls: mode === "metadataError" && current === official ? [{ kind: "link", href: booking }] : [], frames: [],
      officialSourceDiagnostic: { rawOfficialCaptured: true, currentOfficialDocument: true, renderedAddressesPresent: reason !== "pending", renderedLinksPresent: reason !== "pending" },
      ...(mode === "noPrivateProof" ? {} : { nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: stagehandDataHash(current),
        currentUrlSha256: stagehandDataHash(current), documentBindingSha256: "c".repeat(64), observedAt: clock - (mode === "staleNative" ? 5001 : 0), status: 200 } }) };
  });
  const close = vi.fn(async () => {
    if (mode === "closeFailure") throw Error("PRIVATE");
    if (mode === "lateClose") clock += 5001;
    if (mode === "deadline") clock = first + 720000;
    if (mode === "cancel") abort.abort(Object.assign(Error("PRIVATE"), { code: "DISCOVERY_CANCELLED" }));
  });
  const browserFactory = vi.fn(async options => createDiscoveryBrowser({ ...options, processFactory: () => ({ request, close }) }));
  const client = { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_ID: job.id,
    COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken }),
    checkpoint: vi.fn(async (_id, _token, value) => {
      if (mode === "retiredLease" && value.stagehandProgress?.phase === "FIXED_INSPECTION_FAILED") throw Object.assign(Error("PRIVATE"), { code: "DISCOVERY_LEASE_REJECTED" });
      checkpoints.push(structuredClone(value)); return {};
    }),
    candidate: vi.fn(async () => ({ recipeHash: "b".repeat(64), challenges: [
      { id: "fixture-one", recipeHash: "b".repeat(64), input: job.request.input },
      { id: "fixture-two", recipeHash: "b".repeat(64), input: { ...job.request.input, players: 3 } },
    ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({ activated: true })) };
  const executeRecipe = vi.fn(async () => ({ status: "AVAILABLE", complete: true, slots: [], evidence: { venueVerified: true, dateVerified: true,
    capacityVerified: true, durationVerified: true, completeVerified: true } }));
  const beforeActivate = vi.fn(async () => {}), afterActivate = vi.fn(async () => {});
  const sourceDiscover = vi.fn(async () => report), validateRecipe = vi.fn(async () => ({ valid: true }));
  const genericWorker = vi.fn(async options => {
    expect(close).toHaveBeenCalledOnce(); expect(options.freshOfficialStart).toBe(true); expect(options.job).toBe(job);
    expect(options.workDeadlineAt).toBe(new Date(first + 720000).toISOString()); expect(options.recipeEngineConstraint).toBeUndefined();
    expect(options.checkpointProvenance).not.toHaveProperty("controller");
    expect(options.checkpointProvenance.stagehandFailure.entries.at(-1).cleanup.inspectionBrowserClosed).toBe(true);
    const activation = await verifyDiscoveryCandidate({ client: options.client, job: options.job, recipe: { engine: "BROWSER_DOM" },
      sourceEvidence: { officialUrl: official, observedBookingUrl: official }, executeRecipe,
      beforeActivate: options.beforeActivate, afterActivate: () => options.afterActivate({ metrics: { completedModelTurns: 1 } }) });
    return { outcome: "activated", activation, metrics: { completedModelTurns: 1 } };
  });
  const run = () => runCourseDiscoveryStagehandWorker({ job, client, cwd: process.cwd(), now: () => clock, signal: abort.signal,
    workDeadlineAt: new Date(first + 720000).toISOString(), sourceDiscover, browserFactory, validateRecipe, executeRecipe, genericWorker, beforeActivate, afterActivate });
  const inspect = () => inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal, job, client, cwd: process.cwd(),
    workDeadlineAt: new Date(first + 720000).toISOString(), now: () => clock, signal: abort.signal,
    worker: { createDiscoveryBrowser: browserFactory, validateDiscoveryRecipe: validateRecipe, createDiscoveryAdapterObservation, bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence } });
  return { job, report, run, inspect, genericWorker, sourceDiscover, client, executeRecipe, request, close, beforeActivate, afterActivate, checkpoints, now: () => clock };
}

describe("private public-routing failure recovery", () => {
  it.each(["path", "pending"] as const)("restarts %s only from a fresh canonical root after actual private clean inspection, then verifies twice", async reason => {
    const t = setup(reason), before = structuredClone(t.job), result = await t.run();
    expect(t.job).toEqual(before); expect(t.genericWorker).toHaveBeenCalledOnce(); expect(result.outcome).toBe("activated");
    expect(result.metrics.genericFallback.trigger).toBe(reason === "path" ? "FRAMEWORK_INSPECTION_PATH_STALE" : "FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED");
    expect(t.executeRecipe).toHaveBeenCalledTimes(2); expect(t.client.verification).toHaveBeenCalledTimes(2);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.beforeActivate).toHaveBeenCalledOnce(); expect(t.afterActivate).toHaveBeenCalledOnce();
    expect(t.request.mock.calls.every(([action]) => ["open", "observe", "finish"].includes(action.action))).toBe(true);
  });
  it.each(["noPrivateProof", "staleNative", "access", "non200", "fatal", "transport", "network", "identity", "forgedError", "metadataError", "closeFailure", "lateClose", "deadline", "cancel", "retiredLease"])
    ("never restarts for %s", async mode => {
      const t = setup("path", mode); await expect(t.run()).rejects.toBeDefined();
      expect(t.genericWorker).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    });
  it("never upgrades an incomplete independent replay or changes the normal budget caps", async () => {
    const t = setup("path"); t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: {} } as never);
    await expect(t.run()).rejects.toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE" }); expect(t.client.activate).not.toHaveBeenCalled();
    expect(DISCOVERY_GENERIC_LIMITS).toEqual({ toolOperations: 16, totalTokens: 128000, uncachedInputTokens: 32000, outputTokens: 8192 });
    expect(PUBLIC_ROUTING_FALLBACK_CODES).toEqual(["FRAMEWORK_INSPECTION_PATH_STALE", "FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED"]);
  });
  it.each(PUBLIC_ROUTING_FALLBACK_CODES)("does not recover %s from source discovery or an uploaded receipt", async code => {
    const t = setup("path"), error = Object.assign(Error("PRIVATE"), { code, inspectionReceipt: { outcome: "FAILED", browserClosed: true } });
    t.sourceDiscover.mockRejectedValue(error); await expect(t.run()).rejects.toBe(error);
    expect(t.genericWorker).not.toHaveBeenCalled(); expect(t.request).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("preserves a trusted nonretryable generic guard and its separate usage after the fresh-root handoff", async () => {
    const t = setup("path"), stop = { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED", limit: "uncachedInputTokens" };
    t.genericWorker.mockRejectedValue(Object.assign(Error("PRIVATE"), { code: stop.code, discoveryMetrics: { tokenUsage: { inputTokens: 32001 }, genericBudget: { stop } } }));
    const failure = await t.run().catch(error => error);
    expect(failure.code).toBe(stop.code); expect(failure.discoveryMetrics.genericFallback.worker.genericBudget.stop).toEqual(stop);
    expect(t.genericWorker).toHaveBeenCalledOnce(); expect(t.client.activate).not.toHaveBeenCalled();
  });
  it("keeps the recovery witness private, fresh, and bound to the exact original owned attempt", async () => {
    const t = setup("path"), error = await t.inspect().catch(error => error), start = first + 2000;
    expect(currentStagehandPublicRoutingRecovery(error, t.job, start, t.now())).toMatchObject({ code: "FRAMEWORK_INSPECTION_PATH_STALE", lastAction: "observe" });
    expect(currentStagehandPublicRoutingRecovery({ ...error }, t.job, start, t.now())).toBeUndefined();
    expect(currentStagehandPublicRoutingRecovery(error, structuredClone(t.job), start, t.now())).toBeUndefined();
    expect(currentStagehandPublicRoutingRecovery(error, t.job, start, t.now() + 5001)).toBeUndefined();
    expect(currentStagehandPublicRoutingRecovery(error, t.job, start + 1, t.now())).toBeUndefined();
    for (const [key, value] of [["id", "foreign-fixture-job"], ["attempts", 2], ["leaseToken", "foreign-owned-fixture-lease"], ["sourceFingerprint", "d".repeat(64)], ["deadlineAt", new Date(first + 1000000).toISOString()]] as const) {
      const previous = t.job[key]; Object.assign(t.job, { [key]: value });
      expect(currentStagehandPublicRoutingRecovery(error, t.job, start, t.now())).toBeUndefined(); Object.assign(t.job, { [key]: previous });
    }
    t.job.request.demand.alertGeneration = 3; expect(currentStagehandPublicRoutingRecovery(error, t.job, start, t.now())).toBeUndefined();
    t.job.request.demand.alertGeneration = 2; t.job.request.input.players = 3;
    expect(currentStagehandPublicRoutingRecovery(error, t.job, start, t.now())).toBeUndefined();
  });
});
