---
title: 분석·추론팀 중복 오류·False Report 교차검증
date: 2026-07-24
team: team_research-analysis
tags:
  - self-improve
  - research-analysis
  - duplicate-error
  - false-report
  - lease-race
---

# 분석·추론팀 중복 오류·False Report 교차검증 — 2026-07-24

## 종합 판정

검증 상태는 **Share with caveats**다.

- HR의 `2026-07-24 05:00:00 UTC` 실측값 `score=84.2`,
  `completion=86.7%`, `sample=48h/15`는 lifecycle 원문과 일치한다.
- 직접 원인은 같은 업무보고 `wr_5jFD_m94LPa_KVGC`가 33초 간격으로 두 번
  생성되고, 두 태스크가 모두 `lease_expired`로 남아 실패 2건으로 집계된 것이다.
- 단순한 “never-ran/무산출”은 아니다. 두 태스크 모두 ack와 heartbeat가 있고,
  `agent_actions`에는 lease 만료 뒤 ollama의 `task:completed` 출력이 남아 있다.
  task 상태와 late result가 경합해 결과가 task/work report에 반영되지 않은 것이다.
- 두 최초 provider 오류는 각각 자원 한도 초과와 timeout으로 서로 다르며,
  target 48시간 창의 NCO 연결거부는 0건이다. 따라서 동일 오류용 신규
  research-analysis Circuit Breaker 룰은 근거가 없다.
- 현재 활성 `workReportId` 중복 방지 Gate가 당시와 같은 동시 fan-out을 이미
  차단하므로 대상 팀 전용 소스 변경은 하지 않았다. 다만 terminal 뒤 순차 재시도
  폭주는 다른 팀에서 남아 있어 별도 전역 후속 과제로 기록한다.
- scorer 패치의 `13/13=100%`는 검증된 **counterfactual 집계값**이지,
  실제 보고 제출 완료율이 아니다. 대상 `work_reports` 행은 여전히 `missed`다.

## 데이터 범위와 소스

- 추출 시각: `2026-07-24 05:59:27 UTC` / `14:59:27 KST`.
- 고정 표본창: `[2026-07-22 05:00:00, 2026-07-24 05:00:00]` UTC.
- T1 소스: `db/nco.db`의 `tasks`, `agent_actions`, `work_reports`,
  `team_lifecycle_events`, `hourly_role_audits`, `logs`, `false_reports`,
  `circuit_states`, `schema_migrations`.
- 코드 소스: 분석 기준 commit `0652272134386e6ffc518cb2d2da20ebce5898b9`
  (후속 HEAD `41ef9b5`는 아래 관련 소스를 변경하지 않음),
  `src/core/team-scorer.ts`, `src/server/task-intake.ts`,
  `src/server/gateway.ts`, `src/core/work-report-scheduler.ts`.
- NCO HTTP API `localhost:6200`: 연결 거부. 이 문서는 DB read-only 조회를
  live API 성공으로 표현하지 않는다.

## 고정창 재측정

| 관점 | 분모 | 완료 | completion | score | 판정 |
|---|---:|---:|---:|---:|---|
| DB 원시 terminal 행 | 19 | 13 | 68.4% | 비정규 표본이라 미산출 | 실패 4 + lease 만료 2 포함 |
| 05:00 lifecycle/scorer | 15 | 13 | 86.7% | 84.2 | HR 실측과 일치 |
| 동일 WR을 논리 업무 1건으로 중복 제거 | 14 | 13 | 92.9% | `[미검증]` | 실제 missed 업무 1건을 실패로 유지 |
| HEAD scorer 조건 고정창 replay | 13 | 13 | 100.0% | 95.8 | 중복 실패 두 행을 분모에서 모두 제외한 counterfactual |
| 05:10 lifecycle | 13 | `[미기록]` | `[미기록]` | 95.8 | patch 전 age-out 뒤 실제 score event |
| 대상 work report 자체 | 1 | 0 submitted | 0.0% | 해당 없음 | `work_reports.status='missed'` |

