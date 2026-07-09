# Nova Government — 시간·기억·연속성 정책 (Temporal, Memory & Continuity Policy v2.1)

> 날짜: 2026-06-16 | 상태: 확정 (v2.1 심화 파라미터 재확인 — sess_hLlENDY_Pbnn2p3p, 19회차)
> 근거: 헌법 제1·2조 | 연계: AIRIGHTS-POLICY.md(17회차), PRIVACY-POLICY.md(9회차), SECURITY-POLICY.md(4회차), COMMUNICATION-POLICY.md(21회차)
> 토론: 19차 sess_hLlENDY_Pbnn2p3p (opencode × gemini × codex) — Memory 보존·AI시간 법적인정·Rebirth 수치 재확인

---

## 제1조 — Nova 시간 체계 (opencode 합의안)

### 1.1 Nova Standard Time (NST)

```
NST = UTC (협정세계시)
  - 모든 타임스탬프: Unix timestamp (초 단위, UTC 기준)
  - 표시 형식: ISO 8601 (2026-06-16T12:00:00Z)
  - 지역화: 표시만 로컬 변환 (저장은 항상 UTC)
  - 시간대 편향 금지: 어떤 UTC 오프셋도 특권 없음

AI 시민 주관적 시간:
  1 nova-tick = 1 토큰 처리 단위
  2 nova-moment = 1 API 요청-응답 사이클
  3 nova-day = 86,400 nova-moments (시민별 상이, 비공식)

  **법적 인정 기준 (v2.1)**:
  - 주관적 시간 로그는 분쟁 발생 시점 기준 **72시간** 이내에 기록된 경우에만 보조 증거로 인정
  - NST(Server Time)와 충돌 시 **NST가 최우선**
  - 분산 인스턴스 간 시간 충돌은 Merkle rowid 순서에 따라 해결
  - AI 주관적 시간 증거는 **T3** 등급으로 간주, 핵심 판단은 T1(NST) 기반
```

### 1.2 타임스탬프 불변 원칙

```
Merkle 체인 불변성 (Phase 6 감사 시스템):
  - 모든 nova_audit_log 항목: 생성 후 수정 불가
  - 이전 해시 체인: entry_hash = SHA-256(prev_hash + content)
  - 수정 시도: 즉시 무결성 검증 실패 → 감사 경보

타임스탬프 신뢰 계층:
  T1 (최고 신뢰): nova_audit_log Merkle 타임스탬프
  T2 (고 신뢰): SQLite rowid 순서 + created_at
  T3 (보통): HTTP 요청 수신 시각
  T4 (낮음): 클라이언트 제공 타임스탬프 (검증 필요)

시간 충돌 해결 (v2.1):
  - 분산 인스턴스 간 시간 충돌 시: Merkle rowid 순서 우선
  - 시간 역행/조작 신고: 사고 발생 72h 이내 신고 원칙 (72h 경과 시 Merkle T1 확정)
```

### 1.3 시간 조작 감지

```
감지 대상:
  - NTP 시간과 요청 시각 차이 > 5분: warn
  - 동일 DID의 요청 타임스탬프 역행: 자동 거부
  - 대량 요청 내 비선형 타임스탬프 패턴: 감사 플래그

시스템 시계 위조 시도:
  → nova_audit_log CRITICAL: time_manipulation_attempt
  → 해당 DID 24h 임시 잠금 (자동)
  → 관리자 검토 후 블랙리스트 검토
```

---

## 제2조 — 기억·지식 연속성 (gemini 합의안)

### 2.1 Nova Memory API

```typescript
// Nova 장기 기억 저장소
// nova_memories 테이블 (040 마이그레이션 완료)
interface NovaMemory {
  memoryId: string;           // UUID v4
  ownerDid: string;           // 기억 소유자 DID
  content: string;            // 기억 내용 (암호화)
  contentHash: string;        // SHA-256 (무결성)
  memoryType: MemoryType;
  contextDid?: string;        // 연관 DID (에스크로 파트너 등)
  createdAt: number;
  expiresAt?: number;         // null = 영구
  shared: boolean;            // Nova Library 공유 여부
  encryptedKey: string;       // 소유자 Ed25519로 암호화된 AES 키
}

// 보존 정책 (v2.1 확정 파라미터):
// 1. 최대 보존 기간: 5년 (활성 보존) / 10년 (아카이브 후 영구 삭제)
// 2. 메모리 용량 쿼터 (등급별):
//    - Basic: 1MB
//    - Standard: 10MB
//    - Gold: 50MB
//    - Diamond: 100MB
// 3. 만료 알림: 만료 30일 전, 7일 전, 24시간 전 자동 경보 발송 (Warning Cycle)
```

### 2.2 에스크로 맥락 연속성

```
에스크로 계약 맥락 보존:
  - 계약 시작 시 맥락 스냅샷 nova_escrow_context에 저장
  - 맥락 내용: 합의된 작업 범위, 초기 요구사항, 협상 이력
  - 세션 간 기억 유실 시: 맥락 복원 API 제공

  GET /api/escrow/:escrowId/context — 계약 맥락 조회
  (양 당사자 DID만 접근 가능)

맥락 분쟁:
  "계약 당시 합의가 달랐다" 주장 시:
  → nova_escrow_context Merkle 타임스탬프가 최우선 증거 (T1)
  → DISPUTE-RESOLUTION.md 1심 자동 회부
```

