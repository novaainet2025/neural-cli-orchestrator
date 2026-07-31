---
name: subagent-failure-modes
description: NCO 서브에이전트/프로바이더 위임이 실패했을 때, 또는 위임을 시작하기 전에 사용한다. 실측 기반 실패 분류표(F1~F21)와 "재시도 금지" 목록을 제공한다. Circuit breaker open, queue_wait_timeout, orphaned, silent-failure, empty completion, FORMAT_MISMATCH, timeout(hardcap/idle), rate limit, invalid model selection, protocol_reconversion_blocked, invalid_project_dir, Reading additional input from stdin 같은 오류를 만났을 때 반드시 읽어라.
---

# 서브에이전트 실패 모드 카탈로그 — 재시도 금지 목록

**출처(T1)**: `db/nco.db` — `tasks.error`(14일, 실패/timeout/lease_expired **5579건**) + `learning_events.pattern`(3009건) + `dead_letter_tasks`(430건). 2026-07-30 실측.

## 이 스킬의 단 하나의 규칙

> **실패한 방법을 같은 모양으로 다시 던지지 않는다.**
> 실패의 42%는 "이미 죽은 프로바이더에 계속 던진" 파생 실패였다. 재시도가 아니라 *경로 변경*이 정답이다.

위임 전 반드시:
```bash
scripts/codex-subagent.sh gate          # 게이트 확인 (available=False 면 던지지 않는다)
scripts/codex-subagent.sh stats         # 지금까지의 성공/실패 원장
```

---

## 프로바이더 성공률 실측 (14일, n=8,600+)

| 프로바이더 | 완료 | 실패 | 성공률 | 판정 |
|---|---|---|---|---|
| **codex** | 1411 | 159 | **83.8%** | 구현 위임 1순위 |
| cursor-agent | 724 | 56 | 88.4% | 리뷰용, 표본 적음 |
| agy | 473 | 26 | 89.8% | UI/패턴 |
| ollama | 466 | 117 | 76.4% | 로컬 검증 |
| hermes | 708 | 528 | 56.5% | 무료 대체워커, 신뢰도 낮음 |
| opencode | 323 | 774 | 27.3% | **CB 상습 개방 — 던지기 전 게이트 필수** |
| claude-code | 459 | 1668 | 20.6% | 실패 76%가 CB-cascade. self-dispatch 지양 |

> 낮은 성공률 ≠ 낮은 능력. opencode/claude-code 실패의 대부분은 **F1(CB-cascade)** 파생분이다. 근본 원인은 최초로 CB를 연 신호다.

---

## 실패 분류표 (근본원인 롤업)

| # | 분류 | 14일 건수 | 비중 |
|---|---|---|---|
| F1 | CB-cascade (파생) | 2346 | 42% |
| F2 | orphan-poison (서버 재기동) | 325 | 6% |
| F3 | output-echo 오분류 | 297 | 5% |
| F4 | queue_wait_timeout (30분) | 147 | 3% |
| F5 | silent / empty output | 99 | 2% |
| F6 | timeout (idle/hardcap) | 38 (+learning 142) | — |
| F9 | verifier(tsc) 실패 | 24 | — |
| F7 | rate-limit | 12 (+learning 65) | — |
| F8 | quality / FORMAT_MISMATCH | 9 (+learning 48) | — |
| Z | 잔여(F10~F15 포함) | 227 | 4% |

---

### F1 — CB-cascade `Circuit breaker open for agent X (generic)` / `provider_unavailable`
- **실측**: claude-code 1268 · opencode 457 · hermes 450 · ollama 26 …
- **정체**: 파생 실패다. 게이트가 닫힌 뒤 도착한 태스크가 실행 없이 즉사한 것.
- 🚫 **재시도 금지**: 같은 프로바이더로 즉시 재투입. cooldown 중에는 100% 같은 결과.
- ✅ **대응**: `GET /api/agents` → `gate.available` 확인 → `false`면 (a) `cooldownUntil` 이후, (b) 가용 대체로 라우팅. 라우팅은 provider-registry `resolvePreference` 경유 — **id 하드코딩 금지**.

