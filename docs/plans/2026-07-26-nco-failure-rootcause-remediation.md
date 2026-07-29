# NCO 태스크 실패 근본원인 수정 명세 (P0/P1/P2)

작성 2026-07-26 · 근거: 28-에이전트 진단 워크플로우 (확정 12 / 반증 8), 모든 수치 T1 재확인
Baseline 스냅샷: `nco_baseline_20260726_1755.txt` (git HEAD `d2943828`)

## 배경 — 반드시 먼저 읽을 것

실패 5,155건 중 **67.6%가 프로바이더를 한 번도 호출하지 않은 합성 실패**다.
진짜 "AI가 일을 못 한" 실패는 11.6%뿐이다.

핵심 메커니즘 = **half-open 좀비 트랩** (3개 결함 직렬):

1. `dashboard-compat.ts:295` — 2분마다 도는 "CB 자동복구 타이머"가 `canExecute()`를
   호출하고 반환값을 버린다. `canExecute()`는 조회가 아니라 **상태 변이 함수**로,
   open+쿨다운만료를 half-open으로 전이시키며 유일한 프로브 슬롯(max 1)을 점유한다.
   실행을 안 하므로 recordSuccess/recordFailure가 영영 호출되지 않는다.
   → **자동복구 장치가 실제로는 슬롯 소각기**. 프로바이더당 하루 720회.
2. `circuit-breaker-registry.ts:315` `recoverIfExpired` — `state === 'open'`만 검사.
   half-open은 자가복구 분기가 없어 영구 고착. DB 증거: `copilot|half-open|2026-07-21` (5일째).
3. `task-queue.ts:892` — `.filter(s => s.state === 'open')`이 half-open을 배제하지 않아
   고착 좀비로 에스컬레이션. 이 줄은 코드베이스에서 원시 state 비교를 쓰는 **유일한 이탈 지점**
   (나머지 20곳은 `getAvailability()` 사용). CB 실패의 79.1%가 에스컬레이션 경유로 2배 증폭.

---

# P0 — 즉시 출혈 차단

> **P0-1 ~ P0-4는 반드시 한 배포에 묶을 것.**
> P0-1만 넣으면 이미 고착된 회로가 안 풀리고, P0-2만 넣으면 5분마다 재고착된다.

### P0-1. 복구 타이머가 상태를 파괴하지 않게
- 파일: `src/server/routes/dashboard-compat.ts:288-299` `startCbAutoHeal`
- 변경: `sandbox.circuitBreaker.canExecute()` → `circuitBreakerRegistry.getSnapshot(id)`
  (내부에서 `recoverIfExpired`를 경유하므로 복구는 되고 프로브 슬롯은 소모하지 않음)
- 근거: 같은 리포 `work-report-scheduler.ts:580` 주석이 이미 "가용성은 non-mutating
  `getAvailability()`로 본다. `canExecute()`는 …" 라고 적어놨는데 이 파일만 미반영
- 기대: 트랩 유입원 제거

### P0-2. half-open 자가복구 안전망
- 파일: `src/security/circuit-breaker-registry.ts:315-342` `recoverIfExpired`
- 변경: 조건에 `|| (state === 'half-open' && openedAt != null && Date.now() - openedAt > HALF_OPEN_TTL_MS)` 추가
- 신설 상수: `HALF_OPEN_TTL_MS = 5 * 60_000`
- 기대: 고착 상한 22h → 5분

### P0-3. 프로브 슬롯을 세마포어로 (정답 수정)
- 파일: `src/security/circuit-breaker-registry.ts:172,211,302,430` + `src/agent/agent-manager.ts`
- 변경: `halfOpenAttempts`를 **누적 카운터 → in-flight 세마포어**로 전환.
  `releaseProbeSlot(agentId)` 신설. `executeTask`의 `finally`에서 무조건 반납하되,
  `canExecute() === true`로 슬롯을 실제 획득한 경로에서만 반납하도록 `slotHeld` 플래그로 가드.
- **주의(리뷰 중점)**: 반납 위치를 잘못 잡으면 슬롯이 음수가 되어 무제한 동시 실행이 된다.
- 기대: P0-2가 사후 안전망이라면 이것이 구조적 정답

### P0-4. 에스컬레이션 증폭 차단
- 파일: `src/core/task-queue.ts:892`
- 변경: `.filter(snapshot => snapshot.state === 'open')`
      → `.filter(snapshot => !circuitBreakerRegistry.getAvailability(snapshot.agentId).available)`
- 기대: 2홉 CB 거부 약 1,666건 제거. 코드베이스 유일 이탈 지점 정상화

### P0-5. 인테이크 누수 차단
- 파일: `src/server/gateway.ts:269-272` `selectTaskProvider`
- 변경: `|| availability.status === 'probe'` 삭제 → same-role 폴백 또는 409로 흐름
- 기대: hermes 450건 등 인테이크 누수 제거

