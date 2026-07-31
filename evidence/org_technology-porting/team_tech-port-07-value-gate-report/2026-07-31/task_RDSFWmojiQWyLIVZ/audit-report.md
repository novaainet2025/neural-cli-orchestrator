# Nova-AX 정기 감사 보고 — 미통과

- 회사: `org_technology-porting`
- 팀: `team_tech-port-07-value-gate-report`
- 감사 대상: `task_RDSFWmojiQWyLIVZ`
- 대상 작업이 감사하던 선행 작업: `task_n6fEyN7Da3AS2l3X`
- 증거 등급: Tier 1 (SQLite 원장 행, 파일 내용·SHA-256, HTTP 접속 실측)

## 판정

새 Nova-AX 검증 실행은 생성되지 않았다. 따라서 6개 기관 모두 `미제출`이며,
승인 receipt도 없다. 유효한 receipt가 없으므로 NCO
`POST /api/tasks/task_RDSFWmojiQWyLIVZ/verification`은 호출하지 않았다.

| 기관 | 새 판정 |
|---|---|
| inspection 검사기관 | 미제출 |
| validation 검증기관 | 미제출 |
| measurement 실측기관 | 미제출 |
| performance 성능테스트기관 | 미제출 |
| optimization 최적화기관 | 미제출 |
| goal 목표달성 체크기관 | 미제출 |

## 원장 사실

- 대상 task: `reviewing`, `verificationStatus=pending`
- 대상 task 귀속 verification run: 0건
- 대상 task 귀속 receipt: 0건
- 대상 task 귀속 loop: 0건
- 회사·팀 범위의 열린 loop(`action_required`/`resubmitted`): 0건
- 대상 completion-audit directive: `dispatched`
- 현재 감사 실행 task: `task_NaAusuFjzF6IyL3n` (`running`, actor `codex`)
- directive attempt: 3

직전 감사 실행 `task_THsd224lq-j-rRXS`는 provider queue wait timeout으로 실패했고,
Nova-AX가 directive를 재큐잉한 뒤 현재 실행을 배정했다.

Nova-AX `verification_audit`에는 대상 completion 거부 행이 남아 있다. 최신 거부
`vaud_b3b2ad2f-b54f-40fb-afe1-fb55c5e11f10`의 사유는
`verified completion requires receiptId`이다. receipt 없는 완료 이벤트가 실제로
게이트에서 거부됐으므로 완료 상태로 보고할 수 없다.

동일 범위의 과거 승인 receipt
`vrcpt_0933c4d8-1190-4dba-8855-bca47c09d95b`는
`task_pximRcfB6RefFcJF`에 귀속되고 이미 1회 소비되었다. 대상 task에 재사용할 수 없다.
그 과거 반시드 loop `vloop_4c2e82d4-6d1b-42d9-a1ec-4b69d295e26a`와 attempt는
각각 `completed`, `approved`이지만 다른 task의 완료 조건이다.

## 남은 실패

- 대상 작업 자체가 선행 작업의 6/6 승인·완료 결박을 달성하지 못한 미검증 감사 결과다.
- 실제 팀 산출물은 `MERGE_RELEASE_DECISION: NO_GO`이며 P1~P4 구현, 동등 조건 A/B,
  fresh recovery rehearsal, unrestricted CI, permission/destructive E2E 등이 미검증이다.
- 회사·팀 원장에 `missed` 9건과 `pending` 1건, 합계 10건의 미수신 보고가 남아 있다.
- NCO `:6200`과 Nova-AX `:6300` 직접 HTTP 접속이 모두 실패했다.
- Nova-AX MCP 호출은 실행 전 취소되었고, 사용 가능한 앱 브라우저 백엔드는 0개였다.

## 재검증

```bash
bash evidence/org_technology-porting/team_tech-port-07-value-gate-report/2026-07-31/task_RDSFWmojiQWyLIVZ/verify-ground-truth.sh
```

성공 시 16개 독립 assertion과 다음 핵심 사실이 출력된다.

```text
ground_truth_assertions=16/16
target_runs=0
target_receipts=0
target_loops=0
scope_open_loops=0
historical_unreceived_reports=10
```

## 증거 경로

- `db/nco.db`
- `/Users/nova-ai/project/nova-ax/db/nova-ax.db`
- `data/team-runner/team_tech-port-07-value-gate-report-2026-07-23.md`
- `evidence/org_technology-porting/team_tech-port-07-value-gate-report/2026-07-31/task_RDSFWmojiQWyLIVZ/verify-ground-truth.sh`

DB 직접 수정, 과거 receipt 재사용, 검증 게이트 우회는 수행하지 않았다.
