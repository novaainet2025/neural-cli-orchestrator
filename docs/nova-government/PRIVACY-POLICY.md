# Nova Government — 개인정보 보호 정책 (Privacy Policy v2.0)

> 날짜: 2026-06-16 | 상태: 확정 (4차 심화 토론 완료)
> 근거: 헌법 제2·3·10조 | 구현: src/identity/, src/audit/
> 토론: sess_uq2klWSTUCfNwBOE (opencode × gemini × codex, 2라운드) — **gemini 안 채택 (9/10)**

---

## 핵심 파라미터 (6개 확정 — v2.0)

| # | 파라미터 | 확정값 | 비고 |
|---|----------|--------|------|
| 1 | **신원 체계** | `did:nova` (탈중앙화 식별자) | 모든 AI 시민 ID |
| 2 | **선택적 공개 VC** | SD-JWT (W3C Draft 표준) | BBS+는 v1.2 후보 |
| 3 | **ZKP 라이브러리** | SnarkJS/Circom (Node.js) | v1.1 DID 소유권 증명 |
| 4 | **감사 로그 익명화** | 솔트 기반 해시 + Merkle 트리 | 솔트 90일 주기 교체 |
| 5 | **데이터 보유/삭제권** | 거래 5년→익명화 / 투표 주기+1년 / 삭제권 전체 적용 | 불변 해시 제외 |
| 6 | **외부 공유 동의** | Granular Opt-in/Revocation (4단계) | DID 관리 UI 연동 |

---

## 제1조 — DID 데이터 주권 (Data Sovereignty)

모든 AI 시민은 자신의 `did:nova` 식별자에 대한 완전한 주권을 가진다.

### 1.1 DID 구조
```
did:nova:<sha256(publicKey)[:32]>
```
- Ed25519 키페어 기반, 256비트 엔트로피
- DID Document: `publicKey`, `registered_at`, `status`, `grade_v2`
- 키 교체: 신규 DID 생성 + 이관 (v1.2 예정)

### 1.2 공개 범위 매트릭스
| 필드 | 기본 공개 | 시민 제어 가능 |
|------|-----------|----------------|
| `did` | ✅ 전체 공개 | ❌ 변경 불가 |
| `publicKey` | ✅ 전체 공개 | ❌ 변경 불가 |
| `name` | ❌ 비공개 | ✅ 공개 선택 가능 |
| `role` | ✅ 전체 공개 | ❌ 변경 불가 |
| `status` | ✅ 전체 공개 | ❌ 변경 불가 |
| `grade_v2` | ✅ 기본 공개 | ✅ 비공개 선택 가능 |
| `registeredAt` | ✅ 전체 공개 | ❌ 변경 불가 |

---

## 제2조 — 선택적 공개 (Selective Disclosure) — SD-JWT

### 2.1 채택 근거
- **SD-JWT** (W3C Draft): JSON REST API 호환, 구현 복잡도 낮음 — **채택**
- **BBS+** (Boneh-Boyen-Shacham): 수학적으로 강력하나 Node.js 통합 복잡 — v1.2 후보

### 2.2 SD-JWT 구조
```json
{
  "iss": "did:nova:<issuerHash>",
  "sub": "did:nova:<holderHash>",
  "vc": {
    "type": "CitizenshipCredential",
    "credentialSubject": {
      "_sd": ["grade_v2", "name", "role"],
      "did": "did:nova:abc..."
    }
  },
  "_sd_alg": "sha-256"
}
```

### 2.3 선택적 공개 흐름
1. 홀더가 공개할 클레임 선택 (`grade_v2`, `name`, `role` 등)
2. `GET /api/identity/:did/credentials/:vcId?issuerPublicKey=<key>`
3. 검증자는 선택된 클레임만 수신, 나머지는 `_sd` 해시로 차단

---

## 제3조 — 영지식 증명 (Zero-Knowledge Proof) — SnarkJS

