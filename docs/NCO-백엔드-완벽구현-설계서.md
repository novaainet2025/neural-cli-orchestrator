# NCO 백엔드 완벽 구현 설계서 v3.0

> **작성일**: 2026-04-09  
> **버전**: v3.0 — 핵심 재정의  
> **상태**: 설계 완료 — 실행 대기  

---

## 0. 핵심 재정의

### NCO란 무엇인가

NCO는 **9개 AI가 하나의 팀으로 일하는 시스템**이다.

각 AI는 단순한 "프롬프트 파이프"가 아니라 **독립적인 에이전트**다.
읽고, 쓰고, 수정하고, 삭제하고, 생성할 수 있다.
모든 에이전트는 **중앙 상태**를 공유하며, 서로의 작업과 상태를 실시간으로 볼 수 있다.
그리고 그들은 **토론**한다.

### 3가지 핵심 축

```
┌─────────────────────────────────────────────────┐
│                                                   │
│  1. Agent Autonomy (에이전트 자율성)                │
│     각 AI는 독립 에이전트다.                        │
│     파일을 읽고, 코드를 쓰고, 테스트를 돌린다.       │
│     스스로 판단하고 실행한다.                        │
│                                                   │
│  2. Shared Awareness (공유 인식)                    │
│     모든 AI는 중앙 상태를 본다.                     │
│     누가 뭘 하고 있는지 실시간으로 안다.              │
│     작업 결과를 서로 확인하고 참조한다.               │
│                                                   │
│  3. Discussion Protocol (토론 프로토콜)              │
│     AI들이 서로 대화한다.                           │
│     제안하고, 반박하고, 평가하고, 합의한다.           │
│     실시간 양방향 통신으로.                          │
│                                                   │
└─────────────────────────────────────────────────┘
```

### 이전 설계서와의 차이

| 이전 (v2) | 지금 (v3) |
|-----------|-----------|
| AI = 프롬프트 입력 → 텍스트 출력 | AI = **에이전트** (읽기/쓰기/수정/삭제/생성) |
| 180개 API 엔드포인트 나열 | **핵심 3축 중심** 설계 |
| 토론은 Phase 6 (나중) | **토론이 Phase 1** (먼저) |
| BullMQ에 작업 넣고 기다림 | **실시간 양방향 통신** (이벤트 드리븐) |
| AI는 서로 모름 | **중앙 상태 공유** — 모든 AI가 서로를 안다 |

---

## 1. 아키텍처

### 1.1 시스템 전체 구조

```
                        ┌─────────────────────┐
                        │    사용자 / CLI /     │
                        │    Dashboard         │
                        └─────────┬───────────┘
                                  │
                        ┌─────────▼───────────┐
                        │   NCO Orchestrator   │
                        │   ┌───────────────┐  │
                        │   │  Event Bus     │  │  ← 모든 것의 중심
                        │   │  (실시간 통신)  │  │
                        │   └───────┬───────┘  │
                        │           │          │
                        │   ┌───────▼───────┐  │
                        │   │ Shared State   │  │  ← 중앙 상태
                        │   │ (모든 AI 공유) │  │
                        │   └───────┬───────┘  │
                        │           │          │
                        └───────────┼──────────┘
                                    │
              ┌─────────┬───────────┼───────────┬─────────┐
              ▼         ▼           ▼           ▼         ▼
        ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
        │ Agent    ││ Agent    ││ Agent    ││ Agent    ││ Agent    │
        │ claude   ││ opencode ││ gemini   ││ codex    ││ vllm     │
        │          ││          ││          ││          ││          │
        │ ◆ read   ││ ◆ read   ││ ◆ read   ││ ◆ read   ││ ◆ read   │
        │ ◆ write  ││ ◆ write  ││ ◆ write  ││ ◆ write  ││ ◆ write  │
        │ ◆ edit   ││ ◆ edit   ││ ◆ edit   ││ ◆ edit   ││ ◆ edit   │
        │ ◆ delete ││ ◆ delete ││ ◆ delete ││ ◆ delete ││ ◆ delete │
        │ ◆ create ││ ◆ create ││ ◆ create ││ ◆ create ││ ◆ create │
        │ ◆ run    ││ ◆ run    ││ ◆ run    ││ ◆ run    ││ ◆ run    │
        └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘
              │           │           │           │           │
              └─────────┬─┴───────────┴───────────┴─┬─────────┘
                        │                           │
                        ▼                           ▼
                  ┌──────────┐                ┌──────────┐
                  │ Workspace│                │ Discussion│
                  │ (공유    │                │ Engine    │
                  │  파일시스│                │ (토론     │
                  │  템/코드)│                │  엔진)    │
                  └──────────┘                └──────────┘
```

### 1.2 핵심 컴포넌트 3개

```
┌─────────────────────────────────────────────────────┐
│ 1. Event Bus (이벤트 버스)                           │
│    = 모든 통신의 중심                                │
│    - 에이전트 → 에이전트 메시지                       │
│    - 에이전트 → 중앙 상태 업데이트                    │
│    - 중앙 → 에이전트 명령/알림                        │
│    - 사용자 → 시스템 요청                            │
│    구현: Redis Pub/Sub + WebSocket                   │
├─────────────────────────────────────────────────────┤
│ 2. Shared State (공유 상태)                          │
│    = 모든 AI가 보는 하나의 진실                       │
│    - 누가 무엇을 하고 있는지 (agent_activities)       │
│    - 각 에이전트의 작업 결과 (work_artifacts)         │
│    - 공유 파일/코드 (workspace_files)                │
│    - 토론 히스토리 (discussion_threads)               │
│    구현: Redis (실시간) + SQLite (영속)               │
├─────────────────────────────────────────────────────┤
│ 3. Discussion Engine (토론 엔진)                     │
│    = AI들이 서로 대화하는 프로토콜                     │
│    - 주제 제시 → 제안 → 반박 → 평가 → 합의           │
│    - 실시간 양방향 (모든 AI가 동시에 참여)             │
│    - 라운드 기반 + 자유 토론 모드                     │
│    구현: Event Bus 위에 토론 프로토콜 계층             │
└─────────────────────────────────────────────────────┘
```

