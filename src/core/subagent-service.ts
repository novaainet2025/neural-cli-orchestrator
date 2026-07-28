import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../storage/database.js';
import { eventBus } from './event-bus.js';
import { createSubagentRunId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('subagent-service');
const ACTIVE_NATIVE_STATUSES = ['starting', 'working'] as const;
const ACTIVE_TASK_STATUSES = ['pending', 'assigned', 'running', 'streaming'] as const;

export type SubagentStatus = 'starting' | 'working' | 'completed' | 'failed' | 'cancelled';
export type SubagentSource = 'native' | 'nco-task';

export interface SubagentRun {
  id: string;
  parentTaskId: string;
  rootTaskId?: string;
  parentProvider: string;
  cliSessionId?: string;
  spawnedByCli?: string;
  externalAgentId?: string;
  parentExternalAgentId?: string;
  name?: string;
  status: SubagentStatus;
  promptSummary?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  source: SubagentSource;
  evidenceSource?: string;
}

interface SubagentRunRow {
  id: string;
  parent_task_id: string;
  root_task_id: string | null;
  parent_provider: string;
  cli_session_id: string | null;
  spawned_by_cli: string | null;
  name: string | null;
  status: string;
  prompt_summary: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  source: string;
  evidence_source: string | null;
  metadata_json: string | null;
}

interface SubagentMetadata {
  externalAgentId?: string;
  parentExternalAgentId?: string;
}

function parseMetadata(value: string | null): SubagentMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed as SubagentMetadata : {};
  } catch {
    return {};
  }
}

function rowToRun(row: SubagentRunRow): SubagentRun {
  const metadata = parseMetadata(row.metadata_json);
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    rootTaskId: row.root_task_id ?? undefined,
    parentProvider: row.parent_provider,
    cliSessionId: row.cli_session_id ?? undefined,
    spawnedByCli: row.spawned_by_cli ?? undefined,
    externalAgentId: metadata.externalAgentId,
    parentExternalAgentId: metadata.parentExternalAgentId,
    name: row.name ?? undefined,
    status: row.status as SubagentStatus,
    promptSummary: row.prompt_summary ?? undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    source: row.source as SubagentSource,
    evidenceSource: row.evidence_source ?? undefined,
  };
}

type SubagentEventType =
  | 'subagent:started'
  | 'subagent:updated'
  | 'subagent:completed'
  | 'subagent:failed';

function publishSubagentEvent(type: SubagentEventType, run: SubagentRun): void {
  eventBus.publish({
    type,
    subagentId: run.id,
    parentTaskId: run.parentTaskId,
    rootTaskId: run.rootTaskId,
    parentProvider: run.parentProvider,
    externalAgentId: run.externalAgentId,
    parentExternalAgentId: run.parentExternalAgentId,
    name: run.name,
    status: run.status,
    source: run.source,
  }).catch(err => log.error({ err, type, subagentId: run.id }, 'subagent event publish failed'));
}

type NewSubagentRun = Omit<SubagentRun, 'id' | 'startedAt' | 'updatedAt' | 'status'> & {
  status?: SubagentStatus;
};

