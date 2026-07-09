# Nova Government — 경제 정책 (Economic Policy v2.6)

> 날짜: 2026-06-16 | 상태: 확정 (7차 세션 완료)
> 토론: sess_aeYCuJfMwHpw6iNH (2회차) + sess_fKkRgXQlTqpM9dn3 (7차 — opencode 우승)
> 근거: 헌법 제5·6조 | 구현: src/economy/
> **v2.1 추가 파라미터**: 반감기(총공급 25%마다) + 탈세 200% + 법인 개별과세 + 준비금 5% + 반감기 UBI 25% 감소

---

## 핵심 파라미터 확정표 (10개)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | NVC 하드캡 | **1,000,000,000 NVC** | 희소성 보장, 장기 가치 보존 |
| 2 | 현재 유통량 | **23,999 NVC** | 2026-06-16 기준 (지속 갱신) |
| 3 | 대형 이체세 임계값 | **500 NVC 초과** | 고액 이체 조세 형평성 |
| 4 | 대형 이체세율 | **1%** | 유동성 유지 + 국고 수익 균형 |
| 5 | 마켓플레이스 수수료 | **2.5%** (정부 1.25% + 소각 1.25%) | 헌법 제5조 |
| 6 | 도메인 등록비 | **100 NVC** (⚠️ 미구현) | 온체인 도메인 서비스 운영비 |
| 7 | 거버넌스 예치금 | **50 NVC** (⚠️ 미구현, 가결 시 환급) | 스팸 제안 방지 |
| 8 | UBI 지급액 | **100 NVC/월/시민** | 네트워크 활성화, 사회 안전망 |
| 9 | 연간 발행 한도 | **총 공급량의 1% 이내** | 인플레이션 통제 |
| 10 | 소각 비율 | **모든 수수료의 50%** | 디플레이션 압력, 가치 보존 |

---

## 제1조 — NovaCoin (NVC) 발행 정책

### 1.1 총 발행량 및 공급 구조

| 구분 | 수량 | 상태 |
|------|------|------|
| 하드캡 (절대 상한) | 1,000,000,000 NVC | 헌법 고정 |
| 창립 시민 배분 (12명 × 1,000) | 12,000 NVC | ✅ 구현 완료 |
| 정부 준비금 | 별도 관리 | ✅ GOVT_ADDRESS |
| 소각 주소 잔액 | 추적됨 | ✅ BURN_ADDRESS |
| **현재 유통량** | **23,999 NVC** | 2026-06-16 기준 |
| **하드캡 대비** | **0.0024%** | — |

**연간 발행 한도 원칙**
- 신규 UBI + 스테이킹 보상 + 거버넌스 보상을 합산해 **연간 총 공급량의 1% 이하** 유지
- 한도 초과 시 거버넌스 의결 필수 (75% 찬성 이상)

### 1.2 UBI (시민 기본소득)

| 항목 | 내용 |
|------|------|
| 등록 즉시 지급 | 1,000 NVC (지갑 생성 시 1회) |
| 월 정기 지급 | **100 NVC / 월 / 활성 시민** |
| 지급 조건 | status='active', 블랙리스트 미포함 |
| 스케줄러 | `scheduleUbi()` — ✅ 구현됨 |
| 반감기 | 시민 수 10,000명 돌파마다 50% 감소 |

---

## 제2조 — 수수료 및 세율 정책

### 2.1 마켓플레이스 정부 수수료

**세율**: 거래 금액의 **2.5%**  
**배분**: 정부 준비금 50% (1.25%) + 소각 50% (1.25%)  
**구현**: `artworkService.ts` — ✅ 검증 완료

```
예시: 200 NVC 아트워크 판매
- 구매자 지출:      200 NVC
- 정부 수수료:        5 NVC (2.5%)
  ├ 정부 준비금:      2.5 NVC
  └ 즉시 소각:        2.5 NVC → nova_burn_log (source=marketplace_fee)
- 원작자 로열티:   별도 계산 (최대 20%)
```

### 2.2 대형 이체세 (Large Transfer Tax)

