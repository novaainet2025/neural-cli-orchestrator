import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('shared-state');

// ─── Agent State ──────────────────────────────────────
export interface AgentState {
  id: string;
  status: string;
  currentTask: string | null;
  currentFiles: string[];
  lastAction: string | null;
  lastActionAt: number | null;
  messageCount: number;
  health: {
    consecutiveFailures: number;
    circuitState: 'closed' | 'open' | 'half-open';
    lastError: string | null;
  };
}

const AGENT_PREFIX = 'nco:agent:';
const AGENT_TTL = 300; // 5 min
const ARTIFACTS_KEY = 'nco:artifacts:recent';
const LOCK_PREFIX = 'nco:lock:file:';

export class SharedState {
  // ─── Agent State ──────────────────────────────────
  async getAgentState(agentId: string): Promise<AgentState | null> {
    if (!isRedisConnected()) return null;
    const redis = await getRedis();
    const raw = await redis.get(`${AGENT_PREFIX}${agentId}:state`);
    return raw ? JSON.parse(raw) : null;
  }

  async setAgentState(agentId: string, state: Partial<AgentState>): Promise<void> {
    if (!isRedisConnected()) return;
    const redis = await getRedis();
    const current = await this.getAgentState(agentId);
    const merged: AgentState = {
      id: agentId,
      status: 'offline',
      currentTask: null,
      currentFiles: [],
      lastAction: null,
      lastActionAt: null,
      messageCount: 0,
      health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      ...current,
      ...state,
    };
    await redis.set(`${AGENT_PREFIX}${agentId}:state`, JSON.stringify(merged), 'EX', AGENT_TTL);
  }

  async getAllAgentStates(): Promise<Record<string, AgentState>> {
    if (!isRedisConnected()) return {};
    const redis = await getRedis();
    const keys = await redis.keys(`${AGENT_PREFIX}*:state`);
    const result: Record<string, AgentState> = {};
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        const state = JSON.parse(raw) as AgentState;
        result[state.id] = state;
      }
    }
    return result;
  }

  // ─── Heartbeat ────────────────────────────────────
  async heartbeat(agentId: string): Promise<void> {
    if (!isRedisConnected()) return;
    const redis = await getRedis();
    await redis.set(`${AGENT_PREFIX}${agentId}:heartbeat`, String(Date.now()), 'EX', 60);
  }

  async isAgentAlive(agentId: string): Promise<boolean> {
    if (!isRedisConnected()) return false;
    const redis = await getRedis();
    return (await redis.exists(`${AGENT_PREFIX}${agentId}:heartbeat`)) === 1;
  }

  // ─── File Locks ───────────────────────────────────
  async acquireLock(path: string, agentId: string, ttlMs = 300_000): Promise<boolean> {
    if (!isRedisConnected()) return true; // no redis = no lock needed
    const redis = await getRedis();
    const key = `${LOCK_PREFIX}${path}`;
    const result = await redis.set(key, agentId, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(path: string, agentId: string): Promise<boolean> {
    if (!isRedisConnected()) return true;
    const redis = await getRedis();
    const key = `${LOCK_PREFIX}${path}`;
    const holder = await redis.get(key);
    if (holder === agentId) {
      await redis.del(key);
      return true;
    }
    return false;
  }

  async getLockHolder(path: string): Promise<string | null> {
    if (!isRedisConnected()) return null;
    const redis = await getRedis();
    return redis.get(`${LOCK_PREFIX}${path}`);
  }

  // ─── Config Seeding (JSON → DB) ───────────────────
  async seedProviders(): Promise<void> {
    const db = getDb();
    const providers = loadEnabledProviders();

    const upsert = db.prepare(`
      INSERT INTO agents (id, name, type, role, score, model, command, args_json, endpoint, api_key_ref,
        capabilities_json, permissions_json, persona_json, concurrency, rate_limit_rpm, cost, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, role=excluded.role, score=excluded.score,
        model=excluded.model, command=excluded.command, args_json=excluded.args_json,
        endpoint=excluded.endpoint, api_key_ref=excluded.api_key_ref,
        capabilities_json=excluded.capabilities_json, permissions_json=excluded.permissions_json,
        persona_json=excluded.persona_json, concurrency=excluded.concurrency,
        rate_limit_rpm=excluded.rate_limit_rpm, cost=excluded.cost, enabled=1,
        updated_at=datetime('now')
    `);

    const seedTx = db.transaction((provs: ProviderConfig[]) => {
      for (const p of provs) {
        upsert.run(
          p.id, p.name, p.type, p.role, p.score, p.model, p.command,
          JSON.stringify(p.args), p.endpoint || null, p.apiKeyRef || null,
          JSON.stringify(p.capabilities), JSON.stringify(p.permissions),
          JSON.stringify(p.persona), p.concurrency, p.rateLimitRpm, p.cost
        );
      }
    });

    seedTx(providers);

    // Disable agents that are NOT in the enabled providers list (config says disabled)
    const enabledIds = providers.map(p => p.id);
    if (enabledIds.length > 0) {
      const placeholders = enabledIds.map(() => '?').join(',');
      const disableResult = db.prepare(
        `UPDATE agents SET enabled=0, updated_at=datetime('now') WHERE id NOT IN (${placeholders})`
      ).run(...enabledIds);
      if (disableResult.changes > 0) {
        log.info({ count: disableResult.changes }, 'Providers disabled (not in config enabled list)');
      }
    }

    log.info({ count: providers.length }, 'Providers seeded to DB');

    // Also set initial Redis state
    for (const p of providers) {
      await this.setAgentState(p.id, {
        id: p.id,
        status: 'idle',
        currentTask: null,
        currentFiles: [],
        lastAction: null,
        lastActionAt: null,
        messageCount: 0,
        health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      });
    }
  }
}

export const sharedState = new SharedState();
