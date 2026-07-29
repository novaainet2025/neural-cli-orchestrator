---
team_id: team_cli-design
team_slug: cli-design
role: 중복에러방지팀 (duplicate-error-prevention) — cross-verification
improvement_cycle: 2
target_score: 82.2
target_completion: 85.7
sample: 48h/7
snapshot_utc: "2026-07-24 05:16:31"
verdict: SELF-IMPROVE PATCH = FALSE REPORT (no-op) · surface & hold
---

# cli-design 개선 사이클 2 — 교차검증 리포트 (중복에러방지팀)

## 0. 결론 (요약)
- **자가개선팀 산출 패치 = False Report (no-op)** — 대상 팀(cli-design)에 대한 기능 변경 0건.
- cli-design 48h 표본의 실패 2건은 **둘 다 `spawned_by_cli='commander-perfgoal'` 제어면(perf-goal) 태스크**
  → 팀 charter 산출물이 아님 → 스코어러가 **이미** `CONTROL_PLANE_PERFGOAL_EXCLUSION`으로 제외(commit 1dfa39e/275b360/c31625f).
  실제 팀 작업(team-runner 2 + work-report-scheduler 3)은 **전부 completed → 제외 후 완료율 100%**.
- 즉 **근본원인·수정은 이전 사이클에 이미 완료·검증됨**(tsc 0, 18/18). FORMAT_MISMATCH는 대상 표본 밖. **본 사이클 무코드변경 surface & hold.**
- CB/Gate 룰은 **스코어러 변경 아님** — self-improve no-op 패치 재승인 봉쇄용 2건만 **제안**(번호 미부여, 날조 금지).

---

## 1. 자가개선팀 패치 False-Report 교차검증 (T1)

주장된 패치는 아래 3가지 diff만 포함 → **cli-design 기능 수정 0건**:

| 패치 대상 | 실측(T1) | 판정 |
|---|---|---|
| `db/hnsw-indices/*.hnsw` (codex/retired-provider/ollama) | `git diff --stat db/hnsw-indices/` → **7 files changed, 0 insertions(+), 0 deletions(-)** (바이너리 인덱스, baseline 스냅샷에 이미 존재하는 노이즈) | no-op 노이즈 |
| `docs/self-improve/tech-port-08-migration-rootcause-2026-07-24.md` | `git status --short docs/self-improve/` → **출력 없음**(워킹트리 무변경). `revalidated_utc`/`qualityRetryExample`는 이미 커밋된 내용 = 재기술 | no-op / **대상 팀 아님**(tech-port-08 문서) |
| 근거로 인용한 `task_ZZg5UdtnMmIzauL5` | DB: `team_id=team_self-learning`, `status=running`, `created_at=2026-07-24 03:12:33` | **cli-design 표본 아님** + 스냅샷 이후 생성된 현재 재주입 프롬프트 아티팩트 |

→ 패치가 "고쳤다"는 FORMAT_MISMATCH는 **대상 팀·대상 표본에 존재하지 않는 문제**.
게이트 로직(`src/verification/response-quality.ts`, `src/core/team-scorer.ts`) **미변경**. 전형적 phantom patch.

증거 명령:
```
git diff --stat -- db/hnsw-indices/        # 0 insertions/0 deletions
git status --short -- docs/self-improve/    # (empty)
sqlite3 db/nco.db "SELECT team_id,status,created_at FROM tasks WHERE id='task_ZZg5UdtnMmIzauL5'"
  # team_self-learning | running | 2026-07-24 03:12:33
```

---

## 2. cli-design 실제 48h 표본 (T1, sample=7)

`sqlite3 db/nco.db` — `team_id LIKE '%cli-design%' AND created_at > now-48h`:

| status | count |
|---|---|
| completed | 5 |
| failed | 2 |

**표본 7건의 spawner별 분해 (T1 — `spawned_by_cli`):**

| spawned_by_cli | status | count | 팀 charter 작업? |
|---|---|---|---|
| `commander-perfgoal` | failed | 2 | ❌ 제어면(perf-goal) — 스코어러 제외 대상 |
| `team-runner` | completed | 2 | ✅ 실제 팀 작업 |
| `work-report-scheduler` | completed | 3 | ✅ 실제 팀 작업 |

**실패 2건 = 둘 다 commander-perfgoal:**

| task | agent | error (T1) | spawned_by_cli |
|---|---|---|---|
| `task_UbgK8HFH0-cvvwt` | agy | `orphaned: server restart (poison — requeued 2x)` | **commander-perfgoal** |
| `task_dWW-eyL6sIl07j7` | ollama | `unknown: failure pattern in output` (resp_len=107) | **commander-perfgoal** |

