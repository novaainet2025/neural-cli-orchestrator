# NCO 백엔드 완벽 구현 설계서 v4.0

> **작성일**: 2026-04-10
> **버전**: v4.0
> **상태**: 활성
> **요약**: NCO 백엔드 메인 아키텍처 설계 — 보안 격리, 실시간 양방향, 동기화 전략, 도구 표준, 상태 머신

---

## 0. 핵심 재정의

### NCO란 무엇인가

NCO는 **9개 AI가 하나의 팀으로 일하는 시스템**이다.

각 AI는 단순한 "프롬프트 파이프"가 아니라 **독립적인 에이전트**다.
읽고, 쓰고, 수정하고, 삭제하고, 생성할 수 있다.
모든 에이전트는 **중앙 상태**를 공유하며, 서로의 작업과 상태를 실시간으로 볼 수 있다.
그리고 그들은 **토론**한다.

### 5가지 핵심 축

```
┌─────────────────────────────────────────────────────┐
│                                                      │
│  1. Agent Autonomy (에이전트 자율성)                   │
│     각 AI는 독립 에이전트다.                           │
│     파일을 읽고, 코드를 쓰고, 테스트를 돌린다.          │
│     스스로 판단하고 실행한다.                           │
│                                                      │
│  2. Shared Awareness (공유 인식)                      │
│     모든 AI는 중앙 상태를 본다.                        │
│     누가 뭘 하고 있는지 실시간으로 안다.                 │
│     작업 결과를 서로 확인하고 참조한다.                  │
│                                                      │
│  3. Discussion Protocol (토론 프로토콜)                │
│     AI들이 서로 대화한다.                              │
│     제안하고, 반박하고, 평가하고, 합의한다.              │
│     실시간 양방향 통신으로.                             │
│                                                      │
│  4. Security Isolation (보안 격리)                    │
│     각 에이전트는 샌드박스 안에서 실행된다.              │
│     허용된 경로만 접근, 허용된 명령만 실행.              │
│     장애가 다른 에이전트에게 전파되지 않는다.             │
│                                                      │
│  5. Bidirectional Realtime (양방향 실시간)             │
│     사용자가 진행 중인 작업에 실시간 개입할 수 있다.      │
│     에이전트 행동이 즉시 사용자에게 스트리밍된다.         │
│     놓친 이벤트 없이 재연결된다.                        │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 이전 설계서와의 차이

| v2 | v3 | v4 (현재) |
|----|-----|-----------|
| AI = 프롬프트 입력 → 텍스트 출력 | AI = **에이전트** | 에이전트 + **보안 샌드박스** |
| 180개 API 나열 | 핵심 3축 중심 | **5축** (격리 + 실시간 추가) |
| 토론은 Phase 6 (나중) | 토론이 Phase 3 | 토론 Phase 3 + **실시간 개입** |
| BullMQ에 작업 넣고 기다림 | 실시간 양방향 | **시퀀스 기반 재연결** + 백프레셔 |
| AI는 서로 모름 | 중앙 상태 공유 | 중앙 상태 + **동기화 전략** |
| 도구 형식 미정의 | JSON 형식 언급 | **NCO Tool Protocol 표준** |
| 상태 전이 미정의 | pending → completed | **7단계 상태 머신** |
| gemini-api 포함 (10개) | gemini-api 포함 | **gemini-api 제거 (9개)** |
| Ollama: Qwen3-4B | Qwen3-4B | **Gemma 4 26B (NVFP4)** |

---

## 1. 아키텍처

### 1.1 시스템 전체 구조

```
                        ┌─────────────────────┐
                        │    사용자 / CLI /     │
                        │    Dashboard         │
                        └─────────┬───────────┘
                                  │ WebSocket (양방향)
                                  │ + HTTP REST
                        ┌─────────▼───────────┐
                        │   NCO Orchestrator   │
                        │   ┌───────────────┐  │
                        │   │  Event Bus     │  │  ← 모든 것의 중심
                        │   │  (실시간 통신)  │  │
                        │   └───────┬───────┘  │
                        │           │          │
                        │   ┌───────▼───────┐  │
                        │   │ Shared State   │  │  ← 중앙 상태
                        │   │ (Redis+SQLite) │  │
                        │   │ + Sync Engine  │  │  ← 양방향 동기
                        │   └───────┬───────┘  │
                        │           │          │
                        │   ┌───────▼───────┐  │
                        │   │  Sandbox       │  │  ← 보안 격리
                        │   │  Manager       │  │
                        │   └───────┬───────┘  │
                        │           │          │
                        └───────────┼──────────┘
                                    │
              ┌─────────┬───────────┼───────────┬─────────┐
              ▼         ▼           ▼           ▼         ▼
        ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
        │ Agent    ││ Agent    ││ Agent    ││ Agent    ││ Agent    │
        │ claude   ││ opencode ││ gemini   ││ aider    ││ ollama     │
        │ (95)     ││ (90)     ││ (85)     ││ (82)     ││ (75)     │
        │ Type A   ││ Type B   ││ Type B   ││ Type B   ││ Type C   │
        │          ││          ││          ││          ││          │
        │          ││          │+ codex(83) cursor(78) copilot(75) │
        │          ││          │  openrouter(75) — 총 9개 에이전트  │
        │ ┌──────┐ ││ ┌──────┐ ││ ┌──────┐ ││ ┌──────┐ ││ ┌──────┐ │
        │ │Sandbox│ ││ │Sandbox│ ││ │Sandbox│ ││ │Sandbox│ ││ │Sandbox│ │
        │ └──────┘ ││ └──────┘ ││ └──────┘ ││ └──────┘ ││ └──────┘ │
        └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘
              │           │           │           │           │
              └─────────┬─┴───────────┴───────────┴─┬─────────┘
                        │                           │
                        ▼                           ▼
                  ┌──────────┐                ┌──────────┐
                  │ Workspace│                │ Discussion│
                  │ (공유    │                │ Engine    │
                  │  파일)   │                │ (토론)    │
                  └──────────┘                └──────────┘
```

### 1.2 핵심 컴포넌트 5개

```
┌─────────────────────────────────────────────────────┐
│ 1. Event Bus (이벤트 버스)                           │
│    = 모든 통신의 중심                                │
│    - 에이전트 → 에이전트 메시지                       │
│    - 에이전트 → 중앙 상태 업데이트                    │
│    - 중앙 → 에이전트 명령/알림                        │
│    - 사용자 ↔ 시스템 양방향                          │
│    - 시퀀스 번호 기반 이벤트 순서 보장                 │
│    구현: Redis Pub/Sub + Redis Streams + WebSocket   │
├─────────────────────────────────────────────────────┤
│ 2. Shared State (공유 상태)                          │
│    = 모든 AI가 보는 하나의 진실                       │
│    - Redis (실시간) + SQLite (영속)                   │
│    - 주기적 동기화 (Redis → SQLite, 5초)              │
│    - 재시작 복원 (SQLite → Redis)                    │
│    - Config 마스터: DB (부팅 시 JSON→DB 시딩)         │
├─────────────────────────────────────────────────────┤
│ 3. Discussion Engine (토론 엔진)                     │
│    = AI들이 서로 대화하는 프로토콜                     │
│    - 라운드 기반 + 자유 토론 + 사용자 개입             │
│    구현: Event Bus 위에 토론 프로토콜 계층             │
├─────────────────────────────────────────────────────┤
│ 4. Sandbox Manager (샌드박스 관리자)                  │
│    = 에이전트 격리 및 보안                            │
│    - 파일 경로 화이트리스트                            │
│    - 명령 실행 허용/차단 목록                          │
│    - 리소스 제한 (CPU, 메모리, 시간)                   │
│    - Circuit Breaker (연속 실패 시 자동 격리)          │
│    구현: 경로 검증 + 명령 필터 + ulimit + 상태 감시    │
├─────────────────────────────────────────────────────┤
│ 5. Realtime Bridge (실시간 브릿지)                    │
│    = 사용자 ↔ 에이전트 양방향 실시간                   │
│    - WebSocket: 양방향 (에이전트 행동 수신 + 사용자 개입)│
│    - SSE: 단방향 스트리밍 (경량 클라이언트용)           │
│    - 시퀀스 기반 재연결 (놓친 이벤트 재전송)            │
│    - 백프레셔 (클라이언트 처리 속도 초과 시 스로틀)      │
│    구현: ws + Redis Streams (이벤트 시퀀싱)            │
└─────────────────────────────────────────────────────┘
```

---

## 2. 에이전트 모델

### 2.1 에이전트란 무엇인가

각 AI 프로바이더는 단순한 API 호출 대상이 아니다.
**에이전트 = AI + 도구 + 컨텍스트 + 상태 + 샌드박스**.

```typescript
interface Agent {
  // ═══ 정체성 ═══
  id: string;                  // "claude-code"
  name: string;                // "Claude Code"
  role: AgentRole;             // Commander | Architect | Engineer | ...
  score: number;               // 95

  // ═══ 능력 (도구) — 샌드박스 내에서만 ═══
  tools: AgentTools;

  // ═══ 상태 (실시간, 모든 AI가 볼 수 있음) ═══
  state: AgentState;

  // ═══ 실행 엔진 ═══
  executor: AgentExecutor;     // subprocess | API | local

  // ═══ 샌드박스 정책 ═══
  sandbox: SandboxPolicy;
}

interface AgentTools {
  // 파일 시스템 (샌드박스 경로 내에서만)
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  editFile(path: string, changes: EditChange[]): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;

  // 코드 실행 (허용 명령만)
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
  sendMessage(to: string, content: string, priority?: MessagePriority): Promise<void>;
  broadcast(content: string): Promise<void>;
  requestReview(artifactId: string, reviewers: string[]): Promise<ReviewResult[]>;
}

interface AgentState {
  status: 'idle' | 'thinking' | 'working' | 'discussing' | 'reviewing' | 'waiting' | 'error' | 'isolated';
  currentTask: string | null;
  currentFiles: string[];
  lastAction: AgentAction | null;
  lastActionAt: number;
  artifacts: WorkArtifact[];
  messageCount: number;
  uptime: number;
  health: {
    consecutiveFailures: number;  // Circuit Breaker 기준
    circuitState: 'closed' | 'open' | 'half-open';
    lastError: string | null;
  };
}

// ═══ 메시지 우선순위 ═══
type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

// ═══ 샌드박스 정책 ═══
interface SandboxPolicy {
  allowedPaths: string[];         // 접근 가능 경로 (glob)
  deniedPaths: string[];          // 접근 금지 경로
  allowedCommands: string[];      // 실행 가능 명령
  deniedCommands: string[];       // 실행 금지 명령 (패턴)
  maxFileSize: number;            // 최대 파일 쓰기 크기 (bytes)
  maxExecutionTime: number;       // 최대 명령 실행 시간 (ms)
  maxMemory: number;              // 최대 메모리 (bytes)
  maxConcurrentActions: number;   // 최대 동시 도구 호출
}
```

### 2.2 9개 에이전트 역할

| 에이전트 | 역할 | 핵심 도구 | 자율 행동 범위 |
|---------|------|-----------|--------------|
| **claude-code** (95) | Commander ★ | 전체 도구 | 모든 에이전트에게 명령, 최종 승인, 아키텍처 결정 |
| **opencode** (90) | Architect | read, write, search, run | 설계 문서 작성, 구조 변경, 75+ LLM 활용 |
| **gemini** (85) | Designer | read, write, create, search | UI/UX 파일 생성, 디자인 리뷰, 멀티모달 분석 |
| **codex** (83) | Engineer | read, write, edit, run, test | 코드 작성, 알고리즘 구현, 테스트 작성 |
| **aider** (82) | Engineer | read, edit, git | 대규모 리팩토링, Git 커밋, 코드 수정 |
| **cursor-agent** (78) | Reviewer | read, search, run | 코드 리뷰, 버그 탐지, 품질 분석 |
| **copilot** (75) | Researcher | read, search | 정보 수집, 문서 조사, 코드 완성 |
| **openrouter** (75) | Generalist | read, search, run | 무료 LLM 활용, 범용 작업, 비용 0 |
| **ollama** (75) | Validator | read, run, test | 로컬 검증, 테스트 실행, 결과 확인 (Gemma 4 26B) |

### 2.3 Ollama — Gemma 4 로컬 추론

```
모델:     gemma-4-26B-A4B-it-NVFP4
원본:     google/gemma-4-27b-it (26B 파라미터, Active 4B, MoE)
양자화:   NVFP4 (NVIDIA FP4, modelopt)
GPU:     RTX 4090 24GB
VRAM:    ~16GB 사용 (모델) + ~8GB KV cache
포트:    http://localhost:11434/v1 (OpenAI 호환)
모델경로: /mnt/d/llm-models/ollama/gemma-4-26B-A4B-it-NVFP4

설치 과정:
  1. python3 -m venv ~/ollama-env
  2. pip install ollama + transformers>=5.5.3 업그레이드
  3. gemma4_patched.py → ollama/model_executor/models/gemma4.py 덮어씌움
  4. 실행:
     source ~/ollama-env/bin/activate
     VLLM_NVFP4_GEMM_BACKEND=marlin ollama serve \
       /mnt/d/llm-models/ollama/gemma-4-26B-A4B-it-NVFP4 \
       --quantization modelopt \
       --dtype auto \
       --kv-cache-dtype fp8 \
       --gpu-memory-utilization 0.85 \
       --max-model-len 8192 \
       --max-num-seqs 4 \
       --trust-remote-code \
       --port 8000

