import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  assessParkedCourseCampaignSameCycleRecoveryHistory,
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  createParkedCourseCampaignMembershipDigest,
  deriveParkedCourseCampaignHumanReviewCycles,
  getReportSafeProviderFamilyCategory,
  inspectActiveParkedCourseCampaign,
  loadCampaignMemberObservations,
  loadParkedCourseCampaignAdmissionMembers,
  loadParkedCourseCampaignMembers,
  parseParkedCourseCampaignAudit,
  runParkedCourseCampaignCommand,
  summarizeCampaignEvidenceCategories,
  summarizeParkedCourseCampaignProgress,
  type ParkedCourseCampaignMember,
  type ParkedCourseCampaignMemberObservation,
} from "./course-support-campaign";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { COURSE_SUPPORT_RESPONDER_PROMPT_VERSION } from "./course-support-responder-policy";
import { persistCourseSupportSearchExecutionFence } from "./course-support-search-execution-fence";

const capturedAt = new Date("2026-08-20T12:00:00.000Z");

function member(
  ordinal: number,
  overrides: Partial<ParkedCourseCampaignMember> = {},
): ParkedCourseCampaignMember {
  return {
    courseId: `course-${ordinal}`,
    incidentId: `incident-${ordinal}`,
    cycle: 3,
    revision: 7,
    monitoringRevision: 11,
    monitoringFailureFingerprint: "SOURCE:MISSING",
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "MISSING_SOURCE",
    failureFingerprint: "SOURCE:MISSING",
    providerSnapshotFingerprint: "a".repeat(64),
    attemptLedgerFingerprint: "b".repeat(64),
    playbookConclusion: "UNRESOLVED_EXHAUSTED",
    latestProbeAt: "2026-08-19T12:00:00.000Z",
    latestDiscoveryAt: "2026-08-19T13:00:00.000Z",
    ...overrides,
  };
}

function observation(
  ordinal: number,
  overrides: Partial<ParkedCourseCampaignMemberObservation> = {},
): ParkedCourseCampaignMemberObservation {
  return {
    courseId: `course-${ordinal}`,
    incidentId: `incident-${ordinal}`,
    cycle: 4,
    status: "AUTO_INVESTIGATING",
    activeBatchId: null,
    confirmedAt: new Date("2026-08-20T12:01:00.000Z"),
    resolution: null,
    resolvedAt: null,
    decisionAt: null,
    monitoringState: "AUTO_INVESTIGATING",
    monitoringStateChangedAt: new Date("2026-08-20T12:05:00.000Z"),
    latestProbe: null,
    campaignTerminalEvidenceAt: new Date("2026-08-20T12:05:00.000Z"),
    campaignTerminalRuntimeVersion: "release-1",
    campaignTerminalDeploymentSha: "release-1",
    campaignTerminalOutcome: null,
    campaignTerminalFreshRuntimeProof: true,
    campaignTerminalAutomatedFinal: true,
    currentlyParked: false,
    humanReviewCycles: [],
    ...overrides,
  };
}

const providerCourseSnapshot = {
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

const playbookStages = [
  ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
  ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
  ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
  ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
  ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ["LOCAL_READER", "LOCAL_READER"],
  ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION"],
] as const;

function partialPlaybookLedger(cycle: number, completedStageCount: number) {
  return {
    version: 1,
    events: playbookStages
      .slice(0, completedStageCount)
      .map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(
          capturedAt.getTime() + index * 1_000,
        ).toISOString(),
        failureFingerprint: "SOURCE:MISSING",
        runtimeVersion: "release-old",
        skipReason: "NO_PROVIDER_METADATA",
      })),
  };
}

function campaignParkedRow(input: {
  cycle: number;
  attemptLedger: unknown;
  events: Array<Record<string, unknown>>;
  batchIncidents: Array<Record<string, unknown>>;
  revision?: number;
  providerFamilyKey?: string;
  failureClass?: string;
  failureFingerprint?: string;
  providerCourse?: Parameters<
    typeof buildCourseSupportProviderSnapshotFingerprint
  >[0];
  probes?: Array<{ id: string; courseId: string; observedAt: Date }>;
  discoveries?: Array<{ id: string; courseId: string; createdAt: Date }>;
}) {
  const parkedAt = new Date("2026-08-20T12:30:00.000Z");
  return {
    id: "incident-1",
    courseId: "course-1",
    cycle: input.cycle,
    revision: input.revision ?? 9,
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: input.providerFamilyKey ?? "SOURCE_MISSING",
    failureClass: input.failureClass ?? "MISSING_SOURCE",
    failureFingerprint: input.failureFingerprint ?? "SOURCE:MISSING",
    attemptLedger: input.attemptLedger,
    humanReviewReason: "AUTOMATION_STALLED",
    status: "NEEDS_HUMAN",
    activeRealSearchCount: 0,
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
    monitoringEvents: input.events,
    batchIncidents: input.batchIncidents,
    course: {
      ...(input.providerCourse ?? providerCourseSnapshot),
      preferences: [],
      monitoringStatus: {
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 13,
        failureFingerprint: input.failureFingerprint ?? "SOURCE:MISSING",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      },
      probes: input.probes ?? [],
      automationDiscoveries: input.discoveries ?? [],
    },
  };
}

function campaignDependencies(input: {
  members: ParkedCourseCampaignMember[];
  allMembers?: ParkedCourseCampaignMember[];
  globalParkedCount?: number;
  observations?: ParkedCourseCampaignMemberObservation[];
}) {
  const createdRuns: Array<Record<string, unknown>> = [];
  return {
    createdRuns,
    dependencies: {
      loadLatestCampaign: vi.fn().mockResolvedValue(null),
      loadActiveCampaign: vi.fn().mockResolvedValue(null),
      loadParkedMembers: vi.fn().mockResolvedValue(input.members),
      loadAllParkedMembers: vi
        .fn()
        .mockResolvedValue(input.allMembers ?? input.members),
      loadGlobalParkedCount: vi
        .fn()
        .mockResolvedValue(
          input.globalParkedCount ?? (input.allMembers ?? input.members).length,
        ),
      loadMemberObservations: vi
        .fn()
        .mockResolvedValue(input.observations ?? []),
      createCampaign: vi.fn(async (audit) => {
        const run = {
          id: "campaign-run-1",
          status: "RUNNING" as const,
          completedAt: null,
          outcome: null,
          audit,
        };
        createdRuns.push(run);
        return run;
      }),
      completeCampaign: vi.fn().mockResolvedValue(true),
      withTransitionLease: vi.fn(async (worker) => ({
        acquired: true as const,
        value: await worker(),
      })),
    },
  };
}

