import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as nativeCampaign from "@/lib/automation/course-support-campaign";
import type { ParkedCourseCampaignMember } from "@/lib/automation/course-support-campaign";
import * as fleet from "./course-fleet";
import { ACCEPTANCE_READ_LIMITS, AcceptanceReadFence } from "./course-support-acceptance-read-boundary";
import * as byteBoundary from "./course-support-acceptance-read-size-boundary";
import { ACCEPTANCE_READ_PHASES, type AcceptanceReadPhase } from "./course-support-acceptance-read-fence";
import {
  loadCourseSupportAcceptanceProjection,
  parseCourseSupportAcceptanceProjection,
} from "./course-support-acceptance";
import {
  buildAcceptanceReasonsReport,
  loadCourseSupportAcceptanceReasons,
  runAcceptanceReasonsDiagnostic,
  unavailableAcceptanceReasons,
  withAcceptanceReadPhase,
} from "./course-support-acceptance-reasons";
import * as campaign from "./course-support-campaign";

const sourceSha = "a".repeat(40);
const capturedAt = new Date("2026-08-20T12:00:00.000Z");
const databaseNow = new Date("2026-08-21T12:00:00.000Z");
const privateMarker = "private-course-provider-actor-run-secret";

function campaignMember(index: number): ParkedCourseCampaignMember {
  return {
    courseId: `${privateMarker}-course-${index}`,
    incidentId: `${privateMarker}-incident-${index}`,
    cycle: 1, revision: 1, monitoringRevision: 1, monitoringFailureFingerprint: null,
    kind: "FETCH_FAILED", providerFamilyKey: `${privateMarker}-family-${index}`,
    failureClass: "UNSUPPORTED_FAMILY", failureFingerprint: `${index}`.padStart(64, "0"),
    providerSnapshotFingerprint: `${index + 1}`.padStart(64, "0"),
    attemptLedgerFingerprint: `${index + 2}`.padStart(64, "0"),
    playbookConclusion: "UNRESOLVED_EXHAUSTED", latestProbeAt: null, latestDiscoveryAt: null,
  };
}

async function nativeFixture() {
  const audit = nativeCampaign.createParkedCourseCampaignAudit({ capturedAt, expectedCount: 112,
    members: Array.from({ length: 112 }, (_, index) => campaignMember(index)) });
  const inspection: campaign.CampaignInspection = {
    runId: `${privateMarker}-run`, status: "COMPLETED", capturedAt: audit.capturedAt,
    expectedCount: 112, totalCount: 112, terminalCount: 112, pendingCount: 0, readyCount: 0,
    activeCount: 0, monitoredCount: 112, bookingNotOpenCount: 0, factualLimitationCount: 0,
    technicalLimitationCount: 0, sourceUnverifiedCount: 0, engineeringBlockerCount: 0,
    currentResultMissingCount: 0, humanReviewCount: 0, terminalWithin24HoursCount: 112,
    automaticWithin24HoursCount: 112, remainingGlobalParkedCount: 0,
    membershipDigest: audit.membershipDigest,
  };
  const futureIncidents: campaign.FutureAutomaticResolutionInput["incidents"] = [{
    id: `${privateMarker}-future`, courseId: `${privateMarker}-future-course`, cycle: 1,
    status: "RESOLVED", resolution: "MONITORING_RESTORED",
    confirmedAt: new Date("2026-08-20T14:00:00.000Z"),
    lastSeenAt: new Date("2026-08-20T15:00:00.000Z"),
    resolvedAt: new Date("2026-08-20T15:00:00.000Z"), decisionAt: null, decisionActorId: null,
    campaignAdmissionEvents: [], terminalEvents: [{
      eventType: "RECOVERED", toState: null, source: "COURSE_SUPPORT_RESPONDER",
      operatorActorId: null, runtimeVersion: null, deploymentSha: sourceSha,
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      audit: { cycle: 1, confirmedAt: "2026-08-20T14:00:00.000Z", automatedFinal: true },
    }],
  }];
  const rollingEvents: campaign.RollingEndpointEvent[] = [{
    incidentId: `${privateMarker}-rolling`, eventType: "HUMAN_REVIEW_REQUESTED", toState: null,
    source: "COURSE_SUPPORT_RESPONDER", operatorActorId: null, runtimeVersion: null,
    deploymentSha: null, occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    countsAsEndpoint: false, audit: {},
  }, {
    incidentId: `${privateMarker}-rolling`, eventType: "RECOVERED", toState: null,
    source: "COURSE_SUPPORT_RESPONDER", operatorActorId: null, runtimeVersion: sourceSha,
    deploymentSha: sourceSha, occurredAt: new Date("2026-08-20T15:00:00.000Z"),
    countsAsEndpoint: true, audit: { cycle: 2, automatedFinal: true },
  }];
  const future = campaign.assessFutureAutomaticResolution({ campaignCapturedAt: capturedAt,
    campaignRunId: inspection.runId, campaignMembershipDigest: audit.membershipDigest,
    campaignIncidentCycles: audit.members.map(({ incidentId, cycle }) => ({ incidentId, cycle })),
    incidents: futureIncidents, now: databaseNow });
  const rolling = campaign.assessRollingHumanReview(rollingEvents);
  const summary = campaign.buildOperatorCourseSupportCampaignSummary({ campaign: inspection,
    futureAutomaticWithin24Hours: future.summary, rollingHumanReview: rolling.summary,
    repeatImplementations: campaign.summarizeRepeatProviderImplementations({ batches: [] }),
    now: databaseNow });
  const record = { id: inspection.runId, status: "COMPLETED", audit, notes: null };
  const fleetCounts: fleet.OperatorCourseFleetCounts = {
    action: 0, watch: 0, parked: 0, limitations: 0, unchecked: 0, working: 112,
    dueNow: 0, inProgress: 0, recoveryRequired: 0, scheduledRetry: 0,
    engineeringNeeded: 0, needsHuman: 0,
  };
  const { runId, totalCount, ...observedCampaign } = inspection;
  void runId; void totalCount;
  const projection = await loadCourseSupportAcceptanceProjection({ now: databaseNow, observedCampaign }, {
    loadCourseFleetCounts: async () => fleetCounts,
    loadLatestCampaignRecord: async () => record,
    loadFreshGlobalParkedCount: async () => 0,
    loadCampaignSummary: async () => summary,
  });
  if (!projection.operational || !parseCourseSupportAcceptanceProjection(projection)) {
    throw new Error("Synthetic native projection fixture must be valid.");
  }
  return { audit, inspection, futureIncidents, rollingEvents, future, rolling, summary,
    record, fleetCounts, projection };
}

