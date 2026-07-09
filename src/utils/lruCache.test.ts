import { describe, expect, it } from 'vitest';
import { LRUCache } from './lruCache.js';

describe('LRUCache', () => {
  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<number, string>(2);

    expect(cache.get(1)).toBeUndefined();
  });

  it('evicts the least recently used item when capacity is exceeded', () => {
    const cache = new LRUCache<number, number>(2);

    cache.put(1, 1);
    cache.put(2, 2);
    expect(cache.get(1)).toBe(1);

    cache.put(3, 3);

    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe(1);
    expect(cache.get(3)).toBe(3);
  });

  it('updates an existing key and marks it as most recently used', () => {
    const cache = new LRUCache<string, number>(2);

    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('a', 10);
    cache.put('c', 3);

    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('supports a capacity of one', () => {
    const cache = new LRUCache<number, string>(1);

    cache.put(1, 'one');
    cache.put(2, 'two');

    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe('two');
  });

  it('throws when capacity is zero or negative', () => {
    expect(() => new LRUCache(0)).toThrow('Capacity must be greater than 0');
    expect(() => new LRUCache(-1)).toThrow('Capacity must be greater than 0');
  });
});
