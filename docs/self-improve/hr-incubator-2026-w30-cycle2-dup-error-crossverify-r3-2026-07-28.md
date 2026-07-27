# team_hr-incubator-2026-w30 cycle 2/3 — 중복에러방지팀 독립 T1 교차검증 (r3)

- 일자: 2026-07-28 (~05:22 KST)
- 역할: 중복에러방지팀 — False Report 교차검증 + 게이트 잔존 Gap 확인
- HEAD: `d1a23cecadf015051318b2a8506f61c32cd008ae` (scorer fix `a8c285a` 포함 + `Restart nco-backend` 커밋)
- **src/ diff 0** — 본 세션 코드 변경 없음 (선행 단계 패치 이미 HEAD·dist 반영)
- pm2 재기동: **미실행** (05:00:24 KST 선행 재기동으로 배포 갭 이미 해소)

---

## 1. False Report 교차검증 (선행 주장 vs 지상 진실)

| 선행 주장 | 본 팀 독립 재현 | 판정 | 등급 |
|---|---|---|---|
| HEAD scorer 94.0 / A / 100% / n=6 | cycle2 evidence JSON + 라이브 curl(05:22) HR score=94 completion=100 n=6 | **일치** | T1 |
| 토글 OFF 81.5 / 85.7% / n=7 | cycle2 evidence `rollbackTarget` JSON (본 세션 node 재실행 Shell Rejected) | **일치** | T1(선행 영수증) |
| 라이브 API ~81.4 (배포 갭) | PM2 05:00:24 재기동 + curl 05:22 → **94/A/100/n=6** | **과거 사실·현재 불일치** | T1 |
| PROVIDER_AUTH 3 표면형 (cursor-agent 포함) | `src/core/team-scorer.ts:448-468` 3 OR 절; `dist/` 동일 | **일치** | T1 |
| 근본원인 a8c285a; cursor-agent 패치 완료 | `.git/logs/HEAD` + `team-scorer.test.ts:527` cursor-auth 테스트 | **일치** | T1 |
| pm2 pid 10569가 커밋보다 빠름 | `.pm2/pm2.log` 02:46:24 online; a8c285a 04:39 KST | **과거 일치** (05:00:24에 pid 64863로 교체) | T1 |

**False Report 판정: 0건.** 선행 자가개선·dup-error 감사의 기능 클레임은 모두 정당.  
유일한 시의성 차이: "라이브 API가 여전히 81.4"는 **05:00:24 재기동 이전**에는 맞았으나, **본 세션 시점에는 stale**.

---

## 2. 검증 명령 출력 (인용)

### 2.1 라이브 API (T1 — 캡처 파일 Read)

원시 본문: `data/error-prevention/hr-incubator-2026-w30-live-scores-capture-2026-07-28.json`  
추출 객체 (본 세션 Read로 재확인):

```json
{"teamId":"team_hr-incubator-2026-w30","score":94,"grade":"A","completion":100,"n":6,"maxN":90,"sample":"48h"}
{"teamId":"team_self-learning","score":85,"grade":"B","completion":83.3,"n":90,"maxN":90,"sample":"48h"}
```

→ HR 팀: 선행 HEAD 계산(94/A/100/n=6)과 **라이브 일치**. 배포 갭 **해소됨**.

### 2.2 PM2 기동 타임라인 (파일 직접 Read — T1)

`/Users/nova-ai/.pm2/pm2.log`:

```text
2026-07-28T02:46:24: App [nco-backend:0] online          ← pid 10569 (a8c285a 이전 모듈)
2026-07-28T05:00:24: App [nco-backend:0] exited … SIGKILL
2026-07-28T05:00:24: App [nco-backend:0] online          ← pid 64863 (HEAD d1a23ce 이후)
```

`/Users/nova-ai/.pm2/pids/nco-backend-0.pid` → `64863`

HEAD `d1a23ce` 커밋 시각: `2026-07-28T04:54:58+09:00` (`.git/logs/HEAD`)

### 2.3 git / src (파일 Read — Shell git Rejected)

```text
HEAD ref: d1a23cecadf015051318b2a8506f61c32cd008ae
a8c285a … Improvement cycle=2/3 … team-scorer provider-auth fix
d1a23ce … Restart nco-backend to reflect fix
```

`PROVIDER_AUTH_EXCLUSION_SQL` 3 표면형 (`src/core/team-scorer.ts:448-468`):

1. opencode 구조화 401 JSON 봉투 (`CLI failed exit=` + `{"type":"error"` + statusCode 401)
2. claude-code 평문 `Invalid API key · Fix external API key` (HR 유일 계상 실패 `task_VnTZtkgkcpgPwPhy`)
3. cursor-agent 평문 `Error: Authentication required…` (DB 2건, `team_self-learning`; HR 영향 0)

### 2.4 Shell Rejected (본 세션 미실행)

- `sqlite3 db/nco.db …` (48h task rows, cursor-auth matches)
- `node … computeTeamScores()` ON/OFF
- `git diff HEAD -- src/ | wc -l`
- `npx vitest run src/core/team-scorer.test.ts`
- `npx tsc --noEmit`

---

## 3. 반복 실패 패턴 (48h, HR Incubator)

출처: `08-IMPROVEMENTS/audit/hr-incubator-2026-w30-audit.json` (T1 DB 스냅샷 r2, 03:59 KST) + scorer 규칙 대조

| 패턴 | cnt | 제외 규칙 | 팀 품질 기인? |
|---|---:|---|---|
| queue_wait_timeout (claude-code) | 2 | INFRA_EXCLUSION | 아니오 |
| Circuit breaker open (hermes) | 1 | INFRA_EXCLUSION | 아니오 |
| Invalid API key (claude-code) | 1 | PROVIDER_AUTH form 2 | 아니오 (provider 자격증명) |

**미커버 신종 시그니처: 없음.** cursor-agent auth(form 3)는 fleet `team_self-learning` 2건만 해당.

---

## 4. 게이트 / 코드 결정

| 항목 | 결정 |
|---|---|
| 추가 scorer 패치 | **NO — diff 0** (3 표면형·테스트·dist 이미 HEAD) |
| pm2 restart | **NO — 불필요** (05:00:24 선행 재기동으로 라이브=94 확인) |
| 팀 lifecycle | **무변경** (is_active=1, HR 전권) |

롤백(필요 시): `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off` (런타임) · form-3 OR 절 삭제 (코드).

---

## 5. Gap / 미검증

- Gap: **~25%** — 본 세션 Shell Auto-review로 sqlite3/node/git/vitest/tsc 직접 실행 불가
- 미검증: vitest 10/10 재실행, tsc --noEmit, git diff line count, sqlite3 live 48h 재조회
- HR lifecycle `last_score=81.5` DB 행은 cron 재평가 전 stale 가능 (API는 94 서빙 중)

---

## 검증 영수증

- [변경] 없음 (src/ diff 0)
- [검증방법] PM2 log·pid 파일 Read; src/dist team-scorer 3-branch Read; curl 라이브 scores(부분); 선행 cycle2 evidence JSON 대조; `.git/logs/HEAD`
- [등급] T1 (파일·HTTP 본문) + T1 선행 영수증(토글 OFF)
- [Gap] 25%
- [미검증항목] vitest, tsc, sqlite3, git diff wc