---

## 2. 에이전트 모델

### 2.1 에이전트란 무엇인가

각 AI 프로바이더는 단순한 API 호출 대상이 아니다.
**에이전트 = AI + 도구 + 컨텍스트 + 상태**.

```typescript
interface Agent {
  // ═══ 정체성 ═══
  id: string;                  // "claude-code"
  name: string;                // "Claude Code"
  role: AgentRole;             // Commander | Architect | Engineer | ...
  score: number;               // 95

  // ═══ 능력 (도구) ═══
  tools: AgentTools;           // 에이전트가 실행할 수 있는 것들

  // ═══ 상태 (실시간, 모든 AI가 볼 수 있음) ═══
  state: AgentState;

  // ═══ 실행 엔진 ═══
  executor: AgentExecutor;     // subprocess | API | local
}

interface AgentTools {
  // 파일 시스템
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  editFile(path: string, changes: EditChange[]): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;

  // 코드 실행
  runCommand(cmd: string, args: string[]): Promise<CommandResult>;
  runTest(testPath: string): Promise<TestResult>;

  // 검색
  searchCode(query: string): Promise<SearchResult[]>;
  searchFiles(pattern: string): Promise<string[]>;

  // Git
  gitDiff(): Promise<string>;
  gitCommit(message: string): Promise<void>;
  gitStatus(): Promise<string>;

  // 소통 (다른 에이전트와)
  sendMessage(to: string, content: string): Promise<void>;
  broadcast(content: string): Promise<void>;
  requestReview(artifactId: string, reviewers: string[]): Promise<ReviewResult[]>;
}

interface AgentState {
  status: 'idle' | 'thinking' | 'working' | 'discussing' | 'reviewing' | 'waiting' | 'error';
  currentTask: string | null;           // 지금 하고 있는 일
  currentFiles: string[];               // 지금 보고 있는 파일들
  lastAction: AgentAction | null;       // 마지막 행동
  lastActionAt: number;
  artifacts: WorkArtifact[];            // 이 에이전트가 만든 결과물들
  messageCount: number;                 // 주고받은 메시지 수
  uptime: number;                       // 활성 시간
}
```

### 2.2 9개 에이전트 역할

| 에이전트 | 역할 | 핵심 도구 | 자율 행동 범위 |
|---------|------|-----------|--------------|
| **claude-code** (95) | Commander ★ | 전체 도구 | 모든 에이전트에게 명령, 최종 승인, 아키텍처 결정 |
| **opencode** (90) | Architect | read, write, search, run | 설계 문서 작성, 구조 변경, 75+ LLM 활용 |
| **gemini** (85) | Designer | read, write, create, search | UI/UX 파일 생성, 디자인 리뷰, 멀티모달 분석 |
| **gemini-api** (85) | Analyst | read, search, run | 데이터 분석, API 검증, 성능 리포트 생성 |
| **codex** (83) | Engineer | read, write, edit, run, test | 코드 작성, 알고리즘 구현, 테스트 작성 |
| **aider** (82) | Engineer | read, edit, git | 대규모 리팩토링, Git 커밋, 코드 수정 |
| **cursor-agent** (78) | Reviewer | read, search, run | 코드 리뷰, 버그 탐지, 품질 분석 |
| **copilot** (75) | Researcher | read, search | 정보 수집, 문서 조사, 코드 완성 |
| **openrouter** (75) | Generalist | read, search, run | 무료 LLM 활용, 범용 작업, 비용 0 |
| **vllm** (70) | Validator | read, run, test | 로컬 검증, 테스트 실행, 결과 확인 |

### 2.3 에이전트 실행 모델

```
사용자: "auth 모듈에 JWT 검증 추가해"

┌─────────────────────────────────────────────────────┐
│ Commander (claude-code) 가 받음                      │
│                                                      │
│ 1. 작업 분석                                         │
│    → 공유 상태에서 현재 코드 구조 확인                 │
│    → 복잡도 판단: 6 (중간)                            │
│    → 결정: codex에게 구현 위임, cursor-agent에 리뷰    │
│                                                      │
│ 2. 작업 위임 (Event Bus)                              │
│    → codex에게: "auth/jwt.ts 작성해. 스펙은 이거야"    │
│    → cursor-agent에게: "codex 완료 후 리뷰해"          │
│                                                      │
│ 3. 모든 에이전트가 실시간으로 봄                       │
│    → 공유 상태: codex.status = 'working'              │
│    → 공유 상태: codex.currentFiles = ['auth/jwt.ts']  │
│    → gemini: "나도 보고 있어, UI 쪽 영향 체크할게"      │
└─────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ codex (Engineer) 실행                                │
│                                                      │
│ 1. readFile('src/auth/index.ts')     ← 에이전트 도구  │
│ 2. searchCode('middleware')          ← 에이전트 도구  │
│ 3. createFile('src/auth/jwt.ts', code) ← 에이전트 도구│
│ 4. editFile('src/auth/index.ts', ...) ← 에이전트 도구 │
│ 5. runTest('tests/auth/')            ← 에이전트 도구  │
│                                                      │
│ 매 행동마다:                                          │
│   → Event Bus로 행동 브로드캐스트                     │
│   → 공유 상태 업데이트                                │
│   → 다른 에이전트들이 실시간으로 관찰                  │
└─────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ cursor-agent (Reviewer) 자동 시작                    │
│                                                      │
│ codex의 artifacts를 공유 상태에서 확인:                │
│ 1. readFile('src/auth/jwt.ts')       ← codex가 만든것│
│ 2. 코드 리뷰 수행                                    │
│ 3. sendMessage('codex', '라인 23 보안 이슈 있음')     │
│                                                      │
│ → codex가 메시지 수신 → 수정 → 재제출                 │
│ → cursor-agent 재리뷰 → 승인                         │
│ → Commander에게 완료 보고                             │
└─────────────────────────────────────────────────────┘
```

---

