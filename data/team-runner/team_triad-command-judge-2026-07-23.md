# Triad Command & Judge — 일일 산출물 (2026-07-23, ai=claude-code, taskId=task_FiLGwZ_ec9LxMM0p)

## Triad Command & Judge — 2026-07-23

### 1. 오늘 관찰·분석

| 관찰 | 근거 | 등급 |
|------|------|------|
| claude-code 성공률 36%, 24h실패 8회 | `/api/agents` 실데이터 | T1 (직접 주입) |
| 모든 장기기억 태스크가 FORMAT_MISMATCH로 quality-gate reject | `quality_rejected: FORMAT_MISMATCH` 일관 패턴 (5개 태스크) | T1 |
| 다른 에이전트(opencode 제외) 상태는 모두 idle | 동일 실데이터에 기재 없음 — 미확인 | 미확인 |
| gemini, aider, openclaw는 offline | 팀 멤버 목록에 명시 | T1 |
| opencode는 task_FiLGwZ_ec9LxMM0p 작업 중 | 팀 멤버 목록에 명시 | T1 |

**핵심 패턴**: claude-code 36% 성공률 + FORMAT_MISMATCH reject 반복 = 출력 형식 계약 위반이 지속적 블로커.

### 2. 현재 상태

- **프로젝트**: nco (bugfix)
- **claude-code**: idle (마지막 태스크 1223), 성공률 36% — 심각 수준. 24h 8회 실패는 rate-limit 또는 복구 불가 패턴일 가능성.
- **다른 에이전트**: 모두 idle/open offline — 현재 전력 8/12.
- **장기기억 일관성 실패**: 5개 태스크 모두 `FORAMT_MISMATCH` (원문 오타 포함)로 거절 — 템플릿/스키마 준수 실패가 근본 원인으로 보임.
- **변경 파일 목록 / diff 요약 / 빌드 결과**: **미확인** — 명령 실행 불가 환경이므로 생성할 수 없음.

### 3. 다음에 필요한 작업 제안

**우선순위 1 — FORMAT_MISMATCH 루트 원인 분석**
- `src/agent/` 또는 `src/utils/`에서 quality-gate 검증 로그 조회
- reject된 태스크의 출력 샘플과 기대 스키마 비교
- 성공 케이스(36%)와 실패 케이스(64%)의 출력 차이 수집

**우선순위 2 — claude-code 성능 진단**
- `/api/agents` 전체 응답 수집 (다른 7개 에이전트 상태·성공률)
- 24h실패 8회의 구체적 실패 유형: rate-limit? timeout? 출력 오류?
- 성공률 36%의 threshold (기대치? NCO 평균?)

**우선순위 3 — 시스템 회복**
- FORMAT_MISMATCH가 템플릿 문제면 `src/mcp/` 템플릿 검증 파이프라인 수정
- claude-code 재시작 또는 타입 A→B 전환 검토
- opencode(task 진행 중) 완료 시점에 논의 참여 요청

**수집 필요 데이터 목록**:
1. `/api/agents` 전체 JSON 응답
2. quality-gate 검증기 소스 (`src/security/` 또는 `src/core/`)
3. claude-code 최근 실패 태스크 1223의 상세 로그
4. 기대 출력 스키마 (Zod validation)

**미확인 항목**: 빌드 상태, 테스트 결과, diff 내용, 커밋 현황 — 텍스트 전용 응답이므로 생성 불가.
