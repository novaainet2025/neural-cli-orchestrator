# Collaboration Mesh cycle4 — 통지원 volume 면제 재검증 영수증

- 대상: `team_gov-command-collaboration`
- task: `task_WLq3xSO6z1leCGWR`
- 기준 HEAD: `4bccaf6f413791fd883f62563a3eeda20b7984d6`
- 검증일: 2026-07-28

## 변경

- `src/security/collaboration-loop-guard.ts`
  - 기존 작업트리 구현을 재사용했다. `nco-system` 통지원은
    `echo-loop`/`channel-burst` 볼륨 규칙만 면제한다.
  - `protocol-echo`는 발신자와 무관하게 계속 적용한다.
  - Gap-check에서 고유 protocol 통지의 21번째 메시지가 `channel-burst`로
    차단되는 조건 결합 오류를 확인했다. 기존 한 분기를 규칙별 조건으로 최소
    분리해 `channel-burst` 면제와 `protocol-echo` 보호가 동시에 성립하게 했다.
  - `NCO_MESH_LOOP_GUARD_NOTIFIERS=off`이면 면제를 해제해 기존 동작으로
    돌아간다.
  - 잘못된 ISO `T/Z` 문자열 비교에서 나온 `3018/844/27.97%` 주석은
    `julianday()` 고정 스냅샷 재검증값으로 정정했다.
- `src/security/collaboration-loop-guard.test.ts`
  - 통지원 면제, protocol-echo 유지, 일반 peer 보호, env rollback, 채널 파서를
    검증하는 기존 작업트리 테스트 5건을 재검증했다.
  - 고유 protocol 통지 burst 회귀와 env 격리를 기존 테스트에 보강했다.
  - 잘못된 `3018/844/27.97%` 증거 주석을 정정했다.
- 이번 단계의 중복 구현: **0건**. 기존 구현을 유지하면서 위 조건 결합 1곳과
  증거 주석만 정리했다.
- `src/core/team-scorer.ts` 및 `computeVolume`: **diff 0**.
- 팀 삭제·비활성화·lifecycle 쓰기: **0건**. 재조회한 팀 행은
  `is_active=1`, `is_always_on=1`이다.

## 실제 NCO 메시지 근거

상한 `2026-07-27T20:50:00.000Z`를 고정하고 SQLite
`julianday(created_at)`로 정확한 48시간만 선택했다. 동일 1,008건을 실제
`CollaborationLoopGuard`에 시간순으로 입력했다.

```text
{"upperBound":"2026-07-27T20:50:00.000Z","label":"flag-default","rows":1008,"unparsed":0,"blocked":0,"byRule":{},"bySender":{}}
{"upperBound":"2026-07-27T20:50:00.000Z","label":"flag-off","rows":1008,"unparsed":0,"blocked":7,"byRule":{"channel-burst":5,"echo-loop":2},"bySender":{"nco-system":7}}
```

판정: 기존 동작은 정상 `nco-system` 통지 7건을 볼륨 규칙으로 차단했다.
면제 적용 시 같은 표본의 차단은 0건이었다. `3018/844/27.97%`는 정확한
48시간 수치가 아니므로 이 영수증과 코드 주석에서 재사용하지 않는다.

## 반사실 A/B — flag off 기존 출력 바이트 동일

Oracle은 `git show HEAD:src/security/collaboration-loop-guard.ts`로 읽은 기존
구현이다. 고정 시각에서 peer 반복, 통지원 burst, 통지원 protocol-echo를 포함한
39개 입력의 decision 배열을 UTF-8 JSON으로 직렬화해 비교했다.

```text
{"flag":"off","oracle":"git HEAD:src/security/collaboration-loop-guard.ts","cases":39,"expectedBytes":5978,"actualBytes":5978,"expectedSha256":"a22b444547cea97d822ef1d74a189a6d4a78513bce5d9cf1414306ef48772538","actualSha256":"a22b444547cea97d822ef1d74a189a6d4a78513bce5d9cf1414306ef48772538","byteIdentical":true}
```

## 규칙별 조건 Gap-check

수정 전에는 고유 protocol 통지의 21번째 메시지가 `channel-burst`로 차단됐다.

```text
{"distinctProtocolMessages":30,"firstBlocked":{"index":20,"decision":{"allowed":false,"rule":"channel-burst","reason":"collaboration channel sent 21 messages within 60000ms","channel":"nco-system->sink","repeats":1,"windowCount":21,"cooldownUntil":1785186773504}}}
```

규칙별 조건을 분리한 뒤에는 고유 30건은 전부 통과하고, 동일 protocol 본문은
두 번째에 `protocol-echo`로 차단됐다.

```text
{"distinctProtocolMessages":30,"firstBlocked":null,"repeatedFirstAllowed":true,"repeatedSecondAllowed":false,"repeatedSecondRule":"protocol-echo"}
```

## 실행 로그 원문

### Typecheck

```text
$ npx tsc --noEmit
[stdout 없음]
exit_code=0
```

