// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { projectGenericFailureDiagnostic } from "./generic-failure-diagnostic";
import { makeWorkerTerminalDiagnostic, parseWorkerTerminalDiagnostic } from "../../../scripts/automation/course-discovery-terminal-diagnostic.mjs";
import { createCourseDiscoveryClient } from "../../../scripts/automation/course-discovery-client.mjs";
const m = vi.hoisted(() => ({ current: vi.fn(), owner: vi.fn(), report: vi.fn(), simulator: vi.fn(),
  db: { $queryRaw: vi.fn(), $transaction: vi.fn(), courseDiscoveryJob: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    simulatorSupportIncident: { findUnique: vi.fn() }, courseSupportIncident: { findUnique: vi.fn(), updateMany: vi.fn() } } }));
vi.mock("@/lib/prisma", () => ({ prisma: m.db }));
vi.mock("./service", () => ({ currentDiscoveryEngineeringFailure: m.current }));
vi.mock("./legacy-exclusion", () => ({ hasLegacyDiscoveryOwner: m.owner,
  excludeDiscoveryPilotTargets: (targets: unknown[]) => targets }));
vi.mock("@/lib/automation/support-incidents", () => ({ reportCourseSupportIssue: m.report }));
vi.mock("@/lib/automation/simulator-support-incidents", () => ({ reconcileSimulatorSupportIncidentFailure: m.simulator }));
import { currentDiscoveryEngineeringHandoff, discoveryEngineeringContext, discoveryEngineeringReceipt,
  discoveryFailureDiagnosis, getOwnedLearningBookingEdgeEvidence, getOwnedLearningFailureEvidence, readRetainedStagehandRoutingEvidence, reconcileDiscoveryEngineeringHandoffs } from "./engineering-repair";
