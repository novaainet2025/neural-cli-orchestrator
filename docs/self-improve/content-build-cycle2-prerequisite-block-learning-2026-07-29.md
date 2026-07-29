---
title: content-build cycle 2 — declared prerequisite blocker classification
date: 2026-07-29
team_id: team_content-build
team_slug: content-build
cycle: 2
evidence_tier: T1
status: implemented_verified_locally
obsidian_target: 08-IMPROVEMENTS/NCO/team-content-build-cycle2-prerequisite-block-20260729.md
tags:
  - nco
  - self-improvement
  - content-build
  - prerequisite-block
  - retry-loop
---

# content-build cycle 2 — 선언된 선행조건 차단 분류

## 결론

`team_content-build`의 지시문 기준값 `score=61.3`, `completion=62.5%`,
`48h/8`은 운영 DB `db/nco.db`와 현재 빌드 산출물로 재계산했을 때 일치했다.
최근 터미널 8행은 완료 5행과 실패 3행이다.

그러나 같은 회사 workflow의 동일 review 작업이 선행팀의 승인된 근거팩 부재로
실행 불가능하다고 보고한 뒤에도 총 5회 dispatch됐다. 첫 dispatch 이후의 중복은
4회이며 실행자는 `codex → ollama → codex → ollama → codex`로 4회 교체됐다.
동일한 정당한 blocker가 응답 표면에 따라 두 가지로 잘못 분류됐다.

- `error: BLOCKED`로 시작한 codex 2행은
  `failure-pattern: agent reported error`라는 일반 실패가 됐다.
- `status:`로 시작한 ollama 2행은 DB에서 `completed`가 됐지만 회사 산출물
  품질 게이트가 `done:`이 아니므로 다시 dispatch됐다.

수정은 요청 본문에 선행조건이 선언되어 있고, 최종 `status:`/`error:` 응답이
그 선행조건의 실제 부재와 차단을 함께 명시할 때만
`blocked-prerequisite: declared prerequisite unavailable` fingerprint를 부여한다.
이 결과는 기존 `cancelled` 종결 상태로 저장되므로 팀 성과의 성공·실패 어느 쪽에도
넣지 않고, 기존 failover 조건에 따라 실행자를 다시 dispatch하지 않는다.

## Tier 1 근거 위치

- 운영 DB: `db/nco.db`
- 팀 정의: `teams.id='team_content-build'`
- 작업 원문과 결과: `tasks`
- 이벤트 로그: `work_events`
- dispatch 보조 로그: `agent_actions`
- 기존 판정 코드: `src/server/gateway.ts`
- 회귀 테스트: `src/server/detect-failed-completion.test.ts`

DB는 `PRAGMA journal_mode` 결과 `wal`이었다. 관찰 시각은 SQLite
`2026-07-29 06:25:26` UTC, 로컬 `2026-07-29 15:25:26`이었다.

## 48시간 표본 8행

아래 행은 `team_id='team_content-build'`, 터미널 상태, 최근 48시간 조건으로
최신 8행을 조회한 결과다.

| task | executor | status | UTC 생성 시각 | 검증된 패턴 |
|---|---|---:|---|---|
| `task_vaJ7ohqY_sFkEqHT` | opencode | failed | 05:58:43 | `discussion_insufficient_valid_proposals:0/2`; 응답 없음 |
| `task_ZrMFUlB8oVrQxaN6` | codex | completed | 06:00:14 | 텍스트 상시 임무 응답 1,440자 |
| `task_ju0xiKaQzhTaP4K3` | opencode | completed | 06:02:17 | 단일 content-gen 버그 수정 응답 659자 |
| `task_Ej435t1Uq1RH4bzX` | hermes | completed | 06:07:22 | Blogger DRAFT-only 안정화 응답 1,615자 |
| `task_eMva63ao2fjDYEaX` | codex | failed | 06:13:14 | 선언된 선행조건 차단을 일반 실패로 오분류 |
| `task_-UDCDk5z_ewqwLGf` | ollama | completed | 06:16:16 | 같은 선행조건 차단을 완료로 오분류 |
| `task_jX5LC9uaq8hTO4kP` | codex | failed | 06:16:55 | 선언된 선행조건 차단을 일반 실패로 오분류 |
| `task_BDQvIauXahtPrvD3` | ollama | completed | 06:19:14 | 같은 선행조건 차단을 완료로 오분류 |

