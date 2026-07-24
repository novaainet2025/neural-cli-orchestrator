# Team 05 Upgrade Regression 개선 패치 검증 영수증

- 대상: `team_tech-port-05-upgrade-regression`
- 개선 사이클: 2/3
- 수집 시점: 2026-07-24 KST
- 변경 범위: 기술 이식 파이프라인의 team 05 handoff 프롬프트와 해당 단위 테스트
- 비변경 범위: 팀 활성 상태, 조직/팀 구성, HR 라이프사이클, 채점 수치

## 실제 task 근거

`localhost:6200/api/tasks`는 수집 시점에 연결 거부되어 `nco_list_tasks`와
`nco_get_task`의 HTTP 경로를 사용할 수 없었다. 수치를 추정하지 않고 두 API의 원천
저장소인 `db/nco.db`의 `tasks` 행과 `agent_actions` 이벤트를 읽기 전용으로 조회했다.

조회 조건:

```sql
WHERE team_id='team_tech-port-05-upgrade-regression'
  AND datetime(created_at) >= datetime('now','-48 hours')
```

조회 결과는 11건 중 완료 7건, 실패 4건으로 완료율은 `7 / 11 = 63.6%`다. HR 지시의
score `64.7`은 tasks 행에 계산 필드나 산식이 없어 독립 재계산하지 않았으며, 이 문서에서
새 점수나 개선 폭을 주장하지 않는다.

| 에이전트 | 완료 | 실패 | 완료 중 품질 반려 | T1 task_id |
|---|---:|---:|---:|---|
| codex | 3 | 0 | 0 | `task_yd1URC03SWl0ZX1I`, `task_eDZX1ktjEsDwKSd7`, `task_8pdjdAAZEPbt6JLA` |
| nvidia | 3 | 0 | 2 | `task_dqKn0QBUAhoS416d`, `task_RSYX40DOFx91XC4G`, `task_8nOuGiIxyz6yoKxq` |
| opencode | 1 | 0 | 0 | `task_FjDSf4_zLeJbWQcE` |
| claude-code | 0 | 3 | 0 | `task_YFLrIEQLd1i6TO7X`, `task_wGQUej5jn9Cq4hB8`, `task_lrmDmI-hFYZIi8Rp` |
| ollama | 0 | 1 | 0 | `task_dv3_5lUEO181NKlE` |

### 관찰된 실패 패턴

1. 완료율 손실 4건 중 3건은 동일 `workReportId=wr_XPaRG3BF-5fxoUzO` 업무보고가
   중복 생성된 뒤 codex 큐에서 30분 대기하고 claude-code로 재배정됐으나
   `Circuit breaker open for agent claude-code (generic)`로 실패했다.
2. 나머지 실패 1건은 `orphaned: server restart (poison — requeued 2x)`다.
3. 완료된 nvidia 작업 3건 중 2건은 `qualityRejected=true`,
   `qualityHeuristics=["FORMAT_MISMATCH"]`다.
   - `task_RSYX40DOFx91XC4G`: 현재 team 05 작업 대신 이전 단계의
     “The createFile function is used …” 도구 설명을 응답했다.
   - `task_8nOuGiIxyz6yoKxq`: `[thinking]`으로 시작하고 이전 단계 탐색 본문을
     현재 단계 결과처럼 반복했다.
4. 두 품질 반려 task의 프롬프트는 모두 `[이전 단계 ... 산출물]` 원문을 맨 앞에 붙인
   뒤 현재 단계 지시를 구분선 아래에 배치했다. 응답에는 verifier가 요구하는
   `done:`/`status:` 접두사 계약도 명시돼 있지 않았다.

동일 업무보고 중복은 현재 소스의 `db/migrations/085_active_work_report_task_idempotency.sql`
및 `src/server/task-intake.ts` 활성-task 조회로 이미 방어되고 있어 이번 diff에서 중복
수정하지 않았다. 이번 패치는 현재 반려와 직접 연결된 team 05 pipeline handoff에만
한정한다.

