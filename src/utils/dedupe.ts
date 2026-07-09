export function deduplicate<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function deduplicateByKey<T, K>(items: readonly T[], getKey: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
