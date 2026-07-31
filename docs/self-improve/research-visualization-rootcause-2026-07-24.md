---
title: research-visualization 48h completion 근본원인
date: 2026-07-24
team: team_research-visualization
evidence: T1
tags:
  - self-improve
  - research-visualization
  - retired-media-provider
  - mem0
---

# 시각화·미디어팀 48h completion 근본원인

## 결론

- cycle-2 HR 지시가 기록된 `2026-07-24 06:10:00 UTC`를 기준
  시각으로 고정했다. 분석 창은 `[2026-07-22 06:10:00,
  2026-07-24 06:10:00]`이다.
- `team_lifecycle_events.tle_46iemVjvvq-0l5i2`가
  `score=89.3`, `metadata={sample:"48h", n:14, completion:92.9}`를,
  `tle_EEB93Plw9XB8PzOr`가 cycle-2 HR 지시를 직접 기록한다. 따라서
  completion은 유효 완료 13건/terminal 14건이다.
- 유일한 유효 비완료 `task_lGPe3SaFRRJF2oF-`는 네 후보인
  never-ran, silent-empty, infra-orphan, work-report 중복팬아웃 중
  어느 것도 아니다. `retired-media-provider`가 heartbeat 1회를 남기고 4초 동안
  실제 실행됐으나, provider ID인 `retired-media-provider`를 CLI job-set 이름으로
  전달해 `exit=4 / Unknown model "retired-media-provider"`로 실패했다.
- 이 행은 `workReportId`가 없고 기존 `INFRA_EXCLUSION`,
  `LEASE_NEVER_RAN_EXCLUSION`,
  `WORK_REPORT_DUP_DELIVERED_EXCLUSION`,
  `WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION`에 모두 걸리지 않는다.
  또한 `spawned_by_cli=claude-2-measure`인 합성 ping이므로 팀의 실제
  시각화 산출물 실패로 해석하면 안 된다. 현재 scorer가 이 행을 센 것은
  팀 품질 관점의 오탐이다.
- 공유 기본 설정 `config/ai-providers.json`의 retired-media-provider 모델을
  `retired-media-provider`에서 `flux_2`로 바꿨다. 이 머신의 비추적 로컬 오버레이에는
  같은 보정과 실제 접수 성공 기록이 있었지만, 공유 SSOT가 뒤처져 로컬
  오버레이가 없는 실행 환경에서 동일 오류가 재발할 수 있었다.
- scorer의 과거 행을 삭제하거나 상태를 바꾸지 않았고 팀 lifecycle에도
  손대지 않았다. 따라서 이 노트는 현 점수 회복을 주장하지 않는다.

## T1 표본

아래 14행은 scorer의 현재 제외 규칙을 고정 창에 적용한 결과다.
`tasks`에는 별도 `started_at` 열이 없으므로 실행 시작은 lease를 받은
`acked_at`으로 표시했다. 시각은 모두 UTC다.

