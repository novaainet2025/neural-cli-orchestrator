# team_gov-command-collaboration cycle4 — CB/Gate 룰 갱신 판정 + False Report 교차검증

- 작성: 중복에러방지팀, 2026-07-28
- 대상: `team_gov-command-collaboration` (Collaboration Mesh and Protocol)
- 코드 기준: HEAD `18ccf07` (작업 트리 src/ diff 0)
- 라이브 기준: pm2 `nco-backend` pid 18727, created `2026-07-27T20:31:22.888Z`, `/health` 200
- 성격: **읽기 전용 감사 + 반사실 A/B**. src/ 코드 변경 0, 제외 규칙 추가 0, CB 임계치 변경 0.

---

## 0. 결론 요약

| 항목 | 판정 |
|---|---|
| ① 지시문 값(83.4 / 87.5% / 48h·n=8) | **일치 (stale 아님)** — 라이브 API·HEAD 재계산 모두 동일 |
| ② PROVIDER_AUTH_EXCLUSION(4bccaf6) 라이브 동작 | **동작 확인** — `task_4aq6FQ3yZuXoiTdK` 1건 제외 중, off 시 74.9/C/77.8%로 복귀 |
| ③ 볼륨-룰 면제(18ccf07)의 타 팀 점수 부작용 | **구조적으로 0** — 스코어러는 mesh 테이블을 전혀 참조하지 않음 |
| False Report | **허위 0건**, 과장 표현 1건(시제) |
| 최종 권고 | **이번 사이클 룰 무변경**. 단 18ccf07은 *편익 미관측 + 비용 실측* 상태이므로 다음 사이클에 대안 D(범위 축소)로 재조정 권고 |

---

## 1. 룰 변경표

**이번 사이클 변경 0건.** 아래는 현재 룰 상태와 그 근거를 실 ID로 고정한 것이다.

| 룰 ID | 위치 | 이전 | 이후 | 근거 (실 task_id / msg_id) | 이번 사이클 조치 |
|---|---|---|---|---|---|
| `PROVIDER_AUTH_EXCLUSION` | `src/core/team-scorer.ts:445-470` | 3개 표면형 (envelope401 / plain-claude / plain-cursor) | **변경 없음** | `task_4aq6FQ3yZuXoiTdK`(gcc, envelope401) 외 DB 전체 10건 — §3 표 | 무변경 (동작 재확인만) |
| `SPAWN_FAILURE_EXCLUSION` | `src/core/team-scorer.ts:364` | — | **변경 없음** | 영향 팀 1개(`team_content-planning`) | 무변경 |
| `ZERO_OUTPUT_COMPLETED_EXCLUSION` | `src/core/team-scorer.ts:388` | — | **변경 없음** | 영향 팀 1개(`team_content-planning`, 감점 방향) | 무변경 |
| `echo-loop` (볼륨) | `collaboration-loop-guard.ts` `maxRepeatsPerWindow=3` / `windowMs=60000` | 임계치 3 | **임계치 변경 없음** — 발신자 면제만 (18ccf07) | `msg_IsvWF493OkvSUfOt`·`msg_v3ziqCbmyw8Yets8`·`msg_ZD9LcWyZidRmFA1m`·`msg_7WRzhsZStgKClppG` (동일 본문 4회 / 39ms) | 무변경, 범위 재조정 권고 |
| `channel-burst` (볼륨) | 동 `maxMessagesPerWindow=20` | 임계치 20 | **임계치 변경 없음** — 발신자 면제만 (18ccf07) | `msg_GnS9RZwXG6gAp-av` 트립 시점 윈도 카운트 **21** (실측) | 무변경, 면제 유지 권고 |
| `protocol-echo` | 동 `maxProtocolRepeatsPerWindow=1` | 임계치 1 | **변경 없음** — 면제 대상 아님 | — | 무변경 |

> 임계치·룰 번호는 모두 `DEFAULT_COLLABORATION_LOOP_CONFIG`(`collaboration-loop-guard.ts:77-84`)에서 직접 읽은 값이다. 창작 값 없음.

---

