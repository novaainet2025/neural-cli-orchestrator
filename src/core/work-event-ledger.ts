import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { createEventId } from '../utils/id.js';
import type { NCOEvent } from './types.js';

const log = createLogger('work-event-ledger');

export const WORK_EVENT_CATEGORIES = [
  'work',
  'success',
  'failure',
  'improvement',
  'context',
  'issue',
  'conflict',
  'error',
  'bug',
  'worktree',
  'git',
  'regression',
] as const;

export const WORK_EVENT_SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical'] as const;
export const WORK_EVENT_OUTCOMES = ['observed', 'started', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;

export type WorkEventCategory = typeof WORK_EVENT_CATEGORIES[number];
export type WorkEventSeverity = typeof WORK_EVENT_SEVERITIES[number];
export type WorkEventOutcome = typeof WORK_EVENT_OUTCOMES[number];

export interface WorkEventInput {
  id?: string;
  eventKey?: string;
  source: string;
  sourceEventId?: string | null;
  category?: WorkEventCategory;
  eventType: string;
  severity?: WorkEventSeverity;
  outcome?: WorkEventOutcome;
  title: string;
  summary?: string | null;
  detail?: unknown;
  evidence?: unknown;
  taskId?: string | null;
  workReportId?: string | null;
  improvementNoteId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  occurredAt?: string | number | Date;
}

export interface WorkEventRecord {
  id: string;
  eventKey: string;
  source: string;
  sourceEventId: string | null;
  category: WorkEventCategory;
  eventType: string;
  severity: WorkEventSeverity;
  outcome: WorkEventOutcome;
  title: string;
  summary: string | null;
  detail: unknown;
  evidence: unknown;
  taskId: string | null;
  workReportId: string | null;
  improvementNoteId: string | null;
  agentId: string | null;
  sessionId: string | null;
  projectPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  commitSha: string | null;
  occurredAt: string;
  recordedAt: string;
  previousHash: string | null;
  contentHash: string;
}

const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashWorkEvent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function redactSensitive(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return SECRET_VALUE_PATTERNS.reduce(
      (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]),
    );
  }
  return value;
}

function toIso(value: WorkEventInput['occurredAt']): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function classifyWorkEvent(eventType: string): WorkEventCategory {
  const type = eventType.toLowerCase();
  if (/(?:merge[_:-]?conflict|conflict|lease[_:-]?(?:denied|collision))/.test(type)) return 'conflict';
  if (/regression/.test(type)) return 'regression';
  if (/(?:bug|defect)/.test(type)) return 'bug';
  if (/worktree/.test(type)) return 'worktree';
  if (/(?:^|[:_-])git(?:$|[:_-])|commit|push|merge|rebase|checkout/.test(type)) return 'git';
  if (/improv|learning|lesson|retrospective/.test(type)) return 'improvement';
  if (/context|handoff|session|discussion|decision/.test(type)) return 'context';
  if (/error/.test(type)) return 'error';
  if (/fail|timed?[_:-]?out|cancel|expired|reject|blocked|rate[_:-]?limit/.test(type)) return 'failure';
  if (/complete|success|succeed|approve|resolved|verified|passed/.test(type)) return 'success';
  if (/issue|warn|risk|incident/.test(type)) return 'issue';
  return 'work';
}

export function inferWorkEventOutcome(eventType: string): WorkEventOutcome {
  const type = eventType.toLowerCase();
  if (/cancel/.test(type)) return 'cancelled';
  if (/blocked|conflict|reject|rate[_:-]?limit/.test(type)) return 'blocked';
  if (/fail|error|timed?[_:-]?out|expired|regression/.test(type)) return 'failed';
  if (/complete|success|succeed|approve|resolved|verified|passed|commit|push/.test(type)) return 'succeeded';
  if (/start|created|queued|assigned|running/.test(type)) return 'started';
  return 'observed';
}

export function inferWorkEventSeverity(
  category: WorkEventCategory,
  outcome: WorkEventOutcome,
): WorkEventSeverity {
  if (category === 'error' || outcome === 'failed') return 'error';
  if (category === 'conflict' || category === 'regression' || outcome === 'blocked') return 'warning';
  return 'info';
}

function rowToRecord(row: Record<string, unknown>): WorkEventRecord {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    source: String(row.source),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    category: row.category as WorkEventCategory,
    eventType: String(row.event_type),
    severity: row.severity as WorkEventSeverity,
    outcome: row.outcome as WorkEventOutcome,
    title: String(row.title),
    summary: row.summary == null ? null : String(row.summary),
    detail: JSON.parse(String(row.detail_json)),
    evidence: JSON.parse(String(row.evidence_json)),
    taskId: row.task_id == null ? null : String(row.task_id),
    workReportId: row.work_report_id == null ? null : String(row.work_report_id),
    improvementNoteId: row.improvement_note_id == null ? null : String(row.improvement_note_id),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    projectPath: row.project_path == null ? null : String(row.project_path),
    worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
    branch: row.branch == null ? null : String(row.branch),
    commitSha: row.commit_sha == null ? null : String(row.commit_sha),
    occurredAt: String(row.occurred_at),
    recordedAt: String(row.recorded_at),
    previousHash: row.previous_hash == null ? null : String(row.previous_hash),
    contentHash: String(row.content_hash),
  };
}

