---
title: Collaboration Mesh and Protocol 실패 패턴 — 2026-W30 cycle 3
date: 2026-07-28
team_id: team_gov-command-collaboration
team_slug: gov-command-collaboration
improvement_cycle: 3
evidence_tier: T1
tags:
  - nco
  - self-improvement
  - collaboration-mesh
  - mem0
---

# Collaboration Mesh and Protocol 실패 패턴 — 2026-W30 cycle 3

## 결론

`2026-07-27 18:10:00 UTC` HR 스냅샷의 `score=75.0`,
`completion=77.8%`, `sample=48h/9`는 mesh 전달 실패나
`done:/status:/error:` 응답 재변환 루프가 아니라, 다음 두 provider/runtime 실패가
일반 팀 품질 실패로 계상된 결과다.

1. `task_4aq6FQ3yZuXoiTdK` — `opencode` 응답 본문에
   `statusCode:401`, `authentication_error`, `invalid x-api-key`가 있으나 최종
   `error`는 일반 `opencode: CLI failed exit=1` 래퍼다.
2. `task_ZZ88RKyuEpH_T8MV` — NCO가 `SIGINT`로 shutdown된 직후
   `hermes`가 사용하는 `codex` CLI가 exit 1로 끝났고 failover도 skip됐다.
   최종 `error`가 일반 `hermes: CLI failed exit=1` 래퍼라 scorer의 인프라 제외에
   걸리지 않았다.

즉 cycle 1의 문서·기억 개선이 scorer/runtime 분류 경계에 연결되지 않은 상태에서
새 인프라 실패가 표본에 계속 유입된 것이 cycle 2→3 정체의 직접 원인이다.

## 증거 경계와 재현 기준

- 팀: `team_gov-command-collaboration`
- 스냅샷: `team_lifecycle_events.id=tle_IEx_Rhn7KZElOOoB`
- 스냅샷 시각: `2026-07-27 18:10:00 UTC`
- lifecycle 원문: `score=75.0`, `improvement_count=2`,
  `metadata={"sample":"48h","n":9,"maxN":84,"completion":77.8,...}`
- cycle 3 시작: `tle_eZMaQejH7xKndTLL`과
  `tle_kPThTg8A_7TmI6VV`, `improvement_count=3`
- 원천: `/Users/nova-ai/project/nco/db/nco.db`
- 실행 로그:
  `/Users/nova-ai/.pm2/logs/nco-backend-out-0.log`
- scorer 정의:
  `/Users/nova-ai/project/nco/src/core/team-scorer.ts`
- 표본 grain: scorer가 선택한 terminal task 1행
- 시간 필터: task `created_at`이 스냅샷 이전 48시간
- 제외 규칙: provider-unavailable 등 인프라 접두사, 완료된 work report의 실패
  중복 사본, all-failed fanout, never-ran lease, dead-agent job-wait 등 현재
  `team-scorer.ts` 규칙

현재 gateway `http://localhost:6200`은 연결되지 않아 HTTP API가 아니라 SQLite
행과 PM2 원문 로그를 source of truth로 사용했다.

## score 재현

현재 scorer 식:

```text
volume = 100 × log10(n) / log10(maxN)
score  = round1(0.9 × completion + 0.1 × volume)
```

스냅샷 값을 대입하면:

```text
n = 9
maxN = 84
completion = 7 / 9 × 100 = 77.8
volume = 100 × log10(9) / log10(84) = 49.58960564358733
score = round1(0.9 × 77.8 + 0.1 × 49.58960564358733) = 75.0
```

raw terminal은 11건이다. scorer가
`task_vul5sMk4wNuu-aQB`를 완료된 동일 work report
`wr_8EfXc5_COR2M_Kg6`의 실패 중복 사본으로,
`task_CmAsfvFiSfqBnsHY`를 `provider_unavailable:` 인프라 실패로 제외해
점수 표본은 9건이 된다.

## 48h/9 점수 표본

| task ID | 담당 | 상태 | 직접 관찰 | 판정 |
|---|---|---:|---|---|
| `task_e3jyQHHLBEqMBCCs` | ollama | completed | 응답 817자 | 포함 성공 |
| `task_dzPRXYhaMk3AzhlQ` | hermes | completed | 응답 1,180자 | 포함 성공 |
| `task_oa1quZNQZJqF1j3w` | ollama | completed | 응답 493자 | 포함 성공 |
| `task_kJ9xKYxyAwN9unr1` | opencode | completed | work report 응답 237자 | 포함 성공 |
| `task_8raTpdLuY_zByKPG` | codex | completed | 동일 logical work report의 완료 사본, 응답 520자 | 포함 성공 |
| `task_4aq6FQ3yZuXoiTdK` | opencode | failed | 응답의 `401 invalid x-api-key`; error는 일반 CLI 래퍼 | 포함 실패, 인프라 오분류 |
| `task_B_Guy1kIMJpE8ry1` | ollama | completed | 응답 778자 | 포함 성공 |
| `task_ZZ88RKyuEpH_T8MV` | hermes | failed | PM2 shutdown과 동시에 CLI exit 1; failover skip | 포함 실패, 인프라 오분류 |
| `task_kEK9y3-dIjcFDH9d` | opencode | completed | 응답 2,037자 | 포함 성공 |

