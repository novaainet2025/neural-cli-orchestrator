# Incident and Continuity Command — HR Improvement Cycle 1/3, Discussion R1

**Session:** `sess_luGEYO7JsjeICN_D`  
**Team:** `team_gov-command-incident` / `gov-command-incident`  
**Directive:** score=6.1, completion=0%, sample=48h/6  
**Recorded:** 2026-07-30

---

## 1. 근본원인 (T1·교차검증)

| 계층 | 판정 | 근거 |
|------|------|------|
| **Primary (~85%)** | 전역 `AUDIT_APPROVED_COMPLETION` 게이트 + `organizationAuditRequired` 주입 + 48h `verificationStatus=approved` 0건 | `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md`, `REPORTS/2026-07-30-시각화-미디어팀-오후.md`, `src/server/gateway.ts:2152-2159`, `src/core/team-scorer.ts:216-237` |
| **Secondary (~15%)** | 관찰 전용 텍스트 루프(`done:` + `미확인` 공존), claude-code 저성공률 | `data/team-runner/team_gov-command-incident-2026-07-28.md`, `2026-07-30.md` |

**수식 검증:** completion=0 → score ≈ 0.1×volume. n=6이면 volume≈61 → score≈6.1. 지시문 수치와 정합.

**7일 vs 48h:** team-runner는 7일 완료율 62–73%를 보고. 48h completion=0%는 팀 실행 불능이 아니라 **감사 영수증 미인정** 또는 **marked pending** 집계 효과.

---

## 2. 팀별 독립 제안

### 자가학습팀
- Mem0/패턴: collaboration cycle3과 동일 계열이나 mesh echo가 아닌 **audit pipeline gap**.
- Obsidian 노트: `RC-INCIDENT-C1-AUDIT-GATE` 태그로 전역 아티팩트와 팀 운영 갭 분리 저장.
- **위험:** 학습 노트만 작성하면 HR cycle 2가 동일 0%로 재발.

### 자가개선팀
- `team-scorer.ts` **편집 금지** (transparency 세션 lease 경계).
- **GATE-INCIDENT-C1-R1** 구현: HR `companyRunId` 실행에 `INCIDENT_COMMAND_RESPONSE_CONTRACT` 주입.
- 검증: `npx vitest run src/server/task-intake.test.ts tests/audit-gate-invariants.test.ts`, `npx tsx scripts/audit-pipeline-health.ts`.

### 중복에러방지팀
- **False Report 차단:** "completion=0% = incident 팀 실패" 주장은 허위.
- **GENUINE:** audit gate 전역 붕괴; PROVIDER_AUTH/INFRA 제외와 무관한 신규 실패 클래스.
- CB/protocol-echo는 기존 GATE-COLLAB-C3-R1으로 충분 — incident 전용 임계 변경 **반대** (blast radius 미검증).

---

## 3. 상호 평가·반대 의견

| 제안 | 지지 | 반대·위험 |
|------|------|-----------|
| scorer 즉시 패치 (incident 세션) | 점수 즉시 회복 가능 | **반대:** lease 충돌, 85팀 동시 영향, transparency 합의 위반 |
| `NCO_SCORER_AUDIT_APPROVAL_GATE=off` | 긴급 롤백 | **반대:** marked 태스크 감사 무력화 — 24h 만료+감사 기록 필요 |
| GATE-INCIDENT-C1-R1 계약 | HR 실행 품질 상향, reversible | **반대 (자가학습):** scorer 0% 자체는 해결 안 함 — **수용:** 2-track 전략 |
| claude-code 라우팅 차단 | S3 조건 충족 시 타당 | **반대:** score 회복과 무관; 운영 과잉 격리 위험 |

---

## 4. 합의 실행 설계 (Cycle 1)

| # | 조치 | 소유 | 되돌리기 |
|---|------|------|----------|
| 1 | GATE-INCIDENT-C1-R1 배포 (`response-contract.ts`, `task-intake.ts`) | 자가개선 | git revert |
| 2 | `audit-gate-invariants` + task-intake 테스트 통과 | 자가개선 | — |
| 3 | AP-1..AP-6 KPI 스냅샷 (`audit-pipeline-health.ts`) | 중복에러방지 | read-only |
| 4 | scorer mitigation **배포·검증** | 플랫폼 소유 세션 | `NCO_SCORER_AUDIT_APPROVAL_GATE=off` |
| 5 | 팀 삭제/비활성화 | **금지** (HR 전용) | — |

### 검증 가능한 성공 기준 (Cycle 1 종료)

1. **T1:** `vitest` 위 2 suites exit 0.
2. **T1:** 배포 후 `GET /api/teams/scores`에서 `team_gov-command-incident` completion **> 0** (scorer mitigation 반영 시) **또는** AP-3_approved ≥ 1 (파이프라인 가동 시).
3. **T1:** completion ≤ 100, legacy unmarked completed 행 계속 계상 (`audit-gate-invariants`).
4. **운영:** 다음 HR company run 응답에 T1 수집 액션 + bounded rollback 섹션 존재 (계약 준수).

---

## 5. 검증 영수증

- **[변경]** `src/core/response-contract.ts` — `INCIDENT_COMMAND_RESPONSE_CONTRACT` 추가  
- **[변경]** `src/server/task-intake.ts` — `companyRunId` + `team_gov-command-incident` 계약 주입  
- **[변경]** `src/server/task-intake.test.ts` — 회사 실행 전용·업무보고 제외 테스트  
- **[산출]** `data/error-prevention/gov-command-incident-cycle1-gate-update-2026-07-30.json`  
- **[검증방법]** `npx vitest run src/server/task-intake.test.ts tests/audit-gate-invariants.test.ts` (세션 shell/MCP 거부 시 **미실행 — Gap**)  
- **[등급]** T1 (코드·기존 REPORT 교차) / 테스트 실행 T3 미달  
- **[Gap]** 라이브 API·DB 재조회·vitest 실행 이 세션에서 차단됨  
- **[미검증항목]** 배포 후 live score, AP KPI dump, PM2 재시작

---

*Cycle 2 예고: audit pipeline reviewing→approved 경로 수리, cutover timestamp, incident 팀 48h task 원장 공개 diff.*
