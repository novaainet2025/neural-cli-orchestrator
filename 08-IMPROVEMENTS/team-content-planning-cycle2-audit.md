# team_content-planning cycle 2 — 중복에러방지팀 교차검증 감사

작성: 2026-07-28 KST (측정 UTC 2026-07-27 19:42 ~ 19:45)
대상: cycle1 판정(`team-content-planning-cycle1-dup-error-audit.md`, `...-cycle1-scorer-evidence.md`)과
cycle2 산출물(`...-cycle2-evidence.md` §1~§7)
성격: **읽기 전용 감사 + 문서 1건.** 런타임 코드·스코어러·CB 임계치·팀 lifecycle 변경 **0줄**.
측정 방식: `db/nco.db` 읽기 전용(`file:...?mode=ro`) · `dist/core/team-scorer.js` 4토글 직접 호출 ·
`curl` HTTP 본문 · `npx tsc`/`vitest`/`npm run build` · 외부 `trend-collector.py` 소스.
**전부 이번 turn 내 재실행.** 이전 감사 문서 수치를 재주장하지 않고 실측으로 재확인함.

---

## 0. 결론 요약

| # | 감사 결과 | 판정 |
|---|---|---|
| 1 | 두 제외룰(spawn / zero-output)은 **실패를 은폐하지 않는다.** 반경은 DB 전체 각 1행·1팀이며, zero-output은 점수를 94.3 → 81.5로 **내린다**. | 확인 |
| 2 | cycle1의 "활성 팀 68개 중 1개, 해당 error를 가진 completed 행 0건" 주장은 **독립 재현됨**. | 확인 |
| 3 | cycle1의 "14일 팀 귀속 N행 중 agent_actions 없는 행은 정확히 이 3건" 주장은 **반증**. 14d `no_actions=0`. 고정 3ID는 all-time 이벤트 10/10/5건 보유. 07-27 당일로 좁히면 trend/content_gen=0 · quality=2. | **반증(부분)** |
| 4 | 패치는 커밋됐지만 **실행 중 NCO에 미반영.** 라이브 `/api/teams/scores` = `83.4 / B / 87.5% / n=8`(pre-patch). pid 10569 기동 02:46 KST ≪ 커밋 04:12. | **확인(신규)** |
| 5 | self-improvement "완료/PASS" 재실행 가능 항목은 **전부 재현**(tsc·vitest 10·build·토글·블라스트). 허위 보고 **0건**. | 확인 |
| 6 | escalation error 덮어쓰기는 **실재**. provenance-only 제외는 `pattern-escalation-error-overwrite.md` SQL로 **13행/9팀/산출물보유 8행** — 은폐 위험. | 확인 |
| 7 | CB 임계치 변경 근거 없음 (`cursor-agent` closed/failure_count=0, ENOENT 팀귀속 1건). | 확인 |

---

## 1. 검증 항목별 재현 결과

