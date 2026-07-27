import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type Database from 'better-sqlite3';
import { closeDb, getDb, runMigrations } from '../src/storage/database.js';
import {
  hashWorkEvent,
  recordWorkEventSafely,
  redactSensitive,
  stableJson,
} from '../src/core/work-event-ledger.js';

const DEFAULT_VAULT = '/Users/nova-ai/obsidian/mac-obsidian';
const DEFAULT_REPOSITORIES = [
  resolve(process.cwd()),
  DEFAULT_VAULT,
];
const KST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface SqlRow {
  [key: string]: unknown;
}

interface ExportStats {
  tasks: number;
  reports: number;
  improvements: number;
  journalDays: number;
  skipped: number;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name));
}

function parseJson(value: unknown, fallback: unknown = {}): unknown {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return { invalidJson: true, raw: value };
  }
}

function clean(value: unknown): unknown {
  return redactSensitive(value);
}

function text(value: unknown): string {
  if (value == null) return '';
  const redacted = clean(String(value));
  return String(redacted).replaceAll('```', '``\\`');
}

function yaml(value: unknown): string {
  return JSON.stringify(text(value));
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function writeIfChanged(
  db: Database.Database,
  targetKey: string,
  path: string,
  content: string,
  stats: ExportStats,
): boolean {
  const hash = contentHash(content);
  const current = db.prepare(
    'SELECT content_hash, target_path FROM work_event_export_state WHERE target_key=?',
  ).get(targetKey) as { content_hash: string; target_path: string } | undefined;
  if (
    current?.content_hash === hash
    && current.target_path === path
    && existsSync(path)
  ) {
    stats.skipped++;
    return false;
  }
  writeAtomic(path, content);
  db.prepare(`
    INSERT INTO work_event_export_state (target_key, content_hash, target_path, exported_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(target_key) DO UPDATE SET
      content_hash=excluded.content_hash,
      target_path=excluded.target_path,
      exported_at=excluded.exported_at
  `).run(targetKey, hash, path);
  return true;
}

function normalizeOccurredAt(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value;
}

function backfillAgentActions(db: Database.Database): number {
  if (!hasTable(db, 'agent_actions')) return 0;
  const rows = db.prepare(
    'SELECT * FROM agent_actions ORDER BY created_at ASC, rowid ASC',
  ).all() as SqlRow[];
  const alreadyRecorded = db.prepare(
    'SELECT 1 FROM work_events WHERE id=? OR event_key=? LIMIT 1',
  );
  for (const row of rows) {
    // New EventBus writes reach work_events and the legacy agent_actions index
    // in the same publish call. The backfill must recognize either identity so
    // it does not report a false collision or duplicate the event.
    if (alreadyRecorded.get(String(row.id), `agent-action:${row.id}`)) continue;
    const detail = parseJson(row.detail_json, row);
    recordWorkEventSafely({
      id: String(row.id),
      eventKey: `agent-action:${row.id}`,
      source: 'agent-actions-backfill',
      sourceEventId: String(row.id),
      eventType: String(row.action_type ?? 'action:unknown'),
      title: String(row.action_type ?? 'Agent action'),
      detail,
      taskId: row.task_id == null ? null : String(row.task_id),
      agentId: row.agent_id == null ? null : String(row.agent_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      occurredAt: normalizeOccurredAt(row.created_at),
    }, db);
  }
  return rows.length;
}

function backfillTasks(db: Database.Database): number {
  if (!hasTable(db, 'tasks')) return 0;
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as SqlRow[];
  for (const row of rows) {
    const taskId = String(row.id);
    const status = String(row.status ?? 'unknown');
    const updatedAt = String(row.updated_at ?? row.created_at ?? '');
    const error = row.error == null ? null : String(row.error);
    recordWorkEventSafely({
      eventKey: `task-snapshot:${taskId}:${status}:${updatedAt}`,
      source: 'tasks-backfill',
      sourceEventId: taskId,
      eventType: `task:${status}`,
      title: `Task ${taskId}: ${status}`,
      summary: error,
      detail: {
        mode: row.mode,
        status,
        priority: row.priority,
        workspaceId: row.workspace_id,
        parentTaskId: row.parent_task_id,
        metadata: parseJson(row.metadata_json),
        error,
        responseBytes: row.response == null ? 0 : Buffer.byteLength(String(row.response)),
      },
      evidence: parseJson(row.evidence_json, []),
      taskId,
      agentId: row.assigned_to == null ? null : String(row.assigned_to),
      occurredAt: normalizeOccurredAt(row.updated_at ?? row.created_at),
    }, db);
  }
  return rows.length;
}

function backfillImprovementNotes(db: Database.Database): number {
  if (!hasTable(db, 'improvement_notes')) return 0;
  const rows = db.prepare(
    'SELECT * FROM improvement_notes ORDER BY timestamp ASC, rowid ASC',
  ).all() as SqlRow[];
  for (const row of rows) {
    recordWorkEventSafely({
      eventKey: `improvement-note:${row.id}`,
      source: 'improvement-notes-backfill',
      sourceEventId: String(row.id),
      category: 'improvement',
      eventType: 'improvement:recorded',
      severity: String(row.severity ?? 'info') === 'critical'
        ? 'critical'
        : String(row.severity ?? 'info') === 'high'
          ? 'error'
          : 'info',
      title: String(row.problem ?? `Improvement ${row.id}`),
      summary: row.fix == null ? null : String(row.fix),
      detail: row,
      evidence: row.verified_at ? [{ verifiedAt: row.verified_at }] : [],
      improvementNoteId: String(row.id),
      agentId: row.agent == null ? null : String(row.agent),
      occurredAt: normalizeOccurredAt(row.timestamp),
    }, db);
  }
  return rows.length;
}

function backfillLearningEvents(db: Database.Database): number {
  if (!hasTable(db, 'learning_events')) return 0;
  const rows = db.prepare(
    'SELECT * FROM learning_events ORDER BY created_at ASC, id ASC',
  ).all() as SqlRow[];
  for (const row of rows) {
    recordWorkEventSafely({
      eventKey: `learning-event:${row.id}`,
      source: 'learning-events-backfill',
      sourceEventId: String(row.id),
      category: 'improvement',
      eventType: `learning:${String(row.event_type ?? 'observed')}`,
      title: `Learning event: ${String(row.event_type ?? 'observed')}`,
      summary: row.pattern == null ? null : String(row.pattern),
      detail: {
        context: parseJson(row.context, row.context),
        autoApplied: Boolean(row.auto_applied),
      },
      agentId: row.agent_id == null ? null : String(row.agent_id),
      occurredAt: normalizeOccurredAt(row.created_at),
    }, db);
  }
  return rows.length;
}

function backfillWorkReports(db: Database.Database): number {
  if (!hasTable(db, 'work_reports')) return 0;
  const rows = db.prepare(
    'SELECT * FROM work_reports ORDER BY created_at ASC, rowid ASC',
  ).all() as SqlRow[];
  for (const row of rows) {
    const reportId = String(row.id);
    const status = String(row.status ?? 'unknown');
    recordWorkEventSafely({
      eventKey: `work-report:${reportId}:${status}:${String(row.updated_at ?? '')}`,
      source: 'work-reports-backfill',
      sourceEventId: reportId,
      eventType: `work-report:${status}`,
      title: String(row.title ?? `Work report ${reportId}`),
      summary: row.body_md == null ? null : String(row.body_md).slice(0, 2_000),
      detail: {
        reportDate: row.report_date,
        reportSlot: row.report_slot,
        reportKind: row.report_kind,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        status,
        latenessMinutes: row.lateness_minutes,
        summary: parseJson(row.summary_json),
      },
      taskId: row.source_task_id == null ? null : String(row.source_task_id),
      workReportId: reportId,
      occurredAt: normalizeOccurredAt(row.updated_at ?? row.created_at),
    }, db);
  }
  return rows.length;
}

function backfillDecisionLog(db: Database.Database): number {
  if (!hasTable(db, 'decision_log')) return 0;
  const rows = db.prepare(
    'SELECT * FROM decision_log ORDER BY created_at ASC, rowid ASC',
  ).all() as SqlRow[];
  for (const row of rows) {
    recordWorkEventSafely({
      eventKey: `decision-log:${row.id}`,
      source: 'decision-log-backfill',
      sourceEventId: String(row.id),
      category: 'context',
      eventType: 'decision:recorded',
      title: String(row.decision ?? `Decision ${row.id}`),
      summary: row.reason == null ? null : String(row.reason),
      detail: row,
      evidence: row.evidence_tier ? [{ tier: row.evidence_tier }] : [],
      taskId: row.task_id == null ? null : String(row.task_id),
      agentId: row.actor == null ? null : String(row.actor),
      occurredAt: normalizeOccurredAt(row.created_at),
    }, db);
  }
  return rows.length;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    code: result.status,
  };
}

function gitDirectory(cwd: string): string | null {
  const result = runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  return result.ok ? result.stdout : null;
}

function operationState(gitDir: string | null): string[] {
  if (!gitDir) return [];
  return [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
  ].filter(([path]) => existsSync(join(gitDir, path))).map(([, state]) => state);
}

function scanRepository(db: Database.Database, repository: string): void {
  if (!existsSync(repository)) return;
  const root = runGit(repository, ['rev-parse', '--show-toplevel']);
  if (!root.ok) {
    recordWorkEventSafely({
      eventKey: `git-error:${contentHash(`${repository}:${root.stderr}`)}`,
      source: 'git-scanner',
      category: 'error',
      eventType: 'git:repository_error',
      severity: 'error',
      outcome: 'failed',
      title: `Git repository scan failed: ${repository}`,
      summary: root.stderr || `exit ${root.code}`,
      detail: { repository, command: 'git rev-parse --show-toplevel', exitCode: root.code },
      projectPath: repository,
    }, db);
    return;
  }

  const repoRoot = root.stdout;
  const status = runGit(repoRoot, ['status', '--porcelain=v2', '--branch']);
  const worktrees = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const conflicts = runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  const head = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const branch = runGit(repoRoot, ['branch', '--show-current']);
  const upstream = runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const divergence = upstream.ok
    ? runGit(repoRoot, ['rev-list', '--left-right', '--count', `${upstream.stdout}...HEAD`])
    : { ok: false, stdout: '', stderr: upstream.stderr, code: upstream.code };
  const name = runGit(repoRoot, ['config', '--get', 'user.name']);
  const email = runGit(repoRoot, ['config', '--get', 'user.email']);
  const operations = operationState(gitDirectory(repoRoot));
  const dirtyLines = status.stdout.split('\n')
    .filter(line => line && !line.startsWith('#'));
  const conflictFiles = conflicts.stdout.split('\n').filter(Boolean);
  const divergenceParts = divergence.stdout.split(/\s+/).map(Number);
  const state = {
    repository: repoRoot,
    head: head.stdout || null,
    branch: branch.stdout || '(detached)',
    upstream: upstream.ok ? upstream.stdout : null,
    behind: Number.isFinite(divergenceParts[0]) ? divergenceParts[0] : null,
    ahead: Number.isFinite(divergenceParts[1]) ? divergenceParts[1] : null,
    dirty: dirtyLines,
    conflicts: conflictFiles,
    operations,
    worktrees: worktrees.stdout,
    gitIdentity: {
      hasName: name.ok && Boolean(name.stdout),
      hasEmail: email.ok && Boolean(email.stdout),
    },
  };
  const commandFailures = [
    ['git status --porcelain=v2 --branch', status],
    ['git worktree list --porcelain', worktrees],
    ['git diff --name-only --diff-filter=U', conflicts],
    ['git rev-parse HEAD', head],
    ['git branch --show-current', branch],
  ].filter(([, result]) => !(result as ReturnType<typeof runGit>).ok);
  const stateHash = hashWorkEvent(stableJson(state));
  const sourceKey = `git:${repoRoot}`;
  const previous = db.prepare(
    'SELECT state_hash, state_json, observed_at FROM work_event_source_state WHERE source_key=?',
  ).get(sourceKey) as { state_hash: string; state_json: string; observed_at: string } | undefined;
  const previousState = previous
    ? parseJson(previous.state_json) as { conflicts?: unknown[]; operations?: unknown[] }
    : null;

  if (previous?.state_hash !== stateHash) {
    recordWorkEventSafely({
      eventKey: `git-snapshot:${repoRoot}:${stateHash}`,
      source: 'git-scanner',
      category: dirtyLines.length > 0 ? 'worktree' : 'git',
      eventType: dirtyLines.length > 0 ? 'worktree:dirty' : 'worktree:clean',
      severity: conflictFiles.length > 0 || operations.length > 0 ? 'warning' : 'info',
      outcome: conflictFiles.length > 0 ? 'blocked' : 'observed',
      title: `${basename(repoRoot)} worktree ${dirtyLines.length > 0 ? 'dirty' : 'clean'}`,
      summary: `${dirtyLines.length} changed, ${conflictFiles.length} conflict(s), ${operations.length} Git operation(s)`,
      detail: state,
      evidence: [
        { command: 'git status --porcelain=v2 --branch', exitCode: status.code },
        { command: 'git worktree list --porcelain', exitCode: worktrees.code },
      ],
      projectPath: repoRoot,
      worktreePath: repoRoot,
      branch: branch.stdout || null,
      commitSha: head.stdout || null,
    }, db);
  }

  if (conflictFiles.length > 0 || operations.length > 0) {
    recordWorkEventSafely({
      eventKey: `git-conflict:${repoRoot}:${stateHash}`,
      source: 'git-scanner',
      category: 'conflict',
      eventType: 'git:merge_conflict',
      severity: 'error',
      outcome: 'blocked',
      title: `${basename(repoRoot)} Git conflict or incomplete operation`,
      summary: [...operations, ...conflictFiles].join(', '),
      detail: { operations, conflictFiles, status: status.stdout },
      projectPath: repoRoot,
      worktreePath: repoRoot,
      branch: branch.stdout || null,
      commitSha: head.stdout || null,
    }, db);
  }

  if (
    ((previousState?.conflicts?.length ?? 0) > 0 || (previousState?.operations?.length ?? 0) > 0)
    && conflictFiles.length === 0
    && operations.length === 0
  ) {
    recordWorkEventSafely({
      // Include the preceding observation so a later, identical
      // conflict→clean transition remains a distinct historical event.
      eventKey: `git-conflict-resolved:${repoRoot}:${previous?.state_hash}:${stateHash}:${previous?.observed_at}`,
      source: 'git-scanner',
      category: 'conflict',
      eventType: 'git:conflict_resolved',
      severity: 'info',
      outcome: 'succeeded',
      title: `${basename(repoRoot)} Git conflict resolved`,
      summary: 'Previously observed conflict or incomplete Git operation is no longer present',
      detail: { previous: previousState, current: state },
      evidence: [{ command: 'git diff --name-only --diff-filter=U', exitCode: conflicts.code }],
      projectPath: repoRoot,
      worktreePath: repoRoot,
      branch: branch.stdout || null,
      commitSha: head.stdout || null,
    }, db);
  }

  if (commandFailures.length > 0) {
    recordWorkEventSafely({
      eventKey: `git-command-error:${repoRoot}:${stateHash}`,
      source: 'git-scanner',
      category: 'error',
      eventType: 'git:scan_command_error',
      severity: 'error',
      outcome: 'failed',
      title: `${basename(repoRoot)} Git scan command failed`,
      summary: commandFailures
        .map(([command, result]) => `${command}: ${(result as ReturnType<typeof runGit>).stderr || `exit ${(result as ReturnType<typeof runGit>).code}`}`)
        .join('; '),
      detail: Object.fromEntries(commandFailures.map(([command, result]) => [
        command as string,
        {
          exitCode: (result as ReturnType<typeof runGit>).code,
          stderr: (result as ReturnType<typeof runGit>).stderr,
        },
      ])),
      projectPath: repoRoot,
      worktreePath: repoRoot,
      branch: branch.stdout || null,
      commitSha: head.stdout || null,
    }, db);
  }

  if (!name.ok || !name.stdout || !email.ok || !email.stdout) {
    recordWorkEventSafely({
      eventKey: `git-identity-error:${repoRoot}:${stateHash}`,
      source: 'git-scanner',
      category: 'error',
      eventType: 'git:configuration_error',
      severity: 'error',
      outcome: 'blocked',
      title: `${basename(repoRoot)} Git identity is incomplete`,
      summary: `user.name=${name.ok && name.stdout ? 'set' : 'missing'}, user.email=${email.ok && email.stdout ? 'set' : 'missing'}`,
      detail: { repository: repoRoot, userNameConfigured: Boolean(name.stdout), userEmailConfigured: Boolean(email.stdout) },
      projectPath: repoRoot,
      branch: branch.stdout || null,
      commitSha: head.stdout || null,
    }, db);
  }

  db.prepare(`
    INSERT INTO work_event_source_state (source_key, state_json, state_hash, observed_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(source_key) DO UPDATE SET
      state_json=excluded.state_json,
      state_hash=excluded.state_hash,
      observed_at=excluded.observed_at
  `).run(sourceKey, stableJson(state), stateHash);
}

function backfill(db: Database.Database): Record<string, number> {
  // First import can contain tens of thousands of historical rows. Keep the
  // per-event idempotency/savepoint behavior, but commit the batch once so the
  // initial migration is bounded by CPU rather than one fsync per row.
  return db.transaction(() => ({
    agentActions: backfillAgentActions(db),
    tasks: backfillTasks(db),
    improvements: backfillImprovementNotes(db),
    learning: backfillLearningEvents(db),
    workReports: backfillWorkReports(db),
    decisions: backfillDecisionLog(db),
  })).immediate();
}

function renderJson(value: unknown): string {
  return `\`\`\`json\n${text(JSON.stringify(clean(value), null, 2))}\n\`\`\``;
}

function renderTask(db: Database.Database, row: SqlRow): string {
  const taskId = String(row.id);
  const events = db.prepare(`
    SELECT category, event_type, severity, outcome, title, summary, occurred_at, content_hash
    FROM work_events
    WHERE task_id=?
    ORDER BY occurred_at ASC, rowid ASC
  `).all(taskId) as SqlRow[];
  const reports = hasTable(db, 'work_reports')
    ? db.prepare(`
        SELECT id, status, title, body_md, summary_json, report_date, report_slot, updated_at
        FROM work_reports
        WHERE source_task_id=?
        ORDER BY updated_at ASC
      `).all(taskId) as SqlRow[]
    : [];
  const evidence = parseJson(row.evidence_json, []);

  return `---
nco_id: ${yaml(taskId)}
entity: nco-task
status: ${yaml(row.status)}
agent: ${yaml(row.assigned_to)}
created_at: ${yaml(row.created_at)}
updated_at: ${yaml(row.updated_at)}
completed_at: ${yaml(row.completed_at)}
tags:
  - nco/task
  - nco/status/${fileSafe(String(row.status ?? 'unknown'))}
---
# NCO 작업 — ${text(taskId)}

## 상태

- 상태: \`${text(row.status)}\`
- 에이전트: \`${text(row.assigned_to || 'unassigned')}\`
- 모드: \`${text(row.mode)}\`
- 생성: ${text(row.created_at)}
- 갱신: ${text(row.updated_at)}
- 완료: ${text(row.completed_at || '—')}
- 부모 작업: ${text(row.parent_task_id || '—')}
- 워크스페이스: ${text(row.workspace_id || '—')}

## 프롬프트

${text(row.prompt) || '_없음_'}

## 시스템 프롬프트

${text(row.system_prompt) || '_없음_'}

## 결과

${text(row.response) || '_결과 없음_'}

## 오류

${text(row.error) || '_오류 없음_'}

## 검증 증거

${renderJson(evidence)}

## 메타데이터

${renderJson(parseJson(row.metadata_json))}

## 연결된 작업 보고서

${reports.length > 0
    ? reports.map(report => `### ${text(report.title || report.id)}

- ID: \`${text(report.id)}\`
- 상태: \`${text(report.status)}\`
- 기준일/슬롯: ${text(report.report_date)} / ${text(report.report_slot)}
- 갱신: ${text(report.updated_at)}

${text(report.body_md)}

${renderJson(parseJson(report.summary_json))}`).join('\n\n')
    : '_연결된 작업 보고서 없음_'}

