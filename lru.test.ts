import { LRUCache } from './lru';

describe('LRUCache', () => {
  let cache: LRUCache<number, string>;

  beforeEach(() => {
    cache = new LRUCache<number, string>(2);
  });

  test('should return undefined for non-existent key', () => {
    expect(cache.get(1)).toBeUndefined();
  });

  test('should store and retrieve value', () => {
    cache.put(1, 'one');
    expect(cache.get(1)).toBe('one');
  });

  test('should update existing key', () => {
    cache.put(1, 'one');
    cache.put(1, 'uno');
    expect(cache.get(1)).toBe('uno');
  });

  test('should evict least recently used when capacity exceeded', () => {
    cache.put(1, 'one');
    cache.put(2, 'two');
    cache.put(3, 'three'); // should evict key 1
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe('two');
    expect(cache.get(3)).toBe('three');
  });

  test('should mark recently used', () => {
    cache.put(1, 'one');
    cache.put(2, 'two');
    cache.get(1); // access 1
    cache.put(3, 'three'); // should evict 2 (least recently used)
    expect(cache.get(1)).toBe('one');
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(3)).toBe('three');
  });

  test('should handle zero capacity', () => {
    const zeroCache = new LRUCache<number, string>(0);
    zeroCache.put(1, 'one');
    expect(zeroCache.get(1)).toBeUndefined();
    expect(zeroCache.size()).toBe(0);
  });

  test('size should reflect number of entries', () => {
    expect(cache.size()).toBe(0);
    cache.put(1, 'one');
    expect(cache.size()).toBe(1);
    cache.put(2, 'two');
    expect(cache.size()).toBe(2);
    cache.put(3, 'three'); // evicts one
    expect(cache.size()).toBe(2);
  });

  test('clear should remove all entries', () => {
    cache.put(1, 'one');
    cache.put(2, 'two');
    cache.clear();
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});