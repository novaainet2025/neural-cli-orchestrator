export function findMax(arr: number[]): number | undefined {
  if (arr.length === 0) {
    return undefined;
  }
  return Math.max(...arr);
}
