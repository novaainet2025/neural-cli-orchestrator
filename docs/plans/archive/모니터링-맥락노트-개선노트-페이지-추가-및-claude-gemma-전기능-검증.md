# 모니터링 맥락노트·개선노트·페이지 추가 및 claude-gemma 전기능 검증

> **Plan ID**: plan_UcVHOvT2sOGGKj1P  
> **생성일**: 2026-04-19  
> **목표**: NCO 모니터링에 맥락노트·개선노트·전체기록 페이지 추가, claude-gemma(MLX Gemma 4 26B)의 Claude Code 전기능 + NCO 기능 사용 가능 여부 검증, 프록시 설정 수정으로 모든 도구 사용 확인

---

## 배경 및 컨텍스트

- **NCO Monitor**: `src/server/monitor.ts` (3626줄) — 현재 탭: Overview, Mesh, Sessions, Messages, Discussions, Tasks, Flow, Debug
- **claude-gemma**: `ANTHROPIC_BASE_URL=http://localhost:4100 claude` — MLX Proxy(port 4100) → MLX Server(port 8000) → Gemma 4 26B A4B 4-bit
- **MLX 프록시**: `/Users/nova-ai/project/nco/cli-installs/anthropic-mlx-proxy.py` (774줄) — Anthropic API ↔ OpenAI-compatible 변환
- **기존 이슈**: Connection: keep-alive → close 수정으로 SSE Dilly-dallying 해결 이력 있음

---

## Phase 1: 모니터링 UI 개선 — 새 탭 3개 추가

### 1-1. 맥락노트 (Context Notes) 탭
- [ ] `src/server/monitor.ts` 탭 바에 `Context` 탭 추가
- [ ] 탭 컨텐츠: 현재 세션/플랜/토론의 맥락 정보를 실시간 표시
  - 활성 Plan ID + 제목
  - 현재 실행 중인 에이전트 + 역할
  - 진행 중인 Discussion 주제
  - 최근 10개 이벤트 요약
- [ ] WebSocket 이벤트 `context:update` 수신 시 자동 갱신
- [ ] `src/server/gateway.ts`에 `GET /api/context/current` 엔드포인트 추가 (현재 맥락 스냅샷 반환)

### 1-2. 개선노트 (Improvement Notes) 탭
- [ ] `src/server/monitor.ts` 탭 바에 `Improvements` 탭 추가
- [ ] 개선노트 데이터 구조 정의:
  ```
  {
    id, timestamp, category,
    problem: string,      // 무엇이 문제였는가
    rootCause: string,    // 근본 원인
    fix: string,          // 어떻게 수정했는가
    verifiedAt: string,   // 검증 시각
    agent: string,        // 수정한 에이전트
    severity: 'low'|'medium'|'high'|'critical'
  }
  ```
- [ ] SQLite 마이그레이션 추가: `db/migrations/007_improvement_notes.sql` (또는 다음 번호)
- [ ] `src/server/gateway.ts`에 CRUD 엔드포인트 추가:
  - `POST /api/improvements` — 개선노트 등록
  - `GET /api/improvements` — 목록 조회 (페이지네이션)
  - `GET /api/improvements/:id` — 상세 조회
- [ ] 탭 UI: 심각도별 색상 배지, 문제/원인/수정 3단 레이아웃, 검색/필터

### 1-3. 전체기록 (All Records) 페이지
- [ ] `src/server/monitor.ts` 탭 바에 `All Records` 탭 추가
- [ ] 통합 타임라인 뷰: 이벤트·메시지·태스크·디스커션·개선노트를 시간순 단일 피드로 표시
- [ ] 필터 옵션: 유형별(이벤트/메시지/태스크/토론/개선), 에이전트별, 시간 범위
- [ ] `GET /api/records/all` 엔드포인트: 통합 페이지네이션 반환
- [ ] 실시간 WebSocket push — 새 레코드 도착 시 피드 상단 삽입

---

## Phase 2: 모니터링 정상 동작 검증

### 2-1. 서버/WebSocket 연결 확인
- [ ] NCO 백엔드(port 6200) 응답 확인: `curl http://localhost:6200/health`
- [ ] WebSocket 브리지(port 6201) 연결 확인
- [ ] 모니터 페이지 브라우저 오픈: `http://localhost:6260`
- [ ] 기존 8개 탭 데이터 정상 렌더링 확인

### 2-2. 새 탭 기능 테스트
- [ ] Context 탭: 활성 Plan 데이터 정상 표시 확인
- [ ] Improvements 탭: 테스트 개선노트 등록 → UI 반영 확인
- [ ] All Records 탭: 이벤트 발생 시 실시간 피드 업데이트 확인
- [x] TypeScript 컴파일 오류 0개: `npx tsc --noEmit`

### 2-3. 기존 탭 회귀 확인
- [ ] Overview, Mesh, Sessions, Messages, Discussions, Tasks, Flow, Debug 탭 정상 동작 확인
- [ ] 드래그 리사이저, 키보드 단축키 정상 동작 확인

---

## Phase 3: claude-gemma 전기능 검증

### 3-1. 환경 확인
- [ ] MLX 서버 실행 확인: `curl http://localhost:8000/health`
- [ ] MLX 프록시 실행 확인: `curl http://localhost:4100/health`
- [ ] 기본 추론 테스트: `ANTHROPIC_BASE_URL=http://localhost:4100 ANTHROPIC_API_KEY=dummy claude -p "hello"`