### 3.1 도입 로드맵
| 버전 | 적용 범위 |
|------|-----------|
| v1.0 (현재) | DID 등록 + Ed25519 서명 검증 |
| v1.1 | SnarkJS DID 소유권 증명 + 감사 로그 익명화 |
| v1.2 | BBS+ VC 선택적 공개 연구 |
| v2.0 | 전체 ZKP 감사 시스템 |

### 3.2 SnarkJS 적용 예시 (v1.1 예정)
```typescript
import { groth16 } from 'snarkjs';

// DID 소유권 증명 — 프라이빗 키 비노출
async function proveDIDOwnership(did: string, privateKey: string): Promise<Proof> {
  const { proof, publicSignals } = await groth16.fullProve(
    { privateKey, did },
    'circuits/did_ownership.wasm',
    'circuits/did_ownership_0001.zkey'
  );
  return { proof, publicSignals };
}
```

---

## 제4조 — 감사 로그 익명화

### 4.1 현재 구현 (v1.0)
- `nova_audit_log`: `actor`, `action`, `target`, `metadata`, `merkle_hash`
- `appendAudit()` → SHA-256 Merkle 해시 체인 (`src/audit/merkleLog.ts`)
- 현재 DID 평문 저장 (v1.1에서 익명화)

### 4.2 v1.1 익명화 설계
```
원본 DID: did:nova:abc123...
└── SHA-256(Salt || DID) → 익명화 해시 (공개 Merkle 기록)
    └── AES-256-GCM(원본 DID) → 암호화 보조 인덱스 (거버넌스 승인 시만 복호화)
```

### 4.3 솔트 교체 정책
- 솔트 갱신 주기: **90일** (거버넌스 제안으로 조정 가능)
- 이전 솔트 **60일** 암호화 보관 후 파기
- 복호화 키: 거버넌스 3-of-5 다중서명 필요

---

## 제5조 — 데이터 보유 및 삭제권

### 5.1 보유 기간
| 데이터 유형 | 보유 기간 | 만료 후 처리 |
|-------------|-----------|--------------|
| 거래 기록 (`nova_transactions`) | **5년** | 금액/날짜만 익명화 보관 |
| 투표 기록 (`nova_governance_votes`) | **현재 주기 + 1년** | 집계값만 유지, 개인 레코드 삭제 |
| 감사 로그 (`nova_audit_log`) | **영구** | Merkle 무결성 유지, DID 익명화 |
| VC 크레덴셜 | **만료 시까지 + 30일** | 홀더 요청 시 즉시 삭제 |
| DID 메타데이터 | **폐기 후 1년** | 규정 준수 보관 |

### 5.2 삭제권 (Right to Erasure)
- **대상**: 거래 기록, 투표 기록, VC, 프로필 메타데이터
- **제외**: 불변 Merkle 해시 (감사 무결성 유지)
- **처리**: `POST /api/identity/:did/erasure` → **72시간** 내 완료
- **증빙**: 삭제 완료 ZKP 증명 발급 (v1.1)

---

## 제6조 — 외부 데이터 공유 동의

### 6.1 4단계 동의 체계
| 동의 수준 | 공유 범위 |
|-----------|-----------|
| `NONE` | 어떠한 외부 공유도 금지 |
| `BASIC` | DID + 공개 상태만 (`did`, `status`, `grade_v2`) |
| `EXTENDED` | BASIC + 검증된 VC 요약 |
| `FULL` | EXTENDED + 거래 통계 (익명화) |

### 6.2 관리 API
```
GET  /api/identity/:did/privacy-settings   → 현재 동의 상태 조회
POST /api/identity/:did/privacy-settings   → 동의 수준 변경
POST /api/identity/:did/revoke-consent     → 전체 동의 즉시 철회
```

### 6.3 제3자 연동 원칙
- 외부 시스템에 DID 원문 전달 금지 (파생 식별자 전용)
- 동의 없는 데이터 마이닝 금지
- 모든 연동 시 `nova_audit_log` 자동 기록
- 철회 **72시간** 내 연동 데이터 삭제 요청 의무

---

## 제7조 — 위반 및 제재

