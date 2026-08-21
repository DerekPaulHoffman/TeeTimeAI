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
  routeCourseSupportRemediation,
  type ActionableCourseSupportRemediationWorkMode,
  type CourseSupportRemediationAttemptSignature,
  type CourseSupportRemediationDirective,
  type CourseSupportRemediationRetryBudget,
  type CourseSupportRemediationRoute
} from "./course-support-remediation-routing";
import {
  getCourseMonitoringEscalationDeadline,
  getHumanReviewRetryAt,
  inferHumanReviewReason,
  reopenParkedCourseForResponderCampaignInTransaction,
  runSerializedCourseMonitoringWrite
} from "./course-monitoring";
import {
  planNextParkedCourseCampaignCohort,
  inspectActiveParkedCourseCampaign
} from "./course-support-campaign";
import { enqueueRemediatedCourseRechecks } from "./search-recheck-queue";
import { withPostgresAdvisoryTextLease } from "./lease";
import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  getProviderReadinessFailure,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY
} from "./provider-capabilities";
import {
  COURSE_SUPPORT_BATCH_LEASE_MS,
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
  readCourseSupportReleaseExecutionEvidence,
} from "./course-support-zero-execution";
import {
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
  compareCourseSupportGroupPriority,
  isCriticalRealDemand,
  selectCourseSupportBatch,
  type CourseSupportCandidate,
  type SelectedCourseSupportBatch
} from "./course-support-selection";
import { MONITORING_STRATEGY_ACTIONS, type MonitoringStrategyAction } from "./monitoring-strategy";

export {
  selectCourseSupportBatch,
  type CourseSupportCandidate,
  type RecentBatchFairnessEvidence,
  type SelectedCourseSupportBatch
} from "./course-support-selection";

const NEAR_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TIMELINESS_GRACE_MS = 15 * 60 * 1000;
const RECHECK_HEALTH_FRESHNESS_MS = 2 * 60 * 1000;
const DETACHED_FAILURE_FALLBACK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EXPIRED_UNRELEASED_BATCH_RETRY_DELAY_MS = 60 * 1000;
const COURSE_SUPPORT_WRITE_CONFLICT_MAX_ATTEMPTS = 3;
const COURSE_SUPPORT_WRITE_CONFLICT_BACKOFF_MS = 25;
const COURSE_SUPPORT_SERIALIZABLE_TRANSACTION_TIMEOUT_MS = 15_000;
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
      lastSuccessfulAt: true,
      failureFingerprint: true,
      nextAutomaticAttemptAt: true,
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
  completedAt: true
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
      batch: { select: { summary: true, releaseSha: true } }
    }
  },
  course: {
    select: {
      ...DETACHED_VERIFICATION_COURSE_SELECT,
      preferences: {
        where: {
          teeSearch: {
            status: "ACTIVE",
            trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] }
          }
        },
        select: { teeSearch: { select: { id: true, date: true } } }
      }
    }
  }
} satisfies Prisma.CourseSupportIncidentSelect;

type CourseSupportCandidateIncident = Prisma.CourseSupportIncidentGetPayload<{
  select: typeof COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT;
}>;

type CourseSupportClaimCandidate = CourseSupportCandidate & {
  playbookEventCountAtClaim: number;
};

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
  runnableCoverageProven?: boolean;
  scheduleVersion?: number | null;
  trafficClass?: string | null;
};

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

export function runWithCourseSupportWriterTransitionLease<T>(worker: () => Promise<T>) {
  return withPostgresAdvisoryTextLease(prisma, COURSE_SUPPORT_WRITER_LANE, worker);
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
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableCourseSupportWriteConflict(error)) {
        throw error;
      }
      await sleep(COURSE_SUPPORT_WRITE_CONFLICT_BACKOFF_MS * attempt);
    }
  }
  throw new Error("Course-support write-conflict retry exhausted unexpectedly.");
}

function isResponderSelectionEligible(input: {
  confirmedAt: Date | null | undefined;
  attemptLedger: unknown;
  cycle: number;
  activeRealSearchCount: number;
}) {
  if (input.confirmedAt != null) {
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

function runCourseSupportTransactionWithRetry<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) {
  return withCourseSupportWriteConflictRetry(() => prisma.$transaction(operation));
}

function runCourseSupportSerializableTransactionWithRetry<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) {
  return withCourseSupportWriteConflictRetry(() =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: COURSE_SUPPORT_SERIALIZABLE_TRANSACTION_TIMEOUT_MS
    })
  );
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
    retryBudget: route.retryBudget
      ? {
          maximumAttempts: route.retryBudget.maximumAttempts,
          attemptsCompleted: route.retryBudget.attemptsCompleted,
          attemptsRemaining: route.retryBudget.attemptsRemaining,
          exhausted: route.retryBudget.exhausted
        }
      : null
  } satisfies Prisma.InputJsonObject;
}

type PersistedCourseSupportRemediationDirective = CourseSupportRemediationDirective & {
  allowUnchangedRuntime: boolean;
  requiresImplementationPath: boolean;
  reason: string | null;
  retryBudget: CourseSupportRemediationRetryBudget | null;
};

