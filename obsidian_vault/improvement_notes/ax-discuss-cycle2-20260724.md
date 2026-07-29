---
title: "Discussion Lead (ax-discuss) 개선 사이클 2 — 48h/14 실패 패턴"
date: 2026-07-24
team_id: team_ax-discuss
team_slug: ax-discuss
improvement_cycle: 2
snapshot_utc: "2026-07-24 03:50:00"
score: 71.1
completion: 71.4
sample: 48h/14
source_task_id: task_kaTfKnym8JuowOrF
lifecycle_event_id: tle_VHTG7oSWcXKT55Sf
evidence_tier: T1
mem0_id: mem0-1784866816265-mnyr9m
knowledge_base_id: kb_ax_discuss_cycle2_20260724
tags:
  - nco/self-learning
  - ax-discuss
  - work-report
  - FORMAT_MISMATCH
  - retry-lineage
  - mem0
---

# Discussion Lead (ax-discuss) 개선 사이클 2 — 48h/14 실패 패턴

## 판정

HR 스냅샷의 `score=71.1`, `completion=71.4%`, `48h/14`는
`completed=10`, `failed/timed_out=4`로 재현된다. 점수를 직접 낮춘 네 건은
Discussion Lead의 토론·합의 산출물이 아니라 **한 개의 2026-07-24 오전
업무보고가 같은 `workReportId=wr_eZfmihgCSrbtQnSX`로 `opencode`에 반복
발행된 실행**이다.

- 세 건은 `task:completed` action이 공백 2~3바이트만 반환해
  `silent-failure: empty output`으로 끝났다.
- 한 건은 약 15분 뒤 `timeout(idle)`로 끝났다.
- 네 건 모두 품질 verifier가 없고 `qualityRejected`도 없다. 따라서
  `FORMAT_MISMATCH`나 text-only 산출물의 diff 부재가 이 네 실패의 직접
  원인이라는 근거는 없다.

별도의 품질 문제도 있다. raw `completed` 열 건 중 여섯 건에는
`qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`가 남아 있다.
이 여섯 건은 scorer가 여전히 completed로 세었으므로 completion 71.4%의
직접 감점 원인은 아니지만, **상태 완료와 출력 계약 충족이 일치하지 않는
숨은 품질 부채**다.

따라서 근본원인은 하나의 “diff-ratio 오탐”이 아니라 다음 두 계층이다.

1. completion 손실: 동일 업무보고의 반복 실행이 한 agent의 빈 출력·idle
   timeout을 네 개의 팀 실패로 증폭했다.
2. 품질 피드백 왜곡: completed parent의 `FORMAT_MISMATCH` retry와 timeout
   retry가 과거에는 `team_id=NULL`로 생성돼, 교정 성공이 팀 계보와 48시간
   점수에 환류되지 않았다.

## T1 원천과 스냅샷 경계

- HR 원장: `team_lifecycle_events.id=tle_VHTG7oSWcXKT55Sf`,
  `created_at=2026-07-24 03:50:00 UTC`(12:50 KST),
  `metadata_json={"sample":"48h","n":14,"completion":71.4,...}`.
- task 원장: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
  `agent_actions`, `work_reports`.
- 대상 창: HR 이벤트 시각을 상한으로 한 최근 48시간 terminal task.
- `localhost:6200`은 조사 시 연결 거부였다. API 성공을 주장하지 않고,
  API의 지속 원장인 SQLite 행을 읽기 전용 조회했다.
- `data/nco.db`에는 `tasks` 테이블이 없다. 이 분석의 task 원천으로 쓰지
  않았다.

스냅샷 시점의 scorer는 raw terminal 16건 중 다음 두 건을 분모에서 제외해
14건을 만들었다.

| 제외 task | 상태 | 제외 근거 | 주의점 |
|---|---|---|---|
| `task_tcQN27KxLB_Otif1` | failed | NCO `localhost:6200` 연결 거부 | 팀 품질이 아닌 gateway 가용성 사건 |
| `task_goC0-dH8ZhbDsAs8` | lease_expired | ack 후 heartbeat 0 | 만료 뒤 `agent_actions`에 240바이트 보고가 도착했으므로 단순 “never-ran” 단정은 금지 |

