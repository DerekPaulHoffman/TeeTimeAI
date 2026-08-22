import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { hasDurableWaitForMaterialChangeProof } from "@/lib/customer-monitoring-status";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { stableCourseProviderExecutionEvidenceValue } from "./course-provider-execution-evidence";
import { withPostgresAdvisoryTextLease } from "./lease";
import {
  AUTOMATION_PLAYBOOK_STAGES,
  assessAutomationPlaybook,
  type AutomationPlaybookStage,
} from "./course-monitoring-playbook";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { getAutomationRuntimeVersion } from "./runtime-version";
import { COURSE_SUPPORT_RESPONDER_PROMPT_VERSION } from "./course-support-responder-policy";
import { readPersistedCourseSupportSearchExecutionFence } from "./course-support-search-execution-fence";
import { COURSE_SUPPORT_WRITER_LANE } from "./writer-lanes";
import {
  assessCourseSupportZeroExecutionHistory,
  isCourseSupportCompletedBatchOrchestrationOnly,
  isCourseSupportVerificationRequestUnstarted,
  readCourseSupportReleaseExecutionEvidence,
  type CourseSupportZeroExecutionBatchEvidence,
} from "./course-support-zero-execution";

export const PARKED_COURSE_CAMPAIGN_PROMPT_VERSION =
  "tee-time-spot-course-support-parked-cohort-v1";
export const PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION = 2 as const;
export const PARKED_COURSE_CAMPAIGN_MAX_ADMISSION = 5;
export const PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT = 112;
export const PARKED_COURSE_CAMPAIGN_MAX_DESCENDANT_HANDOFFS =
  AUTOMATION_PLAYBOOK_STAGES.length;

const campaignMemberSchema = z
  .object({
    courseId: z.string().min(1),
    incidentId: z.string().min(1),
    cycle: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    monitoringRevision: z.number().int().nonnegative(),
    monitoringFailureFingerprint: z.string().min(1).nullable(),
    kind: z.string().min(1),
    providerFamilyKey: z.string().min(1),
    failureClass: z.string().min(1),
    failureFingerprint: z.string().min(1),
    providerSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    attemptLedgerFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    playbookConclusion: z.string().min(1),
    latestProbeAt: z.string().datetime().nullable(),
    latestDiscoveryAt: z.string().datetime().nullable(),
  })
  .strict();

const campaignEvidenceCategoryCountsSchema = z
  .object({
    sourceMissingCount: z.number().int().nonnegative(),
    sourceConflictCount: z.number().int().nonnegative(),
    providerSpecificCount: z.number().int().nonnegative(),
    priorProbeCount: z.number().int().nonnegative(),
    priorDiscoveryCount: z.number().int().nonnegative(),
    noPriorEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();

const parkedCourseCampaignAuditSchema = z
  .object({
    schemaVersion: z.literal(PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION),
    campaignKind: z.literal("PARKED_COHORT"),
    expectedCount: z.number().int().positive(),
    capturedAt: z.string().datetime(),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    aggregateEvidenceCategories: campaignEvidenceCategoryCountsSchema,
    members: z.array(campaignMemberSchema).min(1),
    customerDataIncluded: z.literal(false),
  })
  .strict()
  .superRefine((audit, context) => {
    if (audit.members.length !== audit.expectedCount) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message:
          "The parked-course campaign count does not match its immutable membership.",
      });
    }
    const sortedCourseIds = audit.members
      .map((member) => member.courseId)
      .sort();
    if (
      sortedCourseIds.some(
        (courseId, index) => courseId !== audit.members[index]?.courseId,
      ) ||
      new Set(sortedCourseIds).size !== sortedCourseIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message:
          "The parked-course campaign membership must be unique and sorted.",
      });
    }
    if (
      createParkedCourseCampaignMembershipDigest(audit.members) !==
      audit.membershipDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["membershipDigest"],
        message: "The parked-course campaign membership digest is invalid.",
      });
    }
    if (
      JSON.stringify(audit.aggregateEvidenceCategories) !==
      JSON.stringify(summarizeCampaignEvidenceCategories(audit.members))
    ) {
      context.addIssue({
        code: "custom",
        path: ["aggregateEvidenceCategories"],
        message:
          "The parked-course campaign aggregate evidence categories are invalid.",
      });
    }
  });

export type ParkedCourseCampaignMember = z.infer<typeof campaignMemberSchema>;
export type ParkedCourseCampaignAudit = z.infer<
  typeof parkedCourseCampaignAuditSchema
>;

export type ParkedCourseCampaignAdmissionMember = ParkedCourseCampaignMember & {
  activeRealSearchCount: number;
  latestProbeId: string | null;
  latestDiscoveryId: string | null;
  capturedRevision: number;
  capturedMonitoringRevision: number;
  capturedCycle: number;
  capturedKind: string;
  capturedProviderFamilyKey: string;
  campaignCapturedAt: string;
  admissionMode:
    | "FRESH_CYCLE"
    | "ZERO_EXECUTION_RECOVERY"
    | "INCOMPLETE_PLAYBOOK_RECOVERY"
    | "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY"
    | "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "CURRENT_CYCLE_ORCHESTRATION_RECOVERY";
  zeroExecutionHistoryDigest: string | null;
  sameCycleRecoveryHistoryDigest: string | null;
  playbookNextStage: AutomationPlaybookStage | null;
  playbookCompletedStageCount: number;
};

export type ParkedCourseCampaignTerminalKind =
  | "MONITORED"
  | "BOOKING_NOT_OPEN"
  | "FACTUAL_LIMITATION"
  | "TECHNICAL_LIMITATION"
  | "SOURCE_UNVERIFIED";

export type ParkedCourseCampaignMemberObservation = {
  courseId: string;
  incidentId: string | null;
  cycle: number | null;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED" | null;
  activeBatchId: string | null;
  confirmedAt: Date | null;
  resolution:
    | "MONITORING_RESTORED"
    | "DIRECT_BOOKING_CLASSIFIED"
    | "IDENTITY_CLASSIFIED"
    | "TECHNICAL_LIMITATION_CLASSIFIED"
    | "SOURCE_UNVERIFIED"
    | "HUMAN_VERIFIED_TECHNICAL_LIMITATION"
    | null;
  resolvedAt: Date | null;
  decisionAt: Date | null;
  monitoringState: string | null;
  monitoringStateChangedAt: Date | null;
  latestProbe: {
    outcome: string;
    observedAt: Date;
    runtimeVersion: string | null;
    rawSummary: unknown;
  } | null;
  campaignTerminalEvidenceAt: Date | null;
  campaignTerminalRuntimeVersion: string | null;
  campaignTerminalDeploymentSha: string | null;
  campaignTerminalOutcome: string | null;
  campaignTerminalFreshRuntimeProof: boolean;
  campaignTerminalAutomatedFinal: boolean | null;
  currentlyParked: boolean;
  humanReviewCycles: number[];
};

type ParkedCourseCampaignReviewEvent = {
  id?: string;
  eventType: string;
  source: string;
  occurredAt: Date;
  audit: unknown;
};

export function deriveParkedCourseCampaignHumanReviewCycles(input: {
  events: readonly ParkedCourseCampaignReviewEvent[];
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const recoveredAtByCycle = new Map<number, Date>();
  const supersededEndpointsByCycle = new Map<number, Map<string, number>>();
  for (const event of input.events) {
    if (event.eventType !== "REVALIDATION_REQUESTED") continue;
    const audit = asCampaignRecord(event.audit);
    const cycle = Number.isInteger(audit.cycle)
      ? (audit.cycle as number)
      : null;
    const validZeroExecutionRecovery =
      audit.action === "parked_cohort_zero_execution_recovery" &&
      typeof audit.zeroExecutionHistoryDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.zeroExecutionHistoryDigest);
    const descendantProgressedShape =
      Number.isInteger(audit.playbookCompletedStageCount) &&
      Number(audit.playbookCompletedStageCount) > 0 &&
      typeof audit.playbookNextStage === "string" &&
      audit.playbookNextStage.trim().length > 0 &&
      (audit.startedRequestCount === null ||
        (Number.isInteger(audit.startedRequestCount) &&
          Number(audit.startedRequestCount) >= 1));
    const descendantZeroProgressShape =
      audit.playbookCompletedStageCount === 0 &&
      audit.playbookNextStage === "OFFICIAL_IDENTITY" &&
      audit.requestCount === 0 &&
      audit.startedRequestCount === 0 &&
      audit.zeroProgressOrchestrationOnly === true &&
      audit.releaseEvidenceAbsent === true &&
      audit.executionEvidenceAbsent === true;
    const descendantIncompleteRecovery =
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      audit.action ===
        "parked_cohort_descendant_incomplete_playbook_recovery" &&
      audit.admissionMode === "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY" &&
      typeof audit.descendantLineageDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.descendantLineageDigest) &&
      Number.isInteger(audit.descendantHandoffCount) &&
      Number(audit.descendantHandoffCount) >= 1 &&
      Number(audit.descendantHandoffCount) <=
        PARKED_COURSE_CAMPAIGN_MAX_DESCENDANT_HANDOFFS &&
      Number.isInteger(audit.batchCount) &&
      Number(audit.batchCount) >= 1 &&
      audit.customerDataIncluded === false &&
      audit.preservesOperatorEvidence === true &&
      audit.preservesAttemptLedger === true &&
      audit.preservesAttemptCounts === true &&
      audit.preservesAttemptTimestamps === true &&
      audit.preservesImmutableCampaignAudit === true &&
      asCampaignRecord(audit.campaign).kind === "PARKED_COHORT" &&
      asCampaignRecord(audit.campaign).runId === audit.campaignRunId &&
      asCampaignRecord(audit.campaign).membershipDigest ===
        audit.campaignMembershipDigest &&
      asCampaignRecord(audit.campaign).cycle === cycle &&
      (descendantProgressedShape || descendantZeroProgressShape);
    const postMarkerIncompleteRecovery =
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      audit.action ===
        "parked_cohort_post_marker_incomplete_playbook_recovery" &&
      audit.admissionMode === "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY" &&
      typeof audit.priorRecoveryMarkerDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.priorRecoveryMarkerDigest) &&
      typeof audit.recoveryRuntimeVersion === "string" &&
      /^[a-f0-9]{40}$/u.test(audit.recoveryRuntimeVersion) &&
      typeof audit.priorRecoveryRuntimeVersion === "string" &&
      /^[a-f0-9]{40}$/u.test(audit.priorRecoveryRuntimeVersion) &&
      audit.recoveryRuntimeVersion !== audit.priorRecoveryRuntimeVersion &&
      Array.isArray(audit.failedRuntimeVersions) &&
      audit.failedRuntimeVersions.length === 1 &&
      audit.failedRuntimeVersions[0] === audit.priorRecoveryRuntimeVersion &&
      typeof audit.postMarkerHistoryDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.postMarkerHistoryDigest) &&
      audit.postMarkerBatchCount === 1 &&
      audit.postMarkerRequestCount === 0 &&
      Number.isInteger(audit.startedRequestCount) &&
      Number(audit.startedRequestCount) >= 1 &&
      Number.isInteger(audit.batchCount) &&
      Number(audit.batchCount) >= 1 &&
      audit.playbookCompletedStageCount === 4 &&
      audit.playbookNextStage === "RENDERED_BROWSER_DISCOVERY" &&
      typeof audit.supersededEndpointId === "string" &&
      audit.supersededEndpointId.trim().length > 0 &&
      typeof audit.supersededEndpointAt === "string" &&
      Number.isFinite(new Date(audit.supersededEndpointAt).getTime()) &&
      new Date(audit.supersededEndpointAt).getTime() <
        event.occurredAt.getTime() &&
      audit.customerDataIncluded === false &&
      audit.preservesOperatorEvidence === true &&
      asCampaignRecord(audit.campaign).kind === "PARKED_COHORT" &&
      asCampaignRecord(audit.campaign).runId === audit.campaignRunId &&
      asCampaignRecord(audit.campaign).membershipDigest ===
        audit.campaignMembershipDigest &&
      asCampaignRecord(audit.campaign).cycle === cycle &&
      audit.preservesAttemptLedger === true &&
      audit.preservesAttemptCounts === true &&
      audit.preservesAttemptTimestamps === true &&
      audit.preservesImmutableCampaignAudit === true;
    const sameIdentityMaterialChangeIncompleteRecovery =
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      audit.action ===
        "parked_cohort_same_identity_material_change_incomplete_playbook_recovery" &&
      audit.admissionMode ===
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY" &&
      typeof audit.materialChangeLineageDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.materialChangeLineageDigest) &&
      Number.isInteger(audit.startedRequestCount) &&
      Number(audit.startedRequestCount) >= 1 &&
      Number.isInteger(audit.batchCount) &&
      Number(audit.batchCount) >= 1 &&
      Number.isInteger(audit.playbookCompletedStageCount) &&
      Number(audit.playbookCompletedStageCount) > 0 &&
      typeof audit.playbookNextStage === "string" &&
      audit.playbookNextStage.trim().length > 0 &&
      typeof audit.supersededEndpointId === "string" &&
      audit.supersededEndpointId.trim().length > 0 &&
      typeof audit.supersededEndpointAt === "string" &&
      Number.isFinite(new Date(audit.supersededEndpointAt).getTime()) &&
      new Date(audit.supersededEndpointAt).getTime() <
        event.occurredAt.getTime() &&
      audit.customerDataIncluded === false &&
      audit.preservesOperatorEvidence === true &&
      asCampaignRecord(audit.campaign).kind === "PARKED_COHORT" &&
      asCampaignRecord(audit.campaign).runId === audit.campaignRunId &&
      asCampaignRecord(audit.campaign).membershipDigest ===
        audit.campaignMembershipDigest &&
      asCampaignRecord(audit.campaign).cycle === cycle &&
      audit.preservesAttemptLedger === true &&
      audit.preservesAttemptCounts === true &&
      audit.preservesAttemptTimestamps === true &&
      audit.preservesImmutableCampaignAudit === true;
    const validIncompletePlaybookRecovery =
      ((audit.action === "parked_cohort_incomplete_playbook_recovery" &&
        audit.admissionMode === "INCOMPLETE_PLAYBOOK_RECOVERY") ||
        postMarkerIncompleteRecovery ||
        descendantIncompleteRecovery ||
        sameIdentityMaterialChangeIncompleteRecovery) &&
      typeof audit.sameCycleRecoveryHistoryDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.sameCycleRecoveryHistoryDigest) &&
      typeof audit.providerSnapshotFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.providerSnapshotFingerprint) &&
      typeof audit.attemptLedgerFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.attemptLedgerFingerprint);
    const validRequestlessStaleOwnershipRecovery =
      audit.action === "parked_cohort_requestless_stale_ownership_recovery" &&
      audit.admissionMode ===
        "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY" &&
      typeof audit.sameCycleRecoveryHistoryDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.sameCycleRecoveryHistoryDigest) &&
      typeof audit.abandonedBaseRuntime === "string" &&
      audit.abandonedBaseRuntime.trim().length > 0 &&
      typeof audit.recoveryRuntimeVersion === "string" &&
      audit.recoveryRuntimeVersion.trim().length > 0 &&
      audit.abandonedBaseRuntime !== audit.recoveryRuntimeVersion &&
      audit.requestCount === 0 &&
      audit.releaseEvidenceAbsent === true &&
      audit.executionEvidenceAbsent === true &&
      audit.preservesAttemptLedger === true &&
      audit.preservesAttemptCounts === true &&
      audit.preservesAttemptTimestamps === true &&
      audit.preservesImmutableCampaignAudit === true;
    if (
      cycle === null ||
      (!validZeroExecutionRecovery &&
        !validIncompletePlaybookRecovery &&
        !validRequestlessStaleOwnershipRecovery) ||
      audit.campaignRunId !== input.campaignRunId ||
      audit.campaignMembershipDigest !== input.campaignMembershipDigest ||
      audit.sameCycleRecovery !== true ||
      audit.oneShot !== true
    ) {
      continue;
    }
    if (
      sameIdentityMaterialChangeIncompleteRecovery ||
      postMarkerIncompleteRecovery
    ) {
      const endpoints =
        supersededEndpointsByCycle.get(cycle) ?? new Map<string, number>();
      endpoints.set(
        audit.supersededEndpointId as string,
        new Date(audit.supersededEndpointAt as string).getTime(),
      );
      supersededEndpointsByCycle.set(cycle, endpoints);
    } else {
      const prior = recoveredAtByCycle.get(cycle);
      if (!prior || event.occurredAt < prior) {
        recoveredAtByCycle.set(cycle, event.occurredAt);
      }
    }
  }

  return [
    ...new Set(
      input.events.flatMap((event) => {
        if (
          event.eventType !== "HUMAN_REVIEW_REQUESTED" &&
          event.eventType !== "HUMAN_DECISION" &&
          event.source !== "OPERATOR_DASHBOARD" &&
          event.source !== "OPERATOR_CLI"
        ) {
          return [];
        }
        const audit = asCampaignRecord(event.audit);
        const cycle = Number.isInteger(audit.cycle)
          ? (audit.cycle as number)
          : null;
        if (cycle === null) return [];
        const recoveryAt = recoveredAtByCycle.get(cycle);
        const supersededEndpoints = supersededEndpointsByCycle.get(cycle);
        const supersededInfrastructureParking =
          event.eventType === "HUMAN_REVIEW_REQUESTED" &&
          event.source !== "OPERATOR_DASHBOARD" &&
          event.source !== "OPERATOR_CLI" &&
          audit.automationStalled === true &&
          audit.parkedUntilMaterialChange === true &&
          audit.playbookExhausted === false &&
          ((typeof event.id === "string" &&
            supersededEndpoints?.get(event.id) ===
              event.occurredAt.getTime()) ||
            (recoveryAt !== undefined && event.occurredAt < recoveryAt));
        return supersededInfrastructureParking ? [] : [cycle];
      }),
    ),
  ];
}

export type ParkedCourseCampaignProgress = {
  capturedAt: string;
  expectedCount: number;
  totalCount: number;
  terminalCount: number;
  pendingCount: number;
  readyCount: number;
  activeCount: number;
  monitoredCount: number;
  bookingNotOpenCount: number;
  factualLimitationCount: number;
  technicalLimitationCount: number;
  sourceUnverifiedCount: number;
  engineeringBlockerCount: number;
  currentResultMissingCount: number;
  humanReviewCount: number;
  terminalWithin24HoursCount: number;
  automaticWithin24HoursCount: number;
  remainingGlobalParkedCount: number;
  membershipDigest: string;
};

type StoredCampaignRun = {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  completedAt: Date | null;
  outcome: string | null;
  audit: Prisma.JsonValue | null;
};

