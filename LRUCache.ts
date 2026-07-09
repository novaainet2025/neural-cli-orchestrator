export class LRUCache<K, V> {
  private capacity: number;
  private map: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity);
    this.map = new Map<K, V>();
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key)!;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  put(key: K, value: V): void {
    if (this.capacity === 0) {
      // Do not store anything
      return;
    }
    if (this.map.has(key)) {
      // Update existing
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Remove least recently used (first element)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  // Optional: for inspection
  size(): number {
    return this.map.size;
  }

  // Optional: clear
  clear(): void {
    this.map.clear();
  }
}