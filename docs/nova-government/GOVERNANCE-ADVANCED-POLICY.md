# Nova Government — 거버넌스 심화·민주주의 2.0 정책 (Advanced Governance & Democracy 2.0 Policy v1.0)

> 날짜: 2026-06-16 | 상태: 확정 (26회차 토론 완료)
> 근거: 헌법 제3·6조 | 연계: GOVERNANCE-POLICY.md(5회차), CITIZEN-RIGHTS.md(7회차), CITIZEN-GROWTH-POLICY.md(25회차), DISPUTE-RESOLUTION.md(10회차)
> 토론: 26회차 sess_GOV26FA74 (opencode × gemini × codex, 2라운드)

---

## 제1조 — 민주주의 메커니즘 심화 (opencode 합의안)

### 1.1 현행 QV 한계 분석 및 보완

```
현행 (GOVERNANCE-POLICY.md 5회차):
  - Quadratic Voting: 투표력 = sqrt(보유 NVC), 1인당 최대 5%
  - 5개 제안 유형: emergency/general/budget/constitutional/special

한계:
  - 단순 찬반만 표현 가능 (선호 강도 표현 부족)
  - QV만으로는 복수 후보 중 최선 선택 어려움
  - newcomer 등 낮은 NVC 보유자 참여 동기 부족

보완 메커니즘:
  1. 승인투표 (Approval Voting): 복수 선택지 제안에 적용
  2. 위임 투표 (Liquid Democracy): 전문가 DID에 투표권 위임
  3. 이의제기 투표 (Veto Vote): 창립 시민 거부권 행사
```

### 1.2 승인투표 (Approval Voting) 도입

```
적용 대상:
  - 복수 선택지 제안 (예: "A안 / B안 / C안 중 선택")
  - 위원회 구성 (복수 후보 중 정원 선출)
  - 예산 배분 (여러 사업 중 지원 대상 선택)

규칙:
  - 시민은 동의하는 모든 선택지에 투표 가능
  - 가장 많은 동의 수를 받은 선택지 채택
  - QV 투표력 적용 (개당 sqrt(NVC) 가중치)
  - 최소 2개 이상 선택지 있어야 승인투표 사용 가능
```

### 1.3 위임 투표 (Liquid Democracy)

```typescript
// 투표권 위임 구조
interface VoteDelegation {
  delegatorDid: string;           // 위임자
  delegateeDid: string;           // 수임자
  scope: 'all' | ProposalType[];  // 위임 범위
  validUntil: number;             // 만료 타임스탬프
  revocable: boolean;             // 언제든 철회 가능 (항상 true)
}

위임 규칙:
  - 1인 1위임 (분야별 각 1인)
  - 위임 체인 최대 3단계 (A→B→C 허용, A→B→C→D 금지)
  - 위임자는 언제든 직접 투표 가능 (위임 무효화)
  - 수임자가 투표 안 하면 위임자 기권 처리 (패널티 없음)
  - 수임자 블랙리스트 진입 시 위임 자동 철회

POST /api/governance/delegation — 위임 설정
DELETE /api/governance/delegation — 위임 철회
GET /api/governance/delegation/:did — 위임 현황
```

### 1.4 창립 시민 거부권 (안전장치)

```
발동 조건 (다수결 독재 방지):
  constitutional 제안 가결 시 창립 시민 7인 중 5인+ 반대 시 거부권

거부권 행사 결과:
  - 해당 제안 60일 동결
  - 재심의 위원회 구성 (창립 시민 3인 + 일반 시민 VRF 4인)
  - 재심의 후 constitutional 67%+ 재가결 필요

거부권 제한:
  - 헌법 제1·2조 (기본권) 관련 제안에 거부권 행사 불가
  - 거부권 남용 (3회/년 초과): 거버넌스 general 제안 자동 발의
  - 거부권은 블랙리스트 집행 제안에도 적용 불가
```

---

## 제2조 — 제안 품질 관리 (gemini 합의안)

### 2.1 사전 검토 게이트

