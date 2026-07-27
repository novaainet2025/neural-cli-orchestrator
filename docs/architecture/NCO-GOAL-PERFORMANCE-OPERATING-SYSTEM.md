# NCO 목표·성과·총지휘 운영체계 (Goal/Performance/Commander Operating System)

모든 활성 organization/team에 대해 daily/weekly/monthly 3주기 목표(goal)·성과보고(performance report)를
자동으로 보장하고, 최종 지휘관(commander) 감사가 그 커버리지·실행 품질·자동화 상태를 주기적으로 판정하는
운영체계. 기존 daily-only HR 커버리지(`team_goals`, `source='hr-daily-coverage'`,
`src/core/hourly-role-oversight.ts`)를 대체하지 않고 별도 source 값으로 공존한다.

## 1. 주기(Period)와 키 형식

`src/core/performance-governance.ts`의 `getKstPerformancePeriods()`가 KST(UTC+9) 기준으로 세 주기를
동시에 계산한다.

| 주기 | 키 형식 | 예시 | 산출 방식 |
|---|---|---|---|
| daily | `YYYY-MM-DD` | `2026-07-26` | KST 자정 기준 하루 |
| weekly | `YYYY-Www` (ISO 8601) | `2026-W30` | 목요일 규칙(Thursday rule)으로 ISO 연·주 산출 |
| monthly | `YYYY-MM` | `2026-07` | KST 월 경계 |

ISO 주차는 "그 주의 목요일이 속한 연도"를 ISO 연도로 삼는 표준 알고리즘을 그대로 구현했다(연말/연초
경계에서 일반적인 `getWeek()`류 구현이 자주 틀리는 지점). `src/core/performance-governance.test.ts`의
`computes ISO week keys correctly across year boundaries` 테스트가 다음 경계를 검증한다:

- 2025-12-29(월) → `2026-W01` (2026-01-01은 목요일)
- 2020-12-31(목) → `2020-W53`
- 2021-01-01(금) → 전년도 `2020-W53`
- 2023-01-01(일) → 전년도 `2022-W52`
- 2024-12-30(월) → 이듬해 `2025-W01`

## 2. 목표(Goal) — `team_goals`, `source='performance-governance'`

`db/migrations/087_goal_performance_operating_system.sql`이 기존 `team_goals`/`performance_reports`
테이블에 partial unique index를 추가한다(신규 테이블 생성 없음, 077/078/084의 기존 스키마를 그대로
재사용):

```sql
CREATE UNIQUE INDEX idx_team_goals_performance_governance
  ON team_goals(subject_kind, subject_id, period, period_key, source)
  WHERE source = 'performance-governance';
```

`runPerformanceGovernance()`는 매 실행마다:

1. **이전 기간 확정** — 각 주기별로 `period_key < 현재키 AND status='active' AND source='performance-governance'`인
   목표를 `direction`에 따라 `met`/`missed`로 확정한다(daily-only였던 `hourly-role-oversight.ts`의
   `finalizePreviousDailyGoals` 로직을 3주기로 일반화).
2. **현재 기간 upsert** — 모든 활성 organization/team × 3주기에 대해 목표를 `INSERT ... ON CONFLICT
   ... WHERE source='performance-governance' DO UPDATE`로 보장한다. 같은 `period_key`로 재실행해도
   새 행이 생기지 않고 `target_value`/`current_value`/`note`만 최신화된다(멱등).
3. **team 목표**: `metric='completed_task_count'`, target은 `team.is_always_on`과 주기(daily/weekly/monthly)에
   따라 1/5/20(always-on) 또는 1/1/4(on-demand)건, current는 그 기간 창(window) 내 실제 `completed` 태스크 수.
4. **organization 목표**: `metric='active_team_execution_coverage_pct'`, target=100, current=소속 활성 팀 중
   해당 기간에 완료 증거(완료 태스크)가 있는 팀의 비율(%) — 팀들의 실제 실행 데이터를 그대로 롤업한다.
5. `note`에는 목표 대비 gap과 결정론적 다음 행동(`nextAction`)을 실제 수치로 보간해 기록한다(LLM 호출 없음).

## 3. 성과보고(Performance Report) — `performance_reports`, `source='performance-governance'`

같은 실행에서 동일한 3주기 `performance_reports`를 upsert한다(`idx_performance_reports_governance`
partial unique index 활용). `metrics_json`에는 다음이 저장된다:

```json
{
  "goal": { "attainmentPct": 83.3 },
  "execution": { "taskTotal": 4, "taskCompleted": 3, "taskFailed": 1, "successRatePct": 75 },
  "workReports": { "due": 2, "submitted": 1, "submissionRatePct": 50 },
  "guidance": { "status": "attention", "gap": 1, "nextAction": "..." }
}
```

