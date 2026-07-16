import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  AutomationReason,
  BookingMethod,
  CourseSupportBatchIncidentResult,
  CourseSupportBatchStatus,
  CourseSupportFailureClass,
  CourseSupportIncidentKind,
  ProbeOutcome
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  enqueueRemediatedCourseRechecks
} from "./search-recheck-queue";
import { withPostgresAdvisoryTextLease } from "./lease";
import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  getProviderReadinessFailure,
  resolveProviderCapability
} from "./provider-capabilities";
import {
  COURSE_SUPPORT_BATCH_LEASE_MS,
  COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
  COURSE_SUPPORT_SYNTHETIC_AGING_MS,
  COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  clampCourseSupportBatchSize,
  getResponderThreadPolicy,
  sanitizeResponderText,
  sanitizeResponderValue,
  type ResponderFailureDomain,
  type ResponderOutcome
} from "./course-support-responder-policy";
import {
  notifyCourseSupportIssueBatch,
  resolveCourseSupportIncident
} from "./support-incidents";

const REPOSITORY_WRITER_LEASE_KEY = "tee-time-spot:repository-writer";
const HOURLY_PROMPT_PREFIX = "tee-time-spot-improvement-loop-v";
const NEAR_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TIMELINESS_GRACE_MS = 15 * 60 * 1000;
const RECHECK_HEALTH_FRESHNESS_MS = 2 * 60 * 1000;
const ACTIVE_BATCH_STATUSES: CourseSupportBatchStatus[] = [
  "CLAIMED",
  "IMPLEMENTING",
  "VERIFYING"
];
const TRANSIENT_FAILURE_CLASSES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "SCHEMA",
  "UNKNOWN",
  "MISSING_SOURCE",
  "MISSING_METADATA",
  "UNSUPPORTED_FAMILY"
]);
const SUCCESSFUL_PROBE_OUTCOMES = new Set<ProbeOutcome>([
  "MATCH_FOUND",
  "NO_MATCH"
]);
const FINAL_BOOKING_METHODS = new Set<BookingMethod>([
  "PHONE_ONLY",
  "CONTACT_COURSE",
  "WALK_IN"
]);
const FINAL_AUTOMATION_REASONS = new Set<AutomationReason>([
  "AUTOMATION_PROHIBITED",
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

export type CourseSupportCandidate = {
  id: string;
  courseId: string;
  cycle: number;
  kind: CourseSupportIncidentKind;
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  failureFingerprint: string;
  engineeringOnly: boolean;
  activeRealSearchCount: number;
  earliestTargetDate: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastAttemptAt: Date | null;
  attemptCount: number;
  updatedAt: Date;
};

export type RecentBatchFairnessEvidence = {
  includedEngineeringOnly: boolean;
  includedCriticalRealDemand: boolean;
};

export type SelectedCourseSupportBatch = {
  providerFamilyKey: string;
  failureFingerprint: string;
  incidents: CourseSupportCandidate[];
  fairnessReason: "PRIORITY" | "AGED_SYNTHETIC_RESERVATION";
  containsCriticalRealDemand: boolean;
};

export type CourseSupportCourseEvidence = {
  isPublic: boolean;
  bookingMethod: BookingMethod;
  automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason: AutomationReason;
  latestDiscovery?: {
    status: string;
    bookingMethod: BookingMethod;
    automationEligibility: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
    automationReason: AutomationReason;
    sourceUrl: string;
    bookingUrl: string | null;
    confidence: number;
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
  scheduleVersion?: number | null;
  trafficClass?: string | null;
};

export type BatchIncidentVerification = {
  result: CourseSupportBatchIncidentResult;
  postProbeId: string | null;
  message: string;
  proofSnapshot: Prisma.InputJsonValue | null;
};

export function runWithRepositoryWriterTransitionLease<T>(
  worker: () => Promise<T>
) {
  return withPostgresAdvisoryTextLease(
    prisma,
    REPOSITORY_WRITER_LEASE_KEY,
    worker
  );
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

export async function getCourseSupportBatchRecoveryProvenance(batchId: string) {
  const batch = await prisma.courseSupportBatch.findUnique({
    where: { id: batchId },
    select: { baseSha: true, summary: true }
  });
  if (!batch) {
    throw new Error("Course-support batch was not found.");
  }
  const summary = asJsonObject(batch.summary);
  return {
    baseSha: batch.baseSha,
    branch: typeof summary.branch === "string" ? summary.branch : null,
    plannedPaths: Array.isArray(summary.plannedPaths)
      ? normalizePaths(
          summary.plannedPaths.filter(
            (path): path is string => typeof path === "string"
          )
        )
      : []
  };
}

export function selectCourseSupportBatch(input: {
  candidates: CourseSupportCandidate[];
  recentBatches?: RecentBatchFairnessEvidence[];
  maxCourses?: number;
  now?: Date;
}): SelectedCourseSupportBatch | null {
  const now = input.now ?? new Date();
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);
  const groups = new Map<string, CourseSupportCandidate[]>();

  for (const candidate of input.candidates) {
    const key = `${candidate.providerFamilyKey}\u0000${candidate.failureFingerprint}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const rankedGroups = [...groups.values()]
    .map((incidents) => incidents.sort((left, right) => compareCandidates(left, right, now)))
    .sort((left, right) => compareGroups(left, right, now));
  if (rankedGroups.length === 0) {
    return null;
  }

  const criticalGroups = rankedGroups.filter((group) =>
    group.some((candidate) => isCriticalRealDemand(candidate, now))
  );
  const recentFairnessWindow = (input.recentBatches ?? []).slice(
    0,
    COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW
  );
  const syntheticReservationDue =
    criticalGroups.length === 0 &&
    recentFairnessWindow.length >= COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW &&
    recentFairnessWindow.every(
      (batch) =>
        !batch.includedEngineeringOnly && !batch.includedCriticalRealDemand
    );
  const agedSyntheticGroup = rankedGroups
    .filter((group) =>
      group.some(
        (candidate) =>
          candidate.engineeringOnly &&
          now.getTime() - candidate.firstSeenAt.getTime() >=
            COURSE_SUPPORT_SYNTHETIC_AGING_MS
      )
    )
    .sort((left, right) => oldestSeenAt(left) - oldestSeenAt(right))[0];

  const selectedGroup =
    criticalGroups[0] ??
    (syntheticReservationDue ? agedSyntheticGroup : undefined) ??
    rankedGroups[0];
  const fairnessReason =
    selectedGroup === agedSyntheticGroup && syntheticReservationDue
      ? "AGED_SYNTHETIC_RESERVATION"
      : "PRIORITY";
  const containsCriticalRealDemand = selectedGroup.some((candidate) =>
    isCriticalRealDemand(candidate, now)
  );
  const selectedIncidents = containsCriticalRealDemand
    ? selectedGroup.slice(0, maxCourses)
    : reserveAgedSyntheticSlots(selectedGroup, maxCourses, now);

  return {
    providerFamilyKey: selectedGroup[0].providerFamilyKey,
    failureFingerprint: selectedGroup[0].failureFingerprint,
    incidents: selectedIncidents,
    fairnessReason,
    containsCriticalRealDemand
  };
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
      Math.max(60, Math.trunc(input.retryAfterSeconds ?? 0))
    );
    return new Date(now.getTime() + boundedSeconds * 1000);
  }

  const attemptIndex = Math.max(0, input.attemptCount - 1);
  const ladder = [15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60];
  const baseSeconds = ladder[Math.min(attemptIndex, ladder.length - 1)];
  const jitter = deterministicJitter(
    `${input.failureFingerprint}:${input.attemptCount}`
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
}): BatchIncidentVerification {
  const finalDisposition = getPersistedFinalDisposition(
    input.course,
    input.incidentLastSeenAt ??
      input.incidentFirstSeenAt ??
      input.batchCreatedAt
  );
  if (finalDisposition) {
    return {
      result: "FINAL_DISPOSITION",
      postProbeId: null,
      message: finalDisposition.message,
      proofSnapshot: finalDisposition.proofSnapshot
    };
  }

  const releaseSha = input.releaseSha?.trim();
  const newestProbe = input.newestProbe;
  const notBefore = input.recheckDispatchStartedAt;
  const freshSearchCheckedAt =
    newestProbe?.freshSearchCheckedAt ?? newestProbe?.observedAt;
  const providerEvidenceNotBefore = input.deployedAt ?? input.batchCreatedAt;
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
      proofSnapshot: null
    };
  }

  if (SUCCESSFUL_PROBE_OUTCOMES.has(newestProbe.outcome)) {
    return {
      result: "RESTORED",
      postProbeId: newestProbe.id,
      message:
        "The newest per-course workflow observation from the claimed release is runnable.",
      proofSnapshot: buildProbeProofSnapshot(newestProbe)
    };
  }

  return {
    result: "RETRY_SCHEDULED",
    postProbeId: newestProbe.id,
    message:
      "The newest per-course workflow observation from the claimed release is still not runnable.",
    proofSnapshot: buildProbeProofSnapshot(newestProbe)
  };
}

export function preserveExplicitHumanVerification(input: {
  result: CourseSupportBatchIncidentResult;
  engineeringOnly: boolean;
  postProbeId?: string | null;
  message?: string | null;
}): BatchIncidentVerification | null {
  if (input.result !== "NEEDS_HUMAN" || input.engineeringOnly) {
    return null;
  }
  return {
    result: "NEEDS_HUMAN",
    postProbeId: input.postProbeId ?? null,
    message:
      input.message ??
      "A concrete external action remains required after safe automated work.",
    proofSnapshot: null
  };
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
    const safelyCommittedPlannedChange =
      !input.releaseSha &&
      input.baseIsAncestor === true &&
      (input.committedPaths ?? []).length > 0 &&
      (input.committedPaths ?? []).every((path) =>
        input.plannedPaths.includes(path)
      );
    if (!safelyCommittedPlannedChange) {
      reasons.push("The checkout HEAD does not match the batch provenance.");
    }
  }
  const plannedPaths = new Set(input.plannedPaths);
  const unplannedDirtyPaths = input.dirtyPaths.filter(
    (path) => !plannedPaths.has(path)
  );
  if (unplannedDirtyPaths.length > 0) {
    reasons.push(
      `Dirty paths are outside the batch plan: ${unplannedDirtyPaths.join(", ")}`
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

export function shouldDispatchRemediatedCourseRechecks(input: {
  persistedReleaseSha: string | null;
  persistedDeployedAt: Date | null;
  nextReleaseSha: string | null | undefined;
  nextDeployedAt: Date | null | undefined;
}) {
  const releaseSha = input.nextReleaseSha ?? input.persistedReleaseSha;
  return Boolean(
    !input.persistedDeployedAt &&
      releaseSha &&
      input.nextDeployedAt
  );
}

export async function inspectCourseSupportQueue(input?: { now?: Date }) {
  const now = input?.now ?? new Date();
  const dueWhere = {
    status: "AUTO_INVESTIGATING" as const,
    activeBatchId: null,
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
  };
  const [dueIncidents, activeBatch, expiredBatch, activeHourlyRun] =
    await Promise.all([
      prisma.courseSupportIncident.findMany({
        where: dueWhere,
        select: {
          providerFamilyKey: true,
          failureFingerprint: true,
          engineeringOnly: true,
          activeRealSearchCount: true
        }
      }),
      prisma.courseSupportBatch.findFirst({
        where: {
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { gt: now }
        },
        orderBy: { heartbeatAt: "desc" },
        select: {
          id: true,
          reference: true,
          status: true,
          leaseExpiresAt: true,
          providerFamilyKey: true
        }
      }),
      prisma.courseSupportBatch.findFirst({
        where: {
          status: { in: ACTIVE_BATCH_STATUSES },
          leaseExpiresAt: { lte: now }
        },
        orderBy: { leaseExpiresAt: "asc" },
        select: {
          id: true,
          reference: true,
          status: true,
          leaseExpiresAt: true
        }
      }),
      findActiveHourlyWriter()
    ]);

  const providerGroups = new Set(
    dueIncidents.map(
      (incident) =>
        `${incident.providerFamilyKey}\u0000${incident.failureFingerprint}`
    )
  );
  const dueRealCount = dueIncidents.filter(
    (incident) => incident.activeRealSearchCount > 0 && !incident.engineeringOnly
  ).length;
  const dueEngineeringCount = dueIncidents.filter(
    (incident) => incident.engineeringOnly
  ).length;
  const outcome: ResponderOutcome =
    activeBatch || activeHourlyRun
      ? "deferred_busy"
      : expiredBatch
        ? "recovery_required"
        : dueIncidents.length === 0
          ? "no_due_work"
          : "ready";
  const durableCloseoutRecorded =
    outcome === "no_due_work" || outcome === "deferred_busy"
      ? await recordRoutineResponderObservation({
          outcome,
          now,
          summary: {
            dueIncidentCount: dueIncidents.length,
            dueRealCount,
            dueEngineeringCount,
            providerGroupCount: providerGroups.size,
            activeBatch: Boolean(activeBatch),
            activeHourlyWriter: Boolean(activeHourlyRun)
          }
        })
      : false;
  const policy = getResponderThreadPolicy({
    outcome,
    durableCloseoutRecorded:
      outcome === "no_due_work" || outcome === "deferred_busy"
        ? durableCloseoutRecorded
        : true
  });

  return {
    outcome,
    observedAt: now.toISOString(),
    dueIncidentCount: dueIncidents.length,
    dueRealCount,
    dueEngineeringCount,
    providerGroupCount: providerGroups.size,
    activeWriter: activeBatch
      ? {
          kind: "COURSE_SUPPORT_BATCH" as const,
          batchRef: activeBatch.reference,
          status: activeBatch.status,
          providerFamilyKey: activeBatch.providerFamilyKey,
          leaseExpiresAt: activeBatch.leaseExpiresAt.toISOString()
        }
      : activeHourlyRun
        ? {
            kind: "HOURLY_IMPROVEMENT" as const,
            startedAt: activeHourlyRun.startedAt.toISOString(),
            requiresExplicitRecovery: true
          }
        : null,
    expiredBatch: expiredBatch
      ? {
          batchRef: expiredBatch.reference,
          status: expiredBatch.status,
          leaseExpiredAt: expiredBatch.leaseExpiresAt.toISOString()
        }
      : null,
    durableCloseoutRecorded,
    ...policy
  };
}

export async function claimCourseSupportBatch(input: {
  ownerThreadId: string;
  branch: string;
  baseSha: string;
  plannedPaths?: string[];
  maxCourses?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  validateOwnerThread(input.ownerThreadId);
  validateTaskBranch(input.branch);
  validateGitSha(input.baseSha, "base SHA");
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);

  const lease = await runWithRepositoryWriterTransitionLease(async () => {
    const [activeBatch, activeHourlyRun] = await Promise.all([
      prisma.courseSupportBatch.findFirst({
        where: {
          status: { in: ACTIVE_BATCH_STATUSES }
        },
        orderBy: { heartbeatAt: "desc" },
        select: { id: true, leaseExpiresAt: true, status: true }
      }),
      findActiveHourlyWriter()
    ]);
    if (
      activeBatch &&
      activeBatch.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      return {
        outcome: "recovery_required" as const,
        durableCloseoutRecorded: false,
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "An expired responder batch must be recovered before new work is claimed."
      };
    }
    if (activeBatch || activeHourlyRun) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "deferred_busy",
        now,
        summary: {
          activeBatch: Boolean(activeBatch),
          activeHourlyWriter: Boolean(activeHourlyRun)
        }
      });
      return {
        outcome: "deferred_busy" as const,
        durableCloseoutRecorded: recorded,
        ...getResponderThreadPolicy({
          outcome: "deferred_busy",
          durableCloseoutRecorded: recorded
        })
      };
    }

    const [candidates, recentBatches] = await Promise.all([
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
                  earliestTargetDate: true
                }
              }
            }
          }
        }
      })
    ]);
    const selected = selectCourseSupportBatch({
      candidates,
      recentBatches: recentBatches.map((batch) => ({
        includedEngineeringOnly: batch.incidents.some(
          (entry) => entry.incident.engineeringOnly
        ),
        includedCriticalRealDemand: batch.incidents.some((entry) =>
          isHistoricalCriticalRealDemand(entry.incident, now)
        )
      })),
      maxCourses,
      now
    });
    if (!selected) {
      const recorded = await recordRoutineResponderObservation({
        outcome: "no_due_work",
        now,
        summary: { dueIncidentCount: 0 }
      });
      return {
        outcome: "no_due_work" as const,
        durableCloseoutRecorded: recorded,
        ...getResponderThreadPolicy({
          outcome: "no_due_work",
          durableCloseoutRecorded: recorded
        })
      };
    }

    const selectedCourseIds = selected.incidents.map(
      (incident) => incident.courseId
    );
    const newestProbes = await prisma.courseProbe.findMany({
      where: { courseId: { in: selectedCourseIds } },
      orderBy: { observedAt: "desc" },
      select: { id: true, courseId: true }
    });
    const preProbeByCourse = new Map<string, string>();
    for (const probe of newestProbes) {
      if (!preProbeByCourse.has(probe.courseId)) {
        preProbeByCourse.set(probe.courseId, probe.id);
      }
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
    const plannedPaths = normalizePaths(input.plannedPaths ?? []);
    const created = await prisma.$transaction(async (tx) => {
      const automationRun = await tx.automationRun.create({
        data: {
          promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
          notes: JSON.stringify({
            schemaVersion: 1,
            lifecycle: "claimed",
            branch: input.branch,
            baseSha: input.baseSha,
            plannedPaths,
            incidentCount: selected.incidents.length,
            fairnessReason: selected.fairnessReason
          })
        },
        select: { id: true }
      });
      const batch = await tx.courseSupportBatch.create({
        data: {
          reference: createCourseSupportBatchReference(now),
          providerFamilyKey: selected.providerFamilyKey,
          failureFingerprint: selected.failureFingerprint,
          status: "CLAIMED",
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
            containsCriticalRealDemand: selected.containsCriticalRealDemand,
            selectedIncidentCount: selected.incidents.length
          }
        },
        select: { id: true, reference: true }
      });
      await tx.courseSupportBatchIncident.createMany({
        data: selected.incidents.map((incident) => ({
          batchId: batch.id,
          incidentId: incident.id,
          courseId: incident.courseId,
          cycle: incident.cycle,
          preProbeId: preProbeByCourse.get(incident.courseId) ?? null
        }))
      });
      for (const incident of selected.incidents) {
        const claimed = await tx.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            providerFamilyKey: incident.providerFamilyKey,
            failureFingerprint: incident.failureFingerprint,
            updatedAt: incident.updatedAt,
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
          },
          data: {
            activeBatchId: batch.id,
            lastAttemptAt: now,
            attemptCount: { increment: 1 }
          }
        });
        if (claimed.count !== 1) {
          throw new Error("Course-support batch ownership changed during claim.");
        }
      }
      return {
        automationRunId: automationRun.id,
        batchId: batch.id,
        batchRef: batch.reference
      };
    });

    return {
      outcome: "ready" as const,
      batchRef: created.batchRef,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      providerFamilyKey: selected.providerFamilyKey,
      failureFingerprint: selected.failureFingerprint,
      incidentCount: selected.incidents.length,
      fairnessReason: selected.fairnessReason,
      containsCriticalRealDemand: selected.containsCriticalRealDemand,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "The claimed responder batch is still in progress."
    };
  });

  if (!lease.acquired) {
    return {
      outcome: "deferred_busy" as const,
      durableCloseoutRecorded: false,
      ...getResponderThreadPolicy({
        outcome: "deferred_busy",
        durableCloseoutRecorded: false
      })
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
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING"] },
      leaseExpiresAt: { gte: now }
    },
    select: {
      status: true,
      revision: true,
      summary: true,
      ownerAutomationRunId: true
    }
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      pathRecorded: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost."
    };
  }
  const summary = asJsonObject(batch.summary);
  const plannedPaths = normalizePaths([
    ...(Array.isArray(summary.plannedPaths)
      ? summary.plannedPaths.filter(
          (candidate): candidate is string => typeof candidate === "string"
        )
      : []),
    path
  ]);
  const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.courseSupportBatch.updateMany({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now }
      },
      data: {
        status: "IMPLEMENTING",
        summary: {
          ...summary,
          plannedPaths
        } as Prisma.InputJsonValue,
        heartbeatAt: now,
        leaseExpiresAt,
        revision: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new Error("Responder batch ownership changed while claiming a path.");
    }
    if (batch.ownerAutomationRunId) {
      await transaction.automationRun.updateMany({
        where: { id: batch.ownerAutomationRunId, completedAt: null },
        data: {
          notes: JSON.stringify({
            schemaVersion: 1,
            lifecycle: "implementing",
            plannedPaths,
            plannedPathCount: plannedPaths.length
          })
        }
      });
    }
  });
  return {
    outcome: "ready" as const,
    pathRecorded: true,
    plannedPathCount: plannedPaths.length,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "The responder batch is still in progress."
  };
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
      leaseExpiresAt: { gte: now }
    },
    select: {
      reference: true,
      providerFamilyKey: true,
      failureFingerprint: true,
      createdAt: true,
      incidents: {
        orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }],
        select: {
          cycle: true,
          result: true,
          course: {
            select: {
              name: true,
              website: true,
              detectedBookingUrl: true,
              detectedPlatform: true,
              bookingMethod: true,
              automationEligibility: true,
              automationReason: true,
              providerFamilyKey: true
            }
          },
          incident: {
            select: {
              kind: true,
              failureClass: true,
              engineeringOnly: true,
              activeRealSearchCount: true,
              earliestTargetDate: true,
              attemptCount: true,
              latestMessage: true,
              nextAction: true,
              firstSeenAt: true,
              lastSeenAt: true
            }
          }
        }
      }
    }
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost."
    };
  }
  return {
    outcome: "ready" as const,
    batchRef: batch.reference,
    providerFamilyKey: batch.providerFamilyKey,
    failureFingerprint: batch.failureFingerprint,
    claimedAt: batch.createdAt.toISOString(),
    courses: batch.incidents.map((entry, index) => ({
      ordinal: String(index + 1).padStart(2, "0"),
      name: entry.course.name,
      providerFamilyKey: entry.course.providerFamilyKey,
      detectedPlatform: entry.course.detectedPlatform,
      failureClass: entry.incident.failureClass,
      kind: entry.incident.kind,
      result: entry.result,
      engineeringOnly: entry.incident.engineeringOnly,
      activeRealSearchCount: entry.incident.activeRealSearchCount,
      earliestTargetDate:
        entry.incident.earliestTargetDate?.toISOString().slice(0, 10) ?? null,
      attemptCount: entry.incident.attemptCount,
      bookingMethod: entry.course.bookingMethod,
      automationEligibility: entry.course.automationEligibility,
      automationReason: entry.course.automationReason,
      officialSiteRoot: getSafePublicRoot(entry.course.website),
      officialBookingRoot: getSafePublicRoot(entry.course.detectedBookingUrl),
      latestEvidence: sanitizeResponderText(
        entry.incident.latestMessage ?? "No bounded failure message was recorded."
      ),
      nextAction: entry.incident.nextAction
        ? sanitizeResponderText(entry.incident.nextAction)
        : null,
      firstSeenAt: entry.incident.firstSeenAt.toISOString(),
      lastSeenAt: entry.incident.lastSeenAt.toISOString()
    })),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "The responder batch is still in progress."
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
    "required external action"
  );
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
      incidents: {
        orderBy: [{ course: { name: "asc" } }, { createdAt: "asc" }],
        select: {
          id: true,
          incidentId: true,
          cycle: true,
          updatedAt: true,
          incident: {
            select: {
              engineeringOnly: true,
              status: true,
              activeBatchId: true,
              updatedAt: true
            }
          }
        }
      }
    }
  });
  const entry = batch?.incidents[input.ordinal - 1];
  if (!batch || !entry) {
    throw new Error("Course-support ordinal is not present in the owned batch.");
  }
  if (entry.incident.engineeringOnly) {
    throw new Error(
      "Engineering-only incidents require a conclusive persisted disposition, not owner escalation."
    );
  }
  const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
  await prisma.$transaction(async (transaction) => {
    const ownership = await transaction.courseSupportBatch.updateMany({
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
        leaseExpiresAt,
        revision: { increment: 1 }
      }
    });
    const incident = await transaction.courseSupportIncident.updateMany({
      where: {
        id: entry.incidentId,
        cycle: entry.cycle,
        status: "AUTO_INVESTIGATING",
        activeBatchId: input.batchId,
        engineeringOnly: false,
        updatedAt: entry.incident.updatedAt
      },
      data: { latestMessage: evidence, nextAction, updatedAt: now }
    });
    const batchEntry = await transaction.courseSupportBatchIncident.updateMany({
      where: { id: entry.id, updatedAt: entry.updatedAt },
      data: {
        result: "NEEDS_HUMAN",
        postProbeId: null,
        message: `${evidence} Required external action: ${nextAction}`,
        proofSnapshot: Prisma.DbNull,
        verifiedIncidentUpdatedAt: now,
        verifiedAt: now
      }
    });
    if (ownership.count !== 1 || incident.count !== 1 || batchEntry.count !== 1) {
      throw new Error("Course-support state changed while recording human escalation.");
    }
  });
  return {
    outcome: "needs_human" as const,
    ordinal: String(input.ordinal).padStart(2, "0"),
    evidenceRecorded: true,
    nextActionRecorded: true,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "A concrete external action requires owner visibility."
  };
}

export async function heartbeatCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  status?: "IMPLEMENTING" | "VERIFYING";
  releaseSha?: string | null;
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
      leaseExpiresAt: { gte: now }
    },
    select: { status: true, revision: true, releaseSha: true }
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      heartbeatRecorded: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost."
    };
  }
  if (
    batch.releaseSha &&
    input.releaseSha &&
    batch.releaseSha !== input.releaseSha
  ) {
    throw new Error("Release SHA does not match the batch's persisted release.");
  }

  const status = nextBatchStatus(batch.status, input.status);
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
      status,
      heartbeatAt: now,
      leaseExpiresAt,
      releaseSha: input.releaseSha ?? batch.releaseSha,
      revision: { increment: 1 }
    }
  });
  return {
    outcome: updated.count === 1 ? ("ready" as const) : ("recovery_required" as const),
    heartbeatRecorded: updated.count === 1,
    status,
    releaseSha:
      updated.count === 1 ? (input.releaseSha ?? batch.releaseSha) : null,
    leaseExpiresAt: updated.count === 1 ? leaseExpiresAt.toISOString() : null,
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason:
      updated.count === 1
        ? "The responder batch is still in progress."
        : "Responder batch ownership changed during heartbeat."
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
      leaseExpiresAt: { gte: now }
    },
    include: {
      incidents: {
        include: {
          incident: {
            select: {
              cycle: true,
              status: true,
              engineeringOnly: true,
              activeBatchId: true,
              firstSeenAt: true,
              lastSeenAt: true,
              updatedAt: true
            }
          },
          course: {
            select: {
              isPublic: true,
              bookingMethod: true,
              automationEligibility: true,
              automationReason: true,
              automationDiscoveries: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  status: true,
                  bookingMethod: true,
                  automationEligibility: true,
                  automationReason: true,
                  sourceUrl: true,
                  bookingUrl: true,
                  confidence: true,
                  createdAt: true
                }
              }
            }
          }
        }
      }
    }
  });
  if (!batch) {
    return {
      outcome: "recovery_required" as const,
      verified: false,
      threadDisposition: "KEEP_VISIBLE" as const,
      archiveReason: "Responder batch ownership or lease freshness was lost."
    };
  }
  const releaseSha = input.releaseSha ?? batch.releaseSha;
  if (batch.releaseSha && input.releaseSha && batch.releaseSha !== input.releaseSha) {
    throw new Error("Release SHA does not match the batch's persisted release.");
  }
  const deployedAt = input.deployedAt ?? batch.deployedAt;
  if (deployedAt && !releaseSha) {
    throw new Error(
      "Fresh-runtime verification requires a persisted release SHA before deployment proof."
    );
  }
  if (batch.deployedAt && input.deployedAt && batch.deployedAt.getTime() !== input.deployedAt.getTime()) {
    throw new Error("Deployment time does not match the batch's persisted deployment.");
  }
  const courseIds = batch.incidents.map((entry) => entry.courseId);
  if (courseIds.length === 0) {
    throw new Error("A responder batch without incident evidence cannot be verified.");
  }
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
          deployedAt
        )
      : null;
  const newestProbeByCourse =
    persistedSearchHealth?.freshProviderProofByCourse ??
    new Map<string, FreshProbeEvidence>();

  const verifications = batch.incidents.map((entry) => {
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
          message: entry.message
        })
      : null;
    return {
      entry,
      verification: incidentCurrent
        ? (explicitHumanVerification ?? classifyFreshBatchEvidence({
            batchCreatedAt: batch.createdAt,
            deployedAt,
            releaseSha,
            recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
            preProbeId: entry.preProbeId,
            newestProbe: newestProbeByCourse.get(entry.courseId),
            course: { ...entry.course, latestDiscovery },
            incidentFirstSeenAt: entry.incident.firstSeenAt,
            incidentLastSeenAt: entry.incident.lastSeenAt
          }))
        : {
            result: "STALE_EVIDENCE" as const,
            postProbeId: null,
            message: "The incident changed after this responder batch was claimed.",
            proofSnapshot: null
        }
    };
  });
  const recheckCourseIds = verifications
    .filter(
      ({ entry, verification }) =>
        entry.incident.cycle === entry.cycle &&
        entry.incident.activeBatchId === batch.id &&
        entry.incident.status === "AUTO_INVESTIGATING" &&
        verification.result !== "FINAL_DISPOSITION"
    )
    .map(({ entry }) => entry.courseId);
  const shouldOwnRecheckDispatch = Boolean(
    releaseSha &&
      deployedAt &&
      recheckCourseIds.length > 0 &&
      !batch.recheckDispatchedAt
  );
  const recheckDispatchKey =
    batch.recheckDispatchKey ??
    (shouldOwnRecheckDispatch ? randomUUID() : null);
  const recheckDispatchStartedAt =
    batch.recheckDispatchStartedAt ??
    (shouldOwnRecheckDispatch ? now : null);
  const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now },
        releaseSha: batch.releaseSha,
        deployedAt: batch.deployedAt
      },
      data: {
        status: "VERIFYING",
        releaseSha,
        deployedAt,
        heartbeatAt: now,
        leaseExpiresAt,
        recheckDispatchKey,
        recheckDispatchStartedAt,
        revision: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new Error("Responder batch ownership changed during verification.");
    }
    for (const { entry, verification } of verifications) {
      const entryUpdated = await tx.courseSupportBatchIncident.updateMany({
        where: {
          id: entry.id,
          result: entry.result,
          updatedAt: entry.updatedAt
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
          verifiedAt: now
        }
      });
      if (entryUpdated.count !== 1) {
        throw new Error("Responder evidence changed during verification.");
      }
    }
  });

  let recheckDispatch = getPersistedRecheckDispatch(batch.summary);
  let recheckDispatchedAt = batch.recheckDispatchedAt;
  const shouldDispatch = Boolean(
    recheckDispatchKey &&
      recheckDispatchStartedAt &&
      !recheckDispatchedAt &&
      recheckCourseIds.length > 0
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
        recheckDispatchKey ?? undefined
      );
      const dispatchComplete =
        dispatched.queuedCount === dispatched.affectedSearchCount &&
        dispatched.queueFailureCount === dispatched.directStartCount;
      scheduledSearches = dispatched.scheduledSearches;
      recheckDispatch = {
        attempted: true,
        dispatchKeyPersisted: true,
        dispatchedAt: recheckDispatchStartedAt?.toISOString(),
        affectedSearchCount: dispatched.affectedSearchCount,
        queuedCount: dispatched.queuedCount,
        queueFailureCount: dispatched.queueFailureCount,
        directStartCount: dispatched.directStartCount,
        affectedSearchRefs: dispatched.affectedSearchRefs,
        dispatchError: !dispatchComplete
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
        dispatchError: true,
        error: sanitizeResponderText(
          error instanceof Error
            ? error.message
            : "Course-remediation recheck dispatch failed."
        )
      };
    }
    const persisted = await prisma.$transaction(async (tx) => {
      for (const search of scheduledSearches) {
        await tx.courseSupportBatchSearch.upsert({
          where: {
            batchId_searchRef: {
              batchId: batch.id,
              searchRef: search.searchRef
            }
          },
          create: {
            batchId: batch.id,
            teeSearchId: search.searchId,
            searchRef: search.searchRef,
            scheduleVersion: search.scheduleVersion
          },
          update: {
            teeSearchId: search.searchId,
            scheduleVersion: search.scheduleVersion
          }
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
          recheckDispatchedAt: null
        },
        data: {
          recheckDispatchedAt,
          summary: {
            ...asJsonObject(batch.summary),
            recheckDispatch
          } as Prisma.InputJsonValue,
          revision: { increment: 1 }
        }
      });
    });
    if (persisted.count !== 1) {
      throw new Error("Responder recheck dispatch ownership changed.");
    }
    expectedRevision += 1;
  } else if (!recheckDispatch && recheckCourseIds.length === 0) {
    recheckDispatch = {
      attempted: false,
      affectedSearchCount: 0,
      queuedCount: 0,
      queueFailureCount: 0,
      dispatchError: false,
      reason: "FINAL_DISPOSITION_ONLY"
    };
  }

  if (recheckDispatchedAt && recheckDispatchStartedAt) {
    const health = await assessRemediatedSearchHealth(
      batch.id,
      courseIds,
      recheckDispatchStartedAt,
      now,
      getAffectedSearchRefs(recheckDispatch),
      releaseSha,
      deployedAt
    );
    const restoredCourseIds = verifications
      .filter(({ verification }) => verification.result === "RESTORED")
      .map(({ entry }) => entry.courseId);
    const affectedCourseSearchPairCount = restoredCourseIds.reduce(
      (total, courseId) =>
        total + (health.affectedCourseSearchPairCountByCourse.get(courseId) ?? 0),
      0
    );
    const healthyCourseSearchPairCount = restoredCourseIds.reduce(
      (total, courseId) =>
        total + (health.healthyCourseSearchPairCountByCourse.get(courseId) ?? 0),
      0
    );
    const provenRunnableCourseCount = restoredCourseIds.filter((courseId) =>
      health.freshProviderProofByCourse.has(courseId)
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
        health.healthySchedulerCount === health.affectedSearchCount &&
        health.freshSearchCheckCount === health.affectedSearchCount
    };
    const healthPersisted = await prisma.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: "VERIFYING",
        revision: expectedRevision,
        recheckDispatchKey,
        recheckDispatchStartedAt,
        recheckDispatchedAt
      },
      data: {
        summary: {
          ...asJsonObject(batch.summary),
          recheckDispatch
        } as Prisma.InputJsonValue,
        heartbeatAt: now,
        leaseExpiresAt,
        revision: { increment: 1 }
      }
    });
    if (healthPersisted.count !== 1) {
      throw new Error("Responder schedule-health evidence changed during verification.");
    }
  }

  const counts = countVerificationResults(
    verifications.map(({ verification }) => verification.result)
  );
  return {
    outcome: "ready" as const,
    verified: true,
    releaseSha: releaseSha ?? null,
    deployedAt: deployedAt?.toISOString() ?? null,
    counts,
    recheckDispatch,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    threadDisposition: "KEEP_VISIBLE" as const,
    archiveReason: "Verification is recorded; durable batch closeout remains."
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
          (affectedCourseSearchPairCountByCourse.get(courseId) ?? 0) + 1
        );
      }

      const probe = latestProbeByCourse.get(courseId);
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
          SUCCESSFUL_PROBE_OUTCOMES.has(probe.outcome)
      );
      if (!hasFreshRunnableProof || !probe || !freshSearchCheckedAt) {
        continue;
      }

      const freshProof = {
        ...probe,
        freshSearchCheckedAt,
        scheduleVersion: search.scheduleVersion,
        trafficClass: search.trafficClass ?? probe.trafficClass ?? null
      } satisfies FreshProbeEvidence;
      const candidates = candidateProofsByCourse.get(courseId) ?? [];
      candidates.push(freshProof);
      candidateProofsByCourse.set(courseId, candidates);
      if (requiresCurrentCoverage) {
        healthyCourseSearchPairCountByCourse.set(
          courseId,
          (healthyCourseSearchPairCountByCourse.get(courseId) ?? 0) + 1
        );
      }
    }
  }

  const freshProviderProofByCourse = new Map<string, FreshProbeEvidence>();
  for (const courseId of input.courseIds) {
    const affected = affectedCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const healthy = healthyCourseSearchPairCountByCourse.get(courseId) ?? 0;
    const candidates = candidateProofsByCourse.get(courseId) ?? [];
    if (healthy !== affected || candidates.length === 0) {
      continue;
    }
    candidates.sort(
      (left, right) => right.observedAt.getTime() - left.observedAt.getTime()
    );
    freshProviderProofByCourse.set(courseId, candidates[0]);
  }

  return {
    freshProviderProofByCourse,
    affectedCourseSearchPairCountByCourse,
    healthyCourseSearchPairCountByCourse
  };
}

async function assessRemediatedSearchHealth(
  batchId: string,
  courseIds: string[],
  dispatchedAt: Date,
  now: Date,
  expectedSearchRefs: Map<string, number>,
  releaseSha: string | null,
  deployedAt: Date | null
) {
  const dispatches = await prisma.courseSupportBatchSearch.findMany({
    where: { batchId },
    include: {
      teeSearch: {
        select: {
          status: true,
          scheduleVersion: true,
          workflowRunId: true,
          checkStatus: true,
          checkLeaseExpiresAt: true,
          nextCheckAt: true,
          lastCheckedAt: true,
          updatedAt: true,
          trafficClass: true,
          preferences: {
            where: { courseId: { in: courseIds } },
            select: { courseId: true }
          },
          probes: {
            where: {
              courseId: { in: courseIds },
              ...(deployedAt ? { observedAt: { gte: deployedAt } } : {})
            },
            orderBy: { observedAt: "desc" },
            select: {
              id: true,
              courseId: true,
              outcome: true,
              observedAt: true,
              runtimeVersion: true,
              rawSummary: true
            }
          }
        }
      }
    }
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
      now
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
          dispatch.teeSearch.updatedAt.getTime() >= dispatchedAt.getTime())
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
            (preference) => preference.courseId
          ),
          probes: dispatch.teeSearch.probes.map((probe) => ({
            id: probe.id,
            courseId: probe.courseId,
            outcome: probe.outcome,
            observedAt: probe.observedAt,
            runtimeVersion: probe.runtimeVersion,
            providerExecution:
              asJsonObject(probe.rawSummary).providerExecution ===
              "RUNNABLE_PROVIDER_CHECK"
          }))
        }
      ];
    }),
    courseIds,
    releaseSha,
    deployedAt,
    dispatchedAt
  });
  return {
    affectedSearchCount: affectedDispatches.length,
    healthySchedulerCount,
    freshSearchCheckCount,
    ...providerEvidence
  };
}

export function isVerifiedSearchRemoval(
  dispatch: {
    teeSearch: unknown | null;
    removedAt: Date | null;
    removalReason: string | null;
  },
  dispatchedAt: Date
) {
  return Boolean(
    !dispatch.teeSearch &&
      dispatch.removalReason === "SEARCH_DELETED_BY_OWNER" &&
      dispatch.removedAt &&
      dispatch.removedAt.getTime() >= dispatchedAt.getTime()
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
  now: Date
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
          now.getTime() - SEARCH_TIMELINESS_GRACE_MS
    );
  }
  if (search.checkStatus === "CHECKING") {
    return Boolean(
      search.checkLeaseExpiresAt &&
        search.checkLeaseExpiresAt.getTime() > now.getTime() &&
        search.updatedAt.getTime() >=
          now.getTime() - SEARCH_TIMELINESS_GRACE_MS
    );
  }
  return false;
}

export async function closeoutCourseSupportBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  requestedOutcome?: ResponderOutcome;
  failureDomain?: ResponderFailureDomain;
  retryAfterSeconds?: number | null;
  summary?: unknown;
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
    include: {
      incidents: { include: { incident: true } }
    }
  });
  if (!batch) {
    return {
      outcome: "command_failed" as const,
      durableCloseoutRecorded: false,
      ...getResponderThreadPolicy({
        outcome: "command_failed",
        durableCloseoutRecorded: false
      })
    };
  }
  if (batch.incidents.length === 0) {
    throw new Error("A responder batch without incident evidence cannot be closed.");
  }

  const normalizedEntries = batch.incidents.map((entry) => {
    if (entry.result === "PENDING" || entry.result === "STALE_EVIDENCE") {
      return { ...entry, normalizedResult: "RETRY_SCHEDULED" as const };
    }
    if (entry.result === "NEEDS_HUMAN" && entry.incident.engineeringOnly) {
      return { ...entry, normalizedResult: "RETRY_SCHEDULED" as const };
    }
    return { ...entry, normalizedResult: entry.result };
  });
  for (const entry of normalizedEntries) {
    if (
      entry.normalizedResult === "RETRY_SCHEDULED" &&
      !canCloseCourseSupportRetry(
        entry.incident.failureClass,
        input.requestedOutcome
      )
    ) {
      throw new Error(
        "A non-transient provider restriction requires current final-disposition evidence or an explicit human escalation."
      );
    }
    if (
      ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult) &&
      !isDurableTerminalProof(entry, batch)
    ) {
      throw new Error("Terminal course-support evidence is missing or stale.");
    }
    if (
      entry.verifiedIncidentUpdatedAt &&
      entry.incident.updatedAt.getTime() !==
        entry.verifiedIncidentUpdatedAt.getTime()
    ) {
      throw new Error("A course-support incident changed after verification.");
    }
  }
  const needsHumanCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "NEEDS_HUMAN"
  ).length;
  const hasHuman = needsHumanCount > 0;
  const terminalCount = normalizedEntries.filter((entry) =>
    ["RESTORED", "FINAL_DISPOSITION"].includes(entry.normalizedResult)
  ).length;
  const restoredCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "RESTORED"
  ).length;
  const retryCount = normalizedEntries.filter(
    (entry) => entry.normalizedResult === "RETRY_SCHEDULED"
  ).length;
  if (restoredCount > 0 && !isRecheckDispatchHealthy(batch.summary, now)) {
    throw new Error(
      "Affected searches do not yet have complete durable recheck and scheduler evidence."
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
          (entry) => entry.normalizedResult === "FINAL_DISPOSITION"
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
          `Requested responder outcome ${input.requestedOutcome} contradicts the independently derived ${derivedOutcome} result.`
        );
      }
    } else if (!FAILURE_CLOSEOUT_OUTCOMES.has(input.requestedOutcome)) {
      throw new Error(
        "Responder closeout does not accept lifecycle or routine outcomes as overrides."
      );
    }
  }
  const outcome = input.requestedOutcome ?? derivedOutcome;
  const retryTimes: Date[] = [];
  const safeSummary = sanitizeResponderCloseoutSummary(input.summary);

  await prisma.$transaction(async (tx) => {
    const ownership = await tx.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        leaseToken: input.leaseToken,
        ownerThreadId: input.ownerThreadId,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { gte: now }
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
            retryCount,
            needsHumanCount,
            summary: safeSummary
          }
        } as Prisma.InputJsonValue,
        revision: { increment: 1 }
      }
    });
    if (ownership.count !== 1) {
      throw new Error("Responder batch ownership changed during closeout.");
    }

    for (const entry of normalizedEntries) {
      const message = sanitizeResponderText(
        entry.message ?? "Course-support responder closeout recorded."
      );
      const expectedIncidentUpdatedAt =
        entry.verifiedIncidentUpdatedAt ?? entry.incident.updatedAt;
      let incidentUpdated: { count: number };
      if (entry.normalizedResult === "RESTORED") {
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            nextAttemptAt: null,
            resolvedAt: now,
            resolution: "MONITORING_RESTORED",
            resolutionMessage: message,
            lastSeenAt: now
          }
        });
      } else if (entry.normalizedResult === "FINAL_DISPOSITION") {
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            nextAttemptAt: null,
            resolvedAt: now,
            resolution: "DIRECT_BOOKING_CLASSIFIED",
            resolutionMessage: message,
            lastSeenAt: now
          }
        });
      } else if (entry.normalizedResult === "NEEDS_HUMAN") {
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            engineeringOnly: false,
            updatedAt: expectedIncidentUpdatedAt
          },
          data: {
            status: "NEEDS_HUMAN",
            activeBatchId: null,
            nextAttemptAt: null,
            escalatedAt: entry.incident.escalatedAt ?? now,
            latestMessage: message,
            lastSeenAt: now
          }
        });
      } else {
        const nextAttemptAt = computeCourseSupportNextAttemptAt({
          failureClass: entry.incident.failureClass,
          failureFingerprint: entry.incident.failureFingerprint,
          attemptCount: Math.max(1, entry.incident.attemptCount),
          retryAfterSeconds: input.retryAfterSeconds,
          now
        });
        retryTimes.push(nextAttemptAt);
        incidentUpdated = await tx.courseSupportIncident.updateMany({
          where: {
            id: entry.incidentId,
            cycle: entry.cycle,
            activeBatchId: batch.id,
            status: "AUTO_INVESTIGATING",
            updatedAt: expectedIncidentUpdatedAt
          },
          data: {
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
            nextAttemptAt,
            latestMessage: message,
            lastSeenAt: now
          }
        });
      }
      if (incidentUpdated.count !== 1) {
        throw new Error("A course-support incident changed during closeout.");
      }
      if (entry.result !== entry.normalizedResult) {
        const batchEntryUpdated = await tx.courseSupportBatchIncident.updateMany({
          where: {
            id: entry.id,
            result: entry.result,
            updatedAt: entry.updatedAt
          },
          data: { result: entry.normalizedResult }
        });
        if (batchEntryUpdated.count !== 1) {
          throw new Error("Responder batch evidence changed during closeout.");
        }
      }
    }

    if (batch.ownerAutomationRunId) {
      await tx.automationRun.updateMany({
        where: { id: batch.ownerAutomationRunId, completedAt: null },
        data: {
          completedAt: now,
          outcome,
          notes: JSON.stringify({
            schemaVersion: 1,
            lifecycle: "closeout",
            status: batchStatus,
            outcome,
            derivedOutcome,
            terminalCount,
            retryCount,
            failureDomain: input.failureDomain ?? "NONE"
          })
        }
      });
    }
  });

  let notificationPendingCount = 0;
  for (const entry of normalizedEntries.filter((candidate) =>
    ["RESTORED", "FINAL_DISPOSITION"].includes(candidate.normalizedResult)
  )) {
    const resolved = await resolveCourseSupportIncident({
      courseId: entry.courseId,
      resolution:
        entry.normalizedResult === "RESTORED"
          ? "MONITORING_RESTORED"
          : "DIRECT_BOOKING_CLASSIFIED",
      message: sanitizeResponderText(
        entry.message ?? "Course-support responder closeout recorded."
      ),
      now
    });
    if (
      resolved &&
      (resolved.ownerNotifiedAt || resolved.escalationNotifiedAt) &&
      !resolved.resolutionNotifiedAt
    ) {
      notificationPendingCount += 1;
    }
  }
  const humanIncidentIds = normalizedEntries
    .filter((entry) => entry.normalizedResult === "NEEDS_HUMAN")
    .map((entry) => entry.incidentId);
  if (humanIncidentIds.length > 0) {
    const notification = await notifyCourseSupportIssueBatch(
      humanIncidentIds,
      now
    );
    notificationPendingCount += notification.pendingIncidentIds.length;
  }

  let finalOutcome = outcome;
  let finalBatchStatus = batchStatus;
  if (notificationPendingCount > 0) {
    finalOutcome = "delivery_incident";
    finalBatchStatus = "PARTIAL";
    await prisma.$transaction([
      prisma.courseSupportBatch.update({
        where: { id: batch.id },
        data: {
          status: "PARTIAL",
          summary: {
            ...asJsonObject(batch.summary),
            closeout: {
              outcome: finalOutcome,
              derivedOutcome,
              failureDomain: "DELIVERY",
              terminalCount,
              retryCount,
              needsHumanCount,
              notificationPendingCount,
              summary: safeSummary
            }
          } as Prisma.InputJsonValue
        }
      }),
      ...(batch.ownerAutomationRunId
        ? [
            prisma.automationRun.update({
              where: { id: batch.ownerAutomationRunId },
              data: { outcome: finalOutcome }
            })
          ]
        : [])
    ]);
  }

  const nextAttemptAt = retryTimes.sort(
    (left, right) => left.getTime() - right.getTime()
  )[0];
  const policy = getResponderThreadPolicy({
    outcome: finalOutcome,
    failureDomain:
      notificationPendingCount > 0 ? "DELIVERY" : input.failureDomain,
    nextAttemptAt,
    requiresHuman: hasHuman,
    durableCloseoutRecorded: true
  });
  return {
    outcome: finalOutcome,
    derivedOutcome,
    batchStatus: finalBatchStatus,
    durableCloseoutRecorded: true,
    terminalCount,
    retryCount,
    notificationPendingCount,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    ...policy
  };
}

export async function recoverCourseSupportBatch(input: {
  batchId: string;
  requestingThreadId: string;
  currentBranch: string;
  currentHeadSha: string;
  dirtyPaths: string[];
  baseIsAncestor?: boolean;
  committedPaths?: string[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const lease = await runWithRepositoryWriterTransitionLease(async () => {
    const batch = await prisma.courseSupportBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        status: true,
        leaseExpiresAt: true,
        ownerThreadId: true,
        baseSha: true,
        releaseSha: true,
        revision: true,
        summary: true
      }
    });
    if (!batch || !ACTIVE_BATCH_STATUSES.includes(batch.status)) {
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: ["The requested responder batch is not recoverable."],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery needs owner attention."
      };
    }
    const [otherBatch, activeHourlyRun] = await Promise.all([
      prisma.courseSupportBatch.findFirst({
        where: {
          id: { not: batch.id },
          status: { in: ACTIVE_BATCH_STATUSES }
        },
        select: { id: true }
      }),
      findActiveHourlyWriter()
    ]);
    if (otherBatch || activeHourlyRun) {
      return {
        outcome: "deferred_busy" as const,
        recovered: false,
        reasons: [
          "Another repository writer must finish before this responder batch can be recovered."
        ],
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery is blocked by another repository writer."
      };
    }
    const summary = asJsonObject(batch.summary);
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
            (path): path is string => typeof path === "string"
          )
        : [],
      dirtyPaths: normalizePaths(input.dirtyPaths),
      baseIsAncestor: input.baseIsAncestor,
      committedPaths: normalizePaths(input.committedPaths ?? []),
      now
    });
    if (recovery.action === "BLOCK") {
      return {
        outcome: "command_failed" as const,
        recovered: false,
        reasons: recovery.reasons.map(sanitizeResponderText),
        threadDisposition: "KEEP_VISIBLE" as const,
        archiveReason: "Responder recovery provenance did not match."
      };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + COURSE_SUPPORT_BATCH_LEASE_MS);
    const recoveredReleaseSha =
      batch.releaseSha ??
      (input.currentHeadSha !== batch.baseSha ? input.currentHeadSha : null);
    const updated = await prisma.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
        revision: batch.revision,
        leaseExpiresAt: { lte: now }
      },
      data: {
        ownerThreadId: input.requestingThreadId,
        leaseToken,
        leaseExpiresAt,
        heartbeatAt: now,
        releaseSha: recoveredReleaseSha,
        revision: { increment: 1 }
      }
    });
    return updated.count === 1
      ? {
          outcome: "ready" as const,
          recovered: true,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          threadDisposition: "KEEP_VISIBLE" as const,
          archiveReason: "Recovered responder work remains in progress."
        }
      : {
          outcome: "deferred_busy" as const,
          recovered: false,
          threadDisposition: "ARCHIVE" as const,
          archiveReason: "Another responder recovered the batch first."
        };
  });
  return lease.acquired
    ? lease.value
    : {
        outcome: "deferred_busy" as const,
        recovered: false,
        threadDisposition: "ARCHIVE" as const,
        archiveReason: "Another repository writer owns the transition lease."
      };
}

export async function backfillCourseSupportResponderState(input?: {
  apply?: boolean;
  now?: Date;
}) {
  const now = input?.now ?? new Date();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const [courses, incidents] = await Promise.all([
    prisma.course.findMany({
      select: {
        id: true,
        providerFamilyKey: true,
        detectedPlatform: true,
        detectedBookingUrl: true,
        website: true,
        bookingMetadata: true,
        updatedAt: true
      }
    }),
    prisma.courseSupportIncident.findMany({
    where: { status: { not: "RESOLVED" }, activeBatchId: null },
    include: {
      course: {
        select: {
          providerFamilyKey: true,
          detectedPlatform: true,
          detectedBookingUrl: true,
          website: true,
          bookingMetadata: true,
          preferences: {
            where: {
              teeSearch: { status: "ACTIVE", date: { gte: today } }
            },
            select: {
              teeSearch: {
                select: { date: true, trafficClass: true }
              }
            }
          }
        }
      }
    }
    }
  )]);
  const courseUpdates = courses.flatMap((course) => {
    const providerFamilyKey = resolveProviderCapability(course).providerFamilyKey;
    return providerFamilyKey === course.providerFamilyKey
      ? []
      : [
          {
            id: course.id,
            previousProviderFamilyKey: course.providerFamilyKey,
            previousUpdatedAt: course.updatedAt,
            providerFamilyKey
          }
        ];
  });
  const updates = incidents.map((incident) => {
    const realSearchDates = incident.course.preferences
      .filter(
        (preference) =>
          preference.teeSearch.trafficClass !== "AUTOMATION" &&
          preference.teeSearch.trafficClass !== "TEST"
      )
      .map((preference) => preference.teeSearch.date)
      .sort((left, right) => left.getTime() - right.getTime());
    const provider = resolveProviderCapability(incident.course);
    const providerFamilyKey = provider.providerFamilyKey;
    const observedFailure = classifyProviderFailure({
      error: incident.latestMessage ?? incident.initialMessage
    }).failureClass;
    const failureClass = deriveBackfillFailureClass({
      existing: incident.failureClass,
      kind: incident.kind,
      readinessFailure:
        incident.kind === "NEEDS_ADAPTER"
          ? getProviderReadinessFailure(provider)
          : null,
      observedFailure
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
        failureClass
      }),
      activeRealSearchCount: realSearchDates.length,
      earliestTargetDate: realSearchDates[0] ?? null,
      engineeringOnly:
        realSearchDates.length > 0 ? false : incident.engineeringOnly,
      nextAttemptAt:
        incident.status === "AUTO_INVESTIGATING"
          ? (incident.nextAttemptAt ?? now)
          : null
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
                  updatedAt: update.previousUpdatedAt
                },
                data: { providerFamilyKey: update.providerFamilyKey }
              })
            )
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
            activeBatchId: null
          },
          data: {
            providerFamilyKey: update.providerFamilyKey,
            failureClass: update.failureClass,
            failureFingerprint: update.failureFingerprint,
            activeRealSearchCount: update.activeRealSearchCount,
            earliestTargetDate: update.earliestTargetDate,
            engineeringOnly: update.engineeringOnly,
            nextAttemptAt: update.nextAttemptAt
          }
              })
            )
          )
        : [];
    appliedCourseUpdateCount = courseResults.reduce(
      (total, result) => total + result.count,
      0
    );
    appliedIncidentUpdateCount = incidentResults.reduce(
      (total, result) => total + result.count,
      0
    );
  }

  return {
    outcome: "success" as const,
    mode: input?.apply ? ("applied" as const) : ("dry_run" as const),
    courseUpdateCount: courseUpdates.length,
    appliedCourseUpdateCount,
    incidentCount: updates.length,
    appliedIncidentUpdateCount,
    conflictSkippedCount:
      input?.apply
        ? courseUpdates.length + updates.length -
          appliedCourseUpdateCount -
          appliedIncidentUpdateCount
        : 0,
    realDemandIncidentCount: updates.filter(
      (update) => update.activeRealSearchCount > 0
    ).length,
    engineeringOnlyIncidentCount: updates.filter(
      (incident) => incident.engineeringOnly
    ).length,
    providerFamilyCount: new Set(
      updates.map((update) => update.providerFamilyKey)
    ).size,
    failureClassCounts: Object.fromEntries(
      [...new Set(updates.map((update) => update.failureClass))]
        .sort()
        .map((failureClass) => [
          failureClass,
          updates.filter((update) => update.failureClass === failureClass).length
        ])
    )
  };
}

export function buildFailureFingerprint(input: {
  providerFamilyKey: string;
  kind: CourseSupportIncidentKind;
  failureClass: CourseSupportFailureClass;
}) {
  return buildProviderFailureFingerprint({
    providerFamilyKey: input.providerFamilyKey,
    failureClass: input.failureClass,
    operation: input.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY"
  });
}

function reserveAgedSyntheticSlots(
  incidents: CourseSupportCandidate[],
  maxCourses: number,
  now: Date
) {
  const real = incidents.filter((candidate) => !candidate.engineeringOnly);
  const agedSynthetic = incidents.filter(
    (candidate) =>
      candidate.engineeringOnly &&
      now.getTime() - candidate.firstSeenAt.getTime() >=
        COURSE_SUPPORT_SYNTHETIC_AGING_MS
  );
  if (real.length === 0 || agedSynthetic.length === 0 || maxCourses < 4) {
    return incidents.slice(0, maxCourses);
  }
  const reservedSyntheticSlots = Math.max(1, Math.floor(maxCourses / 4));
  const selected = [
    ...real.slice(0, maxCourses - reservedSyntheticSlots),
    ...agedSynthetic.slice(0, reservedSyntheticSlots)
  ];
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  for (const candidate of incidents) {
    if (selected.length >= maxCourses) {
      break;
    }
    if (!selectedIds.has(candidate.id)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  return selected.sort((left, right) => compareCandidates(left, right, now));
}

function compareGroups(
  left: CourseSupportCandidate[],
  right: CourseSupportCandidate[],
  now: Date
) {
  const leftCritical = left.some((candidate) => isCriticalRealDemand(candidate, now));
  const rightCritical = right.some((candidate) => isCriticalRealDemand(candidate, now));
  if (leftCritical !== rightCritical) {
    return leftCritical ? -1 : 1;
  }
  const leadComparison = compareCandidates(left[0], right[0], now);
  if (leadComparison !== 0) {
    return leadComparison;
  }
  const leftDemand = left.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0
  );
  const rightDemand = right.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0
  );
  return rightDemand - leftDemand || oldestSeenAt(left) - oldestSeenAt(right);
}

function compareCandidates(
  left: CourseSupportCandidate,
  right: CourseSupportCandidate,
  now: Date
) {
  const priority = candidatePriority(left, now) - candidatePriority(right, now);
  if (priority !== 0) {
    return priority;
  }
  const target =
    (left.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER);
  if (target !== 0) {
    return target;
  }
  const attempts = left.attemptCount - right.attemptCount;
  if (attempts !== 0) {
    return attempts;
  }
  return left.firstSeenAt.getTime() - right.firstSeenAt.getTime();
}

function candidatePriority(candidate: CourseSupportCandidate, now: Date) {
  if (isCriticalRealDemand(candidate, now)) {
    return 0;
  }
  if (candidate.activeRealSearchCount > 0 && candidate.kind === "FETCH_FAILED") {
    return 1;
  }
  if (candidate.activeRealSearchCount > 0) {
    return 2;
  }
  if (!candidate.engineeringOnly) {
    return 3;
  }
  return 4;
}

function isCriticalRealDemand(
  candidate: CourseSupportCandidate,
  now: Date
) {
  return Boolean(
    candidate.activeRealSearchCount > 0 &&
      candidate.kind === "FETCH_FAILED" &&
      candidate.earliestTargetDate &&
      candidate.earliestTargetDate.getTime() <=
        now.getTime() + NEAR_DATE_WINDOW_MS
  );
}

function isHistoricalCriticalRealDemand(
  incident: {
    engineeringOnly: boolean;
    activeRealSearchCount: number;
    kind: CourseSupportIncidentKind;
    earliestTargetDate: Date | null;
  },
  now: Date
) {
  return Boolean(
    !incident.engineeringOnly &&
      incident.activeRealSearchCount > 0 &&
      incident.kind === "FETCH_FAILED" &&
      incident.earliestTargetDate &&
      incident.earliestTargetDate.getTime() <= now.getTime() + NEAR_DATE_WINDOW_MS
  );
}

function oldestSeenAt(candidates: CourseSupportCandidate[]) {
  return Math.min(...candidates.map((candidate) => candidate.firstSeenAt.getTime()));
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
  incidentFirstSeenAt: Date
): { message: string; proofSnapshot: Prisma.InputJsonValue } | null {
  const discovery = course.latestDiscovery;
  const evidenceOrigin = discovery
    ? getSafeEvidenceOrigin(discovery.sourceUrl)
    : null;
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
    FINAL_BOOKING_METHODS.has(course.bookingMethod) &&
    discovery.bookingMethod === course.bookingMethod &&
    course.automationReason === "NO_ONLINE_BOOKING" &&
    discovery.automationReason === "NO_ONLINE_BOOKING";
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
      : "Current official evidence supports a final policy-safe non-runnable disposition.",
    proofSnapshot: {
      kind: "FINAL_DISPOSITION",
      disposition: manualDisposition ? "MANUAL_DIRECT" : course.automationReason,
      discoveryStatus: discovery.status,
      discoveryCreatedAt: discovery.createdAt.toISOString(),
      evidenceOrigin,
      confidence: discovery.confidence,
      bookingMethod: course.bookingMethod,
      automationEligibility: course.automationEligibility,
      automationReason: course.automationReason
    } satisfies Prisma.InputJsonObject
  };
}

function buildProbeProofSnapshot(
  probe: FreshProbeEvidence
): Prisma.InputJsonValue {
  return {
    kind: "PROVIDER_PROBE",
    outcome: probe.outcome,
    observedAt: probe.observedAt.toISOString(),
    freshSearchCheckedAt:
      (probe.freshSearchCheckedAt ?? probe.observedAt).toISOString(),
    runtimeVersion: probe.runtimeVersion,
    providerExecution: probe.providerExecution,
    scheduleVersion: probe.scheduleVersion ?? null,
    trafficClass: probe.trafficClass ?? null
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

async function listDueCourseSupportCandidates(now: Date) {
  return prisma.courseSupportIncident.findMany({
    where: {
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
    },
    orderBy: [{ earliestTargetDate: "asc" }, { firstSeenAt: "asc" }],
    select: {
      id: true,
      courseId: true,
      cycle: true,
      kind: true,
      providerFamilyKey: true,
      failureClass: true,
      failureFingerprint: true,
      engineeringOnly: true,
      activeRealSearchCount: true,
      earliestTargetDate: true,
      firstSeenAt: true,
      lastSeenAt: true,
      lastAttemptAt: true,
      attemptCount: true
      ,updatedAt: true
    }
  });
}

async function findActiveHourlyWriter() {
  return prisma.automationRun.findFirst({
    where: {
      promptVersion: { startsWith: HOURLY_PROMPT_PREFIX },
      completedAt: null
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true }
  });
}

async function recordRoutineResponderObservation(input: {
  outcome: "no_due_work" | "deferred_busy";
  now: Date;
  summary: unknown;
}) {
  try {
    await prisma.automationRun.create({
      data: {
        promptVersion: COURSE_SUPPORT_RESPONDER_PROMPT_VERSION,
        startedAt: input.now,
        completedAt: input.now,
        outcome: input.outcome,
        notes: JSON.stringify({
          schemaVersion: 1,
          lifecycle: "closeout",
          outcome: input.outcome,
          summary: sanitizeResponderValue(input.summary)
        })
      }
    });
    return true;
  } catch {
    return false;
  }
}

function nextBatchStatus(
  current: CourseSupportBatchStatus,
  requested: "IMPLEMENTING" | "VERIFYING" | undefined
): CourseSupportBatchStatus {
  if (!requested) {
    return current === "CLAIMED" ? "IMPLEMENTING" : current;
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
      "STALE_EVIDENCE"
    ].map((result) => [
      result,
      results.filter((candidate) => candidate === result).length
    ])
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

function normalizePaths(paths: string[]) {
  return [
    ...new Set(
      paths
        .map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
        .filter(Boolean)
    )
  ].sort();
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
    throw new Error("Course-support planned paths must be safe repo-relative files.");
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

function asJsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
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

function isRecheckDispatchHealthy(
  value: Prisma.JsonValue | null,
  now: Date
) {
  const dispatch = getPersistedRecheckDispatch(value);
  if (
    !dispatch ||
    dispatch.attempted !== true ||
    dispatch.dispatchError !== false ||
    dispatch.schedulerHealthComplete !== true ||
    dispatch.courseOutcomeHealthComplete !== true
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
  const provenRunnableCourses = finiteCount(
    dispatch.provenRunnableCourseCount
  );
  const affectedCourseSearchPairs = finiteCount(
    dispatch.affectedCourseSearchPairCount
  );
  const healthyCourseSearchPairs = finiteCount(
    dispatch.healthyCourseSearchPairCount
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
        healthObservedAt.getTime() >=
          now.getTime() - RECHECK_HEALTH_FRESHNESS_MS
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

function isDurableTerminalProof(
  entry: {
    normalizedResult: CourseSupportBatchIncidentResult;
    proofSnapshot: Prisma.JsonValue | null;
    verifiedAt: Date | null;
    verifiedIncidentUpdatedAt: Date | null;
    incident: { lastSeenAt: Date };
  },
  batch: {
    createdAt: Date;
    releaseSha: string | null;
    deployedAt: Date | null;
    recheckDispatchStartedAt: Date | null;
  }
) {
  if (!entry.verifiedAt || !entry.verifiedIncidentUpdatedAt) {
    return false;
  }
  const proof = asJsonObject(entry.proofSnapshot);
  if (entry.normalizedResult === "RESTORED") {
    const observedAt = parseProofDate(proof.observedAt);
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
        freshSearchCheckedAt.getTime() >= entry.incident.lastSeenAt.getTime()
    );
  }
  if (entry.normalizedResult === "FINAL_DISPOSITION") {
    const discoveredAt = parseProofDate(proof.discoveryCreatedAt);
    return Boolean(
      proof.kind === "FINAL_DISPOSITION" &&
        typeof proof.evidenceOrigin === "string" &&
        getSafeEvidenceOrigin(proof.evidenceOrigin) === proof.evidenceOrigin &&
        discoveredAt &&
        discoveredAt.getTime() >= entry.incident.lastSeenAt.getTime() &&
        typeof proof.confidence === "number" &&
        proof.confidence >= 0.7
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
    "productionSmokePassed"
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
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function parseProofDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function validateOwnerThread(ownerThreadId: string) {
  if (!ownerThreadId.trim()) {
    throw new Error("Course-support batch claim requires the current task id.");
  }
}

function validateTaskBranch(branch: string) {
  if (!branch.startsWith("automation/course-support-") || branch === "main") {
    throw new Error(
      "Course-support batch claim requires an automation/course-support-* task branch."
    );
  }
}

function validateGitSha(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`Course-support ${label} must be a full Git SHA.`);
  }
}

function createCourseSupportBatchReference(now: Date) {
  return `support-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID()
    .replaceAll("-", "")
    .slice(0, 10)}`;
}

export function isTransientCourseSupportFailure(
  failureClass: CourseSupportFailureClass
) {
  return TRANSIENT_FAILURE_CLASSES.has(failureClass);
}

export function canCloseCourseSupportRetry(
  failureClass: CourseSupportFailureClass,
  requestedOutcome?: ResponderOutcome
) {
  return (
    isTransientCourseSupportFailure(failureClass) ||
    Boolean(
      requestedOutcome &&
        OPERATIONAL_RETRY_CLOSEOUT_OUTCOMES.has(requestedOutcome)
    )
  );
}