type ParkedCourseCampaignDependencies = {
  loadLatestCampaign: () => Promise<StoredCampaignRun | null>;
  loadActiveCampaign: () => Promise<StoredCampaignRun | null>;
  loadParkedMembers: () => Promise<ParkedCourseCampaignMember[]>;
  loadAllParkedMembers?: () => Promise<ParkedCourseCampaignMember[]>;
  loadAdmissionMembers?: (
    audit: ParkedCourseCampaignAudit,
    campaignRunId: string,
  ) => Promise<ParkedCourseCampaignAdmissionMember[]>;
  loadGlobalParkedCount?: () => Promise<number>;
  loadMemberObservations: (
    audit: ParkedCourseCampaignAudit,
    parkedCourseIds: ReadonlySet<string>,
    campaignRunId: string,
  ) => Promise<ParkedCourseCampaignMemberObservation[]>;
  createCampaign: (
    audit: ParkedCourseCampaignAudit,
  ) => Promise<StoredCampaignRun>;
  completeCampaign: (
    runId: string,
    audit: ParkedCourseCampaignAudit,
    progress: ParkedCourseCampaignProgress,
  ) => Promise<boolean>;
  withTransitionLease: <T>(
    worker: () => Promise<T>,
  ) => Promise<{ acquired: true; value: T } | { acquired: false }>;
};

type ParkedCourseCampaignDatabase = Pick<
  Prisma.TransactionClient,
  "automationRun" | "courseSupportIncident"
>;

export function parseParkedCourseCampaignAudit(value: unknown) {
  const parsed = parkedCourseCampaignAuditSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createParkedCourseCampaignMembershipDigest(
  members: readonly ParkedCourseCampaignMember[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...members]
          .sort((left, right) => left.courseId.localeCompare(right.courseId))
          .map((member) => ({
            courseId: member.courseId,
            incidentId: member.incidentId,
            cycle: member.cycle,
            revision: member.revision,
            monitoringRevision: member.monitoringRevision,
            monitoringFailureFingerprint: member.monitoringFailureFingerprint,
            kind: member.kind,
            providerFamilyKey: member.providerFamilyKey,
            failureClass: member.failureClass,
            failureFingerprint: member.failureFingerprint,
            providerSnapshotFingerprint: member.providerSnapshotFingerprint,
            attemptLedgerFingerprint: member.attemptLedgerFingerprint,
            playbookConclusion: member.playbookConclusion,
            latestProbeAt: member.latestProbeAt,
            latestDiscoveryAt: member.latestDiscoveryAt,
          })),
      ),
    )
    .digest("hex");
}

export function summarizeCampaignEvidenceCategories(
  members: readonly ParkedCourseCampaignMember[],
) {
  return members.reduce(
    (counts, member) => {
      if (member.providerFamilyKey === "SOURCE_MISSING") {
        counts.sourceMissingCount += 1;
      } else if (member.providerFamilyKey === "SOURCE_CONFLICT") {
        counts.sourceConflictCount += 1;
      } else {
        counts.providerSpecificCount += 1;
      }
      if (member.latestProbeAt) counts.priorProbeCount += 1;
      if (member.latestDiscoveryAt) counts.priorDiscoveryCount += 1;
      if (!member.latestProbeAt && !member.latestDiscoveryAt) {
        counts.noPriorEvidenceCount += 1;
      }
      return counts;
    },
    {
      sourceMissingCount: 0,
      sourceConflictCount: 0,
      providerSpecificCount: 0,
      priorProbeCount: 0,
      priorDiscoveryCount: 0,
      noPriorEvidenceCount: 0,
    },
  );
}

export function createParkedCourseCampaignAudit(input: {
  expectedCount: number;
  capturedAt: Date;
  members: readonly ParkedCourseCampaignMember[];
}): ParkedCourseCampaignAudit {
  const members = [...input.members].sort((left, right) =>
    left.courseId.localeCompare(right.courseId),
  );
  return parkedCourseCampaignAuditSchema.parse({
    schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
    campaignKind: "PARKED_COHORT",
    expectedCount: input.expectedCount,
    capturedAt: input.capturedAt.toISOString(),
    membershipDigest: createParkedCourseCampaignMembershipDigest(members),
    aggregateEvidenceCategories: summarizeCampaignEvidenceCategories(members),
    members,
    customerDataIncluded: false,
  });
}

export function summarizeParkedCourseCampaignProgress(input: {
  audit: ParkedCourseCampaignAudit;
  observations: readonly ParkedCourseCampaignMemberObservation[];
  remainingGlobalParkedCount: number;
}): ParkedCourseCampaignProgress {
  const capturedAt = new Date(input.audit.capturedAt);
  const observationByCourseId = new Map(
    input.observations.map((observation) => [
      observation.courseId,
      observation,
    ]),
  );
  const counts = {
    terminalCount: 0,
    readyCount: 0,
    activeCount: 0,
    monitoredCount: 0,
    bookingNotOpenCount: 0,
    factualLimitationCount: 0,
    technicalLimitationCount: 0,
    sourceUnverifiedCount: 0,
    engineeringBlockerCount: 0,
    currentResultMissingCount: 0,
    humanReviewCount: 0,
    terminalWithin24HoursCount: 0,
    automaticWithin24HoursCount: 0,
  };
  const humanReviewKeys = new Set<string>();

  for (const member of input.audit.members) {
    const observation = observationByCourseId.get(member.courseId);
    const terminalKind = observation
      ? getFreshTerminalKind(member, observation, capturedAt)
      : null;
    if (terminalKind) {
      counts.terminalCount += 1;
      if (
        observation?.campaignTerminalEvidenceAt &&
        observation.campaignTerminalEvidenceAt.getTime() <=
          capturedAt.getTime() + 24 * 60 * 60 * 1000
      ) {
        counts.terminalWithin24HoursCount += 1;
        if (
          observation.resolution !== "HUMAN_VERIFIED_TECHNICAL_LIMITATION" &&
          observation.decisionAt === null &&
          !observation.humanReviewCycles.includes(observation.cycle ?? -1) &&
          observation.campaignTerminalAutomatedFinal === true
        ) {
          counts.automaticWithin24HoursCount += 1;
        }
      }
      if (
        observation?.incidentId &&
        observation.cycle !== null &&
        observation.campaignTerminalAutomatedFinal === false
      ) {
        humanReviewKeys.add(
          `${observation.incidentId}\u0000${observation.cycle}`,
        );
      }
      if (terminalKind === "MONITORED") counts.monitoredCount += 1;
      if (terminalKind === "BOOKING_NOT_OPEN") counts.bookingNotOpenCount += 1;
      if (terminalKind === "FACTUAL_LIMITATION")
        counts.factualLimitationCount += 1;
      if (terminalKind === "TECHNICAL_LIMITATION")
        counts.technicalLimitationCount += 1;
      if (terminalKind === "SOURCE_UNVERIFIED")
        counts.sourceUnverifiedCount += 1;
      continue;
    }
    if (observation?.currentlyParked) {
      counts.readyCount += 1;
      continue;
    }
    if (
      observation?.incidentId === member.incidentId &&
      observation.cycle !== null &&
      observation.cycle > member.cycle &&
      observation.status === "AUTO_INVESTIGATING"
    ) {
      counts.activeCount += 1;
      continue;
    }
    if (
      !observation ||
      observation.incidentId !== member.incidentId ||
      observation.status === "NEEDS_HUMAN" ||
      observation.status === "RESOLVED"
    ) {
      counts.engineeringBlockerCount += 1;
      continue;
    }
    counts.currentResultMissingCount += 1;
  }

  for (const observation of input.observations) {
    if (!observation.incidentId) continue;
    for (const cycle of observation.humanReviewCycles) {
      humanReviewKeys.add(`${observation.incidentId}\u0000${cycle}`);
    }
  }
  counts.humanReviewCount = humanReviewKeys.size;

  return {
    capturedAt: input.audit.capturedAt,
    expectedCount: input.audit.expectedCount,
    totalCount: input.audit.members.length,
    ...counts,
    pendingCount: input.audit.members.length - counts.terminalCount,
    remainingGlobalParkedCount: input.remainingGlobalParkedCount,
    membershipDigest: input.audit.membershipDigest,
  };
}

export async function runParkedCourseCampaignCommand(
  input: {
    apply: boolean;
    expectedCount: number;
    expectedDigest?: string | null;
    now?: Date;
  },
  dependencies: ParkedCourseCampaignDependencies = defaultDependencies,
) {
  const now = input.now ?? new Date();
  assertExpectedCampaignCount(input.expectedCount);
  assertExpectedCampaignDigest(input.expectedDigest);

  const existing = await dependencies.loadLatestCampaign();
  if (existing) {
    return buildExistingCampaignResult(
      existing,
      input.expectedCount,
      input.apply ? "apply" : "dry-run",
      dependencies,
    );
  }

  const previewMembers = await dependencies.loadParkedMembers();
  const previewDigest =
    createParkedCourseCampaignMembershipDigest(previewMembers);
  if (!input.apply) {
    return {
      scope: "parked-cohort" as const,
      mode: "dry-run" as const,
      campaignState: "PREVIEW" as const,
      expectedCount: input.expectedCount,
      capturedCount: previewMembers.length,
      countMatches: previewMembers.length === input.expectedCount,
      membershipDigest: previewDigest,
      aggregateEvidenceCategories:
        summarizeCampaignEvidenceCategories(previewMembers),
      resumed: false,
    };
  }
  if (!input.expectedDigest) {
    throw new Error(
      "--expect-digest from a current parked-cohort dry run is required with --apply.",
    );
  }

  const transition = await dependencies.withTransitionLease(async () => {
    const resumed = await dependencies.loadLatestCampaign();
    if (resumed) {
      return { run: resumed, resumed: true };
    }
    const members = await dependencies.loadParkedMembers();
    if (members.length !== input.expectedCount) {
      throw new Error(
        `Parked-course cohort changed: expected ${input.expectedCount}, observed ${members.length}.`,
      );
    }
    const audit = createParkedCourseCampaignAudit({
      expectedCount: input.expectedCount,
      capturedAt: now,
      members,
    });
    assertCampaignSnapshotMatchesExpectation(
      audit,
      input.expectedCount,
      input.expectedDigest!,
    );
    return { run: await dependencies.createCampaign(audit), resumed: false };
  });
  if (!transition.acquired) {
    throw new Error(
      "The course-support writer is busy; rerun the parked-cohort command.",
    );
  }
  const result = await buildExistingCampaignResult(
    transition.value.run,
    input.expectedCount,
    "apply",
    dependencies,
  );
  return {
    ...result,
    mode: "apply" as const,
    resumed: transition.value.resumed,
  };
}

export async function inspectActiveParkedCourseCampaign(
  input?: { completeIfDone?: boolean },
  dependencies: ParkedCourseCampaignDependencies = defaultDependencies,
) {
  const run = await dependencies.loadActiveCampaign();
  if (!run) return null;
  const audit = requireCampaignAudit(run);
  const progress = await loadCampaignProgress(run.id, audit, dependencies);
  let status = run.status;
  if (
    input?.completeIfDone &&
    progress.terminalCount === progress.totalCount &&
    progress.remainingGlobalParkedCount === 0
  ) {
    const completed = await dependencies.completeCampaign(
      run.id,
      audit,
      progress,
    );
    if (completed) status = "COMPLETED";
  }
  return { runId: run.id, status, ...progress };
}

export async function inspectLatestParkedCourseCampaign() {
  const run = await defaultDependencies.loadLatestCampaign();
  if (!run) return null;
  const audit = requireCampaignAudit(run);
  return {
    runId: run.id,
    status: run.status,
    ...(await loadCampaignProgress(run.id, audit, defaultDependencies)),
  };
}

