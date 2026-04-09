# NCO 백엔드 업그레이드 — Phase A~F

## Phase A: 안전장치 (FileChangeGuard + Triple Verification Gate)
- [x] A1: src/security/file-change-guard.ts 생성
- [x] A2: src/security/verification-gate.ts 생성
- [x] A3: db/migrations/008_safety.sql 생성
- [x] A4: src/agent/agent-tools.ts에 FileChangeGuard 연동
- [x] A5: src/agent/agent-manager.ts에 VerificationGate 연동
- [x] A6: gateway.ts에 /api/safety/* 라우트 추가
- [x] A7: 검증 — tsc 0 에러, 서버 재시작 후 API 동작 확인 필요

## Phase B: 에이전트 세션 관리
- [x] B1: src/agent/session-manager.ts 생성
- [x] B2: db/migrations/009_agent_sessions.sql 생성
- [x] B3: gateway.ts에 /api/agent/start, sessions, status, abort, approve, reject 라우트 추가
- [x] B4: index.ts 부팅 시퀀스에 sessionManager import + shutdown 추가
- [x] B5: orchestrated-loop.ts에 AbortSignal 추가
- [x] B6: agent-tools.ts에 세션별 승인 체크 추가
- [x] B7: 검증 — tsc 0 에러

## Phase C: Smart Router + Conductor
- [x] C1: src/core/smart-router.ts 생성 (복잡도 분석 + 키워드 트리거 + 비용 기반 선택)
- [x] C2: gateway.ts에 POST /api/conductor 추가 (auto-dispatch → 모드/AI 자동 선택)
- [x] C3: mcp/server.ts에 nco_conductor 도구 추가
- [x] C4: discussion-engine.ts hive/commander 합성 단계 추가
- [x] C5: 검증 — tsc 0 신규 에러 (기존 3개는 types.ts/websocket.ts 무관)

## Phase D: 칸반 + Plan
- [x] D1: src/core/plan-manager.ts 생성
- [x] D2: src/core/kanban-engine.ts 생성
- [x] D3: db/migrations/010_plans_kanban.sql 생성
- [x] D4: gateway.ts에 6개 라우트 추가 (plan/create, plan/:id, plan/sync, kanban, kanban/move, plan/execute)
- [x] D5: 검증 — tsc 0 신규 에러

## Phase E: Observability + Learn
- [x] E1: src/core/observability.ts 생성 (리더보드, 에이전트 히스토리, 시스템 메트릭)
- [x] E2: src/core/knowledge-base.ts 생성 (저장, 검색, 컨텍스트, 자동 추출)
- [x] E3: db/migrations/011_observability_learn.sql 생성
- [x] E4: gateway.ts에 6개 라우트 추가
- [x] E5: dashboard-compat.ts GET /api/learning 실제 구현
- [x] E6: agent-manager.ts 태스크 완료 후 지식 추출
- [x] E7: 검증 — tsc 0 신규 에러

## Phase F: Commander 4-Layer
- [x] F1: src/core/commander.ts 생성 (4-Layer: Management→Information→Execution→Quality→Synthesis)
- [x] F2: gateway.ts에 POST /api/commander + GET /api/commander/layers 추가
- [x] F3: mcp/server.ts에 nco_commander 도구 추가 (POST /api/commander 연결)
- [x] F4: discussion-engine.ts 'commander' 모드 타입 추가
- [x] F5: 검증 — tsc 0 신규 에러
