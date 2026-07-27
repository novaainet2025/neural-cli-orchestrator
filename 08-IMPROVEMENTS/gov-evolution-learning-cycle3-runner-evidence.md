# team_gov-evolution-learning — 개선 사이클 3/3 근본원인·수정 기록

작성: 2026-07-28 (KST) · 대상: `team_gov-evolution-learning` (Continuous Learning) · 증거 등급 T1

## 1. HR 지시문 수치는 stale (재작업 아님, 실측으로 확인)

| 출처 | score | grade | completion | n | sample |
|---|---|---|---|---|---|
| HR 지시문 (cycle 3) | 83.4 | — | 87.5% | 8 | 48h |
| `computeTeamScores()` @HEAD `d1a23ce` | **94.3** | A | **100%** | 7 | 48h |
| 라이브 `GET :6200/api/teams/scores` | **94.3** | A | **100%** | 7 | 48h |
| HEAD + `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off` | 83.3 | B | 87.5% | 8 | 48h |

지시문 수치는 `PROVIDER_AUTH_EXCLUSION`(2026-07-27 fleet 자격증명 장애 제외 절)이 적용되기 전에
찍힌 스냅샷과 정확히 일치한다. 해당 절은 이미 HEAD에 반영·라이브 서빙 중이므로 **스코어러는
변경하지 않았다(diff 0)**. HR 목표 90을 이미 상회한다.

48h 실패 3건과 귀속 클래스(모두 팀 산출물 품질이 아닌 인프라/자격증명 이벤트):

- `task_3eejRUftHpUXmdOH` — `silent-failure: empty output`, wr `wr_wcXz4AG_W0eFppWp` (형제 태스크가 보고서 제출)
- `task_IjCXiEO-3LT65aIS` — `provider_unavailable: claude-code (open/generic)` → `INFRA_EXCLUSION`
- `task_p2V_WOaQg3z-gdGx` — opencode 401 봉투(`{"type":"error"…`) → `PROVIDER_AUTH_EXCLUSION`

## 2. 실제로 남아 있던 근본원인 — team-runner 경로의 학습 증거 미회수

`tasks` 실측: 이 팀의 태스크 **10건 전부**, 프롬프트에 `[learning_task_evidence]` **0회**.

```
sqlite3 db/nco.db "SELECT id, CASE WHEN prompt LIKE '%[learning_task_evidence]%'
  THEN 'HAS' ELSE 'NO' END FROM tasks WHERE team_id='team_gov-evolution-learning';"
→ 10행 모두 NO
```

최근 3건(`task_p2V_WOaQg3z-gdGx`, `task__3A5-o_ot53ooK3D`, `task_ZPInZmK1byYaqSGY`,
2026-07-27 17:29~17:37)은 `spawned_by_cli='team-runner'`, `workReportId=none` — 즉
**work-report 경로가 아니라 상시 임무(team-runner) 경로**로 생성된다.

- 사이클 1(2026-07-27)이 고친 `src/core/work-report-scheduler.ts`의 `buildTeamDataContext()`
  학습 증거 블록은 work-report 경로에만 존재한다. 이 팀의 최근 work-report는 06:53이 마지막이라
  그 수정은 아직 실제 프롬프트에 나타난 적이 없다.
- `scripts/team-runner.sh`의 `build_team_data_context()`에는 `analytics-lead`/`cfo`/
  `self-improvement`/`ax-docs` 전용 분기만 있고 `gov-evolution-learning` 분기가 없었다.
  주입되는 `[실데이터]`는 집계 카운트뿐 → 태스크 id·error·`learning_events`가 0건.
- 같은 프롬프트가 `[실데이터 사용 규칙] 위 값과 주입된 파일 내용만 사실로 사용한다`를 강제한다.
  결과적으로 팀 charter("태스크 결과·실패·검증 영수증에서 재사용 가능한 교훈을 추출")를
  **구조적으로 수행할 수 없는** 상태였다. 이는 사이클 1·2가 "src/ 밖"이라며 명시적으로
  범위에서 제외한 잔여 갭이다.

## 3. 수정 (bounded, reversible)

`scripts/team-runner.sh` `build_team_data_context()`에 `gov-evolution-learning` 전용 분기 추가
(+79줄, 1파일). `src/core/work-report-scheduler.ts:321-416`과 **같은 쿼리·같은 라벨·같은 상한**을
파이썬으로 미러링한다.

- `[learning_task_evidence]` — 48h terminal 태스크 최대 5건 (id/상태/생성/완료/오류/지시/응답/
  result_json/evidence_json/workReportId, 응답은 `T4-natural-language`로 태깅)
- `[learning_event_evidence]` — 위 태스크 id에 `context.taskId`/`context.sourceTaskId`로 연결된
  `learning_events` 최대 10건
- 읽기 전용(`mode=ro`) 커넥션 재사용, `except (OSError, sqlite3.Error): pass` — 조회 실패 시
  기존 동작 그대로(러너 무중단)
- **롤백**: `NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT=off` (재빌드·재배포 불필요).
  src/ 측 플래그와 같은 이름이라 한 번에 되돌아간다.

## 4. 검증 (T1)

러너의 프롬프트 빌더 heredoc을 그대로 추출해 실 DB(`db/nco.db`) + 라이브 `/api/teams`
스냅샷으로 실행한 결과:

| 실행 | prompt bytes | `[learning_task_evidence]` | `[learning_event_evidence]` |
|---|---|---|---|
| HEAD (수정 전) | 1926 | 0 | 0 |
| 수정 후 | 10353 | 5 | 5 |
| 수정 후 + 플래그 off | 1926 | 0 | 0 |

- 롤백 동등성: `cmp` 결과 수정 전 body.json과 플래그 off body.json **바이트 동일**.
- 주입된 실제 값 예: `id=task_p2V_WOaQg3z-gdGx, 상태=failed, 오류=opencode: CLI failed exit=1 …`,
  `[learning_event_evidence] id=434, agent=codex, event=failover_dispatch,
  pattern=silent-failure: empty output` — 모두 실제 DB 행.
- 타 팀 무영향: `team_self-improvement` / `team_cfo` / `team_analytics-lead` /
  `team_content-planning` 4팀 body.json 수정 전후 **바이트 동일**.
- `bash -n scripts/team-runner.sh` → 0
- `npx tsc --noEmit` → exit 0
- `npm run build` → exit 0
- `npm run test:run` → 709 passed / 1 failed. 유일한 실패 `tests/근거.test.ts >
  최신 포인터가 오늘 날짜를 가리킨다`(`expected '2026-07-27' to be '2026-07-28'`)는
  **선행 존재**하는 실패다 — `git stash push -- scripts/team-runner.sh` 후 동일 실패 재현 확인.
  KST 자정 데이터 포인터 staleness 테스트이며 이번 변경과 무관하다.

## 5. Gap / 미검증

- 이번 변경은 **다음 team-runner 실행 시점**부터 실제 태스크 프롬프트에 반영된다. 실제 러너가
  생성한 태스크 행에서 `[learning_task_evidence]`를 확인한 것은 아니다(빌더 직접 실행까지만 검증).
- 증거가 주입된 뒤 팀 산출물 품질이 실제로 올라가는지는 다음 사이클 관측 대상이다.
  스코어는 이번 변경으로 움직이지 않는다(이미 94.3/A/100%).
- 커밋은 하지 않았다(사용자 소관). 잔여 out-of-scope: `src/security/learning-stage-gate.ts`
  는 여전히 importers=0(미배선).