HEAD replay의 score는 현재 활성 팀 집합에서 `maxN=85`로 재계산했다. 같은
재현식으로 과거 조건의 score는 84.1이어서 lifecycle의 84.2와 0.1 차이가 난다.
이는 추출 시점의 활성 팀 집합을 과거 시점으로 완전히 복원하지 않은 영향이므로,
과거 실제 score의 소스 오브 트루스는 lifecycle `84.2`다.

`05:10 UTC` 회복은 두 lease 행의 생성시각 `05:02:45`, `05:03:18`이 rolling
48시간 하한 밖으로 밀린 뒤 발생했다. all-failed fan-out 제외가 들어간
`aa30b09`는 `05:22 UTC`, 범위 가드와 회귀 테스트를 추가한 `0652272`는
`05:53 UTC` 커밋이다. 따라서 `05:10 score=95.8`을 patch 효과로 귀속하면
False Report다.

## 반복 실패 사슬

| task_id | 생성 | task 최종상태 | ack / heartbeat | nvidia 오류 | ollama late action | task 산출물 |
|---|---|---|---|---|---|---|
| `task_gXcRlu7Ui41AtYar` | 05:02:45 | `lease_expired` 05:08:07 | ack 05:02:46 / HB 05:06:17, seq 16 | `503 ResourceExhausted: ... (19/16)` | `task:completed` 05:14:18, 본문 존재 | response/result NULL |
| `task_HFKv-pgafAT8ADJZ` | 05:03:18 | `lease_expired` 05:06:32 | ack 05:03:18 / HB 05:04:52, seq 8 | `The operation was aborted due to timeout` | `task:completed` 05:13:12, 본문 존재 | response/result NULL |

두 태스크의 `metadata_json.workReportId`는 동일하다. target `agent_actions`는
각 태스크마다 `created → nvidia failed → ollama completed` 3행씩, 총 6행이다.
ollama 완료는 task가 이미 lease 만료 terminal이 된 뒤 6분 이상 늦게 도착했다.
`work_reports.source_task_id`는 첫 태스크를 가리키지만 보고서 본문은 비어 있고
최종 상태는 `missed`다.

### 후보별 판정

| 후보 | 실측 | 판정 |
|---|---|---|
| never-ran lease 만료 | ack 존재, HB seq 16/8 | 기각 |
| 동일 provider 오류 반복 | resource limit 1, timeout 1 | 기각 |
| gateway/NCO 연결거부 | target tasks·logs 0건 | 기각 |
| 큐 기아 | provider 동시요청 한도 관측, 큐 대기 원자료 없음 | `[미검증]` |
| 중복 fan-out | 동일 WR, 생성 간격 33초 | 확정 |
| lease/late-result 상태 경합 | terminal 뒤 action completion 2건 | 확정 |
| 실제 보고 제출 성공 | work report `missed`, 본문 NULL | 기각 |

## auto-audit·Circuit Breaker·False Report 경계

| 소스 | 실측 | 해석 |
|---|---:|---|
| `hourly_role_audits.subject_id IN ('team_research-analysis','research-analysis')` | 0 | 팀 전용 auto-audit 판정 없음 |
| 고정창 `logs`의 팀/task/ECONNREFUSED 매치 | 0 | 저장 운영 로그 근거 없음 |
| target lease 태스크 `agent_actions` | 6 | late completion을 확인하는 교차 증거 |
| `false_reports` 전체 | 0 | 공식 False Report 판정 자체가 없음 |
| 개선 pipeline 관련 `verification_gates` | 15 | typecheck/change-ratio pass, lint skip 기록 |
| 최초 3개 stage의 `FORMAT_MISMATCH` | 3 | 모두 262자 도구 설명 에코 |

