# Nova-AX 정기 감사 보고 — task_pevcTEWfvszz8vXe

- 회사: `org_ui-inspection`
- 팀: `team_ui-ax-design`
- 원본 작업: `task_pevcTEWfvszz8vXe`
- 감사 판정: **미완료**
- 새 검증 runId: 없음
- 승인 receiptId: 없음
- 완료 이벤트 결박: 없음

## 기관별 판정

| 기관 | 새 판정 | 근거 |
|---|---|---|
| inspection | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |
| validation | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |
| measurement | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |
| performance | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |
| optimization | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |
| goal | 미실행(unknown) | 대상 작업의 운영 `verification_runs` 행 0건 |

운영 Nova-AX SQLite 직접 조회:

- `verification_runs`: 0
- `verification_receipts`: 0
- `verification_loops`: 0
- `verification_loop_attempts`: 0
- `verification_receipt_consumptions`: 0
- 범위 레지스트리: `active=1`

운영 NCO SQLite 직접 조회:

- `tasks.status=cancelled`
- `tasks.completed_at=NULL`
- `metadata.verificationStatus=pending`
- `metadata.verificationReceiptId=NULL`
- 완료 소비 이벤트: 0

## 수집된 독립 기계 증거

읽기 전용 SQLite/파일시스템 수집기가 현재 작업 결과를 다시 평가했다.

- 요구 검사: 10/10
- 음성 대조: 7/7 변형 탐지
- 작업 시간창 대상 저장소 변경: 0
- 선언한 후속 UI 산출물 생성: 0
- 실제 응답 SHA-256: `82ad9a391e5221bf7cc129375db93690dfda48c2b6fe3c4819ea325c01fd4ab3`
- 검사 증거 SHA-256: `4887644cf09f3445d65f152041b871140108ed86a49b5b148e2f2e817edeadba`
- 음성 대조 SHA-256: `762d264576018c26e7b04f2c9336cd86579ed13d104533158f75f3466766b9f4`
- 파일시스템 관측 SHA-256: `0084e54c5bd15f25f316b559d9907558f1984ef700719439dfbfa2ed41c40014`
- 최종 감사 산출물 SHA-256: `633ced84117840382d939e4c8256918ccaf39bcaa47b007791e2ad65f35b3de7`

이 증거는 제출 준비가 됐지만 운영 Nova-AX 기관 판정을 대신하지 않는다.

## 남은 실패

1. NCO `:6200`, Nova-AX `:6300` 모두 `ECONNREFUSED`.
2. 컴파일된 NCO 전경 기동은 `listen EPERM 0.0.0.0:6200`으로 차단됨.
3. Nova-AX 공식 `Fastify.inject` 운영 DB 제출은 `SQLITE_READONLY`로 차단됨.
4. 설치된 Nova-AX/NCO 제어 연결 호출은 `user cancelled MCP tool call`로 반환됨.
5. 영수증이 없으므로 NCO verification POST는 수행하지 않았다.
6. 영수증이 생겨도 현재 `tasks.status=cancelled`이다. 공식 NCO 라우트는 `reviewing` 이외 상태에 `409 task_not_waiting_for_verification`을 반환하도록 구현되어 있어, 지원되는 상태 복구가 먼저 필요하다. DB 직접 상태 변경은 검증 게이트 우회이므로 수행하지 않았다.

## 완료 조건

다음 모두가 새로 관측돼야 완료다.

1. 대상 작업 전용 Nova-AX run이 `approved`, `passed_institutions=6`.
2. 대상 작업/회사/팀/actor가 일치하는 receipt 발급.
3. 열린 반시드 루프가 생기면 해당 attempt와 loop가 `completed`.
4. NCO 공식 verification POST가 200을 반환.
5. 영수증 소비 1건, NCO 작업 `completed`, `verificationStatus=approved`.
