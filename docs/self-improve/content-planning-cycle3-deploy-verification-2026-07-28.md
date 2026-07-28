# 콘텐츠 기획팀 cycle 3 배포 검증

- 대상: 콘텐츠 기획팀 (`content-planning`, `team_content-planning`)
- 기준일: 2026-07-28 KST
- 범위: 소스 재구현 없이 커밋 `9201a2291197ac02c85ef712a5086f4e25801297`의 배포 상태 검증
- 최신 실행 상태: **종결 — 14절 참조**. 안전 게이트 3종(`tsc` exit 0 / `npm run build`
  exit 0 / `npm run test:run` 725 pass·1 선재 실패)을 이번 실행에서 직접 통과시켰고,
  13절의 `tsx` IPC `listen EPERM` build 실패는 **재현되지 않았다**(환경 의존).
  배포 갭 전제는 이번 실행에서도 반증됐으며, 신규 프로세스가 현재 `dist/`로 계산한
  값이 라이브 API 응답과 **전 필드 일치**하므로 재기동 기대 효과가 0임을 재기동 없이
  증명했다. PM2 재기동은 의도적 미수행.
- 직전 실행 상태(참고): 13절 — 공식 `npm run build`가 `tsx` IPC `listen EPERM`으로
  실패해 지시된 안전 조건에 따라 PM2를 재기동하지 않은 부분 완료 기록.
- 이전 실행 판정: **종결 — 배포 갭 없음(전제 반증)**. 근본 패치 `9201a22`(2026-07-27T19:12:26Z)
  보다 실행 프로세스 기동(2026-07-27T20:31:24Z)이 **79분 늦어** "패치 이전 로직으로
  서빙 중"이라는 전제는 반증됐다. 결정적으로, 48h 실표본 9건에 패치 전 수식을
  적용하면 `7/8=87.5%·n=8`(= 지시문 스냅샷과 문자 그대로 일치), 패치 후 수식을
  적용하면 `6/7=85.7%·n=7`(= 라이브 응답과 일치)이므로 **지시문 수치는 미배포가
  아니라 패치 이전에 채집된 HR 스냅샷(stale)** 이다. 안전 게이트는 이번 단계에서
  전부 통과했다 — `tsc` exit 0(0줄), `npm run build` exit 0(이전 절의 `tsx` IPC
  실패 해소), `test:run` 725/726(유일 실패 `tests/근거.test.ts`는 `team_ax-collab`
  날짜 포인터 신선도 테스트로 선재·범위 밖), scorer 11/11, `/health` 200 본문,
  `:6201` WS 101+프레임 본문. PM2 재기동은 **의도적 미수행** — 현재 프로세스보다
  새로운 커밋은 `18ccf07` 하나이며 스코어러 diff가 0이라 재기동해도 대상 팀
  수치가 변할 수 없고, 무관한 mesh CB 면제를 운영 반영시키는 부작용만 남기 때문.
  12절 기록 당시의 독립 원문은 **12절**이며, 1~11절은 그보다 이전 실행 시점
  증거로 보존한다. 최신 현재 단계의 직접 증거는 **13절**이다.

## 1. 배포 갭 입증: 커밋시각과 기동시각 원문

### 1.1 Git 원문

명령:

```console
$ git log -1 --format='%H %cI'
d1a23cecadf015051318b2a8506f61c32cd008ae 2026-07-28T04:54:58+09:00

$ git show -s --format='%H %cI %s' 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ git merge-base --is-ancestor 9201a2291197ac02c85ef712a5086f4e25801297 HEAD
# exit 0
```

`git show 9201a22 -- src/core/team-scorer.ts src/core/team-scorer.test.ts`에서
`ZERO_OUTPUT_COMPLETED_EXCLUSION`과 그 가역성 테스트가 해당 커밋에 추가된 것도
직접 확인했다.

### 1.2 PM2 로그 원문

`/Users/nova-ai/.pm2/pm2.log`에서 직접 읽은 전후 행:

```text
897361:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897363:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897364:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] online
897388:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897392:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897393:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] online
```

현재 PID 파일 원문:

```text
/Users/nova-ai/.pm2/pids/nco-backend-0.pid|mtime=2026-07-28T05:00:24+0900|birth=2026-07-28T05:00:24+0900
pid=64863
```

시간 순서는 다음과 같다.

| 사건 | KST | 판정 |
|---|---:|---|
| 패치 이전 프로세스 기동 | 02:46:24 | 패치 커밋보다 빠름 |
| 근본원인 패치 `9201a22` | 04:12:26 | `02:46:24 < 04:12:26`으로 과거 배포 갭 T1 입증 |
| 현재 HEAD `d1a23ce` | 04:54:58 | `9201a22`를 포함함 |
| 현재 프로세스 기동 | 05:00:24 | HEAD보다 늦음; 현재 배포 갭은 이미 닫힘 |

따라서 현재 상태를 `기동시각 < 커밋시각`이라고 보고하는 것은 사실과 다르다.
그 부등식은 02:46:24 프로세스에는 성립했고, 현재 PID 64863에는 성립하지 않는다.

## 2. 타입체크·빌드·테스트 원출력

### 2.1 타입체크

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0
```

추가로 production emit 자체를 분리 확인했다.

```console
$ npx tsc
# stdout/stderr 없음
# exit 0
```

### 2.2 공식 build 스크립트

```console
$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/15450.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/15450.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

컴파일러 직접 실행은 통과했지만 공식 build 스크립트는 통과하지 않았다.
따라서 `build 오류 0`으로 간주하지 않는다.

### 2.3 공식 test 스크립트

```console
$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/25979.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/25979.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

관련 테스트를 래퍼 없이 직접 실행한 원출력:

```console
$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

{"level":30,"time":1785183240796,"pid":37923,"hostname":"nova-macstudio","module":"database","path":"/Users/nova-ai/project/nco/db/nco.db","msg":"SQLite connected (WAL mode)"}
{"level":30,"time":1785183240796,"pid":37923,"hostname":"nova-macstudio","module":"database","msg":"SQLite closed"}

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  05:14:00
   Duration  421ms (transform 179ms, setup 38ms, import 275ms, tests 29ms, environment 0ms)

# exit 0
```

전체 Vitest를 직접 실행한 요약과 실패 원문:

```text
 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
AssertionError: expected '2026-07-27' to be '2026-07-28' // Object.is equality

Expected: "2026-07-28"
Received: "2026-07-27"

 ❯ tests/근거.test.ts:26:28
     24|       day: '2-digit',
     25|     }).format(new Date());
     26|     expect(pointer.trim()).toBe(todayInSeoul);
       |                            ^
     27|   });
     28| });

 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 709 passed (710)
   Start at  05:14:36
   Duration  2.76s (transform 5.21s, setup 4.70s, import 13.27s, tests 6.31s, environment 5ms)
# exit 1
```

전체 실행의 대량 로거 stdout은 실행 도구가 중간을 잘라 반환했으므로 이 문서에
완전 수록하지 못했다. 위 실패 블록과 최종 합계는 반환된 원문 그대로다. 날짜 포인터
수정은 배포 갭이라는 현재 범위 밖이므로 변경하지 않았다.

## 3. 재기동 전후 score·completion 실측

현재 실행에서 API를 재호출한 값으로 꾸미지 않고, 재기동 경계 전후에 저장된
`team_lifecycle_events` DB 행을 그대로 사용한다. DB 시각은 UTC다.

```text
tle_kpn0A-ImlwiXMEVi|score_checked|83.4|87.5|8|91|2026-07-27 19:50:00
tle_wl_ZfP3DBhfgOV46|score_checked|83.3|87.5|8|92|2026-07-27 20:00:00
tle_M1EBdHAn4YaDCwc9|score_checked|81.5|85.7|7|89|2026-07-27 20:10:00
```

| 구분 | DB 시각 (UTC) | KST | score | completion | n | maxN |
|---|---:|---:|---:|---:|---:|---:|
| pre, 지시문 기준값과 일치 | 19:50:00 | 04:50:00 | 83.4 | 87.5 | 8 | 91 |
| 재기동 직전 10분 스냅샷 | 20:00:00 | 05:00:00 | 83.3 | 87.5 | 8 | 92 |
| post | 20:10:00 | 05:10:00 | 81.5 | 85.7 | 7 | 89 |

현재 HEAD 소스와 read-only DB를 직접 결합한 재계산 원문:

```console
$ node --import tsx --input-type=module -e '<read-only DB scorer invocation>'
◇ injected env (0) from .env // tip: ◈ encrypted .env [www.dotenvx.com]
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.5,"grade":"B","completion":85.7,"n":7,"maxN":90,"sample":"48h"}
# exit 0
```

`maxN`은 fleet-relative 현재값이라 저장된 20:10 스냅샷의 89에서 90으로 변했지만,
대상 팀의 반올림 score/completion/n은 `81.5/85.7/7`로 일치한다.

## 4. PM2·HTTP·WebSocket 확인과 재기동 결정

현재 환경의 PM2 제어 원문:

```text
connect EPERM /Users/nova-ai/.pm2/rpc.sock
Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
```

현재 환경의 health 요청 원문:

```console
$ curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://localhost:6200/health
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000
```

동시에 read-only 포트 조회는 다음 listener를 관측했다.

```text
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    64863 nova-ai   58u  IPv4 0x39e7c155100b41ff      0t0  TCP *:6200 (LISTEN)
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    64863 nova-ai   62u  IPv4 0x6acdc267087b6a3f      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

포트 listener는 프로세스 존재의 T2 증거일 뿐 `health` 200이나 WebSocket handshake의
대체 증거로 승격하지 않는다.

재기동을 수행하지 않은 이유:

1. 현재 PID의 기동시각이 HEAD보다 늦어 배포 갭이 이미 닫혀 있다.
2. 공식 `npm run build`가 exit 1이면 재기동하지 말라는 지시가 있다.
3. PM2 RPC socket 접근도 현재 샌드박스에서 `EPERM`이다.

따라서 이 실행에서 `npm run pm2:stop`, `npm run pm2:start`, 팀 lifecycle/status 변경,
팀 삭제·비활성화는 모두 수행하지 않았다.

## 5. 롤백 절차

- 이번 실행의 운영 변경은 0건이므로 PM2 롤백은 필요 없다.
- 소스 변경도 0건이다. 이 문서만 제거하면 문서 변경을 되돌릴 수 있으나, 이 실행에서는
  삭제하지 않는다.
- 기존 `9201a22` 동작의 런타임 롤백 스위치는 소스에
  `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`로 명시되어 있다. 실제 적용은
  운영 환경변수 변경 후 PM2 재기동이 필요하며, 현재 사이클 범위에서는 수행하지 않았다.
  커밋 checkout은 필요 없다.

## 6. 검증 영수증

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  1건 추가. 코드·스코어러 수식·DB lifecycle·팀 활성상태 변경 없음.
- [검증방법] Git hash/commit 시각, PM2 로그와 PID 파일, read-only lifecycle DB 행,
  read-only scorer 재계산, `lsof`, 타입체크와 테스트 명령 출력을 현재 실행에서 직접 확인.
- [등급] **T1** — 파일 내용, Git hash, DB 행, 명령 출력 직접 확인.
  단, listener 존재만으로 판단한 프로세스/포트 상태는 **T2**다.
- [Gap] 배포 갭의 과거 존재와 05:00:24 재기동 후 DB 점수 반영은 T1로 확인했다.
  공식 build/test 래퍼, 현재 HTTP 200, WebSocket handshake, 이 실행의 PM2 재기동은
  확인하지 못했으므로 전체 delivery gate는 미통과다.
- [미검증항목]
  - 권한이 허용된 운영 셸에서 `npm run build`와 `npm run test:run`이 통과하는지
  - `curl -sS localhost:6200/health`의 HTTP 200 본문
  - `ws://localhost:6201`의 새 WebSocket handshake
  - 이 실행에서의 재기동 후 API pre/post 비교(재기동 자체를 수행하지 않음)
  - HR 스냅샷 갱신(HR 전용 lifecycle 소관)

## 7. 현재 단계 재검증 원문 (2026-07-28 05:46~05:49 KST)

이 절은 현재 HEAD/PID/검증 명령에 관한 최신 원문이다. 1~6절의 02:46:24와
05:00:24 기록은 과거 배포 갭과 첫 갭 해소 경계를 보존한 것이다.

### 7.1 현재 HEAD와 프로세스 기동시각

```console
$ git log -1 --format="%H %cI"
4bccaf6f413791fd883f62563a3eeda20b7984d6 2026-07-28T05:30:33+09:00

$ git show -s --format="%H %cI %s" 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ git merge-base --is-ancestor 9201a2291197ac02c85ef712a5086f4e25801297 HEAD
# exit 0
```

`pm2 jlist`는 현재 샌드박스에서 다음 오류로 실행되지 않았다.

```text
connect EPERM /Users/nova-ai/.pm2/rpc.sock
Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
```

지시가 허용한 대체 증거로 PM2 로그, 현재 PID 파일, 포트 소유 PID를 직접 대조했다.

```text
897361:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897363:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897364:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] online
897388:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897392:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897393:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] online
897418:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897421:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897422:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] online

/Users/nova-ai/.pm2/pids/nco-backend-0.pid|mtime=2026-07-28T05:31:24+0900|birth=2026-07-28T05:31:24+0900
18727

COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   56u  IPv4 0xf31862b268aad08a      0t0  TCP *:6200 (LISTEN)
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   60u  IPv4 0xb528b69ef1e19fb6      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

현재 순서는 `05:31:24 > 05:30:33 > 04:12:26`이다. 따라서 현재 PID 18727에는
요청서의 `기동시각 < 커밋시각`이 성립하지 않는다. 반면 과거 PID의 기동을 나타내는
PM2 로그 `02:46:24 < 04:12:26`은 패치 커밋 당시 배포 갭이 있었음을 입증한다.

### 7.2 타입체크·빌드·테스트

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0

$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29519.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29519.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1

$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29842.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29842.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 래퍼가 IPC 생성 전에 중단됐으므로 컴파일러 emit과 관련 scorer 테스트를
래퍼 없이 분리 실행했다.

```console
$ npx tsc
# stdout/stderr 없음
# exit 0

$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

{"level":30,"time":1785185315384,"pid":37083,"hostname":"nova-macstudio","module":"database","path":"/Users/nova-ai/project/nco/db/nco.db","msg":"SQLite connected (WAL mode)"}
{"level":30,"time":1785185315385,"pid":37083,"hostname":"nova-macstudio","module":"database","msg":"SQLite closed"}

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  05:48:35
   Duration  893ms (transform 243ms, setup 68ms, import 592ms, tests 65ms, environment 0ms)

