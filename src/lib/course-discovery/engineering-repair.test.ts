// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  discoveryFailureDiagnosis, getOwnedLearningBookingEdgeEvidence, getOwnedLearningFailureEvidence, reconcileDiscoveryEngineeringHandoffs } from "./engineering-repair";
import { collectBookingEdgeEvidence } from "./booking-edge-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { listCourseSupportDispatchCandidates } from "@/lib/automation/course-support-batches";
import { sanitizeResponderValue } from "@/lib/automation/course-support-responder-policy";
import { createDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";
import { cpsCatalogIdentityFailureStages } from "./cps-source";
import { safeFixedInspectionSourceDiagnostic, safeBrowserFailureDiagnostics } from "../../../scripts/automation/course-discovery-worker.mjs";
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
describe("terminal learner to coding responder", () => {
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
    expect(JSON.stringify(result)).not.toMatch(/private|token|PRIVATE/iu);
    if (code === "DISCOVERY_NATIVE_TRANSPORT_FATAL") expect(result).toMatchObject({ category: "BROWSER_TRANSPORT_REJECTED",
      nativeTransportDiagnostic: { failureCode: "NATIVE_REDIRECT_RESPONSE_TIMEOUT", phase: "RESPONSE_WAIT", method: "GET", resourceType: "document" } });
    else expect(result).not.toHaveProperty("nativeTransportDiagnostic");
    expect(result).not.toHaveProperty("delegationDiagnostic");
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
