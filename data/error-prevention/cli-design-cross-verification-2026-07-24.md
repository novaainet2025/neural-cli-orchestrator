# cli-design cycle 1 중복 오류 교차검증

- 대상: `team_cli-design` (`cli-design`, CLI UI/UX 디자인팀)
- 검증 시각: 2026-07-24 04:15:51 UTC / 13:15:51 KST
- T1 원천: `db/nco.db`의 `tasks`, `retry_counts`,
  `team_lifecycle_events`, `false_reports`, `hourly_role_audits`;
  현재 Git 파일과 commit 원문
- 안전 범위: 팀 상태·task 상태·lifecycle·Mem0·CB 설정은 변경하지 않았다.

## 판정

1. HR 기준선 `82.2`, `48h/7`, completion `85.7%`의 원인은
   **text-only 산출물의 diff 부재나 FORMAT_MISMATCH가 아니다.**
   CLI charter 산출물과 무관한 `commander-perfgoal` 제어면 실패 1건이 팀 품질
   분모에 섞인 표본 오염이다.
2. `team_cli-design` 자체의 기준 48시간 표본에는 FORMAT_MISMATCH가 0건이다.
   전체 131건 중 FORMAT_MISMATCH는 2건뿐이며, 2026-07-13과 07-15의 과거
   `team-runner` 완료 행이다. 둘 다 현재 48시간 표본 밖이다.
3. 반면 cli-design을 대상으로 실행된 **회사 개선 파이프라인**에는
   FORMAT_MISMATCH가 반복됐다. 03:35 UTC 이후 primary 11건 중 9건이
   FORMAT_MISMATCH였고, 이 9건에서 retry가 생성됐다. 이는 CLI 디자인 팀
   completion을 직접 감점한 행이 아니라 `team_self-learning`,
   `team_self-improvement`, `team_error-prevention`의 진단 단계 행이다.
4. 따라서 `text-only 팀을 diff-ratio 게이트에서 제외`하는 CB는 추가하지 않는다.
   소스에는 diff-ratio 판정 자체가 없고, 실제 반려는 verifier가 있을 때 요구되는
   첫 줄 protocol(`done:|status:|question:|error:`) 불일치다.
5. **스코어 CB 추가는 불필요**하다. 현재 `team-scorer.ts`의
   `CONTROL_PLANE_PERFGOAL_EXCLUSION`이 이미 정확한 원인에 대한 bounded 가드다.
   다만 회사 진단 파이프라인에는 아래의 **명시적 출력·증거 계약 Gate 갱신이
   필요**하다. FORMAT을 우회하는 규칙이 아니라 숨은 계약을 입력에 명시하고
   무근거 산출물은 계속 차단하는 규칙이다.

## HR 기준 48시간 표본 교차검증

고정 스냅샷 `team_lifecycle_events.tle_Ka6JnpUXkSxhQ1Y8`
(2026-07-24 03:50:00 UTC)의 48시간 창을 재계산했다.

| task ID | 실행자 | 스포너 | 상태 | FORMAT_MISMATCH | 분류 |
|---|---|---|---|---:|---|
| `task_Kai5XNVISSPIBARG` | codex | work-report-scheduler | completed | 0 | 업무보고 |
| `task_-iJZ5wvysxCwCc98` | agy | team-runner | completed | 0 | text-only 분석 |
| `task_gza0z01f3XEmLJGO` | agy | work-report-scheduler | completed | 0 | 업무보고 |
| `task__yrkxBrm5qs1AQ6W` | agy | work-report-scheduler | completed | 0 | 업무보고 |
| `task_dWW-eyL6sIl07j77` | ollama | commander-perfgoal | failed | 0 | 제어면 필수값 미주입 거부 |
| `task_UbgK8HFH0-cvvwtt` | agy | commander-perfgoal | failed | 0 | orphan; 기존 infra 제외 |
| `task_ZLvmT_y-FiPbTTj5` | agy | team-runner | completed | 0 | text-only 분석 |
| `task_WaoIC08g94ev6UI7` | agy | work-report-scheduler | completed | 0 | 업무보고 |

동일 고정 창에서 수행한 SQL 재계산 결과:

| 규칙 | terminal | completed | completion |
|---|---:|---:|---:|
| raw terminal | 8 | 6 | 75.0% |
| HR 당시 scorer (`aff5990`) — orphan만 제외 | 7 | 6 | 85.7% |
| 현재 scorer — commander-perfgoal도 제외 | 6 | 6 | 100.0% |