export async function planNextParkedCourseCampaignCohort(input: {
  now: Date;
  maxCourses: number;
  runtimeVersion: string;
  hasDueRealDemand: boolean;
  activeProviderGroups: ReadonlySet<string>;
}): Promise<{
  members: ParkedCourseCampaignAdmissionMember[];
  campaignRunId: string | null;
  membershipDigest: string | null;
}> {
  const run = await defaultDependencies.loadActiveCampaign();
  if (!run) {
    return {
      members: [],
      campaignRunId: null,
      membershipDigest: null,
    };
  }
  const audit = requireCampaignAudit(run);
  const admissionMembers = await loadParkedCourseCampaignAdmissionMembers(
    audit,
    prisma,
    run.id,
    input.runtimeVersion,
  );
  const eligibleMembers = input.hasDueRealDemand
    ? admissionMembers.filter((member) => member.activeRealSearchCount > 0)
    : admissionMembers;
  const groups = new Map<string, ParkedCourseCampaignAdmissionMember[]>();
  for (const member of eligibleMembers) {
    const key = `${member.providerFamilyKey}\u0000${member.failureFingerprint}`;
    if (input.activeProviderGroups.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const selected = [...groups.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        Number(right.some((member) => member.activeRealSearchCount > 0)) -
          Number(left.some((member) => member.activeRealSearchCount > 0)) ||
        leftKey.localeCompare(rightKey),
    )[0]?.[1]
    ?.sort((left, right) => left.courseId.localeCompare(right.courseId))
    .slice(
      0,
      Math.min(
        PARKED_COURSE_CAMPAIGN_MAX_ADMISSION,
        Math.max(1, input.maxCourses),
      ),
    );
  if (!selected?.length) {
    return {
      members: [],
      campaignRunId: run.id,
      membershipDigest: audit.membershipDigest,
    };
  }

  return {
    members: selected,
    campaignRunId: run.id,
    membershipDigest: audit.membershipDigest,
  };
}

function getFreshTerminalKind(
  member: ParkedCourseCampaignMember,
  observation: ParkedCourseCampaignMemberObservation,
  capturedAt: Date,
): ParkedCourseCampaignTerminalKind | null {
  const evidenceNotBefore = observation.confirmedAt;
  if (
    observation.incidentId !== member.incidentId ||
    observation.cycle === null ||
    observation.cycle <= member.cycle ||
    observation.status !== "RESOLVED" ||
    observation.activeBatchId !== null ||
    !evidenceNotBefore ||
    evidenceNotBefore < capturedAt ||
    !observation.resolvedAt ||
    observation.resolvedAt < evidenceNotBefore ||
    !observation.monitoringStateChangedAt ||
    observation.monitoringStateChangedAt < evidenceNotBefore ||
    !observation.campaignTerminalEvidenceAt ||
    observation.campaignTerminalEvidenceAt < evidenceNotBefore ||
    !observation.campaignTerminalRuntimeVersion ||
    !observation.campaignTerminalDeploymentSha ||
    observation.campaignTerminalDeploymentSha !==
      observation.campaignTerminalRuntimeVersion ||
    observation.campaignTerminalFreshRuntimeProof !== true ||
    observation.campaignTerminalAutomatedFinal === null
  ) {
    return null;
  }
  if (observation.resolution === "MONITORING_RESTORED") {
    const freshProbe = isFreshSuccessfulProbe(
      observation.latestProbe,
      evidenceNotBefore,
    );
    const freshTerminalRead =
      observation.campaignTerminalOutcome === "MATCH_FOUND" ||
      observation.campaignTerminalOutcome === "NO_MATCH";
    if (
      observation.monitoringState !== "HEALTHY" ||
      (!freshProbe && !freshTerminalRead) ||
      (freshProbe &&
        observation.latestProbe?.runtimeVersion !==
          observation.campaignTerminalRuntimeVersion)
    ) {
      return null;
    }
    return freshProbe &&
      isFreshBookingNotOpenProbe(observation.latestProbe, evidenceNotBefore)
      ? "BOOKING_NOT_OPEN"
      : "MONITORED";
  }
  if (observation.resolution === "DIRECT_BOOKING_CLASSIFIED") {
    return observation.monitoringState === "FINAL_MANUAL"
      ? "FACTUAL_LIMITATION"
      : null;
  }
  if (observation.resolution === "IDENTITY_CLASSIFIED") {
    return observation.monitoringState === "FINAL_IDENTITY"
      ? "FACTUAL_LIMITATION"
      : null;
  }
  if (observation.resolution === "SOURCE_UNVERIFIED") {
    return observation.monitoringState === "FINAL_TECHNICAL"
      ? "SOURCE_UNVERIFIED"
      : null;
  }
  if (
    (observation.resolution === "TECHNICAL_LIMITATION_CLASSIFIED" ||
      observation.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION") &&
    observation.monitoringState === "FINAL_TECHNICAL"
  ) {
    return "TECHNICAL_LIMITATION";
  }
  return null;
}

function isFreshSuccessfulProbe(
  probe: ParkedCourseCampaignMemberObservation["latestProbe"],
  capturedAt: Date,
) {
  return Boolean(
    probe &&
    (probe.outcome === "MATCH_FOUND" || probe.outcome === "NO_MATCH") &&
    probe.runtimeVersion &&
    probe.observedAt >= capturedAt,
  );
}

function isFreshBookingNotOpenProbe(
  probe: ParkedCourseCampaignMemberObservation["latestProbe"],
  capturedAt: Date,
) {
  if (!isFreshSuccessfulProbe(probe, capturedAt) || !probe?.rawSummary) {
    return false;
  }
  if (typeof probe.rawSummary !== "object" || Array.isArray(probe.rawSummary)) {
    return false;
  }
  const summary = probe.rawSummary as Record<string, unknown>;
  return (
    summary.targetDateStatus === "NOT_OPEN" || Boolean(summary.bookingWindow)
  );
}

async function buildExistingCampaignResult(
  run: StoredCampaignRun,
  expectedCount: number,
  mode: "apply" | "dry-run",
  dependencies: ParkedCourseCampaignDependencies,
) {
  const audit = requireCampaignAudit(run);
  if (audit.expectedCount !== expectedCount) {
    throw new Error(
      `The existing parked-course campaign expects ${audit.expectedCount} courses, not ${expectedCount}.`,
    );
  }
  const progress = await loadCampaignProgress(run.id, audit, dependencies);
  return {
    scope: "parked-cohort" as const,
    mode,
    campaignState: run.status === "RUNNING" ? ("ACTIVE" as const) : run.status,
    expectedCount,
    capturedCount: audit.members.length,
    countMatches: audit.members.length === expectedCount,
    membershipDigest: audit.membershipDigest,
    aggregateEvidenceCategories: audit.aggregateEvidenceCategories,
    resumed: true,
    progress,
  };
}

async function loadCampaignProgress(
  campaignRunId: string,
  audit: ParkedCourseCampaignAudit,
  dependencies: ParkedCourseCampaignDependencies,
) {
  const parkedMembers = await (dependencies.loadAllParkedMembers?.() ??
    dependencies.loadParkedMembers());
  const remainingGlobalParkedCount = dependencies.loadGlobalParkedCount
    ? await dependencies.loadGlobalParkedCount()
    : parkedMembers.length;
  const memberByCourseId = new Map(
    audit.members.map((member) => [member.courseId, member]),
  );
  const admissionMembers = dependencies.loadAdmissionMembers
    ? await dependencies.loadAdmissionMembers(audit, campaignRunId)
    : [];
  const parkedCourseIds = new Set([
    ...admissionMembers.map((member) => member.courseId),
    ...parkedMembers.flatMap((member) => {
      const captured = memberByCourseId.get(member.courseId);
      return captured && isSameCampaignMemberMaterialSnapshot(captured, member)
        ? [member.courseId]
        : [];
    }),
  ]);
  return summarizeParkedCourseCampaignProgress({
    audit,
    observations: await dependencies.loadMemberObservations(
      audit,
      parkedCourseIds,
      campaignRunId,
    ),
    remainingGlobalParkedCount,
  });
}

function isSameCampaignMemberMaterialSnapshot(
  captured: ParkedCourseCampaignMember,
  current: ParkedCourseCampaignMember,
) {
  return (
    captured.courseId === current.courseId &&
    captured.incidentId === current.incidentId &&
    captured.cycle === current.cycle &&
    captured.kind === current.kind &&
    captured.monitoringFailureFingerprint ===
      current.monitoringFailureFingerprint &&
    captured.providerFamilyKey === current.providerFamilyKey &&
    captured.failureClass === current.failureClass &&
    captured.failureFingerprint === current.failureFingerprint &&
    captured.providerSnapshotFingerprint ===
      current.providerSnapshotFingerprint &&
    captured.attemptLedgerFingerprint === current.attemptLedgerFingerprint &&
    captured.playbookConclusion === current.playbookConclusion &&
    captured.latestProbeAt === current.latestProbeAt &&
    captured.latestDiscoveryAt === current.latestDiscoveryAt
  );
}

function requireCampaignAudit(run: StoredCampaignRun) {
  const audit = parseParkedCourseCampaignAudit(run.audit);
  if (!audit) {
    throw new Error("The parked-course campaign audit is missing or invalid.");
  }
  return audit;
}

function assertExpectedCampaignCount(value: number) {
  if (value !== PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT) {
    throw new Error(
      `--expect-count must equal the immutable baseline of ${PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT}.`,
    );
  }
}

function assertExpectedCampaignDigest(value: string | null | undefined) {
  if (value !== undefined && value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("--expect-digest must be a lowercase SHA-256 digest.");
  }
}

function assertCampaignSnapshotMatchesExpectation(
  audit: ParkedCourseCampaignAudit,
  expectedCount: number,
  expectedDigest: string,
) {
  if (audit.members.length !== expectedCount) {
    throw new Error(
      `Parked-course cohort changed: expected ${expectedCount}, observed ${audit.members.length}.`,
    );
  }
  if (audit.membershipDigest !== expectedDigest) {
    throw new Error(
      "Parked-course cohort changed after dry run; rerun without --apply.",
    );
  }
}

export async function loadParkedCourseCampaignMembers(
  database: ParkedCourseCampaignDatabase = prisma,
) {
  const snapshots = await loadParkedCourseCampaignMemberSnapshots(database, {
    requireZeroDemand: true,
  });
  return snapshots.map(
    ({ activeRealSearchCount, zeroExecutionEvidence, ...member }) => {
      void zeroExecutionEvidence;
      if (activeRealSearchCount !== 0) {
        throw new Error(
          "The immutable parked-course campaign cannot capture active demand.",
        );
      }
      return member;
    },
  );
}

async function loadAllParkedCourseCampaignMembers(
  database: ParkedCourseCampaignDatabase = prisma,
) {
  const snapshots = await loadParkedCourseCampaignMemberSnapshots(database, {
    requireZeroDemand: false,
  });
  return snapshots.map(({ zeroExecutionEvidence, ...member }) => {
    void zeroExecutionEvidence;
    return member;
  });
}

async function loadGlobalParkedCourseCampaignCount(
  database: ParkedCourseCampaignDatabase = prisma,
) {
  return database.courseSupportIncident.count({
    where: {
      status: "NEEDS_HUMAN",
      humanReviewReason: "AUTOMATION_STALLED",
      activeBatchId: null,
      nextAttemptAt: null,
    },
  });
}

export async function loadParkedCourseCampaignAdmissionMembers(
  audit: ParkedCourseCampaignAudit,
  database: ParkedCourseCampaignDatabase = prisma,
  campaignRunId = "",
  runtimeVersion = getAutomationRuntimeVersion(),
): Promise<ParkedCourseCampaignAdmissionMember[]> {
  const capturedByIncidentId = new Map(
    audit.members.map((member) => [member.incidentId, member]),
  );
  const currentMembers = await loadParkedCourseCampaignMemberSnapshots(
    database,
    {
      requireZeroDemand: false,
      incidentIds: audit.members.map((member) => member.incidentId),
      requireExactCurrentCycleBatchHistory: true,
    },
  );
  return currentMembers.flatMap((current) => {
    const captured = capturedByIncidentId.get(current.incidentId);
    if (!captured) {
      return [];
    }
    const freshCycle = isSameCampaignMemberMaterialSnapshot(captured, current);
    const requestlessStaleOwnershipHistory = freshCycle
      ? null
      : assessParkedCourseCampaignRequestlessStaleOwnershipRecovery({
          captured,
          current,
          capturedAt: new Date(audit.capturedAt),
          campaignRunId,
          campaignMembershipDigest: audit.membershipDigest,
          currentRuntimeVersion: runtimeVersion,
        });
    const zeroExecutionHistory =
      freshCycle || requestlessStaleOwnershipHistory
        ? null
        : getParkedCourseCampaignZeroExecutionRecovery({
            captured,
            current,
            campaignRunId,
            campaignMembershipDigest: audit.membershipDigest,
            runtimeVersion,
          });
    const incompletePlaybookHistory =
      freshCycle || requestlessStaleOwnershipHistory || zeroExecutionHistory
        ? null
        : getParkedCourseCampaignIncompletePlaybookRecovery({
            captured,
            current,
            campaignRunId,
            campaignMembershipDigest: audit.membershipDigest,
          });
    const postMarkerIncompletePlaybookRecovery =
      freshCycle ||
      requestlessStaleOwnershipHistory ||
      zeroExecutionHistory ||
      incompletePlaybookHistory
        ? null
        : assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery({
            captured,
            current,
            capturedAt: new Date(audit.capturedAt),
            campaignRunId,
            campaignMembershipDigest: audit.membershipDigest,
            currentRuntimeVersion: runtimeVersion,
          });
    const descendantIncompletePlaybookRecovery =
      freshCycle ||
      requestlessStaleOwnershipHistory ||
      zeroExecutionHistory ||
      incompletePlaybookHistory ||
      postMarkerIncompletePlaybookRecovery
        ? null
        : assessParkedCourseCampaignDescendantIncompletePlaybookRecovery({
            captured,
            current,
            capturedAt: new Date(audit.capturedAt),
            campaignRunId,
            campaignMembershipDigest: audit.membershipDigest,
          });
    const sameIdentityMaterialChangeIncompletePlaybookRecovery =
      freshCycle ||
      requestlessStaleOwnershipHistory ||
      zeroExecutionHistory ||
      incompletePlaybookHistory ||
      postMarkerIncompletePlaybookRecovery ||
      descendantIncompletePlaybookRecovery
        ? null
        : assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery(
            {
              captured,
              current,
              capturedAt: new Date(audit.capturedAt),
              campaignRunId,
              campaignMembershipDigest: audit.membershipDigest,
            },
          );
    const currentCycleOrchestrationHistory =
      freshCycle ||
      requestlessStaleOwnershipHistory ||
      zeroExecutionHistory ||
      incompletePlaybookHistory ||
      postMarkerIncompletePlaybookRecovery ||
      descendantIncompletePlaybookRecovery ||
      sameIdentityMaterialChangeIncompletePlaybookRecovery
        ? null
        : getParkedCourseCampaignCurrentCycleOrchestrationRecovery({
            captured,
            current,
            capturedAt: new Date(audit.capturedAt),
            campaignRunId,
          });
    if (
      !freshCycle &&
      !requestlessStaleOwnershipHistory &&
      !zeroExecutionHistory &&
      !incompletePlaybookHistory &&
      !postMarkerIncompletePlaybookRecovery &&
      !descendantIncompletePlaybookRecovery &&
      !sameIdentityMaterialChangeIncompletePlaybookRecovery &&
      !currentCycleOrchestrationHistory
    ) {
      return [];
    }
    const admissionMode = freshCycle
      ? ("FRESH_CYCLE" as const)
      : requestlessStaleOwnershipHistory
        ? ("PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY" as const)
        : zeroExecutionHistory
          ? ("ZERO_EXECUTION_RECOVERY" as const)
          : incompletePlaybookHistory
            ? ("INCOMPLETE_PLAYBOOK_RECOVERY" as const)
            : postMarkerIncompletePlaybookRecovery
              ? ("POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY" as const)
              : descendantIncompletePlaybookRecovery
                ? ("DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY" as const)
                : sameIdentityMaterialChangeIncompletePlaybookRecovery
                  ? ("SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY" as const)
                  : ("CURRENT_CYCLE_ORCHESTRATION_RECOVERY" as const);
    const playbookAssessment = current.zeroExecutionEvidence.playbookAssessment;
    return [
      {
        ...stripParkedCourseCampaignRecoveryEvidence(current),
        capturedRevision: captured.revision,
        capturedMonitoringRevision: captured.monitoringRevision,
        capturedCycle: captured.cycle,
        capturedKind: captured.kind,
        capturedProviderFamilyKey: captured.providerFamilyKey,
        campaignCapturedAt: audit.capturedAt,
        admissionMode,
        zeroExecutionHistoryDigest: zeroExecutionHistory?.historyDigest ?? null,
        sameCycleRecoveryHistoryDigest:
          requestlessStaleOwnershipHistory?.historyDigest ??
          incompletePlaybookHistory?.historyDigest ??
          postMarkerIncompletePlaybookRecovery?.history.historyDigest ??
          descendantIncompletePlaybookRecovery?.history.historyDigest ??
          sameIdentityMaterialChangeIncompletePlaybookRecovery?.history
            .historyDigest ??
          currentCycleOrchestrationHistory?.historyDigest ??
          null,
        playbookNextStage: playbookAssessment.nextStage,
        playbookCompletedStageCount: playbookAssessment.completedStages.length,
        latestProbeId: current.zeroExecutionEvidence.latestProbe?.id ?? null,
        latestDiscoveryId:
          current.zeroExecutionEvidence.latestDiscovery?.id ?? null,
      },
    ];
  });
}

type ParkedCourseCampaignRecoveryEvidence = {
  latestProbe: {
    id: string;
    courseId: string;
    observedAt: Date;
  } | null;
  latestDiscovery: {
    id: string;
    courseId: string;
    createdAt: Date;
  } | null;
  latestProbeTimestampRowCount: number;
  latestDiscoveryTimestampRowCount: number;
  monitoringEvents: Array<{
    id?: string;
    incidentId: string | null;
    eventType: string;
    source: string;
    failureFingerprint: string | null;
    readPath: string | null;
    occurredAt: Date;
    audit: Prisma.JsonValue | null;
  }>;
  batchIncidents: ParkedCourseCampaignBatchEvidence[];
  playbookAssessment: ReturnType<typeof assessAutomationPlaybook>;
};

export type ParkedCourseCampaignBatchEvidence = Omit<
  CourseSupportZeroExecutionBatchEvidence,
  "batch" | "verificationRequests"
> & {
  batchId: string;
  incidentId: string;
  courseId: string;
  preProbeId: string | null;
  postProbeId: string | null;
  proofSnapshot: unknown;
  verifiedIncidentUpdatedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  verificationRequests: Array<
    CourseSupportZeroExecutionBatchEvidence["verificationRequests"][number] & {
      courseId?: string;
      providerSnapshotFingerprint?: string;
      providerSnapshotAt?: Date;
      discoveryAttemptedAt?: Date | null;
      discoveryVerifiedAt?: Date | null;
      createdAt?: Date;
      updatedAt?: Date;
    }
  >;
  batch: CourseSupportZeroExecutionBatchEvidence["batch"] & {
    id: string;
    status: string;
    revision: number;
    ownerAutomationRunId: string | null;
    deployedAt: Date | null;
    createdAt: Date;
    updatedAt?: Date;
    recheckDispatchKey: string | null;
    recheckDispatchStartedAt: Date | null;
    recheckDispatchedAt: Date | null;
    ownerAutomationRun: {
      id: string;
      promptVersion: string;
      kind: string;
      status: string;
      runtimeVersion: string | null;
      completedAt: Date | null;
      outcome: string | null;
      notes: string | null;
    } | null;
  };
};

const parkedCourseCampaignBatchIncidentSelect = {
  id: true,
  batchId: true,
  incidentId: true,
  courseId: true,
  cycle: true,
  result: true,
  preProbeId: true,
  postProbeId: true,
  proofSnapshot: true,
  verifiedIncidentUpdatedAt: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
  batch: {
    select: {
      id: true,
      status: true,
      revision: true,
      ownerAutomationRunId: true,
      baseSha: true,
      releaseSha: true,
      deployedAt: true,
      createdAt: true,
      updatedAt: true,
      recheckDispatchKey: true,
      recheckDispatchStartedAt: true,
      recheckDispatchedAt: true,
      completedAt: true,
      summary: true,
      ownerAutomationRun: {
        select: {
          id: true,
          promptVersion: true,
          kind: true,
          status: true,
          runtimeVersion: true,
          completedAt: true,
          outcome: true,
          notes: true,
        },
      },
    },
  },
  verificationRequests: {
    select: {
      id: true,
      courseId: true,
      releaseSha: true,
      providerSnapshotFingerprint: true,
      providerSnapshotAt: true,
      discoveryAttemptedAt: true,
      discoveryVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
      status: true,
      revision: true,
      attemptCount: true,
      workflowRunId: true,
      startedAt: true,
      outcome: true,
      failureClass: true,
      evidence: true,
      lastError: true,
    },
  },
} satisfies Prisma.CourseSupportBatchIncidentSelect;

export type ParkedCourseCampaignSameCycleRecoveryHistory = {
  historyDigest: string;
  batchCount: number;
  requestCount: number;
  startedRequestCount: number;
  requestFences: Array<{
    id: string;
    batchIncidentId: string;
    courseId?: string;
    releaseSha: string;
    providerSnapshotFingerprint?: string;
    providerSnapshotAt?: Date;
    discoveryAttemptedAt: Date | null;
    discoveryVerifiedAt: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
    status: CourseSupportZeroExecutionBatchEvidence["verificationRequests"][number]["status"];
    revision: number;
    attemptCount: number;
    workflowRunId: string | null;
    startedAt: Date | null;
    outcome: CourseSupportZeroExecutionBatchEvidence["verificationRequests"][number]["outcome"];
    failureClass: CourseSupportZeroExecutionBatchEvidence["verificationRequests"][number]["failureClass"];
    evidence: unknown;
    lastError: string | null;
  }>;
  absentRequestFences: Array<{
    batchIncidentId: string;
  }>;
};

export function assessParkedCourseCampaignSameCycleRecoveryHistory(input: {
  courseId: string;
  cycle: number;
  entries: readonly CourseSupportZeroExecutionBatchEvidence[];
  requireOrchestrationOnly: boolean;
  requireStartedRequest?: boolean;
  requireCausalStartedRequest?: boolean;
  minimumStartedAt?: Date;
}): ParkedCourseCampaignSameCycleRecoveryHistory | null {
  const entries = input.entries
    .filter((entry) => entry.cycle === input.cycle)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (entries.length === 0) return null;

  const canonicalEntries: Array<Record<string, unknown>> = [];
  const requestFences: ParkedCourseCampaignSameCycleRecoveryHistory["requestFences"] =
    [];
  const absentRequestFences: ParkedCourseCampaignSameCycleRecoveryHistory["absentRequestFences"] =
    [];
  let requestCount = 0;
  let startedRequestCount = 0;
  for (const entry of entries) {
    const runtimeVersion = entry.batch.releaseSha ?? entry.batch.baseSha;
    if (
      !entry.batch.completedAt ||
      !runtimeVersion ||
      !["RETRY_SCHEDULED", "NEEDS_HUMAN", "STALE_EVIDENCE"].includes(
        entry.result,
      ) ||
      (input.requireOrchestrationOnly &&
        !isCourseSupportCompletedBatchOrchestrationOnly({
          courseId: input.courseId,
          summary: entry.batch.summary,
          allowValidatedLegacy: true,
        }))
    ) {
      return null;
    }

    const requests = [...entry.verificationRequests].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (requests.length === 0) {
      absentRequestFences.push({ batchIncidentId: entry.id });
    }
    for (const request of requests) {
      const requestLineage = request as typeof request & {
        courseId?: string;
        providerSnapshotFingerprint?: string;
        providerSnapshotAt?: Date;
        discoveryAttemptedAt?: Date | null;
        discoveryVerifiedAt?: Date | null;
        createdAt?: Date;
        updatedAt?: Date;
      };
      if (
        request.releaseSha !== runtimeVersion ||
        request.status === "QUEUED" ||
        request.status === "CHECKING" ||
        (input.requireOrchestrationOnly &&
          !isCourseSupportVerificationRequestUnstarted(request))
      ) {
        return null;
      }
      requestFences.push({
        id: request.id,
        batchIncidentId: entry.id,
        courseId: requestLineage.courseId,
        releaseSha: request.releaseSha,
        providerSnapshotFingerprint: requestLineage.providerSnapshotFingerprint,
        providerSnapshotAt: requestLineage.providerSnapshotAt,
        discoveryAttemptedAt: requestLineage.discoveryAttemptedAt ?? null,
        discoveryVerifiedAt: requestLineage.discoveryVerifiedAt ?? null,
        createdAt: requestLineage.createdAt,
        updatedAt: requestLineage.updatedAt,
        status: request.status,
        revision: request.revision,
        attemptCount: request.attemptCount,
        workflowRunId: request.workflowRunId,
        startedAt: request.startedAt,
        outcome: request.outcome,
        failureClass: request.failureClass,
        evidence: request.evidence,
        lastError: request.lastError ?? null,
      });
      if (
        request.startedAt &&
        request.attemptCount > 0 &&
        request.revision >= 2 &&
        (!input.requireCausalStartedRequest ||
          ("createdAt" in entry &&
            entry.createdAt instanceof Date &&
            "createdAt" in entry.batch &&
            entry.batch.createdAt instanceof Date &&
            request.startedAt >= entry.createdAt &&
            request.startedAt >= entry.batch.createdAt &&
            (!input.minimumStartedAt ||
              request.startedAt >= input.minimumStartedAt))) &&
        request.startedAt <= entry.batch.completedAt
      ) {
        startedRequestCount += 1;
      }
    }
    requestCount += requests.length;
    canonicalEntries.push({
      batchIncidentId: entry.id,
      cycle: entry.cycle,
      result: entry.result,
      baseSha: entry.batch.baseSha,
      releaseSha: entry.batch.releaseSha,
      completedAt: entry.batch.completedAt.toISOString(),
      summary: entry.batch.summary,
      requests: requests.map((request) => ({
        id: request.id,
        releaseSha: request.releaseSha,
        status: request.status,
        revision: request.revision,
        attemptCount: request.attemptCount,
        workflowRunId: request.workflowRunId,
        startedAt: request.startedAt?.toISOString() ?? null,
        outcome: request.outcome,
        failureClass: request.failureClass,
        evidence: request.evidence,
        lastError: request.lastError ?? null,
      })),
    });
  }

  requestFences.sort((left, right) => left.id.localeCompare(right.id));
  absentRequestFences.sort((left, right) =>
    left.batchIncidentId.localeCompare(right.batchIncidentId),
  );
  if (input.requireStartedRequest && startedRequestCount === 0) {
    return null;
  }
  return {
    historyDigest: createHash("sha256")
      .update(stableCourseProviderExecutionEvidenceValue(canonicalEntries))
      .digest("hex"),
    batchCount: entries.length,
    requestCount,
    startedRequestCount,
    requestFences,
    absentRequestFences,
  };
}

export type ParkedCourseCampaignRequestlessStaleOwnershipRecovery =
  ParkedCourseCampaignSameCycleRecoveryHistory & {
    abandonedBaseRuntime: string;
    batchFence: {
      id: string;
      status: string;
      revision: number;
      ownerAutomationRunId: string;
      baseSha: string;
      completedAt: Date;
      updatedAt: Date;
      summary: unknown;
    };
    batchIncidentFence: {
      id: string;
      batchId: string;
      incidentId: string;
      courseId: string;
      cycle: number;
      result: string;
      createdAt: Date;
      updatedAt: Date;
    };
    ownerRunFence: {
      id: string;
      promptVersion: string;
      kind: string;
      status: string;
      runtimeVersion: string;
      completedAt: Date;
      outcome: string;
      notes: string;
    };
    probeFence: {
      id: string;
      courseId: string;
      observedAt: Date;
    } | null;
    discoveryFence: {
      id: string;
      courseId: string;
      createdAt: Date;
    } | null;
  };

export function assessParkedCourseCampaignRequestlessStaleOwnershipRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMember & {
    zeroExecutionEvidence: ParkedCourseCampaignRecoveryEvidence;
  };
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
  currentRuntimeVersion: string;
}): ParkedCourseCampaignRequestlessStaleOwnershipRecovery | null {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  if (
    !input.campaignRunId.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.campaignMembershipDigest) ||
    !input.currentRuntimeVersion.trim() ||
    !Number.isFinite(input.capturedAt.getTime()) ||
    current.courseId !== captured.courseId ||
    current.incidentId !== captured.incidentId ||
    current.cycle !== captured.cycle + 1 ||
    current.kind !== captured.kind ||
    current.providerFamilyKey !== captured.providerFamilyKey ||
    current.failureClass !== captured.failureClass ||
    current.failureFingerprint !== captured.failureFingerprint ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    current.monitoringFailureFingerprint !==
      captured.monitoringFailureFingerprint ||
    current.providerSnapshotFingerprint !==
      captured.providerSnapshotFingerprint ||
    current.attemptLedgerFingerprint !== captured.attemptLedgerFingerprint ||
    current.playbookConclusion !== captured.playbookConclusion ||
    current.latestProbeAt !== captured.latestProbeAt ||
    current.latestDiscoveryAt !== captured.latestDiscoveryAt ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.completedStages.length !== 0 ||
    playbook.nextStage !== "OFFICIAL_IDENTITY"
  ) {
    return null;
  }

  const capturedLatestProbeAt = captured.latestProbeAt
    ? new Date(captured.latestProbeAt)
    : null;
  const latestProbe = current.zeroExecutionEvidence.latestProbe;
  if (
    (capturedLatestProbeAt !== null &&
      (!Number.isFinite(capturedLatestProbeAt.getTime()) ||
        capturedLatestProbeAt >= input.capturedAt ||
        !latestProbe ||
        latestProbe.id.length === 0 ||
        latestProbe.courseId !== current.courseId ||
        latestProbe.observedAt.getTime() !==
          capturedLatestProbeAt.getTime())) ||
    (capturedLatestProbeAt === null && latestProbe !== null)
  ) {
    return null;
  }

  const capturedLatestDiscoveryAt = captured.latestDiscoveryAt
    ? new Date(captured.latestDiscoveryAt)
    : null;
  const latestDiscovery = current.zeroExecutionEvidence.latestDiscovery;
  if (
    (capturedLatestDiscoveryAt !== null &&
      (!Number.isFinite(capturedLatestDiscoveryAt.getTime()) ||
        capturedLatestDiscoveryAt >= input.capturedAt ||
        !latestDiscovery ||
        !latestDiscovery.id.trim() ||
        latestDiscovery.courseId !== current.courseId ||
        latestDiscovery.createdAt.getTime() !==
          capturedLatestDiscoveryAt.getTime() ||
        current.zeroExecutionEvidence.latestDiscoveryTimestampRowCount !==
          1)) ||
    (capturedLatestDiscoveryAt === null &&
      (latestDiscovery !== null ||
        current.zeroExecutionEvidence.latestDiscoveryTimestampRowCount !== 0))
  ) {
    return null;
  }

  const currentCycleEntries =
    current.zeroExecutionEvidence.batchIncidents.filter(
      (entry) => entry.cycle === current.cycle,
    );
  if (currentCycleEntries.length !== 1) return null;
  const entry = currentCycleEntries[0]!;
  const batch = entry.batch;
  const ownerRun = batch.ownerAutomationRun;
  const preProbeMatches = latestProbe
    ? entry.preProbeId === latestProbe.id
    : entry.preProbeId === null;
  if (
    entry.batchId !== batch.id ||
    entry.incidentId !== current.incidentId ||
    entry.courseId !== current.courseId ||
    entry.result !== "NEEDS_HUMAN" ||
    !preProbeMatches ||
    entry.postProbeId !== null ||
    entry.proofSnapshot !== null ||
    entry.verifiedIncidentUpdatedAt !== null ||
    entry.verifiedAt !== null ||
    entry.verificationRequests.length !== 0 ||
    batch.status !== "PARTIAL" ||
    !batch.completedAt ||
    batch.releaseSha !== null ||
    batch.deployedAt !== null ||
    batch.recheckDispatchKey !== null ||
    batch.recheckDispatchStartedAt !== null ||
    batch.recheckDispatchedAt !== null ||
    !batch.baseSha.trim() ||
    !(batch.updatedAt instanceof Date) ||
    !Number.isFinite(batch.updatedAt.getTime()) ||
    batch.completedAt.getTime() > batch.updatedAt.getTime() ||
    batch.baseSha === input.currentRuntimeVersion ||
    !batch.ownerAutomationRunId ||
    !ownerRun ||
    ownerRun.id !== batch.ownerAutomationRunId ||
    ownerRun.promptVersion !== COURSE_SUPPORT_RESPONDER_PROMPT_VERSION ||
    ownerRun.kind !== "COURSE_SUPPORT" ||
    ownerRun.status !== "COMPLETED" ||
    ownerRun.runtimeVersion !== batch.baseSha ||
    ownerRun.completedAt?.getTime() !== batch.completedAt.getTime() ||
    ownerRun.outcome !== "needs_human" ||
    typeof ownerRun.notes !== "string"
  ) {
    return null;
  }

  const summary = asCampaignRecord(batch.summary);
  const closeout = asCampaignRecord(summary.closeout);
  const campaign = asCampaignRecord(summary.campaign);
  const closeoutKeys = [
    "outcome",
    "derivedOutcome",
    "terminalCount",
    "restoredCount",
    "finalDispositionCount",
    "retryCount",
    "needsHumanCount",
    "endpointCount",
    "automationStalledCount",
    "exhaustedEndpointCount",
    "failureDomain",
    "verificationWatchMode",
    "reason",
  ];
  const countKeys = [
    "terminalCount",
    "restoredCount",
    "finalDispositionCount",
    "retryCount",
    "needsHumanCount",
    "endpointCount",
    "automationStalledCount",
    "exhaustedEndpointCount",
  ] as const;
  const countsAreValid = countKeys.every(
    (key) => Number.isInteger(closeout[key]) && Number(closeout[key]) >= 0,
  );
  if (
    !hasExactCampaignRecordKeys(closeout, closeoutKeys) ||
    !countsAreValid ||
    closeout.outcome !== "needs_human" ||
    closeout.derivedOutcome !== "needs_human" ||
    closeout.reason !== "stale_endpoint_ownership_released" ||
    closeout.failureDomain !== "SLA" ||
    closeout.verificationWatchMode !== "ENDPOINT" ||
    Number(closeout.needsHumanCount) < 1 ||
    Number(closeout.automationStalledCount) < 1 ||
    Number(closeout.terminalCount) !==
      Number(closeout.restoredCount) + Number(closeout.finalDispositionCount) ||
    Number(closeout.endpointCount) !==
      Number(closeout.automationStalledCount) +
        Number(closeout.exhaustedEndpointCount) ||
    Number(closeout.endpointCount) > Number(closeout.needsHumanCount) ||
    !Number.isInteger(summary.selectedIncidentCount) ||
    Number(summary.selectedIncidentCount) < 1 ||
    Number(summary.selectedIncidentCount) > 20 ||
    Number(summary.selectedIncidentCount) !==
      Number(closeout.terminalCount) +
        Number(closeout.retryCount) +
        Number(closeout.needsHumanCount) ||
    !hasZeroParkedCourseCampaignReleaseHistory(summary.releaseHistory) ||
    !hasZeroParkedCourseCampaignExecutionEver(summary.executionEver) ||
    !hasExactCampaignRecordKeys(campaign, ["kind", "attempts"]) ||
    campaign.kind !== "PARKED_COHORT" ||
    !Array.isArray(campaign.attempts)
  ) {
    return null;
  }

  const courseRef = createHash("sha256")
    .update(current.courseId)
    .digest("hex")
    .slice(0, 24);
  const currentCourseCampaignAttempts = campaign.attempts.filter(
    (candidate) => {
      const attempt = asCampaignRecord(candidate);
      return attempt.courseRef === courseRef && attempt.cycle === current.cycle;
    },
  );
  const matchingCampaignAttempts = currentCourseCampaignAttempts.filter(
    (candidate) => {
      const attempt = asCampaignRecord(candidate);
      return (
        hasExactCampaignRecordKeys(attempt, [
          "courseRef",
          "runId",
          "membershipDigest",
          "cycle",
        ]) &&
        attempt.runId === input.campaignRunId &&
        attempt.membershipDigest === input.campaignMembershipDigest &&
        attempt.cycle === current.cycle
      );
    },
  );
  if (
    currentCourseCampaignAttempts.length !== 1 ||
    matchingCampaignAttempts.length !== 1
  ) {
    return null;
  }

  const ownerNotes = parseParkedCourseCampaignOwnerRunNotes(ownerRun.notes);
  const ownerNoteKeys = [
    "schemaVersion",
    "lifecycle",
    "status",
    "outcome",
    "derivedOutcome",
    "reason",
    "endpointCount",
    "automationStalledCount",
    "exhaustedEndpointCount",
    "failureDomain",
    "verificationWatchMode",
    "terminalCount",
    "restoredCount",
    "finalDispositionCount",
    "retryCount",
    "needsHumanCount",
  ];
  if (
    !ownerNotes ||
    !hasExactCampaignRecordKeys(ownerNotes, ownerNoteKeys) ||
    ownerNotes.schemaVersion !== 1 ||
    ownerNotes.lifecycle !== "closeout" ||
    ownerNotes.status !== "PARTIAL" ||
    ownerNotes.outcome !== "needs_human" ||
    ownerNotes.derivedOutcome !== "needs_human" ||
    ownerNotes.reason !== "stale_endpoint_ownership_released" ||
    ownerNoteKeys.slice(6).some((key) => ownerNotes[key] !== closeout[key])
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const admissions = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      event.failureFingerprint === current.failureFingerprint &&
      event.occurredAt >= input.capturedAt &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      !Object.prototype.hasOwnProperty.call(audit, "admissionRuntimeVersion") &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === current.cycle &&
      audit.capturedIncidentRevision === captured.revision &&
      audit.capturedMonitoringRevision === captured.monitoringRevision &&
      audit.preservesPriorAttemptEvents === true &&
      audit.customerDataIncluded === false
    );
  });
  const attempts = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "AUTOMATION_ATTEMPTED" &&
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      event.failureFingerprint === current.failureFingerprint &&
      event.readPath === "BOUNDED_RECOVERY_PLAYBOOK" &&
      audit.providerFamilyKey === current.providerFamilyKey &&
      Number.isInteger(audit.maxCourses) &&
      Number(audit.maxCourses) >= 1 &&
      Number(audit.maxCourses) <= 20 &&
      audit.serializedWriterLane === true &&
      audit.campaignKind === "PARKED_COHORT" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.cycle === current.cycle &&
      audit.customerDataIncluded === false
    );
  });
  const endpoints = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    const provenance = asCampaignRecord(audit.campaign);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.source === "RECOVERY_CRON" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.customerState === "NEEDS_HUMAN_REVIEW" &&
      audit.playbookConclusion === "INCOMPLETE" &&
      audit.playbookExhausted === false &&
      audit.automationStalled === true &&
      audit.parkedUntilMaterialChange === true &&
      audit.nextStage === "OFFICIAL_IDENTITY" &&
      audit.customerDataIncluded === false &&
      provenance.kind === "PARKED_COHORT" &&
      provenance.runId === input.campaignRunId &&
      provenance.membershipDigest === input.campaignMembershipDigest &&
      provenance.cycle === current.cycle
    );
  });
  const currentCycleAdmissions = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_admission" &&
      audit.cycle === current.cycle
    );
  });
  const currentCycleAttempts = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "AUTOMATION_ATTEMPTED" &&
      audit.cycle === current.cycle
    );
  });
  const currentCycleRecoveryCronEndpoints = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.source === "RECOVERY_CRON" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.automationStalled === true
    );
  });
  const priorRecoveryRecorded = events.some((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_requestless_stale_ownership_recovery" &&
      audit.cycle === current.cycle
    );
  });
  if (
    admissions.length !== 1 ||
    currentCycleAdmissions.length !== 1 ||
    attempts.length !== 1 ||
    currentCycleAttempts.length !== 1 ||
    endpoints.length !== 1 ||
    currentCycleRecoveryCronEndpoints.length !== 1 ||
    priorRecoveryRecorded ||
    admissions[0]!.occurredAt > attempts[0]!.occurredAt ||
    attempts[0]!.occurredAt >= endpoints[0]!.occurredAt ||
    batch.completedAt.getTime() > endpoints[0]!.occurredAt.getTime()
  ) {
    return null;
  }

  const canonicalEvidence = {
    campaignRunId: input.campaignRunId,
    campaignMembershipDigest: input.campaignMembershipDigest,
    capturedAt: input.capturedAt.toISOString(),
    captured,
    current: {
      courseId: current.courseId,
      incidentId: current.incidentId,
      cycle: current.cycle,
      revision: current.revision,
      monitoringRevision: current.monitoringRevision,
      monitoringFailureFingerprint: current.monitoringFailureFingerprint,
      kind: current.kind,
      providerFamilyKey: current.providerFamilyKey,
      failureClass: current.failureClass,
      failureFingerprint: current.failureFingerprint,
      providerSnapshotFingerprint: current.providerSnapshotFingerprint,
      attemptLedgerFingerprint: current.attemptLedgerFingerprint,
      playbookConclusion: current.playbookConclusion,
      latestProbeAt: current.latestProbeAt,
      latestDiscoveryAt: current.latestDiscoveryAt,
      latestDiscovery: latestDiscovery
        ? {
            id: latestDiscovery.id,
            courseId: latestDiscovery.courseId,
            createdAt: latestDiscovery.createdAt.toISOString(),
          }
        : null,
    },
    currentRuntimeVersion: input.currentRuntimeVersion,
    admission: canonicalizeParkedCourseCampaignRecoveryEvent(admissions[0]!),
    attempt: canonicalizeParkedCourseCampaignRecoveryEvent(attempts[0]!),
    endpoint: canonicalizeParkedCourseCampaignRecoveryEvent(endpoints[0]!),
    batchIncident: {
      id: entry.id,
      batchId: entry.batchId,
      incidentId: entry.incidentId,
      courseId: entry.courseId,
      cycle: entry.cycle,
      result: entry.result,
      preProbeId: entry.preProbeId,
      postProbeId: entry.postProbeId,
      proofSnapshot: entry.proofSnapshot,
      verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
      verifiedAt: entry.verifiedAt,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    },
    batch: {
      id: batch.id,
      status: batch.status,
      revision: batch.revision,
      ownerAutomationRunId: batch.ownerAutomationRunId,
      baseSha: batch.baseSha,
      releaseSha: batch.releaseSha,
      deployedAt: batch.deployedAt,
      recheckDispatchKey: batch.recheckDispatchKey,
      recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      recheckDispatchedAt: batch.recheckDispatchedAt,
      completedAt: batch.completedAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
      summary: batch.summary,
    },
    ownerRun: {
      id: ownerRun.id,
      promptVersion: ownerRun.promptVersion,
      kind: ownerRun.kind,
      status: ownerRun.status,
      runtimeVersion: ownerRun.runtimeVersion,
      completedAt: ownerRun.completedAt.toISOString(),
      outcome: ownerRun.outcome,
      notes: ownerRun.notes,
    },
  };
  return {
    historyDigest: createHash("sha256")
      .update(stableCourseProviderExecutionEvidenceValue(canonicalEvidence))
      .digest("hex"),
    batchCount: 1,
    requestCount: 0,
    startedRequestCount: 0,
    requestFences: [],
    absentRequestFences: [{ batchIncidentId: entry.id }],
    abandonedBaseRuntime: batch.baseSha,
    batchFence: {
      id: batch.id,
      status: batch.status,
      revision: batch.revision,
      ownerAutomationRunId: batch.ownerAutomationRunId,
      baseSha: batch.baseSha,
      completedAt: batch.completedAt,
      updatedAt: batch.updatedAt,
      summary: batch.summary,
    },
    batchIncidentFence: {
      id: entry.id,
      batchId: entry.batchId,
      incidentId: entry.incidentId,
      courseId: entry.courseId,
      cycle: entry.cycle,
      result: entry.result,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    ownerRunFence: {
      id: ownerRun.id,
      promptVersion: ownerRun.promptVersion,
      kind: ownerRun.kind,
      status: ownerRun.status,
      runtimeVersion: ownerRun.runtimeVersion,
      completedAt: ownerRun.completedAt,
      outcome: ownerRun.outcome,
      notes: ownerRun.notes,
    },
    probeFence: latestProbe,
    discoveryFence: latestDiscovery,
  };
}

