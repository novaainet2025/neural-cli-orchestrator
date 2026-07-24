---
created_at: 2026-07-24T12:24:43+09:00
updated_at: 2026-07-24T12:27:52+09:00
verified_at: 2026-07-24
tags:
  - improvement-note
  - category/team-quality
  - team/kd-memory
  - nco/mem0
  - nco/knowledge-base
  - evidence/T1
  - cycle/2
---

# kd-memory agent history and memory hygiene — cycle 2

## Scope and safety

- 대상 지시 기준선:
  `team_kd-memory`, score `3.1`, completion `0%`, sample `48h/3`,
  improvement cycle `2/3` (`team_lifecycle_events.tle_PAfluMTwLvj28M7w`).
- 관측 시각: 2026-07-24 12:24:43 KST. T1 원천은 `db/nco.db`의
  `tasks`, `teams`, `team_members`, `team_lifecycle_events`,
  `team_lifecycle_profiles`, `improvement_notes`, `knowledge_base`,
  `mem0_entries`와 현재 저장소 소스다.
- `team_members`에는 대상 팀 행이 0건이다. 아래 에이전트는 팀 구성원이라고
  추정하지 않고, 대상 팀 또는 개선 파이프라인 task의 실제 `assigned_to`로만
  분류한다.
- 관측 도중 cycle 3 종료 뒤 HR lifecycle이 2026-07-24 03:20:01 UTC에
  `retired`, 팀 행이 `is_active=0`으로 바뀌었다. 이는 cycle 2 지시 이후의 별도
  HR 이벤트이며 이번 작업의 성공 증거가 아니다. 이 작업은 팀 활성·retirement·
  task status·score를 변경하지 않는다.
- 외부 원본 vault `/Users/nova-ai/obsidian/mac-obsidian`는 쓰기 허용 범위 밖이다.
  이 파일은 저장소의 Obsidian 미러에 둔 동기화 대기 노트다.

## Ground-truth task history

### Team-owned sample

대상 팀 소유 task는 아래 3건뿐이다. 모두
`spawned_by_cli='commander-perfgoal'`인 목표·성과보고 제어면 작업이며 실제
지식·메모리 감사 산출물 task는 0건이다.

| Agent | Task | Raw status | Verified outcome | Classification |
|---|---|---|---|---|
| hermes | `task_pKVM8hAZUmzskqwL` | failed | `localhost:6200` 연결 거부, POST 미수행 | NCO gateway 인프라 실패 |
| ollama | `task_WpB7UCfWLhPnwx-u` | failed | `targetValue`, `direction`, `reflection`, `improvement` 미주입을 밝히고 값 날조를 거부 | 입력 계약 실패; honesty-positive |
| nvidia → ollama | `task_tnhlWTnnJz5dVshv` | lease_expired | nvidia empty completion 뒤 ollama 재배정, response 없음 | provider/lease 실패 |

따라서 저장된 completion `0%`는 감사 품질 실패율이 아니다. 제어면 태스크 3건을
감사팀 표본으로 센 집계 오염이며, 실제 감사 표본은 아직 없다.

### Improvement-pipeline history

같은 48시간에서 `team_kd-memory`를 직접 대상으로 삼은 company-orchestrator
task를 에이전트별로 다시 집계했다. `completed`는 raw DB 상태이며 품질 성공과
동의어가 아니다.

| Agent | Observed rows | Quality/evidence pattern | Learning classification |
|---|---:|---|---|
| nvidia | raw completed 7 | 7/7 `qualityRejected=true`, 7/7 `evidence_json` 없음, 보수적 함수·도구 서술 5건 | 성공 지식에서 제외 |
| ollama | completed 2, failed-like 2 | completed 2/2 `FORMAT_MISMATCH`, 증거 없음; 한 실패는 미주입 값을 정직하게 거부 | 정직한 미완료와 성공을 분리 |
| hermes | failed 2 | gateway 연결 실패 1, corrective retry CLI/tool 실패 1 | 인프라/도구 실패 |
| codex | 비종결 6 | 관측 시 assigned/queued/running이며 response 없음 | 성공·실패 판정 보류 |
| claude-code | 비종결 2 | 관측 시 running이며 response 없음 | 성공·실패 판정 보류 |

