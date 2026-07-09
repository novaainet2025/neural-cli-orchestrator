import { describe, expect, it } from 'vitest';
import { fibonacci } from '../src/fibonacci.js';

describe('src/fibonacci.js', () => {
  it('returns the correct Fibonacci number', () => {
    expect(fibonacci(0)).toBe(0);
    expect(fibonacci(1)).toBe(1);
    expect(fibonacci(2)).toBe(1);
    expect(fibonacci(10)).toBe(55);
    expect(fibonacci(30)).toBe(832040);
  });

  it('rejects invalid input', () => {
    expect(() => fibonacci(-1)).toThrow(RangeError);
    expect(() => fibonacci(1.5)).toThrow(RangeError);
  });
});
