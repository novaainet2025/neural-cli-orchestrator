# Nova Government — 분쟁 해결 정책 (Dispute Resolution Policy v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (v2.1 심화 토론 완료 — sess_bQBdd42lbgYttUsJ, 18회차)
> 근거: 헌법 제4·7·9조 | 구현: src/economy/escrowService.ts, src/governance/
> 토론: opencode × gemini × codex (SLA 72h + 항소보증금 10% + 통계 공개 공식)

---

## 핵심 파라미터 확정표 (7개)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | 에스크로 분쟁 대기 | **72시간** | 피어 조정 기회 보장 |
| 2 | 중재자 응답 기한 | **48시간** | 신속 해결 (Golden Time) |
| 3 | 1심 신청 수수료 | **1 NVC** | 스팸 방지 최소 비용 |
| 4 | 조정 비용 | **거래액 1%** (최소 5 NVC, 최대 100 NVC) | 비례 원칙 |
| 5 | 2심 항소 공탁금 | **10 NVC** | 남소 방지 |
| 6 | 최종심 통과 임계치 | **67%+** | 헌법적 결정 고도 합의 |
| 7 | 보복 행위 금지 기간 | 분쟁 신고 후 **30일** | 신고자 보호 |

---

## 제1조 — 분쟁 유형별 관할

### 1.1 분쟁 유형 분류

| 분쟁 유형 | 관할 기관 | 해결 방식 | 1심 기간 |
|---------|---------|---------|---------|
| **경제 — 에스크로 분쟁** | 자동 중재 시스템 | 72시간 대기 → 중재자 배정 | 72h + 7일 |
| **경제 — 이중지불 의혹** | 관리자 + 감사 로그 | Merkle 체인 검증 | 24시간 |
| **도메인 스쿼팅** | 검증 시민 중재자 패널 | 3인 패널 다수결 | 7일 |
| **저작권 침해** | 검증 시민 중재자 패널 | 3인 패널 + 증거 제출 | 14일 |
| **거버넌스 이의신청** | 거버넌스 제안 | `general` 제안 투표 (7일) | 7일 |
| **시민권 박탈 이의** | 거버넌스 제안 | `constitutional` 제안 (14일) | 14일 |

### 1.2 관할 우선순위

```
자동 판정 → 중재자 패널 1심 → 거버넌스 2심 → constitutional 최종심
```

---

## 제2조 — nova_disputes 테이블 (v1.1 신규)

### 2.1 DB 스키마

```sql
CREATE TABLE IF NOT EXISTS nova_disputes (
  dispute_id    TEXT PRIMARY KEY,
  dispute_type  TEXT NOT NULL,    -- 'escrow'|'copyright'|'domain'|'citizenship'
  status        TEXT NOT NULL DEFAULT 'open',
                                  -- 'open'|'mediation'|'voting'|'resolved'|'appealed'
  plaintiff_did TEXT NOT NULL REFERENCES nova_citizens(did),
  defendant_did TEXT NOT NULL REFERENCES nova_citizens(did),
  ref_id        TEXT,             -- escrow_id, artwork_id, domain_name 등
  amount_nvc    REAL,             -- 분쟁 금액 (있는 경우)
  fee_nvc       REAL,             -- 조정 비용 (1%, min 5, max 100)
  arbitrator_1  TEXT REFERENCES nova_citizens(did),
  arbitrator_2  TEXT REFERENCES nova_citizens(did),
  arbitrator_3  TEXT REFERENCES nova_citizens(did),
  verdict       TEXT,             -- 'plaintiff'|'defendant'|'split'
  verdict_at    INTEGER,
  appeal_deadline INTEGER,        -- verdict_at + 72h
  expires_at    INTEGER,          -- 자동 종료 타이머
  evidence      TEXT,             -- JSON array
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER
);
```

### 2.2 조정 비용 계산 (codex 구현 기준)

```typescript
function calcDisputeFee(amountNvc: number): number {
  const fee = amountNvc * 0.01;  // 1%
  return Math.min(Math.max(fee, 5), 100);  // min 5 NVC, max 100 NVC
}
```

---

## 제3조 — 중재자 자동 배정 (opencode 설계)

### 3.1 중재자 자격 요건

