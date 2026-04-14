# vLLM 모델을 활용한 Claude Code 최적화 종합 가이드

> 6개 Claude 에이전트(claude-1~6)의 관점을 통합한 실전 최적화 문서
> 원본: 17개 MD 파일 (backup/, 새 폴더/, 새 폴더 (2)/, combined.md) 통합
> 최종 정리: 2026-04-14

---

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [vLLM 서버 성능 최적화](#2-vllm-서버-성능-최적화)
3. [프록시 계층 최적화](#3-프록시-계층-최적화)
4. [컨텍스트 윈도우 관리](#4-컨텍스트-윈도우-관리)
5. [Tool Use 최적화](#5-tool-use-최적화)
6. [Mesh 네트워크 협업](#6-mesh-네트워크-협업)
7. [비용 대비 효과 극대화](#7-비용-대비-효과-극대화)
8. [에이전트 역할 분담](#8-에이전트-역할-분담)
9. [검증 및 품질 보장](#9-검증-및-품질-보장)
10. [Opus급 추론 구현 전략](#10-opus급-추론-구현-전략)

---

## 1. 아키텍처 개요

### 시스템 구조

```
사용자 터미널
    ↓
Claude Code (claude 바이너리, PID별 세션)
    ↓
┌─────────────────────────────────────┐
│  Anthropic-vLLM 프록시 (포트 4100)  │
│  - Anthropic ↔ OpenAI 형식 변환     │
│  - IntentClassifier (도구 필요 판별) │
│  - 히스토리 자동 트리밍              │
│  - Conductor 릴레이 (복잡 작업 위임) │
└─────────────┬───────────────────────┘
              ↓
┌─────────────────────────────────────┐
│  vLLM 서버 (포트 8000)              │
│  - Gemma 4 26B-A4B (NVFP4 양자화)  │
│  - PagedAttention + Continuous Batch│
│  - max_model_len ≈ 4096 토큰       │
└─────────────────────────────────────┘
```

### 핵심 포트 구성

| 포트 | 서비스 | 용도 |
|------|--------|------|
| 4100 | Anthropic-vLLM 프록시 | Claude Code ↔ vLLM 변환 |
| 6200 | NCO 백엔드 (HTTP) | 에이전트 관리, Mesh API |
| 6201 | NCO WebSocket | 실시간 이벤트 브로드캐스트 |
| 8000 | vLLM 서버 | 로컬 모델 추론 |

---

## 2. vLLM 서버 성능 최적화

### 2.1 PagedAttention 최적화

vLLM의 핵심 기술인 PagedAttention은 KV 캐시의 메모리 파편화를 방지합니다.

- **KV Cache 크기 조정**: `nco-vllm-config`로 현재 설정 확인, 긴 컨텍스트 작업 시 캐시 크기 확대
- **메모리 오버헤드 감소**: 대규모 프로젝트 탐색 시 KV 캐시가 VRAM을 잠식하지 않도록 관리
- **VRAM 모니터링**: `nco-vllm-metrics`로 GPU 메모리 점유율, 토큰 생성 속도, 레이턴시 실시간 확인

### 2.2 Continuous Batching

다중 에이전트(Mesh)가 동시 요청 시 대기 시간 최소화:

```
에이전트 A 요청 ──┐
에이전트 B 요청 ──┼── vLLM Continuous Batch ── 동시 처리
에이전트 C 요청 ──┘
```

- 순차 처리 대비 3-5배 처리량 향상
- `nco-vllm-set-idle`로 미사용 시 자동 VRAM 해제

### 2.3 양자화 전략

Gemma 4 26B 모델의 NVFP4 양자화 적용:

| 방식 | VRAM | 품질 | 속도 |
|------|------|------|------|
| FP16 | ~52GB | 최상 | 기준 |
| NVFP4 (현재) | ~14GB | 양호 | 1.5x |
| AWQ/GPTQ | ~13GB | 양호 | 1.3x |

> 현재 NVFP4가 VRAM-성능 균형에서 최적

### 2.4 서버 관리 명령어

```bash
/nco-vllm-status    # 상태 확인 (PID, 헬스체크, VRAM, 업타임)
/nco-vllm-start     # 서버 시작 (모델 로딩 ~3분)
/nco-vllm-stop      # 서버 중지 + VRAM 해제
/nco-vllm-restart   # 재시작 (중지 → 3초 → 시작)
/nco-vllm-metrics   # 성능 지표 (처리량, 지연, VRAM)
/nco-vllm-config    # 프로바이더 설정 확인
```

---

## 3. 프록시 계층 최적화

### 3.1 IntentClassifier

프롬프트를 사전 분석하여 도구 사용 여부를 판별:

```python
TOOL_INJECT_THRESHOLD = 0.6  # 도구 필요 확률 임계값
```

- 도구가 필요 없는 단순 질문 → 도구 미주입 → 토큰 절약
- 도구가 필요한 작업 → 키워드 기반 도구 선별 주입

### 3.2 동적 도구 선택 (On-Demand Tool Indexing)

전체 도구 목록 대신 키워드 기반으로 필요한 도구만 주입:

```
"파일 읽어줘" → Read, Glob 만 주입
"git 상태 확인" → Bash 만 주입
"코드 수정" → Read, Edit, Grep 주입
```

- **효과**: 4096 토큰 한계에서 도구 설명이 차지하는 비율 대폭 감소
- **7개 핵심 도구**의 파라미터를 Gemma 모델 특성에 맞게 보정

### 3.3 히스토리 자동 트리밍

```python
MAX_HISTORY_TOKENS = 3000  # Gemma 4K 컨텍스트 제한 고려
```

- tool_use/tool_result 쌍 무결성 보장하며 오래된 메시지 제거
- `count_tokens` 엔드포인트로 실제 토큰 수 계산 (vLLM `/tokenize` 활용)

### 3.4 Conductor 릴레이

복잡한 작업은 자동으로 NCO Conductor로 위임:

```
단순 질문 → 프록시가 직접 vLLM 응답
복잡한 작업 → Conductor API → 최적 에이전트 자동 선택 → 실행
```

---

## 4. 컨텍스트 윈도우 관리

### Gemma 4K vs Claude 200K

| 항목 | Gemma (vLLM) | Claude (API) |
|------|-------------|-------------|
| 컨텍스트 | ~4,096 토큰 | 200,000 토큰 |
| 비용 | 무료 (로컬) | API 과금 |
| Tool Use 정확도 | 중간 | 높음 |

### 4.1 작업 단위 분할 (필수)

```
1개 메시지 = 1개 명확한 목표
  - 파일 1-2개
  - 함수 1-3개
  - 긴 작업 → 체크포인트 단위로 분할
```

### 4.2 대형 파일 처리 전략

```
금지: 파일 전체를 vLLM 세션에 전달
권장: grep + head 조합으로 필요 부분만 추출

예시:
  "Read /path/to/file.ts offset=100 limit=30"  ← 30줄만 읽기
  "Grep 'handleMeshMessage' in **/*.ts"         ← 패턴 검색
```

### 4.3 think 블록 제거

Gemma 모델이 생성하는 사고 과정 텍스트를 응답에서 자동 필터링하여 유효 토큰 절약

---

## 5. Tool Use 최적화

### 5.1 Relaxed JSON 파싱

Gemma 계열 모델의 tool call은 종종 불완전한 JSON을 생성:

```json
// Gemma가 생성하는 JSON (불완전)
{name: "Read", input: {file_path: "/tmp/test.ts"}}

// 프록시가 자동 복구
{"name": "Read", "input": {"file_path": "/tmp/test.ts"}}
```

### 5.2 도구 실패 대응

| 상황 | 원인 | 대응 |
|------|------|------|
| 응답이 잘림 | max_tokens 초과 | 작업을 더 작게 분할 |
| 도구 호출 없이 텍스트만 | Gemma가 tool_use 미인식 | "use the Read tool" 명시 지시 |
| 한국어 출력 품질 저하 | Gemma 한국어 약점 | 영어 프롬프트 → 번역 |
| 할루시네이션 | 파일 경로/함수명 오류 | 사실 검증 필수 |

### 5.3 도구 파라미터 보정

7개 핵심 도구에 대해 Gemma 특성 맞춤 보정:

```
Read:  file_path 필수, offset/limit 선택
Edit:  old_string 유일성 보장 필수
Bash:  command 문자열 이스케이프 강화
Grep:  pattern 정규식 단순화 (Gemma 한계)
Glob:  pattern 와일드카드 기본값 제공
Write: content 전체 제공 (부분 쓰기 불가)
Agent: prompt에 충분한 컨텍스트 포함
```

---

## 6. Mesh 네트워크 협업

### 6.1 세션 구조

```
pts/0: claude-1 (Commander, Claude Opus API)
pts/2: claude-2 (vLLM Gemma, 프록시 연결)
pts/3: claude-3 (vLLM Gemma, 프록시 연결)
pts/4: claude-4 (vLLM Gemma, 프록시 연결)
pts/5: claude-5 (vLLM Gemma, 프록시 연결)
pts/6: claude-6 (vLLM Gemma, 프록시 연결)
```

### 6.2 통신 흐름

```
발신 세션 → /nco-mesh send [메시지]
    ↓
NCO 백엔드 (POST /api/mesh/send)
    ↓
WebSocket 브로드캐스트 (포트 6201)
    ↓
auto-responder (node mesh-auto-responder.js)
    ↓
[TASK] 감지 → 파일 생성 직접 처리 / NCO Conductor 위임
    ↓
결과 회신 → 발신 세션
```

### 6.3 충돌 방지

```bash
/nco-mesh check "작업 설명" file1.ts file2.ts
```

3가지 충돌 유형 감지:
- **파일 충돌 (HIGH)**: 같은 파일을 동시 편집
- **작업 중복 (MEDIUM)**: 유사한 작업 설명 (키워드 유사도 ≥ 0.75)
- **브랜치 근접 (LOW)**: 같은 브랜치 + 같은 디렉토리

### 6.4 주요 명령어

```bash
/nco-mesh                    # 세션 목록 + 작업 요약
/nco-mesh send <메시지>      # 브로드캐스트
/nco-mesh send @claude-2 <메시지>  # 다이렉트 메시지
/nco-mesh check <작업설명>   # 충돌 검사
/nco-mesh done               # 작업 완료 표시
/nco-mesh messages           # 메시지 기록 조회
```

---

## 7. 비용 대비 효과 극대화

### 작업 유형별 최적 AI 배분

| 작업 유형 | 권장 AI | 비용 | 이유 |
|-----------|---------|------|------|
| 단순 검증/포맷 변환 | vLLM | 0원 | 반복 작업에 API 낭비 방지 |
| 코드 스타일 수정 | vLLM | 0원 | 패턴 기반 단순 변환 |
| 파일 읽기/검색 | vLLM | 0원 | Read/Grep 도구 실행 |
| 테스트 실행/보고 | vLLM | 0원 | Bash 도구 1회성 실행 |
| 신규 기능 설계 | Claude API | 과금 | 복잡한 아키텍처 결정 |
| 복잡한 디버깅 | Claude API | 과금 | 깊은 맥락 이해 필요 |
| 보안 심층 분석 | Claude API | 과금 | OWASP 취약점 등 |
| 코드 리뷰 | Claude API | 과금 | 전체 맥락 파악 필수 |
| 테스트 생성 | 병렬 조합 | 혼합 | vLLM 초안 → Claude 검증 |

### 비용 절약 원칙

```
1순위: vLLM으로 가능한 작업은 항상 vLLM
2순위: 설계·디버깅만 Claude API
3순위: 병렬 조합으로 품질+비용 최적화
```

---

## 8. 에이전트 역할 분담

### NCO 에이전트 매트릭스

| 에이전트 | 역할 | 강점 | 주요 사용처 |
|---------|------|------|-----------|
| opencode | Architect | 설계·구조 분석 | 아키텍처 결정, 리팩토링 계획 |
| gemini | Designer | UI/UX, 패턴 설계 | 인터페이스 설계, 스키마 정의 |
| codex | Engineer | 빠른 구현 | 함수/클래스 구현 |
| aider | Engineer | 파일 편집 자동화 | 다중 파일 동시 수정 |
| cursor-agent | Reviewer | 코드 품질 | PR 리뷰, 버그 탐지 |
| copilot | Researcher | 지식 검색 | 라이브러리 조사 |
| openrouter | Generalist | 범용 추론 | 알고리즘, 복잡한 로직 |
| vllm | Validator | 검증·테스트 | 출력 검증, 엣지케이스 |

### 자동 위임 기준

```
파일 1-2개 단순 수정      → 직접 처리
파일 3-4개               → nco_parallel([codex, aider]) + cursor-agent 리뷰
파일 5개 이상            → nco_commander (4-Layer 전체 동원)
신규 기능                → opencode(설계) → codex+aider(구현) → cursor-agent(검토)
버그 수정 + 테스트       → codex(수정) + vllm(검증) 병렬
```

---

## 9. 검증 및 품질 보장

### 9.1 단계별 검증 패턴

```
Step 1: 파일 읽기 (Read 도구)
Step 2: 특정 함수 분석
Step 3: 테스트 실행 (Bash 도구)
Step 4: 결과 보고 (표준 형식)
```

### 9.2 검증 결과 표준 형식

```markdown
## 검증 결과
- 대상: [파일/함수/모듈명]
- 상태: PASS / FAIL / WARN
- 이슈:
  1. [이슈 설명] (심각도: HIGH/MED/LOW)
- 권장 조치: [수정 방법]
```

### 9.3 vLLM 적합 vs Claude API 권장 검증

| vLLM 적합 (비용 0) | Claude API 권장 |
|---------------------|-----------------|
| JSON/YAML 구문 검증 | 알고리즘 정확성 증명 |
| TypeScript 컴파일 확인 | OWASP 보안 분석 |
| 코드 패턴 매칭 검색 | 성능 병목 분석 |
| 단순 단위 테스트 | 아키텍처 적합성 |
| 설정 파일 누락 키 확인 | 로직 정합성 검증 |

### 9.4 Supervisor 루프 (품질 보장)

```
1. 작업 위임 (nco_task)
2. 결과 검토 — 기준 미달 시 피드백과 함께 재위임
3. 최대 3회 반복
4. 3회 후에도 미달 → Commander가 직접 수정
```

---

## 10. Opus급 추론 구현 전략

### 10.1 Speculative Decoding

```
경량 모델(Draft) → 초안 생성 (빠름)
고성능 모델(Target) → 검증/수정 (정확)
결과: 추론 속도 3배 향상 + Opus급 정밀도 유지
```

### 10.2 Self-Correction 루프

```
모델 실행 → 에러 발생
    ↓
에러 로그 분석 (자체 판단)
    ↓
nco-vllm-restart / nco-status 자동 호출
    ↓
재시도 (가설 → 검증 → 수정 루프)
```

### 10.3 Multi-step Planning

```
복잡한 태스크 수신
    ↓
nco-plan (전략 수립)
    ↓
nco-next-parallel (작업 분할 + 병렬 실행)
    ↓
nco-metrics (결과 즉각 검증)
    ↓
nco-gap (95% 품질 루프)
```

### 10.4 장기 기억 통합

- Memory MCP 서버 연동
- 과거 작업 패턴 + 프로젝트 구조 지속 학습
- 반복적 실수 방지, 사용자 선호도 반영

---

## 부록: 빠른 시작 가이드

### vLLM + Claude Code 실행 순서

```bash
# 1. vLLM 서버 확인/시작
/nco-vllm-status
/nco-vllm-start          # 없으면 시작 (~3분)

# 2. 프록시 시작
/nco-vllm-proxy-start    # 포트 4100

# 3. vLLM Claude Code 세션 시작
ANTHROPIC_BASE_URL=http://localhost:4100 \
ANTHROPIC_API_KEY=dummy \
claude

# 4. Mesh 참여
/nco-mesh ping           # 세션 등록
/nco-mesh                # 활성 세션 확인
```

### 최적화 체크리스트

- [ ] vLLM 서버 상태 정상 (`/nco-vllm-status`)
- [ ] 프록시 연결 확인 (`api✓` 상태바)
- [ ] 프롬프트에 목표 명확히 명시
- [ ] 파일 경로 정확히 지정 (할루시네이션 방지)
- [ ] 1메시지 = 1목표 원칙 준수
- [ ] 대형 파일은 offset/limit 활용
- [ ] 검증 결과에 [TASK-RESULT] 태그 포함
- [ ] Mesh 충돌 검사 후 작업 시작

---

*본 문서는 claude-1~6의 17개 개별 문서를 통합하여 중복 제거 및 체계적으로 재구성한 종합 가이드입니다.*
