import { Prisma, type PrismaClient } from "@prisma/client";

import {
  hasDurableWaitForMaterialChangeProof,
  type AutomationStalledEndpointEvent,
  type AutomationStalledEndpointProofInput,
} from "@/lib/customer-monitoring-status";
import {
  loadCampaignMemberObservations,
  parseParkedCourseCampaignAudit,
  PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  summarizeParkedCourseCampaignProgress,
  type ParkedCourseCampaignMemberObservation,
} from "./course-support-campaign";
import { courseSupportFailureFingerprintsMatch } from "./course-support-failure-fingerprint";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";

const MAX_PARKING_EVENTS = 4096;

export type AcceptanceLedgerIncident = {
  id: string;
  courseId: string;
  cycle: number;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
  activeBatchId: string | null;
  nextAttemptAt: Date | null;
  nextReminderAt: Date | null;
  decisionActorId: string | null;
  decisionAt: Date | null;
  decisionNote: string | null;
  decisionEvidenceUrl: string | null;
  decisionIdempotencyKey: string | null;
  humanReviewReason: string | null;
  escalatedAt: Date | null;
  failureFingerprint: string;
  attemptLedger: unknown;
  monitoringEvents: Array<AutomationStalledEndpointEvent & {
    failureFingerprint: string | null;
  }>;
  course: {
    monitoringStatus: {
      state: AutomationStalledEndpointProofInput["monitoringState"];
      nextAutomaticAttemptAt: Date | null;
      revalidationRequestedAt: Date | null;
    } | null;
  };
};

function emptyPartitions() {
  return {
    freshMonitoredCount: 0,
    freshBookingNotOpenCount: 0,
    freshFactualLimitationCount: 0,
    freshTechnicalLimitationCount: 0,
    freshSourceUnverifiedCount: 0,
    incompletePlaybookParkedCount: 0,
    exhaustedUnchangedEngineeringCount: 0,
    resolvedMissingAcceptanceProofCount: 0,
    missingOrReplacedOriginalIncidentCount: 0,
    activeOwnerOrInvestigatingCount: 0,
    otherUnresolvedCount: 0,
    unknownCount: 0,
  };
}

function emptyProofGaps() {
  return {
    confirmationBoundaryMissingOrStaleCount: 0,
    terminalEventMissingOrStaleCount: 0,
    runtimeProofMissingOrMismatchedCount: 0,
    terminalRejectedByExistingClassifierCount: 0,
    invalidOrWrongCyclePlaybookCount: 0,
    parkingEvidenceMissingCount: 0,
    parkingExhaustionFlagMissingCount: 0,
    parkingExhaustionFlagMissingIncompleteCount: 0,
    parkingExhaustionFlagMissingExhaustedCount: 0,
    parkingExhaustionFlagMissingOtherConclusionCount: 0,
    parkingHistoryLimitExceededCount: 0,
  };
}

function emptyTimestampCounts() {
  return { nullCount: 0, pastOrPresentCount: 0, futureCount: 0, unknownCount: 0 };
}

function emptySchedulingMetadata() {
  return {
    incidentCount: 0,
    activeOwnerCount: 0,
    explicitDecisionPresentCount: 0,
    partialDecisionMetadataCount: 0,
    noExplicitDecisionCount: 0,
    nextAttemptAt: emptyTimestampCounts(),
    nextReminderAt: emptyTimestampCounts(),
    nextAutomaticAttemptAt: emptyTimestampCounts(),
    revalidationRequestedAt: emptyTimestampCounts(),
  };
}

function countTimestamp(counts: ReturnType<typeof emptyTimestampCounts>, value: Date | null | undefined, observedAt: Date) {
  if (value === null) counts.nullCount += 1;
  else if (!(value instanceof Date) || !Number.isFinite(value.getTime())) counts.unknownCount += 1;
  else if (value <= observedAt) counts.pastOrPresentCount += 1;
  else counts.futureCount += 1;
}

