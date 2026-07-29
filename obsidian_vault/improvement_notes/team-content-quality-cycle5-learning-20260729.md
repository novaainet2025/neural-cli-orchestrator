---
created_at: 2026-07-29T03:15:27+09:00
verified_at: 2026-07-29T03:16:47+09:00
team_id: team_content-quality
team_slug: content-quality
cycle: 5
evidence_window: 48h
evidence_snapshot_utc: 2026-07-28T18:10:01Z
evidence_tier: T1
tags:
  - improvement
  - content-quality
  - self-learning
  - evidence-audit
  - post-fix-observation
---

# 고품질 검수팀 Cycle 5 — 48시간 8건 사후검증

## 결론

운영 DB `db/nco.db`의 최신 확인 스냅샷
`team_lifecycle_events.id='tle_V_ZP0mjFb_5bpwPd'`는
`score=83.8`, `completion=87.5`, `sample=48h`, `n=8`,
`maxN=61`이다. 점수 표본은 완료 7건·실패 1건이다.

완료율을 직접 낮춘 행은 여전히
`task_JjX-85_K_1H7WuEC` 한 건이다. build verifier가 통과했지만
응답 전체가 JSON string으로 직렬화된
`"done: workflow implementation gate passed"`여서
`quality_rejected: FORMAT_MISMATCH`로 실패했다. 같은 workflow의 평문 재시도
`task_VZ3TWJjdlYpZ73Ab`는 완료됐다.

이 결함의 bounded fix는 이미 현행 코드에 있다.

- `src/core/collaboration.ts:34`
  `normalizeCollaborationProtocolResponse()`
- `src/verification/response-quality.ts:89`
  공용 normalization 사용
- 최초 품질 게이트 fix:
  `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`
- protocol parser까지 공용화한 현행 변경:
  `b5ba3a439463a50872b2aa793199739e6d785202`

그러나 최초 fix 시각 이후 이 팀의 implementation/verification task는 0건이다.
따라서 현재 점수 유지가 fix 실패라는 근거도, fix가 실제 provider E2E에서
효과를 냈다는 근거도 없다. 과거 실패 task 상태를 성공으로 다시 쓰지 않았고,
rolling 48시간 창에 과거 실패가 남아 있어 87.5%가 유지되는 상태다.

또한 표본 8건에는 실제 게시 후보 원문을 받은 콘텐츠 6축 검수 task가 0건이다.
따라서 83.8을 블로그 콘텐츠 품질 점수로 해석할 수 없다. 이 수치는 NCO task
execution completion과 표본량을 결합한 팀 운영 점수다.

이번 Cycle 5의 bounded·reversible 변경은 이 개선 노트와 별도 Mem0 후보 목록
두 파일뿐이다. 같은 원인의 운영 코드를 중복 수정하거나 과거 DB 행을 변경하지
않는다.

## 점수 재계산

현행 `src/core/team-scorer.ts:556`의 `computeTeamScores()`는 최근 48시간의
`completed`, `failed`, `timed_out`, `lease_expired`를 필터·집계한다.
`cancelled`는 점수 표본에 포함하지 않는다.

최신 DB 행의 입력값을 그대로 계산하면 다음과 같다.

| 항목 | 값 |
|---|---:|
| completed | 7 |
| n | 8 |
| completion | 87.5 |
| maxN | 61 |
| volume | 50.583929606850326 |
| score | 83.8 |

공식:

```text
completion = round1(7 / 8 × 100) = 87.5
volume = 100 × log10(8) / log10(61) = 50.583929606850326
score = round1(0.9 × 87.5 + 0.1 × volume) = 83.8
```

직전 Cycle 4 기록의 `maxN=60`과 달리 최신 스냅샷은 `maxN=61`이다.
반올림된 score는 두 스냅샷 모두 83.8이지만, 시점이 다른 스냅샷 값을 서로
대체하지 않는다.

## 점수 표본 8건