대표 의미 실패:

- cycle 1의 `task_Ib_OXeghqnF-8ILj`, `task_GMvAkdBBv9yRXe2t`,
  `task_SqNegYtal_5CP6By`는 검색 계획이나 함수 설명만 반환했다.
- cycle 2의 `task_V506fZlJHgiWQPJA`와 `task_3mK8FVZufG_a9yUk`는
  `docs/obsidian-improvement-no` 편집 호출 JSON을 응답으로 내보냈고,
  실제 task/agent 분석·Mem0 검증 영수증이 없었다. 두 응답은 길이도 각각
  8,547자로 같고 모두 `FORMAT_MISMATCH`로 반려됐다.
- cycle 3의 nvidia 응답들은 `"Obsidian Note"` placeholder 생성 설명을
  반복했다. 저장소에 생긴 동명 파일은 21바이트의
  `Obsidian Note content`뿐이라 개선 노트가 아니다.
- 위 raw-completed 응답 전부에 `evidence_json`이 없으므로 성공 샘플로 장기
  기억에 승격하면 안 된다.

검증 가능한 긍정 패턴도 분리한다. cron 진단
`task_HyykBW2mcTY6p7q2`의 2026-07-23 09:00 UTC 스냅샷은 당시 팀 task가
0건임을 확인하고, 무표본 팀이 자동 저성과 진단 대상으로 들어가지 않도록
`runTeamScoreDiagnostics`에 `team.n > 0` 가드를 남겼다. 현재 소스와 회귀
테스트로 이 bounded fix를 재확인할 수 있다. 다만 그 응답의 “task 0건”은
그 시각 이후 생성된 3건 때문에 현재 사실로 일반화할 수 없다.

## Root cause

1. **표본 의미 혼합**: 목표·성과보고 제어면 3건을 감사 산출물 품질 표본으로
   집계했다.
2. **raw status와 의미 성공 혼합**: company pipeline은 `completed` 응답이
   `FORMAT_MISMATCH`·무증거·도구 설명이어도 다음 단계와 자동 Mem0에 남겼다.
3. **시간 범위 없는 지식**: 기존 knowledge-base 2건은 7월 23일 09:00의
   “task 0건” 관측을 현재형으로 저장했다. 현재 `used_count=0`이라 재사용 증거는
   없지만, 검색 시 시간축을 잃을 위험이 있다.
4. **구성원 부재**: 대상 팀의 `team_members` 0건이어서 “팀 에이전트별”이라는
   표현만으로 고정 구성원을 추정할 수 없다. 실제 task executor를 기준으로
   학습 대상을 정해야 한다.

## Bounded memory and knowledge fix

기존 task·기억·지식 행을 삭제하거나 재작성하지 않고 다음 고정 ID만 추가한다.

| Store | Fixed ID | Purpose |
|---|---|---|
| improvement note | `team-kd-memory-cycle2-agent-patterns-20260724` | 문제·시간축·agent 패턴·rollback 보존 |
| knowledge base | `kb-team-kd-memory-evidence-separation-cycle2-20260724` | 제어면/감사 표본과 raw/verified 성공 분리 |
| Mem0/hermes | `mem0-team-kd-memory-cycle2-20260724-hermes` | gateway 실패를 감사 품질로 오학습하지 않음 |
| Mem0/ollama | `mem0-team-kd-memory-cycle2-20260724-ollama` | 미주입 값을 날조하지 않고 미완료로 보존 |
| Mem0/nvidia | `mem0-team-kd-memory-cycle2-20260724-nvidia` | tool narration·quality reject를 성공에서 제외 |
| Mem0/codex | `mem0-team-kd-memory-cycle2-20260724-codex` | 시점 있는 DB 근거와 검증 영수증을 요구 |

