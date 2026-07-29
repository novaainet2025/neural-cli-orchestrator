# kd-memory 근본원인·수정 증거 (2026-07-24)

## 1. T1 원문 근거

`db/nco.db`의 `team_lifecycle_events` 원문은 2026-07-24 02:40:00에
`score=3.3`, `sample=48h`, `n=3`, `completion=0`을 기록한다.

세 표본은 모두 `spawned_by_cli=commander-perfgoal`인 목표·성과보고 제어면
태스크다. 실제 지식·메모리 감사 산출물 태스크는 0건이다.

| task_id | 상태 | 실행자 | DB 원문 요약 | 분류 |
|---|---|---|---|---|
| `task_pKVM8hAZUmzskqwL` | failed | hermes | `curl: (7) Failed to connect to localhost port 6200 ... Couldn't connect to server`; 변경 파일 없음 | NCO 게이트웨이 인프라 실패 |
| `task_WpB7UCfWLhPnwx-u` | failed | ollama | `targetValue, direction, reflection, improvement are unknown; cannot fabricate values` | 입력 계약의 필수값 미주입 |
| `task_tnhlWTnnJz5dVshv` | lease_expired | retired-provider→ollama | response 없음; escalation reason=`empty completion from provider 'retired-provider'`; `lease_expires_at=2026-07-23 11:58:17` | provider/lease 인프라 실패 |

세 행에는 모두 실제 POST 작업과 무관한
`verifier_json={"type":"run","command":"npm run build"}`가 붙었고 verifier 자체는
통과했다. 자동 prompt-gate 보강문의 “수정/빌드”가 HTTP 제어면 작업을 코드 작업으로
오분류한 결과다. 이 verifier가 기록된 lease 만료를 일으켰다는 인과 증거는 없다.

## 2. 근본원인 판정

`completion=0%`는 산출물 경로 미인식, 팀 slug 누락, Mem0 미연동을 입증하지
않는다. 직접 원인과 함께 확인된 별도 intake 결함은 다음과 같다.

1. 팀 스코어러가 `commander-perfgoal` 관리 태스크를 실제 팀 감사 품질 표본으로
   합산했다. 이것이 잘못된 팀 completion 신호의 직접 원인이다.
2. task intake가 `[성과보고·목표설정 입력 지시]`를 코드 작업으로 오분류하여
   무관한 build verifier를 부착했다. 이는 독립적인 불필요 gate이며 세 실패의
   원인이라고 단정하지 않는다.

## 3. bounded·reversible 수정

- `src/core/team-scorer.ts`
  - `spawned_by_cli=commander-perfgoal`인 제어면 행을 팀과 무관하게
    completed/terminal 양쪽에서 제외한다.
  - 동일 팀의 non-perfgoal charter 태스크는 계속 집계한다.
  - 롤백: `CONTROL_PLANE_PERFGOAL_EXCLUSION`과 6개 적용부만 제거한다.
- `src/server/task-intake.ts`
  - 정확한 프롬프트 접두사 `[성과보고·목표설정 입력 지시]`만 감지하여 기본 build
    verifier를 생략한다.
  - 명시적으로 전달된 verifier는 기존처럼 우선한다.

HR lifecycle 변경 전 실제 DB로 수정 후 재계산한 당시 `team_kd-memory` 결과는
`score=0`, `completion=0`, `n=0`, `sample=all`이었다. 이는 점수 상승이 아니라
“실제 감사 표본 없음”을 정직하게 표면화한 결과다. 현재 DB에서는 HR lifecycle에
의해 팀이 비활성 상태이므로 live 재계산 결과가 `null`이다. lifecycle·팀 상태는
이번 수정 범위에서 변경하지 않았다.

## 4. T1 검증 결과

- 최초 외부 테스트 실행의 `No test files found`는 테스트 실패가 아니라 보고서의
  설명 문자열이 Vitest 위치 인자로 전달된 호출 형식 오류다. 아래 전체 테스트는
  위치 인자를 전달하지 않은 `npm run test:run` 그대로 다시 실행한 결과다.
- 관련 회귀:
  `npm run test:run -- src/core/team-scorer.test.ts src/server/task-intake.test.ts src/core/team-lifecycle.test.ts`
  → 3 files, 23 tests passed.
- 전체 테스트:
  `npm run test:run` → 96/97 files, 464/465 tests passed; 1 unrelated failure.
  실패는 `tests/근거.test.ts`의 고정 기대값 `2026-07-14`와 현재
  `data/team-runner/team_ax-collab.last=2026-07-24` 불일치이며 단독 재현된다.
- 타입체크: `npx tsc --noEmit` → exit 0.
- 빌드: `npm run build` → exit 0.
- 실제 DB 재계산: 빌드된 `dist/core/team-scorer.js`와 `db/nco.db` 읽기 전용
  연결로 `computeTeamScores(db)` 실행 → kd-memory `score=0`, `completion=0`,
  `n=0`, `sample=all`; control-plane 오염 제거 확인.
- 증거 등급: T1 (DB 행 본문, 소스 diff, 실제 명령 출력).

## 5. 미검증·제약

- NCO API `localhost:6200`은 조사 시 연결되지 않아 post-patch 런타임 HTTP
  재현은 수행하지 못했다.
- 실제 kd-memory 감사 태스크가 아직 0건이므로 개선 후 completion/score 상승은
  주장하지 않는다.
