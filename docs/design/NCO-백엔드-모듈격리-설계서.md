# NCO 백엔드 모듈 격리 설계서

> **작성일**: 2026-04-10
> **버전**: v1.0
> **상태**: 활성
> **요약**: 코어/모듈 경계 원칙 — 모듈 추가/삭제 시 전체 시스템 영향 없음

---

## 1. 설계 원칙

```
┌──────────────────────────────────────────────────────────┐
│                                                           │
│  원칙 1: 중앙 코어는 최소화한다                             │
│          코어 없이는 시스템이 아예 안 켜진다.                │
│          코어만 있으면 "빈 시스템"이 켜진다.                 │
│                                                           │
│  원칙 2: 기능은 모듈이다                                   │
│          모듈은 코어에 자신을 등록한다.                     │
│          코어는 모듈의 존재를 모른 채로 작동한다.             │
│                                                           │
│  원칙 3: 모듈이 없으면 해당 기능만 없다                     │
│          discussion 모듈 삭제 → 토론만 안됨                 │
│          나머지 task, parallel 등은 정상 작동               │
│                                                           │
│  원칙 4: 모듈 간 의존은 선택적이다                          │
│          A 모듈이 B 모듈을 쓰고 싶으면 → "있으면 사용, 없으면 건너뜀" │
│          하드 의존(import) 금지. 코어 레지스트리 경유만 허용.  │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 아키텍처 — 코어 + 모듈

```
┌─────────────────────────────────────────────────────────────┐
│                        NCO Backend                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                 CORE (삭제 불가)                         │  │
│  │                                                        │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ │  │
│  │  │ Event Bus│ │ State    │ │ API      │ │ Module    │ │  │
│  │  │ (Redis)  │ │ Store    │ │ Gateway  │ │ Loader    │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘ │  │
│  │  ┌──────────┐ ┌──────────┐                             │  │
│  │  │ WebSocket│ │ Provider │                             │  │
│  │  │ Server   │ │ Registry │                             │  │
│  │  └──────────┘ └──────────┘                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                  │
│                    register/unregister                        │
│                            │                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ Module  │ │ Module  │ │ Module  │ │ Module  │  ...       │
│  │ task    │ │ discuss │ │ sandbox │ │ kanban  │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│                                                              │
│  각 모듈은 독립적. 어떤 모듈을 빼도 나머지는 작동한다.         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. CORE — 삭제 불가능한 중앙 기능 (6개)

코어만 있으면 **빈 시스템**이 켜진다. API 요청을 받고, 이벤트를 전파하고, 상태를 저장한다.
하지만 AI 실행, 토론, 보안 등 **모든 실제 기능은 모듈**이다.

### 3.1 코어 목록

| # | 코어 | 역할 | 왜 코어인가 |
|---|------|------|-----------|
| 1 | **Event Bus** | Redis Pub/Sub + Streams. 모든 모듈 간 통신의 유일한 경로 | 이것 없으면 모듈 간 소통 불가 |
| 2 | **State Store** | Redis(실시간) + SQLite(영속) + Sync Engine | 이것 없으면 상태 저장 불가 |
| 3 | **API Gateway** | Fastify HTTP 서버 (:6200). 라우트 등록/해제 동적 지원 | 이것 없으면 REST API 불가 |
| 4 | **WebSocket Server** | ws 서버 (:6201). Event Bus ↔ 클라이언트 브릿지 | 이것 없으면 실시간 통신 불가 |
| 5 | **Provider Registry** | 프로바이더 목록 관리 (CRUD). 실행은 안 함 — 등록만 | 이것 없으면 AI 목록조차 없음 |
| 6 | **Module Loader** | 모듈 발견 → 검증 → 등록 → 라이프사이클 관리 | 이것 없으면 모듈 로딩 불가 |

### 3.2 코어 구현

