import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import { courseSupportActionPlanAllows, isCourseSupportSourceSearchActionEligible } from "./course-support-action-plan";
import { getCourseSupportRetainedSourceRecovery } from "./course-support-retained-source-recovery";
import type { BrowserInvestigationMode } from "./browser-probe-evidence";
import {
  tagCourseSupportBrowserStageControlFailure,
  type CourseSupportBrowserStageControlFailureCode
} from "./course-support-verification-watch";

export type CourseSupportBrowserStageTarget = {
  ordinal: number;
  courseId: string;
  stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION";
};

export type CourseSupportBrowserStageEntry = {
  courseId: string;
  cycle: number;
  result: string;
  course?: Parameters<typeof getCourseSupportRetainedSourceRecovery>[0]["course"];
  incident: {
    id: string;
    cycle: number;
    status: string;
    activeBatchId: string | null;
    providerFamilyKey?: string;
    attemptLedger: unknown;
    confirmedAt?: Date | null;
    firstSeenAt?: Date;
  };
};

export type CourseSupportBrowserStageBatch = {
  releaseSha: string | null;
  deployedAt: Date | null;
  summary?: unknown;
  incidents: CourseSupportBrowserStageEntry[];
};

export const ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS = [
  "PENDING",
  "STALE_EVIDENCE",
  "RETRY_SCHEDULED",
] as const;

export function isActiveOwnedCourseSupportBrowserResult(result: string) {
  return ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS.some(
    (activeResult) => activeResult === result,
  );
}

type BrowserReleaseFence = {
  releaseSha: string;
  deployedAt: Date;
};

async function runBrowserStageControlPhase<T>(
  failureCode: CourseSupportBrowserStageControlFailureCode,
  operation: () => T | Promise<T>
) {
  try {
    return await operation();
  } catch (error) {
    throw tagCourseSupportBrowserStageControlFailure(failureCode, error);
  }
}

function browserStageControlFailure(
  failureCode: CourseSupportBrowserStageControlFailureCode,
  message: string
) {
  return tagCourseSupportBrowserStageControlFailure(
    failureCode,
    new Error(message)
  );
}

export type CourseSupportBrowserPersistenceFence = {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  releaseSha: string;
  deployedAt: Date;
  runtimeVersion: string;
  incidentId: string;
  courseId: string;
  cycle: number;
  stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION";
};

export type CourseSupportBrowserPersistenceGuard = (input: {
  courseId: string;
  requireCurrentStage: boolean;
}) => Promise<void>;

type BrowserProbeRunner = (input: {
  courseId: string;
  mode: BrowserInvestigationMode;
  beforePersist: (input?: { requireCurrentStage?: boolean }) => Promise<void>;
  persistenceFence: CourseSupportBrowserPersistenceFence;
  deferTerminalCloseout: true;
  persistSearchProbe: false;
}) => Promise<{ persistedCount: number }>;

