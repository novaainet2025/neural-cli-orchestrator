---
title: "Triad Command & Judge 48h/6 실패 패턴 — cycle 1"
date: 2026-07-24
team_id: team_triad-command-judge
team_slug: triad-command-judge
source_task_id: task_kV6VYLvbNyX7Qb0W
improvement_cycle: 1
snapshot_utc: "2026-07-24 03:10:00"
score: 50
completion: 50
sample: 48h/6
evidence_tier: T1
mem0_id: "mem0-1784864918194-7cpl95"
tags:
  - nco/self-improve
  - triad-command-judge
  - lease-expired
  - late-result-race
  - mem0
---

# Triad Command & Judge 48h/6 실패 패턴 — cycle 1

## 판정

`score=50`, `completion=50%`, `48h/6`의 직접 원인은 토론 미수렴이나
`FORMAT_MISMATCH`가 아니라 **같은 업무보고 fan-out 세 건의
`lease_expired` 집계**다.

세 건은 모두 `workReportId=wr_I1mTe__cHAH5D4Ul`이고, 최초 요청 대상
`claude-code`의 circuit breaker가 열린 뒤 `opencode`로 재할당됐다. task 행은
ack 이후 heartbeat 0, `response=NULL`, `result_json=NULL`인 채 lease 만료로
종결됐다. 그 결과 스코어러의 당시 원시 표본은 `completed=3`,
`lease_expired=3`이 되어 completion이 정확히 `3/6=50%`가 됐다.

다만 이를 “에이전트가 전혀 실행되지 않은 never-ran”으로 단정할 수는 없다.
세 task 모두 `agent_actions.task:completed`가 lease 만료 174~200초 뒤
도착했다. 정확한 근본원인 분류는 **heartbeat/lease 만료와 late completion
event 간 상태 경합**이다. 늦은 출력도 공백 1건, 보고서 1건, 무관한 코드 조각
1건이므로 세 건을 성공 산출물로 재분류할 근거도 없다.

## T1 원천과 범위

- HR 스냅샷:
  `team_lifecycle_events.id=tle_d663wyv8QMmTopTa`,
  `created_at=2026-07-24 03:10:00 UTC`,
  `metadata_json={"sample":"48h","n":6,"completion":50}`.
- DB: 요청에 적힌 `db/nco.sqlite`는 존재하지 않는다. 실제 운영 원천
  `db/nco.db`를 `sqlite3 -readonly`로 조회했다.
- 창: `2026-07-22 03:10:00` 이상, `2026-07-24 03:10:00` 이하에 생성된
  `tasks.team_id='team_triad-command-judge'` 여섯 행.
- 교차검증: 여섯 task의 `agent_actions` 12행과 연결된 `discussions` 행을
  조회했다. 연결 discussion은 0행이다.
- `localhost:6200` API는 조회 시 연결 거부였다. 따라서 API를 호출했다고
  주장하지 않으며, 동일 원천 DB 행만 T1로 사용한다.

## 실패 유형 빈도

| 분류 | 빈도 | task_id | T1 근거 |
|---|---:|---|---|
| task terminal `completed` | 3 | `task_FiLGwZ_ec9LxMM0p`, `task_0BY3rdSi1hsxYYeZ`, `task_TRmtenu0XE09r7zo` | `tasks.status=completed`, `error=NULL` |
| lease/late-result 상태 경합 | 3 | `task_HCgj8ICR22wc7cIn`, `task_7k_Ok1CKnoPTTPlX`, `task_rhnUFXmH8w792YZR` | `tasks.status=lease_expired`, ack 있음, heartbeat 0, task response 없음; 뒤늦은 action completion 있음 |
| `FORMAT_MISMATCH` terminal 실패 | 0 | — | 여섯 task의 `error`, `metadata_json`, `verifier_result_json`에 quality reject 기록 없음 |
| gateway-down terminal 실패 | 0 | — | 여섯 task의 error는 NULL 또는 `lease_expired`; NCO 연결거부 기록 없음 |
| discussion 미수렴·정족수 실패 | 0 | — | 여섯 task에 연결된 `discussions` 0행 |

## 표본 6건

