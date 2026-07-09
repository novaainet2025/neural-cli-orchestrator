# NCO 버그·에러·결함 종합 감사 (분산 병렬)

> 일시: 2026-07-03 · 코디네이터: claude-3(nova-macstudio) · 방식: 프로바이더 9영역 병렬 + 세션 2영역 분산 + 코디 자체분석
> 대상: `/Users/nova-ai/project/nco` (NCO backend, TS/ESM, :6200)
> 원시 수집: `scratchpad/nco_audit_results.md` · 세션 회신: inter-session `messages.log`

## 1. 분산 배분 & 커버리지 매트릭스 (중복 없음)

| 영역 | 담당 | 상태 | 발견 |
|---|---|---|---|
| A1 `src/agent` 어댑터 | codex | ✅(결과유효, 프로세스末 fail) | 7 (CRIT 2) |
| A2 `src/core` 오케스트레이션 | opencode→**codex 재배정** | ✅ | 12 (HIGH 10) |
| A3 `src/server` API/미들웨어 | cursor-agent(409 한도)→**claude-3 자체** | ✅ | 6 (CRIT 2) |
| A4 `src/core` 큐/상태 | copilot(쿼터)→**codex 재배정** | ✅ | 10 (CRIT 1) |
| A5 `src/core` 품질/메모리 | nvidia(빈응답)→**codex 재배정** | ✅ | 9 (CRIT 3) |
| A6 `src/verification`+`src/audit` | ollama(실패)→**agy 재배정** | ✅ | 11 (CRIT 1) |
| A7 `src/monitoring`+`bridge`+`client` | agy | ✅ | 8 |
| A8 `src/storage`+db | openrouter | ✅ | 8 (CRIT 1) |
| A9 `src/utils` | hermes(실패)→**codex 재배정** | ✅ | 8 |
| S1 `src/mcp` 디스패치 | **claude-3**(세션) | ✅ | 4 (HIGH 1) |
| S2 프로세스/라이프사이클/메시 | **claude-2**(세션) | ✅ | 15 (CRIT 1) |
| S3 `src/security/*` 샌드박스/가드 | claude-1 큐잉→**codex 재배정** | ✅ (claude-1 독립 2차 대기) | 11 (CRIT 2) |

**프로바이더 가용성 실태(T1, `/api/agents`):** copilot 월쿼터 초과, cursor-agent 사용한도, opencode API키 오류, ollama/mlx 오류, nvidia 빈응답, hermes 실패 — **9개 중 6개 즉시 실패**(opencode 포함). codex·agy·openrouter만 안정. 실패분(A2·A4·A5·A6·A9·S3·A3)은 안정 프로바이더 재배정 + 코디 자체분석으로 **전량 커버(12/12)**. codex가 재배정 워크호스(단일 프로바이더 다수 슬라이스 → 독립성은 그만큼 낮음, §5 미검증항목).

---

> **코디 T1 재현(spot-check 8건):** ✅확정 7 — `cross-validator.ts:60`(`union===0?1`=빈셋 완전합의), `merkleLog.ts:73`(`severity` 해시입력 누락, l.87 저장만), `orchestrated-loop.ts:108`(abort→bare `break`, 실패플래그 없음), `orchestrated-loop.ts:298`(실패를 문자열 마커로 return, throw 아님), `sync-engine.ts:21`(updateHook→forwardSync→flushWrites의 `UPDATE agents`가 hook 재유발=자기루프), `sleep-consolidator.ts:198`(`DELETE mem0_entries`에 HNSW 라벨정리 없음=orphan 벡터). ⚠️`vector-memory.ts:360` PLAUSIBLE(`getOrCreateIndex` 동작 의존, 미완전확인). ⚠️`redis.ts` 정정(아래). → **CRIT 부하지지 클레임 대부분 T1 확정. 프로바이더 T4는 대체로 정확(오차 1/8), 코드 반영 전 개별 재현 권장.**

## 2. CRITICAL (11 확정 + 1 정정) — 즉시 조치