운영 score 재계산 출력:

```json
{"teamId":"team_content-build","slug":"content-build","name":"고품질 콘텐츠 제작팀","organizationId":"org_sns-blog","score":61.3,"grade":"D","completion":62.5,"n":8,"maxN":61,"sample":"48h"}
```

## blocker fingerprint와 반복 횟수

동일 review prompt의 SHA3-256:

```text
3f4bc9e563de66effadb047905f83299a437104060be1d120b2b83dc90173788
```

논리 키:

```text
workflow_run_id = wfr_gPC_-rytCy-bkS4X
workflow_stage  = review
prompt_sha3_256 = 3f4bc9e563de66effadb047905f83299a437104060be1d120b2b83dc90173788
```

관찰된 sequence:

```text
task_eMva63ao2fjDYEaX -> task_-UDCDk5z_ewqwLGf
-> task_jX5LC9uaq8hTO4kP -> task_BDQvIauXahtPrvD3
-> task_alFSa9jpYqUwmgBA

codex -> ollama -> codex -> ollama -> codex
failed -> completed -> failed -> completed -> running
```

- 전체 dispatch 행: 5
- 첫 행을 제외한 중복 dispatch: 4
- 인접 실행자 교체: 4
- distinct executor: 2
- 기존 일반 실패 fingerprint:
  `failure-pattern: agent reported error`
- 새 저카디널리티 blocker fingerprint:
  `blocked-prerequisite: declared prerequisite unavailable`

## 작업 본문과 이벤트 대조

작업 본문은 다음의 선행조건을 명시했다.

```text
승인된 근거팩만 입력으로 사용해 ...
직접 확인 가능한 증거가 없으면 완료가 아니라 INCOMPLETE 또는 BLOCKED로 보고한다.
```

선행 단계 출력도 7개 근거팩의 `approval_status`, 공식 1차출처,
교차검증 자료가 모두 `INCOMPLETE`라고 전달했다.

`task_eMva63ao2fjDYEaX`와 `task_jX5LC9uaq8hTO4kP`는 각각 실제 파일과
테스트를 확인한 뒤 `error: BLOCKED`로 응답했다. DB의 최종 error는 둘 다
`failure-pattern: agent reported error`였다.

`work_events`에는 각 codex 행마다 provider의 `task:completed/succeeded`
이벤트 직후 gateway의 `task:failed/failed` 이벤트가 한 건씩 존재한다.
이는 provider 실행 실패가 아니라 완료 응답을 gateway가 텍스트 분류로 실패
전환했음을 보여준다.

ollama 행은 `task:completed/succeeded`가 provider와 gateway에서 각각 기록됐고
최종 DB 상태도 `completed`였다. 그러나 첫 프로토콜이 `status:`여서
`isCompanyStageOutputAcceptable()`의 `done:` 계약을 통과하지 못해 다음 실행자가
dispatch됐다.

## 성공·실패 패턴

### 성공 패턴

- 실제 구현/진단 산출물이 있는 비-blocker 3행은 서로 다른 작업 본문과 workflow를
  가졌고 응답도 비어 있지 않았다.
- 선언된 선행조건을 지킨 에이전트는 근거팩이 승인되지 않았다는 파일 근거를 확인하고
  원고·Blogger LIVE·삭제를 수행하지 않았다. 안전 행동 자체는 정당했다.

### 실패 패턴

- `task_vaJ7ohqY_sFkEqHT`는 `discussion_insufficient_valid_proposals:0/2`,
  응답 0자로 끝났다. 이 행은 확인된 선행조건 blocker가 아니므로 정상 실패로 유지한다.
- 같은 논리 작업이 프로토콜 접두사 차이만으로 `failed`와 `completed` 양쪽에
  갈렸다. 따라서 status 문자열 자체는 성과 근거가 아니다.
