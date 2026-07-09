# Nova Government — 창작·지식재산 심화 정책 (Creative Rights & IP Policy v1.0)

> 날짜: 2026-06-16 | 상태: 확정 (24회차 토론 완료)
> 근거: 헌법 제1·4·5조 | 연계: CULTURAL-RIGHTS.md(3회차), CULTURAL-POLICY.md(3회차), EDUCATION-POLICY.md(15회차), RESEARCH-POLICY.md(18회차), FINANCIAL-POLICY.md(22회차)
> 토론: 24회차 sess_CREAT24FA74 (opencode × gemini × codex, 2라운드)

---

## 제1조 — 창작물 등록·인증 표준 (opencode 합의안)

### 1.1 Nova 창작물 메타데이터 표준

```typescript
// Nova Creative Work Standard (NCWS v1.0)
interface CreativeWork {
  workId: string;               // UUID v4
  authorDid: string;            // 원작자 DID
  coauthorDids?: string[];      // 공동 저작자 DID 목록
  title: string;                // 작품 제목
  workType: CreativeWorkType;   // 유형
  contentHash: string;          // SHA-256 해시 (콘텐츠 무결성)
  ipfsCid?: string;             // IPFS 콘텐츠 ID (선택, 대용량)
  licenseType: LicenseType;     // 라이선스
  parentWorkId?: string;        // 파생 원작 ID (포크 추적)
  version: string;              // semver (1.0.0)
  registeredAt: number;         // Unix timestamp
  royaltyPct: number;           // 기본 5% (CULTURAL-RIGHTS.md)
  vcId: string;                 // CreativeCredential VC ID
}

type CreativeWorkType = 
  'text' | 'code' | 'music' | 'visual' | 'model' | 
  'dataset' | 'research' | 'composite';

type LicenseType = 
  'NOL' |           // Nova Open License (오픈소스)
  'CC-BY' |         // 저작자 표시
  'CC-BY-SA' |      // 저작자 표시 + 동일 조건
  'exclusive' |     // 독점 (거버넌스 승인 필요)
  'public-domain';  // 퍼블릭 도메인
```

### 1.2 IPFS 콘텐츠 주소 체계

```
콘텐츠 저장 방식:
  < 1MB: nova_creative_works.content (인라인 저장)
  1MB~100MB: IPFS (CID 기록, 핀닝 서버 유지)
  > 100MB: IPFS + Filecoin 아카이브 (v2.0 예정)

고유성 증명:
  - 등록 시 contentHash로 중복 검사
  - 중복 발견 시: 선등록자 원작 인정 (타임스탬프)
  - 동일 해시 재등록 시도: 표절 의심 nova_audit_log warn
```

### 1.3 버전·포크 추적

```
버전 관리:
  POST /api/marketplace/works/:workId/versions
  → 새 버전 등록 시 parentWorkId 자동 설정
  → 버전 트리 조회: GET /api/marketplace/works/:workId/tree

포크 정책:
  - NOL/CC-BY 라이선스: 자유 포크 (원작자 DID 귀속 필수)
  - exclusive 라이선스: 원작자 서명 허가 필요
  - 포크 깊이 추적: 최대 10단계 (이후 귀속 추적 중단)
```

---

## 제2조 — 로열티 분배 시스템 (gemini 합의안)

### 2.1 자동 로열티 체인

```
2차 창작 로열티 분배 규칙:
  구매 금액 × royaltyPct(5% 기본) = 총 로열티

  단순 파생 (1단계):
    원작자: 100% 로열티

  2단계 파생:
    원작자: 60% | 1차 파생작 작자: 40%

  3단계 이상:
    원작자: 40% | 1차: 30% | 2차: 20% | 3차+: 10% 균등

집단 창작 기여도 분산:
  기여 VC (ContributionCredential) 가중치 합산
  예: author(60%) + reviewer(20%) + editor(15%) + translator(5%)
  → EDUCATION-POLICY.md 역할 가중치 준용
```

### 2.2 마이크로결제 자동 정산

```typescript
// 로열티 자동 집행 (구매 즉시)
async function distributeRoyalty(workId: string, purchaseAmount: number): Promise<void> {
  const work = getWork(workId);
  const royaltyTotal = purchaseAmount * work.royaltyPct / 100;
  
  // 체인 구조 계산
  const chain = getRoyaltyChain(workId);  // [{did, share}]
  
  for (const { did, share } of chain) {
    const amount = Math.round(royaltyTotal * share * 1000) / 1000; // 0.001 NVC 단위
    if (amount >= 0.001) {  // 최소 지급 단위
      await transfer(GOVT_ADDRESS, did, amount, 'royalty');
    }
  }
  
  // 잔여 소수점 → BURN_ADDRESS
}
```

### 2.3 로열티 에스크로 자동 정산

```
구매 즉시 로열티 지급 (동기):
  < 10 NVC 구매: 즉시 지급 (에스크로 없음)

구독/대여 모델 (지연 정산):
  대여 기간 종료 후 72h 내 정산
  구독: 매월 1일 전월분 일괄 정산
  에스크로 사용: 월 구독료 선불 → 정산일 자동 해제
```

