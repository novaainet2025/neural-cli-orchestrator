// Utility to remove duplicate items from an array.
export function dedupe<T>(arr: T[]): T[] {
  // Using a Set preserves insertion order and removes duplicates.
  return Array.from(new Set(arr));
}