import { collectBookingEdgeEvidence } from "./booking-edge-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { listCourseSupportDispatchCandidates } from "@/lib/automation/course-support-batches";
import { sanitizeResponderValue } from "@/lib/automation/course-support-responder-policy";
import { createDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";
import { cpsCatalogIdentityFailureStages } from "./cps-source";
import { safeFixedInspectionSourceDiagnostic, safeBrowserFailureDiagnostics } from "../../../scripts/automation/course-discovery-worker.mjs";
import { stagehandDataHash, createStagehandSourceCheckpoint } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
const now = new Date("2030-01-01T12:16:00Z"), picked = new Date("2030-01-01T12:00:00Z");
let failure: ReturnType<typeof fixture>;
let outdoorIncident: { id: string; courseId: string; status: string; updatedAt: Date; firstSeenAt: Date; attemptLedger: unknown; activeBatchId: string | null };
function fixture() { return { job: { id: "job1", targetKey: "course:course1", courseId: "course1", offeringId: null as string | null,
  status: "FAILED", outcome: "TOOL_FAILURE", attempts: 2, activeTargetKey: null, sourceFingerprint: "a".repeat(64),
  baseRecipeId: "recipe1", firstPickedUpAt: picked, deadlineAt: new Date("2030-01-01T12:15:00Z"), completedAt: new Date("2030-01-01T12:02:00Z"),
  updatedAt: picked, checkpoint: { stagehandProgress: { phase: "INDEPENDENT_REPLAY" }, stagehandFailure: { code: "ADAPTER_CONFIGURATION_CHANGED" } },
  result: null as unknown }, source: { course: { id: "course1" }, identity: { officialUrl: "https://official.example/" } },
  request: { demand: { searchId: "search1" }, target: { courseId: "course1" } } }; }
function receipt() { return { version: 1, state: "QUEUED", incidentId: "incident1", queuedAt: now.toISOString(), sourceFingerprint: "a".repeat(64) }; }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("COURSE_DISCOVERY_ENABLED", "true"); vi.stubEnv("COURSE_DISCOVERY_ROLLOUT_MODE", "GENERAL");
  failure = fixture(); m.current.mockImplementation(async () => failure); m.owner.mockResolvedValue(false);
  m.db.$queryRaw.mockResolvedValue([{ id: "job1" }]); m.db.$transaction.mockImplementation(async f => f(m.db));
  m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? null : failure.job);
  m.db.courseDiscoveryJob.findMany.mockImplementation(async () => [failure.job]);
  m.db.courseDiscoveryJob.updateMany.mockImplementation(async ({ data }) => { failure.job.result = data.result; return { count: 1 }; });
  outdoorIncident = { id: "incident1", courseId: "course1", status: "AUTO_INVESTIGATING",
    updatedAt: picked, firstSeenAt: picked, attemptLedger: null, activeBatchId: null };
  m.db.courseSupportIncident.findUnique.mockImplementation(async () => outdoorIncident);
  m.db.courseSupportIncident.updateMany.mockImplementation(async ({ data }) => { outdoorIncident = { ...outdoorIncident, ...data }; return { count: 1 }; });
  m.db.simulatorSupportIncident.findUnique.mockResolvedValue({ id: "incident1", offeringId: "bay1", status: "AUTO_INVESTIGATING" });
  m.report.mockResolvedValue({ incidentId: "incident1", status: "AUTO_INVESTIGATING" });
});
afterEach(() => vi.unstubAllEnvs());
describe("private retained source-routing evidence", () => {
  function routingFixture(nativeLabels = false) {
    const official = "https://routing-official.example/", booking = "https://routing-booking.example/availability";
    const request = { identity: { name: "Routing Fixture", address: "10 Public Road", officialUrl: official, timeZone: "UTC" },
      target: { kind: "OUTDOOR", courseId: "course1" }, demand: { searchId: "search1", alertGeneration: 1 },
      input: { date: "2030-01-02", startTime: "08:00", endTime: "18:00", timeZone: "UTC", players: 2 } };
    const job = { ...failure.job, request, checkpoint: {} as unknown };
    const report = { framework: { name: "Stagehand", version: "4.3.0" }, jobId: job.id,
      firstPickedUpAt: picked.toISOString(), deadlineAt: job.deadlineAt.toISOString(),
      startedAt: "2030-01-01T12:00:01.000Z", finishedAt: "2030-01-01T12:00:10.000Z", workDeadlineAt: "2030-01-01T12:04:00.000Z",
      frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY", frameworkExtractedTimes: false,
      outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
      adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking },
      visitedUrls: [official, booking], officialLinkLedger: [{ pageUrl: official,
        ...(nativeLabels ? { kind: "NATIVE_VISIBLE_DOM", observedAt: "2030-01-01T12:00:02.000Z", documentHash: "c".repeat(64) } : {}),
        links: [{ href: booking, ...(nativeLabels ? { text: "Golf Now", label: "", visible: true } : {}) }] }], frameLedger: [],
      actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: booking }, afterUrl: booking }],
      initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 }, metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium" } };
    job.checkpoint = { stagehandSource: createStagehandSourceCheckpoint({ ...job, attempts: 1,
      firstPickedUpAt: picked.toISOString(), deadlineAt: job.deadlineAt.toISOString() }, report) };
    return { job, official, booking };
  }
  it("projects already-retained public routing after the original deadline without resuming or admitting a read", () => {
    const { job, official, booking } = routingFixture();
    const value = readRetainedStagehandRoutingEvidence(job, now);
    expect(value).toMatchObject({ kind: "STAGEHAND_RETAINED_ROUTING", path: [official, booking],
      links: [{ position: 0, kind: "OTHER", visible: null }], actions: [{ sourceUrl: official, href: booking, afterUrl: booking, action: "CLICK" }], actionsTruncated: false });
    expect(JSON.stringify(value)).not.toMatch(/lease|search1|course1|Routing Fixture|Public Road/);
    expect(m.db.courseDiscoveryJob.findUnique).not.toHaveBeenCalled();
  });
  it.each(["request", "source", "job", "clock", "attempt", "report", "completion", "invalid-completion", "extra"])("rejects changed checkpoint binding: %s", mode => {
    const { job } = routingFixture();
    const saved = (job.checkpoint as { stagehandSource: Record<string, unknown> }).stagehandSource;
    if (mode === "request") job.request.demand.alertGeneration++;
    if (mode === "source") job.sourceFingerprint = "b".repeat(64);
    if (mode === "job") job.id = "foreign";
    if (mode === "clock") job.deadlineAt = new Date("2030-01-01T12:16:00Z");
    if (mode === "attempt") job.attempts = 0;
    if (mode === "report") saved.reportSha256 = "b".repeat(64);
    if (mode === "completion") job.completedAt = new Date("2030-01-01T12:00:05Z");
    if (mode === "invalid-completion") job.completedAt = new Date("invalid");
    if (mode === "extra") saved.privateText = "PRIVATE";
    expect(readRetainedStagehandRoutingEvidence(job, now)).toBeNull();
  });
  it("retains a closed label category from native link evidence without copying the caption", () => {
    const { job } = routingFixture(true), value = readRetainedStagehandRoutingEvidence(job, now);
    expect(value?.links).toEqual([{ position: 0, kind: "NATIVE_VISIBLE_DOM", visible: true, bookingLabel: false }]);
    expect(JSON.stringify(value)).not.toContain("Golf Now");
  });
});
describe("durable terminal worker diagnostics", () => {
  const diagnostic = { version: 1 as const, failureCode: "DISCOVERY_MODEL_CATALOG_UNAVAILABLE", frameworkPhase: "GENERIC_FALLBACK" as const, errorName: "Error" };
  const failureRecord = () => ({ version: 1, attempt: 2, terminal: true, observedAt: "2030-01-01T12:01:00.000Z", diagnostic });
  it.each(["early", "after-checkpoint"])("reports the actual terminal code after %s failure instead of prior fixed inspection", mode => {
    const job = { ...fixture().job, result: { workerFailure: failureRecord() }, checkpoint: {
      stagehandFailure: { code: "UNSUPPORTED_ADAPTER_SOURCE" }, stagehandProgress: { phase: "FIXED_INSPECTION" },
      ...(mode === "after-checkpoint" ? { genericToolTrace: { entries: [], lostEntries: 0 }, controller: { version: 1 } } : {}),
    } };
    expect(discoveryFailureDiagnosis(job)).toMatchObject({ failureCode: diagnostic.failureCode, phase: "GENERIC_FALLBACK",
      terminalWorkerDiagnostic: { ...diagnostic, attempt: 2 }, priorInspection: { failureCode: "UNSUPPORTED_ADAPTER_SOURCE" }, evidenceAuthority: false });
  });
  it.each(["attempt", "pending", "early", "late", "unknown", "private-field", "invalid-clock"])("ignores unbound or malformed terminal metadata: %s", mode => {
    const record = failureRecord();
    if (mode === "attempt") record.attempt = 1;
    if (mode === "pending") record.terminal = false;
    if (mode === "early") record.observedAt = "2029-12-31T23:00:00.000Z";
    if (mode === "late") record.observedAt = "2030-01-01T12:03:00.000Z";
    if (mode === "unknown") record.diagnostic = { ...diagnostic, failureCode: "PRIVATE_CANARY" };
    if (mode === "private-field") Object.assign(record.diagnostic = { ...diagnostic }, { message: "PRIVATE_CANARY" });
    const value = discoveryFailureDiagnosis({ ...fixture().job, ...(mode === "invalid-clock" ? { deadlineAt: new Date("invalid") } : {}), result: { workerFailure: record } });
    expect(value).not.toHaveProperty("terminalWorkerDiagnostic"); expect(JSON.stringify(value)).not.toContain("PRIVATE_CANARY");
  });
  it.each(["valid", "unbound", "absent"])("retains the existing no-recipe fallback trace only behind bound terminal proof: %s", mode => {
    const record = { ...failureRecord(), diagnostic: { ...diagnostic, failureCode: "DISCOVERY_NO_VERIFIED_RECIPE" } };
    if (mode === "unbound") record.attempt = 1;
    const job = { ...fixture().job, result: { workerFailure: record }, checkpoint: {
      stagehandFailure: { code: "FRAMEWORK_INSPECTION_PATH_STALE" },
      ...(mode === "absent" ? {} : { genericToolTrace: { entries: [{ action: "BROWSER_INSPECT_ADAPTER", status: "ERROR",
        errorCode: "UNSUPPORTED_ADAPTER_SOURCE", modelPreviewBytes: 42, previewOmitted: false,
        url: "PRIVATE_CANARY", arguments: "PRIVATE_CANARY" }], lostEntries: 0 },
      controller: { lastFailure: { code: "DISCOVERY_BROWSER_INCOMPLETE", details: {
        action: "inspect_adapter", loading: false, pendingRequestCount: 0, url: "PRIVATE_CANARY" } } } }),
    } };
    const value = sanitizeResponderValue(discoveryFailureDiagnosis(job));
    if (mode === "unbound") expect(value).not.toHaveProperty("genericFallbackDiagnostic");
    else {
      expect(value).toMatchObject({ failureCode: "DISCOVERY_NO_VERIFIED_RECIPE", phase: "GENERIC_FALLBACK",
        genericFallbackDiagnostic: { traceRetention: mode === "absent" ? "NOT_RETAINED" : "PRESENT", evidenceAuthority: false } });
      if (mode === "valid") expect(value).toMatchObject({ genericFallbackDiagnostic: { toolTrace: { entries: [{
        action: "BROWSER_INSPECT_ADAPTER", errorCode: "UNSUPPORTED_ADAPTER_SOURCE" }] } } });
      expect(value).not.toHaveProperty("genericFallbackDiagnostic.limit");
    }
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CANARY");
  });
  it("normalizes unknown error codes without retaining error prose", () => {
    const value = makeWorkerTerminalDiagnostic(Object.assign(new Error("PRIVATE_CANARY"), { code: "PRIVATE_CANARY", url: "PRIVATE_CANARY" }));
    expect(value).toEqual({ version: 1, failureCode: "UNKNOWN_WORKER_FAILURE", frameworkPhase: "WORKER", errorName: "Error" });
    expect(parseWorkerTerminalDiagnostic({ ...value, message: "PRIVATE_CANARY" })).toBeUndefined();
  });
  it("sends the closed diagnostic through the signed client and rejects invalid payloads before network I/O", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const client = createCourseDiscoveryClient({ baseUrl: "https://fixture.example/", deviceToken: "fixture-only-device-token", fetchImpl });
    await client.failWithDiagnostic("fixture-job", "owned-lease", "TOOL_FAILURE", false, diagnostic);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ leaseToken: "owned-lease", reason: "TOOL_FAILURE", retryable: false, terminalDiagnostic: diagnostic });
    expect(() => client.failWithDiagnostic("fixture-job", "owned-lease", "TOOL_FAILURE", false, { ...diagnostic, failureCode: "PRIVATE_CANARY" })).toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
describe("terminal learner to coding responder", () => {
  it.each(["owned", "foreign-owner", "foreign-batch", "cycle-drift", "source-drift", "runtime-drift", "unlinked-child",
    "late-observation", "early-observation", "digest-drift", "request-drift", "checkpoint-job-drift", "omitted", "unsafe-input"].flatMap(scenario => ["names", "availability"].map(kind => ({ scenario, kind }))))(
    "keeps $kind private and tied to the original reciprocal failed child: $scenario", async ({ scenario, kind }) => {
      const link = { version: 1, kind: "LATE_ENGINEERING_RECOVERY", originalJobId: "job1", jobId: "child1", batchId: "batch1",
        incidentId: "incident1", ownerThreadId: "owner1", cycle: 1, sourceFingerprint: failure.job.sourceFingerprint,
        releaseSha: "b".repeat(40), runtimeVersion: "c".repeat(40), requestedAt: "2030-01-01T12:10:00.000Z",
        originalFirstPickedUpAt: picked.toISOString(), originalDeadlineAt: failure.job.deadlineAt.toISOString() };
      failure.job.result = { engineeringHandoff: receipt(), learningRecoveries: [link] };
      const evidence = kind === "names" ? { schemaVersion: 1, kind: "CPS_NAMED_COURSE_COMPARISON", observedAt: "2030-01-01T12:11:00.000Z",
        canonicalName: "harbor pointe", officialNames: ["north", "south"], providerNames: ["harbor north", "harbor south"] } :
        { schemaVersion: 1, kind: "CPS_AVAILABILITY_CONTENT_STRUCTURE", observedAt: "2030-01-01T12:11:00.000Z", truncated: false,
          nodes: [{ path: [], type: "OBJECT", count: 1 }, { path: ["teeTimes"], type: "ARRAY", count: 0 }] };
      if (scenario === "late-observation") evidence.observedAt = "2030-01-01T12:13:00.000Z";
      if (scenario === "early-observation") evidence.observedAt = "2030-01-01T12:09:00.000Z";
      if (scenario === "unsafe-input") Object.assign(evidence, { url: "https://private.example/" });
      const request = { target: { courseId: "course1" } };
      const diagnostic = { cpsCatalogIdentityFailureStage: "NAMED_COURSE_NAMES" };
      const privateKey = kind === "names" ? "privateCourseNameComparison" : "privateCpsAvailabilityStructure";
      const entry = { attempt: 1, code: kind === "names" ? "ADAPTER_IDENTITY_MISMATCH" : "DISCOVERY_REPLAY_INCOMPLETE",
        phase: kind === "names" ? "FIXED_INSPECTION" : "REPLAY", observedAt: "2030-01-01T12:11:01.000Z",
        ...(kind === "names" ? { fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) } : { replayFailureCode: "CPS_AVAILABILITY_INCOMPLETE" }),
        ...(scenario === "omitted" ? { [`${privateKey}OmittedForBudget`]: true } : { [privateKey]: evidence }),
        [`${privateKey}Sha256`]: scenario === "digest-drift" ? "f".repeat(64) : stagehandDataHash(evidence) };
      const child = { ...failure.job, id: "child1", request, firstPickedUpAt: new Date("2030-01-01T12:10:00Z"),
        deadlineAt: new Date("2030-01-01T12:25:00Z"), completedAt: new Date("2030-01-01T12:12:00Z"),
        result: { learningRecoveryOf: scenario === "unlinked-child" ? { ...link, batchId: "foreign" } : link,
          executionRuntimeVersion: scenario === "runtime-drift" ? "d".repeat(40) : link.runtimeVersion },
        checkpoint: { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", jobId: scenario === "checkpoint-job-drift" ? "other" : "child1",
          sourceFingerprint: link.sourceFingerprint, requestSha256: scenario === "request-drift" ? "f".repeat(64) : stagehandDataHash(request),
          firstPickedUpAt: "2030-01-01T12:10:00.000Z", deadlineAt: "2030-01-01T12:25:00.000Z", entries: [entry] } } };
      m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.id === child.id ? child : failure.job);
      const result = await getOwnedLearningFailureEvidence(m.db as never, { batchId: scenario === "foreign-batch" ? "other" : "batch1",
        ownerThreadId: scenario === "foreign-owner" ? "other" : "owner1", courseId: "course1", incidentId: "incident1",
        incidentCycle: scenario === "cycle-drift" ? 2 : 1, now,
        providerSnapshotFingerprint: scenario === "source-drift" ? "f".repeat(64) : buildCourseSupportProviderSnapshotFingerprint(failure.source.course as never) });
      if (scenario === "owned") expect(result).toMatchObject({ [kind === "names" ? "courseNameComparisonEvidence" : "availabilityStructureEvidence"]: evidence, evidenceAuthority: false, untrustedPageEvidence: true });
      else expect(result).toBeNull();
      expect(JSON.stringify(discoveryFailureDiagnosis(child))).not.toContain("harbor");
      expect(JSON.stringify(sanitizeResponderValue(discoveryFailureDiagnosis(child)))).not.toContain("harbor");
      expect(JSON.stringify(discoveryFailureDiagnosis(child))).not.toContain("teeTimes");
      expect(await getOwnedLearningBookingEdgeEvidence(m.db as never, { batchId: "batch1", ownerThreadId: "owner1", courseId: "course1",
        incidentId: "incident1", incidentCycle: 1, now, providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(failure.source.course as never) })).toBeNull();
    });
  it("exposes persisted closed source diagnostics without treating them as source proof", () => {
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 2,
        phase: "FIXED_INSPECTION", code: "STAGEHAND_WORKER_FAILED", fixedInspectionDiagnostic: {
          officialSourceDiagnostic: { stage: "CONTROLLER_CAPTURE", rawOfficialCaptured: false, currentOfficialDocument: false, html: "PRIVATE" },
          navigationFailureKind: "TIMEOUT", url: "PRIVATE",
        } }] },
    } });
    expect(result).toMatchObject({ fixedInspectionSourceDiagnostic: { stage: "CONTROLLER_CAPTURE", rawOfficialCaptured: false,
      currentOfficialDocument: false }, fixedInspectionNavigationFailureKind: "TIMEOUT", evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("projects the fixed inspector's own native transport rejection separately from generic fallback", () => {
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 2, phase: "FIXED_INSPECTION",
        code: "STAGEHAND_WORKER_FAILED", fixedInspectionDiagnostic: { nativeRouterFailure: {
          code: "NATIVE_REDIRECT_LOADER_MISMATCH", phase: "LOADER_IDENTITY", operation: "REQUEST_RELEASE", method: "OPTIONS",
          identityPresent: true, url: "PRIVATE", headers: "PRIVATE" } } }] },
    } });
    expect(result).toMatchObject({ fixedInspectionNativeTransportDiagnostic: { failureCode: "NATIVE_REDIRECT_LOADER_MISMATCH",
      phase: "LOADER_IDENTITY", operation: "REQUEST_RELEASE", method: "OPTIONS", identityPresent: true }, evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("reports retained budget omission markers without inventing diagnostic contents", () => {
    const project = (entry: object) => discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 2,
        phase: "FIXED_INSPECTION", code: "STAGEHAND_WORKER_FAILED", ...entry }] },
    } });
    expect(project({ fixedInspectionDiagnosticOmittedForBudget: true, fixedInspectionDiagnosticSha256: "a".repeat(64) }))
      .toMatchObject({ fixedInspectionDiagnosticRetention: "OMITTED_FOR_BUDGET", evidenceAuthority: false });
    expect(project({ fixedInspectionDiagnostic: { html: "PRIVATE" } })).toMatchObject({ fixedInspectionDiagnosticRetention: "PRESENT" });
    for (const entry of [{}, { fixedInspectionDiagnosticOmittedForBudget: true },
      { fixedInspectionDiagnosticOmittedForBudget: true, fixedInspectionDiagnosticSha256: "PRIVATE" }])
      expect(project(entry)).not.toHaveProperty("fixedInspectionDiagnosticRetention");
    expect(JSON.stringify(project({ fixedInspectionDiagnostic: { html: "PRIVATE" } }))).not.toContain("PRIVATE");
  });
  it.each([...cpsCatalogIdentityFailureStages, "PRIVATE"])("preserves only finite catalog failure stage %s across the helper and owned diagnosis", stage => {
    const diagnostic = safeFixedInspectionSourceDiagnostic({ cpsCatalogIdentityFailureStage: stage, html: "PRIVATE" });
    const transported = safeBrowserFailureDiagnostics({ cpsCatalogIdentityFailureStage: stage, headers: "PRIVATE" });
    if (stage === "PRIVATE") { expect(diagnostic).toBeUndefined(); expect(transported).not.toHaveProperty("cpsCatalogIdentityFailureStage"); return; }
    expect(diagnostic).toEqual({ cpsCatalogIdentityFailureStage: stage });
    expect(transported).toMatchObject(diagnostic);
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 1, phase: "FIXED_INSPECTION",
        code: "ADAPTER_IDENTITY_MISMATCH", fixedInspectionDiagnostic: diagnostic }] },
    } });
    expect(result).toMatchObject({ cpsCatalogIdentityFailureStage: stage, evidenceAuthority: false });
    expect(sanitizeResponderValue(result)).toMatchObject({ cpsCatalogIdentityFailureStage: stage });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it.each(["owned", "foreign-owner", "foreign-batch", "cycle-drift", "source-drift", "runtime-drift", "unlinked-child", "late-observation", "early-observation"].flatMap(scenario =>
    ["edge", "physical"].map(kind => ({ scenario, kind }))))(
    "discloses $kind evidence only from the same reciprocal current-source child: $scenario", async ({ scenario, kind }) => {
      const link = { version: 1, kind: "LATE_ENGINEERING_RECOVERY", originalJobId: "job1", jobId: "child1", batchId: "batch1",
        incidentId: "incident1", ownerThreadId: "owner1", cycle: 1, sourceFingerprint: failure.job.sourceFingerprint,
        releaseSha: "b".repeat(40), runtimeVersion: "c".repeat(40), requestedAt: new Date("2030-01-01T12:10:00Z").toISOString(),
        originalFirstPickedUpAt: picked.toISOString(), originalDeadlineAt: failure.job.deadlineAt.toISOString() };
      failure.job.result = { engineeringHandoff: receipt(), learningRecoveries: [link] };
      const clock = vi.spyOn(Date, "now").mockReturnValue(new Date("2030-01-01T12:11:00Z").getTime());
      const evidence = collectBookingEdgeEvidence({ url: "https://official.example/tee-times/", html: "<html><body></body></html>" });
      clock.mockRestore();
      const physical = { schemaVersion: 1 as const, observedAt: evidence.observedAt,
        canonicalStreet: { before: "" as const, street: "oakridge", type: "rd" as const, after: "" as const },
        providerStreet: { before: "" as const, street: "oak ridge", type: "rd" as const, after: "" as const } };
      const diagnostic = createDelegationDiagnostic(kind === "edge" ? "HOP_TWO_LINK" : "PROVIDER_BIND");
      if (kind === "edge") diagnostic.hopEvidence = evidence; else diagnostic.physicalBindingEvidence = physical;
      if (scenario === "late-observation") evidence.observedAt = new Date("2030-01-01T12:30:00Z").toISOString();
      if (scenario === "late-observation") physical.observedAt = evidence.observedAt;
      if (scenario === "early-observation") physical.observedAt = evidence.observedAt = "2030-01-01T12:09:00.000Z";
      const child = { ...failure.job, id: "child1", firstPickedUpAt: new Date("2030-01-01T12:10:00Z"),
        deadlineAt: new Date("2030-01-01T12:25:00Z"), completedAt: new Date("2030-01-01T12:12:00Z"),
        result: { learningRecoveryOf: scenario === "unlinked-child" ? { ...link, batchId: "foreign" } : link,
          executionRuntimeVersion: scenario === "runtime-drift" ? "d".repeat(40) : link.runtimeVersion },
        checkpoint: { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [
          { attempt: 1, code: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", phase: "FIXED_INSPECTION", fixedInspectionDiagnostic: { teeItUpDelegation: diagnostic } } ] } } };
      m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.id === child.id ? child : failure.job);
      const result = await (kind === "edge" ? getOwnedLearningBookingEdgeEvidence : getOwnedLearningFailureEvidence)(m.db as never, { batchId: scenario === "foreign-batch" ? "other" : "batch1",
        ownerThreadId: scenario === "foreign-owner" ? "other" : "owner1", courseId: "course1", incidentId: "incident1", incidentCycle: scenario === "cycle-drift" ? 2 : 1, now,
        providerSnapshotFingerprint: scenario === "source-drift" ? "f".repeat(64) : buildCourseSupportProviderSnapshotFingerprint(failure.source.course as never) });
      if (scenario === "owned") {
        expect(result).toMatchObject({ sourceFingerprint: failure.job.sourceFingerprint, executionRuntime: link.runtimeVersion,
          [kind === "edge" ? "evidence" : "physicalBindingEvidence"]: kind === "edge" ? evidence : physical, evidenceAuthority: false, untrustedPageEvidence: true });
        expect(discoveryFailureDiagnosis(child)).not.toHaveProperty("bookingEdgeEvidence");
        expect(discoveryFailureDiagnosis(child)).not.toHaveProperty("physicalBindingEvidence");
        expect(JSON.stringify(result)).not.toMatch(/https:|official.example|<html/u);
      } else expect(result).toBeNull();
    });
  it("queues outdoor engineering once without resetting the failed job, clock or cooldown", async () => {
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 1 });
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ kind: "NEEDS_ADAPTER", readPath: "DISCOVERY_CODE_REPAIR",
      failureObservedAt: failure.job.completedAt, episodeStartedAt: picked }));
    const write = m.db.courseDiscoveryJob.updateMany.mock.calls[0][0];
    expect(Object.keys(write.data)).toEqual(["result"]);
    expect(discoveryEngineeringReceipt(failure.job.result)).toEqual(receipt());
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 0 });
    expect(m.report).toHaveBeenCalledTimes(1);
    expect(failure.job).toMatchObject({ attempts: 2, status: "FAILED", firstPickedUpAt: picked, deadlineAt: new Date("2030-01-01T12:15:00Z") });
  });
  it("routes simulator failures to their offering rather than outdoor support", async () => {
    failure.job.offeringId = "bay1";
    m.db.simulatorSupportIncident.findUnique.mockResolvedValueOnce(null);
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 1, queued: 1 });
    expect(m.simulator).toHaveBeenCalledWith(m.db, expect.objectContaining({ offeringId: "bay1", reason: "DISCOVERY_CODE_REPAIR" }));
    expect(m.report).not.toHaveBeenCalled();
  });
  it("initializes an empty outdoor investigation before its claim without inventing provider evidence", async () => {
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(1);
    expect(m.db.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: { id: "incident1", updatedAt: picked, status: "AUTO_INVESTIGATING", activeBatchId: null },
      data: { attemptLedger: { version: 1, events: [] } },
    });
  });
  it("preserves an existing outdoor investigation ledger", async () => {
    m.db.courseSupportIncident.findUnique.mockResolvedValue({ id: "incident1", courseId: "course1", status: "AUTO_INVESTIGATING",
      updatedAt: picked, attemptLedger: { version: 1, events: [{ retained: true }] }, activeBatchId: null });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(1);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
  });
  it("does not link outdoor repair when ledger initialization loses its ownership fence", async () => {
    m.db.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("initializes a previously queued unowned handoff without requeueing its job", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(outdoorIncident.attemptLedger).toEqual({ version: 1, events: [] });
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled(); expect(m.report).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding", "new-cycle"])("preserves %s authority on a previously queued handoff", async owner => {
    failure.job.result = { engineeringHandoff: receipt() };
    if (owner === "coding") m.owner.mockResolvedValue(true);
    if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? { id: "active" } : failure.job);
    if (owner === "new-cycle") outdoorIncident.firstSeenAt = new Date(now.getTime() + 1);
    await reconcileDiscoveryEngineeringHandoffs(now);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("does not initialize an old queued incident if its server receipt changes while acquiring the course lock", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    m.current.mockResolvedValueOnce(failure).mockResolvedValueOnce({ ...failure,
      job: { ...failure.job, result: { engineeringHandoff: { ...receipt(), incidentId: "replacement-incident" } } } });
    await reconcileDiscoveryEngineeringHandoffs(now);
    expect(m.db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it.each(["AUTO_INVESTIGATING", "NEEDS_HUMAN"])("preserves the simulator's existing %s episode and cooldown", async status => {
    failure.job.offeringId = "bay1";
    m.db.simulatorSupportIncident.findUnique.mockResolvedValue({ id: "incident1", offeringId: "bay1", status,
      retryAt: new Date(now.getTime() + 86_400_000), reason: "ORIGINAL_FAILURE" });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(status === "AUTO_INVESTIGATING" ? 1 : 0);
    expect(m.simulator).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding"])("preserves an existing %s owner", async owner => {
    if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockResolvedValue({ id: "active" });
    else m.owner.mockResolvedValue(true);
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.report).not.toHaveBeenCalled(); expect(m.simulator).not.toHaveBeenCalled(); expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("does not link a handoff when source or demand changes after issue preparation", async () => {
    m.report.mockImplementation(async () => { m.current.mockResolvedValue(null); return { incidentId: "incident1", status: "AUTO_INVESTIGATING" }; });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it.each(["learner", "coding"])("does not transfer ownership when a %s owner appears during issue preparation", async owner => {
    m.report.mockImplementation(async () => {
      if (owner === "learner") m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey ? { id: "active" } : failure.job);
      else m.owner.mockResolvedValue(true);
      return { incidentId: "incident1", status: "AUTO_INVESTIGATING" };
    });
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).not.toHaveBeenCalled();
  });
  it("retires obsolete failures so they cannot starve the bounded queue", async () => {
    m.current.mockResolvedValue(null);
    expect((await reconcileDiscoveryEngineeringHandoffs(now)).queued).toBe(0);
    expect(m.db.courseDiscoveryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { result: {
      engineeringHandoff: { version: 1, state: "OBSOLETE", observedAt: now.toISOString(), reason: "SOURCE_DEMAND_OR_SUCCESS_SUPERSEDED_FAILURE" } } } }));
    expect(failure.job.status).toBe("FAILED"); expect(m.report).not.toHaveBeenCalled();
  });
  it.each(["disabled", "pilot"])("does not expand the %s rollout", async mode => {
    if (mode === "disabled") vi.stubEnv("COURSE_DISCOVERY_ENABLED", "false"); else vi.stubEnv("COURSE_DISCOVERY_ROLLOUT_MODE", "PILOT");
    expect(await reconcileDiscoveryEngineeringHandoffs(now)).toEqual({ examined: 0, queued: 0 });
    expect(m.db.$queryRaw).not.toHaveBeenCalled();
  });
});
describe("private failure evidence", () => {
  it("surfaces the linked recovery's new failure while preserving the original failed clock", async () => {
    const link = { version: 1, kind: "LATE_ENGINEERING_RECOVERY", originalJobId: "job1", jobId: "child1", batchId: "batch1",
      incidentId: "incident1", ownerThreadId: "owner1", cycle: 1, sourceFingerprint: failure.job.sourceFingerprint,
      releaseSha: "b".repeat(40), runtimeVersion: "c".repeat(40), requestedAt: now.toISOString(),
      originalFirstPickedUpAt: picked.toISOString(), originalDeadlineAt: failure.job.deadlineAt.toISOString() };
    failure.job.result = { engineeringHandoff: receipt(), learningRecoveries: [link] };
    const child = { ...failure.job, id: "child1", attempts: 1, result: { learningRecoveryOf: link },
      checkpoint: { stagehandFailure: { code: "BROWSER_UNAVAILABLE" } } };
    m.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.id === child.id ? child : failure.job);
    const context = await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now);
    expect(context).toMatchObject({ jobId: "job1", originalFirstPickupAt: picked.toISOString(),
      originalDeadlineAt: failure.job.deadlineAt.toISOString(), diagnosis: { category: "SAVED_METHOD_SOURCE_CHANGED" },
      latestLearningRecovery: { jobId: "child1", implementationRelease: link.releaseSha, executionRuntime: link.runtimeVersion,
        diagnosis: { category: "LOCAL_BROWSER_UNAVAILABLE" }, evidenceAuthority: false } });
    child.result.learningRecoveryOf = { ...link, runtimeVersion: "d".repeat(40) };
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now))
      .toMatchObject({ latestLearningRecovery: null });
  });
  it("projects only closed delegation gates from the failed inspection without making them proof", () => {
    const diagnostic = createDelegationDiagnostic("ROOT_IDENTITY");
    diagnostic.gates.rootRenderedAddress = false;
    const entry = { attempt: 1, phase: "FIXED_INSPECTION", code: "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED",
      fixedInspectionDiagnostic: { teeItUpDelegation: { ...diagnostic, url: "https://private.example/token" } } };
    const project = () => sanitizeResponderValue(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE",
      checkpoint: { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [entry] } } }));
    expect(project()).toMatchObject({ failureCode: entry.code,
      delegationDiagnostic: { stage: diagnostic.stage, gates: Object.entries(diagnostic.gates).map(([gate, passed]) => ({ gate: gate.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase(), passed })) },
      evidenceAuthority: false });
    expect(JSON.stringify(project())).not.toContain("private.example");
    Object.assign(entry.fixedInspectionDiagnostic.teeItUpDelegation.gates, { rootRenderedAddress: "PRIVATE" });
    expect(project()).not.toHaveProperty("delegationDiagnostic");
  });
  it("projects optional binding booleans without losing historical failures or copying untrusted fields", () => {
    const diagnostic = createDelegationDiagnostic("PROVIDER_BIND");
    Object.assign(diagnostic.gates, { directoryNameMatch: true, directoryIdentityMatch: true,
      directoryIdentityKindMissing: true, directoryIdentitySimulator: "PRIVATE", providerName: "PRIVATE" });
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: {
      schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 1, phase: "FIXED_INSPECTION",
        code: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", fixedInspectionDiagnostic: { teeItUpDelegation: diagnostic } }] } } });
    expect(result).toMatchObject({ delegationDiagnostic: { stage: "PROVIDER_BIND", gates: expect.arrayContaining([
      { gate: "DIRECTORY_NAME_MATCH", passed: true }, { gate: "DIRECTORY_IDENTITY_MATCH", passed: true },
      { gate: "DIRECTORY_IDENTITY_KIND_MISSING", passed: true }]) }, evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.delegationDiagnostic!.gates.some(row => row.gate === "DIRECTORY_IDENTITY_SIMULATOR")).toBe(false);
  });
  it.each(["DISCOVERY_NATIVE_TRANSPORT_FATAL", "DISCOVERY_GENERIC_BUDGET_EXHAUSTED"])("reports terminal %s instead of the earlier fixed inspection", code => {
    const diagnostic = createDelegationDiagnostic("PROVIDER_BIND");
    const checkpoint = { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [
      { attempt: 1, phase: "FIXED_INSPECTION", code: "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED", fixedInspectionDiagnostic: { teeItUpDelegation: diagnostic } },
    ] }, genericGuard: { code, toolOperations: 5, nativeFirstFatal: { code: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT",
      method: "GET", resourceType: "document", url: "https://private.example/token", message: "PRIVATE_BODY", operation: "PRIVATE_OPERATION" } } };
    const result = JSON.parse(JSON.stringify(sanitizeResponderValue(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint }))));
    expect(result).toMatchObject({ failureCode: code, phase: "GENERIC_FALLBACK", evidenceAuthority: false,
      priorInspection: { failureCode: "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED", phase: "FIXED_INSPECTION", delegationDiagnostic: { stage: "PROVIDER_BIND" } } });
    expect(JSON.stringify(result)).not.toMatch(/private\.example|PRIVATE_BODY|PRIVATE_OPERATION/iu);
    if (code === "DISCOVERY_NATIVE_TRANSPORT_FATAL") expect(result).toMatchObject({ category: "BROWSER_TRANSPORT_REJECTED",
      nativeTransportDiagnostic: { failureCode: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT", method: "GET", resourceType: "document" } });
    else expect(result).not.toHaveProperty("nativeTransportDiagnostic");
    expect(result).not.toHaveProperty("delegationDiagnostic");
  });
  it("retains the exhausted limit and structural tool replies in the owning diagnostic", () => {
    const checkpoint = { genericGuard: { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED", limit: "toolOperations",
      toolOperations: 16, tokenUsage: { totalTokens: 1234 }, limits: { toolOperations: 16 } },
      genericToolTrace: { entries: [{ action: "BROWSER_INSPECT_ADAPTER", status: "ERROR",
        errorCode: "UNSUPPORTED_ADAPTER_SOURCE", modelPreviewBytes: 42, previewOmitted: false }], lostEntries: 8 } };
    const result = sanitizeResponderValue(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint }));
    expect(result).toMatchObject({ genericFallbackDiagnostic: { limit: "toolOperations", toolOperations: 16,
      tokenUsage: { totalTokens: 1234 }, limits: { toolOperations: 16 }, traceRetention: "PRESENT",
      toolTrace: checkpoint.genericToolTrace, evidenceAuthority: false } });
  });
  it("keeps the historical failed control predicate apart from later passive feedback", () => {
    const checkpoint = { genericGuard: { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" }, controller: {
      lastFailure: { code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "click", failure: { code: "STALE_OR_UNKNOWN_CONTROL", url: "PRIVATE_CANARY" },
        staleControlReason: "CONTROL_SIGNATURE_CHANGED", loading: false, pendingRequestCount: 0, selector: "PRIVATE_CANARY" } },
      lastFeedback: { code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "observe", loading: true, pendingRequestCount: 2 } },
    } };
    const value = sanitizeResponderValue(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint }));
    expect(value).toMatchObject({ genericFallbackDiagnostic: { historicalFailure: { action: "click", failureCode: "STALE_OR_UNKNOWN_CONTROL",
      staleControlReason: "CONTROL_SIGNATURE_CHANGED", loading: false, pendingRequestCount: 0 },
      lastFeedback: { action: "observe", loading: true, pendingRequestCount: 2 }, evidenceAuthority: false } });
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CANARY");
  });
  it.each([null, [], { code: "PRIVATE_CANARY", details: { staleControlReason: "CONTROL_DISABLED" } },
    { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { staleControlReason: "CONTROL_DISABLED" } }])("rejects unrelated feedback %j", value => {
    const result = projectGenericFailureDiagnostic({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" }, undefined,
      { lastFailure: value, lastFeedback: value });
    expect(result).not.toHaveProperty("historicalFailure"); expect(result).not.toHaveProperty("lastFeedback");
  });
  it("strips arbitrary failure/control values and malformed counts from browser feedback", () => {
    const result = projectGenericFailureDiagnostic({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" }, undefined,
      { lastFailure: { code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "PRIVATE_CANARY", failure: { code: "PRIVATE_CANARY" },
        staleControlReason: "PRIVATE_CANARY", loading: "PRIVATE_CANARY", pendingRequestCount: -1, url: "PRIVATE_CANARY" } } });
    expect(result?.historicalFailure).toEqual({ feedbackKind: "DISCOVERY_BROWSER_INCOMPLETE" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("projects closed request-failure facts and adapter rejection without exposing requests", () => {
    const result = projectGenericFailureDiagnostic({ code: "DISCOVERY_NO_VERIFIED_RECIPE" }, undefined, {
      officialUrl: "https://fixture.example/",
      lastFailure: { code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "inspect_adapter",
        failure: { code: "ADAPTER_IDENTITY_MISMATCH", url: "PRIVATE_CANARY" }, requests: [
          { code: "UNSAFE_URL", method: "GET", resourceType: "script", url: "https://fixture.example/path?PRIVATE_CANARY" },
          { code: "PRIVATE_CANARY", method: "PRIVATE_CANARY", resourceType: "PRIVATE_CANARY" },
        ] } },
    });
    expect(result).toMatchObject({ historicalFailure: { failureCode: "ADAPTER_IDENTITY_MISMATCH", requestFailures: [
      { failureCode: "UNSAFE_URL", method: "GET", resourceType: "script", originCategory: "OFFICIAL_ORIGIN" },
      { failureCode: "OTHER_REQUEST_ERROR", originCategory: "UNAVAILABLE" },
    ] }, traceRetention: "NOT_RETAINED", evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it.each(["FIRST_TWO_AND_LATEST_SIX", "PRIVATE_CANARY", undefined])("retains only the closed trace layout %s", retention => {
    const result = projectGenericFailureDiagnostic({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" }, { entries: [], lostEntries: 4, retention });
    if (retention === "FIRST_TWO_AND_LATEST_SIX") expect(result?.toolTrace?.retention).toBe(retention);
    else expect(result?.toolTrace).not.toHaveProperty("retention");
  });
  it("projects the actual persisted worker trace under the production tsx loader without tool arguments", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", `
      const {createDiscoveryToolTrace}=require('./scripts/automation/course-discovery-worker.mjs');
      const {projectGenericFailureDiagnostic}=require('./src/lib/course-discovery/generic-failure-diagnostic.ts');
      const trace=createDiscoveryToolTrace();
      trace.record('discovery_browser',{action:'inspect_adapter',url:'PRIVATE_CANARY'},'ERROR','UNSUPPORTED_ADAPTER_SOURCE','PRIVATE_CANARY');
      console.log(JSON.stringify(projectGenericFailureDiagnostic({code:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED',limit:'outputTokens',
        toolOperations:1,tokenUsage:{outputTokens:8192},limits:{outputTokens:8192}},trace.snapshot(),{
          lastFailure:{code:'DISCOVERY_BROWSER_INCOMPLETE',details:{action:'click',staleControlReason:'CONTROL_SIGNATURE_CHANGED',url:'PRIVATE_CANARY'}}})));
    `], { encoding: "utf8", windowsHide: true });
    expect(JSON.parse(output)).toMatchObject({ limit: "outputTokens", toolOperations: 1,
      tokenUsage: { outputTokens: 8192 }, toolTrace: { entries: [{ action: "BROWSER_INSPECT_ADAPTER", status: "ERROR",
        errorCode: "UNSUPPORTED_ADAPTER_SOURCE" }], lostEntries: 0 }, historicalFailure: { action: "click", staleControlReason: "CONTROL_SIGNATURE_CHANGED" }, evidenceAuthority: false });
    expect(output).not.toContain("PRIVATE_CANARY");
  });
  it("keeps the terminal replies through the actual loader and owned projection", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", `
      const {createDiscoveryToolTrace}=require('./scripts/automation/course-discovery-worker.mjs');
      const {projectGenericFailureDiagnostic}=require('./src/lib/course-discovery/generic-failure-diagnostic.ts');
      const trace=createDiscoveryToolTrace();
      for(let i=0;i<12;i++)trace.record('discovery_browser',{action:'observe',url:'PRIVATE_CANARY'},'SUCCESS',undefined,'x'.repeat(i));
      console.log(JSON.stringify(projectGenericFailureDiagnostic({code:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED'},trace.snapshot())));
    `], { encoding: "utf8", windowsHide: true });
    const result = JSON.parse(output);
    expect(result.toolTrace.retention).toBe("FIRST_TWO_AND_LATEST_SIX"); expect(result.toolTrace.lostEntries).toBe(4);
    expect(result.toolTrace.entries.map((entry: { modelPreviewBytes: number }) => entry.modelPreviewBytes)).toEqual([0, 1, 6, 7, 8, 9, 10, 11]);
    expect(output).not.toContain("PRIVATE_CANARY");
  });
  it("caps traces and strips unknown codes, counts and private fields", () => {
    const entry = { action: "PRIVATE_CANARY", status: "ERROR", errorCode: "PRIVATE_CANARY", url: "PRIVATE_CANARY",
      modelPreviewBytes: 20, previewOmitted: true, schemaEngine: "PRIVATE_CANARY" };
    const value = projectGenericFailureDiagnostic({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED", limit: "PRIVATE_CANARY",
      toolOperations: -1, tokenUsage: { totalTokens: Infinity, inputTokens: "123", outputTokens: 12, url: "PRIVATE_CANARY" },
      limits: { outputTokens: 8192, private: "PRIVATE_CANARY" } },
    { entries: [null, ...Array.from({ length: 12 }, () => entry)], lostEntries: 2 });
    expect(value).toMatchObject({ tokenUsage: { outputTokens: 12 }, limits: { outputTokens: 8192 },
      traceRetention: "PRESENT", toolTrace: { entries: Array.from({ length: 8 }, () => ({ action: "UNKNOWN_TOOL", status: "ERROR",
        errorCode: "OTHER_TOOL_ERROR", modelPreviewBytes: 20, previewOmitted: true })), lostEntries: 7 } });
    expect(value).not.toHaveProperty("limit"); expect(value).not.toHaveProperty("toolOperations");
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CANARY");
  });
  it.each([undefined, null, { entries: "PRIVATE", lostEntries: 0 }, { entries: [], lostEntries: -1 },
    { entries: Array(1025).fill({}), lostEntries: 0 }])("distinguishes unavailable or malformed trace %j without inventing facts", trace => {
    const value = projectGenericFailureDiagnostic({ code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED" }, trace);
    expect(value?.traceRetention).toBe(trace === undefined ? "NOT_RETAINED" : "INVALID");
    expect(value).not.toHaveProperty("toolTrace"); expect(value).not.toHaveProperty("limit");
  });
  it("rejects arbitrary guard codes and leaves non-tool outcomes alone", () => {
    expect(projectGenericFailureDiagnostic({ code: "PRIVATE" }, {})).toBeUndefined();
    expect(discoveryFailureDiagnosis({ outcome: "UNSUPPORTED", checkpoint: {
      genericGuard: { code: "DISCOVERY_GENERIC_BUDGET_EXHAUSTED", limit: "totalTokens" },
    } })).not.toHaveProperty("genericFallbackDiagnostic");
  });
  it("never promotes an arbitrary guard or native reason into a diagnostic or changes a non-tool outcome", () => {
    const checkpoint = { stagehandFailure: { code: "ADAPTER_TRANSPORT_FAILED" }, genericGuard: {
      code: "PRIVATE_GUARD", nativeFirstFatal: { code: "PRIVATE_NATIVE", url: "https://private.example/token" } } };
    expect(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint })).toMatchObject({ failureCode: "ADAPTER_TRANSPORT_FAILED" });
    checkpoint.genericGuard.code = "DISCOVERY_NATIVE_TRANSPORT_FATAL";
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint });
    expect(result).toMatchObject({ nativeTransportDiagnostic: { failureCode: "UNKNOWN" }, evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private\.example/u);
    expect(discoveryFailureDiagnosis({ outcome: "DEADLINE", checkpoint })).toMatchObject({ category: "DEADLINE_EXCEEDED", failureCode: "ADAPTER_TRANSPORT_FAILED" });
  });
  it("keeps a closed worker failure hint usable after CLI sanitization without exposing a code credential", () => {
    const project = (code: string) => sanitizeResponderValue(discoveryFailureDiagnosis({
      outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: { schemaVersion: 1,
        kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 1,
          phase: "FIXED_INSPECTION", code, message: "PRIVATE_PROVIDER_BODY" }] } },
    }));
    expect(project("ADAPTER_TRANSPORT_FAILED")).toMatchObject({ code: "[redacted]",
      failureCode: "ADAPTER_TRANSPORT_FAILED", evidenceAuthority: false });
    for (const code of ["PRIVATE_PROVIDER_BODY", "TOKEN_ABC123", "https://private.example/token"])
      expect(project(code)).toMatchObject({ code: "[redacted]", failureCode: null, evidenceAuthority: false });
    expect(JSON.stringify(project("TOKEN_ABC123"))).not.toContain("TOKEN_ABC123");
  });
  it.each(["OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED", "STAGEHAND_SOURCE_DISCOVERY_FAILED"])("carries the actual bounded worker checkpoint entry for %s into repair", code => {
    const checkpoint = {
      stagehandProgress: { phase: "SOURCE_EXPORTED" },
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [
        { attempt: 1, phase: "SOURCE_DISCOVERY", code: "STAGEHAND_SOURCE_BUDGET_EXHAUSTED" },
        { attempt: 2, phase: "FIXED_INSPECTION", code, message: "PRIVATE_UNTRUSTED_INSTRUCTIONS" },
      ] },
    };
    expect(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint })).toMatchObject({
      code, phase: "FIXED_INSPECTION", evidenceAuthority: false,
    });
    expect(JSON.stringify(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint }))).not.toContain("PRIVATE_UNTRUSTED_INSTRUCTIONS");
  });
  it("carries only a closed phone rejection stage through a later transport failure", () => {
    for (const stage of ["VENUE_IDENTITY", "PRIVATE", ["VENUE_IDENTITY"]]) {
      const checkpoint = { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC",
        entries: [{ attempt: 1, phase: "FIXED_INSPECTION", code: "CPS_PHONE_BOOKING_SOURCE_UNVERIFIED",
          fixedInspectionDiagnostic: { cpsPhoneBookingFailureStage: stage, html: "PRIVATE" } }] },
        genericGuard: { code: "DISCOVERY_NATIVE_TRANSPORT_FATAL", nativeFirstFatal: { code: "NATIVE_REDIRECT_LOADER_TIMEOUT" } } };
      const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint });
      if (stage === "VENUE_IDENTITY") expect(result).toMatchObject({ priorInspection: { cpsPhoneBookingFailureStage: stage, evidenceAuthority: false } });
      else expect(result.priorInspection).not.toHaveProperty("cpsPhoneBookingFailureStage");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
  });
  it("keeps bounded preflight failure evidence in the original-owner repair diagnosis", () => {
    const nativeFirstFatal = { code: "NATIVE_REDIRECT_LOADER_TIMEOUT", method: "OPTIONS", requestedPreflightMethod: "GET",
      preflightRegistrationGate: "SOURCE_NOT_PUBLISHED", preflightCandidatePresent: false, preflightSourceKnown: false,
      preflightOriginSafe: true, preflightRequestedHeadersCategory: "ORDINARY" };
    const result = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      genericGuard: { code: "DISCOVERY_NATIVE_TRANSPORT_FATAL", nativeFirstFatal: { ...nativeFirstFatal, headers: "PRIVATE", url: "PRIVATE" } },
    } });
    const { code: failureCode, ...facts } = nativeFirstFatal;
    expect(result).toMatchObject({ nativeTransportDiagnostic: { failureCode, ...facts }, evidenceAuthority: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("exposes retained fixed-inspection readability without page or identity values", () => {
    const row = { action: "open", actionIndex: 1, currentUrlCategory: "BOOKING_ORIGIN", nativeTransport: true,
      navigationStatusPresent: true, navigationStatus: 200, accessRequirementObserved: false, nativeFatalPresent: false,
      nativeFatalCode: null, readyState: "complete", pendingRequestCount: 0, officialDocumentCurrent: null, failedPredicates: [] };
    const project = (readability: unknown) => discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 1,
        phase: "FIXED_INSPECTION", code: "STAGEHAND_WORKER_FAILED", fixedInspectionDiagnostic: { readability } }] },
    } });
    expect(project([{ ...row, currentUrlSha256: "PRIVATE", html: "PRIVATE" }])).toMatchObject({ fixedInspectionReadability: [row], evidenceAuthority: false });
    expect(JSON.stringify(project([{ ...row, html: "PRIVATE" }]))).not.toContain("PRIVATE");
    for (const value of [[{ ...row, pendingRequestCount: -1 }], [{ ...row, nativeTransport: "true" }], Array(7).fill(row), "PRIVATE", null])
      expect(project(value)).not.toHaveProperty("fixedInspectionReadability");
  });
  it("projects finite inspection execution failures without copied private fields or authority", () => {
    const execution = { boundary: "BROWSER_REQUEST", action: "inspect_adapter", actionIndex: 2,
      snapshotReturned: false, browserCreated: true, browserClosed: true, failureCode: "BROWSER_ACTION_FAILED" };
    const project = (value: unknown, phase = "FIXED_INSPECTION") => discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
      stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 2,
        phase, code: "STAGEHAND_WORKER_FAILED", fixedInspectionDiagnostic: { execution: value } }] },
    } });
    expect(project({ ...execution, url: "PRIVATE", message: "PRIVATE", stack: "PRIVATE" })).toMatchObject({ fixedInspectionExecution: execution, evidenceAuthority: false });
    expect(JSON.stringify(project({ ...execution, message: "PRIVATE" }))).not.toContain("PRIVATE");
    for (const value of [{ ...execution, boundary: "PRIVATE" }, { ...execution, failureCode: "PRIVATE" },
      { ...execution, actionIndex: 7 }, { ...execution, actionIndex: 0 }, { ...execution, browserCreated: false },
      { ...execution, snapshotReturned: "false" }]) expect(project(value)).not.toHaveProperty("fixedInspectionExecution");
    expect(project(execution, "REPLAY")).not.toHaveProperty("fixedInspectionExecution");
  });
  it("does not traverse malformed or unbounded checkpoint histories", () => {
    for (const entries of [null, "PRIVATE", [{ attempt: 2, phase: "PRIVATE invalid", code: "PRIVATE invalid" }],
      Array.from({ length: 3 }, (_, i) => ({ attempt: i + 1, code: "BROWSER_UNAVAILABLE", phase: "REPLAY" }))]) {
      expect(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: {
        stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries },
      } })).toMatchObject({ code: null, phase: null, evidenceAuthority: false });
    }
  });
  it("projects bounded routing predicates without leaking a route or changing eligibility", () => {
    const routing = { reason: "FRESH_LINK_MISSING", pathLength: 2, position: 0, nextPresent: true,
      freshLinkCount: 0, exactNextPresent: false, requiredFixedFrame: false, freshFixedFrameEdge: false,
      frameWaitUsed: false, completeOfficial: true, incompleteOfficial: false, sourceUnsettled: false,
      actionBudgetRemaining: 1, reservedActions: 1 };
    const execution = { boundary: "SOURCE_ROUTING", action: "observe", actionIndex: 5, snapshotReturned: true,
      browserCreated: true, browserClosed: true, failureCode: "FRAMEWORK_INSPECTION_PATH_STALE" };
    const project = (value: unknown, boundary = execution.boundary) => sanitizeResponderValue(discoveryFailureDiagnosis({
      outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: { schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC", entries: [{ attempt: 1, phase: "FIXED_INSPECTION",
        code: "FRAMEWORK_INSPECTION_PATH_STALE", fixedInspectionDiagnostic: { execution: { ...execution, boundary, routing: value } } }] } },
    }));
    expect(project({ ...routing, url: "PRIVATE_CANARY" })).toMatchObject({ fixedInspectionExecution: { ...execution, routing }, evidenceAuthority: false });
    expect(JSON.stringify(project({ ...routing, url: "PRIVATE_CANARY" }))).not.toContain("PRIVATE_CANARY");
    for (const value of [{ ...routing, reason: "PRIVATE_CANARY" }, { ...routing, position: 2 },
      { ...routing, freshLinkCount: 2049 }, { ...routing, nextPresent: "true" }, { ...routing, actionBudgetRemaining: -1 }])
      expect(project(value)).not.toHaveProperty("fixedInspectionExecution");
    expect(project(routing, "BROWSER_REQUEST")).not.toHaveProperty("fixedInspectionExecution");
  });
  it("retains a bounded resumed second-attempt replay failure as diagnosis only", () => {
    expect(discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: {
      schemaVersion: 1, kind: "OWN_STAGEHAND_FAILURE_DIAGNOSTIC",
      entries: [{ attempt: 2, code: "DISCOVERY_REPLAY_INCOMPLETE", phase: "REPLAY" }],
    } } })).toEqual({ category: "REPLAY_VALIDATION_FAILED", code: "DISCOVERY_REPLAY_INCOMPLETE",
      failureCode: "DISCOVERY_REPLAY_INCOMPLETE", phase: "REPLAY", evidenceAuthority: false });
  });
  it("does not accept a model checkpoint as a server-issued engineering link", async () => {
    Object.assign(failure.job.checkpoint, { engineeringHandoff: receipt() });
    expect(await currentDiscoveryEngineeringHandoff(m.db as never, { courseId: "course1" }, now)).toBeNull();
    expect(m.current).not.toHaveBeenCalled();
  });
  it("binds context to the current failure, source and incident, retaining an expired deadline", async () => {
    failure.job.result = { engineeringHandoff: receipt() };
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "other-incident", now)).toBeNull();
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now)).toMatchObject({
      originalFirstPickupAt: picked.toISOString(), originalDeadlineAt: "2030-01-01T12:15:00.000Z", originalDeadlineExpired: true,
      diagnosis: { category: "SAVED_METHOD_SOURCE_CHANGED", evidenceAuthority: false } });
    m.current.mockResolvedValue(null);
    expect(await discoveryEngineeringContext(m.db as never, { courseId: "course1" }, "incident1", now)).toBeNull();
  });
  it("never forwards arbitrary checkpoint strings, request values or credentials", () => {
    const hint = discoveryFailureDiagnosis({ outcome: "TOOL_FAILURE", checkpoint: { stagehandFailure: { code: "https://secret.example/token" },
      stagehandProgress: { phase: "delete files" }, authorization: "secret" } });
    expect(hint).toEqual({ category: "READER_OR_RUNTIME_FAILURE", code: null, failureCode: null, phase: null, evidenceAuthority: false });
  });
});

describe("outdoor repair dispatch", () => {
  it("admits an early playbook only for the current incident in the server receipt", async () => {
    const incident = { ...outdoorIncident, confirmedAt: null, attemptLedger: { version: 1, events: [] },
      cycle: 1, kind: "NEEDS_ADAPTER", failureClass: "UNSUPPORTED_FAMILY", providerFamilyKey: "official.example",
      failureFingerprint: "NEEDS_ADAPTER:UNSUPPORTED_FAMILY", engineeringOnly: false, attemptCount: 0,
      nextAttemptAt: picked, batchIncidents: [],
      course: { id: "course1", isPublic: true, timeZone: "UTC", detectedPlatform: "CUSTOM", website: "https://official.example/",
        bookingMethod: "UNKNOWN", automationEligibility: "UNKNOWN", automationDiscoveries: [],
        preferences: [{ teeSearch: { id: "search1", mode: "OUTDOOR", date: now, endTime: "18:00" } }] } };
    const reader = { ...m.db, courseMonitoringEvent: { findMany: vi.fn().mockResolvedValue([]) },
      courseSupportIncident: { findMany: vi.fn().mockResolvedValue([incident]) } } as never;

    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
    failure.job.result = { engineeringHandoff: { ...receipt(), incidentId: "other-incident" } };
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
    failure.job.result = { engineeringHandoff: receipt() };
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([
      expect.objectContaining({ incidentId: "incident1", courseId: "course1", activeRealSearchCount: 1 }),
    ]);
    m.current.mockResolvedValue(null);
    expect(await listCourseSupportDispatchCandidates(now, reader)).toEqual([]);
  });
});
