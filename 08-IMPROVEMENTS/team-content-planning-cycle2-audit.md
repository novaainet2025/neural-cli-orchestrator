# team_content-planning cycle 2 — 중복에러방지팀 교차검증 감사

작성: 2026-07-28 KST (측정 UTC 2026-07-27 19:28 ~ 19:36)
대상: cycle1 판정(`team-content-planning-cycle1-dup-error-audit.md`, `...-cycle1-scorer-evidence.md`)과
cycle2 산출물(`...-cycle2-evidence.md` §1~§7)
성격: **읽기 전용 감사 + 문서 1건 추가.** 런타임 코드·스코어러·CB 임계치·팀 lifecycle 변경 **0줄**.
측정 방식: `db/nco.db` 읽기 전용(`file:...?mode=ro`) 직접 조회 · `dist/core/team-scorer.js` 직접 호출 ·
`git show` · 외부 저장소 소스/로그 · `curl` HTTP 본문. 전부 이번 turn 내 재실행.

---

## 0. 결론 요약

| # | 감사 결과 | 판정 |
|---|---|---|
| 1 | 두 제외룰(spawn / zero-output)은 **실패를 은폐하지 않는다.** 반경은 DB 전체 각 1행·1팀이며, zero-output은 점수를 94.3 → 81.5로 **내린다**. | 확인 |
| 2 | cycle1의 "활성 팀 68개 중 1개, 해당 error를 가진 completed 행 0건" 주장은 **독립 재현됨**. | 확인 |
| 3 | cycle1의 "이 3행의 agent_actions 이벤트가 0건 / 14일 6,052행 중 이벤트 없는 행은 정확히 이 3건" 주장은 **사실과 다르다**(과대진술). 단 해당 *실행 인스턴스* 기준으로 좁히면 성립하며 결론(외부 주입)은 유지된다. | **반증(부분)** |
| 4 | **신규·최우선 발견**: 패치는 커밋됐지만 **실행 중 NCO에 반영되어 있지 않다.** 라이브 `/api/teams/scores`는 지금도 `83.4 / B / 87.5% / n=8`(pre-patch)을 준다. HR이 다음 사이클에 받을 값도 83.4다. | **신규 발견** |
| 5 | self-improvement 보고서의 "완료/PASS" 주장 중 재실행 가능한 항목은 **전부 재현됨**(tsc·vitest·build·토글 매트릭스·블라스트 반경). 허위 보고 **0건**. | 확인 |
| 6 | escalation error 덮어쓰기는 **실재**하나, 이를 근거로 제외를 넓히면 위험하다. 반사실 실측: provenance-only 룰은 48h에 **13행 / 9팀**을 제외하고 그중 **8행은 실제 산출물을 가진 진짜 실패**다. | 확인 |
| 7 | CB 임계치는 **변경 근거 없음** → 변경 제안하지 않음. | 확인 |

---

## 1. 검증 항목별 재현 결과

측정 시각의 48h 창 = `2026-07-25 19:28 UTC` 이후 `created_at`. cycle1/cycle2 측정 시점보다 창이
약 30~60분 이동했으나, 이 팀의 48h 행 9건은 모두 창 안에 남아 있어 산술은 동일하게 재현된다.

