import { setTimeout as delay } from "node:timers/promises";
import type { ownedOutdoorLearningRecoveryProgress, requestOwnedOutdoorLearningRecovery } from "@/lib/course-discovery/service";
import { CourseSupportRuntimeUpdateFailure } from "@/lib/automation/course-support-runtime-update";
import { readPreAdmissionRuntimeBlocker, type CourseSupportLearningRuntimeBlocker, type CourseSupportLearningRuntimeReadyReceipt } from "@/lib/automation/course-support-runtime-hold";

type Progress = Awaited<ReturnType<typeof ownedOutdoorLearningRecoveryProgress>>;
type Admission = Awaited<ReturnType<typeof requestOwnedOutdoorLearningRecovery>>;

const RUNTIME_SHA = /^[a-f0-9]{40}$/u;
const HEARTBEAT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/u;

function readCourseSupportLearningRuntimeBlocker(error: CourseSupportRuntimeUpdateFailure, runtimeVersion: string, observedAt = new Date()): CourseSupportLearningRuntimeBlocker | null {
  const evidence = { kind: "WINDOWS_RUNTIME_BLOCKED", runtimeVersion, observedAt, diagnostic: error.diagnostic } as const;
  return readPreAdmissionRuntimeBlocker(evidence, observedAt) ? evidence : null;
}

function readRuntimeRecord(stdout: unknown): Record<string, unknown> | null {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 16_384) return null;
  try {
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function isQualifiedCourseSupportLearningRuntime(stdout: unknown, runtimeVersion: string) {
  const validated = readRuntimeRecord(stdout);
  return RUNTIME_SHA.test(runtimeVersion) && validated?.outcome === "already_current" &&
    validated.runtimeVersion === runtimeVersion && validated.acceptanceRestartProof === false;
}

/** Project the trusted managed task's read-only Inspect output without its local paths. */
export function readCourseSupportLearningRuntimeReadyReceipt(stdout: unknown, runtimeVersion: string,
  observedAt = new Date()): CourseSupportLearningRuntimeReadyReceipt | null {
  const task = readRuntimeRecord(stdout);
  if (!task || !RUNTIME_SHA.test(runtimeVersion) || !Number.isFinite(observedAt.getTime()) || task.action !== "Inspect" ||
      task.apply !== false || task.taskName !== "Tee Time Spot Course Discovery" ||
      task.taskPath !== "\\TeeTimeSpot\\" || task.exists !== true || task.state !== "Running" || task.ready !== true ||
      task.restartPrerequisites !== "PRESENT" || task.workerMode !== "STAGEHAND_SOL" || task.pollStatus !== "completed" ||
      task.heartbeatStatus !== "fresh" || task.activeOperations !== 0 || task.drained === true || Object.hasOwn(task, "drainNonce") ||
      task.runtimeVersion !== runtimeVersion || typeof task.lastHeartbeatAt !== "string" ||
      !HEARTBEAT_TIMESTAMP.test(task.lastHeartbeatAt)) return null;
  const heartbeatAt = new Date(task.lastHeartbeatAt);
  const age = observedAt.getTime() - heartbeatAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > 60_000) return null;
  return { kind: "WINDOWS_RUNTIME_READY", runtimeVersion, observedAt, heartbeatAt };
}

/** A controller, not a second learner. Only the normal runtime claims work,
 * performs independent replay and activates a recipe. No check/email writes. */
export async function watchOwnedLearningRecovery(input: {
  prepareRuntime: () => Promise<void>;
  runtimeVersion: string;
  admit: () => Promise<Admission>;
  read: (job: Extract<Admission, { jobId: string }>) => Promise<Progress>;
  readHandoff: (job: Extract<Admission, { jobId: string }>) => Promise<{ durableCloseoutRecorded: boolean;
    method?: Extract<Progress, { state: "METHOD_SAVED" }> }>;
  isStateConflict?: (error: unknown) => boolean;
  signal: AbortSignal;
  now?: () => number;
  wait?: (signal: AbortSignal) => Promise<unknown>;
}) {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (signal => delay(15_000, undefined, { signal }));
  input.signal.throwIfAborted();
  try {
    await input.prepareRuntime();
  } catch (error) {
    input.signal.throwIfAborted();
    const blocker = error instanceof CourseSupportRuntimeUpdateFailure && readCourseSupportLearningRuntimeBlocker(error, input.runtimeVersion);
    if (blocker) return { outcome: "runtime_blocked_before_admission" as const, blocker, error };
    throw error;
  }
  input.signal.throwIfAborted();
  const job = await input.admit();
  if (job.outcome !== "created" && job.outcome !== "existing") return { outcome: "learning_recovery_deferred" as const, admission: job,
    durableCloseoutRecorded: false, monitoringVerified: false, deliveryVerified: false };
  const stopAt = now() + 18 * 60_000;
  let last: Progress | null = null;
  while (now() < stopAt) {
    try {
      last = await input.read(job);
      if (last.state === "METHOD_SAVED") {
        // Activation closes only the coding phase atomically. A read of that
        // actual marker permits completion even if its heartbeat raced closure.
        const handoff = await input.readHandoff(job);
        if (!handoff.durableCloseoutRecorded) throw Error("LEARNING_HANDOFF_NOT_RECORDED");
        return { outcome: "learning_recipe_handoff" as const, durableCloseoutRecorded: true,
          monitoringVerified: false, deliveryVerified: false, job, method: last };
      }
      input.signal.throwIfAborted();
      if (last.state !== "PENDING") return { outcome: "repair_required" as const, ownershipRetained: true,
        durableCloseoutRecorded: false, monitoringVerified: false, deliveryVerified: false, job, learning: last };
      await wait(input.signal);
    } catch (error) {
      if (input.isStateConflict?.(error)) {
        // A completed atomic coding handoff can outlive the active-state
        // projection. Reconcile that historical phase once, without repeating
        // the failed read, admission, runtime preparation or any provider work.
        const handoff = await input.readHandoff(job);
        if (!handoff.durableCloseoutRecorded || !handoff.method ||
            handoff.method.runtimeVersion !== job.runtimeVersion) throw error;
        return { outcome: "learning_recipe_handoff" as const, durableCloseoutRecorded: true,
          monitoringVerified: false, deliveryVerified: false, job, method: handoff.method };
      }
      if (!input.signal.aborted) throw error;
      // Never suppress lost ownership unless the independently persisted phase
      // handoff for this exact original owner actually completed.
      const completed = await input.read(job);
      if (completed.state !== "METHOD_SAVED") throw error;
      const handoff = await input.readHandoff(job);
      if (!handoff.durableCloseoutRecorded) throw error;
      return { outcome: "learning_recipe_handoff" as const, durableCloseoutRecorded: true,
        monitoringVerified: false, deliveryVerified: false, job, method: completed };
    }
  }
  return { outcome: "learning_recovery_pending" as const, ownershipRetained: true,
    durableCloseoutRecorded: false, monitoringVerified: false, deliveryVerified: false, job, learning: last };
}