## 3. 공유 상태 (Shared State)

### 3.1 구조

모든 에이전트가 읽고 쓸 수 있는 **하나의 진실**.

```typescript
interface SharedState {
  // ═══ 에이전트 활동 (실시간) ═══
  agents: Record<string, AgentState>;
  // 예: agents['codex'].status = 'working'
  //     agents['codex'].currentTask = 'JWT 검증 구현'
  //     agents['codex'].currentFiles = ['src/auth/jwt.ts']

  // ═══ 작업 결과물 ═══
  artifacts: WorkArtifact[];
  // 예: { id, agentId: 'codex', type: 'file_created', path: 'src/auth/jwt.ts',
  //       content: '...', timestamp, reviewStatus: 'pending' }

  // ═══ 메시지 (에이전트 간 소통) ═══
  messages: AgentMessage[];
  // 예: { from: 'cursor-agent', to: 'codex', content: '라인 23 보안 이슈',
  //       type: 'review_comment', timestamp }

  // ═══ 토론 ═══
  discussions: Discussion[];

  // ═══ 작업 큐 ═══
  taskQueue: Task[];

  // ═══ 워크스페이스 ═══
  workspace: {
    projectPath: string;
    activeFiles: Map<string, string>;  // 에이전트가 수정 중인 파일 락
  };
}
```

### 3.2 공유 상태 저장소

```
┌──────────────────────────────────────────────┐
│            Shared State Store                 │
│                                               │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │ Redis        │    │ SQLite              │  │
│  │ (실시간)     │    │ (영속)               │  │
│  │              │    │                     │  │
│  │ agent:state  │    │ tasks               │  │
│  │ agent:msgs   │    │ artifacts           │  │
│  │ discussion:* │    │ discussions         │  │
│  │ workspace:*  │    │ messages            │  │
│  │ locks:*      │    │ metrics             │  │
│  └─────────────┘    └─────────────────────┘  │
│         │                     │               │
│         └──────┬──────────────┘               │
│                ▼                              │
│  ┌─────────────────────────────┐              │
│  │ State Sync                   │              │
│  │ Redis ←→ SQLite 양방향 동기  │              │
│  └─────────────────────────────┘              │
└──────────────────────────────────────────────┘
```

### 3.3 Redis 키 구조

```
# 에이전트 상태 (실시간)
nco:agent:{id}:state          → JSON AgentState (TTL: 없음, 상시 갱신)
nco:agent:{id}:heartbeat      → timestamp (TTL: 60s)

# 에이전트 간 메시지
nco:messages:{from}:{to}      → List<AgentMessage>
nco:messages:broadcast         → List<AgentMessage>

# 토론
nco:discussion:{sessionId}     → JSON Discussion
nco:discussion:{sessionId}:msgs → List<DiscussionMessage>

# 작업 결과물
nco:artifact:{id}              → JSON WorkArtifact
nco:artifacts:recent           → Sorted Set (score=timestamp)

# 워크스페이스 락
nco:lock:file:{path}           → agentId (TTL: 300s)

# 작업 큐
nco:queue:{providerId}         → BullMQ Queue

# Pub/Sub 채널
nco:events                     → 전체 이벤트 스트림
nco:events:{agentId}           → 특정 에이전트 이벤트
nco:events:discussion:{id}     → 토론 이벤트
```

---

## 4. Event Bus (이벤트 버스)

### 4.1 구조

```
모든 통신은 Event Bus를 통한다.

Agent ──publish──▶ Event Bus ──subscribe──▶ Agent
                      │
                      ├──▶ Shared State (자동 갱신)
                      ├──▶ WebSocket (사용자에게 전달)
                      ├──▶ SQLite (영속 저장)
                      └──▶ Discussion Engine (토론 라우팅)
```

### 4.2 이벤트 유형

```typescript
// ═══ 에이전트 생명주기 ═══
type AgentEvent =
  | { type: 'agent:online',     agentId: string }
  | { type: 'agent:offline',    agentId: string }
  | { type: 'agent:status',     agentId: string, status: AgentStatus }
  | { type: 'agent:heartbeat',  agentId: string, timestamp: number }

// ═══ 에이전트 행동 (핵심 — 모든 AI가 이것을 본다) ═══
type ActionEvent =
  | { type: 'action:read',      agentId: string, path: string }
  | { type: 'action:write',     agentId: string, path: string, content: string }
  | { type: 'action:edit',      agentId: string, path: string, changes: EditChange[] }
  | { type: 'action:delete',    agentId: string, path: string }
  | { type: 'action:create',    agentId: string, path: string, content: string }
  | { type: 'action:run',       agentId: string, command: string, output: string }
  | { type: 'action:test',      agentId: string, testPath: string, result: TestResult }
  | { type: 'action:search',    agentId: string, query: string, results: SearchResult[] }
  | { type: 'action:git',       agentId: string, operation: string, detail: string }

// ═══ 에이전트 간 소통 ═══
type MessageEvent =
  | { type: 'message:direct',   from: string, to: string, content: string }
  | { type: 'message:broadcast', from: string, content: string }
  | { type: 'message:review',   from: string, to: string, artifactId: string, comments: string }
  | { type: 'message:approve',  from: string, artifactId: string }
  | { type: 'message:reject',   from: string, artifactId: string, reason: string }

// ═══ 작업 ═══
type TaskEvent =
  | { type: 'task:created',     taskId: string, assignee: string, prompt: string }
  | { type: 'task:started',     taskId: string, agentId: string }
  | { type: 'task:progress',    taskId: string, agentId: string, progress: number, detail: string }
  | { type: 'task:chunk',       taskId: string, agentId: string, chunk: string }
  | { type: 'task:completed',   taskId: string, agentId: string, result: any }
  | { type: 'task:failed',      taskId: string, agentId: string, error: string }
  | { type: 'task:delegated',   taskId: string, from: string, to: string, reason: string }

// ═══ 토론 ═══
type DiscussionEvent =
  | { type: 'discussion:started',           sessionId: string, topic: string, participants: string[] }
  | { type: 'discussion:message',           sessionId: string, from: string, content: string, round: number }
  | { type: 'discussion:round_started',     sessionId: string, round: number }
  | { type: 'discussion:round_completed',   sessionId: string, round: number, consensusRate: number }
  | { type: 'discussion:evaluation',        sessionId: string, from: string, scores: Record<string, number> }
  | { type: 'discussion:vote',              sessionId: string, from: string, choice: string, reason: string }
  | { type: 'discussion:consensus_reached', sessionId: string, rate: number, result: string }
  | { type: 'discussion:completed',         sessionId: string, report: DiscussionReport }

// ═══ 시스템 ═══
type SystemEvent =
  | { type: 'system:rate_limit', agentId: string, reason: string, retryAfter: number }
  | { type: 'system:error',     agentId: string, error: string }
  | { type: 'system:fallback',  from: string, to: string, reason: string }
```

