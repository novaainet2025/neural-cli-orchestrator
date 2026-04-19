# claude-1: IntentClassifier 분석 + 도구 선택 최적화

> 분석 대상: `security-kb/anthropic-vllm-proxy.py`
> 분석일: 2026-04-14

## 1. IntentClassifier 분류 로직 (Lines 345-400)

Ollama guided JSON을 사용하여 사용자 의도를 3가지로 분류:

| 의도 | 설명 | 예시 |
|------|------|------|
| `exec` | 실행/작업 요청 | "파일 수정해줘", "테스트 실행" |
| `skill` | NCO 스킬 호출 | "nco-status", "nco-mesh" |
| `answer` | 일반 Q&A/채팅 | "이 코드 설명해줘" |

### 모호성 감지 (Line 348)
- 입력 길이 < 30자 또는 한국어 대명사(그/이/저) 포함 시 **모호한 입력**으로 판단
- 모호한 경우 최근 대화 컨텍스트를 추가하여 분류 정확도 향상
- `_INTENT_SCHEMA` (Line 379)로 guided JSON 응답 강제

## 2. _select_tools_for_message 도구 선택 (Lines 1459-1517)

5단계 On-Demand Tool Indexing:

```
Step 1: Core Tools (항상 포함)
  → {Bash, Read, Skill}

Step 2: 키워드 매칭 (_TOOL_GROUPS 정규식)
  → 마지막 사용자 메시지에서 키워드 스캔

Step 3: 연속성 보장
  → 최근 4턴에서 사용된 도구 유지

Step 4: 안전 기본값
  → Core만 남으면 {Edit, Write, Grep, Glob} 추가

Step 5: 특수 규칙
  → MCP nco-commands 항상 포함 → max_tools 캡
```

### 키워드 매칭 패턴 (Lines 1437-1451)

| 도구 그룹 | 키워드 |
|-----------|--------|
| Edit/Write | 수정, 변경, edit, fix, create, write, refactor |
| Grep/Glob | 찾, 검색, find, grep, glob, structure |
| AskUserQuestion | 질문, 확인, 선택, which, decide |
| WebFetch/WebSearch | 웹, url, http, fetch, download |
| Agent | 에이전트, 위임, delegate, 병렬, parallel |

### 상수
- `_MAX_TOOLS_GEMMA = 8` (Line 1455)
- `_MAX_TOOLS_DEFAULT = 10` (Line 1456)
- `_CORE_TOOLS = {Bash, Read, Skill}` (Line 1434)
- `_BLOCKED_TOOLS_FOR_VLLM`: 10개 도구 제외 (ExitWorktree, Monitor 등)

## 3. 개선 제안

### 제안 1: 키워드 매칭 확장
현재 한국어 키워드가 제한적. "고쳐", "바꿔", "열어" 등 구어체 동사 추가 필요.

### 제안 2: 의도 분류 캐싱
동일 패턴의 반복 요청에 대해 IntentClassifier 결과를 30초간 캐싱하여 Ollama 호출 감소.

### 제안 3: 도구 사용 피드백 루프
도구 호출 실패 시 다음 턴에서 해당 도구를 우선 포함하도록 _select_tools_for_message에 실패 히스토리 반영.