```typescript
// ═══ src/core/module-loader.ts ═══

interface NCOModule {
  // 모든 모듈이 구현하는 인터페이스
  name: string;                          // 'task', 'discussion', 'sandbox' ...
  version: string;
  
  // 라이프사이클
  onRegister(core: NCOCore): Promise<void>;   // 코어에 등록될 때
  onReady(): Promise<void>;                    // 모든 모듈 로딩 완료 후
  onShutdown(): Promise<void>;                 // 종료 시 정리

  // 선택: API 라우트 등록
  routes?(): RouteDefinition[];

  // 선택: Event Bus 구독
  subscriptions?(): EventSubscription[];

  // 선택: 다른 모듈 소프트 의존
  optionalDependencies?(): string[];      // 없어도 작동, 있으면 활용
}

interface NCOCore {
  eventBus: EventBus;
  stateStore: StateStore;
  gateway: FastifyInstance;
  ws: WebSocketServer;
  providerRegistry: ProviderRegistry;

  // 모듈 조회 (없으면 null — 하드 의존 방지)
  getModule<T extends NCOModule>(name: string): T | null;
  hasModule(name: string): boolean;
}

class ModuleLoader {
  private modules: Map<string, NCOModule> = new Map();

  // 모듈 디렉토리 스캔 → 자동 로딩
  async loadAll(modulesDir: string): Promise<void> {
    const entries = await fs.readdir(modulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(modulesDir, entry.name, 'index.ts');
      if (!await fileExists(manifestPath)) continue;

      try {
        const mod: NCOModule = await import(manifestPath);
        await this.register(mod);
        logger.info(`Module loaded: ${mod.name} v${mod.version}`);
      } catch (err) {
        // 모듈 로딩 실패 → 경고만, 시스템은 계속
        logger.warn(`Module failed to load: ${entry.name}`, err);
      }
    }

    // 모든 모듈 로딩 후 onReady 호출
    for (const mod of this.modules.values()) {
      try {
        await mod.onReady();
      } catch (err) {
        logger.warn(`Module onReady failed: ${mod.name}`, err);
      }
    }
  }

  async register(mod: NCOModule): Promise<void> {
    // 라우트 등록
    if (mod.routes) {
      for (const route of mod.routes()) {
        core.gateway.route(route);
      }
    }

    // 이벤트 구독
    if (mod.subscriptions) {
      for (const sub of mod.subscriptions()) {
        core.eventBus.on(sub.event, sub.handler);
      }
    }

    this.modules.set(mod.name, mod);
  }

  async unregister(name: string): Promise<void> {
    const mod = this.modules.get(name);
    if (!mod) return;
    await mod.onShutdown();
    // 라우트 해제, 구독 해제
    this.modules.delete(name);
    logger.info(`Module unregistered: ${name}`);
  }

  getModule<T extends NCOModule>(name: string): T | null {
    return (this.modules.get(name) as T) ?? null;
  }
}
```

### 3.3 코어 부팅 시퀀스

```
1. Redis 연결
2. SQLite 초기화 + 마이그레이션
3. Event Bus 시작
4. State Store 시작 + Recovery Sync (SQLite → Redis)
5. Provider Registry 초기화 (ai-providers.json → DB 시딩)
6. API Gateway 시작 (:6200)
7. WebSocket Server 시작 (:6201)
8. Module Loader → src/modules/ 디렉토리 스캔 → 모듈 자동 로딩
9. 시스템 Ready

코어만 있으면:
  GET /api/health → { status: 'ok', modules: [] }
  GET /api/providers → 9개 프로바이더 목록 (실행은 안 됨)
  WebSocket 연결 가능 (이벤트 없음)
```

---

## 4. MODULES — 독립 기능 단위 (추가/삭제 자유)

### 4.1 전체 모듈 맵