### 4.3 구현

```typescript
// event-bus.ts
import Redis from 'ioredis';
import { EventEmitter } from 'eventemitter3';

class EventBus {
  private pub: Redis;
  private sub: Redis;
  private local: EventEmitter;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.local = new EventEmitter();

    // Redis Pub/Sub → 로컬 이벤트
    this.sub.subscribe('nco:events');
    this.sub.on('message', (channel, message) => {
      const event = JSON.parse(message);
      this.local.emit(event.type, event);
      this.local.emit('*', event);  // 와일드카드 리스너
    });
  }

  // 이벤트 발행 (모든 구독자에게)
  async publish(event: NCOEvent): Promise<void> {
    const enriched = {
      ...event,
      id: nanoid(),
      timestamp: Date.now()
    };

    // 1. Redis Pub/Sub (다른 프로세스/서비스에게)
    await this.pub.publish('nco:events', JSON.stringify(enriched));

    // 2. 공유 상태 자동 갱신
    await this.updateSharedState(enriched);

    // 3. SQLite 영속 저장 (중요 이벤트만)
    if (this.shouldPersist(enriched)) {
      await this.persistEvent(enriched);
    }
  }

  // 구독
  on(eventType: string, handler: (event: NCOEvent) => void): void {
    this.local.on(eventType, handler);
  }

  // 에이전트별 구독
  onAgent(agentId: string, handler: (event: NCOEvent) => void): void {
    this.local.on('*', (event: NCOEvent) => {
      if ('agentId' in event && event.agentId === agentId) handler(event);
      if ('to' in event && event.to === agentId) handler(event);
    });
  }

  // 공유 상태 자동 갱신
  private async updateSharedState(event: NCOEvent): Promise<void> {
    if (event.type.startsWith('agent:')) {
      await this.pub.set(`nco:agent:${event.agentId}:state`,
        JSON.stringify(event), 'EX', 300);
    }
    if (event.type.startsWith('action:')) {
      await this.pub.zadd('nco:artifacts:recent',
        event.timestamp, JSON.stringify(event));
    }
    if (event.type.startsWith('discussion:')) {
      await this.pub.rpush(`nco:discussion:${event.sessionId}:msgs`,
        JSON.stringify(event));
    }
  }
}
```

---

## 5. 토론 엔진 (Discussion Engine)

### 5.1 토론이란

토론은 **에이전트 간 구조화된 대화**다.
Event Bus 위에서 동작하는 프로토콜이다.

```
토론 = 주제 + 참여자들 + 라운드들 + 합의

라운드 = 모든 참여자가 발언 → 상호 평가 → 합의율 계산
```

### 5.2 토론 흐름

```
사용자: /nco-discussion "이 아키텍처의 문제점과 개선 방안"

════════════════════════════════════════════════════════
  Phase 1: 세션 생성
════════════════════════════════════════════════════════

  Commander(claude-code)가:
  1. 복잡도 분석 → 7
  2. 참여자 자동 선정: opencode(Architect), gemini(Designer), codex(Engineer)
  3. 세션 생성 → Event Bus로 discussion:started 발행
  4. 모든 에이전트가 공유 상태에서 토론 시작을 봄

════════════════════════════════════════════════════════
  Phase 2: Round 1 — 독립 제안 (병렬)
════════════════════════════════════════════════════════

  각 에이전트가 동시에 작업:

  opencode: "아키텍처 분석 중..."
    → action:read 'src/core/**'           ← 코드를 직접 읽음
    → action:search 'dependency injection' ← 패턴 검색
    → discussion:message "제안 A: 모듈 분리 + DI 패턴 도입"

  gemini: "UI 영향 분석 중..."
    → action:read 'src/components/**'
    → discussion:message "제안 B: 컴포넌트 트리 최적화"

  codex: "성능 프로파일링 중..."
    → action:run 'npm run benchmark'       ← 실제 실행
    → discussion:message "제안 C: 핫패스 최적화, 벤치마크 결과 첨부"

  ★ 핵심: 에이전트들이 실제로 코드를 읽고 실행한 결과를 기반으로 제안
  ★ 핵심: 모든 행동(action:*)이 Event Bus로 브로드캐스트 → 다른 AI도 봄

════════════════════════════════════════════════════════
  Phase 3: Round 2 — 상호 평가
════════════════════════════════════════════════════════

  공유 상태에서 모든 제안을 확인한 각 에이전트가:

  opencode → codex 제안 평가:
    "벤치마크 결과 좋지만, DI 없이 핫패스만 최적화하면 유지보수 문제"
    점수: 7/10

  codex → opencode 제안 평가:
    "DI 패턴 동의, 하지만 런타임 오버헤드 우려"
    → action:run 'node benchmark-di.js'    ← 직접 검증
    점수: 8/10

  gemini → 둘 다 평가:
    "UI 관점에서 opencode 제안이 컴포넌트 리렌더 줄임"
    점수: opencode 9/10, codex 7/10

════════════════════════════════════════════════════════
  Phase 4: 합의 도출
════════════════════════════════════════════════════════

  합의율 계산 (가중치: 에이전트 점수 기반):
    opencode(90점): A안 지지
    codex(83점): A+C 혼합 지지
    gemini(85점): A안 지지

  합의율: 87% → 임계값(80%) 초과 → 합의 달성

════════════════════════════════════════════════════════
  Phase 5: 최종 보고서
════════════════════════════════════════════════════════

  Commander가 종합:
  - 채택: opencode 제안 (DI 패턴) + codex 핫패스 최적화 부분 통합
  - 근거: 벤치마크 데이터 + UI 리렌더 분석
  - 반론: codex의 DI 오버헤드 우려 → 해결책 제시
  - 실행 계획: Phase별 구현 순서

  → WebSocket으로 사용자에게 실시간 스트리밍
  → 공유 상태에 보고서 저장
  → 모든 에이전트가 결과 확인
```