let fixture: Awaited<ReturnType<typeof nativeFixture>>;
beforeEach(async () => { vi.restoreAllMocks(); fixture = await nativeFixture(); });
afterEach(() => { vi.restoreAllMocks(); });

function reportInput() {
  return { sourceSha, observedAt: databaseNow, acceptanceProjection: fixture.projection,
    future: fixture.future, rolling: fixture.rolling };
}

function expectPrivateEvidenceAbsent(value: unknown) {
  expect(value).toMatchObject({ recordType: "course_support_acceptance_reasons", schemaVersion: 3 });
  expect(value).toHaveProperty("readFence");
  const serialized = JSON.stringify(value);
  for (const privateValue of [privateMarker, "postgresql://private:credential", "private@example.test", "https://private.example.test"]) {
    expect(serialized).not.toContain(privateValue);
  }
}

describe("native acceptance reason report", () => {
  it("retains the valid native UNKNOWN projection and null rates unchanged", () => {
    const before = JSON.stringify(fixture.projection);
    const result = buildAcceptanceReasonsReport(reportInput());
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "AVAILABLE", reason: "COMPLETE_NATIVE_TRACE",
      evidenceReadComplete: true, customerDataIncluded: false,
      futureUnknown: { nativeCount: 1, classifiedCount: 1, reconciliation: "MATCH",
        primaryReasonCounts: { RELEASE_PROOF_UNAVAILABLE_OR_CONFLICTING: 1 } },
      rollingAmbiguous: { nativeCount: 1, classifiedCount: 1, reconciliation: "MATCH",
        primaryReasonCounts: { OLDER_HISTORY_CYCLE_UNSCOPED: 1 } },
    });
    expect(result.acceptanceProjection).toBe(fixture.projection);
    expect(result.acceptanceProjection).toMatchObject({ schemaVersion: 1, status: "UNKNOWN", operational: {
      futureAutomaticWithin24Hours: { ratePercent: null, targetPercent: 95, status: "UNKNOWN" },
      rollingHumanReview: { ratePercent: null, targetPercent: 5, status: "UNKNOWN" },
    } });
    expect(JSON.stringify(fixture.projection)).toBe(before);
    expectPrivateEvidenceAbsent(result);
  });

  it.each(["future count", "rolling count", "future summary", "rolling summary"])("rejects %s mismatch without replacing the valid projection", (change) => {
    const input = reportInput();
    if (change === "future count") input.future = { ...fixture.future, primaryReasonCounts: {} };
    if (change === "rolling count") input.rolling = { ...fixture.rolling, primaryReasonCounts: { OLDER_HISTORY_CYCLE_UNSCOPED: 2 } };
    if (change === "future summary") input.future = { ...fixture.future, summary: { ...fixture.future.summary, pendingCount: 1 } };
    if (change === "rolling summary") input.rolling = { ...fixture.rolling, summary: { ...fixture.rolling.summary, humanReviewCount: 1 } };
    const result = buildAcceptanceReasonsReport(input);
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "COUNT_RECONCILIATION_FAILED",
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(result.acceptanceProjection).toBe(fixture.projection);
  });

  it.each([
    { [privateMarker]: 0 },
    { RELEASE_PROOF_UNAVAILABLE_OR_CONFLICTING: -1 },
    { RELEASE_PROOF_UNAVAILABLE_OR_CONFLICTING: 1.5 },
    { RELEASE_PROOF_UNAVAILABLE_OR_CONFLICTING: Number.MAX_SAFE_INTEGER + 1 },
    { RELEASE_PROOF_UNAVAILABLE_OR_CONFLICTING: "private@example.test" },
  ])("rejects unknown/private or invalid reason counts %#", (invalidCounts) => {
    const result = buildAcceptanceReasonsReport({ ...reportInput(), future: {
      ...fixture.future, primaryReasonCounts: invalidCounts as campaign.CourseSupportAcceptancePrimaryReasonCounts,
    } });
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "COUNT_RECONCILIATION_FAILED", futureUnknown: null });
    expectPrivateEvidenceAbsent(result);
  });

  it("rejects a projection containing an extra private field through the native parser", () => {
    const result = buildAcceptanceReasonsReport({ ...reportInput(), acceptanceProjection: {
      ...fixture.projection, privateCourse: privateMarker,
    } as typeof fixture.projection });
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "PROJECTION_SNAPSHOT_UNAVAILABLE", acceptanceProjection: null });
    expectPrivateEvidenceAbsent(result);
  });

  it.each(["sha", "clock"])("rejects invalid %s before retaining any supplied evidence", (invalid) => {
    const result = buildAcceptanceReasonsReport({ ...reportInput(),
      ...(invalid === "sha" ? { sourceSha: privateMarker } : { observedAt: new Date("invalid") }) });
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", sourceSha: null, observedAt: null,
      reason: "INVALID_ARGUMENTS", acceptanceProjection: null });
    expectPrivateEvidenceAbsent(result);
  });

  it("attributes the output bound to report construction while retaining the native projection", () => {
    vi.spyOn(Buffer, "byteLength").mockReturnValueOnce(ACCEPTANCE_READ_LIMITS.outputBytes + 1);
    const result = buildAcceptanceReasonsReport(reportInput());
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "REPORT_CONSTRUCTION", boundary: "OUTPUT_BYTES" },
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(result.acceptanceProjection).toBe(fixture.projection);
    expectPrivateEvidenceAbsent(result);
  });

  it.each([
    { phase: privateMarker, boundary: "TOP_LEVEL_ROWS" },
    { phase: "FLEET", boundary: privateMarker },
    { phase: "FLEET", boundary: "TOP_LEVEL_ROWS", privateUrl: "https://private.example.test" },
    { phase: "FLEET", boundary: "SELECTED_EVIDENCE_BYTES", privateUrl: "https://private.example.test" },
    { phase: "FLEET", boundary: "selected_evidence_bytes" },
    { phase: "FLEET" },
  ])("drops invalid or private read-fence metadata from unavailable reports %#", (readFence) => {
    const result = unavailableAcceptanceReasons({ sourceSha, reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence } as Parameters<typeof unavailableAcceptanceReasons>[0]);
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", readFence: null,
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null });
    expectPrivateEvidenceAbsent(result);
  });

  it.each(["READ_TIMEOUT", "READ_FAILED", "COUNT_RECONCILIATION_FAILED"] as const)("does not add a read-fence inference to %s", (reason) => {
    const result = unavailableAcceptanceReasons({ sourceSha, reason,
      readFence: { phase: "FLEET", boundary: "TOP_LEVEL_ROWS" } });
    expect(result).toMatchObject({ schemaVersion: 3, reason, readFence: null });
    expectPrivateEvidenceAbsent(result);
  });

  it.each(["WHOLE_ROW_BYTES", "SELECTED_EVIDENCE_BYTES"] as const)("publishes schema 3 with the validated %s tag without reinterpreting native acceptance", (boundary) => {
    const before = JSON.stringify(fixture.projection);
    const result = unavailableAcceptanceReasons({ sourceSha, reason: "EVIDENCE_BOUND_EXCEEDED",
      acceptanceProjection: fixture.projection, readFence: { phase: "CAMPAIGN_INSPECTION", boundary } });
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "CAMPAIGN_INSPECTION", boundary },
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(result.acceptanceProjection).toBe(fixture.projection);
    expect(result.acceptanceProjection).toHaveProperty("schemaVersion", 1);
    expect(JSON.stringify(fixture.projection)).toBe(before);
    expectPrivateEvidenceAbsent(result);
  });
});