function countSchedulingMetadata(counts: ReturnType<typeof emptySchedulingMetadata>, incident: AcceptanceLedgerIncident, observedAt: Date) {
  counts.incidentCount += 1;
  if (incident.activeBatchId !== null) counts.activeOwnerCount += 1;
  const actorPresent = incident.decisionActorId !== null;
  const decisionAtPresent = incident.decisionAt !== null;
  // Match all five nullable decision-field presence fences in campaign loading.
  // Presence is not a verified decision or permission to recover incomplete work.
  const anyDecisionPresent = actorPresent || decisionAtPresent ||
    incident.decisionNote !== null || incident.decisionEvidenceUrl !== null ||
    incident.decisionIdempotencyKey !== null;
  if (anyDecisionPresent) counts.explicitDecisionPresentCount += 1;
  else counts.noExplicitDecisionCount += 1;
  if (anyDecisionPresent && (!actorPresent || !decisionAtPresent)) counts.partialDecisionMetadataCount += 1;
  countTimestamp(counts.nextAttemptAt, incident.nextAttemptAt, observedAt);
  countTimestamp(counts.nextReminderAt, incident.nextReminderAt, observedAt);
  // A missing monitoring row is unavailable metadata, not an explicit null field.
  countTimestamp(counts.nextAutomaticAttemptAt, incident.course.monitoringStatus?.nextAutomaticAttemptAt, observedAt);
  countTimestamp(counts.revalidationRequestedAt, incident.course.monitoringStatus?.revalidationRequestedAt, observedAt);
}

export function buildUnavailableAcceptanceLedger(
  observedAt: Date,
  reason: "INVALID_ARGUMENTS" | "DATABASE_UNAVAILABLE" | "CAMPAIGN_UNAVAILABLE" | "INVALID_CAMPAIGN" | "READ_FAILED",
) {
  return {
    recordType: "course_support_acceptance_ledger" as const,
    schemaVersion: 1 as const,
    status: "UNKNOWN" as const,
    reason,
    observedAt: observedAt.toISOString(),
    capturedAt: null,
    expectedCount: PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT,
    totalCount: null,
    partitions: null,
    proofGaps: null,
    pendingStageCounts: null,
    schedulingMetadataByStatus: null,
    partitionInvariant: "UNKNOWN" as const,
    automaticAdmissionAssessed: false as const,
    customerDataIncluded: false as const,
  };
}

