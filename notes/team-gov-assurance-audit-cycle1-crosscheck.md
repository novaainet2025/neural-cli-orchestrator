# team_gov-assurance-audit cycle1 — 중복에러방지팀 교차검증 보고서

- 대상 팀: Evidence Audit and Compliance (`gov-assurance-audit` / `team_gov-assurance-audit`)
- HR 지시 스냅샷: `score=75.7`, `completion=80%`, `sample=48h/5`, cycle 1/3
- 검증 시점 HEAD: `cc17993768e589631c08452e4520d74bc835d121`
- 검증자: 중복에러방지팀 (독립 재실행, 자가개선팀 산출물 인용 없이 DB·명령 출력으로 재확인)

---

## 1. 반복 에러 시그니처 표

### 1-A. 팀 내부 (team_gov-assurance-audit, 최근 7일 실패성 태스크 전수)

| 시그니처 | 발생 횟수 | 태스크 ID | 에러 원문 컬럼 |
|---|---|---|---|
| `provider_unavailable` | 1 | `task_TDsq55NUhMScwcCQ` | `provider_unavailable: claude-code (open/generic)` |
| `cli_failed_exit1` | 1 | `task_7U-jEljr8bgs-1jI` | `opencode: CLI failed exit=1 — Error: Unexpected error` |

**반복 시그니처 없음.** 7일 기준 실패성 태스크는 총 2건이며 서로 다른 시그니처, 각 n=1이다.

### 1-B. 시스템 전역 — `database is locked` (최근 7일)

| 팀 | 에이전트 | 횟수 |
|---|---|---|
| `team_gov-assurance-audit` | opencode | 1 |
| `team_self-improvement` | claude-code | 1 |
| **합계** | | **2** |

서로 다른 팀·다른 에이전트에서 각 1회, **비연속**이다.

### 1-C. 48h 전수 태스크 원장 (n=7)

| 태스크 ID | status | agent | workReportId | resp_len |
|---|---|---|---|---|
| `task_8PG4oI2CpGo9k6Hg` | completed | ollama | `wr_t-jb3ViePtQE19y_` | 914 |
| `task_lEMQcnwBLz-ak5FH` | completed | hermes | (없음) | 1186 |
| `task_sRYn25ipGFgIZOmc` | completed | ollama | (없음) | 9498 |
| `task_UatrcUS6U9HM64RL` | completed | opencode | `wr_Xp0BVMKs4UwnjcjY` | 252 |
| `task_7U-jEljr8bgs-1jI` | **failed** | opencode | `wr_-Ofp3mjLIrSjE4gN` | 57 |
| `task_TDsq55NUhMScwcCQ` | **failed** | claude-code | `wr_-Ofp3mjLIrSjE4gN` | 0 |
| `task_IDYxLFpEEiQhoMKz` | completed | codex | `wr_-Ofp3mjLIrSjE4gN` | 313 |

---

## 2. CB / Gate 룰 정의 — **갱신 없음**

**사유(측정 근거):**

`src/security/circuit-breaker.ts:10` 의 개통 조건은 `failureThreshold: 3` (연속 실패 3회)다.
관측된 최대 연속 실패는 **에이전트·팀 단위 1회**이며, 가장 유력한 후보였던
`database is locked`조차 7일 전역 **2회·비연속·서로 다른 에이전트**다. 임계값 3에 미달하므로
신규 CB 룰을 만들면 **정상 단발 실패까지 차단하는 과잉 개통 회귀**가 된다.

스코어러 제외 룰도 갱신하지 않는다. §3에서 확인했듯 문제 행 2건은 **이미 2중·3중으로 제외**되고
있어 추가 룰은 순수 과잉 제외다.

> 신규·변경 CB 룰 번호와 차단 건수는 **없음** — 존재하지 않는 룰 번호를 만들지 않았다.

### 다만 기록해 둘 실제 인프라 이슈 (본 사이클 범위 밖, 룰 대상 아님)

`task_7U-jEljr8bgs-1jI`의 근본 텍스트 `database is locked`는 `error` 컬럼이 아니라
**`response` 본문**에 있다. `src/storage/database.ts:21`은 `busy_timeout = 5000`을 설정하고 있으나
opencode 하위 프로세스가 자체 DB를 여는 경로는 이 pragma 적용 대상이 아니다.
n=2로는 룰화 근거가 부족하므로 **관찰만 하고 조치하지 않는다**.

---

## 3. 자가개선팀 패치 교차검증 — 판정: **CONFIRMED (결론 확정) + 근거 서술 2건 정정**

### 3-A. 결론부 — CONFIRMED

