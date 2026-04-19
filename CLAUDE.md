# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NCO (Neural CLI Orchestrator) is a TypeScript backend that orchestrates 9 AI agents (Claude Code, Codex, Gemini CLI, Aider, OpenCode, Cursor Agent, Copilot, OpenRouter, Ollama) as a collaborative team. Agents are classified into three types:

- **Type A (Native)**: CLI agents with their own execution loop (claude-code)
- **Type B (Orchestrated)**: CLI agents driven by NCO's loop with XML-based tool calls (codex, gemini, aider, opencode, cursor-agent, copilot)
- **Type C (API-based)**: OpenAI-compatible API endpoints with key rotation (openrouter, ollama)

Coordination modes: task (single agent), parallel (all agents), discussion (multi-round dialogue), consensus (voting), hive (unified entity), broadcast (message all).

## Build & Run Commands

```bash
npm run dev          # Watch mode with tsx (hot reload)
npm run build        # TypeScript compile to dist/
npm start            # Run compiled dist/index.js
npm test             # Vitest watch mode
npm run test:run     # Vitest single run
npm run pm2:start    # Production via PM2
npm run pm2:stop     # Stop PM2 process
```

No separate lint or format commands are configured.

## Architecture

### Boot Sequence (src/index.ts)

Initialization order matters — each step depends on the previous:
1. SQLite (WAL mode) + migrations from `db/migrations/`
2. Redis (graceful fallback to local-only if unavailable)
3. Event Bus (Redis Pub/Sub + Streams, persisted to SQLite)
4. Provider seeding (`config/ai-providers.json` → DB + Redis)
5. Recovery sync (SQLite → Redis)
6. Agent Manager (initializes 9 agents with sandboxes)
7. Fastify Gateway on `:6200`
8. WebSocket Bridge on `:6201`

### Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/agent/` | Agent execution: OrchestratedLoop (Type B), ApiExecutor (Type C), ToolParser, AgentToolExecutor |
| `src/core/` | Discussion engine, Event bus, Shared state, Sync engine |
| `src/server/` | Fastify gateway, WebSocket bridge, Live monitor dashboard |
| `src/security/` | SandboxManager, PathGuard, CommandGate, ResourceLimiter, CircuitBreaker |
| `src/storage/` | SQLite database init + Redis client |
| `src/mcp/` | MCP server exposing 26 tools for external integration |
| `src/utils/` | Config loader, Pino logger, Zod validation schemas |

### Storage Model

- **SQLite**: Durable storage (agents, actions, messages, artifacts, tasks, discussions, rate limits). 7 migration files auto-run on boot.
- **Redis**: Fast state (agent heartbeats with 60s TTL, file locks, event streams with 10k replay buffer). Optional — system degrades gracefully without it.
- **Sync**: Bidirectional SQLite ↔ Redis. Recovery sync at startup, periodic sync at intervals.

### Event System

Event bus uses hybrid Redis Pub/Sub + SQLite persistence. 20+ event types (action:*, message:*, task:*, discussion:*, system:*) are broadcast via WebSocket and persisted to DB. WebSocket clients can replay events from a sequence number on reconnection.

## Configuration

- `config/ai-providers.json` — Agent definitions (model, command, role, score, capabilities, persona, health checks, rate limits)
- `config/topology.json` — Ports and paths
- `.env` — API keys and runtime settings (see `.env.example`)
- `ecosystem.config.cjs` — PM2 process management

## Testing

Tests are integration-focused in `tests/`. The server must be running (or tests start it). Key test files:

- `full-integration.ts` — 52 tests covering all API endpoints, WebSocket, agent execution, discussions
- `agent-integration.ts` — 27 tests for agent execution workflows
- `team-work.ts` — 25 tests for multi-agent collaboration

Run a single test file: `npx vitest run tests/full-integration.ts`

## Language & Runtime

