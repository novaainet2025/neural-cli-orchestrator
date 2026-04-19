# 개선: main 브랜치 머지 (Ollama→MLX 충돌 해결)

**날짜**: 2026-04-19 | **브랜치**: platform/mac

## 머지된 main 변경사항

| 파일 | 내용 |
|------|------|
| `db/migrations/017_usage_tokens.sql` | agent_invocations 토큰 컬럼 4개 추가 |
| `src/core/invocation-tracker.ts` | TokenUsage 인터페이스 + completeInvocation 확장 |
| `src/server/monitor.ts` | 모니터링 UI (Topology·Swimlane) 업데이트 |
| `cli-installs/ollama-ctl.sh` | Ollama 관리 스크립트 (참조용) |
| `.claude/commands/nco-ollama.md` | /nco-ollama 커맨드 |

## 충돌 해결 전략

- **Mac 우선 유지**: `config.ts`(mlx), `topology.json`, `ecosystem.config.cjs`, `statusline.sh`
- **main 채택**: `monitor.ts`, `mcp/server.ts`, `agent-manager.ts` (신기능 포함)
- **이유**: Mac은 MLX 백엔드 사용, Ollama 관련 코드는 Windows(WSL) 전용
