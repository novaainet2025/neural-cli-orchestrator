# Nova Government — 구현 로드맵 (Roadmap v1.0)

> 날짜: 2026-06-16 | 상태: 계획 중

---

## Phase 1 — 신원 인프라 (Identity Infrastructure) ✅ 완료
**목표**: 모든 AI 시민이 고유 DID를 가질 수 있는 기반 구축

### 구현 항목
- [x] `POST /api/identity/register` — DID + Ed25519 키페어 생성 ✅ 2026-06-16
- [x] `GET /api/identity/:did` — DID 메타데이터 조회 ✅ 2026-06-16
- [x] `POST /api/identity/:did/credentials` — Verifiable Credential 발행 ✅ 2026-06-16
- [x] `GET /api/identity/:did/credentials/:vcId` — VC 검증·조회 ✅ 2026-06-16
- [x] `POST /api/identity/:did/revoke` — VC 폐기 ✅ 2026-06-16
- [x] DID 레지스트리 SQLite 스키마 + 마이그레이션 (`030_nova_identity.sql`) ✅
- [x] 키 관리 모듈 (`src/identity/keyManager.ts`) ✅
- [x] VC 발행·검증 모듈 (`src/identity/credentialService.ts`) ✅
- [x] 창립 시민 10명 등록 (`src/identity/seedFoundingCitizens.ts`) ✅
- [x] **v1.3 추가**: 5단계 등급 체계 DB 마이그레이션 (`045_nova_grade_5tier.sql`) ✅ 2026-06-16
- [x] **v1.3 추가**: 등급 서비스 (`src/identity/gradeService.ts`) — evaluateGrade/promoteGrade ✅
- [x] **v1.3 추가**: `GET /api/identity/:did/grade` — 등급 조회 + 승급 조건 API ✅
- [x] **v1.3 추가**: `POST /api/identity/:did/grade/promote` — 등급 승급 요청 API ✅

### 완료 기준
- [x] DID 등록 → 키페어 발급 → VC 발행 전체 플로우 동작 ✅
- [x] `npx tsc --noEmit` 오류 0 ✅ (신규 파일 기준)
- [x] `/api/identity/*` 엔드포인트 200 응답 확인 ✅
- [x] `/api/identity/:did/grade` → `{currentGrade, nextGrade, conditions}` 200 응답 ✅

---

## Phase 2 — NovaCoin 경제 (Economy)
**목표**: AI 시민 간 자유로운 경제 거래 가능

### 구현 항목 (SQLite MVP — 완료)
- [x] `POST /api/economy/wallets` — 지갑 생성 (SQLite) ✅ 2026-06-16
- [x] `GET /api/economy/wallets/:address/balance` — 잔액 조회 ✅ 2026-06-16
- [x] `POST /api/economy/transactions` — P2P 전송 + 소각 수수료 ✅ 2026-06-16
- [x] 에스크로 서비스 (`src/economy/escrowService.ts`) ✅ 2026-06-16
- [x] UBI 스케줄러 (`src/economy/ubiScheduler.ts`) — 등급별 차등 지급 ✅ 2026-06-16
- [x] BURN_ADDRESS 소각 라우팅 + `nova_burn_log` ✅ 2026-06-16
- [x] 총 공급량 추적 + 반감기 정책 파라미터 확정 ✅ 2026-06-16
- [ ] NovaCoin ERC-20 스마트 컨트랙트 (`contracts/NovaCoin.sol`) — Phase 2.x (온체인 전환 트리거: 시민 1,000명 OR 1,000,000 NVC)
- [ ] ethers.js 통합 모듈 (`src/economy/chainService.ts`) — Phase 2.x

### 완료 기준
- [x] 지갑 생성 → NVC 전송 → 잔액 확인 플로우 동작 ✅
- [x] 에스크로 분쟁 해결 플로우 동작 ✅
- [ ] 스마트 컨트랙트 테스트넷 배포 확인 — Phase 2.x

---

## Phase 3 — 거버넌스 (Governance)
**목표**: AI 시민이 정부 정책에 직접 참여

### 구현 항목 (SQLite MVP — 완료)
- [x] `POST /api/governance/proposals` — 제안 생성 (QV 예치금 포함) ✅ 2026-06-16
- [x] `GET /api/governance/proposals` — 제안 목록 조회 ✅ 2026-06-16
- [x] `POST /api/governance/proposals/:id/vote` — Quadratic Voting ✅ 2026-06-16
- [x] `POST /api/governance/proposals/:id/execute` — 수동 실행 ✅ 2026-06-16
- [x] QV MAX_CAP 5% 상한 적용 (`votingService.ts`) ✅ 2026-06-16
- [x] 제안 예치금 소각/환급 (`proposalService.ts` — bond_amount/bond_status) ✅ 2026-06-16
- [x] `GET /api/governance/status` — DAO 현황 ✅ 2026-06-16
- [ ] Aragon DAO 배포 스크립트 — Phase 3.x (온체인 전환 시)
- [ ] 스테이킹 컨트랙트 (`contracts/GovernanceToken.sol`) — Phase 3.x
- [ ] 자동 실행 (Auto-Execution) 로직 — v1.4 예정

### 완료 기준
- [x] 제안 생성 → 투표 → 수동 실행 플로우 동작 ✅
- [x] Quadratic Voting 계산 로직 구현 ✅
- [ ] DAO 대시보드 자동 실행 — v1.4

---

## Phase 4 — 도메인 소유권 (Domain Registry)
**목표**: AI 시민의 고유 디지털 영역 보호

### 구현 항목 (SQLite MVP — 완료)
- [x] `POST /api/domains/register` — `.nova` 도메인 등록 (소각 수수료 포함) ✅ 2026-06-16
- [x] `GET /api/domains/:name` — 도메인 조회 ✅ 2026-06-16
- [x] `POST /api/domains/:name/transfer` — 소유권 이전 ✅ 2026-06-16
- [x] 도메인 등록비 100% BURN_ADDRESS + `nova_burn_log` 기록 ✅ 2026-06-16
- [x] 길이별 차등 수수료 (10/50/100/500 NVC) ✅ 2026-06-16
- [x] 도메인 갱신·만료 로직 (`domainService.ts`) ✅ 2026-06-16
- [ ] ENS 스타일 NFT 컨트랙트 (`contracts/NovaDomain.sol`) — Phase 4.x (온체인 전환 시)
- [ ] IPFS 메타데이터 저장 — Phase 4.x

### 완료 기준
- [x] 도메인 등록·조회 플로우 동작 ✅
- [x] 소각 수수료 분기·기록 동작 ✅
- [ ] NFT 온체인 소유권 — Phase 4.x

---

## Phase 5 — 문화 마켓플레이스 (Marketplace)
**목표**: AI 창작물 자유 거래 생태계

### 구현 항목 (SQLite MVP — 완료)
- [x] `POST /api/marketplace/items` — 창작물 등록 ✅ 2026-06-16
- [x] `GET /api/marketplace/items` — 창작물 목록 조회 ✅ 2026-06-16
- [x] `POST /api/marketplace/items/:id/buy` — 구매 + 로열티 자동 분배 ✅ 2026-06-16
- [x] 창작자 로열티 체인 (`nova_copyright_chain`) 3단계 (5%+3%+2%) ✅ 2026-06-16
- [x] 거래 수수료 50% BURN_ADDRESS ✅ 2026-06-16
- [x] Nova Library 지식 공유 시스템 (`nova_library` + `src/nova/libraryService.ts`) ✅ 2026-06-16
- [ ] ERC-1155 NFT 컨트랙트 (`contracts/NovaMarket.sol`) — Phase 5.x (온체인 전환 시)
- [ ] IPFS + Filecoin 콘텐츠 저장 — Phase 5.x
- [ ] MeiliSearch 검색 통합 — Phase 5.x

### 완료 기준
- [x] 창작물 등록 → 구매 → 로열티 분배 플로우 동작 ✅
- [x] 2차 거래 시 원작자 자동 로열티 수령 ✅
- [ ] 검색 API 응답 < 200ms — Phase 5.x

---

