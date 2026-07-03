import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxManager } from '../src/security/sandbox-manager.js';
import {
  PRMTrajectoryAbortError,
  TrajectoryGuard,
  type TrajectoryGuardConfig,
} from '../src/security/trajectory-guard.js';

vi.mock('../src/core/event-bus.js', () => ({
  eventBus: {
    publish: vi.fn().mockResolvedValue(undefined),
  },
}));

function createSandboxStub() {
  return {
    recordFailure: vi.fn(),
  } as unknown as SandboxManager & { recordFailure: ReturnType<typeof vi.fn> };
}

function createConfig(overrides: Partial<TrajectoryGuardConfig> = {}): TrajectoryGuardConfig {
  return {
    toolBudgetLimit: 200,
    toolBudgetWindowMs: 30 * 60_000,
    repeatedToolLimit: 10,
    pingPongLimit: 4,
    consecutiveToolErrorLimit: 5,
    ...overrides,
  };
}

function createContext(taskId: string, agentId: string, sandbox = createSandboxStub()) {
  return {
    ctx: {
      taskId,
      agentId,
      sandbox,
    },
    sandbox,
  };
}

const originalEnv = {
  PRM_TOOL_BUDGET_LIMIT: process.env.PRM_TOOL_BUDGET_LIMIT,
  PRM_TOOL_BUDGET_WINDOW_MS: process.env.PRM_TOOL_BUDGET_WINDOW_MS,
  PRM_REPEATED_TOOL_LIMIT: process.env.PRM_REPEATED_TOOL_LIMIT,
  PRM_PING_PONG_LIMIT: process.env.PRM_PING_PONG_LIMIT,
  PRM_TOOL_ERROR_STREAK_LIMIT: process.env.PRM_TOOL_ERROR_STREAK_LIMIT,
};

afterEach(() => {
  process.env.PRM_TOOL_BUDGET_LIMIT = originalEnv.PRM_TOOL_BUDGET_LIMIT;
  process.env.PRM_TOOL_BUDGET_WINDOW_MS = originalEnv.PRM_TOOL_BUDGET_WINDOW_MS;
  process.env.PRM_REPEATED_TOOL_LIMIT = originalEnv.PRM_REPEATED_TOOL_LIMIT;
  process.env.PRM_PING_PONG_LIMIT = originalEnv.PRM_PING_PONG_LIMIT;
  process.env.PRM_TOOL_ERROR_STREAK_LIMIT = originalEnv.PRM_TOOL_ERROR_STREAK_LIMIT;
  vi.clearAllMocks();
});