export async function runCourseSupportBrowserPersistenceWrite<T>(input: {
  transaction: Prisma.TransactionClient;
  fence: CourseSupportBrowserPersistenceFence;
  runtimeVersion?: string | null;
  mutate: (transaction: Prisma.TransactionClient) => Promise<T>;
}) {
  const { transaction, fence } = input;
  if (
    fence.runtimeVersion !== fence.releaseSha ||
    (input.runtimeVersion && input.runtimeVersion !== fence.runtimeVersion)
  ) {
    throw new Error(
      "Course-support browser runtime no longer matches the persisted release.",
    );
  }

  const incidentOwned = await transaction.courseSupportIncident.updateMany({
    where: {
      id: fence.incidentId,
      courseId: fence.courseId,
      cycle: fence.cycle,
      status: "AUTO_INVESTIGATING",
      activeBatchId: fence.batchId,
    },
    data: { revision: { increment: 0 } },
  });
  if (incidentOwned.count !== 1) {
    throw new Error(
      "Course-support browser persistence lost current incident ownership.",
    );
  }

  const batchOwned = await transaction.courseSupportBatch.updateMany({
    where: {
      id: fence.batchId,
      leaseToken: fence.leaseToken,
      ownerThreadId: fence.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
      leaseExpiresAt: { gte: new Date() },
      releaseSha: fence.releaseSha,
      deployedAt: fence.deployedAt,
    },
    data: { revision: { increment: 0 } },
  });
  if (batchOwned.count !== 1) {
    throw new Error(
      "Course-support browser persistence lost current batch ownership.",
    );
  }

  const [membership, incident] = await Promise.all([
    transaction.courseSupportBatchIncident.findUnique({
      where: {
        batchId_incidentId: {
          batchId: fence.batchId,
          incidentId: fence.incidentId,
        },
      },
      select: { courseId: true, cycle: true, result: true },
    }),
    transaction.courseSupportIncident.findUnique({
      where: { id: fence.incidentId },
      select: { cycle: true, attemptLedger: true },
    }),
  ]);
  if (
    !membership ||
    membership.courseId !== fence.courseId ||
    membership.cycle !== fence.cycle ||
    !isActiveOwnedCourseSupportBrowserResult(membership.result) ||
    !incident ||
    incident.cycle !== fence.cycle ||
    assessAutomationPlaybook(incident.attemptLedger, incident.cycle)
      .nextStage !== fence.stage
  ) {
    throw new Error(
      "Course-support browser stage ownership changed inside persistence.",
    );
  }

  return input.mutate(transaction);
}

export async function runGuardedCourseSupportBrowserMutation<T>(input: {
  courseId: string;
  requireCurrentStage: boolean;
  beforePersist?: CourseSupportBrowserPersistenceGuard;
  mutate: () => Promise<T>;
}) {
  await input.beforePersist?.({
    courseId: input.courseId,
    requireCurrentStage: input.requireCurrentStage,
  });
  return input.mutate();
}

export function selectOwnedCourseSupportBrowserStageTargets(input: {
  batchId: string;
  entries: readonly CourseSupportBrowserStageEntry[];
}): CourseSupportBrowserStageTarget[] {
  return input.entries.flatMap((entry, index) => {
    if (
      !isActiveOwnedCourseSupportBrowserResult(entry.result) ||
      entry.incident.status !== "AUTO_INVESTIGATING" ||
      entry.incident.activeBatchId !== input.batchId ||
      entry.incident.cycle !== entry.cycle
    ) {
      return [];
    }

    const stage = assessAutomationPlaybook(
      entry.incident.attemptLedger,
      entry.incident.cycle,
    ).nextStage;
    if (
      stage !== "RENDERED_BROWSER_DISCOVERY" &&
      stage !== "INDEPENDENT_CONFIRMATION"
    ) {
      return [];
    }

    return [{ ordinal: index + 1, courseId: entry.courseId, stage }];
  });
}

