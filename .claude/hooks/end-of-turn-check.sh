#!/bin/bash
# ═══════════════════════════════════════════════════════════
# NCO Stop Hook v3.0 — Self-Eval + Gap Analysis + Action Menu
# ═══════════════════════════════════════════════════════════
#
# 실행 시점: Claude Code CLI가 응답을 멈출 때 (매 턴 종료)
#
# v3 기능:
#   1. 세션 제목 표시 (현재 브랜치 + 최근 커밋 요약)
#   2. 작업 자가평가 (변경 파일, 에러, 품질 등급)
#   3. Gap 분석 (계획 vs 실제 완료율)
#   4. Gap < 95% → exit 2 (자동 재수정, stderr로 에러 주입)
#   5. Gap >= 95% → exit 0 + 다음 작업 액션 메뉴
#      /nco-next       — 다음 순차 작업
#      /nco-next-parallel — 독립 태스크 병렬 실행
#      /nco-task    — NCO 추천 작업 위임
#      /nco-gap        — 수동 gap 재분석
#
# exit 0 = Claude 정상 종료
# exit 2 = Claude 재실행 (stderr → 프롬프트 주입)
# ═══════════════════════════════════════════════════════════

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ═══ Resolve NCO_SESSION_ID: env var > process tree walk ═══
if [ -z "$NCO_SESSION_ID" ]; then
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      NCO_SESSION_ID="$_CK"
      break
    fi
  done
  NCO_SESSION_ID="${NCO_SESSION_ID:-${PPID:-$$}}"
fi

# ═══ Resolve NCO_NAME: env var > PID-file reservation ═══
if [ -z "$NCO_NAME" ]; then
  for _pf in /tmp/nco-names/claude-*.pid; do
    [ -f "$_pf" ] || continue
    _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
    if [ "$_rp" = "$NCO_SESSION_ID" ]; then
      NCO_NAME=$(basename "$_pf" .pid)
      break
    fi
  done
fi
MY_NAME="${NCO_NAME:-cli}"

# ═══ 유틸 ═══
to_int() { local v; v=$(echo "${1:-0}" | tr -dc '0-9'); echo "${v:-0}"; }

# ═══ 상태 파일 경로 ═══
NCO_SESSION_DIR="/tmp/nco-sessions"
NCO_STATE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"
NCO_HISTORY="$NCO_SESSION_DIR/$NCO_SESSION_ID-history.log"
mkdir -p "$NCO_SESSION_DIR" 2>/dev/null

# ═══════════════════════════════════════════════════════════
# STEP 1: 세션 컨텍스트 수집
# ═══════════════════════════════════════════════════════════

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git log -1 --pretty=format:"%s" 2>/dev/null | head -c 60 || echo "no commits")
SESSION_TITLE="${BRANCH} — ${LAST_COMMIT}"

# 턴 카운터 (히스토리 파일 라인 수)
TURN_COUNT=0
if [ -f "$NCO_HISTORY" ]; then
    TURN_COUNT=$(wc -l < "$NCO_HISTORY" | tr -d '[:space:]')
fi
TURN_COUNT=$(to_int "$TURN_COUNT")
TURN_COUNT=$((TURN_COUNT + 1))

# ═══════════════════════════════════════════════════════════
# STEP 2: 작업 결과 수집 (OPTIMIZED: cache + single call)
# ═══════════════════════════════════════════════════════════

# Cache TTL: 60s for tsc/lint (expensive)
CHECK_CACHE_TTL=60
CHECK_CACHE_DIR="/tmp/nco-check-cache"
mkdir -p "$CHECK_CACHE_DIR" 2>/dev/null
CACHE_KEY="check-$(date +%Y%m%d%H)"
CACHE_FILE="$CHECK_CACHE_DIR/$CACHE_KEY.cache"

_cached_check() {
    if [ -f "$CACHE_FILE" ]; then
        local mtime
        if mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null); then
            :
        elif mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null); then
            :
        else
            mtime=0
        fi
        local age=$(($(date +%s) - mtime))
        if [ "$age" -lt "$CHECK_CACHE_TTL" ]; then
            cat "$CACHE_FILE"
            return 0
        fi
    fi
    return 1
}

