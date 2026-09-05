import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: database }));

import { parkCourseSupportCandidatesForMaterialChange } from "./course-support-batches";
import {
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  loadParkedCourseCampaignAdmissionMembers,
} from "./course-support-campaign";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import type { CourseSupportCandidate } from "./course-support-selection";

const capturedAt = new Date("2026-08-20T12:00:00.000Z");
const admittedAt = new Date("2026-08-20T12:05:00.000Z");
const updatedAt = new Date("2026-08-20T12:25:00.000Z");
const parkedAt = new Date("2026-08-20T12:30:00.000Z");
const stages = [
  ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
  ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
  ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
  ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
  ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ["LOCAL_READER", "LOCAL_READER"],
  ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION"],
] as const;

function ledger(completed: number) {
  return { version: 1, events: stages.slice(0, completed).map(([stage, readPath], index) => ({
    sequence: index + 1, cycle: 4, stage, readPath, transition: "NOT_APPLICABLE",
    evidenceKind: "TOOLING", observedAt: new Date(admittedAt.getTime() + (index + 1) * 1000).toISOString(),
    failureFingerprint: "SOURCE:MISSING", runtimeVersion: "release-old", skipReason: "NO_PROVIDER_METADATA",
  })) };
}

function fixture(attemptLedger: unknown = ledger(4)) {
  const incident = {
    id: "incident-fixture", courseId: "course-fixture", cycle: 4, revision: 9,
    status: "AUTO_INVESTIGATING", activeBatchId: null, resolution: null, resolvedAt: null,
    lastSeenAt: updatedAt, updatedAt, failureFingerprint: "SOURCE:MISSING", engineeringOnly: true,
    activeRealSearchCount: 0, earliestTargetDate: null, escalatedAt: null, attemptLedger,
  };
  const monitoringStatus = {
    state: "AUTO_INVESTIGATING", stateChangedAt: admittedAt, lastSuccessfulAt: null, revision: 13,
  };
  const transaction = {
    $queryRawUnsafe: vi.fn(async () => []),
    courseSupportIncident: {
      findUnique: vi.fn(async () => incident),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    courseMonitoringStatus: {
      findUnique: vi.fn(async () => monitoringStatus),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    courseMonitoringEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "event-fixture", ...data })),
      createMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(),
    },
  };
  database.$transaction.mockImplementation(async (worker) => worker(transaction));
  const candidate = {
    ...incident, kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING", failureClass: "MISSING_SOURCE",
    remediationRoute: {
      workMode: "WAIT_FOR_MATERIAL_CHANGE", resumeWorkMode: "ADVANCE_DISCOVERY", allowUnchangedRuntime: false,
      requiresImplementationPath: false, retryBudget: null, reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
    },
  } as unknown as CourseSupportCandidate;
  return { incident, monitoringStatus, transaction, candidate };
}

