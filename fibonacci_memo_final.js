/**
 * Return the n-th Fibonacci number using memoization.
 * Time complexity: O(n)
 * Space complexity: O(n)
 * @param {number} n - Non-negative integer index
 * @returns {number}
 */
export function fib(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }

  const memo = new Map([[0, 0], [1, 1]]);

  function compute(index) {
    if (memo.has(index)) {
      return memo.get(index);
    }

    const value = compute(index - 1) + compute(index - 2);
    memo.set(index, value);
    return value;
  }

  return compute(n);
}