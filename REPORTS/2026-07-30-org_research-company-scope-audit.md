# Nova-AX 정기 감사 보고 — `org_research` / 회사 자체(company-scope)

- **감사 대상 작업:** `task_Op7-5QgFJScqMWmr` (NCO, 회사 자체 범위)
- **검증 runId:** `vrun_3d6aae88-3ed7-46f3-8fb0-5ee3e98a22c3`
- **판정:** **approved — 6/6**
- **receiptId:** `vrcpt_c4c768b9-a3b4-43b6-b42e-7f05b43c4347`
- **evidenceDigest:** `8f4d06f4ac38a268230a4d0c4e669e8efc7271d30c1cd6db4912f028b6aca448`
- **완료 이벤트 결박:** `dd750eb2-2120-4b34-9280-defe3a97a9fa` (consumption `vuse_86bc5501-a926-4ce3-a523-414384229724`)
- **관측 시각:** 2026-07-30T17:26:55.855Z
- **증거 번들:** `/Users/nova-ai/project/nova-ax/evidence/org_research-company-scope-20260730/`

---

## 1. 기관별 판정

| 기관 | 판정 | 실패 |
|---|---|---|
| inspection (검사기관) | approved | 없음 |
| validation (검증기관) | approved | 없음 |
| measurement (실측기관) | approved | 없음 |
| performance (성능테스트기관) | approved | 없음 |
| optimization (최적화기관) | approved | 없음 |
| goal (목표달성 체크기관) | approved | 없음 |

## 2. 제출한 기계 증거 (자가보고·작업일지·LLM 주장 전면 배제)

측정 창은 절대 시각으로 고정되어(`windows`) 재현 시 동일 모집단을 본다.

| KPI | 기준선 | 현재 | 목표 | 방향 |
|---|---:|---:|---:|---|
| `company_work_report_submission_rate_4d_pct` | 67.86 | **96.15** | 80 | 높을수록 좋음 |
| `company_missed_work_report_count_4d` | 18 | **2** | 5 | 낮을수록 좋음 |
| `company_work_product_task_failure_count_72h` | 0 | **0** | 0 | 낮을수록 좋음 |
| `company_completed_work_product_task_volume_72h` | 46 | **48** | 1 | 높을수록 좋음 |

목표 80%는 임의값이 아니라 NCO 자체 등급 기준(`src/core/team-scorer.ts` `gradeTeamScore` B 하한 80)이다.

실행된 검사 3종 (exit code·소요시간·출력 해시를 실행 시점에 관측):

| 테스트 | exit | 소요 | 내용 |
|---|---:|---:|---|
| `company-claim-verifier` | 0 | 486ms | 산출물의 정량 주장 78건을 NCO DB에서 **다른 질의 형태로** 재도출해 전수 대조 |
| `metric-negative-control` | 0 | 7,460ms | 위조 산출물 7종(제출률 부풀림·누락 은폐·기준선 조작·볼륨 과장·해시 위조·존재하지 않는 산출물·허구 근거행)을 검증기가 전부 탐지 |
| `nova-ax-verification-suite` | 0 | 9,867ms | `npm run test:verification` — 감사 기구 자체의 단위·HTTP 회귀 |

## 3. 회사 산출물 인벤토리 (해시는 저장된 본문에서 직접 산출)

| work_report | 일자/슬롯 | bytes | sha256(앞 16) |
|---|---|---:|---|
| `wr_3GzumgBXptlNLnpR` | 07-28 am | 1468 | `0f01a3eb8db21e44` |
| `wr_C9ElAijhU07JswBJ` | 07-28 pm | 1450 | `f73a00b930d2f5a9` |
| `wr_gl5n2RJutcbessLp` | 07-29 am | 1837 | `a152267d5e2df493` |
| `wr_NaTk8QlzfbzuVBA8` | 07-29 pm | 1060 | `a8334bdcef19552a` |
| `wr_SbswOsPKaUR8aDuO` | 07-30 am | 1142 | `7e67b5f25d081aa6` |
| `wr_MnHzmwN-EPf8szcT` | 07-30 pm | 1601 | `02b644eccee96f4b` |

전체 해시는 `company-scope-evidence.json`의 `deliverables` 참조.

## 4. 남은 실패 — 완료로 보고하지 않는 항목

1. **`team_research-visualization` 스코프 비준수** — 최신 run 3건 전부 rejected(0/3), 반시드 루프 `vloop_91a99931-aaff-49dd-a1e2-1174567f65fc` = `action_required` (iteration 1/5). 회사 자체 범위가 아니라 **팀 범위** 지시(`vdir_1211575d` dispatched / `vdir_713077ee` queued, NCO `task_xPv_BuvzSGWs7VPB` queued)에서 처리된다. 근본원인은 기존 조사에서 팀 결함이 아니라 미커밋 `AUDIT_APPROVED_COMPLETION` 게이트로 규명돼 있다.
2. **회사 자체 슬롯 제출률 75%(6/8)** — 직전 창 0%(0/8)에서 개선됐으나 B 하한 80% 미달. 미제출 슬롯: 2026-07-27 am/pm.
3. **감사 파이프라인 종결 실패 4건** (현재 창 19건 판정 중) — `task_POlruSB6qm5m4aLq`(queue_wait_timeout), `task_SeBHERcyKrYmROv3`(orphaned: server restart), `task_7_qe-7TrGAIBEV7b`·`task_gwosa4g4Vp2Tk0Rp`(visualization 감사 미충족 자진 보고). 직전 창에는 감사 파이프라인 태스크 자체가 0건이라 비교 기준선이 없다. 회사 연구 산출물 태스크 실패는 양 창 모두 **0건**이다.

세 항목 모두 증거 번들 `company-scope-evidence.json`의 `disclosures` / `crossScopeStatus`에 기계 판독 가능한 형태로 기록돼 있다.

## 5. 증거 경로

```
/Users/nova-ai/project/nova-ax/evidence/org_research-company-scope-20260730/
├── collect-company-evidence.mjs      # 수집기 (producer ≠ actor)
├── claim-verifier.mjs                # 독립 재도출 검증기
├── negative-control.mjs              # 검증기 위조 탐지 능력 증명
├── company-scope-evidence.json       # 제출 산출물 (inspection 대상)
├── evidence-index.json               # 해시 인덱스
├── regression-guard.json             # 무회귀 가드
├── submission-payload.json           # 6기관 제출 페이로드
├── submission-decision.json          # 6/6 판정 원문
├── completion-event.json             # 영수증 결박 (200)
├── replay-probe.json                 # 재사용 거부 (409)
├── oversight-final.json              # 감사 후 스코프 스냅샷
└── *.stdout / *.exit / *.duration    # 실행 원시 출력
```
