/**
 * Race condition detection via Promise.all concurrent request simulation.
 *
 * Strategy:
 *  1. Demonstrate a known-broken counter (yield between read/write) fails under load.
 *  2. Assert invariants on production concurrency primitives under burst load.
 *  3. Verify SQLite + ID generation stay consistent when writes fire in parallel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { AsyncQueue } from '../src/utils/asyncQueue.js';
import { ResourceLimiter } from '../src/security/resource-limiter.js';
import { getDb, runMigrations, closeDb } from '../src/storage/database.js';
import { createTaskId } from '../src/utils/id.js';
import { env } from '../src/utils/config.js';

/** Yield one microtask — interleaves async callers like concurrent HTTP handlers. */
const yieldTick = (): Promise<void> => Promise.resolve();

/** Intentionally racy counter for regression detection. */
class VulnerableCounter {
  private value = 0;

  async increment(): Promise<void> {
    const current = this.value;
    await yieldTick();
    this.value = current + 1;
  }

  get(): number {
    return this.value;
  }
}

/** Serialized counter — expected to pass the same load test. */
class SafeCounter {
  private value = 0;
  private chain: Promise<void> = Promise.resolve();

  increment(): Promise<void> {
    this.chain = this.chain.then(() => {
      this.value++;
    });
    return this.chain;
  }

  get(): number {
    return this.value;
  }
}

describe('Race condition detection (Promise.all simulation)', () => {
  describe('detector baseline — intentional race vs fix', () => {
    it('detects lost updates when read-modify-write yields', async () => {
      const counter = new VulnerableCounter();
      const workers = 50;

      await Promise.all(Array.from({ length: workers }, () => counter.increment()));

      expect(counter.get()).toBeLessThan(workers);
    });

    it('passes when updates are serialized', async () => {
      const counter = new SafeCounter();
      const workers = 50;

      await Promise.all(Array.from({ length: workers }, () => counter.increment()));

      expect(counter.get()).toBe(workers);
    });
  });

  describe('ResourceLimiter — concurrent slot acquisition', () => {
    it('never exceeds maxConcurrentActions when slots are held concurrently', async () => {
      const limit = 4;
      const attempts = 10;
      const rl = new ResourceLimiter({ maxConcurrentActions: limit });
      let peakActive = 0;
      let entered = 0;

      let releaseBarrier!: () => void;
      const holdUntil = new Promise<void>(resolve => {
        releaseBarrier = resolve;
      });

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, async () => {
          await yieldTick();
          const release = await rl.acquireSlot();
          entered++;
          peakActive = Math.max(peakActive, rl.getActiveCount());
          if (entered === limit) releaseBarrier();
          await holdUntil;
          release();
        }),
      );

      const acquired = results.filter(r => r.status === 'fulfilled').length;
      const rejected = results.filter(r => r.status === 'rejected').length;

      expect(peakActive).toBeLessThanOrEqual(limit);
      expect(acquired).toBe(limit);
      expect(rejected).toBe(attempts - limit);
      expect(rl.getActiveCount()).toBe(0);
    });
  });

  describe('AsyncQueue — concurrency ceiling under burst', () => {
    it('never runs more than maxConcurrency tasks simultaneously', async () => {
      const maxConcurrency = 3;
      const queue = new AsyncQueue(maxConcurrency);
      let inFlight = 0;
      let peakInFlight = 0;
      const taskCount = 24;

      await Promise.all(
        Array.from({ length: taskCount }, (_, i) =>
          queue.add(async () => {
            inFlight++;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return i;
          }),
        ),
      );

      expect(peakInFlight).toBeLessThanOrEqual(maxConcurrency);
      expect(inFlight).toBe(0);
    });
  });

  describe('SQLite + ID generation — parallel write integrity', () => {
    const testDbPath = resolve(env.ROOT, 'db/test-concurrency-race.db');

    beforeAll(() => {
      process.env.DATABASE_PATH = testDbPath;
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      runMigrations();
    });

    afterAll(() => {
      // 방어적 정리: 격리가 깨져 라이브 DB에 붙었더라도 테스트 행을 남기지 않는다
      try {
        getDb().prepare(`DELETE FROM tasks WHERE prompt LIKE 'race-test-%'`).run();
      } catch {
        // DB가 이미 닫혔으면 무시
      }
      closeDb();
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
      delete process.env.DATABASE_PATH;
    });

    it('generates unique task IDs under concurrent Promise.all', async () => {
      const ids = await Promise.all(
        Array.from({ length: 200 }, async () => {
          await yieldTick();
          return createTaskId();
        }),
      );

      expect(new Set(ids).size).toBe(ids.length);
    });

    it('persists concurrent task inserts without ID collision', async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO tasks (id, mode, prompt, status, priority)
        VALUES (?, 'task', ?, 'pending', 5)
      `);

      const rows = await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          await yieldTick();
          const id = createTaskId();
          insert.run(id, `race-test-${i}`);
          return id;
        }),
      );

      const unique = new Set(rows);
      expect(unique.size).toBe(rows.length);

      const count = db
        .prepare(`SELECT count(*) AS n FROM tasks WHERE prompt LIKE 'race-test-%'`)
        .get() as { n: number };
      expect(count.n).toBe(rows.length);
    });
  });
});
