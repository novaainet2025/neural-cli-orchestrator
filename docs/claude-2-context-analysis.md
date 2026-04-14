# claude-2: 히스토리 트리밍 + 컨텍스트 관리 분석

> 분석 대상: `security-kb/anthropic-vllm-proxy.py`
> 분석일: 2026-04-14

## 1. trim_messages() 동작 방식 (Lines 919-980)

### 핵심 로직
가장 오래된 메시지부터 제거하여 토큰 예산 이내로 유지:

```
보존 대상:
  - system 메시지 (항상 유지)
  - 최신 user 메시지 (항상 유지)
  - tool_use/tool_result 쌍 (무결성 보장)

제거 순서:
  1. 가장 오래된 user/assistant 메시지부터
  2. tool_use가 있는 assistant 제거 시 → 연관 tool_result도 함께 제거
```

### 토큰 예산 계산
```python
MAX_OUTPUT_TOKENS = 4096
VLLM_MAX_CTX = 16384  # vLLM /v1/models에서 자동 감지
effective_budget = VLLM_MAX_CTX - MAX_OUTPUT_TOKENS - 256  # 안전 마진

# 트리밍 임계값: 시스템 토큰 제외 후 70%
trim_threshold = (effective_budget - system_tokens) * 0.70
```

## 2. tool_use/tool_result 쌍 보존 (Lines 948-969)

### 추출 함수 (Lines 866-881)
- `extract_tool_use_ids()`: assistant 메시지의 tool_use 블록에서 ID 추출
- `extract_tool_result_ids()`: user 메시지의 tool_result 블록에서 tool_use_id 추출

### 매칭 로직 (Lines 950-967)
```
assistant[tool_use id=A, id=B] 제거 시:
  → pending = {A, B}
  → 후속 user 메시지에서 tool_result(tool_use_id=A), tool_result(tool_use_id=B) 탐색
  → 매칭되는 tool_result 포함 user 메시지도 함께 제거
  → pending이 빌 때까지 반복
```

**A1 불변성**: tool call + response가 항상 함께 유지/제거됨

## 3. 토큰 카운팅 메커니즘

### 추정 방식 (Line 794)
```python
CJK 문자: 1.2 토큰/글자
ASCII: 3.5 글자/토큰
안전 마진: ×1.15
```

### 정확 카운팅 (Line 806)
- vLLM `/tokenize` 엔드포인트 호출
- 실패 시 추정치로 폴백
- `/v1/messages/count_tokens` (Lines 2415-2429): 메시지+도구를 JSON으로 평탄화 후 토큰화

### 안전 장치 (Line 927)
- ±15% 추정 오차 허용
- Preflight 검증: `vllm_tokenize_messages`로 추론 전 재확인

## 4. MAX_HISTORY_TOKENS 최적값 제안

| 시나리오 | 현재값 | 제안값 | 근거 |
|----------|--------|--------|------|
| Gemma 4K 모델 | 70% (약 2,700) | 65% (약 2,500) | 도구 주입 토큰 여유 확보 |
| 16K 컨텍스트 | 70% (약 8,400) | 75% (약 9,000) | 긴 컨텍스트 활용 극대화 |
| 도구 Heavy 작업 | 70% | 55% | 도구 정의가 1,500+ 토큰 점유 |

### 개선안
- 동적 임계값: 주입된 도구 수에 따라 트리밍 비율 자동 조정
- 현재 도구 8개(Gemma) × ~150토큰 ≈ 1,200토큰이므로, 도구 많을수록 히스토리 축소
