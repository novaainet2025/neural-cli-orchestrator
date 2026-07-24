---
title: 분석·추론팀 completion 저하 근본원인
date: 2026-07-24
team: team_research-analysis
tags:
  - self-improve
  - research-analysis
  - lease-expired
  - work-report-fanout
---

# 분석·추론팀 근본원인 분석 — 2026-07-24

## 결론

`2026-07-24 05:00:00 UTC`(KST 14:00) HR 스냅샷의 `score=84.2`,
`completion=86.7%`, `48h/15`는 DB와 일치한다. 원인은 never-ran이나
게이트웨이 연결거부가 아니라, 동일 업무보고 `wr_5jFD_m94LPa_KVGC`가 33초 간격으로
두 번 생성되고 두 실행이 모두 provider/fallback 단계에서 `lease_expired`가 된 뒤
스코어러가 이를 서로 다른 실패 2건으로 센 것이다.

두 태스크는 heartbeat가 각각 16회와 8회 있으므로
`LEASE_NEVER_RAN_EXCLUSION` 대상이 아니다. 한 건의 논리 업무를 행 단위 실패 2건으로
센 오케스트레이션 표본 오합산이 completion을 `13/15=86.7%`로 낮췄다.

## 데이터 범위와 집계 재현

- T1 소스: `db/nco.db`의 `tasks`, `team_lifecycle_events` 행을 `sqlite3 -readonly`로 조회.
- 기준 시각: lifecycle event `tle_UDwSDbNPBSPcf8lj`, `2026-07-24 05:00:00 UTC`.
- 48시간 창: `2026-07-22 05:00:00` 이상, `2026-07-24 05:00:00` 이하.
- latency 정의: `completed_at - created_at`(없으면 `updated_at - created_at`), 밀리초.
- 스코어러 상태 집합: `completed`, `failed`, `timed_out`, `lease_expired`.

| 단계 | terminal | completed | completion | 근거 |
|---|---:|---:|---:|---|
| DB 원시 행 | 19 | 13 | 68.4% | 완료 13 + 실패 4 + lease 만료 2 |
| 당시 스코어러 제외 적용 | 15 | 13 | 86.7% | orphan 3 + circuit 1 제외 |
| 동일 work report를 논리 업무 1건으로 중복제거 | 14 | 13 | 92.9% | lease 만료 2행을 실패 업무 1건으로 계산 |
| 현재 HEAD의 all-failed fan-out 제외 규칙 적용 | 13 | 13 | 100% | 두 중복 실패 행 모두 분모 제외 |

`team_lifecycle_events`도 같은 시각에 `score=84.2`, `completion=86.7`,
`n=15`, `sample=48h`를 기록했다. 따라서 HR 수치는 stale/fabricated 값이 아니다.

## 당시 유효 표본 15건

| task_id | status | agent | latency_ms | last heartbeat / seq | error | 판정 |
|---|---|---|---:|---|---|---|
| `task_gXcRlu7Ui41AtYar` | lease_expired | ollama | 322000 | 05:06:17 / 16 | `lease_expired` | 실패·중복 WR |
| `task_HFKv-pgafAT8ADJZ` | lease_expired | ollama | 194000 | 05:04:52 / 8 | `lease_expired` | 실패·중복 WR |
| `task_I7tEJaVY4DK7kU3p` | completed | ollama | 228000 | 06:35:25 / 21 | NULL | 완료 |
| `task_6XT5cedyH57Vc7AW` | completed | hermes | 146000 | 07:45:59 / 20 | NULL | 완료 |
| `task_GARkyUMuyL_gFqKV` | completed | agy | 146000 | 10:14:48 / 16 | NULL | 완료 |
| `task_qpw2V16PjZCQ3oFT` | completed | codex | 44000 | 15:23:06 / 6 | NULL | 완료 |
| `task_s7Qhwi4lmUc3ATp6` | completed | codex | 470000 | 00:10:43 / 35 | NULL | 완료 |
| `task_oBORE6jwJsHbWJoM` | completed | codex | 482000 | 00:10:56 / 33 | NULL | 완료 |
| `task_8GyMOXiTZ5qwOFJA` | completed | codex | 496000 | 00:11:09 / 17 | NULL | 완료 |
| `task_00mqCLGPWXJpfy8j` | completed | codex | 370000 | 05:09:03 / 25 | NULL | 완료 |
| `task__2kypGo9AckNlxuO` | completed | codex | 424000 | 05:09:58 / 33 | NULL | 완료 |
| `task_gpYZfLH-7zYC4DNZ` | completed | codex | 472000 | 05:11:22 / 14 | NULL | 완료 |
| `task_dFxhSjsEHl5bVdzg` | completed | codex | 52000 | 15:32:43 / 5 | NULL | 완료 |
| `task_gfVzXOrmmkcyA_A3` | completed | codex | 1597000 | 00:30:05 / 35 | NULL | 완료 |
| `task_fCFvmhrbYy9aT_s5` | completed | codex | 1673000 | 00:31:24 / 22 | NULL | 완료 |

표의 heartbeat 시각은 각 행 날짜의 UTC이며, task ID별 원문은 DB에서 재조회할 수 있다.

## 분모에서 이미 제외된 원시 실패 4건