| task_id | agent | status | started (`acked_at`) | heartbeat | completed | resp_len | 근본원인 가설 | 증거등급 |
|---|---|---|---|---|---|---:|---|---|
| `task_zT4pGw1Ch943xyuu` | agy | completed | 07-22 06:41:44 | 07-22 06:43:11 | 07-22 06:43:14 | 600 | 정상 완료 | T1 tasks/actions |
| `task_lGPe3SaFRRJF2oF-` | retired-media-provider | failed | 07-22 09:23:13 | 07-22 09:23:16 | 07-22 09:23:17 | 62 | 잘못된 CLI job-set `retired-media-provider`, exit 4 | T1 tasks/actions |
| `task_NMLG4RoqefROWr0X` | agy | completed | 07-22 10:19:56 | 07-22 10:20:47 | 07-22 10:20:51 | 551 | 정상 완료 | T1 tasks/actions |
| `task_c-7QkwEnDzgf41jx` | agy | completed | 07-22 15:25:47 | 07-22 15:26:16 | 07-22 15:26:17 | 1,057 | 정상 완료 | T1 tasks/actions |
| `task_-cdB2NKC_kcNtlXt` | agy | completed | 07-23 00:03:43 | 07-23 00:04:16 | 07-23 00:04:18 | 726 | 업무보고 완료 형제 | T1 tasks/work_reports |
| `task_4Hf8_RQQ_abQaLCG` | agy | completed | 07-23 00:03:17 | 07-23 00:03:44 | 07-23 00:03:47 | 595 | 업무보고 완료; FORMAT_MISMATCH 표시는 completion과 별도 | T1 tasks/work_reports |
| `task_ca5bpafI9l421zwx` | agy | completed | 07-23 00:03:32 | 07-23 00:04:00 | 07-23 00:04:03 | 861 | 업무보고 완료 형제 | T1 tasks/work_reports |
| `task_9-j9zC_GAx3KRPSu` | agy | completed | 07-23 05:03:14 | 07-23 05:03:51 | 07-23 05:03:56 | 701 | 업무보고 완료 | T1 tasks/work_reports |
| `task_50mWOcr_sFGz8PQu` | agy | completed | 07-23 05:03:56 | 07-23 05:04:32 | 07-23 05:04:39 | 803 | 업무보고 완료; FORMAT_MISMATCH 표시는 completion과 별도 | T1 tasks/work_reports |
| `task_tPO0haMGHXIRyAFo` | agy | completed | 07-23 15:34:48 | 07-23 15:35:18 | 07-23 15:35:22 | 984 | 정상 완료 | T1 tasks/actions |
| `task_uSPK23LPDzXEmzCV` | agy | completed | 07-24 00:07:22 | 07-24 00:07:56 | 07-24 00:08:01 | 737 | 업무보고 완료 | T1 tasks/work_reports |
| `task_MpNxQHmBYeofWugW` | agy | completed | 07-24 00:08:42 | 07-24 00:09:15 | 07-24 00:09:23 | 757 | 업무보고 완료 형제 | T1 tasks/work_reports |
| `task_c8A3Udy6WitDO5Ce` | agy | completed | 07-24 00:08:01 | 07-24 00:08:35 | 07-24 00:08:42 | 641 | 업무보고 완료 형제 | T1 tasks/work_reports |
| `task_rSi5HOS_mWgZ65WF` | agy | completed | 07-24 05:04:07 | 07-24 05:04:41 | 07-24 05:04:44 | 612 | 업무보고 완료 | T1 tasks/work_reports |

`task_lGPe3SaFRRJF2oF-`의 직접 행:

```text
assigned_to=retired-media-provider
status=failed
spawned_by_cli=claude-2-measure
created_at=2026-07-22 09:23:13
completed_at=2026-07-22 09:23:17
acked_at=2026-07-22 09:23:13
last_heartbeat_at=2026-07-22 09:23:16
heartbeat_seq=1
resp_len=62
workReportId=NULL
error=retired-media-provider: CLI failed exit=4 — Error: Unknown model "retired-media-provider". Run: retired-media-provider model list
```

`agent_actions`에도 `task:created` 뒤 3,314ms 만에 같은 오류로
`task:failed`가 기록되어 있어, 큐를 잡지 못한 never-ran으로 볼 수 없다.

## 에이전트별 성공·실패 패턴

| agent | 유효 completed | 유효 failed | 평균 latency | 추가 관찰 |
|---|---:|---:|---:|---|
| agy | 13 | 0 | 103.2초 | completed 13건 중 2건에 FORMAT_MISMATCH metadata가 있으나 task status는 completed |
| retired-media-provider | 0 | 1 | 4.0초 | 실제 생성 실패가 아니라 잘못된 CLI job-set으로 실행 전 검증 단계에서 종료 |

고정 창의 raw terminal은 16행, raw completed는 13행이다. raw 실패
3행 중 아래 2행은 기존 scorer가 이미 제외한다.

| task_id | agent | raw status | 제외 근거 | 판정 |
|---|---|---|---|---|
| `task_-jmyQ2o2yNmAtFx-` | hermes | failed, resp_len=0 | `orphaned: server restart`, `commander-perfgoal` | INFRA/CONTROL_PLANE 제외 |
| `task_I2eS1mVCONHHpuQG` | agy | failed, resp_len=0 | `orphaned: server restart`, `commander-perfgoal` | INFRA/CONTROL_PLANE 제외 |

따라서 raw 13/16이 아니라, 이 두 행을 제외한 13/14가 lifecycle에
기록된 92.9%와 일치한다.

## 후보 원인과 scorer 규칙 교차검증

| 후보 | raw 관찰 | 유효 표본 | 판정 |
|---|---:|---:|---|
| never-ran `lease_expired` | 0 | 0 | 원인 아님 |
| silent-empty `resp_len=0` | 2 | 0 | 두 행 모두 infra-orphan/control-plane으로 이미 제외 |
| infra-orphan | 2 | 0 | `INFRA_EXCLUSION`이 이미 제외 |
| 실패 work-report 중복팬아웃 | 0 | 0 | 원인 아님 |
| retired-media-provider invalid job-set | 1 | 1 | 유일한 completion 저하 행 |