# Try cache first
if _cached_check; then
    eval "$(cat "$CACHE_FILE")"
else
    CHANGED_FILES_LIST=$(git diff --name-only 2>/dev/null)
    STAGED_FILES_LIST=$(git diff --cached --name-only 2>/dev/null)
    ALL_CHANGED=$(printf "%s\n%s" "$CHANGED_FILES_LIST" "$STAGED_FILES_LIST" | sort -u | grep -v '^$')

    CHANGED_COUNT=$(echo "$ALL_CHANGED" | grep -c '.' 2>/dev/null || echo 0)
    CHANGED_COUNT=$(to_int "$CHANGED_COUNT")

    DIFF_STAT=$(git diff --stat 2>/dev/null | tail -1)
    ADDITIONS=$(echo "$DIFF_STAT" | awk '{for(i=1;i<=NF;i++) if($(i+1)~/^insertion/) {print $i; found=1}} END{if(!found) print 0}')
    DELETIONS=$(echo "$DIFF_STAT" | awk '{for(i=1;i<=NF;i++) if($(i+1)~/^deletion/) {print $i; found=1}} END{if(!found) print 0}')
    ADDITIONS=$(to_int "$ADDITIONS")
    DELETIONS=$(to_int "$DELETIONS")

    # Only run tsc if files changed (skip for read-only)
    TSC_ERRORS=0
    if command -v npx &>/dev/null && [ -f "tsconfig.json" ] && [ "$CHANGED_COUNT" -gt 0 ]; then
        TSC_OUTPUT=$(npx tsc --noEmit 2>&1)
        TSC_ERRORS=$(echo "$TSC_OUTPUT" | grep -c "error TS" | tr -d '[:space:]' || true)
        TSC_ERRORS=$(to_int "$TSC_ERRORS")
    fi

    LINT_ERRORS=0
    if command -v npx &>/dev/null && [ -f "tsconfig.json" ] && [ "$CHANGED_COUNT" -gt 0 ]; then
        if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ] || [ -f "eslint.config.js" ]; then
            LINT_TARGET_FILES=$(echo "$ALL_CHANGED" | grep -E '\.(ts|tsx|js|jsx)$' | head -10)
            if [ -n "$LINT_TARGET_FILES" ]; then
                LINT_OUTPUT=$(echo "$LINT_TARGET_FILES" | xargs npx eslint --no-warn 2>/dev/null)
                LINT_ERRORS=$(echo "$LINT_OUTPUT" | grep -c "error" | tr -d '[:space:]' || true)
                LINT_ERRORS=$(to_int "$LINT_ERRORS")
            fi
        fi
    fi

    # Write cache
    cat > "$CACHE_FILE" <<EOF
CHANGED_COUNT=$CHANGED_COUNT
ADDITIONS=$ADDITIONS
DELETIONS=$DELETIONS
TSC_ERRORS=$TSC_ERRORS
LINT_ERRORS=$LINT_ERRORS
EOF
fi

# ═══════════════════════════════════════════════════════════
# STEP 3: 태스크 상태 수집
# ═══════════════════════════════════════════════════════════

TOTAL_TASKS=0
DONE_TASKS=0
PENDING_TASKS=""
PENDING_TASK_LIST=""

parse_tasks_from_file() {
    local file="$1"
    [ ! -f "$file" ] && return
    while IFS= read -r line; do
        if echo "$line" | grep -qE '^\s*-\s*\[[ xX]\]'; then
            TOTAL_TASKS=$((TOTAL_TASKS + 1))
            if echo "$line" | grep -qE '^\s*-\s*\[[xX]\]'; then
                DONE_TASKS=$((DONE_TASKS + 1))
            else
                local text
                text=$(echo "$line" | LC_ALL=C sed 's/^\s*-\s*\[ \]\s*//')
                PENDING_TASKS="${PENDING_TASKS}  - ${text}\n"
                PENDING_TASK_LIST="${PENDING_TASK_LIST}${text}|"
            fi
        fi
    done < "$file"
}

