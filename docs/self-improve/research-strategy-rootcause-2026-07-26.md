# team_research-strategy 근본원인 분석 — cycle 4/3 (2026-07-26)

> **SUPERSEDED (cycle 5):** 이 문서의 “실작업 중 사용자 중단에 의한 정당
> 실패” 결론은 같은 시각의 PM2 `Shutting down` 원문과 세 provider 동시
> SIGINT/exit 130 기록에 의해 기각됐다. 최신 판정과 수정은
> `obsidian_vault/improvement_notes/team-research-strategy-cycle5-shutdown-sigint-20260726.md`를
> 따른다. 아래 내용은 판정 이력 보존용이다.

> HR DIRECTIVE: score=83.3, completion=87.5%, sample=48h/8 · 담당: 자가학습팀
> 결론: **신규 근본원인 0건. HR 스냅샷은 stale, 유일 카운트 실패는 cycle2에서 기판정된 '실작업 중 SIGINT abort' 카테고리 재발 1건. scorer 무변경(diff 0), surface & hold.**

## 1. 실측 (T1)

- 조회 시각: 2026-07-26 (48h 윈도우 = 07-24 ~ 07-26)
- 방법: `db/nco.db` 직접 조회 — `computeTeamScores()`의 6개 exclusion 절(INFRA · CONTROL_PLANE_PERFGOAL · LEASE_NEVER_RAN · WORK_REPORT_DUP_DELIVERED · WORK_REPORT_FANOUT_ALL_FAILED · JOB_WAIT_DEAD_AGENT)을 SQL로 그대로 재현 + `npx tsx`로 scorer 자체 실행 이중 확인.
- 라이브 스코어(scorer 직접 실행): `{"score":81.4,"grade":"B","completion":85.7,"n":7,"sample":"48h"}` = 6완료/7카운트.
- HR 스냅샷(87.5%/8)과의 차이: 완료 1건(task_bM5cv-OTJEZplaom, 07-24 06:38 생성)이 48h 윈도우를 이탈. 스냅샷 시점 7/8=87.5% ↔ 현재 6/7=85.7% — **표본 드리프트일 뿐 신규 실패 발생 없음.**

## 2. 표본 8건 전수 판정표 (HR 스냅샷 기준 카운트 대상)

| # | task_id | 상태 | 에이전트 | hb_seq | 산출물(rlen) | 판정 | 근거 (T1) |
|---|---------|------|----------|--------|--------------|------|-----------|
| 1 | task_bM5cv-OTJEZplaom | completed | opencode | 12 | 153 | 정상 완료 | DB row; cycle2 당시 'queued'였던 건이 정상 완료됨. 현재는 윈도우 이탈 |
| 2 | task_Z2dHw0zeA0pZjqm_ | completed | claude-code | 6 | 941 | 정상 완료 | wr_n51OekbZZJSKW0va 실배달본 |
| 3 | task__04Go89EOIojlPdW | completed | claude-code | 6 | 2665 | 정상 완료 | DB row |
| 4 | task_rqeBjdKtM3pecZgs | completed | ollama | 4 | 591 | 정상 완료 | DB row |
| 5 | task_CLCWy1BZDVqqFWPb | completed | ollama | 5 | 978 | 정상 완료 | DB row |
| 6 | task_WZ1iiz-Dnd7v8WG4 | completed | nvidia | 2 | 985 | 정상 완료 | DB row |
| 7 | task_bBJ8fWUCwJjfbJsS | completed | agy | 9 | 1370 | 정상 완료 | wr_QxViGkc4gpdQhLAP 실배달본 |
| 8 | task__zXpjggKrqmyv0Of | **failed** | opencode | **4** | 0 | **정당 실패** (기판정 카테고리) | error=`opencode: CLI failed exit=unknown — Command was killed with SIGINT (User interruption with CTRL-C)`. 04:12 생성→04:49 마지막 hb, 37분 실작업 후 강제 중단, 산출물 0 |

3분류 요약: **신규 실패 0 · 기제외(카운트 제외됨) 89 · 정당 실패 1 · 정상 완료 7**.

## 3. 기제외 89건 (48h 터미널 96건 − 카운트 7건) — 전부 기존 카테고리

| 묶음 | 건수 | error 패턴 | 적용된 기존 exclusion |
|------|------|-----------|----------------------|
| wr_Kb6xuW_v1mCU3-td 팬아웃 | 69 | Circuit breaker open (opencode) | INFRA + FANOUT_ALL_FAILED |
| wr_n51OekbZZJSKW0va 팬아웃 | 8 | Circuit breaker open (opencode·cursor-agent) | INFRA + DUP_DELIVERED (완료 형제 task_Z2dHw0zeA0pZjqm_ 존재) |
| team-runner 산발 CB | 11 | Circuit breaker open (opencode·hermes) | INFRA |
| wr_wFHYWnUS_OENmWt5 | 1 | Circuit breaker open (opencode) | INFRA |

07-25 05~08시 opencode 서킷브레이커 장애로 work-report-scheduler가 동일 workReportId를 ~70회 재발행한 인프라 이벤트. 팀 품질과 무관하며 기존 절이 전량 제외 — **stale 재계상도, 신규 원인도 아님.**

## 4. 유일 실패 건 판정 — cycle2 판정과의 대조

- cycle2 (docs/self-improve/research-strategy-rootcause-2026-07-24.md): task_ewJ3BdhLQz5XfOcR = cursor-agent **exit=130(SIGINT)**, hb 32, 실작업 중 abort → 스코어러 불변식(hb>0 = 실작업 실패로 카운트, team-scorer.ts:204 주석)상 **정당 카운트**, 단일 케이스 exclusion 추가는 지표 게이밍으로 기각.
- cycle4 (이번): task__zXpjggKrqmyv0Of = opencode **SIGINT kill**, hb 4, 37분 실작업 후 abort — **동일 카테고리 재발.** 48h 전팀 SIGINT-kill 실패는 이 1건뿐(T1: 전팀 GROUP BY 조회) → 단일 케이스 exclusion은 이번에도 부적격. **scorer 코드 무변경.**

## 5. 조치 및 검증

- 변경: 본 노트 1건 + 장기기억 갱신(아래) — **src diff 0** (bounded, 문서만이므로 되돌리기 = 파일 삭제).
- 검증: `npx tsc --noEmit` + `npx vitest run src/core/team-scorer.test.ts` (결과는 보고 영수증 참조).

## 6. Mem0/장기기억 갱신 초안 (반영됨)

`project_research_strategy_rootcause_already_done.md`에 cycle4 재확정 추가: HR 83.3/87.5%/8 stale, 실측 81.4/85.7%/7(B), 유일 실패=task__zXpjggKrqmyv0Of(SIGINT abort, hb 4 실작업)=기판정 정당 실패 카테고리, 신규 원인 0, scorer 무변경, 재작업 금지.
