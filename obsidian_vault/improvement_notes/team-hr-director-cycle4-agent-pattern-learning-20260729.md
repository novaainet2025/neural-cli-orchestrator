---
title: "Team Lifecycle HR Director Cycle 4 에이전트 실패 패턴 학습"
date: 2026-07-29
team_id: team_hr-director
team_slug: hr-director
source_task_id: task_k2QXx3V5oC6Lnx55
cycle: 4
evidence_tier: T1
tags:
  - nco
  - self-learning
  - hr-director
  - work-report
  - mem0
---

# Team Lifecycle HR Director Cycle 4 에이전트 실패 패턴 학습

## 결론

지시문에 기록된 `score=81.8`, `completion=85.7`, `sample=48h/7`은
2026-07-29 01:40:00 UTC의 운영 DB 스냅샷과 일치한다. 그러나 같은 논리 업무보고의
재배달 task가 01:41:02 UTC에 완료된 뒤 직접 재계산한 최신 값은
`score=94.7`, `completion=100`, `n=7`, `maxN=62`, `sample=48h`였다.

따라서 이 주기의 직접 원인은 HR 업무 내용 실패가 아니다. `cursor-agent`의 일시적
provider 연결 실패 뒤 `hermes`로 재배정된 Codex CLI가 시작 훅에 실패하고 idle
timeout에 도달한 provider/failover 런타임 사건이다. 같은 `workReportId`는 후속
task에서 정상 완료됐고 기존 scorer가 활성 재시도와 배달 완료 형제를 구분해 점수를
회복했다.

새 점수 보정이나 팀 lifecycle 변경은 불필요하다. 이번 주기의 최소 가역 수정은 이
판별 규칙을 팀 Mem0에 기록해 향후 에이전트가 raw task 행을 논리 업무 실패로 오인하지
않도록 한 것이다.

## 최근 48시간 표본

운영 DB `tasks` 원문을 task 유형과 agent별로 다시 집계했다.

| agent | task 유형 | completed | timed_out | cancelled | 판정 |
|---|---:|---:|---:|---:|---|
| `cursor-agent` | 회사 감사 | 1 | 0 | 1 | 완료 1건, SIGINT 취소 1건 |
| `cursor-agent` | 팀 상시 임무 | 2 | 0 | 0 | 2건 모두 완료 |
| `cursor-agent` | 업무보고 | 3 | 0 | 0 | 3건 모두 완료 |
| `hermes` | 업무보고 | 1 | 1 | 0 | 두 행 모두 같은 논리 업무보고 |

현재 raw 행은 완료 7건, timeout 1건, 취소 1건이다. scorer 표본은 취소 행을 세지 않고,
동일한 `workReportId`의 완료 형제가 있는 timeout 행을 중복 실패에서 제외하므로
완료 7/7이다.

이 48시간 표본 안에서 반복되는 agent/task 유형의 실질 실패는 없다. `hermes`의 timeout은
한 번뿐이고 동일 논리 업무가 이후 `hermes` 재배달에서 완료됐다. “반복 실패”라고 주장하려면
raw 재시도 행이 아니라 서로 다른 논리 업무의 최종 미배달이 최소 두 건 있어야 한다.

## 실패 사건 원문

### 최초 실행

- task: `task_41umGRQ-8CnSPQmG`
- 최초 agent: `cursor-agent`
- `agent_invocations.error`:
  `cursor-agent: CLI failed exit=1 — NonRetriableError: Provider Error We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.`
- invocation 소요: `7778ms`
- decision log: `reassign:cursor-agent->hermes`

### 재배정 실행

- 최종 상태: `timed_out`
- 오류: `timeout(idle)`
- heartbeat: 4회
- response: 6844바이트
- result: 0바이트
- task event 소요: `908602ms`
- response 끝부분: `hook: SessionStart Failed`, `hook: UserPromptSubmit Failed`

6844바이트는 업무보고 본문이 아니라 Codex CLI 시작 정보, 원래 prompt 재출력, 장기 기억
컨텍스트, 훅 실패 로그다. 즉 agent가 HR 보고 내용을 작성한 뒤 품질에 실패한 사건이 아니다.

### 동일 논리 업무의 복구

- 논리 키: `wr_1VwBRwye7R-Ph0yl`
- 후속 task: `task_R2wdt7iSufGn-jCb`
- agent: `hermes`
- 실행: 2026-07-29 01:40:13~01:41:02 UTC
- 결과: `completed`, response 1127바이트
- `team_lifecycle_events`:
  - 01:40:00 — `score_checked`, 81.8, completion 85.7, n=7
  - 01:40:22 — `score_recovered`, 94.3, n=6
  - 01:41:03 — `score_checked`, 94.7, n=7