## 2. ① 지시문 값 대조 — stale 아님 (금번 사이클 최초)

| 출처 | score | grade | completion | n | sample |
|---|---|---|---|---|---|
| 지시문 (HR DIRECTIVE) | 83.4 | — | 87.5% | 8 | 48h |
| 라이브 `GET /api/teams/scores` | **83.4** | B | **87.5** | **8** | 48h |
| HEAD 재계산 (`computeTeamScores`, db/nco.db) | **83.4** | B | **87.5** | **8** | 48h |

**3자 완전 일치.** cycle1~3에서 반복되던 "지시문 stale → 이미 수정된 항목 재보고" 패턴이 이번에는 발생하지 않았다. 즉 cycle4 지시문은 `4bccaf6` 반영 후의 값이며, **이 사이클에서 "83.4/87.5%가 미수정 상태"라고 재보고하면 그것이 False Report가 된다.**

48h 원장 11건 → 제외 3건 → terminal n=8, completed 7 → 7/8 = 87.5%:

| task_id | status | assigned_to | 계상 | 제외 룰 |
|---|---|---|---|---|
| task_e3jyQHHLBEqMBCCs / dzPRXYhaMk3AzhlQ / oa1quZNQZJqF1j3w / kJ9xKYxyAwN9unr1 / 8raTpdLuY_zByKPG / B_Guy1kIMJpE8ry1 / kEK9y3-dIjcFDH9d | completed ×7 | ollama/hermes/ollama/opencode/codex/ollama/opencode | 계상 | — |
| task_ZZ88RKyuEpH_T8MV | failed | hermes | **계상(유일한 실패)** | — |
| task_vul5sMk4wNuu-aQB | failed | opencode | 제외 | fanout/silent 계열 |
| task_CmAsfvFiSfqBnsHY | failed | claude-code | 제외 | `INFRA_EXCLUSION` (provider_unavailable) |
| task_4aq6FQ3yZuXoiTdK | failed | opencode | 제외 | **`PROVIDER_AUTH_EXCLUSION`** |

---

## 3. ② PROVIDER_AUTH_EXCLUSION(4bccaf6) 라이브 경로 동작 확인 — 동작함

**반사실 A/B (같은 실 DB, 토글만 변경):**

```
NCO_SCORER_PROVIDER_AUTH_EXCLUSION 미설정(=on) : 83.4 / B / 87.5% / n=8
NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off         : 74.9 / C / 77.8% / n=9
```

라이브 API가 **83.4**를 반환하므로, 서빙 중인 프로세스는 제외가 **켜진** 코드를 실행 중이다. 델타는 정확히 `task_4aq6FQ3yZuXoiTdK` 1건.

**DB 전체 매칭 10건 (표면형별) — 전부 2026-07-27 17:18:57~17:29:48 UTC, 11분 단일 장애 창:**

| task_id | team_id | assigned_to | 표면형 |
|---|---|---|---|
| task_VnTZtkgkcpgPwPhy | hr-incubator-2026-w30 | claude-code | plain-claude |
| task_VrWuAuDGg0Rb0gxO | (null) | opencode | envelope401 |
| task_Zd_RsLbbpyjLTTEU | (null) | opencode | envelope401 |
| **task_4aq6FQ3yZuXoiTdK** | **gov-command-collaboration** | opencode | envelope401 |
| task_u_VTwDmVodFpsNDX | self-learning | cursor-agent | plain-cursor |
| task_IkKQEYErfegOFc6R | self-learning | cursor-agent | plain-cursor |
| task_HWShOuugEQE4gDzh | self-learning | opencode | envelope401 |
| task_Kb_L3S2p8lyFAjGO | (null) | opencode | envelope401 |
| task_KkeE7Ly_A5hC1K2n | (null) | opencode | envelope401 |
| task_p2V_WOaQg3z-gdGx | gov-evolution-learning | opencode | envelope401 |

**과잉 제외 없음 검증:** 팀 귀속 6건(hr-incubator 1 / gcc 1 / self-learning 3 / gov-evolution-learning 1)이 A/B의 n 델타(7→6, 9→8, 94→91, 8→7)와 **정확히 1:1 대응**한다. null-team 4건은 어떤 팀 점수에도 영향이 없다. 즉 이 룰은 문서화된 자격증명 장애 창 밖으로 새지 않는다.

