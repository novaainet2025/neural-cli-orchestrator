---
title: gov-command-collaboration cycle 4 학습 — 48h/8 재추출
date: 2026-07-28
team_id: team_gov-command-collaboration
team_slug: gov-command-collaboration
improvement_cycle: 4
evidence_tier: T1
tags:
  - nco
  - self-learning
  - collaboration-mesh
  - error-prevention
---

# gov-command-collaboration cycle 4 학습 — 48h/8 재추출

## 결론

- 기준 스냅샷은 `team_lifecycle_events.id=tle_VV788pez2n3A7-p8`,
  `2026-07-27 20:50:00 UTC`, `score=83.4`, `completion=87.5`,
  `sample=48h`, `n=8`, `maxN=90`이다. 현재 소스의
  `computeTeamScores()`를 `db/nco.db`에 다시 실행한 결과도
  `83.4 / B / 87.5% / n=8 / maxN=90`이었다.
- `4bccaf6` 시각(`2026-07-28T05:30:33+09:00`) 이후 이 팀의 신규 terminal
  task는 **0건**이다. cycle 4 표본 8건은 전부 그 이전 행이므로 신규 실패 원인이
  추가된 상태가 아니다.
- 표본은 완료 7건과 실패 1건이다. 남은 실패
  `task_ZZ88RKyuEpH_T8MV`는 PM2 `SIGINT` shutdown과 22ms 간격으로 provider
  exit 1이 기록된 과거 행이다. 같은 유형의 향후 저장 정규화는 이미
  `7eb7dd4`에 들어갔지만 이 과거 DB 행은 소급 변경되지 않아 48h 표본에 남아 있다.
- 표시 점수의 잔여 gap `16.6`은 하나의 원인이 아니다. 소스 식을 실제 스냅샷 값에
  적용하면 raw score `83.3711766586279`가 `83.4`로 반올림된다. 완료율 항의 gap
  기여는 `11.25`, `computeVolume` 항의 gap 기여는
  `5.378823341372094`이고, 두 raw gap의 합은 `16.628823341372094`다.
- NCO HTTP `:6200`은 이 세션에서 `curl: (7) Failed to connect`였으므로
  HTTP 라이브 응답은 **미검증**이다. 위 판정은 DB 행, 현재 scorer 실행 결과,
  Git 파일/해시, PM2 로그를 근거로 한다.

## 샘플 원본 8건 표 (task_id/agent/status/error/증거등급)

기간은 lifecycle 스냅샷 시각을 상한으로 한 정확한 48시간이며, 소요시간은
`completed_at - created_at`으로 계산한 DB wall time이다. provider 실제 모델 실행
시간과 동일하다고 주장하지 않는다.

| task_id | agent(provider) | status | error | 소요시간(s) | response bytes | 증거등급 |
|---|---|---|---|---:|---:|---|
| `task_e3jyQHHLBEqMBCCs` | ollama | completed | NULL | 155 | 817 | T1 — tasks 행 |
| `task_dzPRXYhaMk3AzhlQ` | hermes | completed | NULL | 27 | 1,180 | T1 — tasks 행 |
| `task_oa1quZNQZJqF1j3w` | ollama | completed | NULL | 40 | 493 | T1 — tasks 행 |
| `task_kJ9xKYxyAwN9unr1` | opencode | completed | NULL | 3,365 | 237 | T1 — tasks 행 |
| `task_8raTpdLuY_zByKPG` | codex | completed | NULL | 1,296 | 520 | T1 — tasks 행 |
| `task_B_Guy1kIMJpE8ry1` | ollama | completed | NULL | 1,401 | 778 | T1 — tasks 행 |
| `task_ZZ88RKyuEpH_T8MV` | hermes | failed | `hermes: CLI failed exit=1 — Reading additional input from stdin...` | 25 | 6,298 | T1 — tasks 행 + PM2 로그 |
| `task_kEK9y3-dIjcFDH9d` | opencode | completed | NULL | 30 | 2,037 | T1 — tasks 행 |

### 에이전트별 재집계

