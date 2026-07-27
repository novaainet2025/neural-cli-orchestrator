# 콘텐츠 기획팀 개선 cycle 1 검증 영수증

검증일: 2026-07-28 (Asia/Seoul)

## 실데이터 진단

- DB: `db/nco.db`
- `computeTeamScores()` 재계산 결과:
  - `teamId`: `team_content-planning`
  - `score`: `83.4`
  - `completion`: `87.5`
  - `n`: `8`
  - `maxN`: `84`
  - `sample`: `48h`
- HR 지시 입력의 score `83.6`과 현재 재계산 score `83.4`는 동일하지 않다. 현재 확인된 값은 `83.4`이며, completion과 표본은 각각 `87.5`, `8`이다.
- 유일한 계상 실패 태스크:
  - ID: `task_content_generation`
  - status: `failed`
  - assigned_to: `cursor-agent`
  - created_at: `2026-07-27 17:10:06`
  - completed_at: `2026-07-27 17:21:31`
  - response length: `0`
  - error prefix: `cursor-agent: CLI failed exit=unknown — Command failed with ENOENT: cursor-agent`
- 같은 48시간 원시 행의 opencode circuit-breaker 실패 1건은 `team-scorer.ts`의 인프라 제외 조건에 의해 표본에서 제외된다.

근본원인: NCO provider subprocess가 좁은 서비스 PATH를 상속하면 `~/.local/bin/cursor-agent`를 찾지 못한다. 실제 바이너리는 `/Users/nova-ai/.local/bin/cursor-agent`에 존재하며 직접 `--version` 실행 결과는 `2026.07.23-e383d2b`였다.

## 변경

- `src/agent/provider-process-env.ts`
  - `cursor-agent`에만 `~/.local/bin` PATH fallback을 추가한다.
  - `NCO_CURSOR_AGENT_BIN_DIR`로 설치 디렉터리를 지정할 수 있다.
  - `NCO_CURSOR_AGENT_PATH_FALLBACK=off`로 즉시 비활성화할 수 있다.
  - 다른 provider의 PATH는 변경하지 않는다.
- `src/agent/orchestrated-loop.ts`
  - 실제 Type B provider 태스크 subprocess에 위 환경을 적용한다.
- `src/agent/agent-manager.ts`
  - provider recovery probe에도 동일 환경을 적용한다.
- `src/agent/provider-process-env.test.ts`
  - 기본 fallback, 타 provider 비영향, off 롤백, 커스텀 경로/중복 방지를 검증한다.
- 전체 diff: `08-IMPROVEMENTS/team-content-planning-cycle1.patch`

## 직접 동작 증거

컴파일된 `dist/agent/provider-process-env.js`와 `spawnSync('cursor-agent', ['--version'])`를 사용했다. 실제 서비스 조건처럼 기존 `process.env`를 유지하고 PATH만 `/usr/bin:/bin`으로 제한했다.

```json
{
  "before": {
    "status": null,
    "error": "spawnSync cursor-agent ENOENT",
    "stdout": ""
  },
  "patched": {
    "status": 0,
    "error": null,
    "stdout": "2026.07.23-e383d2b"
  },
  "rollbackToggleOff": {
    "status": null,
    "error": "spawnSync cursor-agent ENOENT",
    "stdout": ""
  }
}
```

## 빌드·테스트 증거

- `git diff --check -- src/agent/agent-manager.ts src/agent/orchestrated-loop.ts src/agent/provider-process-env.ts src/agent/provider-process-env.test.ts` → exit `0`
- `git apply --check --reverse 08-IMPROVEMENTS/team-content-planning-cycle1.patch` → exit `0`
- `node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- ./node_modules/.bin/tsc` → 실제 `tsc` 실행, exit `0`
  - `work_events`: `regression:build:passed`, outcome `succeeded`, summary `./node_modules/.bin/tsc completed successfully`, exitCode `0`
- `env PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts --event-type regression:typecheck -- tsc --noEmit` → exit `0`
- `node --import tsx scripts/run-with-work-event.ts --event-type regression:test -- ./node_modules/.bin/vitest run src/agent/provider-process-env.test.ts` → test files `1 passed`; tests `4 passed`; exit `0`
- npm과 같은 `node_modules/.bin` PATH를 주입한 control 검증에서 `src/security/command-gate.test.ts`와 신규 테스트 → test files `2 passed`; tests `6 passed`; exit `0`
- `env PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run`으로 전체 회귀 실행:
  - 결과: test files `120 passed`, `1 failed`; tests `672 passed`, `1 failed`; exit `1`
  - 실패: `tests/근거.test.ts`가 `data/team-runner/team_ax-collab.last`의 `2026-07-27`을 오늘 KST `2026-07-28`과 비교해 실패했다. 변경 파일과 무관하며 이 작업에서는 수정하지 않았다.
- no-IPC 경로는 소스나 package script를 수정하지 않고 `tsx` CLI만 Node의 공식 import hook으로 대체했다.

## npm 스크립트 Gap

이 sandbox에서 수정하지 않은 정확한 `npm run build`와 `npm run test:run`은 `tsx` CLI가 Unix IPC 소켓을 열 때 아래 오류로 실행 본체 시작 전에 실패했다.

```text
Error: listen EPERM: operation not permitted .../tsx-501/*.pipe
```

따라서 기본 `tsx` npm wrapper 자체의 정상 실행은 미검증이다. 동일 npm 스크립트 본체는 no-IPC import-hook 경로로 실행했고 build/typecheck는 통과했으며, 전체 test는 위의 기존 날짜 포인터 1건 때문에 비통과다. 사용자 전달 `runTest` 로그의 `filter: 결과:`는 `결과:`가 Vitest 파일 필터로 추가된 별도 호출 오류이며, 인자 없는 전체 실행 결과와 구분한다.

공식 delivery gate `run-delivery-gate.sh --full`도 동일 IPC 오류를 재현했고 exit `4`, `PASS=0 FAIL=4 SKIP=0`이었다. 네 실패는 dirty worktree inspection(`dirty-files: 123`)과 npm typecheck/test/build wrapper이며, 코드 본체 검증 결과와 구분한다.

## 등급·Gap·롤백

- [Evidence Tier 1] DB 행, 파일 내용, 명령 출력, 컴파일 결과, 실제 cursor-agent 프로세스 실행을 직접 확인했다.
- Gap:
  - 정확한 npm wrapper 실행은 sandbox IPC 정책으로 미검증.
  - 전체 회귀 1건은 날짜 포인터 불일치로 실패.
  - NCO HTTP `http://localhost:6200/api/health`는 curl exit `7`로 연결 불가해 런타임 통합 태스크 재실행은 미검증.
  - 팀 score 개선치는 런타임 재실행 전이므로 주장하지 않는다.
- 롤백:
  - 런타임 즉시 롤백: `NCO_CURSOR_AGENT_PATH_FALLBACK=off`
  - 코드 롤백: `provider-process-env.ts`와 테스트를 제거하고 두 호출부를 기존 `...process.env, ...provider.env` 병합으로 되돌린다.
- 팀 lifecycle/status/retirement 필드는 변경하지 않았다.