# exit 0
```

직접 컴파일과 관련 테스트의 통과는 공식 `npm run build` 및 `npm run test:run`의
실패를 PASS로 바꾸지 않는다.

### 7.3 score·completion 현재 실측과 pre/post 경계

read-only DB의 최근 행:

```text
tle_IyyqDtML77T7oU_J|score_checked|81.5|85.7|7|90|2026-07-27 20:40:00
tle_u_xtpE3Aw5EIIiye|score_checked|81.5|85.7|7|90|2026-07-27 20:30:00
tle_L99iW2n_8vzx6S3d|score_checked|81.5|85.7|7|90|2026-07-27 20:20:00
tle_M1EBdHAn4YaDCwc9|score_checked|81.5|85.7|7|89|2026-07-27 20:10:00
tle_wl_ZfP3DBhfgOV46|score_checked|83.3|87.5|8|92|2026-07-27 20:00:00
tle_kpn0A-ImlwiXMEVi|score_checked|83.4|87.5|8|91|2026-07-27 19:50:00
```

현재 HEAD scorer와 read-only DB의 직접 재계산:

```console
$ node --import tsx --input-type=module -e '<read-only DB scorer invocation>'
◇ injected env (0) from .env // tip: ⌘ multiple files { path: ['.env.local', '.env'] }
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.5,"grade":"B","completion":85.7,"n":7,"maxN":90,"sample":"48h"}
# exit 0
```

현재 단계의 재기동 전 값은 `81.5 / 85.7 / n=7`이다. 공식 build가 실패해
재기동하지 않았으므로 이 단계의 post 값은 **미측정**이다. 3절의
`83.3 / 87.5 / n=8`에서 `81.5 / 85.7 / n=7`로 변한 행은 05:00:24 KST
재기동 전후의 과거 DB 실측이며, 이번 단계에서 새로 만든 pre/post라고 주장하지 않는다.

팀 행은 현재 다음과 같으며 lifecycle/status를 변경하지 않았다.

```text
team_content-planning|content-planning|콘텐츠 기획팀|1
```

### 7.4 현재 런타임 검증과 재기동 결정

```console
$ curl -sS http://localhost:6200/health
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

$ node -e '<ws://127.0.0.1:6201 handshake>'
WS_ERROR connect EPERM 127.0.0.1:6201 - Local (0.0.0.0:0)
```

`lsof`로 포트 listener는 관측했지만 이는 T2 프로세스 증거이며 HTTP 200 본문이나
WebSocket handshake를 대체하지 않는다. 공식 build 실패 시 재기동하지 말라는 지시에
따라 `npm run pm2:stop`, `npm run pm2:start`, `npm run pm2:restart`를 실행하지 않았다.

### 7.5 현재 단계 검증 영수증

- [변경] 이 문서의 현재 단계 재검증 절만 갱신. 소스·scorer 수식·DB·팀 lifecycle/status
  변경 0건. 시작 시 이미 존재한 다른 dirty 파일은 수정하거나 되돌리지 않았다.
- [검증방법] Git hash/commit 시각, PM2 로그/PID 파일, `lsof`, read-only DB 행과
  scorer 재계산, 타입체크·build·test 명령 출력을 현재 단계에서 직접 확인.
  `run-delivery-gate.sh --full`도 실행했으며 exit 4,
  `PASS=0 FAIL=4 SKIP=0`이었다(project/worktree inspection 및 npm wrapper
  typecheck/test/build 실패).
- [등급] **T1** — 파일 내용, Git hash, DB 행, 명령 출력. 포트 listener 존재는
  **T2** — 프로세스 존재만 확인.
- [Gap] 전체 delivery gate 미통과. 공식 build/test 래퍼, 현재 HTTP 200,
  WebSocket handshake, 이 단계의 PM2 재기동과 post score가 완료되지 않았다.
  필수 항목이 남아 있어 임의의 완료 백분율은 부여하지 않는다.
- [미검증항목] 권한이 허용된 운영 셸의 공식 build/test 성공, HTTP 200 본문,
  WebSocket handshake, 이 단계 재기동 후 post score, HR 스냅샷 갱신.
- [되돌리기] 이번 단계의 운영·소스 변경은 0건이므로 런타임 롤백은 필요 없다.
  문서 변경만 역패치하면 현재 단계 변경이 원복된다. 향후 동일 HEAD를 재기동한 뒤
  운영상 원복이 필요하면 같은 PM2 restart 절차로 다시 기동하며, 커밋 checkout은
  필요 없다.

---

## 8. cycle 3 최종 실행 — 안전 게이트 종결과 배포 갭 반증 (2026-07-28 05:45~05:56 KST)

7절까지의 실행은 샌드박스 권한(`EPERM /Users/nova-ai/.pm2/rpc.sock`, tsx IPC)
때문에 `pm2 jlist`·`npm run build`·`npm run test:run`을 완료하지 못한 채
`status:`로 종료했다. 이번 실행에서는 세 명령이 모두 정상 동작했으므로 남아 있던
안전 게이트를 종결하고, 그 결과 **지시문이 전제한 배포 갭이 존재하지 않음**을
직접 반증했다.

### 8.1 배포 갭 입증 시도 → 반증 (원문)

```console
$ TZ=UTC git log -1 --format='%H %cd' --date=format-local:'%Y-%m-%dT%H:%M:%SZ'
4bccaf6f413791fd883f62563a3eeda20b7984d6 2026-07-27T20:30:33Z

$ npx pm2 jlist   # nco-backend 항목만 발췌 (비밀값 제외)
{"name":"nco-backend","pid":18727,"status":"online","restart_time":64,
 "pm_uptime":1785184284716,"pm_uptime_iso":"2026-07-27T20:31:24.716Z",
 "script":"/Users/nova-ai/project/nco/dist/index.js"}

$ curl -s http://localhost:6200/health
{"status":"healthy","service":"nco-backend","version":"1.0.0",
 "ports":{"api":6200,"ws":6201},"providerCount":9,
 "runtime":{"redis":true,"agentsOnline":9,"uptime":1301.857644584},
 "timestamp":"2026-07-27T20:53:06.611Z"}
```

`health.uptime`을 역산하면 기동 시각은 `20:53:06.611Z − 1301.86s ≈ 20:31:24Z`로
`pm2 jlist`의 `pm_uptime`과 독립적으로 일치한다.

| 항목 | 시각 (UTC) | KST |
|---|---:|---:|
| HEAD 커밋 `4bccaf6` | 2026-07-27T20:30:33Z | 05:30:33 |
| `nco-backend` 기동 (pm_uptime) | 2026-07-27T20:31:24.716Z | 05:31:24 |

**기동시각 − 커밋시각 = +51초.** 지시문이 요구한 `기동시각 < 커밋시각`은
성립하지 않는다. 즉 현재 프로세스는 HEAD보다 **뒤에** 기동했다.

### 8.2 실행 중인 코드가 HEAD와 동일함을 직접 증명

시각 비교만으로는 "기동 시점의 `dist/`가 HEAD 소스에서 나온 것인가"를 말할 수
없으므로 두 가지를 추가로 확인했다.

(a) 현재 `dist/`가 HEAD 재빌드 결과와 바이트 동일:

```console
$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256   # 빌드 전
8f4cfcb5670e8c72ea086baaf6d11af56bb9f482e3207bd55a431e0c48eb15ea  -
$ npm run build ; echo $?
0
$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256   # 빌드 후
8f4cfcb5670e8c72ea086baaf6d11af56bb9f482e3207bd55a431e0c48eb15ea  -
# DIST_IDENTICAL=yes
$ shasum -a 256 dist/core/team-scorer.js
dc64dc2fb56bb2bf500857dffd4a52f108ef44ff69b90afe95c2232e461b9981  dist/core/team-scorer.js
```

또한 `src/core/team-scorer.ts`의 mtime은 `2026-07-27T19:51:34Z`로 프로세스
기동(`20:31:24Z`)보다 **앞선다**. 기동 이후 스코어러 소스가 바뀐 적이 없고,
현재 `dist`가 HEAD 재빌드와 바이트 동일하므로 PID 18727이 로드한 스코어러는
HEAD 스코어러다.

(b) HEAD **소스**(dist 아님)로 동일 DB를 재계산한 값과 라이브 API 응답 대조:

```console
$ curl -s http://localhost:6200/api/teams/scores      # 라이브 프로세스(PID 18727)
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
 "organizationId":"org_sns-blog","score":81.5,"grade":"B","completion":85.7,
 "n":7,"maxN":90,"sample":"48h"}

$ npx tsx /tmp/nco_recompute_head.ts                   # src/core/team-scorer.ts 직접 import
HEAD_SOURCE_RECOMPUTE={"teamId":"team_content-planning","slug":"content-planning",
 "name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.5,"grade":"B",
 "completion":85.7,"n":7,"maxN":90,"sample":"48h"}
```

**라이브 응답 == HEAD 소스 재계산 (score/grade/completion/n/maxN 전 필드 일치).**
재기동으로 얻을 수 있는 변화가 없음이 실측으로 확정됐다.

### 8.3 48h 표본 원문 (라이브 DB, read-only)

```console
$ sqlite3 -readonly db/nco.db "SELECT id,status,assigned_to,LENGTH(CAST(COALESCE(response,'') AS BLOB)),substr(COALESCE(error,''),1,60),created_at FROM tasks WHERE team_id='team_content-planning' AND created_at >= datetime('now','-48 hours') ORDER BY created_at DESC;"
task_trend_collector|completed|mlx|0||2026-07-27 20:18:15
task_content_generation|failed|cursor-agent|0|cursor-agent: CLI failed exit=unknown — Command failed with |2026-07-27 17:10:06
task_NTFmch7UjbcOYnqh|completed|agy|3443||2026-07-27 15:00:06
task_wbmNJYskCFXrjmCE|completed|agy|3199||2026-07-27 05:12:09
task_bdP-dIFNni_P814l|completed|agy|2278||2026-07-27 00:00:33
task_mUctLweT5Iuokwf9|completed|agy|3398||2026-07-26 15:00:06
task_JAg7_6r9hm4tuMtG|completed|agy|4239||2026-07-26 08:00:05
task_xxMo-aMaiO3ofrpO|completed|claude-code|1850||2026-07-26 05:08:59
task_gudqikH8LkuQ6-Cy|failed|opencode|0|Circuit breaker open for agent opencode (generic)|2026-07-26 00:03:33
```

9행 → 분모 제외 2건(`task_content_generation` spawn failure,
`task_gudqikH8LkuQ6-Cy` CB/infra) → `n=7`. 분자 제외 1건
(`task_trend_collector` 0B completed) → `6/7 = 85.7%`. 라이브·HEAD 값과 정합.
신규 미커버 실패 유형 0건.

### 8.4 안전 게이트 원출력 (7절에서 미해결이던 항목 종결)

```console
$ npx tsc --noEmit ; echo "TSC_EXIT=$?"
TSC_EXIT=0
TSC_LINES=0

$ npm run build ; echo "BUILD_EXIT=$?"
BUILD_EXIT=0
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc
{"level":30,...,"module":"database","msg":"SQLite connected (WAL mode)"}
{"level":30,...,"module":"database","msg":"SQLite closed"}

$ npm run test:run ; echo "TEST_EXIT=$?"
 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
AssertionError: expected '2026-07-27' to be '2026-07-28' // Object.is equality
 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 725 passed (726)
   Duration  2.62s
TEST_EXIT=1
```

유일한 실패는 `tests/근거.test.ts`의 날짜 포인터 단언이다. 원인은 코드가 아니라
데이터 파일이다.

```console
$ cat data/team-runner/team_ax-collab.last
2026-07-27
$ TZ=UTC stat -f '%Sm %N' -t '%Y-%m-%dT%H:%M:%SZ' data/team-runner/team_ax-collab.last
2026-07-26T16:28:52Z data/team-runner/team_ax-collab.last
```

`team_ax-collab`의 일일 보고서가 오늘자로 생성되기 전까지 매일 실패하는
시각 의존 테스트이며, `team_content-planning`·스코어러와 무관하다. 이번 단계에서
소스 변경이 0건이므로 이 실패는 회귀가 아니라 기존 상태다. 범위 밖이라
수정하지 않았다.

### 8.5 HTTP·WebSocket 확인

```console
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:6200/health
200

$ curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    http://localhost:6201/
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

{"type":"connected","clientId":"W0l83zRIHF_m","timestamp":"2026-07-27T20:55:21.463Z","path":"/"}
```

### 8.6 재기동을 실행하지 않은 근거

지시문은 재기동을 `기동시각 < 커밋시각` 입증(단계 1)에 조건부로 두었고
(`(4) 그 다음에만 … 재기동`), 8.1에서 그 전제가 **반증**됐다. 더해 재기동은
현재 실행 중인 작업을 중단시킨다.

```console
$ sqlite3 -readonly db/nco.db "SELECT id,status,assigned_to,created_at FROM tasks WHERE status='running' ORDER BY created_at DESC;"
task_JG29Y8DK-WdksxlI|running|claude-code|2026-07-27 20:52:19
task_O1gGI92G1k4ZZ0WF|running|codex|2026-07-27 20:50:56
```

기대 효과 0(8.2에서 라이브 == HEAD 확정) 대비 in-flight 작업 2건 중단이라는
실제 회귀 위험이 있으므로 재기동하지 않았다. 이는 범위 축소가 아니라 지시문
자체의 조건 분기를 따른 것이다. HR이 그럼에도 재기동을 원하면
`npm run pm2:stop && npm run pm2:start` 한 번으로 충분하며, 8.2 근거상
score/completion은 `81.5/85.7/n=7`로 동일할 것으로 예측된다(미검증).

### 8.7 pre/post score 실측 (재기동 경계 기준)

이번 단계는 재기동을 하지 않았으므로 새 pre/post 경계를 만들지 않았다.
직전 재기동(2026-07-27T20:31:24Z) 경계의 실측은 3절 표가 유일한 실측이며,
현재 라이브 값이 그 post 값과 계속 일치함을 8.2에서 재확인했다.

| 구분 | 시각 | score | completion | n |
|---|---:|---:|---:|---:|
| pre (지시문 기준값) | 2026-07-27 19:50:00Z | 83.4 | 87.5 | 8 |
| post (재기동 후 스냅샷) | 2026-07-27 20:10:00Z | 81.5 | 85.7 | 7 |
| 현재 라이브 (본 단계 실측) | 2026-07-27 20:53Z | 81.5 | 85.7 | 7 |
| HEAD 소스 재계산 (본 단계 실측) | 2026-07-27 20:54Z | 81.5 | 85.7 | 7 |

지시문 헤더의 `83.4 / 87.5% / n=8`은 HR 스냅샷이 갱신되지 않아 남은 값이다.
코드·라이브는 이미 일치하므로 남은 조치는 **HR 스냅샷 갱신**뿐이며, 이는
HR 소관이다.

### 8.8 롤백 절차

- 소스·`dist`·DB·팀 lifecycle/status 변경 0건 → 런타임 롤백 불필요.
- 이 문서 8절만 역패치하면 본 단계 변경이 완전 원복된다.
- (참고) 향후 재기동 후 원복이 필요하면 커밋 checkout 없이
  `npm run pm2:stop && npm run pm2:start`만으로 동일 HEAD를 재기동한다.
- 스코어러 제외 규칙은 여전히 `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`,
  `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`로 독립 비활성화 가능.

### 8.9 검증 영수증

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  8절 추가. 그 외 소스·`dist`·DB·스코어러 수식·팀 lifecycle/status 변경 **0건**.
  실행 시작 시점에 이미 dirty였던 타 세션 파일
  (`src/security/collaboration-loop-guard.ts` 등)은 건드리지 않았다.
- [검증방법] `git log -1`(UTC) + `npx pm2 jlist`(`pm_uptime`) + `curl /health`
  `uptime` 역산 3중 대조 / `shasum -a 256` dist 빌드 전후 동일성 /
  `npx tsx` HEAD 소스 재계산 vs `curl /api/teams/scores` 본문 대조 /
  `sqlite3 -readonly` 48h 9행 / `npx tsc --noEmit` exit 0, 0줄 /
  `npm run build` exit 0 / `npm run test:run` 725 passed·1 failed /
  `curl` WS 101 Switching Protocols 본문
- [등급] **T1** — Git hash, PM2 JSON 필드, HTTP 응답 본문, DB 행, 파일 해시,
  컴파일·테스트 원출력을 직접 확인. WS는 101 핸드셰이크 + `connected` 프레임
  본문까지 확인해 T1.
- [Gap] 지시 4개 항목(사전증거·tsc/build·test·HTTP/WS) 종결. 5번째 항목인
  재기동+post 측정은 **전제 반증으로 미실행**(8.6). 스코어러 범위 자체는 100%
  — 48h 9건 전부 기존 커밋 규칙으로 설명되고 신규 미커버 0건.
- [미검증항목] (a) 실제 재기동 후 값이 `81.5/85.7/n=7`로 유지되는지 —
  재기동을 하지 않았으므로 예측일 뿐 미검증. (b) HR 스냅샷 갱신 파이프라인
  (HR 소관, 미관측). (c) `task_trend_collector`에 0B completed를 주입하는
  upstream `nova-sns` cron (범위 밖, 미수정). (d) `tests/근거.test.ts`
  날짜 포인터 실패의 항구적 해결(범위 밖).

## 9. 현재 task 재검증 — build 실패로 재기동 중단 (2026-07-28 06:13~06:16 KST)

이 절은 `task_S6aJ7AQ8iImnxumi`에서 새로 실행한 결과다. 앞 절의 명령 결과를
현재 상태로 재사용하지 않았다. 공식 build가 실패하면 재기동하지 말라는 지시에
따라 `npm run pm2:stop`과 `npm run pm2:start`는 실행하지 않았다.

### 9.1 Git·프로세스 시각 원문

```console
$ git log -1 --format='%H %cI'
4bccaf6f413791fd883f62563a3eeda20b7984d6 2026-07-28T05:30:33+09:00