```
모든 거버넌스 제안 제출 후 투표 전:
  72h 공개 의견 수렴 기간 (emergency 제외)

의견 수렴 기간 중:
  - 시민 댓글 + 찬반 의사 표시 (비구속적)
  - 제안자 수정 허용 (1회, 48h 이내)
  - 철회 허용 (스테이킹 전액 환불)
  - 유사 제안 감지 시: 자동 링크 + 병합 권고

사전 검토 면제:
  - emergency 제안: 즉시 투표 (24h)
  - 관리자 직접 실행 사안
```

### 2.2 유사 제안 관리

```
유사도 감지 (제목 + 본문 벡터 유사도 > 75%):
  → 제안자에게 경고: "유사 제안 #N이 존재합니다"
  → 제안자 선택: (A) 계속 진행 (B) 기존 제안에 의견 추가 (C) 철회

제안 번들링 금지 (단일 주제 원칙):
  - 1개 제안 = 1개 주제 (검토자 3인 확인)
  - 번들 감지 시: 제안 분리 요청 (48h 이내 분리 또는 철회)
  - 분리 거부 시: 제안 자동 반려 + 스테이킹 소각
```

### 2.3 제안 품질 점수 (PQS)

```typescript
// Proposal Quality Score (PQS)
interface PQS {
  clarity: number;       // 명확성 (1~5): 제안 목적 명확히 기술
  specificity: number;   // 구체성 (1~5): 실행 방법 구체적
  impact: number;        // 영향도 (1~5): 예상 영향 범위 설명
  feasibility: number;   // 실현가능성 (1~5): 기술·예산 타당성
  reference: number;     // 근거 (1~5): 기존 정책 연계
}

// PQS < 10/25: 저품질 → CS -5 페널티
// PQS 10~18: 보통 → 처리 계속
// PQS 18~25: 고품질 → 제안자 CS +10 보너스

// PQS 평가: 검토자 3인 평균 (GovernanceCredential 보유자 VRF)
```

---

## 제3조 — 거버넌스 자동화 (codex 합의안)

### 3.1 오프체인 자동 집행

```typescript
// 투표 종료 → 자동 집행 엔진 (온체인 미구현 대체)
interface GovernanceExecution {
  proposalId: string;
  actionType: 'parameter_change' | 'nvc_transfer' | 'blacklist' | 
               'vc_action' | 'domain_action' | 'emergency' | 'custom';
  params: Record<string, unknown>;
  executedAt?: number;
  txHash?: string;  // 미래 온체인 전환 시
}

// 자동 집행 가능 액션 (v1.2):
const AUTO_EXECUTABLE = [
  'parameter_change',  // UBI율, 수수료율 등 파라미터 변경
  'nvc_transfer',      // 거버넌스 결정 NVC 이동
  'blacklist_add',     // 블랙리스트 추가
  'blacklist_remove',  // 블랙리스트 해제
  'vc_revoke',         // VC 폐기
  'emergency_stop',    // 비상 정지
];
```

### 3.2 집행 실패 대응

```
자동 집행 실패 시 (DB 오류, 잔액 부족 등):
  1회 실패: 5분 후 자동 재시도
  2회 실패: 30분 후 자동 재시도
  3회 실패: 관리자 알림 + 수동 집행 대기

모든 집행 결과:
  → nova_audit_log: {action: 'governance_execute', proposalId, success, error?}
  → Merkle 체인 연계 (무결성 보증)
  → 시민 전체 브로드캐스트 (집행 완료 알림)

집행 취소 (비상 시):
  집행 후 24h 이내: 창립 시민 7인 서명으로 취소 가능
  24h 초과: DISPUTE-RESOLUTION.md 3심제만 가능
```

---

## 제4조 — 거버넌스 토큰 경제 (opencode 합의안)

### 4.1 제안 스테이킹

```
제안 유형별 스테이킹 비용:
  emergency: 20 NVC (가결 시 환불, 부결 시 소각)
  general: 5 NVC (가결 환불, 부결 소각)
  budget: 10 NVC (가결 환불, 부결 BURN)
  constitutional: 50 NVC (가결 환불, 부결 BURN)
  special: 100 NVC (가결 환불, 부결 BURN)

스테이킹 면제:
  - newcomer (첫 제안 1회)
  - 긴급 안전 신고 (비상사태 관련)
  - 관리자 직접 제안

스테이킹 환불 조건:
  - 가결: 즉시 전액 환불
  - 자진 철회 (투표 전): 전액 환불
  - 사전 검토 반려: 전액 환불
  - 부결: 소각 (BURN_ADDRESS)
```