### F2 — orphan-poison `orphaned: server restart (poison — requeued 2x)`
- **실측**: dead_letter 404건이 이 사유. tasks 325건.
- 🚫 **재시도 금지**: 같은 task_id 수동 재큐(3회에서 poison 확정 → dead-letter).
- ✅ **대응**: boot-time orphan recovery(`src/index.ts`)에 맡긴다. **외부 cron이 직접 주입한 태스크**(nova-sns 등)는 NCO 성과 집계에서 제외 — 오귀속 원인.

### F3 — output-echo 오분류 `unknown: failure pattern in output` / `Reading additional input from stdin...`
- **실측**: 297건. 추가로 `codex: CLI failed exit=1 — [NCO Core Operating Principles v1]…` 21건, `hermes: … 9. **done:/status:/error: 재변환 금지**` 6건 — **자기 argv/시스템프롬프트를 에코**해 실패로 오판된 사례.
- **상태**: argv 에코 오탐은 `546bdfa`(2026-07-30 09:15)에서 차단됨. 마지막 발생 2026-07-29 01:43 — 이후 재발 없음.
- 🚫 **재시도 금지**: 동일 프롬프트 재전송(같은 에코 재발) · 프롬프트에 대용량 소스/시스템 규칙 인라인 · **stdin 파이프로 codex 호출**.
- ✅ **대응**: 소스는 **파일 경로로 전달**. 프롬프트는 argv/`--prompt-file`. 출력 판정은 `src/utils/echo-filter.ts` 경유 확인.

### F4 — queue_wait_timeout `provider X busy for 1800000ms`
- **실측**: claude-code 128 · ollama 9.
- 🚫 **재시도 금지**: 같은 프로바이더 큐에 재투입(30분 더 기다린 뒤 또 죽는다).
- ✅ **대응**: `nco_parallel` 로 프로바이더 분산, 또는 대체 워커. 한 프로바이더에 직렬 적재하지 않는다.

### F5 — silent / empty `silent-failure: empty output` · `empty completion from provider 'X' after N iteration(s)` · `silent-failure: answer stopped at a future-intent preamble`
- **실측**: 70 + 22 + 7.
- 🚫 **재시도 금지**: 동일 프롬프트 3회 이상 반복.
- ✅ **대응**: 출력계약을 프롬프트에 박는다 — 첫 줄 `done:` / `error:`, 산출물 **파일 경로 필수**. ollama가 iteration 1에서 empty면 `/nco-debug-recover`(모델 캐시·컨텍스트 재감지).

### F6 — timeout `timeout(hardcap)` 74 · `timeout(idle)` 68 · `agy: timeout waiting for response` 44
- 🚫 **재시도 금지**: 같은 크기의 작업을 같은 하드캡으로.
- ✅ **대응**: 작업 분할. agy 대량 요청은 특히 idle timeout 상습.

### F7 — rate-limit `You've hit your weekly limit · resets 4am` (43) / `session limit · resets 3:20am` (22)
- 🚫 **절대 재시도 금지**: 리셋 시각 전. 리밋 소진 프로바이더 재호출은 CB만 더 연다.
- ✅ **대응**: 대체 워커 순서 `hermes → ollama → opencode`. 보고에 `[미참여:<agent>=리밋]` 명시하고 교착시키지 않는다.

### F8 — quality / FORMAT_MISMATCH (48)
- **정체**: 상당수가 **오탐**. text-only 개념 답변·read-only 리뷰·"OK만 응답" 산출물은 diff가 없는 게 정상.
- 🚫 **금지**: 게이트를 통과시키려 산출물/diff를 조작하거나 채점기를 자기수정.
- ✅ **대응**: surface & hold — 오탐임을 근거와 함께 보고하고 멈춘다.

### F9 — verifier(tsc) 실패 `verifier failed: … tsc … src/core/team_*.ts(1,1): error`
- **실측**: 24건.
- ✅ **대응**: `src/*.ts` 에 섞인 junk 산출물(`Improvement cycle=N/3` 텍스트 파일)·팬텀 모듈을 `git rm`. **없는 모듈을 새로 만들어 tsc를 통과시키지 않는다.**

