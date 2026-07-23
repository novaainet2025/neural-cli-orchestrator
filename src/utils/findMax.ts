export function findMax(arr: number[]): number | undefined {
  if (arr.length === 0) {
    return undefined;
  }

  let maximum = arr[0];
  for (let index = 1; index < arr.length; index += 1) {
    maximum = Math.max(maximum, arr[index]);
  }
  return maximum;
}
