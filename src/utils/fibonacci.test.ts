import { describe, expect, it } from 'vitest';
import { fibonacci } from './fibonacci.js';

describe('fibonacci', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite input %s',
    (input) => {
      expect(() => fibonacci(input)).toThrow('n must be a non-negative integer');
    },
  );
});
