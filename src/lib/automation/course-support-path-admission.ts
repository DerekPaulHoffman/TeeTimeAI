import { setTimeout as delay } from "node:timers/promises";

/** Wait only for a confirmed read-only mutex denial. The enclosing owner-bound
 * heartbeat keeps the lease alive; mutations/errors never replay. */
export async function waitForCourseSupportPathAdmission<T>(attempt: () => Promise<T>, input: {
  signal?: AbortSignal; budgetMs?: number; now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<T> {
  const now = input.now ?? (() => performance.now());
  const budget = input.budgetMs ?? 20 * 60_000;
  if (!Number.isFinite(budget) || budget < 0 || budget > 20 * 60_000) throw Error("Invalid implementation-admission wait budget.");
  const deadline = now() + budget;
  const wait = input.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  for (;;) {
    input.signal?.throwIfAborted();
    const result = await attempt();
    const value = result as Record<string, unknown> | null;
    if (value?.outcome !== "deferred_busy" || value.pathRecorded !== false ||
        !["EXCLUSIVE_IMPLEMENTATION_AUTHORITY_HELD", "WRITER_TRANSITION_LANE_BUSY"].includes(String(value.reasonCode))) return result;
    const remaining = deadline - now();
    if (remaining <= 0) return result;
    await wait(Math.min(30_000, remaining), input.signal);
  }
}