검증 응답:
  "저는 Google DeepMind에서 개발한 오픈 가중치 대규모 언어 모델인 Gemma 4입니다."
```

### 2.4 에이전트 실행 모델

```
사용자: "auth 모듈에 JWT 검증 추가해"

┌─────────────────────────────────────────────────────┐
│ Commander (claude-code) 가 받음                      │
│                                                      │
│ 1. 작업 분석 (Smart Router)                          │
│    → 키워드 매칭 + 복잡도 점수                        │
│    → 복잡도: 6 (중간)                                │
│    → 필요 능력: code, testing                         │
│    → 결정: codex에게 구현 위임, cursor-agent에 리뷰    │
│                                                      │
│ 2. 작업 위임 (Event Bus)                              │
│    → codex에게: "auth/jwt.ts 작성해. 스펙은 이거야"    │
│    → cursor-agent에게: "codex 완료 후 리뷰해"          │
│                                                      │
│ 3. 모든 에이전트가 실시간으로 봄                       │
│    → 공유 상태: codex.status = 'working'              │
│    → 공유 상태: codex.currentFiles = ['auth/jwt.ts']  │
│    → 사용자: WebSocket으로 진행 상황 실시간 수신        │
│    → 사용자: 개입 가능 ("보안 우선으로 구현해")          │
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

  // ═══ 작업 결과물 ═══
  artifacts: WorkArtifact[];

  // ═══ 메시지 (에이전트 간 소통) ═══
  messages: AgentMessage[];

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
┌──────────────────────────────────────────────────┐
│              Shared State Store                    │
│                                                    │
│  ┌──────────────┐       ┌──────────────────────┐  │
│  │ Redis         │       │ SQLite               │  │
│  │ (실시간)      │       │ (영속)                │  │
│  │               │       │                      │  │
│  │ agent:state   │       │ tasks                │  │
│  │ agent:msgs    │       │ artifacts            │  │
│  │ discussion:*  │       │ discussions          │  │
│  │ workspace:*   │       │ messages             │  │
│  │ locks:*       │       │ metrics              │  │
│  │ sequence:*    │       │ agent_actions        │  │
│  └──────┬───────┘       └──────────┬───────────┘  │
│         │                          │               │
│         └──────────┬───────────────┘               │
│                    ▼                               │
│  ┌─────────────────────────────────────┐           │
│  │         Sync Engine                  │           │
│  │                                      │           │
│  │  ● Forward Sync (Redis → SQLite)     │           │
│  │    - 주기: 5초                       │           │
│  │    - 대상: agent_actions, messages   │           │
│  │    - 방식: 마지막 sync 이후 변경분만  │           │
│  │                                      │           │
│  │  ● Recovery Sync (SQLite → Redis)    │           │
│  │    - 시점: 서버 시작 시              │           │
│  │    - 대상: agent state, active tasks │           │
│  │    - 방식: SQLite가 진실의 소스       │           │
│  │                                      │           │
│  │  ● Event-driven Sync                 │           │
│  │    - 대상: task 완료, discussion 종료 │           │
│  │    - 방식: 즉시 양방향 기록          │           │
│  └─────────────────────────────────────┘           │
└──────────────────────────────────────────────────┘
```

### 3.3 동기화 전략 상세

```typescript
class SyncEngine {
  private lastSyncSeq: number = 0;

  // ═══ 주기적 Forward Sync (Redis → SQLite) ═══
  // 5초마다 Redis에 쌓인 변경분을 SQLite에 배치 기록
  async forwardSync(): Promise<void> {
    // Redis Stream에서 마지막 sync 이후 이벤트 조회
    const events = await this.redis.xrange(
      'nco:event-log',
      this.lastSyncSeq + 1,
      '+'
    );

    // SQLite 트랜잭션으로 배치 기록
    this.db.transaction(() => {
      for (const event of events) {
        if (event.type.startsWith('action:')) {
          this.insertAction(event);
        }
        if (event.type.startsWith('message:')) {
          this.insertMessage(event);
        }
        if (event.type === 'task:completed' || event.type === 'task:failed') {
          this.updateTask(event);
        }
      }
    })();

    this.lastSyncSeq = events[events.length - 1]?.id ?? this.lastSyncSeq;
  }

  // ═══ Recovery Sync (SQLite → Redis) — 서버 재시작 시 ═══
  async recoverySync(): Promise<void> {
    // 1. 마지막 알려진 에이전트 상태 복원
    const agents = this.db.prepare('SELECT * FROM agents WHERE enabled = 1').all();
    for (const agent of agents) {
      await this.redis.set(`nco:agent:${agent.id}:state`, JSON.stringify({
        status: 'idle',  // 재시작이므로 모두 idle
        lastKnownState: agent.status,
        restoredAt: Date.now()
      }));
    }

    // 2. 미완료 작업 복원
    const pendingTasks = this.db.prepare(
      'SELECT * FROM tasks WHERE status IN (?, ?)'
    ).all('pending', 'assigned');
    for (const task of pendingTasks) {
      await this.redis.rpush(`nco:queue:${task.assigned_to}`, JSON.stringify(task));
    }

    // 3. 활성 토론 복원
    const activeDiscussions = this.db.prepare(
      'SELECT * FROM discussions WHERE status = ?'
    ).all('active');
    for (const disc of activeDiscussions) {
      await this.redis.set(`nco:discussion:${disc.id}`, JSON.stringify(disc));
    }
  }