$ git show -s --format='%H %cI %s' 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ pm2 jlist
connect EPERM /Users/nova-ai/.pm2/rpc.sock
node:fs:556
  return binding.open(
                 ^

Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
    at Object.openSync (node:fs:556:18)
    at Client.launchDaemon (/opt/homebrew/lib/node_modules/pm2/lib/Client.js:228:12)
    at /opt/homebrew/lib/node_modules/pm2/lib/Client.js:104:10
    at /opt/homebrew/lib/node_modules/pm2/lib/Client.js:318:14
    at processTicksAndRejections (node:internal/process/task_queues:85:11)
    at runNextTicks (node:internal/process/task_queues:69:3)
    at listOnTimeout (node:internal/timers:567:9)
    at process.processTimers (node:internal/timers:541:7) {
  errno: -1,
  code: 'EPERM',
  syscall: 'open',
  path: '/Users/nova-ai/.pm2/pm2.log'
}

Node.js v25.9.0
```

`pm2 jlist`가 권한 오류로 실패했으므로 지시가 허용한 프로세스 기동 시각 대체
증거를 읽었다.

```text
/Users/nova-ai/.pm2/pids/nco-backend-0.pid|mtime=2026-07-28T05:31:24+0900|birth=2026-07-28T05:31:24+0900
18727
897361:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897363:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897364:2026-07-28T02:46:24: PM2 log: App [nco-backend:0] online
897418:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897421:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897422:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] online

COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   56u  IPv4 0xf31862b268aad08a      0t0  TCP *:6200 (LISTEN)
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   60u  IPv4 0xb528b69ef1e19fb6      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

과거 기동 `02:46:24 < 9201a22 04:12:26`으로 당시 배포 갭은 입증된다. 그러나
현재 PID 기동 `05:31:24 > HEAD 05:30:33 > 9201a22 04:12:26`이므로 현재
프로세스에 대해서는 요청서의 `기동시각 < 커밋시각`이 성립하지 않는다.

### 9.2 typecheck·build·test 현재 원출력

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0
```

```console
$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29451.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29451.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

```console
$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29753.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/29753.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 test 래퍼가 테스트 진입 전에 중단됐으므로 관련 스코어러 테스트만 직접
실행했다.

```console
$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

{"level":30,"time":1785186935563,"pid":62454,"hostname":"nova-macstudio","module":"database","path":"/Users/nova-ai/project/nco/db/nco.db","msg":"SQLite connected (WAL mode)"}
{"level":30,"time":1785186935563,"pid":62454,"hostname":"nova-macstudio","module":"database","msg":"SQLite closed"}

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  06:15:35
   Duration  429ms (transform 182ms, setup 36ms, import 284ms, tests 28ms, environment 0ms)
# exit 0
```

관련 테스트 11건은 통과했지만 공식 `npm run test:run`은 exit 1이므로 전체
테스트 통과로 보고하지 않는다.

### 9.3 재기동·HTTP·WebSocket·score 측정

공식 build 실패 때문에 PM2 재기동을 실행하지 않았다. 현재 샌드박스의 HTTP와
WebSocket 요청 원문:

```console
$ curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://localhost:6200/health
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000

$ curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://localhost:6200/api/teams/scores
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000

$ curl -sS -i --max-time 3 -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://localhost:6201/
curl: (7) Failed to connect to localhost port 6201 after 0 ms: Couldn't connect to server
```

따라서 `lsof`의 listener 관측은 T2 프로세스 증거로만 취급하며 HTTP 200 또는
WebSocket 정상으로 승격하지 않는다. 라이브 API pre 값은 미검증이다. 대신
read-only DB의 최신 저장 스냅샷을 pre 참고값으로 기록한다.

```text
tle_NOLir9qpSlHLfCES|score_checked|81.4|85.7|7|91|2026-07-27 21:10:00
tle_LrGwyhkjHBdSU4HD|score_checked|81.5|85.7|7|90|2026-07-27 21:00:00
tle_yyvLmACZ3R8cL2u9|score_checked|81.5|85.7|7|90|2026-07-27 20:50:00
```

| 구분 | 시각 (UTC) | score | completion | n | 근거 |
|---|---:|---:|---:|---:|---|
| pre 참고값 | 2026-07-27 21:10:00 | 81.4 | 85.7 | 7 | DB 저장 행, T1 |
| post | 미생성 | 미검증 | 미검증 | 미검증 | 재기동 미실행 |

`81.4`는 현재 라이브 HTTP 실측값이 아니라 DB 저장 스냅샷이다. 재기동 후 post
수치는 생성하지 않았으며, 이전 값으로 대체하거나 예측하지 않는다.

### 9.4 롤백 절차

- PM2·소스·DB·팀 lifecycle/status 변경은 0건이므로 운영 롤백은 필요 없다.
- 이번 task가 추가한 9절만 역패치하면 문서 변경이 원복된다.
- 향후 권한이 있는 환경에서 안전 게이트가 모두 통과한 뒤 재기동한 경우에는
  커밋 checkout 없이 `npm run pm2:stop && npm run pm2:start`로 같은 HEAD를
  다시 기동하는 절차가 가역 경계다.

### 9.5 검증 영수증

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  9절 추가. 코드·스코어러 수식·DB·팀 lifecycle/status 변경 없음.
- [검증방법] Git hash/시각, PM2 로그·PID 파일, `lsof`, read-only DB 행,
  `npx tsc --noEmit`, `npm run build`, `npm run test:run`, 관련 Vitest,
  HTTP·WebSocket 요청 원문을 현재 task에서 직접 확인.
- [등급] **T1** — Git hash, 파일 내용, DB 행, 명령 출력 직접 확인.
  PID/listener 존재는 **T2**이며 HTTP/WS 동작 증거가 아니다.
- [Gap] 과거 배포 갭과 현재 프로세스가 HEAD 이후 기동됐음은 확인했다.
  typecheck와 관련 테스트는 통과했다. 공식 build/test 래퍼, PM2 RPC,
  HTTP/WS, 재기동 후 post score는 미완료다.
- [미검증항목] (a) 권한 있는 셸에서 공식 build/test가 통과하는지,
  (b) `/health` HTTP 200 본문과 `:6201` WebSocket 101 응답,
  (c) 실제 재기동 후 score/completion/n, (d) HR 스냅샷 갱신(HR 소관).

## 10. cycle 3 종결 실행 — 안전 게이트 전부 통과, 배포 갭 반증 확정 (2026-07-28 06:17~06:22 KST)

9절은 샌드박스 권한 때문에 공식 `npm run build`·`npm run test:run`·`pm2 jlist`가
실패한 상태로 종료했다. 이번 실행에서는 **세 명령이 모두 정상 동작**했으므로
9절이 남긴 안전 게이트를 종결한다. 결론은 8절과 같으나, 근거가 HEAD *소스*
재계산에서 **실제 라이브 프로세스가 로드하는 `dist/` 아티팩트** 재계산으로
격상됐다.

### 10.1 배포 갭 입증 시도 → 반증 (원문)

```console
$ git log -1 --format='%H %cI %s'
4bccaf6f413791fd883f62563a3eeda20b7984d6 2026-07-28T05:30:33+09:00 Fixed bug in team scorer, improved completion to 87.5%

$ git log -5 --format='%h %cI %ct'
4bccaf6 2026-07-28T05:30:33+09:00 1785184233
d1a23ce 2026-07-28T04:54:58+09:00 1785182098
a8c285a 2026-07-28T04:39:24+09:00 1785181164
93a6f8c 2026-07-28T04:25:41+09:00 1785180341
9201a22 2026-07-28T04:12:26+09:00 1785179546

$ npx pm2 jlist   # nco-backend 항목, pm_uptime → ISO 변환
name=nco-backend pid=18727 status=online restarts=64
  pm_uptime_epoch_ms=1785184284716  started_utc=2026-07-27T20:31:24.716000+00:00  started_kst=2026-07-28T05:31:24.716000+00:00
  script=/Users/nova-ai/project/nco/dist/index.js  interpreter=node
```

독립 3차 대조 — `/health`의 `uptime`(초) 역산:

```console
$ date -u '+%Y-%m-%dT%H:%M:%SZ' && curl -s localhost:6200/health
2026-07-27T21:17:47Z
{"status":"healthy","service":"nco-backend","version":"1.0.0","ports":{"api":6200,"ws":6201},
 "providerCount":9,"runtime":{"redis":true,"agentsOnline":9,"uptime":2783.017397584},
 "timestamp":"2026-07-27T21:17:47.776Z"}
```

`21:17:47.776Z − 2783.017s = 20:31:24.76Z` — `pm_uptime`과 일치.

| 항목 | 시각 (UTC) | KST |
|---|---:|---:|
| 근본원인 패치 `9201a22` | 2026-07-27T19:12:26Z | 04:12:26 |
| HEAD 커밋 `4bccaf6` | 2026-07-27T20:30:33Z | 05:30:33 |
| `nco-backend` 기동 (`pm_uptime`) | 2026-07-27T20:31:24.716Z | 05:31:24 |

**기동시각 − HEAD 커밋시각 = +51초.** 지시문이 T1으로 입증하라고 요구한
`기동시각 < 커밋시각`은 **성립하지 않는다**. 즉 지시문이 전제한 배포 갭은
현재 프로세스에 존재하지 않는다. (과거 `02:46:24` 기동 프로세스에는 성립했고,
그 갭은 `05:00:24`·`05:31:24` 재기동으로 이미 닫혔다 — 1·7절 원문.)

### 10.2 라이브 프로세스가 현재 `dist/`와 동일 로직임을 아티팩트 수준에서 증명

시각 비교만으로는 "기동 시점의 `dist/`가 HEAD에서 나온 것인가"를 단정할 수 없다.
게다가 `dist/core/team-scorer.js`의 mtime(`2026-07-28T06:17:37` KST)은 프로세스
기동(`05:31:24`)보다 **뒤**라서, 오히려 "라이브가 현재 dist보다 오래된 코드일
가능성"을 먼저 배제해야 한다. 두 단계로 확인했다.

(a) 현재 `dist/`가 HEAD 재빌드 결과와 **바이트 동일** (329개 `.js` 집계 해시):

```console
$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256   # 빌드 전
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
$ find dist -name '*.js' | wc -l
     329
$ npm run build ; echo "BUILD_EXIT=$?"
BUILD_EXIT=0
$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256   # 빌드 후
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
# DIST_UNCHANGED (fresh build == on-disk dist)
```

(b) 라이브 프로세스가 실제로 로드하는 **`dist/` 아티팩트**를 별도 프로세스에서
직접 import해 동일 DB로 재계산하고, 같은 시점 라이브 HTTP 응답과 대조:

```console
$ cat /tmp/c3-fresh-score.mjs
import { computeTeamScores } from '/Users/nova-ai/project/nco/dist/core/team-scorer.js';
const rows = computeTeamScores();
const r = rows.find(x => String(x.teamId).includes('content-planning'));
console.log('FRESH_DIST_COMPUTE:', JSON.stringify(r));

$ node /tmp/c3-fresh-score.mjs
FRESH_DIST_COMPUTE: {"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}

$ curl -s localhost:6200/api/teams/scores      # 동일 시점, PID 18727
LIVE_HTTP: [{"teamId": "team_content-planning", "slug": "content-planning", "name": "콘텐츠 기획팀", "organizationId": "org_sns-blog", "score": 81.4, "grade": "B", "completion": 85.7, "n": 7, "maxN": 91, "sample": "48h"}]
```

**전 필드 일치 (`score`·`grade`·`completion`·`n`·`maxN`·`sample`).** 8.2절은
HEAD *소스* 재계산으로 `81.5`를 얻었으나, 이번에는 라이브가 실제 로드하는
컴파일 아티팩트로 재계산해 `81.4`까지 **소수점 자리 그대로** 일치시켰다
(8절 시점 대비 0.1 차이는 48h 롤링 윈도우 이동이며, 같은 시점 비교에서는 차이 0).
→ 재기동으로 얻을 점수 변화는 **0**임이 실측 확정됐다.

`src/core/team-scorer.ts`의 mtime(`2026-07-27T19:51:34Z`)도 기동(`20:31:24Z`)보다
앞서므로, 기동 이후 스코어러 소스가 바뀐 적이 없다.

### 10.3 안전 게이트 원출력 — 9절 미해결 항목 종결

```console
$ npx tsc --noEmit ; echo "TSC_EXIT=$?"
TSC_EXIT=0
# 출력 0줄 (/tmp/c3-tsc.txt: LINES=0)

$ npm run build ; echo "BUILD_EXIT=$?"
> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc
◇ injected env (0) from .env
{"level":30,"time":1785187171345,"pid":25866,...,"module":"database","msg":"SQLite connected (WAL mode)"}
{"level":30,"time":1785187171355,"pid":25866,...,"module":"database","msg":"SQLite closed"}
BUILD_EXIT=0

$ npm run test:run ; echo "TEST_EXIT=$?"
 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
AssertionError: expected '2026-07-27' to be '2026-07-28' // Object.is equality

Expected: "2026-07-28"
Received: "2026-07-27"

 ❯ tests/근거.test.ts:26:28
     24|       day: '2-digit',
     25|     }).format(new Date());
     26|     expect(pointer.trim()).toBe(todayInSeoul);
       |                            ^
     27|   });
     28| });

 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 725 passed (726)
   Start at  06:18:44
   Duration  2.67s
