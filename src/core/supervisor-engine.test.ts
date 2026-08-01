import { beforeEach, describe, expect, it, vi } from 'vitest';

type StalledTask = { id: string; assigned_to: string | null };

const mocks = vi.hoisted(() => ({
  assigned: [] as StalledTask[],
  queued: [] as StalledTask[],
  publish: vi.fn(async () => undefined),
  replaceActiveTaskRef: null as ((taskId: string) => Promise<any>) | null,
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => sql.includes("status IN ('pending', 'queued')") ? mocks.queued : mocks.assigned,
    }),
  }),
}));

vi.mock('./kanban-engine.js', () => ({
  kanbanEngine: {
    get replaceActiveTaskRef() {
      return mocks.replaceActiveTaskRef;
    },
  },
}));

vi.mock('./event-bus.js', () => ({
  eventBus: { publish: mocks.publish },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { SupervisorEngine } = await import('./supervisor-engine.js');

async function recover(engine: InstanceType<typeof SupervisorEngine>): Promise<void> {
  await (engine as unknown as { recoverStalledTasks: () => Promise<void> }).recoverStalledTasks();
}

describe('SupervisorEngine stalled task recovery', () => {
  beforeEach(() => {
    mocks.assigned = [
      { id: 'assigned-stalled', assigned_to: 'codex' },
      { id: 'running-stalled', assigned_to: 'claude' },
    ];
    mocks.queued = [{ id: 'queued-stalled', assigned_to: null }];
    mocks.publish.mockClear();
    mocks.replaceActiveTaskRef = null;
  });

  it('routes every stalled task through the active replacement contract', async () => {
    const replace = vi.fn(async (taskId: string) => ({
      ok: true,
      newTaskId: `retry-${taskId}`,
      replacedActive: true,
    }));
    mocks.replaceActiveTaskRef = replace;

    await recover(new SupervisorEngine());

    expect(replace.mock.calls.map(([taskId]) => taskId)).toEqual([
      'assigned-stalled',
      'running-stalled',
      'queued-stalled',
    ]);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor:stall-recovery',
      data: expect.objectContaining({ detected: 3, recovered: 3, failed: 0 }),
    }));
  });

  it('leaves recovery to the contract and reports unavailable or rejected replacements as failures', async () => {
    await recover(new SupervisorEngine());

    expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ detected: 3, recovered: 0, failed: 3 }),
    }));

    mocks.publish.mockClear();
    mocks.replaceActiveTaskRef = vi.fn(async (taskId: string) => (
      taskId === 'assigned-stalled'
        ? { ok: true, newTaskId: 'retry-assigned' }
        : { ok: false, statusCode: 429, body: { error: 'retry limit exceeded' } }
    ));

    await recover(new SupervisorEngine());

    expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ detected: 3, recovered: 1, failed: 2 }),
    }));
  });
});