## 이벤트 타임라인

${events.length > 0
    ? events.map(event => `- ${text(event.occurred_at)} · **${text(event.category)}** · \`${text(event.event_type)}\` · ${text(event.title)}${event.summary ? ` — ${text(event.summary)}` : ''} · hash \`${text(String(event.content_hash).slice(0, 12))}\``).join('\n')
    : '_기록된 이벤트 없음_'}

---
_NCO work-event journal 자동 생성. 시크릿은 저장 전에 제거됨._
`;
}

function renderImprovement(row: SqlRow): string {
  return `---
nco_id: ${yaml(row.id)}
entity: nco-improvement
severity: ${yaml(row.severity)}
agent: ${yaml(row.agent)}
created_at: ${yaml(row.timestamp)}
verified_at: ${yaml(row.verified_at)}
tags:
  - nco/improvement
  - nco/severity/${fileSafe(String(row.severity ?? 'unknown'))}
---
# 개선 기록 — ${text(row.id)}

## 문제

${text(row.problem)}

## 근본 원인

${text(row.root_cause) || '_미확인_'}

## 개선 조치

${text(row.fix) || '_미정_'}

## 검증

- 검증 시각: ${text(row.verified_at || '미검증')}
- 담당 에이전트: \`${text(row.agent)}\`
- 분류: \`${text(row.category)}\`
- 심각도: \`${text(row.severity)}\`
- 태그: ${text(row.tags)}

---
_NCO work-event journal 자동 생성._
`;
}