### P0-6. 부팅 재큐잉 건강판정 정상화
- 파일: `src/index.ts:55-59` `pickHealthyProvider.isUp`
- 변경: `s === 'available' || s === 'probe'` → `getAvailability(id).available`
- 기대: orphan poison 재생산 차단 (401건 중 상당수)

### P0-7. 측정 오염 제거 — 재발행 상한
- 파일: `work-report-scheduler` 재발행 루프
- 변경: 시도 상한(5) + 지수 백오프 추가
- 근거: CB 실패 2,077행이 **단 149개 업무보고**에서 나옴 (평균 13.9배, 최다 89회)
- 기대: 증폭 13.9배 → 1배

---

# P1 — 재발·중복 방지

### P1-1. 종결 상태 중복 실행 가드
- 파일: `src/core/task-queue.ts:1324-1330` `startRuntime`
- 변경: `TERMINAL_STATES.has(started.prev)`이면 `runtimes.delete` 후 **`UnrecoverableError`** throw
  (일반 `Error`를 던지면 BullMQ `attempts:3`이 재시도를 유발하므로 반드시 UnrecoverableError)
- 기대: 중복 실행 118 태스크(2.4%) + '버려진 결과' 차단

### P1-2. BullMQ lock 정합
- 파일: `src/core/task-queue.ts:716-718, 996-1002`
- 변경: `attempts: 3` → `1` (재시도는 enqueue 루프가 담당),
  `lockDuration`을 hardTimeout+120s로 정합, `purgeStaleJobs()` 신설해 부팅 시 구 job 제거
- 기대: `Missing lock for job` 계열 및 그로 인한 중복 실행 감소

### P1-3. verifier baseline 도입 (설계는 opencode 선행 권장)
- 파일: `src/core/task-queue.ts:458-518` `applyVerifierGate`
- 변경: verifier 실패 시에만 lazily 같은 `(cwd, command)`를 재실행(TTL 60s 캐시).
  baseline도 실패하면 `passed: true` + `verifier_skipped: 'pre-existing build failure'` 기록하고
  태스크는 completed 유지. 이상적으로 `git diff --name-only` 스코핑 병행.
- **미해결 트레이드오프**: baseline이 이미 실패면 진짜 회귀도 통과시킨다(위양성↔위음성 교환).
  동시 실행 태스크가 워킹트리를 오염시키면 baseline 자체가 오염된다.
- 기대: 07-13급 사고(1,045건/3일) 재발 차단

### P1-4. 페일오버 판정 화이트리스트 → 블랙리스트
- 파일: `src/server/task-failover.ts:17-32, 59-67`
- 현황: 화이트리스트 정규식 11개가 실측 상위 클래스를 **하나도** 매칭하지 않음.
  실제 실패행 5,145건에 이식 실행 → **4,662건(90.6%)이 무로그 탈락**
- 변경: `classifyFailure()` 단일 분류기 도입
  (`provider_unavailable` / `provider_limit` / `transient` / `verifier` / `silent_output` / `orphan` / `policy`).
  `policy`(cancelled·quality_rejected)만 non-retryable로 처리
- **비용 주의**: 재실행이 늘어 프로바이더 쿼터·토큰 비용 증가. 증가폭 미산정.
  `NCO_AUTO_FAILOVER=off` 롤백 경로 유지 필수

### P1-5. 페일오버 체인 결손 보완
- 파일: `config/failover-chains.json`
- 현황: 키 9개뿐 — **`claude-code`, `retired-local-provider`, `higgsfield` 부재**.
  `gateway.ts:1134`의 `chains[assigned_to]`가 undefined → 즉시 null.
  **실패 1위 에이전트 claude-code의 페일오버 성공률이 구조적으로 0%**
- 변경: `"claude-code": ["codex","cursor-agent","opencode"]`, `"retired-local-provider": ["ollama","hermes"]` 추가
  + `defaultChain` 폴백(같은 role의 건강한 프로바이더)

### P1-6. retry 카운터 감쇠
- 파일: `src/server/gateway.ts:543-556` `reserveRetry`
- 현황: `retry_counts` 1,221행 중 **666행이 count>=3**. cap 3에 걸려 영구 소진, 감쇠·만료 지점 없음
- 변경: `retry_counts.updated_at` 컬럼 추가, 6시간 창 감쇠.
  절대 상한(`totalRetries >= 10` → dead_letter) 병행

### P1-7. FORMAT_MISMATCH 오탐 종결
- 파일: `src/server/gateway.ts:1189` + `src/core/company-orchestrator.ts:1261,1268`
- 현황: `requireProtocolPrefix: Boolean(taskRow.verifier_json)` — **verifier가 붙었다는 사실만으로**
  `done:|status:` 프리픽스를 요구하는데 그 계약은 특정 팀 5곳에만 프롬프트로 고지됨.
  **고지되지 않은 형식 계약의 사후 강제.** `Quality-gate reject` 태스크 2,658건
