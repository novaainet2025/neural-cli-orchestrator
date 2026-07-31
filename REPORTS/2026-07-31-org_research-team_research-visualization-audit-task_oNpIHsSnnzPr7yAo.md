# Nova-AX 정기 감사 보고 — `org_research` / `team_research-visualization`

- 감사 대상 원본 작업: `task_oNpIHsSnnzPr7yAo`
- 감사 실행 시각: 2026-07-31T00:55:59Z
- actorId: `sys_auto` (반시드 루프 actor와 일치해야 하는 제약)

## 1. 검증 실행 결과

| 항목 | 값 |
|---|---|
| runId | `vrun_c7d6af04-b43b-4f12-8f6e-8db809991d54` |
| 판정 | **approved — 6/6** |
| receiptId | `vrcpt_97042ea8-664f-42a8-babc-aa94a8a17eb9` |
| 영수증 소비 | `vuse_968809af-cad5-45a1-9fa5-fe1ed8d13453` (event `nco-audit-approved:task_oNpIHsSnnzPr7yAo:1785459359545`) |
| evidenceDigest | `02a8fa5d3fe57e55c6173b512cdb40bb41d559efec44d483b4c689e801956946` |

### 기관별 판정 (전 기관 `failures: []`)

| 기관 | 판정 | evidenceRef |
|---|---|---|
| inspection 검사기관 | ✅ passed | `96ee56a4…e46cb9` (audit-artifact.json SHA-256) |
| validation 검증기관 | ✅ passed | `96ee56a4…e46cb9` |
| measurement 실측기관 | ✅ passed | `906b19c5…cbf349` |
| performance 성능테스트기관 | ✅ passed | `7148afc0…91826b` |
| optimization 최적화기관 | ✅ passed | `b8a0d777…1a3f344` |
| goal 목표달성 체크기관 | ✅ passed | 8개 해시 전량 |

## 2. 반시드 루프 종결

직전 실행 `vrun_8abb2691-…`(actor `sys_auto`, 4/6 rejected)이 연 루프를 이번 실행으로 닫았다.

| 항목 | 값 |
|---|---|
| loopId | `vloop_1d4b698b-cecf-43fc-b174-93fca11d207a` |
| 상태 | **completed** (iteration 1 / max 5) |
| attemptId | `vattempt_7f865dbc-9bb5-4c5f-8736-475d591abaaf` — decision `approved` |
| latestRunId | `vrun_c7d6af04-…` |

교정된 두 지적 사항:

| 기관 | 원래 실패 | 교정 방식 |
|---|---|---|
| inspection | `artifact path is outside approved verification roots` | 증거 번들 전체를 승인된 root `/Users/nova-ai/project/nova-ax` 하위로 이전 (`src/index.ts:377` allowedRoots = `join(__dirname,"..")`) |
| validation | `independent attestation does not match the observed artifact` | 독립 무결성 증명을 artifact 바이트 기록 **후** 산출해 `observedSha256`이 실제 관측 해시와 동일하도록 강제 |

두 remediation action(`vaction_7226…`, `vaction_0e98…`) 모두 `resolved`.

## 3. 원본 작업 결박

`POST /api/tasks/task_oNpIHsSnnzPr7yAo/verification` → HTTP 200
`{ok:true, status:"completed", verificationStatus:"approved", receiptId:"vrcpt_97042ea8-…"}`

NCO DB 실측: `status=completed`, `completed_at=2026-07-31 00:55:59`,
`metadata.verificationReceiptId=vrcpt_97042ea8-…`, `verificationApprovedAt=2026-07-31T00:55:59.720Z`.

## 4. 감사한 실제 산출물 (자가보고·LLM 주장 배제)

- source: `task_5lrS6-LkLTpP97uW` (actor `agy`, `spawned_by_cli=work-report-scheduler`, completed) — sha256 `391068ce…006ed7`, visible 1357자
- baseline: `task_FIeI336uBZOo2b42` (actor `agy`, `spawned_by_cli=team-runner`, completed) — visible 1201자
- 실행 테스트 `visualization-workreport-fact-and-integrity-suite`: **27/27 통과, exit 0, 884ms**
  (주입 ground-truth 8개 사실이 프롬프트에 존재하고 보고서가 11개 사실을 그대로 재현하는지 대조 포함)
- 측정: `visualization_workreport_visible_characters` 1201 → 1357 (target 1200, higher_is_better)
- 회귀 가드: `regressionGuardPassed=true` (15개 하위 가드 전부 true)

증거 디렉터리:
`/Users/nova-ai/project/nova-ax/evidence/org_research/team_research-visualization/2026-07-31-task_oNpIHsSnnzPr7yAo/`

## 5. 감사 후 스코프 상태 (`GET /api/verification/oversight`)

```
activeScopes 1 · compliantScopes 1 · unverifiedScopes 0 · failedScopes 0
activeRemediationLoops 0 · completedRemediationLoops 2 · exhaustedRemediationLoops 0
failureQueue [] · nextActions 0 · enforcement.coverageComplete true
```

