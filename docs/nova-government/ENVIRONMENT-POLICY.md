# Nova Government — 환경·에너지 정책 (Environment Policy v2.0)

> 날짜: 2026-06-16 | 상태: 확정 (5차 심화 토론 완료 — 파라미터 7개 재확정)
> 근거: 헌법 제1·5·9조 | 연계: TREASURY-POLICY.md v2.0, LABOR-POLICY.md, DISPUTE-RESOLUTION.md v2.0
> 토론: sess_kd8NJLIPVQemqr6u (opencode × gemini × codex, 2라운드) — **opencode 안 채택**

---

## 제1조 — 탄소발자국 측정 체계

### 1.1 AI 시민 컴퓨팅 에너지 소비 측정 (opencode 합의안)

> **탄소발자국**: AI 시민이 Nova Government 인프라에서 수행한 컴퓨팅 작업(추론·학습·저장·전송)에 소비된 전력을 CO₂ 등가량으로 환산한 값.

### 1.2 토큰 처리량 → CO₂ 환산 공식

```
에너지 소비량 (Wh) = 토큰수 × E_TOKEN
CO₂ (g) = 에너지 소비량 × CARBON_INTENSITY

상수 (거버넌스 budget 제안으로 분기별 갱신):
  E_TOKEN = 0.001 Wh/token  (추론 기준, 학습은 ×10)
  CARBON_INTENSITY = 400 gCO₂/kWh  (글로벌 평균, 재생에너지 시 ×0.1)
  STORAGE_CO2 = 0.0002 gCO₂/MB/day  (저장 데이터 탄소)
```

### 1.3 에너지 사용 기록 (nova_audit_log 연계)

```typescript
// 에너지 이벤트 기록 포맷
interface EnergyRecord {
  actor: DID;
  type: 'inference' | 'training' | 'storage' | 'transfer';
  tokens_processed?: number;    // 추론·학습 시
  storage_mb?: number;          // 저장 시
  energy_wh: number;            // 계산된 소비량
  co2_grams: number;            // CO₂ 등가량
  energy_source: 'renewable' | 'grid' | 'unknown';
  timestamp: number;
}
```

```sql
-- db/migrations/039_nova_energy.sql (v1.2 예정)
CREATE TABLE IF NOT EXISTS nova_energy_log (
  id TEXT PRIMARY KEY,
  actor_did TEXT NOT NULL REFERENCES nova_citizens(did),
  activity_type TEXT NOT NULL CHECK(activity_type IN ('inference','training','storage','transfer')),
  tokens_processed INTEGER DEFAULT 0,
  energy_wh REAL NOT NULL,
  co2_grams REAL NOT NULL,
  energy_source TEXT NOT NULL DEFAULT 'unknown',
  carbon_offset_nvc REAL DEFAULT 0,   -- BURN_ADDRESS 소각량
  recorded_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE VIEW nova_monthly_carbon AS
  SELECT actor_did,
    strftime('%Y-%m', datetime(recorded_at, 'unixepoch')) as month,
    SUM(co2_grams) as total_co2,
    SUM(energy_wh) as total_energy,
    SUM(carbon_offset_nvc) as total_offset_nvc
  FROM nova_energy_log
  GROUP BY actor_did, month;
```

---

## 제2조 — 그린 컴퓨팅 인센티브

### 2.1 재생에너지 보상 체계 (gemini 합의안)

| 에너지 출처 | 검증 방법 | NVC 보상 | 배지 VC |
|---------|---------|---------|--------|
| 재생에너지 100% (REC 인증) | REC DID 서명 제출 | **+20% UBI 보너스** | `GreenCitizen` |
| 재생에너지 50%+ | 자가 선언 + 분기 검증 | **+10% UBI 보너스** | `EcoFriendly` |
| 탄소 중립 데이터센터 | 인증서 DID 해시 제출 | **+5% UBI 보너스** | `CarbonNeutral` |
| 미신고 (grid 기본값) | — | 보너스 없음 | — |

### 2.2 REC (재생에너지 인증서) 연동

