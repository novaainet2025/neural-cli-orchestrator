import { beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

// Mock setInterval to prevent background timer from hanging the test process
vi.spyOn(global, 'setInterval').mockImplementation(() => {
  return {} as any;
});

const { dbAll, dbGet, dbPrepare, getDb, readdirSync, readFileSync, statSync, execFileAsyncMock, listProviders, getP95Latency, getAvailability } = vi.hoisted(() => {
  const dbAll = vi.fn(() => []);
  const dbGet = vi.fn(() => ({ c: 0 }));
  const dbPrepare = vi.fn(() => ({
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
      return { stdout: '[mlx-keepalive] 12:34:56', stderr: '' };
    }),
    listProviders: vi.fn(() => [{ id: 'codex', name: 'Codex', role: 'Engineer', enabled: true }]),
    getP95Latency: vi.fn(() => 100),
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
    getAllAgentStates: vi.fn(async () => ({})),
    setAgentState: vi.fn(),
  },
}));

// Mock agentManager
vi.mock('../../agent/agent-manager.js', () => ({
  agentManager: {
    listProviders,
    listEnabledIds: vi.fn(() => []),
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

  describe('GET /api/mlx/latency', () => {
    it('pings local and remote MLX and reads keepalive log', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async () => {
        return { ok: true } as any;
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/mlx/latency',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.local.online).toBe(true);
      expect(data.remote.online).toBe(true);
      expect(data.lastKeepaliveAt).toBe('12:34:56');

      global.fetch = originalFetch;
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
    });
  });
});
