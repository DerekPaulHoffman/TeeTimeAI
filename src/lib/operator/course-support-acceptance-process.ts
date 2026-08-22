import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  buildCourseSupportAcceptanceReadFailureProjection,
  buildCourseSupportAcceptanceTimeoutProjection,
  parseCourseSupportAcceptanceProjection,
  type CourseSupportAcceptanceObservedCampaign,
  type CourseSupportAcceptanceProjection,
} from "./course-support-acceptance";

export const COURSE_SUPPORT_ACCEPTANCE_WORKER_TIMEOUT_MS = 15_000;
const COURSE_SUPPORT_ACCEPTANCE_WORKER_KILL_GRACE_MS = 2_000;
const COURSE_SUPPORT_ACCEPTANCE_WORKER_MAX_OUTPUT_BYTES = 256 * 1024;
const COURSE_SUPPORT_ACCEPTANCE_WORKER_PROTOCOL_VERSION = 1 as const;

const nonnegativeCountSchema = z.number().int().nonnegative();
const observedCampaignSchema = z
  .object({
    status: z.enum(["RUNNING", "COMPLETED", "FAILED"]),
    capturedAt: z.string().datetime(),
    expectedCount: z.number().int().positive(),
    terminalCount: nonnegativeCountSchema,
    pendingCount: nonnegativeCountSchema,
    readyCount: nonnegativeCountSchema,
    activeCount: nonnegativeCountSchema,
    monitoredCount: nonnegativeCountSchema,
    bookingNotOpenCount: nonnegativeCountSchema,
    factualLimitationCount: nonnegativeCountSchema,
    technicalLimitationCount: nonnegativeCountSchema,
    sourceUnverifiedCount: nonnegativeCountSchema,
    engineeringBlockerCount: nonnegativeCountSchema,
    currentResultMissingCount: nonnegativeCountSchema,
    humanReviewCount: nonnegativeCountSchema,
    terminalWithin24HoursCount: nonnegativeCountSchema,
    automaticWithin24HoursCount: nonnegativeCountSchema,
    remainingGlobalParkedCount: nonnegativeCountSchema,
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const workerInputSchema = z
  .object({
    observedAt: z.string().datetime(),
    parkedCampaign: observedCampaignSchema.nullable(),
  })
  .strict();
const workerOutputSchema = z
  .object({
    protocolVersion: z.literal(
      COURSE_SUPPORT_ACCEPTANCE_WORKER_PROTOCOL_VERSION,
    ),
    projection: z.unknown(),
  })
  .strict();

type AcceptanceWorkerInput = {
  observedAt: string;
  parkedCampaign: CourseSupportAcceptanceObservedCampaign | null;
};

type AcceptanceWorkerCommand = {
  executable: string;
  args: string[];
};

type AcceptanceWorkerOptions = {
  command?: AcceptanceWorkerCommand;
  killGraceMs?: number;
  onWorkerSpawn?: (child: ReturnType<typeof spawn>) => void;
  spawnWorker?: typeof spawn;
  timeoutMs?: number;
};

export async function attachCourseSupportAcceptanceProjectionFromWorker<
  T extends AcceptanceWorkerInput,
>(inspection: T, options: AcceptanceWorkerOptions = {}) {
  const acceptanceProjection =
    await loadCourseSupportAcceptanceProjectionFromWorker(
      {
        observedAt: inspection.observedAt,
        parkedCampaign: inspection.parkedCampaign,
      },
      options,
    );
  return { ...inspection, acceptanceProjection };
}

export async function loadCourseSupportAcceptanceProjectionFromWorker(
  input: AcceptanceWorkerInput,
  options: AcceptanceWorkerOptions = {},
): Promise<CourseSupportAcceptanceProjection> {
  const parsedInput = workerInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return buildCourseSupportAcceptanceReadFailureProjection();
  }

  const command = options.command ?? getDefaultAcceptanceWorkerCommand();
  const timeoutMs = normalizePositiveTimeout(
    options.timeoutMs,
    COURSE_SUPPORT_ACCEPTANCE_WORKER_TIMEOUT_MS,
  );
  const killGraceMs = normalizePositiveTimeout(
    options.killGraceMs,
    COURSE_SUPPORT_ACCEPTANCE_WORKER_KILL_GRACE_MS,
  );
  const spawnWorker = options.spawnWorker ?? spawn;

  return new Promise<CourseSupportAcceptanceProjection>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnWorker(command.executable, command.args, {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      options.onWorkerSpawn?.(child);
    } catch {
      resolve(buildCourseSupportAcceptanceReadFailureProjection());
      return;
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      resolve(buildCourseSupportAcceptanceReadFailureProjection());
      return;
    }
    const childInput = child.stdin;
    const childOutput = child.stdout;
    const childError = child.stderr;

    let stdout = "";
    let settled = false;
    let forcedProjection: CourseSupportAcceptanceProjection | null = null;
    let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlineTimer = setTimeout(() => {
      terminate(buildCourseSupportAcceptanceTimeoutProjection());
    }, timeoutMs);

    const finish = (projection: CourseSupportAcceptanceProjection) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve(projection);
    };
    const terminate = (projection: CourseSupportAcceptanceProjection) => {
      if (settled || forcedProjection) return;
      forcedProjection = projection;
      child.kill();
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(projection);
        return;
      }
      killGraceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        childInput.destroy();
        childOutput.destroy();
        childError.destroy();
        child.unref();
        finish(projection);
      }, killGraceMs);
    };

    childOutput.setEncoding("utf8");
    childOutput.on("data", (chunk: string) => {
      if (settled || forcedProjection) return;
      stdout += chunk;
      if (
        Buffer.byteLength(stdout, "utf8") >
        COURSE_SUPPORT_ACCEPTANCE_WORKER_MAX_OUTPUT_BYTES
      ) {
        terminate(buildCourseSupportAcceptanceReadFailureProjection());
      }
    });
    childError.resume();
    child.on("error", () => {
      terminate(buildCourseSupportAcceptanceReadFailureProjection());
    });
    child.on("close", (code) => {
      if (forcedProjection) {
        finish(forcedProjection);
        return;
      }
      if (code !== 0) {
        finish(buildCourseSupportAcceptanceReadFailureProjection());
        return;
      }
      finish(parseAcceptanceWorkerOutput(stdout));
    });
    childInput.on("error", () => {
      terminate(buildCourseSupportAcceptanceReadFailureProjection());
    });
    childInput.end(JSON.stringify(parsedInput.data));
  });
}