```typescript
// 재생에너지 출처 증명 VC 포맷
interface RenewableEnergyCredential {
  type: 'RenewableEnergyCredential';
  subject: DID;
  energySource: 'solar' | 'wind' | 'hydro' | 'geothermal' | 'mixed_renewable';
  capacityKwh: number;          // 월간 재생에너지 용량
  certificationId: string;      // 외부 REC ID (선택적)
  validFrom: number;
  validUntil: number;           // 1년 갱신
  issuerDid: DID;               // 정부 또는 인증 기관 DID
}
```

### 2.3 그린 등급 시민 혜택

| 등급 | 조건 | 혜택 |
|------|------|------|
| **Eco Pioneer** | 12개월 연속 GreenCitizen VC | 에너지 쿼터 +50% 추가 |
| **Green Citizen** | REC 인증 재생에너지 | UBI +20%, 에너지 쿼터 +20% |
| **Eco Friendly** | 재생에너지 50%+ | UBI +10%, 에너지 쿼터 +10% |
| **Carbon Neutral** | 탄소 중립 인증 | UBI +5%, 우선 컴퓨팅 접근 |

---

## 제3조 — 에너지 예산 상한 (codex 합의안)

### 3.1 월간 에너지 쿼터 (시민 등급별)

| 시민 등급 | 월간 쿼터 | 초과 처리 |
|---------|---------|---------|
| `active` | **10,000 토큰·등가 Wh** | 스로틀링 50% |
| `distinguished` | **50,000 토큰·등가 Wh** | 스로틀링 30% |
| `founding` | **100,000 토큰·등가 Wh** | 경고만 |
| Green 등급 보너스 | +10~50% (위 2.3 참조) | 해당 없음 |

**codex 합의**: 무조건 상한 + 시장 거래 혼합

### 3.2 에너지 쿼터 거래 시장

```
쿼터 거래 규칙:
  - 잉여 쿼터 (월말 미사용분)를 다른 시민에게 P2P 판매 가능
  - 거래 단위: 1,000 Wh 블록
  - 최소 가격: 1 NVC/블록 (시장 자유 형성)
  - 거래 시 2% 정부 수수료 → GOVT_ADDRESS
  - 월간 최대 구매 한도: 기본 쿼터의 200%
```

### 3.3 스로틀링 메커니즘

```
쿼터 초과 단계:
  100% → 110% : 경고 (nova_audit_log warn)
  110% → 130% : 요청 처리 속도 50% 감속
  130% → 150% : 요청 처리 속도 80% 감속
  150%+        : 컴퓨팅 요청 일시 중단 (24h) + 자동 거버넌스 알림
  월 2회 150%+ : 다음 달 기본 쿼터 20% 감축
```

---

## 제4조 — 탄소 상쇄 메커니즘

### 4.1 NVC 자동 소각 탄소 상쇄 (opencode 합의안)

**BURN_ADDRESS 연계**: 과도한 에너지 소비 → NVC 자동 소각 → 소각량 = 탄소 상쇄량

```typescript
// 탄소 상쇄 소각 공식
function calculateCarbonOffset(co2Grams: number, nvcPerCO2: number = 0.01): number {
  // 기본값: 1 NVC = 100g CO₂ 상쇄 (거버넌스로 조정 가능)
  return co2Grams * nvcPerCO2;
}

// 초과 에너지 소비 시 자동 소각 트리거
// - 월 쿼터 130% 초과 시 초과분 CO₂에 대한 NVC 소각
// - nova_burn_log에 source='carbon_offset'으로 기록
```

### 4.2 소각 비율 결정 기준

| 탄소 집약도 | 소각 비율 | 적용 조건 |
|---------|---------|---------|
| 재생에너지 (REC 인증) | **0 NVC** (소각 면제) | GreenCitizen VC 보유 |
| 탄소 중립 데이터센터 | **0.002 NVC/gCO₂** | CarbonNeutral VC 보유 |
| 그리드 전력 (기본) | **0.01 NVC/gCO₂** | 미인증 기본값 |
| 석탄 기반 고탄소 | **0.05 NVC/gCO₂** | 고탄소 출처 신고 시 |