export async function persistOwnedCourseSupportBrowserPlaybookStages(
  input: {
    batchId: string;
    leaseToken: string;
    ownerThreadId: string;
    requestedReleaseSha?: string | null;
    requestedDeployedAt?: Date | null;
    now?: Date;
  },
  dependencies: {
    runBrowserProbe: BrowserProbeRunner;
    validateReleaseFence?: (fence: BrowserReleaseFence) => Promise<void>;
    loadBatch?: typeof loadOwnedCourseSupportBrowserStageBatch;
    hasOwnedSourceSearchCandidate?: (
      fence: CourseSupportBrowserPersistenceFence,
    ) => Promise<boolean>;
  },
) {
  const loadBatch =
    dependencies.loadBatch ?? loadOwnedCourseSupportBrowserStageBatch;
  const fixedNow = input.now;
  const currentTime = fixedNow ? () => fixedNow : () => new Date();
  const loadCurrentBatch = () =>
    loadBatch({
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      now: currentTime(),
    });
  const initialBatch = await runBrowserStageControlPhase(
    "BROWSER_STAGE_BATCH_LOAD_FAILED",
    loadCurrentBatch
  );
  if (!initialBatch) {
    throw browserStageControlFailure(
      "BROWSER_STAGE_CURRENT_TARGET_FAILED",
      "Course-support browser progression requires current batch ownership."
    );
  }
  const releaseFence = await runBrowserStageControlPhase(
    "BROWSER_STAGE_RELEASE_FENCE_FAILED",
    () =>
      resolvePersistedBrowserReleaseFence({
        batch: initialBatch,
        requestedReleaseSha: input.requestedReleaseSha,
        requestedDeployedAt: input.requestedDeployedAt
      })
  );
  if (!releaseFence) {
    return emptyBrowserStageResult(false);
  }
  const targets = await runBrowserStageControlPhase(
    "BROWSER_STAGE_TARGET_SELECTION_FAILED",
    () =>
      selectOwnedCourseSupportBrowserStageTargets({
        batchId: input.batchId,
        entries: initialBatch.incidents
      })
  );
  if (targets.length === 0) {
    return emptyBrowserStageResult(true);
  }
  await runBrowserStageControlPhase("BROWSER_STAGE_PROVENANCE_FAILED", () =>
    dependencies.validateReleaseFence?.(releaseFence)
  );

  let persistedCount = 0;
  let sourceResearchHandoffCount = 0;
  const executedTargets: CourseSupportBrowserStageTarget[] = [];
  for (const target of targets) {
    const initialEntry = initialBatch.incidents.find(
      (entry) => entry.courseId === target.courseId,
    );
    if (!initialEntry) {
      throw browserStageControlFailure(
        "BROWSER_STAGE_TARGET_SELECTION_FAILED",
        "Course-support browser progression lost its initial course evidence."
      );
    }
    const assertCurrentTarget = async (
      options: { requireCurrentStage?: boolean } = {},
    ) => {
      const currentBatch = await runBrowserStageControlPhase(
        "BROWSER_STAGE_BATCH_LOAD_FAILED",
        loadCurrentBatch
      );
      if (!currentBatch) {
        throw browserStageControlFailure(
          "BROWSER_STAGE_CURRENT_TARGET_FAILED",
          "Course-support browser progression lost current batch ownership."
        );
      }
      await runBrowserStageControlPhase(
        "BROWSER_STAGE_RELEASE_FENCE_FAILED",
        () => assertPersistedBrowserReleaseFence(currentBatch, releaseFence)
      );
      const currentEntry = currentBatch.incidents.find(
        (entry) =>
          entry.courseId === target.courseId &&
          entry.incident.id === initialEntry.incident.id &&
          isActiveOwnedCourseSupportBrowserResult(entry.result) &&
          entry.incident.status === "AUTO_INVESTIGATING" &&
          entry.incident.activeBatchId === input.batchId &&
          entry.incident.cycle === entry.cycle,
      );
      if (!currentEntry) {
        throw browserStageControlFailure(
          "BROWSER_STAGE_CURRENT_TARGET_FAILED",
          "Course-support browser progression lost current course ownership."
        );
      }
      if (
        options.requireCurrentStage !== false &&
        assessAutomationPlaybook(
          currentEntry.incident.attemptLedger,
          currentEntry.incident.cycle,
        ).nextStage !== target.stage
      ) {
        throw browserStageControlFailure(
          "BROWSER_STAGE_CURRENT_TARGET_FAILED",
          "Course-support browser stage ownership changed before persistence."
        );
      }
      return { currentBatch, currentEntry };
    };

    const persistenceFence: CourseSupportBrowserPersistenceFence = {
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      releaseSha: releaseFence.releaseSha,
      deployedAt: releaseFence.deployedAt,
      runtimeVersion: releaseFence.releaseSha,
      incidentId: initialEntry.incident.id,
      courseId: target.courseId,
      cycle: initialEntry.cycle,
      stage: target.stage,
    };

    const { currentBatch, currentEntry } = await assertCurrentTarget();
    const sourceRecovery =
      target.stage === "INDEPENDENT_CONFIRMATION" &&
      currentEntry.course && currentEntry.incident.firstSeenAt
        ? getCourseSupportRetainedSourceRecovery({
            course: currentEntry.course,
            incident: {
              ...currentEntry.incident,
              confirmedAt: currentEntry.incident.confirmedAt ?? null,
              firstSeenAt: currentEntry.incident.firstSeenAt,
            },
            now: currentTime(),
          })
        : null;
    const missingSourceResearch = Boolean(target.stage === "RENDERED_BROWSER_DISCOVERY" && currentEntry.course &&
      isCourseSupportSourceSearchActionEligible({ workMode: "ADVANCE_DISCOVERY", playbookStage: target.stage,
        incidentProviderFamilyKey: currentEntry.incident.providerFamilyKey ?? "", course: currentEntry.course }));
    if (target.stage === "INDEPENDENT_CONFIRMATION" || missingSourceResearch) {
      const { readCourseSupportRemediationClaimAttempt } =
        await import("./course-support-batches");
      const claim = readCourseSupportRemediationClaimAttempt({
        summary: currentBatch.summary,
        courseId: target.courseId,
        expectedAttemptCount: currentBatch.incidents.length,
      });
      const sourceSearchAssigned = Boolean(
        claim?.actionPlan?.primaryAction === "SEARCH_FOR_OFFICIAL_SOURCE" &&
        courseSupportActionPlanAllows(claim.actionPlan, "SEARCH_FOR_OFFICIAL_SOURCE") &&
        claim.actionPlan.route.workMode === "ADVANCE_DISCOVERY" &&
        claim.actionPlan.route.playbookStage === target.stage,
      );
      if ((sourceRecovery || missingSourceResearch) && !sourceSearchAssigned) {
        // A fresh claim must own source research before a browser can read a
        // missing source or independently revisit a rejected source.
        sourceResearchHandoffCount += 1;
        continue;
      }
      if (sourceSearchAssigned) {
        const hasCandidate = dependencies.hasOwnedSourceSearchCandidate ??
          (await import("./db-service")).hasOwnedCourseSupportSourceSearchCandidate;
        if (!(await hasCandidate(persistenceFence))) {
          throw browserStageControlFailure(
            "BROWSER_STAGE_CURRENT_TARGET_FAILED",
            "Owned source research requires its exact recorded candidate before browser verification.",
          );
        }
        const refreshed = await assertCurrentTarget();
        const refreshedClaim = readCourseSupportRemediationClaimAttempt({
          summary: refreshed.currentBatch.summary,
          courseId: target.courseId,
          expectedAttemptCount: refreshed.currentBatch.incidents.length,
        });
        const refreshedRecovery = sourceRecovery && refreshed.currentEntry.course &&
          refreshed.currentEntry.incident.firstSeenAt
          ? getCourseSupportRetainedSourceRecovery({
              course: refreshed.currentEntry.course,
              incident: {
                ...refreshed.currentEntry.incident,
                confirmedAt: refreshed.currentEntry.incident.confirmedAt ?? null,
                firstSeenAt: refreshed.currentEntry.incident.firstSeenAt,
              },
              now: currentTime(),
            })
          : null;
        if (JSON.stringify(refreshedClaim) !== JSON.stringify(claim) ||
          (sourceRecovery && refreshedRecovery?.rejectionEvidenceDigest !== sourceRecovery.rejectionEvidenceDigest)) {
          throw browserStageControlFailure(
            "BROWSER_STAGE_CURRENT_TARGET_FAILED",
            "Owned source research changed before browser verification.",
          );
        }
      }
    }
    const result = await dependencies.runBrowserProbe({
      courseId: target.courseId,
      mode:
        target.stage === "INDEPENDENT_CONFIRMATION"
          ? "INDEPENDENT"
          : "RENDERED",
      beforePersist: async (options) => {
        await assertCurrentTarget(options);
      },
      persistenceFence,
      deferTerminalCloseout: true,
      persistSearchProbe: false,
    });
    executedTargets.push(target);
    persistedCount += result.persistedCount;
  }

  return {
    releaseFenceReady: true,
    eligibleCount: executedTargets.length,
    persistedCount,
    renderedDiscoveryCount: executedTargets.filter(
      (target) => target.stage === "RENDERED_BROWSER_DISCOVERY",
    ).length,
    independentConfirmationCount: executedTargets.filter(
      (target) => target.stage === "INDEPENDENT_CONFIRMATION",
    ).length,
    sourceResearchHandoffCount,
  };
}

