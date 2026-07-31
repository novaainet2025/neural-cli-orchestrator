# 감사 보고 — org_ui-inspection / team_ui-accessibility

관찰 시각: 2026-07-30T19:50:36Z  
감사 대상: `task_I2FM116aXy5I2r6-`

## 판정

- 새 검증 runId: 없음
- 기관별 판정: 실행되지 않음
- 승인 receiptId: 없음
- NCO 완료 결박: 실행되지 않음
- 완료 주장: 하지 않음

## 직접 확인된 상태

- NCO `tasks` 행은 `status=reviewing`, `assigned_to=claude-code`,
  `response_chars=3384`, `verificationStatus=pending`이다.
- 실제 감사 산출물
  `/Users/nova-ai/project/nova-ax/evidence/audit-ui-inspection-accessibility-20260731/independent-audit-findings.md`
  의 SHA-256은
  `eb6709331d09e012d26b4af7e1ccf48c8b3daa1e8d5605277ba3762662a453ec`이다.
- 산출물이 인용한 이전 작업 `task_GtlvAXGUd5dkXZyl`의 검증은
  `vrun_538b0367-63eb-4321-932a-2d609197170f`, `approved 6/6`이며,
  영수증 `vrcpt_6b1e5e0a-eb61-450d-bb72-76f7a15801e9`는
  `vuse_76f633e6-d261-4c50-91a5-a9f9315f2f00`으로 소비된 것을
  Nova-AX SQLite에서 재확인했다.
- 현재 회사·팀 범위의 반시드 루프는 4건 모두 `completed`이며 열린 루프는 0건이다.
- NCO `work_reports`에서 `organization_id=org_ui-inspection` 또는
  `team_id=team_ui-accessibility`인 행은 0건이다.

## 차단 사유

새 검증 실행과 완료 결박에 필요한 쓰기 가능한 API 전송 경로가 없었다.

1. 셸에서 `localhost:6300`과 `localhost:6200` 연결이 모두 HTTP 000으로 차단됐다.
2. Nova-AX/NCO MCP 호출은 사용자 취소로 반환됐다.
3. 인앱 브라우저 런타임은 사용 가능한 브라우저가 0개였다.
4. 별도 연결 런타임의 `fetch()`도 `fetch failed`로 종료됐다.

검증 영수증 테이블이나 NCO 작업 상태를 직접 수정하는 방식은 검증 게이트
우회이므로 수행하지 않았다.

## 남은 실패

1. `task_I2FM116aXy5I2r6-`에 대한 새 `6/6 approved` 실행과 receipt가 없다.
2. 따라서 `POST /api/tasks/task_I2FM116aXy5I2r6-/verification` 결박이 없다.
3. 현재 범위의 공식 `work_reports` 행이 0건이다.

원시 기계 스냅샷은 같은 디렉터리의 `machine-snapshot.json`에 있다.
