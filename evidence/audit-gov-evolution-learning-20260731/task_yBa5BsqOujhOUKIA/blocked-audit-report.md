# Nova-AX 정기 감사 차단 보고

- 회사: `org_nco-evolution`
- 팀: `team_gov-evolution-learning`
- 감사 대상 NCO 작업: `task_yBa5BsqOujhOUKIA`
- 관측 시각: `2026-07-30T21:50:31Z`
- 최종 판정: `BLOCKED_NOT_COMPLETED`

## 권위 원장 관측

- NCO 작업 상태: `reviewing`
- NCO 검증 메타데이터: `verificationStatus=pending`
- Nova-AX 새 검증 실행: 0건
- 기관별 판정: inspection, validation, measurement, performance, optimization, goal 모두 미실행
- 승인 영수증: 0건
- 영수증 소비: 0건
- 대상 작업에 결박된 반시드 루프: 0건
- 대상 작업 감사 지시:
  - `vdir_6b133fe5-b14b-4b3d-b059-49543ed122ca`
  - 상태 `dispatched`
  - 감사 실행 작업 `task_WeAVdnJBBISJLT4v`

대상 작업 자체는 이전 감사에서 `task_x21RZj7Pog5HXkTi`의 검증과 완료 결박이 생성되지 않았다고
보고했으며, 현재도 그 결과가 `reviewing` 상태로 남아 있다. 다른 task에 발급된 기존 영수증은 이
task에 재사용할 수 없다.

## 실행 경로 진단

- `curl http://localhost:6300/api/health` → 연결 거부
- `curl http://localhost:6200/api/tasks/task_yBa5BsqOujhOUKIA` → 연결 거부
- Nova-AX MCP `ax_health` 및 `ax_request` → `user cancelled MCP tool call`
- NCO MCP `nco_get_task` → `user cancelled MCP tool call`
- Nova-AX 실제 `dist/index.js` 전경 기동 → `SQLITE_READONLY: attempt to write a readonly database`
- PM2 제어 → `/Users/nova-ai/.pm2/rpc.sock` 접근 `EPERM`
- 브라우저 교차 확인 → 사용 가능한 브라우저 0개

이 환경에서 Nova-AX 권위 원장에 새 run을 기록하거나 NCO 완료 결박을 수행할 수 있는 허용된 쓰기
경로가 없다. 복제 DB나 자체 생성 상태 문자열을 권위 run/receipt로 보고하지 않는다.

## 재검증 경로

- NCO 원장: `/Users/nova-ai/project/nco/db/nco.db`
- Nova-AX 원장: `/Users/nova-ai/project/nova-ax/db/nova-ax.db`
- 이 보고서: `/Users/nova-ai/project/nco/evidence/audit-gov-evolution-learning-20260731/task_yBa5BsqOujhOUKIA/blocked-audit-report.md`

관측 시점 파일 SHA-256:

- NCO 원장: `5673e7954c3fc24f33e61beb7a035438629e42a1ec508ee68864b3f80ba1bfb6`
- Nova-AX 원장: `9be75ef99e13b65e350bb7dee7e83452b63508e22e9a56cb5f510f33dbeb131f`

## 완료에 필요한 다음 조건

1. 실제 Nova-AX 서비스 또는 연결형 `ax_request`에 권위 쓰기 접근이 복구되어야 한다.
2. `task_yBa5BsqOujhOUKIA` 전용 새 검증 실행이 6/6 approved여야 한다.
3. 새 receiptId를 동일 actorId와 함께
   `POST /api/tasks/task_yBa5BsqOujhOUKIA/verification`에 제출해야 한다.
4. Nova-AX `verification_receipt_consumptions`와 NCO `tasks.status=completed`,
   `verificationStatus=approved`를 독립적으로 재확인해야 한다.
5. 이후 열린 반시드 루프가 생기면 해당 loop attempt가 `completed`여야 한다.
