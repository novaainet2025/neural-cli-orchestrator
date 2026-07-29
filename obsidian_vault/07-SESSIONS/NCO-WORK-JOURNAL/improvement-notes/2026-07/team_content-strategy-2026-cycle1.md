---
team_id: team_content-strategy-2026
team_slug: content-planning
team_name: 콘텐츠 전략·근거기획팀
improvement_cycle: 1
sample: 48h
sample_size: 2
observed_score: 46.7
observed_completion: 50
evidence_date: 2026-07-28
status: staged
---

# 콘텐츠 전략·근거기획팀 개선 cycle 1

## 결론

점수 46.7의 직접 원인은 최근 48시간 표본 2건 중 `task_trend_collector`가
`status='completed'`로 기록됐지만 검증 가능한 산출물과 NCO 실행 흔적이 전혀 없는
0바이트 완료 행이라는 점이다. 현재 스코어러는 이 행을 terminal 분모에는 남기고
completed 분자에서는 제외하므로 유효 완료가 1/2가 되어 completion이 50%가 된다.

이 행은 팀 에이전트의 콘텐츠 품질 실패가 아니다. 외부
`/Users/nova-ai/project/nova-sns/automation/trend-collector.py`가 고정 ID를 NCO DB에
직접 `INSERT OR REPLACE`하고, `collect_all_trends()`가 예외 없이 끝났다는 이유만으로
상태만 `completed`로 갱신한다. 이 경로는 수집 결과를 `response`, `result_json`,
`evidence_json`에 기록하지 않고 NCO 에이전트 실행도 거치지 않는다.

## 확인 범위와 기준 시점

- DB: `/Users/nova-ai/project/nco/db/nco.db`
- SQLite 확인 시각: 2026-07-28 08:31:46 UTC
- 스코어러 직접 실행 결과:
  `{"teamId":"team_content-strategy-2026","slug":"content-planning","name":"콘텐츠 전략·근거기획팀","organizationId":"org_sns-blog","score":46.7,"grade":"F","completion":50,"n":2,"maxN":66,"sample":"48h"}`
- 팀 row: `is_active=1`, 구성원은 `agy`, `retired-provider`, `ollama`
- HR lifecycle 상태나 팀 활성 상태는 읽기만 했고 변경하지 않았다.

## 표본별 성공·실패 원인

| task | DB 상태 | 담당 | 직접 관측된 실행/산출물 | 판정과 원인 |
|---|---|---|---|---|
| `task_EbTqTcR3_iFzfMQB` | completed | agy | response 891바이트, error NULL, 현 세대 agent action 2건, work event 7건, heartbeat 8 | 유효 성공. 주입된 에이전트 현황 수치를 그대로 요약하고 근거가 없는 검색의도·독자 문제·차별점은 `미확인`으로 표시했다. 다만 입력 자체에 독자·콘텐츠 근거가 없어 실제 근거 패킷은 만들지 못했다. |
| `task_trend_collector` | completed | mlx | response 0바이트, result 0바이트, evidence 0바이트, progress 0.0, ack/heartbeat 없음, 현 세대 agent action 0건, work event 0건 | 유효 실패. 외부 수집 스크립트의 성공 상태만 DB에 투영됐고 NCO가 검증할 산출물은 저장되지 않았다. `mlx`는 이 팀의 구성원도 아니다. |

## 에이전트별 작업 패턴

- `agy`: 팀 표본 1건을 받아 1건 모두 검증 가능한 텍스트 산출물을 남겼다. 없는
  콘텐츠 근거를 만들지 않은 점은 charter와 일치한다. 다만 `done: [Evidence Tier 1]`은
  주입 텍스트와의 일치만 뜻하며, 원문·실사례·독자 결과를 검증했다는 뜻은 아니다.
- `retired-provider`, `ollama`: 구성원이지만 최근 48시간 이 팀 표본에 배정된 태스크가 0건이어서
  이 팀에서의 성공/실패 패턴을 평가할 수 없다.
- `mlx`: 구성원이 아닌데 외부 cron이 고정값으로 지정했다. 현 세대 NCO 실행은 0건이며
  0바이트 완료 행만 남았다. 따라서 이 표본으로 `mlx`의 모델 성능을 평가해서는 안 된다.

## 46.7점의 주요 저해 요인

1. 유효 산출물이 없는 완료 행 때문에 completed 분자가 2가 아니라 1이다.
2. 스코어 공식은 `0.9 × completion + 0.1 × volume`이다. 현재
   `volume = 100 × log10(2) / log10(66) = 16.544255391905832`이고,
   `0.9 × 50 + 0.1 × 16.544255391905832`를 한 자리로 반올림하면 46.7이다.
   즉 주된 감점은 표본량 항목보다 completion 50%다.