  // ═══ Config 시딩 (JSON → DB) — 최초 부팅 시 ═══
  async seedFromConfig(): Promise<void> {
    const config = JSON.parse(fs.readFileSync('config/ai-providers.json', 'utf-8'));

    this.db.transaction(() => {
      for (const provider of config.providers) {
        this.db.prepare(`
          INSERT OR REPLACE INTO agents (id, name, role, score, type, model, command,
            args_json, endpoint, api_key_ref, capabilities_json, permissions_json,
            persona_json, concurrency, rate_limit_rpm, cost, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          provider.id, provider.name, provider.role, provider.score,
          provider.type, provider.model, provider.command,
          JSON.stringify(provider.args), provider.endpoint, provider.apiKeyRef,
          JSON.stringify(provider.capabilities), JSON.stringify(provider.permissions),
          JSON.stringify(provider.persona), provider.concurrency,
          provider.rateLimitRpm, provider.cost, provider.enabled ? 1 : 0
        );
      }
    })();
    // 이후 DB가 마스터 — 런타임 변경은 DB에서만
  }
}
```

### 3.4 Redis 키 구조

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

# 워크스페이스 락 (Redis만 — 단일 소스)
nco:lock:file:{path}           → agentId (TTL: 300s)

# 작업 큐
nco:queue:{providerId}         → BullMQ Queue

# ═══ v4 추가: 이벤트 시퀀싱 (Redis Streams) ═══
nco:event-log                  → Redis Stream (모든 이벤트 영속 기록)
nco:event-seq                  → 글로벌 시퀀스 카운터

# Pub/Sub 채널 (실시간 전파)
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
                      ├──▶ Redis Stream (시퀀스 기록)  ← v4 추가
                      ├──▶ WebSocket (사용자에게 전달)
                      ├──▶ SQLite (Sync Engine 경유)
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
  | { type: 'agent:isolated',   agentId: string, reason: string }        // v4: Circuit Breaker

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
  | { type: 'action:denied',    agentId: string, tool: string, reason: string }    // v4: 샌드박스 차단

// ═══ 에이전트 간 소통 ═══
type MessageEvent =
  | { type: 'message:direct',   from: string, to: string, content: string,
      priority: MessagePriority, replyTo?: string }                                // v4: 우선순위+답장
  | { type: 'message:broadcast', from: string, content: string, priority: MessagePriority }
  | { type: 'message:review',   from: string, to: string, artifactId: string, comments: string }
  | { type: 'message:approve',  from: string, artifactId: string }
  | { type: 'message:reject',   from: string, artifactId: string, reason: string }
  | { type: 'message:ack',      from: string, messageId: string }                 // v4: 수신 확인

// ═══ 작업 ═══
type TaskEvent =
  | { type: 'task:created',     taskId: string, assignee: string, prompt: string }
  | { type: 'task:assigned',    taskId: string, agentId: string }                  // v4: 배정 확인
  | { type: 'task:started',     taskId: string, agentId: string }
  | { type: 'task:progress',    taskId: string, agentId: string, progress: number, detail: string }
  | { type: 'task:chunk',       taskId: string, agentId: string, chunk: string }
  | { type: 'task:reviewing',   taskId: string, reviewerId: string }               // v4: 리뷰 시작
  | { type: 'task:completed',   taskId: string, agentId: string, result: any }
  | { type: 'task:failed',      taskId: string, agentId: string, error: string }
  | { type: 'task:delegated',   taskId: string, from: string, to: string, reason: string }
  | { type: 'task:cancelled',   taskId: string, reason: string }                           // v4: 사용자 취소

// ═══ 토론 ═══
type DiscussionEvent =
  | { type: 'discussion:started',           sessionId: string, topic: string, participants: string[] }
  | { type: 'discussion:message',           sessionId: string, from: string, content: string, round: number }
  | { type: 'discussion:user_intervention', sessionId: string, content: string }   // v4: 사용자 개입
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
  | { type: 'system:circuit_open',  agentId: string, failures: number }            // v4: 회로 개방
  | { type: 'system:circuit_close', agentId: string }                              // v4: 회로 복구
  | { type: 'system:message_timeout', messageId: string, from: string, to: string } // v4: ACK 타임아웃

// ═══ v4: 모든 이벤트의 공통 엔벨로프 ═══
interface NCOEvent {
  id: string;               // nanoid (비즈니스 ID)
  streamId: string;         // Redis Stream ID (예: "1712700000000-0") — 순서/재연결 기준
  timestamp: number;
  payload: AgentEvent | ActionEvent | MessageEvent | TaskEvent | DiscussionEvent | SystemEvent;
}
```

### 4.3 구현

```typescript
// event-bus.ts
import Redis from 'ioredis';
import { EventEmitter } from 'eventemitter3';

class EventBus {
  private pub: Redis;
  private sub: Redis;
  private stream: Redis;          // v4: Redis Streams용
  private local: EventEmitter;
  private localQueue: NCOEvent[] = [];  // Redis 장애 시 로컬 버퍼 (최대 10000)

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.stream = new Redis(redisUrl);
    this.local = new EventEmitter();

    // Redis Pub/Sub → 로컬 이벤트
    this.sub.subscribe('nco:events');
    this.sub.on('message', (channel, message) => {
      const event = JSON.parse(message);
      this.local.emit(event.payload.type, event);
      this.local.emit('*', event);
    });
  }

  // 이벤트 발행 (모든 구독자에게)
  async publish(payload: NCOEventPayload): Promise<NCOEvent> {
    // Redis Stream의 ID는 "타임스탬프-시퀀스" 형식 (예: "1712700000000-0")
    // XADD에 '*'을 쓰면 Redis가 자동 생성. 이 ID가 곧 시퀀스 역할을 한다.
    const event: NCOEvent = {
      id: nanoid(),
      timestamp: Date.now(),
      streamId: '',  // XADD 후 채워짐
      payload
    };

    // 1. Redis Stream (영속 이벤트 로그 — 재연결/동기화의 핵심)
    //    Redis가 자동 생성하는 Stream ID를 시퀀스로 사용
    const streamId = await this.stream.xadd('nco:event-log', '*',
      'data', JSON.stringify(event)
    );
    event.streamId = streamId;  // 예: "1712700000000-0"

    // 2. Redis Pub/Sub (실시간 전파)
    await this.pub.publish('nco:events', JSON.stringify(event));

    // 3. 공유 상태 자동 갱신
    await this.updateSharedState(event);

    return event;
  }

  // v4: Redis Stream ID 기반 이벤트 재조회 (WebSocket 재연결 시)
  // 클라이언트가 마지막 수신한 streamId를 보내면 그 이후 이벤트를 반환
  async getEventsSince(sinceStreamId: string, limit: number = 1000): Promise<NCOEvent[]> {
    // sinceStreamId가 빈 문자열이면 처음부터
    const fromId = sinceStreamId || '0-0';
    // XRANGE는 fromId 포함이므로, 이미 받은 것 다음부터 조회하려면
    // fromId 뒤에 '(' 접두사를 쓰거나 (XRANGE 미지원), 결과에서 첫 번째를 건너뛴다.
    // 실용적 방법: XREAD BLOCK 0 COUNT limit STREAMS nco:event-log fromId
    const entries = await this.stream.xread(
      'COUNT', limit, 'STREAMS', 'nco:event-log', fromId
    );
    if (!entries || entries.length === 0) return [];
    // entries = [['nco:event-log', [['streamId', ['data', json]], ...]]]
    return entries[0][1].map(([streamId, fields]: [string, string[]]) => {
      const event = JSON.parse(fields[1]);  // fields = ['data', jsonString]
      event.streamId = streamId;
      return event;
    });
  }

  // 구독
  on(eventType: string, handler: (event: NCOEvent) => void): void {
    this.local.on(eventType, handler);
  }

  // 에이전트별 구독
  onAgent(agentId: string, handler: (event: NCOEvent) => void): void {
    this.local.on('*', (event: NCOEvent) => {
      const p = event.payload;
      if ('agentId' in p && p.agentId === agentId) handler(event);
      if ('to' in p && p.to === agentId) handler(event);
    });
  }

  // 공유 상태 자동 갱신
  private async updateSharedState(event: NCOEvent): Promise<void> {
    const p = event.payload;
    if (p.type.startsWith('agent:')) {
      await this.pub.set(`nco:agent:${(p as any).agentId}:state`,
        JSON.stringify(p), 'EX', 300);
    }
    if (p.type.startsWith('action:')) {
      await this.pub.zadd('nco:artifacts:recent',
        event.timestamp, JSON.stringify(p));
    }
    if (p.type.startsWith('discussion:')) {
      await this.pub.rpush(`nco:discussion:${(p as any).sessionId}:msgs`,
        JSON.stringify(p));
    }
  }

  // v4: Redis 장애 시 로컬 전용 모드
  private degraded: boolean = false;

  async publishWithFallback(payload: NCOEventPayload): Promise<NCOEvent> {
    try {
      const result = await this.publish(payload);
      // Redis 복구 감지 → 로컬 큐 flush
      if (this.degraded && this.localQueue.length > 0) {
        await this.flushLocalQueue();
        this.degraded = false;
      }
      return result;
    } catch (err) {
      this.degraded = true;
      // 로컬 EventEmitter로만 전파 (단일 프로세스 내)
      const event: NCOEvent = {
        id: nanoid(),
        streamId: `local-${Date.now()}`,  // 로컬 임시 ID
        timestamp: Date.now(),
        payload
      };
      this.local.emit(payload.type, event);
      this.local.emit('*', event);
      // 복구 후 Redis에 배치 전송을 위해 로컬 큐에 저장
      if (this.localQueue.length < 10_000) {  // 최대 10000건
        this.localQueue.push(event);
      }
      return event;
    }
  }

  // Redis 복구 시 로컬 큐를 Stream에 기록
  private async flushLocalQueue(): Promise<void> {
    const batch = this.localQueue.splice(0);
    for (const event of batch) {
      const streamId = await this.stream.xadd('nco:event-log', '*',
        'data', JSON.stringify(event)
      );
      event.streamId = streamId;
    }
  }
}
```

### 4.4 메시지 프로토콜

```typescript
// ═══ 메시지 우선순위 처리 ═══
// critical: 보안 이슈, 시스템 장애 → 즉시 처리, 진행 중 작업 중단 가능
// high:     Commander 명령, 리뷰 결과 → 현재 도구 호출 완료 후 즉시 처리
// normal:   일반 메시지, 작업 위임 → FIFO 순서
// low:      정보성, 로그 → 유휴 시 처리

interface MessageEnvelope {
  id: string;
  from: string;
  to: string | null;             // null = broadcast
  content: string;
  priority: MessagePriority;
  replyTo: string | null;        // 이전 메시지에 대한 답장
  maxSize: number;               // 기본 64KB, 코드 포함 시 256KB
  ttl: number;                   // 미확인 시 만료 (기본 300s)
  requireAck: boolean;           // true면 수신자가 ack 필수
  createdAt: number;
}

// ═══ ACK 프로토콜 ═══
// 1. 발신자: message:direct 발행 (requireAck: true)
// 2. Event Bus: 메시지 Redis Stream에 기록 + Pub/Sub 전파
// 3. 수신자: 메시지 수신 → message:ack 발행
// 4. 발신자: ack 수신 확인
// 5. TTL 내 ack 미수신 → system:message_timeout 이벤트 발생
//    → Commander에게 에스컬레이션

// ═══ 비동기 응답 패턴 ═══
// 리뷰 요청 같이 상대방이 바쁠 수 있는 경우:
// 1. message:review 발행
// 2. 수신자 status == 'working' → 내부 대기열에 추가
// 3. 수신자 현재 작업 완료 후 → 대기열에서 꺼내 처리
// 4. 대기열 최대 크기: 10 (초과 시 가장 낮은 우선순위 드롭)
// 5. 대기 시간 초과 (600s) → Commander에게 자동 에스컬레이션

class AgentMessageQueue {
  private queue: PriorityQueue<MessageEnvelope>;  // 우선순위 큐
  private maxSize: number = 10;

  enqueue(msg: MessageEnvelope): boolean {
    if (this.queue.size >= this.maxSize) {
      // 가장 낮은 우선순위 메시지 드롭
      const lowest = this.queue.peekLowest();
      if (lowest && priorityRank(msg.priority) > priorityRank(lowest.priority)) {
        this.queue.removeLowest();
        this.queue.push(msg);
        return true;
      }
      return false; // 신규 메시지가 더 낮은 우선순위 → 드롭
    }
    this.queue.push(msg);
    return true;
  }

  // 에이전트가 idle이 될 때 호출
  dequeue(): MessageEnvelope | null {
    return this.queue.pop();
  }
}
```

---

## 5. 토론 엔진 (Discussion Engine)

### 5.1 토론이란

토론은 **에이전트 간 구조화된 대화**다.
Event Bus 위에서 동작하는 프로토콜이다.

```
토론 = 주제 + 참여자들 + 라운드들 + 합의 + 사용자 개입

라운드 = 모든 참여자가 발언 → 상호 평가 → 합의율 계산
사용자 개입 = 라운드 중 언제든 사용자가 방향 수정 가능
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
  5. 사용자에게 WebSocket으로 세션 ID + 참여자 목록 전송

════════════════════════════════════════════════════════
  Phase 2: Round 1 — 독립 제안 (병렬)
════════════════════════════════════════════════════════

  각 에이전트가 동시에 작업:

  opencode: "아키텍처 분석 중..."
    → action:read 'src/core/**'
    → action:search 'dependency injection'
    → discussion:message "제안 A: 모듈 분리 + DI 패턴 도입"

  gemini: "UI 영향 분석 중..."
    → action:read 'src/components/**'
    → discussion:message "제안 B: 컴포넌트 트리 최적화"

  codex: "성능 프로파일링 중..."
    → action:run 'npm run benchmark'
    → discussion:message "제안 C: 핫패스 최적화, 벤치마크 결과 첨부"

  ★ 사용자가 WebSocket으로 모든 과정을 실시간으로 관찰
  ★ 사용자 개입 가능: "보안 관점도 분석해줘"
    → discussion:user_intervention 이벤트 발행
    → 모든 에이전트가 수신 → 제안에 보안 관점 추가

════════════════════════════════════════════════════════
  Phase 3: Round 2 — 상호 평가
════════════════════════════════════════════════════════

  opencode → codex 제안 평가: 점수 7/10
  codex → opencode 제안 평가: 점수 8/10
  gemini → 둘 다 평가: opencode 9/10, codex 7/10

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
  - 채택: opencode 제안 + codex 핫패스 최적화 통합
  - 근거: 벤치마크 데이터 + UI 리렌더 분석
  - 반론 정리 + 해결책
  - 실행 계획: Phase별 구현 순서

  → WebSocket으로 사용자에게 실시간 스트리밍
  → 공유 상태에 보고서 저장
```

### 5.3 합의율 계산 알고리즘

```typescript
class ConsensusCalculator {
  // 가중 합의율 계산
  // 에이전트 점수가 높을수록 투표 가중치가 높다.
  //
  // 공식: 합의율 = Σ(동의 에이전트 가중치) / Σ(전체 에이전트 가중치) × 100
  //
  // 동의 판정: 에이전트가 최고 득표 안건에 투표했으면 동의
  //            안건별 점수 평가 시 → 가중 평균 최고점 안건 = 채택 후보

  calculate(votes: Vote[], agents: Agent[]): ConsensusResult {
    // 1. 에이전트별 가중치 계산 (점수 기반)
    const weights = new Map<string, number>();
    let totalWeight = 0;
    for (const agent of agents) {
      const w = agent.score / 100;  // 0.70 ~ 0.95
      weights.set(agent.id, w);
      totalWeight += w;
    }

    // 2. 안건별 가중 점수 합산
    const proposalScores = new Map<string, number>();
    for (const vote of votes) {
      const w = weights.get(vote.agentId) ?? 0;
      const current = proposalScores.get(vote.choice) ?? 0;
      proposalScores.set(vote.choice, current + w);
    }

    // 3. 최고 득표 안건 결정
    let topProposal = '';
    let topScore = 0;
    for (const [proposal, score] of proposalScores) {
      if (score > topScore) {
        topScore = score;
        topProposal = proposal;
      }
    }

    // 4. 합의율 = 최고 득표 안건의 가중치 합 / 전체 가중치 합
    const consensusRate = totalWeight > 0 ? (topScore / totalWeight) * 100 : 0;

    // 5. 합의 임계값 확인 (기본 80%)
    return {
      achieved: consensusRate >= 80,
      rate: Math.round(consensusRate * 10) / 10,  // 소수점 1자리
      topProposal,
      topScore,
      breakdown: Object.fromEntries(proposalScores)
    };
  }
}

// 예시:
// opencode(90점, 가중치 0.9): A안 → A = 0.9
// codex(83점, 가중치 0.83):   A+C → A = 0.9, C = 0.83 (혼합은 각각 절반)
// gemini(85점, 가중치 0.85):  A안 → A = 0.9 + 0.85 = 1.75
//
// 전체 가중치: 0.9 + 0.83 + 0.85 = 2.58
// A안 가중치: 0.9 + 0.415 + 0.85 = 2.165 (codex는 A에 절반 가중치)
// 합의율: 2.165 / 2.58 × 100 = 83.9% → 80% 초과 → 합의 달성
```

### 5.4 자유 토론 모드 (Realtime)

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

// codex가 즉시 반응
eventBus.on('discussion:message', async (event) => {
  if (event.payload.sessionId === mySession && event.payload.from !== 'codex') {
    const response = await codexAgent.think(event.payload.content);
    eventBus.publish({
      type: 'discussion:message',
      sessionId,
      from: 'codex',
      content: response
    });
  }
});

// v4: 사용자가 자유 토론에 직접 참여
// WebSocket에서 수신한 사용자 메시지를 Event Bus에 주입
wsServer.on('discussion:user_message', (data) => {
  eventBus.publish({
    type: 'discussion:user_intervention',
    sessionId: data.sessionId,
    content: data.message
  });
});
```

---

## 6. 에이전트 실행 엔진

### 6.1 핵심 현실: CLI AI는 멀티턴 대화가 안 된다

```
★ 이것이 NCO 설계의 가장 중요한 제약이다.

대부분의 CLI AI 도구는 "프롬프트 입력 → 결과 출력 → 종료"의
단발(single-shot) 실행 모델이다. stdin으로 JSON을 주입해서
도구 호출 결과를 피드백하는 멀티턴 대화가 불가능하다.

따라서 NCO는 다음 원칙으로 설계한다:

  ┌─────────────────────────────────────────────────┐
  │  NCO Orchestrator가 "두뇌"가 아니라 "지휘자"다.   │
  │  각 AI는 "두뇌"다.                               │
  │                                                   │
  │  지휘자(NCO)가:                                    │
  │  1. 컨텍스트를 조립한다 (공유 상태 + 파일 + 히스토리) │
  │  2. AI에게 한 번 물어본다 (single-shot)             │
  │  3. 응답을 파싱한다 (도구 호출 감지)                │
  │  4. 도구를 NCO가 직접 실행한다 (샌드박스 내)         │
  │  5. 결과를 다시 컨텍스트에 추가한다                  │
  │  6. 필요하면 AI에게 다시 물어본다 (외부 루프)        │
  │                                                   │
  │  AI는 "생각만 한다". 행동은 NCO가 한다.             │
  └─────────────────────────────────────────────────┘
```

### 6.2 3가지 에이전트 실행 유형

```
┌─────────────────────────────────────────────────────────┐
│ Type A: Native Agent (자체 도구 실행 능력 보유)           │
│                                                          │
│ 대상: claude-code                                        │
│                                                          │
│ Claude Code는 자체적으로 파일 읽기/쓰기, 명령 실행,        │
│ git 조작이 가능한 에이전트다. NCO가 도구를 대행할 필요 없이  │
│ 작업 프롬프트와 컨텍스트만 전달하면 스스로 완수한다.         │
│                                                          │
│ NCO 역할: 작업 위임 + 결과 수집 + 상태 브로드캐스트         │
│                                                          │
│ 호출: claude -p --output-format json "프롬프트"            │
│ 출력: 작업 결과 (코드, 파일 변경 등)                       │
│ 멀티턴: claude --continue 로 이전 대화 이어가기 가능        │
├─────────────────────────────────────────────────────────┤
│ Type B: Single-shot Worker (단발 실행, NCO가 루프 관리)    │
│                                                          │
│ 대상: opencode, gemini, codex, aider, cursor-agent,       │
│       copilot                                            │
│                                                          │
│ "프롬프트 → 응답 → 종료" 모델. stdin 대화 불가.            │
│ NCO Orchestrator가 외부에서 Think→Act→Observe 루프를       │
│ 관리한다. AI는 각 루프의 "Think" 단계만 담당한다.           │
│                                                          │
│ NCO 역할: 컨텍스트 조립 + AI 호출 + 응답 파싱 +            │
│           도구 직접 실행 + 루프 관리                       │
│                                                          │
│ 각 CLI의 실제 호출 방식:                                  │
│   codex:         codex "프롬프트" (단발, 결과 stdout)      │
│   gemini:        echo "프롬프트" | gemini (파이프 입력)    │
│   aider:         aider --message "프롬프트" (단발 실행)    │
│   opencode:      opencode chat "프롬프트" (단발)           │
│   cursor-agent:  cursor-agent "프롬프트" (단발)            │
│   copilot:       github-copilot-cli "프롬프트" (단발)     │
├─────────────────────────────────────────────────────────┤
│ Type C: API Agent (OpenAI 호환 API, 멀티턴 가능)          │
│                                                          │
│ 대상: ollama (Gemma 4), openrouter                          │
│                                                          │
│ OpenAI 호환 chat completions API를 직접 호출.              │
│ messages 배열에 히스토리를 누적하여 멀티턴 대화 가능.        │
│ function calling 지원 시 AI가 직접 도구 호출 요청 가능.     │
│                                                          │
│ NCO 역할: API 호출 + function call 실행 + 응답 루프         │
└─────────────────────────────────────────────────────────┘
```

### 6.3 NCO Orchestrated Loop (핵심 — Type B 에이전트용)

NCO가 외부에서 관리하는 Think→Act→Observe 루프.
**AI는 "생각"만 하고, NCO가 "행동"한다.**

```typescript
class OrchestratedLoop {
  // ═══ 안전 장치 ═══
  private readonly MAX_ITERATIONS = 15;   // 최대 루프
  private readonly MAX_TOOL_CALLS = 30;   // 최대 도구 호출
  private readonly DEADLOCK_THRESHOLD = 3; // 교착 감지 (같은 도구+인자 3회)

  async run(agent: Agent, task: AgentTask): Promise<AgentResult> {
    let iterations = 0;
    let toolCalls = 0;
    const history: LoopStep[] = [];
    const callSignatures: string[] = [];
    const startTime = Date.now();

    while (iterations < this.MAX_ITERATIONS) {
      iterations++;

      // ════════════════════════════════════════════
      // 1. THINK — AI에게 한 번 물어본다 (single-shot)
      // ════════════════════════════════════════════

      const prompt = this.buildPrompt(agent, task, history);

      // Type B: subprocess 단발 실행
      const response = await this.callCLI(agent, prompt);

      // Event Bus: 청크 스트리밍
      await eventBus.publish({
        type: 'task:chunk', taskId: task.id,
        agentId: agent.id, chunk: response.text
      });

      // ════════════════════════════════════════════
      // 2. PARSE — 응답에서 의도 추출
      // ════════════════════════════════════════════

      const parsed = this.parseResponse(response.text);

      // 완료 선언 감지
      if (parsed.isComplete) {
        return {
          output: parsed.summary,
          artifacts: this.collectArtifacts(history),
          iterations, toolCalls
        };
      }

      // 도구 호출 요청이 없으면 → AI가 텍스트만 출력한 것 → 완료로 간주
      if (parsed.toolCalls.length === 0) {
        return {
          output: response.text,
          artifacts: this.collectArtifacts(history),
          iterations, toolCalls
        };
      }

      // ════════════════════════════════════════════
      // 3. ACT — NCO가 도구를 직접 실행한다
      // ════════════════════════════════════════════

      for (const call of parsed.toolCalls) {
        if (toolCalls >= this.MAX_TOOL_CALLS) {
          return { output: 'Max tool calls exceeded', status: 'force_stopped' };
        }

        // 교착 감지
        const sig = `${call.tool}:${JSON.stringify(call.args)}`;
        callSignatures.push(sig);
        if (callSignatures.filter(s => s === sig).length >= this.DEADLOCK_THRESHOLD) {
          return { output: `Deadlock: ${call.tool} repeated ${this.DEADLOCK_THRESHOLD}x`, status: 'deadlocked' };
        }

        // 샌드박스 검증
        const validation = await sandboxManager.validate(agent, call);
        if (!validation.ok) {
          await eventBus.publish({
            type: 'action:denied', agentId: agent.id,
            tool: call.tool, reason: validation.reason
          });
          history.push({ tool: call.tool, args: call.args, result: { error: validation.reason }, denied: true });
          continue;
        }

        // 도구 실행
        const result = await this.executeTool(agent, call);
        toolCalls++;

        // Event Bus 브로드캐스트
        await eventBus.publish({
          type: `action:${call.tool}`, agentId: agent.id,
          ...call.args, result
        });

        // ════════════════════════════════════════
        // 4. OBSERVE — 결과를 히스토리에 추가
        // ════════════════════════════════════════

        history.push({ tool: call.tool, args: call.args, result });
      }

      // 진행률 보고
      await eventBus.publish({
        type: 'task:progress', taskId: task.id,
        agentId: agent.id, progress: iterations / this.MAX_ITERATIONS,
        detail: `Iteration ${iterations}: ${parsed.toolCalls.length} tools executed`
      });

      // 시간 제한
      if (Date.now() - startTime > agent.sandbox.maxExecutionTime) {
        return { output: 'Time limit exceeded', status: 'timeout' };
      }

      // → 다음 루프: 히스토리를 포함한 새 프롬프트로 AI를 다시 호출
    }

    return { output: 'Max iterations exceeded', status: 'max_iterations' };
  }

  // ═══ 프롬프트 조립 (매 루프마다 갱신) ═══
  private buildPrompt(agent: Agent, task: AgentTask, history: LoopStep[]): string {
    return `
당신은 NCO 팀의 ${agent.role}(${agent.name})입니다.

## 작업
${task.prompt}

## 현재 팀 상태
${this.getTeamStatusSummary()}

## 이전 행동과 결과
${history.length === 0 ? '(첫 번째 시도)' :
  history.map((h, i) =>
    `[${i+1}] ${h.tool}(${JSON.stringify(h.args)}) → ${
      h.denied ? `차단됨: ${h.result.error}` :
      typeof h.result === 'string' ? h.result.slice(0, 500) :
      JSON.stringify(h.result).slice(0, 500)
    }`
  ).join('\n')
}

## 다음 행동을 선택하세요
도구를 호출하려면 NCO Tool Protocol 형식으로 작성하세요:
<nco-tool name="도구명">
{"param": "value"}
</nco-tool>

작업이 완료되었으면 다음을 작성하세요:
<nco-complete>
완료 요약
</nco-complete>

사용 가능한 도구: read_file, write_file, edit_file, delete_file,
  create_file, run_command, search_code, send_message, broadcast
    `.trim();
  }

  // ═══ CLI 단발 호출 ═══
  private async callCLI(agent: Agent, prompt: string): Promise<{ text: string }> {
    const limits = resourceLimiter.getExecOptions(agent);

    // 각 CLI별 실제 호출 방식
    switch (agent.id) {
      case 'codex':
        return this.execAndCapture('codex', [prompt], limits);
      case 'gemini':
        return this.execAndCapture('gemini', [], { ...limits, input: prompt });
      case 'aider':
        return this.execAndCapture('aider', ['--message', prompt, '--yes', '--no-git'], limits);
      case 'opencode':
        return this.execAndCapture('opencode', ['chat', prompt], limits);
      case 'cursor-agent':
        return this.execAndCapture('cursor-agent', [prompt], limits);
      case 'copilot':
        return this.execAndCapture('github-copilot-cli', [prompt], limits);
      default:
        throw new Error(`Unknown CLI agent: ${agent.id}`);
    }
  }

  private async execAndCapture(cmd: string, args: string[], opts: ExecaOptions): Promise<{ text: string }> {
    const result = await execa(cmd, args, {
      timeout: opts.timeout,
      input: opts.input,
      reject: false  // 비정상 종료도 결과로 처리
    });
    return { text: result.stdout || result.stderr || '(no output)' };
  }

  // ═══ 응답 파싱 ═══
  private parseResponse(text: string): ParsedResponse {
    // 완료 감지
    const completeMatch = text.match(/<nco-complete>([\s\S]*?)<\/nco-complete>/);
    if (completeMatch) {
      return { isComplete: true, summary: completeMatch[1].trim(), toolCalls: [] };
    }

    // 도구 호출 감지 (NCO Tool Protocol → function calling → JSON block 폴백)
    const toolCalls = toolParser.parseAny(text);

    return { isComplete: false, summary: '', toolCalls };
  }
}
```

### 6.4 Native Agent 실행 (Type A — claude-code)

```typescript
class NativeAgentExecutor {
  // Claude Code는 자체적으로 파일 조작, 명령 실행이 가능하다.
  // NCO는 작업을 위임하고 결과만 수집한다.

  async execute(agent: Agent, task: AgentTask): Promise<AgentResult> {
    const context = await this.buildContext(task);

    // Claude Code는 --continue로 이전 대화 이어가기 가능
    const proc = execa('claude', ['-p', '--output-format', 'json'], {
      input: `${context}\n\n${task.prompt}`,
      timeout: agent.sandbox.maxExecutionTime
    });

    let fullOutput = '';
    for await (const chunk of proc.stdout) {
      const text = chunk.toString();
      fullOutput += text;

      // 스트리밍 브로드캐스트
      await eventBus.publish({
        type: 'task:chunk', taskId: task.id,
        agentId: agent.id, chunk: text
      });
    }

    // Claude Code의 출력에서 파일 변경 등 결과 파싱
    const artifacts = this.parseClaudeOutput(fullOutput);

    // 결과를 공유 상태에 등록
    for (const artifact of artifacts) {
      await eventBus.publish({
        type: `action:${artifact.type}`, agentId: agent.id,
        path: artifact.path, content: artifact.content
      });
    }

    return { output: fullOutput, artifacts };
  }

  private buildContext(task: AgentTask): string {
    return `
[NCO Context]
팀 상태: ${this.getTeamStatusSummary()}
관련 작업: ${task.relatedTasks?.join(', ') || '없음'}
워크스페이스: ${task.workspacePath}
이 작업 완료 후 Event Bus로 결과가 브로드캐스트됩니다.
    `.trim();
  }
}
```

### 6.5 API Agent 실행 (Type C — Ollama, OpenRouter)

```typescript
class APIAgentExecutor {
  // OpenAI 호환 API — 멀티턴 대화 + function calling 가능

  async execute(agent: Agent, task: AgentTask): Promise<AgentResult> {
    const client = new OpenAI({
      baseURL: agent.endpoint,
      apiKey: agent.apiKeyRef ? this.getApiKey(agent) : 'not-needed'
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(agent) },
      { role: 'user', content: task.prompt }
    ];

    const toolDefs = this.getToolDefinitions();
    let iterations = 0;
    const MAX_ITERATIONS = 15;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.chat.completions.create({
        model: agent.model,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        stream: false  // function calling 시 non-stream이 안정적
      });

      const choice = response.choices[0];

      // 스트리밍 출력
      if (choice.message.content) {
        await eventBus.publish({
          type: 'task:chunk', taskId: task.id,
          agentId: agent.id, chunk: choice.message.content
        });
      }

      // function calling 응답 처리
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        messages.push(choice.message);  // assistant 메시지 추가

        for (const toolCall of choice.message.tool_calls) {
          const call = {
            tool: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments)
          };

          // 샌드박스 검증 + 실행
          const validation = await sandboxManager.validate(agent, call);
          let result: any;
          if (!validation.ok) {
            result = { error: validation.reason };
            await eventBus.publish({
              type: 'action:denied', agentId: agent.id,
              tool: call.tool, reason: validation.reason
            });
          } else {
            result = await this.executeTool(agent, call);
            await eventBus.publish({
              type: `action:${call.tool}`, agentId: agent.id,
              ...call.args, result
            });
          }

          // 도구 결과를 messages에 추가 → 다음 턴에서 AI가 참조
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        continue;  // 다음 턴
      }

      // function calling 없이 종료 → 완료
      // NCO Tool Protocol 폴백 파싱 (function calling 미지원 모델)
      if (choice.message.content) {
        const parsed = toolParser.parseAny(choice.message.content);
        if (parsed.length > 0) {
          // NCO Tool Protocol로 도구 호출 → OrchestratedLoop과 동일 패턴
          for (const call of parsed) {
            const validation = await sandboxManager.validate(agent, call);
            if (validation.ok) {
              const result = await this.executeTool(agent, call);
              messages.push({ role: 'user', content: `도구 결과: ${JSON.stringify(result)}` });
            }
          }
          continue;
        }
      }

      // 도구 호출도 없고 완료 → 최종 응답
      return {
        output: choice.message.content || '',
        artifacts: this.collectArtifacts()
      };
    }

    return { output: 'Max iterations exceeded', status: 'max_iterations' };
  }

  // ═══ API 키 롤링 (장애 처리 포함) ═══
  private keyIndex: number = 0;
  private keyCooldowns: Map<number, number> = new Map(); // keyIndex → cooldown 만료 시각

  private getApiKey(agent: Agent): string {
    const keys = process.env[agent.apiKeyRef!]?.split(',').map(k => k.trim()) ?? [];
    if (keys.length === 0) throw new Error(`No API keys for ${agent.apiKeyRef}`);

    // 쿨다운 중이 아닌 키 찾기
    const now = Date.now();
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = (this.keyIndex + attempt) % keys.length;
      const cooldownUntil = this.keyCooldowns.get(idx) ?? 0;
      if (now >= cooldownUntil) {
        this.keyIndex = idx;
        return keys[idx];
      }
    }

    // 모든 키가 쿨다운 중 → 가장 빨리 풀리는 키 반환
    let earliest = { idx: 0, time: Infinity };
    for (const [idx, time] of this.keyCooldowns) {
      if (time < earliest.time) earliest = { idx, time };
    }
    this.keyIndex = earliest.idx;
    return keys[earliest.idx];
  }

  // 429 발생 시 호출
  onRateLimit(keyIndex: number): void {
    this.keyCooldowns.set(keyIndex, Date.now() + 60_000); // 60초 쿨다운
    this.keyIndex = (keyIndex + 1) % this.getTotalKeys();  // 다음 키로 전환

    // 모든 키가 쿨다운인지 확인
    const now = Date.now();
    const allCooling = [...this.keyCooldowns.values()].every(t => t > now);
    if (allCooling) {
      // 전체 제한 → Ollama 로컬 폴백 이벤트 발행
      eventBus.publish({
        type: 'system:fallback',
        from: 'openrouter', to: 'ollama',
        reason: 'All API keys rate-limited, falling back to local Ollama'
      });
    }
  }
}
```

### 6.6 Agent Manager — 유형별 실행 분배

```typescript
class AgentManager {
  private nativeExecutor = new NativeAgentExecutor();   // Type A
  private orchestratedLoop = new OrchestratedLoop();    // Type B
  private apiExecutor = new APIAgentExecutor();          // Type C

  // 에이전트 유형 분류
  private readonly AGENT_TYPES: Record<string, 'native' | 'single-shot' | 'api'> = {
    'claude-code':   'native',        // Type A: 자체 도구 실행
    'opencode':      'single-shot',   // Type B: NCO가 루프 관리
    'gemini':        'single-shot',
    'codex':         'single-shot',
    'aider':         'single-shot',
    'cursor-agent':  'single-shot',
    'copilot':       'single-shot',
    'openrouter':    'api',           // Type C: API 멀티턴
    'ollama':          'api',
  };

  async executeTask(agent: Agent, task: AgentTask): Promise<AgentResult> {
    // Circuit Breaker 확인
    return circuitBreaker.execute(agent.id, async () => {
      // 상태 업데이트
      await eventBus.publish({ type: 'agent:status', agentId: agent.id, status: 'working' });
      await eventBus.publish({ type: 'task:started', taskId: task.id, agentId: agent.id });

      try {
        const type = this.AGENT_TYPES[agent.id];
        let result: AgentResult;

        switch (type) {
          case 'native':
            result = await this.nativeExecutor.execute(agent, task);
            break;
          case 'single-shot':
            result = await this.orchestratedLoop.run(agent, task);
            break;
          case 'api':
            result = await this.apiExecutor.execute(agent, task);
            break;
        }

        await eventBus.publish({
          type: 'task:completed', taskId: task.id,
          agentId: agent.id, result: result.output
        });
        await eventBus.publish({ type: 'agent:status', agentId: agent.id, status: 'idle' });

        return result;

      } catch (error) {
        await eventBus.publish({
          type: 'task:failed', taskId: task.id,
          agentId: agent.id, error: String(error)
        });
        await eventBus.publish({ type: 'agent:status', agentId: agent.id, status: 'error' });
        throw error;
      }
    });
  }
}
```

---

## 7. 보안 & 격리 (Security & Isolation)

### 7.1 샌드박스 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                  Sandbox Manager                     │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Path Guard   │  │ Command Gate │  │ Resource   │ │
│  │              │  │              │  │ Limiter    │ │
│  │ 경로 허용/   │  │ 명령 허용/   │  │            │ │
│  │ 차단 검증    │  │ 차단 검증    │  │ CPU/Mem/   │ │
│  │              │  │              │  │ Time 제한  │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                │         │
│         └────────────────┼────────────────┘         │
│                          ▼                          │
│                  ┌───────────────┐                   │
│                  │ Circuit       │                   │
│                  │ Breaker       │                   │
│                  │               │                   │
│                  │ 연속 실패 시   │                   │
│                  │ 에이전트 격리  │                   │
│                  └───────────────┘                   │
└─────────────────────────────────────────────────────┘
```

### 7.2 경로 보안 (Path Guard)

```typescript
class PathGuard {
  // 전역 허용 경로 (모든 에이전트)
  private globalAllowed: string[] = [
    '/home/nova/projects/**',       // 프로젝트 디렉토리
    '/mnt/d/NCO-Dashboard/**',      // 대시보드
    '/tmp/nco-*/**'                 // NCO 임시 파일
  ];

  // 전역 금지 경로 (절대 접근 불가)
  private globalDenied: string[] = [
    '/etc/**',
    '/usr/**',
    '/var/**',
    '/root/**',
    '/home/nova/.ssh/**',
    '/home/nova/.gnupg/**',
    '/home/nova/.env',              // 글로벌 환경변수
    '**/.git/objects/**',           // Git 내부 객체 직접 접근 금지
    '**/node_modules/**',           // node_modules 쓰기 금지 (읽기만)
    '**/.env',                      // 모든 .env 파일
    '**/*.key',                     // 개인키
    '**/*.pem',                     // 인증서
    '**/credentials*',              // 자격증명
  ];

  // 읽기 전용 경로 (읽기만, 쓰기/삭제 불가)
  private readOnlyPaths: string[] = [
    '**/node_modules/**',
    '**/package-lock.json',
    '**/config/topology.json',
    '**/config/ai-providers.json',
  ];

  validate(agent: Agent, action: 'read' | 'write' | 'delete' | 'create', filePath: string): ValidationResult {
    const resolved = nodePath.resolve(filePath);  // import * as nodePath from 'path'

    // 1. 경로 탈출 감지 (path traversal)
    if (filePath.includes('..') || !resolved.startsWith('/')) {
      return { ok: false, reason: `Path traversal detected: ${filePath}` };
    }

    // 2. 전역 금지 확인
    if (this.matchesAny(resolved, this.globalDenied)) {
      return { ok: false, reason: `Globally denied path: ${filePath}` };
    }

    // 3. 전역 허용 확인
    if (!this.matchesAny(resolved, this.globalAllowed)) {
      return { ok: false, reason: `Path not in allowed scope: ${filePath}` };
    }

    // 4. 읽기 전용 확인 (write/delete 시)
    if (action !== 'read' && this.matchesAny(resolved, this.readOnlyPaths)) {
      return { ok: false, reason: `Read-only path: ${filePath}` };
    }

    // 5. 에이전트별 추가 제한
    if (agent.sandbox.deniedPaths.length > 0 &&
        this.matchesAny(resolved, agent.sandbox.deniedPaths)) {
      return { ok: false, reason: `Agent-specific denied path: ${filePath}` };
    }

    // 6. 파일 크기 제한 (write/create 시)
    // → executeTool에서 별도 검증

    return { ok: true };
  }
}
```

### 7.3 명령 실행 보안 (Command Gate)

```typescript
class CommandGate {
  // 허용 명령 화이트리스트
  private allowedCommands: RegExp[] = [
    /^npm\s+(run|test|install|ci|ls|outdated)/,
    /^npx\s+/,
    /^node\s+/,
    /^tsx?\s+/,
    /^git\s+(status|diff|log|add|commit|branch|checkout|stash|show)/,
    /^cat\s+/,
    /^ls\s+/,
    /^find\s+/,
    /^grep\s+/,
    /^rg\s+/,
    /^wc\s+/,
    /^head\s+/,
    /^tail\s+/,
    /^echo\s+/,
    /^pwd$/,
    /^which\s+/,
    /^python3?\s+/,
    /^pip\s+(install|list|show)/,
    /^curl\s+.*localhost/,          // 로컬 API만 허용
    /^vitest\s+/,
    /^tsc\s+/,
  ];

  // 절대 금지 패턴 (화이트리스트 통과해도 차단)
  private deniedPatterns: RegExp[] = [
    /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf / 방지
    /rm\s+-rf?\s+~\//,               // 홈 디렉토리 삭제 방지
    />\s*\/dev\/sd/,                   // 디스크 직접 쓰기
    /mkfs/,                            // 파일시스템 포맷
    /dd\s+/,                           // 디스크 복제
    /:(){ :\|:& };:/,                 // fork bomb
    /curl\s+.*\|\s*(bash|sh)/,        // 원격 스크립트 실행
    /wget\s+.*\|\s*(bash|sh)/,
    /chmod\s+[0-7]*s/,                // setuid
    /sudo\s+/,                         // 권한 상승
    /su\s+/,
    /passwd/,
    /ssh\s+/,                          // 원격 접속
    /scp\s+/,
    /nc\s+/,                           // netcat
    /nmap/,
    /\\x[0-9a-f]/i,                   // 셸코드 인젝션
    /\$\(.*\)/,                        // 명령 치환 (제한적 허용 — 아래 참조)
    /`.*`/,                            // 백틱 명령 치환
  ];

  validate(agent: Agent, command: string): ValidationResult {
    const cmd = command.trim();

    // 1. 빈 명령 차단
    if (!cmd) return { ok: false, reason: 'Empty command' };

    // 2. 금지 패턴 먼저 확인 (화이트리스트보다 우선)
    for (const pattern of this.deniedPatterns) {
      if (pattern.test(cmd)) {
        return { ok: false, reason: `Dangerous command pattern: ${cmd}` };
      }
    }

    // 3. 화이트리스트 확인
    const isAllowed = this.allowedCommands.some(pattern => pattern.test(cmd));
    if (!isAllowed) {
      return { ok: false, reason: `Command not in whitelist: ${cmd.split(' ')[0]}` };
    }

    // 4. 에이전트별 추가 제한
    if (agent.sandbox.allowedCommands.length > 0) {
      const agentAllowed = agent.sandbox.allowedCommands.some(
        pattern => new RegExp(pattern).test(cmd)
      );
      if (!agentAllowed) {
        return { ok: false, reason: `Agent ${agent.id} not allowed: ${cmd}` };
      }
    }

    return { ok: true };
  }
}
```

### 7.4 리소스 제한 (Resource Limiter)

```typescript
class ResourceLimiter {
  // 에이전트별 기본 리소스 제한
  private defaults: Record<string, ResourceLimits> = {
    'claude-code':   { maxMemMB: 2048, maxTimeSec: 600, maxFileSizeMB: 10, maxConcurrent: 8 },
    'opencode':      { maxMemMB: 1024, maxTimeSec: 300, maxFileSizeMB: 5,  maxConcurrent: 4 },
    'gemini':        { maxMemMB: 1024, maxTimeSec: 300, maxFileSizeMB: 5,  maxConcurrent: 4 },
    'codex':         { maxMemMB: 1024, maxTimeSec: 300, maxFileSizeMB: 5,  maxConcurrent: 4 },
    'aider':         { maxMemMB: 512,  maxTimeSec: 300, maxFileSizeMB: 5,  maxConcurrent: 4 },
    'cursor-agent':  { maxMemMB: 512,  maxTimeSec: 300, maxFileSizeMB: 2,  maxConcurrent: 4 },
    'copilot':       { maxMemMB: 512,  maxTimeSec: 180, maxFileSizeMB: 2,  maxConcurrent: 2 },
    'openrouter':    { maxMemMB: 256,  maxTimeSec: 120, maxFileSizeMB: 2,  maxConcurrent: 2 },
    'ollama':          { maxMemMB: 256,  maxTimeSec: 120, maxFileSizeMB: 2,  maxConcurrent: 1 },
  };

  // subprocess 실행 시 리소스 제한 적용
  getExecOptions(agent: Agent): ExecaOptions {
    const limits = this.defaults[agent.id];
    return {
      timeout: limits.maxTimeSec * 1000,
      // ulimit으로 메모리 제한 (Linux)
      env: {
        ...process.env,
        // soft limit
        RLIMIT_AS: String(limits.maxMemMB * 1024 * 1024),
      }
    };
  }
}
```

### 7.5 Circuit Breaker (장애 격리)

```typescript
class CircuitBreaker {
  // 상태: closed(정상) → open(격리) → half-open(시험)
  //
  // closed:    정상 동작. 실패 카운트 증가.
  // open:      에이전트 격리. 모든 요청 즉시 거부. 복구 타이머 시작.
  // half-open: 시험 요청 1개 허용. 성공 → closed, 실패 → open
  //
  // 기준: 5회 연속 실패 → open (60초 후 half-open)

  private states: Map<string, CircuitState> = new Map();

  private readonly FAILURE_THRESHOLD = 5;
  private readonly RECOVERY_TIMEOUT = 60_000; // 60초

  async execute<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const state = this.getState(agentId);

    if (state.circuit === 'open') {
      if (Date.now() - state.openedAt! > this.RECOVERY_TIMEOUT) {
        state.circuit = 'half-open';
      } else {
        throw new AgentIsolatedException(agentId, state.consecutiveFailures);
      }
    }

    try {
      const result = await fn();
      this.onSuccess(agentId);
      return result;
    } catch (error) {
      this.onFailure(agentId, error);
      throw error;
    }
  }

  private onFailure(agentId: string, error: unknown): void {
    const state = this.getState(agentId);
    state.consecutiveFailures++;
    state.lastError = String(error);

    if (state.consecutiveFailures >= this.FAILURE_THRESHOLD || state.circuit === 'half-open') {
      state.circuit = 'open';
      state.openedAt = Date.now();

      eventBus.publish({
        type: 'system:circuit_open',
        agentId,
        failures: state.consecutiveFailures
      });

      eventBus.publish({
        type: 'agent:isolated',
        agentId,
        reason: `${state.consecutiveFailures} consecutive failures`
      });
    }
  }

  private onSuccess(agentId: string): void {
    const state = this.getState(agentId);
    state.consecutiveFailures = 0;
    state.lastError = null;

    if (state.circuit === 'half-open') {
      state.circuit = 'closed';
      eventBus.publish({ type: 'system:circuit_close', agentId });
    }
  }
}
```

---

## 8. 실시간 양방향 통신 (Realtime Bridge)

### 8.1 아키텍처

```
 사용자 (Dashboard / CLI)
    │
    │  WebSocket (wss://localhost:6201)
    │  ┌──────────────────────────────────┐
    │  │ 하향 (서버 → 클라이언트):         │
    │  │  - 에이전트 행동 스트리밍          │
    │  │  - 토론 진행 상황                 │
    │  │  - 작업 진행률/청크               │
    │  │  - 시스템 알림                    │
    │  │                                  │
    │  │ 상향 (클라이언트 → 서버):         │
    │  │  - 사용자 개입 (토론 방향 수정)    │
    │  │  - 작업 중단/수정                 │
    │  │  - 에이전트에게 직접 메시지        │
    │  │  - lastSeq 기반 재연결            │
    │  └──────────────────────────────────┘
    │
    ▼
 Realtime Bridge (server/realtime-bridge.ts)
    │
    ├──▶ Event Bus (Redis Pub/Sub) ──▶ 에이전트들
    │
    └──▶ Redis Stream (시퀀스 기반 이벤트 재조회)
```

### 8.2 WebSocket 서버

```typescript
class RealtimeBridge {
  private wss: WebSocketServer;
  private clients: Map<string, ClientSession> = new Map();

  interface ClientSession {
    ws: WebSocket;
    lastStreamId: string;      // 마지막 수신 Redis Stream ID (예: "1712700000000-0")
    subscriptions: string[];   // 구독 중인 이벤트 타입
    backpressure: {
      buffered: number;        // 미전송 메시지 수
      maxBuffer: number;       // 최대 버퍼 (기본 500)
      throttleMs: number;      // 스로틀 간격 (기본 0, 압박 시 50ms)
    };
  }

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws, req) => {
      const clientId = nanoid();
      const session: ClientSession = {
        ws,
        lastStreamId: '0-0',
        subscriptions: ['*'],  // 기본: 전체 구독
        backpressure: { buffered: 0, maxBuffer: 500, throttleMs: 0 }
      };
      this.clients.set(clientId, session);

      // ═══ 상향 메시지 처리 (사용자 → 시스템) ═══
      ws.on('message', (data) => this.handleClientMessage(clientId, JSON.parse(data.toString())));
      ws.on('close', () => this.clients.delete(clientId));
    });

    // ═══ Event Bus → WebSocket 브릿지 ═══
    eventBus.on('*', (event: NCOEvent) => {
      for (const [clientId, session] of this.clients) {
        if (this.shouldForward(event, session)) {
          this.sendToClient(clientId, session, event);
        }
      }
    });
  }

  // ═══ 사용자 상향 메시지 유형 ═══
  private async handleClientMessage(clientId: string, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      // 재연결 시 놓친 이벤트 요청
      case 'sync':
        const missed = await eventBus.getEventsSince(msg.lastStreamId);
        for (const event of missed) {
          const session = this.clients.get(clientId)!;
          session.ws.send(JSON.stringify(event));
          session.lastStreamId = event.streamId;
        }
        break;

      // 구독 필터 변경
      case 'subscribe':
        this.clients.get(clientId)!.subscriptions = msg.eventTypes;
        break;

      // 사용자가 토론에 개입
      case 'discussion:intervene':
        await eventBus.publish({
          type: 'discussion:user_intervention',
          sessionId: msg.sessionId,
          content: msg.content
        });
        break;

      // 사용자가 에이전트에게 직접 메시지
      case 'agent:message':
        await eventBus.publish({
          type: 'message:direct',
          from: 'user',
          to: msg.agentId,
          content: msg.content,
          priority: 'high'
        });
        break;

      // 작업 중단
      case 'task:cancel':
        await eventBus.publish({
          type: 'task:cancelled',
          taskId: msg.taskId,
          reason: 'User cancelled'
        });
        break;
    }
  }

  // ═══ 백프레셔 관리 ═══
  private sendToClient(clientId: string, session: ClientSession, event: NCOEvent): void {
    const bp = session.backpressure;

    // 버퍼 초과 → 스로틀 활성화
    if (bp.buffered >= bp.maxBuffer) {
      bp.throttleMs = Math.min(bp.throttleMs + 10, 200); // 점진적 스로틀
      // 낮은 우선순위 이벤트 드롭 (heartbeat, progress 등)
      if (this.isLowPriority(event)) return;
    }

    // 전송
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(event), (err) => {
        if (!err) {
          bp.buffered--;
          if (bp.buffered < bp.maxBuffer * 0.5) {
            bp.throttleMs = 0; // 스로틀 해제
          }
        }
      });
      bp.buffered++;
    }
  }

  // 낮은 우선순위 이벤트 (백프레셔 시 드롭 가능)
  private isLowPriority(event: NCOEvent): boolean {
    const droppable = ['agent:heartbeat', 'task:progress', 'task:chunk'];
    return droppable.includes(event.payload.type);
  }
}
```

### 8.3 SSE vs WebSocket 역할 분리

```
┌──────────────────────────────────────────────────────┐
│ WebSocket (port 6201)                                │
│ - 양방향: 에이전트 이벤트 수신 + 사용자 개입 전송      │
│ - 대상: Dashboard (React), 인터랙티브 CLI              │
│ - 기능: 재연결, 백프레셔, 구독 필터                    │
│ - 모든 이벤트 유형                                    │
├──────────────────────────────────────────────────────┤
│ SSE (port 6200, /api/stream)                         │
│ - 단방향: 서버 → 클라이언트 스트리밍만                 │
│ - 대상: 경량 클라이언트, curl, 모니터링 도구            │
│ - 기능: 간단한 이벤트 스트림                           │
│ - 필터: ?types=task:chunk,discussion:message          │
└──────────────────────────────────────────────────────┘
```

---

## 9. NCO Tool Protocol (도구 호출 표준)

### 9.1 문제

각 CLI AI의 출력 형식이 모두 다르다:
- claude-code: 자체 도구 시스템
- codex: OpenAI function calling
- gemini: 자체 형식
- aider: `/run`, `/add` 커맨드

NCO는 **통합된 도구 호출 형식**이 필요하다.

### 9.2 NCO Tool Protocol 형식

```
에이전트 AI에게 시스템 프롬프트로 주입하는 표준 형식:

