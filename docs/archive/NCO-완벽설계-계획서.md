# NCO (Neural CLI Orchestrator) 완벽 백엔드 설계서 v2.0

> **작성일**: 2026-04-09  
> **버전**: v2.0 — 복구 데이터 기반 완전 재설계  
> **상태**: 설계 완료 — 실행 대기  
> **근거**: 복구 스냅샷 3축 + 가이드 문서 4종 + MCP 서버 소스 + 프론트엔드 API 계약 분석

---

## 0. 배경 및 현재 상태

### 0.1 사고 경위
2026-04-09 `wsl --unregister Ubuntu-24.04` 실행으로 ext4.vhdx(254GB) 영구 삭제.  
SSD TRIM으로 복구 불가. **6개월간의 백엔드 소스 전량 소실.**

### 0.2 복구 자산 현황

| 자산 | 상태 | 위치 |
|------|------|------|
| 프론트엔드 (NCO-Dashboard) | **완전 확보** | `D:/NCO-Dashboard` |
| Git 이력/stash/reflog | **확보** | `recovery-snapshot-20260409/evidence/` |
| 백엔드 API 계약 (엔드포인트/포트/프로토콜) | **확보** | 프론트 소스 + Vite 플러그인에서 역추출 |
| AI 프로바이더 설정 | **확보** | `config/ai-providers.json` |
| MCP 서버 소스 | **확보** | `mcp/nco-mcp-server-index.ts` (26개 도구 정의) |
| 복구 스켈레톤 (gateway/worker/ws) | **확보** | `neural-cli-orchestrator-recovered/` |
| PM2 설정 | **확보** | `ecosystem.config.cjs` |
| 백엔드 원본 소스 | **소실** | WSL ext4.vhdx와 함께 삭제 |
| Redis AOF 운영 흔적 | **확보** | `D:/NCO-Dashboard/appendonlydir/` |

### 0.3 복구 스켈레톤에서 확인된 실제 아키텍처

