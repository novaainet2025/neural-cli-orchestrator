# Mesh & Discussion 검증 보고서 (2026-04-15)

## 수정된 버그 (5건)

| # | 버그 | 수정 파일 | 검증 |
|---|------|----------|------|
| 1 | 브로드캐스트 `delivered:0` (skip-self 오발동) | `src/core/cli-mesh.ts:371` | ✓ delivered=1 |
| 2 | `/api/mesh/messages/:sessionId` queue+DB 통합 조회 | `src/server/gateway.ts:608`, `src/core/cli-mesh.ts:peekPendingMessages` | ✓ pending 필드 |
| 3 | `nco-mesh.md` `[AUTO]` 하드코딩 필터 제거 | `.claude/commands/nco-mesh.md` | ✓ 모든 메시지 표시 |
| 4 | 세션ID PID→UUID | `.claude/commands/nco-mesh.md` | ✓ `agent-{uuid8}` |
| 5 | `claude-gemma` 시작시 자동 heartbeat | `~/.local/bin/claude-vllm-gemma` | ✓ trap 포함 |

## 구현된 엔드포인트

- `POST /api/discussion/start` — 실제 `discussionEngine.startDiscussion()`과 연결 (이전엔 fallback stub)

## E2E 테스트 결과

모든 Mesh API + 토론 엔진 핵심 경로 통과.

## Gap (별도 이슈)

- `/api/providers` — fallback stub ("pending implementation")
- `/api/agents` — 빈 배열 반환 (agent 초기화 검토 필요)

## TypeScript 컴파일

`npx tsc --noEmit` 오류 0건.
