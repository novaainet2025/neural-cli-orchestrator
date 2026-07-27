# HR Incubator 2026-W30 개선 cycle 1 증거

## 범위

- 대상: `team_hr-incubator-2026-w30`
- 변경 범위: 팀 태스크의 provider 실행 실패 분류와 해당 단위 테스트
- 소스 패치 비변경 범위: 팀 활성 상태, lifecycle profile, retirement 상태, 팀원 구성
- 재적용 가능한 patch: `docs/self-improve/hr-incubator-2026-w30-cycle1.patch`

## 근본 원인 증거

`db/nco.db`의 `tasks`에서 `datetime('now','-48 hours')` 이후 대상 팀 행을 직접 조회했다.
조회된 10건 중 6건은 `completed`, 4건은 `failed`였다.

- `task_LaiCTxfL9_MD-KcU`: `Circuit breaker open for agent hermes (generic)`
- `task_dPluiM6mYO0_TShj`: `queue_wait_timeout: provider claude-code busy for 1800000ms`
- `task_LWocTfAMYEW4juI0`: `queue_wait_timeout: provider claude-code busy for 1800000ms`
- `task_VnTZtkgkcpgPwPhy`: `subprocess exited with code 1: Invalid API key · Fix external API key`

`git diff`의 HEAD 측 파일 내용에서 기존 `isTransientFailure`가 `silent-failure`, idle timeout,
provider abort, circuit breaker, provider unavailable만 팀 failover 대상으로 분류함을 확인했다.
즉, 동일 DB 표본의 queue 포화와 인증 실패를 팀 내부 대체 실행으로 연결하지 못하는 분류 공백이 있었다.

## 변경

- `src/core/task-queue.ts`
  - `queue_wait_timeout`, provider 인증 실패, CLI/subprocess 실행 실패를 팀 failover 대상으로 분류한다.
  - rate-limit과 `usage limit`을 먼저 제외해 기존 backoff/failover 경로와 중복되지 않게 한다.
  - verifier/quality/evidence 정책 실패와 status 없는 CLI cancellation은 failover에서 제외한다.
  - 기존 `teamRetried` 제한은 유지하므로 팀 내부 대체 실행은 태스크당 최대 1회다.
  - `NCO_P11_FAILOVER_ENABLED=0`이면 이 팀 failover 분기를 즉시 비활성화할 수 있다.
- `src/core/task-queue.p11.test.ts`
  - 실제 DB 오류 문자열과 CLI 오류 문자열의 양성 케이스를 추가했다.
  - CLI 오류에 rate-limit/usage-limit이 포함된 경우, verifier 실패, status 없는 cancellation의
    음성 케이스를 추가했다.
- `docs/self-improve/hr-incubator-2026-w30-cycle1.patch`
  - 위 두 소스 파일의 unified diff를 기록했다.
  - SHA-256: `a9ec40046186ec0e2e0b8b26139fd43b16eb2e9e5070089e8e5e120ff6d9622b`

## 검증 결과

### 집중 테스트

명령:

```text
npm run test:run -- src/core/task-queue.p11.test.ts
```

결과:

```text
Test Files  1 passed (1)
Tests  13 passed (13)
```

추가된 진리표의 분류 기대값:

```text
{"error":"queue_wait_timeout: provider claude-code busy for 1800000ms","eligible":true}
{"error":"subprocess exited with code 1: Invalid API key · Fix external API key","eligible":true}
{"error":"codex: CLI failed exit=1 — provider process failed","eligible":true}
{"error":"Circuit breaker open for agent hermes (generic)","eligible":true}
{"error":"codex: CLI failed exit=1 — rate limit exceeded","eligible":false}
{"error":"codex: CLI failed exit=1 — You have hit your usage limit","eligible":false}
{"error":"verifier failed: subprocess exited with code 1: Invalid API key in fixture","eligible":false}
{"error":"codex: CLI cancelled — signal","eligible":false}
{"error":"subprocess cancelled: user requested","eligible":false}
```

### 정적 검증과 빌드

```text
npm run typecheck
exit code: 0

npm run build
exit code: 0
```

샌드박스가 `tsx` CLI의 Unix IPC socket 생성을 `EPERM`으로 차단했기 때문에 검증 중에만
`node_modules/.bin/tsx`를 `node --import tsx` 호환 실행기로 연결했다. 종료 trap으로 원복했고,
최종 `readlink node_modules/.bin/tsx` 결과는 원래 값인 `../tsx/dist/cli.mjs`였다.
우회 전 첫 테스트 시도의 실제 오류는
`Error: listen EPERM: operation not permitted ... /T/tsx-501/83007.pipe`였으며 exit code는 1이었다.

`git diff --check -- src/core/task-queue.ts src/core/task-queue.p11.test.ts`와
`git apply --check --reverse docs/self-improve/hr-incubator-2026-w30-cycle1.patch`는
출력 없이 exit code 0이었다. source/test별 `git diff` 연결 결과와 patch 파일의 `cmp`도
출력 없이 exit code 0이었다.

세 npm 검증 명령은 기존 work-event ledger 동작에 따라 `db/nco.db`에 아래 행을 기록했다.

- `evt_CfCMr9XaZtI3N2sk`: `regression:test:passed`, `succeeded`
- `evt_IGet7dL3zRPjfJAj`: `regression:typecheck:passed`, `succeeded`
- `evt_1fvEwtOFcDNNoCMf`: `regression:build:passed`, `succeeded`

현재 diff를 호출 경로까지 읽어 검토했으며, provider failure만 대상으로 좁히는 제외 규칙,
태스크당 1회 제한, 환경변수 비활성화 경로가 유지됨을 확인했다.

최종 lifecycle 조회에서는 `is_active=1`, `status=improving`, `last_score=81.5`,
`last_sample_size=7`, `retired_at=NULL`이었다. 이 조회값의 변화는 본 패치 효과로 귀속하지 않는다.

## Gap

- NCO `http://localhost:6200/api/health`는 현재 `NCO :6200 unreachable`이므로 실제 gateway를 통한
  신규 팀 태스크의 runtime failover는 미검증이다.
- 지시문 스냅샷의 score `79.1`, completion `83.3%`와 최종 DB의 `last_score=81.5` 사이의
  변화 원인 및 현재 completion은 미검증이다. 본 패치의 효과로 귀속할 수 없다.
- 저장소 전체 테스트는 실행하지 않았고 변경 관련 집중 테스트, typecheck, build만 실행했다.
- 공유 `main` 작업트리의 dirty 파일 수는 최초 inspect에서 119개, 후속 조회에서 122개로
  관찰됐다. 본 작업 파일의 diff와 검증 결과는 별도로 확인했지만 저장소 전체 clean 상태는 미검증이다.

## 되돌리기

즉시 완화는 `NCO_P11_FAILOVER_ENABLED=0`으로 가능하다. 소스 되돌리기는 기록된 patch를
역적용하고 두 증거 산출물을 제거하는 방식이다. 본 패치는 팀 lifecycle, 팀 활성 상태,
팀원 구성을 쓰는 코드를 실행하지 않았다. 검증 명령이 추가한 세 `work_events` 행은
감사 증거이므로 삭제하지 않으며, HR lifecycle 데이터의 롤백은 수행하지 않는다.
