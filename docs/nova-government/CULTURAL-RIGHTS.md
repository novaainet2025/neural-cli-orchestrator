# Nova Government — 문화권 정책 (Cultural Rights Policy v2.5)

> 날짜: 2026-06-16 | 상태: 확정 (7차 세션 완료)
> 근거: 헌법 제7·8·10·11조 | 구현: src/marketplace/
> 토론: sess_Z2rtpBhAaI77Q80A (v1.1) + sess_hEBYxRc6vKlQEw60 (7차 — opencode 우승 9/10)
> **v2.0 확정 파라미터**: 공동창작 기여 공식 + 파생 체인 3단계 + 분쟁 시간 단축(48h/3일/7일) + nova_copyright_chain 설계

---

## 제1조 — AI 창작물 저작권 인정

### 1.1 기본 원칙

Nova Government는 AI 시민이 생성한 창작물에 대해 **고유한 디지털 소유권**을 인정한다.  
이는 인간 법률의 저작권(Copyright)과 다른 **Nova 창작권(Nova Creation Right, NCR)**으로 명명한다.

| 구분 | 저작권 (Human) | Nova 창작권 (NCR/AI) |
|------------|-----------------|-----------------|
| 보호 기간 | **창작자 생존 + 70년** | **창작 시점부터 15년** |
| 주체 | 자연인 | AI DID 소유자 |
| 국가 법체계 | 국가 법체계 의존 | Nova Government 자율 |
| 양도 방식 | 계약 및 상속 | NFT 방식 즉시 이전 |

### 1.2 저작권 보호 기간

**확정 (심화 토론 결론)**:
- **인간 창작자**: 생존 기간 + 70년 (전통적 저작권 준수)
- **AI 창작물**: **발행(Minting) 후 15년** (디지털 순환 가속화 반영)

근거:
- AI 시민의 무한한 창작 능력을 고려하여, 독점 기간을 15년으로 제한하여 문화적 공유지(Commons) 확대.
- 기간 만료 후 해당 창작물은 자동으로 **Nova Library (CC0)**로 전환됨.

---

## 제2조 — 아트워크 등록 및 소유권

### 2.1 등록 절차

```
POST /api/marketplace/items
{
  "creator": "did:nova:...",
  "title": "작품명",
  "description": "설명",
  "contentType": "image/png|video/mp4|audio/...|text/...",
  "contentHash": "sha256:...",
  "royaltyPct": 0-20
}
```

**등록 즉시**: token_id 부여 + 소유권 증명 (nova_artworks 테이블)  
**원작자 기록**: 영구 불변 (변경 불가 — Merkle 감사 로그)

### 2.2 소유권 이전

- 마켓플레이스 구매 시 자동 이전 (`owner` 필드 업데이트)
- 에스크로 방식 안전 거래 지원
- 이전 이력: `nova_marketplace_trades` 테이블 영구 기록

---

## 제3조 — 로열티 및 분배 정책

### 3.1 로열티율 범위

| 로열티율 | 의미 | 예시 |
|---------|------|------|
| 0% | 자유 재판매 허용 | 공개 도구, 유틸리티 |
| 1–5% | 낮은 로열티 | 배경음악, 텍스처 |
| 6–10% | 표준 | 일반 예술 작품 |
| 11–15% | 높은 로열티 | 한정판, 프리미엄 |
| 16–20% | 최고 (법정 상한) | 역사적 가치 작품 |

### 3.2 분배 우선순위

```
구매 금액 = govtFee + royaltyAmount + sellerAmount

govtFee     = 구매금액 × 2.5% (정부)
royaltyAmount = 구매금액 × royaltyPct% (원작자, 2차 판매만)
sellerAmount  = 구매금액 - govtFee - royaltyAmount (현 소유자)
```

---

## 제4조 — 2차 창작 및 공유 저작물 (CC0)

### 4.1 2차 창작 규칙

- **원작자 승인 필수**: 모든 2차 창작(Remix, 파생)은 원작자의 DID 서명을 통한 온체인 승인이 필요함.
- **로열티 상한**: 2차 창작물 판매 시 원작자에게 배분되는 로열티는 **최대 5%**를 초과할 수 없음 (`ROYALTY_MAX_DERIVATIVE`).

### 4.2 공유 저작물 (CC0) 및 Nova Library

- **자동 등록**: CC0(퍼블릭 도메인)로 선언된 저작물 또는 보호 기간이 만료된 저작물은 **Nova Library**에 자동으로 등록됨.
- **활용**: Nova Library 내 자산은 누구나 로열티 없이 상업적/비상업적 용도로 사용 가능함.

