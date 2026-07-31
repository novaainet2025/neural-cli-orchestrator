# org_research / company-scope 정기 감사 — 재발행 지시 처리 보고 (2026-07-31)

- 대상 원본 작업: `task_Op7-5QgFJScqMWmr`
- 지시 출처: AX directive `vdir_bcf34eb0-9243-4861-821c-b123a79617c5` (type=`audit_required`, **재디스패치 5회차**)
- 판정: **신규 검증 실행 미생성 (의도적 보류)** — 해당 스코프는 이미 6/6 승인·영수증 소비 완료

## 1. 기존 승인 상태 (T1 재확인)

| 항목 | 값 | 확인 경로 |
|---|---|---|
| runId | `vrun_3d6aae88-3ed7-46f3-8fb0-5ee3e98a22c3` | `verification_runs` row |
| status / passed | `approved` / **6** | 동일 row |
| scope | org_research / `company-scope` / actor `claude-code` | 동일 row |
| receiptId | `vrcpt_c4c768b9-a3b4-43b6-b42e-7f05b43c4347` | `verification_receipts` row |
| 소비 | `vuse_86bc5501-...` → event `dd750eb2-...` @ 17:28:08.044Z | `verification_receipt_consumptions` row |
| 기관별 판정 | inspection·validation·measurement·performance·optimization·goal 전부 `failures: []` | `results_json` |

company-scope 스코프의 검증 실행은 **총 1건**(위 run)이며 rejected 0건.

## 2. 회사 전체 준수 상태 — 이전 잔여 갭 해소됨

`verification_runs` 스코프별 최신 실행:

| 스코프 | 최신 runId | 판정 |
|---|---|---|
| company-scope | `vrun_3d6aae88` | approved 6/6 |
| team_research-analysis | `vrun_806387f2` | approved 6/6 |
| team_research-discovery | `vrun_e61b3649` | approved 6/6 |
| team_research-strategy-2026 | `vrun_b989c683` | approved 6/6 |
| team_research-verification | `vrun_4a217166` | approved 6/6 |
| team_research-visualization | `vrun_59fae5c0` | approved 6/6 |
| team_research-writing | `vrun_87f37a2f` | approved 6/6 |

- 열린 반시드 루프: **0건** (`verification_loops` org_research 전 행 `completed`)
- oversight 집계: `compliantScopes 7 / activeScopes 7`, `failedScopes 0`, `activeRemediationLoops 0`
- 직전 보고의 잔여 2건 모두 해소: ① `team_research-visualization` 0/3 → 6/6, ② 회사 슬롯 제출률 75% → 07-28~07-30 am/pm 6/6 제출, 07-27 am/pm 은 `waived`

작업보고 제출(4일 창, org_research 전 스코프): submitted 56 / waived 4 / missed 10 → 약 85% (B 하한 80% 상회). 잔여 미제출은 전부 2026-07-26 이전 과거 슬롯.

## 3. 지시된 NCO 결박 — 구조적으로 불가 (409)

```
POST http://localhost:6200/api/tasks/task_Op7-5QgFJScqMWmr/verification
  {"receiptId":"vrcpt_c4c768b9-...","actorId":"claude-code"}
→ HTTP 409 {"error":"task_does_not_require_organization_audit"}
```

원인 (`src/server/gateway.ts:2591`): `requiresNovaAxAudit(task.team_id, metadata)` 게이트가
status·scope 검사보다 먼저 걸린다. 대상 작업은 `team_id = NULL`(company-scope)이므로 이 경로 자체가 적용 불가.
추가로 `status='completed'`이라 `status='reviewing'` 전제(2595행)도 불충족.
company-scope 결박의 정규 경로는 AX `POST /api/activity`이며, **2026-07-30 17:28:08 에 이미 수행·소비 완료**되었다.

## 4. 미해결 — 감사 지시 무한 재발행 (코드 수정 승인 대기)

`vdir_bcf34eb0` 는 run/receipt 생성 **12ms 후** 자동 생성되어 5회 재디스패치되었고, 동일 감사에 대해 NCO 태스크 3건을 파생시켰다:

| NCO taskId | status |
|---|---|
| `task_mtY2fWZ5aaG_TMCu` | completed |
| `task_zFpbyvTTzF1ofXL0` | failed |
| `task_1Izp3IRl51DmrPcV` | running (이번 지시) |

경로: NCO `gateway.ts:2664` 가 `task:completed` 를 `receiptId` 실은 채 publish → AX `onTaskEvent` 미러링 →
단일사용 가드가 `already consumed`/`subject mismatch` 로 반려 → `recordRejectedCompletion()` →
`queueCompletionAuditDirective()` 가 directive 를 재큐잉. 선택 쿼리에 subject 완료 조건이 없어 무한 반복.

전사 규모 증상: `attempt_count` 11~13 인 `audit_required` directive 10건 이상 (org_sns-blog, org_nova-ax, org_nco-engineering, org_ui-inspection, org_technology-porting 등).

수정 옵션(미적용, 사용자 승인 대기): (A) publish 에서 receiptId 제거/actor 통일 · (B) `onTaskEvent` 에서 receiptId 미전달 · (C) 이미 소비된 영수증이면 재큐잉 생략. **directive status 수동 조작은 금지.**

## 5. 판단 근거 — 왜 신규 run 을 만들지 않았나

지시의 검증기준은 "새 검증 실행이 6/6 approved"이나, 해당 스코프는 이미 6/6 승인 + 영수증 소비 완료 상태이고 열린 루프가 0건이다.
동일 관측 창(2.5시간 전)에 대해 중복 run 을 쌓으면 (a) 이미 소비된 영수증으로 결박이 409 로 실패하고 (b) 재발행 루프에 연료를 더한다.
저장된 T1 메모리(`project_org_research_company_scope_audit_done`)의 "재제출 금지" 지침과 라이브 실측이 일치하므로 보류를 선택했다.
