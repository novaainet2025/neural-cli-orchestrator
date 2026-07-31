# Integration and Release — cycle 1 검증 영수증

검증일: 2026-07-30 (Asia/Seoul) · 세션: `sess_hs03gZRBEKPCkLKX` · HR cycle **1/3**

## HR 지시 입력 (고정)

| 필드 | 값 |
|---|---|
| team | `gov-engineering-release` / `team_gov-engineering-release` |
| score | **6.1** |
| completion | **0%** |
| sample | **48h / n=6** |

## T1 실데이터 진단

### A. 일일 산출물 (팀 러너, 파일 내용 직접 대조)

| 날짜 | taskId | 7d 완료율 | 릴리스 판정 | 빌드·테스트 |
|---|---|---:|---|---|
| 2026-07-30 | `task_J7jKrtyyP-Rl8doI` | 73.3% (11/15) | STOP/HOLD | **미실행** |
| 2026-07-29 | `task_1zHRI_lIA1gCQ62q` | 66.7% (8/12) | 중지·보류 | **미실행** |
| 2026-07-28 | `task_xoUDpF0k6hbG3kue` | 55.6% (5/9) | STOP/HOLD | **미실행** |

공통 패턴: codex가 주입된 집계 수치로 **관찰·보류 보고서**만 완료한다. 통합·배포·
`verify.sh`·`tsc`·호환성 검증의 T1 증거는 산출물에 없다. 이는 헌장(독립검증 없이
릴리스 금지)과 **일치**하나, HR 개선 사이클의 “완료” 지표와는 **불일치**한다.

### B. 점수 6.1 / completion 0% — 근본원인 (플릿 공통)

교차 근거: `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md`,
`REPORTS/2026-07-30-시각화-미디어팀-오후.md`

1. `src/core/team-scorer.ts`의 `AUDIT_APPROVED_COMPLETION` 게이트가 배포된 `dist/`에
   반영되어, 감사 마커가 있으나 Nova-AX 6/6 영수증이 없는 `completed` 행이 분자에서
   제외된다.
2. 플릿 실측(동일 보고서): 48h `completed` 팀 태스크 628건 중
   `verificationStatus='approved'` **0건**, `reviewing` **0건**.
3. score 공식: `0.9 × completion + 0.1 × volume`. completion=0이면 volume만 남아
   **6.1 ≈ 0.1 × log-volume** (n=6, maxN≈19) — HR 입력과 산술 일치.

**결론:** completion=0%는 Integration and Release 팀의 48h 실패 6건이 아니라,
**감사 파이프라인 미배선 상태에서의 스코어러 아티팩트**다. 팀 결함으로 단정하면
False Report다.

### C. 팀 고유 2차 원인 (cycle 2+ 추적)

- 산출물이 전부 “보류” 서술이며 **실행 가능한 릴리스 게이트 산출물**
  (`scripts/audit-pipeline-health.ts` 출력, `npx tsc`, API 호환 스모크)이 없다.
- 7d 창 실패 4건의 task id·error 원문이 일일 보고에 **미연결**되어 감사 추적 공백.

## cycle 1 합의 수정 (bounded · reversible)

| # | 조치 | 소유 | 롤백 |
|---|---|---|---|
| 1 | **스코어러 본문 수정 금지** — transparency 세션 소유 (`team-scorer.ts`) | 자가개선 | 해당 세션 revert |
| 2 | **읽기 전용 진단** `scripts/release-team-cycle1-diagnosis.ts` 추가 | 자가개선 | 파일 삭제 |
| 3 | **중복에러 감사** `08-IMPROVEMENTS/team-gov-engineering-release-cycle1-dup-error-audit.md` | 중복에러방지 | 문서만 |
| 4 | **학습 노트** `obsidian_vault/improvement_notes/team-gov-engineering-release-cycle1-learning-20260730.md` | 자가학습 | 문서만 |
| 5 | 긴급 시에만 `NCO_SCORER_AUDIT_APPROVAL_GATE=off` + PM2 재시작 (플릿 전체) | HR/인프라 | env unset |

## 검증 명령 (cycle 1 완료 기준)

```bash
npx tsx scripts/release-team-cycle1-diagnosis.ts
npx tsx scripts/audit-pipeline-health.ts
npx vitest run tests/audit-gate-invariants.test.ts
```

성공 기준 (cycle 1):

1. 진단 스크립트가 team score·48h task 목록·fleet AP-4=0을 출력한다.
2. invariant 테스트 4건 통과.
3. **주장 금지:** score가 90+로 오른 것 — 스코어러 배포 전까지 미주장.

## Gap

- 이 세션에서 shell/curl이 거부되어 위 명령의 **실행 출력은 미수집**.
- `npm run build` / PM2 재시작 미수행 — 스코어러 완화 배포는 소유 세션 대기.

## 등급

- [T1] 일일 산출물 파일, transparency·viz 감사 보고서, `team-scorer.ts` 공식·주석
- [Gap] 라이브 DB 재조회·테스트 exit code — 미검증