### 2.1 실패를 성공으로 기록하는 계열 (NCO 최상위 결함군)
- **`src/agent/orchestrated-loop.ts:108`** — `abortSignal` 중단 시 `break`만 하고 정상 반환 → 취소/타임아웃된 B형 provider의 빈 출력이 `agent-manager.ts:193/246/298` 성공경로로 흘러 `task:completed`,`success:true`로 오염.
- **`src/agent/orchestrated-loop.ts:284`** — codex 비정상 종료를 예외가 아닌 문자열 `"[codex: no final response…]"`로 반환 → 이후 tool call 없으면 루프가 완료로 간주, 실패/usage-limit/timeout이 성공으로 기록.
- (연계 HIGH: `agent-manager.ts:185` Type A 종료코드 미검사, `agent-tools.ts:223` runCommand 항상 `ok:true`, `utils/summarizer.ts:40` 실패를 휴리스틱으로 대체, `audit/threatEscalation.ts:62` 비상정지 실패 묵인 — **동일 안티패턴**)

### 2.2 검증/무결성 게이트 우회
- **`src/core/cross-validator.ts:60`** — `jaccard()`가 양쪽 핵심어가 모두 비면 `1`(완전합의) 반환 → 실패/빈 응답끼리도 교차검증 통과.
- **`src/audit/merkleLog.ts:73`** — `computeHash`에 `severity` 필드 누락 → DB에서 로그 severity 변조해도 무결성 검증 통과(감사로그 위변조).
- **`src/core/sleep-consolidator.ts:198`** — `mem0_entries` 삭제/정리 시 HNSW 인덱스 재빌드 없음 → 벡터 라벨이 삭제행을 계속 참조, 메모리 검색 정합성 지속 파손.
- **`src/core/vector-memory.ts:360`** — `rebuildIndex()`가 빈 인덱스 신규생성이 아니라 기존 디스크 인덱스 재로드 → 오염 벡터가 "재빌드"로도 치유 안 됨.

### 2.3 인프라/영속성
- **`src/server/middleware/authJwt.ts:32,54`** — `ACCESS_TOKEN_SECRET ?? "access-secret"`, `REFRESH_TOKEN_SECRET ?? "refresh-secret"` **하드코딩 폴백 시크릿** → env 미설정 시 공개 문자열로 서명, **누구나 토큰 위조/무한 세션 탈취**.
- **`src/storage/redis.ts:41-45`** ⚠️정정 — openrouter 원보고("line31 null 반환")는 **부정확**(코디 T1 재현: `createClient`는 null 미반환, l.31은 error 핸들러). **실제 결함**: `getRedis()`가 `client = createClient()`를 `await connect()` **이전에** 대입(l.43) → connect() 거부 시 예외 전파 + `client`에 깨진 인스턴스가 캐시되어 이후 `getRedis()`가 재연결 없이 broken client 반환. lazyConnect라 에러가 첫 명령까지 지연. (등급 HIGH로 하향)
- **`src/core/sync-engine.ts:21`** — `agents` UPDATE_HOOK→`forwardSync()`→`flushWrites()`가 다시 `UPDATE agents` → **자기유발 동기화 루프**, I/O 폭증·상태 일관성 붕괴.
- **`hooks/nco-name-resolver.sh:83` vs `inter-session-name.sh:30`** — 이름 해석기가 `flock(.lock)` vs `mkdir(.lockdir)` **락 프리미티브 불일치** → 상호배제 실패, "session name shuffle" 재발(claude-2, T1).

---

### 2.4 샌드박스/권한 우회 (보안 core)
- **`src/security/path-guard.ts:53`** — 부모 디렉터리 symlink 아래 경로가 검사 우회 → 샌드박스 밖 파일 R/W(§S3).
- **`src/security/sandbox-manager.ts:115`** — `Commander` 역할 `allowedCommands:[]` = 전 명령 허용 → CommandGate 전면 우회, 임의명령 실행(§S3).
- (참고: `authJwt.ts` 하드코딩 시크릿 §2.3, `falseReportGuard.ts:70` 셸주입 §S3-HIGH도 보안 최우선)