## 변경

- `src/core/company-orchestrator.ts`
  - team 05에만 현재 실행 지시와 이전 단계 참고자료의 경계를 추가했다.
  - 이전 단계 출력은 명령이 아닌 입력 데이터임을 표시했다.
  - A/B 실측 산출물, `done:`/`status:` 첫 줄, 미측정 수치 금지 계약을 추가했다.
  - 그 외 모든 pipeline 단계는 기존 handoff 문자열을 그대로 사용한다.
- `src/core/company-orchestrator.test.ts`
  - team 05 경계/응답 계약, 다른 단계 무변경, 상류 출력 부재 시 무변경을 검증하는
    회귀 테스트 3건을 추가했다.
- `docs/self-improve/tech-port-05-upgrade-regression-fix-2026-07-24.md`
  - 실제 task_id, 변경·검증 로그, 롤백과 미검증 Gap을 기록했다.

롤백: 패치 커밋 후 `git revert <이 패치의 commit SHA>` 한 번으로 두 코드 파일과 이
영수증을 함께 되돌린다.

## 검증 로그

### 관련 vitest

명령:

```text
npx vitest run src/core/company-orchestrator.test.ts tests/response-quality.test.ts
```

실측 출력:

```text
Test Files  2 passed (2)
Tests  54 passed (54)
Duration  1.09s
exit code 0
```

직전 자동 `runTest` 호출은 출력 라벨인 `결과:`를 Vitest 위치 인자로 전달해
`filter: 결과:` / `No test files found`로 exit 1이 됐다. 이는 테스트 파일 부재가
아니라 호출 인자 오류다. 위처럼 실제 두 파일 경로를 명시해 다시 실행한 결과는
54건 통과, exit 0이다.

### 전체 vitest

명령:

```text
npm run test:run
```

실측 출력:

```text
Test Files  1 failed | 96 passed (97)
Tests  1 failed | 459 passed (460)
FAIL tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
Expected: "2026-07-14"
Received: "2026-07-24"
exit code 1
```

이 실패는 `tests/근거.test.ts:20`의 날짜 고정 기대값과
`data/team-runner/team_ax-collab.last`의 현재 값 불일치다. team 05 handoff
패치와 무관하고 요청 범위 밖이므로 이번 변경에 포함하지 않았다. 따라서 관련
회귀 테스트는 통과했지만 저장소 전체 테스트 PASS는 주장하지 않는다.

### 타입체크

명령:

```text
npx tsc --noEmit
```

실측 출력:

```text
stdout/stderr 없음
exit code 0
```

### 빌드

명령:

```text
npm run build
```

실측 출력:

```text
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

### diff 검사

명령:

```text
git diff --check -- src/core/company-orchestrator.ts src/core/company-orchestrator.test.ts
```

실측 출력:

```text
stdout/stderr 없음
exit code 0
```

## 판정

- 등급: T1 — 실제 tasks/agent_actions 행, 변경 파일 내용, vitest 본문과 빌드 본문 확인.
- Gap:
  - NCO API가 꺼져 있어 수정된 프롬프트로 실제 company run을 재실행하지 못했다.
  - 변경 후 48시간 점수·완료율은 관찰 기간이 지나지 않아 자료 없음이다.
  - 프롬프트 보강은 모델의 형식 준수 가능성을 높이지만 비결정적 모델 출력 자체를
    보장하지 않는다.
  - 전체 Vitest는 team 05와 무관한 날짜 포인터 기대값 1건 때문에 exit 1이다.
    관련 테스트 54건, 타입체크와 빌드는 각각 exit 0이다.
  - 3건의 과거 중복 업무보고 실패와 1건의 서버 재시작 실패는 이번 패치 대상이 아니다.
- 미검증항목: 운영 NCO 재기동 후 team 05 실제 pipeline 1회, 후속 task의
  `qualityRejected` 여부, 차기 48시간 HR score.