3. 유효 성공 1건도 콘텐츠 전략에 필요한 검색의도, 독자 문제, 기존 글, 원문,
   데이터, 실사례를 입력받지 못했다. 상태 점수에는 성공으로 잡히지만 팀 charter의
   핵심 산출물인 근거 패킷 품질은 확인할 수 없다.
4. 고정 ID를 반복 덮어쓰는 외부 producer 때문에 과거 agent action이 같은 task ID에
   누적될 수 있다. 반드시 현재 `tasks.created_at` 이후의 action/event만 세어야 한다.

## 적용한 bounded fix

이번 자가학습 하위작업의 허용 범위에서는 코드나 HR lifecycle을 변경하지 않고 다음
판정 규칙을 개선 노트와 팀 장기 기억에 고정한다.

> 팀 성공은 status 문자열만으로 인정하지 않는다. `response`, `result_json`,
> `evidence_json` 중 하나의 검증 가능한 산출물과 현재 task 세대의 실행 흔적을 함께
> 확인한다. 고정 ID task는 `tasks.created_at` 이후의 action/event만 사용한다.
> 외부 collector 성공을 팀 task로 기록하려면 수집 파일 경로·요약·검증값을 evidence로
> 연결하고, 그렇지 않으면 팀 품질 task가 아닌 별도 telemetry로 분리한다.

이 수정은 문서·기억만 추가하므로 기존 런타임을 변경하지 않는다. 팀 공유 Mem0에는
`mem0-1785227833778-v7102o`로 저장했다. 되돌리려면 이 노트와 해당 Mem0 행을 제거하고
`team:team_content-strategy-2026` HNSW index를 재구축하면 된다. upstream producer 코드는
이 하위작업의 프로젝트/파일 범위 밖이라 수정하지 않았다.

## 다음 cycle 권고

1. `trend-collector.py` producer 소유 팀이 성공 시 수집 파일 경로, 항목 수의 출처,
   파일 hash 또는 최소 요약을 NCO evidence에 기록하도록 별도 변경한다.
2. 고정 ID 대신 실행별 ID를 쓰거나 generation key를 저장해 과거 action과 현재 실행이
   섞이지 않게 한다.
3. team-runner 입력에 실제 검색의도·독자 문제·기존 글·원문/데이터 후보를 최소 1개씩
   넣고, 없으면 “근거 수집 task”로 명시해 결과를 제작팀에 전달한다.
4. 다음 표본에서는 `retired-provider`와 `ollama`도 실제 팀 task를 수행한 뒤에만 에이전트 간 패턴을
   비교한다.

## 검증 영수증

- [Evidence Tier 1] `teams`, `team_members`, `tasks`, `agent_actions`,
  `work_events`, `team_lifecycle_events`의 DB 행과 두 task 본문을 직접 확인했다.
- [Evidence Tier 1] `src/core/team-scorer.ts`의 공식과 직접 실행된
  `computeTeamScores()` 결과가 score 46.7, completion 50, n 2, maxN 66으로 일치했다.
  최종 재확인에서는 다른 팀 표본 변화로 조직 상대값 `maxN`이 65가 됐지만 score 46.7,
  completion 50, n 2, sample 48h는 그대로였다.
- [Evidence Tier 1] 외부 producer 파일의 `INSERT OR REPLACE`, 상태 갱신 SQL,
  고정 team/provider 값과 2026-07-28 cron 수집 완료 로그를 직접 확인했다.
- [Evidence Tier 1] Mem0 DB 행 `mem0-1785227833778-v7102o`와
  `team:team_content-strategy-2026` scope의 HNSW 검색 회수를 직접 확인했다.
- [Evidence Tier 1] `./node_modules/.bin/tsc --noEmit`와
  `./node_modules/.bin/tsc`는 각각 exit 0이었다.
- [Evidence Tier 1] `node node_modules/vitest/vitest.mjs run
  src/core/team-scorer.test.ts src/core/cron-scheduler.team-scores.test.ts`는
  test files 2개, tests 14개가 모두 통과했다.
- [미검증] package wrapper인 `npm run typecheck`, `npm run test`,
  `npm run build`는 코드 실행 전에 sandbox가 tsx IPC socket 생성을 막아 모두
  `listen EPERM .../tsx-501/*.pipe`로 실패했다. delivery gate 결과는
  `PASS=0 FAIL=4 SKIP=0`이며 이를 통과로 주장하지 않는다.
- [미검증] NCO HTTP health: `curl: (7) Failed to connect to localhost port 6200`
  (`HTTP_STATUS=000`).
- [미검증] 이 파일의 Obsidian 원본 경로 반영. 실행 환경이
  `/Users/nova-ai/obsidian/mac-obsidian/.../improvement-notes` 생성을
  `Operation not permitted`로 차단해 저장소 mirror에 스테이징했다.
- [미변경] 팀 삭제·비활성화·retirement·HR lifecycle 상태.
- [미변경] 범위 밖 upstream `nova-sns/automation/trend-collector.py`.