당시 `commander-perfgoal` completed task
`task_ce9XnQACRVYEVJRI`는 14건에 포함됐다. 이후 커밋 `1dfa39e`가
control-plane task를 전 팀에서 제외했으므로, 현재 scorer를 과거 HR
스냅샷에 그대로 적용한 값은 동일 비교가 아니다. 이 문서는 lifecycle
이벤트가 소유한 `71.1/71.4%/14`를 기준으로 한다.

## 48시간 표본 14건

| task_id | agent | DB 상태 | 품질 플래그 | 관측 분류 |
|---|---|---|---|---|
| `task_3v40MbxX9Jcz2rXy` | opencode | failed | 없음 | 공백 2바이트, `silent-failure` |
| `task_FCS4xJvFV6Fgt-1l` | opencode | failed | 없음 | 공백 3바이트, `silent-failure` |
| `task_vvo99V0aEDoJkure` | opencode | failed | 없음 | 공백 2바이트, `silent-failure` |
| `task_qLyVkz5jiVmoaF8W` | opencode | timed_out | 없음 | `timeout(idle)`; team 미귀속 retry 2건은 completed |
| `task_0xiZg4I-uRBqI2So` | opencode | completed | 없음 | team-runner 일일 분석보고 |
| `task_ce9XnQACRVYEVJRI` | retired-provider | completed | `FORMAT_MISMATCH` | control-plane 목표·성과 입력 응답 |
| `task_gZPQLtKQmPFSL2nu` | opencode | completed | `FORMAT_MISMATCH` | 오후 업무보고; retry 2건은 team 미귀속 |
| `task_4101CDKT9fi_SHbR` | opencode | completed | 없음 | 같은 오후 업무보고의 protocol 응답 |
| `task_oU_2WmYSVRxtclr-` | claude-code | completed | `FORMAT_MISMATCH` | 오전 업무보고; retry 3건은 team 미귀속 |
| `task_mUEy-HA_aFJuIZNx` | claude-code | completed | `FORMAT_MISMATCH` | 오전 업무보고; retry 3건은 team 미귀속 |
| `task_iLFhsAx1YYD9kH_8` | claude-code | completed | 없음 | text-only 상시 임무 응답 |
| `task_O486KIhkclffZKW5` | claude-code | completed | `FORMAT_MISMATCH` | 실제 본문이 “이 목표에서 제외”라 요구사항 자체가 불명확 |
| `task_jA4pKL16-OGT7tMV` | agy | completed | `FORMAT_MISMATCH` | 역할 한 문장 질문에 `unknown`을 반환; 상태 완료가 내용 성공을 보장하지 않음 |
| `task_NNUUMOVbLRTc2_Lh` | cursor-agent | completed | 없음 | 오후 업무보고 |

열네 건 모두 `evidence_json IS NULL`이다. 따라서 이 표의 “completed”는
DB terminal 상태를 뜻하며, 보고 내용·HTTP 입력·회의 결과의 실질 성공까지
검증됐다는 뜻이 아니다.

## 에이전트별 성공·실패 패턴

| agent | 표본 | raw completed | 상태 실패 | completed 중 `FORMAT_MISMATCH` | raw 완료율 |
|---|---:|---:|---:|---:|---:|
| opencode | 7 | 3 | 4 | 1 | 42.9% |
| claude-code | 4 | 4 | 0 | 3 | 100.0% |
| retired-provider | 1 | 1 | 0 | 1 | 100.0% |
| agy | 1 | 1 | 0 | 1 | 100.0% |
| cursor-agent | 1 | 1 | 0 | 0 | 100.0% |
| **합계** | **14** | **10** | **4** | **6** | **71.4%** |

`opencode`의 42.9%를 provider 일반 성능으로 확대 해석하면 안 된다. 네 실패가
모두 같은 prompt·같은 `workReportId`에 집중돼 독립 표본이 아니기 때문이다.
반대로 나머지 agent의 100%도 표본이 1~4건이고 여섯 quality reject가 섞여
있어 실질 품질 100%를 뜻하지 않는다.