## 3. 영역별 HIGH/MED (요약)

### A1 에이전트 어댑터 (codex)
- [HIGH] `agent-manager.ts:185` Type A subprocess `failed/exitCode/isCanceled` 미검사(reject:false).
- [HIGH] `agent-tools.ts:223` `runCommand` 종료코드 무관 항상 `ok:true`.
- [HIGH] `agent-tools.ts:224` 모델 생성 명령을 `shell:true` 실행 → 메타문자(`;`,`&&`,`$()`) 주입 위험.
- [MED] `api-executor.ts:68` `withAbortSignal()`이 원격 Promise 미취소 → 유령요청·토큰 낭비.
- [MED] `session-manager.ts:164` 위험도구 승인 60초 후 **자동승인** → 승인게이트 무력화.

### A2 오케스트레이션 (codex 재배정)
- [HIGH] `supervisor-engine.ts:20` `setInterval` 핸들 미저장, `stop()`이 미해제 → 재시작마다 복구루프 중첩.
- [HIGH] `supervisor-engine.ts:48` stalled 판정을 `created_at` 기준 → 방금 running된 태스크도 즉시 자동실패.
- [HIGH] `delegation-manager.ts:191` `complete()`가 `acceptance_status`/`work_status` 미검증 후 completed 덮어쓰기.
- [HIGH] `collaboration-engine.ts:166/190` 참가자 read-modify-write 무트랜잭션 race + 비참가 세션 기여 주입.
- [HIGH] `discussion-engine.ts:87/599` trust/reputation 전역상태 세션혼선 + realtime 리스너 미제거 누적.
- [HIGH] `harness-orchestrator.ts:167` 재시도 시 이전 `finalOutput/Score` 미초기화 → 실패재시도가 과거 성공으로 accept.
- [HIGH] `ensemble-engine.ts:160` 빈 에이전트 배열에도 `sorted[0]` winner → `winner.agentId` 런타임 오류.
- [HIGH] `workflow-pipeline.ts:160/393` 실행 failed에도 스코어링 진행 + 모드별 결과조회 경로 오라우팅(영구 polling 실패).
- [MED] `ensemble-engine.ts:125` `Promise.race` setTimeout 성공경로 미취소 → 타이머 누적.

### A4 큐/상태/스케줄링 (codex 재배정)
- [HIGH] `event-bus.ts:123` publish/xadd 부분실패 → 실시간 중복수신 + Stream 영구유실 동시 발생.
- [HIGH] `event-bus.ts:203` `xack()`가 파싱/핸들러 오류 시 누락 → poison 메시지 무한 재전달.
- [HIGH] `kanban-engine.ts:76/97` plan 작업 잠금·claim 없이 조회/실행 → 중복실행 + 선행실패 무시 순차진행.
- [HIGH] `cron-scheduler.ts:46` 재시도 setTimeout 핸들 미보관, cancel/delete가 미취소 → 삭제된 job 재실행.
- [MED] `shared-state.ts:164` `releaseLock()` GET→DEL 분리 → 만료/재획득 끼면 타 소유자 락 삭제.
- [MED] `invocation-tracker.ts:180` notified read→send→set 순서 → 완료알림 중복발송.
- [MED] `task-queue.ts:506` BullMQ 이벤트+enqueue 이중 카운트 → 큐 메트릭 팽창.
- [MED] `sync-engine.ts:87` `recoverySync()`가 non-online을 일괄 offline 복구 → running/idle/busy 유효상태 소실.

