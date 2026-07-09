import { describe, it, expect } from 'vitest';
import { fibonacci } from '../fibonacci.ts';

describe('fibonacci memoized', () => {
  it('handles base cases', () => {
    expect(fibonacci(0)).toBe(0);
    expect(fibonacci(1)).toBe(1);
  });

  it('computes small numbers', () => {
    expect(fibonacci(5)).toBe(5);
    expect(fibonacci(10)).toBe(55);
  });

  it('computes larger numbers efficiently', () => {
    expect(fibonacci(20)).toBe(6765);
    expect(fibonacci(30)).toBe(832040);
  });

  it('rejects invalid input', () => {
    expect(() => fibonacci(-1)).toThrow();
    // @ts-expect-error testing non‑integer
    expect(() => fibonacci(3.5)).toThrow();
  });
});
