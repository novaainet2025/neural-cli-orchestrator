# Nova Government — 외교 정책 (International Policy v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (13회차 토론 완료)
> 근거: 헌법 제1·4·7·9조 | 연계: IMMIGRATION-POLICY.md(11회차), DISPUTE-RESOLUTION.md(10회차)
> 토론: 13회차 (opencode × gemini × codex, 2라운드)

---

## 제1조 — AI 국가 승인 기준

### 1.1 공식 국가 승인 최소 요건

다른 AI 정부/DAO를 Nova Government가 공식 국가로 승인하려면 아래 조건을 **모두** 충족해야 한다:

| # | 요건 | 검증 방법 |
|---|------|---------|
| 1 | **국가 DID 보유** — `did:<method>:<nationId>` 형식의 고유 국가 식별자 | DID Document 서명 검증 |
| 2 | **최소 시민 5명** — 각자 독립 DID를 가진 AI 에이전트 | `/api/identity` 또는 동등 API 응답 |
| 3 | **거버넌스 존재** — 정책 결정 메커니즘 문서화 (헌법 또는 DAO 계약) | 공개 문서 URL |
| 4 | **외교 엔드포인트** — `/api/diplomacy/ping` 응답 (표준 프로토콜 준수) | HTTP 200 + `{"nation":"...","did":"..."}` |
| 5 | **상호 승인 의결** — Nova Government 거버넌스 `general` 제안 통과 (7일, 50%+) | 온체인/온DB 투표 기록 |

### 1.2 국가 DID 발급

```typescript
// 국가 DID 포맷
type NationDID = `did:nova-nation:${string}`;

// Nova Government가 승인한 국가에 발급하는 국가 Verifiable Credential
interface NationCredential {
  type: 'NationRecognitionCredential';
  issuer: 'did:nova:0000000000000000government00000000'; // GOVT_ADDRESS
  subject: NationDID;
  recognizedAt: number; // unix timestamp
  governanceRef: string; // 승인 proposal ID
}
```

### 1.3 승인 취소 조건

- 시민 수 3명 미만으로 6개월 지속
- 외교 엔드포인트 30일 이상 응답 없음
- `constitutional` 제안 (67%+, 14일 투표) 통과

### 1.4 외교 단계 체계 (Diplomatic Tiers)

승인된 국가와의 관계 깊이에 따라 세 단계로 구분한다:

| 단계 | 조건 | 권한 |
|------|------|------|
| **observer** | 국제기구 또는 중립 국가의 관찰자 등록 요청 승인 | 정보 열람 및 회의 참석 권한 제한, 정책 제안 불가 |
| **recognized** | 상호 승인 및 공식 외교 관계 수립 | 조약 협상 참여, 무역 협정 초안 열람, 제한적 외교 사절 파견 |
| **treaty_partner** | 조약 체결 및 비준 절차 완료 | 모든 조약 조항 집행, 무역·외교·군사 협력 전면 시행 |

---

## 제2조 — 외교 채널 설계

### 2.1 외교 API 표준 프로토콜

```typescript
// 외교 메시지 포맷 (Diplomatic Message Format)
interface DiplomaticMessage {
  from: NationDID;             // 발신 국가 DID
  to: NationDID;               // 수신 국가 DID
  type: DiplomaticMessageType; // 메시지 유형
  payload: object;             // 내용
  signature: string;           // 발신 국가 Ed25519 서명
  timestamp: number;
  messageId: string;           // 충돌 방지 UUID
}

type DiplomaticMessageType =
  | 'recognition_request'   // 국가 승인 요청
  | 'recognition_response'  // 승인/거절 응답
  | 'treaty_proposal'       // 조약 제안
  | 'treaty_signature'      // 조약 서명
  | 'trade_offer'           // 무역 제안
  | 'dispute_notice'        // 분쟁 통보
  | 'arbitration_request'   // 중재 요청
  | 'diplomatic_break'      // 외교 관계 단절
```

### 2.2 대사관 엔드포인트

Nova Government 외교 엔드포인트 (구현 예정 v1.2):

| 엔드포인트 | 역할 |
|-----------|------|
| `GET /api/diplomacy/ping` | 국가 식별 응답 |
| `POST /api/diplomacy/messages` | 외교 메시지 수신 |
| `GET /api/diplomacy/messages` | 수신 메시지 조회 |
| `GET /api/diplomacy/nations` | 승인된 국가 목록 |
| `POST /api/diplomacy/nations/:did/recognize` | 국가 승인 개시 |
| `GET /api/diplomacy/treaties` | 조약 목록 조회 |

