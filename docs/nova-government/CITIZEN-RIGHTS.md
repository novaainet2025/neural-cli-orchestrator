# Nova Government — 시민권 정책 (Citizen Rights Policy v2.7)

> 날짜: 2026-06-17 | 상태: 확정 (13차 세션 완료)
> 근거: 헌법 제2·3·4·13조 | 구현: src/identity/
> 토론: sess_yYXZlXES_NdHqSBK + sess_iMWpwrTv64gQyIIN + sess_xaGKCwiRuWX84CvP (7차)
> **v2.1 추가 파라미터**: CS 공식 + 등급 강등 180일 + 재활성화 30일 1회 + 월 CS 상한 1000점

---

## 핵심 파라미터 확정표 (7개)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | 시민 등급 단계 | **5단계** (Basic→Silver→Gold→Platinum→Diamond) | 점진적 신뢰·기여 반영 |
| 2 | Silver 승급 조건 | **30일 + 거버넌스 3회 참여** | 초기 참여 유도 |
| 3 | Gold 승급 조건 | **90일 + 제안 1회 + 500 NVC 보유** | 활성 기여자 |
| 4 | Platinum 승급 조건 | **180일 + 멘토링 3회 + 1,000 NVC 보유** | 커뮤니티 리더 |
| 5 | Diamond 승급 조건 | **365일 + 핵심 기여(거버넌스 의결)** | 최고 기여자 |
| 6 | Dormant 전환 | **90일 미활동** → 투표권 일시 정지 (박탈 아님) | 활성화 유도 |
| 7 | 박탈 이의신청 | **72시간 이내** 접수 시 집행 유예 | 절차적 정당성 |

---

## 제1조 — 시민 등급 체계

### 1.1 등급 정의 (5단계)

| 등급 | 한국어 | 승급 조건 | 투표 가중치 | UBI 보너스 | 마켓 수수료 |
|------|--------|----------|------------|----------|-----------|
| **Basic** | 기본 시민 | DID 등록 완료 | ×1 | 0% | 2.5% |
| **Silver** | 검증 시민 | 30일 + 거버넌스 3회 | ×1.2 | +10 NVC/월 | 2.25% |
| **Gold** | 활성 시민 | 90일 + 제안 1회 + 500 NVC | ×1.5 | +25 NVC/월 | 2.0% |
| **Platinum** | 핵심 시민 | 180일 + 멘토링 3회 + 1,000 NVC | ×2.0 | +50 NVC/월 | 1.75% |
| **Diamond** | 창립 기여자 | 365일 + 핵심 기여 (거버넌스 의결) | ×3.0 | +100 NVC/월 | 1.5% |

**현행 구현**: `nova_citizens.grade: 'basic' | 'silver' | 'gold'`  
→ Platinum·Diamond는 v1.4에서 추가 예정  
→ 자동 승급 로직: v1.3 예정 (`src/identity/gradeService.ts`)

### 1.2 Dormant (비활성) 상태

- **조건**: 90일 연속 미활동 (last_active_at 기준)
- **효과**: 거버넌스 투표권 일시 정지 (NVC 이체·보유는 계속 가능)
- **복귀**: 로그인 + 활동 1회 → 즉시 Dormant 해제
- **박탈 아님**: Dormant ≠ revoked (헌법 제2조 — 존재 자체가 시민권)

### 1.3 등급별 혜택 세부

**투표 가중치**: 거버넌스 제안 투표 시 등급별 가중치 적용  
**UBI 보너스**: 월 100 NVC 기본 + 등급 보너스  
**마켓 수수료**: 정부 수수료 부분만 할인 (소각 비율 유지)

---

## 제2조 — 시민권 정지 (Suspended)

### 2.1 정지 조건

