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
const AGENT_TTL = 600; // 10 min (기존 5분 → 소실 방지 확대)
const ARTIFACTS_KEY = 'nco:artifacts:recent';
const LOCK_PREFIX = 'nco:lock:file:';

export class SharedState {
  private localStates: Record<string, AgentState> = {};
  private localHeartbeats: Record<string, number> = {};
  private warnedFallbackOps = new Set<string>();

  private createDefaultState(agentId: string): AgentState {
    return {
      id: agentId,
      status: 'offline',
      currentTask: null,
      currentFiles: [],
      lastAction: null,
      lastActionAt: null,
      messageCount: 0,
      health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
    };
  }

  private warnLocalFallback(op: string): void {
    if (this.warnedFallbackOps.has(op)) return;
    this.warnedFallbackOps.add(op);
    log.warn({ op }, 'Redis unavailable, using in-memory shared state fallback');
  }

  // ─── Agent State ──────────────────────────────────
  async getAgentState(agentId: string): Promise<AgentState | null> {
    if (!isRedisConnected()) {
      this.warnLocalFallback('getAgentState');
      return this.localStates[agentId] || null;
    }
    const redis = await getRedis();
    const raw = await redis.get(`${AGENT_PREFIX}${agentId}:state`);
    if (raw) {
      const state = JSON.parse(raw) as AgentState;
      this.localStates[agentId] = state;
      return state;
    }
    return this.localStates[agentId] || null;
  }

  async setAgentState(agentId: string, state: Partial<AgentState>): Promise<void> {
    const current = await this.getAgentState(agentId);
    const merged: AgentState = { ...this.createDefaultState(agentId), ...current, ...state };
    this.localStates[agentId] = merged;

    if (!isRedisConnected()) {
      this.warnLocalFallback('setAgentState');
      return;
    }

    const redis = await getRedis();
    await redis.set(`${AGENT_PREFIX}${agentId}:state`, JSON.stringify(merged), 'EX', AGENT_TTL);
  }

  async getAllAgentStates(): Promise<Record<string, AgentState>> {
    if (!isRedisConnected()) {
      this.warnLocalFallback('getAllAgentStates');
      return { ...this.localStates };
    }
    const redis = await getRedis();
    const keys = await redis.keys(`${AGENT_PREFIX}*:state`);
    const result: Record<string, AgentState> = { ...this.localStates };
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        const state = JSON.parse(raw) as AgentState;
        result[state.id] = state;
        this.localStates[state.id] = state;
      }
    }
    return result;
  }

  // ─── Heartbeat ────────────────────────────────────
  async heartbeat(agentId: string): Promise<void> {
    const now = Date.now();
    this.localHeartbeats[agentId] = now;
    if (!isRedisConnected()) {
      this.warnLocalFallback('heartbeat');
      return;
    }
    const redis = await getRedis();
    await redis.set(`${AGENT_PREFIX}${agentId}:heartbeat`, String(now), 'EX', 120);
    // heartbeat 시 state TTL도 갱신 (소실 방지)
    const stateKey = `${AGENT_PREFIX}${agentId}:state`;
    const ttl = await redis.ttl(stateKey);
    if (ttl > 0 && ttl < AGENT_TTL / 2) {
      await redis.expire(stateKey, AGENT_TTL);
    }
  }

  async isAgentAlive(agentId: string): Promise<boolean> {
    const localAlive = !!this.localHeartbeats[agentId] && (Date.now() - this.localHeartbeats[agentId]) < 60000;
    if (!isRedisConnected()) {
      this.warnLocalFallback('isAgentAlive');
      return localAlive;
    }
    const redis = await getRedis();
    return (await redis.exists(`${AGENT_PREFIX}${agentId}:heartbeat`)) === 1 || localAlive;
  }

  // ─── File Locks ───────────────────────────────────
  /**
   * Acquire a distributed file-edit lock for the given path.
   *
   * Call this immediately before starting a file edit, and call `releaseLock()`
   * after the edit has completed so other agents can safely proceed.
   *
   * The lock uses a TTL to prevent stale locks from remaining forever if the
   * editor crashes or never releases it. `ttlMs` is the lock lifetime in
   * milliseconds and defaults to 300,000 ms (5 minutes).
   *
   * Example:
   * ```ts
   * const locked = await sharedState.acquireLock(filePath, agentId);
   * if (!locked) return;
   * try {
   *   // edit file here
   * } finally {
   *   await sharedState.releaseLock(filePath, agentId);
   * }
   * ```
   */
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
    const released = await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      key,
      agentId,
    );
    return released === 1;
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