| agent | 표본 | 완료 | 실패 | completion | wall 합계(s) | wall 평균(s) |
|---|---:|---:|---:|---:|---:|---:|
| ollama | 3 | 3 | 0 | 100.0% | 1,596 | 532.0 |
| hermes | 2 | 1 | 1 | 50.0% | 52 | 26.0 |
| opencode | 2 | 2 | 0 | 100.0% | 3,395 | 1,697.5 |
| codex | 1 | 1 | 0 | 100.0% | 1,296 | 1,296.0 |

### raw terminal 11건에서 제외된 3건

| task_id | agent | status | scorer 제외 근거 | 증거등급 |
|---|---|---|---|---|
| `task_vul5sMk4wNuu-aQB` | opencode | failed | 동일 `workReportId=wr_8EfXc5_COR2M_Kg6`의 완료 형제 `task_8raTpdLuY_zByKPG` 존재 | T1 — tasks 행 |
| `task_CmAsfvFiSfqBnsHY` | claude-code | failed | `error='provider_unavailable: claude-code (open/generic)'` | T1 — tasks 행 |
| `task_4aq6FQ3yZuXoiTdK` | opencode | failed | provider-auth 전용 오류 봉투: response 978 bytes, `invalid x-api-key` 위치 134, `"statusCode":401` 위치 153, `authentication_error` 위치 809 | T1 — tasks 행 |

## mesh/inter-session 메시지 원시 집계

동일 스냅샷 상한의 48시간만 집계했다. 표본 11개 task ID를 메시지 본문에서
직접 검색한 결과는 mesh와 inter-session 모두 **0건**이다. 따라서 메시지 통계와
task 성공/실패 사이의 인과는 **미검증**이며, 단순 동시발생을 원인으로 승격하지 않는다.

### mesh_messages

| from_agent | 메시지 | 고유 본문 | 채널 |
|---|---:|---:|---:|
| nco | 1,007 | 978 | 10 |
| codex-root | 1 | 1 | 1 |

- 전체 1,008건, 고유 본문 979건, 채널 11개.
- `nco-system→unknown` 908건, `nco-system→work-report-scheduler` 63건.
- protocol prefix(`done:/status:/error:/question:`) 1건.
- 동일 `(from_session,to_session,content)` 중복 그룹 16개, 해당 메시지 41건,
  중복 초과분 25건, 단일 그룹 최대 4건.
- 대상 task ID 언급 0건. protocol 응답이 신규 task로 변환됐다는 lineage도 0건이다.

### inter-session messages.log

| from_name | 메시지 | 종류 |
|---|---:|---|
| codex-nova-safety | 15 | broadcast 7 / direct 8 |
| nova-macstudio-claude-1 | 5 | broadcast 5 |
| nova-macstudio-claude-3 | 3 | direct 3 |
| nova-macstudio-claude-4-2 | 1 | direct 1 |
| nova-macstudio-claude-6 | 10 | broadcast 9 / direct 1 |
| nova-macstudio-claude-7 | 4 | broadcast 1 / direct 3 |
| nova-macstudio-claude-99 | 1 | broadcast 1 |

- 전체 39건, protocol prefix 17건, 대상 task ID 언급 0건.
- 동일 `(from_name,to,text)` 중복 그룹 1개, 중복 초과분 4건.

### 48h 필터 재사용 교훈

`mesh_messages.created_at`은 `2026-07-25T22:39:19.993Z`처럼 `T/Z`를 포함한다.
이를 `created_at >= datetime(...)`로 문자열 비교하면 같은 날짜의 cutoff 이전 행도
포함된다. 동일 스냅샷에서 문자열 필터는 3,022건
(`MIN=2026-07-25T00:07:10.213Z`), `julianday()` 필터는 정확히 1,008건
(`MIN=2026-07-25T22:39:19.993Z`)이었다. 이전의 `3018`류 수치를 strict 48h
근거로 재사용하지 않는다.

## 패턴 분류