| task_id | agent | latency_ms | heartbeat seq | DB error | 당시 제외 사유 |
|---|---|---:|---:|---|---|
| `task_f-Z1FrwVm7VHWbSW` | agy | 12110000 | 31 | `orphaned: server restart (poison — requeued 2x)` | `INFRA_EXCLUSION` |
| `task_iBVEFSARVtZAxm8W` | opencode | 147000 | 14 | `orphaned: server restart (poison — requeued 2x)` | infra + `commander-perfgoal` |
| `task_n2QkREHMwdAgv13t` | codex | 862000 | 0 | `orphaned: server restart (poison — requeued 2x)` | `INFRA_EXCLUSION` |
| `task_M_aLmvGtYUT1a_2Y` | claude-code | 1803000 | 0 | `Circuit breaker open for agent claude-code (generic)` | `INFRA_EXCLUSION` |

이 4건은 원시 terminal 19에는 있지만 당시 유효 분모 15에는 없다. 따라서 이들을
`86.7%`의 직접 원인으로 지목하는 것은 False Report다.

## 두 lease 만료의 실패 사슬

| task_id | 동일 WR | 최초 provider 실패 | fallback 관측 | 산출물 |
|---|---|---|---|---|
| `task_gXcRlu7Ui41AtYar` | `wr_5jFD_m94LPa_KVGC` | nvidia `503 ResourceExhausted: Worker local total request limit reached (19/16)` | ollama heartbeat 16회 후 만료 | response/result 모두 NULL |
| `task_HFKv-pgafAT8ADJZ` | `wr_5jFD_m94LPa_KVGC` | nvidia `The operation was aborted due to timeout` | ollama heartbeat 8회 후 만료 | response/result 모두 NULL |

두 행은 모두 동일한 `2026-07-22 오후 업무보고` 프롬프트다. verifier의
`npm run build`는 나중에 exit 0이지만, 업무보고 response가 없으므로 산출물 완료 증거가
아니다.

### 후보별 판정

- never-ran lease_expired: 기각. `acked_at`과 heartbeat가 모두 존재한다.
- 게이트웨이 다운/연결거부: 기각. 두 행의 error·response에 포트 6200 연결거부가 없다.
- 큐 기아: `[미검증]`. 한 행에 provider 동시요청 한도 초과는 있지만 큐 대기시간 원자료는 없다.
- 실제 분석 품질 결함: 근거 없음. 두 행 모두 분석 결과를 반환하기 전에 실행 인프라에서 만료됐다.
- 오케스트레이션 표본 오합산: 확정. 동일 `workReportId` 실패가 2개의 terminal 행으로 집계됐다.

## 시간 경과와 현재 코드 상태

- `05:00 UTC`: lifecycle `score_checked`가 `84.2 / 86.7% / n=15` 기록.
- `05:10 UTC`: 두 lease 행이 rolling 48h 창 밖으로 자연 만료되어
  `score_recovered=95.8`, `n=13` 기록.
- `05:20 UTC`: `score=95.7`, `n=13` 기록.
- `05:22 UTC` 이후 HEAD `aa30b09`에는
  `WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION`이 존재한다
  (`src/core/team-scorer.ts:262-287`, 집계 적용부 `:303`, `:317`, `:330`).

따라서 05:10의 회복을 05:22 이후 코드 변경의 효과로 보고하면 안 된다. 회복의 직접
원인은 rolling window age-out이다. 현재 규칙은 같은 패턴이 창 안에 있어도 중복 실패
행을 제외하는 bounded·reversible 가드지만, all-failed fan-out 전용 회귀 테스트는 현재
파일에서 확인되지 않았다. 자가개선 단계에서는 이 케이스를 별도 테스트로 고정해야 한다.

## Mem0 연동용 지식 항목

- key: `project_research_analysis_work_report_fanout_20260724`
- fact: `team_research-analysis`의 2026-07-24 `86.7% (13/15)` 저하는 동일
  `workReportId=wr_5jFD_m94LPa_KVGC`의 heartbeat 보유 lease 만료 2행을 독립 실패로 센 결과다.
- discriminator: `status=lease_expired AND heartbeat_seq>0`이므로 never-ran 규칙으로
  제외하지 말고, `team_id + metadata_json.workReportId` 중복 여부와 provider escalation을
  함께 확인한다.
- evidence: `task_gXcRlu7Ui41AtYar`, `task_HFKv-pgafAT8ADJZ`,
  lifecycle `tle_UDwSDbNPBSPcf8lj`, git `aa30b09`.
- reuse: score 저하 조사 시 현재 시각의 rolling query만 보지 말고 lifecycle 이벤트 시각으로
  48시간 창을 고정해 재현한다.

## 검증 영수증

- [변경] `docs/self-improve/research-analysis-rootcause-2026-07-24.md` — 잘못된 타 팀
  한 줄/오진 내용을 실제 DB 근거 노트로 교체.
- [검증방법] 고정 48h SQL → `raw 19/13`, 당시 필터 `15/13`, HEAD 필터 `13/13`;
  lifecycle row → `score=84.2`, `completion=86.7`, `n=15`;
  `npx tsc --noEmit` → exit 0;
  `npx vitest run src/core/team-scorer.test.ts` → 1 file, 5 tests passed;
  `npm run build` → `tsc`, exit 0.
- [등급] T1 — SQLite 원문 행, lifecycle 이벤트, 소스/커밋 직접 확인.
- [Gap] all-failed fan-out 전용 단위 테스트는 `[미검증]`; 직접 `computeTeamScores` 호출은
  샌드박스의 tsx IPC `EPERM`으로 실행하지 못했으므로 SQL로 동일 조건을 재현했다.
- [미검증항목] provider 큐 대기시간, 운영 배포 프로세스가 HEAD를 로드했는지 여부.
- 안전: 팀 삭제·비활성·lifecycle 상태 변경 및 소스코드 변경 없음.