→ 실패 2건은 팀 charter 산출물이 아니라 **NCO 제어면(perf-goal) 태스크**. error 문자열(orphan / failure-pattern)은 제어면 태스크가 실패한 *이유*일 뿐, 제외 판정은 error 종류와 무관하게 `spawned_by_cli`로 결정된다.

**FORMAT_MISMATCH 태그 행은 표본 밖:** `task_KqTC-pUQRGLL0ix`(2026-07-13), `task_wncrR9LzcCMxB3U`(2026-07-15)
— 둘 다 completed, 48h 창(07-22~24) **바깥**. 즉 현재 사이클 감점과 무관.

→ **근본원인(T1):** cli-design 원시 완료율 저하(6/7=85.7% 또는 raw 5/7)는 제어면 태스크 2건이 분모에 섞여서 발생.
**스코어러는 이미 이를 제외**(`team-scorer.ts:194` `CONTROL_PLANE_PERFGOAL_EXCLUSION`, 6곳 적용 273-298) → 실제 팀 작업 5/5 = **완료율 100%**. **근본원인·수정 이미 완료·검증됨.**

---

## 3. 제안 룰 변경 목록 (적용 전/후 — 번호 미부여, 소유자 확정 대상)

> CB 룰 번호·감사 수치는 **날조 금지**. 아래는 조건 명세만. 실제 등록은 게이트 소유자 승인 필요.
> **주의:** 스코어러 완료율 계상은 이미 `CONTROL_PLANE_PERFGOAL_EXCLUSION`으로 해결됨 → **신규 스코어러 룰 불필요.**
> 아래 제안은 **self-improve no-op/False-Report 패치의 재승인 봉쇄** 목적에 한정한다.

**R-proposal-B · phantom-patch False-Report 차단(CB/Gate)**
- 전: 개선 패치 diff가 바이너리 인덱스(`db/hnsw-indices/*.hnsw`) 및/또는 대상 팀과 무관한 문서만 건드려도 통과.
- 후: 패치 diff의 **코드 insertion/deletion 합이 0**이거나 대상 파일이 전부 `*.hnsw`/타팀 문서면 **자동 no-op 플래그 → 반려**.
- 목적: 이번 self-improve no-op 패치류의 반복 승인 봉쇄.

**R-proposal-C · 근거 태스크 소속·시점 검증(Gate)**
- 전: 패치가 임의 task_id를 근본원인 근거로 인용해도 검증 없음.
- 후: 인용 태스크는 **`team_id == 대상 팀` AND `created_at <= snapshot_utc`** 를 만족해야 근거로 인정.
  위반 시 근본원인 미검증으로 반려. → `task_ZZg5UdtnMmIzauL5`(team_self-learning, 스냅샷 이후)는 자동 탈락.

---

## 4. 검증 영수증
- [변경] 코드 변경 없음(surface & hold). 산출물: 본 교차검증 리포트 1건.
- [검증방법]
  `git diff --stat db/hnsw-indices/` → 0 insertions/0 deletions ·
  `git status --short docs/self-improve/` → empty ·
  `sqlite3 db/nco.db` cli-design 48h 표본 spawner 분해 = commander-perfgoal/failed×2, team-runner/completed×2, work-report-scheduler/completed×3 ·
  실패 2건 `spawned_by_cli='commander-perfgoal'` 직접 확인 ·
  `grep CONTROL_PLANE_PERFGOAL_EXCLUSION src/core/team-scorer.ts` → line 194 선언 + 273/280/286/293/298 적용 present ·
  FORMAT_MISMATCH 행 2건 created_at=07-13/07-15(표본 밖) ·
  `npx tsc --noEmit` → exit 0 · `npx vitest run team-scorer.test.ts response-quality.test.ts` → **18/18 pass**
- [등급] **T1** (DB row 본문·spawned_by_cli 필드·git diff stat·grep 소스·빌드/테스트 출력 직접 확인)
- [Gap] 95% — 근본원인(제어면 태스크 오계상)과 기존 수정(CONTROL_PLANE_PERFGOAL_EXCLUSION) 모두 T1 재확인. self-improve 패치 False-Report 확정. 룰 B/C는 **제안** 상태(미등록).
- [미검증항목] R-proposal-B/C 실제 게이트 등록·적용(소유자 승인 전 미실행); 스코어러 제외 후 HR 스냅샷 재계상 반영 시점.

---

## 5. HR/커맨더 처리 지침
- **팀 삭제·비활성 금지** — HR 전용 lifecycle. 본 리포트는 근거 제공만.
- 자가개선팀 no-op 패치는 **머지·커밋하지 말 것**(False Report).
- 룰 A/B/C는 게이트 소유자에게 **제안**으로 전달 후 승인 시 등록.
