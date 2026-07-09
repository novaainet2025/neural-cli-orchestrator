/**
 * LRU Cache implementation with O(1) get and put operations.
 * Uses a Map for fast key lookup and a doubly linked list to track usage order.
 */
export class LRUCache<K, V> {
  private capacity: number;
  private map: Map<K, ListNode<K, V>>;
  private head: ListNode<K, V> | null = null;
  private tail: ListNode<K, V> | null = null;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('Capacity must be greater than 0');
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.moveToHead(node);
    return node.value;
  }

  put(key: K, value: V): void {
    let node = this.map.get(key);
    if (node) {
      node.value = value;
      this.moveToHead(node);
    } else {
      node = new ListNode(key, value);
      this.map.set(key, node);
      this.addNode(node);
      if (this.map.size > this.capacity) {
        this.removeTail();
      }
    }
  }

  private addNode(node: ListNode<K, V>) {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: ListNode<K, V>) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }

  private moveToHead(node: ListNode<K, V>) {
    this.removeNode(node);
    this.addNode(node);
  }

  private removeTail() {
    if (!this.tail) return;
    this.map.delete(this.tail.key);
    this.removeNode(this.tail);
  }
}

class ListNode<K, V> {
  key: K;
  value: V;
  prev: ListNode<K, V> | null = null;
  next: ListNode<K, V> | null = null;
  constructor(key: K, value: V) {
    this.key = key;
    this.value = value;
  }
}
