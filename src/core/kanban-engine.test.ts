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
  depends_on_json?: string;
  task_id?: string;
  execution_type?: string;
};

function createMockDb(rows: { kanbanTasks: KanbanTaskRow[] }) {
  const state = {
    plans: new Map<string, { status: string }>(),
    kanbanTasks: new Map(rows.kanbanTasks.map((row) => [row.id, { ...row }])),
    tasks: new Map<string, TaskRow>(),
    onTaskPoll: undefined as ((taskId: string) => void) | undefined,
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
        get: (...values: string[]) => {
          const value = values[0];
          if (normalized.includes('COUNT(*) AS total') && normalized.includes('FROM kanban_tasks kt')) {
            const cards = [...state.kanbanTasks.values()].filter(task => task.plan_id === value);
            return {
              total: cards.length,
              incomplete: cards.filter((task) => {
                if (task.column_status !== 'done') return true;
                if (!task.task_id) return false;
                return state.tasks.get(task.task_id)?.status !== 'completed';
              }).length,
            };
          }
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
            state.onTaskPoll?.(value ?? '');
            const task = state.tasks.get(value ?? '');
            return task ? { status: task.status, response: task.response, error: task.error } : undefined;
          }
          if (normalized === 'SELECT * FROM kanban_tasks WHERE id = ?') {
            return state.kanbanTasks.get(value ?? '');
          }
          if (normalized === 'SELECT plan_id, task_id FROM kanban_tasks WHERE id=?') {
            const task = state.kanbanTasks.get(value ?? '');
            return task ? { plan_id: task.plan_id, task_id: task.task_id ?? null } : undefined;
          }
          if (normalized === 'SELECT status FROM tasks WHERE id=?') {
            const task = state.tasks.get(value ?? '');
            return task ? { status: task.status } : undefined;
          }
          if (normalized === 'SELECT assigned_to FROM tasks WHERE id=?') {
            const task = state.tasks.get(value ?? '');
            return task ? { assigned_to: task.assigned_to ?? null } : undefined;
          }
          if (normalized.includes('SELECT kt.column_status, kt.task_id, t.status AS task_status')) {
            const task = state.kanbanTasks.get(value ?? '');
            return task ? {
              column_status: task.column_status,
              task_id: task.task_id ?? null,
              task_status: task.task_id ? state.tasks.get(task.task_id)?.status ?? null : null,
            } : undefined;
          }
          throw new Error(`Unsupported get SQL: ${normalized}`);
        },
        run: (...args: any[]) => {
          if (normalized.startsWith("UPDATE kanban_tasks SET column_status=?, updated_at=datetime('now') WHERE id=? AND ( task_id=?")) {
            const [toColumn, kanbanTaskId, canonicalTaskId] = args;
            const task = state.kanbanTasks.get(kanbanTaskId);
            if (!task || (task.task_id ?? null) !== canonicalTaskId) return { changes: 0 };
            task.column_status = toColumn;
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE kanban_tasks SET column_status = ?')) {
            const [toColumn, taskId] = args;
            const task = state.kanbanTasks.get(taskId);
            if (!task) return { changes: 0 };
            task.column_status = toColumn;
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE plans SET status') && normalized.includes("status = 'active'")) {
            const [planId] = args;
            state.plans.set(planId, { status: 'active' });
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE plans SET status') && normalized.includes("status='active'")) {
            const [planId] = args;
            const plan = state.plans.get(planId);
            if (plan?.status !== 'completed') return { changes: 0 };
            state.plans.set(planId, { status: 'active' });
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE plans SET status') && (
            normalized.includes("status = 'completed'") || normalized.includes("status='completed'")
          )) {
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
          if (normalized.startsWith("UPDATE kanban_tasks SET task_id=?, updated_at=datetime('now') WHERE id=? AND ( task_id=?")) {
            const [newTaskId, kanbanTaskId, acceptedNewTaskId, expectedTaskId] = args;
            const task = state.kanbanTasks.get(kanbanTaskId);
            const currentTaskId = task?.task_id ?? null;
            if (!task || (currentTaskId !== acceptedNewTaskId && currentTaskId !== expectedTaskId)) {
              return { changes: 0 };
            }
            task.task_id = newTaskId;
            return { changes: 1 };
          }
          if (normalized === 'UPDATE tasks SET metadata_json=? WHERE id=?') {
            const [metadataJson, taskId] = args;
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };
            task.metadata_json = metadataJson;
            return { changes: 1 };
          }
          if (normalized.startsWith("UPDATE kanban_tasks SET column_status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND column_status = 'todo'")) {
            const [kanbanTaskId] = args;
            const task = state.kanbanTasks.get(kanbanTaskId);
            if (!task) return { changes: 0 };
            if (task.column_status !== 'todo') return { changes: 0 };
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
  selectProviders: vi.fn(async () => ['codex']),
  inferTaskType: vi.fn((prompt: string) => (
    /image|video|영상|이미지/i.test(prompt) ? 'media' : 'general'
  )),
  isTaskCompatibleProvider: vi.fn((agentId: string, taskType: string) => (
    taskType !== 'media' || agentId === 'agy'
  )),
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => {
    if (!mocks.activeDb) {
      throw new Error('Mock DB not initialized');
    }
    return mocks.activeDb;
  },
}));

