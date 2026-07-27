# NCO — Neural CLI Orchestrator

**9개 AI 에이전트를 지휘하는 CLI 오케스트레이터**

Claude Code 안에서 `/nco-task`, `/nco-discussion`, `/nco-opus` 등의 슬래시 커맨드로 여러 AI를 병렬·순차 실행하고 결과를 통합합니다.

---

## 1클릭 설치

```bash
curl -fsSL https://raw.githubusercontent.com/novaainet2025/neural-cli-orchestrator/main/bootstrap.sh | bash
```

저장소 설치/갱신, `npm ci`, 빌드, PM2 배포, `/health` 검증까지
비대화식으로 완료합니다. 기본 설치 경로는 `$HOME/nco`이며 `.env`와 로컬
변경은 덮어쓰지 않습니다.

### macOS / Linux / WSL2 (전체)

```bash
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git
cd neural-cli-orchestrator
bash setup.sh
```

### Windows 11 (PowerShell 관리자)

```powershell
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git
cd neural-cli-orchestrator
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

> 자세한 설치 안내 → **[INSTALL.md](./INSTALL.md)**

---

## 아키텍처

```
Claude Code (Commander)
    │
    ├─ /nco-task      → 단일 AI 위임
    ├─ /nco-team      → 병렬 실행
    ├─ /nco-opus      → 7-Phase 전략 지휘
    └─ /nco-conductor → 자동 최적 AI 선택
           │
           ▼
    NCO Backend (:6200 REST / :6201 WebSocket)
           │
    ┌──────┴──────────────────────────────┐
    │  9개 AI 에이전트                     │
    │  claude-code · opencode · gemini    │
    │  codex · aider · cursor-agent       │
    │  copilot · openrouter · ollama      │
    └─────────────────────────────────────┘
           │
    Redis (:6379) + SQLite
```

---

## 주요 기능

| 기능 | 커맨드 | 설명 |
|------|--------|------|
| 단일 위임 | `/nco-task` | 특정 AI에 작업 위임 |
| 병렬 실행 | `/nco-team` | 여러 AI 동시 실행 |
| AI 토론 | `/nco-discussion` | 멀티 AI 라운드 토론 |
| 합의 투표 | `/nco-consensus` | AI 투표로 최적 답안 결정 |
| 하이브 모드 | `/nco-hive` | 9개 AI 전체 투입 |
| 전략 지휘 | `/nco-opus` | 분석→설계→배분→검증 루프 |
| 자동 라우팅 | `/nco-conductor` | 복잡도 분석 후 AI 자동 선택 |
| Plan 실행 | `/nco-do` | 칸반 태스크 자동 배분 |
| 풀스택 해결 | `/nco-solve` | 검색→설계→구현→검증 원키 |

---

## 포트 구성

| 포트 | 서비스 |
|------|--------|
| 6200 | NCO REST API |
| 6201 | WebSocket 실시간 스트림 |
| 6379 | Redis |
| 11434 | Ollama (선택) |
| 4100 | Anthropic 호환 프록시 (선택) |

---

## 빠른 시작

```bash
# 1. 설치 후 shell 설정 반영
source ~/.bashrc

# 2. 이미 배포된 NCO 상태 확인
curl -fsS http://127.0.0.1:6200/health

# 3. Claude Code 실행 후 상태 확인
claude
/nco-status

# 4. 첫 번째 작업 위임
/nco-task codex "hello world 함수를 Python으로 작성해줘"
```

---

## 요구사항

- **Node.js** 22+
- **Redis** 7+
- **Claude Code** CLI
- **OS**: macOS 12+ / Ubuntu 20.04+ / Windows 10 WSL2

Ollama(로컬 AI)은 선택사항 — RTX 3090+ 필요.

---

## 디렉토리 구조

```
neural-cli-orchestrator/
├── bootstrap.sh          # 한 줄 설치·갱신 진입점
├── setup.sh              # Mac/Linux/WSL 설치
├── setup.ps1             # Windows 설치
├── INSTALL.md            # 상세 설치 가이드
├── src/                  # TypeScript 소스
├── config/               # AI 프로바이더 설정
├── db/migrations/        # SQLite 스키마
└── cli-installs/
    ├── install-all.sh    # AI 에이전트 설치
    └── ollama-ctl.sh     # Ollama 로컬 LLM 제어
```

---

## 라이선스

MIT
