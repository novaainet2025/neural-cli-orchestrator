# Claude Code 로컬 환경 설정 가이드 (macOS Apple Silicon)

> 최종 업데이트: 2026-04-18  
> 대상: macOS Apple Silicon (M1/M2/M3/M4), Claude Code + NCO + MLX 통합 환경

---

## 아키텍처 개요

```
Claude Code (claude 바이너리)
    │
    ├─── [일반 모드] ──────────── Anthropic API (클라우드, Sonnet/Opus)
    │
    └─── [MLX 모드] ─────────── ANTHROPIC_BASE_URL=http://localhost:4100
                                    │
                              Anthropic-MLX 프록시 (port 4100)
                              anthropic-mlx-proxy.py
                              Anthropic ↔ OpenAI 형식 변환
                                    │
                              MLX 서버 (port 8000)
                              Gemma 4 26B A4B 4-bit
                              /Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit

NCO 백엔드 (port 6200) ─── WebSocket (port 6201)
Redis (port 6379)
```

## 포트 구성

| 포트 | 서비스 | 용도 |
|------|--------|------|
| 4100 | Anthropic-MLX 프록시 | Claude Code ↔ MLX 포맷 변환 |
| 6200 | NCO 백엔드 (HTTP) | 에이전트 관리, Mesh API, Kanban |
| 6201 | NCO WebSocket | 실시간 이벤트 브로드캐스트 |
| 6379 | Redis | 상태 캐시, 이벤트 스트림, Pub/Sub |
| 8000 | MLX 서버 | 로컬 모델 추론 (OpenAI 호환) |

---

## 설치된 컴포넌트 (현재 맥 환경)

| 컴포넌트 | 경로 / 버전 | 상태 |
|---------|------------|------|
| Claude Code | `claude` CLI, v2.1.109 | ✅ 설치됨 |
| Node.js | v25.9.0 | ✅ |
| npm | v11.12.1 | ✅ |
| Python3 | 3.14.4 | ✅ |
| PM2 | `pm2` CLI | ✅ |
| Redis | `redis-cli` | ✅ |
| MLX 바이너리 | `/Users/nova-ai/.local/bin/mlx_lm.server` | ✅ |
| MLX 모델 | `/Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit` | ✅ |
| NCO 소스 | `/Users/nova-ai/project/nco` | ✅ |
| mlx_lm Python 패키지 | `pip install mlx-lm` | ⚠️ 미설치 (바이너리만 있음) |

---

## Claude Code 설정 (`~/.claude/settings.json`)

```json
{
  "model": "sonnet",
  "advisorModel": "opus",
  "skipDangerousModePermissionPrompt": true,
  "autoUpdatesChannel": "latest"
}
```

- **model**: 기본 작업 모델 — `claude-sonnet-4-6`
- **advisorModel**: `/advisor` 명령 → `claude-opus-4-6`
- **skipDangerousModePermissionPrompt**: 위험 작업 프롬프트 스킵

### Hooks 구성 (`~/.claude/settings.json` → `hooks`)

| 이벤트 | Hook | 역할 |
|--------|------|------|
| `SessionStart` | `mesh-register.sh` | Mesh에 세션 등록 |
| `SessionStart` | `mesh-autoresponder.sh` | 자동 응답기 시작 |
| `UserPromptSubmit` | `nco-task-classifier.sh` | 프롬프트 분류 |
| `UserPromptSubmit` | `mesh-heartbeat.sh` | Mesh 하트비트 |
| `UserPromptSubmit` | `mesh-precheck.sh` | 충돌 감지 |
| `UserPromptSubmit` | `nco-rules-inject.sh` | NCO 규칙 주입 |
| `PreToolUse` | `nco-agent-enforce.sh` | 에이전트 위임 검사 |
| `PostToolUse` | `nco-track-agent-use.sh` | 사용 추적 |
| `statusLine` | `nco-statusline.sh` | 상태표시줄 |

**Hook 파일 위치**: `~/.claude/hooks/`

### 프로젝트 레벨 설정 (`.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [{ "command": "bash .claude/hooks/session-start.sh" }],
    "UserPromptSubmit": [{ "command": "bash .claude/hooks/user-prompt-nco-context.sh" }]
  }
}
```

---

## 서비스 시작 순서

### 1. Redis (항상 먼저)

```bash
redis-server --daemonize yes   # 이미 실행 중이면 생략
redis-cli ping                 # PONG 확인
```

### 2. NCO 백엔드

```bash
# 개발 모드 (hot reload)
cd /Users/nova-ai/project/nco && npm run dev

# 프로덕션 (PM2)
npm run pm2:start
pm2 logs nco-backend
```

헬스 체크: `curl http://localhost:6200/health`

### 3. MLX 서버 (로컬 추론 필요 시)

```bash
# PM2로 시작
pm2 start ecosystem.config.cjs --only mlx-server

# 또는 슬래시 명령
/nco-mlx start

# 상태 확인
/nco-mlx status
```

> 초기 로딩 약 2-3분 소요 (Gemma 4 26B 4-bit, Apple Silicon Unified Memory)

헬스 체크: `curl http://localhost:8000/v1/models`

### 4. Anthropic-MLX 프록시 (MLX 모드로 Claude Code 실행 시)

```bash
# 시작
/nco-mlx proxy start

# 또는 직접
nohup python3 /Users/nova-ai/project/nco/cli-installs/anthropic-mlx-proxy.py 4100 &

# 상태
/nco-mlx proxy status
```

