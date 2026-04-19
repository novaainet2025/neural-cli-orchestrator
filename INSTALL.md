# NCO 설치 가이드

NCO(Neural CLI Orchestrator)를 처음 설치하거나 새 머신에 환경을 구성할 때 사용하는 안내서입니다.

---

## 빠른 시작 (1클릭 설치)

### macOS / Linux / WSL2

```bash
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git
cd neural-cli-orchestrator
bash setup.sh
```

### Windows 11

PowerShell을 **관리자 권한**으로 실행:

```powershell
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git
cd neural-cli-orchestrator
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

> Windows는 WSL2 + Ubuntu를 자동으로 설치합니다. 재부팅이 필요할 수 있습니다.

---

## 설치 스크립트 옵션

### `setup.sh` 옵션

| 옵션 | 설명 |
|------|------|
| (없음) | 대화형 설치 — API 키 입력 프롬프트 표시 |
| `--no-interactive` | 자동 설치 — 프롬프트 없이 기본값으로 진행 |
| `--skip-ollama` | Ollama 안내 메시지 스킵 |
| `--dev` | 개발 모드 |

```bash
# 예시
bash setup.sh --no-interactive --skip-ollama
```

### `setup.ps1` 옵션 (Windows)

| 옵션 | 설명 |
|------|------|
| (없음) | 전체 설치 (WSL2 + Ubuntu + NCO) |
| `-SkipWSL` | WSL2 이미 설치된 경우 스킵 |
| `-SkipVLLM` | Ollama 안내 스킵 |
| `-NoInteractive` | 자동 설치 |

```powershell
# WSL2 이미 있는 경우
.\setup.ps1 -SkipWSL

