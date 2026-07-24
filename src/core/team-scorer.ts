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

// 인프라 기인 실패(부팅 orphan 복구·graceful shutdown 드레인 타임아웃·에이전트 가용성
// 서킷브레이커·NCO 게이트웨이 다운)는 팀 산출물 품질 신호가 아니라 인프라 이벤트다.
//  - src/index.ts가 재시작 실패를 'orphaned:%' 접두 error로 마킹한다
//    ('orphaned: server restart …', 'orphaned: graceful shutdown timeout').
//  - src/agent/agent-manager.ts:135가 에이전트 서킷이 열려 있으면 태스크 실행 *이전*에
//    'Circuit breaker open for agent …' error로 즉시 실패시킨다(iterations:0, durationMs:0).
//    즉 팀 작업은 한 줄도 실행되지 않았고, 이는 에이전트 오프라인/레이트리밋 가용성 신호다.
//  - 성과보고·목표설정처럼 localhost:6200(NCO 게이트웨이)로 실제 HTTP POST를 요구하는
//    태스크는, 서버가 다운이면 에이전트가 정직하게 'curl: (7) … Couldn't connect to server'
//    를 보고하고 실패로 마킹된다. 이때 error는 일반 품질게이트값
//    'unknown: failure pattern in output'이며 실제 원인(연결거부)은 response 본문에만 있다.
//    NCO 게이트웨이가 죽어 있으면 어떤 팀도 성공할 수 없으므로 이는 서킷브레이커와 동일한
//    가용성 이벤트이지 팀 품질 신호가 아니다.
// completion 분모에 이런 실패를 넣으면 팀이 인프라 이벤트로 부당하게 감점된다
// (실측 2026-07-24: 최근 48h에 orphan 64건, 서킷브레이커 63건·14개 팀. team_tech-port-02
//  -safety-license는 5건 실패 중 4건이 동일 workReportId wr_ZKslprd1NUvsf1Fg를 오프라인
//  claude-code로 팬아웃한 서킷브레이커 실패였고, 같은 work report의 다른 사본은 codex가
//  완료(task_8L00qmKQxhiqO41O)했다). team_kd-harness는 48h 2건 모두 게이트웨이 다운
//  연결거부(task_dpJ7AB81vGJ-tpGX·task_jJPEz5GR9JwxISMP)로 completion=0% 오탐이었다.
//  따라서 terminal 집계에서만 제외한다. 정상 품질 실패(unknown/timeout/lease_expired 등)는
//  그대로 카운트한다.
// 안전 불변식: 연결거부 제외는 실패-클래스 error('unknown: failure pattern in output')를
//  요구하고 status<>'completed'로 이중 가드한다. completed 태스크는 이 error를 절대 갖지
//  않으므로(실측 0건) completed⊆terminal 불변식이 유지되어 completion>100% 회귀가 없다.
//  단순히 response 텍스트만 매칭하면 완료 보고서가 과거 연결오류를 인용했거나 다른 로컬
//  서비스 연결에 실패한 태스크까지 잘못 빠지므로 반드시 error·status·NCO 포트를 함께 건다.
// 롤백: 아래 3개 terminal CASE에서 INFRA_EXCLUSION 조건을 제거하면 정확히 이전 동작.
//  게이트웨이-다운 절만 되돌리려면 아래 `AND NOT ( … )` 블록만 삭제한다.
const INFRA_EXCLUSION = `AND (k.error IS NULL OR (k.error NOT LIKE 'orphaned:%' AND k.error NOT LIKE 'Circuit breaker open%'))
    AND NOT (
      k.status <> 'completed'
      AND COALESCE(k.error, '') LIKE 'unknown: failure pattern in output%'
      AND (COALESCE(k.response, '') LIKE '%Failed to connect to localhost port 6200%'
           OR COALESCE(k.response, '') LIKE '%Failed to connect to 127.0.0.1 port 6200%')
    )`;

