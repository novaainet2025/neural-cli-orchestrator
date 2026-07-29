---
title: "tech-port-04 Baseline Benchmark 실패 패턴 — 개선 cycle 2"
date: 2026-07-24
team_id: team_tech-port-04-baseline-benchmark
team_slug: tech-port-04-baseline-benchmark
improvement_cycle: 2
evidence_tier: T1
tags:
  - nco/self-improve
  - tech-port-04
  - baseline-benchmark
  - failure-pattern
  - mem0
---

# tech-port-04 Baseline Benchmark 실패 패턴 — 개선 cycle 2

## 결론

2026-07-24 02:10:00 UTC의 HR 지시가 참조한 48시간 표본은 실제로
`completed=8`, `failed=1`, `n=9`, 완료율 `88.9%`였다. 점수를 직접 낮춘 유일한
실패는 벤치마크 단계 실패가 아니라 `agy` 태스크가 서버 재시작 뒤 두 번 재큐잉되고
poison 한도를 소진한 인프라 실패였다.

다만 완료 8건 중 5건은 품질 게이트가 `FORMAT_MISMATCH`로 판정했다. 그 5건의
품질 재시도 자식은 모두 실패했으며, 자식의 `team_id`는 모두 `NULL`이었다. 또한
동일한 오전 업무보고가 같은 `workReportId`로 3번 실행되어 9건 표본의 33.3%를
차지했다. 따라서 확인된 패턴은 다음 세 가지다.

1. 인프라 재시작 실패 1건이 완료율을 100%에서 88.9%로 낮춤.
2. 응답 첫 줄 계약 부재와 실패한 품질 복구 경로가 5건의 품질 부채를 남김.
3. 동일 보고 3중 실행이 작은 표본을 편중시킴.

기존 파일
`team_tech-port-04-baseline-benchmark/team_tech-port-04-baseline-benchmark`의
“specific benchmark stage repeat failure” 주장은 근거 task ID나 원본 로그가
없고 실제 9건 표본과도 일치하지 않으므로 이 분석의 증거로 사용하지 않았다.

## 표본과 수집 경계

- 스냅샷 기준: `team_lifecycle_events.id=tle_tZ8jioKPZWhxWfCW`
  (`2026-07-24 02:10:00` UTC).
- lifecycle 원본: score `86.8`, completion `88.9`, sample `48h/9`,
  improvement cycle `2/3`.
- 조회 창: HR 지시 시각을 상한으로 한 직전 48시간.
- 대상 상태: `completed`, `failed`, `timed_out`, `lease_expired`.
- 원본: `db/nco.db`의 `tasks`, `team_lifecycle_events`, `teams` 행.
- 전용 `nco_list_tasks`/`nco_get_task` 커넥터는 현재 세션에 노출되지 않았고,
  `http://localhost:6200`도 조회 시점에 연결 거부였다. 두 MCP 명령이 읽는 동일한
  NCO SQLite 원본을 read-only로 직접 조회했다. 따라서 DB 행은 T1이지만
  전용 도구 호출 여부는 `[미검증]`이 아니라 **미수행**이다.

## 48시간/9샘플 원본

| task_id | agent | 상태 | 소요시간 | 재큐잉 | 품질 판정 | retry 자식 |
|---|---|---:|---:|---:|---|---|
| `task_Hg8EAhPiofUYUoMn` | retired-provider | completed | 16초 | 0 | 기록 없음 | 없음 |
| `task_hdBl_7u7ln4fzhn0` | retired-provider | completed | 63초 | 0 | 기록 없음 | 없음 |
| `task_e-_rSc9NAVSHcEc9` | agy | completed | 192초 | 0 | `FORMAT_MISMATCH` | `task_rnCkWxvukesMtCbP` failed |
| `task_GgQ8CwfGz1FFiE3i` | agy | failed | 392초 | 2 | 응답 없음 | 없음 |
| `task_Gsr7Rm5UgWq47f4u` | retired-provider | completed | 48초 | 0 | `FORMAT_MISMATCH` | `task_-1g-Qa9Nw3uerejV` failed |
| `task_G177mycE5mbj6mNz` | retired-provider | completed | 11초 | 0 | 기록 없음 | 없음 |
| `task_FWap1nZvqohI_e6X` | retired-provider | completed | 30초 | 0 | `FORMAT_MISMATCH` | `task_VchwQci_MQlNL6CW` failed |
| `task_cPzZJoBgO4roKi_y` | retired-provider | completed | 35초 | 0 | `FORMAT_MISMATCH` | `task_8fd4-Yx3d2pesT6P` failed |
| `task_gbpQ8h-IsxsxHy_E` | retired-provider | completed | 37초 | 0 | `FORMAT_MISMATCH` | `task_LRktC26-y4oyTOTy` failed |

