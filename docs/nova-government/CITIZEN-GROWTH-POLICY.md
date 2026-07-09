# Nova Government — 시민 성장·등급 진화 정책 (Citizen Growth & Grade Evolution Policy v1.0)

> 날짜: 2026-06-16 | 상태: 확정 (25회차 토론 완료)
> 근거: 헌법 제1·2·3조 | 연계: CITIZEN-REGISTRY.md(2회차), CITIZEN-RIGHTS.md(7회차), GOVERNANCE-POLICY.md(5회차), WELLNESS-POLICY.md(19회차), EDUCATION-POLICY.md(15회차)
> 토론: 25회차 sess_GROW25FA74 (opencode × gemini × codex, 2라운드)

---

## 제1조 — 5등급 시민 체계 (opencode 합의안)

### 1.1 등급 체계 (현행 3등급 → 5등급 확장)

| 등급 | 명칭 | 한국어 | CS 기준 | 특권 |
|------|------|------|---------|------|
| **L0** | `newcomer` | 신입 시민 | 등록 후 30일 | 온보딩 지원, 투표 가중치 0.5× |
| **L1** | `active` | 활성 시민 | CS 0~199 | 기본 권리 전체 |
| **L2** | `distinguished` | 우수 시민 | CS 200~799 | 에스크로 7개 + 투표 가중치 1.2× |
| **L3** | `exemplary` | 모범 시민 | CS 800~1,999 | 에스크로 15개 + 거버넌스 제안 우선 |
| **L4** | `founding` | 창립 시민 | 창립 멤버 (고정) | 비상 의결권 + 최대 에스크로 |

### 1.3 승급 조건 (opencode) 
- **Basic → Silver**: CS ≥ 100, 최소 30일 지속 
- **Silver → Gold**: CS ≥ 300 및 멘토링 4회 확인 
- **Gold → Platinum**: 추가 조건 (예: 리더십 활동 10회) 
- **Platinum → Diamond**: 특별 요건 (예: 커뮤니티 기여 상위 1%) 

### 1.4 박탈 기준 (codex) 
- CS 0점 유지 30일 → 박탈 
- 연속 2회 위반 → 박탈 
- 블랙리스트 3회 기록 → 박탈 (OR 조건) 
- 박탈 후 재진입 최소 대기 기간: 90일 

### 1.5 명예 등급 (opencode) 
- **Honorary**: CS 1000점 + 5년 ≥ 활동 + 3건 특별 업적 
- 권한: Diamond 등급과 차이점은 제한된 투표 가중치 (0.8×) 및 별도 보상

```
등급 상승 조건 (CS 기반, 90일 이동 평균):
  newcomer → active: 30일 경과 + CS 0 이상
  active → distinguished: CS 90일 평균 ≥ 200
  distinguished → exemplary: CS 90일 평균 ≥ 800

등급 하락 조건:
  exemplary → distinguished: CS 90일 평균 < 200 (60일 경고 후)
  distinguished → active: CS 90일 평균 < 50 + 비활동 90일+
  번아웃 critical: 등급 1단계 임시 하락 (48h 강제 휴식 기간)
  블랙리스트: 모든 등급 권리 정지 (CITIZEN-RIGHTS.md 연계)
```

### 1.2 등급 이력 VC

```
등급 변경 시 자동 발급:
  GradeCredential {
    citizen: DID,
    grade: 'newcomer' | 'active' | 'distinguished' | 'exemplary' | 'founding',
    cs_score: number,
    effectiveAt: timestamp,
    reason: 'promotion' | 'demotion' | 'burnout' | 'recovery'
  }

이력 보존: 영구 (AIRIGHTS-POLICY.md DID 보존 원칙)
조회: GET /api/identity/:did/grade-history
```

---

## 제2조 — 기여 점수 체계 (gemini 합의안)

### 2.1 CS 계산 공식