export function recordWorkEvent(
  input: WorkEventInput,
  database: Database.Database = getDb(),
): WorkEventRecord {
  const requestedId = input.id?.trim() || createEventId();
  const sourceEventId = input.sourceEventId?.trim() || null;
  const eventKey = input.eventKey?.trim() || `${input.source}:${sourceEventId ?? requestedId}`;
  const category = input.category ?? classifyWorkEvent(input.eventType);
  const outcome = input.outcome ?? inferWorkEventOutcome(input.eventType);
  const severity = input.severity ?? inferWorkEventSeverity(category, outcome);
  const occurredAt = toIso(input.occurredAt);
  const detail = redactSensitive(input.detail ?? {});
  const evidence = redactSensitive(input.evidence ?? []);
  const summary = input.summary == null
    ? null
    : String(redactSensitive(input.summary)).trim() || null;
  const title = String(redactSensitive(input.title)).trim() || input.eventType;

  const insert = () => {
    const existing = database.prepare(
      'SELECT * FROM work_events WHERE event_key=?',
    ).get(eventKey) as Record<string, unknown> | undefined;
    if (existing) return rowToRecord(existing);

    // A legacy/backfill path can carry the same source event ID with a
    // different idempotency key. Re-key the ledger row instead of dropping
    // either observation on the primary-key collision.
    const idCollision = database.prepare(
      'SELECT event_key FROM work_events WHERE id=?',
    ).get(requestedId) as { event_key: string } | undefined;
    const id = idCollision ? createEventId() : requestedId;
    const previous = database.prepare(
      'SELECT content_hash FROM work_events ORDER BY rowid DESC LIMIT 1',
    ).get() as { content_hash: string } | undefined;
    const previousHash = previous?.content_hash ?? null;
    const hashPayload = stableJson({
      id,
      eventKey,
      source: input.source,
      sourceEventId,
      category,
      eventType: input.eventType,
      severity,
      outcome,
      title,
      summary,
      detail,
      evidence,
      taskId: input.taskId ?? null,
      workReportId: input.workReportId ?? null,
      improvementNoteId: input.improvementNoteId ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      projectPath: input.projectPath ?? null,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      commitSha: input.commitSha ?? null,
      occurredAt,
      previousHash,
    });
    const contentHash = hashWorkEvent(hashPayload);

    database.prepare(`
      INSERT INTO work_events (
        id, event_key, source, source_event_id, category, event_type,
        severity, outcome, title, summary, detail_json, evidence_json,
        task_id, work_report_id, improvement_note_id, agent_id, session_id,
        project_path, worktree_path, branch, commit_sha, occurred_at,
        previous_hash, content_hash
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      id,
      eventKey,
      input.source,
      sourceEventId,
      category,
      input.eventType,
      severity,
      outcome,
      title,
      summary,
      stableJson(detail),
      stableJson(evidence),
      input.taskId ?? null,
      input.workReportId ?? null,
      input.improvementNoteId ?? null,
      input.agentId ?? null,
      input.sessionId ?? null,
      input.projectPath ?? null,
      input.worktreePath ?? null,
      input.branch ?? null,
      input.commitSha ?? null,
      occurredAt,
      previousHash,
      contentHash,
    );
    return rowToRecord(database.prepare('SELECT * FROM work_events WHERE id=?').get(id) as Record<string, unknown>);
  };

  // Bulk backfills already hold one outer transaction. Avoid a SAVEPOINT per
  // historical row while retaining an immediate transaction for normal calls.
  return database.inTransaction
    ? insert()
    : database.transaction(insert).immediate();
}

export function recordWorkEventSafely(
  input: WorkEventInput,
  database: Database.Database = getDb(),
): WorkEventRecord | null {
  try {
    return recordWorkEvent(input, database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fields = {
      eventType: input.eventType,
      source: input.source,
      error: message,
    };
    if (message.includes('no such table: work_events')) {
      log.debug(fields, 'Work event table not available yet');
    } else {
      log.error(fields, 'Work event persistence failed');
    }
    return null;
  }
}

export function recordNcoEvent(
  event: NCOEvent,
  database: Database.Database = getDb(),
): WorkEventRecord | null {
  const agentId = typeof event.agentId === 'string'
    ? event.agentId
    : typeof event.from === 'string'
      ? event.from
      : null;
  const taskId = typeof event.taskId === 'string' ? event.taskId : null;
  const sessionId = typeof event.sessionId === 'string'
    ? event.sessionId
    : typeof event.discussionId === 'string'
      ? event.discussionId
      : null;
  const error = typeof event.error === 'string' ? event.error : null;
  const category = classifyWorkEvent(event.type);

  return recordWorkEventSafely({
    id: event.id,
    eventKey: `event-bus:${event.id}`,
    source: 'event-bus',
    sourceEventId: event.id,
    category,
    eventType: event.type,
    title: event.type,
    summary: error,
    detail: event,
    taskId,
    agentId,
    sessionId,
    occurredAt: event.timestamp,
  }, database);
}

export interface ListWorkEventsOptions {
  category?: WorkEventCategory;
  taskId?: string;
  source?: string;
  from?: string;
  to?: string;
  beforeId?: string;
  limit?: number;
}

export function listWorkEvents(
  options: ListWorkEventsOptions = {},
  database: Database.Database = getDb(),
): WorkEventRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.category) {
    clauses.push('category=?');
    params.push(options.category);
  }
  if (options.taskId) {
    clauses.push('task_id=?');
    params.push(options.taskId);
  }
  if (options.source) {
    clauses.push('source=?');
    params.push(options.source);
  }
  if (options.from) {
    clauses.push('occurred_at>=?');
    params.push(toIso(options.from));
  }
  if (options.to) {
    clauses.push('occurred_at<=?');
    params.push(toIso(options.to));
  }
  if (options.beforeId) {
    clauses.push(`rowid < COALESCE((SELECT rowid FROM work_events WHERE id=?), 9223372036854775807)`);
    params.push(options.beforeId);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT *
    FROM work_events
    ${where}
    ORDER BY rowid DESC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}