```
원본 런타임 토폴로지 (복구됨):
┌─────────────────────────────────────────────────────────────┐
│ Dashboard (6260) ──Vite Proxy──▶ Gateway (6200)             │
│                  ──WebSocket───▶ WS Server (6201)           │
│                                      │                      │
│                              ┌───────┼───────┐              │
│                              ▼       ▼       ▼              │
│                          BullMQ   SQLite   Redis(6379)      │
│                              │                              │
│                              ▼                              │
│                     Worker (task processor)                  │
│                              │                              │
│                    ┌─────────┼─────────┐                    │
│                    ▼         ▼         ▼                    │
│              AI CLI #1  AI CLI #2  AI API #N                │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. 시스템 아키텍처 (5-Layer)

### 1.1 전체 구조

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 5: Integration                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐    │
│  │ Claude Code  │ │ MCP Server   │ │ CLI Mesh Network     │    │
│  │ Slash/Hooks  │ │ (26 Tools)   │ │ (P2P AI Team)        │    │
│  └──────────────┘ └──────────────┘ └──────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: Orchestration                                          │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │ Conductor  │ │ Agent    │ │Discussion│ │ Smart Failover │   │
│  │ (자동배차) │ │ Loop     │ │ Engine   │ │ & Auto-Select  │   │
│  └───────────┘ └──────────┘ └──────────┘ └────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: AI Provider Management                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐   │
│  │ Registry     │ │ Process Pool │ │ Health Monitor       │   │
│  │ (등록/삭제)  │ │ (subprocess) │ │ (30s heartbeat)      │   │
│  └──────────────┘ └──────────────┘ └──────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Communication                                          │
│  ┌──────────┐ ┌──────────┐ ┌───────┐ ┌──────────────────┐    │
│  │ REST API │ │WebSocket │ │  SSE  │ │ Redis Pub/Sub    │    │
│  │ (6200)   │ │ (6201)   │ │       │ │ (6379) + BullMQ  │    │
│  └──────────┘ └──────────┘ └───────┘ └──────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Storage                                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │ SQLite   │ │ Redis    │ │ State    │ │ Workspace JSON │   │
│  │ (WAL)    │ │ (Cache)  │ │ File     │ │ (.nco-workspace)│  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 포트 토폴로지 (실제 복구 데이터 기준)

| 포트 | 서비스 | 프로토콜 | 상태 |
|------|--------|----------|------|
| **6200** | NCO API Gateway | HTTP/REST | 핵심 |
| **6201** | NCO WebSocket | WS | 핵심 |
| **6260** | Dashboard Dev Server | HTTP | 프론트 |
| **6379** | Redis | TCP | 큐/캐시 |
| **8000** | Ollama Server (OpenAI 호환) | HTTP | AI |

---

## 2. 디렉토리 구조

```
/opt/neural-cli-orchestrator/
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs           # PM2 프로세스 관리
├── .env                           # 환경변수
├── .env.example
│
├── config/
│   ├── topology.json              # 포트/서비스 토폴로지
│   └── ai-providers.json          # AI 프로바이더 등록 정보
│
├── src/
│   ├── gateway.ts                 # 메인 API 게이트웨이 (6200)
│   ├── worker.ts                  # BullMQ 작업 워커
│   │
│   ├── api/                       # API 라우트 모듈
│   │   ├── websocket-server.ts    # WebSocket 서버 (6201)
│   │   ├── routes/
│   │   │   ├── health.ts          # /health, /api/health
│   │   │   ├── providers.ts       # /api/ai-providers/*
│   │   │   ├── daemons.ts         # /api/daemons/*
│   │   │   ├── tasks.ts           # /api/tasks/*, /api/task-master/*
│   │   │   ├── chat.ts            # /api/chat/*
│   │   │   ├── collaboration.ts   # /api/parallel, /api/realtime/*
│   │   │   ├── sessions.ts        # /api/realtime-sessions/*
│   │   │   ├── agent.ts           # /api/agent/* (자율 에이전트 루프)
│   │   │   ├── conductor.ts       # /api/conductor/* (자동 배차)
│   │   │   ├── mesh.ts            # /api/mesh/* (CLI 메시 네트워크)
│   │   │   ├── skills.ts          # /api/skills/*
│   │   │   ├── workspace.ts       # /api/workspace/*
│   │   │   ├── learning.ts        # /api/learning/*, /api/auto-learning/*
│   │   │   ├── checkpoints.ts     # /api/checkpoints/*
│   │   │   ├── monitoring.ts      # /api/stats/*, /api/rate-limit/*, /api/quality/*
│   │   │   ├── security.ts        # /api/security/*
│   │   │   └── files.ts           # /api/file-api/*
│   │   └── middleware/
│   │       ├── cors.ts
│   │       ├── rate-limiter.ts
│   │       └── request-logger.ts
│   │
│   ├── core/                      # 핵심 오케스트레이션 엔진
│   │   ├── orchestrator.ts        # 메인 오케스트레이터
│   │   ├── conductor.ts           # Chief Conductor 자동 배차
│   │   ├── complexity-analyzer.ts # 프롬프트 복잡도 분석 (1-10)
│   │   ├── smart-router.ts        # AI 자동 선택 라우터
│   │   ├── smart-failover.ts      # 장애 시 자동 전환
│   │   └── session-manager.ts     # 세션 생명주기 관리
│   │
│   ├── ai/                        # AI 프로바이더 계층
│   │   ├── registry.ts            # 프로바이더 레지스트리 (등록/삭제/조회)
│   │   ├── process-pool.ts        # CLI AI 프로세스 풀 관리
│   │   ├── health-monitor.ts      # 30초 주기 헬스체크
│   │   ├── provider-base.ts       # 추상 프로바이더 클래스
│   │   └── providers/
│   │       ├── claude-code.ts     # 95점 Commander
│   │       ├── opencode.ts        # 90점 Architect (75+ LLM)
│   │       ├── gemini.ts          # 85점 Designer (Gemini 3 Pro)
│   │       ├── gemini-api.ts      # 85점 Analyst (14-key rotation)
│   │       ├── codex.ts           # 83점 Engineer
│   │       ├── aider.ts           # 82점 Engineer (대규모 리팩토링)
│   │       ├── cursor-agent.ts    # 78점 Reviewer
│   │       ├── copilot.ts         # 75점 Researcher
│   │       └── ollama.ts             # 70점 Validator (Ollama OpenAI 호환 API)
│   │
│   ├── discussion/                # 토론/합의 엔진
│   │   ├── engine.ts              # 토론 진행 엔진 (라운드 관리)
│   │   ├── consensus.ts           # 합의 도출기 (가중치 투표)
│   │   ├── hive.ts                # 하이브 모드 (9=1)
│   │   ├── moderator.ts           # 토론 중재자 (Commander)
│   │   ├── realtime-session.ts    # 실시간 토론 세션
│   │   └── report-generator.ts    # 토론 결과 보고서 생성
│   │
│   ├── agent/                     # 자율 에이전트 루프
│   │   ├── loop.ts                # think → act → observe 루프
│   │   ├── session.ts             # 에이전트 세션 관리
│   │   ├── approval.ts            # 도구 실행 승인/거부
│   │   └── store.ts               # /tmp/nco-sessions 세션 저장
│   │
│   ├── mesh/                      # CLI 메시 네트워크
│   │   ├── node.ts                # 메시 노드 (P2P)
│   │   ├── discovery.ts           # 노드 발견
│   │   ├── role-assignment.ts     # 인지 계층 역할 배정
│   │   └── messaging.ts           # 노드 간 메시징
│   │
│   ├── storage/                   # 저장소 계층
│   │   ├── sqlite-store.ts        # SQLite (WAL 모드) — 메인 DB
│   │   ├── memory-store.ts        # 메모리 스토어 — 폴백
│   │   ├── redis-client.ts        # Redis 연결 관리
│   │   ├── state-file.ts          # JSON 상태 파일 동기화
│   │   └── workspace.ts           # .nco-workspace 관리
│   │
│   ├── queue/                     # 작업 큐
│   │   ├── queue-factory.ts       # BullMQ 큐 팩토리
│   │   ├── task-processor.ts      # 작업 실행기 (실제 AI 호출)
│   │   └── job-types.ts           # 작업 유형 정의
│   │
│   ├── mcp/                       # MCP 서버
│   │   ├── server.ts              # MCP 서버 메인 (26개 도구)
│   │   └── tools/
│   │       ├── collaboration.ts   # nco_discussion/parallel/consensus/hive/task/broadcast
│   │       ├── status.ts          # nco_status/providers/daemons/health/rate_limits/queue_metrics
│   │       ├── sessions.ts        # nco_list_sessions/get_session/session_messages
│   │       ├── tasks.ts           # nco_get_task/list_tasks
│   │       ├── system.ts          # nco_start/stop/verify
│   │       └── agent.ts           # nco_agent_start/status/abort/approve/reject/sessions
│   │
│   └── utils/
│       ├── logger.ts              # pino 기반 고성능 로거
│       ├── config.ts              # 환경변수 + 설정 로더
│       ├── validation.ts          # zod 스키마
│       └── id.ts                  # nanoid 기반 ID 생성
│
├── .claude/                       # Claude Code 통합
│   ├── settings.json              # MCP 서버 + 훅 설정
│   ├── hooks/
│   │   ├── session-start.sh       # TIER1 로드, Git 상태, NCO 헬스, Plan 동기화
│   │   ├── end-of-turn-check.sh   # 팬텀 파일 체크 → tsc → ESLint → Plan 동기화
│   │   └── nco-statusline.sh      # 실시간 상태 업데이트
│   └── commands/                  # 커스텀 슬래시 명령 (45+개)
│       ├── nco.md                 # /nco — 글로벌 메뉴
│       ├── nco-task.md            # /nco-task — 단일 AI 위임
│       ├── nco-parallel.md        # /nco-parallel — 병렬 실행
│       ├── nco-discussion.md      # /nco-discussion — 토론
│       ├── nco-realtime.md        # /nco-realtime — 실시간 토론
│       ├── nco-consensus.md       # /nco-consensus — 합의
│       ├── nco-hive.md            # /nco-hive — 하이브 모드
│       ├── nco-broadcast.md       # /nco-broadcast — 전체 방송
│       ├── nco-commander.md       # /nco-commander — 계층 모드
│       ├── nco-conductor.md       # /nco-conductor — 자동 배차
│       ├── nco-agent.md           # /nco-agent — 자율 에이전트
│       ├── nco-start.md           # /nco-start — 전체 시작
│       ├── nco-stop.md            # /nco-stop — 전체 중지
│       ├── nco-status.md          # /nco-status — 상태 확인
│       ├── nco-providers.md       # /nco-providers — AI 목록
│       ├── nco-daemons.md         # /nco-daemons — 데몬 관리
│       ├── nco-mesh-join.md       # /nco-mesh-join — 메시 참여
│       ├── nco-mesh-task.md       # /nco-mesh-task — 동료에게 위임
│       ├── nco-mesh-say.md        # /nco-mesh-say — 브로드캐스트
│       ├── nco-listen.md          # /nco-listen — SSE 리스너
│       ├── nco-skills.md          # /nco-skills — 스킬 관리
│       ├── nco-verify.md          # /nco-verify — 설정 검증
│       ├── nco-tier1.md           # /nco-tier1 — 절대 규칙
│       ├── nco-help.md            # /nco-help — 도움말
│       └── ultrawork.md           # /ultrawork — 최대 성능 모드
│
├── db/
│   ├── migrations/
│   │   ├── 001_init.sql
│   │   ├── 002_sessions.sql
│   │   ├── 003_discussions.sql
│   │   ├── 004_metrics.sql
│   │   └── 005_agent_sessions.sql
│   └── nco.db                     # SQLite 런타임 DB
│
├── docs/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── scripts/
    ├── setup.sh                   # 초기 설치 스크립트
    └── health-check.sh            # 헬스체크 스크립트