## 반복 발행·retry 계보

`wr_eZfmihgCSrbtQnSX`에는 00:01:56~00:05:44 UTC 사이 parent task가 다섯
건 생성됐다. 네 건은 이번 scorer 표본의 실패가 됐고, 한 건은 lease 만료
제외 대상이다. `work_reports` 행은 `source_task_id=task_goC0-dH8ZhbDsAs8`
이지만 최종 상태는 `missed`, `submitted_at=NULL`이다. 즉 늦게 생성된 파일과
보고서 제출 상태도 서로 동기화되지 않았다.

또한 여섯 `FORMAT_MISMATCH` completed parent가 만든 retry child는 총 15건이며
전부 `team_id=NULL`이다. 그중 14건은 completed, 1건은 failed다. timeout
parent `task_qLyVkz5jiVmoaF8W`의 retry child 두 건도 모두 completed지만
`team_id=NULL`이다. 이 과거 행들은 교정 성공을 팀 점수로 되돌리지 못한다.

## 이미 적용된 bounded 수정과 이번 판정

이번 자가학습 하위작업 전에 다음 전방 수정이 이미 존재한다.

| commit | 수정 | 이 표본과의 관계 |
|---|---|---|
| `e0a786f` | 활성 `workReportId` 중복을 route 조회와 partial unique index로 차단 | 동시 parent 중복의 재발 범위를 줄임; terminal 뒤 재발행은 의도적으로 허용 |
| `b5bbf4d` | quality retry가 parent의 team/company metadata를 승계 | 새 retry의 팀 계보 유실 방지; 과거 NULL 행은 소급 변경하지 않음 |
| `014bdf6` | `[업무보고 작성]` prompt에 기본 build verifier를 붙이지 않음 | Markdown 보고의 `FORMAT_MISMATCH` 재시도 루프 축소 |
| `aff5990` | ack 후 heartbeat 0인 lease 만료를 scorer에서 제외 | `task_goC0-dH8ZhbDsAs8`가 cycle 2 분모에서 빠짐 |

cycle 1의 lifecycle 원장은 `completion=62.5%`, `n=16`을 기록했고, 위
인프라 제외 반영 뒤 cycle 2는 `71.4%`, `n=14`가 됐다. 이는 분모 정정이지
새로운 Discussion Lead 산출물 성공이 아니다.

현재 남은 10/14는 48시간 창에 남은 과거 네 실패의 영향이다. 이미 존재하는
전방 수정을 중복 패치하거나 과거 task 상태를 소급 변경하면 증거 계보를
훼손한다. 따라서 이번 하위작업의 코드 판정은 **`surface & hold`**다.

- 소스 추가 수정 없음.
- 팀 삭제·비활성화·lifecycle 변경 없음.
- 다음 `work-report-scheduler` 실제 실행에서 동일 `workReportId` active
  parent 수, retry `team_id`, 기본 verifier 부재를 관찰한다.
- terminal 실패 뒤 무제한에 가까운 순차 재발행 또는 late result와
  `work_reports.status` 불일치가 반복되면 그때 별도 bounded fix를 검토한다.

## Mem0 장기 기억·지식베이스

- Mem0 agent/user: `self-learning` / `team_ax-discuss`
- Mem0 ID: `mem0-1784866816265-mnyr9m`
- 검색 모드: BM25 (`NCO_MEM0_NO_EMBED=1`, embedded=false)
- KB ID: `kb_ax_discuss_cycle2_20260724`
- KB category/confidence: `bug_pattern` / `0.95`
- 한 줄 교훈: **ax-discuss의 71.4%는 text-only diff 부재가 아니라 같은
  workReportId의 공백 출력 3건과 idle timeout 1건이 만든 10/14이며,
  completed의 FORMAT_MISMATCH와 team 미귀속 retry는 별도 품질 계층으로
  분리해 tasks·metadata·parent 계보를 함께 확인한다.**

