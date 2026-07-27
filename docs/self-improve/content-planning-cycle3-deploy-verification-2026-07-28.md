# 콘텐츠 기획팀 cycle 3 배포 검증

- 대상: 콘텐츠 기획팀 (`content-planning`, `team_content-planning`)
- 기준일: 2026-07-28 KST
- 범위: 소스 재구현 없이 커밋 `9201a2291197ac02c85ef712a5086f4e25801297`의 배포 상태 검증
- 판정: **부분 완료**. 과거 배포 갭과 05:00:24 KST 재기동에 의한 갭 해소는
  Git·PM2 로그·DB 행으로 재검증했다. 그러나 현재 실행 환경에서 공식
  `npm run build`와 `npm run test:run`이 `tsx` IPC 권한 오류로 실패했으므로,
  지시된 안전 게이트에 따라 이 실행에서는 PM2를 재기동하지 않았다.

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
