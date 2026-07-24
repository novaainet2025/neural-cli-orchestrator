---
created_at: 2026-07-24T13:07:13+09:00
verified_at: 2026-07-24
tags:
  - improvement-note
  - category/team-quality
  - team/cli-design
  - nco/mem0
  - nco/knowledge-base
  - evidence/T1
  - cycle/1
---

# cli-design cycle 1 — 48시간 표본 근본원인

## 범위와 기준선

- 대상은 `team_cli-design`(`cli-design`, CLI UI/UX 디자인팀)이다.
- HR 기준선은 `team_lifecycle_events.tle_Ka6JnpUXkSxhQ1Y8`의
  2026-07-24 03:50:00 UTC 스냅샷이다. 저장값은 score `82.2`,
  sample `48h/7`, completion `85.7%`다.
- T1 원천은 `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
  `work_reports`, `agent_invocations`, `team_goals`,
  `performance_reports`, `team_lifecycle_events` 원문 행과 HR 스냅샷 직전
  scorer 버전 `aff5990:src/core/team-scorer.ts`의 집계 조건이다.
- DB 시각은 UTC다. 아래 표는 재검증 편의를 위해 원문 UTC 시각을 그대로 쓴다.
- 이 작업은 지정 노트 한 파일만 추가한다. task 상태, score, 팀 활성 상태,
  lifecycle 상태, Mem0 및 knowledge-base 행은 변경하지 않는다.
- 시작 시 지정 경로는 존재하지 않았다. 조사 중 별도 cycle 3 문서와 scorer
  수정 commit이 추가됐으므로, 아래에는 이 작업이 직접 조회한 DB 행과 고정
  snapshot만 근거로 사용한다.

## 최근 48시간 표본 7건

HR 스냅샷과 같은 집계 기준으로 48시간 terminal 표본은 완료 6건과 실패
1건이다. `6 / 7 = 85.7%`다.

| task ID | 생성 시각(UTC) | 실행자 | 스포너 / 작업 유형 | DB 상태 | T1 결과 |
|---|---|---|---|---|---|
| `task_Kai5XNVISSPIBARG` | 2026-07-22 05:00:53 | `codex` | `work-report-scheduler` / 오후 업무보고 | completed | `work_reports.wr_tauFnXzz_k7u5727`가 submitted, 본문 366자; build verifier passed |
| `task_-iJZ5wvysxCwCc98` | 2026-07-22 15:02:45 | `agy` | `team-runner` / 텍스트 전용 일일 분석 | completed | prompt가 도구·파일 수정 금지, response 1,516자; verifier 없이 완료 |
| `task_gza0z01f3XEmLJGO` | 2026-07-23 00:00:45 | `agy` | `work-report-scheduler` / 오전 업무보고 | completed | `work_reports.wr_k8v9k15Ri0m4gwik`가 submitted, 본문 707자; build verifier passed |
| `task__yrkxBrm5qs1AQ6W` | 2026-07-23 05:01:02 | `agy` | `work-report-scheduler` / 오후 업무보고 | completed | `work_reports.wr_ED0hXleznbDap2hO`가 submitted, 본문 618자; build verifier passed |
| `task_dWW-eyL6sIl07j77` | 2026-07-23 11:33:20 | `ollama` | `commander-perfgoal` / 목표·성과보고 제어면 입력 | failed | response=`targetValue and direction are unknown; reflection and improvement are unknown; no evidence to verify`; error=`unknown: failure pattern in output` |
| `task_ZLvmT_y-FiPbTTj5` | 2026-07-23 15:01:49 | `agy` | `team-runner` / 텍스트 전용 일일 분석 | completed | prompt가 도구·파일 수정 금지, response 1,636자; verifier 없이 완료 |
| `task_WaoIC08g94ev6UI7` | 2026-07-24 00:00:53 | `agy` | `work-report-scheduler` / 오전 업무보고 | completed | `work_reports.wr_0nXhRDzl3Z6XAymb`가 submitted, 본문 856자; build verifier passed |

같은 48시간에 raw terminal 행은 하나 더 있다.
`task_UbgK8HFH0-cvvwtt`는 `status=failed`,
`error='orphaned: server restart (poison — requeued 2x)'`라 scorer의
인프라 제외 조건으로 분모에서 빠진다. 따라서 위 표가 저장된 `n=7`과
일치한다.

## 에이전트별 성공·실패 패턴

| 실행자 | 표본 | 완료 / 실패 | 관측 패턴 |
|---|---:|---:|---|
| `codex` | 1 | 1 / 0 | 업무보고 파일을 만들고 build verifier까지 통과했다. |
| `agy` | 5 | 5 / 0 | 업무보고 3건을 submitted로 연결했고, 파일 diff가 금지된 텍스트 전용 분석 2건도 정상 완료했다. |
| `ollama` | 1 | 0 / 1 | CLI 디자인 산출물이 아니라 `commander-perfgoal` 제어면 요청에서 필수값 미주입을 지적하고 값 날조를 거부했다. |

`task_dWW-eyL6sIl07j77`의 build verifier는 passed지만 이는 저장소 타입체크
결과일 뿐, 요청된 HTTP POST 성공을 증명하지 않는다. 해당 task의 response와
invocation summary 모두 같은 거부문이며 task status도 failed다.

한편 19분 뒤 별도 task `task_UbgK8HFH0-cvvwtt`의 invocation은 HTTP 201 확인을
보고했고, DB에는 같은 팀·날짜의 goal
`goal_soCIclMJrj82kSla`와 performance report
`perf_Rl5dyvlncgZ0HUzp`가 각각 11:54:53, 11:55:03 UTC에 존재한다. 다만 두
행에는 source task FK가 없으므로 특정 task가 생성했다고 단정하지 않는다.

## 가설 판정과 근본원인

### 1. text-only 산출물의 diff 부재가 Gap 스코어러에서 미완으로 오탐했는가?

**이 표본에서는 아니다.** `task_-iJZ5wvysxCwCc98`과
`task_ZLvmT_y-FiPbTTj5`는 prompt 자체가 도구·파일 수정을 금지한 text-only
태스크이고 verifier도 없지만 둘 다 completed다. 나머지 업무보고 4건도
markdown 본문이 `work_reports`에 submitted로 저장됐다. 7개 행의
`metadata_json`에는 `qualityRejected` 또는 `FORMAT_MISMATCH` 값이 없다.

따라서 repo diff 부재를 이유로 이 6개 성공이 미완 처리됐다는 T1 증거는 없다.

### 2. 실제 미제출 태스크가 있는가?

task 단위로는 **1건이 미제출**이다. `task_dWW-eyL6sIl07j77`은 목표·성과보고
HTTP 입력을 수행하지 않고 필수 입력값 부재를 보고했다. 그러나 이것은 CLI
UI/UX 설계·업무보고 산출물의 미제출이 아니라, 별도 `commander-perfgoal`
제어면 입력 계약 실패다. 값이 주입되지 않은 상태에서 수치를 만들지 않은
`ollama`의 동작은 honesty-first 원칙에 부합한다.

### 확정 근본원인

score 정체의 직접 원인은 **CLI 디자인 품질 표본에 제어면 관리 태스크
1건을 혼합한 표본 오염**이다. 완료한 CLI 디자인/보고 태스크는 6/6인데,
필수 목표값이 없는 `commander-perfgoal` 거부 1건이 terminal 분모에 들어가
completion이 100%가 아니라 85.7%로 계산됐다. 이는 실행자 품질 문제나
text-only diff 오탐이 아니라 task taxonomy와 scorer 분모의 불일치다.

## bounded 후보와 동시 작업 상태

- 자가개선 단계에서는 `spawned_by_cli='commander-perfgoal'`인 제어면 task를
  팀 charter 품질 표본과 분리하는 scorer 가드를 검토한다.
- 적용한다면 completed와 terminal 양쪽에 같은 조건을 사용해
  `completed <= terminal` 불변식을 유지하고, 전체 활성 팀 회귀 테스트를
  추가한다.
- 롤백 단위는 해당 scorer 조건과 테스트뿐이어야 하며 팀 삭제·비활성화·
  lifecycle 변경은 하지 않는다.
- 이 노트를 검증하는 동안 별도 작업이 commit `c31625f`, `259d198`,
  `1dfa39e`에서 위 team-agnostic 가드를 `src/core/team-scorer.ts`에 적용했다.
  중복 수정을 피하기 위해 이 작업에서는 scorer를 편집하지 않았다.
- 이 노트는 진단 산출물이다. 동시 commit을 이 작업의 변경으로 보고하거나,
  다음 lifecycle 표본 전에 score가 향상됐다고 주장하지 않는다.

## Mem0/knowledge-base 연동 교훈

> `[저장 제안·미연동]` text-only 여부나 repo diff 유무로 팀 품질을 판정하지 말고, `spawned_by_cli`로 제어면 task와 charter 산출물을 분리하며 미주입 값을 정직하게 거부한 결과는 실패 지식이 아니라 입력 계약 결함으로 저장한다.

## 검증 영수증

- `[lifecycle]` `tle_Ka6JnpUXkSxhQ1Y8`에서 score `82.2`,
  metadata `{"sample":"48h","n":7,"completion":85.7,...}`를 직접 조회했다.
- `[tasks]` 표본 7건의 id, status, assigned_to, spawned_by_cli,
  prompt, response, error, metadata, verifier 결과를 직접 조회했다.
- `[submitted reports]` 업무보고 4건의 `work_reports.status=submitted`,
  source task 및 body 길이를 직접 조회했다.
- `[failure]` 유일 실패 task와 `agent_invocations.inv_9ymLAgrvGzFv4dhe`가
  동일한 미주입 값 거부문을 저장한 것을 확인했다.
- `[score scope]` 2026-07-24 04:00:00 UTC 후속 lifecycle snapshot은 score
  `82.1`, 같은 `48h/7`, completion `85.7%`다. score의 volume 항은 다른 팀의
  최대 표본 수에 따라 변하므로 HR 지시 시점의 `82.2`를 현재 재계산값으로
  가장하지 않는다.
- `[source snapshot]` HR 이벤트보다 앞선 commit `aff5990`은
  `commander-perfgoal` 제외를 `team_kd-memory`에만 한정해
  `team_cli-design`의 거부 task를 분모에 남긴다. 현재 source의
  team-agnostic 제외는 `1dfa39e`에서 직접 확인했다.
- `[SQL assertions]` 지정 ID 재집계 결과 rows `7`, completed `6`,
  failed `1`, agents `3`, quality-rejected rows `0`; submitted work reports
  `4`; SQLite `PRAGMA quick_check`는 `ok`.
- `[focused test]` `npx vitest run src/core/team-scorer.test.ts` → 1 file,
  4 tests passed, exit `0`.
- `[typecheck]` `npx tsc --noEmit` → exit `0`, 출력 없음.
- `[build]` `npm run build` → TypeScript `tsc`, exit `0`.
- `[등급]` T1 — DB 원문 행과 저장소 파일 내용을 직접 확인했다.
- `[미검증항목]` 외부 Obsidian 원본 vault 동기화, 다음 독립 표본의 score
  변화, Mem0/knowledge-base 실제 저장·검색, 동시 scorer commit의 전체
  테스트 스위트·운영 프로세스 반영·런타임 효과.