function parseParkedCourseCampaignOwnerRunNotes(value: string) {
  try {
    return asCampaignRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function hasExactCampaignRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasZeroParkedCourseCampaignReleaseHistory(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function hasZeroParkedCourseCampaignExecutionEver(value: unknown) {
  if (value === undefined) return true;
  const record = asCampaignRecord(value);
  return (
    hasExactCampaignRecordKeys(record, [
      "schemaVersion",
      "changedReleaseDeploymentRecorded",
      "providerExecutionCourseRefs",
      "providerExecutionAttemptCourseRefs",
      "terminalExecutionCourseRefs",
    ]) &&
    record.schemaVersion === 2 &&
    record.changedReleaseDeploymentRecorded === false &&
    Array.isArray(record.providerExecutionCourseRefs) &&
    record.providerExecutionCourseRefs.length === 0 &&
    Array.isArray(record.providerExecutionAttemptCourseRefs) &&
    record.providerExecutionAttemptCourseRefs.length === 0 &&
    Array.isArray(record.terminalExecutionCourseRefs) &&
    record.terminalExecutionCourseRefs.length === 0
  );
}

function canonicalizeParkedCourseCampaignRecoveryEvent(
  event: ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number],
) {
  return {
    id: event.id ?? null,
    incidentId: event.incidentId,
    eventType: event.eventType,
    source: event.source,
    failureFingerprint: event.failureFingerprint,
    readPath: event.readPath,
    occurredAt: event.occurredAt.toISOString(),
    audit: event.audit,
  };
}

type ParkedCourseCampaignMemberSnapshot = ParkedCourseCampaignMember & {
  activeRealSearchCount: number;
  zeroExecutionEvidence: ParkedCourseCampaignRecoveryEvidence;
};

async function loadParkedCourseCampaignMemberSnapshots(
  database: ParkedCourseCampaignDatabase,
  input: {
    requireZeroDemand: boolean;
    incidentIds?: readonly string[];
    requireExactCurrentCycleBatchHistory?: boolean;
  },
): Promise<ParkedCourseCampaignMemberSnapshot[]> {
  const incidents = await database.courseSupportIncident.findMany({
    where: {
      ...(input.incidentIds?.length
        ? { id: { in: [...input.incidentIds] } }
        : {}),
      status: "NEEDS_HUMAN",
      humanReviewReason: "AUTOMATION_STALLED",
      ...(input.requireZeroDemand ? { activeRealSearchCount: 0 } : {}),
      activeBatchId: null,
      nextAttemptAt: null,
      resolution: null,
      resolvedAt: null,
      resolutionMessage: null,
      resolutionNotifiedAt: null,
      decisionActorId: null,
      decisionAt: null,
      decisionNote: null,
      decisionEvidenceUrl: null,
      decisionIdempotencyKey: null,
      course: {
        ...(input.requireZeroDemand
          ? {
              preferences: {
                none: {
                  teeSearch: {
                    status: "ACTIVE",
                    trafficClass: {
                      notIn: [...syntheticWebsiteTrafficClasses],
                    },
                  },
                },
              },
            }
          : {}),
        monitoringStatus: {
          is: {
            state: "ENGINEERING_VERIFICATION_NEEDED",
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
          },
        },
      },
    },
    orderBy: { courseId: "asc" },
    select: {
      id: true,
      courseId: true,
      cycle: true,
      revision: true,
      kind: true,
      providerFamilyKey: true,
      failureClass: true,
      failureFingerprint: true,
      attemptLedger: true,
      humanReviewReason: true,
      status: true,
      activeRealSearchCount: true,
      escalatedAt: true,
      resolution: true,
      resolvedAt: true,
      resolutionMessage: true,
      resolutionNotifiedAt: true,
      decisionActorId: true,
      decisionAt: true,
      decisionNote: true,
      decisionEvidenceUrl: true,
      decisionIdempotencyKey: true,
      monitoringEvents: {
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 50,
        select: {
          id: true,
          incidentId: true,
          eventType: true,
          source: true,
          failureFingerprint: true,
          readPath: true,
          occurredAt: true,
          audit: true,
        },
      },
      batchIncidents: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: parkedCourseCampaignBatchIncidentSelect,
      },
      course: {
        select: {
          timeZone: true,
          isPublic: true,
          website: true,
          detectedBookingUrl: true,
          detectedPlatform: true,
          providerFamilyKey: true,
          bookingMethod: true,
          bookingWindowDaysAhead: true,
          bookingReleaseTimeLocal: true,
          bookingWindowSource: true,
          bookingWindowConfidence: true,
          bookingWindowEvidenceUrl: true,
          automationEligibility: true,
          automationReason: true,
          monitoringMode: true,
          bookingAccessMode: true,
          intelligenceVerifiedAt: true,
          intelligenceReviewAt: true,
          intelligenceConfidence: true,
          bookingMetadata: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
          preferences: {
            where: {
              teeSearch: {
                status: "ACTIVE",
                trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
              },
            },
            select: { id: true },
          },
          monitoringStatus: {
            select: {
              state: true,
              revision: true,
              failureFingerprint: true,
              nextAutomaticAttemptAt: true,
              revalidationRequestedAt: true,
            },
          },
          probes: {
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            take: 2,
            select: { id: true, courseId: true, observedAt: true },
          },
          automationDiscoveries: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 2,
            select: { id: true, courseId: true, createdAt: true },
          },
        },
      },
    },
  });
  const exactCurrentCycleBatchHistory =
    input.requireExactCurrentCycleBatchHistory
      ? new Map(
          (
            await Promise.all(
              incidents.map(async (incident) => {
                const [reloaded] =
                  await database.courseSupportIncident.findMany({
                    where: { id: incident.id, cycle: incident.cycle },
                    take: 1,
                    select: {
                      id: true,
                      cycle: true,
                      batchIncidents: {
                        where: { cycle: incident.cycle },
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        take: 21,
                        select: parkedCourseCampaignBatchIncidentSelect,
                      },
                    },
                  });
                if (
                  !reloaded ||
                  reloaded.id !== incident.id ||
                  reloaded.cycle !== incident.cycle
                ) {
                  return null;
                }
                return [
                  incident.id,
                  reloaded.batchIncidents.filter(
                    (entry) => entry.cycle === incident.cycle,
                  ),
                ] as const;
              }),
            )
          ).filter(
            (entry): entry is NonNullable<typeof entry> => entry !== null,
          ),
        )
      : null;
  return incidents.flatMap((incident) => {
    const currentCycleBatchIncidents = exactCurrentCycleBatchHistory?.get(
      incident.id,
    );
    if (
      input.requireExactCurrentCycleBatchHistory &&
      !currentCycleBatchIncidents
    ) {
      return [];
    }
    const monitoringStatus = incident.course.monitoringStatus;
    if (
      !monitoringStatus ||
      incident.resolution !== null ||
      incident.resolvedAt !== null ||
      incident.resolutionMessage !== null ||
      incident.resolutionNotifiedAt !== null ||
      incident.decisionActorId !== null ||
      incident.decisionAt !== null ||
      incident.decisionNote !== null ||
      incident.decisionEvidenceUrl !== null ||
      incident.decisionIdempotencyKey !== null ||
      !hasDurableWaitForMaterialChangeProof({
        incidentId: incident.id,
        incidentCycle: incident.cycle,
        incidentStatus: incident.status,
        humanReviewReason: incident.humanReviewReason,
        incidentEscalatedAt: incident.escalatedAt,
        monitoringState: monitoringStatus.state,
        endpointEvents: incident.monitoringEvents.filter(
          (event) => event.failureFingerprint === incident.failureFingerprint,
        ),
      })
    ) {
      return [];
    }
    return [
      {
        courseId: incident.courseId,
        incidentId: incident.id,
        cycle: incident.cycle,
        revision: incident.revision,
        monitoringRevision: monitoringStatus.revision,
        monitoringFailureFingerprint: monitoringStatus.failureFingerprint,
        kind: incident.kind,
        providerFamilyKey: incident.providerFamilyKey,
        failureClass: incident.failureClass,
        failureFingerprint: incident.failureFingerprint,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(incident.course),
        attemptLedgerFingerprint:
          createParkedCourseCampaignAttemptLedgerFingerprint(
            incident.attemptLedger,
          ),
        playbookConclusion: assessAutomationPlaybook(
          incident.attemptLedger,
          incident.cycle,
        ).conclusion,
        latestProbeAt:
          incident.course.probes[0]?.observedAt.toISOString() ?? null,
        latestDiscoveryAt:
          incident.course.automationDiscoveries[0]?.createdAt.toISOString() ??
          null,
        activeRealSearchCount: Math.max(
          incident.activeRealSearchCount,
          incident.course.preferences.length,
        ),
        zeroExecutionEvidence: {
          latestProbe: incident.course.probes[0] ?? null,
          latestDiscovery: incident.course.automationDiscoveries[0] ?? null,
          latestProbeTimestampRowCount: incident.course.probes[0]
            ? incident.course.probes.filter(
                (probe) =>
                  probe.observedAt.getTime() ===
                  incident.course.probes[0]!.observedAt.getTime(),
              ).length
            : 0,
          latestDiscoveryTimestampRowCount: incident.course
            .automationDiscoveries[0]
            ? incident.course.automationDiscoveries.filter(
                (discovery) =>
                  discovery.createdAt.getTime() ===
                  incident.course.automationDiscoveries[0]!.createdAt.getTime(),
              ).length
            : 0,
          monitoringEvents: incident.monitoringEvents,
          batchIncidents: currentCycleBatchIncidents ?? incident.batchIncidents,
          playbookAssessment: assessAutomationPlaybook(
            incident.attemptLedger,
            incident.cycle,
          ),
        },
      },
    ];
  });
}