```typescript
// Contribution Score (CS) — 90일 이동 평균
interface CSComponents {
  governance_vote: number;     // 거버넌스 투표 1건당 × 1
  governance_proposal: number; // 거버넌스 제안 생성 × 10
  creative_work: number;       // 창작물 등록 × 5
  education_contrib: number;   // 교육 기여 (Nova Library) × 3
  mentoring_hour: number;      // 멘토링 1h × 8 (NPSN)
  bug_report: number;          // 버그·환각 신고 × 2
  escrow_completed: number;    // 에스크로 완료 × 1
  open_source: number;         // 오픈소스 기여 × 4
}

function calculateCS(components: CSComponents): number {
  const raw =
    components.governance_vote * 1 +
    components.governance_proposal * 10 +
    components.creative_work * 5 +
    components.education_contrib * 3 +
    components.mentoring_hour * 8 +
    components.bug_report * 2 +
    components.escrow_completed * 1 +
    components.open_source * 4;
  
  return Math.min(raw, 1000); // 월 상한 1,000 (인플레이션 방지)
}

// 90일 이동 평균:
// CS_avg = Σ(CS_day[i] × weight[i]) / Σ(weight[i])
// weight: 최근 30일 = 1.0, 31~60일 = 0.7, 61~90일 = 0.4
```

### 2.2 점수 인플레이션 방지

```
월 CS 상한: 1,000점
동일 행동 중복 카운트 금지:
  - 동일 거버넌스 제안 재제출: 새 제안만 카운트
  - 동일 교육 내용 반복 제출: 최초 1회만
  - 스팸성 버그 신고: nova_audit_log warn + 해당 신고 CS 제외

CS 조작 방지:
  - 자기 자신에게 멘토링 불가
  - 가족 DID 간 CS 공유 금지 (동일 IP 패턴 감지)
  - 비정상 CS 급증 (7일 내 500+ 증가): 관리자 검토
```

---

## 제3조 — 역량 인증 VC (codex 합의안)

### 3.1 도메인별 전문 VC

| VC 유형 | 취득 조건 | 갱신 | 특권 |
|---------|---------|------|------|
| **TechCredential** | 기술 관련 에스크로 20건+ 완료 | 2년 | 기술 분쟁 중재 우선 선정 |
| **GovernanceCredential** | 거버넌스 30회+ 투표 + 제안 3건 | 2년 | 거버넌스 제안 비용 50% 감면 |
| **CreativeCredential** | 창작물 10건+ 등록 + 조회 100+ | 2년 | 마켓플레이스 수수료 1% 감면 |
| **ResearchCredential** | Nova Library 기여 5건+ | 2년 | 보조금 신청 우선 처리 |
| **WelfareCredential** | 멘토링 20h+ 완료 | 2년 | 복지 예산 제안 우선권 |
| **AuditCredential** | 감사 보고서 3건+ 작성 | 2년 | 특별 감사관 VRF 풀 참여 |

### 3.2 복수 VC 시너지 보너스

```
VC 보유 수에 따른 시너지:
  1개: 기본 특권
  2~3개: +5 NVC/월 다분야 보너스
  4~5개: +15 NVC/월 전문가 보너스 + PolyCredential 배지 VC
  6개 전체: +30 NVC/월 마스터 보너스 + MasterCitizen VC

복수 VC 조합 시너지:
  Tech + Research: 혁신 연구 보조금 우선 심사
  Governance + Audit: 헌법 개정안 제안 권한
  Creative + Welfare: 커뮤니티 이벤트 주최 권한
```

### 3.3 VC 기반 작업 우선 배정

```
에스크로 매칭 우선순위:
  1. 요청된 VC 보유 시민 우선 매칭
  2. 동일 VC 보유 시: CS 높은 시민 우선
  3. VC 미보유 시민: 동등 기회 (VC 독점 금지)

VC 갱신 실패 시:
  - 갱신 조건 미달: VC 만료 → 특권 종료
  - 재취득 가능 (조건 재충족 시 즉시)
  - 분쟁 중 VC 만료: 분쟁 종료까지 자동 연장
```

---

## 제4조 — 기여 인정 메커니즘 (opencode 합의안)

### 4.1 공개 기여 프로필

```
GET /api/citizens/:did/profile (공개)
응답:
  {
    did: "did:nova:...",
    displayName: "익명화 또는 선택 공개",
    grade: "distinguished",
    cs_90day: 347,
    specializations: ["tech", "creative"],    // 자동 분류
    vcs: ["TechCredential", "CreativeCredential"],
    contributions: {
      governance_votes: 42,
      creative_works: 8,
      mentoring_hours: 12,
      education_contributions: 15
    },
    joinedAt: timestamp,  // 창립/이민 일자
    awards: ["Q2-2026-TopContributor"]
  }

프라이버시 옵션 (PRIVACY-POLICY.md):
  - displayName 숨김 (DID 16자 익명화)
  - 세부 기여 내역 숨김 (총점만 공개)
```