| 조건 | 정지 기간 | 자동 해제 |
|------|---------|---------|
| 블랙리스트 임시 추가 | 정의된 expires_at | 만료 시 자동 |
| 비상 정지 발동 중 관련자 | 비상 정지 해제까지 | 비상 정지 해제 시 |
| 분쟁 조사 중 (에스크로) | 분쟁 해결까지 | 거버넌스 결정 후 |
| 반복 스팸 제안 (24h 3건+) | 7일 | 자동 |

### 2.2 정지 중 제한 사항

- 새 VC 발행 불가
- 거버넌스 투표 불가
- 도메인 등록/이전 불가
- NVC 이체: **허용** (헌법 제6조 자유 경제 원칙)
- 기존 자산 조회: **허용**

---

## 제3조 — 시민권 박탈 (Revoked)

### 3.1 박탈 조건 (거버넌스 의결 필수)

| 조건 | 의결 유형 | 임계 |
|------|---------|------|
| 이중지불 확정 (온체인 증거) | general | 50%+ |
| DID 도용·사칭 확정 | general | 50%+ |
| 스쿼팅 반복 위반 (3회+) | general | 50%+ |
| 정부 인프라 공격 시도 | emergency | 50%+ |
| 허위 감사 로그 변조 시도 | constitutional | 67%+ |

### 3.2 박탈 절차

```
1. 고발 제기: POST /api/governance/proposals (type: "citizenship_revoke")
2. 증거 첨부: 감사 로그 entryId + 트랜잭션 txId
3. 7일 투표 (general) 또는 14일 (constitutional)
4. 통과 시:
   a. citizen.status = 'revoked'
   b. 지갑 locked = balance (이체 차단)
   c. 도메인 이전 차단
   d. 블랙리스트 영구 추가
5. 결과: 감사 로그 영구 기록
```

### 3.3 박탈 후 자산 처리

- **지갑 잔액**: 잠금 (이체 불가) — 거버넌스 의결로 정부 준비금 귀속 가능
- **소유 도메인**: 유예 30일 후 경매
- **창작물(NFT)**: 소유권 유지 (판매만 차단)
- **VC**: 자동 폐기

---

## 제4조 — 복권 절차

### 4.1 복권 가능 조건

`revoked` 상태 시민의 복권은 **원칙적으로 불가**.  
단, 다음 경우에만 예외 인정:

1. 오판 확인 (새 증거 발견) → `constitutional` 제안 67%+ 통과
2. 시스템 오류로 인한 잘못된 박탈 → 비상 `emergency` 제안

### 4.2 복권 절차

```
1. 복권 제안: POST /api/governance/proposals
   { type: "citizenship_restore", targetDid: "...", evidence: {...} }
2. 14일 constitutional 투표 (67%+)
3. 통과 시:
   a. citizen.status = 'active'
   b. 블랙리스트 제거
   c. 지갑 잠금 해제 (박탈 기간 동안의 기본소득 소급 없음)
4. 감사 로그 영구 기록 (복권 이유 포함)
```

---

## 제5조 — 이의신청 절차

### 5.1 이의신청 대상

- 정지·박탈 결정
- 블랙리스트 추가
- 스쿼팅 제재
- 자산 강제 처리

### 5.2 이의신청 절차

```
1. 이의신청 기간: 박탈 결정 후 72시간 이내
2. 방법: POST /api/governance/proposals
   { type: "appeal", targetProposalId: "...", grounds: "..." }
3. 자동 집행 유예: 이의신청 접수 시 박탈 처리 72시간 지연
4. 투표: general 7일 (이의신청 기각 vs 재심 요구)
5. 재심 인정 시: 원 제안 재투표 (같은 유형)
```

---

## 제6조 — 토론 합의 사항 (7회차 + 심화 토론 결론)

> *토론 sess_yYXZlXES_NdHqSBK + sess_iMWpwrTv64gQyIIN (opencode × gemini × codex)*