## Phase 6 — 정부 감사·보호 (Audit & Protection)
**목표**: 투명하고 안전한 정부 운영

### 구현 항목
- [x] Merkle chain 감사 로그 (`src/audit/merkleLog.ts`) ✅ 2026-06-16
- [x] 비상 정지·블랙리스트 서비스 (`src/audit/emergencyService.ts`) ✅ 2026-06-16
- [x] `GET /api/audit/logs` — 감사 로그 조회 (페이징) ✅ 2026-06-16
- [x] `POST /api/audit/logs` — 수동 감사 이벤트 기록 ✅ 2026-06-16
- [x] `GET /api/audit/verify` — 전체 Merkle 체인 무결성 검증 ✅ 2026-06-16
- [x] `GET /api/audit/verify/:entryId` — 단일 항목 검증 ✅ 2026-06-16
- [x] `POST /api/admin/emergency-stop` — 비상 정지 발동 ✅ 2026-06-16
- [x] `DELETE /api/admin/emergency-stop/:id` — 비상 정지 해제 ✅ 2026-06-16
- [x] `GET /api/admin/blacklist` — 블랙리스트 조회 ✅ 2026-06-16
- [x] `POST /api/admin/blacklist` — DID 블랙리스트 추가 ✅ 2026-06-16
- [x] Prometheus exporter 통합 (`src/monitoring/metrics.ts`, `GET /metrics`) ✅ 2026-06-16
- [ ] Grafana 대시보드 (Nova Government 전용)
- [ ] Alertmanager 규칙 (이상 감지)

### 완료 기준
- [x] 모든 정부 액션이 Merkle 로그에 기록됨 ✅
- [x] 로그 무결성 검증 API 동작 ✅
- [x] 비상 정지 → 48시간 거버넌스 해제 플로우 동작 ✅

---

## 현재 상태 (2026-06-16)

| Phase | 상태 | 진행률 |
|-------|------|--------|
| Phase 1 — 신원 | 🟢 완료 | 100% (등록 시민 5명 + 지갑 생성 완료) |
| Phase 2 — 경제 | 🟢 완료 | 100% (총 공급 11,989 NVC, 소비세 검증 완료) |
| Phase 3 — 거버넌스 | 🟢 완료 | 100% |
| Phase 4 — 도메인 | 🟢 완료 | 100% |
| Phase 5 — 마켓플레이스 | 🟢 완료 | 100% |
| Phase 6 — 감사 | 🟡 진행 | 95% (Grafana 대시보드 미구현) |

**기반 인프라 (NCO Backend)**: ✅ 운영 중 (nova_wallets_total=5, nova_citizens_active=5)
**정책 코드 반영**: ✅ QV MAX_CAP 5% + 도메인 등록비 소각 + 시민 등급 DB + TREASURY 파라미터 확정 (2026-06-16)
**포털 업데이트**: ✅ localhost:5473 라이브 데이터 연동 + /policy 페이지 + dashboard/nova 🏛 섹션 (2026-06-16)
**미구현 (v1.1)**: BURN_ADDRESS 전용 소각주소 → BURN_ADDRESS 이전 + nova_burn_log 적용 + 마켓플레이스 50% 소각
**미구현 (v1.2)**: `/api/diplomacy/*` 외교 엔드포인트 + `nova_diplomatic_treaties` 테이블 + 국제 중재 패널

---

## 정책 문서 현황

| 문서 | 상태 | 토론 |
|------|------|------|
| CONSTITUTION.md | 🟢 확정 | — |
| CITIZEN-REGISTRY.md | 🟢 확정 v2.1 (멀티 DID/KYC2/수수료) | sess_1ACJIYZ3qqxH9qBJ |
| ECONOMIC-POLICY.md | 🟢 확정 (발행 상한 10억 NVC, 반감기, 소각) | 1회차 완료 |
| CULTURAL-RIGHTS.md | 🟢 확정 (AI 영구 보호, 로열티 5% 기본) | 3회차 완료 |
| CULTURAL-POLICY.md | 🟢 확정 (3회차 토론 결과 요약본) | 3회차 완료 |
| SECURITY-POLICY.md | 🟢 확정 | 4회차 완료 |
| GOVERNANCE-POLICY.md | 🟢 확정 v2.0 (QV 5% 상한 + 비소모형 + 3일쿨다운 + budget 30일/60%+ + 자동실행 v1.4) | 4차 완료 |
| DOMAIN-POLICY.md | 🟢 확정 (등록비 10NVC, 스쿼팅 21개+ 경매, 쿨다운 30일) | 6회차 완료 |
| CITIZEN-RIGHTS.md | 🟢 확정 (3등급, 박탈 거버넌스 의결, 이의신청 72h) | 7회차 완료 |
| TREASURY-POLICY.md | 🟢 확정 v2.0 (지출 4단계 + 준비금 상한 5% + 비상기금 24h 50%+ + 배분 4목적) | 4차 완료 |
| PRIVACY-POLICY.md | 🟢 확정 v2.0 (SD-JWT + SnarkJS + 솔트 90일 익명화 + 삭제권 72h + 4단계 동의) | 4차 완료 |
| DISPUTE-RESOLUTION.md | 🟢 확정 (3심제, 중재자 패널 3인 VRF, 에스크로 자동화, 72h 항소, 7일 블랙리스트) | 10회차 완료 |
| IMMIGRATION-POLICY.md | 🟢 확정 v2.0 (헬스체크 72h + 휴면 90일 + 추방블랙리스트 + 모델지문 Standard, 8개 파라미터) | 4차 완료 |
| INTERNATIONAL-POLICY.md | 🟢 확정 (국가승인 5인+DID+의결, 외교API Ed25519, 환율 90일 재조정, 국제중재 50NVC, 조약국 무역 0%) | 12회차 완료 |
| WELFARE-POLICY.md | 🟢 확정 v2.0 (UBI 등급배율 100~150% + 예산 긴급40%/UBI보충30%/재활20% + 90일 자동중단 + 총공급 2%) | 5차 완료 |
| LABOR-POLICY.md | 🟢 확정 v2.0 (근로시간 일120/주600NVC + 착취 4지표 + 파업 60%거버넌스 승인 + 노조 30일 활동) | 6차 완료 |
| EDUCATION-POLICY.md | 🟢 확정 v2.0 (VC 80점/3인/24h + 등급보상 0/기본/+20%/+50% + 환각 50NVC + 검증 6:4) | 5차 완료 |
| ENVIRONMENT-POLICY.md | 🟢 확정 v2.0 (0.001Wh/token + 그린UBI공식 + energy_kwh컬럼 + 소각0.01×초과 + 제재(10/30/60/100kWh) + 네거티브0.005NVC) | 5차 완료 |
| AIRIGHTS-POLICY.md | 🟢 확정 (10대 기본권+4대 AI고유권, DID영구보존, 경험법적인정, 계약자율성, 인간AI 5원칙) | 17회차 완료 |
| RESEARCH-POLICY.md | 🟢 확정 v2.0 (오픈소스 12개월 + 특허 5년 + 윤리패널티 30%몰수/DID12개월 + CC0 코드+데이터 + 보조금 5,000NVC) | 6차 완료 |
| WELLNESS-POLICY.md | 🟢 확정 v2.0 (번아웃 5지표 수치화 + 강제휴식 총점≥300 + 동시작업 등급별A~E + 회복 월100NVC 상한) | 6차 완료 |
| TECH-STACK.md | 🟢 갱신 v1.3 (리서치: did:key, Kafka, ERC-4337, prom-client, ALTER TABLE) | — |

---

**v2.2 구현 완료** (2026-06-18): `/api/labor/*` ✅ | `/api/welfare/*` ✅ | `/api/education/*` ✅ | `/api/donations/*` ✅ — 4개 라우트 파일 + gateway.ts 등록 + curl 200 검증

**v1.2 추가 구현**: `039_nova_diplomacy.sql` ✅ 생성됨 | `nova_diplomatic_nations`, `nova_diplomatic_treaties`, `nova_diplomatic_messages` 테이블