| 패턴 | 재추출 판정 | 직접 근거 |
|---|---|---|
| cycle4 지시문 stale vs 현재 실측 불일치 | **없음** | lifecycle `83.4/87.5/n=8/maxN=90`과 현재 scorer 재실행 결과 일치 |
| `4bccaf6` 이후 신규 팀 실패 | **없음** | 이후 terminal 0건, 최신 표본 task 생성 시각 `2026-07-27 18:00:16 UTC` |
| provider-auth 상위 error 덮어쓰기 | **있음, 이미 제외됨** | `task_4aq...`의 escalation 첫 reason은 `provider_unavailable: claude-code (open/auth)`지만 최종 error는 일반 opencode CLI wrapper |
| dup-fanout | **있음, 이미 제외됨** | 동일 work report 3사본: opencode failed, claude-code failed, codex completed |
| 잔여 계상 실패 | **있음, 과거 shutdown 행** | `task_ZZ...`: PM2 `SIGINT`와 hermes exit 1 사이 22ms, DB에는 failed 유지 |
| protocol response 재변환 | **미검증/lineage 0** | mesh 1건·inter-session 17건의 protocol prefix는 있으나 대상 task ID 언급 0건 |
| 단일 표본 편중 | **구조적 영향 확인** | `n=8`, fleet `maxN=90`에서 volume `46.21176658627907`, 점수 기여 `4.621176658627907` |

## 이미 수정 완료 항목과 커밋 해시

| 항목 | 커밋 | 확인 내용 |
|---|---|---|
| delivered work-report 중복 사본 scorer 제외 | `e0a98de`, `04ffd9f` | `WORK_REPORT_DUP_DELIVERED_EXCLUSION`, all-failed fanout 상태 한정 |
| provider-auth 오류 봉투 scorer 제외 도입 | `7eb7dd4` | `PROVIDER_AUTH_EXCLUSION_SQL`과 env rollback toggle 도입 |
| 평문 `Invalid API key` 표면형 추가 | `a8c285a` | 정확 일치 + 빈 result guard 추가 |
| cursor-agent `Authentication required` 표면형 추가 | `d1a23ce` | 세 번째 인증 표면형 추가 |
| shutdown 중 generic exit 1 정규화 | `7eb7dd4` | shutdown 시작 시 active runtime을 표시하고 cancelled/orphaned로 정규화 |
| cycle4가 참조한 현재 통합 HEAD | `4bccaf6f413791fd883f62563a3eeda20b7984d6` | 현재 HEAD와 점수 `83.4` 확인. 단, `git diff-tree`상 이 커밋 자체의 `src/core/team-scorer.ts` 변경 경로는 0개이므로 scorer line-origin 커밋으로 재인용하지 않는다. |

## 잔여 갭 후보와 근거

1. **역사 행의 48h 잔존**
   `task_ZZ88RKyuEpH_T8MV`는 `2026-07-27 17:28:27 UTC` 생성,
   DB 계산상 `2026-07-29 17:28:27 UTC`에 48h 창을 벗어난다. 그 전에 status를
   소급 변경하거나 task-ID 전용 scorer 예외를 넣는 것은 금지한다.
2. **volume 항의 구조적 감점**
   완료율과 별도로 `computeVolume(n,maxN)`가 10% 반영된다. 이 스냅샷에서
   volume은 `46.21176658627907`이고 점수 기여는 `4.621176658627907`이다.
   팀별 단일 표본 품질과 fleet 최대 표본량을 섞는 정책이 타당한지는 별도 HR/평가
   정책 결정이며, 이번 분석 작업에서 식을 바꾸지 않는다.
3. **HTTP 라이브 검증 공백**
   `localhost:6200` 연결 거부로 `/api/health`, `/api/teams/scores`,
   `/api/agents`, `/api/activity` 본문은 미검증이다. DB와 scorer 재실행은 확인됐지만
   serving process 상태를 대신하지 않는다.
4. **메시지→task lineage 부재**
   `mesh_messages`와 inter-session log에서 대상 task ID가 0건이라 dup/protocol
   메시지가 이번 실패를 만들었다고 입증할 수 없다. 추적 키가 추가되기 전까지는
   상관관계를 원인으로 보고하지 않는다.

## 재작업 금지 목록