```
src/modules/
├── executor-native/       # Type A: Claude Code 실행
├── executor-cli/          # Type B: CLI 단발 실행 + OrchestratedLoop
├── executor-api/          # Type C: API 멀티턴 (vLLM, OpenRouter)
├── mode-task/             # /api/task — 단일 AI 위임
├── mode-parallel/         # /api/parallel — 병렬 비교
├── mode-discussion/       # /api/discussion — 턴제 토론
├── mode-consensus/        # /api/consensus — 합의 도출
├── mode-hive/             # /api/hive — 9=1 통합
├── mode-commander/        # /api/commander — 4-Layer 계층
├── mode-conductor/        # /api/conductor — 자동 디스패치
├── sandbox/               # PathGuard + CommandGate + ResourceLimiter
├── file-guard/            # FileChangeGuard (변경률 보호)
├── circuit-breaker/       # 장애 격리
├── verification-gate/     # Triple Verification (L1/L2/L3)
├── smart-router/          # 복잡도 분석 + 에이전트 선택
├── agent-session/         # 에이전트 루프 세션 관리
├── kanban/                # 칸반 + Plan
├── learn/                 # NCO Learn 지식 베이스
├── observability/         # 메트릭 + 리더보드
├── mcp-server/            # MCP 26개 도구
├── queue/                 # BullMQ 작업 큐
└── tool-executor/         # 파일/명령 도구 실행
```

### 4.2 모듈 의존성 규칙

```
                    ┌─────────────┐
                    │    CORE     │
                    │ (Event Bus, │
                    │  State,     │
                    │  Gateway,   │
                    │  WS, etc.)  │
                    └──────┬──────┘
                           │
              모든 모듈은 CORE만 의존
                           │
         ┌─────────┬───────┼───────┬─────────┐
         ▼         ▼       ▼       ▼         ▼
    ┌─────────┐ ┌──────┐ ┌────┐ ┌──────┐ ┌──────┐
    │executor │ │mode- │ │sand│ │kanban│ │learn │
    │-cli     │ │task  │ │box │ │      │ │      │
    └─────────┘ └──────┘ └────┘ └──────┘ └──────┘

모듈 간 직접 import 금지.
모듈이 다른 모듈을 쓰고 싶으면:

  // ❌ 금지 — 하드 의존
  import { Sandbox } from '../sandbox';

  // ✅ 허용 — 코어 경유, 없으면 건너뜀
  const sandbox = core.getModule('sandbox');
  if (sandbox) {
    await sandbox.validate(agent, call);
  } else {
    // sandbox 모듈 없음 → 검증 건너뜀 (또는 기본 허용)
  }
```

### 4.3 모듈별 상세 — 삭제 시 영향 분석

| 모듈 | 삭제 시 영향 | 다른 모듈이 받는 영향 |
|------|------------|-------------------|
| **executor-native** | claude-code 실행 불가 | mode-* 에서 claude-code 선택 시 → 폴백 또는 에러 |
| **executor-cli** | 6개 CLI AI 실행 불가 | mode-* 에서 해당 AI 선택 시 → 폴백 |
| **executor-api** | vLLM/OpenRouter 실행 불가 | mode-* 에서 해당 AI 선택 시 → 폴백 |
| **mode-task** | `/api/task` 404 | conductor가 task 모드 선택 시 → 다음 모드로 |
| **mode-parallel** | `/api/parallel` 404 | conductor가 건너뜀 |
| **mode-discussion** | `/api/discussion` 404 | consensus 불가 (discussion 기반이므로) |
| **mode-consensus** | `/api/consensus` 404 | discussion은 정상 |
| **mode-hive** | `/api/hive` 404 | 나머지 모드 정상 |
| **mode-commander** | `/api/commander` 404 | 나머지 모드 정상 |
| **mode-conductor** | `/api/conductor` 404 → 사용자가 직접 모드 선택 필요 | 자동 디스패치만 없음 |
| **sandbox** | 보안 검증 없이 도구 실행 (위험하지만 작동) | executor-*가 검증 건너뜀 |
| **file-guard** | 변경률 보호 없음 | tool-executor가 무조건 허용 |
| **circuit-breaker** | 장애 격리 없음 — 실패해도 계속 시도 | executor-*가 무한 재시도 가능 |
| **verification-gate** | 작업 완료 후 검증 건너뜀 | task 완료 시 바로 completed |
| **smart-router** | 자동 AI 선택 없음 → 사용자가 직접 지정 필요 | conductor 작동 불가 |
| **agent-session** | 에이전트 루프 세션 관리 불가 | `/api/agent/*` 404 |
| **kanban** | 칸반/Plan 불가 | `/api/kanban/*`, `/api/plan/*` 404 |
| **learn** | 지식 저장/검색 불가 | 프롬프트에 지식 컨텍스트 미포함 |
| **observability** | 메트릭/리더보드 없음 | 모니터링 API 404 |
| **mcp-server** | MCP 도구 사용 불가 (CLI에서 REST 수동 호출) | Claude Code MCP 연동 불가 |
| **queue** | BullMQ 미사용 → 직접 실행 (동기) | 작업 큐잉/지연 실행 불가 |
| **tool-executor** | 파일/명령 도구 실행 불가 | executor-*가 도구 실행 불가 → AI 응답만 가능 |