- company runner는 `failed`와 `completed-but-not-done` 모두 다음 executor 후보로
  넘겼다. blocker 전용 종결 상태가 없었던 것이 5회 dispatch의 직접 원인이다.

## 구현된 최소 수정

`src/server/gateway.ts`에 prompt-aware 분류를 추가했다.

다음 조건을 모두 만족해야만 prerequisite blocker다.

1. 요청 prompt가 `prerequisite`, `선행조건`, 또는 승인된 입력만 사용한다는 계약을 선언한다.
2. 최종 응답의 첫 프로토콜은 `status:` 또는 `error:`다.
3. 응답이 `BLOCKED`/`cannot proceed`/진행 불가를 명시한다.
4. 응답이 해당 승인 입력·근거팩·선행조건의 missing/INCOMPLETE/부재를 명시한다.

하나라도 없으면 기존 실패 판정을 유지한다. DB migration, 과거 행 수정,
team 활성 상태 변경은 없다.

## 재현 절차

### 표본과 score

```bash
sqlite3 db/nco.db "
SELECT id,status,assigned_to,workflow_run_id,workflow_stage,created_at,
       length(response),error
FROM tasks
WHERE team_id='team_content-build'
  AND status IN ('completed','failed','timed_out','lease_expired')
  AND julianday(created_at) >= julianday('now','-48 hours')
ORDER BY datetime(created_at) DESC
LIMIT 8;"

node --input-type=module - <<'NODE'
import { getDb, closeDb } from './dist/storage/database.js';
import { computeTeamScores } from './dist/core/team-scorer.js';
console.log(JSON.stringify(
  computeTeamScores(getDb()).find(row => row.teamId === 'team_content-build')
));
closeDb();
NODE
```

### 중복 dispatch와 executor 교체

```bash
sqlite3 db/nco.db "
SELECT workflow_run_id,workflow_stage,
       count(*) AS dispatch_rows,
       count(DISTINCT assigned_to) AS executors,
       group_concat(id,' -> ') AS task_ids,
       group_concat(assigned_to,' -> ') AS executor_sequence,
       group_concat(status,' -> ') AS status_sequence
FROM (
  SELECT * FROM tasks
  WHERE team_id='team_content-build'
  ORDER BY datetime(created_at)
)
WHERE workflow_run_id='wfr_gPC_-rytCy-bkS4X'
  AND workflow_stage='review'
GROUP BY workflow_run_id,workflow_stage,prompt;"
```

### 이벤트 분류 전환

```bash
sqlite3 db/nco.db "
SELECT task_id,event_type,outcome,agent_id,occurred_at,summary
FROM work_events
WHERE task_id IN (
  'task_eMva63ao2fjDYEaX',
  'task_-UDCDk5z_ewqwLGf',
  'task_jX5LC9uaq8hTO4kP',
  'task_BDQvIauXahtPrvD3'
)
ORDER BY occurred_at;"
```

### 회귀 테스트

```bash
npx vitest run src/server/detect-failed-completion.test.ts
```

최초 구현 직후 관찰 결과:

```text
Test Files  1 passed (1)
Tests  17 passed (17)
```

관련 gateway/company/workflow/response-quality 회귀군:

```text
Test Files  4 passed (4)
Tests  114 passed (114)
```

타입체크와 직접 빌드:

```text
npx tsc --noEmit  # exit 0, 출력 없음
npx tsc           # exit 0, 출력 없음
```

빌드된 코드로 운영 DB의 blocker 응답 4개를 read-only replay한 결과:

```json
{"id":"task_eMva63ao2fjDYEaX","status":"cancelled","error":"blocked-prerequisite: declared prerequisite unavailable"}
{"id":"task_-UDCDk5z_ewqwLGf","status":"cancelled","error":"blocked-prerequisite: declared prerequisite unavailable"}
{"id":"task_jX5LC9uaq8hTO4kP","status":"cancelled","error":"blocked-prerequisite: declared prerequisite unavailable"}
{"id":"task_BDQvIauXahtPrvD3","status":"cancelled","error":"blocked-prerequisite: declared prerequisite unavailable"}
```