<nco-tool name="tool_name">
{"param1": "value1", "param2": "value2"}
</nco-tool>

예시:
<nco-tool name="read_file">
{"path": "src/auth/jwt.ts"}
</nco-tool>

<nco-tool name="write_file">
{"path": "src/auth/jwt.ts", "content": "import jwt from 'jsonwebtoken';\n..."}
</nco-tool>

<nco-tool name="run_command">
{"cmd": "npm test -- --filter auth"}
</nco-tool>

<nco-tool name="send_message">
{"to": "cursor-agent", "content": "리뷰 부탁해", "priority": "normal"}
</nco-tool>
```

### 9.3 파서 구현

```typescript
// tool-parser.ts — NCO Tool Protocol 파서

class NCOToolParser {
  // 기본 파서: <nco-tool> XML 태그 감지
  private readonly TOOL_PATTERN = /<nco-tool\s+name="(\w+)">\s*(\{[\s\S]*?\})\s*<\/nco-tool>/g;

  parse(output: string): ToolCall[] {
    const calls: ToolCall[] = [];
    let match: RegExpExecArray | null;

    while ((match = this.TOOL_PATTERN.exec(output)) !== null) {
      try {
        calls.push({
          tool: match[1],
          args: JSON.parse(match[2])
        });
      } catch (e) {
        // JSON 파싱 실패 → 무시 (AI가 잘못된 형식 출력)
      }
    }

    return calls;
  }