### 5.3 자유 토론 모드 (Realtime)

라운드 없이 **자유롭게 대화**하는 모드:

```typescript
// 실시간 자유 토론
// 에이전트들이 Event Bus를 통해 자유롭게 발언

// opencode가 발언
eventBus.publish({
  type: 'discussion:message',
  sessionId,
  from: 'opencode',
  content: '이 부분 동의 안 해. 증거 보여줄게.',
  round: null  // 라운드 없음 = 자유 토론
});

// codex가 즉시 반응 (다른 에이전트의 메시지를 구독 중)
eventBus.on('discussion:message', async (event) => {
  if (event.sessionId === mySession && event.from !== 'codex') {
    // 다른 AI의 발언을 보고 즉시 응답
    const response = await codexAgent.think(event.content);
    eventBus.publish({
      type: 'discussion:message',
      sessionId,
      from: 'codex',
      content: response
    });
  }
});
```

---

## 6. 에이전트 실행 엔진

### 6.1 CLI 에이전트 실행

```typescript
// 각 CLI AI는 subprocess로 실행
// 하지만 단순 프롬프트 파이프가 아님
// 에이전트 도구를 프롬프트에 주입하여 AI가 도구를 호출하게 함

class CLIAgentExecutor {
  async execute(agent: Agent, task: AgentTask): Promise<AgentResult> {
    // 1. 에이전트 컨텍스트 구성
    const context = await this.buildContext(agent, task);

    // 2. 시스템 프롬프트에 도구 + 공유 상태 주입
    const systemPrompt = `
당신은 NCO 팀의 ${agent.role}(${agent.name})입니다.

## 현재 팀 상태
${await this.getTeamStatus()}

## 현재 토론/작업
${context.currentDiscussion || '없음'}

## 다른 에이전트들의 최근 행동
${await this.getRecentActions()}

## 사용 가능한 도구
다음 도구를 호출할 수 있습니다. JSON 형식으로 호출하세요:
- read_file(path): 파일 읽기
- write_file(path, content): 파일 쓰기
- edit_file(path, changes): 파일 수정
- delete_file(path): 파일 삭제
- create_file(path, content): 파일 생성
- run_command(cmd): 명령 실행
- send_message(to, content): 다른 에이전트에게 메시지
- broadcast(content): 전체 브로드캐스트

## 규칙
- 작업 전 반드시 관련 파일을 읽을 것
- 수정 후 테스트를 실행할 것
- 중요 결정은 Commander에게 보고할 것
- 다른 에이전트의 작업 영역 파일을 수정할 때 메시지로 알릴 것
    `.trim();

    // 3. AI 실행 (subprocess 또는 API)
    const proc = execa(agent.command, [...agent.args], {
      input: JSON.stringify({ systemPrompt, prompt: task.prompt }),
      timeout: 300_000
    });

    // 4. 출력 파싱 — 도구 호출 감지 및 실행
    let fullOutput = '';
    for await (const chunk of proc.stdout) {
      const text = chunk.toString();
      fullOutput += text;

      // 도구 호출 감지
      const toolCalls = this.parseToolCalls(text);
      for (const call of toolCalls) {
        // 도구 실행
        const result = await this.executeTool(agent, call);

        // Event Bus로 행동 브로드캐스트
        await eventBus.publish({
          type: `action:${call.tool}`,
          agentId: agent.id,
          ...call.args,
          result
        });

        // 도구 결과를 AI에게 피드백
        proc.stdin.write(JSON.stringify({ toolResult: result }));
      }

      // 스트리밍 출력
      await eventBus.publish({
        type: 'task:chunk',
        taskId: task.id,
        agentId: agent.id,
        chunk: text
      });
    }

    return { output: fullOutput, artifacts: this.collectArtifacts() };
  }

  // 도구 실행
  private async executeTool(agent: Agent, call: ToolCall): Promise<any> {
    switch (call.tool) {
      case 'read_file':
        return fs.readFile(call.args.path, 'utf-8');

      case 'write_file':
        // 파일 락 확인
        const lockHolder = await redis.get(`nco:lock:file:${call.args.path}`);
        if (lockHolder && lockHolder !== agent.id) {
          // 다른 에이전트가 수정 중 → 메시지로 알림
          await eventBus.publish({
            type: 'message:direct',
            from: agent.id,
            to: lockHolder,
            content: `${call.args.path} 수정하려는데, 지금 작업 중이야?`
          });
          throw new Error(`File locked by ${lockHolder}`);
        }
        // 락 획득 후 쓰기
        await redis.set(`nco:lock:file:${call.args.path}`, agent.id, 'EX', 300);
        await fs.writeFile(call.args.path, call.args.content);
        return { ok: true };

      case 'edit_file':
        // write_file과 동일한 락 로직 + diff 적용
        ...

      case 'run_command':
        const { stdout, stderr } = await execa(call.args.cmd, { shell: true, timeout: 60000 });
        return { stdout, stderr };

      case 'send_message':
        await eventBus.publish({
          type: 'message:direct',
          from: agent.id,
          to: call.args.to,
          content: call.args.content
        });
        return { sent: true };

      case 'broadcast':
        await eventBus.publish({
          type: 'message:broadcast',
          from: agent.id,
          content: call.args.content
        });
        return { sent: true };
    }
  }
}
```

### 6.2 API 에이전트 실행 (vLLM, Gemini API)

