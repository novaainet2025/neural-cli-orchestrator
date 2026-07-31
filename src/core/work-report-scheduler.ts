import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';
import { agentManager } from '../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { buildComputerUseObservability, probeComputerUseRuntimeSync } from './computer-use-company.js';
import { allowQueueProviderFailover, listCompanyRuns, resolveExecutor } from './company-orchestrator.js';
import { resolvePreference } from './provider-registry.js';

const log = createLogger('work-report-scheduler');
const KST_OFFSET_HOURS = 9;
const KST_TIMEZONE = 'Asia/Seoul';
const POLL_INTERVAL_MS = 60_000;
const MISSED_GRACE_MS = 30 * 60 * 1000;
// 태스크 발행 간 지연 — 일괄발사가 단일스레드 로컬 LLM 서버(retired-local-provider)를 크래시시킨 실측(2026-07-08 ↺6) 완화
export const TASK_DISPATCH_STAGGER_MS = 5_000;
// 링크 해제(실패)·미발행 보고의 태스크 재발행 상한 (틱당)
const REDISPATCH_LIMIT = 20;
// P0-7: 보고 1건당 재발행 시도 상한 + 지수 백오프 — CB 실패 2,077행이 단 149개 업무보고에서
// 나옴(평균 13.9배, 최다 89회)을 실측. 상한 없이 매 틱 재발행하면 같은 근본원인이 반복
// 카운트되어 실패 통계가 오염된다. attempts>=5면 더 이상 재발행하지 않고(자연스럽게 finalize
// 단계에서 missed로 확정), 시도할 때마다 5분→최대 2시간까지 지수 백오프한다.
const MAX_REDISPATCH_ATTEMPTS = 5;
const REDISPATCH_BACKOFF_BASE_MS = 5 * 60_000;
const REDISPATCH_BACKOFF_MAX_MS = 2 * 60 * 60_000;
const NON_REPORT_EXECUTORS = new Set(['openclaw']);
// 링크 해제 대상 태스크 상태: 이 상태로 끝난 태스크는 업무보고 결과로 수집되지 않고
// source_task_id=NULL로 해제되어 다음 틱 재발행 대상이 된다.
export const UNLINK_TASK_STATUSES = ['failed', 'cancelled', 'timed_out', 'lease_expired'] as const;

// 직렬 발행 게이트: 업무보고 태스크 POST 각각을 순차화한다.
// 최초발행(issueWorkReports), 팀재발행(redispatchUnlinkedTeamReports),
// 회사재발행(redispatchUnlinkedOrgReports), 겹친 API 호출 모두 이 게이트를 통과하며
// 시작 간격 TASK_DISPATCH_STAGGER_MS(5초)를 보장한다.
export class WorkReportDispatchGate {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private hasStarted = false;

  constructor(
    private readonly staggerMs = TASK_DISPATCH_STAGGER_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.hasStarted) {
        const waitMs = Math.max(0, this.staggerMs - (this.now() - this.lastStart));
        if (waitMs > 0) await this.sleep(waitMs);
      }
      this.lastStart = this.now();
      this.hasStarted = true;
      return fn();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const workReportDispatchGate = new WorkReportDispatchGate();

export class WorkReportSchedulerRunGate {
  private running = false;

  async run(fn: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await fn();
      return true;
    } finally {
      this.running = false;
    }
  }
}
// 회사 보고 fallback: 보고서 작성 가능한 등록 실행자만, 우선순위 순.
// knownAgents 임의 순회는 비텍스트 실행자나 보고서 작성에 부적합한 실행자를 고를 수 있다.
const REPORT_CAPABLE_FALLBACK_PRIORITY = [
  'ollama',
  'codex',
  'opencode',
  'claude-code',
  'hermes',
  'cursor-agent',
  'agy',
] as const;

export type WorkReportSlot = 'am' | 'pm';
export type WorkReportStatus = 'pending' | 'submitted' | 'late' | 'missed' | 'waived';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  manager: string | null;
  is_active: number;
}

interface TeamRow {
  id: string;
  organization_id: string | null;
  name: string;
  slug: string;
  lead: string | null;
  charter: string | null;
  is_active: number;
}

export interface SubjectSnapshot {
  organizationId: string | null;
  teamId: string | null;
  orgRootId: string | null;
  orgParentId: string | null;
  orgPath: string;
  orgDepth: number;
  unitLevel: 'company' | 'department' | 'team';
  active: boolean;
}

export interface ReportTaskCandidate {
  reportId: string;
  subjectKind: 'team' | 'organization';
  subjectId: string;
  teamId: string | null;
  organizationId: string | null;
  lead: string;
  prompt: string;
}

type ReportDataDb = ReturnType<typeof getDb>;
type ContextLoader = () => string[];

interface TeamDataRow {
  slug: string;
  lead: string | null;
}

