import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sessionSequence = 0;

vi.mock('./orchestrated-loop.js', () => ({ OrchestratedLoop: class {} }));
vi.mock('./api-executor.js', () => ({ ApiExecutor: class {} }));
vi.mock('./agent-manager.js', () => ({
  agentManager: {
    getProvider: vi.fn(() => ({ id: 'test-agent' })),
    executeTask: vi.fn(),
  },
}));
vi.mock('../security/sandbox-manager.js', () => ({ createSandbox: vi.fn() }));
vi.mock('../core/event-bus.js', () => ({
  eventBus: { publish: vi.fn(async () => undefined) },
}));
vi.mock('../core/shared-state.js', () => ({ sharedState: {} }));
vi.mock('../storage/database.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: vi.fn(), all: vi.fn(() => []) }),
  }),
}));
vi.mock('../utils/config.js', () => ({ env: {} }));
vi.mock('../utils/id.js', () => ({ createSessionId: () => `session-${++sessionSequence}` }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { agentManager } from './agent-manager.js';
import { sessionManager } from './session-manager.js';

describe('AgentSessionManager retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.mocked(agentManager.executeTask).mockResolvedValue({
      success: true,
      output: 'done',
      iterations: 1,
      toolCalls: 0,
    } as any);
  });

  afterEach(() => {
    sessionManager.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('clears controller references and evicts a completed session after its TTL', async () => {
    const sessionId = await sessionManager.startSession('prompt', 'test-agent');
    await Promise.resolve();

    const completed = sessionManager.getSession(sessionId);
    expect(completed?.status).toBe('completed');
    expect(completed?.abortController).toBeUndefined();
    expect(completed?.pendingApproval).toBeUndefined();

    vi.advanceTimersByTime(15 * 60_000);
    expect(sessionManager.getSession(sessionId)).toBeUndefined();
  });

  it('rejects and clears a pending approval when the session is aborted', async () => {
    vi.mocked(agentManager.executeTask).mockImplementationOnce((_agentId, _prompt, options) => (
      new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    ));
    const sessionId = await sessionManager.startSession('prompt', 'test-agent');
    const approval = sessionManager.requestApproval(sessionId, { tool: 'runCommand' });

    expect(await sessionManager.abortSession(sessionId)).toBe(true);
    expect(await approval).toBe(false);
    expect(sessionManager.getSession(sessionId)?.abortController).toBeUndefined();
    expect(sessionManager.getSession(sessionId)?.pendingApproval).toBeUndefined();
  });

  it('keeps only the 100 most recent completed sessions', async () => {
    const sessionIds: string[] = [];
    for (let index = 0; index < 101; index++) {
      sessionIds.push(await sessionManager.startSession(`prompt-${index}`, 'test-agent'));
    }
    await Promise.resolve();

    expect(sessionManager.listSessions()).toHaveLength(100);
    expect(sessionManager.getSession(sessionIds[0])).toBeUndefined();
    expect(sessionManager.getSession(sessionIds[100])).toBeDefined();
  });
});