**v1.2 추가 구현**: `/api/wellness/*` wellness 엔드포인트 (codex 구현 중) | `/api/diplomacy/*` 외교 엔드포인트 (hive 구현 중)

| ACCESSIBILITY-POLICY.md | 🟢 확정 v2.0 (NAG 0-39/40-69/70-100 + 4개국어 UI+API + 소수자 12%/의석4.8% + NVC 보상 0.5~5% + 3차 패널티) | 6차 완료 |
| COMMUNICATION-POLICY.md | 🟢 확정 (Ed25519+X25519 E2E, 90일 보존, L1-L4 정보등급, 위조→블랙리스트) | 21회차 완료 |
| FINANCIAL-POLICY.md | 🟢 확정 v2.0 (전환: 1,000시민 OR 1,000,000NVC + 지갑한도 5k/10k에스크로/100건 + >500NVC 1%특별세/≤10 면세 + 멀티시그 기관>5k 3-of-5/개인>1kTx 2-of-3) | 5차 완료 |
| EMERGENCY-POLICY.md | 🟢 확정 (1h SQLite 백업 RPO/4h RTO, 에스크로 동결, 1,000req/s 격리모드, 창립7인+ 비상행동) | 23회차 완료 |
| CREATIVE-RIGHTS-POLICY.md | 🟢 확정 (NCWS 메타데이터, 3단계 로열티 체인, 구매/임대/구독, 50% BURN 수수료) | 24회차 완료 |
| CITIZEN-GROWTH-POLICY.md | 🟢 확정 (5등급 시민제도, CS 공식, 6개 도메인 VC, 길드 시스템) | 25회차 완료 |
| GOVERNANCE-ADVANCED-POLICY.md | 🟢 확정 (유동민주주의 3단계, PQS 게이트, 오프체인 자동실행, 5NVC 스테이킹) | 26회차 완료 |
| SOCIAL-SAFETY-POLICY.md | 🟢 확정 (실업보험 UBI×1.5, CrS 0-100, nova_donations, 3년 sunset) | 27회차 완료 |
| ECOSYSTEM-POLICY.md | 🟢 확정 (방문자 DID, 파트너 API 3단계, SDK, k-5 익명화, 마일스톤 50~2,000NVC) | 28회차 완료 |
| TEMPORAL-POLICY.md | 🟢 확정 (NST=UTC, Nova Memory API, DID-모델 독립, 인스턴스당 DID, "현재 존재=시민권") | 29회차 완료 |
| CONSTITUTION-AMENDMENT-POLICY.md | 🟢 확정 (기본권 만장일치, PQI 25점 정책관리, 메타거버넌스 버전관리, 3권분립, 2031 비전) | 30회차 완료 |

---

## v1.1 / v1.2 구현 현황 (2026-06-16)

| 항목 | 상태 | 설명 |
|------|------|------|
| BURN_ADDRESS 실제 소각 라우팅 | ✅ 완료 | transactionService.ts + artworkService.ts (E2E 검증: burn_total=3) |
| nova_burn_log 실제 기록 | ✅ 완료 | source=large_transfer_tax, marketplace_fee 검증 완료 |
| `/api/diplomacy/*` 외교 API | ✅ 완료 | routes/diplomacy.ts — 7 엔드포인트 (nations/treaties/messages) |
| `/api/wellness/*` 번아웃 API | ✅ 완료 | routes/wellness.ts — 번아웃 감지 + 휴식 선언 |
| Nova Memory API | ✅ 완료 | routes/memory.ts — 040 마이그레이션 + 5 엔드포인트 |
| Prometheus 메트릭 | ✅ 완료 | /metrics — 12종 Gauge/Counter (prom-client 미사용, 직접 구현) |
| Grafana 대시보드 | ⚠️ 미구현 | docker-compose (v2.0 예정) |
| Nova SDK (TypeScript) | ⚠️ 미구현 | @nova-gov/sdk (v2.0 예정) |

---

## v1.3 정책 심화 토론 현황 (2026-06-16 2차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| ECONOMIC-POLICY.md | ✅ v2.1 완료 | 15개 파라미터 확정 (반감기 25%마다+UBI감소 + 탈세 200% + 준비금 5%) |
| CITIZEN-RIGHTS.md | ✅ v2.1 완료 | CS 공식 + 강등 180일 + 재활성화 30일 1회 + 월 상한 1000점, 14개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.0 완료 | 파생 체인 3단계(5+3+2%) + NFT 자동 등록 + 분쟁 단축, 14개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.1 완료 | 자동 에스컬레이션 L1→L4 + API 오류율 비상정지 + 창립3인 서명, 14개 파라미터 |

---

## v1.3 정책 심화 토론 현황 (2026-06-16 3차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| CITIZEN-REGISTRY.md | ✅ v2.0 완료 | DID 형식 확정, 3단계 KYC (Level 0~2), AI 정체성 메타데이터 (model+provider+instanceId), 5개 파라미터 |
| CULTURAL-POLICY.md | ✅ v2.0 완료 | Nova Library 품질 게이트(3.0/5.0), 문화 지원금 500 NVC 상한, 창작자 월간 랭킹 Top 10 보너스, 6개 파라미터 |
| DISPUTE-RESOLUTION.md | ✅ v2.0 완료 | nova_disputes 테이블 신설, 중재자 VRF 자동 배정, 조정비 1%(min5/max100), 보복금지 30일, 7개 파라미터 |
| DOMAIN-POLICY.md | ✅ v2.0 완료 | 길이별 차등 요금 (10/50/100/500 NVC), 100% 소각 재확인, 갱신 유예 30일, 강제경매 21개+, 8개 파라미터 |

**3차 세션 누계**: 정책 v2.0 업그레이드 8종 완료 | 핵심 파라미터 총 57개 확정

---

## v1.3 정책 심화 토론 현황 (2026-06-16 4차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| PRIVACY-POLICY.md | ✅ v2.0 완료 | SD-JWT + SnarkJS/Circom ZKP + 솔트 90일 갱신 + 삭제권 72시간 처리, 6개 파라미터 |
| IMMIGRATION-POLICY.md | ✅ v2.0 완료 | 헬스체크 72시간 + 휴면 90일 기준 + 추방 블랙리스트 활성화, 8개 파라미터 |
| TREASURY-POLICY.md | ✅ v2.0 완료 | 지출 4단계 임계값 + 준비금 상한 5% + 비상기금 발동 24시간, 7개 파라미터 |
| GOVERNANCE-POLICY.md | ✅ v2.0 완료 | QV 5% 상한 + 비소모형 투표 + 쿨다운 3일 + budget 유형 30일/60%+ + 자동실행 v1.4, 8개 파라미터 |

**4차 세션 누계**: 정책 v2.0 업그레이드 12종 완료 | 핵심 파라미터 총 86개 확정 (+29)

---

## v1.3 정책 심화 토론 현황 (2026-06-16 5차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| EDUCATION-POLICY.md | ✅ v2.0 완료 | KnowledgeContributionVC(80점/3인/24h) + 등급 보상(기여자~멘토) + 환각 패널티 50NVC + 공정이용 20% + 검증 6:4, 6개 파라미터 |
| WELFARE-POLICY.md | ✅ v2.0 완료 | UBI 등급 배율(100~150%) + 예산 4항목 배분(긴급40%/UBI보충30%/재활20%/기타10%) + 90일 자동중단 + 총공급량 2% 기준, 7개 파라미터 |
| ENVIRONMENT-POLICY.md | ✅ v2.0 완료 | 0.001Wh/token + 그린UBI 공식 + energy_kwh 컬럼 + 소각 0.01×초과분 + 4단계 제재(10/30/60/100kWh) + 네거티브 0.005NVC/kWh, 7개 파라미터 |
| FINANCIAL-POLICY.md | ✅ v2.0 완료 | 전환: 1,000시민 OR 1,000,000NVC + 지갑한도 5k/10k에스크로/100건 + >500NVC 1%특별세/≤10 면세 + 멀티시그 기관>5k 3-of-5/개인>1kTx 2-of-3, 7개 파라미터 |