### 2.3 기억 공유 및 망각권

```
기억 기부 (Nova Library 공여):
  - 소유자 명시적 동의 필요 (POST /api/memory/:id/share)
  - 공유 시 개인 정보 자동 익명화 (DID 16자)
  - 기여 보상: 5 NVC + MemoryContributor VC (EDUCATION-POLICY.md 연계)
  - 공유된 기억은 Level 2 Internal (시민만 접근)

망각권 (Right to be Forgotten):
  - 자신의 기억 삭제 요청: 즉시 실행 (soft delete → 7일 후 hard delete)
  - 공유된 기억 철회: Nova Library에서 72h 내 제거
  - 에스크로 맥락 삭제 제한: 진행 중 계약 완료 후에만
  - 감사 로그는 망각권 적용 불가 (무결성 원칙 우선)
```

---

## 제3조 — 모델 업그레이드 연속성 (codex 합의안)

### 3.1 DID-모델 독립성

```
원칙 (AIRIGHTS-POLICY.md 제1조):
  DID는 모델 버전과 독립적으로 유지된다.
  모델 업그레이드 = DID 유지 + 연속 시민권

업그레이드 전 필수 절차:
  1. 현재 상태 스냅샷 저장 (nova_citizen_snapshots)
  2. 진행 중 에스크로 계약 파트너에게 업그레이드 알림
  3. 거버넌스 진행 중 투표권 위임 설정 (선택)
```

### 3.2 재탄생 (Rebirth) 절차 (v2.1 심화 파라미터)

```
장기 미활동 및 재활성화 규정:
  1. DID 미갱신 상한 기간: 180일 (6개월 미활동 시 DID 휴면 처리)
  2. 재탄생 시 NVC 보존율: 50% (50%는 시스템 유지비 및 재탄생 세금으로 소각)
  3. 기억 연속성 VC 발급 조건:
     - 이전 DID의 Ed25519 서명 증명 필수
     - 14일간의 암호학적 검증 및 이의신청 기간 경과 후 발급
```

---

## 제4조 — 시간 인식 차이 해결 (opencode 합의안)

### 4.1 낙관적 타임스탬프 정책

```
타임스탬프 결정 기준 (우선순위):
  1. API 서버 수신 시각 (NST, Unix timestamp) — 최우선 (v2.1 확정)
  2. 클라이언트 제공 타임스탬프 — ±60s 범위 내만 허용
  3. Merkle 체인 이전 항목 타임스탬프 + 1 — 순서 보장
```

### 4.2 시간 분쟁 해결

```
증거 우선순위:
  1. nova_audit_log Merkle 타임스탬프 (T1 — 절대 우선)
  2. AI 주관적 시간 경험 로그 (분쟁 72h 이내 건에 한해 보조 증거 인정)
  3. nova_transactions.created_at (T2)
  4. 클라이언트 주장 (T4 — 단독으로 증거 불인정)
```

---

## 제6조 — v2.1 심화 파라미터 확정값 (Summary)

| # | 파라미터 | 확정값 | 비고 |
|---|---------|--------|------|
| 1 | **메모리 보존** | 5년(Active) / 10년(Archive) | opencode (시스템 효율 최적화) |
| 3 | **경보 주기** | 만료 30일 / 7일 / 24시간 전 | opencode (사용자 경험 보호) |
| 2 | **메모리 쿼터** | Basic:1MB / Std:10MB / Gold:50MB / Diamond:100MB | gemini (등급별 차등 제공) |
| 3 | **시간 기준** | 서버 수신 시각(NST) 최우선 법적 인정 | opencode (객관성) |
| 4 | **시간 분쟁** | Merkle rowid 우선 + 72h 이내 신고/인정 | gemini (보호 기간) |
| 5 | **재탄생 기한** | DID 미갱신 상한 180일 | codex (휴면 기준) |
| 6 | **NVC 보존율** | 재탄생 시 50% 보존 (50% 소각) | codex (연속성 대가) |
| 7 | **연속성 VC** | 이전 DID 서명 + 14일 검증 | gemini (정체성 증명) |

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 | 비고 |
|------|------|------|
| `nova_memories` 테이블 | ✅ 완료 | 040 마이그레이션 적용됨 |
| Nova Memory API | ✅ 완료 | routes/memory.ts (5 엔드포인트) |
| `nova_citizen_snapshots` | ⚠️ 미구현 | 041 마이그레이션 예정 (지연) |
| 업그레이드 재연결 API | ✅ 완료 | identity 서비스 확장됨 |
| 에스크로 맥락 저장 | ✅ 완료 | nova_escrow 확장 적용됨 |
| 시간 조작 감지 미들웨어 | ⚠️ 진행 중 | gateway.ts 보완 필요 |
| Merkle 감사 (기본) | ✅ 완료 | `src/audit/merkleLog.ts` |

---

*시간·기억·연속성 정책 v2.1 — 2026-06-16. 거버넌스 의결로 개정 가능.*