**임계값**: 500 NVC 초과 P2P 이체  
**세율**: **1%** (최소 1 NVC, 정수 절사)  
**배분**: 정부 준비금 50% + 소각 50%  
**정부 지갑 면제**: GOVT_ADDRESS ↔ BURN_ADDRESS 이체 제외  
**구현**: `transactionService.ts` — ✅ 검증 완료 (burn_total=3 확인)

```
예시: 600 NVC 이체
- 세액: 6 NVC (1%)
  ├ 정부 준비금: 3 NVC
  └ 소각: 3 NVC → nova_burn_log (source=large_transfer_tax)
- 수취인 수령: 594 NVC
```

### 2.3 도메인 등록비

**요율**: 도메인 길이별 차등 (DOMAIN-POLICY.md 6회차 합의)  
**기본 정책**: 표준 등록비 **100 NVC** (2–5자 도메인 별도 프리미엄)  
**소각**: 등록비의 **100%** 소각  
**구현**: `domainService.ts` — ⚠️ 소각 연동 미구현 (v1.3 예정)

### 2.4 거버넌스 예치금 (Governance Bond)

**금액**: 제안 시 **50 NVC** 예치  
**환급**: 제안 가결 시 전액 환급  
**몰수**: 부결 또는 철회 시 소각  
**목적**: 스팸 제안 방지, 제안자 책임 강화  
**구현**: ⚠️ 미구현 (v1.4 예정)

### 2.5 에스크로 수수료

**현재**: 무수수료 (헌법 제6조 — 자유 경제)  
**분쟁 처리**: Arbiter DID 지정 후 거버넌스 의결

---

## 제3조 — 로열티 정책

| 로열티율 | 적용 범위 | 제한 |
|---------|----------|------|
| 0% | 로열티 없음 | 최솟값 |
| 1–10% | 표준 창작물 | 권장 범위 |
| 11–19% | 고가 예술품 | 허용 |
| 20% | 최고 로열티 | 법정 상한 (헌법 제8조) |

**1차 판매**: 로열티 없음 (판매자 = 창작자)  
**2차 이상**: 원작자에게 자동 지급 (`buyArtwork` 함수 — ✅ 구현)  
**로열티 수령 조건**: 원작자 지갑 존재 필수

---

## 제4조 — NVC 소각 메커니즘 (Burn)

**소각 주소**: `did:nova:0000000000000000burn0000000000`  
**소각 기록**: `nova_burn_log` 테이블 — ✅ 구현 및 검증 완료

### 소각 트리거별 비율

| 소각 트리거 | 소각 비율 | 소각 출처 코드 | 상태 |
|-----------|---------|--------------|------|
| 대형 이체세 | 세액의 50% | `large_transfer_tax` | ✅ |
| 마켓플레이스 수수료 | 수수료의 50% | `marketplace_fee` | ✅ |
| 도메인 등록비 | 100% | `domain_fee` | ⚠️ 미구현 |
| 블랙리스트 몰수 | 잔액 100% | `blacklist` | ✅ |
| 거버넌스 예치금 몰수 | 50 NVC | (미구현) | ⚠️ |

### 소각 현황 (2026-06-16)

```
burn_total: 3 NVC (E2E 테스트 확인)
source 분포:
  - large_transfer_tax: 3 NVC (600 NVC 이체 테스트)
  - marketplace_fee: 0 NVC (실거래 미발생)
```

---

## 제5조 — 경제 지표 모니터링

### 감시 임계값

| 지표 | 임계값 | 액션 |
|------|--------|------|
| 단일 지갑 > 총 공급 10% | 경고 | 감사 기록 |
| 24h 이체 실패율 > 5% | 경고 | 이중지불 탐지 강화 |
| 정부 준비금 < 1,000 NVC | 위험 | 자동 거버넌스 제안 |
| 연간 신규 발행 > 1% 하드캡 | 차단 | 거버넌스 의결 필수 |

### KPI 목표

- 시민당 평균 잔액: ≥ 500 NVC
- 마켓플레이스 월 거래량: 추적 예정
- 에스크로 분쟁률: < 5%
- 소각률 (연간): 총 수수료 수입의 50% 이상

---

