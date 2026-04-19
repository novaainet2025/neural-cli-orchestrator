# NCO 백엔드 업그레이드 — 핵심 가치 & 필수 기능

> **작성일**: 2026-04-10
> **버전**: v1.0
> **상태**: 통합예정
> **요약**: 메인 설계서(v4.0) 누락 기능 보완 — 다음 버전 설계서에 병합 예정
> **출처**: NCO 프레젠테이션 + 3대 가이드 문서 + 대시보드 프론트엔드 역분석

---

## 0. 왜 이 문서가 필요한가

설계서 v4.1은 **인프라(Event Bus, Shared State, Sandbox)** 중심이다.
NCO가 사용자에게 약속하는 **핵심 가치**가 빠져 있다.

```
설계서 v4.1이 커버하는 것:
  ✅ Event Bus + Redis Streams
  ✅ 공유 상태 + 동기화
  ✅ 보안 샌드박스
  ✅ 토론 엔진 (기본)
  ✅ 에이전트 루프 (OrchestratedLoop)

설계서 v4.1에 없는 것 (이 문서에서 정의):
  ❌ 7종 실행 모드 (discussion, parallel, consensus, hive, task, commander, conductor)
  ❌ 에이전트 루프 관리 API (start, status, abort, approve, reject)
  ❌ 칸반 + Plan 시스템
  ❌ 안전장치 (변경률 차단, 자동 백업, Triple Verification Gate)
  ❌ NCO 고유 기능 (Hive, Broadcast, Learn, Smart, Observability)
  ❌ Commander 4-Layer 계층 구조
  ❌ PDCA 사이클
  ❌ MCP 서버 26개 도구
  ❌ 대시보드 API 호환 (180+ 라우트)
  ❌ CLI 비용 절감 핵심 가치
```

---

## 1. NCO 핵심 가치 — 백엔드가 반드시 지원해야 하는 것

### 1.1 CLI 비용 절감 (NCO 존재 이유)

```
API 방식: 월 $500~$2,000+ (토큰 종량제)
CLI 방식: 월 $20~$200 고정 (구독제, 무제한)

NCO는 CLI를 오케스트레이션하여 API 대비 5~20배 비용 절감하면서
동일한 성능을 달성하는 것이 핵심 가치다.

백엔드 필수 지원:
  - CLI subprocess 관리 (프로세스 풀, 헬스체크, 자동 재시작)
  - API 폴백 (CLI 실패 시 OpenRouter 무료 API → Ollama 로컬)
  - 비용 추적 (CLI=무료, API=유료 토큰 카운팅)
  - Rate Limit 지능적 회피 (키 롤링, 프로바이더 전환)
```

### 1.2 1인 개발자 → 9인 팀

```
9개 AI가 각자의 전문성으로 동시에 작업하는 것.
단일 AI의 블라인드 스팟을 교차 검증으로 제거하는 것.

백엔드 필수 지원:
  - 9개 프로바이더 동시 관리 (프로세스 풀)
  - 역할 기반 자동 배치 (Scoreboard/Smart Router)
  - 교차 검증 파이프라인 (AI-A 결과를 AI-B가 검증)
```

---

## 2. 7종 실행 모드 — 백엔드 API 설계

### 2.1 모드 목록

| # | 모드 | 명령어 | 복잡도 | 방식 | AI 수 |
|---|------|--------|--------|------|-------|
| 1 | **Task** | `/nco-task <ai> "프롬프트"` | 1-4 | 단일 AI 위임 | 1 |
| 2 | **Conductor** | `/nco-conductor "프롬프트"` | 3-4 | 자동 디스패치 (Smart Router) | 1-2 |
| 3 | **Parallel** | `/nco-parallel "프롬프트"` | 5-6 | 동일 질문 → 여러 AI 동시 → 결과 비교 | 2-3 |
| 4 | **Discussion** | `/nco-discussion "주제"` | 5-8 | 순차 턴제 토론 | 2-5 |
| 5 | **Consensus** | `/nco-consensus "주제"` | 8-9 | 합의 도달까지 반복 토론 | 3+ |
| 6 | **Hive** | `/nco-hive "작업"` | 10 | 9개 AI = 1개 슈퍼 AI (통합 지능) | 9 |
| 7 | **Commander** | `/nco-commander "작업"` | 7-10 | 4-Layer 계층적 자동 분배 | 4-9 |

### 2.2 모드별 백엔드 API