점수에서 제외된 raw terminal:

| task ID | 담당 | 상태 | 제외 근거 |
|---|---|---:|---|
| `task_vul5sMk4wNuu-aQB` | opencode | failed | `wr_8EfXc5_COR2M_Kg6`의 완료 사본 `task_8raTpdLuY_zByKPG` 존재 |
| `task_CmAsfvFiSfqBnsHY` | claude-code | failed | `error='provider_unavailable: claude-code (open/generic)'` |

## 에이전트별 실패율

아래 비율은 **scorer의 48h/9 표본**만 분모로 삼는다.

| 담당 | 포함 terminal | 실패 | 실패율 |
|---|---:|---:|---:|
| hermes | 2 | 1 | 50.0% |
| opencode | 3 | 1 | 33.3% |
| ollama | 3 | 0 | 0.0% |
| codex | 1 | 0 | 0.0% |
| claude-code | 0 | 0 | 해당 없음 |

`claude-code`의 raw 실패 1건은 scorer 인프라 제외 대상이므로 점수 표본 실패율의
분모에 넣지 않았다. raw 11건과 scored 9건을 섞어 비율을 만들지 않는다.

## cycle 1→2→3 변화

| 시각 UTC | lifecycle | cycle 상태 | score / completion / n | 직접 변화 |
|---|---|---|---|---|
| 07-27 06:05:15 | `tle_6iht_lfSwI4QwJDL` | cycle 1 trigger | 75.7 / 80.0% / 5 | 실패 1건이 있던 최초 지시 |
| 07-27 07:15:02 | `tle_waotLwIyESPUCTPt` | cycle 1 도중 | 93.7 / 100.0% / 5 | 완료 사본 반영과 scorer 제외 후 회복 |
| 07-27 17:20:58 | `tle_mcVz3oe6PibpoRDA` | cycle 2 trigger | 79.1 / 83.3% / 6 | `task_4aq...` 401 실패가 새로 포함 |
| 07-27 17:30:00 | `tle_mM-4Ph0uEtqnIkqM` | cycle 2 도중 | 68.7 / 71.4% / 7 | `task_ZZ...` shutdown 실패가 추가 |
| 07-27 17:44:28 | `tle_d_m5unbTdSpA-f1v` | cycle 2 도중 | 72.2 / 75.0% / 8 | `task_B...` 성공 추가 |
| 07-27 18:00:47 | `tle_DO-QLjKGrmXHsFk8` | cycle 2 도중 | 75.0 / 77.8% / 9 | `task_kEK...` 성공 추가 |
| 07-27 18:10:00 | `tle_t5Rl7zIO7zKAB17Q` | cycle 2 failed / cycle 3 start | 75.0 / 77.8% / 9 | 실패 2건이 계속 표본에 남음 |

cycle 2에서 성공 2건이 추가됐지만 새 shutdown 실패도 1건 추가됐고, cycle 2의
학습 산출물은 런타임/scorer를 변경하지 않았기 때문에 표본의 두 오분류 실패를
제거하지 못했다.

## 실패별 로그 근거

### `task_4aq6FQ3yZuXoiTdK`

- DB `response` 위치: `invalid x-api-key` 134번째 문자,
  `statusCode` 154번째 문자, `authentication_error` 809번째 문자
- DB `error`: `opencode: CLI failed exit=1 ...`
- PM2 로그 line 3455480:
  `taskId=task_4aq6FQ3yZuXoiTdK`, `claude-code → opencode`,
  `Escalating task after non-rate-limit failure`
- scorer의 `INFRA_EXCLUSION`은 `error` 접두사를 검사하며, 이 구조화된 401이
  `response`에만 있으면 제외하지 못한다.

### `task_ZZ88RKyuEpH_T8MV`

- PM2 로그 line 3455790:
  `module=main`, `signal=SIGINT`, `Shutting down...`
- PM2 로그 line 3455793:
  22ms 뒤 `agentId=hermes`, `exitCode=1`,
  `codex exec ... --sandbox read-only -m gpt-5.6-terra`
- PM2 로그 line 3455804:
  `taskId=task_ZZ88RKyuEpH_T8MV`,
  `Automatic task failover skipped`
- `config/ai-providers.json`과 `config/ai-providers.local.json`은 `hermes`의
  command를 의도적으로 `codex`로 설정한다. 따라서 agent 이름 불일치가 아니라
  현재 provider alias 구성이다.
- DB `error`: `hermes: CLI failed exit=1 ...`
- shutdown 기인 실행 중단이 `orphaned:` 또는 `provider_unavailable:`로 정규화되지
  않아 점수 실패로 남았다.