describe("course-support parking evidence producer", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["incomplete", ledger(4), "AVAILABLE", "INCOMPLETE", false, "RENDERED_BROWSER_DISCOVERY"],
    ["exhausted", ledger(8), "AVAILABLE", "UNRESOLVED_EXHAUSTED", true, null],
    ["invalid", { invalid: true }, "UNAVAILABLE", null, null, null],
  ] as const)("emits canonical %s evidence from the locked incident ledger", async (_name, attemptLedger, status, conclusion, exhausted, nextStage) => {
    const input = fixture(attemptLedger);
    await expect(parkCourseSupportCandidatesForMaterialChange([input.candidate], parkedAt)).resolves.toBe(1);
    expect(input.transaction.courseSupportIncident.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ attemptLedger: true }) }));
    expect(input.transaction.$queryRawUnsafe).toHaveBeenCalledBefore(input.transaction.courseSupportIncident.findUnique);
    expect(input.transaction.courseMonitoringEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      source: "COURSE_SUPPORT_RESPONDER", eventType: "HUMAN_REVIEW_REQUESTED", occurredAt: parkedAt,
      audit: expect.objectContaining({
        cycle: 4, automationStalled: true, parkedUntilMaterialChange: true,
        reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED", resumeWorkMode: "ADVANCE_DISCOVERY",
        playbookAssessmentStatus: status, playbookConclusion: conclusion, playbookExhausted: exhausted, nextStage,
      }),
    }) });
    expect(input.transaction.courseSupportIncident.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ cycle: 4, revision: 9, status: "AUTO_INVESTIGATING", activeBatchId: null, updatedAt }),
      data: expect.objectContaining({ status: "NEEDS_HUMAN", nextAttemptAt: null, nextReminderAt: parkedAt }),
    }));
  });

  it("leaves already parked historical rows untouched", async () => {
    const input = fixture();
    input.incident.status = "NEEDS_HUMAN";
    await expect(parkCourseSupportCandidatesForMaterialChange([input.candidate], parkedAt)).resolves.toBe(0);
    expect(input.transaction.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(input.transaction.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(input.transaction.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("feeds its actual incomplete parking event through the unchanged campaign recovery predicates", async () => {
    const input = fixture();
    await parkCourseSupportCandidatesForMaterialChange([input.candidate], parkedAt);
    const producedEvent = input.transaction.courseMonitoringEvent.create.mock.calls[0]![0].data;
    const course = {
      timeZone: "America/New_York", isPublic: true, website: null, detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const, providerFamilyKey: "SOURCE_MISSING", bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, bookingWindowSource: null,
      bookingWindowConfidence: null, bookingWindowEvidenceUrl: null, automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const, monitoringMode: "STANDARD" as const, bookingAccessMode: "UNKNOWN",
      intelligenceVerifiedAt: null, intelligenceReviewAt: null, intelligenceConfidence: null, bookingMetadata: null,
      layoutHoleCounts: [], layoutHolesVerifiedAt: null,
    };
    const audit = createParkedCourseCampaignAudit({ expectedCount: 1, capturedAt, members: [{
      courseId: input.incident.courseId, incidentId: input.incident.id, cycle: 3, revision: 7, monitoringRevision: 11,
      monitoringFailureFingerprint: "SOURCE:MISSING", kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE", failureFingerprint: "SOURCE:MISSING",
      providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course),
      attemptLedgerFingerprint: createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE", latestProbeAt: null, latestDiscoveryAt: null,
    }] });
    const request = {
      id: "request-fixture", releaseSha: "release-old", status: "SUCCEEDED", revision: 3, attemptCount: 1,
      workflowRunId: "workflow-fixture", startedAt: new Date("2026-08-20T12:20:00.000Z"),
      outcome: "FETCH_FAILED", failureClass: "MISSING_METADATA", evidence: { providerExecution: true }, lastError: "missing metadata",
    };
    const row = {
      ...input.incident, status: "NEEDS_HUMAN", nextAttemptAt: null, humanReviewReason: "AUTOMATION_STALLED",
      kind: "NEEDS_ADAPTER", providerFamilyKey: "SOURCE_MISSING", failureClass: "MISSING_SOURCE",
      escalatedAt: parkedAt, resolutionMessage: null, resolutionNotifiedAt: null,
      decisionActorId: null, decisionAt: null, decisionNote: null, decisionEvidenceUrl: null, decisionIdempotencyKey: null,
      monitoringEvents: [producedEvent, {
        incidentId: input.incident.id, eventType: "REVALIDATION_REQUESTED", source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING", occurredAt: admittedAt,
        audit: { action: "parked_cohort_admission", campaignRunId: "campaign-fixture",
          campaignMembershipDigest: audit.membershipDigest, priorCycle: 3, cycle: 4 },
      }],
      batchIncidents: [{
        id: "entry-fixture", cycle: 4, result: "NEEDS_HUMAN",
        batch: { baseSha: "release-old", releaseSha: "release-old", completedAt: updatedAt, summary: { closeout: { providerExecutionStarted: true } } },
        verificationRequests: [request],
      }],
      course: { ...course, preferences: [], probes: [], automationDiscoveries: [], monitoringStatus: {
        state: "ENGINEERING_VERIFICATION_NEEDED", revision: 14, failureFingerprint: "SOURCE:MISSING",
        nextAutomaticAttemptAt: null, revalidationRequestedAt: null,
      } },
    };
    const load = () => loadParkedCourseCampaignAdmissionMembers(audit, {
      courseSupportIncident: { findMany: vi.fn(async () => [row]) },
    } as never, "campaign-fixture", "release-current");
    expect(await load()).toMatchObject([{ admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY", playbookCompletedStageCount: 4 }]);
    const eventAudit = producedEvent.audit as Record<string, unknown>;
    delete eventAudit.playbookExhausted;
    expect(await load()).toEqual([]);
    eventAudit.playbookExhausted = true;
    expect(await load()).toEqual([]);
    eventAudit.playbookExhausted = false;
    request.status = "CHECKING";
    expect(await load()).toEqual([]);
    request.status = "SUCCEEDED";
    Object.assign(row, { decisionNote: "operator decision must remain fenced" });
    expect(await load()).toEqual([]);
  });
});