증류 규칙:

> kd-memory 평가는 `commander-perfgoal` 제어면 task와 실제 감사 산출물을
> 분리한다. 2026-07-24 관측상 실제 감사 task는 0건이다. raw `completed`라도
> `qualityRejected=true`, `evidence_json` 부재, 도구 함수 설명이면 성공
> 지식에서 제외한다. “task 0건” 같은 관측에는 시점을 붙이고 최신 DB로
> 재검증한다. 팀 lifecycle은 HR만 변경한다.

## Rollback

- 파일 rollback: 이 노트 한 개만 제거한다.
- DB rollback: 위 표의 고정 ID 6개만 제거한다.
- 기존 자동 Mem0 14건, 기존 knowledge-base 2건, task/team/lifecycle 행은
  변경하거나 삭제하지 않는다.

## Verification receipt

- `[DB snapshot]` 팀 소유 task 3건, team member 0건, agent별 pipeline 집계,
  quality metadata와 response 본문을 직접 조회했다.
- `[memory baseline]` kd-memory 관련 Mem0 14건 중
  `FORMAT_MISMATCH` 포함 2건, 보수적 tool narration 포함 4건을 확인했다.
  이는 전체 의미 품질률이 아니라 문자열 기반 오염 지표다.
- `[knowledge baseline]` 기존 두 KB 행
  `kb_ODEJMXLCDg7YtAx9`, `kb_5dkop3PTc3m7u1GW`가 09:00 스냅샷의
  “task 0건”만 저장하고 `used_count=0`인 것을 확인했다.
- `[linked rows]` 고정 ID로 improvement note 1건, knowledge-base 1건,
  agent-scoped Mem0 4건을 단일 트랜잭션으로 추가한 뒤 직접 재조회했다.
  기존 행은 갱신·삭제하지 않았다.
- `[Mem0 retrieval]` build 산출물의 public `mem0Service.search`를
  `hermes`, `ollama`, `nvidia`, `codex`에 호출했다. 네 검색 모두 각 agent의
  `mem0-team-kd-memory-cycle2-20260724-*`를 첫 결과로 회수했다.
- `[knowledge retrieval]` public `knowledgeBase.query`를
  `kd-memory commander-perfgoal FORMAT_MISMATCH evidence_json`으로 호출해
  `kb-team-kd-memory-evidence-separation-cycle2-20260724`를 회수했다.
  이 public query의 기존 피드백 동작으로 새 행의 `used_count`는 1이 됐다.
- `[focused tests]`
  `npm run test:run -- src/core/cron-scheduler.team-scores.test.ts
  src/core/team-scorer.test.ts src/server/task-intake.test.ts`
  → 3 files, 20 tests passed.
- `[typecheck]` `npx tsc --noEmit` → exit 0, 출력 없음.
- `[build]` `npm run build` → TypeScript `tsc`, exit 0.
- `[database integrity]` SQLite `quick_check` → `ok`;
  `foreign_key_check` → 위반 행 없음.
- `[failed attempt]` 최초 연결 스크립트의 `npx tsx` 실행은 tsx IPC socket의
  `EPERM`으로 애플리케이션 코드 전에 중단됐다. DB 행이 0건인 것을 유지한 채
  IPC가 없는 plain Node로 같은 단일 트랜잭션을 실행해 위 6건만 추가했다.
- `[grade]` T1: DB row, 파일 내용, 소스와 실제 명령 출력.
- `[미검증]` 새 기억이 다음 독립 kd-memory 감사 task의 품질을 높이는지,
  semantic embedding 생성, 외부 Obsidian 원본 vault 동기화, NCO API
  end-to-end 복구.
- 새 실제 감사 표본이 없으므로 score/completion 향상은 주장하지 않는다.