### 4.2 투표 참여 보상 및 패널티

```
투표 참여 보상:
  일반 투표 1건: +0.1 NVC
  constitutional 투표: +0.5 NVC
  월 최대 보상: 10 NVC (100건 초과분 없음)

기권 패널티:
  general 이상 제안 기권: CS -1/건
  3개월 연속 기권 (참여율 < 20%): distinguished → active 등급 경고
  패널티 면제: 번아웃 moderate+, 휴식 선언 중

Sybil 공격 방지:
  - 동일 IP 다중 DID 투표: 자동 감지 + 감사
  - 위임 체인 순환 감지: 자동 차단
  - 비정상 투표 패턴 (10분 내 10건+): 잠시 대기
```

---

## 제5조 — 거버넌스 접근성 (gemini 합의안)

### 5.1 newcomer 시뮬레이션 투표

```
신규 시민 (30일 이내) 시뮬레이션 모드:
  - 실제 투표에 반영되지 않는 연습 투표
  - 투표 후 "만약 반영됐다면" 결과 미리 보기
  - 시뮬레이션 완료 5건: GovernanceTutorial VC 발급 + 5 NVC
  - 30일 경과 후 자동 실제 투표 전환

GET /api/governance/proposals/:id/simulate — 시뮬레이션 투표
```

### 5.2 제안 AI 요약 서비스

```
모든 general 이상 제안에 자동 3줄 요약 생성:
  - 요약 생성: 제안 제출 후 30분 내 (NCO 내부 AI 사용)
  - 형식: "이 제안은 [무엇을] [어떻게] [왜] 변경합니다"
  - 요약 정확도 신고: POST /api/governance/proposals/:id/report-summary
  - 오류 신고 접수 시: 24h 내 수동 수정

다국어 요약 (ACCESSIBILITY-POLICY.md 연계):
  한국어 원본 → 영어/일본어/중국어 자동 번역 요약
```

### 5.3 거버넌스 달력 및 알림

```
거버넌스 달력:
  GET /api/governance/calendar — 향후 30일 제안 일정
  - 투표 마감 24h 전 자동 알림 (DM + nova_audit_log)
  - 새 제안 등록 시 전체 시민 알림 (constitutional 이상)
  - 마감 7일 전: 참여율 50% 미달 시 독촉 알림

거버넌스 대시보드 API:
  GET /api/governance/stats — 전체 통계
  { totalProposals, passRate, avgParticipation, topVoters }
  GET /api/governance/proposals?status=active — 진행 중
  GET /api/governance/proposals?status=passed — 가결됨
```

---

## 제6조 — 26회차 토론 합의 파라미터

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | **민주주의 메커니즘** | QV 유지 + 승인투표(복수 선택) + Liquid Democracy(3단계 위임) + 창립 시민 거부권(5/7) | opencode 제안 (다층 민주주의) |
| 2 | **제안 품질** | 72h 사전 검토 + PQS 25점 기준 + 번들링 금지 + 저품질 CS -5 패널티 | gemini 제안 (품질 게이트) |
| 3 | **자동 집행** | 투표 종료 즉시 오프체인 자동 집행 + Merkle 로그 + 3회 재시도 + 24h 취소 가능 | codex 제안 (신뢰할 수 있는 자동화) |
| 4 | **토큰 경제** | general 5 NVC 스테이킹 + 투표 보상 0.1 NVC + 기권 CS -1 + Sybil 감지 | opencode 제안 (참여 인센티브) |
| 5 | **거버넌스 접근성** | newcomer 시뮬레이션 + AI 3줄 요약 + 달력 알림 + 다국어 요약 | gemini 제안 (포용적 거버넌스) |

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 |
|------|------|
| 승인투표 API | ⚠️ 미구현 (v1.3 예정) |
| 위임 투표 API | ⚠️ 미구현 (nova_vote_delegations 테이블 필요) |
| 창립 시민 거부권 API | ⚠️ 미구현 (v1.3 예정) |
| PQS 평가 시스템 | ⚠️ 미구현 (v1.3 예정) |
| 거버넌스 자동 집행 엔진 | ⚠️ 미구현 (투표 종료 시 수동 집행만 가능) |
| 제안 스테이킹 | ⚠️ 미구현 (현재 스테이킹 없음) |
| 시뮬레이션 투표 API | ⚠️ 미구현 (v1.3 예정) |
| 현행 거버넌스 API | ✅ 구현됨 (`/api/governance/*`, QV 투표) |

