---
created_at: 2026-07-28T04:37:44+09:00
verified_at: 2026-07-28
tags:
  - improvement-note
  - team/gov-evolution-learning
  - nco/mem0
  - agent-history
  - evidence/T1
  - cycle/3
---

# Continuous Learning agent history and shared memory — cycle 3

> Requested content:
> “Analyze agent work histories and success/failure patterns to optimize Obsidian notes and Mem0 long-term memory integration.”

## Scope and safety

- 대상: `gov-evolution-learning` / `team_gov-evolution-learning`.
- HR 기준선: score `83.4`, completion `87.5%`, sample `48h/8`,
  improvement cycle `3/3`.
- 분석 원천: 2026-07-28 KST에 만든 `db/nco.db` 읽기 전용 스냅샷의
  `tasks`, `teams`, `team_lifecycle_profiles`, `mem0_entries`와 현재 저장소 소스.
- 이 작업은 팀을 삭제·비활성화하지 않고 lifecycle status, retirement, score,
  task status를 변경하지 않는다. 해당 판단은 HR 소유로 남긴다.
- 외부 Obsidian 원본 vault는 쓰지 않는다. 이 파일은 저장소 내부 Obsidian
  미러의 동기화 대기 노트다.

## Ground-truth work history

48시간 대상 범위의 terminal task는 10건이다. 아래 비율은 원시 DB status이며,
산출물의 의미 품질 성공률과 동일하다고 간주하지 않는다.

| 실행 에이전트 | terminal | completed | failed | 원시 완료율 | 관찰 패턴 |
|---|---:|---:|---:|---:|---|
| `ollama` | 3 | 3 | 0 | 100.0% | 응답은 모두 존재하지만 한 응답은 도구 금지 입력을 `[api/agents]` 직접 검증으로 서술해 자연어 주장을 T1로 승격할 수 없음 |
| `opencode` | 3 | 1 | 2 | 33.3% | `task_3eejRUftHpUXmdOH` 공백 출력, `task_p2V_WOaQg3z-gdGx` 인증 오류 봉투 |
| `hermes` | 2 | 2 | 0 | 100.0% | 주입된 데이터와 미제공 항목의 경계를 명시하는 보수적 응답 |
| `claude-code` | 1 | 0 | 1 | 0.0% | `provider_unavailable: claude-code (open/generic)` |
| `codex` | 1 | 1 | 0 | 100.0% | opencode·claude-code 실패 뒤 오후 보고서를 생성한 failover 성공 |

10건 전부 `result_json`과 `evidence_json`이 비어 있다. 따라서 status가
`completed`인 7건도 구조화된 검증 성공으로 자동 승격하지 않는다.

HR의 `48h/8`, completion `87.5%` 표본과 원시 10건의 차이는
provider/infrastructure 제외 규칙이 적용된 결과다. 점수 표본에서 남는 직접
미완료는 `task_3eejRUftHpUXmdOH`의 `silent-failure: empty output` 1건이다.
원시 10건을 분모로 다시 계산한 값을 HR 점수라고 주장하지 않는다.

## Root cause

이 팀은 `ollama`, `opencode`, `hermes`, `claude-code`, `codex` 사이에서 실행자와
failover 대상이 바뀐다. 그러나 `src/agent/agent-manager.ts`의 기존 기억 경로는
작업 전 `vectorMemory.search(agentId, ...)`, 성공 뒤
`vectorMemory.add(agentId, ...)`만 호출했다.

cycle 1 진단 task `task_kyjwoz5UnXmOYDWE`도 `codex` 개인 Mem0에만 자동 저장되어
`access_count=4`였고, `self-learning`의 대상 기억과
`team:team_gov-evolution-learning` 공유 기억은 각각 0건이었다. 즉 저장은
되었지만 다음 실행자가 달라지면 팀 교훈을 회수하지 못하는 **executor-scoped
memory fragmentation**이 지속 학습의 직접 결손이다.

## Bounded, reversible fix

1. 개인 agent memory 저장·검색은 그대로 유지한다.
2. DB task에 안전한 `team_id`가 있으면 `team:<team_id>` HNSW namespace에도 같은
   성공 기억을 저장하고, 다음 팀 task에서 개인+팀 기억을 함께 검색한다.
3. 개인·팀 결과의 공백 정규화 내용이 같으면 점수가 높은 한 건만 주입하고 전체
   context 상한 5건을 유지한다.
4. `NCO_TEAM_MEMORY_SCOPE=off`이면 공유 namespace 계산·검색·저장을 모두
   비활성화해 기존 동작으로 즉시 되돌린다.
5. 기존 Mem0 행과 HNSW index는 삭제하거나 재작성하지 않는다.