---

## 4. ③ 볼륨-룰 면제(18ccf07)의 부작용 A/B

### 4-1. 타 팀 점수 부작용 — 구조적으로 0

- `src/core/team-scorer.ts`의 `mesh_messages|mesh_sessions` 참조 수 = **0**.
- 스코어러 SQL은 `tasks` / `teams` / `organizations` + `tasks` 자기조인 2개(`DELIVERED_WORK_REPORTS_JOIN`, `WORK_REPORT_FANOUT_ALL_FAILED_JOIN`)만 읽는다(`team-scorer.ts:484-551`).
- 따라서 mesh 전달 가드가 무엇을 막든 **점수 산식에 직접 경로가 없다.** "제외 과다로 인한 점수 인플레"는 이 변경에서 발생할 수 없다.

### 4-2. 편익은 라이브에서 미관측

- 가드 배선(`cli-mesh.ts:406`)은 `11631c1`(2026-07-27T15:29:58Z)에 들어갔다.
- 배선 이후 mesh 트래픽 **179건**(15:30:06Z~21:29:39Z). 이 구간의 채널당 최대 60초 메시지 수 = **6**(임계 20), 동일 본문 최대 반복 = **1**(임계 3).
- 라이브 로그(`nco-backend-out-0.log`, 220MB)에서 `collaboration-msg-loop guard` / `collaboration_loop_blocked` 출현 = **0회**.
- → **가드는 배선 이후 실제로 단 1건도 차단한 적이 없다.** 면제가 구하는 통지는 관측 구간에 존재하지 않는다.

### 4-3. 비용은 실측됨

| 시나리오 | 차단 | 내역 |
|---|---|---|
| 4bccaf6 (면제 전) | 7 | channel-burst 5 + echo-loop 2 |
| 18ccf07 + `NCO_MESH_LOOP_GUARD_NOTIFIERS=off` | 7 | 위와 **바이트 동일** (sha256 `3d373d76…1b0892`) |
| 18ccf07 (면제 on) | **0** | 볼륨 룰 전체 휴면 |

7건 중 **1건은 진짜 중복 팬아웃**이다: `msg_IsvWF493OkvSUfOt`(.306Z) → `v3ziqCbmyw8Yets8`(.334Z) → `ZD9LcWyZidRmFA1m`(.339Z) → `7WRzhsZStgKClppG`(.345Z), 본문 전부 `❌ [task] codex 완료 (1501.3s)` 동일, 39ms 간격. 면제는 이 탐지도 함께 끈다.

48h 창 발신자 분포는 `nco-system` **1007** / `codex-api-root` 1 → 면제 대상이 트래픽의 99.9%이므로 볼륨 룰은 사실상 전면 휴면이 된다.

### 4-4. 부수 발견 — 제외 룰의 maxN 결합 (신규, 조치 불요)

`PROVIDER_AUTH_EXCLUSION` A/B에서 68개 팀 중 **44개**의 점수가 움직였다. 그러나 자기 태스크가 실제로 제외된 팀은 4개뿐이다:

| 팀 | off → on | n | 등급 |
|---|---|---|---|
| gov-command-collaboration | 74.9 → **83.4** | 9→8 | C→B |
| gov-evolution-learning | 83.3 → 94.3 | 8→7 | B→A |
| hr-incubator-2026-w30 | 81.4 → 94.0 | 7→6 | B→A |
| self-learning | 82.8 → 85.2 | 94→91 | B→B |

나머지 **40개 팀은 n·completion 불변인데 점수만 ±0.1** 움직였다. 원인은 `self-learning`의 n이 줄면서 전역 `maxN`이 94→91로 바뀌고, `computeVolume(n, maxN)`이 모든 팀에 공유되기 때문이다(`team-scorer.ts:554-558`). 즉 **한 팀의 제외가 모든 팀 점수를 미세하게 흔든다.**

