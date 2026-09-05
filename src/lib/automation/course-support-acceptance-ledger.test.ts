import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  buildCourseSupportAcceptanceLedger,
  loadCourseSupportAcceptanceLedger,
  parseAcceptanceLedgerArguments,
  runCourseSupportAcceptanceLedgerDiagnostic,
  type AcceptanceLedgerIncident,
} from "./course-support-acceptance-ledger";
import {
  createParkedCourseCampaignAudit,
  type ParkedCourseCampaignMemberObservation,
} from "./course-support-campaign";
import { AUTOMATION_PLAYBOOK_STAGES } from "./course-monitoring-playbook";

const loadObservations = vi.hoisted(() => vi.fn());
vi.mock("./course-support-campaign", async (importOriginal) => ({
  ...await importOriginal<typeof import("./course-support-campaign")>(),
  loadCampaignMemberObservations: loadObservations,
}));

const capturedAt = new Date("2026-08-20T12:00:00.000Z");
const confirmedAt = new Date("2026-08-20T12:01:00.000Z");
const evidenceAt = new Date("2026-08-20T12:05:00.000Z");
const observedAt = new Date("2026-09-05T12:00:00.000Z");
const runtime = "a".repeat(40);

function fixture() {
  const members = Array.from({ length: 112 }, (_, index) => ({
    courseId: `private-course-${String(index).padStart(3, "0")}`,
    incidentId: `private-incident-${index}`,
    cycle: 3, revision: 7, monitoringRevision: 11,
    monitoringFailureFingerprint: "SOURCE:MISSING",
    kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING",
    failureClass: "MISSING_SOURCE", failureFingerprint: "SOURCE:MISSING",
    providerSnapshotFingerprint: "a".repeat(64),
    attemptLedgerFingerprint: "b".repeat(64),
    playbookConclusion: "UNRESOLVED_EXHAUSTED",
    latestProbeAt: null, latestDiscoveryAt: null,
  }));
  const audit = createParkedCourseCampaignAudit({ expectedCount: 112, capturedAt, members });
  const observations: ParkedCourseCampaignMemberObservation[] = members.map((member) => ({
    courseId: member.courseId, incidentId: member.incidentId, cycle: 4,
    status: "NEEDS_HUMAN", activeBatchId: null, confirmedAt,
    resolution: null, resolvedAt: null, decisionAt: null,
    monitoringState: "ENGINEERING_VERIFICATION_NEEDED", monitoringStateChangedAt: evidenceAt,
    latestProbe: null, campaignTerminalEvidenceAt: null,
    campaignTerminalRuntimeVersion: null, campaignTerminalDeploymentSha: null,
    campaignTerminalOutcome: null, campaignTerminalFreshRuntimeProof: false,
    campaignTerminalAutomatedFinal: null, currentlyParked: false, humanReviewCycles: [],
  }));
  const incidents: AcceptanceLedgerIncident[] = members.map((member) => ({
    id: member.incidentId, courseId: member.courseId, cycle: 4,
    status: "NEEDS_HUMAN", activeBatchId: null, nextAttemptAt: null,
    nextReminderAt: null, decisionActorId: null, decisionAt: null,
    decisionNote: null, decisionEvidenceUrl: null, decisionIdempotencyKey: null,
    humanReviewReason: "AUTOMATION_STALLED", escalatedAt: evidenceAt,
    failureFingerprint: "SOURCE:MISSING", attemptLedger: ledger(8),
    monitoringEvents: [{
      incidentId: member.incidentId, eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: evidenceAt, failureFingerprint: "SOURCE:MISSING",
      audit: {
        cycle: 4, customerState: "NEEDS_HUMAN_REVIEW", automationStalled: true,
        parkedUntilMaterialChange: true, playbookExhausted: true,
        privateData: "https://private.example.test/sheet?secret=private-payload",
      },
    }],
    course: { monitoringStatus: {
      state: "ENGINEERING_VERIFICATION_NEEDED", nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
    } },
  }));
  return { audit, observedAt, observations, incidents };
}