  // ═══ 폴백 파서 (AI가 NCO 형식을 안 쓸 경우) ═══

  // OpenAI function calling 형식
  parseFunctionCalling(output: string): ToolCall[] {
    // {"function_call": {"name": "...", "arguments": "..."}}
    try {
      const parsed = JSON.parse(output);
      if (parsed.function_call) {
        return [{
          tool: parsed.function_call.name,
          args: JSON.parse(parsed.function_call.arguments)
        }];
      }
    } catch {}
    return [];
  }

  // JSON 블록 폴백
  parseJsonBlock(output: string): ToolCall[] {
    const jsonPattern = /```json\s*(\{[\s\S]*?\})\s*```/g;
    const calls: ToolCall[] = [];
    let match: RegExpExecArray | null;
    while ((match = jsonPattern.exec(output)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        if (obj.tool && obj.args) {
          calls.push({ tool: obj.tool, args: obj.args });
        }
      } catch {}
    }
    return calls;
  }

  // 통합 파서 (우선순위: NCO > function_calling > JSON block)
  parseAny(output: string): ToolCall[] {
    let calls = this.parse(output);
    if (calls.length > 0) return calls;

    calls = this.parseFunctionCalling(output);
    if (calls.length > 0) return calls;

    return this.parseJsonBlock(output);
  }
}
```

---

## 10. 작업 상태 머신 & Smart Router

### 10.1 Task State Machine (7단계)

```
  ┌──────────┐
  │ pending  │ ← 작업 생성, 아직 배정 안됨
  └────┬─────┘
       │ Commander가 에이전트 선택
       ▼
  ┌──────────┐
  │ assigned │ ← 에이전트에 배정됨, 에이전트가 아직 시작 안함
  └────┬─────┘
       │ 에이전트가 작업 시작
       ▼
  ┌──────────┐
  │ running  │ ← 에이전트가 작업 중 (도구 호출, 코드 작성 등)
  └────┬─────┘
       │
       ├─── 성공 완료 ──────────────▶ ┌──────────┐
       │                              │completed │
       │                              └──────────┘
       │
       ├─── 리뷰 필요 ──────────────▶ ┌──────────┐
       │                              │reviewing │ ← Reviewer가 검토 중
       │                              └────┬─────┘
       │                                   │
       │                     ┌─────────────┼─────────────┐
       │                     │             │             │
       │                  승인          수정요청       거부
       │                     │             │             │
       │                     ▼             ▼             ▼
       │               completed      running        failed
       │
       ├─── 실패 ──────────────────▶ ┌──────────┐
       │                              │ failed   │
       │                              └────┬─────┘
       │                                   │
       │                           재시도 또는 위임
       │                                   │
       │                                   ▼
       │                            assigned (다른 에이전트)
       │
       └─── 사용자 취소 ──────────▶ ┌──────────┐
                                    │cancelled │
                                    └──────────┘

  상태 전이 규칙:
  - pending → assigned:      Commander가 assignee 설정
  - assigned → running:      에이전트가 task:started 발행
  - running → completed:     에이전트가 task:completed 발행 (리뷰 불필요)
  - running → reviewing:     에이전트가 리뷰 요청
  - reviewing → completed:   Reviewer가 message:approve
  - reviewing → running:     Reviewer가 message:reject (수정 요청)
  - running → failed:        에이전트가 task:failed 또는 타임아웃
  - failed → assigned:       Commander가 재배정 (같은/다른 에이전트)
  - * → cancelled:           사용자가 task:cancel (어느 상태에서든)
