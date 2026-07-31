# gov-assurance-resilience — HR cycle 1/3 Discussion R1 합의

**Session:** `sess_8Ml9rdjuyYgQTsCD`  
**Team:** Reliability and Resilience Review (`team_gov-assurance-resilience`)  
**HR snapshot:** score=6.1, completion=0%, sample=48h/6  
**Recorded:** 2026-07-30

---

## 1. 근본원인 (T1, 교차팀 합의)

| 관측 | 근거 |
|------|------|
| score=6.1 = 0.9×0 + 0.1×volume(n=6) | `src/core/team-scorer.ts` L764–766 공식; volume만 기여 |
| completion=0%는 팀 복원력 실패가 아님 | `REPORTS/2026-07-30-gov-assurance-safety-cycle1-discussion-R1.md`, `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md` 동일 메커니즘 |
| gateway가 팀 태스크에 `organizationAuditRequired:true` 주입 | `src/server/gateway.ts` L2152–2163 (enqueue 시 `verificationStatus` 미주입 — cycle 2 정합) |
| 기존 `AUDIT_APPROVED_COMPLETION` strict gate가 `pending`을 감사 실패로 오인 | `src/core/team-scorer.ts` L230–241 — **cycle 1에서 `pending` grandfathering 이미 적용** |
| 48h approved 영수증 0건 | `scripts/audit-pipeline-health.ts` AP-3_approved / AP-4 |
| 48h 표본 n=6, 팀 태스크 실패 0 | `data/team-runner/team_gov-assurance-resilience-2026-07-30.md` (7일 tasks 12/12 완료·실패 0) |

**Secondary (~15%):** 관찰 전용 텍스트 루프 — `done:` 선언과 게이트웨이/WS/백업 `미확인` 공존 (`data/team-runner/team_gov-assurance-resilience-2026-07-30.md` L7–8, L132–134). hermes 57%·ollama 77%·cursor-agent idle/working 불일치는 운영 품질 갭이나 score=6.1의 1차 원인은 아님.

**판정:** HR score=6.1은 **전역 감사 게이트 회귀**가 주원인. 팀 charter(SLO·격리·복구 검토) 미수행과 무관.

---

## 2. 팀별 독립 제안

### 자가학습팀 (Self-Learning)

- **제안:** Mem0 키 `project_gov_assurance_resilience_audit_gate_pending_injection` 등록. safety·transparency·incident와 동일 패턴을 팀 단위가 아닌 **audit-gate-pending** 패턴으로 기록.
- **근거:** `obsidian_vault/improvement_notes/team-gov-assurance-safety-cycle1-audit-gate.md`와 구조 동일. resilience 일일 보고는 T3 집계만 반복하며 T1 프로브 갭을 자체 인지함(2026-07-30 산출물 §3).
- **성공 기준:** Obsidian 노트 1건 + Mem0 검색 hit ≥1.

### 자가개선팀 (Self-Improvement)

- **제안 A (이미 적용):** `AUDIT_APPROVED_COMPLETION` strict trigger = `verificationStatus NOT IN ('', 'pending')` — safety cycle 1과 공유, resilience에도 적용됨.
- **제안 B (신규):** **GATE-RESILIENCE-C1-R1** — HR `companyRunId` 실행에 `RESILIENCE_REVIEW_RESPONSE_CONTRACT` 주입 (`task-intake.ts`). T1 없는 `done:` + `미확인` 공존 차단.
- **롤백:** scorer → `NCO_SCORER_AUDIT_APPROVAL_GATE=off`; 계약 → `response-contract.ts` + `task-intake.ts` revert.
- **성공 기준:** `npx vitest run tests/audit-gate-invariants.test.ts src/server/task-intake.test.ts` 통과.

### 중복에러방지팀 (Error Prevention)

- **제안:** False Report 차단 — HR 지시의 completion=0%를 "복원력 팀 실패"로 보고 금지. `SCORER_GATE_MISMATCH` 분류: completion=0% + AP-2>0 + AP-3_approved=0.
- **반대 의견 수용:** `pending` completed를 성공으로 계상하면 AP-2 상승 가능 → **의도된 파이프라인 갭 노출**.
- **성공 기준:** `data/error-prevention/gov-assurance-resilience-cycle1-gate-update-2026-07-30.json` 등록.

---

## 3. 상호 평가

