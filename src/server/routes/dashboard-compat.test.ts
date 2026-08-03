import { beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import Database from 'better-sqlite3';

// Mock setInterval to prevent background timer from hanging the test process
vi.spyOn(global, 'setInterval').mockImplementation(() => {
  return {} as any;
});

const { dbAll, dbGet, dbPrepare, getDb, readdirSync, readFileSync, statSync, execFileAsyncMock, listProviders, listEnabledIds, getP95Latency, getAvailability, getAllAgentStates } = vi.hoisted(() => {
  const dbAll = vi.fn<() => any[]>(() => []);
  const dbGet = vi.fn(() => ({ c: 0 }));
  const dbPrepare = vi.fn((_sql: string) => ({
    all: dbAll,
    get: dbGet,
    run: vi.fn(),
  }));

  const readdirSync = vi.fn((_path?: string): string[] => []);
  // config.ts loads config/*.json through the fs mock at import time (transitive
  // via logger/redis) — serve minimal valid JSON for those paths, plain text otherwise.
  const readFileSync = vi.fn((path?: unknown): string => {
    const p = String(path);
    if (p.endsWith('topology.json')) {
      return JSON.stringify({
        ports: { apiGateway: 6200, websocket: 6201, dashboard: 3000, redis: 6379, ollama: 11434 },
        paths: { backend: '.', dashboard: '.', database: 'db/nco.db', stateFile: 'state.json', workspace: '.' },
      });
    }
    if (p.endsWith('.json')) return '{"version":1,"updated":"","providers":[]}';
    return 'dummy content';
  });
  const statSync = vi.fn(() => ({
    mtime: new Date(),
    size: 100,
  }));

  return {
    dbAll,
    dbGet,
    dbPrepare,
    getDb: vi.fn(() => ({
      prepare: dbPrepare,
    })),
    readdirSync,
    readFileSync,
    statSync,
    execFileAsyncMock: vi.fn(async () => {
      return { stdout: 'ok', stderr: '' };
    }),
    listProviders: vi.fn(() => [{ id: 'codex', name: 'Codex', role: 'Engineer', enabled: true }]),
    listEnabledIds: vi.fn(() => ['codex']),
    getP95Latency: vi.fn(() => 100),
    getAllAgentStates: vi.fn(async () => ({})),
    getAvailability: vi.fn(() => ({
      status: 'gated:rate-limit',
      reason: 'rate-limit',
      available: false,
      cooldownUntil: '2026-07-03T00:00:00.000Z',
      circuitState: 'open',
    })),
  };
});

vi.mock('../../storage/database.js', () => ({
  getDb,
}));

// Mock sharedState
vi.mock('../../core/shared-state.js', () => ({
  sharedState: {
    getAllAgentStates,
    setAgentState: vi.fn(),
  },
}));

// Mock agentManager
vi.mock('../../agent/agent-manager.js', () => ({
  agentManager: {
    listProviders,
    listEnabledIds,
    getP95Latency,
  },
}));

vi.mock('../../security/circuit-breaker-registry.js', () => ({
  circuitBreakerRegistry: {
    getSnapshot: vi.fn(() => ({
      state: 'open',
      failureCount: 2,
      openedAt: Date.now(),
      cooldownUntil: Date.now() + 60_000,
      reason: 'rate-limit',
    })),
    getAvailability,
  },
}));

// dashboard-compat imports getRedis (fleet cooldown persistence). Without this
// mock the real module loads config.ts, whose loadJSON hits the fs mock's
// 'dummy content' and fails JSON.parse at import time.
vi.mock('../../storage/redis.js', () => ({
  getRedis: vi.fn(() => null),
}));

vi.mock('node:fs', () => ({
  readdirSync,
  readFileSync,
  statSync,
  existsSync: vi.fn(() => true),
}));

vi.mock('fs', () => ({
  readdirSync,
  readFileSync,
  statSync,
  existsSync: vi.fn(() => true),
}));

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    promisify: (fn: any) => {
      if (fn.name === 'execFile') {
        return execFileAsyncMock;
      }
      return original.promisify(fn);
    },
  };
});

import { registerDashboardRoutes } from './dashboard-compat.js';