```

### 10.2 상태 전이 구현

```typescript
class TaskStateMachine {
  private readonly VALID_TRANSITIONS: Record<string, string[]> = {
    'pending':   ['assigned', 'cancelled'],
    'assigned':  ['running', 'cancelled'],
    'running':   ['completed', 'reviewing', 'failed', 'cancelled'],
    'reviewing': ['completed', 'running', 'failed', 'cancelled'],
    'failed':    ['assigned', 'cancelled'],
    'completed': [],  // 최종 상태
    'cancelled': [],  // 최종 상태
  };

  transition(task: Task, newStatus: string, context: TransitionContext): boolean {
    const allowed = this.VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new InvalidTransitionError(task.id, task.status, newStatus);
    }

    const oldStatus = task.status;
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    // 상태별 부수 효과
    switch (newStatus) {
      case 'assigned':
        task.assignedTo = context.agentId;
        break;
      case 'running':
        break;
      case 'reviewing':
        // 리뷰어에게 자동 알림
        eventBus.publish({
          type: 'message:review',
          from: task.assignedTo,
          to: context.reviewerId,
          artifactId: context.artifactId,
          comments: `Task ${task.id} 리뷰 요청`
        });
        break;
      case 'failed':
        // 재시도 로직: 같은 에이전트 1회 → 다른 에이전트 위임
        if (task.retryCount < 1) {
          task.retryCount++;
          // 자동 재배정 (같은 에이전트)
          setTimeout(() => this.transition(task, 'assigned', context), 5000);
        } else {
          // Commander에게 에스컬레이션
          eventBus.publish({
            type: 'task:delegated',
            taskId: task.id,
            from: task.assignedTo,
            to: 'claude-code',
            reason: `${task.retryCount} retries failed, escalating`
          });
        }
        break;
      case 'completed':
        task.completedAt = new Date().toISOString();
        break;
    }