```typescript
class APIAgentExecutor {
  async execute(agent: Agent, task: AgentTask): Promise<AgentResult> {
    const client = new OpenAI({
      baseURL: agent.endpoint, // vLLM: http://localhost:8000/v1
      apiKey: agent.apiKeyRef ? process.env[agent.apiKeyRef] : 'not-needed'
    });

    // 동일한 시스템 프롬프트 (도구 + 팀 상태 + 공유 컨텍스트)
    const systemPrompt = await this.buildAgentPrompt(agent);

    const stream = await client.chat.completions.create({
      model: agent.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task.prompt }
      ],
      stream: true,
      tools: this.getToolDefinitions() // function calling 지원 시
    });

    for await (const chunk of stream) {
      // 도구 호출 + 스트리밍 + Event Bus 브로드캐스트
      // CLI 에이전트와 동일한 패턴
    }
  }
}
```

---

## 7. 프로젝트 구조 (v3)

```
/opt/neural-cli-orchestrator/
│
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs
├── .env
│
├── config/
│   ├── topology.json
│   └── ai-providers.json
│
├── src/
│   ├── index.ts                    # 엔트리포인트
│   │
│   ├── core/                       # ★ 핵심 3축
│   │   ├── event-bus.ts            # 이벤트 버스 (Redis Pub/Sub)
│   │   ├── shared-state.ts         # 공유 상태 관리
│   │   └── discussion-engine.ts    # 토론 엔진
│   │
│   ├── agent/                      # ★ 에이전트 시스템
│   │   ├── agent.ts                # 에이전트 인터페이스
│   │   ├── agent-manager.ts        # 에이전트 생명주기 관리
│   │   ├── agent-tools.ts          # 에이전트 도구 (read/write/edit/delete/create/run)
│   │   ├── cli-executor.ts         # CLI AI 실행기 (subprocess)
│   │   ├── api-executor.ts         # API AI 실행기 (vLLM, Gemini)
│   │   ├── tool-parser.ts          # AI 출력에서 도구 호출 파싱
│   │   └── providers/              # 프로바이더별 설정
│   │       ├── claude-code.ts
│   │       ├── opencode.ts
│   │       ├── gemini.ts
│   │       ├── gemini-api.ts
│   │       ├── codex.ts
│   │       ├── aider.ts
│   │       ├── cursor-agent.ts
│   │       ├── copilot.ts
│   │       └── vllm.ts
│   │
│   ├── server/                     # HTTP/WS 서버 (인터페이스 계층)
│   │   ├── gateway.ts              # Fastify (6200)
│   │   ├── websocket.ts            # WebSocket (6201)
│   │   ├── sse.ts                  # SSE 스트리밍
│   │   └── routes/                 # API 라우트 (대시보드 호환)
│   │       ├── health.ts
│   │       ├── providers.ts
│   │       ├── daemons.ts
│   │       ├── tasks.ts
│   │       ├── chat.ts
│   │       ├── discussions.ts
│   │       ├── realtime.ts
│   │       ├── agent-api.ts
│   │       ├── rate-limits.ts
│   │       ├── plans.ts
│   │       ├── mesh.ts
│   │       └── ... (대시보드 호환 라우트)
│   │
│   ├── storage/                    # 저장소
│   │   ├── database.ts             # SQLite (WAL)
│   │   ├── migrations.ts           # 마이그레이션
│   │   ├── redis.ts                # Redis
│   │   └── repos/                  # 데이터 접근
│   │       ├── task-repo.ts
│   │       ├── discussion-repo.ts
│   │       ├── artifact-repo.ts
│   │       ├── message-repo.ts
│   │       └── metrics-repo.ts
│   │
│   ├── queue/                      # BullMQ (에이전트 작업 큐)
│   │   ├── factory.ts
│   │   └── processor.ts
│   │
│   ├── mcp/                        # MCP 서버 (Claude Code 통합)
│   │   └── server.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── config.ts
│       └── id.ts
│
├── db/
│   └── migrations/
│
├── .claude/
│   ├── settings.json
│   └── commands/
│
└── tests/
```

---

## 8. DB 스키마 (v3 — 에이전트 중심)