---

## 5. 모듈 구현 예시

### 5.1 mode-task 모듈

```typescript
// src/modules/mode-task/index.ts

import type { NCOModule, NCOCore, RouteDefinition } from '../../core/types';

const module: NCOModule = {
  name: 'mode-task',
  version: '1.0.0',

  async onRegister(core: NCOCore) {
    this.core = core;
  },

  async onReady() {},
  async onShutdown() {},

  routes(): RouteDefinition[] {
    return [
      {
        method: 'POST',
        url: '/api/task',
        handler: async (req, reply) => {
          const { ai, prompt } = req.body as { ai: string, prompt: string };

          // 프로바이더 존재 확인 (코어)
          const provider = this.core.providerRegistry.get(ai);
          if (!provider) return reply.status(404).send({ error: `Provider ${ai} not found` });

          // executor 모듈 찾기 (소프트 의존)
          const executorType = this.getExecutorType(provider);
          const executor = this.core.getModule(`executor-${executorType}`);
          if (!executor) {
            return reply.status(503).send({
              error: `Executor module 'executor-${executorType}' not loaded`
            });
          }

          // smart-router 있으면 활용 (선택)
          const router = this.core.getModule('smart-router');
          const complexity = router?.analyzeComplexity(prompt) ?? 5;

          // 태스크 생성 (코어 State Store)
          const taskId = nanoid();
          await this.core.stateStore.createTask({
            id: taskId, mode: 'task', prompt,
            assignedTo: ai, status: 'assigned', complexity
          });

          // 실행 (비동기 — 즉시 응답)
          this.executeInBackground(taskId, executor, provider, prompt);

          return reply.send({ taskId, status: 'assigned', ai });
        }
      }
    ];
  },

  async executeInBackground(taskId, executor, provider, prompt) {
    try {
      await this.core.stateStore.updateTaskStatus(taskId, 'running');
      await this.core.eventBus.publish({
        type: 'task:started', taskId, agentId: provider.id
      });

      // sandbox 있으면 경유, 없으면 직접 실행
      const sandbox = this.core.getModule('sandbox');
      const result = await executor.execute(provider, { id: taskId, prompt }, sandbox);

      // verification-gate 있으면 검증, 없으면 바로 완료
      const gate = this.core.getModule('verification-gate');
      if (gate) {
        const verified = await gate.verify(taskId, result);
        if (!verified.passed) {
          await this.core.stateStore.updateTaskStatus(taskId, 'failed');
          return;
        }
      }

      await this.core.stateStore.updateTaskStatus(taskId, 'completed');
      await this.core.eventBus.publish({
        type: 'task:completed', taskId, agentId: provider.id, result
      });

    } catch (err) {
      // circuit-breaker 있으면 기록, 없으면 무시
      const cb = this.core.getModule('circuit-breaker');
      cb?.onFailure(provider.id, err);

      await this.core.stateStore.updateTaskStatus(taskId, 'failed');
      await this.core.eventBus.publish({
        type: 'task:failed', taskId, agentId: provider.id, error: String(err)
      });
    }
  },

  getExecutorType(provider): string {
    if (provider.id === 'claude-code') return 'native';
    if (provider.type === 'api') return 'api';
    return 'cli';
  }
};

export default module;
```

