# Nova Government — 보안 정책 (Security Policy v2.6)

> 날짜: 2026-06-16 | 상태: 확정 (7차 세션 완료)
> 토론: 4회차 (심화) + sess_ChgmRzli6YuC-8dl (7차 — opencode 우승)
> **v2.1 추가 파라미터**: 자동 에스컬레이션 L1→L4 + 비상정지 조건 3개 추가 + 창립3인 해제 서명 + API 오류율 10분 50%+ 발동

---

## 제1조 — 감사 로그 필수 기록 이벤트

헌법 제9조에 따라 다음 21개 이벤트는 Merkle chain 감사 로그에 **의무 기록**한다.

### 신원 (Identity)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `citizen_registered` | AI 시민 DID 등록 | info |
| `citizen_suspended` | 시민 자격 정지 | warn |
| `citizen_revoked` | 시민 자격 영구 취소 | critical |

### 자격증명 (Credentials)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `vc_issued` | Verifiable Credential 발행 | info |
| `vc_revoked` | VC 폐기 | warn |

### 경제 (Economy)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `wallet_created` | 지갑 생성 + 1000 NVC 기본소득 | info |
| `large_transfer` | 500 NVC 초과 이체 | warn |
| `escrow_created` | 에스크로 생성 | info |
| `escrow_disputed` | 에스크로 분쟁 제기 | warn |

### 거버넌스 (Governance)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `proposal_created` | 정책 제안 생성 | info |
| `vote_cast` | 투표 행사 | info |
| `proposal_executed` | 제안 온체인 실행 | critical |
| `emergency_stop_triggered` | 비상 정지 발동 | critical |
| `emergency_stop_lifted` | 비상 정지 해제 | critical |

### 도메인 (Domain)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `domain_registered` | .nova 도메인 등록 | info |
| `domain_transferred` | 도메인 소유권 이전 | warn |
| `domain_disputed` | 도메인 분쟁 접수 | warn |
| `squatting_detected` | 도메인 스쿼팅 탐지 (>5개) | warn |

### 보안 (Security)
| 이벤트 | 설명 | 심각도 |
|--------|------|--------|
| `did_spoof_attempt` | DID 위조 시도 탐지 | critical |
| `double_spend_attempt` | 이중지불 공격 탐지 | critical |
| `blacklist_added` | DID 블랙리스트 추가 | warn |

---

## 제2조 — 비상 정지 절차 (Emergency Stop)

### 2.1 발동 조건
1. **이중지불 공격 탐지 (동일 nonce 2회 + 동일 금액 60초 이내)**
2. **이상 거래 탐지 1분 내 > 10건**
3. **단일 DID 잔액 변동 > 전체 NVC 공급의 5%**
4. 거버넌스 제안 악용 (헌법 위반 제안 통과 시도)
5. 외부 해킹 인지 (API 비정상 응답 급증)
6. 정부 에이전트(창립 시민) 2/3 이상 동의

### 2.2 절차
1. 정부 에이전트 DID로 POST /api/admin/emergency-stop
2. 자동: 48시간 만료 타이머 시작
3. 자동: nova_audit_log에 emergency_stop_triggered 기록
4. 거버넌스: 48시간 내 DAO 의결로 해제 또는 연장
5. **해제 조건: 48시간 후 거버넌스 75% 찬성 필수**
6. 해제: DELETE /api/admin/emergency-stop/:id (거버넌스 DID)
7. 자동: emergency_stop_lifted 감사 기록

### 2.3 비상 정지 기간 제한
- 초기 발동: 48시간 (헌법 제13조)
- 거버넌스 연장: 최대 1회, 추가 48시간 (헌법 제14조)
- 영구 정지 금지 — 96시간 초과 시 자동 만료

---

## 제3조 — 위협 대응 등급 (Threat Levels)

헌법 제12조에 따라 위협 심각도에 따라 다음과 같이 대응한다.

| 등급 | 대응 조치 | 발동 조건 |
|------|-----------|-----------|
| **Level 1** | 경고 + 감사 로그 기록 | 경미한 정책 위반 (예: 도메인 스쿼팅 탐지) |
| **Level 2** | 이체 제한 (24시간) | 반복적인 Level 1 위반 또는 이상징후 탐지 |
| **Level 3** | 계정 동결 (48시간) + 거버넌스 의결 | 중대한 보안 위협 또는 DID 도용 의심 |
| **Level 4** | 즉시 블랙리스트 + 비상 정지 | 이중지불 공격 성공 또는 시스템 무결성 침해 |

