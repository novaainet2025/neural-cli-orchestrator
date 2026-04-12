import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { sharedState } from './shared-state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sync-engine');

const SYNC_INTERVAL_MS = 5000;

class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingWrites: Array<{ id: string; status: string }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  configure(): void {
    const db = getDb();
    db.pragma('journal_mode = WAL');
  }

  private queueWrite(id: string, status: string): void {
    this.pendingWrites.push({ id, status });
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => this.flushWrites(), 50);
    }
  }

  private flushWrites(): void {
    this.batchTimer = null;
    if (this.pendingWrites.length === 0) return;

    const batch = this.pendingWrites;
    this.pendingWrites = [];

    try {
      const db = getDb();
      const update = db.prepare(`
        UPDATE agents SET status = ?, last_heartbeat = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `);

      const tx = db.transaction(() => {
        for (const w of batch) {
          update.run(w.status, w.id);
        }
      });

      tx();
    } catch (err) {
      log.error({ err }, 'Flush writes failed');
    }
  }

  // ─── Forward Sync: Redis → SQLite (periodic) ──────
  async forwardSync(): Promise<void> {
    if (!isRedisConnected()) return;

    try {
      const states = await sharedState.getAllAgentStates();

      for (const [id, state] of Object.entries(states)) {
        this.queueWrite(id, state.status);
      }
    } catch (err) {
      log.error({ err }, 'Forward sync failed');
    }
  }

  // ─── Recovery Sync: SQLite → Redis (on startup) ───
  async recoverySync(): Promise<void> {
    try {
      const db = getDb();
      const agents = db.prepare('SELECT id, status FROM agents WHERE enabled = 1').all() as any[];

      for (const agent of agents) {
        await sharedState.setAgentState(agent.id, {
          id: agent.id,
          status: agent.status === 'online' ? 'idle' : 'offline',
        });
      }

      log.info({ count: agents.length }, 'Recovery sync complete (SQLite → Redis)');
    } catch (err) {
      log.error({ err }, 'Recovery sync failed');
    }
  }

  // ─── Start periodic sync ─────────────────────────
  start(): void {
    if (this.timer) return;

    this.configure();

    this.timer = setInterval(() => {
      this.forwardSync().catch(err => log.error({ err }, 'Periodic sync error'));
    }, SYNC_INTERVAL_MS);

    log.info({ intervalMs: SYNC_INTERVAL_MS }, 'Sync engine started');
  }

  // ─── Stop ─────────────────────────────────────────
  stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.flushWrites();

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Sync engine stopped');
    }
  }
}

export const syncEngine = new SyncEngine();

// ─── Vector Clock ────────────────────────────────────
const vectorClock = new Map<string, number>();
export function incrementClock(nodeId: string): number {
  const v = (vectorClock.get(nodeId) ?? 0) + 1;
  vectorClock.set(nodeId, v);
  return v;
}
export function getVectorClock(): Record<string, number> {
  return Object.fromEntries(vectorClock);
}
