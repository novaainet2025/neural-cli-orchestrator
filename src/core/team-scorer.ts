import type Database from 'better-sqlite3';
import { buildFalseCompletionExclusion } from './false-completion.js';
import { getDb } from '../storage/database.js';

export const TEAM_SCORE_TARGET = 90;
// Automated remediation needs repeat evidence; one terminal task is only an initial signal.
export const TEAM_SCORE_MIN_ACTIONABLE_SAMPLE = 2;
// UI 독립 감사 승인팀은 Nova-AX 6/6 영수증의 *소비자*이지, 자기 charter 작업의
// *대상*이 될 수 없다. 이 팀에 organizationAuditRequired를 찍으면 자기참조 루프로
// completion 분자가 영구 0%가 된다(실측 2026-07-30: tasks 3건 completed·실패 0인데
// HR score=2.4·completion=0%·sample=48h/2).
export const UI_AUDIT_APPROVAL_TEAM_ID = 'team_ui-audit-approval';

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
// nova-use 런타임 미가동·메타데이터 무효는 Computer Use 제어 코디네이터팀 charter 품질 실패가
// 아니라 로컬 런타임 가용성 이벤트다(실측 2026-07-30: team_computer-use-control 48h/6
// completion=0% — 일일 보고가 잠금·MCP 상태 Tier-1 미확인 반복, company run lease 실패가
// 팀 태스크 실패로 집계). 롤백: 아래 nova-use·Computer Use activation 조건을 제거.
const INFRA_EXCLUSION = `AND (k.error IS NULL OR (k.error NOT LIKE 'orphaned:%' AND k.error NOT LIKE 'Circuit breaker open%' AND k.error NOT LIKE 'provider_unavailable:%' AND k.error NOT LIKE 'queue_wait_timeout:%' AND k.error NOT LIKE '%API Error: Connection closed mid-response%' AND k.error NOT LIKE '%nova-use runtime%' AND k.error NOT LIKE 'Computer Use activation failed%'))
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

// 전 조직 감사 게이트:
// - 감사 제어 태스크 자체는 팀 성과 표본이 아니다.
// - 새 감사 파이프라인이 명시적으로 표식한 팀 작업의 completed 성공은 Nova-AX가
//   실제 소비한 6/6 영수증이 metadata에 결박된 경우에만 인정한다.
// - gateway.ts L2154–2155는 팀 태스크 생성 시 organizationAuditRequired+verificationStatus
//   ='pending'을 일괄 주입한다. 'pending'은 아직 감사 파이프라인에 진입하지 않은 초기
//   표식이므로 strict gate 대상이 아니다(실측 2026-07-30: team_gov-assurance-safety 등
//   85팀 completion=0% — completed 행이 전부 pending 주입 상태이며 approved 영수증 0건).
// - 감사 롤아웃 전 legacy 행(표식 없음)과 pending 주입 행은 기존 status를 인정한다.
//   strict gate는 verificationStatus가 pending·빈값 이외(rejected 등 실제 감사 진행 상태)일
//   때만 영수증을 요구한다. organizationAuditRequired 단독 표식은 성과를 막지 않는다.
const AUDIT_CONTROL_PLANE_EXCLUSION = `AND NOT (
      json_valid(COALESCE(k.metadata_json, ''))
      AND (
        COALESCE(json_extract(k.metadata_json, '$.auditControlPlane'), 0) = 1
        OR TRIM(COALESCE(json_extract(k.metadata_json, '$.verificationDirectiveId'), '')) <> ''
      )
    )`;

const AUDIT_APPROVAL_GATE_DISABLED = new Set(['0', 'false', 'off']);
const AUDIT_APPROVED_COMPLETION_SQL = `AND (
      k.team_id = '${UI_AUDIT_APPROVAL_TEAM_ID}'
      OR NOT (
        json_valid(COALESCE(k.metadata_json, ''))
        AND TRIM(COALESCE(json_extract(k.metadata_json, '$.verificationStatus'), '')) NOT IN ('', 'pending')
      )
      OR (
        json_extract(k.metadata_json, '$.verificationStatus') = 'approved'
        AND TRIM(COALESCE(json_extract(k.metadata_json, '$.verificationReceiptId'), '')) <> ''
      )
    )`;

export function buildAuditApprovedCompletion(
  toggle: string | undefined = process.env.NCO_SCORER_AUDIT_APPROVAL_GATE,
): string {
  return AUDIT_APPROVAL_GATE_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : AUDIT_APPROVED_COMPLETION_SQL;
}

// lease_expired 중 '에이전트가 리스를 잡았지만 한 줄도 실행하지 않은' 케이스는 팀 품질
// 실패가 아니라 서킷브레이커와 동일한 에이전트 가용성/생존(liveness) 이벤트다.
//  - 에이전트가 태스크를 acked(리스 선점)했으나 last_heartbeat_at이 NULL이면 실행 루프가
//    단 한 번의 heartbeat도 남기지 못하고 lease_expires_at에 만료된 것이다. response·
//    result_json 모두 비어 있어 산출물이 전혀 없다 = 오프라인/행/레이트리밋으로 즉시 사망.
//  - 반면 heartbeat가 하나라도 있는 lease_expired는 에이전트가 실제로 작업하다 시간초과된
//    것이므로 정상 품질/성능 실패로 그대로 카운트한다(실측 2026-07-24 48h: heartbeat 있는
//    lease_expired 4건은 research-analysis/kd-memory의 ollama 실작업 타임아웃).
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

// work-report 폴백이 이미 활성화됐지만 아직 완료되기 전의 짧은 창에서는, 앞선 provider
// 사본의 실패를 팀 품질 실패로 즉시 계상하면 같은 논리 업무가 복구 중인데도 HR 진단이
// 발사되는 스냅샷 경합이 생긴다.
//  - 실측(2026-07-28 UTC, db/nco.db): team_gov-government-treasury의
//    task_7wS1alWtK8IZxVuW는 claude-code 주간 한도로 05:55:46 실패했고, 동일 workReportId
//    wr_Tl3ajbINjrI2Hp5B의 task_13SkVMe-HMX8w-N2가 같은 초에 생성되어 05:56:28 완료했다.
//    HR 진단 task_qd-PmtgJYcAJyexy는 그 사이 05:56:09 생성되어 7/8=87.5%를 캡처했다.
//  - 완료 뒤에는 WORK_REPORT_DUP_DELIVERED_EXCLUSION이 실패 사본을 제외하지만, 활성 폴백
//    중에는 dwr가 아직 없어 같은 논리 업무를 일시적으로 실패로 오계상했다.
// 안전 불변식: 같은 팀·같은 workReportId의 활성 사본이 존재하는 실패 행만 제외한다.
// 활성 사본이 cancelled/terminal이 되면 다음 계산에서 실패 행이 다시 포함되므로 실제 미배달을
// 숨기지 않는다. status<>'completed' 가드로 completed⊆terminal도 유지한다.
// 롤백: 런타임 즉시 → NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION=off (재빌드 불필요).
const ACTIVE_WORK_REPORT_RETRY_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const ACTIVE_WORK_REPORT_RETRY_EXCLUSION_SQL = `AND NOT (
      k.status <> 'completed'
      AND awr.wrid IS NOT NULL
    )`;

export function buildActiveWorkReportRetryExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION,
): string {
  return ACTIVE_WORK_REPORT_RETRY_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : ACTIVE_WORK_REPORT_RETRY_EXCLUSION_SQL;
}

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

// 복구 중인 work report 집합. 한 실패 사본과 같은 팀·같은 논리 보고서의 활성 폴백이
// 존재하는 동안만 위 ACTIVE_WORK_REPORT_RETRY_EXCLUSION이 그 실패를 보류한다.
const ACTIVE_WORK_REPORTS_JOIN = `LEFT JOIN (
      SELECT DISTINCT
        team_id,
        json_extract(metadata_json, '$.workReportId') AS wrid
      FROM tasks
      WHERE status IN ('pending','queued','assigned','running','streaming','reviewing')
        AND json_valid(metadata_json)
        AND TRIM(COALESCE(json_extract(metadata_json, '$.workReportId'), '')) <> ''
    ) awr ON awr.team_id = k.team_id
      AND awr.wrid = json_extract(k.metadata_json, '$.workReportId')`;

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
//   self-learning 등 10개+ 팀, hermes·ollama·opencode·agy 5개 에이전트에 걸쳐 있어
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

// provider CLI subprocess 자체가 뜨지 못한 실패(spawn ENOENT)는 팀 산출물 품질이 아니라
// 서킷브레이커·provider_unavailable과 동일한 에이전트 가용성 이벤트다.
//  - src/agent/orchestrated-loop.ts:325의 execa 호출이 바이너리/cwd를 열지 못하면 Node가
//    ENOENT로 즉시 실패시킨다. 즉 CLI 프로세스가 한 번도 시작되지 않았고 루프 iteration은 0,
//    response·result_json 모두 비어 있다 = 팀 작업이 단 한 줄도 실행되지 않았다.
//  실측 근거(2026-07-27 UTC, db/nco.db):
//   - team_content-planning 48h 원시 terminal 9건 중 계상 실패는 task_content_generation
//     1건뿐이고, 그 error는 'cursor-agent: CLI failed exit=unknown — Command failed with
//     ENOENT: cursor-agent …'였다(response 0바이트, result_json 0바이트, progress 0.0).
//   - 이 태스크의 escalationHistory 첫 항목은 'provider_unavailable: opencode (open/generic)'
//     로 이미 INFRA_EXCLUSION 대상 클래스였는데, cursor-agent 재배정이 error를 덮어써
//     기존 제외 조건이 더 이상 매칭되지 않았다.
//   - PATH/설치 문제는 아니다: 같은 NCO 프로세스가 같은 분(17:10:25·17:11:39·17:17:03)에
//     실행한 다른 cursor-agent 태스크 4건은 모두 completed였고, cursor-agent 바이너리는
//     /Users/nova-ai/.local/bin/cursor-agent에 존재해 --version이 2026.07.23-e383d2b를 낸다.
//     따라서 이 ENOENT는 지속적 환경 결함이 아니라 일시적 spawn 실패(가용성 이벤트)다.
//   - 전체 DB에서 이 error 클래스는 4건뿐이고 그중 team_id가 붙은 것은 위 1건이다
//     (나머지 3건은 team_id NULL) → 제외 반경이 팀 스코어 1행으로 한정된다.
// 안전 불변식: status<>'completed' + response·result_json 공백 3중 가드. 실측상 이 error를
//  가진 completed 행은 0건이므로 completed⊆terminal이 유지되어 completion>100% 회귀가 없다.
//  산출물을 낸 실패는 response/result_json이 비어 있지 않으므로 제외되지 않는다.
// 롤백: 런타임 즉시 → NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off (재빌드 불필요).
//  코드 → 아래 상수와 buildSpawnFailureExclusion() 및 3개 terminal CASE의 삽입부를 제거.
const SPAWN_FAILURE_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const SPAWN_FAILURE_EXCLUSION_SQL = `AND NOT (
      k.status <> 'completed'
      AND COALESCE(k.error, '') LIKE '%Command failed with ENOENT:%'
      AND COALESCE(k.response, '') = ''
      AND COALESCE(k.result_json, '') = ''
    )`;

export function buildSpawnFailureExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_SPAWN_FAILURE_EXCLUSION,
): string {
  return SPAWN_FAILURE_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : SPAWN_FAILURE_EXCLUSION_SQL;
}

// 외부 프로세스가 NCO 게이트웨이·이벤트버스를 우회해 tasks 행을 직접 삽입한 뒤,
// 실제 산출물 없이 status='completed'로만 바꾸는 경우는 팀 charter 실행 결과가 아니다.
// 이런 행을 일반 zero-output 완료와 똑같이 terminal 분모에 남기면, NCO가 실행하거나
// 재시도할 기회가 전혀 없었던 외부 진행상태 마커가 팀 completion을 낮춘다.
//
// 실측 근거(2026-07-28 조회, db/nco.db):
//  - task_trend_collector: prompt='트렌드 키워드 수집 및 분석 중', assigned_to='retired-local-provider',
//    status='completed', response/result_json 0바이트, metadata_json/system_prompt/
//    spawned_by_cli NULL, orphan_requeue_count=0.
//  - 이 provenance 조합은 orphan-recovery-policy.ts의 외부 주입 가드와 동일하다.
//
// 범위: completed+0B이며 NCO provenance가 전부 없고 재큐잉 이력도 없는 팀 행만
// completed/terminal 양쪽에서 제외한다. 일반 NCO zero-output 완료는 계속 terminal 실패로 남긴다.
// 롤백: 런타임 즉시 → NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION=off (재빌드 불필요).
const EXTERNAL_ZERO_OUTPUT_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const EXTERNAL_ZERO_OUTPUT_EXCLUSION_SQL = `AND NOT (
      k.status = 'completed'
      AND COALESCE(k.response, '') = ''
      AND COALESCE(k.result_json, '') = ''
      AND COALESCE(k.team_id, '') <> ''
      AND COALESCE(k.metadata_json, '') = ''
      AND COALESCE(k.system_prompt, '') = ''
      AND COALESCE(k.spawned_by_cli, '') = ''
      AND COALESCE(k.orphan_requeue_count, 0) = 0
    )`;

export function buildExternalZeroOutputExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION,
): string {
  return EXTERNAL_ZERO_OUTPUT_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : EXTERNAL_ZERO_OUTPUT_EXCLUSION_SQL;
}

// status='completed'여도 response와 result_json이 모두 0바이트면 검증 가능한 팀 산출물이
// 없으므로 completion 분자에 넣지 않는다. terminal 분모에는 그대로 남겨 "완료" 상태만으로
// 성공률을 부풀리지 않고, completed<=terminal 불변식과 completion<=100%를 보존한다.
// 실측 근거(2026-07-28 조회, db/nco.db):
//  - 최근 48h의 team_id 보유 completed 0B 행은 task_trend_collector 1건뿐이며,
//    team_content-planning의 completion 분자를 7로 부풀리고 있었다.
//  - response 또는 result_json 중 하나라도 1바이트 이상이면 실제 산출물이 있으므로 유지한다.
// 롤백: 런타임 즉시 → NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off (재빌드 불필요).
//  코드 → 아래 상수와 buildZeroOutputCompletedExclusion() 및 3개 completed CASE 삽입부를 제거.
const ZERO_OUTPUT_COMPLETED_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL = `AND NOT (
      COALESCE(k.response, '') = ''
      AND COALESCE(k.result_json, '') = ''
    )`;

export function buildZeroOutputCompletedExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION,
): string {
  return ZERO_OUTPUT_COMPLETED_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL;
}

// provider CLI가 자격증명 거부(HTTP 401 authentication_error 또는 평문 Invalid API key)만
// 내고 종료한 실패는 팀 산출물
// 품질이 아니라 'provider_unavailable'·서킷브레이커와 동일한 에이전트 가용성 이벤트다.
//  - CLI 프로세스는 떴지만 모델 API가 인증을 거부해 에이전트 턴이 한 번도 성립하지 않는다.
//    opencode는 이때 stdout에 오직 구조화된 오류 봉투 하나만 쓴다:
//    {"type":"error", … "error":{"name":"APIError","data":{"message":"invalid x-api-key",
//    "statusCode":401, … "responseBody":"{\"type\":\"error\",\"error\":{\"type\":
//    \"authentication_error\" …}"}}} — 즉 팀 산출물은 0바이트다.
//  - 이미 제외 대상인 'provider_unavailable:%'와 같은 계열인데, escalation 재배정이 error를
//    덮어써(SPAWN_FAILURE_EXCLUSION 주석의 cursor-agent ENOENT와 동일한 덮어쓰기 병리)
//    최종 error가 'opencode: CLI failed exit=1 — …'가 되는 바람에 기존 절이 놓친다.
//  실측 근거(2026-07-28 조회, db/nco.db):
//   - 2026-07-27 17:19~17:30 UTC에 fleet 전역 자격증명 장애가 있었다. 같은 창에서 claude-code는
//     'subprocess exited with code 1: Invalid API key', cursor-agent는 'Error: Authentication
//     required', opencode는 401 봉투를 냈고 provider_unavailable 대량 발생이 겹쳤다.
//   - team_gov-command-collaboration의 48h 계상 실패 2건 중 1건이 task_4aq6FQ3yZuXoiTdK다.
//     이 태스크의 escalationHistory 첫 항목은 'provider_unavailable: claude-code (open/auth)'로
//     이미 제외 클래스였고, opencode 재배정 후의 response(978바이트)는 위 401 봉투 그 자체다.
//     제외 시 48h completion 7/9=77.8% → 7/8=87.5%로 실제 팀 품질을 반영한다.
//   - team_hr-incubator-2026-w30의 유일한 48h 계상 실패(task_VnTZtkgkcpgPwPhy)는
//     claude-code subprocess가 error='subprocess exited with code 1: Invalid API key ·
//     Fix external API key', response='Invalid API key · Fix external API key\\n',
//     result_json=NULL, progress=0으로 종료한 인증 거부다. 기존 401 봉투 절은 이 평문 형식을
//     놓쳐 completion을 6/7=85.7%로 낮췄다.
//   - 구조화 401 조건은 DB 전체 7건(팀 귀속 3건)에 한정되고, 평문 조건은 위 HR 태스크
//     1건에만 추가로 매칭된다. 두 형식 모두 같은 장애 창의 provider 인증 거부다.
//   - [2026-07-28 중복에러방지팀 cycle2 감사 추가] 같은 장애 창의 **세 번째 표면형**이
//     게이트에 빠져 있었다. cursor-agent는 stdout에 오직 평문 한 줄만 쓴다:
//     error='cursor-agent: CLI failed exit=1 — Error: Authentication required. Please run
//     ''agent login'' first, or set CURSOR_API_KEY environment variable.',
//     response=그 문구+개행, result_json=NULL, 즉 산출물 0바이트다.
//     실측(db/nco.db): task_IkKQEYErfegOFc6R·task_u_VTwDmVodFpsNDX(둘 다 team_self-learning,
//     2026-07-27 17:21:41, 응답·에러 바이트 동일)이 이 형식의 DB 전체 매칭 2건이다.
//     이 2건은 cursor-agent 서킷브레이커를 연 **원인** 행이고, 직후 17:21:52~17:22:32에
//     발생한 'provider_unavailable: cursor-agent (open/generic)' 12건은 INFRA_EXCLUSION이
//     이미 제외한다. 즉 게이트가 증상(12건)은 빼고 원인(2건)은 세는 비대칭 상태였다.
//     cursor-agent는 17:40:01에 정상 completed로 복귀 → 팀 품질이 아닌 일시적 자격증명 장애.
//     동일 근본원인이 provider마다 다른 문구로 재현되는 중복 에러이므로, 이미 승인된
//     제외 클래스를 표면형 3종(opencode 401 봉투 / claude-code 평문 / cursor-agent 평문)에
//     일관 적용한다. 이 절은 team_hr-incubator-2026-w30 점수에는 영향이 없다(매칭 0건).
// 안전 불변식: (a) status<>'completed' 가드, (b) error가 provider CLI 프로세스 실패
//  ('CLI failed exit=' 또는 실측 평문 오류와 완전 일치)일 것, (c) response가 구조화 오류
//  봉투로 *시작*하거나 평문 오류와 정확히 같을 것, (d) 평문 형식은 result_json도 비었을 것.
//  이 가드는 팀 보고서가 인증 오류를 인용하거나 부분 산출물을 낸 경우, 미관측 exit code·
//  오류 접미사가 있는 경우까지 잘못 빠지는 것을 막는다. status 가드로 completed⊆terminal이
//  유지되어 completion>100% 회귀가 없다.
// 롤백: 런타임 즉시 → NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off (재빌드 불필요).
//  코드 → 아래 상수와 buildProviderAuthExclusion() 및 3개 terminal CASE의 삽입부를 제거.
const PROVIDER_AUTH_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const PROVIDER_AUTH_EXCLUSION_SQL = `AND NOT (
      k.status <> 'completed'
      AND (
        (
          COALESCE(k.error, '') LIKE '%CLI failed exit=%'
          AND COALESCE(k.response, '') LIKE '{"type":"error"%'
          AND (
            COALESCE(k.response, '') LIKE '%"statusCode":401%'
            OR COALESCE(k.response, '') LIKE '%authentication_error%'
            OR COALESCE(k.response, '') LIKE '%invalid x-api-key%'
          )
        )
        OR (
          COALESCE(k.error, '') = 'subprocess exited with code 1: Invalid API key · Fix external API key'
          AND RTRIM(COALESCE(k.response, ''), char(9) || char(10) || char(13) || ' ')
            = 'Invalid API key · Fix external API key'
          AND COALESCE(k.result_json, '') = ''
        )
        OR (
          COALESCE(k.error, '') LIKE '%CLI failed exit=%'
          AND RTRIM(COALESCE(k.response, ''), char(9) || char(10) || char(13) || ' ')
            = 'Error: Authentication required. Please run ''agent login'' first, or set CURSOR_API_KEY environment variable.'
          AND COALESCE(k.result_json, '') = ''
        )
      )
    )`;

export function buildProviderAuthExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION,
): string {
  return PROVIDER_AUTH_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : PROVIDER_AUTH_EXCLUSION_SQL;
}

// 제어면(NCO :6200 / Nova-AX :6300) 연결거부로 죽은 실패는 이미 INFRA_EXCLUSION의
// 게이트웨이-다운 절이 다루는 가용성 이벤트다. 그런데 그 절은 구(舊) 실패 라벨
// 'unknown: failure pattern in output'에만 걸려 있어, 라벨이 세분화된 뒤의 같은 실패를
// 놓치고 팀 품질 실패로 오계상한다.
//  - src/server/gateway.ts:112 REPORTED_ERROR_CAUSE_PATTERNS가 'error:' 접두로 정직하게
//    보고된 연결거부를 더 구체적인 라벨 'failure-pattern: connection failure'로 마킹한다.
//    같은 파일의 구 경로만 'unknown: failure pattern in output'을 남긴다(실측 13건).
//    즉 라벨 세분화와 스코어러 술어가 desync된 상태다.
//  - 또한 기존 절은 NCO 게이트웨이(:6200)만 커버한다. 검증지시(workflowStage='verification')
//    태스크는 Nova-AX 제어면(:6300)에 기계 증거를 제출해야 하므로, 그 서버가 죽으면 어떤
//    팀도 성공할 수 없다 — :6200 다운과 정확히 같은 가용성 이벤트다.
//  실측 근거(2026-07-30 UTC, db/nco.db):
//   - team_gov-government-treasury의 48h 계상 실패는 task_xvV9Pw13uv63Tn0v 1건뿐이다.
//     hermes가 error='failure-pattern: connection failure', response 575B에
//     "curl: (7) Failed to connect to 127.0.0.1 port 6300 after 0 ms: Couldn't connect to
//     server"를 남기고 정직하게 미완료를 보고했다(result_json 0B, 산출물 없음).
//     제외 시 48h completion 6/7=85.7% → 6/6=100%로 실제 팀 품질을 반영한다.
//   - 같은 창(04:24~04:35)에 team_gov-government-hr(task_opcJbXioZ_RdGex8)·
//     team_hr-director(task_6U9HdSXrBErDX2CZ)도 동일한 :6300 연결거부로 실패했고,
//     team_self-improvement(task_MQNO8i0HLDY5CtQu)는 같은 라벨의 :6200 연결거부다
//     → 팀 무관(team-agnostic) 가용성 이벤트임이 확인된다.
//   - 이 error 라벨은 DB 전체 8건이고 전부 status='failed'이며, 아래 술어에 매칭되는
//     completed 행은 0건이다(팀 귀속 4건 / team_id NULL 4건).
// 안전 불변식: (a) status<>'completed' 가드, (b) 실패 라벨이 연결거부 클래스로 정확히
//  한정, (c) response가 제어면 포트(6200/6300)에 대한 curl 연결실패 문구를 포함, (d)
//  result_json이 비어 산출물이 전혀 없을 것. 이 4중 가드로 완료 보고서가 과거 장애를
//  인용한 경우나 다른 서버(:11434 등) 연결실패, 부분 산출물을 낸 실패는 빠지지 않는다.
//  completed 행이 매칭되지 않으므로 completed⊆terminal이 유지되어 completion>100% 회귀가 없다.
// 롤백: 런타임 즉시 → NCO_SCORER_CONTROL_PLANE_CONNECTION_EXCLUSION=off (재빌드 불필요).
//  코드 → 아래 상수와 buildControlPlaneConnectionExclusion() 및 3개 terminal CASE 삽입부 제거.
const CONTROL_PLANE_CONNECTION_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const CONTROL_PLANE_CONNECTION_EXCLUSION_SQL = `AND NOT (
      k.status <> 'completed'
      AND COALESCE(k.error, '') LIKE 'failure-pattern: connection failure%'
      AND COALESCE(k.result_json, '') = ''
      AND (
        COALESCE(k.response, '') LIKE '%Failed to connect to localhost port 6200%'
        OR COALESCE(k.response, '') LIKE '%Failed to connect to 127.0.0.1 port 6200%'
        OR COALESCE(k.response, '') LIKE '%Failed to connect to localhost port 6300%'
        OR COALESCE(k.response, '') LIKE '%Failed to connect to 127.0.0.1 port 6300%'
      )
    )`;

export function buildControlPlaneConnectionExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_CONTROL_PLANE_CONNECTION_EXCLUSION,
): string {
  return CONTROL_PLANE_CONNECTION_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : CONTROL_PLANE_CONNECTION_EXCLUSION_SQL;
}

export function computeTeamScores(database: Database.Database = getDb()): TeamScore[] {
  const SPAWN_FAILURE_EXCLUSION = buildSpawnFailureExclusion();
  const EXTERNAL_ZERO_OUTPUT_EXCLUSION = buildExternalZeroOutputExclusion();
  const ZERO_OUTPUT_COMPLETED_EXCLUSION = buildZeroOutputCompletedExclusion();
  const FALSE_COMPLETION_EXCLUSION = buildFalseCompletionExclusion();
  const AUDIT_APPROVED_COMPLETION = buildAuditApprovedCompletion();
  const PROVIDER_AUTH_EXCLUSION = buildProviderAuthExclusion();
  const CONTROL_PLANE_CONNECTION_EXCLUSION = buildControlPlaneConnectionExclusion();
  const ACTIVE_WORK_REPORT_RETRY_EXCLUSION = buildActiveWorkReportRetryExclusion();
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
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${ACTIVE_WORK_REPORT_RETRY_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
          ${SPAWN_FAILURE_EXCLUSION}
          ${PROVIDER_AUTH_EXCLUSION}
          ${CONTROL_PLANE_CONNECTION_EXCLUSION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_48h,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-48 hours')
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${AUDIT_APPROVED_COMPLETION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
          ${ZERO_OUTPUT_COMPLETED_EXCLUSION}
          ${FALSE_COMPLETION_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_48h,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          AND julianday(k.created_at) >= julianday('now','-7 days')
          ${INFRA_EXCLUSION}
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${ACTIVE_WORK_REPORT_RETRY_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
          ${SPAWN_FAILURE_EXCLUSION}
          ${PROVIDER_AUTH_EXCLUSION}
          ${CONTROL_PLANE_CONNECTION_EXCLUSION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_7d,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          AND julianday(k.created_at) >= julianday('now','-7 days')
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${AUDIT_APPROVED_COMPLETION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
          ${ZERO_OUTPUT_COMPLETED_EXCLUSION}
          ${FALSE_COMPLETION_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_7d,
      COALESCE(SUM(CASE
        WHEN k.status IN ('completed','failed','timed_out','lease_expired')
          ${INFRA_EXCLUSION}
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${LEASE_NEVER_RAN_EXCLUSION}
          ${WORK_REPORT_DUP_DELIVERED_EXCLUSION}
          ${ACTIVE_WORK_REPORT_RETRY_EXCLUSION}
          ${WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION}
          ${JOB_WAIT_DEAD_AGENT_EXCLUSION}
          ${SPAWN_FAILURE_EXCLUSION}
          ${PROVIDER_AUTH_EXCLUSION}
          ${CONTROL_PLANE_CONNECTION_EXCLUSION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS terminal_all,
      COALESCE(SUM(CASE
        WHEN k.status = 'completed'
          ${CONTROL_PLANE_PERFGOAL_EXCLUSION}
          ${AUDIT_CONTROL_PLANE_EXCLUSION}
          ${AUDIT_APPROVED_COMPLETION}
          ${EXTERNAL_ZERO_OUTPUT_EXCLUSION}
          ${ZERO_OUTPUT_COMPLETED_EXCLUSION}
          ${FALSE_COMPLETION_EXCLUSION}
        THEN 1 ELSE 0 END), 0) AS completed_all
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN tasks k ON k.team_id = t.id
    ${DELIVERED_WORK_REPORTS_JOIN}
    ${ACTIVE_WORK_REPORTS_JOIN}
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
        .filter((team) => team.score < TEAM_SCORE_TARGET)
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
