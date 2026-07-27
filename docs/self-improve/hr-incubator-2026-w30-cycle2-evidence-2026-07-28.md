# HR Incubator 2026-W30 개선 cycle 2 증거

## 범위

- 대상: `team_hr-incubator-2026-w30`
- 변경 범위: team scorer의 provider 인증 실패 분류와 해당 회귀 테스트
- 비변경 범위: 팀 활성 상태, lifecycle 상태, retirement, 팀원 구성
- 즉시 롤백: `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off`

## 근본 원인

현재 `db/nco.db`를 읽고 provider 인증 제외 토글을 비활성화해
`computeTeamScores()`로 계산한 결과는 아래와 같았다.

```json
{"teamId":"team_hr-incubator-2026-w30","slug":"hr-incubator-2026-w30","name":"HR Incubator 2026-W30","organizationId":"org_knowledge-diet","score":81.5,"grade":"B","completion":85.7,"n":7,"maxN":89,"sample":"48h"}
```

표본의 유일한 계상 실패는 `tasks.id=task_VnTZtkgkcpgPwPhy`였다.

```text
status=failed
assigned_to=claude-code
progress=0.0
error='subprocess exited with code 1: Invalid API key · Fix external API key'
length(response)=39
response_hex=496E76616C696420415049206B657920C2B7204669782065787465726E616C20415049206B65790A
length(COALESCE(result_json,''))=0
```

응답 hex의 마지막 `0A`는 줄바꿈이다. 기존
`PROVIDER_AUTH_EXCLUSION_SQL`은 `CLI failed exit=`와 `{"type":"error"...}` 형태의
구조화 401만 제외해서 이 claude-code 평문 인증 거부를 놓쳤다. 따라서 팀이 작업을
완료할 수 없었고 최종 행에 팀 산출물도 남지 않은 provider 가용성 실패가 팀 산출물 실패
1건으로 계상됐다.

## 변경

- `src/core/team-scorer.ts`
  - 기존 provider 인증 제외 규칙에 실측한 평문 `Invalid API key · Fix external API key`
    형식을 추가했다.
  - `status <> 'completed'`, 실측 error 문자열 완전 일치, 오류 한 줄과 정확히 같은 response,
    빈 `result_json`을 모두 요구한다. 미관측 exit code나 오류 접미사는 제외하지 않는다.
  - response 끝의 공백·탭·CR·LF만 `RTRIM`해서 실제 DB의 마지막 LF를 허용한다.
  - 부분 산출물이나 오류 문자열을 인용한 보고서는 제외하지 않는다.
- `src/core/team-scorer.test.ts`
  - 실제 HR 오류 형식의 양성 회귀 케이스를 추가했다.
  - quality-gate 오류, 부분 산출물, 미관측 exit code의 음성 케이스를 추가했다.
  - 환경변수 토글을 끄면 기존 집계로 복귀함을 검증했다.

## 검증 결과

### 대상 회귀 테스트

IPC를 쓰지 않는 TypeScript loader로 repository의 work-event 기록기와 같은 Vitest
대상 파일을 실행했다.

```text
PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts \
  --event-type regression:test -- vitest run src/core/team-scorer.test.ts
Test Files  1 passed (1)
Tests  10 passed (10)
event=evt_-v6PFR32txxAADHk
event_type=regression:test:passed
outcome=succeeded
exit_code=0
```

### 현재 DB에 대한 scorer 계산

수정 코드 활성 상태:

```json
{"target":{"teamId":"team_hr-incubator-2026-w30","slug":"hr-incubator-2026-w30","name":"HR Incubator 2026-W30","organizationId":"org_knowledge-diet","score":94,"grade":"A","completion":100,"n":6,"maxN":88,"sample":"48h"},"completionOver100":0}
```

토글 비활성 상태:

```json
{"rollbackTarget":{"teamId":"team_hr-incubator-2026-w30","slug":"hr-incubator-2026-w30","name":"HR Incubator 2026-W30","organizationId":"org_knowledge-diet","score":81.5,"grade":"B","completion":85.7,"n":7,"maxN":89,"sample":"48h"}}
```

이는 현재 DB를 읽어 함수가 계산한 관측값이며 lifecycle 테이블에 새 점수로 저장한 값이 아니다.

### typecheck와 build

샌드박스의 `tsx` CLI IPC 제약을 피하되 repository의 work-event 기록기와 실제 `tsc`
인자는 유지했다.