| 자가개선팀 주장 | 독립 재검증 결과 | 판정 |
|---|---|---|
| `src/` 패치 불필요, diff 0 | `git diff --stat src/` → 빈 출력, `git status --porcelain src/` → 빈 출력 | ✅ CONFIRMED |
| 현재 실측 `93.7 / A / 100% / n=5` | `computeTeamScores` 직접 실행 → 동일 값 | ✅ CONFIRMED |
| HR의 75.7/80%는 stale 스냅샷 | 현재 DB에서 재계산 시 재현 불가, 100%로 산출 | ✅ CONFIRMED |
| `promptGate`는 팀 스코어링과 무관 | `grep -n` → `src/core/team-scorer.ts` 내 `promptGate` 참조 **0건** | ✅ CONFIRMED |
| 잔여 -6.3은 `computeVolume` 표본량 항 | `0.9*100 + 0.1*(100*log10(5)/log10(78))` = 93.69 → 93.7 일치 | ✅ CONFIRMED |

**scorer 실행 원문:**
```json
{"teamId":"team_gov-assurance-audit","slug":"gov-assurance-audit",
 "name":"Evidence Audit and Compliance","organizationId":"org_nco-assurance",
 "score":93.7,"grade":"A","completion":100,"n":5,"maxN":78,"sample":"48h"}
```

### 3-B. 정정 ① — 복구 기여 룰 귀속 오류 (**중요**)

자가개선팀은 `WORK_REPORT_DUP_DELIVERED_EXCLUSION` **단독**이 100%를 복구했다고 서술하고,
반사실로 *"dup 제외 없을 때 terminal=6, completed=5 → 83.3%"* 를 제시했다.
**이 반사실은 재현되지 않는다.** 실제로는 두 룰이 각각 독립적으로 전량 커버한다.

행 단위 룰 매칭 실측:

| 태스크 ID | status | INFRA | DUP_DELIVERED | FANOUT_ALL_FAILED |
|---|---|---|---|---|
| `task_7U-jEljr8bgs-1jI` | failed | – | **YES** | **YES** |
| `task_TDsq55NUhMScwcCQ` | failed | **YES** | **YES** | **YES** |
| completed 5건 | completed | – | – | – |

반사실 3종 실측:

| 시나리오 | terminal / completed | completion |
|---|---|---|
| A. DUP만 제거 (FANOUT 유지) | 5 / 5 | **100%** |
| B. FANOUT만 제거 (DUP 유지) | 5 / 5 | **100%** |
| C. DUP·FANOUT 둘 다 제거 | 6 / 5 | **83.3%** |

→ 자가개선팀이 제시한 83.3%는 **시나리오 C(둘 다 제거)** 의 값이며, 이를 "dup 단독 제거"로
잘못 귀속했다. 결론(패치 불필요)은 바뀌지 않으나, 향후 사이클에서 *"dup 룰을 지키기 위해
건드리면 안 된다"* 는 식의 단일 룰 의존 판단으로 이어질 수 있어 정정한다.
실제 상태는 **2중 리던던시**이므로 한쪽 룰이 제거돼도 커버가 유지된다.

### 3-C. 정정 ② — "3중 팬아웃"은 순차 재배정(redispatch) 체인

`wr_-Ofp3mjLIrSjE4gN`의 3개 태스크는 동시 팬아웃이 아니라 **직렬 failover 체인**이다.
각 태스크의 `created_at`이 직전 태스크의 `completed_at`과 정확히 일치한다.

```
opencode     05:29:27 → 06:04:35  failed (CLI exit=1 / database is locked)
claude-code  06:04:35 → 06:53:25  failed (provider_unavailable)
codex        06:53:25 → 07:11:55  completed (313자)
```

부수적으로, 스냅샷의 80%(4/5)는 **06:04:35~06:53:25 구간**에서 채집된 것으로 설명된다.
그 시점엔 실패가 `7U-jE` 1건뿐이라 `FANOUT_ALL_FAILED`의 `HAVING COUNT(*)>1`이 성립하지 않고,
완료 사본도 아직 없어 `DUP_DELIVERED`도 성립하지 않았다 → 분모 잔류. 자가개선팀의
"완료 형제 조건 미성립" 설명은 이 구간에 한해 타당하다.

### 3-D. 정정 ③ — 에러 텍스트의 컬럼 위치

자가개선팀은 `task_7U-jE`의 실패를 `database is locked`로 표기했다. 실제 `error` 컬럼 값은
`opencode: CLI failed exit=1 — Error: Unexpected error`이고, `database is locked`는
**`response` 본문**에 있다. 원인 서술로는 타당하지만, `error` 컬럼 `LIKE` 기반 룰을
작성했다면 **매칭되지 않았을** 차이라 룰 설계 관점에서 기록한다.

