# 리서치 기획·전략팀 — 일일 산출물 (2026-07-24, ai=claude-code, taskId=task_jKyR76jGeweQMSxk)

# 2026-07-24 리서치 기획·전략팀 — 일일 분석 및 리서치 설계

---

## 1. 데이터 관찰·분석 (근거: 주입된 실데이터만 사용)

**A. 데이터 불일치 발견 (2곳)**

| 항목 | [tasks] | [/api/teams] | 판정 |
|------|---------|-------------|------|
| 실패 | 9 | 8 | **불일치** — 동일 기간(7일)인데 1 차이 |
| 진행 | 0 | 0 | 일치 |
| 완료율 | 65.4% | 65.4% | 일치 (17/26 = 65.38%) |
| 대기 | (없음) | 1 | **불일치** — [tasks]에 pending 필드 누락 |

→ `/api/teams`의 `실패=8 + 대기=1 = 9`이므로, [tasks]의 실패=9는 pending을 실패에 포함했을 가능성. **확인 필요**: 두 엔드포인트의 `실패` 집계 조건 차이.

**B. Agent 데이터와 팀 aggregate의 괴리**

- 팀 태스크 누계 = 26건
- claude-code 개인 태스크 누계 = 1,238건
- opencode = 2,034건
- nvidia = 364건

→ **팀 aggregate(26건)는 전체 태스크의 극히 일부** (필터링된 뷰 또는 특정 채널/기간 한정). 어느 시간 범위에 해당하는지 실데이터에 명시 안 됨.

**C. Agent 세션 상태 불일치**

- Team 섹션에서 `opencode: working (working on: task_jKyR76jGeweQMSxk)`  
- `/api/agents`에서 `opencode: 상태=idle`

→ **두 데이터 소스의 상태 정의 차이** 또는 polling 시점 차이. `/api/agents`가 최신 우선.

**D. work_reports: 4건/7일**

- 평균 0.57건/일. 팀 규모(9개 에이전트) 대비 현저히 낮음. 보고 의무 준수율 측정 필요.

---

## 2. 리서치 질문 정의 — MECE 분해

**핵심 연구 질문 (RQ0):** *NCO 팀의 태스크 완료율 65.4%를 85%+로 끌어올리기 위해 어떤 개입이 효과적인가?*

### MECE 분해

```
RQ0: 완료율 65.4% → 85%+ 개선 전략
├── RQ1: 실패 원인 분석
│   ├── RQ1.1: 에이전트별 실패율 분포는? (claude-code 65% 실패 vs opencode 27% 실패)
│   ├── RQ1.2: 실패의 공통 패턴(타임아웃·포맷·의존성)은?
│   └── RQ1.3: 실패 태스크 8-9건 중 재시도 가능/완료된 비율은?
├── RQ2: 보고 체계 분석
│   ├── RQ2.1: work_report 4건/7일 — 준수율 실제값과 병목은?
│   └── RQ2.2: work_report 미제출 태스크의 완료율 차이는?
├── RQ3: 에이전트별 역량 차이 분석
│   ├── RQ3.1: claude-code 성공률 35%의 근본 원인은? (모델·프롬프트·빈도)
│   └── RQ3.2: opencode(73%)·nvidia(73%)의 모범 사례 일반화 가능성?
└── RQ4: 데이터 인프라 분석
    ├── RQ4.1: [tasks]와 [/api/teams] 불일치의 근본 원인은?
    └── RQ4.2: 태스크 26건 aggregate의 시간 범위와 필터 조건은?
```

---

## 3. 가설 (Hypotheses)

| ID | 가설 | 근거 | 반증 기준 |
|----|------|------|----------|
| H1 | claude-code의 낮은 성공률(35%)이 팀 전체 완료율을 10%p 이상 끌어내림 | claude-code 24h실패=12, 타 에이전트 대비 4-5배 | claude-code 제외 시 완료율 70%+ 미만이면 기각 |
| H2 | work_report 미제출 태스크의 완료율이 제출 태스크보다 20%p 낮음 | 보고=모니터링=조기 개입의 가설 | 데이터 수집 후 χ² 검정 |
| H3 | 실패 태스크 중 40% 이상이 타임아웃/자원 한계가 원인 | NCO 에이전트의 CircuitBreaker·ResourceLimiter 존재 | 실패 사유 분류 후 40% 미만이면 기각 |
| H4 | [tasks]와 [/api/teams]의 실패 수 차이는 pending 상태 분류 오류 | 9-8=1, [/api/teams]에 pending=1 | 실제 DB 쿼리로 status='pending' 건수 확인 |

---

## 4. 성공 기준 (Success Criteria)

1. **RQ1 (원인 분석)**: 각 실패 태스크의 1차 원인 코드(Timeout / FormatMismatch / Dependency / Auth)가 분류되어, 원인별 구성비 도출
2. **RQ2 (보고 체계)**: work_report 제출률 목표치(예: 80%) 대비 현재 4건/26건=15.4%의 Gap 정량화
3. **RQ3 (역량 차이)**: claude-code 35% vs opencode 73%의 통계적 유의성 검증 (최소 100건 샘플 필요 — 현재 26건으로 불충분)
4. **RQ4 (데이터 인프라)**: 두 엔드포인트 불일치의 근본 원인이 코드 버그인지 집계 조건 차이인지 판정

---

## 5. 미확인/데이터 Gap (명시적 보고)

| 항목 | 상태 | 해결 방법 |
|------|------|----------|
| 실패 태스크 상세 사유 | **미확인** — 주입 데이터에 실패 이유 없음 | `/api/tasks?status=failed` 호출 |
| 26건 aggregate의 시간 범위 | **미확인** — "최근 7일"이라고 하나 agent 개인 태스크 1000+건과 불일치 | DB 쿼리 또는 API 문서 확인 |
| claude-code 'idle' vs Team 섹션 상태 | **미확인** — 두 소스 불일치 | `/api/agents/claude-code` 상세 호출 |
| 작업 유형 분포 (bugfix/feature/research) | **미확인** — 실데이터에 없음 | `/api/tasks?groupBy=type` |
| 에이전트별 평균 처리 시간 | **미확인** — 실데이터에 없음 | `/api/tasks?groupBy=agent&measure=duration` |
| work_report 품질(서식/근거 포함률) | **미확인** — 건수만 있음 | work_report 4건 본문 수집 |

---

## 6. 탐색수집팀 핸드오프

**수집 우선순위:**

```
P0 (차단 해소):
  GET /api/tasks?status=failed&days=7 → 실패 사유 배열 추출
  GET /api/tasks?days=7 → 전체 태스크 메타 (created_at, agent_id, type, duration)
  GET /api/agents/claude-code → 상세 상태 및 최근 실패 로그
  
P1 (가설 검증):
  GET /api/work_reports?days=7 → 4건 본문 수집 (서식 준수 여부 코딩)
  GET /api/agents/opencode → 상세 (모범사례)
  GET /api/agents/nvidia → 상세
  
P2 (인프라):
  DB 직접 쿼리: SELECT status, count(*) FROM tasks GROUP BY status
  DB 직접 쿼리: SELECT endpoint, count_logic FROM api_logs WHERE mismatch_detected=1
```

**수집 방법론:**
- 각 API 호출 시 `curl -s http://localhost:6200{path}` — T1(HTTP 본문) 수집
- 응답 JSON에서 필요한 필드만 추출해 구조화
- 2개 이상 endpoint에서 동일 데이터 요청 시 timestamp 기록 (불일치 원인 추적)

---

**Status:** 리서치 설계 완료. Discussion Lead에 회람 후 P0 수집 Queue로 전달 대기.
