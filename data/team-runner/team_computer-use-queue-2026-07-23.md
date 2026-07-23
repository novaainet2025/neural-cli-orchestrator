# Computer Use 요청·대기·보고팀 — 일일 산출물 (2026-07-23, ai=claude-code, taskId=task_vs7cNMx7h1gfeV3e)

status: Computer Use Coordinator 보고 (2026-07-23)

## 1. 오늘 관찰·분석

- **Provider 상태 (실데이터 기준)**: `claude-code` — idle, task 1223, 성공률 36%, 24h 실패 12. 성공률 36%는 24h 실패 12건과 연관됨. 재시도 정책 또는 task 배분 기준 점검 필요. `opencode` — working (task 2005), 성공률 74%, 24h 실패 1. 안정적.
- **Computer Use 요청**: 현재 접수된 요청 0건. 점유 대기열 없음. 제어권 유휴 상태.
- **장기 기억 패턴 (미확인 → 데이터 수집 필요)**: `quality_rejected: FORMAT_MISMATCH`가 4개 task에서 반복됨. 이전 거절 이유가 출력 형식 불일치로 수렴 중. 근거는 BM25 검색 결과 문자열만 존재(T3) — 실제 DB 조회나 로그 파일 내용은 미확인.

## 2. 현재 상태

| 항목 | 상태 | 근거 등급 |
|------|------|-----------|
| 제어권 점유 | 없음 (유휴) | 실데이터 상 Computer Use 요청 0건 |
| claude-code | idle, task 1223 | 주입 실데이터 (T1, /api/agents) |
| opencode | working, task 2005 | 주입 실데이터 (T1) |
| codex 외 6개 | idle/offline | 주입 에이전트 목록 (T1) |
| FORMAT_MISMATCH 원인 | 미확인 | BM25 점수 0.43-0.55 문자열 존재 (T3) — 실제 DB row·로그 미조회 |
| 대기열 | 비어 있음 | Computer Use 요청 0건 |

## 3. 다음 필요 작업 제안

1. **claude-code 부진 분석**: 성공률 36%·24h 실패 12의 근본 원인 확인. `GET /api/agents/claude-code/errors` 또는 `GET /api/tasks?agent=claude-code&status=failed` 호출 필요 (NCO MCP gateway :6200).
2. **Computer Use readiness 확인**: 제어 코디네이터(예: open-computer-use 인스턴스)의 상태를 `GET /health` 또는 프로세스 존재 여부(`ps aux | grep computer-use`)로 확인. 현재 미확인.
3. **FORMAT_MISMATCH 추적**: 4개 task reject의 공통 로그 수집. `/api/tasks?status=rejected&reason=FORMAT_MISMATCH` 조회로 DB row 직접 확인 (T1 필요).
4. **수집 불가 항목**: Computer Use coordinator 주소, 대기열 depth, 재시도 로그, WebSocket 연결 상태 — 전부 미확인. 위 API 조회로 해소 가능.

question: 위 (3) FORMAT_MISMATCH DB 조회를 코디네이터(NCO gateway)에 요청할까요?