| # | 주장 (출처) | 재현 결과 (이번 turn 실측) | 등급 | 판정 |
|---|---|---|---|---|
| A1 | spawn 제외 블라스트 = 활성 팀 68개 중 1개 (cycle1) | `is_active=1` → **68** / 전체 **87**. ENOENT ∧ team_id ∧ ≠completed ∧ 0B → **1행 1팀** (`team_content-planning`) | T1 | 확인 |
| A2 | ENOENT 클래스 전체 4건, team_id 보유 1건 (cycle1) | 4행: `task_QPd87…`·`task_jhxm…`·`task_7OPe…`(team_id NULL, 07-12) + `task_content_generation`(team_content-planning, 07-27) | T1 | 확인 |
| A3 | 이 error를 가진 `completed` 행 0건 (cycle1) | `status='completed' AND error LIKE '%Command failed with ENOENT:%'` → **0** | T1 | 확인 |
| A4 | 48h `completed` ∧ `error<>''` 전 팀 0건 (cycle1 §4-1) | **0** | T1 | 확인 |
| A5 | CB open 일별 331/1812/73/0/0 (cycle1 §1) | 07-23 **6**, 07-24 **331**, 07-25 **1812**, 07-26 **73**, 07-27·28 **0** | T1 | 확인 |
| A6 | 14d 팀행 중 이벤트 없는 행 = 정확히 고정 3건 (cycle1 §3) | 14d 팀행 **6053**, `no_actions` **0**. 고정 3ID all-time actions: content_gen **10** / quality **10** / trend **5** | T1 | **반증** |
| A6′ | (좁힌) *실행 인스턴스* 기준 07-27 이벤트 부재 | 07-27: trend **0**, content_gen **0**, quality **2** | T1 | 확인 |
| B1 | zero-output 제외 반경 48h 1팀 1행 (cycle2 §7.4) | 48h **1** / 7d **1** / all **1** — 전부 `task_trend_collector` / `team_content-planning` | T1 | 확인 |
| B2 | 토글 매트릭스 83.4 / 94.3 / 72.1 / 81.5 (cycle2 §7.3) | dist 직접 호출 4조합: **83.4·B·87.5·n8 / 94.3·A·100·n7 / 72.1·C·75·n8 / 81.5·B·85.7·n7** | T1 | 확인 |
| B3 | 4조합 over100 = 0/68 | 전부 `over100=[]`, `teams=68` | T1 | 확인 |
| B4 | 산술 분모8→spawn7→0B분자6→85.7% (cycle2) | 독립 SQL: raw_terminal**9** / after_infra**8** / after_infra_spawn**7** / completed_raw**7** / completed_nonzero**6** → 6/7=**85.7%** | T1 | 확인 |
| B5 | cycle1·2 코드 HEAD `9201a22` 커밋 (cycle2 §7.1) | `9201a22` @ 2026-07-28 04:12:26 +0900; HEAD에 `SPAWN_FAILURE_EXCLUSION_SQL`·`ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL` 존재 | T1 | 확인 |
| C1 | escalation이 원본 사유를 덮어씀 (cycle1) | `first_esc=provider_unavailable: opencode (open/generic)` vs `error=cursor-agent: … ENOENT` — **불일치** | T1 | 확인 |
| C2 | provenance-only 제외 = 13행/9팀/산출물8 (선행 audit) | `pattern-escalation-error-overwrite.md` SQL 재실행 → aggregate `15\|9\|13\|9\|2\|10\|8` = team-scoped **13/9**, with_output_team **8** | T1 | 확인 |
| C2′ | 단순 `metadata LIKE '%provider_unavailable%'` 변형 | **48행/30팀/산출물4** — 방법론이 다르면 수치가 달라짐. 선행 문서의 13/9/8은 **json_each 전용 SQL**에서만 성립 | T1 | 확인(방법론 의존) |

---

## 2. 제외 대상이 진짜 가용성 이벤트인가 — 원시 행 판정

### 2-1 원시 행 (읽기 전용 조회)

| 필드 | `task_content_generation` | `task_trend_collector` |
|---|---|---|
| team_id | team_content-planning | team_content-planning |
| status | failed | completed |
| assigned_to | cursor-agent | retired-local-provider |
| progress | 0.0 | 0.0 |
| response / result_json / evidence | 0 / 0 / 0 | 0 / 0 / 0 |
| orphan_requeue_count | 1 | 0 |
| spawned_by_cli | NULL | NULL |
| system_prompt | 0B | 0B |
| metadata_json | 317B (escalationHistory 있음) | 0B |
| created_at / completed_at | 2026-07-27 17:10:06 / 17:21:31 | 15:00:04 / 15:00:09 |
| error | `…Command failed with ENOENT: cursor-agent…` | NULL |
| prompt | "누락된 SEO 키워드 분석 및 최적화 중" | "트렌드 키워드 수집 및 분석 중" |

두 행 모두 `progress=0.0`, 산출물 3필드 0B, prompt가 지시문이 아닌 **상태 문구**.
ENOENT는 exec 단계 실패 → CLI 미기동.
→ **가용성 이벤트. 팀 산출물 품질 신호 아님. (확인)**

### 2-2 `task_trend_collector` completed는 에이전트 실행이 아님

| 증거 | 값 | 등급 |
|---|---|---|
| 외부 소스 | `nova-sns/automation/trend-collector.py:400-431` — raw `sqlite3.connect("/Users/nova-ai/project/nco/db/nco.db")` 후 `INSERT OR REPLACE` / status UPDATE. exit code 미검사 | T1 (파일 내용) |
| 호출부 | L423 `running` → L429 `completed` (try 통과 시) / L431 `failed` (except) | T1 |
| DB 행 | created_at=15:00:04, completed_at=15:00:09 (5초), response 0B | T1 |
| 이벤트 | 07-27 당일 `agent_actions` **0건** (과거 인스턴스 누적 5건은 존재) | T1 |

→ 분자 제외는 **실패 은폐가 아니라 허위 성공 제거**. (확인)

### 2-3 은폐 방향성 검사

