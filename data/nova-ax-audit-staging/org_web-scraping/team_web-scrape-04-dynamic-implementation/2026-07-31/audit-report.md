status: 부분 감사 — 신선한 기계 증거는 생성·검증했지만 Nova-AX 새 검증 실행과 NCO receipt 결박은 접근 경계로 차단되어 완료로 보고하지 않는다.

# Nova-AX 정기 감사 보고

- 회사: `org_web-scraping`
- 팀: `team_web-scrape-04-dynamic-implementation`
- 원본 작업: `task_pnxUEketwozTapq7`
- 증거 관측 시각: `2026-07-30T19:09:59.044Z`
- 권위 상태 재조회 시각: `2026-07-30T19:12:42.798Z`

## 현재 감사 판정

- 새 검증 runId: 없음
- 새 receiptId: 없음
- 새 완료 이벤트 결박: 없음
- 열린 반시드 루프: `0`
- 원본 작업 대상 감사 directive: `1`건 `queued`
- 최종 판정: `BLOCKED_NOT_COMPLETED`

| 기관 | 현재 판정 | 실패/차단 |
|---|---|---|
| 검사기관 (`inspection`) | 미검증 | 새 Nova-AX 실행 미생성 |
| 검증기관 (`validation`) | 미검증 | 새 Nova-AX 실행 미생성 |
| 실측기관 (`measurement`) | 미검증 | 새 Nova-AX 실행 미생성 |
| 성능테스트기관 (`performance`) | 미검증 | 새 Nova-AX 실행 미생성 |
| 최적화기관 (`optimization`) | 미검증 | 새 Nova-AX 실행 미생성 |
| 목표달성 체크기관 (`goal`) | 미검증 | 새 Nova-AX 실행 미생성 |

## 신선한 기계 증거

- NCO SQLite 최근 7일 실측:
  - 완료 작업 `21 / 29`
  - 제출 보고 `10 / 14`
- Vitest:
  - 테스트 파일 `2 / 2` 통과
  - 테스트 `7 / 7` 통과
  - exitCode `0`
  - duration `2164ms`
- Scrapling 정책 unittest:
  - 테스트 `11 / 11` 통과
  - exitCode `0`
  - duration `245ms`
- 관측 artifact SHA-256:
  - `6b7a63d55bb00494ec64d21f653775099e6a6dfc822392e138326a52b603d886`

## 제출 시도 결과

- Nova-AX `GET /api/health`: `connect EPERM 127.0.0.1:6300`
- NCO `GET /api/tasks/task_pnxUEketwozTapq7`: `connect EPERM 127.0.0.1:6200`
- Nova-AX `POST /api/verification/runs`: 선행 health 접근 실패로 미실행
- NCO `POST /api/tasks/task_pnxUEketwozTapq7/verification`: 새 승인 receipt가 없어 미실행

호스트의 `lsof`에서는 `:6300`과 `:6200` 리스너가 관측됐으므로 서비스 부재가 아니라 현재 실행 경계의 localhost 연결 차단으로 분류한다.

## 권위 원장 재검증

현재 원장에는 이 작업에 대한 과거 실행이 1건 있다.

- 과거 runId: `vrun_77a6fe63-cffe-4bd0-85c0-1a9acce6e160`
- 과거 판정: `approved 6/6`
- 과거 receiptId: `vrcpt_3c2b3e44-aafa-4641-bfe8-6443c72f9461`
- 과거 receipt 소비: `vuse_55fe199f-19bf-44a1-ae32-af7abf9bf278`
- 과거 완료 event: `8fbe2425-4af9-4bea-aa3b-d3efa9198432`

이 실행과 receipt는 현재 원본 작업 대상 감사 directive가 생성되기 전에 발행·소비되었으므로 현재 감사의 새 실행이나 결박에 재사용하지 않는다.

## 남은 실패

1. 신선한 `submission-payload.json`을 Nova-AX에 제출해 새 6/6 판정과 receipt를 받아야 한다.
2. 원본 NCO 작업은 현재 `completed`다. 현재 gateway 구현은 `/verification` 호출 시 작업 상태가 `reviewing`이 아니면 `409 task_not_waiting_for_verification`을 반환하도록 되어 있다. 이는 소스와 DB에 근거한 예상이며, 현재 네트워크 차단 때문에 실제 HTTP 응답은 아직 미관측이다.
3. 새 receipt를 NCO POST로 소비하고, Nova-AX consumption 행 및 `task_complete` 이벤트를 재조회해야 한다.
4. 원본 작업 대상 `queued` 감사 directive를 `completed`로 닫아야 한다.

## 증거 경로와 SHA-256

- `evidence-manifest.json`
  - `591760676c7ed86b8e384ddc6b9cf3b7b564426f4c4f8f91208c33ede22e5c64`
- `submission-payload.json`
  - `3351b5bd74ce5708145752375a7ee8a89b1137e7d4c7f3b97d2743ee09b5a781`
- `authority-state.json`
  - `3d20b0c1731948be132175987878147aa4a4001857a2111163d5278b2a672ac4`
- `submission-attempt.json`
  - `dde4f06ad0b156896cb708cd6c79c003ae3ec404f98a5d8b28ab43b4383d5e2a`
- `vitest-output.txt`
  - `c6ec2eb368471b860f92a8418cfaf4932e1e33d17259c185c3ec2844d3aba49c`
- `scrapling-policy-output.txt`
  - `5771bc9c29a6f17060a3c40908f19211ab855235cc86c6c8026271e9a570a8e8`
