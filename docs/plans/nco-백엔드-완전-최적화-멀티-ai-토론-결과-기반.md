# NCO 백엔드 완전 최적화 — 멀티 AI 토론 결과 기반

> **Plan ID:** plan_Qfhe66MTkgggljoY
> **상태:** in-progress
> **근거:** 4개 AI (ollama, opencode, openrouter, gemini) 멀티 토론 합의 결과 (2026-04-10)
> **세션:** sess_liEDltDZ0d4Z7dbw (completed)

---

## 아키텍처 원칙

```
┌─────────────────────────────────────────────────────┐
│  NCO 백엔드 최적화 레이어 구조                         │
│                                                     │
│  [P4] DX Layer      문서자동생성 · 모니터링 최적화      │
│  [P3] AI Layer      동적Consensus · KB 임베딩         │
│  [P2] Perf Layer    WebSocket압축 · Sync CDC          │
│  [P1] Reliability   EventBus신뢰성 · Queue우선순위    │
│  [P0] Stability     토론타임아웃 · CircuitBreaker     │
│  ─────────────────────────────────────────────────  │
│  기존 인터페이스 유지 (Breaking Change 없음)            │
│  npm run build 통과 필수 · TypeScript strict 준수     │
└─────────────────────────────────────────────────────┘
```

### 설계 원칙
1. **인터페이스 보존** — 모든 public API 시그니처 유지, 내부 구현만 교체
2. **점진적 적용** — 각 Phase 독립 배포 가능, 롤백 용이
3. **검증 우선** — 각 변경 후 `npm run build` + 기존 테스트 통과 확인
4. **TypeScript strict** — any 사용 금지, 타입 완전성 보장

---

## Phase 0 — 안정화 (즉시)

### Task 1: 토론 엔진 타임아웃
- **파일:** `src/core/discussion-engine.ts`
- **문제:** `Promise.allSettled` 타임아웃 없음 → 에이전트 응답 지연 시 무한 대기
- **설계:**
  ```typescript
  // Before: Promise.allSettled(agentPromises)
  // After:
  const timeout = AbortSignal.timeout(30_000); // 30초 per round
  const results = await Promise.allSettled(
    agentPromises.map(p => Promise.race([p, timeoutReject(timeout)]))
  );
  ```
- **추가:** Structured JSON Output 강제 (`{ score: number, reason: string, proposal: string }`)
- **검증:** 타임아웃 에이전트는 score=0으로 처리, 토론 계속 진행

- [x] [P0-1a] discussion-engine.ts: collectResponses에 AbortSignal.timeout(30s) 추가 @codex
- [x] [P0-1b] discussion-engine.ts: extractScores를 Structured JSON 파싱으로 교체 @codex
- [x] [P0-1c] build 검증 및 타임아웃 단위 테스트 @ollama

### Task 2: Circuit Breaker 동적 임계치
- **파일:** `src/agent/agent-manager.ts`
- **문제:** failureThreshold 고정 5회, half-open 즉시 closed 전환
- **설계:**
  ```typescript
  // Dynamic threshold: 최근 100개 요청의 95th percentile latency 기반
  // half-open: 연속 3회 성공 후 closed 전환
  // Adaptive: 에이전트별 개별 Circuit Breaker 인스턴스
  ```
- **추가:** 에이전트별 latency 히스토그램 (`latencyBucket: Map<number, number>`)

- [x] [P0-2a] agent-manager.ts: 에이전트별 latency 히스토그램 추가 @aider
- [x] [P0-2b] agent-manager.ts: 95th percentile 기반 동적 threshold 계산 @aider
- [x] [P0-2c] agent-manager.ts: half-open → closed 조건 3회 연속 성공으로 변경 @aider
- [x] [P0-2d] build 검증 @cursor-agent

---

## Phase 1 — 신뢰성 (주간)