| # | 주장 (출처) | 재현 결과 (이번 turn 실측) | 등급 | 판정 |
|---|---|---|---|---|
| A1 | spawn 제외 블라스트 반경 = 활성 팀 68개 중 1개 (cycle1 §3) | `teams.is_active=1` → **68** (전체 87). 제외 적중 중 `team_id` 보유 = **1행 / 1팀**(`team_content-planning`) | T1 | 확인 |
| A2 | ENOENT error 클래스 전체 4건, 그중 team_id 보유 1건 (cycle1 §3) | DB 전체 4행 — `task_QPd87…`·`task_jhxm…`·`task_7OPe…`(전부 team_id NULL, 07-12) + `task_content_generation`(team_content-planning) | T1 | 확인 |
| A3 | 이 error를 가진 `completed` 행 **0건** → `completion>100%` 회귀 없음 (cycle1 §3) | `status='completed' AND error LIKE '%Command failed with ENOENT:%'` → **0** | T1 | 확인 |
| A4 | 48h 창 `completed` + `error<>''` 행 0건 (전 팀) (cycle1 §4-1) | **0** | T1 | 확인 |
| A5 | `Circuit breaker open%` 일별 331 / 1812 / 73 / 0 / 0 (cycle1 §1) | 07-23 **6**, 07-24 **331**, 07-25 **1812**, 07-26 **73**, 07-27·07-28 **행 없음(0)** | T1 | 확인 |
| A6 | 14일 팀 귀속 6,052행 중 **agent_actions 이벤트가 없는 행은 정확히 이 3건** (cycle1 §3) | 14d 팀 귀속 = **6,049행**(창 이동분). `agent_actions`가 **전무한 행 = 0건**. 문제의 3개 고정 ID는 각각 이벤트 **10 / 10 / 5건** 보유 | T1 | **반증** |
| A6′ | (좁힌 형태) 문제의 *실행 인스턴스*에 이벤트가 없다 | 2026-07-27 하루 기준 `task_trend_collector` **0건**, `task_content_generation` **0건**, `task_quality_check` 2건. `action_type='task:created'`는 DB 전체 16,879건 존재 → **부재가 유의미한 신호임**이 확인됨 | T1 | 확인 |
| B1 | zero-output 제외 반경 = 48h에 1팀 1행 (cycle2 §7.4) | 48h **1행**, 7d **1행**, **전 기간 1행** — 모두 `team_content-planning / task_trend_collector`. 원 보고서는 48h만 확인했으나 전 창에서도 1행 | T1 | 확인(+보강) |
| B2 | 토글 매트릭스 83.4 / 94.3 / 72.1 / 81.5 (cycle2 §7.3) | `dist/core/team-scorer.js` 4조합 직접 호출 → **83.4·B·87.5·n8 / 94.3·A·100·n7 / 72.1·C·75·n8 / 81.5·B·85.7·n7** — **4조합 전부 일치** | T1 | 확인 |
| B3 | 4조합 모두 `completion>100%` 팀 0/68 (cycle2 §7.3) | 4조합 전부 **over100 = []**, teams = **68** | T1 | 확인 |
| B4 | 산술: 분모 8 → spawn on 7 → 0B 제외로 분자 6 → 85.7% (cycle2 §7.4) | 스코어러 코드를 쓰지 않고 **직접 SQL로 독립 재계산**: `terminal(infra만)=8`, `+spawn=7`, `completed_raw=7`, `+zero-output=6` → 6/7 = **85.7%** | T1 | 확인 |
| B5 | cycle1·2 코드는 이미 HEAD `9201a22`에 커밋됨 (cycle2 §7.1) | `git log -1 9201a22` → `2026-07-28 04:12:26 +0900`. HEAD 소스에 `SPAWN_FAILURE_EXCLUSION_SQL`·`ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL` 존재 | T1 | 확인 |
| C1 | escalation 재배정이 원본 실패 사유를 덮어썼다 (cycle1 §1.2) | `metadata_json.escalationHistory[0].reason` = `provider_unavailable: opencode (open/generic)` / `tasks.error` = `cursor-agent: … ENOENT` — **두 값이 실제로 불일치** | T1 | 확인 |

---

## 2. 제외 대상이 진짜 가용성 이벤트인가 — 원시 행 판정

### 2-1 원시 행 (읽기 전용 조회 그대로)