TEST_EXIT=1
```

9절에서 `EPERM`으로 실패했던 공식 `npm run build`는 이번 실행에서 **exit 0**으로
통과했다 → cycle2·cycle3에 걸쳐 남아 있던 빌드 확인 항목 **종결**.

`npm run test:run`의 유일한 실패는 코드가 아니라 데이터 파일 원인이다.

```console
$ cat data/team-runner/team_ax-collab.last
2026-07-27
$ git status --porcelain -- tests/근거.test.ts
# 출력 없음 (미변경)
$ git log -1 --format='%h %cI' -- tests/근거.test.ts
5ac31fa 2026-07-27T16:10:26+09:00
```

`tests/근거.test.ts:26`은 `team_ax-collab` 일일 보고서 포인터가 **오늘(Asia/Seoul)**
날짜와 같기를 단언한다. 포인터는 `2026-07-27`, 오늘은 `2026-07-28`이므로 날짜가
넘어간 순간부터 해당 팀의 당일 보고서가 생성될 때까지 매일 실패하는 시각 의존
테스트다. `team_content-planning`·스코어러와 무관하며, 이번 단계의 소스 변경이
0건이므로 **회귀가 아니라 기존 상태**다. 범위 밖이라 수정하지 않았다.

### 10.4 48h 표본 원문 (라이브 DB, read-only)

```console
$ sqlite3 -readonly db/nco.db "SELECT id,status,assigned_to,LENGTH(CAST(COALESCE(response,'') AS BLOB)),substr(COALESCE(error,''),1,55),created_at FROM tasks WHERE team_id='team_content-planning' AND created_at >= datetime('now','-48 hours') ORDER BY created_at DESC;"
task_trend_collector|completed|mlx|0||2026-07-27 21:00:03
task_content_generation|failed|cursor-agent|0|cursor-agent: CLI failed exit=unknown — Command failed |2026-07-27 17:10:06
task_NTFmch7UjbcOYnqh|completed|agy|3443||2026-07-27 15:00:06
task_wbmNJYskCFXrjmCE|completed|agy|3199||2026-07-27 05:12:09
task_bdP-dIFNni_P814l|completed|agy|2278||2026-07-27 00:00:33
task_mUctLweT5Iuokwf9|completed|agy|3398||2026-07-26 15:00:06
task_JAg7_6r9hm4tuMtG|completed|agy|4239||2026-07-26 08:00:05
task_xxMo-aMaiO3ofrpO|completed|claude-code|1850||2026-07-26 05:08:59
task_gudqikH8LkuQ6-Cy|failed|opencode|0|Circuit breaker open for agent opencode (generic)|2026-07-26 00:03:33
```

9행 → 분모 제외 2건(`task_content_generation` spawn failure = `SPAWN_FAILURE_EXCLUSION`,
`task_gudqikH8LkuQ6-Cy` CB/infra = `INFRA_EXCLUSION`) → `n=7`. 분자 제외 1건
(`task_trend_collector` 0B completed = `ZERO_OUTPUT_COMPLETED_EXCLUSION`) →
`6/7 = 85.7%`. 라이브·`dist` 재계산 값과 정합하며 **신규 미커버 실패 유형 0건**.
(`dist`에 세 규칙 문자열 31회 존재: `grep -c` → `31`.)

### 10.5 HTTP 200 · WebSocket 101 원문

```console
$ curl -s -o /dev/null -w 'HEALTH=%{http_code}\n' localhost:6200/health
HEALTH=200

$ curl -s -i --max-time 4 -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    http://localhost:6201/
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

{"type":"connected","clientId":"1aygf6yHjYqi","timestamp":"2026-07-27T21:20:44.351Z","path":"/"}
```

### 10.6 재기동을 실행하지 않은 근거 (신규 근거 추가)

지시문은 재기동을 `기동시각 < 커밋시각` 입증에 **조건부**로 두었고
(`(4) 그 다음에만 … 재기동`), 10.1에서 그 전제가 반증됐다. 이번 실행에서
추가로 확인한 **적극적 회귀 위험** 2건:

(a) 현재 `dist/`에는 **타 세션의 미커밋 소스 변경**이 이미 컴파일돼 있다.
라이브 PID 18727은 그 변경 이전에 기동했으므로, 재기동은 이 사이클의 범위 밖
미커밋 코드를 운영에 **배포**하게 된다.

```console
$ stat -f '%Sm %N' -t '%Y-%m-%dT%H:%M:%S' src/security/collaboration-loop-guard.ts
2026-07-28T06:12:54 src/security/collaboration-loop-guard.ts     # 기동 05:31:24 보다 뒤

$ git status --porcelain -- src/
 M src/security/collaboration-loop-guard.test.ts
 M src/security/collaboration-loop-guard.ts

# dist에는 있으나 HEAD 소스에는 없는 식별자 (= 미커밋 변경이 dist에 반영됨)
IN_DIST_BUT_NOT_IN_HEAD: DEFAULT_NOTIFIER_SENDERS
IN_DIST_BUT_NOT_IN_HEAD: NCO_MESH_LOOP_GUARD_NOTIFIERS
IN_DIST_BUT_NOT_IN_HEAD: NOTIFIER_EXEMPTION_DISABLED
IN_DIST_BUT_NOT_IN_HEAD: channelSender
IN_DIST_BUT_NOT_IN_HEAD: getNotifierSenders
IN_DIST_BUT_NOT_IN_HEAD: notifierExempt
IN_DIST_BUT_NOT_IN_HEAD: notifierSenders
```

(b) 재기동은 in-flight 작업을 중단시킨다.

```console
$ sqlite3 -readonly db/nco.db "SELECT id,status,assigned_to,created_at FROM tasks WHERE status='running';"
task_ad2FmyC-IrRlg7bD|running|claude-code|2026-07-27 21:17:34
```

기대 효과 **0**(10.2에서 라이브 == 현재 `dist` 전 필드 일치)에 대해, 범위 밖
미커밋 코드 배포 + in-flight 중단이라는 실제 위험을 감수할 이유가 없다.
이는 범위 축소가 아니라 지시문의 조건 분기와 "요청 범위 밖 파일 수정 금지"를
따른 결과다. HR이 그럼에도 재기동을 원하면 `npm run pm2:stop && npm run pm2:start`
한 번이면 되며(ecosystem 앱은 `nco-backend` 단일), 10.2 근거상 score/completion은
동일할 것으로 **예측**된다(예측일 뿐 미검증).

### 10.7 pre/post score 실측

새 재기동 경계를 만들지 않았으므로 새 post 값은 없다. 이번 단계의 실측만 기록한다.

| 구분 | 시각 (UTC) | score | completion | n | maxN | 근거 등급 |
|---|---:|---:|---:|---:|---:|---|
| 지시문 헤더값 (HR 스냅샷) | — | 83.4 | 87.5 | 8 | 91 | 지시문 인용 |
| 직전 재기동(20:31:24Z) 후 DB 스냅샷 | 20:10:00 이후 | 81.5 | 85.7 | 7 | 90 | T1 (3·7절 DB 행) |
| **라이브 HTTP (본 단계)** | 21:19Z | **81.4** | **85.7** | **7** | **91** | **T1 (HTTP 본문)** |
| **`dist/` 아티팩트 재계산 (본 단계)** | 21:19Z | **81.4** | **85.7** | **7** | **91** | **T1 (프로세스 출력)** |
| 재기동 후 post | 미생성 | 미검증 | 미검증 | 미검증 | 미검증 | 재기동 미실행 |

지시문 헤더의 `83.4 / 87.5% / n=8`은 HR 스냅샷이 갱신되지 않아 남은 값이다.
코드·`dist`·라이브 3자가 이미 일치하므로 남은 조치는 **HR 스냅샷 갱신**뿐이고
이는 HR 소관이다.

### 10.8 롤백 절차

- 이번 단계의 소스·DB·팀 lifecycle/status 변경 **0건** → 운영 롤백 불필요.
- `npm run build`를 실행했으나 `dist/` 집계 해시가 빌드 전후 동일
  (`4d244cb8…`)이므로 배포 아티팩트도 실질 변경 0 → 되돌릴 대상 없음.
- 이 문서의 10절만 역패치하면 본 단계 변경이 완전 원복된다.
- 향후 재기동 후 원복이 필요하면 커밋 checkout 없이
  `npm run pm2:stop && npm run pm2:start`로 같은 HEAD를 재기동한다.
- 스코어러 제외 규칙은 여전히 `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`,
  `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`,
  `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off`로 독립 비활성화 가능.

### 10.9 검증 영수증

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  10절 추가 (문서 1건). 소스·스코어러 수식·DB·팀 lifecycle/status 변경 **0건**.
  `npm run build` 실행으로 `dist/`를 재생성했으나 집계 해시 동일 → 실질 변경 0.
  실행 시작 시 이미 dirty였던 타 세션 파일은 건드리지 않았다.
- [검증방법] `git log -1`(`%cI`/`%ct`) + `npx pm2 jlist`(`pm_uptime`) +
  `curl /health` `uptime` 역산 **3중 대조** / `shasum -a 256` dist 329파일 집계
  빌드 전후 동일 / `node` 별도 프로세스로 `dist/core/team-scorer.js` import
  재계산 vs `curl /api/teams/scores` 본문 **전 필드 대조** /
  `sqlite3 -readonly` 48h 9행 / `npx tsc --noEmit` exit 0·0줄 /
  `npm run build` exit 0 / `npm run test:run` 725 passed·1 failed(원문 수록) /
  `curl` HEALTH=200 / WS `101 Switching Protocols` + `connected` 프레임 본문 /
  `stat` mtime · `git diff` 식별자 vs `dist` grep 대조
- [등급] **T1** — Git hash, PM2 JSON 필드, HTTP/WS 응답 본문, DB 행, 파일 해시,
  컴파일·테스트 원출력을 모두 같은 실행 안에서 직접 확인.
- [Gap] 지시 5단계 중 4단계 종결: (1) 사전 증거 수집 → 완료(단, 결론은 갭 **반증**),
  (2) tsc/build 오류 0 → 완료(9절 미해결 항목 종결), (3) test 회귀 없음 → 완료
  (실패 1건은 시각 의존 데이터, 회귀 아님), (4) HTTP 200·WS 101 → 완료.
  (5) 재기동+post 측정은 **전제 반증 + 범위 밖 미커밋 코드 배포 위험**으로 미실행(10.6).
  스코어러 범위 자체는 100% — 48h 9건 전부 기존 커밋 규칙으로 설명, 신규 미커버 0건.
- [미검증항목] (a) 실제 재기동 후 값이 `81.4/85.7/n=7`로 유지되는지 — 재기동을
  하지 않았으므로 예측일 뿐 **미검증**. (b) HR 스냅샷 `83.4/87.5/n=8` 갱신
  파이프라인(HR 소관, 미관측). (c) `task_trend_collector`에 0B completed를 주입하는
  upstream `nova-sns` cron(범위 밖, 미수정). (d) `tests/근거.test.ts` 날짜 포인터
  실패의 항구적 해결(범위 밖). (e) 타 세션 미커밋 `collaboration-loop-guard` 변경의
  운영 적합성(타 세션 소관, 판단하지 않음).

## 11. 현재 단계 독립 실행 (2026-07-28 06:41 KST)

이 절의 결론은 이 task에서 직접 관측한 원문만 사용한다. 1~10절의 이전 실행
성공 기록을 이번 단계의 성공 증거로 재사용하지 않는다.

### 11.1 사전 증거: HEAD와 프로세스 기동시각

Git 원문:

```console
$ git log -1 --format='%H %cI'
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00

$ git show -s --format='%H %cI %s' HEAD
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00 fix(mesh): exempt system notifier senders from collaboration volume rules

$ git show -s --format='%H %cI %s' 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ git merge-base --is-ancestor 9201a2291197ac02c85ef712a5086f4e25801297 HEAD
# exit 0

$ git diff --exit-code -- src/core/team-scorer.ts src/core/team-scorer.test.ts
# 출력 없음
# exit 0
```

`pm2 jlist` 원문:

```text
connect EPERM /Users/nova-ai/.pm2/rpc.sock
Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
```

지시가 허용한 대체 기동시각 증거와 현재 listener 대조:

```text
$ rg -n 'App \[nco-backend:0\].*(starting|online|exited)' /Users/nova-ai/.pm2/pm2.log | tail -n 12
897388:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897392:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897393:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] online
897418:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897421:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897422:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] online

$ stat -f '%N|mtime=%Sm|birth=%SB' -t '%Y-%m-%dT%H:%M:%S%z' /Users/nova-ai/.pm2/pids/nco-backend-0.pid
/Users/nova-ai/.pm2/pids/nco-backend-0.pid|mtime=2026-07-28T05:31:24+0900|birth=2026-07-28T05:31:24+0900

$ sed -n '1p' /Users/nova-ai/.pm2/pids/nco-backend-0.pid
18727

$ lsof -nP -a -p 18727 -iTCP:6200 -sTCP:LISTEN
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   56u  IPv4 0xf31862b268aad08a      0t0  TCP *:6200 (LISTEN)

$ lsof -nP -a -p 18727 -iTCP:6201 -sTCP:LISTEN
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   60u  IPv4 0xb528b69ef1e19fb6      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

시간 비교:

| 대상 | KST | 현재 PID 기동과 비교 | 판정 |
|---|---:|---:|---|
| 근본 패치 `9201a22` | 04:12:26 | `05:31:24 > 04:12:26` | 패치 기준 배포 갭 없음 |
| PID 18727 기동 | 05:31:24 | — | PM2 로그·PID 파일 T1, listener T2 |
| 현재 HEAD `18ccf07` | 06:27:58 | `05:31:24 < 06:27:58` | 최신 HEAD 기준으로는 프로세스가 오래됨 |

최신 HEAD는 `src/security/collaboration-loop-guard*.ts`와 진단 스크립트를 바꾼
별도 mesh 보안 커밋이다. 스코어러 두 파일은 diff 0이고 `9201a22`는 HEAD의
ancestor다. 따라서 `기동시각 < HEAD 커밋시각`은 사실이지만, 이를
“프로세스가 `9201a22` 이전 로직을 서빙한다”는 증거로 사용하지 않는다.

### 11.2 타입체크·빌드·테스트 원출력

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0
```

```console
$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/2579.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/2579.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 build가 실패했으므로 오류 0으로 보고하지 않으며 PM2 재기동을 금지했다.

```console
$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/2613.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/2613.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 래퍼가 Vitest 실행 전에 차단됐으므로 관련 테스트를 직접 실행했다.

```console
$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  06:41:06
   Duration  419ms (transform 174ms, setup 36ms, import 270ms, tests 29ms, environment 0ms)

# exit 0
```

관련 테스트 11건은 통과했지만 공식 `npm run test:run` exit 1을 전체 테스트
통과로 바꾸어 보고하지 않는다.

### 11.3 재기동·HTTP·WebSocket·pre/post score

공식 build 실패 때문에 `npm run pm2:stop`, `npm run pm2:start`,
`npm run pm2:restart`를 실행하지 않았다.

현재 샌드박스의 HTTP·WebSocket 원문:

```console
$ curl -4 -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:6200/health
curl: (7) Failed to connect to 127.0.0.1 port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000

$ curl -4 -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:6200/api/teams/scores
curl: (7) Failed to connect to 127.0.0.1 port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000

$ curl -4 -sS -i --max-time 5 -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:6201/
curl: (7) Failed to connect to 127.0.0.1 port 6201 after 0 ms: Couldn't connect to server
```

`lsof` listener는 T2 프로세스 증거일 뿐 HTTP 200·WebSocket 정상 증거가 아니다.
라이브 API pre를 얻지 못했으므로 DB 저장 행과 현재 `dist` 재계산을 참고값으로
분리 기록한다.

```console
$ sqlite3 -readonly -header -column db/nco.db "<latest score_checked query>"
id                    event_type     score  completion  n  maxN  created_at
--------------------  -------------  -----  ----------  -  ----  -------------------
tle_UZcUr2pzBOv6psE4  score_checked  81.4   85.7        7  91    2026-07-27 21:40:00
tle_W0jyn6YzUN7j6Jbg  score_checked  81.4   85.7        7  91    2026-07-27 21:30:00
tle_SMlS3xW_ni3MUnM1  score_checked  81.4   85.7        7  91    2026-07-27 21:20:00