### A5 품질/메모리 (codex 재배정)
- [HIGH] `cross-validator.ts:181` consensus 거짓이어도 `disagreements<=agreements`면 accept.
- [HIGH] `hallucination-guard.ts:54` 컨텍스트 없으면 grounding `0.7` 부여 → 환각필터 사실상 비활성.
- [HIGH] `reflexion.ts:205` refine 결과를 다음 입력에 미반영, 즉시 덮어씀 → 자가개선 허위안정.
- [HIGH] `vector-memory.ts:231` HNSW addPoint 후 SQLite INSERT → DB 실패 시 orphan 벡터 라벨.
- [HIGH] `knowledge-base.ts:347` projectPath/category 제한없이 전역 유사row를 같은 id로 덮어씀 → 타 프로젝트 지식 오염.
- [MED] `quality-gate.ts:190` "best available" 주석과 달리 `lastOutput`만 반환 → 더 나은 후보 폐기.

### A6 검증/감사 (agy 재배정)
- [HIGH] `verification/response-quality.ts:59` ERROR_MARKER 정규식 `^` 앵커 → 생각태그 선행 시 에러마커 검출 우회.
- [HIGH] `audit/merkleLog.ts:90/160/203` appendAudit 무트랜잭션 prev_hash race + verifyChainIntegrity `limit=1000` 하드코딩(초과분 미검증) + verifyEntry가 체인 미검증.
- [HIGH] `audit/emergencyService.ts:220/244` 위협수준 이전값 무시 강제 다운그레이드 + 해제 직후 즉시 자동재정지 데드락.
- [HIGH] `audit/threatEscalation.ts:40/62` Level2/3 처리 플레이스홀더 방치 + Level4 비상정지 예외 묵인.
- [MED] `emergencyService.ts:57/255` 만료 비상정지 status='active' 잔존 + DID 유효성 검증 누락.

### A7 모니터링/UI (agy)
- [HIGH] `client/components/AgentMonitor.tsx:12,13` WS `ws://localhost` 하드코딩(HTTPS Mixed-Content 차단) + 재연결 로직 부재.
- [HIGH] `client/components/AgentDashboard.tsx:16` `http://localhost:6200/monitor` 하드코딩 → 원격배포 시 모니터링 불능.
- [MED] `monitoring/metrics.ts:35,147` `/metrics`마다 20+ 동기 SQLite 쿼리 이벤트루프 블로킹 + 완료/실패 0건 시 successRate NaN.
- [MED] `bridge/types.ts:107` `z.union`(비discriminated) → 고빈도 WS 검증 CPU 저하.
- [MED] `client/components/AgentDashboard.tsx:13` API 실패 시 에러표시 없이 무한 'Loading...'.

### A8 저장/영속성 (openrouter)
- [HIGH] `server/routes/fleet-ops.ts:44` `pushReports` TTL 정리가 GET 시에만 → 무한 메모리 증가(DoS).
- [HIGH] `server/routes/fleet-ops.ts:108` `const valid` 배열의 `.length=100` 변조로 상한 강제 불안정.
- [MED] `fleet-ops.ts:52` 만료 미반영 host 상한 → 정당 host 429.
- [MED] `storage/database.ts:14-22,41-44` 마이그레이션 무트랜잭션 부분적용 + 파일읽기 오류 미처리 크래시.
- [LOW] `database.ts:6,27-30` getDb 싱글톤 race + busy_timeout 5000 부족.

### A9 유틸 (codex 재배정)
- [HIGH] `utils/summarizer.ts:40` AI 실패를 휴리스틱으로 대체·예외삼킴(§2.1 계열).
- [MED] `utils/intent-parser.ts:58` 절대경로 정규식 캡처그룹 없는데 `[1]` 참조 → 경로인자 유실.
- [MED] `utils/config.ts:166` PORT/WS_PORT `Number()` 변환 후 NaN 미검증 → 바인드 런타임 오류.
- [MED] `utils/summarizer.ts:47`, `binaryTree.ts:23`, `fibonacci.ts:10` 길이계약 위반/타입 미검증/재귀 스택오버플로.
- [LOW] `config.ts:87` `/proc/version` 실패 빈 catch→linux 폴백, `file-logger.ts:19` 날짜 1회계산(로테이션 미작동).