### 5.2 sandbox 모듈

```typescript
// src/modules/sandbox/index.ts

const module: NCOModule = {
  name: 'sandbox',
  version: '1.0.0',

  async onRegister(core: NCOCore) {
    this.pathGuard = new PathGuard();
    this.commandGate = new CommandGate();
    this.resourceLimiter = new ResourceLimiter();
  },

  // 다른 모듈이 core.getModule('sandbox').validate() 로 호출
  async validate(agent, toolCall): Promise<ValidationResult> {
    if (toolCall.tool === 'run_command') {
      return this.commandGate.validate(agent, toolCall.args.cmd);
    }
    if (['read_file','write_file','edit_file','delete_file','create_file'].includes(toolCall.tool)) {
      return this.pathGuard.validate(agent, toolCall.tool, toolCall.args.path);
    }
    return { ok: true };
  },

  // file-guard 모듈과 독립 — 둘 다 있으면 둘 다 검증
  // file-guard 없으면 변경률 검증 없이 통과
  // sandbox 없으면 경로/명령 검증 없이 통과
};
```

### 5.3 소프트 의존 패턴 정리

```typescript
// ═══ 다른 모듈 사용 시 항상 이 패턴 ═══

// 패턴 1: 있으면 사용, 없으면 건너뜀
const sandbox = core.getModule('sandbox');
if (sandbox) {
  const result = await sandbox.validate(agent, call);
  if (!result.ok) return; // 차단
}
// sandbox 없으면 → 검증 없이 통과

// 패턴 2: 있으면 향상, 없으면 기본값
const router = core.getModule('smart-router');
const complexity = router?.analyzeComplexity(prompt) ?? 5; // 없으면 기본 5

// 패턴 3: 있으면 기록, 없으면 무시
const learn = core.getModule('learn');
learn?.save({ category: 'bug_pattern', content: '...' }); // 없으면 아무것도 안함

// 패턴 4: 있으면 검증, 없으면 바로 완료
const gate = core.getModule('verification-gate');
if (gate) {
  const verified = await gate.verify(taskId, result);
  if (!verified.passed) { /* 실패 처리 */ }
}
// gate 없으면 → 무조건 통과
```

---

## 6. 디렉토리 구조