```

---

## 3. AI 프로바이더 시스템 (등록/삭제/관리)

### 3.1 프로바이더 인터페이스 (복구 데이터 기반)

```typescript
// config/ai-providers.json 형식 (복구됨)
interface ProviderConfig {
  id: string;           // "claude-code", "ollama", etc.
  name: string;         // 표시 이름
  enabled: boolean;     // 활성화 여부
  type: 'cli' | 'api' | 'local';
  model: string | null; // 모델명
  command: string | null; // CLI 실행 명령
  args: string[];       // CLI 인자
  env: Record<string, string>; // 환경변수
}

// 런타임 프로바이더 (확장)
interface AIProvider extends ProviderConfig {
  score: number;         // 능력 점수 (70-95)
  role: string;          // Commander | Architect | Designer | Analyst | Engineer | Reviewer | Researcher | Validator
  capabilities: string[]; // ['code', 'review', 'test', 'design', 'analysis', ...]
  cost: 'free' | 'paid';
  status: 'online' | 'offline' | 'error' | 'disabled';
  metrics: {
    avgResponseMs: number;
    successRate: number;
    totalTasks: number;
    lastHealthCheck: string;
  };
}
```

### 3.2 9개 AI 프로바이더 매트릭스 (복구 확인)

| ID | 점수 | 역할 | 유형 | 특화 | 비용 |
|----|------|------|------|------|------|
| `claude-code` | 95 | Commander ★ | CLI | 아키텍처, 코드리뷰, 보안, 의사결정 | paid |
| `opencode` | 90 | Architect | CLI | 75+ LLM 접근, Antigravity 멀티모델 | paid |
| `gemini` | 85 | Designer | CLI | UI/UX 설계 (Gemini 3 Pro) | paid |
| `gemini-api` | 85 | Analyst | API | API 작업, 데이터 처리, **14-key rotation** | paid |
| `codex` | 83 | Engineer | CLI | 코드 생성, 알고리즘 | paid |
| `aider` | 82 | Engineer | CLI | 코드 편집, 대규모 리팩토링 | paid |
| `cursor-agent` | 78 | Reviewer | CLI | 코드 리뷰, IDE 통합 | paid |
| `copilot` | 75 | Researcher | CLI | 코드 완성, 정보 수집 | paid |
| `ollama` | 70 | Validator | api | 로컬 Ollama 서버, 고속 추론, **무료** | **free** |

### 3.3 동적 등록/삭제 시스템

```bash
# 등록 (config/ai-providers.json에 추가 + 즉시 반영)
nco ai add deepseek \
  --type api \
  --model deepseek-coder-v3 \
  --endpoint "https://api.deepseek.com/v1" \
  --key-env DEEPSEEK_API_KEY \
  --role Engineer \
  --score 80 \
  --capabilities code,review,test

# 삭제 (soft delete — DB 기록 보존, config에서 제거)
nco ai remove deepseek

# 관리
nco ai list                    # 전체 목록 + 상태
nco ai status                  # 실시간 헬스 + 메트릭
nco ai enable/disable <name>   # 활성화/비활성화 토글
nco ai test <name>             # 연결 테스트 + 응답 시간
nco ai metrics <name>          # 성능 메트릭 조회
nco ai rotate-key <name>       # API 키 로테이션 (gemini-api 14-key)
```

**등록 흐름:**
```
nco ai add <name> → config/ai-providers.json 갱신
                   → 즉시 헬스체크 실행
                   → SQLite providers 테이블에 메타 저장
                   → BullMQ에 전용 큐 생성 (nco-<name>)
                   → WebSocket으로 대시보드에 변경 알림
                   → 라우터 매트릭스 재계산
