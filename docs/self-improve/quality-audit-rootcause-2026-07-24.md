# 품질 검수팀 48시간 완료율 저하 근본원인 — 2026-07-24

## 기술 요약

- 요청 지표의 원장은 `team_lifecycle_events`의
  `tle_KYVYFrYSgOHxnL4G`(`score_checked`, 2026-07-24 03:50:00 UTC)와
  `tle_pVs0F0w2GIXcxFY4`(`hr_directive`, 같은 시각)이다.
  `score_checked` metadata는 `{"sample":"48h","n":7,"completion":85.7,...}`만
  저장한다(score 숫자는 이벤트에 없음). HR 프롬프트/라이브 스코어의 score
  (당시 ~82.2, 재검증 시점 81.7)는 `computeTeamScores`의 volume 항을 포함한
  별도 산출이며, completion·n은 이벤트와 일치한다.
- 48시간 원시 terminal 9건 중 `orphaned:%` 인프라 실패 2건을 기존 필터가
  제외하고, 6 completed + 1 failed가 분모 7을 구성했다. 유일한 counted failure
  `task_SMVL4-GzMPj56Wtg`는 품질 감사가 아니라 `commander-perfgoal` 제어면
  목표/성과 입력 태스크다. 에이전트는 미주입 필수값을 조작하지 않고 확인을 요청했다.
  따라서 **85.7%의 14.3%p 미달은 팀 감사 작업 누락이 아니라 스코어러 범위 오탐**이다.
- 이 표본에는 `lease_expired=0`, `heartbeat-NULL=0`이다. 유일한 실패도 heartbeat
  6회와 응답 본문이 있으므로 never-ran/lease 장애 가설은 기각된다.
- 다만 현재 데이터로 “실제 감사 품질은 100%”라고 결론 낼 수 없다. 분모 7 중 직접
  팀 상시 감사는 2건뿐이고, 그중 `task_Pv7u4ADyacqfxLtG`는 DB status가
  `completed`이지만 응답 첫 문장에서 최신 패키지 미제공으로 최종 감사를 완료할 수
  없다고 명시한다. **현재 completion은 실행 상태 지표이지 업무 성취 지표가 아니다.**
- 결론은 **surface & hold**다. 제어면 태스크 제외는 타당하지만, 배포 반영과
  업무결과 의미론 개선은 자가개선팀이 별도로 검증해야 한다. 팀 삭제·비활성·retirement
  변경은 수행하지 않는다.

## 범위와 원천

- 분석 기준 시각: **2026-07-24 03:50:00 UTC**(KST 12:50:00)
- 48시간 시작: **2026-07-22 03:50:00 UTC**
- 대상: `team_quality-audit`
- 원천: [`db/nco.db`](../../db/nco.db)의 `tasks`,
  `team_lifecycle_events`, `team_lifecycle_profiles`
- 스코어 정의: [`src/core/team-scorer.ts`](../../src/core/team-scorer.ts)의
  terminal 상태, 48시간 선택, completion 및 fleet-relative volume 산식
- API 대응: `nco_list_tasks`는 `GET /api/tasks`, `nco_get_task`는
  `GET /api/tasks/:id`이며 두 라우트 모두 `tasks` 원장을 읽는다
  ([`src/mcp/server.ts`](../../src/mcp/server.ts),
  [`src/server/gateway.ts`](../../src/server/gateway.ts)).

초안 작성 시점에는 `localhost:6200` 연결 거부였다. cycle 1 T1 재검증
(2026-07-24 13:41 KST)에서는 `/api/health` healthy, `GET /api/tasks/:id`로
`task_SMVL4-GzMPj56Wtg`·`task_Pv7u4ADyacqfxLtG`·`task_16HQgVNhF7mF545t`를
교차확인했고 DB row와 일치했다. `GET /api/tasks?teamId=` 쿼리 필터는
동작하지 않으므로(gateway list가 team_id를 필터하지 않음) 팀별 전수는
SQL 또는 ID별 GET이 필요하다. 아래 수치는 이동하는 “현재 48시간”이 아니라
HR directive 이벤트 시각(03:50 UTC)에 고정했고, 롤링 창 재집계는 별도 표기한다.