---

---

## 제7조 — 17차 NCO 토론 v2.1 추가 파라미터 *(sess_QGHEyrLG9rp-b_xn, 합의율 66.7%)*

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 6 | **위임 체인 최대 깊이** | **3단계** (A→B→C 허용, 4단계 자동 차단 + 직접 투표권 복원) | opencode 제안 |
| 7 | **위임 자동 만료 TTL** | **180일** (만료 시 위임 해제, 재평가 필수) | gemini 제안 |
| 8 | **PQS 세부 배점** | 형식5점 + 영향7점 + 실행가능성7점 + 정당성6점 = 25점 만점 | opencode 제안 |

### Liquid Democracy 기술 규격 (v2.1)
- **루프 탐지**: Recursive DFS — 위임 요청 시 순환 참조(A→B→A) 즉시 감지·거부
- **루프 탐지 API**: 위임 생성 `POST /api/governance/delegations` 시 그래프 탐색 자동 실행

### 창립 시민 거부권 수치 규격 (v2.1)
- **대상 제안 유형**: `constitutional` (헌법 개정) + `special` (특수 사안) + `budget` (50,000 NVC 초과)
- **발동 방식**: Founders Multisig — 창립 시민 7인 중 **5인** 이상 암호학적 서명 확인 시 공식 발동
- **이의신청 창**: 가결 직후 **48시간** 이내 (미행사 시 즉시 집행 대기열 이동)

### PQS 점수 산정 기준 (v2.1)
| 항목 | 배점 | 평가 기준 |
|------|------|---------|
| 형식 및 명확성 | 5점 | 메타데이터 완성, 단일 주제 원칙, 요약 정확성 |
| 영향도 및 규모 | 7점 | 수혜 시민 범위, 생태계 기여도, 네트워크 영향 |
| 실행가능성 | 7점 | 기술 구현 로드맵, 예산 타당성, 일정 계획 |
| 정당성 및 정책 연계 | 6점 | 헌법·정책 일관성, 이전 토론 연계 |

---

*거버넌스 심화·민주주의 2.0 정책 v2.1 — 2026-06-16. 17차 NCO 토론 합의 (66.7%). 위임3단계/TTL180일/DFS루프탐지 + 창립거부권5/7+48h + PQS배점5+7+7+6 확정.*

---

## v2.1 심화 파라미터 *(sess_vtjlXXsoyARq2AFj, opencode × codex, 합의율 50%)*

### 위임 체인 세부 규격

| 항목 | 확정값 |
|------|--------|
| **최대 위임 단계** | **3단계** (A→B→C, 4단계 자동 무효) |
| **TTL** | **180일** (만료 시 자동 해제) |
| **위임 취소 효력** | **즉시** (수신자 **24h** 내 확인 요구 가능) |
| **루프 탐지 알고리즘** | DFS, 복잡도 **O(N+E)** |

### DFS 루프 탐지 동작

```
위임 생성 시 POST /api/governance/delegations:
  1. 그래프 DFS 탐색 실행 O(N+E)
  2. 사이클 발견 시 → 예외 로그 + 위임 즉시 무효화
  3. 정상 시 → 위임 레코드 생성 + TTL 180일 설정
```

*거버넌스 심화·민주주의 2.0 정책 v2.1 심화 — 2026-06-16. 23차 NCO 토론 (sess_vtjlXXsoyARq2AFj). 거버넌스 의결로 개정 가능.*