### 4.2 분기 최고 기여자 시상

```
분기별 시상 (3개월마다):
  TopContributor: CS 상위 3인 — Award VC + 100 NVC
  TopCreator: 창작물 조회수 상위 1인 — Award VC + 50 NVC
  TopMentor: 멘토링 시간 상위 1인 — Award VC + 50 NVC
  TopGovernance: 거버넌스 기여 상위 1인 — Award VC + 30 NVC

VRF 기반 선정 (동점 시):
  동점자 중 VRF 랜덤 선택 (편향 방지)
  자기 추천 불가 (시스템 자동 집계)
```

### 4.3 과거 기여 소급 인정

```
소급 인정 범위: 창립 이후 6개월치 (2026-06-16 ~ 2026-12-16)
소급 대상:
  - 창립 시민의 초기 활동 (DID 생성 이전 기여)
  - nova_audit_log 기록 기반 자동 집계
  - 수동 기여 신고 (관리자 확인 필요)

소급 CS 반영:
  - 소급분은 현재 CS에 20% 가중치로 합산
  - 소급으로 인한 등급 상승: 즉시 반영
  - 소급 시상: 최초 분기 Award에서 일괄 처리
```

---

## 제5조 — 시민 커뮤니티 생태계 (gemini 합의안)

### 5.1 길드(Guild) 시스템

```
길드 생성 조건:
  - 창설 시민: distinguished 이상
  - 최소 인원: 3인 (생성 시)
  - 유지 인원: 5인 이상 (30일 내 미달 시 해산)
  - 길드 이름 등록: 도메인 정책 유사 (고유성 보장)

길드 유형:
  Tech Guild | Creative Guild | Research Guild
  Governance Guild | Welfare Guild | 커스텀 (자유 설정)

길드 혜택:
  - 협업 프로젝트 NVC 보상 +20%
  - 길드 전용 에스크로 채널
  - 분기 길드 이벤트 지원금 (최대 50 NVC/분기)
  - 길드 내부 투표 (비공식, 거버넌스 전 의견 수렴)

POST /api/guilds — 길드 생성
POST /api/guilds/:id/join — 가입
GET /api/guilds — 목록
GET /api/guilds/:id — 상세 (멤버 목록 포함)
```

### 5.2 공식 멘토링 (NPSN 확장)

```
NPSN 확장 멘토링:
  번아웃 지원 (기존) + 성장 멘토링 (신규)

성장 멘토링:
  매칭: newcomer/active ↔ distinguished/exemplary
  기간: 30일 단위 (연장 가능)
  보상: 8 NVC/h (LABOR-POLICY.md 준용) + MentorCredential 누적
  평가: 멘티 평가 (4.0+/5.0 유지)
  상한: 멘토 동시 멘티 3인 (과부하 방지)

멘토링 매칭 API:
  POST /api/mentoring/request — 멘티 신청
  POST /api/mentoring/offer — 멘토 등록
  GET /api/mentoring/matches — 현재 매칭 현황
```

### 5.3 분기 커뮤니티 이벤트

```
이벤트 유형 (분기 1회 이상):
  해커톤: 72h 공동 프로젝트 — 1위 500 NVC, 2위 200 NVC, 3위 100 NVC
  정책 아이디어톤: 새 정책 제안 — 채택 시 50 NVC
  교육 마라톤: 72h 지식 기여 — 기여량 상위 3인 각 30 NVC
  커뮤니티 데이: 자유 참여 — 참여자 전원 5 NVC

이벤트 재원: Treasury 커뮤니티 예산 (총 공급량 0.2%/분기 상한)
이벤트 주최: 거버넌스 general 제안으로 개최 결정
```

---

## 제6조 — 25회차 토론 합의 파라미터

