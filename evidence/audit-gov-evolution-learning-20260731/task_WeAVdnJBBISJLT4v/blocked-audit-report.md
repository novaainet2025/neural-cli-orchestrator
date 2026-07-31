# Nova-AX 정기 감사 차단 보고 — task_WeAVdnJBBISJLT4v

- 회사: `org_nco-evolution`
- 팀: `team_gov-evolution-learning`
- 감사 대상 NCO 작업: `task_WeAVdnJBBISJLT4v`
- 대상 작업이 감사한 하위 작업: `task_yBa5BsqOujhOUKIA`
- 관측 시각: `2026-07-31T03:55:14Z`
- 최종 판정: `BLOCKED_NOT_COMPLETED`

## 완료 게이트

- 새 Nova-AX 검증 runId: 없음
- 6개 기관 판정: 모두 미실행
- 승인 receiptId: 없음
- NCO 완료 결박: 미수행
- 현재 작업 상태: `reviewing`
- 현재 작업 검증 메타데이터: `verificationStatus=pending`
- 현재 작업 전용 열린 반시드 루프: 0건
- 현재 회사/팀 범위 열린 반시드 루프: 0건

기관별 현재 판정:

| 기관 | 판정 | 사유 |
| --- | --- | --- |
| inspection | 미실행 | 현재 작업 전용 제출 run이 없음 |
| validation | 미실행 | 현재 작업 전용 제출 run이 없음 |
| measurement | 미실행 | 현재 작업 전용 제출 run이 없음 |
| performance | 미실행 | 현재 작업 전용 제출 run이 없음 |
| optimization | 미실행 | 현재 작업 전용 제출 run이 없음 |
| goal | 미실행 | 현재 작업 전용 제출 run이 없음 |

## 실제 산출물 관측

NCO 원장의 `tasks` 행에서 현재 작업의 응답은 하위 작업
`task_yBa5BsqOujhOUKIA`에 6/6 승인과 완료 결박이 없음을 보고한 최종 차단 감사 결과다.

응답이 인용한 산출물:

- 경로:
  `/Users/nova-ai/project/nco/evidence/audit-gov-evolution-learning-20260731/task_yBa5BsqOujhOUKIA/blocked-audit-report.md`
- 바이트: `2903`
- SHA-256: `3be1c7d92bb5b5ddf451f37feee7e2cd2ebc2cab86192207edee58e479c08590`

파일 내용과 NCO/Nova-AX 원장을 재검사한 결과:

- `task_WeAVdnJBBISJLT4v`: `reviewing`, `verificationStatus=pending`,
  `completed_at=null`
- `task_yBa5BsqOujhOUKIA`: `reviewing`, `verificationStatus=pending`,
  `completed_at=null`
- `task_WeAVdnJBBISJLT4v`에 결박된 `verification_runs`: 0건
- `task_WeAVdnJBBISJLT4v`에 결박된 `verification_receipts`: 0건
- 회사/팀 범위 열린 `verification_loops`: 0건

## 작업 보고 의무 수신 상태

NCO `work_reports` 원장에 현재 회사/팀 범위 행은 총 20건이다.

- `submitted`: 15건
- `missed`: 5건

미수신 행:

| workReportId | 날짜/슬롯 | 주체 | sourceTaskId |
| --- | --- | --- | --- |
| `wr_dUqp7bT31nDzpO2n` | 2026-07-26 pm | organization | 없음 |
| `wr_6UPabCZJPoitVftv` | 2026-07-27 am | organization | 없음 |
| `wr_mFYMUMA_uwpQoDU6` | 2026-07-27 pm | organization | 없음 |
| `wr_hlMVC4bKv8rSXxZa` | 2026-07-31 am | organization | `task_eYq-hIZg9tItzfNv` |
| `wr_5WtIdFWRnPBW-pQ3` | 2026-07-31 am | team | `task_FHLgqgdCaR5Vk7Sp` |

따라서 “모든 회사·팀의 작업 보고 의무 수신”은 현재 원장 기준 미충족이다.

## 허용된 실행 경로 진단

- 셸 `curl http://localhost:6300/api/health`:
  `curl: (7) Failed to connect to localhost port 6300 after 0 ms: Couldn't connect to server`
- 셸 `curl http://localhost:6200/api/tasks/task_WeAVdnJBBISJLT4v`:
  `curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server`
- Nova-AX MCP `ax_request`:
  `user cancelled MCP tool call`
- NCO MCP `nco_get_task`:
  `user cancelled MCP tool call`
- 호스트 브라우저 가용 목록: `[]`
- PM2 제어:
  `connect EPERM /Users/nova-ai/.pm2/rpc.sock`
- 프로세스 간접 증거:
  `lsof`에서 `127.0.0.1:6300`, `*:6200`, `127.0.0.1:6201` 리스너가 관측됨

`lsof`는 프로세스 존재를 보일 뿐 HTTP 동작이나 쓰기 성공을 증명하지 않는다. 반대로 이
세션의 연결 실패는 샌드박스에서 API에 도달하지 못했다는 증거이며 호스트 서비스가
죽었다는 증거는 아니다.

## 남은 실패

1. 작업 보고 의무 5건이 `missed`로 남아 있다.
2. 현재 작업 전용 새 Nova-AX 검증 run이 없다.
3. 6개 기관 중 실행된 기관이 없다.
4. 승인 receiptId가 없다.
5. NCO `POST /api/tasks/task_WeAVdnJBBISJLT4v/verification` 결박이 없다.
6. 이 세션에는 허용된 Nova-AX/NCO HTTP 쓰기 경로가 없다.
7. 현재 산출물은 NCO 경로에 있고, 운영 Nova-AX의 기본 관측 허용 루트는
   `/Users/nova-ai/project/nova-ax`이다. 운영 환경의 `AX_VERIFICATION_ROOTS`에 NCO
   경로가 설정된 증거도 없다.

## 재검증 증거 경로

- NCO 권위 원장: `/Users/nova-ai/project/nco/db/nco.db`
- Nova-AX 권위 원장: `/Users/nova-ai/project/nova-ax/db/nova-ax.db`
- 하위 감사 산출물:
  `/Users/nova-ai/project/nco/evidence/audit-gov-evolution-learning-20260731/task_yBa5BsqOujhOUKIA/blocked-audit-report.md`
- 현재 감사 보고:
  `/Users/nova-ai/project/nco/evidence/audit-gov-evolution-learning-20260731/task_WeAVdnJBBISJLT4v/blocked-audit-report.md`

완료로 전환하려면 먼저 5개 누락 보고를 권위 NCO 경로로 수신 처리하고, 현재 작업 전용
증거를 운영 Nova-AX가 직접 관측 가능한 경로에 둔 뒤 새 6/6 approved run을 생성해야
한다. 열린 반시드 루프가 생기면 그 loop attempt를 `completed`로 만든 다음, 새
receiptId와 동일 actorId를 NCO 검증 엔드포인트에 제출해야 한다.
