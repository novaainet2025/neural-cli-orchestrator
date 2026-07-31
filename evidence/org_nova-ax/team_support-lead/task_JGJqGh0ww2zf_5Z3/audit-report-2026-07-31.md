# Nova-AX 정기 감사 — task_JGJqGh0ww2zf_5Z3

- 회사: `org_nova-ax`
- 팀: `team_support-lead`
- 감사 시각: `2026-07-30T15:58:34Z` (`2026-07-31T00:58:34+0900`)
- 최종 판정: **미완료**

## 새 검증 실행

- 새 runId: 없음
- 새 receiptId: 없음
- 기관별 판정: 새 제출이 없어 검사·검증·실측·성능테스트·최적화·목표달성 체크기관 모두 미판정
- NCO 완료 결박: 미수행

## 원본 작업 실측

읽기 전용 NCO SQLite 조회 결과:

- `tasks.id`: `task_JGJqGh0ww2zf_5Z3`
- `status`: `reviewing`
- `team_id`: `team_support-lead`
- `assigned_to`: `agy`
- `completed_at`: `NULL`
- `metadata_json.verificationStatus`: `pending`
- `evidence_json`: `NULL`
- 연결된 `artifacts` 행: 0건

원본 DB: `/Users/nova-ai/project/nco/db/nco.db`

## 기존 검증 기록 — 이번 새 실행 요건에는 부적합

- 기존 runId: `vrun_f82efdf2-cd42-4202-836f-9bba5c36bd84`
- 기존 receiptId: `vrcpt_48b0b5df-2c43-4211-b412-89a5d142a374`
- 기존 기관별 저장 판정: 6개 모두 `passed=true`
- receipt consumption: 0건
- 대상 task의 remediation loop: 0건
- loop attempt: 0건

이 기록은 재사용하지 않았다. 기존 제출 스크립트
`/Users/nova-ai/project/nova-ax/submit_support_lead.js`가 독립 실측 대신
`baseline=0`, `current=100`, `test successful`, 자체 생성 provenance를 사용한다.
또한 기존 산출물
`/Users/nova-ai/project/nova-ax/output/audit_team_support-lead.md`에는
`<runId>`와 `<receiptId>` 자리표시자가 남아 있다.

기존 산출물 직접 해시:

```text
e3244d9adc1b90b9965f25619e370c0352c0ec855514b2c83f0b56c851bd6374
```

원본 Nova-AX DB: `/Users/nova-ai/project/nova-ax/db/nova-ax.db`

## 팀 보고 의무 실측

`work_reports`의 최신 보고일 `2026-07-30`은 오전·오후 2건 모두
`submitted`이다.

전체 저장 이력은 다음과 같다.

| 상태 | 건수 |
|---|---:|
| submitted | 29 |
| late | 2 |
| missed | 13 |
| 합계 | 44 |

따라서 최신 완료 보고일의 2/2 제출은 확인되지만, 저장 이력 전체에 대해
“모든 보고 의무 수신”을 주장할 수는 없다.

## 제어 경로 실패

- `lsof`: `:6200`, `127.0.0.1:6300` listener 존재(T2 간접 증거)
- 셸 `curl`: 두 포트 모두 `curl: (7) Failed to connect`
- Node 로컬 fetch: `connect EPERM`
- Nova-AX MCP `ax_health`: `user cancelled MCP tool call`
- NCO MCP 상태/태스크 호출: `user cancelled MCP tool call`
- 인앱 브라우저: 사용 가능한 브라우저 0개

따라서 새 `POST /api/verification/runs`와
`POST /api/tasks/task_JGJqGh0ww2zf_5Z3/verification`는 전송되지 않았다.

## 재검증 SQL

```sql
-- NCO
SELECT id,status,assigned_to,team_id,completed_at,metadata_json,evidence_json
FROM tasks
WHERE id='task_JGJqGh0ww2zf_5Z3';

SELECT status,COUNT(*) AS count
FROM work_reports
WHERE team_id='team_support-lead'
GROUP BY status
ORDER BY status;

-- Nova-AX
SELECT id,status,passed_institutions,evidence_digest,results_json,created_at
FROM verification_runs
WHERE task_id='task_JGJqGh0ww2zf_5Z3'
ORDER BY created_at;

SELECT r.id AS receipt_id,c.id AS consumption_id,c.event_id,c.consumed_at
FROM verification_receipts r
LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
WHERE r.task_id='task_JGJqGh0ww2zf_5Z3';

SELECT *
FROM verification_loops
WHERE task_id='task_JGJqGh0ww2zf_5Z3';
```