/** Aggregate-only diagnostic. A known unresolved bucket is never terminal credit. */
export function buildCourseSupportAcceptanceLedger(input: {
  audit: unknown;
  observedAt: Date;
  observations: readonly ParkedCourseCampaignMemberObservation[];
  incidents: readonly AcceptanceLedgerIncident[];
}) {
  const audit = parseParkedCourseCampaignAudit(input.audit);
  if (
    !audit ||
    audit.expectedCount !== PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT ||
    new Set(audit.members.map((member) => member.incidentId)).size !== audit.members.length
  ) {
    return buildUnavailableAcceptanceLedger(input.observedAt, "INVALID_CAMPAIGN");
  }
  const partitions = emptyPartitions();
  const proofGaps = emptyProofGaps();
  const pendingStageCounts: Record<string, number> = {};
  const schedulingMetadataByStatus = {
    AUTO_INVESTIGATING: emptySchedulingMetadata(),
    NEEDS_HUMAN: emptySchedulingMetadata(),
    RESOLVED: emptySchedulingMetadata(),
  };
  const capturedAt = new Date(audit.capturedAt);
  for (const member of audit.members) {
    const observations = input.observations.filter((entry) => entry.courseId === member.courseId);
    const incidents = input.incidents.filter((entry) => entry.courseId === member.courseId);
    if (observations.length > 1 || incidents.length > 1) {
      partitions.unknownCount += 1;
      continue;
    }
    const observation = observations[0];
    const incident = incidents[0];
    if (!observation || !incident || observation.incidentId !== member.incidentId || incident.id !== member.incidentId) {
      partitions.missingOrReplacedOriginalIncidentCount += 1;
      continue;
    }
    if (observation.cycle !== incident.cycle || observation.status !== incident.status) {
      partitions.unknownCount += 1;
      continue;
    }
    // Nonexclusive metadata counts are not due-work, eligibility or liveness proof.
    countSchedulingMetadata(schedulingMetadataByStatus[incident.status], incident, input.observedAt);

    // Reuse the canonical strict classifier without changing its predicates.
    // This transient single-member view is never parsed, persisted or reported
    // as a replacement campaign; the complete immutable audit is validated above.
    const terminal = summarizeParkedCourseCampaignProgress({
      audit: { ...audit, members: [member] },
      observations: [observation],
      remainingGlobalParkedCount: 0,
    });
    if (terminal.terminalCount === 1) {
      partitions.freshMonitoredCount += terminal.monitoredCount;
      partitions.freshBookingNotOpenCount += terminal.bookingNotOpenCount;
      partitions.freshFactualLimitationCount += terminal.factualLimitationCount;
      partitions.freshTechnicalLimitationCount += terminal.technicalLimitationCount;
      partitions.freshSourceUnverifiedCount += terminal.sourceUnverifiedCount;
      continue;
    }
    if (observation.status === "RESOLVED") {
      partitions.resolvedMissingAcceptanceProofCount += 1;
      proofGaps.terminalRejectedByExistingClassifierCount += 1;
      if (!observation.confirmedAt || observation.confirmedAt < capturedAt || observation.cycle === null || observation.cycle <= member.cycle) {
        proofGaps.confirmationBoundaryMissingOrStaleCount += 1;
      }
      if (!observation.campaignTerminalEvidenceAt || !observation.confirmedAt || observation.campaignTerminalEvidenceAt < observation.confirmedAt) {
        proofGaps.terminalEventMissingOrStaleCount += 1;
      }
      if (!observation.campaignTerminalRuntimeVersion || observation.campaignTerminalRuntimeVersion !== observation.campaignTerminalDeploymentSha || observation.campaignTerminalFreshRuntimeProof !== true || observation.campaignTerminalAutomatedFinal === null) {
        proofGaps.runtimeProofMissingOrMismatchedCount += 1;
      }
      continue;
    }
    const monitoring = incident.course.monitoringStatus;
    if (incident.status === "AUTO_INVESTIGATING" || incident.activeBatchId !== null) {
      // Persisted ownership/investigation is not proof of a live process. Human
      // review reminders and stale revalidation timestamps do not enter here.
      partitions.activeOwnerOrInvestigatingCount += 1;
      continue;
    }
    if (incident.status !== "NEEDS_HUMAN" || monitoring?.state !== "ENGINEERING_VERIFICATION_NEEDED") {
      partitions.otherUnresolvedCount += 1;
      continue;
    }
    if (incident.monitoringEvents.length > MAX_PARKING_EVENTS) {
      partitions.unknownCount += 1;
      proofGaps.parkingHistoryLimitExceededCount += 1;
      continue;
    }
    const assessment = assessAutomationPlaybook(incident.attemptLedger, incident.cycle);
    if (!assessment.valid || assessment.cycle !== incident.cycle) {
      partitions.unknownCount += 1;
      proofGaps.invalidOrWrongCyclePlaybookCount += 1;
      continue;
    }
    const endpointEvents = incident.monitoringEvents.filter((event) =>
      event.failureFingerprint !== null && courseSupportFailureFingerprintsMatch(event.failureFingerprint, incident.failureFingerprint),
    );
    const parkingProven = hasDurableWaitForMaterialChangeProof({
      incidentId: incident.id,
      incidentCycle: incident.cycle,
      incidentStatus: incident.status,
      humanReviewReason: incident.humanReviewReason,
      incidentEscalatedAt: incident.escalatedAt,
      monitoringState: monitoring.state,
      endpointEvents,
    });
    if (!parkingProven) proofGaps.parkingEvidenceMissingCount += 1;
    if (parkingProven && !endpointEvents.some((event) => {
      const eventAudit = asRecord(event.audit);
      return event.incidentId === incident.id && eventAudit.cycle === incident.cycle &&
        event.eventType === "HUMAN_REVIEW_REQUESTED" &&
        event.occurredAt && incident.escalatedAt && event.occurredAt >= incident.escalatedAt &&
        typeof eventAudit.playbookExhausted === "boolean";
    })) {
      proofGaps.parkingExhaustionFlagMissingCount += 1;
      if (assessment.conclusion === "INCOMPLETE") proofGaps.parkingExhaustionFlagMissingIncompleteCount += 1;
      else if (assessment.conclusion === "UNRESOLVED_EXHAUSTED") proofGaps.parkingExhaustionFlagMissingExhaustedCount += 1;
      else proofGaps.parkingExhaustionFlagMissingOtherConclusionCount += 1;
    }
    if (assessment.conclusion === "INCOMPLETE" && assessment.nextStage) {
      // A remaining ledger stage is not permission to claim or execute it.
      // Operator decisions and exact action/ownership authority remain separate.
      partitions.incompletePlaybookParkedCount += 1;
      pendingStageCounts[assessment.nextStage] = (pendingStageCounts[assessment.nextStage] ?? 0) + 1;
    } else if (assessment.conclusion === "UNRESOLVED_EXHAUSTED" && parkingProven) {
      partitions.exhaustedUnchangedEngineeringCount += 1;
    } else {
      partitions.otherUnresolvedCount += 1;
    }
  }
  return {
    recordType: "course_support_acceptance_ledger" as const,
    schemaVersion: 1 as const,
    status: "AVAILABLE" as const,
    reason: null,
    observedAt: input.observedAt.toISOString(),
    capturedAt: audit.capturedAt,
    expectedCount: audit.expectedCount,
    totalCount: audit.members.length,
    partitions,
    proofGaps,
    pendingStageCounts,
    schedulingMetadataByStatus,
    partitionInvariant: Object.values(partitions).reduce((sum, value) => sum + value, 0) === audit.members.length ? "PASS" as const : "UNKNOWN" as const,
    automaticAdmissionAssessed: false as const,
    customerDataIncluded: false as const,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read-only, consistent database snapshot; no scheduler/responder mutation path. */
export async function loadCourseSupportAcceptanceLedger(database: Pick<PrismaClient, "$transaction">, observedAt = new Date()) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
      await transaction.$executeRaw`SET LOCAL statement_timeout = '25000ms'`;
      const campaign = await transaction.automationRun.findFirst({
        where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { id: true, audit: true },
      });
      if (!campaign) return buildUnavailableAcceptanceLedger(observedAt, "CAMPAIGN_UNAVAILABLE");
      const audit = parseParkedCourseCampaignAudit(campaign.audit);
      if (!audit || audit.expectedCount !== PARKED_COURSE_CAMPAIGN_EXPECTED_COUNT) return buildUnavailableAcceptanceLedger(observedAt, "INVALID_CAMPAIGN");
      const observations = await loadCampaignMemberObservations(audit, new Set(), campaign.id, transaction);
      const incidents = await transaction.courseSupportIncident.findMany({
        where: { courseId: { in: audit.members.map((member) => member.courseId) } },
        select: {
          id: true, courseId: true, cycle: true, status: true, activeBatchId: true,
          nextAttemptAt: true, humanReviewReason: true, escalatedAt: true,
          nextReminderAt: true, decisionActorId: true, decisionAt: true,
          decisionNote: true, decisionEvidenceUrl: true, decisionIdempotencyKey: true,
          failureFingerprint: true, attemptLedger: true,
          monitoringEvents: {
            where: { eventType: "HUMAN_REVIEW_REQUESTED" },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: MAX_PARKING_EVENTS + 1,
            select: { incidentId: true, eventType: true, occurredAt: true, failureFingerprint: true, audit: true },
          },
          course: { select: { monitoringStatus: { select: { state: true, nextAutomaticAttemptAt: true, revalidationRequestedAt: true } } } },
        },
      });
      return buildCourseSupportAcceptanceLedger({ audit, observedAt, observations, incidents });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 30_000 });
  } catch {
    return buildUnavailableAcceptanceLedger(observedAt, "READ_FAILED");
  }
}

export function parseAcceptanceLedgerArguments(args: readonly string[]) {
  return args.length === 1 && args[0] === "--machine";
}

export async function runCourseSupportAcceptanceLedgerDiagnostic(
  input: { args: readonly string[]; observedAt: Date },
  dependencies: {
    loadEnvironment: () => Promise<unknown>;
    getDatabaseUrl: () => string | undefined;
    read: () => Promise<ReturnType<typeof buildCourseSupportAcceptanceLedger>>;
  },
) {
  if (!parseAcceptanceLedgerArguments(input.args)) {
    return buildUnavailableAcceptanceLedger(input.observedAt, "INVALID_ARGUMENTS");
  }
  try {
    await dependencies.loadEnvironment();
    if (!dependencies.getDatabaseUrl()?.trim()) {
      return buildUnavailableAcceptanceLedger(input.observedAt, "DATABASE_UNAVAILABLE");
    }
    return await dependencies.read();
  } catch {
    return buildUnavailableAcceptanceLedger(input.observedAt, "READ_FAILED");
  }
}
