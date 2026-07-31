# Nova-AX 정기 감사 — `org_research` / `team_research-visualization`

- 감사 대상 원본 작업: `task_LpxitMAJ2WDfhBcx`
- 실행 시각: 2026-07-30T19:47:49Z (KST 2026-07-31 04:47)
- 증거 번들: `/Users/nova-ai/project/nova-ax/evidence/org_research/team_research-visualization/2026-07-30-task_LpxitMAJ2WDfhBcx/`

## 1. 결과 요약

| 항목 | 값 |
|---|---|
| 검증 runId | `vrun_59fae5c0-060b-4138-8a61-384e9484086f` |
| 판정 | **approved — 6/6** |
| receiptId | `vrcpt_b2a3aca6-afb6-4026-9720-955636fc32fa` |
| 영수증 소비 | `vuse_e539937a-4e9b-4800-96e5-bab689fa28ff` (event `nco-audit-approved:task_LpxitMAJ2WDfhBcx:1785440869738`) |
| actorId | `agy` |
| NCO 결박 | `POST /api/tasks/task_LpxitMAJ2WDfhBcx/verification` → 200, `status=completed` |
| 열린 반시드 루프 | 0건 (스코프 유일 루프 `vloop_91a99931`은 이미 `completed`) |
| 스코프 준수 | `compliantScopes=1`, `failedScopes=0`, `activeRemediationLoops=0` |

### 기관별 판정

| 기관 | 판정 | 증거 해시(대표) |
|---|---|---|
| 검사기관 inspection | ✅ passed | `fd9206ee…6f70` (audit-artifact.json) |
| 검증기관 validation | ✅ passed | `fd9206ee…6f70` |
| 실측기관 measurement | ✅ passed | `643b6b94…e329` (machine-measurement.json) |
| 성능테스트기관 performance | ✅ passed | `db096fd8…4d89` (artifact-verification-test.log) |
| 최적화기관 optimization | ✅ passed | `735678e4…de03d` (optimization-regression-guard.json) |
| 목표달성 goal | ✅ passed | `f5785ce8…f796` 외 7건 |

`failures` 배열은 6개 기관 전부 빈 배열이다 (`remainingFailures: []`).

## 2. 제출한 기계 증거 (자가보고·작업일지·자체점수 배제)

감사 대상 실제 산출물 = 팀의 실제 업무 산출물인 **2026-07-30 오후 업무보고**
(`task_5lrS6-LkLTpP97uW`, actor `agy`, `spawned_by_cli=work-report-scheduler`, status `completed`).
기준선 = 직전 감사에서 영수증 결박된 산출물 `task_FIeI336uBZOo2b42`.

- **산출물 직접 관측**: nco.db read-only 추출 → 파일화 후 SHA-256
  `391068ce…6ed7`, 1357 visible chars.
- **실측**: `visualization_workreport_visible_characters` 1201 → 1357 (target 1200, +156).
- **실행 테스트**: `visualization-workreport-fact-and-integrity-suite` 23/23 pass, **exit 0**, 135ms.
  주요 단정 — 주입된 `[실데이터]` 8개 사실이 프롬프트에 실재하고, 보고서 본문이 그 11개 수치·문자열을
  그대로 재현(35/24/9/2/68.6%, missed=1/submitted=14, hermes 6개 서브에이전트 실행 횟수)하며,
  DB `response` 와 파일이 바이트 단위 동일하고, draft 마커가 없음.
- **회귀 가드**: 15개 게이트 전부 true (팀·actor·생성경로·바이트동일·무회귀·열린루프 0).
- **독립성**: 모든 provenance producer 는 `codex-independent-*`, `machineProduced=true`,
  `kind ∈ {direct_observation, monitor, ci, independent_verifier}`. `selfReportedScore`·`workJournal` 미제출.

## 3. 남은 실패 / 잔여 갭

기관 판정 실패는 **0건**. 다만 감사 인프라 쪽에 한 건의 실측 결함을 확인했다.

### 결함: 영수증 결박 직후 중복 소비 시도가 감사 지시를 무한 재큐잉한다

관측 (T1):

1. `19:47:49.738Z` — actor `agy` 의 `task_complete` 이벤트로 영수증 정상 소비 (consumption row 존재).
2. `19:47:49.821Z` — `agent_id=ollama` 로 **같은 receiptId** 가 다시 제출되어
   `verification receipt subject mismatch` 로 반려 (`activity_log` id `4f83a33f…`).
3. `19:47:49.823Z` — 그 반려가 `recordRejectedCompletion()` →
   `queueCompletionAuditDirective()` 를 타면서 `vdir_1211575d`(subject=`task_LpxitMAJ2WDfhBcx`)가
   **다시 `queued`** 로 돌아감 (attempt_count 7).

경로: NCO `src/server/gateway.ts:2664` 가 결박 성공 후 `task:completed` 를
`agentId: task.assigned_to`(= `ollama`)로 publish → Nova-AX `src/index.ts:276` `onTaskEvent`
가 이를 `task_completed` 액티비티로 미러링하며 `receiptId` 를 그대로 실어 재소비 시도 →
영수증 actor(`agy`)와 불일치 → 반려 → 감사 지시 재큐잉.
큐된 `audit_required` 지시는 대상 작업의 완료 여부와 무관하게 재디스패치된다
(`verification-authority.ts:1445` 선택 쿼리에 subject 완료 조건 없음).

규모: `activity_log` 에서 **이미 정상 소비된 영수증**에 대한 중복 반려가 43건
(`already consumed` 32건 + `subject mismatch` 11건). 이 스코프가 같은 감사 지시를
반복 수신해 온 원인이다.

권한 판단이 필요해 **코드 변경·directive status 조작은 하지 않았다.** 제안 옵션:

- (A) NCO: `eventBus.publish('task:completed')` 에서 `receiptId` 를 빼거나
  `agentId` 를 결박 actor 로 통일.
- (B) Nova-AX `onTaskEvent`: 미러링 액티비티에 `receiptId` 를 전달하지 않음(소비는 HTTP 경로 전용).
- (C) `recordRejectedCompletion`: 해당 receipt 가 이미 소비됐거나 subject 작업이 소비된
  영수증을 가진 경우 재큐잉 생략.

## 4. 증거 경로

```
evidence/org_research/team_research-visualization/2026-07-30-task_LpxitMAJ2WDfhBcx/
├── collect-evidence.mjs                       # 수집기(재현 가능)
├── submit-and-bind.mjs                        # 제출 + NCO 결박
├── source-task-response.md                    # 실제 산출물 (391068ce…)
├── baseline-task-response.md                  # 기준선
├── source-observation.json                    # 995f22a3…
├── machine-measurement.json                   # 643b6b94…
├── performance-test-run.json                  # a12b33b4…
├── artifact-verification-test.log             # db096fd8…  exit 0
├── optimization-regression-guard.json         # 735678e4…
├── independent-integrity-attestation.json     # 601059661…
├── goal-attestation.json                      # f5785ce8…
├── audit-artifact.json                        # fd9206ee…
├── verification-submission.json / verification-decision.json
├── nco-task-before.json / nco-binding-response.json / nco-task-after.json
├── run-after.json / oversight-after.json
└── final-audit-report.json
```