const SUBSTANTIVE_TASK_SLUGS = new Set([
  'content-planning',
  'sns',
  'quality-audit',
  'self-improvement',
]);
const EVOLUTION_LEARNING_TEAM_SLUG = 'gov-evolution-learning';
const EVOLUTION_LEARNING_CONTEXT_FLAG = 'NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT';
const DECISION_COORDINATION_TEAM_SLUG = 'ax-decision-coordination';
const DECISION_COORDINATION_CONTEXT_FLAG = 'NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT';
const VERIFICATION_QUALITY_TEAM_SLUG = 'web-scrape-06-verification-quality';
const VERIFICATION_QUALITY_CONTEXT_FLAG = 'NCO_VERIFICATION_QUALITY_SAMPLE_CONTEXT';
const COMPUTER_USE_CONTROL_TEAM_SLUG = 'computer-use-control';
const COMPUTER_USE_CONTROL_CONTEXT_FLAG = 'NCO_COMPUTER_USE_CONTROL_EVIDENCE_CONTEXT';
const VERIFICATION_UPSTREAM_TEAM_SLUGS = [
  'web-scrape-03-static-implementation',
  'web-scrape-04-dynamic-implementation',
  'web-scrape-05-data-analysis',
] as const;
const SNS_TEAM_SLUGS = new Set(['content-planning', 'sns', 'quality-audit']);

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function compactContextText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength)}…`;
}

function compactNullableContextText(
  value: string | null,
  maxLength: number,
): string {
  if (value == null) return '없음';
  const compacted = compactContextText(value, maxLength);
  return compacted || '공백';
}

function evolutionLearningContextEnabled(): boolean {
  const configured = process.env[EVOLUTION_LEARNING_CONTEXT_FLAG]?.trim().toLowerCase();
  return configured !== '0' && configured !== 'false' && configured !== 'off';
}

function decisionCoordinationContextEnabled(): boolean {
  const configured = process.env[DECISION_COORDINATION_CONTEXT_FLAG]?.trim().toLowerCase();
  return configured !== '0' && configured !== 'false' && configured !== 'off';
}

function verificationQualitySampleContextEnabled(): boolean {
  const configured = process.env[VERIFICATION_QUALITY_CONTEXT_FLAG]?.trim().toLowerCase();
  return configured !== '0' && configured !== 'false' && configured !== 'off';
}

function computerUseControlContextEnabled(): boolean {
  const configured = process.env[COMPUTER_USE_CONTROL_CONTEXT_FLAG]?.trim().toLowerCase();
  return configured !== '0' && configured !== 'false' && configured !== 'off';
}

function loadRepositoryGitContext(): string[] {
  try {
    const projectDir = resolveInternalProjectDir();
    const logOutput = execFileSync(
      'git',
      ['-C', projectDir, 'log', '-5', '--date=iso-strict', '--pretty=format:%h|%ad|%s'],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 },
    ).trim();
    const statusOutput = execFileSync(
      'git',
      ['-C', projectDir, 'status', '--short', '--untracked-files=no'],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 512 * 1024 },
    ).trim();

    const lines: string[] = [];
    if (logOutput) {
      lines.push(`[git] 최근 커밋:\n${logOutput.split('\n').slice(0, 5).join('\n')}`);
    }
    if (statusOutput) {
      const changed = statusOutput.split('\n').filter(Boolean);
      lines.push(`[git] 추적 파일 변경 ${changed.length}건:\n${changed.slice(0, 20).join('\n')}`);
    }
    return lines;
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to collect repository git context');
    return [];
  }
}

function loadSnsBlogContext(): string[] {
  const blogPromoDir = resolve(resolveInternalProjectDir(), 'data/blog-promo');
  try {
    if (!existsSync(blogPromoDir)) return [];

    const lines: string[] = [];
    const lastPostPath = resolve(blogPromoDir, '.last-post');
    if (existsSync(lastPostPath)) {
      const lastPostUrl = compactContextText(readFileSync(lastPostPath, 'utf8'), 500);
      if (lastPostUrl) lines.push(`[blog-promo] 최근 처리 글 URL=${lastPostUrl}`);
    }

    const artifacts = readdirSync(blogPromoDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const path = resolve(blogPromoDir, entry.name);
        return { name: entry.name, path, modifiedAt: statSync(path).mtime };
      })
      .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime())
      .slice(0, 3);

    for (const artifact of artifacts) {
      const heading = readFileSync(artifact.path, 'utf8')
        .split(/\r?\n/)
        .find((line) => /^#\s+/.test(line));
      const title = heading ? compactContextText(heading.replace(/^#\s+/, ''), 200) : '';
      lines.push(
        `[blog-promo] 로컬 산출물=${artifact.name}, 수정=${artifact.modifiedAt.toISOString()}${title ? `, 제목=${title}` : ''}`,
      );
    }
    return lines;
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to collect SNS blog context');
    return [];
  }
}

/**
 * 팀 보고에 넣을 근거 데이터를 읽는다. 모든 값은 현재 SQLite 행, 로컬 파일 또는 git 출력에서만 만든다.
 * 선택 소스가 비었거나 조회에 실패하면 명시적인 무자료 지시를 반환한다.
 */
export function buildTeamDataContext(
  teamId: string,
  database: ReportDataDb = getDb(),
  gitContextLoader: ContextLoader = loadRepositoryGitContext,
  snsContextLoader: ContextLoader = loadSnsBlogContext,
): string {
  const sections: string[] = [];
  const collect = (source: string, reader: () => string[]): void => {
    try {
      sections.push(...reader());
    } catch (error) {
      log.warn({ teamId, source, error: error instanceof Error ? error.message : String(error) }, 'Failed to collect team report data');
    }
  };

  let team: TeamDataRow | undefined;
  collect('teams', () => {
    team = database.prepare('SELECT slug, lead FROM teams WHERE id=?').get(teamId) as TeamDataRow | undefined;
    return [];
  });
  if (!team) return '데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고.';

  collect('tasks', () => {
    const summary = database.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completed,
             COALESCE(SUM(CASE WHEN status IN ('failed','timed_out','lease_expired','cancelled') THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN status IN ('pending','queued','assigned','running','streaming','reviewing') THEN 1 ELSE 0 END), 0) AS active
      FROM tasks
      WHERE team_id=? AND created_at >= datetime('now','-7 days')
    `).get(teamId) as { total: number; completed: number; failed: number; active: number };
    if (summary.total === 0) return [];
    const completionRate = (summary.completed / summary.total) * 100;
    return [
      `[tasks] 최근 7일: 전체=${summary.total}, 완료=${summary.completed}, 실패성=${summary.failed}, 진행=${summary.active}, 완료율=${completionRate.toFixed(1)}%`,
    ];
  });

  collect('work_reports', () => {
    const rows = database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM work_reports
      WHERE team_id=? AND report_date >= date('now','-7 days') AND status<>'pending'
      GROUP BY status
      ORDER BY status
    `).all(teamId) as Array<{ status: string; count: number }>;
    return rows.length > 0
      ? [`[work_reports] 최근 7일: ${rows.map((row) => `${row.status}=${row.count}`).join(', ')}`]
      : [];
  });

  if (SUBSTANTIVE_TASK_SLUGS.has(team.slug)) {
    collect('recent_team_tasks', () => {
      const rows = database.prepare(`
        SELECT id, status, created_at, prompt
        FROM tasks
        WHERE team_id=?
          AND created_at >= datetime('now','-7 days')
          AND prompt NOT LIKE '[업무보고 작성]%'
        ORDER BY created_at DESC
        LIMIT 5
      `).all(teamId) as Array<{
        id: string;
        status: string;
        created_at: string;
        prompt: string;
      }>;
      return rows.map((row) =>
        `[recent_team_task] id=${compactContextText(row.id, 100)}, 상태=${compactContextText(row.status, 50)}, 생성=${compactContextText(row.created_at, 50)}, 지시=${compactContextText(row.prompt, 240)}`,
      );
    });
  }

  if (
    team.slug === EVOLUTION_LEARNING_TEAM_SLUG
    && evolutionLearningContextEnabled()
  ) {
    let sourceTaskIds: string[] = [];
    collect('evolution_learning_tasks', () => {
      const rows = database.prepare(`
        SELECT
          id,
          status,
          created_at,
          completed_at,
          prompt,
          response,
          error,
          result_json,
          evidence_json,
          CASE
            WHEN json_valid(metadata_json)
            THEN json_extract(metadata_json, '$.workReportId')
            ELSE NULL
          END AS work_report_id
        FROM tasks
        WHERE team_id=?
          AND status IN ('completed','failed','timed_out','lease_expired','cancelled')
          AND created_at >= datetime('now','-48 hours')
        ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC, id DESC
        LIMIT 5
      `).all(teamId) as Array<{
        id: string;
        status: string;
        created_at: string;
        completed_at: string | null;
        prompt: string;
        response: string | null;
        error: string | null;
        result_json: string | null;
        evidence_json: string | null;
        work_report_id: string | null;
      }>;
      sourceTaskIds = rows.map((row) => row.id);
      return rows.map((row) =>
        [
          '[learning_task_evidence] source_tier=T1(SQLite tasks row)',
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `완료=${compactNullableContextText(row.completed_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `지시=${compactContextText(row.prompt, 240)}`,
          `응답(T4-natural-language)=${compactNullableContextText(row.response, 400)}`,
          `result_json=${compactNullableContextText(row.result_json, 300)}`,
          `evidence_json=${compactNullableContextText(row.evidence_json, 300)}`,
          `workReportId=${compactNullableContextText(row.work_report_id, 100)}`,
        ].join(', '),
      );
    });

    if (sourceTaskIds.length > 0) {
      collect('evolution_learning_events', () => {
        const placeholders = sourceTaskIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT id, agent_id, event_type, pattern, context, auto_applied, created_at
          FROM learning_events
          WHERE created_at >= datetime('now','-48 hours')
            AND json_valid(context)
            AND (
              json_extract(context, '$.taskId') IN (${placeholders})
              OR json_extract(context, '$.sourceTaskId') IN (${placeholders})
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 10
        `).all(...sourceTaskIds, ...sourceTaskIds) as Array<{
          id: number;
          agent_id: string;
          event_type: string | null;
          pattern: string | null;
          context: string;
          auto_applied: number;
          created_at: string;
        }>;
        return rows.map((row) =>
          [
            '[learning_event_evidence] source_tier=T1(SQLite learning_events row)',
            `id=${row.id}`,
            `agent=${compactContextText(row.agent_id, 100)}`,
            `event=${compactNullableContextText(row.event_type, 100)}`,
            `created=${compactContextText(row.created_at, 50)}`,
            `auto_applied=${row.auto_applied === 1 ? '1' : '0'}`,
            `pattern=${compactNullableContextText(row.pattern, 240)}`,
            `context=${compactContextText(row.context, 400)}`,
          ].join(', '),
        );
      });
    }
  }

  const agentIds = new Set<string>();
  if (team.lead?.trim()) agentIds.add(team.lead.trim());
  collect('team_members', () => {
    const members = database.prepare(`
      SELECT member_ref
      FROM team_members
      WHERE team_id=? AND member_type='provider'
      ORDER BY created_at ASC
    `).all(teamId) as Array<{ member_ref: string }>;
    for (const member of members) {
      if (member.member_ref.trim()) agentIds.add(member.member_ref.trim());
    }
    return [];
  });

  // Decision & Coordination Office: 집계만으로는 조정 charter(식별자·핸드오프·귀속)를 수행할 수 없다.
  // team-runner 경로도 동일 블록을 미러링한다(scripts/team-runner.sh).
  // 롤백: NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT=off
  if (
    team.slug === DECISION_COORDINATION_TEAM_SLUG
    && decisionCoordinationContextEnabled()
  ) {
    collect('decision_coordination_team_tasks', () => {
      const rows = database.prepare(`
        SELECT
          id,
          status,
          assigned_to,
          created_at,
          completed_at,
          error,
          prompt,
          CASE
            WHEN json_valid(metadata_json)
            THEN json_extract(metadata_json, '$.workReportId')
            ELSE NULL
          END AS work_report_id
        FROM tasks
        WHERE team_id=?
          AND created_at >= datetime('now', '-48 hours')
        ORDER BY
          CASE
            WHEN status IN ('pending','queued','assigned','running','streaming','reviewing') THEN 0
            ELSE 1
          END,
          COALESCE(completed_at, created_at) DESC,
          created_at DESC,
          id DESC
        LIMIT 8
      `).all(teamId) as Array<{
        id: string;
        status: string;
        assigned_to: string | null;
        created_at: string;
        completed_at: string | null;
        error: string | null;
        prompt: string;
        work_report_id: string | null;
      }>;
      return rows.map((row) =>
        [
          '[coordination_task_evidence] source_tier=T1(SQLite tasks row)',
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `담당=${compactNullableContextText(row.assigned_to, 80)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `완료=${compactNullableContextText(row.completed_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `workReportId=${compactNullableContextText(row.work_report_id, 100)}`,
          `지시=${compactContextText(row.prompt, 240)}`,
        ].join(', '),
      );
    });

    collect('decision_coordination_work_reports', () => {
      const rows = database.prepare(`
        SELECT id, report_date, report_slot, status, source_task_id, submitted_at
        FROM work_reports
        WHERE team_id=?
          AND report_date >= date('now', '-7 days')
        ORDER BY report_date DESC, report_slot DESC, updated_at DESC
        LIMIT 5
      `).all(teamId) as Array<{
        id: string;
        report_date: string;
        report_slot: string;
        status: string;
        source_task_id: string | null;
        submitted_at: string | null;
      }>;
      return rows.map((row) =>
        [
          '[coordination_work_report_evidence] source_tier=T1(SQLite work_reports row)',
          `id=${compactContextText(row.id, 100)}`,
          `date=${compactContextText(row.report_date, 20)}`,
          `slot=${compactContextText(row.report_slot, 10)}`,
          `status=${compactContextText(row.status, 30)}`,
          `sourceTaskId=${compactNullableContextText(row.source_task_id, 100)}`,
          `submittedAt=${compactNullableContextText(row.submitted_at, 50)}`,
        ].join(', '),
      );
    });

    if (agentIds.size > 0) {
      const memberIds = [...agentIds];
      const placeholders = memberIds.map(() => '?').join(',');
      collect('decision_coordination_member_tasks', () => {
        const rows = database.prepare(`
          SELECT id, assigned_to, status, team_id, created_at, completed_at, error
          FROM tasks
          WHERE assigned_to IN (${placeholders})
            AND created_at >= datetime('now', '-48 hours')
          ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC, id DESC
          LIMIT 10
        `).all(...memberIds) as Array<{
          id: string;
          assigned_to: string | null;
          status: string;
          team_id: string | null;
          created_at: string;
          completed_at: string | null;
          error: string | null;
        }>;
        return rows.map((row) =>
          [
            '[coordination_member_task_evidence] source_tier=T1(SQLite tasks row)',
            `id=${compactContextText(row.id, 100)}`,
            `담당=${compactNullableContextText(row.assigned_to, 80)}`,
            `상태=${compactContextText(row.status, 50)}`,
            `teamId=${compactNullableContextText(row.team_id, 100)}`,
            `생성=${compactContextText(row.created_at, 50)}`,
            `완료=${compactNullableContextText(row.completed_at, 50)}`,
            `오류=${compactNullableContextText(row.error, 200)}`,
          ].join(', '),
        );
      });
    }
  }

  // web-scrape-06-verification-quality: charter는 표본 원문 대조를 요구하지만 team-runner가
  // 집계 카운트만 주입해 5축 검증이 구조적으로 BLOCKED였다(실측 2026-07-30 러너 산출물).
  // upstream 파이프라인(03~05)의 evidence_json·result_json·응답 스니펫을 T1으로 주입한다.
  // 롤백: NCO_VERIFICATION_QUALITY_SAMPLE_CONTEXT=off
  if (
    team.slug === VERIFICATION_QUALITY_TEAM_SLUG
    && verificationQualitySampleContextEnabled()
  ) {
    const upstreamPlaceholders = VERIFICATION_UPSTREAM_TEAM_SLUGS.map(() => '?').join(',');
    collect('verification_upstream_samples', () => {
      const rows = database.prepare(`
        SELECT
          t.id,
          tm.slug AS team_slug,
          t.status,
          t.created_at,
          t.completed_at,
          t.response,
          t.error,
          t.result_json,
          t.evidence_json
        FROM tasks t
        JOIN teams tm ON tm.id = t.team_id
        WHERE tm.slug IN (${upstreamPlaceholders})
          AND t.status IN ('completed','failed','timed_out','lease_expired','cancelled')
          AND t.created_at >= datetime('now','-48 hours')
          AND (
            TRIM(COALESCE(t.evidence_json, '')) <> ''
            OR TRIM(COALESCE(t.result_json, '')) <> ''
            OR (
              t.status = 'completed'
              AND LENGTH(TRIM(COALESCE(t.response, ''))) > 100
            )
          )
        ORDER BY COALESCE(t.completed_at, t.created_at) DESC, t.created_at DESC, t.id DESC
        LIMIT 5
      `).all(...VERIFICATION_UPSTREAM_TEAM_SLUGS) as Array<{
        id: string;
        team_slug: string;
        status: string;
        created_at: string;
        completed_at: string | null;
        response: string | null;
        error: string | null;
        result_json: string | null;
        evidence_json: string | null;
      }>;
      return rows.map((row) =>
        [
          '[verification_upstream_sample] source_tier=T1(SQLite tasks row)',
          `upstream_team=${compactContextText(row.team_slug, 80)}`,
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `완료=${compactNullableContextText(row.completed_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `응답(T4-natural-language)=${compactNullableContextText(row.response, 400)}`,
          `result_json=${compactNullableContextText(row.result_json, 300)}`,
          `evidence_json=${compactNullableContextText(row.evidence_json, 300)}`,
        ].join(', '),
      );
    });

    collect('verification_team_failures', () => {
      const rows = database.prepare(`
        SELECT id, status, created_at, error, response
        FROM tasks
        WHERE team_id=?
          AND status IN ('failed','timed_out','lease_expired','cancelled')
          AND created_at >= datetime('now','-48 hours')
        ORDER BY created_at DESC, id DESC
        LIMIT 5
      `).all(teamId) as Array<{
        id: string;
        status: string;
        created_at: string;
        error: string | null;
        response: string | null;
      }>;
      return rows.map((row) =>
        [
          '[verification_failure_rca] source_tier=T1(SQLite tasks row)',
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `응답(T4-natural-language)=${compactNullableContextText(row.response, 200)}`,
        ].join(', '),
      );
    });
  }

  // computer-use-control: charter는 잠금·런타임·MCP Tier-1 확인을 요구하지만 team-runner가
  // 집계 카운트만 주입해 일일 보고가 "미확인" 반복 → completion=0% 오탐이었다
  // (실측 2026-07-28~30: team_computer-use-control 일일 산출물 전수).
  // /api/computer-use/status와 동일한 런타임·활성 run·48h 태스크 오류를 T1으로 주입한다.
  // 롤백: NCO_COMPUTER_USE_CONTROL_EVIDENCE_CONTEXT=off
  if (
    team.slug === COMPUTER_USE_CONTROL_TEAM_SLUG
    && computerUseControlContextEnabled()
  ) {
    collect('computer_use_runtime', () => {
      const runtime = probeComputerUseRuntimeSync();
      const snapshot = buildComputerUseObservability(runtime);
      return [
        [
          '[computer_use_runtime_evidence] source_tier=T1(nova-use metadata file)',
          `available=${runtime.available ? '1' : '0'}`,
          `pid=${runtime.pid ?? '없음'}`,
          `endpointHost=${compactNullableContextText(runtime.endpointHost ?? null, 80)}`,
          `error=${compactNullableContextText(runtime.error ?? null, 240)}`,
          `leaseMs=${snapshot.policy.leaseMs}`,
          `heartbeatMs=${snapshot.policy.heartbeatMs}`,
          `maxWaitMs=${snapshot.policy.maxWaitMs}`,
          `timestamp=${compactContextText(snapshot.timestamp, 50)}`,
        ].join(', '),
      ];
    });

    collect('computer_use_active_runs', () => {
      const runs = listCompanyRuns(20)
        .filter((run) => run.orgSlug === 'computer-use' && run.computerUse)
        .slice(0, 5);
      return runs.map((run) =>
        [
          '[computer_use_active_run_evidence] source_tier=T1(company_runs row)',
          `runId=${compactContextText(run.id, 100)}`,
          `status=${compactContextText(run.computerUse!.status, 30)}`,
          `message=${compactNullableContextText(run.computerUse!.message, 240)}`,
          `queuedBehindRunId=${compactNullableContextText(run.computerUse!.queuedBehindRunId ?? null, 100)}`,
          `activatedAt=${compactNullableContextText(run.computerUse!.activatedAt ?? null, 50)}`,
          `releasedAt=${compactNullableContextText(run.computerUse!.releasedAt ?? null, 50)}`,
        ].join(', '),
      );
    });

    collect('computer_use_control_tasks', () => {
      const rows = database.prepare(`
        SELECT
          id,
          status,
          assigned_to,
          created_at,
          completed_at,
          error,
          CASE
            WHEN json_valid(metadata_json)
            THEN json_extract(metadata_json, '$.workReportId')
            ELSE NULL
          END AS work_report_id
        FROM tasks
        WHERE team_id=?
          AND created_at >= datetime('now', '-48 hours')
        ORDER BY
          CASE
            WHEN status IN ('pending','queued','assigned','running','streaming','reviewing') THEN 0
            ELSE 1
          END,
          COALESCE(completed_at, created_at) DESC,
          created_at DESC,
          id DESC
        LIMIT 8
      `).all(teamId) as Array<{
        id: string;
        status: string;
        assigned_to: string | null;
        created_at: string;
        completed_at: string | null;
        error: string | null;
        work_report_id: string | null;
      }>;
      return rows.map((row) =>
        [
          '[computer_use_control_task_evidence] source_tier=T1(SQLite tasks row)',
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `담당=${compactNullableContextText(row.assigned_to, 80)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `완료=${compactNullableContextText(row.completed_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `workReportId=${compactNullableContextText(row.work_report_id, 100)}`,
        ].join(', '),
      );
    });

    collect('computer_use_control_failures', () => {
      const rows = database.prepare(`
        SELECT id, status, created_at, error, response
        FROM tasks
        WHERE team_id=?
          AND status IN ('failed','timed_out','lease_expired','cancelled')
          AND created_at >= datetime('now', '-48 hours')
        ORDER BY created_at DESC, id DESC
        LIMIT 5
      `).all(teamId) as Array<{
        id: string;
        status: string;
        created_at: string;
        error: string | null;
        response: string | null;
      }>;
      return rows.map((row) =>
        [
          '[computer_use_control_failure_rca] source_tier=T1(SQLite tasks row)',
          `id=${compactContextText(row.id, 100)}`,
          `상태=${compactContextText(row.status, 50)}`,
          `생성=${compactContextText(row.created_at, 50)}`,
          `오류=${compactNullableContextText(row.error, 240)}`,
          `응답(T4-natural-language)=${compactNullableContextText(row.response, 200)}`,
        ].join(', '),
      );
    });
  }

  if (agentIds.size > 0) {
    const ids = [...agentIds];
    const placeholders = ids.map(() => '?').join(',');
    collect('agent_performance_summary', () => {
      const rows = database.prepare(`
        SELECT agent_id, task_type, total_runs, success_rate, avg_quality, avg_duration_ms
        FROM agent_performance_summary
        WHERE agent_id IN (${placeholders})
        ORDER BY total_runs DESC, agent_id ASC, task_type ASC
        LIMIT 10
      `).all(...ids) as Array<{
        agent_id: string;
        task_type: string;
        total_runs: number;
        success_rate: number;
        avg_quality: number;
        avg_duration_ms: number;
      }>;
      return rows.map((row) =>
        `[agent_performance_summary] ${row.agent_id}/${row.task_type}: 실행=${row.total_runs}, 성공률=${(row.success_rate * 100).toFixed(1)}%, 평균품질=${formatMetric(row.avg_quality)}, 평균소요ms=${formatMetric(row.avg_duration_ms)}`,
      );
    });

    collect('metrics', () => {
      const rows = database.prepare(`
        SELECT agent_id, metric_type, COUNT(*) AS samples, AVG(value) AS avg_value, MAX(created_at) AS latest_at
        FROM metrics
        WHERE agent_id IN (${placeholders}) AND created_at >= datetime('now','-7 days')
        GROUP BY agent_id, metric_type
        ORDER BY samples DESC, agent_id ASC, metric_type ASC
        LIMIT 10
      `).all(...ids) as Array<{
        agent_id: string;
        metric_type: string;
        samples: number;
        avg_value: number;
        latest_at: string;
      }>;
      return rows.map((row) =>
        `[metrics] ${row.agent_id}/${row.metric_type}: 표본=${row.samples}, 평균=${formatMetric(row.avg_value)}, 최근=${row.latest_at}`,
      );
    });
  }

  if (team.slug === 'cfo') {
    collect('nova_wallets', () => {
      const row = database.prepare(`
        SELECT COUNT(*) AS wallets, COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(locked), 0) AS locked
        FROM nova_wallets
      `).get() as { wallets: number; balance: number; locked: number };
      return [`[nova_wallets] 지갑=${row.wallets}, 총잔액=${row.balance}, 잠금=${row.locked}`];
    });
    collect('nova_transactions', () => {
      const rows = database.prepare(`
        SELECT status, COUNT(*) AS transactions, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(fee), 0) AS fee
        FROM nova_transactions
        WHERE created_at >= strftime('%s','now','-7 days')
        GROUP BY status
        ORDER BY status
      `).all() as Array<{ status: string; transactions: number; amount: number; fee: number }>;
      return rows.length > 0
        ? rows.map((row) => `[nova_transactions] 최근 7일/${row.status}: 건수=${row.transactions}, 금액=${row.amount}, 수수료=${row.fee}`)
        : ['[nova_transactions] 최근 7일 거래=0'];
    });
  }

  if (SNS_TEAM_SLUGS.has(team.slug)) {
    collect('blog-promo', snsContextLoader);
  }

  if (team.slug === 'self-improvement') {
    collect('improvement_notes', () => {
      const summary = database.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN timestamp >= datetime('now','-7 days') THEN 1 ELSE 0 END), 0) AS recent,
               MAX(timestamp) AS latest_at
        FROM improvement_notes
      `).get() as { total: number; recent: number; latest_at: string | null };
      const lines = [
        `[improvement_notes] 전체=${summary.total}, 최근 7일=${summary.recent}, 최근기록=${summary.latest_at ?? '없음'}`,
      ];
      const rows = database.prepare(`
        SELECT timestamp, category, problem, root_cause, fix, verified_at, agent, severity
        FROM improvement_notes
        WHERE timestamp >= datetime('now','-7 days')
        ORDER BY timestamp DESC
        LIMIT 5
      `).all() as Array<{
        timestamp: string;
        category: string;
        problem: string;
        root_cause: string;
        fix: string;
        verified_at: string | null;
        agent: string;
        severity: string;
      }>;
      for (const row of rows) {
        lines.push(
          `[improvement_note] 시각=${compactContextText(row.timestamp, 50)}, 분류=${compactContextText(row.category, 50)}, 심각도=${compactContextText(row.severity, 30)}, 에이전트=${compactContextText(row.agent, 50)}, 문제=${compactContextText(row.problem, 200)}, 원인=${compactContextText(row.root_cause, 200) || '기록 없음'}, 수정=${compactContextText(row.fix, 200) || '기록 없음'}, 검증=${row.verified_at ? compactContextText(row.verified_at, 50) : '미검증'}`,
        );
      }
      return lines;
    });
  }

  if (team.slug === 'ax-docs' || team.slug === 'self-improvement') {
    collect('git', gitContextLoader);
  }

  return sections.length > 0
    ? sections.join('\n')
    : '데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고.';
}

function collectDescendantOrgIds(rootOrgId: string, database: ReportDataDb): string[] {
  const allIds: string[] = [rootOrgId];
  const queue = [rootOrgId];
  const visited = new Set<string>([rootOrgId]);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = database.prepare(
      `SELECT id FROM organizations WHERE parent_id=? AND is_active=1`,
    ).all(currentId) as Array<{ id: string }>;
    for (const child of children) {
      if (!visited.has(child.id)) {
        visited.add(child.id);
        allIds.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return allIds;
}

export function buildOrganizationDataContext(
  orgId: string,
  database: ReportDataDb = getDb(),
): string {
  const sections: string[] = [];

  const allOrgIds = collectDescendantOrgIds(orgId, database);
  const placeholders = allOrgIds.map(() => '?').join(',');

  const teams = database.prepare(`
    SELECT id, name, slug, lead
    FROM teams
    WHERE organization_id IN (${placeholders}) AND is_active=1
    ORDER BY created_at ASC, name ASC
  `).all(...allOrgIds) as Array<{ id: string; name: string; slug: string; lead: string | null }>;

  if (teams.length === 0) {
    return '소속 팀 없음\n이 조직에 속한 활성 팀이 없습니다.';
  }

  sections.push(`[teams] 소속 팀(${teams.length}): ${teams.map((t) => t.name || t.slug).join(', ')}`);

  for (const team of teams) {
    const summary = database.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completed,
             COALESCE(SUM(CASE WHEN status IN ('failed','timed_out','lease_expired','cancelled') THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN status IN ('pending','queued','assigned','running','streaming','reviewing') THEN 1 ELSE 0 END), 0) AS active
      FROM tasks
      WHERE team_id=? AND created_at >= datetime('now','-7 days')
    `).get(team.id) as { total: number; completed: number; failed: number; active: number };
    if (summary.total > 0) {
      sections.push(`[tasks] ${team.name || team.slug} 최근 7일: 전체=${summary.total}, 완료=${summary.completed}, 실패=${summary.failed}, 진행=${summary.active}`);
    }
  }

  const wrSummary = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM work_reports
    WHERE organization_id IN (${placeholders}) AND report_date >= date('now','-7 days') AND status<>'pending'
    GROUP BY status
    ORDER BY status
  `).all(...allOrgIds) as Array<{ status: string; count: number }>;
  if (wrSummary.length > 0) {
    sections.push(`[work_reports] 소속팀+하위조직 최근 7일 보고: ${wrSummary.map((r) => `${r.status}=${r.count}`).join(', ')}`);
  }

  return sections.length > 0
    ? sections.join('\n')
    : '데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고.';
}

/**
 * 업무보고 프롬프트의 `[실데이터]` 스냅샷을 실행 시점 기준으로 다시 읽어 교체한다.
 *
 * 왜 필요한가 (2026-07-27 team_gov-evolution-learning 실측):
 * failover/retry 복제본은 `loadRetryPayload()`가 부모 prompt를 바이트 단위로 승계한다.
 * 그래서 `[실데이터]` 블록이 *부모 제출 시각*에 동결된다. wr_wcXz4AG_W0eFppWp 체인
 * (task_3eejRUftHpUXmdOH → task_IjCXiEO-3LT65aIS → task_TF-0pwR0YBvnvs0b)은 prompt
 * SHA-1이 전부 `de1a9425…`로 동일했고, 05:29 스냅샷 `전체=4, 실패성=0`을 06:53에 실행된
 * codex 복제본이 그대로 서술했다. 그 시점 실제 DB는 `전체=6, 실패성=2`였다.
 *
 * 에이전트 날조가 아니다 — 프롬프트 요구사항 5번("[실데이터]에 있는 값만 사실로 사용")을
 * 성실히 지킬수록 failover를 유발한 바로 그 실패가 보고서에서 은폐되는 구조였다.
 * 지속학습팀(charter: 실패에서 교훈 추출)에는 이 동결이 임무 자체를 무력화한다.
 *
 * 경계: `[실데이터]` 와 `요구사항:` 구분선을 둘 다 가진 업무보고 프롬프트만 건드린다.
 * 일반 태스크 프롬프트는 구분선이 없어 그대로 반환한다(no-op).
 * 롤백: 런타임 즉시 → NCO_WORK_REPORT_SNAPSHOT_REFRESH=off (재빌드 불필요).
 */
export const WORK_REPORT_SNAPSHOT_REFRESH_FLAG = 'NCO_WORK_REPORT_SNAPSHOT_REFRESH';
const SNAPSHOT_REFRESH_DISABLED = new Set(['0', 'false', 'off']);
const SNAPSHOT_BEGIN_MARKER = '[실데이터]';
const SNAPSHOT_END_MARKER = '요구사항:';
const SNAPSHOT_REFRESH_NOTE =
  '[snapshot_refreshed] source_tier=T1(SQLite 재조회) — 위 [실데이터]는 이 실행 시점에 다시 읽은 값이다. '
  + '이전 시도(failover/retry)의 동결 스냅샷이 아니므로, 앞선 시도의 실패도 위 수치에 반영되어 있다.';

export function isWorkReportSnapshotRefreshEnabled(
  toggle: string | undefined = process.env[WORK_REPORT_SNAPSHOT_REFRESH_FLAG],
): boolean {
  return !SNAPSHOT_REFRESH_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

export function refreshWorkReportPromptSnapshot(
  prompt: string,
  teamId: string,
  buildContext: (teamId: string) => string = buildTeamDataContext,
  toggle?: string,
): string {
  if (!isWorkReportSnapshotRefreshEnabled(toggle)) return prompt;
  if (!prompt || !teamId) return prompt;

  const lines = prompt.split('\n');
  const begin = lines.findIndex(line => line.trim() === SNAPSHOT_BEGIN_MARKER);
  if (begin === -1) return prompt;
  const end = lines.findIndex((line, index) => index > begin && line.trim() === SNAPSHOT_END_MARKER);
  if (end === -1) return prompt;

  let rebuilt: string;
  try {
    rebuilt = buildContext(teamId);
  } catch (error) {
    // 재조회 실패 시 동결 스냅샷이라도 유지한다 — 보고 자체를 깨뜨리지 않는다.
    log.warn({
      teamId,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to refresh work report data snapshot — keeping inherited snapshot');
    return prompt;
  }
  if (!rebuilt.trim()) return prompt;

  const previous = lines.slice(begin + 1, end).join('\n');
  if (previous.trim() === rebuilt.trim()) return prompt;

  return [
    ...lines.slice(0, begin + 1),
    rebuilt,
    SNAPSHOT_REFRESH_NOTE,
    ...lines.slice(end),
  ].join('\n');
}

export function buildOrganizationReportPrompt(
  org: OrganizationRow,
  reportDate: string,
  reportSlot: WorkReportSlot,
  snapshot: SubjectSnapshot,
  dataContext: string,
): string {
  const slotLabel = reportSlot === 'am' ? '오전' : '오후';
  return [
    `[업무보고 작성] ${reportDate} ${slotLabel} 보고서를 작성하라.`,
    `회사: ${org.name}`,
    `조직 경로: ${snapshot.orgPath}`,
    '[실데이터]',
    dataContext,
    '요구사항:',
    '1. 오늘 회사 전체의 핵심 업무 현황을 간단히 정리한다.',
    '2. 소속 팀별 진행 상황과 주요 이슈를 명시한다.',
    '3. 다음 기간의 액션 플랜을 제시한다.',
    '4. 결과를 markdown 본문으로 작성한다.',
    '5. 본문 전체를 반드시 한국어로만 작성한다. 제목·소제목·불릿 포함 영어 문장 금지 (코드/파일명/고유명사 제외).',
    '6. [실데이터]에 있는 값만 사실로 사용하고 없는 수치·사건·완료 상태를 지어내지 않는다.',
    '7. 데이터가 없더라도 빈 응답을 내지 말고 데이터 가용성, 확인 불가 항목, 다음 수집 액션을 본문에 명시한다.',
  ].join('\n');
}

export interface WorkReportIssueResult {
  reportDate: string;
  reportSlot: WorkReportSlot;
  created: number;
  existing: number;
  pending: number;
  waived: number;
  teamTasksCreated: number;
  teamTasksFailed: number;
  organizationTasksCreated: number;
  organizationTasksFailed: number;
}

function getKstDateParts(date = new Date()): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

export function formatKstDate(date = new Date()): string {
  const parts = getKstDateParts(date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function buildKstDateTime(date: string, hour: number, minute: number): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - KST_OFFSET_HOURS, minute, 0, 0));
}

export function getDefaultWorkReportSlot(date = new Date()): WorkReportSlot {
  const parts = getKstDateParts(date);
  return parts.hour < 14 ? 'am' : 'pm';
}

export function getDueAt(reportDate: string, reportSlot: WorkReportSlot): string {
  const due = reportSlot === 'am'
    ? buildKstDateTime(reportDate, 11, 30)
    : buildKstDateTime(reportDate, 18, 0);
  return due.toISOString();
}

function getFinalizeAfter(reportDate: string, reportSlot: WorkReportSlot): Date {
  const base = reportSlot === 'am'
    ? buildKstDateTime(reportDate, 12, 0)
    : buildKstDateTime(reportDate, 18, 30);
  return base;
}

function buildOrgSnapshots(organizations: OrganizationRow[]): Map<string, SubjectSnapshot> {
  const orgById = new Map(organizations.map((organization) => [organization.id, organization]));
  const snapshots = new Map<string, SubjectSnapshot>();

  const visit = (organizationId: string, trail: Set<string>): SubjectSnapshot => {
    const cached = snapshots.get(organizationId);
    if (cached) return cached;

    const organization = orgById.get(organizationId);
    if (!organization) {
      return {
        organizationId: null,
        teamId: null,
        orgRootId: null,
        orgParentId: null,
        orgPath: organizationId,
        orgDepth: 0,
        unitLevel: 'company',
        active: false,
      };
    }

    if (trail.has(organizationId)) {
      return {
        organizationId: organization.id,
        teamId: null,
        orgRootId: organization.id,
        orgParentId: organization.parent_id,
        orgPath: organization.slug,
        orgDepth: 0,
        unitLevel: 'company',
        active: organization.is_active === 1,
      };
    }

    const nextTrail = new Set(trail);
    nextTrail.add(organizationId);

    let snapshot: SubjectSnapshot;
    if (organization.parent_id) {
      const parent = visit(organization.parent_id, nextTrail);
      snapshot = {
        organizationId: organization.id,
        teamId: null,
        orgRootId: parent.orgRootId ?? organization.id,
        orgParentId: organization.parent_id,
        orgPath: `${parent.orgPath}/${organization.slug}`,
        orgDepth: parent.orgDepth + 1,
        unitLevel: 'department',
        active: parent.active && organization.is_active === 1,
      };
    } else {
      snapshot = {
        organizationId: organization.id,
        teamId: null,
        orgRootId: organization.id,
        orgParentId: null,
        orgPath: organization.slug,
        orgDepth: 0,
        unitLevel: 'company',
        active: organization.is_active === 1,
      };
    }

    snapshots.set(organizationId, snapshot);
    return snapshot;
  };

  for (const organization of organizations) {
    visit(organization.id, new Set<string>());
  }

  return snapshots;
}

function buildTeamSnapshot(team: TeamRow, orgSnapshots: Map<string, SubjectSnapshot>): SubjectSnapshot {
  if (!team.organization_id) {
    return {
      organizationId: null,
      teamId: team.id,
      orgRootId: null,
      orgParentId: null,
      orgPath: team.slug,
      orgDepth: 0,
      unitLevel: 'team',
      active: team.is_active === 1,
    };
  }

  const parent = orgSnapshots.get(team.organization_id);
  if (!parent) {
    return {
      organizationId: team.organization_id,
      teamId: team.id,
      orgRootId: team.organization_id,
      orgParentId: team.organization_id,
      orgPath: team.slug,
      orgDepth: 1,
      unitLevel: 'team',
      active: team.is_active === 1,
    };
  }

  return {
    organizationId: team.organization_id,
    teamId: team.id,
    orgRootId: parent.orgRootId,
    orgParentId: team.organization_id,
    orgPath: `${parent.orgPath}/${team.slug}`,
    orgDepth: parent.orgDepth + 1,
    unitLevel: 'team',
    active: parent.active && team.is_active === 1,
  };
}

export function buildReportPrompt(
  team: TeamRow,
  reportDate: string,
  reportSlot: WorkReportSlot,
  snapshot: SubjectSnapshot,
  dataContext = buildTeamDataContext(team.id),
): string {
  const slotLabel = reportSlot === 'am' ? '오전' : '오후';
  const charter = team.charter?.trim() ? `팀 상시 임무: ${team.charter.trim()}\n` : '';
  return [
    `[업무보고 작성] ${reportDate} ${slotLabel} 보고서를 작성하라.`,
    `팀: ${team.name}`,
    `조직 경로: ${snapshot.orgPath}`,
    charter.trimEnd(),
    '[실데이터]',
    dataContext,
    '요구사항:',
    '1. 오늘 수행한 핵심 업무를 간단히 정리한다.',
    '2. 진행 중 이슈와 다음 액션을 명시한다.',
    '3. 결과를 markdown 본문으로 작성한다.',
    // 한국어 강제 (2026-07-08 사용자 절대 요건 — 영어 본문 제출 실측으로 강화):
    '4. 본문 전체를 반드시 한국어로만 작성한다. 제목·소제목·불릿 포함 영어 문장 금지 (코드/파일명/고유명사 제외). Write the ENTIRE report in Korean only.',
    '5. [실데이터]에 있는 값만 사실로 사용하고 없는 수치·사건·완료 상태를 지어내지 않는다.',
    '6. 데이터가 없더라도 빈 응답을 내지 말고 데이터 가용성, 확인 불가 항목, 다음 수집 액션을 본문에 명시한다.',
  ].filter(Boolean).join('\n');
}

/**
 * 업무보고 발행 실행자(executor)를 가용성 기반으로 해석한다.
 *
 * 기존엔 team.lead 로 직행 발행했다. 그런데 파운데이션 정책(company-orchestrator
 * NCO_FOUNDATION_COMPANY_POLICIES)이 gov-command→claude-code, gov-evolution→opencode 처럼
 * 세션·리밋에 취약한 provider를 팀 lead(=manager)로 박아두고, 팀 재생성 때마다 되살아난다.
 * 그 lead의 회로차단기가 열려 있으면 발행 태스크가 즉시 "Circuit breaker open"으로 실패하고
 * 매 틱 새 실패를 양산했다(2026-07-25 실측 성공률 8.9% 붕괴의 직접 원인).
 *
 * 여기서는 company-orchestrator의 resolveExecutor(가용 lead→가용 member→fallback)를 재사용해
 * 리드가 불가용이면 팀의 가용 멤버/fallback으로 라우팅한다. 조직 설계(누가 지휘 manager인지)는
 * 그대로 두고 "보고 작성 실행자"만 건강한 provider로 넘긴다. 전원 불가용이면 null → 스킵(보고는
 * pending 유지, 회로 복구 후 redispatch가 재개).
 *
 * ※ 가용성은 circuitBreakerRegistry.getAvailability()(non-mutating)로 본다. canExecute()는
 *    cooldown 만료 시 half-open 전이+true 반환으로 매 틱 프로브 1건을 흘리는 누수가 있었다.
 */
function makeReportExecutorResolver(knownAgents: Set<string>): {
  resolve: (teamId: string, lead: string | null) => string | null;
  rerouted: () => Array<{ from: string; to: string }>;
  skipped: () => string[];
} {
  const db = getDb();
  const availCache = new Map<string, boolean>();
  const memberCache = new Map<string, string[]>();
  const rerouted: Array<{ from: string; to: string }> = [];
  const skipped = new Set<string>();

  const isAvailable = (id: string): boolean => {
    if (!knownAgents.has(id)) return false;
    let a = availCache.get(id);
    if (a === undefined) {
      try {
        a = circuitBreakerRegistry.getAvailability(id).available;
      } catch {
        a = true; // 판정 실패 시 보수적으로 허용
      }
      availCache.set(id, a);
    }
    return a;
  };

  const loadMembers = (teamId: string): string[] => {
    let m = memberCache.get(teamId);
    if (m === undefined) {
      m = (db.prepare(
        `SELECT member_ref FROM team_members WHERE team_id=? ORDER BY created_at ASC, id ASC`,
      ).all(teamId) as Array<{ member_ref: string }>).map((r) => r.member_ref);
      memberCache.set(teamId, m);
    }
    return m;
  };

  return {
    resolve: (teamId, lead) => {
      const members = loadMembers(teamId);
      const teamRow = { id: teamId, name: '', slug: '', lead, charter: null, description: null, members };
      const exec = resolveExecutor(teamRow, knownAgents, 'ollama', isAvailable);
      if (!exec || !isAvailable(exec)) {
        if (lead) skipped.add(lead);
        return null;
      }
      if (lead && exec !== lead) rerouted.push({ from: lead, to: exec });
      return exec;
    },
    rerouted: () => rerouted,
    skipped: () => [...skipped],
  };
}

function resolveOrgReportExecutor(
  org: OrganizationRow,
  knownAgents: Set<string>,
  executorResolver: ReturnType<typeof makeReportExecutorResolver>,
): string | null {
  // media 전용 실행자는 보고서 작성 불가 — manager여도 대체 경로로 넘긴다
  const mgr = org.manager?.trim();
  if (
    mgr
    && knownAgents.has(mgr)
    && !NON_REPORT_EXECUTORS.has(mgr)
  ) {
    try {
      if (circuitBreakerRegistry.getAvailability(mgr).available) return mgr;
    } catch { /* fall through to sub-org team fallback */ }
  }

  const db = getDb();
  const allOrgIds = collectDescendantOrgIds(org.id, db);
  const placeholders = allOrgIds.map(() => '?').join(',');
  const childTeams = db.prepare(`
    SELECT id, lead FROM teams WHERE organization_id IN (${placeholders}) AND is_active=1 AND lead IS NOT NULL AND TRIM(lead) != ''
    ORDER BY created_at ASC, name ASC
  `).all(...allOrgIds) as Array<{ id: string; lead: string }>;
  for (const t of childTeams) {
    const exec = executorResolver.resolve(t.id, t.lead.trim());
    if (exec && !NON_REPORT_EXECUTORS.has(exec)) return exec;
  }

  // 보고서 작성 가능 등록 실행자만, 고정 우선순위 (media/임의 knownAgents 순회 금지)
  for (const agentId of resolvePreference(REPORT_CAPABLE_FALLBACK_PRIORITY, 'general')) {
    if (!knownAgents.has(agentId) || NON_REPORT_EXECUTORS.has(agentId)) continue;
    try {
      if (circuitBreakerRegistry.getAvailability(agentId).available) return agentId;
    } catch { /* skip */ }
  }
  return null;
}

export function buildReportTaskMetadata(candidate: ReportTaskCandidate): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    projectDir: resolveInternalProjectDir(),
    // Treasury failures task_0VCvCCPdkRADiuwH/task_7wS1alWtK8IZxVuW were dispatched with
    // organizationId=org_nco-government and this flag forced to true. Reuse the company
    // safety gate so foundation-company reports stay within same-role/team routing.
    allowProviderFailover: allowQueueProviderFailover(candidate.organizationId ?? ''),
    workReportId: candidate.reportId,
    subjectKind: candidate.subjectKind,
    subjectId: candidate.subjectId,
    organizationId: candidate.organizationId,
  };
  if (candidate.teamId) metadata.teamId = candidate.teamId;
  return metadata;
}

export async function createTeamReportTasks(
  app: FastifyInstance,
  candidates: ReportTaskCandidate[],
): Promise<{
  created: number;
  failed: number;
  deferred: number;
  attemptedReportIds: string[];
}> {
  const db = getDb();
  let created = 0;
  let failed = 0;
  let deferred = 0;
  const attemptedReportIds: string[] = [];

  for (const candidate of candidates) {
    const metadata = buildReportTaskMetadata(candidate);
    const response = await workReportDispatchGate.run(async () => {
      // 후보 계산 뒤 직렬 발행 게이트에서 대기하는 동안 회로가 열릴 수 있다.
      // 실제 POST 직전에 다시 확인해 stale "available" 판정으로 실패 태스크를
      // 연속 생성하지 않는다. 판정 자체가 실패하면 기존 동작대로 발행을 허용한다.
      try {
        if (!circuitBreakerRegistry.getAvailability(candidate.lead).available) return null;
      } catch (err) {
        log.warn({
          reportId: candidate.reportId,
          lead: candidate.lead,
          err: err instanceof Error ? err.message : String(err),
        }, 'Work-report dispatch availability recheck failed — preserving dispatch');
      }

      attemptedReportIds.push(candidate.reportId);
      return app.inject({
        method: 'POST',
        url: '/api/task',
        payload: {
          ai: candidate.lead,
          prompt: candidate.prompt,
          mode: 'task',
          callerAgentId: 'work-report-scheduler',
          metadata,
        },
      });
    });

    if (response === null) {
      deferred += 1;
      log.warn({
        reportId: candidate.reportId,
        subjectKind: candidate.subjectKind,
        subjectId: candidate.subjectId,
        teamId: candidate.teamId,
        lead: candidate.lead,
      }, 'Work-report dispatch deferred — executor circuit became unavailable');
      continue;
    }

    if (response.statusCode !== 202) {
      failed += 1;
      log.warn({
        reportId: candidate.reportId,
        subjectKind: candidate.subjectKind,
        subjectId: candidate.subjectId,
        teamId: candidate.teamId,
        lead: candidate.lead,
        statusCode: response.statusCode,
        payload: response.body,
      }, 'Failed to create work-report task');
      continue;
    }

    const body = response.json() as { taskId?: string };
    if (!body.taskId) {
      failed += 1;
      log.warn({ reportId: candidate.reportId, subjectKind: candidate.subjectKind, subjectId: candidate.subjectId }, 'Task route returned without taskId');
      continue;
    }

    db.prepare(`
      UPDATE work_reports
      SET source_task_id=?, updated_at=datetime('now')
      WHERE id=? AND source_task_id IS NULL
    `).run(body.taskId, candidate.reportId);
    if (candidate.teamId) {
      db.prepare(`
        UPDATE tasks
        SET team_id=?, updated_at=datetime('now')
        WHERE id=?
      `).run(candidate.teamId, body.taskId);
    }
    created += 1;
  }

  return { created, failed, deferred, attemptedReportIds };
}

export async function issueWorkReports(
  app: FastifyInstance,
  reportDate = formatKstDate(),
  reportSlot: WorkReportSlot = getDefaultWorkReportSlot(),
): Promise<WorkReportIssueResult> {
  const db = getDb();
  const organizations = db.prepare(`
    SELECT id, name, slug, parent_id, manager, is_active
    FROM organizations
    ORDER BY created_at ASC, name ASC
  `).all() as OrganizationRow[];
  const teams = db.prepare(`
    SELECT id, organization_id, name, slug, lead, charter, is_active
    FROM teams
    ORDER BY created_at ASC, name ASC
  `).all() as TeamRow[];

  const orgSnapshots = buildOrgSnapshots(organizations);
  const dueAt = getDueAt(reportDate, reportSlot);
  const taskCandidates: ReportTaskCandidate[] = [];
  let created = 0;
  let pending = 0;
  let waived = 0;

  const knownAgents = new Set(agentManager.listEnabledIds());
  const executorResolver = makeReportExecutorResolver(knownAgents);
  const resolvedExecutor = new Map<string, string | null>();
  for (const team of teams) {
    const lead = team.lead?.trim();
    if (lead) resolvedExecutor.set(team.id, executorResolver.resolve(team.id, lead));
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO work_reports (
      id, report_date, report_slot, subject_kind, subject_id, organization_id, team_id,
      org_root_id, org_parent_id, org_path, org_depth, unit_level, status, due_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const organization of organizations) {
      const snapshot = orgSnapshots.get(organization.id);
      if (!snapshot) continue;
      const status: WorkReportStatus = snapshot.active ? 'pending' : 'waived';
      const reportId = createId('wr');
      const result = insert.run(
        reportId,
        reportDate,
        reportSlot,
        'organization',
        organization.id,
        organization.id,
        null,
        snapshot.orgRootId,
        snapshot.orgParentId,
        snapshot.orgPath,
        snapshot.orgDepth,
        snapshot.unitLevel,
        status,
        dueAt,
      );
      if (result.changes > 0) {
        created += 1;
        if (status === 'pending') pending += 1;
        if (status === 'waived') waived += 1;
        if (status === 'pending') {
          const exec = resolveOrgReportExecutor(organization, knownAgents, executorResolver);
          if (exec) {
            taskCandidates.push({
              reportId,
              subjectKind: 'organization',
              subjectId: organization.id,
              teamId: null,
              organizationId: organization.id,
              lead: exec,
              prompt: buildOrganizationReportPrompt(
                organization,
                reportDate,
                reportSlot,
                snapshot,
                buildOrganizationDataContext(organization.id),
              ),
            });
          }
        }
      }
    }

    for (const team of teams) {
      const snapshot = buildTeamSnapshot(team, orgSnapshots);
      const status: WorkReportStatus = snapshot.active ? 'pending' : 'waived';
      const reportId = createId('wr');
      const result = insert.run(
        reportId,
        reportDate,
        reportSlot,
        'team',
        team.id,
        snapshot.organizationId,
        team.id,
        snapshot.orgRootId,
        snapshot.orgParentId,
        snapshot.orgPath,
        snapshot.orgDepth,
        snapshot.unitLevel,
        status,
        dueAt,
      );
      if (result.changes > 0) {
        created += 1;
        if (status === 'pending') pending += 1;
        if (status === 'waived') waived += 1;
        const executor = status === 'pending' && team.lead?.trim()
          ? resolvedExecutor.get(team.id) ?? null
          : null;
        if (executor) {
          taskCandidates.push({
            reportId,
            subjectKind: 'team',
            subjectId: team.id,
            teamId: team.id,
            organizationId: snapshot.organizationId,
            lead: executor,
            prompt: buildReportPrompt(team, reportDate, reportSlot, snapshot),
          });
        }
      }
    }
  });

  tx();

  const rerouted = executorResolver.rerouted();
  if (rerouted.length > 0) {
    log.info({ reportDate, reportSlot, rerouted },
      'Initial dispatch rerouted work-reports from unavailable lead to healthy executor');
  }
  const skippedLeads = executorResolver.skipped();
  if (skippedLeads.length > 0) {
    log.warn({ reportDate, reportSlot, skipped: skippedLeads },
      'Initial dispatch skipped — no available executor (reports stay pending for redispatch)');
  }

  // 팀→회사 순차 발행. 각 POST는 공용 게이트를 통과하므로 배치 경계에서도
  // TASK_DISPATCH_STAGGER_MS 간격이 유지된다.
  const teamTaskCandidates = taskCandidates.filter(c => c.subjectKind === 'team');
  const orgTaskCandidates = taskCandidates.filter(c => c.subjectKind === 'organization');
  const teamTaskResult = await createTeamReportTasks(app, teamTaskCandidates);
  const orgTaskResult = await createTeamReportTasks(app, orgTaskCandidates);
  const existing = organizations.length + teams.length - created;
  log.info({
    reportDate,
    reportSlot,
    created,
    existing,
    pending,
    waived,
    teamTasksCreated: teamTaskResult.created,
    teamTasksFailed: teamTaskResult.failed,
    teamTasksDeferred: teamTaskResult.deferred,
    organizationTasksCreated: orgTaskResult.created,
    organizationTasksFailed: orgTaskResult.failed,
    organizationTasksDeferred: orgTaskResult.deferred,
  }, 'Work reports issued');

  return {
    reportDate,
    reportSlot,
    created,
    existing,
    pending,
    waived,
    teamTasksCreated: teamTaskResult.created,
    teamTasksFailed: teamTaskResult.failed,
    organizationTasksCreated: orgTaskResult.created,
    organizationTasksFailed: orgTaskResult.failed,
  };
}

export function finalizeMissedWorkReports(
  reportDate: string,
  reportSlot: WorkReportSlot,
  now = new Date(),
): { updated: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, due_at
    FROM work_reports
    WHERE report_date=? AND report_slot=? AND status='pending'
  `).all(reportDate, reportSlot) as Array<{ id: string; due_at: string }>;

  let updated = 0;
  const update = db.prepare(`
    UPDATE work_reports
    SET status='missed', updated_at=datetime('now')
    WHERE id=? AND status='pending'
  `);

  for (const row of rows) {
    const dueAt = new Date(row.due_at);
    if (Number.isNaN(dueAt.getTime())) continue;
    if (dueAt.getTime() + MISSED_GRACE_MS <= now.getTime()) {
      const result = update.run(row.id);
      updated += result.changes;
    }
  }

  if (updated > 0) {
    log.info({ reportDate, reportSlot, updated }, 'Work reports marked missed');
  }
  return { updated };
}

// SQLite datetime('now') UTC 문자열('YYYY-MM-DD HH:MM:SS') 또는 ISO 문자열 → epoch ms
function parseDbTimestamp(value: string | null): number {
  if (!value) return Number.NaN;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

// 완료된 source task의 응답을 보고서로 수집(auto-submit) + 실패 태스크는 링크 해제해 재발행 대상화.
// 태스크 성공 ≠ 제출이었던 갭(2026-07-08 Gap 분석)의 근본 해결 — 에이전트 협조 없이 결정론적으로 제출.
export function ingestCompletedReportTasks(
  reportDate: string,
  db: ReportDataDb = getDb(),
): { ingested: number; unlinked: number } {
  const rows = db.prepare(`
    SELECT wr.id, wr.due_at, wr.status, wr.summary_json, wr.source_task_id,
           t.status AS task_status, t.response AS task_response,
           COALESCE(t.completed_at, t.updated_at) AS task_finished_at
    FROM work_reports wr
    JOIN tasks t ON t.id = wr.source_task_id
    WHERE wr.report_date BETWEEN date(?, '-2 days') AND ?
      AND wr.status IN ('pending','missed') AND wr.source_task_id IS NOT NULL
  `).all(reportDate, reportDate) as Array<{
    id: string;
    due_at: string;
    status: WorkReportStatus;
    summary_json: string | null;
    source_task_id: string;
    task_status: string | null;
    task_response: string | null;
    task_finished_at: string | null;
  }>;

  let ingested = 0;
  let unlinked = 0;
  const submitStmt = db.prepare(`
    UPDATE work_reports
    SET title=?, body_md=?, summary_json=?, submitted_at=?, status=?, lateness_minutes=?, updated_at=datetime('now')
    WHERE id=? AND status IN ('pending','missed')
  `);
  const unlinkStmt = db.prepare(`
    UPDATE work_reports
    SET source_task_id=NULL, updated_at=datetime('now')
    WHERE id=? AND status='pending'
  `);

  for (const row of rows) {
    const responseText = (row.task_response ?? '').trim();
    if (row.task_status === 'completed' && responseText) {
      const finishedMs = parseDbTimestamp(row.task_finished_at);
      const submittedAt = Number.isFinite(finishedMs) ? new Date(finishedMs).toISOString() : new Date().toISOString();
      const dueMs = Date.parse(row.due_at);
      const lateMs = Number.isFinite(dueMs) ? Math.max(0, Date.parse(submittedAt) - dueMs) : 0;
      const status: WorkReportStatus = lateMs > 0 ? 'late' : 'submitted';
      const latenessMinutes = lateMs > 0 ? Math.ceil(lateMs / 60_000) : 0;
      let summary: Record<string, unknown> = {};
      if (row.summary_json) {
        try {
          const prev: unknown = JSON.parse(row.summary_json);
          if (prev && typeof prev === 'object' && !Array.isArray(prev)) summary = prev as Record<string, unknown>;
        } catch { /* 파손 JSON은 새로 시작 */ }
      }
      summary.source = 'auto-ingest';
      summary.task_id = row.source_task_id;
      if (row.status === 'missed') summary.was_missed = true;
      const title = responseText.split('\n')[0].replace(/^#+\s*/, '').slice(0, 120) || null;
      const result = submitStmt.run(title, responseText, JSON.stringify(summary), submittedAt, status, latenessMinutes, row.id);
      ingested += result.changes;
    } else if (row.task_status && (UNLINK_TASK_STATUSES as readonly string[]).includes(row.task_status) && row.status === 'pending') {
      const result = unlinkStmt.run(row.id);
      unlinked += result.changes;
    }
  }

  if (ingested > 0 || unlinked > 0) {
    log.info({ reportDate, ingested, unlinked }, 'Work report task results ingested');
  }
  return { ingested, unlinked };
}

// 태스크 미연결(pending + source_task_id NULL) 팀 보고에 태스크 재발행 — issue 멱등 갭 보완:
// 최초 insert 후 태스크 생성 실패/링크 해제 시 다음 틱에서 자동 복구된다.
async function redispatchUnlinkedTeamReports(app: FastifyInstance, reportDate: string): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT wr.id AS report_id, wr.report_slot, wr.organization_id, wr.org_path, wr.redispatch_attempts,
           tm.id AS team_id, tm.name, tm.slug, tm.lead, tm.charter, tm.organization_id AS team_org_id, tm.is_active
    FROM work_reports wr
    JOIN teams tm ON tm.id = wr.team_id
    WHERE wr.report_date=? AND wr.subject_kind='team' AND wr.status='pending' AND wr.source_task_id IS NULL
      AND tm.lead IS NOT NULL AND TRIM(tm.lead) != ''
      AND wr.redispatch_attempts < ?
      AND (wr.next_redispatch_at IS NULL OR wr.next_redispatch_at <= datetime('now'))
    ORDER BY wr.due_at ASC, wr.rowid ASC
  `).all(reportDate, MAX_REDISPATCH_ATTEMPTS) as Array<{
    report_id: string;
    report_slot: WorkReportSlot;
    organization_id: string | null;
    org_path: string;
    redispatch_attempts: number;
    team_id: string;
    name: string;
    slug: string;
    lead: string;
    charter: string | null;
    team_org_id: string | null;
    is_active: number;
  }>;
  if (rows.length === 0) return;

  // 상한(5)에 걸려 이번 틱 대상에서 제외된 보고 수 — 관측용(측정 오염 제거 검증 지표).
  const cappedOut = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM work_reports wr
    JOIN teams tm ON tm.id = wr.team_id
    WHERE wr.report_date=? AND wr.subject_kind='team' AND wr.status='pending' AND wr.source_task_id IS NULL
      AND tm.lead IS NOT NULL AND TRIM(tm.lead) != '' AND wr.redispatch_attempts >= ?
  `).get(reportDate, MAX_REDISPATCH_ATTEMPTS) as { n: number }).n;
  if (cappedOut > 0) {
    log.warn({ reportDate, cappedOut, maxAttempts: MAX_REDISPATCH_ATTEMPTS }, 'Redispatch attempts capped — reports left pending for finalize to mark missed');
  }

  // 미등록 리드는 발행 불가(400 Unknown agent) — 매 틱 반복 실패 루프 방지 가드 (2026-07-08 실측).
  // 등록 복구(재시작) 시 자동으로 다시 발행된다.
  const knownAgents = new Set(agentManager.listEnabledIds());
  const eligible = rows.filter((row) => knownAgents.has(row.lead.trim()));
  const skipped = rows.length - eligible.length;
  if (skipped > 0) {
    const missing = [...new Set(rows.filter(r => !knownAgents.has(r.lead.trim())).map(r => r.lead.trim()))];
    log.warn({ reportDate, skipped, missing }, 'Redispatch skipped for unregistered team leads');
  }
  if (eligible.length === 0) return;

  // circuit breaker가 열린 리드에게 재발행하면 태스크가 즉시 "Circuit breaker open"으로 실패하고,
  // 실패한 보고는 다음 틱에서 다시 unlink→재발행되어 매 틱 새 실패 태스크를 양산하는 무한 루프가 된다
  // (2026-07-25 실측: '[업무보고 작성]' 태스크가 opencode/claude-code로 매 틱 재투입되어 분당 ~20건
  //  "Circuit breaker open" 실패 대량 생성 → 대시보드 실패 토스트 폭주). 회로가 닫혀 있거나 cooldown
  //  경과로 회로가 자가복구된 리드/실행자에게만 발행한다. 회로 회복 시 자동으로 재개된다.
  //  (초기 dispatch와 동일한 resolveExecutor 라우팅 — lead 불가용이면 가용 member/fallback으로,
  //   전원 불가용이면 스킵. half-open 프로브 누수 없는 non-mutating 판정.)
  const executorResolver = makeReportExecutorResolver(knownAgents);
  const rowExecutor = new Map<string, string>(); // report_id → 해석된 실행자
  const dispatchable = eligible.filter((row) => {
    const exec = executorResolver.resolve(row.team_id, row.lead.trim());
    if (exec) { rowExecutor.set(row.report_id, exec); return true; }
    return false;
  });
  const rerouted = executorResolver.rerouted();
  if (rerouted.length > 0) {
    log.info({ reportDate, rerouted }, 'Redispatch rerouted work-reports to healthy executor');
  }
  const breakerSkipped = eligible.length - dispatchable.length;
  if (breakerSkipped > 0) {
    log.warn({ reportDate, skipped: breakerSkipped, skippedLeads: executorResolver.skipped() }, 'Redispatch skipped — no available executor');
  }
  if (dispatchable.length === 0) return;

  // 틱당 재발행 상한(REDISPATCH_LIMIT)은 '실제 발행 가능한' 행에만 적용한다. 이전에는 SQL
  // LIMIT이 breaker·미등록 필터보다 먼저 걸려, 열린 breaker 리드의 보고가 창을 독점하면
  // 건강한 리드의 보고가 영원히 선택되지 못하고 finalize에서 missed로 확정됐다
  // (2026-07-26 실측: am 보고 중 codex 25건·agy 8건이 breaker-open으로 매 틱 LIMIT 20을
  //  소진, due_at 정렬 26위였던 ollama-리드 wr__HnEYtQh7mQzh1HI는 한 번도 재발행되지 못하고
  //  missed — team_computer-use-safety completion 5/6 하락의 직접 원인). 발행 불가 행은
  //  어차피 태스크를 만들지 않으므로 상한에서 제외해도 틱당 생성량 상한은 동일하게 유지된다.
  // 롤백: SELECT에 `LIMIT ?`(+ REDISPATCH_LIMIT 바인딩)를 되돌리고 아래 slice를 제거하면 이전 동작.
  const batch = dispatchable.slice(0, REDISPATCH_LIMIT);
  if (batch.length < dispatchable.length) {
    log.info(
      { reportDate, dispatchable: dispatchable.length, deferred: dispatchable.length - batch.length },
      'Redispatch capped for this tick — remainder retried next tick',
    );
  }

  const candidates: ReportTaskCandidate[] = batch.map((row) => {
    const team: TeamRow = {
      id: row.team_id,
      organization_id: row.team_org_id,
      name: row.name,
      slug: row.slug,
      lead: row.lead,
      charter: row.charter,
      is_active: row.is_active,
    };
    const snapshot: SubjectSnapshot = {
      organizationId: row.organization_id,
      teamId: row.team_id,
      orgRootId: null,
      orgParentId: null,
      orgPath: row.org_path,
      orgDepth: 0,
      unitLevel: 'team',
      active: true,
    };
    return {
      reportId: row.report_id,
      subjectKind: 'team' as const,
      subjectId: row.team_id,
      teamId: row.team_id,
      organizationId: row.organization_id,
      lead: rowExecutor.get(row.report_id) ?? row.lead.trim(),
      prompt: buildReportPrompt(team, reportDate, row.report_slot, snapshot),
    };
  });

  const result = await createTeamReportTasks(app, candidates);
  log.info({
    reportDate,
    redispatched: result.created,
    failed: result.failed,
    deferred: result.deferred,
  }, 'Unlinked work-report tasks redispatched');

  // P0-7: 이번 틱에 실제로 재발행을 시도한 보고(batch)만 attempts+1 + 지수 백오프 적용.
  // 발행 자체가 202를 반환해도(생성된 태스크가 나중에 CB open으로 실패) 다음 틱에 다시
  // unlink→여기로 돌아오므로, 시도 횟수는 "재발행을 시도했는가"를 기준으로 센다.
  const backoffStmt = db.prepare(`
    UPDATE work_reports
    SET redispatch_attempts = redispatch_attempts + 1,
        next_redispatch_at = datetime('now', ?),
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const attemptedReportIds = new Set(result.attemptedReportIds);
  for (const row of batch) {
    if (!attemptedReportIds.has(row.report_id)) continue;
    const backoffMs = Math.min(
      REDISPATCH_BACKOFF_BASE_MS * 2 ** row.redispatch_attempts,
      REDISPATCH_BACKOFF_MAX_MS,
    );
    backoffStmt.run(`+${Math.round(backoffMs / 1000)} seconds`, row.report_id);
  }
}

async function redispatchUnlinkedOrgReports(app: FastifyInstance, reportDate: string): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT wr.id AS report_id, wr.report_slot, wr.organization_id, wr.org_path, wr.redispatch_attempts,
           o.id AS org_id, o.name, o.slug, o.manager, o.is_active
    FROM work_reports wr
    JOIN organizations o ON o.id = wr.subject_id
    WHERE wr.report_date=? AND wr.subject_kind='organization' AND wr.status='pending' AND wr.source_task_id IS NULL
      AND wr.redispatch_attempts < ?
      AND (wr.next_redispatch_at IS NULL OR wr.next_redispatch_at <= datetime('now'))
    ORDER BY wr.due_at ASC, wr.rowid ASC
  `).all(reportDate, MAX_REDISPATCH_ATTEMPTS) as Array<{
    report_id: string;
    report_slot: WorkReportSlot;
    organization_id: string;
    org_path: string;
    redispatch_attempts: number;
    org_id: string;
    name: string;
    slug: string;
    manager: string | null;
    is_active: number;
  }>;
  if (rows.length === 0) return;

  const cappedOut = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM work_reports wr
    JOIN organizations o ON o.id = wr.subject_id
    WHERE wr.report_date=? AND wr.subject_kind='organization' AND wr.status='pending' AND wr.source_task_id IS NULL
      AND wr.redispatch_attempts >= ?
  `).get(reportDate, MAX_REDISPATCH_ATTEMPTS) as { n: number }).n;
  if (cappedOut > 0) {
    log.warn({ reportDate, cappedOut, maxAttempts: MAX_REDISPATCH_ATTEMPTS }, 'Org redispatch attempts capped — reports left pending for finalize');
  }

  const knownAgents = new Set(agentManager.listEnabledIds());
  const executorResolver = makeReportExecutorResolver(knownAgents);
  const snapshots = buildOrgSnapshots(
    db.prepare(`SELECT id, name, slug, parent_id, manager, is_active FROM organizations`).all() as OrganizationRow[],
  );
  const dispatchable: typeof rows = [];
  const rowExecutor = new Map<string, string>();
  for (const row of rows) {
    const org: OrganizationRow = {
      id: row.org_id, name: row.name, slug: row.slug,
      parent_id: null, manager: row.manager, is_active: row.is_active,
    };
    const exec = resolveOrgReportExecutor(org, knownAgents, executorResolver);
    if (exec) {
      rowExecutor.set(row.report_id, exec);
      dispatchable.push(row);
    }
  }

  const batch = dispatchable.slice(0, REDISPATCH_LIMIT);
  if (batch.length < dispatchable.length) {
    log.info(
      { reportDate, dispatchable: dispatchable.length, deferred: dispatchable.length - batch.length },
      'Org redispatch capped for this tick — remainder retried next tick',
    );
  }

  const candidates: ReportTaskCandidate[] = batch.map((row) => {
    const snapshot = snapshots.get(row.organization_id)!;
    const org: OrganizationRow = {
      id: row.org_id, name: row.name, slug: row.slug,
      parent_id: null, manager: row.manager, is_active: row.is_active,
    };
    return {
      reportId: row.report_id,
      subjectKind: 'organization' as const,
      subjectId: row.org_id,
      teamId: null,
      organizationId: row.organization_id,
      lead: rowExecutor.get(row.report_id) ?? 'ollama',
      prompt: buildOrganizationReportPrompt(
        org,
        reportDate,
        row.report_slot,
        snapshot,
        buildOrganizationDataContext(row.org_id),
      ),
    };
  });

  const result = await createTeamReportTasks(app, candidates);
  log.info({
    reportDate,
    redispatched: result.created,
    failed: result.failed,
    deferred: result.deferred,
  }, 'Unlinked org work-report tasks redispatched');

  const backoffStmt = db.prepare(`
    UPDATE work_reports
    SET redispatch_attempts = redispatch_attempts + 1,
        next_redispatch_at = datetime('now', ?),
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const attemptedReportIds = new Set(result.attemptedReportIds);
  for (const row of batch) {
    if (!attemptedReportIds.has(row.report_id)) continue;
    const backoffMs = Math.min(
      REDISPATCH_BACKOFF_BASE_MS * 2 ** row.redispatch_attempts,
      REDISPATCH_BACKOFF_MAX_MS,
    );
    backoffStmt.run(`+${Math.round(backoffMs / 1000)} seconds`, row.report_id);
  }
}