모든 DB 근거는 `db/nco.db`의 `tasks.id=<task ID>` 행이다. DB 시각은 UTC다.

| # | task / 상태 / UTC | 유형·근거 위치 | 확인 관찰 | 원인 판정 | 재검증 |
|---:|---|---|---|---|---|
| 1 | `task_v7oxdG9P6olVcdAC` / completed / `2026-07-27 00:02:14` | `spawned_by_cli='work-report-scheduler'`; `work_reports.id='wr_3n-Yy1czY76vlPgJ'`; `REPORTS/2026-07-27-고품질-검수팀-오전.md` | DB 보고가 `submitted`이고 파일도 존재한다. 파일은 당일 원문 부재·6축 채점 미수행을 명시한다. | 성공 사례: 실행·보고 전달은 완료. 콘텐츠 PASS 증거는 아님. | `tasks`와 `work_reports.source_task_id`를 조인하고 파일 SHA-256 `c630cb78569cb082fa06d9267bcd1540524fd7a3472ff6bb532042324c88cb73`을 다시 계산한다. |
| 2 | `task_TRiUFVnRT_oeVpAP` / completed / `2026-07-27 05:27:17` | work-report scheduler; `work_reports.id='wr_FQfiwowsv6j0rNkO'`; `REPORTS/2026-07-27-고품질-검수팀-오후.md` | DB `submitted`, 파일 존재. 오전과 같은 원문 부재를 재보고한다. | 성공 사례: 사실·미확인 범위를 분리한 보고. 신규 콘텐츠 verdict는 없음. | DB body와 파일 SHA-256 `1d074f5c40111107ffe575d3600ba7358945d3e3fa41e2ced6c487eeb1d9d4ec`을 대조한다. |
| 3 | `task_m5Vd83hUpjLpoTEv` / completed / `2026-07-27 17:03:27` | `spawned_by_cli='team-runner'`; `data/team-runner/team_content-quality-2026-07-28.md` | prompt에 게시 후보 원문·URL·제목이 없고, 응답은 `원문 미주입으로 채점 불가 → FAIL(보류)`라고 정직하게 보고했다. | 입력계약 위반은 확인. task completion 감점 원인은 아님. 범용 러너 오호출 fix는 migration 097로 이미 적용됨. | `tasks.prompt/response`를 확인하고 migration 적용 뒤 같은 spawner의 신규 행 수를 조회한다. |
| 4 | `task_eNx6XUOZiVTe1QZ_` / completed / `2026-07-28 00:02:39` | work-report scheduler; `work_reports.id='wr_dfMcFqeUewgIhvOe'` | DB 보고는 `submitted`, body 2416 bytes다. `REPORTS/2026-07-28-고품질-검수팀-오전.md`는 저장소에 없다. | DB 전달 성공은 확인. 파일 산출물 의무 여부는 unknown이므로 실패로 재분류하지 않는다. | DB body/status/source task를 조회하고 `test -f`로 파일 존재를 별도 확인한다. |
| 5 | `task_XLZde35QdjqlOXfp` / completed / `2026-07-28 05:02:08` | work-report scheduler; `work_reports.id='wr_vRaO0vWg3CWSIWOF'`; `REPORTS/2026-07-28-고품질-검수팀-오후.md` | DB `submitted`, 파일 존재. 오전 파일 부재와 콘텐츠 실점수 부재를 명시한다. | 성공 사례: 누락을 숨기지 않은 보고. 콘텐츠 PASS 증거는 아님. | DB body와 파일 SHA-256 `35f8b99bc5566c116455101b10550b48bdea967b65d4fd0afa5f032e476a1846`을 대조한다. |
| 6 | `task_qrxIUr3BQAgn8Ojy` / completed / `2026-07-28 12:25:52` | `metadata_json.workflowStage='discussion'` | verifier/evidence JSON 없이 `강제 효과 80% 향상 예상`을 주장한다. | 저평가 후보: 의미 검증 공백. completed이므로 87.5% 감점 원인은 아니다. 수치는 근거 없음. | response, `verifier_result_json IS NULL`, evidence 필드 부재를 확인하고 근거 없는 정량 주장 회귀를 별도 설계한다. |
| 7 | `task_JjX-85_K_1H7WuEC` / failed / `2026-07-28 12:32:01` | 동일 workflow `wfr_MBseWr_vOB55BRRZ`; implementation | build verifier `exitCode=0`, `passed=true`; quoted `done:`만 `FORMAT_MISMATCH`로 반려됐다. | score/completion의 직접 근본 원인. provider serialization 경계 결함. 현행 코드에서는 수정됨. | #8과 decoded response/workflow ID를 대조하고 response-quality·collaboration 회귀를 실행한다. |
| 8 | `task_VZ3TWJjdlYpZ73Ab` / completed / `2026-07-28 12:35:10` | 동일 workflow; implementation retry | 평문 `done: workflow implementation gate passed`; build verifier `exitCode=0`, `passed=true`. | 성공 사례: 의미가 같은 응답의 표현 wrapper만 달라 완료됐다. #7이 substantive 실패가 아님을 뒷받침한다. | #7/#8의 response, verifier, workflow ID를 한 쿼리로 비교한다. |