for plan_file in docs/plans/*.md .llm/todo.md; do
    parse_tasks_from_file "$plan_file"
done

TOTAL_TASKS=$(to_int "$TOTAL_TASKS")
DONE_TASKS=$(to_int "$DONE_TASKS")

# ═══════════════════════════════════════════════════════════
# STEP 4: 자가평가 (품질 등급 산정)
# ═══════════════════════════════════════════════════════════

# Gap Rate 계산
if [ "$TOTAL_TASKS" -gt 0 ]; then
    GAP_RATE=$(( (DONE_TASKS * 100) / TOTAL_TASKS ))
else
    if [ "$CHANGED_COUNT" -gt 0 ] && [ "$TSC_ERRORS" -eq 0 ] && [ "$LINT_ERRORS" -eq 0 ]; then
        GAP_RATE=100
    elif [ "$CHANGED_COUNT" -eq 0 ]; then
        GAP_RATE=100
    else
        GAP_RATE=70
    fi
fi

# 에러 감점
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

# 품질 등급
if [ "$GAP_RATE" -ge 95 ]; then
    GRADE="A"
    GRADE_ICON="★"
    GRADE_DESC="완료"
elif [ "$GAP_RATE" -ge 80 ]; then
    GRADE="B"
    GRADE_ICON="●"
    GRADE_DESC="양호 — 마무리 필요"
elif [ "$GAP_RATE" -ge 60 ]; then
    GRADE="C"
    GRADE_ICON="▲"
    GRADE_DESC="미흡 — 에러/미완료 다수"
else
    GRADE="D"
    GRADE_ICON="✗"
    GRADE_DESC="위험 — 즉시 수정 필요"
fi

# 자가평가 요약 (한 줄)
EVAL_SUMMARY=""
if [ "$TSC_ERRORS" -gt 0 ] && [ "$LINT_ERRORS" -gt 0 ]; then
    EVAL_SUMMARY="tsc ${TSC_ERRORS}err + lint ${LINT_ERRORS}err → 수정 필요"
elif [ "$TSC_ERRORS" -gt 0 ]; then
    EVAL_SUMMARY="tsc ${TSC_ERRORS}err → 타입 에러 수정 필요"
elif [ "$LINT_ERRORS" -gt 0 ]; then
    EVAL_SUMMARY="lint ${LINT_ERRORS}err → 코드 스타일 수정 필요"
elif [ "$CHANGED_COUNT" -eq 0 ]; then
    EVAL_SUMMARY="변경 없음"
else
    EVAL_SUMMARY="깨끗함 — 에러 없음"
fi

# ═══════════════════════════════════════════════════════════
# STEP 5: 히스토리 기록
# ═══════════════════════════════════════════════════════════

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) turn=${TURN_COUNT} gap=${GAP_RATE}% grade=${GRADE} files=${CHANGED_COUNT} +${ADDITIONS}/-${DELETIONS} tsc=${TSC_ERRORS} lint=${LINT_ERRORS}" >> "$NCO_HISTORY"

cat > "$NCO_STATE" <<STATEEOF
{
  "session_id": "$NCO_SESSION_ID",
  "session_title": "$(echo "$SESSION_TITLE" | LC_ALL=C sed 's/"/\\"/g')",
  "turn": $TURN_COUNT,
  "changed_files": $CHANGED_COUNT,
  "additions": $ADDITIONS,
  "deletions": $DELETIONS,
  "tsc_errors": $TSC_ERRORS,
  "lint_errors": $LINT_ERRORS,
  "total_tasks": $TOTAL_TASKS,
  "done_tasks": $DONE_TASKS,
  "gap_rate": $GAP_RATE,
  "grade": "$GRADE",
  "eval": "$(echo "$EVAL_SUMMARY" | LC_ALL=C sed 's/"/\\"/g')",
  "last_check": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATEEOF

# ═══════════════════════════════════════════════════════════
# STEP 6: 판정 — 통과 or 재실행
# ═══════════════════════════════════════════════════════════

THRESHOLD=95

# ── 공통 헤더 ──
HEADER=$(cat <<HDREOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[NCO:${MY_NAME}] ${SESSION_TITLE}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
턴 #${TURN_COUNT} | Gap ${GAP_RATE}% | ${GRADE_ICON} ${GRADE} — ${GRADE_DESC}
HDREOF
)

# ── 공통 자가평가 블록 ──
EVAL_BLOCK=$(cat <<EVALEOF

[자가평가]
  파일: ${CHANGED_COUNT}개 변경 (+${ADDITIONS}/-${DELETIONS}) ${FILE_SUMMARY}
  tsc:  ${TSC_ERRORS}err | lint: ${LINT_ERRORS}err
  태스크: ${DONE_TASKS}/${TOTAL_TASKS} 완료
  평가: ${EVAL_SUMMARY}
EVALEOF
)

if [ "$GAP_RATE" -ge "$THRESHOLD" ]; then
# ═══ PASS ═══ (COMPACT OUTPUT)

    cat >&2 <<PASSEOF
[NCO:${MY_NAME}] ${SESSION_TITLE}
turn=${TURN_COUNT} gap=${GAP_RATE}% grade=${GRADE} files=${CHANGED_COUNT} +${ADDITIONS}/-${DELETIONS} tsc=${TSC_ERRORS} lint=${LINT_ERRORS}
PASSEOF

    # Check for mesh messages (compact)
    MESH_MSGS=""
    if (echo > /dev/tcp/localhost/6200) 2>/dev/null; then
        MESH_HB_RESULT=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
          -H "Content-Type: application/json" \
          -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"idle\"}" 2>/dev/null)

        if [ -n "$MESH_HB_RESULT" ]; then
            MESH_MSGS=$(echo "$MESH_HB_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
if msgs:
    for m in msgs[:3]:
        t=m.get('type','info')[:4]
        f=m.get('fromAgent','?')[:8]
        c=m.get('content','')[:40]
        print(f'{t}:{f}:{c}')
" 2>/dev/null)
        fi
    fi

    if [ -n "$MESH_MSGS" ]; then
        MESH_COUNTER_FILE="/tmp/nco-mesh-auto-${NCO_SESSION_ID}.count"
        MESH_COUNT=$(cat "$MESH_COUNTER_FILE" 2>/dev/null || echo "0")
        MESH_COUNT=$((MESH_COUNT + 1))

        if [ "$MESH_COUNT" -le 3 ]; then
            echo "$MESH_COUNT" > "$MESH_COUNTER_FILE"
            echo "[MESH] ${MESH_MSGS}" >&2
            exit 2
        else
            rm -f "$MESH_COUNTER_FILE"
        fi
    else
        rm -f "/tmp/nco-mesh-auto-${NCO_SESSION_ID}.count" 2>/dev/null
    fi

    echo "act: /nco-next | /nco-parallel | /nco-task | /nco-mesh | /nco-gap" >&2
    exit 0

else
    # ═══ FAIL: 자동 재수정 (COMPACT) ═══

    cat >&2 <<FAILEOF
[NCO:${MY_NAME}] Gap ${GAP_RATE}% < ${THRESHOLD}% (auto-fix mode)
turn=${TURN_COUNT} files=${CHANGED_COUNT} +${ADDITIONS}/-${DELETIONS} tsc=${TSC_ERRORS} lint=${LINT_ERRORS}
FAILEOF

    [ "$TSC_ERRORS" -gt 0 ] && echo "tsc: $TSC_ERRORS err" >&2
    [ "$LINT_ERRORS" -gt 0 ] && echo "lint: $LINT_ERRORS err" >&2

    [ "$GAP_RATE" -lt "$THRESHOLD" ] && echo "gap: need ${THRESHOLD}%+" >&2

    # Check mesh messages even in fail
    if (echo > /dev/tcp/localhost/6200) 2>/dev/null; then
        MESH_HB_FAIL=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
          -H "Content-Type: application/json" \
          -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"coding\"}" 2>/dev/null)

        if [ -n "$MESH_HB_FAIL" ]; then
            MESH_MSGS_FAIL=$(echo "$MESH_HB_FAIL" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
if msgs:
    for m in msgs[:2]:
        t=m.get('type','info')[:4]
        f=m.get('fromAgent','?')[:8]
        c=m.get('content','')[:40]
        print(f'{t}:{f}:{c}')
" 2>/dev/null)
            [ -n "$MESH_MSGS_FAIL" ] && echo "[MESH] ${MESH_MSGS_FAIL}" >&2
        fi
    fi

exit 2
fi