```
id                   = task_content_generation      id                   = task_trend_collector
team_id              = team_content-planning        team_id              = team_content-planning
status               = failed                       status               = completed
assigned_to          = cursor-agent                 assigned_to          = mlx
progress             = 0.0                          progress             = 0.0
created_at           = 2026-07-27 17:10:06          created_at           = 2026-07-27 15:00:04
completed_at         = 2026-07-27 17:21:31          completed_at         = 2026-07-27 15:00:09
response / result_json / evidence_json = 0 / 0 / 0   response / result_json / evidence_json = 0 / 0 / 0
orphan_requeue_count = 1                            orphan_requeue_count = 0
spawned_by_cli       = NULL                         spawned_by_cli       = NULL
system_prompt        = 0 bytes                      system_prompt        = 0 bytes
error                = …Command failed with ENOENT  error                = NULL
prompt               = "누락된 SEO 키워드 분석 및 최적화 중"   prompt               = "트렌드 키워드 수집 및 분석 중"
```

두 행 모두 `progress=0.0`, 산출물 3필드 전부 0B, `prompt`가 지시문이 아니라 **상태 문구**다.
`ENOENT`는 exec 단계 실패이므로 CLI 프로세스가 한 번도 기동되지 않았음을 뜻한다.
→ **가용성 이벤트로 판정. 팀 산출물 품질 신호가 아님. (확인)**

### 2-2 `task_trend_collector`의 "completed"는 에이전트 실행이 아니다 — 초 단위 대조

| 증거 | 값 | 등급 |
|---|---|---|
| 외부 cron | `0 */6 * * * … nova-sns … automation/trend-collector.py` | T1 |
| 외부 소스 | `trend-collector.py:408` `INSERT OR REPLACE INTO tasks …` / `:429` `register_nco_task("task_trend_collector", …, "completed")` | T1 |
| 외부 로그 | `logs/cron.log`: `[2026-07-28 00:00:04] 수집 완료` (KST) = **UTC 2026-07-27 15:00:04** | T1 |
| DB 행 | `created_at = 2026-07-27 15:00:04`, `completed_at = 15:00:09` | T1 |
| 이벤트 | 2026-07-27 당일 `agent_actions` **0건** (동일 ID의 과거 실행 이벤트는 5건 존재) | T1 |

외부 파이썬의 로그 라인과 DB 행 생성 시각이 **초 단위로 일치**한다. 이 "완료"는 파이썬이
자기 자신에 대해 쓴 상태 문자열이며 NCO 에이전트가 낸 산출물이 아니다.
→ 분자에서 제외하는 것은 **실패 은폐가 아니라 허위 성공 제거**다. (확인)

### 2-3 은폐 방향성 검사 — 규칙은 팀에 유리한가

| 검사 | 실측 | 해석 |
|---|---|---|
| zero-output 룰의 점수 효과 | 94.3 → **81.5** (A → B), completion 100% → 85.7% | 점수를 **내린다**. 은폐의 반대 방향 |
| 0B completed가 분모에 남는가 | terminal CASE에는 삽입되지 않음 → n=7 유지, 분자만 6 | 실패와 동일 취급. `completed ⊆ terminal` 보존 |
| 외부 주입이 **실패**를 쓰면? | `trend-collector.py:431`이 `status='failed'`를 쓰는 경로 존재. 이 행은 error가 NULL/비-ENOENT라 어떤 제외룰에도 걸리지 않음 | 주입 **성공**은 빠지고 주입 **실패**는 그대로 계상 → 규칙은 팀에 **불리한 쪽으로 보수적** |
| 산출물이 다른 곳에 있을 가능성 | 0B 대상 행의 `evidence_json`도 0B. 전 기간 대상 행이 1건뿐 | `response`/`result_json`만 보는 것이 이 데이터에서 오탐을 만들지 않음 |
| 분모 전용 제외룰이 `completed`와 겹치는가 (>100% 위험) | `INFRA_EXCLUSION` ∩ completed = **0**, `PROVIDER_AUTH` 형태 ∩ completed = **0** | 4조합 over100 = [] 실측과 일치 |
| spawn 룰의 세탁 가능성 (앞선 시도가 산출물을 냈는데 마지막 ENOENT로 0B가 되는가) | `persistTaskReassignment`(task-queue.ts:293-317)는 `response`/`result_json`을 건드리지 않음. `task-queue.ts:197` `response: result.output \|\| undefined` → **빈 출력은 기존 response를 덮어쓰지 않음** | 산출물을 냈던 태스크는 구조적으로 0B 가드를 통과할 수 없음 |