- TypeScript with `strict: true`, ES2022 target, NodeNext module resolution (ESM)
- Node.js >= 22 required
- Documentation is in Korean

### Claude Code in this repo: slash commands & tools

- **Slash commands**: Files under `.claude/commands/*.md` become `/nco-*` commands (e.g. `/nco-commander`, `/nco-start`, `/nco-mesh`). They work whenever this project is opened in Claude Code; no extra enable flag is required beyond a normal session.
- **Hooks** (`.claude/settings.json`): `UserPromptSubmit`, `Stop`, `SessionStart` inject NCO context and checks. Ensure NCO is reachable at `:6200` for full behavior; otherwise hooks still exit successfully with an offline hint.
- **Natural language → tools**: Do **not** wait for the user to type slash commands. If they ask in plain language to read a file, search code, run a command or tests, edit something, or call an API—use the corresponding tools immediately. For orchestration (`/nco-commander`, parallel agents, mesh), interpret intent and run the matching `curl` or workflow from `.claude/commands/` without asking them to rephrase as a slash command.
- **Programmatic intent** (optional): `POST /api/nlp/intent` with `{ "query": "..." }` returns a suggested tool and args for automation clients.

---

## Commander 오케스트레이션 — NCO 전용 규칙

### 이 프로젝트에서 자동 실행 조건

| 작업 유형 | 자동 호출 패턴 |
|----------|--------------|
| 새 API 엔드포인트 추가 | opencode(설계) → codex(구현) → cursor-agent(리뷰) → ollama(검증) |
| 새 에이전트 타입 추가 | opencode(아키텍처) + gemini(인터페이스 설계) 병렬 → aider(파일 편집) |
| 보안 수정 | cursor-agent(감사) + ollama(검증) 병렬 |
| 성능 최적화 | copilot(벤치마크 리서치) → codex(구현) → ollama(검증) |
| 테스트 커버리지 확대 | codex(테스트 생성) + ollama(엣지케이스) 병렬 |
| 모니터 UI 변경 | gemini(디자인 제안) → 나(구현) |
| 전체 리팩토링 | `nco_commander` 단일 호출 |

### Supervisor 루프 — 이 프로젝트 기준

```
성공 기준:
  - npx tsc --noEmit 오류 0개
  - 기존 /api/* 엔드포인트 응답 유지
  - WebSocket 브리지 (:6201) 정상
  - Redis/SQLite 데이터 무결성
```

### 에이전트 결과 통합 시 체크리스트

- [ ] TypeScript 타입 오류 없음
- [ ] 기존 gateway.ts 라우트와 충돌 없음
- [ ] 이벤트 버스 타입 일치 (src/core/types.ts)
- [ ] 새 마이그레이션 파일 필요 여부 확인 (db/migrations/)
- [ ] monitor.ts UI 업데이트 필요 여부 확인

---

## Claude-Gemma (로컬 MLX, 포트 4100 프록시) — **자동 적용 (슬래시 명령 불필요)**

다음 중 하나이면 **별도 `/…` 명령 없이** 아래 규칙을 따른다: `ANTHROPIC_BASE_URL`에 `4100` 포함, 또는 `http://127.0.0.1:4100/health` 가 살아 있음.

- **UserPromptSubmit 훅**이 세션 **첫 사용자 메시지**에 토큰 절약 지시를 `additionalContext`로 한 번 붙인다.
- **필수 동작**: 검증은 **`cli-installs/gemma-gate-check.sh`** 만 사용 (`--no-plan` 또는 `--plan <파일>`). 장문 리뷰·전체 재탐색으로 빌드/린트를 대체하지 않는다. 출력·중간 보고는 최소화. 설계가 매우 어려울 때만 **Advisor** 1회.
- **`/claude-gemma-pipeline`** 은 긴 템플릿·예시가 필요할 때만 참고(선택).

게이트 예: `bash cli-installs/gemma-gate-check.sh . --no-plan` 또는 `--plan docs/plans/<이번작업>.md`.
