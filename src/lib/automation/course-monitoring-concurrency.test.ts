import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  courseMonitoringEvent: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  courseSupportVerificationRequest: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  courseSupportBatch: {
    updateMany: vi.fn(),
  },
  courseSupportBatchIncident: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  course: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  courseProbe: {
    findFirst: vi.fn(),
  },
  courseAutomationDiscovery: {
    findFirst: vi.fn(),
  },
  automationRun: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  teeSearch: {
    updateMany: vi.fn(),
  },
}));

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {},
  courseMonitoringStatus: {},
  courseSupportIncident: {
    findMany: vi.fn(),
  },
  automationRun: {
    upsert: vi.fn(),
  },
  teeSearch: {},
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  getMaterialProviderEvidenceChanges,
  recordCourseMonitoringFailure,
  recordCourseMonitoringFinalClassification,
  recordCourseMonitoringPlaybookTransition,
  recordCourseMonitoringSuccess,
  reconcileCourseMonitoringDeadline,
  reopenParkedCourseForResponderCampaign,
  reopenParkedCourseForResponderCampaignInTransaction,
  revalidateCourseMonitoringForProviderEvidenceChange,
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction,
  revalidateHumanReviewCoursesForDeployment,
} from "./course-monitoring";
import { parkCourseSupportCandidatesForMaterialChange } from "./course-support-batches";
import {
  assessParkedCourseCampaignDescendantIncompletePlaybookRecovery,
  assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery,
  assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery,
  assessParkedCourseCampaignSameCycleRecoveryHistory,
  assessParkedCourseCampaignRequestlessStaleOwnershipRecovery,
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  loadParkedCourseCampaignAdmissionMembers,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
} from "./course-support-campaign";
import { persistCourseSupportSearchExecutionFence } from "./course-support-search-execution-fence";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { COURSE_SUPPORT_RESPONDER_PROMPT_VERSION } from "./course-support-responder-policy";
import { assessCourseSupportZeroExecutionHistory } from "./course-support-zero-execution";
import type { CourseSupportCandidate } from "./course-support-selection";
import { buildProviderFailureFingerprint } from "./provider-capabilities";