최근 48시간에는 위 8건 외에 `cancelled` 2건
(`task_yzkhttMqqv158Znf`, `task_yo9PrY2DqktHw_bb`)이 있다. 둘 다
`orphaned: graceful shutdown signal (SIGINT)`이지만
`computeTeamScores()`의 terminal 상태 집합에 `cancelled`가 없어 score 표본에는
들지 않는다. 이 노트는 이들을 8건 중 일부로 잘못 세지 않는다.

## 근본 원인 후보별 판정

### A. JSON string protocol wrapper — confirmed, 직접 감점

- 근거: `task_JjX-85_K_1H7WuEC`와 동일 workflow 재시도
  `task_VZ3TWJjdlYpZ73Ab`.
- 영향: 실패 1건이 남아 completion `7/8=87.5%`.
- 현행 fix: 유효한 JSON string 하나만 decode하고 malformed/structured JSON은
  기존대로 거부한다.
- rollback: 관련 commit의 normalization 함수와 테스트만 revert한다.
- 효과 측정: fix 이후 content-quality protocol task가 0건이므로 provider E2E는
  **unverified**.

### B. 수정 후 점수 정체 — confirmed observation, 회귀 증거 아님

- 최초 fix commit 시각: `2026-07-28T21:59:44+09:00`
  (`2026-07-28 12:59:44 UTC`).
- fix 이후 content-quality implementation/verification task: 0건.
- 최신 score snapshot: `2026-07-28 18:10:01 UTC`.
- 판정: 과거 실패가 rolling window에 남고 새 성공 표본이 없으므로 점수가 그대로다.
  과거 task·score 행 수정은 금지한다.
- 재검증: `created_at > '2026-07-28 12:59:44'`인 새 protocol task의 원문 응답과
  status를 확인한 뒤에만 효과를 판정한다.

### C. 대상 원문 없는 범용 러너 호출 — confirmed, completion 감점 아님

- 근거: `task_m5Vd83hUpjLpoTEv` prompt/response와 러너 파일.
- 기존 fix: `db/migrations/097_content_quality_dedicated_runner.sql`;
  `scripts/team-runner.sh:69`가 `@전담러너` 팀을 제외한다.
- 운영 DB: migration 적용 `2026-07-28 14:59:10 UTC`;
  두 charter는 `@전담러너`로 시작하며 `is_active=1`,
  `required_capabilities.protected=1`.
- 적용 뒤 `spawned_by_cli='team-runner'` 신규 행: 0.
- 판정: 입력계약 결함의 source fix는 존재. 다음 scheduled sweep과 실제
  `daily-blog-promo.sh` E2E는 **unverified**.

