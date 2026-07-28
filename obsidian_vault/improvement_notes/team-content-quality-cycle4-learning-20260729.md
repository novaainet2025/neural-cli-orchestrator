---
created_at: 2026-07-29T00:31:00+09:00
team_id: team_content-quality
team_slug: content-quality
cycle: 4
evidence_window: 48h
evidence_snapshot_utc: 2026-07-28T15:20:00Z
evidence_tier: T1
tags:
  - improvement
  - content-quality
  - self-learning
  - evidence-audit
  - FORMAT_MISMATCH
---

# 고품질 검수팀 Cycle 4 — 최근 48시간 8건 근거 감사

## 결론

HR 스냅샷 `tle_J-rXGkS3YNuxiu-1`의 `score=83.8`,
`completion=87.5`, `sample=48h/8`, `maxN=60`은 운영 DB에서 직접
확인했다. 같은 스냅샷을 구성하는 terminal task는 완료 7건·실패 1건이다.

현재 완료율을 낮춘 행은 `task_JjX-85_K_1H7WuEC` 한 건뿐이다. 이 행은
요청된 문장을 의미상 정확히 반환했지만 provider가 전체 응답을 JSON 문자열로
직렬화해 `"done: workflow implementation gate passed"`로 저장했고,
품질 게이트가 `FORMAT_MISMATCH`로 오반려한 사례다. 동일 workflow의 평문 재시도
`task_VZ3TWJjdlYpZ73Ab`는 완료됐다.

반면 원문 없는 일반 팀 러너 호출 `task_m5Vd83hUpjLpoTEv`는 내용상
`FAIL(보류)`였지만 task 상태는 `completed`다. 따라서 이 행은 콘텐츠 검수 누락
증거이지만, 이번 87.5%의 감점 행은 아니다. 기존 Cycle 3 노트가 원문 미주입
태스크를 점수 하락과 직접 연결한 부분은 이번 HR 스냅샷에는 적용되지 않는다.

새 소스 수정은 만들지 않는다. 두 관찰 원인의 bounded fix가 이미 존재하며 현재
파일·DB에서 확인됐기 때문이다.

- JSON 문자열 protocol 오반려: commit `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`
- 원문 없는 범용 러너 호출: migration
  `db/migrations/097_content_quality_dedicated_runner.sql`
  (commit `97e1237`, 운영 DB 적용 시각 `2026-07-28 14:59:10` UTC)

## 지표 근거

### HR 원본 행

근거 위치:

- `db/nco.db`
- `team_lifecycle_events.id='tle_J-rXGkS3YNuxiu-1'`
- 같은 시각 directive:
  `team_lifecycle_events.id='tle_F7MA-F87_xz2Sgwy'`

확인값:

| 항목 | 값 |
|---|---:|
| score | 83.8 |
| completion | 87.5% |
| sample | 48h |
| n | 8 |
| maxN | 60 |
| snapshot UTC | 2026-07-28 15:20:00 |

현재 스코어러 공식은
`round1(0.9 × completion + 0.1 × 100 × log10(n) / log10(maxN))`이다.
스냅샷 값 `completed=7`, `terminal=8`, `maxN=60`을 대입하면
`completion=87.5`, `volume=50.78814227963442`, `score=83.8`이다.
따라서 83.8·87.5%는 단순 제공값이 아니라 이번 감사에서 재계산 가능한 DB
스냅샷 값이다.

### 점수 하락 해석

`team_lifecycle_events`의 연속 스냅샷은 다음과 같다.

| UTC | n | completion | score |
|---|---:|---:|---:|
| 2026-07-28 14:10 | 12 | 91.7% | 88.6 |
| 2026-07-28 14:50 | 9 | 88.9% | 85.4 |
| 2026-07-28 15:20 | 8 | 87.5% | 83.8 |

이 구간에 `team_content-quality`의 새 실패 task는 없다. 기존 단일 실패가
남은 상태에서 더 오래된 완료 행이 48시간 창 밖으로 빠져 n과 완료 분자가 함께
줄어든 것이 확인된 변화다. 향후 점수나 회복 시점은 새 task 유입과 전사 `maxN`
변화에 따라 달라지므로 예측하지 않는다.

## 표본 8건

DB timestamp는 UTC다. 모든 task 원문 근거는
`db/nco.db`의 `tasks.id=<task ID>` 행이다.

