import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { sharedState } from './shared-state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sync-engine');

const SYNC_INTERVAL_MS = 5000;
const RECOVERABLE_AGENT_STATUSES = new Set(['running', 'idle', 'busy']);

class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingWrites: Array<{ id: string; status: string }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushingWrites = false;

  configure(): void {
    const db = getDb();
    db.pragma('journal_mode = WAL');

    // UPDATE_HOOK: trigger forward sync whenever the agents table changes
    try {
      (db as any).updateHook((type: string, _dbName: string, tableName: string, _rowId: number) => {
        if (tableName === 'agents') {
          if (this.isFlushingWrites) {
            log.debug({ type, tableName }, 'SQLite UPDATE_HOOK ignored during flush');
            return;
          }
          log.debug({ type, tableName }, 'SQLite UPDATE_HOOK → scheduling forward sync');
          this.forwardSync().catch(err => log.error({ err }, 'UPDATE_HOOK sync failed'));
        }
      });
    } catch (err) {
      log.debug({ err }, 'UPDATE_HOOK not supported — skipping');
    }
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

    this.isFlushingWrites = true;
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
    } finally {
      this.isFlushingWrites = false;
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
          status: agent.status === 'online'
            ? 'idle'
            : RECOVERABLE_AGENT_STATUSES.has(agent.status)
              ? agent.status
              : 'offline',
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
export type VectorClock = Record<string, number>;

const vectorClock = new Map<string, number>();

export function incrementClock(nodeId: string): number {
  const v = (vectorClock.get(nodeId) ?? 0) + 1;
  vectorClock.set(nodeId, v);
  return v;
}

export function getVectorClock(): Record<string, number> {
  return Object.fromEntries(vectorClock);
}

/**
 * Merge two vector clocks by taking the max of each component.
 * This is the standard CRDT merge (join / least-upper-bound).
 */
export function mergeClock(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...local };
  for (const [node, tick] of Object.entries(remote)) {
    merged[node] = Math.max(merged[node] ?? 0, tick);
  }
  return merged;
}

export type ClockRelation = 'equal' | 'before' | 'after' | 'concurrent';

/**
 * Detect the causal relationship between two vector clocks.
 *
 * Returns:
 *   'equal'      — identical
 *   'before'     — local happened-before remote
 *   'after'      — local happened-after remote
 *   'concurrent' — neither dominates (conflict)
 */
export function detectConflict(
  local: Record<string, number>,
  remote: Record<string, number>,
): ClockRelation {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

  let localDominates = false;
  let remoteDominates = false;

  for (const key of allKeys) {
    const l = local[key] ?? 0;
    const r = remote[key] ?? 0;
    if (l > r) localDominates = true;
    if (r > l) remoteDominates = true;
    if (localDominates && remoteDominates) return 'concurrent';
  }

  if (localDominates) return 'after';
  if (remoteDominates) return 'before';
  return 'equal';
}

/** Canonical aliases for spec-compliance */
export const compareClocks = detectConflict;
export const mergeClocks = mergeClock;
