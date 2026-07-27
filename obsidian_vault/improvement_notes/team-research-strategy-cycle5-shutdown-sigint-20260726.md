---
title: research-strategy cycle 5 — graceful shutdown SIGINT 오분류
team_id: team_research-strategy
team_slug: research-strategy
cycle: 5
date: 2026-07-26
evidence_tier: T1
tags:
  - self-learning
  - research-strategy
  - graceful-shutdown
  - SIGINT
  - task-scoring
---

# research-strategy cycle 5 — graceful shutdown SIGINT 오분류

## 결론

HR 원장 `tle_q2UC1tRHVf0GZnLE`과 직후 점검
`tle_34nXIHukACmT-NC9`는 `score=81.1`, `completion=85.7`,
`sample=48h/7`, `improvement_count=5`를 기록한다.
현재 `computeTeamScores()` 직접 실행도 같은 결과를 반환했다.

유일한 포함 실패 `task__zXpjggKrqmyv0Of`는 팀의 정상적인 실행 실패가
아니다. PM2 원문 로그에서 NCO가 `2026-07-26 13:49:39 +0900`에
`signal="SIGINT", msg="Shutting down..."`을 기록한 19ms 뒤, 같은 NCO
로그 스트림에 opencode의 SIGINT 종료가 기록됐다. DB `agent_actions`에도 동일 UTC 초
`2026-07-26 04:49:39`에 다음 세 provider의 동시 중단이 저장됐다.

| task | provider | DB 근거 |
|---|---|---|
| `task__zXpjggKrqmyv0Of` | opencode | `Command was killed with SIGINT`, `team_research-strategy`, response 0 |
| `task__Eb4pMoM_F2ljuIw` | claude-code | `Command was killed with SIGINT`, response 0 |
| `task__cnWK-TbBGgIwsQw` | cursor-agent | `exit=130`, `Aborting operation...`, response 0 |

따라서 cycle 4 노트의 “실작업 중 사용자 중단이므로 정당 팀 실패” 판정은
더 높은 증거인 PM2 종료 로그와 동시 provider action에 의해 기각된다.
근본원인은 **PM2/NCO graceful shutdown의 process-group SIGINT가 provider
실패로 먼저 종결되어 기존 `orphaned: graceful shutdown` 분류를 우회한 것**이다.

## 수정

- `src/index.ts`: 종료 핸들러 진입 즉시 `taskQueue.beginShutdown(signal)` 호출.
- `src/worker.ts`: standalone worker의 종료 핸들러도 같은 shutdown signal을
  큐에 먼저 기록해 별도 worker 배치에서 동일 오계상이 재발하지 않게 한다.
- `src/core/task-queue.ts`: 종료 중 발생한 실제
  `SIGINT`, `exit=130`, `Aborting operation` 실패만
  `status=cancelled`, `error=orphaned: graceful shutdown signal (<signal>)`로
  정규화한다.
- 정규화된 `cancelled` 결과는 즉시 반환해 종료 drain 중 tier escalation이
  새 provider 실행을 시작하지 못하게 한다.
- 성공 결과와 일반 provider 실패는 변경하지 않는다.
- `src/core/task-queue.shutdown.test.ts`: 관측된 세 오류 형태, 일반 실패,
  종료 외 중단, drain 중 성공 보존, 취소 후 escalation 금지를 회귀 테스트한다.
- `src/core/task-queue.recovery.test.ts`: 관측된 SIGINT 오류의 정규화 결과가
  startup recovery 경로에서도 DB `status=cancelled`, shutdown error,
  `completed_at=NULL`로 보존되는지 인메모리 DB 행으로 검증한다.
- 스코어러는 수정하지 않았다. DB 직접 조회에서 팀은 `is_active=1`이고,
  지시 이후 lifecycle event는 `hr_directive`, `improvement_started`,
  `score_checked`뿐이며 `retired`는 없다.

## 검증

관련 회귀 테스트:

```text
Test Files  7 passed (7)
Tests       34 passed (34)
```

`npx tsc --noEmit`, `npm run build`, `git diff --check`는 모두 exit 0이었다.

전체 `npx vitest run`은 현재 작업트리에서 103개 파일, 539개 테스트가
모두 통과했다. 이전 검증의 범위 밖 `tests/근거.test.ts:20` 고정 날짜
실패는 재현되지 않았으며, 이번 변경에서 그 테스트를 수정하지 않았다.
변경 경로를 포함한 관련 7개 파일 34개 테스트도 모두 통과했다.

`2026-07-26 19:07:12 +0900`에 소스 scorer를 현재 DB에 직접 실행한 값과
동일 scorer 공식으로 계산한 counterfactual:

```json
{
  "before": {
    "score": 81.1,
    "completion": 85.7,
    "n": 7,
    "maxN": 132,
    "sample": "48h"
  },
  "after": {
    "score": 93.7,
    "completion": 100,
    "n": 6,
    "maxN": 132,
    "sample": "48h"
  }
}
```

`after`는 대상 실패 한 건이 새 분류로 저장된다는 가정의 계산값이며 운영
지표가 아니다. 라이브 DB의 과거 task/lifecycle 행은 수정하지 않았다.
다음 실제 종료 사건에서 새 분류가 저장되는지는 운영 관찰이 필요하다.

## 자가학습 교훈

1. provider 오류 문자열만으로 `User interruption`을 팀 귀책으로 판정하지
   않는다. 같은 초의 NCO shutdown 로그와 다른 provider action을 먼저
   교차검증한다.
2. graceful shutdown 분류는 scorer의 사후 문자열 예외보다 실행 경계에서
   처리한다.
3. cycle 노트가 Mem0/knowledge base에 실제 저장·재검색되지 않았다면
   “반영됨”이라고 쓰지 않는다.
4. 더 높은 증거로 기존 판정을 뒤집으면 이전 진단을 삭제하지 말고
   `SUPERSEDED` 표시와 최신 근거 경로를 남겨 검색 시 충돌을 해소한다.

## 장기기억·지식 베이스

- Mem0: `mem0-1785059580185-2gxen5`
  - agent=`self-learning`, user=`team_research-strategy`
  - DB 내용·metadata와 `shutdown SIGINT` lexical 조회에서 같은 ID 확인
- knowledge base:
  `kb-team-research-strategy-cycle5-shutdown-sigint-20260726`
  - DB 현재값 category=`bug_pattern`, confidence=`0.96`, used_count=`1`
  - `graceful shutdown SIGINT` lexical 조회에서 같은 ID 확인

## 롤백

`src/index.ts`·`src/worker.ts`의 `taskQueue.beginShutdown()` 호출,
`shutdownSignal` 상태,
`normalizeGracefulShutdownInterruption()`, `cancelled` 즉시 반환 가드 및
전용 테스트만 제거하면 된다.
DB migration은 없다. 장기기억 롤백은 위 Mem0 ID와 knowledge-base ID 두
행만 대상으로 한다.

## Gap

- 변경 후 실제 PM2 restart를 실행하지 않았다. 서비스 재시작은 현재의 다른
  진행 작업을 중단할 수 있어 이 범위에서 수행하지 않는다.
- 실제 다음 48시간 score/completion은 아직 존재하지 않는다.
- 공용 Obsidian 원본 vault는 현재 작업공간 밖이므로 이 노트의 원본 vault
  동기화는 미검증이다.
