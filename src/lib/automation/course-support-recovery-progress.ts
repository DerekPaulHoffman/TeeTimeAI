/** Settle only an acknowledged, committed fence adoption within one recovery
 * invocation. Errors, unknown outcomes and ambiguous mutations never replay. */
export async function settleCourseSupportRecoveryFence<T>(
  operation: () => Promise<T>,
  revalidate: () => void | Promise<void>,
): Promise<T> {
  let previousRevision = -1;
  for (let pass = 0; ; pass++) {
    const result = await operation();
    const value = result as Record<string, unknown> | null;
    const progress = value?.recoveryProgress as Record<string, unknown> | undefined;
    if (value?.outcome !== "recovery_required" || value.recovered !== false ||
        value.safelyRequeued !== false || value.durableCloseoutRecorded !== false ||
        progress?.kind !== "COMMITTED_SEARCH_EXECUTION_FENCE_ADOPTION" ||
        !Number.isSafeInteger(progress.revision) || (progress.revision as number) < 1) return result;
    // At most two successful adoptions (legacy empty fence, then fresh settled
    // evidence). Continuing churn stays visible instead of becoming a loop.
    if (pass >= 2 || (progress.revision as number) <= previousRevision) return result;
    previousRevision = progress.revision as number;
    await revalidate();
  }
}