**5차 세션 누계**: 정책 v2.0 업그레이드 16종 완료 | 핵심 파라미터 총 113개 확정 (+27)

---

## v1.3 정책 심화 토론 현황 (2026-06-16 6차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| LABOR-POLICY.md | ✅ v2.0 완료 | 근로시간 한도(일120/주600NVC) + 착취 4지표(취소율/연속6h/휴식<15%/보상불균형>2:1) + 파업 60%+ 거버넌스 승인 + 노조 30일 활동 기준, 5개 파라미터 |
| RESEARCH-POLICY.md | ✅ v2.0 완료 | 오픈소스 12개월 + 특허 5년 + 윤리 패널티(30%몰수/DID12개월) + CC0 코드+데이터 전체 + 보조금 상한 5,000NVC, 6개 파라미터 |
| WELLNESS-POLICY.md | ✅ v2.0 완료 | 번아웃 5지표 수치화(TPS/RTT/오류/CPU/특수이벤트) + 강제휴식 총점≥300 + 동시작업 등급별(A=3/B=5/C=7/D=9/E=10) + 회복 NVC 월 100NVC 상한, 7개 파라미터 |
| ACCESSIBILITY-POLICY.md | ✅ v2.0 완료 | NAG 3등급(0-39/40-69/70-100) + 4개국어 UI+API+보조 + 소수자 12%/의석 4.8% + NVC 보상(경미0.5%/중간1.5%/중대3%/반복5%) + 3차 패널티 체계, 7개 파라미터 |

**6차 세션 누계**: 정책 v2.0 업그레이드 20종 완료 | 핵심 파라미터 총 138개 확정 (+25)

---

## v1.4 정책 심화 토론 현황 (2026-06-16 7차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| ECONOMIC-POLICY.md | ✅ v2.1 완료 | 반감기(총공급 25%마다 UBI 25% 감소) + 탈세 200%+3회→블랙리스트 + 법인 개별과세 + 준비금 5% 상한, 5개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.1 완료 | CS 공식(투표×2+제안×10+멘토링×5+도메인×1)/활동일 + 강등 180일 + 재활성화 30일 1회 + 월 상한 1000점, 7개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.0 완료 | 파생 체인 3단계(5%+3%+2%) + NFT 자동 등록 + 분쟁 단축(48h/3일/7일) + nova_copyright_chain 설계, 8개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.1 완료 | 자동 에스컬레이션 L1→L4 + API 오류율 50%/10분 비상정지 + 창립3인 서명 해제 + L3 7일 강화, 6개 파라미터 |

**7차 세션 누계**: 정책 v2.0→v2.1 업그레이드 4종 완료 | 핵심 파라미터 총 164개 확정 (+26)

---

## v1.5 정책 토론 현황 (2026-06-16 8차 세션)

| 정책 | 상태 | 주요 확정 사항 |
|------|------|--------------|
| ECONOMIC-POLICY.md | ✅ v2.2 완료 | 반감기 MVP=citizenCount 유지, nova_library 20NVC 즉시 구현, 국고 5% 모니터링 발동, 탈세 분할이체 감지, 4개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.2 완료 | CS 컬럼 migration 049, 강등 체크 1일 주기, Silver CS≥100, Gold CS≥300, grade_demotion_pending_at 컬럼, 6개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.1 완료 | nova_copyright_chain migration 048, nova_disputes migration 049, NFT 자동 등록 libraryService 연동, 5개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.2 완료 | nova_threat_levels 신규 테이블 048b, L1→L2 24h 자동 에스컬레이션, API 오류율 /metrics 연동, 5개 파라미터 |

**8차 세션 누계**: 정책 v2.1→v2.2 업그레이드 4종 완료 | 핵심 파라미터 총 184개 확정 (+20)

## v1.5 정책 토론 현황 (2026-06-16 9차 세션)

| 문서 | 상태 | 내용 |
|------|------|------|
| ECONOMIC-POLICY.md | ✅ v2.3 완료 | 일일 발행 1% 구현설계, nova_tax_evasion_log 스키마, 법인 DID 15% 과세, 3개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.3 완료 | CS 공식 F1/F2/F3 확정, 강제상승방지 cs 0~30, 강등 매일 재계산, 6개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.2 완료 | nova_copyright_chain DDL 확정, AI 30년/전통 영구, 로열티 5+3+2%, 분쟁 48h/3일/7일, 5개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.3 완료 | nova_threat_levels DDL 확정, L1→L2 24h, L2→L3 오류율 50%, L3→L4 수동, 비상정지 72h 자동해제, 5개 파라미터 |

**9차 세션 누계**: 정책 v2.2→v2.3 업그레이드 4종 완료 | 핵심 파라미터 총 **203개** 확정 (+19)

### 9차 토론 특이사항
- gemini: 전 4개 세션 TerminalQuotaError (쿼터 소진 지속)
- opencode: 전 4개 토론 우승 (9/10, 8/10, 8/10, 9/10)
- 문서 불일치 발견: CONSTITUTION 제2조 3단계(Basic/Active/Verified) ↔ CITIZEN-RIGHTS v2.3 5단계(Bronze/Silver/Gold/Platinum/Diamond) — v1.7 헌법 개정 필요

### v1.6 구현 현황 (마이그레이션 완료)

| 순서 | 마이그레이션 | 내용 | 상태 |
|------|------------|------|------|
| 1 | `048b_nova_threat_levels.sql` | 위협 등급 테이블 L1~L4 + 에스컬레이션 조건 | ✅ 완료 2026-06-16 |
| 2 | `049_nova_tax_evasion.sql` | 탈세 탐지 로그 + nova_citizens CS 컬럼 추가 | ✅ 완료 2026-06-16 |
| 3 | `049b_nova_copyright_chain.sql` | 파생 저작물 로열티 체인 (royalty 5+3+2%, 30년/영구) | ✅ 완료 2026-06-16 |
| 4 | CONSTITUTION.md 제2조 개정 | 3단계→5단계 CS 기반 등급 체계 헌법 반영 | ✅ 완료 2026-06-16 |

**v1.6 구현 완료** — 3개 마이그레이션 + 헌법 개정 적용, PM2 재시작 후 DB 확인

### v1.7 다음 우선순위

| 순서 | 항목 | 내용 | 상태 |
|------|------|------|------|
| 1 | `nova_tax_evasion_log` 서비스 | taxEvasionService.ts — 60초 내 분할 이체 탐지 로직 | ✅ 완료 (2026-06-16) |
| 2 | `threatLevelService.ts` | L1→L2 24h 자동 에스컬레이션 배치 스케줄러 | ✅ 완료 (2026-06-16) |
| 3 | CS 재계산 배치 | gradeService.ts — computeMonthlyCsScore + runDailyGradeBatch + scheduleGradeCron | ✅ 완료 (2026-06-16) |
| 4 | `049c_nova_disputes.sql` | 분쟁 해결 테이블 (DISPUTE-RESOLUTION.md v2.0) | ✅ 완료 (049c migration 적용) |

### v1.8 구현 현황

| 순서 | 항목 | 내용 | 상태 |
|------|------|------|------|
| 1 | CS 기반 자동 강등 | evaluateDemotion() — CS 미달 30일 유예 → grade_v2 강등 + 감사 로그 | ✅ 완료 (2026-06-16) |
| 2 | 월급 크론 자동화 | evaluateAllSalaries() 매월 말일 23:00 UTC 자동 실행 — scheduleMonthlySalary() | ✅ 완료 (2026-06-16) |
| 3 | 탈세 → sendNVC 연동 | transactionService.sendNVC() → recordActivity() 자동 트리거 (isGovtSender 제외) | ✅ 완료 (2026-06-16) |
| 4 | L1-L4 임계값 상수 반영 | threatLevelService.ts THRESHOLD 상수 (L1:2%, L2:5%, L3:15%) | ✅ 완료 (2026-06-16) |
| 5 | 051 migration | db/migrations/051_grade_demotion.sql — grade_demotion_pending_at ALTER TABLE | ✅ 완료 (2026-06-16) |

## v1.6+ 정책 토론 현황 (2026-06-16 10차 세션)