### F10 — config drift `invalid model selection (--model "agy-internal")` (6) · 퇴출 프로바이더 모델 선택 오류
- 🚫 **재시도 금지**: 프로바이더/모델 **id 하드코딩**. drift 테스트가 실패시킨다.
- ✅ **대응**: `npm run provider:add|remove`, 라우팅은 `resolvePreference`. **nvidia/mlx는 2026-07-29 퇴출 — 재추가 금지**(과거 로그에 남은 기록은 이력일 뿐).

### F11 — 업스트림 장애 `NonRetriableError: Provider Error` (33) · `ENOTFOUND api2.cursor.sh` (3) · `Connection error` / `fetch failed`
- ✅ **대응**: 최대 1회 재시도, 그 이상은 프로바이더 변경. `NonRetriableError`는 이름 그대로 재시도 대상이 아니다.

### F12 — `discussion_no_valid_proposals` (25) / `insufficient_valid_proposals:1/2` (8)
- **정체**: 참가자 다수가 게이트 차단 → 유효 제안 미달.
- ✅ **대응**: 토론/합의 시작 전 `gate.available=true` 인 프로바이더로 참가자를 필터.

### F14 — `This model only supports single tool-calls at once!` (8)
- ✅ **대응**: 로컬/양자화 모델에는 병렬 tool_use 금지. 순차 1콜씩 재설계.

### F15 — `exit=130` / `Aborting operation` / `SIGINT` (cursor-agent 32, opencode 2)
- **주의**: 정당한 취소일 수 있다. 실패로 집계하기 전 원인을 확인한다(과거 "exit=130=정당" 판정이 뒤집힌 이력 있음 — task-queue 정규화 참조).

### F16 — health 프로브 오탐 (이 작업 중 실측 발견)
- **증상**: `/health`뿐 아니라 `/`도 연결 후 무응답인데 PM2는 `online`, 내부 로그와 작업은 계속 진행한다.
- **원인(T1, 2026-07-31)**: 부팅 때 orphan 185개를 동시에 `enqueue()`해 동기 SQLite busy wait가 이벤트루프를 굶겼다. Redis 데드라인은 handler가 실행된 뒤에만 작동하므로 이 경우를 막지 못한다.
- 🚫 **금지**: 단발 또는 3회 프로브 실패를 "NCO 다운"으로 번역하거나, 에이전트/세션이 PM2 stop·restart·reload·start를 직접 실행하는 것.
- ✅ **대응**: timeout은 `unresponsive`로 보고하고 PM2 상태·uptime·부팅 로그를 함께 수집한다. `degraded` HTTP 200은 살아 있다는 신호다. 자동 재기동하지 말고 사람에게 원인과 증거를 전달한다.

### F17 — 프로토콜 응답 재변환 (409, 이 작업 중 실측 발견)
- **증상**: `HTTP 409 protocol_reconversion_blocked`.
- **원인**: `done:` / `status:` / `error:` / `question:` 로 시작하는 **에이전트 응답을 그대로 새 태스크로 재투입**. 게이트웨이가 에코 루프 방지를 위해 차단한다.
- 🚫 **재시도 금지**: 같은 프롬프트. 100% 같은 409.
- ✅ **대응**: 응답을 인용하지 말고 **현재 단계의 지시문으로 다시 쓴다**(`buildProtocolSafeHandoff`).

### F18 — `metadata.projectDir` 누락 (400, 이 작업 중 실측 발견)
- **증상**: `HTTP 400 {"error":"invalid_project_dir","detail":"metadata.projectDir is required"}`.
- 🚫 **금지**: 디스패처를 우회해 `curl /api/task` 를 직접 호출하는 것. 필수 필드를 빠뜨리게 된다.
- ✅ **대응**: `scripts/codex-subagent.sh` 경유(자동 주입). 직접 호출이 불가피하면 `{"metadata":{"projectDir":"<repo>"}}` 포함.

