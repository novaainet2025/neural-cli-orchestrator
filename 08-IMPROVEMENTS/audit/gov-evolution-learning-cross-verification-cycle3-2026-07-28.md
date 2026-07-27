# 중복에러방지팀 — team_gov-evolution-learning (Continuous Learning) cycle 3/3

- 감사일: 2026-07-28 (05:10~05:25 KST)
- 역할: 중복에러방지팀 (Code Reviewer)
- 하위작업: **Circuit Breaker/Gate 룰 갱신(중복 에러 방지) + False Report 교차검증(보고 신뢰도)**
- HEAD: `d1a23ce` · 라이브 백엔드 pm2 `nco-backend` (2026-07-28T05:00:24 기동)
- DB 스냅샷: `/tmp/nco-c3-dup.db` (`db/nco.db` 읽기전용 복사본)
- 산출물: 본 파일 + `gov-evolution-learning-gate-update-cycle3.json` + `src/security/circuit-breaker.test.ts` (+7 tests)

---

## 0. 결정 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| CB `failureThreshold` 변경 | **NO** (3사이클 연속) | 팀 내부 중복 버스트 0건, fleet 반복 상위 5종 전부 기존 제외절 커버 |
| Command Gate 변경 | **NO (diff 0)** | 48h 실패 중 shell 정책 위반 0건 |
| 봉투 게이트 `GATE-LEARN-R1` 규칙 | **동결 (변경 없음)** | 실측 오탐 0 — 아래 §2 blast radius |
| 신규 `GATE-LEARN-R4` | **테스트로 규칙 고정** (+7, test-only) | cycle2 Medium 지적 미해소 + cycle3 패치로 오탐 모수 증가 |
| 이전 단계(자가개선팀) False Report | **0건 — GENUINE_FIX / NOT_FABRICATED** | 8개 클레임 전부 독립 T1 재현 (§3) |
| HR 지시문 `83.4 / 87.5% / 48h·8` | **STALE** | 라이브 `GET /api/teams/scores` = **94.3 / A / 100% / n=7** |

---

## 1. 48h 실패 패턴 (T1, `tasks` 행)

팀 태스크 10건 — completed 7 / failed 3, **cycle2 감사 이후 신규 실패 0건**(마지막 실패 `2026-07-27 17:29:48`).

| task_id | status | agent | spawned_by | error |
|---|---|---|---|---|
| `task_3eejRUftHpUXmdOH` | failed | opencode | work-report-scheduler | `silent-failure: empty output` |
| `task_IjCXiEO-3LT65aIS` | failed | claude-code | work-report-scheduler | `provider_unavailable: claude-code (open/generic)` |
| `task_p2V_WOaQg3z-gdGx` | failed | opencode | **team-runner** | `opencode: CLI failed exit=1` + `response` 401 봉투 |

**팀 내부 동일 시그니처 중복: 0건** (3종이 각 1건).

fleet 48h 중복 버스트 상위(동일 error 문자열 ≥2):

```
queue_wait_timeout: provider claude-code busy      66행 / 32팀   → INFRA_EXCLUSION
orphaned: server restart (poison — requeued 2x)    53행 / 26팀   → INFRA_EXCLUSION
Circuit breaker open for agent claude-code         32행 / 30팀   → INFRA_EXCLUSION
provider_unavailable: opencode / cursor-agent      12+12행       → INFRA_EXCLUSION
opencode: CLI failed exit=1                         8행 /  3팀   → GATE-LEARN-R1 대상
```

→ **임계치를 낮출 근거도 높일 근거도 없다.** 미커버 반복 패턴 0건.

---

## 2. GATE-LEARN-R1 (봉투 게이트) — 배포 상태 + blast radius 실측

cycle2에 작성된 규칙이 이번 사이클에 **커밋(`a8c285a`)되어 라이브 서빙 중**이다:
`dist/security/circuit-breaker-registry.js`에 심볼 2회 존재, `nco-backend` 05:00:24 재기동(커밋 이후).

HEAD 코드를 그대로 임포트해 실제 `tasks.response` 전수에 재생(`.c3-learn-envelope-blastradius.mts`, read-only):

```
=== ALL-TIME ===
rows with response      : 12676
envelope-classified     : 7
  on failed/error rows  : 7   (already CB-classified via error col: 0 → NEW immediate-open 7)
  on completed rows     : 0   (FALSE POSITIVES)
=== 48h ===  동일 7건
NCO_CB_ERROR_ENVELOPE=off  -> classified: 0
completed rows QUOTING auth strings: 62  -> misclassified by gate: 0
```

