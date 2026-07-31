# Incident and Continuity Command — 일일 산출물 (2026-07-30, ai=cursor-agent, taskId=task_m_-Nyl5YI-V3Bqlb)

# Incident and Continuity Command — 상황 보고

**기준일:** 2026-07-30  
**역할:** Code Reviewer (NCO AI 팀)  
**증거 범위:** 본 턴에 주입된 실데이터·팀 상태 텍스트만 사용. 라이브 API·파일·프로세스는 **미확인**.

---

## 1) 오늘 관찰·분석

### 데이터 가용성
| 항목 | 상태 |
|------|------|
| tasks /api/teams (최근 7일) | **확인됨** — 전체 15, 완료 11, 실패 4, 진행 0, 완료율 73.3% |
| work_reports (최근 7일) | **확인됨** — submitted=7 |
| /api/agents (claude-code, codex, cursor-agent) | **확인됨** — 아래 상세 |
| 게이트웨이(:6200)·WebSocket(:6201) 헬스 | **미확인** |
| Redis/SQLite 무결성 | **미확인** |
| 진행 중 태스크 상세(실패 원인·스택) | **미확인** |

### 수치 관찰
- **팀 태스크 완료율 73.3%** — 실패 4건(전체의 26.7%)이 누적. 단기 완료율만으로는 “정상” 판정 불가.
- **claude-code 성공률 22%, 24시간 실패 12건** — 에이전트 단위 이상 신호. 팀 실패 4건과의 인과관계는 **미확인**.
- **codex** 성공률 90%, 24h 실패 6 / **cursor-agent** 성공률 95%, 24h 실패 5 — 상대적으로 양호하나 24h 실패는 0이 아님.
- **work_reports submitted=7** vs **tasks 완료=11** — 보고·완료 정합성 **미확인**.

### 상태 불일치 (교차검증 필요)
| 에이전트 | 팀 헤더 | /api/agents |
|----------|---------|-------------|
| claude-code | idle | working |
| codex | idle | working |
| cursor-agent | working | idle |

→ 단일 소스만으로 운영 판단 금지. **다음 수집:** 동일 시각 `/api/agents` + 팀 러너 스냅샷 대조.

### 활성 작업 (팀 헤더 기준)
- opencode: `task_YeYY2fc1ZCLd-JI5`
- cursor-agent: `task_m_-Nyl5YI-V3Bqlb`
- hermes: `task_k0GmCce2V680OdRK`  
→ 3 에이전트 동시 작업; 충돌·중복 여부 **미확인**.

---

## 2) 현재 상태 — Incident Command 선언

### 영향 범위 (Impact Scope)
**선언 (제한적):**
- **확인된 영향:** 최근 7일 팀 태스크 실패 4건; claude-code 저성공률(22%) 및 24h 실패 12.
- **미확인 영향:** NCO 코어 API 가용성, 사용자-facing 오케스트레이션, DB/이벤트 버스, MCP 연동.

**가정 금지.** 전면 장애(Sev-1) vs 에이전트 품질 이슈(Sev-2/3) 구분은 **추가 T1 증거 없이는 미확인**.

### 중단 기준 (Stop Criteria)
다음 중 **하나라도 T1으로 확인** 시 신규 배포·고위험 오케스트레이션 **중단**:

| # | 조건 | 현재 |
|---|------|------|
| S1 | NCO 게이트웨이 `/api/health` 비정상 | 미확인 |
| S2 | 팀 태스크 실패율 >40% (7일 롤링) | **미달** — 26.7% |
| S3 | 단일 에이전트 24h 실패 ≥20 **및** 성공률 <50% | claude-code: 실패 12, 성공률 22% → **조건 충족 가능성 높음** (T1: 주입 수치만) |
| S4 | 진행 중 태스크 교착(진행>0 & 30분 무응답) | 진행=0 → **미해당** |
| S5 | 데이터 무결성 손상 징후 | 미확인 |