// commander-perfgoal은 팀의 실제 감사/구현 산출물이 아니라 목표/성과보고를 NCO 제어면에
// 입력하는 관리 태스크다('[성과보고·목표설정 입력 지시]' 프롬프트로 POST /api/goals 수행).
// 에이전트는 필수 목표값(targetValue·direction·unit 등)이 주입되지 않으면 조작 금지 규칙에
// 따라 정상적으로 거부하는데, 이 거부·연결거부·lease 만료가 팀 charter 품질 실패로 오계상된다.
// team_kd-memory에서 처음 관찰됐으나(표본 3건 전부 이 유형), 실측 2026-07-24 결과 거의 모든
// 팀에 동일 패턴이 존재한다(team_quality-audit task_SMVL4-GzMPj56Wtg: ollama가 미주입 필수값을
// 정상 거부 → completion 6/7=85.7% 오탐; 제외 시 6/6=100%로 실제 감사 품질을 반영).
// spawned_by_cli='commander-perfgoal'은 perf-goal 제어면 전용 스포너라 team charter 작업과
// 겹치지 않으므로 팀 무관하게(team-agnostic) 제외한다. completed/terminal 양쪽에 같은 조건을
// 적용해 completed⊆terminal 불변식을 보존한다(실측: 활성 팀 전수 comp_all>term_all 0건).
// 롤백: 아래 조건을 team_id='team_kd-memory'로 다시 좁히거나 6개 삽입부에서 제거하면 이전 동작.
const CONTROL_PLANE_PERFGOAL_EXCLUSION = `AND NOT (
      COALESCE(k.spawned_by_cli, '') = 'commander-perfgoal'
    )`;

// lease_expired 중 '에이전트가 리스를 잡았지만 한 줄도 실행하지 않은' 케이스는 팀 품질
// 실패가 아니라 서킷브레이커와 동일한 에이전트 가용성/생존(liveness) 이벤트다.
//  - 에이전트가 태스크를 acked(리스 선점)했으나 last_heartbeat_at이 NULL이면 실행 루프가
//    단 한 번의 heartbeat도 남기지 못하고 lease_expires_at에 만료된 것이다. response·
//    result_json 모두 비어 있어 산출물이 전혀 없다 = 오프라인/행/레이트리밋으로 즉시 사망.
//  - 반면 heartbeat가 하나라도 있는 lease_expired는 에이전트가 실제로 작업하다 시간초과된
//    것이므로 정상 품질/성능 실패로 그대로 카운트한다(실측 2026-07-24 48h: heartbeat 있는
//    lease_expired 4건은 research-analysis/kd-memory의 ollama·nvidia 실작업 타임아웃).
//  실측 근거: team_triad-command-judge는 48h 표본 6건 중 3건이 opencode에 acked됐으나
//   heartbeat 0·response NULL로 만료된 never-ran(task_rhnUFXmH8w792YZR·task_7k_Ok1CKnoPTTPlX
//   ·task_HCgj8ICR22wc7cIn, 모두 work-report-scheduler 발) → completion 50%(3/6) 오탐.
//   never-ran 3건 제외 시 completion=3/3=100%로 팀 품질을 정확히 반영한다. 48h 전체로는
//   acked+heartbeat-NULL lease_expired 9건이 동일 패턴이다.
// 안전 불변식: 조건에 k.status='lease_expired'를 명시하므로 completed 행은 절대 제외되지
//  않는다(completed는 lease_expired가 될 수 없다). 따라서 completed⊆terminal이 유지되어
//  completion>100% 회귀가 없다. 게다가 acked_at IS NOT NULL을 요구해 '리스를 잡은 뒤
//  죽은' 케이스로 한정한다. 롤백: 아래 3개 terminal CASE에서 이 조건만 제거하면 이전 동작.
const LEASE_NEVER_RAN_EXCLUSION = `AND NOT (
      k.status = 'lease_expired'
      AND k.acked_at IS NOT NULL
      AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at = '')
    )`;

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
          ${INFRA_EXCLUSION}
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_48h,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-48 hours')
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_48h,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          AND julianday(k.created_at) >= julianday('now','-7 days')
          ${INFRA_EXCLUSION}
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_7d,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-7 days')
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_7d,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          ${INFRA_EXCLUSION}
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_all,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_all
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
