import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('runtime-process-registry');

export interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  processGroupId: number;
  command: string;
}

interface RuntimeProcessRow {
  task_id: string;
  agent_id: string;
  pid: number;
  process_group_id: number;
  owner_pid: number;
  command_hash: string;
}

export interface ProcessRegistryDependencies {
  inspectProcess?: (pid: number) => ProcessSnapshot | null;
  listProcesses?: () => ProcessSnapshot[];
  killProcessGroup?: (processGroupId: number) => void;
  ownerPid?: number;
}

export interface ProcessReapResult {
  examined: number;
  reaped: number;
  stale: number;
  skippedLiveOwner: number;
}

function parseProcessLine(line: string): ProcessSnapshot | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+?)\s*$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    command: match[4],
  };
}

export function inspectProcess(pid: number): ProcessSnapshot | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'command=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 },
    );
    return parseProcessLine(output.trim());
  } catch {
    return null;
  }
}

export function listProcesses(): ProcessSnapshot[] {
  try {
    const output = execFileSync(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,command='],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return output.split('\n').map(parseProcessLine).filter((row): row is ProcessSnapshot => row != null);
  } catch (error) {
    log.warn({ err: error }, 'Could not inspect process table for orphan cleanup');
    return [];
  }
}

function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function isNcoBackendProcess(processInfo: ProcessSnapshot | null): boolean {
  if (!processInfo) return false;
  return /(?:dist\/index\.js|src\/index\.ts)(?:\s|$)/.test(processInfo.command)
    && /(?:^|[\s/])(?:node|tsx)(?:\s|$)/.test(processInfo.command);
}

function defaultKillProcessGroup(processGroupId: number): void {
  if (process.platform === 'win32') {
    process.kill(processGroupId, 'SIGKILL');
    return;
  }
  process.kill(-processGroupId, 'SIGKILL');
}

function safeProcessGroup(
  processGroupId: number,
  ownerPid: number,
  inspect: (pid: number) => ProcessSnapshot | null,
): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return false;
  const owner = inspect(ownerPid);
  if (!owner) return false;
  return owner.processGroupId !== processGroupId;
}

export function registerRuntimeProcess(
  input: { taskId: string; agentId: string; pid: number },
  database: Database.Database = getDb(),
  dependencies: ProcessRegistryDependencies = {},
): boolean {
  try {
    const inspect = dependencies.inspectProcess ?? inspectProcess;
    const snapshot = inspect(input.pid);
    if (!snapshot || snapshot.pid !== input.pid) return false;
    database.prepare(`
      INSERT INTO runtime_processes (
        task_id, agent_id, pid, process_group_id, owner_pid, command_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        pid = excluded.pid,
        process_group_id = excluded.process_group_id,
        owner_pid = excluded.owner_pid,
        command_hash = excluded.command_hash,
        updated_at = datetime('now')
    `).run(
      input.taskId,
      input.agentId,
      snapshot.pid,
      snapshot.processGroupId,
      dependencies.ownerPid ?? process.pid,
      commandHash(snapshot.command),
    );
    return true;
  } catch (error) {
    log.warn({ err: error, taskId: input.taskId, pid: input.pid }, 'Runtime process registration failed');
    return false;
  }
}

export function unregisterRuntimeProcess(
  taskId: string,
  database: Database.Database = getDb(),
): void {
  try {
    database.prepare('DELETE FROM runtime_processes WHERE task_id = ?').run(taskId);
  } catch (error) {
    log.warn({ err: error, taskId }, 'Runtime process unregister failed');
  }
}

export function reapStaleRuntimeProcesses(
  database: Database.Database = getDb(),
  dependencies: ProcessRegistryDependencies = {},
): ProcessReapResult {
  const inspect = dependencies.inspectProcess ?? inspectProcess;
  const killGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  const ownerPid = dependencies.ownerPid ?? process.pid;
  const rows = database.prepare(`
    SELECT task_id, agent_id, pid, process_group_id, owner_pid, command_hash
    FROM runtime_processes
    WHERE owner_pid <> ?
  `).all(ownerPid) as RuntimeProcessRow[];
  const result: ProcessReapResult = { examined: rows.length, reaped: 0, stale: 0, skippedLiveOwner: 0 };
  const remove = database.prepare('DELETE FROM runtime_processes WHERE task_id = ?');

  for (const row of rows) {
    if (isNcoBackendProcess(inspect(row.owner_pid))) {
      result.skippedLiveOwner += 1;
      continue;
    }
    const snapshot = inspect(row.pid);
    const exactMatch = snapshot?.processGroupId === row.process_group_id
      && commandHash(snapshot.command) === row.command_hash;
    let removeRegistryRow = !exactMatch;
    if (exactMatch && safeProcessGroup(row.process_group_id, ownerPid, inspect)) {
      try {
        killGroup(row.process_group_id);
        result.reaped += 1;
        removeRegistryRow = true;
        log.warn(
          { taskId: row.task_id, agentId: row.agent_id, pid: row.pid, pgid: row.process_group_id },
          'Reaped provider process left by a dead NCO backend',
        );
      } catch (error) {
        log.warn({ err: error, taskId: row.task_id, pid: row.pid }, 'Failed to reap stale provider process');
      }
    } else {
      result.stale += 1;
    }
    if (removeRegistryRow) remove.run(row.task_id);
  }
  return result;
}