## DB-grounded 증거표: 점수에 포함된 7건

모든 시각은 UTC다. `HB`는 `last_heartbeat_at`과 `heartbeat_seq`를 뜻한다.

| task_id | created → completed | status | acked_at | HB | spawned_by_cli | 근본원인 분류 |
|---|---|---:|---|---|---|---|
| `task_uuStvylGPSQN-6KG` | 07-22 07:05:47 → 07:15:52 | completed | 07:05:47 | 07:15:48 / 40 | `work-report-scheduler` | 업무보고 완료; 감사 charter 직접 표본 아님 |
| `task_16HQgVNhF7mF545t` | 07-22 15:01:03 → 15:02:36 | completed | 15:01:03 | 15:02:36 / 10 | `team-runner` | 직접 품질 감사 수행; 완료 응답 존재 |
| `task_x_y4k22B50uQPE9U` | 07-23 00:00:40 → 00:04:02 | completed | 00:00:40 | 00:03:58 / 30 | `work-report-scheduler` | 업무보고 완료; 감사 charter 직접 표본 아님 |
| `task_yTdf6-mNBkFq3g1U` | 07-23 05:00:56 → 05:01:33 | completed | 05:00:56 | 05:01:32 / 7 | `work-report-scheduler` | 업무보고 완료; 감사 charter 직접 표본 아님 |
| `task_SMVL4-GzMPj56Wtg` | 07-23 11:38:19 → 11:40:30 | **failed** | **NULL** | 11:40:07 / 6 | `commander-perfgoal` | **제어면 범위 오탐**: 필수 목표값 미주입을 조작하지 않고 확인 요청 |
| `task_Pv7u4ADyacqfxLtG` | 07-23 15:01:03 → 15:01:46 | completed | 15:01:05 | 15:01:44 / 7 | `team-runner` | 직접 감사 태스크이나 입력 패키지 부재로 “최종 감사 불가”; status/business outcome 불일치 |
| `task_1n2K1YvoVdWphPhq` | 07-24 00:00:48 → 00:02:36 | completed | 00:00:48 | 00:02:33 / 14 | `work-report-scheduler` | 업무보고 완료; 감사 charter 직접 표본 아님 |

집계 패턴은 다음과 같다.

| 구분 | n | completed | non-completed | ack NULL | heartbeat NULL | lease_expired |
|---|---:|---:|---:|---:|---:|---:|
| `work-report-scheduler` | 4 | 4 | 0 | 0 | 0 | 0 |
| `team-runner` | 2 | 2 | 0 | 0 | 0 | 0 |
| `commander-perfgoal` | 1 | 0 | 1 | 1 | 0 | 0 |
| 합계 | **7** | **6** | **1** | **1** | **0** | **0** |

`acked_at=NULL`만으로 실행되지 않았다고 판정하면 안 된다.
`task_SMVL4-GzMPj56Wtg`에는 heartbeat 6회, `last_activity_at`, 응답, 성공한 build
verifier가 모두 남아 있다. 이 행의 실패는 lease 장애가 아니라 입력 계약과 점수 범위의
문제다.

## 원시 9건에서 제외된 인프라 이벤트

| task_id | status | created → completed (UTC) | ack / HB | error | 분류 |
|---|---|---|---|---|---|
| `task_zhONDDhk-axRXUId` | failed | 07-23 11:52:56 → 11:56:05 | acked / HB 5 | `orphaned: server restart (poison — requeued 2x)` | 기존 `INFRA_EXCLUSION`으로 제외 |
| `task_quality_check` | failed | 07-23 19:08:00 → 07-24 02:53:29 | ack NULL / HB 6 | `orphaned: server restart (poison — requeued 2x)` | 기존 `INFRA_EXCLUSION`으로 제외 |

