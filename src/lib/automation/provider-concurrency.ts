export async function runProviderFamilyTasks<T>(
  items: T[],
  getProviderFamilyKey: (item: T) => string,
  worker: (item: T) => Promise<void>,
  maxConcurrency = 2
) {
  const pending = [...items];
  const concurrency = Math.max(1, Math.min(2, maxConcurrency));

  while (pending.length > 0) {
    const selectedIndexes: number[] = [];
    const selectedFamilies = new Set<string>();
    for (let index = 0; index < pending.length && selectedIndexes.length < concurrency; index += 1) {
      const family = getProviderFamilyKey(pending[index]);
      if (selectedFamilies.has(family)) {
        continue;
      }
      selectedFamilies.add(family);
      selectedIndexes.push(index);
    }

    const batch = selectedIndexes.map((index) => pending[index]);
    for (const index of [...selectedIndexes].sort((left, right) => right - left)) {
      pending.splice(index, 1);
    }
    await Promise.all(batch.map(worker));
  }
}