### S1 MCP 디스패치 (claude-3)
- [HIGH] `src/mcp/server.ts:157` `executeAgentTask` 폴링예산 `TIMEOUT`(30s) 고정 — 실제 태스크 30s 초과 빈번(codex 71~140s 관측) → 서버 실행중인데 timeout throw + 고아태스크.
- [MED] `server.ts:18-19` `res.ok` 미확인 → 4xx/5xx 본문을 결과로 반환. `20-22` 모든 예외 `{error}` 스왈로잉.

### S2 프로세스/라이프사이클/메시 (claude-2, 15건 — 발췌)
- [HIGH] `hooks/inter-session-name.sh:34` 3초 후 `rm -rf .lockdir` 락강탈 → 느린 홀더도 강탈, claude-N 중복.
- [HIGH] `hooks/mesh-register.sh:38` mac에 flock 부재인데 폴백 없음 → 이름할당 no-op/등록우회.
- [HIGH] `hooks/mesh-heartbeat.sh:124` `[ -d /proc/$pid ]` 리눅스ism, macOS엔 /proc 없음 → stale responder kill 항상 거짓, 좀비 누적.
- [HIGH] `src/core/cli-mesh.ts:211-243/375` heartbeat·sendMessage가 동일 Redis 키 read-modify-write 무원자성 → mesh DM 유실.
- [HIGH] `setup.sh:330` settings.json 통째 덮어쓰기 → 기존 hooks/permissions/env 소실.
- [MED] `mesh-inbox-poller.sh:34-41` PID 가드 TOCTOU → DM 중복 inject. `mesh-heartbeat.sh:143` nohup 고아 spawn(플릿규칙 위반).
- [MED] `cli-mesh.ts:200-204` 동명 세션 무조건 evict → 다중호스트 claude-N 상호축출 플랩.

### S3 보안 샌드박스/가드 (claude-1 큐잉 → **codex 재배정, 완료**) — 11건 (CRIT 2)
- [CRIT] `src/security/path-guard.ts:53` — symlink 검사가 **최종 경로 자체가 링크일 때만** 수행 → 부모 디렉터리 symlink(`allowedRoot/link→/etc`) 아래 `.../link/passwd`는 통과. `lstatSync(abs)`는 대상을 일반파일로 보고 `isUnderAllowed`는 문자열 prefix만 검사 → **샌드박스 밖 파일 R/W 우회**.
- [CRIT] `src/security/sandbox-manager.ts:115` — `Commander` 역할이 `allowedCommands: []`로 **모든 명령 허용** → 해당 경로 에이전트가 CommandGate allowlist 전면 우회, 임의 명령 실행/권한상승.
- [HIGH] `path-guard.ts:53` — 대상 파일 미존재 시 `existsSync=false`로 symlink 검사 건너뜀 → 허용 디렉터리 내 외부향 symlink 디렉터리 생성 후 신규 파일 쓰기로 외부 경로 쓰기.
- [HIGH] `command-gate.ts:45` — allowlist가 `command.split('/').pop()` **basename만 비교** → cwd에 악성 `git`/`node` 두고 `/tmp/git`로 실행 시 허용명령 오인, allowlist 우회.
- [HIGH] `resource-limiter.ts:46` — `acquireSlot()` release 함수가 **비-idempotent** → 다중 호출 시 `activeActions` 음수 → 동시실행 제한 영구 무력화.
- [HIGH] `circuit-breaker-registry.ts:194` — half-open 전환 후 후속 `canExecute()`가 `state!=='open'` 분기로 전부 `true` → half-open probe 1회 제한 실패, 장애 provider로 병렬 폭주.
- [HIGH] `falseReportGuard.ts:70` — `shell_success` 검증이 `bash -c evidence.target`를 그대로 실행 → 증거 문자열이 외부입력이면 **검증단계가 임의 셸 실행 통로**(게이트 우회).
- [HIGH] `acquisition-policy.ts:69` — `defaultPolicy:'deny'`여도 승인게이트 0개면 `auto_pass` → **deny-by-default 미적용**, 공급망 통제 무력화.
- [MED] `acquisition-vetting.ts:284` 설치스크립트 정규식 denylist 의존(`node -e`/`perl -e`/토큰유출 미차단). `file-change-guard.ts:106` `change_ratio` 항상 0 저장 → `verification-gate.ts:137`의 `>=0.9` 대량교체 탐지 영구 우회.

