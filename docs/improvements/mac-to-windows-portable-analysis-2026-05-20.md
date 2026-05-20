# platform/mac → platform/windows 공용 코드 분석

날짜: 2026-05-20
기준: `origin/platform/mac` (HEAD d3d44f1) vs `origin/platform/windows` (HEAD bbc97f3)
diff stat: 114 files changed, 8501+ / 1325- (mac 우위 압도적)

## 요약

- mac 전용 commit: 63개 / windows 전용 commit: 31개
- 두 브랜치는 **병행 개발 중** — 같은 feature가 각 브랜치에 따로 커밋된 경우 다수 (해시만 다름)
- mac에만 있는 commit 중 **즉시 cherry-pick 가능한 cross-platform 변경**이 상당수 존재

## ⭐ 즉시 적용 권장 (Cross-Platform — Cherry-pick 후보)

| 우선 | Commit | 내용 | 이유 |
|------|--------|------|------|
| 🔴 H | `3c4c0d0` | feat(nco): NVIDIA NIM provider + API URL health probe | 128개 모델 추가, 메모리 `project_nvidia_provider`에 이미 등록된 핵심 기능 |
| 🔴 H | `af9f859` | fix(nco): 9개 AI 프로바이더 파일 I/O 완전 수정 | 모든 프로바이더에 영향 가는 버그 픽스 |
| 🔴 H | `61f0d5e` | fix(aider): ask 모드 + no-stdin + SEARCH/REPLACE 파서 | aider는 Windows에도 있음, 파서 버그 수정 |
| 🔴 H | `bc6f637` | fix(gateway): discussion/consensus comma-string + maxRounds 타입 정규화 | gateway 입력 검증, plat-독립 |
| 🟡 M | `d35501d` | fix(nco): stash 머지 충돌 해결 + buildCompactSystemPrompt | system prompt 생성, plat-독립 |
| 🟡 M | `c264178` | fix(ecosystem): npx tsx → ./node_modules/.bin/tsx | PM2가 Windows에도 작동, Mac 한정 버그였지만 Win에서도 안정성 향상 |
| 🟡 M | `e2ab82d` | fix(proxy): SSE 스트림 종료 후 Claude Code 대기 현상 수정 | SSE 처리 로직, plat-독립 |
| 🟡 M | `6b4f3a7` | fix(mesh): broadcast skip-self collision + pending queue API | mesh 버그 픽스, plat-독립 |
| 🟡 M | `58c66da` | feat(commands): 시스템 명령어 33개 추가/수정/삭제 | `.claude/commands/` 동기화 |
| 🟡 M | `3a6df93` | feat(hooks): advisor 통합 (SessionStart/Stop/UserPromptSubmit) | 훅 통합, plat-독립 (bash) |

### Monitor UI 그룹 (Notes 탭) — 하나의 묶음으로 적용

| Commit | 내용 |
|--------|------|
| `4d2673b` | feat: monitor /api/notes 엔드포인트 + 📝 Notes 탭 |
| `7cbcf75` | fix: monitor SyntaxError — TS 템플릿 이스케이프 |
| `bf2db90` | fix: monitor Notes탭 JS SyntaxError 완전 수정 (5곳) |
| `34ec104` | feat: Notes탭 2패널 레이아웃 |
| `9a3973d` | feat(monitor): Notes 탭에 이전 세션 맥락노트 히스토리 뷰어 |

### 토큰 사용량 추적

| Commit | 내용 |
|--------|------|
| `45dbae8` | feat(nco): 토큰 사용량 추적 + 모니터링 UI |

## ⚠️ 부분 적용 (Hybrid — Mac-only 부분 제거 후 cherry-pick)

| Commit | Cross-platform 부분 | Mac-only 부분 (제외) |
|--------|---------------------|----------------------|
| `d3d44f1` (mesh 실시간) | **tmux send-keys + file inbox 2-레이어** (`/tmp/nco-inbox/`, `MeshSession.tmuxPane/Socket`) | Warp `osascript` 주입 (`deliverViaWarp`) |
| `c23a072` (mlx + LF) | **LF gitattributes**, Anthropic SSE block order | Gemma MLX tool parsing |
| `0c1c877` (TERM env) | `TERM=xterm-256color` 자체는 plat-독립이지만, Windows에선 ConPTY 사용으로 효과 없음 — 적용해도 무방 | (없음) |

## ❌ 적용 제외 (Mac-only)

| 카테고리 | Commits | 이유 |
|----------|---------|------|
| Ollama → MLX 전환 | `0083bee` `da2d54f` `c0055ce` | MLX는 Apple Silicon 전용 |
| Mac 셋업 패키지 | `4202395` `3439a03` | brew/launchctl/plist 의존 |
| Mac statusline (BSD date, Apple Silicon) | `c602745` `41ba880` `e2794f1` `732bc42` `84b303a` | `date -j`, `system_profiler` 등 BSD 한정 |
| Anthropic-MLX proxy | `454591a` `5cc1df9` | MLX 서버 의존 |
| macOS 가이드 문서 | `e12a6f1` | Mac 한정 가이드 |
| stash 머지 충돌 (중복) | `8019b9c` | `d35501d`과 중복 |

## 적용 추천 순서

1. **High 우선 5개 cherry-pick** (`3c4c0d0`, `af9f859`, `61f0d5e`, `bc6f637`, `d35501d`) — 충돌 가능성 낮은 코어 버그픽스부터
2. **현재 로컬 미커밋 19개 파일 먼저 커밋** — 그렇지 않으면 cherry-pick 시 충돌
3. Monitor Notes 탭 묶음 (5개 commit) — UI 영역, 충돌 시 monitor.ts 통합 필요
4. Mesh 실시간 통신 hybrid 적용 — `d3d44f1`에서 osascript 코드만 #ifdef로 분기

## 명령 예시

```bash
cd /mnt/d/neural-cli-orchestrator

# 1) 로컬 변경 커밋 먼저
git add -A && git commit -m "wip: windows local tuning before mac merge"

# 2) High 우선 cherry-pick
git cherry-pick 3c4c0d0 af9f859 61f0d5e bc6f637 d35501d

# 3) 충돌 발생 시 platform/windows 본 기준으로 해결
# 4) Notes 탭 묶음
git cherry-pick 4d2673b 7cbcf75 bf2db90 34ec104 9a3973d

# 5) hybrid mesh — cherry-pick 후 osascript 코드 제거 편집
git cherry-pick d3d44f1
# 이후 src/core/cli-mesh.ts에서 deliverViaWarp 함수 삭제 또는 #ifdef
```

## 통계

- Cross-platform 즉시 적용 가능: **약 15개 commit**
- Hybrid 부분 적용: 3개 commit
- Mac-only 제외: 약 15개 commit
- 나머지 30개는 양 브랜치에 병행 적용된 동일 feature (해시만 다름)