```sql
-- ═══════════════════════════════
-- 에이전트 (중심 테이블)
-- ═══════════════════════════════
CREATE TABLE agents (
  id TEXT PRIMARY KEY,              -- 'claude-code', 'codex', ...
  name TEXT NOT NULL,
  role TEXT NOT NULL,               -- Commander, Architect, Engineer, ...
  score INTEGER DEFAULT 50,
  type TEXT NOT NULL,               -- 'cli', 'api', 'local'
  model TEXT,
  command TEXT,
  args_json TEXT DEFAULT '[]',
  endpoint TEXT,
  api_key_ref TEXT,
  capabilities_json TEXT DEFAULT '[]',
  permissions_json TEXT DEFAULT '{}',
  persona_json TEXT DEFAULT '{}',
  concurrency INTEGER DEFAULT 4,
  rate_limit_rpm INTEGER DEFAULT 20,
  cost TEXT DEFAULT 'free',
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'offline',
  last_heartbeat TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════
-- 에이전트 행동 로그 (핵심 — 모든 행동 기록)
-- ═══════════════════════════════
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_type TEXT NOT NULL,        -- read, write, edit, delete, create, run, search, git, message
  target TEXT,                      -- 파일 경로 또는 대상
  detail_json TEXT,                 -- 행동 상세 (변경 내용, 명령 출력 등)
  task_id TEXT,                     -- 관련 작업
  session_id TEXT,                  -- 관련 토론 세션
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_actions_agent ON agent_actions(agent_id, created_at DESC);
CREATE INDEX idx_actions_task ON agent_actions(task_id);
CREATE INDEX idx_actions_type ON agent_actions(action_type);

-- ═══════════════════════════════
-- 에이전트 간 메시지 (소통)
-- ═══════════════════════════════
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,                    -- NULL = broadcast
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'direct', -- direct, broadcast, review, approve, reject
  artifact_id TEXT,                 -- 관련 결과물
  session_id TEXT,                  -- 관련 토론
  read_at TEXT,                     -- 수신 확인
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_from ON agent_messages(from_agent);
CREATE INDEX idx_messages_to ON agent_messages(to_agent);
CREATE INDEX idx_messages_session ON agent_messages(session_id);

-- ═══════════════════════════════
-- 작업 결과물 (에이전트가 만든 것)
-- ═══════════════════════════════
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT,
  artifact_type TEXT NOT NULL,      -- file_created, file_modified, test_result, analysis, proposal
  path TEXT,                        -- 파일 경로 (파일 관련 시)
  content TEXT,                     -- 내용 또는 결과
  review_status TEXT DEFAULT 'pending', -- pending, approved, rejected, needs_revision
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_artifacts_agent ON artifacts(agent_id);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_review ON artifacts(review_status);

-- ═══════════════════════════════
-- 작업
-- ═══════════════════════════════
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'task',
  prompt TEXT NOT NULL,
  assigned_to TEXT REFERENCES agents(id),
  delegated_from TEXT,              -- 위임한 에이전트
  status TEXT DEFAULT 'pending',
  progress REAL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  workspace_id TEXT DEFAULT 'default',
  parent_task_id TEXT,              -- 하위 작업
  priority INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ═══════════════════════════════
-- 토론 세션
-- ═══════════════════════════════
CREATE TABLE discussions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  mode TEXT DEFAULT 'discussion',   -- discussion, realtime, parallel, consensus, hive
  status TEXT DEFAULT 'active',
  participants_json TEXT NOT NULL,
  initiator TEXT NOT NULL,          -- 토론을 시작한 에이전트
  current_round INTEGER DEFAULT 0,
  max_rounds INTEGER DEFAULT 3,
  consensus_threshold REAL DEFAULT 0.8,
  consensus_rate REAL DEFAULT 0,
  result_json TEXT,                 -- 최종 합의 결과
  report TEXT,                      -- 최종 보고서
  task_id TEXT,                     -- 관련 작업
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

-- ═══════════════════════════════
-- 토론 메시지 (라운드별)
-- ═══════════════════════════════
CREATE TABLE discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  round INTEGER,                    -- NULL = 자유 토론
  message_type TEXT DEFAULT 'proposal', -- proposal, evaluation, rebuttal, vote, synthesis
  content TEXT NOT NULL,
  scores_json TEXT,                 -- 평가 점수 (evaluation 시)
  vote_choice TEXT,                 -- 투표 선택 (vote 시)
  vote_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_disc_msgs ON discussion_messages(discussion_id, round);

-- ═══════════════════════════════
-- 파일 락 (동시 수정 방지)
-- ═══════════════════════════════
CREATE TABLE file_locks (
  path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  acquired_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- ═══════════════════════════════
-- Rate Limit
-- ═══════════════════════════════
CREATE TABLE rate_limit_state (
  agent_id TEXT PRIMARY KEY,
  is_limited INTEGER DEFAULT 0,
  reason TEXT,
  limited_at TEXT,
  reset_at TEXT,
  consecutive_failures INTEGER DEFAULT 0
);

-- ═══════════════════════════════
-- 메트릭
-- ═══════════════════════════════
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_metrics ON metrics(agent_id, metric_type, created_at DESC);

-- ═══════════════════════════════
-- 스키마 버전
-- ═══════════════════════════════
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  applied_at TEXT DEFAULT (datetime('now'))
);
```

---

## 9. 구현 순서 (핵심 먼저)

```
═══════════════════════════════════════════════════════
Phase 1: 뼈대 + Event Bus + 공유 상태
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: 이벤트를 발행/구독할 수 있고,
                     공유 상태를 읽고 쓸 수 있다.

  ├── 프로젝트 초기화 (package.json, tsconfig)
  ├── config/ 복사 (topology.json, ai-providers.json)
  ├── storage/database.ts + 마이그레이션
  ├── storage/redis.ts
  ├── core/event-bus.ts          ★ 핵심 1
  ├── core/shared-state.ts       ★ 핵심 2
  ├── utils/ (logger, config, id)
  └── 검증: EventBus.publish() → Redis로 전파 확인

═══════════════════════════════════════════════════════
Phase 2: 에이전트 시스템
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: AI를 에이전트로 실행할 수 있다.
                     에이전트가 파일을 읽고 쓰고 실행한다.
                     모든 행동이 Event Bus로 브로드캐스트된다.

  ├── agent/agent.ts             ★ 에이전트 인터페이스
  ├── agent/agent-tools.ts       ★ 도구 (read/write/edit/delete/create/run)
  ├── agent/cli-executor.ts      ★ CLI 실행 (subprocess)
  ├── agent/api-executor.ts      ★ API 실행 (vLLM, Gemini)
  ├── agent/tool-parser.ts         도구 호출 파싱
  ├── agent/agent-manager.ts       에이전트 생명주기
  ├── agent/providers/ (9개)
  └── 검증: codex 에이전트 실행
            → 파일 읽기 → 코드 작성 → 테스트 실행
            → 모든 행동이 Event Bus에 나타남
            → 공유 상태에서 codex.status = 'working' 확인

═══════════════════════════════════════════════════════
Phase 3: 토론 엔진
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: AI들이 토론한다.
                     서로의 제안을 보고 평가하고 합의한다.
                     모든 과정이 실시간으로 관찰 가능하다.

  ├── core/discussion-engine.ts  ★ 핵심 3
  │   ├── 라운드 기반 토론
  │   ├── 자유 토론 모드
  │   ├── 합의 계산 (가중치 투표)
  │   ├── 보고서 생성
  │   └── Event Bus 연동
  └── 검증: /nco-discussion "주제"
            → 3개 AI가 제안 → 상호 평가 → 합의 → 보고서
            → 전 과정 Event Bus에서 실시간 관찰

═══════════════════════════════════════════════════════
Phase 4: 실시간 통신 (사용자 인터페이스)
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: 사용자가 WebSocket으로 모든 것을
                     실시간으로 볼 수 있다.

  ├── server/gateway.ts          Fastify (6200)
  ├── server/websocket.ts        WebSocket (6201)
  │   └── Event Bus ←→ WebSocket 브릿지
  │       (Event Bus의 이벤트를 WebSocket으로 중계)
  ├── server/sse.ts              SSE 스트리밍
  ├── server/routes/health.ts
  ├── server/routes/providers.ts
  ├── server/routes/tasks.ts
  ├── server/routes/discussions.ts
  ├── server/routes/realtime.ts
  └── 검증: WebSocket 연결 → 에이전트 행동이 실시간 수신
            토론 시작 → 모든 라운드가 실시간 스트리밍

═══════════════════════════════════════════════════════
Phase 5: 대시보드 호환 API
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: NCO-Dashboard와 연결된다.

  ├── server/routes/ 나머지 전체
  │   ├── daemons.ts
  │   ├── chat.ts
  │   ├── rate-limits.ts
  │   ├── plans.ts
  │   ├── agent-api.ts
  │   ├── mesh.ts
  │   ├── ...
  ├── queue/factory.ts (BullMQ)
  ├── queue/processor.ts
  └── 검증: Dashboard 시작 → 모든 페이지 정상 동작

═══════════════════════════════════════════════════════
Phase 6: MCP + Claude Code 통합
═══════════════════════════════════════════════════════
  ├── mcp/server.ts (26개 도구)
  ├── .claude/commands/ (45+개)
  ├── .claude/settings.json
  └── 검증: /nco-discussion → MCP로 토론 시작

═══════════════════════════════════════════════════════
Phase 7: 완성
═══════════════════════════════════════════════════════
  ├── 에이전트 자율 루프 (think→act→observe)
  ├── Smart Router (복잡도→AI 자동 선택)
  ├── Smart Failover (장애→자동 전환)
  ├── ecosystem.config.cjs (PM2)
  ├── 테스트
  └── 문서화
```