    return true;
  }
}
```

### 10.3 Smart Router (복잡도 → 에이전트 자동 선택)

```typescript
class SmartRouter {
  // 복잡도 분석 (1-10)
  analyzeComplexity(prompt: string, context: RouterContext): number {
    let score = 0;

    // 1. 키워드 기반 (0-3점)
    const complexKeywords = ['아키텍처', 'architecture', 'refactor', 'migration', 'security', 'performance'];
    const simpleKeywords = ['fix', 'typo', 'rename', 'format', 'lint'];
    if (complexKeywords.some(k => prompt.toLowerCase().includes(k))) score += 3;
    if (simpleKeywords.some(k => prompt.toLowerCase().includes(k))) score -= 1;

    // 2. 파일 범위 (0-3점)
    const mentionedPaths = this.extractPaths(prompt);
    if (mentionedPaths.length > 5) score += 3;
    else if (mentionedPaths.length > 2) score += 2;
    else if (mentionedPaths.length >= 1) score += 1;

    // 3. 작업 유형 (0-2점)
    if (/토론|discuss|review|평가/.test(prompt)) score += 2;
    if (/테스트|test|검증|verify/.test(prompt)) score += 1;

    // 4. 길이 (0-2점)
    if (prompt.length > 500) score += 2;
    else if (prompt.length > 200) score += 1;

    return Math.max(1, Math.min(10, score));
  }

  // 에이전트 선택
  selectAgent(prompt: string, context: RouterContext): AgentSelection {
    const complexity = this.analyzeComplexity(prompt, context);
    const requiredCapabilities = this.extractCapabilities(prompt);

    // 사용 가능한 에이전트 (online + circuit closed + not busy)
    const available = this.getAvailableAgents();

    // 능력 매칭 + 점수 가중치
    const candidates = available
      .map(agent => ({
        agent,
        matchScore: this.calculateMatchScore(agent, requiredCapabilities, complexity)
      }))
      .sort((a, b) => b.matchScore - a.matchScore);

    // 복잡도별 전략
    if (complexity >= 8) {
      // 고복잡도: Commander 직접 처리 또는 토론 제안
      return {
        primary: candidates[0]?.agent ?? this.getAgent('claude-code'),
        strategy: 'discussion_recommended',
        complexity,
        reason: `High complexity (${complexity}), discussion recommended`
      };
    }

    if (complexity <= 3) {
      // 저복잡도: 무료 에이전트 우선
      const freeAgent = candidates.find(c => c.agent.cost === 'free');
      if (freeAgent) {
        return {
          primary: freeAgent.agent,
          strategy: 'cost_optimized',
          complexity,
          reason: `Low complexity (${complexity}), using free agent`
        };
      }
    }

    // 중간 복잡도: 최고 매칭 에이전트
    return {
      primary: candidates[0].agent,
      fallback: candidates[1]?.agent,
      strategy: 'best_match',
      complexity,
      reason: `Matched ${candidates[0].agent.id} (score: ${candidates[0].matchScore})`
    };
  }

  private calculateMatchScore(agent: Agent, required: string[], complexity: number): number {
    let score = 0;

    // 능력 매칭 (0-50)
    const capMatch = required.filter(cap => agent.capabilities.includes(cap)).length;
    score += (capMatch / Math.max(required.length, 1)) * 50;

    // 에이전트 점수 (0-30)
    score += (agent.score / 100) * 30;

    // 가용성 (0-10)
    if (agent.state.status === 'idle') score += 10;
    else if (agent.state.status === 'working') score += 0;

    // 비용 효율 (0-10) — 저복잡도 시 무료 보너스
    if (complexity <= 5 && agent.cost === 'free') score += 10;

    return score;
  }

  private extractCapabilities(prompt: string): string[] {
    const capMap: Record<string, string[]> = {
      'code|구현|implement|작성': ['code'],
      'review|리뷰|검토': ['review'],
      'test|테스트|검증': ['testing'],
      'design|디자인|UI|UX': ['design', 'ui-ux'],
      'refactor|리팩토링': ['refactoring', 'code'],
      'architecture|아키텍처|설계': ['architecture'],
      'security|보안': ['security'],
      'git|커밋|commit': ['git'],
      'search|검색|조사': ['research'],
    };

    const caps: Set<string> = new Set();
    for (const [pattern, capabilities] of Object.entries(capMap)) {
      if (new RegExp(pattern, 'i').test(prompt)) {
        capabilities.forEach(c => caps.add(c));
      }
    }
    return [...caps];
  }
}
```

---

## 11. 에이전트 실행 흐름 종합

### 11.1 Type별 실행 흐름 비교

```
═══ Type A: Native Agent (claude-code) ═══

  사용자 요청 → NCO → claude -p "프롬프트"
                        │
                        └── Claude Code가 자체적으로:
                            파일 읽기/쓰기, 명령 실행, Git 조작
                            (NCO는 결과만 수집하여 Event Bus 브로드캐스트)

  루프 주체: Claude Code 자체 (내부 에이전트 루프)
  NCO 역할:  위임 + 결과 수집 + 상태 공유

═══ Type B: Single-shot Worker (codex, gemini, aider 등) ═══

  사용자 요청 → NCO → [NCO가 외부 루프 관리]
                        │
                        ├─ Think: CLI에 프롬프트 전송 (단발)
                        │         codex "프롬프트+컨텍스트+히스토리"
                        │         → AI가 응답 반환
                        │
                        ├─ Parse: NCO가 응답에서 도구 호출 추출
                        │         <nco-tool> 또는 JSON 패턴 감지
                        │
                        ├─ Act:   NCO가 도구를 직접 실행
                        │         (샌드박스 검증 → 파일 읽기/쓰기/명령)
                        │
                        ├─ Observe: 결과를 히스토리에 추가
                        │
                        └─ Loop:  히스토리 포함한 새 프롬프트로 다시 CLI 호출
                                  (최대 15회, 도구 30회, 교착 3회 반복 감지)

  루프 주체: NCO OrchestratedLoop
  NCO 역할:  프롬프트 조립 + CLI 호출 + 도구 실행 + 루프 관리

═══ Type C: API Agent (ollama, openrouter) ═══

  사용자 요청 → NCO → OpenAI 호환 API 호출
                        │
                        ├─ messages 배열에 히스토리 누적
                        ├─ function calling 지원 시 → AI가 도구 호출 요청
                        ├─ NCO가 도구 실행 → 결과를 messages에 추가
                        └─ AI가 최종 응답 → 완료

  루프 주체: API 멀티턴 (messages 배열 누적)
  NCO 역할:  API 호출 + function call 실행 + 키 롤링
```

### 11.2 안전 장치 종합

```
┌─────────────────────────────────────────────────────┐
│ 모든 에이전트 유형에 공통 적용되는 안전 장치:          │
│                                                      │
│ 1. 샌드박스 (Section 7)                               │
│    - PathGuard: 허용 경로만 접근                      │
│    - CommandGate: 허용 명령만 실행                     │
│    - ResourceLimiter: 시간/메모리 제한                 │
│                                                      │
│ 2. Circuit Breaker (Section 7.5)                      │
│    - 5회 연속 실패 → 에이전트 격리 (60s)               │
│    - half-open 시험 → 성공 시 복귀                    │
│                                                      │
│ 3. 루프 제한 (Type B/C)                               │
│    - 최대 반복: 15회                                  │
│    - 최대 도구 호출: 30회                              │
│    - 교착 감지: 같은 도구+인자 3회 반복 → 강제 종료     │
│    - 시간 초과: 에이전트별 maxExecutionTime             │
│                                                      │
│ 4. 에스컬레이션                                       │
│    - 루프 강제 종료 시 → Commander에게 자동 보고         │
│    - Commander가 다른 에이전트로 재위임 결정             │
└─────────────────────────────────────────────────────┘
```

---

## 12. 프로젝트 구조 (v4)

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
│   ├── core/                       # ★ 핵심 5축
│   │   ├── event-bus.ts            # 이벤트 버스 (Redis Pub/Sub + Streams)
│   │   ├── shared-state.ts         # 공유 상태 관리
│   │   ├── sync-engine.ts          # Redis ↔ SQLite 동기화         ★ v4
│   │   └── discussion-engine.ts    # 토론 엔진
│   │
│   ├── agent/                      # ★ 에이전트 시스템
│   │   ├── agent.ts                # 에이전트 인터페이스
│   │   ├── agent-manager.ts        # 에이전트 생명주기 관리
│   │   ├── agent-tools.ts          # 에이전트 도구 (read/write/edit/delete/create/run)
│   │   ├── native-executor.ts      # Type A: Claude Code 네이티브  ★ v4
│   │   ├── orchestrated-loop.ts    # Type B: NCO 외부 루프 (핵심)  ★ v4
│   │   ├── api-executor.ts         # Type C: API 멀티턴 (Ollama, OpenRouter)
│   │   ├── tool-parser.ts          # NCO Tool Protocol 파서       ★ v4
│   │   ├── smart-router.ts         # 복잡도→에이전트 자동 선택     ★ v4
│   │   ├── message-queue.ts        # 에이전트별 메시지 대기열      ★ v4
│   │   └── providers/              # 프로바이더별 설정
│   │       ├── claude-code.ts
│   │       ├── opencode.ts
│   │       ├── gemini.ts
│   │       ├── codex.ts
│   │       ├── aider.ts
│   │       ├── cursor-agent.ts
│   │       ├── copilot.ts
│   │       ├── openrouter.ts
│   │       └── ollama.ts
│   │
│   ├── security/                   # ★ 보안 & 격리                ★ v4
│   │   ├── sandbox-manager.ts      # 통합 샌드박스 관리
│   │   ├── path-guard.ts           # 경로 보안
│   │   ├── command-gate.ts         # 명령 실행 보안
│   │   ├── resource-limiter.ts     # 리소스 제한
│   │   └── circuit-breaker.ts      # 장애 격리
│   │
│   ├── server/                     # HTTP/WS 서버
│   │   ├── gateway.ts              # Fastify (6200)
│   │   ├── websocket.ts            # WebSocket (6201)
│   │   ├── realtime-bridge.ts      # Event Bus ↔ WebSocket 브릿지  ★ v4
│   │   ├── sse.ts                  # SSE 스트리밍
│   │   └── routes/
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
│   │       └── ...
│   │
│   ├── storage/
│   │   ├── database.ts             # SQLite (WAL)
│   │   ├── migrations.ts
│   │   ├── redis.ts
│   │   └── repos/
│   │       ├── task-repo.ts
│   │       ├── discussion-repo.ts
│   │       ├── artifact-repo.ts
│   │       ├── message-repo.ts
│   │       └── metrics-repo.ts
│   │
│   ├── queue/
│   │   ├── factory.ts
│   │   └── processor.ts
│   │
│   ├── mcp/
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

## 13. DB 스키마 (v4 — 에이전트 중심 + 보안/상태머신)

```sql
-- ═══════════════════════════════
-- 에이전트 (중심 테이블)
-- ═══════════════════════════════
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  score INTEGER DEFAULT 50,
  type TEXT NOT NULL,
  model TEXT,
  command TEXT,
  args_json TEXT DEFAULT '[]',
  endpoint TEXT,
  api_key_ref TEXT,
  capabilities_json TEXT DEFAULT '[]',
  permissions_json TEXT DEFAULT '{}',
  persona_json TEXT DEFAULT '{}',
  sandbox_json TEXT DEFAULT '{}',          -- v4: 샌드박스 정책
  concurrency INTEGER DEFAULT 4,
  rate_limit_rpm INTEGER DEFAULT 20,
  cost TEXT DEFAULT 'free',
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'offline',
  last_heartbeat TEXT,
  circuit_state TEXT DEFAULT 'closed',     -- v4: closed/open/half-open
  consecutive_failures INTEGER DEFAULT 0,  -- v4: Circuit Breaker 카운터
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════
-- 에이전트 행동 로그
-- ═══════════════════════════════
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_type TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  task_id TEXT,
  session_id TEXT,
  sandbox_result TEXT,                     -- v4: 'allowed' | 'denied'
  denied_reason TEXT,                      -- v4: 차단 사유
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_actions_agent ON agent_actions(agent_id, created_at DESC);
CREATE INDEX idx_actions_task ON agent_actions(task_id);
CREATE INDEX idx_actions_type ON agent_actions(action_type);

-- ═══════════════════════════════
-- 에이전트 간 메시지
-- ═══════════════════════════════
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'direct',
  priority TEXT DEFAULT 'normal',          -- v4: critical/high/normal/low
  reply_to TEXT,                           -- v4: 답장 대상 메시지 ID
  artifact_id TEXT,
  session_id TEXT,
  ack_at TEXT,                             -- v4: ACK 수신 시각
  ttl_seconds INTEGER DEFAULT 300,         -- v4: 만료 시간
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_from ON agent_messages(from_agent);
CREATE INDEX idx_messages_to ON agent_messages(to_agent);
CREATE INDEX idx_messages_session ON agent_messages(session_id);
CREATE INDEX idx_messages_priority ON agent_messages(priority);  -- v4