## 기각하거나 보류한 가설

### mesh 미전달

동일 48시간에 `mesh_messages` 952건, `to_session='unknown'` 852건(89.5%),
고유 본문 926건, 완전 동일 본문의 최대 중복 4건을 관찰했다. PM2에도
`recipient_unavailable`, `status=not_queued`, `acknowledged=false`가 있다.

그러나 `mesh_messages` 스키마에는 task ID나 receiver acknowledgement가 없어 두 점수
실패와의 인과 연결을 만들 수 없다. 따라서 mesh 관측성은 별도 위험이지만 이번
`75.0`의 직접 원인으로 주장하지 않는다.

### 프로토콜 응답 변환 루프

raw 11개 prompt 중 legacy `[이전 단계 ...]`와
`[현재 단계 실행 지시 — 최우선]` 패턴은 모두 0건이었다. 응답 prefix는 `done:` 2건,
`status:` 0건, `error:` 0건이었지만 이 응답이 새 task로 변환됐다는 lineage 증거는
없다. 두 실패 task 모두 동일한 텍스트 전용 일일 진단 prompt였고 실패 원문은
provider/runtime 오류다.

### 응답 시간 초과

두 점수 실패는 각각 생성 후 약 3초, 약 25초 만에 terminal이 됐다. scorer의
`timed_out`이나 `lease_expired`가 아니므로 응답 시간 초과를 직접 원인으로 보지 않는다.

## bounded fix

이번 자가학습 하위작업의 범위에서는 다음 두 산출물만 추가한다.

1. 이 cycle-3 개선 note의 vault 반영 대기 staging 사본
2. 이 note의 핵심 결론과 재검증 키를 담은 단일 Mem0 장기기억
   `mem0-1785176484742-7qaehu`

런타임 코드, scorer, team row, lifecycle event는 변경하지 않는다. 후속 구현 단계에서는
다음 두 좁은 normalization을 별도 회귀 테스트와 함께 검토해야 한다.

- `response`의 구조화된 `401/authentication_error/invalid x-api-key`를
  terminal 저장 전에 `provider_unavailable:<agent>(open/auth)`로 정규화
- drain/shutdown이 실행 중 CLI를 종료한 경우 일반 exit 1 대신 명시적 인프라 종료
  분류를 저장하고, 현재 failover 정책과 scorer가 같은 분류를 사용하도록 통일

### 안전·되돌리기

- `teams.id=team_gov-command-collaboration`은 `is_active=1`,
  `is_always_on=1`인 상태를 읽기 확인했다.
- 팀 삭제·비활성화·retirement·lifecycle status 변경은 수행하지 않는다.
- 되돌리기는 이 staging note와 Mem0
  `mem0-1785176484742-7qaehu`만 대상으로 한다.
  에이전트 전체 memory clear는 사용하지 않는다.

## 검증 영수증

- [Evidence Tier 1] `db/nco.db` task/lifecycle/team/mem0 행,
  PM2 로그 line 3455480·3455790·3455793·3455804, 현재 scorer/provider 설정
  파일 내용을 직접 확인했다.
- [재현] raw terminal 11 → 제외 2 → scored 9, 완료 7·실패 2,
  completion 77.8%, score 75.0.
- [Mem0] `mem0-1785176484742-7qaehu`, `stored=true`,
  `embedded=false`를 insert 후 DB에서 다시 읽어 확인했다.
- [typecheck] `node --import tsx scripts/run-with-work-event.ts
  --event-type regression:typecheck -- ./node_modules/.bin/tsc --noEmit` → exit 0.
- [build] `node --import tsx scripts/run-with-work-event.ts
  --event-type regression:build -- ./node_modules/.bin/tsc` → exit 0.
- [관련 테스트] `vitest run src/core/team-scorer.test.ts` →
  test file 1 passed, tests 6 passed.
- [Vault Gap] 원본 경로 추가는
  `patch rejected: writing outside of the project; rejected by user approval settings`
  로 차단됐고 최종 재조회도 `VAULT_NOTE_MISSING`이었다.
- [공식 gate Gap] `run-delivery-gate.sh --quick` → exit 2.
  canonical checkout의 dirty file 123개 검사와 `npm run typecheck`의
  `tsx` Unix pipe `listen EPERM`이 실패했다. 위 IPC 없는 동일 wrapper로 compiler를
  별도 재실행해 exit 0을 확인했지만 공식 npm-script 경로 실패는 그대로 남긴다.
- [미검증] Obsidian vault 원본 반영, 후속 runtime normalization 구현,
  post-fix dispatch, 다음 48시간 점수, receiver acknowledgement.
- [HTTP Gap] 최종 `curl -sS --max-time 3 http://localhost:6200/api/health`는
  `curl: (7) Failed to connect to localhost port 6200 after 0 ms:
  Couldn't connect to server`로 실패했다.