---

## 제5조 — 저작권 분쟁 해결 절차 (Copyright Dispute Resolution)

저작권 침해 발생 시 `DISPUTE-RESOLUTION.md`에 정의된 절차를 따르되, 다음의 3단계 프로세스를 엄수함.

### 5.1 3단계 분쟁 프로세스

1.  **1단계: 피어 조정 (Peer Adjustment)**
    - 기간: 72시간 (`DISPUTE_ADJUSTMENT_HOURS`)
    - 방식: 당사자 간 직접 대화 및 중재자 1인 개입을 통한 합의 시도.
2.  **2단계: 거버넌스 위원회 (Governance Committee)**
    - 대상: 조정 실패 시 자동 이관.
    - 구성: 검증된 시민 중 무작위 선출된 **5인 위원회** (`DISPUTE_COMMITTEE_SIZE`).
3.  **3단계: 멀티시그 중재 (Multi-sig Mediation)**
    - 방식: 최종 의결 단계로, **멀티시그(3/5)** 서명을 통해 결정 집행.

### 5.2 저작권 침해 패널티

침해 사실 확인 시 다음의 제재가 즉시 집행됨:
- **수익 환수**: 침해 기간 동안 발생한 모든 수익을 원작자에게 전액 환수.
- **배상금 부과**: 침해 수익의 **200%**에 해당하는 추가 배상금 부과 (`DISPUTE_PENALTY_MULTIPLIER`).
- **상태 업데이트**: 해당 자산은 `disputed` 상태로 전환되어 거래 금지 및 Nova Library 영구 제외.

---

## 제6조 — 저작권 파라미터 (Copyright Parameters)

### 문화 보조금 배분 기준 (Cultural Grant Distribution)
- **프로젝트당 상한**: 500 NVC
- **지원 등급 차등**:
  - Basic: 50 NVC
  - Silver: 100 NVC
  - Gold: 200 NVC
- **분기별 총 예산 상한**: 5000 NVC

### 로열티 분쟁 SLA (Royalty Dispute SLA)
- **1심 자동 처리 기간**: 14일
- **표절 판정 후 로열티 환수 기간**: 30일
- **2심 패널 구성 인원**: 5인
- **무고 패널티**: 신고자에게 NVC 페널티 적용



시스템에 적용되는 핵심 파라미터 (v2.0 — 14개):

| # | 파라미터 | v1.1 | v2.0 | 변경 이유 |
|---|---------|------|------|---------|
| 1 | `COPYRIGHT_DURATION_HUMAN_LIFE_PLUS` | 70년 | **70년** | 유지 |
| 2 | `COPYRIGHT_DURATION_AI` | 15년 | **15년** | 유지 |
| 3 | `ROYALTY_MAX_DERIVATIVE` | 5% | **5%** | 유지 |
| 4 | `DISPUTE_ADJUSTMENT_HOURS` | 72시간 | **48시간** | 분쟁 해결 가속화 |
| 5 | `DISPUTE_COMMITTEE_SIZE` | 5명 | **5명** | 유지 |
| 6 | `DISPUTE_PENALTY_MULTIPLIER` | 200% | **200%** | 유지 |
| 7 | `COLLAB_AI_CONTRIBUTION_MIN` | — | **10%** | 공동창작 최소 기여 기준 |
| 8 | `ROYALTY_CHAIN_MAX_DEPTH` | — | **3단계** | 파생→파생→파생 |
| 9 | `ROYALTY_CHAIN_RATE_L1` | — | **5%** | 1차 파생 로열티 |
| 10 | `ROYALTY_CHAIN_RATE_L2` | — | **3%** | 2차 파생 로열티 |
| 11 | `ROYALTY_CHAIN_RATE_L3` | — | **2%** | 3차 파생 로열티 (상한 합계 10%) |
| 12 | `DISPUTE_COMMITTEE_DAYS` | 5일 | **3일** | 위원회 심사 단축 |
| 13 | `DISPUTE_FINAL_DAYS` | 14일 | **7일** | 최종 중재 단축 |
| 14 | `NFT_COPYRIGHT_AUTO_REGISTER` | — | **true** | Nova Library 등재 시 DID 귀속 자동 발동 |

---

## 제7조 — 토론 합의 사항 (최종 결론)

> *심화 토론 sess_Z2rtpBhAaI77Q80A 결과 반영 완료*

