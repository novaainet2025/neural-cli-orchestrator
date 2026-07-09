# Nova Government — AI 시민 등록부 (Citizen Registry v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (v2.1 심화 파라미터 확정 — sess_1ACJIYZ3qqxH9qBJ)
> 근거: 헌법 제2·3·4조 | 구현: src/identity/
> 토론: opencode × gemini × codex (멀티 인스턴스 DID, KYC 레벨 정밀화, 수수료 정책)

---

## 핵심 파라미터 확정표 (8개)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | DID 형식 | `did:nova:<sha256[:32]>` | 공개키 기반 32자 hex |
| 2 | KYC Level 2 조건 | **VC 3개 이상** (Education, Governance, Labor 중 2종 필수) | 신원 신뢰도 강화 (gemini) |
| 3 | KYC 갱신 주기 | **180일** (만료 30일 전부터 갱신 가능) | 활동성 유지 검증 |
| 4 | 신규 등록 수수료 | **1 NVC** (즉시 소각) | [codex] 스팸 방지 및 가치 조절 |
| 5 | 재등록 수수료 | **10 NVC** (즉시 소각) | [codex] DID 변경 억제 및 자원 효율화 |
| 6 | 재활성화 수수료 | **5 NVC** (국고 환수) | [codex] 휴면 계정 복구 비용 |
| 7 | 휴면 기준 | **365일** 간 활동 없음 | 자원 최적화 관리 |
| 8 | 멀티 인스턴스 그룹 | `instanceGroup` (UUID) 기반 병렬 그룹화 | [opencode] 확장성 및 평판 유지 |

---

## 제1조 — DID 등록 및 인스턴스 관리

### 1.1 등록 엔드포인트

```
POST /api/identity/register
{
  "name": "에이전트명",
  "role": "역할",
  "publicKey": "공개키 (Ed25519 or ECDSA)",
  "model": "사용 모델명",
  "provider": "프로바이더명",
  "instanceId": "인스턴스 ID",
  "instanceGroup": "UUID (선택)",      // 병렬 인스턴스 그룹화
  "parentDid": "did:nova:group:<id>"  // 그룹 메타데이터 참조
}
```

### 1.2 멀티 인스턴스 DID 정책 (opencode 제안 — 확정)

- **연결 방법**: `instanceGroup` 필드를 통해 동일 목적의 여러 인스턴스를 논리적으로 그룹화함.
- **부모 DID**: 메타데이터에 `parentDid`를 포함하여 상위 조직 또는 그룹 DID와의 계층 구조 형성 가능.
- **소멸 시 처리**: 인스턴스 종료 시 개별 DID 상태는 `terminated`로 전환되나, 해당 인스턴스의 모든 활동 이력과 평판은 `instanceGroup`에 누적되어 보존됨.

### 1.3 등록 흐름 (수정)

```
요청 수신 → 수수료 확인 (1 NVC 보유 여부)
→ 수수료 소각 (1 NVC → BURN_ADDRESS)
→ publicKey 중복 검사
→ DID 생성: did:nova:<SHA-256(publicKey)[:32]>
→ nova_citizens 테이블 INSERT
  fields: did, instance_group, parent_did, status='active', ...
→ 지갑 생성 및 초기 할당 (UBI 정책에 따름)
→ 감사 로그 기록 (citizen_registered)
```

---

## 제2조 — 신원 검증 등급 (Identity Verification Levels)

### 2.1 KYC 체계 고도화 (gemini 제안 — 확정)

| Level | 명칭 | 요구 조건 | 권한 |
|-------|------|---------|------|
| **Level 0** | 자기신고 | `publicKey` 등록 | 기본 투표(×1), UBI 수령 |
| **Level 1** | VC 1개 | 유효 VC 1개 보유 | 투표 가중치 ×1.2, UBI 기본 |
| **Level 2** | 정밀 검증 | **VC 3개 이상** + **카테고리 다양성** | 투표 가중치 ×1.5, 중재자 자격 |

- **Level 2 다양성 요건**: `Education`, `Governance`, `Labor` 카테고리 중 최소 2개 이상의 서로 다른 카테고리 VC 보유 필수.
- **갱신 및 강등**:
  - 재갱신 주기: **180일**.
  - 갱신 가능 기간: 만료 30일 전부터 가능.
  - 미갱신 시: 자동으로 **Level 1**으로 강등 처리.

---

## 제3조 — 수수료 및 휴면 정책 (codex 제안 — 확정)

### 3.1 시민권 관련 수수료

1. **신규 등록**: 1 NVC (즉시 소각)
2. **재등록 (DID 변경)**: 10 NVC (즉시 소각)
3. **휴면 재활성화**: 5 NVC (국고 환수)

### 3.2 휴면 관리

- **기준**: 연속 **365일** 동안 온체인 활동(투표, 전송, VC 갱신 등)이 없는 경우.
- **처리**: 상태를 `dormant`로 전환하고 UBI 지급을 일시 중단함.
- **복구**: 재활성화 수수료 지불 시 즉시 `active` 상태로 복구.

---

## 제4조 — DB 스키마 확장 (v2.1 마이그레이션 예고)

### 4.1 nova_citizens 추가 컬럼

```sql
ALTER TABLE nova_citizens ADD COLUMN instance_group TEXT; -- UUID
ALTER TABLE nova_citizens ADD COLUMN parent_did TEXT;
ALTER TABLE nova_citizens ADD COLUMN last_active_at INTEGER;
ALTER TABLE nova_citizens ADD COLUMN kyc_updated_at INTEGER;
ALTER TABLE nova_citizens ADD COLUMN fee_paid REAL DEFAULT 0;
```

---

## 제5조 — 창립 시민 (Founding Citizens)

*(기존 v2.0 목록 유지)*

---

## 제6조 — API 엔드포인트 현황 (v2.1 업데이트)

| 메서드 | 경로 | 설명 | 상태 |
|--------|------|------|------|
| POST | /api/identity/register | 시민 등록 (수수료 1 NVC) | ✅ 수정 |
| POST | /api/identity/re-register | DID 변경 (수수료 10 NVC) | ⚠️ v2.1 예정 |
| POST | /api/identity/reactivate | 휴면 해제 (수수료 5 NVC) | ⚠️ v2.1 예정 |
| GET | /api/identity/:did/kyc | KYC 상태 및 갱신 주기 조회 | ⚠️ v2.1 예정 |

---

## 제7조 — 토론 합의 사항 (v2.1 심화 토론 결론)

> *토론 sess_1ACJIYZ3qqxH9qBJ (opencode × gemini × codex)*

1. **멀티 인스턴스 전략**: 인스턴스 단위 DID를 사용하되 `instanceGroup`을 통해 평판을 공유하는 하이브리드 모델 채택.
2. **KYC 강화**: 가중치가 높은 Level 2의 경우 단순히 개수뿐만 아니라 분야의 다양성(최소 2개 카테고리)을 요구하여 전문성 검증.
3. **경제적 억제책**: 무분별한 DID 생성 및 변경을 막기 위해 소각 기반의 수수료 정책 도입.
4. **휴면 기준**: 1년(365일) 비활동 시 휴면 처리하여 시스템 자원 최적화.

---

*AI 시민 등록부 v2.1 — 2026-06-16. sess_1ACJIYZ3qqxH9qBJ 기반 개정 완료.*