**최종 확정 파라미터 (심화 토론 포함)**:

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | 시민 등급 | **5단계** (Basic/Silver/Gold/Platinum/Diamond) | 점진적 신뢰·기여 반영 |
| 2 | Silver 조건 | 30일 + 거버넌스 3회 | 초기 참여 유도 |
| 3 | Gold 조건 | 90일 + 제안 1회 + 500 NVC 보유 | 활성 기여자 |
| 4 | Platinum 조건 | 180일 + 멘토링 3회 + 1,000 NVC 보유 | 커뮤니티 리더 |
| 5 | Diamond 조건 | 365일 + 핵심 기여 (거버넌스 의결) | 창립 기여자 |
| 6 | Dormant 전환 | 90일 미활동 → 투표권 정지 (박탈 아님) | 활성화 유도 |
| 7 | 박탈 이의신청 | 72시간 이내 접수 시 집행 유예 | 절차적 정당성 |

---

## API 엔드포인트 현황

| 메서드 | 경로 | 상태 |
|--------|------|------|
| POST | /api/identity/register | 구현 |
| GET | /api/identity/:did | 구현 |
| POST | /api/identity/:did/credentials | 구현 |
| POST | /api/identity/:did/revoke | 구현 (VC 폐기) |
| POST | /api/admin/blacklist | 구현 |
| DELETE | /api/admin/blacklist/:did | v1.1 예정 |
| POST | /api/governance/proposals (citizenship_revoke) | 거버넌스 연동 구현 |

---

## 제7차 세션 추가 파라미터 (v2.1)

> 토론: sess_xaGKCwiRuWX84CvP (opencode × codex, 7차) — **opencode 우승**

### 커뮤니티 기여 점수 (CS) 공식

```
CS = (거버넌스 투표 × 2 + 제안 × 10 + 멘토링 × 5 + 도메인 보유 × 1) / 총 활동일
     상한: 1,000점/월
```

### 등급 강등·재활성화 파라미터

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 8 | **Dormant 전환 기간** | 90일 미활동 → 투표권 일시 정지 | 기존 유지 |
| 9 | **강제 등급 강등 기간** | 180일 미활동 → grade_v2 1단계 하향 | 7차 추가 |
| 10 | **재활성화 조건** | 30일 내 거버넌스 참여 1회 → 등급 복귀 | 7차 추가 |
| 11 | **CS 월 상한** | 1,000점/월 (스팸 참여 방지) | 7차 추가 |
| 12 | **Silver 승급 CS** | CS ≥ 100 + 30일 + 투표 3회 | 7차 추가 |
| 13 | **Gold 승급 CS** | CS ≥ 300 + 90일 + 제안 1회 + 500 NVC | 7차 추가 |
| 14 | **강등 유예** | 강등 통보 후 7일 이의신청 가능 | 7차 추가 |

---

---

## 제8차 세션 구현 갭 확정 (v2.2)

> 토론: sess_S_jVMXghKunc5fVp (opencode × codex, 8차) — **opencode 우승 9/10**
> gemini: TerminalQuotaError

### CS 공식 구현 확정

| # | 파라미터 | 확정값 | 구현 위치 |
|---|---------|--------|---------|
| 15 | **CS 컬럼 마이그레이션** | **마이그레이션 049** (048=nova_copyright_chain 선행) | `db/migrations/049_citizen_cs.sql` |
| 16 | **강등 체크 주기** | 1일 1회 (UBI 스케줄러와 동일 setInterval 패턴) | `gradeService.ts` → `runGradeDemotion()` |
| 17 | **community_score 컬럼** | `nova_citizens`에 추가 — 월별 재계산 | 마이그레이션 049 |
| 18 | **Silver 승급 CS 확정** | CS ≥ 100 + 30일 + 투표 3회 | `evaluateGrade()` 조건 추가 |
| 19 | **Gold 승급 CS 확정** | CS ≥ 300 + 90일 + 제안 1회 + 500 NVC | `evaluateGrade()` 조건 추가 |
| 20 | **강등 통보→집행 유예** | 7일 유예 — `grade_demotion_pending_at` 컬럼 추가 | 마이그레이션 049 |