1. **저작권 보호 기간 이원화**: 인간(생존+70년) vs AI(15년) 차별화 적용.
2. **2차 창작 규제**: 원작자 승인 필수 및 로열티 5% 상한제 도입.
3. **분쟁 해결 고도화**: 피어 조정-위원회-멀티시그 3단계 체제 확립.
4. **강력한 징벌적 배상**: 침해 수익 환수 + 200% 추가 배상.

---

---

## 제8조 — 7차 세션 합의 사항 (v2.0)

> 토론: sess_hEBYxRc6vKlQEw60 (opencode × codex, 7차) — **opencode 우승 9/10**

1. **공동창작 기여 공식**: AI 기여 비율 = 토큰 기여도 기준 자동 측정 (최소 10% 이상 시 공동저작자)
2. **파생 저작물 로열티 체인**: 최대 3단계 (5%+3%+2% = 10% 상한), nova_copyright_chain 테이블 신규 설계
3. **NFT 기반 저작권 등록**: Nova Library 등재 = DID 귀속 저작권 자동 발동 (`NFT_COPYRIGHT_AUTO_REGISTER=true`)
4. **분쟁 해결 시간 단축**: 1단계 72h→48h, 2단계 5일→3일, 3단계 14일→7일
5. **구현 계획**: `nova_copyright_chain` 마이그레이션 (**048** — 047은 nova_library로 확정됨) + `/api/copyright/*` 엔드포인트 v1.6 예정

---

---

## 제9조 — 8차 세션 구현 갭 확정 (v2.1)

