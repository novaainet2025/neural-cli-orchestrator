import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeTask = vi.fn();
const listEnabledIds = vi.fn(() => ['claude-code', 'codex', 'cursor-agent']);
const getAvailability = vi.fn(() => ({
  available: true,
  status: 'available',
  reason: null as string | null,
}));
const publish = vi.fn(async () => undefined);

vi.mock('../agent/agent-manager.js', () => ({
  agentManager: {
    executeTask,
    listEnabledIds,
  },
}));

vi.mock('./event-bus.js', () => ({
  eventBus: {
    publish,
  },
}));

vi.mock('../security/circuit-breaker-registry.js', () => ({
  circuitBreakerRegistry: {
    getAvailability,
  },
}));

const { commander } = await import('./commander.js');

describe('Commander', () => {
  beforeEach(() => {
    executeTask.mockReset();
    listEnabledIds.mockReset();
    listEnabledIds.mockReturnValue(['claude-code', 'codex', 'cursor-agent']);
    getAvailability.mockReset();
    getAvailability.mockReturnValue({
      available: true,
      status: 'available',
      reason: null,
    });
    publish.mockClear();
  });

  it('fails fast when management returns a placeholder plan', async () => {
    executeTask.mockResolvedValueOnce({
      success: true,
      output: '# test\n\n- [x] (작업 추가 필요)\n',
    });

    const result = await commander.executeCommand('test');

    expect(result.status).toBe('failed');
    expect(result.finalOutput).toContain('empty or placeholder execution plan');
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('passes sanitized actionable steps to execution', async () => {
    executeTask
      .mockResolvedValueOnce({
        success: true,
        output: [
          '1. Analyze the failing commander flow',
          '2. Implement a guard for placeholder plans',
          '3. Add a regression test',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'Implemented the fix and added tests.',
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'Looks correct.',
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'Final consolidated output.',
      });

    const result = await commander.executeCommand('fix commander placeholder plan handling');

    expect(result.status).toBe('completed');
    expect(executeTask).toHaveBeenCalledTimes(4);
    expect(executeTask.mock.calls[1]?.[1]).toContain('- Analyze the failing commander flow');
    expect(executeTask.mock.calls[1]?.[1]).toContain('- Implement a guard for placeholder plans');
    expect(executeTask.mock.calls[1]?.[1]).not.toContain('1.');
  });

  it('fails before execution when management returns a CLI error string', async () => {
    executeTask.mockResolvedValueOnce({
      success: true,
      output: 'Error: Reached max turns (3)',
    });

    const result = await commander.executeCommand('verify');

    expect(result.status).toBe('failed');
    expect(result.finalOutput).toContain('empty or placeholder execution plan');
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when every enabled provider is circuit-gated', async () => {
    getAvailability.mockReturnValue({
      available: false,
      status: 'gated:generic',
      reason: 'generic',
    });

    const result = await commander.executeCommand('implement a safe improvement');

    expect(result.status).toBe('failed');
    expect(result.finalOutput).toContain('No available provider for management layer');
    expect(executeTask).not.toHaveBeenCalled();
  });
});