-- ═══════════════════════════════
-- 작업 결과물
-- ═══════════════════════════════
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT,
  artifact_type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  review_status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_artifacts_agent ON artifacts(agent_id);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_review ON artifacts(review_status);

-- ═══════════════════════════════
-- 작업 (v4: 상태 머신)
-- ═══════════════════════════════
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'task',
  prompt TEXT NOT NULL,
  assigned_to TEXT REFERENCES agents(id),
  delegated_from TEXT,
  status TEXT DEFAULT 'pending',           -- v4: pending/assigned/running/reviewing/completed/failed/cancelled
  progress REAL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  workspace_id TEXT DEFAULT 'default',
  parent_task_id TEXT,
  priority INTEGER DEFAULT 0,
  complexity INTEGER,                      -- v4: Smart Router 분석 결과 (1-10)
  retry_count INTEGER DEFAULT 0,           -- v4: 재시도 횟수
  router_reason TEXT,                      -- v4: Smart Router 선택 사유
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
  mode TEXT DEFAULT 'discussion',
  status TEXT DEFAULT 'active',
  participants_json TEXT NOT NULL,
  initiator TEXT NOT NULL,
  current_round INTEGER DEFAULT 0,
  max_rounds INTEGER DEFAULT 3,
  consensus_threshold REAL DEFAULT 0.8,
  consensus_rate REAL DEFAULT 0,
  result_json TEXT,
  report TEXT,
  task_id TEXT,
  user_interventions INTEGER DEFAULT 0,    -- v4: 사용자 개입 횟수
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

-- ═══════════════════════════════
-- 토론 메시지
-- ═══════════════════════════════
CREATE TABLE discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,                  -- 'user' = 사용자 개입
  round INTEGER,
  message_type TEXT DEFAULT 'proposal',
  content TEXT NOT NULL,
  scores_json TEXT,
  vote_choice TEXT,
  vote_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_disc_msgs ON discussion_messages(discussion_id, round);

-- ═══════════════════════════════
-- 이벤트 시퀀스 (v4: 동기화 추적)
-- ═══════════════════════════════
CREATE TABLE sync_state (
  id TEXT PRIMARY KEY DEFAULT 'global',
  last_synced_seq INTEGER DEFAULT 0,       -- 마지막 동기화 시퀀스
  last_synced_at TEXT,
  synced_count INTEGER DEFAULT 0
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

## 14. 구현 순서 (핵심 먼저)

```
═══════════════════════════════════════════════════════
Phase 1: 뼈대 + Event Bus + 공유 상태 + 동기화
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: 이벤트를 발행/구독할 수 있고,
                     공유 상태를 읽고 쓰고 동기화한다.

  ├── 프로젝트 초기화 (package.json, tsconfig)
  ├── config/ (topology.json, ai-providers.json)
  ├── storage/database.ts + 마이그레이션 (v4 스키마)
  ├── storage/redis.ts
  ├── core/event-bus.ts          ★ 핵심 1 (Redis Pub/Sub + Streams)
  ├── core/shared-state.ts       ★ 핵심 2
  ├── core/sync-engine.ts        ★ 핵심 3 (v4: Redis↔SQLite 동기화)
  ├── utils/ (logger, config, id)
  └── 검증: EventBus.publish() → Redis Streams 기록
            SyncEngine.forwardSync() → SQLite 기록
            SyncEngine.recoverySync() → Redis 복원

═══════════════════════════════════════════════════════
Phase 2: 에이전트 시스템 + 보안 격리
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: AI를 에이전트로 안전하게 실행한다.
                     모든 행동이 샌드박스 내에서만 실행된다.

  ├── security/path-guard.ts     ★ v4: 경로 보안
  ├── security/command-gate.ts   ★ v4: 명령 보안
  ├── security/resource-limiter.ts ★ v4: 리소스 제한
  ├── security/circuit-breaker.ts  ★ v4: 장애 격리
  ├── security/sandbox-manager.ts  ★ v4: 통합 관리
  ├── agent/agent.ts
  ├── agent/agent-tools.ts       (샌드박스 경유)
  ├── agent/tool-parser.ts       ★ v4: NCO Tool Protocol + 폴백 파서
  ├── agent/native-executor.ts   ★ v4: Type A (claude-code)
  ├── agent/orchestrated-loop.ts ★ v4: Type B (NCO 외부 루프 — 핵심)
  ├── agent/api-executor.ts      ★ v4: Type C (Ollama, OpenRouter + 키 롤링)
  ├── agent/agent-manager.ts     ★ v4: 유형별 실행 분배
  ├── agent/smart-router.ts      ★ v4: 복잡도→에이전트 선택
  ├── agent/message-queue.ts     ★ v4: 메시지 대기열
  ├── agent/providers/ (9개)
  └── 검증: codex 에이전트 실행 (Type B — OrchestratedLoop)
            → NCO가 프롬프트 조립 → codex 단발 호출 ✓
            → 응답에서 <nco-tool> 파싱 ✓
            → NCO가 도구 실행 (파일 읽기, 허용 경로) ✓
            → /etc/passwd 읽기 (PathGuard 차단) ✓
            → rm -rf 실행 (CommandGate 차단) ✓
            → npm test 실행 (허용) ✓
            → 결과를 히스토리에 추가 → 다시 codex 호출 (루프) ✓
            → Circuit Breaker (5회 실패 → 격리) ✓

═══════════════════════════════════════════════════════
Phase 3: 토론 엔진
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: AI들이 토론하고 사용자가 개입한다.

  ├── core/discussion-engine.ts  ★ 핵심
  │   ├── 라운드 기반 토론
  │   ├── 자유 토론 모드
  │   ├── 사용자 개입 (discussion:user_intervention)  ★ v4
  │   ├── 합의 계산 (가중치 투표)
  │   ├── 보고서 생성
  │   └── Event Bus 연동
  └── 검증: /nco-discussion "주제"
            → 3개 AI가 제안 → 상호 평가 → 합의
            → 사용자가 WebSocket으로 방향 수정 → 반영 확인

═══════════════════════════════════════════════════════
Phase 4: 실시간 양방향 통신
═══════════════════════════════════════════════════════
  이 Phase가 끝나면: 사용자와 에이전트가 양방향 실시간 통신.

  ├── server/gateway.ts          Fastify (6200)
  ├── server/realtime-bridge.ts  ★ v4: 양방향 브릿지
  ├── server/websocket.ts        WebSocket (6201)
  │   ├── 상향 메시지 처리 (사용자 → Event Bus)
  │   ├── 시퀀스 기반 재연결
  │   └── 백프레셔 관리
  ├── server/sse.ts              SSE 스트리밍
  ├── server/routes/ (기본 라우트)
  └── 검증: WebSocket 연결 → 에이전트 행동 실시간 수신
            연결 끊김 → 재연결 → 놓친 이벤트 수신 확인
            9개 에이전트 동시 → 백프레셔 스로틀 확인

═══════════════════════════════════════════════════════
Phase 5: 대시보드 호환 API
═══════════════════════════════════════════════════════
  ├── server/routes/ 나머지 전체
  ├── queue/factory.ts (BullMQ)
  ├── queue/processor.ts
  └── 검증: Dashboard → 모든 페이지 정상

═══════════════════════════════════════════════════════
Phase 6: MCP + Claude Code 통합
═══════════════════════════════════════════════════════
  ├── mcp/server.ts (26개 도구)
  ├── .claude/commands/ (45+개)
  └── 검증: /nco-discussion → MCP로 토론 시작

═══════════════════════════════════════════════════════
Phase 7: 완성
═══════════════════════════════════════════════════════
  ├── ecosystem.config.cjs (PM2: gateway + worker + ollama)
  ├── 테스트 (vitest)
  ├── 모니터링/알림
  └── 문서화
```

---

## 15. 핵심 검증 시나리오

### 시나리오 1: 에이전트 자율 실행 + 샌드박스 (Phase 2 검증)

```bash
POST /api/task
{ "ai": "codex", "prompt": "src/utils/에 날짜 포맷 유틸 함수 만들어" }

# 기대 결과:
# 1. Smart Router: 복잡도 3, codex 선택 (code 능력 매칭)
# 2. Task: pending → assigned → running
# 3. codex: read_file('src/utils/') → PathGuard 허용 ✓
# 4. codex: create_file('src/utils/date-format.ts') → PathGuard 허용 ✓
# 5. codex: run_command('npm test') → CommandGate 허용 ✓
# 6. codex: read_file('/etc/passwd') → PathGuard 차단 ✗ → action:denied
# 7. Task: running → completed
# 8. Autonomous Loop: 10회 이내 완료
# 9. 모든 행동이 Event Bus + Redis Stream 기록
```

### 시나리오 2: 토론 + 사용자 개입 (Phase 3-4 검증)

```bash
POST /api/realtime/discussion
{ "prompt": "에러 핸들링 전략", "providers": ["opencode","codex","gemini"] }

# 기대 결과:
# 1. Round 1: 각자 제안 (WebSocket으로 실시간 스트리밍)
# 2. 사용자 개입: "보안 관점도 고려해줘" (WebSocket 상향)
#    → discussion:user_intervention → 에이전트들이 반영
# 3. Round 2: 상호 평가
# 4. 합의 → 보고서
# 5. WebSocket 끊김 → 재연결 → lastSeq 이후 이벤트 수신
```

### 시나리오 3: Circuit Breaker (Phase 2 검증)

```bash
# aider가 5회 연속 실패 (OpenRouter rate limit)
# 1. 실패 1-4: task:failed → 재시도
# 2. 실패 5: circuit_open → agent:isolated
# 3. 60초 후: circuit half-open → 시험 요청 1개
# 4. 성공: circuit_close → 정상 복귀
# 5. 실패: circuit_open → 추가 60초 대기
```

### 시나리오 4: 대규모 병렬 작업 (Phase 4 검증)

```bash
# 9개 에이전트 동시 작업
# 1. WebSocket에 초당 ~50개 이벤트 발생
# 2. 백프레셔: buffered > 500 → heartbeat/progress 드롭
# 3. 클라이언트 처리 속도 회복 → 스로틀 해제
# 4. 이벤트 순서 보장 (seq 기반)
```

---

## 16. 기술 스택

```
핵심:
  fastify          — HTTP 서버
  ws               — WebSocket
  ioredis          — Redis (Event Bus + Streams + 공유 상태)
  better-sqlite3   — SQLite (영속 저장)
  bullmq           — 작업 큐
  execa            — subprocess (CLI AI)
  openai           — API AI (Ollama Gemma 4, OpenRouter)
  zod              — 검증
  pino             — 로거
  nanoid           — ID 생성
  eventemitter3    — 로컬 이벤트
  dotenv           — 환경변수
  minimatch        — glob 패턴 매칭 (PathGuard)

개발:
  typescript, tsx, vitest
```

---

## 17. 즉시 실행 명령

```bash
cd /home/nova/projects/neural-cli-orchestrator

npm install fastify @fastify/cors ws ioredis better-sqlite3 \
  bullmq execa openai zod pino pino-pretty nanoid \
  eventemitter3 dotenv minimatch

npm install -D typescript tsx @types/node @types/ws @types/better-sqlite3 vitest

npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --outDir dist --rootDir src --strict --esModuleInterop --declaration
```

---

> **상태**: v4.1 설계 완료 — 실행 대기
>
> **v3 → v4.1 핵심 변경 사항**:
>
> **현실 기반 실행 모델 (v4.1 핵심)**:
> - CLI AI는 멀티턴 대화가 안 된다는 **현실적 제약** 반영
> - **3가지 실행 유형**: Type A (Native/claude), Type B (Single-shot/NCO 외부 루프), Type C (API 멀티턴)
> - **OrchestratedLoop**: NCO가 "지휘자", AI가 "두뇌". NCO가 프롬프트 조립→CLI 호출→도구 실행→루프 관리
> - 각 CLI AI의 **실제 호출 방식** 명시 (codex, gemini, aider, opencode, cursor-agent, copilot)
>
> **보안 격리**: PathGuard + CommandGate + ResourceLimiter + CircuitBreaker
> **실시간 양방향**: WebSocket 양방향 + Redis Stream ID 기반 재연결 + 백프레셔
> **동기화 전략**: Redis↔SQLite 3단계 동기화 (Forward 5s + Recovery + Event-driven)
> **메시지 프로토콜**: 우선순위 4단계 + ACK + TTL + 비동기 대기열
> **NCO Tool Protocol**: `<nco-tool>` 표준 + function calling + JSON block 폴백
> **작업 상태 머신**: 7단계 (pending→assigned→running→reviewing→completed/failed/cancelled)
> **Smart Router**: 복잡도 분석 + 능력 매칭 + 비용 최적화
> **합의 알고리즘**: 가중 투표 (에이전트 점수 기반 가중치, 80% 임계값)
> **API 키 롤링**: 쿨다운 관리 + 전체 제한 시 Ollama 폴백 자동 전환
> **Ollama**: Gemma 4 26B (NVFP4, Active 4B MoE, RTX 4090)
> **gemini-api 제거**: 9개 에이전트로 통일
>
> 승인 시 Phase 1부터 구현 시작.
