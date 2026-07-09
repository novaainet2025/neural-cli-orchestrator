/**
 * Computes the n-th Fibonacci number using memoization.
 * Time complexity: O(n)
 * Space complexity: O(n)
 *
 * @param {number} n
 * @returns {number}
 */
export function fibonacci(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }

  const memo = new Array(n + 1);
  memo[0] = 0;

  if (n >= 1) {
    memo[1] = 1;
  }

  for (let i = 2; i <= n; i += 1) {
    memo[i] = memo[i - 1] + memo[i - 2];
  }

  return memo[n];
}