```
POST /api/task
  body: { ai: string, prompt: string, mode: 'task' }
  응답: WebSocket 스트리밍 → task:chunk → task:completed

POST /api/conductor
  body: { prompt: string }
  내부: Smart Router가 복잡도 분석 → 최적 모드+AI 자동 선택
  응답: WebSocket 스트리밍

POST /api/parallel
  body: { prompt: string, providers?: string[] }
  내부: 동일 프롬프트를 2-3개 AI에 동시 전송
  응답: WebSocket으로 각 AI 응답 병렬 스트리밍 → 비교 리포트

POST /api/discussion/create
  body: { topic: string, participants?: string[], maxRounds?: number }
  내부: 턴제 토론 (AI-A → AI-B → AI-C → 평가 → 다음 라운드)
  응답: WebSocket 실시간 스트리밍 (discussion:message, discussion:round_*)

POST /api/consensus
  body: { topic: string, threshold?: number }
  내부: 토론 → 투표 → 합의율 < threshold → 추가 라운드 → 반복
  응답: WebSocket 스트리밍 → consensus_reached 또는 consensus_failed

POST /api/hive
  body: { prompt: string }
  내부: 9개 AI에게 같은 컨텍스트 분배 → 개별 응답 수집
        → Commander가 통합 → 하나의 응답으로 합성
  응답: WebSocket 스트리밍

POST /api/commander
  body: { prompt: string }
  내부: Commander(claude-code)가 4-Layer 계층 구조로 자동 분배
  응답: WebSocket 스트리밍 (각 레이어별 결과)
```

### 2.3 Commander 4-Layer 계층 구조

```
┌─ Management Layer ──────────────────────────┐
│ ★ Commander (claude-code): 전략, 최종 결정   │
│ 📐 Architect (opencode): 아키텍처 설계       │
├─ Information Layer ─────────────────────────┤
│ 🔍 Researcher (copilot): 정보 수집           │
│ 📊 Analyst (openrouter): 데이터 분석         │
├─ Execution Layer ───────────────────────────┤
│ ⚙ Engineer (codex/aider): 코드 구현         │
│ 🎨 Designer (gemini): UI/UX 디자인          │
├─ Quality Layer ─────────────────────────────┤
│ 📝 Reviewer (cursor-agent): 코드 리뷰       │
│ ✅ Validator (ollama): 로컬 검증              │
└─────────────────────────────────────────────┘

위임 규칙:
  Management → 전체 레이어에 위임 가능
  Information → Execution에 위임 가능
  Quality → Execution에 위임 가능 (수정 요청)
  Execution → 위임 불가 (실행만)
```

### 2.4 Conductor (자동 디스패치) 로직

```typescript
// 사용자가 /nco-conductor "프롬프트" 실행 시
// Smart Router가 복잡도를 분석하고 최적 모드를 자동 선택

async function conductorDispatch(prompt: string): Promise<void> {
  const complexity = smartRouter.analyzeComplexity(prompt);
  const keywords = extractKeywords(prompt);

  // 자동 트리거 매핑
  const autoTriggers: Record<string, { mode: string, minAI: number }> = {
    '아키텍처|architecture|설계': { mode: 'discussion', minAI: 3 },
    '보안|security|vulnerability':  { mode: 'parallel',   minAI: 2 },
    '프로덕션|deploy|release':      { mode: 'consensus',  minAI: 3 },
    '리뷰|review|검토':             { mode: 'discussion', minAI: 2 },
    '리팩토링|refactor':            { mode: 'discussion', minAI: 2 },
    '최적화|performance':           { mode: 'parallel',   minAI: 2 },
    '테스트|test':                  { mode: 'parallel',   minAI: 2 },
    '긴급|critical':               { mode: 'consensus',  minAI: 2 },
  };

  // 복잡도 기반 기본 모드
  let mode: string;
  if (complexity <= 2) mode = 'task';       // ollama 단독
  else if (complexity <= 4) mode = 'task';  // codex/gemini
  else if (complexity <= 6) mode = 'parallel';
  else if (complexity <= 8) mode = 'discussion';
  else if (complexity <= 9) mode = 'consensus';
  else mode = 'hive';

  // 키워드 오버라이드
  for (const [pattern, config] of Object.entries(autoTriggers)) {
    if (new RegExp(pattern, 'i').test(prompt)) {
      mode = config.mode;
      break;
    }
  }

  // 해당 모드의 API 호출
  await executeMode(mode, prompt, complexity);
}
```

