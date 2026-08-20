import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
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
  reopenParkedCourseForResponderCampaignInTransaction,
  revalidateCourseMonitoringForProviderEvidenceChange,
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction,
  revalidateHumanReviewCoursesForDeployment,
} from "./course-monitoring";
import { parkCourseSupportCandidatesForMaterialChange } from "./course-support-batches";
import { createParkedCourseCampaignAttemptLedgerFingerprint } from "./course-support-campaign";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import type { CourseSupportCandidate } from "./course-support-selection";
import { buildProviderFailureFingerprint } from "./provider-capabilities";

describe("course monitoring write serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      { incident: { ...makeIncident(), course: { ...makeIncident().course, website: "https://changed.example" } } },
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
      { incident: { ...makeIncident(), attemptLedger: { version: 1, events: [] } } },
      { incident: { ...makeIncident(), decisionAt: new Date("2026-08-20T11:00:00.000Z") } },
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

    expect(transactionMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(transactionMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
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

  it("closes an unclaimed automatic incident in the same serialized success write", async () => {
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
      audit: {
        action: "parked_cohort_admission",
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
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
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