describe("parked course campaign", () => {
  it("captures a stale monitoring fingerprint only with matching durable incident proof", async () => {
    const parkedAt = new Date("2026-08-19T12:00:00.000Z");
    const parkedRow = {
      id: "incident-1",
      courseId: "course-1",
      cycle: 3,
      revision: 7,
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      failureFingerprint: "SOURCE:MISSING",
      attemptLedger: null,
      humanReviewReason: "AUTOMATION_STALLED",
      status: "NEEDS_HUMAN",
      activeRealSearchCount: 0,
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
          incidentId: "incident-1",
          eventType: "HUMAN_REVIEW_REQUESTED",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: parkedAt,
          audit: {
            cycle: 3,
            customerState: "NEEDS_HUMAN_REVIEW",
            parkedUntilMaterialChange: true,
            automationStalled: true,
          },
        },
      ],
      course: {
        timeZone: "America/New_York",
        isPublic: true,
        website: null,
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        bookingMethod: "UNKNOWN",
        bookingWindowDaysAhead: null,
        bookingReleaseTimeLocal: null,
        bookingWindowSource: null,
        bookingWindowConfidence: null,
        bookingWindowEvidenceUrl: null,
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        monitoringMode: "STANDARD",
        bookingAccessMode: "UNKNOWN",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        bookingMetadata: null,
        layoutHoleCounts: [],
        layoutHolesVerifiedAt: null,
        preferences: [],
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 11,
          failureFingerprint: "SOURCE:LEGACY",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
        probes: [],
        automationDiscoveries: [],
      },
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([parkedRow])
      .mockResolvedValueOnce([
        {
          ...parkedRow,
          monitoringEvents: [
            {
              ...parkedRow.monitoringEvents[0],
              failureFingerprint: "SOURCE:OTHER",
            },
          ],
        },
      ]);

    const snapshots = await loadParkedCourseCampaignMembers({
      courseSupportIncident: { findMany },
    } as never);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      failureFingerprint: "SOURCE:MISSING",
      monitoringFailureFingerprint: "SOURCE:LEGACY",
    });
    expect(snapshots[0]).not.toHaveProperty("activeRealSearchCount");
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt: parkedAt,
      members: snapshots,
    });
    expect(parseParkedCourseCampaignAudit(audit)).toEqual(audit);
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        members: [{ ...audit.members[0], activeRealSearchCount: 0 }],
      }),
    ).toBeNull();
    await expect(
      loadParkedCourseCampaignMembers({
        courseSupportIncident: { findMany },
      } as never),
    ).resolves.toEqual([]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          course: expect.objectContaining({
            preferences: {
              none: {
                teeSearch: {
                  status: "ACTIVE",
                  trafficClass: {
                    notIn: expect.arrayContaining(["AUTOMATION", "TEST"]),
                  },
                },
              },
            },
          }),
        }),
      }),
    );
  });

  it.each([4, 5])(
    "plans an exact same-cycle recovery after %i of 8 durable playbook stages",
    async (completedStageCount) => {
      const attemptLedger = partialPlaybookLedger(4, completedStageCount);
      const admittedAt = new Date("2026-08-20T12:05:00.000Z");
      const parkedAt = new Date("2026-08-20T12:30:00.000Z");
      const row = campaignParkedRow({
        cycle: 4,
        attemptLedger,
        events: [
          {
            incidentId: "incident-1",
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
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: "c".repeat(64),
              priorCycle: 3,
              cycle: 4,
            },
          },
        ],
        batchIncidents: [
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
                status: "SUCCEEDED",
                revision: 3,
                attemptCount: 1,
                workflowRunId: "workflow-partial",
                startedAt: new Date("2026-08-20T12:20:00.000Z"),
                outcome: "FETCH_FAILED",
                failureClass: "MISSING_METADATA",
                evidence: { providerExecution: true },
                lastError: "missing metadata",
              },
            ],
          },
        ],
      });
      const captured = member(1, {
        cycle: 3,
        revision: 5,
        monitoringRevision: 9,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot),
        attemptLedgerFingerprint:
          createParkedCourseCampaignAttemptLedgerFingerprint(null),
        playbookConclusion: "INCOMPLETE",
        latestProbeAt: null,
        latestDiscoveryAt: null,
      });
      const audit = createParkedCourseCampaignAudit({
        expectedCount: 1,
        capturedAt,
        members: [captured],
      });
      (
        row.monitoringEvents[1]?.audit as Record<string, unknown>
      ).campaignMembershipDigest = audit.membershipDigest;
      const members = await loadParkedCourseCampaignAdmissionMembers(
        audit,
        {
          courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
        } as never,
        "campaign-run-1",
        "release-current",
      );

      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({
        admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
        capturedCycle: 3,
        cycle: 4,
        playbookCompletedStageCount: completedStageCount,
        playbookNextStage: playbookStages[completedStageCount]?.[0],
        zeroExecutionHistoryDigest: null,
      });
      expect(members[0]?.sameCycleRecoveryHistoryDigest).toMatch(
        /^[a-f0-9]{64}$/u,
      );
    },
  );

  it("plans only the exact started-request descendant at 5 of 8 stages", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const handoffAt = new Date("2026-08-20T12:15:00.000Z");
    const startedAt = new Date("2026-08-20T12:20:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const capturedProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const currentProviderCourse = {
      ...providerCourseSnapshot,
      website: "https://official.example",
      providerFamilyKey: "GENERIC_HTTP",
    };
    const currentProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(currentProviderCourse);
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      providerSnapshotFingerprint: capturedProviderSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: null,
      latestDiscoveryAt: null,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const makeEntry = (ordinal: number) => ({
      id: `batch-entry-descendant-${ordinal}`,
      batchId: `batch-descendant-${ordinal}`,
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 5,
      result: "NEEDS_HUMAN",
      createdAt: new Date("2026-08-20T12:19:00.000Z"),
      batch: {
        id: `batch-descendant-${ordinal}`,
        createdAt: new Date("2026-08-20T12:18:00.000Z"),
        baseSha: "release-old",
        releaseSha: "release-old",
        completedAt: new Date("2026-08-20T12:25:00.000Z"),
        summary: { closeout: { providerExecutionStarted: true } },
      },
      verificationRequests: [
        {
          id: `request-descendant-${ordinal}`,
          releaseSha: "release-old",
          status: "SUCCEEDED",
          revision: 3,
          attemptCount: 1,
          workflowRunId: `workflow-descendant-${ordinal}`,
          startedAt,
          outcome: "FETCH_FAILED",
          failureClass: "MISSING_METADATA",
          evidence: { providerExecution: true },
          lastError: "metadata remained incomplete",
        },
      ],
    });
    const makeRow = (batchCount = 1) =>
      campaignParkedRow({
        cycle: 5,
        attemptLedger: partialPlaybookLedger(5, 5),
        providerFamilyKey: "GENERIC_HTTP",
        failureClass: "MISSING_METADATA",
        failureFingerprint: "METADATA:MISSING",
        providerCourse: currentProviderCourse,
        events: [
          {
            incidentId: "incident-1",
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
            incidentId: "incident-1",
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
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              priorCycle: 3,
              cycle: 4,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          },
        ],
        batchIncidents: Array.from({ length: batchCount }, (_, index) =>
          makeEntry(index + 1),
        ),
      });
    const database = (row: ReturnType<typeof makeRow>) => {
      const exactCurrentCycleRow = {
        ...row,
        batchIncidents: row.batchIncidents.slice(0, 21),
      };
      return {
        courseSupportIncident: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([row])
            .mockResolvedValueOnce([exactCurrentCycleRow]),
        },
      } as never;
    };

    const members = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      database(makeRow()),
      "campaign-run-1",
      "release-current",
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
      capturedCycle: 3,
      cycle: 5,
      playbookCompletedStageCount: 5,
      playbookNextStage: "BROWSER_ADAPTER_RETRY",
      zeroExecutionHistoryDigest: null,
    });
    expect(members[0]?.sameCycleRecoveryHistoryDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const twentyBatchMembers = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      database(makeRow(20)),
      "campaign-run-1",
      "release-current",
    );
    expect(twentyBatchMembers).toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
      }),
    ]);
    for (const batchCount of [21, 22]) {
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(makeRow(batchCount)),
          "campaign-run-1",
          "release-current",
        ),
      ).resolves.toEqual([]);
    }

    const latestProbeAt = new Date("2026-08-20T12:26:00.000Z");
    const latestDiscoveryAt = new Date("2026-08-20T12:27:00.000Z");
    const exactLatestEvidence = makeRow();
    exactLatestEvidence.course.probes = [
      {
        id: "probe-descendant-latest",
        courseId: "course-1",
        observedAt: latestProbeAt,
      },
    ];
    exactLatestEvidence.course.automationDiscoveries = [
      {
        id: "discovery-descendant-latest",
        courseId: "course-1",
        createdAt: latestDiscoveryAt,
      },
    ];
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(exactLatestEvidence),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        latestProbeId: "probe-descendant-latest",
        latestDiscoveryId: "discovery-descendant-latest",
      }),
    ]);

    const duplicateHandoff = makeRow();
    duplicateHandoff.monitoringEvents.push({
      ...duplicateHandoff.monitoringEvents[1]!,
      occurredAt: new Date("2026-08-20T12:16:00.000Z"),
    });
    const unstartedRequest = makeRow();
    const request = unstartedRequest.batchIncidents[0]!
      .verificationRequests[0]! as Record<string, unknown>;
    request.startedAt = null;
    request.attemptCount = 0;
    const staleCurrentSnapshot = makeRow();
    (
      staleCurrentSnapshot.monitoringEvents[1]!.audit as Record<string, unknown>
    ).observedProviderSnapshotFingerprint = "f".repeat(64);
    const missingHandoff = makeRow();
    missingHandoff.monitoringEvents.splice(1, 1);
    const gappedDescendant = makeRow();
    gappedDescendant.cycle = 6;
    const duplicateLatestProbe = structuredClone(exactLatestEvidence);
    duplicateLatestProbe.course.probes.push({
      id: "probe-descendant-latest-sibling",
      courseId: "course-1",
      observedAt: latestProbeAt,
    });
    const duplicateLatestDiscovery = structuredClone(exactLatestEvidence);
    duplicateLatestDiscovery.course.automationDiscoveries.push({
      id: "discovery-descendant-latest-sibling",
      courseId: "course-1",
      createdAt: latestDiscoveryAt,
    });

    for (const changed of [
      duplicateHandoff,
      unstartedRequest,
      staleCurrentSnapshot,
      missingHandoff,
      gappedDescendant,
      duplicateLatestProbe,
      duplicateLatestDiscovery,
    ]) {
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(changed),
          "campaign-run-1",
          "release-current",
        ),
      ).resolves.toEqual([]);
    }
  });

  it("plans only the exact requestless zero-stage +3 descendant history", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const firstHandoffAt = new Date("2026-08-20T12:10:00.000Z");
    const finalHandoffAt = new Date("2026-08-20T12:15:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const capturedProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const intermediateProviderCourse = {
      ...providerCourseSnapshot,
      website: "https://first.example/tee-times",
      providerFamilyKey: "GENERIC_HTTP",
    };
    const currentProviderCourse = {
      ...intermediateProviderCourse,
      website: "https://second.example/tee-times",
    };
    const intermediateProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(intermediateProviderCourse);
    const currentProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(currentProviderCourse);
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      providerSnapshotFingerprint: capturedProviderSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: null,
      latestDiscoveryAt: null,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
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
    const settledSearchFence = persistCourseSupportSearchExecutionFence(
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
    const makeEntry = (ordinal = 1) => ({
      id: `zero-entry-${ordinal}`,
      batchId: `zero-batch-${ordinal}`,
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 6,
      result: "NEEDS_HUMAN",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: null,
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date(`2026-08-20T12:${19 + ordinal}:00.000Z`),
      updatedAt: new Date(`2026-08-20T12:${24 + ordinal}:00.000Z`),
      batch: {
        id: `zero-batch-${ordinal}`,
        status: "PARTIAL",
        revision: ordinal,
        ownerAutomationRunId: null,
        baseSha: "release-old",
        releaseSha: null,
        deployedAt: null,
        createdAt: new Date(`2026-08-20T12:${18 + ordinal}:00.000Z`),
        updatedAt: new Date(`2026-08-20T12:${24 + ordinal}:00.000Z`),
        recheckDispatchKey: null,
        recheckDispatchStartedAt: null,
        recheckDispatchedAt: null,
        completedAt: new Date(`2026-08-20T12:${24 + ordinal}:00.000Z`),
        summary: {
          campaign: {
            kind: "PARKED_COHORT",
            attempts: [
              {
                courseRef,
                runId: "campaign-run-1",
                membershipDigest: audit.membershipDigest,
                cycle: 6,
              },
            ],
          },
          searchExecutionFence: settledSearchFence,
          closeout: {
            orchestrationOnlyCourseRefs: [courseRef],
            remediationAttempts: [
              {
                courseRef,
                providerSnapshotFingerprint: currentProviderSnapshotFingerprint,
                failureFingerprint: "SOURCE:MISSING",
                runtimeVersion: "release-old",
                consumed: false,
                countsTowardOperationalNoProgress: false,
                executionEvidence: { ...noExecution },
              },
            ],
          },
        },
        ownerAutomationRun: null,
      },
      verificationRequests: [],
    });
    const makeRow = () =>
      campaignParkedRow({
        cycle: 6,
        attemptLedger: { version: 1, events: [] },
        providerFamilyKey: "GENERIC_HTTP",
        failureClass: "MISSING_SOURCE",
        failureFingerprint: "SOURCE:MISSING",
        providerCourse: currentProviderCourse,
        events: [
          {
            id: "zero-endpoint",
            incidentId: "incident-1",
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
            incidentId: "incident-1",
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
              claimedProviderSnapshotFingerprint:
                intermediateProviderSnapshotFingerprint,
              observedProviderSnapshotFingerprint:
                currentProviderSnapshotFingerprint,
              providerFamilyChanged: false,
              providerSnapshotChanged: true,
              customerDataIncluded: false,
            },
          },
          {
            id: "zero-handoff-1",
            incidentId: "incident-1",
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
              claimedProviderSnapshotFingerprint:
                capturedProviderSnapshotFingerprint,
              observedProviderSnapshotFingerprint:
                intermediateProviderSnapshotFingerprint,
              providerFamilyChanged: true,
              providerSnapshotChanged: true,
              customerDataIncluded: false,
            },
          },
          {
            id: "zero-admission",
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            readPath: null,
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              priorCycle: 3,
              cycle: 4,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          },
        ],
        batchIncidents: [makeEntry()],
      });
    const database = (row: ReturnType<typeof makeRow>) => ({
      courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(makeRow()) as never,
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        cycle: 6,
        playbookCompletedStageCount: 0,
        playbookNextStage: "OFFICIAL_IDENTITY",
      }),
    ]);

    const priorDescendantRecovery = makeRow();
    priorDescendantRecovery.monitoringEvents.push({
      id: "prior-descendant-recovery",
      incidentId: "incident-1",
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      failureFingerprint: "HTTP:MISSING",
      readPath: null,
      occurredAt: new Date("2026-08-20T12:12:00.000Z"),
      audit: {
        action: "parked_cohort_descendant_incomplete_playbook_recovery",
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        capturedCycle: 2,
        cycle: 5,
      },
    });
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(priorDescendantRecovery) as never,
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        cycle: 6,
      }),
    ]);

    const handoffBoundaryDiscovery = makeRow();
    handoffBoundaryDiscovery.course.automationDiscoveries = [
      {
        id: "handoff-boundary-discovery",
        courseId: "course-1",
        createdAt: finalHandoffAt,
      },
    ];
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(handoffBoundaryDiscovery) as never,
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
        latestDiscoveryId: "handoff-boundary-discovery",
      }),
    ]);

    const failClosedRows = [
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          id: "zero-second-marker",
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: new Date("2026-08-20T12:29:00.000Z"),
          audit: {
            action: "parked_cohort_descendant_incomplete_playbook_recovery",
            campaignRunId: "campaign-run-1",
            cycle: 6,
          },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests.push({
          id: "unexpected-request",
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
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.releaseSha = "release-old";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.postProbeId = "unexpected-probe";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts = [];
      },
      (row: ReturnType<typeof makeRow>) => {
        const attempts =
          row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts;
        attempts.push(structuredClone(attempts[0]!));
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.searchExecutionFence.settled = false;
        row.batchIncidents[0]!.batch.summary.searchExecutionFence.reasons = [
          "DISPATCH_PENDING",
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.searchExecutionFence.searchExecutionMayHaveStartedCourseRefs =
          [courseRef];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.searchExecutionFence.providerExecutionAttemptCourseRefs =
          [courseRef];
      },
      (row: ReturnType<typeof makeRow>) => {
        const fence = row.batchIncidents[0]!.batch.summary.searchExecutionFence;
        fence.batchSearchCount = 1;
        fence.teeSearchCount = 1;
        fence.preferenceCount = 1;
        fence.memberships = [
          {
            searchRef: "3".repeat(64),
            scheduleVersion: 1,
            alertGeneration: 1,
            courseRefs: [courseRef],
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        const fence = row.batchIncidents[0]!.batch.summary.searchExecutionFence;
        const probeRef = "4".repeat(64);
        fence.probeCount = 1;
        fence.probeEvidenceRefs = [probeRef];
        fence.probeEvidenceBySearch = [
          {
            searchRef: "3".repeat(64),
            probes: [{ probeRef, courseRef }],
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts[0]!.executionEvidence.providerExecutionAttemptRecorded = true;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts[0]!.executionEvidence.playbookAttemptRecorded = true;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.campaign.attempts[0]!.runId =
          "different-run";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.splice(2, 1);
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          id: "zero-skipped-transition",
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: new Date("2026-08-20T12:12:00.000Z"),
          audit: { priorCycle: 3, cycle: 5 },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.createdAt = new Date(
          finalHandoffAt.getTime() - 1,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.completedAt = new Date(
          parkedAt.getTime() + 1,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.probes = [
          {
            id: "post-handoff-probe",
            courseId: "course-1",
            observedAt: new Date(finalHandoffAt.getTime() + 1),
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries = [
          {
            id: "post-handoff-discovery",
            courseId: "course-1",
            createdAt: new Date(finalHandoffAt.getTime() + 1),
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.attemptLedger = {
          version: 1,
          events: [
            {
              sequence: 1,
              cycle: 6,
              stage: "OFFICIAL_IDENTITY",
              transition: "STARTED",
              readPath: "OFFICIAL_IDENTITY",
              evidenceKind: "TOOLING",
              observedAt: "2026-08-20T12:19:00.000Z",
              failureFingerprint: "SOURCE:MISSING",
              runtimeVersion: "release-old",
            },
          ],
        };
      },
      (row: ReturnType<typeof makeRow>) => {
        const overlap = makeEntry(2);
        overlap.batch.createdAt = new Date("2026-08-20T12:24:00.000Z");
        overlap.createdAt = new Date("2026-08-20T12:26:00.000Z");
        overlap.batch.completedAt = new Date("2026-08-20T12:28:00.000Z");
        overlap.updatedAt = overlap.batch.completedAt;
        row.batchIncidents.push(overlap);
      },
    ];
    for (const mutate of failClosedRows) {
      const row = makeRow();
      mutate(row);
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(row) as never,
          "campaign-run-1",
          "release-current",
        ),
      ).resolves.toEqual([]);
    }
  });

  it("plans only one exact same-identity +2 material-change recovery at rendered-browser discovery", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const materialChangeAt = new Date("2026-08-20T12:10:00.000Z");
    const parkedAt = new Date("2026-08-20T12:45:00.000Z");
    const currentProviderCourse = {
      ...providerCourseSnapshot,
      website: "https://official.example/tee-times",
    };
    const capturedProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(currentProviderCourse);
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      monitoringFailureFingerprint: "SOURCE:LEGACY",
      providerSnapshotFingerprint: capturedProviderSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: null,
      latestDiscoveryAt: null,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const makeBatchEntry = (input: {
      ordinal: number;
      createdAt: string;
      completedAt: string;
      result: "RETRY_SCHEDULED" | "NEEDS_HUMAN";
      status: "RETRYABLE_FAILED" | "PARTIAL";
      requestStatus: "SUCCEEDED" | "STALE";
    }) => ({
      id: `batch-entry-${input.ordinal}`,
      batchId: `batch-${input.ordinal}`,
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 5,
      result: input.result,
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: { ordinal: input.ordinal, providerExecution: true },
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.completedAt),
      batch: {
        id: `batch-${input.ordinal}`,
        status: input.status,
        revision: input.ordinal,
        ownerAutomationRunId: `owner-${input.ordinal}`,
        baseSha: "release-old",
        releaseSha: "release-old",
        deployedAt: new Date("2026-08-20T12:09:00.000Z"),
        createdAt: new Date(new Date(input.createdAt).getTime() - 30_000),
        updatedAt: new Date(input.completedAt),
        recheckDispatchKey: `dispatch-${input.ordinal}`,
        recheckDispatchStartedAt: new Date(input.createdAt),
        recheckDispatchedAt: new Date(input.createdAt),
        completedAt: new Date(input.completedAt),
        summary: {
          remediation: {
            attempts: [{ courseRef, providerSnapshotFingerprint }],
          },
          closeout: {
            ordinal: input.ordinal,
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
        ownerAutomationRun: null,
      },
      verificationRequests: [
        {
          id: `request-${input.ordinal}`,
          courseId: "course-1",
          releaseSha: "release-old",
          providerSnapshotFingerprint,
          providerSnapshotAt: new Date(input.createdAt),
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
          createdAt: materialChangeAt,
          updatedAt: new Date(input.completedAt),
          status: input.requestStatus,
          revision: input.ordinal + 1,
          attemptCount: 1,
          workflowRunId: `workflow-${input.ordinal}`,
          startedAt: new Date(input.createdAt),
          outcome: "FETCH_FAILED",
          failureClass: "MISSING_SOURCE",
          evidence: { ordinal: input.ordinal, providerExecution: true },
          lastError: "source remained unavailable",
        },
      ],
    });
    const makeRow = () =>
      campaignParkedRow({
        cycle: 5,
        attemptLedger: partialPlaybookLedger(5, 4),
        providerCourse: currentProviderCourse,
        events: [
          {
            id: "endpoint-material-change",
            incidentId: "incident-1",
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
              endpointStalled: true,
            },
          },
          {
            id: "operator-material-change",
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "OPERATOR_CLI",
            failureFingerprint: "SOURCE:MISSING",
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
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              priorCycle: 3,
              cycle: 4,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          },
          {
            id: "historical-attempt-material-change",
            incidentId: "incident-1",
            eventType: "AUTOMATION_ATTEMPTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            occurredAt: new Date("2026-08-20T11:59:00.000Z"),
            audit: { cycle: 3 },
          },
        ],
        batchIncidents: [
          makeBatchEntry({
            ordinal: 1,
            createdAt: "2026-08-20T12:11:00.000Z",
            completedAt: "2026-08-20T12:19:00.000Z",
            result: "RETRY_SCHEDULED",
            status: "RETRYABLE_FAILED",
            requestStatus: "STALE",
          }),
          makeBatchEntry({
            ordinal: 2,
            createdAt: "2026-08-20T12:20:00.000Z",
            completedAt: "2026-08-20T12:29:00.000Z",
            result: "RETRY_SCHEDULED",
            status: "RETRYABLE_FAILED",
            requestStatus: "SUCCEEDED",
          }),
          makeBatchEntry({
            ordinal: 3,
            createdAt: "2026-08-20T12:30:00.000Z",
            completedAt: "2026-08-20T12:39:00.000Z",
            result: "NEEDS_HUMAN",
            status: "PARTIAL",
            requestStatus: "SUCCEEDED",
          }),
        ],
      });
    const database = (row: ReturnType<typeof makeRow>) =>
      ({
        courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
      }) as never;
    const databaseWithExactCurrentCycle = (
      initialRow: ReturnType<typeof makeRow>,
      exactRow: ReturnType<typeof makeRow>,
    ) => {
      const findMany = vi
        .fn()
        .mockResolvedValueOnce([initialRow])
        .mockResolvedValueOnce([
          {
            id: exactRow.id,
            cycle: exactRow.cycle,
            batchIncidents: exactRow.batchIncidents,
          },
        ]);
      return {
        database: { courseSupportIncident: { findMany } } as never,
        findMany,
      };
    };

    const planned = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      database(makeRow()),
      "campaign-run-1",
      "release-current",
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      admissionMode:
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
      capturedCycle: 3,
      cycle: 5,
      playbookCompletedStageCount: 4,
      playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
      zeroExecutionHistoryDigest: null,
      latestProbeId: null,
      latestDiscoveryId: null,
    });
    expect(planned[0]?.sameCycleRecoveryHistoryDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const laterIncompleteStage = makeRow();
    laterIncompleteStage.attemptLedger = partialPlaybookLedger(5, 5);
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(laterIncompleteStage),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode:
          "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
        playbookCompletedStageCount: 5,
        playbookNextStage: "BROWSER_ADAPTER_RETRY",
      }),
    ]);

    const evidenceObservedAt = new Date("2026-08-20T12:40:00.000Z");
    const planWithEvidence = async (probeId: string, discoveryId: string) => {
      const row = makeRow();
      row.course.probes = [
        { id: probeId, courseId: "course-1", observedAt: evidenceObservedAt },
      ];
      row.course.automationDiscoveries = [
        {
          id: discoveryId,
          courseId: "course-1",
          createdAt: evidenceObservedAt,
        },
      ];
      const [memberWithEvidence] =
        await loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(row),
          "campaign-run-1",
          "release-current",
        );
      return memberWithEvidence!;
    };
    const evidencePlan = await planWithEvidence("probe-a", "discovery-a");
    const alternateProbeIdentityPlan = await planWithEvidence(
      "probe-b",
      "discovery-a",
    );
    const alternateDiscoveryIdentityPlan = await planWithEvidence(
      "probe-a",
      "discovery-b",
    );
    expect(evidencePlan).toMatchObject({
      latestProbeId: "probe-a",
      latestDiscoveryId: "discovery-a",
      latestProbeAt: evidenceObservedAt.toISOString(),
      latestDiscoveryAt: evidenceObservedAt.toISOString(),
    });
    expect(alternateProbeIdentityPlan).toMatchObject({
      latestProbeId: "probe-b",
      latestDiscoveryId: "discovery-a",
      latestProbeAt: evidenceObservedAt.toISOString(),
      latestDiscoveryAt: evidenceObservedAt.toISOString(),
    });
    expect(alternateDiscoveryIdentityPlan).toMatchObject({
      latestProbeId: "probe-a",
      latestDiscoveryId: "discovery-b",
      latestProbeAt: evidenceObservedAt.toISOString(),
      latestDiscoveryAt: evidenceObservedAt.toISOString(),
    });
    expect(alternateProbeIdentityPlan.sameCycleRecoveryHistoryDigest).not.toBe(
      evidencePlan.sameCycleRecoveryHistoryDigest,
    );
    expect(
      alternateDiscoveryIdentityPlan.sameCycleRecoveryHistoryDigest,
    ).not.toBe(evidencePlan.sameCycleRecoveryHistoryDigest);

    const canonicalPostDiscovery = makeRow();
    const postDiscoveryRequest =
      canonicalPostDiscovery.batchIncidents[0]!.verificationRequests[0]!;
    postDiscoveryRequest.discoveryAttemptedAt = new Date(
      postDiscoveryRequest.startedAt!.getTime() + 10_000,
    );
    postDiscoveryRequest.providerSnapshotAt = new Date(
      postDiscoveryRequest.startedAt!.getTime() + 20_000,
    );
    postDiscoveryRequest.discoveryVerifiedAt = new Date(
      postDiscoveryRequest.startedAt!.getTime() + 30_000,
    );
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(canonicalPostDiscovery),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode:
          "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
      }),
    ]);

    const providerExecutionNotSticky = makeRow();
    providerExecutionNotSticky.batchIncidents[0]!.verificationRequests[0]!.evidence =
      { ordinal: 1, providerExecution: false };
    providerExecutionNotSticky.batchIncidents[1]!.verificationRequests[0]!.evidence =
      { ordinal: 2 };
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(providerExecutionNotSticky),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toHaveLength(1);

    const mixedCycleInitial = makeRow();
    mixedCycleInitial.batchIncidents = Array.from(
      { length: 20 },
      (_, index) => {
        const entry = makeBatchEntry({
          ordinal: index + 10,
          createdAt: `2026-08-20T11:${String(index).padStart(2, "0")}:00.000Z`,
          completedAt: `2026-08-20T11:${String(index).padStart(2, "0")}:30.000Z`,
          result: "RETRY_SCHEDULED",
          status: "RETRYABLE_FAILED",
          requestStatus: "STALE",
        });
        entry.cycle = 4;
        return entry;
      },
    );
    const exactCurrentCycle = makeRow();
    const mixedCycleDatabase = databaseWithExactCurrentCycle(
      mixedCycleInitial,
      exactCurrentCycle,
    );
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        mixedCycleDatabase.database,
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toHaveLength(1);
    expect(mixedCycleDatabase.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "incident-1", cycle: 5 },
        select: expect.objectContaining({
          batchIncidents: expect.objectContaining({
            where: { cycle: 5 },
            take: 21,
          }),
        }),
      }),
    );

    const preTransitionStart = makeRow();
    for (const entry of preTransitionStart.batchIncidents) {
      entry.verificationRequests[0]!.startedAt = new Date(
        materialChangeAt.getTime() - 1,
      );
    }
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(preTransitionStart),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([]);

    const tooManyExactEntries = makeRow();
    tooManyExactEntries.batchIncidents = Array.from(
      { length: 21 },
      (_, index) => {
        const createdAt = new Date(
          materialChangeAt.getTime() + (index + 1) * 60_000,
        );
        return makeBatchEntry({
          ordinal: index + 30,
          createdAt: createdAt.toISOString(),
          completedAt: new Date(createdAt.getTime() + 30_000).toISOString(),
          result: index === 20 ? "NEEDS_HUMAN" : "RETRY_SCHEDULED",
          status: index === 20 ? "PARTIAL" : "RETRYABLE_FAILED",
          requestStatus: "SUCCEEDED",
        });
      },
    );
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(tooManyExactEntries),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([]);

    const failClosedRows = [
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          ...row.monitoringEvents[0]!,
          id: "endpoint-material-change-duplicate",
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          ...row.monitoringEvents[2]!,
          occurredAt: new Date("2026-08-20T12:06:00.000Z"),
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          ...row.monitoringEvents[1]!,
          occurredAt: new Date("2026-08-20T12:10:30.000Z"),
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        const materialAudit = row.monitoringEvents[1]!.audit as Record<
          string,
          unknown
        >;
        materialAudit.evidenceFingerprint = "f".repeat(64);
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.monitoringStatus.failureFingerprint = "SOURCE:OTHER";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.status = "QUEUED";
      },
      (row: ReturnType<typeof makeRow>) => {
        for (const entry of row.batchIncidents) {
          entry.verificationRequests[0]!.startedAt = null;
          entry.verificationRequests[0]!.attemptCount = 0;
        }
      },
      (row: ReturnType<typeof makeRow>) => {
        for (const entry of row.batchIncidents) {
          entry.verificationRequests[0]!.revision = 1;
        }
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.courseId =
          "course-other";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.providerSnapshotFingerprint =
          capturedProviderSnapshotFingerprint;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.providerSnapshotAt =
          new Date(materialChangeAt.getTime() - 1);
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.createdAt = new Date(
          materialChangeAt.getTime() - 1,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests[0]!.providerSnapshotAt =
          new Date(
            row.batchIncidents[0]!.verificationRequests[0]!.startedAt!.getTime() +
              1,
          );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.remediation.attempts = [];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.remediation.attempts.push({
          courseRef,
          providerSnapshotFingerprint,
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.remediation.attempts[0]!.providerSnapshotFingerprint =
          capturedProviderSnapshotFingerprint;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts[0]!.providerSnapshotFingerprint =
          capturedProviderSnapshotFingerprint;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts[0]!.observedProviderSnapshotFingerprint =
          capturedProviderSnapshotFingerprint;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.summary.closeout.remediationAttempts[0]!.providerSnapshotChanged = true;
      },
      (row: ReturnType<typeof makeRow>) => {
        const request = row.batchIncidents[0]!.verificationRequests[0]!;
        request.providerSnapshotAt = new Date(
          request.startedAt!.getTime() + 20_000,
        );
        request.discoveryAttemptedAt = null;
        request.discoveryVerifiedAt = new Date(
          request.startedAt!.getTime() + 30_000,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        const request = row.batchIncidents[0]!.verificationRequests[0]!;
        request.providerSnapshotAt = new Date(
          request.startedAt!.getTime() + 20_000,
        );
        request.discoveryAttemptedAt = new Date(
          request.startedAt!.getTime() + 25_000,
        );
        request.discoveryVerifiedAt = new Date(
          request.startedAt!.getTime() + 30_000,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        const request = row.batchIncidents[0]!.verificationRequests[0]!;
        request.providerSnapshotAt = new Date(
          row.batchIncidents[0]!.batch.completedAt!.getTime() + 1,
        );
        request.discoveryAttemptedAt = new Date(
          request.startedAt!.getTime() + 10_000,
        );
        request.discoveryVerifiedAt = new Date(
          row.batchIncidents[0]!.batch.completedAt!.getTime() + 2,
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.status = "VERIFYING";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.createdAt = new Date("2026-08-20T12:18:00.000Z");
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.createdAt = new Date(
          "2026-08-20T12:09:59.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[2]!.batch.completedAt = new Date(
          "2026-08-20T12:46:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.unshift({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: new Date("2026-08-20T12:46:00.000Z"),
          audit: {
            action:
              "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
            campaignRunId: "campaign-run-1",
            cycle: 5,
          },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          occurredAt: new Date("2026-08-20T12:09:00.000Z"),
          audit: { priorCycle: 4, cycle: 5 },
        });
      },
    ];
    for (const mutate of failClosedRows) {
      const row = makeRow();
      mutate(row);
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(row),
          "campaign-run-1",
          "release-current",
        ),
      ).resolves.toEqual([]);
    }
  });

  it("plans one post-marker browser-stage recovery only on a newer exact runtime", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const priorBatchCompletedAt = new Date("2026-08-20T12:12:00.000Z");
    const priorEndpointAt = new Date("2026-08-20T12:15:00.000Z");
    const priorMarkerAt = new Date("2026-08-20T12:18:00.000Z");
    const deployedAt = new Date("2026-08-20T12:17:00.000Z");
    const postBatchCompletedAt = new Date("2026-08-20T12:25:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const priorRuntime = "a".repeat(40);
    const currentRuntime = "b".repeat(40);
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const attemptLedger = partialPlaybookLedger(4, 4);
    const attemptLedgerFingerprint =
      createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger);
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      providerSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: null,
      latestDiscoveryAt: null,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const preMarkerEntry = () => ({
      id: "batch-entry-before-marker",
      batchId: "batch-before-marker",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 4,
      result: "NEEDS_HUMAN",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: { providerExecution: true },
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date("2026-08-20T12:06:00.000Z"),
      updatedAt: priorBatchCompletedAt,
      batch: {
        id: "batch-before-marker",
        status: "PARTIAL",
        revision: 2,
        ownerAutomationRunId: null,
        baseSha: priorRuntime,
        releaseSha: priorRuntime,
        deployedAt: new Date("2026-08-20T12:04:00.000Z"),
        createdAt: new Date("2026-08-20T12:05:30.000Z"),
        updatedAt: priorBatchCompletedAt,
        recheckDispatchKey: "dispatch-before-marker",
        recheckDispatchStartedAt: new Date("2026-08-20T12:06:00.000Z"),
        recheckDispatchedAt: new Date("2026-08-20T12:06:00.000Z"),
        completedAt: priorBatchCompletedAt,
        summary: { closeout: { providerExecutionStarted: true } },
        ownerAutomationRun: null,
      },
      verificationRequests: [
        {
          id: "request-before-marker",
          releaseSha: priorRuntime,
          updatedAt: priorBatchCompletedAt,
          status: "SUCCEEDED",
          revision: 3,
          attemptCount: 1,
          workflowRunId: "workflow-before-marker",
          startedAt: new Date("2026-08-20T12:07:00.000Z"),
          outcome: "FETCH_FAILED",
          failureClass: "MISSING_SOURCE",
          evidence: { providerExecution: true },
          lastError: "source remained unavailable",
        },
      ],
    });
    const postMarkerEntry = () => ({
      id: "batch-entry-after-marker",
      batchId: "batch-after-marker",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 4,
      result: "RETRY_SCHEDULED",
      preProbeId: null,
      postProbeId: null,
      proofSnapshot: null,
      verifiedIncidentUpdatedAt: null,
      verifiedAt: null,
      createdAt: new Date("2026-08-20T12:20:00.000Z"),
      updatedAt: postBatchCompletedAt,
      batch: {
        id: "batch-after-marker",
        status: "RETRYABLE_FAILED",
        revision: 3,
        ownerAutomationRunId: null,
        baseSha: priorRuntime,
        releaseSha: priorRuntime,
        deployedAt,
        createdAt: new Date("2026-08-20T12:19:00.000Z"),
        updatedAt: postBatchCompletedAt,
        recheckDispatchKey: null,
        recheckDispatchStartedAt: null,
        recheckDispatchedAt: null,
        completedAt: postBatchCompletedAt,
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
                  workMode: "DISCOVERY_ONLY",
                  strategyAction: "DISCOVER_WITH_BROWSER",
                  playbookStage: "RENDERED_BROWSER_DISCOVERY",
                },
              },
            ],
          },
        },
        ownerAutomationRun: null,
      },
      verificationRequests: [],
    });
    const priorHistory = assessParkedCourseCampaignSameCycleRecoveryHistory({
      courseId: "course-1",
      cycle: 4,
      entries: [preMarkerEntry()] as never,
      requireOrchestrationOnly: false,
      requireStartedRequest: true,
      requireCausalStartedRequest: true,
      minimumStartedAt: admittedAt,
    });
    expect(priorHistory).not.toBeNull();
    const legacyPriorHistoryDigest =
      "1057174a76f2484fd640dd45ddb012ae1f9cf672d8ec0a5edd458b9db7320977";
    expect(priorHistory!.historyDigest).toBe(legacyPriorHistoryDigest);
    const endpointAudit = {
      cycle: 4,
      customerState: "NEEDS_HUMAN_REVIEW",
      playbookConclusion: "INCOMPLETE",
      playbookExhausted: false,
      automationStalled: true,
      parkedUntilMaterialChange: true,
      nextStage: "RENDERED_BROWSER_DISCOVERY",
      campaign: {
        kind: "PARKED_COHORT",
        runId: "campaign-run-1",
        membershipDigest: audit.membershipDigest,
        cycle: 4,
      },
      customerDataIncluded: false,
    };
    const makeRow = () =>
      campaignParkedRow({
        cycle: 4,
        revision: 10,
        attemptLedger,
        events: [
          {
            id: "endpoint-post-marker",
            incidentId: "incident-1",
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            failureFingerprint: "SOURCE:MISSING",
            readPath: null,
            occurredAt: parkedAt,
            audit: endpointAudit,
          },
          {
            id: "marker-incomplete-recovery",
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            readPath: null,
            occurredAt: priorMarkerAt,
            audit: {
              action: "parked_cohort_incomplete_playbook_recovery",
              admissionMode: "INCOMPLETE_PLAYBOOK_RECOVERY",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              capturedCycle: 3,
              cycle: 4,
              sameCycleRecoveryHistoryDigest: legacyPriorHistoryDigest,
              providerSnapshotFingerprint,
              attemptLedgerFingerprint,
              latestProbeAt: null,
              latestDiscoveryAt: null,
              playbookCompletedStageCount: 4,
              playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
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
            incidentId: "incident-1",
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            failureFingerprint: "SOURCE:MISSING",
            readPath: null,
            occurredAt: priorEndpointAt,
            audit: endpointAudit,
          },
          {
            id: "campaign-admission",
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint: "SOURCE:MISSING",
            readPath: null,
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              priorCycle: 3,
              cycle: 4,
              capturedIncidentRevision: 5,
              capturedMonitoringRevision: 9,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          },
        ],
        batchIncidents: [preMarkerEntry(), postMarkerEntry()],
      });
    const database = (row: ReturnType<typeof makeRow>) => {
      const findMany = vi.fn().mockResolvedValue([row]);
      return {
        database: { courseSupportIncident: { findMany } } as never,
        findMany,
      };
    };
    const makeBrowserAdapterRow = () => {
      const row = structuredClone(makeRow());
      const browserAdapterLedger = partialPlaybookLedger(4, 5);
      row.attemptLedger = browserAdapterLedger;
      const browserAdapterLedgerFingerprint =
        createParkedCourseCampaignAttemptLedgerFingerprint(
          browserAdapterLedger,
        );
      for (const event of [
        row.monitoringEvents[0]!,
        row.monitoringEvents[2]!,
      ]) {
        (event.audit as Record<string, unknown>).nextStage =
          "BROWSER_ADAPTER_RETRY";
      }
      const markerAudit = row.monitoringEvents[1]!.audit as Record<
        string,
        unknown
      >;
      markerAudit.attemptLedgerFingerprint = browserAdapterLedgerFingerprint;
      markerAudit.playbookCompletedStageCount = 5;
      markerAudit.playbookNextStage = "BROWSER_ADAPTER_RETRY";
      const summary = row.batchIncidents[1]!.batch.summary as {
        closeout: { remediationAttempts: Array<Record<string, unknown>> };
      };
      const approach = summary.closeout.remediationAttempts[0]!
        .approach as Record<string, unknown>;
      approach.workMode = "VERIFY_TRANSIENT";
      approach.strategyAction = "RUN_TYPED_ADAPTER";
      approach.playbookStage = "BROWSER_ADAPTER_RETRY";
      return row;
    };

    const positive = database(makeRow());
    const planned = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      positive.database,
      "campaign-run-1",
      currentRuntime,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
      capturedCycle: 3,
      cycle: 4,
      playbookCompletedStageCount: 4,
      playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
      latestProbeId: null,
      latestDiscoveryId: null,
    });
    expect(planned[0]?.sameCycleRecoveryHistoryDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(positive.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "incident-1", cycle: 4 },
        select: expect.objectContaining({
          batchIncidents: expect.objectContaining({ take: 21 }),
        }),
      }),
    );

    const browserAdapter = database(makeBrowserAdapterRow());
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        browserAdapter.database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
        capturedCycle: 3,
        cycle: 4,
        playbookCompletedStageCount: 5,
        playbookNextStage: "BROWSER_ADAPTER_RETRY",
      }),
    ]);

    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(makeRow()).database,
        "campaign-run-1",
        priorRuntime,
      ),
    ).resolves.toEqual([]);

    const historicalProbeAt = new Date("2026-08-19T12:00:00.000Z");
    const historicalAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [
        {
          ...captured,
          latestProbeAt: historicalProbeAt.toISOString(),
        },
      ],
    });
    const historicalPreProbe = makeRow();
    historicalPreProbe.monitoringEvents =
      historicalPreProbe.monitoringEvents.map((event) => ({
        ...event,
        audit: structuredClone(event.audit),
      }));
    historicalPreProbe.course.probes = [
      {
        id: "probe-before-marker",
        courseId: "course-1",
        observedAt: historicalProbeAt,
      },
    ];
    historicalPreProbe.batchIncidents[1]!.preProbeId = "probe-before-marker";
    for (const event of historicalPreProbe.monitoringEvents) {
      const eventAudit = event.audit as Record<string, unknown>;
      if ("campaignMembershipDigest" in eventAudit) {
        eventAudit.campaignMembershipDigest = historicalAudit.membershipDigest;
      }
      const campaign = eventAudit.campaign as
        Record<string, unknown> | undefined;
      if (campaign) {
        campaign.membershipDigest = historicalAudit.membershipDigest;
      }
    }
    const historicalMarkerAudit = historicalPreProbe.monitoringEvents[1]!
      .audit as Record<string, unknown>;
    historicalMarkerAudit.latestProbeAt = historicalProbeAt.toISOString();
    historicalMarkerAudit.latestProbeId = "probe-before-marker";
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        historicalAudit,
        database(historicalPreProbe).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
        latestProbeId: "probe-before-marker",
        latestProbeAt: historicalProbeAt.toISOString(),
      }),
    ]);

    const discoveryChangedBeforeMarker = makeRow();
    const preMarkerDiscoveryAt = new Date("2026-08-20T12:16:00.000Z");
    discoveryChangedBeforeMarker.course.automationDiscoveries = [
      {
        id: "discovery-before-marker",
        courseId: "course-1",
        createdAt: preMarkerDiscoveryAt,
      },
    ];
    const discoveryMarkerAudit = discoveryChangedBeforeMarker
      .monitoringEvents[1]!.audit as Record<string, unknown>;
    discoveryMarkerAudit.latestDiscoveryAt = preMarkerDiscoveryAt.toISOString();
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(discoveryChangedBeforeMarker).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
        latestDiscoveryId: "discovery-before-marker",
        latestDiscoveryAt: preMarkerDiscoveryAt.toISOString(),
      }),
    ]);

    const sameTimestampDiscoverySibling = structuredClone(
      discoveryChangedBeforeMarker,
    );
    sameTimestampDiscoverySibling.course.automationDiscoveries.push({
      id: "discovery-before-marker-sibling",
      courseId: "course-1",
      createdAt: preMarkerDiscoveryAt,
    });
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(sameTimestampDiscoverySibling).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([]);

    const probeMarkerWithoutIdentity = structuredClone(historicalPreProbe);
    delete (
      probeMarkerWithoutIdentity.monitoringEvents[1]!.audit as Record<
        string,
        unknown
      >
    ).latestProbeId;
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        historicalAudit,
        database(probeMarkerWithoutIdentity).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([]);

    const markerTimestampSiblingEvent = makeRow();
    markerTimestampSiblingEvent.monitoringEvents.push({
      id: "marker-timestamp-sibling",
      incidentId: "incident-1",
      eventType: "AUTOMATION_ATTEMPTED",
      source: "RECOVERY_CRON",
      failureFingerprint: "SOURCE:MISSING",
      readPath: null,
      occurredAt: priorMarkerAt,
      audit: { cycle: 4 },
    });
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(markerTimestampSiblingEvent).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([]);

    const failClosedMutations = [
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.deployedAt = null;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.deployedAt = priorMarkerAt;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.releaseSha = currentRuntime;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.createdAt = new Date(
          "2026-08-20T12:17:59.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests = [];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.verificationRequests.push({
          ...row.batchIncidents[0]!.verificationRequests[0]!,
          id: "late-post-marker-request",
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({ ...row.monitoringEvents[1]! });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          ...row.monitoringEvents[1]!,
          audit: {
            ...(row.monitoringEvents[1]!.audit as Record<string, unknown>),
            action: "parked_cohort_post_marker_incomplete_playbook_recovery",
          },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents[0]!.occurredAt = new Date(
          "2026-08-20T12:24:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.probes = [
          {
            id: "probe-after-marker",
            courseId: "course-1",
            observedAt: new Date("2026-08-20T12:19:00.000Z"),
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries = [
          {
            id: "discovery-after-marker",
            courseId: "course-1",
            createdAt: new Date("2026-08-20T12:19:00.000Z"),
          },
        ];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          id: "attempt-after-marker",
          incidentId: "incident-1",
          eventType: "AUTOMATION_ATTEMPTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: new Date("2026-08-20T12:19:00.000Z"),
          audit: { cycle: 4 },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          id: "attempt-at-endpoint",
          incidentId: "incident-1",
          eventType: "AUTOMATION_ATTEMPTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: parkedAt,
          audit: { cycle: 4 },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.push({
          id: "attempt-after-endpoint",
          incidentId: "incident-1",
          eventType: "AUTOMATION_ATTEMPTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: new Date("2026-08-20T12:31:00.000Z"),
          audit: { cycle: 4 },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.preProbeId = "pre-probe-residue";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.postProbeId = "post-probe-residue";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.proofSnapshot = { providerExecution: true };
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.verifiedIncidentUpdatedAt = new Date(
          "2026-08-20T12:24:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.verifiedAt = new Date(
          "2026-08-20T12:24:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.recheckDispatchKey = "dispatch-residue";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.recheckDispatchStartedAt = new Date(
          "2026-08-20T12:24:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.batch.recheckDispatchedAt = new Date(
          "2026-08-20T12:24:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        const marker = row.monitoringEvents[1]!.audit as Record<
          string,
          unknown
        >;
        marker.attemptLedgerFingerprint = "f".repeat(64);
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[1]!.batch.summary as {
          closeout: { remediationAttempts: Array<Record<string, unknown>> };
        };
        summary.closeout.remediationAttempts[0]!.consumed = true;
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[1]!.batch.summary as {
          closeout: { remediationAttempts: Array<Record<string, unknown>> };
        };
        const execution = summary.closeout.remediationAttempts[0]!
          .executionEvidence as Record<string, unknown>;
        execution.claimedImplementationPaths = true;
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[1]!.batch.summary as {
          closeout: { remediationAttempts: Array<Record<string, unknown>> };
        };
        const approach = summary.closeout.remediationAttempts[0]!
          .approach as Record<string, unknown>;
        delete approach.workMode;
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[1]!.batch.summary as {
          closeout: { remediationAttempts: Array<Record<string, unknown>> };
        };
        const approach = summary.closeout.remediationAttempts[0]!
          .approach as Record<string, unknown>;
        approach.strategyAction = "IMPLEMENT_PROVIDER_ADAPTER";
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[1]!.batch.summary as {
          closeout: { remediationAttempts: Array<Record<string, unknown>> };
        };
        const approach = summary.closeout.remediationAttempts[0]!
          .approach as Record<string, unknown>;
        approach.playbookStage = "BROWSER_ADAPTER_RETRY";
      },
    ];
    for (const mutate of failClosedMutations) {
      const row = makeRow();
      mutate(row);
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(row).database,
          "campaign-run-1",
          currentRuntime,
        ),
      ).resolves.toEqual([]);
    }

    const tooMany = makeRow();
    for (let ordinal = 0; ordinal < 19; ordinal += 1) {
      const extra = preMarkerEntry();
      extra.id = `extra-entry-${ordinal}`;
      extra.batchId = `extra-batch-${ordinal}`;
      extra.batch.id = `extra-batch-${ordinal}`;
      extra.verificationRequests[0]!.id = `extra-request-${ordinal}`;
      tooMany.batchIncidents.push(extra);
    }
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(tooMany).database,
        "campaign-run-1",
        currentRuntime,
      ),
    ).resolves.toEqual([]);
  });

  it("plans only the exact requestless stale-ownership campaign recovery", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const attemptedAt = admittedAt;
    const historicalProbeAt = new Date("2026-08-20T11:30:00.000Z");
    const historicalDiscoveryAt = new Date("2026-08-20T11:40:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const failureFingerprint = "ab".repeat(32);
    const attemptLedger = { version: 1, events: [] };
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      monitoringFailureFingerprint: failureFingerprint.toUpperCase(),
      failureFingerprint,
      providerSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: historicalProbeAt.toISOString(),
      latestDiscoveryAt: historicalDiscoveryAt.toISOString(),
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
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
    const makeRow = () => {
      const row = campaignParkedRow({
        cycle: 4,
        attemptLedger,
        failureFingerprint,
        probes: [
          {
            id: "probe-historical",
            courseId: "course-1",
            observedAt: historicalProbeAt,
          },
        ],
        discoveries: [
          {
            id: "discovery-historical",
            courseId: "course-1",
            createdAt: historicalDiscoveryAt,
          },
        ],
        events: [
          {
            incidentId: "incident-1",
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            failureFingerprint,
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
                membershipDigest: audit.membershipDigest,
                cycle: 4,
              },
              customerDataIncluded: false,
            },
          },
          {
            incidentId: "incident-1",
            eventType: "AUTOMATION_ATTEMPTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint,
            readPath: "BOUNDED_RECOVERY_PLAYBOOK",
            occurredAt: attemptedAt,
            audit: {
              providerFamilyKey: "SOURCE_MISSING",
              maxCourses: 5,
              serializedWriterLane: true,
              campaignKind: "PARKED_COHORT",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              cycle: 4,
              customerDataIncluded: false,
            },
          },
          {
            incidentId: "incident-1",
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            failureFingerprint,
            readPath: null,
            occurredAt: admittedAt,
            audit: {
              action: "parked_cohort_admission",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: audit.membershipDigest,
              priorCycle: 3,
              cycle: 4,
              capturedIncidentRevision: 5,
              capturedMonitoringRevision: 9,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          },
        ],
        batchIncidents: [
          {
            id: "batch-entry-stale",
            batchId: "batch-stale",
            incidentId: "incident-1",
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
                      membershipDigest: audit.membershipDigest,
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
        ],
      });
      row.course.monitoringStatus.failureFingerprint =
        failureFingerprint.toUpperCase();
      return row;
    };
    const database = (row: ReturnType<typeof makeRow>) =>
      ({
        courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
      }) as never;

    const planned = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      database(makeRow()),
      "campaign-run-1",
      "release-current",
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      admissionMode: "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY",
      capturedCycle: 3,
      cycle: 4,
      playbookCompletedStageCount: 0,
      playbookNextStage: "OFFICIAL_IDENTITY",
      zeroExecutionHistoryDigest: null,
      latestProbeId: "probe-historical",
      latestDiscoveryId: "discovery-historical",
    });
    expect(planned[0]?.sameCycleRecoveryHistoryDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const failClosedRows = [
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verificationRequests.push({
          id: "late-request",
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.releaseSha = "release-old";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.preProbeId = "probe-before";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.probes[0]!.observedAt = new Date("2026-08-20T11:31:00.000Z");
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.probes.unshift({
          id: "probe-new",
          courseId: "course-1",
          observedAt: new Date("2026-08-20T12:01:00.000Z"),
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries[0]!.courseId = "course-other";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries.unshift({
          id: "discovery-same-time-sibling",
          courseId: "course-1",
          createdAt: historicalDiscoveryAt,
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries[0]!.createdAt = new Date(
          "2026-08-20T12:01:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.course.automationDiscoveries = [];
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.postProbeId = "probe-after";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.proofSnapshot = { providerExecution: false };
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verifiedAt = parkedAt;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.verifiedIncidentUpdatedAt = parkedAt;
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents[1]!.occurredAt = new Date(
          "2026-08-20T12:04:00.000Z",
        );
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.ownerAutomationRun.notes =
          ownerNotes.replace('"needsHumanCount":1', '"needsHumanCount":2');
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[0]!.batch.summary as Record<
          string,
          unknown
        >;
        summary.closeout = { ...closeout, orchestrationRetryCount: 0 };
      },
      (row: ReturnType<typeof makeRow>) => {
        const summary = row.batchIncidents[0]!.batch.summary as Record<
          string,
          unknown
        >;
        summary.closeout = { ...closeout, orchestrationOnlyCourseRefs: [] };
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.ownerAutomationRun.notes = JSON.stringify({
          ...JSON.parse(ownerNotes),
          orchestrationRetryCount: 0,
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        (
          row.monitoringEvents[2]!.audit as Record<string, unknown>
        ).admissionRuntimeVersion = "release-old";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[0]!.batch.ownerAutomationRun.runtimeVersion =
          "release-other";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.monitoringEvents.unshift({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: "SOURCE:MISSING",
          readPath: null,
          occurredAt: new Date("2026-08-20T12:31:00.000Z"),
          audit: {
            action: "parked_cohort_requestless_stale_ownership_recovery",
            campaignRunId: "campaign-run-1",
            cycle: 4,
          },
        });
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents.push({
          ...row.batchIncidents[0]!,
          id: "batch-entry-extra",
        });
      },
    ];
    for (const mutate of failClosedRows) {
      const row = makeRow();
      mutate(row);
      await expect(
        loadParkedCourseCampaignAdmissionMembers(
          audit,
          database(row),
          "campaign-run-1",
          "release-current",
        ),
      ).resolves.toEqual([]);
    }
    const notPreCaptureMember = {
      ...captured,
      latestProbeAt: capturedAt.toISOString(),
    };
    const notPreCaptureAudit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [notPreCaptureMember],
    });
    const notPreCaptureRow = makeRow();
    notPreCaptureRow.course.probes = [
      {
        id: "probe-historical",
        courseId: "course-1",
        observedAt: capturedAt,
      },
    ];
    const endpointAudit = notPreCaptureRow.monitoringEvents[0]!.audit as Record<
      string,
      unknown
    >;
    (endpointAudit.campaign as Record<string, unknown>).membershipDigest =
      notPreCaptureAudit.membershipDigest;
    const attemptAudit = notPreCaptureRow.monitoringEvents[1]!.audit as Record<
      string,
      unknown
    >;
    attemptAudit.campaignMembershipDigest = notPreCaptureAudit.membershipDigest;
    const admissionAudit = notPreCaptureRow.monitoringEvents[2]!
      .audit as Record<string, unknown>;
    admissionAudit.campaignMembershipDigest =
      notPreCaptureAudit.membershipDigest;
    const notPreCaptureSummary = notPreCaptureRow.batchIncidents[0]!.batch
      .summary as {
      campaign: { attempts: Array<Record<string, unknown>> };
    };
    notPreCaptureSummary.campaign.attempts[0]!.membershipDigest =
      notPreCaptureAudit.membershipDigest;
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        notPreCaptureAudit,
        database(notPreCaptureRow),
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([]);
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database(makeRow()),
        "campaign-run-1",
        "release-old",
      ),
    ).resolves.toEqual([]);
  });

  it("plans one current-cycle orchestration retry from durable operator material-change evidence", async () => {
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const operatorAt = new Date("2026-08-20T12:10:00.000Z");
    const handoffAt = new Date("2026-08-20T12:20:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const orchestrationSummary = (attemptsCompleted: number) => ({
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
    });
    const row = campaignParkedRow({
      cycle: 5,
      attemptLedger: { version: 1, events: [] },
      events: [
        {
          incidentId: "incident-1",
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
          incidentId: "incident-1",
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
          incidentId: "incident-1",
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
      batchIncidents: [1, 2].map((attemptsCompleted) => ({
        id: `batch-entry-${attemptsCompleted}`,
        cycle: 5,
        result: attemptsCompleted === 1 ? "RETRY_SCHEDULED" : "NEEDS_HUMAN",
        batch: {
          baseSha: "release-old",
          releaseSha: "release-old",
          completedAt: new Date(`2026-08-20T12:2${attemptsCompleted}:00.000Z`),
          summary: orchestrationSummary(attemptsCompleted),
        },
        verificationRequests: [],
      })),
    });
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      providerSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(null),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: null,
      latestDiscoveryAt: null,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const database = {
      courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
    } as never;

    const members = await loadParkedCourseCampaignAdmissionMembers(
      audit,
      database,
      "campaign-run-1",
      "release-current",
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      admissionMode: "CURRENT_CYCLE_ORCHESTRATION_RECOVERY",
      capturedCycle: 3,
      cycle: 5,
      playbookCompletedStageCount: 0,
      playbookNextStage: "OFFICIAL_IDENTITY",
      zeroExecutionHistoryDigest: null,
    });
    expect(members[0]?.sameCycleRecoveryHistoryDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    row.monitoringEvents.unshift({
      incidentId: "incident-1",
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      failureFingerprint: "SOURCE:MISSING",
      occurredAt: new Date("2026-08-20T12:35:00.000Z"),
      audit: {
        action: "parked_cohort_current_cycle_orchestration_recovery",
        campaignRunId: "campaign-run-1",
        cycle: 5,
      },
    });
    await expect(
      loadParkedCourseCampaignAdmissionMembers(
        audit,
        database,
        "campaign-run-1",
        "release-current",
      ),
    ).resolves.toEqual([]);
  });

  it("hashes attempt ledgers canonically so object key order is not material", () => {
    expect(
      createParkedCourseCampaignAttemptLedgerFingerprint({
        version: 1,
        nested: { beta: 2, alpha: 1 },
      }),
    ).toBe(
      createParkedCourseCampaignAttemptLedgerFingerprint({
        nested: { alpha: 1, beta: 2 },
        version: 1,
      }),
    );
  });

  it.each([
    ["SOURCE_MISSING", "SOURCE_MISSING"],
    ["SOURCE_CONFLICT", "SOURCE_CONFLICT"],
    ["CHRONOGOLF", "PROVIDER_SPECIFIC"],
    ["booking.course.example", "PROVIDER_SPECIFIC"],
  ] as const)(
    "projects provider family %j to report-safe category %s",
    (providerFamilyKey, expected) => {
      expect(getReportSafeProviderFamilyCategory(providerFamilyKey)).toBe(
        expected,
      );
    },
  );

  it("creates a deterministic immutable membership digest and rejects tampering", () => {
    const members = [member(2), member(1)];
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 2,
      capturedAt,
      members,
    });

    expect(audit.members.map((entry) => entry.courseId)).toEqual([
      "course-1",
      "course-2",
    ]);
    expect(audit.schemaVersion).toBe(2);
    expect(audit.membershipDigest).toBe(
      createParkedCourseCampaignMembershipDigest(members),
    );
    expect(audit.aggregateEvidenceCategories).toEqual({
      sourceMissingCount: 2,
      sourceConflictCount: 0,
      providerSpecificCount: 0,
      priorProbeCount: 2,
      priorDiscoveryCount: 2,
      noPriorEvidenceCount: 0,
    });
    expect(summarizeCampaignEvidenceCategories(audit.members)).toEqual(
      audit.aggregateEvidenceCategories,
    );
    expect(parseParkedCourseCampaignAudit(audit)).toEqual(audit);
    expect(
      createParkedCourseCampaignMembershipDigest([
        member(1, { monitoringFailureFingerprint: "SOURCE:LEGACY" }),
      ]),
    ).not.toBe(createParkedCourseCampaignMembershipDigest([member(1)]));
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        members: [{ ...audit.members[0], revision: 8 }, audit.members[1]],
      }),
    ).toBeNull();
    expect(
      parseParkedCourseCampaignAudit({
        ...audit,
        aggregateEvidenceCategories: {
          ...audit.aggregateEvidenceCategories,
          sourceMissingCount: 1,
        },
      }),
    ).toBeNull();
  });

  it("keeps a count-mismatched dry run read-only and returns its snapshot digest", async () => {
    const { dependencies } = campaignDependencies({
      members: [member(1), member(2)],
    });

    const result = await runParkedCourseCampaignCommand(
      { apply: false, expectedCount: 112, now: capturedAt },
      dependencies,
    );

    expect(result).toMatchObject({
      mode: "dry-run",
      campaignState: "PREVIEW",
      expectedCount: 112,
      capturedCount: 2,
      countMatches: false,
    });
    expect(result.membershipDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(dependencies.createCampaign).not.toHaveBeenCalled();
    expect(dependencies.withTransitionLease).not.toHaveBeenCalled();
  });

  it("requires the exact dry-run digest before creating one durable run", async () => {
    const members = Array.from({ length: 112 }, (_, index) =>
      member(index + 1),
    );
    const { dependencies } = campaignDependencies({ members });
    const membershipDigest =
      createParkedCourseCampaignMembershipDigest(members);

    await expect(
      runParkedCourseCampaignCommand(
        {
          apply: true,
          expectedCount: 112,
          expectedDigest: "0".repeat(64),
          now: capturedAt,
        },
        dependencies,
      ),
    ).rejects.toThrow("changed after dry run");
    expect(dependencies.createCampaign).not.toHaveBeenCalled();

    const result = await runParkedCourseCampaignCommand(
      {
        apply: true,
        expectedCount: 112,
        expectedDigest: membershipDigest,
        now: capturedAt,
      },
      dependencies,
    );

    expect(result).toMatchObject({
      mode: "apply",
      campaignState: "ACTIVE",
      capturedCount: 112,
      membershipDigest,
    });
    expect(dependencies.createCampaign).toHaveBeenCalledTimes(1);
  });

  it("rejects changing the immutable production baseline count", async () => {
    const { dependencies } = campaignDependencies({ members: [member(1)] });

    await expect(
      runParkedCourseCampaignCommand(
        { apply: false, expectedCount: 111, now: capturedAt },
        dependencies,
      ),
    ).rejects.toThrow("immutable baseline of 112");
    expect(dependencies.loadParkedMembers).not.toHaveBeenCalled();
  });

  it("reports exclusive progress buckets and append-only human intervention", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 5,
      capturedAt,
      members: [member(1), member(2), member(3), member(4), member(5)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 7,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null,
          },
        }),
        observation(2, {
          status: "RESOLVED",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
          resolvedAt: new Date("2026-08-20T14:00:00.000Z"),
          decisionAt: new Date("2026-08-20T13:50:00.000Z"),
          monitoringState: "FINAL_TECHNICAL",
          humanReviewCycles: [4],
        }),
        observation(3, {
          currentlyParked: true,
          cycle: 3,
          status: "NEEDS_HUMAN",
        }),
        observation(4),
      ],
    });

    expect(progress).toMatchObject({
      totalCount: 5,
      terminalCount: 2,
      readyCount: 1,
      activeCount: 1,
      engineeringBlockerCount: 1,
      currentResultMissingCount: 0,
      terminalWithin24HoursCount: 2,
      automaticWithin24HoursCount: 1,
      humanReviewCount: 1,
      remainingGlobalParkedCount: 7,
    });
    expect(
      progress.terminalCount +
        progress.readyCount +
        progress.activeCount +
        progress.engineeringBlockerCount +
        progress.currentResultMissingCount,
    ).toBe(progress.totalCount);
  });

  it("does not accept a resolution from the captured parked cycle as fresh proof", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          cycle: 3,
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
        }),
      ],
    });

    expect(progress.terminalCount).toBe(0);
    expect(progress.engineeringBlockerCount).toBe(1);
  });

  it("reconciles only an exact DB-loaded legacy factual terminal carrier", async () => {
    const campaignRunId = "campaign-run-legacy";
    const releaseSha = "a".repeat(40);
    const confirmedAt = new Date("2026-08-20T12:01:00.000Z");
    const deployedAt = new Date("2026-08-20T12:02:00.000Z");
    const dispatchStartedAt = new Date("2026-08-20T12:03:00.000Z");
    const verifiedAt = new Date("2026-08-20T12:06:00.000Z");
    const closeoutAt = new Date("2026-08-20T12:07:00.000Z");
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const event = {
      id: "legacy-terminal-event",
      incidentId: "incident-1",
      courseId: "course-1",
      eventType: "STATE_CHANGED",
      source: "COURSE_SUPPORT_RESPONDER",
      fromState: "AUTO_INVESTIGATING",
      toState: "FINAL_IDENTITY",
      occurredAt: closeoutAt,
      outcome: null,
      runtimeVersion: releaseSha,
      deploymentSha: releaseSha,
      audit: {
        automatedFinal: true,
        finalKind: "identity",
        customerDataIncluded: false,
        cycle: 4,
        confirmedAt: confirmedAt.toISOString(),
        campaign: {
          kind: "PARKED_COHORT",
          runId: campaignRunId,
          membershipDigest: audit.membershipDigest,
          cycle: 4,
        },
      },
    };
    const incident = {
      id: "incident-1",
      courseId: "course-1",
      cycle: 4,
      status: "RESOLVED",
      activeBatchId: null,
      confirmedAt,
      firstSeenAt: new Date("2026-08-19T12:00:00.000Z"),
      providerFamilyKey: "CPS",
      failureClass: "MISSING_METADATA",
      attemptCount: 1,
      activeRealSearchCount: 0,
      attemptLedger: null,
      resolution: "IDENTITY_CLASSIFIED",
      resolvedAt: closeoutAt,
      decisionAt: null,
      monitoringEvents: [event],
      course: {
        monitoringStatus: {
          state: "FINAL_IDENTITY",
          stateChangedAt: closeoutAt,
        },
        probes: [],
      },
    };
    const entry = {
      id: "legacy-terminal-entry",
      batchId: "legacy-terminal-batch",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 4,
      result: "FINAL_DISPOSITION",
      proofSnapshot: {
        kind: "EXACT_PLACE_REVIEW",
        disposition: "VERIFIED_NON_COURSE",
        classification: "PRIVATE_PRACTICE_GREEN",
        evidenceOrigin: "https://course.example",
        reviewedAt: "2026-08-20T00:00:00.000Z",
        reviewUpdatedAt: "2026-08-20T12:04:00.000Z",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
      },
      verifiedAt,
      verifiedIncidentUpdatedAt: new Date("2026-08-20T12:05:00.000Z"),
      createdAt: new Date("2026-08-20T12:00:30.000Z"),
      updatedAt: verifiedAt,
      batch: {
        id: "legacy-terminal-batch",
        status: "SUCCEEDED",
        createdAt: new Date("2026-08-20T12:00:30.000Z"),
        completedAt: closeoutAt,
        releaseSha,
        deployedAt,
        recheckDispatchStartedAt: dispatchStartedAt,
        summary: {
          campaign: {
            kind: "PARKED_COHORT",
            attempts: [
              {
                courseRef,
                runId: campaignRunId,
                membershipDigest: audit.membershipDigest,
                cycle: 4,
              },
            ],
          },
        },
      },
    };
    const incidentFindMany = vi.fn().mockResolvedValue([incident]);
    const batchIncidentFindMany = vi.fn();
    const loadObservations = (batchEntry: typeof entry) => {
      batchIncidentFindMany.mockResolvedValueOnce([batchEntry]);
      return loadCampaignMemberObservations(audit, new Set(), campaignRunId, {
        courseSupportIncident: {
          findMany: incidentFindMany,
        },
        courseSupportBatchIncident: {
          findMany: batchIncidentFindMany,
        },
      } as never);
    };

    const exactObservations = await loadObservations(entry);
    expect(batchIncidentFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ incidentId: "incident-1", cycle: 4 }],
          batch: expect.objectContaining({ completedAt: { gte: capturedAt } }),
        }),
      }),
    );
    expect(exactObservations).toEqual([
      expect.objectContaining({
        campaignTerminalFreshRuntimeProof: true,
        campaignTerminalAutomatedFinal: true,
      }),
    ]);
    expect(
      summarizeParkedCourseCampaignProgress({
        audit,
        observations: exactObservations,
        remainingGlobalParkedCount: 0,
      }),
    ).toMatchObject({
      terminalCount: 1,
      factualLimitationCount: 1,
      engineeringBlockerCount: 0,
    });

    const mismatchedEntry = structuredClone(entry);
    mismatchedEntry.batch.releaseSha = "b".repeat(40);
    const mismatchedObservations = await loadObservations(mismatchedEntry);
    expect(mismatchedObservations).toEqual([
      expect.objectContaining({ campaignTerminalFreshRuntimeProof: false }),
    ]);
    expect(
      summarizeParkedCourseCampaignProgress({
        audit,
        observations: mismatchedObservations,
        remainingGlobalParkedCount: 0,
      }),
    ).toMatchObject({
      terminalCount: 0,
      factualLimitationCount: 0,
      engineeringBlockerCount: 1,
    });
  });

  it("requires fresh terminal evidence and a current-runtime read for recovery", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const base = observation(1, {
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
      monitoringState: "HEALTHY",
      latestProbe: {
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-20T12:50:00.000Z"),
        runtimeVersion: "release-1",
        rawSummary: null,
      },
    });

    for (const changed of [
      { ...base, campaignTerminalEvidenceAt: null },
      {
        ...base,
        campaignTerminalEvidenceAt: new Date("2026-08-20T11:59:59.000Z"),
      },
      { ...base, campaignTerminalRuntimeVersion: "release-2" },
      { ...base, latestProbe: null },
      {
        ...base,
        latestProbe: {
          outcome: "NO_MATCH",
          observedAt: new Date("2026-08-20T12:50:00.000Z"),
          runtimeVersion: null,
          rawSummary: null,
        },
      },
      {
        ...base,
        latestProbe: {
          outcome: "NO_MATCH",
          observedAt: new Date("2026-08-20T12:00:30.000Z"),
          runtimeVersion: "release-1",
          rawSummary: null,
        },
      },
    ]) {
      const progress = summarizeParkedCourseCampaignProgress({
        audit,
        remainingGlobalParkedCount: 0,
        observations: [changed],
      });
      expect(progress.terminalCount).toBe(0);
      expect(progress.engineeringBlockerCount).toBe(1);
    }
  });

  it("accepts an exact fresh responder terminal read when no CourseProbe row was needed", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: null,
          campaignTerminalOutcome: "NO_MATCH",
          campaignTerminalFreshRuntimeProof: true,
        }),
      ],
    });

    expect(progress.terminalCount).toBe(1);
    expect(progress.monitoredCount).toBe(1);
  });

  it("keeps the campaign running when atomic completion revalidation declines", async () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const { dependencies } = campaignDependencies({
      members: [],
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null,
          },
        }),
      ],
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit,
    });
    dependencies.completeCampaign.mockResolvedValue(false);

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies,
    );

    expect(result).toMatchObject({
      status: "RUNNING",
      terminalCount: 1,
      totalCount: 1,
    });
    expect(dependencies.completeCampaign).toHaveBeenCalledTimes(1);
  });

  it("does not complete while generic parked waiting remains outside the baseline", async () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const { dependencies } = campaignDependencies({
      members: [member(2)],
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "HEALTHY",
          latestProbe: {
            outcome: "NO_MATCH",
            observedAt: new Date("2026-08-20T12:50:00.000Z"),
            runtimeVersion: "release-1",
            rawSummary: null,
          },
        }),
      ],
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit,
    });

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies,
    );

    expect(result).toMatchObject({
      status: "RUNNING",
      terminalCount: 1,
      totalCount: 1,
      remainingGlobalParkedCount: 1,
    });
    expect(dependencies.completeCampaign).not.toHaveBeenCalled();
  });

  it("counts a revision-churned and case-normalized captured row in the global parked invariant", async () => {
    const canonicalFingerprint = "ab".repeat(32);
    const captured = member(1, {
      monitoringFailureFingerprint: canonicalFingerprint,
      failureFingerprint: canonicalFingerprint,
    });
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const current = member(1, {
      revision: 9,
      monitoringRevision: 13,
      monitoringFailureFingerprint: canonicalFingerprint.toUpperCase(),
      failureFingerprint: canonicalFingerprint,
    });
    const { dependencies } = campaignDependencies({
      members: [],
      allMembers: [current],
      observations: [
        observation(1, {
          cycle: 3,
          status: "NEEDS_HUMAN",
          currentlyParked: true,
        }),
      ],
    });
    dependencies.loadActiveCampaign.mockResolvedValue({
      id: "campaign-run-1",
      status: "RUNNING",
      completedAt: null,
      outcome: null,
      audit,
    });

    const result = await inspectActiveParkedCourseCampaign(
      { completeIfDone: true },
      dependencies,
    );

    expect(result).toMatchObject({
      status: "RUNNING",
      readyCount: 1,
      remainingGlobalParkedCount: 1,
    });
    expect(dependencies.loadAllParkedMembers).toHaveBeenCalledTimes(1);
    expect(dependencies.loadGlobalParkedCount).toHaveBeenCalledTimes(1);
    expect(dependencies.loadMemberObservations).toHaveBeenCalledWith(
      audit,
      new Set(["course-1"]),
      "campaign-run-1",
    );
    expect(dependencies.completeCampaign).not.toHaveBeenCalled();
  });

  it("does not count an operator-tagged final as automatic when decisionAt is absent", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          decisionAt: null,
          monitoringState: "FINAL_MANUAL",
          campaignTerminalAutomatedFinal: false,
        }),
      ],
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      automaticWithin24HoursCount: 0,
      humanReviewCount: 1,
    });
  });

  it("keeps append-only human cycle evidence from regaining automatic credit", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          decisionAt: null,
          monitoringState: "FINAL_MANUAL",
          campaignTerminalAutomatedFinal: true,
          humanReviewCycles: [4],
        }),
      ],
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      automaticWithin24HoursCount: 0,
      humanReviewCount: 1,
    });
  });

  it("trusts only fully attributed descendant recovery markers", () => {
    const membershipDigest = "c".repeat(64);
    const parked = {
      id: "descendant-endpoint",
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      occurredAt: new Date("2026-08-20T12:20:00.000Z"),
      audit: {
        cycle: 6,
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    };
    const marker = {
      action: "parked_cohort_descendant_incomplete_playbook_recovery",
      admissionMode: "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      cycle: 6,
      descendantLineageDigest: "d".repeat(64),
      descendantHandoffCount: 2,
      sameCycleRecoveryHistoryDigest: "e".repeat(64),
      providerSnapshotFingerprint: "f".repeat(64),
      attemptLedgerFingerprint: "a".repeat(64),
      batchCount: 1,
      startedRequestCount: null,
      playbookCompletedStageCount: 5,
      playbookNextStage: "BROWSER_ADAPTER_RETRY",
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
        membershipDigest,
        cycle: 6,
      },
    };
    const markerEvent = {
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: new Date("2026-08-20T12:25:00.000Z"),
      audit: marker,
    };
    const humanCycles = (event = markerEvent) =>
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [parked, event],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      });

    expect(humanCycles()).toEqual([]);
    expect(humanCycles({ ...markerEvent, source: "OPERATOR_CLI" })).toEqual([
      6,
    ]);
    expect(
      humanCycles({
        ...markerEvent,
        audit: { ...marker, preservesOperatorEvidence: false },
      }),
    ).toEqual([6]);
    expect(
      humanCycles({
        ...markerEvent,
        audit: {
          ...marker,
          campaign: { ...marker.campaign, runId: "different-run" },
        },
      }),
    ).toEqual([6]);

    expect(
      humanCycles({
        ...markerEvent,
        audit: {
          ...marker,
          startedRequestCount: 0,
          requestCount: 0,
          playbookCompletedStageCount: 0,
          playbookNextStage: "OFFICIAL_IDENTITY",
          zeroProgressOrchestrationOnly: true,
          releaseEvidenceAbsent: true,
          executionEvidenceAbsent: true,
        },
      }),
    ).toEqual([]);
  });

  it("does not count superseded zero-execution infrastructure parking as human intervention", () => {
    const parkedAt = new Date("2026-08-20T12:20:00.000Z");
    const recoveredAt = new Date("2026-08-20T12:25:00.000Z");
    const membershipDigest = "c".repeat(64);
    const events = [
      {
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        occurredAt: parkedAt,
        audit: {
          cycle: 4,
          automationStalled: true,
          parkedUntilMaterialChange: true,
          playbookExhausted: false,
        },
      },
      {
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        occurredAt: recoveredAt,
        audit: {
          action: "parked_cohort_zero_execution_recovery",
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: membershipDigest,
          cycle: 4,
          sameCycleRecovery: true,
          oneShot: true,
          zeroExecutionHistoryDigest: "d".repeat(64),
        },
      },
    ];
    const humanReviewCycles = deriveParkedCourseCampaignHumanReviewCycles({
      events,
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
    });
    expect(humanReviewCycles).toEqual([]);

    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "FINAL_MANUAL",
          humanReviewCycles,
        }),
      ],
    });
    expect(progress).toMatchObject({
      terminalCount: 1,
      humanReviewCount: 0,
      automaticWithin24HoursCount: 1,
    });
  });

  it("suppresses only the automated park superseded by an exact requestless stale-ownership marker", () => {
    const membershipDigest = "c".repeat(64);
    const marker = {
      action: "parked_cohort_requestless_stale_ownership_recovery",
      admissionMode: "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      cycle: 4,
      sameCycleRecovery: true,
      oneShot: true,
      sameCycleRecoveryHistoryDigest: "d".repeat(64),
      abandonedBaseRuntime: "release-old",
      recoveryRuntimeVersion: "release-current",
      requestCount: 0,
      releaseEvidenceAbsent: true,
      executionEvidenceAbsent: true,
      preservesAttemptLedger: true,
      preservesAttemptCounts: true,
      preservesAttemptTimestamps: true,
      preservesImmutableCampaignAudit: true,
    };
    const parked = {
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      occurredAt: new Date("2026-08-20T12:20:00.000Z"),
      audit: {
        cycle: 4,
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    };
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          parked,
          {
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            occurredAt: new Date("2026-08-20T12:25:00.000Z"),
            audit: marker,
          },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          parked,
          {
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            occurredAt: new Date("2026-08-20T12:25:00.000Z"),
            audit: { ...marker, requestCount: 1 },
          },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([4]);
  });

  it("trusts only the fully shaped +2 marker and suppresses only its exact automated endpoint", () => {
    const membershipDigest = "c".repeat(64);
    const supersededEndpointAt = new Date("2026-08-20T12:20:00.000Z");
    const earlierAutomatedPark = {
      id: "endpoint-earlier",
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      occurredAt: new Date("2026-08-20T12:15:00.000Z"),
      audit: {
        cycle: 5,
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    };
    const supersededEndpoint = {
      ...earlierAutomatedPark,
      id: "endpoint-superseded",
      occurredAt: supersededEndpointAt,
    };
    const marker = {
      action:
        "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
      admissionMode:
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      cycle: 5,
      sameCycleRecovery: true,
      oneShot: true,
      sameCycleRecoveryHistoryDigest: "d".repeat(64),
      materialChangeLineageDigest: "e".repeat(64),
      providerSnapshotFingerprint: "f".repeat(64),
      attemptLedgerFingerprint: "a".repeat(64),
      batchCount: 3,
      startedRequestCount: 1,
      playbookCompletedStageCount: 4,
      playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
      supersededEndpointId: "endpoint-superseded",
      supersededEndpointAt: supersededEndpointAt.toISOString(),
      customerDataIncluded: false,
      preservesOperatorEvidence: true,
      preservesAttemptLedger: true,
      preservesAttemptCounts: true,
      preservesAttemptTimestamps: true,
      preservesImmutableCampaignAudit: true,
      campaign: {
        kind: "PARKED_COHORT",
        runId: "campaign-run-1",
        membershipDigest,
        cycle: 5,
      },
    };
    const markerEvent = {
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: new Date("2026-08-20T12:25:00.000Z"),
      audit: marker,
    };

    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [supersededEndpoint, markerEvent],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [earlierAutomatedPark, supersededEndpoint, markerEvent],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([5]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          supersededEndpoint,
          markerEvent,
          {
            id: "operator-material-change",
            eventType: "REVALIDATION_REQUESTED",
            source: "OPERATOR_CLI",
            occurredAt: new Date("2026-08-20T12:10:00.000Z"),
            audit: { cycle: 5, providerEvidenceChanged: true },
          },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([5]);
    for (const malformedAudit of [
      { ...marker, customerDataIncluded: true },
      { ...marker, preservesOperatorEvidence: false },
      {
        ...marker,
        campaign: { ...marker.campaign, runId: "different-run" },
      },
      {
        ...marker,
        campaign: { ...marker.campaign, membershipDigest: "b".repeat(64) },
      },
      { ...marker, campaign: { ...marker.campaign, cycle: 4 } },
    ]) {
      expect(
        deriveParkedCourseCampaignHumanReviewCycles({
          events: [
            supersededEndpoint,
            { ...markerEvent, audit: malformedAudit },
          ],
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: membershipDigest,
        }),
      ).toEqual([5]);
    }
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          supersededEndpoint,
          { ...markerEvent, audit: { ...marker, startedRequestCount: 0 } },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([5]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          supersededEndpoint,
          { ...markerEvent, source: "OPERATOR_CLI" },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([5]);
  });

  it("suppresses only the exact post-marker machine endpoint and preserves operator evidence", () => {
    const membershipDigest = "c".repeat(64);
    const supersededEndpointAt = new Date("2026-08-20T12:30:00.000Z");
    const automatedEndpoint = {
      id: "endpoint-post-marker",
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      occurredAt: supersededEndpointAt,
      audit: {
        cycle: 4,
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    };
    const marker = {
      action: "parked_cohort_post_marker_incomplete_playbook_recovery",
      admissionMode: "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY",
      campaignRunId: "campaign-run-1",
      campaignMembershipDigest: membershipDigest,
      cycle: 4,
      sameCycleRecovery: true,
      oneShot: true,
      sameCycleRecoveryHistoryDigest: "d".repeat(64),
      priorRecoveryMarkerDigest: "e".repeat(64),
      priorRecoveryRuntimeVersion: "a".repeat(40),
      recoveryRuntimeVersion: "b".repeat(40),
      failedRuntimeVersions: ["a".repeat(40)],
      postMarkerHistoryDigest: "f".repeat(64),
      postMarkerBatchCount: 1,
      postMarkerRequestCount: 0,
      providerSnapshotFingerprint: "1".repeat(64),
      attemptLedgerFingerprint: "2".repeat(64),
      batchCount: 2,
      startedRequestCount: 1,
      playbookCompletedStageCount: 4,
      playbookNextStage: "RENDERED_BROWSER_DISCOVERY",
      supersededEndpointId: "endpoint-post-marker",
      supersededEndpointAt: supersededEndpointAt.toISOString(),
      customerDataIncluded: false,
      preservesOperatorEvidence: true,
      preservesAttemptLedger: true,
      preservesAttemptCounts: true,
      preservesAttemptTimestamps: true,
      preservesImmutableCampaignAudit: true,
      campaign: {
        kind: "PARKED_COHORT",
        runId: "campaign-run-1",
        membershipDigest,
        cycle: 4,
      },
    };
    const markerEvent = {
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: new Date("2026-08-20T13:00:00.000Z"),
      audit: marker,
    };
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [automatedEndpoint, markerEvent],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          {
            ...automatedEndpoint,
            occurredAt: new Date("2026-08-20T12:29:00.000Z"),
          },
          automatedEndpoint,
          markerEvent,
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([4]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          automatedEndpoint,
          { ...automatedEndpoint, id: "endpoint-same-time-other" },
          markerEvent,
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([4]);
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          automatedEndpoint,
          markerEvent,
          {
            eventType: "REVALIDATION_REQUESTED",
            source: "OPERATOR_CLI",
            occurredAt: new Date("2026-08-20T12:45:00.000Z"),
            audit: { cycle: 4 },
          },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: membershipDigest,
      }),
    ).toEqual([4]);
    for (const malformedMarker of [
      { ...marker, postMarkerBatchCount: 2 },
      { ...marker, postMarkerRequestCount: 1 },
      { ...marker, preservesOperatorEvidence: false },
      {
        ...marker,
        campaign: { ...marker.campaign, membershipDigest: "9".repeat(64) },
      },
    ]) {
      expect(
        deriveParkedCourseCampaignHumanReviewCycles({
          events: [
            automatedEndpoint,
            { ...markerEvent, audit: malformedMarker },
          ],
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: membershipDigest,
        }),
      ).toEqual([4]);
    }
  });

  it.each([
    {
      name: "an actual human decision",
      event: {
        eventType: "HUMAN_DECISION",
        source: "OPERATOR_CLI",
        occurredAt: new Date("2026-08-20T12:21:00.000Z"),
        audit: { cycle: 4 },
      },
    },
    {
      name: "an exhausted playbook request",
      event: {
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        occurredAt: new Date("2026-08-20T12:21:00.000Z"),
        audit: {
          cycle: 4,
          automationStalled: true,
          parkedUntilMaterialChange: true,
          playbookExhausted: true,
        },
      },
    },
    {
      name: "a request after recovery",
      event: {
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: "RECOVERY_CRON",
        occurredAt: new Date("2026-08-20T12:31:00.000Z"),
        audit: {
          cycle: 4,
          automationStalled: true,
          parkedUntilMaterialChange: true,
          playbookExhausted: false,
        },
      },
    },
  ])(
    "retains $name after a same-cycle infrastructure recovery",
    ({ event }) => {
      const membershipDigest = "c".repeat(64);
      expect(
        deriveParkedCourseCampaignHumanReviewCycles({
          events: [
            event,
            {
              eventType: "REVALIDATION_REQUESTED",
              source: "COURSE_SUPPORT_RESPONDER",
              occurredAt: new Date("2026-08-20T12:30:00.000Z"),
              audit: {
                action: "parked_cohort_zero_execution_recovery",
                campaignRunId: "campaign-run-1",
                campaignMembershipDigest: membershipDigest,
                cycle: 4,
                sameCycleRecovery: true,
                oneShot: true,
                zeroExecutionHistoryDigest: "d".repeat(64),
              },
            },
          ],
          campaignRunId: "campaign-run-1",
          campaignMembershipDigest: membershipDigest,
        }),
      ).toEqual([4]);
    },
  );

  it("does not trust a mismatched recovery marker for human-review accounting", () => {
    expect(
      deriveParkedCourseCampaignHumanReviewCycles({
        events: [
          {
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            occurredAt: new Date("2026-08-20T12:20:00.000Z"),
            audit: {
              cycle: 4,
              automationStalled: true,
              parkedUntilMaterialChange: true,
              playbookExhausted: false,
            },
          },
          {
            eventType: "REVALIDATION_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            occurredAt: new Date("2026-08-20T12:30:00.000Z"),
            audit: {
              action: "parked_cohort_zero_execution_recovery",
              campaignRunId: "campaign-run-1",
              campaignMembershipDigest: "e".repeat(64),
              cycle: 4,
              sameCycleRecovery: true,
              oneShot: true,
              zeroExecutionHistoryDigest: "d".repeat(64),
            },
          },
        ],
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: "c".repeat(64),
      }),
    ).toEqual([4]);
  });

  it.each([
    { campaignTerminalRuntimeVersion: null },
    { campaignTerminalDeploymentSha: null },
    { campaignTerminalFreshRuntimeProof: false },
    { campaignTerminalAutomatedFinal: null },
  ])(
    "rejects a factual final without complete terminal provenance",
    (missing) => {
      const audit = createParkedCourseCampaignAudit({
        expectedCount: 1,
        capturedAt,
        members: [member(1)],
      });
      const progress = summarizeParkedCourseCampaignProgress({
        audit,
        remainingGlobalParkedCount: 0,
        observations: [
          observation(1, {
            status: "RESOLVED",
            resolution: "DIRECT_BOOKING_CLASSIFIED",
            resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
            monitoringState: "FINAL_MANUAL",
            ...missing,
          }),
        ],
      });

      expect(progress).toMatchObject({
        terminalCount: 0,
        engineeringBlockerCount: 1,
      });
    },
  );

  it("measures the 24-hour endpoint from durable terminal evidence", () => {
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [member(1)],
    });
    const progress = summarizeParkedCourseCampaignProgress({
      audit,
      remainingGlobalParkedCount: 0,
      observations: [
        observation(1, {
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED",
          resolvedAt: new Date("2026-08-20T13:00:00.000Z"),
          monitoringState: "FINAL_MANUAL",
          campaignTerminalEvidenceAt: new Date("2026-08-21T12:00:01.000Z"),
        }),
      ],
    });

    expect(progress).toMatchObject({
      terminalCount: 1,
      terminalWithin24HoursCount: 0,
      automaticWithin24HoursCount: 0,
    });
  });
});