describe("course monitoring write serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMocks.$queryRaw.mockImplementation(
      async (query: { strings?: readonly string[]; values?: unknown[] }) => {
        const sql = query.strings?.join("") ?? "";
        const [id, courseId, timestamp] = query.values ?? [];
        if (sql.includes('FROM "CourseProbe"')) {
          return [{ id, courseId, observedAt: timestamp }];
        }
        if (sql.includes('FROM "CourseAutomationDiscovery"')) {
          return [{ id, courseId, createdAt: timestamp }];
        }
        if (
          sql.includes("FOR UPDATE") &&
          [
            'FROM "CourseSupportBatch"',
            'FROM "AutomationRun"',
            'FROM "CourseSupportBatchIncident"',
            'FROM "CourseSupportVerificationRequest"',
          ].some((table) => sql.includes(table))
        ) {
          return [...new Set(query.values ?? [])]
            .filter((value): value is string => typeof value === "string")
            .sort((left, right) => left.localeCompare(right))
            .map((rowId) => ({ id: rowId }));
        }
        return [];
      },
    );
    prismaMocks.$transaction
      .mockRejectedValueOnce(
        Object.assign(new Error("Transaction failed due to a write conflict"), {
          code: "P2034",
        }),
      )
      .mockImplementation(async (worker) => worker(transactionMocks));
    transactionMocks.$queryRawUnsafe.mockResolvedValue([]);
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 7,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.create.mockResolvedValue({
      courseId: "course-1",
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8,
    });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1",
    });
    transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
      null,
    );
    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValue(
      {
        count: 1,
      },
    );
    transactionMocks.courseSupportBatch.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValue(
      null,
    );
    transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValue([]);
    transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMocks.course.findUnique.mockResolvedValue(null);
    transactionMocks.course.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.courseProbe.findFirst.mockResolvedValue(null);
    transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
      null,
    );
    transactionMocks.automationRun.findFirst.mockResolvedValue(null);
    transactionMocks.automationRun.findMany.mockResolvedValue([]);
    transactionMocks.automationRun.findUnique.mockResolvedValue(null);
    transactionMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
  });

  it("admits revision-only parked campaign churn without erasing durable history", async () => {
    prismaMocks.$transaction.mockReset();
    const admittedAt = new Date("2026-08-20T12:00:00.000Z");
    const escalatedAt = new Date("2026-08-19T12:00:00.000Z");
    const latestProbeAt = new Date("2026-08-19T13:00:00.000Z");
    const latestDiscoveryAt = new Date("2026-08-19T14:00:00.000Z");
    const providerCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 3,
      revision: 7,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: escalatedAt,
          audit: {
            cycle: 3,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
          },
        },
      ],
      course: {
        ...providerCourse,
        probes: [{ observedAt: latestProbeAt }],
        automationDiscoveries: [{ createdAt: latestDiscoveryAt }],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 11,
          failureFingerprint: "SOURCE:LEGACY",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    });

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          expectedCycle: 3,
          expectedRevision: 7,
          expectedMonitoringRevision: 11,
          capturedRevision: 5,
          capturedMonitoringRevision: 9,
          expectedKind: "NEEDS_ADAPTER",
          expectedFailureClass: "MISSING_SOURCE",
          expectedLatestProbeAt: latestProbeAt.toISOString(),
          expectedLatestDiscoveryAt: latestDiscoveryAt.toISOString(),
          expectedProviderFamilyKey: "SOURCE_MISSING",
          expectedFailureFingerprint: "SOURCE:MISSING",
          expectedMonitoringFailureFingerprint: "SOURCE:LEGACY",
          expectedProviderSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(providerCourse),
          expectedAttemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          expectedPlaybookConclusion: "INCOMPLETE",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: "a".repeat(64),
          now: admittedAt,
        },
      ),
    ).resolves.toEqual({
      admitted: true,
      incidentId: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
    });

    const incidentUpdate =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(incidentUpdate.where).toMatchObject({
      id: "incident-campaign",
      cycle: 3,
      revision: 7,
    });
    expect(incidentUpdate.data).toMatchObject({
      cycle: { increment: 1 },
      status: "AUTO_INVESTIGATING",
      attemptCount: 0,
      confirmedAt: admittedAt,
      nextAttemptAt: admittedAt,
    });
    expect(incidentUpdate.data).not.toHaveProperty("firstSeenAt");
    expect(incidentUpdate.data).not.toHaveProperty("occurrenceCount");
    expect(incidentUpdate.data).not.toHaveProperty("decisionAt");
    expect(incidentUpdate.data).not.toHaveProperty("decisionActorId");
    expect(incidentUpdate.data).not.toHaveProperty("decisionNote");
    expect(incidentUpdate.data).not.toHaveProperty("decisionEvidenceUrl");
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revision: 11,
          failureFingerprint: "SOURCE:LEGACY",
        }),
        data: expect.objectContaining({
          failureFingerprint: "SOURCE:MISSING",
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            action: "parked_cohort_admission",
            campaignRunId: "campaign-run-1",
            cycle: 4,
            capturedIncidentRevision: 5,
            capturedMonitoringRevision: 9,
            admittedIncidentRevision: 7,
            admittedMonitoringRevision: 11,
            activeDemandAtAdmission: false,
          }),
        }),
      }),
    );
  });

  it("recovers a campaign member once in the admitted cycle when provider execution never began", async () => {
    prismaMocks.$transaction.mockReset();
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:00:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const oldRuntime = "a".repeat(40);
    const currentRuntime = "b".repeat(40);
    const membershipDigest = "c".repeat(64);
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const providerCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const historyEntry = {
      id: "batch-entry-1",
      cycle: 4,
      result: "RETRY_SCHEDULED",
      batch: {
        baseSha: oldRuntime,
        releaseSha: oldRuntime,
        completedAt: parkedAt,
        summary: {
          campaign: {
            kind: "PARKED_COHORT",
            attempts: [
              {
                courseRef,
                runId: "campaign-run-1",
                membershipDigest,
                cycle: 4,
              },
            ],
          },
          closeout: {
            remediationAttempts: [
              {
                courseRef,
                runtimeVersion: oldRuntime,
                consumed: false,
                executionEvidence: {
                  deploymentRecorded: false,
                  providerAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                },
                operationalRetry: {
                  attemptsCompleted: 1,
                  exhausted: false,
                  reason: "OPERATIONAL_RETRY_AVAILABLE",
                },
              },
            ],
          },
        },
      },
      verificationRequests: [
        {
          id: "request-1",
          releaseSha: oldRuntime,
          status: "STALE",
          revision: 2,
          attemptCount: 0,
          workflowRunId: null,
          startedAt: null,
          outcome: null,
          failureClass: null,
          evidence: null,
        },
      ],
    };
    const requestlessHistoryEntry = {
      id: "batch-entry-2",
      cycle: 4,
      result: "NEEDS_HUMAN",
      batch: {
        baseSha: oldRuntime,
        releaseSha: oldRuntime,
        completedAt: new Date("2026-08-20T12:25:00.000Z"),
        summary: {
          closeout: {
            remediationAttempts: [
              {
                courseRef,
                runtimeVersion: oldRuntime,
                consumed: false,
                executionEvidence: {
                  deploymentRecorded: false,
                  providerAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                },
                operationalRetry: {
                  attemptsCompleted: 2,
                  exhausted: true,
                  reason: "OPERATIONAL_RETRY_BUDGET_EXHAUSTED",
                },
              },
            ],
          },
        },
      },
      verificationRequests: [],
    };
    const history = assessCourseSupportZeroExecutionHistory({
      courseId: "course-1",
      cycle: 4,
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      currentRuntimeVersion: currentRuntime,
      entries: [historyEntry, requestlessHistoryEntry],
    });
    expect(history).not.toBeNull();
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      revision: 9,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          source: "RECOVERY_CRON",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: parkedAt,
          audit: {
            cycle: 4,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
            playbookExhausted: false,
            campaign: {
              runId: "campaign-run-1",
              membershipDigest,
              cycle: 4,
            },
          },
        },
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: admittedAt,
          audit: {
            action: "parked_cohort_admission",
            campaignRunId: "campaign-run-1",
            campaignMembershipDigest: membershipDigest,
            priorCycle: 3,
            cycle: 4,
          },
        },
      ],
      batchIncidents: [historyEntry, requestlessHistoryEntry],
      course: {
        ...providerCourse,
        probes: [],
        automationDiscoveries: [],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 13,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 4,
      expectedRevision: 9,
      expectedMonitoringRevision: 13,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      admissionMode: "ZERO_EXECUTION_RECOVERY" as const,
      expectedZeroExecutionHistoryDigest: history!.historyDigest,
      currentRuntimeVersion: currentRuntime,
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: null,
      expectedLatestDiscoveryAt: null,
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint:
        buildCourseSupportProviderSnapshotFingerprint(providerCourse),
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      now: recoveredAt,
    };

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({
      admitted: true,
      incidentId: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
    });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.where).toMatchObject({ cycle: 4, revision: 9 });
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      attemptCount: 0,
      nextAttemptAt: recoveredAt,
    });
    expect(update.data).not.toHaveProperty("cycle");
    expect(update.data).not.toHaveProperty("confirmedAt");
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          batchIncidentId: "batch-entry-1",
          startedAt: null,
        }),
      }),
    );
    expect(
      transactionMocks.courseSupportVerificationRequest.findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          batchIncidentId: "batch-entry-2",
          releaseSha: oldRuntime,
        },
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            action: "parked_cohort_zero_execution_recovery",
            cycle: 4,
            sameCycleRecovery: true,
            oneShot: true,
            zeroExecutionHistoryDigest: history!.historyDigest,
          }),
        }),
      }),
    );
    transactionMocks.courseSupportIncident.updateMany.mockClear();
    transactionMocks.courseMonitoringEvent.create.mockClear();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...baseIncident,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: recoveredAt,
          audit: {
            action: "parked_cohort_zero_execution_recovery",
            campaignRunId: "campaign-run-1",
            cycle: 4,
          },
        },
        ...baseIncident.monitoringEvents,
      ],
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      {
        count: 0,
      },
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      {
        count: 1,
      },
    );
    transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
      {
        id: "late-request",
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("resumes a partially completed campaign playbook in the same cycle with exact evidence fences", async () => {
    prismaMocks.$transaction.mockReset();
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const stages = [
      ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
      ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
      ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
      ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ] as const;
    const attemptLedger = {
      version: 1,
      events: stages.map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle: 4,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(
          admittedAt.getTime() + index * 1_000,
        ).toISOString(),
        failureFingerprint: "SOURCE:MISSING",
        runtimeVersion: "release-old",
        skipReason: "NO_PROVIDER_METADATA",
      })),
    };
    const providerCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const batchIncidents = [
      {
        id: "batch-entry-partial",
        cycle: 4,
        result: "NEEDS_HUMAN",
        batch: {
          baseSha: "release-old",
          releaseSha: "release-old",
          completedAt: new Date("2026-08-20T12:25:00.000Z"),
          summary: { closeout: { providerExecutionStarted: true } },
        },
        verificationRequests: [
          {
            id: "request-partial",
            releaseSha: "release-old",
            status: "SUCCEEDED" as const,
            revision: 3,
            attemptCount: 1,
            workflowRunId: "workflow-partial",
            startedAt: new Date("2026-08-20T12:20:00.000Z"),
            outcome: "FETCH_FAILED" as const,
            failureClass: "MISSING_METADATA" as const,
            evidence: { providerExecution: true },
            lastError: "missing metadata",
          },
        ],
      },
    ];
    const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 4,
      entries: batchIncidents,
      requireOrchestrationOnly: false,
    });
    expect(history).not.toBeNull();
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      revision: 9,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          source: "RECOVERY_CRON",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: parkedAt,
          audit: {
            cycle: 4,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
            playbookExhausted: false,
            endpointStalled: true,
          },
        },
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: admittedAt,
          audit: {
            action: "parked_cohort_admission",
            campaignRunId: "campaign-run-1",
            campaignMembershipDigest: "a".repeat(64),
            priorCycle: 3,
            cycle: 4,
          },
        },
      ],
      batchIncidents,
      course: {
        ...providerCourse,
        probes: [],
        automationDiscoveries: [],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 13,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 4,
      expectedRevision: 9,
      expectedMonitoringRevision: 13,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY" as const,
      expectedSameCycleRecoveryHistoryDigest: history!.historyDigest,
      expectedPlaybookNextStage: "RENDERED_BROWSER_DISCOVERY",
      expectedPlaybookCompletedStageCount: 4,
      currentRuntimeVersion: "release-current",
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: null,
      expectedLatestDiscoveryAt: null,
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint:
        buildCourseSupportProviderSnapshotFingerprint(providerCourse),
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: "a".repeat(64),
      now: recoveredAt,
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 4 });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    for (const preserved of [
      "cycle",
      "attemptLedger",
      "attemptCount",
      "confirmedAt",
      "lastAttemptAt",
    ]) {
      expect(update.data).not.toHaveProperty(preserved);
    }
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-partial",
          workflowRunId: "workflow-partial",
          startedAt: new Date("2026-08-20T12:20:00.000Z"),
          evidence: { equals: { providerExecution: true } },
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            action: "parked_cohort_incomplete_playbook_recovery",
            admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
            sameCycleRecovery: true,
            oneShot: true,
            sameCycleRecoveryHistoryDigest: history!.historyDigest,
          }),
        }),
      }),
    );

    const changedIncidents = [
      { ...baseIncident, revision: 10 },
      {
        ...baseIncident,
        course: {
          ...baseIncident.course,
          website: "https://changed.example",
        },
      },
      {
        ...baseIncident,
        failureFingerprint: "SOURCE:CHANGED",
      },
      { ...baseIncident, attemptLedger: { version: 1, events: [] } },
      {
        ...baseIncident,
        monitoringEvents: [
          {
            incidentId: "incident-campaign",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            occurredAt: recoveredAt,
            audit: {
              action: "parked_cohort_incomplete_playbook_recovery",
              campaignRunId: "campaign-run-1",
              cycle: 4,
            },
          },
          ...baseIncident.monitoringEvents,
        ],
      },
    ];
    transactionMocks.courseSupportIncident.updateMany.mockClear();
    for (const changed of changedIncidents) {
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(
        changed,
      );
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
    }

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    batchIncidents[0]!.verificationRequests[0]!.evidence = null;
    const nullEvidenceHistory =
      assessParkedCourseCampaignSameCycleRecoveryHistory({
        courseId: "course-1",
        cycle: 4,
        entries: batchIncidents,
        requireOrchestrationOnly: false,
      });
    expect(nullEvidenceHistory).not.toBeNull();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      { count: 1 },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        {
          ...input,
          expectedSameCycleRecoveryHistoryDigest:
            nullEvidenceHistory!.historyDigest,
        },
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 4 });
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-partial",
          // Prisma returns both database NULL and JSON null as JavaScript
          // null, so the semantic null fence must admit either representation.
          evidence: { equals: Prisma.AnyNull },
        }),
      }),
    );

    transactionMocks.courseSupportIncident.updateMany.mockClear();
    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      { count: 0 },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        {
          ...input,
          expectedSameCycleRecoveryHistoryDigest:
            nullEvidenceHistory!.historyDigest,
        },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    batchIncidents[0]!.verificationRequests[0]!.evidence = {
      providerExecution: true,
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      {
        count: 0,
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("atomically resumes the exact started-request campaign handoff descendant without resetting progress", async () => {
    prismaMocks.$transaction.mockReset();
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const handoffAt = new Date("2026-08-20T12:15:00.000Z");
    const startedAt = new Date("2026-08-20T12:20:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const latestProbe = {
      id: "probe-descendant-planned",
      courseId: "course-1",
      observedAt: new Date("2026-08-20T12:26:00.000Z"),
    };
    const latestDiscovery = {
      id: "discovery-descendant-planned",
      courseId: "course-1",
      createdAt: new Date("2026-08-20T12:27:00.000Z"),
    };
    const stages = [
      ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
      ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
      ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
      ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
      ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ] as const;
    const attemptLedger = {
      version: 1,
      events: stages.map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle: 5,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(
          admittedAt.getTime() + index * 1_000,
        ).toISOString(),
        failureFingerprint: "METADATA:MISSING",
        runtimeVersion: "release-old",
        skipReason: "NO_PROVIDER_METADATA",
      })),
    };
    const capturedProviderCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const currentProviderCourse = {
      ...capturedProviderCourse,
      updatedAt: new Date("2026-08-20T12:14:00.000Z"),
      website: "https://official.example",
      providerFamilyKey: "GENERIC_HTTP",
    };
    const capturedProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(capturedProviderCourse);
    const currentProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(currentProviderCourse);
    const campaignAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt: new Date("2026-08-20T12:00:00.000Z"),
      members: [
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 3,
          revision: 5,
          monitoringRevision: 9,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint: capturedProviderSnapshotFingerprint,
          attemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: null,
        },
      ],
    });
    const batchIncidents = Array.from({ length: 20 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      const createdAt = new Date(
        new Date("2026-08-20T12:19:00.000Z").getTime() + index,
      );
      const completedAt = new Date(
        new Date("2026-08-20T12:25:00.000Z").getTime() + index,
      );
      return {
        id: `batch-entry-descendant-${suffix}`,
        batchId: `batch-descendant-${suffix}`,
        incidentId: "incident-campaign",
        courseId: "course-1",
        cycle: 5,
        result: "NEEDS_HUMAN",
        preProbeId: null,
        postProbeId: null,
        proofSnapshot: { providerExecution: true },
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null,
        createdAt,
        updatedAt: completedAt,
        batch: {
          id: `batch-descendant-${suffix}`,
          status: "PARTIAL",
          revision: 3,
          ownerAutomationRunId: `owner-descendant-${suffix}`,
          baseSha: "release-old",
          releaseSha: "release-old",
          deployedAt: new Date("2026-08-20T12:17:00.000Z"),
          createdAt,
          updatedAt: completedAt,
          recheckDispatchKey: `dispatch-descendant-${suffix}`,
          recheckDispatchStartedAt: new Date("2026-08-20T12:18:30.000Z"),
          recheckDispatchedAt: new Date("2026-08-20T12:18:45.000Z"),
          completedAt,
          summary: { closeout: { providerExecutionStarted: true } },
          ownerAutomationRun: {
            id: `owner-descendant-${suffix}`,
            promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
            kind: "COURSE_SUPPORT",
            status: "COMPLETED",
            runtimeVersion: "release-old",
            completedAt,
            outcome: "needs_human",
            notes: `closed descendant ${suffix}`,
          },
        },
        verificationRequests: [
          {
            id: `request-descendant-${suffix}`,
            courseId: "course-1",
            releaseSha: "release-old",
            providerSnapshotFingerprint: currentProviderSnapshotFingerprint,
            providerSnapshotAt: startedAt,
            discoveryAttemptedAt: null,
            discoveryVerifiedAt: null,
            createdAt,
            updatedAt: completedAt,
            status: "SUCCEEDED" as const,
            revision: 3,
            attemptCount: 1,
            workflowRunId: `workflow-descendant-${suffix}`,
            startedAt,
            outcome: "FETCH_FAILED" as const,
            failureClass: "MISSING_METADATA" as const,
            evidence: { providerExecution: true },
            lastError: "metadata remained incomplete",
          },
        ],
      };
    });
    const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 5,
      entries: batchIncidents,
      requireOrchestrationOnly: false,
      requireStartedRequest: true,
    });
    expect(history).not.toBeNull();
    const monitoringEvents = [
      {
        id: "endpoint-descendant",
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "METADATA:MISSING",
        occurredAt: parkedAt,
        audit: {
          cycle: 5,
          customerState: "NEEDS_HUMAN_REVIEW",
          parkedUntilMaterialChange: true,
          automationStalled: true,
          playbookExhausted: false,
          endpointStalled: true,
        },
      },
      {
        id: "handoff-descendant",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "METADATA:MISSING",
        occurredAt: handoffAt,
        audit: {
          providerFamilyHandoff: true,
          providerFamilyChanged: true,
          providerSnapshotChanged: true,
          priorCycle: 4,
          cycle: 5,
          claimedProviderSnapshotFingerprint:
            capturedProviderSnapshotFingerprint,
          observedProviderSnapshotFingerprint:
            currentProviderSnapshotFingerprint,
          priorProviderFamilyKey: "SOURCE_MISSING",
          providerFamilyKey: "GENERIC_HTTP",
          priorFailureFingerprint: "SOURCE:MISSING",
          failureFingerprint: "METADATA:MISSING",
          customerDataIncluded: false,
        },
      },
      {
        id: "admission-descendant",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        occurredAt: admittedAt,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          priorCycle: 3,
          cycle: 4,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    ];
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 5,
      revision: 12,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "GENERIC_HTTP",
      failureClass: "MISSING_METADATA",
      failureFingerprint: "METADATA:MISSING",
      attemptLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      attemptCount: 7,
      lastAttemptAt: new Date("2026-08-20T12:25:00.000Z"),
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents,
      batchIncidents,
      course: {
        ...currentProviderCourse,
        probes: [latestProbe],
        automationDiscoveries: [latestDiscovery],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "METADATA:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const plannerFindMany = vi
      .fn()
      .mockResolvedValueOnce([baseIncident])
      .mockResolvedValueOnce([{ ...baseIncident, batchIncidents }]);
    const plannedMembers = await loadParkedCourseCampaignAdmissionMembers(
      campaignAudit,
      {
        courseSupportIncident: { findMany: plannerFindMany },
      } as never,
      "campaign-run-1",
      "release-current",
    );
    expect(plannedMembers).toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        latestProbeId: latestProbe.id,
        latestDiscoveryId: latestDiscovery.id,
      }),
    ]);
    const planned = plannedMembers[0]!;
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: planned.cycle,
      expectedRevision: planned.revision,
      expectedMonitoringRevision: planned.monitoringRevision,
      capturedRevision: planned.capturedRevision,
      capturedMonitoringRevision: planned.capturedMonitoringRevision,
      capturedCycle: planned.capturedCycle,
      campaignCapturedAt: planned.campaignCapturedAt,
      admissionMode: planned.admissionMode,
      expectedSameCycleRecoveryHistoryDigest:
        planned.sameCycleRecoveryHistoryDigest,
      expectedPlaybookNextStage: planned.playbookNextStage,
      expectedPlaybookCompletedStageCount: planned.playbookCompletedStageCount,
      currentRuntimeVersion: "release-current",
      capturedKind: planned.capturedKind,
      capturedProviderFamilyKey: planned.capturedProviderFamilyKey,
      expectedKind: planned.kind,
      expectedFailureClass: planned.failureClass,
      expectedLatestProbeAt: planned.latestProbeAt,
      expectedLatestDiscoveryAt: planned.latestDiscoveryAt,
      expectedLatestProbeId: planned.latestProbeId,
      expectedLatestDiscoveryId: planned.latestDiscoveryId,
      expectedProviderFamilyKey: planned.providerFamilyKey,
      expectedFailureFingerprint: planned.failureFingerprint,
      expectedMonitoringFailureFingerprint:
        planned.monitoringFailureFingerprint,
      expectedProviderSnapshotFingerprint: planned.providerSnapshotFingerprint,
      expectedAttemptLedgerFingerprint: planned.attemptLedgerFingerprint,
      expectedPlaybookConclusion: planned.playbookConclusion,
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: campaignAudit.membershipDigest,
      now: recoveredAt,
    };
    transactionMocks.automationRun.findUnique.mockResolvedValue({
      promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
      audit: campaignAudit,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValue(
      batchIncidents,
    );
    transactionMocks.courseProbe.findFirst.mockResolvedValue(latestProbe);
    transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
      latestDiscovery,
    );

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 5 });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    for (const preserved of [
      "cycle",
      "attemptLedger",
      "attemptCount",
      "confirmedAt",
      "lastAttemptAt",
    ]) {
      expect(update.data).not.toHaveProperty(preserved);
    }
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            action: "parked_cohort_descendant_incomplete_playbook_recovery",
            admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
            descendantHandoffCount: 1,
            descendantLineageDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            preservesAttemptCounts: true,
            preservesImmutableCampaignAudit: true,
            campaign: {
              kind: "PARKED_COHORT",
              runId: "campaign-run-1",
              membershipDigest: campaignAudit.membershipDigest,
              cycle: 5,
            },
          }),
        }),
      }),
    );
    const historyLockQueries = transactionMocks.$queryRaw.mock.calls.filter(
      ([query]) => {
        const sql = (query as { strings?: readonly string[] }).strings?.join("");
        return (
          sql?.includes("FOR UPDATE") &&
          [
            'FROM "CourseSupportBatch"',
            'FROM "AutomationRun"',
            'FROM "CourseSupportBatchIncident"',
            'FROM "CourseSupportVerificationRequest"',
          ].some((table) => sql.includes(table))
        );
      },
    );
    expect(historyLockQueries).toHaveLength(4);
    expect(
      historyLockQueries.map(
        ([query]) => (query as { values?: unknown[] }).values?.length,
      ),
    ).toEqual([20, 20, 20, 20]);
    expect(transactionMocks.automationRun.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();

    transactionMocks.courseSupportIncident.updateMany.mockClear();
    transactionMocks.courseMonitoringEvent.create.mockClear();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...baseIncident,
      monitoringEvents: [
        ...monitoringEvents,
        {
          ...monitoringEvents[1],
          occurredAt: new Date("2026-08-20T12:16:00.000Z"),
        },
      ],
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    for (const changedCourseEvidence of [
      {
        ...baseIncident.course,
        probes: [
          latestProbe,
          { ...latestProbe, id: "probe-descendant-same-time-sibling" },
        ],
      },
      {
        ...baseIncident.course,
        automationDiscoveries: [
          latestDiscovery,
          {
            ...latestDiscovery,
            id: "discovery-descendant-same-time-sibling",
          },
        ],
      },
    ]) {
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        ...baseIncident,
        course: changedCourseEvidence,
      });
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }

    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    const defaultQueryRaw = transactionMocks.$queryRaw.getMockImplementation()!;
    transactionMocks.$queryRaw.mockImplementation(
      async (query: { strings?: readonly string[]; values?: unknown[] }) => {
        const sql = query.strings?.join("") ?? "";
        if (sql.includes('FROM "CourseProbe"')) {
          return [
            latestProbe,
            { ...latestProbe, id: "probe-descendant-late-sibling" },
          ];
        }
        return defaultQueryRaw(query);
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    transactionMocks.$queryRaw.mockImplementation(
      async (query: { strings?: readonly string[]; values?: unknown[] }) => {
        const sql = query.strings?.join("") ?? "";
        if (sql.includes('FROM "CourseAutomationDiscovery"')) {
          return [
            latestDiscovery,
            {
              ...latestDiscovery,
              id: "discovery-descendant-late-sibling",
            },
          ];
        }
        return defaultQueryRaw(query);
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    for (const arrangeLockedHistoryRace of [
      () =>
        transactionMocks.$queryRaw.mockImplementation(
          async (query: { strings?: readonly string[]; values?: unknown[] }) => {
            const sql = query.strings?.join("") ?? "";
            if (sql.includes('FROM "CourseSupportVerificationRequest"')) {
              return [];
            }
            return defaultQueryRaw(query);
          },
        ),
      () =>
        transactionMocks.$queryRaw.mockImplementation(
          async (query: { strings?: readonly string[]; values?: unknown[] }) => {
            const sql = query.strings?.join("") ?? "";
            if (sql.includes('FROM "CourseSupportBatchIncident"')) {
              const expectedIds = [...new Set(query.values ?? [])]
                .filter((value): value is string => typeof value === "string")
                .sort((left, right) => left.localeCompare(right));
              return expectedIds.map((id, index) => ({
                id: index === 0 ? "batch-entry-descendant-substituted" : id,
              }));
            }
            return defaultQueryRaw(query);
          },
        ),
    ]) {
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        baseIncident,
      );
      arrangeLockedHistoryRace();
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }
  });

  it("atomically resumes only the exact requestless zero-stage +3 descendant", async () => {
    const capturedAt = new Date("2026-08-20T12:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const firstHandoffAt = new Date("2026-08-20T12:10:00.000Z");
    const finalHandoffAt = new Date("2026-08-20T12:15:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const capturedCourse = {
      timeZone: "America/New_York",
      isPublic: true,
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      bookingWindowEvidenceUrl: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const intermediateCourse = {
      ...capturedCourse,
      website: "https://first.example/tee-times",
      providerFamilyKey: "GENERIC_HTTP",
    };
    const currentCourse = {
      ...intermediateCourse,
      updatedAt: new Date("2026-08-20T12:18:00.000Z"),
      website: "https://second.example/tee-times",
    };
    const capturedFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(capturedCourse);
    const intermediateFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(intermediateCourse);
    const currentFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(currentCourse);
    const emptyLedger = { version: 1, events: [] };
    const campaignAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 3,
          revision: 5,
          monitoringRevision: 9,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint: capturedFingerprint,
          attemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: null,
        },
      ],
    });
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const noExecution = {
      claimedImplementationPaths: true,
      newReleaseRecorded: false,
      deploymentRecorded: false,
      postProbeRecorded: false,
      providerAttemptRecorded: false,
      playbookAttemptRecorded: false,
      terminalResultRecorded: false,
      providerExecutionStarted: false,
    };
    const searchExecutionFence = persistCourseSupportSearchExecutionFence(
      {
        schemaVersion: 1,
        digest: "1".repeat(64),
        searchStateDigest: "2".repeat(64),
        probeEvidenceRefs: [],
        settled: true,
        reasons: [],
        batchSearchCount: 0,
        teeSearchCount: 0,
        preferenceCount: 0,
        probeCount: 0,
        deletedSearchRefs: [],
        probeEvidenceBySearch: [],
        memberships: [],
        providerExecutionAttemptCourseIds: [],
        providerExecutionAttemptCourseRefs: [],
        searchExecutionMayHaveStartedCourseRefs: [],
      },
      new Date("2026-08-20T12:24:00.000Z"),
    );
    const batchEntry = {
      id: "zero-entry",
      batchId: "zero-batch",
      incidentId: "incident-campaign",
      courseId: "course-1",
      cycle: 6,
      result: "NEEDS_HUMAN",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: null,
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date("2026-08-20T12:20:00.000Z"),
      updatedAt: new Date("2026-08-20T12:25:00.000Z"),
      batch: {
        id: "zero-batch",
        status: "PARTIAL",
        revision: 1,
        ownerAutomationRunId: null,
        baseSha: "release-old",
        releaseSha: null,
        deployedAt: null,
        createdAt: new Date("2026-08-20T12:19:00.000Z"),
        updatedAt: new Date("2026-08-20T12:25:00.000Z"),
        recheckDispatchKey: null,
        recheckDispatchStartedAt: null,
        recheckDispatchedAt: null,
        completedAt: new Date("2026-08-20T12:25:00.000Z"),
        summary: {
          campaign: {
            kind: "PARKED_COHORT",
            attempts: [
              {
                courseRef,
                runId: "campaign-run-1",
                membershipDigest: campaignAudit.membershipDigest,
                cycle: 6,
              },
            ],
          },
          searchExecutionFence,
          closeout: {
            orchestrationOnlyCourseRefs: [courseRef],
            remediationAttempts: [
              {
                courseRef,
                providerSnapshotFingerprint: currentFingerprint,
                failureFingerprint: "SOURCE:MISSING",
                runtimeVersion: "release-old",
                consumed: false,
                countsTowardOperationalNoProgress: false,
                executionEvidence: noExecution,
              },
            ],
          },
        },
        ownerAutomationRun: null,
      },
      verificationRequests: [],
    };
    const monitoringEvents = [
      {
        id: "zero-endpoint",
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: parkedAt,
        audit: {
          cycle: 6,
          customerState: "NEEDS_HUMAN_REVIEW",
          parkedUntilMaterialChange: true,
          automationStalled: true,
          playbookExhausted: false,
          endpointStalled: true,
        },
      },
      {
        id: "zero-handoff-2",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: finalHandoffAt,
        audit: {
          providerFamilyHandoff: true,
          priorCycle: 5,
          cycle: 6,
          priorProviderFamilyKey: "GENERIC_HTTP",
          providerFamilyKey: "GENERIC_HTTP",
          priorFailureFingerprint: "HTTP:MISSING",
          failureFingerprint: "SOURCE:MISSING",
          claimedProviderSnapshotFingerprint: intermediateFingerprint,
          observedProviderSnapshotFingerprint: currentFingerprint,
          providerFamilyChanged: false,
          providerSnapshotChanged: true,
          customerDataIncluded: false,
        },
      },
      {
        id: "zero-handoff-1",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "HTTP:MISSING",
        readPath: null,
        occurredAt: firstHandoffAt,
        audit: {
          providerFamilyHandoff: true,
          priorCycle: 4,
          cycle: 5,
          priorProviderFamilyKey: "SOURCE_MISSING",
          providerFamilyKey: "GENERIC_HTTP",
          priorFailureFingerprint: "SOURCE:MISSING",
          failureFingerprint: "HTTP:MISSING",
          claimedProviderSnapshotFingerprint: capturedFingerprint,
          observedProviderSnapshotFingerprint: intermediateFingerprint,
          providerFamilyChanged: true,
          providerSnapshotChanged: true,
          customerDataIncluded: false,
        },
      },
      {
        id: "zero-admission",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: admittedAt,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          priorCycle: 3,
          cycle: 4,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    ];
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 6,
      revision: 12,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "GENERIC_HTTP",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: emptyLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      attemptCount: 7,
      lastAttemptAt: batchEntry.batch.completedAt,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents,
      batchIncidents: [batchEntry],
      course: {
        ...currentCourse,
        probes: [],
        automationDiscoveries: [],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const assessment =
      assessParkedCourseCampaignDescendantIncompletePlaybookRecovery({
        captured: campaignAudit.members[0]!,
        current: {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 6,
          revision: 12,
          monitoringRevision: 16,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "GENERIC_HTTP",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint: currentFingerprint,
          attemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(emptyLedger),
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: null,
          activeRealSearchCount: 0,
          zeroExecutionEvidence: {
            latestProbe: null,
            latestDiscovery: null,
            latestProbeTimestampRowCount: 0,
            latestDiscoveryTimestampRowCount: 0,
            monitoringEvents,
            batchIncidents: [batchEntry],
            playbookAssessment: assessAutomationPlaybook(emptyLedger, 6),
          },
        },
        capturedAt,
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: campaignAudit.membershipDigest,
      });
    expect(assessment).not.toBeNull();
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 6,
      expectedRevision: 12,
      expectedMonitoringRevision: 16,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      campaignCapturedAt: campaignAudit.capturedAt,
      admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY" as const,
      expectedSameCycleRecoveryHistoryDigest: assessment!.history.historyDigest,
      expectedPlaybookNextStage: "OFFICIAL_IDENTITY",
      expectedPlaybookCompletedStageCount: 0,
      currentRuntimeVersion: "release-current",
      capturedKind: "NEEDS_ADAPTER" as const,
      capturedProviderFamilyKey: "SOURCE_MISSING",
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: null,
      expectedLatestDiscoveryAt: null,
      expectedLatestProbeId: null,
      expectedLatestDiscoveryId: null,
      expectedProviderFamilyKey: "GENERIC_HTTP",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint: currentFingerprint,
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(emptyLedger),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: campaignAudit.membershipDigest,
      now: recoveredAt,
    };
    const defaultQueryRaw = transactionMocks.$queryRaw.getMockImplementation()!;
    const arrangeBase = () => {
      vi.clearAllMocks();
      transactionMocks.$queryRaw.mockImplementation(defaultQueryRaw);
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        baseIncident,
      );
      transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValue([
        batchEntry,
      ]);
      transactionMocks.automationRun.findUnique.mockResolvedValue({
        promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
        status: "RUNNING",
        completedAt: null,
        audit: campaignAudit,
      });
      transactionMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.course.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.courseSupportBatch.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseProbe.findFirst.mockResolvedValue(null);
      transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
      transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
        id: "zero-recovery-marker",
      });
    };

    arrangeBase();
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 6 });
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
            descendantHandoffCount: 2,
            batchCount: 1,
            requestCount: 0,
            startedRequestCount: 0,
            playbookCompletedStageCount: 0,
            playbookNextStage: "OFFICIAL_IDENTITY",
            zeroProgressOrchestrationOnly: true,
            releaseEvidenceAbsent: true,
            executionEvidenceAbsent: true,
          }),
        }),
      }),
    );

    for (const arrangeRace of [
      () =>
        transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValueOnce(
          { id: "late-entry" },
        ),
      () =>
        transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
          { id: "late-request" },
        ),
      () => {
        const changed = structuredClone(batchEntry);
        changed.batch.summary.searchExecutionFence.searchExecutionMayHaveStartedCourseRefs =
          [courseRef];
        transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValueOnce(
          [changed],
        );
      },
      () =>
        transactionMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(
          {
            ...baseIncident,
            course: {
              ...baseIncident.course,
              probes: [
                {
                  id: "post-handoff-probe",
                  courseId: "course-1",
                  observedAt: new Date(finalHandoffAt.getTime() + 1),
                },
              ],
            },
          },
        ),
      () =>
        transactionMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(
          {
            ...baseIncident,
            course: {
              ...baseIncident.course,
              automationDiscoveries: [
                {
                  id: "post-handoff-discovery",
                  courseId: "course-1",
                  createdAt: new Date(finalHandoffAt.getTime() + 1),
                },
              ],
            },
          },
        ),
      () => {
        const changed = structuredClone(batchEntry);
        changed.verificationRequests.push({
          id: "late-request-row",
          releaseSha: "release-old",
          status: "STALE",
          revision: 1,
          attemptCount: 0,
          workflowRunId: null,
          startedAt: null,
          outcome: null,
          failureClass: null,
          evidence: null,
          lastError: null,
        });
        transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValueOnce(
          [changed],
        );
      },
    ]) {
      arrangeBase();
      arrangeRace();
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }
  });

  it("atomically resumes the exact same-identity +2 depth-4 campaign member and fences every evidence layer", async () => {
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const materialChangeAt = new Date("2026-08-20T12:10:00.000Z");
    const parkedAt = new Date("2026-08-20T12:45:00.000Z");
    const latestProbe = {
      id: "probe-planned",
      courseId: "course-1",
      observedAt: new Date("2026-08-20T12:41:00.000Z"),
    };
    const latestDiscovery = {
      id: "discovery-planned",
      courseId: "course-1",
      createdAt: new Date("2026-08-20T12:42:00.000Z"),
    };
    const capturedProviderCourse = {
      updatedAt: new Date("2026-08-20T12:09:00.000Z"),
      timeZone: "America/New_York",
      isPublic: true,
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      bookingWindowEvidenceUrl: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const providerCourse = {
      ...capturedProviderCourse,
      website: "https://official.example/tee-times",
    };
    const capturedProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(capturedProviderCourse);
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourse);
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const attemptLedger = {
      version: 1,
      events: [
        ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
        ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
        ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
        ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
      ].map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle: 5,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(
          materialChangeAt.getTime() + index * 1_000,
        ).toISOString(),
        failureFingerprint: "SOURCE:MISSING",
        runtimeVersion: "release-old",
        skipReason: "NO_PROVIDER_METADATA",
      })),
    };
    const campaignAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt: new Date("2026-08-20T12:00:00.000Z"),
      members: [
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 3,
          revision: 5,
          monitoringRevision: 9,
          monitoringFailureFingerprint: "SOURCE:LEGACY",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint: capturedProviderSnapshotFingerprint,
          attemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: null,
        },
      ],
    });
    const makeEntry = (ordinal: number) => {
      const createdAt = new Date(
        `2026-08-20T12:${String(ordinal * 10 + 1).padStart(2, "0")}:00.000Z`,
      );
      const completedAt = new Date(
        `2026-08-20T12:${String(ordinal * 10 + 9).padStart(2, "0")}:00.000Z`,
      );
      return {
        id: `batch-entry-${ordinal}`,
        batchId: `batch-${ordinal}`,
        incidentId: "incident-campaign",
        courseId: "course-1",
        cycle: 5,
        result: ordinal === 3 ? "NEEDS_HUMAN" : "RETRY_SCHEDULED",
        preProbeId: null,
        postProbeId: null,
        proofSnapshot: { ordinal, providerExecution: true },
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null,
        createdAt,
        updatedAt: completedAt,
        batch: {
          id: `batch-${ordinal}`,
          status: ordinal === 3 ? "PARTIAL" : "RETRYABLE_FAILED",
          revision: ordinal,
          ownerAutomationRunId: `owner-${ordinal}`,
          baseSha: "release-old",
          releaseSha: "release-old",
          deployedAt: new Date("2026-08-20T12:09:00.000Z"),
          createdAt: new Date(createdAt.getTime() - 30_000),
          updatedAt: completedAt,
          recheckDispatchKey: `dispatch-${ordinal}`,
          recheckDispatchStartedAt: createdAt,
          recheckDispatchedAt: createdAt,
          completedAt,
          summary: {
            remediation: {
              attempts: [{ courseRef, providerSnapshotFingerprint }],
            },
            closeout: {
              ordinal,
              remediationAttempts: [
                {
                  courseRef,
                  providerSnapshotFingerprint,
                  observedProviderSnapshotFingerprint:
                    providerSnapshotFingerprint,
                  failureFingerprint: "SOURCE:MISSING",
                  observedFailureFingerprint: "SOURCE:MISSING",
                  runtimeVersion: "release-old",
                  providerSnapshotChanged: false,
                },
              ],
            },
          },
          ownerAutomationRun: {
            id: `owner-${ordinal}`,
            promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
            kind: "COURSE_SUPPORT",
            status: "COMPLETED",
            runtimeVersion: "release-old",
            completedAt,
            outcome: "needs_human",
            notes: `closed ordinal ${ordinal}`,
          },
        },
        verificationRequests: [
          {
            id: `request-${ordinal}`,
            courseId: "course-1",
            releaseSha: "release-old",
            providerSnapshotFingerprint,
            providerSnapshotAt: new Date(createdAt.getTime() + 20_000),
            discoveryAttemptedAt: new Date(createdAt.getTime() + 10_000),
            discoveryVerifiedAt: new Date(createdAt.getTime() + 30_000),
            createdAt: materialChangeAt,
            updatedAt: completedAt,
            status: "SUCCEEDED" as const,
            revision: ordinal + 1,
            attemptCount: 1,
            workflowRunId: `workflow-${ordinal}`,
            startedAt: createdAt,
            outcome: "FETCH_FAILED" as const,
            failureClass: "MISSING_SOURCE" as const,
            evidence: { ordinal, providerExecution: true },
            lastError: "source remained unavailable",
          },
        ],
      };
    };
    const batchIncidents = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 5,
      entries: batchIncidents,
      requireOrchestrationOnly: false,
      requireStartedRequest: true,
    });
    expect(history).not.toBeNull();
    const monitoringEvents = [
      {
        id: "endpoint-material-change",
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: parkedAt,
        audit: {
          cycle: 5,
          customerState: "NEEDS_HUMAN_REVIEW",
          parkedUntilMaterialChange: true,
          automationStalled: true,
          playbookExhausted: false,
          endpointStalled: true,
        },
      },
      {
        id: "operator-material-change",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "OPERATOR_CLI",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: materialChangeAt,
        audit: {
          reason: "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED",
          priorCycle: 4,
          cycle: 5,
          priorProviderFamilyKey: "SOURCE_MISSING",
          providerFamilyKey: "SOURCE_MISSING",
          providerFamilyChanged: false,
          changedFields: ["website"],
          evidenceFingerprint: providerSnapshotFingerprint,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
      {
        id: "campaign-admission-material-change",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: admittedAt,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          priorCycle: 3,
          cycle: 4,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    ];
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 5,
      revision: 12,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      attemptCount: 8,
      lastAttemptAt: new Date("2026-08-20T12:40:00.000Z"),
      confirmedAt: admittedAt,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents,
      batchIncidents,
      course: {
        ...providerCourse,
        probes: [latestProbe],
        automationDiscoveries: [latestDiscovery],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const campaignRun = {
      promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
      audit: campaignAudit,
    };
    const recoveryAssessment =
      assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery(
        {
          captured: campaignAudit.members[0]!,
          current: {
            courseId: "course-1",
            incidentId: "incident-campaign",
            cycle: 5,
            revision: 12,
            monitoringRevision: 16,
            monitoringFailureFingerprint: "SOURCE:MISSING",
            kind: "NEEDS_ADAPTER",
            providerFamilyKey: "SOURCE_MISSING",
            failureClass: "MISSING_SOURCE",
            failureFingerprint: "SOURCE:MISSING",
            providerSnapshotFingerprint,
            attemptLedgerFingerprint:
              createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger),
            playbookConclusion: "INCOMPLETE",
            latestProbeAt: latestProbe.observedAt.toISOString(),
            latestDiscoveryAt: latestDiscovery.createdAt.toISOString(),
            activeRealSearchCount: 0,
            zeroExecutionEvidence: {
              latestProbe,
              latestDiscovery,
              latestProbeTimestampRowCount: 1,
              latestDiscoveryTimestampRowCount: 1,
              monitoringEvents,
              batchIncidents,
              playbookAssessment: assessAutomationPlaybook(attemptLedger, 5),
            },
          },
          capturedAt: new Date(campaignAudit.capturedAt),
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
        },
      );
    expect(recoveryAssessment).not.toBeNull();
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 5,
      expectedRevision: 12,
      expectedMonitoringRevision: 16,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      campaignCapturedAt: campaignAudit.capturedAt,
      admissionMode:
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY" as const,
      expectedSameCycleRecoveryHistoryDigest:
        recoveryAssessment!.history.historyDigest,
      expectedPlaybookNextStage: "RENDERED_BROWSER_DISCOVERY",
      expectedPlaybookCompletedStageCount: 4,
      currentRuntimeVersion: "release-current",
      capturedKind: "NEEDS_ADAPTER" as const,
      capturedProviderFamilyKey: "SOURCE_MISSING",
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: latestProbe.observedAt.toISOString(),
      expectedLatestDiscoveryAt: latestDiscovery.createdAt.toISOString(),
      expectedLatestProbeId: latestProbe.id,
      expectedLatestDiscoveryId: latestDiscovery.id,
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint: providerSnapshotFingerprint,
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: campaignAudit.membershipDigest,
      now: recoveredAt,
    };
    const defaultQueryRaw = transactionMocks.$queryRaw.getMockImplementation()!;
    const failLockedTable = (table: string) =>
      transactionMocks.$queryRaw.mockImplementation(
        async (query: { strings?: readonly string[]; values?: unknown[] }) => {
          const sql = query.strings?.join("") ?? "";
          if (sql.includes(table)) return [];
          return defaultQueryRaw(query);
        },
      );
    const arrangeBase = () => {
      vi.clearAllMocks();
      transactionMocks.$queryRaw.mockImplementation(defaultQueryRaw);
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        baseIncident,
      );
      transactionMocks.automationRun.findUnique.mockResolvedValue(campaignRun);
      transactionMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.course.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.courseSupportBatch.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValue(
        batchIncidents,
      );
      transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValue(
        { count: 1 },
      );
      transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseProbe.findFirst.mockResolvedValue(latestProbe);
      transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
        latestDiscovery,
      );
      transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
      transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
        id: "recovery-marker",
      });
    };

    arrangeBase();
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 5 });
    const incidentUpdate =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(incidentUpdate.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    expect(incidentUpdate.data.escalationDeadlineAt.getTime()).toBeGreaterThan(
      recoveredAt.getTime(),
    );
    for (const preserved of [
      "cycle",
      "attemptLedger",
      "attemptCount",
      "confirmedAt",
      "lastAttemptAt",
    ]) {
      expect(incidentUpdate.data).not.toHaveProperty(preserved);
    }
    expect(transactionMocks.automationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "campaign-run-1",
          audit: { equals: campaignAudit },
        }),
      }),
    );
    expect(transactionMocks.course.updateMany).toHaveBeenCalledWith({
      where: {
        id: "course-1",
        updatedAt: providerCourse.updatedAt,
      },
      data: { updatedAt: providerCourse.updatedAt },
    });
    expect(transactionMocks.courseProbe.findFirst).toHaveBeenCalledWith({
      where: { courseId: "course-1" },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      select: { id: true, courseId: true, observedAt: true },
    });
    expect(
      transactionMocks.courseAutomationDiscovery.findFirst,
    ).toHaveBeenCalledWith({
      where: { courseId: "course-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, courseId: true, createdAt: true },
    });
    const evidenceLockQueries = transactionMocks.$queryRaw.mock.calls
      .map(
        ([query]) =>
          query as { strings: readonly string[]; values: unknown[] },
      )
      .filter((query) => {
        const sql = query.strings.join("");
        return (
          sql.includes('FROM "CourseProbe"') ||
          sql.includes('FROM "CourseAutomationDiscovery"')
        );
      });
    expect(evidenceLockQueries).toHaveLength(2);
    expect(evidenceLockQueries[0]!.strings.join("")).toContain(
      'FROM "CourseProbe"',
    );
    expect(evidenceLockQueries[0]!.strings.join("")).toContain("FOR UPDATE");
    expect(evidenceLockQueries[0]!.values).toEqual([
      latestProbe.id,
      latestProbe.courseId,
      latestProbe.observedAt,
    ]);
    expect(evidenceLockQueries[1]!.strings.join("")).toContain(
      'FROM "CourseAutomationDiscovery"',
    );
    expect(evidenceLockQueries[1]!.strings.join("")).toContain("FOR UPDATE");
    expect(evidenceLockQueries[1]!.values).toEqual([
      latestDiscovery.id,
      latestDiscovery.courseId,
      latestDiscovery.createdAt,
    ]);
    const historyLockQueries = transactionMocks.$queryRaw.mock.calls
      .map(
        ([query]) =>
          query as { strings: readonly string[]; values: unknown[] },
      )
      .filter((query) => {
        const sql = query.strings.join("");
        return [
          'FROM "CourseSupportBatch"',
          'FROM "AutomationRun"',
          'FROM "CourseSupportBatchIncident"',
          'FROM "CourseSupportVerificationRequest"',
        ].some((table) => sql.includes(table));
      });
    expect(historyLockQueries).toHaveLength(4);
    expect(historyLockQueries.map((query) => query.values.length)).toEqual([
      3, 3, 3, 3,
    ]);
    expect(transactionMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportBatchIncident.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { incidentId: "incident-campaign", cycle: 5 },
        take: 21,
      }),
    );
    expect(
      transactionMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: expect.stringContaining(
            "parked-cohort-same-identity-material-change-incomplete-playbook-recovery",
          ),
          audit: expect.objectContaining({
            admissionMode:
              "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
            materialChangeLineageDigest:
              expect.stringMatching(/^[a-f0-9]{64}$/u),
            sameCycleRecoveryHistoryDigest:
              recoveryAssessment!.history.historyDigest,
            batchCount: 3,
            startedRequestCount: 3,
            playbookCompletedStageCount: 4,
            playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
            supersededEndpointId: "endpoint-material-change",
            supersededEndpointAt: parkedAt.toISOString(),
            sameCycleRecovery: true,
            oneShot: true,
            preservesAttemptLedger: true,
            preservesAttemptCounts: true,
            preservesAttemptTimestamps: true,
            preservesOperatorEvidence: true,
            preservesImmutableCampaignAudit: true,
            customerDataIncluded: false,
            campaign: {
              kind: "PARKED_COHORT",
              runId: "campaign-run-1",
              membershipDigest: campaignAudit.membershipDigest,
              cycle: 5,
            },
          }),
        }),
      }),
    );

    const raceControls = [
      () =>
        transactionMocks.automationRun.updateMany.mockResolvedValueOnce({
          count: 0,
        }),
      () => failLockedTable('FROM "AutomationRun"'),
      () =>
        transactionMocks.course.updateMany.mockResolvedValueOnce({ count: 0 }),
      () => failLockedTable('FROM "CourseSupportBatch"'),
      () => failLockedTable('FROM "CourseSupportBatchIncident"'),
      () => failLockedTable('FROM "CourseSupportVerificationRequest"'),
      () => {
        const timestampDrift = batchIncidents.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                verificationRequests: [
                  {
                    ...entry.verificationRequests[0]!,
                    discoveryVerifiedAt: new Date(
                      entry.verificationRequests[0]!.discoveryVerifiedAt!.getTime() +
                        1,
                    ),
                  },
                ],
              }
            : entry,
        );
        transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValueOnce(
          timestampDrift,
        );
      },
      () =>
        transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValueOnce(
          { id: "late-current-cycle-entry" },
        ),
      () =>
        transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
          { id: "late-current-cycle-request" },
        ),
      () =>
        transactionMocks.courseProbe.findFirst.mockResolvedValueOnce({
          ...latestProbe,
          id: "probe-appended-at-same-timestamp",
        }),
      () =>
        transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValueOnce(
          {
            ...latestDiscovery,
            id: "discovery-appended-at-same-timestamp",
          },
        ),
      () => failLockedTable('FROM "CourseProbe"'),
      () => failLockedTable('FROM "CourseAutomationDiscovery"'),
      () =>
        transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValueOnce({
          id: "late-recovery-marker",
        }),
    ];
    for (const [raceIndex, arrangeRace] of raceControls.entries()) {
      arrangeBase();
      arrangeRace();
      const raceResult =
        await reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        );
      expect(raceResult, `race control ${raceIndex}`).toEqual({
        admitted: false,
      });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }

    const committedSameTimestampIdentityChanges = [
      {
        ...baseIncident,
        course: {
          ...baseIncident.course,
          probes: [{ ...latestProbe, id: "probe-committed-at-same-timestamp" }],
        },
      },
      {
        ...baseIncident,
        course: {
          ...baseIncident.course,
          automationDiscoveries: [
            {
              ...latestDiscovery,
              id: "discovery-committed-at-same-timestamp",
            },
          ],
        },
      },
    ];
    for (const changedIncident of committedSameTimestampIdentityChanges) {
      arrangeBase();
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        changedIncident,
      );
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }

    arrangeBase();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...baseIncident,
      activeBatchId: "active-batch",
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it.each([
    "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
    "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
  ] as const)("uses SERIALIZABLE for %s admission", async (admissionMode) => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(null);

    await expect(
      reopenParkedCourseForResponderCampaign({
        courseId: "course-1",
        incidentId: "incident-campaign",
        expectedCycle: 5,
        expectedRevision: 12,
        expectedMonitoringRevision: 16,
        capturedRevision: 5,
        capturedMonitoringRevision: 9,
        capturedCycle: 3,
        campaignCapturedAt: "2026-08-20T12:00:00.000Z",
        admissionMode,
        expectedSameCycleRecoveryHistoryDigest: "a".repeat(64),
        expectedPlaybookNextStage: "RENDERED_BROWSER_DISCOVERY",
        expectedPlaybookCompletedStageCount: 4,
        capturedKind: "NEEDS_ADAPTER",
        capturedProviderFamilyKey: "SOURCE_MISSING",
        expectedKind: "NEEDS_ADAPTER",
        expectedFailureClass: "MISSING_SOURCE",
        expectedLatestProbeAt: null,
        expectedLatestDiscoveryAt: null,
        expectedLatestProbeId: null,
        expectedLatestDiscoveryId: null,
        expectedProviderFamilyKey: "SOURCE_MISSING",
        expectedFailureFingerprint: "SOURCE:MISSING",
        expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
        expectedProviderSnapshotFingerprint: "b".repeat(64),
        expectedAttemptLedgerFingerprint: "c".repeat(64),
        expectedPlaybookConclusion: "INCOMPLETE",
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: "d".repeat(64),
        currentRuntimeVersion: "e".repeat(40),
      }),
    ).resolves.toEqual({ admitted: false });
    expect(prismaMocks.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "Serializable",
        timeout: 15_000,
      }),
    );
  });

  it.each([
    [
      "rendered-browser",
      {
        completedStageCount: 4,
        nextStage: "RENDERED_BROWSER_DISCOVERY" as const,
        workMode: "DISCOVERY_ONLY",
        strategyAction: "DISCOVER_WITH_BROWSER",
      },
    ],
    [
      "browser-adapter",
      {
        completedStageCount: 5,
        nextStage: "BROWSER_ADAPTER_RETRY" as const,
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RUN_TYPED_ADAPTER",
      },
    ],
  ])(
    "plans and atomically resumes the exact requestless post-marker %s batch on a newer runtime",
    async (_label, route) => {
    const capturedAt = new Date("2026-08-20T12:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const firstEndpointAt = new Date("2026-08-20T12:15:00.000Z");
    const priorMarkerAt = new Date("2026-08-20T12:18:00.000Z");
    const postDeploymentAt = new Date("2026-08-20T12:17:00.000Z");
    const finalEndpointAt = new Date("2026-08-20T12:30:00.000Z");
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const priorRuntime = "a".repeat(40);
    const currentRuntime = "b".repeat(40);
    const legacyDiscovery = {
      id: "discovery-before-marker",
      courseId: "course-1",
      createdAt: new Date("2026-08-20T12:16:00.000Z"),
    };
    const providerCourse = {
      updatedAt: new Date("2026-08-20T12:04:00.000Z"),
      timeZone: "America/New_York",
      isPublic: true,
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      bookingWindowEvidenceUrl: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourse);
    const attemptLedger = {
      version: 1,
      events: [
        ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
        ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
        ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
        ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
        ...(route.completedStageCount === 5
          ? [["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"]]
          : []),
      ].map(([stage, readPath], index) => {
        const renderedBrowser = stage === "RENDERED_BROWSER_DISCOVERY";
        return {
          sequence: index + 1,
          cycle: 4,
          stage,
          transition: renderedBrowser ? "COMPLETED" : "NOT_APPLICABLE",
          readPath,
          evidenceKind: renderedBrowser ? "RENDERED_PAGE" : "TOOLING",
          observedAt: new Date(
            admittedAt.getTime() + index * 1_000,
          ).toISOString(),
          failureFingerprint: "SOURCE:MISSING",
          runtimeVersion: priorRuntime,
          ...(renderedBrowser
            ? {}
            : { skipReason: "NO_PROVIDER_METADATA" }),
        };
      }),
    };
    const attemptLedgerFingerprint =
      createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger);
    const campaignAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 3,
          revision: 5,
          monitoringRevision: 9,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint,
          attemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: null,
        },
      ],
    });
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const preMarkerEntry = {
      id: "batch-entry-before-marker",
      batchId: "batch-before-marker",
      incidentId: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      result: "NEEDS_HUMAN",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: { providerExecution: true },
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date("2026-08-20T12:06:00.000Z"),
      updatedAt: new Date("2026-08-20T12:12:00.000Z"),
      batch: {
        id: "batch-before-marker",
        status: "PARTIAL",
        revision: 2,
        ownerAutomationRunId: null,
        baseSha: priorRuntime,
        releaseSha: priorRuntime,
        deployedAt: new Date("2026-08-20T12:04:00.000Z"),
        createdAt: new Date("2026-08-20T12:05:30.000Z"),
        updatedAt: new Date("2026-08-20T12:12:00.000Z"),
        recheckDispatchKey: "dispatch-before-marker",
        recheckDispatchStartedAt: new Date("2026-08-20T12:06:00.000Z"),
        recheckDispatchedAt: new Date("2026-08-20T12:06:00.000Z"),
        completedAt: new Date("2026-08-20T12:12:00.000Z"),
        summary: { closeout: { providerExecutionStarted: true } },
        ownerAutomationRun: null,
      },
      verificationRequests: [
        {
          id: "request-before-marker",
          releaseSha: priorRuntime,
          updatedAt: new Date("2026-08-20T12:12:00.000Z"),
          status: "SUCCEEDED" as const,
          revision: 3,
          attemptCount: 1,
          workflowRunId: "workflow-before-marker",
          startedAt: new Date("2026-08-20T12:07:00.000Z"),
          outcome: "FETCH_FAILED" as const,
          failureClass: "MISSING_SOURCE" as const,
          evidence: { providerExecution: true },
          lastError: "source remained unavailable",
        },
      ],
    };
    const postMarkerEntry = {
      id: "batch-entry-after-marker",
      batchId: "batch-after-marker",
      incidentId: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      result: "RETRY_SCHEDULED",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: null,
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date("2026-08-20T12:20:00.000Z"),
      updatedAt: new Date("2026-08-20T12:25:00.000Z"),
      batch: {
        id: "batch-after-marker",
        status: "RETRYABLE_FAILED",
        revision: 3,
        ownerAutomationRunId: null,
        baseSha: priorRuntime,
        releaseSha: priorRuntime,
        deployedAt: postDeploymentAt,
        createdAt: new Date("2026-08-20T12:19:00.000Z"),
        updatedAt: new Date("2026-08-20T12:25:00.000Z"),
        recheckDispatchKey: null,
        recheckDispatchStartedAt: null,
        recheckDispatchedAt: null,
        completedAt: new Date("2026-08-20T12:25:00.000Z"),
        summary: {
          closeout: {
            orchestrationOnly: true,
            orchestrationOnlyCount: 1,
            remediationAttempts: [
              {
                courseRef,
                providerSnapshotFingerprint,
                observedProviderSnapshotFingerprint:
                  providerSnapshotFingerprint,
                failureFingerprint: "SOURCE:MISSING",
                observedFailureFingerprint: "SOURCE:MISSING",
                runtimeVersion: priorRuntime,
                activeRealSearchCount: 0,
                consumed: false,
                countsTowardOperationalNoProgress: false,
                executionEvidence: {
                  claimedImplementationPaths: false,
                  newReleaseRecorded: false,
                  deploymentRecorded: false,
                  postProbeRecorded: false,
                  providerAttemptRecorded: false,
                  providerExecutionAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                  providerExecutionStarted: false,
                },
                approach: {
                  workMode: route.workMode,
                  strategyAction: route.strategyAction,
                  playbookStage: route.nextStage,
                },
              },
            ],
          },
        },
        ownerAutomationRun: null,
      },
      verificationRequests: [],
    };
    const batchIncidents = [preMarkerEntry, postMarkerEntry];
    const priorHistory = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 4,
      entries: [preMarkerEntry],
      requireOrchestrationOnly: false,
      requireStartedRequest: true,
      requireCausalStartedRequest: true,
      minimumStartedAt: admittedAt,
    });
    expect(priorHistory).not.toBeNull();
    const endpointAudit = {
      cycle: 4,
      customerState: "NEEDS_HUMAN_REVIEW",
      playbookConclusion: "INCOMPLETE",
      playbookExhausted: false,
      automationStalled: true,
      parkedUntilMaterialChange: true,
      nextStage: route.nextStage,
      campaign: {
        kind: "PARKED_COHORT",
        runId: "campaign-run-1",
        membershipDigest: campaignAudit.membershipDigest,
        cycle: 4,
      },
      customerDataIncluded: false,
    };
    const monitoringEvents = [
      {
        id: "endpoint-post-marker",
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: finalEndpointAt,
        audit: endpointAudit,
      },
      {
        id: "marker-incomplete-recovery",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: priorMarkerAt,
        audit: {
          action: "parked_cohort_incomplete_playbook_recovery",
          admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          capturedCycle: 3,
          cycle: 4,
          sameCycleRecoveryHistoryDigest: priorHistory!.historyDigest,
          providerSnapshotFingerprint,
          attemptLedgerFingerprint,
          latestProbeAt: null,
          latestDiscoveryAt: legacyDiscovery.createdAt.toISOString(),
          playbookCompletedStageCount: route.completedStageCount,
          playbookNextStage: route.nextStage,
          recoveryRuntimeVersion: priorRuntime,
          sameCycleRecovery: true,
          oneShot: true,
          preservesAttemptLedger: true,
          preservesAttemptCounts: true,
          preservesAttemptTimestamps: true,
          preservesOperatorEvidence: true,
          preservesImmutableCampaignAudit: true,
          campaign: endpointAudit.campaign,
          customerDataIncluded: false,
        },
      },
      {
        id: "endpoint-before-marker",
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: firstEndpointAt,
        audit: endpointAudit,
      },
      {
        id: "campaign-admission-post-marker",
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: admittedAt,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          priorCycle: 3,
          cycle: 4,
          capturedIncidentRevision: 5,
          capturedMonitoringRevision: 9,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    ];
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      revision: 10,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      attemptCount: 6,
      lastAttemptAt: new Date("2026-08-20T12:25:00.000Z"),
      confirmedAt: admittedAt,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: finalEndpointAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents,
      batchIncidents,
      course: {
        ...providerCourse,
        probes: [],
        automationDiscoveries: [legacyDiscovery],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const campaignRun = {
      promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
      audit: campaignAudit,
    };
    const recoveryAssessment =
      assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery({
        captured: campaignAudit.members[0]!,
        current: {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 4,
          revision: 10,
          monitoringRevision: 16,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint,
          attemptLedgerFingerprint,
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: null,
          latestDiscoveryAt: legacyDiscovery.createdAt.toISOString(),
          activeRealSearchCount: 0,
          zeroExecutionEvidence: {
            latestProbe: null,
            latestDiscovery: legacyDiscovery,
            latestProbeTimestampRowCount: 0,
            latestDiscoveryTimestampRowCount: 1,
            monitoringEvents,
            batchIncidents,
            playbookAssessment: assessAutomationPlaybook(attemptLedger, 4),
          },
        },
        capturedAt,
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: campaignAudit.membershipDigest,
        currentRuntimeVersion: currentRuntime,
      });
    expect(recoveryAssessment).not.toBeNull();
    const plannerFindMany = vi.fn().mockResolvedValue([baseIncident]);
    const plannedMembers = await loadParkedCourseCampaignAdmissionMembers(
      campaignAudit,
      {
        courseSupportIncident: { findMany: plannerFindMany },
      } as never,
      "campaign-run-1",
      currentRuntime,
    );
    expect(plannedMembers).toEqual([
      expect.objectContaining({
        admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
        playbookCompletedStageCount: route.completedStageCount,
        playbookNextStage: route.nextStage,
      }),
    ]);
    const planned = plannedMembers[0]!;
    const input = {
      courseId: planned.courseId,
      incidentId: planned.incidentId,
      expectedCycle: planned.cycle,
      expectedRevision: planned.revision,
      expectedMonitoringRevision: planned.monitoringRevision,
      capturedRevision: planned.capturedRevision,
      capturedMonitoringRevision: planned.capturedMonitoringRevision,
      capturedCycle: planned.capturedCycle,
      campaignCapturedAt: planned.campaignCapturedAt,
      admissionMode: planned.admissionMode,
      expectedSameCycleRecoveryHistoryDigest:
        planned.sameCycleRecoveryHistoryDigest,
      expectedPlaybookNextStage: planned.playbookNextStage,
      expectedPlaybookCompletedStageCount: planned.playbookCompletedStageCount,
      currentRuntimeVersion: currentRuntime,
      capturedKind: planned.capturedKind,
      capturedProviderFamilyKey: planned.capturedProviderFamilyKey,
      expectedKind: planned.kind,
      expectedFailureClass: planned.failureClass,
      expectedLatestProbeAt: planned.latestProbeAt,
      expectedLatestDiscoveryAt: planned.latestDiscoveryAt,
      expectedLatestProbeId: planned.latestProbeId,
      expectedLatestDiscoveryId: planned.latestDiscoveryId,
      expectedProviderFamilyKey: planned.providerFamilyKey,
      expectedFailureFingerprint: planned.failureFingerprint,
      expectedMonitoringFailureFingerprint:
        planned.monitoringFailureFingerprint,
      expectedProviderSnapshotFingerprint: planned.providerSnapshotFingerprint,
      expectedAttemptLedgerFingerprint: planned.attemptLedgerFingerprint,
      expectedPlaybookConclusion: planned.playbookConclusion,
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: campaignAudit.membershipDigest,
      now: recoveredAt,
    };
    const defaultQueryRaw = transactionMocks.$queryRaw.getMockImplementation()!;
    const arrangeBase = () => {
      vi.clearAllMocks();
      transactionMocks.$queryRaw.mockImplementation(defaultQueryRaw);
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        baseIncident,
      );
      transactionMocks.automationRun.findUnique.mockResolvedValue(campaignRun);
      transactionMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.course.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.courseSupportBatch.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.findMany.mockResolvedValue(
        batchIncidents,
      );
      transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportVerificationRequest.updateMany.mockResolvedValue(
        { count: 1 },
      );
      transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseProbe.findFirst.mockResolvedValue(null);
      transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
        legacyDiscovery,
      );
      transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
      transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
        id: "post-marker-recovery",
      });
    };

    arrangeBase();
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 4 });
    expect(
      transactionMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportVerificationRequest.findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncidentId: {
            in: ["batch-entry-before-marker", "batch-entry-after-marker"],
          },
          id: { notIn: ["request-before-marker"] },
        }),
      }),
    );
    const incidentUpdate =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]![0];
    expect(incidentUpdate.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    for (const preserved of [
      "cycle",
      "attemptLedger",
      "attemptCount",
      "confirmedAt",
      "lastAttemptAt",
    ]) {
      expect(incidentUpdate.data).not.toHaveProperty(preserved);
    }
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: expect.stringContaining(
            "parked-cohort-post-marker-incomplete-playbook-recovery",
          ),
          audit: expect.objectContaining({
            admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
            priorRecoveryMarkerDigest:
              recoveryAssessment!.priorRecoveryMarkerDigest,
            priorRecoveryRuntimeVersion: priorRuntime,
            recoveryRuntimeVersion: currentRuntime,
            failedRuntimeVersions: [priorRuntime],
            postMarkerHistoryDigest:
              recoveryAssessment!.postMarkerHistoryDigest,
            postMarkerBatchCount: 1,
            postMarkerRequestCount: 0,
            latestDiscoveryId: legacyDiscovery.id,
            latestDiscoveryAt: legacyDiscovery.createdAt.toISOString(),
            batchCount: 2,
            startedRequestCount: 1,
            supersededEndpointId: "endpoint-post-marker",
            supersededEndpointAt: finalEndpointAt.toISOString(),
            playbookCompletedStageCount: route.completedStageCount,
            playbookNextStage: route.nextStage,
            preservesOperatorEvidence: true,
            customerDataIncluded: false,
          }),
        }),
      }),
    );
    const discoveryLock = transactionMocks.$queryRaw.mock.calls.find(
      ([query]) =>
        (query as { strings?: readonly string[] }).strings
          ?.join("")
          .includes('FROM "CourseAutomationDiscovery"'),
    );
    expect(discoveryLock?.[0].values).toEqual([
      legacyDiscovery.id,
      legacyDiscovery.courseId,
      legacyDiscovery.createdAt,
    ]);

    arrangeBase();
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        {
          ...input,
          expectedPlaybookCompletedStageCount:
            route.completedStageCount === 4 ? 5 : 4,
          expectedPlaybookNextStage:
            route.nextStage === "RENDERED_BROWSER_DISCOVERY"
              ? "BROWSER_ADAPTER_RETRY"
              : "RENDERED_BROWSER_DISCOVERY",
        },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    arrangeBase();
    transactionMocks.$queryRaw.mockImplementation(
      async (query: { strings?: readonly string[]; values?: unknown[] }) => {
        const sql = query.strings?.join("") ?? "";
        if (sql.includes('FROM "CourseAutomationDiscovery"')) {
          return [
            legacyDiscovery,
            { ...legacyDiscovery, id: "discovery-same-timestamp-sibling" },
          ];
        }
        return defaultQueryRaw(query);
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    arrangeBase();
    transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
      { id: "late-post-marker-request" },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    arrangeBase();
    transactionMocks.automationRun.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });

    arrangeBase();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...baseIncident,
      monitoringEvents: [
        ...monitoringEvents,
        {
          ...monitoringEvents[1],
          occurredAt: new Date("2026-08-20T12:31:00.000Z"),
          audit: {
            ...monitoringEvents[1]!.audit,
            action: "parked_cohort_post_marker_incomplete_playbook_recovery",
          },
        },
      ],
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
  });

  it("atomically reopens only the exact requestless stale campaign owner without resetting progress", async () => {
    prismaMocks.$transaction.mockReset();
    const capturedAt = new Date("2026-08-20T12:00:00.000Z");
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const attemptedAt = admittedAt;
    const historicalProbeAt = new Date("2026-08-20T11:30:00.000Z");
    const historicalDiscoveryAt = new Date("2026-08-20T11:40:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const attemptLedger = { version: 1, events: [] };
    const providerCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourse);
    const attemptLedgerFingerprint =
      createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger);
    const campaignAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 3,
          revision: 5,
          monitoringRevision: 9,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint,
          attemptLedgerFingerprint,
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: historicalProbeAt.toISOString(),
          latestDiscoveryAt: historicalDiscoveryAt.toISOString(),
        },
      ],
    });
    const closeout = {
      outcome: "needs_human",
      derivedOutcome: "needs_human",
      terminalCount: 0,
      restoredCount: 0,
      finalDispositionCount: 0,
      retryCount: 0,
      needsHumanCount: 1,
      endpointCount: 1,
      automationStalledCount: 1,
      exhaustedEndpointCount: 0,
      failureDomain: "SLA",
      verificationWatchMode: "ENDPOINT",
      reason: "stale_endpoint_ownership_released",
    };
    const ownerNotes = JSON.stringify({
      schemaVersion: 1,
      lifecycle: "closeout",
      status: "PARTIAL",
      outcome: "needs_human",
      derivedOutcome: "needs_human",
      reason: "stale_endpoint_ownership_released",
      endpointCount: 1,
      automationStalledCount: 1,
      exhaustedEndpointCount: 0,
      failureDomain: "SLA",
      verificationWatchMode: "ENDPOINT",
      terminalCount: 0,
      restoredCount: 0,
      finalDispositionCount: 0,
      retryCount: 0,
      needsHumanCount: 1,
    });
    const monitoringEvents = [
      {
        incidentId: "incident-campaign",
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: parkedAt,
        audit: {
          cycle: 4,
          customerState: "NEEDS_HUMAN_REVIEW",
          playbookConclusion: "INCOMPLETE",
          playbookExhausted: false,
          automationStalled: true,
          parkedUntilMaterialChange: true,
          nextStage: "OFFICIAL_IDENTITY",
          campaign: {
            kind: "PARKED_COHORT",
            runId: "campaign-run-1",
            membershipDigest: campaignAudit.membershipDigest,
            cycle: 4,
          },
          customerDataIncluded: false,
        },
      },
      {
        incidentId: "incident-campaign",
        eventType: "AUTOMATION_ATTEMPTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: "BOUNDED_RECOVERY_PLAYBOOK",
        occurredAt: attemptedAt,
        audit: {
          providerFamilyKey: "SOURCE_MISSING",
          maxCourses: 5,
          serializedWriterLane: true,
          campaignKind: "PARKED_COHORT",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          cycle: 4,
          customerDataIncluded: false,
        },
      },
      {
        incidentId: "incident-campaign",
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        failureFingerprint: "SOURCE:MISSING",
        readPath: null,
        occurredAt: admittedAt,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: campaignAudit.membershipDigest,
          priorCycle: 3,
          cycle: 4,
          capturedIncidentRevision: 5,
          capturedMonitoringRevision: 9,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    ];
    const batchIncidents = [
      {
        id: "batch-entry-stale",
        batchId: "batch-stale",
        incidentId: "incident-campaign",
        courseId: "course-1",
        cycle: 4,
        result: "NEEDS_HUMAN",
        preProbeId: "probe-historical",
        postProbeId: null,
        proofSnapshot: null,
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null,
        createdAt: attemptedAt,
        updatedAt: parkedAt,
        batch: {
          id: "batch-stale",
          status: "PARTIAL",
          revision: 2,
          ownerAutomationRunId: "owner-run-stale",
          baseSha: "release-old",
          releaseSha: null,
          deployedAt: null,
          recheckDispatchKey: null,
          recheckDispatchStartedAt: null,
          recheckDispatchedAt: null,
          completedAt: parkedAt,
          updatedAt: parkedAt,
          summary: {
            selectedIncidentCount: 1,
            campaign: {
              kind: "PARKED_COHORT",
              attempts: [
                {
                  courseRef: createHash("sha256")
                    .update("course-1")
                    .digest("hex")
                    .slice(0, 24),
                  runId: "campaign-run-1",
                  membershipDigest: campaignAudit.membershipDigest,
                  cycle: 4,
                },
              ],
            },
            closeout,
          },
          ownerAutomationRun: {
            id: "owner-run-stale",
            promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
            kind: "COURSE_SUPPORT",
            status: "COMPLETED",
            runtimeVersion: "release-old",
            completedAt: parkedAt,
            outcome: "needs_human",
            notes: ownerNotes,
          },
        },
        verificationRequests: [],
      },
    ];
    const assessment =
      assessParkedCourseCampaignRequestlessStaleOwnershipRecovery({
        captured: campaignAudit.members[0]!,
        current: {
          courseId: "course-1",
          incidentId: "incident-campaign",
          cycle: 4,
          revision: 12,
          monitoringRevision: 16,
          monitoringFailureFingerprint: "SOURCE:MISSING",
          kind: "NEEDS_ADAPTER",
          providerFamilyKey: "SOURCE_MISSING",
          failureClass: "MISSING_SOURCE",
          failureFingerprint: "SOURCE:MISSING",
          providerSnapshotFingerprint,
          attemptLedgerFingerprint,
          playbookConclusion: "INCOMPLETE",
          latestProbeAt: historicalProbeAt.toISOString(),
          latestDiscoveryAt: historicalDiscoveryAt.toISOString(),
          zeroExecutionEvidence: {
            latestProbe: {
              id: "probe-historical",
              courseId: "course-1",
              observedAt: historicalProbeAt,
            },
            latestDiscovery: {
              id: "discovery-historical",
              courseId: "course-1",
              createdAt: historicalDiscoveryAt,
            },
            latestProbeTimestampRowCount: 1,
            latestDiscoveryTimestampRowCount: 1,
            monitoringEvents,
            batchIncidents,
            playbookAssessment: {
              valid: true,
              version: 1,
              cycle: 4,
              conclusion: "INCOMPLETE",
              completedStages: [],
              nextStage: "OFFICIAL_IDENTITY",
              invalidReason: null,
            },
          },
        },
        capturedAt,
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: campaignAudit.membershipDigest,
        currentRuntimeVersion: "release-current",
      });
    expect(assessment).not.toBeNull();
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 4,
      revision: 12,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      attemptCount: 8,
      lastAttemptAt: attemptedAt,
      confirmedAt: admittedAt,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents,
      batchIncidents,
      course: {
        ...providerCourse,
        probes: [
          {
            id: "probe-historical",
            courseId: "course-1",
            observedAt: historicalProbeAt,
          },
        ],
        automationDiscoveries: [
          {
            id: "discovery-historical",
            courseId: "course-1",
            createdAt: historicalDiscoveryAt,
          },
        ],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 4,
      expectedRevision: 12,
      expectedMonitoringRevision: 16,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      campaignCapturedAt: campaignAudit.capturedAt,
      admissionMode:
        "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY" as const,
      expectedSameCycleRecoveryHistoryDigest: assessment!.historyDigest,
      expectedPlaybookNextStage: "OFFICIAL_IDENTITY",
      expectedPlaybookCompletedStageCount: 0,
      currentRuntimeVersion: "release-current",
      capturedKind: "NEEDS_ADAPTER" as const,
      capturedProviderFamilyKey: "SOURCE_MISSING",
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: historicalProbeAt.toISOString(),
      expectedLatestDiscoveryAt: historicalDiscoveryAt.toISOString(),
      expectedLatestProbeId: "probe-historical",
      expectedLatestDiscoveryId: "discovery-historical",
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint: providerSnapshotFingerprint,
      expectedAttemptLedgerFingerprint: attemptLedgerFingerprint,
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: campaignAudit.membershipDigest,
      now: recoveredAt,
    };
    const campaignRun = {
      promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
      audit: campaignAudit,
    };
    transactionMocks.automationRun.findUnique.mockResolvedValue(campaignRun);
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    const historicalProbe = {
      id: "probe-historical",
      courseId: "course-1",
      observedAt: historicalProbeAt,
    };
    const historicalDiscovery = {
      id: "discovery-historical",
      courseId: "course-1",
      createdAt: historicalDiscoveryAt,
    };
    transactionMocks.courseProbe.findFirst.mockResolvedValue(historicalProbe);
    transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
      historicalDiscovery,
    );

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 4 });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    for (const preserved of [
      "cycle",
      "attemptLedger",
      "attemptCount",
      "confirmedAt",
      "lastAttemptAt",
    ]) {
      expect(update.data).not.toHaveProperty(preserved);
    }
    expect(transactionMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-stale",
          releaseSha: null,
          deployedAt: null,
          recheckDispatchedAt: null,
          updatedAt: parkedAt,
        }),
        data: {
          revision: { increment: 0 },
          updatedAt: parkedAt,
        },
      }),
    );
    expect(
      transactionMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-stale",
          preProbeId: "probe-historical",
          postProbeId: null,
          verifiedAt: null,
        }),
      }),
    );

    const [probeLockQuery] = transactionMocks.$queryRaw.mock.calls[0] as [
      { strings: readonly string[]; values: unknown[] },
    ];
    expect(probeLockQuery.strings.join("")).toContain('FROM "CourseProbe"');
    expect(probeLockQuery.strings.join("")).toContain("FOR UPDATE");
    expect(probeLockQuery.values).toEqual([
      historicalProbe.id,
      historicalProbe.courseId,
      historicalProbeAt,
    ]);
    const discoveryLock = transactionMocks.$queryRaw.mock.calls.find(
      ([query]) =>
        (query as { strings?: readonly string[] }).strings
          ?.join("")
          .includes('FROM "CourseAutomationDiscovery"'),
    );
    expect(discoveryLock?.[0].values).toEqual([
      historicalDiscovery.id,
      historicalDiscovery.courseId,
      historicalDiscoveryAt,
    ]);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            action: "parked_cohort_requestless_stale_ownership_recovery",
            admissionMode: "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY",
            abandonedBaseRuntime: "release-old",
            recoveryRuntimeVersion: "release-current",
            requestCount: 0,
            releaseEvidenceAbsent: true,
            executionEvidenceAbsent: true,
            preservesAttemptLedger: true,
            preservesAttemptCounts: true,
            preservesAttemptTimestamps: true,
            preservesImmutableCampaignAudit: true,
            campaign: {
              kind: "PARKED_COHORT",
              runId: "campaign-run-1",
              membershipDigest: campaignAudit.membershipDigest,
              cycle: 4,
            },
          }),
        }),
      }),
    );

    const raceControls = [
      () =>
        transactionMocks.automationRun.updateMany.mockResolvedValueOnce({
          count: 0,
        }),
      () =>
        transactionMocks.courseSupportBatch.updateMany.mockResolvedValueOnce({
          count: 0,
        }),
      () =>
        transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValueOnce(
          { count: 0 },
        ),
      () =>
        transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValueOnce(
          {
            id: "unexpected-entry",
          },
        ),
      () =>
        transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
          {
            id: "late-request",
          },
        ),
      () =>
        transactionMocks.courseProbe.findFirst.mockResolvedValueOnce({
          ...historicalProbe,
          id: "probe-new",
          observedAt: new Date("2026-08-20T12:45:00.000Z"),
        }),
      () =>
        transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValueOnce(
          {
            ...historicalDiscovery,
            id: "discovery-newer",
            createdAt: new Date("2026-08-20T12:45:00.000Z"),
          },
        ),
      () =>
        transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValueOnce(
          {
            ...historicalDiscovery,
            id: "discovery-same-time-substitute",
          },
        ),
      () =>
        transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValueOnce(
          null,
        ),
      () =>
        transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValueOnce(
          { ...historicalDiscovery, courseId: "course-other" },
        ),
      () =>
        transactionMocks.$queryRaw
          .mockResolvedValueOnce([historicalProbe])
          .mockResolvedValueOnce([
            historicalDiscovery,
            {
              ...historicalDiscovery,
              id: "discovery-same-time-sibling",
            },
          ]),
      () => transactionMocks.$queryRaw.mockResolvedValueOnce([]),
    ];
    for (const arrangeRace of raceControls) {
      vi.clearAllMocks();
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
        baseIncident,
      );
      transactionMocks.automationRun.findUnique.mockResolvedValue(campaignRun);
      transactionMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
      transactionMocks.courseSupportBatch.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
        count: 1,
      });
      transactionMocks.courseSupportBatchIncident.findFirst.mockResolvedValue(
        null,
      );
      transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
      transactionMocks.courseProbe.findFirst.mockResolvedValue(historicalProbe);
      transactionMocks.courseAutomationDiscovery.findFirst.mockResolvedValue(
        historicalDiscovery,
      );
      transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
        null,
      );
      arrangeRace();
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    }

    vi.clearAllMocks();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    transactionMocks.automationRun.findUnique.mockResolvedValue({
      ...campaignRun,
      status: "COMPLETED",
      completedAt: recoveredAt,
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("retries exact requestless operator material-change orchestration without resetting its cycle", async () => {
    prismaMocks.$transaction.mockReset();
    const recoveredAt = new Date("2026-08-20T13:00:00.000Z");
    const operatorAt = new Date("2026-08-20T12:10:00.000Z");
    const handoffAt = new Date("2026-08-20T12:20:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const providerCourse = {
      timeZone: "America/New_York",
      website: "https://official.example",
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourse);
    const batchIncidents = [1, 2].map((attemptsCompleted) => ({
      id: `batch-orchestration-${attemptsCompleted}`,
      cycle: 5,
      result: attemptsCompleted === 1 ? "RETRY_SCHEDULED" : "NEEDS_HUMAN",
      batch: {
        baseSha: "release-old",
        releaseSha: "release-old",
        completedAt: new Date(`2026-08-20T12:2${attemptsCompleted}:00.000Z`),
        summary: {
          closeout: {
            remediationAttempts: [
              {
                courseRef,
                runtimeVersion: "release-old",
                consumed: false,
                countsTowardOperationalNoProgress: false,
                executionEvidence: {
                  deploymentRecorded: false,
                  postProbeRecorded: false,
                  providerAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                  providerExecutionStarted: false,
                },
                operationalRetry: {
                  attemptsCompleted,
                  exhausted: attemptsCompleted > 1,
                  reason:
                    attemptsCompleted > 1
                      ? "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
                      : "OPERATIONAL_RETRY_AVAILABLE",
                },
              },
            ],
          },
        },
      },
      verificationRequests: [],
    }));
    const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 5,
      entries: batchIncidents,
      requireOrchestrationOnly: true,
    });
    expect(history).not.toBeNull();
    const baseIncident = {
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 5,
      revision: 12,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: { version: 1, events: [] },
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          source: "RECOVERY_CRON",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: parkedAt,
          audit: {
            cycle: 5,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
            playbookExhausted: false,
            operationalRetryBudgetExhausted: true,
          },
        },
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "OPERATOR_CLI",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: operatorAt,
          audit: {
            reason: "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED",
            priorCycle: 3,
            cycle: 4,
            priorProviderFamilyKey: "SOURCE_MISSING",
            providerFamilyKey: "SOURCE_MISSING",
            changedFields: ["website"],
            evidenceFingerprint: providerSnapshotFingerprint,
            customerDataIncluded: false,
          },
        },
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: handoffAt,
          audit: {
            providerFamilyHandoff: true,
            priorCycle: 4,
            cycle: 5,
            claimedProviderSnapshotFingerprint: providerSnapshotFingerprint,
            observedProviderSnapshotFingerprint: providerSnapshotFingerprint,
            priorProviderFamilyKey: "SOURCE_MISSING",
            providerFamilyKey: "SOURCE_MISSING",
            priorFailureFingerprint: "SOURCE:MISSING",
            failureFingerprint: "SOURCE:MISSING",
            customerDataIncluded: false,
          },
        },
      ],
      batchIncidents,
      course: {
        ...providerCourse,
        probes: [],
        automationDiscoveries: [],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 16,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    };
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 5,
      expectedRevision: 12,
      expectedMonitoringRevision: 16,
      capturedRevision: 5,
      capturedMonitoringRevision: 9,
      capturedCycle: 3,
      campaignCapturedAt: "2026-08-20T12:00:00.000Z",
      admissionMode: "CURRENT_CYCLE_ORCHESTRATION_RECOVERY" as const,
      expectedSameCycleRecoveryHistoryDigest: history!.historyDigest,
      expectedPlaybookNextStage: "OFFICIAL_IDENTITY",
      expectedPlaybookCompletedStageCount: 0,
      currentRuntimeVersion: "release-current",
      capturedKind: "NEEDS_ADAPTER" as const,
      capturedProviderFamilyKey: "SOURCE_MISSING",
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: null,
      expectedLatestDiscoveryAt: null,
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint: providerSnapshotFingerprint,
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint({
          version: 1,
          events: [],
        }),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: "a".repeat(64),
      now: recoveredAt,
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toMatchObject({ admitted: true, cycle: 5 });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      nextAttemptAt: recoveredAt,
    });
    expect(update.data).not.toHaveProperty("cycle");
    expect(update.data).not.toHaveProperty("attemptCount");
    expect(update.data).not.toHaveProperty("attemptLedger");
    expect(update.data).not.toHaveProperty("confirmedAt");
    expect(
      transactionMocks.courseSupportVerificationRequest.findFirst,
    ).toHaveBeenCalledTimes(2);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            action: "parked_cohort_current_cycle_orchestration_recovery",
            admissionMode: "CURRENT_CYCLE_ORCHESTRATION_RECOVERY",
            preservesOperatorEvidence: true,
          }),
        }),
      }),
    );

    transactionMocks.courseSupportIncident.updateMany.mockClear();
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...baseIncident,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: recoveredAt,
          audit: {
            action: "parked_cohort_current_cycle_orchestration_recovery",
            campaignRunId: "campaign-run-1",
            cycle: 5,
          },
        },
        ...baseIncident.monitoringEvents,
      ],
    });
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();

    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(
      baseIncident,
    );
    transactionMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
      {
        id: "late-request",
      },
    );
    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        input,
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("fails campaign admission closed when captured evidence changed", async () => {
    prismaMocks.$transaction.mockReset();
    const escalatedAt = new Date("2026-08-19T12:00:00.000Z");
    const providerCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 3,
      revision: 7,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: escalatedAt,
          audit: {
            cycle: 3,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
          },
        },
      ],
      course: {
        ...providerCourse,
        probes: [{ observedAt: new Date("2026-08-20T13:00:00.000Z") }],
        automationDiscoveries: [],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 11,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    });

    await expect(
      reopenParkedCourseForResponderCampaignInTransaction(
        transactionMocks as never,
        {
          courseId: "course-1",
          incidentId: "incident-campaign",
          expectedCycle: 3,
          expectedRevision: 7,
          expectedMonitoringRevision: 11,
          capturedRevision: 7,
          capturedMonitoringRevision: 11,
          expectedKind: "NEEDS_ADAPTER",
          expectedFailureClass: "MISSING_SOURCE",
          expectedLatestProbeAt: "2026-08-19T13:00:00.000Z",
          expectedLatestDiscoveryAt: null,
          expectedProviderFamilyKey: "SOURCE_MISSING",
          expectedFailureFingerprint: "SOURCE:MISSING",
          expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
          expectedProviderSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(providerCourse),
          expectedAttemptLedgerFingerprint:
            createParkedCourseCampaignAttemptLedgerFingerprint(null),
          expectedPlaybookConclusion: "INCOMPLETE",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: "a".repeat(64),
        },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("fails campaign admission closed on provider, ledger, or decision changes", async () => {
    prismaMocks.$transaction.mockReset();
    const escalatedAt = new Date("2026-08-19T12:00:00.000Z");
    const latestProbeAt = new Date("2026-08-19T13:00:00.000Z");
    const latestDiscoveryAt = new Date("2026-08-19T14:00:00.000Z");
    const capturedProviderCourse = {
      timeZone: "America/New_York",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN" as const,
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN" as const,
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "UNKNOWN" as const,
      automationReason: "NONE" as const,
      monitoringMode: "STANDARD" as const,
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
    };
    const makeIncident = () => ({
      id: "incident-campaign",
      courseId: "course-1",
      cycle: 3,
      revision: 9,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      activeRealSearchCount: 0,
      activeBatchId: null,
      nextAttemptAt: null,
      escalatedAt,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      monitoringEvents: [
        {
          incidentId: "incident-campaign",
          eventType: "HUMAN_REVIEW_REQUESTED",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: escalatedAt,
          audit: {
            cycle: 3,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
          },
        },
      ],
      course: {
        ...capturedProviderCourse,
        probes: [{ observedAt: latestProbeAt }],
        automationDiscoveries: [{ createdAt: latestDiscoveryAt }],
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 13,
          failureFingerprint: "SOURCE:MISSING",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    });
    const input = {
      courseId: "course-1",
      incidentId: "incident-campaign",
      expectedCycle: 3,
      expectedRevision: 9,
      expectedMonitoringRevision: 13,
      capturedRevision: 7,
      capturedMonitoringRevision: 11,
      expectedKind: "NEEDS_ADAPTER" as const,
      expectedFailureClass: "MISSING_SOURCE" as const,
      expectedLatestProbeAt: latestProbeAt.toISOString(),
      expectedLatestDiscoveryAt: latestDiscoveryAt.toISOString(),
      expectedProviderFamilyKey: "SOURCE_MISSING",
      expectedFailureFingerprint: "SOURCE:MISSING",
      expectedMonitoringFailureFingerprint: "SOURCE:MISSING",
      expectedProviderSnapshotFingerprint:
        buildCourseSupportProviderSnapshotFingerprint(capturedProviderCourse),
      expectedAttemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      expectedPlaybookConclusion: "INCOMPLETE",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: "a".repeat(64),
    };

    for (const changed of [
      {
        incident: {
          ...makeIncident(),
          course: {
            ...makeIncident().course,
            website: "https://changed.example",
          },
        },
      },
      {
        incident: {
          ...makeIncident(),
          course: {
            ...makeIncident().course,
            monitoringStatus: {
              ...makeIncident().course.monitoringStatus,
              failureFingerprint: "SOURCE:CHANGED",
            },
          },
        },
      },
      {
        incident: {
          ...makeIncident(),
          attemptLedger: { version: 1, events: [] },
        },
      },
      {
        incident: {
          ...makeIncident(),
          decisionAt: new Date("2026-08-20T11:00:00.000Z"),
        },
      },
    ]) {
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(
        changed.incident,
      );
      await expect(
        reopenParkedCourseForResponderCampaignInTransaction(
          transactionMocks as never,
          input,
        ),
      ).resolves.toEqual({ admitted: false });
    }

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("defers an active campaign member and reopens the same non-campaign endpoint without resetting playbook evidence", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const deadlineAt = new Date("2026-08-20T12:20:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const now = new Date("2026-08-20T13:00:00.000Z");
    const attemptLedger = {
      version: 1,
      events: [
        {
          sequence: 1,
          cycle: 4,
          stage: "OFFICIAL_IDENTITY",
          transition: "NOT_APPLICABLE",
          readPath: "OFFICIAL_IDENTITY",
          evidenceKind: "TOOLING",
          observedAt: "2026-08-20T12:05:00.000Z",
          failureFingerprint: "SOURCE:MISSING",
          runtimeVersion: "release-old",
          skipReason: "NO_PROVIDER_METADATA",
        },
      ],
    };
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-stalled",
      courseId: "course-1",
      cycle: 4,
      confirmedAt: new Date("2026-08-20T12:00:00.000Z"),
      revision: 9,
      status: "NEEDS_HUMAN",
      attemptLedger,
      kind: "NEEDS_ADAPTER",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: parkedAt,
      escalationDeadlineAt: deadlineAt,
      activeRealSearchCount: 0,
      attemptCount: 6,
      activeBatchId: null,
      activeBatch: null,
      nextAttemptAt: null,
      nextReminderAt: parkedAt,
      resolution: null,
      resolvedAt: null,
      lastSeenAt: new Date("2026-08-20T12:25:00.000Z"),
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 13,
    });
    transactionMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "NONE",
    });
    transactionMocks.courseProbe.findFirst.mockResolvedValue(null);
    transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      incidentId: "incident-stalled",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 4,
        customerState: "NEEDS_HUMAN_REVIEW",
        parkedUntilMaterialChange: true,
        automationStalled: true,
        playbookExhausted: false,
        nextStage: "TYPED_ADAPTER",
        escalationDeadlineAt: deadlineAt.toISOString(),
      },
    });
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);

    transactionMocks.automationRun.findMany.mockResolvedValueOnce([{
      audit: createParkedCourseCampaignAudit({
        expectedCount: 1,
        capturedAt: new Date("2026-08-20T11:00:00.000Z"),
        members: [
          {
            courseId: "course-1",
            incidentId: "incident-stalled",
            cycle: 4,
            revision: 9,
            monitoringRevision: 13,
            monitoringFailureFingerprint: "SOURCE:MISSING",
            kind: "NEEDS_ADAPTER",
            providerFamilyKey: "SOURCE_MISSING",
            failureClass: "MISSING_SOURCE",
            failureFingerprint: "SOURCE:MISSING",
            providerSnapshotFingerprint: "a".repeat(64),
            attemptLedgerFingerprint: "b".repeat(64),
            playbookConclusion: "INCOMPLETE",
            latestProbeAt: null,
            latestDiscoveryAt: null,
          },
        ],
      }),
    }]);

    await expect(
      reconcileCourseMonitoringDeadline({
        courseId: "course-1",
        now,
        source: "RECOVERY_CRON",
      }),
    ).resolves.toEqual({
      outcome: "RETAINED_PARKED",
      incidentId: "incident-stalled",
      parkedUntilMaterialChange: true,
    });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();

    transactionMocks.automationRun.findMany.mockResolvedValueOnce([{
      audit: { schemaVersion: 999, campaignKind: "PARKED_COHORT" },
    }]);
    await expect(
      reconcileCourseMonitoringDeadline({
        courseId: "course-1",
        now,
        source: "RECOVERY_CRON",
      }),
    ).resolves.toEqual({
      outcome: "RETAINED_PARKED",
      incidentId: "incident-stalled",
      parkedUntilMaterialChange: true,
    });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();

    await expect(
      reconcileCourseMonitoringDeadline({
        courseId: "course-1",
        now,
        source: "RECOVERY_CRON",
      }),
    ).resolves.toEqual({ outcome: "RETRYING", incidentId: "incident-stalled" });
    const update =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      status: "AUTO_INVESTIGATING",
      humanReviewReason: null,
      nextAttemptAt: now,
    });
    expect(update.data.escalationDeadlineAt).toEqual(
      new Date("2026-08-20T13:30:00.000Z"),
    );
    expect(update.data).not.toHaveProperty("cycle");
    expect(update.data).not.toHaveProperty("attemptLedger");
    expect(update.data).not.toHaveProperty("attemptCount");
    expect(update.data).not.toHaveProperty("confirmedAt");
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            action: "resume_incomplete_automation_stalled_playbook",
            cycle: 4,
            nextStage: "TYPED_ADAPTER",
            preservesAttemptLedger: true,
            preservesAttemptCount: true,
            preservesOperatorEvidence: true,
          }),
        }),
      }),
    );

    transactionMocks.courseSupportIncident.updateMany.mockClear();
    transactionMocks.courseMonitoringStatus.updateMany.mockClear();
    transactionMocks.courseMonitoringEvent.create.mockClear();
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      id: "prior-recovery",
    });
    await expect(
      reconcileCourseMonitoringDeadline({
        courseId: "course-1",
        now,
        source: "RECOVERY_CRON",
      }),
    ).resolves.toEqual({
      outcome: "RETAINED_PARKED",
      incidentId: "incident-stalled",
    });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("retries a write conflict and serializes writes by course", async () => {
    await expect(
      recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        now: new Date("2026-07-27T15:45:00.000Z"),
      }),
    ).resolves.toMatchObject({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8,
    });

    expect(prismaMocks.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMocks.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "ReadCommitted",
        timeout: 15_000,
      }),
    );
    expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledWith(
      `WITH acquired AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
     )
     SELECT true AS locked FROM acquired`,
      "course-monitoring:course-1",
    );
  });

  it.each([
    {
      provenance: "original admission",
      action: "parked_cohort_admission",
    },
    {
      provenance: "descendant recovery",
      action: "parked_cohort_descendant_incomplete_playbook_recovery",
      zeroProgress: false,
    },
    {
      provenance: "zero-progress descendant recovery",
      action: "parked_cohort_descendant_incomplete_playbook_recovery",
      zeroProgress: true,
    },
    {
      provenance: "post-marker incomplete-playbook recovery",
      action: "parked_cohort_post_marker_incomplete_playbook_recovery",
      zeroProgress: false,
    },
    {
      provenance: "requestless stale-ownership recovery",
      action: "parked_cohort_requestless_stale_ownership_recovery",
      zeroProgress: false,
    },
    {
      provenance: "same-identity +2 incomplete-playbook recovery",
      action:
        "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
      zeroProgress: false,
    },
  ])(
    "closes an unclaimed automatic incident with $provenance campaign provenance",
    async ({ action, zeroProgress = false }) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const succeededAt = new Date("2026-07-27T15:45:00.000Z");
      const runtimeSha = "d".repeat(40);
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state: "AUTO_INVESTIGATING",
        consecutiveFailures: 1,
        failureFingerprint: "SOURCE:UNKNOWN",
        firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
        nextAutomaticAttemptAt: succeededAt,
        revalidationRequestedAt: null,
        revision: 3,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-1",
        cycle: 5,
        confirmedAt: new Date("2026-07-27T15:40:00.000Z"),
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        revision: 4,
      });
      transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
        occurredAt: new Date("2026-07-27T15:44:00.000Z"),
        audit: {
          action,
          ...(action ===
          "parked_cohort_post_marker_incomplete_playbook_recovery"
            ? {
                admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
                sameCycleRecoveryHistoryDigest: "b".repeat(64),
                priorRecoveryMarkerDigest: "c".repeat(64),
                priorRecoveryRuntimeVersion: "a".repeat(40),
                recoveryRuntimeVersion: "b".repeat(40),
                failedRuntimeVersions: ["a".repeat(40)],
                postMarkerHistoryDigest: "c".repeat(64),
                postMarkerBatchCount: 1,
                postMarkerRequestCount: 0,
                providerSnapshotFingerprint: "d".repeat(64),
                attemptLedgerFingerprint: "e".repeat(64),
                batchCount: 2,
                startedRequestCount: 1,
                playbookCompletedStageCount: 4,
                playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
                supersededEndpointId: "endpoint-post-marker",
                supersededEndpointAt: "2026-07-27T15:43:00.000Z",
                customerDataIncluded: false,
                preservesOperatorEvidence: true,
                sameCycleRecovery: true,
                oneShot: true,
                preservesAttemptLedger: true,
                preservesAttemptCounts: true,
                preservesAttemptTimestamps: true,
                preservesImmutableCampaignAudit: true,
                campaign: {
                  kind: "PARKED_COHORT",
                  runId: "campaign-run-1",
                  membershipDigest: "a".repeat(64),
                  cycle: 5,
                },
              }
            : action === "parked_cohort_descendant_incomplete_playbook_recovery"
              ? {
                  admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
                  descendantLineageDigest: "b".repeat(64),
                  descendantHandoffCount: 1,
                  sameCycleRecoveryHistoryDigest: "c".repeat(64),
                  providerSnapshotFingerprint: "d".repeat(64),
                  attemptLedgerFingerprint: "e".repeat(64),
                  batchCount: 1,
                  startedRequestCount: zeroProgress ? 0 : null,
                  playbookCompletedStageCount: zeroProgress ? 0 : 5,
                  playbookNextStage: zeroProgress
                    ? "OFFICIAL_IDENTITY"
                    : "BROWSER_ADAPTER_RETRY",
                  ...(zeroProgress
                    ? {
                        requestCount: 0,
                        zeroProgressOrchestrationOnly: true,
                        releaseEvidenceAbsent: true,
                        executionEvidenceAbsent: true,
                      }
                    : {}),
                  customerDataIncluded: false,
                  preservesOperatorEvidence: true,
                  sameCycleRecovery: true,
                  oneShot: true,
                  preservesAttemptLedger: true,
                  preservesAttemptCounts: true,
                  preservesAttemptTimestamps: true,
                  preservesImmutableCampaignAudit: true,
                  campaign: {
                    kind: "PARKED_COHORT",
                    runId: "campaign-run-1",
                    membershipDigest: "a".repeat(64),
                    cycle: 5,
                  },
                }
              : action === "parked_cohort_requestless_stale_ownership_recovery"
                ? {
                    admissionMode:
                      "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY",
                    sameCycleRecoveryHistoryDigest: "b".repeat(64),
                    abandonedBaseRuntime: "release-old",
                    recoveryRuntimeVersion: "release-current",
                    requestCount: 0,
                    releaseEvidenceAbsent: true,
                    executionEvidenceAbsent: true,
                    sameCycleRecovery: true,
                    oneShot: true,
                    preservesAttemptLedger: true,
                    preservesAttemptCounts: true,
                    preservesAttemptTimestamps: true,
                    preservesImmutableCampaignAudit: true,
                  }
                : action ===
                    "parked_cohort_same_identity_material_change_incomplete_playbook_recovery"
                  ? {
                      admissionMode:
                        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
                      sameCycleRecoveryHistoryDigest: "b".repeat(64),
                      materialChangeLineageDigest: "c".repeat(64),
                      providerSnapshotFingerprint: "d".repeat(64),
                      attemptLedgerFingerprint: "e".repeat(64),
                      batchCount: 3,
                      startedRequestCount: 1,
                      playbookCompletedStageCount: 4,
                      playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
                      supersededEndpointId: "endpoint-material-change",
                      supersededEndpointAt: "2026-07-27T15:43:00.000Z",
                      customerDataIncluded: false,
                      preservesOperatorEvidence: true,
                      sameCycleRecovery: true,
                      oneShot: true,
                      preservesAttemptLedger: true,
                      preservesAttemptCounts: true,
                      preservesAttemptTimestamps: true,
                      preservesImmutableCampaignAudit: true,
                      campaign: {
                        kind: "PARKED_COHORT",
                        runId: "campaign-run-1",
                        membershipDigest: "a".repeat(64),
                        cycle: 5,
                      },
                    }
                  : {}),
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: "a".repeat(64),
          cycle: 5,
        },
      });

      await recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        runtimeVersion: runtimeSha,
        now: succeededAt,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "incident-1",
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          revision: 4,
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedAt: succeededAt,
          resolution: "MONITORING_RESTORED",
          nextAttemptAt: null,
          nextReminderAt: null,
        }),
      });
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          incidentId: "incident-1",
          eventType: "RECOVERED",
          deploymentSha: runtimeSha,
          runtimeVersion: runtimeSha,
          audit: {
            cycle: 5,
            confirmedAt: "2026-07-27T15:40:00.000Z",
            automatedFinal: true,
            campaign: {
              kind: "PARKED_COHORT",
              runId: "campaign-run-1",
              membershipDigest: "a".repeat(64),
              cycle: 5,
            },
            customerDataIncluded: false,
          },
        }),
      });
      expect(
        JSON.stringify(
          transactionMocks.courseMonitoringEvent.findFirst.mock.calls[0]?.[0],
        ),
      ).toContain("parked_cohort_descendant_incomplete_playbook_recovery");
    },
  );

  it("does not inherit campaign provenance from a partially shaped +2 recovery marker", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const succeededAt = new Date("2026-07-27T15:45:00.000Z");
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE:UNKNOWN",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: succeededAt,
      revalidationRequestedAt: null,
      revision: 3,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 5,
      confirmedAt: new Date("2026-07-27T15:40:00.000Z"),
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      revision: 4,
    });
    transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      occurredAt: new Date("2026-07-27T15:44:00.000Z"),
      audit: {
        action:
          "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
        admissionMode:
          "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: "a".repeat(64),
        cycle: 5,
        sameCycleRecoveryHistoryDigest: "b".repeat(64),
        materialChangeLineageDigest: "c".repeat(64),
        providerSnapshotFingerprint: "d".repeat(64),
        attemptLedgerFingerprint: "e".repeat(64),
        batchCount: 3,
        startedRequestCount: 0,
        playbookCompletedStageCount: 4,
        playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
        supersededEndpointAt: "2026-07-27T15:43:00.000Z",
        sameCycleRecovery: true,
        oneShot: true,
        preservesAttemptLedger: true,
        preservesAttemptCounts: true,
        preservesAttemptTimestamps: true,
        preservesImmutableCampaignAudit: true,
      },
    });

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      runtimeVersion: "d".repeat(40),
      now: succeededAt,
    });

    const recoveredEvent =
      transactionMocks.courseMonitoringEvent.create.mock.calls
        .map(([call]) => call.data)
        .find((data) => data.eventType === "RECOVERED");
    expect(recoveredEvent.audit).not.toHaveProperty("campaign");

    transactionMocks.courseMonitoringEvent.create.mockClear();
    transactionMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      occurredAt: new Date("2026-07-27T15:44:00.000Z"),
      audit: {
        action: "parked_cohort_descendant_incomplete_playbook_recovery",
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: "a".repeat(64),
        cycle: 5,
        descendantLineageDigest: "b".repeat(64),
        descendantHandoffCount: 1,
        sameCycleRecoveryHistoryDigest: "c".repeat(64),
        providerSnapshotFingerprint: "d".repeat(64),
        attemptLedgerFingerprint: "e".repeat(64),
        batchCount: 1,
        requestCount: 0,
        startedRequestCount: 0,
        playbookCompletedStageCount: 0,
        playbookNextStage: "OFFICIAL_IDENTITY",
        zeroProgressOrchestrationOnly: true,
        releaseEvidenceAbsent: true,
        executionEvidenceAbsent: true,
        customerDataIncluded: false,
        preservesOperatorEvidence: false,
        sameCycleRecovery: true,
        oneShot: true,
        preservesAttemptLedger: true,
        preservesAttemptCounts: true,
        preservesAttemptTimestamps: true,
        preservesImmutableCampaignAudit: true,
        campaign: {
          kind: "PARKED_COHORT",
          runId: "campaign-run-1",
          membershipDigest: "a".repeat(64),
          cycle: 5,
        },
      },
    });
    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      runtimeVersion: "d".repeat(40),
      now: new Date(succeededAt.getTime() + 1),
    });
    const malformedDescendantRecoveredEvent =
      transactionMocks.courseMonitoringEvent.create.mock.calls
        .map(([call]) => call.data)
        .find((data) => data.eventType === "RECOVERED");
    expect(malformedDescendantRecoveredEvent.audit).not.toHaveProperty(
      "campaign",
    );
  });

  it("closes an unclaimed parked human incident when fresh monitoring succeeds", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const succeededAt = new Date("2026-07-27T15:46:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-parked",
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      revision: 9,
    });

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "MATCH_FOUND",
      now: succeededAt,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "incident-parked",
        status: "NEEDS_HUMAN",
        activeBatchId: null,
        revision: 9,
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolvedAt: succeededAt,
        resolution: "MONITORING_RESTORED",
        nextAction: null,
        nextAttemptAt: null,
        nextReminderAt: null,
      }),
    });
  });

  it("re-reads and resolves an unclaimed incident after a stale success CAS", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const succeededAt = new Date("2026-07-27T15:47:00.000Z");
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-raced",
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        revision: 4,
      })
      .mockResolvedValueOnce({
        id: "incident-raced",
        status: "NEEDS_HUMAN",
        activeBatchId: null,
        revision: 5,
      });
    transactionMocks.courseSupportIncident.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      now: succeededAt,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenNthCalledWith(2, {
      where: {
        id: "incident-raced",
        status: "NEEDS_HUMAN",
        activeBatchId: null,
        revision: 5,
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "MONITORING_RESTORED",
        resolvedAt: succeededAt,
      }),
    });
  });

  it.each([
    "TECHNICAL_LIMITATION_CLASSIFIED",
    "SOURCE_UNVERIFIED",
    "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
  ] as const)(
    "supersedes a revalidated %s final after fresh monitoring succeeds",
    async (resolution) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const succeededAt = new Date("2026-07-27T15:47:30.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state: "REVALIDATING_FINAL",
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: succeededAt,
        revalidationRequestedAt: succeededAt,
        revision: 8,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-revalidating",
        status: "RESOLVED",
        resolution,
        activeBatchId: null,
        revision: 5,
      });

      await recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        now: succeededAt,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "incident-revalidating",
          status: "RESOLVED",
          resolution,
          activeBatchId: null,
          revision: 5,
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedAt: succeededAt,
          resolution: "MONITORING_RESTORED",
          nextAction: null,
          nextAttemptAt: null,
          nextReminderAt: null,
        }),
      });
    },
  );

  it.each([
    ["DIRECT_BOOKING_CLASSIFIED", "FINAL_MANUAL", "FINAL_MANUAL"],
    ["IDENTITY_CLASSIFIED", "FINAL_IDENTITY", "FINAL_IDENTITY"],
    ["DIRECT_BOOKING_CLASSIFIED", "REVALIDATING_FINAL", "FINAL_MANUAL"],
    ["IDENTITY_CLASSIFIED", "REVALIDATING_FINAL", "FINAL_IDENTITY"],
  ] as const)(
    "preserves a factual %s final from %s after a success report",
    async (resolution, currentState, expectedState) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const succeededAt = new Date("2026-07-27T15:47:45.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state: currentState,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: succeededAt,
        revalidationRequestedAt: succeededAt,
        revision: 8,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-factual-final",
        status: "RESOLVED",
        resolution,
        activeBatchId: null,
        revision: 5,
      });

      await recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "MATCH_FOUND",
        now: succeededAt,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).toHaveBeenCalledWith({
        where: { courseId: "course-1", revision: 8 },
        data: {
          state: expectedState,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          ...(currentState !== expectedState
            ? { stateChangedAt: succeededAt }
            : {}),
          revision: { increment: 1 },
        },
      });
      expect(
        transactionMocks.courseMonitoringEvent.create.mock.calls.some(
          ([call]) => call.data.eventType === "RECOVERED",
        ),
      ).toBe(false);
      expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["FINAL_MANUAL", "FINAL_IDENTITY"] as const)(
    "does not let a stale success override %s while a responder still owns the incident",
    async (finalState) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const succeededAt = new Date("2026-07-27T15:47:47.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state: finalState,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-owned-final",
        status: "AUTO_INVESTIGATING",
        resolution: null,
        activeBatchId: "batch-1",
        revision: 5,
      });

      await recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        now: succeededAt,
      });

      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).toHaveBeenCalledWith({
        where: { courseId: "course-1", revision: 8 },
        data: {
          state: finalState,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: { increment: 1 },
        },
      });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create.mock.calls.some(
          ([call]) => call.data.eventType === "RECOVERED",
        ),
      ).toBe(false);
      expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    },
  );

  it("preserves a legacy factual final even when no support incident exists", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const succeededAt = new Date("2026-07-27T15:47:48.000Z");
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      failureFingerprint: null,
      firstDegradedAt: null,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(null);

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      now: succeededAt,
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: { courseId: "course-1", revision: 8 },
        data: {
          state: "FINAL_MANUAL",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: { increment: 1 },
        },
      },
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        incidentId: null,
        eventType: "CHECK_SUCCEEDED",
        toState: "FINAL_MANUAL",
      }),
    });
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a factual final that wins a revalidation success CAS race", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const succeededAt = new Date("2026-07-27T15:47:50.000Z");
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "REVALIDATING_FINAL",
      consecutiveFailures: 0,
      failureFingerprint: null,
      firstDegradedAt: null,
      nextAutomaticAttemptAt: succeededAt,
      revalidationRequestedAt: succeededAt,
      revision: 8,
    });
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-raced-final",
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        activeBatchId: null,
        revision: 5,
      })
      .mockResolvedValueOnce({
        id: "incident-raced-final",
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        activeBatchId: null,
        revision: 6,
      });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      now: succeededAt,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledTimes(1);
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-raced-final",
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        revision: 5,
      }),
      data: expect.objectContaining({ resolution: "MONITORING_RESTORED" }),
    });
    expect(
      transactionMocks.courseMonitoringStatus.update,
    ).toHaveBeenNthCalledWith(2, {
      where: { courseId: "course-1", revision: 8 },
      data: {
        state: "FINAL_IDENTITY",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        stateChangedAt: succeededAt,
        revision: { increment: 1 },
      },
    });
    expect(
      transactionMocks.courseMonitoringEvent.create.mock.calls.some(
        ([call]) => call.data.eventType === "RECOVERED",
      ),
    ).toBe(false);
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("serializes success ahead of parking and preserves the authoritative recovery", async () => {
    prismaMocks.$transaction.mockReset();
    const startedAt = new Date("2026-07-27T15:40:00.000Z");
    const succeededAt = new Date("2026-07-27T15:47:00.000Z");
    const parkingAt = new Date("2026-07-27T15:48:00.000Z");
    let monitoringStatus = {
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      stateChangedAt: startedAt,
      lastSuccessfulAt: null as Date | null,
      consecutiveFailures: 2,
      failureFingerprint: "UNSUPPORTED_FAMILY:fixture" as string | null,
      firstDegradedAt: startedAt as Date | null,
      nextAutomaticAttemptAt: parkingAt as Date | null,
      revalidationRequestedAt: null as Date | null,
      revision: 7,
    };
    let incident = {
      id: "incident-race",
      courseId: "course-1",
      cycle: 2,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null as string | null,
      resolution: null as string | null,
      resolvedAt: null as Date | null,
      revision: 4,
      updatedAt: startedAt,
      failureFingerprint: "UNSUPPORTED_FAMILY:fixture",
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null as Date | null,
      escalatedAt: null as Date | null,
    };
    const createdEvents: Array<Record<string, unknown>> = [];
    let releaseSuccess!: () => void;
    let markSuccessPaused!: () => void;
    const successPaused = new Promise<void>((resolve) => {
      markSuccessPaused = resolve;
    });
    const resumeSuccess = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    let lockTail = Promise.resolve();

    prismaMocks.$transaction.mockImplementation(async (worker) => {
      let releaseLock: (() => void) | undefined;
      let acquired = false;
      const transaction = {
        ...transactionMocks,
        $queryRawUnsafe: vi.fn(async (...args: unknown[]) => {
          const prior = lockTail;
          lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await prior;
          acquired = true;
          await transactionMocks.$queryRawUnsafe(...args);
          return [];
        }),
      };
      try {
        return await worker(transaction);
      } finally {
        if (acquired) {
          releaseLock?.();
        }
      }
    });
    transactionMocks.courseMonitoringStatus.upsert.mockImplementation(
      async () => ({
        ...monitoringStatus,
      }),
    );
    transactionMocks.courseMonitoringStatus.findUnique.mockImplementation(
      async () => ({
        ...monitoringStatus,
      }),
    );
    transactionMocks.courseMonitoringStatus.update.mockImplementation(
      async () => {
        markSuccessPaused();
        await resumeSuccess;
        monitoringStatus = {
          ...monitoringStatus,
          state: "HEALTHY",
          stateChangedAt: succeededAt,
          lastSuccessfulAt: succeededAt,
          consecutiveFailures: 0,
          failureFingerprint: null,
          firstDegradedAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: monitoringStatus.revision + 1,
        };
        return { ...monitoringStatus };
      },
    );
    transactionMocks.courseMonitoringStatus.updateMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => ({
        count:
          where.courseId === monitoringStatus.courseId &&
          where.state === monitoringStatus.state &&
          where.revision === monitoringStatus.revision
            ? 1
            : 0,
      }),
    );
    transactionMocks.courseSupportIncident.findUnique.mockImplementation(
      async () => ({
        ...incident,
      }),
    );
    transactionMocks.courseSupportIncident.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches =
          where.id === incident.id &&
          where.status === incident.status &&
          where.revision === incident.revision &&
          where.activeBatchId === incident.activeBatchId;
        if (!matches) {
          return { count: 0 };
        }
        if (data.status === "RESOLVED") {
          incident = {
            ...incident,
            status: "RESOLVED",
            resolution: "MONITORING_RESTORED",
            resolvedAt: succeededAt,
            revision: incident.revision + 1,
            updatedAt: succeededAt,
          };
        }
        return { count: 1 };
      },
    );
    transactionMocks.courseMonitoringEvent.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        createdEvents.push(data);
        return { id: `event-${createdEvents.length}`, ...data };
      },
    );

    const candidate = {
      id: incident.id,
      courseId: incident.courseId,
      cycle: incident.cycle,
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "fixture",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: incident.failureFingerprint,
      humanReviewReason: null,
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      escalationDeadlineAt: parkingAt,
      escalatedAt: null,
      endpointHumanReviewProven: false,
      firstSeenAt: startedAt,
      lastSeenAt: startedAt,
      lastAttemptAt: startedAt,
      nextAttemptAt: parkingAt,
      attemptCount: 1,
      updatedAt: startedAt,
      remediationRoute: {
        workMode: "WAIT_FOR_MATERIAL_CHANGE",
        resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
        allowUnchangedRuntime: false,
        requiresImplementationPath: false,
        retryBudget: null,
        reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
      },
    } as unknown as CourseSupportCandidate;

    const success = recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      now: succeededAt,
    });
    await successPaused;
    const parking = parkCourseSupportCandidatesForMaterialChange(
      [candidate],
      parkingAt,
    );
    await Promise.resolve();
    expect(
      transactionMocks.courseSupportIncident.findUnique,
    ).toHaveBeenCalledTimes(1);
    releaseSuccess();

    await expect(success).resolves.toMatchObject({ state: "HEALTHY" });
    await expect(parking).resolves.toBe(0);
    expect(monitoringStatus).toMatchObject({
      state: "HEALTHY",
      lastSuccessfulAt: succeededAt,
    });
    expect(incident).toMatchObject({
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: succeededAt,
    });
    expect(createdEvents).not.toContainEqual(
      expect.objectContaining({
        audit: expect.objectContaining({ parkedUntilMaterialChange: true }),
      }),
    );
  });

  it.each([
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_IDENTITY", "IDENTITY_CLASSIFIED"],
  ] as const)(
    "retains an authoritative %s incident when a stale failure reports material change",
    async (state, resolution) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const now = new Date("2026-07-27T15:49:00.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });
      transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
        courseId: "course-1",
        state,
        revision: 9,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-final",
        cycle: 3,
        status: "RESOLVED",
        resolution,
        failureFingerprint: "prior-fingerprint",
        humanReviewReason: null,
        escalatedAt: null,
        escalationDeadlineAt: null,
        activeBatchId: null,
        nextAttemptAt: null,
        revision: 6,
        activeRealSearchCount: 1,
      });

      const result = await recordCourseMonitoringFailure({
        courseId: "course-1",
        outcome: "FETCH_FAILED",
        failureFingerprint: "new-stale-report",
        readPath: "workflow-reader",
        activeRealSearchCount: 1,
        materialEvidenceChanged: true,
        now,
      });

      expect(result).toMatchObject({
        retainedHumanFinal: true,
        nextAttemptAt: null,
        status: { state },
      });
      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
          }),
        }),
      );
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["FINAL_MANUAL", "FINAL_IDENTITY"] as const)(
    "retains the authoritative %s monitoring state while a responder owns the unresolved incident",
    async (state) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const now = new Date("2026-07-27T15:49:05.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });
      transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
        courseId: "course-1",
        state,
        revision: 9,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-owned-final",
        cycle: 3,
        status: "AUTO_INVESTIGATING",
        resolution: null,
        failureFingerprint: "prior-fingerprint",
        humanReviewReason: null,
        escalatedAt: null,
        escalationDeadlineAt: null,
        activeBatchId: "batch-1",
        nextAttemptAt: null,
        revision: 6,
        activeRealSearchCount: 1,
      });

      const result = await recordCourseMonitoringFailure({
        courseId: "course-1",
        outcome: "FETCH_FAILED",
        failureFingerprint: "new-stale-report",
        readPath: "workflow-reader",
        activeRealSearchCount: 1,
        materialEvidenceChanged: true,
        now,
      });

      expect(result).toMatchObject({
        retainedHumanFinal: true,
        nextAttemptAt: null,
        status: { state },
      });
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    },
  );

  it("does not steal responder ownership while recording success", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-1",
      revision: 4,
    });

    await recordCourseMonitoringSuccess({
      courseId: "course-1",
      outcome: "NO_MATCH",
      now: new Date("2026-07-27T15:45:00.000Z"),
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["manual", "FINAL_MANUAL", "MANUAL_DIRECT"],
    ["identity", "FINAL_IDENTITY", "IDENTITY_FINAL"],
  ] as const)(
    "does not rewrite or append a transition for an unchanged clean %s final",
    async (_label, state, outcome) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });

      await expect(
        recordCourseMonitoringFinalClassification({
          courseId: "course-1",
          state,
          outcome,
          message: "Official evidence confirms the final classification.",
          now: new Date("2026-07-27T15:50:00.000Z"),
        }),
      ).resolves.toMatchObject({
        state,
        revision: 8,
      });

      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["FINAL_MANUAL", "MANUAL_DIRECT", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_IDENTITY", "IDENTITY_FINAL", "IDENTITY_CLASSIFIED"],
  ] as const)(
    "atomically reconciles an unclaimed incident when %s classification already persisted",
    async (state, outcome, resolution) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const classifiedAt = new Date("2026-07-27T15:50:00.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-1",
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        revision: 4,
      });

      await recordCourseMonitoringFinalClassification({
        courseId: "course-1",
        state,
        outcome,
        message: "Official evidence confirms the factual final state.",
        now: classifiedAt,
      });

      expect(
        transactionMocks.courseMonitoringStatus.update,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "incident-1",
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          revision: 4,
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedAt: classifiedAt,
          resolution,
          nextAttemptAt: null,
          nextReminderAt: null,
        }),
      });
    },
  );

  it.each([
    [
      "TECHNICAL_LIMITATION_CLASSIFIED",
      "FINAL_MANUAL",
      "MANUAL_DIRECT",
      "DIRECT_BOOKING_CLASSIFIED",
    ],
    [
      "SOURCE_UNVERIFIED",
      "FINAL_IDENTITY",
      "IDENTITY_FINAL",
      "IDENTITY_CLASSIFIED",
    ],
    [
      "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
      "FINAL_MANUAL",
      "MANUAL_DIRECT",
      "DIRECT_BOOKING_CLASSIFIED",
    ],
  ] as const)(
    "upgrades a resolved %s incident when fresh factual evidence proves %s",
    async (priorResolution, state, outcome, resolution) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      const classifiedAt = new Date("2026-07-27T15:50:01.000Z");
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state: "FINAL_TECHNICAL",
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8,
      });
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-technical-final",
        status: "RESOLVED",
        resolution: priorResolution,
        activeBatchId: null,
        revision: 4,
      });

      await recordCourseMonitoringFinalClassification({
        courseId: "course-1",
        state,
        outcome,
        message: "Fresh official evidence confirms the factual final state.",
        now: classifiedAt,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "incident-technical-final",
          status: "RESOLVED",
          activeBatchId: null,
          revision: 4,
          resolution: priorResolution,
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedAt: classifiedAt,
          resolution,
          nextAttemptAt: null,
          nextReminderAt: null,
        }),
      });
    },
  );

  it("retries the incident CAS when a concurrent unowned technical update wins first", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const classifiedAt = new Date("2026-07-27T15:50:02.000Z");
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_TECHNICAL",
      consecutiveFailures: 0,
      failureFingerprint: null,
      firstDegradedAt: null,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-technical-final",
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        activeBatchId: null,
        revision: 4,
      })
      .mockResolvedValueOnce({
        id: "incident-technical-final",
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        activeBatchId: null,
        revision: 5,
      });
    transactionMocks.courseSupportIncident.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_IDENTITY",
      outcome: "IDENTITY_FINAL",
      message: "Fresh official evidence confirms the identity final.",
      now: classifiedAt,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenNthCalledWith(2, {
      where: {
        id: "incident-technical-final",
        status: "RESOLVED",
        activeBatchId: null,
        revision: 5,
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
      },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        resolvedAt: classifiedAt,
      }),
    });
  });

  it("preserves active responder ownership while recording a factual final", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "PHONE_ONLY:CONFIRMED",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-1",
      revision: 4,
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      now: new Date("2026-07-27T15:50:00.000Z"),
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("repairs a dirty final snapshot without recording a same-state transition", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 2,
      failureFingerprint: "PHONE_ONLY:STALE",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 7,
      confirmedAt: new Date("2026-07-27T15:40:00.000Z"),
      status: "RESOLVED",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      decisionAt: null,
      activeBatchId: null,
      revision: 4,
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      now: new Date("2026-07-27T15:50:00.000Z"),
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      {
        where: {
          courseId: "course-1",
          revision: 8,
        },
        data: {
          state: "FINAL_MANUAL",
          consecutiveFailures: 0,
          failureFingerprint: null,
          firstDegradedAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: { increment: 1 },
        },
      },
    );
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("records one transition when a course enters a manual final state", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 3,
      failureFingerprint: "PHONE_ONLY:CONFIRMED",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 7,
      confirmedAt: new Date("2026-07-27T15:40:00.000Z"),
      status: "RESOLVED",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      decisionAt: null,
      activeBatchId: null,
      revision: 4,
    });
    const now = new Date("2026-07-27T15:50:00.000Z");

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      evidenceUrl: "https://course.example/booking",
      runtimeVersion: "release-sha",
      now,
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FINAL_MANUAL",
          stateChangedAt: now,
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      1,
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "STATE_CHANGED",
        fromState: "AUTO_INVESTIGATING",
        toState: "FINAL_MANUAL",
        outcome: "MANUAL_DIRECT",
        occurredAt: now,
        audit: {
          cycle: 7,
          confirmedAt: "2026-07-27T15:40:00.000Z",
          automatedFinal: true,
          customerDataIncluded: false,
        },
      }),
    });
  });

  it("queues active real searches for an external factual final transition", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE:UNKNOWN",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });
    const now = new Date("2026-07-27T15:50:00.000Z");

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      source: "COURSE_SUPPORT_RESPONDER",
      message: "Official evidence confirms direct action.",
      now,
    });

    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        preferences: { some: { courseId: "course-1" } },
      },
      data: { nextCheckAt: now, recheckRequestedAt: now },
    });
  });

  it("does not queue a duplicate self-recheck for a search-workflow final", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE:UNKNOWN",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8,
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      source: "SEARCH_WORKFLOW",
      message: "Official evidence confirms direct action.",
    });

    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("appends playbook proof without consuming the legacy responder attempt ladder", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 1,
      revision: 7,
      status: "AUTO_INVESTIGATING",
      attemptLedger: null,
    });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    const now = new Date("2026-07-27T15:55:00.000Z");

    await recordCourseMonitoringPlaybookTransition({
      courseId: "course-1",
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion: "release-sha",
      now,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptLedger: expect.any(Object),
          revision: { increment: 1 },
        }),
      }),
    );
    const updateData =
      transactionMocks.courseSupportIncident.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("attemptCount");
    expect(updateData).not.toHaveProperty("lastAttemptAt");
  });

  it("does not append browser playbook proof after the bound provider snapshot changes", async () => {
    const boundCourse = {
      detectedPlatform: "CUSTOM" as const,
      providerFamilyKey: "BOOKING_EXAMPLE",
      detectedBookingUrl: "https://booking.example/tee-times",
      bookingMethod: "PUBLIC_ONLINE" as const,
      automationEligibility: "ALLOWED" as const,
      automationReason: "NONE" as const,
    };
    transactionMocks.course.findUnique.mockResolvedValue({
      ...boundCourse,
      detectedBookingUrl: "https://booking.example/concurrent-change",
    });

    await expect(
      recordCourseMonitoringPlaybookTransition({
        courseId: "course-1",
        stage: "RENDERED_BROWSER_DISCOVERY",
        transition: "COMPLETED",
        readPath: "RENDERED_BROWSER",
        evidenceKind: "RENDERED_PAGE",
        failureFingerprint: "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:COMPLETED",
        runtimeVersion: "release-sha",
        expectedProviderSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(boundCourse),
      }),
    ).resolves.toBeNull();

    const courseLock = transactionMocks.$queryRaw.mock.calls.find(([query]) =>
      (query as { strings?: readonly string[] }).strings
        ?.join("")
        .includes('FROM "Course"'),
    );
    expect(courseLock?.[0].strings.join("")).toContain("FOR UPDATE");
    expect(
      transactionMocks.courseSupportIncident.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("records a deployment marker without reopening unchanged human-review work", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    prismaMocks.automationRun.upsert.mockResolvedValue({
      id: `cm_deploy_${"a".repeat(40)}`,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    transactionMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "deployment-event" });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 3,
      revision: 9,
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      activeBatchId: null,
      failureFingerprint: "SOURCE:UNKNOWN",
      activeRealSearchCount: 1,
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 4,
    });
    const deploymentSha = "a".repeat(40);

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });

    expect(prismaMocks.automationRun.upsert).toHaveBeenCalledTimes(3);
    expect(prismaMocks.automationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: `cm_deploy_${deploymentSha}` },
        create: expect.objectContaining({
          id: `cm_deploy_${deploymentSha}`,
          runtimeVersion: deploymentSha,
          outcome: "deployment_observed",
          audit: { customerDataIncluded: false },
        }),
        update: {},
      }),
    );
    expect(prismaMocks.courseSupportIncident.findMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("does not treat a deployment as a material trigger for an automation stall", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    const deploymentSha = "c".repeat(40);
    prismaMocks.automationRun.upsert.mockResolvedValue({
      id: `cm_deploy_${deploymentSha}`,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-stalled" },
    ]);
    transactionMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "deployment-stalled-event" });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-stalled",
      cycle: 5,
      revision: 11,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "AUTOMATION_STALLED",
      activeBatchId: null,
      failureFingerprint: "SOURCE:UNKNOWN",
      activeRealSearchCount: 1,
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-stalled",
      state: "AUTO_INVESTIGATING",
      revision: 8,
    });

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });

    expect(prismaMocks.courseSupportIncident.findMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("does not scan or batch parked incidents after deployment", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) =>
      worker(transactionMocks),
    );
    const now = new Date("2026-07-27T16:00:00.000Z");
    const deploymentSha = "b".repeat(40);
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      courseId: `course-${index + 1}`,
    }));
    prismaMocks.automationRun.upsert.mockResolvedValue({
      id: `cm_deploy_${deploymentSha}`,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce(candidates.slice(0, 20))
      .mockResolvedValueOnce(candidates.slice(20));
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseSupportIncident.findUnique.mockImplementation(
      async ({ where }: { where: { courseId: string } }) => ({
        id: `incident-${where.courseId}`,
        courseId: where.courseId,
        cycle: 2,
        revision: 7,
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        activeBatchId: null,
        failureFingerprint: "SOURCE:UNKNOWN",
        activeRealSearchCount: 1,
        escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
        firstSeenAt: new Date("2026-07-27T15:00:00.000Z"),
      }),
    );
    transactionMocks.courseMonitoringStatus.upsert.mockImplementation(
      async ({ where }: { where: { courseId: string } }) => ({
        courseId: where.courseId,
        state:
          where.courseId === "course-25"
            ? "FINAL_MANUAL"
            : "ENGINEERING_VERIFICATION_NEEDED",
        revision: 4,
      }),
    );

    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });
    await expect(
      revalidateHumanReviewCoursesForDeployment({ deploymentSha, now }),
    ).resolves.toEqual({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    });

    expect(prismaMocks.courseSupportIncident.findMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("opens a fresh playbook cycle and queues real searches when provider metadata changes during human review", async () => {
    const now = new Date("2026-08-11T13:00:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 4,
      revision: 9,
      status: "NEEDS_HUMAN",
      kind: "FETCH_FAILED",
      providerFamilyKey: "CPS",
      failureClass: "CHALLENGE",
      activeBatchId: null,
      activeRealSearchCount: 2,
      failureFingerprint: "CPS:CHALLENGE",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 6,
    });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          providerFamilyKey: "CPS",
          bookingMetadata: { parserVersion: 1, tenantId: "tenant" },
        },
        after: {
          providerFamilyKey: "CPS",
          bookingMetadata: { parserVersion: 2, tenantId: "tenant" },
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "REQUEUED",
      changedFields: ["bookingMetadata"],
      searchesQueued: 2,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 4,
          revision: 9,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 6,
        state: "ENGINEERING_VERIFICATION_NEEDED",
      },
      data: {
        state: "AUTO_INVESTIGATING",
        failureFingerprint: "CPS:CHALLENGE",
        firstDegradedAt: now,
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: now,
        stateChangedAt: now,
        revision: { increment: 1 },
      },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        idempotencyKey: expect.stringMatching(
          /^course-provider-evidence-revalidate:/u,
        ),
        audit: expect.objectContaining({
          priorCycle: 4,
          cycle: 5,
          changedFields: ["bookingMetadata"],
          customerDataIncluded: false,
        }),
      }),
    });
    const event =
      transactionMocks.courseMonitoringEvent.create.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(event)).not.toContain("tenant");
  });

  it("keeps a trusted account-required discovery in parked engineering review", async () => {
    const now = new Date("2026-08-18T17:15:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-account-required",
      cycle: 3,
      revision: 7,
      status: "NEEDS_HUMAN",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "UNSUPPORTED_FAMILY",
      activeBatchId: null,
      activeRealSearchCount: 0,
      failureFingerprint: "old-source-fingerprint",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 5,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-account-required",
        before: {
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          automationReason: "OTHER",
          bookingAccessMode: "UNKNOWN",
        },
        after: {
          providerFamilyKey: "driverpos.io",
          detectedBookingUrl: "https://provider.example/tenant/sign-in",
          automationReason: "ACCOUNT_REQUIRED",
          bookingAccessMode: "ACCOUNT_REQUIRED",
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "HUMAN_REVIEW_PRESERVED",
      searchesQueued: 0,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "incident-account-required",
        cycle: 3,
        revision: 7,
        activeBatchId: null,
        status: "NEEDS_HUMAN",
      },
      data: expect.objectContaining({
        status: "NEEDS_HUMAN",
        providerFamilyKey: "driverpos.io",
        failureClass: "AUTH",
        humanReviewReason: "ACCOUNT_REQUIRED",
        latestMessage:
          "Verified official course evidence indicates an account is required to view tee times.",
        nextAttemptAt: null,
        escalatedAt: now,
        nextReminderAt: now,
        revision: { increment: 1 },
      }),
    });
    const incidentUpdate =
      transactionMocks.courseSupportIncident.updateMany.mock.calls.at(-1)?.[0]
        ?.data;
    expect(incidentUpdate).toHaveProperty("status", "NEEDS_HUMAN");
    expect(incidentUpdate).not.toHaveProperty("cycle");
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        courseId: "course-account-required",
        revision: 5,
        state: "ENGINEERING_VERIFICATION_NEEDED",
      },
      data: expect.objectContaining({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      }),
    });
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_REVIEW_REQUESTED",
        toState: "ENGINEERING_VERIFICATION_NEEDED",
        audit: expect.objectContaining({
          cycle: 3,
          customerState: "NEEDS_HUMAN_REVIEW",
          humanReviewReason: "ACCOUNT_REQUIRED",
          parkedUntilMaterialChange: true,
          automaticRetrySuppressed: true,
          customerDataIncluded: false,
        }),
      }),
    });
  });

  it("parks an unowned stalled automatic incident when account-required evidence is conclusive", async () => {
    const now = new Date("2026-08-18T17:30:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-auto-account-required",
      cycle: 4,
      revision: 9,
      status: "AUTO_INVESTIGATING",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "UNSUPPORTED_FAMILY",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "old-source-fingerprint",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 6,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-auto-account-required",
        before: {
          providerFamilyKey: "SOURCE_MISSING",
          detectedBookingUrl: null,
          automationReason: "OTHER",
          bookingAccessMode: "UNKNOWN",
        },
        after: {
          providerFamilyKey: "driverpos.io",
          detectedBookingUrl: "https://provider.example/tenant/sign-in",
          automationReason: "ACCOUNT_REQUIRED",
          bookingAccessMode: "ACCOUNT_REQUIRED",
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "HUMAN_REVIEW_PRESERVED",
      searchesQueued: 0,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "incident-auto-account-required",
        cycle: 4,
        revision: 9,
        activeBatchId: null,
        status: "AUTO_INVESTIGATING",
      },
      data: expect.objectContaining({
        status: "NEEDS_HUMAN",
        humanReviewReason: "ACCOUNT_REQUIRED",
        nextAttemptAt: null,
        escalatedAt: now,
      }),
    });
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        courseId: "course-auto-account-required",
        revision: 6,
        state: "AUTO_INVESTIGATING",
      },
      data: expect.objectContaining({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      }),
    });
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("re-reads an eligible parked incident after a stale provider-evidence CAS", async () => {
    const now = new Date("2026-08-11T13:02:00.000Z");
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-provider-race",
        cycle: 4,
        revision: 9,
        status: "NEEDS_HUMAN",
        kind: "FETCH_FAILED",
        providerFamilyKey: "CPS",
        failureClass: "CHALLENGE",
        activeBatchId: null,
        activeRealSearchCount: 2,
        failureFingerprint: "CPS:CHALLENGE",
        humanReviewReason: "AUTOMATION_STALLED",
        resolution: null,
      })
      .mockResolvedValueOnce({
        id: "incident-provider-race",
        cycle: 4,
        revision: 10,
        status: "NEEDS_HUMAN",
        kind: "FETCH_FAILED",
        providerFamilyKey: "CPS",
        failureClass: "CHALLENGE",
        activeBatchId: null,
        activeRealSearchCount: 2,
        failureFingerprint: "CPS:CHALLENGE",
        humanReviewReason: "AUTOMATION_STALLED",
        resolution: null,
      });
    transactionMocks.courseSupportIncident.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 6,
    });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { bookingMetadata: { parserVersion: 1 } },
        after: { bookingMetadata: { parserVersion: 2 } },
        source: "OPERATOR_CLI",
        now,
      }),
    ).resolves.toEqual({
      outcome: "REQUEUED",
      changedFields: ["bookingMetadata"],
      searchesQueued: 2,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledTimes(2);
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-provider-race",
          cycle: 4,
          revision: 10,
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          attemptCount: 0,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("continues the unowned reopen when batch ownership ends during a provider-evidence CAS", async () => {
    const now = new Date("2026-08-11T13:03:00.000Z");
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-owner-race",
        cycle: 4,
        revision: 9,
        status: "AUTO_INVESTIGATING",
        kind: "NEEDS_ADAPTER",
        providerFamilyKey: "CPS",
        failureClass: "MISSING_METADATA",
        activeBatchId: "batch-1",
        activeRealSearchCount: 1,
        failureFingerprint: "CPS:MISSING_METADATA",
        humanReviewReason: null,
        resolution: null,
        activeBatch: {
          status: "IMPLEMENTING",
          releaseSha: null,
          deployedAt: null,
          recheckDispatchedAt: null,
        },
      })
      .mockResolvedValueOnce({
        id: "incident-owner-race",
        cycle: 4,
        revision: 10,
        status: "NEEDS_HUMAN",
        kind: "NEEDS_ADAPTER",
        providerFamilyKey: "CPS",
        failureClass: "MISSING_METADATA",
        activeBatchId: null,
        activeRealSearchCount: 1,
        failureFingerprint: "CPS:MISSING_METADATA",
        humanReviewReason: "AUTOMATION_STALLED",
        resolution: null,
        activeBatch: null,
      });
    transactionMocks.courseSupportIncident.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 6,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { detectedBookingUrl: "https://old.example/booking" },
        after: { detectedBookingUrl: "https://new.example/booking" },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "REQUEUED",
      changedFields: ["detectedBookingUrl"],
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenNthCalledWith(1, {
      where: {
        id: "incident-owner-race",
        cycle: 4,
        revision: 9,
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-1",
      },
      data: {
        lastSeenAt: now,
        revision: { increment: 1 },
      },
    });
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-owner-race",
          revision: 10,
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
        }),
      }),
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("preserves a factual winner after a stale provider-evidence reopen CAS", async () => {
    const now = new Date("2026-08-11T13:04:00.000Z");
    transactionMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        id: "incident-factual-race",
        cycle: 4,
        revision: 9,
        status: "NEEDS_HUMAN",
        kind: "FETCH_FAILED",
        providerFamilyKey: "CPS",
        failureClass: "CHALLENGE",
        activeBatchId: null,
        activeRealSearchCount: 1,
        failureFingerprint: "CPS:CHALLENGE",
        humanReviewReason: "AUTOMATION_STALLED",
        resolution: null,
      })
      .mockResolvedValueOnce({
        id: "incident-factual-race",
        cycle: 4,
        revision: 10,
        status: "RESOLVED",
        kind: "FETCH_FAILED",
        providerFamilyKey: "CPS",
        failureClass: "CHALLENGE",
        activeBatchId: null,
        activeRealSearchCount: 1,
        failureFingerprint: "CPS:CHALLENGE",
        humanReviewReason: null,
        resolution: "DIRECT_BOOKING_CLASSIFIED",
      });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    transactionMocks.courseMonitoringStatus.findUnique
      .mockResolvedValueOnce({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 6,
      })
      .mockResolvedValueOnce({
        state: "FINAL_MANUAL",
        revision: 7,
      });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { bookingAccessMode: "UNKNOWN" },
        after: { bookingAccessMode: "PUBLIC_SIGNED_OUT" },
        source: "OPERATOR_CLI",
        now,
      }),
    ).resolves.toEqual({
      outcome: "AUTHORITATIVE_FINAL_PRESERVED",
      changedFields: ["bookingAccessMode"],
      searchesQueued: 0,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledTimes(1);
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        incidentId: "incident-factual-race",
        fromState: "FINAL_MANUAL",
        toState: "FINAL_MANUAL",
        audit: expect.objectContaining({ authoritativeFinalRetained: true }),
      }),
    });
  });

  it("aborts after repeated eligible provider-evidence CAS misses", async () => {
    const now = new Date("2026-08-11T13:04:30.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-provider-conflict",
      cycle: 4,
      revision: 9,
      status: "NEEDS_HUMAN",
      kind: "FETCH_FAILED",
      providerFamilyKey: "CPS",
      failureClass: "CHALLENGE",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "CPS:CHALLENGE",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
    });
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 0,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 6,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
        transactionMocks as never,
        {
          courseId: "course-1",
          before: { bookingMetadata: { parserVersion: 1 } },
          after: { bookingMetadata: { parserVersion: 2 } },
          source: "OPERATOR_CLI",
          now,
        },
      ),
    ).rejects.toThrow(
      "Course provider-evidence revalidation write conflict while opening a fresh cycle.",
    );

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledTimes(3);
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
  });

  it("reopens a resolved technical final under the current provider family when material evidence changes", async () => {
    const now = new Date("2026-08-11T13:05:00.000Z");
    const nextFailureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "FOREUP",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA",
      httpStatus: null,
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-technical-final",
      cycle: 4,
      revision: 9,
      status: "RESOLVED",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "TENFORE",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: "old-family-fingerprint",
      activeBatchId: null,
      activeRealSearchCount: 1,
      humanReviewReason: null,
      resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "FINAL_TECHNICAL",
      revision: 6,
    });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { providerFamilyKey: "TENFORE" },
        after: { providerFamilyKey: "FOREUP" },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "REQUEUED",
      changedFields: ["providerFamilyKey"],
      searchesQueued: 1,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "incident-technical-final",
        cycle: 4,
        revision: 9,
        activeBatchId: null,
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
      },
      data: expect.objectContaining({
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        providerFamilyKey: "FOREUP",
        failureFingerprint: nextFailureFingerprint,
        occurrenceCount: 1,
        lastAttemptAt: null,
        attemptCount: 0,
        firstSeenAt: now,
        nextAttemptAt: now,
        resolvedAt: null,
        resolution: null,
        decisionAt: null,
      }),
    });
    expect(
      transactionMocks.courseMonitoringStatus.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 6,
        state: "FINAL_TECHNICAL",
      },
      data: {
        state: "AUTO_INVESTIGATING",
        failureFingerprint: nextFailureFingerprint,
        firstDegradedAt: now,
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: now,
        stateChangedAt: now,
        revision: { increment: 1 },
      },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        failureFingerprint: nextFailureFingerprint,
        audit: expect.objectContaining({
          priorCycle: 4,
          cycle: 5,
          reason: "TECHNICAL_FINAL_PROVIDER_EVIDENCE_CHANGED",
          priorProviderFamilyKey: "TENFORE",
          providerFamilyKey: "FOREUP",
          providerFamilyChanged: true,
        }),
      }),
    });
  });

  it("uses the execution fingerprint fields as the material-change projection", () => {
    expect(
      getMaterialProviderEvidenceChanges(
        {
          timeZone: "America/New_York",
          bookingWindowDaysAhead: 7,
          bookingReleaseTimeLocal: "07:00",
          bookingWindowConfidence: 0.75,
          bookingAccessMode: "ACCOUNT_REQUIRED",
          isPublic: false,
          intelligenceConfidence: 0.55,
        },
        {
          timeZone: "America/Chicago",
          bookingWindowDaysAhead: 14,
          bookingReleaseTimeLocal: "08:00",
          bookingWindowConfidence: 0.95,
          bookingAccessMode: "PUBLIC_SIGNED_OUT",
          isPublic: true,
          intelligenceConfidence: 0.95,
        },
      ),
    ).toEqual([
      "timeZone",
      "bookingWindowDaysAhead",
      "bookingReleaseTimeLocal",
      "bookingWindowConfidence",
      "bookingAccessMode",
      "isPublic",
      "intelligenceConfidence",
    ]);
  });

  it.each([
    {
      label: "private-course confidence",
      before: {
        isPublic: false,
        intelligenceVerifiedAt: new Date("2026-08-10T13:15:00.000Z"),
        intelligenceReviewAt: new Date("2026-09-10T13:15:00.000Z"),
        intelligenceConfidence: 0.55,
      },
      after: {
        isPublic: false,
        intelligenceVerifiedAt: new Date("2026-08-10T13:15:00.000Z"),
        intelligenceReviewAt: new Date("2026-09-10T13:15:00.000Z"),
        intelligenceConfidence: 0.95,
      },
      changedField: "intelligenceConfidence",
    },
    {
      label: "public-access classification",
      before: {
        isPublic: false,
        intelligenceVerifiedAt: new Date("2026-08-10T13:15:00.000Z"),
        intelligenceReviewAt: new Date("2026-09-10T13:15:00.000Z"),
        intelligenceConfidence: 0.95,
      },
      after: {
        isPublic: true,
        intelligenceVerifiedAt: new Date("2026-08-10T13:15:00.000Z"),
        intelligenceReviewAt: new Date("2026-09-10T13:15:00.000Z"),
        intelligenceConfidence: 0.95,
      },
      changedField: "isPublic",
    },
  ] as const)(
    "reopens parked work when only $label changes",
    async ({ before, after, changedField }) => {
      const now = new Date("2026-08-11T13:15:00.000Z");
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-private-recheck",
        cycle: 6,
        revision: 11,
        status: "NEEDS_HUMAN",
        activeBatchId: null,
        activeRealSearchCount: 1,
        failureFingerprint: "IDENTITY:RECHECK",
        humanReviewReason: "AUTOMATION_STALLED",
        resolution: null,
      });
      transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 5,
      });
      transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        revalidateCourseMonitoringForProviderEvidenceChange({
          courseId: "course-1",
          before,
          after,
          source: "COURSE_SUPPORT_RESPONDER",
          now,
        }),
      ).resolves.toEqual({
        outcome: "REQUEUED",
        changedFields: [changedField],
        searchesQueued: 1,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-private-recheck",
            cycle: 6,
            revision: 11,
            activeBatchId: null,
          }),
          data: expect.objectContaining({
            cycle: { increment: 1 },
            status: "AUTO_INVESTIGATING",
            nextAttemptAt: now,
          }),
        }),
      );
      expect(
        transactionMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          courseId: "course-1",
          revision: 5,
          state: "ENGINEERING_VERIFICATION_NEEDED",
        },
        data: {
          state: "AUTO_INVESTIGATING",
          failureFingerprint: "IDENTITY:RECHECK",
          firstDegradedAt: now,
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
          stateChangedAt: now,
          revision: { increment: 1 },
        },
      });
      expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
        where: {
          status: "ACTIVE",
          trafficClass: { notIn: ["AUTOMATION", "TEST"] },
          preferences: { some: { courseId: "course-1" } },
        },
        data: { nextCheckAt: now, recheckRequestedAt: now },
      });
    },
  );

  it("queues one fresh real-search recheck when material provider evidence changes after batch dispatch", async () => {
    const now = new Date("2026-08-11T13:30:00.000Z");
    const providerSnapshotFingerprint = "a".repeat(64);
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 4,
      revision: 9,
      status: "AUTO_INVESTIGATING",
      activeBatchId: "batch-1",
      activeRealSearchCount: 1,
      failureFingerprint: "CPS:MISSING_METADATA",
      humanReviewReason: null,
      resolution: null,
      activeBatch: {
        status: "VERIFYING",
        releaseSha: "b".repeat(40),
        deployedAt: new Date("2026-08-11T13:20:00.000Z"),
        recheckDispatchedAt: new Date("2026-08-11T13:21:00.000Z"),
      },
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 6,
    });
    transactionMocks.courseMonitoringEvent.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "provider-recheck-event" });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });

    const revalidate = () =>
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          timeZone: "America/New_York",
          detectedBookingUrl: "https://old.example/booking",
        },
        after: {
          timeZone: "America/New_York",
          detectedBookingUrl: "https://new.example/booking",
        },
        providerSnapshotFingerprint,
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      });

    await expect(revalidate()).resolves.toEqual({
      outcome: "RECHECK_QUEUED",
      changedFields: ["detectedBookingUrl"],
      searchesQueued: 1,
    });
    await expect(revalidate()).resolves.toEqual({
      outcome: "REPLAYED",
      changedFields: ["detectedBookingUrl"],
      searchesQueued: 0,
    });

    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        date: { gte: expect.any(Date) },
        preferences: { some: { courseId: "course-1" } },
      },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: now,
        lastCheckOutcome: null,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null,
      },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      1,
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        incidentId: "incident-1",
        eventType: "REVALIDATION_REQUESTED",
        idempotencyKey: expect.stringMatching(
          /^course-provider-evidence-recheck:/u,
        ),
        audit: expect.objectContaining({
          cycle: 4,
          providerSnapshotFingerprint,
          exactReleaseProgression: true,
          postDispatchRecheck: true,
          customerDataIncluded: false,
        }),
      }),
    });
  });

  it("invalidates active-batch proof when material provider evidence changes before dispatch", async () => {
    const now = new Date("2026-08-11T13:45:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-owned-material-change",
      cycle: 3,
      revision: 7,
      status: "AUTO_INVESTIGATING",
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "TENFORE",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: "claimed-family-fingerprint",
      activeBatchId: "batch-1",
      activeRealSearchCount: 1,
      humanReviewReason: null,
      resolution: null,
      activeBatch: {
        status: "CLAIMED",
        releaseSha: null,
        deployedAt: null,
        recheckDispatchedAt: null,
      },
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 5,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: { providerFamilyKey: "TENFORE" },
        after: { providerFamilyKey: "FOREUP" },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "NOT_ACTIONABLE",
      changedFields: ["providerFamilyKey"],
      searchesQueued: 0,
    });

    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "incident-owned-material-change",
        cycle: 3,
        revision: 7,
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-1",
      },
      data: {
        lastSeenAt: now,
        revision: { increment: 1 },
      },
    });
    const freshnessWrite =
      transactionMocks.courseSupportIncident.updateMany.mock.calls.at(-1)?.[0]
        ?.data;
    expect(freshnessWrite).not.toHaveProperty("providerFamilyKey");
    expect(freshnessWrite).not.toHaveProperty("failureFingerprint");
    expect(
      transactionMocks.courseMonitoringEvent.create,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("immediately restarts an automation-stalled cycle when access and monitoring evidence changes", async () => {
    const now = new Date("2026-08-11T14:00:00.000Z");
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-stalled",
      cycle: 7,
      revision: 12,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "READER:PARSER",
      humanReviewReason: "AUTOMATION_STALLED",
      resolution: null,
    });
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 3,
    });

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          bookingAccessMode: "CAPTCHA_OR_QUEUE",
          monitoringMode: "LOCAL_READER_ONLY",
        },
        after: {
          bookingAccessMode: "PUBLIC_SIGNED_OUT",
          monitoringMode: "AUTOMATIC",
        },
        source: "LOCAL_READER",
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "REQUEUED",
      changedFields: ["monitoringMode", "bookingAccessMode"],
    });

    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        preferences: { some: { courseId: "course-1" } },
      },
      data: { nextCheckAt: now, recheckRequestedAt: now },
    });
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audit: expect.objectContaining({
          reason: "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED",
        }),
      }),
    });
  });

  it("ignores immaterial evidence refreshes and metadata key-order changes", async () => {
    const now = new Date("2026-08-11T15:00:00.000Z");

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          providerFamilyKey: "FOREUP",
          bookingMetadata: { bookingClassId: 8, scheduleId: 4 },
          policyNotes: "older note",
          intelligenceVerifiedAt: new Date("2026-08-10T00:00:00.000Z"),
        },
        after: {
          providerFamilyKey: "FOREUP",
          bookingMetadata: { scheduleId: 4, bookingClassId: 8 },
          policyNotes: "newer note",
          intelligenceVerifiedAt: now,
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "IMMATERIAL",
      changedFields: [],
      searchesQueued: 0,
    });

    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("does not reopen parked work for a timestamp-only evidence refresh", async () => {
    const now = new Date("2026-08-11T15:30:00.000Z");

    await expect(
      revalidateCourseMonitoringForProviderEvidenceChange({
        courseId: "course-1",
        before: {
          intelligenceVerifiedAt: new Date("2026-08-10T00:00:00.000Z"),
          intelligenceReviewAt: new Date("2026-09-10T00:00:00.000Z"),
          bookingWindowCheckedAt: new Date("2026-08-10T01:00:00.000Z"),
          bookingWindowObservedAt: new Date("2026-08-10T01:00:00.000Z"),
        },
        after: {
          intelligenceVerifiedAt: now,
          intelligenceReviewAt: new Date("2026-09-11T00:00:00.000Z"),
          bookingWindowCheckedAt: now,
          bookingWindowObservedAt: now,
        },
        source: "COURSE_SUPPORT_RESPONDER",
        now,
      }),
    ).resolves.toEqual({
      outcome: "IMMATERIAL",
      changedFields: [],
      searchesQueued: 0,
    });

    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
    expect(
      transactionMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_IDENTITY", "IDENTITY_CLASSIFIED"],
  ])(
    "preserves authoritative %s when provider evidence changes",
    async (state, resolution) => {
      const now = new Date("2026-08-11T16:00:00.000Z");
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) =>
        worker(transactionMocks),
      );
      transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
        id: "incident-final",
        cycle: 2,
        revision: 5,
        status: "RESOLVED",
        activeBatchId: null,
        activeRealSearchCount: 1,
        failureFingerprint: "FACTUAL:FINAL",
        humanReviewReason: null,
        resolution,
      });
      transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        revision: 8,
      });

      await expect(
        revalidateCourseMonitoringForProviderEvidenceChange({
          courseId: "course-1",
          before: { detectedBookingUrl: "https://old.example/booking" },
          after: { detectedBookingUrl: "https://new.example/booking" },
          source: "OPERATOR_CLI",
          now,
        }),
      ).resolves.toMatchObject({
        outcome: "AUTHORITATIVE_FINAL_PRESERVED",
        searchesQueued: 0,
      });

      expect(
        transactionMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(transactionMocks.teeSearch.updateMany).not.toHaveBeenCalled();
      expect(
        transactionMocks.courseMonitoringEvent.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromState: state,
          toState: state,
          idempotencyKey: expect.stringMatching(
            /^course-provider-evidence-revalidate:/u,
          ),
          audit: expect.objectContaining({ authoritativeFinalRetained: true }),
        }),
      });
    },
  );
});