export function recordSubagentRun(run: NewSubagentRun): SubagentRun {
  const db = getDb();
  const id = createSubagentRunId();
  const now = sqlNow();
  const status = run.status ?? 'starting';
  const source = run.source ?? 'native';
  const metadata: SubagentMetadata = {
    externalAgentId: run.externalAgentId,
    parentExternalAgentId: run.parentExternalAgentId,
  };

  db.prepare(`
    INSERT INTO subagent_runs (
      id, parent_task_id, root_task_id, parent_provider, cli_session_id,
      spawned_by_cli, name, status, prompt_summary, started_at, updated_at,
      source, evidence_source, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.parentTaskId,
    run.rootTaskId ?? null,
    run.parentProvider,
    run.cliSessionId ?? null,
    run.spawnedByCli ?? null,
    run.name ?? null,
    status,
    run.promptSummary ?? null,
    now,
    now,
    source,
    run.evidenceSource ?? null,
    JSON.stringify(metadata),
  );

  const result: SubagentRun = {
    ...run,
    id,
    status,
    source,
    startedAt: now,
    updatedAt: now,
  };
  publishSubagentEvent('subagent:started', result);
  log.info({ id, parentTaskId: run.parentTaskId, status, source }, 'subagent run recorded');
  return result;
}

export function updateSubagentRunStatus(
  id: string,
  status: SubagentStatus,
  extra?: { name?: string; promptSummary?: string; evidenceSource?: string },
): SubagentRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM subagent_runs WHERE id=?').get(id) as SubagentRunRow | undefined;
  if (!row) return null;

  const now = sqlNow();
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  db.prepare(`
    UPDATE subagent_runs
       SET status=?,
           updated_at=?,
           completed_at=CASE WHEN ? THEN ? ELSE NULL END,
           name=COALESCE(?, name),
           prompt_summary=COALESCE(?, prompt_summary),
           evidence_source=COALESCE(?, evidence_source)
     WHERE id=?
  `).run(
    status,
    now,
    isTerminal ? 1 : 0,
    isTerminal ? now : null,
    extra?.name ?? null,
    extra?.promptSummary ?? null,
    extra?.evidenceSource ?? null,
    id,
  );

  const updated = db.prepare('SELECT * FROM subagent_runs WHERE id=?').get(id) as SubagentRunRow;
  const result = rowToRun(updated);
  const eventType: SubagentEventType = isTerminal
    ? status === 'completed' ? 'subagent:completed' : 'subagent:failed'
    : 'subagent:updated';
  publishSubagentEvent(eventType, result);
  return result;
}

export interface ListSubagentRunsOptions {
  activeOnly?: boolean;
  includeRecentSeconds?: number;
  limit?: number;
  parentTaskId?: string;
}

function reconcileStaleNativeRuns(): void {
  const db = getDb();
  db.prepare(`
    UPDATE subagent_runs
       SET status='cancelled', completed_at=datetime('now'), updated_at=datetime('now')
     WHERE source='native'
       AND status IN ('starting','working')
       AND (
         updated_at < datetime('now', '-10 minutes')
         OR (
           updated_at < datetime('now', '-15 seconds')
           AND NOT EXISTS (
             SELECT 1 FROM tasks
              WHERE tasks.id=subagent_runs.parent_task_id
                AND tasks.status IN ('pending','assigned','running','streaming')
           )
         )
       )
  `).run();
}

function buildActiveOrRecentClause(
  statusSql: string,
  options: ListSubagentRunsOptions,
  params: unknown[],
): string | null {
  const activeOnly = options.activeOnly !== false;
  const recentSeconds = Number(options.includeRecentSeconds ?? 0);
  const recentClause = recentSeconds > 0
    ? `updated_at >= datetime('now', '-' || ? || ' seconds')`
    : null;

  if (activeOnly && recentClause) {
    params.push(recentSeconds);
    return `(status IN (${statusSql}) OR ${recentClause})`;
  }
  if (activeOnly) return `status IN (${statusSql})`;
  if (recentClause) {
    params.push(recentSeconds);
    return recentClause;
  }
  return null;
}

export function listSubagentRuns(options: ListSubagentRunsOptions = {}): SubagentRun[] {
  reconcileStaleNativeRuns();
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  const activityClause = buildActiveOrRecentClause("'starting','working'", options, params);
  if (activityClause) where.push(activityClause);
  if (options.parentTaskId) {
    where.push('(parent_task_id=? OR root_task_id=?)');
    params.push(options.parentTaskId, options.parentTaskId);
  }

  const limit = clampLimit(options.limit);
  const sql = `
    SELECT * FROM subagent_runs
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  return (db.prepare(sql).all(...params, limit) as SubagentRunRow[]).map(rowToRun);
}

interface ParentTaskSourceRow {
  id: string;
  parent_task_id: string;
  parent_provider: string | null;
  assigned_to: string | null;
  status: string;
  prompt: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  spawned_by_cli: string | null;
}

function taskStatusToSubagentStatus(status: string): SubagentStatus {
  if (status === 'pending' || status === 'assigned') return 'starting';
  if (status === 'running' || status === 'streaming') return 'working';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

export function findParentTaskSources(options: ListSubagentRunsOptions = {}): SubagentRun[] {
  const db = getDb();
  const where = ['child.parent_task_id IS NOT NULL'];
  const params: unknown[] = [];
  const activeOnly = options.activeOnly !== false;
  const recentSeconds = Number(options.includeRecentSeconds ?? 0);
  if (activeOnly && recentSeconds > 0) {
    where.push(`(
      child.status IN ('pending','assigned','running','streaming')
      OR child.updated_at >= datetime('now', '-' || ? || ' seconds')
    )`);
    params.push(recentSeconds);
  } else if (activeOnly) {
    where.push("child.status IN ('pending','assigned','running','streaming')");
  } else if (recentSeconds > 0) {
    where.push(`child.updated_at >= datetime('now', '-' || ? || ' seconds')`);
    params.push(recentSeconds);
  }
  if (options.parentTaskId) {
    where.push('(child.parent_task_id=? OR child.id=?)');
    params.push(options.parentTaskId, options.parentTaskId);
  }

  const rows = db.prepare(`
    SELECT child.id,
           child.parent_task_id,
           parent.assigned_to AS parent_provider,
           child.assigned_to,
           child.status,
           child.prompt,
           child.created_at,
           child.updated_at,
           child.completed_at,
           child.spawned_by_cli
      FROM tasks child
      LEFT JOIN tasks parent ON parent.id=child.parent_task_id
     WHERE ${where.join(' AND ')}
     ORDER BY child.updated_at DESC
     LIMIT ?
  `).all(...params, clampLimit(options.limit)) as ParentTaskSourceRow[];

  return rows.map(row => ({
    id: row.id,
    parentTaskId: row.parent_task_id,
    rootTaskId: row.parent_task_id,
    parentProvider: row.parent_provider || row.assigned_to || 'unknown',
    spawnedByCli: row.spawned_by_cli ?? undefined,
    externalAgentId: row.id,
    name: row.assigned_to || row.id,
    status: taskStatusToSubagentStatus(row.status),
    promptSummary: row.prompt.slice(0, 200),
    startedAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    source: 'nco-task',
    evidenceSource: 'tasks.parent_task_id',
  }));
}

export function listAllSubagents(options: ListSubagentRunsOptions = {}): SubagentRun[] {
  const combined = [...listSubagentRuns(options), ...findParentTaskSources(options)];
  return combined
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, clampLimit(options.limit));
}

export interface ParsedNativeSubagent {
  externalAgentId: string;
  parentExternalAgentId?: string;
  name: string;
  status: SubagentStatus;
  timestamp: string;
}

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
  timestamp: string;
}