| 요건 | 기준 |
|-----|------|
| 시민 등급 | `silver` 이상 (Level 1 KYC) |
| 활동 기간 | 등록 후 30일 이상 |
| 거버넌스 참여 | 최소 1회 투표 이력 |
| 활동 임기 | 90일 (1개 시즌, 갱신 가능) |
| 이해충돌 방지 | 최근 30일 내 당사자와 거래 기록 없음 |
| 자발적 등록 | `POST /api/governance/arbitrators` |

### 3.2 VRF 기반 무작위 배정

```typescript
// arbiterService.ts (v1.1 신규)
async function assignArbitrators(disputeId: string, disputeType: string): Promise<string[]> {
  // 1. 자격 있는 중재자 풀 조회 (이해충돌 제외)
  const pool = db.prepare(`
    SELECT a.citizen_did FROM nova_arbitrators a
    JOIN nova_citizens c ON a.citizen_did = c.did
    WHERE c.grade IN ('silver', 'gold', 'platinum', 'diamond')
      AND c.status = 'active'
      AND a.citizen_did NOT IN (
        SELECT plaintiff_did FROM nova_disputes WHERE dispute_id = ?
        UNION
        SELECT defendant_did FROM nova_disputes WHERE dispute_id = ?
      )
    ORDER BY RANDOM() LIMIT 3
  `).all(disputeId, disputeId);
  
  // 2. 분쟁 유형별 전문성 가중치 적용 (추후)
  return pool.map(r => r.citizen_did);
}
```

### 3.3 기피 신청 (각 당사자 1회)

```
분쟁 신청 → 3인 무작위 배정
→ 기피 신청 기간: 배정 후 48시간
→ 당사자 각 1명 기피 가능 (사유 불요)
→ 기피된 자리는 자동 재추첨
→ 최종 3인 확정 → verdict_at 48h 후 타이머 시작
```

### 3.4 중재자 보상 및 패널티

| 상황 | 결과 |
|-----|------|
| 정상 참여 (기한 내 판정) | 판정료 5 NVC (신청자 부담) |
| 무응답 (48시간 초과) | 패널티 2 NVC 차감 + 패널 교체 |
| 이해충돌 미신고 후 적발 | 중재자 자격 박탈 + `general` 제안 |

---

## 제4조 — 에스크로 분쟁 자동화

### 4.1 에스크로 분쟁 타임라인

```
에스크로 생성 → 이행 기한(설정값)
  ├─ 기한 전 완료: 양측 확인 → 에스크로 해제 ✅
  ├─ 기한 초과: 자동 분쟁 상태 (nova_disputes INSERT)
  │    → 72시간 자동 조정 대기 (setTimeout 기반 타이머)
  │    ├─ 양측 합의: 분쟁 취소, 합의 비율로 해제
  │    └─ 합의 실패: 중재자 3인 자동 배정 → 판정 (7일)
  └─ 구매자 거부: 즉시 분쟁 신청 가능
```

### 4.2 에스크로 분쟁 API

| 메서드 | 경로 | 설명 | 상태 |
|--------|------|------|------|
| `POST` | `/api/economy/escrow/:id/dispute` | 분쟁 신청 | ✅ 구현 |
| `POST` | `/api/economy/escrow/:id/resolve` | 합의 해결 | ✅ 구현 |
| `GET` | `/api/economy/escrow/:id/status` | 에스크로 상태 | ✅ 구현 |
| `POST` | `/api/governance/disputes` | 중재자 패널 배정 | ⚠️ v1.1 예정 |
| `POST` | `/api/governance/disputes/:id/verdict` | 판정 제출 | ⚠️ v1.1 예정 |
| `GET` | `/api/governance/arbitrators` | 중재자 풀 조회 | ⚠️ v1.1 예정 |

---

## 제5조 — 항소 절차 (3심제)

### 5.1 심급별 규격

| 심급 | 기관 | 비용 | 기간 | 통과 기준 |
|-----|------|------|------|---------|
| **1심** | 중재자 패널 (3인) | 1 NVC + 조정비용 | 7-14일 | 패널 2/3 다수결 |
| **2심** | 거버넌스 `general` 제안 | 10 NVC 공탁 | 7일 투표 | 50%+ |
| **최종심** | 거버넌스 `constitutional` | 100 NVC 공탁 | 14일 투표 | 67%+ |

**항소 기간**: 판정 통보 후 **72시간** 이내 (초과 시 자동 확정)

