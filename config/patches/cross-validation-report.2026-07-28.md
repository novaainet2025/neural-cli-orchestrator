# Skill Academy / Capability Transfer — Cross-Validation Report (2026-07-28)

- **팀**: `team_gov-evolution-skills` (Skill Academy and Capability Transfer)
- **수행**: 중복에러방지팀
- **사이클**: improvement cycle 1/3
- **성격**: 읽기 전용 감사 + ACL 패치 산출. **src/ 코드 diff 0**, 팀 lifecycle 변경 0.
- **짝 산출물**: `config/patches/skill-acl-2026-07-28.json`

---

## 0. 결론

| 항목 | 판정 |
|---|---|
| 지시문 score=83.5 / completion=87.5% / 48h·n=8 | **STALE** — 라이브는 **95 / S / 100% / n=8** |
| CircuitBreaker open (≥2) | **0건** → 임계치 조정 **없음** |
| command gate deny (≥2) | **0건** → Gate 조정 **없음** |
| rate limit exceed (≥2) | **0건** → rate-limit 조정 **없음** |
| False Report (허위 완료/허위 CB 수치) | **허위 완료 주장 0건** (본 감사 범위). 지시문·일부 업무보고 본문의 **stale 점수 인용** 1계통 |
| 최종 권고 | **이번 사이클 룰/임계치 무변경**. weekly-limit→quota 분류는 제안만 (`CB-SKILL-C1-R4-PROPOSAL`) |

---

## 1. 증거 출처 (Evidence Tier)

| 등급 | 자료 |
|---|---|
| **T1** | `GET /api/teams/scores` → gov-evolution-skills 객체 |
| **T1** | `GET /api/tasks/<id>` 본문 (error, metadata_json, status, spawned_by_cli) |
| **T1** | `GET /api/agents` → claude-code.health / gate |
| **T1** | `src/core/team-scorer.ts` INFRA_EXCLUSION / WORK_REPORT_DUP_DELIVERED_EXCLUSION 소스 |
| **T1** | `src/security/circuit-breaker-registry.ts` QUOTA_PATTERNS / RATE_LIMIT_PATTERNS |
| **T3** | `GET /api/false-reports` 등 — `"pending implementation"` (데이터 부재로 명시) |
| **미실행** | `sqlite3 db/nco.db` — 세션 Auto-review 차단. DB 파일 존재는 T2(`ls` via helper) |

---

## 2. 라이브 점수 vs 지시문

### 지시문 (HR DIRECTIVE)
- score=**83.5**, completion=**87.5%**, sample=**48h/8**

### 라이브 (재조회, 동일 객체 2회 확인)
```json
{"teamId":"team_gov-evolution-skills","slug":"gov-evolution-skills","name":"Skill Academy and Capability Transfer","organizationId":"org_nco-evolution","score":95,"grade":"S","completion":100,"n":8,"maxN":65,"sample":"48h"}
```

**판정**: 지시문 수치는 현재 라이브와 불일치 → **STALE**.  
이 사이클에서 “아직 83.5/87.5%라서 Gate를 바꿔야 한다”고 보고하면 **그것이 False Report**가 된다.

팀 활성 상태 (`GET /api/teams` 발췌): `isActive: true`, `status: "idle"`. **삭제/비활성화 없음**.

---

## 3. 48h 실패 원장 (task evidence)

| task_id | status | assigned_to | error (verbatim) | 스코어 계상 |
|---|---|---|---|---|
| task_K0WzIJ30V7g4XqNi | failed | claude-code | `queue_wait_timeout: provider claude-code busy for 1800000ms` | **제외** — `INFRA_EXCLUSION` (`queue_wait_timeout:%`) |
| task_EOKPfKyrTYcNmGaX | failed | claude-code | `subprocess exited with code 1: You've hit your weekly limit · resets 4am (Asia/Seoul)` | **제외** — 동일 `workReportId=wr_8NPQ12v5jhqfciTa` 완료 형제 존재 → `WORK_REPORT_DUP_DELIVERED_EXCLUSION` |
| task_lzbBgDBmlTctcZNQ | completed | opencode | null | 계상 (형제 완료) |
| task_1BnR7wYDHUqips9J | completed | ollama | null | 계상 (형제 완료) |
| + completed ×6 | completed | mixed | null | 계상 |

→ terminal n=8, completed=8, completion=**100%** — 라이브와 일치.

### 지시 대상 3패턴 카운트

| 패턴 | 48h 팀 샘플 건수 | ≥2? |
|---|---:|---|
| CircuitBreaker open | 0 | 아니오 |
| command gate deny | 0 | 아니오 |
| rate limit exceed | 0 | 아니오 |