describe('dashboard-compat routes', () => {
  let app: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbAll.mockReturnValue([]);
    dbGet.mockReturnValue({ c: 0 });
    dbPrepare.mockImplementation((_sql: string) => ({
      all: dbAll,
      get: dbGet,
      run: vi.fn(),
    }));
    listProviders.mockReturnValue([{ id: 'codex', name: 'Codex', role: 'Engineer', enabled: true }]);
    listEnabledIds.mockReturnValue(['codex']);
    getAllAgentStates.mockResolvedValue({});
    app = fastify({ logger: false });
    await registerDashboardRoutes(app);
  });

  describe('GET /api/notes', () => {
    it('returns context notes, improvement notes, and context history', async () => {
      readdirSync.mockImplementation((path: any) => {
        if (path.includes('improvements')) {
          return ['imp1.md'];
        }
        if (path.includes('context_history')) {
          return ['hist1.md'];
        }
        return [];
      });

      readFileSync.mockImplementation((path: any) => {
        if (path.includes('context_note.md')) {
          return '# Context Note';
        }
        if (path.includes('improvements')) {
          return 'Before → After\n| before | after |\n###\n권장 개선사항\n1. Improve logging\n점수: 90';
        }
        if (path.includes('context_history')) {
          return '## Session Title\nContent';
        }
        return '';
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notes',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.contextNote.exists).toBe(true);
      expect(data.contextNote.content).toBe('# Context Note');
      expect(data.improvementNotes).toHaveLength(1);
      expect(data.improvementNotes[0].score).toBe('90');
      expect(data.contextHistory).toHaveLength(1);
      expect(data.contextHistory[0].title).toBe('Session Title');
    });
  });

  describe('GET /api/tasks/heatmap', () => {
    it('queries DB for hourly failures per agent in last 24h', async () => {
      dbAll.mockReturnValue([
        { assigned_to: 'aider', hour: 10, cnt: 2 },
        { assigned_to: 'aider', hour: 11, cnt: 1 },
      ] as any);

      const response = await app.inject({
        method: 'GET',
        url: '/api/tasks/heatmap',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('aider');
      expect(data.agents[0].hours[10]).toBe(2);
      expect(data.agents[0].hours[11]).toBe(1);
      expect(data.agents[0].total).toBe(3);
    });
  });

  describe('GET /api/agents', () => {
    it('includes gate details without removing existing health fields', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].health.circuitState).toBe('open');
      expect(data.agents[0].gate).toEqual({
        status: 'gated:rate-limit',
        reason: 'rate-limit',
        available: false,
        cooldownUntil: '2026-07-03T00:00:00.000Z',
      });
      expect(data.agents[0].limit).toMatchObject({
        status: 'inconsistent',
        limited: null,
        availableForNewWork: false,
      });
      expect(data.agents[0].guidance).toContain('만료 시각과 모순');
      expect(data.meta.workFreshnessMs).toBe(180000);
    });

    it('does not trust stale shared working state as active execution', async () => {
      getAllAgentStates.mockResolvedValueOnce({
        codex: { status: 'working', currentTask: 'task-stale' },
      } as any);

      const response = await app.inject({ method: 'GET', url: '/api/agents' });
      const [codex] = JSON.parse(response.payload).agents;

      expect(codex.work).toMatchObject({
        status: 'unknown',
        active: null,
        freshness: 'stale',
        evidence: 'stale-working-signal',
      });
      expect(codex.currentTask).toBeNull();
    });

    it('reports only lease-backed fresh execution as working', async () => {
      dbPrepare.mockImplementation((sql: string) => ({
        all: vi.fn(() => sql.includes('WITH ranked_live AS')
          ? [{
              assigned_to: 'codex',
              id: 'task-live',
              prompt: 'verified live work',
              status: 'running',
              created_at: '2026-08-03T02:59:00.000Z',
            }]
          : []),
        get: dbGet,
        run: vi.fn(),
      }));

      const response = await app.inject({ method: 'GET', url: '/api/agents' });
      const [codex] = JSON.parse(response.payload).agents;

      expect(codex.status).toBe('working');
      expect(codex.currentTask).toBe('verified live work');
      expect(codex.work).toMatchObject({
        status: 'working',
        active: true,
        evidence: 'lease-backed-task',
        taskId: 'task-live',
      });
      expect(codex.guidance).toContain('기존 작업은 진행 중');
    });

    it('filters assigned, reviewing, expired-lease, and stale running rows in SQLite', async () => {
      await app.inject({ method: 'GET', url: '/api/agents' });
      const liveSql = dbPrepare.mock.calls
        .map(([sql]) => String(sql))
        .find(sql => sql.includes('WITH ranked_live AS'))!;
      const sqlite = new Database(':memory:');
      try {
        sqlite.exec(`
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            assigned_to TEXT,
            prompt TEXT,
            status TEXT,
            last_activity_at TEXT,
            last_heartbeat_at TEXT,
            updated_at TEXT,
            created_at TEXT,
            lease_expires_at TEXT
          );
          INSERT INTO tasks VALUES
            ('assigned', 'codex', 'queued only', 'assigned', datetime('now'), datetime('now'), datetime('now'), datetime('now'), datetime('now', '+90 seconds')),
            ('reviewing', 'codex', 'quality stage', 'reviewing', datetime('now'), datetime('now'), datetime('now'), datetime('now'), datetime('now', '+90 seconds')),
            ('expired', 'codex', 'expired lease', 'running', datetime('now'), datetime('now'), datetime('now'), datetime('now'), datetime('now', '-1 second')),
            ('stale', 'codex', 'stale heartbeat', 'running', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'), datetime('now', '-10 minutes'), datetime('now', '-10 minutes'), datetime('now', '+90 seconds')),
            ('live', 'ollama', 'live runtime', 'running', datetime('now'), datetime('now'), datetime('now'), datetime('now'), datetime('now', '+90 seconds'));
        `);

        const rows = sqlite.prepare(liveSql).all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          assigned_to: 'ollama',
          id: 'live',
          prompt: 'live runtime',
          status: 'running',
        });
      } finally {
        sqlite.close();
      }
    });
  });

  describe('GET /api/rate-limits/state', () => {
    it('marks expired raw rows stale without reporting a current limit', async () => {
      dbPrepare.mockImplementation((sql: string) => ({
        all: vi.fn(() => {
          if (sql === 'SELECT * FROM rate_limit_state') {
            return [{
              agent_id: 'codex',
              is_limited: 1,
              reason: 'quota',
              reset_at: '2026-07-01 00:00:00',
              updated_at: '2026-07-01 00:00:00',
            }];
          }
          return [];
        }),
        get: dbGet,
        run: vi.fn(),
      }));
      getAvailability.mockReturnValueOnce({
        agentId: 'codex',
        status: 'available',
        reason: null,
        available: true,
        cooldownUntil: null,
        circuitState: 'closed',
      } as any);

      const response = await app.inject({ method: 'GET', url: '/api/rate-limits/state' });
      const state = JSON.parse(response.payload).state;

      expect(state.providers.codex).toMatchObject({ currentlyLimited: false, stale: true });
      expect(state.limitedProviders).toEqual([]);
      expect(state.availableProviders).toEqual(['codex']);
      expect(state.providerStatus.codex).toMatchObject({
        status: 'available',
        limited: false,
        staleRecord: true,
      });
    });
  });

  // app.all('/api/*') 의 fallback 이 예전에 reply.code(200) 을 썼다. 그래서 오타나
  // 단수/복수 실수가 전부 "성공"으로 보였다. 실제로 태스크 취소에 단수형
  // /api/task/:id/cancel 을 호출하고 200 을 받아 취소된 줄 알았던 사고가 있었다
  // (실구현은 복수형 /api/tasks/:id/cancel). 우리는 HTTP 응답을 증거로 쓰므로
  // 200 + 빈 데이터는 기계가 만들어내는 거짓 성공이다.
  describe('unmatched /api/* routes', () => {
    it('answers 404 instead of a 200 that looks like success', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/definitely-not-a-real-route-zzz',
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data.ok).toBe(false);
      expect(data.error).toBe('route_not_found');
      // 예전 본문이 남아 있으면 호출자가 여전히 성공으로 읽는다.
      expect(response.payload).not.toContain('pending implementation');
    });

    it('does not swallow a singular/plural typo as success', async () => {
      // 실구현은 POST /api/tasks/:id/cancel (복수형)이다.
      const response = await app.inject({
        method: 'POST',
        url: '/api/task/some-id/cancel',
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).ok).toBe(false);
    });
  });
});
