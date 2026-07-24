# 중복에러방지팀 — team 06 교차검증 리포트 (2026-07-24)

대상: `team_tech-port-06-improvement-debate` · 검증 대상 패치: `e6efcf1` + 후속 `INFRA_EXCLUSION`(`src/core/team-scorer.ts:175`)
목적: self-improvement 패치가 지표를 **겉으로만** 올리는 가짜 개선(fabricated metric)인지 독립 판정 + 반복 에러 차단 게이트 룰 정의.

## 1. 데이터 가용성 (정직 명시)

- team-06 전용 auto-audit **에러 로그 스트림은 주입/영속되지 않음**. `data/team-runner/team_quality-audit-*.md`는 **다른 팀(홍보 품질검수)** 감사이며 team-06 에러 트레이스가 아님 → 사용하지 않음.
- 모든 수치는 `db/nco.db`의 `tasks` 테이블에서 **직접 SQL 재계산**. 지어낸 값 없음. 부재 항목은 아래 `[미확인]`으로 표기.

## 2. 실패 패턴 분석 (48h, T1)

| 분류 | 건수 | task_id 근거 |
|---|---|---|
| completed | 7 | task_lue2DAqFKkmNm23z 외 6 |
| failed — **infra orphan** | 1 | `task_1SAeDCVfMO8FDlBz` (`orphaned: server restart`, response 0B) |
| failed — **infra gateway-down** | 1 | `task_eTYAEfE-U8SP4X8F` (response: `Failed to connect to localhost port 6200 … Couldn't connect to server`) |
| lease_expired — **정상 실패(유지)** | 3 | task_T42Cd0mgElSOaoXU, task_xn-WyOVjIHSEgnD0, task_WHn4No9eM_HH6WJQ |
| **raw terminal** | **12** | |

### 반복 에러(무한 재시도 루프) 가설 판정 → **NOT_CONFIRMED (task 계층)**
- team-06 tasks에서 `FORMAT_MISMATCH` 매칭 = **0건**(error‖response, 전 status). HR 지시 프롬프트 재실행 = **0건**.
- 즉 FORMAT_MISMATCH 무한루프는 **report/Stop-hook 품질게이트 계층** 현상이지 task 테이블의 재시도 폭주가 아님. task-level 서킷브레이커로는 포착 불가. **재시도 횟수 수치를 날조하지 않음.**

## 3. 패치 교차검증 (패치 전/후 실측)

| | 분모(terminal) | 분자(completed) | completion |
|---|---|---|---|
| **패치 전** (raw) | 12 | 7 | **58.3%** |
| **패치 후** (INFRA_EXCLUSION) | 10 | 7 | **70.0%** |
| Δ | −2 (검증된 infra 2건) | **±0** | **+11.7%p** |

핵심: 분모가 **검증된 infra 실패 2건만큼만** 줄었고 **분자(7)는 불변**. 가짜 완료 추가 없음. lease_expired 3건(정상 실패)은 그대로 카운트.

## 4. False Report 판정 → **GENUINE_FIX / NOT_FABRICATED**

근거(T1):
1. 제외된 2건이 각각 독립 검증된 infra 이벤트 — orphan(재시작·응답 0B) + gateway-down(연결거부, 팀 작업 미실행).
2. completed 수 전/후 동일(7) — 분자 부풀림 없음.
3. 정상 품질 실패(lease_expired 3) 보존.
4. 안전 불변식 `completed(7) ⊆ terminal(10)` 유지 → completion>100% 회귀 없음.
5. 경계·가역: 단일 SQL 절, `git revert e6efcf1` 또는 INFRA_EXCLUSION 제거로 정확히 원복.

전역 맥락(48h): orphan **122건/38팀**, circuit-open **66건/14팀**, gateway-down **13건** — 일반적·공정한 인프라 제외이며 team-06 전용 gaming 아님.

## 5. 게이트 룰 (상세: `tech-port-06-gate-update-2026-07-24.json`)

- **GATE-06-R1** (changed, **이미 반영**): infra 실패(orphan/circuit-open/gateway-down)를 completion 분모에서 제외. `team-scorer.ts:175`.
- **GATE-06-R2** (new, **제안·미구현**): gateway 타깃 dispatch 전 `/health` 프로브 → 다운이면 pre-dispatch skip. 실행 낭비 13건/48h 제거. 미구현·미검증.
- **GATE-06-R3** (observation, **범위 밖**): FORMAT_MISMATCH 루프는 grader 포맷 계약 불일치(text-only 산출물). gate owner에 위임. 합성 diff 날조 금지.

## 검증 영수증
- **[변경]** `data/error-prevention/tech-port-06-gate-update-2026-07-24.json`(신규, 룰 정의+근거 task_id), 본 리포트(신규). **소스코드 미변경**(스코어러 수정은 `e6efcf1`에서 이미 완료·검증됨).
- **[검증방법]** `sqlite3 db/nco.db` before/after 재계산(7/12→7/10) · 제외 2건 error+response 본문 직접 확인 · `FORMAT_MISMATCH` 매칭 0 확인 · `node JSON.parse`→VALID · `npx tsc --noEmit`→exit 0
- **[등급]** T1 (DB row 본문 + 소스 라인 + git hash 직접 확인)
- **[Gap]** 90% — 패치 자체는 T1 완전검증. R2/R3는 제안·관찰(미구현).
- **[미검증항목]** ① team-06 전용 auto-audit 에러로그 부재(tasks 테이블만 사용) ② 런타임 score 재계산은 다음 cron/재기동 반영(저장된 60.2는 지연) ③ R2/R3 미구현·미테스트 ④ lease_expired 3건 근본(worker offline)은 범위 밖
