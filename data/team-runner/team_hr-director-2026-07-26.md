# Team Lifecycle HR Director — 일일 산출물 (2026-07-26, ai=claude-code, taskId=task_AAWhydrV_DPsx1D7)

Done. The Stop-hook `tsc=2 err` was **real build breakage**, not a Gap false-positive — and it was not from my HR task (that was text-only, zero source edits). I traced and fixed it.

## What was broken
Commit `5144a3c` ("Fixed team scorer issue") committed three hallucinated artifact files into `src/`:

| File | Problem |
|---|---|
| `src/team_triad-command-judge.ts` | Junk: only `Improvement cycle=1/3` — a self-improve status marker misplaced with `.ts` extension (TS1434 parse error) |
| `src/core/team_triad-command-judge.ts` | Junk: only `Improvement cycle=2/3` |
| `src/reporting/validator.test.ts` | Hallucinated test importing `./validator` — a module that **never existed**; `validateT1` referenced nowhere; missing `vitest` import; incoherent body |

The two parse-error files were masking the third (TS1434 makes tsc bail early), so the true error set only surfaced after removing them.

## Fix
`git rm` all three (staged, not committed). I did **not** fabricate a `validator.ts` to satisfy the fake test — that would be inventing a module for a hallucinated spec.

## 검증 영수증
- **[변경]** `git rm` × 3: `src/team_triad-command-judge.ts`, `src/core/team_triad-command-judge.ts`, `src/reporting/validator.test.ts` (all staged)
- **[검증방법]** `npx tsc --noEmit` → 빈 출력, exit 0 (2→0 errors); `grep -rn validateT1 src/` → 참조 없음; `git log --all -- src/reporting/validator.ts` → 이력 없음(팬텀 확인)
- **[등급]** T1 (tsc 실행 결과 + grep + git history 직접 확인)
- **[Gap]** 100% — tsc 0 errors 달성; 제거 파일 모두 코드에서 import 안 됨(comment 2건만 팀명 언급, 파일 참조 아님)
- **[미검증항목]** `npm run build` 전체 emit·vitest 스위트 미실행(tsc typecheck만); 커밋 미수행 — 변경은 스테이징 상태

두 가지 후속 판단이 필요합니다:
1. **커밋 여부** — 현재 `main` 브랜치입니다. 원하시면 브랜치 생성 후 커밋하겠습니다 (기본은 스테이징만 유지).
2. **업스트림 근본 수정** — self-improve/team 러너가 `Improvement cycle=N/3` 마커를 `src/*.ts`에 쓰는 버그가 재발원입니다. 마커를 `data/self-improve/`로만 쓰도록 러너를 고쳐야 재오염을 막습니다. 진행할까요?