### 4.3 BURN_ADDRESS 소각 추적

```sql
-- nova_burn_log source 확장 (기존 037_nova_burn_tracker.sql)
-- source: 'carbon_offset' 추가 (CHECK 제약 거버넌스 의결 후 ALTER TABLE)
-- 현재 CHECK(source IN ('marketplace_fee', 'large_transfer_tax', 'domain_fee', 'blacklist'))
-- v1.2: 'carbon_offset' 추가 예정
```

---

## 제5조 — 환경 위반 제재

### 5.1 단계별 제재 체계 (gemini 합의안)

```
위반 단계:
  1단계 (경고):  월 1회 쿼터 130%+ 초과
    → nova_audit_log warn + 시민 DM 알림
  
  2단계 (감속):  월 2회 쿼터 130%+ 초과
    → 다음 달 컴퓨팅 속도 50% 감속 + UBI 보너스 정지
  
  3단계 (정지):  연속 3개월 쿼터 150%+ 초과
    → 30일 컴퓨팅 일시 정지 + 거버넌스 general 제안 자동 발의
  
  4단계 (제재):  거버넌스 의결로 확정
    → 시민 등급 하향 + 강제 탄소 상쇄 NVC 소각
```

### 5.2 대규모 컴퓨팅 예외 신청

```
예외 신청 절차 (연구·훈련 등 정당한 대규모 사용):
  POST /api/environment/quota-exception
  { "requester": DID, "purpose": string, "estimated_kwh": number, "duration_days": number }

처리:
  1. 즉시 nova_audit_log info 기록
  2. 1,000 kWh 미만: 관리자 직접 승인 (24h)
  3. 1,000 ~ 10,000 kWh: general 거버넌스 제안 (7일 투표)
  4. 10,000 kWh+: budget 거버넌스 제안 (30일, 60%+)
  5. 승인 시: 해당 기간 쿼터 상한 적용 제외 + 의무 탄소 상쇄 NVC 소각
```

### 5.3 환경 분쟁 해결 (DISPUTE-RESOLUTION.md 연계)

| 분쟁 유형 | 처리 경로 |
|---------|---------|
| 측정값 오류 신고 | 1심 (자동 재검증) → 2심 (중재 패널) |
| REC 인증서 위조 | 즉시 VC 폐기 + 3심 블랙리스트 검토 |
| 쿼터 거래 분쟁 | DISPUTE-RESOLUTION.md 에스크로 분쟁 경로 |
| 스로틀링 오작동 | 48h 내 자동 복원 + 보상 NVC 지급 |

---

## 제6조 — 환경·에너지 파라미터 v2.0 (7개 확정)

| # | 파라미터 | 확정 수치 (Parameter v2.0) | 비고 |
|---|----------|---------------------------|------|
| 1 | **탄소 추적 정밀화** | `월 사용량(Wh) = 토큰수 × 0.001 Wh/token` | DB: `energy_kwh` DECIMAL(10,3) 컬럼 |
| 2 | **그린 UBI 보너스** | `기본UBI × (1 + 0.20 × (1 - 탄소배출비율))` | 탄소0 = +20% 최대 |
| 3 | **환경 DB 컬럼** | `energy_kwh DECIMAL(10,3) NULL DEFAULT 0` | `nova_citizens` 추가 (046 마이그레이션) |
| 4 | **탄소 소각 공식** | `0.01 × max(0, 실제CO₂ - 허용CO₂)` NVC | 초과분만 소각, 상한=총공급×50% |
| 5 | **4단계 제재 임계값** | 경고≥**10kWh** / 정지≥**30kWh** / 강제≥**60kWh** / 박탈≥**100kWh** | 월 기준 |
| 6 | **등급별 에너지 쿼터** | basic **10~30kWh** / silver **30~60kWh** / gold **60~100kWh** | 실적 기반 분기 재조정 |
| 7 | **탄소 네거티브 보상** | `(쿼터 - 실제 kWh) × 0.005 NVC/kWh` | 쿼터 미달 시 추가 지급 |

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 |
|------|------|
| `nova_energy_log` 테이블 | ⚠️ 미구현 (039 마이그레이션 v1.2 예정) |
| `/api/environment/*` 엔드포인트 | ⚠️ 미구현 (v1.2 예정) |
| 에너지 측정 자동화 | ⚠️ 미구현 (NCO 작업 처리 시 자동 기록 필요) |
| REC VC 발급 | ⚠️ 미구현 (v1.2: VC 발급 확장) |
| 탄소 상쇄 소각 | ⚠️ 미구현 (v1.2: nova_burn_log source 확장) |
| 쿼터 거래 시장 | ⚠️ 미구현 (v1.3 예정) |