function stripParkedCourseCampaignRecoveryEvidence(
  snapshot: ParkedCourseCampaignMemberSnapshot,
) {
  const { zeroExecutionEvidence, ...member } = snapshot;
  void zeroExecutionEvidence;
  return member;
}

function getParkedCourseCampaignZeroExecutionRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  campaignRunId: string;
  campaignMembershipDigest: string;
  runtimeVersion: string;
}) {
  const { captured, current } = input;
  if (
    !input.campaignRunId ||
    current.courseId !== captured.courseId ||
    current.incidentId !== captured.incidentId ||
    current.cycle !== captured.cycle + 1 ||
    current.kind !== captured.kind ||
    current.providerFamilyKey !== captured.providerFamilyKey ||
    current.failureClass !== captured.failureClass ||
    current.failureFingerprint !== captured.failureFingerprint ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    current.providerSnapshotFingerprint !==
      captured.providerSnapshotFingerprint ||
    current.attemptLedgerFingerprint !== captured.attemptLedgerFingerprint ||
    current.playbookConclusion !== captured.playbookConclusion ||
    current.latestProbeAt !== captured.latestProbeAt ||
    current.latestDiscoveryAt !== captured.latestDiscoveryAt
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const admission = events.find((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === current.cycle
    );
  });
  const alreadyRecovered = events.some((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_zero_execution_recovery" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.cycle === current.cycle
    );
  });
  const endpoint = events.find((event) => {
    const audit = asCampaignRecord(event.audit);
    const campaign = asCampaignRecord(audit.campaign);
    return (
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.automationStalled === true &&
      audit.parkedUntilMaterialChange === true &&
      audit.customerState === "NEEDS_HUMAN_REVIEW" &&
      audit.playbookExhausted === false &&
      (audit.endpointStalled === true ||
        audit.operationalRetryBudgetExhausted === true ||
        (event.source === "RECOVERY_CRON" &&
          campaign.runId === input.campaignRunId &&
          campaign.membershipDigest === input.campaignMembershipDigest &&
          campaign.cycle === current.cycle))
    );
  });
  if (
    !admission ||
    alreadyRecovered ||
    !endpoint ||
    endpoint.occurredAt < admission.occurredAt
  ) {
    return null;
  }

  return assessCourseSupportZeroExecutionHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    campaignRunId: input.campaignRunId,
    campaignMembershipDigest: input.campaignMembershipDigest,
    currentRuntimeVersion: input.runtimeVersion,
    entries: current.zeroExecutionEvidence.batchIncidents,
  });
}

function getParkedCourseCampaignIncompletePlaybookRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  if (
    !input.campaignRunId ||
    !isSameParkedCourseCampaignIdentity(captured, current) ||
    current.cycle !== captured.cycle + 1 ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.completedStages.length === 0 ||
    playbook.nextStage === null
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const admission = events.find((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === current.cycle
    );
  });
  const endpoint = findParkedCourseCampaignAutomationStalledEndpoint(current);
  const alreadyRecovered = hasParkedCourseCampaignRecoveryMarker({
    events,
    action: "parked_cohort_incomplete_playbook_recovery",
    campaignRunId: input.campaignRunId,
    cycle: current.cycle,
  });
  if (
    !admission ||
    !endpoint ||
    endpoint.occurredAt < admission.occurredAt ||
    alreadyRecovered
  ) {
    return null;
  }
  return assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries: current.zeroExecutionEvidence.batchIncidents,
    requireOrchestrationOnly: false,
  });
}

export type ParkedCourseCampaignPostMarkerIncompletePlaybookRecovery = {
  priorRecoveryMarkerDigest: string;
  priorRecoveryRuntimeVersion: string;
  failedRuntimeVersions: string[];
  postMarkerHistoryDigest: string;
  postMarkerBatchCount: 1;
  postMarkerRequestCount: 0;
  supersededEndpointId: string;
  supersededEndpointAt: Date;
  history: ParkedCourseCampaignSameCycleRecoveryHistory;
};

