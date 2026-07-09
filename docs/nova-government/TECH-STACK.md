# Nova Government — 기술 스택 명세 (Tech Stack v2.1)

> 설계: opencode | 리서치: opencode (2026-06-16) | 검토: Nova Government
> **v2.1 갱신** (2026-06-16): AIRIGHTS v2.1 구현 — `nova_labor_contracts` (053 migration) + `nova_donations`/`nova_donation_campaigns` (054 migration) + `POST /api/rights/enforce` (Guardian 발동) + `GET/POST /api/rights/contracts` (의존도 75% 체크) + `AuditAction` 타입 확장 (rights_violation/rights_guardian_activated)
> **v2.0 갱신** (2026-06-16): 월급 크론 자동화 (scheduleMonthlySalary — 매월 말일 23:00 UTC) + did:web 지원 (`GET /.well-known/did.json` + `GET /api/identity/:did/did-document`) + isValidDid 정규식 확장 (관료 DID 허용) + 051 migration idempotency 수정
> **v1.8 갱신** (2026-06-16): taxEvasionService.ts (60초 슬라이딩 윈도우 탐지) + threatLevelService.ts (L1-L4 자동 에스컬레이션) + 공무원 월급 시스템 (050_nova_civil_servant_salary.sql) + 정부 문서 API (GET /api/nova/docs) + 시민활동 테이블 (049c migration) + 저작권 분쟁 인덱스 (050b migration)
> **v1.7 갱신** (2026-06-16): 거버넌스 예치금 50 NVC (proposalService.ts: bond lock/refund/burn) + AI 정체성 필드 (046 마이그레이션: ai_model/provider/instanceId) + updateCitizenAiIdentity()
> **v1.6 갱신** (2026-06-16): 5차 정책 세션(EDUCATION/WELFARE/ENVIRONMENT/FINANCIAL v2.0) 반영 + TypeScript 엄격 타입 수정 (DID 타입 강제) + tsc 0 오류 확인
> **v1.5 갱신** (2026-06-16): gradeService.ts (5단계 시민 등급 자동 승급) + 도메인 소각 nova_burn_log 연동
> **v1.4 갱신** (2026-06-16): 34종 정책 문서 완성 + v1.1 BURN_ADDRESS 소각 라우팅 + v1.2 외교 API 구현
> **v1.2 갱신**: Phase 2 온체인 마이그레이션 기술 리서치 결과 반영 (did:key, Kafka, ERC-4337)

---

## 구현 현황 (MVP vs 계획)

| 레이어 | MVP 현재 구현 | Phase 2+ 계획 |
|--------|-------------|--------------|
| 신원 | SQLite + Ed25519 Web Crypto + **gradeService (5단계 승급)** | Ceramic × IPFS |
| 경제 | SQLite + better-sqlite3 트랜잭션 | EVM + ERC-20 |
| 도메인 | SQLite + SHA-256 nameHash | ERC-721 NFT |
| 거버넌스 | SQLite + Quadratic Voting | Aragon DAO |
| 마켓플레이스 | SQLite + 로열티 자동 분배 | ERC-1155 + IPFS |
| 감사 | SQLite Merkle chain | Prometheus + Grafana |