| task_id | 최종 agent | task 상태 | heartbeat / task response | action 결과 | 분류 |
|---|---|---|---|---|---|
| `task_FiLGwZ_ec9LxMM0p` | `opencode` fallback | completed | seq 5 / 1,619 bytes | 정상 시각 completion | 상태상 성공. 다만 주입되지 않은 `FORMAT_MISMATCH`·에이전트 상태를 T1이라고 서술해 사실성 Gap이 있음 |
| `task_0BY3rdSi1hsxYYeZ` | `ollama` | completed | seq 6 / 115 bytes | 정상 시각 completion; verifier build exit 0 | HTTP 2건의 201 대신 필수값을 되묻는 `question:` 응답. task 계약 성공은 미검증 |
| `task_TRmtenu0XE09r7zo` | `opencode` fallback | completed | seq 5 / 1,787 bytes | 정상 시각 completion | 상태상 성공. 응답의 `FORMAT_MISMATCH x4`·일부 fleet 상태는 주입 원문 밖 주장 |
| `task_7k_Ok1CKnoPTTPlX` | `opencode` fallback | lease_expired | seq 0 / NULL | lease +174초, 출력 2 bytes(공백) | lease/late-result 경합 + 무내용 산출 |
| `task_HCgj8ICR22wc7cIn` | `opencode` fallback | lease_expired | seq 0 / NULL | lease +190초, 출력 1,000 bytes | lease/late-result 경합; action에는 보고서가 있으나 task에 반영되지 않음 |
| `task_rhnUFXmH8w792YZR` | `opencode` fallback | lease_expired | seq 0 / NULL | lease +200초, 출력 1,000 bytes | lease/late-result 경합 + 업무보고와 무관한 코드 조각 |

`agent_actions`의 `task:completed`라는 문자열은 task 성공의 지상 진실이 아니다.
세 늦은 event가 도착하기 전에 task state machine은 이미 lease 만료로
종결됐고, event 출력도 task의 `response`/`result_json`에 반영되지 않았다.

## 에이전트별 패턴

| agent | task 행 | action 관찰 | 판정 |
|---|---|---|---|
| `claude-code` | 최종 assigned task 0건 | 다섯 건의 최초 `task:created`; 모두 circuit-open 뒤 fallback | 산출물 품질을 평가할 실행 표본이 없다. 가용성 요인만 확인됨 |
| `opencode` | completed 2, lease_expired 3 | 다섯 건 모두 completion event. 만료 세 건은 lease 이후 174~200초 도착 | fallback 자체는 두 건 완료했지만, 업무보고 fan-out은 heartbeat 누락·late result와 출력 품질 문제가 함께 있음 |
| `ollama` | completed 1 | completion event 1 | 상태는 완료지만 요구된 HTTP 201 증거가 없고 clarification만 반환해 계약 이행은 미검증 |

이 표본은 “terminal status 기준 완료율”과 “실제 요구사항 이행 품질”이 서로
다름을 보여 준다. 따라서 기존 50%를 순수 팀 품질로 보아도 안 되고, 수정 후
100%를 완전한 판단 품질로 보아도 안 된다.

## 배제된 가설

1. **`FORMAT_MISMATCH`**: 두 completed 응답이 과거 패턴으로 언급했을 뿐,
   여섯 task의 terminal error/metadata에는 해당 reject가 없다. 이번 3개
   실패의 원인이 아니다.
2. **토론 라운드·정족수·synthesis**: 연결 discussion이 0행이라 원인으로
   지목할 근거가 없다.
3. **gateway down**: 표본 task에는 연결거부 error/response가 없다.
4. **정상적인 실작업 timeout**: task heartbeat는 모두 0이지만 늦은 action
   completion이 있으므로 단순 “실행 전 사망”도 T1로 확정할 수 없다.

## 이미 적용된 bounded fix와 남은 Gap

이번 자가학습 하위작업 전에 커밋
`aff5990d82b59f5a136f7a6a6ebd1d3c8716b303`이
`src/core/team-scorer.ts`에 `LEASE_NEVER_RAN_EXCLUSION`을 추가했다.
조건은 `status='lease_expired'`, `acked_at IS NOT NULL`,
`last_heartbeat_at IS NULL`인 행만 terminal 분모에서 제외하며, heartbeat가
있는 실제 timeout과 completed 행은 유지한다. 한 곳의 predicate를
48h/7d/all terminal CASE에 재사용하므로 변경은 bounded하고, predicate
삽입 세 곳을 제거하면 되돌릴 수 있다.

DB lifecycle은 커밋 뒤 `2026-07-24 03:30:01 UTC`에
`score_recovered=92.9`, `sample=48h`, `n=3`을 기록했고 03:40 재검사도
같았다. 이는 분모 오염 제거가 스코어러에 반영됐다는 T1 행이지, 세 completed
산출물의 내용 품질이 모두 검증됐다는 뜻은 아니다.