`reflection`/`improvement` 컬럼은 실제 집계 수치를 문자열로 보간한 결과만 저장한다(허구 텍스트 금지).

## 4. 총지휘관 감사(Commander Operation Audit) — `commander_operation_audits`

`src/core/commander-operation-audit.ts`의 `runCommanderOperationAudit()`가 실행마다 **집계 1행**을
기록한다(주체별이 아니라 감사 실행 1회당 1행 — `active_organizations`, `goals_expected/present`,
`reports_expected/present`, `failed_tasks`, `stalled_tasks`, `missed_work_reports`,
`schedules_expected/healthy`, `checks_json`, `evidence_json`). 판정 기준:

| 조건 | 판정 |
|---|---|
| 목표/성과보고 커버리지 미달, 예약된 자동화(cron) 비정상 | `fail` |
| 2시간 이상 정체된 `running`/`assigned`/`streaming`/`reviewing` 태스크 존재 | `fail` |
| 최근 24시간 실패·타임아웃 태스크 존재 | `attention` |
| 금일 누락·기한초과 업무보고 존재 | `attention` |
| 관리자/팀장/헌장 누락 등 구조적 결함 | `attention` |
| 위 모두 정상 | `pass` |

감사는 **기록만 한다** — 삭제·강제종료 등 어떤 조치도 취하지 않는다.

필수 자동화 5종(`PERFORMANCE_CRON_REQUIREMENTS`)의 registered/enabled/last_status/last_run 신선도를
함께 검사한다:

| cron_jobs.id | 스케줄(Asia/Seoul) | 역할 |
|---|---|---|
| `pg-hourly-progress-refresh` | `0 * * * *` | 현재 3주기 진행률 갱신 |
| `pg-daily-rollup` | `10 0 * * *` | 전일 확정 + 금일 daily 목표 오픈 |
| `pg-weekly-rollup` | `15 0 * * 1` | 전주 확정 + ISO 주 시작(월요일) 오픈 |
| `pg-monthly-rollup` | `20 0 1 * *` | 전월 확정 + 금월 오픈 |
| `pg-hourly-commander-audit` | `5 * * * *` | 총지휘관 감사 실행 |

마이그레이션은 위 5개 job을 `INSERT OR IGNORE` 후 정의에 맞게 `UPDATE`하고,
`cron-scheduler.ts`의 `ensureDefaultInternalJobs()`는 누락된 job을 부팅 시 보충한다.
`src/index.ts` 부팅
시퀀스는 Gateway 기동 이후 위 두 함수를 1회 실행하되 `try/catch`로 감싸 실패해도 서비스 기동을 막지
않는다.

## 5. API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/performance-flow?period=daily\|weekly\|monthly&subjectKind=&subjectId=&limit=` | period-key별 시계열(goalAttainmentPct, taskSuccessRatePct, taskCompleted, failedTasks, workReportSubmissionRatePct) + `currentCoverage`(선택한 현재 주기의 목표/보고 커버리지 요약) |
| `GET /api/commander/operations?limit=` | 최신(`latest`) + 이력(`history`) 감사 결과 |
| `POST /api/performance-governance/run` | 수동 실행 — governance + commander audit을 즉시 실행하고 결과를 반환(T1 즉시검증용) |

`limit`은 두 GET 엔드포인트 모두 zod로 1~100(또는 1~24) 범위를 강제한다.

## 6. 대시보드

`GET /performance-flow` (`src/server/performance-dashboard.ts`)는 외부 라이브러리 없이 순수 SVG로:

- 목표 달성률·태스크 성공률 추이 선그래프(daily/weekly/monthly 전환)
- Goal → Execution → Report → Commander Audit 흐름 다이어그램
- 최신 총지휘관 판정(pass/attention/fail)과 근거(evidence) 목록
- 스크린리더/텍스트 파서를 위한 `<table>` 데이터(그래프와 동일한 수치를 표로 병기)

를 렌더링한다.

## 7. T1 검증 방법

```bash
npx tsc --noEmit                               # 0 errors
npx vitest run src/core/performance-governance.test.ts \
  src/server/routes/performance-flow.test.ts \
  src/core/hourly-role-oversight.test.ts        # 회귀 없음 확인
curl -X POST http://localhost:6200/api/performance-governance/run   # 실제 실행 + 결과 확인
curl "http://localhost:6200/api/performance-flow?period=daily&limit=12"
curl "http://localhost:6200/api/commander/operations?limit=5"
```

`db/nco.db`에 대해 직접 `sqlite3 db/nco.db "SELECT * FROM team_goals WHERE source='performance-governance'"`
등으로 실제 행 존재를 확인할 수 있다(파일시스템/DB 직접 조회 = T1 증거).
