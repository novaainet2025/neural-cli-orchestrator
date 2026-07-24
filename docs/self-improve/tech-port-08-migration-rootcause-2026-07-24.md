---
title: "08 Migration Implementation 48h/4 근본원인 — cycle 1"
date: 2026-07-24
team_id: team_tech-port-08-migration-implementation
team_slug: tech-port-08-migration-implementation
improvement_cycle: 1
snapshot_utc: "2026-07-24 03:10:00"
score: 71.4
completion: 75
sample: 48h/4
evidence_tier: T1
mem0_id: mem0-1784864143027-z2icbt
knowledge_base_id: kb_aFFYr7tYT__np3nv
tags:
  - nco/self-improve
  - tech-port-08
  - migration-implementation
  - failure-pattern
  - mem0
  - knowledge-base
---

# 08 Migration Implementation 48h/4 근본원인 — cycle 1

## T1 증거표

기준 시각은 HR 지시와 같은 `2026-07-24 03:10:00 UTC`다. DB 원본
`team_lifecycle_events.id=tle_UZ8DVy1mto92MR3z`는 `score=71.4`,
`metadata_json={"sample":"48h","n":4,"completion":75,...}`를 기록한다.

현재 세션에는 전용 `nco_list_tasks`/`nco_get_task` 커넥터가 노출되지 않았고,
동일 API 경로인 `localhost:6200`도 조회 시 연결 거부였다. 두 명령이 읽는
원천 저장소 `db/nco.db`를 read-only로 직접 조회했다. 따라서 아래 DB 행은
T1이지만 전용 명령을 실행했다고 주장하지 않는다.

| task_id | agent | 상태 | 관찰된 error·exit | actions 원본 | 등급 |
|---|---|---|---|---|---|
| `task_uSAQQBKFXRoiST1B` | `codex` | completed | `error=NULL`; verifier/exit 기록 없음 | `task:created`, `task:completed` | T1 |
| `task_egz0wRmrHlnDn75F` | `codex` | failed | `error="unknown: failure pattern in output"`; NCO verifier `npm run build` exit `0`; 응답은 `error:`로 시작하며 전체 `npm test` 실패를 보고 | `task:created`, `task:completed` | T1 |
| `task_yx5xqkaoCbupD_Ex` | `codex` | completed | `error=NULL`; verifier/exit 기록 없음 | `task:created`, `task:completed` | T1 |
| `task_XtFCIG_7GJR9uohX` | `codex` | completed | `error=NULL`; NCO verifier `npm run build` exit `0` | `task:created`, `task:completed` | T1 |

T1은 위 DB 필드와 저장된 응답·verifier 본문이 실제로 존재한다는 뜻이다.
`task_egz0wRmrHlnDn75F` 응답 안의 nova-use 테스트 로그는
`agent_actions`에 별도 command/exit action이 없어 독립 재실행 증거로는
**[미검증]**이다. 저장된 verifier 출력은
`neural-cli-orchestrator@1.0.0 build > tsc`이므로 대상 프로젝트 nova-use의
전체 테스트 실패를 반증하지 않는다.

### 현재 `FORMAT_MISMATCH` 재시도와의 경계

현재 요청 머리말의 `[Quality-gate reject: quality_rejected:
FORMAT_MISMATCH]`는 대상 팀 표본의 task error가 아니다. 이 재시도 task
`task_ZZg5UdtnMmIzauL5`는 `team_id=team_self-learning`,
`created_at=2026-07-24 03:12:33 UTC`로, 위 lifecycle 스냅샷
`2026-07-24 03:10:00 UTC` 이후 생성됐다. 대상 4개 행의
`metadata_json.qualityRejected`와 `qualityHeuristics`는 모두 NULL이다.
따라서 현재 진단 산출물의 형식 반려를 대상 팀의 75% 완료율 원인으로
소급하지 않는다.

## 판정

`n=4`의 직접 근본원인은 표본 오염이 아니라
`task_egz0wRmrHlnDn75F` 한 건의 실제 terminal 실패다.

- 포함 표본은 `completed=3`, `failed=1`, `timed_out=0`,
  `lease_expired=0`이며 네 건 모두 최종 실행자가 `codex`다.
- 유일한 실패의 DB error는 일반화된
  `unknown: failure pattern in output`이다. 응답은 P1 구현과 관련 테스트
  통과를 주장하면서도 전체 `npm test` 10건 실패를 보고하고 `error:`로
  종료한다.
- 네 건 모두 `qualityRejected`와 `qualityHeuristics`가 없다. 따라서
  `FORMAT_MISMATCH`는 이 48h/4의 실패 원인이 아니다.
- 네 건의 `handoff_packets`는 0행이다. 그러나 이 작업들에 handoff가
  필수였다는 근거도 없으므로 handoff 부재를 실패 원인으로 판정하지 않는다.