| # | task ID / 상태 | 근거 위치 | 확인된 관찰 | 원인 후보·판정 | 재검증 방법 |
|---:|---|---|---|---|---|
| 1 | `task_v7oxdG9P6olVcdAC` / completed | `tasks`; `work_reports.id='wr_3n-Yy1czY76vlPgJ'`; `REPORTS/2026-07-27-고품질-검수팀-오전.md` | 오전 업무보고가 DB `submitted`이고 파일도 존재한다. 보고서 자체가 당일 원문 부재와 신규 6축 채점 미수행을 명시한다. | 확인 사실: 보고 완료. 확인 사실: 콘텐츠 실검수는 수행되지 않음. | task·work_report의 `source_task_id`를 조인하고 파일 본문에서 `원문 미주입`·`6축 채점 결과: 없음`을 확인한다. |
| 2 | `task_TRiUFVnRT_oeVpAP` / completed | `tasks`; `work_reports.id='wr_FQfiwowsv6j0rNkO'`; `REPORTS/2026-07-27-고품질-검수팀-오후.md` | 오후 업무보고가 DB `submitted`이고 파일도 존재한다. 오전과 동일하게 원문 없는 보류 상태를 재보고한다. | 확인 사실: 보고 완료. 원인 후보가 아니라 반복 관찰이며, 새 콘텐츠 verdict는 없다. | DB `body_md`와 파일 본문을 대조하고 당일 content artifact ID가 있는지 별도 조회한다. |
| 3 | `task_m5Vd83hUpjLpoTEv` / completed | `tasks`; `data/team-runner/team_content-quality-2026-07-28.md` | `spawned_by_cli='team-runner'`. 게시 후보 원문·URL·제목 없이 호출되어 `채점 불가 → FAIL(보류)`를 반환했다. task 상태는 completed다. | 확인 사실: 입력 누락. 확인 사실: 이번 completion 감점 원인은 아님. 근본 원인: 이벤트 기반 게이트가 범용 일일 러너에 포함됐음. | `tasks.prompt`에 검수 원문이 없는지 확인하고, migration 097 적용 뒤 같은 spawner의 신규 행이 생기는지 확인한다. |
| 4 | `task_eNx6XUOZiVTe1QZ_` / completed | `tasks`; `work_reports.id='wr_dfMcFqeUewgIhvOe'` | 오전 보고는 DB `body_md`로 제출됐지만 `REPORTS/2026-07-28-고품질-검수팀-오전.md` 파일은 없다. 응답도 “파일 변경 없음”이라고 명시한다. | 확인 사실: DB 보고 전달은 완료. 확인 사실: 파일 산출물은 없음. 파일이 필수였다는 근거는 없어 task 실패로 재분류하지 않는다. | `work_reports.status/body_md/source_task_id`를 확인하고 저장소 파일 존재 여부를 각각 검사한다. |
| 5 | `task_XLZde35QdjqlOXfp` / completed | `tasks`; `work_reports.id='wr_vRaO0vWg3CWSIWOF'`; `REPORTS/2026-07-28-고품질-검수팀-오후.md` | 오후 보고가 DB `submitted`이고 파일도 존재한다. 오전 파일 부재와 당일 6축 실점수 부재를 명시한다. | 확인 사실: 보고 완료. 확인 사실: 콘텐츠 실검수 증거는 없음. | DB body와 파일의 변경 목록·미검증 항목을 대조한다. |
| 6 | `task_qrxIUr3BQAgn8Ojy` / completed | `tasks.response`; `metadata_json.workflowStage='discussion'` | 응답이 근거 없이 `강제 효과 80% 향상 예상`을 주장했다. verifier와 evidence_json은 없다. | 확인 사실: 수치 근거 없음. 원인 후보: discussion 단계에 protocol 형식 이외의 주장 근거 검증이 없음. | 같은 prompt에 증거 계약을 적용해 수치·출처 없는 향상률을 반려하는지 별도 회귀 테스트한다. 현재는 미구현·미검증이다. |
| 7 | `task_JjX-85_K_1H7WuEC` / failed | `tasks.response/error`; `verifier_result_json` | 응답은 `"done: workflow implementation gate passed"`이고 build verifier는 `exitCode=0`, `passed=true`지만 `quality_rejected: FORMAT_MISMATCH`로 실패했다. | 확인된 근본 원인: 전체 JSON 문자열 wrapper를 protocol 판정 전에 해제하지 않던 경계 결함. | `tests/response-quality.test.ts`에서 JSON 문자열 protocol·malformed JSON 회귀를 실행한다. |
| 8 | `task_VZ3TWJjdlYpZ73Ab` / completed | `tasks.response`; 동일 `workflowRunId='wfr_MBseWr_vOB55BRRZ'`; `verifier_result_json` | 평문 `done: workflow implementation gate passed` 재시도는 완료됐고 build verifier도 `exitCode=0`, `passed=true`다. | 확인 사실: #7과 의미가 같고 표현 wrapper만 다르다. 확인된 재작업 1회. | #7·#8의 decoded response와 workflowRunId를 대조하고 response-quality 회귀 테스트를 실행한다. |

