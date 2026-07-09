# Nova Government — 거버넌스 정책 (Governance Policy v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (v2.1 심화 파라미터 확정 — sess_U2duF56xT7ImLbdV, 20회차)
> 근거: 헌법 제8·9·13조 | 구현: src/governance/
> 토론: 20차 sess_U2duF56xT7ImLbdV (opencode × gemini × codex) — 대리투표·실패패널티·긴급패스트트랙 확정

---

## 핵심 파라미터 (8개 확정 — v2.0)

| # | 파라미터 | 확정값 | 근거 |
|---|----------|--------|------|
| 1 | **QV 스테이킹 한도** | 총 공급량의 **5%** | 권력 집중 방지 (헌법 제9조) |
| 2 | **budget 제안 유형** | 투표 기간 **30일**, 통과 기준 **60%+** | 대규모 지출 신중 결정 |
| 3 | **언스테이킹 쿨다운** | **3일** | 단기 조작 방지 (vote-then-dump) |
| 4 | **최소 발의 스테이킹** | general=**10 NVC**, emergency=**50 NVC**, constitutional=**100 NVC** | 스팸 방지 |
| 5 | **정족수** | 일반 **20%**, 헌법 **33%**, 비상 **10%** | 참여율 현실 반영 |
| 6 | **QV 공식** | `weight = min(√stake, MAX_WEIGHT_CAP)` (MAX=√(공급량×5%)) | 고래 방지 상한 |
| 7 | **투표 토큰 모델** | **비소모형** — 투표 후 NVC 소각 없음 | 토큰 가치 보전 |
| 8 | **자동 실행 로직** | 통과 즉시 실행 (`POST /api/governance/proposals/:id/execute`) | v1.4 예정 |

---

## 제1조 — Quadratic Voting (QV) 설계

### 1.1 공식 (v2.0 확정)

```
weight = min(sqrt(stake_NVC), MAX_WEIGHT_CAP)
MAX_WEIGHT_CAP = sqrt(총_공급량 × 5%)   // 고래 방지 상한
```

**최소 가중치**: stake=0 → weight=1.0 (모든 활성 시민 기본 1표 보장)  
**투표 토큰 모델**: **비소모형** — 투표해도 NVC 소각 없음 (토큰 가치 보전)

| stake | √stake | cap 적용 후 (공급량 11,989 NVC 기준) |
|-------|--------|--------------------------------------|
| 0 NVC | 0 → **1.0** (최소 보장) | 1.0 |
| 10 NVC | 3.16 | 3.16 |
| 100 NVC | 10.0 | 10.0 |
| 599 NVC (최대) | 24.5 | **24.5** (MAX_WEIGHT_CAP) |
| 1,000 NVC | 31.6 → cap | **24.5** (상한 적용) |

### 1.2 구현 (src/governance/votingService.ts)

```typescript
export function calculateQuadraticWeight(stake: number, totalSupply: number): number {
  if (stake <= 0) return 1.0;
  const maxStake = totalSupply * 0.05;               // 5% 상한
  const cappedStake = Math.min(stake, maxStake);
  const cap = Math.sqrt(cappedStake);
  return Math.max(Math.sqrt(cappedStake), cap);      // MAX_WEIGHT_CAP 적용
}
```

---

## 제2조 — 제안 유형 및 투표 기간

### 2.1 제안 유형별 규격 (v2.0 — budget 유형 추가)

| 유형 | 투표 기간 | 통과 기준 | 정족수 | 최소 스테이킹 |
|------|---------|---------|--------|-------------|
| `general` | **7일** | **50%+** | 20% | **10 NVC** |
| `constitutional` | **14일** | **67%+** | 33% | **100 NVC** |
| `emergency` | **48시간** | **50%+** | 10% | **50 NVC** |
| `budget` | **30일** | **60%+** | 25% | **50 NVC** |
| `cultural` | **7일** | **50%+** | 20% | **10 NVC** |

> `budget` · `cultural` 유형은 v2.0 확정 — v1.1에서 구현 예정

### 2.2 발의 조건

1. 발의자: 활성 DID (`status='active'`, 블랙리스트 미포함)
2. 최소 스테이킹: 유형별 상이 (위 표 참조)
3. 중복 방지: 동일 타이틀 활성 제안 존재 시 거부
4. 쿨다운: 동일 발의자 24시간 내 3건 이상 발의 금지

---

## 제3조 — 정족수 (Quorum)

```typescript
export const QUORUM = {
  general:       0.20,   // 20% — 활성 시민 기준
  constitutional: 0.33,  // 33% — 헌법 개정 엄격 기준
  emergency:     0.10,   // 10% — 긴급 상황 최소 기준
  budget:        0.25,   // 25% — 대규모 지출 신중 기준
  cultural:      0.20,   // 20%
};
```

**기권(abstain)**: 정족수 계산 포함, 통과 기준에서 제외

---

## 제4조 — 스테이킹 및 언스테이킹

### 4.1 스테이킹 규칙

- **잠금**: 투표 즉시 → 제안 종료 시 자동 해제
- **쿨다운**: 제안 종료 후 **3일** 강제 잠금 (vote-then-dump 방지)
- **이중 투표 방지**: 동일 제안 1 DID 1회 투표
- **스테이킹 이자**: 없음 (MVP)

### 4.2 잠금 계산

```
available = balance - locked
locked = 스테이킹 합계 + 에스크로 잠금
```

### 4.3 쿨다운 시나리오

```
100 NVC 스테이킹으로 general 제안 투표:
1. 투표 즉시:    locked += 100 NVC
2. 7일 후 종료:  locked 유지 (3일 쿨다운 시작)
3. 쿨다운 3일 후: available += 100 NVC (완전 해제)
총 잠금 기간: 최대 10일 (투표 7일 + 쿨다운 3일)
```

