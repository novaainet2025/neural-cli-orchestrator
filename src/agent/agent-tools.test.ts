import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentToolExecutor } from './agent-tools.js';
import { SandboxManager } from '../security/sandbox-manager.js';
import { resolve } from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => 'content'),
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  mkdir: vi.fn(async () => undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('execa', () => ({
  execa: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, failed: false })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

vi.mock('../utils/config.js', () => ({
  env: { PROJECT_DIR: '/default/project' }
}));

vi.mock('../security/file-change-guard.js', () => ({
  fileChangeGuard: {
    validateChange: vi.fn(async () => ({ action: 'proceed' })),
  }
}));

vi.mock('../core/shared-state.js', () => ({
  sharedState: {
    getLockHolder: vi.fn(async () => null),
    acquireLock: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  }
}));

vi.mock('../core/event-bus.js', () => ({
  eventBus: {
    publish: vi.fn(async () => undefined)
  }
}));

import { readFile, writeFile } from 'fs/promises';
import { execa } from 'execa';

describe('AgentToolExecutor projectDir regression', () => {
  const sandbox = {
    canExecute: () => true,
    assertPath: vi.fn(),
    assertCommand: vi.fn(),
    assertFileSize: vi.fn(),
    getTimeout: () => 1000,
    acquireSlot: async () => () => {},
  } as unknown as SandboxManager;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves file paths against projectDir', async () => {
    const executor = new AgentToolExecutor('agent1', sandbox, 'task1', '/test/project');
    await executor.execute({ tool: 'readFile', args: { path: 'test.txt' } });
    
    expect(readFile).toHaveBeenCalledWith(resolve('/test/project', 'test.txt'), 'utf-8');
    expect(sandbox.assertPath).toHaveBeenCalledWith(resolve('/test/project', 'test.txt'));
  });

  it('runs commands with cwd set to projectDir', async () => {
    const executor = new AgentToolExecutor('agent1', sandbox, 'task1', '/test/project');
    await executor.execute({ tool: 'runCommand', args: { command: 'echo hello' } });
    
    expect(execa).toHaveBeenCalledWith('echo', ['hello'], expect.objectContaining({
      cwd: '/test/project'
    }));
  });
});
