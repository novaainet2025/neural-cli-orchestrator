#!/bin/bash
# ═══════════════════════════════════════════════════════════
# NCO Stop Hook v2.0 — Gap Analysis + Auto-Continue
# ═══════════════════════════════════════════════════════════
#
# 실행 시점: Claude Code CLI가 응답을 멈출 때 (매 턴 종료)
#
# 핵심 로직:
#   1. 작업 결과 기록 (변경 파일, 에러 카운트)
#   2. Gap 분석 (계획 vs 실제 완료율)
#   3. Gap >= 95% → exit 0 (완료) + 다음 작업 추천
#   4. Gap < 95%  → exit 2 (재실행) + 미완료 항목을 stderr로 주입
#
# exit 0 = Claude 정상 종료
# exit 2 = Claude 재실행 (stderr 내용이 프롬프트로 주입됨)
#
# ═══════════════════════════════════════════════════════════

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ═══ 상태 파일 경로 ═══
NCO_SESSION_DIR="/tmp/nco-sessions"
NCO_SESSION_ID="${PPID:-$$}"
NCO_STATE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"
NCO_TASKS="$NCO_SESSION_DIR/$NCO_SESSION_ID-tasks.json"
NCO_GAP="$NCO_SESSION_DIR/$NCO_SESSION_ID-gap.json"
mkdir -p "$NCO_SESSION_DIR" 2>/dev/null

# ═══════════════════════════════════════════════════════════
# STEP 1: 작업 결과 수집
# ═══════════════════════════════════════════════════════════

CHANGED_COUNT=$(git diff --name-only 2>/dev/null | wc -l || echo "0")
STAGED_COUNT=$(git diff --cached --name-only 2>/dev/null | wc -l || echo "0")
TOTAL_CHANGED=$((CHANGED_COUNT + STAGED_COUNT))

# TypeScript 에러 카운트 (빠른 체크)
TSC_ERRORS=0
if command -v npx &>/dev/null && [ -f "tsconfig.json" ]; then
    TSC_ERRORS=$(npx tsc --noEmit 2>&1 | grep -c "error TS" || echo "0")
fi

# ESLint 에러 (변경 파일만)
LINT_ERRORS=0
if command -v npx &>/dev/null && [ -f ".eslintrc*" ] || [ -f "eslint.config*" ]; then
    CHANGED_FILES=$(git diff --name-only --diff-filter=ACMR 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -20)
    if [ -n "$CHANGED_FILES" ]; then
        LINT_ERRORS=$(echo "$CHANGED_FILES" | xargs npx eslint --no-warn 2>/dev/null | grep -c "error" || echo "0")
    fi
fi

# ═══════════════════════════════════════════════════════════
# STEP 2: 태스크 상태 수집 (Plan/칸반 파일 기반)
# ═══════════════════════════════════════════════════════════

# .llm/todo.md 또는 docs/plans/*.md에서 태스크 파싱
TOTAL_TASKS=0
DONE_TASKS=0
PENDING_TASKS=""

parse_tasks_from_file() {
    local file="$1"
    if [ ! -f "$file" ]; then return; fi

    while IFS= read -r line; do
        if echo "$line" | grep -qE '^\s*-\s*\[[ xX]\]'; then
            TOTAL_TASKS=$((TOTAL_TASKS + 1))
            if echo "$line" | grep -qE '^\s*-\s*\[[xX]\]'; then
                DONE_TASKS=$((DONE_TASKS + 1))
            else
                # 미완료 태스크 수집
                TASK_TEXT=$(echo "$line" | sed 's/^\s*-\s*\[ \]\s*//')
                PENDING_TASKS="${PENDING_TASKS}  - ${TASK_TEXT}\n"
            fi
        fi
    done < "$file"
}