---

## 제5조 — 제안 생명주기

```
DRAFT → ACTIVE(투표 중) → PASSED/REJECTED → EXECUTED/CANCELLED
                         ↓ 30일 후 자동 CANCELLED (미실행 시)
```

| 상태 | 설명 | 전환 조건 |
|------|------|---------|
| `active` | 투표 진행 중 | 제안 생성 즉시 |
| `passed` | 통과 | 투표 기간 종료 + 기준 충족 |
| `rejected` | 기각 | 투표 기간 종료 + 기준 미달 |
| `executed` | 실행 완료 | `POST /api/governance/proposals/:id/execute` |
| `cancelled` | 취소 | 발의자 요청 또는 30일 미실행 |

---

## 제6조 — 자동 실행 (Auto-Execution)

### 6.1 자동 실행 설계 (v1.4 예정)

통과된 제안은 별도 수동 트리거 없이 자동 실행된다.

```typescript
// v1.4 예정: src/governance/proposalService.ts
async function autoExecuteProposal(proposalId: string): Promise<void> {
  await fetch(`/api/governance/proposals/${proposalId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  await appendAudit({
    actor: GOVT_ADDRESS,
    action: 'governance_auto_executed',
    target: proposalId,
    metadata: { trigger: 'vote_passed' },
  });
}
```

### 6.2 현재 구현 (v1.0)

`POST /api/governance/proposals/:id/execute` — 수동 호출 방식 (자동화는 v1.4)

---

## 제7조 — 비상 정지 해제 특례

**헌법 제13조 연동**: 비상 정지 해제는 `emergency` 제안으로만 가능.

```
비상 정지 발동 → 48시간 내 emergency 제안 발의 필수
  → 48시간 투표 (정족수 10%+, 50%+ 찬성) → 자동 해제
  → 투표 실패 → 48시간 연장 (최대 3회, 총 192시간)
```

최대 비상 정지 기간: **192시간 (8일)**  
영구 정지 불가 (헌법 제13조 절대 원칙)

---

## API 엔드포인트 현황

| 메서드 | 경로 | 설명 | 상태 |
|--------|------|------|------|
| `POST` | `/api/governance/proposals` | 제안 생성 | ✅ 구현 |
| `GET` | `/api/governance/proposals` | 제안 목록 | ✅ 구현 |
| `GET` | `/api/governance/proposals/:id` | 제안 상세 | ✅ 구현 |
| `POST` | `/api/governance/proposals/:id/vote` | 투표 (QV) | ✅ 구현 |
| `POST` | `/api/governance/proposals/:id/execute` | 실행 | ✅ 구현 |
| `GET` | `/api/governance/status` | DAO 상태 | ✅ 구현 |
| `GET` | `/api/governance/proposals/:id/votes` | 투표 목록 | ✅ 구현 |

**미구현 (v1.1 예정)**:
- `budget` / `cultural` 제안 유형
- 스테이킹 한도 5% 상한 적용
- 언스테이킹 3일 쿨다운 강제

**미구현 (v1.4 예정)**:
- 자동 실행 (Auto-Execution) 로직

---

*Nova Government GOVERNANCE-POLICY.md v2.0 — 4차 NCO 토론 (2026-06-16)*
*8개 파라미터 확정: QV 5% 상한 + 비소모형 + 3일 쿨다운 + budget 제안 + 자동실행 v1.4*

---

## 14차 NCO 토론 추가 확정 (v2.1, 2026-06-16) — 합의율 70.0%

### QV 투표 한도

- **1인당 최대 투표 수: 50표** (단일 제안 기준)
- 이차 투표 비용: 50표 × √50 × cost_per_vote (기존 공식 유지)
- 목적: 극단적 집중 방지 + 소수 의견 보호

### Diamond 비상 대체 조항

- Architect Prime 부재 시: **Diamond 등급 시민 5인 합의**로 임시 의결권 행사
- 발동 조건: Architect Prime 72시간 이상 응답 없음
- 지속 기간: 최대 14일 (이후 재선출 투표 자동 개시)

### 의사정족수 (Quorum) — v2.1 개정

> ⚠️ **v2.1 변경**: 기존 v2.0 제3조의 일반 정족수 **20%** → **30%**로 상향 조정 (14차 토론 합의). 헌법 개정 33% → 67%로 강화. v2.0 제3조 수치는 이 조항으로 대체된다.

| 제안 유형 | 최소 정족수 | 이전(v2.0) |
|----------|-----------|----------|
| 일반 제안 | **30%** 이상 참여 | 20% |
| 헌법 개정 | **67%** 이상 참여 | 33% |
| 비상 조치 | Diamond 5인 (정족수 면제) | 10% |

---

*Nova Government GOVERNANCE-POLICY.md v2.1 — 14차 NCO 토론 (2026-06-16)*
*추가 3개 파라미터 확정: QV 최대 50표 + Diamond 5인 비상체제 + 30% 일반 정족수*

## v2.1 심화 파라미터 확정

### 1. 대리투표(Delegation) 체계
- 투표권 위임 허용 여부: **허용**
- 대리인 상한: **최대 3명**까지 위임 가능
- 위임 기간: **제안별** 지정 (기본 영구 위임)
- 연쇄 위임: **비허용** (1단계 위임만 허용)

### 2. 제안 실패 패널티
- 통과 실패 시 스테이킹 **전액 몰수**
- 몰수율: **100%**
- 반복 실패자 제재: **30일간 발의 금지**

### 3. 긴급 제안 패스트트랙 수치
- emergency 투표 기간: **24시간**
- 긴급 제안 최대 예산 상한: **500 NVC**
- 긴급 제안 연속 사용 제한: **월 2회**