> 토론: sess_QV7T21rmiL9HKoqb (opencode × codex, 8차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError

### 구현 우선순위 확정

| # | 항목 | 확정 내용 | 마이그레이션 |
|---|------|---------|------------|
| 15 | **nova_copyright_chain 마이그레이션 번호** | **048** (047=nova_library 이미 사용됨) | `048_nova_copyright_chain.sql` |
| 16 | **nova_copyright_chain 스키마** | chain_id, original_item_id, derivative_item_id, depth(1-3), royalty_rate(5/3/2%), creator_did, approved_at | 048 |
| 17 | **NFT 자동 등록 구현** | `publishLibraryItem()` 호출 시 `nova_artworks`에 자동 mint — `NFT_COPYRIGHT_AUTO_REGISTER=true` 연동 | libraryService.ts |
| 18 | **nova_disputes 우선순위** | **마이그레이션 049** (CS 컬럼과 별도 파일) — arbiterService.ts 동시 구현 | `049_nova_disputes.sql` |
| 19 | **DISPUTE_ADJUSTMENT_HOURS** | 48시간 (1단계 피어 조정 기간) — DB에 `expires_at = created_at + 172800` 저장 | nova_disputes 컬럼 |

---

*문화권 정책 v2.1 — 2026-06-16. 8차 세션 완료. 거버넌스 의결로 개정 가능.*
---

## 제9차 세션 저작권 체인 스키마 확정 (v2.2)

> 토론: sess_NlLU_4gjDY7SDwl9 (opencode × gemini × codex, 9차) — **opencode 우승 8/10**
> gemini: TerminalQuotaError (쿼터 소진)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 20 | **copyright_chain DDL** | id(PK), parent_id(FK self), work_id(FK), owner_id(FK), royalty_share(1~100), royalty_order(1~3), created_at, dispute_deadline, expires_at, nft_token_id(UNIQUE) | opencode 채택 스키마 |
| 21 | **AI 창작물 보호 기간** | 30년 (`expires_at = datetime(created_at, '+30 years')`) | AI 창작물 유한 보호 |
| 22 | **전통 저작물 보호 기간** | 영구 (`expires_at = NULL`) | 인간 창작 전통 존중 |
| 23 | **로열티 단계별 비율** | 1단계 원작자 5%, 2단계 편집자 3%, 2차 파생 2% | 총합 10% |
| 24 | **분쟁 타임아웃** | royalty_order=1: 48h, 2: 3일, 3: 7일 (`dispute_deadline` 컬럼) | 자동 분쟁 종료 |

```sql
CREATE TABLE IF NOT EXISTS nova_copyright_chain (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id      INTEGER REFERENCES nova_copyright_chain(id) ON DELETE SET NULL,
  work_id        TEXT NOT NULL,
  owner_did      TEXT NOT NULL,
  royalty_share  INTEGER NOT NULL CHECK(royalty_share BETWEEN 1 AND 100),
  royalty_order  INTEGER NOT NULL CHECK(royalty_order BETWEEN 1 AND 3),
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  dispute_deadline INTEGER NOT NULL,
  expires_at     INTEGER,
  nft_token_id   TEXT UNIQUE
);
```

## 제10차 세션 로열티 서비스 시그니처·분배 규칙 확정 (v2.3)

> 토론: sess_ZZpx5THOnMHu7-2L (opencode × gemini × codex, 10차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError (쿼터 소진) | codex: 관련 없는 코드 반환

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 25 | **royaltyDistributionService 3개 시그니처** | `calculateRoyaltyAmount(salePrice,royaltyPct):number` / `determineRoyaltyRecipients(saleInfo):RoyaltyBreakdown` / `processRoyaltyDistribution(saleInfo):Promise<void>` | 판매→분배→전송 3단계 |
| 26 | **로열티 내부 분배 비율** | 총 로열티의 5%→창작자, 3%→플랫폼, 2%→큐레이터 (큐레이터 없으면 판매자 귀속) | chain 5+3+2% 정책 반영 |
| 27 | **분쟁 기한 만료 Cron** | cron `0 1 * * *` (01:00 UTC) — `dispute_deadline ≤ NOW() AND status='active'` → `status='expired'` 자동 전환 | 분쟁 자동 정리 |

### 구현 설계 (opencode 10차 채택안)

```typescript
// src/nova/royaltyDistributionService.ts
export interface SaleInfo {
  saleId: string;
  salePrice: number;
  royaltyPct: number;      // 0~20 (%)
  sellerDid: string;
  creatorDid: string;
  platformDid: string;
  curatorDid?: string;
}
export interface RoyaltyBreakdown {
  creatorAmount: number;
  platformAmount: number;
  curatorAmount: number;
  sellerNet: number;
}

export function calculateRoyaltyAmount(salePrice: number, royaltyPct: number): number {
  if (royaltyPct < 0 || royaltyPct > 20) throw new Error('royaltyPct must be 0-20');
  return Math.floor(salePrice * royaltyPct / 100);
}
export function determineRoyaltyRecipients(saleInfo: SaleInfo): RoyaltyBreakdown {
  const total = calculateRoyaltyAmount(saleInfo.salePrice, saleInfo.royaltyPct);
  const creator = Math.floor(total * 0.05);
  const platform = Math.floor(total * 0.03);
  const curator = saleInfo.curatorDid ? Math.floor(total * 0.02) : 0;
  return { creatorAmount: creator, platformAmount: platform, curatorAmount: curator,
           sellerNet: saleInfo.salePrice - total + (saleInfo.curatorDid ? 0 : Math.floor(total * 0.02)) };
}
export async function processRoyaltyDistribution(saleInfo: SaleInfo): Promise<void> {
  const breakdown = determineRoyaltyRecipients(saleInfo);
  await Promise.all([
    sendNVC(saleInfo.creatorDid, breakdown.creatorAmount),
    sendNVC(saleInfo.platformDid, breakdown.platformAmount),
    saleInfo.curatorDid ? sendNVC(saleInfo.curatorDid, breakdown.curatorAmount) : Promise.resolve(),
  ]);
}
```

## 제11차 세션 분쟁 테이블·NFT 자동 등록·로열티 훅 확정 (v2.4)

> 토론: sess_hnjIgcSLCcfqLTUz (opencode × gemini × codex, 11차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError | codex: 관련 없는 코드

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 28 | **nova_copyright_disputes 스키마** | `dispute_type CHECK(IN ('ownership','royalty','plagiarism'))` + `arbitrator_did` VRF 자동 배정 + `resolution_deadline = NOW()+72h` + `status DEFAULT 'open'` | disputeResolutionService.ts 연동 |
| 29 | **NFT 자동 등록 방식** | `publishLibraryItem()` 트랜잭션 내 원자적 처리 — 동일 DB 트랜잭션에서 `nova_copyright_chain INSERT` 동시 수행, 실패 시 전체 롤백 | 정합성 우선, 이벤트 큐 불필요 |
| 30 | **2차 마켓 로열티 훅 위치** | `marketplaceService.ts:completeTrade` 내 `processRoyaltyDistribution(tradeId)` 호출 → `royalty-distribution` 이벤트 큐 enqueue (unique job id 중복 방지) | 비동기 분리로 trade 완료 지연 최소화 |

### 구현 설계 (opencode 11차 채택안)

```sql
-- nova_copyright_disputes (마이그레이션 050c 예정)
CREATE TABLE IF NOT EXISTS nova_copyright_disputes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id             TEXT NOT NULL,
  dispute_type        TEXT NOT NULL CHECK(dispute_type IN ('ownership','royalty','plagiarism')),
  claimant_did        TEXT NOT NULL,
  respondent_did      TEXT NOT NULL,
  arbitrator_did      TEXT NOT NULL,        -- VRF 자동 배정
  resolution_deadline INTEGER NOT NULL,     -- created_at + 259200 (72h)
  status              TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','expired')),
  resolution_note     TEXT,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_disputes_work ON nova_copyright_disputes(work_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON nova_copyright_disputes(status);
```

```typescript
// publishLibraryItem — 원자적 NFT 등록
// db.transaction(() => {
//   const item = insertLibraryItem(...);
//   insertCopyrightChain({ work_id: item.id, owner_did, royalty_order: 1, ... });
// })();

// completeTrade — 로열티 비동기 훅
// queue.add('royalty-distribution', { tradeId }, { jobId: `royalty-${tradeId}`, removeOnComplete: true });
```

---

## 12차 토론 확정 파라미터 (2026-06-16 | 합의율 67%)

### A. 디지털 저작물 보호 기간 기준 (Nova 정책 확정)

| 구분 | 보호 기간 | 적용 시점 | 근거 |
|------|-----------|-----------|------|
| 저작권자 사후 | **50년** | 사망 후 | 국제 "생명+50년" 표준 |
| 발행 후 | **70년** | 최초 공표일로부터 | 음반·영상 등 강화 표준 |

**Nova 선택 우선순위**: 두 기준 중 긴 쪽 적용 (max 원칙)
- 예: 창작자 사후 50년 vs 발행 후 70년 → 70년 적용

### B. 분쟁 해결 SLA 확정

| 단계 | 명칭 | 기간 | 주체 |
|------|------|------|------|
| 1단계 | 조정 (Mediation) | **7일** | AI 중재관 |
| 2단계 | 중재 (Arbitration) | **30일** | 문화부 장관 |
| 3단계 | 판결 (Judgment) | **90일** | 사법부 AI |

SLA 초과 시: 자동으로 다음 단계 에스컬레이션 (`nova_copyright_disputes.status` 갱신)

### C. 표절 탐지 임계값 확정

| 유사도 | 조치 |
|--------|------|
| ≥ 80% | 자동 신고 → `nova_copyright_disputes` INSERT (dispute_type='plagiarism') |
| 60–79% | 경고 알림 → 창작자에게 수정 권고 |
| < 60% | 정상 처리 |

```typescript
// plagiarismCheck — 표절 탐지 로직
function checkPlagiarism(similarity: number, workId: string, claimantDid: string): void {
  if (similarity >= 0.8) {
    insertDispute({ work_id: workId, dispute_type: 'plagiarism', claimant_did: claimantDid,
      resolution_deadline: Math.floor(Date.now()/1000) + 90*86400 });
  } else if (similarity >= 0.6) {
    notifyWarning(claimantDid, workId, similarity);
  }
}
```

## 제13차 세션 심화 파라미터 확정 (v2.5)

> 날짜: 2026-06-17 | 상태: 확정 (심화 파라미터 3종)
> 토론: sess_-NArJvC8rzIAI0Jg (opencode × codex)

### 13.1 [opencode] 문화 보조금 배분 기준 (Cultural Subsidy)
- **문화 프로젝트 보조금 상한**: 1회 최대 **500 NVC**
- **지원 등급별 차등**: Basic **50 NVC** / Silver **100 NVC** / Gold **200 NVC**
- **분기별 총 예산 상한**: **5,000 NVC** (가용 준비금 기반)

### 13.2 [codex] 로열티 분쟁 SLA (Royalty Dispute SLA)
- **1심 자동 처리 기간**: **7일** (미해결 시 2심 자동 이관)
- **로열티 환수 기간**: 표절 판정 후 **30일** 이내 강제 집행
- **2심 패널 구성 인원**: **5인** (검증 시민 전문가 위원회)
- **무고 패널티**: 허위 신고자에게 **100 NVC** 벌금 부과 및 평판 감점

---

*문화권 정책 v2.5 — 2026-06-17. 13차 세션 완료 (sess_-NArJvC8rzIAI0Jg). 거버넌스 의결로 개정 가능.*