기존의 낮은 신뢰도 KB 항목은 삭제하지 않았다. 이번 curated 항목을 더 높은
confidence로 추가해 검색 우선순위를 개선했다. 롤백은 위 Mem0/KB 단일 ID와
이 문서만 대상으로 하며, 전역 기억 삭제는 사용하지 않는다.

## 재현 쿼리 요약

```sql
SELECT id, assigned_to, status, created_at, error, length(response),
       json_extract(metadata_json,'$.workReportId') AS work_report_id,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS quality_heuristics,
       evidence_json
FROM tasks
WHERE team_id='team_ax-discuss'
  AND created_at BETWEEN datetime('2026-07-24 03:50:00','-48 hours')
                     AND '2026-07-24 03:50:00'
ORDER BY created_at;
```

```sql
SELECT parent_task_id, COUNT(*) AS children,
       SUM(team_id IS NULL) AS team_id_null,
       SUM(status='completed') AS completed
FROM tasks
WHERE parent_task_id IN (
  'task_ce9XnQACRVYEVJRI', 'task_gZPQLtKQmPFSL2nu',
  'task_oU_2WmYSVRxtclr-', 'task_mUEy-HA_aFJuIZNx',
  'task_O486KIhkclffZKW5', 'task_jA4pKL16-OGT7tMV',
  'task_qLyVkz5jiVmoaF8W'
)
GROUP BY parent_task_id;
```

## 검증 영수증

- [변경] `obsidian_vault/improvement_notes/ax-discuss-cycle2-20260724.md`
  — 실제 lifecycle/task/action/report 행 기반 개선 노트.
- [변경] Mem0 `mem0-1784866816265-mnyr9m` — 확정 실패 패턴 한 건.
- [변경] KB `kb_ax_discuss_cycle2_20260724` — confidence 0.95의 curated
  `bug_pattern` 한 건.
- [검증방법] HR 스냅샷 재집계, parent/child 계보·Mem0·KB 재조회,
  타입체크·관련 Vitest·build, 문서 diff 검사.
- [등급] T1 — SQLite 원본 행, git commit/file 내용, 실제 명령 본문.
- [Gap] 운영 API는 연결 거부라 HTTP wrapper 대신 동일 원천 DB를 조회했다.
  48시간 창이 지나기 전에는 전방 수정 후의 새 운영 completion을 주장하지
  않는다.
- [미검증항목] 다음 실제 업무보고 tick의 active dedupe, late result의
  work-report 제출 반영, 팀 고유 회의·합의 산출물의 내용 품질.

### 검증 로그

```text
HR snapshot assertion
rawTerminal=16
scoredN=14
completed=10
failed=4
completion=71.4
formatMismatchCompleted=6
incidentFailures=4
qualityChildren=15
qualityChildrenTeamNull=15
qualityChildrenCompleted=14
timeoutChildren=2
timeoutChildrenTeamNull=2
lifecycleScore=71.1
lifecycleN=14
lifecycleCompletion=71.4
ASSERTION_PASS
exit code 0
```

```text
$ NCO_MEM0_NO_EMBED=1 mem0Search(
    agentId=self-learning,
    userId=team_ax-discuss,
    query="workReportId FORMAT_MISMATCH"
  )
mode=bm25
ids=["mem0-1784866816265-mnyr9m"]
count=1
```

```text
$ SELECT ... FROM knowledge_base
  WHERE id='kb_ax_discuss_cycle2_20260724';
category=bug_pattern
confidence=0.95
source_task_id=task_kaTfKnym8JuowOrF
```

```text
$ npx tsc --noEmit
(stdout/stderr 없음)
exit code 0
```

```text
$ npx vitest run src/core/team-scorer.test.ts \
    src/server/task-intake.test.ts tests/response-quality.test.ts
Test Files  3 passed (3)
Tests       29 passed (29)
Duration    6.08s
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ git diff --check -- \
    obsidian_vault/improvement_notes/ax-discuss-cycle2-20260724.md
(stdout/stderr 없음)
exit code 0
```