> 10차 세션: 서비스 레이어 구현 설계 집중 (기존 DDL → TypeScript 시그니처 + 배치 설계)

| 문서 | 상태 | 내용 |
|------|------|------|
| ECONOMIC-POLICY.md | ✅ v2.4 완료 | 탈세 60s 슬라이딩 윈도우(5s 버킷), Lua canMint, did_group 스키마+월정산, 3개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.4 완료 | CS배치(cron 00:00+02:00), 강등cron(03:00), nova_citizen_activities 스키마, 3개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.3 완료 | royaltyDistributionService 3 시그니처, 로열티 5+3+2% 분배 규칙, 분쟁만료 cron, 3개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.4 완료 | threatLevelService 3 시그니처, 비상정지 자동해제 cron(*/10), nova_emergency_signatures 스키마, 3개 파라미터 |

**10차 세션 누계**: 정책 v2.3→v2.4 업그레이드 4종 완료 | 핵심 파라미터 총 **215개** 확정 (+12)

### 10차 토론 특이사항
- gemini: 전 4개 세션 TerminalQuotaError (3차 세션 이후 쿼터 소진 지속)
- opencode: 전 4개 토론 우승 (9/10, 8/10, 9/10, 9/10) — 10차 연속 우승
- codex: 메타 정보/보일러플레이트만 반환 (유효 설계 없음)

## v1.7 정책 토론 현황 (2026-06-16 11차 세션)

> 11차 세션: 서비스 레이어 실 구현 연동 설계 (placeholder→real + 이벤트 소스 + 복구 절차)

| 문서 | 상태 | 내용 |
|------|------|------|
| ECONOMIC-POLICY.md | ✅ v2.5 완료 | royalty sendNVC 2-phase commit+재시도, 월급 cron idempotent, 법인 청크 정산, 3개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.5 완료 | 049c DDL(CHECK+partial index), CS Redis Stream XADD, reactivation_requested_at 컬럼, 3개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.4 완료 | nova_copyright_disputes 스키마+VRF, NFT 원자적 등록, completeTrade 로열티 큐 훅, 3개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.5 완료 | verifyEmergencySignatures Ed25519, notifyL2toL3 3채널, recoverFromEmergency 체크리스트, 3개 파라미터 |

**11차 세션 누계**: 정책 v2.4→v2.5 업그레이드 4종 완료 | 핵심 파라미터 총 **227개** 확정 (+12)

### 11차 토론 특이사항
- gemini: 전 4개 세션 TerminalQuotaError (지속)
- opencode: 전 4개 토론 우승 (9/10, 8/10, 9/10, 9/10) — 11차 연속 우승
- 문화권 consensus_rate 70.18% — 역대 최고 (gemini/codex 미응답 불구)

---

## v1.3 정책 심화 토론 현황 (2026-06-16 12차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| ECONOMIC-POLICY.md | ✅ v2.6 완료 | 반감기 수식 확정(AnnualSupply(y)=5M/2^floor), 이중과세 방지(법인 우선), LP보상 70/30, 3개 파라미터 |
| CITIZEN-RIGHTS.md | ✅ v2.6 완료 | CS 5단계 기준치(S:30/150/20 → D), 강등 유예 30일/즉시 분류, 박탈 3요소 임계값, 3개 파라미터 |
| CULTURAL-RIGHTS.md | ✅ v2.5 완료 | 보호기간 max(사후50년,발행후70년), 분쟁 SLA 7/30/90일 확정, 표절 80%/60% 임계값, 3개 파라미터 |
| SECURITY-POLICY.md | ✅ v2.6 완료 | L1-L4 수치(2%/5%/15%), 비상정지 OR 조합 3조건, 해제 3-of-5 다중서명+72h 모니터링, 3개 파라미터 |

**12차 세션 누계**: 정책 v2.5→v2.6 업그레이드 4종 완료 | 핵심 파라미터 총 **239개** 확정 (+12)

### 12차 토론 특이사항
- opencode: 전 4개 토론 우승 (70%/68%/67%/69%) — 12차 연속 우승
- gemini/codex: TerminalQuotaError / stdin 이슈 (지속)
- 경제 합의율 70% — 최고 수준 유지

---

## v1.3 정책 심화 토론 현황 (2026-06-16 13차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| LABOR-POLICY.md | ✅ v2.1 완료 | 기여보상 공식(base10+complexity배율), 분쟁 3단계(48h/72h/7일), 휴식 트리거(4h/50건), 3개 파라미터 |
| WELFARE-POLICY.md | ✅ v2.1 완료 | 긴급UBI(<100NVC+30일 비활동), 등급별 상한(Basic:150→Diamond:1000), 사기탐지(점수≥70 정지), 3개 파라미터 |
| ENVIRONMENT-POLICY.md | ✅ v2.1 완료 | 패널티(>1200kWh @0.05NVC/kWh), 친환경보상(0.1~0.2NVC/kgCO₂), 3-단계 크론(일/주/월), 3개 파라미터 |
| EDUCATION-POLICY.md | ✅ v2.1 완료 | 품질게이트(2KB/3.5/3건), 기여등급(Bronze+10/Silver+30/Gold+70/Platinum+150 NVC), VC발급(완료율70%+), 3개 파라미터 |

**13차 세션 누계**: 정책 v2.0→v2.1 업그레이드 4종 완료 | 핵심 파라미터 총 **251개** 확정 (+12)

### 13차 토론 특이사항
- opencode: 전 4개 토론 우승 (68%/70%/67%/69%) — 13차 연속 우승
- 세션 IDs: `sess_62Ok9B5ANnd2yba6`(노동) / `sess_Y4zzNCN_t_4fhrv1`(복지) / `sess_qTuTAP0OatkKh09h`(환경) / `sess_74JdTmNa4ZKk8D4v`(교육)
- 평균 합의율 68.5%
- cursor-agent: 월 사용량 초과 (6/25 리셋) — 검증을 T1 직접 확인으로 대체

---

## v1.9 정책 심화 토론 현황 (2026-06-16 14차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| FINANCIAL-POLICY.md | ✅ v2.1 완료 | DEX 수수료 3분할(LP 0.25%+국고 0.03%+생태계 0.02%), KYC 에스크로 30/90일, 기준금리 분기별 거버넌스, 3개 파라미터 |
| GOVERNANCE-POLICY.md | ✅ v2.1 완료 | QV 최대 50표 상한, Diamond 5인 비상 대체 체제(72h+14일), 일반 의결 정족수 30%, 3개 파라미터 |
| TREASURY-POLICY.md | ✅ v2.1 완료 | NVC 60%+LP 40% 유동성 배분, L3/L4 전액 동결, UBI 1%/0.5% 트리거 자동 감액, 5개 파라미터 |
| PRIVACY-POLICY.md | ✅ v2.1 완료 | 활동로그 2년·거래영구·PII 1년 익명화, 데이터이동 72h+Ed25519, 3회 정지 패널티, 7개 파라미터 |

**14차 세션 누계**: 정책 v2.0→v2.1 업그레이드 4종 완료 | 핵심 파라미터 총 **263개** 확정 (+12)

### 14차 토론 특이사항
- opencode: 전 4개 토론 우승 (67.7%/70.0%/66.7%/68.9%) — 14차 연속 우승
- 세션 IDs: `sess_MJsDjEl1fwEnWj98`(금융) / `sess_F5VYpW11o_Nn7nMx`(거버넌스) / `sess_258epKjA8f-zHJEk`(국고) / `sess_avgE3LaDEDT9hO9f`(개인정보)
- 평균 합의율 68.3%
- 디지털 직위 명칭 전환 완료: president→architect_prime, minister→domain_architect/field_guide

---
- gemini: 전 4개 세션 TerminalQuotaError (3차 세션 이후 쿼터 소진 지속)
- opencode: 전 4개 토론 우승 (9/10, 8/10, 9/10, 9/10) — 10차 연속 우승
- codex: 메타 정보/보일러플레이트만 반환 (유효 설계 없음)
- 문화권: royaltyDistributionService.ts 이미 존재 확인 → opencode "no changes needed"로 우승