남은 Gap은 predicate 이름과 주석의 “never-ran” 해석이다.
`agent_actions`의 늦은 completion 출력을 보지 않고 heartbeat NULL만으로
never-ran이라고 부르므로, 후속 lifecycle/lease 수정에서는 다음을 별도로
다뤄야 한다.

- lease 소유자 실행 중 heartbeat가 왜 0이었는지와 만료 후 completion event
  수용/폐기 정책을 추적한다.
- scorer 제외 조건을 liveness 신호로 유지하되, late completion action의 존재와
  출력 품질을 별도 운영 지표로 남긴다.
- completed task도 HTTP 201, 근거 범위, 출력 계약 같은 task-specific verifier로
  검증한다. 일반 `npm run build` 성공을 HTTP 입력 성공으로 대체하지 않는다.

이번 하위작업은 이미 적용된 scorer 소스를 다시 수정하지 않았다. 팀 활성 상태,
lifecycle, task status, HR 은퇴 판단도 변경하지 않았다.

## Mem0 장기기억

- agent: `self-learning`
- user: `team_triad-command-judge`
- id: `mem0-1784864918194-7cpl95`
- mode: BM25 (`NCO_MEM0_NO_EMBED=1`, embedded=false)
- 한 줄 요약: `triad-command-judge 48h/6의 3개 실패는 같은 workReportId에서 ack 후 heartbeat 0으로 lease 만료됐지만 174~200초 뒤 task:completed action이 도착한 lease/late-result 경합이다; FORMAT_MISMATCH나 토론 미수렴으로 단정하지 말고 tasks와 agent_actions를 함께 확인한다.`

롤백 시 이 문서와 Mem0의 위 단일 ID만 대상으로 한다. 에이전트 전체 기억을
지우는 `mem0Clear`는 사용하지 않는다.

## 재현 쿼리

```sql
SELECT id, assigned_to, status, created_at, completed_at, error,
       acked_at, last_heartbeat_at, heartbeat_seq, lease_expires_at,
       length(response), metadata_json, verifier_result_json
FROM tasks
WHERE team_id='team_triad-command-judge'
  AND created_at BETWEEN datetime('2026-07-24 03:10:00','-48 hours')
                     AND '2026-07-24 03:10:00'
ORDER BY created_at;
```

```sql
SELECT a.task_id, a.agent_id, a.action_type, a.created_at,
       length(json_extract(a.detail_json,'$.output')) AS action_output_bytes,
       ROUND((julianday(a.created_at)-julianday(t.lease_expires_at))*86400,1)
         AS seconds_after_lease
FROM agent_actions a
JOIN tasks t ON t.id=a.task_id
WHERE a.task_id IN (
  'task_FiLGwZ_ec9LxMM0p', 'task_0BY3rdSi1hsxYYeZ',
  'task_TRmtenu0XE09r7zo', 'task_HCgj8ICR22wc7cIn',
  'task_7k_Ok1CKnoPTTPlX', 'task_rhnUFXmH8w792YZR'
)
ORDER BY a.task_id, a.created_at;
```

## 검증 영수증

- [변경] `docs/self-improve/triad-command-judge-failure-patterns-2026-07-24.md`
  — 실제 lifecycle/task/action 행 기반의 실패 빈도·근본원인·Gap.
- [변경] Mem0 `mem0-1784864918194-7cpl95` — 위 확정 패턴 한 줄.
- [검증방법] DB read-only 재집계, 문서 재읽기, Mem0 row·BM25 재조회,
  `npx tsc --noEmit`, `npx vitest run src/core/team-scorer.test.ts`,
  `npm run build`, `git diff --check`.
- [등급] T1 — SQLite 원본 행, 파일 본문, 실제 명령 출력.
- [Gap] scorer fix는 이미 별도 커밋에 존재하며 이번 하위작업에서 소스를
  재수정하지 않았다. API `localhost:6200`은 연결 거부라 동일 원천 DB를
  직접 조회했다.
- [미검증항목] late completion event의 state-machine 경로, 세 completed
  task의 업무별 계약 이행, 개선 후 다음 48시간 품질 추세.

### 검증 로그

```text
$ npx tsc --noEmit
(stdout/stderr 없음)
exit code 0
```

```text
$ npx vitest run src/core/team-scorer.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ git diff --check -- docs/self-improve/triad-command-judge-failure-patterns-2026-07-24.md
(stdout/stderr 없음)
exit code 0
```

```text
mem0Add:
id=mem0-1784864918194-7cpl95
stored=true
embedded=false

mem0Search(agentId=self-learning, userId=team_triad-command-judge,
           query="lease heartbeat late result"):
mode=bm25
ids=[mem0-1784864918194-7cpl95]
```