현재 증거를 다음 고정 공유 스코프에 1건 증류했다.

| Store | Scope / ID | Purpose |
|---|---|---|
| Obsidian mirror | 이 파일 | 작업 이력, 원시 status/검증 성공 분리, 근거와 롤백 |
| Mem0 HNSW | `team:team_gov-evolution-learning` / `mem0-1785181064084-n1hdhn` | failover 뒤에도 task ID·실패 유형·HR lifecycle 경계를 회수 |
| improvement note DB | `team-gov-evolution-learning-cycle3-agent-memory-20260728` | 파일과 Mem0 ID의 연결 및 근본원인 검색 |

증류 기억은 `task_3eejRUftHpUXmdOH`,
`task_p2V_WOaQg3z-gdGx`, agent별 원시 완료 패턴, 구조화 증거 0/10,
provider/auth 실패를 팀 품질과 분리하는 규칙, HR lifecycle 경계를 포함한다.
재검증일은 2026-08-04로 기록했다.

## Rollback

- 런타임 즉시 롤백: `NCO_TEAM_MEMORY_SCOPE=off`.
- 코드 롤백: `src/core/task-memory-scope.ts`, 전용 테스트, 그리고
  `src/agent/agent-manager.ts`의 개인+팀 검색/저장 연결만 되돌린다.
- 증거 seed 롤백: Mem0 ID `mem0-1785181064084-n1hdhn`과 improvement note ID
  `team-gov-evolution-learning-cycle3-agent-memory-20260728`만 제거한 뒤
  `team:team_gov-evolution-learning` HNSW index를 재빌드한다.
- 노트 롤백: 이 파일만 제거한다.
- 기존 개인 Mem0, task/team/lifecycle 행은 롤백 대상이 아니다.

## Verification receipt

- `[Evidence Tier 1 — DB snapshot]` terminal task 10건과 agent별 status,
  `result_json`·`evidence_json` 0/10, cycle1 자동 기억의 `codex` 스코프와
  `access_count=4`를 직접 조회했다.
- `[Evidence Tier 1 — source]` `agent-manager.ts`가 기존에 개인 agent ID만으로
  HNSW 검색·저장을 수행하는 코드를 직접 확인했다.
- `[Evidence Tier 1 — focused tests]`
  `node --import tsx ./node_modules/vitest/vitest.mjs run
  src/core/task-memory-scope.test.ts src/agent/agent-manager.test.ts`
  → test files 2 passed, tests 11 passed.
- `[Evidence Tier 1 — HNSW retrieval]` 추가 전 공유 스코프 행 0건을 확인한 뒤
  public `vectorMemory.add/search`로 `mem0-1785181064084-n1hdhn`을 저장·첫 결과로
  재조회했다. 저장 행은 `embedded=1`, fallback `semantic=0`,
  `hnsw_label=0`, `importance=1.2`, 재조회 뒤 `access_count=1`이다.
- `[Evidence Tier 1 — DB integrity]` seed 저장 뒤 `PRAGMA quick_check` → `ok`.
- `[Evidence Tier 1 — typecheck/build]` npm wrapper는 `tsx`의
  `listen EPERM .../tsx-501/*.pipe`로 TypeScript 실행 전에 실패했다. 같은 저장소
  work-event wrapper를 IPC 없는 `node --import tsx`로 실행한
  `tsc --noEmit`과 `tsc`는 각각 exit 0이었고 DB에
  `regression:typecheck:passed`, `regression:build:passed` 행이 기록됐다.
- `[Evidence Tier 1 — full regression]` IPC 없는 wrapper의 전체 Vitest는
  test files `121 passed / 1 failed`, tests `705 passed / 1 failed`였다.
  유일한 실패는 범위 밖 `tests/근거.test.ts:26`의 날짜 포인터가
  `2026-07-27`이고 서울 현재일이 `2026-07-28`인 불일치다. 이 포인터는 임의로
  수정하지 않았다.
- `[Evidence Tier 1 — Git integration]` 작업 중 다른 프로세스가 `main`을
  `a8c285a3d65340f27627d8f3327bd8fd5a091690`으로 전진시켰고, 해당 commit
  tree에서 이 노트, 공유 HNSW index, 메모리 스코프 코드와 테스트가 직접
  확인됐다. 누가 commit을 수행했는지는 unknown이며 이번 검증에서는 Git tree
  내용만 근거로 사용한다.
- `[미검증]` NCO `:6200`이 연결 거부 상태여서 운영 task E2E 주입은 미실행이다.
  외부 Obsidian 원본 vault 동기화와 다음 독립 cycle의 score/completion 향상도
  미검증이며 향상 수치를 주장하지 않는다.
