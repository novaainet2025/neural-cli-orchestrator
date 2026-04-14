# claude-5: Tool Use 파라미터 보정 검증

> 분석 대상: `security-kb/anthropic-vllm-proxy.py`
> 분석일: 2026-04-14

## 1. 7개 핵심 도구의 Gemma 호환성

### 도구 선택 상수
```python
_MAX_TOOLS_GEMMA = 8      # Line 1455
_MAX_TOOLS_DEFAULT = 10   # Line 1456
_CORE_TOOLS = {"Bash", "Read", "Skill"}  # Line 1434
```

### 차단 도구 (_BLOCKED_TOOLS_FOR_VLLM, Lines 1428-1430)
ExitWorktree, EnterWorktree, Monitor, ExitPlanMode, EnterPlanMode, NotebookEdit, ScheduleWakeup, CronCreate, CronDelete, CronList

### 핵심 도구별 Gemma 호환성

| 도구 | Gemma 호환성 | 주요 이슈 |
|------|-------------|----------|
| Bash | 양호 | command 파라미터 이스케이프 누락 가능 |
| Read | 양호 | file_path 할루시네이션 빈발 |
| Edit | 중간 | old_string 유일성 보장 미흡 |
| Write | 양호 | content 전체 제공 필수 |
| Grep | 중간 | 정규식 복잡도 제한 필요 |
| Glob | 양호 | 와일드카드 패턴 단순화 필요 |
| Skill | 양호 | skill 이름 정확도 높음 |

## 2. Relaxed JSON 파싱 검증 (Lines 1756-1762)

### Gemma 텍스트 기반 도구 호출 감지 (Lines 1720-1748)

```
Gemma 생성 형식: <|tool_call>call:ToolName{...}<tool_call|>

감지 패턴 (Line 1724-1726):
  <|tool_call>call:{ToolName}{raw_args}<tool_call|>

추출 후 파싱 (Line 1730-1735):
  1차: json.loads(raw_args)
  2차 (실패시): {"command": raw_args}  ← Bash 폴백
```

### JSON 복구 로직

```python
try:
    input_data = json.loads(raw_args) if raw_args else {}
except json.JSONDecodeError:
    # 복구: 불완전 JSON을 _raw_arguments로 래핑
    input_data = {"_raw_arguments": raw_args}
```

### 검증 결과
- **정상 JSON**: 정확히 파싱됨
- **불완전 JSON**: `_raw_arguments`로 보존 — 데이터 손실 방지
- **빈 인수**: 빈 딕셔너리 `{}` 반환 — 안전

## 3. Think 블록 제거 (Lines 1161-1163)

```python
elif t == "thinking":
    log.debug("thinking 블록 수신 (무시): budget=%s", block.get("budget_tokens"))
```

- Anthropic API의 extended thinking 블록을 수신하되 **응답에서 제거**
- 토큰 절약 효과: thinking이 응답의 30-50%를 차지할 수 있음

## 4. 도구 파라미터 보정 개선안

### 개선 1: Bash command 이스케이프 강화
```python
# Gemma가 생성한 command에서 위험 패턴 감지
if tool_name == "Bash":
    cmd = input_data.get("command", "")
    # rm -rf / 같은 위험 명령 차단
    if re.match(r'rm\s+-rf\s+/', cmd):
        return error_response("위험한 명령 차단됨")
```

### 개선 2: Read file_path 검증
```python
if tool_name == "Read":
    path = input_data.get("file_path", "")
    # 상대 경로 → 절대 경로 변환
    if not path.startswith("/"):
        path = os.path.join(os.getcwd(), path)
```

### 개선 3: Edit old_string 퍼지 매칭
Gemma가 old_string을 약간 다르게 생성하는 경우 (공백, 줄바꿈 차이):
```python
# 정확 매칭 실패 시 fuzzy 매칭 시도
if old_string not in file_content:
    # difflib.get_close_matches로 유사 문자열 탐색
    candidates = find_similar_blocks(file_content, old_string, threshold=0.85)
```