describe('TrajectoryGuard', () => {
  it('warns on repeated tool breach and aborts on the next breach', async () => {
    const guard = new TrajectoryGuard(createConfig({ repeatedToolLimit: 2 }));
    const { ctx } = createContext('task-repeat', 'agent-a');

    await expect(guard.beforeTool(ctx, { tool: 'search' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.beforeTool(ctx, { tool: 'search' })).resolves.toMatchObject({ allowed: true });

    const warning = await guard.beforeTool(ctx, { tool: 'search' });
    expect(warning).toMatchObject({
      allowed: false,
      breach: 'tool-repeat',
      escalation: 'warn',
    });
    expect(warning.snapshot.escalationLevel).toBe(1);
    expect(warning.snapshot.repeatedToolCount).toBe(3);

    await expect(guard.beforeTool(ctx, { tool: 'search' })).rejects.toMatchObject({
      name: 'PRMTrajectoryAbortError',
      breach: 'tool-repeat',
      escalation: 'abort',
    });
  });

  it('reads tool budget env overrides at instantiation time and fires within the rolling window', async () => {
    process.env.PRM_TOOL_BUDGET_LIMIT = '5';
    process.env.PRM_TOOL_BUDGET_WINDOW_MS = '1000';

    const guard = new TrajectoryGuard();
    const { ctx } = createContext('task-budget', 'agent-a');

    for (let i = 0; i < 5; i++) {
      await expect(guard.beforeTool(ctx, { tool: `tool-${i}`, at: i * 100 })).resolves.toMatchObject({ allowed: true });
    }

    const warning = await guard.beforeTool(ctx, { tool: 'tool-6', at: 550 });
    expect(warning).toMatchObject({
      allowed: false,
      breach: 'tool-budget',
      escalation: 'warn',
    });
    expect(warning.snapshot.toolTimestamps).toHaveLength(6);
  });

  it('detects ping-pong sendMessage alternation at the configured limit', async () => {
    const guard = new TrajectoryGuard(createConfig({ pingPongLimit: 4 }));
    const { ctx } = createContext('task-pingpong', 'agent-a');

    await expect(guard.beforeTool(ctx, { tool: 'sendMessage', toAgent: 'agent-b' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.beforeTool(ctx, { tool: 'sendMessage', toAgent: 'agent-c' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.beforeTool(ctx, { tool: 'sendMessage', toAgent: 'agent-b' })).resolves.toMatchObject({ allowed: true });

    const warning = await guard.beforeTool(ctx, { tool: 'sendMessage', toAgent: 'agent-c' });
    expect(warning).toMatchObject({
      allowed: false,
      breach: 'ping-pong',
      escalation: 'warn',
    });
    expect(warning.snapshot.recentHops.slice(-4)).toEqual([
      'agent-a->agent-b',
      'agent-a->agent-c',
      'agent-a->agent-b',
      'agent-a->agent-c',
    ]);
  });

  it('resets tool error streak after a success and breaches again only on a fresh streak', async () => {
    const guard = new TrajectoryGuard(createConfig({ consecutiveToolErrorLimit: 3 }));
    const { ctx } = createContext('task-errors', 'agent-a');

    await expect(guard.afterTool(ctx, { tool: 'exec', ok: false, error: 'e1' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.afterTool(ctx, { tool: 'exec', ok: false, error: 'e2' })).resolves.toMatchObject({ allowed: true });

    const reset = await guard.afterTool(ctx, { tool: 'exec', ok: true });
    expect(reset.allowed).toBe(true);
    expect(reset.snapshot.consecutiveToolErrors).toBe(0);

    await expect(guard.afterTool(ctx, { tool: 'exec', ok: false, error: 'e3' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.afterTool(ctx, { tool: 'exec', ok: false, error: 'e4' })).resolves.toMatchObject({ allowed: true });

    const warning = await guard.afterTool(ctx, { tool: 'exec', ok: false, error: 'e5' });
    expect(warning).toMatchObject({
      allowed: false,
      breach: 'tool-error-streak',
      escalation: 'warn',
    });
    expect(warning.snapshot.consecutiveToolErrors).toBe(3);
  });

  it('drops ended task state without leaking across task ids or active tasks', async () => {
    const guard = new TrajectoryGuard(createConfig({ repeatedToolLimit: 1 }));
    const taskOne = createContext('task-one', 'agent-a');
    const taskTwo = createContext('task-two', 'agent-a');

    await expect(guard.beforeTool(taskOne.ctx, { tool: 'grep' })).resolves.toMatchObject({ allowed: true });
    await expect(guard.beforeTool(taskTwo.ctx, { tool: 'grep' })).resolves.toMatchObject({ allowed: true });

    guard.endTask('task-one', 'agent-a');

    await expect(guard.beforeTool(taskOne.ctx, { tool: 'grep' })).resolves.toMatchObject({ allowed: true });

    const taskTwoWarning = await guard.beforeTool(taskTwo.ctx, { tool: 'grep' });
    expect(taskTwoWarning).toMatchObject({
      allowed: false,
      breach: 'tool-repeat',
      escalation: 'warn',
    });
  });

  it('calls sandbox.recordFailure on third escalation when the circuit opens', async () => {
    const guard = new TrajectoryGuard(createConfig({ repeatedToolLimit: 1 }));
    const { ctx, sandbox } = createContext('task-circuit', 'agent-a');

    await expect(guard.beforeTool(ctx, { tool: 'grep' })).resolves.toMatchObject({ allowed: true });

    const warn = await guard.beforeTool(ctx, { tool: 'grep' });
    expect(warn.escalation).toBe('warn');

    await expect(guard.beforeTool(ctx, { tool: 'grep' })).rejects.toMatchObject({
      breach: 'tool-repeat',
      escalation: 'abort',
    });

    await expect(guard.beforeTool(ctx, { tool: 'grep' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PRMTrajectoryAbortError);
      expect((error as PRMTrajectoryAbortError).escalation).toBe('circuit-open');
      return true;
    });

    expect(sandbox.recordFailure).toHaveBeenCalledTimes(1);
    expect(sandbox.recordFailure).toHaveBeenCalledWith('PRM trajectory breach: tool-repeat');
  });
});
