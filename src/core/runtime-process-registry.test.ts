import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLegacyNcoProviderProcess,
  reapLegacyNcoProviderProcesses,
  reapOwnedRuntimeProcesses,
  reapStaleRuntimeProcesses,
  registerRuntimeProcess,
  unregisterRuntimeProcess,
  type ProcessSnapshot,
} from './runtime-process-registry.js';

describe('runtime process registry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE runtime_processes (
        task_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_group_id INTEGER NOT NULL,
        owner_pid INTEGER NOT NULL,
        command_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => db.close());

  it('registers a verified process and unregisters it at task finalization', () => {
    const processInfo: ProcessSnapshot = {
      pid: 4101,
      parentPid: 4000,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/codex exec --json prompt',
    };

    expect(registerRuntimeProcess(
      { taskId: 'task_a', agentId: 'codex', pid: 4101 },
      db,
      { ownerPid: 4000, inspectProcess: () => processInfo },
    )).toBe(true);
    expect(db.prepare('SELECT pid, process_group_id, owner_pid FROM runtime_processes').get()).toEqual({
      pid: 4101,
      process_group_id: 4101,
      owner_pid: 4000,
    });

    unregisterRuntimeProcess('task_a', db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get()).toEqual({ count: 0 });
  });

  it('reaps only an exact process-group and command match from a dead owner', () => {
    const provider: ProcessSnapshot = {
      pid: 4101,
      parentPid: 1,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/codex exec --json prompt',
    };
    registerRuntimeProcess(
      { taskId: 'task_a', agentId: 'codex', pid: provider.pid },
      db,
      { ownerPid: 4000, inspectProcess: () => provider },
    );
    const killProcessGroup = vi.fn();
    const inspectProcess = vi.fn((pid: number) => {
      if (pid === provider.pid) return provider;
      if (pid === 5000) return { pid: 5000, parentPid: 1, processGroupId: 5000, command: 'node dist/index.js' };
      return null;
    });

    expect(reapStaleRuntimeProcesses(db, {
      ownerPid: 5000,
      inspectProcess,
      killProcessGroup,
    })).toMatchObject({ examined: 1, reaped: 1, stale: 0 });
    expect(killProcessGroup).toHaveBeenCalledWith(4101);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get()).toEqual({ count: 0 });
  });

  it('does not kill a reused PID whose command fingerprint changed', () => {
    const original: ProcessSnapshot = {
      pid: 4101,
      parentPid: 4000,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/codex exec old prompt',
    };
    registerRuntimeProcess(
      { taskId: 'task_a', agentId: 'codex', pid: original.pid },
      db,
      { ownerPid: 4000, inspectProcess: () => original },
    );
    const killProcessGroup = vi.fn();

    expect(reapStaleRuntimeProcesses(db, {
      ownerPid: 5000,
      inspectProcess: (pid) => pid === original.pid
        ? { ...original, command: '/usr/bin/python unrelated.py' }
        : null,
      killProcessGroup,
    })).toMatchObject({ reaped: 0, stale: 1 });
    expect(killProcessGroup).not.toHaveBeenCalled();
  });

  it('keeps ownership evidence when process-group termination fails', () => {
    const provider: ProcessSnapshot = {
      pid: 4101,
      parentPid: 1,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/codex exec --json prompt',
    };
    registerRuntimeProcess(
      { taskId: 'task_a', agentId: 'codex', pid: provider.pid },
      db,
      { ownerPid: 4000, inspectProcess: () => provider },
    );

    expect(reapStaleRuntimeProcesses(db, {
      ownerPid: 5000,
      inspectProcess: (pid) => pid === provider.pid
        ? provider
        : pid === 5000
          ? { pid, parentPid: 1, processGroupId: 5000, command: 'node dist/index.js' }
          : null,
      killProcessGroup: () => {
        throw new Error('permission denied');
      },
    })).toMatchObject({ examined: 1, reaped: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get()).toEqual({ count: 1 });
  });

  it('force-reaps only exact registered processes owned by the shutting-down backend', () => {
    const owned: ProcessSnapshot = {
      pid: 4101,
      parentPid: 5000,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/opencode run --format json NCO task',
    };
    const unrelated: ProcessSnapshot = {
      pid: 4201,
      parentPid: 5000,
      processGroupId: 4201,
      command: '/opt/homebrew/bin/codex exec unrelated task',
    };
    registerRuntimeProcess(
      { taskId: 'task_owned', agentId: 'opencode', pid: owned.pid },
      db,
      { ownerPid: 5000, inspectProcess: () => owned },
    );
    registerRuntimeProcess(
      { taskId: 'task_unrelated', agentId: 'codex', pid: unrelated.pid },
      db,
      { ownerPid: 5000, inspectProcess: () => unrelated },
    );
    const killProcessGroup = vi.fn();

    expect(reapOwnedRuntimeProcesses(['task_owned'], db, {
      ownerPid: 5000,
      inspectProcess: (pid) => pid === owned.pid
        ? owned
        : pid === 5000
          ? { pid, parentPid: 1, processGroupId: 5000, command: 'node dist/index.js' }
          : null,
      killProcessGroup,
    })).toMatchObject({ examined: 1, reaped: 1, stale: 0 });
    expect(killProcessGroup).toHaveBeenCalledOnce();
    expect(killProcessGroup).toHaveBeenCalledWith(owned.processGroupId);
    expect(db.prepare('SELECT task_id FROM runtime_processes').all()).toEqual([
      { task_id: 'task_unrelated' },
    ]);
  });

  it('does not force-kill a registered PID after its command fingerprint changes', () => {
    const original: ProcessSnapshot = {
      pid: 4101,
      parentPid: 5000,
      processGroupId: 4101,
      command: '/opt/homebrew/bin/opencode run original',
    };
    registerRuntimeProcess(
      { taskId: 'task_owned', agentId: 'opencode', pid: original.pid },
      db,
      { ownerPid: 5000, inspectProcess: () => original },
    );
    const killProcessGroup = vi.fn();

    expect(reapOwnedRuntimeProcesses(['task_owned'], db, {
      ownerPid: 5000,
      inspectProcess: (pid) => pid === original.pid
        ? { ...original, command: '/usr/bin/python unrelated.py' }
        : null,
      killProcessGroup,
    })).toMatchObject({ examined: 1, reaped: 0, stale: 1 });
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get()).toEqual({ count: 0 });
  });

  it('recognizes and reaps only legacy NCO provider signatures with PPID 1', () => {
    const codex = {
      pid: 6101,
      parentPid: 1,
      processGroupId: 6101,
      command: '/opt/homebrew/bin/codex exec --output-last-message /var/folders/xx/T/nco-codex-last-abc prompt',
    };
    const userCodex = { ...codex, pid: 6102, processGroupId: 6102, command: 'codex exec user-task' };
    const liveNcoChild = { ...codex, pid: 6103, processGroupId: 6103, parentPid: 5000 };
    const openCodeHistory = {
      pid: 6104,
      parentPid: 1,
      processGroupId: 6104,
      command: 'opencode run --pure --format json ## Conversation History (workspace: default) task',
    };
    const openCodeDiscussion = {
      pid: 6105,
      parentPid: 1,
      processGroupId: 6105,
      command: 'opencode run --pure --format json Discussion R1. Session: sess_dead_backend task',
    };
    const userOpenCode = {
      pid: 6106,
      parentPid: 1,
      processGroupId: 6106,
      command: 'opencode run --format json user-task',
    };
    expect(isLegacyNcoProviderProcess(codex)).toBe(true);
    expect(isLegacyNcoProviderProcess(userCodex)).toBe(false);
    expect(isLegacyNcoProviderProcess(liveNcoChild)).toBe(false);
    expect(isLegacyNcoProviderProcess(openCodeHistory)).toBe(true);
    expect(isLegacyNcoProviderProcess(openCodeDiscussion)).toBe(true);
    expect(isLegacyNcoProviderProcess(userOpenCode)).toBe(false);
    const killProcessGroup = vi.fn();

    expect(reapLegacyNcoProviderProcesses({
      ownerPid: 5000,
      listProcesses: () => [
        codex,
        userCodex,
        liveNcoChild,
        openCodeHistory,
        openCodeDiscussion,
        userOpenCode,
      ],
      inspectProcess: (pid) => pid === 5000
        ? { pid, parentPid: 1, processGroupId: 5000, command: 'node dist/index.js' }
        : null,
      killProcessGroup,
    })).toBe(3);
    expect(killProcessGroup).toHaveBeenCalledWith(6101);
    expect(killProcessGroup).toHaveBeenCalledWith(6104);
    expect(killProcessGroup).toHaveBeenCalledWith(6105);
  });
});