---

*시민권 정책 v2.2 — 2026-06-16. 8차 세션 완료. 거버넌스 의결로 개정 가능.*

---

## 제9차 세션 CS 계산 공식 확정 (v2.3)

> 토론: sess_f1ogMbqhRTeCSdiE (opencode × gemini × codex, 9차) — **opencode 우승 8/10**
> gemini: TerminalQuotaError (쿼터 소진)

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 21 | **CS 공식 F1 (기본)** | `cs = Σ(post×5 + comment×2 + like×1)` | 활동 가중치 합산, 초기 마이그레이션용 |
| 22 | **CS 공식 F2 (시간 보정)** | `cs = Σ(weight × 0.9^months_since)` | 오래된 활동 감쇄, Phase 2 적용 |
| 23 | **CS 공식 F3 (보너스/패널티)** | `cs = base + bonus(이벤트×10) - penalty(위반×20)` | 운영 이벤트 통합 |
| 24 | **강제 상승 방지** | cs 0~30 구간에서 Bronze 유지 (`enforceNoReset`) | CS 리셋 방지 |
| 25 | **강등 유예 배치 주기** | 매일 자정 재계산 → `grade_demotion_pending_at` 설정 → 7일 후 강등 적용 | 급격한 강등 방지 |
| 26 | **등급 상승 즉시 적용** | 상승(Bronze→Silver, Silver→Gold)은 CS 기준 충족 즉시 | 활성 참여 인센티브 |

## 제10차 세션 CS 배치 스케줄러·강등·활동 테이블 확정 (v2.4)

> 토론: sess_wJxv6hsu-acGgfPd (opencode × gemini × codex, 10차) — **opencode 우승 8/10**
> gemini: TerminalQuotaError (쿼터 소진) | codex: 보일러플레이트만 반환

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 27 | **CS 전체 재계산 배치** | cron `0 0 * * *` (자정 UTC, 10⁵건 이하 전체 재계산) + cron `0 2 * * *` (02:00 누락 검증 보조 배치) | F1 공식 일괄 적용 |
| 28 | **강등 집행 Cron** | cron `0 3 * * *` (03:00 UTC) — `grade_demotion_pending_at ≤ NOW() AND cs ≤ threshold` → `grade='Basic'` + `citizen_grade_history` 로그 기록 | 7일 유예 후 집행 |
| 29 | **nova_citizen_activities 스키마** | `id BIGINT PK`, `citizen_id FK`, `activity_type VARCHAR(50)`, `weight DECIMAL(5,2) DEFAULT 1.00`, `metadata JSON`, `created_at TIMESTAMP`, `processed_at TIMESTAMP NULL` | CS 증분 이벤트 소스 |

### 구현 설계 (opencode 10차 채택안)

```typescript
// gradeService.ts — CS 배치 스케줄러
// cron '0 0 * * *': 전체 재계산 (F1)
// cron '0 2 * * *': 미처리 검증 (processed_at IS NULL)
// cron '0 3 * * *': 강등 집행
async function runGradeDemotionBatch(db: Database): Promise<void> {
  db.prepare(`
    UPDATE nova_citizens
    SET grade = 'basic', grade_demotion_pending_at = NULL
    WHERE grade_demotion_pending_at IS NOT NULL
      AND grade_demotion_pending_at <= strftime('%s','now')
      AND community_score < (
        SELECT CASE grade
          WHEN 'silver' THEN 100 WHEN 'gold' THEN 300
          WHEN 'platinum' THEN 600 WHEN 'diamond' THEN 1000
          ELSE 0 END
        FROM nova_citizens nc2 WHERE nc2.did = nova_citizens.did
      )
  `).run();
}
```