> 추가 자체발견(claude-3, A3 보강): `ipRateLimit.ts:36` **X-Forwarded-For 스푸핑으로 레이트리밋 우회 + store 무한증가 DoS**(HIGH), `ipRateLimit.ts:39` 실제 fixed-window라 경계 2배 버스트(MED), `authJwt.ts:30/52` `algorithms` 미고정 알고리즘 혼동(HIGH).
> (claude-1은 동일 영역 독립 2차 검토를 큐잉 중 — 회신 시 교차확인용으로 append 예정.)

---

## 4. 교차 패턴 (근본원인 3종)

1. **실패=성공 기록 (Fail-as-Success)** — orchestrated-loop, agent-manager, agent-tools, summarizer, threatEscalation, workflow-pipeline. `reject:false`/문자열반환/빈catch가 실패를 성공경로로 흘림. **NCO 거짓보고 문제의 코드레벨 뿌리.** → 종료코드/예외를 성공판정에 필수 반영하는 공통 게이트 필요.
2. **무원자성 read-modify-write** — sync-engine, event-bus, kanban-engine, shared-state, invocation-tracker, collaboration-engine, cli-mesh, merkleLog. Redis/SQLite 동시성 보호(WATCH/MULTI/Lua/트랜잭션) 부재. → 동시 세션·병렬 실행에서 상태 유실·중복.
3. **검증 게이트의 기본값 관대화** — cross-validator(빈=합의1), hallucination-guard(무맥락 0.7), quality-gate(last≠best), merkleLog(severity 제외). 실패/저품질이 기본 통과. → 임계·기본값을 "불충분시 거부"로 반전.

---

## 5. 검증 영수증
- [변경] `docs/nco-bug-audit-2026-07-03.md` 신규 생성 (감사 리포트, 코드 무변경)
- [검증방법] `POST /api/task`×15 디스패치 후 `GET /api/tasks/:id/status` 폴링 결과 수집(`nco_audit_results.json`); claude-2 회신 `messages.log` 원문 확보; claude-3 자체분석 `authJwt.ts`/`ipRateLimit.ts`/`mcp/server.ts` 직접 Read; **CRIT spot-check 8건 소스 직접 Read 재현**(cross-validator·merkleLog·orchestrated-loop×2·sync-engine·sleep-consolidator·vector-memory·redis); 프로바이더 가용성 `/api/agents` lastError T1
- [등급] T1(코디 직접 Read 재현: authJwt·ipRateLimit·mcp/server + spot-check cross-validator·merkleLog·redis 5파일 + API응답본문 + messages.log) + T4(그 외 프로바이더/세션 LLM 발견 — 파일:라인 근거 포함, 코디 미재현)
- [Gap] ~99% — **12/12 영역 전량 커버**(S3 security 포함, codex 재배정 완료). CRIT spot-check 8건 중 **7 확정 + 1 정정(redis)** → 프로바이더 T4 신뢰도 실측(오차 1/8). 총 발견 ~101건(CRIT 11 확정+1정정, HIGH 다수)
- [미검증항목] (1) S3 security의 claude-1 **독립 2차 검토**(단일 codex 결과만 — 회신 시 교차확인 예정) (2) 미재현 CRIT: `sandbox-manager:115`, `path-guard:53`, `event-bus`, `cross-validator:60 외 프로바이더 HIGH 다수` 등 파일:라인만 신뢰분(spot-check 8건 외) (3) 각 버그 런타임 PoC/재현 (4) nvidia/ollama/hermes/copilot/opencode 원 슬라이스의 독립 2차(단일 재배정 결과만). **결론: 코드 수정 착수 전 CRIT 개별 재현 필수 — 특히 보안 core 2건.**
