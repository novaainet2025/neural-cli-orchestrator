import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const insertedLogs: Array<{ level: string; message: string; status: string }> = [];
  const upsertDistilledLesson = vi.fn(async () => ({ action: 'inserted' as const }));

  const db = {
    prepare(sql: string) {
      if (sql.includes("WHERE status IN ('running', 'streaming', 'reviewing')")) {
        return { get: () => ({ n: 0 }) };
      }
      if (sql.includes("WHERE category = 'sleep-consolidator'")) {
        return { get: () => undefined };
      }
      if (sql.includes('FROM tasks') && sql.includes("status = 'completed'")) {
        return {
          all: () => [{
            id: 'task-1',
            prompt: 'Investigate API retry flow',
            response: 'fix: guard null response before retry',
            completed_at: '2026-07-03T01:00:00.000Z',
            workspace_id: '/repo',
          }],
        };
      }
      if (sql.includes('FROM logs') && sql.includes("level IN ('warn', 'error', 'fatal')")) {
        return {
          all: () => [{
            id: 'log-1',
            timestamp: '2026-07-03T01:30:00.000Z',
            level: 'error',
            message: 'rate limit exceeded in provider call',
            context_json: '{"taskId":"task-1"}',
          }],
        };
      }
      if (sql.includes('FROM mesh_messages')) {
        return { all: () => [] };
      }
      if (sql.includes('INSERT INTO logs')) {
        return {
          run: (_id: string, level: string, message: string, _contextJson: string, status: string) => {
            insertedLogs.push({ level, message, status });
            return { changes: 1 };
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  return {
    db,
    insertedLogs,
    upsertDistilledLesson,
  };
});

vi.mock('../storage/database.js', () => ({
  getDb: () => state.db,
}));

vi.mock('../utils/id.js', () => ({
  createId: (prefix?: string) => `${prefix ?? 'id'}_stub`,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./knowledge-base.js', () => ({
  knowledgeBase: {
    isSelfImprovementAutoApplyEnabled: vi.fn(() => true),
    upsertDistilledLesson: state.upsertDistilledLesson,
  },
}));

vi.mock('./vector-memory.js', () => ({
  vectorMemory: {
    flushAll: vi.fn(async () => undefined),
  },
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/tester',
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => ['note.md']),
  readFile: vi.fn(async () => '권장 개선사항: verify cron outputs before claim'),
  stat: vi.fn(async () => ({ mtimeMs: Date.parse('2026-07-03T02:00:00.000Z') })),
}));

import { sleepConsolidator } from './sleep-consolidator.js';

describe('sleepConsolidator self improvement', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    state.insertedLogs.length = 0;
    originalFetch = global.fetch;
    global.fetch = async () => {
      return new Response(null, { status: 500 });
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reviews tasks, notes, and logs then saves distilled lessons', async () => {
    const report = await sleepConsolidator.consolidateSelfImprovements();
    console.log('CONSOLIDATION REPORT:', report);

    expect(report.tasksReviewed).toBe(1);
    expect(report.notesReviewed).toBe(1);
    expect(report.logsReviewed).toBe(1);
    expect(report.lessonsDistilled).toBeGreaterThanOrEqual(3);
    expect(report.lessonsSaved).toBe(report.lessonsDistilled);
    expect(state.upsertDistilledLesson).toHaveBeenCalled();
    expect(state.insertedLogs.at(-1)).toMatchObject({
      level: 'info',
      message: 'Self-improvement consolidation complete',
    });
  });
});