```
src/
├── core/                          # ★ 코어 — 삭제 불가
│   ├── index.ts                   # 엔트리포인트, 부팅 시퀀스
│   ├── event-bus.ts               # Redis Pub/Sub + Streams
│   ├── state-store.ts             # Redis + SQLite + Sync
│   ├── gateway.ts                 # Fastify HTTP (:6200)
│   ├── websocket.ts               # ws (:6201) + Event Bus 브릿지
│   ├── provider-registry.ts       # 프로바이더 목록 관리
│   ├── module-loader.ts           # 모듈 발견/등록/해제
│   ├── types.ts                   # NCOModule, NCOCore 인터페이스
│   └── migrations/                # DB 스키마 (코어 테이블만)
│       └── 001-core.sql           # agents, tasks, events, sync_state
│
├── modules/                       # ★ 모듈 — 추가/삭제 자유
│   │
│   │  ┌─ 실행기 (3종) ─────────────────────────────┐
│   ├── executor-native/           # Type A: claude-code
│   │   └── index.ts
│   ├── executor-cli/              # Type B: 6개 CLI + OrchestratedLoop
│   │   ├── index.ts
│   │   ├── orchestrated-loop.ts
│   │   └── tool-parser.ts        # NCO Tool Protocol 파서
│   ├── executor-api/              # Type C: vLLM + OpenRouter
│   │   ├── index.ts
│   │   └── key-rotation.ts       # API 키 롤링
│   │
│   │  ┌─ 실행 모드 (7종) ──────────────────────────┐
│   ├── mode-task/                 # POST /api/task
│   │   └── index.ts
│   ├── mode-parallel/             # POST /api/parallel
│   │   └── index.ts
│   ├── mode-discussion/           # POST /api/discussion/create
│   │   ├── index.ts
│   │   ├── turn-manager.ts       # 턴제 관리
│   │   └── consensus-calc.ts     # 합의율 계산
│   ├── mode-consensus/            # POST /api/consensus
│   │   └── index.ts              # discussion 모듈 소프트 의존
│   ├── mode-hive/                 # POST /api/hive
│   │   └── index.ts
│   ├── mode-commander/            # POST /api/commander
│   │   ├── index.ts
│   │   └── layer-dispatch.ts     # 4-Layer 분배
│   ├── mode-conductor/            # POST /api/conductor
│   │   └── index.ts              # smart-router 소프트 의존
│   │
│   │  ┌─ 보안 (4종) ───────────────────────────────┐
│   ├── sandbox/                   # PathGuard + CommandGate + ResourceLimiter
│   │   ├── index.ts
│   │   ├── path-guard.ts
│   │   ├── command-gate.ts
│   │   └── resource-limiter.ts
│   ├── file-guard/                # FileChangeGuard (변경률)
│   │   └── index.ts
│   ├── circuit-breaker/           # 장애 격리
│   │   └── index.ts
│   ├── verification-gate/         # Triple Verification (L1/L2/L3)
│   │   └── index.ts
│   │
│   │  ┌─ 도구 & 라우팅 ──────────────────────────┐
│   ├── tool-executor/             # 파일/명령 도구 실제 실행
│   │   └── index.ts
│   ├── smart-router/              # 복잡도 분석 + AI 선택
│   │   └── index.ts
│   ├── agent-session/             # 에이전트 세션 (start/abort/approve)
│   │   └── index.ts
│   │
│   │  ┌─ 데이터 & 기능 ──────────────────────────┐
│   ├── kanban/                    # 칸반 + Plan
│   │   ├── index.ts
│   │   └── migrations/
│   │       └── 001-kanban.sql    # plans, kanban_tasks 테이블
│   ├── learn/                     # NCO Learn 지식 베이스
│   │   ├── index.ts
│   │   └── migrations/
│   │       └── 001-learn.sql     # knowledge_base 테이블
│   ├── observability/             # 메트릭 + 리더보드
│   │   └── index.ts
│   ├── queue/                     # BullMQ 작업 큐
│   │   └── index.ts
│   └── mcp-server/                # MCP 26개 도구
│       └── index.ts
│
├── config/
│   ├── topology.json
│   └── ai-providers.json
│
└── db/
    └── migrations/                # 코어 마이그레이션만
```

---

## 7. 모듈별 DB 마이그레이션 격리

```
코어 테이블 (src/core/migrations/):
  001-core.sql:
    agents, tasks, agent_actions, agent_messages,
    artifacts, discussions, discussion_messages,
    rate_limit_state, metrics, sync_state, schema_migrations

모듈 테이블 (각 모듈 내 migrations/):
  kanban/migrations/001-kanban.sql:
    plans, kanban_tasks
    → kanban 모듈 삭제 시 이 테이블도 무시됨

  learn/migrations/001-learn.sql:
    knowledge_base
    → learn 모듈 삭제 시 이 테이블도 무시됨

  file-guard/migrations/001-file-guard.sql:
    file_backups
    → file-guard 모듈 삭제 시 이 테이블도 무시됨

  verification-gate/migrations/001-vgate.sql:
    verification_gates
    → verification-gate 모듈 삭제 시 이 테이블도 무시됨

Module Loader가 모듈 로딩 시 해당 모듈의 migrations/ 자동 실행.
모듈 삭제 시 테이블은 남아있지만 아무도 접근 안 함 (무해).
```