- 최대 진폭 **0.1점**, 등급 변동 **0건**(전부 A→A) → 이번 사이클 조치 불요.
- 다른 두 룰은 결합이 없었다(`maxN` on=off=91): `SPAWN_FAILURE` 영향 1팀(content-planning 72.1→81.4), `ZERO_OUTPUT` 영향 1팀(content-planning 94.3→**81.4**, 감점 방향 = 인플레 억제 룰).

---

## 5. False Report 교차검증

| # | 주장 (출처) | T1 증거 | 판정 |
|---|---|---|---|
| 1 | cycle3 "mesh 3018건 중 844건(27.97%) 오탐 차단" | 고정 창 `julianday` 리플레이: msgs=1008, blocked=**7** | **거짓 — 이미 자가개선팀이 자진 철회함.** 재사용 금지 |
| 2 | 자가개선팀 "정확한 48h 창에서 차단은 7건" | 독립 리플레이 재현: `msgs=1008 allowed=1001 blocked=7`, `by_rule={"channel-burst":5,"echo-loop":2}` | **참** |
| 3 | 자가개선팀 "A/B 바이트 동일, sha256 3d373d76…1b0892" | 4bccaf6 모듈 vs HEAD+`NOTIFIERS=off` 재실행 → `diff` exit 0, 양측 sha256 `3d373d7624725596ff5b3b67a46936936fd51669451b12fc7d819a45521b0892` | **참 (독립 재현)** |
| 4 | 자가개선팀 "channel-burst 21msg/60s" | 트립 메시지 `msg_GnS9RZwXG6gAp-av`(01:15:57.139Z) 기준 직전 60초 동일 채널 카운트 = **21** | **참** |
| 5 | 자가개선팀 "echo-loop = 동일 본문 4회/39ms 진짜 중복" | 02:17:42.306~.345Z 4행, 본문 동일 | **참** |
| 6 | 자가개선팀 "48h 트래픽 1007/1008이 nco-system" | `GROUP BY from_session` → nco-system 1007, codex-api-root 1 | **참** |
| 7 | 자가개선팀 "**실제 유실은** 정상 통지 6건 차단 + 진짜 중복 1건 탐지**였습니다**" | 7건 전부 `mesh_messages`에 **존재**. 가드는 history insert **이전**에 차단(`cli-mesh.ts:403-419`, `historyRecorded:false`). 또한 7건(07-27 01:15~02:17Z)은 가드 배선 `11631c1`(15:29:58Z)보다 **13시간 이상 앞선다**. 라이브 로그 차단 기록 0건 | **과장 — 반사실이지 실유실 아님.** 수치는 정확, 시제가 사실을 넘어섬 |
| 8 | 자가개선팀 "라이브 프로세스는 여전히 pre-fix" | 프로세스 created `20:31:22Z` < `dist/security/collaboration-loop-guard.js` mtime `21:29Z`(=06:29 KST) | **참** |
| 9 | 지시문 "score=83.4, completion=87.5%, 48h/8" | 라이브 API·HEAD 재계산 모두 동일 | **참 (stale 아님)** |
| 10 | cycle3 "hermes Tool Escape" 판정 | (본 사이클 미재검) | **미검증** |

**허위 보고 0건.** 유일한 결함은 #7의 시제 과장이며, 근거 수치 자체는 전부 재현되었다. 자가개선팀이 cycle3 자기 수치(#1)를 스스로 철회한 것은 정상 동작으로 기록한다.

**이번 사이클 신규 중복 에러 위험:** ①이 stale이 아니므로, 후속 단계가 "83.4/87.5% 미수정" 또는 "PROVIDER_AUTH_EXCLUSION 미적용"을 다시 근본원인으로 올리면 그것이 곧 중복 False Report다.

---

## 6. 최종 권고

### 이번 사이클: **룰 무변경**

- 스코어러 제외 3종 모두 실 task_id 근거로 정확히 대응하며 과잉 제외 없음 → 추가·삭제 근거 없음.
- CB/가드 임계치(3 / 20 / 1 / 60s)를 바꿀 실데이터 근거 없음 → 창작 변경 금지 원칙에 따라 무변경.
- `18ccf07`은 이미 커밋되었고 A/B 바이트 동일 롤백이 검증되어 있으므로 **되돌릴 필요 없음**(리스크 = 볼륨 룰 휴면뿐, 점수 경로 없음).

