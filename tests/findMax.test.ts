import { expect, test } from 'vitest';
import { findMax } from '../src/utils/findMax';

test('findMax returns the maximum value in a non-empty array', () => {
  expect(findMax([1, 2, 3, 4, 5])).toBe(5);
  expect(findMax([-1, -5, -2, 0])).toBe(0);
  expect(findMax([10])).toBe(10);
});

test('findMax returns undefined for an empty array', () => {
  expect(findMax([])).toBeUndefined();
});

test('findMax works with large numbers', () => {
  expect(findMax([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toBe(Number.MAX_SAFE_INTEGER);
});