---

## 3. 에이전트 루프 관리 API

### 3.1 에이전트 세션 API (MCP + REST)

```
POST /api/agent/start
  body: { prompt: string, provider?: string, maxIterations?: number }
  응답: { sessionId: string, status: 'running' }
  내부: OrchestratedLoop 시작, WebSocket으로 실시간 스트리밍

GET /api/agent/status/:sessionId
  응답: { sessionId, status, iteration, toolCalls, lastAction, artifacts[] }

POST /api/agent/abort/:sessionId
  응답: { aborted: true }
  내부: 진행 중인 subprocess 강제 종료

POST /api/agent/approve/:sessionId
  body: { toolCallId: string }
  내부: 대기 중인 도구 호출 승인 (위험 명령 시 사용자 승인 필요)

POST /api/agent/reject/:sessionId
  body: { toolCallId: string, reason: string }
  내부: 도구 호출 거부

GET /api/agent/sessions
  응답: { sessions: AgentSession[] }
```

### 3.2 도구 승인 모드

```
일반 도구 (read_file, search_code): 자동 승인
위험 도구 (write_file, delete_file, run_command): 설정에 따라
  - autoApprove: true → 자동 승인 (기본)
  - autoApprove: false → WebSocket으로 사용자에게 승인 요청
    → agent:tool_approval_required 이벤트 발행
    → 사용자가 approve/reject
```

---

## 4. 안전장치 시스템

### 4.1 변경률 기반 보호 (v4.1에 없음 — 필수 추가)

```typescript
class FileChangeGuard {
  // 설계서 v4.1의 PathGuard/CommandGate와 별도로
  // 파일 내용 변경 비율을 기반으로 보호

  async validateChange(
    filePath: string,
    originalContent: string,
    newContent: string,
    agent: Agent
  ): Promise<ChangeValidation> {

    const changeRatio = this.calculateChangeRatio(originalContent, newContent);

    // ═══ 90%+ 변경 → 자동 차단 (BLOCKED) ═══
    if (changeRatio >= 0.9) {
      return {
        action: 'blocked',
        reason: `${(changeRatio * 100).toFixed(0)}% 변경 감지 — 파일 전체 교체 차단`,
        changeRatio
      };
    }

    // ═══ 70~90% 변경 → 자동 백업 후 진행 ═══
    if (changeRatio >= 0.7) {
      const backupPath = await this.createBackup(filePath, originalContent);
      return {
        action: 'backup_then_proceed',
        reason: `${(changeRatio * 100).toFixed(0)}% 변경 — 백업 생성: ${backupPath}`,
        backupPath,
        changeRatio
      };
    }

    // ═══ 70% 미만 → 정상 진행 ═══
    return { action: 'allow', changeRatio };
  }

  private calculateChangeRatio(original: string, modified: string): number {
    // Levenshtein distance 기반 변경률
    const maxLen = Math.max(original.length, modified.length);
    if (maxLen === 0) return 0;
    const distance = levenshteinDistance(original, modified);
    return distance / maxLen;
  }

  private async createBackup(filePath: string, content: string): Promise<string> {
    const backupDir = path.join(path.dirname(filePath), '.backup');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${path.basename(filePath)}.${Date.now()}.bak`);
    await fs.writeFile(backupPath, content);
    return backupPath;
  }
}
```

### 4.2 Triple Verification Gate

```
모든 에이전트 작업 완료 시 3단계 검증:

L1: 타입 체크 (tsc --noEmit)
  → TypeScript 에러 0건 확인
  → 실패 시 → 에이전트에게 수정 요청 (자동 재루프)

L2: 린트 체크 (ESLint, 변경 파일만)
  → 린트 에러/경고 확인
  → 실패 시 → 에이전트에게 수정 요청

L3: 변경률 검증 (Gap 90%+)
  → 변경된 모든 파일의 변경률 확인
  → 90%+ 파일이 있으면 → 차단 + 롤백

3단계 모두 통과해야 task:completed 선언 가능.
하나라도 실패하면 task:failed + 사유 + 자동 수정 시도.
```

### 4.3 DB 스키마 추가

```sql
-- 파일 백업 기록
CREATE TABLE file_backups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  file_path TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  change_ratio REAL NOT NULL,      -- 0.0 ~ 1.0
  original_size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_backups_task ON file_backups(task_id);