```

**삭제 흐름:**
```
nco ai remove <name> → 활성 세션 확인 (있으면 경고)
                      → BullMQ 큐 드레인 (대기 작업 처리)
                      → config/ai-providers.json에서 제거
                      → SQLite soft delete (status='removed')
                      → 프로세스 풀에서 kill
                      → WebSocket 알림
```

---

## 4. API 엔드포인트 전체 계약 (복구 + 신규)

### 4.1 Core API (복구 확인 — 프론트엔드 호환 필수)

```
# 헬스 & 시스템
GET  /health                        → 전체 시스템 상태
GET  /api/health                    → 상세 헬스 (store, queue, ws, uptime)

# AI 프로바이더
GET  /api/ai-providers              → 전체 프로바이더 목록
GET  /api/ai-providers/enabled      → 활성 프로바이더만
POST /api/ai-providers              → 프로바이더 등록 (NEW)
PUT  /api/ai-providers/:id          → 프로바이더 수정 (NEW)
DEL  /api/ai-providers/:id          → 프로바이더 삭제 (NEW)

# 데몬 관리
GET  /api/daemons                   → 전체 데몬 상태
GET  /api/daemons/by-workspace      → 워크스페이스별 데몬
POST /api/daemons/:name/start       → 데몬 시작
POST /api/daemons/:name/stop        → 데몬 중지
POST /api/daemons/:name/restart     → 데몬 재시작
POST /api/daemons/restart-all       → 전체 재시작

# 작업 관리
GET  /api/tasks                     → 작업 목록 (?limit, ?workspaceId, ?provider)
GET  /api/tasks/:id                 → 작업 상세
GET  /api/tasks/:id/status          → 작업 상태만
POST /api/task                      → 작업 생성 (단일)
POST /api/tasks                     → 작업 생성 (배치)
DEL  /api/tasks/:id                 → 작업 취소

# Task Master
GET  /api/task-master/tasks         → Task Master 작업 목록
GET  /api/task-master/stats         → 통계 (total, byStatus)
GET  /api/task-master/workspaces    → 워크스페이스 목록
```

### 4.2 Collaboration API (복구 확인)

```
# 채팅
GET  /api/chat/messages             → 메시지 목록 (?workspaceId)
POST /api/chat/messages             → 메시지 전송
DEL  /api/chat/messages             → 메시지 삭제 (?workspaceId)
GET  /api/chat/ais                  → 채팅 가능 AI 목록
GET  /api/chat/workspaces           → 채팅 워크스페이스 목록

# 협업 모드
POST /api/parallel                  → 병렬 실행
POST /api/chat/parallel             → 채팅 병렬
POST /api/chat/discussion           → 채팅 토론
POST /api/chat/consensus            → 채팅 합의

# 실시간 세션
POST /api/realtime/discussion       → 실시간 토론
POST /api/realtime/parallel         → 실시간 병렬
POST /api/realtime/consensus        → 실시간 합의
GET  /api/realtime-sessions         → 세션 목록
GET  /api/realtime-sessions/:id     → 세션 상세
```

### 4.3 Advanced API (프론트 Vite 플러그인에서 역추출)

```
# 에이전트 루프
POST /api/agent/start               → 자율 에이전트 시작
GET  /api/agent/:id/status          → 에이전트 상태
POST /api/agent/:id/abort           → 에이전트 중단
POST /api/agent/:id/approve         → 도구 실행 승인
POST /api/agent/:id/reject          → 도구 실행 거부
GET  /api/agent/sessions            → 에이전트 세션 목록

# Conductor (자동 배차)
POST /api/conductor/dispatch        → 자동 AI 배차
GET  /api/conductor/queue           → 배차 큐 상태

# 메시 네트워크
POST /api/mesh/join                 → 노드 참여
GET  /api/mesh/team                 → 팀 구성
POST /api/mesh/task                 → 동료에게 위임
GET  /api/mesh/status               → 노드 상태
POST /api/mesh/broadcast            → 전체 브로드캐스트
POST /api/mesh/dm                   → 다이렉트 메시지

# 스킬 관리
GET  /api/skills                    → 스킬 목록
POST /api/skills/install            → 스킬 설치
DEL  /api/skills/:id                → 스킬 삭제

# 워크스페이스
GET  /api/workspace                 → 워크스페이스 상태
POST /api/workspace/init            → 워크스페이스 초기화

# 학습 데이터
GET  /api/learning                  → 학습 데이터 조회
POST /api/learning                  → 학습 데이터 저장
POST /api/auto-learning/feedback    → 자동 학습 피드백

# 체크포인트
GET  /api/checkpoints               → 체크포인트 목록
POST /api/checkpoints               → 체크포인트 생성
POST /api/checkpoints/:id/restore   → 롤백

# 모니터링
GET  /api/stats                     → 시스템 통계
GET  /api/rate-limit                → Rate Limit 현황
GET  /api/rate-limit/analysis       → Rate Limit 분석
GET  /api/quality/metrics           → 품질 메트릭
GET  /api/event-monitor/events      → 이벤트 로그

# 파일 시스템
GET  /api/file-api/tree             → 파일 트리
GET  /api/file-api/read             → 파일 읽기
```

### 4.4 WebSocket 계약 (포트 6201, 복구 확인)

```typescript
// 클라이언트 → 서버
{ type: "subscribe", taskId: string }      // 작업 구독
{ type: "unsubscribe", taskId: string }    // 구독 해제
{ type: "join_discussion", sessionId: string }  // 토론 참여
{ type: "send_message", sessionId: string, content: string }