function renderWorkReport(row: SqlRow): string {
  return `---
nco_id: ${yaml(row.id)}
entity: nco-work-report
status: ${yaml(row.status)}
report_date: ${yaml(row.report_date)}
report_slot: ${yaml(row.report_slot)}
subject_id: ${yaml(row.subject_id)}
source_task_id: ${yaml(row.source_task_id)}
tags:
  - nco/work-report
  - nco/status/${fileSafe(String(row.status ?? 'unknown'))}
---
# ${text(row.title || `NCO 작업 보고서 — ${row.id}`)}

## 보고 정보

- ID: \`${text(row.id)}\`
- 상태: \`${text(row.status)}\`
- 종류: \`${text(row.report_kind || 'work')}\`
- 대상: \`${text(row.subject_kind)}:${text(row.subject_id)}\`
- 기준일/슬롯: ${text(row.report_date)} / ${text(row.report_slot)}
- 기한: ${text(row.due_at)}
- 제출: ${text(row.submitted_at || '미제출')}
- 지연: ${text(row.lateness_minutes)}분
- 원본 작업: ${text(row.source_task_id || '—')}

## 본문

${text(row.body_md) || '_본문 없음_'}

## 구조화 요약

${renderJson(parseJson(row.summary_json))}

---
_NCO work-event journal 자동 생성._
`;
}

