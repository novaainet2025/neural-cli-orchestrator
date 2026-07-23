import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';
import { agentManager } from '../agent/agent-manager.js';

const log = createLogger('work-report-scheduler');
const KST_OFFSET_HOURS = 9;
const KST_TIMEZONE = 'Asia/Seoul';
const POLL_INTERVAL_MS = 60_000;
const MISSED_GRACE_MS = 30 * 60 * 1000;
// 태스크 발행 간 지연 — 일괄발사가 단일스레드 로컬 LLM 서버(mlx)를 크래시시킨 실측(2026-07-08 ↺6) 완화
const TASK_DISPATCH_STAGGER_MS = 5_000;
// 링크 해제(실패)·미발행 보고의 태스크 재발행 상한 (틱당)
const REDISPATCH_LIMIT = 20;

export type WorkReportSlot = 'am' | 'pm';
export type WorkReportStatus = 'pending' | 'submitted' | 'late' | 'missed' | 'waived';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
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

interface SubjectSnapshot {
  organizationId: string | null;
  teamId: string | null;
  orgRootId: string | null;
  orgParentId: string | null;
  orgPath: string;
  orgDepth: number;
  unitLevel: 'company' | 'department' | 'team';
  active: boolean;
}

interface ReportTaskCandidate {
  reportId: string;
  teamId: string;
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
const SNS_TEAM_SLUGS = new Set(['content-planning', 'sns', 'quality-audit']);

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function compactContextText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength)}…`;
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

export interface WorkReportIssueResult {
  reportDate: string;
  reportSlot: WorkReportSlot;
  created: number;
  existing: number;
  pending: number;
  waived: number;
  teamTasksCreated: number;
  teamTasksFailed: number;
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

async function createTeamReportTasks(app: FastifyInstance, candidates: ReportTaskCandidate[]): Promise<{ created: number; failed: number }> {
  const db = getDb();
  let created = 0;
  let failed = 0;

  let first = true;
  for (const candidate of candidates) {
    // 스태거: 동시/연속 발사로 단일스레드 로컬 서버가 죽는 것 방지 (첫 건은 즉시)
    if (!first) {
      await new Promise<void>((resolve) => setTimeout(resolve, TASK_DISPATCH_STAGGER_MS));
    }
    first = false;
    const response = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: candidate.lead,
        prompt: candidate.prompt,
        mode: 'task',
        callerAgentId: 'work-report-scheduler',
        metadata: {
          projectDir: resolveInternalProjectDir(),
          allowProviderFailover: true,
          workReportId: candidate.reportId,
          teamId: candidate.teamId,
          organizationId: candidate.organizationId,
        },
      },
    });

    if (response.statusCode !== 202) {
      failed += 1;
      log.warn({
        reportId: candidate.reportId,
        teamId: candidate.teamId,
        lead: candidate.lead,
        statusCode: response.statusCode,
        payload: response.body,
      }, 'Failed to create team work-report task');
      continue;
    }

    const body = response.json() as { taskId?: string };
    if (!body.taskId) {
      failed += 1;
      log.warn({ reportId: candidate.reportId, teamId: candidate.teamId }, 'Task route returned without taskId');
      continue;
    }

    db.prepare(`
      UPDATE work_reports
      SET source_task_id=?, updated_at=datetime('now')
      WHERE id=? AND source_task_id IS NULL
    `).run(body.taskId, candidate.reportId);
    db.prepare(`
      UPDATE tasks
      SET team_id=?, updated_at=datetime('now')
      WHERE id=?
    `).run(candidate.teamId, body.taskId);
    created += 1;
  }

  return { created, failed };
}

export async function issueWorkReports(
  app: FastifyInstance,
  reportDate = formatKstDate(),
  reportSlot: WorkReportSlot = getDefaultWorkReportSlot(),
): Promise<WorkReportIssueResult> {
  const db = getDb();
  const organizations = db.prepare(`
    SELECT id, name, slug, parent_id, is_active
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
      const result = insert.run(
        createId('wr'),
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
        if (status === 'pending' && team.lead?.trim()) {
          taskCandidates.push({
            reportId,
            teamId: team.id,
            organizationId: snapshot.organizationId,
            lead: team.lead.trim(),
            prompt: buildReportPrompt(team, reportDate, reportSlot, snapshot),
          });
        }
      }
    }
  });

  tx();

  const taskResult = await createTeamReportTasks(app, taskCandidates);
  const existing = organizations.length + teams.length - created;
  log.info({
    reportDate,
    reportSlot,
    created,
    existing,
    pending,
    waived,
    teamTasksCreated: taskResult.created,
    teamTasksFailed: taskResult.failed,
  }, 'Work reports issued');

  return {
    reportDate,
    reportSlot,
    created,
    existing,
    pending,
    waived,
    teamTasksCreated: taskResult.created,
    teamTasksFailed: taskResult.failed,
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
function ingestCompletedReportTasks(reportDate: string): { ingested: number; unlinked: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT wr.id, wr.due_at, wr.status, wr.summary_json, wr.source_task_id,
           t.status AS task_status, t.response AS task_response,
           COALESCE(t.completed_at, t.updated_at) AS task_finished_at
    FROM work_reports wr
    JOIN tasks t ON t.id = wr.source_task_id
    WHERE wr.report_date=? AND wr.status IN ('pending','missed') AND wr.source_task_id IS NOT NULL
  `).all(reportDate) as Array<{
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
    } else if (row.task_status && ['failed', 'cancelled', 'timed_out'].includes(row.task_status) && row.status === 'pending') {
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
    SELECT wr.id AS report_id, wr.report_slot, wr.organization_id, wr.org_path,
           tm.id AS team_id, tm.name, tm.slug, tm.lead, tm.charter, tm.organization_id AS team_org_id, tm.is_active
    FROM work_reports wr
    JOIN teams tm ON tm.id = wr.team_id
    WHERE wr.report_date=? AND wr.subject_kind='team' AND wr.status='pending' AND wr.source_task_id IS NULL
      AND tm.lead IS NOT NULL AND TRIM(tm.lead) != ''
    ORDER BY wr.due_at ASC
    LIMIT ?
  `).all(reportDate, REDISPATCH_LIMIT) as Array<{
    report_id: string;
    report_slot: WorkReportSlot;
    organization_id: string | null;
    org_path: string;
    team_id: string;
    name: string;
    slug: string;
    lead: string;
    charter: string | null;
    team_org_id: string | null;
    is_active: number;
  }>;
  if (rows.length === 0) return;

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

  const candidates: ReportTaskCandidate[] = eligible.map((row) => {
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
      teamId: row.team_id,
      organizationId: row.organization_id,
      lead: row.lead.trim(),
      prompt: buildReportPrompt(team, reportDate, row.report_slot, snapshot),
    };
  });

  const result = await createTeamReportTasks(app, candidates);
  log.info({ reportDate, redispatched: result.created, failed: result.failed }, 'Unlinked work-report tasks redispatched');
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
  if (now >= amFinalizeAt) {
    finalizeMissedWorkReports(reportDate, 'am', now);
  }
  if (now >= pmFinalizeAt) {
    finalizeMissedWorkReports(reportDate, 'pm', now);
  }
}

// 중복 기동 가드 — start를 여러 번 호출해도 interval이 누적되지 않게 (리뷰 지적 2026-07-08)
let schedulerCleanup: (() => void) | null = null;

export function startWorkReportScheduler(app: FastifyInstance): () => void {
  if (schedulerCleanup) {
    log.warn('Work-report scheduler already running — reusing existing instance');
    return schedulerCleanup;
  }
  void reconcileScheduledRuns(app).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ error: message }, 'Initial work-report scheduler reconciliation failed');
  });

  const timer = setInterval(() => {
    void reconcileScheduledRuns(app).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ error: message }, 'Work-report scheduler tick failed');
    });
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