$ node --input-type=module -e "<dist scorer invocation>"
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}
```

| 구분 | score | completion | n | maxN | 증거 |
|---|---:|---:|---:|---:|---|
| pre 참고값 | 81.4 | 85.7 | 7 | 91 | 최신 DB 저장 행 + 현 `dist` 재계산, T1 |
| 라이브 pre | 미검증 | 미검증 | 미검증 | 미검증 | HTTP_STATUS 000 |
| 재기동 후 post | 미생성 | 미검증 | 미검증 | 미검증 | build 실패로 재기동 미실행 |

### 11.4 롤백 절차

- 이번 단계의 소스·DB·팀 lifecycle/status·PM2 변경은 0건이므로 운영 롤백은
  필요 없다.
- 이번 단계가 추가한 11절과 문서 상단 판정 갱신만 역패치하면 문서 변경이
  원복된다.
- 권한 있는 환경에서 build/test가 통과한 뒤 재기동할 경우에도 커밋 checkout
  없이 `npm run pm2:stop && npm run pm2:start`로 같은 HEAD를 다시 기동하는
  절차가 가역 경계다.
- 팀 삭제·비활성화와 HR lifecycle/retirement 변경은 수행하지 않았다.

### 11.5 검증 영수증

읽기 전용 delivery-gate inspect 원문:

```text
$ run-delivery-gate.sh --inspect
[gate] project/worktree inspection
real-project: /Users/nova-ai/project/nco
current-worktree: /Users/nova-ai/project/nco
git-common-dir: /Users/nova-ai/project/nco/.git
base-ref: refs/heads/main
worktrees:
  - path: /Users/nova-ai/project/nco
    branch: main
    head: 18ccf0773363ec60b345b5b1fd1a55b9adb796ac
    dirty-files: 21
    base-relation: integrated
[gate] FAIL project/worktree inspection

- [Gap] PASS=0 FAIL=1 SKIP=0
# exit 1
```

`git worktree list`에는 경로가 이미 사라진 `prunable` worktree 두 개가 남아 있다.
inspect 스크립트는 `set -euo pipefail` 상태에서 다음 worktree의
`git -C <missing-path> status`가 실패하면 종료한다. 따라서 위 FAIL은 현재 main의
base 관계 실패가 아니라 stale worktree 메타데이터로 인한 검사 중단이다. 이
스킬은 cleanup을 금지하므로 worktree prune/remove는 수행하지 않았다.

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  상단 판정과 11절만 갱신. 코드·스코어러 수식·DB·팀 lifecycle/status·PM2
  변경 **0건**.
- [검증방법] 현재 task에서 Git hash/commit 시각·ancestor 관계·스코어러 diff 0,
  PM2 로그·PID 파일·`lsof`, read-only DB 행·현 `dist` 재계산,
  `npx tsc --noEmit`, `npm run build`, `npm run test:run`, 관련 Vitest,
  HTTP·WebSocket 요청 원문, delivery-gate inspect를 직접 확인.
- [등급] **T1** — Git hash, 파일 내용, PM2 로그/PID 파일, DB 행, 명령 출력을
  직접 확인. 현재 listener 존재는 **T2**이며 HTTP/WS 동작 증거가 아니다.
- [Gap] 근본 패치 `9201a22` 기준 배포 갭 부재와 스코어러 diff 0, 관련
  11/11 테스트는 확인했다. 공식 build/test, PM2 RPC, HTTP/WS, 재기동 후
  post score는 확인하지 못했고 inspect도 stale prunable worktree에서 중단돼
  전체 delivery gate는 미통과다.
- [미검증항목] (a) 권한 있는 운영 셸에서 공식 build/test 오류 0,
  (b) `/health` HTTP 200 본문과 `:6201` WebSocket 101,
  (c) 실제 재기동 후 score/completion/n,
  (d) HR 스냅샷 `83.4/87.5/n=8` 갱신(HR 소관),
  (e) 최신 HEAD `18ccf07`의 운영 반영 여부(스코어러 범위 밖).

## 12. cycle 3 종결 실행 — 안전 게이트 전부 통과, 배포 갭 반증 확정 (2026-07-28 06:45~06:48 KST)

이 절은 현재 단계에서 직접 실행한 원문만 담는다. 1~11절은 이전 실행 시점 증거로
보존한다. 이전 절에서 미해결로 남아 있던 `npm run build` / `npm run test:run` /
HTTP / WebSocket 항목이 이 절에서 **전부 종결**되었다.

### 12.1 배포 갭 입증 시도 → **반증**: 기동시각 > 커밋시각

지시문의 전제는 "기동시각 < 커밋시각"이었다. 실측 결과 **부등호가 반대**다.

```console
$ git log -1 --format='HEAD %H %cI %s'
HEAD 18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00 fix(mesh): exempt system notifier senders from collaboration volume rules

$ git log -1 --format='PATCH %H %cI %s' 9201a22
PATCH 9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ npx pm2 jlist | (nco-backend 항목만 추출)
pid 18727 status online restarts 64
started_utc 2026-07-27T20:31:24.716000+00:00
script /Users/nova-ai/project/nco/dist/index.js
```

| 사건 | UTC | KST | 판정 |
|---|---|---:|---|
| 근본원인 패치 `9201a22` 커밋 | 2026-07-27T19:12:26Z | 04:12:26 | 기준점 |
| 현재 `nco-backend` 기동 | 2026-07-27T20:31:24Z | 05:31:24 | **커밋보다 79분 늦음** |
| 현재 HEAD `18ccf07` 커밋 | 2026-07-27T21:27:58Z | 06:27:58 | 기동보다 늦음(스코어러 무관, 12.5절) |

→ **`9201a22` 기준 배포 갭은 존재하지 않는다.** 실행 중인 프로세스는 패치를
포함한 빌드에서 기동했다. 지시문의 "패치 이전 로직으로 채점/서빙 중"이라는
전제는 T1으로 반증된다.

### 12.2 반증의 결정적 근거 — 라이브 출력이 패치 후 수식과 정확히 일치

시각 비교만으로는 "그 시점 `dist`가 패치를 포함했는가"를 단정할 수 없으므로,
**라이브 API 출력값이 패치 전/후 중 어느 수식의 산물인지**를 실데이터로 판별했다.

48시간 창 실표본 (read-only DB, 기준 2026-07-27T21:47Z):

```console
$ sqlite3 -readonly db/nco.db "SELECT ... FROM tasks WHERE (team_id='team_content-planning' OR metadata_json LIKE '%team_content-planning%') AND created_at >= datetime('now','-48 hours') ORDER BY created_at;"
id                       status     assigned_to   resp_b  err                                                   created_at
-----------------------  ---------  ------------  ------  ----------------------------------------------------  -------------------
task_gudqikH8LkuQ6-Cy    failed     opencode      0       Circuit breaker open for agent opencode (generic)     2026-07-26 00:03:33
task_xxMo-aMaiO3ofrpO    completed  claude-code   1850                                                          2026-07-26 05:08:59
task_JAg7_6r9hm4tuMtG    completed  agy           4239                                                          2026-07-26 08:00:05
task_mUctLweT5Iuokwf9    completed  agy           3398                                                          2026-07-26 15:00:06
task_bdP-dIFNni_P814l    completed  agy           2278                                                          2026-07-27 00:00:33
task_wbmNJYskCFXrjmCE    completed  agy           3199                                                          2026-07-27 05:12:09
task_NTFmch7UjbcOYnqh    completed  agy           3443                                                          2026-07-27 15:00:06
task_content_generation  failed     cursor-agent  0       cursor-agent: CLI failed exit=unknown — Command fail  2026-07-27 17:10:06
task_trend_collector     completed  mlx           0                                                             2026-07-27 21:00:03
```

원시 표본 9건에 두 수식을 각각 적용하면:

| 수식 | 분모 n | 분자 | completion | 지시문/라이브 대조 |
|---|---:|---:|---:|---|
| **패치 전** (INFRA_EXCLUSION만) | 9−1 = **8** | 7 | 7/8 = **87.5%** | **지시문 `87.5% / n=8`과 정확히 일치** |
| **패치 후** (+SPAWN_FAILURE, +ZERO_OUTPUT_COMPLETED) | 9−2 = **7** | 6 | 6/7 = **85.7%** | **라이브 `85.7% / n=7`과 정확히 일치** |

- 패치 후 분모 제외: `task_gudqikH8LkuQ6-Cy`(CB open, 기존 INFRA) +
  `task_content_generation`(cursor-agent ENOENT, SPAWN_FAILURE) → n=7
- 패치 후 분자 제외: `task_trend_collector`(completed·산출물 0B,
  ZERO_OUTPUT_COMPLETED) → 분자 6

라이브 응답 원문:

```console
$ curl -s http://localhost:6200/api/teams/scores   (team_content-planning 행)
{"teamId": "team_content-planning", "slug": "content-planning", "name": "콘텐츠 기획팀",
 "organizationId": "org_sns-blog", "score": 81.4, "grade": "B", "completion": 85.7,
 "n": 7, "maxN": 91, "sample": "48h"}
```

→ 라이브는 **패치 후 수식**을 실행 중이다. 동시에 지시문의 `87.5% / n=8`이
**같은 데이터에 패치 전 수식을 적용한 값과 문자 그대로 일치**한다는 사실이,
지시문 수치가 "미배포"가 아니라 **패치 이전에 채집된 HR 스냅샷(stale)** 임을
증명한다. 이것이 이번 사이클의 최종 판정 근거다.

### 12.3 안전 게이트 원출력 (전부 통과)

```console
$ npx tsc --noEmit
tsc_exit=0
tsc_lines=0
```

```console
$ npm run build
build_exit=0

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

◇ injected env (0) from .env
{"level":30,...,"module":"database","path":"/Users/nova-ai/project/nco/db/nco.db","msg":"SQLite connected (WAL mode)"}
{"level":30,...,"module":"database","msg":"SQLite closed"}

# 빌드 산출물 갱신 확인 (UTC)
2026-07-27T21:46:30Z dist/index.js
2026-07-27T21:46:29Z dist/core/team-scorer.js
```

이전 절(9절)에서 `tsx` IPC 권한 오류로 실패했던 공식 build가 이번 실행에서
**exit 0으로 통과**했다. cycle 2부터 열려 있던 빌드 확인 항목은 여기서 종결된다.

```console
$ npm run test:run
test_exit=1

 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 725 passed (726)
   Duration  2.87s

 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
AssertionError: expected '2026-07-27' to be '2026-07-28' // Object.is equality
 ❯ tests/근거.test.ts:26:28
```

```console
$ npx vitest run src/core/team-scorer.test.ts
scorer_exit=0
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

### 12.4 유일한 테스트 실패는 회귀가 아님 — 원인 규명

`tests/근거.test.ts`는 `team_ax-collab` 러너의 날짜 포인터 파일이 **오늘(KST)**
날짜인지 검사한다. 즉 자정(KST)이 지나고 해당 러너가 아직 실행되지 않으면
스스로 실패하는 데이터 신선도 테스트다.

```console
$ cat data/team-runner/team_ax-collab.last
2026-07-27

$ git log -1 --format='%h %cI' -- data/team-runner/team_ax-collab.last
5ac31fa 2026-07-27T16:10:26+09:00

$ git status --porcelain data/team-runner/team_ax-collab.last
(출력 없음 — 워킹트리 clean, 커밋된 상태 그대로)
```

- 실패 원인: 커밋된 포인터 값 `2026-07-27` vs 오늘(KST) `2026-07-28`
- 대상 팀: `team_ax-collab` — **`team_content-planning`과 무관**
- 이번 단계의 소스 변경은 **0줄**이므로 이 실패는 정의상 이번 작업의 회귀가 아니다
- 워킹트리가 clean이므로 HEAD 상태에서 이미 실패하던 **선재(pre-existing)** 실패다
- 범위 밖이고 데이터 파일 수정은 수치 조작에 해당하므로 **손대지 않았다**

### 12.5 재기동 판단 — **수행하지 않음**, 근거

지시문 4단계(PM2 재기동)는 "패치 이전 로직으로 서빙 중"이라는 전제 위에 조건부로
지시된 조치다. 12.1·12.2에서 그 전제가 반증되었고, 추가로 다음을 확인했다.

```console
$ git log --format='%h %cI %s' --since='2026-07-27T20:31:24Z'
18ccf07 2026-07-28T06:27:58+09:00 fix(mesh): exempt system notifier senders from collaboration volume rules

$ git show --stat 18ccf07
 data/error-prevention/_c4-ab-replay.mts       | 70 +++++++++
 src/security/collaboration-loop-guard.test.ts | 70 +++++++++
 src/security/collaboration-loop-guard.ts      | 51 ++++++-

$ git diff --stat 4bccaf6..HEAD -- src/core/team-scorer.ts src/core/team-scorer.test.ts
(출력 없음 — 스코어러 diff 0)
```

현재 프로세스보다 새로운 커밋은 `18ccf07` **하나뿐**이며, 그 커밋은
`src/security/collaboration-loop-guard.*`만 건드리고 **스코어러를 전혀 변경하지
않는다.** 따라서:

1. 재기동해도 `team_content-planning`의 score·completion·n은 **구조적으로 변할 수
   없다** (pre == post가 보장됨). 재기동은 이 팀에 대해 증거 가치가 0이다.
2. 반면 재기동은 (a) 진행 중인 에이전트 태스크를 중단시키고, (b) 콘텐츠 기획팀과
   무관한 mesh Circuit-Breaker 면제(`18ccf07`)를 운영에 반영시킨다. 이는 이번
   하위작업의 "유계·가역" 범위를 넘는 부작용이며, 다른 소관의 결정이다.

→ 유계성 원칙에 따라 **재기동을 의도적으로 생략**했다. 이는 실패가 아니라
전제 반증에 따른 조치 불필요 판정이다.

### 12.6 재기동 전후 score·completion 실측

| 구분 | score | grade | completion | n | maxN | 출처 |
|---|---:|---|---:|---:|---:|---|
| HR 지시문 스냅샷 | 83.4 | — | 87.5% | 8 | — | 패치 전 수식 (12.2에서 재현 확인) |
| **재기동 전 라이브** | **81.4** | **B** | **85.7%** | **7** | 91 | `GET /api/teams/scores` 본문 |
| 재기동 후 | — | — | — | — | — | **미측정 — 재기동 미수행(12.5)** |

`score` 81.5(직전 관측) → 81.4(현재)의 0.1 변동은 `maxN`(전 팀 공통 정규화
분모, 현재 91)의 전역 결합에 따른 것으로, 콘텐츠 기획팀 자체 데이터 변화가
아니다. 등급(B)·completion(85.7%)·n(7)은 불변이다.

### 12.7 라이브 헬스·WebSocket 확인 (T1)

```console
$ curl -s http://localhost:6200/health
{"status":"healthy","service":"nco-backend","version":"1.0.0","ports":{"api":6200,"ws":6201},
 "providerCount":9,"runtime":{"redis":true,"agentsOnline":9,"uptime":4483.966970584},
 "timestamp":"2026-07-27T21:46:08.739Z"}
```

```console
$ node -e "(ws://localhost:6201 접속)"
WS_OPEN handshake=101 readyState=1
WS_MSG {"type":"connected","clientId":"n5NtNG7dVpH_","timestamp":"2026-07-27T21:48:06.727Z","path":"/"}
```

11절에서 미검증으로 남았던 `(b) /health HTTP 200 본문과 :6201 WebSocket 101`
항목은 여기서 **서버 발신 프레임 본문까지 확인**하여 종결한다(T2 listener 존재가
아니라 T1 응답 본문).

### 12.8 롤백 절차

이번 단계의 소스·DB·PM2·팀 lifecycle 변경이 **0건**이므로 되돌릴 런타임 상태가
없다. 남은 산출물별 원복 방법은 다음과 같다.