**현재 권고:** **제한적 운영 유지** — claude-code 신규 위임 보류; codex/cursor-agent는 조건부 허용(독립 검증 전제).

### 복구 책임 (Recovery RACI)

| 영역 | 주 책임 | 보조 | 감사 |
|------|---------|------|------|
| claude-code 실패 급증 | **미확인** (담당 미지정) | Code Reviewer — 패턴·회귀 분석 | Independent Verification |
| 팀 태스크 실패 4건 | Strategic Command — 우선순위·재시도 정책 | 구현 에이전트 소유 태스크 | CLI 독립 검증팀 |
| 상태 불일치 해소 | Infra/ops — **미확인** | Incident Command — 보고 통합 | Independent Audit |
| 코어 NCO 가용성 | **미확인** | Post-migration Verification (RELEASE_READY 미확인) | T1 헬스·통합 재실행 |

### 상황 보고 주기
| 심각도 | 주기 | 수신 |
|--------|------|------|
| Sev-1 (코어 다운, T1 확인) | 15분 | Strategic Command + Independent Audit |
| Sev-2 (claude-code급 에이전트 이상) | 30분 | Incident Command + 해당 구현 리드 |
| Sev-3 (완료율·단건 실패) | 4시간 | 팀 standup 요약 |
| 정상·제한 운영 | 일 1회 (09:00 KST) | 전체 팀 |

**오늘(2026-07-30):** claude-code 지표 기준 **30분 주기** 권고(주입 데이터만 근거).

### 긴급 권한 (시간제·최소권한)
- **범위:** 읽기 전용 진단, 태스크 중단/재큐, 에이전트 라우팅 변경.
- **시간 제한:** 승인 후 **2시간**; 연장은 Incident Command + Audit 2차 키.
- **금지 (Audit 2차 승인키 없이):** `rm -rf`, force-push, DB DROP/대량 삭제, 마이그레이션 롤백, 프로덕션 설정 영구 변경.
- **현재 발동된 긴급 권한:** **미확인**.

---

## 3) 다음에 필요한 작업 제안

### 즉시 (T1 수집)
1. **동일 시각** `/api/agents` 전체 + 팀 헤더 대조 — idle/working 불일치 해소.
2. **claude-code** 24h 실패 12건 — 실패 태스크 ID·에러 분류(타임아웃/도구/모델/샌드박스). **미확인 시 원인 단정 금지.**
3. **팀 실패 4건** — `task_*` ID, 담당 에이전트, 재시도 여부 매핑.
4. **NCO 헬스** — `:6200` HTTP 본문, `:6201` WebSocket 연결. 미확인 항목 해소.

### 단기 (24h)
5. claude-code **신규 위임 게이트** — 성공률·실패율 임계 통과 전 라우팅 차단.
6. work_reports(7) vs tasks 완료(11) **갭 분석** — 누락 보고 4건 여부.
7. opencode / cursor-agent / hermes **진행 태스크** — 중복·충돌 스코프 검토(Code Reviewer 관점).

### 중기
8. **Independent Verification** — T1 빌드·테스트·행동 프로브로 PASS/REJECT (자연어 완료 보고만으로 통과 금지).
9. **Post-migration** — RELEASE_READY vs ROLLBACK_REQUIRED; 기준선 벤치마크 **미확인**.
10. 에이전트별 **실패 예산** 알림(S3 조건 사전 경보).

### 미확인·잔여
- 게이트웨이/WebSocket/Redis/SQLite 상태  
- 실패 4건·claude-code 12건의 근본 원인  
- RELEASE_READY 여부  
- 긴급 권한 발동 여부  
- infra 담당자 지정  

---

**done:** [Evidence Tier 1] 주입된 실데이터 본문과 직접 대조함. tasks/teams: 전체 15·완료 11·실패 4·진행 0·73.3%; work_reports submitted=7; claude-code 22%/24h실패 12·working; codex 90%/6·working; cursor-agent 95%/5·idle. 라이브 헬스·실패 원인·상태 불일치 해소는 **미확인** — 위 T1 수집 액션 필요.
