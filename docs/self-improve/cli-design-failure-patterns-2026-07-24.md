# CLI UI/UX 디자인팀 실패 패턴 — 개선 cycle 2/3

- 대상: `team_cli-design` (`cli-design`, CLI UI/UX 디자인팀)
- 기준 스냅샷: `team_lifecycle_events.tle_Ka6JnpUXkSxhQ1Y8`
- 기준 시각: 2026-07-24 03:50:00 UTC (2026-07-24 12:50:00 KST)
- HR 기록값: score `82.2`, completion `85.7%`, sample `48h/7`
- 근거 등급: T1 (`db/nco.db`의 lifecycle/task 원문을 read-only 조회)

## 결론 — surface & hold

정체 원인은 CLI 디자인 산출물 결함이나 text-only diff 오탐이 아니라,
`commander-perfgoal` 제어면 실패 1건이 팀 charter 품질 분모에 들어간 **표본
오염**이다. HR 당시 인프라 제외 조건으로 orphan 1건만 제외하면 7건 중 6건
완료로 정확히 `85.7%`가 재현된다.

현재 소스에는 `spawned_by_cli='commander-perfgoal'`을 팀 무관하게 제외하는
bounded 가드가 이미 존재한다(`src/core/team-scorer.ts:194-196`, 적용부
`:232`, `:238`, `:244`, `:250`, `:255`, `:260`; commit `1dfa39e`).
따라서 cycle 2/3에서는 추가 코드 수정·cli-design 전용 예외·가짜 diff를 만들지
않고 **surface & hold**한다. 팀 삭제·비활성화 또는 lifecycle 상태 변경도 하지
않는다. 다음 HR lifecycle 스냅샷의 실제 반영은 별도 확인 대상이다.

## 조회 방법과 한계

초안 작성 시점에는 `localhost:6200` 연결 거부였다. cycle 2 T1 재검증(2026-07-24
13:30 KST)에서는 `/api/health` 200, `/api/tasks/:id` 8건 교차확인, SQLite
read-only 재조회가 일치했다. `/api/tasks?limit=500`은 team_id 필터가 없어
팀별 목록은 ID별 GET 또는 SQL이 필요하다(`src/server/gateway.ts:1716-1741`,
`:1896-1902`).

48시간 창은 변하는 현재 시각이 아니라 HR 기록과 동일한
`2026-07-24 03:50:00 UTC`를 상한으로 고정했다. HR 재계산·운영 프로세스 reload는
이번 surface & hold 범위에서 수행하지 않았다.

## HR 48시간 task 증거

| task ID | 생성 시각(UTC) | agent | spawner | 상태 | 판정 |
|---|---|---|---|---|---|
| `task_WaoIC08g94ev6UI7` | 2026-07-24 00:00:53 | agy | work-report-scheduler | completed | 업무보고 완료; verifier build 통과 |
| `task_ZLvmT_y-FiPbTTj5` | 2026-07-23 15:01:49 | agy | team-runner | completed | text-only 상시임무 완료 |
| `task_UbgK8HFH0-cvvwtt` | 2026-07-23 11:52:59 | agy | commander-perfgoal | failed | `orphaned: server restart`; 기존 인프라 제외 |
| `task_dWW-eyL6sIl07j77` | 2026-07-23 11:33:20 | ollama | commander-perfgoal | failed | 미주입 목표값에 대한 정직한 거부; HR 분모 오염 |
| `task__yrkxBrm5qs1AQ6W` | 2026-07-23 05:01:02 | agy | work-report-scheduler | completed | 업무보고 완료; verifier build 통과 |
| `task_gza0z01f3XEmLJGO` | 2026-07-23 00:00:45 | agy | work-report-scheduler | completed | 업무보고 완료; verifier build 통과 |
| `task_-iJZ5wvysxCwCc98` | 2026-07-22 15:02:45 | agy | team-runner | completed | text-only 상시임무 완료 |
| `task_Kai5XNVISSPIBARG` | 2026-07-22 05:00:53 | codex | work-report-scheduler | completed | 업무보고 완료; verifier build 통과 |

재집계:

| 집계 규칙 | terminal | completed | completion |
|---|---:|---:|---:|
| raw task 행 | 8 | 6 | 75.0% |
| HR 당시 조건: orphan 제외 | 7 | 6 | 85.7% |
| 현재 scorer 조건: orphan + commander-perfgoal 제외 | 6 | 6 | 100.0% |

마지막 행은 고정 DB 표본에 현재 조건을 적용한 **counterfactual**이며, HR에
저장된 운영 score가 회복됐다는 주장이 아니다.

## 에이전트별 성공·실패 패턴

| agent | raw terminal/completed | HR 집계 terminal/completed | 현재 조건 terminal/completed | 증거 기반 해석 |
|---|---:|---:|---:|---|
| agy | 6/5 | 5/5 | 5/5 | 업무보고 3건과 text-only 2건 완료. 실패 1건은 응답 없는 restart orphan이라 charter 품질 실패가 아님 |
| codex | 1/1 | 1/1 | 1/1 | 업무보고 파일·build 영수증을 제출. 표본 1건이므로 일반화 금지 |
| ollama | 1/0 | 1/0 | 0/0 | `targetValue`, `direction`, reflection, improvement가 주입되지 않았다고 거부한 perf-goal 관리 task. CLI 디자인 수행 능력의 실패 증거가 아님 |

성공 패턴은 실데이터가 주입된 업무보고와 text-only 분석에서
`done:` 응답 및 확인 불가 항목을 명시한 것이다. 유일한 HR 분모 실패는 CLI
UI/UX 작업이 아니라, 필수 목표 수치가 없는 상태에서 실제 HTTP write를 요구한
관리 task였다.

## 반복 감점 요인 판정

### 1. FORMAT_MISMATCH

- 기준 48시간 raw 8행에서 `qualityRejected` 또는 `FORMAT_MISMATCH`는 **0건**이다.
- 전체 이력에는 과거 2건이 있다:
  - `task_KqTC-pUQRGLL0ixL` — 2026-07-13 15:01:38 UTC, retired-local-provider,
    completed, `qualityHeuristics=["FORMAT_MISMATCH"]`
  - `task_wncrR9LzcCMxB3Ut` — 2026-07-15 15:01:17 UTC, ollama,
    completed, `qualityHeuristics=["FORMAT_MISMATCH"]`
- 두 행은 HR 고정 창 밖이고 상태도 completed다. 따라서 이번 `85.7%`의 원인으로
  연결할 수 없다.

판정: 과거 형식 불일치의 재발 가능성은 남지만, 현재 감점의 직접 원인은 아니다.
FORMAT 게이트 우회나 text-only 팀 전면 면제를 추가할 근거가 없다.

### 2. text-only 산출물의 완료율 오탐

`task_-iJZ5wvysxCwCc98`와 `task_ZLvmT_y-FiPbTTj5`는 prompt가 명시적으로
“텍스트만 응답, 도구/커맨드 사용 금지”인 상시임무이고 둘 다 completed다.
diff가 없다는 이유로 실패 처리된 행은 기준 표본에 없다.

판정: text-only/diff-ratio 오탐 가설은 이 표본에서 기각한다.

### 3. orphan/lease_expired 오분류

`task_UbgK8HFH0-cvvwtt`는 restart orphan이며 HR 당시 scorer에서도 이미 제외돼
`48h/7`의 분모에 들어가지 않았다. 기준 표본에는 `lease_expired`가 없다.

판정: 이번 정체의 잔여 원인이 아니다.

### 4. 제어면 task 혼입

`task_dWW-eyL6sIl07j77`의 prompt는 CLI UI/UX 산출물이 아니라 `/api/goals`와
`/api/performance/reports` write를 요구한다. 구체 목표값이 없는 상태에서
ollama는 값을 꾸며내지 않고 `error:`로 거부했고, 이 행이 기존 분모에 남았다.

판정: 이번 정체의 직접 근본원인이다. 현재 generic
`CONTROL_PLANE_PERFGOAL_EXCLUSION`이 정확한 bounded 대응이며 추가 team-specific
패치는 불필요하다.

## 근본원인 가설 평가

