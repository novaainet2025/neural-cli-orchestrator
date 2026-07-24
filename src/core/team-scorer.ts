import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';

export const TEAM_SCORE_TARGET = 90;

export type TeamScoreGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
export type TeamScoreSample = '48h' | '7d' | 'all';

export interface TeamScore {
  teamId: string;
  slug: string;
  name: string;
  organizationId: string | null;
  score: number;
  grade: TeamScoreGrade;
  completion: number;
  n: number;
  sample: TeamScoreSample;
}

export interface OrganizationScore {
  orgId: string;
  name: string;
  score: number;
  grade: TeamScoreGrade;
  teams: number;
  belowTarget: Array<{
    teamId: string;
    slug: string;
    name: string;
    score: number;
    grade: TeamScoreGrade;
  }>;
}

export function recordTeamDiagnosticOutcome(
  database: Database.Database,
  taskId: string,
  response: string,
): boolean {
  const task = database.prepare(`
    SELECT assigned_to, metadata_json
    FROM tasks
    WHERE id = ?
  `).get(taskId) as { assigned_to: string | null; metadata_json: string | null } | undefined;
  if (!task?.metadata_json || !response) return false;

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(task.metadata_json) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    metadata.diagnosticKind !== 'team-score'
    || typeof metadata.diagnosticTargetTeamId !== 'string'
    || typeof metadata.diagnosticTargetSlug !== 'string'
    || typeof metadata.diagnosticScore !== 'number'
  ) {
    return false;
  }

  const result = database.prepare(`
    INSERT OR IGNORE INTO improvement_notes
      (id, category, problem, root_cause, fix, verified_at, agent, severity, tags)
    VALUES (?, 'team-quality', ?, '', ?, datetime('now'), ?, ?, ?)
  `).run(
    `team-score-diagnostic:${taskId}`,
    `자동 품질진단 산출물: ${metadata.diagnosticTargetSlug} (${metadata.diagnosticScore}점)`,
    response,
    task.assigned_to ?? 'unknown',
    metadata.diagnosticScore < 55 ? 'high' : 'medium',
    JSON.stringify([
      'team-score-diagnostic',
      `team:${metadata.diagnosticTargetTeamId}`,
      `slug:${metadata.diagnosticTargetSlug}`,
      `task:${taskId}`,
    ]),
  );
  return result.changes > 0;
}

interface TeamAggregateRow {
  team_id: string;
  slug: string;
  name: string;
  organization_id: string | null;
  terminal_48h: number;
  completed_48h: number;
  terminal_7d: number;
  completed_7d: number;
  terminal_all: number;
  completed_all: number;
}

interface SelectedSample {
  completion: number;
  n: number;
  sample: TeamScoreSample;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function gradeTeamScore(score: number): TeamScoreGrade {
  if (score >= 95) return 'S';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

function selectCurrentSample(row: TeamAggregateRow): SelectedSample {
  let n: number;
  let completed: number;
  let sample: TeamScoreSample;

  if (row.terminal_48h >= 2) {
    n = row.terminal_48h;
    completed = row.completed_48h;
    sample = '48h';
  } else if (row.terminal_7d >= 2) {
    n = row.terminal_7d;
    completed = row.completed_7d;
    sample = '7d';
  } else {
    n = row.terminal_all;
    completed = row.completed_all;
    sample = 'all';
  }

  return {
    completion: n > 0 ? round1((completed / n) * 100) : 0,
    n,
    sample,
  };
}

function computeVolume(n: number, maxN: number): number {
  if (n <= 0 || maxN <= 0) return 0;
  if (maxN === 1) return 100;
  return (100 * Math.log10(n)) / Math.log10(maxN);
}

// 인프라 기인 실패(부팅 orphan 복구·graceful shutdown 드레인 타임아웃)는 팀 산출물
// 품질 신호가 아니라 서버 재시작 이벤트다. src/index.ts가 이들을 'orphaned:%' 접두
// error로 마킹한다('orphaned: server restart …', 'orphaned: graceful shutdown timeout').
// completion 분모에 이런 실패를 넣으면 팀이 재시작으로 인해 부당하게 감점된다
// (실측 2026-07-24: 최근 48h에 38개 팀·64건 orphan-failed). 따라서 terminal 집계에서만
// 제외한다. 정상 품질 실패(unknown/timeout/lease_expired 등)는 그대로 카운트한다.
// 롤백: 아래 3개 terminal CASE에서 ORPHAN_EXCLUSION 조건을 제거하면 정확히 이전 동작.
const ORPHAN_EXCLUSION = `AND (k.error IS NULL OR k.error NOT LIKE 'orphaned:%')`;

export function computeTeamScores(database: Database.Database = getDb()): TeamScore[] {
  const rows = database.prepare(`
    SELECT
      t.id AS team_id,
      t.slug,
      t.name,
      t.organization_id,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          AND julianday(k.created_at) >= julianday('now','-48 hours')
          ${ORPHAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_48h,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-48 hours')
        THEN 1 ELSE 0 END), 0) AS completed_48h,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          AND julianday(k.created_at) >= julianday('now','-7 days')
          ${ORPHAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_7d,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-7 days')
        THEN 1 ELSE 0 END), 0) AS completed_7d,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          ${ORPHAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_all,
      COALESCE(SUM(CASE WHEN k.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_all
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN tasks k ON k.team_id = t.id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
    GROUP BY t.id, t.slug, t.name, t.organization_id
    ORDER BY t.name ASC, t.id ASC
  `).all() as TeamAggregateRow[];

  const selected = rows.map((row) => ({ row, sample: selectCurrentSample(row) }));
  const maxN = selected.reduce((maximum, item) => Math.max(maximum, item.sample.n), 0);

  return selected.map(({ row, sample }) => {
    const volume = computeVolume(sample.n, maxN);
    const score = round1((0.9 * sample.completion) + (0.1 * volume));
    return {
      teamId: row.team_id,
      slug: row.slug,
      name: row.name,
      organizationId: row.organization_id,
      score,
      grade: gradeTeamScore(score),
      completion: sample.completion,
      n: sample.n,
      sample: sample.sample,
    };
  });
}

export function computeOrganizationScores(
  database: Database.Database = getDb(),
  teamScores: TeamScore[] = computeTeamScores(database),
): OrganizationScore[] {
  const organizations = database.prepare(`
    SELECT id, name
    FROM organizations
    WHERE is_active = 1
    ORDER BY name ASC, id ASC
  `).all() as Array<{ id: string; name: string }>;

  return organizations.map((organization) => {
    const scores = teamScores.filter((team) => team.organizationId === organization.id);
    const score = scores.length > 0
      ? round1(scores.reduce((total, team) => total + team.score, 0) / scores.length)
      : 0;
    return {
      orgId: organization.id,
      name: organization.name,
      score,
      grade: gradeTeamScore(score),
      teams: scores.length,
      belowTarget: scores
        .filter((team) => team.score <= TEAM_SCORE_TARGET)
        .map(({ teamId, slug, name, score: teamScore, grade }) => ({
          teamId,
          slug,
          name,
          score: teamScore,
          grade,
        })),
    };
  });
}