-- 검증 게이트 기록
CREATE TABLE verification_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  gate_level TEXT NOT NULL,        -- 'L1_typecheck', 'L2_lint', 'L3_change_ratio'
  status TEXT NOT NULL,            -- 'pass', 'fail', 'skip'
  detail_json TEXT,                -- 에러 상세
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_gates_task ON verification_gates(task_id);
```

---

## 5. 칸반 + Plan 시스템

### 5.1 API

```
POST /api/plan/create
  body: { title: string, source?: 'discussion' | 'manual' }
  내부: 토론 결과를 기반으로 Plan 마크다운 자동 생성

GET /api/plan/:id
POST /api/plan/:id/sync
  내부: 마크다운 ↔ DB 양방향 동기화 (마크다운이 Source of Truth)

GET /api/kanban
  응답: { columns: ['todo','in_progress','review','done'], tasks: KanbanTask[] }

POST /api/kanban/move
  body: { taskId: string, from: string, to: string }

POST /api/plan/execute
  body: { planId: string, strategy: 'sequential' | 'parallel' | 'auto' }
  내부: /nco-do 구현 — 칸반 태스크를 순서대로 에이전트에 위임
        의존성(blockedBy) 존재 시 순차, 독립 태스크는 병렬
```

### 5.2 Plan → Kanban → Execution 플로우

```
/nco-plan "JWT 인증 시스템"
  │
  ▼
1. /nco-discussion "JWT 인증 설계"
   → 토론 결과 요약
  │
  ▼
2. Plan 마크다운 자동 생성
   docs/plans/jwt-auth.md
   - [ ] S1: JWT 토큰 유틸 (codex)
   - [ ] S2: 인증 미들웨어 (codex)
   - [ ] P3a: 로그인 UI (gemini)     ← S1,S2 완료 후 병렬
   - [ ] P3b: 라우팅 가드 (aider)    ← S1,S2 완료 후 병렬
   - [ ] S4: 통합 테스트 (cursor-agent)
  │
  ▼
3. Kanban DB에 태스크 생성 (양방향 동기화)
  │
  ▼
4. /nco-do jwt-auth
   → S1 실행 → S2 실행 → P3a + P3b 병렬 → S4 실행
   → 각 태스크마다 OrchestratedLoop 또는 NativeExecutor
   → 완료 시 Kanban 상태 자동 이동 (todo → in_progress → done)
```

### 5.3 DB 스키마 추가

```sql
-- Plan (마크다운이 Source of Truth)
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown_path TEXT NOT NULL,     -- docs/plans/xxx.md
  source_discussion_id TEXT,       -- 토론에서 생성된 경우
  status TEXT DEFAULT 'draft',     -- draft, active, completed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Kanban 태스크 (Plan에서 파생)
CREATE TABLE kanban_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES plans(id),
  title TEXT NOT NULL,
  description TEXT,
  column_status TEXT DEFAULT 'todo',  -- todo, in_progress, review, done
  assigned_to TEXT,                    -- agent id
  order_index INTEGER DEFAULT 0,
  depends_on_json TEXT DEFAULT '[]',   -- blockedBy task ids
  execution_type TEXT DEFAULT 'sequential', -- sequential(S) / parallel(P)
  task_id TEXT,                        -- NCO task id (실행 시 연결)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_kanban_plan ON kanban_tasks(plan_id);
CREATE INDEX idx_kanban_status ON kanban_tasks(column_status);
```

---

## 6. NCO 고유 기능 — 백엔드 지원

### 6.1 Hive 모드 (9=1)

```
9개 AI를 하나의 슈퍼 AI처럼 작동시킨다.

구현:
1. 동일 컨텍스트(공유 상태 + 프롬프트)를 9개 AI 전체에 분배
2. 각 AI가 자신의 전문성으로 독립 응답 생성
3. Commander(claude-code)가 9개 응답을 통합
4. 하나의 최종 응답으로 합성

API: POST /api/hive
내부: parallel 실행(9개) → 응답 수집 → Commander 통합 → 최종 응답
```

### 6.2 Broadcast

```
동일 메시지를 9개 AI 전체에 동시 발송.
각 AI의 개별 응답을 수집하여 비교 뷰 제공.

API: POST /api/broadcast
  body: { message: string }
  응답: WebSocket으로 9개 응답 스트리밍 → 비교 리포트

parallel과 차이: parallel은 2-3개, broadcast는 전체 9개.
```

### 6.3 NCO Smart (Conductor 확장)

```
작업 유형·복잡도·Rate Limit 상태를 분석하여
최적 AI + 최적 모드를 자동 선택.