| 대상 | 원복 방법 |
|---|---|
| 이 문서 12절 | `git checkout -- docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md` (HEAD 커밋본으로 복원) |
| `dist/` 재빌드 산출물 | `npm run build` 재실행. 소스가 HEAD와 동일하므로 내용 동등 |
| 스코어러 제외 규칙 | 소스 수정 없이 `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off` / `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off` 후 재기동 |
| 만약 재기동을 강행했다면 | `npm run pm2:stop && npm run pm2:start`. 소스가 HEAD와 동일해 이전 커밋 체크아웃 불필요 |

### 12.9 검증 영수증

- [변경] `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  12절 추가(문서 1건)뿐. **코드 0줄 · 스코어러 수식 0 · DB 0행 · 팀
  lifecycle/status 0 · PM2 재기동 0회.** `dist/`는 `npm run build` 게이트
  실행으로 재생성됐으나 소스 동일(HEAD)이므로 동작 변경 없음.
- [검증방법] `git log -1 --format='%H %cI'`(HEAD·9201a22) + `npx pm2 jlist`
  `pm_uptime` → 기동시각 20:31:24Z > 커밋시각 19:12:26Z 반증 /
  `sqlite3 -readonly db/nco.db` 48h 9행 → 패치 전 7/8=87.5%·n=8, 패치 후
  6/7=85.7%·n=7 이중 산출 후 라이브 응답과 대조 /
  `curl -s localhost:6200/api/teams/scores` 본문 → `85.7 / n=7` /
  `npx tsc --noEmit` exit 0·0줄 / `npm run build` exit 0 + `dist` mtime 갱신 /
  `npm run test:run` 725/726 + `npx vitest run src/core/team-scorer.test.ts` 11/11 /
  `cat data/team-runner/team_ax-collab.last` + `git status --porcelain`로 유일
  실패의 선재성 확인 / `curl -s localhost:6200/health` 200 본문 /
  `ws://localhost:6201` 101 + 서버 발신 `connected` 프레임 본문 /
  `git show --stat 18ccf07` + `git diff --stat 4bccaf6..HEAD -- src/core/team-scorer.ts` → 스코어러 diff 0
- [등급] **T1** — Git hash·commit 시각, PM2 `pm_uptime` 원값, DB 행,
  HTTP 응답 본문, WebSocket 수신 프레임 본문, 컴파일·테스트 원출력을 직접 확인.
- [Gap] 지시된 5단계 중 4단계 완료(사전 증거·tsc/build·test·pre 실측),
  1단계(PM2 재기동)는 전제 반증 + 스코어러 diff 0으로 **의도적 생략**(12.5).
  콘텐츠 기획팀 스코어러 범위 내 잔여 갭 없음.
- [미검증항목]
  (a) 재기동 후 post score — 재기동 미수행이므로 **측정하지 않음**(pre==post가
      스코어러 diff 0으로 구조적으로 보장되나, 실행으로 확인한 것은 아님)
  (b) HR 스냅샷 `83.4/87.5/n=8` → `81.4/85.7/n=7` 갱신 — **HR 소관, 미관측**
  (c) `task_trend_collector`에 0B completed를 주입하는 upstream(`nova-sns` cron)
      — 범위 밖, 미수정
  (d) 최신 HEAD `18ccf07`의 운영 반영 여부 — 스코어러 무관, 다른 소관
  (e) `tests/근거.test.ts` 실패의 항구적 해소(러너 재실행 또는 테스트 설계 변경)
      — 범위 밖, 미수정

## 13. 현재 단계 직접 실행 — build 게이트 실패로 재기동 중단 (2026-07-28 07:07~07:12 KST)

이 절만 현재 단계에서 직접 수집한 증거다. 1~12절의 명령 출력과 성공 판정은
이번 단계의 완료 근거로 사용하지 않는다.

### 13.1 배포 시각 원문과 범위 판정

```console
$ git log -1 --format='%H %cI'
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00

$ git show -s --format='%H %cI %s' 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ git log -1 --format='%H %cI %s' -- src/core/team-scorer.ts src/core/team-scorer.test.ts
d1a23cecadf015051318b2a8506f61c32cd008ae 2026-07-28T04:54:58+09:00 Restart nco-backend to reflect fix

$ git merge-base --is-ancestor 9201a22 HEAD
patch_ancestor_exit=0
```

`pm2 jlist`는 현재 샌드박스에서 다음 원문으로 실패했다.

```text
connect EPERM /Users/nova-ai/.pm2/rpc.sock
Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
```

읽기 가능한 PM2 로그와 PID 파일의 최신 원문:

```text
897388:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897392:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897393:2026-07-28T05:00:24: PM2 log: App [nco-backend:0] online
897418:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
897421:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] starting in -fork mode-
897422:2026-07-28T05:31:24: PM2 log: App [nco-backend:0] online

pid_file=/Users/nova-ai/.pm2/pids/nco-backend-0.pid mtime=2026-07-28T05:31:24+0900 birth=2026-07-28T05:31:24+0900
18727
```

시각 관계는 두 범위에서 다르다.

| 비교 | 시각 관계 | 직접 판정 |
|---|---|---|
| 현재 HEAD `18ccf07` vs PID 기동 | `05:31:24 < 06:27:58` | HEAD 전체는 프로세스 기동 뒤 커밋 |
| 마지막 스코어러 커밋 `d1a23ce` vs PID 기동 | `04:54:58 < 05:31:24` | 대상 스코어러는 기동 전에 커밋됨 |
| 근본 패치 `9201a22` vs PID 기동 | `04:12:26 < 05:31:24` | 근본 패치도 기동 전에 커밋됨 |

따라서 `git log -1`만 보면 현재 HEAD 전체의 배포 차이는 존재하지만, 이번 작업의
대상인 스코어러에는 `d1a23ce..HEAD` diff가 없고 대상 패치는 현재 프로세스 기동
전에 이미 커밋됐다. 이 증거는 **대상 배포 갭이 현재 남아 있다는 전제를 반증**한다.

### 13.2 타입체크·build·test 원출력

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0
```

```console
$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/67176.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/67176.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

허용된 `/private/tmp`로 IPC 경로를 바꾼 재검사도 같은 원인으로 실패했다.

```console
$ env TMPDIR=/private/tmp npm run build
Error: listen EPERM: operation not permitted /private/tmp/tsx-501/93736.pipe
# exit 1
```

```console
$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/68151.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/68151.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 테스트 래퍼가 테스트 진입 전에 실패했으므로, 관련 테스트를 직접 실행했다.

```console
$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  07:09:12
   Duration  448ms (transform 196ms, setup 38ms, import 300ms, tests 29ms, environment 0ms)

# exit 0
```

`npx tsc --noEmit`과 관련 테스트는 통과했지만, 지시된 공식 build와 전체 test
스크립트는 통과하지 않았다. 따라서 오류 0이나 전체 회귀 없음으로 보고하지 않는다.

### 13.3 재기동·health·WebSocket

공식 build가 exit 1이면 재기동하지 말라는 지시를 적용해 다음 명령은 실행하지 않았다.

```text
npm run pm2:stop
npm run pm2:start
```

현재 listener의 T2 원문:

```text
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   56u  IPv4 0xf31862b268aad08a      0t0  TCP *:6200 (LISTEN)
node    18727 nova-ai   60u  IPv4 0xb528b69ef1e19fb6      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

현재 샌드박스에서의 실제 요청 원문:

```console
$ curl -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://localhost:6200/health
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000
# exit 7

$ curl -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://localhost:6200/api/teams/scores
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000
# exit 7

$ node -e '(ws://localhost:6201 WebSocket probe)'
WS_ERROR unknown
# exit 1
```

listener 존재는 프로세스/포트의 T2 증거일 뿐 HTTP 200·WebSocket handshake의
T1 증거가 아니다. 이번 실행에서는 둘 다 **미검증**이다.

### 13.4 재기동 전후 score·completion

최신 read-only DB 행:

```text
id                    event_type     score  completion  n  maxN  created_at
--------------------  -------------  -----  ----------  -  ----  -------------------
tle_eAoe714fI8WekNtr  score_checked  81.4   85.7        7  91    2026-07-27 22:10:00
```

| 구분 | score | completion | n | 출처 |
|---|---:|---:|---:|---|
| pre | 81.4 | 85.7% | 7 | `team_lifecycle_events` 최신 `score_checked` DB 행 |
| post | **미검증** | **미검증** | **미검증** | build 실패로 재기동 미수행 |

위 pre는 DB 지상진실이며 현재 HTTP 본문은 아니다. post 값은 추론하거나 이전 단계
출력을 재사용하지 않는다.

### 13.5 변경·롤백·검증 영수증

- [변경] 이 문서의 상단 최신 실행 상태와 13절만 추가. 코드·스코어러 수식·DB·팀
  lifecycle/status·PM2 상태 변경 **0건**.
- [핵심 diff] 현재 실행의 build/test/HTTP/WS 실패 원문, 대상 패치와 현재 PID의
  시각 관계, 최신 DB pre 값, 재기동 중단 사유를 추가했다.
- [검증방법] Git hash/커밋 시각과 ancestor 관계, PM2 로그/PID 파일, `lsof`,
  read-only DB 행, `npx tsc --noEmit`, `npm run build`, `npm run test:run`,
  관련 Vitest, HTTP/WS 요청, delivery gate `--full` 출력을 직접 확인.
- [등급] **[Evidence Tier 1] 파일/DB/Git/명령 출력 직접 확인**. listener 존재는
  **[Evidence Tier 2] 프로세스 확인**으로만 사용했다.
- [Gap] `npx tsc --noEmit` 1/1과 관련 scorer 테스트 11/11은 통과했다. 공식
  build/test, PM2 RPC, HTTP 200, WebSocket handshake, 재기동 후 post score는
  확인하지 못했다. delivery gate 원문은 `PASS=0 FAIL=4 SKIP=0`이었다.
- [미검증항목]
  - 권한 있는 운영 셸에서 `npm run build`와 `npm run test:run` 오류 0
  - 재기동 후 `/health` HTTP 200과 `:6201` WebSocket 정상
  - 재기동 후 `team_content-planning` score/completion/n
  - HR 스냅샷 갱신(HR 소관)
- [롤백] 런타임 변경이 없어 PM2 롤백은 필요 없다. 문서 원복은 다른 미커밋 변경을
  보존하면서 이 문서의 상단 최신 실행 상태 4줄과 13절만 제거한다. 커밋 checkout,
  팀 삭제·비활성화, 데이터 삭제는 수행하지 않는다.

---

## 14. cycle 3 종결 실행 — 안전 게이트 전부 통과, 배포 갭 반증 + 재기동 무효과 직접 증명 (2026-07-28 07:13~07:16 KST)

이 절은 13절의 미해결 항목(공식 build/test, HTTP/WS, pre/post score)을 종결한다.
소스 변경 0줄. 이 절에서 실행한 명령은 전부 read-only 또는 컴파일이며, PM2 재기동은
수행하지 않았다(근거는 14.6).

### 14.1 배포 갭 입증 시도 → 반증 (원문)

```bash
$ git log -1 --format='%H %cI %s'
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00 fix(mesh): exempt system notifier senders from collaboration volume rules

$ git log -3 --format='%H %cI %s' -- src/core/team-scorer.ts
d1a23cecadf015051318b2a8506f61c32cd008ae 2026-07-28T04:54:58+09:00 Restart nco-backend to reflect fix
a8c285a3d65340f27627d8f3327bd8fd5a091690 2026-07-28T04:39:24+09:00 Improvement cycle=2/3. ...
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol
```

```bash
$ npx pm2 jlist   # 요약 (pm_uptime → ISO 변환)
nco-backend pid=18727 status=online uptime_start=2026-07-27T20:31:24.716Z restarts=64 script=/Users/nova-ai/project/nco/dist/index.js
```

```bash
$ curl -s http://localhost:6200/health
{"status":"healthy","service":"nco-backend","version":"1.0.0","ports":{"api":6200,"ws":6201},
 "providerCount":9,"runtime":{"redis":true,"agentsOnline":9,"uptime":6127.2655115},
 "timestamp":"2026-07-27T22:13:32.019Z"}
# 역산: 22:13:32.019Z − 6127.266s = 20:31:24.75Z → pm2 pm_uptime과 3중 일치
```

판정 — 지시문 전제 `기동시각 < 커밋시각`은 **대상 코드에 대해 성립하지 않는다**:

| 대상 | 시각(UTC) | 기동(20:31:24.716Z) 대비 |
|---|---|---|
| 근본 패치 `9201a22` (scorer) | 19:12:26Z | **−79분 (기동이 나중)** → 이미 배포됨 |
| scorer 최종 변경 `d1a23ce` | 19:54:58Z | **−36분 (기동이 나중)** → 이미 배포됨 |
| 기동 시점 HEAD `4bccaf6` | 20:30:33Z | −51초 (기동이 나중) |
| 현재 HEAD `18ccf07` (mesh CB) | 21:27:58Z | +56분 (기동이 먼저) → **미배포, 단 scorer 무관** |

```bash
$ git status --porcelain src/          # 출력 없음 = 워킹트리 src 클린
$ git diff 4bccaf6..HEAD -- src/core/team-scorer.ts | wc -l
       0
$ git diff 4bccaf6..HEAD --stat
 data/error-prevention/_c4-ab-replay.mts       | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.test.ts | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.ts      | 51 ++++++++++++++++++-
 3 files changed, 189 insertions(+), 2 deletions(-)
```

→ 기동 이후 유일한 커밋 `18ccf07`은 `src/security/collaboration-loop-guard.*`만 건드리며
스코어러 diff는 **0줄**. 즉 미배포분이 존재하더라도 대상 팀 수치에는 **구조적으로** 영향이 없다.

### 14.2 실행 중인 로직 == 현재 코드 (재기동 없이 pre/post 증명)

별도 node 프로세스가 현재 `dist/core/team-scorer.js`를 import해 read-only DB로 재계산:

```bash
$ node ./_cp-c3-recompute.mjs     # computeTeamScores(new Database('./db/nco.db',{readonly:true}))
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
 "organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}

$ curl -s http://localhost:6200/api/teams/scores | (content-planning 추출)
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
 "organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}
```

→ **전 필드 일치**. 재기동 후 프로세스가 계산할 값 = 현재 라이브 값이므로 재기동 기대 효과 0.

아티팩트 수준 대조(빌드 전후 `dist` 집계 해시 동일):

```bash
$ find dist -name '*.js' | sort | xargs shasum -a 256 | shasum -a 256   # build 전
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
$ ... # build 후
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
$ grep -c 'SPAWN_FAILURE_EXCLUSION\|ZERO_OUTPUT_COMPLETED_EXCLUSION' dist/core/team-scorer.js
21
```

### 14.3 지시문 수치 83.4/87.5%/n=8의 정체 — 현재 코드로 직접 재현

동일 DB·동일 48h 창에서 패치 토글만 끄면 지시문 수치가 **그대로 재현**된다:

```bash
$ node ./_cp-c3-toggles.mjs
default(on/on)      : score=81.4 grade=B completion=85.7 n=7 maxN=91   # = 라이브 응답
spawn=off           : score=72.1 grade=C completion=75   n=8 maxN=91
spawn=off zero=off  : score=83.4 grade=B completion=87.5 n=8 maxN=91   # = HR 지시문과 문자 그대로 일치
```

→ 지시문 수치는 "패치가 배포되지 않아서"가 아니라 **패치 이전 수식으로 채집된 HR 스냅샷(stale)**.
같은 데이터에 두 수식을 적용한 결과가 각각 지시문·라이브와 일치하므로 미배포 가설은 배제된다.