### 3-2. Claude Code 기본 기능 검증
- [ ] **파일 읽기 (Read tool)**: 파일 읽기 요청 → 도구 호출 확인
- [ ] **파일 쓰기 (Write/Edit tool)**: 파일 수정 요청 → 도구 호출 확인
- [ ] **Glob/Grep 검색**: 파일 패턴 검색 요청 → 도구 호출 확인
- [ ] **Bash 실행**: 명령어 실행 요청 → 도구 호출 확인
- [ ] **멀티턴 대화**: 이전 컨텍스트 유지 확인
- [ ] **스트리밍 응답**: SSE 스트리밍 정상 동작 확인 (Connection: close 설정 확인)

### 3-3. NCO 기능 검증
- [ ] **NCO 슬래시 명령어**: `/nco-status`, `/nco-providers` 실행 확인
- [ ] **에이전트 위임**: claude-gemma에서 다른 에이전트에 태스크 위임 가능 확인
- [ ] **MCP 도구**: NCO MCP 서버(26개 도구) 접근 가능 확인
- [ ] **Mesh 통신**: claude-gemma 세션이 Mesh에 등록되는지 확인
- [ ] **토론 참여**: `/nco-discussion` 실행 시 claude-gemma가 참여자로 등록 확인

### 3-4. 모든 에이전트와 공동 검증
- [ ] claude-code + claude-gemma 병렬 실행 테스트
- [ ] claude-gemma가 codex, aider 에이전트에게 위임하는 시나리오 실행
- [ ] NCO 대시보드에서 claude-gemma 에이전트 상태 표시 확인
- [ ] 토론 세션에서 claude-gemma 응답 품질 확인

---

## Phase 4: 프록시 설정 수정 및 도구 사용 검증

### 4-1. 현재 프록시 이슈 진단
- [ ] `anthropic-mlx-proxy.py` 전체 검토 — 지원 엔드포인트 목록화
- [ ] 현재 미지원/오작동 엔드포인트 식별:
  - `/v1/messages` (스트리밍/비스트리밍)
  - `/v1/messages/count_tokens`
  - Tool use (도구 호출) 라운드트립
  - System prompt 처리
  - Vision/multimodal (이미지) 지원 여부

### 4-2. 프록시 수정 사항
- [ ] **Tool use 검증**: Gemma 도구 호출 파싱 (`GEMMA_TOOL_HEAD` 정규식) 정확도 확인
  - Claude Code가 보내는 도구 스키마 → Gemma 응답 → 역변환 파이프라인 테스트
- [ ] **SSE 스트리밍**: `Connection: close` 헤더 설정 확인 (기존 수정사항 유지)
- [ ] **토큰 카운트**: `/v1/messages/count_tokens` 응답 정확도 확인
- [ ] **오류 응답 형식**: Anthropic 형식 오류 응답 변환 정확도 확인
- [ ] **타임아웃 설정**: GPU 세마포어 타임아웃(180초) 적정성 검토

### 4-3. 도구별 사용 가능 여부 표 작성
- [ ] 아래 도구 각각 claude-gemma에서 실제 호출 테스트:

| 도구 | 예상 동작 | 실제 결과 | 상태 |
|------|-----------|-----------|------|
| Read | 파일 읽기 | - | - |
| Write | 파일 쓰기 | - | - |
| Edit | 파일 수정 | - | - |
| Bash | 명령어 실행 | - | - |
| Glob | 파일 검색 | - | - |
| Grep | 내용 검색 | - | - |
| WebFetch | 웹 요청 | - | - |
| WebSearch | 웹 검색 | - | - |
| Agent | 서브에이전트 | - | - |

- [ ] 실패 도구에 대한 개선노트 등록

### 4-4. 최종 검증 및 문서화
- [x] 모든 수정 사항 TypeScript 컴파일 확인: `npx tsc --noEmit`
- [ ] 기존 API 엔드포인트 응답 확인 (회귀 없음)
- [ ] `config/ai-providers.json` MLX 항목 업데이트 (수정된 정보 반영)
- [ ] 개선노트 탭에 이번 작업의 수정 사항 일괄 등록
- [ ] `docs/reports/` 에 검증 결과 리포트 저장

---

## 성공 기준

- [x] `npx tsc --noEmit` 오류 0개
- [ ] 모니터 3개 새 탭 (Context, Improvements, All Records) 정상 렌더링
- [ ] claude-gemma에서 Read/Write/Edit/Bash/Glob/Grep 6개 도구 이상 정상 동작
- [ ] 개선노트에 이번 작업의 문제점 및 수정 내용 기록 완료
- [ ] 기존 8개 탭 회귀 없음
- [ ] NCO 에이전트 위임 파이프라인에서 claude-gemma 정상 참여 확인

---

## 담당 에이전트 분배 (권장)

| Phase | 담당 | 역할 |
|-------|------|------|
| Phase 1 UI | opencode + aider | UI 설계 + 파일 편집 |
| Phase 2 검증 | codex + claude-gemma | 단위 테스트 + 자가 검증 |
| Phase 3 검증 | claude-code (감독) + all agents | 전체 에이전트 공동 확인 |
| Phase 4 프록시 | codex + cursor-agent | 프록시 수정 + 코드 리뷰 |
| 최종 통합 | claude-code | 최종 승인 |
