export async function runProviderFamilyTasks<T>(
  items: T[],
  getProviderFamilyKey: (item: T) => string,
  worker: (item: T) => Promise<void>,
  maxConcurrency = 2
) {
  const pending = items.map(item => ({ item, family: getProviderFamilyKey(item) }));
  const concurrency = Math.max(1, Math.min(2, maxConcurrency));
  const running = new Map<string, Promise<{ family: string } | { family: string; error: unknown }>>();

  while (pending.length > 0 || running.size > 0) {
    while (running.size < concurrency) {
      const next = pending.findIndex(({ family }) => !running.has(family));
      if (next < 0) break;
      const [{ item, family }] = pending.splice(next, 1);
      running.set(family, Promise.resolve().then(() => worker(item)).then(
        () => ({ family }),
        (error: unknown) => ({ family, error }),
      ));
    }

    // A slow provider holds only its own slot. The sibling slot can move to
    // another family as soon as its current work has actually finished.
    const finished = await Promise.race(running.values());
    running.delete(finished.family);
    if ("error" in finished) {
      await Promise.all(running.values());
      throw finished.error;
    }
  }
}