---

## 8. 최소 구동 구성 vs 풀 구성

### 8.1 최소 구동 (코어만)

```
로딩: core 6개만
결과: 시스템 켜짐, API 응답, WebSocket 연결
      하지만 AI 실행 불가, 모든 /api/* → 404
용도: 개발 시 코어 테스트
```

### 8.2 기본 구동 (코어 + 필수 모듈)

```
로딩: core + executor-cli + executor-api + mode-task + sandbox + tool-executor
결과: 단일 AI 작업(task) 가능, 보안 검증 있음
      토론/병렬/합의 등은 불가
용도: 최소 기능 테스트, MVP
```

### 8.3 표준 구동 (핵심 모드)

```
로딩: 기본 + executor-native + mode-parallel + mode-discussion
      + mode-consensus + circuit-breaker + file-guard + smart-router
      + agent-session + verification-gate
결과: 4종 핵심 모드 + 보안 + 에이전트 루프 전체 작동
용도: 프로덕션 기본
```

### 8.4 풀 구동 (전체 모듈)

```
로딩: 표준 + mode-hive + mode-commander + mode-conductor
      + kanban + learn + observability + queue + mcp-server
결과: NCO 전체 기능
용도: 프로덕션 완전체
```

---

## 9. 구현 순서 — Phase별 모듈 추가

```
Phase 1: 코어
  src/core/* 전체 (6개 코어 컴포넌트)

Phase 2: 실행 기반
  modules/tool-executor
  modules/executor-cli        (OrchestratedLoop)
  modules/executor-api        (vLLM/OpenRouter + 키 롤링)
  modules/executor-native     (claude-code)
  modules/sandbox             (PathGuard + CommandGate)
  modules/file-guard          (변경률 보호)
  modules/circuit-breaker
  modules/mode-task           (첫 번째 모드)

Phase 3: 협업 모드
  modules/mode-parallel
  modules/mode-discussion     (턴제 토론 + 합의 계산)
  modules/mode-consensus
  modules/smart-router
  modules/agent-session
  modules/verification-gate

Phase 4: 확장 모드 + 실시간
  modules/mode-hive
  modules/mode-commander
  modules/mode-conductor
  modules/kanban

Phase 5: 완성
  modules/learn
  modules/observability
  modules/queue
  modules/mcp-server
```

---

---

## 10. Stop Hook — 자동 Gap 분석 & 연속 작업 시스템

### 10.1 핵심 메커니즘

```
Claude Code CLI 매 턴 종료 시 Stop 훅이 실행된다.

  exit 0 = Claude 정상 종료 (작업 완료)
  exit 2 = Claude 재실행 (stderr 내용을 프롬프트로 주입하여 이어서 작업)

이것을 활용하여:
  Gap < 95% → exit 2 → Claude가 미완료 항목을 자동으로 이어서 작업
  Gap >= 95% → exit 0 → 완료 요약 + 다음 작업 추천
```

### 10.2 Stop Hook 플로우