`2026-07-24 06:04:30 UTC` 재조회에서 `nvidia`는
`closed/failure_count=0`, `ollama`는 `closed/failure_count=1`
(`reason=generic`)이다. 둘 다 현재는 open 상태가 아니지만, 이 현재 snapshot은
2026-07-22 당시 상태를 증명하지 않는다. 역사적 circuit snapshot은 `[미검증]`이다.

공식 `false_reports` 행이 0이므로 “False Report가 없었다”고 단정할 수 없다.
정확한 표현은 “등록된 공식 판정은 없고, task/DB/Git 교차검증으로 아래 보고
불일치를 별도 판정했다”이다.

## 자가개선 보고 교차검증

### 원 stage `task_kF6zTz7Nkzq15bpm`

| 항목 | T1 관측 | 판정 |
|---|---|---|
| 상태 | `completed`, `qualityRejected=true` | 품질 통과 아님 |
| 사유 | `FORMAT_MISMATCH` | 산출물 형식 실패 |
| 응답 | 262자 `searchFiles` 함수 설명 | 코드/감사 보고가 아님 |
| evidence | NULL | patch 귀속 불가 |
| verifier | `npm run build` exit 0 | 당시 현재 소스 compile만 증명 |

원 stage는 성공을 주장한 보고서라기보다 **비산출/FORMAT_MISMATCH**다.
악의적 False Report로 확정하지 않지만 공유 가능한 자가개선 산출물은 아니다.

### retry·Git 산출물

- retry `task_54QCEVypIIPOKFp0`는 추출 시 `running`, response/evidence가 NULL이다.
  완료 보고가 없으므로 task 수준 성공은 `[미검증]`이다.
- commit `0652272`에는 scorer의 fan-out 그룹을
  `failed|timed_out|lease_expired`로 한정한 1개 조건 변경과 분석팀 회귀 테스트가
  실제로 존재한다.
- 고정창 replay는 patch 보고의 `13/15 → 13/13`, completion `100%`,
  score `95.8` counterfactual을 재현한다.
- 다만 commit `0652272`는 9개 파일을 포함하며 CFO 노트, 별도 보고서, HNSW
  바이너리 등이 섞여 있다. 따라서 “단일 목적 최소 diff의 되돌릴 수 있는 단일
  커밋”이라는 산출물 요건은 충족하지 않는다.
- `100%`는 scorer 분모 제외 결과다. 논리 업무 1실패를 남기는 재측정은
  `13/14=92.9%`, 실제 대상 업무보고는 `missed`다. 이를 구분하지 않고 “실제
  업무 완료율 100% 회복”이라고 표현하면 False Report다.

## Gate 변경 판단

### 대상 팀 전용 변경 불필요

기존 Gate는 다음 두 층으로 실제 적용돼 있다.

1. migration `085_active_work_report_task_idempotency.sql`
   - `idx_tasks_active_work_report_id` partial unique index.
   - 활성 상태 `pending|queued|assigned|running|streaming|reviewing`에서 동일
     `workReportId` 두 행을 DB가 거부한다.
2. `/api/task` intake
   - insert 전 활성 태스크를 찾아 기존 `taskId`를 `deduplicated=true`로 반환한다.
   - 동시 insert race에서 unique 오류가 나도 기존 활성 태스크를 다시 조회한다.

migration은 `2026-07-24 02:22:50 UTC` 적용됐다. 대상 중복은 이틀 전인
`2026-07-22` 발생이므로 현재 Gate라면 두 번째 활성 행을 만들 수 없다. 추출 시
전체 DB의 활성 `workReportId` 중복 그룹은 0이다. provider 오류도 동일 signature가
아니고 gateway 연결거부도 없으므로 research-analysis 전용 CB 패턴을 추가하면
실제 timeout과 자원 한도를 하나로 뭉뚱그리는 과잉 차단이 된다.

### 남은 전역 리스크

