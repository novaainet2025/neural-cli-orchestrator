# 개선: Mac 환경에서 Ollama 프로바이더 완전 제거

**날짜**: 2026-05-13 | **브랜치**: platform/mac

## 변경 사유

Mac 환경에서 로컬 LLM은 MLX(Apple Silicon)만 사용한다.
Ollama는 Windows/WSL 전용이며 Mac에서 실행되지 않는다.
`enabled: false`로 비활성화된 채 설정에 남아 있던 Ollama 항목을 완전히 정리한다.

## 변경 내용

| 파일 | 변경 |
|------|------|
| `config/ai-providers.json` | `ollama` 프로바이더 항목 삭제 (version 7 → 8로 갱신 필요) |
| `src/server/monitor.ts` | `AGENT_COLORS_MAP`, `agentColor()` 에서 ollama 컬러 삭제 |
| `src/agent/agent-manager.ts` | Type C 주석: `(ollama, openrouter)` → `(openrouter, mlx)` |
| `src/mcp/server.ts` | `nco_ollama_debug` 도구 정의 + 케이스 핸들러 삭제 |
| `.claude/commands/nco-task.md` | AI 목록에서 `ollama` 제거 |
| `.claude/hooks/nco-statusline.sh` | `SHORT["ollama"]` 항목 제거 |
| `cli-installs/ollama-nco-cmd.sh` | 파일 삭제 |
| `cli-installs/ollama-ctl.sh` | 파일 삭제 |
| `.claude/commands/nco-ollama.md` | 파일 삭제 |

## 로컬 LLM 현재 구성 (Mac)

- **MLX**: `gemma-4-26b-4bit` (Apple Silicon, port 8000)
- **Anthropic proxy**: `python3 anthropic-mlx-proxy.py 4100`
- **디버그**: `/nco-debug` 명령어 (nco-debug-status, nco-debug-recover 등)

## 참고

- `platform/windows` 브랜치에서는 Ollama 관련 코드가 유지된다.
- 이번 변경은 `platform/mac` 브랜치 전용.