### Task 3: Event Bus 신뢰성
- **파일:** `src/core/event-bus.ts`
- **문제:** Redis echo 억제가 setTimeout 기반 불안정, deduplication TTL 10s 너무 짧음
- **설계:**
  ```
  Redis Streams (XADD/XREADGROUP) Consumer Groups
  ├── Group: "nco-consumers"
  ├── ACK 기반 메시지 확인
  ├── PEL(Pending Entry List) 재처리
  └── Redis 장애시 → SQLite fallback queue 자동 전환
  deduplication TTL: 10s → 30s
  ```

- [x] [P1-3a] event-bus.ts: deduplication TTL 30s로 변경 @codex
- [x] [P1-3b] event-bus.ts: Redis Streams Consumer Group 도입 (XADD/XREADGROUP) @codex
- [x] [P1-3c] event-bus.ts: Redis 장애시 SQLite fallback queue 자동 전환 @codex
- [x] [P1-3d] build 검증 @cursor-agent

### Task 4: Task Queue 우선순위
- **파일:** `src/core/task-queue.ts`
- **문제:** BullMQ priority 미반영, DB의 priority 필드 사용 안 됨
- **설계:**
  ```typescript
  // BullMQ job 추가 시 priority 반영
  await queue.add(taskId, payload, {
    priority: task.priority ?? 5,  // 0=최고, 9=최저
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  });
  // Aging: 대기 5분 이상인 태스크 priority +1 (starvation 방지)
  ```

- [x] [P1-4a] task-queue.ts: BullMQ add() 호출에 priority 옵션 연결 @aider
- [x] [P1-4b] task-queue.ts: Aging 메커니즘 (5분 대기시 priority +1) @aider
- [x] [P1-4c] build 검증 @cursor-agent

---

## Phase 2 — 성능 (월간)

### Task 5: WebSocket 최적화
- **파일:** `src/server/websocket.ts`
- **문제:** 전체 JSON payload 전송, 구독 필터 부족
- **설계:**
  ```
  permessage-deflate 압축 활성화
  Unified Pub/Sub: taskId/sessionId/agentId 기반 채널 구독
  SSE fallback: WebSocket 미지원 클라이언트용
  ```

- [x] [P2-5a] websocket.ts: permessage-deflate 압축 활성화 @opencode
- [x] [P2-5b] websocket.ts: 채널 기반 구독 필터링 (taskId/sessionId/agentId) @opencode
- [x] [P2-5c] websocket.ts: SSE 엔드포인트 추가 (GET /api/events/stream) @opencode
- [x] [P2-5d] build 검증 @cursor-agent

### Task 6: Redis/SQLite Sync CDC
- **파일:** `src/core/sync-engine.ts`
- **문제:** 5초 주기 단방향 동기화, 최대 5초 데이터 불일치
- **설계:**
  ```
  SQLite WAL mode 최적화 (PRAGMA journal_mode=WAL)
  변경 감지: SQLite UPDATE_HOOK → 즉시 Redis 반영
  벡터 클록: 충돌 감지 및 최신값 우선 merge
  Batch write: 50ms 윈도우로 묶어 쓰기
  ```

- [x] [P2-6a] sync-engine.ts: SQLite WAL mode + UPDATE_HOOK 설정 @codex
- [x] [P2-6b] sync-engine.ts: 벡터 클록 충돌 감지 및 merge 로직 @codex
- [x] [P2-6c] sync-engine.ts: 50ms Batch write 윈도우 @codex
- [x] [P2-6d] build 검증 @cursor-agent

---

## Phase 3 — AI 품질 (분기)

### Task 7: 동적 Consensus
- **파일:** `src/core/discussion-engine.ts`
- **문제:** consensusThreshold 고정 0.8, 에이전트 가중치 미반영
- **설계:**
  ```typescript
  // PID 기반 동적 threshold
  // threshold(t+1) = threshold(t) + Kp*e + Ki*∫e + Kd*Δe
  // e = target_consensus_rate - actual_consensus_rate
  // 에이전트 신뢰도: 최근 10회 토론 성공률 기반 가중치
  ```