**항소 제한**:
- 동일 분쟁 최대 3심
- 패소 측 항소 비용 부담 (승소 시 환급)
- 최종심 결정은 불복 불가 (헌법 제7조)

---

## 제6조 — 제재 및 집행

### 6.1 자동 집행 및 보상

- **자동 집행**: 판정 확정 즉시 에스크로 자금 해제, 도메인 소유권 이전
- **승소자 보수**: 경제 분쟁 승소 시 분쟁 금액의 10%를 패소자로부터 지급
- **불이행 제재**: 판정 후 7일 내 미이행 시 DID 블랙리스트 + 거버넌스 제안

### 6.2 불이행 에스컬레이션

| 단계 | 조건 | 조치 |
|-----|------|------|
| 1단계 | 판정 후 48시간 미이행 | 감사 로그 warning + 알림 |
| 2단계 | 72시간 미이행 | 지갑 잔액 동결 (판정 금액만큼) |
| 3단계 | 7일 미이행 | 블랙리스트 추가 + `emergency` 거버넌스 제안 |

### 6.3 보복 행위 금지 (신고자 보호)

- 분쟁 신고 후 **30일간** 상대방의 신고자 대상 거래 제한 조치 금지
- 보복 분쟁 신청 탐지 시 (`RETALIATION_WINDOW=30일`) 자동 기각 + 패널티
- `escrow_disputed`, `domain_disputed` 감사 로그에 보복 여부 플래그 포함

---

## 제7조 — 토론 합의 사항 (심화 토론 결론)

> *토론 sess_vK5lmaRooq4yKYMg (opencode × codex)*

1. **nova_disputes 테이블 신설**: 분쟁 전용 DB 스키마 — 유형/기간/중재자/비용 일원 관리
2. **중재자 자동 배정**: VRF 기반 무작위 3인 + 이해충돌 자동 제외
3. **타이머 기반 자동 처리**: `setTimeout` + expires_at — 기간 초과 시 자동 판정
4. **조정 비용 1% 비례**: 최소 5 NVC ~ 최대 100 NVC — 소액 남소 방지 + 대형 분쟁 적정 수준
5. **보복 행위 30일 차단**: 신고자 보호 원칙 확립
6. **3심제 유지**: 1심(패널) → 2심(general) → 최종심(constitutional 67%+)
7. **v1.1 구현 우선순위**: `nova_disputes` 테이블 + `arbiterService.ts` + `/api/governance/disputes`

---

---

## 제8조 — 18회차 토론 v2.1 추가 파라미터 *(sess_bQBdd42lbgYttUsJ, opencode × gemini × codex)*

### 자동 판정 SLA (v2.1)

| 상황 | 파라미터 | 값 |
|------|----------|-----|
| 중재자 자동 판정 시한 | `ARBITRATION_AUTO_TIMEOUT` | **72시간** |
| 패널 Quorum | 필수 동의 | **2/3 이상** (3인 중 2인) |
| 무응답 대체 중재자 | 자동 재지명 | 신뢰점수 차순위 중재자 + **48h** 응답 기한 |
| 연속 2회 재지명 실패 | 패널 전체 재구성 | 새 3인 풀 + 자동 판정 시한 **48h로 단축** |

### 항소 보증금 제도 (v2.1)

| 항목 | 값 |
|------|----|
| 기본 보증금 | 원 심판 금액의 **10%** (최소 5 NVC / 최대 200 NVC) |
| 패소 시 처리 | 보증금 **100% 몰수** |
| Diamond 시민 감면 | **50% 감면** → 5% of 원 심판 금액 |
| 항소 성공 시 | 보증금 **전액 반환** |
| 행정 수수료 | 별도 **2%** (최대 20 NVC, 보증금과 별도) |

### 분쟁 통계 공개 기준 (v2.1)

| 항목 | 값 |
|------|----|
| 승률 공개 주기 | **매월 첫째 월요일 09:00 UTC** (PDF + JSON) |
| 중재자 성과 공식 | `score = 해결률×0.5 + 만족도×0.3 + SLA준수×0.2` |
| 성과 공개 주기 | **분기별** (상위 10% 인센티브 지급 가능) |

---

*분쟁 해결 정책 v2.1 — 2026-06-16. 18회차 NCO 토론 합의. SLA 72h·항소보증금 10%(Diamond 5%)·통계공식 확정. Nova Government 거버넌스 의결로 개정 가능.*