고정 시점 재계산 결과는 원시 terminal **9건/완료 6건=66.7%**,
directive 당시 필터 **7건/완료 6건=85.7%**, 현재 소스의 일반화 필터
**6건/완료 6건=100.0%**다. 마지막 100.0%는 **태스크 status completion**의
재계산값이며 감사 품질 100%를 뜻하지 않는다.

## 하락 지점과 스코어 해석

`team_lifecycle_events`에서 확인되는 주요 점검 시점은 다음과 같다.

| score_checked (UTC) | score | sample | n | completion |
|---|---:|---|---:|---:|
| 2026-07-24 02:20:01 | 73.6 | 48h | 8 | 75.0% |
| 2026-07-24 02:30:00 | 83.0 | 48h | 7 | 85.7% |
| 2026-07-24 03:20:03 | 82.3 | 48h | 7 | 85.7% |
| 2026-07-24 03:30:01 | 82.2 | 48h | 7 | 85.7% |
| **2026-07-24 03:50:00** | **82.2** | **48h** | **7** | **85.7%** |
| 2026-07-24 04:00:01 | 82.1 | 48h | 7 | 85.7% |
| 2026-07-24 04:20:00 | 81.9 | 48h | 7 | 85.7% |

03:30까지 score가 83.0에서 82.2로 내려가는 동안 `n=7`과
`completion=85.7%`는 변하지 않았다. 소스상 score의 나머지 입력은 fleet의 최대 표본에
상대적인 volume이므로, 이 구간의 하락은 새 팀 실패가 아니라 상대 volume 변화로
설명된다. 다만 이벤트 metadata가 당시 `maxN`과 volume 값을 저장하지 않으므로 정확한
volume 항은 재현 불가다.

02:20→02:30의 분모 변화 원인은 현재 `tasks` 행만으로 확정할 수 없다. task 상태가
in-place 갱신되고 스코어러 소스도 같은 날 변경됐지만 이벤트에는 행별 inclusion snapshot이
없다. 따라서 이 전환에 특정 태스크 원인을 소급 배정하지 않는다.

## 근본원인 판정

| 가설 | 판정 | 근거 | 신뢰도 |
|---|---|---|---|
| 실제 품질 감사 1건이 실패했다 | **기각** | counted failure는 `commander-perfgoal`; 감사 prompt가 아님 | 높음 |
| lease 만료 또는 heartbeat 누락이 completion을 낮췄다 | **기각** | scored 7건에서 둘 다 0건 | 높음 |
| 제어면 태스크가 팀 품질 분모에 섞였다 | **확정** | 7건 중 유일 실패의 spawner/prompt/response가 모두 제어면을 지시 | 높음 |
| `completed`가 업무 성취를 정확히 나타낸다 | **기각** | `task_Pv7u4ADyacqfxLtG`는 completed지만 최종 감사 불가를 명시 | 높음 |
| 83.0→82.2가 추가 팀 실패를 뜻한다 | **기각** | 해당 구간 n/completion 고정; score 산식의 상대 volume만 변동 가능 | 중간-높음 |

`task_SMVL4-GzMPj56Wtg`의 응답은
`targetValue`, `direction`, `unit`, `reflection`, `improvement`가 알려지지 않았으니
요청자에게 확인하라는 내용이다. 이는 Fable honesty-first와 팀 charter의 “근거가 없으면
지어내지 말고 미확인으로 표시” 원칙에 부합한다. 이 정직한 거부를 품질 실패로 계산한 것이
직접 근본원인이다.

## bounded·reversible fix 인계

현재 HEAD에는 commit `1dfa39e5149ddd8cdb2478fd7ce1bf09b6128eff`가
`spawned_by_cli='commander-perfgoal'`을 팀 무관 제어면으로 제외하도록
`CONTROL_PLANE_PERFGOAL_EXCLUSION`을 terminal/completed 6개 CASE에 대칭 적용한다.
이 소스 변경은 다음 이유로 범위가 제한되고 되돌릴 수 있다.