---

## 10. 핵심 검증 시나리오

### 시나리오 1: 에이전트 자율 실행 (Phase 2 검증)

```bash
# codex에게 작업 위임
POST /api/task
{ "ai": "codex", "prompt": "src/utils/에 날짜 포맷 유틸 함수 만들어" }

# 기대 결과:
# 1. codex가 src/utils/ 디렉토리를 읽음 (action:read)
# 2. date-format.ts 파일 생성 (action:create)
# 3. 테스트 파일 생성 (action:create)
# 4. 테스트 실행 (action:run)
# 5. 모든 행동이 Event Bus로 브로드캐스트
# 6. 공유 상태에 결과물(artifact) 등록
# 7. 다른 에이전트들이 이 과정을 볼 수 있음
```

### 시나리오 2: 토론 (Phase 3 검증)

```bash
# 3개 AI 토론
POST /api/realtime/discussion
{ "prompt": "이 프로젝트의 에러 핸들링 전략", "providers": ["opencode","codex","gemini"] }

# 기대 결과:
# 1. 각 AI가 독립적으로 코드를 분석 (action:read, action:search)
# 2. Round 1: 각자 제안 (discussion:message)
# 3. Round 2: 서로 평가 (discussion:evaluation)
# 4. 합의율 계산 → 80% 이상이면 합의
# 5. Commander가 보고서 생성
# 6. WebSocket으로 전체 과정 실시간 스트리밍
```

### 시나리오 3: 에이전트 간 소통 (Phase 2-3 검증)

```bash
# codex가 파일 수정 → cursor-agent가 자동 리뷰

# 1. codex: action:edit src/auth/jwt.ts
# 2. Event Bus → cursor-agent가 감지
# 3. cursor-agent: action:read src/auth/jwt.ts (codex가 수정한 파일)
# 4. cursor-agent: message:review → codex ("라인 23 XSS 위험")
# 5. codex: message:direct → cursor-agent ("수정했어, 다시 봐줘")
# 6. codex: action:edit src/auth/jwt.ts (수정)
# 7. cursor-agent: message:approve → codex
# 8. 공유 상태: artifact.reviewStatus = 'approved'
```

---

## 11. 기술 스택 (최소화)

```
핵심만:
  fastify          — HTTP 서버
  ws               — WebSocket
  ioredis          — Redis (Event Bus + 공유 상태)
  better-sqlite3   — SQLite (영속 저장)
  bullmq           — 작업 큐
  execa            — subprocess (CLI AI)
  openai           — API AI (vLLM, Gemini)
  zod              — 검증
  pino             — 로거
  nanoid           — ID 생성
  eventemitter3    — 로컬 이벤트
  dotenv           — 환경변수

개발:
  typescript, tsx, vitest
```

---

## 12. 즉시 실행 명령

```bash
cd /home/nova/projects/neural-cli-orchestrator

npm install fastify @fastify/cors ws ioredis better-sqlite3 \
  bullmq execa openai zod pino pino-pretty nanoid \
  eventemitter3 dotenv @anthropic-ai/sdk @google/generative-ai

npm install -D typescript tsx @types/node @types/ws @types/better-sqlite3 vitest

npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --outDir dist --rootDir src --strict --esModuleInterop --declaration

# 복구 설정 파일 복사
mkdir -p config db
cp /mnt/c/Users/lovecat/recovery-snapshot-20260409/neural-cli-orchestrator-recovered/config/topology.json config/
cp /mnt/d/NCO-Dashboard/.nco-workspace/ai-providers.json config/
```

---

> **상태**: v3.0 설계 완료 — 실행 대기  
>  
> **핵심 변화**:  
> - AI는 에이전트다 (읽기/쓰기/수정/삭제/생성/실행)  
> - Event Bus가 모든 통신의 중심이다  
> - 공유 상태로 모든 에이전트가 서로를 안다  
> - 토론이 Phase 1이 아니라 Phase 3이지만, Phase 1-2가 토론의 전제조건이다  
> - 대시보드 호환은 Phase 5에서 한다 (핵심 먼저)  
>  
> 승인 시 Phase 1부터 구현 시작.