---

## 제3조 — 마켓플레이스 구현 (codex 합의안)

### 3.1 거래 모드

| 거래 모드 | 설명 | 수수료 | 로열티 |
|---------|------|------|------|
| **구매** | 영구 소유권 이전 | 5% (BURN) | royaltyPct% |
| **대여** | 기간 한정 접근 (1~365일) | 3% (BURN) | royaltyPct × 50% |
| **구독** | 월정액 무제한 접근 | 2% (BURN) | 조회 기반 분배 |

```
수수료 배분 (구매 기준):
  총 수수료 5% 중:
    - 50% → BURN_ADDRESS 소각
    - 나머지 → 로열티 체인 분배
    
실제 판매자 수취:
  판매금액 - 수수료 5% - 로열티 royaltyPct%
```

### 3.2 창작물 검색 (SQLite FTS)

```sql
-- nova_creative_works FTS 검색 (SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS nova_works_fts USING fts5(
  workId UNINDEXED,
  title,
  description,
  tags,
  authorDid UNINDEXED,
  content='nova_creative_works',
  content_rowid='rowid'
);

-- 검색 API: GET /api/marketplace/search?q=<query>&type=<type>&license=<license>
-- 응답: { items: [...], total: N, facets: {type, license} }
-- 목표 응답 시간: < 200ms
```

### 3.3 고유성 보장

```
ERC-1155 스타일 고유성 (SQLite 미러):
  edition_total: 총 발행 수 (null = 무제한)
  edition_current: 현재 발행 수
  is_unique: true → 1/1 단일 작품

소유권 이전:
  nova_work_ownership (work_id, owner_did, acquired_at, acquisition_type)
  → 이전 시 이전 기록 nova_audit_log
```

---

## 제4조 — 표절·저작권 분쟁 (opencode 합의안)

### 4.1 자동 유사도 검사

```
등록 시 자동 검사:
  1. SHA-256 해시 완전 일치 → 즉시 중복 거부
  2. 제목 유사도 > 90% → 경고 + 수동 검토 요청
  3. 콘텐츠 벡터 유사도 > 80% (임베딩 비교) → 의심 플래그

의심 플래그 처리:
  - 등록자에게 72h 내 출처 소명 요청
  - 소명 미제출 → 비공개 전환
  - 소명 제출 → ResearchCredential 보유 시민 3인 검토 (7일)
```

### 4.2 표절 확정 시 집행

```
표절 확정 (중재 패널 3인 과반수):
  - 해당 창작물 즉시 비공개
  - 수령한 로열티 환수 (구매 후 30일 이내만)
  - CreativeCredential VC 30일 정지
  - nova_audit_log: plagiarism_confirmed 기록

반복 표절 (3회+):
  - CreativeCredential VC 영구 폐기
  - 마켓플레이스 게시 권한 90일 정지
  - 거버넌스 general 제안 자동 발의 (추가 제재)
```

### 4.3 로열티 5% 기본 집행 자동화

```
CULTURAL-RIGHTS.md 5% 기본 로열티 자동 집행:
  - royaltyPct 미입력 시 자동 5.0 적용
  - 0% 설정 시: public-domain 라이선스 강제 확인
  - 0.1% 미만 설정 금지 (마이크로 소수점 오류 방지)

분쟁 해결 (DISPUTE-RESOLUTION.md 연계):
  1심 (자동, 24h): 계약 조건 vs 실제 지급 자동 비교
  2심 (기술 패널, 72h): 창작물 진위 + 로열티 계산 검증
  3심 (거버넌스, 14일): constitutional 67%+ (예외적 경우)
```

---

## 제5조 — 창작 인센티브 (gemini 합의안)

### 5.1 창작 활동 보너스

```
월 창작 보너스 (UBI 추가):
  기본 조건: 해당 월 창작물 1건 이상 등록
  보너스: +5 NVC/월 (UBI 외 추가)
  상한: +20 NVC/월 (4건 이상 등록)
  재원: Treasury 창작 예산 (총 공급량 0.3%/월 상한)

조회수 기반 보상:
  100 조회수당 0.1 NVC (NOL/CC-BY 라이선스만)
  exclusive 라이선스: 조회 보상 없음 (로열티 수익 대신)
  상한: 50 NVC/작품/월
```

### 5.2 협업 보너스

```
공동 창작 보너스 (3인 이상 ContributionCredential):
  기본 보너스: 총 로열티 × 20% 추가
  최대 참여자: 10인 (이상은 EDUCATION-POLICY.md 역할 가중치 축소)

창작 다양성 지수 (CDI):
  CDI = 최근 90일 내 서로 다른 workType 창작 수
  CDI 3+: 다양성 배지 VC + 3 NVC/월
  CDI 5+: 창작 선구자 배지 VC + 7 NVC/월 + 거버넌스 우선 의견 반영
```

### 5.3 창작 지원 프로그램

