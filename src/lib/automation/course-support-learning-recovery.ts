import { setTimeout as delay } from "node:timers/promises";
import type { ownedOutdoorLearningRecoveryProgress, requestOwnedOutdoorLearningRecovery } from "@/lib/course-discovery/service";

type Progress = Awaited<ReturnType<typeof ownedOutdoorLearningRecoveryProgress>>;
type Admission = Awaited<ReturnType<typeof requestOwnedOutdoorLearningRecovery>>;

/** A controller, not a second learner. Only the normal runtime claims work,
 * performs independent replay and activates a recipe. No check/email writes. */
export async function watchOwnedLearningRecovery(input: {
  prepareRuntime: () => Promise<void>;
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
  await input.prepareRuntime();
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