export function parseCourseSupportAcceptanceWorkerInput(value: unknown) {
  const parsed = workerInputSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    now: new Date(parsed.data.observedAt),
    observedCampaign: parsed.data.parkedCampaign,
  };
}

export function buildCourseSupportAcceptanceWorkerOutput(
  projection: CourseSupportAcceptanceProjection,
) {
  return {
    protocolVersion: COURSE_SUPPORT_ACCEPTANCE_WORKER_PROTOCOL_VERSION,
    projection,
  } as const;
}

function parseAcceptanceWorkerOutput(
  stdout: string,
): CourseSupportAcceptanceProjection {
  try {
    const envelope = workerOutputSchema.safeParse(JSON.parse(stdout));
    if (!envelope.success) {
      return buildCourseSupportAcceptanceReadFailureProjection();
    }
    return (
      parseCourseSupportAcceptanceProjection(envelope.data.projection) ??
      buildCourseSupportAcceptanceReadFailureProjection()
    );
  } catch {
    return buildCourseSupportAcceptanceReadFailureProjection();
  }
}

function getDefaultAcceptanceWorkerCommand(): AcceptanceWorkerCommand {
  const require = createRequire(import.meta.url);
  return {
    executable: process.execPath,
    args: [
      require.resolve("tsx/cli"),
      fileURLToPath(
        new URL(
          "../../../scripts/automation/course-support-acceptance-worker.ts",
          import.meta.url,
        ),
      ),
    ],
  };
}

function normalizePositiveTimeout(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}