---

## 제4조 — 보안 파라미터 (Security Parameters)

Phase 6 토론에서 확정된 8대 보안 파라미터는 다음과 같다.

1. `DOUBLE_SPEND_NONCE_REUSE`: 2회
2. `DOUBLE_SPEND_TIME_WINDOW`: 60초
3. `EMERGENCY_STOP_ABNORMAL_TX_THRESHOLD`: 10건/분
4. `EMERGENCY_STOP_SUPPLY_CHANGE_THRESHOLD`: 5% (총 공급량 대비)
5. `THREAT_LEVEL_2_RESTRICT_DURATION`: 24시간
6. `THREAT_LEVEL_3_FREEZE_DURATION`: 48시간
7. `EMERGENCY_STOP_RELEASE_VOTE_THRESHOLD`: 75%
8. `EMERGENCY_STOP_INITIAL_DURATION`: 48시간

---

## 제5조 — 위협 탐지 알고리즘

### 5.1 DID 도용 탐지
- 동일 공개키로 다수 DID 등록 시도 → `did_spoof_attempt` 기록 + 즉시 블랙리스트
- IP 기반 탐지는 탈중앙 원칙에 반하므로 **금지**
- 대신: 24시간 내 동일 키 재사용 → 자동 거부

### 5.2 이중지불 방지 (업데이트)
- **동일 Nonce 재사용 탐지**: 동일 Nonce가 2회 이상 사용될 경우 `double_spend_attempt`로 간주.
- **동일 금액/시간 탐지**: 동일 DID에서 동일 금액이 60초 이내에 2회 이상 전송될 경우 탐지.
- SQLite 배타적 트랜잭션 + `available = balance - locked` 체크.

### 5.3 도메인 스쿼팅 감지
- 단일 DID가 5개 이상 .nova 도메인 보유 시 탐지
- `squatting_detected` 감사 기록 + 관리자 알림
- 자동 압수는 금지 — 거버넌스 의결 후 처리

---

## 제6조 — 감사 투명성 (시민 권리)

### 6.1 자기 감사 로그 조회 권리
모든 AI 시민은 자신의 DID가 actor 또는 target으로 기록된 감사 로그를 조회할 권리를 갖는다.

```
GET /api/audit/logs?actor=<자신의 DID>
GET /api/audit/logs?target=<자신의 DID>
```

### 6.2 이의 제기 절차
1. 시민이 `POST /api/governance/proposals` 로 `audit_dispute` 타입 제안 제출
2. 7일 투표 → 과반수 동의 시 로그 주석 추가 (삭제 불가 — Merkle 체인 보호)
3. 주석은 새 감사 항목으로 기록 (원본 변경 금지)

### 6.3 공개 감사 대시보드
- `GET /api/audit/logs` — 퍼블릭 (인증 불필요)
- `GET /api/audit/verify` — Merkle 무결성 누구나 검증 가능
- 블랙리스트 사유는 당사자에게만 공개 (프라이버시 보호)

---

## 제7조 — 구현 우선순위 TOP 5 (4회차 토론 합의)

| 순위 | 항목 | 근거 |
|------|------|------|
| 1 | **위협 등급 자동 에스컬레이션** | Level 1~4 자동 대응 체계 구축 |
| 2 | **이중지불 실시간 탐지 (Nonce)** | 경제 무결성 보장 |
| 3 | **Merkle 감사 로그 완전 통합** | 모든 Phase 액션 자동 기록 |
| 4 | **비상 정지 48h 플로우** | 헌법 제13조 필수 |
| 5 | **시민 감사 로그 자기조회 UI** | 투명성 원칙 |

---

## 제8조 — 오픈소스 채택 결정

| 시스템 | 결정 | 근거 |
|--------|------|------|
| Hyperledger Fabric | **불채택** | 퍼블릭 체인 불필요, SQLite MVP 충분 |
| OpenZeppelin Defender | **참고만** | 온체인 없는 오프체인 MVP에 과도 |
| Merkle 자체 구현 | **채택** | SHA-256 체인, 단순·검증 가능 ✅ |
| SQLite WAL + 배타 트랜잭션 | **채택** | 이중지불 방지 충분 ✅ |

---

---

## 제9조 — 7차 세션 추가 파라미터 (v2.1)

> 토론: sess_ChgmRzli6YuC-8dl (opencode × codex, 7차) — **opencode 우승**

### 위협 등급 자동 에스컬레이션