- 제외 키는 일반 응답 문자열이 아니라 전용 spawner 식별자다.
- numerator와 denominator에 대칭 적용해 `completed ⊆ terminal`을 보존한다.
- 롤백은 조건을 `team_id='team_kd-memory'`로 다시 좁히는 단일 상수 변경이다.
- 팀 lifecycle 상태, 활성 여부, retirement에는 손대지 않는다.

그러나 commit 이후인 04:20·04:40 score event도 여전히 `n=7`, `completion=85.7%`를
기록했고, 라이브 `GET /api/teams/scores`의 `team_quality-audit`도
`score=81.7, completion=85.7, n=7, sample=48h`다. 같은 DB에 현재 HEAD 필터를
적용하면 rolling 48h도 `6/6=100%`이므로 **소스 수정 존재와 운영 프로세스 반영은
분리**된다. 이 자가학습 하위작업에서는 서비스 재시작이나 lifecycle 조작을 하지
않고 자가개선팀에 다음을 인계한다.

1. 배포된 scorer가 HEAD와 같은 필터를 사용하는지 확인하고, 재계산 응답에서 대상 팀이
   `n=6`인지 T1로 검증한다.
2. `team_lifecycle_events.metadata_json`에 `completed`, `maxN`, `volume`,
   포함/제외 task ID snapshot을 저장해 과거 score를 재현 가능하게 만든다.
3. task status와 별도로 `business_outcome` 또는 `scope_kind`
   (`charter`, `work-report`, `control-plane`)를 기록해 실행 완료와 업무 성취를 분리한다.
4. `acked_at=NULL`은 heartbeat/response와 함께 해석하고 단독 never-ran 규칙으로 쓰지 않는다.

## Obsidian 개선 노트

**패턴 ID:** `quality-audit-score-scope-20260724`

- **증상:** completion 85.7%, score 82.2로 팀 품질 저하처럼 보임.
- **실제 원인:** 7건 중 유일 실패가 팀 감사가 아닌 제어면 목표 입력이며, 미주입 값을
  조작하지 않은 안전한 거부였음.
- **반복 감점 요인:** team_id만으로 이질적인 charter·업무보고·제어면 태스크를 한 분모에
  섞음. `completed`도 business success와 동일시함.
- **조기 탐지:** 점수 하락 시 `spawned_by_cli`, prompt 목적, response 첫 문장,
  ack/heartbeat/lease를 함께 조회한다.
- **안전 가드:** 전용 spawner 기반 제외, numerator/denominator 대칭, 포함 task snapshot
  보존, lifecycle 결정은 HR 전권 유지.
- **시각화 생략:** n=7의 범주형 감사에서는 차트보다 task ID가 보이는 정확한 증거표가
  원인 검증에 더 적합하다.

## Mem0 장기기억 연동 항목

1. `team_id`는 성과 범위를 보장하지 않는다. `spawned_by_cli`와 task 목적을 함께 분류해
   control-plane 태스크를 charter completion에서 제외한다.
2. `acked_at=NULL`만으로 never-ran을 판정하지 않는다. heartbeat, response,
   `last_activity_at`, lease status를 교차 확인한다.
3. NCO의 `completed`는 실행 종료 상태일 수 있으며 business objective 달성을 보장하지
   않는다. 응답의 명시적 미완료 신호를 별도 outcome으로 저장한다.
4. 상대 volume을 포함한 score 이벤트에는 `maxN`, volume, 포함/제외 task snapshot을
   같이 저장해야 과거 수치를 재현할 수 있다.
5. 팀 lifecycle·retirement는 HR 전권이다. 자가학습/자가개선은 증거와 scorer 범위만
   다루고 팀 삭제·비활성화는 수행하지 않는다.

## 한계와 추가 질문

- `GET /api/tasks`는 team_id 쿼리 필터가 없어 팀별 목록은 SQL/`GET /api/tasks/:id`가 필요하다.
  개별 get_task 3건은 cycle 1에서 T1 교차확인 완료.
