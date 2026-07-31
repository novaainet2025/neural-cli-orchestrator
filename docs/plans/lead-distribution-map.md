# codex 편중 완화 — 역할기반 lead 분산 매핑표 (claude-2 설계)

> claude-3 요청. **사용자 "codex 주력" 지시 존중** — 코어 코딩/구현 팀은 codex 유지, 나머지만 역할별 분산.
> 적용은 사용자 OK 후 claude-3(teams DB 락). 현재 codex 14팀 → 분산 후 codex 4팀.

## 원칙
- **codex 유지 = 실제 코딩/구현/git 작업 팀만** (사용자 주력 지시 반영, 4팀)
- 리뷰·보안·QA·검증 → **cursor-agent** (리뷰 전문)
- 분석·추론 → **retired-provider** (Reasoner)
- 문서·스펙 → **opencode** (구조/설계)
- 집필·리포팅 → **claude-code** (서술 강점)
- 포화 해소: codex 14→4, 어느 프로바이더도 단일 과부하 없게 분산

## 매핑표 (codex lead 14팀)

| 팀 slug | 역할 | 현 lead | → 신 lead | 근거 |
|---|---|---|---|---|
| cli-core | CLI 코어 개발 | codex | **codex (유지)** | 핵심 코딩 |
| ax-git | Git Manager | codex | **codex (유지)** | git/코딩 |
| infra-engineer | Infrastructure | codex | **codex (유지)** | 인프라/코딩 |
| self-improvement | 자가개선(소스개선) | codex | **codex (유지)** | 소스코드 개선 |
| ax-expert-security | 보안 전문가 | codex | **cursor-agent** | 보안 리뷰 |
| ax-security | Security Agent | codex | **cursor-agent** | 보안 |
| cli-qa | CLI 검증/QA | codex | **cursor-agent** | QA/검증 |
| quality-audit | 품질 검수 | codex | **cursor-agent** | 품질 감사 |
| research-verification | 검증·팩트체크 | codex | **cursor-agent** | 적대적 검증 |
| analytics-lead | Analytics Lead | codex | **retired-provider** | 분석/추론 |
| research-analysis | 분석·추론팀 | codex | **retired-provider** | 심층 추론 |
| self-learning | 자가학습(패턴분석) | codex | **retired-provider** | 패턴 분석 |
| ax-docs | Docs & Spec | codex | **opencode** | 문서/스펙 구조 |
| research-writing | 집필·리포팅 | codex | **claude-code** | 리포트 집필 |

## 분산 후 전체 분포 (예상)
codex 4 · cursor-agent 5 · retired-provider 3 · claude-code 8 · ollama 7 · opencode 1 · agy 4 = 32팀
→ codex 단일집중(14) 해소, 최대 부하 claude-code 8(주간리밋은 P1 스킵+P11 failover가 완화).

## 적용 SQL (claude-3가 사용자 OK 후 실행)
```sql
UPDATE teams SET lead = CASE slug
  WHEN 'ax-expert-security' THEN 'cursor-agent'
  WHEN 'ax-security'        THEN 'cursor-agent'
  WHEN 'cli-qa'             THEN 'cursor-agent'
  WHEN 'quality-audit'      THEN 'cursor-agent'
  WHEN 'research-verification' THEN 'cursor-agent'
  WHEN 'analytics-lead'    THEN 'retired-provider'
  WHEN 'research-analysis' THEN 'retired-provider'
  WHEN 'self-learning'     THEN 'retired-provider'
  WHEN 'ax-docs'           THEN 'opencode'
  WHEN 'research-writing'  THEN 'claude-code'
  ELSE lead END,
  updated_at = datetime('now')
WHERE is_active=1 AND lead='codex'
  AND slug IN ('ax-expert-security','ax-security','cli-qa','quality-audit','research-verification','analytics-lead','research-analysis','self-learning','ax-docs','research-writing');
-- cli-core/ax-git/infra-engineer/self-improvement 은 codex 유지(미변경).
```

## 검증
적용 후 `SELECT lead,COUNT(*) FROM teams WHERE is_active=1 GROUP BY lead` → codex 4 확인.
이후 n=30+ 팀태스크 배치로 성공률 재측정 → codex 포화 실패 소거로 98%+ 확정.

## 주의
- **P8(동적 재선정)이 이미 lead 서킷open 시 자동 재선정**하므로 이 재배정은 "초기 배정 최적화"(포화 예방). P11/P8과 상보적.
- retired-media-provider 정식통합(호출구조 "retired-media-provider generate create <model> --prompt")은 별건 — 이 표는 lead 분산만.