# Plan 파일들 스캔
for plan_file in docs/plans/*.md .llm/todo.md; do
    parse_tasks_from_file "$plan_file"
done

# ═══════════════════════════════════════════════════════════
# STEP 3: Gap 분석
# ═══════════════════════════════════════════════════════════

if [ "$TOTAL_TASKS" -gt 0 ]; then
    GAP_RATE=$(( (DONE_TASKS * 100) / TOTAL_TASKS ))
else
    # 태스크 정의 없음 → 파일 변경 + 에러 기반 판단
    if [ "$TOTAL_CHANGED" -gt 0 ] && [ "$TSC_ERRORS" -eq 0 ] && [ "$LINT_ERRORS" -eq 0 ]; then
        GAP_RATE=100  # 변경 있고 에러 없으면 완료로 간주
    elif [ "$TOTAL_CHANGED" -eq 0 ]; then
        GAP_RATE=0    # 변경 없으면 작업 안 한 것
    else
        GAP_RATE=70   # 변경 있지만 에러 있으면 70%
    fi
fi

# 에러가 있으면 gap에서 차감
if [ "$TSC_ERRORS" -gt 0 ]; then
    PENALTY=$(( TSC_ERRORS * 5 ))
    [ "$PENALTY" -gt 30 ] && PENALTY=30
    GAP_RATE=$(( GAP_RATE - PENALTY ))
    [ "$GAP_RATE" -lt 0 ] && GAP_RATE=0
fi

if [ "$LINT_ERRORS" -gt 0 ]; then
    PENALTY=$(( LINT_ERRORS * 2 ))
    [ "$PENALTY" -gt 15 ] && PENALTY=15
    GAP_RATE=$(( GAP_RATE - PENALTY ))
    [ "$GAP_RATE" -lt 0 ] && GAP_RATE=0
fi

# ═══════════════════════════════════════════════════════════
# STEP 4: 상태 기록
# ═══════════════════════════════════════════════════════════

cat > "$NCO_STATE" <<STATEEOF
{
  "session_id": "$NCO_SESSION_ID",
  "changed_files": $TOTAL_CHANGED,
  "tsc_errors": $TSC_ERRORS,
  "lint_errors": $LINT_ERRORS,
  "total_tasks": $TOTAL_TASKS,
  "done_tasks": $DONE_TASKS,
  "gap_rate": $GAP_RATE,
  "last_check": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATEEOF

# ═══════════════════════════════════════════════════════════
# STEP 5: 판정 — 통과 or 재실행
# ═══════════════════════════════════════════════════════════

THRESHOLD=95

if [ "$GAP_RATE" -ge "$THRESHOLD" ]; then
    # ═══ PASS: 95%+ 달성 → 완료 + 다음 작업 추천 ═══

    # 다음 작업 후보 탐색
    NEXT_TASKS=""
    for plan_file in docs/plans/*.md .llm/todo.md; do
        if [ -f "$plan_file" ]; then
            NEXT=$(grep -m 3 '^\s*-\s*\[ \]' "$plan_file" 2>/dev/null | sed 's/^\s*-\s*\[ \]\s*//' | head -3)
            if [ -n "$NEXT" ]; then
                NEXT_TASKS="${NEXT_TASKS}${NEXT}\n"
            fi
        fi
    done

    cat >&2 <<PASSEOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[NCO Stop] Gap ${GAP_RATE}% — PASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
결과: ${TOTAL_CHANGED}개 파일 변경, tsc ${TSC_ERRORS}err, lint ${LINT_ERRORS}err
태스크: ${DONE_TASKS}/${TOTAL_TASKS} 완료
PASSEOF

    if [ -n "$NEXT_TASKS" ]; then
        cat >&2 <<NEXTEOF

다음 작업 추천:
$(echo -e "$NEXT_TASKS" | head -3 | nl -ba)

단축키: /next (다음 순차 작업) | /next-parallel (병렬 작업)
NEXTEOF
    fi

    exit 0

else
    # ═══ FAIL: 95% 미달 → 재실행 (exit 2) ═══
    # stderr 내용이 Claude에게 프롬프트로 주입됨

    cat >&2 <<FAILEOF
[NCO Stop Hook] Gap ${GAP_RATE}% < ${THRESHOLD}% — 작업 미완료. 계속 진행하세요.

현재 상태:
  파일 변경: ${TOTAL_CHANGED}개
  tsc 에러: ${TSC_ERRORS}개
  lint 에러: ${LINT_ERRORS}개
  태스크: ${DONE_TASKS}/${TOTAL_TASKS} 완료

미완료 항목:
$(echo -e "$PENDING_TASKS")
FAILEOF

    # tsc 에러가 있으면 에러 내용도 주입
    if [ "$TSC_ERRORS" -gt 0 ]; then
        echo "" >&2
        echo "TypeScript 에러 (수정 필요):" >&2
        npx tsc --noEmit 2>&1 | grep "error TS" | head -10 >&2
    fi

    # lint 에러가 있으면 에러 내용도 주입
    if [ "$LINT_ERRORS" -gt 0 ]; then
        echo "" >&2
        echo "ESLint 에러 (수정 필요):" >&2
        echo "$CHANGED_FILES" | xargs npx eslint --no-warn 2>/dev/null | grep "error" | head -10 >&2
    fi

    echo "" >&2
    echo "위 미완료 항목과 에러를 해결하고, gap ${THRESHOLD}% 이상을 달성하세요." >&2

    exit 2
fi