function resolvePersistedBrowserReleaseFence(input: {
  batch: CourseSupportBrowserStageBatch;
  requestedReleaseSha?: string | null;
  requestedDeployedAt?: Date | null;
}): BrowserReleaseFence | null {
  if (
    input.requestedReleaseSha &&
    input.batch.releaseSha &&
    input.requestedReleaseSha !== input.batch.releaseSha
  ) {
    throw new Error(
      "Release SHA does not match the batch's persisted release.",
    );
  }
  if (
    input.requestedDeployedAt &&
    input.batch.deployedAt &&
    input.requestedDeployedAt.getTime() !== input.batch.deployedAt.getTime()
  ) {
    throw new Error(
      "Deployment time does not match the batch's persisted deployment.",
    );
  }
  if (input.batch.releaseSha && !input.batch.deployedAt) {
    throw new Error(
      "Course-support browser progression requires trusted deployment proof for the persisted release.",
    );
  }
  if (!input.batch.releaseSha && input.batch.deployedAt) {
    throw new Error(
      "Course-support browser deployment proof has no persisted release SHA.",
    );
  }
  if (!input.batch.releaseSha || !input.batch.deployedAt) {
    return null;
  }
  return {
    releaseSha: input.batch.releaseSha,
    deployedAt: input.batch.deployedAt,
  };
}