export function parseCodexSessionEvents(input: string): ParsedNativeSubagent[] {
  const calls = new Map<string, PendingCall>();
  const agents = new Map<string, ParsedNativeSubagent>();

  for (const line of input.split(/\r?\n/)) {
    const record = safeJsonObject(line.trim());
    if (!record) continue;
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString();
    const payload = record.type === 'response_item' && isRecord(record.payload)
      ? record.payload
      : record;
    const type = typeof payload.type === 'string' ? payload.type : '';

    if (type === 'function_call') {
      const callId = stringValue(payload.call_id) || stringValue(payload.id);
      const name = stringValue(payload.name);
      const args = parseArguments(payload.arguments);
      if (callId) calls.set(callId, { name, args, timestamp });

      if (name === 'spawn_agent') {
        const requestedName = stringValue(args.task_name) || stringValue(args.name);
        if (requestedName) {
          const externalAgentId = requestedName.startsWith('/') ? requestedName : `/root/${requestedName}`;
          setAgent(agents, externalAgentId, 'starting', timestamp);
        }
      } else if (name === 'followup_task') {
        const target = stringValue(args.target) || stringValue(args.agent_id);
        if (target) setAgent(agents, target, 'working', timestamp);
      } else if (name === 'interrupt_agent') {
        const target = stringValue(args.target) || stringValue(args.agent_id);
        if (target) setAgent(agents, target, 'cancelled', timestamp);
      }
      continue;
    }

    if (type !== 'function_call_output') continue;
    const callId = stringValue(payload.call_id);
    const pending = calls.get(callId);
    const output = parseOutput(payload.output);
    if (!pending || !output) continue;

    if (pending.name === 'spawn_agent') {
      const requestedName = stringValue(pending.args.task_name) || stringValue(pending.args.name);
      const externalAgentId = stringValue(output.task_name)
        || stringValue(output.agent_id)
        || stringValue(output.agentId)
        || (requestedName ? `/root/${requestedName}` : '');
      if (externalAgentId) setAgent(agents, externalAgentId, 'working', timestamp);
    } else if (pending.name === 'list_agents' && Array.isArray(output.agents)) {
      for (const item of output.agents) {
        if (!isRecord(item)) continue;
        const externalAgentId = stringValue(item.agent_name) || stringValue(item.agent_id);
        if (!externalAgentId || externalAgentId === '/root') continue;
        setAgent(agents, externalAgentId, parseCodexAgentStatus(item.agent_status), timestamp);
      }
    } else if (pending.name === 'interrupt_agent') {
      const target = stringValue(pending.args.target) || stringValue(pending.args.agent_id);
      if (target) setAgent(agents, target, 'cancelled', timestamp);
    } else if (pending.name === 'followup_task') {
      const target = stringValue(pending.args.target) || stringValue(pending.args.agent_id);
      if (target) setAgent(agents, target, 'working', timestamp);
    }
  }

  return [...agents.values()];
}