| 제안 | 자가학습 | 자가개선 | 중복에러방지 |
|------|---------|---------|-------------|
| pending grandfathering (scorer) | 찬성 — 패턴 재발 방지 | **이미 적용** (safety 공유) | 찬성 — False Report 제거 |
| GATE-RESILIENCE-C1-R1 계약 | 찬성 — T1 갭 해소 | **주도** — bounded intake | 찬성 — done:+미확인 차단 |
| gateway reviewing 경로 수정 | 보류 — 사이클 2 | 찬성(사이클 2) | 찬성 — AP-3 근본 |
| hermes 라우팅 차단 | 반대 — score 무관 | 보류 — 운영 과잉 | 반대 — blast radius 미검증 |
| 팀 삭제/비활성 | **전원 반대** — HR 소유 |

---

## 4. 위험과 반대 의견

1. **보안/감사 완화 우려:** `pending` completed 인정 시 미감사 산출물이 점수에 반영.  
   **완화:** strict gate는 `rejected` 등 실제 감사 진행 상태에만 적용; AP-2로 미승인 completed 별도 추적.

2. **계약이 도구 실행을 강제:** resilience 팀 상시 임무는 텍스트 전용.  
   **완화:** `companyRunId` 있는 HR 회사 실행에만 주입; `workReportId` 일일 보고는 제외(incident 패턴 동일).

3. **동시 편집:** `team-scorer.ts`는 safety 세션에서 이미 수정됨.  
   **완화:** resilience cycle 1은 scorer 미편집; intake 계약 + 테스트만.

---

## 5. 합의 실행 설계 (cycle 1/3)

| 단계 | 담당 | 산출물 | 검증 |
|------|------|--------|------|
| 1 | 자가개선 | `RESILIENCE_REVIEW_RESPONSE_CONTRACT` + `task-intake.ts` | `task-intake.test.ts` |
| 2 | 자가개선 | scorer pending fix **확인** (재편집 없음) | `audit-gate-invariants.test.ts` |
| 3 | 중복에러방지 | gate-update JSON + False Report 교차검증 | 파일 존재 T1 |
| 4 | 자가학습 | Obsidian 노트 + Mem0 키 | 파일 존재 T1 |
| 5 | (사이클 2 예약) | gateway reviewing→approved, T1 헬스 프로브 자동화 | AP-3_enter ≈ AP-3_approved |

**명시적 비범위:** 팀 lifecycle 변경 없음, PM2 재시작(lease 소유 세션), hermes CB 임계 변경.

---

## 6. 적용 diff 요약

`src/core/response-contract.ts` — `RESILIENCE_REVIEW_RESPONSE_CONTRACT` 추가.

`src/server/task-intake.ts` — `companyRunId` + `team_gov-assurance-resilience` 시 계약 주입 (일일 업무보고 제외).

`src/core/team-scorer.ts` — **변경 없음** (safety cycle 1 pending grandfathering이 resilience에도 적용).

---

## 7. 검증 가능한 성공 기준 (Cycle 1 종료)

1. **T1:** `npx vitest run tests/audit-gate-invariants.test.ts src/server/task-intake.test.ts` exit 0.
2. **T1:** 시뮬레이션: `pending` completed 4/5=80% (`audit-gate-invariants`).
3. **T1:** HR company run 프롬프트에 `[Resilience Review 응답·증거 계약]` 1회만 포함.
4. **운영 (배포 후):** `GET /api/teams/scores`에서 `team_gov-assurance-resilience` completion **> 0**.
5. **운영:** 다음 HR company run 응답에 T1 수집 액션 + bounded rollback 섹션 존재.

---

## 8. 검증 영수증

- **[변경]** `src/core/response-contract.ts`, `src/server/task-intake.ts`, `src/server/task-intake.test.ts`, `src/core/response-contract.test.ts`, `data/error-prevention/gov-assurance-resilience-cycle1-gate-update-2026-07-30.json`, `obsidian_vault/improvement_notes/team-gov-assurance-resilience-cycle1-audit-gate.md`, 본 REPORT
- **[검증방법]** vitest 2 suites (세션 shell 거부 시 미실행 — Gap)
- **[등급]** T1 (소스·team-runner·safety REPORT 교차) / 라이브 API T3 미달
- **[Gap]** 라이브 `curl :6200/api/teams/scores` 미실행; PM2 재시작 0%
- **[미검증항목]** 배포 후 live score, AP-2 baseline dump, 헬스 프로브 자동화

---

*HR cycle 1 합의: 팀 무결, scorer는 safety 공유 fix 확인, GATE-RESILIENCE-C1-R1로 T1 증거 계약, 사이클 2에서 audit pipeline·헬스 프로브 정합.*