function hasAnyReports(reportDate: string, reportSlot: WorkReportSlot): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM work_reports
    WHERE report_date=? AND report_slot=?
  `).get(reportDate, reportSlot) as { count: number };
  return row.count > 0;
}

async function reconcileScheduledRuns(app: FastifyInstance): Promise<void> {
  const now = new Date();
  const reportDate = formatKstDate(now);
  const amIssueAt = buildKstDateTime(reportDate, 9, 0);
  const pmIssueAt = buildKstDateTime(reportDate, 14, 0);
  const amFinalizeAt = getFinalizeAfter(reportDate, 'am');
  const pmFinalizeAt = getFinalizeAfter(reportDate, 'pm');

  if (now >= amIssueAt && !hasAnyReports(reportDate, 'am')) {
    await issueWorkReports(app, reportDate, 'am');
  }
  if (now >= pmIssueAt && !hasAnyReports(reportDate, 'pm')) {
    await issueWorkReports(app, reportDate, 'pm');
  }
  // 완료 태스크 응답 수집(auto-submit) — finalize(missed 확정)보다 먼저 수행해
  // 이미 도착한 결과가 missed로 오분류되지 않게 한다. 실패 태스크는 링크 해제 후 재발행.
  ingestCompletedReportTasks(reportDate);
  await redispatchUnlinkedTeamReports(app, reportDate);
  await redispatchUnlinkedOrgReports(app, reportDate);
  if (now >= amFinalizeAt) {
    finalizeMissedWorkReports(reportDate, 'am', now);
  }
  if (now >= pmFinalizeAt) {
    finalizeMissedWorkReports(reportDate, 'pm', now);
  }
}

// 중복 기동 가드 — start를 여러 번 호출해도 interval이 누적되지 않게 (리뷰 지적 2026-07-08)
let schedulerCleanup: (() => void) | null = null;
const schedulerRunGate = new WorkReportSchedulerRunGate();

export function startWorkReportScheduler(app: FastifyInstance): () => void {
  if (schedulerCleanup) {
    log.warn('Work-report scheduler already running — reusing existing instance');
    return schedulerCleanup;
  }
  const runReconciliation = (source: 'initial' | 'tick') => {
    void schedulerRunGate.run(() => reconcileScheduledRuns(app))
      .then((started) => {
        if (!started) {
          log.warn({ source }, 'Work-report scheduler reconciliation skipped — previous run still active');
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ error: message, source }, 'Work-report scheduler reconciliation failed');
      });
  };

  runReconciliation('initial');

  const timer = setInterval(() => {
    runReconciliation('tick');
  }, POLL_INTERVAL_MS);
  timer.unref();
  log.info({ intervalMs: POLL_INTERVAL_MS }, 'Work-report scheduler started');

  schedulerCleanup = () => {
    clearInterval(timer);
    schedulerCleanup = null;
    log.info('Work-report scheduler stopped');
  };
  return schedulerCleanup;
}
