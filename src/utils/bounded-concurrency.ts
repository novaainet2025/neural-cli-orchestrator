export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  if (items.length === 0) return 0;

  const limit = Number.isFinite(concurrency)
    ? Math.max(1, Math.min(items.length, Math.floor(concurrency)))
    : 1;
  let nextIndex = 0;
  let processed = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (shouldContinue()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
      processed += 1;
    }
  });

  await Promise.all(runners);
  return processed;
}
