---
created_at: 2026-07-28T13:05:37Z
updated_at: 2026-07-28T13:07:02Z
team_id: team_content-quality
team_slug: content-quality
cycle: 2
tags:
  - improvement
  - improvement-note
  - content-quality
  - FORMAT_MISMATCH
  - response-quality
---

# 고품질 검수팀 cycle 2 — JSON 문자열 프로토콜 오반려

## 결론

최근 저하 표본의 실질 실패는 콘텐츠 검수 실패가 아니라 provider 직렬화 형식과
응답 품질 게이트의 경계 불일치였다. 전체 응답이 하나의 유효한 JSON 문자열인 경우에만
디코딩한 문자열로 프로토콜 접두사를 검사하는 국소 수정이 현재
`7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`에 반영돼 있다.

## T1 작업 증거

- 실패 행 `task_JjX-85_K_1H7WuEC`
  - `status=failed`
  - `error=quality_rejected: FORMAT_MISMATCH`
  - `response="done: workflow implementation gate passed"` (바깥 큰따옴표 포함)
- 재시도 행 `task_VZ3TWJjdlYpZ73Ab`
  - `status=completed`
  - `response=done: workflow implementation gate passed`
- 두 응답의 디코딩된 의미는 같고, 차이는 provider가 붙인 JSON 문자열 wrapper다.
- 2026-07-28 재계산 시 현재 스코어러 출력은
  `score=90.1`, `completion=92.9`, `n=14`, `sample=48h`였다.
  이는 현재 DB 스냅샷의 직접 계산값이며 수정의 인과 효과로 해석하지 않는다.

## Bounded fix와 안전 경계

- `src/verification/response-quality.ts`
  - 전체 응답이 유효한 JSON 문자열 하나일 때만 prefix 판정용 값을 unwrap한다.
  - 저장 원문, 구조화 JSON 처리, 도구 에코 탐지 등 다른 휴리스틱은 변경하지 않는다.
- `tests/response-quality.test.ts`
  - JSON 문자열로 감싼 유효한 `done:` 응답은 허용한다.
  - protocol prefix가 없는 JSON 문자열과 깨진 JSON 문자열은 계속 거절한다.
- 과거 실패 task의 상태·team_id는 수정하지 않았다.
- 팀의 `is_active=1`을 유지했으며 lifecycle 상태는 변경하지 않았다.

## 검증 영수증

- `npx vitest run tests/response-quality.test.ts`
  - `Test Files 1 passed (1)`
  - `Tests 15 passed (15)`
- `npx tsc --noEmit`
  - exit 0
- `npx tsc`
  - exit 0
- `node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- ./node_modules/.bin/tsc`
  - exit 0
  - work event `evt_f5q-uIyg-sU3pBpS`: `regression:build:passed`
- `npm run build`
  - 미통과: tsx IPC 소켓 생성이 `listen EPERM`으로 차단됐다.
  - `/private/tmp`로 변경해도 같은 `listen EPERM`이 재현됐다.
- build wrapper 진단 중 `tsc`를 PATH 없이 지정한 1회 시도는 `spawn tsc ENOENT`로
  실패했고, append-only work event `evt_hYvOf2ivpTdr8XHQ`와
  `evt_Npub9bKrPHeqsf7F`가 기록됐다. 위 성공 이벤트는 로컬 compiler의 명시 경로로
  다시 실행해 이 실패가 TypeScript 오류가 아님을 구분한다.
- NCO conductor
  - 미실행: `localhost:6200` 연결 거부.

## 장기 기억 연결

- Mem0: `mem0-1785242779311-najnyw`
  - namespace: `team:team_content-quality`
  - 동일 실패·수정 경계를 기록한 기존 항목을 직접 조회했고 중복 삽입하지 않았다.
- improvement note row:
  - `team-content-quality-cycle2-json-protocol-20260728`
  - 동일 root cause와 fix가 기록된 기존 행을 직접 조회했고 중복 삽입하지 않았다.

## 롤백

- 코드 롤백 단위: `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`의
  `protocolCandidate()` 추가와 두 호출부만 제거한다.
- 지식 산출물 롤백 단위: 이 노트 파일만 제거한다.
- DB task 행과 팀 lifecycle 데이터는 롤백 대상이 아니다.

## 미검증

- `npm run build` 래퍼의 정상 완료
- 실행 중 NCO HTTP 경로에서 동일 retired-provider 응답을 다시 흘린 E2E 결과
- 수정 이후 rolling-window 지표 개선의 인과성