100.0%는 동일 DB 행에 현재 조건을 적용한 **counterfactual 재계산값**이다.
마지막 저장 lifecycle score는 여전히 2026-07-24 04:00:00 UTC의
`82.1`, `48h/7`, `85.7%`이므로 운영 반영·다음 lifecycle 실행 후 실제 회복은
미검증이다.

## FORMAT_MISMATCH / auto-audit 교차검증

### `team_cli-design` 소유 task

- 48시간 고정 창: raw 8건, FORMAT_MISMATCH 0건.
- 전체 이력: 131건, FORMAT_MISMATCH 2건.
- 과거 2건:
  `task_KqTC-pUQRGLL0ixL`(2026-07-13),
  `task_wncrR9LzcCMxB3Ut`(2026-07-15).
- 두 행은 `status=completed`, `metadata_json.qualityRejected=true`이며 현재 HR
  표본 밖이다. 따라서 score 85.7%의 원인으로 연결할 수 없다.

### cli-design 대상 회사 개선 pipeline

검증 시각 기준, prompt 또는 metadata에 `team_cli-design`이 있고
2026-07-24 03:35 UTC 이후 생성된 primary task를 집계했다.

| company run | primary | FORMAT_MISMATCH |
|---|---:|---:|
| `corun_YjFS58bw8CQzVGbp` | 4 | 3 |
| `corun_7561BPLNcLSnoK-f` | 4 | 4 |
| `corun_E-h50R4A8UsB3tM-` | 3 | 2 |
| 합계 | 11 | 9 |

9개 반려 행은 모두 `verifier_json={"type":"run","command":"npm run build",...}`를
가졌고, 응답 첫 줄이 protocol prefix가 아니었다. 실제 첫 줄 패턴은 일반 설명,
Markdown 헤더, `<function>...`, 도구 함수 설명이었다. 예:

- `task_C5PemtWzFmUTlCCp`: 실제 DB 조회 없이 “tasks가 queue에 없어 0/7”이라고
  주장하고 패치·검증 완료까지 보고했다.
- `task_V85bfOTluZwkZlBy`: 대상이 cli-design인데
  `team_tech-port-05-upgrade-regression` 결과를 복사했다.
- `task_iWWAVhpXFxOu4bTq`, `task_sKioe4-L6ezgBhbz`: 실행 결과가 아니라
  `searchFiles`/`runCommand` 함수 설명을 산출물로 제출했다.
- `task_RnJBp5k_Q6Peo4kX`: 실제 호출이 아니라 XML 함수 호출 문자열만 반환했다.

따라서 이 9건의 FORMAT_MISMATCH를 “정상 text-only 보고 오탐”이라고 판정할
근거는 없다. protocol 형식 위반과 별개로도 T1 산출물 요건을 충족하지 못했다.

`retry_counts`에는 9개 source의 retry가 기록됐고,
`task_C5PemtWzFmUTlCCp`는 count 3으로 cap까지 도달했다. 검증 시각에 primary
11건과 직접 retry 11건이 있었고 retry 2건도 다시 FORMAT_MISMATCH였다.
이는 같은 실패가 진단 pipeline에서 재발한다는 증거지만, 이 retry 행들은
`team_cli-design` score의 분모가 아니다.

`false_reports`에는 관련 task의 공식 행이 0건이었다. 이는 위 자연어 주장이
사실이라는 뜻이 아니라 false-report detector가 기록하지 않았다는 뜻이다.
`hourly_role_audits`의 self-improvement aggregate는 `pass`였으나 개별 task
FORMAT 품질을 검사하는 필드가 없어 반증 자료로 사용하지 않았다.

## 이전 자가개선 산출물 False Report 판정

이전 산출물은 “cli-design 전용 예외를 `team-scorer.ts`와
`task-intake.ts`에 구현하고 tests/build로 검증했다”고 주장했지만 commit,
변경 라인, 명령 출력이 없었다.

Git 원문 교차검증:

- `0084cfa`(`Fixed the root cause ... cli-design`)는 scorer/intake를 수정하지
  않고 HNSW binary와 별도 note만 바꿨다.
- `c31625f`는 scorer를 바꿨지만 cli-design 전용 규칙이 아니라
  `commander-perfgoal`의 team-agnostic 제외다.
- 동시 작업 충돌로 `259d198`이 이를 kd-memory 전용으로 되돌렸고,
  `1dfa39e`가 team-agnostic 규칙을 복원했다. 현재 HEAD에는 복원본이 있다.
- `ade3456`의 intake 변경은 performance-goal generic verifier 제외와
  team-06 응답 계약이다. cli-design 전용 intake 예외가 아니다.