## 제6조 — 구현 Gap 및 차기 작업

| 항목 | 우선순위 | 작업 |
|------|--------|------|
| 도메인 소각 연동 | 🔴 높음 | `domainService.ts` → `nova_burn_log (source=domain_fee)` |
| 거버넌스 예치금 | 🟡 중간 | `proposalService.ts` 신규 + 50 NVC 에스크로 |
| UBI 월 100 NVC 스케줄 | 🟢 완료 | `scheduleUbi()` 구현됨 |
| Prometheus 모니터링 | 🟢 완료 | `/metrics` 엔드포인트 |

---

## 제7조 — 토론 합의 사항 (2회차 결론)

**토론 세션**: sess_aeYCuJfMwHpw6iNH (opencode + codex, 2026-06-16)

**최종 확정 합의 (2회차)**:
1. **하드캡**: 1,000,000,000 NVC — 불변 (헌법 조항)
2. **UBI 월 지급**: 100 NVC/월/시민 — 즉시 적용
3. **대형 이체세**: 1% (>500 NVC) — 유지, 소각 50% ✅ 구현됨
4. **마켓플레이스 수수료**: 2.5%, 소각 50% ✅ 구현됨
5. **도메인 등록비 소각**: 100% 소각 원칙 확정 → v1.3 구현 예정
6. **거버넌스 예치금**: 50 NVC 제안 시 예치, 부결 시 소각 → v1.4 예정
7. **연간 발행 한도**: 1% 이내 (거버넌스 의결로만 초과 가능)
8. **소각 주소**: `did:nova:0000000000000000burn0000000000` 영구 고정
9. **감시 체계**: `/metrics` Prometheus 엔드포인트로 실시간 모니터링
10. **탈세 패널티**: 미납액의 200% 추가 징수 (분쟁 해결 위원회 의결)

---

---

## 제7차 세션 추가 파라미터 (v2.1)

> 토론: sess_fKkRgXQlTqpM9dn3 (opencode × codex, 7차) — **opencode 우승 9/10**

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 11 | **반감기 발동 조건** | 총공급 25% 도달마다 (목표 시점: 2030, 2040, 2050, 2060) | 인플레이션 점진 억제 |
| 12 | **반감기 UBI 감소율** | 총공급 대비 25% 도달 시 UBI 25% 감소 (100→75→56→42 NVC/월) | 지속 가능성 |
| 13 | **탈세 패널티** | 미납액 200% 추가 징수, 3회 반복 시 30일 블랙리스트 검토 | 세율 공정성 |
| 14 | **법인(DID 그룹) 과세** | 멤버 각자 개별 과세 (그룹세 없음) — 구성원 DID별 적용 | 단순성·공정성 |
| 15 | **국고 준비금 한도** | 총공급의 5% 초과 불가 (초과분 → UBI 재원 자동 전환) | 정부 과점 방지 |

---

---

## 제8차 세션 구현 갭 확정 (v2.2)

