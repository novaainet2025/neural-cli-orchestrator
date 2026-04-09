# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NCO (Neural CLI Orchestrator) is a TypeScript backend that orchestrates 9 AI agents (Claude Code, Codex, Gemini CLI, Aider, OpenCode, Cursor Agent, Copilot, OpenRouter, vLLM) as a collaborative team. Agents are classified into three types:

- **Type A (Native)**: CLI agents with their own execution loop (claude-code)
- **Type B (Orchestrated)**: CLI agents driven by NCO's loop with XML-based tool calls (codex, gemini, aider, opencode, cursor-agent, copilot)
- **Type C (API-based)**: OpenAI-compatible API endpoints with key rotation (openrouter, vllm)

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