function readCourseSupportRemediationDirective(
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
  const releaseProvenance = readCourseSupportReleaseProvenance(input.summary);
  if (
    !hasRuntimeBearingCourseSupportPath(readBatchPlannedPaths(input.summary)) ||
    !input.releaseSha ||
    input.releaseSha === input.baseSha ||
    !input.deployedAt ||
    !releaseProvenance ||
    releaseProvenance.toSha !== input.releaseSha ||
    !hasRuntimeBearingCourseSupportPath(releaseProvenance.committedPaths)
  ) {
    throw new Error(
      "This remediation route requires a runtime-bearing committed implementation path, a new release SHA, and deployment proof before verification."
    );
  }
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

function countCourseSupportPlaybookEvents(input: { attemptLedger: unknown; cycle: number;
}) {
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
  return {
    courseRef,
    providerSnapshotFingerprint,
    failureFingerprint,
    runtimeVersion,
    activeRealSearchCount,
    consumed: record.consumed,
    countsTowardOperationalNoProgress:
      typeof record.countsTowardOperationalNoProgress === "boolean"
        ? record.countsTowardOperationalNoProgress
        : null,
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
  const providerEvidenceNotBefore = input.deployedAt ?? input.batchCreatedAt;
  const providerExecutionAttemptProof =
    input.releaseSha &&
    input.deployedAt &&
    notBefore &&
    newestProbe?.providerExecution &&
    freshSearchCheckedAt &&
    freshSearchCheckedAt.getTime() >= notBefore.getTime() &&
    newestProbe.observedAt.getTime() >= providerEvidenceNotBefore.getTime() &&
    newestProbe.observedAt.getTime() >= notBefore.getTime()
      ? buildProbeProofSnapshot(newestProbe)
      : null;
  if (
    !releaseSha ||
    !input.deployedAt ||
    !notBefore ||
    !newestProbe ||
    newestProbe.id === input.preProbeId ||
    !freshSearchCheckedAt ||
    freshSearchCheckedAt.getTime() < notBefore.getTime() ||
    newestProbe.observedAt.getTime() < providerEvidenceNotBefore.getTime() ||
    freshSearchCheckedAt.getTime() <
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

export function buildCourseSupportResponderHandoff(input: {
  outcome: ResponderOutcome;
  hasExpiredBatch: boolean;
  ownedByCurrentTask: boolean;
  availableWriterSlots: number;
  ordinaryDispatchGroupCount: number;
  parkedCampaign: { status: string; readyCount: number } | null;
}): CourseSupportResponderHandoff {
  if (input.hasExpiredBatch && input.availableWriterSlots > 0) {
    return { action: "RECOVER", source: "EXPIRED_BATCH" };
  }
  if (input.ownedByCurrentTask) {
    return { action: "RESUME", source: "OWNED_BATCH" };
  }
  if (
    input.outcome === "ready" &&
    input.availableWriterSlots > 0 &&
    input.ordinaryDispatchGroupCount > 0
  ) {
    return {
      action: "CLAIM",
      source: "ORDINARY_DISPATCH",
      maxCourses: 5,
      selection: "ATOMIC_SERVER_SIDE",
    };
  }
  if (
    input.outcome === "ready" &&
    input.availableWriterSlots > 0 &&
    input.parkedCampaign?.status === "RUNNING" &&
    input.parkedCampaign.readyCount > 0
  ) {
    return {
      action: "CLAIM",
      source: "PARKED_CAMPAIGN",
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

export function shouldFinalizeSourceUnverified(input: {
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  attemptCount: number;
  activeRealSearchCount: number;
  firstSeenAt: Date;
  freshCycleStartedAt: Date | null;
  attemptLedger: unknown;
  cycle: number;
  verifiedAt: Date | null;
  result: CourseSupportBatchIncidentResult;
  now?: Date;
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
  return Boolean(
    input.result === "RETRY_SCHEDULED" &&
    freshPlaybookComplete &&
    input.verifiedAt &&
    input.verifiedAt.getTime() >= input.freshCycleStartedAt!.getTime() &&
    ((input.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
      input.failureClass === "MISSING_SOURCE") ||
      (input.providerFamilyKey === SOURCE_CONFLICT_PROVIDER_FAMILY &&
        input.failureClass === "MISSING_METADATA")),
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
  T extends { id: string; createdAt: Date; course: { name: string } },
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
  const [rawDueIncidents, activeBatches, expiredBatch, parkedCampaign] =
    await Promise.all([
      prisma.courseSupportIncident.findMany({
        where: dueWhere,
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
                select: {
                  teeSearch: { select: { id: true, date: true } },
                },
              },
            },
          },
        },
      }),
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
    ]);
  const activeBatch =
    activeBatches.find((batch) => batch.ownerThreadId === requestingThreadId) ??
    activeBatches[0] ??
    null;
  const activeProviderGroups = new Set(
    activeBatches.map(
      (batch) => `${batch.providerFamilyKey}\u0000${batch.failureFingerprint}`,
    ),
  );
  const dueDemand = rawDueIncidents.flatMap((incident) => {
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
  });
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
  const handoff = buildCourseSupportResponderHandoff({
    outcome,
    hasExpiredBatch: Boolean(expiredBatch),
    ownedByCurrentTask,
    availableWriterSlots,
    ordinaryDispatchGroupCount: readOnlyDispatchGroups.length,
    parkedCampaign,
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
  const now = input.now ?? new Date();
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

  const lease = await runWithCourseSupportWriterTransitionLease(async () => {
    const activeBatches = await prisma.courseSupportBatch.findMany({
      where: {
        status: { in: ACTIVE_BATCH_STATUSES },
        leaseExpiresAt: { gt: now },
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
        now,
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
        now,
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

    const [initialCandidates, recentBatches, retryBatch] = await Promise.all([
      listDueCourseSupportCandidates(now),
      prisma.courseSupportBatch.findMany({
        where: { completedAt: { not: null } },
        orderBy: { completedAt: "desc" },
        take: COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
        select: {
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
        },
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
          now,
          maxCourses: Math.min(maxCourses, 5),
          runtimeVersion: input.baseSha,
          hasDueRealDemand: initialCandidates.some(
            (candidate) => candidate.activeRealSearchCount > 0,
          ),
          activeProviderGroups,
        });
    const campaignCandidates = await listParkedCourseCampaignCandidates(
      campaignPlan,
      now,
    );
    const allCandidates = [...campaignCandidates, ...initialCandidates];
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
          now,
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
        now,
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
    const fairnessEvidence = recentBatches.map((batch) => ({
      includedEngineeringOnly: batch.incidents.some(
        (entry) => entry.incident.engineeringOnly,
      ),
      includedCriticalRealDemand: batch.incidents.some((entry) =>
        isHistoricalCriticalRealDemand(entry.incident, now),
      ),
    }));
    const selected = retryBatch
      ? selectCourseSupportRetryBatch({
          candidates,
          retryBatch,
          retryOrdinal: input.retryOrdinal,
          maxCourses,
          now,
        })
      : (selectCourseSupportBatch({
          candidates: candidates.filter(
            (candidate) =>
              !candidate.campaign || candidate.activeRealSearchCount > 0,
          ),
          recentBatches: fairnessEvidence,
          maxCourses,
          now,
        }) ??
        selectCourseSupportBatch({
          candidates: candidates.filter(
            (candidate) =>
              Boolean(candidate.campaign) &&
              candidate.activeRealSearchCount === 0,
          ),
          recentBatches: fairnessEvidence,
          maxCourses: Math.min(maxCourses, 5),
          now,
        }));
    if (!selected) {
      const deferredForImplementation =
        implementationBlockedCandidates.length > 0;
      const outcome = deferredForImplementation
        ? "deferred_busy"
        : "no_due_work";
      const recorded = await recordRoutineResponderObservation({
        outcome,
        now,
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

    const selectedRemediationRoute = selected.incidents[0]?.remediationRoute;
    if (!selectedRemediationRoute || !selected.remediationDirective) {
      throw new Error(
        "Course-support remediation routing was unavailable; no batch was claimed.",
      );
    }
    const playbookEventCountAtClaimByIncidentId = new Map(
      candidates.map((candidate) => [
        candidate.id,
        candidate.playbookEventCountAtClaim,
      ]),
    );
    const remediationSummary = {
      ...serializeCourseSupportRemediationRoute(selectedRemediationRoute),
      attempts: selected.incidents.map((incident) => ({
        courseRef:
          incident.remediationCourseRef ??
          createCourseSupportRemediationCourseRef(incident.courseId),
        providerSnapshotFingerprint:
          incident.providerSnapshotFingerprint ?? "unknown",
        failureFingerprint: incident.failureFingerprint,
        runtimeVersion: input.baseSha,
        activeRealSearchCount: incident.activeRealSearchCount,
        playbookEventCountAtClaim:
          playbookEventCountAtClaimByIncidentId.get(incident.id) ?? 0,
        reason:
          incident.remediationRoute?.reason ?? selectedRemediationRoute.reason,
        approach:
          incident.remediationRoute?.attemptSignature ??
          selectedRemediationRoute.attemptSignature ??
          null,
      })),
    } satisfies Prisma.InputJsonObject;
    const campaignAttempts = selected.incidents.flatMap((incident) =>
      incident.campaign
        ? [
            {
              courseRef: createCourseSupportRemediationCourseRef(
                incident.courseId,
              ),
              runId: incident.campaign.runId,
              membershipDigest: incident.campaign.membershipDigest,
              cycle: incident.cycle,
            },
          ]
        : [],
    );
    const campaignSummary =
      campaignAttempts.length > 0
        ? ({
            kind: "PARKED_COHORT",
            attempts: campaignAttempts,
          } satisfies Prisma.InputJsonObject)
        : null;

    const selectedCourseIds = selected.incidents.map(
      (incident) => incident.courseId,
    );
    const newestProbes = await prisma.courseProbe.findMany({
      where: { courseId: { in: selectedCourseIds } },
      orderBy: { observedAt: "desc" },
      select: { id: true, courseId: true },
    });
    const preProbeByCourse = new Map<string, string>();
    for (const probe of newestProbes) {
      if (!preProbeByCourse.has(probe.courseId)) {
        preProbeByCourse.set(probe.courseId, probe.id);
      }
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS,
    );
    const conflictingInitialPaths = findConflictingResponderPaths(
      plannedPaths,
      activeBatches.flatMap((activeBatch) =>
        readBatchPlannedPaths(activeBatch.summary),
      ),
    );
    if (conflictingInitialPaths.length > 0) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now,
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
    const created = await prisma.$transaction(
      async (tx) => {
        const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
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
              now,
            });
          if (!reopened.admitted || reopened.cycle !== incident.cycle) {
            throw new Error(
              "A parked-course campaign member changed before atomic batch admission.",
            );
          }
        }
        const currentIncidents = await tx.courseSupportIncident.findMany({
          where: {
            id: { in: selected.incidents.map((incident) => incident.id) },
          },
          select: {
            id: true,
            cycle: true,
            revision: true,
            confirmedAt: true,
            attemptLedger: true,
            status: true,
            activeBatchId: true,
            engineeringOnly: true,
            updatedAt: true,
            course: {
              select: {
                ...DETACHED_VERIFICATION_COURSE_SELECT,
                preferences: {
                  where: {
                    teeSearch: {
                      status: "ACTIVE",
                      trafficClass: {
                        notIn: [...syntheticWebsiteTrafficClasses],
                      },
                    },
                  },
                  select: {
                    teeSearch: { select: { id: true, date: true } },
                  },
                },
              },
            },
          },
        });
        const currentIncidentById = new Map(
          currentIncidents.map((incident) => [incident.id, incident]),
        );
        for (const incident of selected.incidents) {
          const current = currentIncidentById.get(incident.id);
          if (!current) {
            throw new Error(
              "Course-support demand changed during claim; rerun selection.",
            );
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
              now,
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
        let reconciledAuthoritativeFinalCount = 0;
        for (const incident of selected.incidents) {
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
              resolvedAt: now,
              resolution: authoritativeResolution.resolution,
              resolutionMessage: authoritativeResolution.message,
              nextAction: null,
              nextAttemptAt: null,
              nextReminderAt: null,
              lastSeenAt: now,
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
        if (input.retryOrdinal !== undefined) {
          const outsideDueFetchFailures =
            await tx.courseSupportIncident.findMany({
              where: {
                ...buildDueResponderIncidentWhere(now),
                id: {
                  notIn: selected.incidents.map((incident) => incident.id),
                },
                kind: "FETCH_FAILED",
              },
              select: {
                cycle: true,
                confirmedAt: true,
                attemptLedger: true,
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
                      select: {
                        teeSearch: { select: { id: true, date: true } },
                      },
                    },
                  },
                },
              },
            });
          const outsideCriticalDemandAppeared = outsideDueFetchFailures.some(
            (incident) => {
              const { course } = incident;
              const currentDemand = deriveCourseSupportCurrentDemand(
                course.preferences,
                {
                  timeZone: course.timeZone,
                  now,
                },
              );
              return Boolean(
                isResponderSelectionEligible({
                  confirmedAt: incident.confirmedAt,
                  attemptLedger: incident.attemptLedger,
                  cycle: incident.cycle,
                  activeRealSearchCount: currentDemand.activeRealSearchCount,
                }) &&
                currentDemand.activeRealSearchCount > 0 &&
                currentDemand.earliestTargetDate &&
                currentDemand.earliestTargetDate.getTime() <=
                  now.getTime() + NEAR_DATE_WINDOW_MS,
              );
            },
          );
          if (outsideCriticalDemandAppeared) {
            throw new Error(
              "A targeted responder retry cannot bypass due critical real-demand work.",
            );
          }
        }
        const automationRun = await tx.automationRun.create({
          data: {
            promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
            kind: "COURSE_SUPPORT",
            status: "RUNNING",
            runtimeVersion: input.baseSha,
            ownerThreadId: input.ownerThreadId,
            heartbeatAt: now,
            notes: JSON.stringify({
              schemaVersion: 1,
              lifecycle: "claimed",
              branch: input.branch,
              baseSha: input.baseSha,
              plannedPaths,
              incidentCount: selected.incidents.length,
              fairnessReason: selected.fairnessReason,
              remediation: remediationSummary,
              ...(campaignSummary ? { campaign: campaignSummary } : {}),
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
            reference: createCourseSupportBatchReference(now),
            providerFamilyKey: selected.providerFamilyKey,
            failureFingerprint: selected.failureFingerprint,
            status: plannedPaths.length > 0 ? "IMPLEMENTING" : "CLAIMED",
            ownerAutomationRunId: automationRun.id,
            ownerThreadId: input.ownerThreadId,
            leaseToken,
            leaseExpiresAt,
            heartbeatAt: now,
            baseSha: input.baseSha,
            maxCourses,
            summary: {
              schemaVersion: 1,
              branch: input.branch,
              plannedPaths,
              fairnessReason: selected.fairnessReason,
              remediation: remediationSummary,
              ...(campaignSummary ? { campaign: campaignSummary } : {}),
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
              containsCriticalRealDemand: selected.containsCriticalRealDemand,
              selectedIncidentCount: selected.incidents.length,
            },
          },
          select: { id: true, reference: true },
        });
        await tx.courseSupportBatchIncident.createMany({
          data: selected.incidents.map((incident) => ({
            batchId: batch.id,
            incidentId: incident.id,
            courseId: incident.courseId,
            cycle: incident.cycle,
            preProbeId: preProbeByCourse.get(incident.courseId) ?? null,
          })),
        });
        for (const incident of selected.incidents) {
          const retrySourceEntry =
            retryBatch && input.retryOrdinal !== undefined
              ? retryBatch.incidents[input.retryOrdinal - 1]
              : null;
          const claimed = await tx.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              cycle: incident.cycle,
              providerFamilyKey: incident.providerFamilyKey,
              failureFingerprint: incident.failureFingerprint,
              updatedAt:
                currentIncidentById.get(incident.id)?.updatedAt ??
                incident.updatedAt,
              status: "AUTO_INVESTIGATING",
              activeBatchId: null,
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
              ...(retryBatch?.completedAt
                ? {
                    nextAttemptAt: {
                      gt: retryBatch.completedAt,
                      lte: now,
                    },
                  }
                : {
                    OR: [
                      { nextAttemptAt: null },
                      { nextAttemptAt: { lte: now } },
                    ],
                  }),
            },
            data: {
              activeBatchId: batch.id,
              activeRealSearchCount: incident.activeRealSearchCount,
              earliestTargetDate: incident.earliestTargetDate,
              engineeringOnly: incident.engineeringOnly,
              lastAttemptAt: now,
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
            data: selected.incidents.map((incident) => ({
              courseId: incident.courseId,
              incidentId: incident.id,
              eventType: "AUTOMATION_ATTEMPTED" as const,
              source: "COURSE_SUPPORT_RESPONDER" as const,
              fromState: incident.humanReviewReason
                ? ("ENGINEERING_VERIFICATION_NEEDED" as const)
                : ("AUTO_INVESTIGATING" as const),
              toState: incident.humanReviewReason
                ? ("ENGINEERING_VERIFICATION_NEEDED" as const)
                : ("AUTO_INVESTIGATING" as const),
              failureFingerprint: incident.failureFingerprint,
              readPath: "BOUNDED_RECOVERY_PLAYBOOK",
              message:
                "The responder claimed a bounded provider-family recovery attempt.",
              occurredAt: now,
              audit: {
                providerFamilyKey: selected.providerFamilyKey,
                maxCourses,
                serializedWriterLane: true,
                ...(incident.campaign
                  ? {
                      campaignKind: "PARKED_COHORT",
                      campaignRunId: incident.campaign.runId,
                      campaignMembershipDigest:
                        incident.campaign.membershipDigest,
                      cycle: incident.cycle,
                    }
                  : {}),
                customerDataIncluded: false,
              },
            })),
          });
          const humanReviewCourseIds = selected.incidents.flatMap((incident) =>
            incident.humanReviewReason ? [incident.courseId] : [],
          );
          const automatedCourseIds = selected.incidents.flatMap((incident) =>
            incident.humanReviewReason ? [] : [incident.courseId],
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
              stateChangedAt: now,
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
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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

    return {
      outcome: "ready" as const,
      batchRef: created.batchRef,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      providerFamilyKey: selected.providerFamilyKey,
      failureFingerprint: selected.failureFingerprint,
      incidentCount: selected.incidents.length,
      leverage: {
        providerGroupCount: 1,
        currentAffectedCourseCount: selected.incidents.length,
        activeRealDemandCount: selected.incidents.reduce(
          (total, incident) => total + incident.activeRealSearchCount,
          0,
        ),
        futureSiblingApplicability: ![
          SOURCE_MISSING_PROVIDER_FAMILY,
          SOURCE_CONFLICT_PROVIDER_FAMILY,
        ].includes(selected.providerFamilyKey as never),
      },
      fairnessReason: selected.fairnessReason,
      containsCriticalRealDemand: selected.containsCriticalRealDemand,
      remediation: selected.remediationDirective
        ? {
            ...selected.remediationDirective,
            allowUnchangedRuntime:
              selected.incidents[0]?.remediationRoute?.allowUnchangedRuntime ??
              false,
            requiresImplementationPath:
              selected.incidents[0]?.remediationRoute
                ?.requiresImplementationPath ?? false,
            reason: selected.incidents[0]?.remediationRoute?.reason ?? null,
          }
        : null,
      parkedForMaterialChangeCount,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "The claimed responder batch is still in progress.",
    };
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
    failureFingerprint: batch.failureFingerprint,
    claimedAt: batch.createdAt.toISOString(),
    remediation: remediationDirective,
    courses: orderCourseSupportBatchIncidents(batch.incidents).map(
      (entry, index) => {
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
        return {
          ordinal: String(index + 1).padStart(2, "0"),
          providerFamilyKey: entry.course.providerFamilyKey,
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
          playbookExhausted: isAutomationPlaybookExhausted(
            entry.incident.attemptLedger,
            entry.cycle,
          ),
          playbookConclusion: playbook.conclusion,
          nextPlaybookStage: playbook.nextStage,
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
          website: true,
          detectedBookingUrl: true,
          detectedPlatform: true,
          providerFamilyKey: true,
          bookingMetadata: true,
          monitoringMode: true,
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
          replayed: true,
          leaseExpiresAt: batch.leaseExpiresAt,
          result: result.result,
        };
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
      return { replayed: false, leaseExpiresAt, result: result.result };
    },
  );

  if (!persisted) {
    return courseSupportSourceSearchRecoveryRequired();
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
    throw new Error(
      "Course-support ordinal is not present in the owned batch.",
    );
  }
  const playbook = assessAutomationPlaybook(
    entry.incident.attemptLedger,
    entry.cycle,
  );
  const officialIdentity = playbook.stages.find(
    (stage) => stage.stage === "OFFICIAL_IDENTITY",
  );
  const provider = resolveProviderCapability(entry.course);
  if (
    entry.result !== "PENDING" ||
    entry.cycle !== entry.incident.cycle ||
    entry.incident.status !== "AUTO_INVESTIGATING" ||
    entry.incident.activeBatchId !== input.batchId ||
    entry.incident.kind !== "NEEDS_ADAPTER" ||
    entry.incident.providerFamilyKey !== SOURCE_MISSING_PROVIDER_FAMILY ||
    entry.incident.failureClass !== "MISSING_SOURCE" ||
    entry.course.providerFamilyKey !== SOURCE_MISSING_PROVIDER_FAMILY ||
    entry.course.website !== null ||
    entry.course.detectedBookingUrl !== null ||
    provider.capability ||
    entry.course.monitoringMode === "LOCAL_READER_ONLY" ||
    entry.incident.resolution !== null ||
    entry.course.monitoringStatus?.state === "FINAL_MANUAL" ||
    entry.course.monitoringStatus?.state === "FINAL_IDENTITY" ||
    !playbook.valid ||
    officialIdentity?.applicability !== "APPLICABLE" ||
    officialIdentity.attemptCount < 1 ||
    !officialIdentity.completedAt ||
    (input.requireRenderedStage &&
      playbook.nextStage !== "RENDERED_BROWSER_DISCOVERY")
  ) {
    throw new Error(
      "Exact source search is not eligible for this owned incident cycle.",
    );
  }
  const searchContext = buildCourseSupportSourceSearchContext(entry.course);
  const scopeDigest = buildCourseSupportSourceSearchScopeDigest({
    batchId: input.batchId,
    incidentId: entry.incident.id,
    cycle: entry.cycle,
  });
  return {
    entry,
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
  return (
    course.length === 1 && incident.length === 1 && batchEntry.length === 1
  );
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
  return (
    audit.result === result.result && event.evidenceUrl === result.candidateUrl
  );
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
  releaseAdvanceProof?: CourseSupportReleaseAdvanceProof;
  now?: Date;
};

export async function heartbeatCourseSupportBatch(
  input: CourseSupportHeartbeatInput,
) {
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
      ...(releaseSummary
        ? { summary: releaseSummary as Prisma.InputJsonValue }
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

export async function verifyCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  releaseSha?: string | null;
  deployedAt?: Date | null;
  now?: Date;
}) {
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
    readCourseSupportRemediationDirective(batch.summary)
      ?.allowUnchangedRuntime === false
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
          batch.recheckDispatchStartedAt,
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
  await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
    const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
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
    dispatchError: boolean;
  } | null = null;
  if (releaseSha && deployedAt && recheckBatchIncidentIds.length > 0) {
    try {
      const scheduled = await scheduleCourseSupportVerificationRequests({
        batchId: batch.id,
        releaseSha,
        batchIncidentIds: recheckBatchIncidentIds,
        now,
      });
      detachedDispatch = {
        attempted: true,
        eligibleCount: scheduled.eligibleCount,
        createdCount: scheduled.createdCount,
        ineligibleCount: scheduled.ineligibleCount,
        dispatchError: false,
      };
    } catch {
      detachedDispatch = {
        attempted: true,
        eligibleCount: 0,
        createdCount: 0,
        ineligibleCount: recheckBatchIncidentIds.length,
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
  const detachedVerificationRerun = summarizeDetachedVerificationRerun({
    requests: detachedRequestStates,
    verificationByBatchIncidentId: new Map(
      verifications.map(({ entry, verification }) => [entry.id, verification]),
    ),
    currentFailureBatchIncidentIds: currentDetachedFailureBatchIncidentIds,
  });
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
      const dispatched = await enqueueRemediatedCourseRechecks(
        recheckCourseIds,
        undefined,
        recheckDispatchKey ?? undefined,
      );
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
        detachedVerificationPendingCount:
          detachedVerificationRerun.pendingCount,
        detachedVerificationRerunNeeded: detachedVerificationRerun.rerunNeeded,
        affectedSearchRefs: dispatched.affectedSearchRefs,
        dispatchError: !dispatchComplete,
      };
      if (dispatchComplete) {
        recheckDispatchedAt = now;
      }
    } catch (error) {
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
        detachedVerificationPendingCount:
          detachedVerificationRerun.pendingCount,
        detachedVerificationRerunNeeded: detachedVerificationRerun.rerunNeeded,
        dispatchError: true,
        error: sanitizeResponderText(
          error instanceof Error
            ? error.message
            : "Course-remediation recheck dispatch failed.",
        ),
      };
    }
    const persisted = await runCourseSupportTransactionWithRetry(async (tx) => {
      for (const search of scheduledSearches) {
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
      return tx.courseSupportBatch.updateMany({
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
          }
        : {}),
      detachedVerificationPendingCount: detachedVerificationRerun.pendingCount,
      detachedVerificationRerunNeeded: detachedVerificationRerun.rerunNeeded,
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
      detachedVerificationPendingCount: detachedVerificationRerun.pendingCount,
      detachedVerificationRerunNeeded: detachedVerificationRerun.rerunNeeded,
      dispatchError: false,
      reason: "FINAL_DISPOSITION_ONLY",
    };
  }

  let verifiedSearchExecutionFence: CourseSupportSearchExecutionFenceSnapshot | null =
    verificationSearchExecutionFence;
  let searchExecutionFenceRerunNeeded =
    !verificationSearchExecutionFence.settled;
  if (recheckDispatchedAt && recheckDispatchStartedAt) {
    const health = await assessRemediatedSearchHealth(
      batch.id,
      courseIds,
      recheckDispatchStartedAt,
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
        return tx.courseSupportBatch.updateMany({
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
    detachedVerification: detachedVerificationRerun,
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
    const latestProbeByCourse = new Map<string, FreshProbeEvidence>();
    for (const probe of search.probes) {
      if (!latestProbeByCourse.has(probe.courseId)) {
        latestProbeByCourse.set(probe.courseId, probe);
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
        (candidate) =>
          candidate.courseId === courseId &&
          input.deployedAt &&
          scheduleIsCurrent &&
          freshSearchCheckedAt &&
          freshSearchCheckedAt.getTime() >= input.dispatchedAt.getTime() &&
          candidate.providerExecution &&
          candidate.observedAt.getTime() >= input.deployedAt.getTime() &&
          candidate.observedAt.getTime() >= input.dispatchedAt.getTime(),
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
      const hasFreshRunnableProof = Boolean(
        input.releaseSha &&
        input.deployedAt &&
        scheduleIsCurrent &&
        freshSearchCheckedAt &&
        freshSearchCheckedAt.getTime() >= input.dispatchedAt.getTime() &&
        probe &&
        probe.runtimeVersion === input.releaseSha &&
        probe.observedAt.getTime() >= input.deployedAt.getTime() &&
        probe.providerExecution &&
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
    providerAttempts.sort(
      (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
    );
    if (providerAttempts[0]) {
      freshProviderAttemptByCourse.set(courseId, providerAttempts[0]);
    }

    const affected = affectedCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const healthy = healthyCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const candidates = candidateProofsByCourse.get(courseId) ?? [];
    if (healthy !== affected || candidates.length === 0) {
      continue;
    }
    candidates.sort(
      (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
    );
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
    return (
      expectedVersion !== undefined &&
      dispatch.scheduleVersion === expectedVersion
    );
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
            providerExecution:
              asJsonObject(probe.rawSummary).providerExecution ===
              "RUNNABLE_PROVIDER_CHECK",
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
  if (!search.workflowRunId) {
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
}) {
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
    failureFingerprint === input.incidentFailureFingerprint
  ) {
    return null;
  }
  const event = input.monitoringEvents?.[0];
  const audit = asJsonObject(event?.audit);
  const failureClass = audit.failureClass;
  if (
    !event ||
    event.failureFingerprint !== failureFingerprint ||
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
    failureFingerprint,
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

async function closeoutCourseSupportBatchAttempt(
  input: CloseoutCourseSupportBatchInput,
) {
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
          course: {
            select: DETACHED_VERIFICATION_COURSE_SELECT,
          },
        },
      },
    },
  });
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
      (entry.result === "PENDING" ||
        entry.result === "STALE_EVIDENCE" ||
        entry.result === "RETRY_SCHEDULED")
    ) {
      const sourceUnverifiedFinal = shouldFinalizeSourceUnverified({
        providerFamilyKey: entry.incident.providerFamilyKey,
        failureClass: entry.incident.failureClass,
        attemptCount: entry.incident.attemptCount,
        activeRealSearchCount: entry.incident.activeRealSearchCount,
        firstSeenAt: entry.incident.firstSeenAt,
        freshCycleStartedAt: entry.incident.confirmedAt,
        attemptLedger: entry.incident.attemptLedger,
        cycle: entry.incident.cycle,
        verifiedAt: entry.verifiedAt,
        result: entry.result,
        now,
      });
      if (sourceUnverifiedFinal) {
        // The complete source-specific proof is normalized by the next branch.
      } else {
        if (
          shouldContinueSettledCourseSupportRemediation({
            remediationDirective,
            failureClass: retryFailureClass,
            attemptCount: entry.incident.attemptCount,
            playbookConclusion: playbookAssessment.conclusion,
            nextPlaybookStage: playbookAssessment.nextStage,
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
    }
    if (
      shouldFinalizeSourceUnverified({
        providerFamilyKey: entry.incident.providerFamilyKey,
        failureClass: entry.incident.failureClass,
        attemptCount: entry.incident.attemptCount,
        activeRealSearchCount: entry.incident.activeRealSearchCount,
        firstSeenAt: entry.incident.firstSeenAt,
        freshCycleStartedAt: entry.incident.confirmedAt,
        attemptLedger: entry.incident.attemptLedger,
        cycle: entry.incident.cycle,
        verifiedAt: entry.verifiedAt,
        result: entry.result,
        now,
      })
    ) {
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
          freshCycleStartedAt: entry.incident.confirmedAt!.toISOString(),
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
          nextAttemptAt: handoffRetryCandidates.reduce((latest, candidate) =>
            candidate.getTime() > latest.getTime() ? candidate : latest,
          ),
          materialChange:
            providerFamilyKey !== entry.incident.providerFamilyKey ||
            failureFingerprint !== entry.incident.failureFingerprint ||
            providerSnapshotChanged,
        },
      ] as const;
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
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective,
        failureClass: getEffectiveCourseSupportRetryFailureClass({
          incidentFailureClass: entry.incident.failureClass,
          proofSnapshot: entry.proofSnapshot,
        }),
        attemptCount: entry.incident.attemptCount,
        playbookConclusion: playbookAssessment.conclusion,
        nextPlaybookStage: playbookAssessment.nextStage,
      });
    const sourceUnverifiedHumanReview =
      normalizedProof.kind === "HUMAN_REVIEW_REQUIRED" &&
      normalizedProof.disposition === "SOURCE_UNVERIFIED";
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
      !canContinueIncompletePlaybook &&
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
  const closeoutRuntimeVersion = batch.releaseSha ?? batch.baseSha;
  const detachedRequestStatesAtCloseout =
    await prisma.courseSupportVerificationRequest.findMany({
      where: {
        batchIncident: { batchId: batch.id },
      },
      select: DETACHED_VERIFICATION_REQUEST_STATE_SELECT,
    });
  const providerExecutionStartedByBatchIncidentId = new Set(
    detachedRequestStatesAtCloseout.flatMap((request) =>
      request.startedAt !== null ? [request.batchIncidentId] : [],
    ),
  );
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
    const claimedImplementationPaths =
      readBatchPlannedPaths(batch.summary).length > 0;
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
    const providerAttemptRecorded = Boolean(
      historicalExecution.providerExecutionEverForCourse ||
      hasCurrentCourseSupportProviderExecutionProof({
        proofSnapshot: entry.proofSnapshot,
        baseSha: batch.baseSha,
        releaseSha: batch.releaseSha,
        claimedAt: batch.createdAt,
        recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      }),
    );
    const providerExecutionAttemptRecorded = Boolean(
      historicalExecution.providerExecutionAttemptEverForCourse ||
      hasCourseSupportProviderExecutionAttemptEvidence({
        proofSnapshot: entry.proofSnapshot,
        baseSha: batch.baseSha,
        releaseSha: batch.releaseSha,
        claimedAt: batch.createdAt,
        recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      }),
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
    const terminalResultRecorded = Boolean(
      historicalExecution.terminalExecutionEverForCourse ||
      (["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult) &&
        (isAuthoritativeFactualCourseMonitoringState(
          entry.course.monitoringStatus?.state,
        ) ||
          durableFactualBatchProofRecorded ||
          (!currentFailureIdentityByBatchIncidentId.get(entry.id)
            ?.materialChange &&
            (getAuthoritativeCourseMonitoringResolution(
              entry.course.monitoringStatus?.state,
            ) ||
              isDurableTerminalProof(entry, batch))))),
    );
    const consumed =
      deploymentRecorded ||
      providerAttemptRecorded ||
      playbookAttemptRecorded ||
      terminalResultRecorded;
    const countsTowardOperationalNoProgress = Boolean(
      consumed ||
      providerExecutionAttemptRecorded ||
      providerExecutionStartedByBatchIncidentId.has(entry.id),
    );
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
      runtimeVersion: batch.releaseSha ?? batch.baseSha,
      activeRealSearchCount: entry.incident.activeRealSearchCount,
      consumed,
      countsTowardOperationalNoProgress,
      executionEvidence: {
        claimedImplementationPaths,
        newReleaseRecorded,
        deploymentRecorded,
        postProbeRecorded,
        providerAttemptRecorded,
        providerExecutionAttemptRecorded,
        playbookAttemptRecorded,
        terminalResultRecorded,
        providerExecutionStarted: providerExecutionStartedByBatchIncidentId.has(
          entry.id,
        ),
      },
      approach: parseCourseSupportRemediationApproach(plannedAttempt.approach),
    } satisfies Prisma.InputJsonObject;
  });
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
      return {
        ...attempt,
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
    const factualMonitoringWinner =
      isAuthoritativeFactualCourseMonitoringState(
        entry.course.monitoringStatus?.state,
      ) ||
      (entry.normalizedResult === "FINAL_DISPOSITION" &&
        asJsonObject(entry.proofSnapshot).kind === "PLAYBOOK_FACTUAL_FINAL" &&
        isDurableTerminalProof(entry, batch));
    const staleResultAfterMaterialChange =
      !factualMonitoringWinner &&
      currentFailureIdentity.materialChange &&
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
    const remediationAttempt = closeoutRemediationAttempts.find(
      (attempt) =>
        attempt.courseRef ===
        createCourseSupportRemediationCourseRef(entry.courseId),
    );
    const currentCycleIsOrchestrationOnly = Boolean(
      remediationAttempt?.countsTowardOperationalNoProgress === false &&
      assessAutomationPlaybook(entry.incident.attemptLedger, entry.cycle)
        .completedStages.length === 0 &&
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
    const playbookAssessment = assessAutomationPlaybook(
      entry.incident.attemptLedger,
      entry.incident.cycle,
    );
    const canContinueIncompletePlaybook =
      playbookAssessment.conclusion === "INCOMPLETE" &&
      Boolean(playbookAssessment.nextStage) &&
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective,
        failureClass: getEffectiveCourseSupportRetryFailureClass({
          incidentFailureClass: entry.incident.failureClass,
          proofSnapshot: entry.proofSnapshot,
        }),
        attemptCount: entry.incident.attemptCount,
        playbookConclusion: playbookAssessment.conclusion,
        nextPlaybookStage: playbookAssessment.nextStage,
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
  const reusableFamilyRestoredCount = normalizedEntries.filter(
    (entry) =>
      entry.normalizedResult === "RESTORED" &&
      resolveProviderCapability(entry.course).providerFamilyKey ===
        batch.providerFamilyKey,
  ).length;
  const retryCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "RETRY_SCHEDULED",
  ).length;
  const restoredRequiringBatchDispatchCount = normalizedEntries.filter(
    (entry) =>
      entry.normalizedResult === "RESTORED" &&
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
  if (input.requestedOutcome) {
    if (DERIVED_CLOSEOUT_OUTCOMES.has(input.requestedOutcome)) {
      if (input.requestedOutcome !== derivedOutcome) {
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
  const outcome = input.requestedOutcome ?? derivedOutcome;
  const retryTimes: Date[] = [];
  const safeSummary = sanitizeResponderCloseoutSummary(input.summary);
  const remediationAttemptConsumed = closeoutRemediationAttempts.some(
    (attempt) => attempt.consumed,
  );
  const orchestrationOnlyCount = closeoutRemediationAttempts.filter(
    (attempt) => attempt.countsTowardOperationalNoProgress === false,
  ).length;
  let siblingWakeCount = 0;

  await runCourseSupportSerializableTransactionWithRetry(async (tx) => {
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
    const courseMonitoringAvailable = hasCourseMonitoringPersistence(tx);
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
        snapshotRequests.some((request) => request.startedAt !== null) ||
        freshRequests.some((request) => request.startedAt !== null) ||
        freshRequests.length !== snapshotRequests.length ||
        freshRequests.some(
          (request) =>
            !snapshotRequests.some((snapshot) => snapshot.id === request.id),
        )
      ) {
        throw new CourseSupportCloseoutSnapshotChangedError();
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
              startedAt: null,
              outcome: request.outcome,
              failureClass: request.failureClass,
              lastError: request.lastError,
            },
            data: { revision: { increment: 0 } },
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
      [...materialHandoffBatchIncidentIds].filter(
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
            lastSeenAt: now,
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
            lastSeenAt: now,
            revision: { increment: 1 },
          },
        });
        const monitoringUpdated = await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "HEALTHY",
          data: {
            state: "HEALTHY",
            lastSuccessfulAt: now,
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
          await tx.courseMonitoringEvent.create({
            data: {
              courseId: entry.courseId,
              incidentId: entry.incidentId,
              eventType: "RECOVERED",
              source: "COURSE_SUPPORT_RESPONDER",
              fromState: "AUTO_INVESTIGATING",
              toState: "HEALTHY",
              outcome: "NO_MATCH",
              message,
              runtimeVersion: batch.releaseSha,
              deploymentSha: batch.releaseSha,
              occurredAt: now,
              audit: {
                freshRuntimeProof: true,
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
            lastSeenAt: now,
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
        retryTimes.push(handoff.nextAttemptAt);
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
            firstSeenAt: now,
            confirmedAt: now,
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              now,
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
            lastSeenAt: now,
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
            lastSeenAt: now,
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
        const continueIncompletePlaybook =
          playbookAssessment.conclusion === "INCOMPLETE" &&
          Boolean(playbookAssessment.nextStage) &&
          shouldContinueSettledCourseSupportRemediation({
            remediationDirective,
            failureClass: effectiveFailureClass,
            attemptCount: entry.incident.attemptCount,
            playbookConclusion: playbookAssessment.conclusion,
            nextPlaybookStage: playbookAssessment.nextStage,
          });
        const watchContinuationAt =
          (verificationWatchMode === "WATCH_SETTLED" ||
            verificationWatchMode === "ENDPOINT") &&
          continueIncompletePlaybook
            ? new Date(now.getTime() + 60 * 1000)
            : null;
        const closeoutRemediationAttempt = closeoutRemediationAttempts.find(
          (attempt) =>
            attempt.courseRef ===
            createCourseSupportRemediationCourseRef(entry.courseId),
        );
        const currentCycleIsOrchestrationOnly = Boolean(
          closeoutRemediationAttempt?.countsTowardOperationalNoProgress ===
            false &&
          assessAutomationPlaybook(entry.incident.attemptLedger, entry.cycle)
            .completedStages.length === 0 &&
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
        const retryEscalationDeadline = closeoutRemediationAttempt
          ? currentCycleIsOrchestrationOnly
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
          closeoutRemediationAttempt && !closeoutRemediationAttempt.consumed
            ? closeoutRemediationAttempt.countsTowardOperationalNoProgress
              ? new Date(
                  now.getTime() + COURSE_SUPPORT_OPERATIONAL_RETRY_DELAY_MS,
                )
              : (orchestrationRetryByCourseRef.get(
                  closeoutRemediationAttempt.courseRef,
                )?.retryAt ?? null)
            : null;
        const normalNextAttemptAt =
          operationalRetryAt ??
          watchContinuationAt ??
          computeCourseSupportNextAttemptAt({
            failureClass: effectiveFailureClass,
            failureFingerprint: effectiveFailureFingerprint,
            attemptCount: Math.max(1, entry.incident.attemptCount),
            retryAfterSeconds: input.retryAfterSeconds,
            now,
          });
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
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt,
          },
          data: {
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            failureClass: effectiveFailureClass,
            failureFingerprint: effectiveFailureFingerprint,
            escalationDeadlineAt: retryEscalationDeadline,
            nextAttemptAt,
            latestMessage: message,
            lastSeenAt: now,
            revision: { increment: 1 },
          },
        });
        await persistCourseMonitoringCloseout({
          courseId: entry.courseId,
          snapshot: entry.course.monitoringStatus,
          targetState: "AUTO_INVESTIGATING",
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: effectiveFailureFingerprint,
            nextAutomaticAttemptAt: nextAttemptAt,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
      }
      if (incidentUpdated.count !== 1) {
        throw new CourseSupportCloseoutSnapshotChangedError();
      }
      if (entry.result !== entry.normalizedResult) {
        const batchEntryUpdated =
          await tx.courseSupportBatchIncident.updateMany({
            where: {
              id: entry.id,
              result: entry.result,
              updatedAt: entry.updatedAt,
            },
            data: { result: entry.normalizedResult },
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
              confirmedAt: now,
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
              lastSeenAt: now,
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
        lastError: "batch_closed",
        updatedAt: now,
      },
    });

    if (batch.ownerAutomationRunId) {
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
            verificationWatchMode,
            failureDomain: input.failureDomain ?? "NONE",
            remediationAttemptConsumed,
            siblingWakeCount,
          }),
        },
      });
    }
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
    automationStalledCount,
    operationalRetryBudgetExhaustedCount,
    providerFamilyHandoffCount,
    siblingWakeCount,
    notificationPendingCount: 0,
    leverage: {
      providerGroupResolvedCount:
        retryCount === 0 && needsHumanCount === 0 ? 1 : 0,
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
        restoredCount > 0 &&
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
    try {
      return await closeoutCourseSupportBatchAttempt(input);
    } catch (error) {
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
        leaseExpiresAt: true,
        ownerThreadId: true,
        ownerAutomationRunId: true,
        providerFamilyKey: true,
        failureFingerprint: true,
        baseSha: true,
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
              select: {
                monitoringStatus: {
                  select: {
                    state: true,
                    revision: true,
                    lastSuccessfulAt: true,
                  },
                },
              },
            },
            incident: {
              select: {
                status: true,
                resolution: true,
                decisionAt: true,
                cycle: true,
                attemptLedger: true,
                activeBatchId: true,
                failureFingerprint: true,
                activeRealSearchCount: true,
                escalationDeadlineAt: true,
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
    if (!batch || !ACTIVE_BATCH_STATUSES.includes(batch.status)) {
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: ["The requested responder batch is not recoverable."],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery needs owner attention.",
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
        const terminalCount = restoredCount + finalCount;
        const hasHuman = needsHumanCount > 0;
        const derivedOutcome: ResponderOutcome = hasHuman
          ? "needs_human"
          : terminalCount > 0
            ? "partial"
            : "retryable_failed";
        const batchStatus: CourseSupportBatchStatus =
          hasHuman || terminalCount > 0 ? "PARTIAL" : "RETRYABLE_FAILED";
        const closeoutReason =
          terminalIncidents.length > 0
            ? "expired_mixed_reconciled_without_adoption"
            : "expired_retry_reconciled_without_adoption";
        const retryFloor = new Date(
          now.getTime() + EXPIRED_UNRELEASED_BATCH_RETRY_DELAY_MS,
        );
        const retryAtByBatchIncidentId = new Map(
          retryIncidents.map((entry) => {
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
        let nextAttemptAt = [...retryAtByBatchIncidentId.values()].reduce(
          (earliest, candidate) =>
            candidate.getTime() < earliest.getTime() ? candidate : earliest,
        );
        const message =
          terminalIncidents.length > 0
            ? "Expired responder terminal decisions were reconciled and unresolved work was safely requeued without adopting local changes."
            : "Expired responder retry evidence was safely requeued without adopting local changes.";
        const verificationLastError =
          terminalIncidents.length > 0
            ? "batch_mixed_reconciled"
            : "batch_requeued";
        const terminalMessage =
          "Expired responder ownership was superseded by a later durable course decision.";
        const summary = asJsonObject(batch.summary);
        const plannedRemediationAttempts = Array.isArray(
          asJsonObject(summary.remediation).attempts,
        )
          ? (asJsonObject(summary.remediation).attempts as unknown[])
          : [];
        const safeRequeueOrchestrationOnlyEntryIds = new Set(
          retryIncidents.flatMap((entry) => {
            const historicalExecution =
              readCourseSupportReleaseExecutionEvidence({
                summary: batch.summary,
                baseSha: batch.baseSha,
                courseRef: createCourseSupportRemediationCourseRef(
                  entry.courseId,
                ),
              });
            if (
              (entry.verificationRequests ?? []).some(
                (request) => request.startedAt !== null,
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
            throw new Error(
              "Search execution changed during safe responder requeue.",
            );
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
            if (!safeRequeueOrchestrationOnlyEntryIds.has(entry.id)) return [];
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
            const countsTowardOperationalNoProgress =
              !safeRequeueOrchestrationOnlyEntryIds.has(entry.id);
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
                  claimedImplementationPaths:
                    readBatchPlannedPaths(batch.summary).length > 0,
                  newReleaseRecorded: false,
                  deploymentRecorded: false,
                  postProbeRecorded: false,
                  providerAttemptRecorded: false,
                  playbookAttemptRecorded: false,
                  terminalResultRecorded: false,
                  providerExecutionStarted: (
                    entry.verificationRequests ?? []
                  ).some((request) => request.startedAt !== null),
                },
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
        nextAttemptAt = [...retryAtByBatchIncidentId.values()].reduce(
          (earliest, candidate) =>
            candidate.getTime() < earliest.getTime() ? candidate : earliest,
        );
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
          for (const entryId of safeRequeueOrchestrationOnlyEntryIds) {
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
            if (
              snapshotRequests.some((request) => request.startedAt !== null) ||
              freshRequests.some((request) => request.startedAt !== null) ||
              freshRequests.length !== snapshotRequests.length ||
              freshRequests.some(
                (request) =>
                  !snapshotRequests.some(
                    (snapshot) => snapshot.id === request.id,
                  ),
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
                    startedAt: null,
                    outcome: request.outcome,
                    failureClass: request.failureClass,
                    lastError: request.lastError,
                  },
                  data: { revision: { increment: 0 } },
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
                  retryCount: retryIncidents.length,
                  needsHumanCount,
                  remediationAttemptConsumed: false,
                  remediationAttempts: safeRequeueRemediationAttempts,
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
                lastSeenAt: now,
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
            await tx.automationRun.updateMany({
              where: { id: batch.ownerAutomationRunId, completedAt: null },
              data: {
                kind: "COURSE_SUPPORT",
                status:
                  safeRequeueOrchestrationOnlyEntryIds.size > 0
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
                  retryCount: retryIncidents.length,
                  needsHumanCount,
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
          }
        });
        return {
          outcome: derivedOutcome,
          recovered: false,
          safelyRequeued: true,
          superseded: terminalIncidents.length > 0,
          durableCloseoutRecorded: true,
          nextAttemptAt: nextAttemptAt.toISOString(),
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
  now?: Date;
}) {
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
  return {
    kind: "PROVIDER_PROBE",
    outcome: probe.outcome,
    observedAt: probe.observedAt.toISOString(),
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
                  lastSeenAt: now,
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
                    ? { lastSuccessfulAt: incident.resolvedAt ?? now }
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
              lastSeenAt: now,
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

async function listDueCourseSupportCandidates(now: Date) {
  const incidents = await prisma.courseSupportIncident.findMany({
    where: buildDueResponderIncidentWhere(now),
    orderBy: [{ earliestTargetDate: "asc" }, { firstSeenAt: "asc" }],
    select: COURSE_SUPPORT_CANDIDATE_INCIDENT_SELECT,
  });
  return buildCourseSupportCandidates(incidents, now);
}

function buildCourseSupportCandidates(
  incidents: readonly CourseSupportCandidateIncident[],
  now: Date,
): CourseSupportClaimCandidate[] {
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
      providerFamilyKey: incident.providerFamilyKey,
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
      materialChanges: priorAttempt
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
    const remediationRoute = applyCourseSupportOperationalRetryBudget({
      route: routedRemediation,
      attemptsCompleted: operationalAttemptsCompleted,
    });
    return [
      {
        id: incident.id,
        courseId: incident.courseId,
        cycle: incident.cycle,
        kind: incident.kind,
        providerFamilyKey: incident.providerFamilyKey,
        failureClass: incident.failureClass,
        failureFingerprint: incident.failureFingerprint,
        humanReviewReason: incident.humanReviewReason,
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
        remediationDirective:
          getCourseSupportRemediationDirective(remediationRoute),
        remediationRoute,
        providerSnapshotFingerprint,
        remediationCourseRef: createCourseSupportRemediationCourseRef(
          incident.courseId,
        ),
        playbookEventCountAtClaim: countCourseSupportPlaybookEvents({
          attemptLedger: incident.attemptLedger,
          cycle: incident.cycle,
        }),
      },
    ];
  });
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
  const reopenedCycleCandidates = buildCourseSupportCandidates(
    incidents.flatMap((incident) => {
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
    }),
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
  return (
    batch.status === "IMPLEMENTING" ||
    readBatchPlannedPaths(batch.summary).length > 0
  );
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
  return (
    (verification.proofSnapshot as Prisma.InputJsonObject).kind ===
    "PROVIDER_VERIFICATION"
  );
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
    };
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
      freshSearchCheckedAt.getTime() >=
        batch.recheckDispatchStartedAt.getTime() &&
      freshSearchCheckedAt.getTime() >= entry.incident.lastSeenAt.getTime(),
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
      const playbook = assessAutomationPlaybook(
        entry.incident.attemptLedger,
        entry.incident.cycle,
      );
      return Boolean(
        proof.disposition === "SOURCE_UNVERIFIED" &&
        proof.providerFamilyKey === entry.incident.providerFamilyKey &&
        proof.failureClass === entry.incident.failureClass &&
        proof.attemptCount === entry.incident.attemptCount &&
        proof.activeRealSearchCount === entry.incident.activeRealSearchCount &&
        proof.cycle === entry.incident.cycle &&
        proof.completedStageCount === AUTOMATION_PLAYBOOK_STAGES.length &&
        ((entry.incident.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
          entry.incident.failureClass === "MISSING_SOURCE") ||
          (entry.incident.providerFamilyKey ===
            SOURCE_CONFLICT_PROVIDER_FAMILY &&
            entry.incident.failureClass === "MISSING_METADATA")) &&
        firstSeenAt?.getTime() === entry.incident.firstSeenAt.getTime() &&
        freshCycleStartedAt &&
        entry.incident.confirmedAt &&
        freshCycleStartedAt.getTime() ===
          entry.incident.confirmedAt.getTime() &&
        verifiedAt?.getTime() === entry.verifiedAt.getTime() &&
        verifiedAt &&
        verifiedAt.getTime() >= freshCycleStartedAt.getTime() &&
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
  const result: Record<string, number | boolean> = {};
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

function summarizeDetachedVerificationRerun(input: {
  requests: DetachedVerificationRequestState[];
  verificationByBatchIncidentId: Map<string, BatchIncidentVerification>;
  currentFailureBatchIncidentIds: Set<string>;
}) {
  const relevantRequests = input.requests.filter(
    (request) =>
      input.verificationByBatchIncidentId.get(request.batchIncidentId)
        ?.result !== "NEEDS_HUMAN",
  );
  const pendingCount = relevantRequests.filter(
    (request) => request.status === "QUEUED" || request.status === "CHECKING",
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
    courseMonitoringEvent?: unknown;
  };
  return Boolean(
    candidate.courseMonitoringStatus && candidate.courseMonitoringEvent,
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