/**
 * Force-reap provider processes that still belong to this backend after the
 * bounded shutdown drain. The registry fingerprint prevents PID-reuse kills;
 * rows for a different owner are deliberately left for startup recovery.
 */
export function reapOwnedRuntimeProcesses(
  taskIds: readonly string[],
  database: Database.Database = getDb(),
  dependencies: ProcessRegistryDependencies = {},
): ProcessReapResult {
  const targets = new Set(taskIds);
  if (targets.size === 0) {
    return { examined: 0, reaped: 0, stale: 0, skippedLiveOwner: 0 };
  }

  const inspect = dependencies.inspectProcess ?? inspectProcess;
  const killGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  const ownerPid = dependencies.ownerPid ?? process.pid;
  const rows = (database.prepare(`
    SELECT task_id, agent_id, pid, process_group_id, owner_pid, command_hash
    FROM runtime_processes
    WHERE owner_pid = ?
  `).all(ownerPid) as RuntimeProcessRow[]).filter(row => targets.has(row.task_id));
  const result: ProcessReapResult = { examined: rows.length, reaped: 0, stale: 0, skippedLiveOwner: 0 };
  const remove = database.prepare('DELETE FROM runtime_processes WHERE task_id = ?');

  for (const row of rows) {
    const snapshot = inspect(row.pid);
    const exactMatch = snapshot?.processGroupId === row.process_group_id
      && commandHash(snapshot.command) === row.command_hash;
    if (!exactMatch) {
      result.stale += 1;
      remove.run(row.task_id);
      continue;
    }
    if (!safeProcessGroup(row.process_group_id, ownerPid, inspect)) {
      result.stale += 1;
      continue;
    }
    try {
      killGroup(row.process_group_id);
      result.reaped += 1;
      remove.run(row.task_id);
      log.warn(
        { taskId: row.task_id, agentId: row.agent_id, pid: row.pid, pgid: row.process_group_id },
        'Force-reaped provider process after shutdown drain timeout',
      );
    } catch (error) {
      log.warn({ err: error, taskId: row.task_id, pid: row.pid }, 'Failed to force-reap provider process');
    }
  }
  return result;
}

/** Strict signatures used only for pre-registry processes from older builds. */
export function isLegacyNcoProviderProcess(processInfo: ProcessSnapshot): boolean {
  if (processInfo.parentPid !== 1) return false;
  const command = processInfo.command;
  const orphanedCodex = /(?:^|[\s/])codex(?:\s+)exec(?:\s|$)/.test(command)
    // macOS native CLIs use /var/folders/... while Linux uses /tmp.
    // The basename is generated only by NCO's Codex executor.
    && command.includes('nco-codex-last-');
  const orphanedOpenCode = /(?:^|[\s/])opencode(?:\s+)run(?:\s|$)/.test(command)
    && (
      command.includes('[NCO Core Operating Principles v1]')
      // Pre-registry OrchestratedLoop prompts were sometimes prefixed with
      // persisted conversation history, so the core-principles marker was not
      // present in ps output. These two headers are emitted by NCO itself.
      || command.includes('## Conversation History (workspace:')
      || /Discussion R\d+\. Session: sess_[A-Za-z0-9_-]+/.test(command)
    );
  return orphanedCodex || orphanedOpenCode;
}

export function reapLegacyNcoProviderProcesses(
  dependencies: ProcessRegistryDependencies = {},
): number {
  if (process.env.NCO_LEGACY_PROCESS_REAP === '0') return 0;
  const inspect = dependencies.inspectProcess ?? inspectProcess;
  const ownerPid = dependencies.ownerPid ?? process.pid;
  const killGroup = dependencies.killProcessGroup ?? defaultKillProcessGroup;
  const processes = (dependencies.listProcesses ?? listProcesses)();
  const groups = new Map<number, ProcessSnapshot>();
  for (const processInfo of processes) {
    if (isLegacyNcoProviderProcess(processInfo)) groups.set(processInfo.processGroupId, processInfo);
  }

  let reaped = 0;
  for (const [processGroupId, processInfo] of groups) {
    if (!safeProcessGroup(processGroupId, ownerPid, inspect)) continue;
    try {
      killGroup(processGroupId);
      reaped += 1;
      log.warn(
        { pid: processInfo.pid, pgid: processGroupId },
        'Reaped legacy NCO provider process with no live parent',
      );
    } catch (error) {
      log.warn({ err: error, pid: processInfo.pid, pgid: processGroupId }, 'Legacy provider reap failed');
    }
  }
  return reaped;
}