이 시간 순서는 기존 활성 재시도 제외와 배달 완료 형제 제외가 의도대로 작동했음을 보여준다.
새 scorer 예외를 추가하면 이미 복구되는 사건을 중복 보정할 위험이 있다.

## 7일 확장 패턴과 해석 제한

7일 raw 행에서는 `hermes`의 circuit-breaker 실패가 110행이지만 서로 다른 논리 항목은
2개뿐이다. 그 밖에 job-wait timeout 2행, queue-wait 1행, idle timeout 1행이 있다.
`opencode`도 circuit-breaker 실패 43행이지만 논리 항목은 2개다. 같은
`workReportId`를 반복 생성한 과거 fan-out이 raw 실패 수를 크게 부풀린다.

반대로 `hermes` 완료는 5행/4개 논리 항목, `cursor-agent` 완료는 9행/9개 논리 항목이다.
최근 48시간만 보면 `cursor-agent`가 HR 팀 task의 안정적인 주 실행자라는 근거가 더 강하다.

주입된 `agent_performance_summary`도 현재 표본으로 오해하면 안 된다.

- `cursor-agent` 행의 `last_updated`: 2026-06-10
- `hermes` 행의 `last_updated`: 2026-07-09
- `hermes`의 code/design/research/review/verify/ui 성공률 0%는 이 과거 materialized
  summary 값이며, 최근 48시간의 동일 업무보고 재배달 성공을 포함하지 않는다.

향후 학습에서는 최근 task 원문과 논리 업무 최종 상태를 우선하고, 오래된 materialized
summary는 보조 신호로만 사용한다.

## 적용한 최소 가역 수정

팀 장기 기억 범위 `team:team_hr-director`에 다음 재사용 규칙을 기록했다.

1. raw task 행 수가 아니라 `workReportId`별 최종 배달 상태를 확인한다.
2. provider 연결 오류, 시작 훅 실패, circuit-breaker, queue/job-wait timeout을 HR
   산출물 내용 실패와 분리한다.
3. 단일 provider timeout만으로 팀 lifecycle 또는 retirement 결정을 내리지 않는다.
4. task 완료와 `work_reports` ingestion을 별도 검증한다.
5. 팀 상태와 멤버십 변경은 HR 소유로 남긴다.

Mem0 ID는 `mem0-1785289443475-13px1x`다. SQLite 행, HNSW 인덱스 count=4,
검색 결과 1위를 직접 확인했다. 상세 기록은
`team-hr-director-cycle4-mem0-update-20260729.json`에 있다.

운영 코드 diff는 0이다. `teams` 행은 `is_active=1`, `is_always_on=1`,
`lead=cursor-agent`로 유지했고, lifecycle event의 `retired`와 `restored`는 모두 0건이다.

## 검증 영수증

- [근거] `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`, `agent_actions`,
  `agent_invocations`, `decision_log`, `team_lifecycle_events`, `mem0_entries` 행
- [근거] `computeTeamScores()` 직접 실행 결과:
  `{"score":94.7,"completion":100,"n":7,"maxN":62,"sample":"48h"}`
- [Mem0] `mem0-1785289443475-13px1x`, content SHA-256
  `a3f7f001fc149cbc9ceb967505c01f40cc385226f8f05724ce3eaa923cd79101`
- [HNSW] count=4, 파일 SHA-256
  `72aa26ff1ccaba7b7f6b18d7cf402cee3b28561298f1064144e1600b77f00cc7`
- [등급] T1 — DB 행, 파일 본문, 실행 출력 직접 확인

## Gap과 롤백

- NCO HTTP `localhost:6200`은 연결 거부여서 HTTP Mem0 경로와 conductor 교차검토는
  수행하지 못했다. 동일 코드 경로인 `vectorMemory.add()`를 직접 실행하고 DB/HNSW/search로
  검증했다.
- `work_reports.wr_1VwBRwye7R-Ph0yl`은 후속 task 완료 뒤에도 현재 `pending`이고
  `body_md`가 0바이트다. backend가 내려가 ingestion이 실행되지 않은 상태로 보이지만,
  실제 원인은 backend 재기동 후 scheduler ingestion을 관찰해야 확정할 수 있다.
- 다음 예약 실행에서 90점 이상 유지 여부는 아직 미검증이다.
- 롤백은 이 노트와 JSON 로그를 제거하고, 명시적 승인 후 Mem0 ID
  `mem0-1785289443475-13px1x` 행을 제거한 다음 해당 team HNSW 인덱스를 rebuild하면 된다.
  롤백은 실행하지 않았다.
