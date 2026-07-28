#!/bin/bash
# Stop Hook: NCO 품질 게이트 — 완료 전 실제 검증 강제
# exit 0 = 통과 | exit 2 = 차단 (stderr → Claude 주입)
# 목표: 에이전트 자기 보고(self-report) 대신 서버/컴파일러 실제 검증 결과만 신뢰

echo "[$(date +%H:%M:%S)] HOOK_START nco-stop-quality-gate.sh" >> /tmp/claude-hook-trace.log
trap 'echo "[$(date +%H:%M:%S)] HOOK_END   nco-stop-quality-gate.sh exit=$?" >> /tmp/claude-hook-trace.log' EXIT

INPUT=$(cat)

# ── 세션 ID 결정 ────────────────────────────────────────────────────────
if [ -z "$NCO_SESSION_ID" ]; then
    _CK=$$
    for _i in 1 2 3 4 5; do
        _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
        [ -z "$_CK" ] && break
        _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
        echo "$_CM" | grep -qE '^(claude|node)$' && { NCO_SESSION_ID="$_CK"; break; }
    done
    NCO_SESSION_ID="${NCO_SESSION_ID:-$$}"
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/nova-ai/project/nco}"
NCO_API="http://localhost:6200"

# ── NCO 오프라인이면 게이트 스킵 ────────────────────────────────────────
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 "$NCO_API/health" 2>/dev/null)
if [ -z "$NCO_HEALTH" ]; then
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
# GATE 1: TypeScript 컴파일 오류 검사 (자기 보고 불신 — 컴파일러만 신뢰)
# ═══════════════════════════════════════════════════════════════════════
TSC_ERRORS=""
if [ -f "$PROJECT_DIR/tsconfig.json" ]; then
    TSC_OUTPUT=$(cd "$PROJECT_DIR" && ./node_modules/.bin/tsc --noEmit 2>&1 || npx tsc --noEmit 2>&1)
    TSC_EXIT=$?
    if [ "$TSC_EXIT" -ne 0 ]; then
        # 오류 수 카운트
        TSC_ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c "error TS" 2>/dev/null || echo "?")
        TSC_ERRORS="TypeScript 컴파일 오류 ${TSC_ERROR_COUNT}개 존재"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════
# GATE 2: 서버 측 NCO 호출 검증 (파일 조작 불가 — SQLite 기반)
# 전략: spawned_by_cli="claude-code" 태스크를 최근 30분 기준으로 검색
# (세션 ID는 MCP 서버 PID vs Claude Code PID 불일치로 신뢰 불가)
# ═══════════════════════════════════════════════════════════════════════
NCO_REAL_CALLS=0
NCO_FEATURES_USED=""

# 현재 시간 기준 30분 이내 생성된 claude-code 태스크 검색
TASK_DATA=$(curl -s --connect-timeout 2 --max-time 4 \
    "$NCO_API/api/tasks?limit=50" 2>/dev/null)