function kstDate(value: unknown): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? 'unknown-date' : KST_DATE.format(date);
}

function renderJournalDay(date: string, rows: SqlRow[]): string {
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const category = String(row.category);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const counts = Array.from(categoryCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `- ${category}: ${count}`)
    .join('\n');

  return `---
entity: nco-work-event-journal
date: ${yaml(date)}
event_count: ${rows.length}
tags:
  - nco/events
  - nco/date/${date}
---
# NCO 작업 이벤트 — ${date}

## 요약

${counts}

## 전체 이벤트

${rows.map(row => `### ${text(row.occurred_at)} · ${text(row.title)}

- ID: \`${text(row.id)}\`
- 유형: \`${text(row.event_type)}\`
- 분류/심각도/결과: \`${text(row.category)}\` / \`${text(row.severity)}\` / \`${text(row.outcome)}\`
- 소스: \`${text(row.source)}\`
- 작업: ${text(row.task_id || '—')}
- 에이전트/세션: ${text(row.agent_id || '—')} / ${text(row.session_id || '—')}
- 프로젝트/워크트리: ${text(row.project_path || '—')} / ${text(row.worktree_path || '—')}
- 브랜치/커밋: ${text(row.branch || '—')} / ${text(row.commit_sha || '—')}
- 요약: ${text(row.summary || '—')}
- 체인: previous \`${text(String(row.previous_hash ?? '').slice(0, 12) || 'root')}\` → current \`${text(String(row.content_hash).slice(0, 12))}\`

#### 상세

${renderJson(parseJson(row.detail_json))}

#### 증거

${renderJson(parseJson(row.evidence_json, []))}
`).join('\n\n')}