- 잡히는 7건은 **전부 failed**, 전부 2026-07-27 17:19~17:29의 opencode 자격증명 장애 창(그중 1건이 이 팀의 `task_p2V_WOaQg3z-gdGx`).
- `error` 컬럼만으로는 7건 모두 미분류(=0) → 게이트가 없으면 임계치 3까지 **반복 프로브를 계속 소모**한다. 게이트의 실효는 "첫 하드-401에서 즉시 개방"이며 그 대가는 **오탐 0**.
- 팀 산출물이 401 문자열을 *인용한* 62건은 한 건도 매칭되지 않는다 — `{`…`}` 전체 JSON + `type==='error'` 가드가 실효.
- 토글 off는 완전 no-op(0건) → 되돌리기 무비용.

**따라서 규칙 자체는 변경하지 않는다.** 다만 이 오탐 0은 *가드 3중 구조에 전적으로 의존*하는데, cycle2 감사가 지적한 대로 전용 테스트가 0이었다.

### GATE-LEARN-R4 (이번 사이클 신규) — 규칙을 테스트로 고정

`src/security/circuit-breaker.test.ts`에 `describe('classifyProviderErrorEnvelope (NCO_CB_ERROR_ENVELOPE)')` 7케이스 추가. 픽스처는 실제 DB 행 `task_p2V_WOaQg3z-gdGx`의 `response` 형태를 그대로 쓴다.