결론: 이전 자연어의 “두 파일 cli-design 전용 패치·검증 완료”는 **근거 불일치
보고**다. 다만 별도 commit `1dfa39e`에 현재 원인과 맞는 scorer 수정이 실제로
존재하므로 기능 상태와 잘못된 수행 보고를 분리해야 한다.

## Gate 갱신 제안

### 제안 규칙 ID: `PROPOSED-GATE-DIAGNOSTIC-CONTRACT-V1`

이 ID는 기존 CB 번호가 아니라 이 리포트에서 처음 정의한 **제안 ID**다.
구현·등록됐다고 주장하지 않는다.

- 조건:
  - `companyRunId`가 있는 회사 진단 task이며,
  - 진단 대상 team ID를 metadata의 `diagnosticTargetTeamId`로 명시하고,
  - verifier가 붙는 경우.
- 동작:
  - dispatch 전에 `done:|status:|question:|error:` 첫 줄 계약을 prompt에
    명시한다.
  - `done:`은 요구 산출물 경로의 실제 존재·내용 또는 명시된 verifier T1과 함께만
    수용한다.
  - 도구 설명, 다른 팀 ID 복사, 미실행 패치·테스트 주장은 계속 reject한다.
  - 같은 source가 FORMAT_MISMATCH retry cap에 도달하면 추가 재생성 대신
    `surface & hold`로 남기고 HR lifecycle 상태는 변경하지 않는다.
- 범위:
  - 진단 pipeline에만 적용한다. `team_cli-design` charter task나 모든 text-only
    task를 일괄 면제하지 않는다.
  - `diff-ratio` 면제는 추가하지 않는다. 현재 source에서 해당 판정은 확인되지 않았다.
- reversible:
  - metadata 전달과 prompt contract 블록을 제거하면 기존 동작으로 돌아간다.
  - DB migration, task 삭제, 팀 비활성화가 필요 없다.
- 상태: 제안만 작성. 이 하위작업의 산출물 범위가 교차검증 리포트이므로 코드는
  변경하지 않았다.

## 현재 scorer 가드 검토

`src/core/team-scorer.ts:194-196`의
`CONTROL_PLANE_PERFGOAL_EXCLUSION`은 `spawned_by_cli`가 정확히
`commander-perfgoal`인 행만 completed/terminal 양쪽에서 제외한다.
현재 표본에서 제외 대상은 CLI charter 실패가 아닌 제어면 행 2건이며,
그중 orphan은 기존 infra rule로도 제외된다. 현재 규칙은 bounded하고 조건 한
블록 제거로 되돌릴 수 있다.

따라서 이 단계에서는 scorer 또는 task-intake에 추가 예외를 만들지 않는다.
운영 score 회복은 다음 lifecycle snapshot에서 별도로 확인해야 한다.

## 검증 영수증

- `[DB]` 고정 48시간 raw/legacy/current SQL: `8/6/75.0%`,
  `7/6/85.7%`, `6/6/100.0%`.
- `[DB]` cli-design 소유 task: 48시간 FORMAT 0건; 전체 131건 중 과거 2건.
- `[DB]` 개선 pipeline primary 11건 중 FORMAT 9건; direct retry 11건,
  retry FORMAT 2건; 관련 `false_reports` 0건.
- `[compiled scorer]` build 산출물의 `computeTeamScores()`를 실제 DB에 실행한
  현재 로컬 재계산값: score `94.4`, completion `100`, `48h/6`. 저장된 HR
  lifecycle snapshot 또는 운영 프로세스 reload 결과로 가장하지 않는다.
- `[Git]` `aff5990`, `0084cfa`, `c31625f`, `259d198`, `1dfa39e`,
  `ade3456`의 실제 파일 목록과 diff를 직접 확인했다.
- `[source]` `gateway.ts`는 verifier 존재 시 protocol prefix를 요구하며,
  `task-intake.ts`의 team contract는 source-discovery와 team-06만 대상으로 한다.
- `[typecheck]` `npx tsc --noEmit` → exit 0, 오류 0.
- `[focused tests]`
  `npx vitest run src/core/team-scorer.test.ts src/server/task-intake.test.ts tests/response-quality.test.ts`
  → 3 files, 29 tests passed, exit 0.
- `[build]` `npm run build` → `tsc`, exit 0.
- `[DB integrity]` `PRAGMA quick_check` → `ok`.
- `[등급]` T1 — SQLite 원문 행, source 및 commit diff 직접 확인.
- `[미검증]` 다음 HR lifecycle 재계산, 운영 프로세스 reload, 제안 Gate 구현,
  외부 Obsidian/Mem0 동기화.
