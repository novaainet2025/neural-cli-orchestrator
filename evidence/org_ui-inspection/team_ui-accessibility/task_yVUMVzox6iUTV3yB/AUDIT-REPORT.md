# Nova-AX 정기 감사 보고 — 미완료

- 회사: `org_ui-inspection`
- 팀: `team_ui-accessibility`
- 감사 대상: `task_yVUMVzox6iUTV3yB`
- 판정: `blocked_do_not_claim_approval`
- 새 검증 runId: 없음
- 승인 receiptId: 없음
- NCO 완료 결박: 미수행

## 기관별 판정

| 기관 | 판정 |
|---|---|
| 검사기관 | 미제출 |
| 검증기관 | 미제출 |
| 실측기관 | 미제출 |
| 성능테스트기관 | 미제출 |
| 최적화기관 | 미제출 |
| 목표달성 체크기관 | 미제출 |

## 직접 관측 결과

NCO 운영 DB에서 대상 작업은 `reviewing`, `verificationStatus=pending`,
`completed_at=NULL`, `evidence_json` 0바이트다. 응답의 SHA-256은
`5d3ba1f528641701971377f949c2c2e10dafb6c57c9481d2534da43d261c920c`다.

Nova-AX 운영 DB에서 대상 taskId의 run, receipt, receipt consumption,
remediation loop, loop attempt는 각각 0건이다. 현재 회사·팀 범위의 열린
remediation loop도 0건이다. 두 운영 DB의 `PRAGMA quick_check` 결과는 `ok`다.

정식 `work_reports` 테이블의 해당 팀 보고 행은 0건이다. 최신 팀 러너 산출물은
실제 UI 접근성 검사·실패 재현·수정 검증이 근거 부족으로 미확인이라고 명시한다.

현재 실행 환경에서 NCO `:6200`과 Nova-AX `:6300`은 모두
`curl` 종료 코드 7, HTTP `000` 연결 거부다. Nova-AX 및 NCO 연결자 호출은
각각 `user cancelled MCP tool call`로 실행되지 않았다.

## 남은 실패

1. 대상 작업 범위의 새 Nova-AX 검증 실행이 없다.
2. 6/6 승인 영수증과 영수증 소비 기록이 없다.
3. 대상 작업 자체가 요청했던 6/6 검증 및 완료 결박을 수행하지 않았다.
4. 실제 접근성 검사 산출물과 독립 기계 증거가 없다.
5. 제출 및 NCO 결박 HTTP 경로가 현재 실행 환경에서 도달 불가다.

승인 영수증이 없으므로 `POST /api/tasks/task_yVUMVzox6iUTV3yB/verification`은
실행하지 않았다. 미승인 상태를 완료로 전환하지 않는다.

기계 판독 스냅샷은 같은 디렉터리의 `audit-blocked-report.json`이다.