// 서버 → 클라이언트
{ type: "connected", clientId: string }    // 연결 완료
{ type: "subscribed", taskId: string }     // 구독 확인
{ type: "unsubscribed", taskId: string }   // 해제 확인
{ type: "task-created", taskId, task }     // 작업 생성됨
{ type: "task_complete", taskId, task }    // 작업 완료
{ type: "task_progress", taskId, progress } // 작업 진행률
{ type: "token_stream", sessionId, token } // 토큰 스트리밍
{ type: "discussion_round", sessionId, round } // 토론 라운드
{ type: "consensus_update", sessionId, rate }  // 합의율 갱신
{ type: "ai_status_change", providerId, status } // AI 상태 변경
{ type: "error", message }                 // 에러

// 토론 전용 WebSocket 경로
ws://localhost:6201/discussion/:id         // 특정 토론 세션 구독
```

---

## 5. 토론/합의 엔진 상세 설계

### 5.1 7가지 협업 모드

| 모드 | 복잡도 | AI 수 | 트리거 | 실행 방식 |
|------|--------|--------|--------|-----------|
| `/nco-task` | 1-4 | 1 | 단순 작업 | 단일 AI 직접 실행 |
| `/nco-parallel` | 5-7 | 2-3 | 비교 필요 | 동일 프롬프트 병렬 전송 → 결과 비교 |
| `/nco-discussion` | 5-8 | 3-5 | 복잡한 설계 | 순차 토론 (라운드제) |
| `/nco-realtime` | 5-8 | 3-5 | 빠른 토론 | 실시간 스트리밍 토론 |
| `/nco-consensus` | 8-10 | 5-7 | 중대 결정 | 가중치 투표 기반 합의 |
| `/nco-hive` | 10 | 9 전체 | 초복잡 과제 | 9=1 하이브마인드 |
| `/nco-broadcast` | - | 9 전체 | 공지 | 전원에게 동시 전달 |

### 5.2 토론 엔진 흐름

```
사용자 → /nco-discussion "주제"
         │
         ▼
┌─────────────────────────────────────────────┐
│ Step 1: 세션 생성                            │
│   - 복잡도 분석 (1-10)                       │
│   - 참여 AI 자동 선정 (역할 기반)             │
│   - WebSocket 세션 채널 생성                  │
│   - SQLite sessions 테이블에 기록             │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ Step 2: Round 1 — 초기 제안 (병렬)           │
│   ┌→ AI-A: "방안 A 제시"  ─┐                │
│   ├→ AI-B: "방안 B 제시"  ─┼→ BullMQ 큐     │
│   └→ AI-C: "방안 C 제시"  ─┘   각각 별도 job │
│                                              │
│   WebSocket: 각 AI 응답 토큰 실시간 스트리밍   │
│   SQLite: discussion_rounds 기록              │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ Step 3: Round 2 — 상호 평가 (병렬)           │
│   각 AI에게 다른 AI의 응답 전달               │
│   → 장점/단점 분석                           │
│   → 1-10점 평가                              │
│   → 개선안 제시                              │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ Step 4: 합의율 계산                          │
│   가중치 = AI 점수(score) × 역할 적합도       │
│                                              │
│   합의율 = Σ(가중치 × 동의) / Σ(가중치)       │
│                                              │
│   ≥ 80% → Step 6 (합의 완료)                 │
│   < 80% → Step 5 (추가 라운드)               │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ Step 5: 추가 라운드 (최대 3회)               │
│   쟁점만 추출 → 집중 토론                     │
│   라운드마다 합의율 재계산                     │
│   3회 후에도 미합의 → 다수결 채택              │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ Step 6: 최종 보고서 생성                     │
│   Commander(claude-code)가 종합:              │
│   - 채택된 방안 + 근거                       │
│   - 반론 요약 (소수 의견 보존)                │
│   - 실행 계획 (단계별)                       │
│   - 참여 AI별 기여도                         │
│                                              │
│   → WebSocket 스트리밍                       │
│   → SQLite 보고서 저장                       │
│   → 대시보드 알림                            │
└─────────────────────────────────────────────┘
```

### 5.3 Agent 루프 (Cline 스타일)

```
/nco-agent "auth 모듈에 JWT 검증 추가"
         │
         ▼
┌─────────────────────────────────────────────┐
│ THINK: 작업 분석                             │
│   - 현재 코드 구조 파악                      │
│   - 필요한 변경 사항 목록화                   │
│   - 실행 계획 수립                           │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ ACT: 도구 실행 제안                          │
│   - 파일 읽기/수정 요청                      │
│   - 터미널 명령 실행 요청                     │
│   → 사용자 승인 대기 (approve/reject)         │
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ OBSERVE: 결과 관찰                           │
│   - 실행 결과 분석                           │
│   - 에러 시 자동 수정 시도                    │
│   - 다음 단계 결정                           │
│   → 완료 or THINK로 복귀                     │
└─────────────────────────────────────────────┘
```

---

## 6. DB 스키마 (확장판)

```sql
-- ============================
-- 001_init.sql
-- ============================

-- AI 프로바이더
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('local', 'api', 'cli')),
  role TEXT,                         -- Commander, Architect, etc.
  score INTEGER DEFAULT 50,          -- 능력 점수 (1-100)
  model TEXT,
  command TEXT,
  args TEXT,                         -- JSON array
  endpoint TEXT,
  api_key_ref TEXT,                  -- 환경변수 이름만 저장
  capabilities TEXT NOT NULL,        -- JSON array
  cost TEXT DEFAULT 'free' CHECK(cost IN ('free', 'paid')),
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'offline',
  config_json TEXT,                  -- 추가 설정 (JSON)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  removed_at TEXT                    -- soft delete
);

-- 작업
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                -- task, parallel, discussion, consensus, hive, chat-*, realtime-*, agent
  provider TEXT,
  prompt TEXT,
  workspace_id TEXT DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'accepted',
  payload_json TEXT,                 -- 전체 요청 본문
  result_json TEXT,                  -- 실행 결과
  queue_job_id TEXT,                 -- BullMQ job ID
  duration_ms INTEGER,
  token_count INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_tasks_provider ON tasks(provider);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