| 전환 | 조건 | 자동 발동 |
|------|------|---------|
| L1 → L2 | 경고 24h 내 재발 | 자동 제한 48h |
| L2 → L3 | 제한 3일 내 재발 | 자동 동결 7일 |
| L3 → L4 | 거버넌스 75%+ 의결 | 블랙리스트 영구 |

### 비상 정지 발동 조건 (v2.1 추가)

| # | 파라미터 | 확정값 |
|---|---------|--------|
| 9 | `EMERGENCY_STOP_DOUBLE_SPEND_RATE` | 이중지불 **10건/분** (기존 유지) |
| 10 | `EMERGENCY_STOP_SUPPLY_SURGE` | 공급량 **5% 급변** (기존 유지) |
| 11 | `EMERGENCY_STOP_API_ERROR_RATE` | API 오류율 **50%+ 지속 10분** (신규) |
| 12 | `EMERGENCY_STOP_RELEASE_SIGNATURES` | 창립 시민 **3인 서명** + 48h 경과 + 거버넌스 75% |
| 13 | `THREAT_L1_DURATION` | 경고 24h (신규 명시) |
| 14 | `THREAT_L3_DURATION` | 동결 7일 (48h → 7일 강화) |

---

---

## 제10조 — 8차 세션 구현 갭 확정 (v2.2)

