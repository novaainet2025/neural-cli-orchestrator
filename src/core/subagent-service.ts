import { getDb } from '../storage/database.js';
import { eventBus } from './event-bus.js';
import { createSubagentRunId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('subagent-service');

export type SubagentStatus = 'starting' | 'working' | 'completed' | 'failed' | 'cancelled';
export type SubagentSource = 'native' | 'nco-task';

export interface SubagentRun {
  id: string;
  parentTaskId: string;
  rootTaskId?: string;
  parentProvider: string;
  cliSessionId?: string;
  spawnedByCli?: string;
  name?: string;
  status: SubagentStatus;
  promptSummary?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  source: SubagentSource;
  evidenceSource?: string;
}

export interface SubagentRunRow {
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

function rowToRun(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    rootTaskId: row.root_task_id ?? undefined,
    parentProvider: row.parent_provider,
    cliSessionId: row.cli_session_id ?? undefined,
    spawnedByCli: row.spawned_by_cli ?? undefined,
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

export interface ParentTaskSource {
  id: string;
  parentTaskId: string;
  parentProvider: string;
  status: string;
  promptSummary: string;
  startedAt: string;
}

type SubagentEventType = 'subagent:started' | 'subagent:updated' | 'subagent:completed' | 'subagent:failed';

function publishSubagentEvent(type: SubagentEventType, run: SubagentRun): void {
  eventBus.publish({
    type,
    subagentId: run.id,
    parentTaskId: run.parentTaskId,
    rootTaskId: run.rootTaskId,
    parentProvider: run.parentProvider,
    name: run.name,
    status: run.status,
    source: run.source,
  }).catch(err => log.error({ err, type, subagentId: run.id }, 'subagent event publish failed'));
}

export function recordSubagentRun(run: Omit<SubagentRun, 'id' | 'startedAt' | 'updatedAt' | 'status'> & { status?: SubagentStatus }): SubagentRun {
  const db = getDb();
  const id = createSubagentRunId();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const status = run.status || 'starting';
  const source = run.source || 'native';

  db.prepare(`
    INSERT INTO subagent_runs (id, parent_task_id, root_task_id, parent_provider, cli_session_id, spawned_by_cli, name, status, prompt_summary, started_at, updated_at, source, evidence_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    now, now,
    source,
    run.evidenceSource ?? null,
  );

  const result: SubagentRun = {
    id, ...run, status, source,
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

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';

  db.prepare(`
    UPDATE subagent_runs SET status=?, updated_at=?, completed_at=COALESCE(?, completed_at), name=COALESCE(?, name), prompt_summary=COALESCE(?, prompt_summary), evidence_source=COALESCE(?, evidence_source)
    WHERE id=?
  `).run(
    status, now,
    isTerminal ? now : null,
    extra?.name ?? null,
    extra?.promptSummary ?? null,
    extra?.evidenceSource ?? null,
    id,
  );

  const updated = db.prepare('SELECT * FROM subagent_runs WHERE id=?').get(id) as SubagentRunRow;
  const result = rowToRun(updated);

  const eventType: SubagentEventType = isTerminal
    ? (status === 'completed' ? 'subagent:completed' : 'subagent:failed')
    : 'subagent:updated';
  publishSubagentEvent(eventType, result);

  log.info({ id, status }, 'subagent run status updated');
  return result;
}

export function getSubagentRun(id: string): SubagentRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM subagent_runs WHERE id=?').get(id) as SubagentRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export interface ListSubagentRunsOptions {
  activeOnly?: boolean;
  includeRecentSeconds?: number;
  limit?: number;
  parentTaskId?: string;
}

export function listSubagentRuns(options: ListSubagentRunsOptions = {}): SubagentRun[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.activeOnly !== false) {
    where.push("status IN ('starting','working')");
  }

  if (options.includeRecentSeconds && options.includeRecentSeconds > 0) {
    where.push(`updated_at >= datetime('now', '-' || ? || ' seconds')`);
    params.push(options.includeRecentSeconds);
  }

  if (options.parentTaskId) {
    where.push('(parent_task_id=? OR root_task_id=?)');
    params.push(options.parentTaskId, options.parentTaskId);
  }

  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 500) : 100;
  const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM subagent_runs${whereClause} ORDER BY updated_at DESC LIMIT ?`;

  const rows = db.prepare(sql).all(...params, limit) as SubagentRunRow[];
  return rows.map(rowToRun);
}

export interface ParentTaskSourceRow {
  id: string;
  parent_task_id: string;
  assigned_to: string;
  status: string;
  prompt: string;
  created_at: string;
}

export function findParentTaskSources(activeOnly?: boolean, includeRecentSeconds?: number, limit?: number): ParentTaskSource[] {
  const db = getDb();
  const where: string[] = ["parent_task_id IS NOT NULL"];
  const params: unknown[] = [];

  if (activeOnly !== false) {
    where.push("status IN ('running','streaming','assigned','pending')");
  }

  if (includeRecentSeconds && includeRecentSeconds > 0) {
    where.push(`updated_at >= datetime('now', '-' || ? || ' seconds')`);
    params.push(includeRecentSeconds);
  }

  const l = limit && limit > 0 ? Math.min(limit, 500) : 100;
  const sql = `SELECT id, parent_task_id, assigned_to, status, prompt, created_at FROM tasks${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;

  const rows = db.prepare(sql).all(...params, l) as ParentTaskSourceRow[];
  return rows.map(r => ({
    id: r.id,
    parentTaskId: r.parent_task_id,
    parentProvider: r.assigned_to || 'unknown',
    status: r.status,
    promptSummary: r.prompt.slice(0, 200),
    startedAt: r.created_at,
  }));
}

export interface SubagentView {
  subagentRuns: SubagentRun[];
  parentTaskSources: ParentTaskSource[];
}

export function listAllSubagentViews(options: ListSubagentRunsOptions = {}): SubagentView {
  return {
    subagentRuns: listSubagentRuns(options),
    parentTaskSources: findParentTaskSources(options.activeOnly, options.includeRecentSeconds, options.limit),
  };
}

// ─── Codex JSONL parser ────────────────

export interface CodexSubagentEvent {
  agentId: string;
  nickname?: string;
  type: 'spawned' | 'waiting' | 'followup' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  timestamp: string;
}

export function parseCodexJsonlEvents(stdout: string): CodexSubagentEvent[] {
  const events: CodexSubagentEvent[] = [];
  const spawnMap = new Map<string, string>(); // call_id → agent_id

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed?.type !== 'function_call' && parsed?.type !== 'function_call_output') continue;

    const ts = (parsed.timestamp as string) || new Date().toISOString();
    const callId = parsed.call_id as string || '';

    if (parsed.type === 'function_call') {
      const funcName = (parsed.name as string) || (parsed.function?.name as string) || '';
      const args = typeof parsed.arguments === 'object'
        ? (parsed.arguments as Record<string, unknown>)
        : (typeof parsed.arguments === 'string' ? safeJsonParseObj(parsed.arguments) : {});

      if (funcName === 'spawn_agent') {
        const agentId = (args.agent_id || args.agentId || args.id || '') as string;
        if (agentId) {
          spawnMap.set(callId, agentId);
          events.push({
            agentId,
            nickname: args.nickname as string || args.name as string || undefined,
            type: 'spawned',
            timestamp: ts,
          });
        }
      } else if (funcName === 'wait_agent') {
        const agentId = (args.agent_id || args.agentId || args.id || spawnMap.get(callId) || '') as string;
        if (agentId) {
          events.push({ agentId, type: 'waiting', timestamp: ts });
        }
      } else if (funcName === 'followup_task') {
        const agentId = (args.agent_id || args.agentId || args.id || spawnMap.get(callId) || '') as string;
        if (agentId) {
          events.push({ agentId, type: 'followup', timestamp: ts });
        }
      } else if (funcName === 'interrupt_agent') {
        const agentId = (args.agent_id || args.agentId || args.id || spawnMap.get(callId) || '') as string;
        if (agentId) {
          events.push({ agentId, type: 'interrupted', timestamp: ts });
        }
      }
    } else if (parsed.type === 'function_call_output') {
      const output = typeof parsed.output === 'string' ? parsed.output : '';
      // Match spawn_agent output: {"agent_id":"...","nickname":"..."}
      const outputObj = safeJsonParseObj(output);
      if (outputObj && (outputObj.agent_id || outputObj.agentId)) {
        const agentId = (outputObj.agent_id || outputObj.agentId) as string;
        // Map from call_id to agent_id for linking call_output to spawn
        spawnMap.set(callId, agentId);
      }
    }
  }

  return events;
}

function safeJsonParseObj(str: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

// ─── Claude Code subagent text parser (fallback) ────────────────

const CLAUDE_SUBAGENT_START_RE = /(?:🔄|→|starting|spawning|launching)\s*(?:sub-?agent|child|worker)\s*(?::\s*)?([^\n]+)/i;
const CLAUDE_SUBAGENT_DONE_RE = /(?:✅|✓|✔|completed|finished|done)\s*(?:sub-?agent|child|worker)\s*(?::\s*)?([^\n]+)/i;
const CLAUDE_SUBAGENT_FAIL_RE = /(?:❌|✗|failed|error)\s*(?:sub-?agent|child|worker)\s*(?::\s*)?([^\n]+)/i;

export interface ClaudeSubagentEvent {
  name: string;
  type: 'started' | 'completed' | 'failed';
  line: string;
}

export function parseClaudeCodeSubagentText(text: string): ClaudeSubagentEvent[] {
  const events: ClaudeSubagentEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const startMatch = trimmed.match(CLAUDE_SUBAGENT_START_RE);
    if (startMatch) {
      events.push({ name: startMatch[1].trim(), type: 'started', line: trimmed });
      continue;
    }

    const doneMatch = trimmed.match(CLAUDE_SUBAGENT_DONE_RE);
    if (doneMatch) {
      events.push({ name: doneMatch[1].trim(), type: 'completed', line: trimmed });
      continue;
    }

    const failMatch = trimmed.match(CLAUDE_SUBAGENT_FAIL_RE);
    if (failMatch) {
      events.push({ name: failMatch[1].trim(), type: 'failed', line: trimmed });
    }
  }
  return events;
}