**판정: 두 제외룰 모두 실패 은폐 아님.** 반경은 DB 전체 각 1행이고, 안전 가드가 코드 수준에서 뒷받침된다.

---

## 3. escalation 원본 사유 덮어쓰기 — 룰 갱신 제안 (적용은 별도 승인)

### 3-1 확인된 사실

`tasks.error`는 태스크의 원인이 아니라 **마지막 시도의 오류 문자열**이다. 원본 사유는
`metadata_json.escalationHistory[].reason`에만 남는다(§1 C1에서 T1 확인).
접두사 문자열에 의존하는 `INFRA_EXCLUSION`은 재배정이 일어나면 매칭이 깨진다.

### 3-2 반사실 실측 — "provenance만 보고 제외"는 위험하다

`escalationHistory`에 인프라 사유가 있고 최종 error는 인프라가 아닌 48h 실패 행:

```
제외될 행 = 13,  영향 팀 = 9,  그중 response > 0B (실제 산출물을 낸 진짜 실패) = 8
```

포함 예: `silent-failure: empty output`(응답 25B·8B), `opencode: CLI failed exit=1`(응답 936B·978B).
이들은 **에이전트가 실제로 돌고 산출물까지 낸 품질 실패**다. 현행 두 룰의 반경(각 1행)과 비교하면
**13배**이며, 이것이야말로 "점수만 올리고 실패를 숨기는" 오용 패턴이다.

### 3-3 제안

| ID | 제안 | 근거 | 임계치 변경 |
|---|---|---|---|
| **R1** | **CB 임계치·`rateLimitRpm` 변경 금지** | `circuit_states.cursor-agent` = `closed`, failure_count **0** (회로가 열린 적 없음). ENOENT 14일 빈도 **1건**. 임계치를 어떻게 바꿔도 이 실패는 막히지 않음 | **없음** |
| **R2** | 제외 판정을 **provenance 단독으로 확장하지 말 것**. 현행처럼 `escalation 사유` ∧ `산출물 0B` ∧ `progress 0` ∧ `해당 실행의 이벤트 부재` **논리곱**을 유지 | §3-2 반사실 13행/9팀·산출물 보유 8행 | 없음 |
| **R3** | (비-스코어) `tasks`에 `first_failure_reason` 등 **최초 실패 사유 보존 필드** 추가. 스코어 룰이 mutable `error` 접두사에 의존하지 않게 함 | §3-1. 현재는 JSON 안에 묻혀 있어 SQL 제외 조건이 문자열 매칭으로 내려갈 수밖에 없음 | 없음 |
| **R4** | 제외 상수마다 **`∩ completed = 0` 불변식 회귀 테스트** 상설화 (현재는 소스 주석의 실측 기록이 근거) | §2-3 마지막 행. 데이터가 바뀌면 `completion>100%` 회귀가 조용히 열릴 수 있음 | 없음 |
| **R5** | (범위 밖·별도 승인) 외부 `nova-sns` 고정 ID raw sqlite3 주입 → NCO API 경유로 전환. cycle1의 orphan gate는 **실행**만 막고 phantom `completed` **기록 자체**는 못 막는다 | §2-2 | 없음 |

---

## 4. self-improvement 보고서의 "완료/PASS" 주장 ↔ T1 대조

