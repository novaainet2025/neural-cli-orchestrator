---
title: "team_cfo 중복 work-report timeout — cycle 1"
date: 2026-07-24
team_id: team_cfo
team_slug: cfo
snapshot_utc: "2026-07-24 05:00:00"
score: 87.3
completion: 90.9
sample: 48h/11
evidence_tier: T1
mem0_key: project_team_cfo_cycle1_duplicate_work_report_timeout
tags:
  - nco/self-improve
  - cfo
  - work-report
  - duplicate-fanout
  - scorer
---

# team_cfo 중복 work-report timeout — cycle 1

## 한 줄 판정

`team_cfo`의 48h/11 결손은 CFO 산출물 미배달이 아니라, 이미 완료 형제가
있는 동일 `workReportId`의 중복 사본 하나를 `timed_out` 실패로 다시 센
스케줄러 팬아웃/스코어러 경계 문제다.

## T1 행

| task_id | status | agent | workReportId | heartbeat | error | 판정 |
|---|---|---|---|---:|---|---|
| `task_3TlVeMIGK2jZIDk7` | completed | opencode | `wr_iRaNIyiaBq7orx3I` | 7 | NULL | 논리 보고서 배달 |
| `task_nOh_b4GnVr1r1IuJ` | timed_out | opencode | `wr_iRaNIyiaBq7orx3I` | 61 | `timeout(idle)` | 배달 후 남은 중복 사본 |

두 행은 같은 team, prompt, workReportId를 가진다. 완료 사본은
`2026-07-23 05:02:14 UTC`, 중복 사본은 `05:17:11`에 종료됐다.

## 배제된 가설

- `lease_expired`: 고정 창 0건.
- heartbeat-NULL / never-ran: 고정 창 0건. 결손 행 heartbeat는 61.
- `FORMAT_MISMATCH`: 7개 행에서 관측됐지만 모두 completed. 결손 행에는
  해당 신호가 없다.
- 재무 데이터소스 부재: 보고서 내용의 품질/가용성 과제이나 관련 DB
  task는 completed라 90.9% 결손을 만들지 않았다.

## 현재 수정 상태

HR 스냅샷 `2026-07-24 05:00:00 UTC`의 원시 집계는 completed 10 /
terminal 11 = 90.9%다.

스냅샷 뒤인 `05:22:34 UTC`의 commit
`aa30b09ac2d665070368780bbb194f635a85ea7f`에는 같은 팀·같은
workReportId의 completed 형제가 있을 때 non-completed 사본만 terminal
분모에서 제외하는 일반 가드가 이미 있다. CFO 예외나 새 코드 diff는 만들지
않는다. API 중단으로 라이브 서비스 로드와 다음 점수는 미검증이다.

## Mem0/memory 재발 방지 교훈

> 팀 완료율은 물리 task row가 아니라 논리 산출물 배달 여부와 함께
> 해석해야 한다. 동일 `(team_id, workReportId)`에 completed 형제가 있으면
> non-completed 형제는 팀 품질 실패가 아니라 팬아웃 아티팩트로 분리한다.
> 단, completed 형제가 없는 단독 timeout은 실제 실패로 유지하고,
> heartbeat 유무만으로 중복 배달 여부를 추정하지 않는다.

- canonical memory key:
  `project_team_cfo_cycle1_duplicate_work_report_timeout`
- Mem0 영속화: **미수행** — `localhost:6200` 연결 거부. 가짜 ID 없음.
- 상세 근거:
  [[cfo-rootcause-2026-07-24|CFO 48h/11 근본원인 보고서]]

## 후속 확인

1. NCO API 복구 후 CFO task 목록과 team score를 읽기 전용 재조회한다.
2. work-report-scheduler에서 같은 workReportId가 여러 completed task로
   남는 `wr_p2MGFBgnU1tsVLh1` 패턴도 생성 단계에서 계측한다.
3. 팀 lifecycle은 HR 권한이므로 변경하지 않는다.