function ledger(completed: number) {
  const readPaths = ["OFFICIAL_IDENTITY", "TYPED_PROVIDER_ADAPTER", "OFFICIAL_HTTP", "TYPED_PROVIDER_ADAPTER", "RENDERED_BROWSER", "TYPED_PROVIDER_ADAPTER", "LOCAL_READER", "INDEPENDENT_CONFIRMATION"];
  return {
    version: 1,
    events: AUTOMATION_PLAYBOOK_STAGES.slice(0, completed).map((stage, index) => ({
      sequence: index + 1, cycle: 4, stage, transition: "NOT_APPLICABLE",
      readPath: readPaths[index], evidenceKind: "TOOLING", observedAt: evidenceAt.toISOString(),
      failureFingerprint: "SOURCE:MISSING", runtimeVersion: runtime,
      skipReason: "NO_PROVIDER_METADATA",
    })),
  };
}

function resolve(input: ReturnType<typeof fixture>, index: number, changes: Partial<ParkedCourseCampaignMemberObservation> = {}) {
  Object.assign(input.observations[index], {
    status: "RESOLVED", resolution: "MONITORING_RESTORED", resolvedAt: evidenceAt,
    monitoringState: "HEALTHY", campaignTerminalEvidenceAt: evidenceAt,
    campaignTerminalRuntimeVersion: runtime, campaignTerminalDeploymentSha: runtime,
    campaignTerminalOutcome: "NO_MATCH", campaignTerminalFreshRuntimeProof: true,
    campaignTerminalAutomatedFinal: true, ...changes,
  });
  input.incidents[index].status = "RESOLVED";
}