- 변경: `hasResponseContract(taskRow.prompt)` (계약 마커 5종 검사)로 교체. SELECT에 `prompt` 추가

### P1-8. 셧다운 순서 정정
- 파일: `ecosystem.config.cjs` + `src/index.ts:361-398`
- 변경: `kill_timeout: 20000` 추가(현재 키 없음 → pm2 기본 1600ms).
  shutdown 순서를 '고아 표시·락 반납 먼저 → 드레인 나중'으로 반전. 유령 `in_progress` 제거

---

# P2 — 학습 루프 구축

> **핵심 원칙: writer와 소비자를 같은 PR에 넣을 것.**
> `agent_evolution_log`는 12,673행이 쌓였는데 소비자가 없어 write-only다.
> `learning_events`도 writer만 붙이면 같은 운명이 된다.

### P2-1. 무로그 조기 return 제거
- 파일: `src/server/gateway.ts:1099, 1100, 1103, 1141`
- 현황: 페일오버 조기 return 4곳 전부 무로그. 실패가 어느 게이트에서 죽었는지
  사후에 알 방법이 DB 포렌식뿐
- 변경: 각 지점에 `logDecision({phase:'failover', decision:'skip', reason})`
  + `insertDeadLetter(..., 'failover_exhausted')`

### P2-2. 학습 writer 신설
- 파일: **신규** `src/core/failure-learning.ts`
- 현황: `learning_events` 0행 + `grep -rn learning_events src/` **무매치**.
  테이블만 있고 쓰는 코드가 한 줄도 없음
- 변경: `recordLearningEvent()` 신설. 쓰기 지점 6곳:
  circuit commit(`registry:429`), recordFailure 미분류, failover skip/dispatch,
  quality_reject, escalation, orphan_poison, duplicate_execution

### P2-3. 학습 소비자 (**이것이 핵심**)
- 파일: 위 신규 파일
- 변경:
  - `getLearnedCircuitPatterns()`: 최근 14일 `circuit_unclassified` 중 `count>=3` 시그니처를
    정규식 컴파일 → `classifyCircuitError`가 참조해 quota로 자동 승격
  - `getFailureDigest()` → `/api/learning` 노출
- **오탐 위험**: 정상 출력이 'limit'을 인용만 해도 quota로 승격될 수 있다.
  `count>=3` + 시그니처 완전일치 + 감사 로그 + 수동 무효화 API가 함께 필요

### P2-4. 에러 문자열 정직화
- 파일: `src/agent/agent-manager.ts:144`
- 변경: `Circuit breaker open` → `provider_unavailable: ${id} (${state}/${reason})`
- **주의**: 기존 문자열 소비자(`team-scorer`, 대시보드)가 있으므로 **양쪽 패턴 모두 인식**하도록 유지

---

# 별도 검토 (이번 범위 밖)

`task-queue.ts` `runEnqueue`에 admission 게이트 + `deferred` 상태 도입 —
"회로가 막음"을 failed가 아니라 defer로 강등. 효과는 가장 크지만(RC2 정면 해결) 위험도 가장 크다.
`deferCount` 상한 + orphan 스캔 제외가 필수. P0/P1 안정화 후 opencode 설계 → codex 구현.

---

# 검증 (배포 후 T1 실측)

```bash
cd /Users/nova-ai/project/nco
```

1. **CB 합성 실패 소멸** — `select substr(created_at,1,10) d, count(*) from tasks
   where error like 'Circuit breaker open%' and created_at >= '<배포시각>' group by 1;`
   → 합격: 일 10건 미만 (현재 07-25 1,812건)
2. **half-open 고착 5분 이내** — `select agent_id, state, (strftime('%s','now') - opened_at/1000)/60 stuck_min
   from circuit_states where state='half-open';` → 합격: `stuck_min < 6` (현재 copilot 7,000+분)
3. **실패가 조치되는가** — 실패 대비 `parent_task_id` 자식 보유 비율
   → 현재 2.5%(최근 3일 0.56%) → 목표 40%+
4. **페일오버 탈락률** — `dist/server/task-failover.js`의 판정 함수를 실제 실패행에 이식 실행
   → 현재 90.6% → 목표 20% 미만
5. **학습 루프 생존** — `select event_type, count(*) from learning_events group by 1;` → 목표 일 수백 행.
   `select count(*) from learning_events where auto_applied=1;` → **0이면 write-only 재발**
6. **측정 오염 제거** — workReportId 증폭배수 → 현재 13.9 → 목표 2.0 미만
7. **회귀 방지** — `npx tsc --noEmit` (현재 에러 0),
   `npm test -- circuit-breaker task-failover`
   (P0-3은 `circuit-breaker.test.ts`, P1-4는 `task-failover.test.ts:11` 갱신 필요),
   `grep -rn "state === 'open'" src --include="*.ts" | grep -v test`
   → 합격: `task-queue.ts:892` 매치 소멸