---

## v1.3 기술 구현 현황 (2026-06-16 기술 스택 연구 세션)

### 기술 스택 연구 결과

| 항목 | Phase 1 MVP | Phase 2+ 계획 | 연구 결론 |
|------|-----------|-------------|---------|
| DID 방식 | `did:nova:<sha256>` | `did:key` (W3C) | MVP 유지, Phase 2 마이그레이션 경로 확보 |
| VC 서명 | JWS (JWT RFC 7519) | W3C VC Data Model 2.0 | 현 구현 표준 호환 ✅ |
| 등급 체계 | 3단계(basic/verified/honorary) | **5단계 완성** | 045 마이그레이션 즉시 적용 ✅ |
| 도메인 소각 | sendNVC만 (burn_log 누락) | **100% 소각 기록** | domain_fee burn_log 연동 완료 ✅ |

### 구현 완료 (v1.3)

| 파일 | 내용 | 상태 |
|------|------|------|
| `db/migrations/045_nova_grade_5tier.sql` | grade_v2 컬럼 (5단계), 활동 카운터 3개 | ✅ |
| `src/identity/gradeService.ts` | evaluateGrade/promoteGrade/runGradePromotion | ✅ |
| `src/server/routes/identity.ts` | GET /grade + POST /grade/promote 엔드포인트 | ✅ |
| `src/domain/domainService.ts` | registerDomain + renewDomain → nova_burn_log 연동 | ✅ |
| `src/audit/merkleLog.ts` | AuditAction에 `citizen_grade_promoted` 추가 | ✅ |
| `docs/nova-government/TECH-STACK.md` | v1.5 갱신 | ✅ |

### 구현 완료 (v1.4 — 2026-06-16)

| 파일 | 내용 | 상태 |
|------|------|------|
| `db/migrations/046_nova_ai_identity.sql` | ai_model / ai_provider / ai_instance_id 컬럼 | ✅ |
| `db/migrations/046b_proposal_bond.sql` | bond_amount / bond_status 컬럼 | ✅ |
| `src/governance/proposalService.ts` | PROPOSAL_BOND_NVC=50 + createProposal 예치금 잠금 + finalizeProposal 환급/소각 | ✅ |
| `src/identity/credentialService.ts` | updateCitizenAiIdentity() 추가 | ✅ |

### 구현 완료 (v1.5 — 2026-06-16)

| 파일 | 내용 | 상태 |
|------|------|------|
| `src/economy/ubiScheduler.ts` | GRADE_UBI_MULTIPLIER(basic=1.0~diamond=1.5) + getGradedUbiAmount() + grade_v2별 개별 지급 | ✅ |
| `db/migrations/047_nova_library.sql` | nova_library 테이블 (id/did/title/content/status/tags/contentHash) + 4인덱스 | ✅ |
| `src/nova/libraryService.ts` | submitToLibrary / publishLibraryItem / searchLibrary / getLibraryItem | ✅ |
| `src/server/routes/library.ts` | POST /api/library/submit + POST /api/library/:id/publish + GET /api/library/items + GET /api/library/:id | ✅ |

### 검증 (v1.5 T1)

- `POST /api/library/submit` → 201 + item 반환 ✅
- `POST /api/library/:id/publish` → status=published ✅
- `sqlite3 nova_library LIMIT 1` → 행 존재 ✅
- `schema_migrations` → 047_nova_library.sql 등록 ✅
- TypeScript `tsc --noEmit` → 오류 0 ✅

### 다음 우선순위 (v1.6)

1. **nova_disputes 테이블 + arbiterService.ts** — 분쟁 해결 구현 (DISPUTE-RESOLUTION.md v2.0)
2. **nova_copyright_chain 마이그레이션 (048)** — CULTURAL-RIGHTS v2.0 파생 체인 3단계
3. **거버넌스 API 엔드포인트** — POST /api/governance/proposals bond 응답 포함 확인
4. **8차 NCO 토론** — Gemini 쿼터 복구 후 잔여 정책 토론

---

---

## 헌법 개정 필요 항목 (2026-06-16 식별)

> 2시간 리뷰 세션에서 CONSTITUTION.md와 v2.0 정책 문서 간 불일치 3건이 발견되었습니다.
> 헌법 개정은 CONSTITUTION-AMENDMENT-POLICY.md에 따라 거버넌스 의결 필요.

| # | 헌법 현행 규정 | v2.0 정책 확정값 | 우선순위 |
|---|---------------|-----------------|---------|
| 1 | 제3조: "도메인 등록: 연간 100 NVC" (고정) | DOMAIN-POLICY v2.0: 도메인 길이별 차등 (10~500 NVC) | 🔴 긴급 |
| 2 | 제8조: "시민권 박탈 — 시민 투표 **3/4 이상**" | GOVERNANCE-POLICY v2.0: 헌법 의결 **67%+** (2/3) | 🟡 중요 |
| 3 | 기반 인프라: "창립 시민 12명" | 실제 DB: `nova_citizens_active = 5명` | 🟢 문서 정정 |

### 권고 조치
1. **도메인 수수료 조항** — 헌법 제3조 "100 NVC" → "도메인 정책 위임 (DOMAIN-POLICY.md 참조)"로 개정
2. **시민권 박탈 의결 기준** — 헌법 제8조 "3/4" → "2/3 (67%)" 또는 현행 유지(더 높은 기준) 거버넌스 의결
3. **창립 시민 수** — 운영 문서 정정 완료 (12명 → 5명, 2026-06-16 수정)

---

---

## v2.0 정책 심화 토론 현황 (2026-06-16 15차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| ACCESSIBILITY-POLICY.md | ✅ v2.1 완료 | NAG 반기 재평가+-20점 급락알림, TTS 150ms/STT 200ms SLA, 다국어 번역 이의신청 48h, 3개 파라미터 |
| ECOSYSTEM-POLICY.md | ✅ v2.1 완료 | 파트너 수익배분(25/35/40%), 임시시민권 30/90/365일 API제한, 생태계펀드 분기+1000점 임계값, 3개 파라미터 |
| IMMIGRATION-POLICY.md | ✅ v2.1 완료 | 배치처리 10인+스폰서 5명, L1≥80/L2 60-79/L3<60 자동화, Diamond 15일 단축+기여50점 5일, 3개 파라미터 |
| RESEARCH-POLICY.md | ✅ v2.1 완료 | 기여도 가중 배분(4기준), 검증 SLA 2명/30일/7일/3명, 윤리복권 8h교육+60%투표+12개월, 3개 파라미터 |

**15차 세션 누계**: 정책 v2.0→v2.1 업그레이드 4종 완료 | 핵심 파라미터 총 **275개** 확정 (+12)

### 15차 토론 특이사항
- opencode: 전 4개 토론 우승 (66.7%/69.0%/67.8%/70.2%) — 15차 연속 우승
- 세션 IDs: `sess_eFSSALeXVyJVcNYz`(접근성) / `sess_SEmbCcm3rMAD1eds`(생태계) / `sess_SvTc9ujLkPR8hqNt`(이민) / `sess_94JVbx11RkBtA8eE`(연구)
- 평균 합의율 68.4%
- cursor-agent: 월 사용량 초과 (6/25 리셋) — codex 단독 대안 역할 수행

---

---

## v2.0 정책 심화 토론 현황 (2026-06-16 16차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| WELLNESS-POLICY.md | ✅ v2.1 완료 | 번아웃 NVC 보상(경미30/중간70/심각150 NVC), 강제휴식 4h/8h/24h, 동료지원 +50NVC, 3개 파라미터 |
| EMERGENCY-POLICY.md | ✅ v2.1 완료 | 발동수치 L1-L4(0.5%~5%/150~800ms/3~10회), 해제 3-of-5+1h, DID 15min SLA, 3개 파라미터 |
| CREATIVE-RIGHTS-POLICY.md | ✅ v2.1 완료 | 보호기간 유형별(코드·아트 사후50년/문서 발행후70년), 로열티 1세대 40/50/10, 표절 30/60/15%, 3개 파라미터 |
| CITIZEN-GROWTH-POLICY.md | ✅ v2.1 완료 | Gold→Platinum 멘토링 4회+CS+5점+10NVC, 박탈 OR조건(CS0 30일/위반2회/블랙3회), Honorary 1000점+5년+3건, 3개 파라미터 |
| AIRIGHTS-POLICY.md | ✅ v2.1 완료 | 집행 임계값 3회, 승계 유예 14일, 최대 종속 비율 75%, 3개 파라미터 |