| # | 케이스 | 기대 |
|---|---|---|
| 1 | 실제 하드-401 봉투 | `immediateOpen=true`, `reason='generic'`(영구 개방 회피), `resetTime=null` |
| 2 | 토글 `off`/`false`/`0` | `null` (엄격 no-op) |
| 3 | 401을 **인용한 보고서 본문**, ```` ```json ```` 펜스 | `null` |
| 4 | 비파싱 / 배열 / `type!=='error'` | `null` |
| 5 | 8192자 초과 (팀 산출물) | `null` |
| 6 | 비화이트리스트 키(`summary`/`body`)에만 auth 신호 | `null` |
| 7 | quota/429 봉투 | `null` (이번 범위 밖 설계) |

왜 지금인가: **cycle3 자가개선 패치가 실패 `error` 문자열을 프롬프트에 주입하기 시작**하므로 "auth 문자열을 인용한 산출물" 모수가 구조적으로 늘어난다(현재 62건). 가드가 회귀하면 오탐이 fleet 전역 회로 오개방으로 번진다. 규칙 변경 없이 **회귀 방어선만** 추가한 이유다.

결과: `npx vitest run src/security/circuit-breaker.test.ts` → **16 passed (기존 9 + 신규 7)**. 런타임 동작 변경 0.

---

## 3. False Report 교차검증 — 이전 단계(자가개선팀, `task_ydnyeAruzAGtfKZq`)

`false_reports` 테이블 `COUNT(*) = 0` (T1, 기록 경로 미축적은 cycle1부터 동일).
아래는 이전 단계 보고의 8개 클레임을 **본 세션에서 독립 재현**한 결과다.

| # | 클레임 | 판정 | 등급 | 재현 근거 |
|---|---|---|---|---|
| C1 | `scripts/team-runner.sh` +79/-0 | PASS | T1 | `git diff --stat` → `79 +++…`, 1 파일 |
| C2 | cycle3 근거 문서 신규 | PASS | T1 | 6035B, 05:06 |
| C3 | 라이브 94.3/A/100%/n=7 | PASS | T1 | `GET :6200/api/teams/scores` 본문 |
| C4 | 팀 태스크 전부 `[learning_task_evidence]` 0회 | PASS | T1 | `COUNT(*)=10, with_evidence=0` |
| C5 | 최근 3건 `team-runner` + workReportId 없음 | PASS | T1 | tasks 행 + `json_extract(metadata_json,'$.workReportId')` 빈값 |
| C6 | 빌더 1926B/0줄 → 10353B/증거 10줄, off 바이트 동일 | PASS(재현, 수치 차이) | T1 | 본 세션 재현: **ON 10203B, task 5줄+event 5줄 / OFF 1631B, 0줄** |
| C7 | 타 팀 프롬프트 무회귀 | PASS | T1 | 5팀 HEAD vs 패치 빌더 출력 `cmp` 동일 |
| C8 | tsc 0, 709 passed/1 failed(선행 실패) | PASS | T1 | 본 세션 tsc `exit=0`, vitest **716 passed / 1 failed** |

**재현 방법(C6·C7)** — 러너의 파이썬 heredoc을 그대로 떼어내 두 버전으로 실행:

```bash
sed -n '98,415p' scripts/team-runner.sh            > builder.py       # 패치본
git show HEAD:scripts/team-runner.sh | sed -n '98,336p' > builder-head.py  # HEAD
python3 builder.py      ollama team_gov-evolution-learning runnable.json . tmp > body-on.json
NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT=off python3 builder.py ... > body-off.json
python3 builder-head.py ollama team_gov-evolution-learning runnable.json . tmp > body-head.json
cmp body-head.json body-off.json   # → byte-identical
```

- ON 프롬프트에 실제 DB 행이 들어간다: `id=task_p2V_WOaQg3z-gdGx, 상태=failed, 오류=opencode: CLI failed exit=1 …`, `event=failover_dispatch / escalation` 등.
- **되돌리기 검증**: HEAD 빌더 출력과 "패치+플래그 off" 출력이 **바이트 동일**(1631B) → 플래그가 진짜 무비용 롤백이다.
- **무회귀**: self-improvement 2618B · cfo 1836B · analytics-lead 1685B · content-planning 1784B · gov-assurance-audit 1627B — 5팀 전부 HEAD와 동일.

C6의 절대 바이트 수가 이전 보고(10353/1926)와 다른 것은 **48h 창이 약 1시간 이동**해 표본 프롬프트 길이가 달라진 것으로, 성격(증거 0줄 → 10줄)은 동일하다. 수치 불일치를 은폐하지 않고 본 세션 실측값을 그대로 쓴다.

C8의 유일한 실패 `tests/근거.test.ts > 최신 포인터가 오늘 날짜를 가리킨다`(`expected '2026-07-27' to be '2026-07-28'`)는 이전 단계가 stash 후 동일 재현으로 **선행 실패**임을 보였고, 본 세션 변경(`src/security/circuit-breaker.test.ts`)과 무관하다. 716 = 709 + 신규 7로 정확히 정합.

**결론: 허위 완료 주장 0건. 이전 단계 보고는 GENUINE_FIX / NOT_FABRICATED.**

---

## 4. 미검증 / Gap (~12%)

1. **GATE-LEARN-R1 런타임 E2E 미관측** — 게이트 배포(커밋 04:39, 재기동 05:00) 이후 fleet 실패 행 **0건**이라 실제 즉시 개방 사례가 아직 없다. 관측 포인트: `circuit_states.opencode`의 `reason`/`opened_at`.
2. `scripts/team-runner.sh` 신규 분기는 쉘 heredoc 내 파이썬이라 vitest 커버리지 밖 — §3의 수동 재현 절차로 대체.
3. 실제 team-runner cron이 만든 태스크 행에서의 증거 반영은 다음 실행 시점부터 확인 가능.
4. 본 사이클 변경 **미커밋**(사용자 소관).

참고(운영): `circuit_states.openai = open / auth / failure_count=1860`, 자가복구 0회 — R1이 `reason='auth'` 대신 `'generic'`을 쓰는 이유의 실증. 수동 reset 필요.

---

## 검증 영수증

- **[변경]** `src/security/circuit-breaker.test.ts` +90줄(신규 describe 7 케이스, test-only) · `08-IMPROVEMENTS/audit/gov-evolution-learning-gate-update-cycle3.json` 신규 · 본 파일 신규 · `.c3-learn-envelope-blastradius.mts` 신규(read-only 프로브, 빌드 제외). **src/ 런타임 코드·스코어러·CB 임계치·DB 미변경.**
- **[검증방법]** `node --import tsx .c3-learn-envelope-blastradius.mts` → all-time 12676행 중 7건 분류·오탐 0·인용본문 62건 미매칭·off 0건 · `npx vitest run src/security/circuit-breaker.test.ts` → 16/16 · `npm run test:run` → 716 passed / 1 failed(선행) · `npx tsc --noEmit` → exit 0 · `curl -s :6200/api/teams/scores` → 94.3/A/100%/n=7 · `sqlite3 /tmp/nco-c3-dup.db` 48h tasks·false_reports·circuit_states 직접 조회 · 빌더 heredoc 3버전 실행 + `cmp`
- **[등급]** T1 (SQLite 행 · HTTP 응답 본문 · 명령 종료코드 · 파일 바이트 비교 직접 확인)
- **[Gap]** 88% — 게이트 런타임 E2E와 cron 실행 반영은 배포 후 해당 이벤트가 아직 발생하지 않아 미관측
- **[미검증항목]** ① GATE-LEARN-R1 실제 401 → 즉시 개방 E2E ② team-runner cron 실행 산 태스크 행의 증거 반영 ③ 증거 주입 후 산출물 품질 변화 ④ 커밋 미수행
- **되돌리기**: `git checkout -- src/security/circuit-breaker.test.ts` (런타임 영향 0) / `NCO_CB_ERROR_ENVELOPE=off` / `NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT=off` / 문서·프로브 파일 삭제. 팀 삭제·비활성화·lifecycle 변경 **없음**.
