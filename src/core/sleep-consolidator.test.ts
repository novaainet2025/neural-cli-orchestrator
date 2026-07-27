import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const insertedLogs: Array<{ level: string; message: string; status: string; contextJson?: string }> = [];
  const upsertDistilledLesson = vi.fn(async (_lesson: {
    projectPath: string;
    category: string;
    content: string;
    sourceTaskId?: string;
    confidence: number;
  }) => ({ action: 'inserted' as const }));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  let activeTaskCount = 0;
  let completedTasks: Array<Record<string, unknown>> = [{
    id: 'task-1',
    prompt: 'Investigate API retry flow',
    response: 'fix: guard null response before retry',
    completed_at: '2026-07-03T01:00:00.000Z',
    workspace_id: '/repo',
  }];
  let warnErrorLogs: Array<Record<string, unknown>> = [{
    id: 'log-1',
    timestamp: '2026-07-03T01:30:00.000Z',
    level: 'error',
    message: 'rate limit exceeded in provider call',
    context_json: '{"taskId":"task-1"}',
  }];

  const db = {
    prepare(sql: string) {
      if (sql.includes("WHERE status IN ('running', 'streaming', 'reviewing')")) {
        return { get: () => ({ n: activeTaskCount }) };
      }
      if (sql.includes("WHERE category = 'sleep-consolidator'")) {
        return { get: () => undefined };
      }
      if (sql.includes('FROM tasks') && sql.includes("status = 'completed'")) {
        return {
          all: () => completedTasks,
        };
      }
      if (sql.includes('FROM logs') && sql.includes("level IN ('warn', 'error', 'fatal')")) {
        return {
          all: () => warnErrorLogs,
        };
      }
      if (sql.includes('FROM mesh_messages')) {
        return { all: () => [] };
      }
      if (sql.includes('INSERT INTO logs')) {
        return {
          run: (_id: string, level: string, message: string, contextJson: string, status: string) => {
            insertedLogs.push({ level, message, status, contextJson });
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
    logger,
    get activeTaskCount() {
      return activeTaskCount;
    },
    set activeTaskCount(n: number) {
      activeTaskCount = n;
    },
    setCompletedTasks(rows: Array<Record<string, unknown>>) {
      completedTasks = rows;
    },
    setWarnErrorLogs(rows: Array<Record<string, unknown>>) {
      warnErrorLogs = rows;
    },
    resetFixtures() {
      activeTaskCount = 0;
      completedTasks = [{
        id: 'task-1',
        prompt: 'Investigate API retry flow',
        response: 'fix: guard null response before retry',
        completed_at: '2026-07-03T01:00:00.000Z',
        workspace_id: '/repo',
      }];
      warnErrorLogs = [{
        id: 'log-1',
        timestamp: '2026-07-03T01:30:00.000Z',
        level: 'error',
        message: 'rate limit exceeded in provider call',
        context_json: '{"taskId":"task-1"}',
      }];
    },
  };
});

vi.mock('../storage/database.js', () => ({
  getDb: () => state.db,
}));

vi.mock('../utils/id.js', () => ({
  createId: (prefix?: string) => `${prefix ?? 'id'}_stub`,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => state.logger,
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
  stat: vi.fn(async () => ({ mtimeMs: Date.now() - 60 * 60 * 1000 })),
}));

const openaiCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: openaiCreate,
      },
    };
  },
}));

import {
  boundSelfImprovementPrompt,
  MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN,
  MAX_SELF_IMPROVEMENT_PROMPT_CHARS,
  selectTopLessonsForSave,
  sleepConsolidator,
  type DistilledLesson,
} from './sleep-consolidator.js';

describe('boundSelfImprovementPrompt', () => {
  it('returns original prompt when under cap', () => {
    const result = boundSelfImprovementPrompt('hello world', 100);
    expect(result.truncated).toBe(false);
    expect(result.originalChars).toBe(11);
    expect(result.promptChars).toBe(11);
    expect(result.prompt).toBe('hello world');
    expect(result.prompt.length).toBeLessThanOrEqual(100);
  });

  it('truncates oversized prompt to <= maxChars and reports sizes', () => {
    const original = 'x'.repeat(MAX_SELF_IMPROVEMENT_PROMPT_CHARS + 50_000);
    const result = boundSelfImprovementPrompt(original);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(original.length);
    expect(result.promptChars).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_PROMPT_CHARS);
    expect(result.prompt.length).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_PROMPT_CHARS);
    expect(result.promptChars).toBe(result.prompt.length);
    expect(result.maxPromptChars).toBe(MAX_SELF_IMPROVEMENT_PROMPT_CHARS);
    expect(result.prompt).toContain('[prompt truncated]');
  });
});