describe("immutable native read phase tagging", () => {
  it("keeps both optional-boundary constructors backward compatible", async () => {
    for (const error of [new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED"),
      new byteBoundary.AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED")]) {
      expect(error).toMatchObject({ message: "EVIDENCE_BOUND_EXCEEDED", reason: "EVIDENCE_BOUND_EXCEEDED", boundary: null });
    }
    const original = new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED");
    await expect(withAcceptanceReadPhase("FUTURE_CYCLES", async () => { throw original; })).rejects.toBe(original);
  });

  it.each(ACCEPTANCE_READ_PHASES)("retains the first throwing phase %s through nested wrappers without mutating the original error", async (phase) => {
    const original = new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TOP_LEVEL_ROWS");
    const tagged: unknown = await withAcceptanceReadPhase(phase, async () => { throw original; }).catch(error => error);
    expect(tagged).toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED", phase, boundary: "TOP_LEVEL_ROWS" });
    expect(original).not.toHaveProperty("phase");
    await expect(withAcceptanceReadPhase("REPORT_CONSTRUCTION", async () => { throw tagged; })).rejects.toBe(tagged);
  });

  it.each(["P2028", "57014"])("preserves the exact native timeout %s rather than turning it into a bound", async (code) => {
    const original = Object.assign(new Error(privateMarker), { code, reason: "EVIDENCE_BOUND_EXCEEDED",
      boundary: "TOP_LEVEL_ROWS", phase: "FUTURE_CYCLES" });
    await expect(withAcceptanceReadPhase("IMPLEMENTATION_HISTORY", async () => { throw original; })).rejects.toBe(original);
  });
});

function transactionHarness() {
  // Real byte preflight selectors and SQL are covered by the boundary tests.
  // This harness retains native projection, classifier and orchestration calls.
  const bytePreflight = vi.fn<ReturnType<typeof byteBoundary.createAcceptanceBytePreflight>>().mockResolvedValue(undefined);
  vi.spyOn(byteBoundary, "createAcceptanceBytePreflight").mockReturnValue(bytePreflight);
  const transaction = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ now: databaseNow }]),
    automationRun: { findFirst: vi.fn().mockResolvedValue(fixture.record) },
    courseSupportIncident: { count: vi.fn().mockResolvedValue(0) },
    course: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    teeSearch: { count: vi.fn().mockResolvedValue(0) },
  };
  const database = { $transaction: vi.fn(async (worker: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    worker(transaction as unknown as Prisma.TransactionClient)) };
  const inspection = vi.spyOn(nativeCampaign, "inspectLatestParkedCourseCampaign").mockResolvedValue(fixture.inspection);
  const fleetRead = vi.spyOn(fleet, "loadOperatorCourseFleetCounts").mockResolvedValue(fixture.fleetCounts);
  const reads = {
    inspectLatestCampaign: vi.fn().mockResolvedValue(fixture.inspection),
    loadCampaignAudit: vi.fn().mockResolvedValue(fixture.audit),
    loadRollingEndpointEvents: vi.fn().mockResolvedValue(fixture.rollingEvents),
    loadFutureUnfamiliarIncidents: vi.fn().mockResolvedValue(fixture.futureIncidents),
    loadImplementationBatches: vi.fn().mockResolvedValue([]),
  };
  const dependencies = vi.spyOn(campaign, "createOperatorCourseSupportCampaignDependencies").mockReturnValue(reads);
  return { transaction, database, inspection, fleetRead, reads, dependencies, bytePreflight,
    read: async () => {
      const result = await loadCourseSupportAcceptanceReasons(database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], sourceSha);
      expect(result).toMatchObject({ schemaVersion: 3 });
      expect(result).toHaveProperty("readFence");
      return result;
    } };
}

