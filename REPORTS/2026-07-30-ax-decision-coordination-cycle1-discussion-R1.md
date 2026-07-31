# ax-decision-coordination — HR cycle 1/3 Discussion R1 합의

**Session:** `sess_aBHXSVxM1Fg6Nq5N`  
**Team:** Decision & Coordination Office (`team_ax-decision-coordination-2026`)  
**HR snapshot:** score=6.1, completion=0%, sample=48h/6  
**Recorded:** 2026-07-30

---

## 1. 근본원인 (T1, 교차팀 합의)

| 관측 | 근거 |
|------|------|
| score=6.1 ≈ 0.9×0 + 0.1×volume(n=6) | `src/core/team-scorer.ts` volume·completion 공식; completion=0이면 volume만 기여 |
| completion=0%는 팀 품질 실패가 아님 | `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md` §T1 — 전 조직 `AUDIT_APPROVED_COMPLETION` 회귀 |
| 팀 charter는 **식별자·귀속·핸드오프**가 필수인데 team-runner가 집계만 주입 | `REPORTS/2026-07-30-Decision-and-Coordination-Office-오후.md` — 4스냅샷 연속 "원본 데이터 미제공" |
| work-report-scheduler 경로는 `gov-evolution-learning` 패턴으로 이미 보강됐으나 team-runner 경로 누락 | `scripts/team-runner.sh` L106–112 주석; spawned_by_cli='team-runner' 프롬프트만 빈약 |
| team-runner는 2026-07-28..30 일일 산출물 생성·포인터 갱신 | `data/team-runner/team_ax-decision-coordination-2026.last` → `2026-07-30` |
| 07-30 산출물은 집계 수치는 있으나 개별 task id·진행 건·work_report 연결 불가 반복 | `REPORTS/2026-07-30-Decision-and-Coordination-Office-오후.md` §진행 중 이슈, §데이터 가용성 |

**판정:** (A) HR completion=0%는 **전역 스코어러 회귀** — 본 사이클 비범위(owning session). (B) 팀 운영 병목은 **evidence context 미주입** — cycle 1 bounded fix 대상.

---

## 2. 팀별 독립 제안

### 자가학습팀 (Self-Learning)

- **제안:** Obsidian 패턴 노트 `team-ax-decision-coordination-evidence-gap` 등록. `gov-evolution-learning`·`web-scrape-06-verification-quality`와 동일한 "집계-only 주입 → charter BLOCKED" 패턴을 팀 slug 단위가 아닌 **주입 경로(team-runner vs scheduler) 단위**로 기록.
- **근거:** 4스냅샷 동일 미제공은 에이전트 실패가 아니라 **프롬프트 shape 결함**의 재현 신호.
- **성공 기준:** 개선 노트 1건; Mem0 검색 hit ≥1 (cycle 2에서 consolidate).

### 자가개선팀 (Self-Improvement)

- **제안:** `ax-decision-coordination` 전용 T1 evidence 블록을 `src/core/work-report-scheduler.ts`·`scripts/team-runner.sh`에 미러링. env `NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT` (default on; `off`로 즉시 롤백).
- **주입 블록:** `[coordination_task_evidence]` (48h·8건), `[coordination_work_report_evidence]` (7d·5건), `[coordination_member_task_evidence]` (멤버 48h·10건).
- **롤백:** `export NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT=off` — 재빌드 불필요.
- **성공 기준:** `npx vitest run src/core/work-report-scheduler.test.ts -t "coordination"` 통과; 다음 team-runner 프롬프트에 `id=` 라인 존재.

### 중복에러방지팀 (Error Prevention)

- **제안:** False Report 차단 — completion=0%를 "조정 오피스 무능"으로 보고 금지. `SCORER_GATE_MISMATCH` 분류(approved=0 + completion=0)와 팀별 evidence gap을 분리 KPI로 유지.
- **반대 의견 수용:** evidence 주입 후에도 에이전트가 여전히 "미확인"을 쓸 수 있음 → **허용**(정직한 fallback); "확인됨" 주장만 차단.
- **성공 기준:** auto-audit에 `EVIDENCE_CONTEXT_INJECTED` vs `CHARTER_BLOCKED_NO_IDS` 구분; 후자는 다음 러너 1회 후 0이어야 함.

