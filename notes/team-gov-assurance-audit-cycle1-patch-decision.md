# team_gov-assurance-audit Cycle 1/3 — 자가개선(패치) 단계 결론: **소스 변경 0 (diff 0)**

작성: 2026-07-27 / 대상: `team_gov-assurance-audit` (Evidence Audit and Compliance, org_nco-assurance, is_active=1)
HR 지시 스냅샷: score=75.7, completion=80%, sample=48h/5, cycle=1/3

---

## 1. 결론 요약

`src/` 소스 패치는 **불필요**하다. HR 스냅샷의 75.7점/80%를 만든 유일한 실패 1건은
**동일 work report의 팬아웃 형제**였고, 그 형제가 나중에 정상 완료되면서 기존 스코어러의
`WORK_REPORT_DUP_DELIVERED_EXCLUSION`(HEAD에 이미 커밋됨)이 자동 적용되었다.
HEAD 코드로 재계산한 현재 값은 **score=93.7 / grade=A / completion=100% / n=5 / sample=48h**이다.

즉 75.7은 **stale 스냅샷**이며, 집계 로직의 오계상도 산출물 품질 실패도 아니다.
여기서 스코어러를 추가로 손대면 이미 올바르게 동작하는 경로에 과잉 제외를 넣는 회귀가 된다.

---

## 2. 실데이터 — 48h 태스크 전수 (T1: `sqlite3 db/nco.db` 직접 조회)

| Task ID | status | error | wrid | resp len | 스코어러 처리 |
|---|---|---|---|---|---|
| task_8PG4oI2CpGo9k6Hg | completed | — | wr_t-jb3ViePtQE19y_ | 914 | terminal+completed |
| task_lEMQcnwBLz-ak5FH | completed | — | (없음) | 1186 | terminal+completed |
| task_sRYn25ipGFgIZOmc | completed | — | (없음) | 9498 | terminal+completed |
| task_UatrcUS6U9HM64RL | completed | — | wr_Xp0BVMKs4UwnjcjY | 252 | terminal+completed |
| task_7U-jEljr8bgs-1jI | failed | `opencode: CLI failed exit=1 — Error: Unexpected error` / 응답 본문 `database is locked` | **wr_-Ofp3mjLIrSjE4gN** | 57 | **DUP_DELIVERED로 제외** |
| task_TDsq55NUhMScwcCQ | failed | `provider_unavailable: claude-code (open/generic)` | **wr_-Ofp3mjLIrSjE4gN** | 0 | **INFRA_EXCLUSION으로 제외** |
| task_IDYxLFpEEiQhoMKz | completed | — | **wr_-Ofp3mjLIrSjE4gN** | 313 | terminal+completed |

`wr_-Ofp3mjLIrSjE4gN` 한 건이 **3중 팬아웃**됐고, 그중 `task_IDYxLFpEEiQhoMKz`가
실제 보고서를 배달했다. 나머지 2건은 배달된 산출물의 중복 사본 실패다.

---

## 3. 근본원인 및 75.7 → 93.7 이동 경위

HR 스냅샷 시점에는 `task_IDYxLFpEEiQhoMKz`가 아직 `running`(비terminal)이었다.
따라서 (a) completed 카운트에 들어가지 못했고, (b) "완료 형제가 존재할 때만" 참이 되는
`WORK_REPORT_DUP_DELIVERED_EXCLUSION`의 EXISTS 조건도 성립하지 않아 `task_7U-jEljr8bgs-1jI`가
분모에 남았다 → terminal 5 / completed 4 = **80%**.

점수 공식 역산으로 스냅샷이 정확히 재현된다(창작 아님):
`volume = 100*log10(5)/log10(78) = 36.86`, `score = 0.9*80 + 0.1*36.86 = 75.69 ≈ 75.7` ✔

형제가 완료된 현재는 terminal 5 / completed 5 = **100%**,
`score = 0.9*100 + 0.1*36.86 = 93.69 ≈ 93.7`.

