/**
 * Memoized Fibonacci implementation.
 * Uses a plain object as cache for simplicity.
 */
export function fibonacci(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('n must be a non-negative integer');
  }

  if (n < 2) {
    return n;
  }

  let previous = 0;
  let current = 1;
  for (let index = 2; index <= n; index += 1) {
    const next = previous + current;
    previous = current;
    current = next;
  }

  return current;
}