- 03:50 이벤트가 사용한 `maxN`과 inclusion snapshot·score 숫자는 metadata에 없어
  volume 항을 정확히 재현할 수 없다.
- DB 행은 상태 이력을 보존하지 않으므로 02:20→02:30의 개별 task 전환은 알 수 없다.
- 최신 홍보 패키지 제공 여부와 실제 감사 품질을 확인할 별도 business-outcome 원장은
  현재 표본에 없다.
- 운영 프로세스에 HEAD 필터가 반영된 뒤 n=6으로 재계산되는지, 그리고
  `task_Pv7u4ADyacqfxLtG` 같은 안전한 “입력 부족” 결과를 성공/보류 중 무엇으로
  정의할지는 자가개선팀과 metric owner가 결정해야 한다.

## cycle 1 T1 재검증 (2026-07-24 13:41 KST) — surface & hold

| 검증 | 결과 | 등급 |
|---|---|---|
| `tle_KYVYFrYSgOHxnL4G` metadata | `n=7`, `completion=85.7`, `sample=48h` (score 필드 없음) | T1 |
| 고정창 terminal 9건 | 완료 6 / 실패 3(`task_SMVL4` perfgoal, `task_zhONDDhk` orphan+perfgoal, `task_quality_check` orphan) | T1 |
| HR 당시 조건(orphan 제외) | 7/6 = **85.7%** — directive와 일치 | T1 |
| HEAD 필터(orphan+perfgoal 제외) | 6/6 = **100.0%** (counterfactual, 운영 회복 주장 아님) | T1 |
| lease_expired / heartbeat-NULL | scored 분모에서 **0건** | T1 |
| `GET /api/tasks/task_SMVL4-GzMPj56Wtg` | status=failed, spawned_by_cli=commander-perfgoal, response=필수값 미주입 거부 | T1 |
| `GET /api/teams/scores` live | quality-audit **score=81.7, completion=85.7, n=7** | T1 |
| `npm run build` / `vitest team-scorer.test.ts` | exit 0 / 4 passed | T1 |

**판정:** 근본원인은 실감사 누락이 아니라 `commander-perfgoal` 제어면 오계상이다.
코드 가드(`CONTROL_PLANE_PERFGOAL_EXCLUSION`, commit `1dfa39e5`)는 HEAD에 있으나
운영 프로세스의 live score는 아직 구필터(n=7)다. 자가학습 범위에서는 추가 diff
없이 **surface & hold**. 배포/재시작·lifecycle은 HR/자가개선 전권.

## 검증 영수증

- [변경] `docs/self-improve/quality-audit-rootcause-2026-07-24.md` — cycle 1 T1
  재검증(API·live scores·metadata 정정)·surface & hold 기록. 소스 코드 변경 없음.
- [기존 패치] `src/core/team-scorer.ts:194-196` —
  `CONTROL_PLANE_PERFGOAL_EXCLUSION` (commit `1dfa39e5`, 이번 하위작업에서 재작성 안 함)
- [DB 검증] 고정창·롤링창 동일: raw `9/6`, infra `7/6=85.7%`, HEAD 필터 `6/6=100.0%`
- [API 검증] `/api/health` healthy; `/api/tasks/:id` 3건 DB 일치;
  `/api/teams/scores` → quality-audit `81.7 / 85.7% / n=7` (운영 미반영 Gap)
- [이벤트 검증] `tle_KYVYFrYSgOHxnL4G` → `n=7, completion=85.7, sample=48h`
- [빌드/타입체크] `npm run build` → exit 0 (`tsc`)
- [관련 테스트] `npx vitest run src/core/team-scorer.test.ts` → 1 file, 4 tests passed
- [증거 등급] T1 (DB row + HTTP body + 파일). 운영 프로세스 reload는 **미실시**
- [Gap] live scorer가 HEAD 필터를 쓰도록 재시작/재배포; event metadata에 score/maxN/
  inclusion snapshot 부재; business-outcome 원장 부재
- [미검증항목] 없음(범위 내). 운영 반영은 자가개선팀 인계.