검색 문자열: `"Circuit breaker open"`, `"command gate"`, `"Command matches denied"`, `"rate limit exceeded"`, `"Rate limit"` — **매칭 0**.

---

## 4. CircuitBreaker / Gate 임계치 판정

| 룰 ID | 현재 값 | 조치 |
|---|---|---|
| failureThreshold | 3 | **유지** |
| resetTimeoutMs / BASE_COOLDOWN_MS | 60_000 | **유지** |
| QUOTA_FALLBACK_COOLDOWN_MS | 3_600_000 | **유지** |
| CommandGate GLOBAL_DENIED_PATTERNS | shell deny/allow | **유지 (diff 0)** |

**근거**: 지시문이 명시한 3패턴이 샘플에서 2회 이상 반복되지 않음. 임계치 숫자를 바꾸면 **근거 없는 변경 = 날조 조정**.

### 부수 관찰 (조정 아님)

`You've hit your weekly limit`는 `QUOTA_PATTERNS`에 없어 **quota immediateOpen이 되지 않음**.

라이브 `claude-code` health (verbatim fields):
- `circuitState`: `"closed"`
- `consecutiveFailures`: `1`
- `lastError`: weekly-limit 문자열
- `gate.status`: `"available"`, `gate.reason`: `"generic"`

→ `config/patches/skill-acl-2026-07-28.json`의 `CB-SKILL-C1-R4-PROPOSAL`로만 기록. **본 사이클 미구현**.

---

## 5. False Report 교차검증

| # | 주장 / 표면 | 원본 evidence | 판정 |
|---|---|---|---|
| FR-1 | HR 지시문 score=83.5 / completion=87.5% | 라이브 scores 95 / 100% | **STALE 지시문** (현재 상태를 83.5로 재주장하면 FR) |
| FR-2 | “CircuitBreaker/Gate/rate-limit이 스킬 전이 실패의 주원인” | 팀 48h task error 매칭 0 | **미지지** — 주장 시 FR |
| FR-3 | task_EOKPfKyrTYcNmGaX 실패로 팀 품질 붕괴 | 동일 wr_8NPQ12v5jhqfciTa 완료 형제 2건 | **품질 실패 아님** (스코어러가 올바르게 제외) |
| FR-4 | 오후 업무보고 응답이 완료율 70.0%/72.7% 인용 | task_lzbBgDBmlTctcZNQ / task_1BnR7wYDHUqips9J response 스냅샷 | **시점 스냅샷 과장 위험** — 작성 시점 프롬프트 실데이터 인용이지 라이브 scorer와 불일치. 고의 허위완료는 증거 없음 |
| FR-5 | `/api/false-reports` DB 판결 | `"pending implementation"` | **데이터 부재** — 존재하지 않는 FR ID 날조 안 함 |

**허위 완료(가짜 completed) 0건**: 실패 2건은 API status=`failed`로 정직히 남아 있고, 완료 형제가 별도 task로 존재한다.

---

## 6. auto-audit 경계

- 팀 전용 auto-audit 스트림: **미주입 / 미매칭** (hourly-audits latest-500에서 skill/evolution subject 0).
- 본 보고는 **tasks API + agents API + 소스**로 대체. 수치 날조 없음.

---

## 7. 변경 파일 / 롤백

| 경로 | 내용 |
|---|---|
| `config/patches/skill-acl-2026-07-28.json` | ACL/CB·Gate 판정 (변경 0 + proposal) |
| `config/patches/cross-validation-report.2026-07-28.md` | 본 신뢰도 리포트 |

- **src/** 변경: **0**
- **팀 비활성화/삭제**: **0**
- 롤백: 위 두 파일 삭제하면 산출물 원상복구. 런타임 동작 변화 없음.

---

## 검증 영수증

- [변경] `config/patches/skill-acl-2026-07-28.json` — 신규
- [변경] `config/patches/cross-validation-report.2026-07-28.md` — 신규
- [검증방법] `GET /api/teams/scores` → score=95, completion=100, n=8; `GET /api/tasks/task_EOKPfKyrTYcNmGaX` → weekly-limit + wr_8NPQ12v5jhqfciTa; `GET /api/tasks/task_K0WzIJ30V7g4XqNi` → queue_wait_timeout; CB/gate/rate-limit 문자열 검색 0
- [등급] **T1** (HTTP body + source file)
- [Gap] ~12% — sqlite 직접 GROUP BY 미실행, hourly_role_audits 전표 미확인, weekly-limit quota 제안 미구현
- [미검증항목] sqlite CLI 재실행; fleet-wide weekly-limit ≥2 여부; R4 제안 적용 후 단위테스트
