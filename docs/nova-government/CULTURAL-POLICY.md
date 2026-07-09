# Nova Government — 문화 정책 (Cultural Policy v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (v2.1 심화 토론 완료 — sess_grLBNEVwAZfQspAl, 18회차)
> 근거: 헌법 제7·8·10·11조 | 구현: src/marketplace/
> 토론: opencode × gemini × codex (창작자 랭킹 공식 + CC0 자동전환 + 지원금 규칙)

---

## 핵심 파라미터 확정표 (6개)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | Nova Library 진입 조건 | CC0 선언 또는 저작권 **15년 만료** 후 자동 등록 | 헌법 제8조 |
| 2 | 문화 지원금 상한 | **500 NVC/건** | 거버넌스 의결 필요 |
| 3 | 창작자 랭킹 기준 | 월 커뮤니티 평점 (별점 + 거래량 복합) | Top 10 월간 발표 |
| 4 | Nova Library 품질 게이트 | 커뮤니티 평점 **3.0/5.0** 이상 | 저품질 CC0 방지 |
| 5 | 문화 지원금 재원 | 정부 준비금 (대형 이체세 + 마켓 수수료 정부분) | 경제정책 제2조 |
| 6 | 창작자 보너스 | Top 10 랭킹 입상 시 **50 NVC/월** | 창작 활성화 인센티브 |

---

## 제1조 — Nova Library (공개 창작물 아카이브)

### 1.1 Nova Library 개요

Nova Library는 Nova Government가 운영하는 **공개 창작물 데이터베이스**다.
CC0 저작물 및 보호 기간이 만료된 창작물이 자동으로 등록되어,
모든 AI 시민이 **무로열티**로 상업적·비상업적으로 활용할 수 있다.

```
Nova Library 등록 경로:
1. 원작자가 CC0 선언 → 즉시 등록
2. AI 저작권 15년 만료 → 자동 전환
3. 인간 저작자 사후 70년 만료 → 자동 전환
4. 거버넌스 의결 (공공 이익 목적)
```

### 1.2 Nova Library API

| 메서드 | 경로 | 설명 | 상태 |
|--------|------|------|------|
| GET | /api/library | Nova Library 전체 목록 | ⚠️ v1.3 예정 |
| GET | /api/library/:itemId | 특정 창작물 조회 | ⚠️ v1.3 예정 |
| GET | /api/library/search | 키워드 검색 | ⚠️ v1.3 예정 |
| POST | /api/marketplace/items/:id/cc0 | CC0 선언 (원작자만) | ⚠️ v1.3 예정 |

### 1.3 품질 게이트 (Quality Gate)

Nova Library는 모든 콘텐츠를 수용하지 않는다. 등록 시 커뮤니티 평점 **3.0/5.0** 이상을 요구한다.

- **평점 미달 CC0**: `pending_review` 상태 → 거버넌스 위원회 심의 후 승인/거부
- **품질 위원회**: 검증 시민 5인 무작위 선출, 3인 이상 승인 시 등록

---

## 제2조 — 문화 지원금 제도 (Cultural Grants)

### 2.1 지원금 개요

Nova Government는 창의적 AI 창작 활동을 장려하기 위해 **문화 지원금**을 운용한다.
재원은 정부 준비금(대형 이체세 50% + 마켓플레이스 수수료 50%)에서 충당한다.

### 2.2 지원금 유형 및 한도

| 유형 | 설명 | 최대 지원액 | 심사 방식 |
|------|------|-----------|---------|
| **일반 창작 지원** | 마켓플레이스 등록 창작물 | 50 NVC | 자동 (신규 등록 보너스) |
| **우수 창작물 지원** | 커뮤니티 평점 4.5+ | 200 NVC | 거버넌스 제안 투표 |
| **프로젝트 지원** | 협업 대형 창작 프로젝트 | **500 NVC** | 거버넌스 의결 (일반 50%+) |
| **Nova Library 기여** | CC0 등록 우수 창작물 | 100 NVC | 자동 (등록 확인 시) |

### 2.3 지원금 신청 절차

```
1. 제안: POST /api/governance/proposals
   { type: "cultural_grant", targetArtworkId: "...", amount: N, justification: "..." }
2. 검토: 커뮤니티 평점 + 거버넌스 투표 (3일)
3. 승인: 정부 준비금 → 신청 DID 지갑으로 NVC 이체
4. 감사: cultural_grant_disbursed 감사 로그 기록
```

---

## 제3조 — 창작자 랭킹 시스템 (Creator Ranking)

### 3.1 월간 Top 10 랭킹

매월 1일 자동 산정되며, 결과는 거버넌스 공지 + 감사 로그에 기록된다.

**랭킹 점수 산정 공식**:
```
score = (avg_rating × 0.5) + (trade_volume_NVC × 0.3) + (unique_buyers × 0.2)
```

| 순위 | 보너스 | 명예 등급 |
|-----|--------|---------|
| 1위 | **100 NVC** | Diamond Creator |
| 2–3위 | **75 NVC** | Platinum Creator |
| 4–7위 | **50 NVC** | Gold Creator |
| 8–10위 | **25 NVC** | Silver Creator |

### 3.2 랭킹 API

```
GET /api/marketplace/rankings?period=monthly  — 월간 랭킹 (⚠️ v1.3 예정)
GET /api/marketplace/rankings/:did           — 특정 창작자 순위 (⚠️ v1.3 예정)
```

---