```text
evt_JLRsdCGM-blGCWle  regression:typecheck:passed  succeeded  exit_code=0  tsc ["--noEmit"]
evt_O8PP0M0_-w3jygCH  regression:build:passed      succeeded  exit_code=0  tsc []
```

`git diff --check -- src/core/team-scorer.ts src/core/team-scorer.test.ts`도 출력 없이
exit 0이었다.

### package wrapper와 delivery gate

잘못 전달된 `결과:` 인자의 실패는 Vitest가 그 문자열을 파일 필터로 해석해
`No test files found`가 된 호출 오류다. 필터를
`src/core/team-scorer.test.ts`로 바로잡은 package 명령과 `npm run typecheck`,
`npm run build`는 package의 `tsx` CLI가 Unix socket을 열기 전에 샌드박스 권한
오류로 종료됐다.

```text
Error: listen EPERM: operation not permitted
.../T/tsx-501/*.pipe
```

`run-delivery-gate.sh --full`도 같은 wrapper 오류와 공유 작업트리의 dirty 상태를
각각 실패로 기록해 `PASS=0 FAIL=4 SKIP=0`이었다.

IPC 서버를 만들지 않는 `node --import tsx`로 동일 work-event 기록기와 내부 명령을
실행한 대상 테스트, typecheck, build는 각각 exit 0이다.

### 전체 suite

IPC 없는 loader로 전체 Vitest suite를 추가 실행했다.

```text
node --import tsx ./node_modules/vitest/vitest.mjs run
Test Files  2 failed | 119 passed (121)
Tests       2 failed | 699 passed (701)
```

실패는 scorer 범위 밖의 두 테스트였다.

- `tests/근거.test.ts`: 서울 오늘 날짜 `2026-07-28`을 기대했으나 최신 포인터가
  `2026-07-27`
- `src/security/command-gate.test.ts`: `Command path not trusted:`를 기대했으나
  `Command executable not found: vitest`

대상 scorer 회귀 테스트는 전체 suite에서도 통과했지만, 전체 suite 자체는 green이 아니다.

## lifecycle 안전 확인

검증 시점의 DB 행:

```text
id=team_hr-incubator-2026-w30
is_active=1
status=probation
last_score=81.5
last_sample_size=7
retired_at=NULL
last_checked_at=2026-07-27T19:30:00.005Z
```

소스 diff는 scorer와 테스트에만 있으며 lifecycle/retirement 쓰기를 추가하지 않았다.
검증 명령은 repository 표준에 따라 `work_events`에 테스트·typecheck·build 결과를 기록했다.

## Gap

- NCO `http://localhost:6200/api/health`는
  `curl: (7) Failed to connect to localhost port 6200`이어서 runtime HTTP 검증과 lease,
  NCO를 통한 교차리뷰는 미검증이다.
- package script 자체는 sandbox의 `tsx` IPC `EPERM`으로 미통과이며, 실제 내부 명령의
  IPC 없는 동등 실행만 통과했다.
- 전체 suite는 `119 files / 699 tests` 통과, 범위 밖 2 files / 2 tests 실패다.
- HR lifecycle의 점수 재계산·상태 변경·retirement 판단은 수행하지 않았다.

## 되돌리기

재빌드 없이 `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off`로 기존 집계를 복원할 수 있다.
코드 롤백은 `PROVIDER_AUTH_EXCLUSION_SQL`의 평문 subprocess 분기와
`team-scorer.test.ts`의 `plain provider credential rejection` 테스트만 제거하면 된다.
팀이나 lifecycle 행을 삭제·비활성화할 필요가 없다.

## 검증 영수증

- [변경] `src/core/team-scorer.ts`, `src/core/team-scorer.test.ts` — 실측 평문 provider 인증 거부의 완전 일치 분류와 양성·음성 회귀 테스트
- [검증방법] DB task 행·response hex 직접 조회; 대상 테스트 10/10; typecheck exit 0; build exit 0; 활성/비활성 scorer 계산 대조
- [등급] T1 (DB 행, 파일 내용, 명령 출력 직접 확인)
- [Gap] NCO HTTP/lease/교차리뷰, package `tsx` wrapper, 전체 suite의 범위 밖 2개 실패
- [미검증항목] runtime gateway 반영, HR lifecycle 재평가