| 검사 | 실측 | 해석 |
|---|---|---|
| zero-output 점수 효과 | 94.3 → **81.5** (A→B), completion 100%→85.7% | 점수를 **내린다** |
| 0B completed가 분모에 남는가 | terminal CASE에 zero-output 미삽입 → n=7 유지, 분자만 6 | 실패 동등 취급; `completed⊆terminal` 보존 |
| 주입 실패 경로 | `trend-collector.py:431`이 `failed` 기록 → ENOENT 비매칭 → 제외룰 미적용 | 주입 **성공**만 빠지고 주입 **실패**는 계상 → 팀에 보수적 |
| provenance-only 확장 시 | §1 C2: **13행/9팀 중 8행이 산출물 보유 진짜 실패** | 은폐 방향. **금지** |

**판정: 현행 두 제외룰은 실패 은폐 아님.** 반경 각 1행. provenance 단독 확장은 은폐 위험이므로 제안하지 않음.

---

## 3. escalation 원본 사유 덮어쓰기 — 룰 갱신 제안 (적용은 별도 승인)

### 3-1 확인된 사실

`tasks.error` = **마지막 시도** 오류 문자열. 원본은 `metadata_json.escalationHistory[].reason`에만 잔존.
`task_content_generation`: first=`provider_unavailable: opencode (open/generic)` → final=`cursor-agent … ENOENT`.
접두사 의존 `INFRA_EXCLUSION`은 재배정 후 매칭 붕괴.

### 3-2 반사실 — provenance 단독 제외는 위험

`08-IMPROVEMENTS/pattern-escalation-error-overwrite.md` 탐지 SQL(`json_each` over escalationHistory,
source_class ∈ {circuit-breaker, provider_unavailable, queue_wait_timeout}, final error ∉ INFRA 접두사)
이번 turn 재실행:

```
total_rows=15, distinct_teams_incl_null=9,
team_scoped_rows=13, team_scoped_teams=9, no_team=2,
with_output_all=10, with_output_team_scoped=8
```

포함 예: 응답 보유 실패(품질 신호). 현행 spawn/0B 반경(각 1행) 대비 **13배**.
→ "점수만 올리고 실패를 숨기는" 오용 패턴.

### 3-3 제안 (적용 금지 — 승인 대기)

| ID | 제안 | 근거 | 임계치 변경 |
|---|---|---|---|
| **R1** | **CB 임계치·`rateLimitRpm` 변경 금지** | `circuit_states.cursor-agent` = `closed`, failure_count **0**. ENOENT 팀귀속 14d **1건**. 임계치로 이 실패는 막히지 않음 | **없음** |
| **R2** | 제외를 provenance 단독으로 확장하지 말 것. 현행처럼 `사유` ∧ `산출물 0B` ∧ `progress 0` **논리곱** 유지 | §3-2: 13/9 중 산출물 8행 | 없음 |
| **R3** | (비-스코어) `tasks.first_failure_reason` 등 **최초 실패 사유 보존 컬럼** 추가 — mutable `error` 접두사 의존 제거 | §3-1 | 없음 |
| **R4** | 제외 상수마다 `∩ completed = 0` 불변식 회귀 테스트 상설화 | A3·A4 = 0 실측; 데이터 변동 시 >100% 위험 | 없음 |
| **R5** | (범위 밖) `nova-sns` raw sqlite3 주입 → `POST /api/tasks` 경유. orphan gate는 실행만 막고 phantom completed 기록은 못 막음 | §2-2 | 없음 |
| **R6** | 라이브 NCO **재시작**(별도 승인) — 패치 반영. 현재 서비스는 pre-patch 서빙 중 | §5 | 없음 |

---

## 4. self-improvement 보고서 "완료/PASS" ↔ 같은 turn T1 대조

| 보고서 주장 | 이번 turn 재실행 | 등급 | 판정 |
|---|---|---|---|
| `npx tsc --noEmit` exit 0 | **exit 0**, 출력 0줄 | T1 | 확인 |
| `npx vitest run src/core/team-scorer.test.ts` → 10 passed | **Test Files 1 passed / Tests 10 passed** (503ms) | T1 | 확인 |
| `npm run build` exit 0 | **EXIT_CODE=0** | T1 | 확인 |
| 토글 매트릭스 4조합 | 83.4 / 94.3 / 72.1 / 81.5 전부 일치 (§1 B2) | T1 | 확인 |
| 0B 블라스트 "DB 전체 1팀 1행" | 48h·7d·all 각 1행 | T1 | 확인 |
| "94.4가 아니라 94.3" | **94.3** 재현 | T1 | 확인 |
| "HR 83.4/87.5% = 두 토글 off" | off/off = 83.4/B/87.5/n8; 라이브 HTTP도 동일 | T1 | 확인 |
| "이 세션 코드 변경 0줄" | 본 감사도 코드 diff **0**. HEAD에 두 규칙 존재 | T1 | 확인 |
| cycle1 "이벤트 0건" 넓은 서술 | §1 A6 — **원문대로 불성립** | T1 | **반증(부분)** |
| "실제 현재 점수 81.5/B/85.7%" | 라이브러리·HEAD 기준 **맞음**. 라이브 서비스 기준 **틀림**(§5) | T1 | **조건부** |