- `task_ZZ88RKyuEpH_T8MV` status/error를 소급 수정하거나 삭제하지 않는다.
- 이 task ID 또는 `hermes: CLI failed exit=1` 일반문만 겨냥한 scorer 예외를 만들지 않는다.
- `4bccaf6`을 `PROVIDER_AUTH_EXCLUSION` 소스 line-origin 커밋으로 다시 기록하지 않는다.
- raw terminal 11건, scored 8건, 메시지 1,008건의 서로 다른 분모를 섞지 않는다.
- ISO `T/Z` timestamp에 문자열 `datetime()` 비교를 사용해 48h 수치를 만들지 않는다.
- protocol-prefixed 메시지 존재만으로 task 재변환이나 mesh 실패의 인과를 주장하지 않는다.
- 팀 삭제·비활성화·retirement·lifecycle status 변경을 수행하지 않는다.

## Mem0/장기기억 등록용 요약 (3줄)

cycle4 `83.4/87.5%/48h-8`은 DB·현재 scorer 재실행과 일치하며 `4bccaf6` 이후 신규 팀 terminal은 0건이다.
raw 11건 중 provider-auth 1·provider-unavailable 1·delivered dup-fanout 1이 제외되고, 잔여 실패 1은 이미 future-normalized된 SIGINT 역사 행이다.
점수 잔여 gap은 완료율 항과 log10 volume 항의 복합 결과이며, ISO `T/Z` 48h 집계는 문자열 비교가 아니라 `julianday()`를 사용한다.

등록 검증: NCO HTTP가 연결 거부 상태여서 동일 애플리케이션 `mem0Add` 경로를
`NCO_MEM0_NO_EMBED=1`로 1회 실행했다. DB 재조회 결과
`mem0-1785185962373-5g51f5`, `agent_id=team_gov-command-collaboration`,
`embedded=0`, 본문 3줄, 동일 본문 행 1건이다.

## 변경·검증 경계

- 코드 수정: 없음.
- 이 작업이 수행한 팀/lifecycle 쓰기: 없음. `teams` 행은 `is_active=1`,
  `is_always_on=1`로 읽기 확인. 분석 도중 외부 HR scheduler가
  `tle_APLt_geO0kv9WQSQ`(`source=scheduled`, `score_checked`, `83.4`) 1행을
  `2026-07-27 21:00:00 UTC`에 append한 것은 별도 관측 사실이다.
- 추가 산출물: 이 학습 노트 1건.
- 장기기억: `mem0_memories.id=mem0-1785185962373-5g51f5` 1건.
- 되돌리기: 이 신규 파일과 위 ID의 장기기억 1행만 정확히 제거하면 된다
  (미실행). 이 작업은 DB task/team/lifecycle 행을 쓰지 않았다.
- [Evidence Tier 1] `db/nco.db` tasks/team_lifecycle_events/teams 행, 현재 scorer
  실행 출력, Git commit/file 내용, PM2 로그, inter-session 원문 로그를 직접 확인했다.

## 검증 영수증

- [변경] `data/error-prevention/gov-command-collaboration-cycle4-learning-2026-07-28.md`
  신규 1건, `mem0_memories.id=mem0-1785185962373-5g51f5` 신규 1행. 코드 diff 0.
  task/team/lifecycle 쓰기 0; 외부 scheduled `score_checked` append 1행은 위에 별도 기록.
- [검증방법] `node --import tsx scripts/run-with-work-event.ts --event-type
  regression:typecheck -- ./node_modules/.bin/tsc --noEmit` → exit 0.
- [검증방법] 같은 wrapper로
  `./node_modules/.bin/vitest run src/core/team-scorer.test.ts
  src/core/task-queue.shutdown.test.ts` → test files 2 passed, tests 20 passed.
- [검증방법] 같은 wrapper로 `./node_modules/.bin/tsc` → exit 0.
- [검증방법] 공식 `run-delivery-gate.sh --full` → exit 4,
  `PASS=0 FAIL=4 SKIP=0`. 기존 dirty checkout과 `tsx` CLI의
  `listen EPERM .../*.pipe` 때문에 inspection/typecheck/test/build가 실패했다.
  `TMPDIR`를 `/private/tmp` 전용 디렉터리로 바꾼 npm 재시도도 같은 `listen EPERM`이었다.
- [등급] T1 — 파일/DB/PM2/Git 원문과 명령 출력을 이 작업에서 직접 관찰.
- [Gap] 요청 산출물 2/2와 underlying typecheck/test/build는 검증 완료.
  공식 npm/delivery-gate wrapper 통과 및 live HTTP serving은 미검증이다.