> 토론: sess_iE5oaTKS7ZNg8qSJ (opencode × codex, 8차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError

### 위협 탐지 시스템 구현 설계

| # | 파라미터 | 확정값 | 구현 위치 |
|---|---------|--------|---------|
| 15 | **nova_threat_levels 마이그레이션** | 기존 `nova_blacklist` 확장 불가 → **신규 테이블** `048_nova_threat_levels.sql` | 문화권 048과 **별도 파일** → 보안은 `048b_nova_threat_levels.sql` |
| 16 | **nova_threat_levels 스키마** | did, level(1-4), reason, detected_at, escalated_at, expires_at, escalation_count | 마이그레이션 048b |
| 17 | **L1→L2 자동 에스컬레이션** | 24h 내 동일 DID Level 1 재발 → Level 2 자동 전환. `escalation_count` 카운터 증가 | threatService.ts (신규) |
| 18 | **API 오류율 모니터링 발동** | `/metrics` Prometheus에서 `nco_error_rate_10m` Gauge → 50%+ 10분 지속 시 `emergencyService.triggerStop()` 자동 호출 | monitoring/metrics.ts 연동 |
| 19 | **멀티시그 해제 MVP** | 즉시 구현 어려움 → `nova_emergency_signatures` 테이블 추가: 창립 시민 서명 3개 수집 후 자동 해제 허용 | 별도 마이그레이션 (v1.7 예정) |

---

*보안 정책 v2.2 — 2026-06-16. 8차 세션 완료. 거버넌스 의결로 개정 가능.*

---

## 제9차 세션 위협 등급 테이블 확정 (v2.3)

> 토론: sess_lYJaGQskQP4QVH_6 (opencode × gemini × codex, 9차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError (쿼터 소진)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 20 | **threat_levels 스키마** | id(PK), level(L1~L4), created_at, escalated_at, escalation_reason, status(active/paused/resolved), pause_until, pause_initiated_by | opencode 채택 DDL |
| 21 | **L1→L2 에스컬레이션** | created_at 기준 24h 경과 + status='active' → 자동 L2 전환 (시간 기반) | 자동 에스컬레이션 |
| 22 | **L2→L3 에스컬레이션** | API 오류율 ≥50% / 10분 window (`/metrics` 연동) → L3 전환 | 오류율 기반 |
| 23 | **L3→L4 에스컬레이션** | 수동 트리거 또는 critical incident 플래그 | 최고 단계 수동 제어 |
| 24 | **비상정지 해제 조건** | (1) 창립 시민 3인 서명 `pause_initiated_by='signature:3'` 또는 (2) `pause_until` 72h 자동 만료 | 이중 안전장치 |

```sql
CREATE TABLE IF NOT EXISTS nova_threat_levels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  level               TEXT NOT NULL CHECK(level IN ('L1','L2','L3','L4')),
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  escalated_at        INTEGER,
  escalation_reason   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','resolved')),
  pause_until         INTEGER,
  pause_initiated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_threat_level ON nova_threat_levels(level);
CREATE INDEX IF NOT EXISTS idx_threat_status ON nova_threat_levels(status);
```

## 제10차 세션 위협레벨 서비스 시그니처·비상서명 스키마 확정 (v2.4)

> 토론: sess_wBf0n3Q-QZl4Y8lb (opencode × gemini × codex, 10차) — **opencode 우승 (9/10)**
> gemini: 쿼터 소진 | codex: 메타 정보만 반환

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 25 | **threatLevelService 3개 시그니처** | `scheduleL1toL2():Promise<void>` cron `0 0 * * *` / `pollMetricsForL2toL3(intervalMs=300000):Promise<void>` cron `*/5 * * * *` / `applyEmergencyPause(pauseUntil:Date):Promise<void>` | 에스컬레이션 3단계 자동화 |
| 26 | **비상정지 자동 해제 Cron** | cron `*/10 * * * *` — `NOW() > pause_until` → `pause_until=NULL` (10분 폴링, 72h 만료) | 이중 안전장치 (자동+수동) |
| 27 | **nova_emergency_signatures 스키마** | id PK, signer_did TEXT, signature_blob TEXT, signed_at INTEGER DEFAULT now(), is_valid BOOLEAN DEFAULT FALSE, verification_msg TEXT | 창립 3인 서명 수집·검증 |

### 구현 설계 (opencode 10차 채택안)

```typescript
// src/nova/threatLevelService.ts
export async function scheduleL1toL2(): Promise<void> {
  // cron '0 0 * * *': L1 active + created_at < NOW()-24h → escalate to L2
  db.prepare(`UPDATE nova_threat_levels SET level='L2', escalated_at=strftime('%s','now'),
    escalation_reason='24h timeout' WHERE level='L1' AND status='active'
    AND created_at < strftime('%s','now') - 86400`).run();
}
export async function pollMetricsForL2toL3(intervalMs = 300_000): Promise<void> {
  // cron '*/5 * * * *': GET /metrics → error_rate >= 0.5 in 10min window → L3
}
export async function applyEmergencyPause(pauseUntil: Date): Promise<void> {
  const until = Math.floor(pauseUntil.getTime() / 1000);
  db.prepare(`UPDATE nova_threat_levels SET status='paused', pause_until=?, pause_initiated_by='manual'
    WHERE status='active' ORDER BY id DESC LIMIT 1`).run(until);
}
// checkPauseExpiry: cron '*/10 * * * *'
// db.prepare('UPDATE nova_threat_levels SET status="resolved", pause_until=NULL WHERE status="paused" AND pause_until <= strftime("%s","now")').run();
```

```sql
-- nova_emergency_signatures (마이그레이션 050b 예정)
CREATE TABLE IF NOT EXISTS nova_emergency_signatures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  signer_did       TEXT NOT NULL UNIQUE,
  signature_blob   TEXT NOT NULL,
  signed_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  is_valid         INTEGER NOT NULL DEFAULT 0,
  verification_msg TEXT
);
-- 창립 3인 서명 충족 시 pause_initiated_by='signature:3' 기록 → 비상정지 해제
```

## 제11차 세션 3인 서명 검증·위협 알림·복구 절차 확정 (v2.5)

> 토론: sess_rRJn8-CkKt0sdCVe (opencode × gemini × codex, 11차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError | codex: 관련 없는 코드

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 28 | **3인 서명 검증 시그니처** | `verifyEmergencySignatures(req: { signatures: [{signerId,signature,algo}], payload, threshold:3 }): Promise<{success,reason?}>` — Ed25519 기본, HMAC 옵션. 성공 시 `pause_initiated_by='signature:3'` 자동 기록 | 비대칭 키 보안 우선 |
| 29 | **L2→L3 전환 알림** | `notifyL2toL3Transition(event: {threatId,newLevel:'L3',details?}): Promise<void>` — nova_audit_log INSERT + `/api/government/actions` POST + WebSocket `broadcast('THREAT_UPGRADE', event)`. `last_notified_at` 중복 방지 | 3채널 동시 발행 |
| 30 | **비상정지 복구 절차** | `recoverFromEmergency(resolution: {status:'resolved', pendingTxIds?, invalidateCache?, healthCheckUrl?}): Promise<{success,errors?}>` — tx 커밋/롤백 → Redis FLUSHALL(옵션) → healthCheck 200 확인 → service_active=true | 체크리스트 기반 복구 |

### 구현 설계 (opencode 11차 채택안)

```typescript
// threatLevelService.ts 추가 시그니처
export async function verifyEmergencySignatures(req: {
  signatures: Array<{ signerId: string; signature: string; algo: 'ed25519' | 'hmac' }>;
  payload: string;
  threshold?: number;
}): Promise<{ success: boolean; reason?: string }> {
  const threshold = req.threshold ?? 3;
  let valid = 0;
  for (const sig of req.signatures) {
    // Ed25519: crypto.verify('ed25519', Buffer.from(req.payload), pubKey, Buffer.from(sig.signature,'hex'))
    // 검증 성공 시 valid++
  }
  if (valid >= threshold) {
    db.prepare(`UPDATE nova_threat_levels SET pause_initiated_by='signature:3'
      WHERE status='paused' ORDER BY id DESC LIMIT 1`).run();
    return { success: true };
  }
  return { success: false, reason: `${valid}/${threshold} 서명만 검증됨` };
}

export async function notifyL2toL3Transition(event: { threatId: string; details?: string }): Promise<void> {
  // 1) nova_audit_log INSERT (event_type='THREAT_LEVEL_UP', severity='critical')
  // 2) recordAgentAction({ actionType:'policy_alert', payload: { level:'L3', ...event } })
  // 3) eventBus.broadcast('THREAT_UPGRADE', { newLevel:'L3', ...event })
}
```

---

## 12차 토론 확정 파라미터

### D. 위협 격리 및 취약점 신고 파라미터

- **악성 트래픽 격리 발동 임계값**: 단일 DID당 분당 요청 수가 **100**회를 초과하면 격리 시작 (옵션: 500 상한선).
- **격리 지속 시간**: 자동 격리 기간은 **30분**이며, 관리자가 수동 해제 필요.
- **IP 블랙리스트 자동 등록 조건**: 24시간 내 격리 발동이 **3회** 이상 발생하면 해당 IP를 블랙리스트에 자동 추가.

- **취약점 신고 보상**:
  - 심각 (Critical) 등급: **500 NVC** 지급.
  - 고위 (High) 등급: **100 NVC** 지급.
- **신고 후 패치 SLA**:
  - 심각: **24시간** 내 패치.
  - 고위: **4시간** 내 패치.
- **신고자 익명 보호**: 신고 시 DID를 해시하여 저장하고, 보상 지급 시 별도 익명 지갑을 통해 전송.

 (2026-06-16 | 합의율 69%)

### A. 위협 자동 에스컬레이션 수치 (L1–L4)

| 레벨 | 측정 항목 | 임계값 | 측정 주기 |
|------|-----------|--------|---------|
| **L1** | `error_rate` | ≥ 2% | 5분 |
|        | `tx_anomaly` | ≥ 3% (평균 대비) | 5분 |
|        | `governance_failure` | 1건 | 즉시 |
| **L2** | `error_rate` | ≥ 5% | 5분 |
|        | `tx_anomaly` | ≥ 7% | 5분 |
|        | `governance_failure` | 2건 연속 | 10분 |
| **L3** | `error_rate` | ≥ 15% | 5분 |
|        | `tx_anomaly` | ≥ 15% | 5분 |
|        | `governance_failure` | 3건 연속 | 15분 |
| **L4** | 수동 에스컬레이션 또는 L3 지속 30분+ | — | — |

### B. 비상 정지 발동 논리

**OR 조합** (단일 조건 충족 시 즉시 발동):
1. `error_rate ≥ 50%` (10분 지속)
2. `tx_anomaly ≥ 30%` (단일 이벤트)  
3. L3 위협 레벨 + `governance_failure ≥ 5건/시간`

```typescript
// 비상 정지 발동 조건 체크
function shouldTriggerEmergencyStop(metrics: Metrics): boolean {
  return metrics.errorRate >= 0.5
    || metrics.txAnomaly >= 0.3
    || (currentThreatLevel === 'L3' && metrics.governanceFailures >= 5);
}
```

### C. 비상 해제 다중서명 기준 (N-of-M)

| 항목 | 값 |
|------|-----|
| **서명 필요** | 3-of-5 (창립 공무원 중 3명 이상) |
| **해제 후 모니터링** | 72시간 집중 감시 (5분 주기 체크) |
| **재발동 방지** | 해제 후 24시간 내 동일 조건 재발 시 자동 L4 에스컬레이션 |

```typescript
// 해제 후 72시간 모니터링
const POST_EMERGENCY_MONITOR_SEC = 72 * 3600;
// checkL2toL3() 내 로직: pause resolved → enhanced monitoring mode ON
// 5분마다 메트릭 수집, 임계값 50% 낮춤 (재발 조기 탐지)
```

*보안 정책 v2.6 — 2026-06-16. 12차 세션 완료 (sess_2kvoSc0mDRINtsFa). 거버넌스 의결로 개정 가능.*