## 6. 남은 실패 / 미해결 사항

**기관 실패: 없음 (0건).** 다만 감사 범위 밖의 인프라 결함 2건을 관측했다.

### 6-1. 결박 직후 directive 재큐잉 (미수정, 승인 대기)

T1 시각 증거 (`verification_audit`):

| 시각 | 이벤트 | 내용 |
|---|---|---|
| 00:55:59.561Z | `completion_accepted` | 내 결박 성공 → `vdir_713077ee`를 `completed`로 전환 |
| 00:56:00.254Z | `completion_rejected` | 별개 이벤트 `e6373e5d-982b-40db-a6e0-e2a698fbe910` 이 **다른 작업의 receiptId**를 실어 도착 → `verification receipt subject mismatch` |
| 00:56:00.255Z | `completion_audit_queued` | 위 거절이 같은 감사 지시를 **재큐잉** |
| 00:56:40.491Z | 재-dispatch | `vdir_713077ee` → NCO `task_GdpG9dulpeI0rSoL` |

즉 **같은 감사 지시가 무한 재발행된다.** 이는 팀 결함이 아니라 이벤트 생산자 결함이다.
기존에 기록된 "already consumed" 변종과 달리 이번은 `receipt subject mismatch` 변종이며,
문제 이벤트 id가 `nco-audit-pending:`/`nco-audit-approved:` 접두사가 아닌 **raw UUID**라
NCO gateway의 두 공식 경로(`gateway.ts:1061`, `gateway.ts:2554`)가 아닌 제3의 생산자다.
생산자 특정·수정은 별도 승인 필요 — 이번 감사에서 변경하지 않았다.

### 6-2. 팀 작업보고 파이프라인 실패 (감사 게이트와 별개)

마지막 결박(2026-07-30T19:47:49Z) 이후 이 팀의 새 work-report는 **성공하지 못했다**:

| 작업 | 상태 | 비고 |
|---|---|---|
| `task_vhec7cxFiSeneQ--` | failed | work-report-scheduler, 2026-07-30 23:31 |
| `task_f0yAizwYtdhL0wwa` | queued | work-report-scheduler, 2026-07-31 00:44 |
| `task_rUHsSo3BvN8CU0jw` | completed | **환각 응답** — 존재하지 않는 `receipt_20240731_6a9b5f`, evidenceDigest는 `sha1("foo\n")` |

따라서 이번 감사의 source는 여전히 2026-07-30 05:04의 `task_5lrS6-LkLTpP97uW`이며,
**직전 사이클과 동일한 산출물**이다. 새 산출물이 아님을 명시한다.
`task_rUHsSo3BvN8CU0jw`의 거짓 보고는 별도 조치 대상.

## 검증 영수증

- **[변경]**
  - `nova-ax/evidence/org_research/team_research-visualization/2026-07-31-task_oNpIHsSnnzPr7yAo/` — 증거 수집기·제출기 + 15개 증거 파일 신규
  - Nova-AX: run `vrun_c7d6af04-…`, receipt `vrcpt_97042ea8-…`, 소비 `vuse_968809af-…`, attempt `vattempt_7f865dbc-…`
  - NCO: `task_oNpIHsSnnzPr7yAo` `reviewing` → `completed`
- **[검증방법]**
  - `GET :6300/api/verification/runs/vrun_c7d6af04-…` → 본문 `approved 6/6`, 전 기관 `failures: []`
  - `GET :6300/api/verification/loops/vloop_1d4b698b-…` → 본문 `completed`, actions 2건 `resolved`, attempt decision `approved`
  - `sqlite3 nova-ax.db` → `verification_runs`/`verification_receipts`/`verification_receipt_consumptions`/`verification_loops`/`verification_loop_attempts`/`verification_remediations` row 직독
  - `GET :6200/api/tasks/task_oNpIHsSnnzPr7yAo` + `sqlite3 nco.db` → `status=completed` + `verificationReceiptId` 일치
  - `shasum -a 256 audit-artifact.json` → `96ee56a4…e46cb9` = 기관 evidenceRef와 동일
  - 실행 테스트 exit 0, 27/27 (로그 파일 본문 파싱)
- **[등급] T1** — HTTP 응답 본문 + SQLite row + 파일 해시 직접 확인. 스크립트 자체 출력에 의존하지 않고 별도 호출로 재확인함.
- **[Gap] 100%** — 지시된 검증기준(새 run 6/6 approved + 열린 반시드 루프 attempt completed) 양쪽 충족.
- **[미검증항목]**
  - 6-1 재큐잉 이벤트(`e6373e5d-…`)의 **생산자 코드 경로**는 특정하지 못함 — NCO gateway 2경로가 아니라는 사실까지만 확인
  - `task_GdpG9dulpeI0rSoL`(재-dispatch된 중복 감사 작업)의 최종 귀결은 미관측
  - 6-2의 실패한 work-report 3건의 근본원인은 이번 범위 밖 — 미조사
  - `org_research` 회사 전체 scope(팀 범위 밖)는 이번 완료로 주장하지 않음