### D. discussion의 근거 없는 `80%` — confirmed output, score 원인 아님

- 근거: `task_qrxIUr3BQAgn8Ojy.response`;
  `verifier_result_json IS NULL`.
- 판정: 완료 상태만 검사하면 근거 없는 예측이 통과하는 의미 품질 공백 후보다.
  다만 이 행은 completed이므로 현재 completion 감점 원인은 아니다.
- 별도 코드 수정은 이번 하위작업 범위를 넘고 회귀 계약도 없어 수행하지 않는다.

### E. DB 업무보고와 파일 산출물 불일치 — observed, 의무 여부 unknown

- 근거: `task_eNx6XUOZiVTe1QZ_`의 work report는 DB `submitted`지만
  오전 파일은 없다.
- 판정: 파일이 필수라는 task 계약 근거가 없어 실패 원인으로 단정하지 않는다.
- 재검증: 해당 scheduler 계약과 `work_reports.body_md`가 canonical artifact인지
  확인해야 한다.

### F. `cycle=5/3`와 `improvement_failed` 이유 — unknown

- 현재 task `task_1SdqKjiqCg29HCII.prompt`에는 `cycle=5/3`이 있다.
- `team_lifecycle_events.id='tle_QgAaclU8UD0-19py'`는
  `event_type='improvement_failed'`지만 `metadata_json='{}'`다.
- 따라서 improvement cycle 초과 표기 또는 실패 사유는 DB 근거만으로 설명할 수 없다.
  HR lifecycle 상태·retirement를 변경하거나 제안하지 않는다.
- 재검증: company orchestrator 실행 로그 또는 실패 이벤트에 연결된 source task ID가
  필요하다.

## 성공 패턴과 실패 패턴 비교

| 비교축 | 성공 패턴 | 실패·저품질 패턴 |
|---|---|---|
| protocol | 평문 또는 유효한 JSON string을 공용 normalizer가 decode한 `done:` | 과거에는 전체 JSON string wrapper를 원문 그대로 검사해 오반려 |
| verifier | #8은 build `exitCode=0`, `passed=true`와 완료 상태가 일치 | #7은 같은 verifier 통과인데 표현 wrapper 때문에 실패 |
| 증거 태도 | #1, #2, #3, #5는 원문 부재·미확인을 숨기지 않음 | #6은 verifier 없이 `80% 향상`을 예측 |
| 콘텐츠 입력 | 실제 원문이 있으면 6축 검수 가능 | 이번 8건에는 대상 원문을 받은 검수 0건 |
| 산출물 전달 | DB submitted + 파일 존재가 3건 | DB submitted지만 파일 없는 보고 1건; 파일 의무는 unknown |

## Bounded·reversible fix

이번 단계는 이미 존재하는 source fix를 중복 변경하지 않고 다음 두 지식 산출물만
추가한다.

1. `obsidian_vault/improvement_notes/team-content-quality-cycle5-learning-20260729.md`
2. `obsidian_vault/improvement_notes/team-content-quality-cycle5-mem0-candidates-20260729.md`

두 파일 삭제로 원상복구할 수 있다. 운영 DB, task 상태, score snapshot, 팀
`is_active`, `protected`, charter, HR lifecycle/retirement는 변경하지 않았다.

## 재검증 명령