### 관련 Vitest

```text
$ npx vitest run src/security/collaboration-loop-guard.test.ts src/core/cli-mesh.test.ts src/core/collaboration.test.ts
 RUN  v4.1.10 /Users/nova-ai/project/nco
{"level":40,"time":1785186800368,"pid":68308,"hostname":"nova-macstudio","module":"cli-mesh","from":"a","to":"target-session","type":"info","delivery":{"messageId":"msg_0IaYSbf51uh5HCUE","targetSessionId":"target-session","status":"not_queued","queuedRecipients":0,"historyRecorded":false,"acknowledged":false,"reason":"collaboration_loop_blocked"},"loop":{"allowed":false,"rule":"protocol-echo","reason":"identical protocol collaboration message repeated 2x within 60000ms","channel":"sender-a->target-session","repeats":2,"windowCount":2,"cooldownUntil":1785186860368},"msg":"Mesh message blocked by collaboration-msg-loop guard"}
 Test Files  3 passed (3)
      Tests  30 passed (30)
   Duration  195ms (transform 149ms, setup 131ms, import 109ms, tests 19ms, environment 0ms)
exit_code=0
```

### TypeScript build

```text
$ npx tsc
[stdout 없음]
exit_code=0
```

빌드 뒤 `dist/security/collaboration-loop-guard.js`에서 직접 읽은 핵심 분기:

```text
const notifierExempt = resolved.notifierSenders?.has(channelSender(channel)) ?? false;
if (!(notifierExempt && !protocolPrefixed) && repeats > repeatCap) {
if (!notifierExempt && windowCount > resolved.maxMessagesPerWindow) {
```

### 공식 delivery gate

```text
$ /Users/nova-ai/.codex/plugins/cache/nova-use/nco-shared-toolkit/0.1.3/skills/nco-delivery-gate/scripts/run-delivery-gate.sh --full
[gate] FAIL project/worktree inspection
Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/48358.pipe
[gate] FAIL npm run typecheck
[gate] FAIL npm run test
[gate] FAIL npm run build
- [Gap] PASS=0 FAIL=4 SKIP=0
exit_code=4
```

직접 실행한 동일 기반의 `npx tsc --noEmit`, 관련 Vitest, `npx tsc`는 모두
exit 0이지만, 공식 npm wrapper는 `tsx` IPC pipe의 sandbox `listen EPERM`으로
실행되지 않았다. canonical checkout에는 이 작업 밖의 dirty 파일도 있어 inspection이
실패했다.

## 검증 영수증

- [변경] 위 소스/테스트 2개 경로의 기존 bounded 분기를 재검증하고, 규칙별 조건
  결합 1곳과 거짓 48시간 수치 주석을 정정했다. 본 영수증 1개를 추가했다.
- [검증방법] 정확한 DB 48시간 replay, 규칙별 조건 probe, Git HEAD oracle
  flag-off A/B, `npx tsc --noEmit`, 관련 Vitest 3 files/30 tests, `npx tsc`,
  생성된 dist 내용 직접 확인.
- [등급] **T1** — DB 행을 실제 함수에 replay한 출력, 파일 내용, Git HEAD
  source, 명령 출력과 생성된 dist를 현재 단계에서 직접 관찰했다.
- [Gap] DB replay, 규칙별 조건, flag-off A/B, typecheck, 관련 test/build를
  모두 관찰했다. 공식 delivery gate 4단계는 `PASS=0 FAIL=4`다.
- [미검증항목]
  - `localhost:6200`은 `curl` exit 7이어서 live health/agents/activity HTTP
    본문과 라이브 score는 미검증이다.
  - PM2 재기동과 실제 프로세스 적용은 수행하지 않았다.
  - 전체 저장소 test suite는 실행하지 않았고 관련 3개 파일 30개 테스트만 실행했다.
  - `.git/index.lock` 생성 권한이 없어 분리 커밋은 실행되지 않았다.
  - 기존 untracked cycle3 보고서·JSON·probe에는 잘못된 `3018/844/27.97%`가
    남아 있다. 다른 작업자의 dirty 산출물이므로 이 단계에서 수정하거나 커밋하지 않는다.

## 커밋 판단

**승인, 실행 차단.** 정확한 DB replay, 조건 Gap-check, flag-off 바이트 A/B, 직접
typecheck/test/build가 모두 통과했으며 변경은 notifier 판정 조건과 그 테스트에
한정된다. 이 소스·테스트와 본 영수증 3개 경로만 분리 커밋하는 것이 타당하고,
기존 cycle3 산출물 및 다른 dirty 파일은 제외해야 한다. 실제 `git add`는 아래
권한 오류로 실패했으며 cached diff는 비어 있다.

```text
fatal: Unable to create '/Users/nova-ai/project/nco/.git/index.lock': Operation not permitted
```

## 롤백

```bash
NCO_MESH_LOOP_GUARD_NOTIFIERS=off pm2 restart nco-backend --update-env
```