헬스 체크: `curl http://localhost:4100/health`

### 5. Claude Code — MLX 모드로 실행

```bash
ANTHROPIC_BASE_URL=http://localhost:4100 \
ANTHROPIC_API_KEY=dummy \
claude
```

---

## MLX 서버 상세 (Apple Silicon)

### 모델 스펙

| 항목 | 값 |
|------|----|
| 모델 | Gemma 4 26B A4B |
| 양자화 | 4-bit |
| 모델 경로 | `/Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit` |
| 컨텍스트 | ~4,096 토큰 (8K max) |
| 메모리 | ~14 GB Unified Memory |
| 특이점 | GPU 직렬화 (Metal 크래시 방지, 동시 요청 1개 제한) |

### Anthropic-MLX 프록시 역할

```
Claude Code (Anthropic 포맷)
    ↓
프록시 변환:
  - Anthropic tools → OpenAI function_calling
  - Anthropic messages → OpenAI chat format
  - Tool result 블록 처리
  - think 블록 자동 필터링
  - SSE 스트림 → Connection: close (대기 버그 방지)
    ↓
MLX 서버 (OpenAI 호환 포맷)
```

### MLX vs Claude API 작업 배분

| 작업 유형 | 권장 | 이유 |
|-----------|------|------|
| 단순 검색/포맷 변환 | MLX | 반복 작업 API 낭비 방지 |
| 파일 읽기/Grep 실행 | MLX | 도구 단순 실행 |
| 테스트 실행 | MLX | Bash 1회성 |
| 신규 기능 설계 | Claude API | 복잡한 아키텍처 결정 |
| 심층 디버깅 | Claude API | 긴 컨텍스트 필요 |
| 보안 분석 | Claude API | OWASP 등 정밀도 필요 |
| 코드 리뷰 | Claude API | 전체 맥락 파악 |

---

## NCO 슬래시 명령어 (`.claude/commands/`)

전체 명령어는 `/Users/nova-ai/.claude/commands/`에 위치.

### 주요 명령 그룹

| 그룹 | 명령어 | 설명 |
|------|--------|------|
| **시스템** | `/nco-start` `/nco-stop` `/nco-status` | NCO 백엔드 관리 |
| **MLX** | `/nco-mlx [status\|start\|stop\|proxy]` | MLX 서버 관리 |
| **Mesh** | `/nco-mesh [send\|check\|messages]` | CLI 세션 간 통신 |
| **에이전트** | `/nco-task` `/nco-team` `/nco-discussion` | 에이전트 위임 |
| **오케스트레이션** | `/nco-commander` `/nco-conductor` `/nco-opus` | 자동 조율 |
| **플래닝** | `/nco-plan` `/nco-do` `/nco-next` `/nco-kanban` | 태스크 관리 |
| **검색** | `/nco-search` `/nco-search-github` `/nco-search-npm` | 외부 검색 |
| **디버그** | `/nco-debug` `/nco-debug-status` `/nco-debug-clear` | MLX 프록시 디버깅 |

---

## 환경 변수 (`.env` 위치: `/Users/nova-ai/project/nco/.env`)

```bash
PORT=6200
WS_PORT=6201
NODE_ENV=development
DATABASE_PATH=./db/nco.db
REDIS_URL=redis://127.0.0.1:6379
PROJECT_DIR=/Users/nova-ai/project/nco

# MLX 모드 전환 시 (선택)
# ANTHROPIC_BASE_URL=http://localhost:4100
# ANTHROPIC_API_KEY=dummy
```

---

## 현재 환경 미적용 / 주의사항

| 항목 | 상태 | 조치 |
|------|------|------|
| `mlx_lm` Python 패키지 | ⚠️ 미설치 | `pip install mlx-lm` (바이너리는 존재) |
| NCO 백엔드 | 수동 시작 필요 | `npm run dev` or `npm run pm2:start` |
| MLX 서버 | 수동 시작 필요 | `/nco-mlx start` |
| MLX 프록시 | 수동 시작 필요 | `/nco-mlx proxy start` |
| `ANTHROPIC_BASE_URL` | 미설정 (정상) | MLX 세션 열 때만 수동 지정 |

> Redis는 항상 실행 중 (`redis-cli ping` → PONG ✅)

---

## 빠른 시작 체크리스트

```bash
# 1. Redis 확인
redis-cli ping                      # → PONG ✅

# 2. NCO 시작
cd /Users/nova-ai/project/nco
npm run pm2:start                   # → nco-backend online

# 3. NCO 헬스 확인
curl http://localhost:6200/health   # → {"status":"ok",...}

# 4. [선택] MLX 세션 열기
pm2 start ecosystem.config.cjs --only mlx-server
# 로딩 대기 (~3분)
/nco-mlx proxy start
ANTHROPIC_BASE_URL=http://localhost:4100 ANTHROPIC_API_KEY=dummy claude
```

---

## 관련 문서

- `docs/vllm-claude-code-optimization-guide.md` — vLLM 최적화 가이드 (Linux/GPU 환경 참고용)
- `cli-installs/anthropic-mlx-proxy.py` — MLX 프록시 소스
- `ecosystem.config.cjs` — PM2 프로세스 설정
- `config/ai-providers.json` — 에이전트 프로바이더 설정
- `.claude/commands/nco-mlx.md` — `/nco-mlx` 명령 전체 소스