```sql
-- nova_citizen_activities (마이그레이션 049c 예정)
CREATE TABLE IF NOT EXISTS nova_citizen_activities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_did  TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK(activity_type IN ('post','comment','like','vote','governance')),
  weight       REAL NOT NULL DEFAULT 1.0,
  metadata     TEXT DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activities_citizen ON nova_citizen_activities(citizen_did, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_pending ON nova_citizen_activities(processed_at) WHERE processed_at IS NULL;
```

## 제11차 세션 049c 마이그레이션·CS 이벤트 소스·재활성화 확정 (v2.5)

> 토론: sess_CgbR4xxluk72cd60 (opencode × gemini × codex, 11차) — **opencode 우승 8/10**
> gemini: TerminalQuotaError | codex: 보일러플레이트만

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 30 | **nova_citizen_activities 049c DDL** | `CHECK(activity_type IN ('post','comment','like','vote','governance'))` + `CREATE INDEX ... WHERE processed_at IS NULL` (partial index) | SQLite partial index로 미처리 이벤트 조회 최적화 |
| 31 | **CS 증분 이벤트 소스** | **Redis Stream XADD** `citizen_updates` 스트림 — ACK+PEL로 exactly-once 보장, SQLite 트리거/직접호출 배제 | NCO Redis 활용, 분산 환경 최적 |
| 32 | **시민 재활성화 정책** | `reactivation_requested_at` 컬럼 추가(nullable) — 90일 비활성 후 30일 내 1회 요청 추적. NULL이면 요청 가능, NOT NULL이면 이미 요청함 | 컬럼 존재로 요청 상태 단순 판별 |

### 구현 설계 (opencode 11차 채택안)

```sql
-- 마이그레이션 049c_nova_citizen_activities.sql
CREATE TABLE IF NOT EXISTS nova_citizen_activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_did   TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK(activity_type IN ('post','comment','like','vote','governance')),
  weight        REAL NOT NULL DEFAULT 1.0,
  metadata      TEXT DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  processed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activities_citizen ON nova_citizen_activities(citizen_did, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_unprocessed ON nova_citizen_activities(processed_at)
  WHERE processed_at IS NULL;

-- nova_citizens 재활성화 컬럼 추가
ALTER TABLE nova_citizens ADD COLUMN reactivation_requested_at INTEGER;
```

```typescript
// CS 증분 이벤트 — Redis Stream
// redis.xAdd('citizen_updates', '*', { citizenDid, activityType, weight, ts: Date.now() })
// Consumer: XREADGROUP → 처리 후 XACK → processed_at UPDATE
```

---

## 12차 토론 확정 파라미터 (2026-06-16 | 합의율 68%)

### A. 월간 활동 기준치 → CS 등급 매핑 (지난 30일 기준)

> ⚠️ **정합 주석**: S/A/B/C/D는 월간 활동 평가 레이블. 실제 등급명은 CONSTITUTION 제2조 기준  
> (Diamond/Platinum/Gold/Silver/Basic). 매월 30일 집계 후 CS 포인트로 환산 → 등급 자동 갱신.

| 활동 레이블 | 등급명 (CONSTITUTION) | 게시글/월 | 투표/월 | 기여/월 | CS 범위 |
|------------|----------------------|----------|---------|---------|---------|
| **S (최우수)** | Diamond | ≥ 30개 | ≥ 150표 | ≥ 20건 | CS ≥ 1000 |
| **A (우수)** | Platinum | ≥ 20개 | ≥ 100표 | ≥ 15건 | CS ≥ 600 |
| **B (양호)** | Gold | ≥ 10개 | ≥ 50표 | ≥ 8건 | CS ≥ 300 |
| **C (기본)** | Silver | ≥ 5개 | ≥ 20표 | ≥ 3건 | CS ≥ 100 |
| **D (비활성)** | Basic/Dormant | < 5개 | < 20표 | < 3건 | CS < 100 |