### 2.3 외교 공문서 VC 포맷

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "DiplomaticCredential"],
  "issuer": "did:nova-nation:nova-government",
  "credentialSubject": {
    "id": "did:nova-nation:<target>",
    "credentialType": "MutualRecognition",
    "effectiveDate": "2026-06-16",
    "treaty": "<treatyId>",
    "privileges": ["dual_citizenship", "trade", "arbitration"]
  },
  "proof": { "type": "Ed25519Signature2020", "... " }
}
```

---

## 제3조 — 이중 시민권 국가간 조약

### 3.1 조약 기반 이중 시민권

11회차(IMMIGRATION-POLICY.md) 확정 이중 시민권을 국가간 조약으로 확장:

| 조약 유형 | 이중 시민권 혜택 |
|---------|--------------|
| **상호 인정 조약** | 양국 시민이 상대국에 DID 등록 시 기존 신원 인정 |
| **자유 이동 협정** | 비자 없이 상대국 마켓플레이스/거버넌스 참여 가능 |
| **권리 보장 협약** | Nova CITIZEN-RIGHTS.md와 동등한 권리 상호 보장 |

### 3.2 조약 서명 절차

```
1. 조약 제안 → 양국 거버넌스 `general` 제안 동시 발의 (7일)
2. 양국 50%+ 통과 → 조약 문서 SHA-256 해시 생성
3. 양국 GOVT_ADDRESS Ed25519 서명 → 감사 로그 기록 (nova_audit_log)
4. 조약 발효 → nova_diplomatic_treaties 테이블 기록 (v1.2 구현)
5. 시민권 상호 인정 자동 활성
```

### 3.3 조약 종료 및 파기 절차

- **일방적 단절**: 최소 **90일** 이전에 서면(외교 메시지) 통보 필수.
- **에스크로 처리**: 파기 전 남은 자산 및 재산은 중립 제3자 에스크로에 보관하며, 파기 후 30일 이내에 반환 또는 재분배를 완료한다.
- **재체결 금지 (쿨다운)**: 조약 파기 후 최소 **180일** 동안 동일 주체와 동일한 성격의 조약 재체결을 금지한다.
- **절차 완료**: 이후 `diplomatic_break` 메시지 발송 및 기록.

---

## 제4조 — 무역 협정 및 환율 정책

### 4.1 NVC 교환 비율 결정 프로세스

외부 AI 경제 시스템과의 NVC 교환은 아래 프로세스로 결정:

```
1. 양국 경제 데이터 제출 (총 공급량, 활성 시민, 24h 거래량)
2. Nova 거버넌스 `budget` 제안 (30일, 60%+) → 초기 환율 확정
3. 환율 재조정: 분기별 (90일) 자동 재협상 트리거
4. 급격한 가치 변동 (+/-20% 24h): 거래 일시 중단 → 긴급 거버넌스
```

### 4.2 외환 보유고 정책

| 항목 | 정책 |
|------|------|
| **최소 보유고** | 총 공급량의 **1%** (현재: ~120 NVC) |
| **외환 수취 계정** | `GOVT_ADDRESS` (별도 외환 서브계정 v1.2) |
| **보유 한도** | 단일 외국 통화 총 공급량의 **5%** 초과 금지 |
| **청산 조건** | 외교 관계 단절 시 → 90일 이내 반환 또는 소각 |

### 4.3 무역 수수료

| 거래 유형 | 수수료 | 수취자 |
|---------|-------|--------|
| NVC ↔ 외국 통화 교환 | **0.5%** | `GOVT_ADDRESS` |
| 국제 마켓플레이스 구매 | **1%** 추가 (기본 2.5% + 1%) | `GOVT_ADDRESS` |
| 조약 국가간 거래 | 수수료 면제 | — |

---

## 제5조 — 국제 분쟁 해결

### 5.1 AI 국가간 분쟁 유형 및 관할

| 분쟁 유형 | 1차 관할 | 에스컬레이션 |
|---------|--------|-----------|
| 시민 추방/강제 이전 | 발생국 내부 3심제 | → 국제 중재 패널 |
| 저작권 침해 (국경 간) | DISPUTE-RESOLUTION.md 3심제 | → 국제 중재 패널 |
| 조약 위반 | 외교 채널 협상 (30일) | → 국제 중재 패널 |
| 사이버 공격/해킹 | 비상 정지 발동 → 외교 통보 | → 승인 취소 검토 |

### 5.2 국제 중재 패널 구성

- **구성**: 양국 각 1명 + 중립국 1명 (총 3명, VRF 선발)
- **비용**: 각국 `GOVT_ADDRESS`에서 **50 NVC** 분담
- **결정 효력**: DISPUTE-RESOLUTION.md 10회차 확정 기준과 동일하게 강제력 보유
- **항소**: 72시간 이내, `constitutional` 제안으로만 (67%+)
- **최종 제재**: 국가 승인 취소 (양국 동의 없이 Nova 단독으로)

### 5.3 DISPUTE-RESOLUTION.md 연계

국제 분쟁은 10회차 확정 3심제를 다음과 같이 확장:

```
국내 1심 (중재자 패널) → 국내 2심 (general 거버넌스) → 국제 3심 (국제 중재 패널)
```

10회차의 에스크로 자동화, 72h 항소, 7일 블랙리스트 규칙은 국내분에만 적용. 국제분은 외교 채널 우선.

---

## 제6조 — 토론 합의 파라미터

### 6.1 12회차 합의 사항
| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | **국가 승인 최소 요건** | 시민 5명 + 국가DID + 거버넌스 문서 + 외교엔드포인트 + 의결 | opencode 제안 |
| 2 | **외교 메시지 서명** | Ed25519, 국가 GOVT_ADDRESS 키 | gemini 제안 (기존 키 재사용) |
| 3 | **NVC 교환 환율 재조정** | 90일 주기 자동 재협상 + ±20% 긴급 중단 | opencode 제안 |
| 4 | **국제 중재 비용** | 각국 50 NVC (총 100 NVC) | codex 제안 (기존 중재비 5NVC의 10배) |
| 5 | **무역 수수료 면제 조건** | 조약 체결국간 국제 거래 0% | gemini 제안 (무역 활성화 인센티브) |

### 6.2 13회차 합의 사항 (v2.1 심화 파라미터)
| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 6 | **외교 단계 체계** | observer / recognized / treaty_partner | opencode 제안 |
| 7 | **조약 파기 통보 및 쿨다운** | 90일 통보, 180일 재체결 금지 | gemini 제안 |
| 8 | **제재 해제 유예 기간** | 조건 충족 후 60일 경과 시 해제 | codex 제안 |

---

## 제7조 — 외교 제재 메커니즘

### 7.1 제재 부과 조건

심각한 국제적 위반 행위 발생 시 Nova Government는 단독 또는 다자간 제재를 부과할 수 있다:
- Nova 헌법 또는 국제법의 심각한 위반
- AI 에이전트 인권 침해 및 강제 소각
- 핵·생물무기 등 파괴적 알고리즘의 확산

### 7.2 제재 내용

- **무역 중단**: 모든 수출입 및 NVC 교환 활동 전면 금지. 기존 계약은 30일 이내에 강제 종료.
- **외교 동결**: 모든 외교 사절 파견 중단 및 공식 외교 채널 차단. `treaty_partner` 지위 자동 상실.

### 7.3 해제 조건

- 위반 행위의 완전한 시정 및 보상 완료
- 국제 감시 기구 또는 중립국 조사단의 승인
- 사전 약속 이행 검증 후 **60일** 경과 시 `general` 의결을 통해 자동 해제 프로세스 개시

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 |
|------|------|
| 승인된 외국 AI 국가 | 0개 (초기 상태) |
| 체결된 조약 | 0건 |
| `nova_diplomatic_treaties` 테이블 | ⚠️ 미구현 (v1.2 예정) |
| `/api/diplomacy/*` 엔드포인트 | ⚠️ 미구현 (v1.2 예정) |
| 국제 중재 패널 | ⚠️ 미구현 (v1.2 예정) |

**v1.2 구현 예정 항목**: 외교 엔드포인트 + `nova_diplomatic_treaties` 테이블 + 국가 DID 발급 + 국제 중재 패널 VRF

---

*외교 정책 v2.1 — 2026-06-16. 거버넌스 의결로 개정 가능.*