```bash
# 최신 HR 스냅샷
sqlite3 -readonly -json db/nco.db "
SELECT id,event_type,score,metadata_json,created_at
FROM team_lifecycle_events
WHERE team_id='team_content-quality' AND event_type='score_checked'
ORDER BY datetime(created_at) DESC LIMIT 1;"

# 점수 표본 8건
sqlite3 -readonly -json db/nco.db "
SELECT id,status,error,spawned_by_cli,created_at,
       json_extract(metadata_json,'$.workflowStage') AS workflow_stage,
       json_extract(metadata_json,'$.workflowRunId') AS workflow_run_id
FROM tasks
WHERE team_id='team_content-quality'
  AND datetime(created_at)>=datetime('now','-48 hours')
  AND status IN ('completed','failed','timed_out','lease_expired')
ORDER BY datetime(created_at);"

# 직접 감점 실패와 성공 재시도
sqlite3 -readonly -json db/nco.db "
SELECT id,status,error,response,verifier_result_json,metadata_json,created_at
FROM tasks
WHERE id IN ('task_JjX-85_K_1H7WuEC','task_VZ3TWJjdlYpZ73Ab')
ORDER BY datetime(created_at);"

# 전담 러너 fix와 lifecycle 불변식
sqlite3 -readonly -json db/nco.db "
SELECT id,substr(charter,1,80),is_active,is_always_on
FROM teams WHERE id='team_content-quality';
SELECT id,substr(charter,1,80),is_active,is_always_on,protected
FROM required_capabilities WHERE id='team_content-quality';
SELECT id,filename,applied_at FROM schema_migrations
WHERE filename='097_content_quality_dedicated_runner.sql';"

# 관련 회귀·빌드
./node_modules/.bin/vitest run \
  tests/response-quality.test.ts \
  src/core/collaboration.test.ts \
  src/core/company-orchestrator.test.ts \
  src/storage/content-quality-dedicated-runner-migration.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc
```

## 검증 영수증

- [변경] 이 Cycle 5 노트와 Mem0 후보 목록 2개 파일만 신규 추가했다.
  운영 코드·DB·팀 lifecycle 필드는 수정하지 않았다.
- [운영 DB] 최신 score event:
  `tle_V_ZP0mjFb_5bpwPd`,
  `{"sample":"48h","n":8,"maxN":61,"completion":87.5}`,
  score 원시값 `83.79999999999999716`.
- [빌드 산출물 재계산]
  `computeTeamScores()`:
  `{"teamId":"team_content-quality","slug":"content-quality","name":"고품질 검수팀","organizationId":"org_sns-blog","score":83.8,"grade":"B","completion":87.5,"n":8,"maxN":61,"sample":"48h"}`.
- [관련 회귀]
  `Test Files 4 passed (4)`, `Tests 96 passed (96)`,
  `Duration 1.29s`.
- [타입체크] `./node_modules/.bin/tsc --noEmit`:
  exit `0`, 출력 없음.
- [빌드] `./node_modules/.bin/tsc`:
  exit `0`, 출력 없음.
- [post-fix 관찰] 최초 fix 이후 protocol task `0`;
  migration 097 적용 뒤 범용 team-runner task `0`.
  이는 새 실패가 없다는 관찰이며 E2E 성공 증거로 올리지 않는다.
- [안전 불변식] 현재 DB:
  `teams.is_active=1`, `is_always_on=1`;
  `required_capabilities.is_active=1`, `is_always_on=1`, `protected=1`.
- [HTTP] `curl -sS --max-time 5 http://localhost:6200/health`:
  `curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server`.
- [NCO conductor] 읽기 전용 교차검토 요청:
  `user cancelled MCP tool call`.
- [Evidence Tier 1] 운영 DB 행, 파일 본문·SHA-256, 현행 코드·Git commit,
  테스트·compiler 명령 출력을 이번 task에서 직접 확인했다.

## 미검증·남은 항목

- fix 이후 실제 provider가 quoted protocol 응답을 반환하는 content-quality E2E
- 다음 scheduled `team-runner`에서 content-quality 제외 유지
- 게시 후보 원문을 포함한 `daily-blog-promo.sh` 전용 검수 PASS/FAIL
- discussion 단계의 근거 없는 정량 주장 자동 반려
- DB 업무보고 외 파일 산출물의 필수 계약
- `cycle=5/3` 또는 `improvement_failed`의 source reason
- NCO HTTP `localhost:6200` 본문: 연결 거부
- NCO conductor 교차검토: MCP 호출이 `user cancelled MCP tool call`로 종료
- 최신 rolling window에서 향후 score가 오를지 여부