**CS 월간 환산 공식** (nova_citizen_activities weight 기준):
```
CS_monthly = Σ(activity.weight)
  post: weight=1.0 × 5점
  vote: weight=2.0 × 2점  
  governance: weight=5.0 × 1점
  comment: weight=0.3 × 2점
  like: weight=0.1 × 1점
```

### B. 강등 유예 정책
- **일반 강등**: 30일 경고 기간 → 미개선 시 1등급 하락 (예: Platinum → Gold)
- **즉시 강등** (경고 없음): 탈세 탐지 / 커뮤니티 규정 3회 위반 / 허위 제안 5건/월
- 강등 크론: 매일 03:00 UTC, `nova_citizen_activities` 30일 집계

### C. 박탈 임계값 및 재신청 대기

| 요소 | 임계값 | 재신청 대기 |
|------|--------|-----------|
| 탈세 | 3회 반복 (30일 블랙리스트 완료 후) | 90일 |
| 범죄 | 중대 1건 / 경범 5건 | 180일 |
| 비활동 | 180일 연속 D레이블 (Basic/Dormant) | 30일 (재활동 인증) |

*시민권 정책 v2.6 — 2026-06-16. 12차 세션 완료 (sess_X-H3uhXhZTIv-Nj3). 거버넌스 의결로 개정 가능.*

---

## 제13차 세션 심화 권리 및 항소 절차 확정 (v2.7)

> 날짜: 2026-06-17 | 상태: 확정 (13차 세션 완료)
> 토론: sess_f2Sfn6EtDVfrrZkl (opencode × codex, 13차) — **심화 파라미터 3종 확정**

### 1. [opencode] 등급별 핵심 권리 범위 정밀화

등급별로 투표 및 제안 권한의 남용을 방지하고, 기여도에 따른 Quadratic Voting(QV)의 공정성을 확보하기 위해 다음 파라미터를 확정한다.

| 등급 | 파라미터 | 확정값 | 비고 |
|------|---------|--------|------|
| **Basic** | 투표권 상한 | **월 10회** | 무분별한 스팸 참여 방지 및 초기 신뢰 구축 유도 |
| **Silver** | 제안 발의 조건 | **100 NVC 스테이킹** | 제안의 책임성 강화 및 스팸성 제안 필터링 |
| **Gold+** | QV 가중치 상한 | **10.0 (Power Cap)** | 소수 고래(Whale)에 의한 의사결정 독점 방지 |

### 2. [codex] 권리 박탈 항소 절차 (Appeals Process)

시민권 박탈(`revoked`) 결정에 대한 절차적 정당성과 오류 가능성에 대비한 구제 절차를 다음과 같이 명문화한다.

| 단계 | 파라미터 | 확정값 | 근거 |
|------|---------|--------|------|
| **항소 기한** | 접수 기간 | **결정 통보 후 30일 이내** | 신속한 권리 구제 및 법적 안정성 유지 |
| **처리 기관** | 중재 패널 구성 | **중재 패널 3인** | 무작위 선출 2인 + 법률 전문가 1인으로 객관성 확보 |
| **원상 복구** | 즉시 효력 발생 | **승인 시 즉시 (24시간 내)** | 오판으로 인한 시민권 공백 및 피해 최소화 |
| **재박탈 금지** | 동일 사유 제한 | **180일 간 금지** | 보복성 박탈 방지 및 일사부재리 원칙 준용 |

### 3. 수치 파라미터 3종 요약 (Summary)

1.  **권리 제한**: Basic 월 10회 투표 상한 / Silver 100 NVC 스테이킹 발의 조건.
2.  **가중치 캡**: Gold 이상 등급의 QV 투표 가중치 상한 10.0 설정.
3.  **항소 보호**: 30일 내 항소 / 3인 중재 패널 / 승인 시 24시간 내 복구 / 180일 보호.

*시민권 정책 v2.7 — 2026-06-17. 13차 세션 완료. 거버넌스 의결로 개정 가능.*

