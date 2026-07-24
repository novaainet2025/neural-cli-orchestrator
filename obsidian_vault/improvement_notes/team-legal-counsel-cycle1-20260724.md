# team_legal-counsel — 개선 사이클 1/3 근본원인 노트 (2026-07-24)

- 대상: `team_legal-counsel` (Legal Counsel, legal-counsel)
- HR 스냅샷: score=81.5, completion=83.3%, sample=48h/12, cycle=1/3
- 증거 등급: **T1** (SQLite `db/nco.db` 직접 조회 + `computeTeamScores` 실행 측정)

## [작업표본 N건]

48h 창(`created_at >= now-48h`) `team_legal-counsel` 태스크: **완료 10 / 실패 3 = 13건**.
스코어러는 인프라 실패 1건(orphan)을 이미 제외해 분모 12 → 10/12=**83.3%** (HR 스냅샷과 정확히 일치).

| task_id | status | agent | error | workReportId | resp_len |
|---|---|---|---|---|---|
| task_Uasm_GiCyMDLxPgX | completed | opencode | — | wr_B_FILi2kqsq5pXeA | 251 |
| task_ZSC7LeEtTTkuzdUP | failed | opencode | silent-failure: empty output | **wr_B_FILi2kqsq5pXeA** | 2 |
| task_16ZXX8QzyJw4zASb | failed | opencode | silent-failure: empty output | **wr_B_FILi2kqsq5pXeA** | 3 |
| task_hM1XC4ar8XKaPeDl | failed | opencode | orphaned: server restart (poison — requeued 3x) | — | — |

## [실패분류]

1. **중복 work-report 팬아웃 레이스 (2건)** — `task_ZSC7LeEtTTkuzdUP`, `task_16ZXX8QzyJw4zASb`.
   `2026-07-24 00:02:10`에 동일 `workReportId=wr_B_FILi2kqsq5pXeA`로 3개 사본이 opencode에 거의 동시 생성됨.
   한 사본(`task_Uasm_GiCyMDLxPgX`)이 251자 실보고서로 `00:03:34` 완료하는 동안, 나머지 두 사본은
   빈 산출(resp_len 2·3)로 `silent-failure: empty output` 처리됨. **산출물(보고서)은 이미 배달됨.**
2. **인프라 orphan (1건)** — `task_hM1XC4ar8XKaPeDl`. 서버 재시작 poison-requeue. 스코어러가 이미 제외.

## [근본원인 가설 (증거 task_id 인용)]

completion 83.3%의 결손 2/12는 **팀 산출물 품질 실패가 아니라 스케줄러 팬아웃 아티팩트**다.
`idx_tasks_active_work_report_id` 유니크 인덱스는 *활성* 중복만 막고, 한 사본이 terminal이 되면
슬롯이 풀려 형제 사본이 빈손으로 종료될 수 있다. `team-scorer.ts`의 기존 3개 제외절
(INFRA / CONTROL_PLANE_PERFGOAL / LEASE_NEVER_RAN) 중 어느 것도 `silent-failure: empty output`을
잡지 못해, 배달 완료된 work report의 실패 중복이 completion을 부당 감점했다.
(선행 사례: `team-scorer.ts` 주석의 tech-port-02 `wr_ZKslprd1NUvsf1Fg` 팬아웃과 동일 계열이나
그쪽은 서킷브레이커 error라 INFRA 절이 이미 커버했다.)

## [수정 — bounded / reversible]

`src/core/team-scorer.ts`: `WORK_REPORT_DUP_DELIVERED_EXCLUSION` 추가 + `DELIVERED_WORK_REPORTS_JOIN`
파생 테이블(배달된 (team_id, workReportId) 집합) LEFT JOIN. terminal CASE 3곳(48h/7d/all)에만 적용.
- **로직**: `status<>'completed'` AND 같은 팀·같은 workReportId의 완료 사본이 존재(`dwr.wrid IS NOT NULL`) → terminal 분모 제외.
- **안전 불변식**: `status<>'completed'` 가드로 완료 행은 절대 제외 안 됨 → `completed⊆terminal` 유지 → completion>100% 회귀 없음 (실측 55팀 breach 0건).
- **과잉제외 방지**: 완료 형제 없는 단독 빈-산출 실패(예: wr_B)는 그대로 카운트 (테스트 `legal-wrB-fail`로 가드).
- **성능**: 초기 상관 서브쿼리(EXISTS) 방식은 대형 tasks 테이블 재스캔으로 15.2s → 파생 테이블 해시조인으로 재구현해 **491.9ms** (baseline 205.7ms, +286ms). cron 주기 실행이라 허용 범위.
- **롤백**: terminal CASE 3곳에서 해당 조건 + JOIN 제거 = 정확히 이전 동작.

## [검증 — T1]

- `npx tsc --noEmit` → 0 오류.
- `npx vitest run team-scorer.test.ts` → 5/5 (신규 회귀 테스트 `excludes failed work-report fan-out siblings…` 포함).
- 관련 스위트 `cron-scheduler.team-scores` + `team-lifecycle` 포함 → 12/12.
- 실 DB 직접 검증: legal-counsel 48h **terminal 12→10, completed 10 → completion 83.3%→100%**.
- 전 55팀 `completion>100 || <0` breach = **0건**.

## [주의 — HR 결정 필요 · 자체판단 금지]

`teams.is_active = 0` (현재 **비활성**). 라이브 스코어러는 `WHERE t.is_active=1`로 이 팀을 제외하므로
현재는 점수 산출 자체가 되지 않는다(HR 스냅샷은 비활성화 이전 값). **팀 재활성/은퇴는 HR 전용 라이프사이클
권한**이며 지시("Do not delete or deactivate teams. HR alone owns lifecycle")에 따라 자체 재활성화하지 않음.
스코어러 수정은 팀 무관(team-agnostic)하게 전역 적용되므로, 재활성 시 자동으로 공정 집계된다.

## [Mem0 연동 키]

- `project_legal_counsel_cycle1_rootcause_dup_fanout` (신규)
- 관련: `project_computer_use_queue_rootcause_already_done` (동일 팬아웃 계열), `project_legal_counsel_report_gap_loop` (텍스트-전용 보고 루프), `project_tech_port_02_rootcause_already_done` (workReportId 팬아웃 선행 사례)