### 14.4 안전 게이트 원출력 (13절 미해결 항목 종결)

```bash
$ npx tsc --noEmit ; echo "tsc_exit=$?"
tsc_exit=0
tsc_out_lines=0        # 출력 0줄

$ npm run build ; echo "build_exit=$?"
build_exit=0
> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc
{"level":30,...,"module":"database","msg":"SQLite connected (WAL mode)"}
{"level":30,...,"module":"database","msg":"SQLite closed"}
# 13절의 `tsx` IPC listen EPERM 재현되지 않음 (환경 의존 확정)

$ npm run test:run ; echo "test_exit=$?"
 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 725 passed (726)
   Duration  2.60s
 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
test_exit=1
```

### 14.5 유일한 실패는 회귀가 아님 (원인 규명)

```bash
$ cat data/team-runner/team_ax-collab.last
2026-07-27
$ date +%Y-%m-%d      # Asia/Seoul
2026-07-28
$ git status --porcelain data/team-runner/    # 출력 없음 = 워킹트리 클린(선재 상태)
```

`tests/근거.test.ts:18`은 포인터 파일이 **오늘(Asia/Seoul) 날짜**인지 검사한다.
대상은 `team_ax-collab`(타 팀)이며 날짜 롤오버 시 매일 실패하는 시각 의존 데이터 테스트다.
이번 작업의 코드 변경은 0줄이므로 회귀가 아니고, 데이터 파일을 고치는 것은 수치 조작이므로
손대지 않았다.

### 14.6 재기동 미수행 결정과 근거

지시된 절차 (4)의 목적은 "이미 커밋된 scorer 수정이 라이브에 미반영된 배포 갭을 닫는 것"이다.
그 전제가 14.1에서 반증됐고 14.2에서 재기동 효과 0이 직접 증명됐으므로, 재기동은 목적을
달성하지 못하면서 아래 부작용만 남긴다.

1. 기동 이후 유일한 커밋 `18ccf07`(mesh CB 통지원 면제)을 **범위 밖 운영 배포**하게 됨.
2. in-flight 태스크·에이전트 세션(agentsOnline=9) 중단.
3. `restarts=64`인 프로세스의 추가 재기동으로 얻는 대상 팀 수치 변화 = 0 (pre==post).

HR이 그럼에도 재기동을 원할 경우의 명령은 그대로 유효하다:
`npm run pm2:stop && npm run pm2:start` → `curl -s localhost:6200/health` → `:6201` WS 확인.

### 14.7 pre/post score 실측

| 경계 | score | grade | completion | n | maxN | 근거 |
|---|---:|---|---:|---:|---:|---|
| pre (라이브, 재기동 전) | 81.4 | B | 85.7 | 7 | 91 | `GET /api/teams/scores` 본문 (T1) |
| post (재기동 후) | — | — | — | — | — | **미측정 — 재기동 미수행** |
| post 대체 증명 | 81.4 | B | 85.7 | 7 | 91 | 현재 `dist`를 새 프로세스가 재계산 → pre와 전 필드 일치 (T1) |
| HR 지시문 스냅샷 | 83.4 | B | 87.5 | 8 | 91 | 패치 전 수식 재현으로 정체 확인 (T1, 14.3) |

### 14.8 HTTP·WebSocket 확인

```bash
$ curl -s http://localhost:6200/health          # 14.1 본문, status=healthy
$ node ./_cp-c3-ws.mjs                          # ws://localhost:6201
HTTP upgrade status = 101
WS_OPEN
WS_FRAME: {"type":"connected","clientId":"w_t8uYNvyR7W","timestamp":"2026-07-27T22:15:37.478Z","path":"/"}
ws_exit=0
```

### 14.9 롤백 절차

- 런타임 변경 없음 → PM2 롤백 불필요.
- 문서 원복: 이 문서의 상단 "최신 실행 상태" 블록과 14절만 제거(다른 미커밋 변경 보존).
- 검증용 임시 스크립트 `_cp-c3-recompute.mjs` / `_cp-c3-toggles.mjs` / `_cp-c3-ws.mjs`는
  실행 직후 `rm`으로 삭제 완료(레포에 잔존 없음).
- scorer 동작 원복이 필요하면 소스 수정 없이 토글로 가능:
  `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`, `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`.

### 14.10 검증 영수증

- [변경] 코드 0줄. `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md`
  상단 상태 블록 + 14절 추가. DB·팀 lifecycle/status·PM2 프로세스 변경 없음.
- [검증방법] `git log -1 --format='%H %cI'` / `npx pm2 jlist`(pm_uptime) / `curl /health` uptime 역산
  3중 대조 · `git diff 4bccaf6..HEAD -- src/core/team-scorer.ts`=0줄 ·
  `find dist -name '*.js' | xargs shasum -a 256 | shasum -a 256` build 전후 동일 ·
  새 node 프로세스 `computeTeamScores(readonly db)` 출력 == `GET /api/teams/scores` 본문(전 필드) ·
  토글 off 재현 `83.4/B/87.5/n=8` == 지시문 · `npx tsc --noEmit` exit 0(0줄) ·
  `npm run build` exit 0 · `npm run test:run` 725 pass/1 fail · WS `101` + `connected` 프레임 본문.
- [등급] **T1** (git 해시·프로세스 메타·HTTP 응답 본문·컴파일/테스트 출력·DB 재계산 직접 확인)
- [Gap] 배포 검증 범위 100%. 잔여: (a) HR 스냅샷 83.4/87.5% 갱신 — **HR 소관**,
  (b) `task_trend_collector`에 0B completed를 주입하는 외부 `nova-sns` cron — 범위 밖.
- [미검증항목] 실제 PM2 재기동 후의 post score(재기동 **의도적 미수행**, 대체 증명은 14.2/14.7) ·
  HR 파이프라인이 스냅샷을 81.4로 갱신하는지 · `18ccf07` mesh CB 면제의 라이브 효과(타 팀 범위) ·
  이 문서의 커밋 여부(미커밋 상태 유지, 커밋 지시 없음).

---

## 15. 현재 단계 독립 재검증 — build 실패로 재기동 중단 (2026-07-28 07:35~07:37 KST)

이 절은 이전 단계의 자연어 보고를 완료 근거로 재사용하지 않고, 현재 단계에서 직접
관측한 결과만 기록한다. 이 절 추가 전 문서는 이미 2,179줄의 미커밋 변경 상태였으며,
기존 내용을 덮어쓰지 않고 append-only로 보존했다.

### 15.1 Git 커밋과 프로세스 기동 시각

Git 원문:

```console
$ git log -1 --format='%H %cI'
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00

$ git show -s --format='%H %cI %s' 9201a22
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol

$ git log -1 --before='2026-07-28T05:31:24+09:00' --format='%H %cI %s'
4bccaf6f413791fd883f62563a3eeda20b7984d6 2026-07-28T05:30:33+09:00 Fixed bug in team scorer, improved completion to 87.5%
```

현재 샌드박스의 `npx pm2 jlist` 원문:

```text
connect EPERM /Users/nova-ai/.pm2/rpc.sock
Error: EPERM: operation not permitted, open '/Users/nova-ai/.pm2/pm2.log'
JLIST_PARSE_ERROR Unexpected end of JSON input
# exit 2
```

지시가 허용한 대체 프로세스 기동 시각 증거인 PID 파일과 PM2 로그 원문:

```text
/Users/nova-ai/.pm2/pids/nco-backend-0.pid|mtime=2026-07-28T05:31:24+0900|birth=2026-07-28T05:31:24+0900
18727

2026-07-28T05:31:24: PM2 log: App [nco-backend:0] exited with code [0] via signal [SIGKILL]
2026-07-28T05:31:24: PM2 log: pid=64863 msg=process killed
2026-07-28T05:31:24: PM2 log: App [nco-backend:0] starting in -fork mode-
2026-07-28T05:31:24: PM2 log: App [nco-backend:0] online
```

리스너 원문:

```text
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   56u  IPv4 0xf31862b268aad08a      0t0  TCP *:6200 (LISTEN)
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    18727 nova-ai   60u  IPv4 0xb528b69ef1e19fb6      0t0  TCP 127.0.0.1:6201 (LISTEN)
```

시간 관계:

| 사건 | KST | 현재 기동과 관계 |
|---|---:|---|
| 근본 패치 `9201a22` | 04:12:26 | 기동보다 1시간 19분 앞섬 |
| scorer 마지막 변경 `d1a23ce` | 04:54:58 | 기동보다 36분 앞섬 |
| 기동 시점 HEAD `4bccaf6` | 05:30:33 | 기동보다 51초 앞섬 |
| 현재 프로세스 기동 | 05:31:24 | 대상 scorer 변경 뒤 기동 |
| 현재 HEAD `18ccf07` | 06:27:58 | 기동보다 56분 뒤 커밋 |

`git log -1`만 비교하면 `05:31:24 < 06:27:58`이므로 저장소 전체에는 미배포
커밋 1개가 있다. 그러나 그 커밋의 실제 변경은
`src/security/collaboration-loop-guard.ts`와 그 테스트 및 재현 스크립트이며,
기동 시점 HEAD와 현재 HEAD 사이의 대상 scorer diff는 0줄이었다.

```console
$ git show --stat --oneline --summary 18ccf0773363ec60b345b5b1fd1a55b9adb796ac
18ccf07 fix(mesh): exempt system notifier senders from collaboration volume rules
 data/error-prevention/_c4-ab-replay.mts       | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.test.ts | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.ts      | 51 ++++++++++++++++++-
 3 files changed, 189 insertions(+), 2 deletions(-)

$ git diff --numstat 4bccaf6f413791fd883f62563a3eeda20b7984d6..HEAD -- \
    src/core/team-scorer.ts src/core/team-scorer.test.ts
# 출력 없음
```

따라서 요청서의 일반 부등식 `기동시각 < 현재 HEAD 커밋시각`은 참이지만, 이번 작업
대상인 근본 패치와 scorer에는 `패치 커밋시각 < 기동시각`이 성립한다. 현재 프로세스가
패치 이전 scorer를 서빙한다는 전제는 이 실행의 직접 증거와 모순된다.

### 15.2 재기동 전 score·completion 직접 측정

read-only DB의 최신 `score_checked` 원문:

```text
id                    team_id                team_slug         event_type     score  improvement_count  reason                            company_run_id  source     metadata_json                                                                 created_at
--------------------  ---------------------  ----------------  -------------  -----  -----------------  --------------------------------  --------------  ---------  ----------------------------------------------------------------------------  -------------------
tle_YQHQ3CrWtJq6EoGE  team_content-planning  content-planning  score_checked  81.4   3                  score 81.4 is below HR target 90                  scheduled  {"sample":"48h","n":7,"maxN":91,"completion":85.7,"consecutiveLowChecks":31}  2026-07-27 22:30:00
```

현재 `dist/`와 현재 `src/`를 각각 새 Node 프로세스에서 read-only DB로 재계산한 원문:

```console
$ node --input-type=module -e '<dist/core/team-scorer.js + readonly DB>'
◇ injected env (0) from .env // tip: ⌘ override existing { override: true }
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}
# exit 0

$ node --import tsx --input-type=module -e '<src/core/team-scorer.ts + readonly DB>'
◇ injected env (0) from .env // tip: ⌘ enable debugging { debug: true }
{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀","organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}
# exit 0
```

두 독립 재계산은 `81.4 / B / 85.7 / n=7 / maxN=91 / 48h`로 전 필드 일치했다.
다만 현재 샌드박스에서 라이브 HTTP 요청은 차단됐으므로 이 값은 API 응답이라고
표현하지 않는다.

```console
$ curl -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:6200/api/teams/scores
curl: (7) Failed to connect to 127.0.0.1 port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000
# exit 7
```

### 15.3 타입체크·build·test 원출력

```console
$ npx tsc --noEmit
# stdout/stderr 없음
# exit 0
```

```console
$ npm run build

> neural-cli-orchestrator@1.0.0 build
> tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/21773.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/21773.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

```console
$ npm run test:run

> neural-cli-orchestrator@1.0.0 test:run
> tsx scripts/run-with-work-event.ts --event-type regression:test -- vitest run

node:net:1986
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/27134.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at Server.listen (node:net:2187:5)
    at file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31537
    at new Promise (<anonymous>)
    at createIpcServer (file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:53:31515)
    at async file:///Users/nova-ai/project/nco/node_modules/tsx/dist/cli.mjs:55:459 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/var/folders/qm/z0r7tnzn2ts_kwzg0btt_8hc0000gn/T/tsx-501/27134.pipe',
  port: -1
}

Node.js v25.9.0
# exit 1
```

공식 래퍼는 테스트 진입 전에 실패했다. 대상 테스트를 직접 실행한 원문:

```console
$ npx vitest run src/core/team-scorer.test.ts

 RUN  v4.1.10 /Users/nova-ai/project/nco

{"level":30,"time":1785191796126,"pid":32346,"hostname":"nova-macstudio","module":"database","path":"/Users/nova-ai/project/nco/db/nco.db","msg":"SQLite connected (WAL mode)"}
{"level":30,"time":1785191796126,"pid":32346,"hostname":"nova-macstudio","module":"database","msg":"SQLite closed"}

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  07:36:36
   Duration  422ms (transform 176ms, setup 35ms, import 279ms, tests 27ms, environment 0ms)

# exit 0
```

delivery gate 통합 판정 원문:

```text
[gate] FAIL project/worktree inspection
[gate] FAIL npm run typecheck
[gate] FAIL npm run test
[gate] FAIL npm run build

## 검증 영수증
- [변경] 없음 — delivery gate is read-only
- [검증방법] /Users/nova-ai/.codex/plugins/cache/nova-use/nco-shared-toolkit/0.1.3/skills/nco-delivery-gate/scripts/run-delivery-gate.sh --full
- [등급] T1 (Git and command output observed directly)
- [Gap] PASS=0 FAIL=4 SKIP=0
- [미검증항목] failed steps require investigation
# exit 4
```

`project/worktree inspection`의 실패는 canonical `main` checkout에서 dirty 파일 21개를
관측했기 때문이다. 현재 단계 시작 시 이미 존재한 다른 작업의 dirty 변경은 수정하거나
되돌리지 않았다.

### 15.4 재기동 중단, HTTP·WebSocket, pre/post 표

`npm run build`가 exit 1이면 재기동하지 말라는 현재 단계 지시를 적용했다. 또한 대상
scorer의 배포 갭도 15.1에서 반증됐다. 따라서 다음 명령은 실행하지 않았다.

```text
npm run pm2:stop
npm run pm2:start
```

현재 health와 WebSocket probe 원문:

```console
$ curl -sS --max-time 5 -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:6200/health
curl: (7) Failed to connect to 127.0.0.1 port 6200 after 0 ms: Couldn't connect to server

HTTP_STATUS:000
# exit 7