| 가설 | 판정 | T1 근거 |
|---|---|---|
| 실제 CLI 디자인 미제출이 1건 있다 | 기각 | 포함된 charter/work-report 6건 모두 completed |
| text-only 결과가 diff 부재로 실패했다 | 기각 | text-only 2건 모두 completed |
| FORMAT_MISMATCH가 85.7%를 만들었다 | 기각 | 고정 48시간 표본 0건 |
| 인프라 orphan이 계속 감점됐다 | 기각 | orphan 제외 후 HR의 7/6이 재현됨 |
| perf-goal 제어면 실패가 charter 분모를 오염했다 | 채택 | 해당 행 제외 시 동일 표본 6/6 |

## Mem0·에이전트 지식 베이스 연동

cycle 2 T1 재검증에서 `POST /api/mem0/self-learning/add`로 5건 저장 후
`GET /api/mem0/self-learning?userId=team_cli-design` 및 search로 확인했다.

| Mem0 ID | 요약 |
|---|---|
| `mem0-1784867411714-v75rzn` | perfgoal 제어면 vs charter 분리; `task_dWW-eyL6sIl07j77` 정직 거부 |
| `mem0-1784867426098-00zyn7` | text-only team-runner 완료 2건 diff 부재로 실패 추정 금지 |
| `mem0-1784867430856-6v09n8` | 고정 48h FORMAT_MISMATCH 0건; 창 밖 사건 연결 금지 |
| `mem0-1784867430857-210oum` | counterfactual 6/6 vs 저장 lifecycle 구분 |
| `mem0-1784867430985-yk6t3k` | orphan perfgoal `task_UbgK8HFH0-cvvwtt`는 infra 제외 |

- agent/user: `self-learning` / `team_cli-design`
- search: `POST /api/mem0/self-learning/search` query
  `cli-design perfgoal contamination commander-perfgoal` → mode `semantic`, 2건 매칭
  (BM25 폴백은 `NCO_MEM0_NO_EMBED=1` 환경에서만; 현재 런타임은 semantic 우선)

**Knowledge base (`kb_*`)**: cycle 2에서 `POST /api/learn/save`로 1건 저장·
`GET /api/learn/query`로 확인했다.

| KB ID | category | source task |
|---|---|---|
| `kb_cli_design_cycle2_20260724` | `bug_pattern` | `task_dWW-eyL6sIl07j77` |

요약: root cause = commander-perfgoal contamination; surface & hold;
`CONTROL_PLANE_PERFGOAL_EXCLUSION`(commit `1dfa39e`); FORMAT_MISMATCH·text-only
오탐 아님.

## 검증 영수증

- [변경] `docs/self-improve/cli-design-failure-patterns-2026-07-24.md` 작성·Mem0/KB 증거 보강
- [DB] lifecycle `tle_Ka6JnpUXkSxhQ1Y8`에서 score `82.2`,
  completion `85.7`, n `7`, sample `48h` 확인
- [DB] 고정 48시간 raw/HR/current 조건 재계산:
  `8/6/75.0%` → `7/6/85.7%` → `6/6/100.0%`
- [DB] agent별 HR 조건: agy `5/5`, codex `1/1`, ollama `0/1`
- [DB] 기준 표본 FORMAT_MISMATCH `0`; 과거 표본 밖 2건 확인
- [DB 무결성] `PRAGMA quick_check` → `ok`
- [소스/commit] scorer generic exclusion과 commit `1dfa39e` 원문 확인
- [타입체크] `npx tsc --noEmit` → exit 0, 오류 0
- [관련 테스트] `npx vitest run src/core/team-scorer.test.ts` →
  1 file, 4 tests passed, exit 0
- [build] `npm run build` → `tsc`, exit 0
- [등급] T1
- [Mem0] 5건 write·list·search 확인 (IDs 위 표)
- [KB] `kb_cli_design_cycle2_20260724` write·query 확인
- [API] `/api/health` 200; `/api/tasks/:id` 8건 SQL과 일치
- [미검증] 다음 HR lifecycle score 반영, 운영 프로세스 reload,
  BM25-only search(`NCO_MEM0_NO_EMBED=1`)