-- ============================
-- 002_sessions.sql
-- ============================

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  topic TEXT,
  complexity INTEGER,                -- 1-10
  participants TEXT NOT NULL,        -- JSON array of provider IDs
  context TEXT,                      -- 공유 컨텍스트
  config_json TEXT,                  -- 세션 설정 (max_rounds, timeout, etc.)
  result_json TEXT,                  -- 최종 결과
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

-- ============================
-- 003_discussions.sql
-- ============================

CREATE TABLE discussion_rounds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  round_type TEXT DEFAULT 'proposal', -- proposal, evaluation, rebuttal, vote
  responses_json TEXT NOT NULL,       -- {providerId: {content, tokens, durationMs}}
  evaluations_json TEXT,              -- {providerId: {scores: {}, comments: {}}}
  consensus_rate REAL,                -- 0.0 - 1.0
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, round_number)
);

CREATE TABLE discussion_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  adopted_proposal TEXT,             -- 채택된 방안
  rationale TEXT,                    -- 근거
  dissenting_opinions TEXT,          -- 반론 요약 (JSON)
  action_plan TEXT,                  -- 실행 계획
  contribution_json TEXT,            -- AI별 기여도 (JSON)
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================
-- 004_metrics.sql
-- ============================

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,         -- response_time, success_rate, quality_score, token_usage, cost
  value REAL NOT NULL,
  metadata_json TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_metrics_provider ON metrics(provider_id, metric_type);
CREATE INDEX idx_metrics_time ON metrics(recorded_at DESC);

-- Rate Limit 추적
CREATE TABLE rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  limit_type TEXT NOT NULL,          -- rpm, tpm, daily
  current_usage INTEGER DEFAULT 0,
  max_limit INTEGER,
  reset_at TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

-- ============================
-- 005_agent_sessions.sql
-- ============================

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'thinking',    -- thinking, acting, waiting_approval, observing, completed, aborted
  provider_id TEXT,
  steps_json TEXT,                   -- [{type: think|act|observe, content, timestamp}]
  pending_action_json TEXT,          -- 승인 대기 중인 액션
  result_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================
-- 006_learning.sql
-- ============================