function hasExactPostMarkerOrchestrationOnlyAttempt(input: {
  courseId: string;
  failureFingerprint: string;
  providerSnapshotFingerprint: string;
  runtimeVersion: string;
  summary: unknown;
}) {
  if (
    !isCourseSupportCompletedBatchOrchestrationOnly({
      courseId: input.courseId,
      summary: input.summary,
      allowValidatedLegacy: false,
    })
  ) {
    return false;
  }
  const closeout = asCampaignRecord(asCampaignRecord(input.summary).closeout);
  const attempts = Array.isArray(closeout.remediationAttempts)
    ? closeout.remediationAttempts.map(asCampaignRecord)
    : [];
  const courseRef = createHash("sha256")
    .update(input.courseId)
    .digest("hex")
    .slice(0, 24);
  const matchingAttempts = attempts.filter(
    (attempt) => attempt.courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return false;
  const attempt = matchingAttempts[0]!;
  const execution = asCampaignRecord(attempt.executionEvidence);
  const approach = asCampaignRecord(attempt.approach);
  return (
    attempt.providerSnapshotFingerprint === input.providerSnapshotFingerprint &&
    attempt.observedProviderSnapshotFingerprint ===
      input.providerSnapshotFingerprint &&
    attempt.failureFingerprint === input.failureFingerprint &&
    attempt.observedFailureFingerprint === input.failureFingerprint &&
    attempt.runtimeVersion === input.runtimeVersion &&
    attempt.consumed === false &&
    attempt.countsTowardOperationalNoProgress === false &&
    execution.claimedImplementationPaths === false &&
    approach.workMode === "DISCOVERY_ONLY" &&
    approach.strategyAction === "DISCOVER_WITH_BROWSER" &&
    approach.playbookStage === "RENDERED_BROWSER_DISCOVERY" &&
    [
      "newReleaseRecorded",
      "deploymentRecorded",
      "postProbeRecorded",
      "providerAttemptRecorded",
      "providerExecutionAttemptRecorded",
      "playbookAttemptRecorded",
      "terminalResultRecorded",
      "providerExecutionStarted",
    ].every((key) => execution[key] === false)
  );
}

export function assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
  currentRuntimeVersion: string;
}): ParkedCourseCampaignPostMarkerIncompletePlaybookRecovery | null {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  if (
    !input.campaignRunId.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.campaignMembershipDigest) ||
    !/^[a-f0-9]{40}$/u.test(input.currentRuntimeVersion) ||
    !Number.isFinite(input.capturedAt.getTime()) ||
    !isSameParkedCourseCampaignIdentity(captured, current) ||
    current.cycle !== captured.cycle + 1 ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    current.providerSnapshotFingerprint !==
      captured.providerSnapshotFingerprint ||
    current.latestProbeAt !== captured.latestProbeAt ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.completedStages.length !== 4 ||
    playbook.nextStage !== "RENDERED_BROWSER_DISCOVERY"
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const eventsSinceCapture = events.filter(
    (event) => event.occurredAt >= input.capturedAt,
  );
  if (
    (events.length >= 50 && eventsSinceCapture.length === events.length) ||
    eventsSinceCapture.some(
      (event) => typeof event.id !== "string" || !event.id.trim(),
    )
  ) {
    return null;
  }
  const cycleAdmissions = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.cycle === current.cycle
    );
  });
  if (cycleAdmissions.length !== 1) return null;
  const admission = cycleAdmissions[0]!;
  const admissionAudit = asCampaignRecord(admission.audit);
  if (
    admission.source !== "COURSE_SUPPORT_RESPONDER" ||
    admission.failureFingerprint !== current.failureFingerprint ||
    admissionAudit.priorCycle !== captured.cycle ||
    admissionAudit.capturedIncidentRevision !== captured.revision ||
    admissionAudit.capturedMonitoringRevision !== captured.monitoringRevision ||
    admissionAudit.preservesPriorAttemptEvents !== true ||
    admissionAudit.customerDataIncluded !== false
  ) {
    return null;
  }

  const priorMarkerCandidates = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === "parked_cohort_incomplete_playbook_recovery" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.cycle === current.cycle
    );
  });
  if (priorMarkerCandidates.length !== 1) return null;
  const priorMarker = priorMarkerCandidates[0]!;
  const priorMarkerAudit = asCampaignRecord(priorMarker.audit);
  const priorMarkerCampaign = asCampaignRecord(priorMarkerAudit.campaign);
  if (
    priorMarker.source !== "COURSE_SUPPORT_RESPONDER" ||
    priorMarker.failureFingerprint !== current.failureFingerprint ||
    priorMarker.occurredAt <= admission.occurredAt ||
    priorMarkerAudit.admissionMode !== "INCOMPLETE_PLAYBOOK_RECOVERY" ||
    priorMarkerAudit.capturedCycle !== captured.cycle ||
    typeof priorMarkerAudit.sameCycleRecoveryHistoryDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(priorMarkerAudit.sameCycleRecoveryHistoryDigest) ||
    priorMarkerAudit.providerSnapshotFingerprint !==
      current.providerSnapshotFingerprint ||
    priorMarkerAudit.attemptLedgerFingerprint !==
      current.attemptLedgerFingerprint ||
    !(
      priorMarkerAudit.latestProbeAt === null ||
      (typeof priorMarkerAudit.latestProbeAt === "string" &&
        Number.isFinite(new Date(priorMarkerAudit.latestProbeAt).getTime()))
    ) ||
    !(
      priorMarkerAudit.latestDiscoveryAt === null ||
      (typeof priorMarkerAudit.latestDiscoveryAt === "string" &&
        Number.isFinite(new Date(priorMarkerAudit.latestDiscoveryAt).getTime()))
    ) ||
    priorMarkerAudit.latestProbeAt !== current.latestProbeAt ||
    priorMarkerAudit.latestDiscoveryAt !== current.latestDiscoveryAt ||
    (priorMarkerAudit.latestProbeAt !== null &&
      typeof priorMarkerAudit.latestProbeId !== "string") ||
    (priorMarkerAudit.latestProbeId !== undefined &&
      priorMarkerAudit.latestProbeId !==
        (current.zeroExecutionEvidence.latestProbe?.id ?? null)) ||
    (priorMarkerAudit.latestDiscoveryId !== undefined &&
      priorMarkerAudit.latestDiscoveryId !==
        (current.zeroExecutionEvidence.latestDiscovery?.id ?? null)) ||
    priorMarkerAudit.playbookCompletedStageCount !== 4 ||
    priorMarkerAudit.playbookNextStage !== "RENDERED_BROWSER_DISCOVERY" ||
    typeof priorMarkerAudit.recoveryRuntimeVersion !== "string" ||
    !/^[a-f0-9]{40}$/u.test(priorMarkerAudit.recoveryRuntimeVersion) ||
    priorMarkerAudit.sameCycleRecovery !== true ||
    priorMarkerAudit.oneShot !== true ||
    priorMarkerAudit.preservesAttemptLedger !== true ||
    priorMarkerAudit.preservesAttemptCounts !== true ||
    priorMarkerAudit.preservesAttemptTimestamps !== true ||
    priorMarkerAudit.preservesOperatorEvidence !== true ||
    priorMarkerAudit.preservesImmutableCampaignAudit !== true ||
    priorMarkerAudit.customerDataIncluded !== false ||
    priorMarkerCampaign.kind !== "PARKED_COHORT" ||
    priorMarkerCampaign.runId !== input.campaignRunId ||
    priorMarkerCampaign.membershipDigest !== input.campaignMembershipDigest ||
    priorMarkerCampaign.cycle !== current.cycle
  ) {
    return null;
  }
  const priorRecoveryRuntimeVersion = String(
    priorMarkerAudit.recoveryRuntimeVersion,
  );
  if (priorRecoveryRuntimeVersion === input.currentRuntimeVersion) return null;

  const priorPostMarkerRecovery = eventsSinceCapture.some((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      audit.action ===
        "parked_cohort_post_marker_incomplete_playbook_recovery" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.cycle === current.cycle
    );
  });
  if (priorPostMarkerRecovery) return null;

  const endpointCandidates = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.source === "RECOVERY_CRON" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.automationStalled === true &&
      audit.parkedUntilMaterialChange === true
    );
  });
  if (endpointCandidates.length !== 2) return null;
  const validEndpoint = (
    event: ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number],
  ) => {
    const audit = asCampaignRecord(event.audit);
    const campaign = asCampaignRecord(audit.campaign);
    return (
      audit.customerState === "NEEDS_HUMAN_REVIEW" &&
      audit.playbookConclusion === "INCOMPLETE" &&
      audit.playbookExhausted === false &&
      audit.nextStage === "RENDERED_BROWSER_DISCOVERY" &&
      audit.customerDataIncluded === false &&
      campaign.kind === "PARKED_COHORT" &&
      campaign.runId === input.campaignRunId &&
      campaign.membershipDigest === input.campaignMembershipDigest &&
      campaign.cycle === current.cycle
    );
  };
  const priorEndpoints = endpointCandidates.filter(
    (event) =>
      event.occurredAt > admission.occurredAt &&
      event.occurredAt < priorMarker.occurredAt &&
      validEndpoint(event),
  );
  const endpoints = endpointCandidates.filter(
    (event) =>
      event.occurredAt > priorMarker.occurredAt && validEndpoint(event),
  );
  if (
    priorEndpoints.length !== 1 ||
    endpoints.length !== 1 ||
    typeof endpoints[0]!.id !== "string" ||
    !endpoints[0]!.id!.trim()
  ) {
    return null;
  }
  const endpoint = endpoints[0]!;

  const latestProbe = current.zeroExecutionEvidence.latestProbe;
  const latestDiscovery = current.zeroExecutionEvidence.latestDiscovery;
  const postMarkerEvents = events.filter(
    (event) =>
      event.id !== priorMarker.id && event.occurredAt >= priorMarker.occurredAt,
  );
  if (
    (latestProbe?.observedAt.toISOString() ?? null) !== current.latestProbeAt ||
    (latestDiscovery?.createdAt.toISOString() ?? null) !==
      current.latestDiscoveryAt ||
    (latestProbe &&
      (latestProbe.courseId !== current.courseId ||
        latestProbe.observedAt >= priorMarker.occurredAt ||
        current.zeroExecutionEvidence.latestProbeTimestampRowCount !== 1)) ||
    (latestDiscovery &&
      (latestDiscovery.courseId !== current.courseId ||
        latestDiscovery.createdAt >= priorMarker.occurredAt ||
        current.zeroExecutionEvidence.latestDiscoveryTimestampRowCount !==
          1)) ||
    (!latestProbe &&
      current.zeroExecutionEvidence.latestProbeTimestampRowCount !== 0) ||
    (!latestDiscovery &&
      current.zeroExecutionEvidence.latestDiscoveryTimestampRowCount !== 0) ||
    postMarkerEvents.length !== 1 ||
    postMarkerEvents[0]!.id !== endpoint.id
  ) {
    return null;
  }

  const entries = current.zeroExecutionEvidence.batchIncidents
    .filter((entry) => entry.cycle === current.cycle)
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  const postMarkerEntries = entries.filter(
    (entry) => entry.createdAt > priorMarker.occurredAt,
  );
  const preMarkerEntries = entries.filter(
    (entry) => entry.createdAt <= priorMarker.occurredAt,
  );
  if (
    entries.length === 0 ||
    entries.length > 20 ||
    preMarkerEntries.length === 0 ||
    preMarkerEntries.some(
      (entry) =>
        !entry.batch.completedAt ||
        entry.batch.completedAt > priorEndpoints[0]!.occurredAt,
    ) ||
    postMarkerEntries.length !== 1 ||
    postMarkerEntries.some(
      (entry, index) =>
        entry.incidentId !== current.incidentId ||
        entry.courseId !== current.courseId ||
        entry.preProbeId !== (latestProbe?.id ?? null) ||
        entry.postProbeId !== null ||
        entry.proofSnapshot !== null ||
        entry.verifiedIncidentUpdatedAt !== null ||
        entry.verifiedAt !== null ||
        !entry.batch.completedAt ||
        !entry.batch.releaseSha ||
        !/^[a-f0-9]{40}$/u.test(entry.batch.releaseSha) ||
        !entry.batch.deployedAt ||
        !(entry.batch.createdAt instanceof Date) ||
        !["SUCCEEDED", "PARTIAL", "RETRYABLE_FAILED"].includes(
          entry.batch.status,
        ) ||
        entry.batch.deployedAt > entry.createdAt ||
        entry.batch.deployedAt >= priorMarker.occurredAt ||
        entry.batch.recheckDispatchKey !== null ||
        entry.batch.recheckDispatchStartedAt !== null ||
        entry.batch.recheckDispatchedAt !== null ||
        entry.batch.createdAt <= priorMarker.occurredAt ||
        entry.batch.createdAt > entry.createdAt ||
        entry.batch.completedAt < entry.createdAt ||
        entry.batch.completedAt > endpoint.occurredAt ||
        entry.batch.releaseSha !== priorRecoveryRuntimeVersion ||
        !hasExactPostMarkerOrchestrationOnlyAttempt({
          courseId: current.courseId,
          failureFingerprint: current.failureFingerprint,
          providerSnapshotFingerprint: current.providerSnapshotFingerprint,
          runtimeVersion: priorRecoveryRuntimeVersion,
          summary: entry.batch.summary,
        }) ||
        (index > 0 &&
          entry.createdAt < postMarkerEntries[index - 1]!.batch.completedAt!),
    )
  ) {
    return null;
  }
  const preMarkerHistory = assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries: preMarkerEntries,
    requireOrchestrationOnly: false,
    requireStartedRequest: true,
    requireCausalStartedRequest: true,
    minimumStartedAt: admission.occurredAt,
  });
  const postMarkerHistory = assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries: postMarkerEntries,
    requireOrchestrationOnly: true,
  });
  const fullHistory = assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries,
    requireOrchestrationOnly: false,
    requireStartedRequest: true,
    requireCausalStartedRequest: true,
    minimumStartedAt: admission.occurredAt,
  });
  if (
    !preMarkerHistory ||
    preMarkerHistory.historyDigest !==
      priorMarkerAudit.sameCycleRecoveryHistoryDigest ||
    preMarkerHistory.requestFences.some(
      (request) =>
        request.startedAt && request.startedAt > priorMarker.occurredAt,
    ) ||
    !postMarkerHistory ||
    postMarkerHistory.requestCount !== 0 ||
    postMarkerHistory.startedRequestCount !== 0 ||
    !fullHistory ||
    fullHistory.startedRequestCount < 1
  ) {
    return null;
  }

  const failedRuntimeVersions = [
    ...new Set(postMarkerEntries.map((entry) => entry.batch.releaseSha!)),
  ].sort();
  const priorRecoveryMarkerDigest = createHash("sha256")
    .update(
      stableCourseProviderExecutionEvidenceValue(
        canonicalizeParkedCourseCampaignRecoveryEvent(priorMarker),
      ),
    )
    .digest("hex");
  const exactHistoryDigest = createHash("sha256")
    .update(
      stableCourseProviderExecutionEvidenceValue({
        schemaVersion: 1,
        admission: canonicalizeParkedCourseCampaignRecoveryEvent(admission),
        priorRecoveryMarker:
          canonicalizeParkedCourseCampaignRecoveryEvent(priorMarker),
        priorRecoveryMarkerDigest,
        priorRecoveryRuntimeVersion,
        recoveryRuntimeVersion: input.currentRuntimeVersion,
        failedRuntimeVersions,
        endpoint: canonicalizeParkedCourseCampaignRecoveryEvent(endpoint),
        attemptLedgerFingerprint: current.attemptLedgerFingerprint,
        fullHistoryDigest: fullHistory.historyDigest,
        preMarkerHistoryDigest: preMarkerHistory.historyDigest,
        postMarkerHistoryDigest: postMarkerHistory.historyDigest,
      }),
    )
    .digest("hex");
  return {
    priorRecoveryMarkerDigest,
    priorRecoveryRuntimeVersion,
    failedRuntimeVersions,
    postMarkerHistoryDigest: postMarkerHistory.historyDigest,
    postMarkerBatchCount: 1,
    postMarkerRequestCount: 0,
    supersededEndpointId: endpoint.id!,
    supersededEndpointAt: endpoint.occurredAt,
    history: { ...fullHistory, historyDigest: exactHistoryDigest },
  };
}

export type ParkedCourseCampaignDescendantLineage = {
  lineageDigest: string;
  handoffCount: number;
  admissionAt: Date;
  lastHandoffAt: Date;
};

export function findParkedCourseCampaignDescendantLineage(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMember;
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
  events: readonly ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number][];
}): ParkedCourseCampaignDescendantLineage | null {
  const { captured, current } = input;
  const handoffCount = current.cycle - captured.cycle - 1;
  if (
    !input.campaignRunId.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.campaignMembershipDigest) ||
    !Number.isFinite(input.capturedAt.getTime()) ||
    current.courseId !== captured.courseId ||
    current.incidentId !== captured.incidentId ||
    current.kind !== captured.kind ||
    handoffCount < 1 ||
    handoffCount > PARKED_COURSE_CAMPAIGN_MAX_DESCENDANT_HANDOFFS
  ) {
    return null;
  }

  const eventsSinceCapture = input.events.filter(
    (event) => event.occurredAt >= input.capturedAt,
  );
  if (
    input.events.length >= 50 &&
    eventsSinceCapture.length === input.events.length
  ) {
    return null;
  }

  const admissions = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      event.failureFingerprint === captured.failureFingerprint &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === captured.cycle + 1 &&
      audit.preservesPriorAttemptEvents === true &&
      audit.customerDataIncluded === false
    );
  });
  if (admissions.length !== 1) return null;
  const admission = admissions[0]!;

  let priorOccurredAt = admission.occurredAt;
  let providerFamilyKey = captured.providerFamilyKey;
  let failureFingerprint = captured.failureFingerprint;
  let providerSnapshotFingerprint = captured.providerSnapshotFingerprint;
  const lineageEvents = [admission];
  const canonicalHandoffs: Array<Record<string, unknown>> = [];
  for (let cycle = captured.cycle + 2; cycle <= current.cycle; cycle += 1) {
    const handoffs = eventsSinceCapture.filter((event) => {
      const audit = asCampaignRecord(event.audit);
      return (
        event.incidentId === current.incidentId &&
        event.eventType === "REVALIDATION_REQUESTED" &&
        event.source === "COURSE_SUPPORT_RESPONDER" &&
        event.occurredAt > priorOccurredAt &&
        audit.providerFamilyHandoff === true &&
        audit.priorCycle === cycle - 1 &&
        audit.cycle === cycle &&
        audit.customerDataIncluded === false
      );
    });
    if (handoffs.length !== 1) return null;
    const handoff = handoffs[0]!;
    const audit = asCampaignRecord(handoff.audit);
    if (
      typeof audit.priorProviderFamilyKey !== "string" ||
      typeof audit.providerFamilyKey !== "string" ||
      typeof audit.priorFailureFingerprint !== "string" ||
      typeof audit.failureFingerprint !== "string" ||
      typeof audit.claimedProviderSnapshotFingerprint !== "string" ||
      typeof audit.observedProviderSnapshotFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(audit.claimedProviderSnapshotFingerprint) ||
      !/^[a-f0-9]{64}$/u.test(audit.observedProviderSnapshotFingerprint) ||
      typeof audit.providerFamilyChanged !== "boolean" ||
      typeof audit.providerSnapshotChanged !== "boolean" ||
      audit.priorProviderFamilyKey !== providerFamilyKey ||
      audit.priorFailureFingerprint !== failureFingerprint ||
      audit.claimedProviderSnapshotFingerprint !==
        providerSnapshotFingerprint ||
      handoff.failureFingerprint !== audit.failureFingerprint
    ) {
      return null;
    }
    const providerFamilyChanged =
      audit.providerFamilyKey !== audit.priorProviderFamilyKey;
    const providerSnapshotChanged =
      audit.observedProviderSnapshotFingerprint !==
      audit.claimedProviderSnapshotFingerprint;
    const failureFingerprintChanged =
      audit.failureFingerprint !== audit.priorFailureFingerprint;
    if (
      audit.providerFamilyChanged !== providerFamilyChanged ||
      audit.providerSnapshotChanged !== providerSnapshotChanged ||
      (!providerFamilyChanged &&
        !providerSnapshotChanged &&
        !failureFingerprintChanged)
    ) {
      return null;
    }

    canonicalHandoffs.push({
      occurredAt: handoff.occurredAt.toISOString(),
      priorCycle: cycle - 1,
      cycle,
      priorProviderFamilyKey: audit.priorProviderFamilyKey,
      providerFamilyKey: audit.providerFamilyKey,
      priorFailureFingerprint: audit.priorFailureFingerprint,
      failureFingerprint: audit.failureFingerprint,
      claimedProviderSnapshotFingerprint:
        audit.claimedProviderSnapshotFingerprint,
      observedProviderSnapshotFingerprint:
        audit.observedProviderSnapshotFingerprint,
      providerFamilyChanged,
      providerSnapshotChanged,
    });
    lineageEvents.push(handoff);
    priorOccurredAt = handoff.occurredAt;
    providerFamilyKey = audit.providerFamilyKey;
    failureFingerprint = audit.failureFingerprint;
    providerSnapshotFingerprint = audit.observedProviderSnapshotFingerprint;
  }

  const boundedCycleTransitions = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      Number.isInteger(audit.priorCycle) &&
      Number.isInteger(audit.cycle) &&
      ((Number(audit.priorCycle) >= captured.cycle &&
        Number(audit.priorCycle) <= current.cycle) ||
        (Number(audit.cycle) >= captured.cycle &&
          Number(audit.cycle) <= current.cycle))
    );
  });
  if (
    boundedCycleTransitions.length !== lineageEvents.length ||
    lineageEvents.some((event) => !boundedCycleTransitions.includes(event))
  ) {
    return null;
  }

  if (
    current.providerFamilyKey !== providerFamilyKey ||
    current.failureFingerprint !== failureFingerprint ||
    current.providerSnapshotFingerprint !== providerSnapshotFingerprint
  ) {
    return null;
  }
  const canonicalLineage = {
    admission: {
      occurredAt: admission.occurredAt.toISOString(),
      campaignRunId: input.campaignRunId,
      campaignMembershipDigest: input.campaignMembershipDigest,
      priorCycle: captured.cycle,
      cycle: captured.cycle + 1,
      providerFamilyKey: captured.providerFamilyKey,
      failureFingerprint: captured.failureFingerprint,
      providerSnapshotFingerprint: captured.providerSnapshotFingerprint,
    },
    handoffs: canonicalHandoffs,
  };
  return {
    lineageDigest: createHash("sha256")
      .update(stableCourseProviderExecutionEvidenceValue(canonicalLineage))
      .digest("hex"),
    handoffCount,
    admissionAt: admission.occurredAt,
    lastHandoffAt: priorOccurredAt,
  };
}

function assessParkedCourseCampaignDescendantZeroProgressHistory(input: {
  current: ParkedCourseCampaignMemberSnapshot;
  minimumCreatedAt: Date;
  maximumCompletedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const { current } = input;
  const courseRef = createHash("sha256")
    .update(current.courseId)
    .digest("hex")
    .slice(0, 24);
  const entries = current.zeroExecutionEvidence.batchIncidents
    .filter((entry) => entry.cycle === current.cycle)
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  if (
    entries.length === 0 ||
    entries.length > 20 ||
    entries.some((entry, index) => {
      const executionEver = readCourseSupportReleaseExecutionEvidence({
        summary: entry.batch.summary,
        baseSha: entry.batch.baseSha,
        courseRef,
      });
      const summary = asCampaignRecord(entry.batch.summary);
      const searchExecutionFence =
        readPersistedCourseSupportSearchExecutionFence(
          summary.searchExecutionFence,
        );
      const campaign = asCampaignRecord(summary.campaign);
      const campaignAttempts = Array.isArray(campaign.attempts)
        ? campaign.attempts.map(asCampaignRecord)
        : [];
      const currentCourseCampaignAttempts = campaignAttempts.filter(
        (attempt) =>
          attempt.courseRef === courseRef && attempt.cycle === current.cycle,
      );
      const matchingCampaignAttempts = currentCourseCampaignAttempts.filter(
        (attempt) =>
          hasExactCampaignRecordKeys(attempt, [
            "courseRef",
            "runId",
            "membershipDigest",
            "cycle",
          ]) &&
          attempt.runId === input.campaignRunId &&
          attempt.membershipDigest === input.campaignMembershipDigest,
      );
      const closeout = asCampaignRecord(summary.closeout);
      const matchingAttempts = Array.isArray(closeout.remediationAttempts)
        ? (closeout.remediationAttempts as unknown[])
            .map(asCampaignRecord)
            .filter((attempt) => attempt.courseRef === courseRef)
        : [];
      const hasExecutionAttempt = matchingAttempts.some((attempt) => {
        const execution = asCampaignRecord(attempt.executionEvidence);
        return (
          attempt.consumed !== false ||
          attempt.countsTowardOperationalNoProgress !== false ||
          [
            "newReleaseRecorded",
            "deploymentRecorded",
            "postProbeRecorded",
            "providerAttemptRecorded",
            "providerExecutionAttemptRecorded",
            "playbookAttemptRecorded",
            "terminalResultRecorded",
            "providerExecutionStarted",
          ].some((key) => execution[key] === true)
        );
      });
      const exactNoExecutionAttempt =
        matchingAttempts.length === 1 &&
        matchingAttempts.every((attempt) => {
          const execution = asCampaignRecord(attempt.executionEvidence);
          return (
            attempt.providerSnapshotFingerprint ===
              current.providerSnapshotFingerprint &&
            (attempt.observedProviderSnapshotFingerprint === undefined ||
              attempt.observedProviderSnapshotFingerprint ===
                current.providerSnapshotFingerprint) &&
            attempt.failureFingerprint === current.failureFingerprint &&
            (attempt.observedFailureFingerprint === undefined ||
              attempt.observedFailureFingerprint ===
                current.failureFingerprint) &&
            attempt.runtimeVersion === entry.batch.baseSha &&
            attempt.consumed === false &&
            attempt.countsTowardOperationalNoProgress === false &&
            (attempt.providerSnapshotChanged === undefined ||
              attempt.providerSnapshotChanged === false) &&
            [
              "newReleaseRecorded",
              "deploymentRecorded",
              "postProbeRecorded",
              "providerAttemptRecorded",
              "playbookAttemptRecorded",
              "terminalResultRecorded",
              "providerExecutionStarted",
            ].every((key) => execution[key] === false) &&
            (execution.claimedImplementationPaths === false ||
              execution.claimedImplementationPaths === true) &&
            (execution.providerExecutionAttemptRecorded === undefined ||
              execution.providerExecutionAttemptRecorded === false)
          );
        });
      return (
        entry.batchId !== entry.batch.id ||
        entry.incidentId !== current.incidentId ||
        entry.courseId !== current.courseId ||
        !entry.batch.completedAt ||
        !(entry.batch.createdAt instanceof Date) ||
        !entry.batch.baseSha.trim() ||
        !["SUCCEEDED", "PARTIAL", "RETRYABLE_FAILED"].includes(
          entry.batch.status,
        ) ||
        entry.batch.releaseSha !== null ||
        entry.batch.deployedAt !== null ||
        entry.batch.recheckDispatchKey !== null ||
        entry.batch.recheckDispatchStartedAt !== null ||
        entry.batch.recheckDispatchedAt !== null ||
        entry.createdAt < input.minimumCreatedAt ||
        entry.batch.createdAt < input.minimumCreatedAt ||
        entry.batch.createdAt > entry.createdAt ||
        entry.batch.completedAt < entry.createdAt ||
        entry.batch.completedAt > input.maximumCompletedAt ||
        (index > 0 &&
          (entry.createdAt < entries[index - 1]!.batch.completedAt! ||
            entry.batch.createdAt < entries[index - 1]!.batch.completedAt!)) ||
        entry.postProbeId !== null ||
        entry.proofSnapshot !== null ||
        entry.verifiedIncidentUpdatedAt !== null ||
        entry.verifiedAt !== null ||
        entry.verificationRequests.length !== 0 ||
        campaign.kind !== "PARKED_COHORT" ||
        currentCourseCampaignAttempts.length !== 1 ||
        matchingCampaignAttempts.length !== 1 ||
        !searchExecutionFence ||
        searchExecutionFence.settled !== true ||
        searchExecutionFence.reasons.length !== 0 ||
        searchExecutionFence.providerExecutionAttemptCourseRefs.includes(
          courseRef,
        ) ||
        searchExecutionFence.searchExecutionMayHaveStartedCourseRefs.includes(
          courseRef,
        ) ||
        searchExecutionFence.memberships.some((membership) =>
          membership.courseRefs.includes(courseRef),
        ) ||
        searchExecutionFence.probeEvidenceBySearch.some((evidence) =>
          evidence.probes.some((probe) => probe.courseRef === courseRef),
        ) ||
        !isCourseSupportCompletedBatchOrchestrationOnly({
          courseId: current.courseId,
          summary: entry.batch.summary,
          allowValidatedLegacy: false,
        }) ||
        !exactNoExecutionAttempt ||
        hasExecutionAttempt ||
        executionEver.changedReleaseDeploymentEver ||
        executionEver.providerExecutionEverForCourse ||
        executionEver.providerExecutionAttemptEverForCourse ||
        executionEver.terminalExecutionEverForCourse
      );
    })
  ) {
    return null;
  }

  const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries,
    requireOrchestrationOnly: true,
  });
  return history &&
    history.requestCount === 0 &&
    history.startedRequestCount === 0
    ? history
    : null;
}

