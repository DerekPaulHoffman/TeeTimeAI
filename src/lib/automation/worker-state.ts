import type { AutomationWorkerState } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { getAutomationRuntimeVersion } from "./runtime-version";

export const AUTOMATION_WORKERS = {
  COURSE_SUPPORT: {
    workerKey: "course-support-responder",
    cadenceSeconds: 15 * 60,
    graceSeconds: 3 * 60
  },
  LOCAL_READER: {
    workerKey: "local-tee-time-reader",
    cadenceSeconds: 2 * 60,
    graceSeconds: 3 * 60
  },
  IMPROVEMENT: {
    workerKey: "product-improvement",
    cadenceSeconds: 6 * 60 * 60,
    graceSeconds: 30 * 60
  }
} as const;

export type AutomationWorkerConfig =
  (typeof AUTOMATION_WORKERS)[keyof typeof AUTOMATION_WORKERS];

export const SCHEDULED_AUTOMATION_CYCLE_FLAG = "--scheduled-cycle";

export function shouldRecordAutomationWorkerCycle(input: {
  command: string;
  args: readonly string[];
}) {
  const flagCount = input.args.filter(
    (argument) => argument === SCHEDULED_AUTOMATION_CYCLE_FLAG
  ).length;
  if (flagCount === 0) {
    return false;
  }
  if (flagCount > 1) {
    throw new Error(`${SCHEDULED_AUTOMATION_CYCLE_FLAG} may be provided only once.`);
  }
  if (input.command !== "inspect") {
    throw new Error(
      `${SCHEDULED_AUTOMATION_CYCLE_FLAG} is reserved for the scheduled inspect entrypoint.`
    );
  }
  return true;
}

export async function isAutomationWorkerExecutionAllowed(config: AutomationWorkerConfig) {
  const worker = await prisma.automationWorkerState.findUnique({
    where: { workerKey: config.workerKey },
    select: { desiredState: true }
  });
  return worker?.desiredState !== "PAUSED";
}

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
      lastHeartbeatAt: now,
      nextExpectedAt: getNextExpectedWorkerRun(now, config)
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
      nextExpectedAt: getNextExpectedWorkerRun(now, config),
      runtimeVersion: getAutomationRuntimeVersion()
    }
  });
}

export async function runWithAutomationWorkerHeartbeat<T>(
  config: AutomationWorkerConfig,
  operation: () => Promise<T>,
  input: { intervalMs: number }
) {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("Automation worker heartbeat interval must be a positive integer.");
  }

  let heartbeatFailure: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  const interval = setInterval(() => {
    if (heartbeatInFlight || heartbeatFailure) {
      return;
    }
    heartbeatInFlight = heartbeatAutomationWorker(config)
      .then((result) => {
        if (result.count !== 1) {
          throw new Error(
            `Automation worker heartbeat lost active ownership for ${config.workerKey}.`
          );
        }
      })
      .catch((error) => {
        heartbeatFailure = error;
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, input.intervalMs);
  interval.unref?.();

  try {
    const result = await operation();
    await heartbeatInFlight;
    if (heartbeatFailure) {
      throw heartbeatFailure;
    }
    return result;
  } finally {
    clearInterval(interval);
    await heartbeatInFlight;
  }
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
  let recovered = 0;

  for (const worker of workers) {
    if (isAutomationWorkerOverdue(worker, now)) {
      overdue += 1;
      const expectedAt = worker.nextExpectedAt!;
      const overdueSince =
        worker.overdueSince ??
        new Date(expectedAt.getTime() + worker.graceSeconds * 1000);
      if (!worker.overdueSince) {
        await prisma.automationWorkerState.updateMany({
          where: {
            workerKey: worker.workerKey,
            desiredState: "ACTIVE",
            nextExpectedAt: expectedAt,
            overdueSince: null
          },
          data: { overdueSince }
        });
      }
      continue;
    }

    if (worker.overdueSince) {
      const recovery = await prisma.automationWorkerState.updateMany({
        where: {
          workerKey: worker.workerKey,
          overdueSince: worker.overdueSince
        },
        data: {
          overdueSince: null,
          overdueNotifiedFor: null,
          recoveredNotifiedAt: now
        }
      });
      recovered += recovery.count;
    }
  }

  return { considered: workers.length, overdue, notified: 0, recovered };
}