## 패턴 분류

### 확인 사실

1. 표본 구성은 업무보고 4건, workflow gate 3건, 범용 team-runner 1건이다.
2. 실제 게시 후보 원문을 받은 6축 콘텐츠 검수 task는 표본에 0건이다.
3. task 상태 기준 미완료는 `task_JjX-85_K_1H7WuEC` 1건이다.
4. 재작업은 동일 workflow에서 JSON 문자열 응답 실패 후 평문 재시도 1회다.
5. 콘텐츠 검수 누락은 원문 없는 `task_m5Vd83hUpjLpoTEv`에서 확인되지만,
   해당 task는 실행 자체를 완료해 completion 분자에 포함됐다.
6. `task_qrxIUr3BQAgn8Ojy`의 `80%`는 근거가 없는데도 completed 처리됐다.
7. task completion과 콘텐츠 PASS/FAIL은 서로 다른 축이다.

### 추정·미확인

1. score 83.8이 실제 블로그 콘텐츠 품질 저하를 뜻한다는 해석은 확인되지 않았다.
   표본에 실제 콘텐츠 검수 task가 없기 때문이다.
2. discussion 단계의 의미 검증기가 있었다면 `80%` 주장을 막았을 가능성은 있으나,
   회귀 테스트가 없어 아직 후보 원인이다.
3. migration 097이 다음 범용 스케줄 주기에서도 신규 무원문 호출을 막는지는
   아직 미확인이다. 적용 뒤 현재 조회 시점까지 신규 `team-runner` 행은 0건이지만,
   다음 일일 실행을 관찰하지 않았다.
4. rolling window의 향후 score는 새 표본과 전사 maxN에 의존하므로 예측하지 않는다.

## Bounded·reversible fix 상태

### 1. JSON 문자열 protocol 오반려

현재 파일 `src/verification/response-quality.ts`의 `protocolCandidate()`는 응답
전체가 유효한 JSON string 하나일 때만 prefix 판정용 값을 decode한다. 저장 원문과
다른 휴리스틱은 변경하지 않는다. malformed JSON과 protocol prefix 없는 JSON
string은 계속 반려한다.

롤백 단위는 commit `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`의
`protocolCandidate()` 및 두 판정부 변경과 해당 테스트 두 건이다.

### 2. 원문 없는 범용 러너 호출

migration 097은 `teams`와 `required_capabilities`의
`team_content-quality` charter에만 `@전담러너 `를 멱등 추가한다.
`scripts/team-runner.sh`는 해당 접두사 팀을 범용 sweep에서 제외한다.

운영 DB 확인값:

- `schema_migrations.applied_at='2026-07-28 14:59:10'`
- 두 charter 모두 `@전담러너 `로 시작
- `teams.is_active=1`
- `required_capabilities.is_active=1`, `protected=1`
- migration 적용 뒤 `spawned_by_cli='team-runner'` 신규 행: 0

migration 파일 주석과 회귀 테스트에 접두사만 제거하는 scoped rollback이 있다.
팀 삭제·비활성화·retirement·lifecycle status 변경은 수행하지 않았다.

### 이번 Cycle 4 변경 판단

신규 운영 코드·DB 수정은 0이다. 같은 원인에 중복 패치를 만들거나 과거 실패 task를
성공으로 재작성하면 원본 이력을 훼손하고 지표를 인위적으로 바꾸므로 수행하지 않는다.
이번 변경은 이 감사 노트 한 파일뿐이며 파일 삭제로 되돌릴 수 있다.

## Mem0·지식 베이스 갱신안

### Mem0

신규 삽입은 제안하지 않는다. 아래 기존 장기기억이 이번 표본의 재사용 가능한 교훈을
이미 포함한다.

- `mem0_memories.id='mem0-1785249560319-20adab'`
  - 원문 미주입 시 점수를 만들지 않고 보류
  - task 상태와 콘텐츠 verdict를 혼동하지 않음
  - `task_qrx...`의 근거 없는 80% 예측을 사실로 재사용하지 않음
- `mem0_entries.id='mem0-1785242779311-najnyw'`
  - JSON 문자열 protocol wrapper의 정확한 허용 경계

시점 의존 값인 83.8·87.5%·n=8은 장기 규칙이 아니므로 Mem0에 중복 저장하지 않는다.

### knowledge_base

현재 `knowledge_base`에는 JSON 문자열 protocol 결함
`kb-team-content-quality-json-protocol-cycle2-20260728`만 있고,
이벤트 기반 검수 입력 계약은 별도 항목으로 확인되지 않았다. 다음 갱신 때 아래
단일 항목을 후보로 사용한다.

