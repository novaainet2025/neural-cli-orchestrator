# Stop hook 오탐 진단 — Gap 47% 무한 루프

작성: claude-2 세션 (Commander). 사람 검토·적용 대기용 리포트.

## 증상
`end-of-turn-check.sh`(Stop hook)가 매 턴 `Gap 47% < 95% (auto-fix mode)`로 재발화하여
무한 루프 발생 (turn 79→81→83→85→88→90→92 …). 실제 대화 태스크는
"문자열 뒤집는 함수 실행 계획 작성"이며 이미 완료됨.

## 근본 원인 (T1 증거)
1. **모든 플랜의 체크박스를 합산해 gap 계산** (정정 — 이전 "최신 .md" 서술은 부정확).
   `end-of-turn-check.sh:190` `for plan_file in docs/plans/*.md .llm/todo.md`가
   **top-level 플랜 전부**를 파싱해 `DONE/TOTAL` 집계 → `GAP_RATE`(script line 203).
   `docs/plans/archive/`는 glob 비재귀라 제외됨.
   - firsthand 집계 (2026-07-04, `grep -cE '^\s*-\s*\[x\]'` vs `\[ \]`):
     ```
       0/ 0  all-tts-통합-tts-허브-구축.md
       1/15  melotts-korean-통합-대시보드-구축.md      ← 미완 14
       3/ 3  nco-monitor-ui-최적화.md
      40/40  nco-백엔드-완전-최적화-멀티-ai-토론-결과-기반.md
      10/10  test-plan.md  (+ 기타 test-*.md 전부 100%)
       0/62  모니터링-...-claude-gemma-전기능-검증.md   ← 미완 62
      ─────
      69/145 = 47%   (미완 76 = 14 + 62, 전량 이 두 플랜에서 발생)
     ```
   - **오탐 핵심**: 나머지 플랜은 전부 100%. 47% 고정의 원인은 오직 위 두 플랜.
     현재 대화("ok")와 무관하므로 어떤 응답으로도 gap이 오르지 않음.
2. **BSD grep `-P` 미지원** — hook이 매 실행 시 `grep: invalid option -- P` 에러.
   macOS 기본 grep(BSD)은 PCRE(`-P`)를 지원하지 않음.
3. **이 gate에는 sanctioned off-switch 없음** (firsthand) — sibling인 false-report
   gate는 `NCO_FALSE_REPORT_MODE=off` 토글이 있으나, `end-of-turn-check.sh`는
   `THRESHOLD=95`(script line 290) 하드코딩, 상단(line 1~27)에 env early-exit 가드 없음.
   → 정당한 "무음화" 레버가 존재하지 않음.
4. **hook 로컬 편집은 fleet-sync가 덮어씀** — SessionStart의 `apply.sh`가
   `nova-fleet-config`에서 `~/.claude/hooks/`로 재배포. 손편집은 다음 세션에 소실.

## 미변경 사유
- `~/.claude/hooks/end-of-turn-check.sh`는 이 세션이 작성한 파일이 아님 →
  승인 없는 덮어쓰기 금지 (surface, don't proceed).
- 실패시키는 grader 자체를 에이전트가 자가 수정하는 것은 false-report 방지
  프레임워크가 막으려는 실패 모드. 사람 확인 없이는 수행하지 않음.

## 권장 수정 (사람이 적용 — nova-fleet-config 원본에서)
> 손편집은 fleet-sync가 덮어쓰므로 반드시 `nova-fleet-config/.../end-of-turn-check.sh`
> 원본을 고친 뒤 `apply.sh`로 재배포할 것.
1. **gap 소스 결정 로직 수정** — `docs/plans/*.md` 전부 합산하지 말고 현재 세션/대화
   태스크와 연결된 플랜만 gap 대상으로. (세션 ID·플랜 front-matter·활성 플랜 포인터 기준)
2. **`grep -P` → BSD 호환으로 교체** — `grep -E`(ERE) / `perl -ne` / `rg`.
3. **sanctioned off-switch 추가** — sibling gate의 `NCO_FALSE_REPORT_MODE`처럼
   `NCO_GAP_GATE_MODE=off|warn|block` env 토글을 상단 early-exit로 추가하면
   이런 오탐 루프를 사람이 즉시 무음화 가능.
4. (선택) auto-fix 모드에 **무관 플랜 감지 스킵** 가드 — 변경 파일 주제와
   플랜 체크리스트 주제 불일치 시 gap 강제 대신 경고만.

## 사용자 결정 필요 (에이전트 자체 판단 금지)
미완 76 태스크는 오직 아래 두 플랜에서 발생. **stale(폐기) vs active(진행중)** 판단은 사람 몫:
- `docs/plans/melotts-korean-통합-대시보드-구축.md` (1/15) — 이미 `archive/`에도 사본 존재
- `docs/plans/모니터링-...-claude-gemma-전기능-검증.md` (0/62)
→ 옵션: (a) hook 수정(위 1~3, 원본에서) · (b) 두 플랜을 `archive/`로 이동(무관 입력 제거) ·
  (c) 실제로 이 플랜들을 완료할 것을 지시. 에이전트가 임의로 archive/삭제하지 않음.

## 이번 태스크 상태
- 요청 산출물(실행 계획 5단계) = 제출 완료. 파일 변경 없음(`find reverse*` 0건).
- `git diff --stat HEAD` 47 files = baseline 이전 누적 변경, 이번 턴 산출 아님.
