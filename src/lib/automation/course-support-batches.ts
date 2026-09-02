import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  AutomationReason,
  BookingMethod,
  CourseMonitoringState,
  CourseSupportBatchIncidentResult,
  CourseSupportBatchStatus,
  CourseSupportFailureClass,
  CourseSupportIncidentKind,
  CourseSupportResolution,
  GooglePlaceAccessOverride,
  ProbeOutcome
} from "@prisma/client";

import { evaluateMonitoringGate, isCoherentManualDisposition } from "@/lib/automation/policy";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import {
  buildCourseSupportProviderSnapshotFingerprint,
  getCurrentCourseSupportVerificationFailure,
  getEligibleCourseSupportVerificationProof,
  isCourseSupportFactualFinalProof,
  scheduleCourseSupportVerificationRequests
} from "./course-support-verification";
import {
  AUTOMATION_PLAYBOOK_STAGES,
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  isAutomationHumanReviewProofCurrentOrPrior,
  isAutomationPlaybookExhausted,
  parseAutomationPlaybookLedger,
  type AutomationPlaybookStage
} from "./course-monitoring-playbook";
import {
  buildCourseSupportSourceSearchAttemptRef,
  buildCourseSupportSourceSearchContext,
  buildCourseSupportSourceSearchScopeDigest,
  normalizeCourseSupportSourceSearchResult
} from "./course-support-source-search";
import {
  COURSE_SUPPORT_REMEDIATION_WORK_MODES,
  DEFAULT_COURSE_SUPPORT_TRANSIENT_RETRY_BUDGET,
  getCourseSupportRemediationDirective,
  isAssignedDetachedStageProgression,
  routeCourseSupportRemediation,
  shouldImplementReusableSupportAfterExhaustedDiscovery,
  type ActionableCourseSupportRemediationWorkMode,
  type CourseSupportRemediationAttemptSignature,
  type CourseSupportRemediationDirective,
  type CourseSupportRemediationRetryBudget,
  type CourseSupportRemediationRoutingReason,
  type CourseSupportRemediationRoute
} from "./course-support-remediation-routing";
import {
  courseSupportProviderContractEvidenceMarkersMatch,
  parseCourseSupportProviderContractEvidenceMarker,
  selectCurrentBrowserProviderContractEvidence,
  selectProviderContractTrustedBookingLandingUrl,
  selectProviderContractTrustedLandingUrl,
  type CourseSupportProviderContractEvidenceMarker,
} from "./course-support-provider-contract-evidence";
import {
  buildCourseSupportClaimActionPlan,
  courseSupportActionPlanAllows,
  courseSupportActionPlanMatchesRoute,
  isCourseSupportSourceSearchActionEligible,
  parseCourseSupportClaimActionPlan,
  type CourseSupportClaimActionPlan
} from "./course-support-action-plan";
import { buildCourseSupportActionExecution } from "./course-support-action-execution";
import {
  acquireCourseMonitoringWriteLockInTransaction,
  ACTIVE_DEMAND_ESCALATION_MS,
  getDeferredFailureHandoffEscalationDeadline,
  getCourseMonitoringEscalationDeadline,
  getHumanReviewRetryAt,
  INACTIVE_INVESTIGATION_MS,
  inferHumanReviewReason,
  reopenParkedCourseForResponderCampaignInTransaction,
  runSerializedCourseMonitoringWrite
} from "./course-monitoring";
import {
  getReportSafeProviderFamilyCategory,
  planNextParkedCourseCampaignCohort,
  inspectActiveParkedCourseCampaign,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  parseParkedCourseCampaignAudit,
} from "./course-support-campaign";
import {
  createDeferredFailureHandoffAdmission,
  createDeferredFailureHandoffBatchIncidentDigest,
  createDeferredFailureHandoffLegacySourceRecordDigest,
  createDeferredFailureHandoffSignal,
  createDeferredFailureHandoffSourceProofDigest,
  parseDeferredFailureHandoffAdmission,
  parseDeferredFailureHandoffSignal,
  type DeferredFailureHandoffSignal,
} from "./course-support-deferred-failure-handoff";
import {
  courseSupportFailureFingerprintsMatch,
  normalizeCourseSupportFailureFingerprint,
} from "./course-support-failure-fingerprint";
import {
  enqueueRemediatedCourseRechecks,
  isSearchScheduleWorkflowStartReservation,
} from "./search-recheck-queue";
import {
  withPostgresAdvisoryTextLease,
  type PostgresAdvisoryLeaseContext,
} from "./lease";
import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  getProviderReadinessFailure,
  isExactSourceMissingProviderState,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY
} from "./provider-capabilities";
import {
  getProviderExecutionEvidenceObservedAt,
  isProviderExecutionMarker,
} from "./provider-execution-marker";
import {
  COURSE_SUPPORT_BATCH_LEASE_MS,
  COURSE_SUPPORT_BATCH_MAX_SIZE,
  COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
  COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  clampCourseSupportBatchSize,
  getResponderThreadPolicy,
  sanitizeResponderText,
  sanitizeResponderValue,
  type ResponderFailureDomain,
  type ResponderOutcome
} from "./course-support-responder-policy";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";
import { COURSE_SUPPORT_WRITER_LANE } from "./writer-lanes";
import {
  areCourseSupportCompletedAttemptsOrchestrationOnly,
  buildCourseSupportExecutionEverSummary,
  countCourseSupportCompletedOrchestrationOnlyAttempts,
  getCourseSupportOrchestrationRetrySchedule,
  isCourseSupportAssignedAdapterOrchestrationMiss,
  isCourseSupportVerificationRequestUnstarted,
  readCourseSupportReleaseExecutionEvidence,
} from "./course-support-zero-execution";
import {
  buildCourseSupportSearchExecutionFenceSnapshot,
  CourseSupportSearchExecutionFenceRetryError,
  canAdvanceCourseSupportSearchExecutionFence,
  courseSupportSearchExecutionFenceMatches,
  createCourseSupportSearchExecutionFenceInput,
  getCourseSupportSearchExecutionMayHaveStartedCourseRefs,
  isCourseSupportSearchExecutionFenceRetryError,
  loadCourseSupportSearchExecutionFence,
  lockCourseSupportSearchExecutionFenceRows,
  persistCourseSupportSearchExecutionFence,
  readCourseSupportSearchExecutionFence,
  readPersistedCourseSupportSearchExecutionFence,
  type CourseSupportSearchExecutionFenceInput,
  type CourseSupportSearchExecutionFenceSnapshot,
  type PersistedCourseSupportSearchExecutionFence,
} from "./course-support-search-execution-fence";
import {
  classifyCourseSupportCampaignSummary,
  compareCourseSupportGroupPriority,
  isCriticalRealDemand,
  selectCourseSupportAdmissionLane,
  selectCourseSupportBatch,
  type CourseSupportCampaignSummaryState,
  type CourseSupportCandidate,
  type RecentBatchFairnessEvidence,
  type SelectedCourseSupportBatch
} from "./course-support-selection";
import {
  MONITORING_STRATEGY_ACTIONS,
  selectMonitoringStrategy,
  type MonitoringStrategyAction,
  type MonitoringStrategyInput,
} from "./monitoring-strategy";

export {
  classifyCourseSupportCampaignSummary,
  selectCourseSupportAdmissionLane,
  selectCourseSupportBatch,
  type CourseSupportCampaignSummaryState,
  type CourseSupportCandidate,
  type RecentBatchFairnessEvidence,
  type SelectedCourseSupportBatch
} from "./course-support-selection";

const NEAR_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TIMELINESS_GRACE_MS = 15 * 60 * 1000;
const RECHECK_HEALTH_FRESHNESS_MS = 2 * 60 * 1000;
const DETACHED_FAILURE_FALLBACK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// One verifier-only failure reclassification may reopen the episode, but a
// stable provider must then get one bounded investigation horizon to drain its
// existing playbook before another reclassification can reset that work.
const COURSE_SUPPORT_FAILURE_ONLY_HANDOFF_COOLDOWN_MS =
  Math.min(ACTIVE_DEMAND_ESCALATION_MS, INACTIVE_INVESTIGATION_MS);
const EXPIRED_UNRELEASED_BATCH_RETRY_DELAY_MS = 60 * 1000;
const COURSE_SUPPORT_WRITE_CONFLICT_MAX_ATTEMPTS = 3;
const COURSE_SUPPORT_WRITE_CONFLICT_BACKOFF_MS = 25;
const COURSE_SUPPORT_SERIALIZABLE_TRANSACTION_TIMEOUT_MS = 15_000;
// One atomic campaign claim can fence five members with twenty historical
// entries each, so it gets the same per-attempt budget as campaign closeout.
const COURSE_SUPPORT_BATCH_CLAIM_TRANSACTION_TIMEOUT_MS = 60_000;
const COURSE_SUPPORT_BATCH_CLAIM_PLANNING_BUDGET_MS = 60_000;
// Planning and retry backoff consume this same absolute envelope. Each inner
// attempt is capped to its remaining time while preserving release headroom.
const COURSE_SUPPORT_BATCH_CLAIM_WRITER_LEASE_HEADROOM_MS = 5_000;
const COURSE_SUPPORT_BATCH_CLAIM_WRITER_LEASE_TIMEOUT_MS =
  COURSE_SUPPORT_BATCH_CLAIM_PLANNING_BUDGET_MS +
  COURSE_SUPPORT_BATCH_CLAIM_TRANSACTION_TIMEOUT_MS *
    COURSE_SUPPORT_WRITE_CONFLICT_MAX_ATTEMPTS;
const COURSE_SUPPORT_ACTIVE_CAMPAIGN_FENCE_LIMIT = 100;
const COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT = 256;
const COURSE_SUPPORT_PARKED_RECOVERY_SCAN_LIMIT =
  COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT * 4;
const COURSE_SUPPORT_CANDIDATE_BATCH_HISTORY_READ_LIMIT = 128;
const COURSE_SUPPORT_CANDIDATE_REQUEST_HISTORY_READ_LIMIT = 64;
const COURSE_SUPPORT_CANDIDATE_CURRENT_CYCLE_EVENT_READ_LIMIT = 20;
const COURSE_SUPPORT_CANDIDATE_PREFERENCE_READ_LIMIT = 1_024;
const COURSE_SUPPORT_AUTHORITATIVE_PROBE_READ_LIMIT = 256;
const ACTIVE_BATCH_STATUSES: CourseSupportBatchStatus[] = ["CLAIMED", "IMPLEMENTING", "VERIFYING"];
// Keep long-lived Codex ownership aligned with the global provider I/O limit.
// Additional owners cannot make provider progress and can starve unrelated
// interactive/release work on the local Codex host.
const MAX_CONCURRENT_COURSE_SUPPORT_BATCHES = 2;
const TRANSIENT_FAILURE_CLASSES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK"
]);
const COURSE_SUPPORT_FAILURE_CLASSES = new Set<CourseSupportFailureClass>([
  "MISSING_SOURCE",
  "MISSING_METADATA",
  "UNSUPPORTED_FAMILY",
  "READER_PARSER_MISSING",
  "AUTH",
  "RATE_LIMIT",
  "CHALLENGE",
  "NOT_FOUND",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "SCHEMA",
  "UNKNOWN"
]);
const SUCCESSFUL_PROBE_OUTCOMES = new Set<ProbeOutcome>(["MATCH_FOUND", "NO_MATCH"]);
const FINAL_AUTOMATION_REASONS = new Set<AutomationReason>([
  "ACCOUNT_REQUIRED",
  "CAPTCHA_OR_QUEUE"
]);
const DERIVED_CLOSEOUT_OUTCOMES = new Set<ResponderOutcome>([
  "success",
  "classification_only",
  "partial",
  "retryable_failed",
  "needs_human"
]);
const FAILURE_CLOSEOUT_OUTCOMES = new Set<ResponderOutcome>([
  "blocked_auth",
  "blocked_env",
  "blocked_git",
  "migration_failed",
  "deploy_failed",
  "production_verification_failed",
  "privacy_incident",
  "delivery_incident",
  "unsafe_provider",
  "repeated_sla_failure",
  "command_failed"
]);
const OPERATIONAL_RETRY_CLOSEOUT_OUTCOMES = new Set<ResponderOutcome>([
  "blocked_auth",
  "blocked_env",
  "blocked_git",
  "migration_failed",
  "deploy_failed",
  "production_verification_failed",
  "command_failed"
]);
const COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUSES = [
  "LEARNED",
  "VERIFIED",
  "INSPECTED",
  "BLOCKED"
] as const;
const COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUS_SET = new Set<string>(
  COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUSES
);
const DETACHED_VERIFICATION_COURSE_SELECT = {
  id: true,
  updatedAt: true,
  name: true,
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
  monitoringStatus: {
    select: {
      state: true,
      stateChangedAt: true,
      lastSuccessfulAt: true,
      failureFingerprint: true,
      nextAutomaticAttemptAt: true,
      revalidationRequestedAt: true,
      revision: true
    }
  },
  monitoringEvents: {
    where: { eventType: "CHECK_FAILED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 1,
    select: {
      failureFingerprint: true,
      occurredAt: true,
      audit: true
    }
  },
  probes: {
    where: {
      teeSearch: {
        status: "ACTIVE",
        trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
      },
    },
    orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    take: 2,
    select: {
      id: true,
      outcome: true,
      observedAt: true,
      runtimeVersion: true,
      rawSummary: true,
    },
  }
} satisfies Prisma.CourseSelect;
const DETACHED_VERIFICATION_REQUEST_STATE_SELECT = {
  id: true,
  batchIncidentId: true,
  releaseSha: true,
  runtimeVersion: true,
  status: true,
  revision: true,
  attemptCount: true,
  startedAt: true,
  outcome: true,
  failureClass: true,
  evidence: true,
  lastError: true,
  providerSnapshotFingerprint: true,
  nextAttemptAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CourseSupportVerificationRequestSelect;
const COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT = {
  id: true,
  courseId: true,
  cycle: true,
  confirmedAt: true,
  attemptLedger: true,
  kind: true,
  providerFamilyKey: true,
  failureClass: true,
  failureFingerprint: true,
  humanReviewReason: true,
  engineeringOnly: true,
  activeRealSearchCount: true,
  earliestTargetDate: true,
  escalationDeadlineAt: true,
  escalatedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  lastAttemptAt: true,
  nextAttemptAt: true,
  attemptCount: true,
  status: true,
  activeBatchId: true,
  revision: true,
  updatedAt: true,
  monitoringEvents: {
    where: { eventType: "REVALIDATION_REQUESTED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    // Keep a bounded newest-first provenance view for routing. The exact
    // current-cycle cap is validated separately so prior-cycle rows cannot
    // consume this window and hide a current-cycle overflow.
    take: COURSE_SUPPORT_CANDIDATE_CURRENT_CYCLE_EVENT_READ_LIMIT + 1,
    select: {
      id: true,
      eventType: true,
      occurredAt: true,
      failureFingerprint: true,
      audit: true,
    },
  },
  batchIncidents: {
    where: { batch: { completedAt: { not: null } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: COURSE_SUPPORT_CANDIDATE_BATCH_HISTORY_READ_LIMIT + 1,
    select: {
      id: true,
      batchId: true,
      incidentId: true,
      courseId: true,
      cycle: true,
      result: true,
      proofSnapshot: true,
      verifiedAt: true,
      verifiedIncidentUpdatedAt: true,
      createdAt: true,
      updatedAt: true,
      verificationRequests: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: COURSE_SUPPORT_CANDIDATE_REQUEST_HISTORY_READ_LIMIT + 1,
        select: {
          id: true,
          batchIncidentId: true,
          releaseSha: true,
          runtimeVersion: true,
          status: true,
          revision: true,
          attemptCount: true,
          startedAt: true,
          outcome: true,
          failureClass: true,
          evidence: true,
          lastError: true,
          providerSnapshotFingerprint: true,
          nextAttemptAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      batch: {
        select: {
          id: true,
          status: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          baseSha: true,
          summary: true,
          releaseSha: true,
          deployedAt: true,
          createdAt: true,
          completedAt: true,
          revision: true,
          updatedAt: true,
        },
      }
    }
  },
  course: {
    select: {
      ...DETACHED_VERIFICATION_COURSE_SELECT,
      probes: {
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        take: 2,
        select: {
          id: true,
          outcome: true,
          observedAt: true,
          runtimeVersion: true,
        },
      },
      preferences: {
        where: {
          teeSearch: {
            status: "ACTIVE",
            trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] }
          }
        },
        take: COURSE_SUPPORT_CANDIDATE_PREFERENCE_READ_LIMIT + 1,
        select: { teeSearch: { select: { id: true, date: true } } }
      },
      automationDiscoveries: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 12,
        select: {
          id: true,
          evidence: true,
          automationReason: true,
          detectedPlatform: true,
          bookingUrl: true,
          apiMetadata: true,
          confidence: true,
          createdAt: true
        }
      }
    }
  }
} satisfies Prisma.CourseSupportIncidentSelect;

type CourseSupportCandidateIncident = Prisma.CourseSupportIncidentGetPayload<{
  select: typeof COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT;
}>;

type SourceCompleteFinalizationCampaignProvenance = {
  runId: string;
  membershipDigest: string;
};

type SourceCompleteFinalizationRecovery = {
  evidenceDigest: string;
  sourceBatchId: string;
  sourceBatchIncidentId: string;
  priorIncidentStatus: "AUTO_INVESTIGATING" | "NEEDS_HUMAN";
  priorHumanReviewReason: CourseSupportCandidate["humanReviewReason"];
  expectedMonitoringState: CourseMonitoringState;
  expectedMonitoringRevision: number;
  expectedMonitoringStateChangedAt: Date;
  expectedLatestDiscoveryId: string | null;
  expectedLatestDiscoveryCreatedAt: Date | null;
  campaign: SourceCompleteFinalizationCampaignProvenance | null;
};

type CourseSupportClaimCandidate = CourseSupportCandidate & {
  courseUpdatedAt: Date;
  playbookEventCountAtClaim: number;
  sourceCompleteFinalizationRecovery?: SourceCompleteFinalizationRecovery;
};

export class CourseSupportClaimReplanRequired extends Error {
  constructor(readonly originalError: Error) {
    super(originalError.message);
    this.name = "CourseSupportClaimReplanRequired";
  }
}

function isCourseSupportClaimSnapshotDrift(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.endsWith("rerun selection.") ||
      error.message ===
        "A parked-course campaign member changed before atomic batch admission.")
  );
}

function readCandidateSourceCompleteFinalizationRecovery(
  candidate: CourseSupportCandidate,
) {
  return (candidate as CourseSupportClaimCandidate)
    .sourceCompleteFinalizationRecovery;
}

type DetachedVerificationRequestState = Prisma.CourseSupportVerificationRequestGetPayload<{
  select: typeof DETACHED_VERIFICATION_REQUEST_STATE_SELECT;
}>;

type CourseSupportDemandPreference = {
  teeSearch: {
    id: string;
    date: Date;
  };
};

export function deriveCourseSupportCurrentDemand(
  preferences: readonly CourseSupportDemandPreference[],
  context?: { timeZone: string; now: Date }
) {
  if (preferences.length > COURSE_SUPPORT_CANDIDATE_PREFERENCE_READ_LIMIT) {
    throw new Error(
      "Course-support candidate demand exceeds the bounded read limit.",
    );
  }
  const dateBoundary = context
    ? getCourseLocalDateStorageBoundary(context.timeZone, context.now)
    : null;
  const searchDates = new Map<string, Date>();
  for (const preference of preferences) {
    if (dateBoundary && preference.teeSearch.date.getTime() < dateBoundary.getTime()) {
      continue;
    }
    const current = searchDates.get(preference.teeSearch.id);
    if (!current || preference.teeSearch.date.getTime() < current.getTime()) {
      searchDates.set(preference.teeSearch.id, preference.teeSearch.date);
    }
  }
  const dates = [...searchDates.values()].sort((left, right) => left.getTime() - right.getTime());
  return {
    activeRealSearchCount: dates.length,
    earliestTargetDate: dates[0] ?? null
  };
}

export type CourseSupportRetryBatchEvidence = {
  status: CourseSupportBatchStatus;
  completedAt: Date | null;
  summary: Prisma.JsonValue | null;
  providerFamilyKey: string;
  failureFingerprint: string;
  incidents: Array<{
    id: string;
    incidentId: string;
    courseId: string;
    cycle: number;
    result: CourseSupportBatchIncidentResult;
    incident: {
      batchIncidents: Array<{
        id: string;
        cycle: number;
      }>;
    };
  }>;
};

export type CourseSupportCourseEvidence = {
  isPublic: boolean | null;
  bookingMethod: BookingMethod;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason: AutomationReason;
  monitoringMode?: string | null;
  website?: string | null;
  detectedBookingUrl?: string | null;
  policyNotes?: string | null;
  intelligenceVerifiedAt?: Date | null;
  intelligenceReviewAt?: Date | null;
  intelligenceConfidence?: number | null;
  latestPlaceReview?: {
    active: boolean;
    accessOverride: GooglePlaceAccessOverride | null;
    classification: string;
    evidenceUrl: string;
    reviewedAt: Date;
    updatedAt: Date;
  } | null;
  latestDiscovery?: {
    status: string;
    detectedPlatform?: string;
    bookingMethod: BookingMethod;
    bookingPhone?: string | null;
    automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
    automationReason: AutomationReason;
    sourceUrl: string;
    bookingUrl: string | null;
    apiEndpoint?: string | null;
    apiMetadata?: Prisma.JsonValue | null;
    confidence: number;
    evidence?: Prisma.JsonValue | null;
    createdAt: Date;
  } | null;
};

export type FreshProbeEvidence = {
  id: string;
  outcome: ProbeOutcome;
  observedAt: Date;
  freshSearchCheckedAt?: Date | null;
  runtimeVersion: string | null;
  providerExecution: boolean;
  providerExecutionObservedAt?: Date | null;
  runnableCoverageProven?: boolean;
  scheduleVersion?: number | null;
  trafficClass?: string | null;
};

function getFreshProbeProviderObservedAt(
  probe: FreshProbeEvidence,
): Date | null {
  return probe.providerExecutionObservedAt === undefined
    ? probe.observedAt
    : probe.providerExecutionObservedAt;
}

function getFreshProbeOrderingTime(probe: FreshProbeEvidence) {
  return getFreshProbeProviderObservedAt(probe) ?? probe.observedAt;
}

function compareFreshProbeEvidenceDescending(
  left: FreshProbeEvidence,
  right: FreshProbeEvidence,
) {
  const providerTimeOrder =
    getFreshProbeOrderingTime(right).getTime() -
    getFreshProbeOrderingTime(left).getTime();
  if (providerTimeOrder !== 0) return providerTimeOrder;
  const rowTimeOrder = right.observedAt.getTime() - left.observedAt.getTime();
  return rowTimeOrder !== 0
    ? rowTimeOrder
    : right.id.localeCompare(left.id);
}

function haveSameFreshProbeMeaning(
  left: FreshProbeEvidence,
  right: FreshProbeEvidence,
) {
  return (
    left.outcome === right.outcome &&
    left.runtimeVersion === right.runtimeVersion &&
    left.providerExecution === right.providerExecution &&
    (getFreshProbeProviderObservedAt(left)?.getTime() ?? null) ===
      (getFreshProbeProviderObservedAt(right)?.getTime() ?? null)
  );
}

export type BatchIncidentVerification = {
  result: CourseSupportBatchIncidentResult;
  postProbeId: string | null;
  message: string;
  proofSnapshot: Prisma.InputJsonValue | null;
};

type CurrentProviderEvidenceSource = "WORKFLOW" | "DETACHED_VERIFICATION" | "DETACHED_FAILURE";

const CURRENT_PROVIDER_EVIDENCE_KIND = {
  WORKFLOW: "PROVIDER_PROBE",
  DETACHED_VERIFICATION: "PROVIDER_VERIFICATION",
  DETACHED_FAILURE: "PROVIDER_VERIFICATION_FAILURE"
} as const satisfies Record<CurrentProviderEvidenceSource, string>;

const CURRENT_PROVIDER_EVIDENCE_TIE_PRIORITY = {
  WORKFLOW: 1,
  DETACHED_VERIFICATION: 2,
  DETACHED_FAILURE: 3
} as const satisfies Record<CurrentProviderEvidenceSource, number>;

export function runWithCourseSupportWriterTransitionLease<T>(
  worker: (context: PostgresAdvisoryLeaseContext) => Promise<T>,
  options?: { timeout?: number },
) {
  return withPostgresAdvisoryTextLease(
    prisma,
    COURSE_SUPPORT_WRITER_LANE,
    worker,
    options,
  );
}

export function isRetryableCourseSupportWriteConflict(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (["P2034", "40P01", "40001"].includes(code.toUpperCase())) {
    return true;
  }
  const message =
    "message" in error && typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    message.includes("deadlock detected") ||
    message.includes("write conflict") ||
    message.includes("serialization failure")
  );
}

export async function withCourseSupportWriteConflictRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
) {
  const maxAttempts = options.maxAttempts ?? COURSE_SUPPORT_WRITE_CONFLICT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Course-support write-conflict attempts must be an integer from 1 through 5.");
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt === maxAttempts || !isRetryableCourseSupportWriteConflict(error)) {
        throw error;
      }
      await sleep(COURSE_SUPPORT_WRITE_CONFLICT_BACKOFF_MS * attempt);
      options.signal?.throwIfAborted();
    }
  }
  throw new Error("Course-support write-conflict retry exhausted unexpectedly.");
}

function isResponderSelectionEligible(input: {
  confirmedAt: Date | null | undefined;
  attemptLedger: unknown;
  cycle: number;
  engineeringOnly: boolean;
  activeRealSearchCount: number;
}) {
  if (input.confirmedAt != null) {
    return true;
  }
  if (input.engineeringOnly && input.activeRealSearchCount === 0) {
    return true;
  }
  if (input.activeRealSearchCount <= 0) {
    return false;
  }
  const assessment = assessAutomationPlaybook(input.attemptLedger, input.cycle);
  return (
    assessment.valid &&
    assessment.conclusion === "INCOMPLETE" &&
    (assessment.nextStage === "RENDERED_BROWSER_DISCOVERY" ||
      assessment.nextStage === "INDEPENDENT_CONFIRMATION")
  );
}

function getAuthoritativeCourseMonitoringResolution(
  state: CourseMonitoringState | null | undefined
) {
  switch (state) {
    case "HEALTHY":
      return {
        resolution: "MONITORING_RESTORED" as const,
        message: "Current authoritative monitoring state already records restored monitoring."
      };
    case "FINAL_MANUAL":
      return {
        resolution: "DIRECT_BOOKING_CLASSIFIED" as const,
        message:
          "Current authoritative monitoring state already records the direct booking classification."
      };
    case "FINAL_IDENTITY":
      return {
        resolution: "IDENTITY_CLASSIFIED" as const,
        message:
          "Current authoritative monitoring state already records the identity classification."
      };
    case "FINAL_TECHNICAL":
      return {
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED" as const,
        message:
          "Current authoritative monitoring state already records the proof-backed technical classification."
      };
    default:
      return null;
  }
}

function buildDueResponderIncidentWhere(now: Date): Prisma.CourseSupportIncidentWhereInput {
  return {
    status: "AUTO_INVESTIGATING",
    activeBatchId: null,
    AND: [
      {
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      {
        OR: [
          { confirmedAt: { not: null } },
          { engineeringOnly: true },
          {
            course: {
              preferences: {
                some: {
                  teeSearch: {
                    status: "ACTIVE",
                    trafficClass: {
                      notIn: [...syntheticWebsiteTrafficClasses]
                    }
                  }
                }
              }
            }
          }
        ]
      }
    ]
  };
}

function buildParkedSourceCompleteFinalizationRecoveryWhere(): Prisma.CourseSupportIncidentWhereInput {
  return {
    status: "NEEDS_HUMAN",
    humanReviewReason: "AUTOMATION_STALLED",
    activeBatchId: null,
    nextAttemptAt: null,
    resolution: null,
    resolvedAt: null,
    batchIncidents: {
      some: {
        result: "RETRY_SCHEDULED",
        batch: {
          status: "RETRYABLE_FAILED",
          completedAt: { not: null },
        },
      },
    },
    course: {
      monitoringStatus: {
        is: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        },
      },
    },
  };
}

function runCourseSupportTransactionWithRetry<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) {
  return withCourseSupportWriteConflictRetry(() => prisma.$transaction(operation));
}

function runCourseSupportSerializableTransactionWithRetry<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  timeout = COURSE_SUPPORT_SERIALIZABLE_TRANSACTION_TIMEOUT_MS,
  writerLeaseBudget?: {
    deadlineAt: Date;
    headroomMs: number;
  },
) {
  return withCourseSupportWriteConflictRetry(() => {
    let attemptTimeout = timeout;
    if (writerLeaseBudget) {
      const remainingBeforeHeadroom = Math.floor(
        writerLeaseBudget.deadlineAt.getTime() -
          Date.now() -
          writerLeaseBudget.headroomMs,
      );
      if (remainingBeforeHeadroom < 1) {
        throw new Error(
          "The course-support writer lease budget was exhausted before the serializable transaction could start.",
        );
      }
      attemptTimeout = Math.min(timeout, remainingBeforeHeadroom);
    }
    return prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: attemptTimeout,
    });
  });
}

async function getCourseSupportDatabaseNow(transaction: Prisma.TransactionClient) {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "now"`
  );
  if (!row?.now || !Number.isFinite(row.now.getTime())) {
    throw new Error("Course-support database time is unavailable.");
  }
  return row.now;
}

async function fenceCourseSupportClaimCourseRows(
  transaction: Prisma.TransactionClient,
  courses: readonly { id: string; updatedAt: Date }[],
) {
  const stableCourses = [...courses].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const [index, course] of stableCourses.entries()) {
    if (index > 0 && stableCourses[index - 1]?.id === course.id) {
      throw new Error(
        "Course-support claim contains duplicate course evidence.",
      );
    }
    const fenced = await transaction.course.updateMany({
      where: { id: course.id, updatedAt: course.updatedAt },
      data: { updatedAt: course.updatedAt },
    });
    if (fenced.count !== 1) {
      throw new Error(
        "Course-support course evidence changed during claim; rerun selection.",
      );
    }
  }
}

async function lockCourseSupportClaimIncidentRows(
  transaction: Prisma.TransactionClient,
  incidents: readonly { id: string }[],
) {
  const stableIncidentIds = incidents
    .map((incident) => incident.id)
    .sort((left, right) => left.localeCompare(right));
  if (
    stableIncidentIds.some(
      (incidentId, index) =>
        index > 0 && stableIncidentIds[index - 1] === incidentId,
    )
  ) {
    throw new Error(
      "Course-support claim contains duplicate incident evidence.",
    );
  }
  const locked = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id"
       FROM "CourseSupportIncident"
      WHERE "id" = ANY($1::text[])
      ORDER BY "id"
      FOR UPDATE`,
    stableIncidentIds,
  );
  if (
    locked.length !== stableIncidentIds.length ||
    locked.some((row, index) => row.id !== stableIncidentIds[index])
  ) {
    throw new Error(
      "Course-support incident ownership changed before claim; rerun selection.",
    );
  }
}

async function acquireCourseSupportClaimMonitoringLocks(
  transaction: Prisma.TransactionClient,
  courseIds: readonly string[],
) {
  for (const courseId of [...new Set(courseIds)].sort((left, right) =>
    left.localeCompare(right),
  )) {
    await acquireCourseMonitoringWriteLockInTransaction(transaction, courseId);
  }
}

export async function getOwnedCourseSupportLeaseToken(input: {
  batchId: string;
  ownerThreadId: string;
}) {
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES }
    },
    select: { leaseToken: true }
  });
  if (!batch) {
    throw new Error("The responder batch is not owned by this task.");
  }
  return batch.leaseToken;
}

export async function renewCourseSupportBatchOperationLease(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now }
    },
    select: {
      status: true,
      revision: true,
      summary: true
    }
  });
  if (!batch) {
    return operationLeaseRenewalResult(null);
  }
  if (courseSupportBatchReservesCheckout(batch)) {
    const transition = await runWithCourseSupportWriterTransitionLease(() =>
      runCourseSupportTransactionWithRetry(async (transaction) => {
        const databaseNow = await getCourseSupportDatabaseNow(transaction);
        const current = await transaction.courseSupportBatch.findFirst({
          where: {
            id: input.batchId,
            leaseToken: input.leaseToken,
            ownerThreadId: input.ownerThreadId,
            status: { in: ACTIVE_BATCH_STATUSES },
            leaseExpiresAt: { gt: databaseNow }
          },
          select: {
            status: true,
            revision: true,
            summary: true
          }
        });
        if (!current || !courseSupportBatchReservesCheckout(current)) {
          return null;
        }
        const otherActiveBatches = await transaction.courseSupportBatch.findMany({
          where: {
            id: { not: input.batchId },
            status: { in: ACTIVE_BATCH_STATUSES },
            leaseExpiresAt: { gt: databaseNow }
          },
          select: { status: true, summary: true }
        });
        if (otherActiveBatches.some((candidate) => courseSupportBatchReservesCheckout(candidate))) {
          return null;
        }
        const leaseExpiresAt = new Date(databaseNow.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
        const updated = await transaction.courseSupportBatch.updateMany({
          where: {
            id: input.batchId,
            leaseToken: input.leaseToken,
            ownerThreadId: input.ownerThreadId,
            status: current.status,
            revision: current.revision,
            leaseExpiresAt: { gt: databaseNow }
          },
          data: {
            heartbeatAt: databaseNow,
            leaseExpiresAt
          }
        });
        return updated.count === 1 ? leaseExpiresAt : null;
      })
    );
    return operationLeaseRenewalResult(transition.acquired ? transition.value : null);
  }

  const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
  const updated = await prisma.courseSupportBatch.updateMany({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: batch.status,
      revision: batch.revision,
      leaseExpiresAt: { gte: now }
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt
    }
  });
  return operationLeaseRenewalResult(updated.count === 1 ? leaseExpiresAt : null);
}

function operationLeaseRenewalResult(leaseExpiresAt: Date | null) {
  return {
    outcome: leaseExpiresAt ? ("ready" as const) : ("recovery_required" as const),
    heartbeatRecorded: leaseExpiresAt !== null,
    leaseExpiresAt: leaseExpiresAt?.toISOString() ?? null
  };
}

export async function resolveCourseSupportBatchReference(reference: string) {
  if (!/^support-\d{14}-[a-f0-9]{10}$/.test(reference)) {
    throw new Error("Invalid course-support batch reference.");
  }
  const batch = await prisma.courseSupportBatch.findUnique({
    where: { reference },
    select: { id: true }
  });
  if (!batch) {
    throw new Error("Course-support batch reference was not found.");
  }
  return batch.id;
}

type PersistedCourseSupportRemediationAttempt = {
  courseRef: string;
  providerSnapshotFingerprint: string;
  failureFingerprint: string;
  runtimeVersion: string;
  activeRealSearchCount: number;
  consumed: boolean;
  countsTowardOperationalNoProgress: boolean | null;
  approach: CourseSupportRemediationAttemptSignature | null;
};

const COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET = 2;
const COURSE_SUPPORT_OPERATIONAL_RETRY_DELAY_MS = 60 * 1000;

function createCourseSupportRemediationCourseRef(courseId: string) {
  return createHash("sha256").update(courseId).digest("hex").slice(0, 24);
}

function serializeCourseSupportRemediationRetryBudget(
  retryBudget: CourseSupportRemediationRetryBudget | null
) {
  return retryBudget
    ? {
        maximumAttempts: retryBudget.maximumAttempts,
        attemptsCompleted: retryBudget.attemptsCompleted,
        attemptsRemaining: retryBudget.attemptsRemaining,
        exhausted: retryBudget.exhausted
      }
    : null;
}

function serializeCourseSupportRemediationRoute(route: CourseSupportRemediationRoute) {
  return {
    schemaVersion: 1,
    workMode: route.workMode,
    resumeWorkMode: route.resumeWorkMode,
    allowUnchangedRuntime: route.allowUnchangedRuntime,
    requiresImplementationPath: route.requiresImplementationPath,
    reason: route.reason,
    strategyAction: route.strategy.action,
    strategyReason: route.strategy.reason,
    playbookStage: route.attemptSignature?.playbookStage ?? null,
    retryBudget: serializeCourseSupportRemediationRetryBudget(route.retryBudget)
  } satisfies Prisma.InputJsonObject;
}

function courseSupportClaimActionPlansMatch(
  left: CourseSupportClaimActionPlan | null | undefined,
  right: CourseSupportClaimActionPlan | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.primaryAction === right.primaryAction &&
    left.allowedActions.length === right.allowedActions.length &&
    left.allowedActions.every(
      (action, index) => action === right.allowedActions[index],
    ) &&
    left.route.workMode === right.route.workMode &&
    left.route.strategyAction === right.route.strategyAction &&
    left.route.playbookStage === right.route.playbookStage
  );
}

function courseSupportRemediationAttemptSignaturesMatch(
  left: CourseSupportRemediationAttemptSignature | null | undefined,
  right: CourseSupportRemediationAttemptSignature | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    left.workMode === right.workMode &&
    left.strategyAction === right.strategyAction &&
    left.playbookStage === right.playbookStage
  );
}

function courseSupportRemediationRoutesMatch(
  left: CourseSupportRemediationRoute | null | undefined,
  right: CourseSupportRemediationRoute | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    JSON.stringify(serializeCourseSupportRemediationRoute(left)) ===
      JSON.stringify(serializeCourseSupportRemediationRoute(right)) &&
    left.materialChangeDetected === right.materialChangeDetected &&
    left.strategy.providerFamilyKey === right.strategy.providerFamilyKey &&
    left.strategy.browserAllowed === right.strategy.browserAllowed &&
    courseSupportRemediationAttemptSignaturesMatch(
      left.attemptSignature,
      right.attemptSignature,
    )
  );
}

function courseSupportClaimAuthorityMatches(
  selected: CourseSupportClaimCandidate,
  current: CourseSupportClaimCandidate,
) {
  return (
    courseSupportRemediationRoutesMatch(
      selected.remediationRoute,
      current.remediationRoute,
    ) &&
    courseSupportClaimActionPlansMatch(selected.actionPlan, current.actionPlan) &&
    courseSupportProviderContractEvidenceMarkersMatch(
      selected.providerContractEvidence,
      current.providerContractEvidence,
    ) &&
    selected.playbookEventCountAtClaim === current.playbookEventCountAtClaim
  );
}

type PersistedCourseSupportRemediationDirective = CourseSupportRemediationDirective & {
  allowUnchangedRuntime: boolean;
  requiresImplementationPath: boolean;
  reason: string | null;
  retryBudget: CourseSupportRemediationRetryBudget | null;
};

export type CourseSupportRemediationClaimAttempt = {
  courseRef: string;
  providerSnapshotFingerprint: string;
  failureFingerprint: string;
  playbookEventCountAtClaim: number;
  approach: CourseSupportRemediationAttemptSignature;
  actionPlan: CourseSupportClaimActionPlan | null;
  providerContractEvidence: CourseSupportProviderContractEvidenceMarker | null;
};

export function readCourseSupportRemediationDirective(
  summary: unknown
): PersistedCourseSupportRemediationDirective | null {
  const remediation = asJsonObject(asJsonObject(summary).remediation);
  const workMode = remediation.workMode;
  const strategyAction = remediation.strategyAction;
  const playbookStage = remediation.playbookStage;
  if (
    typeof workMode !== "string" ||
    !COURSE_SUPPORT_REMEDIATION_WORK_MODES.includes(
      workMode as (typeof COURSE_SUPPORT_REMEDIATION_WORK_MODES)[number]
    ) ||
    typeof strategyAction !== "string" ||
    !MONITORING_STRATEGY_ACTIONS.includes(
      strategyAction as (typeof MONITORING_STRATEGY_ACTIONS)[number]
    ) ||
    !(
      playbookStage === null ||
      (typeof playbookStage === "string" &&
        AUTOMATION_PLAYBOOK_STAGES.includes(
          playbookStage as (typeof AUTOMATION_PLAYBOOK_STAGES)[number]
        ))
    )
  ) {
    return null;
  }
  const rawRetryBudget = remediation.retryBudget;
  const retryBudgetRecord = asJsonObject(rawRetryBudget);
  const retryBudget =
    rawRetryBudget !== null &&
    Number.isInteger(retryBudgetRecord.maximumAttempts) &&
    Number.isInteger(retryBudgetRecord.attemptsCompleted) &&
    Number.isInteger(retryBudgetRecord.attemptsRemaining) &&
    typeof retryBudgetRecord.exhausted === "boolean" &&
    (retryBudgetRecord.maximumAttempts as number) > 0 &&
    (retryBudgetRecord.attemptsCompleted as number) >= 0 &&
    (retryBudgetRecord.attemptsRemaining as number) >= 0 &&
    (retryBudgetRecord.attemptsRemaining as number) ===
      Math.max(
        0,
        (retryBudgetRecord.maximumAttempts as number) -
          (retryBudgetRecord.attemptsCompleted as number)
      ) &&
    retryBudgetRecord.exhausted ===
      (retryBudgetRecord.attemptsCompleted as number) >=
        (retryBudgetRecord.maximumAttempts as number)
      ? {
          maximumAttempts: retryBudgetRecord.maximumAttempts as number,
          attemptsCompleted: retryBudgetRecord.attemptsCompleted as number,
          attemptsRemaining: retryBudgetRecord.attemptsRemaining as number,
          exhausted: retryBudgetRecord.exhausted as boolean
        }
      : null;
  return {
    workMode: workMode as CourseSupportRemediationDirective["workMode"],
    strategyAction: strategyAction as MonitoringStrategyAction,
    playbookStage: playbookStage as AutomationPlaybookStage | null,
    allowUnchangedRuntime: remediation.allowUnchangedRuntime === true,
    requiresImplementationPath: remediation.requiresImplementationPath === true,
    reason: typeof remediation.reason === "string" ? remediation.reason : null,
    retryBudget
  };
}

export function readCourseSupportRemediationClaimAttempt(input: {
  summary: unknown;
  courseId: string;
  expectedAttemptCount: number;
}): CourseSupportRemediationClaimAttempt | null {
  const remediation = asJsonObject(asJsonObject(input.summary).remediation);
  if (
    !Array.isArray(remediation.attempts) ||
    remediation.attempts.length !== input.expectedAttemptCount ||
    input.expectedAttemptCount < 1
  ) {
    return null;
  }
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const matches = remediation.attempts.filter(
    (candidate) => asJsonObject(candidate).courseRef === courseRef
  );
  const courseRefs = remediation.attempts.map(
    (candidate) => asJsonObject(candidate).courseRef
  );
  const uniqueCourseRefs = new Set(courseRefs);
  if (
    matches.length !== 1 ||
    !courseRefs.every(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^[a-f0-9]{24}$/u.test(candidate)
    ) ||
    uniqueCourseRefs.size !== remediation.attempts.length
  ) {
    return null;
  }
  const attempt = asJsonObject(matches[0]);
  const approachRecord = asJsonObject(attempt.approach);
  const approach = parseCourseSupportRemediationApproach(attempt.approach);
  const actionPlan = parseCourseSupportClaimActionPlan(attempt.actionPlan);
  const providerContractEvidence =
    attempt.providerContractEvidence === undefined ||
    attempt.providerContractEvidence === null
      ? null
      : parseCourseSupportProviderContractEvidenceMarker(
          attempt.providerContractEvidence
        );
  const providerContractEvidenceAllowed = Boolean(
    approach?.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      approach.playbookStage === "BROWSER_ADAPTER_RETRY"
  );
  const exactApproachKeys = ["workMode", "strategyAction", "playbookStage"];
  if (
    typeof attempt.providerSnapshotFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(attempt.providerSnapshotFingerprint) ||
    typeof attempt.failureFingerprint !== "string" ||
    attempt.failureFingerprint.length < 1 ||
    attempt.failureFingerprint.length > 160 ||
    !Number.isSafeInteger(attempt.playbookEventCountAtClaim) ||
    (attempt.playbookEventCountAtClaim as number) < 0 ||
    !approach ||
    (providerContractEvidence !== null && !providerContractEvidenceAllowed) ||
    (attempt.providerContractEvidence !== undefined &&
      attempt.providerContractEvidence !== null &&
      !providerContractEvidence) ||
    (attempt.actionPlan !== undefined &&
      (!actionPlan ||
        !courseSupportActionPlanMatchesRoute({
          plan: actionPlan,
          workMode: approach.workMode,
          strategyAction: approach.strategyAction,
          playbookStage: approach.playbookStage
        }))) ||
    Object.keys(approachRecord).length !== exactApproachKeys.length ||
    !exactApproachKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(approachRecord, key)
    )
  ) {
    return null;
  }
  return {
    courseRef,
    providerSnapshotFingerprint: attempt.providerSnapshotFingerprint,
    failureFingerprint: attempt.failureFingerprint,
    playbookEventCountAtClaim: attempt.playbookEventCountAtClaim as number,
    approach,
    actionPlan,
    providerContractEvidence
  };
}

function assertCourseSupportImplementationVerificationReady(input: {
  summary: Prisma.JsonValue | null;
  baseSha: string;
  releaseSha: string | null;
  deployedAt: Date | null;
}) {
  const remediation = readCourseSupportRemediationDirective(input.summary);
  if (!remediation?.requiresImplementationPath) {
    return;
  }
  if (
    !hasStrictCourseSupportImplementationExecutionProof(input)
  ) {
    throw new Error(
      "This remediation route requires a runtime-bearing committed implementation path, a new release SHA, and deployment proof before verification."
    );
  }
}

export function hasStrictCourseSupportImplementationExecutionProof(input: {
  summary: Prisma.JsonValue | null;
  baseSha: string;
  releaseSha: string | null;
  deployedAt: Date | null;
}) {
  const releaseProvenance = readCourseSupportReleaseProvenance(input.summary);
  return Boolean(
    hasRuntimeBearingCourseSupportPath(readBatchPlannedPaths(input.summary)) &&
    input.releaseSha &&
    input.releaseSha !== input.baseSha &&
    input.deployedAt &&
    releaseProvenance &&
    releaseProvenance.toSha === input.releaseSha &&
    hasRuntimeBearingCourseSupportPath(releaseProvenance.committedPaths)
  );
}

export function hasCourseSupportImplementationExecutionProofIncludingHistory(input: {
  summary: Prisma.JsonValue | null;
  baseSha: string;
  releaseSha: string | null;
  deployedAt: Date | null;
}) {
  return Boolean(
    hasStrictCourseSupportImplementationExecutionProof(input) ||
    (hasRuntimeBearingCourseSupportPath(readBatchPlannedPaths(input.summary)) &&
      readCourseSupportReleaseExecutionEvidence({
        summary: input.summary,
        baseSha: input.baseSha
      }).changedReleaseDeploymentEver)
  );
}

function isAuthoritativeFactualCourseMonitoringState(
  state: CourseMonitoringState | null | undefined
) {
  return state === "FINAL_MANUAL" || state === "FINAL_IDENTITY";
}

function getAuthoritativeMonitoringStateForResolution(
  resolution: CourseSupportResolution | null | undefined
): CourseMonitoringState | null {
  switch (resolution) {
    case "MONITORING_RESTORED":
      return "HEALTHY";
    case "DIRECT_BOOKING_CLASSIFIED":
      return "FINAL_MANUAL";
    case "IDENTITY_CLASSIFIED":
      return "FINAL_IDENTITY";
    case "TECHNICAL_LIMITATION_CLASSIFIED":
    case "SOURCE_UNVERIFIED":
    case "HUMAN_VERIFIED_TECHNICAL_LIMITATION":
      return "FINAL_TECHNICAL";
    default:
      return null;
  }
}

function parseCourseSupportRemediationApproach(
  value: unknown
): CourseSupportRemediationAttemptSignature | null {
  const approach = asJsonObject(value);
  const workMode = approach.workMode;
  const strategyAction = approach.strategyAction;
  const playbookStage = approach.playbookStage;
  if (
    typeof workMode !== "string" ||
    workMode === "WAIT_FOR_MATERIAL_CHANGE" ||
    !COURSE_SUPPORT_REMEDIATION_WORK_MODES.includes(
      workMode as (typeof COURSE_SUPPORT_REMEDIATION_WORK_MODES)[number]
    ) ||
    typeof strategyAction !== "string" ||
    !MONITORING_STRATEGY_ACTIONS.includes(
      strategyAction as (typeof MONITORING_STRATEGY_ACTIONS)[number]
    ) ||
    !(
      playbookStage === null ||
      (typeof playbookStage === "string" &&
        AUTOMATION_PLAYBOOK_STAGES.includes(
          playbookStage as (typeof AUTOMATION_PLAYBOOK_STAGES)[number]
        ))
    )
  ) {
    return null;
  }
  return {
    workMode: workMode as ActionableCourseSupportRemediationWorkMode,
    strategyAction: strategyAction as MonitoringStrategyAction,
    playbookStage: playbookStage as AutomationPlaybookStage | null
  };
}

function countCourseSupportPlaybookEvents(input: { attemptLedger: unknown; cycle: number }) {
  return (
    parseAutomationPlaybookLedger(input.attemptLedger)?.events.filter(
      (event) => event.cycle === input.cycle
    ).length ?? 0
  );
}

function hasCourseSupportPlaybookAttemptSinceClaim(input: {
  attemptLedger: unknown;
  cycle: number;
  eventCountAtClaim: unknown;
  claimedAt: Date;
}) {
  const ledger = parseAutomationPlaybookLedger(input.attemptLedger);
  if (!ledger) {
    return false;
  }
  const currentCycleEvents = ledger.events.filter((event) => event.cycle === input.cycle);
  if (
    typeof input.eventCountAtClaim === "number" &&
    Number.isInteger(input.eventCountAtClaim) &&
    input.eventCountAtClaim >= 0
  ) {
    return currentCycleEvents.length > input.eventCountAtClaim;
  }
  return currentCycleEvents.some(
    (event) => new Date(event.observedAt).getTime() >= input.claimedAt.getTime()
  );
}

function hasCurrentCourseSupportProviderExecutionProof(input: {
  proofSnapshot: unknown;
  baseSha: string;
  releaseSha: string | null;
  claimedAt: Date;
  recheckDispatchStartedAt: Date | null;
}) {
  const proof = asJsonObject(input.proofSnapshot);
  const runtimeVersion =
    typeof proof.releaseSha === "string"
      ? proof.releaseSha
      : typeof proof.runtimeVersion === "string"
        ? proof.runtimeVersion
        : null;
  return Boolean(
    runtimeVersion === (input.releaseSha ?? input.baseSha) &&
    hasCourseSupportProviderExecutionAttemptEvidence(input),
  );
}

function hasCourseSupportProviderExecutionAttemptEvidence(input: {
  proofSnapshot: unknown;
  baseSha: string;
  releaseSha: string | null;
  claimedAt: Date;
  recheckDispatchStartedAt: Date | null;
}) {
  const proof = asJsonObject(input.proofSnapshot);
  const runtimeVersion =
    typeof proof.releaseSha === "string"
      ? proof.releaseSha
      : typeof proof.runtimeVersion === "string"
        ? proof.runtimeVersion
        : null;
  const expectedRuntimeVersion = input.releaseSha ?? input.baseSha;
  const observedAt = typeof proof.observedAt === "string" ? new Date(proof.observedAt) : null;
  const causalBoundary =
    input.recheckDispatchStartedAt ??
    (runtimeVersion === expectedRuntimeVersion ? input.claimedAt : null);
  return Boolean(
    proof.providerExecution === true &&
    observedAt &&
    Number.isFinite(observedAt.getTime()) &&
    causalBoundary &&
    observedAt.getTime() >= causalBoundary.getTime() &&
    observedAt.getTime() >= input.claimedAt.getTime()
  );
}

function hasDurableDetachedProviderExecutionEvidence(
  request: DetachedVerificationRequestState,
) {
  const evidence = asJsonObject(request.evidence);
  const observedAt =
    typeof evidence.observedAt === "string"
      ? new Date(evidence.observedAt)
      : null;
  return Boolean(
    request.startedAt &&
      (request.status === "SUCCEEDED" ||
        request.status === "RETRYABLE_FAILED" ||
        request.status === "STALE") &&
      request.runtimeVersion === request.releaseSha &&
      request.outcome &&
      evidence.providerExecution === true &&
      (evidence.kind === "PROVIDER_VERIFICATION" ||
        evidence.kind === "PROVIDER_VERIFICATION_FAILURE") &&
      evidence.runtimeVersion === request.runtimeVersion &&
      (evidence.releaseSha === undefined ||
        evidence.releaseSha === request.releaseSha) &&
      evidence.outcome === request.outcome &&
      evidence.failureClass === (request.failureClass ?? undefined) &&
      typeof request.providerSnapshotFingerprint === "string" &&
      evidence.providerSnapshotFingerprint ===
        request.providerSnapshotFingerprint &&
      observedAt &&
      Number.isFinite(observedAt.getTime()) &&
      observedAt.getTime() >= request.startedAt.getTime(),
  );
}

function isActiveDetachedVerificationRequest(
  request: DetachedVerificationRequestState,
) {
  return request.status === "QUEUED" || request.status === "CHECKING";
}

function canTreatDetachedVerificationRequestAsOrchestrationOnly(
  request: DetachedVerificationRequestState,
) {
  return (
    !isActiveDetachedVerificationRequest(request) &&
    (request.status === "SUCCEEDED" ||
      request.status === "RETRYABLE_FAILED" ||
      request.status === "STALE") &&
    !hasDurableDetachedProviderExecutionEvidence(request)
  );
}

function didCourseSupportCloseoutConsumeRemediationAttempt(input: {
  summary: unknown;
  courseId: string;
}) {
  const closeout = asJsonObject(asJsonObject(input.summary).closeout);
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const rawAttempt = Array.isArray(closeout.remediationAttempts)
    ? closeout.remediationAttempts.find((entry) => asJsonObject(entry).courseRef === courseRef)
    : null;
  const attempt = asJsonObject(rawAttempt);
  if (typeof attempt.consumed === "boolean") {
    return attempt.consumed;
  }
  // Backward compatibility for closeouts written before the per-course boolean
  // was persisted. Never infer execution from an outcome label or a claimed
  // path; only the durable technical evidence fields consume the route.
  const executionEvidence = asJsonObject(attempt.executionEvidence);
  return (
    executionEvidence.deploymentRecorded === true ||
    executionEvidence.providerAttemptRecorded === true ||
    executionEvidence.playbookAttemptRecorded === true ||
    executionEvidence.terminalResultRecorded === true
  );
}

function readPersistedCourseSupportRemediationAttemptRecord(input: {
  summary: unknown;
  courseId: string;
}): PersistedCourseSupportRemediationAttempt | null {
  const closeout = asJsonObject(asJsonObject(input.summary).closeout);
  if (!Array.isArray(closeout.remediationAttempts)) {
    return null;
  }
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const raw = closeout.remediationAttempts.find(
    (entry) => asJsonObject(entry).courseRef === courseRef
  );
  const record = asJsonObject(raw);
  const providerSnapshotFingerprint = record.providerSnapshotFingerprint;
  const failureFingerprint = record.failureFingerprint;
  const runtimeVersion = record.runtimeVersion;
  const activeRealSearchCount = record.activeRealSearchCount;
  if (
    typeof record.consumed !== "boolean" ||
    typeof providerSnapshotFingerprint !== "string" ||
    typeof failureFingerprint !== "string" ||
    typeof runtimeVersion !== "string" ||
    typeof activeRealSearchCount !== "number" ||
    !Number.isInteger(activeRealSearchCount) ||
    activeRealSearchCount < 0
  ) {
    return null;
  }
  const exactExecutionEvidence =
    readExactCourseSupportDecisionExecutionEvidenceShape(
      record.executionEvidence,
    );
  const persistedCountsTowardOperationalNoProgress =
    typeof record.countsTowardOperationalNoProgress === "boolean"
      ? record.countsTowardOperationalNoProgress
      : null;
  return {
    courseRef,
    providerSnapshotFingerprint,
    failureFingerprint,
    runtimeVersion,
    activeRealSearchCount,
    consumed: record.consumed,
    // `providerExecutionStarted` is the legacy name for PRE_EXECUTION request
    // attachment. It protects one-shot request admission, but it is not proof
    // that provider I/O ran and must not consume the operational no-progress
    // budget. Exact legacy records are normalized from durable execution proof;
    // malformed/older envelopes retain their conservative persisted tri-state.
    countsTowardOperationalNoProgress: exactExecutionEvidence
      ? record.consumed ||
        exactExecutionEvidence.providerExecutionAttemptRecorded
      : persistedCountsTowardOperationalNoProgress,
    approach: parseCourseSupportRemediationApproach(record.approach)
  };
}

function readPersistedCourseSupportRemediationAttempt(input: {
  summary: unknown;
  courseId: string;
}): PersistedCourseSupportRemediationAttempt | null {
  const attempt = readPersistedCourseSupportRemediationAttemptRecord(input);
  return attempt && attempt.consumed && didCourseSupportCloseoutConsumeRemediationAttempt(input)
    ? attempt
    : null;
}

function isSameCourseSupportRemediationApproach(
  left: CourseSupportRemediationAttemptSignature | null,
  right: CourseSupportRemediationAttemptSignature | null
) {
  return Boolean(
    left &&
    right &&
    left.workMode === right.workMode &&
    left.strategyAction === right.strategyAction &&
    left.playbookStage === right.playbookStage
  );
}

export function countCourseSupportOperationalNoProgressAttempts(input: {
  batchIncidents: Array<{ cycle: number;
    verificationRequests?: Array<{
      releaseSha: string;
      startedAt: Date | null;
    }>;
    batch: { summary: unknown; releaseSha?: string | null };
  }>;
  cycle: number;
  courseId: string;
  providerSnapshotFingerprint: string;
  failureFingerprint: string;
  approach: CourseSupportRemediationAttemptSignature | null;
  zeroExecutionRecoveryRecorded?: boolean;
}) {
  let count = 0;
  for (const entry of input.batchIncidents.filter((candidate) => candidate.cycle === input.cycle)) {
    const attempt = readPersistedCourseSupportRemediationAttemptRecord({
      summary: entry.batch.summary,
      courseId: input.courseId
    });
    if (
      !attempt ||
      attempt.consumed ||
      attempt.providerSnapshotFingerprint !== input.providerSnapshotFingerprint ||
      attempt.failureFingerprint !== input.failureFingerprint ||
      !isSameCourseSupportRemediationApproach(attempt.approach, input.approach)
    ) {
      break;
    }
    const legacyZeroExecutionRequest =
      attempt.countsTowardOperationalNoProgress === null &&
      (input.zeroExecutionRecoveryRecorded === true ||
        entry.verificationRequests?.some(
          (request) =>
            request.releaseSha === attempt.runtimeVersion &&
            request.startedAt === null,
        ));
    if (
      attempt.countsTowardOperationalNoProgress === false ||
      legacyZeroExecutionRequest
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

function hasValidatedZeroExecutionRecoveryMarker(
  cycle: number,
  events: readonly { audit: unknown }[] | undefined,
) {
  return Boolean(
    events?.some((event) => {
      const audit = asJsonObject(event.audit);
      return (
        audit.action === "parked_cohort_zero_execution_recovery" &&
        audit.cycle === cycle &&
        audit.sameCycleRecovery === true &&
        audit.oneShot === true &&
        typeof audit.campaignRunId === "string" &&
        typeof audit.campaignMembershipDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(audit.campaignMembershipDigest) &&
        typeof audit.zeroExecutionHistoryDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(audit.zeroExecutionHistoryDigest)
      );
    }),
  );
}

function hasCurrentCourseSupportTerminalExecutionProof(input: {
  result: CourseSupportBatchIncidentResult;
  proofSnapshot: unknown;
  verifiedAt: Date | null;
}) {
  if (
    !input.verifiedAt ||
    (input.result !== "RESTORED" && input.result !== "FINAL_DISPOSITION")
  ) {
    return false;
  }
  const proof = asJsonObject(input.proofSnapshot);
  return typeof proof.kind === "string";
}

function applyCourseSupportOperationalRetryBudget(input: {
  route: CourseSupportRemediationRoute;
  attemptsCompleted: number;
}) {
  if (
    input.route.workMode === "WAIT_FOR_MATERIAL_CHANGE" ||
    input.attemptsCompleted < COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET
  ) {
    return input.route;
  }
  return {
    ...input.route,
    workMode: "WAIT_FOR_MATERIAL_CHANGE" as const,
    resumeWorkMode: input.route.workMode,
    allowUnchangedRuntime: false,
    requiresImplementationPath: false,
    reason: "OPERATIONAL_RETRY_BUDGET_EXHAUSTED" as const
  } satisfies CourseSupportRemediationRoute;
}

export async function getCourseSupportBatchRecoveryProvenance(batchId: string) {
  const batch = await prisma.courseSupportBatch.findUnique({
    where: { id: batchId },
    select: { baseSha: true, releaseSha: true, summary: true }
  });
  if (!batch) {
    throw new Error("Course-support batch was not found.");
  }
  const summary = asJsonObject(batch.summary);
  const remediationDirective = readCourseSupportRemediationDirective(summary);
  return {
    baseSha: batch.baseSha,
    releaseSha: batch.releaseSha,
    branch: typeof summary.branch === "string" ? summary.branch : null,
    plannedPaths: Array.isArray(summary.plannedPaths)
      ? normalizePaths(
          summary.plannedPaths.filter((path): path is string => typeof path === "string")
        )
      : [],
    remediationDirective
  };
}

export function selectCourseSupportRetryBatch(input: {
  candidates: CourseSupportCandidate[];
  retryBatch: CourseSupportRetryBatchEvidence;
  retryOrdinal?: number;
  maxCourses?: number;
  now?: Date;
}): SelectedCourseSupportBatch {
  const now = input.now ?? new Date();
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);
  const retryBatch = input.retryBatch;
  const closeout = asJsonObject(retryBatch.summary).closeout;
  if (
    retryBatch.status !== "RETRYABLE_FAILED" ||
    !retryBatch.completedAt ||
    !closeout ||
    typeof closeout !== "object" ||
    Array.isArray(closeout)
  ) {
    throw new Error("A targeted responder retry must reference a durably closed retryable batch.");
  }
  if (retryBatch.incidents.length === 0) {
    throw new Error("A targeted responder retry has no incident evidence.");
  }
  if (retryBatch.incidents.length > COURSE_SUPPORT_BATCH_MAX_SIZE) {
    throw new Error(
      "A targeted responder retry exceeds the bounded batch size.",
    );
  }
  const scopedEntries = selectCourseSupportRetrySourceEntries({
    retryBatch,
    retryOrdinal: input.retryOrdinal,
    requestedMaxCourses: input.maxCourses
  });
  if (input.retryOrdinal === undefined && retryBatch.incidents.length > maxCourses) {
    throw new Error("The targeted responder retry exceeds the requested batch size.");
  }

  const seenIncidentKeys = new Set<string>();
  const seenCourseCycles = new Set<string>();
  for (const entry of retryBatch.incidents) {
    if (entry.result !== "RETRY_SCHEDULED") {
      throw new Error("A targeted responder retry contains non-retryable incident evidence.");
    }
    const latestBatchIncident = entry.incident.batchIncidents[0];
    if (
      !latestBatchIncident ||
      latestBatchIncident.id !== entry.id ||
      latestBatchIncident.cycle !== entry.cycle
    ) {
      throw new Error("The targeted responder retry was superseded by a later batch.");
    }
    const incidentKey = `${entry.incidentId}\u0000${entry.cycle}`;
    const courseCycle = `${entry.courseId}\u0000${entry.cycle}`;
    if (
      seenIncidentKeys.has(incidentKey) ||
      seenCourseCycles.has(courseCycle)
    ) {
      throw new Error(
        "A targeted responder retry contains duplicate incident evidence.",
      );
    }
    seenIncidentKeys.add(incidentKey);
    seenCourseCycles.add(courseCycle);
  }

  const selectedIncidents = scopedEntries.map((entry) => {
    const candidate = input.candidates.find(
      (current) =>
        current.id === entry.incidentId &&
        current.courseId === entry.courseId &&
        current.cycle === entry.cycle &&
        current.providerFamilyKey === retryBatch.providerFamilyKey &&
        current.failureFingerprint === retryBatch.failureFingerprint,
    );
    if (!candidate) {
      throw new Error(
        "The targeted responder retry is not currently due or its provenance changed.",
      );
    }
    if (
      !candidate.nextAttemptAt ||
      candidate.nextAttemptAt.getTime() <= retryBatch.completedAt!.getTime() ||
      candidate.nextAttemptAt.getTime() > now.getTime()
    ) {
      throw new Error(
        "The targeted responder retry does not have a current due retry schedule.",
      );
    }
    return candidate;
  });
  const selectedIncidentIds = new Set(
    selectedIncidents.map((incident) => incident.id),
  );
  if (
    input.candidates.some(
      (candidate) =>
        !selectedIncidentIds.has(candidate.id) &&
        isCriticalRealDemand(candidate, now),
    )
  ) {
    throw new Error(
      "A targeted responder retry cannot bypass due critical real-demand work.",
    );
  }
  const remediationDirective = selectedIncidents[0]?.remediationDirective;
  if (
    remediationDirective &&
    selectedIncidents.some(
      (candidate) =>
        JSON.stringify(candidate.remediationDirective) !==
        JSON.stringify(remediationDirective),
    )
  ) {
    throw new Error(
      "The targeted responder retry now requires a different remediation route.",
    );
  }
  const actionPlan = selectedIncidents[0]?.actionPlan;
  if (
    selectedIncidents.some(
      (candidate) =>
        JSON.stringify(candidate.actionPlan ?? null) !==
        JSON.stringify(actionPlan ?? null),
    )
  ) {
    throw new Error(
      "The targeted responder retry now requires a different claimed action contract.",
    );
  }

  return {
    providerFamilyKey: retryBatch.providerFamilyKey,
    failureFingerprint: retryBatch.failureFingerprint,
    incidents: selectedIncidents,
    fairnessReason: "TARGETED_RETRY",
    containsCriticalRealDemand: selectedIncidents.some((candidate) =>
      isCriticalRealDemand(candidate, now),
    ),
    ...(remediationDirective ? { remediationDirective } : {}),
  };
}

function selectCourseSupportRetrySourceEntries(input: {
  retryBatch: CourseSupportRetryBatchEvidence;
  retryOrdinal?: number;
  requestedMaxCourses?: number;
}) {
  if (input.retryOrdinal === undefined) {
    return input.retryBatch.incidents;
  }
  if (!Number.isInteger(input.retryOrdinal) || input.retryOrdinal < 1) {
    throw new Error(
      "A targeted responder retry ordinal must be a positive integer.",
    );
  }
  if (input.requestedMaxCourses !== 1) {
    throw new Error(
      "An exact-entry targeted responder retry requires maxCourses to be 1.",
    );
  }
  const entry = input.retryBatch.incidents[input.retryOrdinal - 1];
  if (!entry) {
    throw new Error("The targeted responder retry ordinal is out of range.");
  }
  return [entry];
}

export function computeCourseSupportNextAttemptAt(input: {
  failureClass: CourseSupportFailureClass;
  failureFingerprint: string;
  attemptCount: number;
  now?: Date;
  retryAfterSeconds?: number | null;
}) {
  const now = input.now ?? new Date();
  if (
    input.failureClass === "RATE_LIMIT" &&
    Number.isFinite(input.retryAfterSeconds) &&
    (input.retryAfterSeconds ?? 0) > 0
  ) {
    const boundedSeconds = Math.min(
      24 * 60 * 60,
      Math.max(60, Math.trunc(input.retryAfterSeconds ?? 0)),
    );
    return new Date(now.getTime() + boundedSeconds * 1000);
  }

  const attemptIndex = Math.max(0, input.attemptCount - 1);
  const ladder = [15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60];
  const baseSeconds = ladder[Math.min(attemptIndex, ladder.length - 1)];
  const jitter = deterministicJitter(
    `${input.failureFingerprint}:${input.attemptCount}`,
  );
  return new Date(now.getTime() + Math.round(baseSeconds * jitter) * 1000);
}

export function classifyFreshBatchEvidence(input: {
  batchCreatedAt: Date;
  deployedAt?: Date | null;
  releaseSha?: string | null;
  recheckDispatchStartedAt?: Date | null;
  preProbeId?: string | null;
  newestProbe?: FreshProbeEvidence | null;
  course: CourseSupportCourseEvidence;
  incidentFirstSeenAt?: Date | null;
  incidentLastSeenAt?: Date | null;
  now?: Date;
}): BatchIncidentVerification {
  const finalDisposition = getPersistedFinalDisposition(
    input.course,
    input.incidentFirstSeenAt ??
      input.incidentLastSeenAt ??
      input.batchCreatedAt,
    input.now ?? new Date(),
  );
  if (finalDisposition) {
    return {
      result: "FINAL_DISPOSITION",
      postProbeId: null,
      message: finalDisposition.message,
      proofSnapshot: finalDisposition.proofSnapshot,
    };
  }

  const releaseSha = input.releaseSha?.trim();
  const newestProbe = input.newestProbe;
  const notBefore = input.recheckDispatchStartedAt;
  const freshSearchCheckedAt =
    newestProbe?.freshSearchCheckedAt ?? newestProbe?.observedAt;
  const providerExecutionObservedAt = newestProbe
    ? getFreshProbeProviderObservedAt(newestProbe)
    : null;
  const providerEvidenceNotBefore = input.deployedAt ?? input.batchCreatedAt;
  const providerExecutionAttemptProof =
    input.releaseSha &&
    input.deployedAt &&
    notBefore &&
    newestProbe?.providerExecution &&
    freshSearchCheckedAt &&
    providerExecutionObservedAt &&
    freshSearchCheckedAt.getTime() >= notBefore.getTime() &&
    providerExecutionObservedAt.getTime() >=
      providerEvidenceNotBefore.getTime() &&
    providerExecutionObservedAt.getTime() >= notBefore.getTime() &&
    providerExecutionObservedAt.getTime() >=
      (input.incidentLastSeenAt?.getTime() ?? 0)
      ? buildProbeProofSnapshot(newestProbe)
      : null;
  if (
    !releaseSha ||
    !input.deployedAt ||
    !notBefore ||
    !newestProbe ||
    newestProbe.id === input.preProbeId ||
    !freshSearchCheckedAt ||
    !providerExecutionObservedAt ||
    freshSearchCheckedAt.getTime() < notBefore.getTime() ||
    providerExecutionObservedAt.getTime() <
      providerEvidenceNotBefore.getTime() ||
    providerExecutionObservedAt.getTime() < notBefore.getTime() ||
    providerExecutionObservedAt.getTime() <
      (input.incidentLastSeenAt?.getTime() ?? 0) ||
    newestProbe.runtimeVersion !== releaseSha ||
    !newestProbe.providerExecution
  ) {
    return {
      result: "STALE_EVIDENCE",
      postProbeId: newestProbe?.id ?? null,
      message:
        "No newest per-course workflow observation from the claimed release proves the remediation yet.",
      // A causally fresh provider attempt is operational evidence even when an
      // older runtime produced it. Keep it distinct from runnable proof: the
      // stale result still cannot restore monitoring.
      proofSnapshot: providerExecutionAttemptProof,
    };
  }

  if (
    newestProbe.runnableCoverageProven !== false &&
    SUCCESSFUL_PROBE_OUTCOMES.has(newestProbe.outcome)
  ) {
    return {
      result: "RESTORED",
      postProbeId: newestProbe.id,
      message:
        "The newest per-course workflow observation from the claimed release is runnable.",
      proofSnapshot: buildProbeProofSnapshot(newestProbe),
    };
  }

  return {
    result: "RETRY_SCHEDULED",
    postProbeId: newestProbe.id,
    message:
      "The newest per-course workflow observation from the claimed release is still not runnable.",
    proofSnapshot: buildProbeProofSnapshot(newestProbe),
  };
}

export function classifyDetachedVerificationEvidence(input: {
  proof: Awaited<
    ReturnType<typeof getEligibleCourseSupportVerificationProof>
  > | null;
  deployedAt?: Date | null;
  recheckDispatchStartedAt?: Date | null;
  incidentLastSeenAt: Date;
}): BatchIncidentVerification | null {
  if (!input.proof?.eligible) {
    return null;
  }
  const evidence = asJsonObject(input.proof.evidence);
  const observedAt = parseProofDate(evidence.observedAt);
  const completedAt = input.proof.completedAt;
  if (evidence.kind === "PLAYBOOK_FACTUAL_FINAL") {
    const current = Boolean(
      input.deployedAt &&
      input.recheckDispatchStartedAt &&
      observedAt &&
      evidence.runtimeVersion === input.proof.releaseSha &&
      evidence.releaseSha === input.proof.releaseSha &&
      evidence.outcome === input.proof.outcome &&
      (evidence.disposition === "MANUAL_DIRECT" ||
        evidence.disposition === "IDENTITY_FINAL") &&
      observedAt.getTime() >= input.deployedAt.getTime() &&
      observedAt.getTime() >= input.recheckDispatchStartedAt.getTime() &&
      completedAt.getTime() >= observedAt.getTime(),
    );
    return {
      result: current ? "FINAL_DISPOSITION" : "STALE_EVIDENCE",
      postProbeId: null,
      message: current
        ? evidence.disposition === "IDENTITY_FINAL"
          ? "Current ordered public-page evidence supports a final course identity disposition."
          : "Current ordered public-page evidence supports a final direct-course disposition."
        : "The ordered factual-final evidence is not current for this responder release.",
      proofSnapshot: evidence as Prisma.InputJsonObject,
    };
  }
  const current = Boolean(
    input.deployedAt &&
    input.recheckDispatchStartedAt &&
    observedAt &&
    evidence.kind === "PROVIDER_VERIFICATION" &&
    evidence.providerExecution === true &&
    evidence.runtimeVersion === input.proof.releaseSha &&
    evidence.outcome === input.proof.outcome &&
    observedAt.getTime() >= input.deployedAt.getTime() &&
    observedAt.getTime() >= input.recheckDispatchStartedAt.getTime() &&
    observedAt.getTime() >= input.incidentLastSeenAt.getTime() &&
    completedAt.getTime() >= observedAt.getTime(),
  );
  const proofSnapshot = {
    kind: "PROVIDER_VERIFICATION",
    outcome: input.proof.outcome,
    observedAt: observedAt?.toISOString() ?? null,
    completedAt: completedAt.toISOString(),
    runtimeVersion: input.proof.runtimeVersion,
    providerExecution: evidence.providerExecution === true,
    providerSnapshotFingerprint: input.proof.providerSnapshotFingerprint,
  } satisfies Prisma.InputJsonObject;

  if (current && SUCCESSFUL_PROBE_OUTCOMES.has(input.proof.outcome)) {
    return {
      result: "RESTORED",
      postProbeId: null,
      message:
        "A current exact-runtime provider verification completed without customer search or delivery side effects.",
      proofSnapshot,
    };
  }
  return {
    result: current ? "RETRY_SCHEDULED" : "STALE_EVIDENCE",
    postProbeId: null,
    message: current
      ? "The exact-runtime provider verification did not prove runnable monitoring."
      : "No current exact-runtime detached provider verification proves the remediation yet.",
    proofSnapshot,
  };
}

export function classifyDetachedVerificationFailure(input: {
  failure: Awaited<
    ReturnType<typeof getCurrentCourseSupportVerificationFailure>
  > | null;
  deployedAt?: Date | null;
  recheckDispatchStartedAt?: Date | null;
  incidentLastSeenAt: Date;
}): BatchIncidentVerification | null {
  if (!input.failure?.current) {
    return null;
  }
  const current = Boolean(
    input.deployedAt &&
    input.recheckDispatchStartedAt &&
    input.failure.runtimeVersion === input.failure.releaseSha &&
    input.failure.observedAt.getTime() >= input.deployedAt.getTime() &&
    input.failure.observedAt.getTime() >=
      input.recheckDispatchStartedAt.getTime() &&
    input.failure.observedAt.getTime() >= input.incidentLastSeenAt.getTime(),
  );
  if (!current) {
    return null;
  }
  return {
    result: "RETRY_SCHEDULED",
    postProbeId: null,
    message:
      "The current exact-runtime detached provider verification remains non-runnable.",
    proofSnapshot: {
      kind: "PROVIDER_VERIFICATION_FAILURE",
      status: input.failure.status,
      outcome: input.failure.outcome,
      failureClass: input.failure.failureClass,
      observedAt: input.failure.observedAt.toISOString(),
      completedAt: input.failure.completedAt?.toISOString() ?? null,
      nextAttemptAt: input.failure.nextAttemptAt?.toISOString() ?? null,
      providerRetryNotBeforeAt:
        input.failure.providerRetryNotBeforeAt?.toISOString() ?? null,
      runtimeVersion: input.failure.runtimeVersion,
      providerExecution: input.failure.providerExecution,
      providerSnapshotFingerprint: input.failure.providerSnapshotFingerprint,
    } satisfies Prisma.InputJsonObject,
  };
}

export function chooseNewestProviderVerificationEvidence(input: {
  workflow: BatchIncidentVerification | null;
  detachedVerification: BatchIncidentVerification | null;
  detachedFailure: BatchIncidentVerification | null;
}) {
  const candidates = [
    toCurrentProviderEvidenceCandidate("WORKFLOW", input.workflow),
    toCurrentProviderEvidenceCandidate(
      "DETACHED_VERIFICATION",
      input.detachedVerification,
    ),
    toCurrentProviderEvidenceCandidate(
      "DETACHED_FAILURE",
      input.detachedFailure,
    ),
  ].filter(
    (
      candidate,
    ): candidate is NonNullable<
      ReturnType<typeof toCurrentProviderEvidenceCandidate>
    > => candidate !== null,
  );

  candidates.sort((left, right) => {
    const observedAtOrder =
      right.observedAt.getTime() - left.observedAt.getTime();
    if (observedAtOrder !== 0) {
      return observedAtOrder;
    }

    const safetyOrder =
      Number(right.verification.result !== "RESTORED") -
      Number(left.verification.result !== "RESTORED");
    if (safetyOrder !== 0) {
      return safetyOrder;
    }

    return (
      CURRENT_PROVIDER_EVIDENCE_TIE_PRIORITY[right.source] -
      CURRENT_PROVIDER_EVIDENCE_TIE_PRIORITY[left.source]
    );
  });

  return candidates[0]?.verification ?? null;
}

function toCurrentProviderEvidenceCandidate(
  source: CurrentProviderEvidenceSource,
  verification: BatchIncidentVerification | null,
) {
  if (
    !verification ||
    (verification.result !== "RESTORED" &&
      verification.result !== "RETRY_SCHEDULED")
  ) {
    return null;
  }
  const proof = asJsonObject(
    verification.proofSnapshot as Prisma.JsonValue | null,
  );
  const observedAt = parseProofDate(proof.observedAt);
  if (proof.kind !== CURRENT_PROVIDER_EVIDENCE_KIND[source] || !observedAt) {
    return null;
  }
  return { source, verification, observedAt };
}

export function preserveExplicitHumanVerification(input: {
  result: CourseSupportBatchIncidentResult;
  engineeringOnly: boolean;
  postProbeId?: string | null;
  message?: string | null;
}): BatchIncidentVerification | null {
  if (input.result !== "NEEDS_HUMAN") {
    return null;
  }
  return {
    result: "NEEDS_HUMAN",
    postProbeId: input.postProbeId ?? null,
    message:
      input.message ??
      "A concrete external action remains required after safe automated work.",
    proofSnapshot: null,
  };
}

export function classifyCourseSupportQueueInspection(input: {
  hasActiveBatch: boolean;
  activeBatchCount?: number;
  maxActiveBatches?: number;
  activeBatchOwnerThreadId?: string | null;
  requestingThreadId?: string | null;
  hasExpiredBatch: boolean;
  dueIncidentCount: number;
}): ResponderOutcome {
  if (
    input.hasActiveBatch &&
    input.requestingThreadId &&
    input.activeBatchOwnerThreadId === input.requestingThreadId
  ) {
    return "resume_owned_work";
  }
  const activeBatchCount =
    input.activeBatchCount ?? (input.hasActiveBatch ? 1 : 0);
  const maxActiveBatches = input.maxActiveBatches ?? 1;
  if (activeBatchCount >= maxActiveBatches) {
    return "deferred_busy";
  }
  if (input.hasExpiredBatch) {
    return "recovery_required";
  }
  if (input.dueIncidentCount > 0) {
    return "ready";
  }
  if (input.dueIncidentCount === 0) {
    return "no_due_work";
  }
  return "ready";
}

export type CourseSupportResponderHandoff =
  | {
      action: "RECOVER";
      source: "EXPIRED_BATCH";
    }
  | {
      action: "RESUME";
      source: "OWNED_BATCH";
    }
  | {
      action: "CLAIM";
      source: "ORDINARY_DISPATCH" | "PARKED_CAMPAIGN";
      maxCourses: 5;
      selection: "ATOMIC_SERVER_SIDE";
    }
  | {
      action: "STOP";
      source: "NO_ACTIONABLE_WORK" | "WRITER_CAPACITY";
    };

const COURSE_SUPPORT_RECENT_FAIRNESS_BATCH_SELECT = {
  id: true,
  completedAt: true,
  revision: true,
  summary: true,
  incidents: {
    select: {
      incident: {
        select: {
          engineeringOnly: true,
          activeRealSearchCount: true,
          kind: true,
          earliestTargetDate: true,
        },
      },
    },
  },
} satisfies Prisma.CourseSupportBatchSelect;

type CourseSupportRecentFairnessBatch =
  Prisma.CourseSupportBatchGetPayload<{
    select: typeof COURSE_SUPPORT_RECENT_FAIRNESS_BATCH_SELECT;
  }>;

function buildCourseSupportRecentFairnessEvidence(
  batches: readonly CourseSupportRecentFairnessBatch[],
  now: Date
): RecentBatchFairnessEvidence[] {
  return batches.map((batch) => ({
    includedEngineeringOnly: batch.incidents.some(
      (entry) => entry.incident.engineeringOnly
    ),
    includedCriticalRealDemand: batch.incidents.some((entry) =>
      isHistoricalCriticalRealDemand(entry.incident, now)
    ),
    campaignSummaryState: classifyCourseSupportCampaignSummary(batch.summary),
  }));
}

function buildCourseSupportFairnessHistoryFence(
  batches: readonly CourseSupportRecentFairnessBatch[],
  now: Date,
) {
  const evidence = buildCourseSupportRecentFairnessEvidence(batches, now);
  return batches.map((batch, index) => ({
    id: batch.id,
    completedAt: batch.completedAt?.toISOString() ?? null,
    revision: batch.revision,
    ...evidence[index],
  }));
}

export function buildCourseSupportResponderHandoff(input: {
  outcome: ResponderOutcome;
  hasExpiredBatch: boolean;
  ownedByCurrentTask: boolean;
  availableWriterSlots: number;
  ordinaryDispatchGroupCount: number;
  parkedCampaign: { status: string; readyCount: number } | null;
  hasCurrentActiveRealDemand?: boolean;
  activeBatchCampaignSummaryStates?: readonly CourseSupportCampaignSummaryState[];
  recentBatches?: RecentBatchFairnessEvidence[];
}): CourseSupportResponderHandoff {
  if (input.hasExpiredBatch && input.availableWriterSlots > 0) {
    return { action: "RECOVER", source: "EXPIRED_BATCH" };
  }
  if (input.ownedByCurrentTask) {
    return { action: "RESUME", source: "OWNED_BATCH" };
  }
  const admissionLane =
    input.outcome === "ready" && input.availableWriterSlots > 0
      ? selectCourseSupportAdmissionLane({
          priorityCandidateAvailable: input.ordinaryDispatchGroupCount > 0,
          requestlessParkedCampaignAvailable: Boolean(
            input.parkedCampaign?.status === "RUNNING" &&
              input.parkedCampaign.readyCount > 0
          ),
          hasCurrentActiveRealDemand:
            input.hasCurrentActiveRealDemand === true,
          activeBatchCampaignSummaryStates:
            input.activeBatchCampaignSummaryStates,
          recentBatches: input.recentBatches
        })
      : null;
  if (admissionLane) {
    return {
      action: "CLAIM",
      source:
        admissionLane.lane === "REQUESTLESS_PARKED_CAMPAIGN"
          ? "PARKED_CAMPAIGN"
          : "ORDINARY_DISPATCH",
      maxCourses: 5,
      selection: "ATOMIC_SERVER_SIDE",
    };
  }
  return {
    action: "STOP",
    source:
      input.availableWriterSlots <= 0
        ? "WRITER_CAPACITY"
        : "NO_ACTIONABLE_WORK",
  };
}

type SourceUnverifiedBrowserDiscovery = {
  status: string;
  detectedPlatform?: string | null;
  bookingUrl?: string | null;
  apiMetadata?: unknown;
  confidence: number;
  evidence: unknown;
  createdAt: Date;
};

type SourceUnverifiedProviderSnapshot = Parameters<
  typeof buildCourseSupportProviderSnapshotFingerprint
>[0];

type SourceUnverifiedCourse = Parameters<typeof resolveProviderCapability>[0] &
  Partial<SourceUnverifiedProviderSnapshot> & {
  automationDiscoveries?: readonly SourceUnverifiedBrowserDiscovery[];
};

type SourceUnverifiedFinalizationInput = {
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  course: SourceUnverifiedCourse;
  attemptCount: number;
  activeRealSearchCount: number;
  firstSeenAt: Date;
  freshCycleStartedAt: Date | null;
  attemptLedger: unknown;
  cycle: number;
  verifiedAt: Date | null;
  verifiedIncidentUpdatedAt: Date | null;
  incidentUpdatedAt: Date;
  result: CourseSupportBatchIncidentResult;
  releaseSha?: string | null;
  deployedAt?: Date | null;
  now?: Date;
};

type SourceUnverifiedFinalizationEvidence =
  | {
      mode: "PLAYBOOK_SOURCE_GAP";
      evidenceStartedAt: Date;
    }
  | {
      mode: "INDEPENDENT_BROWSER_SOURCE_CONFLICT";
      evidenceStartedAt: Date;
      renderedObservedAt: Date;
      independentObservedAt: Date;
      providerSnapshotFingerprint: string;
    };

export function shouldFinalizeSourceUnverified(
  input: SourceUnverifiedFinalizationInput,
) {
  return getSourceUnverifiedFinalizationEvidence(input) !== null;
}

export function hasExactRuntimeBrowserProviderExecutionEvidence(input: {
  attemptLedger: unknown;
  cycle: number;
  claimedAt: Date;
  deployedAt: Date | null;
  releaseSha: string | null;
}) {
  if (
    !input.releaseSha ||
    !/^[a-f0-9]{40}$/iu.test(input.releaseSha) ||
    !(input.deployedAt instanceof Date) ||
    !Number.isFinite(input.deployedAt.getTime())
  ) {
    return false;
  }
  const ledger = parseAutomationPlaybookLedger(input.attemptLedger);
  return Boolean(
    ledger?.events.some((event) => {
      if (
        event.cycle !== input.cycle ||
        event.providerExecution !== true ||
        event.runtimeVersion !== input.releaseSha ||
        (event.stage !== "RENDERED_BROWSER_DISCOVERY" &&
          event.stage !== "INDEPENDENT_CONFIRMATION")
      ) {
        return false;
      }
      const observedAt = new Date(event.observedAt);
      return (
        Number.isFinite(observedAt.getTime()) &&
        observedAt.getTime() >= input.claimedAt.getTime() &&
        observedAt.getTime() >= input.deployedAt!.getTime()
      );
    }),
  );
}

export function shouldStartFreshExactRuntimeSourceCycle(input: {
  failureClass: CourseSupportFailureClass;
  attemptLedger: unknown;
  cycle: number;
  result: CourseSupportBatchIncidentResult;
  claimedAt: Date;
  deployedAt: Date | null;
  releaseSha: string | null;
  verifiedAt: Date | null;
  verifiedIncidentUpdatedAt: Date | null;
  incidentUpdatedAt: Date;
}) {
  if (
    (input.failureClass !== "MISSING_METADATA" &&
      input.failureClass !== "UNSUPPORTED_FAMILY") ||
    (input.result !== "NEEDS_HUMAN" &&
      input.result !== "RETRY_SCHEDULED" &&
      input.result !== "STALE_EVIDENCE") ||
    !input.verifiedAt ||
    !input.verifiedIncidentUpdatedAt ||
    input.verifiedIncidentUpdatedAt.getTime() !==
      input.incidentUpdatedAt.getTime() ||
    !hasExactRuntimeBrowserProviderExecutionEvidence(input)
  ) {
    return false;
  }
  const ledger = parseAutomationPlaybookLedger(input.attemptLedger);
  const playbook = assessAutomationPlaybook(input.attemptLedger, input.cycle);
  if (
    !ledger ||
    !playbook.valid ||
    playbook.cycle !== input.cycle ||
    playbook.conclusion !== "UNRESOLVED_EXHAUSTED" ||
    playbook.completedStages.length !== AUTOMATION_PLAYBOOK_STAGES.length ||
    !input.releaseSha
  ) {
    return false;
  }
  const terminalBrowserEvent = (
    stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION",
  ) =>
    [...ledger.events]
      .reverse()
      .find(
        (event) =>
          event.cycle === input.cycle &&
          event.stage === stage &&
          event.transition !== "STARTED" &&
          event.transition !== "FAILED_RETRYABLE",
      ) ?? null;
  const rendered = terminalBrowserEvent("RENDERED_BROWSER_DISCOVERY");
  const independent = terminalBrowserEvent("INDEPENDENT_CONFIRMATION");
  if (!rendered || !independent) {
    return false;
  }
  const latestBrowserObservedAt = Math.max(
    new Date(rendered.observedAt).getTime(),
    new Date(independent.observedAt).getTime(),
  );
  return Boolean(
    Number.isFinite(latestBrowserObservedAt) &&
      latestBrowserObservedAt <= input.verifiedAt.getTime() &&
      (rendered.runtimeVersion === input.releaseSha ||
        independent.runtimeVersion === input.releaseSha) &&
      (rendered.runtimeVersion !== input.releaseSha ||
        independent.runtimeVersion !== input.releaseSha),
  );
}

function getSourceUnverifiedFinalizationEvidence(
  input: SourceUnverifiedFinalizationInput,
): SourceUnverifiedFinalizationEvidence | null {
  if (
    !input.verifiedIncidentUpdatedAt ||
    input.verifiedIncidentUpdatedAt.getTime() !==
      input.incidentUpdatedAt.getTime()
  ) {
    return null;
  }
  if (hasFreshCompleteSourceUnverifiedEvidence(input)) {
    return {
      mode: "PLAYBOOK_SOURCE_GAP",
      evidenceStartedAt: input.freshCycleStartedAt!,
    };
  }
  return getIndependentBrowserSourceConflictEvidence(input);
}

function hasFreshCompleteSourceUnverifiedEvidence(input: {
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  course: Parameters<typeof resolveProviderCapability>[0];
  freshCycleStartedAt: Date | null;
  attemptLedger: unknown;
  cycle: number;
  verifiedAt: Date | null;
  result: CourseSupportBatchIncidentResult;
}) {
  const playbook = assessAutomationPlaybook(input.attemptLedger, input.cycle);
  const freshPlaybookComplete = Boolean(
    input.freshCycleStartedAt &&
    playbook.valid &&
    playbook.cycle === input.cycle &&
    playbook.conclusion === "UNRESOLVED_EXHAUSTED" &&
    playbook.completedStages.length === AUTOMATION_PLAYBOOK_STAGES.length &&
    hasDurableSourceUnverifiedPlaybookEvidence(
      playbook,
      input.freshCycleStartedAt,
    ),
  );
  const exactSourceMissingState = hasExactSourceMissingProviderState({
    incidentProviderFamilyKey: input.providerFamilyKey,
    course: input.course,
  });
  const latestCompletedStageAt =
    getLatestCompletedAutomationPlaybookStageTimestamp(playbook);
  return Boolean(
    (input.result === "RETRY_SCHEDULED" ||
      input.result === "STALE_EVIDENCE") &&
    freshPlaybookComplete &&
    input.verifiedAt &&
    latestCompletedStageAt !== null &&
    input.verifiedAt.getTime() >= latestCompletedStageAt &&
    (exactSourceMissingState ||
      (input.providerFamilyKey === SOURCE_CONFLICT_PROVIDER_FAMILY &&
        input.failureClass === "MISSING_METADATA")),
  );
}

function getIndependentBrowserSourceConflictEvidence(
  input: SourceUnverifiedFinalizationInput,
): Extract<
  SourceUnverifiedFinalizationEvidence,
  { mode: "INDEPENDENT_BROWSER_SOURCE_CONFLICT" }
> | null {
  const evidenceStartedAt =
    input.freshCycleStartedAt ?? (input.cycle === 1 ? input.firstSeenAt : null);
  const releaseSha = input.releaseSha;
  const deployedAt = input.deployedAt;
  if (
    input.failureClass !== "UNSUPPORTED_FAMILY" ||
    (input.result !== "RETRY_SCHEDULED" && input.result !== "STALE_EVIDENCE") ||
    !evidenceStartedAt ||
    !releaseSha ||
    !/^[a-f0-9]{40}$/iu.test(releaseSha) ||
    !(deployedAt instanceof Date) ||
    !Number.isFinite(deployedAt.getTime()) ||
    !input.verifiedAt
  ) {
    return null;
  }

  const playbook = assessAutomationPlaybook(input.attemptLedger, input.cycle);
  const latestCompletedStageAt =
    getLatestCompletedAutomationPlaybookStageTimestamp(playbook);
  if (
    !playbook.valid ||
    playbook.cycle !== input.cycle ||
    playbook.conclusion !== "UNRESOLVED_EXHAUSTED" ||
    playbook.completedStages.length !== AUTOMATION_PLAYBOOK_STAGES.length ||
    latestCompletedStageAt === null ||
    input.verifiedAt.getTime() < latestCompletedStageAt ||
    !hasDurableSourceUnverifiedPlaybookEvidence(playbook, evidenceStartedAt)
  ) {
    return null;
  }

  if (!hasSourceUnverifiedProviderSnapshot(input.course)) {
    return null;
  }
  const providerResolution = resolveProviderCapability(input.course);
  if (
    providerResolution.capability ||
    providerResolution.providerFamilyKey !== input.providerFamilyKey ||
    input.course.bookingMethod !== "UNKNOWN" ||
    (input.course.bookingAccessMode !== undefined &&
      input.course.bookingAccessMode !== null &&
      input.course.bookingAccessMode !== "UNKNOWN") ||
    (input.course.automationEligibility !== "UNKNOWN" &&
      input.course.automationEligibility !== "NEEDS_REVIEW") ||
    (input.course.automationReason !== "NONE" &&
      input.course.automationReason !== "UNSUPPORTED_PLATFORM")
  ) {
    return null;
  }
  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(input.course);
  if (!/^[a-f0-9]{64}$/iu.test(providerSnapshotFingerprint)) {
    return null;
  }
  const observations = (input.course.automationDiscoveries ?? [])
    .map((discovery) =>
      readIndependentBrowserSourceConflictObservation({
        discovery,
        incidentCycle: input.cycle,
        releaseSha,
        deployedAt,
        evidenceStartedAt,
        verifiedAt: input.verifiedAt!,
        providerSnapshotFingerprint,
      }),
    )
    .filter(
      (
        observation,
      ): observation is {
        mode: "RENDERED" | "INDEPENDENT";
        observedAt: Date;
      } => observation !== null,
    );
  const rendered = observations.find(
    (observation) => observation.mode === "RENDERED",
  );
  const independent = observations.find(
    (observation) => observation.mode === "INDEPENDENT",
  );
  if (
    !rendered ||
    !independent ||
    rendered.observedAt.getTime() === independent.observedAt.getTime()
  ) {
    return null;
  }
  return {
    mode: "INDEPENDENT_BROWSER_SOURCE_CONFLICT",
    evidenceStartedAt,
    renderedObservedAt: rendered.observedAt,
    independentObservedAt: independent.observedAt,
    providerSnapshotFingerprint,
  };
}

function hasSourceUnverifiedProviderSnapshot(
  course: SourceUnverifiedCourse,
): course is SourceUnverifiedCourse & SourceUnverifiedProviderSnapshot {
  return Boolean(
    course.detectedPlatform &&
      course.bookingMethod &&
      course.automationEligibility &&
      course.automationReason,
  );
}

function readIndependentBrowserSourceConflictObservation(input: {
  discovery: SourceUnverifiedBrowserDiscovery;
  incidentCycle: number;
  releaseSha: string;
  deployedAt: Date;
  evidenceStartedAt: Date;
  verifiedAt: Date;
  providerSnapshotFingerprint: string;
}) {
  const evidence = asJsonObject(input.discovery.evidence as Prisma.JsonValue);
  const browser = asJsonObject(
    evidence.browserInvestigation as Prisma.JsonValue,
  );
  const authority = asJsonObject(browser.identityAuthority as Prisma.JsonValue);
  const observedAt = parseProofDate(browser.observedAt);
  const pages = Array.isArray(browser.sameOriginPages)
    ? browser.sameOriginPages.map((page) =>
        asJsonObject(page as Prisma.JsonValue),
      )
    : [];
  const bookingDestinations = Array.isArray(browser.bookingDestinations)
    ? browser.bookingDestinations
    : [];
  const networkContracts = Array.isArray(browser.networkContracts)
    ? browser.networkContracts
    : [];
  const accessBarriers = Array.isArray(evidence.accessBarriers)
    ? evidence.accessBarriers
    : [];
  const renderedAccessControls = Array.isArray(evidence.renderedAccessControls)
    ? evidence.renderedAccessControls
    : [];
  const mode =
    browser.mode === "RENDERED" || browser.mode === "INDEPENDENT"
      ? browser.mode
      : null;
  if (
    input.discovery.status !== "INSPECTED" ||
    input.discovery.detectedPlatform !== "UNKNOWN" ||
    (input.discovery.apiMetadata !== null &&
      input.discovery.apiMetadata !== undefined) ||
    !Number.isFinite(input.discovery.confidence) ||
    input.discovery.confidence >= 0.8 ||
    evidence.bookingCallToAction === true ||
    Object.keys(
      asJsonObject(evidence.courseIdentityCorroboration as Prisma.JsonValue),
    ).length > 0 ||
    evidence.learnedFrom !== "browser-visible-links" ||
    !mode ||
    browser.incidentCycle !== input.incidentCycle ||
    browser.runtimeVersion !== input.releaseSha ||
    browser.providerSnapshotFingerprint !== input.providerSnapshotFingerprint ||
    browser.restrictedNetworkObserved !== true ||
    authority.source === "UNPROJECTED_OWNER_SOURCE_CANDIDATE" ||
    (authority.source !== "RETAINED_OFFICIAL_WEBSITE" &&
      authority.source !== "RETAINED_COURSE_SOURCE") ||
    authority.localityEvidencePresent !== true ||
    authority.placeEvidencePresent !== true ||
    pages.length === 0 ||
    pages.some(
      (page) =>
        page.identityStatus !== "CONFLICT" ||
        page.trustedForCourse !== false ||
        page.interactionBlocked !== false,
    ) ||
    bookingDestinations.length !== 0 ||
    networkContracts.length !== 0 ||
    accessBarriers.length !== 0 ||
    renderedAccessControls.length !== 0 ||
    !observedAt ||
    Math.abs(input.discovery.createdAt.getTime() - observedAt.getTime()) >
      1_000 ||
    observedAt.getTime() < input.deployedAt.getTime() ||
    observedAt.getTime() < input.evidenceStartedAt.getTime() ||
    observedAt.getTime() > input.verifiedAt.getTime()
  ) {
    return null;
  }
  return { mode, observedAt };
}

function hasExactSourceMissingProviderState(input: {
  incidentProviderFamilyKey: string;
  course: Parameters<typeof resolveProviderCapability>[0] | null | undefined;
}) {
  return Boolean(
    input.incidentProviderFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
    isExactSourceMissingProviderState(input.course),
  );
}

function hasDurableSourceUnverifiedPlaybookEvidence(
  playbook: ReturnType<typeof assessAutomationPlaybook>,
  freshCycleStartedAt: Date,
) {
  const officialIdentity = playbook.stages.find(
    (stage) => stage.stage === "OFFICIAL_IDENTITY",
  );
  const independentConfirmation = playbook.stages.find(
    (stage) => stage.stage === "INDEPENDENT_CONFIRMATION",
  );
  return Boolean(
    officialIdentity?.applicability === "APPLICABLE" &&
    officialIdentity.attemptCount > 0 &&
    officialIdentity.completedAt &&
    new Date(officialIdentity.completedAt).getTime() >=
      freshCycleStartedAt.getTime() &&
    independentConfirmation?.applicability === "APPLICABLE" &&
    independentConfirmation.attemptCount > 0 &&
    independentConfirmation.completedAt &&
    playbook.stages.every(
      (stage) =>
        stage.completedAt &&
        new Date(stage.completedAt).getTime() >=
          freshCycleStartedAt.getTime() &&
        (stage.applicability !== "APPLICABLE" || stage.attemptCount > 0),
    ),
  );
}

function getLatestCompletedAutomationPlaybookStageTimestamp(
  playbook: ReturnType<typeof assessAutomationPlaybook>,
) {
  const completedStageTimestamps = playbook.stages.map((stage) =>
    stage.completedAt ? new Date(stage.completedAt).getTime() : Number.NaN,
  );
  return completedStageTimestamps.length === AUTOMATION_PLAYBOOK_STAGES.length &&
    completedStageTimestamps.every((timestamp) => Number.isFinite(timestamp))
    ? Math.max(...completedStageTimestamps)
    : null;
}

export function assessCourseSupportRecovery(input: {
  leaseExpiresAt: Date;
  ownerThreadId: string | null;
  requestingThreadId: string;
  baseSha: string;
  releaseSha: string | null;
  expectedBranch: string | null;
  currentBranch: string;
  currentHeadSha: string;
  plannedPaths: string[];
  dirtyPaths: string[];
  baseIsAncestor?: boolean;
  committedPaths?: string[];
  releaseIsAncestor?: boolean;
  releaseCommittedPaths?: string[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  if (input.leaseExpiresAt.getTime() > now.getTime()) {
    reasons.push("The prior responder lease is still active.");
  }
  if (input.expectedBranch && input.currentBranch !== input.expectedBranch) {
    reasons.push("The checkout branch does not match the batch provenance.");
  }
  const expectedHead = input.releaseSha ?? input.baseSha;
  if (input.currentHeadSha !== expectedHead) {
    const committedPaths = input.releaseSha
      ? (input.releaseCommittedPaths ?? [])
      : (input.committedPaths ?? []);
    const safelyCommittedPlannedChange =
      input.baseIsAncestor === true &&
      (!input.releaseSha || input.releaseIsAncestor === true) &&
      committedPaths.length > 0 &&
      committedPaths.every((path) => input.plannedPaths.includes(path));
    if (!safelyCommittedPlannedChange) {
      reasons.push("The checkout HEAD does not match the batch provenance.");
    }
    if (
      input.releaseSha &&
      safelyCommittedPlannedChange &&
      input.ownerThreadId !== input.requestingThreadId
    ) {
      reasons.push(
        "A different task cannot adopt a committed follow-up release.",
      );
    }
  }
  const plannedPaths = new Set(input.plannedPaths);
  const unplannedDirtyPaths = input.dirtyPaths.filter(
    (path) => !plannedPaths.has(path),
  );
  if (unplannedDirtyPaths.length > 0) {
    reasons.push(
      `Dirty paths are outside the batch plan: ${unplannedDirtyPaths.join(", ")}`,
    );
  }
  if (
    input.dirtyPaths.length > 0 &&
    input.ownerThreadId !== input.requestingThreadId
  ) {
    reasons.push("A different task cannot adopt a dirty responder checkout.");
  }

  return reasons.length === 0
    ? { action: "RECOVER" as const, reasons: [] }
    : { action: "BLOCK" as const, reasons };
}

export function canSafelyRequeueExpiredCourseSupportBatch(input: {
  leaseExpiresAt: Date;
  baseSha: string;
  releaseSha: string | null;
  releaseIsPublished: boolean;
  deployedAt: Date | null;
  priorExecutionRecorded?: boolean;
  recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
  dirtyPaths: string[];
  incidentResults: CourseSupportBatchIncidentResult[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const hasRecheckDispatch = Boolean(
    input.recheckDispatchKey ||
    input.recheckDispatchStartedAt ||
    input.recheckDispatchedAt,
  );
  const hasOnlySafeDispatchedEvidence =
    input.incidentResults.length > 0 &&
    input.incidentResults.every(
      (result) => result === "STALE_EVIDENCE" || result === "RETRY_SCHEDULED",
    );
  return Boolean(
    input.leaseExpiresAt.getTime() <= now.getTime() &&
    (!input.releaseSha ||
      input.releaseSha === input.baseSha ||
      !input.releaseIsPublished) &&
    (!input.deployedAt || input.releaseSha === input.baseSha) &&
    input.priorExecutionRecorded !== true &&
    (!hasRecheckDispatch || hasOnlySafeDispatchedEvidence) &&
    input.dirtyPaths.length === 0 &&
    input.incidentResults.length > 0 &&
    input.incidentResults.every(
      (result) =>
        result === "PENDING" ||
        result === "STALE_EVIDENCE" ||
        result === "RETRY_SCHEDULED",
    ),
  );
}

const CURRENT_SOURCE_DISCOVERY_PLAN_STAGES = new Set<AutomationPlaybookStage>([
  "OFFICIAL_IDENTITY",
  "TYPED_ADAPTER",
  "OFFICIAL_HTTP_DISCOVERY",
  "HTTP_ADAPTER_RETRY",
  "RENDERED_BROWSER_DISCOVERY",
]);
const CURRENT_SOURCE_PROVIDER_FAMILIES = new Set<string>([
  SOURCE_MISSING_PROVIDER_FAMILY,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
]);

function isExpiredImplementationSupersededByCurrentSource(input: {
  claimedAttempt: CourseSupportRemediationClaimAttempt | null | undefined;
  course: MonitoringStrategyInput;
  failureClass: CourseSupportFailureClass | null | undefined;
}) {
  const plan = input.claimedAttempt?.actionPlan;
  const playbookStage = input.claimedAttempt?.approach.playbookStage ?? null;
  const currentProviderFamily = input.course.providerFamilyKey
    ?.trim()
    .toUpperCase();
  if (
    plan?.primaryAction !== "IMPLEMENT_REUSABLE_SUPPORT" ||
    !playbookStage ||
    !CURRENT_SOURCE_DISCOVERY_PLAN_STAGES.has(playbookStage) ||
    !CURRENT_SOURCE_PROVIDER_FAMILIES.has(currentProviderFamily ?? "")
  ) {
    return false;
  }

  const currentStrategy = selectMonitoringStrategy({
    ...input.course,
    providerFamilyKey: input.course.providerFamilyKey,
    failureClass: input.failureClass,
    discoveryAttempt:
      playbookStage === "RENDERED_BROWSER_DISCOVERY"
        ? "HTTP_INCONCLUSIVE"
        : "NONE",
  });
  return (
    currentStrategy.action === "DISCOVER_WITH_HTTP" ||
    currentStrategy.action === "DISCOVER_WITH_BROWSER"
  );
}

export type CourseSupportReleaseAdvanceProof = {
  fromSha: string;
  toSha: string;
  branch: string;
  committedPaths: string[];
  descendantVerified: boolean;
};

type PersistedCourseSupportReleaseProvenance =
  CourseSupportReleaseAdvanceProof & {
    schemaVersion: 1;
  };

function normalizeCourseSupportReleaseProvenance(
  proof: CourseSupportReleaseAdvanceProof,
): PersistedCourseSupportReleaseProvenance {
  return {
    schemaVersion: 1,
    fromSha: proof.fromSha,
    toSha: proof.toSha,
    branch: proof.branch,
    committedPaths: normalizeCourseSupportObservedGitPaths(
      proof.committedPaths,
    ),
    descendantVerified: proof.descendantVerified,
  };
}

function readCourseSupportReleaseProvenance(
  summary: unknown,
): PersistedCourseSupportReleaseProvenance | null {
  const provenance = asJsonObject(asJsonObject(summary).releaseProvenance);
  if (
    provenance.schemaVersion !== 1 ||
    typeof provenance.fromSha !== "string" ||
    typeof provenance.toSha !== "string" ||
    typeof provenance.branch !== "string" ||
    !Array.isArray(provenance.committedPaths) ||
    !provenance.committedPaths.every((path) => typeof path === "string") ||
    provenance.descendantVerified !== true
  ) {
    return null;
  }
  return normalizeCourseSupportReleaseProvenance({
    fromSha: provenance.fromSha,
    toSha: provenance.toSha,
    branch: provenance.branch,
    committedPaths: provenance.committedPaths as string[],
    descendantVerified: true,
  });
}

export function chooseCourseSupportReleaseDiffBase(input: {
  baseSha: string;
  persistedReleaseSha: string | null;
  requestedReleaseSha: string;
  originMainSha: string;
  claimedBaseIsAncestorOfOriginMain: boolean;
  originMainIsAncestorOfRequestedRelease: boolean;
}) {
  if (input.persistedReleaseSha === input.requestedReleaseSha) {
    return null;
  }

  const trustedBaseSha = input.persistedReleaseSha ?? input.baseSha;
  return input.claimedBaseIsAncestorOfOriginMain &&
    input.originMainIsAncestorOfRequestedRelease
    ? input.originMainSha
    : trustedBaseSha;
}

export function canVerifyUnchangedCourseSupportRuntime(input: {
  allowUnchangedRuntime: boolean;
  remediationAllowsUnchangedRuntime: boolean;
  baseSha: string;
  persistedReleaseSha: string | null;
  requestedReleaseSha: string;
  plannedPaths: string[];
}) {
  return Boolean(
    input.allowUnchangedRuntime &&
    input.remediationAllowsUnchangedRuntime &&
    input.persistedReleaseSha === null &&
    input.requestedReleaseSha === input.baseSha &&
    input.plannedPaths.length === 0,
  );
}

export function orderCourseSupportBatchIncidents<
  T extends { id: string; createdAt: Date; course: { name: string } }
>(entries: readonly T[]) {
  return [...entries].sort((left, right) => {
    const nameOrder = compareOrdinalText(left.course.name, right.course.name);
    if (nameOrder !== 0) {
      return nameOrder;
    }
    const createdAtOrder = left.createdAt.getTime() - right.createdAt.getTime();
    return createdAtOrder || compareOrdinalText(left.id, right.id);
  });
}

export function assessCourseSupportReleaseTransition(input: {
  persistedReleaseSha: string | null;
  requestedReleaseSha: string | null | undefined;
  expectedBranch: string | null;
  plannedPaths: string[];
  advanceProof?: CourseSupportReleaseAdvanceProof;
}) {
  if (
    !input.requestedReleaseSha ||
    input.requestedReleaseSha === input.persistedReleaseSha
  ) {
    return { action: "UNCHANGED" as const, reasons: [] };
  }
  if (!input.persistedReleaseSha) {
    return { action: "INITIAL" as const, reasons: [] };
  }

  const proof = input.advanceProof;
  const committedPaths = normalizeCourseSupportObservedGitPaths(
    proof?.committedPaths ?? [],
  );
  const reasons: string[] = [];
  if (!proof || proof.fromSha !== input.persistedReleaseSha) {
    reasons.push(
      "The follow-up release does not start from the persisted release.",
    );
  }
  if (!proof || proof.toSha !== input.requestedReleaseSha) {
    reasons.push(
      "The follow-up release proof does not match the requested SHA.",
    );
  }
  if (!proof?.descendantVerified) {
    reasons.push("The follow-up release ancestry was not verified.");
  }
  if (!input.expectedBranch || proof?.branch !== input.expectedBranch) {
    reasons.push(
      "The follow-up release branch does not match batch provenance.",
    );
  }
  if (committedPaths.length === 0) {
    reasons.push("The follow-up release has no committed change.");
  }
  if (committedPaths.some((path) => !input.plannedPaths.includes(path))) {
    reasons.push("The follow-up release contains an unplanned path.");
  }

  return reasons.length === 0
    ? { action: "ADVANCE" as const, reasons: [] }
    : { action: "REJECT" as const, reasons };
}

export function buildCourseSupportReleaseHistory(input: {
  summary: Prisma.JsonValue | null;
  baseSha: string;
  previousReleaseSha: string;
  previousDeployedAt: Date | null;
  previousRecheckDispatchKey: string | null;
  previousRecheckDispatchStartedAt: Date | null;
  previousRecheckDispatchedAt: Date | null;
  previousIncidentVerifications: Array<{
    ordinal: number;
    courseRef: string;
    result: CourseSupportBatchIncidentResult;
    message: string | null;
    proofSnapshot: Prisma.JsonValue | null;
    verifiedIncidentUpdatedAt: Date | null;
    verifiedAt: Date | null;
    providerExecutionRecorded: boolean;
    providerExecutionAttemptRecorded: boolean;
    terminalExecutionRecorded: boolean;
  }>;
  nextReleaseSha: string;
  advancedAt: Date;
}) {
  const summary = asJsonObject(input.summary);
  const existingHistory = Array.isArray(summary.releaseHistory)
    ? summary.releaseHistory
    : [];
  const executionEver = buildCourseSupportExecutionEverSummary({
    summary: input.summary,
    baseSha: input.baseSha,
    previousReleaseSha: input.previousReleaseSha,
    previousDeployedAt: input.previousDeployedAt,
    previousIncidentVerifications: input.previousIncidentVerifications.map(
      (entry) => ({
        ordinal: entry.ordinal,
        courseRef: entry.courseRef,
        providerExecutionRecorded: entry.providerExecutionRecorded,
        providerExecutionAttemptRecorded:
          entry.providerExecutionAttemptRecorded,
        terminalExecutionRecorded: entry.terminalExecutionRecorded,
      }),
    ),
  });
  return {
    ...summary,
    executionEver,
    releaseHistory: [
      ...existingHistory,
      {
        releaseSha: input.previousReleaseSha,
        deployedAt: input.previousDeployedAt?.toISOString() ?? null,
        recheckDispatchKey: input.previousRecheckDispatchKey,
        recheckDispatchStartedAt:
          input.previousRecheckDispatchStartedAt?.toISOString() ?? null,
        recheckDispatchedAt:
          input.previousRecheckDispatchedAt?.toISOString() ?? null,
        recheckDispatch: summary.recheckDispatch ?? null,
        incidentVerifications: input.previousIncidentVerifications.map(
          (entry) => ({
            ordinal: entry.ordinal,
            courseRef: entry.courseRef,
            result: entry.result,
            message: entry.message,
            proofSnapshot: entry.proofSnapshot,
            verifiedIncidentUpdatedAt:
              entry.verifiedIncidentUpdatedAt?.toISOString() ?? null,
            verifiedAt: entry.verifiedAt?.toISOString() ?? null,
          }),
        ),
        supersededBy: input.nextReleaseSha,
        supersededAt: input.advancedAt.toISOString(),
      },
    ].slice(-20),
    recheckDispatch: null,
  } as Prisma.InputJsonValue;
}

export function shouldDispatchRemediatedCourseRechecks(input: {
  persistedReleaseSha: string | null;
  persistedDeployedAt: Date | null;
  nextReleaseSha: string | null | undefined;
  nextDeployedAt: Date | null | undefined;
}) {
  const releaseSha = input.nextReleaseSha ?? input.persistedReleaseSha;
  return Boolean(
    !input.persistedDeployedAt && releaseSha && input.nextDeployedAt,
  );
}

export async function inspectCourseSupportQueue(input?: {
  now?: Date;
  requestingThreadId?: string;
  completeParkedCampaignIfDone?: boolean;
}) {
  const now = input?.now ?? new Date();
  const requestingThreadId = input?.requestingThreadId?.trim() || null;
  if (input?.requestingThreadId !== undefined) {
    validateOwnerThread(input.requestingThreadId);
  }
  const dueWhere = buildDueResponderIncidentWhere(now);
  const [
    rawDueIncidents,
    parkedSourceCompleteFinalizationCandidates,
    activeBatches,
    expiredBatch,
    parkedCampaign,
    recentCompletedBatches,
  ] =
    await Promise.all([
      prisma.courseSupportIncident.findMany({
        where: dueWhere,
        orderBy: [{ earliestTargetDate: "asc" }, { firstSeenAt: "asc" }],
        take: COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT + 1,
        select: {
          cycle: true,
          confirmedAt: true,
          attemptLedger: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          engineeringOnly: true,
          escalationDeadlineAt: true,
          escalatedAt: true,
          firstSeenAt: true,
          course: {
            select: {
              timeZone: true,
              preferences: {
                where: {
                  teeSearch: {
                    status: "ACTIVE",
                    trafficClass: {
                      notIn: [...syntheticWebsiteTrafficClasses],
                    },
                  },
                },
                take: COURSE_SUPPORT_CANDIDATE_PREFERENCE_READ_LIMIT + 1,
                select: {
                  teeSearch: { select: { id: true, date: true } },
                },
              },
            },
          },
        },
      }),
      listParkedSourceCompleteFinalizationRecoveryCandidates(now),
      prisma.courseSupportBatch.findMany({
        where: {
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { gt: now },
        },
        orderBy: { heartbeatAt: "desc" },
        take: MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
        select: {
          id: true,
          reference: true,
          status: true,
          leaseExpiresAt: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          ownerThreadId: true,
          summary: true,
        },
      }),
      prisma.courseSupportBatch.findFirst({
        where: {
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { lte: now },
        },
        orderBy: { leaseExpiresAt: "asc" },
        select: {
          id: true,
          reference: true,
          status: true,
          leaseExpiresAt: true,
        },
      }),
      inspectActiveParkedCourseCampaign({
        completeIfDone: input?.completeParkedCampaignIfDone === true,
      }),
      prisma.courseSupportBatch.findMany({
        where: { completedAt: { not: null } },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
        select: COURSE_SUPPORT_RECENT_FAIRNESS_BATCH_SELECT,
      }),
    ]);
  const activeBatch =
    activeBatches.find((batch) => batch.ownerThreadId === requestingThreadId) ??
    activeBatches[0] ??
    null;
  assertBoundedCourseSupportCandidateQueue(rawDueIncidents);
  const activeProviderGroups = new Set(
    activeBatches.map(
      (batch) => `${batch.providerFamilyKey}\u0000${batch.failureFingerprint}`,
    ),
  );
  const dueDemand = [
    ...rawDueIncidents.flatMap((incident) => {
      const currentDemand = deriveCourseSupportCurrentDemand(
        incident.course.preferences,
        {
          timeZone: incident.course.timeZone,
          now,
        },
      );
      if (
        !isResponderSelectionEligible({
          confirmedAt: incident.confirmedAt,
          attemptLedger: incident.attemptLedger,
          cycle: incident.cycle,
          engineeringOnly: incident.engineeringOnly,
          activeRealSearchCount: currentDemand.activeRealSearchCount,
        })
      ) {
        return [];
      }
      return [
        {
          incident: {
            ...incident,
            endpointHumanReviewProven:
              incident.escalatedAt != null &&
              isAutomationHumanReviewProofCurrentOrPrior(
                incident.attemptLedger,
                incident.cycle,
              ),
            engineeringOnly:
              currentDemand.activeRealSearchCount > 0
                ? false
                : incident.engineeringOnly,
          },
          ...currentDemand,
        },
      ];
    }),
    ...parkedSourceCompleteFinalizationCandidates.map((candidate) => ({
      incident: {
        providerFamilyKey: candidate.providerFamilyKey,
        failureFingerprint: candidate.failureFingerprint,
        engineeringOnly: candidate.engineeringOnly,
        escalationDeadlineAt: candidate.escalationDeadlineAt,
        endpointHumanReviewProven: candidate.endpointHumanReviewProven,
        firstSeenAt: candidate.firstSeenAt,
      },
      activeRealSearchCount: candidate.activeRealSearchCount,
      earliestTargetDate: candidate.earliestTargetDate,
    })),
  ];
  const dueIncidents = dueDemand.map(({ incident }) => incident);
  const availableDueIncidents = dueIncidents.filter(
    (incident) =>
      !activeProviderGroups.has(
        `${incident.providerFamilyKey}\u0000${incident.failureFingerprint}`,
      ),
  );

  const providerGroups = new Set(
    dueIncidents.map(
      (incident) =>
        `${incident.providerFamilyKey}\u0000${incident.failureFingerprint}`,
    ),
  );
  const dueRealCount = dueDemand.filter(
    ({ activeRealSearchCount }) => activeRealSearchCount > 0,
  ).length;
  const dueEngineeringCount = dueDemand.filter(
    ({ incident, activeRealSearchCount }) =>
      incident.engineeringOnly && activeRealSearchCount === 0,
  ).length;
  const dueHistoricalRealCount = dueDemand.filter(
    ({ incident, activeRealSearchCount }) =>
      !incident.engineeringOnly && activeRealSearchCount === 0,
  ).length;
  const readOnlyDispatchGroups = [
    ...dueDemand
      .filter(
        ({ incident }) =>
          !activeProviderGroups.has(
            `${incident.providerFamilyKey}\u0000${incident.failureFingerprint}`,
          ),
      )
      .reduce(
        (groups, item) => {
          const key = `${item.incident.providerFamilyKey}\u0000${item.incident.failureFingerprint}`;
          const current = groups.get(key) ?? {
            providerFamilyKey: item.incident.providerFamilyKey,
            pendingInitialEndpointCount: 0,
            earliestPendingInitialEndpointDeadlineAt: null as Date | null,
            activeRealDemandCount: 0,
            courseCount: 0,
            earliestEscalationDeadlineAt: null as Date | null,
            firstSeenAt: item.incident.firstSeenAt ?? now,
          };
          current.activeRealDemandCount += item.activeRealSearchCount;
          current.courseCount += 1;
          if (
            item.activeRealSearchCount > 0 &&
            !item.incident.endpointHumanReviewProven
          ) {
            current.pendingInitialEndpointCount += 1;
            if (item.incident.escalationDeadlineAt) {
              current.earliestPendingInitialEndpointDeadlineAt = new Date(
                Math.min(
                  current.earliestPendingInitialEndpointDeadlineAt?.getTime() ??
                    Number.MAX_SAFE_INTEGER,
                  item.incident.escalationDeadlineAt.getTime(),
                ),
              );
            }
          }
          if (
            item.activeRealSearchCount > 0 &&
            item.incident.escalationDeadlineAt
          ) {
            current.earliestEscalationDeadlineAt = new Date(
              Math.min(
                current.earliestEscalationDeadlineAt?.getTime() ??
                  Number.MAX_SAFE_INTEGER,
                item.incident.escalationDeadlineAt.getTime(),
              ),
            );
          }
          if (item.incident.firstSeenAt < current.firstSeenAt) {
            current.firstSeenAt = item.incident.firstSeenAt;
          }
          groups.set(key, current);
          return groups;
        },
        new Map<
          string,
          {
            providerFamilyKey: string;
            pendingInitialEndpointCount: number;
            earliestPendingInitialEndpointDeadlineAt: Date | null;
            activeRealDemandCount: number;
            courseCount: number;
            earliestEscalationDeadlineAt: Date | null;
            firstSeenAt: Date;
          }
        >(),
      )
      .values(),
  ]
    .sort((left, right) => {
      const priorityOrder = compareCourseSupportGroupPriority(left, right);
      return (
        priorityOrder ||
        right.courseCount - left.courseCount ||
        left.firstSeenAt.getTime() - right.firstSeenAt.getTime() ||
        left.providerFamilyKey.localeCompare(right.providerFamilyKey)
      );
    })
    .slice(0, MAX_CONCURRENT_COURSE_SUPPORT_BATCHES)
    .map((group, index) => ({
      ordinal: index + 1,
      providerFamilyKey: group.providerFamilyKey,
      activeRealDemandCount: group.activeRealDemandCount,
      courseCount: Math.min(5, group.courseCount),
    }));
  const outcome = classifyCourseSupportQueueInspection({
    hasActiveBatch: Boolean(activeBatch),
    activeBatchCount: activeBatches.length,
    maxActiveBatches: MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
    activeBatchOwnerThreadId: activeBatch?.ownerThreadId,
    requestingThreadId,
    hasExpiredBatch: Boolean(expiredBatch),
    dueIncidentCount:
      availableDueIncidents.length +
      (parkedCampaign?.status === "RUNNING" ? parkedCampaign.readyCount : 0),
  });
  const ownedByCurrentTask = Boolean(
    activeBatch &&
    requestingThreadId &&
    activeBatch.ownerThreadId === requestingThreadId,
  );
  const durableCloseoutRecorded =
    !ownedByCurrentTask &&
    (outcome === "no_due_work" || outcome === "deferred_busy")
      ? await recordRoutineResponderObservation({
          outcome,
          now,
          summary: {
            dueIncidentCount: dueIncidents.length,
            dueRealCount,
            dueEngineeringCount,
            dueHistoricalRealCount,
            providerGroupCount: providerGroups.size,
            activeBatchCount: activeBatches.length,
            parkedCampaignReadyCount:
              parkedCampaign?.status === "RUNNING"
                ? parkedCampaign.readyCount
                : 0,
            parkedCampaignPendingCount: parkedCampaign?.pendingCount ?? 0,
          },
        })
      : false;
  const policy = getResponderThreadPolicy({
    outcome,
    durableCloseoutRecorded: ownedByCurrentTask
      ? false
      : outcome === "no_due_work" || outcome === "deferred_busy"
        ? durableCloseoutRecorded
        : outcome === "resume_owned_work"
          ? false
          : true,
  });
  const availableWriterSlots = Math.max(
    0,
    MAX_CONCURRENT_COURSE_SUPPORT_BATCHES - activeBatches.length,
  );
  const recentFairnessEvidence = buildCourseSupportRecentFairnessEvidence(
    recentCompletedBatches,
    now,
  );
  const handoff = buildCourseSupportResponderHandoff({
    outcome,
    hasExpiredBatch: Boolean(expiredBatch),
    ownedByCurrentTask,
    availableWriterSlots,
    ordinaryDispatchGroupCount: readOnlyDispatchGroups.length,
    parkedCampaign,
    hasCurrentActiveRealDemand: dueRealCount > 0,
    activeBatchCampaignSummaryStates: activeBatches.map((batch) =>
      classifyCourseSupportCampaignSummary(batch.summary),
    ),
    recentBatches: recentFairnessEvidence,
  });

  return {
    outcome,
    handoff,
    observedAt: now.toISOString(),
    dueIncidentCount: dueIncidents.length,
    dueRealCount,
    dueEngineeringCount,
    dueHistoricalRealCount,
    providerGroupCount: providerGroups.size,
    parkedCampaign: parkedCampaign
      ? {
          status: parkedCampaign.status,
          capturedAt: parkedCampaign.capturedAt,
          expectedCount: parkedCampaign.expectedCount,
          terminalCount: parkedCampaign.terminalCount,
          pendingCount: parkedCampaign.pendingCount,
          readyCount: parkedCampaign.readyCount,
          activeCount: parkedCampaign.activeCount,
          monitoredCount: parkedCampaign.monitoredCount,
          bookingNotOpenCount: parkedCampaign.bookingNotOpenCount,
          factualLimitationCount: parkedCampaign.factualLimitationCount,
          technicalLimitationCount: parkedCampaign.technicalLimitationCount,
          sourceUnverifiedCount: parkedCampaign.sourceUnverifiedCount,
          engineeringBlockerCount: parkedCampaign.engineeringBlockerCount,
          currentResultMissingCount: parkedCampaign.currentResultMissingCount,
          humanReviewCount: parkedCampaign.humanReviewCount,
          terminalWithin24HoursCount: parkedCampaign.terminalWithin24HoursCount,
          automaticWithin24HoursCount:
            parkedCampaign.automaticWithin24HoursCount,
          remainingGlobalParkedCount: parkedCampaign.remainingGlobalParkedCount,
          membershipDigest: parkedCampaign.membershipDigest,
        }
      : null,
    activeWriterCount: activeBatches.length,
    availableWriterSlots,
    readOnlyDispatchPlan: {
      maxProviderGroups: MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
      maxCoursesPerGroup: 5,
      globalProviderRequestLimit: 2,
      perProviderFamilyRequestLimit: 1,
      groups: readOnlyDispatchGroups,
    },
    recoveryContinuation: {
      reinspectAfterRecovery: Boolean(
        expiredBatch &&
        (availableDueIncidents.length > 0 ||
          (parkedCampaign?.status === "RUNNING" &&
            parkedCampaign.readyCount > 0)) &&
        activeBatches.length < MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
      ),
      dueIncidentCount:
        availableDueIncidents.length +
        (parkedCampaign?.status === "RUNNING" ? parkedCampaign.readyCount : 0),
      availableWriterSlots: Math.max(
        0,
        MAX_CONCURRENT_COURSE_SUPPORT_BATCHES - activeBatches.length,
      ),
    },
    ownedByCurrentTask,
    activeWriter: activeBatch
      ? {
          kind: "COURSE_SUPPORT_BATCH" as const,
          batchRef: activeBatch.reference,
          status: activeBatch.status,
          providerFamilyKey: activeBatch.providerFamilyKey,
          leaseExpiresAt: activeBatch.leaseExpiresAt.toISOString(),
        }
      : null,
    activeWriters: activeBatches.map((batch) => ({
      kind: "COURSE_SUPPORT_BATCH" as const,
      batchRef: batch.reference,
      status: batch.status,
      providerFamilyKey: batch.providerFamilyKey,
      leaseExpiresAt: batch.leaseExpiresAt.toISOString(),
      ownedByCurrentTask: Boolean(
        requestingThreadId && batch.ownerThreadId === requestingThreadId,
      ),
    })),
    expiredBatch: expiredBatch
      ? {
          batchRef: expiredBatch.reference,
          status: expiredBatch.status,
          leaseExpiredAt: expiredBatch.leaseExpiresAt.toISOString(),
        }
      : null,
    durableCloseoutRecorded,
    ...policy,
  };
}

export async function claimCourseSupportBatch(input: {
  ownerThreadId: string;
  branch: string;
  baseSha: string;
  plannedPaths?: string[];
  maxCourses?: number;
  retryBatchId?: string;
  retryOrdinal?: number;
  now?: Date;
}) {
  validateOwnerThread(input.ownerThreadId);
  validateTaskBranch(input.branch);
  validateGitSha(input.baseSha, "base SHA");
  if (input.retryBatchId !== undefined && !input.retryBatchId.trim()) {
    throw new Error("The targeted responder retry reference is invalid.");
  }
  if (input.retryOrdinal !== undefined && !input.retryBatchId) {
    throw new Error(
      "A targeted responder retry ordinal requires a retry batch reference.",
    );
  }
  if (input.retryOrdinal !== undefined && input.maxCourses !== 1) {
    throw new Error(
      "An exact-entry targeted responder retry requires maxCourses to be 1.",
    );
  }
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);
  const plannedPaths = normalizePaths(input.plannedPaths ?? []);
  const retrySourceBatchDigest = input.retryBatchId
    ? createHash("sha256").update(input.retryBatchId).digest("hex")
    : null;

  const lease = await runWithCourseSupportWriterTransitionLease(
    async (writerLease) => {
    const selectionDatabaseNow = await getCourseSupportDatabaseNow(prisma);
    const activeBatches = await prisma.courseSupportBatch.findMany({
      where: {
        status: { in: ACTIVE_BATCH_STATUSES },
        leaseExpiresAt: { gt: selectionDatabaseNow },
      },
      orderBy: { heartbeatAt: "desc" },
      take: MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
      select: {
        id: true,
        leaseExpiresAt: true,
        status: true,
        providerFamilyKey: true,
        failureFingerprint: true,
        summary: true,
      },
    });
    if (activeBatches.length >= MAX_CONCURRENT_COURSE_SUPPORT_BATCHES) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now: selectionDatabaseNow,
        summary: {
          activeBatchCount: activeBatches.length,
        },
      });
      return {
        outcome: "deferred_busy" as const,
        durableCloseoutRecorded: recorded,
        ...getResponderThreadPolicy({
          outcome: "deferred_busy",
          durableCloseoutRecorded: recorded,
        }),
      };
    }
    const sharedCheckoutImplementationReserved = activeBatches.some((batch) =>
      courseSupportBatchReservesCheckout(batch),
    );
    if (plannedPaths.length > 0 && sharedCheckoutImplementationReserved) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now: selectionDatabaseNow,
        summary: {
          activeBatchCount: activeBatches.length,
          sharedCheckoutImplementationBusy: true,
        },
      });
      return {
        outcome: "deferred_busy" as const,
        durableCloseoutRecorded: recorded,
        ...getResponderThreadPolicy({
          outcome: "deferred_busy",
          durableCloseoutRecorded: recorded,
        }),
      };
    }

    const [initialCandidates, recentCompletedBatches, retryBatch] = await Promise.all([
      listCourseSupportClaimCandidates(selectionDatabaseNow),
      prisma.courseSupportBatch.findMany({
        where: { completedAt: { not: null } },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
        select: COURSE_SUPPORT_RECENT_FAIRNESS_BATCH_SELECT,
      }),
      input.retryBatchId
        ? prisma.courseSupportBatch.findUnique({
            where: { id: input.retryBatchId },
            select: {
              status: true,
              completedAt: true,
              summary: true,
              providerFamilyKey: true,
              failureFingerprint: true,
              incidents: {
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: COURSE_SUPPORT_BATCH_MAX_SIZE + 1,
                select: {
                  id: true,
                  incidentId: true,
                  courseId: true,
                  cycle: true,
                  result: true,
                  incident: {
                    select: {
                      batchIncidents: {
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        take: 1,
                        select: { id: true, cycle: true },
                      },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
    ]);
    const activeProviderGroups = new Set(
      activeBatches.map(
        (batch) =>
          `${batch.providerFamilyKey}\u0000${batch.failureFingerprint}`,
      ),
    );
    const campaignPlan = input.retryBatchId
      ? {
          members: [],
          campaignRunId: null,
          membershipDigest: null,
        }
      : await planNextParkedCourseCampaignCohort({
          now: selectionDatabaseNow,
          maxCourses: Math.min(maxCourses, 5),
          runtimeVersion: input.baseSha,
          hasDueRealDemand: initialCandidates.some(
            (candidate) => candidate.activeRealSearchCount > 0,
          ),
          activeProviderGroups,
        });
    const campaignCandidates = await listParkedCourseCampaignCandidates(
      campaignPlan,
      selectionDatabaseNow,
    );
    const allCandidates = mergeCourseSupportClaimCandidatePools({
      campaignCandidates,
      currentCandidates: initialCandidates,
    });
    const providerEligibleCandidates = allCandidates.filter(
      (candidate) =>
        !activeProviderGroups.has(
          `${candidate.providerFamilyKey}\u0000${candidate.failureFingerprint}`,
        ),
    );
    const implementationBlockedCandidates = sharedCheckoutImplementationReserved
      ? providerEligibleCandidates.filter(
          (candidate) =>
            candidate.remediationRoute?.requiresImplementationPath === true,
        )
      : [];
    const eligibleCandidates = providerEligibleCandidates.filter(
      (candidate) =>
        !sharedCheckoutImplementationReserved ||
        candidate.remediationRoute?.requiresImplementationPath !== true,
    );
    if (input.retryBatchId && !retryBatch) {
      throw new Error("The targeted responder retry batch was not found.");
    }
    const waitingCandidates = eligibleCandidates.filter(
      (candidate) =>
        candidate.remediationRoute?.workMode === "WAIT_FOR_MATERIAL_CHANGE",
    );
    const parkedForMaterialChangeCount = input.retryBatchId
      ? 0
      : await parkCourseSupportCandidatesForMaterialChange(
          waitingCandidates,
          selectionDatabaseNow,
        );
    const candidates = eligibleCandidates.filter(
      (candidate) =>
        candidate.remediationRoute?.workMode !== "WAIT_FOR_MATERIAL_CHANGE",
    );
    const targetedRetryBlockedByCheckout = Boolean(
      retryBatch &&
      implementationBlockedCandidates.some((candidate) =>
        retryBatch.incidents.some(
          (entry) =>
            entry.incidentId === candidate.id &&
            entry.courseId === candidate.courseId &&
            entry.cycle === candidate.cycle,
        ),
      ),
    );
    if (targetedRetryBlockedByCheckout) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now: selectionDatabaseNow,
        summary: {
          activeBatchCount: activeBatches.length,
          sharedCheckoutImplementationBusy: true,
          blockedImplementationCount: implementationBlockedCandidates.length,
        },
      });
      return {
        outcome: "deferred_busy" as const,
        durableCloseoutRecorded: recorded,
        sharedCheckoutImplementationBusy: true,
        parkedForMaterialChangeCount,
        ...getResponderThreadPolicy({
          outcome: "deferred_busy",
          durableCloseoutRecorded: recorded,
        }),
      };
    }
    const fairnessEvidence = buildCourseSupportRecentFairnessEvidence(
      recentCompletedBatches,
      selectionDatabaseNow,
    );
    const prioritySelection = input.retryBatchId
      ? null
      : selectCourseSupportBatch({
          candidates: candidates.filter(
            (candidate) =>
              !candidate.campaign || candidate.activeRealSearchCount > 0,
          ),
          recentBatches: fairnessEvidence,
          maxCourses,
          now: selectionDatabaseNow,
        });
    const requestlessCampaignSelection = input.retryBatchId
      ? null
      : selectCourseSupportBatch({
          candidates: candidates.filter(
            (candidate) =>
              Boolean(candidate.campaign) &&
              candidate.activeRealSearchCount === 0,
          ),
          recentBatches: fairnessEvidence,
          maxCourses: Math.min(maxCourses, 5),
          now: selectionDatabaseNow,
        });
    const admissionLane = input.retryBatchId
      ? null
      : selectCourseSupportAdmissionLane({
          priorityCandidateAvailable: Boolean(prioritySelection),
          requestlessParkedCampaignAvailable: Boolean(
            requestlessCampaignSelection,
          ),
          hasCurrentActiveRealDemand: initialCandidates.some(
            (candidate) => candidate.activeRealSearchCount > 0,
          ),
          activeBatchCampaignSummaryStates: activeBatches.map((batch) =>
            classifyCourseSupportCampaignSummary(batch.summary),
          ),
          recentBatches: fairnessEvidence,
        });
    const selected = retryBatch
      ? selectCourseSupportRetryBatch({
          candidates,
          retryBatch,
          retryOrdinal: input.retryOrdinal,
          maxCourses,
          now: selectionDatabaseNow,
        })
      : admissionLane?.lane === "REQUESTLESS_PARKED_CAMPAIGN"
        ? requestlessCampaignSelection && {
            ...requestlessCampaignSelection,
            fairnessReason: admissionLane.parkedCampaignReservation
              ? ("PARKED_CAMPAIGN_RESERVATION" as const)
              : requestlessCampaignSelection.fairnessReason,
          }
        : admissionLane?.lane === "PRIORITY"
          ? prioritySelection
          : null;
    if (!selected) {
      const deferredForImplementation =
        implementationBlockedCandidates.length > 0;
      const outcome = deferredForImplementation
        ? "deferred_busy"
        : "no_due_work";
      const recorded = await recordRoutineResponderObservation({
        outcome,
        now: selectionDatabaseNow,
        summary: {
          dueIncidentCount: 0,
          parkedForMaterialChangeCount,
          ...(deferredForImplementation
            ? {
                activeBatchCount: activeBatches.length,
                sharedCheckoutImplementationBusy: true,
                blockedImplementationCount:
                  implementationBlockedCandidates.length,
              }
            : {}),
        },
      });
      return {
        outcome,
        durableCloseoutRecorded: recorded,
        parkedForMaterialChangeCount,
        ...(deferredForImplementation
          ? { sharedCheckoutImplementationBusy: true }
          : {}),
        ...getResponderThreadPolicy({
          outcome,
          durableCloseoutRecorded: recorded,
        }),
      };
    }

    if (
      !selected.incidents[0]?.remediationRoute ||
      !selected.remediationDirective ||
      selected.incidents.some((incident) => !incident.actionPlan)
    ) {
      throw new Error(
        "Course-support remediation routing or its claimed action plan was unavailable; no batch was claimed.",
      );
    }
    const preselectedClaimCandidateByIncidentId = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    const buildRemediationSummary = (
      selection: SelectedCourseSupportBatch,
      admittedAt: Date,
    ) => {
      const remediationRoute = selection.incidents[0]?.remediationRoute;
      if (!remediationRoute) {
        throw new Error(
          "Course-support remediation routing changed during locked claim; rerun selection.",
        );
      }
      return ({
        ...serializeCourseSupportRemediationRoute(remediationRoute),
        attempts: selection.incidents.map((incident) => ({
          courseRef:
            incident.remediationCourseRef ??
            createCourseSupportRemediationCourseRef(incident.courseId),
          providerSnapshotFingerprint:
            incident.providerSnapshotFingerprint ?? "unknown",
          failureFingerprint: incident.failureFingerprint,
          runtimeVersion: input.baseSha,
          activeRealSearchCount: incident.activeRealSearchCount,
          playbookEventCountAtClaim:
            (incident as CourseSupportClaimCandidate)
              .playbookEventCountAtClaim ?? 0,
          reason:
            incident.remediationRoute?.reason ??
            remediationRoute.reason,
          retryBudget: serializeCourseSupportRemediationRetryBudget(
            incident.remediationRoute?.retryBudget ?? null,
          ),
          approach:
            incident.remediationRoute?.attemptSignature ??
            remediationRoute.attemptSignature ??
            null,
          actionPlan: incident.actionPlan!,
          providerContractEvidence:
            incident.providerContractEvidence ?? null,
          ...(incident.deferredFailureHandoff
            ? {
                deferredFailureHandoffSource:
                  incident.deferredFailureHandoff.signal,
                deferredFailureHandoffAdmission:
                  createDeferredFailureHandoffAdmission({
                    signal: incident.deferredFailureHandoff.signal,
                    admittedAt,
                  }),
              }
            : {}),
        })),
      }) satisfies Prisma.InputJsonObject;
    };
    const buildCampaignSummary = (selection: SelectedCourseSupportBatch) => {
      const campaignAttempts = selection.incidents.flatMap((incident) => {
        const recoveryCampaign =
          readCandidateSourceCompleteFinalizationRecovery(incident)?.campaign;
        const campaign = incident.campaign
          ? {
              runId: incident.campaign.runId,
              membershipDigest: incident.campaign.membershipDigest,
            }
          : recoveryCampaign;
        return campaign
          ? [
              {
                courseRef: createCourseSupportRemediationCourseRef(
                  incident.courseId,
                ),
                runId: campaign.runId,
                membershipDigest: campaign.membershipDigest,
                cycle: incident.cycle,
              },
            ]
          : [];
      });
      return campaignAttempts.length > 0
        ? ({
            kind: "PARKED_COHORT",
            attempts: campaignAttempts,
          } satisfies Prisma.InputJsonObject)
        : null;
    };
    const buildSourceCompleteFinalizationRecoverySummary = (
      selection: SelectedCourseSupportBatch,
    ) => {
      const recoveryAttempts = selection.incidents.flatMap((incident) => {
        const recovery = readCandidateSourceCompleteFinalizationRecovery(incident);
        return recovery
          ? [
              {
                courseRef: createCourseSupportRemediationCourseRef(
                  incident.courseId,
                ),
                evidenceDigest: recovery.evidenceDigest,
                sourceBatchDigest: createHash("sha256")
                  .update(recovery.sourceBatchId)
                  .digest("hex"),
              },
            ]
          : [];
      });
      return recoveryAttempts.length > 0
        ? ({
            schemaVersion: 1,
            attempts: recoveryAttempts,
          } satisfies Prisma.InputJsonObject)
        : null;
    };
    const preplannedFairnessHistoryFence =
      buildCourseSupportFairnessHistoryFence(
        recentCompletedBatches,
        selectionDatabaseNow,
      );
    const leaseToken = randomUUID();
    const conflictingInitialPaths = findConflictingResponderPaths(
      plannedPaths,
      activeBatches.flatMap((activeBatch) =>
        readBatchPlannedPaths(activeBatch.summary),
      ),
    );
    if (conflictingInitialPaths.length > 0) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now: selectionDatabaseNow,
        summary: {
          activeBatchCount: activeBatches.length,
          scopeConflictCount: conflictingInitialPaths.length,
        },
      });
      return {
        outcome: "deferred_busy" as const,
        durableCloseoutRecorded: recorded,
        scopeConflict: true,
        ...getResponderThreadPolicy({
          outcome: "deferred_busy",
          durableCloseoutRecorded: recorded,
        }),
      };
    }
    const created = await runCourseSupportSerializableTransactionWithRetry(
      async (tx) => {
        await acquireCourseSupportClaimMonitoringLocks(
          tx,
          selected.incidents.map((incident) => incident.courseId),
        );
        await lockCourseSupportClaimIncidentRows(
          tx,
          selected.incidents.map((incident) => ({ id: incident.id })),
        );
        const claimDatabaseNow = await getCourseSupportDatabaseNow(tx);
        const leaseExpiresAt = new Date(
          claimDatabaseNow.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
        );
        await fenceCourseSupportClaimCourseRows(
          tx,
          selected.incidents.map((incident) => {
            const courseUpdatedAt = preselectedClaimCandidateByIncidentId.get(
              incident.id,
            )?.courseUpdatedAt;
            if (
              !(courseUpdatedAt instanceof Date) ||
              !Number.isFinite(courseUpdatedAt.getTime())
            ) {
              throw new Error(
                "Course-support course evidence is unavailable during claim.",
              );
            }
            return { id: incident.courseId, updatedAt: courseUpdatedAt };
          }),
        );
        const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
        const deferredSelectedIncidents = selected.incidents.filter(
          (incident) => incident.deferredFailureHandoff,
        );
        if (deferredSelectedIncidents.some((incident) => incident.campaign)) {
          throw new Error(
            "Deferred failure confirmation cannot overlap parked-campaign ownership.",
          );
        }
        if (deferredSelectedIncidents.length > 0) {
          const activeCampaigns = await tx.automationRun.findMany({
            where: {
              promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
              status: "RUNNING",
              completedAt: null,
            },
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            take: COURSE_SUPPORT_ACTIVE_CAMPAIGN_FENCE_LIMIT + 1,
            select: { audit: true },
          });
          if (
            activeCampaigns.length > COURSE_SUPPORT_ACTIVE_CAMPAIGN_FENCE_LIMIT
          ) {
            throw new Error(
              "Deferred failure confirmation cannot prove bounded parked-course campaign ownership.",
            );
          }
          for (const activeCampaign of activeCampaigns) {
            const audit = parseParkedCourseCampaignAudit(
              activeCampaign.audit,
            );
            if (!audit) {
              throw new Error(
                "Deferred failure confirmation cannot prove parked-course campaign ownership from an invalid audit.",
              );
            }
            if (
              deferredSelectedIncidents.some((incident) =>
                audit.members.some(
                  (member) =>
                    member.incidentId === incident.id ||
                    member.courseId === incident.courseId,
                ),
              )
            ) {
              throw new Error(
                "Deferred failure confirmation conflicts with an active parked-course campaign.",
              );
            }
          }
        }
        for (const incident of selected.incidents) {
          if (!incident.campaign) continue;
          const reopened =
            await reopenParkedCourseForResponderCampaignInTransaction(tx, {
              courseId: incident.courseId,
              incidentId: incident.id,
              expectedCycle: incident.campaign.priorCycle,
              expectedRevision: incident.campaign.priorRevision,
              expectedMonitoringRevision:
                incident.campaign.priorMonitoringRevision,
              capturedRevision: incident.campaign.capturedRevision,
              capturedMonitoringRevision:
                incident.campaign.capturedMonitoringRevision,
              capturedCycle: incident.campaign.capturedCycle,
              capturedKind: incident.campaign.capturedKind,
              capturedProviderFamilyKey:
                incident.campaign.capturedProviderFamilyKey,
              campaignCapturedAt: incident.campaign.campaignCapturedAt,
              admissionMode: incident.campaign.admissionMode,
              expectedZeroExecutionHistoryDigest:
                incident.campaign.zeroExecutionHistoryDigest,
              expectedSameCycleRecoveryHistoryDigest:
                incident.campaign.sameCycleRecoveryHistoryDigest,
              expectedPlaybookNextStage: incident.campaign.playbookNextStage,
              expectedPlaybookCompletedStageCount:
                incident.campaign.playbookCompletedStageCount,
              currentRuntimeVersion: input.baseSha,
              expectedKind: incident.campaign.expectedKind,
              expectedFailureClass: incident.campaign.expectedFailureClass,
              expectedMonitoringFailureFingerprint:
                incident.campaign.expectedMonitoringFailureFingerprint,
              expectedLatestProbeAt: incident.campaign.expectedLatestProbeAt,
              expectedLatestDiscoveryAt:
                incident.campaign.expectedLatestDiscoveryAt,
              expectedLatestProbeId: incident.campaign.expectedLatestProbeId,
              expectedLatestDiscoveryId:
                incident.campaign.expectedLatestDiscoveryId,
              expectedProviderFamilyKey: incident.providerFamilyKey,
              expectedFailureFingerprint: incident.failureFingerprint,
              expectedProviderSnapshotFingerprint:
                incident.campaign.expectedProviderSnapshotFingerprint,
              expectedAttemptLedgerFingerprint:
                incident.campaign.expectedAttemptLedgerFingerprint,
              expectedPlaybookConclusion:
                incident.campaign.expectedPlaybookConclusion,
              campaignRunId: incident.campaign.runId,
              campaignMembershipDigest: incident.campaign.membershipDigest,
              now: claimDatabaseNow,
            });
          if (!reopened.admitted || reopened.cycle !== incident.cycle) {
            throw new Error(
              "A parked-course campaign member changed before atomic batch admission.",
            );
          }
        }
        const [
          currentIncidents,
          currentRecentCompletedBatches,
          currentActiveBatches,
        ] = await Promise.all([
          listCourseSupportClaimCandidateIncidents(claimDatabaseNow, tx),
          tx.courseSupportBatch.findMany({
            where: { completedAt: { not: null } },
            orderBy: [{ completedAt: "desc" }, { id: "desc" }],
            take: COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
            select: COURSE_SUPPORT_RECENT_FAIRNESS_BATCH_SELECT,
          }),
          tx.courseSupportBatch.findMany({
            where: {
              status: { in: ACTIVE_BATCH_STATUSES },
              leaseExpiresAt: { gt: claimDatabaseNow },
            },
            orderBy: { heartbeatAt: "desc" },
            take: MAX_CONCURRENT_COURSE_SUPPORT_BATCHES,
            select: {
              id: true,
              status: true,
              providerFamilyKey: true,
              failureFingerprint: true,
              summary: true,
            },
          }),
        ]);
        const currentIncidentById = new Map(
          currentIncidents.map((incident) => [incident.id, incident]),
        );
        const lockedClaimCandidateByIncidentId = new Map<
          string,
          CourseSupportClaimCandidate
        >();
        for (const incident of selected.incidents) {
          const selectedClaimCandidate =
            preselectedClaimCandidateByIncidentId.get(incident.id);
          if (
            !selectedClaimCandidate ||
            selectedClaimCandidate.courseId !== incident.courseId
          ) {
            throw new Error(
              "Course-support claim evidence changed before atomic batch admission.",
            );
          }
          const current = currentIncidentById.get(incident.id);
          if (!current) {
            throw new Error(
              "Course-support demand changed during claim; rerun selection.",
            );
          }
          const rebuilt = buildCourseSupportCandidates(
            [current],
            claimDatabaseNow,
          ).find((candidate) => candidate.id === incident.id);
          if (!rebuilt) {
            throw new Error(
              "Course-support stage eligibility changed during claim; rerun selection.",
            );
          }
          if (
            !courseSupportProviderContractEvidenceMarkersMatch(
              selectedClaimCandidate.providerContractEvidence,
              rebuilt.providerContractEvidence,
            )
          ) {
            throw new Error(
              "Course-support provider contract evidence changed during claim; rerun selection.",
            );
          }
          if (
            !courseSupportClaimAuthorityMatches(
              selectedClaimCandidate,
              rebuilt,
            )
          ) {
            throw new Error(
              "Course-support claimed action authority changed during claim; rerun selection.",
            );
          }
          const selectedDeferredFailureHandoff =
            selectedClaimCandidate.deferredFailureHandoff;
          const lockedDeferredFailureHandoff = rebuilt.deferredFailureHandoff;
          const selectedSourceCompleteFinalizationRecovery =
            readCandidateSourceCompleteFinalizationRecovery(
              selectedClaimCandidate,
            );
          const lockedSourceCompleteFinalizationRecovery =
            readCandidateSourceCompleteFinalizationRecovery(rebuilt);
          if (
            Boolean(selectedDeferredFailureHandoff) !==
              Boolean(lockedDeferredFailureHandoff) ||
            Boolean(selectedSourceCompleteFinalizationRecovery) !==
              Boolean(lockedSourceCompleteFinalizationRecovery) ||
            Boolean(
              selectedDeferredFailureHandoff &&
                selectedSourceCompleteFinalizationRecovery,
            ) ||
            Boolean(
              lockedDeferredFailureHandoff &&
                lockedSourceCompleteFinalizationRecovery,
            )
          ) {
            throw new Error(
              "Course-support special claim lane changed during locked claim; rerun selection.",
            );
          }
          const lockedClaimCandidate: CourseSupportClaimCandidate =
            selectedClaimCandidate.campaign
              ? { ...rebuilt, campaign: selectedClaimCandidate.campaign }
              : rebuilt;
          lockedClaimCandidateByIncidentId.set(
            incident.id,
            lockedClaimCandidate,
          );
          if (lockedDeferredFailureHandoff) {
            const provenance = lockedDeferredFailureHandoff;
            const selectedProvenance = selectedDeferredFailureHandoff;
            if (
              !selectedProvenance ||
              current.status !== "AUTO_INVESTIGATING" ||
              current.activeBatchId !== null ||
              selectedClaimCandidate.cycle !== rebuilt.cycle ||
              selectedClaimCandidate.providerFamilyKey !==
                rebuilt.providerFamilyKey ||
              selectedClaimCandidate.failureFingerprint !==
                rebuilt.failureFingerprint ||
              selectedProvenance.expectedIncidentRevision !==
                provenance.expectedIncidentRevision ||
              selectedProvenance.expectedMonitoringRevision !==
                provenance.expectedMonitoringRevision ||
              selectedProvenance.expectedMonitoringStateChangedAt.getTime() !==
                provenance.expectedMonitoringStateChangedAt.getTime() ||
              selectedProvenance.sourceBatchIncidentId !==
                provenance.sourceBatchIncidentId ||
              selectedProvenance.sourceBatchId !== provenance.sourceBatchId ||
              selectedProvenance.signal.recordDigest !==
                provenance.signal.recordDigest ||
              selectedProvenance.signal.signalDigest !==
                provenance.signal.signalDigest ||
              current.revision !== provenance.expectedIncidentRevision ||
              current.nextAttemptAt === null ||
              current.nextAttemptAt.getTime() > claimDatabaseNow.getTime() ||
              current.course.monitoringStatus?.revision !==
                provenance.expectedMonitoringRevision ||
              current.course.monitoringStatus.stateChangedAt.getTime() !==
                provenance.expectedMonitoringStateChangedAt.getTime() ||
              rebuilt.remediationRoute?.workMode !== "VERIFY_TRANSIENT" ||
              rebuilt.remediationRoute.requiresImplementationPath ||
              rebuilt.remediationRoute.reason !== "MATERIAL_CHANGE_REOPENED" ||
              rebuilt.remediationRoute.attemptSignature?.playbookStage !== null
            ) {
              throw new Error(
                "Deferred failure confirmation provenance changed during claim; rerun selection.",
              );
            }
            const sourceEntry = current.batchIncidents[0];
            if (
              !sourceEntry ||
              sourceEntry.id !== provenance.sourceBatchIncidentId ||
              sourceEntry.batch.id !== provenance.sourceBatchId
            ) {
              throw new Error(
                "Deferred failure confirmation source changed during claim; rerun selection.",
              );
            }
            const sourceBatchFence = await tx.courseSupportBatch.updateMany({
              where: {
                id: sourceEntry.batch.id,
                status: sourceEntry.batch.status,
                providerFamilyKey: rebuilt.providerFamilyKey,
                failureFingerprint: rebuilt.failureFingerprint,
                baseSha: sourceEntry.batch.baseSha,
                releaseSha: sourceEntry.batch.releaseSha,
                deployedAt: sourceEntry.batch.deployedAt,
                completedAt: sourceEntry.batch.completedAt,
                revision: sourceEntry.batch.revision,
                updatedAt: sourceEntry.batch.updatedAt,
                summary: {
                  equals: sourceEntry.batch.summary as Prisma.InputJsonValue,
                },
              },
              data: {
                revision: { increment: 0 },
                updatedAt: sourceEntry.batch.updatedAt,
              },
            });
            const sourceEntryFence =
              await tx.courseSupportBatchIncident.updateMany({
                where: {
                  id: sourceEntry.id,
                  batchId: sourceEntry.batchId,
                  incidentId: sourceEntry.incidentId,
                  courseId: sourceEntry.courseId,
                  cycle: sourceEntry.cycle,
                  result: sourceEntry.result,
                  proofSnapshot: {
                    equals:
                      sourceEntry.proofSnapshot === null
                        ? Prisma.DbNull
                        : (sourceEntry.proofSnapshot as Prisma.InputJsonValue),
                  },
                  verifiedAt: sourceEntry.verifiedAt,
                  createdAt: sourceEntry.createdAt,
                  updatedAt: sourceEntry.updatedAt,
                },
                data: { updatedAt: sourceEntry.updatedAt },
              });
            if (sourceBatchFence.count !== 1 || sourceEntryFence.count !== 1) {
              throw new Error(
                "Deferred failure confirmation source changed during claim; rerun selection.",
              );
            }
            for (const request of sourceEntry.verificationRequests) {
              const requestFence =
                await tx.courseSupportVerificationRequest.updateMany({
                  where: {
                    id: request.id,
                    batchIncidentId: sourceEntry.id,
                    releaseSha: request.releaseSha,
                    runtimeVersion: request.runtimeVersion,
                    status: request.status,
                    revision: request.revision,
                    attemptCount: request.attemptCount,
                    startedAt: request.startedAt,
                    outcome: request.outcome,
                    failureClass: request.failureClass,
                    lastError: request.lastError,
                    providerSnapshotFingerprint:
                      request.providerSnapshotFingerprint,
                    nextAttemptAt: request.nextAttemptAt,
                    completedAt: request.completedAt,
                    createdAt: request.createdAt,
                    updatedAt: request.updatedAt,
                    evidence: {
                      equals:
                        request.evidence === null
                          ? Prisma.DbNull
                          : (request.evidence as Prisma.InputJsonValue),
                    },
                  },
                  data: {
                    revision: { increment: 0 },
                    updatedAt: request.updatedAt,
                  },
                });
              if (requestFence.count !== 1) {
                throw new Error(
                  "Deferred failure confirmation request changed during claim; rerun selection.",
                );
              }
            }
            const currentMonitoringFailureFingerprint =
              current.course.monitoringStatus?.failureFingerprint;
            if (!currentMonitoringFailureFingerprint) {
              throw new Error(
                "Deferred failure confirmation monitoring identity is unavailable.",
              );
            }
            const monitoringFence =
              await tx.courseMonitoringStatus.updateMany({
                where: {
                  courseId: rebuilt.courseId,
                  state: "AUTO_INVESTIGATING",
                  stateChangedAt:
                    provenance.expectedMonitoringStateChangedAt,
                  revision: provenance.expectedMonitoringRevision,
                  failureFingerprint: currentMonitoringFailureFingerprint,
                  nextAutomaticAttemptAt: current.nextAttemptAt,
                },
                data: { revision: { increment: 0 } },
              });
            if (monitoringFence.count !== 1) {
              throw new Error(
                "Deferred failure confirmation monitoring state changed during claim; rerun selection.",
              );
            }
          }
          const sourceCompleteFinalizationRecovery =
            lockedSourceCompleteFinalizationRecovery;
          if (sourceCompleteFinalizationRecovery) {
            const selectedRecovery =
              selectedSourceCompleteFinalizationRecovery;
            const sourceEntry = current.batchIncidents[0];
            if (
              !selectedRecovery ||
              selectedRecovery.evidenceDigest !==
                sourceCompleteFinalizationRecovery.evidenceDigest ||
              selectedRecovery.sourceBatchId !==
                sourceCompleteFinalizationRecovery.sourceBatchId ||
              selectedRecovery.sourceBatchIncidentId !==
                sourceCompleteFinalizationRecovery.sourceBatchIncidentId ||
              rebuilt.remediationRoute?.workMode !==
                "COMPLETE_CLASSIFICATION" ||
              rebuilt.remediationRoute.reason !== "CLASSIFICATION_READY" ||
              rebuilt.actionPlan?.primaryAction !==
                "COMPLETE_CLASSIFICATION" ||
              current.status !==
                sourceCompleteFinalizationRecovery.priorIncidentStatus ||
              current.humanReviewReason !==
                sourceCompleteFinalizationRecovery.priorHumanReviewReason ||
              current.activeBatchId !== null ||
              (sourceCompleteFinalizationRecovery.priorIncidentStatus ===
              "NEEDS_HUMAN"
                ? current.nextAttemptAt !== null
                : current.nextAttemptAt !== null &&
                  current.nextAttemptAt.getTime() > claimDatabaseNow.getTime()) ||
              !sourceEntry ||
              sourceEntry.id !==
                sourceCompleteFinalizationRecovery.sourceBatchIncidentId ||
              sourceEntry.batch.id !==
                sourceCompleteFinalizationRecovery.sourceBatchId
            ) {
              throw new Error(
                "Course-support source-complete recovery evidence changed during claim; rerun selection.",
              );
            }
            const latestDiscoveryFence =
              await tx.courseAutomationDiscovery.findFirst({
                where: { courseId: rebuilt.courseId },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                select: { id: true, createdAt: true },
              });
            if (
              (latestDiscoveryFence?.id ?? null) !==
                sourceCompleteFinalizationRecovery.expectedLatestDiscoveryId ||
              (latestDiscoveryFence?.createdAt.getTime() ?? null) !==
                (sourceCompleteFinalizationRecovery.expectedLatestDiscoveryCreatedAt?.getTime() ??
                  null)
            ) {
              throw new Error(
                "Course-support source-complete recovery discovery evidence changed during claim; rerun selection.",
              );
            }
            const sourceBatchFence = await tx.courseSupportBatch.updateMany({
              where: {
                id: sourceEntry.batch.id,
                status: "RETRYABLE_FAILED",
                providerFamilyKey: rebuilt.providerFamilyKey,
                failureFingerprint: rebuilt.failureFingerprint,
                baseSha: sourceEntry.batch.baseSha,
                releaseSha: sourceEntry.batch.releaseSha,
                deployedAt: sourceEntry.batch.deployedAt,
                completedAt: sourceEntry.batch.completedAt,
                revision: sourceEntry.batch.revision,
                updatedAt: sourceEntry.batch.updatedAt,
                summary: {
                  equals: sourceEntry.batch.summary as Prisma.InputJsonValue,
                },
              },
              data: {
                revision: { increment: 0 },
                updatedAt: sourceEntry.batch.updatedAt,
              },
            });
            const sourceEntryFence =
              await tx.courseSupportBatchIncident.updateMany({
                where: {
                  id: sourceEntry.id,
                  batchId: sourceEntry.batchId,
                  incidentId: sourceEntry.incidentId,
                  courseId: sourceEntry.courseId,
                  cycle: sourceEntry.cycle,
                  result: "RETRY_SCHEDULED",
                  proofSnapshot: {
                    equals:
                      sourceEntry.proofSnapshot === null
                        ? Prisma.AnyNull
                        : (sourceEntry.proofSnapshot as Prisma.InputJsonValue),
                  },
                  verifiedAt: sourceEntry.verifiedAt,
                  verifiedIncidentUpdatedAt:
                    sourceEntry.verifiedIncidentUpdatedAt,
                  createdAt: sourceEntry.createdAt,
                  updatedAt: sourceEntry.updatedAt,
                },
                data: { updatedAt: sourceEntry.updatedAt },
              });
            const currentMonitoringStatus = current.course.monitoringStatus;
            if (!currentMonitoringStatus?.failureFingerprint) {
              throw new Error(
                "Course-support source-complete recovery monitoring evidence is unavailable.",
              );
            }
            const monitoringFence =
              await tx.courseMonitoringStatus.updateMany({
                where: {
                  courseId: rebuilt.courseId,
                  state:
                    sourceCompleteFinalizationRecovery.expectedMonitoringState,
                  stateChangedAt:
                    sourceCompleteFinalizationRecovery.expectedMonitoringStateChangedAt,
                  revision:
                    sourceCompleteFinalizationRecovery.expectedMonitoringRevision,
                  failureFingerprint:
                    currentMonitoringStatus.failureFingerprint,
                },
                data: {
                  state: "AUTO_INVESTIGATING",
                  nextAutomaticAttemptAt: null,
                  revalidationRequestedAt: null,
                  stateChangedAt: claimDatabaseNow,
                  revision: { increment: 1 },
                },
              });
            if (
              sourceBatchFence.count !== 1 ||
              sourceEntryFence.count !== 1 ||
              monitoringFence.count !== 1
            ) {
              throw new Error(
                "Course-support source-complete recovery evidence changed during claim; rerun selection.",
              );
            }
          }
          if (
            !lockedDeferredFailureHandoff &&
            !lockedSourceCompleteFinalizationRecovery
          ) {
            if (
              current.status !== "AUTO_INVESTIGATING" ||
              current.activeBatchId !== null
            ) {
              throw new Error(
                "Course-support incident ownership changed during locked claim; rerun selection.",
              );
            }
            if (retryBatch?.completedAt) {
              if (
                current.nextAttemptAt === null ||
                current.nextAttemptAt.getTime() <=
                  retryBatch.completedAt.getTime() ||
                current.nextAttemptAt.getTime() > claimDatabaseNow.getTime()
              ) {
                throw new Error(
                  "Course-support targeted retry eligibility changed during locked claim; rerun selection.",
                );
              }
            } else if (
              current.nextAttemptAt !== null &&
              current.nextAttemptAt.getTime() > claimDatabaseNow.getTime()
            ) {
              throw new Error(
                "Course-support incident due time changed during locked claim; rerun selection.",
              );
            }
          }
          if (retryBatch?.completedAt) {
            const selectedRetrySourceEntry =
              input.retryOrdinal !== undefined
                ? retryBatch.incidents[input.retryOrdinal - 1]
                : retryBatch.incidents.find(
                    (entry) =>
                      entry.incidentId === current.id &&
                      entry.courseId === current.courseId,
                  );
            const currentRetrySourceEntry = current.batchIncidents[0];
            if (
              !selectedRetrySourceEntry ||
              selectedRetrySourceEntry.incidentId !== current.id ||
              selectedRetrySourceEntry.courseId !== current.courseId ||
              selectedRetrySourceEntry.cycle !== current.cycle ||
              selectedRetrySourceEntry.result !== "RETRY_SCHEDULED" ||
              !currentRetrySourceEntry ||
              currentRetrySourceEntry.id !== selectedRetrySourceEntry.id ||
              currentRetrySourceEntry.batchId !== input.retryBatchId ||
              currentRetrySourceEntry.incidentId !== current.id ||
              currentRetrySourceEntry.courseId !== current.courseId ||
              currentRetrySourceEntry.cycle !== current.cycle ||
              currentRetrySourceEntry.result !== "RETRY_SCHEDULED" ||
              currentRetrySourceEntry.batch.id !== input.retryBatchId ||
              currentRetrySourceEntry.batch.status !== "RETRYABLE_FAILED" ||
              currentRetrySourceEntry.batch.providerFamilyKey !==
                retryBatch.providerFamilyKey ||
              currentRetrySourceEntry.batch.failureFingerprint !==
                retryBatch.failureFingerprint ||
              currentRetrySourceEntry.batch.completedAt?.getTime() !==
                retryBatch.completedAt.getTime()
            ) {
              throw new Error(
                "Course-support targeted retry provenance changed during locked claim; rerun selection.",
              );
            }
          }
          if (
            incident.providerSnapshotFingerprint &&
            buildCourseSupportProviderSnapshotFingerprint(current.course) !==
              incident.providerSnapshotFingerprint
          ) {
            throw new Error(
              "Course-support provider evidence changed during claim; rerun selection.",
            );
          }
          if (
            getAuthoritativeCourseMonitoringResolution(
              current.course.monitoringStatus?.state,
            )
          ) {
            continue;
          }
          const currentDemand = deriveCourseSupportCurrentDemand(
            current.course.preferences,
            {
              timeZone: current.course.timeZone,
              now: claimDatabaseNow,
            },
          );
          const currentEngineeringOnly =
            currentDemand.activeRealSearchCount > 0
              ? false
              : current.engineeringOnly;
          if (
            !isResponderSelectionEligible({
              confirmedAt: current.confirmedAt,
              attemptLedger: current.attemptLedger,
              cycle: current.cycle,
              engineeringOnly: currentEngineeringOnly,
              activeRealSearchCount: currentDemand.activeRealSearchCount,
            })
          ) {
            throw new Error(
              "Course-support stage eligibility changed during claim; rerun selection.",
            );
          }
          if (
            currentDemand.activeRealSearchCount !==
              incident.activeRealSearchCount ||
            (currentDemand.earliestTargetDate?.getTime() ?? null) !==
              (incident.earliestTargetDate?.getTime() ?? null) ||
            currentEngineeringOnly !== incident.engineeringOnly
          ) {
            throw new Error(
              "Course-support demand changed during claim; rerun selection.",
            );
          }
        }
        const currentFairnessEvidence =
          buildCourseSupportRecentFairnessEvidence(
            currentRecentCompletedBatches,
            claimDatabaseNow,
          );
        if (
          admissionLane?.lane === "REQUESTLESS_PARKED_CAMPAIGN" &&
          admissionLane.parkedCampaignReservation &&
          JSON.stringify(
            buildCourseSupportFairnessHistoryFence(
              currentRecentCompletedBatches,
              claimDatabaseNow,
            ),
          ) !== JSON.stringify(preplannedFairnessHistoryFence)
        ) {
          throw new Error(
            "The requestless parked-campaign reservation changed during atomic claim; rerun selection.",
          );
        }
        const currentActiveProviderGroups = new Set(
          currentActiveBatches.map(
            (batch) =>
              `${batch.providerFamilyKey}\u0000${batch.failureFingerprint}`,
          ),
        );
        const currentSharedCheckoutImplementationReserved =
          currentActiveBatches.some((batch) =>
            courseSupportBatchReservesCheckout(batch),
          );
        const currentConflictingPaths = findConflictingResponderPaths(
          plannedPaths,
          currentActiveBatches.flatMap((activeBatch) =>
            readBatchPlannedPaths(activeBatch.summary),
          ),
        );
        if (
          currentActiveBatches.length >= MAX_CONCURRENT_COURSE_SUPPORT_BATCHES ||
          currentConflictingPaths.length > 0
        ) {
          throw new Error(
            "Course-support active ownership changed during locked claim; rerun selection.",
          );
        }
        const lockedCandidatePool = buildSelectableCourseSupportClaimCandidates(
          currentIncidents,
          claimDatabaseNow,
        )
          .map(
            (candidate) =>
              lockedClaimCandidateByIncidentId.get(candidate.id) ?? candidate,
          )
          .filter(
            (candidate) =>
              !currentActiveProviderGroups.has(
                `${candidate.providerFamilyKey}\u0000${candidate.failureFingerprint}`,
              ) &&
              candidate.remediationRoute?.workMode !==
                "WAIT_FOR_MATERIAL_CHANGE" &&
              (!currentSharedCheckoutImplementationReserved ||
                candidate.remediationRoute?.requiresImplementationPath !== true),
          );
        const currentPrioritySelection = retryBatch
          ? null
          : selectCourseSupportBatch({
              candidates: lockedCandidatePool.filter(
                (candidate) =>
                  !candidate.campaign || candidate.activeRealSearchCount > 0,
              ),
              recentBatches: currentFairnessEvidence,
              maxCourses,
              now: claimDatabaseNow,
            });
        const currentRequestlessCampaignSelection = retryBatch
          ? null
          : selectCourseSupportBatch({
              candidates: lockedCandidatePool.filter(
                (candidate) =>
                  Boolean(candidate.campaign) &&
                  candidate.activeRealSearchCount === 0,
              ),
              recentBatches: currentFairnessEvidence,
              maxCourses: Math.min(maxCourses, 5),
              now: claimDatabaseNow,
            });
        const currentAdmissionLane = retryBatch
          ? null
          : selectCourseSupportAdmissionLane({
              priorityCandidateAvailable: Boolean(currentPrioritySelection),
              requestlessParkedCampaignAvailable: Boolean(
                currentRequestlessCampaignSelection,
              ),
              hasCurrentActiveRealDemand: lockedCandidatePool.some(
                (candidate) => candidate.activeRealSearchCount > 0,
              ),
              activeBatchCampaignSummaryStates: currentActiveBatches.map(
                (batch) =>
                  classifyCourseSupportCampaignSummary(batch.summary),
              ),
              recentBatches: currentFairnessEvidence,
            });
        let currentSelection: SelectedCourseSupportBatch | null;
        if (retryBatch) {
          currentSelection = selectCourseSupportRetryBatch({
            candidates: lockedCandidatePool,
            retryBatch,
            retryOrdinal: input.retryOrdinal,
            maxCourses,
            now: claimDatabaseNow,
          });
        } else if (
          currentAdmissionLane?.lane === "REQUESTLESS_PARKED_CAMPAIGN"
        ) {
          currentSelection = currentRequestlessCampaignSelection
            ? {
                ...currentRequestlessCampaignSelection,
                fairnessReason: currentAdmissionLane.parkedCampaignReservation
                  ? "PARKED_CAMPAIGN_RESERVATION"
                  : currentRequestlessCampaignSelection.fairnessReason,
              }
            : null;
        } else if (currentAdmissionLane?.lane === "PRIORITY") {
          currentSelection = currentPrioritySelection;
        } else {
          currentSelection = null;
        }
        const plannedSelectionMembers = selected.incidents
          .map((incident) => `${incident.id}\u0000${incident.courseId}`)
          .sort();
        const currentSelectionMembers = (currentSelection?.incidents ?? [])
          .map((incident) => `${incident.id}\u0000${incident.courseId}`)
          .sort();
        if (
          !currentSelection ||
          JSON.stringify(currentSelectionMembers) !==
            JSON.stringify(plannedSelectionMembers)
        ) {
          if (
            admissionLane?.lane === "REQUESTLESS_PARKED_CAMPAIGN" &&
            admissionLane.parkedCampaignReservation
          ) {
            throw new Error(
              "The requestless parked-campaign reservation changed during atomic claim; rerun selection.",
            );
          }
          throw new Error(
            "Course-support selection changed during locked claim; rerun selection.",
          );
        }
        const lockedSelection = currentSelection;
        const lockedRemediationRoute =
          lockedSelection.incidents[0]?.remediationRoute;
        if (
          !lockedRemediationRoute ||
          !lockedSelection.remediationDirective ||
          lockedSelection.incidents.some((incident) => !incident.actionPlan)
        ) {
          throw new Error(
            "Course-support remediation routing or its claimed action plan changed during locked claim; rerun selection.",
          );
        }
        let reconciledAuthoritativeFinalCount = 0;
        for (const incident of lockedSelection.incidents) {
          const current = currentIncidentById.get(incident.id);
          if (!current) {
            throw new Error(
              "Course-support demand changed during claim; rerun selection.",
            );
          }
          const monitoringStatus = current.course.monitoringStatus;
          const authoritativeResolution =
            getAuthoritativeCourseMonitoringResolution(monitoringStatus?.state);
          if (!monitoringStatus || !authoritativeResolution) {
            continue;
          }
          const monitoringFence = await tx.courseMonitoringStatus.updateMany({
            where: {
              courseId: incident.courseId,
              state: monitoringStatus.state,
              revision: monitoringStatus.revision,
              lastSuccessfulAt: monitoringStatus.lastSuccessfulAt,
            },
            data: { revision: { increment: 0 } },
          });
          if (monitoringFence.count !== 1) {
            throw new Error(
              "Course-support authoritative monitoring state changed during claim; rerun selection.",
            );
          }
          const reconciled = await tx.courseSupportIncident.updateMany({
            where: {
              id: current.id,
              cycle: current.cycle,
              revision: current.revision,
              status: "AUTO_INVESTIGATING",
              activeBatchId: null,
            },
            data: {
              status: "RESOLVED",
              resolvedAt: claimDatabaseNow,
              resolution: authoritativeResolution.resolution,
              resolutionMessage: authoritativeResolution.message,
              nextAction: null,
              nextAttemptAt: null,
              nextReminderAt: null,
              lastSeenAt: getCourseSupportIncidentEvidenceObservedAt({
                proofSnapshot: null,
                incidentLastSeenAt: current.lastSeenAt,
                now: claimDatabaseNow,
                additionalProviderObservedAt:
                  monitoringStatus.state === "HEALTHY"
                    ? monitoringStatus.lastSuccessfulAt
                    : null,
              }),
              revision: { increment: 1 },
            },
          });
          if (reconciled.count !== 1) {
            throw new Error(
              "Course-support factual finality changed during claim; rerun selection.",
            );
          }
          reconciledAuthoritativeFinalCount += 1;
        }
        if (reconciledAuthoritativeFinalCount > 0) {
          return { reconciledAuthoritativeFinalCount };
        }
        if (input.retryBatchId !== undefined) {
          const outsideDueFetchFailures =
            await tx.courseSupportIncident.findMany({
              where: {
                ...buildDueResponderIncidentWhere(claimDatabaseNow),
                id: {
                  notIn: lockedSelection.incidents.map((incident) => incident.id),
                },
                kind: "FETCH_FAILED",
              },
              take: COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT + 1,
              select: {
                cycle: true,
                confirmedAt: true,
                attemptLedger: true,
                engineeringOnly: true,
                course: {
                  select: {
                    timeZone: true,
                    preferences: {
                      where: {
                        teeSearch: {
                          status: "ACTIVE",
                          trafficClass: {
                            notIn: [...syntheticWebsiteTrafficClasses],
                          },
                        },
                      },
                      take:
                        COURSE_SUPPORT_CANDIDATE_PREFERENCE_READ_LIMIT + 1,
                      select: {
                        teeSearch: { select: { id: true, date: true } },
                      },
                    },
                  },
                },
              },
            });
          assertBoundedCourseSupportCandidateQueue(outsideDueFetchFailures);
          const outsideCriticalDemandAppeared = outsideDueFetchFailures.some(
            (incident) => {
              const { course } = incident;
              const currentDemand = deriveCourseSupportCurrentDemand(
                course.preferences,
                {
                  timeZone: course.timeZone,
                  now: claimDatabaseNow,
                },
              );
              return Boolean(
                isResponderSelectionEligible({
                  confirmedAt: incident.confirmedAt,
                  attemptLedger: incident.attemptLedger,
                  cycle: incident.cycle,
                  engineeringOnly: incident.engineeringOnly,
                  activeRealSearchCount: currentDemand.activeRealSearchCount,
                }) &&
                currentDemand.activeRealSearchCount > 0 &&
                currentDemand.earliestTargetDate &&
                currentDemand.earliestTargetDate.getTime() <=
                  claimDatabaseNow.getTime() + NEAR_DATE_WINDOW_MS,
              );
            },
          );
          if (outsideCriticalDemandAppeared) {
            throw new Error(
              "A targeted responder retry cannot bypass due critical real-demand work.",
            );
          }
        }
        const remediationSummary = buildRemediationSummary(
          lockedSelection,
          claimDatabaseNow,
        );
        const campaignSummary = buildCampaignSummary(lockedSelection);
        const sourceCompleteFinalizationRecoverySummary =
          buildSourceCompleteFinalizationRecoverySummary(lockedSelection);
        const newestProbes = (
          await Promise.all(
            [...new Set(lockedSelection.incidents.map((incident) => incident.courseId))]
              .sort()
              .map((courseId) =>
                tx.courseProbe.findFirst({
                  where: { courseId },
                  orderBy: [{ observedAt: "desc" }, { id: "desc" }],
                  select: { id: true, courseId: true },
                }),
              ),
          )
        ).filter(
          (probe): probe is { id: string; courseId: string } => probe !== null,
        );
        const preProbeByCourse = new Map<string, string>();
        for (const probe of newestProbes) {
          if (!preProbeByCourse.has(probe.courseId)) {
            preProbeByCourse.set(probe.courseId, probe.id);
          }
        }
        const automationRun = await tx.automationRun.create({
          data: {
            promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
            kind: "COURSE_SUPPORT",
            status: "RUNNING",
            runtimeVersion: input.baseSha,
            ownerThreadId: input.ownerThreadId,
            heartbeatAt: claimDatabaseNow,
            notes: JSON.stringify({
              schemaVersion: 1,
              lifecycle: "claimed",
              branch: input.branch,
              baseSha: input.baseSha,
              plannedPaths,
              incidentCount: lockedSelection.incidents.length,
              fairnessReason: lockedSelection.fairnessReason,
              remediation: remediationSummary,
              ...(campaignSummary ? { campaign: campaignSummary } : {}),
              ...(sourceCompleteFinalizationRecoverySummary
                ? {
                    sourceCompleteFinalizationRecovery:
                      sourceCompleteFinalizationRecoverySummary,
                  }
                : {}),
              targetedRetry: Boolean(input.retryBatchId),
              ...(input.retryOrdinal !== undefined
                ? {
                    retryScope: "ENTRY",
                    retrySourceOrdinal: String(input.retryOrdinal).padStart(
                      2,
                      "0",
                    ),
                  }
                : {}),
              ...(retrySourceBatchDigest ? { retrySourceBatchDigest } : {}),
            }),
          },
          select: { id: true },
        });
        const batch = await tx.courseSupportBatch.create({
          data: {
            reference: createCourseSupportBatchReference(claimDatabaseNow),
            providerFamilyKey: lockedSelection.providerFamilyKey,
            failureFingerprint: lockedSelection.failureFingerprint,
            status: plannedPaths.length > 0 ? "IMPLEMENTING" : "CLAIMED",
            ownerAutomationRunId: automationRun.id,
            ownerThreadId: input.ownerThreadId,
            leaseToken,
            leaseExpiresAt,
            heartbeatAt: claimDatabaseNow,
            baseSha: input.baseSha,
            maxCourses,
            summary: {
              schemaVersion: 1,
              branch: input.branch,
              searchExecutionFence: persistCourseSupportSearchExecutionFence(
                buildCourseSupportSearchExecutionFenceSnapshot({
                  courseIds: lockedSelection.incidents.map(
                    (incident) => incident.courseId,
                  ),
                  expectedSearches: [],
                  recheckDispatchKey: null,
                  recheckDispatchStartedAt: null,
                  recheckDispatchedAt: null,
                  now: claimDatabaseNow,
                  dispatches: [],
                }),
                claimDatabaseNow,
              ),
              plannedPaths,
              fairnessReason: lockedSelection.fairnessReason,
              remediation: remediationSummary,
              ...(campaignSummary ? { campaign: campaignSummary } : {}),
              ...(sourceCompleteFinalizationRecoverySummary
                ? {
                    sourceCompleteFinalizationRecovery:
                      sourceCompleteFinalizationRecoverySummary,
                  }
                : {}),
              targetedRetry: Boolean(input.retryBatchId),
              ...(input.retryOrdinal !== undefined
                ? {
                    retryScope: "ENTRY",
                    retrySourceOrdinal: String(input.retryOrdinal).padStart(
                      2,
                      "0",
                    ),
                  }
                : {}),
              ...(retrySourceBatchDigest ? { retrySourceBatchDigest } : {}),
              containsCriticalRealDemand:
                lockedSelection.containsCriticalRealDemand,
              selectedIncidentCount: lockedSelection.incidents.length,
            },
          },
          select: { id: true, reference: true },
        });
        await tx.courseSupportBatchIncident.createMany({
          data: lockedSelection.incidents.map((incident) => ({
            batchId: batch.id,
            incidentId: incident.id,
            courseId: incident.courseId,
            cycle: incident.cycle,
            preProbeId: preProbeByCourse.get(incident.courseId) ?? null,
          })),
        });
        for (const incident of lockedSelection.incidents) {
          const currentIncident = currentIncidentById.get(incident.id);
          if (!currentIncident) {
            throw new Error(
              "Course-support incident ownership changed during locked claim; rerun selection.",
            );
          }
          const sourceCompleteFinalizationRecovery =
            readCandidateSourceCompleteFinalizationRecovery(incident);
          const retrySourceEntry =
            retryBatch && input.retryOrdinal !== undefined
              ? retryBatch.incidents[input.retryOrdinal - 1]
              : retryBatch
                ? retryBatch.incidents.find(
                    (entry) =>
                      entry.incidentId === incident.id &&
                      entry.courseId === incident.courseId,
                  )
                : null;
          const claimed = await tx.courseSupportIncident.updateMany({
            where: {
              id: currentIncident.id,
              cycle: currentIncident.cycle,
              providerFamilyKey: currentIncident.providerFamilyKey,
              failureFingerprint: currentIncident.failureFingerprint,
              revision: currentIncident.revision,
              updatedAt: currentIncident.updatedAt,
              status: currentIncident.status,
              humanReviewReason: currentIncident.humanReviewReason,
              activeBatchId: currentIncident.activeBatchId,
              nextAttemptAt: currentIncident.nextAttemptAt,
              ...(retrySourceEntry
                ? {
                    batchIncidents: {
                      some: {
                        id: retrySourceEntry.id,
                        batchId: input.retryBatchId!,
                        incidentId: incident.id,
                        courseId: incident.courseId,
                        cycle: incident.cycle,
                        result: "RETRY_SCHEDULED",
                      },
                    },
                  }
                : {}),
            },
            data: {
              status: "AUTO_INVESTIGATING",
              activeBatchId: batch.id,
              activeRealSearchCount: incident.activeRealSearchCount,
              earliestTargetDate: incident.earliestTargetDate,
              engineeringOnly: incident.engineeringOnly,
              ...(sourceCompleteFinalizationRecovery
                ? {
                    humanReviewReason: null,
                    nextReminderAt: null,
                    nextAction:
                      "Complete the current-runtime classification from the already complete signed-out source playbook.",
                  }
                : {}),
              lastAttemptAt: claimDatabaseNow,
              attemptCount: { increment: 1 },
              revision: { increment: 1 },
            },
          });
          if (claimed.count !== 1) {
            throw new Error(
              "Course-support batch ownership changed during claim.",
            );
          }
        }
        if (courseMonitoringAvailable) {
          await tx.courseMonitoringEvent.createMany({
            data: lockedSelection.incidents.map((incident) => {
              const sourceCompleteFinalizationRecovery =
                readCandidateSourceCompleteFinalizationRecovery(incident);
              const campaign = incident.campaign
                ? {
                    runId: incident.campaign.runId,
                    membershipDigest: incident.campaign.membershipDigest,
                  }
                : sourceCompleteFinalizationRecovery?.campaign;
              return {
                courseId: incident.courseId,
                incidentId: incident.id,
                eventType: "AUTOMATION_ATTEMPTED" as const,
                source: "COURSE_SUPPORT_RESPONDER" as const,
                fromState:
                  sourceCompleteFinalizationRecovery?.expectedMonitoringState ??
                  (incident.humanReviewReason
                    ? ("ENGINEERING_VERIFICATION_NEEDED" as const)
                    : ("AUTO_INVESTIGATING" as const)),
                toState: sourceCompleteFinalizationRecovery
                  ? ("AUTO_INVESTIGATING" as const)
                  : incident.humanReviewReason
                  ? ("ENGINEERING_VERIFICATION_NEEDED" as const)
                  : ("AUTO_INVESTIGATING" as const),
                failureFingerprint: incident.failureFingerprint,
                readPath: "BOUNDED_RECOVERY_PLAYBOOK",
                message:
                  sourceCompleteFinalizationRecovery
                    ? "The responder claimed a current-runtime classification pass for an already complete signed-out source playbook."
                    : "The responder claimed a bounded provider-family recovery attempt.",
                occurredAt: claimDatabaseNow,
                audit: {
                  providerFamilyKey: lockedSelection.providerFamilyKey,
                  maxCourses,
                  serializedWriterLane: true,
                  ...(sourceCompleteFinalizationRecovery
                    ? {
                        sourceCompleteFinalizationRecovery: true,
                        evidenceDigest:
                          sourceCompleteFinalizationRecovery.evidenceDigest,
                        cycle: incident.cycle,
                      }
                    : {}),
                  ...(campaign
                    ? {
                        campaignKind: "PARKED_COHORT",
                        campaignRunId: campaign.runId,
                        campaignMembershipDigest: campaign.membershipDigest,
                        cycle: incident.cycle,
                      }
                    : {}),
                  customerDataIncluded: false,
                },
              };
            }),
          });
          const humanReviewCourseIds = lockedSelection.incidents.flatMap((incident) =>
            incident.humanReviewReason ? [incident.courseId] : [],
          );
          const automatedCourseIds = lockedSelection.incidents.flatMap((incident) =>
            incident.humanReviewReason ||
            readCandidateSourceCompleteFinalizationRecovery(incident)
              ? []
              : [incident.courseId],
          );
          await tx.courseMonitoringStatus.updateMany({
            where: {
              courseId: { in: automatedCourseIds },
              state: {
                in: ["UNKNOWN", "DEGRADED_RETRYING", "AUTO_INVESTIGATING"],
              },
            },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: null,
              stateChangedAt: claimDatabaseNow,
              revision: { increment: 1 },
            },
          });
          await tx.courseMonitoringStatus.updateMany({
            where: {
              courseId: { in: humanReviewCourseIds },
              state: {
                notIn: [
                  "HEALTHY",
                  "FINAL_MANUAL",
                  "FINAL_TECHNICAL",
                  "FINAL_IDENTITY",
                ],
              },
            },
            data: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              nextAutomaticAttemptAt: null,
              revision: { increment: 1 },
            },
          });
        }
        return {
          automationRunId: automationRun.id,
          batchId: batch.id,
          batchRef: batch.reference,
          leaseExpiresAt,
          selection: lockedSelection,
        };
      },
      COURSE_SUPPORT_BATCH_CLAIM_TRANSACTION_TIMEOUT_MS,
      {
        deadlineAt: writerLease.deadlineAt,
        headroomMs: COURSE_SUPPORT_BATCH_CLAIM_WRITER_LEASE_HEADROOM_MS,
      },
    );

    if ("reconciledAuthoritativeFinalCount" in created) {
      return {
        outcome: "no_due_work" as const,
        durableCloseoutRecorded: true,
        reconciledAuthoritativeFinalCount:
          created.reconciledAuthoritativeFinalCount,
        ...getResponderThreadPolicy({
          outcome: "no_due_work",
          durableCloseoutRecorded: true,
        }),
      };
    }

    const claimedSelection = created.selection;
    return {
      outcome: "ready" as const,
      batchRef: created.batchRef,
      leaseExpiresAt: created.leaseExpiresAt.toISOString(),
      providerFamilyKey: claimedSelection.providerFamilyKey,
      providerFamilyCategory: getReportSafeProviderFamilyCategory(
        claimedSelection.providerFamilyKey,
      ),
      failureFingerprint: claimedSelection.failureFingerprint,
      incidentCount: claimedSelection.incidents.length,
      leverage: {
        providerGroupCount: 1,
        currentAffectedCourseCount: claimedSelection.incidents.length,
        activeRealDemandCount: claimedSelection.incidents.reduce(
          (total, incident) => total + incident.activeRealSearchCount,
          0,
        ),
        futureSiblingApplicability: ![
          SOURCE_MISSING_PROVIDER_FAMILY,
          SOURCE_CONFLICT_PROVIDER_FAMILY,
        ].includes(claimedSelection.providerFamilyKey as never),
      },
      fairnessReason: claimedSelection.fairnessReason,
      containsCriticalRealDemand: claimedSelection.containsCriticalRealDemand,
      remediation: claimedSelection.remediationDirective
        ? {
            ...claimedSelection.remediationDirective,
            allowUnchangedRuntime:
              claimedSelection.incidents[0]?.remediationRoute
                ?.allowUnchangedRuntime ?? false,
            requiresImplementationPath:
              claimedSelection.incidents[0]?.remediationRoute
                ?.requiresImplementationPath ?? false,
            reason:
              claimedSelection.incidents[0]?.remediationRoute?.reason ?? null,
          }
        : null,
      parkedForMaterialChangeCount,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "The claimed responder batch is still in progress.",
    };
    },
    { timeout: COURSE_SUPPORT_BATCH_CLAIM_WRITER_LEASE_TIMEOUT_MS },
  ).catch((error: unknown) => {
    if (isCourseSupportClaimSnapshotDrift(error)) {
      throw new CourseSupportClaimReplanRequired(error as Error);
    }
    throw error;
  });

  if (!lease.acquired) {
    return {
      outcome: "deferred_busy" as const,
      durableCloseoutRecorded: false,
      ...getResponderThreadPolicy({
        outcome: "deferred_busy",
        durableCloseoutRecorded: false,
      }),
    };
  }
  return lease.value;
}

export async function recordCourseSupportClaimStateChurn() {
  const now = await getCourseSupportDatabaseNow(prisma);
  const durableCloseoutRecorded = await recordRoutineResponderObservation({
    outcome: "deferred_busy",
    now,
    summary: {
      claimStateChurn: true,
      planningAttemptCount: 2,
    },
  });
  return {
    outcome: "deferred_busy" as const,
    durableCloseoutRecorded,
    claimStateChurn: true,
    ...getResponderThreadPolicy({
      outcome: "deferred_busy",
      durableCloseoutRecorded,
    }),
  };
}

export async function appendCourseSupportBatchPath(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  path: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const path = validatePlannedPath(input.path);
  const lease = await runWithCourseSupportWriterTransitionLease(async () => {
    const batch = await prisma.courseSupportBatch.findFirst({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: { in: ACTIVE_BATCH_STATUSES },
        leaseExpiresAt: { gte: now },
      },
      select: {
        status: true,
        revision: true,
        releaseSha: true,
        summary: true,
        ownerAutomationRunId: true,
      },
    });
    if (!batch) {
      return null;
    }
    const summary = asJsonObject(batch.summary);
    const currentPlannedPaths = normalizePaths(
      Array.isArray(summary.plannedPaths)
        ? summary.plannedPaths.filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
        : [],
    );
    if (
      !canAppendCourseSupportBatchPath({
        status: batch.status,
        releaseSha: batch.releaseSha,
        plannedPaths: currentPlannedPaths,
      })
    ) {
      return { sealed: true as const };
    }
    const plannedPaths = normalizePaths([...currentPlannedPaths, path]);
    const leaseExpiresAt = new Date(
      now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
    );
    await prisma.$transaction(async (transaction) => {
      const otherActiveBatches = await transaction.courseSupportBatch.findMany({
        where: {
          id: { not: input.batchId },
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { gte: now },
        },
        select: { status: true, summary: true },
      });
      if (
        otherActiveBatches.some((activeBatch) =>
          courseSupportBatchReservesCheckout(activeBatch),
        )
      ) {
        throw new Error(
          "Responder code changes require exclusive access to the approved checkout.",
        );
      }
      const conflicts = findConflictingResponderPaths(
        [path],
        otherActiveBatches.flatMap((activeBatch) =>
          readBatchPlannedPaths(activeBatch.summary),
        ),
      );
      if (conflicts.length > 0) {
        throw new Error(
          "Responder code scope is already owned by another active provider batch.",
        );
      }
      const updated = await transaction.courseSupportBatch.updateMany({
        where: {
          id: input.batchId,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: batch.status,
          revision: batch.revision,
          releaseSha: batch.releaseSha,
          leaseExpiresAt: { gte: now },
        },
        data: {
          status: "IMPLEMENTING",
          summary: {
            ...summary,
            plannedPaths,
          } as Prisma.InputJsonValue,
          heartbeatAt: now,
          leaseExpiresAt,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          "Responder batch ownership changed while claiming a path.",
        );
      }
      if (batch.ownerAutomationRunId) {
        await transaction.automationRun.updateMany({
          where: { id: batch.ownerAutomationRunId, completedAt: null },
          data: {
            notes: JSON.stringify({
              schemaVersion: 1,
              lifecycle: "implementing",
              plannedPaths,
              plannedPathCount: plannedPaths.length,
            }),
          },
        });
      }
    });
    return { sealed: false as const, plannedPaths, leaseExpiresAt };
  });
  if (!lease.acquired || lease.value === null) {
    return {
      outcome: "recovery_required" as const,
      pathRecorded: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost.",
    };
  }
  if (lease.value.sealed) {
    return {
      outcome: "recovery_required" as const,
      pathRecorded: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason:
        "Responder verification provenance is sealed and cannot add paths.",
    };
  }
  return {
    outcome: "ready" as const,
    pathRecorded: true,
    plannedPathCount: lease.value.plannedPaths.length,
    leaseExpiresAt: lease.value.leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "The responder batch is still in progress.",
  };
}

export function canAppendCourseSupportBatchPath(input: {
  status: CourseSupportBatchStatus;
  releaseSha: string | null;
  plannedPaths: string[];
}) {
  if (input.status === "CLAIMED" || input.status === "IMPLEMENTING") {
    return true;
  }

  return (
    input.status === "VERIFYING" &&
    input.releaseSha === null &&
    input.plannedPaths.length === 0
  );
}

const COURSE_SUPPORT_VERIFICATION_STAGE_DEADLINE_GRANT_KEY =
  "verificationStageDeadlineGrant";

const CONCLUDED_DETACHED_VERIFICATION_RECOVERY_STAGES =
  new Set<AutomationPlaybookStage>([
    "TYPED_ADAPTER",
    "HTTP_ADAPTER_RETRY",
    "BROWSER_ADAPTER_RETRY",
    "LOCAL_READER",
  ]);

const DIRECT_SOURCE_VERIFICATION_STAGES = new Set<AutomationPlaybookStage>([
  "OFFICIAL_IDENTITY",
  "OFFICIAL_HTTP_DISCOVERY",
]);

export type CourseSupportVerificationStageDeadlineGrantOutcome =
  | "GRANTED"
  | "REPLAYED"
  | "NO_GRANTABLE_STAGE"
  | "EXPIRED_UNGRANTABLE_PEER";

function getConcludedDetachedVerificationRecoveryStage(
  assessment: ReturnType<typeof assessAutomationPlaybook>,
): AutomationPlaybookStage | null {
  if (assessment.conclusion !== "MONITORING_RESTORED") {
    return null;
  }
  return (
    assessment.stages.find(
      (stage) =>
        stage.status === "SUCCEEDED" &&
        CONCLUDED_DETACHED_VERIFICATION_RECOVERY_STAGES.has(stage.stage),
    )?.stage ?? null
  );
}

export async function grantOwnedCourseSupportVerificationStageDeadline(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
}) {
  return runCourseSupportSerializableTransactionWithRetry(
    async (transaction) => {
      const databaseNow = await getCourseSupportDatabaseNow(transaction);
      const batch = await transaction.courseSupportBatch.findFirst({
        where: {
          id: input.batchId,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { gt: databaseNow },
        },
        select: {
          status: true,
          revision: true,
          leaseExpiresAt: true,
          summary: true,
          createdAt: true,
          releaseSha: true,
          deployedAt: true,
          recheckDispatchStartedAt: true,
          incidents: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              cycle: true,
              result: true,
              proofSnapshot: true,
              verifiedAt: true,
              verifiedIncidentUpdatedAt: true,
              verificationRequests: {
                take: 1,
                select: {
                  id: true,
                  status: true,
                  startedAt: true,
                },
              },
              incident: {
                select: {
                  id: true,
                  cycle: true,
                  revision: true,
                  status: true,
                  activeBatchId: true,
                  attemptCount: true,
                  attemptLedger: true,
                  activeRealSearchCount: true,
                  providerFamilyKey: true,
                  failureClass: true,
                  confirmedAt: true,
                  escalationDeadlineAt: true,
                  firstSeenAt: true,
                  lastSeenAt: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });
      if (!batch) {
        throw new Error(
          "Course-support verification watch lost ownership before its deadline grant.",
        );
      }

      const summary = asJsonObject(batch.summary);
      if (
        Object.prototype.hasOwnProperty.call(
          summary,
          COURSE_SUPPORT_VERIFICATION_STAGE_DEADLINE_GRANT_KEY,
        )
      ) {
        return {
          outcome: "REPLAYED" as const,
          granted: false,
          replayed: true,
          grantedIncidentCount: 0,
        };
      }

      const remediationDirective = readCourseSupportRemediationDirective(
        batch.summary,
      );
      const targets = batch.incidents.flatMap((entry) => {
        const playbook = assessAutomationPlaybook(
          entry.incident.attemptLedger,
          entry.incident.cycle,
        );
        const concludedRecoveryStage =
          getConcludedDetachedVerificationRecoveryStage(playbook);
        const stage = playbook.nextStage ?? concludedRecoveryStage;
        const stageAssessment = playbook.stages.find(
          (assessment) => assessment.stage === stage,
        );
        const assignedDetachedStage = isAssignedDetachedStageProgression({
          remediationDirective,
          playbookConclusion: playbook.conclusion,
          nextPlaybookStage: stage,
          nextPlaybookStageStatus: stageAssessment?.status,
          nextPlaybookStageAttemptCount: stageAssessment?.attemptCount,
        });
        const packetAuthorizedUnchangedRuntimeStage = Boolean(
          playbook.conclusion === "INCOMPLETE" &&
            stage !== null &&
            stage === remediationDirective?.playbookStage &&
            remediationDirective.allowUnchangedRuntime === true &&
            remediationDirective.requiresImplementationPath === false,
        );
        const directSourceStage = Boolean(
          packetAuthorizedUnchangedRuntimeStage &&
            stage !== null &&
            DIRECT_SOURCE_VERIFICATION_STAGES.has(stage) &&
            ((stageAssessment?.status === "PENDING" &&
              stageAssessment.attemptCount === 0) ||
              (stageAssessment?.status === "FAILED_RETRYABLE" &&
                stageAssessment.attemptCount > 0)),
        );
        const unstartedBrowserStage = Boolean(
          (stage === "RENDERED_BROWSER_DISCOVERY" ||
            stage === "INDEPENDENT_CONFIRMATION") &&
            stageAssessment?.status === "PENDING" &&
            stageAssessment.attemptCount === 0,
        );
        const grantableStageState =
          directSourceStage ||
          unstartedBrowserStage ||
          assignedDetachedStage ||
          concludedRecoveryStage !== null;
        return entry.cycle === entry.incident.cycle &&
          entry.incident.status === "AUTO_INVESTIGATING" &&
          entry.incident.activeBatchId === input.batchId &&
          (playbook.conclusion === "INCOMPLETE" ||
            concludedRecoveryStage !== null) &&
          stage !== null &&
          stage === remediationDirective?.playbookStage &&
          grantableStageState &&
          entry.verificationRequests.length === 0
          ? [
              {
                entry,
                stage,
                deadlineAt: getCourseMonitoringEscalationDeadline(
                  databaseNow,
                  entry.incident.activeRealSearchCount,
                ),
              },
            ]
          : [];
      });
      if (targets.length === 0) {
        return {
          outcome: "NO_GRANTABLE_STAGE" as const,
          granted: false,
          replayed: false,
          grantedIncidentCount: 0,
        };
      }

      const prospectiveDeadlineByBatchIncidentId = new Map(
        targets.map((target) => [target.entry.id, target.deadlineAt] as const),
      );
      const unsafeEndpointPeer = batch.incidents.some((entry) => {
        const terminalProofDurable =
          entry.result === "FINAL_DISPOSITION" &&
          isDurableTerminalProof(
            {
              ...entry,
              normalizedResult: entry.result,
            },
            batch,
          );
        if (terminalProofDurable) {
          return false;
        }
        const prospectiveDeadline =
          prospectiveDeadlineByBatchIncidentId.get(entry.id) ??
          entry.incident.escalationDeadlineAt;
        const prospectiveDeadlineTime = prospectiveDeadline?.getTime();
        return (
          prospectiveDeadlineTime !== undefined &&
          Number.isFinite(prospectiveDeadlineTime) &&
          prospectiveDeadlineTime <= databaseNow.getTime()
        );
      });
      if (unsafeEndpointPeer) {
        return {
          outcome: "EXPIRED_UNGRANTABLE_PEER" as const,
          granted: false,
          replayed: false,
          grantedIncidentCount: 0,
        };
      }

      for (const target of targets) {
        const { incident } = target.entry;
        const updated = await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            revision: incident.revision,
            status: "AUTO_INVESTIGATING",
            activeBatchId: input.batchId,
            attemptCount: incident.attemptCount,
            attemptLedger: {
              equals:
                incident.attemptLedger === null
                  ? Prisma.DbNull
                  : incident.attemptLedger,
            },
            batchIncidents: {
              some: {
                id: target.entry.id,
                batchId: input.batchId,
                incidentId: incident.id,
                cycle: target.entry.cycle,
                verificationRequests: { none: {} },
              },
            },
          },
          data: {
            escalationDeadlineAt: target.deadlineAt,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          throw new Error(
            "Course-support incident stage changed or a verification request was created during its verification deadline grant.",
          );
        }
      }

      const stageGrants = Array.from(
        targets.reduce((grants, target) => {
          const key = `${target.entry.cycle}:${target.stage}:${target.deadlineAt.toISOString()}`;
          const current = grants.get(key);
          grants.set(key, {
            cycle: target.entry.cycle,
            stage: target.stage,
            deadlineAt: target.deadlineAt.toISOString(),
            incidentCount: (current?.incidentCount ?? 0) + 1,
          });
          return grants;
        }, new Map<string, { cycle: number; stage: AutomationPlaybookStage; deadlineAt: string; incidentCount: number }>()),
      ).map(([, grant]) => grant);
      const marker = {
        schemaVersion: 1,
        grantedAt: databaseNow.toISOString(),
        incidentCount: targets.length,
        stages: stageGrants,
      } satisfies Prisma.InputJsonObject;
      const ownership = await transaction.courseSupportBatch.updateMany({
        where: {
          id: input.batchId,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: batch.status,
          revision: batch.revision,
          leaseExpiresAt: { gt: databaseNow },
          summary: {
            equals: batch.summary === null ? Prisma.DbNull : batch.summary,
          },
        },
        data: {
          summary: {
            ...summary,
            [COURSE_SUPPORT_VERIFICATION_STAGE_DEADLINE_GRANT_KEY]: marker,
          } as Prisma.InputJsonObject,
          revision: { increment: 1 },
        },
      });
      if (ownership.count !== 1) {
        throw new Error(
          "Course-support batch ownership or directive changed during its verification deadline grant.",
        );
      }

      return {
        outcome: "GRANTED" as const,
        granted: true,
        replayed: false,
        grantedIncidentCount: targets.length,
        grantedAt: marker.grantedAt,
      };
    },
  );
}

export async function getCourseSupportBatchPacket(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    select: {
      reference: true,
      providerFamilyKey: true,
      failureFingerprint: true,
      createdAt: true,
      summary: true,
      releaseSha: true,
      deployedAt: true,
      recheckDispatchStartedAt: true,
      incidents: {
        orderBy: [
          { course: { name: "asc" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          createdAt: true,
          cycle: true,
          result: true,
          proofSnapshot: true,
          verifiedAt: true,
          verifiedIncidentUpdatedAt: true,
          course: {
            select: {
              ...DETACHED_VERIFICATION_COURSE_SELECT,
            },
          },
          incident: {
            select: {
              cycle: true,
              kind: true,
              providerFamilyKey: true,
              failureClass: true,
              engineeringOnly: true,
              activeRealSearchCount: true,
              earliestTargetDate: true,
              escalationDeadlineAt: true,
              attemptCount: true,
              attemptLedger: true,
              latestMessage: true,
              nextAction: true,
              firstSeenAt: true,
              lastSeenAt: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost.",
    };
  }
  const remediationDirective = readCourseSupportRemediationDirective(
    batch.summary,
  );
  return {
    outcome: "ready" as const,
    batchRef: batch.reference,
    providerFamilyKey: batch.providerFamilyKey,
    providerFamilyCategory: getReportSafeProviderFamilyCategory(
      batch.providerFamilyKey,
    ),
    failureFingerprint: batch.failureFingerprint,
    claimedAt: batch.createdAt.toISOString(),
    remediation: remediationDirective,
    courses: orderCourseSupportBatchIncidents(batch.incidents).map(
      (entry, index) => {
        const claimedActionPlan =
          readCourseSupportRemediationClaimAttempt({
            summary: batch.summary,
            courseId: entry.course.id,
            expectedAttemptCount: batch.incidents.length,
          })?.actionPlan ?? null;
        const currentProviderSnapshotFingerprint =
          buildCourseSupportProviderSnapshotFingerprint(entry.course);
        const terminalProofDurable =
          (entry.result === "RESTORED" ||
            entry.result === "FINAL_DISPOSITION") &&
          isDurableTerminalProof(
            {
              ...entry,
              currentProviderSnapshotFingerprint,
              normalizedResult: entry.result,
            },
            batch,
          );
        const playbook = assessAutomationPlaybook(
          entry.incident.attemptLedger,
          entry.cycle,
        );
        const playbookAssessmentAvailable =
          playbook.valid && playbook.cycle === entry.cycle;
        return {
          ordinal: String(index + 1).padStart(2, "0"),
          actionPlan: claimedActionPlan,
          providerFamilyKey: entry.course.providerFamilyKey,
          providerFamilyCategory: getReportSafeProviderFamilyCategory(
            entry.course.providerFamilyKey,
          ),
          detectedPlatform: entry.course.detectedPlatform,
          failureClass: entry.incident.failureClass,
          kind: entry.incident.kind,
          result: entry.result,
          terminalProofDurable,
          engineeringOnly: entry.incident.engineeringOnly,
          activeRealSearchCount: entry.incident.activeRealSearchCount,
          earliestTargetDate:
            entry.incident.earliestTargetDate?.toISOString().slice(0, 10) ??
            null,
          escalationDeadlineAt:
            entry.incident.escalationDeadlineAt?.toISOString() ?? null,
          attemptCount: entry.incident.attemptCount,
          playbookAssessmentStatus: playbookAssessmentAvailable
            ? ("AVAILABLE" as const)
            : ("UNAVAILABLE" as const),
          playbookExhausted: playbookAssessmentAvailable
            ? isAutomationPlaybookExhausted(
                entry.incident.attemptLedger,
                entry.cycle,
              )
            : null,
          playbookConclusion: playbookAssessmentAvailable
            ? playbook.conclusion
            : null,
          nextPlaybookStage: playbookAssessmentAvailable
            ? playbook.nextStage
            : null,
          nextPlaybookStageAttemptCount: playbookAssessmentAvailable
            ? (getCourseSupportNextStageAttemptCount(playbook) ?? null)
            : null,
          bookingMethod: entry.course.bookingMethod,
          automationEligibility: entry.course.automationEligibility,
          automationReason: entry.course.automationReason,
          officialSiteRoot: getSafePublicRoot(entry.course.website),
          officialBookingRoot: getSafePublicRoot(
            entry.course.detectedBookingUrl,
          ),
          latestEvidence: sanitizeResponderText(
            entry.incident.latestMessage ??
              "No bounded failure message was recorded.",
          ),
          nextAction: entry.incident.nextAction
            ? sanitizeResponderText(entry.incident.nextAction)
            : null,
          firstSeenAt: entry.incident.firstSeenAt.toISOString(),
          lastSeenAt: entry.incident.lastSeenAt.toISOString(),
        };
      },
    ),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "The responder batch is still in progress.",
  };
}

const COURSE_SUPPORT_SOURCE_SEARCH_READ_PATH = "CODEX_EXACT_SOURCE_SEARCH";
const courseSupportSourceSearchBatchSelect = {
  status: true,
  revision: true,
  leaseExpiresAt: true,
  summary: true,
  incidents: {
    orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      cycle: true,
      result: true,
      updatedAt: true,
      course: {
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          stateCode: true,
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
          bookingMetadata: true,
          monitoringMode: true,
          bookingAccessMode: true,
          intelligenceVerifiedAt: true,
          intelligenceReviewAt: true,
          intelligenceConfidence: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
          updatedAt: true,
          monitoringStatus: { select: { state: true } },
        },
      },
      incident: {
        select: {
          id: true,
          cycle: true,
          revision: true,
          status: true,
          kind: true,
          providerFamilyKey: true,
          failureClass: true,
          failureFingerprint: true,
          activeBatchId: true,
          attemptLedger: true,
          attemptCount: true,
          lastSeenAt: true,
          resolution: true,
          updatedAt: true,
        },
      },
    },
  },
} satisfies Prisma.CourseSupportBatchSelect;

type CourseSupportSourceSearchBatch = Prisma.CourseSupportBatchGetPayload<{
  select: typeof courseSupportSourceSearchBatchSelect;
}>;

export async function getOwnedCourseSupportSourceSearchContext(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  validateCourseSupportSourceSearchOrdinal(input.ordinal);
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    select: courseSupportSourceSearchBatchSelect,
  });
  if (!batch) {
    return courseSupportSourceSearchRecoveryRequired();
  }
  const resolved = resolveOwnedCourseSupportSourceSearchEntry({
    batchId: input.batchId,
    batch,
    ordinal: input.ordinal,
    requireRenderedStage: true,
  });
  if (resolved.outcome !== "ready") {
    return courseSupportSourceSearchControlResult(input.ordinal, resolved);
  }
  return {
    outcome: "ready" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    searchBudget: 1 as const,
    privateContext: {
      query: resolved.searchContext.query,
      attemptRef: resolved.attemptRef,
    },
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason:
      "The owned responder must perform one exact read-only source search.",
  };
}

export async function recordOwnedCourseSupportSourceSearchResult(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  attemptRef: string;
  candidateUrl?: string | null;
  noUnique?: boolean;
  runtimeVersion: string;
  now?: Date;
}) {
  validateCourseSupportSourceSearchOrdinal(input.ordinal);
  if (!/^[a-f0-9]{64}$/u.test(input.attemptRef)) {
    throw new Error("Source-search attempt reference is invalid.");
  }
  const result = normalizeCourseSupportSourceSearchResult({
    candidateUrl: input.candidateUrl,
    noUnique: input.noUnique,
  });
  const persisted = await runCourseSupportSerializableTransactionWithRetry(
    async (transaction) => {
      const databaseNow =
        input.now ?? (await getCourseSupportDatabaseNow(transaction));
      const batch = await transaction.courseSupportBatch.findFirst({
        where: {
          id: input.batchId,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { gt: databaseNow },
        },
        select: courseSupportSourceSearchBatchSelect,
      });
      if (!batch) {
        return null;
      }
      const resolved = resolveOwnedCourseSupportSourceSearchEntry({
        batchId: input.batchId,
        batch,
        ordinal: input.ordinal,
        requireRenderedStage: false,
      });
      if (resolved.outcome !== "ready") {
        return resolved;
      }
      if (resolved.attemptRef !== input.attemptRef) {
        throw new Error(
          "Source-search context changed before the result was recorded.",
        );
      }
      const idempotencyKey = `course-support-source-search:${resolved.attemptRef}`;
      const existing = await transaction.courseMonitoringEvent.findUnique({
        where: { idempotencyKey },
        select: { evidenceUrl: true, audit: true },
      });
      if (existing) {
        if (!doesCourseSupportSourceSearchEventMatch(existing, result)) {
          throw new Error(
            "A different source-search result already owns this incident cycle.",
          );
        }
        return {
          outcome: "recorded" as const,
          replayed: true,
          leaseExpiresAt: batch.leaseExpiresAt,
          result: result.result,
        };
      }
      if (
        resolved.claimedAttempt !== null &&
        resolved.claimedAttempt.playbookEventCountAtClaim !==
          countCourseSupportPlaybookEvents({
            attemptLedger: resolved.entry.incident.attemptLedger,
            cycle: resolved.entry.cycle,
          })
      ) {
        return courseSupportSourceSearchRouteChanged();
      }
      if (resolved.playbook.nextStage !== "RENDERED_BROWSER_DISCOVERY") {
        throw new Error(
          "Exact source search is not the current owned playbook step.",
        );
      }
      if (
        !(await lockOwnedCourseSupportSourceSearchSnapshot(
          transaction,
          input.batchId,
          resolved.entry,
        ))
      ) {
        throw new Error(
          "Course-support source state changed during exact source search.",
        );
      }

      const leaseExpiresAt = new Date(
        databaseNow.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
      );
      const ownership = await transaction.courseSupportBatch.updateMany({
        where: {
          id: input.batchId,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: batch.status,
          revision: batch.revision,
          leaseExpiresAt: { gt: databaseNow },
        },
        data: {
          heartbeatAt: databaseNow,
          leaseExpiresAt,
          revision: { increment: 1 },
        },
      });
      if (ownership.count !== 1) {
        throw new Error(
          "Course-support batch ownership changed during exact source search.",
        );
      }

      if (result.result === "NO_UNIQUE") {
        const attemptLedger = appendNoUniqueCourseSupportSourceSearchLadder({
          attemptLedger: resolved.entry.incident.attemptLedger,
          cycle: resolved.entry.cycle,
          runtimeVersion: input.runtimeVersion,
          observedAt: databaseNow,
        });
        const incident = await transaction.courseSupportIncident.updateMany({
          where: {
            id: resolved.entry.incident.id,
            cycle: resolved.entry.cycle,
            revision: resolved.entry.incident.revision,
            status: "AUTO_INVESTIGATING",
            activeBatchId: input.batchId,
            updatedAt: resolved.entry.incident.updatedAt,
          },
          data: {
            attemptLedger,
            attemptCount: { increment: 1 },
            lastAttemptAt: databaseNow,
            latestMessage:
              "One bounded exact source search found no unique safe direct official candidate.",
            updatedAt: databaseNow,
            revision: { increment: 1 },
          },
        });
        if (incident.count !== 1) {
          throw new Error(
            "Course-support incident changed during exact source search.",
          );
        }
      }

      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: resolved.entry.course.id,
          incidentId: resolved.entry.incident.id,
          eventType: "AUTOMATION_ATTEMPTED",
          source: "COURSE_SUPPORT_RESPONDER",
          readPath: COURSE_SUPPORT_SOURCE_SEARCH_READ_PATH,
          message:
            result.result === "CANDIDATE"
              ? "One bounded exact source search selected a direct candidate for owned browser verification."
              : "One bounded exact source search found no unique safe direct candidate.",
          evidenceUrl: result.candidateUrl,
          runtimeVersion: input.runtimeVersion,
          idempotencyKey,
          audit: {
            schemaVersion: 1,
            action: "OWNED_EXACT_SOURCE_SEARCH",
            result: result.result,
            incidentCycle: resolved.entry.cycle,
            ordinal: input.ordinal,
            queryDigest: resolved.searchContext.queryDigest,
            missingIdentityFields: resolved.searchContext.missingIdentityFields,
            ownershipScopeDigest: resolved.scopeDigest,
            rawSearchPayloadStored: false,
            courseProjectionApplied: false,
            browserVerificationRequired: result.result === "CANDIDATE",
            independentConfirmationRecorded: result.result === "NO_UNIQUE",
            ...(await readCourseSupportCampaignProvenance(
              transaction,
              batch.summary,
              resolved.entry.course.id,
              resolved.entry.incident.id,
              resolved.entry.cycle,
              databaseNow,
            )),
          },
        },
      });
      return {
        outcome: "recorded" as const,
        replayed: false,
        leaseExpiresAt,
        result: result.result,
      };
    },
  );

  if (!persisted) {
    return courseSupportSourceSearchRecoveryRequired();
  }
  if (persisted.outcome !== "recorded") {
    return courseSupportSourceSearchControlResult(input.ordinal, persisted);
  }
  return {
    outcome: "ready" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    resultRecorded: true,
    candidateRecorded: persisted.result === "CANDIDATE",
    noUniqueRecorded: persisted.result === "NO_UNIQUE",
    replayed: persisted.replayed,
    browserVerificationRequired: persisted.result === "CANDIDATE",
    leaseExpiresAt: persisted.leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "The responder batch is still in progress.",
  };
}

function resolveOwnedCourseSupportSourceSearchEntry(input: {
  batchId: string;
  batch: CourseSupportSourceSearchBatch;
  ordinal: number;
  requireRenderedStage: boolean;
}) {
  const entry = orderCourseSupportBatchIncidents(input.batch.incidents)[
    input.ordinal - 1
  ];
  if (!entry) {
    return courseSupportSourceSearchActionNotApplicable(null);
  }
  const remediation = asJsonObject(asJsonObject(input.batch.summary).remediation);
  const hasPersistedAttempts = Array.isArray(remediation.attempts);
  const claimedAttempt = hasPersistedAttempts
    ? readCourseSupportRemediationClaimAttempt({
        summary: input.batch.summary,
        courseId: entry.course.id,
        expectedAttemptCount: input.batch.incidents.length,
      })
    : null;
  if (hasPersistedAttempts && !claimedAttempt) {
    return courseSupportSourceSearchRouteChanged();
  }
  if (
    claimedAttempt?.actionPlan &&
    !courseSupportActionPlanAllows(
      claimedAttempt.actionPlan,
      "SEARCH_FOR_OFFICIAL_SOURCE",
    )
  ) {
    return courseSupportSourceSearchActionNotApplicable(
      claimedAttempt.actionPlan.primaryAction,
    );
  }
  const playbook = assessAutomationPlaybook(
    entry.incident.attemptLedger,
    entry.cycle,
  );
  const officialIdentity = playbook.stages.find(
    (stage) => stage.stage === "OFFICIAL_IDENTITY",
  );
  const sourceActionTechnicallyEligible = claimedAttempt?.actionPlan
    ? isCourseSupportSourceSearchActionEligible({
        workMode: claimedAttempt.actionPlan.route.workMode,
        playbookStage: claimedAttempt.actionPlan.route.playbookStage,
        incidentProviderFamilyKey: entry.incident.providerFamilyKey,
        course: entry.course,
      })
    : Boolean(
        entry.incident.kind === "NEEDS_ADAPTER" &&
        entry.incident.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
        entry.course.monitoringMode !== "LOCAL_READER_ONLY" &&
        isExactSourceMissingProviderState(entry.course)
      );
  if (
    entry.result !== "PENDING" ||
    entry.cycle !== entry.incident.cycle ||
    entry.incident.status !== "AUTO_INVESTIGATING" ||
    entry.incident.activeBatchId !== input.batchId ||
    !sourceActionTechnicallyEligible ||
    (claimedAttempt !== null &&
      claimedAttempt.failureFingerprint !== entry.incident.failureFingerprint) ||
    (claimedAttempt !== null &&
      claimedAttempt.providerSnapshotFingerprint !==
        buildCourseSupportProviderSnapshotFingerprint(entry.course)) ||
    entry.incident.resolution !== null ||
    entry.course.monitoringStatus?.state === "FINAL_MANUAL" ||
    entry.course.monitoringStatus?.state === "FINAL_IDENTITY" ||
    !playbook.valid ||
    officialIdentity?.applicability !== "APPLICABLE" ||
    officialIdentity.attemptCount < 1 ||
    !officialIdentity.completedAt ||
    (input.requireRenderedStage &&
      claimedAttempt !== null &&
      claimedAttempt.playbookEventCountAtClaim !==
        countCourseSupportPlaybookEvents({
          attemptLedger: entry.incident.attemptLedger,
          cycle: entry.cycle,
        })) ||
    (input.requireRenderedStage && playbook.nextStage !== "RENDERED_BROWSER_DISCOVERY")
  ) {
    return claimedAttempt?.actionPlan
      ? courseSupportSourceSearchRouteChanged()
      : courseSupportSourceSearchActionNotApplicable(null);
  }
  const searchContext = buildCourseSupportSourceSearchContext(entry.course);
  const baseScopeDigest = buildCourseSupportSourceSearchScopeDigest({
    batchId: input.batchId,
    incidentId: entry.incident.id,
    cycle: entry.cycle,
  });
  const scopeDigest = claimedAttempt?.actionPlan
    ? createHash("sha256")
        .update(baseScopeDigest)
        .update("\0")
        .update(JSON.stringify(claimedAttempt.actionPlan))
        .digest("hex")
    : baseScopeDigest;
  return {
    outcome: "ready" as const,
    entry,
    claimedAttempt,
    playbook,
    searchContext,
    scopeDigest,
    attemptRef: buildCourseSupportSourceSearchAttemptRef({
      scopeDigest,
      queryDigest: searchContext.queryDigest,
      courseUpdatedAt: entry.course.updatedAt,
    }),
  };
}

async function readCourseSupportCampaignProvenance(
  transaction: Prisma.TransactionClient,
  summaryValue: unknown,
  courseId: string,
  incidentId: string,
  cycle: number,
  occurredAt: Date,
) {
  const summary = asJsonObject(summaryValue);
  const campaign = asJsonObject(summary.campaign);
  const courseRef = createCourseSupportRemediationCourseRef(courseId);
  const summaryAttempt =
    campaign.kind === "PARKED_COHORT" && Array.isArray(campaign.attempts)
      ? campaign.attempts.find((value) => {
          const entry = asJsonObject(value);
          return entry.courseRef === courseRef && entry.cycle === cycle;
        })
      : null;
  const summaryRecord = asJsonObject(summaryAttempt);
  if (
    typeof summaryRecord.runId === "string" &&
    summaryRecord.runId.trim() &&
    typeof summaryRecord.membershipDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(summaryRecord.membershipDigest)
  ) {
    return buildCourseSupportCampaignProvenance(
      summaryRecord.runId,
      summaryRecord.membershipDigest,
      cycle,
    );
  }

  const admission = await transaction.courseMonitoringEvent.findFirst({
    where: {
      courseId,
      incidentId,
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: { lte: occurredAt },
      AND: [
        { audit: { path: ["action"], equals: "parked_cohort_admission" } },
        { audit: { path: ["cycle"], equals: cycle } },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { audit: true },
  });
  const record = asJsonObject(admission?.audit);
  if (
    record.action !== "parked_cohort_admission" ||
    record.cycle !== cycle ||
    typeof record.campaignRunId !== "string" ||
    !record.campaignRunId.trim() ||
    typeof record.campaignMembershipDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.campaignMembershipDigest)
  ) {
    return {};
  }
  return buildCourseSupportCampaignProvenance(
    record.campaignRunId,
    record.campaignMembershipDigest,
    cycle,
  );
}

function buildCourseSupportCampaignProvenance(
  runId: string,
  membershipDigest: string,
  cycle: number,
) {
  return {
    campaign: {
      kind: "PARKED_COHORT" as const,
      runId,
      membershipDigest,
      cycle,
    },
  };
}

async function lockOwnedCourseSupportSourceSearchSnapshot(
  transaction: Prisma.TransactionClient,
  batchId: string,
  entry: CourseSupportSourceSearchBatch["incidents"][number],
) {
  const course = await transaction.$queryRaw<
    Array<{ locked: number }>
  >(Prisma.sql`
    SELECT 1 AS locked
    FROM "Course"
    WHERE id = ${entry.course.id}
      AND "updatedAt" = ${entry.course.updatedAt}
      AND website IS NULL
      AND "detectedBookingUrl" IS NULL
      AND "providerFamilyKey" = ${SOURCE_MISSING_PROVIDER_FAMILY}
      AND "monitoringMode" <> 'LOCAL_READER_ONLY'
    FOR UPDATE
  `);
  const incident = await transaction.$queryRaw<
    Array<{ locked: number }>
  >(Prisma.sql`
    SELECT 1 AS locked
    FROM "CourseSupportIncident"
    WHERE id = ${entry.incident.id}
      AND cycle = ${entry.cycle}
      AND revision = ${entry.incident.revision}
      AND status = 'AUTO_INVESTIGATING'
      AND "activeBatchId" = ${batchId}
      AND "updatedAt" = ${entry.incident.updatedAt}
    FOR UPDATE
  `);
  const batchEntry = await transaction.$queryRaw<
    Array<{ locked: number }>
  >(Prisma.sql`
    SELECT 1 AS locked
    FROM "CourseSupportBatchIncident"
    WHERE id = ${entry.id}
      AND cycle = ${entry.cycle}
      AND result = 'PENDING'
      AND "updatedAt" = ${entry.updatedAt}
    FOR UPDATE
  `);
  return course.length === 1 && incident.length === 1 && batchEntry.length === 1;
}

function appendNoUniqueCourseSupportSourceSearchLadder(input: {
  attemptLedger: unknown;
  cycle: number;
  runtimeVersion: string;
  observedAt: Date;
}) {
  let ledger = input.attemptLedger;
  const skippedStages = [
    {
      stage: "RENDERED_BROWSER_DISCOVERY",
      readPath: "RENDERED_BROWSER",
      skipReason: "NO_BROWSER_ROUTE",
    },
    {
      stage: "BROWSER_ADAPTER_RETRY",
      readPath: "TYPED_PROVIDER_ADAPTER",
      skipReason: "NO_METADATA_CHANGE",
    },
    {
      stage: "LOCAL_READER",
      readPath: "LOCAL_READER",
      skipReason: "NO_LOCAL_READER_CAPABILITY",
    },
  ] as const;
  for (const stage of skippedStages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: input.cycle,
      stage: stage.stage,
      transition: "NOT_APPLICABLE",
      readPath: stage.readPath,
      evidenceKind: "TOOLING",
      failureFingerprint: `SOURCE_MISSING:EXACT_SEARCH:${stage.stage}`,
      runtimeVersion: input.runtimeVersion,
      skipReason: stage.skipReason,
      note: "No safe source route exists for this ordered playbook stage.",
      observedAt: input.observedAt,
    });
  }
  return appendAutomationPlaybookEvent(ledger, {
    cycle: input.cycle,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "FAILED_TERMINAL",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "TOOLING",
    failureFingerprint: "SOURCE_MISSING:EXACT_SEARCH:NO_UNIQUE",
    runtimeVersion: input.runtimeVersion,
    failureClass: "MISSING_SOURCE",
    note: "One bounded best-available exact course identity search found no unique direct official source.",
    observedAt: input.observedAt,
  });
}

function doesCourseSupportSourceSearchEventMatch(
  event: { evidenceUrl: string | null; audit: unknown },
  result: ReturnType<typeof normalizeCourseSupportSourceSearchResult>,
) {
  const audit = asJsonObject(event.audit);
  return audit.result === result.result && event.evidenceUrl === result.candidateUrl;
}

function validateCourseSupportSourceSearchOrdinal(ordinal: number) {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error("Course-support ordinal must be a positive integer.");
  }
}

function courseSupportSourceSearchRecoveryRequired() {
  return {
    outcome: "recovery_required" as const,
    resultRecorded: false,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Responder batch ownership or lease freshness was lost.",
  };
}

type CourseSupportSourceSearchControl =
  | ReturnType<typeof courseSupportSourceSearchActionNotApplicable>
  | ReturnType<typeof courseSupportSourceSearchRouteChanged>;

function courseSupportSourceSearchControlResult(
  ordinal: number,
  result: CourseSupportSourceSearchControl,
) {
  return {
    ...result,
    ordinal: String(ordinal).padStart(2, "0"),
    resultRecorded: false as const,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason:
      result.outcome === "action_not_applicable"
        ? "Exact source search is not part of the claimed action plan."
        : "The claimed source-search action changed; refresh the owned packet before acting.",
  };
}

function courseSupportSourceSearchActionNotApplicable(
  assignedAction: CourseSupportClaimActionPlan["primaryAction"] | null,
) {
  return {
    outcome: "action_not_applicable" as const,
    reasonCode: "ACTION_PLAN_DISALLOWS_SOURCE_SEARCH" as const,
    assignedAction,
    packetRefreshRequired: false as const,
  };
}

function courseSupportSourceSearchRouteChanged() {
  return {
    outcome: "route_changed" as const,
    reasonCode: "CLAIMED_SOURCE_SEARCH_AUTHORITY_CHANGED" as const,
    assignedAction: null,
    packetRefreshRequired: true as const,
  };
}

export async function markCourseSupportBatchNeedsHuman(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  ordinal: number;
  evidence: string;
  nextAction: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
    throw new Error("Course-support ordinal must be a positive integer.");
  }
  const evidence = sanitizeRequiredResponderText(input.evidence, "evidence");
  const nextAction = sanitizeRequiredResponderText(
    input.nextAction,
    "required external action",
  );
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    select: {
      status: true,
      revision: true,
      incidents: {
        orderBy: [
          { course: { name: "asc" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          createdAt: true,
          incidentId: true,
          cycle: true,
          updatedAt: true,
          course: { select: { name: true } },
          incident: {
            select: {
              engineeringOnly: true,
              attemptLedger: true,
              status: true,
              activeBatchId: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });
  const entry = batch
    ? orderCourseSupportBatchIncidents(batch.incidents)[input.ordinal - 1]
    : undefined;
  if (!batch || !entry) {
    throw new Error(
      "Course-support ordinal is not present in the owned batch.",
    );
  }
  if (
    !isAutomationPlaybookExhausted(entry.incident.attemptLedger, entry.cycle)
  ) {
    throw new Error(
      "Course-support human escalation requires the current automation playbook cycle to exhaust every safe read path.",
    );
  }
  const leaseExpiresAt = new Date(
    now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
  );
  await prisma.$transaction(async (transaction) => {
    const ownership = await transaction.courseSupportBatch.updateMany({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt,
        revision: { increment: 1 },
      },
    });
    const incident = await transaction.courseSupportIncident.updateMany({
      where: {
        id: entry.incidentId,
        cycle: entry.cycle,
        status: "AUTO_INVESTIGATING",
        activeBatchId: input.batchId,
        updatedAt: entry.incident.updatedAt,
      },
      data: { latestMessage: evidence, nextAction, updatedAt: now },
    });
    const batchEntry = await transaction.courseSupportBatchIncident.updateMany({
      where: { id: entry.id, updatedAt: entry.updatedAt },
      data: {
        result: "NEEDS_HUMAN",
        postProbeId: null,
        message: `${evidence} Required external action: ${nextAction}`,
        proofSnapshot: Prisma.DbNull,
        verifiedIncidentUpdatedAt: now,
        verifiedAt: now,
      },
    });
    await transaction.courseSupportVerificationRequest.updateMany({
      where: {
        batchIncidentId: entry.id,
        status: {
          in: ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"],
        },
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "human_verification_superseded",
        updatedAt: now,
      },
    });
    if (
      ownership.count !== 1 ||
      incident.count !== 1 ||
      batchEntry.count !== 1
    ) {
      throw new Error(
        "Course-support state changed while recording human escalation.",
      );
    }
  });
  return {
    outcome: "needs_human" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    evidenceRecorded: true,
    nextActionRecorded: true,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "A concrete external action requires owner visibility.",
  };
}

const courseSupportHeartbeatBatchSelect = {
  createdAt: true,
  baseSha: true,
  status: true,
  revision: true,
  releaseSha: true,
  deployedAt: true,
  recheckDispatchKey: true,
  recheckDispatchStartedAt: true,
  recheckDispatchedAt: true,
  summary: true,
  incidents: {
    orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      result: true,
      message: true,
      proofSnapshot: true,
      verifiedIncidentUpdatedAt: true,
      verifiedAt: true,
      course: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.CourseSupportBatchSelect;

type CourseSupportHeartbeatBatch = Prisma.CourseSupportBatchGetPayload<{
  select: typeof courseSupportHeartbeatBatchSelect;
}>;

type CourseSupportHeartbeatInput = {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  status?: "IMPLEMENTING" | "VERIFYING";
  releaseSha?: string | null;
  deployedAt?: Date | null;
  releaseAdvanceProof?: CourseSupportReleaseAdvanceProof;
  ownerFailureCheckpoint?: {
    stage: "DEPLOYMENT_WAIT" | "VERIFICATION";
    failureDomain: "DEPLOYMENT" | "PRODUCTION_VERIFICATION" | "SLA";
    reasonCode:
      | "DEPLOYMENT_FAILED"
      | "DEPLOYMENT_TIMEOUT"
      | "DEPLOYMENT_TOOLING_FAILED"
      | "VERIFICATION_TOOLING_FAILED";
  };
  now?: Date;
};

export async function heartbeatCourseSupportBatch(
  input: CourseSupportHeartbeatInput,
) {
  const now = input.now ?? new Date();
  if (input.releaseSha) {
    validateGitSha(input.releaseSha, "release SHA");
  }
  if (input.deployedAt && !Number.isFinite(input.deployedAt.getTime())) {
    throw new Error("Deployment proof must be a valid timestamp.");
  }
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    select: courseSupportHeartbeatBatchSelect,
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      heartbeatRecorded: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost.",
    };
  }
  const initialPlan = prepareCourseSupportHeartbeat(batch, input);
  const initialWouldOwnCheckout = courseSupportBatchReservesCheckout({
    status: initialPlan.status,
    summary: batch.summary,
  });
  const persisted = initialWouldOwnCheckout
    ? await runWithCourseSupportWriterTransitionLease(() =>
        runCourseSupportTransactionWithRetry(async (transaction) => {
          const databaseNow = await getCourseSupportDatabaseNow(transaction);
          const current = await transaction.courseSupportBatch.findFirst({
            where: {
              id: input.batchId,
              leaseToken: input.leaseToken,
              ownerThreadId: input.ownerThreadId,
              status: { in: ACTIVE_BATCH_STATUSES },
              leaseExpiresAt: { gt: databaseNow },
            },
            select: courseSupportHeartbeatBatchSelect,
          });
          if (!current) {
            return null;
          }
          const plan = prepareCourseSupportHeartbeat(current, input);
          const wouldOwnCheckout = courseSupportBatchReservesCheckout({
            status: plan.status,
            summary: current.summary,
          });
          if (!wouldOwnCheckout) {
            return null;
          }
          const otherActiveBatches =
            await transaction.courseSupportBatch.findMany({
              where: {
                id: { not: input.batchId },
                status: { in: ACTIVE_BATCH_STATUSES },
                leaseExpiresAt: { gt: databaseNow },
              },
              select: { status: true, summary: true },
            });
          if (
            otherActiveBatches.some((candidate) =>
              courseSupportBatchReservesCheckout(candidate),
            )
          ) {
            return null;
          }
          return persistCourseSupportHeartbeat(
            transaction,
            input,
            current,
            plan,
            databaseNow,
            true,
          );
        }),
      )
    : {
        acquired: true as const,
        value: await runCourseSupportTransactionWithRetry((transaction) =>
          persistCourseSupportHeartbeat(
            transaction,
            input,
            batch,
            initialPlan,
            now,
            false,
          ),
        ),
      };
  const heartbeat = persisted.acquired ? persisted.value : null;
  return {
    outcome: heartbeat ? ("ready" as const) : ("recovery_required" as const),
    heartbeatRecorded: heartbeat !== null,
    status: heartbeat?.status ?? initialPlan.status,
    releaseSha: heartbeat?.releaseSha ?? null,
    releaseAdvanced: heartbeat?.releaseAdvanced ?? false,
    leaseExpiresAt: heartbeat?.leaseExpiresAt.toISOString() ?? null,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: heartbeat
      ? "The responder batch is still in progress."
      : "Responder batch ownership changed during heartbeat.",
  };
}

function prepareCourseSupportHeartbeat(
  batch: CourseSupportHeartbeatBatch,
  input: CourseSupportHeartbeatInput,
) {
  const summary = asJsonObject(batch.summary);
  const plannedPaths = readBatchPlannedPaths(batch.summary);
  const remediationDirective = readCourseSupportRemediationDirective(
    batch.summary,
  );
  const requestedDeploymentSha = input.releaseSha ?? batch.releaseSha;
  if (input.deployedAt && !requestedDeploymentSha) {
    throw new Error(
      "Deployment proof requires a persisted or requested release SHA.",
    );
  }
  if (
    batch.deployedAt &&
    input.deployedAt &&
    batch.deployedAt.getTime() !== input.deployedAt.getTime()
  ) {
    throw new Error(
      "Deployment time does not match the batch's persisted deployment.",
    );
  }
  if (
    input.releaseSha &&
    !batch.releaseSha &&
    input.releaseSha === batch.baseSha &&
    plannedPaths.length === 0 &&
    remediationDirective?.allowUnchangedRuntime === false
  ) {
    throw new Error(
      "This remediation route requires a reusable implementation or material change; unchanged-runtime verification is not allowed.",
    );
  }
  const releaseTransition = assessCourseSupportReleaseTransition({
    persistedReleaseSha: batch.releaseSha,
    requestedReleaseSha: input.releaseSha,
    expectedBranch: typeof summary.branch === "string" ? summary.branch : null,
    plannedPaths,
    advanceProof: input.releaseAdvanceProof,
  });
  if (releaseTransition.action === "REJECT") {
    throw new Error(releaseTransition.reasons.join(" "));
  }
  const releaseChanged =
    releaseTransition.action === "INITIAL" ||
    releaseTransition.action === "ADVANCE";
  const releaseProvenance =
    releaseChanged && input.releaseAdvanceProof
      ? normalizeCourseSupportReleaseProvenance(input.releaseAdvanceProof)
      : null;
  if (releaseChanged && remediationDirective?.requiresImplementationPath) {
    const expectedBranch =
      typeof summary.branch === "string" ? summary.branch : null;
    const committedPaths = releaseProvenance?.committedPaths ?? [];
    const reasons: string[] = [];
    if (!hasRuntimeBearingCourseSupportPath(plannedPaths)) {
      reasons.push("The implementation plan has no runtime-bearing path.");
    }
    if (!releaseProvenance || releaseProvenance.toSha !== input.releaseSha) {
      reasons.push(
        "The committed release proof does not match the requested SHA.",
      );
    }
    if (!releaseProvenance?.descendantVerified) {
      reasons.push("The committed release ancestry was not verified.");
    }
    if (!expectedBranch || releaseProvenance?.branch !== expectedBranch) {
      reasons.push(
        "The committed release branch does not match batch provenance.",
      );
    }
    if (committedPaths.length === 0) {
      reasons.push("The implementation release has no committed change.");
    }
    if (committedPaths.some((path) => !plannedPaths.includes(path))) {
      reasons.push("The implementation release contains an unplanned path.");
    }
    if (!hasRuntimeBearingCourseSupportPath(committedPaths)) {
      reasons.push(
        "The implementation release has no runtime-bearing committed change.",
      );
    }
    if (reasons.length > 0) {
      throw new Error(reasons.join(" "));
    }
  }
  const releaseAdvanced = releaseTransition.action === "ADVANCE";
  if (releaseAdvanced && input.status !== "VERIFYING") {
    throw new Error("A follow-up release must explicitly enter VERIFYING.");
  }
  if (releaseAdvanced && input.deployedAt) {
    throw new Error(
      "A follow-up release must be persisted before its deployment proof.",
    );
  }
  if (input.status === "IMPLEMENTING" && batch.status !== "IMPLEMENTING") {
    throw new Error(
      "Responder code changes must claim a planned path before entering IMPLEMENTING.",
    );
  }
  return {
    status: nextBatchStatus(batch.status, input.status),
    releaseAdvanced,
    releaseProvenance,
  };
}

async function persistCourseSupportHeartbeat(
  transaction: Prisma.TransactionClient,
  input: CourseSupportHeartbeatInput,
  batch: CourseSupportHeartbeatBatch,
  plan: ReturnType<typeof prepareCourseSupportHeartbeat>,
  now: Date,
  useStrictDatabaseTime: boolean,
) {
  const leaseExpiresAt = new Date(
    now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
  );
  const advancedReleaseSummary =
    plan.releaseAdvanced && batch.releaseSha && input.releaseSha
      ? buildCourseSupportReleaseHistory({
          summary: batch.summary,
          baseSha: batch.baseSha,
          previousReleaseSha: batch.releaseSha,
          previousDeployedAt: batch.deployedAt,
          previousRecheckDispatchKey: batch.recheckDispatchKey,
          previousRecheckDispatchStartedAt: batch.recheckDispatchStartedAt,
          previousRecheckDispatchedAt: batch.recheckDispatchedAt,
          previousIncidentVerifications: orderCourseSupportBatchIncidents(
            batch.incidents,
          ).map((entry, index) => ({
            ordinal: index + 1,
            courseRef: createCourseSupportRemediationCourseRef(entry.course.id),
            result: entry.result,
            message: entry.message,
            proofSnapshot: entry.proofSnapshot,
            verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
            verifiedAt: entry.verifiedAt,
            providerExecutionRecorded:
              hasCurrentCourseSupportProviderExecutionProof({
                proofSnapshot: entry.proofSnapshot,
                baseSha: batch.baseSha,
                releaseSha: batch.releaseSha!,
                claimedAt: batch.createdAt,
                recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
              }),
            providerExecutionAttemptRecorded:
              hasCourseSupportProviderExecutionAttemptEvidence({
                proofSnapshot: entry.proofSnapshot,
                baseSha: batch.baseSha,
                releaseSha: batch.releaseSha!,
                claimedAt: batch.createdAt,
                recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
              }),
            terminalExecutionRecorded:
              hasCurrentCourseSupportTerminalExecutionProof({
                result: entry.result,
                proofSnapshot: entry.proofSnapshot,
                verifiedAt: entry.verifiedAt,
              }),
          })),
          nextReleaseSha: input.releaseSha,
          advancedAt: now,
        })
      : null;
  const releaseSummary = plan.releaseProvenance
    ? {
        ...asJsonObject(advancedReleaseSummary ?? batch.summary),
        releaseProvenance: plan.releaseProvenance,
      }
    : advancedReleaseSummary;
  const summaryWithFailureCheckpoint = input.ownerFailureCheckpoint
    ? appendCourseSupportOwnerFailureCheckpoint({
        summary: releaseSummary ?? batch.summary,
        checkpoint: input.ownerFailureCheckpoint,
        recordedAt: now
      })
    : releaseSummary;
  const batchUpdated = await transaction.courseSupportBatch.updateMany({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: batch.status,
      revision: batch.revision,
      leaseExpiresAt: useStrictDatabaseTime ? { gt: now } : { gte: now },
      releaseSha: batch.releaseSha,
      deployedAt: batch.deployedAt,
    },
    data: {
      status: plan.status,
      heartbeatAt: now,
      leaseExpiresAt,
      releaseSha: input.releaseSha ?? batch.releaseSha,
      ...(plan.releaseAdvanced && batch.releaseSha && input.releaseSha
        ? {
            deployedAt: null,
            recheckDispatchKey: null,
            recheckDispatchStartedAt: null,
            recheckDispatchedAt: null,
          }
        : {}),
      ...(!plan.releaseAdvanced && input.deployedAt
        ? { deployedAt: input.deployedAt }
        : {}),
      ...(summaryWithFailureCheckpoint
        ? { summary: summaryWithFailureCheckpoint as Prisma.InputJsonValue }
        : {}),
      revision: { increment: 1 },
    },
  });
  if (batchUpdated.count !== 1) {
    return null;
  }
  if (plan.releaseAdvanced) {
    await transaction.courseSupportBatchIncident.updateMany({
      where: {
        batchId: input.batchId,
        result: { not: "NEEDS_HUMAN" },
      },
      data: {
        result: "PENDING",
        postProbeId: null,
        message: null,
        proofSnapshot: Prisma.DbNull,
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null,
      },
    });
  }
  return {
    status: plan.status,
    releaseSha: input.releaseSha ?? batch.releaseSha,
    releaseAdvanced: plan.releaseAdvanced,
    leaseExpiresAt,
  };
}

function appendCourseSupportOwnerFailureCheckpoint(input: {
  summary: unknown;
  checkpoint: NonNullable<CourseSupportHeartbeatInput["ownerFailureCheckpoint"]>;
  recordedAt: Date;
}) {
  const summary = asJsonObject(input.summary) as Prisma.InputJsonObject;
  const existing = Array.isArray(summary.ownerFailureCheckpoints)
    ? summary.ownerFailureCheckpoints
        .flatMap((value) => {
          const checkpoint = asJsonObject(value);
          if (
            checkpoint.schemaVersion !== 1 ||
            typeof checkpoint.recordedAt !== "string" ||
            typeof checkpoint.stage !== "string" ||
            typeof checkpoint.failureDomain !== "string" ||
            typeof checkpoint.reasonCode !== "string"
          ) {
            return [];
          }
          return [
            {
              schemaVersion: 1,
              recordedAt: checkpoint.recordedAt,
              stage: checkpoint.stage,
              failureDomain: checkpoint.failureDomain,
              reasonCode: checkpoint.reasonCode
            } satisfies Prisma.InputJsonObject
          ];
        })
        .slice(-9)
    : [];
  const nextCheckpoint = {
    schemaVersion: 1,
    recordedAt: input.recordedAt.toISOString(),
    stage: input.checkpoint.stage,
    failureDomain: input.checkpoint.failureDomain,
    reasonCode: input.checkpoint.reasonCode
  } satisfies Prisma.InputJsonObject;
  return {
    ...summary,
    ownerFailureCheckpoints: [...existing, nextCheckpoint]
  } satisfies Prisma.InputJsonObject;
}

export async function verifyCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  releaseSha?: string | null;
  deployedAt?: Date | null;
  signal?: AbortSignal;
  now?: Date;
}) {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  if (input.releaseSha) {
    validateGitSha(input.releaseSha, "release SHA");
  }
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    include: {
      incidents: {
        orderBy: [
          { course: { name: "asc" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        include: {
          incident: {
            select: {
              cycle: true,
              status: true,
              engineeringOnly: true,
              activeBatchId: true,
              firstSeenAt: true,
              lastSeenAt: true,
              attemptLedger: true,
              updatedAt: true,
            },
          },
          course: {
            select: {
              googlePlaceId: true,
              isPublic: true,
              bookingMethod: true,
              automationEligibility: true,
              automationReason: true,
              policyNotes: true,
              intelligenceVerifiedAt: true,
              intelligenceReviewAt: true,
              intelligenceConfidence: true,
              automationDiscoveries: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  status: true,
                  detectedPlatform: true,
                  bookingMethod: true,
                  bookingPhone: true,
                  automationEligibility: true,
                  automationReason: true,
                  sourceUrl: true,
                  bookingUrl: true,
                  apiEndpoint: true,
                  apiMetadata: true,
                  confidence: true,
                  evidence: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      verified: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost.",
    };
  }
  const releaseSha = input.releaseSha ?? batch.releaseSha;
  const deployedAt = input.deployedAt ?? batch.deployedAt;
  const remediationDirective = readCourseSupportRemediationDirective(
    batch.summary
  );
  if (
    batch.releaseSha &&
    input.releaseSha &&
    batch.releaseSha !== input.releaseSha
  ) {
    throw new Error(
      "Release SHA does not match the batch's persisted release.",
    );
  }
  assertCourseSupportImplementationVerificationReady({
    summary: batch.summary,
    baseSha: batch.baseSha,
    releaseSha,
    deployedAt,
  });
  if (
    releaseSha === batch.baseSha &&
    readBatchPlannedPaths(batch.summary).length === 0 &&
    remediationDirective?.allowUnchangedRuntime === false
  ) {
    throw new Error(
      "This remediation route requires a reusable implementation or material change; unchanged-runtime verification is not allowed.",
    );
  }
  if (deployedAt && !releaseSha) {
    throw new Error(
      "Fresh-runtime verification requires a persisted release SHA before deployment proof.",
    );
  }
  if (releaseSha && !deployedAt) {
    throw new Error(
      "Release verification requires deployment proof for the persisted SHA.",
    );
  }
  if (
    batch.deployedAt &&
    input.deployedAt &&
    batch.deployedAt.getTime() !== input.deployedAt.getTime()
  ) {
    throw new Error(
      "Deployment time does not match the batch's persisted deployment.",
    );
  }
  const courseIds = batch.incidents.map((entry) => entry.courseId);
  if (courseIds.length === 0) {
    throw new Error(
      "A responder batch without incident evidence cannot be verified.",
    );
  }
  const googlePlaceIds = [
    ...new Set(
      batch.incidents
        .map((entry) => entry.course.googlePlaceId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const activePlaceReviews = googlePlaceIds.length
    ? await prisma.googlePlaceReview.findMany({
        where: {
          googlePlaceId: { in: googlePlaceIds },
          active: true,
          accessOverride: { in: ["VERIFIED_PRIVATE", "VERIFIED_NON_COURSE"] },
        },
        select: {
          googlePlaceId: true,
          active: true,
          accessOverride: true,
          classification: true,
          evidenceUrl: true,
          reviewedAt: true,
          updatedAt: true,
        },
      })
    : [];
  const placeReviewByGooglePlaceId = new Map(
    activePlaceReviews.map((review) => [review.googlePlaceId, review]),
  );
  const persistedSearchHealth =
    releaseSha &&
    deployedAt &&
    batch.recheckDispatchStartedAt &&
    batch.recheckDispatchedAt
      ? await assessRemediatedSearchHealth(
          batch.id,
          courseIds,
          batch.recheckDispatchedAt,
          now,
          getAffectedSearchRefs(getPersistedRecheckDispatch(batch.summary)),
          releaseSha,
          deployedAt,
          batch.recheckDispatchKey,
          batch.recheckDispatchedAt,
        )
      : null;
  const verificationSearchExecutionFence =
    persistedSearchHealth?.searchExecutionFence ??
    (await readCourseSupportSearchExecutionFence(
      prisma,
      createCourseSupportSearchExecutionFenceInput({
        batchId: batch.id,
        courseIds,
        summary: batch.summary,
        recheckDispatchKey: batch.recheckDispatchKey,
        recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
        recheckDispatchedAt: batch.recheckDispatchedAt,
        now,
      }),
    ));
  const newestProbeByCourse = new Map<string, FreshProbeEvidence>();
  for (const courseId of courseIds) {
    const runnableProof =
      persistedSearchHealth?.freshProviderProofByCourse.get(courseId);
    const providerAttempt =
      persistedSearchHealth?.freshProviderAttemptByCourse.get(courseId);
    if (runnableProof) {
      newestProbeByCourse.set(courseId, {
        ...runnableProof,
        runnableCoverageProven: true,
      });
    } else if (providerAttempt) {
      newestProbeByCourse.set(courseId, {
        ...providerAttempt,
        runnableCoverageProven: false,
      });
    }
  }
  const detachedProofByBatchIncident = new Map(
    releaseSha && deployedAt
      ? await Promise.all(
          batch.incidents.map(
            async (entry) =>
              [
                entry.id,
                await getEligibleCourseSupportVerificationProof({
                  batchIncidentId: entry.id,
                  releaseSha,
                  now,
                }),
              ] as const,
          ),
        )
      : [],
  );
  const detachedFailureByBatchIncident = new Map(
    releaseSha && deployedAt
      ? await Promise.all(
          batch.incidents.map(
            async (entry) =>
              [
                entry.id,
                await getCurrentCourseSupportVerificationFailure({
                  batchIncidentId: entry.id,
                  releaseSha,
                  now,
                }),
              ] as const,
          ),
        )
      : [],
  );

  const currentDetachedFailureBatchIncidentIds = new Set<string>();
  const verifications: Array<{
    entry: (typeof batch.incidents)[number];
    verification: BatchIncidentVerification;
    providerExecutionAttemptRecorded: boolean;
  }> = batch.incidents.map((entry) => {
    const incidentCurrent =
      entry.incident.cycle === entry.cycle &&
      entry.incident.activeBatchId === batch.id &&
      entry.incident.status === "AUTO_INVESTIGATING";
    const latestDiscovery = entry.course.automationDiscoveries[0] ?? null;
    const explicitHumanVerification = incidentCurrent
      ? preserveExplicitHumanVerification({
          result: entry.result,
          engineeringOnly: entry.incident.engineeringOnly,
          postProbeId: entry.postProbeId,
          message: entry.message,
        })
      : null;
    const detachedVerification = incidentCurrent
      ? classifyDetachedVerificationEvidence({
          proof: detachedProofByBatchIncident.get(entry.id) ?? null,
          deployedAt,
          recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
          incidentLastSeenAt: entry.incident.lastSeenAt,
        })
      : null;
    const detachedFactualVerification =
      detachedVerification?.result === "FINAL_DISPOSITION"
        ? detachedVerification
        : null;
    const detachedFailure = incidentCurrent
      ? classifyDetachedVerificationFailure({
          failure: detachedFailureByBatchIncident.get(entry.id) ?? null,
          deployedAt,
          recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
          incidentLastSeenAt: entry.incident.lastSeenAt,
        })
      : null;
    if (detachedFailure) {
      currentDetachedFailureBatchIncidentIds.add(entry.id);
    }
    const currentCourseVerification = incidentCurrent
      ? classifyFreshBatchEvidence({
          batchCreatedAt: batch.createdAt,
          deployedAt,
          releaseSha,
          recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
          preProbeId: entry.preProbeId,
          newestProbe: newestProbeByCourse.get(entry.courseId),
          course: {
            ...entry.course,
            latestDiscovery,
            latestPlaceReview: entry.course.googlePlaceId
              ? (placeReviewByGooglePlaceId.get(entry.course.googlePlaceId) ??
                null)
              : null,
          },
          incidentFirstSeenAt: entry.incident.firstSeenAt,
          incidentLastSeenAt: entry.incident.lastSeenAt,
          now,
        })
      : null;
    const newestProviderVerification = incidentCurrent
      ? chooseNewestProviderVerificationEvidence({
          workflow: currentCourseVerification,
          detachedVerification,
          detachedFailure,
        })
      : null;
    const workflowProviderAttempt = newestProbeByCourse.get(entry.courseId);
    const providerExecutionAttemptRecorded = Boolean(
      incidentCurrent &&
      (verificationSearchExecutionFence.providerExecutionAttemptCourseIds.includes(
        entry.courseId,
      ) ||
        hasExactRuntimeBrowserProviderExecutionEvidence({
          attemptLedger: entry.incident.attemptLedger,
          cycle: entry.cycle,
          claimedAt: batch.createdAt,
          deployedAt,
          releaseSha,
        }) ||
        [
          workflowProviderAttempt
            ? buildProbeProofSnapshot(workflowProviderAttempt)
            : null,
          detachedVerification?.proofSnapshot ?? null,
          detachedFailure?.proofSnapshot ?? null,
        ].some(
          (proofSnapshot) =>
            proofSnapshot !== null &&
            hasCourseSupportProviderExecutionAttemptEvidence({
              proofSnapshot,
              baseSha: batch.baseSha,
              releaseSha,
              claimedAt: batch.createdAt,
              recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
            }),
        )),
    );
    return {
      entry,
      providerExecutionAttemptRecorded,
      verification: incidentCurrent
        ? detachedFactualVerification
          ? detachedFactualVerification
          : currentCourseVerification?.result === "FINAL_DISPOSITION"
            ? currentCourseVerification
            : (explicitHumanVerification ??
              newestProviderVerification ??
              currentCourseVerification ?? {
                result: "STALE_EVIDENCE" as const,
                postProbeId: null,
                message: "Current course verification evidence is unavailable.",
                proofSnapshot: null,
              })
        : {
            result: "STALE_EVIDENCE" as const,
            postProbeId: null,
            message:
              "The incident changed after this responder batch was claimed.",
            proofSnapshot: null,
          },
    };
  });
  const providerExecutionAttemptVerifications = verifications.filter(
    (candidate) => candidate.providerExecutionAttemptRecorded,
  );
  const verificationOrdinalByBatchIncidentId = new Map(
    batch.incidents.map((entry, index) => [entry.id, index + 1]),
  );
  const executionEver =
    providerExecutionAttemptVerifications.length > 0
      ? buildCourseSupportExecutionEverSummary({
          summary: batch.summary,
          baseSha: batch.baseSha,
          previousReleaseSha: releaseSha ?? batch.baseSha,
          previousDeployedAt: null,
          previousIncidentVerifications: verifications.map(
            ({ entry, providerExecutionAttemptRecorded }) => ({
              ordinal: verificationOrdinalByBatchIncidentId.get(entry.id) ?? 0,
              courseRef: createCourseSupportRemediationCourseRef(
                entry.courseId,
              ),
              providerExecutionRecorded: false,
              providerExecutionAttemptRecorded,
              terminalExecutionRecorded: false,
            }),
          ),
        })
      : null;
  const priorPersistedSearchExecutionFence =
    readPersistedCourseSupportSearchExecutionFence(
      asJsonObject(batch.summary).searchExecutionFence,
    );
  const summaryWithoutSearchExecutionFence = Object.fromEntries(
    Object.entries(asJsonObject(batch.summary)).filter(
      ([key]) => key !== "searchExecutionFence",
    ),
  ) as Prisma.InputJsonObject;
  const summaryAfterVerificationEvidence: Prisma.InputJsonObject = {
    ...summaryWithoutSearchExecutionFence,
    ...(executionEver ? { executionEver } : {}),
    ...(priorPersistedSearchExecutionFence
      ? { searchExecutionFence: priorPersistedSearchExecutionFence }
      : !batch.recheckDispatchedAt
        ? {
            searchExecutionFence: persistCourseSupportSearchExecutionFence(
              verificationSearchExecutionFence,
              now,
            ),
          }
        : {}),
  };
  const preliminaryRecheckVerifications = verifications.filter(
    ({ entry, verification }) =>
      entry.incident.cycle === entry.cycle &&
      entry.incident.activeBatchId === batch.id &&
      entry.incident.status === "AUTO_INVESTIGATING" &&
      !["FINAL_DISPOSITION", "RESTORED", "NEEDS_HUMAN"].includes(
        verification.result,
      ),
  );
  const preliminaryRecheckCourseIds = preliminaryRecheckVerifications.map(
    ({ entry }) => entry.courseId,
  );
  const shouldOwnRecheckDispatch = Boolean(
    releaseSha &&
    deployedAt &&
    preliminaryRecheckCourseIds.length > 0 &&
    !batch.recheckDispatchedAt,
  );
  const recheckDispatchKey =
    batch.recheckDispatchKey ??
    (shouldOwnRecheckDispatch ? randomUUID() : null);
  const recheckDispatchStartedAt =
    batch.recheckDispatchStartedAt ?? (shouldOwnRecheckDispatch ? now : null);
  const leaseExpiresAt = new Date(
    now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
  );
  input.signal?.throwIfAborted();
  await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
    input.signal?.throwIfAborted();
    const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
    input.signal?.throwIfAborted();
    const updated = await tx.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now },
        releaseSha: batch.releaseSha,
        deployedAt: batch.deployedAt,
      },
      data: {
        status: "VERIFYING",
        releaseSha,
        deployedAt,
        heartbeatAt: now,
        leaseExpiresAt,
        recheckDispatchKey,
        recheckDispatchStartedAt,
        summary: summaryAfterVerificationEvidence as Prisma.InputJsonValue,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new Error("Responder batch ownership changed during verification.");
    }
    for (const candidate of verifications) {
      const { entry } = candidate;
      let verification = candidate.verification;
      if (isDetachedRestoredVerification(verification)) {
        input.signal?.throwIfAborted();
        const detachedProofIsCurrent =
          await revalidateDetachedVerificationProof(tx, {
            batchId: batch.id,
            batchIncidentId: entry.id,
            incidentId: entry.incidentId,
            courseId: entry.courseId,
            cycle: entry.cycle,
            releaseSha: releaseSha ?? "",
            leaseToken: input.leaseToken,
            ownerThreadId: input.ownerThreadId,
            proofSnapshot: verification.proofSnapshot,
            now,
          });
        if (!detachedProofIsCurrent) {
          verification = {
            result: "STALE_EVIDENCE",
            postProbeId: null,
            message:
              "Detached provider verification changed before its atomic proof could be recorded.",
            proofSnapshot: null,
          };
          candidate.verification = verification;
        }
      }
      input.signal?.throwIfAborted();
      const entryUpdated = await tx.courseSupportBatchIncident.updateMany({
        where: {
          id: entry.id,
          result: entry.result,
          updatedAt: entry.updatedAt,
        },
        data: {
          result: verification.result,
          postProbeId: verification.postProbeId,
          message: sanitizeResponderText(verification.message),
          proofSnapshot:
            verification.proofSnapshot === null
              ? Prisma.DbNull
              : verification.proofSnapshot,
          verifiedIncidentUpdatedAt: entry.incident.updatedAt,
          verifiedAt: now,
        },
      });
      if (entryUpdated.count !== 1) {
        throw new Error("Responder evidence changed during verification.");
      }
    }
    if (courseMonitoringAvailable && releaseSha && deployedAt) {
      input.signal?.throwIfAborted();
      await tx.courseMonitoringEvent.createMany({
        data: batch.incidents.map((entry) => ({
          courseId: entry.courseId,
          incidentId: entry.incidentId,
          eventType: "DEPLOYMENT_VERIFIED" as const,
          source: "DEPLOYMENT" as const,
          runtimeVersion: releaseSha,
          deploymentSha: releaseSha,
          message:
            "The responder recorded the exact deployed release before fresh course verification.",
          idempotencyKey: `course-support-deployment:${batch.id}:${entry.id}:${releaseSha}`,
          occurredAt: deployedAt,
          audit: {
            batchRef: batch.reference,
            customerDataIncluded: false,
          },
        })),
        skipDuplicates: true,
      });
    }
    input.signal?.throwIfAborted();
  });

  const recheckVerifications = verifications.filter(
    ({ entry, verification }) =>
      entry.incident.cycle === entry.cycle &&
      entry.incident.activeBatchId === batch.id &&
      entry.incident.status === "AUTO_INVESTIGATING" &&
      !["FINAL_DISPOSITION", "RESTORED", "NEEDS_HUMAN"].includes(
        verification.result,
      ),
  );
  const recheckCourseIds = recheckVerifications.map(
    ({ entry }) => entry.courseId,
  );
  const recheckBatchIncidentIds = recheckVerifications.map(
    ({ entry }) => entry.id,
  );

  let recheckDispatch = getPersistedRecheckDispatch(batch.summary);
  let recheckDispatchedAt = batch.recheckDispatchedAt;
  let detachedDispatch: {
    attempted: boolean;
    eligibleCount: number;
    createdCount: number;
    ineligibleCount: number;
    ineligibleReasonCounts: Record<string, number>;
    dispatchError: boolean;
  } | null = null;
  if (releaseSha && deployedAt && recheckBatchIncidentIds.length > 0) {
    try {
      input.signal?.throwIfAborted();
      const scheduled = await withCourseSupportWriteConflictRetry(
        () => {
          input.signal?.throwIfAborted();
          return scheduleCourseSupportVerificationRequests({
            batchId: batch.id,
            releaseSha,
            batchIncidentIds: recheckBatchIncidentIds,
            signal: input.signal,
            now,
          });
        },
        { signal: input.signal },
      );
      input.signal?.throwIfAborted();
      detachedDispatch = {
        attempted: true,
        eligibleCount: scheduled.eligibleCount,
        createdCount: scheduled.createdCount,
        ineligibleCount: scheduled.ineligibleCount,
        ineligibleReasonCounts: scheduled.ineligibleReasonCounts ?? {},
        dispatchError: false,
      };
    } catch {
      input.signal?.throwIfAborted();
      detachedDispatch = {
        attempted: true,
        eligibleCount: 0,
        createdCount: 0,
        ineligibleCount: recheckBatchIncidentIds.length,
        ineligibleReasonCounts: {},
        dispatchError: true,
      };
    }
  }
  const detachedRequestStates = releaseSha
    ? await prisma.courseSupportVerificationRequest.findMany({
        where: {
          batchIncidentId: { in: batch.incidents.map((entry) => entry.id) },
          releaseSha,
        },
        select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
      })
    : [];
  const pendingDetachedContinuationBatchIncidentIds =
    getPendingDetachedContinuationBatchIncidentIds(batch.incidents);
  const detachedVerificationRerun = summarizeDetachedVerificationRerun({
    requests: detachedRequestStates,
    verificationByBatchIncidentId: new Map(
      verifications.map(({ entry, verification }) => [entry.id, verification]),
    ),
    currentFailureBatchIncidentIds: currentDetachedFailureBatchIncidentIds,
    pendingContinuationBatchIncidentIds:
      pendingDetachedContinuationBatchIncidentIds,
  });
  const assignedStageOrchestrationGapCount = recheckVerifications.filter(
    ({ entry }) => {
      const playbook = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.cycle
      );
      if (
        !isAssignedDetachedStageProgression({
          remediationDirective,
          playbookConclusion: playbook.conclusion,
          nextPlaybookStage: playbook.nextStage,
          nextPlaybookStageStatus: getCourseSupportNextStageStatus(playbook),
          nextPlaybookStageAttemptCount:
            getCourseSupportNextStageAttemptCount(playbook),
        })
      ) {
        return false;
      }
      return !detachedRequestStates.some(
        (request) =>
          request.batchIncidentId === entry.id &&
          (Boolean(request.startedAt) ||
            request.status === "QUEUED" ||
            request.status === "CHECKING" ||
            request.status === "RETRYABLE_FAILED")
      );
    }
  ).length;
  const detachedVerification = {
    ...detachedVerificationRerun,
    rerunNeeded:
      detachedVerificationRerun.rerunNeeded ||
      assignedStageOrchestrationGapCount > 0,
    assignedStageOrchestrationGapCount,
    schedulerIneligibleReasonCounts:
      detachedDispatch?.ineligibleReasonCounts ?? {},
    schedulerDispatchError: detachedDispatch?.dispatchError ?? false
  };
  const shouldDispatch = Boolean(
    recheckDispatchKey &&
    recheckDispatchStartedAt &&
    !recheckDispatchedAt &&
    recheckCourseIds.length > 0,
  );
  let expectedRevision = batch.revision + 1;
  if (shouldDispatch) {
    let scheduledSearches: Array<{
      searchId: string;
      searchRef: string;
      scheduleVersion: number;
    }> = [];
    try {
      input.signal?.throwIfAborted();
      const dispatched = await enqueueRemediatedCourseRechecks(
        recheckCourseIds,
        undefined,
        recheckDispatchKey ?? undefined,
        input.signal,
      );
      input.signal?.throwIfAborted();
      const dispatchComplete =
        dispatched.queuedCount === dispatched.affectedSearchCount &&
        dispatched.queueFailureCount === dispatched.directStartCount &&
        detachedDispatch?.dispatchError !== true;
      scheduledSearches = dispatched.scheduledSearches;
      recheckDispatch = {
        attempted: true,
        dispatchKeyPersisted: true,
        dispatchedAt: recheckDispatchStartedAt?.toISOString(),
        affectedSearchCount: dispatched.affectedSearchCount,
        queuedCount: dispatched.queuedCount,
        queueFailureCount: dispatched.queueFailureCount,
        directStartCount: dispatched.directStartCount,
        detachedVerificationEligibleCount: detachedDispatch?.eligibleCount ?? 0,
        detachedVerificationCreatedCount: detachedDispatch?.createdCount ?? 0,
        detachedVerificationIneligibleCount:
          detachedDispatch?.ineligibleCount ?? recheckCourseIds.length,
        detachedVerificationDispatchError:
          detachedDispatch?.dispatchError ?? false,
        detachedVerificationIneligibleReasonCounts:
          detachedVerification.schedulerIneligibleReasonCounts,
        detachedVerificationAssignedStageOrchestrationGapCount:
          detachedVerification.assignedStageOrchestrationGapCount,
        detachedVerificationPendingCount: detachedVerification.pendingCount,
        detachedVerificationRerunNeeded: detachedVerification.rerunNeeded,
        affectedSearchRefs: dispatched.affectedSearchRefs,
        dispatchError: !dispatchComplete,
      };
      if (dispatchComplete) {
        recheckDispatchedAt = now;
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      recheckDispatch = {
        attempted: true,
        dispatchedAt: now.toISOString(),
        affectedSearchCount: 0,
        queuedCount: 0,
        queueFailureCount: 0,
        detachedVerificationEligibleCount: detachedDispatch?.eligibleCount ?? 0,
        detachedVerificationCreatedCount: detachedDispatch?.createdCount ?? 0,
        detachedVerificationIneligibleCount:
          detachedDispatch?.ineligibleCount ?? recheckCourseIds.length,
        detachedVerificationDispatchError:
          detachedDispatch?.dispatchError ?? false,
        detachedVerificationIneligibleReasonCounts:
          detachedVerification.schedulerIneligibleReasonCounts,
        detachedVerificationAssignedStageOrchestrationGapCount:
          detachedVerification.assignedStageOrchestrationGapCount,
        detachedVerificationPendingCount: detachedVerification.pendingCount,
        detachedVerificationRerunNeeded: detachedVerification.rerunNeeded,
        dispatchError: true,
        error: sanitizeResponderText(
          error instanceof Error
            ? error.message
            : "Course-remediation recheck dispatch failed.",
        ),
      };
    }
    input.signal?.throwIfAborted();
    const persisted = await runCourseSupportTransactionWithRetry(async (tx) => {
      input.signal?.throwIfAborted();
      for (const search of scheduledSearches) {
        input.signal?.throwIfAborted();
        await tx.courseSupportBatchSearch.upsert({
          where: {
            batchId_searchRef: {
              batchId: batch.id,
              searchRef: search.searchRef,
            },
          },
          create: {
            batchId: batch.id,
            teeSearchId: search.searchId,
            searchRef: search.searchRef,
            scheduleVersion: search.scheduleVersion,
          },
          update: {
            teeSearchId: search.searchId,
            scheduleVersion: search.scheduleVersion,
          },
        });
      }
      input.signal?.throwIfAborted();
      const persistedBatch = await tx.courseSupportBatch.updateMany({
        where: {
          id: batch.id,
          leaseToken: input.leaseToken,
          ownerThreadId: input.ownerThreadId,
          status: "VERIFYING",
          revision: expectedRevision,
          recheckDispatchKey,
          recheckDispatchStartedAt,
          recheckDispatchedAt: null,
        },
        data: {
          recheckDispatchedAt,
          summary: {
            ...asJsonObject(summaryAfterVerificationEvidence),
            recheckDispatch,
          } as Prisma.InputJsonValue,
          revision: { increment: 1 },
        },
      });
      input.signal?.throwIfAborted();
      return persistedBatch;
    });
    if (persisted.count !== 1) {
      throw new Error("Responder recheck dispatch ownership changed.");
    }
    expectedRevision += 1;
  } else if (recheckDispatch) {
    recheckDispatch = {
      ...recheckDispatch,
      ...(detachedDispatch
        ? {
            detachedVerificationEligibleCount: detachedDispatch.eligibleCount,
            detachedVerificationCreatedCount: detachedDispatch.createdCount,
            detachedVerificationIneligibleCount:
              detachedDispatch.ineligibleCount,
            detachedVerificationDispatchError: detachedDispatch.dispatchError,
            detachedVerificationIneligibleReasonCounts:
              detachedVerification.schedulerIneligibleReasonCounts,
            detachedVerificationAssignedStageOrchestrationGapCount:
              detachedVerification.assignedStageOrchestrationGapCount,
          }
        : {}),
      detachedVerificationPendingCount: detachedVerification.pendingCount,
      detachedVerificationRerunNeeded: detachedVerification.rerunNeeded,
      dispatchError:
        recheckDispatch.dispatchError === true ||
        detachedDispatch?.dispatchError === true,
    };
  } else if (!recheckDispatch && recheckCourseIds.length === 0) {
    recheckDispatch = {
      attempted: false,
      affectedSearchCount: 0,
      queuedCount: 0,
      queueFailureCount: 0,
      detachedVerificationIneligibleReasonCounts:
        detachedVerification.schedulerIneligibleReasonCounts,
      detachedVerificationAssignedStageOrchestrationGapCount:
        detachedVerification.assignedStageOrchestrationGapCount,
      detachedVerificationPendingCount: detachedVerification.pendingCount,
      detachedVerificationRerunNeeded: detachedVerification.rerunNeeded,
      dispatchError: false,
      reason: "FINAL_DISPOSITION_ONLY",
    };
  }

  let verifiedSearchExecutionFence: CourseSupportSearchExecutionFenceSnapshot | null =
    verificationSearchExecutionFence;
  let searchExecutionFenceRerunNeeded =
    !verificationSearchExecutionFence.settled;
  if (recheckDispatchedAt && recheckDispatchStartedAt) {
    input.signal?.throwIfAborted();
    const health = await assessRemediatedSearchHealth(
      batch.id,
      courseIds,
      recheckDispatchedAt,
      now,
      getAffectedSearchRefs(recheckDispatch),
      releaseSha,
      deployedAt,
      recheckDispatchKey,
      recheckDispatchedAt,
    );
    const restoredCourseIds = verifications
      .filter(({ verification }) => verification.result === "RESTORED")
      .map(({ entry }) => entry.courseId);
    const detachedRestoredCourseIds = new Set(
      verifications
        .filter(
          ({ verification }) =>
            verification.result === "RESTORED" &&
            verification.proofSnapshot !== null &&
            typeof verification.proofSnapshot === "object" &&
            !Array.isArray(verification.proofSnapshot) &&
            (verification.proofSnapshot as Prisma.InputJsonObject).kind ===
              "PROVIDER_VERIFICATION",
        )
        .map(({ entry }) => entry.courseId),
    );
    const affectedCourseSearchPairCount = restoredCourseIds.reduce(
      (total, courseId) =>
        total +
        (health.affectedCourseSearchPairCountByCourse.get(courseId) ?? 0),
      0,
    );
    const healthyCourseSearchPairCount = restoredCourseIds.reduce(
      (total, courseId) =>
        total +
        (health.healthyCourseSearchPairCountByCourse.get(courseId) ?? 0),
      0,
    );
    const provenRunnableCourseCount = restoredCourseIds.filter(
      (courseId) =>
        health.freshProviderProofByCourse.has(courseId) ||
        detachedRestoredCourseIds.has(courseId),
    ).length;
    recheckDispatch = {
      ...(recheckDispatch ?? {}),
      attempted: true,
      dispatchedAt: recheckDispatchStartedAt.toISOString(),
      dispatchCompletedAt: recheckDispatchedAt.toISOString(),
      currentAffectedSearchCount: health.affectedSearchCount,
      healthySchedulerCount: health.healthySchedulerCount,
      freshSearchCheckCount: health.freshSearchCheckCount,
      restoredCourseCount: restoredCourseIds.length,
      provenRunnableCourseCount,
      affectedCourseSearchPairCount,
      healthyCourseSearchPairCount,
      courseOutcomeHealthComplete:
        provenRunnableCourseCount === restoredCourseIds.length &&
        healthyCourseSearchPairCount === affectedCourseSearchPairCount,
      schedulerHealthObservedAt: now.toISOString(),
      schedulerHealthComplete:
        health.searchExecutionFence.settled &&
        health.healthySchedulerCount === health.affectedSearchCount &&
        health.freshSearchCheckCount === health.affectedSearchCount,
    };
    const lockedFenceInput = createCourseSupportSearchExecutionFenceInput({
      batchId: batch.id,
      courseIds,
      summary: {
        ...asJsonObject(summaryAfterVerificationEvidence),
        recheckDispatch,
      },
      recheckDispatchKey,
      recheckDispatchStartedAt,
      recheckDispatchedAt,
      now,
    });
    const healthPersisted =
      await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
        input.signal?.throwIfAborted();
        await lockCourseSupportSearchExecutionFenceRows(tx, lockedFenceInput);
        const lockedFence = await readCourseSupportSearchExecutionFence(
          tx,
          lockedFenceInput,
        );
        const expectedFence = readPersistedCourseSupportSearchExecutionFence(
          asJsonObject(summaryAfterVerificationEvidence).searchExecutionFence,
        );
        const fenceMatches = Boolean(
          expectedFence &&
          courseSupportSearchExecutionFenceMatches(expectedFence, lockedFence),
        );
        const firstPostDispatchFence = Boolean(
          expectedFence &&
          expectedFence.batchSearchCount === 0 &&
          expectedFence.memberships.length === 0,
        );
        const fenceCanAdvance = Boolean(
          lockedFence.settled &&
          (!expectedFence ||
            firstPostDispatchFence ||
            canAdvanceCourseSupportSearchExecutionFence(
              expectedFence,
              lockedFence,
            )),
        );
        const searchExecutionMayHaveStartedCourseRefs = new Set(
          getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
            expectedFence,
            lockedFence,
          ),
        );
        const adoptedFence = {
          ...lockedFence,
          searchExecutionMayHaveStartedCourseRefs: [
            ...searchExecutionMayHaveStartedCourseRefs,
          ].sort(),
        };
        const executionEverAfterSearchFence =
          searchExecutionMayHaveStartedCourseRefs.size > 0
            ? buildCourseSupportExecutionEverSummary({
                summary: summaryAfterVerificationEvidence,
                baseSha: batch.baseSha,
                previousReleaseSha: releaseSha ?? batch.baseSha,
                previousDeployedAt: null,
                previousIncidentVerifications: verifications.map(
                  ({ entry, providerExecutionAttemptRecorded }) => {
                    const courseRef = createCourseSupportRemediationCourseRef(
                      entry.courseId,
                    );
                    return {
                      ordinal:
                        verificationOrdinalByBatchIncidentId.get(entry.id) ?? 0,
                      courseRef,
                      providerExecutionRecorded: false,
                      providerExecutionAttemptRecorded:
                        providerExecutionAttemptRecorded ||
                        searchExecutionMayHaveStartedCourseRefs.has(courseRef),
                      terminalExecutionRecorded: false,
                    };
                  },
                ),
              })
            : null;
        const persistedFence =
          fenceMatches || fenceCanAdvance
            ? persistCourseSupportSearchExecutionFence(adoptedFence, now)
            : (expectedFence ??
              persistCourseSupportSearchExecutionFence(lockedFence, now));
        verifiedSearchExecutionFence = lockedFence;
        searchExecutionFenceRerunNeeded = !fenceMatches;
        input.signal?.throwIfAborted();
        const persistedHealth = await tx.courseSupportBatch.updateMany({
          where: {
            id: batch.id,
            leaseToken: input.leaseToken,
            ownerThreadId: input.ownerThreadId,
            status: "VERIFYING",
            revision: expectedRevision,
            recheckDispatchKey,
            recheckDispatchStartedAt,
            recheckDispatchedAt,
          },
          data: {
            summary: {
              ...asJsonObject(summaryAfterVerificationEvidence),
              ...(executionEverAfterSearchFence
                ? { executionEver: executionEverAfterSearchFence }
                : {}),
              searchExecutionFence: persistedFence,
              recheckDispatch,
            } as Prisma.InputJsonValue,
            heartbeatAt: now,
            leaseExpiresAt,
            revision: { increment: 1 },
          },
        });
        input.signal?.throwIfAborted();
        return persistedHealth;
      });
    if (healthPersisted.count !== 1) {
      throw new Error(
        "Responder schedule-health evidence changed during verification.",
      );
    }
  }

  const counts = countVerificationResults(
    verifications.map(({ verification }) => verification.result),
  );
  return {
    outcome: "ready" as const,
    verified: true,
    releaseSha: releaseSha ?? null,
    deployedAt: deployedAt?.toISOString() ?? null,
    counts,
    detachedVerification,
    searchExecutionFence: verifiedSearchExecutionFence
      ? {
          settled: verifiedSearchExecutionFence.settled,
          rerunNeeded: searchExecutionFenceRerunNeeded,
        }
      : null,
    recheckDispatch,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Verification is recorded; durable batch closeout remains.",
  };
}

export type RemediatedProviderSearchEvidence = {
  status: string;
  scheduleVersion: number;
  dispatchedScheduleVersion: number;
  lastCheckedAt: Date | null;
  trafficClass?: string | null;
  courseIds: string[];
  probes: Array<FreshProbeEvidence & { courseId: string }>;
};

export function collectFreshRemediatedCourseProof(input: {
  searches: RemediatedProviderSearchEvidence[];
  courseIds: string[];
  releaseSha: string | null;
  deployedAt: Date | null;
  dispatchedAt: Date;
}) {
  const affectedCourseSearchPairCountByCourse = new Map<string, number>();
  const healthyCourseSearchPairCountByCourse = new Map<string, number>();
  const candidateProofsByCourse = new Map<string, FreshProbeEvidence[]>();
  const providerAttemptCandidatesByCourse = new Map<
    string,
    FreshProbeEvidence[]
  >();

  for (const search of input.searches) {
    const probesByCourse = new Map<string, FreshProbeEvidence[]>();
    for (const probe of search.probes) {
      const candidates = probesByCourse.get(probe.courseId) ?? [];
      candidates.push(probe);
      probesByCourse.set(probe.courseId, candidates);
    }
    const latestProbeByCourse = new Map<string, FreshProbeEvidence>();
    const ambiguousLatestProviderTimeByCourse = new Set<string>();
    for (const [courseId, candidates] of probesByCourse) {
      candidates.sort(compareFreshProbeEvidenceDescending);
      const newest = candidates[0];
      if (!newest) continue;
      latestProbeByCourse.set(courseId, newest);
      if (
        candidates.some(
          (candidate) =>
            getFreshProbeOrderingTime(candidate).getTime() ===
              getFreshProbeOrderingTime(newest).getTime() &&
            !haveSameFreshProbeMeaning(candidate, newest),
        )
      ) {
        ambiguousLatestProviderTimeByCourse.add(courseId);
      }
    }
    const freshSearchCheckedAt = search.lastCheckedAt;
    const scheduleIsCurrent =
      search.scheduleVersion >= search.dispatchedScheduleVersion;

    for (const courseId of new Set(search.courseIds)) {
      if (!input.courseIds.includes(courseId)) {
        continue;
      }
      const requiresCurrentCoverage = search.status === "ACTIVE";
      if (requiresCurrentCoverage) {
        affectedCourseSearchPairCountByCourse.set(
          courseId,
          (affectedCourseSearchPairCountByCourse.get(courseId) ?? 0) + 1,
        );
      }

      const probe = latestProbeByCourse.get(courseId);
      const freshProviderAttempts = search.probes.filter(
        (candidate) => {
          const providerObservedAt =
            getFreshProbeProviderObservedAt(candidate);
          return Boolean(
            candidate.courseId === courseId &&
              input.deployedAt &&
              scheduleIsCurrent &&
              freshSearchCheckedAt &&
              freshSearchCheckedAt.getTime() >= input.dispatchedAt.getTime() &&
              candidate.providerExecution &&
              providerObservedAt &&
              providerObservedAt.getTime() >= input.deployedAt.getTime() &&
              providerObservedAt.getTime() >= input.dispatchedAt.getTime(),
          );
        },
      );
      if (freshProviderAttempts.length > 0 && freshSearchCheckedAt) {
        const attempts = providerAttemptCandidatesByCourse.get(courseId) ?? [];
        attempts.push(
          ...freshProviderAttempts.map((candidate) => ({
            ...candidate,
            freshSearchCheckedAt,
            scheduleVersion: search.scheduleVersion,
            trafficClass: search.trafficClass ?? candidate.trafficClass ?? null,
          })),
        );
        providerAttemptCandidatesByCourse.set(courseId, attempts);
      }
      const providerExecutionObservedAt = probe
        ? getFreshProbeProviderObservedAt(probe)
        : null;
      const hasFreshRunnableProof = Boolean(
        input.releaseSha &&
        input.deployedAt &&
        scheduleIsCurrent &&
        freshSearchCheckedAt &&
        freshSearchCheckedAt.getTime() >= input.dispatchedAt.getTime() &&
        probe &&
        probe.runtimeVersion === input.releaseSha &&
        providerExecutionObservedAt &&
        providerExecutionObservedAt.getTime() >= input.deployedAt.getTime() &&
        providerExecutionObservedAt.getTime() >= input.dispatchedAt.getTime() &&
        probe.providerExecution &&
        !ambiguousLatestProviderTimeByCourse.has(courseId) &&
        SUCCESSFUL_PROBE_OUTCOMES.has(probe.outcome),
      );
      if (!hasFreshRunnableProof || !probe || !freshSearchCheckedAt) {
        continue;
      }

      const freshProof = {
        ...probe,
        freshSearchCheckedAt,
        scheduleVersion: search.scheduleVersion,
        trafficClass: search.trafficClass ?? probe.trafficClass ?? null,
      } satisfies FreshProbeEvidence;
      const candidates = candidateProofsByCourse.get(courseId) ?? [];
      candidates.push(freshProof);
      candidateProofsByCourse.set(courseId, candidates);
      if (requiresCurrentCoverage) {
        healthyCourseSearchPairCountByCourse.set(
          courseId,
          (healthyCourseSearchPairCountByCourse.get(courseId) ?? 0) + 1,
        );
      }
    }
  }

  const freshProviderProofByCourse = new Map<string, FreshProbeEvidence>();
  const freshProviderAttemptByCourse = new Map<string, FreshProbeEvidence>();
  for (const courseId of input.courseIds) {
    const providerAttempts =
      providerAttemptCandidatesByCourse.get(courseId) ?? [];
    providerAttempts.sort(compareFreshProbeEvidenceDescending);
    if (providerAttempts[0]) {
      freshProviderAttemptByCourse.set(courseId, providerAttempts[0]);
    }

    const affected = affectedCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const healthy = healthyCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const candidates = candidateProofsByCourse.get(courseId) ?? [];
    if (healthy !== affected || candidates.length === 0) {
      continue;
    }
    candidates.sort(compareFreshProbeEvidenceDescending);
    freshProviderProofByCourse.set(courseId, candidates[0]);
  }

  return {
    freshProviderProofByCourse,
    freshProviderAttemptByCourse,
    affectedCourseSearchPairCountByCourse,
    healthyCourseSearchPairCountByCourse,
  };
}

async function assessRemediatedSearchHealth(
  batchId: string,
  courseIds: string[],
  dispatchedAt: Date,
  now: Date,
  expectedSearchRefs: Map<string, number>,
  releaseSha: string | null,
  deployedAt: Date | null,
  recheckDispatchKey: string | null,
  recheckDispatchedAt: Date | null,
) {
  const { dispatches, snapshot: searchExecutionFence } =
    await loadCourseSupportSearchExecutionFence(prisma, {
      batchId,
      courseIds,
      expectedSearches: [...expectedSearchRefs].map(
        ([searchRef, scheduleVersion]) => ({
          searchRef,
          scheduleVersion,
        }),
      ),
      recheckDispatchKey,
      recheckDispatchStartedAt: dispatchedAt,
      recheckDispatchedAt,
      now,
    });
  const affectedDispatches = dispatches.filter((dispatch) => {
    const expectedVersion = expectedSearchRefs.get(dispatch.searchRef);
    return expectedVersion !== undefined &&
      dispatch.scheduleVersion === expectedVersion;
  });
  const healthySchedulerCount = affectedDispatches.filter((dispatch) => {
    if (!dispatch.teeSearch) {
      return isVerifiedSearchRemoval(dispatch, dispatchedAt);
    }
    if (dispatch.teeSearch.preferences.length === 0) {
      return dispatch.teeSearch.updatedAt.getTime() >= dispatchedAt.getTime();
    }
    if (dispatch.teeSearch.scheduleVersion < dispatch.scheduleVersion) {
      return false;
    }
    return isRemediatedSearchSchedulerHealthy(
      dispatch.teeSearch,
      dispatchedAt,
      now,
    );
  }).length;
  const freshSearchCheckCount = affectedDispatches.filter((dispatch) => {
    if (!dispatch.teeSearch) {
      return isVerifiedSearchRemoval(dispatch, dispatchedAt);
    }
    if (dispatch.teeSearch.preferences.length === 0) {
      return dispatch.teeSearch.updatedAt.getTime() >= dispatchedAt.getTime();
    }
    return Boolean(
      (dispatch.teeSearch.lastCheckedAt &&
        dispatch.teeSearch.lastCheckedAt.getTime() >= dispatchedAt.getTime()) ||
      (dispatch.teeSearch.status !== "ACTIVE" &&
        dispatch.teeSearch.updatedAt.getTime() >= dispatchedAt.getTime()),
    );
  }).length;
  const providerEvidence = collectFreshRemediatedCourseProof({
    searches: affectedDispatches.flatMap((dispatch) => {
      if (!dispatch.teeSearch) {
        return [];
      }
      return [
        {
          status: dispatch.teeSearch.status,
          scheduleVersion: dispatch.teeSearch.scheduleVersion,
          dispatchedScheduleVersion: dispatch.scheduleVersion,
          lastCheckedAt: dispatch.teeSearch.lastCheckedAt,
          trafficClass: dispatch.teeSearch.trafficClass,
          courseIds: dispatch.teeSearch.preferences.map(
            (preference) => preference.courseId,
          ),
          probes: dispatch.teeSearch.probes.map((probe) => ({
            id: probe.id,
            courseId: probe.courseId,
            outcome: probe.outcome,
            observedAt: probe.observedAt,
            runtimeVersion: probe.runtimeVersion,
            providerExecution: Boolean(
              getProviderExecutionEvidenceObservedAt({
                rawSummary: probe.rawSummary,
                probeObservedAt: probe.observedAt,
              }),
            ),
            providerExecutionObservedAt:
              getProviderExecutionEvidenceObservedAt({
                rawSummary: probe.rawSummary,
                probeObservedAt: probe.observedAt,
              }),
          })),
        },
      ];
    }),
    courseIds,
    releaseSha,
    deployedAt,
    dispatchedAt,
  });
  return {
    affectedSearchCount: affectedDispatches.length,
    healthySchedulerCount,
    freshSearchCheckCount,
    searchExecutionFence,
    ...providerEvidence,
  };
}

export function isVerifiedSearchRemoval(
  dispatch: {
    teeSearch: unknown | null;
    removedAt: Date | null;
    removalReason: string | null;
  },
  dispatchedAt: Date,
) {
  return Boolean(
    !dispatch.teeSearch &&
    dispatch.removalReason === "SEARCH_DELETED_BY_OWNER" &&
    dispatch.removedAt &&
    dispatch.removedAt.getTime() >= dispatchedAt.getTime(),
  );
}

export function isRemediatedSearchSchedulerHealthy(
  search: {
    status: string;
    workflowRunId: string | null;
    checkStatus: string;
    checkLeaseExpiresAt: Date | null;
    nextCheckAt: Date | null;
    updatedAt: Date;
  },
  dispatchedAt: Date,
  now: Date,
) {
  if (search.status !== "ACTIVE") {
    return search.updatedAt.getTime() >= dispatchedAt.getTime();
  }
  if (
    !search.workflowRunId ||
    isSearchScheduleWorkflowStartReservation(search.workflowRunId)
  ) {
    return false;
  }
  if (search.checkStatus === "WAITING") {
    return Boolean(
      search.nextCheckAt &&
      search.nextCheckAt.getTime() >=
        now.getTime() - SEARCH_TIMELINESS_GRACE_MS,
    );
  }
  if (search.checkStatus === "CHECKING") {
    return Boolean(
      search.checkLeaseExpiresAt &&
      search.checkLeaseExpiresAt.getTime() > now.getTime() &&
      search.updatedAt.getTime() >= now.getTime() - SEARCH_TIMELINESS_GRACE_MS,
    );
  }
  return false;
}

type CloseoutCourseSupportBatchInput = {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  signal?: AbortSignal;
  requestedOutcome?: ResponderOutcome;
  failureDomain?: ResponderFailureDomain;
  retryAfterSeconds?: number | null;
  summary?: unknown;
  verificationWatchMode?: "WATCH_SETTLED" | "EARLY_RETRY" | "ENDPOINT";
  now?: Date;
};

export function shouldContinueSettledCourseSupportRemediation(input: {
  remediationDirective: PersistedCourseSupportRemediationDirective | null;
  failureClass: CourseSupportFailureClass;
  attemptCount: number;
  playbookConclusion: ReturnType<typeof assessAutomationPlaybook>["conclusion"];
  nextPlaybookStage: AutomationPlaybookStage | null;
  nextPlaybookStageStatus?: ReturnType<
    typeof assessAutomationPlaybook
  >["stages"][number]["status"];
  nextPlaybookStageAttemptCount?: number;
}) {
  const assignedDetachedStage = isAssignedDetachedStageProgression({
    remediationDirective: input.remediationDirective,
    playbookConclusion: input.playbookConclusion,
    nextPlaybookStage: input.nextPlaybookStage,
    nextPlaybookStageStatus: input.nextPlaybookStageStatus,
    nextPlaybookStageAttemptCount: input.nextPlaybookStageAttemptCount,
  });
  if (
    input.playbookConclusion === "INCOMPLETE" &&
    (assignedDetachedStage ||
      ((input.nextPlaybookStage === "RENDERED_BROWSER_DISCOVERY" ||
        input.nextPlaybookStage === "INDEPENDENT_CONFIRMATION") &&
        input.nextPlaybookStageAttemptCount === 0))
  ) {
    // Reaching an assigned stage's endpoint before its first attempt or while
    // an explicit retry budget remains is an orchestration miss, not unchanged
    // course evidence and not proof that the safe playbook is exhausted.
    return true;
  }
  if (
    input.playbookConclusion === "INCOMPLETE" &&
    input.nextPlaybookStage &&
    (!input.remediationDirective ||
      input.nextPlaybookStage !== input.remediationDirective.playbookStage)
  ) {
    // A completed stage handing off to a different safe stage is progress, not
    // an unchanged provider retry. Keep the incident automatic so the bounded
    // playbook can reach an evidence-backed endpoint.
    return true;
  }
  if (TRANSIENT_FAILURE_CLASSES.has(input.failureClass)) {
    if (input.remediationDirective?.retryBudget) {
      // The persisted route budget was computed before this batch claimed its
      // current attempt. Continue only when at least one attempt remains after
      // consuming this one, including after a fresh-cycle material reopen.
      return input.remediationDirective.retryBudget.attemptsRemaining > 1;
    }
    if (
      input.remediationDirective &&
      input.remediationDirective.strategyAction !== "RETRY_PROVIDER"
    ) {
      // A structural route can observe a new transient provider failure. Give
      // that new classification one handoff so the next route can own a fresh,
      // bounded transient budget.
      return true;
    }
    return input.attemptCount < DEFAULT_COURSE_SUPPORT_TRANSIENT_RETRY_BUDGET;
  }
  if (input.remediationDirective) {
    return false;
  }
  return false;
}

function getCourseSupportNextStageAttemptCount(
  assessment: ReturnType<typeof assessAutomationPlaybook>,
) {
  return getCourseSupportNextStageAssessment(assessment)?.attemptCount;
}

function getCourseSupportNextStageStatus(
  assessment: ReturnType<typeof assessAutomationPlaybook>,
) {
  return getCourseSupportNextStageAssessment(assessment)?.status;
}

function getCourseSupportNextStageAssessment(
  assessment: ReturnType<typeof assessAutomationPlaybook>,
) {
  if (!assessment.nextStage) {
    return undefined;
  }
  return assessment.stages.find(
    (stage) => stage.stage === assessment.nextStage,
  );
}

export function buildCourseSupportCloseoutPlaybookDecisionBasis(input: {
  incidents: Array<{ cycle: number; attemptLedger: unknown }>;
}) {
  const assessments = input.incidents.map((entry) => ({
    cycle: entry.cycle,
    assessment: assessAutomationPlaybook(entry.attemptLedger, entry.cycle),
  }));
  const availableAssessments = assessments.filter(
    ({ cycle, assessment }) => assessment.valid && assessment.cycle === cycle,
  );
  const playbookAssessmentAvailableIncidentCount = availableAssessments.length;
  const playbookAssessmentInvalidIncidentCount =
    assessments.length - playbookAssessmentAvailableIncidentCount;
  const playbookAssessmentComplete =
    playbookAssessmentInvalidIncidentCount === 0;
  const incompleteAssessments = availableAssessments.filter(
    ({ assessment }) => assessment.conclusion === "INCOMPLETE",
  );
  const rawIncompleteStageAttempts = incompleteAssessments.map(
    ({ assessment }) => ({
      nextStage: assessment.nextStage,
      attemptCount: getCourseSupportNextStageAttemptCount(assessment),
    }),
  );
  const incompleteStageAttempts = rawIncompleteStageAttempts.flatMap((entry) =>
    entry.nextStage !== null &&
    entry.nextStage !== undefined &&
    Number.isSafeInteger(entry.attemptCount) &&
    (entry.attemptCount ?? -1) >= 0
      ? [
          {
            nextStage: entry.nextStage,
            attemptCount: entry.attemptCount as number,
          },
        ]
      : [],
  );
  const incompletePlaybookEvidenceComplete =
    playbookAssessmentComplete &&
    incompleteStageAttempts.length === rawIncompleteStageAttempts.length;
  const incompletePlaybookNextStageAttemptHistogram =
    incompletePlaybookEvidenceComplete
      ? Array.from(
          incompleteStageAttempts.reduce(
            (histogram, entry) => {
              const key = `${entry.nextStage}:${entry.attemptCount}`;
              const current = histogram.get(key);
              histogram.set(key, {
                nextStage: entry.nextStage,
                attemptCount: entry.attemptCount,
                incidentCount: (current?.incidentCount ?? 0) + 1,
              });
              return histogram;
            },
            new Map<
              string,
              {
                nextStage: AutomationPlaybookStage;
                attemptCount: number;
                incidentCount: number;
              }
            >(),
          ).values(),
        ).sort((left, right) => {
          const stageOrder =
            AUTOMATION_PLAYBOOK_STAGES.indexOf(left.nextStage) -
            AUTOMATION_PLAYBOOK_STAGES.indexOf(right.nextStage);
          return stageOrder !== 0
            ? stageOrder
            : left.attemptCount - right.attemptCount;
        })
      : null;

  return {
    playbookAssessmentAvailableIncidentCount,
    playbookAssessmentInvalidIncidentCount,
    playbookExhaustedCount: playbookAssessmentComplete
      ? availableAssessments.filter(({ assessment }) =>
          ["TECHNICAL_FINAL", "UNRESOLVED_EXHAUSTED"].includes(
            assessment.conclusion,
          ),
        ).length
      : null,
    incompletePlaybookCount: incompletePlaybookEvidenceComplete
      ? incompleteAssessments.length
      : null,
    zeroAttemptBrowserAdapterRetryCount: incompletePlaybookEvidenceComplete
      ? incompleteStageAttempts.filter(
          (entry) =>
            entry.nextStage === "BROWSER_ADAPTER_RETRY" &&
            entry.attemptCount === 0,
        ).length
      : null,
    incompletePlaybookNextStageAttemptHistogram,
  };
}

const COURSE_SUPPORT_DECISION_EXECUTION_EVIDENCE_KEYS = [
  "claimedImplementationPaths",
  "newReleaseRecorded",
  "deploymentRecorded",
  "postProbeRecorded",
  "providerAttemptRecorded",
  "providerExecutionAttemptRecorded",
  "playbookAttemptRecorded",
  "terminalResultRecorded",
  "providerExecutionStarted"
] as const;

const COURSE_SUPPORT_DECISION_ROUTING_REASONS = new Set<
  CourseSupportRemediationRoutingReason
>([
  "EXISTING_SUPPORT_READY",
  "TRANSIENT_RETRY_AVAILABLE",
  "TRANSIENT_RETRY_BUDGET_EXHAUSTED",
  "PLAYBOOK_STAGE_PENDING",
  "PLAYBOOK_EXHAUSTED",
  "NO_PLAYBOOK_STAGE_AVAILABLE",
  "IMPLEMENTATION_REQUIRED",
  "CLASSIFICATION_READY",
  "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
  "OPERATIONAL_RETRY_BUDGET_EXHAUSTED",
  "MATERIAL_CHANGE_REOPENED",
]);

type CourseSupportDecisionExecutionEvidence = Record<
  (typeof COURSE_SUPPORT_DECISION_EXECUTION_EVIDENCE_KEYS)[number],
  boolean
>;

type ExactCourseSupportDecisionAttempts = {
  planned: Record<string, unknown>;
  closeout: Record<string, unknown>;
};

function readExactCourseSupportDecisionExecutionEvidenceShape(
  value: unknown,
): CourseSupportDecisionExecutionEvidence | null {
  const evidence = asJsonObject(value);
  const keys = Object.keys(evidence);
  return keys.length === COURSE_SUPPORT_DECISION_EXECUTION_EVIDENCE_KEYS.length &&
    COURSE_SUPPORT_DECISION_EXECUTION_EVIDENCE_KEYS.every(
      (key) => typeof evidence[key] === "boolean",
    )
    ? (evidence as CourseSupportDecisionExecutionEvidence)
    : null;
}

function readExactCourseSupportDecisionAttempts(input: {
  courseId: string;
  plannedAttempts: unknown[];
  closeoutAttempts: unknown[];
}): ExactCourseSupportDecisionAttempts | null {
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const plannedMatches = input.plannedAttempts.filter(
    (candidate) => asJsonObject(candidate).courseRef === courseRef
  );
  const closeoutMatches = input.closeoutAttempts.filter(
    (candidate) => asJsonObject(candidate).courseRef === courseRef
  );
  if (plannedMatches.length !== 1 || closeoutMatches.length !== 1) {
    return null;
  }
  const planned = asJsonObject(plannedMatches[0]);
  const closeout = asJsonObject(closeoutMatches[0]);
  const plannedApproach =
    planned.approach === null ? null : parseCourseSupportRemediationApproach(planned.approach);
  const closeoutApproach =
    closeout.approach === null ? null : parseCourseSupportRemediationApproach(closeout.approach);
  const plannedApproachRecord = asJsonObject(planned.approach);
  const closeoutApproachRecord = asJsonObject(closeout.approach);
  const exactApproachKeys = ["workMode", "strategyAction", "playbookStage"];
  if (
    typeof planned.providerSnapshotFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(planned.providerSnapshotFingerprint) ||
    typeof planned.failureFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(planned.failureFingerprint) ||
    typeof planned.runtimeVersion !== "string" ||
    !/^[a-f0-9]{40}$/u.test(planned.runtimeVersion) ||
    !Number.isSafeInteger(planned.activeRealSearchCount) ||
    (planned.activeRealSearchCount as number) < 0 ||
    !Number.isSafeInteger(planned.playbookEventCountAtClaim) ||
    (planned.playbookEventCountAtClaim as number) < 0 ||
    !COURSE_SUPPORT_DECISION_ROUTING_REASONS.has(
      planned.reason as CourseSupportRemediationRoutingReason,
    ) ||
    !Object.prototype.hasOwnProperty.call(planned, "approach") ||
    (planned.approach !== null &&
      (!plannedApproach ||
        Object.keys(plannedApproachRecord).length !== exactApproachKeys.length ||
        !exactApproachKeys.every((key) =>
          Object.prototype.hasOwnProperty.call(plannedApproachRecord, key)
        ))) ||
    typeof closeout.providerSnapshotFingerprint !== "string" ||
    closeout.providerSnapshotFingerprint !== planned.providerSnapshotFingerprint ||
    typeof closeout.observedProviderSnapshotFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(closeout.observedProviderSnapshotFingerprint) ||
    closeout.failureFingerprint !== planned.failureFingerprint ||
    typeof closeout.observedFailureFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(closeout.observedFailureFingerprint) ||
    typeof closeout.runtimeVersion !== "string" ||
    !/^[a-f0-9]{40}$/u.test(closeout.runtimeVersion) ||
    closeout.activeRealSearchCount !== planned.activeRealSearchCount ||
    typeof closeout.consumed !== "boolean" ||
    typeof closeout.countsTowardOperationalNoProgress !== "boolean" ||
    !Object.prototype.hasOwnProperty.call(closeout, "approach") ||
    (closeout.approach !== null &&
      (!closeoutApproach ||
        Object.keys(closeoutApproachRecord).length !== exactApproachKeys.length ||
        !exactApproachKeys.every((key) =>
          Object.prototype.hasOwnProperty.call(closeoutApproachRecord, key)
        ))) ||
    !(
      (plannedApproach === null && closeoutApproach === null) ||
      isSameCourseSupportRemediationApproach(plannedApproach, closeoutApproach)
    )
  ) {
    return null;
  }
  return { planned, closeout };
}

function readExactCourseSupportDecisionExecutionEvidence(
  attempt: ExactCourseSupportDecisionAttempts
): CourseSupportDecisionExecutionEvidence | null {
  const exact = readExactCourseSupportDecisionExecutionEvidenceShape(
    attempt.closeout.executionEvidence,
  );
  if (!exact) {
    return null;
  }
  const assignedAdapterOrchestrationMiss =
    isCourseSupportAssignedAdapterOrchestrationMiss({
      approach: attempt.closeout.approach,
      executionEvidence: exact,
    });
  const consumed = assignedAdapterOrchestrationMiss
    ? false
    : exact.deploymentRecorded ||
      exact.providerAttemptRecorded ||
      exact.playbookAttemptRecorded ||
      exact.terminalResultRecorded;
  const countsTowardOperationalNoProgress = assignedAdapterOrchestrationMiss
    ? false
    : consumed || exact.providerExecutionAttemptRecorded;
  if (
    attempt.closeout.consumed !== consumed ||
    attempt.closeout.countsTowardOperationalNoProgress !== countsTowardOperationalNoProgress ||
    (exact.providerAttemptRecorded && !exact.providerExecutionAttemptRecorded)
  ) {
    return null;
  }
  return exact;
}

type CourseSupportDecisionRetryBudget = {
  maximumAttempts: number;
  attemptsCompleted: number;
  attemptsRemaining: number;
  exhausted: boolean;
};

function readCourseSupportDecisionRetryBudgetValue(
  record: Record<string, unknown>
):
  | { status: "NOT_APPLICABLE" }
  | { status: "AVAILABLE"; budget: CourseSupportDecisionRetryBudget }
  | { status: "UNAVAILABLE" } {
  if (!Object.prototype.hasOwnProperty.call(record, "retryBudget")) {
    return { status: "UNAVAILABLE" };
  }
  if (record.retryBudget === null) {
    return { status: "NOT_APPLICABLE" };
  }
  const budget = asJsonObject(record.retryBudget);
  const keys = Object.keys(budget);
  const maximumAttempts = budget.maximumAttempts;
  const attemptsCompleted = budget.attemptsCompleted;
  const attemptsRemaining = budget.attemptsRemaining;
  const exhausted = budget.exhausted;
  if (
    keys.length !== 4 ||
    !["maximumAttempts", "attemptsCompleted", "attemptsRemaining", "exhausted"].every((key) =>
      keys.includes(key)
    ) ||
    !Number.isSafeInteger(maximumAttempts) ||
    (maximumAttempts as number) <= 0 ||
    !Number.isSafeInteger(attemptsCompleted) ||
    (attemptsCompleted as number) < 0 ||
    !Number.isSafeInteger(attemptsRemaining) ||
    (attemptsRemaining as number) < 0 ||
    attemptsRemaining !==
      Math.max(0, (maximumAttempts as number) - (attemptsCompleted as number)) ||
    typeof exhausted !== "boolean" ||
    exhausted !== (attemptsCompleted as number) >= (maximumAttempts as number)
  ) {
    return { status: "UNAVAILABLE" };
  }
  return {
    status: "AVAILABLE",
    budget: {
      maximumAttempts: maximumAttempts as number,
      attemptsCompleted: attemptsCompleted as number,
      attemptsRemaining: attemptsRemaining as number,
      exhausted
    }
  };
}

function readExactCourseSupportDecisionRetryBudget(
  attempt: ExactCourseSupportDecisionAttempts
):
  | { status: "NOT_APPLICABLE" }
  | { status: "AVAILABLE"; budget: CourseSupportDecisionRetryBudget }
  | { status: "UNAVAILABLE" } {
  const planned = readCourseSupportDecisionRetryBudgetValue(attempt.planned);
  const closeout = readCourseSupportDecisionRetryBudgetValue(attempt.closeout);
  if (
    planned.status !== closeout.status ||
    planned.status === "UNAVAILABLE" ||
    closeout.status === "UNAVAILABLE"
  ) {
    return { status: "UNAVAILABLE" };
  }
  if (
    planned.status === "AVAILABLE" &&
    closeout.status === "AVAILABLE" &&
    (planned.budget.maximumAttempts !== closeout.budget.maximumAttempts ||
      planned.budget.attemptsCompleted !== closeout.budget.attemptsCompleted ||
      planned.budget.attemptsRemaining !== closeout.budget.attemptsRemaining ||
      planned.budget.exhausted !== closeout.budget.exhausted)
  ) {
    return { status: "UNAVAILABLE" };
  }
  return planned;
}

function readExactCourseSupportDecisionCooldown(
  attempt: ExactCourseSupportDecisionAttempts,
  now: Date
):
  | { status: "NOT_APPLICABLE" }
  | { status: "AVAILABLE"; active: boolean }
  | { status: "UNAVAILABLE" } {
  if (!Object.prototype.hasOwnProperty.call(attempt.closeout, "failureOnlyHandoffCooldownUntil")) {
    return { status: "UNAVAILABLE" };
  }
  const raw = attempt.closeout.failureOnlyHandoffCooldownUntil;
  if (raw === null) {
    return { status: "NOT_APPLICABLE" };
  }
  if (typeof raw !== "string") {
    return { status: "UNAVAILABLE" };
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw) {
    return { status: "UNAVAILABLE" };
  }
  return { status: "AVAILABLE", active: parsed.getTime() > now.getTime() };
}

function readExactPlannedDeferredFailureHandoff(planned: Record<string, unknown>):
  | { status: "NOT_APPLICABLE" }
  | {
      status: "AVAILABLE";
      signal: DeferredFailureHandoffSignal;
      admission: NonNullable<ReturnType<typeof parseDeferredFailureHandoffAdmission>>;
    }
  | null {
  const hasSignal = Object.prototype.hasOwnProperty.call(planned, "deferredFailureHandoffSource");
  const hasAdmission = Object.prototype.hasOwnProperty.call(
    planned,
    "deferredFailureHandoffAdmission"
  );
  if (!hasSignal && !hasAdmission) {
    return { status: "NOT_APPLICABLE" };
  }
  if (!hasSignal || !hasAdmission) {
    return null;
  }
  const signal = parseDeferredFailureHandoffSignal(planned.deferredFailureHandoffSource);
  const admission = parseDeferredFailureHandoffAdmission(planned.deferredFailureHandoffAdmission);
  return signal &&
    admission &&
    signal.state === "AVAILABLE" &&
    !signal.confirmationStarted &&
    admission.signalDigest === signal.signalDigest &&
    admission.sourceRecordDigest === signal.recordDigest &&
    admission.sourceBatchIncidentDigest === signal.sourceBatchIncidentDigest
    ? { status: "AVAILABLE", signal, admission }
    : null;
}

function readExactCourseSupportDecisionDeferredSignal(input: {
  courseId: string;
  batchIncidentId: string;
  attempt: ExactCourseSupportDecisionAttempts;
  closeoutAttempts: unknown[];
}):
  | { status: "AVAILABLE"; signalState: "AVAILABLE" | "CONSUMED" | null }
  | { status: "UNAVAILABLE" } {
  const planned = readExactPlannedDeferredFailureHandoff(input.attempt.planned);
  if (!planned) {
    return { status: "UNAVAILABLE" };
  }
  const closeout = input.attempt.closeout;
  const hasCloseoutArtifact = [
    "deferredFailureHandoff",
    "deferredFailureHandoffAdmission",
    "deferredFailureHandoffInvalidation"
  ].some((key) => Object.prototype.hasOwnProperty.call(closeout, key));
  const hasPlannedArtifact = [
    "deferredFailureHandoffSource",
    "deferredFailureHandoffAdmission"
  ].some((key) => Object.prototype.hasOwnProperty.call(input.attempt.planned, key));
  if (!hasCloseoutArtifact) {
    return hasPlannedArtifact || planned.status === "AVAILABLE"
      ? { status: "UNAVAILABLE" }
      : { status: "AVAILABLE", signalState: null };
  }
  const parsed = readExactDeferredFailureHandoffAttempt({
    summary: {
      closeout: { remediationAttempts: input.closeoutAttempts }
    },
    courseId: input.courseId
  });
  const closeoutMatchesPlannedCarrier =
    planned.status === "NOT_APPLICABLE"
      ? parsed?.admission === null
      : Boolean(
          parsed?.admission &&
          parsed.signal.signalDigest === planned.signal.signalDigest &&
          new Date(parsed.signal.eligibleAt).getTime() >=
            new Date(planned.signal.eligibleAt).getTime() &&
          parsed.signal.sourceProofDigest === planned.signal.sourceProofDigest &&
          parsed.signal.providerFamilyKey === planned.signal.providerFamilyKey &&
          parsed.signal.canonicalFailureFingerprint ===
            planned.signal.canonicalFailureFingerprint &&
          parsed.signal.observedFailureFingerprint === planned.signal.observedFailureFingerprint &&
          parsed.signal.claimedProviderSnapshotFingerprint ===
            planned.signal.claimedProviderSnapshotFingerprint &&
          parsed.signal.observedProviderSnapshotFingerprint ===
            planned.signal.observedProviderSnapshotFingerprint &&
          parsed.signal.runtimeVersion === planned.signal.runtimeVersion &&
          parsed.signal.cooldownExpiresAt === planned.signal.cooldownExpiresAt &&
          parsed.signal.providerNotBeforeAt === planned.signal.providerNotBeforeAt &&
          parsed.signal.sourceVerificationWatchMode ===
            planned.signal.sourceVerificationWatchMode &&
          parsed.signal.sourceResult === planned.signal.sourceResult &&
          parsed.admission.admittedAt === planned.admission.admittedAt &&
          parsed.admission.signalDigest === parsed.signal.signalDigest &&
          parsed.admission.sourceRecordDigest === parsed.signal.recordDigest &&
          parsed.admission.sourceBatchIncidentDigest === parsed.signal.sourceBatchIncidentDigest
        );
  if (
    !parsed ||
    !closeoutMatchesPlannedCarrier ||
    parsed.signal.sourceBatchIncidentDigest !==
      createDeferredFailureHandoffBatchIncidentDigest(input.batchIncidentId) ||
    input.attempt.closeout.failureOnlyHandoffCooldownUntil !== parsed.signal.cooldownExpiresAt ||
    input.attempt.closeout.failureFingerprint !== parsed.signal.canonicalFailureFingerprint ||
    input.attempt.closeout.observedFailureFingerprint !==
      parsed.signal.observedFailureFingerprint ||
    input.attempt.closeout.providerSnapshotFingerprint !==
      parsed.signal.claimedProviderSnapshotFingerprint ||
    input.attempt.closeout.observedProviderSnapshotFingerprint !==
      parsed.signal.observedProviderSnapshotFingerprint ||
    (parsed.signal.state === "AVAILABLE" && parsed.signal.confirmationStarted) ||
    (parsed.signal.state === "CONSUMED" &&
      (!parsed.admission || parsed.sourceKind !== "CONSUMED_CARRIER"))
  ) {
    return { status: "UNAVAILABLE" };
  }
  return { status: "AVAILABLE", signalState: parsed.signal.state };
}

export function buildCourseSupportCloseoutRemediationDecisionBasis(input: {
  incidents: Array<{ courseId: string; batchIncidentId: string }>;
  plannedAttempts: unknown[];
  closeoutAttempts: unknown[];
  now: Date;
}) {
  const expectedCourseRefs = new Set(
    input.incidents.map((entry) => createCourseSupportRemediationCourseRef(entry.courseId))
  );
  const incidentIdentitiesAreExact =
    input.incidents.every(
      (entry) =>
        entry.courseId.trim().length > 0 &&
        entry.batchIncidentId.trim().length > 0,
    ) &&
    new Set(input.incidents.map((entry) => entry.courseId)).size ===
      input.incidents.length &&
    new Set(input.incidents.map((entry) => entry.batchIncidentId)).size ===
      input.incidents.length;
  const attemptsHaveExactGlobalCardinality = (attempts: unknown[]) =>
    attempts.length === input.incidents.length &&
    new Set(attempts.map((entry) => asJsonObject(entry).courseRef)).size ===
      input.incidents.length &&
    attempts.every((entry) => expectedCourseRefs.has(String(asJsonObject(entry).courseRef)));
  const attemptsHaveExactCardinality =
    incidentIdentitiesAreExact &&
    expectedCourseRefs.size === input.incidents.length &&
    attemptsHaveExactGlobalCardinality(input.plannedAttempts) &&
    attemptsHaveExactGlobalCardinality(input.closeoutAttempts);
  const exactAttempts = input.incidents.map((entry) => ({
    ...entry,
    attempts: attemptsHaveExactCardinality
      ? readExactCourseSupportDecisionAttempts({
          courseId: entry.courseId,
          plannedAttempts: input.plannedAttempts,
          closeoutAttempts: input.closeoutAttempts
        })
      : null
  }));
  const executionEvidence = exactAttempts.map((entry) =>
    entry.attempts ? readExactCourseSupportDecisionExecutionEvidence(entry.attempts) : null
  );
  const executionEvidenceAvailableIncidentCount = executionEvidence.filter(
    (entry) => entry !== null
  ).length;
  const executionEvidenceUnavailableIncidentCount =
    executionEvidence.length - executionEvidenceAvailableIncidentCount;
  const executionEvidenceComplete = executionEvidenceUnavailableIncidentCount === 0;
  const remediationEvidenceAvailableIncidentCount = exactAttempts.filter(
    (entry) => entry.attempts !== null,
  ).length;
  const remediationEvidenceUnavailableIncidentCount =
    exactAttempts.length - remediationEvidenceAvailableIncidentCount;

  const retryBudgets = exactAttempts.map((entry) =>
    entry.attempts
      ? readExactCourseSupportDecisionRetryBudget(entry.attempts)
      : ({ status: "UNAVAILABLE" } as const)
  );
  const rawRetryBudgetUnavailableIncidentCount = retryBudgets.filter(
    (entry) => entry.status === "UNAVAILABLE"
  ).length;
  const applicableRetryBudgets = retryBudgets.flatMap((entry) =>
    entry.status === "AVAILABLE" ? [entry.budget] : []
  );
  const retryBudgetAttemptsRemainingTotal = applicableRetryBudgets.reduce(
    (total, budget) => total + budget.attemptsRemaining,
    0
  );
  const retryBudgetAggregateIsSafe = Number.isSafeInteger(retryBudgetAttemptsRemainingTotal);
  const retryBudgetUnavailableIncidentCount = retryBudgetAggregateIsSafe
    ? rawRetryBudgetUnavailableIncidentCount
    : retryBudgets.length;
  const retryBudgetEvidenceAvailableIncidentCount =
    retryBudgets.length - retryBudgetUnavailableIncidentCount;
  const retryBudgetComplete = retryBudgetUnavailableIncidentCount === 0;
  const retryBudgetApplicableIncidentCount = retryBudgetComplete
    ? applicableRetryBudgets.length
    : null;
  const retryBudgetNotApplicableIncidentCount = retryBudgetComplete
    ? retryBudgets.filter((entry) => entry.status === "NOT_APPLICABLE").length
    : null;

  const cooldowns = exactAttempts.map((entry) =>
    entry.attempts
      ? readExactCourseSupportDecisionCooldown(entry.attempts, input.now)
      : ({ status: "UNAVAILABLE" } as const)
  );
  const cooldownEvidenceUnavailableIncidentCount = cooldowns.filter(
    (entry) => entry.status === "UNAVAILABLE"
  ).length;
  const cooldownEvidenceAvailableIncidentCount =
    cooldowns.length - cooldownEvidenceUnavailableIncidentCount;
  const cooldownEvidenceComplete = cooldownEvidenceUnavailableIncidentCount === 0;
  const applicableCooldowns = cooldowns.filter((entry) => entry.status === "AVAILABLE");

  const deferredSignals = exactAttempts.map((entry) =>
    entry.attempts
      ? readExactCourseSupportDecisionDeferredSignal({
          courseId: entry.courseId,
          batchIncidentId: entry.batchIncidentId,
          attempt: entry.attempts,
          closeoutAttempts: input.closeoutAttempts
        })
      : ({ status: "UNAVAILABLE" } as const)
  );
  const deferredSignalEvidenceUnavailableIncidentCount = deferredSignals.filter(
    (entry) => entry.status === "UNAVAILABLE"
  ).length;
  const deferredSignalEvidenceAvailableIncidentCount =
    deferredSignals.length - deferredSignalEvidenceUnavailableIncidentCount;
  const deferredSignalEvidenceComplete = deferredSignalEvidenceUnavailableIncidentCount === 0;
  const applicableDeferredSignals = deferredSignals.filter(
    (entry) => entry.status === "AVAILABLE" && entry.signalState !== null
  );

  return {
    remediationEvidenceAvailableIncidentCount,
    remediationEvidenceUnavailableIncidentCount,
    executionEvidenceAvailableIncidentCount,
    executionEvidenceUnavailableIncidentCount,
    verificationRequestStartedIncidentCount: executionEvidenceComplete
      ? executionEvidence.filter((entry) => entry?.providerExecutionStarted === true).length
      : null,
    providerExecutionObservedIncidentCount: executionEvidenceComplete
      ? executionEvidence.filter((entry) => entry?.providerExecutionAttemptRecorded === true).length
      : null,
    providerExecutionAttemptRecordedIncidentCount: executionEvidenceComplete
      ? executionEvidence.filter((entry) => entry?.providerExecutionAttemptRecorded === true).length
      : null,
    providerExecutionCompletedIncidentCount: executionEvidenceComplete
      ? executionEvidence.filter((entry) => entry?.providerAttemptRecorded === true).length
      : null,
    retryBudgetEvidenceAvailableIncidentCount,
    retryBudgetUnavailableIncidentCount,
    retryBudgetApplicableIncidentCount,
    retryBudgetNotApplicableIncidentCount,
    retryBudgetAttemptsRemainingTotal:
      retryBudgetComplete && applicableRetryBudgets.length > 0
        ? retryBudgetAttemptsRemainingTotal
        : null,
    retryBudgetExhaustedIncidentCount:
      retryBudgetComplete && applicableRetryBudgets.length > 0
        ? applicableRetryBudgets.filter((budget) => budget.exhausted).length
        : null,
    cooldownEvidenceAvailableIncidentCount,
    cooldownEvidenceUnavailableIncidentCount,
    cooldownApplicableIncidentCount: cooldownEvidenceComplete ? applicableCooldowns.length : null,
    cooldownNotApplicableIncidentCount: cooldownEvidenceComplete
      ? cooldowns.filter((entry) => entry.status === "NOT_APPLICABLE").length
      : null,
    activeCooldownIncidentCount:
      cooldownEvidenceComplete && applicableCooldowns.length > 0
        ? applicableCooldowns.filter((entry) => entry.active).length
        : null,
    deferredSignalEvidenceAvailableIncidentCount,
    deferredSignalEvidenceUnavailableIncidentCount,
    deferredSignalApplicableIncidentCount: deferredSignalEvidenceComplete
      ? applicableDeferredSignals.length
      : null,
    deferredSignalNotApplicableIncidentCount: deferredSignalEvidenceComplete
      ? deferredSignals.filter(
          (entry) => entry.status === "AVAILABLE" && entry.signalState === null
        ).length
      : null,
    deferredSignalAvailableIncidentCount:
      deferredSignalEvidenceComplete && applicableDeferredSignals.length > 0
        ? applicableDeferredSignals.filter(
            (entry) => entry.status === "AVAILABLE" && entry.signalState === "AVAILABLE"
          ).length
        : null,
    deferredSignalConsumedIncidentCount:
      deferredSignalEvidenceComplete && applicableDeferredSignals.length > 0
        ? applicableDeferredSignals.filter(
            (entry) => entry.status === "AVAILABLE" && entry.signalState === "CONSUMED"
          ).length
        : null
  };
}

function getEffectiveCourseSupportRetryFailureClass(input: {
  incidentFailureClass: CourseSupportFailureClass;
  proofSnapshot: unknown;
}) {
  const observedFailureClass = asJsonObject(input.proofSnapshot).failureClass;
  return typeof observedFailureClass === "string" &&
    COURSE_SUPPORT_FAILURE_CLASSES.has(
      observedFailureClass as CourseSupportFailureClass,
    )
    ? (observedFailureClass as CourseSupportFailureClass)
    : input.incidentFailureClass;
}

function getCurrentCourseSupportMonitoringFailureIdentity(input: {
  incidentCycle: number;
  incidentFailureFingerprint: string;
  providerFamilyKey: string;
  batchCreatedAt: Date;
  monitoringStatus?: { failureFingerprint: string | null } | null;
  monitoringEvents?: Array<{
    failureFingerprint: string | null;
    occurredAt: Date;
    audit: Prisma.JsonValue | null;
  }>;
}) {
  const failureFingerprint = input.monitoringStatus?.failureFingerprint;
  if (
    !failureFingerprint ||
    courseSupportFailureFingerprintsMatch(
      failureFingerprint,
      input.incidentFailureFingerprint,
    )
  ) {
    return null;
  }
  const event = input.monitoringEvents?.[0];
  const audit = asJsonObject(event?.audit);
  const failureClass = audit.failureClass;
  if (
    !event ||
    !event.failureFingerprint ||
    !courseSupportFailureFingerprintsMatch(
      event.failureFingerprint,
      failureFingerprint,
    ) ||
    event.occurredAt.getTime() < input.batchCreatedAt.getTime() ||
    audit.cycle !== input.incidentCycle ||
    audit.providerFamilyKey !== input.providerFamilyKey ||
    typeof failureClass !== "string" ||
    !COURSE_SUPPORT_FAILURE_CLASSES.has(
      failureClass as CourseSupportFailureClass,
    )
  ) {
    return null;
  }
  return {
    failureClass: failureClass as CourseSupportFailureClass,
    failureFingerprint:
      normalizeCourseSupportFailureFingerprint(failureFingerprint),
    observedAt: event.occurredAt,
  };
}

type CourseSupportProbeEvidence = {
  id: string;
  outcome: ProbeOutcome;
  observedAt: Date;
  runtimeVersion: string | null;
  rawSummary: Prisma.JsonValue | null;
};

type AuthoritativeCourseSupportSuccessProbe = CourseSupportProbeEvidence & {
  id: string;
  outcome: Extract<ProbeOutcome, "MATCH_FOUND" | "NO_MATCH">;
  providerObservedAt: Date;
};

async function listAuthoritativeCourseSupportProbeEvidence(
  reader: Pick<Prisma.TransactionClient, "courseProbe">,
  input: {
    courseId: string;
    incidentLastSeenAt: Date;
    now: Date;
  },
) {
  return reader.courseProbe.findMany({
    where: {
      courseId: input.courseId,
      observedAt: {
        gt: input.incidentLastSeenAt,
        lte: input.now,
      },
      teeSearch: {
        status: "ACTIVE",
        trafficClass: {
          notIn: [...syntheticWebsiteTrafficClasses],
        },
      },
    },
    orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    take: COURSE_SUPPORT_AUTHORITATIVE_PROBE_READ_LIMIT + 1,
    select: {
      id: true,
      outcome: true,
      observedAt: true,
      runtimeVersion: true,
      rawSummary: true,
    },
  });
}

function getAuthoritativeProbeOrderingTime(
  probe: CourseSupportProbeEvidence,
) {
  return (
    getProviderExecutionEvidenceObservedAt({
      rawSummary: probe.rawSummary,
      probeObservedAt: probe.observedAt,
    }) ?? probe.observedAt
  );
}

function haveSameAuthoritativeProbeMeaning(
  left: CourseSupportProbeEvidence,
  right: CourseSupportProbeEvidence,
) {
  return (
    left.outcome === right.outcome &&
    left.runtimeVersion === right.runtimeVersion &&
    (getProviderExecutionEvidenceObservedAt({
      rawSummary: left.rawSummary,
      probeObservedAt: left.observedAt,
    })?.getTime() ?? null) ===
      (getProviderExecutionEvidenceObservedAt({
        rawSummary: right.rawSummary,
        probeObservedAt: right.observedAt,
      })?.getTime() ?? null)
  );
}

function assessAuthoritativeCourseSupportSuccessProbe(input: {
  probes?: ReadonlyArray<CourseSupportProbeEvidence>;
  incidentLastSeenAt: Date;
  now: Date;
}) {
  const probes = [...(input.probes ?? [])];
  if (probes.length > COURSE_SUPPORT_AUTHORITATIVE_PROBE_READ_LIMIT) {
    return { status: "INVALID" as const, probe: null };
  }
  for (const probe of probes) {
    if (
      !(probe.observedAt instanceof Date) ||
      !Number.isFinite(probe.observedAt.getTime()) ||
      probe.observedAt.getTime() > input.now.getTime()
    ) {
      return { status: "INVALID" as const, probe: null };
    }
  }
  probes.sort((left, right) => {
    const sourceTimeOrder =
      getAuthoritativeProbeOrderingTime(right).getTime() -
      getAuthoritativeProbeOrderingTime(left).getTime();
    if (sourceTimeOrder !== 0) return sourceTimeOrder;
    const rowTimeOrder = right.observedAt.getTime() - left.observedAt.getTime();
    return rowTimeOrder !== 0
      ? rowTimeOrder
      : right.id.localeCompare(left.id);
  });
  const newest = probes[0];
  if (!newest) {
    return { status: "NONE" as const, probe: null };
  }
  const newestOrderingTime = getAuthoritativeProbeOrderingTime(newest);
  if (
    probes.some(
      (probe) =>
        getAuthoritativeProbeOrderingTime(probe).getTime() ===
          newestOrderingTime.getTime() &&
        !haveSameAuthoritativeProbeMeaning(probe, newest),
    )
  ) {
    return { status: "INVALID" as const, probe: null };
  }
  if (newestOrderingTime.getTime() <= input.incidentLastSeenAt.getTime()) {
    return { status: "NONE" as const, probe: null };
  }
  if (!SUCCESSFUL_PROBE_OUTCOMES.has(newest.outcome)) {
    return { status: "NONE" as const, probe: null };
  }
  const providerObservedAt = getProviderExecutionEvidenceObservedAt({
    rawSummary: newest.rawSummary,
    probeObservedAt: newest.observedAt,
  });
  if (
    !providerObservedAt ||
    providerObservedAt.getTime() <= input.incidentLastSeenAt.getTime()
  ) {
    return { status: "NONE" as const, probe: null };
  }
  return {
    status: "VALID" as const,
    probe: {
      ...newest,
      providerObservedAt,
    } as AuthoritativeCourseSupportSuccessProbe,
  };
}

function buildAuthoritativeCourseSupportSuccessProbeProof(
  probe: AuthoritativeCourseSupportSuccessProbe,
) {
  return {
    kind: "PROVIDER_PROBE",
    outcome: probe.outcome,
    observedAt: probe.providerObservedAt.toISOString(),
    freshSearchCheckedAt: probe.observedAt.toISOString(),
    runtimeVersion: probe.runtimeVersion,
    providerExecution: isProviderExecutionMarker(
      asJsonObject(probe.rawSummary).providerExecution,
    ),
    authoritativeCurrentSuccess: true,
  } satisfies Prisma.InputJsonObject;
}

function getActiveCourseSupportFailureOnlyHandoffCooldown(input: {
  incidentCycle: number;
  incidentFailureFingerprint: string;
  providerFamilyKey: string;
  claimedProviderSnapshotFingerprint: string;
  providerSnapshotFingerprint: string;
  currentBatchCreatedAt: Date;
  batchIncidents?: Array<{
    cycle: number;
    batch: { createdAt: Date };
  }>;
  monitoringEvents?: Array<{
    occurredAt: Date;
    audit: Prisma.JsonValue | null;
  }>;
  now: Date;
}) {
  // The bounded query is newest-first and also contains routine same-cycle
  // continuation events. Find the canonical handoff that created this cycle;
  // a later material handoff necessarily creates another cycle and cannot
  // satisfy this exact lineage.
  const handoff = input.monitoringEvents?.find((event) => {
    const audit = asJsonObject(event.audit);
    const priorFailureFingerprint = audit.priorFailureFingerprint;
    const failureFingerprint = audit.failureFingerprint;
    return (
      event.occurredAt instanceof Date &&
      event.occurredAt.getTime() <= input.now.getTime() &&
      audit.providerFamilyHandoff === true &&
      audit.providerFamilyChanged === false &&
      audit.providerSnapshotChanged === false &&
      audit.priorCycle === input.incidentCycle - 1 &&
      audit.cycle === input.incidentCycle &&
      audit.priorProviderFamilyKey === input.providerFamilyKey &&
      audit.providerFamilyKey === input.providerFamilyKey &&
      typeof priorFailureFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(priorFailureFingerprint) &&
      typeof failureFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(failureFingerprint) &&
      priorFailureFingerprint !== failureFingerprint &&
      failureFingerprint === input.incidentFailureFingerprint &&
      audit.claimedProviderSnapshotFingerprint ===
        input.claimedProviderSnapshotFingerprint &&
      audit.observedProviderSnapshotFingerprint ===
        input.providerSnapshotFingerprint &&
      input.claimedProviderSnapshotFingerprint ===
        input.providerSnapshotFingerprint
    );
  });
  if (!handoff) {
    return null;
  }
  const firstCycleBatchCreatedAt = [
    input.currentBatchCreatedAt,
    ...(input.batchIncidents ?? []).flatMap((entry) =>
      entry.cycle === input.incidentCycle &&
      entry.batch.createdAt instanceof Date
        ? [entry.batch.createdAt]
        : [],
    ),
  ].reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
  const cooldownAnchor =
    firstCycleBatchCreatedAt.getTime() > handoff.occurredAt.getTime()
      ? firstCycleBatchCreatedAt
      : handoff.occurredAt;
  const expiresAt = new Date(
    cooldownAnchor.getTime() +
      COURSE_SUPPORT_FAILURE_ONLY_HANDOFF_COOLDOWN_MS,
  );
  return {
    occurredAt: handoff.occurredAt,
    expiresAt,
    active: expiresAt.getTime() > input.now.getTime(),
  };
}

function getEffectiveCourseSupportRetryFailureFingerprint(input: {
  providerFamilyKey: string;
  incidentKind: CourseSupportIncidentKind;
  incidentFailureClass: CourseSupportFailureClass;
  incidentFailureFingerprint: string;
  proofSnapshot: unknown;
}) {
  const proof = asJsonObject(input.proofSnapshot);
  const observedFailureClass = proof.failureClass;
  if (
    typeof observedFailureClass !== "string" ||
    !COURSE_SUPPORT_FAILURE_CLASSES.has(
      observedFailureClass as CourseSupportFailureClass,
    )
  ) {
    return input.incidentFailureFingerprint;
  }
  const failureClass = observedFailureClass as CourseSupportFailureClass;
  const httpStatus =
    typeof proof.httpStatus === "number" && Number.isInteger(proof.httpStatus)
      ? proof.httpStatus
      : null;
  return buildProviderFailureFingerprint({
    providerFamilyKey: input.providerFamilyKey,
    failureClass,
    operation:
      input.incidentKind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
    httpStatus,
  });
}

class CourseSupportCloseoutSnapshotChangedError extends Error {
  constructor() {
    super("A course-support incident changed during closeout.");
    this.name = "CourseSupportCloseoutSnapshotChangedError";
  }
}

function getCourseSupportIncidentEvidenceObservedAt(input: {
  proofSnapshot: Prisma.JsonValue | null;
  incidentLastSeenAt: Date;
  now: Date;
  additionalProviderObservedAt?: Date | null;
}) {
  const proof = asJsonObject(input.proofSnapshot);
  const proofObservedAt = parseProofDate(proof.observedAt);
  const proofKindIsProviderEvidence =
    proof.kind === "PROVIDER_PROBE" ||
    proof.kind === "PROVIDER_VERIFICATION" ||
    proof.kind === "PROVIDER_VERIFICATION_FAILURE";
  const candidates = [input.incidentLastSeenAt];
  if (
    proofKindIsProviderEvidence &&
    proof.providerExecution === true &&
    proofObservedAt &&
    proof.observedAt === proofObservedAt.toISOString() &&
    proofObservedAt.getTime() >= input.incidentLastSeenAt.getTime() &&
    proofObservedAt.getTime() <= input.now.getTime()
  ) {
    candidates.push(proofObservedAt);
  }
  const additionalProviderObservedAt = input.additionalProviderObservedAt;
  if (
    additionalProviderObservedAt &&
    Number.isFinite(additionalProviderObservedAt.getTime()) &&
    additionalProviderObservedAt.getTime() >=
      input.incidentLastSeenAt.getTime() &&
    additionalProviderObservedAt.getTime() <= input.now.getTime()
  ) {
    candidates.push(additionalProviderObservedAt);
  }
  return candidates.reduce((latest, candidate) =>
    candidate.getTime() > latest.getTime() ? candidate : latest,
  );
}

async function closeoutCourseSupportBatchAttempt(
  input: CloseoutCourseSupportBatchInput,
) {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const verificationWatchMode = input.verificationWatchMode ?? "STANDARD";
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ACTIVE_BATCH_STATUSES },
      leaseExpiresAt: { gte: now },
    },
    include: {
      incidents: {
        include: {
          incident: {
            include: {
              monitoringEvents: {
                where: { eventType: "REVALIDATION_REQUESTED" },
                orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
                take: 20,
                select: { occurredAt: true, audit: true },
              },
              batchIncidents: {
                where: { batch: { completedAt: { not: null } } },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                select: {
                  id: true,
                  cycle: true,
                  verificationRequests: {
                    select: {
                      releaseSha: true,
                      status: true,
                      revision: true,
                      attemptCount: true,
                      startedAt: true,
                    },
                  },
                  batch: {
                    select: {
                      summary: true,
                      releaseSha: true,
                      createdAt: true,
                    },
                  },
                },
              },
            },
          },
          course: {
            select: DETACHED_VERIFICATION_COURSE_SELECT,
          },
        },
      },
    },
  });
  input.signal?.throwIfAborted();
  if (!batch) {
    return {
      outcome: "command_failed" as const,
      durableCloseoutRecorded: false,
      ...getResponderThreadPolicy({
        outcome: "command_failed",
        durableCloseoutRecorded: false,
      }),
    };
  }
  if (batch.incidents.length === 0) {
    throw new Error(
      "A responder batch without incident evidence cannot be closed.",
    );
  }
  const remediationDirective = readCourseSupportRemediationDirective(
    batch.summary,
  );
  const changedReleaseAwaitingDeployment = Boolean(
    batch.releaseSha && batch.releaseSha !== batch.baseSha && !batch.deployedAt,
  );
  if (changedReleaseAwaitingDeployment) {
    throw new Error(
      "A changed course-support release cannot be closed before deployment; recover or adopt the active release continuation instead.",
    );
  }
  if (verificationWatchMode === "WATCH_SETTLED") {
    assertCourseSupportImplementationVerificationReady({
      summary: batch.summary,
      baseSha: batch.baseSha,
      releaseSha: batch.releaseSha,
      deployedAt: batch.deployedAt,
    });
  }
  const closeoutSearchExecutionFenceInput =
    createCourseSupportSearchExecutionFenceInput({
      batchId: batch.id,
      courseIds: batch.incidents.map((entry) => entry.courseId),
      summary: batch.summary,
      recheckDispatchKey: batch.recheckDispatchKey,
      recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      recheckDispatchedAt: batch.recheckDispatchedAt,
      now,
    });
  const closeoutSearchExecutionFence =
    await readCourseSupportSearchExecutionFence(
      prisma,
      closeoutSearchExecutionFenceInput,
    );
  const persistedSearchExecutionFence =
    readPersistedCourseSupportSearchExecutionFence(
      asJsonObject(batch.summary).searchExecutionFence,
    );
  // Batches verified by a current responder always carry this snapshot. A
  // pre-fence batch may still complete an operational closeout, but it must
  // never receive the zero-execution/orchestration-only exemption without a
  // persisted snapshot to compare against.
  const expectedSearchExecutionFence =
    persistedSearchExecutionFence ??
    persistCourseSupportSearchExecutionFence(closeoutSearchExecutionFence, now);
  if (
    persistedSearchExecutionFence &&
    !courseSupportSearchExecutionFenceMatches(
      expectedSearchExecutionFence,
      closeoutSearchExecutionFence,
    )
  ) {
    throw new CourseSupportSearchExecutionFenceRetryError();
  }
  const closeoutSearchExecutionMayHaveStartedCourseRefs = new Set(
    getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
      persistedSearchExecutionFence,
      closeoutSearchExecutionFence,
    ),
  );
  for (const entry of batch.incidents) {
    const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
    if (
      closeoutSearchExecutionMayHaveStartedCourseRefs.has(courseRef) &&
      !readCourseSupportReleaseExecutionEvidence({
        summary: batch.summary,
        baseSha: batch.baseSha,
        courseRef,
      }).providerExecutionAttemptEverForCourse
    ) {
      throw new CourseSupportSearchExecutionFenceRetryError(
        "Course-support search execution requires another verification pass before closeout.",
      );
    }
  }

  const currentDetachedFailureBatchIncidentIds = new Set(
    batch.releaseSha &&
      verificationWatchMode !== "EARLY_RETRY" &&
      verificationWatchMode !== "ENDPOINT"
      ? (
          await Promise.all(
            batch.incidents.map(async (entry) => {
              const failure = await getCurrentCourseSupportVerificationFailure({
                batchIncidentId: entry.id,
                releaseSha: batch.releaseSha!,
                now,
              });
              return classifyDetachedVerificationFailure({
                failure,
                deployedAt: batch.deployedAt,
                recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
                incidentLastSeenAt: entry.incident.lastSeenAt,
              })
                ? entry.id
                : null;
            }),
          )
        ).filter((entryId): entryId is string => entryId !== null)
      : [],
  );
  const ownershipReleaseMode =
    verificationWatchMode === "EARLY_RETRY" ||
    verificationWatchMode === "ENDPOINT";

  const baseNormalizedEntries = batch.incidents.map((entry) => {
    const currentProviderSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(entry.course);
    const playbookAssessment = assessAutomationPlaybook(
      entry.incident.attemptLedger,
      entry.incident.cycle,
    );
    const playbookExhausted = isAutomationPlaybookExhausted(
      entry.incident.attemptLedger,
      entry.incident.cycle,
    );
    const endpointReached = Boolean(
      entry.incident.escalationDeadlineAt &&
      entry.incident.escalationDeadlineAt.getTime() <= now.getTime(),
    );
    const retryFailureClass = getEffectiveCourseSupportRetryFailureClass({
      incidentFailureClass: entry.incident.failureClass,
      proofSnapshot: entry.proofSnapshot,
    });
    const continueIncompletePlaybook =
      playbookAssessment.conclusion === "INCOMPLETE" &&
      Boolean(playbookAssessment.nextStage) &&
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective,
        failureClass: retryFailureClass,
        attemptCount: entry.incident.attemptCount,
        playbookConclusion: playbookAssessment.conclusion,
        nextPlaybookStage: playbookAssessment.nextStage,
        nextPlaybookStageStatus:
          getCourseSupportNextStageStatus(playbookAssessment),
        nextPlaybookStageAttemptCount:
          getCourseSupportNextStageAttemptCount(playbookAssessment),
      });
    const terminalProofIsDurable =
      entry.result === "RESTORED" || entry.result === "FINAL_DISPOSITION"
        ? isDurableTerminalProof(
            {
              ...entry,
              currentProviderSnapshotFingerprint,
              normalizedResult: entry.result,
            },
            batch,
          )
        : false;
    const authoritativeMonitoringResolution = ownershipReleaseMode
      ? getAuthoritativeCourseMonitoringResolution(
          entry.course.monitoringStatus?.state,
        )
      : null;
    if (authoritativeMonitoringResolution && entry.course.monitoringStatus) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult:
          entry.course.monitoringStatus.state === "HEALTHY"
            ? ("RESTORED" as const)
            : ("FINAL_DISPOSITION" as const),
        message: authoritativeMonitoringResolution.message,
      };
    }
    const sourceUnverifiedFinalizationEvidence =
      getSourceUnverifiedFinalizationEvidence({
        providerFamilyKey: entry.incident.providerFamilyKey,
        failureClass: entry.incident.failureClass,
        course: entry.course,
        attemptCount: entry.incident.attemptCount,
        activeRealSearchCount: entry.incident.activeRealSearchCount,
        firstSeenAt: entry.incident.firstSeenAt,
        freshCycleStartedAt: entry.incident.confirmedAt,
        attemptLedger: entry.incident.attemptLedger,
        cycle: entry.incident.cycle,
        verifiedAt: entry.verifiedAt,
        verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
        incidentUpdatedAt: entry.incident.updatedAt,
        result: entry.result,
        releaseSha: batch.releaseSha,
        deployedAt: batch.deployedAt,
        now,
      });
    if (sourceUnverifiedFinalizationEvidence) {
      const priorProof = asJsonObject(entry.proofSnapshot);
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult: "FINAL_DISPOSITION" as const,
        proofSnapshot: {
          kind: "SOURCE_UNVERIFIED_FINAL",
          disposition: "SOURCE_UNVERIFIED",
          providerFamilyKey: entry.incident.providerFamilyKey,
          failureClass: entry.incident.failureClass,
          attemptCount: entry.incident.attemptCount,
          activeRealSearchCount: entry.incident.activeRealSearchCount,
          firstSeenAt: entry.incident.firstSeenAt.toISOString(),
          freshCycleStartedAt:
            sourceUnverifiedFinalizationEvidence.evidenceStartedAt.toISOString(),
          evidenceMode: sourceUnverifiedFinalizationEvidence.mode,
          sourceResult: entry.result,
          ...(sourceUnverifiedFinalizationEvidence.mode ===
          "INDEPENDENT_BROWSER_SOURCE_CONFLICT"
            ? {
                renderedObservedAt:
                  sourceUnverifiedFinalizationEvidence.renderedObservedAt.toISOString(),
                independentObservedAt:
                  sourceUnverifiedFinalizationEvidence.independentObservedAt.toISOString(),
                providerSnapshotFingerprint:
                  sourceUnverifiedFinalizationEvidence.providerSnapshotFingerprint,
              }
            : {}),
          cycle: entry.incident.cycle,
          completedStageCount: AUTOMATION_PLAYBOOK_STAGES.length,
          verifiedAt: entry.verifiedAt!.toISOString(),
          priorProofKind:
            typeof priorProof.kind === "string" ? priorProof.kind : "UNKNOWN",
        } as Prisma.JsonValue,
        message:
          "A fresh complete signed-out playbook, including independent confirmation, could not establish one trustworthy public provider source.",
      };
    }
    const freshExactRuntimeSourceCycle =
      shouldStartFreshExactRuntimeSourceCycle({
        failureClass: entry.incident.failureClass,
        attemptLedger: entry.incident.attemptLedger,
        cycle: entry.incident.cycle,
        result: entry.result,
        claimedAt: batch.createdAt,
        deployedAt: batch.deployedAt,
        releaseSha: batch.releaseSha,
        verifiedAt: entry.verifiedAt,
        verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
        incidentUpdatedAt: entry.incident.updatedAt,
      });
    if (freshExactRuntimeSourceCycle) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        freshExactRuntimeSourceCycle: true as const,
        normalizedResult: "RETRY_SCHEDULED" as const,
        message:
          "Browser source evidence spanned different deployed runtimes, so one fresh exact-runtime playbook cycle is required.",
      };
    }
    if (
      verificationWatchMode === "EARLY_RETRY" &&
      (entry.result === "RESTORED" ||
        entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED" ||
        (entry.result === "NEEDS_HUMAN" && !playbookExhausted) ||
        (entry.result === "FINAL_DISPOSITION" && !terminalProofIsDurable))
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult: "RETRY_SCHEDULED" as const,
        message:
          "Verification stopped before authoritative customer monitoring proof could be completed.",
      };
    }
    if (
      verificationWatchMode === "ENDPOINT" &&
      endpointReached &&
      continueIncompletePlaybook &&
      (entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED" ||
        (entry.result === "RESTORED" &&
          (!terminalProofIsDurable ||
            !isRecheckDispatchHealthy(batch.summary, now))) ||
        (entry.result === "FINAL_DISPOSITION" && !terminalProofIsDurable) ||
        (entry.result === "NEEDS_HUMAN" && !playbookExhausted))
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult: "RETRY_SCHEDULED" as const,
        message:
          "The verification endpoint elapsed, but the bounded signed-out playbook has another safe stage to run.",
      };
    }
    if (
      verificationWatchMode === "ENDPOINT" &&
      endpointReached &&
      ((entry.result === "RESTORED" &&
        (!terminalProofIsDurable ||
          !isRecheckDispatchHealthy(batch.summary, now))) ||
        (entry.result === "FINAL_DISPOSITION" && !terminalProofIsDurable) ||
        (entry.result === "NEEDS_HUMAN" && !playbookExhausted))
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: true,
        normalizedResult: "NEEDS_HUMAN" as const,
        message:
          "The automatic verification endpoint elapsed before authoritative customer monitoring proof could be completed.",
      };
    }
    if (
      verificationWatchMode === "ENDPOINT" &&
      endpointReached &&
      (entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED")
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: !playbookExhausted,
        normalizedResult: "NEEDS_HUMAN" as const,
        message: playbookExhausted
          ? "Every safe signed-out read path was exhausted without current reusable provider proof."
          : "The automatic verification endpoint elapsed before every safe signed-out read path could finish.",
      };
    }
    if (
      verificationWatchMode === "WATCH_SETTLED" &&
      playbookAssessment.conclusion === "UNRESOLVED_EXHAUSTED" &&
      (entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED") &&
      shouldImplementReusableSupportAfterExhaustedDiscovery({
        ...entry.course,
        failureClass: retryFailureClass,
      })
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult: "RETRY_SCHEDULED" as const,
        message:
          "The safe discovery playbook completed and handed the public provider to reusable support implementation.",
      };
    }
    if (
      verificationWatchMode === "WATCH_SETTLED" &&
      (entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED")
    ) {
      if (
        shouldContinueSettledCourseSupportRemediation({
          remediationDirective,
          failureClass: retryFailureClass,
          attemptCount: entry.incident.attemptCount,
          playbookConclusion: playbookAssessment.conclusion,
          nextPlaybookStage: playbookAssessment.nextStage,
          nextPlaybookStageStatus:
            getCourseSupportNextStageStatus(playbookAssessment),
          nextPlaybookStageAttemptCount:
            getCourseSupportNextStageAttemptCount(playbookAssessment),
        })
      ) {
        return {
          ...entry,
          currentProviderSnapshotFingerprint,
          automationStalled: false,
          normalizedResult: "RETRY_SCHEDULED" as const,
          message:
            "The bounded remediation advanced to a different safe stage or remains within its transient retry budget.",
        };
      }
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: true,
        normalizedResult: "NEEDS_HUMAN" as const,
        message:
          "The bounded remediation produced no novel stage or reusable change and was parked until a material input changes.",
      };
    }
    if (
      entry.result === "PENDING" ||
      entry.result === "STALE_EVIDENCE" ||
      entry.result === "RETRY_SCHEDULED"
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult:
          verificationWatchMode === "STANDARD" &&
          entry.incident.humanReviewReason
            ? ("NEEDS_HUMAN" as const)
            : ("RETRY_SCHEDULED" as const),
      };
    }
    const proof = asJsonObject(entry.proofSnapshot);
    if (
      entry.result === "FINAL_DISPOSITION" &&
      proof.kind === "FINAL_DISPOSITION" &&
      (proof.disposition === "ACCOUNT_REQUIRED" ||
        proof.disposition === "CAPTCHA_OR_QUEUE")
    ) {
      return {
        ...entry,
        currentProviderSnapshotFingerprint,
        automationStalled: false,
        normalizedResult: "NEEDS_HUMAN" as const,
        proofSnapshot: {
          ...proof,
          kind: "HUMAN_REVIEW_REQUIRED",
          priorProofKind: "FINAL_DISPOSITION",
        } as unknown as Prisma.JsonValue,
        message:
          "Automation confirmed a current technical access limitation; engineer approval is required before it becomes final.",
      };
    }
    return {
      ...entry,
      currentProviderSnapshotFingerprint,
      automationStalled: false,
      normalizedResult: entry.result,
    };
  });
  const authoritativeSuccessProbeByBatchIncidentId = new Map<
    string,
    AuthoritativeCourseSupportSuccessProbe
  >();
  for (const entry of batch.incidents) {
    const probes = await listAuthoritativeCourseSupportProbeEvidence(prisma, {
      courseId: entry.courseId,
      incidentLastSeenAt: entry.incident.lastSeenAt,
      now,
    });
    const assessment = assessAuthoritativeCourseSupportSuccessProbe({
      probes,
      incidentLastSeenAt: entry.incident.lastSeenAt,
      now,
    });
    if (assessment.status === "INVALID") {
      throw new CourseSupportCloseoutSnapshotChangedError();
    }
    if (assessment.status === "VALID" && assessment.probe) {
      authoritativeSuccessProbeByBatchIncidentId.set(
        entry.id,
        assessment.probe,
      );
    }
  }
  const plannedRemediationAttempts = Array.isArray(
    asJsonObject(asJsonObject(batch.summary).remediation).attempts,
  )
    ? (asJsonObject(asJsonObject(batch.summary).remediation)
        .attempts as unknown[])
    : [];
  const currentFailureIdentityByBatchIncidentId = new Map(
    baseNormalizedEntries.map((entry) => {
      const providerFamilyKey = resolveProviderCapability(
        entry.course,
      ).providerFamilyKey;
      const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
      const plannedAttempt = asJsonObject(
        plannedRemediationAttempts.find(
          (candidate) => asJsonObject(candidate).courseRef === courseRef,
        ),
      );
      const proofProviderSnapshotFingerprint = asJsonObject(
        entry.proofSnapshot,
      ).providerSnapshotFingerprint;
      const claimedProviderSnapshotFingerprint =
        typeof plannedAttempt.providerSnapshotFingerprint === "string"
          ? plannedAttempt.providerSnapshotFingerprint
          : typeof proofProviderSnapshotFingerprint === "string"
            ? proofProviderSnapshotFingerprint
            : entry.currentProviderSnapshotFingerprint;
      const providerSnapshotChanged =
        claimedProviderSnapshotFingerprint !==
        entry.currentProviderSnapshotFingerprint;
      const monitoringFailure =
        getCurrentCourseSupportMonitoringFailureIdentity({
          incidentCycle: entry.cycle,
          incidentFailureFingerprint: entry.incident.failureFingerprint,
          providerFamilyKey,
          batchCreatedAt: batch.createdAt,
          monitoringStatus: entry.course.monitoringStatus,
          monitoringEvents: entry.course.monitoringEvents,
        });
      const failureClass =
        monitoringFailure?.failureClass ??
        getEffectiveCourseSupportRetryFailureClass({
          incidentFailureClass: entry.incident.failureClass,
          proofSnapshot: entry.proofSnapshot,
        });
      let failureFingerprint =
        monitoringFailure?.failureFingerprint ??
        getEffectiveCourseSupportRetryFailureFingerprint({
          providerFamilyKey,
          incidentKind: entry.incident.kind,
          incidentFailureClass: entry.incident.failureClass,
          incidentFailureFingerprint: entry.incident.failureFingerprint,
          proofSnapshot: entry.proofSnapshot,
        });
      if (
        providerFamilyKey !== entry.incident.providerFamilyKey &&
        failureFingerprint === entry.incident.failureFingerprint
      ) {
        failureFingerprint = buildProviderFailureFingerprint({
          providerFamilyKey,
          failureClass,
          operation:
            entry.incident.kind === "NEEDS_ADAPTER"
              ? "METADATA"
              : "AVAILABILITY",
          httpStatus: null,
        });
      }
      const handoffRetryCandidates = [now];
      if (
        monitoringFailure &&
        entry.course.monitoringStatus?.nextAutomaticAttemptAt
      ) {
        handoffRetryCandidates.push(
          entry.course.monitoringStatus.nextAutomaticAttemptAt,
        );
      }
      const playbookAssessment = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.incident.cycle,
      );
      if (
        verificationWatchMode === "WATCH_SETTLED" &&
        playbookAssessment.conclusion === "INCOMPLETE" &&
        (playbookAssessment.nextStage === "RENDERED_BROWSER_DISCOVERY" ||
          playbookAssessment.nextStage === "INDEPENDENT_CONFIRMATION")
      ) {
        handoffRetryCandidates.push(new Date(now.getTime() + 60 * 1000));
      }
      const detachedFailureNotBefore = getDetachedFailureRetryNotBefore({
        proofSnapshot: entry.proofSnapshot,
        releaseSha: batch.releaseSha,
        now,
      });
      if (detachedFailureNotBefore) {
        handoffRetryCandidates.push(detachedFailureNotBefore);
      }
      if (
        failureClass === "RATE_LIMIT" &&
        Number.isFinite(input.retryAfterSeconds) &&
        (input.retryAfterSeconds ?? 0) > 0
      ) {
        handoffRetryCandidates.push(
          computeCourseSupportNextAttemptAt({
            failureClass,
            failureFingerprint,
            attemptCount: 1,
            retryAfterSeconds: input.retryAfterSeconds,
            now,
          }),
        );
      }
      const verifierFailureFingerprintChanged =
        monitoringFailure === null &&
        failureFingerprint !== entry.incident.failureFingerprint;
      const verifierProviderExecution =
        asJsonObject(entry.proofSnapshot).providerExecution === true;
      const failureOnlyHandoffCooldown =
        verifierFailureFingerprintChanged &&
        providerFamilyKey === entry.incident.providerFamilyKey &&
        !providerSnapshotChanged
          ? getActiveCourseSupportFailureOnlyHandoffCooldown({
              incidentCycle: entry.cycle,
              incidentFailureFingerprint: entry.incident.failureFingerprint,
              providerFamilyKey,
              claimedProviderSnapshotFingerprint,
              providerSnapshotFingerprint:
                entry.currentProviderSnapshotFingerprint,
              currentBatchCreatedAt: batch.createdAt,
              batchIncidents: entry.incident.batchIncidents,
              monitoringEvents: entry.incident.monitoringEvents,
              now,
            })
          : null;
      const deferredFailureHandoffShadow =
        verifierFailureFingerprintChanged && !verifierProviderExecution
          ? hasDeferredFailureHandoffShadow({
              incident: {
                ...entry.incident,
                courseId: entry.courseId,
                cycle: entry.cycle,
              },
            })
          : false;
      return [
        entry.id,
        {
          providerFamilyKey,
          failureClass,
          failureFingerprint,
          claimedProviderSnapshotFingerprint,
          observedProviderSnapshotFingerprint:
            entry.currentProviderSnapshotFingerprint,
          providerSnapshotChanged,
          monitoringFailureObservedAt: monitoringFailure?.observedAt ?? null,
          failureOnlyHandoffCooldown,
          deferredFailureHandoffShadow,
          nextAttemptAt: handoffRetryCandidates.reduce((latest, candidate) =>
            candidate.getTime() > latest.getTime() ? candidate : latest,
          ),
          materialChange:
            providerFamilyKey !== entry.incident.providerFamilyKey ||
            providerSnapshotChanged ||
            monitoringFailure !== null ||
            (verifierFailureFingerprintChanged &&
              verifierProviderExecution &&
              (failureOnlyHandoffCooldown === null ||
                !failureOnlyHandoffCooldown.active)),
        },
      ] as const;
    }),
  );
  const closeoutRuntimeVersion = batch.releaseSha ?? batch.baseSha;
  const detachedRequestStatesAtCloseout =
    await prisma.courseSupportVerificationRequest.findMany({
      where: {
        batchIncident: { batchId: batch.id },
      },
      select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
    });
  if (
    detachedRequestStatesAtCloseout.some(isActiveDetachedVerificationRequest)
  ) {
    throw new Error(
      "Detached provider verification is still active; rerun verification before closeout.",
    );
  }
  type DeferredFailureHandoffCloseoutSource =
    | {
        kind: "CARRIER";
        source: DeferredFailureHandoffSignal;
        confirmationStarted: boolean;
        admittedAt: Date;
      }
    | {
        kind: "INITIAL";
        source: DeferredFailureHandoffSignal;
      };
  const deferredFailureHandoffByBatchIncidentId = new Map<
    string,
    DeferredFailureHandoffCloseoutSource
  >(
    baseNormalizedEntries.flatMap<
      readonly [string, DeferredFailureHandoffCloseoutSource]
    >((entry) => {
      if (authoritativeSuccessProbeByBatchIncidentId.has(entry.id)) {
        return [];
      }
      const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
      const plannedAttempt = asJsonObject(
        plannedRemediationAttempts.find(
          (candidate) => asJsonObject(candidate).courseRef === courseRef,
        ),
      );
      const admittedSource = parseDeferredFailureHandoffSignal(
        plannedAttempt.deferredFailureHandoffSource,
      );
      const admission = parseDeferredFailureHandoffAdmission(
        plannedAttempt.deferredFailureHandoffAdmission,
      );
      const requests = detachedRequestStatesAtCloseout.filter(
        (request) => request.batchIncidentId === entry.id,
      );
      const confirmationStarted = requests.some(
        (request) => request.startedAt !== null,
      );
      if (
        admittedSource &&
        admission &&
        admission.signalDigest === admittedSource.signalDigest &&
        admission.sourceRecordDigest === admittedSource.recordDigest &&
        admission.sourceBatchIncidentDigest ===
          admittedSource.sourceBatchIncidentDigest &&
        admittedSource.state === "AVAILABLE" &&
        !admittedSource.confirmationStarted &&
        admittedSource.providerFamilyKey === entry.incident.providerFamilyKey &&
        admittedSource.canonicalFailureFingerprint ===
          entry.incident.failureFingerprint &&
        admittedSource.claimedProviderSnapshotFingerprint ===
          entry.currentProviderSnapshotFingerprint &&
        admittedSource.observedProviderSnapshotFingerprint ===
          entry.currentProviderSnapshotFingerprint &&
        plannedAttempt.runtimeVersion === closeoutRuntimeVersion
      ) {
        return [[
          entry.id,
          {
            kind: "CARRIER" as const,
            source: admittedSource,
            confirmationStarted,
            admittedAt: new Date(admission.admittedAt),
          },
        ] as const];
      }
      const identity = currentFailureIdentityByBatchIncidentId.get(entry.id);
      const playbook = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.cycle,
      );
      const proof = asJsonObject(entry.proofSnapshot);
      const proofObservedAt =
        typeof proof.observedAt === "string" ? new Date(proof.observedAt) : null;
      const proofNextAttemptAt =
        proof.nextAttemptAt === null || typeof proof.nextAttemptAt === "string"
          ? (proof.nextAttemptAt as string | null)
          : undefined;
      const proofProviderNotBeforeAt =
        proof.providerRetryNotBeforeAt === null ||
        typeof proof.providerRetryNotBeforeAt === "string"
          ? (proof.providerRetryNotBeforeAt as string | null)
          : undefined;
      const proofCompletedAt =
        proof.completedAt === null || typeof proof.completedAt === "string"
          ? (proof.completedAt as string | null)
          : undefined;
      const matchingRequests = requests.filter(
        (request) => request.releaseSha === closeoutRuntimeVersion,
      );
      const sourceRequest = matchingRequests[0];
      const sourceRequestEvidence = asJsonObject(sourceRequest?.evidence);
      const evidenceProviderNotBeforeAt =
        sourceRequestEvidence.providerRetryNotBeforeAt === undefined
          ? null
          : typeof sourceRequestEvidence.providerRetryNotBeforeAt === "string"
            ? sourceRequestEvidence.providerRetryNotBeforeAt
            : undefined;
      if (
        verificationWatchMode !== "WATCH_SETTLED" ||
        !identity?.failureOnlyHandoffCooldown ||
        identity.deferredFailureHandoffShadow ||
        identity.materialChange ||
        playbook.conclusion !== "UNRESOLVED_EXHAUSTED" ||
        playbook.nextStage !== null ||
        !["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"].includes(
          entry.result,
        ) ||
        matchingRequests.length !== 1 ||
        !sourceRequest ||
        (sourceRequest.status !== "RETRYABLE_FAILED" &&
          sourceRequest.status !== "STALE") ||
        sourceRequest.runtimeVersion !== closeoutRuntimeVersion ||
        sourceRequest.startedAt === null ||
        (proof.status !== "RETRYABLE_FAILED" && proof.status !== "STALE") ||
        proof.kind !== "PROVIDER_VERIFICATION_FAILURE" ||
        proof.outcome !== "FETCH_FAILED" ||
        typeof proof.failureClass !== "string" ||
        !COURSE_SUPPORT_FAILURE_CLASSES.has(
          proof.failureClass as CourseSupportFailureClass,
        ) ||
        proof.providerExecution !== false ||
        !proofObservedAt ||
        !Number.isFinite(proofObservedAt.getTime()) ||
        proofObservedAt.toISOString() !== proof.observedAt ||
        proofObservedAt.getTime() > now.getTime() ||
        proof.runtimeVersion !== closeoutRuntimeVersion ||
        proof.providerSnapshotFingerprint !==
          entry.currentProviderSnapshotFingerprint ||
        proofNextAttemptAt === undefined ||
        proofProviderNotBeforeAt === undefined ||
        proofCompletedAt === undefined ||
        sourceRequest.status !== proof.status ||
        sourceRequest.outcome !== proof.outcome ||
        sourceRequest.failureClass !== proof.failureClass ||
        sourceRequest.providerSnapshotFingerprint !==
          entry.currentProviderSnapshotFingerprint ||
        sourceRequest.startedAt.getTime() > proofObservedAt.getTime() ||
        sourceRequest.createdAt.getTime() > sourceRequest.updatedAt.getTime() ||
        sourceRequest.updatedAt.getTime() > now.getTime() ||
        (sourceRequest.nextAttemptAt?.toISOString() ?? null) !==
          proofNextAttemptAt ||
        (sourceRequest.completedAt?.toISOString() ?? null) !==
          proofCompletedAt ||
        sourceRequestEvidence.schemaVersion !== 1 ||
        sourceRequestEvidence.kind !== "PROVIDER_VERIFICATION" ||
        sourceRequestEvidence.releaseSha !== closeoutRuntimeVersion ||
        sourceRequestEvidence.runtimeVersion !== closeoutRuntimeVersion ||
        sourceRequestEvidence.observedAt !== proof.observedAt ||
        sourceRequestEvidence.outcome !== proof.outcome ||
        sourceRequestEvidence.failureClass !== proof.failureClass ||
        sourceRequestEvidence.providerExecution !== proof.providerExecution ||
        sourceRequestEvidence.providerFamilyKey !==
          entry.incident.providerFamilyKey ||
        sourceRequestEvidence.providerSnapshotFingerprint !==
          entry.currentProviderSnapshotFingerprint ||
        evidenceProviderNotBeforeAt === undefined ||
        evidenceProviderNotBeforeAt !== proofProviderNotBeforeAt ||
        !/^[a-f0-9]{64}$/u.test(entry.incident.failureFingerprint) ||
        !/^[a-f0-9]{64}$/u.test(identity.failureFingerprint) ||
        identity.failureFingerprint === entry.incident.failureFingerprint ||
        !/^[a-f0-9]{64}$/u.test(
          identity.claimedProviderSnapshotFingerprint,
        ) ||
        identity.claimedProviderSnapshotFingerprint !==
          identity.observedProviderSnapshotFingerprint ||
        !/^[a-f0-9]{40}$/u.test(closeoutRuntimeVersion) ||
        getAuthoritativeCourseMonitoringResolution(
          entry.course.monitoringStatus?.state,
        )
      ) {
        return [];
      }
      const providerNotBeforeAt = getDetachedFailureRetryNotBefore({
        proofSnapshot: entry.proofSnapshot,
        releaseSha: batch.releaseSha,
        now,
      });
      const eligibleAt = [
        now,
        identity.failureOnlyHandoffCooldown.expiresAt,
        ...(providerNotBeforeAt ? [providerNotBeforeAt] : []),
      ].reduce((latest, candidate) =>
        candidate.getTime() > latest.getTime() ? candidate : latest,
      );
      const signal = createDeferredFailureHandoffSignal({
        state: "AVAILABLE",
        sourceBatchIncidentDigest:
          createDeferredFailureHandoffBatchIncidentDigest(entry.id),
        sourceProofDigest: createDeferredFailureHandoffSourceProofDigest({
          kind: "PROVIDER_VERIFICATION_FAILURE",
          status: proof.status as string,
          outcome: "FETCH_FAILED",
          failureClass: proof.failureClass as string,
          observedAt: proof.observedAt as string,
          runtimeVersion: closeoutRuntimeVersion,
          providerExecution: proof.providerExecution as boolean,
          providerSnapshotFingerprint:
            entry.currentProviderSnapshotFingerprint,
          completedAt: proofCompletedAt,
          nextAttemptAt: proofNextAttemptAt,
          providerRetryNotBeforeAt: proofProviderNotBeforeAt,
        }),
        providerFamilyKey: entry.incident.providerFamilyKey,
        canonicalFailureFingerprint: entry.incident.failureFingerprint,
        observedFailureFingerprint: identity.failureFingerprint,
        claimedProviderSnapshotFingerprint:
          identity.claimedProviderSnapshotFingerprint,
        observedProviderSnapshotFingerprint:
          identity.observedProviderSnapshotFingerprint,
        runtimeVersion: closeoutRuntimeVersion,
        cooldownExpiresAt:
          identity.failureOnlyHandoffCooldown.expiresAt.toISOString(),
        providerNotBeforeAt: providerNotBeforeAt?.toISOString() ?? null,
        eligibleAt: eligibleAt.toISOString(),
        sourceVerificationWatchMode: "WATCH_SETTLED",
        sourceResult: "RETRY_SCHEDULED",
        sourceAttemptConsumed: true,
        confirmationStarted: false,
      });
      return [[
        entry.id,
        { kind: "INITIAL" as const, source: signal },
      ] as const];
    }),
  );
  for (const entry of baseNormalizedEntries) {
    const normalizedProof = asJsonObject(entry.proofSnapshot);
    const playbookAssessment = assessAutomationPlaybook(
      entry.incident.attemptLedger,
      entry.incident.cycle,
    );
    const canContinueIncompletePlaybook =
      playbookAssessment.conclusion === "INCOMPLETE" &&
      Boolean(playbookAssessment.nextStage) &&
      (Boolean(
        currentFailureIdentityByBatchIncidentId.get(entry.id)
          ?.failureOnlyHandoffCooldown?.active,
      ) ||
        shouldContinueSettledCourseSupportRemediation({
          remediationDirective,
          failureClass: getEffectiveCourseSupportRetryFailureClass({
            incidentFailureClass: entry.incident.failureClass,
            proofSnapshot: entry.proofSnapshot,
          }),
          attemptCount: entry.incident.attemptCount,
          playbookConclusion: playbookAssessment.conclusion,
          nextPlaybookStage: playbookAssessment.nextStage,
          nextPlaybookStageStatus:
            getCourseSupportNextStageStatus(playbookAssessment),
          nextPlaybookStageAttemptCount:
            getCourseSupportNextStageAttemptCount(playbookAssessment),
        }));
    const sourceUnverifiedHumanReview =
      normalizedProof.kind === "HUMAN_REVIEW_REQUIRED" &&
      normalizedProof.disposition === "SOURCE_UNVERIFIED";
    const exhaustedDiscoveryImplementationHandoff = Boolean(
      playbookAssessment.conclusion === "UNRESOLVED_EXHAUSTED" &&
        entry.normalizedResult === "RETRY_SCHEDULED" &&
        shouldImplementReusableSupportAfterExhaustedDiscovery({
          ...entry.course,
          failureClass: getEffectiveCourseSupportRetryFailureClass({
            incidentFailureClass: entry.incident.failureClass,
            proofSnapshot: entry.proofSnapshot,
          }),
        }),
    );
    if (
      entry.normalizedResult === "NEEDS_HUMAN" &&
      !entry.automationStalled &&
      !sourceUnverifiedHumanReview &&
      !currentFailureIdentityByBatchIncidentId.get(entry.id)?.materialChange &&
      !isAutomationPlaybookExhausted(
        entry.incident.attemptLedger,
        entry.incident.cycle,
      )
    ) {
      throw new Error(
        "Course-support closeout cannot request human review before the current automation playbook is exhausted.",
      );
    }
    if (
      entry.normalizedResult === "RETRY_SCHEDULED" &&
      (verificationWatchMode === "STANDARD" ||
        verificationWatchMode === "WATCH_SETTLED") &&
      !currentFailureIdentityByBatchIncidentId.get(entry.id)?.materialChange &&
      !deferredFailureHandoffByBatchIncidentId.has(entry.id) &&
      !canContinueIncompletePlaybook &&
      !exhaustedDiscoveryImplementationHandoff &&
      !canCloseCourseSupportRetry(
        getEffectiveCourseSupportRetryFailureClass({
          incidentFailureClass: entry.incident.failureClass,
          proofSnapshot: entry.proofSnapshot,
        }),
        input.requestedOutcome,
      )
    ) {
      throw new Error(
        "A non-transient provider restriction requires current final-disposition evidence or an explicit human escalation.",
      );
    }
    if (
      ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult) &&
      !isAuthoritativeFactualCourseMonitoringState(
        entry.course.monitoringStatus?.state,
      ) &&
      !getAuthoritativeCourseMonitoringResolution(
        entry.course.monitoringStatus?.state,
      ) &&
      !isDurableTerminalProof(entry, batch) &&
      !currentFailureIdentityByBatchIncidentId.get(entry.id)?.materialChange
    ) {
      throw new Error("Terminal course-support evidence is missing or stale.");
    }
    if (
      !ownershipReleaseMode &&
      entry.verifiedIncidentUpdatedAt &&
      entry.incident.updatedAt.getTime() !==
        entry.verifiedIncidentUpdatedAt.getTime() &&
      !currentFailureIdentityByBatchIncidentId.get(entry.id)?.materialChange
    ) {
      throw new Error("A course-support incident changed after verification.");
    }
  }
  const verificationRequestStartedByBatchIncidentId = new Set(
    detachedRequestStatesAtCloseout.flatMap((request) =>
      request.startedAt !== null ? [request.batchIncidentId] : [],
    ),
  );
  const providerExecutionObservedByBatchIncidentId = new Set([
    ...detachedRequestStatesAtCloseout.flatMap((request) =>
      hasDurableDetachedProviderExecutionEvidence(request)
        ? [request.batchIncidentId]
        : [],
    ),
    ...batch.incidents.flatMap((entry) =>
      hasExactRuntimeBrowserProviderExecutionEvidence({
        attemptLedger: entry.incident.attemptLedger,
        cycle: entry.cycle,
        claimedAt: batch.createdAt,
        deployedAt: batch.deployedAt,
        releaseSha: batch.releaseSha,
      })
        ? [entry.id]
        : [],
    ),
  ]);
  const releaseHistoryOrdinalByBatchIncidentId = new Map(
    batch.incidents.map((entry, index) => [entry.id, index + 1]),
  );
  const rawCloseoutRemediationAttempts = baseNormalizedEntries.map((entry) => {
    const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
    const historicalExecution = readCourseSupportReleaseExecutionEvidence({
      summary: batch.summary,
      baseSha: batch.baseSha,
      courseRef,
      legacyOrdinal: releaseHistoryOrdinalByBatchIncidentId.get(entry.id),
    });
    const plannedAttempt = asJsonObject(
      plannedRemediationAttempts.find(
        (candidate) => asJsonObject(candidate).courseRef === courseRef,
      ),
    );
    const claimedProviderSnapshotFingerprint =
      typeof plannedAttempt.providerSnapshotFingerprint === "string"
        ? plannedAttempt.providerSnapshotFingerprint
        : (currentFailureIdentityByBatchIncidentId.get(entry.id)
            ?.claimedProviderSnapshotFingerprint ??
          entry.currentProviderSnapshotFingerprint);
    const claimedImplementationPaths = hasRuntimeBearingCourseSupportPath(
      readBatchPlannedPaths(batch.summary)
    );
    const newReleaseRecorded = Boolean(
      typeof batch.baseSha === "string" &&
      typeof batch.releaseSha === "string" &&
      batch.releaseSha !== batch.baseSha,
    );
    const deploymentRecorded = Boolean(
      (newReleaseRecorded && batch.deployedAt) ||
      historicalExecution.changedReleaseDeploymentEver,
    );
    const postProbeRecorded = Boolean(
      typeof entry.postProbeId === "string" &&
      entry.postProbeId !== entry.preProbeId,
    );
    const currentProviderAttemptRecorded = hasCurrentCourseSupportProviderExecutionProof({
      proofSnapshot: entry.proofSnapshot,
      baseSha: batch.baseSha,
      releaseSha: batch.releaseSha,
      claimedAt: batch.createdAt,
      recheckDispatchStartedAt: batch.recheckDispatchStartedAt
    });
    const providerAttemptRecorded = Boolean(
      historicalExecution.providerExecutionEverForCourse || currentProviderAttemptRecorded
    );
    const currentProviderExecutionAttemptRecorded = Boolean(
      providerExecutionObservedByBatchIncidentId.has(entry.id) ||
      hasCourseSupportProviderExecutionAttemptEvidence({
        proofSnapshot: entry.proofSnapshot,
        baseSha: batch.baseSha,
        releaseSha: batch.releaseSha,
        claimedAt: batch.createdAt,
        recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      }),
    );
    const providerExecutionAttemptRecorded = Boolean(
      historicalExecution.providerExecutionAttemptEverForCourse ||
      currentProviderExecutionAttemptRecorded
    );
    const playbookAttemptRecorded = hasCourseSupportPlaybookAttemptSinceClaim({
      attemptLedger: entry.incident.attemptLedger,
      cycle: entry.cycle,
      eventCountAtClaim: plannedAttempt.playbookEventCountAtClaim,
      claimedAt: batch.createdAt,
    });
    const durableFactualBatchProofRecorded = Boolean(
      entry.normalizedResult === "FINAL_DISPOSITION" &&
      asJsonObject(entry.proofSnapshot).kind === "PLAYBOOK_FACTUAL_FINAL" &&
      isDurableTerminalProof(entry, batch),
    );
    const currentFailureIdentity = currentFailureIdentityByBatchIncidentId.get(entry.id);
    const currentTerminalResultRecorded = Boolean(
      ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult) &&
        (isAuthoritativeFactualCourseMonitoringState(
          entry.course.monitoringStatus?.state,
        ) ||
          durableFactualBatchProofRecorded ||
          (!currentFailureIdentity?.materialChange &&
            (getAuthoritativeCourseMonitoringResolution(
              entry.course.monitoringStatus?.state,
            ) ||
              isDurableTerminalProof(entry, batch)))));
    const terminalResultRecorded = Boolean(
      historicalExecution.terminalExecutionEverForCourse || currentTerminalResultRecorded
    );
    const approach = parseCourseSupportRemediationApproach(
      plannedAttempt.approach,
    );
    const executionEvidence = {
      claimedImplementationPaths,
      newReleaseRecorded,
      deploymentRecorded,
      postProbeRecorded,
      providerAttemptRecorded,
      providerExecutionAttemptRecorded,
      playbookAttemptRecorded,
      terminalResultRecorded,
      // Legacy persisted key: this is PRE_EXECUTION request attachment, not
      // independently observed provider I/O.
      providerExecutionStarted: verificationRequestStartedByBatchIncidentId.has(
        entry.id,
      ),
    } satisfies CourseSupportDecisionExecutionEvidence;
    const actionPlanWasPersisted = Object.prototype.hasOwnProperty.call(
      plannedAttempt,
      "actionPlan"
    );
    const claimedAttempt = actionPlanWasPersisted
      ? readCourseSupportRemediationClaimAttempt({
          summary: batch.summary,
          courseId: entry.courseId,
          expectedAttemptCount: batch.incidents.length
        })
      : null;
    if (actionPlanWasPersisted && !claimedAttempt?.actionPlan) {
      throw new Error(
        "The persisted course-support action plan is invalid or no longer matches the claimed remediation route."
      );
    }
    const actionExecution = claimedAttempt?.actionPlan
      ? buildCourseSupportActionExecution({
          action: claimedAttempt.actionPlan.primaryAction,
          strictImplementationProofRecorded:
            hasCourseSupportImplementationExecutionProofIncludingHistory({
              summary: batch.summary,
              baseSha: batch.baseSha,
              releaseSha: batch.releaseSha,
              deployedAt: batch.deployedAt
            }),
          authoritativeSuccessSuperseded: authoritativeSuccessProbeByBatchIncidentId.has(entry.id),
          materialChangeSuperseded: currentFailureIdentity?.materialChange === true,
          authoritativeTerminalResultSuperseded: Boolean(
            !authoritativeSuccessProbeByBatchIncidentId.has(entry.id) &&
            ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult) &&
            currentTerminalResultRecorded
          ),
          currentRuntimeProofRecorded: Boolean(
            currentProviderAttemptRecorded ||
            providerExecutionObservedByBatchIncidentId.has(entry.id) ||
            currentTerminalResultRecorded
          ),
          currentClassificationProofRecorded: Boolean(
            entry.normalizedResult === "FINAL_DISPOSITION" && currentTerminalResultRecorded
          )
        })
      : null;
    const assignedAdapterOrchestrationMiss =
      isCourseSupportAssignedAdapterOrchestrationMiss({
        approach: plannedAttempt.approach,
        executionEvidence,
      });
    const consumed = assignedAdapterOrchestrationMiss
      ? false
      : deploymentRecorded ||
        providerAttemptRecorded ||
        playbookAttemptRecorded ||
        terminalResultRecorded;
    const countsTowardOperationalNoProgress = assignedAdapterOrchestrationMiss
      ? false
      : Boolean(consumed || providerExecutionAttemptRecorded);
    const deferredFailureHandoff =
      deferredFailureHandoffByBatchIncidentId.get(entry.id);
    const persistedDeferredFailureHandoff = deferredFailureHandoff
      ? createDeferredFailureHandoffSignal({
            state:
              deferredFailureHandoff.kind === "CARRIER" &&
              deferredFailureHandoff.confirmationStarted
                ? "CONSUMED"
                : "AVAILABLE",
            sourceBatchIncidentDigest:
              createDeferredFailureHandoffBatchIncidentDigest(entry.id),
            sourceProofDigest: deferredFailureHandoff.source.sourceProofDigest,
            providerFamilyKey:
              deferredFailureHandoff.source.providerFamilyKey,
            canonicalFailureFingerprint:
              deferredFailureHandoff.source.canonicalFailureFingerprint,
            observedFailureFingerprint:
              deferredFailureHandoff.source.observedFailureFingerprint,
            claimedProviderSnapshotFingerprint:
              deferredFailureHandoff.source.claimedProviderSnapshotFingerprint,
            observedProviderSnapshotFingerprint:
              deferredFailureHandoff.source
                .observedProviderSnapshotFingerprint,
            runtimeVersion: deferredFailureHandoff.source.runtimeVersion,
            cooldownExpiresAt:
              deferredFailureHandoff.source.cooldownExpiresAt,
            providerNotBeforeAt:
              deferredFailureHandoff.source.providerNotBeforeAt,
            eligibleAt: deferredFailureHandoff.source.eligibleAt,
            sourceVerificationWatchMode: "WATCH_SETTLED",
            sourceResult: deferredFailureHandoff.source.sourceResult,
            sourceAttemptConsumed: true,
            confirmationStarted:
              deferredFailureHandoff.kind === "CARRIER" &&
              deferredFailureHandoff.confirmationStarted,
        })
      : null;
    const plannedRetryBudget =
      readCourseSupportDecisionRetryBudgetValue(plannedAttempt);
    return {
      courseRef,
      // Keep the fingerprint that the attempt actually claimed. If provider
      // inputs changed while the batch was running, the next selector must see
      // that F1 -> F2 change instead of recording F2 as already attempted.
      providerSnapshotFingerprint: claimedProviderSnapshotFingerprint,
      observedProviderSnapshotFingerprint:
        entry.currentProviderSnapshotFingerprint,
      failureFingerprint: entry.incident.failureFingerprint,
      observedFailureFingerprint:
        currentFailureIdentityByBatchIncidentId.get(entry.id)
          ?.failureFingerprint ?? entry.incident.failureFingerprint,
      failureOnlyHandoffCooldownUntil:
        persistedDeferredFailureHandoff?.cooldownExpiresAt ??
        currentFailureIdentityByBatchIncidentId
          .get(entry.id)
          ?.failureOnlyHandoffCooldown?.expiresAt.toISOString() ??
        null,
      runtimeVersion: batch.releaseSha ?? batch.baseSha,
      activeRealSearchCount: entry.incident.activeRealSearchCount,
      consumed,
      countsTowardOperationalNoProgress,
      executionEvidence,
      ...(actionExecution ? { actionExecution } : {}),
      ...(persistedDeferredFailureHandoff
        ? {
            deferredFailureHandoff: persistedDeferredFailureHandoff,
            ...(deferredFailureHandoff?.kind === "CARRIER"
              ? {
                  deferredFailureHandoffAdmission:
                    createDeferredFailureHandoffAdmission({
                      signal: persistedDeferredFailureHandoff,
                      admittedAt: deferredFailureHandoff.admittedAt,
                    }),
                }
              : {}),
          }
        : {}),
      ...(plannedRetryBudget.status === "AVAILABLE"
        ? { retryBudget: plannedRetryBudget.budget }
        : plannedRetryBudget.status === "NOT_APPLICABLE"
          ? { retryBudget: null }
          : {}),
      approach,
    } satisfies Prisma.InputJsonObject;
  });
  const claimedImplementationStillRequired = rawCloseoutRemediationAttempts.some(
    (attempt, index) => {
      const entry = baseNormalizedEntries[index];
      if (!entry) return false;
      const plannedAttempt = asJsonObject(
        plannedRemediationAttempts.find(
          (candidate) =>
            asJsonObject(candidate).courseRef === attempt.courseRef,
        ),
      );
      const actionPlanWasPersisted = Object.prototype.hasOwnProperty.call(
        plannedAttempt,
        "actionPlan",
      );
      if (!actionPlanWasPersisted) {
        // Batches claimed before action plans were introduced retain their
        // existing closeout behavior until they close or are reclaimed.
        return false;
      }
      const claimedAttempt = readCourseSupportRemediationClaimAttempt({
        summary: batch.summary,
        courseId: entry.courseId,
        expectedAttemptCount: batch.incidents.length,
      });
      if (!claimedAttempt?.actionPlan) {
        throw new Error(
          "The persisted course-support action plan is invalid or no longer matches the claimed remediation route.",
        );
      }
      if (
        claimedAttempt.actionPlan.primaryAction !==
        "IMPLEMENT_REUSABLE_SUPPORT"
      ) {
        return false;
      }
      const currentFailureIdentity =
        currentFailureIdentityByBatchIncidentId.get(entry.id);
      const authoritativeTerminalWinner =
        authoritativeSuccessProbeByBatchIncidentId.has(entry.id) ||
        (["RESTORED", "FINAL_DISPOSITION"].includes(
          entry.normalizedResult,
        ) && attempt.executionEvidence.terminalResultRecorded === true);
      return Boolean(
        !currentFailureIdentity?.materialChange &&
          !authoritativeTerminalWinner,
      );
    },
  );
  if (claimedImplementationStillRequired) {
    if (remediationDirective?.requiresImplementationPath !== true) {
      throw new Error(
        "The persisted implementation action no longer matches the batch remediation directive.",
      );
    }
    // A stopped verification watch must not turn skipped implementation into
    // an orchestration-only retry. Keep the owned batch resumable so the
    // assigned runtime change can be completed in this launch, while material
    // provider changes and authoritative terminal evidence retain their
    // existing handoff paths.
    assertCourseSupportImplementationVerificationReady({
      summary: batch.summary,
      baseSha: batch.baseSha,
      releaseSha: batch.releaseSha,
      deployedAt: batch.deployedAt,
    });
  }
  if (
    !persistedSearchExecutionFence &&
    rawCloseoutRemediationAttempts.some(
      (attempt) => attempt.countsTowardOperationalNoProgress === false,
    )
  ) {
    throw new CourseSupportSearchExecutionFenceRetryError(
      "Legacy course-support verification lacks a search-execution fence for orchestration-only closeout.",
    );
  }
  const operationalRetryByCourseRef = new Map(
    rawCloseoutRemediationAttempts.map((attempt, index) => {
      const entry = baseNormalizedEntries[index];
      if (!entry || attempt.consumed || !attempt.approach) {
        return [attempt.courseRef, null] as const;
      }
      const priorAttempts = countCourseSupportOperationalNoProgressAttempts({
        batchIncidents: entry.incident.batchIncidents ?? [],
        cycle: entry.cycle,
        courseId: entry.courseId,
        providerSnapshotFingerprint: attempt.providerSnapshotFingerprint,
        failureFingerprint: attempt.failureFingerprint,
        approach: attempt.approach,
        zeroExecutionRecoveryRecorded: hasValidatedZeroExecutionRecoveryMarker(
          entry.cycle,
          entry.incident.monitoringEvents,
        ),
      });
      const attemptsCompleted =
        priorAttempts + (attempt.countsTowardOperationalNoProgress ? 1 : 0);
      return [
        attempt.courseRef,
        {
          maximumAttempts: COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET,
          attemptsCompleted,
          attemptsRemaining: Math.max(
            0,
            COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET - attemptsCompleted,
          ),
          exhausted:
            attemptsCompleted >= COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET,
          reason:
            attemptsCompleted >= COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET
              ? "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
              : "OPERATIONAL_RETRY_AVAILABLE",
        },
      ] as const;
    }),
  );
  const orchestrationRetryByCourseRef = new Map(
    rawCloseoutRemediationAttempts.flatMap((attempt, index) => {
      const entry = baseNormalizedEntries[index];
      if (!entry || attempt.countsTowardOperationalNoProgress !== false)
        return [];
      const deferredSignal = parseDeferredFailureHandoffSignal(
        attempt.deferredFailureHandoff,
      );
      const executionEvidence =
        readExactCourseSupportDecisionExecutionEvidenceShape(
          attempt.executionEvidence,
        );
      if (deferredSignal && executionEvidence?.providerExecutionStarted) {
        return [];
      }
      const schedule = getCourseSupportOrchestrationRetrySchedule({
        now,
        priorAttemptCount: countCourseSupportCompletedOrchestrationOnlyAttempts(
          {
            courseId: entry.courseId,
            cycle: entry.cycle,
            entries: entry.incident.batchIncidents ?? [],
            allowValidatedLegacy: hasValidatedZeroExecutionRecoveryMarker(
              entry.cycle,
              entry.incident.monitoringEvents,
            ),
          },
        ),
      });
      return [[attempt.courseRef, schedule] as const];
    }),
  );
  const closeoutRemediationAttempts = rawCloseoutRemediationAttempts.map(
    (attempt) => {
      const orchestrationRetry = orchestrationRetryByCourseRef.get(
        attempt.courseRef,
      );
      const deferredSignal = parseDeferredFailureHandoffSignal(
        attempt.deferredFailureHandoff,
      );
      const deferredEligibleAt =
        deferredSignal?.state === "AVAILABLE" && orchestrationRetry
          ? new Date(
              Math.max(
                new Date(deferredSignal.eligibleAt).getTime(),
                orchestrationRetry.retryAt.getTime(),
              ),
            )
          : deferredSignal
            ? new Date(deferredSignal.eligibleAt)
            : null;
      const refreshedDeferredSignal =
        deferredSignal && deferredEligibleAt
          ? createDeferredFailureHandoffSignal({
              state: deferredSignal.state,
              sourceBatchIncidentDigest:
                deferredSignal.sourceBatchIncidentDigest,
              sourceProofDigest: deferredSignal.sourceProofDigest,
              providerFamilyKey: deferredSignal.providerFamilyKey,
              canonicalFailureFingerprint:
                deferredSignal.canonicalFailureFingerprint,
              observedFailureFingerprint:
                deferredSignal.observedFailureFingerprint,
              claimedProviderSnapshotFingerprint:
                deferredSignal.claimedProviderSnapshotFingerprint,
              observedProviderSnapshotFingerprint:
                deferredSignal.observedProviderSnapshotFingerprint,
              runtimeVersion: deferredSignal.runtimeVersion,
              cooldownExpiresAt: deferredSignal.cooldownExpiresAt,
              providerNotBeforeAt: deferredSignal.providerNotBeforeAt,
              eligibleAt: deferredEligibleAt.toISOString(),
              sourceVerificationWatchMode: "WATCH_SETTLED",
              sourceResult: deferredSignal.sourceResult,
              sourceAttemptConsumed: true,
              confirmationStarted: deferredSignal.confirmationStarted,
            })
          : null;
      const deferredAdmission = parseDeferredFailureHandoffAdmission(
        attempt.deferredFailureHandoffAdmission,
      );
      return {
        ...attempt,
        ...(refreshedDeferredSignal
          ? {
              deferredFailureHandoff: refreshedDeferredSignal,
              ...(deferredAdmission
                ? {
                    deferredFailureHandoffAdmission:
                      createDeferredFailureHandoffAdmission({
                        signal: refreshedDeferredSignal,
                        admittedAt: new Date(deferredAdmission.admittedAt),
                      }),
                  }
                : {}),
            }
          : {}),
        operationalRetry:
          operationalRetryByCourseRef.get(attempt.courseRef) ?? null,
        orchestrationRetry: orchestrationRetry
          ? {
              attemptNumber: orchestrationRetry.attemptNumber,
              delaySeconds: Math.floor(orchestrationRetry.delayMs / 1000),
              retryAt: orchestrationRetry.retryAt.toISOString(),
            }
          : null,
      };
    },
  );
  const normalizedEntries = baseNormalizedEntries.map((entry) => {
    const currentFailureIdentity = currentFailureIdentityByBatchIncidentId.get(
      entry.id,
    )!;
    const currentPlaybookAssessment = assessAutomationPlaybook(
      entry.incident.attemptLedger,
      entry.cycle,
    );
    const authoritativeSuccessProbe =
      authoritativeSuccessProbeByBatchIncidentId.get(entry.id);
    if (authoritativeSuccessProbe) {
      return {
        ...entry,
        normalizedResult: "RESTORED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: null,
        postProbeId: authoritativeSuccessProbe.id,
        verifiedAt: authoritativeSuccessProbe.observedAt,
        verifiedIncidentUpdatedAt: entry.incident.updatedAt,
        proofSnapshot: buildAuthoritativeCourseSupportSuccessProbeProof(
          authoritativeSuccessProbe,
        ),
        message:
          "A fresh successful customer monitoring probe superseded the responder's stale failure observation.",
      };
    }
    const factualMonitoringWinner =
      isAuthoritativeFactualCourseMonitoringState(
        entry.course.monitoringStatus?.state,
      ) ||
      (entry.normalizedResult === "FINAL_DISPOSITION" &&
        asJsonObject(entry.proofSnapshot).kind === "PLAYBOOK_FACTUAL_FINAL" &&
        isDurableTerminalProof(entry, batch));
    const deferredCloseoutSource =
      deferredFailureHandoffByBatchIncidentId.get(entry.id);
    const deferredConfirmationStartedWithoutProviderExecution = Boolean(
      deferredCloseoutSource?.kind === "CARRIER" &&
        deferredCloseoutSource.confirmationStarted &&
        asJsonObject(entry.proofSnapshot).providerExecution !== true,
    );
    const unconfirmedVerifierOnlyMaterialChange = Boolean(
      deferredConfirmationStartedWithoutProviderExecution &&
        currentFailureIdentity.providerFamilyKey ===
          entry.incident.providerFamilyKey &&
        !currentFailureIdentity.providerSnapshotChanged &&
        (!entry.course.monitoringStatus?.failureFingerprint ||
          courseSupportFailureFingerprintsMatch(
            entry.course.monitoringStatus.failureFingerprint,
            entry.incident.failureFingerprint,
          )),
    );
    const staleResultAfterMaterialChange =
      !factualMonitoringWinner &&
      currentFailureIdentity.materialChange &&
      !unconfirmedVerifierOnlyMaterialChange &&
      [
        "RESTORED",
        "FINAL_DISPOSITION",
        "RETRY_SCHEDULED",
        "NEEDS_HUMAN",
      ].includes(entry.normalizedResult);
    if (staleResultAfterMaterialChange) {
      return {
        ...entry,
        normalizedResult: "RETRY_SCHEDULED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: {
          fromProviderFamilyKey: entry.incident.providerFamilyKey,
          toProviderFamilyKey: currentFailureIdentity.providerFamilyKey,
          priorFailureFingerprint: entry.incident.failureFingerprint,
          failureClass: currentFailureIdentity.failureClass,
          failureFingerprint: currentFailureIdentity.failureFingerprint,
          claimedProviderSnapshotFingerprint:
            currentFailureIdentity.claimedProviderSnapshotFingerprint,
          observedProviderSnapshotFingerprint:
            currentFailureIdentity.observedProviderSnapshotFingerprint,
          providerSnapshotChanged:
            currentFailureIdentity.providerSnapshotChanged,
          nextAttemptAt: currentFailureIdentity.nextAttemptAt,
          providerFamilyChanged:
            currentFailureIdentity.providerFamilyKey !==
            entry.incident.providerFamilyKey,
        },
        message:
          "Current provider or failure evidence changed while the batch was active, so the incident was moved to a fresh remediation episode.",
      };
    }
    const deferredFailureHandoff = parseDeferredFailureHandoffSignal(
      closeoutRemediationAttempts.find(
        (attempt) =>
          attempt.courseRef ===
          createCourseSupportRemediationCourseRef(entry.courseId),
      )?.deferredFailureHandoff,
    );
    if (
      deferredFailureHandoff?.state === "CONSUMED" &&
      deferredFailureHandoff.confirmationStarted &&
      deferredConfirmationStartedWithoutProviderExecution &&
      !factualMonitoringWinner &&
      !currentFailureIdentity.providerSnapshotChanged &&
      currentFailureIdentity.providerFamilyKey ===
        entry.incident.providerFamilyKey &&
      (!entry.course.monitoringStatus?.failureFingerprint ||
        courseSupportFailureFingerprintsMatch(
          entry.course.monitoringStatus.failureFingerprint,
          entry.incident.failureFingerprint,
        ))
    ) {
      return {
        ...entry,
        normalizedResult: "RETRY_SCHEDULED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: null,
        deferredFailureHandoff,
        message:
          "The one-shot failure confirmation started without provider execution, so its signal was consumed without changing the canonical failure identity.",
      };
    }
    const deferredFailureConfirmationPending = Boolean(
      deferredFailureHandoff?.state === "AVAILABLE" &&
        !deferredFailureHandoff.confirmationStarted &&
        !factualMonitoringWinner &&
        !currentFailureIdentity.materialChange &&
        ["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"].includes(
          entry.result,
        ) &&
        currentPlaybookAssessment.conclusion === "UNRESOLVED_EXHAUSTED" &&
        currentPlaybookAssessment.nextStage === null,
    );
    if (deferredFailureConfirmationPending) {
      return {
        ...entry,
        normalizedResult: "RETRY_SCHEDULED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: null,
        deferredFailureHandoff,
        message:
          "A verifier-only failure change is cooling down before one exact confirmation read.",
      };
    }
    const cooldownContinuesIncompletePlaybook =
      Boolean(currentFailureIdentity.failureOnlyHandoffCooldown?.active) &&
      ["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"].includes(
        entry.result,
      ) &&
      currentPlaybookAssessment.conclusion === "INCOMPLETE" &&
      Boolean(currentPlaybookAssessment.nextStage);
    if (cooldownContinuesIncompletePlaybook) {
      return {
        ...entry,
        normalizedResult: "RETRY_SCHEDULED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: null,
        message:
          "Verifier-only failure churn stayed in the current bounded playbook episode.",
      };
    }
    const remediationAttempt = closeoutRemediationAttempts.find(
      (attempt) =>
        attempt.courseRef ===
        createCourseSupportRemediationCourseRef(entry.courseId),
    );
    const currentCycleIsOrchestrationOnly = Boolean(
      remediationAttempt?.countsTowardOperationalNoProgress === false &&
      (currentPlaybookAssessment.completedStages.length === 0 ||
        isCourseSupportAssignedAdapterOrchestrationMiss({
          approach: remediationAttempt?.approach,
          executionEvidence: remediationAttempt?.executionEvidence,
        })) &&
      areCourseSupportCompletedAttemptsOrchestrationOnly({
        courseId: entry.courseId,
        cycle: entry.cycle,
        entries: entry.incident.batchIncidents ?? [],
        allowEmpty: true,
        allowValidatedLegacy: hasValidatedZeroExecutionRecoveryMarker(
          entry.cycle,
          entry.incident.monitoringEvents,
        ),
      }),
    );
    if (
      currentCycleIsOrchestrationOnly &&
      !factualMonitoringWinner &&
      (entry.automationStalled || entry.normalizedResult === "NEEDS_HUMAN")
    ) {
      return {
        ...entry,
        normalizedResult: "RETRY_SCHEDULED" as const,
        automationStalled: false,
        operationalRetryBudgetExhausted: false,
        providerFamilyHandoff: null,
        message:
          "Provider verification was rescheduled because this cycle never reached execution.",
      };
    }
    const operationalRetry = operationalRetryByCourseRef.get(
      createCourseSupportRemediationCourseRef(entry.courseId),
    );
    const canContinueIncompletePlaybook =
      currentPlaybookAssessment.conclusion === "INCOMPLETE" &&
      Boolean(currentPlaybookAssessment.nextStage) &&
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective,
        failureClass: getEffectiveCourseSupportRetryFailureClass({
          incidentFailureClass: entry.incident.failureClass,
          proofSnapshot: entry.proofSnapshot,
        }),
        attemptCount: entry.incident.attemptCount,
        playbookConclusion: currentPlaybookAssessment.conclusion,
        nextPlaybookStage: currentPlaybookAssessment.nextStage,
        nextPlaybookStageStatus:
          getCourseSupportNextStageStatus(currentPlaybookAssessment),
        nextPlaybookStageAttemptCount:
          getCourseSupportNextStageAttemptCount(currentPlaybookAssessment),
      });
    if (
      operationalRetry?.exhausted &&
      entry.normalizedResult === "RETRY_SCHEDULED" &&
      !entry.automationStalled &&
      !canContinueIncompletePlaybook
    ) {
      return {
        ...entry,
        normalizedResult: "NEEDS_HUMAN" as const,
        automationStalled: true,
        operationalRetryBudgetExhausted: true,
        providerFamilyHandoff: null,
        message:
          "The unchanged operational attempt made no technical progress twice and was parked until a material input changes.",
      };
    }
    return {
      ...entry,
      operationalRetryBudgetExhausted: false,
      providerFamilyHandoff: null,
    };
  });
  const needsHumanCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "NEEDS_HUMAN",
  ).length;
  const automationStalledCount = normalizedEntries.filter(
    (entry) => entry.automationStalled,
  ).length;
  const operationalRetryBudgetExhaustedCount = normalizedEntries.filter(
    (entry) => entry.operationalRetryBudgetExhausted,
  ).length;
  const providerFamilyHandoffCount = normalizedEntries.filter(
    (entry) => entry.providerFamilyHandoff,
  ).length;
  const hasHuman = needsHumanCount > 0;
  const terminalCount = normalizedEntries.filter((entry) =>
    ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult),
  ).length;
  const restoredCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "RESTORED",
  ).length;
  const exactReleaseTerminalEntryIds = new Set(
    normalizedEntries
      .filter((entry) => isDurableTerminalProof(entry, batch))
      .map((entry) => entry.id),
  );
  const reusableFamilyRestoredCount = normalizedEntries.filter(
    (entry) =>
      entry.normalizedResult === "RESTORED" &&
      exactReleaseTerminalEntryIds.has(entry.id) &&
      resolveProviderCapability(entry.course).providerFamilyKey ===
        batch.providerFamilyKey,
  ).length;
  const retryCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "RETRY_SCHEDULED",
  ).length;
  const restoredRequiringBatchDispatchCount = normalizedEntries.filter(
    (entry) =>
      entry.normalizedResult === "RESTORED" &&
      !authoritativeSuccessProbeByBatchIncidentId.has(entry.id) &&
      !(
        ownershipReleaseMode &&
        getAuthoritativeCourseMonitoringResolution(
          entry.course.monitoringStatus?.state,
        )
      ),
  ).length;
  if (
    restoredRequiringBatchDispatchCount > 0 &&
    !isRecheckDispatchHealthy(batch.summary, now)
  ) {
    throw new Error(
      "Affected searches do not yet have complete durable recheck and scheduler evidence.",
    );
  }
  const batchStatus: CourseSupportBatchStatus = hasHuman
    ? "PARTIAL"
    : terminalCount === normalizedEntries.length
      ? "SUCCEEDED"
      : terminalCount > 0
        ? "PARTIAL"
        : "RETRYABLE_FAILED";
  const derivedOutcome: ResponderOutcome = hasHuman
    ? "needs_human"
    : terminalCount === normalizedEntries.length
      ? normalizedEntries.every(
          (entry) => entry.normalizedResult === "FINAL_DISPOSITION",
        )
        ? "classification_only"
        : "success"
      : terminalCount > 0
        ? "partial"
        : "retryable_failed";
  const authoritativeSuccessProbeWon =
    authoritativeSuccessProbeByBatchIncidentId.size > 0;
  if (input.requestedOutcome) {
    if (DERIVED_CLOSEOUT_OUTCOMES.has(input.requestedOutcome)) {
      if (
        input.requestedOutcome !== derivedOutcome &&
        !authoritativeSuccessProbeWon
      ) {
        throw new Error(
          `Requested responder outcome ${input.requestedOutcome} contradicts the independently derived ${derivedOutcome} result.`,
        );
      }
    } else if (!FAILURE_CLOSEOUT_OUTCOMES.has(input.requestedOutcome)) {
      throw new Error(
        "Responder closeout does not accept lifecycle or routine outcomes as overrides.",
      );
    }
  }
  const outcome = authoritativeSuccessProbeWon
    ? derivedOutcome
    : (input.requestedOutcome ?? derivedOutcome);
  const retryTimes: Date[] = [];
  const safeSummary = sanitizeResponderCloseoutSummary(input.summary);
  const remediationAttemptConsumed = closeoutRemediationAttempts.some(
    (attempt) => attempt.consumed,
  );
  const orchestrationOnlyCount = closeoutRemediationAttempts.filter(
    (attempt) => attempt.countsTowardOperationalNoProgress === false,
  ).length;
  const playbookDecisionBasis =
    buildCourseSupportCloseoutPlaybookDecisionBasis({
      incidents: normalizedEntries.map((entry) => ({
        cycle: entry.cycle,
        attemptLedger: entry.incident.attemptLedger,
      })),
    });
  const remediationDecisionBasis =
    buildCourseSupportCloseoutRemediationDecisionBasis({
      incidents: normalizedEntries.map((entry) => ({
        courseId: entry.courseId,
        batchIncidentId: entry.id,
      })),
      plannedAttempts: plannedRemediationAttempts,
      closeoutAttempts: closeoutRemediationAttempts,
      now,
    });
  const decisionBasis = {
    schemaVersion: 3,
    normalizedIncidentCount: normalizedEntries.length,
    needsHumanCount,
    automationStalledCount,
    operationalRetryBudgetExhaustedCount,
    orchestrationOnlyCount,
    ...playbookDecisionBasis,
    ...remediationDecisionBasis,
  };
  const deferredProbeFenceEntries = baseNormalizedEntries.filter((entry) => {
    const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
    const plannedAttempt = asJsonObject(
      plannedRemediationAttempts.find(
        (candidate) => asJsonObject(candidate).courseRef === courseRef,
      ),
    );
    return Boolean(
      authoritativeSuccessProbeByBatchIncidentId.has(entry.id) ||
        currentFailureIdentityByBatchIncidentId.get(entry.id)
          ?.failureFingerprint !== entry.incident.failureFingerprint ||
        parseDeferredFailureHandoffSignal(
          plannedAttempt.deferredFailureHandoffSource,
        ),
    );
  });
  let siblingWakeCount = 0;

  input.signal?.throwIfAborted();
  await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
    input.signal?.throwIfAborted();
    siblingWakeCount = 0;
    await lockCourseSupportSearchExecutionFenceRows(
      tx,
      closeoutSearchExecutionFenceInput,
    );
    const lockedSearchExecutionFence =
      await readCourseSupportSearchExecutionFence(
        tx,
        closeoutSearchExecutionFenceInput,
      );
    if (
      !courseSupportSearchExecutionFenceMatches(
        expectedSearchExecutionFence,
        lockedSearchExecutionFence,
      )
    ) {
      throw new CourseSupportSearchExecutionFenceRetryError();
    }
    if (deferredProbeFenceEntries.length > 0) {
      const courseIds = [
        ...new Set(
          deferredProbeFenceEntries.map((entry) => entry.courseId),
        ),
      ].sort();
      await tx.$queryRaw(
        Prisma.sql`SELECT "id"
                   FROM "Course"
                   WHERE "id" IN (${Prisma.join(courseIds)})
                   ORDER BY "id"
                   FOR UPDATE`,
      );
      for (const entry of deferredProbeFenceEntries) {
        const currentProbes = await listAuthoritativeCourseSupportProbeEvidence(
          tx,
          {
            courseId: entry.courseId,
            incidentLastSeenAt: entry.incident.lastSeenAt,
            now,
          },
        );
        const currentAssessment =
          assessAuthoritativeCourseSupportSuccessProbe({
            probes: currentProbes,
            incidentLastSeenAt: entry.incident.lastSeenAt,
            now,
          });
        const expectedProbe =
          authoritativeSuccessProbeByBatchIncidentId.get(entry.id) ?? null;
        const currentProbe =
          currentAssessment.status === "VALID"
            ? currentAssessment.probe
            : null;
        if (
          currentAssessment.status === "INVALID" ||
          currentProbe?.id !== expectedProbe?.id ||
          currentProbe?.outcome !== expectedProbe?.outcome ||
          currentProbe?.observedAt.getTime() !==
            expectedProbe?.observedAt.getTime() ||
          currentProbe?.runtimeVersion !== expectedProbe?.runtimeVersion ||
          asJsonObject(currentProbe?.rawSummary).providerExecution !==
            asJsonObject(expectedProbe?.rawSummary).providerExecution
        ) {
          throw new CourseSupportCloseoutSnapshotChangedError();
        }
      }
    }
    const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
    const closeoutSignal = input.signal;
    const persistCourseMonitoringCloseout = async (input: {
      courseId: string;
      snapshot:
        | {
            state: CourseMonitoringState;
            lastSuccessfulAt: Date | null;
            revision: number;
          }
        | null
        | undefined;
      targetState: CourseMonitoringState;
      data: Prisma.CourseMonitoringStatusUpdateManyMutationInput;
      allowMaterialHandoff?: boolean;
    }) => {
      if (!courseMonitoringAvailable || !input.snapshot) {
        return false;
      }
      const snapshotIsAuthoritative =
        input.snapshot.state === "HEALTHY" ||
        input.snapshot.state === "FINAL_MANUAL" ||
        input.snapshot.state === "FINAL_IDENTITY" ||
        input.snapshot.state === "FINAL_TECHNICAL";
      const materialHandoffCanSupersedeSnapshot =
        input.allowMaterialHandoff === true &&
        (input.snapshot.state === "HEALTHY" ||
          input.snapshot.state === "FINAL_TECHNICAL");
      if (snapshotIsAuthoritative && !materialHandoffCanSupersedeSnapshot) {
        if (input.snapshot.state === input.targetState) {
          // Lock and CAS the unchanged authoritative row so a newer search
          // observation cannot be hidden by the batch's stale snapshot.
          closeoutSignal?.throwIfAborted();
          const monitoringAsserted = await tx.courseMonitoringStatus.updateMany(
            {
              where: {
                courseId: input.courseId,
                state: input.snapshot.state,
                revision: input.snapshot.revision,
                lastSuccessfulAt: input.snapshot.lastSuccessfulAt,
              },
              data: {
                revision: { increment: 0 },
              },
            },
          );
          if (monitoringAsserted.count !== 1) {
            throw new Error(
              "Course monitoring changed during responder closeout; reverify before closing the batch.",
            );
          }
          return false;
        }
        throw new Error(
          "Course monitoring reached a newer authoritative state during responder closeout; reverify before closing the batch.",
        );
      }
      closeoutSignal?.throwIfAborted();
      const monitoringUpdated = await tx.courseMonitoringStatus.updateMany({
        where: {
          courseId: input.courseId,
          state: input.snapshot.state,
          revision: input.snapshot.revision,
          lastSuccessfulAt: input.snapshot.lastSuccessfulAt,
        },
        data: input.data,
      });
      if (monitoringUpdated.count !== 1) {
        throw new Error(
          "Course monitoring changed during responder closeout; reverify before closing the batch.",
        );
      }
      return true;
    };
    const detachedRequestStates =
      await tx.courseSupportVerificationRequest.findMany({
        where: {
          batchIncident: { batchId: batch.id },
        },
        select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
      });
    if (detachedRequestStates.some(isActiveDetachedVerificationRequest)) {
      throw new CourseSupportCloseoutSnapshotChangedError();
    }
    const detachedRequestStatesForRuntime = detachedRequestStates.filter(
      (request) => request.releaseSha === closeoutRuntimeVersion,
    );
    for (const attempt of closeoutRemediationAttempts.filter(
      (candidate) => candidate.countsTowardOperationalNoProgress === false,
    )) {
      const entry = normalizedEntries.find(
        (candidate) =>
          createCourseSupportRemediationCourseRef(candidate.courseId) ===
          attempt.courseRef,
      );
      if (!entry) {
        throw new CourseSupportCloseoutSnapshotChangedError();
      }
      const snapshotRequests = detachedRequestStatesAtCloseout.filter(
        (candidate) => candidate.batchIncidentId === entry.id,
      );
      const freshRequests = detachedRequestStates.filter(
        (candidate) => candidate.batchIncidentId === entry.id,
      );
      if (
        !snapshotRequests.every(
          canTreatDetachedVerificationRequestAsOrchestrationOnly,
        ) ||
        !freshRequests.every(
          canTreatDetachedVerificationRequestAsOrchestrationOnly,
        ) ||
        freshRequests.length !== snapshotRequests.length ||
        freshRequests.some(
          (request) => {
            const snapshot = snapshotRequests.find(
              (candidate) => candidate.id === request.id,
            );
            return !snapshot || snapshot.revision !== request.revision;
          },
        )
      ) {
        throw new CourseSupportCloseoutSnapshotChangedError();
      }
      for (const request of snapshotRequests) {
        input.signal?.throwIfAborted();
        const requestAsserted =
          await tx.courseSupportVerificationRequest.updateMany({
            where: {
              id: request.id,
              batchIncidentId: entry.id,
              releaseSha: request.releaseSha,
              status: request.status,
              revision: request.revision,
              attemptCount: request.attemptCount,
              startedAt: request.startedAt,
              outcome: request.outcome,
              failureClass: request.failureClass,
              evidence:
                request.evidence === null
                  ? { equals: Prisma.AnyNull }
                  : { equals: request.evidence as Prisma.InputJsonValue },
              lastError: request.lastError,
              runtimeVersion: request.runtimeVersion,
              providerSnapshotFingerprint:
                request.providerSnapshotFingerprint,
              nextAttemptAt: request.nextAttemptAt,
              completedAt: request.completedAt,
              createdAt: request.createdAt,
              updatedAt: request.updatedAt,
            },
            data: {
              revision: { increment: 0 },
              updatedAt: request.updatedAt,
            },
          });
        if (requestAsserted.count !== 1) {
          throw new CourseSupportCloseoutSnapshotChangedError();
        }
      }
      if (
        !snapshotRequests.some(
          (request) => request.releaseSha === closeoutRuntimeVersion,
        )
      ) {
        const lateRequest = await tx.courseSupportVerificationRequest.findFirst(
          {
            where: {
              batchIncidentId: entry.id,
              releaseSha: closeoutRuntimeVersion,
            },
            select: { id: true },
          },
        );
        if (lateRequest) {
          throw new CourseSupportCloseoutSnapshotChangedError();
        }
      }
    }
    const materialHandoffBatchIncidentIds = new Set(
      normalizedEntries
        .filter((entry) => entry.providerFamilyHandoff)
        .map((entry) => entry.id),
    );
    const factualSucceededRequestBatchIncidentIds = new Set(
      detachedRequestStatesForRuntime
        .filter(
          (request) =>
            request.status === "SUCCEEDED" &&
            asJsonObject(request.evidence).kind === "PLAYBOOK_FACTUAL_FINAL",
        )
        .map((request) => request.batchIncidentId),
    );
    const supersededBatchIncidentIds = new Set(
      [
        ...materialHandoffBatchIncidentIds,
        ...authoritativeSuccessProbeByBatchIncidentId.keys(),
      ].filter(
        (batchIncidentId) =>
          !factualSucceededRequestBatchIncidentIds.has(batchIncidentId),
      ),
    );
    const supersededDetachedRequestCount = detachedRequestStates.filter(
      (request) =>
        supersededBatchIncidentIds.has(request.batchIncidentId) &&
        ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"].includes(
          request.status,
        ),
    ).length;
    if (batch.releaseSha && supersededDetachedRequestCount > 0) {
      input.signal?.throwIfAborted();
      const supersededRequests =
        await tx.courseSupportVerificationRequest.updateMany({
          where: {
            batchIncidentId: { in: [...supersededBatchIncidentIds] },
            releaseSha: batch.releaseSha,
            status: {
              in: ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"],
            },
          },
          data: {
            status: "STALE",
            revision: { increment: 1 },
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            completedAt: now,
            lastError: "material_failure_identity_superseded",
            updatedAt: now,
          },
        });
      if (supersededRequests.count !== supersededDetachedRequestCount) {
        throw new Error(
          "Detached provider verification changed while superseding stale material evidence.",
        );
      }
    }
    if (
      verificationWatchMode === "STANDARD" ||
      verificationWatchMode === "WATCH_SETTLED"
    ) {
      assertDetachedVerificationReadyForCloseout({
        requests: detachedRequestStates,
        verificationByBatchIncidentId: new Map(
          normalizedEntries.map((entry) => [
            entry.id,
            {
              result: entry.normalizedResult,
              postProbeId: entry.postProbeId,
              message: entry.message ?? "",
              proofSnapshot: entry.proofSnapshot,
            } satisfies BatchIncidentVerification,
          ]),
        ),
        currentFailureBatchIncidentIds: currentDetachedFailureBatchIncidentIds,
        supersededBatchIncidentIds,
        pendingContinuationBatchIncidentIds:
          getPendingDetachedContinuationBatchIncidentIds(batch.incidents),
      });
    }

    for (const entry of normalizedEntries) {
      const proof = asJsonObject(entry.proofSnapshot);
      const authoritativeMonitoringResolution = ownershipReleaseMode
        ? getAuthoritativeCourseMonitoringResolution(
            entry.course.monitoringStatus?.state,
          )
        : null;
      if (
        !authoritativeMonitoringResolution &&
        entry.normalizedResult === "RESTORED" &&
        proof.kind === "PROVIDER_VERIFICATION"
      ) {
        input.signal?.throwIfAborted();
        const detachedProofIsCurrent =
          await revalidateDetachedVerificationProof(tx, {
            batchId: batch.id,
            batchIncidentId: entry.id,
            incidentId: entry.incidentId,
            courseId: entry.courseId,
            cycle: entry.cycle,
            releaseSha: batch.releaseSha ?? "",
            leaseToken: input.leaseToken,
            ownerThreadId: input.ownerThreadId,
            proofSnapshot: proof,
            now,
          });
        if (!detachedProofIsCurrent) {
          throw new Error(
            "Detached provider verification changed before terminal closeout.",
          );
        }
      }
    }

    const shouldWakeParkedProviderSiblings = Boolean(
      reusableFamilyRestoredCount > 0 &&
      remediationDirective?.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      remediationDirective.requiresImplementationPath &&
      batch.releaseSha &&
      batch.releaseSha !== batch.baseSha &&
      batch.deployedAt,
    );
    const parkedProviderSiblings = shouldWakeParkedProviderSiblings
      ? await tx.courseSupportIncident.findMany({
          where: {
            providerFamilyKey: batch.providerFamilyKey,
            status: "NEEDS_HUMAN",
            humanReviewReason: "AUTOMATION_STALLED",
            activeBatchId: null,
            nextAttemptAt: null,
            resolvedAt: null,
            resolution: null,
            decisionAt: null,
          },
          select: {
            id: true,
            courseId: true,
            cycle: true,
            revision: true,
            updatedAt: true,
            providerFamilyKey: true,
            failureFingerprint: true,
            activeRealSearchCount: true,
            course: {
              select: {
                timeZone: true,
                detectedPlatform: true,
                providerFamilyKey: true,
                detectedBookingUrl: true,
                website: true,
                bookingMetadata: true,
                monitoringStatus: {
                  select: {
                    state: true,
                    revision: true,
                    stateChangedAt: true,
                    lastSuccessfulAt: true,
                    nextAutomaticAttemptAt: true,
                    revalidationRequestedAt: true,
                  },
                },
              },
            },
          },
        })
      : [];
    const relevantParkedProviderSiblings = parkedProviderSiblings.filter(
      (sibling) => {
        const provider = resolveProviderCapability(sibling.course);
        return (
          sibling.providerFamilyKey === batch.providerFamilyKey &&
          provider.providerFamilyKey === batch.providerFamilyKey &&
          provider.isRunnable &&
          sibling.course.monitoringStatus?.state ===
            "ENGINEERING_VERIFICATION_NEEDED" &&
          sibling.course.monitoringStatus.nextAutomaticAttemptAt == null &&
          sibling.course.monitoringStatus.revalidationRequestedAt == null
        );
      },
    );
    siblingWakeCount = relevantParkedProviderSiblings.length;

    input.signal?.throwIfAborted();
    const ownership = await tx.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now },
      },
      data: {
        status: batchStatus,
        completedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: now,
        summary: {
          ...asJsonObject(batch.summary),
          closeout: {
            outcome,
            derivedOutcome,
            failureDomain: input.failureDomain ?? "NONE",
            terminalCount,
            reusableFamilyRestoredCount,
            retryCount,
            needsHumanCount,
            automationStalledCount,
            operationalRetryBudgetExhaustedCount,
            orchestrationOnlyCount,
            providerFamilyHandoffCount,
            decisionBasis,
            verificationWatchMode,
            remediationAttemptConsumed,
            remediationAttempts: closeoutRemediationAttempts,
            siblingWakeCount,
            summary: safeSummary,
          },
        } as Prisma.InputJsonValue,
        revision: { increment: 1 },
      },
    });
    if (ownership.count !== 1) {
      throw new Error("Responder batch ownership changed during closeout.");
    }

    for (const entry of normalizedEntries) {
      const message = sanitizeResponderText(
        entry.message ?? "Course-support responder closeout recorded.",
      );
      const expectedIncidentUpdatedAt =
        ownershipReleaseMode ||
        entry.providerFamilyHandoff ||
        currentFailureIdentityByBatchIncidentId.get(entry.id)?.materialChange
          ? entry.incident.updatedAt
          : (entry.verifiedIncidentUpdatedAt ?? entry.incident.updatedAt);
      const closeoutEvidenceObservedAt =
        getCourseSupportIncidentEvidenceObservedAt({
          proofSnapshot: entry.proofSnapshot,
          incidentLastSeenAt: entry.incident.lastSeenAt,
          now,
        });
      let incidentUpdated: { count: number };
      const authoritativeMonitoringResolution = ownershipReleaseMode
        ? getAuthoritativeCourseMonitoringResolution(
            entry.course.monitoringStatus?.state,
          )
        : null;
      if (
        authoritativeMonitoringResolution &&
        entry.course.monitoringStatus &&
        !entry.providerFamilyHandoff
      ) {
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            nextAttemptAt: null,
            nextReminderAt: null,
            resolvedAt: now,
            resolution: authoritativeMonitoringResolution.resolution,
            resolutionMessage: message,
            nextAction: null,
            lastSeenAt: getCourseSupportIncidentEvidenceObservedAt({
              proofSnapshot: entry.proofSnapshot,
              incidentLastSeenAt: entry.incident.lastSeenAt,
              now,
              additionalProviderObservedAt:
                entry.course.monitoringStatus.state === "HEALTHY"
                  ? entry.course.monitoringStatus.lastSuccessfulAt
                  : null,
            }),
            revision: { increment: 1 },
          },
        });
        await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: entry.course.monitoringStatus.state,
          data: { revision: { increment: 0 } },
        });
      } else if (entry.normalizedResult === "RESTORED") {
        const restoredProof = asJsonObject(entry.proofSnapshot);
        const restoredProviderObservedAt = parseProofDate(
          restoredProof.observedAt,
        );
        if (
          !restoredProviderObservedAt ||
          restoredProof.observedAt !==
            restoredProviderObservedAt.toISOString() ||
          restoredProof.providerExecution !== true ||
          (restoredProof.outcome !== "MATCH_FOUND" &&
            restoredProof.outcome !== "NO_MATCH") ||
          restoredProviderObservedAt.getTime() <
            entry.incident.lastSeenAt.getTime() ||
          restoredProviderObservedAt.getTime() > now.getTime()
        ) {
          throw new CourseSupportCloseoutSnapshotChangedError();
        }
        const restoredRuntimeVersion =
          typeof restoredProof.runtimeVersion === "string" &&
          /^[a-f0-9]{40}$/iu.test(restoredProof.runtimeVersion)
            ? restoredProof.runtimeVersion
            : null;
        const exactReleaseRuntimeProof = isDurableTerminalProof(entry, batch);
        const restoredOutcome =
          restoredProof.outcome === "MATCH_FOUND" ||
          restoredProof.outcome === "NO_MATCH"
            ? restoredProof.outcome
            : "NO_MATCH";
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            nextAttemptAt: null,
            nextReminderAt: null,
            resolvedAt: now,
            resolution: "MONITORING_RESTORED",
            resolutionMessage: message,
            nextAction: null,
            lastSeenAt: restoredProviderObservedAt,
            revision: { increment: 1 },
          },
        });
        const monitoringUpdated = await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "HEALTHY",
          data: {
            state: "HEALTHY",
            lastSuccessfulAt: restoredProviderObservedAt,
            consecutiveFailures: 0,
            failureFingerprint: null,
            firstDegradedAt: null,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (monitoringUpdated) {
          const campaignProvenance = await readCourseSupportCampaignProvenance(
            tx,
            batch.summary,
            entry.courseId,
            entry.incidentId,
            entry.cycle,
            now,
          );
          input.signal?.throwIfAborted();
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "RECOVERED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState: "AUTO_INVESTIGATING",
              toState: "HEALTHY",
              outcome: restoredOutcome,
              message,
              // A fresh customer probe can authoritatively reconcile current
              // monitoring health even when it was produced by another live
              // runtime. Preserve that actual runtime without attributing it
              // to this batch's release unless all exact runtime/deploy/time
              // fences passed.
              runtimeVersion: restoredRuntimeVersion,
              deploymentSha: exactReleaseRuntimeProof
                ? batch.releaseSha
                : null,
              occurredAt: restoredProviderObservedAt,
              audit: {
                freshRuntimeProof: exactReleaseRuntimeProof,
                currentStateReconciliation:
                  restoredProof.authoritativeCurrentSuccess === true &&
                  !exactReleaseRuntimeProof,
                automatedFinal: true,
                customerDataIncluded: false,
                ...campaignProvenance,
                cycle: entry.cycle,
                confirmedAt: entry.incident.confirmedAt?.toISOString() ?? null,
              },
            },
          });
        }
      } else if (entry.normalizedResult === "FINAL_DISPOSITION") {
        const resolution = getFinalDispositionResolution(entry.proofSnapshot);
        const proof = asJsonObject(entry.proofSnapshot);
        const exactReleaseRuntimeProof = isDurableTerminalProof(entry, batch);
        const sourceUnverifiedFinal = proof.kind === "SOURCE_UNVERIFIED_FINAL";
        const finalMonitoringState =
          proof.kind === "EXACT_PLACE_REVIEW" ||
          proof.kind === "BROWSER_PRIVATE_IDENTITY" ||
          (proof.kind === "PLAYBOOK_FACTUAL_FINAL" &&
            proof.disposition === "IDENTITY_FINAL")
            ? ("FINAL_IDENTITY" as const)
            : sourceUnverifiedFinal ||
                (proof.kind === "FINAL_DISPOSITION" &&
                  proof.disposition !== "MANUAL_DIRECT")
              ? ("FINAL_TECHNICAL" as const)
              : ("FINAL_MANUAL" as const);
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            nextAttemptAt: null,
            nextReminderAt: null,
            resolvedAt: now,
            resolution,
            resolutionMessage: message,
            nextAction: null,
            lastSeenAt: closeoutEvidenceObservedAt,
            revision: { increment: 1 },
          },
        });
        const monitoringUpdated = await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: finalMonitoringState,
          data: {
            state: finalMonitoringState,
            consecutiveFailures: 0,
            failureFingerprint: null,
            firstDegradedAt: null,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (monitoringUpdated) {
          const campaignProvenance = await readCourseSupportCampaignProvenance(
            tx,
            batch.summary,
            entry.courseId,
            entry.incidentId,
            entry.cycle,
            now,
          );
          input.signal?.throwIfAborted();
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "STATE_CHANGED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState: "AUTO_INVESTIGATING",
              toState: finalMonitoringState,
              message,
              runtimeVersion: batch.releaseSha,
              deploymentSha: batch.releaseSha,
              occurredAt: now,
              audit: {
                freshRuntimeProof: exactReleaseRuntimeProof,
                automatedFinal: true,
                finalKind:
                  finalMonitoringState === "FINAL_IDENTITY"
                    ? "identity"
                    : sourceUnverifiedFinal
                      ? "source_unverified"
                      : finalMonitoringState === "FINAL_TECHNICAL"
                        ? "known_technical_limitation"
                        : "manual_direct",
                customerDataIncluded: false,
                ...campaignProvenance,
                cycle: entry.cycle,
                confirmedAt: entry.incident.confirmedAt?.toISOString() ?? null,
              },
            },
          });
        }
      } else if (entry.providerFamilyHandoff) {
        const handoff = entry.providerFamilyHandoff;
        const handoffEvidenceObservedAt =
          getCourseSupportIncidentEvidenceObservedAt({
            proofSnapshot: entry.proofSnapshot,
            incidentLastSeenAt: entry.incident.lastSeenAt,
            now,
            additionalProviderObservedAt:
              currentFailureIdentityByBatchIncidentId.get(entry.id)
                ?.monitoringFailureObservedAt ?? null,
          });
        const handoffDeadlineAnchor =
          handoff.nextAttemptAt.getTime() > now.getTime()
            ? handoff.nextAttemptAt
            : now;
        retryTimes.push(handoff.nextAttemptAt);
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            providerFamilyKey: handoff.fromProviderFamilyKey,
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            cycle: { increment: 1 },
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            providerFamilyKey: handoff.toProviderFamilyKey,
            failureClass: handoff.failureClass,
            failureFingerprint: handoff.failureFingerprint,
            lastAttemptAt: null,
            attemptCount: 0,
            occurrenceCount: 1,
            firstSeenAt: handoffEvidenceObservedAt,
            confirmedAt: handoffEvidenceObservedAt,
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              handoffDeadlineAnchor,
              entry.incident.activeRealSearchCount,
            ),
            humanReviewReason: null,
            nextReminderAt: null,
            nextAttemptAt: handoff.nextAttemptAt,
            nextAction:
              "Run a fresh ordered playbook for the newly observed provider or failure identity.",
            ownerNotifiedAt: null,
            escalatedAt: null,
            escalationNotifiedAt: null,
            latestMessage: message,
            lastSeenAt: handoffEvidenceObservedAt,
            revision: { increment: 1 },
          },
        });
        const monitoringUpdated = await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "AUTO_INVESTIGATING",
          allowMaterialHandoff: true,
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: handoff.failureFingerprint,
            nextAutomaticAttemptAt: handoff.nextAttemptAt,
            revalidationRequestedAt: handoff.nextAttemptAt,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (monitoringUpdated) {
          input.signal?.throwIfAborted();
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "REVALIDATION_REQUESTED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState:
                entry.course.monitoringStatus?.state ?? "AUTO_INVESTIGATING",
              toState: "AUTO_INVESTIGATING",
              failureFingerprint: handoff.failureFingerprint,
              message:
                "Current provider or failure evidence changed during responder ownership, so a fresh remediation cycle was queued.",
              runtimeVersion: batch.releaseSha ?? batch.baseSha,
              deploymentSha: batch.deployedAt ? batch.releaseSha : null,
              occurredAt: now,
              audit: {
                priorCycle: entry.cycle,
                cycle: entry.cycle + 1,
                providerFamilyHandoff: true,
                providerFamilyChanged: handoff.providerFamilyChanged,
                providerSnapshotChanged: handoff.providerSnapshotChanged,
                priorProviderFamilyKey: handoff.fromProviderFamilyKey,
                providerFamilyKey: handoff.toProviderFamilyKey,
                claimedProviderSnapshotFingerprint:
                  handoff.claimedProviderSnapshotFingerprint,
                observedProviderSnapshotFingerprint:
                  handoff.observedProviderSnapshotFingerprint,
                priorFailureFingerprint: handoff.priorFailureFingerprint,
                failureFingerprint: handoff.failureFingerprint,
                customerDataIncluded: false,
              },
            },
          });
        }
      } else if (entry.normalizedResult === "NEEDS_HUMAN") {
        const humanReviewReason = entry.automationStalled
          ? ("AUTOMATION_STALLED" as const)
          : inferHumanReviewReason({
              kind: entry.incident.kind,
              failureClass: entry.incident.failureClass,
              bookingAccessMode: entry.course.bookingAccessMode,
              automationReason: entry.course.automationReason,
            });
        const humanRetryAt = getHumanReviewRetryAt(
          now,
          entry.incident.activeRealSearchCount,
        );
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            status: "NEEDS_HUMAN",
            activeBatchId: null,
            nextAttemptAt: entry.automationStalled ? null : humanRetryAt,
            humanReviewReason,
            nextReminderAt: now,
            escalatedAt: entry.incident.escalatedAt ?? now,
            latestMessage: message,
            ...(entry.automationStalled
              ? {
                  nextAction:
                    "Wait for a material provider, failure, reader-capability, relevant implementation, or operator change before retrying.",
                }
              : {}),
            lastSeenAt: closeoutEvidenceObservedAt,
            revision: { increment: 1 },
          },
        });
        const monitoringUpdated = await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "ENGINEERING_VERIFICATION_NEEDED",
          data: {
            state: "ENGINEERING_VERIFICATION_NEEDED",
            nextAutomaticAttemptAt: entry.automationStalled
              ? null
              : humanRetryAt,
            revalidationRequestedAt: null,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (monitoringUpdated) {
          input.signal?.throwIfAborted();
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "HUMAN_REVIEW_REQUESTED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState: "AUTO_INVESTIGATING",
              toState: "ENGINEERING_VERIFICATION_NEEDED",
              failureFingerprint: entry.incident.failureFingerprint,
              message,
              occurredAt: now,
              audit: {
                humanReviewReason,
                cycle: entry.cycle,
                customerState: "NEEDS_HUMAN_REVIEW",
                automationStalled: entry.automationStalled,
                parkedUntilMaterialChange: entry.automationStalled,
                endpointStalled: entry.automationStalled,
                operationalRetryBudgetExhausted:
                  entry.operationalRetryBudgetExhausted,
                reason: entry.operationalRetryBudgetExhausted
                  ? "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
                  : null,
                escalationDeadlineAt:
                  entry.incident.escalationDeadlineAt?.toISOString() ?? null,
                playbookExhausted: isAutomationPlaybookExhausted(
                  entry.incident.attemptLedger,
                  entry.incident.cycle,
                ),
                activeDemand: entry.incident.activeRealSearchCount > 0,
                customerDataIncluded: false,
              },
            },
          });
        }
        if (!entry.automationStalled) {
          input.signal?.throwIfAborted();
          await tx.teeSearch.updateMany({
            where: {
              status: "ACTIVE",
              trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
              date: {
                gte: getCourseLocalDateStorageBoundary(
                  entry.course.timeZone,
                  now,
                ),
              },
              preferences: { some: { courseId: entry.courseId } },
            },
            data: {
              nextCheckAt: now,
              recheckRequestedAt: now,
            },
          });
        }
      } else {
        const freshExactRuntimeSourceCycle =
          "freshExactRuntimeSourceCycle" in entry &&
          entry.freshExactRuntimeSourceCycle === true;
        const playbookAssessment = assessAutomationPlaybook(
          entry.incident.attemptLedger,
          entry.incident.cycle,
        );
        const effectiveFailureClass =
          getEffectiveCourseSupportRetryFailureClass({
            incidentFailureClass: entry.incident.failureClass,
            proofSnapshot: entry.proofSnapshot,
          });
        const effectiveFailureFingerprint =
          getEffectiveCourseSupportRetryFailureFingerprint({
            providerFamilyKey: entry.incident.providerFamilyKey,
            incidentKind: entry.incident.kind,
            incidentFailureClass: entry.incident.failureClass,
            incidentFailureFingerprint: entry.incident.failureFingerprint,
            proofSnapshot: entry.proofSnapshot,
          });
        const closeoutRemediationAttempt = closeoutRemediationAttempts.find(
          (attempt) =>
            attempt.courseRef ===
            createCourseSupportRemediationCourseRef(entry.courseId),
        );
        const deferredFailureHandoff = parseDeferredFailureHandoffSignal(
          closeoutRemediationAttempt?.deferredFailureHandoff,
        );
        const failureOnlyHandoffCooldownActive = Boolean(
          currentFailureIdentityByBatchIncidentId.get(entry.id)
            ?.failureOnlyHandoffCooldown?.active,
        );
        // Keep the cycle opener's canonical identity stable while verifier
        // churn is cooling down. The immutable batch proof/summary retains the
        // observation and the effective identity still drives retry timing;
        // after expiry, the same observation can open one fresh episode.
        const preserveCanonicalDeferredFailureIdentity = Boolean(
          failureOnlyHandoffCooldownActive || deferredFailureHandoff,
        );
        const persistedFailureClass = preserveCanonicalDeferredFailureIdentity
          ? entry.incident.failureClass
          : effectiveFailureClass;
        const persistedFailureFingerprint =
          preserveCanonicalDeferredFailureIdentity
          ? entry.incident.failureFingerprint
          : effectiveFailureFingerprint;
        const continueIncompletePlaybook =
          playbookAssessment.conclusion === "INCOMPLETE" &&
          Boolean(playbookAssessment.nextStage) &&
          (failureOnlyHandoffCooldownActive ||
            shouldContinueSettledCourseSupportRemediation({
              remediationDirective,
              failureClass: effectiveFailureClass,
              attemptCount: entry.incident.attemptCount,
              playbookConclusion: playbookAssessment.conclusion,
              nextPlaybookStage: playbookAssessment.nextStage,
              nextPlaybookStageStatus:
                getCourseSupportNextStageStatus(playbookAssessment),
              nextPlaybookStageAttemptCount:
                getCourseSupportNextStageAttemptCount(playbookAssessment),
            }));
        const watchContinuationAt =
          (verificationWatchMode === "WATCH_SETTLED" ||
            verificationWatchMode === "ENDPOINT") &&
          continueIncompletePlaybook
            ? new Date(now.getTime() + 60 * 1000)
            : null;
        const currentCycleIsOrchestrationOnly = Boolean(
          closeoutRemediationAttempt?.countsTowardOperationalNoProgress ===
            false &&
          (playbookAssessment.completedStages.length === 0 ||
            isCourseSupportAssignedAdapterOrchestrationMiss({
              approach: closeoutRemediationAttempt?.approach,
              executionEvidence:
                closeoutRemediationAttempt?.executionEvidence,
            })) &&
          areCourseSupportCompletedAttemptsOrchestrationOnly({
            courseId: entry.courseId,
            cycle: entry.cycle,
            entries: entry.incident.batchIncidents ?? [],
            allowEmpty: true,
            allowValidatedLegacy: hasValidatedZeroExecutionRecoveryMarker(
              entry.cycle,
              entry.incident.monitoringEvents,
            ),
          }),
        );
        const deferredFailureHandoffDueAt =
          deferredFailureHandoff?.state === "AVAILABLE" &&
          !deferredFailureHandoff.confirmationStarted
            ? new Date(deferredFailureHandoff.eligibleAt)
            : null;
        const retryEscalationDeadline = freshExactRuntimeSourceCycle
          ? getCourseMonitoringEscalationDeadline(
              now,
              entry.incident.activeRealSearchCount,
            )
          : closeoutRemediationAttempt
            ? deferredFailureHandoffDueAt
              ? getDeferredFailureHandoffEscalationDeadline(
                  deferredFailureHandoffDueAt,
                  entry.incident.activeRealSearchCount,
                )
              : currentCycleIsOrchestrationOnly
                ? null
                : continueIncompletePlaybook
                  ? getCourseMonitoringEscalationDeadline(
                      now,
                      entry.incident.activeRealSearchCount,
                    )
                  : (entry.incident.escalationDeadlineAt ??
                    getCourseMonitoringEscalationDeadline(
                      now,
                      entry.incident.activeRealSearchCount,
                    ))
            : entry.incident.escalationDeadlineAt;
        const operationalRetryAt =
          deferredFailureHandoffDueAt
            ? null
            : closeoutRemediationAttempt && !closeoutRemediationAttempt.consumed
            ? closeoutRemediationAttempt.countsTowardOperationalNoProgress
              ? new Date(
                  now.getTime() + COURSE_SUPPORT_OPERATIONAL_RETRY_DELAY_MS,
                )
              : (orchestrationRetryByCourseRef.get(
                  closeoutRemediationAttempt.courseRef,
                )?.retryAt ?? null)
            : null;
        const normalNextAttemptAt = freshExactRuntimeSourceCycle
          ? now
          : (deferredFailureHandoffDueAt ??
            operationalRetryAt ??
            watchContinuationAt ??
            computeCourseSupportNextAttemptAt({
              failureClass: effectiveFailureClass,
              failureFingerprint: effectiveFailureFingerprint,
              attemptCount: Math.max(1, entry.incident.attemptCount),
              retryAfterSeconds: input.retryAfterSeconds,
              now,
            }));
        const detachedFailureNotBefore = getDetachedFailureRetryNotBefore({
          proofSnapshot: entry.proofSnapshot,
          releaseSha: batch.releaseSha,
          now,
        });
        const nextAttemptAt =
          !operationalRetryAt &&
          detachedFailureNotBefore &&
          detachedFailureNotBefore.getTime() > normalNextAttemptAt.getTime()
            ? detachedFailureNotBefore
            : normalNextAttemptAt;
        retryTimes.push(nextAttemptAt);
        input.signal?.throwIfAborted();
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            ...(freshExactRuntimeSourceCycle
              ? {
                  cycle: { increment: 1 },
                  lastAttemptAt: null,
                  attemptCount: 0,
                  occurrenceCount: 1,
                  firstSeenAt: now,
                  confirmedAt: now,
                  humanReviewReason: null,
                  nextReminderAt: null,
                  ownerNotifiedAt: null,
                  escalatedAt: null,
                  escalationNotifiedAt: null,
                  nextAction:
                    "Run every ordered source and reader stage on one exact deployed runtime.",
                }
              : {}),
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            failureClass: persistedFailureClass,
            failureFingerprint: persistedFailureFingerprint,
            escalationDeadlineAt: retryEscalationDeadline,
            nextAttemptAt,
            latestMessage: message,
            lastSeenAt: closeoutEvidenceObservedAt,
            revision: { increment: 1 },
          },
        });
        await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "AUTO_INVESTIGATING",
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: persistedFailureFingerprint,
            nextAutomaticAttemptAt: nextAttemptAt,
            ...(freshExactRuntimeSourceCycle
              ? { revalidationRequestedAt: now }
              : {}),
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (freshExactRuntimeSourceCycle) {
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "REVALIDATION_REQUESTED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState: "AUTO_INVESTIGATING",
              toState: "AUTO_INVESTIGATING",
              failureFingerprint: persistedFailureFingerprint,
              message:
                "The responder started one fresh cycle because source evidence crossed deployment runtimes.",
              runtimeVersion: batch.releaseSha ?? batch.baseSha,
              deploymentSha: batch.releaseSha,
              idempotencyKey: `course-support-exact-runtime-source-cycle:${entry.incidentId}:${entry.cycle}:${batch.releaseSha ?? batch.baseSha}`,
              occurredAt: now,
              audit: {
                action: "fresh_exact_runtime_source_cycle",
                priorCycle: entry.cycle,
                cycle: entry.cycle + 1,
                exactRuntimeRequired: true,
                oneShot: true,
                preservesAttemptLedger: true,
                customerDataIncluded: false,
              },
            },
          });
        }
      }
      if (incidentUpdated.count !== 1) {
        throw new CourseSupportCloseoutSnapshotChangedError();
      }
      if (entry.result !== entry.normalizedResult) {
        const authoritativeSuccessProbe =
          authoritativeSuccessProbeByBatchIncidentId.get(entry.id);
        const normalizedProof = asJsonObject(entry.proofSnapshot);
        const sourceUnverifiedFinalProof =
          entry.normalizedResult === "FINAL_DISPOSITION" &&
          normalizedProof.kind === "SOURCE_UNVERIFIED_FINAL";
        const replacesCapturedProof = Boolean(
          authoritativeSuccessProbe || sourceUnverifiedFinalProof,
        );
        const capturedEntry = batch.incidents.find(
          (candidate) => candidate.id === entry.id,
        );
        if (!capturedEntry) {
          throw new CourseSupportCloseoutSnapshotChangedError();
        }
        input.signal?.throwIfAborted();
        const batchEntryUpdated =
          await tx.courseSupportBatchIncident.updateMany({
            where: {
              id: entry.id,
              result: entry.result,
              updatedAt: entry.updatedAt,
              ...(replacesCapturedProof
                ? {
                    proofSnapshot: {
                      equals:
                        capturedEntry.proofSnapshot === null
                          ? Prisma.AnyNull
                          : (capturedEntry.proofSnapshot as Prisma.InputJsonValue),
                    },
                    verifiedAt: capturedEntry.verifiedAt,
                    postProbeId: capturedEntry.postProbeId,
                    ...(sourceUnverifiedFinalProof
                      ? {
                          verifiedIncidentUpdatedAt:
                            capturedEntry.verifiedIncidentUpdatedAt,
                        }
                      : {}),
                  }
                : {}),
            },
            data: {
              result: entry.normalizedResult,
              updatedAt: now,
              ...(authoritativeSuccessProbe
                ? {
                    postProbeId: authoritativeSuccessProbe.id,
                    verifiedAt: authoritativeSuccessProbe.observedAt,
                    verifiedIncidentUpdatedAt: entry.incident.updatedAt,
                    proofSnapshot:
                      buildAuthoritativeCourseSupportSuccessProbeProof(
                        authoritativeSuccessProbe,
                      ),
                  }
                : sourceUnverifiedFinalProof
                  ? {
                      proofSnapshot:
                        entry.proofSnapshot as Prisma.InputJsonValue,
                    }
                : {}),
            },
          });
        if (batchEntryUpdated.count !== 1) {
          throw new Error("Responder batch evidence changed during closeout.");
        }
      }
    }

    if (relevantParkedProviderSiblings.length > 0) {
      const updateSiblingIncidentGroup = async (
        siblings: typeof relevantParkedProviderSiblings,
        hasActiveRealDemand: boolean,
      ) => {
        if (siblings.length === 0) {
          return;
        }
        input.signal?.throwIfAborted();
        const siblingIncidentsUpdated =
          await tx.courseSupportIncident.updateMany({
            where: {
              id: { in: siblings.map((sibling) => sibling.id) },
              providerFamilyKey: batch.providerFamilyKey,
              status: "NEEDS_HUMAN",
              humanReviewReason: "AUTOMATION_STALLED",
              activeBatchId: null,
              nextAttemptAt: null,
              resolvedAt: null,
              resolution: null,
              decisionAt: null,
              OR: siblings.map((sibling) => ({
                id: sibling.id,
                courseId: sibling.courseId,
                cycle: sibling.cycle,
                revision: sibling.revision,
                updatedAt: sibling.updatedAt,
              })),
            },
            data: {
              cycle: { increment: 1 },
              status: "AUTO_INVESTIGATING",
              lastAttemptAt: null,
              attemptCount: 0,
              occurrenceCount: 1,
              firstSeenAt: now,
              escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                now,
                hasActiveRealDemand ? 1 : 0,
              ),
              humanReviewReason: null,
              nextReminderAt: null,
              nextAttemptAt: now,
              nextAction:
                "Run a fresh ordered playbook because reusable support for this provider family was deployed.",
              ownerNotifiedAt: null,
              escalatedAt: null,
              escalationNotifiedAt: null,
              revision: { increment: 1 },
            },
          });
        if (siblingIncidentsUpdated.count !== siblings.length) {
          throw new Error(
            "Course-support sibling propagation write conflict while reopening parked incidents.",
          );
        }
      };
      await updateSiblingIncidentGroup(
        relevantParkedProviderSiblings.filter(
          (sibling) => sibling.activeRealSearchCount > 0,
        ),
        true,
      );
      await updateSiblingIncidentGroup(
        relevantParkedProviderSiblings.filter(
          (sibling) => sibling.activeRealSearchCount <= 0,
        ),
        false,
      );

      input.signal?.throwIfAborted();
      const siblingMonitoringUpdated =
        await tx.courseMonitoringStatus.updateMany({
          where: {
            courseId: {
              in: relevantParkedProviderSiblings.map(
                (sibling) => sibling.courseId,
              ),
            },
            state: "ENGINEERING_VERIFICATION_NEEDED",
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            OR: relevantParkedProviderSiblings.map((sibling) => {
              const monitoringStatus = sibling.course.monitoringStatus!;
              return {
                courseId: sibling.courseId,
                revision: monitoringStatus.revision,
                stateChangedAt: monitoringStatus.stateChangedAt,
                lastSuccessfulAt: monitoringStatus.lastSuccessfulAt,
              };
            }),
          },
          data: {
            state: "AUTO_INVESTIGATING",
            nextAutomaticAttemptAt: now,
            revalidationRequestedAt: now,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
      if (
        siblingMonitoringUpdated.count !== relevantParkedProviderSiblings.length
      ) {
        throw new Error(
          "Course-support sibling propagation write conflict while reopening monitoring.",
        );
      }

      const courseIdsByStorageBoundary = new Map<number, string[]>();
      for (const sibling of relevantParkedProviderSiblings) {
        const boundary = getCourseLocalDateStorageBoundary(
          sibling.course.timeZone,
          now,
        );
        const courseIds =
          courseIdsByStorageBoundary.get(boundary.getTime()) ?? [];
        courseIds.push(sibling.courseId);
        courseIdsByStorageBoundary.set(boundary.getTime(), courseIds);
      }
      input.signal?.throwIfAborted();
      await tx.teeSearch.updateMany({
        where: {
          status: "ACTIVE",
          trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
          OR: [...courseIdsByStorageBoundary.entries()].map(
            ([boundaryTimestamp, courseIds]) => ({
              date: { gte: new Date(boundaryTimestamp) },
              preferences: { some: { courseId: { in: courseIds } } },
            }),
          ),
        },
        data: {
          nextCheckAt: now,
          recheckRequestedAt: now,
        },
      });

      input.signal?.throwIfAborted();
      const siblingEventsCreated = await tx.courseMonitoringEvent.createMany({
        data: relevantParkedProviderSiblings.map((sibling) => ({
          courseId: sibling.courseId,
          incidentId: sibling.id,
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          failureFingerprint: sibling.failureFingerprint,
          message:
            "Reusable support for this provider family was deployed, so a fresh monitoring cycle was queued.",
          runtimeVersion: batch.releaseSha,
          deploymentSha: batch.releaseSha,
          occurredAt: now,
          audit: {
            priorCycle: sibling.cycle,
            cycle: sibling.cycle + 1,
            providerFamilySupportDeployed: true,
            customerDataIncluded: false,
          } satisfies Prisma.InputJsonObject,
        })),
      });
      if (
        siblingEventsCreated.count !== relevantParkedProviderSiblings.length
      ) {
        throw new Error(
          "Course-support sibling propagation write conflict while recording audit events.",
        );
      }
    }

    const deferredFailureHandoffRequestIds = detachedRequestStatesAtCloseout
      .filter((request) =>
        deferredFailureHandoffByBatchIncidentId.has(request.batchIncidentId),
      )
      .map((request) => request.id);
    input.signal?.throwIfAborted();
    await tx.courseSupportVerificationRequest.updateMany({
      where: {
        batchIncident: { batchId: batch.id },
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
        ...(deferredFailureHandoffRequestIds.length > 0
          ? { id: { notIn: deferredFailureHandoffRequestIds } }
          : {}),
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "batch_closed",
        updatedAt: now,
      },
    });

    if (batch.ownerAutomationRunId) {
      input.signal?.throwIfAborted();
      await tx.automationRun.updateMany({
        where: { id: batch.ownerAutomationRunId, completedAt: null },
        data: {
          kind: "COURSE_SUPPORT",
          status: orchestrationOnlyCount > 0 ? "FAILED" : "COMPLETED",
          completedAt: now,
          outcome,
          notes: JSON.stringify({
            schemaVersion: 1,
            lifecycle: "closeout",
            claim: {
              branch:
                typeof asJsonObject(batch.summary).branch === "string"
                  ? asJsonObject(batch.summary).branch
                  : null,
              baseSha: batch.baseSha,
              plannedPathCount: readBatchPlannedPaths(batch.summary).length,
            },
            status: batchStatus,
            outcome,
            derivedOutcome,
            terminalCount,
            reusableFamilyRestoredCount,
            retryCount,
            automationStalledCount,
            operationalRetryBudgetExhaustedCount,
            orchestrationOnlyCount,
            providerFamilyHandoffCount,
            decisionBasis,
            verificationWatchMode,
            failureDomain: input.failureDomain ?? "NONE",
            remediationAttemptConsumed,
            siblingWakeCount,
          }),
        },
      });
    }
    input.signal?.throwIfAborted();
  });

  const finalOutcome = outcome;
  const finalBatchStatus = batchStatus;

  const nextAttemptAt = retryTimes.sort(
    (left, right) => left.getTime() - right.getTime(),
  )[0];
  const policy = getResponderThreadPolicy({
    outcome: finalOutcome,
    failureDomain: input.failureDomain,
    nextAttemptAt,
    requiresHuman: hasHuman,
    durableCloseoutRecorded: true,
  });
  return {
    outcome: finalOutcome,
    derivedOutcome,
    batchStatus: finalBatchStatus,
    durableCloseoutRecorded: true,
    terminalCount,
    reusableFamilyRestoredCount,
    retryCount,
    needsHumanCount,
    automationStalledCount,
    operationalRetryBudgetExhaustedCount,
    providerFamilyHandoffCount,
    decisionBasis,
    siblingWakeCount,
    notificationPendingCount: 0,
    leverage: {
      providerGroupResolvedCount:
        retryCount === 0 &&
        needsHumanCount === 0 &&
        exactReleaseTerminalEntryIds.size === normalizedEntries.length
          ? 1
          : 0,
      claimedCourseCount: normalizedEntries.length,
      monitoringRestoredCourseCount: restoredCount,
      courseSpecificFinalCount: normalizedEntries.filter(
        (entry) =>
          entry.normalizedResult === "FINAL_DISPOSITION" &&
          getFinalDispositionResolution(entry.proofSnapshot) !==
            "SOURCE_UNVERIFIED",
      ).length,
      sourceUnverifiedFinalCount: normalizedEntries.filter(
        (entry) =>
          entry.normalizedResult === "FINAL_DISPOSITION" &&
          getFinalDispositionResolution(entry.proofSnapshot) ===
            "SOURCE_UNVERIFIED",
      ).length,
      futureSiblingApplicability:
        reusableFamilyRestoredCount > 0 &&
        ![
          SOURCE_MISSING_PROVIDER_FAMILY,
          SOURCE_CONFLICT_PROVIDER_FAMILY,
        ].includes(batch.providerFamilyKey as never),
    },
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    ...policy,
  };
}

export async function closeoutCourseSupportBatch(
  input: CloseoutCourseSupportBatchInput,
) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.signal?.throwIfAborted();
    try {
      return await closeoutCourseSupportBatchAttempt(input);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (
        attempt === maxAttempts ||
        (!(error instanceof CourseSupportCloseoutSnapshotChangedError) &&
          !isCourseSupportSearchExecutionFenceRetryError(error))
      ) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, COURSE_SUPPORT_WRITE_CONFLICT_BACKOFF_MS * attempt),
      );
      input.signal?.throwIfAborted();
    }
  }
  throw new Error("Course-support closeout retry exhausted unexpectedly.");
}

function getFinalDispositionResolution(proofSnapshot: unknown) {
  const proof = asJsonObject(proofSnapshot as Prisma.JsonValue | null);
  if (proof.kind === "SOURCE_UNVERIFIED_FINAL") {
    return "SOURCE_UNVERIFIED" as const;
  }
  if (
    proof.kind === "EXACT_PLACE_REVIEW" ||
    proof.kind === "BROWSER_PRIVATE_IDENTITY" ||
    (proof.kind === "PLAYBOOK_FACTUAL_FINAL" &&
      proof.disposition === "IDENTITY_FINAL")
  ) {
    return "IDENTITY_CLASSIFIED" as const;
  }
  if (
    proof.kind === "FINAL_DISPOSITION" &&
    proof.disposition !== "MANUAL_DIRECT"
  ) {
    return "TECHNICAL_LIMITATION_CLASSIFIED" as const;
  }
  return "DIRECT_BOOKING_CLASSIFIED" as const;
}

function readDurablyClosedCourseSupportRecovery(input: {
  batch: {
    status: CourseSupportBatchStatus;
    completedAt: Date | null;
    ownerAutomationRunId: string | null;
    ownerAutomationRun: {
      id: string;
      kind: string;
      status: string;
      completedAt: Date | null;
      outcome: string | null;
    } | null;
    summary: unknown;
    incidents: Array<{
      result: CourseSupportBatchIncidentResult;
      incident: {
        status: string;
        resolution: CourseSupportResolution | null;
        activeBatchId: string | null;
        nextAttemptAt: Date | null;
      };
    }>;
  };
  now: Date;
}) {
  const { batch, now } = input;
  if (
    ACTIVE_BATCH_STATUSES.includes(batch.status) ||
    !batch.completedAt ||
    batch.incidents.length === 0
  ) {
    return null;
  }

  const closeout = asJsonObject(asJsonObject(batch.summary).closeout);
  const derivedOutcome =
    typeof closeout.derivedOutcome === "string" &&
    DERIVED_CLOSEOUT_OUTCOMES.has(closeout.derivedOutcome as ResponderOutcome)
      ? (closeout.derivedOutcome as ResponderOutcome)
      : null;
  const reportedOutcome =
    typeof closeout.outcome === "string" &&
    (DERIVED_CLOSEOUT_OUTCOMES.has(closeout.outcome as ResponderOutcome) ||
      FAILURE_CLOSEOUT_OUTCOMES.has(closeout.outcome as ResponderOutcome))
      ? (closeout.outcome as ResponderOutcome)
      : null;
  if (
    !derivedOutcome ||
    !reportedOutcome ||
    (reportedOutcome !== derivedOutcome &&
      !FAILURE_CLOSEOUT_OUTCOMES.has(reportedOutcome))
  ) {
    return null;
  }

  const expectedBatchStatus: CourseSupportBatchStatus =
    derivedOutcome === "needs_human" || derivedOutcome === "partial"
      ? "PARTIAL"
      : derivedOutcome === "retryable_failed"
        ? "RETRYABLE_FAILED"
        : "SUCCEEDED";
  const terminalCount = batch.incidents.filter(
    (entry) =>
      entry.result === "RESTORED" || entry.result === "FINAL_DISPOSITION",
  ).length;
  const retryCount = batch.incidents.filter(
    (entry) => entry.result === "RETRY_SCHEDULED",
  ).length;
  const needsHumanCount = batch.incidents.filter(
    (entry) => entry.result === "NEEDS_HUMAN",
  ).length;
  const entriesAreCoherent = batch.incidents.every((entry) => {
    if (entry.incident.activeBatchId !== null) {
      return false;
    }
    if (entry.result === "RESTORED") {
      return (
        entry.incident.status === "RESOLVED" &&
        entry.incident.resolution === "MONITORING_RESTORED" &&
        entry.incident.nextAttemptAt === null
      );
    }
    if (entry.result === "FINAL_DISPOSITION") {
      return (
        entry.incident.status === "RESOLVED" &&
        entry.incident.resolution !== null &&
        entry.incident.resolution !== "MONITORING_RESTORED" &&
        entry.incident.nextAttemptAt === null
      );
    }
    if (entry.result === "RETRY_SCHEDULED") {
      return (
        entry.incident.status === "AUTO_INVESTIGATING" &&
        entry.incident.resolution === null &&
        entry.incident.nextAttemptAt !== null &&
        entry.incident.nextAttemptAt.getTime() > now.getTime()
      );
    }
    if (entry.result === "NEEDS_HUMAN") {
      return (
        entry.incident.status === "NEEDS_HUMAN" &&
        entry.incident.resolution === null &&
        (entry.incident.nextAttemptAt === null ||
          entry.incident.nextAttemptAt.getTime() > now.getTime())
      );
    }
    return false;
  });
  const ownerRunIsCoherent = batch.ownerAutomationRunId
    ? Boolean(
        batch.ownerAutomationRun &&
          batch.ownerAutomationRun.id === batch.ownerAutomationRunId &&
          batch.ownerAutomationRun.kind === "COURSE_SUPPORT" &&
          ["COMPLETED", "FAILED"].includes(
            batch.ownerAutomationRun.status,
          ) &&
          batch.ownerAutomationRun.completedAt?.getTime() ===
            batch.completedAt.getTime() &&
          batch.ownerAutomationRun.outcome === reportedOutcome,
      )
    : batch.ownerAutomationRun === null;
  const countsAreCoherent = Boolean(
    Number.isInteger(closeout.terminalCount) &&
      closeout.terminalCount === terminalCount &&
      Number.isInteger(closeout.retryCount) &&
      closeout.retryCount === retryCount &&
      Number.isInteger(closeout.needsHumanCount) &&
      closeout.needsHumanCount === needsHumanCount &&
      terminalCount + retryCount + needsHumanCount === batch.incidents.length,
  );
  if (
    batch.status !== expectedBatchStatus ||
    !entriesAreCoherent ||
    !ownerRunIsCoherent ||
    !countsAreCoherent
  ) {
    return null;
  }

  const nextAttemptAt = batch.incidents
    .flatMap((entry) =>
      entry.result === "RETRY_SCHEDULED" && entry.incident.nextAttemptAt
        ? [entry.incident.nextAttemptAt]
        : [],
    )
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  return {
    outcome: reportedOutcome,
    derivedOutcome,
    nextAttemptAt,
    requiresHuman: needsHumanCount > 0,
  };
}

export async function recoverCourseSupportBatch(input: {
  batchId: string;
  requestingThreadId: string;
  currentBranch: string;
  currentHeadSha: string;
  dirtyPaths: string[];
  releaseIsPublished: boolean;
  baseIsAncestor?: boolean;
  committedPaths?: string[];
  releaseIsAncestor?: boolean;
  releaseCommittedPaths?: string[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const lease = await runWithCourseSupportWriterTransitionLease(async () => {
    const batch = await prisma.courseSupportBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        status: true,
        completedAt: true,
        leaseExpiresAt: true,
        ownerThreadId: true,
        ownerAutomationRunId: true,
        ownerAutomationRun: {
          select: {
            id: true,
            kind: true,
            status: true,
            completedAt: true,
            outcome: true,
          },
        },
        providerFamilyKey: true,
        failureFingerprint: true,
        baseSha: true,
        createdAt: true,
        releaseSha: true,
        deployedAt: true,
        recheckDispatchKey: true,
        recheckDispatchStartedAt: true,
        recheckDispatchedAt: true,
        revision: true,
        summary: true,
        incidents: {
          select: {
            id: true,
            incidentId: true,
            courseId: true,
            cycle: true,
            result: true,
            proofSnapshot: true,
            updatedAt: true,
            verificationRequests: {
              select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
            },
            course: {
              select: DETACHED_VERIFICATION_COURSE_SELECT,
            },
            incident: {
              select: {
                status: true,
                resolution: true,
                decisionAt: true,
                cycle: true,
                failureClass: true,
                attemptLedger: true,
                activeBatchId: true,
                lastSeenAt: true,
                failureFingerprint: true,
                activeRealSearchCount: true,
                escalationDeadlineAt: true,
                nextAttemptAt: true,
                updatedAt: true,
                monitoringEvents: {
                  where: { eventType: "REVALIDATION_REQUESTED" },
                  orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
                  take: 20,
                  select: { audit: true },
                },
                batchIncidents: {
                  where: { batch: { completedAt: { not: null } } },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: {
                    id: true,
                    cycle: true,
                    verificationRequests: {
                      select: {
                        releaseSha: true,
                        status: true,
                        revision: true,
                        attemptCount: true,
                        startedAt: true,
                      },
                    },
                    batch: { select: { summary: true, releaseSha: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!batch) {
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: ["The requested responder batch is not recoverable."],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery needs owner attention.",
      };
    }
    if (!ACTIVE_BATCH_STATUSES.includes(batch.status)) {
      const closedRecovery = readDurablyClosedCourseSupportRecovery({
        batch,
        now,
      });
      if (closedRecovery) {
        return {
          outcome: closedRecovery.outcome,
          derivedOutcome: closedRecovery.derivedOutcome,
          recovered: false,
          alreadyClosed: true,
          superseded: true,
          durableCloseoutRecorded: true,
          nextAttemptAt: closedRecovery.nextAttemptAt?.toISOString() ?? null,
          reasons: [
            "The expired responder batch reached a coherent durable closeout before recovery began.",
          ],
          ...getResponderThreadPolicy({
            outcome: closedRecovery.outcome,
            nextAttemptAt: closedRecovery.nextAttemptAt,
            requiresHuman: closedRecovery.requiresHuman,
            durableCloseoutRecorded: true,
            now,
          }),
        };
      }
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: [
          "The requested responder batch has no coherent durable closeout.",
        ],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery needs owner attention.",
      };
    }
    if (batch.leaseExpiresAt.getTime() > now.getTime()) {
      return {
        outcome: "deferred_busy" as const,
        recovered: false,
        reasons: [
          "The expired-batch handoff was superseded by renewed responder ownership.",
        ],
        threadDisposition: "ARCHIVE" as const,
        archiveReason: "Another responder owns the renewed batch lease.",
      };
    }
    const terminalIncidents = batch.incidents.filter((entry) =>
      ["NEEDS_HUMAN", "RESOLVED"].includes(entry.incident.status),
    );
    if (
      terminalIncidents.length === batch.incidents.length &&
      batch.incidents.length > 0
    ) {
      const hasHuman = terminalIncidents.some(
        (entry) => entry.incident.status === "NEEDS_HUMAN",
      );
      const restoredCount = terminalIncidents.filter(
        (entry) =>
          entry.incident.status === "RESOLVED" &&
          entry.incident.resolution === "MONITORING_RESTORED",
      ).length;
      const finalCount = terminalIncidents.filter(
        (entry) =>
          entry.incident.status === "RESOLVED" &&
          entry.incident.resolution !== "MONITORING_RESTORED",
      ).length;
      const derivedOutcome = hasHuman
        ? ("needs_human" as const)
        : restoredCount === terminalIncidents.length
          ? ("success" as const)
          : finalCount === terminalIncidents.length
            ? ("classification_only" as const)
            : ("partial" as const);
      const batchStatus: CourseSupportBatchStatus = hasHuman
        ? "PARTIAL"
        : "SUCCEEDED";
      const message =
        "Expired responder ownership was superseded by a later durable course decision.";
      const summary = asJsonObject(batch.summary);
      await prisma.$transaction(
        async (tx) => {
          const currentIncidents = await tx.courseSupportIncident.findMany({
            where: {
              id: { in: terminalIncidents.map((entry) => entry.incidentId) },
              status: { in: ["NEEDS_HUMAN", "RESOLVED"] },
            },
            select: {
              id: true,
              status: true,
              resolution: true,
              decisionAt: true,
              cycle: true,
              activeBatchId: true,
              updatedAt: true,
            },
          });
          const currentById = new Map(
            currentIncidents.map((incident) => [incident.id, incident]),
          );
          const terminalEvidenceStillMatches = terminalIncidents.every(
            (entry) => {
              const current = currentById.get(entry.incidentId);
              return (
                current &&
                current.status === entry.incident.status &&
                current.resolution === entry.incident.resolution &&
                current.decisionAt?.getTime() ===
                  entry.incident.decisionAt?.getTime() &&
                current.cycle === entry.cycle &&
                current.activeBatchId === batch.id &&
                current.updatedAt.getTime() ===
                  entry.incident.updatedAt.getTime()
              );
            },
          );
          if (!terminalEvidenceStillMatches) {
            throw new Error(
              "The superseding course decision changed during responder recovery.",
            );
          }

          const batchUpdated = await tx.courseSupportBatch.updateMany({
            where: {
              id: batch.id,
              status: batch.status,
              revision: batch.revision,
              leaseExpiresAt: { lte: now },
              releaseSha: batch.releaseSha,
              deployedAt: batch.deployedAt,
              recheckDispatchKey: batch.recheckDispatchKey,
              recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
              recheckDispatchedAt: batch.recheckDispatchedAt,
              completedAt: null,
            },
            data: {
              status: batchStatus,
              completedAt: now,
              heartbeatAt: now,
              leaseExpiresAt: now,
              summary: {
                ...summary,
                closeout: {
                  outcome: derivedOutcome,
                  derivedOutcome,
                  terminalCount: restoredCount + finalCount,
                  retryCount: 0,
                  needsHumanCount:
                    terminalIncidents.length - restoredCount - finalCount,
                  reason: "superseded_by_durable_course_decision",
                },
              } as Prisma.InputJsonValue,
              revision: { increment: 1 },
            },
          });
          if (batchUpdated.count !== 1) {
            throw new Error(
              "Expired responder ownership changed during terminal reconciliation.",
            );
          }

          for (const entry of terminalIncidents) {
            const result =
              entry.incident.status === "NEEDS_HUMAN"
                ? ("NEEDS_HUMAN" as const)
                : entry.incident.resolution === "MONITORING_RESTORED"
                  ? ("RESTORED" as const)
                  : ("FINAL_DISPOSITION" as const);
            const entryUpdated = await tx.courseSupportBatchIncident.updateMany(
              {
                where: {
                  id: entry.id,
                  result: entry.result,
                  updatedAt: entry.updatedAt,
                },
                data: { result, message },
              },
            );
            if (entryUpdated.count !== 1) {
              throw new Error(
                "Expired responder evidence changed during terminal reconciliation.",
              );
            }
            const incidentUpdated = await tx.courseSupportIncident.updateMany({
              where: {
                id: entry.incidentId,
                cycle: entry.cycle,
                activeBatchId: batch.id,
                status: entry.incident.status,
                resolution: entry.incident.resolution,
                decisionAt: entry.incident.decisionAt,
                updatedAt: entry.incident.updatedAt,
              },
              data: {
                activeBatchId: null,
                revision: { increment: 1 },
              },
            });
            if (incidentUpdated.count !== 1) {
              throw new Error(
                "Expired responder incident changed during terminal ownership release.",
              );
            }
          }

          await tx.courseSupportVerificationRequest.updateMany({
            where: {
              batchIncident: { batchId: batch.id },
              status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
            },
            data: {
              status: "STALE",
              revision: { increment: 1 },
              leaseToken: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              completedAt: now,
              lastError: "batch_superseded",
              updatedAt: now,
            },
          });

          if (batch.ownerAutomationRunId) {
            await tx.automationRun.updateMany({
              where: { id: batch.ownerAutomationRunId, completedAt: null },
              data: {
                kind: "COURSE_SUPPORT",
                status: "COMPLETED",
                completedAt: now,
                outcome: derivedOutcome,
                notes: JSON.stringify({
                  schemaVersion: 1,
                  lifecycle: "closeout",
                  status: batchStatus,
                  outcome: derivedOutcome,
                  derivedOutcome,
                  terminalCount: restoredCount + finalCount,
                  retryCount: 0,
                  needsHumanCount:
                    terminalIncidents.length - restoredCount - finalCount,
                  reason: "superseded_by_durable_course_decision",
                }),
              },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return {
        outcome: derivedOutcome,
        recovered: false,
        superseded: true,
        durableCloseoutRecorded: true,
        reasons: [message],
        ...getResponderThreadPolicy({
          outcome: derivedOutcome,
          durableCloseoutRecorded: true,
          now,
        }),
      };
    }
    const otherBatches = await prisma.courseSupportBatch.findMany({
      where: {
        id: { not: batch.id },
        status: { in: ACTIVE_BATCH_STATUSES },
        leaseExpiresAt: { gt: now },
      },
      select: {
        id: true,
        status: true,
        providerFamilyKey: true,
        failureFingerprint: true,
        summary: true,
      },
    });
    const recoveringWouldOwnCheckout =
      courseSupportBatchReservesCheckout(batch);
    const sharedCheckoutConflict =
      recoveringWouldOwnCheckout &&
      otherBatches.some((otherBatch) =>
        courseSupportBatchReservesCheckout(otherBatch),
      );
    const conflictingBatch = otherBatches.find((otherBatch) =>
      courseSupportRecoveryBatchesConflict(batch, otherBatch),
    );
    if (sharedCheckoutConflict || conflictingBatch) {
      return {
        outcome: "deferred_busy" as const,
        recovered: false,
        reasons: [
          sharedCheckoutConflict
            ? "The approved responder checkout must be exclusive while implementation work is active."
            : "Another course-support writer with overlapping provider or code scope must finish before this responder batch can be recovered.",
        ],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason:
          "Responder recovery is blocked by another course-support writer.",
      };
    }
    const summary = asJsonObject(batch.summary);
    const priorReleaseExecution = readCourseSupportReleaseExecutionEvidence({
      summary: batch.summary,
      baseSha: batch.baseSha,
    });
    const recovery = assessCourseSupportRecovery({
      leaseExpiresAt: batch.leaseExpiresAt,
      ownerThreadId: batch.ownerThreadId,
      requestingThreadId: input.requestingThreadId,
      baseSha: batch.baseSha,
      releaseSha: batch.releaseSha,
      expectedBranch:
        typeof summary.branch === "string" ? summary.branch : null,
      currentBranch: input.currentBranch,
      currentHeadSha: input.currentHeadSha,
      plannedPaths: Array.isArray(summary.plannedPaths)
        ? summary.plannedPaths.filter(
            (path): path is string => typeof path === "string",
          )
        : [],
      dirtyPaths: normalizeCourseSupportObservedGitPaths(input.dirtyPaths),
      baseIsAncestor: input.baseIsAncestor,
      committedPaths: normalizeCourseSupportObservedGitPaths(
        input.committedPaths ?? [],
      ),
      releaseIsAncestor: input.releaseIsAncestor,
      releaseCommittedPaths: normalizeCourseSupportObservedGitPaths(
        input.releaseCommittedPaths ?? [],
      ),
      now,
    });
    if (recovery.action === "BLOCK") {
      const normalizedDirtyPaths = normalizeCourseSupportObservedGitPaths(
        input.dirtyPaths,
      );
      if (
        canSafelyRequeueExpiredCourseSupportBatch({
          leaseExpiresAt: batch.leaseExpiresAt,
          baseSha: batch.baseSha,
          releaseSha: batch.releaseSha,
          releaseIsPublished: input.releaseIsPublished,
          deployedAt: batch.deployedAt,
          priorExecutionRecorded:
            priorReleaseExecution.changedReleaseDeploymentEver ||
            priorReleaseExecution.providerExecutionEverForCourse ||
            priorReleaseExecution.terminalExecutionEverForCourse,
          recheckDispatchKey: batch.recheckDispatchKey,
          recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
          recheckDispatchedAt: batch.recheckDispatchedAt,
          dirtyPaths: normalizedDirtyPaths,
          incidentResults: batch.incidents.map((entry) => entry.result),
          now,
        })
      ) {
        const retryIncidents = batch.incidents.filter(
          (entry) => entry.incident.status === "AUTO_INVESTIGATING",
        );
        if (
          retryIncidents.length === 0 ||
          retryIncidents.length + terminalIncidents.length !==
            batch.incidents.length
        ) {
          throw new Error(
            "Expired responder incidents no longer match a recoverable lifecycle state.",
          );
        }
        if (
          batch.incidents.some((entry) =>
            (entry.verificationRequests ?? []).some(
              isActiveDetachedVerificationRequest,
            ),
          )
        ) {
          return {
            outcome: "deferred_busy" as const,
            recovered: false,
            reasons: [
              "Detached provider verification is still active; allow the existing request lifecycle to reclaim or finish it before responder recovery.",
            ],
            threadDisposition: "ARCHIVE" as const,
            archiveReason:
              "Responder recovery is waiting for active provider verification.",
          };
        }
        const needsHumanCount = terminalIncidents.filter(
          (entry) => entry.incident.status === "NEEDS_HUMAN",
        ).length;
        const restoredCount = terminalIncidents.filter(
          (entry) =>
            entry.incident.status === "RESOLVED" &&
            entry.incident.resolution === "MONITORING_RESTORED",
        ).length;
        const finalCount = terminalIncidents.filter(
          (entry) =>
            entry.incident.status === "RESOLVED" &&
            entry.incident.resolution !== "MONITORING_RESTORED",
        ).length;
        const plannedRemediationAttempts = Array.isArray(
          asJsonObject(summary.remediation).attempts
        )
          ? (asJsonObject(summary.remediation).attempts as unknown[])
          : [];
        const claimedAttemptByRetryEntryId = new Map(
          retryIncidents.map((entry) => {
            const courseRef = createCourseSupportRemediationCourseRef(entry.courseId);
            const plannedAttempt = asJsonObject(
              plannedRemediationAttempts.find(
                (candidate) => asJsonObject(candidate).courseRef === courseRef
              )
            );
            const actionPlanWasPersisted = Object.prototype.hasOwnProperty.call(
              plannedAttempt,
              "actionPlan"
            );
            const claimedAttempt = actionPlanWasPersisted
              ? readCourseSupportRemediationClaimAttempt({
                  summary: batch.summary,
                  courseId: entry.courseId,
                  expectedAttemptCount: batch.incidents.length
                })
              : null;
            if (actionPlanWasPersisted && !claimedAttempt?.actionPlan) {
              throw new Error(
                "The persisted course-support action plan is invalid or no longer matches the claimed remediation route."
              );
            }
            return [entry.id, claimedAttempt] as const;
          })
        );
        const strictImplementationProofRecorded =
          hasCourseSupportImplementationExecutionProofIncludingHistory({
            summary: batch.summary,
            baseSha: batch.baseSha,
            releaseSha: batch.releaseSha,
            deployedAt: batch.deployedAt
          });
        const implementationActionEntryIds = new Set(
          retryIncidents.flatMap((entry) =>
            claimedAttemptByRetryEntryId.get(entry.id)?.actionPlan?.primaryAction ===
            "IMPLEMENT_REUSABLE_SUPPORT"
              ? [entry.id]
              : []
          )
        );
        const authoritativeSuccessEntryIds = new Set<string>();
        for (const entry of retryIncidents) {
          const probes = await listAuthoritativeCourseSupportProbeEvidence(
            prisma,
            {
              courseId: entry.courseId,
              incidentLastSeenAt: entry.incident.lastSeenAt,
              now,
            },
          );
          const assessment = assessAuthoritativeCourseSupportSuccessProbe({
            probes,
            incidentLastSeenAt: entry.incident.lastSeenAt,
            now,
          });
          if (assessment.status === "INVALID") {
            throw new Error(
              "Fresh responder success evidence changed during expired ownership recovery.",
            );
          }
          if (assessment.status === "VALID") {
            authoritativeSuccessEntryIds.add(entry.id);
          }
        }
        const currentSourceActionPlanChangeEntryIds = new Set(
          retryIncidents.flatMap((entry) =>
            isExpiredImplementationSupersededByCurrentSource({
              claimedAttempt: claimedAttemptByRetryEntryId.get(entry.id),
              course: entry.course,
              failureClass: entry.incident.failureClass,
            })
              ? [entry.id]
              : [],
          ),
        );
        const materialProviderChangeEntryIds = new Set([
          ...retryIncidents.flatMap((entry) => {
            const claimedAttempt = claimedAttemptByRetryEntryId.get(entry.id);
            return claimedAttempt?.providerSnapshotFingerprint &&
              claimedAttempt.providerSnapshotFingerprint !==
                buildCourseSupportProviderSnapshotFingerprint(entry.course)
              ? [entry.id]
              : [];
          }),
          ...currentSourceActionPlanChangeEntryIds,
        ]);
        const supersededImplementationEntryIds = new Set([
          ...authoritativeSuccessEntryIds,
          ...materialProviderChangeEntryIds
        ]);
        const stoppedImplementationEntryIds = new Set(
          retryIncidents.flatMap((entry) =>
            implementationActionEntryIds.has(entry.id) &&
            !strictImplementationProofRecorded &&
            !supersededImplementationEntryIds.has(entry.id)
              ? [entry.id]
              : []
          )
        );
        const retryableIncidents = retryIncidents.filter(
          (entry) => !stoppedImplementationEntryIds.has(entry.id)
        );
        const stoppedImplementationCount = stoppedImplementationEntryIds.size;
        const terminalCount = restoredCount + finalCount;
        const totalNeedsHumanCount = needsHumanCount + stoppedImplementationCount;
        const hasHuman = totalNeedsHumanCount > 0;
        const derivedOutcome: ResponderOutcome = hasHuman
          ? "needs_human"
          : terminalCount > 0
            ? "partial"
            : "retryable_failed";
        const batchStatus: CourseSupportBatchStatus =
          hasHuman || terminalCount > 0 ? "PARTIAL" : "RETRYABLE_FAILED";
        const closeoutReason =
          stoppedImplementationCount > 0
            ? "expired_implementation_stopped_without_proof"
            : currentSourceActionPlanChangeEntryIds.size > 0
              ? "expired_action_plan_superseded_by_current_source"
            : terminalIncidents.length > 0
              ? "expired_mixed_reconciled_without_adoption"
              : "expired_retry_reconciled_without_adoption";
        const retryFloor = new Date(
          now.getTime() + EXPIRED_UNRELEASED_BATCH_RETRY_DELAY_MS,
        );
        const retryAtByBatchIncidentId = new Map(
          retryableIncidents.map((entry) => {
            const detachedFailureNotBefore =
              entry.result === "RETRY_SCHEDULED"
                ? getDetachedFailureRetryNotBefore({
                    proofSnapshot: entry.proofSnapshot,
                    releaseSha: batch.releaseSha,
                    now,
                  })
                : null;
            return [
              entry.id,
              detachedFailureNotBefore &&
              detachedFailureNotBefore.getTime() > retryFloor.getTime()
                ? detachedFailureNotBefore
                : retryFloor,
            ] as const;
          }),
        );
        let nextAttemptAt =
          retryAtByBatchIncidentId.size > 0
            ? [...retryAtByBatchIncidentId.values()].reduce(
                (earliest, candidate) =>
                  candidate.getTime() < earliest.getTime() ? candidate : earliest,
              )
            : null;
        const message =
          stoppedImplementationCount > 0
            ? "Expired responder implementation work lacked required runtime release and deployment proof, so it was parked for human review without another automatic retry."
            : currentSourceActionPlanChangeEntryIds.size > 0
              ? "The expired implementation assignment was superseded by the current durable source-discovery route and safely requeued."
            : terminalIncidents.length > 0
            ? "Expired responder terminal decisions were reconciled and unresolved work was safely requeued without adopting local changes."
            : "Expired responder retry evidence was safely requeued without adopting local changes.";
        const stoppedImplementationMessage =
          "The assigned reusable implementation was not proven by a runtime-bearing release and deployment before responder ownership expired.";
        const verificationLastError =
          stoppedImplementationCount > 0
            ? "implementation_proof_missing"
            : terminalIncidents.length > 0
            ? "batch_mixed_reconciled"
            : "batch_requeued";
        const terminalMessage =
          "Expired responder ownership was superseded by a later durable course decision.";
        const safeRequeueOrchestrationOnlyEntryIds = new Set(
          retryIncidents.flatMap((entry) => {
            if (stoppedImplementationEntryIds.has(entry.id)) {
              return [];
            }
            if (supersededImplementationEntryIds.has(entry.id)) {
              return [];
            }
            const historicalExecution =
              readCourseSupportReleaseExecutionEvidence({
                summary: batch.summary,
                baseSha: batch.baseSha,
                courseRef: createCourseSupportRemediationCourseRef(
                  entry.courseId,
                ),
              });
            if (
              !(entry.verificationRequests ?? []).every(
                canTreatDetachedVerificationRequestAsOrchestrationOnly,
              )
            ) {
              return [];
            }
            if (
              batch.deployedAt !== null ||
              historicalExecution.changedReleaseDeploymentEver ||
              historicalExecution.providerExecutionEverForCourse ||
              historicalExecution.providerExecutionAttemptEverForCourse ||
              historicalExecution.terminalExecutionEverForCourse ||
              asJsonObject(entry.proofSnapshot).providerExecution === true
            ) {
              return [];
            }
            if (
              assessAutomationPlaybook(
                entry.incident.attemptLedger,
                entry.cycle,
              ).completedStages.length > 0
            ) {
              return [];
            }
            return areCourseSupportCompletedAttemptsOrchestrationOnly({
              courseId: entry.courseId,
              cycle: entry.cycle,
              entries: entry.incident.batchIncidents ?? [],
              allowEmpty: true,
              allowValidatedLegacy: hasValidatedZeroExecutionRecoveryMarker(
                entry.cycle,
                entry.incident.monitoringEvents,
              ),
            })
              ? [entry.id]
              : [];
          }),
        );
        const safeRequeueRequestFenceEntryIds = new Set([
          ...safeRequeueOrchestrationOnlyEntryIds,
          ...stoppedImplementationEntryIds,
          ...supersededImplementationEntryIds
        ]);
        let safeRequeueSearchExecutionFence: {
          input: CourseSupportSearchExecutionFenceInput;
          expected: PersistedCourseSupportSearchExecutionFence;
        } | null = null;
        const persistedSafeRequeueSearchExecutionFence =
          readPersistedCourseSupportSearchExecutionFence(
            asJsonObject(batch.summary).searchExecutionFence,
          );
        if (
          safeRequeueOrchestrationOnlyEntryIds.size > 0 ||
          persistedSafeRequeueSearchExecutionFence
        ) {
          const fenceInput = createCourseSupportSearchExecutionFenceInput({
            batchId: batch.id,
            courseIds: retryIncidents.map((entry) => entry.courseId),
            summary: batch.summary,
            recheckDispatchKey: batch.recheckDispatchKey,
            recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
            recheckDispatchedAt: batch.recheckDispatchedAt,
            now,
          });
          const currentFence = await readCourseSupportSearchExecutionFence(
            prisma,
            fenceInput,
          );
          const persistedFence = persistedSafeRequeueSearchExecutionFence;
          if (!persistedFence) {
            const summaryHasSearchExecutionFence =
              Object.prototype.hasOwnProperty.call(
                asJsonObject(batch.summary),
                "searchExecutionFence",
              );
            const exactLegacyPreverificationShape = Boolean(
              !summaryHasSearchExecutionFence &&
                (batch.releaseSha === null ||
                  batch.releaseSha === batch.baseSha) &&
                batch.deployedAt === null &&
                batch.recheckDispatchKey === null &&
                batch.recheckDispatchStartedAt === null &&
                batch.recheckDispatchedAt === null &&
                terminalIncidents.length === 0 &&
                retryIncidents.length > 0 &&
                safeRequeueOrchestrationOnlyEntryIds.size ===
                  retryIncidents.length &&
                retryIncidents.every(
                  (entry) =>
                    entry.result === "PENDING" &&
                    entry.proofSnapshot === null &&
                    (entry.verificationRequests ?? []).length === 0,
                ),
            );
            const emptyLegacyFence =
              persistCourseSupportSearchExecutionFence(
                buildCourseSupportSearchExecutionFenceSnapshot({
                  courseIds: retryIncidents.map((entry) => entry.courseId),
                  expectedSearches: [],
                  recheckDispatchKey: null,
                  recheckDispatchStartedAt: null,
                  recheckDispatchedAt: null,
                  now,
                  dispatches: [],
                }),
                now,
              );
            if (
              !exactLegacyPreverificationShape ||
              !courseSupportSearchExecutionFenceMatches(
                emptyLegacyFence,
                currentFence,
              )
            ) {
              throw new Error(
                "Search execution changed during safe responder requeue.",
              );
            }
            const adoptedLegacyFence =
              await runCourseSupportSerializableTransactionWithRetry(
                async (tx) => {
                  await lockCourseSupportSearchExecutionFenceRows(
                    tx,
                    fenceInput,
                  );
                  const lockedFence =
                    await readCourseSupportSearchExecutionFence(tx, fenceInput);
                  if (
                    !courseSupportSearchExecutionFenceMatches(
                      emptyLegacyFence,
                      lockedFence,
                    )
                  ) {
                    throw new Error(
                      "Search execution changed during safe responder requeue.",
                    );
                  }
                  const lateVerificationRequest =
                    await tx.courseSupportVerificationRequest.findFirst({
                      where: { batchIncident: { batchId: batch.id } },
                      select: { id: true },
                    });
                  if (lateVerificationRequest) {
                    throw new Error(
                      "Detached verification execution changed during safe responder requeue.",
                    );
                  }
                  return tx.courseSupportBatch.updateMany({
                    where: {
                      id: batch.id,
                      status: batch.status,
                      revision: batch.revision,
                      leaseExpiresAt: { lte: now },
                      releaseSha: batch.releaseSha,
                      deployedAt: batch.deployedAt,
                      recheckDispatchKey: null,
                      recheckDispatchStartedAt: null,
                      recheckDispatchedAt: null,
                      completedAt: null,
                    },
                    data: {
                      summary: {
                        ...asJsonObject(batch.summary),
                        searchExecutionFence: emptyLegacyFence,
                      } as Prisma.InputJsonValue,
                      revision: { increment: 1 },
                    },
                  });
                },
              );
            if (adoptedLegacyFence.count !== 1) {
              throw new Error(
                "Expired responder ownership changed during fence adoption.",
              );
            }
            return {
              outcome: "recovery_required" as const,
              recovered: false,
              safelyRequeued: false,
              durableCloseoutRecorded: false,
              reasons: [
                "Legacy responder search execution was proven empty; run recovery again against the retained fence.",
              ],
              threadDisposition: "KEEP_VISIBLE" as const,
              archiveReason:
                "Responder recovery needs one exact fence pass before closeout.",
            };
          }
          const fenceMatches = Boolean(
            courseSupportSearchExecutionFenceMatches(
              persistedFence,
              currentFence,
            ),
          );
          const firstPostDispatchFence = Boolean(
            persistedFence.batchSearchCount === 0 &&
            persistedFence.memberships.length === 0,
          );
          const fenceCanAdvance = Boolean(
            currentFence.settled &&
            (firstPostDispatchFence ||
              canAdvanceCourseSupportSearchExecutionFence(
                persistedFence,
                currentFence,
              )),
          );
          const searchExecutionMayHaveStartedCourseRefs = new Set(
            getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
              persistedFence,
              currentFence,
            ),
          );
          const executionAttemptRequiresPersistence = retryIncidents.some(
            (entry) => {
              const courseRef = createCourseSupportRemediationCourseRef(
                entry.courseId,
              );
              return (
                searchExecutionMayHaveStartedCourseRefs.has(courseRef) &&
                !readCourseSupportReleaseExecutionEvidence({
                  summary: batch.summary,
                  baseSha: batch.baseSha,
                  courseRef,
                }).providerExecutionAttemptEverForCourse
              );
            },
          );
          if (!fenceMatches || executionAttemptRequiresPersistence) {
            if (!fenceMatches && !fenceCanAdvance) {
              throw new Error(
                "Search execution changed during safe responder requeue.",
              );
            }
            const adopted =
              await runCourseSupportSerializableTransactionWithRetry(
                async (tx) => {
                  await lockCourseSupportSearchExecutionFenceRows(
                    tx,
                    fenceInput,
                  );
                  const lockedFence =
                    await readCourseSupportSearchExecutionFence(tx, fenceInput);
                  const lockedMatches = Boolean(
                    courseSupportSearchExecutionFenceMatches(
                      persistedFence,
                      lockedFence,
                    ),
                  );
                  const lockedCanAdvance = Boolean(
                    lockedFence.settled &&
                    (firstPostDispatchFence ||
                      canAdvanceCourseSupportSearchExecutionFence(
                        persistedFence,
                        lockedFence,
                      )),
                  );
                  if (!lockedMatches && !lockedCanAdvance) {
                    throw new Error(
                      "Search execution changed during safe responder requeue.",
                    );
                  }
                  const lockedExecutionMayHaveStartedCourseRefs = new Set(
                    getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
                      persistedFence,
                      lockedFence,
                    ),
                  );
                  const executionEver = buildCourseSupportExecutionEverSummary({
                    summary: batch.summary,
                    baseSha: batch.baseSha,
                    previousReleaseSha: batch.releaseSha ?? batch.baseSha,
                    previousDeployedAt: batch.deployedAt,
                    previousIncidentVerifications: batch.incidents.map(
                      (entry, index) => {
                        const courseRef =
                          createCourseSupportRemediationCourseRef(
                            entry.courseId,
                          );
                        return {
                          ordinal: index + 1,
                          courseRef,
                          providerExecutionRecorded: false,
                          providerExecutionAttemptRecorded:
                            lockedExecutionMayHaveStartedCourseRefs.has(
                              courseRef,
                            ),
                          terminalExecutionRecorded: false,
                        };
                      },
                    ),
                  });
                  return tx.courseSupportBatch.updateMany({
                    where: {
                      id: batch.id,
                      status: batch.status,
                      revision: batch.revision,
                      leaseExpiresAt: { lte: now },
                      releaseSha: batch.releaseSha,
                      deployedAt: batch.deployedAt,
                      recheckDispatchKey: batch.recheckDispatchKey,
                      recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
                      recheckDispatchedAt: batch.recheckDispatchedAt,
                      completedAt: null,
                    },
                    data: {
                      summary: {
                        ...asJsonObject(batch.summary),
                        executionEver,
                        searchExecutionFence:
                          persistCourseSupportSearchExecutionFence(
                            {
                              ...lockedFence,
                              searchExecutionMayHaveStartedCourseRefs: [
                                ...lockedExecutionMayHaveStartedCourseRefs,
                              ].sort(),
                            },
                            now,
                          ),
                      } as Prisma.InputJsonValue,
                      revision: { increment: 1 },
                    },
                  });
                },
              );
            if (adopted.count !== 1) {
              throw new Error(
                "Expired responder ownership changed during fence adoption.",
              );
            }
            return {
              outcome: "recovery_required" as const,
              recovered: false,
              safelyRequeued: false,
              durableCloseoutRecorded: false,
              reasons: [
                "Fresh search execution evidence was retained; run recovery again against the adopted fence.",
              ],
              threadDisposition: "KEEP_VISIBLE" as const,
              archiveReason:
                "Responder recovery needs one settled fence pass before closeout.",
            };
          }
          safeRequeueSearchExecutionFence = {
            input: fenceInput,
            expected: persistedFence,
          };
        }
        const safeRequeueOrchestrationRetryByEntryId = new Map(
          retryIncidents.flatMap((entry) => {
            if (
              !safeRequeueOrchestrationOnlyEntryIds.has(entry.id) ||
              stoppedImplementationEntryIds.has(entry.id)
            ) {
              return [];
            }
            return [
              [
                entry.id,
                getCourseSupportOrchestrationRetrySchedule({
                  now,
                  priorAttemptCount:
                    countCourseSupportCompletedOrchestrationOnlyAttempts({
                      courseId: entry.courseId,
                      cycle: entry.cycle,
                      entries: entry.incident.batchIncidents ?? [],
                      allowValidatedLegacy:
                        hasValidatedZeroExecutionRecoveryMarker(
                          entry.cycle,
                          entry.incident.monitoringEvents,
                        ),
                    }),
                }),
              ] as const,
            ];
          }),
        );
        const safeRequeueRemediationAttempts = retryIncidents.flatMap(
          (entry) => {
            const courseRef = createCourseSupportRemediationCourseRef(
              entry.courseId,
            );
            const plannedAttempt = asJsonObject(
              plannedRemediationAttempts.find(
                (candidate) => asJsonObject(candidate).courseRef === courseRef,
              ),
            );
            const providerSnapshotFingerprint =
              plannedAttempt.providerSnapshotFingerprint;
            const approach = parseCourseSupportRemediationApproach(
              plannedAttempt.approach,
            );
            if (typeof providerSnapshotFingerprint !== "string" || !approach) {
              return [];
            }
            const claimedAttempt = claimedAttemptByRetryEntryId.get(entry.id);
            const actionExecution = claimedAttempt?.actionPlan
              ? buildCourseSupportActionExecution({
                  action: claimedAttempt.actionPlan.primaryAction,
                  strictImplementationProofRecorded,
                  authoritativeSuccessSuperseded:
                    authoritativeSuccessEntryIds.has(entry.id),
                  materialChangeSuperseded:
                    materialProviderChangeEntryIds.has(entry.id),
                  authoritativeTerminalResultSuperseded: false,
                  currentRuntimeProofRecorded: Boolean(
                    hasCurrentCourseSupportProviderExecutionProof({
                      proofSnapshot: entry.proofSnapshot,
                      baseSha: batch.baseSha,
                      releaseSha: batch.releaseSha,
                      claimedAt: batch.createdAt,
                      recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
                    }) ||
                      (entry.verificationRequests ?? []).some(
                        (request) =>
                          request.releaseSha === (batch.releaseSha ?? batch.baseSha) &&
                          hasDurableDetachedProviderExecutionEvidence(request),
                      ),
                  ),
                  currentClassificationProofRecorded: false,
                })
              : null;
            const countsTowardOperationalNoProgress =
              !safeRequeueOrchestrationOnlyEntryIds.has(entry.id) &&
              !supersededImplementationEntryIds.has(entry.id);
            const orchestrationRetry =
              safeRequeueOrchestrationRetryByEntryId.get(entry.id);
            const attemptsCompleted =
              countCourseSupportOperationalNoProgressAttempts({
                batchIncidents: entry.incident.batchIncidents ?? [],
                cycle: entry.cycle,
                courseId: entry.courseId,
                providerSnapshotFingerprint,
                failureFingerprint: entry.incident.failureFingerprint,
                approach,
                zeroExecutionRecoveryRecorded:
                  hasValidatedZeroExecutionRecoveryMarker(
                    entry.cycle,
                    entry.incident.monitoringEvents,
                  ),
              }) + (countsTowardOperationalNoProgress ? 1 : 0);
            return [
              {
                courseRef,
                providerSnapshotFingerprint,
                failureFingerprint: entry.incident.failureFingerprint,
                runtimeVersion: batch.releaseSha ?? batch.baseSha,
                activeRealSearchCount: entry.incident.activeRealSearchCount,
                consumed: false,
                countsTowardOperationalNoProgress,
                executionEvidence: {
                  claimedImplementationPaths: hasRuntimeBearingCourseSupportPath(
                    readBatchPlannedPaths(batch.summary),
                  ),
                  newReleaseRecorded: false,
                  deploymentRecorded: false,
                  postProbeRecorded: false,
                  providerAttemptRecorded: false,
                  providerExecutionAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                  providerExecutionStarted: (
                    entry.verificationRequests ?? []
                  ).some((request) => request.startedAt !== null),
                },
                ...(actionExecution ? { actionExecution } : {}),
                operationalRetry: {
                  maximumAttempts: COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET,
                  attemptsCompleted,
                  attemptsRemaining: Math.max(
                    0,
                    COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET - attemptsCompleted,
                  ),
                  exhausted:
                    attemptsCompleted >=
                    COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET,
                  reason:
                    attemptsCompleted >= COURSE_SUPPORT_OPERATIONAL_RETRY_BUDGET
                      ? "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
                      : "OPERATIONAL_RETRY_AVAILABLE",
                },
                orchestrationRetry: orchestrationRetry
                  ? {
                      attemptNumber: orchestrationRetry.attemptNumber,
                      delaySeconds: Math.floor(
                        orchestrationRetry.delayMs / 1000,
                      ),
                      retryAt: orchestrationRetry.retryAt.toISOString(),
                    }
                  : null,
                approach,
              } satisfies Prisma.InputJsonObject,
            ];
          },
        );
        for (const entryId of safeRequeueOrchestrationOnlyEntryIds) {
          if (stoppedImplementationEntryIds.has(entryId)) {
            continue;
          }
          const currentRetryAt =
            retryAtByBatchIncidentId.get(entryId) ?? retryFloor;
          const orchestrationRetryAt =
            safeRequeueOrchestrationRetryByEntryId.get(entryId)?.retryAt ??
            retryFloor;
          retryAtByBatchIncidentId.set(
            entryId,
            currentRetryAt.getTime() > orchestrationRetryAt.getTime()
              ? currentRetryAt
              : orchestrationRetryAt,
          );
        }
        nextAttemptAt =
          retryAtByBatchIncidentId.size > 0
            ? [...retryAtByBatchIncidentId.values()].reduce(
                (earliest, candidate) =>
                  candidate.getTime() < earliest.getTime() ? candidate : earliest,
              )
            : null;
        await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
          if (safeRequeueSearchExecutionFence) {
            await lockCourseSupportSearchExecutionFenceRows(
              tx,
              safeRequeueSearchExecutionFence.input,
            );
            const lockedFence = await readCourseSupportSearchExecutionFence(
              tx,
              safeRequeueSearchExecutionFence.input,
            );
            if (
              !courseSupportSearchExecutionFenceMatches(
                safeRequeueSearchExecutionFence.expected,
                lockedFence,
              )
            ) {
              throw new Error(
                "Search execution changed during safe responder requeue.",
              );
            }
          }
          const freshDetachedRequestStates =
            await tx.courseSupportVerificationRequest.findMany({
              where: { batchIncident: { batchId: batch.id } },
              select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
            });
          if (
            freshDetachedRequestStates.some(
              isActiveDetachedVerificationRequest,
            )
          ) {
            throw new Error(
              "Detached provider verification is still active during safe responder requeue.",
            );
          }
          for (const entryId of safeRequeueRequestFenceEntryIds) {
            const entry = retryIncidents.find(
              (candidate) => candidate.id === entryId,
            );
            if (!entry) {
              throw new Error(
                "Detached verification execution changed during safe responder requeue.",
              );
            }
            const snapshotRequests = entry.verificationRequests ?? [];
            const freshRequests = freshDetachedRequestStates.filter(
              (candidate) => candidate.batchIncidentId === entry.id,
            );
            const requiresOrchestrationOnlyProof =
              safeRequeueOrchestrationOnlyEntryIds.has(entryId);
            if (
              (requiresOrchestrationOnlyProof &&
                (!snapshotRequests.every(
                  canTreatDetachedVerificationRequestAsOrchestrationOnly,
                ) ||
                  !freshRequests.every(
                    canTreatDetachedVerificationRequestAsOrchestrationOnly,
                  ))) ||
              freshRequests.length !== snapshotRequests.length ||
              freshRequests.some(
                (request) => {
                  const snapshot = snapshotRequests.find(
                    (candidate) => candidate.id === request.id,
                  );
                  return !snapshot || snapshot.revision !== request.revision;
                },
              )
            ) {
              throw new Error(
                "Detached verification execution changed during safe responder requeue.",
              );
            }
            for (const request of snapshotRequests) {
              const requestAsserted =
                await tx.courseSupportVerificationRequest.updateMany({
                  where: {
                    id: request.id,
                    batchIncidentId: entry.id,
                    releaseSha: request.releaseSha,
                    status: request.status,
                    revision: request.revision,
                    attemptCount: request.attemptCount,
                    startedAt: request.startedAt,
                    outcome: request.outcome,
                    failureClass: request.failureClass,
                    evidence:
                      request.evidence === null
                        ? { equals: Prisma.AnyNull }
                        : {
                            equals:
                              request.evidence as Prisma.InputJsonValue,
                          },
                    lastError: request.lastError,
                    runtimeVersion: request.runtimeVersion,
                    providerSnapshotFingerprint:
                      request.providerSnapshotFingerprint,
                    nextAttemptAt: request.nextAttemptAt,
                    completedAt: request.completedAt,
                    createdAt: request.createdAt,
                    updatedAt: request.updatedAt,
                  },
                  data: {
                    revision: { increment: 0 },
                    updatedAt: request.updatedAt,
                  },
                });
              if (requestAsserted.count !== 1) {
                throw new Error(
                  "Detached verification execution changed during safe responder requeue.",
                );
              }
            }
            if (
              !snapshotRequests.some(
                (request) =>
                  request.releaseSha === (batch.releaseSha ?? batch.baseSha),
              )
            ) {
              const lateRequest =
                await tx.courseSupportVerificationRequest.findFirst({
                  where: {
                    batchIncidentId: entry.id,
                    releaseSha: batch.releaseSha ?? batch.baseSha,
                  },
                  select: { id: true },
                });
              if (lateRequest) {
                throw new Error(
                  "Detached verification execution changed during safe responder requeue.",
                );
              }
            }
          }
          if (!strictImplementationProofRecorded) {
            for (const entryId of implementationActionEntryIds) {
              const entry = retryIncidents.find(
                (candidate) => candidate.id === entryId
              );
              const claimedAttempt = claimedAttemptByRetryEntryId.get(entryId);
              if (!entry || !claimedAttempt?.providerSnapshotFingerprint) {
                throw new Error(
                  "Expired responder implementation supersession evidence changed during safe requeue."
                );
              }
              const currentCourse = await tx.course.findUnique({
                where: { id: entry.courseId },
                select: DETACHED_VERIFICATION_COURSE_SELECT
              });
              if (!currentCourse) {
                throw new Error(
                  "Expired responder implementation supersession evidence changed during safe requeue."
                );
              }
              const currentProbes =
                await listAuthoritativeCourseSupportProbeEvidence(tx, {
                  courseId: entry.courseId,
                  incidentLastSeenAt: entry.incident.lastSeenAt,
                  now,
                });
              const currentSuccessAssessment =
                assessAuthoritativeCourseSupportSuccessProbe({
                  probes: currentProbes,
                  incidentLastSeenAt: entry.incident.lastSeenAt,
                  now
                });
              if (currentSuccessAssessment.status === "INVALID") {
                throw new Error(
                  "Expired responder implementation supersession evidence changed during safe requeue."
                );
              }
              const currentAuthoritativeSuccess =
                currentSuccessAssessment.status === "VALID";
              const currentMaterialProviderChange =
                claimedAttempt.providerSnapshotFingerprint !==
                  buildCourseSupportProviderSnapshotFingerprint(currentCourse) ||
                isExpiredImplementationSupersededByCurrentSource({
                  claimedAttempt,
                  course: currentCourse,
                  failureClass: entry.incident.failureClass,
                });
              if (
                currentAuthoritativeSuccess !==
                  authoritativeSuccessEntryIds.has(entryId) ||
                currentMaterialProviderChange !==
                  materialProviderChangeEntryIds.has(entryId)
              ) {
                throw new Error(
                  "Expired responder implementation supersession evidence changed during safe requeue."
                );
              }
            }
          }
          const batchUpdated = await tx.courseSupportBatch.updateMany({
            where: {
              id: batch.id,
              status: batch.status,
              revision: batch.revision,
              leaseExpiresAt: { lte: now },
              releaseSha: batch.releaseSha,
              deployedAt: batch.deployedAt,
              recheckDispatchKey: batch.recheckDispatchKey,
              recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
              recheckDispatchedAt: batch.recheckDispatchedAt,
              completedAt: null,
            },
            data: {
              status: batchStatus,
              completedAt: now,
              heartbeatAt: now,
              leaseExpiresAt: now,
              summary: {
                ...summary,
                closeout: {
                  outcome: derivedOutcome,
                  derivedOutcome,
                  failureDomain: "GIT",
                  terminalCount,
                  retryCount: retryableIncidents.length,
                  needsHumanCount: totalNeedsHumanCount,
                  remediationAttemptConsumed: false,
                  remediationAttempts: safeRequeueRemediationAttempts,
                  actionPlanSupersededByCurrentSourceCount:
                    currentSourceActionPlanChangeEntryIds.size,
                  orchestrationOnlyCount:
                    safeRequeueOrchestrationOnlyEntryIds.size,
                  orchestrationOnlyCourseRefs: retryIncidents
                    .filter((entry) =>
                      safeRequeueOrchestrationOnlyEntryIds.has(entry.id),
                    )
                    .map((entry) =>
                      createCourseSupportRemediationCourseRef(entry.courseId),
                    ),
                  reason: closeoutReason,
                },
              } as Prisma.InputJsonValue,
              revision: { increment: 1 },
            },
          });
          if (batchUpdated.count !== 1) {
            throw new Error(
              "Expired responder ownership changed during safe requeue.",
            );
          }

          for (const entry of batch.incidents) {
            if (entry.incident.status !== "AUTO_INVESTIGATING") {
              const result =
                entry.incident.status === "NEEDS_HUMAN"
                  ? ("NEEDS_HUMAN" as const)
                  : entry.incident.resolution === "MONITORING_RESTORED"
                    ? ("RESTORED" as const)
                    : ("FINAL_DISPOSITION" as const);
              const batchEntryUpdated =
                await tx.courseSupportBatchIncident.updateMany({
                  where: {
                    id: entry.id,
                    result: entry.result,
                    updatedAt: entry.updatedAt,
                  },
                  data: {
                    result,
                    message: terminalMessage,
                  },
                });
              if (batchEntryUpdated.count !== 1) {
                throw new Error(
                  "Expired responder evidence changed during mixed terminal reconciliation.",
                );
              }
              const incidentUpdated = await tx.courseSupportIncident.updateMany(
                {
                  where: {
                    id: entry.incidentId,
                    cycle: entry.cycle,
                    activeBatchId: batch.id,
                    status: entry.incident.status,
                    resolution: entry.incident.resolution,
                    decisionAt: entry.incident.decisionAt,
                    updatedAt: entry.incident.updatedAt,
                  },
                  data: {
                    activeBatchId: null,
                    revision: { increment: 1 },
                  },
                },
              );
              if (incidentUpdated.count !== 1) {
                throw new Error(
                  "Expired responder incident changed during mixed terminal ownership release.",
                );
              }
              continue;
            }
            const recoveryEvidenceObservedAt =
              getCourseSupportIncidentEvidenceObservedAt({
                proofSnapshot: entry.proofSnapshot,
                incidentLastSeenAt: entry.incident.lastSeenAt,
                now,
                additionalProviderObservedAt:
                  entry.course.monitoringStatus?.lastSuccessfulAt ?? null,
              });
            if (stoppedImplementationEntryIds.has(entry.id)) {
              const batchEntryUpdated = await tx.courseSupportBatchIncident.updateMany({
                where: {
                  id: entry.id,
                  result: entry.result,
                  updatedAt: entry.updatedAt
                },
                data: {
                  result: "NEEDS_HUMAN",
                  message: stoppedImplementationMessage
                }
              });
              if (batchEntryUpdated.count !== 1) {
                throw new Error(
                  "Expired responder evidence changed while stopping unproven implementation work."
                );
              }
              const incidentUpdated = await tx.courseSupportIncident.updateMany({
                where: {
                  id: entry.incidentId,
                  cycle: entry.cycle,
                  activeBatchId: batch.id,
                  status: "AUTO_INVESTIGATING",
                  updatedAt: entry.incident.updatedAt
                },
                data: {
                  status: "NEEDS_HUMAN",
                  activeBatchId: null,
                  nextAttemptAt: null,
                  humanReviewReason: "AUTOMATION_STALLED",
                  nextReminderAt: now,
                  escalatedAt: now,
                  latestMessage: stoppedImplementationMessage,
                  nextAction:
                    "Complete the assigned runtime implementation and deployment under fresh responder ownership before verification.",
                  lastSeenAt: recoveryEvidenceObservedAt,
                  revision: { increment: 1 }
                }
              });
              if (incidentUpdated.count !== 1) {
                throw new Error(
                  "Expired responder incident changed while stopping unproven implementation work."
                );
              }
              const monitoringStatus = entry.course.monitoringStatus;
              if (
                monitoringStatus &&
                ["UNKNOWN", "DEGRADED_RETRYING", "AUTO_INVESTIGATING"].includes(
                  monitoringStatus.state
                )
              ) {
                const monitoringUpdated = await tx.courseMonitoringStatus.updateMany({
                  where: {
                    courseId: entry.courseId,
                    state: monitoringStatus.state,
                    revision: monitoringStatus.revision,
                    lastSuccessfulAt: monitoringStatus.lastSuccessfulAt
                  },
                  data: {
                    state: "ENGINEERING_VERIFICATION_NEEDED",
                    nextAutomaticAttemptAt: null,
                    revalidationRequestedAt: null,
                    stateChangedAt: now,
                    revision: { increment: 1 }
                  }
                });
                if (monitoringUpdated.count !== 1) {
                  throw new Error(
                    "Course monitoring changed while stopping unproven implementation work."
                  );
                }
              }
              continue;
            }
            const entryNextAttemptAt =
              retryAtByBatchIncidentId.get(entry.id) ?? retryFloor;
            const remediationAttempt = safeRequeueRemediationAttempts.find(
              (attempt) =>
                attempt.courseRef ===
                createCourseSupportRemediationCourseRef(entry.courseId),
            );
            const currentCycleIsOrchestrationOnly =
              safeRequeueOrchestrationOnlyEntryIds.has(entry.id);
            const retryEscalationDeadline = currentCycleIsOrchestrationOnly
              ? null
              : remediationAttempt
                ? (entry.incident.escalationDeadlineAt ??
                  getCourseMonitoringEscalationDeadline(
                    now,
                    entry.incident.activeRealSearchCount,
                  ))
                : entry.incident.escalationDeadlineAt;
            const batchEntryUpdated =
              await tx.courseSupportBatchIncident.updateMany({
                where: {
                  id: entry.id,
                  result: entry.result,
                  updatedAt: entry.updatedAt,
                },
                data: {
                  result: "RETRY_SCHEDULED",
                  message,
                },
              });
            if (batchEntryUpdated.count !== 1) {
              throw new Error(
                "Expired responder evidence changed during safe requeue.",
              );
            }
            const incidentUpdated = await tx.courseSupportIncident.updateMany({
              where: {
                id: entry.incidentId,
                cycle: entry.cycle,
                activeBatchId: batch.id,
                status: "AUTO_INVESTIGATING",
                updatedAt: entry.incident.updatedAt,
              },
              data: {
                activeBatchId: null,
                escalationDeadlineAt: retryEscalationDeadline,
                nextAttemptAt: entryNextAttemptAt,
                latestMessage: message,
                lastSeenAt: recoveryEvidenceObservedAt,
                revision: { increment: 1 },
              },
            });
            if (incidentUpdated.count !== 1) {
              throw new Error(
                "Expired responder incident changed during safe requeue.",
              );
            }
            const monitoringStatus = entry.course.monitoringStatus;
            if (
              monitoringStatus &&
              ["UNKNOWN", "DEGRADED_RETRYING", "AUTO_INVESTIGATING"].includes(
                monitoringStatus.state,
              )
            ) {
              await tx.courseMonitoringStatus.updateMany({
                where: {
                  courseId: entry.courseId,
                  state: monitoringStatus.state,
                  revision: monitoringStatus.revision,
                  lastSuccessfulAt: monitoringStatus.lastSuccessfulAt,
                },
                data: {
                  state: "AUTO_INVESTIGATING",
                  nextAutomaticAttemptAt: entryNextAttemptAt,
                  stateChangedAt: now,
                  revision: { increment: 1 },
                },
              });
            }
          }

          await tx.courseSupportVerificationRequest.updateMany({
            where: {
              batchIncident: { batchId: batch.id },
              status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
            },
            data: {
              status: "STALE",
              revision: { increment: 1 },
              leaseToken: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              completedAt: now,
              lastError: verificationLastError,
              updatedAt: now,
            },
          });

          if (batch.ownerAutomationRunId) {
            const automationRunUpdated = await tx.automationRun.updateMany({
              where: { id: batch.ownerAutomationRunId, completedAt: null },
              data: {
                kind: "COURSE_SUPPORT",
                status:
                  safeRequeueOrchestrationOnlyEntryIds.size > 0 || stoppedImplementationCount > 0
                    ? "FAILED"
                    : "COMPLETED",
                completedAt: now,
                outcome: derivedOutcome,
                notes: JSON.stringify({
                  schemaVersion: 1,
                  lifecycle: "closeout",
                  status: batchStatus,
                  outcome: derivedOutcome,
                  derivedOutcome,
                  terminalCount,
                  retryCount: retryableIncidents.length,
                  needsHumanCount: totalNeedsHumanCount,
                  implementationStoppedCount: stoppedImplementationCount,
                  actionPlanSupersededByCurrentSourceCount:
                    currentSourceActionPlanChangeEntryIds.size,
                  failureDomain: "GIT",
                  remediationAttemptConsumed: false,
                  operationalNoProgressAttemptCount:
                    safeRequeueRemediationAttempts.filter(
                      (attempt) =>
                        attempt.countsTowardOperationalNoProgress === true,
                    ).length,
                  orchestrationOnlyCount:
                    safeRequeueOrchestrationOnlyEntryIds.size,
                  reason: closeoutReason,
                }),
              },
            });
            if (automationRunUpdated.count !== 1) {
              throw new Error("Expired responder automation run changed during safe requeue.");
            }
          }
        });
        return {
          outcome: derivedOutcome,
          recovered: false,
          safelyRequeued: retryableIncidents.length > 0,
          implementationStoppedCount: stoppedImplementationCount,
          actionPlanSupersededByCurrentSourceCount:
            currentSourceActionPlanChangeEntryIds.size,
          superseded: terminalIncidents.length > 0,
          durableCloseoutRecorded: true,
          nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
          reasons: [message],
          ...getResponderThreadPolicy({
            outcome: derivedOutcome,
            nextAttemptAt,
            requiresHuman: hasHuman,
            durableCloseoutRecorded: true,
            now,
          }),
        };
      }
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: recovery.reasons.map(sanitizeResponderText),
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery provenance did not match.",
      };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
    );
    const recoveredReleaseSha =
      batch.releaseSha ??
      (input.currentHeadSha !== batch.baseSha ? input.currentHeadSha : null);
    const updated = await prisma.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { lte: now },
      },
      data: {
        ownerThreadId: input.requestingThreadId,
        leaseToken,
        leaseExpiresAt,
        heartbeatAt: now,
        releaseSha: recoveredReleaseSha,
        revision: { increment: 1 },
      },
    });
    return updated.count === 1
      ? {
          outcome: "ready" as const,
          recovered: true,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          threadDisposition: "KEEP_VISIBLE" as const,
          archiveReason: "Recovered responder work remains in progress.",
        }
      : {
          outcome: "deferred_busy" as const,
          recovered: false,
          threadDisposition: "ARCHIVE" as const,
          archiveReason: "Another responder recovered the batch first.",
        };
  });
  return lease.acquired
    ? lease.value
    : {
        outcome: "deferred_busy" as const,
        recovered: false,
        threadDisposition: "ARCHIVE" as const,
        archiveReason:
          "Another course-support writer owns the transition lease.",
      };
}

export async function backfillCourseSupportResponderState(input?: {
  apply?: boolean;
  now?: Date }) {
  const now = input?.now ?? new Date();
  const [courses, incidents] = await Promise.all([
    prisma.course.findMany({
      select: {
        id: true,
        providerFamilyKey: true,
        detectedPlatform: true,
        detectedBookingUrl: true,
        website: true,
        bookingMetadata: true,
        automationDiscoveries: {
          where: {
            status: { in: [...COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUSES] },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            detectedPlatform: true,
            bookingUrl: true,
            sourceUrl: true,
            apiMetadata: true,
            confidence: true,
          },
        },
        updatedAt: true,
      },
    }),
    prisma.courseSupportIncident.findMany({
      where: { status: { not: "RESOLVED" }, activeBatchId: null },
      include: {
        course: {
          select: {
            timeZone: true,
            providerFamilyKey: true,
            detectedPlatform: true,
            detectedBookingUrl: true,
            website: true,
            bookingMetadata: true,
            automationDiscoveries: {
              where: {
                status: { in: [...COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUSES] },
              },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                status: true,
                detectedPlatform: true,
                bookingUrl: true,
                sourceUrl: true,
                apiMetadata: true,
                confidence: true,
              },
            },
            preferences: {
              where: {
                teeSearch: { status: "ACTIVE" },
              },
              select: {
                teeSearch: {
                  select: { date: true, trafficClass: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);
  const courseUpdates = courses.flatMap((course) => {
    const providerFamilyKey =
      resolveCourseSupportProviderCapability(course).providerFamilyKey;
    return providerFamilyKey === course.providerFamilyKey
      ? []
      : [
          {
            id: course.id,
            previousProviderFamilyKey: course.providerFamilyKey,
            previousUpdatedAt: course.updatedAt,
            providerFamilyKey,
          },
        ];
  });
  const updates = incidents.map((incident) => {
    const localDateBoundary = getCourseLocalDateStorageBoundary(
      incident.course.timeZone,
      now,
    );
    const realSearchDates = incident.course.preferences
      .filter(
        (preference) =>
          preference.teeSearch.date.getTime() >= localDateBoundary.getTime() &&
          preference.teeSearch.trafficClass !== "AUTOMATION" &&
          preference.teeSearch.trafficClass !== "TEST",
      )
      .map((preference) => preference.teeSearch.date)
      .sort((left, right) => left.getTime() - right.getTime());
    const provider = resolveCourseSupportProviderCapability(incident.course);
    const providerFamilyKey = provider.providerFamilyKey;
    const observedFailure = classifyProviderFailure({
      error: incident.latestMessage ?? incident.initialMessage,
    }).failureClass;
    const failureClass = deriveBackfillFailureClass({
      existing: incident.failureClass,
      kind: incident.kind,
      readinessFailure:
        incident.kind === "NEEDS_ADAPTER"
          ? getProviderReadinessFailure(provider)
          : null,
      observedFailure,
    });
    return {
      id: incident.id,
      previousUpdatedAt: incident.updatedAt,
      cycle: incident.cycle,
      status: incident.status,
      providerFamilyKey,
      failureClass,
      failureFingerprint: buildFailureFingerprint({
        providerFamilyKey,
        kind: incident.kind,
        failureClass,
      }),
      activeRealSearchCount: realSearchDates.length,
      earliestTargetDate: realSearchDates[0] ?? null,
      engineeringOnly:
        realSearchDates.length > 0 ? false : incident.engineeringOnly,
      nextAttemptAt:
        incident.status === "AUTO_INVESTIGATING"
          ? (incident.nextAttemptAt ?? now)
          : null,
    };
  });

  let appliedCourseUpdateCount = 0;
  let appliedIncidentUpdateCount = 0;
  if (input?.apply) {
    const courseResults =
      courseUpdates.length > 0
        ? await prisma.$transaction(
            courseUpdates.map((update) =>
              prisma.course.updateMany({
                where: {
                  id: update.id,
                  providerFamilyKey: update.previousProviderFamilyKey,
                  updatedAt: update.previousUpdatedAt,
                },
                data: { providerFamilyKey: update.providerFamilyKey },
              }),
            ),
          )
        : [];
    const incidentResults =
      updates.length > 0
        ? await prisma.$transaction(
            updates.map((update) =>
              prisma.courseSupportIncident.updateMany({
                where: {
                  id: update.id,
                  updatedAt: update.previousUpdatedAt,
                  cycle: update.cycle,
                  status: update.status,
                  activeBatchId: null,
                },
                data: {
                  providerFamilyKey: update.providerFamilyKey,
                  failureClass: update.failureClass,
                  failureFingerprint: update.failureFingerprint,
                  activeRealSearchCount: update.activeRealSearchCount,
                  earliestTargetDate: update.earliestTargetDate,
                  engineeringOnly: update.engineeringOnly,
                  nextAttemptAt: update.nextAttemptAt,
                },
              }),
            ),
          )
        : [];
    appliedCourseUpdateCount = courseResults.reduce(
      (total, result) => total + result.count,
      0,
    );
    appliedIncidentUpdateCount = incidentResults.reduce(
      (total, result) => total + result.count,
      0,
    );
  }

  return {
    outcome: "success" as const,
    mode: input?.apply ? ("applied" as const) : ("dry_run" as const),
    courseUpdateCount: courseUpdates.length,
    appliedCourseUpdateCount,
    incidentCount: updates.length,
    appliedIncidentUpdateCount,
    conflictSkippedCount: input?.apply
      ? courseUpdates.length +
        updates.length -
        appliedCourseUpdateCount -
        appliedIncidentUpdateCount
      : 0,
    realDemandIncidentCount: updates.filter(
      (update) => update.activeRealSearchCount > 0,
    ).length,
    engineeringOnlyIncidentCount: updates.filter(
      (incident) => incident.engineeringOnly,
    ).length,
    providerFamilyCount: new Set(
      updates.map((update) => update.providerFamilyKey),
    ).size,
    failureClassCounts: Object.fromEntries(
      [...new Set(updates.map((update) => update.failureClass))]
        .sort()
        .map((failureClass) => [
          failureClass,
          updates.filter((update) => update.failureClass === failureClass)
            .length,
        ]),
    ),
  };
}

export function resolveCourseSupportProviderCapability(
  course: Parameters<typeof resolveProviderCapability>[0] & {
    automationDiscoveries?: ReadonlyArray<{
      status: string;
      detectedPlatform?: string | null;
      bookingUrl?: string | null;
      sourceUrl?: string | null;
      apiMetadata?: unknown;
      confidence: number;
    }>;
  },
) {
  const persistedProvider = resolveProviderCapability(course);
  if (persistedProvider.evidenceConflict) {
    return persistedProvider;
  }

  const discovery = course.automationDiscoveries?.find((candidate) =>
    COURSE_SUPPORT_PROVIDER_DISCOVERY_STATUS_SET.has(candidate.status),
  );
  if (!discovery) {
    return persistedProvider;
  }

  const discoveredProvider = resolveProviderDiscoveryIdentity({
    detectedPlatform: discovery.detectedPlatform,
    bookingUrl: discovery.bookingUrl,
    apiMetadata: discovery.apiMetadata,
    confidence: discovery.confidence,
  });
  if (!discoveredProvider) {
    return persistedProvider;
  }
  if (
    persistedProvider.capability &&
    persistedProvider.providerFamilyKey !== discoveredProvider.providerFamilyKey
  ) {
    return persistedProvider;
  }
  if (persistedProvider.isRunnable && !discoveredProvider.isRunnable) {
    return persistedProvider;
  }

  return discoveredProvider;
}

export function buildFailureFingerprint(input: {
  providerFamilyKey: string;
  kind: CourseSupportIncidentKind;
  failureClass: CourseSupportFailureClass;
}) {
  return buildProviderFailureFingerprint({
    providerFamilyKey: input.providerFamilyKey,
    failureClass: input.failureClass,
    operation: input.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
  });
}

function isHistoricalCriticalRealDemand(
  incident: {
    engineeringOnly: boolean;
    activeRealSearchCount: number;
    kind: CourseSupportIncidentKind;
    earliestTargetDate: Date | null;
  },
  now: Date,
) {
  return Boolean(
    !incident.engineeringOnly &&
    incident.activeRealSearchCount > 0 &&
    incident.kind === "FETCH_FAILED" &&
    incident.earliestTargetDate &&
    incident.earliestTargetDate.getTime() <=
      now.getTime() + NEAR_DATE_WINDOW_MS,
  );
}

function deterministicJitter(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return 0.9 + (hash % 201) / 1000;
}

function getPersistedFinalDisposition(
  course: CourseSupportCourseEvidence,
  incidentFirstSeenAt: Date,
  now: Date,
): { message: string; proofSnapshot: Prisma.InputJsonValue } | null {
  const placeReview = course.latestPlaceReview;
  const placeReviewEvidenceOrigin = placeReview
    ? getSafeEvidenceOrigin(placeReview.evidenceUrl)
    : null;
  const exactIdentityDisposition = Boolean(
    placeReview &&
    placeReview.active &&
    placeReviewEvidenceOrigin &&
    placeReview.updatedAt.getTime() >= incidentFirstSeenAt.getTime() &&
    (placeReview.accessOverride === "VERIFIED_PRIVATE" ||
      placeReview.accessOverride === "VERIFIED_NON_COURSE") &&
    !course.isPublic &&
    course.automationEligibility === "BLOCKED" &&
    course.automationReason === "OTHER",
  );
  if (placeReview && placeReviewEvidenceOrigin && exactIdentityDisposition) {
    return {
      message:
        "A current exact-place review supports a final private or non-course disposition.",
      proofSnapshot: {
        kind: "EXACT_PLACE_REVIEW",
        disposition: placeReview.accessOverride,
        classification: placeReview.classification,
        reviewedAt: placeReview.reviewedAt.toISOString(),
        reviewUpdatedAt: placeReview.updatedAt.toISOString(),
        evidenceOrigin: placeReviewEvidenceOrigin,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
      } satisfies Prisma.InputJsonObject,
    };
  }

  const discovery = course.latestDiscovery;
  const evidenceOrigin = discovery
    ? getSafeEvidenceOrigin(discovery.sourceUrl)
    : null;
  const privateIdentityDisposition = discovery
    ? getVerifiedBrowserPrivateIdentityDisposition({
        course,
        discovery,
        incidentFirstSeenAt,
        now,
        evidenceOrigin,
      })
    : null;
  if (privateIdentityDisposition) {
    return privateIdentityDisposition;
  }
  if (
    !discovery ||
    !evidenceOrigin ||
    discovery.createdAt.getTime() < incidentFirstSeenAt.getTime() ||
    discovery.confidence < 0.7 ||
    !["LEARNED", "VERIFIED", "BLOCKED"].includes(discovery.status)
  ) {
    return null;
  }

  const manualDisposition =
    course.isPublic &&
    course.monitoringMode === "CONTACT_ONLY" &&
    isCoherentManualDisposition(course) &&
    isCoherentManualDisposition(discovery) &&
    discovery.bookingMethod === course.bookingMethod &&
    hasAuthoritativeContactEvidence(course, discovery.sourceUrl) &&
    ["VERIFIED", "BLOCKED"].includes(discovery.status);
  const blockedDisposition =
    course.isPublic &&
    course.automationEligibility === "BLOCKED" &&
    discovery.automationEligibility === "BLOCKED" &&
    FINAL_AUTOMATION_REASONS.has(course.automationReason) &&
    discovery.automationReason === course.automationReason;
  if (!manualDisposition && !blockedDisposition) {
    return null;
  }

  return {
    message: manualDisposition
      ? "Current official evidence supports a manual direct-course disposition."
      : "Current official evidence supports a final technically gated non-runnable disposition.",
    proofSnapshot: {
      kind: "FINAL_DISPOSITION",
      disposition: manualDisposition
        ? "MANUAL_DIRECT"
        : course.automationReason,
      discoveryStatus: discovery.status,
      discoveryCreatedAt: discovery.createdAt.toISOString(),
      evidenceOrigin,
      confidence: discovery.confidence,
      bookingMethod: course.bookingMethod,
      automationEligibility: course.automationEligibility,
      automationReason: course.automationReason,
      discoveryBookingMethod: discovery.bookingMethod,
      discoveryAutomationEligibility: discovery.automationEligibility,
      discoveryAutomationReason: discovery.automationReason,
    } satisfies Prisma.InputJsonObject,
  };
}

function buildProbeProofSnapshot(
  probe: FreshProbeEvidence,
): Prisma.InputJsonValue {
  const providerObservedAt = getFreshProbeProviderObservedAt(probe);
  return {
    kind: "PROVIDER_PROBE",
    outcome: probe.outcome,
    observedAt: providerObservedAt?.toISOString() ?? null,
    freshSearchCheckedAt: (
      probe.freshSearchCheckedAt ?? probe.observedAt
    ).toISOString(),
    runtimeVersion: probe.runtimeVersion,
    providerExecution: probe.providerExecution,
    scheduleVersion: probe.scheduleVersion ?? null,
    trafficClass: probe.trafficClass ?? null,
  } satisfies Prisma.InputJsonObject;
}

function getSafeEvidenceOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export async function parkCourseSupportCandidatesForMaterialChange(
  candidates: CourseSupportCandidate[],
  now: Date,
) {
  if (candidates.length === 0) {
    return 0;
  }
  let parkedCount = 0;
  for (const candidate of candidates) {
    const route = candidate.remediationRoute;
    if (!route || route.workMode !== "WAIT_FOR_MATERIAL_CHANGE") {
      continue;
    }
    const parked = await runSerializedCourseMonitoringWrite(
      candidate.courseId,
      async (transaction) => {
        if (!hasCourseMonitoringPersistence(transaction)) {
          return false;
        }
        const [incident, monitoringStatus] = await Promise.all([
          transaction.courseSupportIncident.findUnique({
            where: { id: candidate.id },
            select: {
              id: true,
              courseId: true,
              cycle: true,
              revision: true,
              status: true,
              activeBatchId: true,
              resolution: true,
              resolvedAt: true,
              lastSeenAt: true,
              updatedAt: true,
              failureFingerprint: true,
              engineeringOnly: true,
              activeRealSearchCount: true,
              earliestTargetDate: true,
              escalatedAt: true,
            },
          }),
          transaction.courseMonitoringStatus.findUnique({
            where: { courseId: candidate.courseId },
            select: {
              state: true,
              stateChangedAt: true,
              lastSuccessfulAt: true,
              revision: true,
            },
          }),
        ]);
        if (
          !incident ||
          !monitoringStatus ||
          incident.courseId !== candidate.courseId
        ) {
          return false;
        }

        const authoritativeResolution =
          getAuthoritativeCourseMonitoringResolution(monitoringStatus.state);
        if (authoritativeResolution) {
          const monitoringFence =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: candidate.courseId,
                state: monitoringStatus.state,
                stateChangedAt: monitoringStatus.stateChangedAt,
                lastSuccessfulAt: monitoringStatus.lastSuccessfulAt,
                revision: monitoringStatus.revision,
              },
              data: { revision: { increment: 0 } },
            });
          if (monitoringFence.count !== 1) {
            throw new Error(
              "Course-support parking write conflict while fencing authoritative monitoring.",
            );
          }
          if (
            incident.status !== "RESOLVED" &&
            !incident.activeBatchId &&
            ["AUTO_INVESTIGATING", "NEEDS_HUMAN"].includes(incident.status)
          ) {
            const reconciled =
              await transaction.courseSupportIncident.updateMany({
                where: {
                  id: incident.id,
                  courseId: candidate.courseId,
                  cycle: incident.cycle,
                  revision: incident.revision,
                  status: incident.status,
                  activeBatchId: null,
                },
                data: {
                  status: "RESOLVED",
                  resolvedAt: now,
                  resolution: authoritativeResolution.resolution,
                  resolutionMessage: authoritativeResolution.message,
                  nextAction: null,
                  nextAttemptAt: null,
                  nextReminderAt: null,
                  lastSeenAt: getCourseSupportIncidentEvidenceObservedAt({
                    proofSnapshot: null,
                    incidentLastSeenAt: incident.lastSeenAt,
                    now,
                    additionalProviderObservedAt:
                      monitoringStatus.state === "HEALTHY"
                        ? monitoringStatus.lastSuccessfulAt
                        : null,
                  }),
                  revision: { increment: 1 },
                },
              });
            if (reconciled.count !== 1) {
              throw new Error(
                "Course-support parking write conflict while reconciling authoritative monitoring.",
              );
            }
          }
          return false;
        }

        if (incident.status === "RESOLVED") {
          const authoritativeState =
            getAuthoritativeMonitoringStateForResolution(incident.resolution);
          if (
            authoritativeState &&
            monitoringStatus.state !== authoritativeState
          ) {
            const reconciled =
              await transaction.courseMonitoringStatus.updateMany({
                where: {
                  courseId: candidate.courseId,
                  state: monitoringStatus.state,
                  stateChangedAt: monitoringStatus.stateChangedAt,
                  revision: monitoringStatus.revision,
                },
                data: {
                  state: authoritativeState,
                  nextAutomaticAttemptAt: null,
                  revalidationRequestedAt: null,
                  stateChangedAt: incident.resolvedAt ?? now,
                  ...(authoritativeState === "HEALTHY"
                    ? { lastSuccessfulAt: incident.lastSeenAt }
                    : {}),
                  revision: { increment: 1 },
                },
              });
            if (reconciled.count !== 1) {
              throw new Error(
                "Course-support parking write conflict while reconciling authoritative finality.",
              );
            }
          }
          return false;
        }

        if (
          incident.cycle !== candidate.cycle ||
          incident.status !== "AUTO_INVESTIGATING" ||
          incident.activeBatchId ||
          incident.updatedAt.getTime() !== candidate.updatedAt.getTime()
        ) {
          return false;
        }

        const incidentUpdated =
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              courseId: candidate.courseId,
              cycle: incident.cycle,
              revision: incident.revision,
              status: "AUTO_INVESTIGATING",
              activeBatchId: null,
              updatedAt: incident.updatedAt,
            },
            data: {
              status: "NEEDS_HUMAN",
              engineeringOnly: candidate.engineeringOnly,
              activeRealSearchCount: candidate.activeRealSearchCount,
              earliestTargetDate: candidate.earliestTargetDate,
              nextAttemptAt: null,
              nextReminderAt: now,
              escalatedAt: candidate.escalatedAt ?? incident.escalatedAt ?? now,
              humanReviewReason: "AUTOMATION_STALLED",
              latestMessage:
                "The prior remediation approach has no new material inputs and will not be repeated.",
              nextAction:
                "Wait for a material provider, failure, reader-capability, relevant implementation, or operator change before retrying.",
              revision: { increment: 1 },
            },
          });
        if (incidentUpdated.count !== 1) {
          throw new Error(
            "Course-support parking write conflict while updating the incident.",
          );
        }
        const monitoringUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: candidate.courseId,
              state: monitoringStatus.state,
              stateChangedAt: monitoringStatus.stateChangedAt,
              revision: monitoringStatus.revision,
            },
            data: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: now,
              revision: { increment: 1 },
            },
          });
        if (monitoringUpdated.count !== 1) {
          throw new Error(
            "Course-support parking write conflict while updating monitoring status.",
          );
        }
        await transaction.courseMonitoringEvent.create({
          data: {
            courseId: candidate.courseId,
            incidentId: incident.id,
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "COURSE_SUPPORT_RESPONDER",
            fromState: monitoringStatus.state,
            toState: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: incident.failureFingerprint,
            message:
              "The unchanged remediation approach was parked until a material input changes.",
            occurredAt: now,
            audit: {
              cycle: incident.cycle,
              customerState: "NEEDS_HUMAN_REVIEW",
              automationStalled: true,
              parkedUntilMaterialChange: true,
              reason: route.reason,
              resumeWorkMode: route.resumeWorkMode,
              repeatedApproachSuppressed:
                route.reason === "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
              transientBudgetExhausted:
                route.reason === "TRANSIENT_RETRY_BUDGET_EXHAUSTED",
              operationalRetryBudgetExhausted:
                route.reason === "OPERATIONAL_RETRY_BUDGET_EXHAUSTED",
              customerDataIncluded: false,
            },
          },
        });
        return true;
      },
    );
    if (parked) {
      parkedCount += 1;
    }
  }
  return parkedCount;
}

async function listParkedSourceCompleteFinalizationRecoveryCandidates(
  now: Date,
) {
  const incidents = await prisma.courseSupportIncident.findMany({
    where: buildParkedSourceCompleteFinalizationRecoveryWhere(),
    orderBy: [{ earliestTargetDate: "asc" }, { firstSeenAt: "asc" }],
    take: COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT + 1,
    select: COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT,
  });
  assertBoundedCourseSupportCandidateQueue(incidents);
  await assertBoundedCourseSupportCandidateCurrentCycleHistory(
    prisma,
    incidents,
  );
  return buildCourseSupportCandidates(incidents, now).filter((candidate) =>
    Boolean(readCandidateSourceCompleteFinalizationRecovery(candidate)),
  );
}

type CourseSupportClaimCandidateReadClient = Pick<
  Prisma.TransactionClient,
  "courseSupportIncident" | "courseMonitoringEvent"
>;

async function listCourseSupportClaimCandidateIncidents(
  now: Date,
  client: CourseSupportClaimCandidateReadClient = prisma,
) {
  const firstPage = await client.courseSupportIncident.findMany({
    where: {
      OR: [
        buildDueResponderIncidentWhere(now),
        buildParkedSourceCompleteFinalizationRecoveryWhere(),
      ],
    },
    orderBy: [
      { status: "asc" },
      { earliestTargetDate: "asc" },
      { firstSeenAt: "asc" },
    ],
    take: COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT + 1,
    select: COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT,
  });
  if (firstPage.length <= COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT) {
    await assertBoundedCourseSupportCandidateCurrentCycleHistory(
      client,
      firstPage,
    );
    return firstPage;
  }

  const dueIncidents = firstPage.filter(
    (incident) => incident.status === "AUTO_INVESTIGATING",
  );
  assertBoundedCourseSupportCandidateQueue(dueIncidents);
  if (
    firstPage[COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT]?.status ===
    "AUTO_INVESTIGATING"
  ) {
    assertBoundedCourseSupportCandidateQueue(firstPage);
  }

  const parkedSuperset = await client.courseSupportIncident.findMany({
    where: buildParkedSourceCompleteFinalizationRecoveryWhere(),
    orderBy: [{ earliestTargetDate: "asc" }, { firstSeenAt: "asc" }],
    take: COURSE_SUPPORT_PARKED_RECOVERY_SCAN_LIMIT + 1,
    select: COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT,
  });
  if (parkedSuperset.length > COURSE_SUPPORT_PARKED_RECOVERY_SCAN_LIMIT) {
    if (dueIncidents.length === 0) {
      throw new Error(
        "The parked course-support recovery queue exceeds the bounded scan limit.",
      );
    }
    await assertBoundedCourseSupportCandidateCurrentCycleHistory(
      client,
      dueIncidents,
    );
    return dueIncidents;
  }
  const exactParkedIds = new Set(
    buildSelectableCourseSupportClaimCandidates(parkedSuperset, now)
      .filter((candidate) =>
        Boolean(readCandidateSourceCompleteFinalizationRecovery(candidate)),
      )
      .map((candidate) => candidate.id),
  );
  const incidents = [
    ...dueIncidents,
    ...parkedSuperset.filter((incident) => exactParkedIds.has(incident.id)),
  ];
  await assertBoundedCourseSupportCandidateCurrentCycleHistory(
    client,
    incidents,
  );
  return incidents;
}

async function listCourseSupportClaimCandidates(now: Date) {
  return buildSelectableCourseSupportClaimCandidates(
    await listCourseSupportClaimCandidateIncidents(now),
    now,
  );
}

function readExactDeferredFailureHandoffAttempt(input: {
  summary: unknown;
  courseId: string }) {
  const closeout = asJsonObject(asJsonObject(input.summary).closeout);
  if (!Array.isArray(closeout.remediationAttempts)) return null;
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const matchingAttempts = closeout.remediationAttempts.filter(
    (entry) => asJsonObject(entry).courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return null;
  const attempt = asJsonObject(matchingAttempts[0]);
  const signal = parseDeferredFailureHandoffSignal(
    attempt.deferredFailureHandoff,
  );
  if (!signal) return null;
  const admission =
    attempt.deferredFailureHandoffAdmission === undefined
      ? null
      : parseDeferredFailureHandoffAdmission(
          attempt.deferredFailureHandoffAdmission,
        );
  if (
    attempt.deferredFailureHandoffAdmission !== undefined &&
    !admission
  ) {
    return null;
  }
  const executionEvidence = asJsonObject(attempt.executionEvidence);
  const invalidation = asJsonObject(
    attempt.deferredFailureHandoffInvalidation,
  );
  const executionEvidenceHasExactShape =
    readExactCourseSupportDecisionExecutionEvidenceShape(
      attempt.executionEvidence,
    ) !== null;
  const isExactUnstartedCarrier = Boolean(
    admission &&
      admission.signalDigest === signal.signalDigest &&
      admission.sourceRecordDigest === signal.recordDigest &&
      admission.sourceBatchIncidentDigest ===
        signal.sourceBatchIncidentDigest &&
      attempt.consumed === false &&
      attempt.countsTowardOperationalNoProgress === false &&
      signal.state === "AVAILABLE" &&
      !signal.confirmationStarted &&
      attempt.deferredFailureHandoffInvalidation === undefined &&
      executionEvidenceHasExactShape &&
      executionEvidence.claimedImplementationPaths === false &&
      executionEvidence.newReleaseRecorded === false &&
      executionEvidence.deploymentRecorded === false &&
      executionEvidence.postProbeRecorded === false &&
      executionEvidence.providerAttemptRecorded === false &&
      executionEvidence.providerExecutionAttemptRecorded === false &&
      executionEvidence.playbookAttemptRecorded === false &&
      executionEvidence.terminalResultRecorded === false &&
      executionEvidence.providerExecutionStarted === false,
  );
  const consumedByRecordedExecution = Boolean(
    executionEvidence.deploymentRecorded === true ||
      executionEvidence.providerAttemptRecorded === true ||
      executionEvidence.playbookAttemptRecorded === true ||
      executionEvidence.terminalResultRecorded === true,
  );
  const durableOperationalNoProgressRecorded = Boolean(
    consumedByRecordedExecution ||
      executionEvidence.providerExecutionAttemptRecorded === true,
  );
  const operationalNoProgressMatchesCurrentOrLegacyStartedSemantics =
    attempt.countsTowardOperationalNoProgress ===
      durableOperationalNoProgressRecorded ||
    (attempt.countsTowardOperationalNoProgress === true &&
      !durableOperationalNoProgressRecorded &&
      executionEvidence.providerExecutionStarted === true);
  const admissionMatchesSignal = Boolean(
    admission &&
      admission.signalDigest === signal.signalDigest &&
      admission.sourceRecordDigest === signal.recordDigest &&
      admission.sourceBatchIncidentDigest === signal.sourceBatchIncidentDigest,
  );
  const attemptMatchesSignalIdentity = Boolean(
    attempt.failureFingerprint === signal.canonicalFailureFingerprint &&
      attempt.observedFailureFingerprint ===
        signal.observedFailureFingerprint &&
      attempt.providerSnapshotFingerprint ===
        signal.claimedProviderSnapshotFingerprint &&
      attempt.observedProviderSnapshotFingerprint ===
        signal.observedProviderSnapshotFingerprint &&
      typeof attempt.runtimeVersion === "string" &&
      /^[a-f0-9]{40}$/u.test(attempt.runtimeVersion),
  );
  const isExactStartedConsumedCarrier = Boolean(
    admissionMatchesSignal &&
      attemptMatchesSignalIdentity &&
      signal.state === "CONSUMED" &&
      signal.confirmationStarted &&
      attempt.deferredFailureHandoffInvalidation === undefined &&
      executionEvidenceHasExactShape &&
      executionEvidence.providerExecutionStarted === true &&
      attempt.consumed === consumedByRecordedExecution &&
      operationalNoProgressMatchesCurrentOrLegacyStartedSemantics,
  );
  const isExactInvalidatedConsumedCarrier = Boolean(
    admissionMatchesSignal &&
      attemptMatchesSignalIdentity &&
      signal.state === "CONSUMED" &&
      Object.keys(invalidation).length === 4 &&
      invalidation.schemaVersion === 1 &&
      invalidation.reason === "MUTABLE_CURRENT_STATE_CHANGED" &&
      invalidation.signalDigest === signal.signalDigest &&
      invalidation.customerDataIncluded === false &&
      attempt.consumed === false &&
      operationalNoProgressMatchesCurrentOrLegacyStartedSemantics &&
      executionEvidenceHasExactShape &&
      executionEvidence.providerExecutionStarted ===
        signal.confirmationStarted &&
      Object.entries(executionEvidence).every(
        ([key, value]) =>
          key === "providerExecutionStarted" || value === false,
      ),
  );
  const isExactConsumedCarrier =
    isExactStartedConsumedCarrier || isExactInvalidatedConsumedCarrier;
  const isExactInitialSource = Boolean(
    !admission &&
      attemptMatchesSignalIdentity &&
      attempt.runtimeVersion === signal.runtimeVersion &&
      attempt.failureOnlyHandoffCooldownUntil === signal.cooldownExpiresAt &&
      signal.state === "AVAILABLE" &&
      !signal.confirmationStarted &&
      signal.sourceResult === "RETRY_SCHEDULED" &&
      attempt.deferredFailureHandoffInvalidation === undefined &&
      operationalNoProgressMatchesCurrentOrLegacyStartedSemantics &&
      executionEvidenceHasExactShape &&
      executionEvidence.providerExecutionStarted === true &&
      attempt.consumed === consumedByRecordedExecution,
  );
  if (
    !isExactInitialSource &&
    !isExactUnstartedCarrier &&
    !isExactConsumedCarrier
  ) {
    return null;
  }
  return {
    attempt,
    signal,
    admission,
    sourceKind: isExactConsumedCarrier
      ? ("CONSUMED_CARRIER" as const)
      : ("SUMMARY" as const),
  };
}

function readExactLegacyDeferredFailureHandoffAttempt(input: {
  summary: unknown;
  courseId: string;
}) {
  const closeout = asJsonObject(asJsonObject(input.summary).closeout);
  if (
    closeout.verificationWatchMode !== "WATCH_SETTLED" ||
    closeout.derivedOutcome !== "needs_human" ||
    !Array.isArray(closeout.remediationAttempts)
  ) {
    return null;
  }
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const matchingAttempts = closeout.remediationAttempts.filter(
    (entry) => asJsonObject(entry).courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return null;
  const attempt = asJsonObject(matchingAttempts[0]);
  const executionEvidence = asJsonObject(attempt.executionEvidence);
  const executionEvidenceKeys = Object.keys(executionEvidence);
  const playbookAttemptRecorded =
    executionEvidence.playbookAttemptRecorded === true;
  const exactLegacyExecutionEvidence = Boolean(
    executionEvidenceKeys.length === 9 &&
      [
        "claimedImplementationPaths",
        "newReleaseRecorded",
        "deploymentRecorded",
        "postProbeRecorded",
        "providerAttemptRecorded",
        "providerExecutionAttemptRecorded",
        "playbookAttemptRecorded",
        "terminalResultRecorded",
        "providerExecutionStarted",
      ].every((key) => executionEvidenceKeys.includes(key)) &&
      executionEvidence.claimedImplementationPaths === false &&
      executionEvidence.newReleaseRecorded === false &&
      executionEvidence.deploymentRecorded === false &&
      executionEvidence.postProbeRecorded === false &&
      executionEvidence.providerAttemptRecorded === false &&
      executionEvidence.providerExecutionAttemptRecorded === false &&
      typeof executionEvidence.playbookAttemptRecorded === "boolean" &&
      executionEvidence.terminalResultRecorded === false &&
      executionEvidence.providerExecutionStarted === true,
  );
  return exactLegacyExecutionEvidence &&
    attempt.consumed === playbookAttemptRecorded &&
    closeout.remediationAttemptConsumed === playbookAttemptRecorded &&
    attempt.countsTowardOperationalNoProgress === true &&
    attempt.deferredFailureHandoff === undefined &&
    attempt.deferredFailureHandoffAdmission === undefined
    ? { attempt, courseRef, playbookAttemptRecorded }
    : null;
}

function hasDeferredFailureHandoffShadow(input: {
  incident: {
    courseId: string;
    cycle: number;
    monitoringEvents?: Array<{ audit: Prisma.JsonValue | null }>;
    batchIncidents?: Array<{
      cycle: number;
      batch: { summary: Prisma.JsonValue | null };
    }>;
  };
}) {
  const courseRef = createCourseSupportRemediationCourseRef(
    input.incident.courseId,
  );
  const hasSourceArtifact = (input.incident.batchIncidents ?? [])
    .filter((entry) => entry.cycle === input.incident.cycle)
    .some((entry) => {
      const closeout = asJsonObject(asJsonObject(entry.batch.summary).closeout);
      if (!Array.isArray(closeout.remediationAttempts)) return false;
      return closeout.remediationAttempts.some((rawAttempt) => {
        const attempt = asJsonObject(rawAttempt);
        if (attempt.courseRef !== courseRef) return false;
        return (
          Object.prototype.hasOwnProperty.call(
            attempt,
            "deferredFailureHandoff",
          ) ||
          Object.prototype.hasOwnProperty.call(
            attempt,
            "deferredFailureHandoffAdmission",
          )
        );
      });
    });
  if (hasSourceArtifact) return true;
  return (input.incident.monitoringEvents ?? []).some((event) => {
    const audit = asJsonObject(event.audit);
    const action = audit.action;
    return (
      audit.cycle === input.incident.cycle &&
      (action === "deferred_failure_handoff_legacy_recovery" ||
        action === "deferred_failure_handoff_confirmation_consumed")
    );
  });
}

function readExactConsumedDeferredFailureHandoff(input: {
  incident: Omit<CourseSupportCandidateIncident, "course" | "batchIncidents">;
  course: CourseSupportCandidateIncident["course"];
  batchIncidents: CourseSupportCandidateIncident["batchIncidents"];
}) {
  const currentCycleEntries = (input.batchIncidents ?? []).filter(
    (entry) => entry.cycle === input.incident.cycle,
  );
  let consumedIndex = -1;
  let consumed: NonNullable<ReturnType<typeof readExactDeferredFailureHandoffAttempt>>
    | null = null;
  for (const [index, entry] of currentCycleEntries.entries()) {
    const parsed = readExactDeferredFailureHandoffAttempt({
      summary: entry.batch.summary,
      courseId: input.incident.courseId,
    });
    if (parsed?.sourceKind === "CONSUMED_CARRIER") {
      consumedIndex = index;
      consumed = parsed;
      break;
    }
  }
  const consumedEntry = currentCycleEntries[consumedIndex];
  if (
    !consumed ||
    !consumed.admission ||
    !consumedEntry ||
    !(consumedEntry.createdAt instanceof Date) ||
    consumedEntry.incidentId !== input.incident.id ||
    consumedEntry.courseId !== input.incident.courseId ||
    consumedEntry.batchId !== consumedEntry.batch.id ||
    consumedEntry.batch.completedAt === null ||
    consumedEntry.batch.status !== "RETRYABLE_FAILED" ||
    consumedEntry.result !== "RETRY_SCHEDULED" ||
    (currentCycleEntries[consumedIndex + 1] &&
      (!(currentCycleEntries[consumedIndex + 1].createdAt instanceof Date) ||
        currentCycleEntries[consumedIndex + 1].createdAt.getTime() ===
          consumedEntry.createdAt.getTime()))
  ) {
    return null;
  }
  const courseRef = createCourseSupportRemediationCourseRef(
    input.incident.courseId,
  );
  const newerEntriesAreExactOrdinaryRetries = currentCycleEntries
    .slice(0, consumedIndex)
    .every((entry, index, newerEntries) => {
      const closeout = asJsonObject(asJsonObject(entry.batch.summary).closeout);
      const matchingAttempts = Array.isArray(closeout.remediationAttempts)
        ? closeout.remediationAttempts.filter(
            (rawAttempt) => asJsonObject(rawAttempt).courseRef === courseRef,
          )
        : [];
      const rawAttempt = asJsonObject(matchingAttempts[0]);
      const persistedAttempt =
        readPersistedCourseSupportRemediationAttemptRecord({
          summary: entry.batch.summary,
          courseId: input.incident.courseId,
        });
      const nextEntry = newerEntries[index + 1] ?? consumedEntry;
      return Boolean(
        entry.createdAt instanceof Date &&
          nextEntry.createdAt instanceof Date &&
          entry.createdAt.getTime() > nextEntry.createdAt.getTime() &&
          entry.incidentId === input.incident.id &&
          entry.courseId === input.incident.courseId &&
          entry.batchId === entry.batch.id &&
          entry.batch.completedAt !== null &&
          entry.batch.status === "RETRYABLE_FAILED" &&
          entry.result === "RETRY_SCHEDULED" &&
          matchingAttempts.length === 1 &&
          persistedAttempt?.failureFingerprint ===
            input.incident.failureFingerprint &&
          !Object.prototype.hasOwnProperty.call(
            rawAttempt,
            "deferredFailureHandoff",
          ) &&
          !Object.prototype.hasOwnProperty.call(
            rawAttempt,
            "deferredFailureHandoffAdmission",
          ) &&
          (rawAttempt.failureOnlyHandoffCooldownUntil === null ||
            rawAttempt.failureOnlyHandoffCooldownUntil === undefined)
      );
    });
  if (!newerEntriesAreExactOrdinaryRetries) return null;
  const { signal, admission, attempt } = consumed;
  const effectiveRuntime =
    consumedEntry.batch.releaseSha ?? consumedEntry.batch.baseSha;
  const admittedAt = new Date(admission.admittedAt);
  const request = consumedEntry.verificationRequests[0];
  const proof = asJsonObject(consumedEntry.proofSnapshot);
  const invalidation = asJsonObject(
    attempt.deferredFailureHandoffInvalidation,
  );
  const invalidatedByCurrentState = Boolean(
    signal.state === "CONSUMED" &&
      invalidation.schemaVersion === 1 &&
      invalidation.reason === "MUTABLE_CURRENT_STATE_CHANGED" &&
      invalidation.signalDigest === signal.signalDigest &&
      invalidation.customerDataIncluded === false,
  );
  const providerExecuted =
    !invalidatedByCurrentState && proof.providerExecution === true;
  const effectiveFailureFingerprint = providerExecuted
    ? getEffectiveCourseSupportRetryFailureFingerprint({
        providerFamilyKey: input.incident.providerFamilyKey,
        incidentKind: input.incident.kind,
        incidentFailureClass: input.incident.failureClass,
        incidentFailureFingerprint: input.incident.failureFingerprint,
        proofSnapshot: consumedEntry.proofSnapshot,
      })
    : input.incident.failureFingerprint;
  const requestIsBoundToConfirmationRuntime = Boolean(
    request &&
      request.batchIncidentId === consumedEntry.id &&
      request.releaseSha === effectiveRuntime &&
      (request.runtimeVersion === null ||
        request.runtimeVersion === effectiveRuntime) &&
      request.providerSnapshotFingerprint ===
        signal.claimedProviderSnapshotFingerprint &&
      request.createdAt.getTime() <= request.updatedAt.getTime() &&
      request.updatedAt.getTime() <= consumedEntry.batch.completedAt.getTime(),
  );
  const exactRequestConsumptionState = invalidatedByCurrentState
    ? consumedEntry.verificationRequests.length <= 1 &&
      (signal.confirmationStarted
        ? Boolean(
            request &&
              requestIsBoundToConfirmationRuntime &&
              request.startedAt instanceof Date &&
              request.createdAt.getTime() <= request.startedAt.getTime() &&
              request.startedAt.getTime() <= request.updatedAt.getTime(),
          )
        : !request ||
          (requestIsBoundToConfirmationRuntime &&
            isCourseSupportVerificationRequestUnstarted(request)))
    : consumedEntry.verificationRequests.length === 1 &&
      requestIsBoundToConfirmationRuntime &&
      request?.runtimeVersion === effectiveRuntime &&
      request.startedAt instanceof Date &&
      request.createdAt.getTime() <= request.startedAt.getTime() &&
      request.startedAt.getTime() <= request.updatedAt.getTime();
  const valid = Boolean(
    signal.sourceBatchIncidentDigest ===
      createDeferredFailureHandoffBatchIncidentDigest(consumedEntry.id) &&
      signal.providerFamilyKey === consumedEntry.batch.providerFamilyKey &&
      signal.canonicalFailureFingerprint ===
        consumedEntry.batch.failureFingerprint &&
      signal.claimedProviderSnapshotFingerprint ===
        attempt.providerSnapshotFingerprint &&
      signal.observedProviderSnapshotFingerprint ===
        attempt.observedProviderSnapshotFingerprint &&
      attempt.runtimeVersion === effectiveRuntime &&
      admittedAt.getTime() >= consumedEntry.batch.createdAt.getTime() &&
      admittedAt.getTime() <= consumedEntry.batch.completedAt.getTime() &&
      effectiveFailureFingerprint === input.incident.failureFingerprint &&
      exactRequestConsumptionState
  );
  return valid
    ? { signal, attempt, invalidatedByCurrentState, consumedEntry }
    : null;
}

function readDeferredFailureHandoffCandidate(input: {
  incident: Omit<CourseSupportCandidateIncident, "course" | "batchIncidents">;
  course: CourseSupportCandidateIncident["course"];
  batchIncidents: CourseSupportCandidateIncident["batchIncidents"];
  providerSnapshotFingerprint: string;
  now: Date;
}) {
  const currentCycleEntries = (input.batchIncidents ?? []).filter(
    (entry) => entry.cycle === input.incident.cycle,
  );
  const newest = currentCycleEntries[0];
  if (
    !newest ||
    !(newest.createdAt instanceof Date) ||
    (currentCycleEntries[1] &&
      !(currentCycleEntries[1].createdAt instanceof Date)) ||
    (currentCycleEntries[1] &&
      currentCycleEntries[1].createdAt.getTime() === newest.createdAt.getTime()) ||
    newest.incidentId !== input.incident.id ||
    newest.courseId !== input.incident.courseId ||
    newest.batchId !== newest.batch.id ||
    newest.batch.completedAt === null ||
    newest.batch.createdAt.getTime() > newest.createdAt.getTime() ||
    newest.createdAt.getTime() > newest.updatedAt.getTime() ||
    newest.batch.createdAt.getTime() > newest.batch.completedAt.getTime()
  ) {
    return null;
  }
  const parsedSummary = readExactDeferredFailureHandoffAttempt({
    summary: newest.batch.summary,
    courseId: input.incident.courseId,
  });
  const legacyAttempt = readExactLegacyDeferredFailureHandoffAttempt({
    summary: newest.batch.summary,
    courseId: input.incident.courseId,
  });
  const monitoringEvents = input.incident.monitoringEvents ?? [];
  const legacyMarkers = monitoringEvents.filter(
    (event) => {
      const audit = asJsonObject(event.audit);
      return (
        audit.action === "deferred_failure_handoff_legacy_recovery" &&
        audit.cycle === input.incident.cycle
      );
    },
  );
  let signal: DeferredFailureHandoffSignal;
  let admission: ReturnType<typeof parseDeferredFailureHandoffAdmission>;
  let sourceKind: "SUMMARY" | "LEGACY_RECOVERY";
  if (parsedSummary?.sourceKind === "SUMMARY") {
    if (
      newest.batch.status !== "RETRYABLE_FAILED" ||
      newest.result !== "RETRY_SCHEDULED" ||
      newest.updatedAt.getTime() > newest.batch.completedAt.getTime()
    ) {
      return null;
    }
    ({ signal, admission } = parsedSummary);
    sourceKind = "SUMMARY";
    if (
      legacyMarkers.some(
        (event) =>
          event.occurredAt.getTime() >= newest.batch.createdAt.getTime(),
      )
    ) {
      return null;
    }
  } else {
    if (
      newest.batch.status !== "PARTIAL" ||
      newest.result !== "NEEDS_HUMAN"
    ) {
      return null;
    }
    const marker = legacyMarkers[0];
    const markerAudit = asJsonObject(marker?.audit);
    const markerSignal = parseDeferredFailureHandoffSignal(
      markerAudit.deferredFailureHandoff,
    );
    if (
      !legacyAttempt ||
      legacyMarkers.length !== 1 ||
      !marker ||
      !markerSignal ||
      marker.failureFingerprint !== input.incident.failureFingerprint ||
      markerAudit.schemaVersion !== 1 ||
      markerAudit.cycle !== input.incident.cycle ||
      markerAudit.sourceBatchIncidentDigest !==
        markerSignal.sourceBatchIncidentDigest ||
      markerAudit.sourceProofDigest !== markerSignal.sourceProofDigest ||
      markerAudit.sourceResult !== "NEEDS_HUMAN" ||
      markerAudit.sourceBatchStatus !== "PARTIAL" ||
      markerAudit.sourceDerivedOutcome !== "needs_human" ||
      markerSignal.sourceResult !== "NEEDS_HUMAN" ||
      markerAudit.sourceVerificationWatchMode !== "WATCH_SETTLED" ||
      markerAudit.sourceAttemptConsumed !== true ||
      markerAudit.sameCycleRecovery !== true ||
      markerAudit.oneShotPerEvidenceSnapshot !== true ||
      markerAudit.preservesCanonicalFailureFingerprint !== true ||
      markerAudit.customerDataIncluded !== false ||
      marker.occurredAt.getTime() < newest.batch.completedAt.getTime() ||
      marker.occurredAt.getTime() > input.now.getTime() ||
      newest.batch.completedAt.getTime() > newest.batch.updatedAt.getTime() ||
      newest.batch.updatedAt.getTime() > marker.occurredAt.getTime() ||
      newest.updatedAt.getTime() > marker.occurredAt.getTime() ||
      markerSignal.eligibleAt !== marker.occurredAt.toISOString() ||
      monitoringEvents[0]?.id !== marker.id ||
      monitoringEvents.some(
        (event) =>
          event.id !== marker.id &&
          event.occurredAt.getTime() >= marker.occurredAt.getTime(),
      )
    ) {
      return null;
    }
    const legacyAttemptRecord = legacyAttempt.attempt;
    const expectedLegacySourceRecordDigest =
      createDeferredFailureHandoffLegacySourceRecordDigest({
        sourceBatchIncidentDigest: markerSignal.sourceBatchIncidentDigest,
        sourceProofDigest: markerSignal.sourceProofDigest,
        courseRef: legacyAttempt.courseRef,
        providerFamilyKey: markerSignal.providerFamilyKey,
        canonicalFailureFingerprint:
          markerSignal.canonicalFailureFingerprint,
        observedFailureFingerprint: markerSignal.observedFailureFingerprint,
        providerSnapshotFingerprint:
          markerSignal.claimedProviderSnapshotFingerprint,
        runtimeVersion: markerSignal.runtimeVersion,
        cooldownExpiresAt: markerSignal.cooldownExpiresAt,
        providerNotBeforeAt: markerSignal.providerNotBeforeAt,
        sourceVerificationWatchMode: "WATCH_SETTLED",
        sourceResult: "NEEDS_HUMAN",
        sourceBatchStatus: "PARTIAL",
        sourceDerivedOutcome: "needs_human",
        sourceAttemptConsumed: true,
      });
    if (
      markerAudit.legacySourceRecordDigest !==
        expectedLegacySourceRecordDigest ||
      legacyAttemptRecord.failureFingerprint !==
        markerSignal.canonicalFailureFingerprint ||
      legacyAttemptRecord.observedFailureFingerprint !==
        markerSignal.observedFailureFingerprint ||
      legacyAttemptRecord.providerSnapshotFingerprint !==
        markerSignal.claimedProviderSnapshotFingerprint ||
      legacyAttemptRecord.observedProviderSnapshotFingerprint !==
        markerSignal.observedProviderSnapshotFingerprint ||
      legacyAttemptRecord.runtimeVersion !== markerSignal.runtimeVersion ||
      legacyAttemptRecord.failureOnlyHandoffCooldownUntil !==
        markerSignal.cooldownExpiresAt
    ) {
      return null;
    }
    signal = markerSignal;
    admission = null;
    sourceKind = "LEGACY_RECOVERY";
  }
  const sourceProof = asJsonObject(newest.proofSnapshot);
  const proofObservedAt =
    typeof sourceProof.observedAt === "string"
      ? new Date(sourceProof.observedAt)
      : null;
  const proofNextAttemptAt =
    sourceProof.nextAttemptAt === null ||
    typeof sourceProof.nextAttemptAt === "string"
      ? (sourceProof.nextAttemptAt as string | null)
      : undefined;
  const proofProviderNotBeforeAt =
    sourceProof.providerRetryNotBeforeAt === null ||
    typeof sourceProof.providerRetryNotBeforeAt === "string"
      ? (sourceProof.providerRetryNotBeforeAt as string | null)
      : undefined;
  const proofRuntimeVersion = sourceProof.runtimeVersion;
  const proofProviderSnapshotFingerprint =
    sourceProof.providerSnapshotFingerprint;
  const proofFailureClass = sourceProof.failureClass;
  const proofStatus = sourceProof.status;
  const proofOutcome = sourceProof.outcome;
  const proofCompletedAt =
    sourceProof.completedAt === null ||
    typeof sourceProof.completedAt === "string"
      ? (sourceProof.completedAt as string | null)
      : undefined;
  const proofTimestampsAreCanonical = [
    proofNextAttemptAt,
    proofProviderNotBeforeAt,
    proofCompletedAt,
  ].every((value) => {
    if (value === null) return true;
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
  const exactUnstartedCarrier = Boolean(admission);
  const effectiveSourceRuntime =
    newest.batch.releaseSha ?? newest.batch.baseSha;
  const currentRuntimeRequests = newest.verificationRequests.filter(
    (request) => request.releaseSha === effectiveSourceRuntime,
  );
  const sourceRequest = currentRuntimeRequests[0];
  const sourceRequestEvidence = asJsonObject(sourceRequest?.evidence);
  const sourceTemporalCeiling =
    sourceKind === "LEGACY_RECOVERY"
      ? legacyMarkers[0]!.occurredAt
      : newest.batch.completedAt;
  const requestRowsAreTemporallyBounded = newest.verificationRequests.every(
    (request) =>
      request.batchIncidentId === newest.id &&
      request.createdAt.getTime() <= request.updatedAt.getTime() &&
      request.updatedAt.getTime() <= sourceTemporalCeiling!.getTime(),
  );
  const exactUnstartedCarrierRequest = Boolean(
    exactUnstartedCarrier &&
      parsedSummary?.attempt.runtimeVersion === effectiveSourceRuntime &&
      requestRowsAreTemporallyBounded &&
      (newest.verificationRequests.length === 0 ||
        (newest.verificationRequests.length === 1 &&
          currentRuntimeRequests.length === 1 &&
          sourceRequest &&
          sourceRequest.createdAt.getTime() >= newest.createdAt.getTime() &&
          sourceRequest.providerSnapshotFingerprint ===
            input.providerSnapshotFingerprint &&
          (sourceRequest.runtimeVersion === null ||
            sourceRequest.runtimeVersion === effectiveSourceRuntime) &&
          ["QUEUED", "CHECKING", "RETRYABLE_FAILED", "STALE"].includes(
            sourceRequest.status,
          ) &&
          sourceRequest.attemptCount >= 0 &&
          isCourseSupportVerificationRequestUnstarted(sourceRequest))),
  );
  const evidenceProviderNotBeforeAt =
    sourceRequestEvidence.providerRetryNotBeforeAt === undefined
      ? null
      : typeof sourceRequestEvidence.providerRetryNotBeforeAt === "string"
        ? sourceRequestEvidence.providerRetryNotBeforeAt
        : undefined;
  const exactLegacyClosedRequest = Boolean(
    sourceKind === "LEGACY_RECOVERY" &&
      sourceRequest &&
      proofStatus === "RETRYABLE_FAILED" &&
      sourceRequest.status === "STALE" &&
      sourceRequest.nextAttemptAt === null &&
      sourceRequest.completedAt?.getTime() ===
        newest.batch.completedAt!.getTime() &&
      sourceRequest.updatedAt.getTime() ===
        newest.batch.completedAt!.getTime() &&
      sourceRequest.lastError === "batch_closed",
  );
  const exactUntransformedSettledRequest = Boolean(
    sourceRequest &&
      sourceRequest.status === proofStatus &&
      (sourceRequest.nextAttemptAt?.toISOString() ?? null) ===
        proofNextAttemptAt &&
      (sourceRequest.completedAt?.toISOString() ?? null) === proofCompletedAt,
  );
  const exactSettledSourceRequest = Boolean(
    !exactUnstartedCarrier &&
      currentRuntimeRequests.length === 1 &&
      sourceRequest &&
      requestRowsAreTemporallyBounded &&
      sourceRequest.createdAt.getTime() >= newest.createdAt.getTime() &&
      sourceRequest.runtimeVersion === effectiveSourceRuntime &&
      (exactLegacyClosedRequest || exactUntransformedSettledRequest) &&
      sourceRequest.outcome === proofOutcome &&
      sourceRequest.failureClass === proofFailureClass &&
      sourceRequest.providerSnapshotFingerprint ===
        input.providerSnapshotFingerprint &&
      sourceRequest.startedAt instanceof Date &&
      sourceRequest.createdAt.getTime() <= sourceRequest.startedAt.getTime() &&
      proofObservedAt &&
      sourceRequest.startedAt.getTime() <= proofObservedAt.getTime() &&
      sourceRequest.startedAt.getTime() <= sourceRequest.updatedAt.getTime() &&
      sourceRequestEvidence.schemaVersion === 1 &&
      sourceRequestEvidence.kind === "PROVIDER_VERIFICATION" &&
      sourceRequestEvidence.releaseSha === effectiveSourceRuntime &&
      sourceRequestEvidence.runtimeVersion === effectiveSourceRuntime &&
      sourceRequestEvidence.observedAt === sourceProof.observedAt &&
      sourceRequestEvidence.outcome === proofOutcome &&
      sourceRequestEvidence.failureClass === proofFailureClass &&
      sourceRequestEvidence.providerExecution ===
        sourceProof.providerExecution &&
      sourceRequestEvidence.providerFamilyKey === signal.providerFamilyKey &&
      sourceRequestEvidence.providerSnapshotFingerprint ===
        input.providerSnapshotFingerprint &&
      evidenceProviderNotBeforeAt !== undefined &&
      evidenceProviderNotBeforeAt === proofProviderNotBeforeAt,
  );
  const sourceProofIsValid = Boolean(
    !exactUnstartedCarrier &&
      proofObservedAt &&
      Number.isFinite(proofObservedAt.getTime()) &&
      proofObservedAt.toISOString() === sourceProof.observedAt &&
      proofObservedAt.getTime() <= newest.batch.completedAt.getTime() &&
      proofTimestampsAreCanonical &&
      sourceProof.kind === "PROVIDER_VERIFICATION_FAILURE" &&
      (proofStatus === "RETRYABLE_FAILED" || proofStatus === "STALE") &&
      typeof proofFailureClass === "string" &&
      COURSE_SUPPORT_FAILURE_CLASSES.has(
        proofFailureClass as CourseSupportFailureClass,
      ) &&
      sourceProof.providerExecution === false &&
      typeof proofRuntimeVersion === "string" &&
      proofRuntimeVersion === signal.runtimeVersion &&
      typeof proofProviderSnapshotFingerprint === "string" &&
      proofProviderSnapshotFingerprint === input.providerSnapshotFingerprint &&
      proofNextAttemptAt !== undefined &&
      proofProviderNotBeforeAt !== undefined &&
      proofCompletedAt !== undefined &&
      proofOutcome === "FETCH_FAILED" &&
      exactSettledSourceRequest &&
      createDeferredFailureHandoffSourceProofDigest({
        kind: "PROVIDER_VERIFICATION_FAILURE",
        status: proofStatus as string,
        outcome: "FETCH_FAILED",
        failureClass: proofFailureClass as string,
        observedAt: sourceProof.observedAt as string,
        runtimeVersion: proofRuntimeVersion as string,
        providerExecution: sourceProof.providerExecution as boolean,
        providerSnapshotFingerprint:
          proofProviderSnapshotFingerprint as string,
        completedAt: proofCompletedAt,
        nextAttemptAt: proofNextAttemptAt,
        providerRetryNotBeforeAt: proofProviderNotBeforeAt,
      }) === signal.sourceProofDigest &&
      signal.providerNotBeforeAt ===
        (getDetachedFailureRetryNotBefore({
          proofSnapshot: newest.proofSnapshot,
          releaseSha: newest.batch.releaseSha,
          now: newest.batch.completedAt,
        })?.toISOString() ?? null) &&
      getEffectiveCourseSupportRetryFailureFingerprint({
        providerFamilyKey: input.incident.providerFamilyKey,
        incidentKind: input.incident.kind,
        incidentFailureClass: input.incident.failureClass,
        incidentFailureFingerprint: input.incident.failureFingerprint,
        proofSnapshot: newest.proofSnapshot,
      }) === signal.observedFailureFingerprint,
  );
  if (
    signal.state !== "AVAILABLE" ||
    signal.confirmationStarted ||
    signal.sourceBatchIncidentDigest !==
      createDeferredFailureHandoffBatchIncidentDigest(newest.id) ||
    signal.providerFamilyKey !== input.incident.providerFamilyKey ||
    signal.canonicalFailureFingerprint !==
      input.incident.failureFingerprint ||
    signal.claimedProviderSnapshotFingerprint !==
      input.providerSnapshotFingerprint ||
    signal.observedProviderSnapshotFingerprint !==
      input.providerSnapshotFingerprint ||
    newest.batch.providerFamilyKey !== input.incident.providerFamilyKey ||
    newest.batch.failureFingerprint !== input.incident.failureFingerprint ||
    (!exactUnstartedCarrier &&
      signal.runtimeVersion !== effectiveSourceRuntime) ||
    (!exactUnstartedCarrier && !sourceProofIsValid) ||
    (exactUnstartedCarrier &&
      (newest.proofSnapshot !== null || !exactUnstartedCarrierRequest)) ||
    signal.observedFailureFingerprint === input.incident.failureFingerprint ||
    input.course.monitoringStatus?.state !== "AUTO_INVESTIGATING" ||
    !input.course.monitoringStatus.failureFingerprint ||
    !courseSupportFailureFingerprintsMatch(
      input.course.monitoringStatus.failureFingerprint,
      input.incident.failureFingerprint,
    ) ||
    new Date(signal.eligibleAt).getTime() > input.now.getTime() ||
    input.incident.nextAttemptAt?.getTime() !==
      new Date(signal.eligibleAt).getTime()
  ) {
    return null;
  }
  const newestProbe = input.course.probes?.[0];
  const secondNewestProbe = input.course.probes?.[1];
  const factualProbeFloor = exactUnstartedCarrier
    ? newest.batch.createdAt
    : proofObservedAt!;
  if (
    (newestProbe &&
      secondNewestProbe &&
      newestProbe.observedAt.getTime() ===
        secondNewestProbe.observedAt.getTime()) ||
    (newestProbe &&
      SUCCESSFUL_PROBE_OUTCOMES.has(newestProbe.outcome) &&
      newestProbe.observedAt.getTime() >= factualProbeFloor.getTime())
  ) {
    return null;
  }
  if (
    admission &&
    (admission.signalDigest !== signal.signalDigest ||
      new Date(admission.admittedAt).getTime() <
        newest.batch.createdAt.getTime() ||
      new Date(admission.admittedAt).getTime() >
        newest.batch.completedAt.getTime() ||
      newest.verificationRequests.some((request) => request.startedAt !== null))
  ) {
    return null;
  }
  const newerContradictoryMarker = monitoringEvents.some(
    (event) => {
      const audit = asJsonObject(event.audit);
      if (audit.cycle !== input.incident.cycle) return false;
      return (
        audit.action === "deferred_failure_handoff_confirmation_consumed" ||
        (sourceKind === "SUMMARY" &&
          event.occurredAt.getTime() > newest.batch.completedAt!.getTime() &&
          audit.action === "deferred_failure_handoff_legacy_recovery")
      );
    },
  );
  if (newerContradictoryMarker) return null;
  return {
    signal,
    sourceBatchIncidentId: newest.id,
    sourceBatchId: newest.batch.id,
    expectedIncidentRevision: input.incident.revision,
    expectedMonitoringRevision: input.course.monitoringStatus.revision,
    expectedMonitoringStateChangedAt:
      input.course.monitoringStatus.stateChangedAt,
  };
}

function getSourceCompleteFinalizationCampaignProvenance(input: {
  summary: unknown;
  courseId: string;
  cycle: number;
  monitoringEvents: readonly { audit: unknown }[];
}) {
  const summary = asJsonObject(input.summary);
  const campaign = asJsonObject(summary.campaign);
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const summaryAttempts = Array.isArray(campaign.attempts)
    ? campaign.attempts
        .map((value) => asJsonObject(value))
        .filter(
          (attempt) =>
            attempt.courseRef === courseRef && attempt.cycle === input.cycle,
        )
    : [];
  const summaryProvenance =
    campaign.kind === "PARKED_COHORT" && summaryAttempts.length === 1
      ? readSourceCompleteFinalizationCampaignRecord(summaryAttempts[0])
      : null;
  if (
    Object.prototype.hasOwnProperty.call(summary, "campaign") &&
    !summaryProvenance
  ) {
    return { valid: false as const, provenance: null };
  }

  const admissionProvenances: SourceCompleteFinalizationCampaignProvenance[] = [];
  for (const event of input.monitoringEvents) {
    const audit = asJsonObject(event.audit);
    if (
      audit.action !== "parked_cohort_admission" ||
      audit.cycle !== input.cycle
    ) {
      continue;
    }
    const provenance = readSourceCompleteFinalizationCampaignRecord({
      runId: audit.campaignRunId,
      membershipDigest: audit.campaignMembershipDigest,
    });
    if (!provenance) {
      return { valid: false as const, provenance: null };
    }
    admissionProvenances.push(provenance);
  }
  const distinctAdmissionProvenances = [
    ...new Map(
      admissionProvenances.map((provenance) => [
        `${provenance.runId}\u0000${provenance.membershipDigest}`,
        provenance,
      ]),
    ).values(),
  ];
  if (distinctAdmissionProvenances.length > 1) {
    return { valid: false as const, provenance: null };
  }
  const admissionProvenance = distinctAdmissionProvenances[0] ?? null;
  if (
    summaryProvenance &&
    admissionProvenance &&
    (summaryProvenance.runId !== admissionProvenance.runId ||
      summaryProvenance.membershipDigest !==
        admissionProvenance.membershipDigest)
  ) {
    return { valid: false as const, provenance: null };
  }
  return {
    valid: true as const,
    provenance: summaryProvenance ?? admissionProvenance,
  };
}

function readSourceCompleteFinalizationCampaignRecord(input: {
  runId?: unknown;
  membershipDigest?: unknown;
}): SourceCompleteFinalizationCampaignProvenance | null {
  return typeof input.runId === "string" &&
    input.runId.trim() &&
    typeof input.membershipDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(input.membershipDigest)
    ? {
        runId: input.runId,
        membershipDigest: input.membershipDigest,
      }
    : null;
}

function buildSourceCompleteFinalizationRecoveryRoute(
  waitingRoute: CourseSupportRemediationRoute,
): CourseSupportRemediationRoute {
  return {
    ...waitingRoute,
    workMode: "COMPLETE_CLASSIFICATION",
    resumeWorkMode: "COMPLETE_CLASSIFICATION",
    allowUnchangedRuntime: true,
    requiresImplementationPath: false,
    retryBudget: null,
    reason: "CLASSIFICATION_READY",
    materialChangeDetected: false,
    attemptSignature: {
      workMode: "COMPLETE_CLASSIFICATION",
      strategyAction: waitingRoute.strategy.action,
      playbookStage: null,
    },
  };
}

function getSourceCompleteFinalizationRecovery(input: {
  incident: Omit<CourseSupportCandidateIncident, "course" | "batchIncidents">;
  course: CourseSupportCandidateIncident["course"];
  currentCycleBatchIncidents: CourseSupportCandidateIncident["batchIncidents"];
  providerSnapshotFingerprint: string;
  routedRemediation: CourseSupportRemediationRoute;
  now: Date;
}): SourceCompleteFinalizationRecovery | null {
  const { incident, course, routedRemediation } = input;
  const monitoringStatus = course.monitoringStatus;
  const sourceEntry = input.currentCycleBatchIncidents[0];
  const latestDiscovery = course.automationDiscoveries?.[0] ?? null;
  if (
    !sourceEntry ||
    sourceEntry.cycle !== incident.cycle ||
    sourceEntry.incidentId !== incident.id ||
    sourceEntry.courseId !== incident.courseId ||
    sourceEntry.result !== "RETRY_SCHEDULED" ||
    !sourceEntry.verifiedAt ||
    !sourceEntry.verifiedIncidentUpdatedAt ||
    sourceEntry.verifiedIncidentUpdatedAt.getTime() >
      sourceEntry.verifiedAt.getTime() ||
    sourceEntry.updatedAt.getTime() < sourceEntry.verifiedAt.getTime() ||
    sourceEntry.batch.status !== "RETRYABLE_FAILED" ||
    !sourceEntry.batch.completedAt ||
    sourceEntry.batch.completedAt.getTime() < sourceEntry.updatedAt.getTime() ||
    sourceEntry.batch.providerFamilyKey !== incident.providerFamilyKey ||
    sourceEntry.batch.failureFingerprint !== incident.failureFingerprint ||
    !sourceEntry.batch.releaseSha ||
    !/^[a-f0-9]{40}$/u.test(sourceEntry.batch.releaseSha) ||
    !sourceEntry.batch.deployedAt ||
    sourceEntry.batch.deployedAt.getTime() > sourceEntry.verifiedAt.getTime() ||
    Object.prototype.hasOwnProperty.call(
      asJsonObject(sourceEntry.batch.summary),
      "sourceCompleteFinalizationRecovery",
    ) ||
    routedRemediation.workMode !== "WAIT_FOR_MATERIAL_CHANGE" ||
    routedRemediation.reason !== "PLAYBOOK_EXHAUSTED" ||
    routedRemediation.materialChangeDetected ||
    incident.activeBatchId !== null ||
    !monitoringStatus ||
    (latestDiscovery &&
      latestDiscovery.createdAt.getTime() >= sourceEntry.verifiedAt.getTime())
  ) {
    return null;
  }
  const closeout = asJsonObject(
    asJsonObject(sourceEntry.batch.summary).closeout,
  );
  if (
    closeout.outcome !== "retryable_failed" ||
    closeout.derivedOutcome !== "retryable_failed" ||
    typeof closeout.retryCount !== "number" ||
    !Number.isInteger(closeout.retryCount) ||
    closeout.retryCount < 1
  ) {
    return null;
  }
  const persistedAttempt = readPersistedCourseSupportRemediationAttempt({
    summary: sourceEntry.batch.summary,
    courseId: incident.courseId,
  });
  if (
    !persistedAttempt ||
    persistedAttempt.providerSnapshotFingerprint !==
      input.providerSnapshotFingerprint ||
    persistedAttempt.failureFingerprint !== incident.failureFingerprint ||
    persistedAttempt.runtimeVersion !== sourceEntry.batch.baseSha ||
    !hasFreshCompleteSourceUnverifiedEvidence({
      providerFamilyKey: incident.providerFamilyKey,
      failureClass: incident.failureClass,
      course,
      freshCycleStartedAt: incident.confirmedAt,
      attemptLedger: incident.attemptLedger,
      cycle: incident.cycle,
      verifiedAt: sourceEntry.verifiedAt,
      result: sourceEntry.result,
    })
  ) {
    return null;
  }

  const dueAutomatic =
    incident.status === "AUTO_INVESTIGATING" &&
    incident.humanReviewReason === null &&
    (incident.nextAttemptAt === null ||
      incident.nextAttemptAt.getTime() <= input.now.getTime()) &&
    monitoringStatus.state === "AUTO_INVESTIGATING" &&
    (monitoringStatus.nextAutomaticAttemptAt === null ||
      monitoringStatus.nextAutomaticAttemptAt.getTime() <= input.now.getTime()) &&
    monitoringStatus.revalidationRequestedAt === null;
  const parkedByOldCloseout =
    incident.status === "NEEDS_HUMAN" &&
    incident.humanReviewReason === "AUTOMATION_STALLED" &&
    incident.nextAttemptAt === null &&
    monitoringStatus.state === "ENGINEERING_VERIFICATION_NEEDED" &&
    monitoringStatus.nextAutomaticAttemptAt === null &&
    monitoringStatus.revalidationRequestedAt === null;
  if (
    !monitoringStatus.failureFingerprint ||
    !courseSupportFailureFingerprintsMatch(
      monitoringStatus.failureFingerprint,
      incident.failureFingerprint,
    ) ||
    (!dueAutomatic && !parkedByOldCloseout)
  ) {
    return null;
  }

  const campaign = getSourceCompleteFinalizationCampaignProvenance({
    summary: sourceEntry.batch.summary,
    courseId: incident.courseId,
    cycle: incident.cycle,
    monitoringEvents: incident.monitoringEvents,
  });
  if (!campaign.valid) {
    return null;
  }
  const evidenceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        sourceBatchId: sourceEntry.batch.id,
        sourceBatchIncidentId: sourceEntry.id,
        sourceBatchStatus: sourceEntry.batch.status,
        sourceBatchProviderFamilyKey: sourceEntry.batch.providerFamilyKey,
        sourceBatchFailureFingerprint: sourceEntry.batch.failureFingerprint,
        sourceBatchBaseSha: sourceEntry.batch.baseSha,
        sourceBatchReleaseSha: sourceEntry.batch.releaseSha,
        sourceBatchDeployedAt: sourceEntry.batch.deployedAt.toISOString(),
        sourceBatchCompletedAt: sourceEntry.batch.completedAt.toISOString(),
        sourceBatchRevision: sourceEntry.batch.revision,
        sourceBatchUpdatedAt: sourceEntry.batch.updatedAt.toISOString(),
        sourceEntryResult: sourceEntry.result,
        sourceEntryVerifiedAt: sourceEntry.verifiedAt.toISOString(),
        sourceEntryVerifiedIncidentUpdatedAt:
          sourceEntry.verifiedIncidentUpdatedAt.toISOString(),
        sourceEntryCreatedAt: sourceEntry.createdAt.toISOString(),
        sourceEntryUpdatedAt: sourceEntry.updatedAt.toISOString(),
        incidentId: incident.id,
        courseId: incident.courseId,
        cycle: incident.cycle,
        incidentStatus: incident.status,
        incidentRevision: incident.revision,
        incidentUpdatedAt: incident.updatedAt.toISOString(),
        providerFamilyKey: incident.providerFamilyKey,
        failureFingerprint: incident.failureFingerprint,
        providerSnapshotFingerprint: input.providerSnapshotFingerprint,
        monitoringState: monitoringStatus.state,
        monitoringRevision: monitoringStatus.revision,
        monitoringStateChangedAt: monitoringStatus.stateChangedAt.toISOString(),
        monitoringFailureFingerprint: monitoringStatus.failureFingerprint,
        latestDiscoveryId: latestDiscovery?.id ?? null,
        latestDiscoveryCreatedAt:
          latestDiscovery?.createdAt.toISOString() ?? null,
        campaign: campaign.provenance,
      }),
    )
    .digest("hex");
  return {
    evidenceDigest,
    sourceBatchId: sourceEntry.batch.id,
    sourceBatchIncidentId: sourceEntry.id,
    priorIncidentStatus: dueAutomatic
      ? "AUTO_INVESTIGATING"
      : "NEEDS_HUMAN",
    priorHumanReviewReason: incident.humanReviewReason,
    expectedMonitoringState: monitoringStatus.state,
    expectedMonitoringRevision: monitoringStatus.revision,
    expectedMonitoringStateChangedAt: monitoringStatus.stateChangedAt,
    expectedLatestDiscoveryId: latestDiscovery?.id ?? null,
    expectedLatestDiscoveryCreatedAt: latestDiscovery?.createdAt ?? null,
    campaign: campaign.provenance,
  };
}

function assertBoundedCourseSupportCandidateQueue<T>(rows: readonly T[]) {
  if (rows.length > COURSE_SUPPORT_CANDIDATE_QUEUE_READ_LIMIT) {
    throw new Error(
      "The course-support candidate queue exceeds the bounded read limit.",
    );
  }
}

async function assertBoundedCourseSupportCandidateCurrentCycleHistory(
  client: Pick<Prisma.TransactionClient, "courseMonitoringEvent">,
  incidents: readonly CourseSupportCandidateIncident[],
) {
  if (incidents.length === 0) return;
  const maximumAllowedEvents =
    COURSE_SUPPORT_CANDIDATE_CURRENT_CYCLE_EVENT_READ_LIMIT * incidents.length;
  const events = await client.courseMonitoringEvent.findMany({
    where: {
      eventType: "REVALIDATION_REQUESTED",
      OR: incidents.map((incident) => ({
        incidentId: incident.id,
        audit: { path: ["cycle"], equals: incident.cycle },
      })),
    },
    orderBy: [{ incidentId: "asc" }, { occurredAt: "desc" }, { id: "desc" }],
    take: maximumAllowedEvents + 1,
    select: { id: true, incidentId: true, occurredAt: true },
  });
  if (events.length > maximumAllowedEvents) {
    throw new Error(
      "Course-support candidate history exceeds the bounded read limit.",
    );
  }
  const incidentById = new Map(
    incidents.map((incident) => [incident.id, incident]),
  );
  const eventCountByIncidentId = new Map<string, number>();
  for (const event of events) {
    const incident = event.incidentId
      ? incidentById.get(event.incidentId)
      : undefined;
    if (
      !incident ||
      event.occurredAt.getTime() <
        (incident.confirmedAt ?? incident.firstSeenAt).getTime()
    ) {
      throw new Error(
        "Course-support candidate history exceeds the bounded read limit.",
      );
    }
    const eventCount = (eventCountByIncidentId.get(incident.id) ?? 0) + 1;
    if (
      eventCount > COURSE_SUPPORT_CANDIDATE_CURRENT_CYCLE_EVENT_READ_LIMIT
    ) {
      throw new Error(
        "Course-support candidate history exceeds the bounded read limit.",
      );
    }
    eventCountByIncidentId.set(incident.id, eventCount);
  }
}

function assertBoundedCourseSupportCandidateHistory(
  incidents: readonly CourseSupportCandidateIncident[],
) {
  if (
    incidents.some(
      (incident) =>
        (incident.batchIncidents?.length ?? 0) >
          COURSE_SUPPORT_CANDIDATE_BATCH_HISTORY_READ_LIMIT ||
        (incident.batchIncidents ?? []).some(
          (entry) =>
            (entry.verificationRequests?.length ?? 0) >
            COURSE_SUPPORT_CANDIDATE_REQUEST_HISTORY_READ_LIMIT,
        ),
    )
  ) {
    throw new Error(
      "Course-support candidate history exceeds the bounded read limit.",
    );
  }
}

function buildCourseSupportCandidates(
  incidents: readonly CourseSupportCandidateIncident[],
  now: Date,
): CourseSupportClaimCandidate[] {
  assertBoundedCourseSupportCandidateHistory(incidents);
  return incidents.flatMap(({ course, batchIncidents, ...incident }) => {
    const currentDemand = deriveCourseSupportCurrentDemand(course.preferences, {
      timeZone: course.timeZone,
      now,
    });
    if (
      !isResponderSelectionEligible({
        confirmedAt: incident.confirmedAt,
        attemptLedger: incident.attemptLedger,
        cycle: incident.cycle,
        engineeringOnly: incident.engineeringOnly,
        activeRealSearchCount: currentDemand.activeRealSearchCount,
      })
    ) {
      return [];
    }
    const playbookAssessment = assessAutomationPlaybook(
      incident.attemptLedger,
      incident.cycle,
    );
    const providerSnapshotFingerprint =
      buildCourseSupportProviderSnapshotFingerprint(course);
    const trustedBookingUrl =
      selectProviderContractTrustedBookingLandingUrl(
        course.detectedBookingUrl,
        incident.providerFamilyKey
      );
    const trustedOfficialUrl =
      trustedBookingUrl ??
      selectProviderContractTrustedLandingUrl([course.website]);
    const currentProviderContractEvidence =
      playbookAssessment.nextStage === "BROWSER_ADAPTER_RETRY"
        ? selectCurrentBrowserProviderContractEvidence({
            discoveries: course.automationDiscoveries,
            incidentCycle: incident.cycle,
            incidentFirstSeenAt: incident.firstSeenAt,
            providerFamilyKey: incident.providerFamilyKey,
            providerSnapshotFingerprint,
            officialUrl: trustedOfficialUrl,
            bookingUrl: trustedBookingUrl
          })?.marker ?? null
        : null;
    const deferredFailureHandoff = readDeferredFailureHandoffCandidate({
      incident,
      course,
      batchIncidents,
      providerSnapshotFingerprint,
      now,
    });
    const exactConsumedDeferredFailureHandoff =
      readExactConsumedDeferredFailureHandoff({
        incident,
        course,
        batchIncidents,
      });
    if (
      !deferredFailureHandoff &&
      !exactConsumedDeferredFailureHandoff &&
      hasDeferredFailureHandoffShadow({
        incident: { ...incident, batchIncidents },
      })
    ) {
      return [];
    }
    const currentCycleBatchIncidents = (batchIncidents ?? []).filter(
      (entry) => entry.cycle === incident.cycle,
    );
    const consumedAttempts = currentCycleBatchIncidents.flatMap((entry) => {
      if (
        !didCourseSupportCloseoutConsumeRemediationAttempt({
          summary: entry.batch.summary,
          courseId: incident.courseId,
        })
      ) {
        return [];
      }
      const attempt = readPersistedCourseSupportRemediationAttempt({
        summary: entry.batch.summary,
        courseId: incident.courseId,
      });
      return attempt ? [attempt] : [];
    });
    const currentEpisodeAttempts: PersistedCourseSupportRemediationAttempt[] =
      [];
    for (const attempt of consumedAttempts) {
      if (
        attempt.providerSnapshotFingerprint !== providerSnapshotFingerprint ||
        attempt.failureFingerprint !== incident.failureFingerprint
      ) {
        break;
      }
      currentEpisodeAttempts.push(attempt);
    }
    const priorAttempt = currentEpisodeAttempts[0] ?? consumedAttempts[0];
    const routingAttemptCount =
      currentCycleBatchIncidents.length > 0
        ? currentEpisodeAttempts.length
        : incident.cycle > 1
          ? 0
          : incident.attemptCount;
    const routedRemediation = routeCourseSupportRemediation({
      isPublic: course.isPublic,
      detectedPlatform: course.detectedPlatform,
      // Route from the current course projection when it exists. The incident
      // family is historical grouping evidence and may intentionally differ
      // after a provider/source change; feeding it back into strategy selection
      // can skip the ordered discovery stages for a current SOURCE_MISSING or
      // SOURCE_CONFLICT course.
      providerFamilyKey:
        course.providerFamilyKey?.trim() || incident.providerFamilyKey,
      detectedBookingUrl: course.detectedBookingUrl,
      website: course.website,
      bookingMetadata: course.bookingMetadata,
      bookingMethod: course.bookingMethod,
      automationEligibility: course.automationEligibility,
      automationReason: course.automationReason,
      intelligenceVerifiedAt: course.intelligenceVerifiedAt,
      intelligenceReviewAt: course.intelligenceReviewAt,
      intelligenceConfidence: course.intelligenceConfidence,
      failureClass: incident.failureClass,
      discoveryAttempt: playbookAssessment.completedStages.includes(
        "OFFICIAL_HTTP_DISCOVERY",
      )
        ? "HTTP_INCONCLUSIVE"
        : "NONE",
      attemptCount: routingAttemptCount,
      playbookAssessment,
      priorUnchangedAttempt: priorAttempt?.approach ?? null,
      providerContractEvidenceAvailable:
        currentProviderContractEvidence !== null,
      materialChanges: deferredFailureHandoff
        ? {
            providerSnapshotChanged: false,
            failureFingerprintChanged: true,
            relevantRuntimeChanged: false,
            readerCapabilityChanged: false,
          }
        : exactConsumedDeferredFailureHandoff?.invalidatedByCurrentState
          ? {
              providerSnapshotChanged:
                exactConsumedDeferredFailureHandoff.signal
                  .claimedProviderSnapshotFingerprint !==
                providerSnapshotFingerprint,
              failureFingerprintChanged:
                exactConsumedDeferredFailureHandoff.signal
                  .canonicalFailureFingerprint !==
                  incident.failureFingerprint ||
                (course.monitoringStatus?.failureFingerprint !== null &&
                  course.monitoringStatus?.failureFingerprint !== undefined &&
                  !courseSupportFailureFingerprintsMatch(
                    course.monitoringStatus.failureFingerprint,
                    exactConsumedDeferredFailureHandoff.signal
                      .canonicalFailureFingerprint,
                  )),
              relevantRuntimeChanged: false,
              readerCapabilityChanged: false,
            }
        : priorAttempt
        ? {
            providerSnapshotChanged:
              priorAttempt.providerSnapshotFingerprint !==
              providerSnapshotFingerprint,
            failureFingerprintChanged:
              priorAttempt.failureFingerprint !== incident.failureFingerprint,
            // A different repository SHA is not automatically relevant. Explicit
            // provider/reader/operator reopeners increment the incident cycle, so
            // their prior-cycle attempts were filtered above. Demand only changes
            // priority and must never repeat an unchanged technical approach.
            relevantRuntimeChanged: false,
            readerCapabilityChanged: false,
          }
        : undefined,
      now,
    });
    const sourceCompleteFinalizationRecovery =
      getSourceCompleteFinalizationRecovery({
        incident,
        course,
        currentCycleBatchIncidents,
        providerSnapshotFingerprint,
        routedRemediation,
        now,
      });
    const operationalAttemptsCompleted = routedRemediation.attemptSignature
      ? countCourseSupportOperationalNoProgressAttempts({
          batchIncidents: currentCycleBatchIncidents,
          cycle: incident.cycle,
          courseId: incident.courseId,
          providerSnapshotFingerprint,
          failureFingerprint: incident.failureFingerprint,
          approach: routedRemediation.attemptSignature,
          zeroExecutionRecoveryRecorded:
            hasValidatedZeroExecutionRecoveryMarker(
              incident.cycle,
              incident.monitoringEvents,
            ),
        })
      : 0;
    const remediationRoute = sourceCompleteFinalizationRecovery
      ? buildSourceCompleteFinalizationRecoveryRoute(routedRemediation)
      : deferredFailureHandoff
      ? ({
          ...routedRemediation,
          workMode: "VERIFY_TRANSIENT",
          resumeWorkMode: "VERIFY_TRANSIENT",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          retryBudget: null,
          reason: "MATERIAL_CHANGE_REOPENED",
          strategy: {
            action: "RETRY_PROVIDER",
            reason: "TRANSIENT_PROVIDER_FAILURE",
            providerFamilyKey: incident.providerFamilyKey,
            browserAllowed: false,
          },
          materialChangeDetected: true,
          attemptSignature: {
            workMode: "VERIFY_TRANSIENT",
            strategyAction: "RETRY_PROVIDER",
            playbookStage: null,
          },
        } satisfies CourseSupportRemediationRoute)
      : applyCourseSupportOperationalRetryBudget({
          route: routedRemediation,
          attemptsCompleted: operationalAttemptsCompleted,
        });
    const actionPlan = buildCourseSupportClaimActionPlan({
      route: remediationRoute,
      incidentKind: incident.kind,
      incidentProviderFamilyKey: incident.providerFamilyKey,
      course
    });
    const providerContractEvidence =
      remediationRoute.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      remediationRoute.attemptSignature?.playbookStage ===
        "BROWSER_ADAPTER_RETRY" &&
      actionPlan.primaryAction === "IMPLEMENT_REUSABLE_SUPPORT"
        ? (currentProviderContractEvidence ?? undefined)
        : undefined;
    if (
      deferredFailureHandoff &&
      (remediationRoute.workMode !== "VERIFY_TRANSIENT" ||
        remediationRoute.requiresImplementationPath ||
        remediationRoute.reason !== "MATERIAL_CHANGE_REOPENED" ||
        remediationRoute.attemptSignature?.playbookStage !== null)
    ) {
      return [];
    }
    return [
      {
        id: incident.id,
        courseId: incident.courseId,
        cycle: incident.cycle,
        kind: incident.kind,
        providerFamilyKey: incident.providerFamilyKey,
        failureClass: incident.failureClass,
        failureFingerprint: incident.failureFingerprint,
        humanReviewReason: sourceCompleteFinalizationRecovery
          ? null
          : incident.humanReviewReason,
        engineeringOnly:
          currentDemand.activeRealSearchCount > 0
            ? false
            : incident.engineeringOnly,
        activeRealSearchCount: currentDemand.activeRealSearchCount,
        earliestTargetDate: currentDemand.earliestTargetDate,
        escalationDeadlineAt: incident.escalationDeadlineAt,
        escalatedAt: incident.escalatedAt,
        endpointHumanReviewProven:
          incident.escalatedAt != null &&
          isAutomationHumanReviewProofCurrentOrPrior(
            incident.attemptLedger,
            incident.cycle,
          ),
        firstSeenAt: incident.firstSeenAt,
        lastSeenAt: incident.lastSeenAt,
        lastAttemptAt: incident.lastAttemptAt,
        nextAttemptAt: incident.nextAttemptAt,
        attemptCount: incident.attemptCount,
        updatedAt: incident.updatedAt,
        courseUpdatedAt: course.updatedAt,
        remediationDirective:
          getCourseSupportRemediationDirective(remediationRoute),
        remediationRoute,
        actionPlan,
        ...(providerContractEvidence ? { providerContractEvidence } : {}),
        providerSnapshotFingerprint,
        remediationCourseRef: createCourseSupportRemediationCourseRef(
          incident.courseId,
        ),
        ...(deferredFailureHandoff ? { deferredFailureHandoff } : {}),
        ...(sourceCompleteFinalizationRecovery
          ? { sourceCompleteFinalizationRecovery }
          : {}),
        playbookEventCountAtClaim: countCourseSupportPlaybookEvents({
          attemptLedger: incident.attemptLedger,
          cycle: incident.cycle,
        }),
      },
    ];
  });
}

function buildSelectableCourseSupportClaimCandidates(
  incidents: readonly CourseSupportCandidateIncident[],
  now: Date,
) {
  const incidentById = new Map(
    incidents.map((incident) => [incident.id, incident] as const),
  );
  return buildCourseSupportCandidates(incidents, now).filter((candidate) => {
    const incident = incidentById.get(candidate.id);
    if (!incident || incident.activeBatchId !== null) return false;
    if (readCandidateSourceCompleteFinalizationRecovery(candidate)) return true;
    return (
      incident.status === "AUTO_INVESTIGATING" &&
      (incident.nextAttemptAt === null ||
        incident.nextAttemptAt.getTime() <= now.getTime())
    );
  });
}

export function mergeCourseSupportClaimCandidatePools(input: {
  campaignCandidates: readonly CourseSupportClaimCandidate[];
  currentCandidates: readonly CourseSupportClaimCandidate[];
}) {
  const merged: CourseSupportClaimCandidate[] = [];
  const indexByIncidentId = new Map<string, number>();
  for (const candidate of input.campaignCandidates) {
    const existingIndex = indexByIncidentId.get(candidate.id);
    if (existingIndex !== undefined) {
      if (merged[existingIndex]?.courseId !== candidate.courseId) {
        throw new Error(
          "Course-support candidate pools disagree on incident identity.",
        );
      }
      continue;
    }
    indexByIncidentId.set(candidate.id, merged.length);
    merged.push(candidate);
  }
  for (const candidate of input.currentCandidates) {
    const existingIndex = indexByIncidentId.get(candidate.id);
    if (existingIndex === undefined) {
      indexByIncidentId.set(candidate.id, merged.length);
      merged.push(candidate);
      continue;
    }
    const existing = merged[existingIndex];
    if (!existing || existing.courseId !== candidate.courseId) {
      throw new Error(
        "Course-support candidate pools disagree on incident identity.",
      );
    }
    const existingCampaign = candidate.campaign ? null : existing.campaign;
    const currentRecovery = readCandidateSourceCompleteFinalizationRecovery(
      candidate,
    );
    if (
      existingCampaign &&
      (!currentRecovery?.campaign ||
        currentRecovery.campaign.runId !== existingCampaign.runId ||
        currentRecovery.campaign.membershipDigest !==
          existingCampaign.membershipDigest)
    ) {
      continue;
    }
    // Current persisted authority wins over the campaign's synthetic reopened
    // projection only when it is not campaign-owned or when exact recovery
    // already carries the same cohort provenance.
    merged[existingIndex] = candidate;
  }
  return merged;
}

async function listParkedCourseCampaignCandidates(
  plan: Awaited<ReturnType<typeof planNextParkedCourseCampaignCohort>>,
  now: Date,
) {
  if (!plan.campaignRunId || !plan.members.length || !plan.membershipDigest) {
    return [] as CourseSupportClaimCandidate[];
  }
  const memberByIncidentId = new Map(
    plan.members.map((member) => [member.incidentId, member]),
  );
  const incidents = await prisma.courseSupportIncident.findMany({
    where: { id: { in: plan.members.map((member) => member.incidentId) } },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    select: COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT,
  });
  const reopenedCycleIncidents = incidents.flatMap((incident) => {
    const member = memberByIncidentId.get(incident.id);
    if (
      !member ||
      incident.courseId !== member.courseId ||
      incident.cycle !== member.cycle ||
      incident.kind !== member.kind ||
      incident.failureClass !== member.failureClass ||
      incident.providerFamilyKey !== member.providerFamilyKey ||
      incident.failureFingerprint !== member.failureFingerprint
    ) {
      return [];
    }
    return [
      {
        ...incident,
        status: "AUTO_INVESTIGATING" as const,
        activeBatchId: null,
        cycle:
          member.admissionMode === "FRESH_CYCLE"
            ? incident.cycle + 1
            : incident.cycle,
        confirmedAt:
          member.admissionMode === "FRESH_CYCLE" ? now : incident.confirmedAt,
        humanReviewReason: null,
        lastAttemptAt: null,
        nextAttemptAt: now,
        attemptCount: 0,
        batchIncidents: [],
      },
    ];
  });
  await assertBoundedCourseSupportCandidateCurrentCycleHistory(
    prisma,
    reopenedCycleIncidents,
  );
  const reopenedCycleCandidates = buildSelectableCourseSupportClaimCandidates(
    reopenedCycleIncidents,
    now,
  );
  return reopenedCycleCandidates.flatMap((candidate) => {
    const member = plan.members.find(
      (entry) => entry.incidentId === candidate.id,
    );
    if (!member) return [];
    return [
      {
        ...candidate,
        campaign: {
          runId: plan.campaignRunId!,
          membershipDigest: plan.membershipDigest!,
          priorCycle: member.cycle,
          priorRevision: member.revision,
          priorMonitoringRevision: member.monitoringRevision,
          capturedRevision: member.capturedRevision,
          capturedMonitoringRevision: member.capturedMonitoringRevision,
          capturedCycle: member.capturedCycle,
          capturedKind: member.capturedKind,
          capturedProviderFamilyKey: member.capturedProviderFamilyKey,
          campaignCapturedAt: member.campaignCapturedAt,
          admissionMode: member.admissionMode,
          zeroExecutionHistoryDigest: member.zeroExecutionHistoryDigest,
          sameCycleRecoveryHistoryDigest: member.sameCycleRecoveryHistoryDigest,
          playbookNextStage: member.playbookNextStage,
          playbookCompletedStageCount: member.playbookCompletedStageCount,
          expectedMonitoringFailureFingerprint:
            member.monitoringFailureFingerprint,
          expectedKind: candidate.kind,
          expectedFailureClass: candidate.failureClass,
          expectedProviderSnapshotFingerprint:
            member.providerSnapshotFingerprint,
          expectedAttemptLedgerFingerprint: member.attemptLedgerFingerprint,
          expectedPlaybookConclusion: member.playbookConclusion,
          expectedLatestProbeAt: member.latestProbeAt,
          expectedLatestDiscoveryAt: member.latestDiscoveryAt,
          expectedLatestProbeId: member.latestProbeId,
          expectedLatestDiscoveryId: member.latestDiscoveryId,
        },
      },
    ];
  });
}
async function recordRoutineResponderObservation(input: {
  outcome: "no_due_work" | "deferred_busy" | "deferred_engineering_cadence";
  now: Date;
  summary: unknown;
}) {
  try {
    await prisma.automationRun.create({
      data: {
        promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
        kind: "COURSE_SUPPORT",
        status: "COMPLETED",
        startedAt: input.now,
        completedAt: input.now,
        outcome: input.outcome,
        notes: JSON.stringify({
          schemaVersion: 1,
          lifecycle: "closeout",
          outcome: input.outcome,
          summary: sanitizeResponderValue(input.summary),
        }),
      },
    });
    return true;
  } catch {
    return false;
  }
}

function nextBatchStatus(
  current: CourseSupportBatchStatus,
  requested: "IMPLEMENTING" | "VERIFYING" | undefined,
): CourseSupportBatchStatus {
  if (!requested) {
    return current;
  }
  if (current === "VERIFYING" && requested === "IMPLEMENTING") {
    return current;
  }
  return requested;
}

function countVerificationResults(results: CourseSupportBatchIncidentResult[]) {
  return Object.fromEntries(
    [
      "PENDING",
      "RESTORED",
      "FINAL_DISPOSITION",
      "RETRY_SCHEDULED",
      "NEEDS_HUMAN",
      "STALE_EVIDENCE",
    ].map((result) => [
      result,
      results.filter((candidate) => candidate === result).length,
    ]),
  );
}

function deriveBackfillFailureClass(input: {
  existing: CourseSupportFailureClass;
  kind: CourseSupportIncidentKind;
  readinessFailure: CourseSupportFailureClass | null;
  observedFailure: CourseSupportFailureClass;
}): CourseSupportFailureClass {
  if (input.kind === "NEEDS_ADAPTER" && input.readinessFailure) {
    return input.readinessFailure;
  }
  if (input.existing !== "UNKNOWN") {
    return input.existing;
  }
  if (input.kind === "BLOCKED_AUTH") {
    return "AUTH";
  }
  return input.observedFailure;
}

function compareOrdinalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeCourseSupportObservedGitPaths(paths: string[]) {
  return [
    ...new Set(
      paths
        .map((path) => path.replaceAll("\\", "/"))
        .filter((path) => path.length > 0),
    ),
  ].sort();
}

function normalizePaths(paths: string[]) {
  return [
    ...new Set(
      paths
        .map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
        .filter(Boolean),
    ),
  ].sort();
}

export function isRuntimeBearingCourseSupportPath(value: string) {
  const [path] = normalizePaths([value]);
  if (!path) {
    return false;
  }
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  if (
    segments.some((segment) =>
      ["doc", "docs", "test", "tests", "__tests__", "note", "notes"].includes(
        segment,
      ),
    ) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(fileName) ||
    /\.(?:md|mdx|txt|rst|adoc)$/u.test(fileName) ||
    /^(?:readme|changelog|license)(?:\.|$)/u.test(fileName)
  ) {
    return false;
  }
  return true;
}

function hasRuntimeBearingCourseSupportPath(paths: string[]) {
  return paths.some(isRuntimeBearingCourseSupportPath);
}

function hasAuthoritativeContactEvidence(
  course: Pick<
    CourseSupportCourseEvidence,
    "website" | "detectedBookingUrl" | "bookingMethod" | "automationReason"
  >,
  evidenceUrl: string,
) {
  if (
    !["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      course.bookingMethod,
    ) ||
    course.automationReason !== "NO_ONLINE_BOOKING"
  ) {
    return false;
  }
  try {
    const evidence = new URL(evidenceUrl);
    if (
      evidence.protocol !== "https:" ||
      evidence.username ||
      evidence.password
    ) {
      return false;
    }
    const officialOrigins = [course.website, course.detectedBookingUrl].flatMap(
      (value) => {
        try {
          const url = new URL(value ?? "");
          return url.protocol === "https:" && !url.username && !url.password
            ? [url.origin]
            : [];
        } catch {
          return [];
        }
      },
    );
    return officialOrigins.includes(evidence.origin);
  } catch {
    return false;
  }
}

function readBatchPlannedPaths(summary: Prisma.JsonValue | null) {
  const object = asJsonObject(summary);
  return normalizePaths(
    Array.isArray(object.plannedPaths)
      ? object.plannedPaths.filter(
          (path): path is string => typeof path === "string",
        )
      : [],
  );
}

function courseSupportBatchOwnsCheckout(batch: {
  status: CourseSupportBatchStatus;
  summary: Prisma.JsonValue | null;
}) {
  return batch.status === "IMPLEMENTING" ||
    readBatchPlannedPaths(batch.summary).length > 0;
}

function courseSupportBatchReservesCheckout(batch: {
  status: CourseSupportBatchStatus;
  summary: Prisma.JsonValue | null;
}) {
  return (
    courseSupportBatchOwnsCheckout(batch) ||
    readCourseSupportRemediationDirective(batch.summary)
      ?.requiresImplementationPath === true
  );
}

export function findConflictingResponderPaths(
  requestedPaths: string[],
  ownedPaths: string[],
) {
  const owned = new Set(normalizePaths(ownedPaths).map(getResponderCodeScope));
  return normalizePaths(requestedPaths).filter((path) =>
    owned.has(getResponderCodeScope(path)),
  );
}

export function courseSupportRecoveryBatchesConflict(
  recovering: {
    providerFamilyKey: string;
    failureFingerprint: string;
    summary: Prisma.JsonValue | null;
  },
  active: {
    providerFamilyKey: string;
    failureFingerprint: string;
    summary: Prisma.JsonValue | null;
  },
) {
  if (
    recovering.providerFamilyKey === active.providerFamilyKey ||
    recovering.failureFingerprint === active.failureFingerprint
  ) {
    return true;
  }
  return (
    findConflictingResponderPaths(
      readBatchPlannedPaths(recovering.summary),
      readBatchPlannedPaths(active.summary),
    ).length > 0
  );
}

function getResponderCodeScope(path: string) {
  const normalized = path.toLowerCase();
  const providerAdapter =
    /^src\/lib\/tee-times\/(?:adapters|providers)\/([^/]+)/u.exec(normalized);
  if (providerAdapter) {
    return `provider-adapter:${providerAdapter[1]}`;
  }
  const localReader = /^tools\/local-chrome-reader\/([^/]+-reader\.js)$/u.exec(
    normalized,
  );
  if (localReader) {
    return `local-reader:${localReader[1]}`;
  }
  return `file:${normalized}`;
}

function validatePlannedPath(value: string) {
  const [path] = normalizePaths([value]);
  if (
    !path ||
    path.startsWith("../") ||
    /^[a-z]:\//i.test(path) ||
    path.startsWith("/") ||
    path === ".git" ||
    path.startsWith(".git/") ||
    path === "node_modules" ||
    path.startsWith("node_modules/") ||
    /(^|\/)\.env(?:\.|$)/i.test(path)
  ) {
    throw new Error(
      "Course-support planned paths must be safe repo-relative files.",
    );
  }
  return path;
}

function getSafePublicRoot(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function sanitizeRequiredResponderText(value: string, label: string) {
  const sanitized = sanitizeResponderText(value).trim().slice(0, 1000);
  if (!sanitized || sanitized === "[redacted]") {
    throw new Error(`Course-support ${label} is required.`);
  }
  return sanitized;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getPersistedRecheckDispatch(value: Prisma.JsonValue | null) {
  const summary = asJsonObject(value);
  const dispatch = summary.recheckDispatch;
  return dispatch && typeof dispatch === "object" && !Array.isArray(dispatch)
    ? (dispatch as Record<string, unknown>)
    : null;
}

function isRecheckDispatchHealthy(value: Prisma.JsonValue | null, now: Date) {
  const dispatch = getPersistedRecheckDispatch(value);
  if (
    !dispatch ||
    dispatch.attempted !== true ||
    dispatch.dispatchError !== false ||
    dispatch.schedulerHealthComplete !== true ||
    dispatch.courseOutcomeHealthComplete !== true ||
    dispatch.detachedVerificationDispatchError === true
  ) {
    return false;
  }
  const affected = finiteCount(dispatch.affectedSearchCount);
  const currentAffected = finiteCount(dispatch.currentAffectedSearchCount);
  const queued = finiteCount(dispatch.queuedCount);
  const queueFailures = finiteCount(dispatch.queueFailureCount);
  const directStarts = finiteCount(dispatch.directStartCount);
  const healthySchedulers = finiteCount(dispatch.healthySchedulerCount);
  const freshChecks = finiteCount(dispatch.freshSearchCheckCount);
  const restoredCourses = finiteCount(dispatch.restoredCourseCount);
  const provenRunnableCourses = finiteCount(dispatch.provenRunnableCourseCount);
  const affectedCourseSearchPairs = finiteCount(
    dispatch.affectedCourseSearchPairCount,
  );
  const healthyCourseSearchPairs = finiteCount(
    dispatch.healthyCourseSearchPairCount,
  );
  const healthObservedAt = parseProofDate(dispatch.schedulerHealthObservedAt);
  return (
    affected !== null &&
    currentAffected === affected &&
    queued === affected &&
    queueFailures === directStarts &&
    healthySchedulers === affected &&
    freshChecks === affected &&
    restoredCourses !== null &&
    provenRunnableCourses === restoredCourses &&
    affectedCourseSearchPairs !== null &&
    healthyCourseSearchPairs === affectedCourseSearchPairs &&
    Boolean(
      healthObservedAt &&
      healthObservedAt.getTime() <= now.getTime() + 60_000 &&
      healthObservedAt.getTime() >= now.getTime() - RECHECK_HEALTH_FRESHNESS_MS,
    )
  );
}

function getAffectedSearchRefs(dispatch: Record<string, unknown> | null) {
  const refs = new Map<string, number>();
  if (!dispatch || !Array.isArray(dispatch.affectedSearchRefs)) {
    return refs;
  }
  for (const value of dispatch.affectedSearchRefs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.searchRef === "string" &&
      /^[a-f0-9]{64}$/.test(entry.searchRef) &&
      typeof entry.scheduleVersion === "number" &&
      Number.isInteger(entry.scheduleVersion) &&
      entry.scheduleVersion >= 0
    ) {
      refs.set(entry.searchRef, entry.scheduleVersion);
    }
  }
  return refs;
}

const VERIFIED_BROWSER_PRIVATE_POLICY_NOTES = new Map([
  [
    "official-private-course-profile",
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.",
  ],
  [
    "official-private-club-access",
    "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
  [
    "official-resident-member-access",
    "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
]);

function getVerifiedBrowserPrivateIdentityDisposition(input: {
  course: CourseSupportCourseEvidence;
  discovery: NonNullable<CourseSupportCourseEvidence["latestDiscovery"]>;
  incidentFirstSeenAt: Date;
  now: Date;
  evidenceOrigin: string | null;
}): { message: string; proofSnapshot: Prisma.InputJsonValue } | null {
  const { course, discovery, incidentFirstSeenAt, now, evidenceOrigin } = input;
  const evidence = isPlainJsonObject(discovery.evidence)
    ? discovery.evidence
    : null;
  const learnedFrom = evidence?.learnedFrom;
  const [baseLearnedFrom, ...markers] =
    typeof learnedFrom === "string" ? learnedFrom.split(":") : [];
  const validProvenance =
    markers.length === 0 ||
    (markers.length === 1 && markers[0] === "legacy-policy-reconciliation");
  const expectedPolicyNotes = validProvenance
    ? VERIFIED_BROWSER_PRIVATE_POLICY_NOTES.get(baseLearnedFrom)
    : undefined;
  const finalUrl =
    typeof evidence?.finalUrl === "string" ? evidence.finalUrl : null;
  const observedUrls = Array.isArray(evidence?.observedUrls)
    ? evidence.observedUrls
    : [];
  const verifiedAt = course.intelligenceVerifiedAt;
  const reviewAt = course.intelligenceReviewAt;
  const source = getSafeExactEvidenceUrl(discovery.sourceUrl);
  const booking = discovery.bookingUrl
    ? getSafeExactEvidenceUrl(discovery.bookingUrl)
    : null;
  const final = finalUrl ? getSafeExactEvidenceUrl(finalUrl) : null;
  const maximumEvidenceAt = now.getTime() + 60 * 1000;
  const maximumReviewAt = verifiedAt
    ? verifiedAt.getTime() + 181 * 24 * 60 * 60 * 1000
    : 0;
  if (
    course.isPublic !== false ||
    course.bookingMethod !== "UNKNOWN" ||
    course.automationEligibility !== "BLOCKED" ||
    course.automationReason !== "OTHER" ||
    course.policyNotes !== expectedPolicyNotes ||
    course.intelligenceConfidence !== 0.98 ||
    !verifiedAt ||
    !reviewAt ||
    verifiedAt.getTime() < incidentFirstSeenAt.getTime() ||
    verifiedAt.getTime() > maximumEvidenceAt ||
    discovery.createdAt.getTime() < incidentFirstSeenAt.getTime() ||
    discovery.createdAt.getTime() > maximumEvidenceAt ||
    Math.abs(verifiedAt.getTime() - discovery.createdAt.getTime()) >
      5 * 60 * 1000 ||
    reviewAt.getTime() <= verifiedAt.getTime() ||
    reviewAt.getTime() <= now.getTime() ||
    reviewAt.getTime() > maximumReviewAt ||
    discovery.status !== "VERIFIED" ||
    discovery.detectedPlatform !== "UNKNOWN" ||
    discovery.bookingMethod !== "UNKNOWN" ||
    discovery.bookingPhone != null ||
    discovery.automationEligibility !== "BLOCKED" ||
    discovery.automationReason !== "OTHER" ||
    discovery.apiEndpoint != null ||
    discovery.apiMetadata != null ||
    discovery.confidence !== 0.98 ||
    !expectedPolicyNotes ||
    !evidenceOrigin ||
    !source ||
    !booking ||
    !final ||
    source !== booking ||
    source !== final ||
    !observedUrls.some((value) => value === source) ||
    typeof evidence?.visibleText !== "string" ||
    !evidence.visibleText.trim()
  ) {
    return null;
  }
  return {
    message:
      "Current exact official browser evidence supports a final private-course identity disposition.",
    proofSnapshot: {
      kind: "BROWSER_PRIVATE_IDENTITY",
      disposition: "VERIFIED_PRIVATE",
      discoveryCreatedAt: discovery.createdAt.toISOString(),
      intelligenceVerifiedAt: verifiedAt.toISOString(),
      intelligenceReviewAt: reviewAt.toISOString(),
      evidenceOrigin,
      provenance: learnedFrom,
      confidence: discovery.confidence,
      intelligenceConfidence: course.intelligenceConfidence,
      policyNotes: course.policyNotes,
      courseBookingMethod: course.bookingMethod,
      courseAutomationEligibility: course.automationEligibility,
      courseAutomationReason: course.automationReason,
      discoveryStatus: discovery.status,
      discoveryDetectedPlatform: discovery.detectedPlatform,
      discoveryBookingMethod: discovery.bookingMethod,
      discoveryBookingPhone: discovery.bookingPhone ?? null,
      discoveryAutomationEligibility: discovery.automationEligibility,
      discoveryAutomationReason: discovery.automationReason,
      discoveryApiEndpoint: discovery.apiEndpoint ?? null,
      discoveryApiMetadata: discovery.apiMetadata ?? null,
    } satisfies Prisma.InputJsonObject,
  };
}

function isPlainJsonObject(
  value: Prisma.JsonValue | null | undefined,
): value is Prisma.JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getSafeExactEvidenceUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isDetachedRestoredVerification(
  verification: BatchIncidentVerification,
): verification is BatchIncidentVerification & {
  proofSnapshot: Prisma.InputJsonObject;
} {
  if (
    verification.result !== "RESTORED" ||
    !verification.proofSnapshot ||
    typeof verification.proofSnapshot !== "object" ||
    Array.isArray(verification.proofSnapshot)
  ) {
    return false;
  }
  return (verification.proofSnapshot as Prisma.InputJsonObject).kind ===
    "PROVIDER_VERIFICATION";
}

async function revalidateDetachedVerificationProof(
  transaction: Prisma.TransactionClient,
  input: {
    batchId: string;
    batchIncidentId: string;
    incidentId: string;
    courseId: string;
    cycle: number;
    releaseSha: string;
    leaseToken: string;
    ownerThreadId: string;
    proofSnapshot: unknown;
    now: Date;
  },
) {
  if (!/^[a-f0-9]{40}$/i.test(input.releaseSha)) {
    return false;
  }
  const request = await transaction.courseSupportVerificationRequest.findUnique(
    {
      where: {
        batchIncidentId_releaseSha: {
          batchIncidentId: input.batchIncidentId,
          releaseSha: input.releaseSha,
        },
      },
      select: {
        courseId: true,
        releaseSha: true,
        runtimeVersion: true,
        status: true,
        leaseToken: true,
        leaseExpiresAt: true,
        outcome: true,
        evidence: true,
        providerSnapshotFingerprint: true,
        completedAt: true,
        batchIncident: {
          select: {
            id: true,
            batchId: true,
            incidentId: true,
            courseId: true,
            cycle: true,
            batch: {
              select: {
                id: true,
                status: true,
                ownerThreadId: true,
                leaseToken: true,
                leaseExpiresAt: true,
                releaseSha: true,
                completedAt: true,
              },
            },
            incident: {
              select: {
                id: true,
                cycle: true,
                status: true,
                activeBatchId: true,
                engineeringOnly: true,
              },
            },
            course: { select: DETACHED_VERIFICATION_COURSE_SELECT },
          },
        },
      },
    },
  );
  if (!request) {
    return false;
  }

  const proof = asJsonObject(input.proofSnapshot as Prisma.JsonValue);
  const evidence = asJsonObject(request.evidence);
  const batchIncident = request.batchIncident;
  const activeBatch = batchIncident.batch;
  const incident = batchIncident.incident;
  const currentFingerprint = buildCourseSupportProviderSnapshotFingerprint(
    batchIncident.course,
  );
  const currentMonitoringGate = evaluateMonitoringGate({
    ...batchIncident.course,
    now: input.now,
  });
  const successfulOutcome =
    request.outcome === "MATCH_FOUND" || request.outcome === "NO_MATCH";
  const requestIsCurrent = Boolean(
    request.status === "SUCCEEDED" &&
    request.releaseSha === input.releaseSha &&
    request.runtimeVersion === input.releaseSha &&
    request.leaseToken === null &&
    request.leaseExpiresAt === null &&
    request.completedAt &&
    successfulOutcome &&
    request.courseId === input.courseId &&
    batchIncident.id === input.batchIncidentId &&
    batchIncident.batchId === input.batchId &&
    batchIncident.incidentId === input.incidentId &&
    batchIncident.courseId === input.courseId &&
    batchIncident.cycle === input.cycle &&
    activeBatch.id === input.batchId &&
    activeBatch.status === "VERIFYING" &&
    activeBatch.ownerThreadId === input.ownerThreadId &&
    activeBatch.leaseToken === input.leaseToken &&
    activeBatch.leaseExpiresAt.getTime() >= input.now.getTime() &&
    activeBatch.releaseSha === input.releaseSha &&
    activeBatch.completedAt === null &&
    incident.id === input.incidentId &&
    incident.cycle === input.cycle &&
    incident.status === "AUTO_INVESTIGATING" &&
    incident.activeBatchId === input.batchId &&
    currentMonitoringGate.disposition === "ACTIONABLE" &&
    currentMonitoringGate.adapterAllowed === true &&
    evidence.kind === "PROVIDER_VERIFICATION" &&
    evidence.providerExecution === true &&
    evidence.releaseSha === input.releaseSha &&
    evidence.runtimeVersion === input.releaseSha &&
    evidence.outcome === request.outcome &&
    evidence.providerSnapshotFingerprint ===
      request.providerSnapshotFingerprint &&
    proof.kind === "PROVIDER_VERIFICATION" &&
    proof.providerExecution === true &&
    proof.runtimeVersion === input.releaseSha &&
    proof.outcome === request.outcome &&
    proof.observedAt === evidence.observedAt &&
    proof.completedAt === request.completedAt?.toISOString() &&
    proof.providerSnapshotFingerprint === request.providerSnapshotFingerprint &&
    request.providerSnapshotFingerprint === currentFingerprint,
  );
  if (!requestIsCurrent) {
    return false;
  }

  const liveFutureDemand = await transaction.teeSearch.count({
    where: {
      status: "ACTIVE",
      date: {
        gte: getCourseLocalDateStorageBoundary(
          batchIncident.course.timeZone,
          input.now,
        ),
      },
      preferences: { some: { courseId: input.courseId } },
    },
  });
  return liveFutureDemand === 0;
}

export function isDurableTerminalProof(
  entry: {
    normalizedResult: CourseSupportBatchIncidentResult;
    proofSnapshot: Prisma.JsonValue | null;
    verifiedAt: Date | null;
    verifiedIncidentUpdatedAt: Date | null;
    currentProviderSnapshotFingerprint?: string | null;
    incident: {
      firstSeenAt: Date;
      lastSeenAt: Date;
      providerFamilyKey: string;
      failureClass: CourseSupportFailureClass;
      attemptCount: number;
      activeRealSearchCount: number;
      cycle?: number;
      attemptLedger?: Prisma.JsonValue | null;
      confirmedAt?: Date | null;
      updatedAt: Date;
    };
    course?: SourceUnverifiedCourse;
  },
  batch: {
    createdAt: Date;
    releaseSha: string | null;
    deployedAt: Date | null;
    recheckDispatchStartedAt: Date | null;
  },
) {
  if (!entry.verifiedAt || !entry.verifiedIncidentUpdatedAt) {
    return false;
  }
  const proof = asJsonObject(entry.proofSnapshot);
  if (entry.normalizedResult === "RESTORED") {
    const observedAt = parseProofDate(proof.observedAt);
    if (proof.kind === "PROVIDER_VERIFICATION") {
      const completedAt = parseProofDate(proof.completedAt);
      const notBefore = batch.deployedAt ?? batch.createdAt;
      return Boolean(
        proof.providerExecution === true &&
        (proof.outcome === "MATCH_FOUND" || proof.outcome === "NO_MATCH") &&
        batch.releaseSha &&
        batch.recheckDispatchStartedAt &&
        proof.runtimeVersion === batch.releaseSha &&
        typeof proof.providerSnapshotFingerprint === "string" &&
        /^[a-f0-9]{64}$/i.test(proof.providerSnapshotFingerprint) &&
        proof.providerSnapshotFingerprint ===
          entry.currentProviderSnapshotFingerprint &&
        observedAt &&
        completedAt &&
        completedAt.getTime() >= observedAt.getTime() &&
        observedAt.getTime() >= notBefore.getTime() &&
        observedAt.getTime() >= batch.recheckDispatchStartedAt.getTime() &&
        observedAt.getTime() >= entry.incident.lastSeenAt.getTime(),
      );
    }
    const freshSearchCheckedAt = parseProofDate(proof.freshSearchCheckedAt);
    const notBefore = batch.deployedAt ?? batch.createdAt;
    return Boolean(
      proof.kind === "PROVIDER_PROBE" &&
      proof.providerExecution === true &&
      (proof.outcome === "MATCH_FOUND" || proof.outcome === "NO_MATCH") &&
      batch.releaseSha &&
      batch.recheckDispatchStartedAt &&
      proof.runtimeVersion === batch.releaseSha &&
      observedAt &&
      freshSearchCheckedAt &&
      observedAt.getTime() >= notBefore.getTime() &&
      observedAt.getTime() >= batch.recheckDispatchStartedAt.getTime() &&
      observedAt.getTime() >= entry.incident.lastSeenAt.getTime() &&
      freshSearchCheckedAt.getTime() >=
        batch.recheckDispatchStartedAt.getTime(),
    );
  }
  if (entry.normalizedResult === "FINAL_DISPOSITION") {
    const terminalEvidenceBoundary =
      entry.incident.confirmedAt ?? entry.incident.firstSeenAt;
    if (proof.kind === "PLAYBOOK_FACTUAL_FINAL") {
      return Boolean(
        batch.releaseSha &&
        entry.incident.cycle &&
        isCourseSupportFactualFinalProof({
          proof,
          attemptLedger: entry.incident.attemptLedger,
          cycle: entry.incident.cycle,
          firstSeenAt: terminalEvidenceBoundary,
          releaseSha: batch.releaseSha,
          verifiedAt: entry.verifiedAt,
          notBefore: [
            batch.deployedAt ?? batch.createdAt,
            ...(batch.recheckDispatchStartedAt
              ? [batch.recheckDispatchStartedAt]
              : []),
          ],
          now: entry.verifiedAt,
        }),
      );
    }
    if (proof.kind === "SOURCE_UNVERIFIED_FINAL") {
      const firstSeenAt = parseProofDate(proof.firstSeenAt);
      const freshCycleStartedAt = parseProofDate(proof.freshCycleStartedAt);
      const verifiedAt = parseProofDate(proof.verifiedAt);
      const sourceResult =
        proof.sourceResult === "RETRY_SCHEDULED" ||
        proof.sourceResult === "STALE_EVIDENCE"
          ? proof.sourceResult
          : null;
      const browserFinalizationEvidence =
        proof.evidenceMode === "INDEPENDENT_BROWSER_SOURCE_CONFLICT" &&
        sourceResult &&
        entry.course &&
        entry.incident.cycle
          ? getSourceUnverifiedFinalizationEvidence({
              providerFamilyKey: entry.incident.providerFamilyKey,
              failureClass: entry.incident.failureClass,
              course: entry.course,
              attemptCount: entry.incident.attemptCount,
              activeRealSearchCount: entry.incident.activeRealSearchCount,
              firstSeenAt: entry.incident.firstSeenAt,
              freshCycleStartedAt: entry.incident.confirmedAt ?? null,
              attemptLedger: entry.incident.attemptLedger,
              cycle: entry.incident.cycle,
              verifiedAt: entry.verifiedAt,
              verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
              incidentUpdatedAt: entry.incident.updatedAt,
              result: sourceResult,
              releaseSha: batch.releaseSha,
              deployedAt: batch.deployedAt,
              now: entry.verifiedAt,
            })
          : null;
      const browserSourceConflictProofValid = Boolean(
        browserFinalizationEvidence?.mode ===
          "INDEPENDENT_BROWSER_SOURCE_CONFLICT" &&
        parseProofDate(proof.renderedObservedAt)?.getTime() ===
          browserFinalizationEvidence.renderedObservedAt.getTime() &&
        parseProofDate(proof.independentObservedAt)?.getTime() ===
          browserFinalizationEvidence.independentObservedAt.getTime() &&
        proof.providerSnapshotFingerprint ===
          browserFinalizationEvidence.providerSnapshotFingerprint,
      );
      const legacySourceGapProofValid = Boolean(
        (proof.evidenceMode === undefined ||
          proof.evidenceMode === "PLAYBOOK_SOURCE_GAP") &&
        (hasExactSourceMissingProviderState({
          incidentProviderFamilyKey: entry.incident.providerFamilyKey,
          course: entry.course,
        }) ||
          (entry.incident.providerFamilyKey ===
            SOURCE_CONFLICT_PROVIDER_FAMILY &&
            entry.incident.failureClass === "MISSING_METADATA")) &&
        entry.incident.confirmedAt &&
        freshCycleStartedAt?.getTime() === entry.incident.confirmedAt.getTime(),
      );
      const playbook = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.incident.cycle,
      );
      const latestCompletedStageAt =
        getLatestCompletedAutomationPlaybookStageTimestamp(playbook);
      return Boolean(
        proof.disposition === "SOURCE_UNVERIFIED" &&
        proof.providerFamilyKey === entry.incident.providerFamilyKey &&
        proof.failureClass === entry.incident.failureClass &&
        proof.attemptCount === entry.incident.attemptCount &&
        proof.activeRealSearchCount === entry.incident.activeRealSearchCount &&
        proof.cycle === entry.incident.cycle &&
        proof.completedStageCount === AUTOMATION_PLAYBOOK_STAGES.length &&
        (legacySourceGapProofValid || browserSourceConflictProofValid) &&
        firstSeenAt?.getTime() === entry.incident.firstSeenAt.getTime() &&
        freshCycleStartedAt &&
        (legacySourceGapProofValid ||
          freshCycleStartedAt.getTime() ===
            browserFinalizationEvidence?.evidenceStartedAt.getTime()) &&
        verifiedAt?.getTime() === entry.verifiedAt.getTime() &&
        verifiedAt &&
        entry.verifiedIncidentUpdatedAt.getTime() ===
          entry.incident.updatedAt.getTime() &&
        latestCompletedStageAt !== null &&
        verifiedAt.getTime() >= latestCompletedStageAt &&
        playbook.valid &&
        playbook.cycle === entry.incident.cycle &&
        playbook.conclusion === "UNRESOLVED_EXHAUSTED" &&
        playbook.completedStages.length === AUTOMATION_PLAYBOOK_STAGES.length &&
        hasDurableSourceUnverifiedPlaybookEvidence(
          playbook,
          freshCycleStartedAt,
        ),
      );
    }
    if (proof.kind === "EXACT_PLACE_REVIEW") {
      const reviewUpdatedAt = parseProofDate(proof.reviewUpdatedAt);
      const reviewedAt = parseProofDate(proof.reviewedAt);
      return Boolean(
        (proof.disposition === "VERIFIED_PRIVATE" ||
          proof.disposition === "VERIFIED_NON_COURSE") &&
        typeof proof.classification === "string" &&
        proof.classification.trim() &&
        typeof proof.evidenceOrigin === "string" &&
        getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
        reviewedAt &&
        reviewUpdatedAt &&
        reviewUpdatedAt.getTime() >= terminalEvidenceBoundary.getTime() &&
        proof.automationEligibility === "BLOCKED" &&
        proof.automationReason === "OTHER",
      );
    }
    if (proof.kind === "BROWSER_PRIVATE_IDENTITY") {
      const discoveryCreatedAt = parseProofDate(proof.discoveryCreatedAt);
      const intelligenceVerifiedAt = parseProofDate(
        proof.intelligenceVerifiedAt,
      );
      const intelligenceReviewAt = parseProofDate(proof.intelligenceReviewAt);
      const maximumEvidenceAt = entry.verifiedAt.getTime() + 60 * 1000;
      const maximumReviewAt = intelligenceVerifiedAt
        ? intelligenceVerifiedAt.getTime() + 181 * 24 * 60 * 60 * 1000
        : 0;
      const provenance =
        typeof proof.provenance === "string" ? proof.provenance : "";
      const [baseProvenance, ...provenanceMarkers] = provenance.split(":");
      const validProvenance =
        provenanceMarkers.length === 0 ||
        (provenanceMarkers.length === 1 &&
          provenanceMarkers[0] === "legacy-policy-reconciliation");
      const expectedPolicyNotes = validProvenance
        ? VERIFIED_BROWSER_PRIVATE_POLICY_NOTES.get(baseProvenance)
        : undefined;
      return Boolean(
        proof.disposition === "VERIFIED_PRIVATE" &&
        typeof proof.evidenceOrigin === "string" &&
        getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
        discoveryCreatedAt &&
        intelligenceVerifiedAt &&
        intelligenceReviewAt &&
        discoveryCreatedAt.getTime() >= terminalEvidenceBoundary.getTime() &&
        intelligenceVerifiedAt.getTime() >=
          terminalEvidenceBoundary.getTime() &&
        discoveryCreatedAt.getTime() <= maximumEvidenceAt &&
        intelligenceVerifiedAt.getTime() <= maximumEvidenceAt &&
        Math.abs(
          discoveryCreatedAt.getTime() - intelligenceVerifiedAt.getTime(),
        ) <=
          5 * 60 * 1000 &&
        intelligenceReviewAt.getTime() > intelligenceVerifiedAt.getTime() &&
        intelligenceReviewAt.getTime() > entry.verifiedAt.getTime() &&
        intelligenceReviewAt.getTime() <= maximumReviewAt &&
        expectedPolicyNotes &&
        proof.policyNotes === expectedPolicyNotes &&
        proof.confidence === 0.98 &&
        proof.intelligenceConfidence === 0.98 &&
        proof.courseBookingMethod === "UNKNOWN" &&
        proof.courseAutomationEligibility === "BLOCKED" &&
        proof.courseAutomationReason === "OTHER" &&
        proof.discoveryStatus === "VERIFIED" &&
        proof.discoveryDetectedPlatform === "UNKNOWN" &&
        proof.discoveryBookingMethod === "UNKNOWN" &&
        proof.discoveryBookingPhone === null &&
        proof.discoveryAutomationEligibility === "BLOCKED" &&
        proof.discoveryAutomationReason === "OTHER" &&
        proof.discoveryApiEndpoint === null &&
        proof.discoveryApiMetadata === null,
      );
    }
    const discoveredAt = parseProofDate(proof.discoveryCreatedAt);
    const commonFinalProof = Boolean(
      proof.kind === "FINAL_DISPOSITION" &&
      (proof.disposition === "MANUAL_DIRECT" ||
        proof.disposition === "ACCOUNT_REQUIRED" ||
        proof.disposition === "CAPTCHA_OR_QUEUE") &&
      typeof proof.evidenceOrigin === "string" &&
      getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
      discoveredAt &&
      discoveredAt.getTime() >= terminalEvidenceBoundary.getTime() &&
      typeof proof.confidence === "number" &&
      proof.confidence >= 0.7,
    );
    if (!commonFinalProof) {
      return false;
    }
    if (proof.disposition !== "MANUAL_DIRECT") {
      return true;
    }
    return Boolean(
      isCoherentManualDisposition({
        bookingMethod:
          typeof proof.bookingMethod === "string" ? proof.bookingMethod : null,
        automationEligibility:
          typeof proof.automationEligibility === "string"
            ? proof.automationEligibility
            : null,
        automationReason:
          typeof proof.automationReason === "string"
            ? proof.automationReason
            : null,
      }) &&
      isCoherentManualDisposition({
        bookingMethod:
          typeof proof.discoveryBookingMethod === "string"
            ? proof.discoveryBookingMethod
            : null,
        automationEligibility:
          typeof proof.discoveryAutomationEligibility === "string"
            ? proof.discoveryAutomationEligibility
            : null,
        automationReason:
          typeof proof.discoveryAutomationReason === "string"
            ? proof.discoveryAutomationReason
            : null,
      }) &&
      proof.discoveryBookingMethod === proof.bookingMethod &&
      (proof.discoveryStatus === "VERIFIED" ||
        proof.discoveryStatus === "BLOCKED"),
    );
  }
  return false;
}

function sanitizeResponderCloseoutSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const allowedKeys = [
    "changedFileCount",
    "testCount",
    "failedTestCount",
    "backfillConflictCount",
    "lintPassed",
    "typecheckPassed",
    "buildPassed",
    "migrationApplied",
    "productionSmokePassed",
    "providerGroupCount",
    "currentAffectedCourseCount",
    "futureSiblingCourseCount",
    "courseSpecificRecordCount",
    "recurringProviderFailureCount",
    "realDemandAgeMinutes",
    "exactRuntimeVerifiedCourseCount",
  ] as const;
  const result: Record<
    string,
    number | boolean | string | Record<string, number | boolean | string>
  > = {};
  for (const key of allowedKeys) {
    const candidate = source[key];
    if (typeof candidate === "boolean") {
      result[key] = candidate;
    } else if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
    ) {
      result[key] = Math.trunc(candidate);
    }
  }
  const verificationWatch = asJsonObject(source.verificationWatch);
  const safeVerificationWatch: Record<string, number | boolean | string> = {};
  for (const key of ["settled", "stopped"] as const) {
    if (typeof verificationWatch[key] === "boolean") {
      safeVerificationWatch[key] = verificationWatch[key];
    }
  }
  for (const key of ["passCount", "preCloseoutExplicitHumanCount"] as const) {
    const candidate = verificationWatch[key];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      safeVerificationWatch[key] = candidate;
    }
  }
  if (verificationWatch.stopMode === "EARLY_RETRY" || verificationWatch.stopMode === "ENDPOINT") {
    safeVerificationWatch.stopMode = verificationWatch.stopMode;
  }
  if (Object.keys(safeVerificationWatch).length > 0) {
    result.verificationWatch = safeVerificationWatch;
  }
  return result;
}

function finiteCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function getDetachedFailureRetryNotBefore(input: {
  proofSnapshot: unknown;
  releaseSha: string | null;
  now: Date;
}) {
  const proof = asJsonObject(input.proofSnapshot as Prisma.JsonValue | null);
  const observedAt = parseProofDate(proof.observedAt);
  if (
    !input.releaseSha ||
    proof.kind !== "PROVIDER_VERIFICATION_FAILURE" ||
    (proof.status !== "RETRYABLE_FAILED" && proof.status !== "STALE") ||
    proof.runtimeVersion !== input.releaseSha ||
    proof.outcome === "MATCH_FOUND" ||
    proof.outcome === "NO_MATCH" ||
    typeof proof.failureClass !== "string" ||
    typeof proof.providerExecution !== "boolean" ||
    typeof proof.providerSnapshotFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/i.test(proof.providerSnapshotFingerprint) ||
    !observedAt ||
    observedAt.getTime() > input.now.getTime() + 60_000
  ) {
    return null;
  }

  const persistedRetryAt = parseProofDate(proof.nextAttemptAt);
  const providerRetryNotBeforeAt = parseProofDate(
    proof.providerRetryNotBeforeAt,
  );
  const validRetryTimestamps = [
    persistedRetryAt,
    providerRetryNotBeforeAt,
  ].filter((value): value is Date => value !== null);
  const futureRetryTimestamps = validRetryTimestamps.filter(
    (value) => value.getTime() > input.now.getTime(),
  );
  if (futureRetryTimestamps.length > 0) {
    return futureRetryTimestamps.reduce((latest, value) =>
      value.getTime() > latest.getTime() ? value : latest,
    );
  }

  if (
    proof.failureClass === "RATE_LIMIT" &&
    proof.status === "STALE" &&
    validRetryTimestamps.length === 0
  ) {
    return new Date(
      input.now.getTime() + DETACHED_FAILURE_FALLBACK_COOLDOWN_MS,
    );
  }
  return null;
}

function detachedFailureProofMatchesRequest(
  proofSnapshot: unknown,
  request: DetachedVerificationRequestState,
) {
  const proof = asJsonObject(proofSnapshot as Prisma.JsonValue | null);
  const evidence = asJsonObject(request.evidence);
  const providerRetryNotBeforeAt =
    typeof evidence.providerRetryNotBeforeAt === "string"
      ? evidence.providerRetryNotBeforeAt
      : null;
  const completedAt = request.completedAt?.toISOString() ?? null;
  const nextAttemptAt = request.nextAttemptAt?.toISOString() ?? null;
  return Boolean(
    (request.status === "RETRYABLE_FAILED" || request.status === "STALE") &&
    request.runtimeVersion === request.releaseSha &&
    request.outcome &&
    request.outcome !== "MATCH_FOUND" &&
    request.outcome !== "NO_MATCH" &&
    request.failureClass &&
    proof.kind === "PROVIDER_VERIFICATION_FAILURE" &&
    proof.status === request.status &&
    proof.outcome === request.outcome &&
    proof.failureClass === request.failureClass &&
    proof.observedAt === evidence.observedAt &&
    proof.completedAt === completedAt &&
    proof.nextAttemptAt === nextAttemptAt &&
    proof.providerRetryNotBeforeAt === providerRetryNotBeforeAt &&
    proof.runtimeVersion === request.runtimeVersion &&
    proof.providerExecution === evidence.providerExecution &&
    proof.providerSnapshotFingerprint === request.providerSnapshotFingerprint,
  );
}

function detachedSuccessIsReflected(
  verification: BatchIncidentVerification | undefined,
  request: DetachedVerificationRequestState,
) {
  if (
    verification?.result !== "RESTORED" &&
    verification?.result !== "FINAL_DISPOSITION"
  ) {
    return false;
  }
  const proof = asJsonObject(
    verification.proofSnapshot as Prisma.JsonValue | null,
  );
  const evidence = asJsonObject(request.evidence);
  if (proof.kind === "PLAYBOOK_FACTUAL_FINAL") {
    return Boolean(
      request.status === "SUCCEEDED" &&
      request.runtimeVersion === request.releaseSha &&
      (request.outcome === "MANUAL_DIRECT" ||
        request.outcome === "IDENTITY_FINAL") &&
      request.completedAt &&
      proof.outcome === request.outcome &&
      proof.disposition === request.outcome &&
      proof.observedAt === evidence.observedAt &&
      proof.completedAt === evidence.completedAt &&
      proof.runtimeVersion === request.runtimeVersion &&
      proof.releaseSha === request.releaseSha &&
      proof.providerExecution === false &&
      evidence.kind === "PLAYBOOK_FACTUAL_FINAL",
    );
  }
  if (proof.kind !== "PROVIDER_VERIFICATION") {
    return true;
  }
  return Boolean(
    request.status === "SUCCEEDED" &&
    request.runtimeVersion === request.releaseSha &&
    request.outcome &&
    (request.outcome === "MATCH_FOUND" || request.outcome === "NO_MATCH") &&
    request.completedAt &&
    proof.outcome === request.outcome &&
    proof.observedAt === evidence.observedAt &&
    proof.completedAt === request.completedAt.toISOString() &&
    proof.runtimeVersion === request.runtimeVersion &&
    proof.providerExecution === true &&
    evidence.providerExecution === true &&
    proof.providerSnapshotFingerprint === request.providerSnapshotFingerprint,
  );
}

function isPendingDetachedVerificationContinuation(
  request: DetachedVerificationRequestState,
  pendingContinuationBatchIncidentIds: ReadonlySet<string>,
) {
  if (
    request.status !== "RETRYABLE_FAILED" ||
    request.nextAttemptAt === null ||
    !pendingContinuationBatchIncidentIds.has(request.batchIncidentId)
  ) {
    return false;
  }
  const evidence = asJsonObject(request.evidence);
  return evidence.providerExecution !== true;
}

function getPendingDetachedContinuationBatchIncidentIds(
  entries: ReadonlyArray<{
    id: string;
    cycle: number;
    incident: { attemptLedger?: unknown };
  }>,
) {
  return new Set(
    entries.flatMap((entry) => {
      const assessment = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.cycle,
      );
      const activeOrderedContinuation =
        assessment.conclusion === "INCOMPLETE" &&
        assessment.nextStage !== null;
      const concludedRunnableRecovery =
        getConcludedDetachedVerificationRecoveryStage(assessment) !== null;
      return activeOrderedContinuation || concludedRunnableRecovery
        ? [entry.id]
        : [];
    }),
  );
}

function summarizeDetachedVerificationRerun(input: {
  requests: DetachedVerificationRequestState[];
  verificationByBatchIncidentId: Map<string, BatchIncidentVerification>;
  currentFailureBatchIncidentIds: Set<string>;
  pendingContinuationBatchIncidentIds: ReadonlySet<string>;
}) {
  const relevantRequests = input.requests.filter(
    (request) =>
      input.verificationByBatchIncidentId.get(request.batchIncidentId)
        ?.result !== "NEEDS_HUMAN",
  );
  const pendingCount = relevantRequests.filter(
    (request) =>
      request.status === "QUEUED" ||
      request.status === "CHECKING" ||
      isPendingDetachedVerificationContinuation(
        request,
        input.pendingContinuationBatchIncidentIds,
      ),
  ).length;
  const rerunNeeded = relevantRequests.some((request) => {
    const verification = input.verificationByBatchIncidentId.get(
      request.batchIncidentId,
    );
    if (request.status === "QUEUED" || request.status === "CHECKING") {
      return true;
    }
    if (request.status === "SUCCEEDED") {
      return !detachedSuccessIsReflected(verification, request);
    }
    if (
      isPendingDetachedVerificationContinuation(
        request,
        input.pendingContinuationBatchIncidentIds,
      )
    ) {
      return true;
    }
    if (request.status === "RETRYABLE_FAILED") {
      return !detachedFailureProofMatchesRequest(
        verification?.proofSnapshot,
        request,
      );
    }
    return (
      request.status === "STALE" &&
      (input.currentFailureBatchIncidentIds.has(request.batchIncidentId) ||
        detachedStaleRequestCarriesCooldownEvidence(request)) &&
      !detachedFailureProofMatchesRequest(verification?.proofSnapshot, request)
    );
  });
  return { pendingCount, rerunNeeded };
}

function assertDetachedVerificationReadyForCloseout(input: {
  requests: DetachedVerificationRequestState[];
  verificationByBatchIncidentId: Map<string, BatchIncidentVerification>;
  currentFailureBatchIncidentIds: Set<string>;
  supersededBatchIncidentIds: Set<string>;
  pendingContinuationBatchIncidentIds: ReadonlySet<string>;
}) {
  for (const request of input.requests) {
    if (input.supersededBatchIncidentIds.has(request.batchIncidentId)) {
      continue;
    }
    const verification = input.verificationByBatchIncidentId.get(
      request.batchIncidentId,
    );
    if (verification?.result === "NEEDS_HUMAN") {
      continue;
    }
    if (request.status === "QUEUED" || request.status === "CHECKING") {
      throw new Error(
        "Detached provider verification is still pending; rerun verification before closeout.",
      );
    }
    if (
      isPendingDetachedVerificationContinuation(
        request,
        input.pendingContinuationBatchIncidentIds,
      )
    ) {
      throw new Error(
        "Detached provider verification continuation is still pending; rerun verification before closeout.",
      );
    }
    if (
      request.status === "SUCCEEDED" &&
      !detachedSuccessIsReflected(verification, request)
    ) {
      throw new Error(
        "Detached provider verification completed after the last evidence read; rerun verification before closeout.",
      );
    }
    if (
      request.status === "RETRYABLE_FAILED" &&
      (!input.currentFailureBatchIncidentIds.has(request.batchIncidentId) ||
        !detachedFailureProofMatchesRequest(
          verification?.proofSnapshot,
          request,
        ))
    ) {
      throw new Error(
        "Detached provider failure changed after the last evidence read; rerun verification before closeout.",
      );
    }
    if (
      request.status === "STALE" &&
      (input.currentFailureBatchIncidentIds.has(request.batchIncidentId) ||
        detachedStaleRequestCarriesCooldownEvidence(request)) &&
      !detachedFailureProofMatchesRequest(verification?.proofSnapshot, request)
    ) {
      throw new Error(
        "Detached provider cooldown evidence has not been recorded; rerun verification before closeout.",
      );
    }
  }
}

function detachedStaleRequestCarriesCooldownEvidence(
  request: DetachedVerificationRequestState,
) {
  if (request.status !== "STALE") {
    return false;
  }
  if (request.failureClass === "RATE_LIMIT") {
    return true;
  }
  const evidence = asJsonObject(request.evidence);
  if (typeof evidence.providerRetryNotBeforeAt !== "string") {
    return false;
  }
  const observedAt = parseProofDate(evidence.observedAt);
  const providerRetryNotBeforeAt = parseProofDate(
    evidence.providerRetryNotBeforeAt,
  );
  return Boolean(
    observedAt &&
    providerRetryNotBeforeAt &&
    providerRetryNotBeforeAt.toISOString() ===
      evidence.providerRetryNotBeforeAt &&
    providerRetryNotBeforeAt.getTime() > observedAt.getTime(),
  );
}

function parseProofDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function hasCourseMonitoringPersistence(client: unknown) {
  const candidate = client as {
    courseMonitoringStatus?: unknown;
    courseMonitoringEvent?: {
      create?: unknown;
      createMany?: unknown;
      findFirst?: unknown;
      findUnique?: unknown;
    };
  };
  return Boolean(
    candidate.courseMonitoringStatus &&
      candidate.courseMonitoringEvent &&
      typeof candidate.courseMonitoringEvent.create === "function" &&
      typeof candidate.courseMonitoringEvent.createMany === "function" &&
      typeof candidate.courseMonitoringEvent.findFirst === "function" &&
      typeof candidate.courseMonitoringEvent.findUnique === "function",
  );
}

function validateOwnerThread(ownerThreadId: string) {
  if (!ownerThreadId.trim()) {
    throw new Error("Course-support batch claim requires the current task id.");
  }
}

function validateTaskBranch(branch: string) {
  if (!branch.startsWith("automation/course-support-") || branch === "main") {
    throw new Error(
      "Course-support batch claim requires an automation/course-support-* task branch.",
    );
  }
}

function validateGitSha(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`Course-support ${label} must be a full Git SHA.`);
  }
}

function createCourseSupportBatchReference(now: Date) {
  return `support-${now
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

export function isTransientCourseSupportFailure(
  failureClass: CourseSupportFailureClass,
) {
  return TRANSIENT_FAILURE_CLASSES.has(failureClass);
}

export function canCloseCourseSupportRetry(
  failureClass: CourseSupportFailureClass,
  requestedOutcome?: ResponderOutcome,
) {
  return (
    isTransientCourseSupportFailure(failureClass) ||
    Boolean(
      requestedOutcome &&
      OPERATIONAL_RETRY_CLOSEOUT_OUTCOMES.has(requestedOutcome),
    )
  );
}
