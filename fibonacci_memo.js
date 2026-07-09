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

// Optional: simple test when run directly
if (typeof require !== 'undefined' && require.main === module) {
  const assert = require('node:assert/strict');
  assert.equal(fib(0), 0);
  assert.equal(fib(1), 1);
  assert.equal(fib(10), 55);
  assert.equal(fib(50), 12586269025);
  assert.throws(() => fib(-1), RangeError);
  console.log('All tests passed');
}