- 제안 category: `convention`
- 제안 source task: `task_m5Vd83hUpjLpoTEv`
- 제안 content:
  - 이벤트 기반 콘텐츠 검수기는 대상 원문·식별자·출처 메타데이터가 있을 때만 호출한다.
  - 입력이 없으면 점수 0이나 콘텐츠 FAIL을 만들지 말고 `status: blocked`와 필요한
    수집 항목을 반환한다.
  - 범용 team-runner에서는 `@전담러너` 팀을 제외하되 팀 활성·보호·HR lifecycle
    상태는 변경하지 않는다.
  - task execution status와 콘텐츠 verdict를 별도 필드·지표로 해석한다.

DB 쓰기는 이번 하위작업 범위에 포함하지 않았다. NCO HTTP도
`localhost:6200` 연결 거부 상태라 API 기반 갱신·조회는 미검증이다.

## 재검증 명령

```bash
# HR 스냅샷
sqlite3 -readonly db/nco.db \
  "SELECT id,score,metadata_json,created_at
   FROM team_lifecycle_events
   WHERE id='tle_J-rXGkS3YNuxiu-1';"

# 표본 8건 상태
sqlite3 -readonly db/nco.db \
  "SELECT id,status,error,spawned_by_cli,created_at
   FROM tasks
   WHERE id IN (
     'task_v7oxdG9P6olVcdAC','task_TRiUFVnRT_oeVpAP',
     'task_m5Vd83hUpjLpoTEv','task_eNx6XUOZiVTe1QZ_',
     'task_XLZde35QdjqlOXfp','task_qrxIUr3BQAgn8Ojy',
     'task_JjX-85_K_1H7WuEC','task_VZ3TWJjdlYpZ73Ab'
   )
   ORDER BY datetime(created_at);"

# 전담 러너 fix와 lifecycle 불변식
sqlite3 -readonly db/nco.db \
  "SELECT id,substr(charter,1,20),is_active
   FROM teams WHERE id='team_content-quality';
   SELECT id,substr(charter,1,20),protected,is_active
   FROM required_capabilities WHERE id='team_content-quality';"

# 관련 회귀
npx vitest run tests/response-quality.test.ts \
  src/storage/content-quality-dedicated-runner-migration.test.ts
npx tsc --noEmit
npx tsc
```

## 검증 영수증

- [변경] `obsidian_vault/improvement_notes/team-content-quality-cycle4-learning-20260729.md`
  한 파일 신규 작성. 운영 코드·DB·팀 lifecycle 변경 없음.
- [DB] compiled `computeTeamScores()` 직접 실행:
  `{"teamId":"team_content-quality","slug":"content-quality","name":"고품질 검수팀","organizationId":"org_sns-blog","score":83.8,"grade":"B","completion":87.5,"n":8,"maxN":60,"sample":"48h"}`.
- [테스트]
  `./node_modules/.bin/vitest run tests/response-quality.test.ts src/storage/content-quality-dedicated-runner-migration.test.ts`
  → `Test Files 2 passed (2)`, `Tests 18 passed (18)`.
- [타입체크] `./node_modules/.bin/tsc --noEmit` → exit 0.
- [빌드] `./node_modules/.bin/tsc` → exit 0.
- [빌드 wrapper 교차검증]
  `node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- ./node_modules/.bin/tsc`
  → exit 0.
- [표준 delivery gate]
  `run-delivery-gate.sh --full` → exit 4, `PASS=0 FAIL=4 SKIP=0`.
  worktree가 `ahead-not-integrated`라 inspection이 FAIL했고,
  `npm run typecheck`, `npm run test`, `npm run build`는 모두 tsx CLI IPC
  `listen EPERM`으로 실패했다. 위 직접 compiler/test 실행으로 코드 결과와 wrapper
  실행환경 실패를 구분했다.
- [NCO HTTP] `curl http://127.0.0.1:6200/api/health` 및 `/api/agents`
  → `curl: (7) Failed to connect to 127.0.0.1 port 6200`.
- [등급] T1 — 운영 DB 행, 파일 본문, Git commit diff, 명령 출력을 이번 작업에서
  직접 확인했다.
- [Gap] 관련 회귀 18/18, 직접 타입체크·빌드는 통과. package-script wrapper 0/3과
  NCO HTTP 0/2는 실행환경 차단으로 미통과다.

## 미검증·남은 항목

- 다음 scheduled `team-runner` 실행에서 content-quality 제외가 유지되는지
- 실제 게시 후보 원문을 포함한 dedicated runner E2E PASS/FAIL
- discussion 단계의 근거 없는 정량 주장 자동 반려
- NCO HTTP `:6200` health·agents 본문
- Mem0·knowledge_base 실제 쓰기(이번 산출물은 갱신안만 작성)