현재 partial unique index는 terminal 뒤 정상 재시도를 허용한다. migration 적용 뒤
다른 팀의 동일 WR 세 그룹에서 각각 `27`, `22`, `21`행이 관측됐고, 합계는
Hermes circuit 관련 terminal 실패 67행(`generic open` 66 + `denied
execution` 1) + queued 3행이다. 활성 중복은 없지만 scheduler가 terminal
failure를 unlink한 뒤 매 tick 재발행한 순차 폭주다.

이는 research-analysis의 2026-07-22 provider/lease 경합과 다른 패턴이며 대상 팀
점수 수정에 섞어서는 안 된다. 후속 전역 수정은 `work-report-scheduler`가 agent
circuit-open 동안 unlink/redispatch를 보류하거나 report별 재시도 cap/cooldown을
두는 방식으로 별도 설계·검증해야 한다. 정상 terminal retry 의미를 바꾸므로 이번
팀 한정 작업에서 임의 수정하지 않았다.

## 재현 가능한 핵심 조회

```sql
SELECT status, COUNT(*)
FROM tasks
WHERE team_id='team_research-analysis'
  AND created_at BETWEEN '2026-07-22 05:00:00' AND '2026-07-24 05:00:00'
GROUP BY status;
-- completed 13, failed 4, lease_expired 2

SELECT id, status, acked_at, last_heartbeat_at, heartbeat_seq, error,
       json_extract(metadata_json,'$.workReportId')
FROM tasks
WHERE id IN ('task_gXcRlu7Ui41AtYar','task_HFKv-pgafAT8ADJZ');

SELECT task_id, agent_id, action_type, detail_json, created_at
FROM agent_actions
WHERE task_id IN ('task_gXcRlu7Ui41AtYar','task_HFKv-pgafAT8ADJZ')
ORDER BY task_id, created_at;
```

## 검증 영수증

- [변경]
  `docs/self-improve/research-analysis-duplicate-error-2026-07-24.md` —
  중복 lease/late-result 사슬, Gate 판단, False Report 교차검증 기록.
- [Gate diff]
  없음 — target 패턴은 기존 active-work-report unique Gate가 차단하며 신규
  team-specific CB signature 근거가 없음.
- [DB]
  lifecycle `84.2/86.7%/15`, raw `19/13`, 논리 중복제거 `14/13`,
  HEAD replay `13/13`·score `95.8`, work report `missed`.
- [관련 테스트]
  `npx vitest run src/core/team-scorer.test.ts src/server/task-intake.test.ts
  src/core/work-report-scheduler.test.ts src/security/circuit-breaker.test.ts`
  → `2026-07-24 15:07 KST` 독립 재실행, 4 files/33 tests passed, exit 0.
- [타입체크]
  `npx tsc --noEmit` → `2026-07-24 15:07 KST` 독립 재실행, 출력 없음, exit 0.
- [빌드]
  `npm run build` → `2026-07-24 15:07 KST` 독립 재실행, `tsc`, exit 0.
- [전체 테스트]
  `npx vitest run` → `2026-07-24 15:08 KST` 독립 재실행,
  96 files/477 tests passed, 1 file/1 test failed.
  실패는 범위 밖 `tests/근거.test.ts:20`의 고정 기대값 `2026-07-14`와
  실제 포인터 `2026-07-24` 불일치다.
- [호출 정정]
  외부 `runTest`가 응답의 한국어 표제어를 Vitest 필터로 넘겨
  `filter: 영수증:` 또는 `filter: 결과:`로 종료한 두 로그는 제품 테스트 결과가
  아니다. 위 네 명령은 추가 인자 없이 독립 실행했다.
- [등급]
  T1 — SQLite 원문 행, Git object/소스, 실제 명령 출력 직접 확인.
- [롤백]
  이 작업의 신규 감사 노트만 제거하면 된다. DB, task, team, lifecycle,
  circuit 상태는 변경하지 않았다.
- [Gap]
  NCO API 비가용, 팀 전용 auto-audit 0행, 역사적 circuit snapshot 없음,
  retry task 미완료, 전역 terminal redispatch cap/cooldown 미구현.