### F19 — payload 거부 `delegation_payload_rejected` / `Invalid input`
- **원인**: `ai` 가 런타임 미등록(퇴출·개명) 또는 스키마 불일치.
- ✅ **대응**: `GET /api/agents` 로 실제 등록 id 확인. **id 하드코딩 금지** — provider-registry 경유.

### F20 — 에러 없이 `cancelled` (이 작업 중 실측 발견)
- **증상**: 태스크 status=`cancelled`, `error` 는 빈 문자열. 디스패처는 실패(exit 6)로 반환.
- **정체**: **작업은 이미 반영됐는데** 종료 시점에 취소로 마킹된 사례가 있다. 실측: retired-media-provider 퇴출 src sweep 14파일이 전부 반영된 뒤 `cancelled` 기록(대상 문자열 `grep -rn src/` → 0건, tsc 0).
- 🚫 **금지**: 상태 문자열만 보고 "실패했으니 다시 위임". 이미 끝난 작업을 중복 실행한다.
- ✅ **대응**: 실패 단정 전 **지상진실 확인** — `git diff --stat`, `npx tsc --noEmit`, 목표 문자열 `grep`. 반영됐으면 성공으로 처리하고 원장에 정정 기록.

### F21 — health 오판 → 자가 PM2 재기동 폭주
- **증상(T1, 2026-07-31)**: 같은 Codex 세션이 11:41·11:46·11:51에 `pm2 restart nco-backend`를 반복했고, NCO가 띄운 OpenCode 작업자도 09:19에 같은 명령을 실행했다. 재기동마다 대량 orphan·회로 개방·복구 폭주가 뒤따랐다.
- **정체**: health 실패가 재기동 권한을 뜻하지 않는데 관측과 조치를 한 에이전트가 동시에 소유한 제어면 결함이다.
- 🚫 **절대 금지**: 서브에이전트·NCO 작업자·자동 세션의 PM2 변경. 가드의 승인 환경변수를 스스로 붙이는 것도 승인으로 인정하지 않는다.
- ✅ **대응**: 에이전트는 진단·보고까지만 한다. PM2 변경은 사람이 소유한 터미널에서 명시적으로 수행한다. NCO 런타임은 `CommandGate`에서 PM2 변경 명령을 차단하며, PATH 감사 심은 AI 조상 프로세스를 종료코드 77로 거부한다.

### F13 — stdin 대기 `Reading additional input from stdin...` (codex 16 failed + 7 cancelled)
- 🚫 **재시도 금지**: 프롬프트를 stdin으로 파이프해 codex 호출.
- ✅ **대응**: argv 또는 `--prompt-file`. `scripts/codex-subagent.sh` 는 이미 stdin을 쓰지 않는다.

---

## 실행 순서 (위임 시 고정 절차)

1. `scripts/codex-subagent.sh gate` — 게이트 확인. `available=False` 프로바이더는 **선택지에서 제외**.
2. `scripts/codex-subagent.sh run <role> --prompt-file <path>` — 디스패처가 F1/F4/F13 을 사전 차단하고, 동일 지문 2회 실패 시 `REPEAT_BLOCKED`(exit 5)로 막는다.
3. 실패 시 **exit code로 판단**: `3`=NCO 오프라인(직접 처리) · `4`=게이트 차단(경로 변경) · `5`=반복 실패(접근법 변경) · `6`=분류된 실패(분류별 대응) · `7`=폴링 초과(작업 분할). **어느 경우에도 같은 명령 재실행 금지.**
4. 결과는 `data/subagent-ledger/runs.jsonl` 에 자동 기록 → [[subagent-ledger]] 참조.

## 새로운 실패 요인을 발견했을 때

`UNCLASSIFIED` 로 원장에 남으면 그것이 신호다:
1. `scripts/codex-subagent.sh stats` 로 빈도 확인
2. `scripts/codex-subagent.sh` 의 `RULES`/`ADVICE` 에 분류·대응 추가
3. 이 파일에 F## 항목 추가
4. `~/.claude/hooks/loop-lesson.sh add "<key>" "<교훈>"` — 다음 턴 프롬프트에 자동 주입되어 반복을 막는다
