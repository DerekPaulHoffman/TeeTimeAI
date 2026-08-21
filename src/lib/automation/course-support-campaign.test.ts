import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createParkedCourseCampaignAttemptLedgerFingerprint,
  createParkedCourseCampaignAudit,
  createParkedCourseCampaignMembershipDigest,
  deriveParkedCourseCampaignHumanReviewCycles,
  inspectActiveParkedCourseCampaign,
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
  providerCourse?: typeof providerCourseSnapshot;
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
    const makeRow = () =>
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
        batchIncidents: [
          {
            id: "batch-entry-descendant",
            cycle: 5,
            result: "NEEDS_HUMAN",
            batch: {
              baseSha: "release-old",
              releaseSha: "release-old",
              completedAt: new Date("2026-08-20T12:25:00.000Z"),
              summary: { closeout: { providerExecutionStarted: true } },
            },
            verificationRequests: [
              {
                id: "request-descendant",
                releaseSha: "release-old",
                status: "SUCCEEDED",
                revision: 3,
                attemptCount: 1,
                workflowRunId: "workflow-descendant",
                startedAt,
                outcome: "FETCH_FAILED",
                failureClass: "MISSING_METADATA",
                evidence: { providerExecution: true },
                lastError: "metadata remained incomplete",
              },
            ],
          },
        ],
      });
    const database = (row: ReturnType<typeof makeRow>) =>
      ({
        courseSupportIncident: { findMany: vi.fn().mockResolvedValue([row]) },
      }) as never;

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

    for (const changed of [
      duplicateHandoff,
      unstartedRequest,
      staleCurrentSnapshot,
      missingHandoff,
      gappedDescendant,
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

  it("plans only one exact same-identity +2 material-change recovery at rendered-browser discovery", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const materialChangeAt = new Date("2026-08-20T12:10:00.000Z");
    const parkedAt = new Date("2026-08-20T12:45:00.000Z");
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
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
        recheckDispatchKey: `dispatch-${input.ordinal}`,
        recheckDispatchStartedAt: new Date(input.createdAt),
        recheckDispatchedAt: new Date(input.createdAt),
        completedAt: new Date(input.completedAt),
        summary: { closeout: { ordinal: input.ordinal } },
        ownerAutomationRun: null,
      },
      verificationRequests: [
        {
          id: `request-${input.ordinal}`,
          releaseSha: "release-old",
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
              endpointStalled: true,
            },
          },
          {
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
      const [memberWithEvidence] = await loadParkedCourseCampaignAdmissionMembers(
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
    ).not.toBe(
      evidencePlan.sameCycleRecoveryHistoryDigest,
    );

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
        row.batchIncidents[1]!.batch.status = "VERIFYING";
      },
      (row: ReturnType<typeof makeRow>) => {
        row.batchIncidents[1]!.createdAt = new Date("2026-08-20T12:18:00.000Z");
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

  it("plans only the exact requestless stale-ownership campaign recovery", async () => {
    const admittedAt = new Date("2026-08-20T12:05:00.000Z");
    const attemptedAt = admittedAt;
    const historicalProbeAt = new Date("2026-08-20T11:30:00.000Z");
    const parkedAt = new Date("2026-08-20T12:30:00.000Z");
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(providerCourseSnapshot);
    const attemptLedger = { version: 1, events: [] };
    const captured = member(1, {
      cycle: 3,
      revision: 5,
      monitoringRevision: 9,
      providerSnapshotFingerprint,
      attemptLedgerFingerprint:
        createParkedCourseCampaignAttemptLedgerFingerprint(attemptLedger),
      playbookConclusion: "INCOMPLETE",
      latestProbeAt: historicalProbeAt.toISOString(),
      latestDiscoveryAt: null,
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
    const makeRow = () =>
      campaignParkedRow({
        cycle: 4,
        attemptLedger,
        probes: [
          {
            id: "probe-historical",
            courseId: "course-1",
            observedAt: historicalProbeAt,
          },
        ],
        events: [
          {
            incidentId: "incident-1",
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
            failureFingerprint: "SOURCE:MISSING",
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

  it("counts a revision-churned captured row in the global parked invariant", async () => {
    const captured = member(1);
    const audit = createParkedCourseCampaignAudit({
      expectedCount: 1,
      capturedAt,
      members: [captured],
    });
    const current = member(1, { revision: 9, monitoringRevision: 13 });
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
