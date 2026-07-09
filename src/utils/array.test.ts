import { describe, expect, it } from 'vitest';
import { dedupeArray } from './array.js';

describe('dedupeArray', () => {
  it('removes duplicate primitive values while preserving order', () => {
    expect(dedupeArray([1, 2, 1, 3, 2, 4])).toEqual([1, 2, 3, 4]);
    expect(dedupeArray(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('returns a new empty array for empty input', () => {
    expect(dedupeArray([])).toEqual([]);
  });

  it('deduplicates object references, not deep-equal objects', () => {
    const shared = { id: 1 };

    expect(dedupeArray([shared, shared, { id: 1 }])).toEqual([shared, { id: 1 }]);
  });
});