- 최초 조사 시 `.git/index.lock` 쓰기가 샌드박스에서 거부되어 그 turn에서는
  단일 커밋을 생성하지 못했다. 이후 스코어러 변경은 `aff5990`, intake 변경은
  `ade3456`에 포함되었다. 이 항목은 최초 조사 당시의 제약이며 현재 상태를
  “미커밋”으로 뜻하지 않는다.
- Mem0/Obsidian 연동 상태를 바꾸는 외부 쓰기는 이번 코드 수정 범위에서 수행하지
  않았다.

## 6. cycle 3 재검증 영수증 (2026-07-24 12:56 KST)

- 관련 회귀:
  `npm run test:run -- src/core/team-scorer.test.ts src/server/task-intake.test.ts src/core/team-lifecycle.test.ts`
  → 3 files, **25 tests passed**, exit 0. 요청문에 적힌 23은 기대치였고 현재
  브랜치에는 후속 회귀 테스트가 추가되어 실측은 25다.
- 타입체크: `npx tsc --noEmit` → exit 0, 출력 없음.
- 빌드: `npm run build` → `tsc`, exit 0.
- 실제 DB 원문: `tasks WHERE team_id='team_kd-memory'`는 3건이고 세 건 모두
  `spawned_by_cli='commander-perfgoal'`이다. 현재 제외식을 직접 적용한 집계는
  `terminal_all=0`, `completed_all=0`이다.
- 현재 live DB에서 `teams.is_active=0`이고 최근 lifecycle 원문에
  `event_type='retired'`가 있으므로, 활성 팀만 반환하는
  `computeTeamScores(db)`에는 kd-memory 행이 없다(`null`). 따라서 현재 시점의
  live 재계산을 `n=0` 행이라고 재보고하지 않는다. 위 4절의 `n=0`은 HR lifecycle
  변경 전 실행 증거이고, 단위 테스트는 활성 kd-memory 표본에서
  `{ completion: 0, n: 0, sample: 'all' }` 회귀를 계속 검증한다.
- lifecycle/팀 상태는 읽기 전용으로만 조회했으며 활성화·비활성화·retirement
  변경을 수행하지 않았다.
- NCO API `localhost:6200`은 이번 재검증에서도 연결 거부되어 post-patch HTTP
  재현과 activity/lease 보고는 `[미검증]`이다.
- 대상 소스·테스트는 HEAD 대비 clean이며 이번 turn의 기록 변경은 이 문서뿐이다.
  HNSW 인덱스와 다른 팀 문서 등 범위 밖 워킹트리 변경은 보존했다.
- 증거 등급: T1 (실제 명령 출력, DB 행, 소스·커밋 내용 직접 확인).

## 7. FORMAT_MISMATCH 재시도 영수증 (2026-07-24 13:06 KST)

- quality-gate가 두 차례 반환한 `No test files found`는 Vitest가 `영수증:`을 파일
  필터로 받은 잘못된 호출(`filter: 영수증:`)의 exit 1이다. 코드 테스트 결과로
  간주하지 않았다.
- 정확한 명령
  `npm run test:run -- src/core/team-scorer.test.ts src/server/task-intake.test.ts src/core/team-lifecycle.test.ts`
  재실행 결과는 3 files, **25 tests passed**, exit 0이다.
- `npx tsc --noEmit`은 exit 0, `npm run build`는 `tsc` 후 exit 0이다.
- 읽기 전용 DB 원문에서 `team_kd-memory`의 tasks는 3건이며 모두
  `spawned_by_cli='commander-perfgoal'`이다. 현재 제외 조건을 적용한 원시 집계는
  `terminal_after_exclusion=0`, `completed_after_exclusion=0`이다.
- 현재 `teams.is_active=0`이므로 빌드된 `computeTeamScores(db)`의 kd-memory
  결과는 `null`이다. 이를 활성 팀의 `{n: 0}` 결과라고 바꾸어 보고하지 않는다.
  최신 lifecycle 원문은 2026-07-24 03:20:01 UTC의 HR scheduled
  `event_type='retired'`, `score=1.8`,
  `metadata_json={"immediate":false,"activeTasks":false}`다. 이번 검증은 DB를
  읽기 전용으로만 열었고 팀 상태·lifecycle·retirement를 변경하지 않았다.
- 검증 도중 공유 브랜치에 `c31625f`와 `259d198`이 연속 커밋되어 scorer의
  제어면 제외 범위가 다른 팀 작업과 경합했다. 검증한 워킹트리는
  `CONTROL_PLANE_PERFGOAL_EXCLUSION`을 completed/terminal 6개 CASE에 대칭
  적용하며, 같은 팀의 non-perfgoal charter 태스크를 유지하는 회귀 테스트까지
  통과한다. 따라서 6절의 “대상 소스·테스트가 HEAD 대비 clean”은 당시 스냅샷
  설명이며 현재 스냅샷 설명으로 재사용하지 않는다.
- NCO API `localhost:6200`은 연결 거부 상태라 post-patch HTTP 재현과
  activity/lease 보고는 `[미검증]`이다. 실제 감사 표본은 여전히 0건이므로
  completion/score 상승은 주장하지 않는다.
- 검증 기준선은 `HEAD=632a65a9c15bf840a9f22c2ee892636da220a141`이다.
  대상 소스·테스트는 HEAD 대비 clean이고, 이번 turn에는 현재 구현과 어긋난
  이 문서의 과거 팀 전용 제외 설명만 정정했다. 공유 워킹트리의 HNSW 변경은
  범위 밖이므로 보존했다.
- 증거 등급: T1 (실제 테스트·타입체크·빌드 출력, DB 행, 소스 내용 직접 확인).