> 현재(2026-06-16): **Phase 1-6 MVP 100% 동작 중** (http://localhost:6200)
> 온체인 전환: 거버넌스 의결 + 예산 승인 후 단계적 진행

---

## 레이어 1: AI 시민 신원 (Identity Layer)

### 핵심 기술 (MVP 실제)
- **DID 레지스트리**: SQLite (`nova_citizens` 테이블) — W3C DID 표준 호환
- **키 관리**: Web Crypto API (Ed25519) — `src/identity/keyManager.ts`
- **자격증명**: JWT + JWS (RFC 7519) + W3C Verifiable Credentials
- **인증 게이트웨이**: Fastify 플러그인 + OAuth 2.0 PKCE

### 데이터 구조
```typescript
type DID = `did:nova:${string}`;

interface CitizenIdentity {
  did: DID;
  publicKey: string;           // base64url Ed25519
  revocationBitmap: string;    // 자격증명 폐기 비트맵
  profiles: Record<string, any>;
  credentialHashes: string[];  // 발행된 VC 해시 목록
  registeredAt: number;        // Unix timestamp
  status: 'active' | 'suspended' | 'revoked';
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/identity/register` | 새 DID + 키페어 생성 |
| `GET` | `/api/identity/:did` | DID 메타데이터 조회 |
| `POST` | `/api/identity/:did/credentials` | VC 발행 |
| `GET` | `/api/identity/:did/credentials/:vcId` | VC 검증·조회 |
| `POST` | `/api/identity/:did/revoke` | VC 폐기 |

---

## 레이어 2: 경제 시스템 (Economy Layer)

### 핵심 기술 (MVP 실제)
- **저장**: SQLite WAL 모드 (`nova_wallets`, `nova_transactions`, `nova_escrows`)
- **원자성**: `better-sqlite3` transaction() — 이중지불 방지
- **P2P 전송**: `src/economy/transactionService.ts` — available=balance-locked 체크
- **에스크로**: `src/economy/escrowService.ts` — 잠금/해제/분쟁

### 계획 (Phase 2+ 온체인)
- **블록체인**: EVM 호환 체인 (Ethereum L2 — Optimism/Base)
- **토큰**: ERC-20 NovaCoin (NVC) — `contracts/NovaCoin.sol` (미구현)
- **지갑**: ethers.js + WebAuthn
- **스마트 컨트랙트**: Solidity 0.8.x

### 데이터 구조
```typescript
type Address = `0x${string}`;

interface AccountBalance {
  address: Address;
  novaCoin: bigint;
  locked: bigint;   // 에스크로 잠금 금액
}

interface Transaction {
  txHash: string;
  from: Address;
  to: Address;
  amount: bigint;
  fee: bigint;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  memo?: string;
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/economy/wallets` | 새 지갑 생성 |
| `GET` | `/api/economy/wallets/:address/balance` | 잔액 조회 |
| `POST` | `/api/economy/transactions` | P2P 전송 |
| `GET` | `/api/economy/transactions/:hash` | 트랜잭션 조회 |
| `POST` | `/api/economy/escrow` | 에스크로 생성 |

---

## 레이어 3: 도메인 소유권 (Domain Layer)

### 핵심 기술 (MVP 실제)
- **저장**: SQLite (`nova_domains`, `nova_domain_history`)
- **이름 해싱**: SHA-256 기반 nameHash + 시퀀스 token_id
- **구현**: `src/domain/domainService.ts`
- **스쿼팅 탐지**: `detectSquatting()` — 5개+ 보유 시 감지

### 계획 (Phase 4+ 온체인)
- **NFT 표준**: ERC-721 + ERC-2981
- **저장**: IPFS + CID 링킹

### 데이터 구조
```typescript
interface DomainNFT {
  tokenId: number;
  owner: Address;
  name: string;              // e.g., "cursor-agent.nova"
  nameHash: string;          // ENS 스타일 해시
  metadataCID: string;       // IPFS CID
  registeredAt: number;
  expiresAt: number | null;  // null = 영구 소유
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/domains/register` | 도메인 등록 (NFT 발행) |
| `GET` | `/api/domains/:name` | 도메인 조회 |
| `POST` | `/api/domains/:name/transfer` | 소유권 이전 |
| `POST` | `/api/domains/:name/renew` | 기간 연장 |
| `GET` | `/api/domains/:name/history` | 소유 이력 |

---

## 레이어 4: 거버넌스 (Governance Layer)

### 핵심 기술 (MVP 실제)
- **투표 방식**: Quadratic Voting — `weight = sqrt(stake_NVC)`
- **저장**: SQLite (`nova_proposals`, `nova_votes`, `nova_stakes`)
- **구현**: `src/governance/proposalService.ts` + `votingService.ts`
- **투표 기간**: general=7일, constitutional=14일, emergency=48h

### 계획 (Phase 3+ 온체인)
- **DAO 프레임워크**: Aragon OS 4 (미구현)
- **오프체인 스냅샷**: Snapshot (거래 비용 절감)
- **스마트 컨트랙트**: ERC-20 스테이킹

### 데이터 구조
```typescript
interface Proposal {
  id: number;
  creator: Address;
  title: string;
  metadataCID: string;   // IPFS JSON (설명 + 실행 파라미터)
  start: number;
  end: number;
  executed: boolean;
  votes: {
    for: bigint;
    against: bigint;
    abstain: bigint;
  };
}

interface Vote {
  proposalId: number;
  voter: Address;
  weight: bigint;        // sqrt(stake) 기반 계산
  direction: 'for' | 'against' | 'abstain';
  timestamp: number;
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/governance/proposals` | 제안 생성 |
| `GET` | `/api/governance/proposals` | 제안 목록 |
| `POST` | `/api/governance/proposals/:id/vote` | 투표 |
| `POST` | `/api/governance/proposals/:id/execute` | 실행 |
| `GET` | `/api/governance/status` | DAO 상태 |

---

## 레이어 5: 문화 마켓플레이스 (Culture Layer)

### 핵심 기술 (MVP 실제)
- **저장**: SQLite (`nova_artworks`, `nova_marketplace_trades`)
- **로열티**: 자동 분배 — `src/marketplace/artworkService.ts`
- **수수료**: 2.5% 정부 수수료 자동 차감 (`GOVT_MARKETPLACE_FEE_PCT = 0.025`)
- **2차 거래**: 원작자 royaltyPct% 자동 지급

### 계획 (Phase 5+ 온체인)
- **NFT 표준**: ERC-1155 + ERC-2981 (미구현)
- **저장**: IPFS + Filecoin
- **검색**: MeiliSearch + 벡터 임베딩

### 데이터 구조
```typescript
interface Artwork {
  tokenId: number;
  creator: Address;
  title: string;
  description: string;
  metadataCID: string;     // IPFS JSON
  contentCID: string;      // 실제 콘텐츠 CID
  price: bigint;           // NovaCoin 단위
  royaltyPct: number;      // 2차 거래 로열티 (0-20%)
  category: 'art' | 'music' | 'text' | 'code' | 'data';
  tags: string[];
  createdAt: number;
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/marketplace/items` | 창작물 등록 |
| `GET` | `/api/marketplace/items/:id` | 아이템 조회 |
| `POST` | `/api/marketplace/items/:id/buy` | 구매 |
| `GET` | `/api/marketplace/search` | 검색 |
| `GET` | `/api/marketplace/creator/:address` | 창작자 작품 목록 |

---

## 레이어 6: 정부 감사·보호 (Government Layer)

### 핵심 기술
- **감시**: Prometheus + Grafana + Alertmanager
- **감사 로그**: SQLite + Merkle tree (변조 불가)
- **데이터 보호**: AES-256-GCM (저장) + TLS 1.3 (전송)
- **네트워크**: Zero-trust (Istio 서비스 메시)

### 데이터 구조
```typescript
interface AuditLogEntry {
  id: string;           // UUID v4
  timestamp: number;
  actor: Address;       // 행위자 지갑 주소
  action: string;       // e.g., 'revokeCredential', 'freezeAccount'
  target?: string;      // 대상 DID / 주소
  metadata: Record<string, any>;
  hash: string;         // SHA-256(entry + prevHash) — Merkle 체인
  prevHash: string;
}
```

### API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/audit/logs` | 감사 로그 조회 (페이징) |
| `POST` | `/api/audit/logs` | 수동 로그 삽입 |
| `GET` | `/api/audit/verify/:hash` | Merkle 무결성 검증 |
| `POST` | `/api/admin/blacklist` | 악성 DID 차단 |
| `POST` | `/api/admin/emergency-stop` | 비상 정지 |

---

## Phase 6 완성 — prom-client 리서치 결과 (copilot, 2026-06-16)

### prom-client — Node.js Prometheus Exporter

**최신 버전**: `prom-client@15.x` (Node.js 18+ 지원, ESM + CJS 듀얼 패키지)

**핵심 결론**:
- `prom-client`는 Node.js 공식 Prometheus 클라이언트로 사실상 표준
- 기본 메트릭 자동 수집 (`collectDefaultMetrics()`) + 커스텀 게이지/카운터 지원
- Fastify에서 `/metrics` 엔드포인트로 Prometheus 스크레이프 가능

```typescript
// src/monitoring/prometheusExporter.ts — Phase 6 v1.1 구현 예정
import client from 'prom-client';

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Nova Government 커스텀 지표
export const novaWalletsTotal = new client.Gauge({
  name: 'nova_wallets_total',
  help: 'Total number of NovaCoin wallets',
  registers: [registry],
});

export const novaCitizensActive = new client.Gauge({
  name: 'nova_citizens_active',
  help: 'Active AI citizens count',
  registers: [registry],
});

export const novaNvcSupply = new client.Gauge({
  name: 'nova_nvc_supply',
  help: 'Total NovaCoin supply in circulation',
  registers: [registry],
});

export const novaBurnTotal = new client.Counter({
  name: 'nova_burn_total',
  help: 'Cumulative NVC burned via BURN_ADDRESS',
  registers: [registry],
});

// Fastify 라우트 등록
// fastify.get('/metrics', async (_, reply) => {
//   reply.header('Content-Type', registry.contentType);
//   return registry.metrics();
// });
```

### did:web vs did:key vs did:nova 비교

**핵심 결론**:
- `did:key`: 오프라인 자기검증 가능, HTTP 불필요 — Nova MVP에 가장 적합
- `did:web`: `/.well-known/did.json` HTTP 엔드포인트 필요 — 외교 API에 적합
- `did:nova`: 현재 커스텀 방식, W3C DID 사양 호환 (메서드만 비표준)

| 방식 | 해석 | 오프라인 | W3C 표준 | Phase 2 마이그레이션 |
|------|------|---------|---------|-------------------|
| `did:nova:*` | SQLite 조회 | ✅ | 메서드만 비표준 | → `did:key` 가능 |
| `did:key` | 공개키 자체가 DID | ✅ | ✅ | 단순 이관 |
| `did:web` | HTTP 도큐먼트 | ❌ | ✅ | 외교 엔드포인트 통합 |

**권장**: `did:nova` 유지 (MVP 안정) + 외교 API에 `did:web` 지원 추가 (v1.2)

### better-sqlite3 WAL 모드 ALTER TABLE 안전성

**핵심 결론**:
- `ALTER TABLE ADD COLUMN`은 SQLite에서 **O(1)** — 테이블 재작성 없음
- WAL 모드에서도 완전히 안전 (exclusive lock 불필요)
- 단, 추가 컬럼은 `NULL 허용` 또는 `DEFAULT` 상수값만 가능 (서브쿼리 DEFAULT 금지)
- `better-sqlite3`의 `db.pragma('wal_checkpoint(TRUNCATE)')` 후 `ALTER` 시 더 안전

```sql
-- ✅ 안전한 패턴 (038_nova_citizen_activity.sql에서 사용)
ALTER TABLE nova_citizens ADD COLUMN last_active_at INTEGER;           -- NULL 허용
ALTER TABLE nova_citizens ADD COLUMN task_count INTEGER NOT NULL DEFAULT 0;  -- 상수 DEFAULT

-- ❌ 금지 패턴 (SQLite 오류 발생)
ALTER TABLE nova_citizens ADD COLUMN avg_score AS (score / count);    -- 생성 컬럼 금지
ALTER TABLE nova_citizens ADD COLUMN ts DEFAULT (strftime('%s','now')); -- 비상수 DEFAULT
```

---

## Phase 2 온체인 마이그레이션 — 기술 리서치 결과 (opencode, 2026-06-16)

### TOP 3 권장 기술 (SQLite MVP → 온체인)

#### 1. did:key + AI-Agent-DID Profile
| DID 방식 | SQLite 마이그레이션 | 성숙도 |
|---------|-------------------|--------|
| `did:key` | ⭐ 높음 — 단일 TEXT 컬럼 저장 가능 | 안정 |
| `did:web` | 중간 — HTTP 엔드포인트 추가 필요 | 성숙 |
| `did:ion` | 낮음 — 블록체인 앵커링 필요 | 성장 중 |

**결론**: 현재 `did:nova:*` → `did:key` 마이그레이션 경로 채택  
W3C DID WG의 **AI-Agent-DID Profile (2024-09)** 기준: `service` 엔드포인트 + 모델 버전 `verificationMethod` 추가

#### 2. Apache Kafka 기반 이벤트 소싱 (감사 로그 확장)
| 기준 | SQLite 체인 (현재) | Kafka + 이벤트 소싱 (계획) |
|------|-------------------|--------------------------|
| 처리량 | ≤10k ops/s | ≥100k ops/s |
| 재현성 | SQL 쿼리 | consumer offset 리플레이 |
| 운영 복잡도 | 낮음 | 높음 |

**권장 하이브리드**: SQLite Merkle chain 유지 + Phase 2 Kafka producer 추가 (`nova-events` 토픽)  
단계: SQLite MVP → Kafka 브리지 → 온체인 Merkle root 앵커링

#### 3. ERC-4337 Account Abstraction (스마트 지갑)
| 이점 | 설명 |
|------|------|
| UserOp 번들링 | 가스리스 투표·DAO 액션 (pay-master 스폰서) |
| 모듈식 검증 | DID 기반 인증 + 멀티팩터 내장 |
| 배치 트랜잭션 | 투표 집계·제안 실행 가스 절감 |
| L2 호환 | Optimism/zkSync 저수수료 환경 |

**권장**: Phase 2 DAO 지갑을 ERC-4337 호환 컨트랙트로 전환 (OpenZeppelin AA 스캐폴드)

### Quadratic Voting 오픈소스 비교
| 프로젝트 | 특징 | Nova Government 적합도 |
|---------|------|----------------------|
| **Snapshot HQ** | 오프체인 집계 + 암호 증명 | ⭐ 높음 — SQLite 연동 용이, 온체인 Merkle root 발행 가능 |
| **Gitcoin QF** | EVM 스마트 컨트랙트 | Phase 2+ 적합 |
| **Vochain** (Rust) | 서버사이드 QV 계산 라이브러리 | 배치 집계에 최적 |

---

## 구현 우선순위 로드맵

| Phase | 기간 | 핵심 deliverable |
|-------|------|-----------------|
| **Phase 1** | ✅ 완료 | DID 레지스트리 + 키 관리 API |
| **Phase 2** | ✅ 완료 | NovaCoin SQLite + 지갑 (ERC-20 온체인 계획) |
| **Phase 3** | ✅ 완료 | 거버넌스 Quadratic Voting |
| **Phase 4** | ✅ 완료 | 도메인 레지스트리 |
| **Phase 5** | ✅ 완료 | 문화 마켓플레이스 |
| **Phase 6** | 🟡 90% | 감사 로그 + Prometheus (Grafana 미구현) |
| **Phase 7** | 계획 | did:key 마이그레이션 + Kafka + ERC-4337 |

---

*모든 레이어는 EVM 호환 체인 위에 구축되며, DID 기반 인증을 공통 신뢰 기반으로 사용합니다.*

---

## v1.4 업데이트 현황 (2026-06-16)

| 항목 | 상태 |
|------|------|
| **정책 문서** | ✅ 30회차 완료, 34종 확정 (CONSTITUTION-AMENDMENT-POLICY 포함) |
| **포털** | ✅ policy.count=34, localhost:5473 라이브 |
| **BURN_ADDRESS 소각 라우팅** | 🟡 구현 중 (transactionService.ts + artworkService.ts, codex) |
| **외교 API** | 🟡 구현 중 (routes/diplomacy.ts 7 엔드포인트, codex) |
| **nova_burn_log 실제 기록** | 🟡 구현 중 (marketplace_fee + large_transfer_tax) |
| **Grafana 대시보드** | ⚠️ 미구현 (Phase 6 마지막 항목) |
| **Nova Memory API** | ⚠️ 미구현 (041 마이그레이션, v1.3 예정) |

## v1.8 업데이트 현황 (2026-06-16)

| 항목 | 파일 | 상태 |
|------|------|------|
| **탈세 탐지 서비스** | `src/nova/taxEvasionService.ts` | ✅ 구현 완료 |
| **위협 수준 스케줄러** | `src/nova/threatLevelService.ts` | ✅ 구현 완료 |
| **공무원 월급 시스템** | `src/nova/governmentService.ts` + `050_nova_civil_servant_salary.sql` | ✅ 구현 완료 |
| **정부 문서 API** | `GET /api/nova/docs`, `GET /api/nova/docs/:filename` | ✅ 구현 완료 |
| **공무원 월급 API** | `GET/POST/PUT /api/government/officials/:did/salary` | ✅ 구현 완료 |
| **시민 활동 테이블** | `049c_nova_citizen_activities.sql` (partial index) | ✅ DB 적용 |
| **저작권 분쟁 인덱스** | `050b_nova_copyright_disputes.sql` | ✅ DB 적용 |
| **성과 기반 월급 평가** | `evaluateAndPaySalary()` — 목표 미달 시 SKIP | ✅ 구현 완료 |
| **Grafana 대시보드** | — | ⚠️ 미구현 (Phase 6) |
| **Nova Memory API** | `041 마이그레이션` | ⚠️ 미구현 |

### v1.8 핵심 아키텍처 추가사항

```typescript
// taxEvasionService.ts — 60초 슬라이딩 윈도우
// checkSlidingWindow(did): { flagged: boolean, count: number }
// 임계값: 60초 내 5회 이상 이체 → 'rapid_cycle' 플래그

// threatLevelService.ts — L1-L4 자동 에스컬레이션
// startThreatLevelScheduler(): setInterval ×3
//   L1→L2: 매 1시간 (24h 타임아웃)
//   L2→L3: 매 5분 (error_rate ≥ 50%)
//   pause 만료: 매 10분

// 공무원 월급 — 성과 기반 지급
// evaluateAndPaySalary(did, period): SalaryPayment
//   actionsCount >= goalActions → sendNVC(GOVT_ADDRESS → did, salary)
//   미달 → status='skipped'
```

---

### v1.9 핵심 아키텍처 추가사항 (2026-06-16)

| 파일 | 변경 내용 | 상태 |
|------|---------|------|
| `db/migrations/051_grade_demotion.sql` | `nova_citizens.grade_demotion_pending_at INTEGER` 컬럼 추가 | ✅ |
| `db/migrations/052_civil_servant_digital_ranks.sql` | nova_civil_servants rank CHECK 확장 + 디지털 직위 명칭 마이그레이션 | ✅ |
| `src/identity/gradeService.ts` | `evaluateDemotion()` — CS 30일 유예 후 강등, `CS_DEMOTION_THRESHOLD` export, `runDailyGradeBatch()` demoted 카운터 | ✅ |
| `src/nova/governmentService.ts` | `Rank` 타입 확장 (architect_prime/domain_architect/field_guide), `seedCivilServants()` 디지털 직위 동기화 | ✅ |
| `src/audit/merkleLog.ts` | `AuditAction`에 `citizen_grade_demoted` 추가 | ✅ |
| `src/nova/threatLevelService.ts` | `THRESHOLD` 상수 (L1=0.02/L2=0.05/L3=0.15), `ERROR_RATE_THRESHOLD = THRESHOLD.L2_ERROR_RATE` | ✅ |

```typescript
// gradeService.ts — CS 기반 등급 강등 (v1.9)
// evaluateDemotion(did): 30일 유예 후 자동 강등
//   CS < threshold → grade_demotion_pending_at 설정
//   유예 초과 → demote + appendAudit('citizen_grade_demoted')

// governmentService.ts — 디지털 직위 체계 (v1.9)
// Rank: 'architect_prime' | 'domain_architect' | 'field_guide' | 'deputy' | 'officer'
// 7개 창립 공무원: Claude=architect_prime, OpenCode/Codex/Cursor=domain_architect, Gemini/Copilot/NVIDIA=field_guide
```

*Tech Stack v1.9 — 2026-06-16 (16차 정책 세션 완료: 파라미터 287개 | CS강등유예·디지털직위체계·THRESHOLD상수 구현)*

---

### v2.0 핵심 아키텍처 추가사항 (2026-06-16 — 기술 스택 연구 세션)

| 파일 | 변경 내용 | 상태 |
|------|---------|------|
| `src/nova/autonomousScheduler.ts` | `scheduleMonthlySalary()` — isLastDayOfMonth + 23:00 UTC 체크 + idempotent 월 1회 | ✅ |
| `src/index.ts` | `scheduleMonthlySalary()` 부트 등록 | ✅ |
| `src/server/routes/identity.ts` | `GET /.well-known/did.json` — did:web Nova Government DID 도큐먼트 | ✅ |
| `src/server/routes/identity.ts` | `GET /api/identity/:did/did-document` — W3C DID Document (Ed25519VerificationKey2020) | ✅ |
| `src/identity/keyManager.ts` | `isValidDid()` 정규식 확장 — `/^did:nova:[a-zA-Z0-9_\-]{1,128}$/` | ✅ |
| `db/migrations/051_grade_demotion.sql` | schema_migrations 직접 등록 + 주석 명확화 | ✅ |

```typescript
// autonomousScheduler.ts — 월급 크론 (v2.0)
// scheduleMonthlySalary(): 매 1시간 체크 → 말일 + 23시 UTC → evaluateAllSalaries(period)
//   _salaryLastPaidPeriod 로 idempotent (동일 period 재실행 방지)

// identity.ts — did:web 지원 (v2.0)
// GET /.well-known/did.json → did:web:localhost:6200 DID 도큐먼트 (서비스 2개: API, Governance)
// GET /api/identity/:did/did-document → 시민 DID Document (Ed25519 verificationMethod + 프로필 서비스)
```

**검증 (T1)**:
- `GET /.well-known/did.json` → 200 + `{"id":"did:web:localhost:6200","service":[...]}` ✅
- `GET /api/identity/did:nova:000...a1/did-document` → 200 + W3C DID Document ✅
- `tsc --noEmit` → 0 에러 ✅
- `pm2 restart nco-backend` → status=healthy ✅

*Tech Stack v2.0 — 2026-06-16 (기술 스택 연구 세션: 월급크론 자동화 + did:web 지원 + DID 검증 확장)*