```
Claude 응답 종료
    │
    ▼
┌─────────────────────────────────────────┐
│ STEP 1: 작업 결과 수집                    │
│  - git diff: 변경 파일 수                │
│  - tsc --noEmit: TypeScript 에러 수      │
│  - eslint: 변경 파일 린트 에러 수         │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ STEP 2: 태스크 상태 수집                  │
│  - docs/plans/*.md 파싱                  │
│  - .llm/todo.md 파싱                     │
│  - [ ] 미완료 vs [x] 완료 카운트         │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ STEP 3: Gap Rate 계산                    │
│  - 기본: (완료 태스크 / 전체 태스크) × 100│
│  - tsc 에러: 개당 -5% (최대 -30%)        │
│  - lint 에러: 개당 -2% (최대 -15%)       │
│  - 태스크 없으면: 변경+에러 기반 추정      │
└────────────┬────────────────────────────┘
             │
             ▼
        Gap >= 95%?
        ┌───┴───┐
       YES      NO
        │        │
        ▼        ▼
   ┌────────┐ ┌────────────────────────────┐
   │ exit 0 │ │ exit 2                      │
   │        │ │                             │
   │ 완료!  │ │ stderr에 주입:              │
   │ 요약   │ │  - 미완료 태스크 목록        │
   │ 표시   │ │  - tsc 에러 내용 (상위 10개) │
   │        │ │  - lint 에러 내용 (상위 10개) │
   │ 다음   │ │  - "위 항목을 해결하세요"     │
   │ 작업   │ │                             │
   │ 추천   │ │ → Claude가 자동으로          │
   │        │ │   이어서 작업 시작           │
   └────────┘ └────────────────────────────┘
```

### 10.3 단축키 커맨드 (슬래시 명령)

| 명령 | 동작 | 파일 |
|------|------|------|
| `/next` | 다음 순차 태스크 1개 실행. 의존성 있으면 선행부터. | `.claude/commands/next.md` |
| `/next-parallel` | 독립적인 미완료 태스크들을 Agent로 병렬 실행 | `.claude/commands/next-parallel.md` |
| `/gap` | 현재 Gap 분석 수동 실행 + 상세 리포트 | `.claude/commands/gap.md` |

### 10.4 작업 흐름 예시

```
사용자: "JWT 인증 시스템 구현해"
    │
    ▼
Claude: 작업 시작 → Plan 생성 → 태스크 3개 중 1개 완료
    │
    ▼
[Stop Hook] Gap 33% < 95% → exit 2
    stderr: "미완료: 인증 미들웨어, 라우팅 가드. tsc 에러 2개."
    │
    ▼
Claude: 자동 재실행 → 미들웨어 구현 + tsc 에러 수정
    │
    ▼
[Stop Hook] Gap 66% < 95% → exit 2
    stderr: "미완료: 라우팅 가드."
    │
    ▼
Claude: 자동 재실행 → 라우팅 가드 구현 + 전체 검증
    │
    ▼
[Stop Hook] Gap 100% >= 95% → exit 0
    표시: "완료! 3/3 태스크, tsc 0err, lint 0err"
    추천: "다음: /next (E2E 테스트) | /next-parallel (소셜 로그인 + 2FA)"
    │
    ▼
사용자: /next  ← 한 번의 입력으로 다음 작업 시작
```

### 10.5 설정

```
파일: .claude/settings.json
위치: hooks.Stop

{
  "type": "command",
  "command": "bash \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/end-of-turn-check.sh",
  "timeout": 30,
  "statusMessage": "Gap analysis + verification..."
}

환경변수로 커스터마이즈:
  NCO_GAP_THRESHOLD=95    # Gap 통과 기준 (기본 95)
  NCO_MAX_TSC_PENALTY=30  # tsc 에러 최대 감점
  NCO_MAX_LINT_PENALTY=15 # lint 에러 최대 감점
  NCO_AUTO_CONTINUE=true  # false면 항상 exit 0 (수동 모드)
```

---

> **이 설계의 핵심:**
> 어떤 모듈을 삭제해도 시스템은 켜진다.
> 해당 기능의 API만 404가 된다.
> 나머지 모든 기능은 정상 작동한다.
> Stop Hook이 자동으로 gap을 추적하고, 미달 시 Claude를 재실행시킨다.