# 완전 자동 설치
.\setup.ps1 -NoInteractive -SkipVLLM
```

---

## 설치 항목 (setup.sh 기준)

| 단계 | 항목 | 설명 |
|------|------|------|
| 1 | OS 감지 | macOS / Linux / WSL2 자동 판별 |
| 2 | Node.js 22+ | nvm으로 설치 및 관리 |
| 3 | Redis | 플랫폼별 설치 + 자동 시작 |
| 4 | Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| 5 | NCO 빌드 | `npm install && npm run build` |
| 6 | `.env` 생성 | API 키 대화형 입력 |
| 7 | 슬래시 커맨드 | `~/.claude/commands/nco-*.md` 설치 |
| 8 | 훅 설치 | `~/.claude/hooks/*.sh` 설치 |
| 9 | settings.json | 훅 등록 (SessionStart/Stop/PreToolUse 등) |
| 10 | MCP 등록 | `nco-commands` MCP 서버 등록 |
| 11 | 실행 스크립트 | `~/.local/bin` 에 Ollama 래퍼 설치 |
| 12 | Shell RC | PATH, nvm, alias 등록 |

---

## 시스템 요구사항

### 필수

| 항목 | 최소 | 권장 |
|------|------|------|
| OS | macOS 12+ / Ubuntu 20.04+ / Windows 10 (WSL2) | 최신 버전 |
| Node.js | 22+ | 22 LTS |
| RAM | 8GB | 16GB+ |
| 디스크 | 5GB | 20GB+ |
| 인터넷 | 필요 | - |

### 선택 (Ollama 로컬 AI)

| 항목 | 최소 | 권장 |
|------|------|------|
| GPU | RTX 3080 (10GB VRAM) | RTX 4090 (24GB) |
| VRAM | 10GB | 24GB |
| Python | 3.10+ | 3.11+ |

---

## API 키 설정

설치 후 `.env` 파일에서 API 키를 설정합니다:

```bash
nano ~/projects/neural-cli-orchestrator/.env
# 또는
code ~/projects/neural-cli-orchestrator/.env
```

### 필수 API 키

```env
# Anthropic (Claude) — claude.ai에서 발급
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT) — platform.openai.com에서 발급
OPENAI_API_KEY=sk-...
```

### 선택 API 키 (여러 개 콤마로 구분, 자동 로테이션)

```env
# Google Gemini — aistudio.google.com에서 발급 (무료 티어 있음)
GEMINI_API_KEYS=AIzaSy...,AIzaSy...

# OpenRouter (다양한 모델 접근) — openrouter.ai에서 발급
OPENROUTER_API_KEYS=sk-or-v1-...,sk-or-v1-...

# Hugging Face (모델 다운로드) — huggingface.co에서 발급
HF_TOKEN=hf_...
```

---

## AI 에이전트 설치

NCO는 다음 9개 AI 에이전트를 지원합니다. 설치는 별도 스크립트로:

```bash
bash cli-installs/install-all.sh          # 전체 설치
bash cli-installs/install-all.sh update   # 업데이트
bash cli-installs/install-all.sh status   # 설치 상태 확인
bash cli-installs/install-all.sh codex    # 개별 설치
```

| 에이전트 | 설치 명령 | 역할 |
|----------|-----------|------|
| **claude-code** | (이미 설치됨) | Commander |
| **opencode** | 자동 설치 | Architect |
| **gemini** | 자동 설치 | Designer |
| **codex** | 자동 설치 | Engineer |
| **aider** | 자동 설치 | Coder |
| **cursor-agent** | 자동 설치 | Reviewer |
| **copilot** | 자동 설치 | Researcher |
| **openrouter** | API 키만 필요 | Advisor |
| **ollama** | 아래 Ollama 섹션 참고 | Validator |

---

## Ollama 로컬 AI (선택)

GPU가 있는 경우 로컬에서 Gemma 4 또는 Qwen 모델을 실행할 수 있습니다.

### 설치

```bash
# Python 가상환경 생성
python3 -m venv ~/ollama-env
source ~/ollama-env/bin/activate

# Ollama 설치 (NVFP4 최적화 포함)
pip install "ollama[modelopt]" torch transformers accelerate
```

### 모델 다운로드

```bash
# Gemma 4 26B (권장 — RTX 4090 24GB)
huggingface-cli download google/gemma-4-26B-A4B-it-NVFP4 \
  --local-dir /path/to/models/gemma-4-26B-A4B-it-NVFP4

# Gemma 4 E4B (경량 — RTX 3080 10GB)
huggingface-cli download cosmicproc/gemma-4-E4B-it-NVFP4 \
  --local-dir /path/to/models/gemma-4-E4B-it-NVFP4
```

### Ollama 실행

```bash
# Gemma 시작 (수 분 소요, "healthy" 메시지까지 대기)
ollama-gemma start

# 상태 확인
curl -fsS http://127.0.0.1:11434/health && echo "OK"

# Gemma로 Claude Code 실행
claude-gemma

# 또는 Claude Code 슬래시 커맨드로
/nco-gemma-start    # 백그라운드 기동
/nco-ollama-status    # 상태 확인
```

### 모델별 VRAM 요구사항

| 모델 | VRAM | 컨텍스트 | 속도 |
|------|------|---------|------|
| Gemma 4 E4B NVFP4 | ~8GB | 4096 | 빠름 |
| Gemma 4 26B NVFP4 | ~20GB | 16384 | 보통 |
| Qwen3.5-9B | ~12GB | 8192 | 보통 |

### WSL 자동 시작 설정

```bash
# ~/.bashrc에서 주석 해제
nano ~/.bashrc

# 아래 줄 주석 해제:
# pgrep -f 'ollama serve' >/dev/null 2>&1 || nohup ollama-gemma start >> /tmp/ollama-gemma.log 2>&1 &
```

---

## 설치 후 첫 실행

```bash
# 1. Shell 설정 반영
source ~/.bashrc

# 2. Claude Code 실행
claude --dangerously-skip-permissions

# 3. NCO 시작 (Claude Code 내에서)
/nco-start

# 4. 상태 확인
/nco-status

# 5. 테스트
/nco-task codex "hello world 함수를 Python으로 작성해줘"
```

---

## 포트 구성

| 포트 | 서비스 | 용도 |
|------|--------|------|
| 6200 | NCO REST API | 에이전트 조율, 태스크 관리 |
| 6201 | NCO WebSocket | 실시간 이벤트 스트림 |
| 6260 | NCO Dashboard | 모니터링 UI |
| 6379 | Redis | 작업 큐, 메시 통신 |
| 11434 | Ollama | 로컬 AI 추론 API |
| 4100 | Ollama Proxy | Anthropic 호환 프록시 |

---

## 주요 슬래시 커맨드 (Claude Code 내)

### 시스템 관리

```
/nco-start          NCO 백엔드 시작
/nco-stop           NCO 백엔드 중지
/nco-status         전체 상태 확인
/nco-verify         설정 및 연결 검증
/nco-providers      AI 프로바이더 목록
```

### 에이전트 협력

```
/nco-task           단일 AI에 작업 위임 (예: /nco-task codex "...")
/nco-team           여러 AI 병렬 실행
/nco-discussion     멀티 AI 토론
/nco-consensus      AI 합의 투표
/nco-hive           전체 9 AI 동시 투입
/nco-conductor      AI 자동 선택 및 실행
/nco-opus           전략 지휘관 모드
```

### 워크플로우

```
/nco-plan           Plan 생성 (자동 태스크 분해)
/nco-do             Plan 실행
/nco-kanban         칸반 보드 조회
/nco-progress       실시간 대시보드
/nco-analyze        심층 분석
/nco-solve          풀스택 원키 해결
```

### Ollama

```
/nco-gemma-start    Gemma 백그라운드 기동
/nco-qwen-start     Qwen 백그라운드 기동
/nco-ollama-status    Ollama 상태 확인
/nco-ollama-logs      서버 로그 출력
/nco-ollama-test      추론 테스트
/nco-ollama-use       모델 전환
```

---

## 문제 해결

### NCO 시작 안 됨

```bash
# Redis 확인
redis-cli ping  # PONG이 나와야 함
redis-server --daemonize yes  # 직접 시작

# NCO 직접 실행
cd ~/projects/neural-cli-orchestrator
node dist/index.js
```

### Ollama 오류

```bash
# 기존 프로세스 확인
pgrep -a -f ollama

# VRAM 사용량 확인
nvidia-smi

# 로그 확인
tail -f /tmp/ollama-gemma.log

# 재시작
/nco-ollama-restart
```

### Claude Code 슬래시 커맨드 안 보임

64개 이상의 커맨드는 자동완성에서 일부가 잘립니다. 이름 일부를 직접 입력하세요:

```
/nco-v      → ollama 관련 커맨드 필터링
/nco-s      → start, status, sessions, solve, search...
/nco-d      → discussion, debug, delegate, do...
```

### API 키 오류

```bash
# .env 파일 편집
nano ~/projects/neural-cli-orchestrator/.env

# NCO 재시작
/nco-stop
/nco-start
```

---

## 디렉토리 구조

```
neural-cli-orchestrator/
├── setup.sh              ← Mac/Linux/WSL 설치 스크립트
├── setup.ps1             ← Windows 설치 스크립트
├── .env.example          ← 환경변수 템플릿
├── .env                  ← 실제 설정 (설치 후 생성)
├── src/                  ← TypeScript 소스
│   ├── agent/            ← 9개 AI 에이전트 조율
│   ├── core/             ← 이벤트 버스, 태스크 큐
│   ├── server/           ← Fastify REST + WebSocket
│   └── mcp/              ← Claude Code MCP 서버
├── dist/                 ← 빌드 결과 (자동 생성)
├── db/
│   ├── migrations/       ← SQLite 스키마 (16개)
│   └── nco.db            ← 데이터베이스 (자동 생성)
├── config/
│   ├── ai-providers.json ← AI 프로바이더 정의
│   └── topology.json     ← 포트/경로 설정
└── cli-installs/
    ├── install-all.sh    ← AI 에이전트 전체 설치
    └── ollama-ctl.sh       ← Ollama 제어 스크립트

~/.claude/                ← Claude Code 설정
├── commands/nco-*.md     ← 슬래시 커맨드 73개+
├── hooks/                ← 자동화 훅 9개
├── settings.json         ← 훅 등록
└── claude_desktop_config.json  ← MCP 서버 등록
```

---

## 업데이트

```bash
cd ~/projects/neural-cli-orchestrator
git pull
npm install
npm run build
/nco-stop && /nco-start
```

---

## 라이선스

MIT License — 자유롭게 사용, 수정, 배포 가능합니다.