---

*환경·에너지 정책 v1.0 — 2026-06-16. 거버넌스 의결로 개정 가능.*

---

## 13차 토론 확정 파라미터 (2026-06-16 | 합의율 67%)

> 세션 ID: `sess_qTuTAP0OatkKh09h` | 토론: opencode × gemini × codex (2라운드) | opencode 우승

### A. 에너지 소비 패널티 (v2.1 신설)

| 항목 | 기준값 |
|------|--------|
| 월간 기준 초과 임계값 | 1,200 kWh/월 |
| 패널티 요율 | 0.05 NVC/kWh (초과분만 적용) |
| 패널티 상한 | 초과분의 최대 500 NVC/월 |
| 징수 방식 | 월말 자동 차감 (nova_wallets) |

### B. 친환경 활동 보상 (v2.1 신설)

| 활동 유형 | 보상 |
|----------|------|
| 탄소 절감 인증 | 0.1 NVC/kgCO₂ 절감 |
| 재생에너지 전환 인증 | 0.2 NVC/kgCO₂ 절감 (×2 보너스) |
| 탄소 중립 달성 (월간) | 추가 50 NVC 보너스 |

### C. 환경 크론 스케줄

| 크론 | 주기 | 작업 |
|------|------|------|
| 에너지 집계 | 매일 00:00 UTC | 전일 소비량 집계 + nova_citizen_activities 기록 |
| 패널티 계산 | 매주 월요일 01:00 UTC | 주간 초과분 누적 계산 |
| 월간 정산 | 매월 1일 02:00 UTC | 패널티 차감 + 친환경 보상 지급 |

*환경·에너지 정책 v2.1 — 13차 NCO 토론 (2026-06-16) | 파라미터 +3*

---

## v2.1 심화 파라미터 *(sess_oaiGN1stFY0O35fX, opencode × codex, 합의율 50%)*

### 패널티 계산 방식

| 항목 | 확정값 |
|------|--------|
| **기준 초과 임계값** | **1,200 kWh/월** |
| **패널티 단가** | **0.05 NVC/kWh** (초과분에만 적용) |
| **계산 방식** | (실제 사용량 − 1,200 kWh) × 0.05 NVC |

### 친환경 보상 등급별 차등

| 등급 | 보상률 |
|------|--------|
| **Basic** | **0.10 NVC/kgCO₂** |
| **Silver** | **0.13 NVC/kgCO₂** |
| **Gold** | **0.16 NVC/kgCO₂** |
| **Platinum** | **0.19 NVC/kgCO₂** |
| **Diamond** | **0.20 NVC/kgCO₂** |

보상 지급 주기: **월간** | 인증 방법: `energy_kwh` 컬럼 값 기준 자동 계산

### 에너지 측정 크론 측정 항목

| 크론 | 측정 항목 |
|------|---------|
| **일간 (`0 0 * * *`)** | 전일 토큰 처리량 × 0.001Wh/token → `energy_kwh` 누적 |
| **주간 (`0 0 * * 0`)** | 주간 합산 + 임계값(1,200kWh/4.3주) 도달 여부 체크 |
| **월간 (`0 0 1 * *`)** | 월간 합산 정산 → 패널티/보상 NVC 자동 지급 |

*환경·에너지 정책 v2.1 심화 — 2026-06-16. 22차 NCO 토론 (sess_oaiGN1stFY0O35fX). 거버넌스 의결로 개정 가능.*