이미 설계서 v4.1의 Smart Router에 기초가 있음.
추가 필요:
  - Rate Limit 실시간 상태 반영 (제한 중인 AI 제외)
  - 이전 작업 성과 반영 (성공률 높은 AI 우선)
  - 비용 최적화 (무료 AI 우선: ollama → openrouter → 유료)
```

### 6.4 NCO Learn (지식 베이스)

```
에이전트 작업 결과에서 패턴/지식을 자동 추출하여 저장.
다음 세션에서 동일 프로젝트 작업 시 활용.

DB 스키마:
  CREATE TABLE knowledge_base (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    category TEXT NOT NULL,          -- 'bug_pattern', 'architecture', 'convention', 'decision'
    content TEXT NOT NULL,
    source_task_id TEXT,
    source_discussion_id TEXT,
    confidence REAL DEFAULT 0.8,
    used_count INTEGER DEFAULT 0,    -- 활용 횟수
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

API:
  POST /api/learn/save     — 지식 저장
  GET  /api/learn/query    — 관련 지식 검색 (키워드 + 프로젝트)
  GET  /api/learn/context  — 현재 작업에 관련된 지식 자동 로드
```

### 6.5 NCO Observability (관측성)

```
AI별 토큰 소비·응답속도·성공률 실시간 리더보드.

API:
  GET /api/observability/leaderboard
    응답: { agents: [{ id, totalTasks, successRate, avgResponseTime, tokensUsed }] }

  GET /api/observability/agent/:id
    응답: { history: TimeSeriesData[], recentTasks: Task[] }

  GET /api/rate-limits
    응답: { agents: [{ id, isLimited, reason, resetAt, consecutiveFailures }] }

DB: 기존 metrics 테이블 활용 + rate_limit_state 테이블
```

---

## 7. MCP 서버 — 26개 도구

### 7.1 협업 도구 (6개)

| MCP 도구 | REST 매핑 | 설명 |
|----------|-----------|------|
| `nco_discussion` | POST /api/discussion/create | 멀티AI 토론 |
| `nco_parallel` | POST /api/parallel | 병렬 AI 실행 |
| `nco_consensus` | POST /api/consensus | AI 합의 모드 |
| `nco_hive` | POST /api/hive | 하이브 모드 (9=1) |
| `nco_task` | POST /api/task | 단일 AI 위임 |
| `nco_broadcast` | POST /api/broadcast | 전체 브로드캐스트 |

### 7.2 상태/모니터링 (6개)

| MCP 도구 | REST 매핑 |
|----------|-----------|
| `nco_status` | GET /api/health |
| `nco_providers` | GET /api/providers |
| `nco_daemons` | GET /api/daemons |
| `nco_health` | GET /api/health/detailed |
| `nco_rate_limits` | GET /api/rate-limits |
| `nco_queue_metrics` | GET /api/queue/metrics |

### 7.3 세션 관리 (3개)

| MCP 도구 | REST 매핑 |
|----------|-----------|
| `nco_list_sessions` | GET /api/sessions |
| `nco_get_session` | GET /api/sessions/:id |
| `nco_session_messages` | GET /api/sessions/:id/messages |

### 7.4 태스크 관리 (2개)

| MCP 도구 | REST 매핑 |
|----------|-----------|
| `nco_get_task` | GET /api/tasks/:id |
| `nco_list_tasks` | GET /api/tasks |

### 7.5 시스템 제어 (3개)

| MCP 도구 | REST 매핑 |
|----------|-----------|
| `nco_start` | POST /api/system/start |
| `nco_stop` | POST /api/system/stop |
| `nco_verify` | POST /api/system/verify |

### 7.6 에이전트 루프 (6개)

| MCP 도구 | REST 매핑 |
|----------|-----------|
| `nco_agent_start` | POST /api/agent/start |
| `nco_agent_status` | GET /api/agent/status/:sessionId |
| `nco_agent_abort` | POST /api/agent/abort/:sessionId |
| `nco_agent_approve` | POST /api/agent/approve/:sessionId |
| `nco_agent_reject` | POST /api/agent/reject/:sessionId |
| `nco_agent_sessions` | GET /api/agent/sessions |

---

## 8. 대시보드 API 호환 — 핵심 라우트

프론트엔드(D:/NCO-Dashboard)의 70개 Vite 플러그인이 180+ API 라우트를 기대한다.
Phase 5에서 전체 호환이 목표지만, **핵심 라우트**는 Phase 1-4에서 선행 구현해야 한다.

### Phase 1-4에서 필수인 핵심 라우트 (37개)

```
# 헬스 & 시스템 (4)
GET  /api/health
GET  /api/health/detailed
GET  /api/providers
GET  /api/daemons

# 태스크 (6)
POST /api/task
GET  /api/tasks
GET  /api/tasks/:id
GET  /api/tasks/:id/stream     (SSE)
POST /api/tasks/:id/cancel
POST /api/tasks/:id/retry

# 협업 모드 (7)
POST /api/discussion/create
POST /api/parallel
POST /api/consensus
POST /api/hive
POST /api/broadcast
POST /api/commander
POST /api/conductor

# 세션 (4)
GET  /api/sessions
GET  /api/sessions/:id
GET  /api/sessions/:id/messages
DELETE /api/sessions/:id

# 에이전트 (6)
POST /api/agent/start
GET  /api/agent/status/:id
POST /api/agent/abort/:id
POST /api/agent/approve/:id
POST /api/agent/reject/:id
GET  /api/agent/sessions

# 칸반 & Plan (5)
GET  /api/kanban
POST /api/kanban/move
POST /api/plan/create
GET  /api/plan/:id
POST /api/plan/execute

# 모니터링 (3)
GET  /api/rate-limits
GET  /api/queue/metrics
GET  /api/observability/leaderboard

# 지식 (2)
POST /api/learn/save
GET  /api/learn/query
```

---

## 9. WebSocket 이벤트 — 대시보드 호환

프론트엔드가 기대하는 WebSocket 이벤트 유형:

```
# 태스크
task_start          — 작업 시작
task_chunk          — 스트리밍 청크
task_complete       — 작업 완료
task_error          — 작업 실패
task_progress       — 진행률

# AI 상태
ai_status_update    — AI 온라인/오프라인/작업중
ai_heartbeat        — AI 생존 확인

# 토론
discussion:started   — 토론 시작
discussion:message   — 토론 메시지
discussion:round     — 라운드 진행
discussion:complete  — 토론 완료

# 에이전트
agent:thinking       — 에이전트 사고 중
agent:acting         — 도구 실행 중
agent:observing      — 결과 분석 중
agent:tool_approval  — 도구 승인 요청

# 시스템
rate_limit           — Rate Limit 발생
system_error         — 시스템 오류
provider_fallback    — 프로바이더 폴백
```

---

## 10. 구현 우선순위 — 설계서 Phase에 매핑

```
═══════════════════════════════════════════════════════
Phase 1 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: Event Bus + Shared State + Sync Engine
  추가:
    ├── FileChangeGuard (변경률 보호)
    └── verification_gates 테이블

═══════════════════════════════════════════════════════
Phase 2 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: Agent System + Sandbox
  추가:
    ├── 7종 모드 실행 엔진 (task, parallel, discussion, consensus, hive, commander, conductor)
    ├── Conductor 자동 디스패치
    ├── Commander 4-Layer 분배
    ├── Triple Verification Gate
    └── 에이전트 루프 관리 API (start/status/abort/approve/reject)

═══════════════════════════════════════════════════════
Phase 3 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: Discussion Engine
  추가:
    ├── Parallel 모드 엔진
    ├── Consensus 모드 (합의까지 반복)
    ├── Hive 모드 (9→1 통합)
    └── Broadcast 모드

═══════════════════════════════════════════════════════
Phase 4 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: WebSocket + SSE + REST
  추가:
    ├── 37개 핵심 REST 라우트
    ├── WebSocket 대시보드 호환 이벤트
    └── 칸반 + Plan 시스템 API

═══════════════════════════════════════════════════════
Phase 5 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: 대시보드 호환 전체
  추가:
    ├── NCO Learn (지식 베이스)
    ├── NCO Observability (리더보드)
    ├── 180+ 라우트 전체 호환
    └── Vite 플러그인 → Fastify 라우트 매핑

═══════════════════════════════════════════════════════
Phase 6 (기존) + 추가
═══════════════════════════════════════════════════════
  기존: MCP 서버
  추가:
    └── 26개 MCP 도구 전체 구현
```

---

> **이 문서는 설계서 v4.1의 보완 문서다.**
> 설계서가 인프라를, 이 문서가 기능을 정의한다.
> 두 문서를 합쳐야 NCO 백엔드의 전체 그림이 완성된다.