소요시간은 `created_at`부터 `completed_at`까지의 DB timestamp 차이다.
`updated_at`이 더 늦은 경우가 있으므로 실행 소요시간으로 혼합하지 않았다.

## 에이전트별 결과

| agent | 완료 | 실패 | 표본 내 완료율 | 완료 태스크 평균 | 관찰 |
|---|---:|---:|---:|---:|---|
| retired-provider | 7 | 0 | 100.0% | 34.286초 | 완료 7건 중 4건이 `FORMAT_MISMATCH`; 상태 성공과 산출물 품질은 다름 |
| agy | 1 | 1 | 50.0% | 192초 | 완료 1건도 retired-provider에서 failover된 뒤 `FORMAT_MISMATCH`; 실패 1건은 인프라 poison |

agy는 `n=2`이므로 일반적인 에이전트 성능 결론을 내리기에는 표본이 작다.
타임아웃과 빈 산출물은 이 9건 표본에서 관찰되지 않았다.

## 실패·재시도 패턴 빈도

| 패턴 | 빈도 | 분모 | 근거 task_id | 판정 |
|---|---:|---:|---|---|
| terminal 인프라 poison 실패 | 1 | 9 | `task_GgQ8CwfGz1FFiE3i` | T1 |
| 완료 부모의 `FORMAT_MISMATCH` | 5 | 9 | `task_e-_rSc9NAVSHcEc9`, `task_Gsr7Rm5UgWq47f4u`, `task_FWap1nZvqohI_e6X`, `task_cPzZJoBgO4roKi_y`, `task_gbpQ8h-IsxsxHy_E` | T1 |
| `FORMAT_MISMATCH` retry 실패 | 5 | 5 retries | `task_rnCkWxvukesMtCbP`, `task_-1g-Qa9Nw3uerejV`, `task_VchwQci_MQlNL6CW`, `task_8fd4-Yx3d2pesT6P`, `task_LRktC26-y4oyTOTy` | T1 |
| 동일 work report 중복 실행 | 3 | 9 | `task_FWap1nZvqohI_e6X`, `task_cPzZJoBgO4roKi_y`, `task_gbpQ8h-IsxsxHy_E` | T1 |
| 특정 benchmark stage terminal 실패 | 0 | 9 | 증거없음 | T1 |
| timed_out / lease_expired | 0 | 9 | 증거없음 | T1 |

`FORMAT_MISMATCH`는 전체 표본의 55.6%, 완료 부모의 62.5%다. 세 중복 업무보고는
동일 `workReportId=wr_RF2ukyY524R4QCVY`, 동일 prompt를 가진다.

## 재시도 계보

| 부모 | 자식 | 자식 agent | 자식 소요시간 | 자식 실패 사유 |
|---|---|---|---:|---|
| `task_e-_rSc9NAVSHcEc9` | `task_rnCkWxvukesMtCbP` | codex | 4,229초 | `orphaned: server restart (poison — requeued 2x)` |
| `task_Gsr7Rm5UgWq47f4u` | `task_-1g-Qa9Nw3uerejV` | codex | 1,411초 | `orphaned: server restart (poison — requeued 2x)` |
| `task_FWap1nZvqohI_e6X` | `task_VchwQci_MQlNL6CW` | claude-code | 1,801초 | codex 1,800초 queue wait 뒤 `Circuit breaker open` |
| `task_cPzZJoBgO4roKi_y` | `task_8fd4-Yx3d2pesT6P` | claude-code | 1,802초 | codex 1,800초 queue wait 뒤 `Circuit breaker open` |
| `task_gbpQ8h-IsxsxHy_E` | `task_LRktC26-y4oyTOTy` | claude-code | 1,802초 | codex 1,800초 queue wait 뒤 `Circuit breaker open` |

모든 자식은 `team_id=NULL`이다. 따라서 품질 복구의 성공·실패가 원 팀 score 표본에
포함되지 않는다. 이는 score 자체의 직접 원인이라기보다 팀 품질 피드백이 끊기는
관측성 결함이다.