describe("bounded read-only native reason snapshot", () => {
  it("uses one database clock, client and RepeatableRead transaction for native evidence and projection", async () => {
    const state = transactionHarness();
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "AVAILABLE", observedAt: databaseNow.toISOString(), acceptanceProjection: fixture.projection });
    expect(state.database.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000,
    });
    expect(state.transaction.$executeRawUnsafe.mock.calls).toEqual([
      ["SET TRANSACTION READ ONLY"], ["SET LOCAL statement_timeout = '25000ms'"],
    ]);
    expect(state.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(state.transaction.$executeRawUnsafe.mock.invocationCallOrder[1]).toBeLessThan(state.transaction.$queryRaw.mock.invocationCallOrder[0]);
    expect(state.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(state.inspection.mock.invocationCallOrder[0]);
    const readClient = state.inspection.mock.calls[0][0];
    expect(state.inspection.mock.calls).toHaveLength(1);
    expect(state.inspection.mock.calls[0][1]).toEqual({ now: databaseNow, admissionRuntimeVersion: sourceSha });
    // Identity comparisons avoid asking the deliberately restricted client
    // proxy for assertion-framework introspection or mutation methods.
    expect(state.dependencies.mock.calls[0][0] === readClient).toBe(true);
    expect(state.dependencies.mock.calls[0][1]).toEqual({ now: databaseNow, admissionRuntimeVersion: sourceSha });
    expect(state.fleetRead.mock.calls[0][0]).toEqual({ now: databaseNow });
    expect(state.fleetRead.mock.calls[0][1] === readClient).toBe(true);
    expect(state.reads.loadFutureUnfamiliarIncidents).toHaveBeenCalledExactlyOnceWith({ since: capturedAt, until: databaseNow });
    expect(state.reads.loadRollingEndpointEvents).toHaveBeenCalledExactlyOnceWith({
      since: new Date(databaseNow.getTime() - 30 * 24 * 60 * 60 * 1_000), until: databaseNow,
    });
    expect(state.transaction.course.updateMany).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it.each([[], [{ now: new Date("invalid") }], [{ now: databaseNow }, { now: databaseNow }]])("fails an unavailable/invalid/nonunique DB clock %# before native reads", async (clock) => {
    const state = transactionHarness();
    state.transaction.$queryRaw.mockResolvedValue(clock);
    expect(await state.read()).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "READ_FAILED", observedAt: null });
    expect(state.inspection).not.toHaveBeenCalled();
    expect(state.dependencies).not.toHaveBeenCalled();
    expect(state.transaction.automationRun.findFirst).not.toHaveBeenCalled();
  });

  it("stops a missing latest campaign before audit and projection reads", async () => {
    const state = transactionHarness();
    state.inspection.mockResolvedValue(null);
    expect(await state.read()).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "CAMPAIGN_UNAVAILABLE", observedAt: databaseNow.toISOString() });
    expect(state.transaction.automationRun.findFirst).not.toHaveBeenCalled();
    expect(state.dependencies).not.toHaveBeenCalled();
    expect(state.fleetRead).not.toHaveBeenCalled();
  });

  it.each(["missing", "different run", "invalid audit"])("rejects a %s immutable campaign record", async (failure) => {
    const state = transactionHarness();
    const record = failure === "missing" ? null
      : { ...fixture.record, ...(failure === "different run" ? { id: "different-run" } : { audit: null }) };
    state.transaction.automationRun.findFirst.mockResolvedValue(record);
    expect(await state.read()).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "CAMPAIGN_UNAVAILABLE" });
    expect(state.dependencies).not.toHaveBeenCalled();
  });

  it("retains a valid native unavailable projection when fresh campaign bindings conflict", async () => {
    const state = transactionHarness();
    const changedAudit = nativeCampaign.createParkedCourseCampaignAudit({
      capturedAt: new Date(capturedAt.getTime() + 60_000), expectedCount: 112,
      members: Array.from({ length: 112 }, (_, index) => campaignMember(index)),
    });
    state.transaction.automationRun.findFirst.mockResolvedValue({ ...fixture.record, audit: changedAudit });
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "PROJECTION_SNAPSHOT_UNAVAILABLE",
      futureUnknown: null, rollingAmbiguous: null, acceptanceProjection: {
        status: "UNKNOWN", reason: "LATEST_CAMPAIGN_UNAVAILABLE", latestCampaign: null, operational: null,
      } });
    expect(parseCourseSupportAcceptanceProjection(result.acceptanceProjection)).toEqual(result.acceptanceProjection);
    expect(state.reads.loadFutureUnfamiliarIncidents).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it("fails a combined future-incident bound without publishing sampled reason totals", async () => {
    const state = transactionHarness();
    state.reads.loadFutureUnfamiliarIncidents.mockResolvedValue(
      Array.from({ length: ACCEPTANCE_READ_LIMITS.incidentRows + 1 }, () => fixture.futureIncidents[0]),
    );
    expect(await state.read()).toMatchObject({ schemaVersion: 3, readFence: { phase: "FUTURE_CYCLES", boundary: "COMBINED_FUTURE_ROWS" }, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
  });

  it.each(["P2028", "57014", "OTHER"])("classifies native transaction error %s without raw output", async (code) => {
    const state = transactionHarness();
    state.database.$transaction.mockRejectedValue(Object.assign(new Error(`${privateMarker} postgresql://private:credential https://private.example.test private@example.test`), { code }));
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: code === "OTHER" ? "READ_FAILED" : "READ_TIMEOUT",
      futureUnknown: null, rollingAmbiguous: null, acceptanceProjection: null });
    expectPrivateEvidenceAbsent(result);
  });

  it("suppresses native loader errors after the database clock is known", async () => {
    const state = transactionHarness();
    state.inspection.mockRejectedValue(new Error(`${privateMarker} https://private.example.test private@example.test`));
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "READ_FAILED", observedAt: databaseNow.toISOString(),
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null });
    expectPrivateEvidenceAbsent(result);
  });

  it("makes an over-bound native read unavailable before fetching partial rows", async () => {
    const state = transactionHarness();
    state.transaction.course.count.mockResolvedValue(ACCEPTANCE_READ_LIMITS.courseRows + 1);
    state.inspection.mockImplementation(async (read) => {
      await (read as Prisma.TransactionClient).course.findMany({ select: { id: true } });
      return fixture.inspection;
    });
    expect(await state.read()).toMatchObject({ schemaVersion: 3, readFence: { phase: "CAMPAIGN_INSPECTION", boundary: "TOP_LEVEL_ROWS" }, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(state.transaction.course.findMany).not.toHaveBeenCalled();
    expect(state.dependencies).not.toHaveBeenCalled();
  });

  it.each(["EVIDENCE_BOUND_EXCEEDED", "READ_FAILED"] as const)("stops byte-preflight fence %s before evidence hydration or reason publication", async (reason) => {
    const state = transactionHarness();
    state.bytePreflight.mockRejectedValue(new byteBoundary.AcceptanceBytePreflightFence(reason));
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason,
      observedAt: databaseNow.toISOString(), acceptanceProjection: null,
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false,
      customerDataIncluded: false });
    expect(state.bytePreflight).toHaveBeenCalledTimes(1);
    expect(state.bytePreflight.mock.calls[0].slice(0, 2)).toEqual(["automationRun", "findFirst"]);
    expect(state.transaction.automationRun.findFirst).not.toHaveBeenCalled();
    expect(state.transaction.course.findMany).not.toHaveBeenCalled();
    expect(state.dependencies).not.toHaveBeenCalled();
    expect(state.fleetRead).not.toHaveBeenCalled();
    expect(state.reads.loadFutureUnfamiliarIncidents).not.toHaveBeenCalled();
    expect(state.reads.loadRollingEndpointEvents).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it("publishes only the fixed selected-evidence byte tag before latest campaign record hydration", async () => {
    const state = transactionHarness();
    state.bytePreflight.mockRejectedValue(Object.assign(
      new byteBoundary.AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES"),
      { sql: `${privateMarker} https://private.example.test`, selectedIds: [privateMarker] },
    ));
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "LATEST_CAMPAIGN_RECORD", boundary: "SELECTED_EVIDENCE_BYTES" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(state.bytePreflight).toHaveBeenCalledTimes(1);
    expect(state.transaction.automationRun.findFirst).not.toHaveBeenCalled();
    expect(state.dependencies).not.toHaveBeenCalled();
    expect(state.fleetRead).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it("rejects mutation access on the bounded native client before any DB write", async () => {
    const state = transactionHarness();
    state.inspection.mockImplementation(async (read) => {
      await (read as Prisma.TransactionClient).course.updateMany({ where: { id: privateMarker }, data: { isPublic: true } });
      return fixture.inspection;
    });
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "READ_FAILED" });
    expect(state.transaction.course.updateMany).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it("rejects an invalid source SHA before opening the transaction", async () => {
    const state = transactionHarness();
    expect(await loadCourseSupportAcceptanceReasons(state.database as unknown as Parameters<typeof loadCourseSupportAcceptanceReasons>[0], privateMarker)).toMatchObject({
      schemaVersion: 3, readFence: null, status: "UNAVAILABLE", sourceSha: null, reason: "INVALID_ARGUMENTS",
    });
    expect(state.database.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { loader: "inspection", phase: "CAMPAIGN_INSPECTION" },
    { loader: "record", phase: "LATEST_CAMPAIGN_RECORD" },
    { loader: "fleet", phase: "FLEET" },
    { loader: "future", phase: "FUTURE_CYCLES" },
    { loader: "rolling", phase: "ROLLING_ENDPOINTS" },
    { loader: "implementation", phase: "IMPLEMENTATION_HISTORY" },
  ] as const)("attributes an actual bounded $loader failure to $phase and publishes no partial evidence", async ({ loader, phase }) => {
    const state = transactionHarness();
    const error = new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TOP_LEVEL_ROWS");
    if (loader === "inspection") state.inspection.mockRejectedValue(error);
    if (loader === "record") state.transaction.automationRun.findFirst.mockRejectedValue(error);
    if (loader === "fleet") state.fleetRead.mockRejectedValue(error);
    if (loader === "future") state.reads.loadFutureUnfamiliarIncidents.mockRejectedValue(error);
    if (loader === "rolling") state.reads.loadRollingEndpointEvents.mockRejectedValue(error);
    if (loader === "implementation") state.reads.loadImplementationBatches.mockRejectedValue(error);
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase, boundary: "TOP_LEVEL_ROWS" }, acceptanceProjection: null,
      futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expectPrivateEvidenceAbsent(result);
  });

  it("preserves the future loader phase after a concurrent implementation read has started", async () => {
    const state = transactionHarness();
    const otherStarted = deferred<void>();
    state.reads.loadFutureUnfamiliarIncidents.mockImplementation(async () => {
      await otherStarted.promise;
      throw new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "INCIDENT_HISTORY_ROWS");
    });
    state.reads.loadImplementationBatches.mockImplementation(async () => {
      otherStarted.resolve();
      return [];
    });
    const result = await state.read();
    expect(state.reads.loadImplementationBatches).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: "FUTURE_CYCLES", boundary: "INCIDENT_HISTORY_ROWS" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expectPrivateEvidenceAbsent(result);
  });

  it("shares the finite operation budget across concurrent native future and implementation loaders", async () => {
    const state = transactionHarness();
    const observedFailures: AcceptanceReadPhase[] = [];
    const consume = async (phase: AcceptanceReadPhase) => {
      const read = state.dependencies.mock.calls[0][0] as Prisma.TransactionClient;
      try {
        for (let index = 0; index < ACCEPTANCE_READ_LIMITS.queryCount / 2 + 2; index++) await read.teeSearch.count();
      } catch (error) {
        observedFailures.push(phase);
        throw error;
      }
    };
    state.reads.loadFutureUnfamiliarIncidents.mockImplementation(async () => {
      await consume("FUTURE_CYCLES");
      return fixture.futureIncidents;
    });
    state.reads.loadImplementationBatches.mockImplementation(async () => {
      await consume("IMPLEMENTATION_HISTORY");
      return [];
    });
    const result = await state.read();
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "EVIDENCE_BOUND_EXCEEDED",
      readFence: { phase: observedFailures[0], boundary: "QUERY_OPERATIONS" },
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expect(observedFailures).not.toHaveLength(0);
    expect(state.transaction.teeSearch.count.mock.calls.length).toBeLessThanOrEqual(ACCEPTANCE_READ_LIMITS.queryCount);
    expect(state.transaction.teeSearch.count.mock.calls.length).toBeGreaterThan(ACCEPTANCE_READ_LIMITS.queryCount / 2);
    expect(state.bytePreflight).toHaveBeenCalledTimes(1);
    expectPrivateEvidenceAbsent(result);
  });

  it.each(["lookalike", "private boundary", "private reason", "failed reason", "timeout"] as const)("keeps %s metadata unavailable without leaking a forged error", async (kind) => {
    const state = transactionHarness();
    let error: Error;
    if (kind === "lookalike" || kind === "timeout") {
      error = Object.assign(new Error(`${privateMarker} https://private.example.test private@example.test`), {
        reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "TOP_LEVEL_ROWS", phase: "FLEET",
        ...(kind === "timeout" ? { code: "57014" } : {}),
      });
    } else {
      error = new AcceptanceReadFence(kind === "failed reason" ? "READ_FAILED" : "EVIDENCE_BOUND_EXCEEDED", "TOP_LEVEL_ROWS");
      if (kind === "private boundary") Object.defineProperty(error, "boundary", { value: privateMarker });
      if (kind === "private reason") Object.defineProperty(error, "reason", { value: privateMarker });
      Object.assign(error, { phase: "FLEET", privateUrl: "https://private.example.test" });
    }
    state.inspection.mockRejectedValue(error);
    const result = await state.read();
    expect(result).toMatchObject({ schemaVersion: 3, status: "UNAVAILABLE", readFence: null,
      reason: kind === "timeout" ? "READ_TIMEOUT" : kind === "private boundary" ? "EVIDENCE_BOUND_EXCEEDED" : "READ_FAILED",
      acceptanceProjection: null, futureUnknown: null, rollingAmbiguous: null, evidenceReadComplete: false });
    expectPrivateEvidenceAbsent(result);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function runnerDependencies() {
  return { loadEnvironment: vi.fn().mockResolvedValue(undefined), getDatabaseUrl: vi.fn().mockReturnValue("postgresql://configured-database"),
    readGitSourceSha: vi.fn().mockReturnValue(sourceSha), isCheckoutClean: vi.fn().mockReturnValue(true),
    read: vi.fn().mockResolvedValue(buildAcceptanceReasonsReport(reportInput())) };
}

describe("acceptance reason CLI fences", () => {
  it.each([[], ["--source-sha", sourceSha], ["--read-only", "--source-sha", "short"],
    ["--apply", "--source-sha", sourceSha], ["--read-only", "--source-sha", sourceSha, "--scheduled-cycle"]]
    .map(args => ({ args })))("rejects flags/arguments %# before loading any environment or evidence", async ({ args }) => {
    const dependencies = runnerDependencies();
    expect(await runAcceptanceReasonsDiagnostic({ args }, dependencies)).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "INVALID_ARGUMENTS" });
    expect(dependencies.readGitSourceSha).not.toHaveBeenCalled();
    expect(dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
  });

  it.each(["different SHA", "dirty checkout", "Git failure"])("stops %s before environment or DB reads", async (fence) => {
    const dependencies = runnerDependencies();
    if (fence === "different SHA") dependencies.readGitSourceSha.mockReturnValue("b".repeat(40));
    if (fence === "dirty checkout") dependencies.isCheckoutClean.mockReturnValue(false);
    if (fence === "Git failure") dependencies.readGitSourceSha.mockImplementation(() => { throw new Error(privateMarker); });
    const result = await runAcceptanceReasonsDiagnostic({ args: ["--read-only", "--source-sha", sourceSha] }, dependencies);
    expect(result).toMatchObject({ schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: fence === "Git failure" ? "READ_FAILED" : "INVALID_ARGUMENTS" });
    expect(dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });

  it.each([undefined, "", "  "])("requires an explicit loaded DB URL %# before opening native reads", async (url) => {
    const dependencies = runnerDependencies();
    dependencies.getDatabaseUrl.mockReturnValue(url);
    expect(await runAcceptanceReasonsDiagnostic({ args: ["--read-only", "--source-sha", sourceSha] }, dependencies)).toMatchObject({
      schemaVersion: 3, readFence: null, status: "UNAVAILABLE", reason: "DATABASE_UNAVAILABLE", sourceSha,
    });
    expect(dependencies.loadEnvironment).toHaveBeenCalledTimes(1);
    expect(dependencies.read).not.toHaveBeenCalled();
  });

  it("returns the native report unchanged after all gates, using the exact requested SHA", async () => {
    const dependencies = runnerDependencies();
    const native = buildAcceptanceReasonsReport(reportInput());
    dependencies.read.mockResolvedValue(native);
    expect(await runAcceptanceReasonsDiagnostic({ args: ["--read-only", "--source-sha", sourceSha] }, dependencies)).toBe(native);
    expect(dependencies.read).toHaveBeenCalledExactlyOnceWith(sourceSha);
    expect(dependencies.loadEnvironment.mock.invocationCallOrder[0]).toBeLessThan(dependencies.getDatabaseUrl.mock.invocationCallOrder[0]);
    expect(dependencies.getDatabaseUrl.mock.invocationCallOrder[0]).toBeLessThan(dependencies.read.mock.invocationCallOrder[0]);
  });

  it("keeps thrown environment/read details out of aggregate output", async () => {
    const dependencies = runnerDependencies();
    dependencies.loadEnvironment.mockRejectedValue(new Error(`${privateMarker} postgresql://private:credential`));
    const result = await runAcceptanceReasonsDiagnostic({ args: ["--read-only", "--source-sha", sourceSha] }, dependencies);
    expect(result).toEqual(unavailableAcceptanceReasons({ sourceSha, reason: "READ_FAILED" }));
    expect(dependencies.read).not.toHaveBeenCalled();
    expectPrivateEvidenceAbsent(result);
  });
});