describe("read-only course-support acceptance ledger", () => {
  it("partitions the immutable 112 without crediting parked or resolved-but-unproven work", () => {
    const input = fixture();
    resolve(input, 0);
    resolve(input, 1, { resolution: "DIRECT_BOOKING_CLASSIFIED", monitoringState: "FINAL_MANUAL", campaignTerminalOutcome: "MANUAL_DIRECT" });
    resolve(input, 2, { campaignTerminalDeploymentSha: "b".repeat(40) });
    input.incidents[3].attemptLedger = ledger(4);
    input.incidents[4].id = "replacement-private-incident";
    input.incidents[5].status = "AUTO_INVESTIGATING";
    input.observations[5].status = "AUTO_INVESTIGATING";
    input.incidents[6].attemptLedger = { invalid: true };
    input.incidents[7].course.monitoringStatus!.state = "FINAL_TECHNICAL";
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result).toMatchObject({ status: "AVAILABLE", totalCount: 112, partitionInvariant: "PASS", partitions: {
      freshMonitoredCount: 1, freshFactualLimitationCount: 1,
      resolvedMissingAcceptanceProofCount: 1, incompletePlaybookParkedCount: 1,
      missingOrReplacedOriginalIncidentCount: 1, activeOwnerOrInvestigatingCount: 1,
      unknownCount: 1, otherUnresolvedCount: 1, exhaustedUnchangedEngineeringCount: 104,
    }, proofGaps: { runtimeProofMissingOrMismatchedCount: 1, invalidOrWrongCyclePlaybookCount: 1 } });
    expect(result.pendingStageCounts).toEqual({ RENDERED_BROWSER_DISCOVERY: 1 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/private|https:|SOURCE:MISSING|replacement-private-incident/u);
    expect(serialized).not.toContain(runtime);
    expect(serialized).not.toContain(input.audit.membershipDigest);
  });

  it.each([
    { campaignTerminalFreshRuntimeProof: false },
    { campaignTerminalEvidenceAt: null },
    { confirmedAt: new Date("2026-08-19T12:00:00.000Z") },
    { campaignTerminalAutomatedFinal: null },
    { monitoringState: "ENGINEERING_VERIFICATION_NEEDED" },
    { activeBatchId: "private-owner" },
  ])("retains the existing strict terminal rejection for %j", (changes) => {
    const input = fixture();
    resolve(input, 0, changes);
    expect(buildCourseSupportAcceptanceLedger(input).partitions).toMatchObject({ freshMonitoredCount: 0, resolvedMissingAcceptanceProofCount: 1 });
  });

  it("keeps booking-not-open and source-unverified results separate from monitored and technical counts", () => {
    const input = fixture();
    resolve(input, 0, { latestProbe: { outcome: "NO_MATCH", observedAt: evidenceAt, runtimeVersion: runtime, rawSummary: { targetDateStatus: "NOT_OPEN" } } });
    resolve(input, 1, { resolution: "SOURCE_UNVERIFIED", monitoringState: "FINAL_TECHNICAL", campaignTerminalOutcome: "SOURCE_UNVERIFIED" });
    expect(buildCourseSupportAcceptanceLedger(input).partitions).toMatchObject({ freshBookingNotOpenCount: 1, freshSourceUnverifiedCount: 1, freshMonitoredCount: 0, freshTechnicalLimitationCount: 0 });
  });

  it("exposes missing exhaustion flags without inventing a limitation or a runnable stage", () => {
    const input = fixture();
    input.incidents[0].attemptLedger = ledger(3);
    delete (input.incidents[0].monitoringEvents[0].audit as Record<string, unknown>).playbookExhausted;
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.proofGaps).toMatchObject({ parkingExhaustionFlagMissingCount: 1, parkingExhaustionFlagMissingIncompleteCount: 1, parkingExhaustionFlagMissingExhaustedCount: 0, parkingExhaustionFlagMissingOtherConclusionCount: 0, parkingEvidenceMissingCount: 0 });
    expect(result.partitions).toMatchObject({ incompletePlaybookParkedCount: 1, freshTechnicalLimitationCount: 0 });
  });

  it("distinguishes missing exhaustion metadata for exhausted playbooks from incomplete playbooks", () => {
    const input = fixture();
    delete (input.incidents[0].monitoringEvents[0].audit as Record<string, unknown>).playbookExhausted;
    input.incidents[1].attemptLedger = ledger(4);
    delete (input.incidents[1].monitoringEvents[0].audit as Record<string, unknown>).playbookExhausted;
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.proofGaps).toMatchObject({ parkingExhaustionFlagMissingCount: 2, parkingExhaustionFlagMissingIncompleteCount: 1, parkingExhaustionFlagMissingExhaustedCount: 1, parkingExhaustionFlagMissingOtherConclusionCount: 0 });
    expect(result.partitions).toMatchObject({ incompletePlaybookParkedCount: 1, exhaustedUnchangedEngineeringCount: 111 });
  });

  it("classifies human-review playbooks despite future reminder and retry timestamps", () => {
    const input = fixture();
    const future = new Date("2026-09-05T18:00:00.000Z");
    input.incidents[0].attemptLedger = ledger(4);
    input.incidents[0].nextReminderAt = future;
    input.incidents[0].nextAttemptAt = future;
    input.incidents[0].course.monitoringStatus!.nextAutomaticAttemptAt = future;
    input.incidents[1].nextReminderAt = future;
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.partitions).toMatchObject({ incompletePlaybookParkedCount: 1, exhaustedUnchangedEngineeringCount: 111, activeOwnerOrInvestigatingCount: 0 });
    expect(result.schedulingMetadataByStatus?.NEEDS_HUMAN).toMatchObject({
      incidentCount: 112, activeOwnerCount: 0, noExplicitDecisionCount: 112,
      nextAttemptAt: { nullCount: 111, pastOrPresentCount: 0, futureCount: 1, unknownCount: 0 },
      nextReminderAt: { nullCount: 110, pastOrPresentCount: 0, futureCount: 2, unknownCount: 0 },
      nextAutomaticAttemptAt: { nullCount: 111, pastOrPresentCount: 0, futureCount: 1, unknownCount: 0 },
    });
    expect(result.automaticAdmissionAssessed).toBe(false);
  });

  it("separates stale revalidation and explicit human decisions from automatic eligibility", () => {
    const input = fixture();
    input.incidents[0].attemptLedger = ledger(4);
    input.incidents[0].decisionAt = evidenceAt;
    input.incidents[0].decisionActorId = "private-operator";
    input.incidents[0].course.monitoringStatus!.revalidationRequestedAt = evidenceAt;
    input.incidents[1].course.monitoringStatus!.revalidationRequestedAt = observedAt;
    input.incidents[2].decisionAt = evidenceAt;
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.partitions).toMatchObject({ incompletePlaybookParkedCount: 1, exhaustedUnchangedEngineeringCount: 111, activeOwnerOrInvestigatingCount: 0 });
    expect(result.schedulingMetadataByStatus?.NEEDS_HUMAN).toMatchObject({
      explicitDecisionPresentCount: 2, partialDecisionMetadataCount: 1, noExplicitDecisionCount: 110,
      revalidationRequestedAt: { nullCount: 110, pastOrPresentCount: 2, futureCount: 0, unknownCount: 0 },
    });
    expect(result.automaticAdmissionAssessed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-operator");
  });

  it("keeps persisted owners and investigation status separate from missing schedule metadata", () => {
    const input = fixture();
    input.incidents[0].activeBatchId = "private-owner";
    input.observations[0].activeBatchId = "private-owner";
    input.incidents[1].status = "AUTO_INVESTIGATING";
    input.observations[1].status = "AUTO_INVESTIGATING";
    input.incidents[1].nextAttemptAt = evidenceAt;
    input.incidents[1].course.monitoringStatus = null;
    resolve(input, 2);
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.partitions).toMatchObject({ activeOwnerOrInvestigatingCount: 2, freshMonitoredCount: 1, exhaustedUnchangedEngineeringCount: 109 });
    expect(result.schedulingMetadataByStatus).toMatchObject({
      NEEDS_HUMAN: { incidentCount: 110, activeOwnerCount: 1 },
      RESOLVED: { incidentCount: 1, activeOwnerCount: 0 },
      AUTO_INVESTIGATING: {
        incidentCount: 1, activeOwnerCount: 0,
        nextAttemptAt: { nullCount: 0, pastOrPresentCount: 1, futureCount: 0, unknownCount: 0 },
        nextAutomaticAttemptAt: { nullCount: 0, pastOrPresentCount: 0, futureCount: 0, unknownCount: 1 },
      },
    });
  });

  it.each(["decisionNote", "decisionEvidenceUrl", "decisionIdempotencyKey"] as const)(
    "counts isolated %s metadata as a decision fence without reporting its private value or eligibility",
    (field) => {
      const input = fixture();
      input.incidents[0].attemptLedger = ledger(4);
      input.incidents[0][field] = "private-decision-value";
      const result = buildCourseSupportAcceptanceLedger(input);
      expect(result.schedulingMetadataByStatus?.NEEDS_HUMAN).toMatchObject({
        explicitDecisionPresentCount: 1, partialDecisionMetadataCount: 1, noExplicitDecisionCount: 111,
      });
      expect(result.partitions).toMatchObject({ incompletePlaybookParkedCount: 1, exhaustedUnchangedEngineeringCount: 111 });
      expect(result.automaticAdmissionAssessed).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private-decision-value");
    },
  );

  it("does not call exhaustion intentional without matching durable parking evidence", () => {
    const input = fixture();
    input.incidents[0].monitoringEvents[0].failureFingerprint = "OTHER:SOURCE";
    const result = buildCourseSupportAcceptanceLedger(input);
    expect(result.partitions).toMatchObject({ exhaustedUnchangedEngineeringCount: 111, otherUnresolvedCount: 1 });
    expect(result.proofGaps).toMatchObject({ parkingEvidenceMissingCount: 1 });
  });

  it("keeps absent incidents and duplicate observations distinct from valid zeroes", () => {
    const input = fixture();
    input.incidents.shift();
    input.observations.push(input.observations[1]);
    expect(buildCourseSupportAcceptanceLedger(input).partitions).toMatchObject({ missingOrReplacedOriginalIncidentCount: 1, unknownCount: 1 });
  });

  it("returns null aggregates for a modified membership rather than reporting a smaller successful cohort", () => {
    const input = fixture();
    input.audit.members.pop();
    expect(buildCourseSupportAcceptanceLedger(input)).toMatchObject({ status: "UNKNOWN", reason: "INVALID_CAMPAIGN", totalCount: null, partitions: null, proofGaps: null });
  });

  it("enforces read-only before the first database read and reuses the observation loader in that snapshot", async () => {
    const input = fixture();
    const calls: string[] = [];
    const transaction = {
      $executeRaw: vi.fn(async (sql: TemplateStringsArray) => { calls.push(sql.join("")); return 0; }),
      automationRun: { findFirst: vi.fn(async () => { calls.push("read campaign"); return { id: "private-campaign", audit: input.audit }; }) },
      courseSupportIncident: { findMany: vi.fn(async () => input.incidents) },
    };
    loadObservations.mockResolvedValueOnce(input.observations);
    const database = { $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(transaction)) };
    const result = await loadCourseSupportAcceptanceLedger(database as unknown as Pick<PrismaClient, "$transaction">, observedAt);
    expect(calls).toEqual(["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '25000ms'", "read campaign"]);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 30000 });
    expect(loadObservations).toHaveBeenCalledWith(input.audit, new Set(), "private-campaign", transaction);
    expect(transaction.courseSupportIncident.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ decisionActorId: true, decisionAt: true, decisionNote: true, decisionEvidenceUrl: true, decisionIdempotencyKey: true }),
    }));
    expect(result).toMatchObject({ status: "AVAILABLE", partitions: { exhaustedUnchangedEngineeringCount: 112 } });
  });

  it("does not read after a read-only guard failure and never exposes a database error", async () => {
    const read = vi.fn();
    const transaction = { $executeRaw: vi.fn(async () => { throw new Error("private database https://private.example.test/?token=secret"); }), automationRun: { findFirst: read } };
    const database = { $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(transaction)) };
    const result = await loadCourseSupportAcceptanceLedger(database as unknown as Pick<PrismaClient, "$transaction">, observedAt);
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "UNKNOWN", reason: "READ_FAILED", totalCount: null, partitions: null });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|https:/u);
  });

  it("accepts only the explicit machine read and rejects all mutation or selector arguments", () => {
    expect(parseAcceptanceLedgerArguments(["--machine"])).toBe(true);
    for (const args of [[], ["--apply"], ["--machine", "--apply"], ["--machine", "--course-id", "private"], ["--machine", "--machine"]]) {
      expect(parseAcceptanceLedgerArguments(args)).toBe(false);
    }
  });

  it("rejects unsafe arguments before environment or database work", async () => {
    const dependencies = { loadEnvironment: vi.fn(), getDatabaseUrl: vi.fn(), read: vi.fn() };
    const result = await runCourseSupportAcceptanceLedgerDiagnostic({ args: ["--machine", "--apply"], observedAt }, dependencies);
    expect(result.reason).toBe("INVALID_ARGUMENTS");
    expect(dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(dependencies.getDatabaseUrl).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("rejects missing database configuration without opening a localhost fallback: %j", async (value) => {
    const dependencies = { loadEnvironment: vi.fn(async () => undefined), getDatabaseUrl: () => value, read: vi.fn() };
    const result = await runCourseSupportAcceptanceLedgerDiagnostic({ args: ["--machine"], observedAt }, dependencies);
    expect(result).toMatchObject({ status: "UNKNOWN", reason: "DATABASE_UNAVAILABLE", partitions: null });
    expect(dependencies.read).not.toHaveBeenCalled();
  });
});
