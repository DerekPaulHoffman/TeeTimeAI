import type { AutomationWorkerState } from "@prisma/client";

import { sendAutomationWorkerHealthEmail } from "@/lib/email/alerts";
import { prisma } from "@/lib/prisma";

import { getAutomationRuntimeVersion } from "./runtime-version";

export const AUTOMATION_WORKERS = {
  COURSE_SUPPORT: {
    workerKey: "course-support-responder",
    cadenceSeconds: 10 * 60,
    graceSeconds: 10 * 60
  },
  IMPROVEMENT: {
    workerKey: "product-improvement",
    cadenceSeconds: 6 * 60 * 60,
    graceSeconds: 30 * 60
  }
} as const;

export type AutomationWorkerConfig =
  (typeof AUTOMATION_WORKERS)[keyof typeof AUTOMATION_WORKERS];

export function getNextExpectedWorkerRun(
  completedAt: Date,
  config: Pick<AutomationWorkerConfig, "cadenceSeconds">
) {
  return new Date(completedAt.getTime() + config.cadenceSeconds * 1000);
}

export function isAutomationWorkerOverdue(
  worker: Pick<
    AutomationWorkerState,
    "desiredState" | "monitoringStartedAt" | "nextExpectedAt" | "graceSeconds"
  >,
  now = new Date()
) {
  return Boolean(
    worker.desiredState === "ACTIVE" &&
      worker.monitoringStartedAt &&
      worker.nextExpectedAt &&
      worker.nextExpectedAt.getTime() + worker.graceSeconds * 1000 <= now.getTime()
  );
}

export async function startAutomationWorker(
  config: AutomationWorkerConfig,
  input: { runnerVersion?: string | null; now?: Date } = {}
) {
  const now = input.now ?? new Date();
  let worker = await prisma.automationWorkerState.upsert({
    where: { workerKey: config.workerKey },
    create: {
      workerKey: config.workerKey,
      cadenceSeconds: config.cadenceSeconds,
      graceSeconds: config.graceSeconds,
      runnerVersion: input.runnerVersion,
      runtimeVersion: getAutomationRuntimeVersion(),
      lastStartedAt: now,
      lastHeartbeatAt: now,
      monitoringStartedAt: now,
      nextExpectedAt: getNextExpectedWorkerRun(now, config)
    },
    update: {
      cadenceSeconds: config.cadenceSeconds,
      graceSeconds: config.graceSeconds,
      runnerVersion: input.runnerVersion,
      runtimeVersion: getAutomationRuntimeVersion(),
      lastStartedAt: now,
      lastHeartbeatAt: now
    }
  });
  if (!worker.monitoringStartedAt) {
    worker = await prisma.automationWorkerState.update({
      where: { workerKey: config.workerKey },
      data: { monitoringStartedAt: now }
    });
  }

  if (worker.desiredState === "PAUSED") {
    await prisma.automationWorkerState.update({
      where: { workerKey: config.workerKey },
      data: {
        lastCompletedAt: now,
        lastOutcome: "paused_by_control_plane",
        nextExpectedAt: null
      }
    });
    return { allowed: false as const, worker };
  }

  return { allowed: true as const, worker };
}

export async function heartbeatAutomationWorker(
  config: AutomationWorkerConfig,
  now = new Date()
) {
  return prisma.automationWorkerState.updateMany({
    where: { workerKey: config.workerKey, desiredState: "ACTIVE" },
    data: {
      lastHeartbeatAt: now,
      runtimeVersion: getAutomationRuntimeVersion()
    }
  });
}

export async function completeAutomationWorker(
  config: AutomationWorkerConfig,
  outcome: string,
  now = new Date()
) {
  return prisma.automationWorkerState.update({
    where: { workerKey: config.workerKey },
    data: {
      lastHeartbeatAt: now,
      lastCompletedAt: now,
      lastOutcome: outcome.slice(0, 120),
      nextExpectedAt: getNextExpectedWorkerRun(now, config)
    }
  });
}

export async function bootstrapAutomationWorkers(
  input: { apply?: boolean; now?: Date } = {}
) {
  const now = input.now ?? new Date();
  const configs = Object.values(AUTOMATION_WORKERS);
  const existing = await prisma.automationWorkerState.findMany({
    where: { workerKey: { in: configs.map((config) => config.workerKey) } },
    orderBy: { workerKey: "asc" }
  });

  if (input.apply) {
    for (const config of configs) {
      await prisma.automationWorkerState.upsert({
        where: { workerKey: config.workerKey },
        create: {
          workerKey: config.workerKey,
          cadenceSeconds: config.cadenceSeconds,
          graceSeconds: config.graceSeconds
        },
        update: {
          cadenceSeconds: config.cadenceSeconds,
          graceSeconds: config.graceSeconds
        }
      });
    }
  }

  return {
    mode: input.apply ? "apply" : "dry_run",
    configured: configs.map((config) => ({
      workerKey: config.workerKey,
      cadenceSeconds: config.cadenceSeconds,
      graceSeconds: config.graceSeconds,
      exists: existing.some((worker) => worker.workerKey === config.workerKey)
    })),
    checkedAt: now.toISOString()
  };
}

export async function checkAutomationWorkerHealth(now = new Date()) {
  const workers = await prisma.automationWorkerState.findMany({
    orderBy: { workerKey: "asc" }
  });
  let overdue = 0;
  let notified = 0;
  let recovered = 0;

  for (const worker of workers) {
    if (isAutomationWorkerOverdue(worker, now)) {
      overdue += 1;
      const expectedAt = worker.nextExpectedAt!;
      if (
        !worker.overdueNotifiedFor ||
        worker.overdueNotifiedFor.getTime() !== expectedAt.getTime()
      ) {
        await sendAutomationWorkerHealthEmail({
          workerKey: worker.workerKey,
          event: "overdue",
          expectedAt,
          observedAt: now
        });
        await prisma.automationWorkerState.update({
          where: { workerKey: worker.workerKey },
          data: {
            overdueSince: worker.overdueSince ?? now,
            overdueNotifiedFor: expectedAt,
            overdueNotifiedAt: now,
            recoveredNotifiedAt: null
          }
        });
        notified += 1;
      }
      continue;
    }

    if (
      worker.overdueSince &&
      (!worker.recoveredNotifiedAt ||
        worker.recoveredNotifiedAt.getTime() < worker.overdueSince.getTime())
    ) {
      await sendAutomationWorkerHealthEmail({
        workerKey: worker.workerKey,
        event: "recovered",
        expectedAt: worker.nextExpectedAt ?? now,
        observedAt: now
      });
      await prisma.automationWorkerState.update({
        where: { workerKey: worker.workerKey },
        data: {
          overdueSince: null,
          overdueNotifiedFor: null,
          recoveredNotifiedAt: now
        }
      });
      recovered += 1;
    }
  }

  return { considered: workers.length, overdue, notified, recovered };
}