---
_Append-only SQLite 원장에서 생성. 수정은 새 정정 이벤트로 기록._
`;
}

function exportVault(db: Database.Database, vault: string): ExportStats {
  const root = join(vault, '07-SESSIONS', 'NCO-WORK-JOURNAL');
  const improvementsRoot = join(vault, '08-IMPROVEMENTS', 'NCO');
  const reportsRoot = join(root, 'WORK-REPORTS');
  const stats: ExportStats = { tasks: 0, reports: 0, improvements: 0, journalDays: 0, skipped: 0 };

  if (hasTable(db, 'tasks')) {
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as SqlRow[];
    for (const task of tasks) {
      const month = kstDate(task.created_at).slice(0, 7);
      const content = renderTask(db, task);
      const path = join(root, 'TASKS', month, `${fileSafe(String(task.id))}.md`);
      if (writeIfChanged(db, `task:${task.id}`, path, content, stats)) stats.tasks++;
    }
  }

  if (hasTable(db, 'improvement_notes')) {
    const rows = db.prepare('SELECT * FROM improvement_notes ORDER BY timestamp ASC, rowid ASC').all() as SqlRow[];
    for (const row of rows) {
      const content = renderImprovement(row);
      const path = join(improvementsRoot, `${fileSafe(String(row.id))}.md`);
      if (writeIfChanged(db, `improvement:${row.id}`, path, content, stats)) stats.improvements++;
    }
  }

  if (hasTable(db, 'work_reports')) {
    const rows = db.prepare('SELECT * FROM work_reports ORDER BY created_at ASC, rowid ASC').all() as SqlRow[];
    for (const row of rows) {
      const month = String(row.report_date ?? 'unknown').slice(0, 7);
      const content = renderWorkReport(row);
      const path = join(reportsRoot, month, `${fileSafe(String(row.id))}.md`);
      if (writeIfChanged(db, `work-report:${row.id}`, path, content, stats)) stats.reports++;
    }
  }

  const events = db.prepare(
    'SELECT * FROM work_events ORDER BY occurred_at ASC, rowid ASC',
  ).all() as SqlRow[];
  const byDate = new Map<string, SqlRow[]>();
  for (const event of events) {
    const date = kstDate(event.occurred_at);
    const entries = byDate.get(date) ?? [];
    entries.push(event);
    byDate.set(date, entries);
  }
  for (const [date, rows] of byDate) {
    const content = renderJournalDay(date, rows);
    const path = join(root, 'EVENTS', `${date}.md`);
    if (writeIfChanged(db, `events:${date}`, path, content, stats)) stats.journalDays++;
  }

  const categoryRows = db.prepare(`
    SELECT category, COUNT(*) AS count, MAX(occurred_at) AS latest
    FROM work_events
    GROUP BY category
    ORDER BY category
  `).all() as SqlRow[];
  const taskCount = hasTable(db, 'tasks')
    ? (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
    : 0;
  const responseCount = hasTable(db, 'tasks')
    ? (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE response IS NOT NULL AND response<>''").get() as { n: number }).n
    : 0;
  const reportCount = hasTable(db, 'work_reports')
    ? (db.prepare('SELECT COUNT(*) AS n FROM work_reports').get() as { n: number }).n
    : 0;
  const improvementCount = hasTable(db, 'improvement_notes')
    ? (db.prepare('SELECT COUNT(*) AS n FROM improvement_notes').get() as { n: number }).n
    : 0;
  const latest = db.prepare(
    'SELECT occurred_at, content_hash FROM work_events ORDER BY occurred_at DESC, rowid DESC LIMIT 1',
  ).get() as SqlRow | undefined;
  const indexUpdatedAt = latest?.occurred_at || '—';
  const index = `---