describe('selectTopLessonsForSave', () => {
  it('caps to MAX and prefers higher confidence first', () => {
    const lessons: DistilledLesson[] = Array.from({ length: 250 }, (_, i) => ({
      category: 'bug_pattern' as const,
      content: `lesson-${i}`,
      projectPath: '/repo',
      confidence: i < 50 ? 0.95 : 0.7,
      sourceTaskId: `t-${i}`,
    }));
    const result = selectTopLessonsForSave(lessons);
    expect(result.kept).toBe(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(result.truncated).toBe(50);
    expect(result.lessons).toHaveLength(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(result.lessons.slice(0, 50).every((l) => l.confidence === 0.95)).toBe(true);
    expect(result.lessons.slice(50).every((l) => l.confidence === 0.7)).toBe(true);
  });

  it('is deterministic for equal confidence ties', () => {
    const lessons: DistilledLesson[] = [
      { category: 'convention', content: 'b-item', projectPath: '/repo', confidence: 0.8 },
      { category: 'architecture', content: 'a-item', projectPath: '/repo', confidence: 0.8 },
      { category: 'bug_pattern', content: 'c-item', projectPath: '/repo', confidence: 0.8 },
      { category: 'decision', content: 'd-item', projectPath: '/repo', confidence: 0.8 },
    ];
    const a = selectTopLessonsForSave(lessons, 2);
    const b = selectTopLessonsForSave([...lessons].reverse(), 2);
    expect(a.lessons.map((l) => l.content)).toEqual(b.lessons.map((l) => l.content));
    expect(a.lessons.map((l) => `${l.category}:${l.content}`)).toEqual([
      'architecture:a-item',
      'bug_pattern:c-item',
    ]);
  });
});

describe('sleepConsolidator self improvement', () => {
  let originalFetch: typeof global.fetch;
  let originalOpenRouterKey: string | undefined;
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    state.insertedLogs.length = 0;
    state.resetFixtures();
    openaiCreate.mockReset();
    originalFetch = global.fetch;
    originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    global.fetch = async () => {
      return new Response(null, { status: 500 });
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  it('reviews tasks, notes, and logs then saves distilled lessons (small-input regression)', async () => {
    const report = await sleepConsolidator.consolidateSelfImprovements();

    expect(report.tasksReviewed).toBe(1);
    expect(report.notesReviewed).toBe(1);
    expect(report.logsReviewed).toBe(1);
    expect(report.lessonsDistilled).toBeGreaterThanOrEqual(3);
    expect(report.lessonsDistilled).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(report.lessonsSaved).toBe(report.lessonsDistilled);
    expect(state.upsertDistilledLesson).toHaveBeenCalled();
    expect(state.upsertDistilledLesson.mock.calls.length).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(state.insertedLogs.at(-1)).toMatchObject({
      level: 'info',
      message: 'Self-improvement consolidation complete',
    });
  });

  it('caps fallback lessons per run on large inputs and logs truncated count', async () => {
    state.setWarnErrorLogs(
      Array.from({ length: 400 }, (_, i) => ({
        id: `log-${i}`,
        timestamp: `2026-07-03T01:${String(i % 60).padStart(2, '0')}:00.000Z`,
        level: i % 2 === 0 ? 'error' : 'warn',
        message: `unique failure pattern ${i}: timeout on provider call`,
        context_json: `{"taskId":"task-${i}"}`,
      })),
    );

    const report = await sleepConsolidator.consolidateSelfImprovements();

    expect(report.logsReviewed).toBe(400);
    expect(report.lessonsDistilled).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(report.lessonsSaved).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
    expect(state.upsertDistilledLesson.mock.calls.length).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);

    const capLog = state.logger.info.mock.calls.find(
      (call) => call[1] === 'Self-improvement lessons capped after dedupe',
    );
    expect(capLog).toBeTruthy();
    expect(capLog?.[0]).toMatchObject({
      kept: MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN,
      truncated: expect.any(Number),
      maxLessonsPerRun: MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN,
    });
    expect((capLog?.[0] as { truncated: number }).truncated).toBeGreaterThan(0);
    expect((capLog?.[0] as { originalCount: number }).originalCount).toBeGreaterThan(
      MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN,
    );

    // Higher-confidence error logs (0.74) should outrank warn (0.7) within the capped set.
    const confidences = state.upsertDistilledLesson.mock.calls.map(
      (call) => call[0].confidence,
    );
    expect(confidences.every((c) => c >= 0.7)).toBe(true);
    expect(Math.min(...confidences)).toBeGreaterThanOrEqual(0.74);
  });

  it('bounds LLM user prompt to cap and logs size metadata without prompt body', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret';
    let capturedUserPrompt = '';
    openaiCreate.mockImplementation(async (args: { messages: Array<{ role: string; content: string }> }) => {
      capturedUserPrompt = args.messages.find((m) => m.role === 'user')?.content ?? '';
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              lessons: [{
                category: 'bug_pattern',
                content: 'bound prompt path lesson',
                projectPath: '/repo',
                sourceTaskId: 'task-1',
                confidence: 0.9,
              }],
            }),
          },
        }],
      };
    });

    state.setCompletedTasks(
      Array.from({ length: 50 }, (_, i) => ({
        id: `task-big-${i}`,
        prompt: 'P'.repeat(3500),
        response: 'fix: oversized response body '.repeat(200),
        completed_at: '2026-07-03T01:00:00.000Z',
        workspace_id: '/repo',
      })),
    );
    state.setWarnErrorLogs(
      Array.from({ length: 100 }, (_, i) => ({
        id: `log-big-${i}`,
        timestamp: '2026-07-03T01:30:00.000Z',
        level: 'error',
        message: 'M'.repeat(3000),
        context_json: '{"taskId":"task-1"}',
      })),
    );

    const report = await sleepConsolidator.consolidateSelfImprovements();

    expect(capturedUserPrompt.length).toBeGreaterThan(0);
    expect(capturedUserPrompt.length).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_PROMPT_CHARS);

    const sizeLog = state.logger.info.mock.calls.find(
      (call) => call[1] === 'Self-improvement LLM user prompt sized',
    );
    expect(sizeLog).toBeTruthy();
    expect(sizeLog?.[0]).toMatchObject({
      truncated: true,
      originalChars: expect.any(Number),
      promptChars: expect.any(Number),
      maxPromptChars: MAX_SELF_IMPROVEMENT_PROMPT_CHARS,
    });
    expect((sizeLog?.[0] as { originalChars: number }).originalChars).toBeGreaterThan(
      MAX_SELF_IMPROVEMENT_PROMPT_CHARS,
    );
    expect((sizeLog?.[0] as { promptChars: number }).promptChars).toBeLessThanOrEqual(
      MAX_SELF_IMPROVEMENT_PROMPT_CHARS,
    );
    // No prompt body / secret material in structured log fields.
    const loggedKeys = Object.keys(sizeLog?.[0] as Record<string, unknown>);
    expect(loggedKeys).not.toContain('prompt');
    expect(loggedKeys).not.toContain('content');
    expect(JSON.stringify(sizeLog?.[0])).not.toContain('test-key-not-a-secret');
    expect(JSON.stringify(sizeLog?.[0])).not.toMatch(/P{100,}/);

    expect(report.lessonsSaved).toBeGreaterThanOrEqual(1);
    expect(report.lessonsSaved).toBeLessThanOrEqual(MAX_SELF_IMPROVEMENT_LESSONS_PER_RUN);
  });

  it('preserves active-task gate skip', async () => {
    state.activeTaskCount = 2;
    const report = await sleepConsolidator.consolidateSelfImprovements();
    expect(report.lessonsSaved).toBe(0);
    expect(state.upsertDistilledLesson).not.toHaveBeenCalled();
    expect(state.insertedLogs.at(-1)).toMatchObject({
      message: 'Self-improvement skipped: active_tasks',
    });
  });
});
