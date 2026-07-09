import { beforeEach, describe, expect, it, vi } from 'vitest';

type TaskRow = {
  id: string;
  status: string;
  prompt: string;
  assigned_to?: string;
  response?: string;
  error?: string;
  verifier_json?: string | null;
  verifier_result_json?: string | null;
  metadata_json?: string | null;
};

type KanbanTaskRow = {
  id: string;
  plan_id: string;
  title: string;
  description: string;
  assigned_to?: string;
  column_status: string;
  order_index: number;
  task_id?: string;
};

function createMockDb(rows: { kanbanTasks: KanbanTaskRow[] }) {
  const state = {
    plans: new Map<string, { status: string }>(),
    kanbanTasks: new Map(rows.kanbanTasks.map((row) => [row.id, { ...row }])),
    tasks: new Map<string, TaskRow>(),
  };

  for (const task of rows.kanbanTasks) {
    state.plans.set(task.plan_id, { status: 'pending' });
  }

  return {
    state,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      return {
        all: (planId?: string) => {
          if (normalized.includes('SELECT * FROM kanban_tasks WHERE plan_id = ? AND column_status != \'done\'')) {
            return [...state.kanbanTasks.values()]
              .filter((task) => task.plan_id === planId && task.column_status !== 'done')
              .sort((a, b) => a.order_index - b.order_index);
          }
          if (normalized.includes('SELECT * FROM kanban_tasks WHERE plan_id = ? ORDER BY order_index')) {
            return [...state.kanbanTasks.values()]
              .filter((task) => task.plan_id === planId)
              .sort((a, b) => a.order_index - b.order_index);
          }
          if (normalized.includes('SELECT * FROM kanban_tasks ORDER BY order_index')) {
            return [...state.kanbanTasks.values()].sort((a, b) => a.order_index - b.order_index);
          }
          throw new Error(`Unsupported all SQL: ${normalized}`);
        },
        get: (value?: string) => {
          if (normalized.includes('SELECT COUNT(*) as cnt FROM kanban_tasks')) {
            return {
              cnt: [...state.kanbanTasks.values()].filter(
                (task) => task.plan_id === value && task.column_status !== 'done',
              ).length,
            };
          }
          if (normalized === 'SELECT verifier_result_json, error FROM tasks WHERE id=?') {
            const task = state.tasks.get(value ?? '');
            return task ? { verifier_result_json: task.verifier_result_json, error: task.error } : undefined;
          }
          if (normalized === 'SELECT metadata_json FROM tasks WHERE id=?') {
            const task = state.tasks.get(value ?? '');
            return task ? { metadata_json: task.metadata_json } : undefined;
          }
          if (normalized === 'SELECT status, response, error FROM tasks WHERE id=?') {
            const task = state.tasks.get(value ?? '');
            return task ? { status: task.status, response: task.response, error: task.error } : undefined;
          }
          if (normalized === 'SELECT * FROM kanban_tasks WHERE id = ?') {
            return state.kanbanTasks.get(value ?? '');
          }
          throw new Error(`Unsupported get SQL: ${normalized}`);
        },
        run: (...args: any[]) => {
          if (normalized.startsWith('UPDATE kanban_tasks SET column_status = ?')) {
            const [toColumn, taskId] = args;
            const task = state.kanbanTasks.get(taskId);
            if (!task) return { changes: 0 };
            task.column_status = toColumn;
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE plans SET status = \'active\'')) {
            const [planId] = args;
            state.plans.set(planId, { status: 'active' });
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE plans SET status = \'completed\'')) {
            const [planId] = args;
            state.plans.set(planId, { status: 'completed' });
            return { changes: 1 };
          }
          if (normalized.startsWith('INSERT INTO tasks (id, mode, prompt, assigned_to, status, verifier_json, last_activity_at)')) {
            const [id, prompt, assignedTo, verifierJson] = args;
            state.tasks.set(id, {
              id,
              status: 'running',
              prompt,
              assigned_to: assignedTo,
              verifier_json: verifierJson,
              response: '',
              error: '',
              verifier_result_json: null,
              metadata_json: null,
            });
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE kanban_tasks SET task_id = ?, updated_at = datetime(\'now\') WHERE id = ?')) {
            const [taskId, kanbanTaskId] = args;
            const task = state.kanbanTasks.get(kanbanTaskId);
            if (!task) return { changes: 0 };
            task.task_id = taskId;
            return { changes: 1 };
          }
          if (normalized === 'UPDATE tasks SET prompt=? WHERE id=?') {
            const [prompt, taskId] = args;
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };
            task.prompt = prompt;
            return { changes: 1 };
          }
          if (normalized === 'UPDATE tasks SET metadata_json=? WHERE id=?') {
            const [metadataJson, taskId] = args;
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };
            task.metadata_json = metadataJson;
            return { changes: 1 };
          }
          if (normalized.startsWith("UPDATE kanban_tasks SET column_status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND column_status NOT IN")) {
            const [kanbanTaskId] = args;
            const task = state.kanbanTasks.get(kanbanTaskId);
            if (!task) return { changes: 0 };
            if (task.column_status === 'in_progress' || task.column_status === 'done') return { changes: 0 };
            task.column_status = 'in_progress';
            return { changes: 1 };
          }
          throw new Error(`Unsupported run SQL: ${normalized}`);
        },
      };
    },
  };
}