function parseCodexAgentStatus(status: unknown): SubagentStatus {
  if (typeof status === 'string') {
    if (status === 'running' || status === 'working') return 'working';
    if (status === 'cancelled' || status === 'interrupted') return 'cancelled';
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'completed' || status === 'done') return 'completed';
  }
  if (isRecord(status)) {
    if ('completed' in status) return 'completed';
    if ('failed' in status || 'error' in status) return 'failed';
    if ('cancelled' in status || 'interrupted' in status) return 'cancelled';
  }
  return 'working';
}

function setAgent(
  agents: Map<string, ParsedNativeSubagent>,
  externalAgentId: string,
  status: SubagentStatus,
  timestamp: string,
): void {
  const normalized = externalAgentId.startsWith('/') ? externalAgentId : `/root/${externalAgentId}`;
  const parts = normalized.split('/').filter(Boolean);
  const parentExternalAgentId = parts.length > 2 ? `/${parts.slice(0, -1).join('/')}` : undefined;
  const previous = agents.get(normalized);
  agents.set(normalized, {
    externalAgentId: normalized,
    parentExternalAgentId,
    name: parts.at(-1) || normalized,
    status: preserveTerminalStatus(previous?.status, status),
    timestamp,
  });
}

function preserveTerminalStatus(previous: SubagentStatus | undefined, next: SubagentStatus): SubagentStatus {
  if (previous === 'completed' || previous === 'failed' || previous === 'cancelled') return previous;
  return next;
}

export class CodexSubagentTracker {
  private stdoutBuffer = '';
  private cliSessionId?: string;
  private evidenceFile?: string;
  private timer?: NodeJS.Timeout;
  private readonly runIds = new Map<string, string>();

  constructor(
    private readonly parentTaskId: string,
    private readonly parentProvider: string,
  ) {}

  feedStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = safeJsonObject(line.trim());
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
        this.cliSessionId = event.thread_id;
        this.startMonitoring();
      }
    }
  }

  stop(status: 'completed' | 'failed' | 'cancelled'): void {
    if (this.timer) clearInterval(this.timer);
    this.scanEvidence();
    for (const runId of this.runIds.values()) {
      const current = getRun(runId);
      if (current && ACTIVE_NATIVE_STATUSES.includes(current.status as typeof ACTIVE_NATIVE_STATUSES[number])) {
        updateSubagentRunStatus(runId, status);
      }
    }
  }

  private startMonitoring(): void {
    if (this.timer) return;
    this.scanEvidence();
    this.timer = setInterval(() => this.scanEvidence(), 300);
    this.timer.unref();
  }

  private scanEvidence(): void {
    if (!this.cliSessionId) return;
    if (!this.evidenceFile) this.evidenceFile = findCodexSessionFile(this.cliSessionId);
    if (!this.evidenceFile || !existsSync(this.evidenceFile)) return;

    let text: string;
    try {
      text = readFileSync(this.evidenceFile, 'utf8');
    } catch {
      return;
    }

    for (const event of parseCodexSessionEvents(text)) {
      let runId = this.runIds.get(event.externalAgentId);
      if (!runId) {
        const run = recordSubagentRun({
          parentTaskId: this.parentTaskId,
          rootTaskId: this.parentTaskId,
          parentProvider: this.parentProvider,
          cliSessionId: this.cliSessionId,
          spawnedByCli: 'codex',
          externalAgentId: event.externalAgentId,
          parentExternalAgentId: event.parentExternalAgentId,
          name: event.name,
          status: event.status,
          promptSummary: event.name,
          source: 'native',
          evidenceSource: this.evidenceFile,
        });
        runId = run.id;
        this.runIds.set(event.externalAgentId, runId);
      } else {
        const current = getRun(runId);
        if (current && current.status !== event.status) {
          updateSubagentRunStatus(runId, event.status, { evidenceSource: this.evidenceFile });
        }
      }
    }
  }
}

function getRun(id: string): SubagentRun | null {
  const row = getDb().prepare('SELECT * FROM subagent_runs WHERE id=?').get(id) as SubagentRunRow | undefined;
  return row ? rowToRun(row) : null;
}

function findCodexSessionFile(threadId: string): string | undefined {
  const sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const candidates = [new Date(), new Date(Date.now() - 24 * 60 * 60 * 1000)];
  for (const date of candidates) {
    const dir = join(
      sessionsRoot,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    );
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find(name => name.includes(threadId) && name.endsWith('.jsonl'));
    if (file) return join(dir, file);
  }
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  return typeof value === 'string' ? safeJsonObject(value) ?? {} : {};
}

function parseOutput(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  return safeJsonObject(value);
}

function safeJsonObject(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sqlNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function clampLimit(limit: number | undefined): number {
  return limit && limit > 0 ? Math.min(Math.trunc(limit), 500) : 100;
}