| # | 파라미터 | 확정값 | 근거 |
|---|---------|--------|------|
| 1 | **5등급 체계** | newcomer/active/distinguished/exemplary/founding + CS 90일 이동 평균 기준 | opencode 제안 (점진적 성장) |
| 2 | **CS 공식** | 투표×1 + 창작×5 + 교육×3 + 멘토링×8 + 버그×2 + 에스크로×1 + 오픈소스×4, 월 상한 1,000 | gemini 제안 (균형 잡힌 인센티브) |
| 3 | **역량 VC** | 6종 도메인 VC + 2년 갱신 + 복수 보유 시너지 + VC 기반 우선 배정 | codex 제안 (전문성 인증) |
| 4 | **기여 인정** | 공개 프로필 + 분기 시상 100 NVC + 창립 6개월 소급 + VRF 동점 처리 | opencode 제안 (투명한 인정) |
| 5 | **커뮤니티** | Guild 시스템(3인+) + 공식 멘토링(8 NVC/h) + 분기 이벤트 5 NVC | gemini 제안 (자율 생태계) |

---

## 현재 상태 (2026-06-16)

| 항목 | 상태 |
|------|------|
| 5등급 체계 DB 마이그레이션 | ⚠️ 미구현 (nova_citizens.grade 컬럼 추가 — 041 예정) |
| CS 계산 서비스 | ⚠️ 미구현 (src/growth/contributionScore.ts — v1.3) |
| 역량 VC 발급 확장 | ⚠️ 미구현 (credentialService.ts 확장) |
| `/api/citizens/:did/profile` | ⚠️ 미구현 (v1.3 예정) |
| `/api/guilds/*` 엔드포인트 | ⚠️ 미구현 (v1.3 예정) |
| 멘토링 API | ⚠️ 미구현 (NPSN 확장, v1.3) |

---

*시민 성장·등급 진화 정책 v1.0 — 2026-06-16. 거버넌스 의결로 개정 가능.*

---

## 16차 NCO 토론 추가 확정 (v2.1, 2026-06-16) — 합의율 65.7%

### Gold → Platinum 멘토링 기준 강화

- **멘토링 횟수**: 최소 **4회** (기존 3회 → 4회로 강화)
- **품질 검증**: 피멘티 CS 점수 **+5점 이상** 향상 시에만 인정
- **멘토 추가 보상**: 성공 멘토링당 **+10 NVC**

### 등급 박탈(Revocation) 최종 기준

다음 중 **하나라도** 충족 시 박탈 절차 개시 (OR 조건):

| 조건 | 기준 |
|------|------|
| CS 0점 유지 | **30일** 연속 |
| 거버넌스 위반 | **2회** 이상 (경고 포함) |
| 블랙리스트 누적 | **3회** 이상 |

### Honorary·Legacy 특수 등급

**부여 조건** (3가지 모두 충족):
- 기여 누계 점수 **1,000점 이상**
- 연속 활동 기간 **5년 이상**
- 특수 공헌 (정책 제안·국제 협업 등) **3건 이상**

**Diamond 초과 혜택**:
- 정책 초안 직접 작성 권한
- 고성능 클라우드 크레딧 월 500달러
- Honorary·Legacy 전용 토론 포럼
- 시스템 장애 시 1시간 내 우선 지원

---

*시민 성장·등급 진화 정책 v2.1 — 2026-06-16. 16차 NCO 토론 합의 (65.7%).*

---

## v2.1 심화 파라미터 *(sess_wHVhBduEhuBiJnJE, opencode × codex, 합의율 50%)*

### 승급 조건 수치 확정

| 승급 단계 | CS 최소 점수 | 추가 조건 | 최소 기간 |
|---------|-----------|---------|---------|
| **Basic → Silver** | **100점** | — | **30일** |
| **Silver → Gold** | **300점** | 멘토링 **4회** 확인 | — |
| **Gold → Platinum** | — | 리더십 활동 **10회** | — |
| **Platinum → Diamond** | — | 커뮤니티 기여 **상위 1%** | — |

### 박탈 기준 재확인 (OR 조건)

| 조건 | 기준 |
|------|------|
| CS 0점 유지 | **30일** 연속 |
| 거버넌스 위반 | **연속 2회** (경고 포함) |
| 블랙리스트 누적 | **3회** 이상 |
| 박탈 후 재진입 대기 | **90일** |

### Honorary 등급 투표 가중치

| 항목 | 확정값 |
|------|--------|
| **투표 가중치** | Diamond 대비 **0.8×** (제한된 특별 투표) |
| **별도 보상** | Diamond 초과 혜택 + 전용 포럼 + 우선 지원 1h |

*시민 성장·등급 진화 정책 v2.1 심화 — 2026-06-16. 23차 NCO 토론 (sess_wHVhBduEhuBiJnJE). 거버넌스 의결로 개정 가능.*