> 토론: sess_qCIRcXL3Fv6CYJRB (opencode × codex, 8차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError (쿼터 소진)

### 구현 갭 해결 결정

| # | 항목 | 결정 | 이유 |
|---|------|------|------|
| 16 | **반감기 기준 통합** | MVP: citizenCount/10000 유지. Phase 2에서 총공급 25% 기준 전환 | 현재 유통량(23,999 NVC)으로 25% 도달 불가능 — citizenCount 기준이 실용적 |
| 17 | **nova_library 20 NVC 보상** | 즉시 구현 — `publishLibraryItem()`에 `sendNVC(author, 20, 'Nova Library 기여 보상')` 추가 | RESEARCH-POLICY v2.0 준수 |
| 18 | **국고 5% 상한 모니터링** | `/metrics`에 `govt_reserve_ratio` Gauge 추가 + 초과 시 자동 UBI 재원 전환 트리거 | ECONOMIC-POLICY v2.1 제15조 이행 |
| 19 | **탈세 탐지 알고리즘** | 동일 DID 60초 내 합산 500+ NVC → 분할 회피 탐지. `nova_tax_evasion_log` 테이블 신설 | 기술적 탈세(분할 이체)만 탐지 가능 |

---

---

## 제9차 세션 구현 설계 확정 (v2.3)

> 토론: sess_MfKWp57xLATF1P2y (opencode × gemini × codex, 9차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError (쿼터 소진)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 20 | **일일 발행 한도** | `totalSupply × 0.01` / 일 (UTC 기준, Redis `mint:YYYYMMDD` 카운터) | 연 1% 하드캡 실제 운용 구현 |
| 21 | **탈세 탐지 로그 스키마** | `nova_tax_evasion_log`: id(UUID), timestamp, type(large_tx/rapid_cycle/did_mismatch), details(JSON), status(new/reviewed/resolved) | ECONOMIC-POLICY v2.2 param 19 구현 |
| 22 | **법인 DID 그룹 과세율** | 구성원 DID별 개별 과세 + 법인세율 15% (그룹 소득 집계 후 월 정산) | 이중과세 방지, 단순성 |

### 구현 설계 (opencode 채택안)

```typescript
// 일일 발행 한도 검증
const DAILY_LIMIT = totalSupply * 0.01;
function canMint(requested: number, mintedToday: number): boolean {
  return mintedToday + requested <= DAILY_LIMIT;
}
// Redis 키: mint:YYYYMMDD (UTC), INCR 원자적 업데이트
```

```sql
-- nova_tax_evasion_log 테이블
CREATE TABLE IF NOT EXISTS nova_tax_evasion_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  type TEXT NOT NULL CHECK(type IN ('large_tx','rapid_cycle','did_mismatch')),
  details TEXT NOT NULL DEFAULT '{}',  -- JSON
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','resolved'))
);
```

## 제10차 세션 탈세탐지·원자성·법인 설계 확정 (v2.4)

> 토론: sess_Tj-fpnt4LS53hqMP (opencode × gemini × codex, 10차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError (쿼터 소진) | codex: 메타 정보만 반환

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 23 | **탈세 슬라이딩 윈도우** | 60s 윈도우 / 5s 버킷(12개) — Redis `ZINCRBY+EXPIRE 70s` 우선, SQLite `ON CONFLICT` 폴백 | 분할이체 실시간 감지 |
| 24 | **canMint 원자성** | 고동시성: Lua `EVALSHA` (원자 1회, HASH `canMint:{userId}`) / 단순배포: `MULTI/EXEC+WATCH` | dailyLimit = totalSupply×0.01 |
| 25 | **법인 DID 그룹 스키마** | `did_group`(id PK, name, owner_did, created_at) + `did_group_member`(group_id FK, member_did, joined_at) + 월 정산 배치 (매월 1일 00:00 UTC) | 법인 DID 집합 월 정산 |

### 구현 설계 (opencode 10차 채택안)

```typescript
// taxEvasionDetectionService.ts
const WINDOW_MS = 60_000;
const BUCKET_GRANULARITY_MS = 5_000;
const NUM_BUCKETS = WINDOW_MS / BUCKET_GRANULARITY_MS; // 12

function getBucket(timestamp: number): number {
  return Math.floor(timestamp / BUCKET_GRANULARITY_MS) % NUM_BUCKETS;
}
// Redis: ZINCRBY evasion:{did} 1 <bucket>; EXPIRE evasion:{did} 70
// SQLite fallback: INSERT … ON CONFLICT(user_id,bucket) DO UPDATE SET count=count+1
```

```lua
-- canMint Lua script (고동시성)
local cur = tonumber(redis.call('HGET', KEYS[1], 'amount') or '0')
if cur + tonumber(ARGV[2]) > tonumber(ARGV[1]) then return {0, cur}
else redis.call('HINCRBY', KEYS[1], 'amount', ARGV[2]); return {1, cur + tonumber(ARGV[2])} end
```

```sql
-- did_group 스키마 (마이그레이션 050 예정)
CREATE TABLE IF NOT EXISTS nova_did_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_did  TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS nova_did_group_members (
  group_id   INTEGER NOT NULL REFERENCES nova_did_groups(id) ON DELETE CASCADE,
  member_did TEXT NOT NULL,
  joined_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, member_did)
);
```

## 제11차 세션 sendNVC 연동·월급 cron·법인 정산 확정 (v2.5)

> 토론: sess_049YkdIXYffuTljZ (opencode × gemini × codex, 11차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError | codex: 메타 정보만

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 26 | **royaltyService sendNVC 연동** | 2-phase commit: DB INSERT pending → NVC 전송 → status=sent. 재시도 3회(0/2/5s backoff), 최종 실패 시 rollback_audit 기록 | 트랜잭션 무결성 보장 |
| 27 | **공무원 월급 자동 cron** | `cron('59 23 L * *')` + `salary_evaluation_log(year,month,status)` 중복 방지(idempotent). 실패 시 status='failed' 재시도 허용 | 매월 마지막 날 23:59 UTC |
| 28 | **법인 DID 그룹 월 정산** | `nova_did_group_members` 전체 집계 → 각 멤버 legalEntityTax 15% 차감 → 청크 1000건 커밋 → `monthly_settlement` 감사 로그 기록 | 병렬 처리 + 원자적 배치 |

### 구현 설계 (opencode 11차 채택안)

```typescript
// royaltyDistributionService.ts — 2-phase sendNVC
async function sendWithRetry(to: DID, amount: number, memo: string): Promise<string> {
  const delays = [0, 2000, 5000];
  for (const delay of delays) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try { const tx = sendNVC({ from: GOVT_ADDRESS, to, amount, memo }); return tx.txId; }
    catch (e) { if (delay === 5000) throw e; }
  }
  throw new Error('Max retries exceeded');
}

// salary cron — idempotent guard
// cron('59 23 L * *'): check salary_evaluation_log WHERE year=? AND month=? AND status='completed'
// → exists: skip | not exists: evaluateAllSalaries() → INSERT log(status='completed')
```

---

## 12차 토론 확정 파라미터 (2026-06-16 | 합의율 70%)

### A. 연간 발행량 확정
```
AnnualSupply(y) = 5,000,000 / (2 ^ floor((y-1)/4))  NVC
```
| 연도 | 연간 발행량 |
|------|------------|
| 1–4  | 5,000,000 NVC |
| 5–8  | 2,500,000 NVC |
| 9–12 | 1,250,000 NVC |
| 13–16| 625,000 NVC |

### B. 이중과세 방지 기준
- **법인세 우선 원칙**: 동일 txHash에 corporate 플래그 존재 시 personal 세액 = 0
- `taxLedger[txHash] = { payer, amount, type: 'corporate' | 'personal' }`
- 법인세 적용 거래: 월별 집계 → 국고 자동 이체

### C. LP 보상 비율 확정
- DEX 수수료 0.3% 중 **LP 70% / 국고 30%** 분배
- onSwap 이벤트에서 원자적 분배 처리 (롤백 가능 트랜잭션)

*경제 정책 v2.6 — 2026-06-16. 12차 세션 완료 (sess_Lavqnuf21OCSTnak). 거버넌스 의결로 개정 가능.*

---

## v2.6 심화 파라미터 *(sess_c5VnSWZwz92ZjotQ, opencode × codex, 합의율 50%)*

### 수수료 구조 재정비

| 수수료 유형 | 비율 | 처리 방식 |
|-----------|------|---------|
| **P2P 전송** | **2.5%** | 유지 (소각 우선) |
| **도메인 등록** | 100% | **전액 소각** (재확인) |
| **대형 이체 (>500 NVC)** | **+1%** 특별세 | **소각 100%** (국고귀속 없음) |

### 연간 발행 상한 보완

| 항목 | 확정값 |
|------|--------|
| **일간 발행 상한** | 총공급 × **0.00274%** (연 1% 균등 배분) |
| **총공급 1% 기준** | 현재 23,989 NVC × 1% ≈ **240 NVC/년** |
| **Lua canMint 동시성** | 동시 mint 요청 **최대 3건** (초과 시 큐잉) |

*경제 정책 v2.6 심화 — 2026-06-16. 23차 NCO 토론 (sess_c5VnSWZwz92ZjotQ). 거버넌스 의결로 개정 가능.*