---

## 3. 상호 평가

| 제안 | 자가학습 | 자가개선 | 중복에러방지 |
|------|---------|---------|-------------|
| evidence context 미러링 (cycle 1) | 찬성 — 패턴 재발 방지 | **주도** — gov-evolution-learning 동형 | 찬성 — False Report 제거 |
| team-scorer pending fix | 찬성(병행) — completion 상승 | 사이클 1 비범위(owning session) | 찬성 — HR 지표 오해 제거 |
| gateway reviewing 경로 | 보류 — 사이클 2+ | 찬성(사이클 2) | 찬성 — AP 갭 근본 |
| 팀 삭제/비활성 | **전원 반대** — HR 소유 |

---

## 4. 위험과 반대 의견

1. **프롬프트 비대:** task·work_report·member 3블록 추가로 토큰 증가.  
   **완화:** 48h/8·7d/5·48h/10 상한; `compactContextText` truncation 기존과 동일.
2. **PII/프롬프트 유출:** task `prompt` 필드 주입.  
   **완화:** 240자 상한; 조정 오피스 charter상 내부 운영 데이터만 대상.
3. **경로 불일치:** scheduler만 패치 시 team-runner 회귀.  
   **완화:** 양 경로 동일 쿼리·라벨; 단일 env 킬스위치.
4. **completion=0% 조기 해석:** evidence fix만으로 HR score는 즉시 오르지 않음.  
   **완화:** cycle 1 성공 기준은 **프롬프트 evidence 존재**이지 completion % 아님.

---

## 5. 합의 실행 설계 (cycle 1/3)

| 단계 | 담당 | 산출물 | 검증 |
|------|------|--------|------|
| 1 | 자가개선 | `work-report-scheduler.ts` + `team-runner.sh` evidence 블록 | vitest `-t coordination` |
| 2 | 중복에러방지 | False Report 분류·본 REPORT | T1 파일 존재 |
| 3 | 자가학습 | 패턴 노트( cycle 2 Mem0 ) | Obsidian 경로 |
| 4 | (사이클 2) | team-scorer mitigation deploy + 1회 team-runner 관측 | 프롬프트 `id=` + 보고서 개별 건 인용 |

**명시적 비범위:** `team-scorer.ts` 편집 없음, 팀 lifecycle 변경 없음, PM2 재시작은 lease 소유 세션.

---

## 6. 적용 diff 요약

- `src/core/work-report-scheduler.ts` — `DECISION_COORDINATION_TEAM_SLUG`, `NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT`, 3× `[coordination_*_evidence]` collect 블록 (L153–154, L455–574).
- `scripts/team-runner.sh` — 동일 쿼리·라벨 Python 블록 (L116–132, L350–422).
- `src/core/work-report-scheduler.test.ts` — coordination inject + reversible flag 테스트 (L283–347).

---

## 7. 검증 영수증

- **[변경]** 위 3파일 + 본 REPORT
- **[검증방법]** 테스트: `npx vitest run src/core/work-report-scheduler.test.ts -t "coordination"`; 타입: `npx tsc --noEmit`; 정적: grep `[coordination_task_evidence]` 양 경로
- **[등급]** T1 (소스·테스트 fixture 직접 확인); 라이브 team-runner 프롬프트 재확인은 다음 스케줄 런 후
- **[Gap]** 라이브 `curl :6200/api/teams/scores`·PM2 dist 반영 미실행 가능; cycle 1 코드·테스트 완료 ≠ deploy 100%
- **[미검증항목]** 다음 team-runner 실행 후 산출물에 task `id=` 인용 여부; HR completion % post-scorer-mitigation

---

*HR cycle 1 합의: 팀 무결, evidence context bounded fix, completion 회복은 전역 스코어러 owning session에 위임.*
