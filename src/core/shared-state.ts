import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import {
  OptimisticUpdateConflictError,
  updateJsonWithWatch,
} from '../storage/optimistic-json.js';

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
    const localMerged: AgentState = {
      ...this.createDefaultState(agentId),
      ...this.localStates[agentId],
      ...state,
    };
    this.localStates[agentId] = localMerged;

    if (!isRedisConnected()) {
      this.warnLocalFallback('setAgentState');
      return;
    }

    const redis = await getRedis();
    try {
      const merged = await updateJsonWithWatch<AgentState>(
        redis,
        `${AGENT_PREFIX}${agentId}:state`,
        current => ({ ...this.createDefaultState(agentId), ...localMerged, ...current, ...state }),
        { ttlSeconds: AGENT_TTL, operation: 'setAgentState' },
      );
      if (merged) this.localStates[agentId] = merged;
    } catch (error) {
      if (!(error instanceof OptimisticUpdateConflictError)) throw error;
      log.warn(
        { agentId, operation: error.operation, attempts: error.attempts },
        'Agent state update conflicted; keeping local state',
      );
    }
  }

  async getAllAgentStates(): Promise<Record<string, AgentState>> {
    if (!isRedisConnected()) {
      this.warnLocalFallback('getAllAgentStates');
      return { ...this.localStates };
    }
    const redis = await getRedis();
    const keys = await redis.keys(`${AGENT_PREFIX}*:state`);
    const result: Record<string, AgentState> = { ...this.localStates };
    if (keys.length === 0) return result;

    // 2026-07-31: 키마다 순차 `await get` 하던 N+1 을 MGET 1회로 합쳤다.
    // /health 가 이 함수를 호출하므로 왕복 수가 그대로 응답시간이 된다.
    // Redis 가 흔들릴 때 각 왕복이 retryStrategy(times*200ms, 최대 10s)로 재시도돼
    // 왕복 수만큼 지연이 곱해졌다 — 실측 /health 7.78초(재시도 8회 누적 7.20초 + 처리)가
    // 회차마다 ±0.06초로 거의 상수였던 것이 그 지문이다. 왕복을 N+2 → 3 으로 줄인다.
    const raws = await redis.mget(...keys);
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const state = JSON.parse(raw) as AgentState;
        result[state.id] = state;
        this.localStates[state.id] = state;
      } catch {
        // 손상된 항목 하나가 전체 조회를 실패시키지 않게 한다(기존 동작도 개별 파싱이었다).
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
    await this.reconcileProviders(loadEnabledProviders());
  }

  /** Persist one committed provider roster without re-reading mutable config. */
  async reconcileProviders(providers: readonly ProviderConfig[]): Promise<void> {
    const db = getDb();
    const enabledProviders = providers.filter(provider => provider.enabled !== false);
    const previousIds = new Set(
      (db.prepare('SELECT id FROM agents WHERE enabled=1').all() as Array<{ id: string }>)
        .map(row => row.id),
    );

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

    const seedTx = db.transaction((provs: readonly ProviderConfig[]) => {
      for (const p of provs) {
        upsert.run(
          p.id, p.name, p.type, p.role, p.score, p.model, p.command,
          JSON.stringify(p.args), p.endpoint || null, p.apiKeyRef || null,
          JSON.stringify(p.capabilities), JSON.stringify(p.permissions),
          JSON.stringify(p.persona), p.concurrency, p.rateLimitRpm, p.cost
        );
      }
      // [비활성 전파 2026-07-26] config에서 disabled/제거된 프로바이더가 DB에
      // enabled=1로 잔존 → sync-engine(`WHERE enabled=1`)이 유령 에이전트를
      // Redis로 계속 동기화(감사에서 aider/gemini/openclaw 등 4건 확인). config를
      // 단일 진실원으로: 시드 목록에 없는 행은 enabled=0으로 내린다(행 삭제는
      // FK/이력 보존 위해 하지 않음).
      const ids = provs.map(p => p.id);
      if (ids.length === 0) {
        db.prepare(
          "UPDATE agents SET enabled=0, updated_at=datetime('now') WHERE enabled=1",
        ).run();
      } else {
        const ph = ids.map(() => '?').join(',');
        db.prepare(
          `UPDATE agents SET enabled=0, updated_at=datetime('now')
           WHERE enabled=1 AND id NOT IN (${ph})`,
        ).run(...ids);
      }
    });

    seedTx(enabledProviders);
    log.info({ count: enabledProviders.length }, 'Provider roster reconciled to DB');

    // Preserve live task state. Only newly admitted providers receive an idle
    // record; removed idle providers become offline while active work drains.
    for (const p of enabledProviders) {
      if (previousIds.has(p.id) && await this.getAgentState(p.id)) continue;
      await this.setAgentState(p.id, { id: p.id, status: 'idle' });
    }
    const currentIds = new Set(enabledProviders.map(provider => provider.id));
    for (const removedId of previousIds) {
      if (currentIds.has(removedId)) continue;
      const state = await this.getAgentState(removedId);
      if (state?.status === 'working' || state?.status === 'thinking') continue;
      await this.setAgentState(removedId, {
        status: 'offline',
        currentTask: null,
      });
    }
  }
}

export const sharedState = new SharedState();