잔여 -6.3은 `computeVolume(n=5, maxN=78)` 표본량 항으로, **설계상 정상**이며
기존 `gov-assurance-redteam` / `gov-evolution-*` 노트의 log10 패턴과 동일 계열이다.

---

## 4. 자가학습 단계 노트(`notes/team-gov-assurance-audit-cycle1.md`) 정정 2건

1. **"promptGate 필수 5필드 누락 → score 0 감점"은 팀 점수와 무관하다.**
   `grep -rl promptGate src/` → `src/server/task-intake.ts`, `src/server/gateway.ts`,
   `src/server/task-intake.test.ts` 3곳뿐이며 `src/core/team-scorer.ts`·`team-lifecycle.ts`·
   `src/server/routes/team-scores.ts` 어디에도 참조가 없다. 실제로 48h 완료 5건 중 4건이
   `promptGate.score=0`인 채로 정상 완료됐다. 감점 요인이 아니다.
2. **`task_IDYxLFpEEiQhoMKz`는 더 이상 `running`이 아니라 `completed`다**(응답 313자).
   노트 작성 시점 이후 완료되었고, 이것이 completion 회복의 직접 원인이다.
   `task_sRYn25ipGFgIZOmc`의 workReportId 부재는 team-runner 발 진단 태스크라 정상이며
   completion 집계에 영향이 없다.

---

## 5. 검증 로그 (원문)

```
$ npx tsc --noEmit ; echo TSC_EXIT=$?
TSC_EXIT=0
ERR_LINES=0

$ npx vitest run src/core/team-scorer.test.ts src/core/cron-scheduler.team-scores.test.ts
 RUN  v4.1.4 /Users/nova-ai/project/nco
 Test Files  2 passed (2)
      Tests  8 passed (8)
   Duration  401ms
```

HEAD 스코어러로 재계산(`computeTeamScores` 직접 호출, readonly DB):
```json
{
  "teamId": "team_gov-assurance-audit",
  "slug": "gov-assurance-audit",
  "name": "Evidence Audit and Compliance",
  "organizationId": "org_nco-assurance",
  "score": 93.7, "grade": "A", "completion": 100,
  "n": 5, "maxN": 78, "sample": "48h"
}
```

반사실(counterfactual) — dup-delivered 제외가 없을 때 48h 집계:
```
terminal_no_dup_excl = 6, completed = 5   → 83.3% (제외 적용 시 5/5 = 100%)
```
→ 회복을 만든 메커니즘이 기존 `WORK_REPORT_DUP_DELIVERED_EXCLUSION`임이 T1로 확인된다.

---

## 6. 패치 전/후 비교

| 항목 | HR 스냅샷 (before) | HEAD 재계산 (after) |
|---|---|---|
| score | 75.7 | **93.7** |
| grade | C | **A** |
| completion | 80% (4/5) | **100% (5/5)** |
| n / sample | 5 / 48h | 5 / 48h |
| 소스 변경 | — | **0 파일 (`git diff --stat src/` 빈 출력)** |

---

## 7. 롤백

소스 커밋이 없으므로 `git revert` 대상이 없다. 이 노트만 되돌리려면:

```
rm /Users/nova-ai/project/nco/notes/team-gov-assurance-audit-cycle1-patch-decision.md
```

---

## 8. 미검증 항목

- 잔여 -6.3(표본량 항)은 n이 늘어야 자연 해소되며, 본 사이클에서 n 증가를 유도하는 조치는 하지 않았다.
- `task_7U-jEljr8bgs-1jI`의 `database is locked`(SQLite 경합)는 스코어링에서는 제외되지만
  **실제 인프라 이슈**로 남아 있다. 본 서브태스크 범위(팀 스코어러/집계 경로) 밖이라 손대지 않았다.
- 팀 라이프사이클(활성/은퇴) 상태는 조회만 했고 변경하지 않았다(HR 전유).