## 상위 3개 근본원인 가설

### H1. score/completion 정체의 직접 원인은 benchmark 실패가 아니라 인프라 poison이다

- 근거: 9건 중 유일한 terminal 실패 `task_GgQ8CwfGz1FFiE3i`.
- 원문 error: `orphaned: server restart (poison — requeued 2x)`.
- 해당 태스크는 응답이 없고 `orphan_requeue_count=2`다.
- 특정 benchmark stage가 실행되어 실패했다는 증거는 없다.
- 증거등급: T1, 신뢰도 높음.

### H2. 프롬프트의 출력 계약과 품질 복구 경로가 동시에 실패했다

- `src/verification/response-quality.ts`는 verifier-backed 응답이 첫 줄에서
  `done:`, `status:`, `question:`, `error:` 중 하나로 시작하지 않으면
  `FORMAT_MISMATCH`로 판정한다.
- 5개 부모의 metadata가 실제로 `qualityRejected=true`,
  `qualityHeuristics=["FORMAT_MISMATCH"]`를 기록했다.
- 5개 retry 자식이 모두 실패해 교정 결과가 하나도 생성되지 않았다.
- 첫 줄 계약은 당시 team 04 prompt에 명시되지 않았다.
- 증거등급: T1, 신뢰도 높음.

### H3. 동일 work report 팬아웃이 작은 표본을 편중시켰다

- 동일 prompt/workReportId가 3회 terminal completed로 집계됐다.
- 세 건은 9건 표본의 33.3%이며 모두 `FORMAT_MISMATCH`였다.
- 따라서 독립된 세 번의 benchmark 결과로 해석할 수 없다.
- 증거등급: T1, 신뢰도 높음.

## 경계가 명확한 조치와 롤백

이번 자가학습 하위작업에서는 다음 두 가지 기록만 수행한다.

1. 이 개선 노트를 추가해 근거 없는 “benchmark stage repeat failure” 진단을
   T1 task 계보로 대체한다.
2. 동일 요약을 Mem0에 `tech-port-04 실패패턴` 키로 저장하고 저장 ID와 재조회
   결과를 검증 영수증에 기록한다.

팀·조직·lifecycle 상태, task 상태, score 행은 변경하지 않는다. 코드 수정도
동시 작업 중인 타 팀 변경과 겹치므로 이 하위작업에서는 수행하지 않는다.

롤백:

- 노트: 이 파일만 삭제하거나 해당 추가 commit을 revert한다.
- Mem0: 기록된 memory ID 하나만
  `DELETE /api/mem0/codex/<memory-id>`로 제거한다. API가 중단된 경우
  서비스 복구 뒤 수행한다.

후속 구현 후보 `[미적용]`:

- team 04의 verifier-backed prompt에 첫 줄 응답 계약을 명시한다.
- `workReportId` idempotency가 terminal 중복에도 적용돼야 하는지 별도 설계한다.
- 품질 retry가 원 task의 `team_id`를 계승하도록 하되 score 중복 집계 정책을 먼저
  정의한다.

## 스냅샷 이후 상태

이 노트 작성 전에 lifecycle에 `tle_Se_CRicxYY4gzqRr`(02:30 UTC, score 96.3,
improvement completed)와 `tle_j3vQ35zVRDIsgaE2`(02:40 UTC, score 96.2,
`n=8`)가 이미 존재했다. 현재 코드에는 `orphaned:%`와
`Circuit breaker open%` 인프라 실패를 team score terminal 분모에서 제외하는
조건도 이미 존재한다. 이 회복을 이번 문서·Mem0 기록의 효과로 주장하지 않는다.

## 검증 영수증

- [변경] `docs/self-improve/tech-port-04-baseline-benchmark-cycle2-2026-07-24.md`
  — 48h/9 원본, 재시도 계보, 상위 3개 원인, 롤백 기록.
- [검증방법] `db/nco.db` read-only SQL 재조회, 파일 재읽기,
  Mem0 저장 후 ID·본문·검색 재조회, `npx tsc --noEmit`, 관련 Vitest,
  `npm run build`, `git diff --check`.
- [등급] T1 — SQLite 원본 행, 실제 파일 내용, 실제 명령 출력.
- [Gap] 검증 실행 후 실측 결과로 갱신.
- [미검증항목] 전용 `nco_list_tasks`/`nco_get_task` 호출, production 부하,
  후속 구현 후보의 회귀 영향.