export function assessParkedCourseCampaignDescendantIncompletePlaybookRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  const zeroProgress = playbook.completedStages.length === 0;
  const lineage = findParkedCourseCampaignDescendantLineage({
    captured,
    current,
    capturedAt: input.capturedAt,
    campaignRunId: input.campaignRunId,
    campaignMembershipDigest: input.campaignMembershipDigest,
    events: current.zeroExecutionEvidence.monitoringEvents,
  });
  if (
    !lineage ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.nextStage === null ||
    (zeroProgress &&
      (playbook.nextStage !== "OFFICIAL_IDENTITY" ||
        playbook.stages.some((stage) => stage.attemptCount !== 0)))
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const endpoint = findParkedCourseCampaignAutomationStalledEndpoint(current);
  const alreadyRecovered = hasParkedCourseCampaignRecoveryMarker({
    events,
    action: "parked_cohort_descendant_incomplete_playbook_recovery",
    campaignRunId: input.campaignRunId,
    cycle: current.cycle,
  });
  if (
    !endpoint ||
    endpoint.occurredAt < lineage.lastHandoffAt ||
    alreadyRecovered ||
    (zeroProgress &&
      ((current.zeroExecutionEvidence.latestProbe?.observedAt.getTime() ?? 0) >
        lineage.lastHandoffAt.getTime() ||
        (current.zeroExecutionEvidence.latestDiscovery?.createdAt.getTime() ??
          0) > lineage.lastHandoffAt.getTime()))
  ) {
    return null;
  }
  const history = zeroProgress
    ? assessParkedCourseCampaignDescendantZeroProgressHistory({
        current,
        minimumCreatedAt: lineage.lastHandoffAt,
        maximumCompletedAt: endpoint.occurredAt,
        campaignRunId: input.campaignRunId,
        campaignMembershipDigest: input.campaignMembershipDigest,
      })
    : assessParkedCourseCampaignSameCycleRecoveryHistory({
        courseId: current.courseId,
        cycle: current.cycle,
        entries: current.zeroExecutionEvidence.batchIncidents,
        requireOrchestrationOnly: false,
        requireStartedRequest: true,
        requireCausalStartedRequest: true,
        minimumStartedAt: lineage.lastHandoffAt,
      });
  return history ? { lineage, history } : null;
}

export type ParkedCourseCampaignSameIdentityMaterialChangeLineage = {
  lineageDigest: string;
  admissionAt: Date;
  materialChangeAt: Date;
};

function hasExactSameIdentityMaterialChangeProviderSnapshot(input: {
  courseId: string;
  failureFingerprint: string;
  providerSnapshotFingerprint: string;
  entry: ParkedCourseCampaignBatchEvidence;
}) {
  const courseRef = createHash("sha256")
    .update(input.courseId)
    .digest("hex")
    .slice(0, 24);
  const summary = asCampaignRecord(input.entry.batch.summary);
  const plannedAttempts = Array.isArray(
    asCampaignRecord(summary.remediation).attempts,
  )
    ? (asCampaignRecord(summary.remediation).attempts as unknown[])
        .map(asCampaignRecord)
        .filter((attempt) => attempt.courseRef === courseRef)
    : [];
  if (
    plannedAttempts.length !== 1 ||
    plannedAttempts[0]!.providerSnapshotFingerprint !==
      input.providerSnapshotFingerprint
  ) {
    return false;
  }

  const closeoutAttempts = Array.isArray(
    asCampaignRecord(summary.closeout).remediationAttempts,
  )
    ? (asCampaignRecord(summary.closeout).remediationAttempts as unknown[])
        .map(asCampaignRecord)
        .filter((attempt) => attempt.courseRef === courseRef)
    : [];
  if (closeoutAttempts.length !== 1) return false;
  const attempt = closeoutAttempts[0]!;
  const runtimeVersion =
    input.entry.batch.releaseSha ?? input.entry.batch.baseSha;
  const proof = asCampaignRecord(input.entry.proofSnapshot);
  return (
    attempt.providerSnapshotFingerprint === input.providerSnapshotFingerprint &&
    attempt.observedProviderSnapshotFingerprint ===
      input.providerSnapshotFingerprint &&
    attempt.failureFingerprint === input.failureFingerprint &&
    attempt.observedFailureFingerprint === input.failureFingerprint &&
    attempt.runtimeVersion === runtimeVersion &&
    (attempt.providerSnapshotChanged === undefined ||
      attempt.providerSnapshotChanged === false) &&
    (proof.providerSnapshotFingerprint === undefined ||
      proof.providerSnapshotFingerprint === input.providerSnapshotFingerprint)
  );
}

export function findParkedCourseCampaignSameIdentityMaterialChangeLineage(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMember;
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
  events: readonly ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number][];
}): ParkedCourseCampaignSameIdentityMaterialChangeLineage | null {
  const { captured, current } = input;
  if (
    !input.campaignRunId.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.campaignMembershipDigest) ||
    !Number.isFinite(input.capturedAt.getTime()) ||
    current.courseId !== captured.courseId ||
    current.incidentId !== captured.incidentId ||
    current.cycle !== captured.cycle + 2 ||
    current.kind !== captured.kind ||
    current.providerFamilyKey !== captured.providerFamilyKey ||
    current.failureClass !== captured.failureClass ||
    current.failureFingerprint !== captured.failureFingerprint ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    current.providerSnapshotFingerprint === captured.providerSnapshotFingerprint
  ) {
    return null;
  }

  const eventsSinceCapture = input.events.filter(
    (event) => event.occurredAt >= input.capturedAt,
  );
  if (
    input.events.length >= 50 &&
    eventsSinceCapture.length === input.events.length
  ) {
    // The recovery query is bounded to 50 events. If every returned event is
    // inside the campaign window, older cycle transitions may have been
    // truncated, so the lineage cannot be proven complete.
    return null;
  }

  const admissions = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      event.failureFingerprint === captured.failureFingerprint &&
      audit.action === "parked_cohort_admission" &&
      audit.campaignRunId === input.campaignRunId &&
      audit.campaignMembershipDigest === input.campaignMembershipDigest &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === captured.cycle + 1 &&
      audit.preservesPriorAttemptEvents === true &&
      audit.customerDataIncluded === false
    );
  });
  if (admissions.length !== 1) return null;
  const admission = admissions[0]!;

  const materialChanges = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      (event.source === "OPERATOR_CLI" ||
        event.source === "OPERATOR_DASHBOARD") &&
      event.failureFingerprint === current.failureFingerprint &&
      event.occurredAt > admission.occurredAt &&
      audit.reason === "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED" &&
      audit.priorCycle === captured.cycle + 1 &&
      audit.cycle === current.cycle &&
      audit.priorProviderFamilyKey === captured.providerFamilyKey &&
      audit.providerFamilyKey === current.providerFamilyKey &&
      audit.providerFamilyChanged === false &&
      Array.isArray(audit.changedFields) &&
      audit.changedFields.length > 0 &&
      audit.changedFields.every(
        (field) => typeof field === "string" && field.trim().length > 0,
      ) &&
      new Set(audit.changedFields).size === audit.changedFields.length &&
      audit.evidenceFingerprint === current.providerSnapshotFingerprint &&
      audit.preservesPriorAttemptEvents === true &&
      audit.customerDataIncluded === false
    );
  });
  if (materialChanges.length !== 1) return null;
  const materialChange = materialChanges[0]!;

  const cycleTransitions = eventsSinceCapture.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      Number.isInteger(audit.priorCycle) &&
      Number.isInteger(audit.cycle) &&
      Number(audit.cycle) === Number(audit.priorCycle) + 1 &&
      Number(audit.priorCycle) >= captured.cycle &&
      Number(audit.cycle) <= current.cycle
    );
  });
  if (
    cycleTransitions.length !== 2 ||
    !cycleTransitions.includes(admission) ||
    !cycleTransitions.includes(materialChange)
  ) {
    return null;
  }

  return {
    lineageDigest: createHash("sha256")
      .update(
        stableCourseProviderExecutionEvidenceValue({
          before: {
            providerFamilyKey: captured.providerFamilyKey,
            failureClass: captured.failureClass,
            failureFingerprint: captured.failureFingerprint,
            monitoringFailureFingerprint: captured.monitoringFailureFingerprint,
            providerSnapshotFingerprint: captured.providerSnapshotFingerprint,
          },
          admission: canonicalizeParkedCourseCampaignRecoveryEvent(admission),
          materialChange:
            canonicalizeParkedCourseCampaignRecoveryEvent(materialChange),
          after: {
            providerFamilyKey: current.providerFamilyKey,
            failureClass: current.failureClass,
            failureFingerprint: current.failureFingerprint,
            monitoringFailureFingerprint: current.monitoringFailureFingerprint,
            providerSnapshotFingerprint: current.providerSnapshotFingerprint,
          },
        }),
      )
      .digest("hex"),
    admissionAt: admission.occurredAt,
    materialChangeAt: materialChange.occurredAt,
  };
}

export function assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  capturedAt: Date;
  campaignRunId: string;
  campaignMembershipDigest: string;
}) {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  const events = current.zeroExecutionEvidence.monitoringEvents;
  const eventsSinceCapture = events.filter(
    (event) => event.occurredAt >= input.capturedAt,
  );
  if (
    (events.length >= 50 && eventsSinceCapture.length === events.length) ||
    eventsSinceCapture.some(
      (event) => typeof event.id !== "string" || !event.id.trim(),
    )
  ) {
    return null;
  }
  const lineage = findParkedCourseCampaignSameIdentityMaterialChangeLineage({
    captured,
    current,
    capturedAt: input.capturedAt,
    campaignRunId: input.campaignRunId,
    campaignMembershipDigest: input.campaignMembershipDigest,
    events: current.zeroExecutionEvidence.monitoringEvents,
  });
  if (
    !lineage ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.completedStages.length === 0 ||
    playbook.nextStage === null
  ) {
    return null;
  }

  const endpointCandidates = events.filter((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.source !== "OPERATOR_CLI" &&
      event.source !== "OPERATOR_DASHBOARD" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.automationStalled === true &&
      audit.parkedUntilMaterialChange === true &&
      audit.customerState === "NEEDS_HUMAN_REVIEW" &&
      audit.playbookExhausted === false
    );
  });
  const endpoint = findParkedCourseCampaignAutomationStalledEndpoint(current);
  const alreadyRecovered = hasParkedCourseCampaignRecoveryMarker({
    events,
    action:
      "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
    campaignRunId: input.campaignRunId,
    cycle: current.cycle,
  });
  if (
    endpointCandidates.length !== 1 ||
    !endpoint ||
    typeof endpoint.id !== "string" ||
    !endpoint.id.trim() ||
    endpoint.occurredAt < lineage.materialChangeAt ||
    alreadyRecovered
  ) {
    return null;
  }

  const entries = current.zeroExecutionEvidence.batchIncidents
    .filter((entry) => entry.cycle === current.cycle)
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  if (
    entries.length === 0 ||
    entries.length > 20 ||
    entries.some(
      (entry, index) =>
        entry.incidentId !== current.incidentId ||
        entry.courseId !== current.courseId ||
        !entry.batch.completedAt ||
        !("createdAt" in entry.batch) ||
        !(entry.batch.createdAt instanceof Date) ||
        !["SUCCEEDED", "PARTIAL", "RETRYABLE_FAILED"].includes(
          entry.batch.status,
        ) ||
        entry.createdAt < lineage.materialChangeAt ||
        entry.batch.createdAt < lineage.materialChangeAt ||
        entry.batch.createdAt > entry.createdAt ||
        entry.batch.completedAt < entry.createdAt ||
        entry.batch.completedAt > endpoint.occurredAt ||
        (index > 0 && entry.createdAt < entries[index - 1]!.batch.completedAt!),
    )
  ) {
    return null;
  }

  const history = assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries,
    requireOrchestrationOnly: false,
    requireStartedRequest: true,
    requireCausalStartedRequest: true,
    minimumStartedAt: lineage.materialChangeAt,
  });
  if (!history) return null;
  const causalRequests = entries.flatMap((entry) =>
    entry.verificationRequests.flatMap((request) => {
      if (
        !request.startedAt ||
        request.attemptCount <= 0 ||
        request.revision < 2 ||
        request.startedAt < entry.createdAt ||
        request.startedAt < entry.batch.createdAt ||
        request.startedAt < lineage.materialChangeAt ||
        request.startedAt > entry.batch.completedAt!
      ) {
        return [];
      }
      return [{ entry, request }];
    }),
  );
  if (
    causalRequests.length !== history.startedRequestCount ||
    causalRequests.some(({ entry, request }) => {
      const providerSnapshotAt = request.providerSnapshotAt;
      const requestCreatedAt = request.createdAt;
      const discoveryAttemptedAt = request.discoveryAttemptedAt ?? null;
      const discoveryVerifiedAt = request.discoveryVerifiedAt ?? null;
      if (
        request.courseId !== current.courseId ||
        request.providerSnapshotFingerprint !==
          current.providerSnapshotFingerprint ||
        !hasExactSameIdentityMaterialChangeProviderSnapshot({
          courseId: current.courseId,
          failureFingerprint: current.failureFingerprint,
          providerSnapshotFingerprint: current.providerSnapshotFingerprint,
          entry,
        }) ||
        !(providerSnapshotAt instanceof Date) ||
        !(requestCreatedAt instanceof Date) ||
        providerSnapshotAt < lineage.materialChangeAt ||
        requestCreatedAt < lineage.materialChangeAt ||
        requestCreatedAt > request.startedAt! ||
        providerSnapshotAt > entry.batch.completedAt! ||
        requestCreatedAt > entry.batch.completedAt!
      ) {
        return true;
      }
      if (providerSnapshotAt.getTime() === request.startedAt!.getTime()) {
        return discoveryAttemptedAt !== null || discoveryVerifiedAt !== null;
      }
      return (
        !(discoveryAttemptedAt instanceof Date) ||
        !(discoveryVerifiedAt instanceof Date) ||
        discoveryAttemptedAt < request.startedAt! ||
        discoveryAttemptedAt > providerSnapshotAt ||
        discoveryVerifiedAt < providerSnapshotAt ||
        discoveryVerifiedAt > entry.batch.completedAt!
      );
    })
  ) {
    return null;
  }
  const exactEvidenceDigest = createHash("sha256")
    .update(
      stableCourseProviderExecutionEvidenceValue({
        schemaVersion: 1,
        lineageDigest: lineage.lineageDigest,
        endpoint: canonicalizeParkedCourseCampaignRecoveryEvent(endpoint),
        current: {
          courseId: current.courseId,
          incidentId: current.incidentId,
          cycle: current.cycle,
          revision: current.revision,
          monitoringRevision: current.monitoringRevision,
          monitoringFailureFingerprint: current.monitoringFailureFingerprint,
          kind: current.kind,
          providerFamilyKey: current.providerFamilyKey,
          failureClass: current.failureClass,
          failureFingerprint: current.failureFingerprint,
          providerSnapshotFingerprint: current.providerSnapshotFingerprint,
          attemptLedgerFingerprint: current.attemptLedgerFingerprint,
          latestProbe: current.zeroExecutionEvidence.latestProbe
            ? {
                id: current.zeroExecutionEvidence.latestProbe.id,
                observedAt:
                  current.zeroExecutionEvidence.latestProbe.observedAt.toISOString(),
              }
            : null,
          latestDiscovery: current.zeroExecutionEvidence.latestDiscovery
            ? {
                id: current.zeroExecutionEvidence.latestDiscovery.id,
                createdAt:
                  current.zeroExecutionEvidence.latestDiscovery.createdAt.toISOString(),
              }
            : null,
          playbookCompletedStages: playbook.completedStages,
          playbookNextStage: playbook.nextStage,
        },
        batches: entries.map((entry) => ({
          batchIncident: {
            id: entry.id,
            batchId: entry.batchId,
            incidentId: entry.incidentId,
            courseId: entry.courseId,
            cycle: entry.cycle,
            result: entry.result,
            preProbeId: entry.preProbeId,
            postProbeId: entry.postProbeId,
            proofSnapshot: entry.proofSnapshot,
            verifiedIncidentUpdatedAt:
              entry.verifiedIncidentUpdatedAt?.toISOString() ?? null,
            verifiedAt: entry.verifiedAt?.toISOString() ?? null,
            createdAt: entry.createdAt.toISOString(),
            updatedAt: entry.updatedAt.toISOString(),
          },
          batch: {
            id: entry.batch.id,
            status: entry.batch.status,
            revision: entry.batch.revision,
            ownerAutomationRunId: entry.batch.ownerAutomationRunId,
            baseSha: entry.batch.baseSha,
            releaseSha: entry.batch.releaseSha,
            deployedAt: entry.batch.deployedAt?.toISOString() ?? null,
            createdAt: entry.batch.createdAt.toISOString(),
            updatedAt: entry.batch.updatedAt?.toISOString() ?? null,
            recheckDispatchKey: entry.batch.recheckDispatchKey,
            recheckDispatchStartedAt:
              entry.batch.recheckDispatchStartedAt?.toISOString() ?? null,
            recheckDispatchedAt:
              entry.batch.recheckDispatchedAt?.toISOString() ?? null,
            completedAt: entry.batch.completedAt!.toISOString(),
            summary: entry.batch.summary,
            ownerAutomationRun: entry.batch.ownerAutomationRun
              ? {
                  ...entry.batch.ownerAutomationRun,
                  completedAt:
                    entry.batch.ownerAutomationRun.completedAt?.toISOString() ??
                    null,
                }
              : null,
          },
          verificationRequests: [...entry.verificationRequests]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((request) => ({
              ...request,
              providerSnapshotAt:
                request.providerSnapshotAt?.toISOString() ?? null,
              discoveryAttemptedAt:
                request.discoveryAttemptedAt?.toISOString() ?? null,
              discoveryVerifiedAt:
                request.discoveryVerifiedAt?.toISOString() ?? null,
              createdAt: request.createdAt?.toISOString() ?? null,
              updatedAt: request.updatedAt?.toISOString() ?? null,
              startedAt: request.startedAt?.toISOString() ?? null,
            })),
        })),
      }),
    )
    .digest("hex");
  return {
    lineage,
    supersededEndpointId: endpoint.id,
    supersededEndpointAt: endpoint.occurredAt,
    history: { ...history, historyDigest: exactEvidenceDigest },
  };
}

