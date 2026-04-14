# claude-6: NCO 명령어 + vLLM 통합 워크플로우 검증

> 분석 대상: 프록시 Conductor 릴레이 + NCO 명령어 체계
> 분석일: 2026-04-14

## 1. nco-vllm-* 명령어 동작 검증

| 명령어 | 상태 | 기능 |
|--------|------|------|
| `/nco-vllm-status` | 정상 | PID, 헬스체크, VRAM, 업타임, 로드된 모델 |
| `/nco-vllm-start` | 정상 | 서버 시작 (모델 로딩 ~3분) |
| `/nco-vllm-stop` | 정상 | 서버 중지 + VRAM 해제 |
| `/nco-vllm-restart` | 정상 | 중지 → 3초 대기 → 시작 |
| `/nco-vllm-metrics` | 정상 | 처리량, 지연, VRAM 현황 |
| `/nco-vllm-config` | 정상 | 프로바이더 설정 출력 |
| `/nco-vllm-models` | 정상 | 설치/활성/로드 모델 목록 |
| `/nco-vllm-proxy-start` | 정상 | 프록시 시작 (포트 4100) |
| `/nco-vllm-proxy-status` | 정상 | 프록시 실행/로그 확인 |
| `/nco-vllm-proxy-stop` | 정상 | 프록시 종료 |

> 모든 10개 명령어 정상 동작 확인

## 2. Conductor 릴레이 경로 분석

### 프록시에서의 릴레이 (anthropic-vllm-proxy.py)

```
사용자 입력
    ↓
IntentClassifier.classify() (Line 2202)
    ↓
┌─ intent="answer" → vLLM 직접 추론
├─ intent="skill" → 스킬 실행 (nco-*, /slash)
└─ intent="exec" → _execute_conductor_relay() (Line 2235)
    ↓
POST http://localhost:6200/api/conductor (Line 413)
    ↓
taskId 수신 → 45초 폴링 (5초 간격, Lines 424-437)
    ↓
make_skill_response("conductor", result) (Line 2237)
    ↓
SSE 스트림 변환 → Claude Code에 전달
```

### Mesh Auto-Responder에서의 릴레이

```
[TASK] 메시지 수신 (WebSocket)
    ↓
tryDirectFileCreation() 시도 (Line 302)
    ↓
실패 시 → POST http://localhost:6200/api/conductor (Line 312)
    ↓
taskId 수신 → 60초 폴링 (5초 간격)
    ↓
결과 회신: [AUTO][TASK-RESULT] ...
```

### 핵심 차이점

| 항목 | 프록시 | Mesh Responder |
|------|--------|----------------|
| 폴링 타임아웃 | 45초 | 60초 |
| 응답 형식 | SSE 스트림 | 텍스트 메시지 |
| 폴백 | "NCO 응답 없음" | taskId 반환 |
| 직접 처리 | 없음 | tryDirectFileCreation |

## 3. 폴백 동작 (Conductor 미가용 시)

### 프록시 (Lines 420-446)
- 연결 오류 시 예외 처리 → `nco_result = {"error": str(e)}`
- taskId 없으면 폴링 스킵, 에러 응답 직접 반환
- 기본 메시지: "NCO 응답 없음"

### Mesh Responder (Lines 345-348)
- NCO 연결 오류 catch → `[TASK 실패] NCO 연결 오류: {message}`
- 폴링 타임아웃 → `[NCO] 작업 진행 중 (taskId: ...) — /nco-kanban 으로 확인`

## 4. vLLM-NCO 통합 개선 제안

### 제안 1: Intent 기반 라우팅 캐시
동일 패턴 반복 시 IntentClassifier 호출 생략:
```python
intent_cache = TTLCache(maxsize=100, ttl=60)
key = hash(user_text[:50])
if key in intent_cache:
    return intent_cache[key]
```

### 제안 2: Conductor 비동기 스트리밍
현재 폴링(5초 간격) 대신 WebSocket으로 실시간 결과 수신:
```
프록시 → POST /api/conductor → taskId
프록시 → WS 6201 subscribe(taskId)
NCO → 완료 이벤트 → 프록시 즉시 수신 (폴링 지연 제거)
```

### 제안 3: 하이브리드 실행 모드
```
단순 작업 (파일 읽기/검색) → vLLM 직접 처리 (비용 0)
복잡 작업 (설계/분석) → Conductor → 최적 에이전트
혼합 작업 → vLLM 초안 + Conductor 검증
```
