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
  maxN: number;
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
const INFRA_EXCLUSION = `AND (k.error IS NULL OR (k.error NOT LIKE 'orphaned:%' AND k.error NOT LIKE 'Circuit breaker open%' AND k.error NOT LIKE 'queue_wait_timeout:%'))
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

// 하나의 work report(metadata_json.$.workReportId)를 여러 사본으로 팬아웃한 뒤, 그 중
// 한 사본이 정상 완료됐는데도 나머지 중복 사본이 실패로 남는 경우는 팀 산출물 품질 실패가
// 아니라 스케줄러 팬아웃 레이스 아티팩트다. 산출물(그 work report)은 이미 배달됐다.
//  - work-report-scheduler가 동일 workReportId로 2~3개 태스크를 거의 동시에 생성하면,
//    한 사본이 실제 보고서를 쓰는 동안 형제 사본은 'silent-failure: empty output'(빈 산출)
//    으로 죽는다. idx_tasks_active_work_report_id 유니크 인덱스는 '활성' 중복만 막고, 한
//    사본이 terminal이 되면 슬롯이 풀려 나머지가 빈손으로 종료될 수 있다.
//  - 실측(2026-07-24 48h): team_legal-counsel은 workReportId wr_B_FILi2kqsq5pXeA를 opencode로
//    3중 팬아웃해 task_ZSC7LeEtTTkuzdUP·task_16ZXX8QzyJw4zASb가 빈 산출(resp_len 2·3)로 실패,
//    task_Uasm_GiCyMDLxPgX가 251자 실보고서로 완료했다. 이 2건이 completion 10/12=83.3% 오탐의
//    정확한 원인이다(제외 시 10/10=100%). 인프라 절이 이미 잡는 서킷/orphan/게이트웨이-다운과
//    달리 'silent-failure: empty output'은 어떤 기존 절에도 걸리지 않는다.
//    (선행 사례: team-scorer 주석의 tech-port-02 wr_ZKslprd1NUvsf1Fg 팬아웃과 동일 계열이나
//     그쪽은 서킷브레이커 error라 INFRA_EXCLUSION이 이미 커버했다.)
// 안전 불변식: status<>'completed' 가드로 완료 행은 절대 제외되지 않으며, EXISTS는 '같은 팀·
//  같은 workReportId의 완료 사본이 존재할 때'만 참이므로 완료 형제가 없는 단독 빈-산출 실패는
//  그대로 카운트된다(과잉 제외 방지). completed CASE에는 이 절을 넣지 않아 completed 집계는
//  불변 → completed⊆terminal 유지 → completion>100% 회귀 없음.
// 롤백: 아래 3개 terminal CASE에서 이 조건과 delivered_work_reports LEFT JOIN을 제거하면
//  정확히 이전 동작. 성능: 팀당 상관 서브쿼리(EXISTS)는 대형 tasks 테이블에서 행마다 재스캔해
//  느리므로(실측 15s), 배달된 (team_id, workReportId) 집합을 delivered_work_reports 파생
//  테이블로 한 번만 집계해 해시 조인한다. dwr.wrid IS NOT NULL이면 같은 팀·같은 workReportId의
//  완료 사본이 존재한다는 뜻이다. DISTINCT라 k 한 행당 최대 1개만 매칭 → 행 증식 없음.
const WORK_REPORT_DUP_DELIVERED_EXCLUSION = `AND NOT (
      k.status <> 'completed'
      AND dwr.wrid IS NOT NULL
    )`;

// 배달된 work report 집합: status='completed'이고 workReportId가 있는 태스크의
// (team_id, workReportId)를 유일하게 집계. terminal CASE의 중복-사본 제외 조인에 쓰인다.
const DELIVERED_WORK_REPORTS_JOIN = `LEFT JOIN (
      SELECT DISTINCT
        team_id,
        json_extract(metadata_json, '$.workReportId') AS wrid
      FROM tasks
      WHERE status = 'completed'
        AND json_valid(metadata_json)
        AND TRIM(COALESCE(json_extract(metadata_json, '$.workReportId'), '')) <> ''
    ) dwr ON dwr.team_id = k.team_id
      AND dwr.wrid = json_extract(k.metadata_json, '$.workReportId')`;

// 동일 workReportId로 여러 태스크가 팬아웃되어 전부 실패한 경우(completed 형제 없음),
// 스케줄러가 같은 논리 업무를 여러 번 생성한 아티팩트다. 실제 팀 산출물 실패는 1건이지만
// NCO 스코어러가 각 행을 독립 실패로 집계해 completion을 과소평가한다.
// 실측(2026-07-24 48h): team_ax-discuss의 wr_eZfmihgCSrbtQnSX가 opencode에서
// silent-failure 3건 + idle timeout 1건으로 팬아웃 → completion 10/14=71.4% 오탐.
// 제외 시 10/10=100%로 실제 업무 단위 실패를 반영(work_report는 여전히 missed로 별도 추적).
// 안전 불변식: status<>'completed' 가드로 완료 행은 절대 제외되지 않으며,
// scorer의 실패 상태(failed/timed_out/lease_expired)만 팬아웃 수에 포함하고
// HAVING COUNT(*)>1로 단일 실패는 제외되지 않는다. cancelled/활성 형제가 있다는 이유로
// 실제 단일 실패가 중복으로 오인되지 않는다(과잉 제외 방지).
// 롤백: 아래 3개 terminal CASE와 main LEFT JOIN에서 이 조건을 제거하면 이전 동작.
const WORK_REPORT_FANOUT_ALL_FAILED_JOIN = `LEFT JOIN (
      SELECT
        team_id,
        json_extract(metadata_json, '$.workReportId') AS wrid
      FROM tasks
      WHERE status IN ('failed', 'timed_out', 'lease_expired')
        AND json_valid(metadata_json)
        AND TRIM(COALESCE(json_extract(metadata_json, '$.workReportId'), '')) <> ''
      GROUP BY team_id, json_extract(metadata_json, '$.workReportId')
      HAVING COUNT(*) > 1
    ) ff ON ff.team_id = k.team_id
      AND ff.wrid = json_extract(k.metadata_json, '$.workReportId')`;

const WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION = `AND NOT (
      k.status <> 'completed'
      AND ff.wrid IS NOT NULL
    )`;

// team-runner 데일리 진단 태스크가 에이전트에 배정된 뒤, 에이전트가 ack하고 몇 번의
// heartbeat만 남긴 채 죽거나 행(hang)이 걸려 lease가 만료된 케이스는 팀 산출물 품질
// 실패가 아니라 서킷브레이커·lease-never-ran과 동일한 에이전트 가용성/생존(liveness)
// 이벤트다.
//  - 에이전트가 acked 후 heartbeat_seq가 몇 번 증가하다 멈추면 lease_expires_at
//    (=last_heartbeat_at + lease TTL ~90s)이 지나 lease가 만료된다. 그러나 이 태스크는
//    lease 리퍼가 lease_expired로 수확하지 못하고, team-runner의 job-wait가 결국
//    1230000ms(20.5분) 후 타임아웃하며 'Job wait … timed out before finishing, no finish
//    notification arrived' error로 status='failed' 마킹한다. response·result_json 모두
//    비어 있어 산출물이 전혀 없다 = 오프라인/행/레이트리밋으로 실행 중 사망.
//  - 반면 실제로 계속 작업하다 job-wait를 초과한 '느린' 에이전트는 heartbeat가 계속
//    갱신되어 실패 시점(completed_at)에도 lease가 살아 있다(lease_expires_at >= completed_at).
//    이런 정상 성능/품질 실패는 그대로 카운트한다.
//  실측 근거(2026-07-25): 7d 'Job wait … timed out' 실패 19건 전부 response 길이 0이고,
//   lease가 만료된(completed_at > lease_expires_at) 건은 전부 heartbeat 정지 후 수백~수천 초
//   지나 job-wait가 마킹했다(team_ax-collab task_ZRAxVGlgpf7C0WwY: hermes가 4 heartbeat 후
//   21:30:12에 정지, lease 21:31:42 만료, job-wait가 22:02:36 실패 마킹 = lease 만료 1854초
//   후, 산출물 0). 이 1건이 team_ax-collab 48h completion 5/6=83.3% 오탐의 정확한 원인이며
//   제외 시 5/5=100%로 실제 팀 품질을 반영한다. 동일 패턴이 hr-director·cfo·marketing-lead·
//   self-learning 등 10개+ 팀, hermes·ollama·opencode·nvidia·agy 6개 에이전트에 걸쳐 있어
//   team-agnostic 인프라 이벤트임이 확인된다.
// 안전 불변식: status<>'completed' 가드로 완료 행은 절대 제외되지 않으며(completed는 이
//  error를 갖지 않음, 실측 0건) completed⊆terminal이 유지되어 completion>100% 회귀가 없다.
//  또한 (a) 이 특정 error 문자열, (b) lease_expires_at < completed_at(실패 시점에 이미 lease
//  만료 = 에이전트 사망 확정), (c) response·result_json 모두 공백 3중 가드로, 산출물을 낸
//  실패나 실패 시점에 lease가 살아 있던 '느리지만 생존' 실패는 제외하지 않는다(과잉 제외 방지).
// 롤백: 아래 3개 terminal CASE에서 이 조건을 제거하면 정확히 이전 동작.
const JOB_WAIT_DEAD_AGENT_EXCLUSION = `AND NOT (
      k.status <> 'completed'
      AND COALESCE(k.error, '') LIKE 'Job wait%timed out before finishing%'
      AND k.lease_expires_at IS NOT NULL
      AND k.completed_at IS NOT NULL
      AND julianday(k.completed_at) > julianday(k.lease_expires_at)
      AND COALESCE(k.response, '') = ''
      AND COALESCE(k.result_json, '') = ''
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
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
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
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
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
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_all,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_all
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN tasks k ON k.team_id = t.id
    ${DELIVERED_WORK_REPORTS_JOIN}
    ${WORK_REPORT_FANOUT_ALL_FAILED_JOIN}
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
      maxN,
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
