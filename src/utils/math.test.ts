import { describe, expect, it } from 'vitest';
import { add, addTwo } from './math.js';
import { MathValidationError, validateAdd, validateAddTwo } from '../services/mathService.js';

describe('add', () => {
  it('adds positive integers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('adds a negative number and a positive number', () => {
    expect(add(-5, 5)).toBe(0);
  });

  it('adds zero values', () => {
    expect(add(0, 0)).toBe(0);
  });

  it('adds decimal values', () => {
    expect(add(1.25, 2.5)).toBe(3.75);
  });

  it('adds negative decimal values', () => {
    expect(add(-1.5, -2.5)).toBe(-4);
  });

  it('returns Number.MAX_SAFE_INTEGER when adding zero', () => {
    expect(add(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns Number.MIN_SAFE_INTEGER when adding zero', () => {
    expect(add(Number.MIN_SAFE_INTEGER, 0)).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('supports Number.EPSILON edge arithmetic', () => {
    expect(add(Number.EPSILON, 0)).toBe(Number.EPSILON);
  });

  it('throws Error for NaN input', () => {
    expect(() => add(Number.NaN, 1)).toThrowError(Error);
    expect(() => add(Number.NaN, 1)).toThrow('NaN is not allowed');
  });

  it('throws TypeError for non-number input', () => {
    expect(() => add('1' as unknown as number, 1)).toThrowError(TypeError);
    expect(() => add('1' as unknown as number, 1)).toThrow('Both "a" and "b" must be numbers');
  });

  it('throws Error for undefined input', () => {
    expect(() => add(undefined as unknown as number, 1)).toThrowError(Error);
    expect(() => add(undefined as unknown as number, 1)).toThrow('Both "a" and "b" are required');
  });

  it('throws Error for null input', () => {
    expect(() => add(null as unknown as number, 1)).toThrowError(Error);
    expect(() => add(null as unknown as number, 1)).toThrow('Both "a" and "b" are required');
  });
});

describe('addTwo', () => {
  it('preserves legacy compatibility', () => {
    expect(addTwo(1, 1)).toBe(2);
  });
});

describe('validateAdd', () => {
  it('returns the API payload shape for valid input', () => {
    expect(validateAdd(1, 1)).toEqual({ result: 2, ok: true });
  });

  it('rejects NaN input', () => {
    expect(() => validateAdd(Number.NaN, 1)).toThrow(MathValidationError);
  });

  it('rejects values beyond safe numeric limits', () => {
    expect(() => validateAdd(Number.MAX_SAFE_INTEGER, 10)).toThrow(MathValidationError);
  });
});

describe('validateAddTwo', () => {
  it('remains an alias for the legacy service entrypoint', () => {
    expect(validateAddTwo(2, 3)).toEqual({ result: 5, ok: true });
  });
});