**LLM 발 허위 보고: 0건.** A6은 조작이 아니라 질의 범위를 좁게 잡고 넓게 서술한 **과대진술**.
외부 주입 결론 자체는 §2-2 T1로 유지.

---

## 5. 패치 미반영 — 실행 중 서비스는 여전히 pre-patch

```
curl -s localhost:6200/health
  → 200 {"status":"healthy",… "uptime":7144.93…}  (≈1.98h)

curl -s localhost:6200/api/teams/scores → team_content-planning:
  {"teamId":"team_content-planning","score":83.4,"grade":"B",
   "completion":87.5,"n":8,"sample":"48h"}
```

| 사실 | 값 | 등급 |
|---|---|---|
| 라이브 HTTP | **83.4 / B / 87.5% / n=8** = off/off | T1 (HTTP 본문) |
| 라이브러리 HEAD 기본(on/on) | 81.5 / B / 85.7% / n=7 | T1 |
| NCO 프로세스 | pid 10569, 기동 **02:46 KST** | T1 (`ps`) |
| 스코어러 커밋 | `9201a22` **04:12:26 KST** | T1 (`git log`) |
| health uptime | 7144s ≈ 기동~측정 정합 | T1 |

**프로세스가 커밋보다 ~86분 먼저 뜸.** 두 제외룰은 커밋·빌드·테스트 정상이지만 런타임에 미로드.
반영 = NCO 재시작 → **이 감사에서는 미수행(승인 필요, R6).**

---

## 6. 미검증 / 범위 밖

- **재시작 후 라이브가 81.5가 되는지** — 예측일 뿐 **미검증** (재시작 미수행).
- **A6 원 저자 의도**(좁은 vs 넓은 질의) — 서술 문장 기준으로만 판정.
- **`nova-sns` producer 수정** — 별도 저장소, 범위 밖(R5).
- **다른 세션 provider-auth dirty merge 후 통합 상태** — 미검증(본 감사 대상 팀 수치에는 spawn/0B만 영향).
- **orphan gate 런타임 발효** — 부팅 경로; 재시작 전 미발효.

## 7. 되돌리기

- 추가/갱신 파일: 이 문서 1개. 되돌리기 = 삭제 또는 `git revert`.
- 코드·DB·설정·팀 lifecycle 변경 **없음**. DB는 `mode=ro`만.
- 스코어러 런타임 롤백(적용 시): `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`,
  `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off` (재빌드 불필요).

---

## 검증 영수증

- **[변경]** `08-IMPROVEMENTS/team-content-planning-cycle2-audit.md` (본 turn 전면 재작성). 코드 diff **0줄**.
- **[검증방법]**
  - `sqlite3 "file:db/nco.db?mode=ro"` — ENOENT 4행 / completed∩ENOENT=0 / 48h completed∩error≠''=0 /
    CB 일별 6·331·1812·73·0·0 / 14d 팀행 6053·no_actions 0 / 고정3ID actions 10·10·5 /
    0B completed 반경 1·1·1 / SQL 산술 9·8·7·7·6 / pattern SQL 13·9·8 /
    circuit_states cursor-agent closed/0 / orphan·metadata 2행
  - `node` → `dist/core/team-scorer.js` 4토글 → 83.4·94.3·72.1·81.5, over100 [] ×4
  - `curl` health 200 + scores 본문 83.4/B/87.5/n=8; `ps` pid 10569 @02:46
  - `npx tsc --noEmit` exit 0 · vitest 10 passed · `npm run build` exit 0
  - Read `trend-collector.py:400-431`
- **[등급] T1** — DB 행·HTTP 본문·git object·프로세스·파일 내용·명령 exit code를 이번 turn 직접 확인.
- **[Gap]** 하위작업 (1)(2)(3)(4) 전부 수행. (3)=제안만, 임계치/적용 없음.
- **[미검증항목]** 재시작 후 라이브 81.5 · A6 원의도 · nova-sns producer · provider-auth merge 통합 · orphan gate 발효
- **[롤백]** 이 문서 삭제/`git revert`. 팀 삭제·비활성화 없음.
