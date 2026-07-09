export function removeDuplicates<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr));
}

export function uniq<T>(arr: readonly T[]): T[] {
  return removeDuplicates(arr);
}