- 성공 3건 중 2건은 `PORT_DECISION: APPROVE` 부재에 따른 안전한 무변경
  보고이고, 1건은 `PORT_DECISION: REJECT`를 반영한 업무보고다. 즉 이
  작은 표본에서 실제 이식 구현 신호는 실패한 P1 한 건뿐이다.

### 스코어러 오염 교차검증

같은 48시간 창의 원시 terminal은 10건이지만 아래 6건은 스코어러의 인프라
제외 규칙으로 `n=4`에서 빠졌다.

| 제외 유형 | 건수 | task_id |
|---|---:|---|
| `orphaned: server restart (poison — requeued 2x)` | 2 | `task_eWCrX2LZmkYVThnY`, `task_BTfMb7Eie4Bzn6iQ` |
| `Circuit breaker open for agent claude-code (generic)` | 4 | `task_DMOXqJDtmZBfglGQ`, `task_g-yC3R9YFINNz_vs`, `task_4Kf7ol-jgcUcknTl`, `task_rbVOodQsUk1iZAmi` |

따라서 gateway 연결거부, orphan, circuit-open, lease-never-ran은 최종
48h/4 표본의 하락 기여요인이 아니다. 마이그레이션 실행 자체가 실패했다는
DB error도 없다. 확인 가능한 실패 계약은 “전체 테스트를 통과하지 못한
구현 응답이 terminal failed로 기록됨”까지다.

## 에이전트별 성공·실패 패턴

| agent | 완료 | 실패 | 원시 완료율 | 확인된 패턴 |
|---|---:|---:|---:|---|
| `codex` | 3 | 1 | 75.0% | 승인 부재/거부 시 무변경 보고 3건은 완료. 실제 P1 구현 1건은 관련 테스트 통과를 보고했지만 전체 suite 실패를 함께 보고해 failed. |

포함 표본에 다른 에이전트가 없으므로 에이전트 간 우열 비교는
**[미검증]**이다. 제외된 claude-code circuit 실패를 claude-code 산출물
품질로 해석하지 않는다.

## 스코어 하락 기여요인 순위

`src/core/team-scorer.ts`의 산식은
`score = round1(0.9 * completion + 0.1 * volume)`이다. 스냅샷 시각으로
재계산한 fleet 최대 표본은 `max_n=36`, 이 팀의 `n=4` volume은
`38.685281`이며 `0.9*75 + 0.1*38.685281 = 71.4`다.

스냅샷 이후 2026-07-24 03:41:40 UTC의 live 재계산은 score `71.1`,
completion `75`, `n=4`, sample `48h`, fleet `max_n=46`이었다. 팀 표본은
변하지 않았고 상대 작업량 분모만 변했으므로, 이 `0.3` 차이를 팀의 추가 실패나
개선으로 해석하지 않는다.

1. **유일한 포함 실패 1건** — 완료율을 3/4인 75%로 만들며, 동일한
   `n=4`에서 4/4였을 때와 비교하면 completion 가중분이 22.5점 낮다.
   근거: `task_egz0wRmrHlnDn75F`.
2. **작은 표본량** — `n=4`는 당시 fleet `max_n=36` 대비 volume 가중분
   약 3.9/10점만 만든다. 이는 실패 원인과 구분되는 산식상 기여요인이다.

3위로 확정할 추가 하락 요인은 없다. `evidence_json`은 네 건 모두 NULL이고
verifier 결과도 두 건뿐이어서 감사 가능성은 낮지만, 현재 team score 산식에는
직접 반영되지 않는다.

## 경계가 명확한 가역적 조치

이번 자가학습 하위작업은 다음 세 변경만 수행한다.

1. 이 문서에 lifecycle/task/action 원본, 오염 제외 내역, 미검증 경계를
   기록한다.
2. 확정된 실패 패턴 한 줄을 Mem0에 저장한다.
3. 같은 확정 패턴 한 줄을 knowledge base에 저장한다.

팀·조직·task·lifecycle 상태와 score 원본은 변경하지 않았다. 팀 삭제·비활성화
또는 은퇴 판단도 수행하지 않았다.

롤백은 이 파일을 제거하고, Mem0 ID
`mem0-1784864143027-z2icbt` 한 건만 `mem0Delete(id, "self-learning")`로
삭제하고 knowledge base ID `kb_aFFYr7tYT__np3nv` 한 건만 제거하면 된다.
에이전트 전체 기억을 지우는 `mem0Clear`는 사용하지 않는다.

후속 구현 후보는 이번 범위에서 **미적용·미검증**이다.

- 구현 task verifier가 실제 `metadata.projectDir`의 build/test 산출물을
  증거로 남기는지 검증하고, target-project command exit를 `agent_actions`
  또는 `evidence_json`에 구조화한다.
- `unknown: failure pattern in output` 대신 관련 테스트/전체 suite/인프라
  실패를 구분하는 안정적인 failure code를 저장한다.

## Mem0 장기기억

