import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { sharedState } from './shared-state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sync-engine');

const SYNC_INTERVAL_MS = 5000;

class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;

  // ─── Forward Sync: Redis → SQLite (periodic) ──────
  async forwardSync(): Promise<void> {
    if (!isRedisConnected()) return;

    try {
      const states = await sharedState.getAllAgentStates();
      const db = getDb();

      const update = db.prepare(`
        UPDATE agents SET status = ?, last_heartbeat = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `);

      const tx = db.transaction(() => {
        for (const [id, state] of Object.entries(states)) {
          update.run(state.status, id);
        }
      });

      tx();
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

    this.timer = setInterval(() => {
      this.forwardSync().catch(err => log.error({ err }, 'Periodic sync error'));
    }, SYNC_INTERVAL_MS);

    log.info({ intervalMs: SYNC_INTERVAL_MS }, 'Sync engine started');
  }

  // ─── Stop ─────────────────────────────────────────
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Sync engine stopped');
    }
  }
}

export const syncEngine = new SyncEngine();