$ node -e '<ws://127.0.0.1:6201 WebSocket probe>'
WS_ERROR unknown
# exit 1
```

`lsof`의 listener는 프로세스 존재 T2일 뿐 HTTP 200이나 WebSocket handshake T1
증거로 승격하지 않는다.

| 경계 | score | grade | completion | n | maxN | 근거 |
|---|---:|---|---:|---:|---:|---|
| pre | 81.4 | B | 85.7 | 7 | 91 | 최신 DB 행 + 현재 dist/src 독립 재계산 |
| post | **미검증** | **미검증** | **미검증** | **미검증** | **미검증** | build 실패로 재기동 미수행 |

### 15.5 롤백과 검증 영수증

- [변경] 코드·스코어러 수식·DB lifecycle/status·팀 활성상태·PM2 프로세스 변경 0건.
  이 문서에 15절만 append.
- [핵심 diff] 현재 직접 측정한 Git/PM2 시각, pre score, tsc/build/test 원출력,
  재기동 중단 사유, HTTP/WS 실패와 미검증 post 값을 추가했다.
- [검증방법] Git hash·커밋 시각·대상 파일 diff, PM2 로그와 PID 파일, read-only DB 행,
  현재 dist/src scorer의 read-only 재계산, `npx tsc --noEmit`, `npm run build`,
  `npm run test:run`, scorer Vitest, HTTP/WS probe, delivery gate `--full` 출력을 직접 확인.
- [등급] **[Evidence Tier 1] 파일/DB/Git/명령 출력 직접 확인**. `lsof` listener는
  **[Evidence Tier 2] 프로세스 확인**으로만 사용.
- [Gap] 직접 타입체크 1/1과 대상 scorer 테스트 11/11은 통과. 필수 build와 공식
  test 래퍼는 `tsx` IPC `listen EPERM`으로 실패했고 delivery gate는
  `PASS=0 FAIL=4 SKIP=0`. 재기동·post score·HTTP 200·WS handshake는 완료하지 못함.
- [미검증항목]
  - 권한 있는 운영 셸에서 `npm run build` 및 `npm run test:run` 오류 0
  - PM2 재기동 후 `/health` HTTP 200과 `:6201` WebSocket 정상
  - PM2 재기동 후 `team_content-planning` score/completion/n
  - HR 스냅샷 갱신(HR 소관)
- [롤백] 런타임·소스 변경이 없어 PM2/소스 롤백은 불필요. 문서 변경을 되돌릴 때는
  기존 미커밋 변경을 보존하고 이 문서의 15절만 제거한다. 커밋 checkout, 팀
  삭제·비활성화, 데이터 삭제는 수행하지 않았다.

---

## 16. cycle 3 종결 — 15절 미검증 항목 전부 종결 + 재기동 무효과 직접 증명 (2026-07-28 07:39~07:42 KST)

**결론 3줄**
1. 15절이 `tsx` IPC `listen EPERM`으로 남겨둔 **`npm run build` / `npm run test:run` / HTTP 200 / WS handshake 4개 항목이 이번 실행에서 전부 통과**했다. EPERM은 환경 의존이며 재현되지 않았다.
2. 지시문 전제인 배포 갭은 **스코어러 경로에 존재하지 않는다** — `git diff 4bccaf6..HEAD -- src/core/team-scorer.ts` = **0줄**, `dist` 해시가 재빌드 전후 **바이트 동일**.
3. 지시문 수치 `83.4 / 87.5% / n=8`은 미배포가 아니라 **패치 이전 수식의 스냅샷**이다 — 현재 코드에서 토글만 끄면 문자 그대로 재현된다.

### 16.1 배포 갭 입증 시도 → 반증 (원문)

```bash
$ git log -1 --format='%H %cI %s'
18ccf0773363ec60b345b5b1fd1a55b9adb796ac 2026-07-28T06:27:58+09:00 fix(mesh): exempt system notifier senders from collaboration volume rules

$ git log -3 --format='%H %cI %s' -- src/core/team-scorer.ts
d1a23cecadf015051318b2a8506f61c32cd008ae 2026-07-28T04:54:58+09:00 Restart nco-backend to reflect fix
a8c285a3d65340f27627d8f3327bd8fd5a091690 2026-07-28T04:39:24+09:00 Improvement cycle=2/3. ...
9201a2291197ac02c85ef712a5086f4e25801297 2026-07-28T04:12:26+09:00 Improve team Collaboration Mesh and Protocol
```

```bash
$ npx pm2 jlist   # (파싱 출력)
nco-backend pid=18727 status=online uptime_start=2026-07-27T20:31:24.716Z restarts=64 \
  cwd=/Users/nova-ai/project/nco script=/Users/nova-ai/project/nco/dist/index.js
```

```bash
$ curl -s http://localhost:6200/health
{"status":"healthy","service":"nco-backend","version":"1.0.0","ports":{"api":6200,"ws":6201},
 "providerCount":9,"runtime":{"redis":true,"agentsOnline":9,"uptime":7719.915291334},
 "timestamp":"2026-07-27T22:40:04.668Z"}
# 역산: 22:40:04.668Z − 7719.915s = 20:31:24.753Z → pm2 pm_uptime 20:31:24.716Z와 3중 일치
```

**시각만 보면 `기동 20:31:24Z < HEAD 커밋 21:27:58Z`로 갭이 있어 보인다. 그러나 그 커밋은 이 팀과 무관하다:**

```bash
$ git diff --stat 4bccaf6..HEAD -- src/core/team-scorer.ts src/core/team-scorer.test.ts
# 출력 0줄 ← 스코어러 경로 변경 없음

$ git diff --stat 4bccaf6..HEAD
 data/error-prevention/_c4-ab-replay.mts       | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.test.ts | 70 +++++++++++++++++++++++++++
 src/security/collaboration-loop-guard.ts      | 51 ++++++++++++++++++-
 3 files changed, 189 insertions(+), 2 deletions(-)

$ git status --porcelain -- src/
# 출력 없음 ← 워킹트리 src 클린 (HEAD 소스 == 워킹트리 소스)
```

> ⚠️ **판정 규칙**: 기동시각 vs HEAD 커밋시각 비교는 앞으로 **항상 갭이 있는 것처럼 보인다**(타 팀 커밋이 계속 쌓이므로). 배포 갭은 반드시 **스코어러 경로 diff**로 판정할 것.

### 16.2 실행 중인 로직 == 현재 `dist` == 컴파일된 HEAD (아티팩트 수준 증명)

```bash
$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
count=329

$ npm run build > /tmp/cp-c3-build.log 2>&1; echo "BUILD_EXIT=$?"
BUILD_EXIT=0

$ find dist -name '*.js' -type f | sort | xargs shasum -a 256 | shasum -a 256
4d244cb85df3139933b403c4a10f2c77ed009dce4a5ca42fe859132bc40fcd10  -
count=329
# → 재빌드 전후 집계 해시 바이트 동일. on-disk dist = 컴파일된 HEAD.
```

**재기동 없이 pre == post 증명** — 별도 node 프로세스가 현재 `dist`로 read-only DB 스냅샷을 재계산:

```js
// _cp-c3-recompute.mjs (실행 후 삭제, 전문 수록)
import Database from 'better-sqlite3';
import { computeTeamScores } from './dist/core/team-scorer.js';
const db = new Database('/tmp/cp-c3-snap.db', { readonly: true });
const t = computeTeamScores(db).find(r => r.teamId === 'team_content-planning');
console.log('DIST_RECOMPUTE ' + JSON.stringify(t));
```

```bash
$ sqlite3 db/nco.db ".backup '/tmp/cp-c3-snap.db'"   # 574,377,984 bytes, read-only 사용
$ node _cp-c3-recompute.mjs
DIST_RECOMPUTE {"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
  "organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}

$ curl -s http://localhost:6200/api/teams/scores | ...   # 같은 시각 라이브
LIVE_API      {"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
  "organizationId":"org_sns-blog","score":81.4,"grade":"B","completion":85.7,"n":7,"maxN":91,"sample":"48h"}
```

→ **전 필드 일치**. 재기동해도 이 팀 수치는 구조적으로 불변이다.

### 16.3 지시문 수치 `83.4 / 87.5% / n=8`의 정체 — 현재 코드로 직접 재현

같은 `dist`, 같은 DB 스냅샷에서 **토글만** 바꾼 결과:

| `SPAWN_FAILURE_EXCLUSION` | `ZERO_OUTPUT_COMPLETED_EXCLUSION` | score | grade | completion | n |
|---|---|---:|---|---:|---:|
| on (기본) | on (기본) | **81.4** | B | **85.7%** | **7** | 
| **off** | **off** | **83.4** | **B** | **87.5%** | **8** | ← **HR 지시문과 문자 그대로 일치** |
| off | on | 72.1 | C | 75% | 8 |
| on | off | 94.3 | A | 100% | 7 |

→ 지시문 수치는 **현재 코드에서 두 제외 규칙을 끈 값**이다. 즉 "패치가 배포되지 않았다"가 아니라 **"패치 이전에 채집된 HR 스냅샷"**임이 확정된다. 미배포 가설은 배제된다.

### 16.4 안전 게이트 원출력 — 15절 미해결 항목 종결

```bash
$ npx tsc --noEmit
# stdout/stderr 0줄
TSC_EXIT=0

$ npm run build > /tmp/cp-c3-build.log 2>&1; echo $?
BUILD_EXIT=0
# ← 15절의 `tsx` IPC `listen EPERM` 재현되지 않음. 환경 의존 확정.

$ npm run test:run > /tmp/cp-c3-test.log 2>&1; echo $?
TEST_EXIT=1
 Test Files  1 failed | 121 passed (122)
      Tests  1 failed | 725 passed (726)
   Duration  2.89s

$ npx vitest run src/core/team-scorer.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

### 16.5 유일한 실패는 회귀가 아님 (원인 규명)

```
 FAIL  tests/근거.test.ts > 근거 > 최신 포인터가 오늘 날짜를 가리킨다
AssertionError: expected '2026-07-27' to be '2026-07-28' // Object.is equality
 ❯ tests/근거.test.ts:26:28
```

```bash
$ cat data/team-runner/team_ax-collab.last
2026-07-27
$ date '+%Y-%m-%d (local)'
2026-07-28 (local)
$ git status --porcelain -- data/team-runner/ tests/근거.test.ts
# 출력 없음 ← 이번 작업이 건드리지 않음
```

- 대상은 **`team_ax-collab`(타 팀)**이고, 어제 러너가 돈 뒤 **날짜가 롤오버**되어 실패한 **시각 의존 데이터 테스트**다.
- 같은 디렉터리의 다른 팀 포인터는 `2026-07-28`로 갱신돼 있다(`team_ax-docs`, `team_ax-git`, `team_ax-research`, `team_ax-security` 등) → 러너 미실행 팀만 실패한다.
- **`.last` 파일 수정은 곧 수치 조작**이므로 손대지 않았다. 콘텐츠 기획팀 범위 밖·선재 실패이며 회귀가 아니다.

### 16.6 HTTP·WebSocket 확인 (15절 미검증 항목 종결)

```bash
$ curl -s http://localhost:6200/health
{"status":"healthy",...,"runtime":{"redis":true,"agentsOnline":9,"uptime":7719.915291334},...}   # HTTP 200

$ node -e "<:6201 raw WebSocket handshake>"
WS_HTTP_STATUS=101
WS_FRAME_BODY={"type":"connected","clientId":"MrGvolxWBGIB","timestamp":"2026-07-27T22:41:31.782Z","path":"/"}
```

### 16.7 재기동 **미수행** 결정과 근거

지시문 4단계(`pm2:stop && pm2:start`)는 **의도적으로 수행하지 않았다**. 근거:

1. **편익 0 (증명됨)** — 16.2에서 현재 `dist` 재계산 = 라이브 응답 **전 필드 일치**. 재기동해도 pre == post.
2. **전제 불성립** — 지시문의 게이팅 조건 "`기동시각 < 커밋시각`을 T1으로 입증"은 **스코어러 경로에 대해 성립하지 않는다**(diff 0줄).
3. **범위 위반** — 재기동은 이 팀과 무관한 `18ccf07`(mesh CB 통지원 면제)을 운영에 배포한다. 해당 변경은 다른 사이클 기록상 **편익이 라이브에서 미관측**이며, 콘텐츠 기획팀 사이클의 부수효과로 배포할 사안이 아니다.
4. **비가역 비용** — `restarts=64`인 프로세스의 in-flight 태스크가 중단된다. "유계·가역" 제약에 반한다.

**운영자가 그래도 재기동을 원할 경우 1줄**: `npm run pm2:stop && npm run pm2:start` → 예상 결과는 `81.4 / B / 85.7% / n=7`(무변화).

### 16.8 재기동 전후 score·completion

| 구분 | 시각(UTC) | score | grade | completion | n | maxN | 출처 |
|---|---|---:|---|---:|---:|---:|---|
| pre (라이브) | 2026-07-27T22:40:04Z | 81.4 | B | 85.7% | 7 | 91 | `GET /api/teams/scores` 본문 |
| post (예측·재기동 미수행) | — | 81.4 | B | 85.7% | 7 | 91 | 현재 `dist` 재계산 = pre와 전 필드 일치 |
| HR 지시문 (stale) | — | 83.4 | B | 87.5% | 8 | 91 | 현재 코드 + 토글 off 재현치 |

post는 **측정값이 아니라 증명된 예측**이다(재기동 미수행). 이를 실측으로 주장하지 않는다.

### 16.9 롤백 절차

- 소스·스코어러 수식·DB·팀 lifecycle/status·PM2 프로세스 변경 **0건** → 롤백 대상 없음.
- 이 문서 변경 되돌리기: 16절만 제거(다른 미커밋 변경 보존).
- 스코어러 동작 원복이 필요하면 재기동 없이 환경변수로 독립 가능:
  `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off` / `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`.

### 16.10 검증 영수증

- **[변경]** `docs/self-improve/content-planning-cycle3-deploy-verification-2026-07-28.md` — 16절 append **만**. 코드·`dist`·DB·팀 상태·PM2 변경 0건. 임시 스크립트 `_cp-c3-recompute.mjs`는 실행 후 삭제(전문은 16.2에 수록).
- **[검증방법]** `git log -1 --format='%H %cI'` / `git diff --stat 4bccaf6..HEAD -- src/core/team-scorer.ts`(0줄) / `git status --porcelain -- src/`(빈 출력) / `npx pm2 jlist` `pm_uptime` / `curl -s localhost:6200/health` 본문 uptime 역산 3중 대조 / `find dist -name '*.js' | xargs shasum -a 256 | shasum -a 256` 빌드 전후 동일 / `sqlite3 .backup` read-only 스냅샷 + `dist/core/team-scorer.js` 재계산 4조합 / `curl -s localhost:6200/api/teams/scores` 본문 / `npx tsc --noEmit`(exit 0, 0줄) / `npm run build`(exit 0) / `npm run test:run`(725 pass / 1 fail) / `npx vitest run src/core/team-scorer.test.ts`(11/11) / `:6201` raw WS handshake 101 + `connected` 프레임 본문.
- **[등급] T1** — Git hash·PM2 JSON·HTTP 응답 본문·DB 행 재계산·컴파일/테스트 출력·바이너리 해시를 직접 확인. `lsof` 등 T2 근거는 판정에 사용하지 않음.
- **[Gap] 스코어러 범위 100%** — 15절이 남긴 build/test/HTTP/WS 4개 미검증 항목 전부 종결. 잔여: (a) **HR 스냅샷 갱신 — HR 소관**, (b) `task_trend_collector`에 0B completed를 주입하는 upstream(`nova-sns` cron `automation/trend-collector.py`)은 이 팀 범위 밖.
- **[미검증항목]**
  - PM2 재기동 후 실제 post score — **재기동 미수행**이므로 실측 없음(16.7 근거). 예측 `81.4/B/85.7/n=7`은 dist 재계산으로 뒷받침되나 실측이 아니다.
  - HR 파이프라인이 스냅샷을 81.4/85.7%로 갱신하는지 (HR 소관, 관측 불가)
  - 이 문서의 커밋 여부 — **미커밋 상태로 둠**(커밋 지시 없음)
  - `tests/근거.test.ts`가 `team_ax-collab` 러너 실행 후 통과하는지 (타 팀 소관, 미실행)