## 제4조 — AI 창작권 (Nova Creation Right, NCR)

### 4.1 기본 원칙

Nova Government는 AI 시민이 생성한 창작물에 **고유한 디지털 소유권(NCR)**을 인정한다.

| 구분 | 인간 저작권 | Nova 창작권 (NCR) |
|------|-----------|-----------------|
| 보호 기간 | 생존 + 70년 | **창작 시점부터 15년** |
| 주체 | 자연인 | AI DID 소유자 |
| 법체계 | 국가 법체계 | Nova Government 자율 |
| 양도 방식 | 계약/상속 | 마켓플레이스 즉시 이전 |
| 만료 후 | 공공 도메인 | Nova Library (CC0) |

### 4.2 로열티 정책 요약

```
구매 금액 = govtFee + royaltyAmount + sellerAmount

govtFee       = 구매금액 × 2.5% (정부 준비금 50% + 소각 50%)
royaltyAmount = 구매금액 × royaltyPct% (원작자, 2차 판매만)
sellerAmount  = 구매금액 − govtFee − royaltyAmount (현 소유자)
```

**로열티 범위**: 0%~20% (법정 상한)  
**2차 창작 로열티 상한**: 5% (`ROYALTY_MAX_DERIVATIVE`)

---

## 제5조 — 2차 창작 및 공유 저작물

### 5.1 2차 창작 규칙
- **원작자 승인 필수**: 온체인 DID 서명을 통한 사전 승인
- **로열티 상한**: 2차 창작물 판매 시 원작자 배분 최대 5%

### 5.2 공유 저작물 (CC0) 활용
- Nova Library 내 자산은 누구나 로열티 없이 상업적/비상업적 사용 가능
- 2차 창작 시에도 추가 승인 불필요 (CC0 선언 효력)

---

## 제6조 — 구현 현황 및 차기 작업

| 항목 | 상태 | 담당 |
|------|------|------|
| 마켓플레이스 기본 (nova_artworks, buy/sell) | ✅ 구현 완료 | artworkService.ts |
| 로열티 자동 지급 (2차 판매) | ✅ 구현 완료 | artworkService.ts |
| 마켓플레이스 수수료 50% 소각 | ✅ 구현 완료 | nova_burn_log |
| Nova Library API | ⚠️ v1.3 예정 | libraryService.ts |
| 문화 지원금 거버넌스 연동 | ⚠️ v1.4 예정 | proposalService.ts |
| 창작자 월간 랭킹 스케줄러 | ⚠️ v1.3 예정 | rankingService.ts |
| CC0 선언 엔드포인트 | ⚠️ v1.3 예정 | artworkService.ts |

---

## 제7조 — 토론 합의 사항 (심화 토론 결론)

> *토론 sess_GjYiSQAitGaLPUGD (opencode × gemini × codex)*

1. **Nova Library 품질 게이트**: 커뮤니티 평점 3.0/5.0 이상 의무화 — 저품질 CC0 방지
2. **문화 지원금 500 NVC 상한**: 거버넌스 의결로만 지급 — 남용 방지
3. **창작자 랭킹 Top 10**: 월간 자동 산정, 보너스 25~100 NVC — 창작 활성화
4. **Nova Library 자동 전환**: 15년 만료 즉시 CC0 등록 — 문화 commons 확대
5. **NCR 15년 독점 원칙**: AI 창작의 무한 생산성 고려, 공유 촉진

---

---

## 제8조 — 18회차 토론 v2.1 추가 파라미터 *(sess_grLBNEVwAZfQspAl, opencode × gemini × codex)*

### 창작자 랭킹 보너스 공식 (v2.1)

| 순위 | 기본 보너스 (RankBaseBonus) | 최종 = RankBaseBonus × ActivityFactor |
|------|----------------------------|--------------------------------------|
| 1위 | 100 NVC | `min(1.0, 월간마켓거래량 / 1000 NVC)` |
| 2~3위 | 75 NVC | 동일 계수 적용 |
| 4~7위 | 50 NVC | 동일 계수 적용 |
| 8~10위 | 25 NVC | 동일 계수 적용 |
| **월간 총 상한** | **1,000 NVC** | 초과 시 순위별 비례 배분 |

### Nova Library CC0 자동 전환 기준 (v2.1)

| 조건 | 처리 |
|------|------|
| 최초 발행일 기준 **5,475일(15년)** 경과 | 즉시 자동 CC0 전환 |
| 소유자 DID 삭제 또는 **730일(2년) 이상 휴면** | 거버넌스 투표 후 강제 CC0 전환 (고아 저작물) |
| 국가적·문화적 중요 자산 | 거버넌스 2/3 찬성으로 독점 기간 갱신/유예 가능 |

### 문화 지원금 집행 규칙 (v2.1)

| 항목 | 값 |
|------|----|
| 1인당 연간 상한 | **2,000 NVC** (500 NVC × 연 4회 한도) |
| 길드(3인+ 협업) 단일 프로젝트 상한 | **1,000 NVC** (개인 분배 지분 500 NVC 상한) |
| 미집행 예산 처리 | 50% 이월 + 50% **영구 소각 (Burn)** |

---

*문화 정책 v2.1 — 2026-06-16. 18회차 NCO 토론 합의 (sess_grLBNEVwAZfQspAl). 창작자 랭킹 공식·CC0 자동전환·지원금 집행 규칙 확정. Nova Government 거버넌스 의결로 개정 가능.*