- [x] [P3-7a] discussion-engine.ts: 에이전트별 신뢰도 점수 추적 @openrouter
- [x] [P3-7b] discussion-engine.ts: PID 기반 동적 threshold 계산 @openrouter
- [x] [P3-7c] discussion-engine.ts: 가중치 투표 적용 calculateConsensus() @openrouter
- [x] [P3-7d] build 검증 @cursor-agent

### Task 8: Knowledge Base 임베딩
- **파일:** `src/core/knowledge-base.ts`
- **문제:** LIKE/정규식 검색, confidence 고정 0.8
- **설계:**
  ```
  Vector Embeddings: LangChain (localhost:6270) 연동
  시맨틱 검색: cosine similarity > 0.75
  LLM Entity Extraction: 구조화된 카테고리 자동 분류
  피드백 루프: 사용자 수정 → confidence 점진 업데이트
  ```

- [x] [P3-8a] knowledge-base.ts: LangChain 임베딩 API 연동 @openrouter
- [x] [P3-8b] knowledge-base.ts: 시맨틱 검색 (cosine similarity) 구현 @openrouter
- [x] [P3-8c] knowledge-base.ts: LLM 기반 카테고리 자동 분류 @openrouter
- [x] [P3-8d] knowledge-base.ts: confidence 피드백 루프 @openrouter
- [x] [P3-8e] build 검증 @cursor-agent

---

## Phase 4 — DX 확장

### Task 9: 문서 자동생성
- **파일:** `src/core/plan-manager.ts`
- **문제:** 문서 자동생성 기능 부재, discussion report SQLite만 저장
- **설계:**
  ```
  Handlebars 템플릿 엔진으로 Markdown/JSON 자동 생성
  GET /api/discussions/:id/export → Markdown 다운로드
  File Watcher (chokidar): docs/ 변경 감지 → DB 자동 동기화
  AST 파서: 마크다운 체크박스 ↔ DB task 양방향 바인딩
  ```

- [x] [P4-9a] plan-manager.ts: Handlebars 템플릿 엔진 통합 @aider
- [x] [P4-9b] gateway.ts: GET /api/discussions/:id/export 엔드포인트 @aider
- [x] [P4-9c] plan-manager.ts: chokidar File Watcher 양방향 동기화 @aider
- [x] [P4-9d] build 검증 @cursor-agent

### Task 10: 실시간 모니터링 최적화
- **파일:** `src/server/monitor.ts`, `src/server/websocket.ts`
- **문제:** 전체 JSON 전송 (msgpackr 설치됐으나 미사용), eventBuffer 1000개 유실
- **설계:**
  ```
  MessagePack 인코딩 (msgpackr 이미 설치됨, 활성화만 필요)
  Delta encoding: 변경 필드만 전송 (JSON Patch RFC 6902)
  Ring Buffer: 1000개 배열 → 고정 크기 순환 버퍼
  Throttling: 동일 이벤트 타입 16ms 배치 처리
  ```

- [x] [P4-10a] websocket.ts: msgpackr 인코딩 활성화 @codex
- [x] [P4-10b] websocket.ts: JSON Patch 기반 Delta encoding @codex
- [x] [P4-10c] monitor.ts: Ring Buffer로 eventBuffer 교체 @codex
- [x] [P4-10d] monitor.ts: 16ms Throttling/Batching @codex
- [x] [P4-10e] build 검증 @cursor-agent

---

## 진행 상태

| Phase | 태스크 수 | 완료 | 상태 |
|-------|---------|------|------|
| P0 (안정화) | 7 | 0 | 🔴 대기 |
| P1 (신뢰성) | 7 | 0 | 🔴 대기 |
| P2 (성능) | 8 | 0 | 🔴 대기 |
| P3 (AI품질) | 9 | 0 | 🔴 대기 |
| P4 (DX) | 9 | 0 | 🔴 대기 |
| **합계** | **40** | **0** | 🔴 |

---

## 참조
- 토론 세션: `sess_liEDltDZ0d4Z7dbw` (completed, 4 agents)
- 참여 AI: ollama(Gemma4), opencode, openrouter, gemini
- 생성일: 2026-04-10