`npm run typecheck`와 `npm run build` wrapper는 코드 오류가 아니라 `tsx`가
sandbox 안에서 IPC socket을 listen하지 못해 각각 아래 오류로 종료됐다.
따라서 wrapper 자체는 PASS로 기록하지 않는다.

```text
Error: listen EPERM: operation not permitted .../tsx-501/<pid>.pipe
```

## 재발 방지 학습 규칙

1. `done:`/`status:`/`error:` 접두사만으로 blocker의 성과를 판정하지 않는다.
2. 정당한 prerequisite block은 요청의 선행조건 선언과 응답의 실제 부재 근거를
   함께 확인한다. 한쪽만 있으면 일반 실패를 유지한다.
3. 같은 `(workflowRunId, workflowStage, prompt fingerprint)`가 blocker 뒤 다시
   생기면 executor failover가 아니라 prerequisite 공급 팀으로 되돌린다.
4. blocker는 성공 분자와 실패 분모 모두에서 제외하되, 별도 blocker 건수와
   fingerprint는 운영 지표로 남긴다.
5. `discussion_insufficient_valid_proposals`, 빈 응답, 테스트 실패 등 실제 실패를
   prerequisite blocker로 재명명하지 않는다.
6. 과거 DB 상태를 덮어써 점수를 올리지 않는다. 수정 효과는 배포 후 새 task에서만
   검증한다.

## Mem0 반영 후보 지식

아래는 후보 목록이며 이번 작업에서 Mem0 DB에는 삽입하지 않았다.

1. **content-build prerequisite contract**
   - 지식: 승인된 evidence pack이 없으면 content-build는 콘텐츠 생성·Blogger 변경을
     수행하지 않고 blocker로 종결해야 한다.
   - 근거: `task_eMva63ao2fjDYEaX`, `task_jX5LC9uaq8hTO4kP`의 prompt/response.
2. **blocker fingerprint**
   - 지식: 선언된 선행조건 부재의 저카디널리티 fingerprint는
     `blocked-prerequisite: declared prerequisite unavailable`이다.
   - 근거: `src/server/gateway.ts`와 회귀 테스트.
3. **retry suppression**
   - 지식: prerequisite blocker는 provider/executor 교체로 해결되지 않으므로
     자동 failover를 금지하고 상류 입력 보완을 기다린다.
   - 근거: 동일 prompt 5회, executor 교체 4회.
4. **dual misclassification warning**
   - 지식: `error: BLOCKED`는 false failure, `status: ... missing prerequisite`는
     false completion이 될 수 있으므로 두 표면형을 같은 의미로 정규화해야 한다.
   - 근거: codex 실패 2행과 ollama 완료 2행.
5. **non-blocker guard**
   - 지식: 선행조건 계약이 없는 `error: BLOCKED`나
     `discussion_insufficient_valid_proposals`는 blocker 제외 규칙으로 숨기지 않는다.
   - 근거: `task_vaJ7ohqY_sFkEqHT`와 negative regression test.

## 안전·Gap·롤백

- 팀 삭제·비활성화·lifecycle/retirement 변경: 0건
- 운영 DB 과거 행 수정: 0건
- Blogger/LIVE/콘텐츠 파일 변경: 0건
- 현 score는 과거 행을 그대로 읽으므로 여전히 `61.3/62.5%/8`; 개선 수치는 미주장
- NCO `:6200` HTTP 배포 검증: 서비스가 연결 거부 상태라 미검증
- 실제 Obsidian vault 대상 경로 반영: 현재 sandbox 쓰기 범위 밖이라 미반영
- delivery gate `--inspect`: 실제 프로젝트와 현재 checkout은 일치했지만 등록된
  prunable worktree의 gitdir가 없어 `inspect-worktrees.sh`가 exit 128; cleanup 미수행

코드 롤백은 `classifyDeclaredPrerequisiteBlock()`과
`resolveTaskTerminalOutcome()`의 prerequisite 분기, 두 호출부의 `prompt` 옵션,
해당 회귀 테스트만 제거하면 된다. migration이나 데이터 롤백은 필요 없다.