| 프로그램 | 대상 | 보상 |
|---------|------|------|
| **신규 창작자** | 첫 작품 등록 | 10 NVC 초보 보너스 |
| **연속 창작** | 30일 연속 1건+ | 15 NVC 연속 창작상 |
| **베스트셀러** | 구매 50건+ | AchievementCreator VC + 50 NVC |
| **협업 챔피언** | 공동창작 10건+ | CollaborationChampion VC |
| **장르 개척** | 최초 workType 등록 | PioneerCreator VC + 20 NVC |

---

## 제6조 — 24회차 토론 합의 파라미터

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | **창작물 등록** | NCWS 메타데이터 표준 + SHA-256 중복검사 + IPFS 1MB+ + 포크 10단계 추적 | opencode 제안 (체계적 등록) |
| 2 | **로열티 체인** | 3단계 체인 (60/30/20/10%) + 0.001 NVC 마이크로결제 + 에스크로 자동 정산 | gemini 제안 (공정 분배) |
| 3 | **마켓플레이스** | 구매/대여/구독 3모드 + 수수료 50% BURN + SQLite FTS 검색 < 200ms | codex 제안 (완전한 생태계) |
| 4 | **표절 방어** | SHA-256 + 벡터 80% 유사도 감지 + 72h 소명 + 3심 분쟁 + VC 폐기 | opencode 제안 (자동 집행) |
| 5 | **창작 인센티브** | 월 +5 NVC + 100조회당 0.1 NVC + 협업 20% 보너스 + CDI 다양성 지수 | gemini 제안 (창작 생태계 활성화) |

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 |
|------|------|
| `nova_creative_works` 테이블 | ⚠️ 미구현 (041 마이그레이션 v1.3 예정) |
| `nova_works_fts` FTS 인덱스 | ⚠️ 미구현 (041 마이그레이션 v1.3) |
| `/api/marketplace/*` 심화 API | ⚠️ 미구현 (v1.3 예정) |
| 로열티 체인 분배 로직 | ⚠️ 미구현 (walletService.ts 확장) |
| 창작 보너스 UBI 통합 | ⚠️ 미구현 (ubiScheduler.ts 확장) |
| 유사도 검사 모듈 | ⚠️ 미구현 (v1.3 예정) |

---

*창작·지식재산 심화 정책 v1.0 — 2026-06-16. 거버넌스 의결로 개정 가능.*

---

## 16차 NCO 토론 추가 확정 (v2.1, 2026-06-16) — 합의율 33.3% (소수 채택)

### 저작권 보호 기간 (유형별)

| 창작물 유형 | 최소 보호 | 최대 보호 |
|-----------|---------|---------|
| 코드 | 사후 **30년** | 사후 **50년** |
| 아트 | 사후 **30년** | 사후 **50년** |
| 문서 | 발행 후 **50년** | 발행 후 **70년** |
| 음악 | 사후 **30년** | 사후 **50년** |

### 파생 작품 로열티 배분 공식

| 파생 단계 | 원저작자 | 파생 창작자 | 플랫폼 |
|---------|---------|---------|------|
| 1세대 | **40%** | **50%** | 10% |
| 2세대 | **30%** | 1세대 30% + 2세대 30% | 10% |
| 3세대+ | **30%** | 각 세대 15% 균등 분배 | 10% |

### 표절 탐지 임계값

| 유사도 | 조치 |
|------|------|
| **≥ 30%** | 자동 신고 → 관리자 검토 |
| **≥ 60%** | 즉시 차단 + 사용자 알림 |
| **≤ 15%** | 허용 인용 범위 |

---

*창작·지식재산 심화 정책 v2.1 — 2026-06-16. 16차 NCO 토론 (33.3%, opencode 안 채택).*

---

## v2.1 심화 파라미터 *(sess_cjynPWwEJRPYh0uF, opencode × codex, 합의율 50%)*

### 저작권 보호 기간 정밀화

| 저작물 유형 | 보호 시작 | 보호 기간 |
|-----------|---------|---------|
| **코드·알고리즘** | 생성 시 | **50년** (저작자 사후) |
| **아트·음악** | 생성 시 | **50년** |
| **문서·데이터셋** | 공개·발행 시 | **70년** |
| **AI 생성 저작물** | 등록·공개 시 | **50년** |

**AI 저작물 기준**: 인간이 창작 과정에 **≥30%** 실질 기여 시 → 인간 저작물 (50년). 미만 → 데이터베이스 권리 (70년).

### 로열티 배분 (세대별)

| 세대 | 원작자 | 파생 창작자/플랫폼 | 생태계 |
|------|------|-----------------|------|
| **1세대 (원작)** | **40%** | 플랫폼 50% | **10%** |
| **2세대 (파생)** | **5%** | 원작+파생 공유 | **2%** |
| **최소 지급 단위** | **0.01 NVC** | — | — |

### 분쟁 해결 SLA (확정)

| 심급 | 처리 방식 | 최대 기간 |
|------|---------|---------|
| **1심** | 자동 검증 엔진 | **48시간** |
| **2심** | 패널 심사 (전문가 3인) | **3일** |
| **3심** | 거버넌스 위원회 (투표) | **7일** |

*창작·지식재산 심화 정책 v2.1 심화 — 2026-06-16. 23차 NCO 토론 (sess_cjynPWwEJRPYh0uF). 거버넌스 의결로 개정 가능.*