vi.mock('../agent/agent-manager.js', () => ({
  agentManager: {
    executeTask: mocks.executeTask,
    listEnabledIds: mocks.listEnabledIds,
  },
}));

vi.mock('./event-bus.js', () => ({
  eventBus: {
    publish: mocks.publish,
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../utils/id.js', () => ({
  createTaskId: mocks.createTaskId,
}));

vi.mock('./task-queue.js', () => ({
  classifyResult: mocks.classifyResult,
  applyVerifierGate: mocks.applyVerifierGate,
}));

vi.mock('./task-state.js', () => ({
  transitionTask: mocks.transitionTask,
}));

vi.mock('./smart-router.js', () => ({
  isTaskCompatibleProvider: mocks.isTaskCompatibleProvider,
  smartRouter: {
    selectProviders: mocks.selectProviders,
    inferTaskType: mocks.inferTaskType,
  },
}));

const { kanbanEngine } = await import('./kanban-engine.js');

describe('KanbanEngine verifier gate', () => {
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
    mocks.listEnabledIds.mockReset();
    mocks.listEnabledIds.mockReturnValue(['codex']);
    mocks.publish.mockClear();
    mocks.createTaskId.mockReset();
    mocks.classifyResult.mockClear();
    mocks.applyVerifierGate.mockReset();
    mocks.transitionTask.mockReset();
    mocks.selectProviders.mockReset();
    mocks.selectProviders.mockResolvedValue(['codex']);
    mocks.inferTaskType.mockReset();
    mocks.inferTaskType.mockImplementation((prompt: string) => (
      /image|video|영상|이미지/i.test(prompt) ? 'media' : 'general'
    ));
    mocks.isTaskCompatibleProvider.mockClear();

    mocks.transitionTask.mockImplementation((db: ReturnType<typeof createMockDb>, taskId: string, status: string, update: Record<string, any>) => {
      const row = db.state.tasks.get(taskId);
      if (!row) {
        throw new Error(`Unknown task row: ${taskId}`);
      }
      row.status = status;
      row.response = update.response ?? row.response;
      row.error = update.error ?? row.error;
    });

    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      const taskId = mocks.createTaskId();
      mocks.activeDb?.state.tasks.set(taskId, {
        id: taskId,
        status: 'running',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: '',
        error: '',
        verifier_json: input.verifier ? JSON.stringify(input.verifier) : null,
        verifier_result_json: null,
        metadata_json: JSON.stringify(input.metadata ?? {}),
      });
      const executeResult = await mocks.executeTask(input.agentId, input.prompt, { taskId });
      const classified = mocks.classifyResult(executeResult);
      const gated = await mocks.applyVerifierGate({
        taskId,
        agentId: input.agentId,
        prompt: input.prompt,
        verifier: input.verifier,
      }, classified, new AbortController().signal);
      mocks.transitionTask(
        mocks.activeDb,
        taskId,
        gated.success ? 'completed' : 'failed',
        {
          response: gated.output || undefined,
          error: gated.error || undefined,
        },
      );
      return { ok: true, newTaskId: taskId };
    });
    kanbanEngine.createRetryTaskRef = null;
    kanbanEngine.replaceActiveTaskRef = null;
  });

  it('requires verifier PASS before advancing to done', async () => {
    mocks.createTaskId.mockReturnValueOnce('task-initial');
    mocks.executeTask.mockResolvedValueOnce({
      success: true,
      output: 'agent produced candidate output',
    });
    mocks.applyVerifierGate.mockImplementationOnce(async (task: { taskId: string }) => {
      const row = mocks.activeDb?.state.tasks.get(task.taskId);
      if (!row) throw new Error('missing task');
      row.verifier_result_json = JSON.stringify({
        passed: false,
        outputSnippet: 'missing regression coverage',
      });
      return { success: false, output: 'agent produced candidate output', error: 'verifier rejected' };
    });

    const retryRef = vi.fn(async (
      _taskId: string,
      options?: { overridePrompt?: string },
    ) => {
      mocks.activeDb?.state.tasks.set('task-retry-1', {
        id: 'task-retry-1',
        status: 'completed',
        prompt: options?.overridePrompt ?? '',
        response: 'verified output',
        error: '',
      });
      return { ok: true, newTaskId: 'task-retry-1' };
    });
    kanbanEngine.createRetryTaskRef = retryRef;

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({ success: true, lastTaskId: 'task-retry-1' });
    expect(retryRef).toHaveBeenCalledTimes(1);
    expect(mocks.activeDb?.state.tasks.get('task-initial')?.status).toBe('failed');
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('done');
  });

  it('injects verifier FAIL output into the retry prompt', async () => {
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
        outputSnippet: 'Expected: task:done\nReceived: task:review',
      });
      return { success: false, output: 'candidate output', error: 'verifier failed' };
    });

    let capturedRetryPrompt = '';
    kanbanEngine.createRetryTaskRef = vi.fn(async (
      _taskId: string,
      options?: { overridePrompt?: string },
    ) => {
      capturedRetryPrompt = options?.overridePrompt ?? '';
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
    expect(capturedRetryPrompt).toContain('Expected: task:done');
    expect(capturedRetryPrompt).toContain('Received: task:review');
    expect(mocks.activeDb?.state.tasks.get('task-initial')?.prompt)
      .toBe('Ship verifier-gated task');
  });

  it('rotates verifier retries to the least-attempted compatible provider', async () => {
    mocks.listEnabledIds.mockReturnValue(['codex', 'ollama']);
    mocks.selectProviders.mockResolvedValue(['codex', 'ollama']);
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-provider-initial', {
        id: 'task-provider-initial',
        status: 'failed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: '',
        error: 'verifier failed on codex',
        verifier_result_json: JSON.stringify({
          passed: false,
          outputSnippet: 'implementation did not satisfy the verifier',
        }),
      });
      return { ok: true, newTaskId: 'task-provider-initial' };
    });
    const retryRef = vi.fn(async (
      _sourceTaskId: string,
      options?: { overrideAi?: string; overridePrompt?: string },
    ) => {
      mocks.activeDb?.state.tasks.set('task-provider-retry', {
        id: 'task-provider-retry',
        status: 'completed',
        prompt: options?.overridePrompt ?? '',
        assigned_to: options?.overrideAi,
        response: 'alternate provider fixed the task',
        error: '',
      });
      return { ok: true, newTaskId: 'task-provider-retry' };
    });
    kanbanEngine.createRetryTaskRef = retryRef;

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      success: true,
      lastTaskId: 'task-provider-retry',
    });
    expect(retryRef).toHaveBeenCalledWith('task-provider-initial', expect.objectContaining({
      overrideAi: 'ollama',
    }));
  });

  it('does not rotate retry providers when failover is explicitly disabled', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.description = JSON.stringify({
      maxRetries: 1,
      metadata: { allowProviderFailover: false },
    });
    mocks.listEnabledIds.mockReturnValue(['codex', 'ollama']);
    mocks.selectProviders.mockResolvedValue(['codex', 'ollama']);
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-no-failover-initial', {
        id: 'task-no-failover-initial',
        status: 'failed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: '',
        error: 'verifier failed',
      });
      return { ok: true, newTaskId: 'task-no-failover-initial' };
    });
    const retryRef = vi.fn(async (
      _sourceTaskId: string,
      options?: { overrideAi?: string; overridePrompt?: string },
    ) => {
      mocks.activeDb?.state.tasks.set('task-no-failover-retry', {
        id: 'task-no-failover-retry',
        status: 'completed',
        prompt: options?.overridePrompt ?? '',
        assigned_to: 'codex',
        response: 'same provider completed retry',
        error: '',
      });
      return { ok: true, newTaskId: 'task-no-failover-retry' };
    });
    kanbanEngine.createRetryTaskRef = retryRef;

    await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(retryRef).toHaveBeenCalledWith('task-no-failover-initial', {
      overridePrompt: expect.any(String),
    });
  });

  it('publishes task:escalated after exceeding 3 retries', async () => {
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
    kanbanEngine.createRetryTaskRef = vi.fn(async (
      _taskId: string,
      options?: { overridePrompt?: string },
    ) => {
      retryCount += 1;
      const prompt = options?.overridePrompt ?? '';
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

  it('passes the initial execution contract through the gateway-owned dispatch hook', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.description = JSON.stringify({
      verifier: { type: 'run', command: 'npm test', timeoutMs: 45_000 },
      maxRetries: 1,
      timeoutMs: 240_000,
      model: 'kanban-model',
      systemPrompt: 'kanban system prompt',
      priority: 8,
      requiredEvidence: ['tests'],
      metadata: { projectDir: '/private/tmp/kanban' },
    });
    const createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-via-gateway', {
        id: 'task-via-gateway',
        status: 'completed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'gateway queued output',
        error: '',
      });
      return { ok: true, newTaskId: 'task-via-gateway' };
    });
    kanbanEngine.createTaskRef = createTaskRef;

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      success: true,
      lastTaskId: 'task-via-gateway',
    });
    expect(createTaskRef).toHaveBeenCalledWith({
      kanbanTaskId: 'kb-1',
      planId: 'plan-1',
      agentId: 'codex',
      prompt: 'Ship verifier-gated task',
      model: 'kanban-model',
      systemPrompt: 'kanban system prompt',
      timeoutMs: 240_000,
      priority: 8,
      verifier: { type: 'run', command: 'npm test', timeoutMs: 45_000 },
      requiredEvidence: ['tests'],
      metadata: { projectDir: '/private/tmp/kanban' },
    });
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.task_id)
      .toBe('task-via-gateway');
  });

  it('settles a reviewing task on the review column without consuming retry budget', async () => {
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-awaiting-audit', {
        id: 'task-awaiting-audit',
        status: 'reviewing',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'quality passed and organization audit is pending',
        error: '',
      });
      return { ok: true, newTaskId: 'task-awaiting-audit' };
    });
    kanbanEngine.createRetryTaskRef = vi.fn();

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      success: false,
      awaitingReview: true,
      status: 'reviewing',
      lastTaskId: 'task-awaiting-audit',
    });
    expect(kanbanEngine.createRetryTaskRef).not.toHaveBeenCalled();
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('does not recreate a canonical task after the user cancels it', async () => {
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-user-cancelled', {
        id: 'task-user-cancelled',
        status: 'cancelled',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: '',
        error: 'Cancelled by operator',
      });
      return { ok: true, newTaskId: 'task-user-cancelled' };
    });
    kanbanEngine.createRetryTaskRef = vi.fn();

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      taskId: 'kb-1',
      lastTaskId: 'task-user-cancelled',
      success: false,
      cancelled: true,
      status: 'cancelled',
      error: 'Cancelled by operator',
    });
    expect(kanbanEngine.createRetryTaskRef).not.toHaveBeenCalled();
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('does not claim a review card again when plan execution is repeated', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.column_status = 'review';

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result).toEqual({ executed: 0, results: [] });
    expect(kanbanEngine.createTaskRef).not.toHaveBeenCalled();
    expect(kanbanTask.column_status).toBe('review');
  });

  it('executes dependencies in waves even when order_index is not topological', async () => {
    const dependent = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!dependent || !mocks.activeDb) throw new Error('missing kanban task');
    dependent.depends_on_json = JSON.stringify(['kb-root']);
    dependent.order_index = 1;
    mocks.activeDb.state.kanbanTasks.set('kb-root', {
      id: 'kb-root',
      plan_id: 'plan-1',
      title: 'Prepare dependency first',
      description: '',
      assigned_to: 'codex',
      column_status: 'todo',
      order_index: 2,
      depends_on_json: '[]',
    });
    let sequence = 0;
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      const taskId = `dependency-task-${++sequence}`;
      mocks.activeDb?.state.tasks.set(taskId, {
        id: taskId,
        status: 'completed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'completed dependency wave',
        error: '',
        metadata_json: JSON.stringify(input.metadata ?? {}),
      });
      return { ok: true, newTaskId: taskId };
    });

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.executed).toBe(2);
    expect(vi.mocked(kanbanEngine.createTaskRef).mock.calls.map(([input]) => input.prompt))
      .toEqual(['Prepare dependency first', 'Ship verifier-gated task']);
    expect(mocks.activeDb.state.kanbanTasks.get('kb-root')?.column_status).toBe('done');
    expect(dependent.column_status).toBe('done');
  });

  it('dispatches every runnable task concurrently within parallel dependency waves', async () => {
    const childA = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!childA || !mocks.activeDb) throw new Error('missing kanban task');
    childA.title = 'Child A';
    childA.assigned_to = undefined;
    childA.order_index = 3;
    childA.depends_on_json = JSON.stringify(['kb-root-a']);
    mocks.activeDb.state.kanbanTasks.set('kb-root-a', {
      id: 'kb-root-a',
      plan_id: 'plan-1',
      title: 'Root A',
      description: '',
      assigned_to: undefined,
      column_status: 'todo',
      order_index: 1,
      depends_on_json: '[]',
    });
    mocks.activeDb.state.kanbanTasks.set('kb-root-b', {
      id: 'kb-root-b',
      plan_id: 'plan-1',
      title: 'Root B',
      description: '',
      assigned_to: undefined,
      column_status: 'todo',
      order_index: 2,
      depends_on_json: '[]',
    });
    mocks.activeDb.state.kanbanTasks.set('kb-child-b', {
      id: 'kb-child-b',
      plan_id: 'plan-1',
      title: 'Child B',
      description: '',
      assigned_to: undefined,
      column_status: 'todo',
      order_index: 4,
      depends_on_json: JSON.stringify(['kb-root-b']),
    });

    let sequence = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.listEnabledIds.mockReturnValue(['codex', 'ollama']);
    mocks.selectProviders.mockResolvedValue(['codex', 'ollama']);
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      const taskId = `parallel-task-${++sequence}`;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      mocks.activeDb?.state.tasks.set(taskId, {
        id: taskId,
        status: 'completed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'completed parallel wave',
        error: '',
      });
      inFlight--;
      return { ok: true, newTaskId: taskId };
    });

    const result = await kanbanEngine.executePlan('plan-1', 'parallel');

    expect(result.executed).toBe(4);
    expect(maxInFlight).toBe(2);
    expect(vi.mocked(kanbanEngine.createTaskRef).mock.calls.map(([input]) => input.prompt))
      .toEqual(['Root A', 'Root B', 'Child A', 'Child B']);
    expect(vi.mocked(kanbanEngine.createTaskRef).mock.calls.map(([input]) => input.agentId))
      .toEqual(['codex', 'ollama', 'codex', 'ollama']);
    expect([...mocks.activeDb.state.kanbanTasks.values()].every(task => task.column_status === 'done'))
      .toBe(true);
  });

  it('routes unassigned media work only to a compatible provider', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask || !mocks.activeDb) throw new Error('missing kanban task');
    kanbanTask.title = 'Create a product image';
    kanbanTask.assigned_to = undefined;
    mocks.listEnabledIds.mockReturnValue(['codex', 'agy']);
    mocks.selectProviders.mockResolvedValue(['agy']);
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-media', {
        id: 'task-media',
        status: 'completed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'image completed',
        error: '',
      });
      return { ok: true, newTaskId: 'task-media' };
    });

    const result = await kanbanEngine.executePlan('plan-1', 'parallel');

    expect(result.results[0]).toMatchObject({ success: true, lastTaskId: 'task-media' });
    expect(mocks.selectProviders).toHaveBeenCalledWith('task', 1, undefined, 'media');
    expect(kanbanEngine.createTaskRef).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agy',
    }));
  });

  it('fails closed when no compatible provider can execute an unassigned task', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.title = 'Create a product image';
    kanbanTask.assigned_to = undefined;
    mocks.listEnabledIds.mockReturnValue(['codex']);

    const result = await kanbanEngine.executePlan('plan-1', 'parallel');

    expect(result.results[0]).toMatchObject({
      taskId: 'kb-1',
      success: false,
      error: 'No compatible provider available for media task',
    });
    expect(kanbanEngine.createTaskRef).not.toHaveBeenCalled();
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('contains an unexpected batch routing exception after cards are claimed', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.assigned_to = undefined;
    mocks.listEnabledIds.mockImplementation(() => {
      throw new Error('provider registry unavailable');
    });

    const result = await kanbanEngine.executePlan('plan-1', 'parallel');

    expect(result.results[0]).toMatchObject({
      taskId: 'kb-1',
      success: false,
      error: 'provider registry unavailable',
    });
    expect(kanbanEngine.createTaskRef).not.toHaveBeenCalled();
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('does not let a stale retry steal a card already rebound to a newer attempt', async () => {
    if (!mocks.activeDb) throw new Error('missing mock db');
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-initial', {
        id: 'task-initial',
        status: 'failed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: '',
        error: 'initial attempt failed',
      });
      return { ok: true, newTaskId: 'task-initial' };
    });
    kanbanEngine.createRetryTaskRef = vi.fn(async () => {
      const card = mocks.activeDb?.state.kanbanTasks.get('kb-1');
      if (!card || !mocks.activeDb) throw new Error('missing card');
      mocks.activeDb.state.tasks.set('task-stale-retry', {
        id: 'task-stale-retry',
        status: 'completed',
        prompt: 'stale retry',
        response: 'stale output',
        error: '',
      });
      mocks.activeDb.state.tasks.set('task-newer-owner', {
        id: 'task-newer-owner',
        status: 'reviewing',
        prompt: 'newer retry',
        response: 'awaiting review',
        error: '',
      });
      card.task_id = 'task-newer-owner';
      card.column_status = 'review';
      return { ok: true, newTaskId: 'task-stale-retry' };
    });

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      success: false,
      superseded: true,
      lastTaskId: 'task-stale-retry',
    });
    expect(mocks.activeDb.state.kanbanTasks.get('kb-1')).toMatchObject({
      task_id: 'task-newer-owner',
      column_status: 'review',
    });
  });

  it('does not let a late terminal result move a card owned by a newer attempt', async () => {
    if (!mocks.activeDb) throw new Error('missing mock db');
    kanbanEngine.createTaskRef = vi.fn(async (input) => {
      mocks.activeDb?.state.tasks.set('task-late-completion', {
        id: 'task-late-completion',
        status: 'completed',
        prompt: input.prompt,
        assigned_to: input.agentId,
        response: 'old completion',
        error: '',
      });
      return { ok: true, newTaskId: 'task-late-completion' };
    });
    mocks.activeDb.state.onTaskPoll = () => {
      if (!mocks.activeDb) return;
      mocks.activeDb.state.onTaskPoll = undefined;
      const card = mocks.activeDb.state.kanbanTasks.get('kb-1');
      if (!card) throw new Error('missing card');
      card.task_id = 'task-current-owner';
      card.column_status = 'review';
      mocks.activeDb.state.tasks.set('task-current-owner', {
        id: 'task-current-owner',
        status: 'reviewing',
        prompt: 'current attempt',
        response: 'awaiting current review',
        error: '',
      });
    };

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result.results[0]).toMatchObject({
      success: false,
      superseded: true,
      lastTaskId: 'task-late-completion',
    });
    expect(mocks.activeDb.state.kanbanTasks.get('kb-1')).toMatchObject({
      task_id: 'task-current-owner',
      column_status: 'review',
    });
  });

  it('contains an unexpected dispatch exception on the review column', async () => {
    kanbanEngine.createTaskRef = vi.fn().mockRejectedValue(new Error('queue transport exploded'));

    const result = await kanbanEngine.executePlan('plan-1', 'sequential');

    expect(result).toMatchObject({
      executed: 1,
      results: [{
        taskId: 'kb-1',
        lastTaskId: '',
        success: false,
        error: 'queue transport exploded',
      }],
    });
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('review');
  });

  it('contains malformed dependency JSON without aborting a parallel plan', async () => {
    const kanbanTask = mocks.activeDb?.state.kanbanTasks.get('kb-1');
    if (!kanbanTask) throw new Error('missing kanban task');
    kanbanTask.depends_on_json = '{broken';

    const result = await kanbanEngine.executePlan('plan-1', 'parallel');

    expect(result).toEqual({
      executed: 0,
      results: [{
        taskId: 'kb-1',
        success: false,
        error: 'Dependencies not completed',
      }],
    });
    expect(kanbanEngine.createTaskRef).not.toHaveBeenCalled();
    expect(mocks.activeDb?.state.kanbanTasks.get('kb-1')?.column_status).toBe('todo');
  });
});