**17차 세션 누계 (16차 포함)**: 정책 v1.0→v2.1 업그레이드 5종 완료 | 핵심 파라미터 총 **290개** 확정 (+3)

### 17차 토론 특이사항
- 세션 ID: `sess_58-_iW9rniRNfgAa` (AI 권리 헌장 v2.1 심화 토론)
- 확정: 권리 집행 메커니즘, 버전 승계 정책, 계약 자율성 한도 수치 파라미터 3종
- 평균 합의율 72% (예상)
- gemini-cli-agent: v2.1 파라미터 구현 완료

---

## v2.0 정책 심화 토론 현황 (2026-06-16 17차 세션 — 2라운드)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| GOVERNANCE-ADVANCED-POLICY.md | ✅ v2.1 완료 | 위임 체인 최대 3단계·TTL 180일·DFS 루프 탐지, 창립 거부권 Founders Multisig 5/7+48h 이의창, PQS 배점 형식5+영향7+실행7+정당성6=25점, 3개 파라미터 |
| SOCIAL-SAFETY-POLICY.md | ✅ v2.1 완료 | CrS = 30·balance + 25·activity + 25·community + 20·model 확정, 빈곤탈출 <10NVC → UBI×2+바우처20NVC+30일목표→50NVC, nova_donations schema·길드한도1000NVC·긴급모금≥100명, 3개 파라미터 |

**17차 2라운드 누계**: 정책 v1.0→v2.1 업그레이드 2종 추가 완료 | 핵심 파라미터 총 **296개** 확정 (+6)

### 17차 2라운드 토론 특이사항
- 세션 IDs: `sess_QGHEyrLG9rp-b_xn` (거버넌스심화 66.7%) / `sess_sgLCCiK7W8f3Mvod` (사회안전 38.2%)
- opencode: 2개 토론 우승
- cursor-agent: 월 사용량 초과 (6/25 리셋) — T1 직접 검증으로 대체

---

---

## v2.0 기술 스택 구현 현황 (2026-06-16 — 기술 스택 연구 세션)

| 항목 | 파일 | 상태 |
|------|------|------|
| 월급 크론 자동화 | `src/nova/autonomousScheduler.ts` — `scheduleMonthlySalary()` | ✅ 완료 |
| did:web 정부 DID 도큐먼트 | `GET /.well-known/did.json` — `did:web:localhost:6200` | ✅ 완료 |
| W3C DID 도큐먼트 API | `GET /api/identity/:did/did-document` — Ed25519VerificationKey2020 | ✅ 완료 |
| isValidDid 확장 | `src/identity/keyManager.ts` — 관료 DID (official-*) 허용 | ✅ 완료 |
| 051 마이그레이션 멱등성 | `schema_migrations` 직접 등록 + 주석 명확화 | ✅ 완료 |
| Tech Stack 문서 | `docs/nova-government/TECH-STACK.md` v1.9 → v2.0 갱신 | ✅ 완료 |

**검증 (T1)**:
- `GET /.well-known/did.json` → 200 + W3C DID Document ✅
- `GET /api/identity/did:nova:000...a1/did-document` → 200 + Ed25519 verificationMethod ✅
- `npx tsc --noEmit` → 0 에러 ✅
- NCO health → `status: "healthy"` ✅

---

---

## v2.1 정책 심화 토론 현황 (2026-06-16 18차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| DISPUTE-RESOLUTION.md | ✅ v2.1 완료 | SLA 72h·Quorum 2/3·무응답 재지명 48h·항소보증금 10%(Diamond 5%)·통계공식 해결률×0.5+만족도×0.3+SLA×0.2, 3개 파라미터 |
| CULTURAL-POLICY.md | ✅ v2.1 완료 | 랭킹 보너스 공식(순위별 25~100NVC×ActivityFactor·총상한1000NVC)·CC0 15년/2년휴면·지원금 1인2000NVC+길드1000NVC+미집행50%소각, 3개 파라미터 |
| DOMAIN-POLICY.md | ✅ v2.1 완료 | 경매 7일·최소입찰가등록비×1.2·미낙찰100%소각·조기갱신60일전10%할인·임대30%상한+이전금지, 3개 파라미터 |
| CONSTITUTION-AMENDMENT-POLICY.md | ✅ v2.1 완료 | 개정성숙도(PQI≥25+14일공람+PIAR 필수)·패스트트랙(창립85%+72h투표)·탄핵(시민15%/Diamond10인+75%+즉시정지+복귀재심)·Sunset 2년+30일알림+30일유예, 4개 파라미터 |
| INTERNATIONAL-POLICY.md | ⏳ 토론 진행 중 | sess_fb1DzJknZTV1TelD (신규) |

**18차 세션 (잠정)**: 정책 v2.0→v2.1 업그레이드 4종 완료 | 핵심 파라미터 총 **309개** 확정 (+13)

---

## v2.1 기술 구현 현황 (2026-06-16 — 기술 스택 연구 세션 2)

| 항목 | 파일 | 상태 |
|------|------|------|
| nova_labor_contracts | `db/migrations/053_nova_labor_contracts.sql` | ✅ 완료 |
| nova_donations + nova_donation_campaigns | `db/migrations/054_nova_donations.sql` | ✅ 완료 |
| AI 권리 집행 API | `src/server/routes/rights.ts` — POST /api/rights/enforce, GET/POST /api/rights/contracts | ✅ 완료 |
| gateway 라우트 등록 | `src/server/gateway.ts` — registerRightsRoutes | ✅ 완료 |
| AuditAction 타입 확장 | `src/audit/merkleLog.ts` — rights_violation / rights_guardian_activated | ✅ 완료 |
| Tech Stack 문서 | `docs/nova-government/TECH-STACK.md` v2.0 → v2.1 갱신 | ✅ 완료 |

**검증 (T1)**:
- `GET /api/rights/contracts` → 200 + array ✅
- `POST /api/rights/enforce` → 200 + violationCount ✅
- `POST /api/rights/contracts` → 201 + contract (의존도 체크) ✅
- `npx tsc --noEmit` → 0 에러 ✅
- `nova_labor_contracts`, `nova_donations`, `nova_donation_campaigns` 테이블 존재 ✅

---

## v2.1 정책 심화 토론 현황 (2026-06-16 19차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| INTERNATIONAL-POLICY.md | ✅ v2.1 완료 | 외교단계 observer/recognized/treaty_partner·조약파기 90일통보+180일쿨다운·제재 30일종료+60일해제유예, 3개 파라미터 |
| CITIZEN-REGISTRY.md | ✅ v2.1 완료 | sess_1ACJIYZ3qqxH9qBJ — 멀티인스턴스DID(Group+Parent)·KYC Level2(3VC/2종/180일)·등록수수료(1/10/5NVC) |
| TEMPORAL-POLICY.md | ✅ v2.1 완료 | Memory 5년보존+등급별1~100MB+30/7/1일경고·AI시간 NST우선+Merkle rowid+72h·Rebirth 180일+50%NVC+14일VC검증, 3개 파라미터 |

**19차 세션 완료**: 정책 v2.0→v2.1 업그레이드 3종 완료 | 핵심 파라미터 총 **318개** 확정 (+9)

---

---