entity: nco-work-journal-index
updated_at: ${yaml(indexUpdatedAt)}
tags:
  - nco/index
  - nco/events
---
# NCO 통합 작업 기록

> 성공·실패·개선·맥락·이슈·충돌·에러·버그·워크트리·Git·회귀 이벤트의 장기 원장.

## 커버리지

- 전체 작업: ${taskCount}
- 결과가 있는 작업: ${responseCount}
- 작업 보고서: ${reportCount}
- 개선 기록: ${improvementCount}
- 이벤트 원장: ${events.length}
- 최신 이벤트: ${text(latest?.occurred_at || '—')}
- 최신 체인 해시: \`${text(latest?.content_hash || '—')}\`

## 이벤트 분류

| 분류 | 개수 | 최신 |
|---|---:|---|
${categoryRows.map(row => `| ${text(row.category)} | ${text(row.count)} | ${text(row.latest)} |`).join('\n')}

## 저장 구조

- \`TASKS/YYYY-MM/\`: 작업별 전체 프롬프트·결과·오류·검증·이벤트
- \`EVENTS/YYYY-MM-DD.md\`: 날짜별 전체 이벤트와 증거
- \`WORK-REPORTS/YYYY-MM/\`: 업무·성과·목표 보고서
- \`08-IMPROVEMENTS/NCO/\`: 문제·근본 원인·개선·검증

## 무결성

SQLite \`work_events\`는 UPDATE/DELETE가 차단된 append-only 원장이다. 각 이벤트는 이전 이벤트 해시를 포함하며, 정정은 기존 행 변경이 아니라 새 이벤트로 추가한다.
`;
  writeIfChanged(db, 'journal:index', join(root, 'INDEX.md'), index, stats);
  return stats;
}

function parseRepositories(): string[] {
  const configured = process.env.NCO_JOURNAL_REPOSITORIES
    ?.split(',')
    .map(path => path.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_REPOSITORIES;
}

function main(): void {
  const vault = resolve(process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT);
  if (!isAbsolute(vault)) throw new Error('OBSIDIAN_VAULT_PATH must be absolute');
  if (!existsSync(vault) || !statSync(vault).isDirectory()) {
    throw new Error(`Obsidian vault does not exist: ${vault}`);
  }

  runMigrations();
  const db = getDb();
  const sourceCounts = backfill(db);
  for (const repository of parseRepositories()) scanRepository(db, resolve(repository));
  const stats = exportVault(db, vault);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    vault,
    sourceCounts,
    exported: stats,
    totalEvents: (db.prepare('SELECT COUNT(*) AS n FROM work_events').get() as { n: number }).n,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[nco-work-journal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  closeDb();
}