### 다음 사이클 1순위: 면제 범위 축소 (대안 D)

면제를 `channel-burst`에만 적용하고 `echo-loop`은 발신자 무관하게 유지한다.

- 근거: 편익(정상 통지 구제)은 라이브 미관측이지만 **비용(§4-3의 진짜 중복 팬아웃 4회 탐지 상실)은 실측**되었다. 현재 비대칭이 불리하다.
- 같은 창에서 대안 D 측정치는 차단 2건(정상 통지 5건 구제 + 중복 탐지 유지) — 자가개선팀 측정, 본 팀 미재현이므로 **적용 전 재측정 필요**.
- 이 변경은 CB 임계치가 아니라 면제 **범위**만 건드리므로 롤백 경로(`NCO_MESH_LOOP_GUARD_NOTIFIERS`)가 그대로 유효하다.

### 부수 권고 (본 팀 범위 밖, 실행하지 않음)

- `18ccf07` 라이브 반영에는 `pm2 restart nco-backend`가 필요하다. 현 프로세스는 pre-fix 모듈을 들고 있다. 단 §4-2대로 **점수 영향은 없다.**
- `maxN` 전역 결합(§4-4)은 진폭 0.1·등급 변동 0이라 지금은 무해하나, 향후 제외 룰이 최대 n 팀(`self-learning`, n=91)을 크게 깎으면 전 팀 점수가 동시 이동한다. 룰 추가 시 A/B에서 `maxN` 변화를 함께 볼 것.

---

## 7. 미검증 항목

- cycle3 "hermes Tool Escape" 판정의 재검증 (본 사이클 범위 밖).
- 대안 D의 차단 2건 수치 — 자가개선팀 측정치이며 본 팀이 독립 재현하지 않았다.
- 48h 고정 창(`upper=2026-07-27T20:50:00Z`) 밖의 mesh 트래픽 패턴, 다중 통지원 환경에서의 과잉 면제 폭.
- 가드 배선 이후 라이브 차단 0건이 "가드가 활성인데 트립 조건 미도달" 때문인지 "해당 dist가 로드되지 않음" 때문인지는 구분 불가 — 배선 후 트래픽이 임계 근처에도 가지 않아(최대 6/20, 반복 1/3) 판별 자극 자체가 없었다.
- `task_vul5sMk4wNuu-aQB`(silent-failure)가 어느 제외 룰로 빠지는지 룰 단위로 분해하지 않음(총합 n=8은 일치 확인).

---

## 8. 재현 명령

```bash
# ① 지시문 대조
curl -s http://localhost:6200/api/teams/scores | grep -o '{[^}]*gov-command-collaboration[^}]*}'
npx tsx .gcc-score.mts

# ② PROVIDER_AUTH 반사실
NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off npx tsx .gcc-score.mts

# ③ 전팀 블라스트 레이디어스 (읽기 전용)
TOGGLE=NCO_SCORER_PROVIDER_AUTH_EXCLUSION       npx tsx data/error-prevention/_c4-scorer-ab.mts
TOGGLE=NCO_SCORER_SPAWN_FAILURE_EXCLUSION        npx tsx data/error-prevention/_c4-scorer-ab.mts
TOGGLE=NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION npx tsx data/error-prevention/_c4-scorer-ab.mts

# 가드 A/B (4bccaf6 vs HEAD)
git show 4bccaf6:src/security/collaboration-loop-guard.ts > /tmp/c4ab/guard-4bccaf6.ts
GUARD_MODULE=/tmp/c4ab/guard-4bccaf6.ts npx tsx data/error-prevention/_c4-ab-replay.mts
GUARD_MODULE=$PWD/src/security/collaboration-loop-guard.ts NCO_MESH_LOOP_GUARD_NOTIFIERS=off \
  npx tsx data/error-prevention/_c4-ab-replay.mts
```