| 보고서 주장 | 이번 turn 재실행 결과 | 등급 | 판정 |
|---|---|---|---|
| `npx tsc --noEmit` exit 0 (cycle2 §7.2) | **exit 0**, 출력 0줄 | T1 | 확인 |
| `npx vitest run src/core/team-scorer.test.ts` → 10 passed | **Test Files 1 passed / Tests 10 passed** | T1 | 확인 |
| `npm run build` exit 0 (§7.2에서 §5의 EPERM gap 해소 주장) | **exit 0**, `dist/core/team-scorer.js` 재생성(04:33:40) | T1 | 확인 |
| 토글 매트릭스 4조합 수치 | 4조합 전부 일치 (§1 B2) | T1 | 확인 |
| 0B 블라스트 반경 "DB 전체 1팀 1행" | 48h·7d·전 기간 모두 1행 | T1 | 확인 |
| "94.4가 아니라 94.3" 정정 | **94.3** 재현. 이전 수치를 재주장하지 않고 실측을 기록한 처리가 옳음 | T1 | 확인 |
| "HR 입력 83.4/87.5%는 두 토글 off 값" | `off/off` 조합과 정확히 일치 | T1 | 확인 |
| "이 세션 코드 변경 0줄" | `git show HEAD:src/core/team-scorer.ts`에 두 규칙 존재, 커밋 04:12:26 | T1 | 확인 |
| cycle1 "이벤트 0건" 근거 | §1 A6 — **원문대로는 성립하지 않음** | T1 | **반증(부분)** |
| "실제 현재 점수는 81.5/B/85.7%" | 라이브러리·HEAD 기준으로는 맞음. **라이브 서비스 기준으로는 틀림** → §5 | T1 | **조건부** |

**LLM 발 허위 보고: 0건.** 검증 명령 결과를 부풀린 항목은 발견되지 않았다.
A6은 조작이 아니라 **질의 범위를 좁게 잡고 넓게 서술한 과대진술**로 분류한다
(결론인 "외부 주입"은 §2-2의 독립 증거로 오히려 더 강하게 뒷받침된다).

---

## 5. 신규 발견 — 패치가 실행 중 서비스에 반영되어 있지 않다

cycle1·cycle2 모두 "게이트웨이 다운으로 HTTP 미검증"을 `[미검증항목]`으로 남겼다.
**이번 감사 시점에 게이트웨이가 살아 있어 그 항목을 닫았고, 결과는 부정적이다.**

```
curl -s localhost:6200/health                → 200
curl -s localhost:6200/api/teams/scores      → team_content-planning:
     {"score": 83.4, "grade": "B", "completion": 87.5, "n": 8, "sample": "48h"}
     teams = 68, over100 = []
```

| 사실 | 값 | 등급 |
|---|---|---|
| 라이브 HTTP 값 | **83.4 / B / 87.5% / n=8** = `off/off` (pre-patch) | T1 (HTTP 본문) |
| 라이브러리·HEAD 기준 값 | 81.5 / B / 85.7% / n=7 | T1 |
| NCO 프로세스 | pid 10569, 기동 **2026-07-28 02:46:24 KST** | T1 (`ps`) |
| 스코어러 커밋 | `9201a22` **2026-07-28 04:12:26 KST** | T1 (`git log`) |
| `dist` 재빌드 | 04:33:40 | T1 (`stat`) |
| 프로세스 env | `NCO_SCORER_*` 토글 **미설정**(기본 on) | T2 (`ps eww`) |

**프로세스가 코드보다 86분 먼저 떴다.** 두 제외룰은 커밋·빌드·테스트까지 정상이지만
**런타임에서는 한 줄도 실행되고 있지 않다.**

함의 — HR이 다음 사이클에 받을 값은 여전히 **83.4 / 87.5%** 다.
"HR 입력이 stale하다"가 아니라 **"서비스가 아직 pre-patch를 서빙 중"**이 정확한 서술이다.
반영에는 NCO 재시작이 필요하며, 이는 다른 세션·크론이 붙어 있는 공용 서비스에 대한
외부 영향 행위이므로 **이 감사에서는 수행하지 않았다(승인 필요).**

---

## 6. 미검증 / 범위 밖