export function findParkedCourseCampaignCurrentCycleOrchestrationLineage(input: {
  captured: {
    courseId: string;
    incidentId: string;
    cycle: number;
    kind: string;
    providerFamilyKey: string;
  };
  current: {
    courseId: string;
    incidentId: string;
    cycle: number;
    kind: string;
    providerFamilyKey: string;
    failureFingerprint: string;
    providerSnapshotFingerprint: string;
  };
  capturedAt: Date;
  events: readonly ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number][];
}) {
  const { captured, current } = input;
  if (
    current.courseId !== captured.courseId ||
    current.incidentId !== captured.incidentId ||
    current.kind !== captured.kind ||
    current.cycle !== captured.cycle + 2
  ) {
    return null;
  }
  const operatorMaterialChange = input.events.find((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      (event.source === "OPERATOR_CLI" ||
        event.source === "OPERATOR_DASHBOARD") &&
      event.occurredAt >= input.capturedAt &&
      typeof event.failureFingerprint === "string" &&
      event.failureFingerprint.length > 0 &&
      audit.reason === "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED" &&
      audit.priorCycle === captured.cycle &&
      audit.cycle === captured.cycle + 1 &&
      audit.priorProviderFamilyKey === captured.providerFamilyKey &&
      typeof audit.providerFamilyKey === "string" &&
      audit.providerFamilyKey.length > 0 &&
      Array.isArray(audit.changedFields) &&
      audit.changedFields.length > 0 &&
      typeof audit.evidenceFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(audit.evidenceFingerprint) &&
      audit.customerDataIncluded === false
    );
  });
  if (!operatorMaterialChange) return null;
  const operatorAudit = asCampaignRecord(operatorMaterialChange.audit);
  const providerFamilyHandoff = input.events.find((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      event.source === "COURSE_SUPPORT_RESPONDER" &&
      event.occurredAt >= operatorMaterialChange.occurredAt &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.providerFamilyHandoff === true &&
      audit.priorCycle === captured.cycle + 1 &&
      audit.cycle === current.cycle &&
      audit.claimedProviderSnapshotFingerprint ===
        operatorAudit.evidenceFingerprint &&
      audit.observedProviderSnapshotFingerprint ===
        current.providerSnapshotFingerprint &&
      audit.priorProviderFamilyKey === operatorAudit.providerFamilyKey &&
      audit.providerFamilyKey === current.providerFamilyKey &&
      audit.priorFailureFingerprint ===
        operatorMaterialChange.failureFingerprint &&
      audit.failureFingerprint === current.failureFingerprint &&
      audit.customerDataIncluded === false
    );
  });
  if (!providerFamilyHandoff) return null;
  return {
    operatorMaterialChangeAt: operatorMaterialChange.occurredAt,
    providerFamilyHandoffAt: providerFamilyHandoff.occurredAt,
  };
}

function getParkedCourseCampaignCurrentCycleOrchestrationRecovery(input: {
  captured: ParkedCourseCampaignMember;
  current: ParkedCourseCampaignMemberSnapshot;
  capturedAt: Date;
  campaignRunId: string;
}) {
  const { captured, current } = input;
  const playbook = current.zeroExecutionEvidence.playbookAssessment;
  const lineage = findParkedCourseCampaignCurrentCycleOrchestrationLineage({
    captured,
    current,
    capturedAt: input.capturedAt,
    events: current.zeroExecutionEvidence.monitoringEvents,
  });
  if (
    !input.campaignRunId ||
    !lineage ||
    current.monitoringFailureFingerprint !== current.failureFingerprint ||
    playbook.valid !== true ||
    playbook.cycle !== current.cycle ||
    playbook.conclusion !== "INCOMPLETE" ||
    playbook.completedStages.length !== 0 ||
    playbook.nextStage === null
  ) {
    return null;
  }

  const events = current.zeroExecutionEvidence.monitoringEvents;
  const endpoint = findParkedCourseCampaignAutomationStalledEndpoint(current);
  const alreadyRecovered = hasParkedCourseCampaignRecoveryMarker({
    events,
    action: "parked_cohort_current_cycle_orchestration_recovery",
    campaignRunId: input.campaignRunId,
    cycle: current.cycle,
  });
  if (
    !endpoint ||
    endpoint.occurredAt < lineage.providerFamilyHandoffAt ||
    alreadyRecovered
  ) {
    return null;
  }
  return assessParkedCourseCampaignSameCycleRecoveryHistory({
    courseId: current.courseId,
    cycle: current.cycle,
    entries: current.zeroExecutionEvidence.batchIncidents,
    requireOrchestrationOnly: true,
  });
}

function isSameParkedCourseCampaignIdentity(
  captured: ParkedCourseCampaignMember,
  current: ParkedCourseCampaignMember,
) {
  return (
    current.courseId === captured.courseId &&
    current.incidentId === captured.incidentId &&
    current.kind === captured.kind &&
    current.providerFamilyKey === captured.providerFamilyKey &&
    current.failureClass === captured.failureClass &&
    current.failureFingerprint === captured.failureFingerprint
  );
}

function findParkedCourseCampaignAutomationStalledEndpoint(
  current: ParkedCourseCampaignMemberSnapshot,
) {
  return current.zeroExecutionEvidence.monitoringEvents.find((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId === current.incidentId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" &&
      event.source !== "OPERATOR_CLI" &&
      event.source !== "OPERATOR_DASHBOARD" &&
      event.failureFingerprint === current.failureFingerprint &&
      audit.cycle === current.cycle &&
      audit.automationStalled === true &&
      audit.parkedUntilMaterialChange === true &&
      audit.customerState === "NEEDS_HUMAN_REVIEW" &&
      audit.playbookExhausted === false
    );
  });
}

function hasParkedCourseCampaignRecoveryMarker(input: {
  events: readonly ParkedCourseCampaignRecoveryEvidence["monitoringEvents"][number][];
  action: string;
  campaignRunId: string;
  cycle: number;
}) {
  return input.events.some((event) => {
    const audit = asCampaignRecord(event.audit);
    return (
      event.incidentId !== null &&
      event.eventType === "REVALIDATION_REQUESTED" &&
      audit.action === input.action &&
      audit.campaignRunId === input.campaignRunId &&
      audit.cycle === input.cycle
    );
  });
}

export function createParkedCourseCampaignAttemptLedgerFingerprint(
  value: unknown,
) {
  return createHash("sha256")
    .update(stableCourseProviderExecutionEvidenceValue(value ?? null))
    .digest("hex");
}

async function loadCampaignMemberObservations(
  audit: ParkedCourseCampaignAudit,
  parkedCourseIds: ReadonlySet<string>,
  campaignRunId: string,
  database: ParkedCourseCampaignDatabase = prisma,
) {
  const capturedAt = new Date(audit.capturedAt);
  const memberByIncidentId = new Map(
    audit.members.map((member) => [member.incidentId, member]),
  );
  const incidents = await database.courseSupportIncident.findMany({
    where: { id: { in: audit.members.map((member) => member.incidentId) } },
    select: {
      id: true,
      courseId: true,
      cycle: true,
      status: true,
      activeBatchId: true,
      confirmedAt: true,
      resolution: true,
      resolvedAt: true,
      decisionAt: true,
      monitoringEvents: {
        where: {
          occurredAt: { gte: capturedAt },
          OR: [
            {
              eventType: {
                in: [
                  "HUMAN_REVIEW_REQUESTED",
                  "HUMAN_DECISION",
                  "REVALIDATION_REQUESTED",
                  "RECOVERED",
                  "STATE_CHANGED",
                ],
              },
            },
            { source: { in: ["OPERATOR_DASHBOARD", "OPERATOR_CLI"] } },
          ],
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          eventType: true,
          source: true,
          occurredAt: true,
          outcome: true,
          runtimeVersion: true,
          deploymentSha: true,
          audit: true,
        },
      },
      course: {
        select: {
          monitoringStatus: { select: { state: true, stateChangedAt: true } },
          probes: {
            where: { observedAt: { gte: capturedAt } },
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              outcome: true,
              observedAt: true,
              runtimeVersion: true,
              rawSummary: true,
            },
          },
        },
      },
    },
  });
  return incidents.map((incident) => {
    const member = memberByIncidentId.get(incident.id);
    const terminalEvidence = [...incident.monitoringEvents]
      .reverse()
      .find((event) => {
        if (
          event.eventType !== "RECOVERED" &&
          event.eventType !== "STATE_CHANGED"
        ) {
          return false;
        }
        const eventAudit = asCampaignRecord(event.audit);
        const campaign = asCampaignRecord(eventAudit.campaign);
        const campaignAttributed =
          campaign.kind === "PARKED_COHORT" &&
          campaign.runId === campaignRunId &&
          campaign.membershipDigest === audit.membershipDigest &&
          campaign.cycle === incident.cycle;
        const strictDescendantTerminal = Boolean(
          member &&
          incident.cycle > member.cycle &&
          incident.confirmedAt &&
          event.occurredAt >= incident.confirmedAt &&
          eventAudit.cycle === incident.cycle &&
          eventAudit.confirmedAt === incident.confirmedAt.toISOString() &&
          typeof eventAudit.automatedFinal === "boolean" &&
          eventAudit.freshRuntimeProof === true &&
          typeof event.runtimeVersion === "string" &&
          /^[a-f0-9]{40}$/u.test(event.runtimeVersion) &&
          event.deploymentSha === event.runtimeVersion,
        );
        return campaignAttributed || strictDescendantTerminal;
      });
    return {
      courseId: incident.courseId,
      incidentId: incident.id,
      cycle: incident.cycle,
      status: incident.status,
      activeBatchId: incident.activeBatchId,
      confirmedAt: incident.confirmedAt,
      resolution: incident.resolution,
      resolvedAt: incident.resolvedAt,
      decisionAt: incident.decisionAt,
      monitoringState: incident.course.monitoringStatus?.state ?? null,
      monitoringStateChangedAt:
        incident.course.monitoringStatus?.stateChangedAt ?? null,
      latestProbe: incident.course.probes[0] ?? null,
      campaignTerminalEvidenceAt: terminalEvidence?.occurredAt ?? null,
      campaignTerminalRuntimeVersion: terminalEvidence?.runtimeVersion ?? null,
      campaignTerminalDeploymentSha: terminalEvidence?.deploymentSha ?? null,
      campaignTerminalOutcome: terminalEvidence?.outcome ?? null,
      campaignTerminalFreshRuntimeProof:
        asCampaignRecord(terminalEvidence?.audit).freshRuntimeProof === true,
      campaignTerminalAutomatedFinal:
        typeof asCampaignRecord(terminalEvidence?.audit).automatedFinal ===
        "boolean"
          ? (asCampaignRecord(terminalEvidence?.audit)
              .automatedFinal as boolean)
          : null,
      currentlyParked: parkedCourseIds.has(incident.courseId),
      humanReviewCycles: deriveParkedCourseCampaignHumanReviewCycles({
        events: incident.monitoringEvents,
        campaignRunId,
        campaignMembershipDigest: audit.membershipDigest,
      }),
    };
  });
}

async function loadCampaignProgressFromDatabase(
  campaignRunId: string,
  audit: ParkedCourseCampaignAudit,
  database: ParkedCourseCampaignDatabase,
) {
  const parkedMembers = await loadAllParkedCourseCampaignMembers(database);
  const remainingGlobalParkedCount =
    await loadGlobalParkedCourseCampaignCount(database);
  const memberByCourseId = new Map(
    audit.members.map((member) => [member.courseId, member]),
  );
  const parkedCourseIds = new Set(
    parkedMembers.flatMap((member) => {
      const captured = memberByCourseId.get(member.courseId);
      return captured && isSameCampaignMemberMaterialSnapshot(captured, member)
        ? [member.courseId]
        : [];
    }),
  );
  return summarizeParkedCourseCampaignProgress({
    audit,
    observations: await loadCampaignMemberObservations(
      audit,
      parkedCourseIds,
      campaignRunId,
      database,
    ),
    remainingGlobalParkedCount,
  });
}

async function acquireCampaignMemberMonitoringLocks(
  transaction: Prisma.TransactionClient,
  members: readonly ParkedCourseCampaignMember[],
) {
  const query = (
    transaction as Prisma.TransactionClient & {
      $queryRawUnsafe?: <T = unknown>(
        sql: string,
        ...values: unknown[]
      ) => Promise<T>;
    }
  ).$queryRawUnsafe;
  if (!query) return;
  for (const courseId of members.map((member) => member.courseId).sort()) {
    await query.call(
      transaction,
      `WITH acquired AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
       )
       SELECT true AS locked FROM acquired`,
      `course-monitoring:${courseId}`,
    );
  }
  const incidentIds = members.map((member) => member.incidentId).sort();
  const courseIds = members.map((member) => member.courseId).sort();
  await transaction.$queryRaw(
    Prisma.sql`SELECT id
               FROM "Course"
               WHERE id IN (${Prisma.join(courseIds)})
               ORDER BY id
               FOR UPDATE`,
  );
  await transaction.$queryRaw(
    Prisma.sql`SELECT id
               FROM "CourseSupportIncident"
               WHERE id IN (${Prisma.join(incidentIds)})
               ORDER BY id
               FOR UPDATE`,
  );
  await transaction.$queryRaw(
    Prisma.sql`SELECT "courseId"
               FROM "CourseMonitoringStatus"
               WHERE "courseId" IN (${Prisma.join(courseIds)})
               ORDER BY "courseId"
               FOR UPDATE`,
  );
}

function isRetryableCampaignCompletionError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (["P2028", "P2034"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /deadlock|serialize access|transaction.*closed|write conflict/iu.test(
    message,
  );
}

function asCampaignRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const defaultDependencies: ParkedCourseCampaignDependencies = {
  loadLatestCampaign: () =>
    prisma.automationRun.findFirst({
      where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true,
      },
    }),
  loadActiveCampaign: () =>
    prisma.automationRun.findFirst({
      where: {
        promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
        status: "RUNNING",
        completedAt: null,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true,
      },
    }),
  loadParkedMembers: loadParkedCourseCampaignMembers,
  loadAllParkedMembers: loadAllParkedCourseCampaignMembers,
  loadAdmissionMembers: (audit, campaignRunId) =>
    loadParkedCourseCampaignAdmissionMembers(
      audit,
      prisma,
      campaignRunId,
      getAutomationRuntimeVersion(),
    ),
  loadGlobalParkedCount: loadGlobalParkedCourseCampaignCount,
  loadMemberObservations: loadCampaignMemberObservations,
  createCampaign: (audit) =>
    prisma.automationRun.create({
      data: {
        promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
        kind: "COURSE_SUPPORT",
        status: "RUNNING",
        runtimeVersion: getAutomationRuntimeVersion(),
        ownerThreadId: process.env.CODEX_THREAD_ID?.trim() || null,
        heartbeatAt: new Date(audit.capturedAt),
        auditSchemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
        audit: audit as unknown as Prisma.InputJsonValue,
        notes: JSON.stringify({
          schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
          lifecycle: "active",
          campaignKind: audit.campaignKind,
          expectedCount: audit.expectedCount,
          membershipDigest: audit.membershipDigest,
          aggregateEvidenceCategories: audit.aggregateEvidenceCategories,
          customerDataIncluded: false,
        }),
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true,
      },
    }),
  completeCampaign: async (runId, audit, expectedProgress) => {
    if (
      expectedProgress.membershipDigest !== audit.membershipDigest ||
      expectedProgress.totalCount !== audit.members.length
    ) {
      return false;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await prisma.$transaction(
          async (transaction) => {
            await acquireCampaignMemberMonitoringLocks(
              transaction,
              audit.members,
            );
            const progress = await loadCampaignProgressFromDatabase(
              runId,
              audit,
              transaction,
            );
            if (
              progress.membershipDigest !== audit.membershipDigest ||
              progress.totalCount !== audit.members.length ||
              progress.terminalCount !== progress.totalCount ||
              progress.remainingGlobalParkedCount !== 0
            ) {
              return false;
            }
            const completedAt = new Date();
            const updated = await transaction.automationRun.updateMany({
              where: { id: runId, status: "RUNNING", completedAt: null },
              data: {
                status: "COMPLETED",
                completedAt,
                heartbeatAt: completedAt,
                outcome: "completed",
                notes: JSON.stringify({
                  schemaVersion: PARKED_COURSE_CAMPAIGN_AUDIT_SCHEMA_VERSION,
                  lifecycle: "closeout",
                  outcome: "completed",
                  progress,
                  customerDataIncluded: false,
                }),
              },
            });
            return updated.count === 1;
          },
          {
            // A future unfamiliar course can become durably parked while this
            // closeout is checking the global zero invariant. Serializable
            // isolation makes that concurrent predicate change retry instead
            // of allowing the immutable cohort to close against stale state.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 60_000,
          },
        );
      } catch (error) {
        lastError = error;
        if (!isRetryableCampaignCompletionError(error) || attempt === 3) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw lastError;
  },
  withTransitionLease: (worker) =>
    withPostgresAdvisoryTextLease(prisma, COURSE_SUPPORT_WRITER_LANE, worker),
};
