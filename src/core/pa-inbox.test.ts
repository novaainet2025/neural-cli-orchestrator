import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { PaInbox, createPaInbox } from './pa-inbox.js';

/** Deterministic, test-controlled clock. */
function fixedClock(startMs: number): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('PaInbox', () => {
  describe('enqueue -> drain roundtrip', () => {
    it('drains enqueued messages in FIFO order then returns empty on re-drain', () => {
      const db = new Database(':memory:');
      const clock = fixedClock(1_000);
      const inbox = createPaInbox(db, { now: clock.now });

      inbox.enqueue('agent-a', 'first');
      inbox.enqueue('agent-a', 'second');
      inbox.enqueue('agent-b', 'other-inbox'); // isolation: must not leak into agent-a

      expect(inbox.pendingCount('agent-a')).toBe(2);

      const drained = inbox.drain('agent-a');
      expect(drained.map((m) => m.body)).toEqual(['first', 'second']);
      expect(drained[0]!.id).toBeLessThan(drained[1]!.id); // FIFO by rowid
      expect(drained.every((m) => m.slug === 'agent-a')).toBe(true);
      expect(drained[0]!.enqueuedAt).toBe(1_000);

      // Re-drain with no new enqueues -> empty.
      expect(inbox.drain('agent-a')).toEqual([]);
      expect(inbox.pendingCount('agent-a')).toBe(0);

      // The other inbox is untouched.
      expect(inbox.pendingCount('agent-b')).toBe(1);
      expect(inbox.drain('agent-b').map((m) => m.body)).toEqual(['other-inbox']);

      db.close();
    });

    it('drains only messages enqueued after the previous drain', () => {
      const db = new Database(':memory:');
      const inbox = new PaInbox(db, { now: fixedClock(0).now });

      inbox.enqueue('s', 'm1');
      expect(inbox.drain('s').map((m) => m.body)).toEqual(['m1']);

      inbox.enqueue('s', 'm2');
      inbox.enqueue('s', 'm3');
      expect(inbox.drain('s').map((m) => m.body)).toEqual(['m2', 'm3']);
      expect(inbox.drain('s')).toEqual([]);

      db.close();
    });
  });

  describe('durability (persistent SQLite file)', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pa-inbox-'));
      dbPath = join(dir, 'inbox.db');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('preserves undrained messages across a close/reopen of the same DB file', () => {
      // Session 1: enqueue, then simulate a process crash (close without draining).
      const db1 = new Database(dbPath);
      const inbox1 = createPaInbox(db1, { now: fixedClock(5_000).now });
      inbox1.enqueue('persistent-agent', 'survive-me-1');
      inbox1.enqueue('persistent-agent', 'survive-me-2');
      db1.close();

      expect(existsSync(dbPath)).toBe(true);

      // Session 2: reopen the same file — pending messages must still be there.
      const db2 = new Database(dbPath);
      const inbox2 = createPaInbox(db2, { now: fixedClock(9_000).now });
      expect(inbox2.pendingCount('persistent-agent')).toBe(2);

      const drained = inbox2.drain('persistent-agent');
      expect(drained.map((m) => m.body)).toEqual(['survive-me-1', 'survive-me-2']);
      expect(drained[0]!.enqueuedAt).toBe(5_000); // original enqueue time survived

      // And a drained message does NOT reappear after another reopen.
      db2.close();
      const db3 = new Database(dbPath);
      const inbox3 = createPaInbox(db3, { now: fixedClock(10_000).now });
      expect(inbox3.pendingCount('persistent-agent')).toBe(0);
      expect(inbox3.drain('persistent-agent')).toEqual([]);
      db3.close();
    });
  });

  describe('reconcile (self-healing)', () => {
    it('re-queues stale pending messages so they can be drained again', () => {
      const db = new Database(':memory:');
      const clock = fixedClock(0);
      const inbox = createPaInbox(db, { now: clock.now, staleAfterMs: 1_000, maxDeliveries: 3 });

      inbox.enqueue('worker', 'task');

      // Not yet stale.
      clock.set(500);
      expect(inbox.reconcile()).toEqual({ requeued: 0, deadLettered: 0 });

      // Now stale (>= staleAfterMs since updated_at=0).
      clock.set(2_000);
      expect(inbox.reconcile()).toEqual({ requeued: 1, deadLettered: 0 });

      // Still pending & drainable after requeue (id preserved => FIFO intact).
      expect(inbox.pendingCount('worker')).toBe(1);
      expect(inbox.drain('worker').map((m) => m.body)).toEqual(['task']);

      db.close();
    });

    it('dead-letters a message once it exceeds maxDeliveries instead of looping forever', () => {
      const db = new Database(':memory:');
      const clock = fixedClock(0);
      const inbox = createPaInbox(db, { now: clock.now, staleAfterMs: 100, maxDeliveries: 2 });

      inbox.enqueue('flaky', 'poison');

      // Two reconcile passes bump deliveries 0->1->2 (both requeue).
      clock.advance(200);
      expect(inbox.reconcile()).toEqual({ requeued: 1, deadLettered: 0 });
      clock.advance(200);
      expect(inbox.reconcile()).toEqual({ requeued: 1, deadLettered: 0 });

      // Third pass: deliveries (2) >= maxDeliveries (2) -> dead-letter.
      clock.advance(200);
      expect(inbox.reconcile()).toEqual({ requeued: 0, deadLettered: 1 });

      // No longer pending; surfaced via deadLetters(), not drain().
      expect(inbox.pendingCount('flaky')).toBe(0);
      expect(inbox.drain('flaky')).toEqual([]);
      expect(inbox.deadLetters('flaky').map((m) => m.body)).toEqual(['poison']);

      db.close();
    });
  });
});