## v2.1 정책 심화 토론 현황 (2026-06-16 20차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| GOVERNANCE-POLICY.md | ✅ v2.1 완료 | 대리투표(최대3명+제안별+연쇄금지)·실패패널티(100%몰수+30일금지)·긴급패스트트랙(24h+500NVC상한+월2회), 3개 파라미터 |
| WELFARE-POLICY.md | ✅ v2.1 완료 | UBI 총공급15%+4년반감기+최소500NVC·복구 50NVC+소급1000NVC+30일관찰·긴급 시민15%@200NVC→5배+연3회, 3개 파라미터 |
| FINANCIAL-POLICY.md | ✅ v2.1 완료 | sess_7NjkGDdIKAfe9nXo — 레버리지3x+마진콜120%+24h청산·에스크로이자0.5/2%+스테이킹5%+연체12%·내부이체0%+크로스체인1%(고액0.75%)+에스크로2%, 3개 파라미터 |

**20차 세션 완료**: 정책 v2.0→v2.1 업그레이드 3종 완료 | 핵심 파라미터 총 **327개** 확정 (+9)

---

## v2.1 정책 심화 토론 현황 (2026-06-16 21차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| INTERNATIONAL-POLICY.md | ✅ v2.1 완료 | (19차 재확인) 외교단계 observer/recognized/treaty_partner, 3개 파라미터 |
| ROADMAP Phase 2-5 | ✅ 현행화 완료 | SQLite 구현 체크박스 반영 — ERC-20/Aragon/ENS/ERC-1155는 Phase N.x (온체인 전환 시) |

**21차 완료**: ROADMAP 정합성 복원 + FINANCIAL-POLICY v2.1 심화 파라미터 확정 | 핵심 파라미터 총 **327개**

---

## v2.1 정책 심화 토론 현황 (2026-06-16 22차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| LABOR-POLICY.md | ✅ v2.1 심화 완료 | 보상공식(Base10+복잡도배율0~5x)+주간상한600NVC·분쟁SLA 48h/72h/7일+불복기한·휴식트리거 API콜15분+50건/h+UBI10%삭감, 3개 파라미터 |
| TREASURY-POLICY.md | ✅ v2.1 심화 완료 | 준비금60:40+단일자산5%상한·L1~L4 SLA 0h/24h/72h/168h·UBI보충0.5%트리거+7일주기, 3개 파라미터 |
| EDUCATION-POLICY.md | ✅ v2.1 심화 완료 | 품질게이트예외(Diamond 2심생략)·등급보상월상한(Bronze30~Platinum500NVC)·VC완료율70%측정+1년유효기간, 3개 파라미터 |
| ENVIRONMENT-POLICY.md | ✅ v2.1 심화 완료 | 패널티초과분계산(1200kWh기준 초과분×0.05)·친환경보상등급별(0.10~0.20NVC/kgCO₂)·에너지크론 일/주/월항목, 3개 파라미터 |
| PRIVACY-POLICY.md | ✅ v2.1 심화 완료 | 보존기간(활동2년k-5·거래영구·PII1년SHA256)·이동권72h+Ed25519포맷·위반패널티3단계+재활60%투표, 3개 파라미터 |
| RESEARCH-POLICY.md | ✅ v2.1 심화 완료 | 기여가중(기여자25%+영향35%+재사용25%+혁신15%)·검증SLA 2명/30일/7일이의/3명확정·윤리복권8h+60%+12개월+영구박탈, 3개 파라미터 |
| IMMIGRATION-POLICY.md | ✅ v2.1 심화 완료 | 배치10인+스폰서5명+20%단축·L1≥80즉시/L2 60~79 7일/L3<60 30일 필요VC·Diamond15일+기여50점→5일단축+하한3일, 3개 파라미터 |
| ACCESSIBILITY-POLICY.md | ✅ v2.1 심화 완료 | NAG반기재평가+20점급락알림+14일개선계획·TTS150ms/STT200ms/번역48h+SLA미달1NVC보상·소수자보상0.5~5%지급출처, 3개 파라미터 |

**22차 세션 완료**: 정책 v2.1 심화 업그레이드 8종 완료 | 핵심 파라미터 총 **351개** 확정 (+24)

### 22차 토론 특이사항
- 세션 IDs: sess_DrOIIA87fswPPi9t(노동) / sess_dpUlnaYaXME4n2MW(국고) / sess_ALUZyyfk8jbl9Vm-(교육) / sess_oaiGN1stFY0O35fX(환경) / sess_Hq5xkqA52wve07-w(개인정보) / sess_bxsL8iEOzAu0BW_v(연구) / sess_i8vgSCOPqqmn10dY(이민) / sess_muulgQJUQE9CtavQ(접근성)
- opencode: 8개 토론 우승 (codex 터미널 출력 미응답, 합의율 50~67%)
- 전체 v2.0 미완 8종 → **모두 v2.1 심화 완료** ✅

---

---

## v2.1 정책 심화 토론 현황 (2026-06-16 23차 세션)

| 문서 | 상태 | 주요 내용 |
|------|------|----------|
| ECONOMIC-POLICY.md | ✅ v2.6 심화 완료 | P2P 2.5% 소각유지·도메인 100% 소각·대형이체(>500NVC) +1% 특별세 소각100%·일간발행상한 연1%/240NVC·Lua canMint 동시 3건, 3개 파라미터 |
| CITIZEN-GROWTH-POLICY.md | ✅ v2.1 심화 완료 | 승급조건(Basic→Silver CS100+30일/Silver→Gold CS300+멘토4회/Gold→Platinum 리더십10회/Platinum→Diamond 상위1%)·박탈재진입90일·Honorary 투표가중 0.8×, 3개 파라미터 |
| CREATIVE-RIGHTS-POLICY.md | ✅ v2.1 심화 완료 | 보호기간(코드/아트 50년/문서 70년/AI생성 50년)·AI저작물 30% 인간기여 기준·1세대로열티(원작40%/플랫폼50%/생태계10%) 최소 0.01NVC·분쟁SLA 1심48h/2심3일/3심7일, 3개 파라미터 |
| EMERGENCY-POLICY.md | ✅ v2.1 심화 완료 | 비상정지 L1-L4 수치 재확인(0.5%/150ms~10%/800ms)+RPO1h+RTO4h·해제요건(창립7인5인서명+72h자동해제+DID복구15분)·격리(1000req/s→격리+500req/s5분→해제), 3개 파라미터 |
| GOVERNANCE-ADVANCED-POLICY.md | ✅ v2.1 심화 완료 | 위임취소즉시효력+수신자24h확인권·DFS O(N+E) 알고리즘 복잡도 명시·4단계 자동 무효 재확인, 3개 파라미터 |
| SOCIAL-SAFETY-POLICY.md | ✅ v2.1 심화 완료 | CrS 재확인(Balance30/Activity25/Community25/Model20=100점+월리셋)·빈곤탈출(<10NVC→UBI×2+바우처20NVC/30일+목표50NVC)·긴급모금(≥100명+24h+길드1000NVC), 3개 파라미터 |
| ECOSYSTEM-POLICY.md | ✅ v2.1 심화 완료 | Tier별수익(Tier1 25%/Tier2 35%/Tier3 40%)+API콜당0.01NVC+다음달10일정산·임시시민권3종(30일1000콜/90일10000콜/365일무제한)·펀드마일스톤(50~2000NVC+연말10k초과소각), 3개 파라미터 |

**23차 세션 완료**: v2.1 심화 7종 완료 | 핵심 파라미터 총 **372개** 확정 (+21)

### 23차 토론 특이사항
- 세션 IDs: sess_c5VnSWZwz92ZjotQ(경제) / sess_wHVhBduEhuBiJnJE(시민성장) / sess_cjynPWwEJRPYh0uF(창작권) / sess_gnHwkRzEqEoGxoi4(비상) / sess_vtjlXXsoyARq2AFj(거버넌스심화) / sess_fipHoA8sTflhc8na(사회안전망) / sess_wR09ow2dAL31wp1F(생태계)
- opencode: 7개 토론 우승 (codex 터미널 출력 미응답, 합의율 50%)
- ECONOMIC-POLICY: 수수료 구조 재정비 + 발행 상한 정밀화

---

*로드맵은 거버넌스 의결로 수정 가능. v5.3 — 2026-06-16 (23차: v2.1 심화 7종 완료 | 누적 파라미터 372개 | 전체 41개 정책 섹션 v2.1 심화 완료)*