- agent: `self-learning`
- user: `team_tech-port-08-migration-implementation`
- key: `tech-port-08 실패패턴`
- id: `mem0-1784864143027-z2icbt`
- mode: `bm25` (`NCO_MEM0_NO_EMBED=1`, embedded=false)
- summary: `tech-port-08 실패패턴: 2026-07-24 03:10 UTC의 scorer 48h/4는 codex completed 3·failed 1이며, 유일한 포함 실패 task_egz0wRmrHlnDn75F는 error=unknown: failure pattern in output이고 응답이 전체 npm test 실패를 보고했다. raw terminal의 orphan 2건·circuit-open 4건은 scorer에서 제외돼 이 n=4 정체의 원인이 아니다.`

## Knowledge base

- id: `kb_aFFYr7tYT__np3nv`
- category: `bug_pattern`
- source task: `task_7PZB3coobR8rtREA`
- summary: `48h/4 표본은 codex 완료 3·실패 1이며, 유일한 실패는 task_egz0wRmrHlnDn75F다. orphan 2건과 circuit-open 4건은 이미 점수에서 제외됐고 FORMAT_MISMATCH 기록도 없다.`

## Obsidian 개선 노트

이 문서가 canonical 개선 노트다:
[[tech-port-08-migration-rootcause-2026-07-24|08 Migration Implementation cycle 1 개선 노트]].

공용 Obsidian vault에서 별도 동기화본은 발견하지 못했으므로 **[미검증]**이며,
존재하지 않는 외부 노트 링크를 만들지 않는다.

## 재현 쿼리

```sql
SELECT id, assigned_to, status, created_at, completed_at, error,
       verifier_result_json, evidence_json, metadata_json
FROM tasks
WHERE team_id='team_tech-port-08-migration-implementation'
  AND created_at BETWEEN datetime('2026-07-24 03:10:00','-48 hours')
                     AND '2026-07-24 03:10:00'
ORDER BY created_at;
```

```sql
SELECT task_id, agent_id, action_type, target, detail_json, created_at
FROM agent_actions
WHERE task_id IN (
  'task_uSAQQBKFXRoiST1B',
  'task_egz0wRmrHlnDn75F',
  'task_yx5xqkaoCbupD_Ex',
  'task_XtFCIG_7GJR9uohX'
)
ORDER BY task_id, created_at;
```

## 검증 영수증

- [변경] `docs/self-improve/tech-port-08-migration-rootcause-2026-07-24.md`
  — 실제 48h/4 task/action/lifecycle 근거와 원인 순위.
- [변경] Mem0 `mem0-1784864143027-z2icbt` — 확정 패턴 1건.
- [변경] knowledge base `kb_aFFYr7tYT__np3nv` — 같은 확정 패턴 1건.
- [검증방법] DB read-only 재집계, 파일 재읽기, Mem0 row·BM25 재조회,
  team-scorer Vitest, `npx tsc --noEmit`, `npm run build`, `git diff --check`.
- [등급] T1 — SQLite 원본 행, 파일 본문, 실제 명령 출력.
- [Gap] 전용 `nco_list_tasks`/`nco_get_task`와 `localhost:6200`은 사용할 수
  없어 동일 원천 DB를 직접 조회했다. 다음 48시간 관찰 기간은 아직 지나지 않았다.
- [미검증항목] 응답에 인용된 nova-use 전체 테스트의 독립 재실행,
  후속 구현 후보, 개선 후 다음 48시간 score/completion.

### 검증 로그

```text
$ npx tsc --noEmit
(stdout/stderr 없음)
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ npx vitest run src/core/team-scorer.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)
exit code 0
```

```text
DB/file/Mem0 read-only assertion:
lifecycle={score:71.4,n:4,completion:75,sample:"48h"}
sample=[
  task_uSAQQBKFXRoiST1B,
  task_egz0wRmrHlnDn75F,
  task_yx5xqkaoCbupD_Ex,
  task_XtFCIG_7GJR9uohX
]
actions=8, handoffs=0
qualityMarkedInSample=0
qualityRetry={
  taskId:task_ZZg5UdtnMmIzauL5,
  teamId:team_self-learning,
  createdAt:"2026-07-24 03:12:33"
}
memoryId=mem0-1784864143027-z2icbt
memoryMatches=1, duplicateCount=1
knowledgeId=kb_aFFYr7tYT__np3nv, knowledgeMatches=1
ASSERTION_PASS
exit code 0
```

```text
mem0Search(agentId=self-learning,
           userId=team_tech-port-08-migration-implementation,
           query=실패패턴)
mode=bm25
ids=[mem0-1784864143027-z2icbt]
count=1
```

```text
knowledgeBase.query(query=task_egz0wRmrHlnDn75F,
                    projectPath=/Users/nova-ai/project/nco)
ids=[kb_aFFYr7tYT__np3nv]
count=1
```

```text
concurrent duplicate rollback:
deleted mem0-team-tech-port-08-cycle1-validation-scope-20260724 (created by this session)
deleted kb-team-tech-port-08-cycle1-validation-scope-20260724 (created by this session)
canonical Mem0/knowledge rows retained
```

```text
$ git diff --check
exit code 0
```