function assertPersistedBrowserReleaseFence(
  batch: CourseSupportBrowserStageBatch,
  expected: BrowserReleaseFence,
) {
  if (
    batch.releaseSha !== expected.releaseSha ||
    batch.deployedAt?.getTime() !== expected.deployedAt.getTime()
  ) {
    throw new Error(
      "Course-support browser release proof changed before persistence.",
    );
  }
}

function emptyBrowserStageResult(releaseFenceReady: boolean) {
  return {
    releaseFenceReady,
    eligibleCount: 0,
    persistedCount: 0,
    renderedDiscoveryCount: 0,
    independentConfirmationCount: 0,
    sourceResearchHandoffCount: 0,
  };
}

async function loadOwnedCourseSupportBrowserStageBatch(input: {
  batchId: string;
  leaseToken: string;
  ownerThreadId: string;
  now: Date;
}): Promise<CourseSupportBrowserStageBatch | null> {
  return prisma.courseSupportBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      ownerThreadId: input.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
      leaseExpiresAt: { gte: input.now },
    },
    select: {
      releaseSha: true,
      deployedAt: true,
      summary: true,
      incidents: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          courseId: true,
          cycle: true,
          result: true,
          course: {
            select: {
              timeZone: true,
              website: true,
              detectedBookingUrl: true,
              detectedPlatform: true,
              providerFamilyKey: true,
              bookingMethod: true,
              bookingWindowDaysAhead: true,
              bookingWindowEvidenceUrl: true,
              bookingReleaseTimeLocal: true,
              bookingWindowSource: true,
              bookingWindowConfidence: true,
              automationEligibility: true,
              automationReason: true,
              monitoringMode: true,
              bookingAccessMode: true,
              isPublic: true,
              intelligenceVerifiedAt: true,
              intelligenceReviewAt: true,
              intelligenceConfidence: true,
              bookingMetadata: true,
              layoutHoleCounts: true,
              layoutHolesVerifiedAt: true,
              monitoringStatus: { select: { state: true } },
              automationDiscoveries: {
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 12,
                select: {
                  status: true,
                  detectedPlatform: true,
                  apiMetadata: true,
                  automationReason: true,
                  confidence: true,
                  evidence: true,
                  createdAt: true,
                },
              },
            },
          },
          incident: {
            select: {
              id: true,
              cycle: true,
              status: true,
              activeBatchId: true,
              providerFamilyKey: true,
              attemptLedger: true,
              confirmedAt: true,
              firstSeenAt: true,
            },
          },
        },
      },
    },
  });
}