const mocks = vi.hoisted(() => ({
  activeDb: null as ReturnType<typeof createMockDb> | null,
  executeTask: vi.fn(),
  listEnabledIds: vi.fn(() => ['codex']),
  publish: vi.fn(async () => undefined),
  createTaskId: vi.fn(),
  classifyResult: vi.fn((result: unknown) => result),
  applyVerifierGate: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock('../src/storage/database.js', () => ({
  getDb: () => {
    if (!mocks.activeDb) {
      throw new Error('Mock DB not initialized');
    }
    return mocks.activeDb;
  },
}));

vi.mock('../src/agent/agent-manager.js', () => ({
  agentManager: {
    executeTask: mocks.executeTask,
    listEnabledIds: mocks.listEnabledIds,
  },
}));

vi.mock('../src/core/event-bus.js', () => ({
  eventBus: {
    publish: mocks.publish,
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../src/utils/id.js', () => ({
  createTaskId: mocks.createTaskId,
}));

vi.mock('../src/core/task-queue.js', () => ({
  classifyResult: mocks.classifyResult,
  applyVerifierGate: mocks.applyVerifierGate,
}));

vi.mock('../src/core/task-state.js', () => ({
  transitionTask: mocks.transitionTask,
}));

// Dynamically import kanbanEngine after mocks are configured
const { kanbanEngine } = await import('../src/core/kanban-engine.js');

describe('KanbanEngine WS2 Unattended Loop rules (tests/kanban-ws2.test.ts)', () => {
  beforeEach(() => {
    mocks.activeDb = createMockDb({
      kanbanTasks: [
        {
          id: 'kb-1',
          plan_id: 'plan-1',
          title: 'Ship verifier-gated task',
          description: JSON.stringify({
            verifier: { type: 'run', command: 'npm test' },
            maxRetries: 3,
          }),
          assigned_to: 'codex',
          column_status: 'todo',
          order_index: 1,
        },
      ],
    });

    mocks.executeTask.mockReset();
    mocks.listEnabledIds.mockClear();
    mocks.publish.mockClear();
    mocks.createTaskId.mockReset();
    mocks.classifyResult.mockClear();
    mocks.applyVerifierGate.mockReset();
    mocks.transitionTask.mockReset();

    mocks.transitionTask.mockImplementation((db: ReturnType<typeof createMockDb>, taskId: string, status: string, update: Record<string, any>) => {
      const row = db.state.tasks.get(taskId);
      if (!row) {
        throw new Error(`Unknown task row: ${taskId}`);
      }
      row.status = status;
      row.response = update.response ?? row.response;
      row.error = update.error ?? row.error;
    });

    kanbanEngine.createRetryTaskRef = null;
  });

  it('Rule 1: Gate PASS advances to done / FAIL blocks advancement', async () => {
    // 1. Test when the verifier gate PASSES
    mocks.createTaskId.mockReturnValueOnce('task-initial-pass');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'agent output pass',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: true,
        outputSnippet: 'verifier passed successfully',
      });
      return { success: true, output: 'agent output pass', error: '' };
    });

    const passResult = await kanbanEngine.executePlan('plan-1', 'sequential');
    expect(passResult.results[0]).toMatchObject({ success: true, lastTaskId: 'task-initial-pass' });
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('done');

    // Reset column_status to test FAIL blocking advancement
    mocks.activeDb.state.kanbanTasks.get('kb-1')!.column_status = 'todo';
    mocks.createTaskId.mockReturnValueOnce('task-initial-fail');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'agent output fail',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: false,
        outputSnippet: 'verifier gate rejected',
      });
      return { success: false, output: 'agent output fail', error: 'verifier rejected' };
    });

    // Provide a retry ref that returns fail/exceed limit so it stops or throws error
    const retryRef = vi.fn(async () => {
      return { ok: false, body: { error: 'Retry rejected for test' } };
    });
    kanbanEngine.createRetryTaskRef = retryRef;

    const failResult = await kanbanEngine.executePlan('plan-1', 'sequential');
    expect(failResult.results[0]).toMatchObject({
      success: false,
      lastTaskId: 'task-initial-fail',
      error: 'Retry rejected for test',
    });
    // It should move to 'review' column on escalation
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('Rule 2: FAIL includes verifier output in the retry prompt', async () => {
    mocks.createTaskId.mockReturnValueOnce('task-initial');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'candidate output',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: false,
        outputSnippet: 'Expected value: 100\nReceived value: 50',
      });
      return { success: false, output: 'candidate output', error: 'verifier failed' };
    });

    let capturedRetryPrompt = '';
    kanbanEngine.createRetryTaskRef = vi.fn(async (taskId: string) => {
      capturedRetryPrompt = mocks.activeDb?.state.tasks.get(taskId)?.prompt ?? '';
      mocks.activeDb?.state.tasks.set('task-retry-1', {
        id: 'task-retry-1',
        status: 'completed',
        prompt: capturedRetryPrompt,
        response: 'fixed output',
        error: '',
      });
      return { ok: true, newTaskId: 'task-retry-1' };
    });

    await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(capturedRetryPrompt).toContain('[Previous Attempt 1/3 Failed]');
    expect(capturedRetryPrompt).toContain('Expected value: 100');
    expect(capturedRetryPrompt).toContain('Received value: 50');
  });

  it('Rule 3: Exceeding retry budget triggers human escalation (task:escalated)', async () => {
    mocks.createTaskId.mockReturnValueOnce('task-initial');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'candidate output',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: false,
        outputSnippet: 'initial verifier failure',
      });
      return { success: false, output: 'candidate output', error: 'verifier failed on initial attempt' };
    });

    let retryCount = 0;
    kanbanEngine.createRetryTaskRef = vi.fn(async (taskId: string) => {
      retryCount += 1;
      const prompt = mocks.activeDb?.state.tasks.get(taskId)?.prompt ?? '';
      const newTaskId = `task-retry-${retryCount}`;
      mocks.activeDb?.state.tasks.set(newTaskId, {
        id: newTaskId,
        status: 'failed',
        prompt,
        response: '',
        error: `verifier failed on retry ${retryCount}`,
        verifier_result_json: JSON.stringify({
          passed: false,
          outputSnippet: `retry ${retryCount} verifier failure`,
        }),
        metadata_json: null,
      });
      return { ok: true, newTaskId };
    });

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(retryCount).toBe(3);
    expect(result.results[0]).toMatchObject({ success: false, lastTaskId: 'task-retry-3' });
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
    expect(mocks.activeDb?.state.tasks.get('task-retry-3')?.metadata_json).toContain('"escalated_to_human":true');
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task:escalated',
      kanbanTaskId: 'kb-1',
      lastTaskId: 'task-retry-3',
    }));
  });

  it('Rule 4: Polling timeout triggers human escalation (task:escalated)', async () => {
    mocks.createTaskId.mockReturnValueOnce('task-initial');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'candidate output',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: false,
        outputSnippet: 'initial verifier failure',
      });
      return { success: false, output: 'candidate output', error: 'verifier failed' };
    });

    kanbanEngine.createRetryTaskRef = vi.fn(async (taskId: string) => {
      const prompt = mocks.activeDb?.state.tasks.get(taskId)?.prompt ?? '';
      const newTaskId = 'task-retry-hanging';
      mocks.activeDb?.state.tasks.set(newTaskId, {
        id: newTaskId,
        status: 'running',
        prompt,
        response: '',
        error: '',
        metadata_json: null,
      });
      return { ok: true, newTaskId };
    });

    vi.useFakeTimers();
    const planPromise = kanbanEngine.executePlan('plan-1', 'sequential');
    await vi.advanceTimersByTimeAsync(3000 * 100 + 1000);
    const result = await planPromise;
    vi.useRealTimers();

    expect(result.results[0]).toMatchObject({
      success: false,
      lastTaskId: 'task-retry-hanging',
      error: 'Polling timed out waiting for task completion',
    });
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
    expect(mocks.activeDb?.state.tasks.get('task-retry-hanging')?.metadata_json).toContain('"escalated_to_human":true');
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task:escalated',
      kanbanTaskId: 'kb-1',
      lastTaskId: 'task-retry-hanging',
    }));
  });
});