업무보고 원장은 4행 모두 `submitted`이며 body 합계는 2,645자다.
같은 `workReportId`의 task fanout은 각각 3, 2, 3, 1행이지만 9행 전부
completed다. `WORK_REPORT_DUP_DELIVERED_EXCLUSION`은 완료 형제가 있는
비완료 행만 제외하므로 이 표본에서 제외한 행은 0이다. 이 팬아웃은 실패
원인이 아니며 오히려 완료 task 행 수를 늘렸다.

## bounded·reversible 수정

```diff
- "model": "retired-media-provider"
+ "model": "flux_2"
```

- bounded: `config/ai-providers.json`의 retired-media-provider 공유 기본값과 그 값의
  회귀 테스트만 변경한다.
- 근거: 현재 로컬 오버레이도 `flux_2`이며, 이후 실제 NCO retired-media-provider
  task `task_9BaFCTPuIY367BiF`가 `completed`와 UUID 응답
  `190b83a6-fdcd-4022-94f4-ea931c02926b`를 기록했다. 오버레이 적용이
  성공의 원인이었다는 부분은 현재 파일과 시간 순서에 근거한 추론이다.
- 회귀 방지: `src/utils/config.test.ts`가 공유 설정의 모델이
  `flux_2`이고 provider ID와 다름을 검사한다.
- rollback: 위 모델값·note·테스트 1건과 `updated` 날짜만 되돌리면 된다.
- 의도적 비변경: 과거 task 상태, team scorer 분모, team lifecycle,
  팀 활성 상태는 변경하지 않았다.

## Mem0·지식 베이스

- Mem0: `mem0-1784874145395-h5ef5j`
  - `agent_id=retired-media-provider`
  - `user_id=team_research-visualization`
  - `metadata.evidenceTier=T1`
  - cycle-2 기준 시각 `2026-07-24T06:10:00Z`와 현재 source task로
    기존 research-visualization 항목을 갱신
  - DB의 `embedding_len=NULL`; BM25/FTS 색인으로 저장
  - `retired-media-provider flux_2 Unknown model` 재검색에서 같은 ID 반환
- knowledge base:
  `kb-research-visualization-retired-media-provider-model-20260724`
  (`category=bug_pattern`,
  `source_task_id=task_D8mVJyLC5WCZGKcQ`)
- cycle-2 Mem0 갱신 rollback: content의 기준 시각을 `05:50 UTC`로,
  metadata의 `observedAt`을 `2026-07-24T05:50:00Z`로,
  `sourceTaskId`를 `task_D8mVJyLC5WCZGKcQ`로 되돌린다. cycle-1에서
  생성된 knowledge-base 행은 이번 갱신에서 변경하지 않았다.

## 검증 영수증

- [DB] `db/nco.db`의 `tasks`, `agent_actions`, `work_reports`,
  `team_lifecycle_events` 고정 창 직접 조회; `PRAGMA quick_check` → `ok`.
- [설정] `jq` 및 빌드 산출물의 `loadProviders()`로
  `{"id":"retired-media-provider","enabled":true,"model":"flux_2","command":"retired-media-provider"}`
  재확인.
- [Mem0] 기존 ID를 cycle-2 기준으로 갱신한 뒤 DB 행과
  `retired-media-provider* flux_2* Unknown* model*` FTS 재검색으로 같은 ID 확인.
- [관련 테스트]
  `npx vitest run src/utils/config.test.ts src/core/team-scorer.test.ts`
  → 2 files, 11 tests passed.
- [빌드/타입체크] `npm run build` → exit 0 (`tsc`).
- [등급] T1: DB 행, 파일 본문, 명령 출력 직접 확인.
- [Gap]
  - 새 유료 이미지 생성과 공유 설정 reload 후 외부 retired-media-provider artifact
    URL까지 기다리는 live end-to-end는 수행하지 않았다.
  - 로컬 NCO API `localhost:6200`가 연결 거부 상태라 독립 에이전트
    교차리뷰와 자동 activity 보고는 수행하지 못했다.
  - 과거 실패 행과 lifecycle을 의도적으로 보존했으므로 점수 회복은
    주장하지 않는다.