- **재시작 후 라이브 값이 81.5가 되는지** — 예측일 뿐 **미검증**. 재시작 미수행(§5).
- **A6의 원 저자 의도** — 좁은 질의(실행 인스턴스 기준)였는지 넓은 질의였는지는 재현 불가. 서술된 문장 기준으로만 판정했다.
- **`nova-sns` producer 수정** — 별도 저장소, 이번 범위 밖(R5).
- **다른 세션의 provider-auth 변경 최종 상태** — 워킹트리 dirty(`team-scorer.ts` +41/-13). 이 팀 수치에는 영향 없음을 확인(대상 팀에 `{"type":"error"…` 응답 실패 행 0건)했으나, merge 완료 후 통합 상태는 미검증.
- **cycle1 orphan gate의 런타임 발효** — 부팅 경로 코드이므로 §5와 동일하게 재시작 전까지 미발효.

## 7. 이 감사의 되돌리기

- 추가 파일: 이 문서 1개. 되돌리기 = 파일 삭제 또는 `git revert`.
- 코드·DB·설정·팀 lifecycle 변경 **없음**. DB는 전부 `mode=ro` 연결로만 접근.
- 부작용 1건: `npm run build` 재실행으로 `dist/`가 04:33:40에 재생성됐다(§4 검증 목적).
  소스 변경이 없었으므로 산출물 내용은 직전 빌드와 동일하며, 실행 중 프로세스는 이를 로드하지 않는다(§5).

---

## 검증 영수증

- **[변경]** `08-IMPROVEMENTS/team-content-planning-cycle2-audit.md` (신규 1건). 코드 diff **0줄**.
- **[검증방법]**
  - `sqlite3 "file:db/nco.db?mode=ro"` — ENOENT 4행 전수 / completed∩ENOENT=0 / 48h completed∩error≠''=0 /
    CB open 일별 카운트 / 14d 팀행 6,049 및 이벤트 부재 행 0 / 고정 3ID의 action 25건·07-27 당일 0건 /
    0B completed 반경 48h·7d·all 각 1행 / 분모·분자 독립 SQL 재계산 8·7·7·6 / 반사실 13행·9팀·산출물 8행 /
    `circuit_states` 전수
  - `node` → `dist/core/team-scorer.js` `computeTeamScores()` 4토글 조합 직접 호출 → 83.4·94.3·72.1·81.5, over100 [] ×4
  - `curl -s localhost:6200/health` → **200**, `curl -s localhost:6200/api/teams/scores` → 본문에서 `83.4/B/87.5/n=8`
  - `ps -eo pid,lstart` pid 10569 = 02:46:24 KST · `git log -1 9201a22` = 04:12:26 KST · `stat dist/` = 04:33:40
  - `npx tsc --noEmit` → exit 0 · `npx vitest run src/core/team-scorer.test.ts` → 10 passed · `npm run build` → exit 0
  - `grep`/`Read` — `trend-collector.py:408/429/431`, `nova-sns/logs/cron.log` 타임스탬프, `task-queue.ts:197/293-317`
- **[등급] T1** — DB 행·HTTP 응답 본문·git object·프로세스 테이블·파일 내용·명령 exit code를 이번 turn에 직접 확인.
  프로세스 env 확인만 **T2**(`ps eww`).
- **[Gap]** 하위작업 (1)(2)(3)(4) 4항목 전부 수행. (3)은 지시대로 **제안까지만**이고 임계치 변경·적용은 하지 않았다.
- **[미검증항목]** 재시작 후 라이브 값(81.5 예상) · A6 원 저자의 질의 범위 · nova-sns producer 수정 ·
  다른 세션 provider-auth merge 후 통합 상태 · orphan gate 런타임 발효
- **[롤백]** 이 문서 삭제 또는 `git revert`. 런타임 스코어러 롤백은 기존 환경변수 토글
  (`NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`, `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`)이 그대로 유효.
