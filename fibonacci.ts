/**
 * Calculates the nth Fibonacci number using memoization with Map.
 * 
 * @param {number} n The position of the Fibonacci number to calculate.
 * @returns {number} The nth Fibonacci number.
 */
export function fibonacci(n: number): number {
  if (n < 0) {
    throw new Error('Input must be a non-negative integer');
  }
  const cache = new Map<number, number>([[0, 0], [1, 1]]);

  function fibInternal(k: number): number {
    if (cache.has(k)) {
      return cache.get(k)!;
    }
    const result = fibInternal(k - 1) + fibInternal(k - 2);
    cache.set(k, result);
    return result;
  }

  return fibInternal(n);
}