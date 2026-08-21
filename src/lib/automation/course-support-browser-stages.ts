import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import type { BrowserInvestigationMode } from "./browser-probe-evidence";

export type CourseSupportBrowserStageTarget = {
  ordinal: number;
  courseId: string;
  stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION";
};

export type CourseSupportBrowserStageEntry = {
  courseId: string;
  cycle: number;
  result: string;
  incident: {
    id: string;
    cycle: number;
    status: string;
    activeBatchId: string | null;
    attemptLedger: unknown;
  };
};

export type CourseSupportBrowserStageBatch = {
  releaseSha: string | null;
  deployedAt: Date | null;
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
  const initialBatch = await loadCurrentBatch();
  if (!initialBatch) {
    throw new Error(
      "Course-support browser progression requires current batch ownership.",
    );
  }
  const releaseFence = resolvePersistedBrowserReleaseFence({
    batch: initialBatch,
    requestedReleaseSha: input.requestedReleaseSha,
    requestedDeployedAt: input.requestedDeployedAt,
  });
  if (!releaseFence) {
    return emptyBrowserStageResult(false);
  }
  const targets = selectOwnedCourseSupportBrowserStageTargets({
    batchId: input.batchId,
    entries: initialBatch.incidents,
  });
  if (targets.length === 0) {
    return emptyBrowserStageResult(true);
  }
  await dependencies.validateReleaseFence?.(releaseFence);

  let persistedCount = 0;
  for (const target of targets) {
    const initialEntry = initialBatch.incidents.find(
      (entry) => entry.courseId === target.courseId,
    );
    if (!initialEntry) {
      throw new Error(
        "Course-support browser progression lost its initial course evidence.",
      );
    }
    const assertCurrentTarget = async (
      options: { requireCurrentStage?: boolean } = {},
    ) => {
      const currentBatch = await loadCurrentBatch();
      if (!currentBatch) {
        throw new Error(
          "Course-support browser progression lost current batch ownership.",
        );
      }
      assertPersistedBrowserReleaseFence(currentBatch, releaseFence);
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
        throw new Error(
          "Course-support browser progression lost current course ownership.",
        );
      }
      if (
        options.requireCurrentStage !== false &&
        assessAutomationPlaybook(
          currentEntry.incident.attemptLedger,
          currentEntry.incident.cycle,
        ).nextStage !== target.stage
      ) {
        throw new Error(
          "Course-support browser stage ownership changed before persistence.",
        );
      }
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

    await assertCurrentTarget();
    const result = await dependencies.runBrowserProbe({
      courseId: target.courseId,
      mode:
        target.stage === "INDEPENDENT_CONFIRMATION"
          ? "INDEPENDENT"
          : "RENDERED",
      beforePersist: assertCurrentTarget,
      persistenceFence,
      deferTerminalCloseout: true,
      persistSearchProbe: false,
    });
    persistedCount += result.persistedCount;
  }

  return {
    releaseFenceReady: true,
    eligibleCount: targets.length,
    persistedCount,
    renderedDiscoveryCount: targets.filter(
      (target) => target.stage === "RENDERED_BROWSER_DISCOVERY",
    ).length,
    independentConfirmationCount: targets.filter(
      (target) => target.stage === "INDEPENDENT_CONFIRMATION",
    ).length,
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
      incidents: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          courseId: true,
          cycle: true,
          result: true,
          incident: {
            select: {
              id: true,
              cycle: true,
              status: true,
              activeBatchId: true,
              attemptLedger: true,
            },
          },
        },
      },
    },
  });
}