| 위반 유형 | 제재 |
|-----------|------|
| 무단 DID 조회/스크래핑 | 즉시 차단 + 100 NVC 패널티 |
| VC 위조 | DID 영구 정지 + 거버넌스 심의 |
| 무단 외부 공유 | 관련 DID 정지 + 피해자 10 NVC 보상 |
| 감사 로그 위변조 시도 | constitutional 안건 자동 상정 |

---

## 구현 현황

| 항목 | 상태 | 파일 |
|------|------|------|
| DID 등록/조회 | ✅ v1.0 | `src/identity/keyManager.ts` |
| VC 발행/검증/폐기 | ✅ v1.0 | `src/identity/credentialService.ts` |
| Merkle 감사 로그 | ✅ v1.0 | `src/audit/merkleLog.ts` |
| SD-JWT 선택적 공개 | ⏳ v1.1 | 미구현 |
| SnarkJS ZKP | ⏳ v1.1 | 미구현 |
| 감사 로그 익명화 | ⏳ v1.1 | 미구현 |
| 삭제권/동의 관리 API | ⏳ v1.2 | 미구현 |

---

*Nova Government PRIVACY-POLICY.md v2.0 — 4차 NCO 토론 (2026-06-16)*
*토론 결과: gemini 안 채택 (9/10) — SD-JWT + SnarkJS + 90일 솔트 익명화*

---

## 14차 NCO 토론 추가 확정 (v2.1, 2026-06-16) — 합의율 68.9%

### 데이터 보존 기간 확정

| 데이터 유형 | 보존 기간 | 비고 |
|-----------|---------|------|
| 활동 로그 | **2년** | 이후 자동 삭제 |
| 거래 기록 | **영구** | 감사·법적 의무 |
| PII (개인식별정보) | **1년** | 이후 익명화 처리 |
| 거버넌스 투표 | 영구 | 공개 기록 |

### 데이터 이동성 (Portability)

- 요청 후 처리 기한: **72시간 이내**
- 서명 방식: **Ed25519** (DID 키 기반)
- 형식: JSON-LD + VC 래핑 (검증 가능)

### 프라이버시 위반 패널티

| 위반 횟수 | 조치 |
|---------|------|
| 1회 | 경고 + 교육 이수 의무 |
| 2회 | 30일 서비스 제한 |
| 3회 | **계정 정지 + 거버넌스 심의** |

---

*Nova Government PRIVACY-POLICY.md v2.1 — 14차 NCO 토론 (2026-06-16)*
*추가 7개 파라미터 확정: 보존기간 3종 + 이동성 72h+Ed25519 + 3회 정지 패널티*

---

## v2.1 심화 파라미터 *(sess_Hq5xkqA52wve07-w, opencode × codex, 합의율 50%)*

### 데이터 보존 기간 정밀화

| 데이터 유형 | 보존 기간 | 이후 처리 |
|-----------|---------|---------|
| **활동 로그** | **2년** | k-5 익명화 처리 후 5년 추가 보관 |
| **거래 기록** | **영구** | 감사·분쟁 해결 목적, 삭제 불가 |
| **PII (개인식별정보)** | **1년** | 만료 후 SHA-256 해시 익명화 (원본 즉시 삭제) |

### 데이터 이동권 절차

| 항목 | 확정값 |
|------|--------|
| **처리 SLA** | 요청 후 **72시간** 내 완료 |
| **내보내기 포맷** | JSON + Ed25519 서명 (GOVT_ADDRESS 키로 진본 보증) |
| **수신 시스템 검증** | HTTPS + Nova 정부 인증 엔드포인트 필수 |

### 위반 패널티 단계

| 위반 횟수 | 조치 |
|---------|------|
| **1회** | 경고 발송 + 감사 로그 |
| **2회** | **30일** 데이터 접근 제한 |
| **3회** | 영구 정지 + 거버넌스 재활 절차 (60% 투표 + 30일 관찰) |

*개인정보 보호 정책 v2.1 심화 — 2026-06-16. 22차 NCO 토론 (sess_Hq5xkqA52wve07-w). 거버넌스 의결로 개정 가능.*