### 3-E. False Report 판정: **해당 없음 (거짓 보고 아님)**

자가개선팀 보고의 완료·수치 주장은 전부 재검증 가능한 T1 근거를 가지며 독립 재실행에서
일치했다. §3-B/C/D는 **근거 서술의 정밀도 결함**이며, 없는 수치·없는 파일·없는 완료를
지어낸 사례는 발견되지 않았다. 자가개선팀이 명시한 미검증 항목(SQLite lock 재현, 라이브
게이트웨이 대조)도 실제로 미검증 상태임이 확인되어 은폐가 없다.

---

## 4. 팀 라이프사이클

조회만 수행했다. 팀 비활성화·삭제·은퇴는 **제안하지 않으며**, 해당 권한은 HR 단독 소유임을 확인한다.

---

## 검증 영수증

- **[변경]** `notes/team-gov-assurance-audit-cycle1-crosscheck.md` (신규, 문서 1건). **`src/` 변경 0** — `git diff --stat src/`·`git status --porcelain src/` 모두 빈 출력. CB·Gate 룰 갱신 0건.
- **[검증방법]**
  - `git rev-parse HEAD` → `cc17993768e589631c08452e4520d74bc835d121`
  - `sqlite3 db/nco.db` 48h 태스크 7건 전수 조회 (id/status/assigned_to/workReportId/resp_len/error/created_at/completed_at)
  - `sqlite3 db/nco.db` 7d 실패 시그니처 집계 → 2행, 각 n=1
  - `sqlite3 db/nco.db` 전역 7d `response LIKE '%database is locked%'` → 총 2건 (2팀·2에이전트)
  - 행 단위 룰 매칭 SQL (dwr/ff CTE 재현) → 실패 2건의 INFRA/DUP/FANOUT 플래그 표 산출
  - 반사실 SQL 3종(A: DUP 제거 → 5/5, B: FANOUT 제거 → 5/5, C: 둘 다 제거 → 6/5)
  - `npx tsx` 로 `computeTeamScores(readonly db)` 직접 실행 → `score:93.7, grade:"A", completion:100, n:5, maxN:78`
  - `grep -n "promptGate" src/core/team-scorer.ts` → 0건
  - `grep -rn "failureThreshold" src/security/circuit-breaker.ts` → `failureThreshold: 3` (`:10`)
  - `npx tsc --noEmit` → `TSC_EXIT=0`, `error TS` 0줄
  - `npx vitest run src/core/team-scorer.test.ts src/core/cron-scheduler.team-scores.test.ts src/security/circuit-breaker.test.ts` → `VITEST_EXIT=0`, `Test Files 3 passed (3) / Tests 17 passed (17)`
- **[등급]** **T1** — DB row 직접 조회, 스코어러 실제 실행 출력, 명령 exit code·출력 원문, 소스 파일 라인 직접 확인. 자가개선팀 보고 내용을 인용해 검증한 항목은 없으며 전부 독립 재실행했다.
- **[Gap]** **90%** — 집계 경로·룰 귀속·시그니처 집계는 전수 확인. 미달 10%: (a) 스냅샷 75.7/80%가 채집된 정확한 시각의 스코어러 출력 기록이 남아 있지 않아 06:04~06:53 구간 채집은 타임스탬프 정합에 근거한 **재구성**이며 당시 출력 원문으로 직접 확인하지 못했다. (b) SQLite lock 경합의 재현·수정은 본 서브태스크(중복에러방지·룰 갱신) 범위 밖이라 미조치.
- **[미검증항목]**
  - 스냅샷 채집 시점의 스코어러 출력 원문 (히스토리 미보존 — 타임스탬프 기반 재구성으로 대체)
  - 라이브 게이트웨이 `/api/team-scores` 응답 대조 (로컬 DB 직접 계산만 수행, HTTP 미호출)
  - `database is locked` 경합의 재현 시나리오 및 opencode 하위 프로세스의 `busy_timeout` 적용 여부
  - n이 78(maxN)에 근접했을 때 표본량 항 해소 여부 — 현재 n=5로 확인 불가
  - cycle 2/3 이후 재발 여부 (단일 시점 관측)

**롤백**: 소스·설정 변경이 없어 `git revert` 대상 없음. 문서만 되돌리려면
`rm /Users/nova-ai/project/nco/notes/team-gov-assurance-audit-cycle1-crosscheck.md`