CREATE TABLE learning_data (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  task_type TEXT,
  input_summary TEXT,
  output_quality REAL,               -- 0.0 - 1.0
  user_feedback TEXT,                -- positive, negative, neutral
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================
-- 007_checkpoints.sql
-- ============================

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default',
  description TEXT,
  state_json TEXT,                   -- 전체 상태 스냅샷
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## 7. 기술 스택 및 의존성 (최종)

### 7.1 핵심 (복구된 원본 호환 + 성능 업그레이드)

| 패키지 | 용도 | 선정 근거 |
|--------|------|-----------|
| `express` → **`fastify`** | REST API 서버 | 원본은 Express, 재구축 시 2x 성능 향상 |
| `ws` | WebSocket 서버 | 원본 동일 — 경량, 안정적 |
| `bullmq` | 작업 큐 | 원본 동일 — Redis 기반 |
| `ioredis` | Redis 클라이언트 | 원본 동일 |
| `better-sqlite3` | SQLite | 원본 동일 — 네이티브 WAL |
| `cors` | CORS 미들웨어 | 원본 동일 (Fastify 플러그인으로 전환) |

### 7.2 AI 통합

| 패키지 | 용도 |
|--------|------|
| `execa` | CLI AI subprocess 관리 (stdin/stdout 파이프) |
| `@anthropic-ai/sdk` | Claude API 직접 호출 |
| `@google/generative-ai` | Gemini API 직접 호출 (14-key rotation) |
| `openai` | OpenAI 호환 API (Codex, Ollama) |

### 7.3 MCP & Claude Code

| 패키지 | 용도 |
|--------|------|
| `@modelcontextprotocol/sdk` | MCP 서버 (26개 도구) |
| `@anthropic-ai/sdk` | MCP 서버 런타임 |

### 7.4 CLI & 유틸리티

| 패키지 | 용도 |
|--------|------|
| `commander` | CLI 프레임워크 |
| `chalk` | 컬러 출력 |
| `ora` | 스피너 |
| `zod` | 런타임 스키마 검증 |
| `pino` + `pino-pretty` | 고성능 로거 |
| `nanoid` | ID 생성 |
| `eventemitter3` | 이벤트 버스 |
| `p-queue` | 동시성 제어 큐 |
| `dotenv` | 환경변수 |

### 7.5 프로세스 관리

| 도구 | 용도 |
|------|------|
| `pm2` | 프로덕션 프로세스 관리 (원본 동일) |
| `ecosystem.config.cjs` | PM2 설정 (gateway + worker) |

### 7.6 개발/테스트

| 패키지 | 용도 |
|--------|------|
| `typescript` ^5.9 | 메인 언어 |
| `tsx` | TS 직접 실행 |
| `vitest` | 단위/통합 테스트 |
| `@types/ws`, `@types/better-sqlite3` | 타입 정의 |

---

## 8. MCP 서버 26개 도구 (복구 소스 기반)

### 8.1 Collaboration (6개)

| 도구 | 설명 | API 호출 |
|------|------|----------|
| `nco_discussion` | 멀티 AI 토론 시작 | POST /api/realtime/discussion |
| `nco_parallel` | 병렬 AI 실행 | POST /api/parallel |
| `nco_consensus` | AI 합의 모드 | POST /api/realtime/consensus |
| `nco_hive` | 하이브 모드 (9=1) | POST /api/realtime/discussion (mode=hive) |
| `nco_task` | 단일 AI 위임 | POST /api/task |
| `nco_broadcast` | 전체 방송 | POST /api/chat/messages (broadcast=true) |

### 8.2 Status (6개)

| 도구 | 설명 | API 호출 |
|------|------|----------|
| `nco_status` | 시스템 상태 | GET /health |
| `nco_providers` | AI 프로바이더 목록 | GET /api/ai-providers |
| `nco_daemons` | 데몬 상태 | GET /api/daemons |
| `nco_health` | 상세 헬스 | GET /api/health |
| `nco_rate_limits` | Rate Limit 현황 | GET /api/rate-limit |
| `nco_queue_metrics` | BullMQ 큐 메트릭 | GET /health (queues) |

### 8.3 Sessions (3개)

| 도구 | 설명 | API 호출 |
|------|------|----------|
| `nco_list_sessions` | 세션 목록 | GET /api/realtime-sessions |
| `nco_get_session` | 세션 상세 | GET /api/realtime-sessions/:id |
| `nco_session_messages` | 세션 메시지 | GET /api/realtime-sessions/:id/messages |

### 8.4 Tasks (2개)

| 도구 | 설명 | API 호출 |
|------|------|----------|
| `nco_get_task` | 작업 상세 | GET /api/tasks/:id |
| `nco_list_tasks` | 작업 목록 | GET /api/tasks |

### 8.5 System (3개)

| 도구 | 설명 | 동작 |
|------|------|------|
| `nco_start` | NCO 시스템 시작 | pm2 start ecosystem.config.cjs |
| `nco_stop` | NCO 시스템 중지 | pm2 stop ecosystem.config.cjs |
| `nco_verify` | 설정 검증 | config + Redis + SQLite 체크 |

### 8.6 Agent Loop (6개)

| 도구 | 설명 | API 호출 |
|------|------|----------|
| `nco_agent_start` | 에이전트 시작 | POST /api/agent/start |
| `nco_agent_status` | 에이전트 상태 | GET /api/agent/:id/status |
| `nco_agent_abort` | 에이전트 중단 | POST /api/agent/:id/abort |
| `nco_agent_approve` | 도구 실행 승인 | POST /api/agent/:id/approve |
| `nco_agent_reject` | 도구 실행 거부 | POST /api/agent/:id/reject |
| `nco_agent_sessions` | 세션 목록 | GET /api/agent/sessions |

---

## 9. CLI 메시 네트워크 설계

```
CLI-A (claude-code)          CLI-B (opencode)          CLI-C (gemini)
    ★ Commander                  Architect                Designer
         │                           │                        │
         └───────────┬───────────────┼────────────────────────┘
                     ▼
              ┌──────────────┐
              │ NCO Gateway  │
              │ Mesh Router  │
              │   (6200)     │
              └──────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    Redis PubSub  WebSocket   SSE Listener
    (내부 버스)   (실시간)    (단방향 수신)
```

**메시 명령어:**
```bash
/nco-mesh-join nova Commander      # 역할 지정 참여
/nco-mesh-team                     # 팀 구성 확인
/nco-mesh-task opencode "설계해줘"  # 동료에게 위임
/nco-mesh-say "공지사항"            # 전체 브로드캐스트
/nco-mesh-say-to gemini "리뷰해줘" # DM
/nco-mesh-live                     # Living AI Team 모드
/nco-listen                        # SSE 리스너 시작
/nco-reply "응답"                  # 마지막 발신자에 답장
/nco-auto-start                    # 자동 응답 데몬
```

---

## 10. 효율성 극대화 전략 (v2.0)

### 10.1 원본 대비 개선 포인트

| 영역 | 원본 (복구 확인) | v2.0 개선 |
|------|-----------------|-----------|
| **서버** | Express (단일 스레드) | **Fastify** (2x 처리량, 스키마 기반 직렬화) |
| **작업 처리** | Placeholder worker (3초 polling) | **이벤트 드리븐 Worker** (BullMQ listener, 0ms 지연) |
| **저장소** | Memory ↔ SQLite 이중화 | **SQLite WAL 전용** + Redis 캐시 (메모리 폴백 제거) |
| **AI 호출** | 순차 실행 | **p-queue 병렬** (concurrency 제어) |
| **헬스체크** | 수동 | **자동 30초 주기** + 장애 시 즉시 폴백 |
| **프로세스** | cold start 매번 | **프로세스 풀** (warm subprocess 유지) |
| **캐싱** | 없음 | **Redis 응답 캐시** (TTL 5분, 유사 질문 해시) |
| **스트리밍** | echo 응답만 | **토큰 단위 실시간 스트리밍** (WebSocket) |
| **에러 처리** | 단순 try/catch | **Circuit Breaker** + exponential backoff |
| **API 키** | 단일 키 | **gemini-api 14-key rotation** + 자동 로테이션 |
| **라우팅** | 수동 지정 | **복잡도 분석기 + AI 자동 선택** (메트릭 기반 학습) |

### 10.2 성능 목표

| 지표 | 목표값 |
|------|--------|
| Gateway 시작 | < 2초 |
| AI 등록/삭제 | < 500ms |
| REST API 응답 (p99) | < 50ms |
| WebSocket 첫 토큰 | < 300ms |
| 단일 작업 → AI 전달 | < 1초 |
| 병렬 3-AI 결과 수집 | < 30초 |
| 토론 합의 (3 AI, 2라운드) | < 45초 |
| 하이브 모드 (9 AI) | < 120초 |
| 동시 세션 | 100+ |
| 메모리 (Gateway) | < 128MB |
| 메모리 (Worker) | < 256MB |
| SQLite 쿼리 (p99) | < 5ms |

---

## 11. 보안 설계

| 영역 | 구현 |
|------|------|
| **API 키 저장** | 환경변수 참조만 DB에 저장 (`api_key_ref`), 키 값 절대 미저장 |
| **프로세스 격리** | 각 AI subprocess에 `--max-old-space-size` 제한 |
| **입력 검증** | Fastify JSON Schema + Zod 이중 검증 |
| **로깅** | pino에서 API 키, 토큰 자동 마스킹 |
| **네트워크** | localhost 전용 바인딩 (0.0.0.0 금지) |
| **Redis** | requirepass 설정, 비밀번호 .env에만 |
| **Rate Limit** | 프로바이더별 RPM/TPM 추적 + 자동 throttle |
| **체크포인트** | 주요 변경 전 자동 스냅샷 → 롤백 가능 |

---

## 12. 구현 Phase (10단계)

```
Phase 1: 기반 구축 (Foundation)
├── 프로젝트 초기화 (package.json, tsconfig, .env)
├── 디렉토리 구조 생성
├── config/topology.json, config/ai-providers.json
├── SQLite 마이그레이션 시스템 + 스키마
├── Redis 연결 관리자
└── 기본 Fastify 서버 + 헬스체크

Phase 2: 저장소 계층 (Storage)
├── SQLite Store (WAL, 트랜잭션)
├── Redis Client (연결 풀)
├── State File 동기화
└── Workspace 관리자

Phase 3: AI 프로바이더 (Registry)
├── 프로바이더 인터페이스 + 추상 클래스
├── 9개 프로바이더 구현
├── 프로세스 풀 관리자
├── 헬스 모니터 (30초 주기)
├── 동적 등록/삭제 API
└── CLI: nco ai add/remove/list/status

Phase 4: 통신 계층 (Communication)
├── WebSocket 서버 (6201) — 복구 계약 호환
├── BullMQ 큐 팩토리
├── Redis Pub/Sub 이벤트 버스
├── SSE 엔드포인트
└── 실시간 토큰 스트리밍

Phase 5: Core API (프론트 호환)
├── 모든 복구된 REST 엔드포인트 구현
├── 작업 CRUD + Task Master
├── 채팅 API
├── 데몬 관리 API
├── 대시보드 프록시 호환
└── Vite 플러그인 라우트 매핑

Phase 6: 오케스트레이션 엔진
├── 복잡도 분석기
├── Smart Router (메트릭 기반 AI 자동 선택)
├── Smart Failover (Circuit Breaker)
├── Conductor 자동 배차
└── 세션 매니저

Phase 7: 토론/합의 엔진
├── Discussion Engine (라운드제)
├── Consensus Engine (가중치 투표)
├── Hive Mode (9=1)
├── Realtime Session (WebSocket 스트리밍)
├── Report Generator
└── 토론 결과 DB 저장

Phase 8: Agent Loop
├── Think → Act → Observe 루프
├── 승인/거부 흐름 (approve/reject)
├── 세션 관리 (/tmp/nco-sessions)
└── Agent API 엔드포인트

Phase 9: 통합 (Claude Code + MCP + Mesh)
├── MCP 서버 (26개 도구)
├── .claude/commands/ 슬래시 명령 (45+개)
├── .claude/hooks/ 자동 실행 훅 3개
├── CLI 메시 네트워크
└── settings.json MCP 서버 등록

Phase 10: 완성 (Polish)
├── 학습 데이터 수집/분석
├── 체크포인트/롤백 시스템
├── 모니터링/메트릭 API
├── 스킬 관리 시스템
├── 테스트 (unit + integration + e2e)
├── PM2 ecosystem.config.cjs 최종화
└── 문서화
```

---

## 13. 즉시 실행 가능한 Phase 1 명령

```bash
# 프로젝트 디렉토리 (sudo 없이 접근 가능한 경로)
cd /home/nova/projects/neural-cli-orchestrator

# 초기화
npm init -y

# 핵심 의존성
npm install fastify @fastify/cors @fastify/websocket \
  ws bullmq ioredis better-sqlite3 \
  @modelcontextprotocol/sdk @anthropic-ai/sdk \
  execa commander chalk ora \
  zod pino pino-pretty nanoid eventemitter3 p-queue dotenv

# 개발 의존성
npm install -D typescript tsx @types/node @types/ws @types/better-sqlite3 \
  vitest eslint prettier

# TypeScript 설정
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --outDir dist --rootDir src --strict --esModuleInterop
```

---

## 14. 복구 자산 활용 가이드

| 복구 자산 | 활용 방법 |
|-----------|-----------|
| `neural-cli-orchestrator-recovered/src/gateway.cjs` | API 엔드포인트 계약 참조 (라우트, 응답 형식) |
| `neural-cli-orchestrator-recovered/src/api/websocket-server.cjs` | WebSocket 프로토콜 그대로 이식 |
| `neural-cli-orchestrator-recovered/src/lib/provider-registry.cjs` | 프로바이더 JSON 로딩 로직 참조 |
| `neural-cli-orchestrator-recovered/src/lib/queue-factory.cjs` | BullMQ 큐 생성 패턴 참조 |
| `neural-cli-orchestrator-recovered/config/ai-providers.json` | AI 설정 그대로 사용 |
| `mcp/nco-mcp-server-index.ts` | MCP 26개 도구 정의 그대로 이식 |
| `D:/NCO-Dashboard/src/lib/nco-client.ts` | 프론트엔드 API 호출 계약 역참조 |
| `D:/NCO-Dashboard/src/lib/nco-websocket.ts` | WebSocket 클라이언트 프로토콜 역참조 |
| `D:/NCO-Dashboard/.nco-workspace/ai-providers.json` | 추가 AI 설정 참조 |
| `D:/NCO-Dashboard/appendonlydir/` | Redis 운영 데이터 구조 참조 |

---

> **상태: 설계 완료 — 실행 대기**  
> 복구된 실제 아키텍처 + 프론트엔드 API 계약 + MCP 소스를 기반으로 설계.  
> 원본과 100% 호환하면서 성능은 근본적으로 개선.  
> 승인 시 Phase 1부터 순차 구현 시작.