if [ -n "$TASK_DATA" ]; then
    _result=$(echo "$TASK_DATA" | python3 -c "
import sys, json, datetime

MODE_CATEGORIES = {
    'task': 'task',
    'parallel': 'parallel',
    'discussion': 'discussion',
    'consensus': 'consensus',
    'commander': 'commander',
    'conductor': 'commander',
    'harness': 'harness',
    'broadcast': 'broadcast',
    'hive': 'discussion',
    'agent': 'agent',
}

try:
    d = json.load(sys.stdin)
    tasks = d.get('tasks', d) if isinstance(d, dict) else d
    now = datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(minutes=30)
    recent_claude = []
    for t in tasks:
        if t.get('spawned_by_cli') != 'claude-code':
            continue
        ts_str = t.get('created_at', '')
        try:
            ts = datetime.datetime.strptime(ts_str[:19], '%Y-%m-%d %H:%M:%S')
            if ts >= cutoff:
                recent_claude.append(t)
        except:
            pass
    count = len(recent_claude)
    cats = set()
    for t in recent_claude:
        mode = t.get('mode', '')
        cat = MODE_CATEGORIES.get(mode)
        if cat:
            cats.add(cat)
    cats_str = ','.join(sorted(cats)) if cats else 'none'
    print(count, cats_str)
except Exception as e:
    print('0 none')
" 2>/dev/null || echo "0 none")

    NCO_REAL_CALLS=$(echo "$_result" | awk '{print $1}')
    NCO_FEATURES_USED=$(echo "$_result" | awk '{print $2}')
    NCO_REAL_CALLS=${NCO_REAL_CALLS:-0}
    NCO_FEATURES_USED=${NCO_FEATURES_USED:-none}
fi

# ── feature breadth 카운트 ──────────────────────────────────────────────
FEATURE_COUNT=0
if [ "$NCO_FEATURES_USED" != "none" ] && [ -n "$NCO_FEATURES_USED" ]; then
    FEATURE_COUNT=$(echo "$NCO_FEATURES_USED" | tr ',' '\n' | grep -c .)
fi

# ═══════════════════════════════════════════════════════════════════════
# GATE 3: 변경 파일이 있는 경우만 품질 게이트 적용
# ═══════════════════════════════════════════════════════════════════════
CHANGED_FILES=$(git -C "$PROJECT_DIR" diff --name-only 2>/dev/null | wc -l | tr -d ' ')
CHANGED_FILES=${CHANGED_FILES:-0}
STAGED_FILES=$(git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
STAGED_FILES=${STAGED_FILES:-0}
TOTAL_CHANGES=$(( CHANGED_FILES + STAGED_FILES ))

# 세션 시작 전 baseline 차감 (pre-existing uncommitted 파일 제외)
BASELINE=0
BASELINE_FILE="/tmp/nco-gate-baseline-${NCO_SESSION_ID}"
if [ -f "$BASELINE_FILE" ]; then
    BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null | tr -d '[:space:]')
    BASELINE=${BASELINE:-0}
fi
SESSION_CHANGES=$(( TOTAL_CHANGES - BASELINE ))
[ "$SESSION_CHANGES" -lt 0 ] && SESSION_CHANGES=0

# 변경 없으면 게이트 스킵 (읽기/분석 작업)
if [ "$SESSION_CHANGES" -eq 0 ] && [ "$NCO_REAL_CALLS" -eq 0 ]; then
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
# 판정 — 하나라도 실패하면 차단
# ═══════════════════════════════════════════════════════════════════════
GATE_FAILURES=()

# Gate 1: TypeScript 오류
if [ -n "$TSC_ERRORS" ]; then
    GATE_FAILURES+=("❌ GATE 1 (컴파일): $TSC_ERRORS")
fi

# Gate 2a: NCO 최소 호출 수 (변경이 있을 때)
if [ "$SESSION_CHANGES" -ge 3 ] && [ "$NCO_REAL_CALLS" -eq 0 ]; then
    GATE_FAILURES+=("❌ GATE 2a (NCO 미사용): 파일 ${SESSION_CHANGES}개 변경했으나 NCO 에이전트 사용 기록 없음")
fi

# Gate 2b: feature breadth (변경이 많을 때 다양한 NCO 기능 사용 필요)
if [ "$SESSION_CHANGES" -ge 5 ] && [ "$FEATURE_COUNT" -lt 2 ]; then
    GATE_FAILURES+=("❌ GATE 2b (기능 다양성): 대형 변경(${SESSION_CHANGES}파일)은 최소 2개 NCO 기능 필요 (현재: ${FEATURE_COUNT}개 — ${NCO_FEATURES_USED})")
fi

# ── 통과 ────────────────────────────────────────────────────────────────
if [ ${#GATE_FAILURES[@]} -eq 0 ]; then
    echo "[$(date +%H:%M:%S)] NCO QUALITY GATE PASSED: calls=${NCO_REAL_CALLS}, features=${NCO_FEATURES_USED}, changes=${TOTAL_CHANGES}" >> /tmp/claude-hook-trace.log
    exit 0
fi

# ── 차단 ────────────────────────────────────────────────────────────────
FAILURE_MSG=$(printf '%s\n' "${GATE_FAILURES[@]}")

cat >&2 <<GATE_FAIL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[NCO 품질 게이트 — 완료 차단]

세션: ${NCO_SESSION_ID}
변경 파일: ${TOTAL_CHANGES}개
NCO 실제 호출 (서버 검증): ${NCO_REAL_CALLS}회
사용된 NCO 기능: ${NCO_FEATURES_USED}

실패한 게이트:
${FAILURE_MSG}

━━━ 해결 방법 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GATE 1 실패 → tsc 오류를 수정하거나 NCO 에이전트에 위임:
  curl -s -X POST localhost:6200/api/task -H 'Content-Type: application/json' \
    -d '{"ai":"codex","prompt":"Fix TypeScript errors in this project"}'

GATE 2 실패 → NCO 에이전트 사용 후 재완료:
  nco_task / nco_parallel / nco_commander / nco_discussion / nco_harness

진실만 보고: 이 결과는 서버 DB(SQLite)와 tsc 컴파일러의 실제 검증입니다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GATE_FAIL

exit 2
