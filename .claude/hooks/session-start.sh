#!/bin/bash
echo "[$(date +%H:%M:%S)] HOOK_START session-start.sh" >> /tmp/claude-hook-trace.log
# SessionStart Hook - NCO context auto-load + CLI Mesh registration
# Usage: NCO_NAME=nova claude   ← 이름으로 mesh에 자동 등록

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[35m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/nova-ai/project/nco}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ========================================
# Find the actual Claude Code PID (our grandparent: bash -> /bin/sh -> claude)
# ========================================
_CLAUDE_PID=""
_CHECK_PID=$$
for _i in 1 2 3 4 5; do
    _CHECK_PID=$(ps -o ppid= -p "$_CHECK_PID" 2>/dev/null | tr -d ' ')
    [ -z "$_CHECK_PID" ] && break
    _CMD=$(ps -o comm= -p "$_CHECK_PID" 2>/dev/null)
    if echo "$_CMD" | grep -qE '^(claude|node)$'; then
        _CLAUDE_PID="$_CHECK_PID"
        break
    fi
done
NCO_SESSION_ID="${_CLAUDE_PID:-${PPID:-$$}}"

# ========================================
# NCO_NAME — CLI Identity (PID-file based reservation)
# ========================================
# Priority: NCO_NAME env var > /tmp/nco-names/ PID-file reservation
NCO_NAMES_DIR="/tmp/nco-names"
mkdir -p "$NCO_NAMES_DIR" 2>/dev/null

if [ -z "$NCO_NAME" ]; then
    # Atomic name reservation using mkdir lock (macOS-compatible)
    _LOCK_DIR="$NCO_NAMES_DIR/.lock.d"
    _LOCK_WAIT=0
    while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
        sleep 0.1
        _LOCK_WAIT=$((_LOCK_WAIT + 1))
        [ "$_LOCK_WAIT" -gt 50 ] && rm -rf "$_LOCK_DIR" && break  # 5s timeout
    done

    # 1. Clean dead PID files
    for _pidfile in "$NCO_NAMES_DIR"/claude-*.pid; do
        [ -f "$_pidfile" ] || continue
        _rpid=$(cat "$_pidfile" 2>/dev/null | tr -d '[:space:]')
        if [ -z "$_rpid" ] || ! ps -p "$_rpid" >/dev/null 2>&1; then
            rm -f "$_pidfile"
        fi
    done

    # 2. Check if we already have a name (reconnecting session)
    for _pidfile in "$NCO_NAMES_DIR"/claude-*.pid; do
        [ -f "$_pidfile" ] || continue
        _rpid=$(cat "$_pidfile" 2>/dev/null | tr -d '[:space:]')
        if [ "$_rpid" = "$NCO_SESSION_ID" ]; then
            _existing=$(basename "$_pidfile" .pid)
            echo "$_existing" > "$NCO_NAMES_DIR/.last-assigned"
            rmdir "$_LOCK_DIR" 2>/dev/null
            NCO_NAME="$_existing"
            break
        fi
    done

    if [ -z "$NCO_NAME" ]; then
        # 3. Find lowest available number
        _NUM=1
        while [ -f "$NCO_NAMES_DIR/claude-${_NUM}.pid" ]; do
            _NUM=$((_NUM + 1))
        done

        # 4. Reserve it
        echo "$NCO_SESSION_ID" > "$NCO_NAMES_DIR/claude-${_NUM}.pid"
        echo "claude-${_NUM}" > "$NCO_NAMES_DIR/.last-assigned"
        NCO_NAME="claude-${_NUM}"
    fi

    rmdir "$_LOCK_DIR" 2>/dev/null
fi

# ========================================
# Persist NCO_NAME via CLAUDE_ENV_FILE
# ========================================
if [ -n "$CLAUDE_ENV_FILE" ]; then
    echo "export NCO_NAME=\"$NCO_NAME\"" >> "$CLAUDE_ENV_FILE"
    echo "export NCO_SESSION_ID=\"$NCO_SESSION_ID\"" >> "$CLAUDE_ENV_FILE"
fi

# ========================================
# Session tracking system
# ========================================
NCO_SESSION_DIR="/tmp/nco-sessions"
mkdir -p "$NCO_SESSION_DIR" 2>/dev/null
NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

# Clean sessions older than 24h
find "$NCO_SESSION_DIR" -name "*.json" -mmin +1440 -delete 2>/dev/null

# Save git baseline for quality gate (pre-existing changes before this session)
_BASELINE_CHANGED=$(git -C "$PROJECT_DIR" diff --name-only 2>/dev/null | wc -l | tr -d ' ')
_BASELINE_STAGED=$(git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
_BASELINE_TOTAL=$(( ${_BASELINE_CHANGED:-0} + ${_BASELINE_STAGED:-0} ))
echo "$_BASELINE_TOTAL" > "/tmp/nco-gate-baseline-${NCO_SESSION_ID}"

# Create session state file (now includes NCO_NAME)
cat > "$NCO_SESSION_FILE" <<SESSIONJSON
{
  "session_id": "$NCO_SESSION_ID",
  "nco_name": "$NCO_NAME",
  "pid": $NCO_SESSION_ID,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nco_used": false,
  "nco_commands": [],
  "changed_files": 0,
  "last_activity": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
SESSIONJSON

# ========================================
# Header (COMPACT)
# ========================================
echo -e "${CYAN}[NCO:${NCO_NAME}]${NC}" >&2

# Compact status (single line each)
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)
NCO_STATE="OFFLINE"
[ -n "$NCO_HEALTH" ] && NCO_STATE="ONLINE"

VLLM_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:8000/health 2>/dev/null)
VLLM_STATE="OFFLINE"
[ -n "$VLLM_HEALTH" ] && VLLM_STATE="ONLINE"

echo "NCO:${NCO_STATE} vLLM:${VLLM_STATE}" >&2

# Register to mesh (if NCO online)
BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
if [ -n "$NCO_HEALTH" ]; then
    MESH_RESULT=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$NCO_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"idle\",\"currentWork\":\"세션 시작\",\"branch\":\"$BRANCH\"}" 2>/dev/null)

    MESH_SESSIONS=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/mesh/sessions 2>/dev/null)
    MESH_COUNT=$(echo "$MESH_SESSIONS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "0")

    echo "mesh:${NCO_NAME}(${MESH_COUNT})" >&2
fi

echo "session:${NCO_SESSION_FILE}" >&2
echo -e "${CYAN}  NCO Session — ${BOLD}${YELLOW}${NCO_NAME}${NC}${CYAN}              ${NC}" >&2
echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2

# ========================================
# TIER1 rules
# ========================================
echo "" >&2
echo -e "${GREEN}TIER1 Rules:${NC}" >&2
echo -e "  1. Trust > Competence" >&2
echo -e "  2. No report without source" >&2
echo -e "  3. No completion without verification" >&2
echo -e "  4. No fake workers" >&2
echo -e "  5. VRAM/API verification required" >&2
echo "" >&2

# Git status
echo -e "${YELLOW}Git Status:${NC}" >&2
git status --short 2>/dev/null | head -10 >&2

# Recent commits
echo "" >&2
echo -e "${YELLOW}Recent Commits:${NC}" >&2
git log --oneline -5 2>/dev/null >&2

# @.claude tagged learnings
LEARNINGS=$(git log --oneline -20 --grep="@.claude" 2>/dev/null)
if [ -n "$LEARNINGS" ]; then
    echo "" >&2
    echo -e "${GREEN}Learnings (@.claude):${NC}" >&2
    echo "$LEARNINGS" >&2
fi

# TODO file
if [ -f ".llm/todo.md" ]; then
    echo "" >&2
    echo -e "${YELLOW}Current Tasks:${NC}" >&2
    cat .llm/todo.md >&2
fi

# ========================================
# NCO + MLX status
# ========================================
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)
if [ -n "$NCO_HEALTH" ]; then
    echo "" >&2
    echo -e "${GREEN}NCO Engine: Online${NC}" >&2
else
    echo "" >&2
    echo -e "${YELLOW}NCO Engine: Offline${NC}" >&2
fi

MLX_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:8000/health 2>/dev/null)
if [ -n "$MLX_HEALTH" ]; then
    echo -e "${GREEN}MLX: Online${NC}" >&2
else
    echo -e "${YELLOW}MLX: Offline${NC}" >&2
fi

# ========================================
# Claude-Gemma (Anthropic→MLX 프록시 4100) — 워크플로 안내
# ========================================
GEMMA_HINT=0
if echo "${ANTHROPIC_BASE_URL:-}" | grep -q '4100'; then
    GEMMA_HINT=1
elif curl -sf --connect-timeout 1 --max-time 2 http://127.0.0.1:4100/health >/dev/null 2>&1; then
    GEMMA_HINT=1
fi
if [ "$GEMMA_HINT" -eq 1 ]; then
    echo "" >&2
    echo -e "${CYAN}Claude-Gemma:${NC} 토큰 절약 규칙은 ${BOLD}첫 프롬프트부터 자동 적용${NC} (훅). 상세만 ${BOLD}/claude-gemma-pipeline${NC}${NC}" >&2
fi

# ========================================
# Advisor 모델 설정 표시
# ========================================
SETTINGS_FILE="$HOME/.claude/settings.json"
ADVISOR_MODEL=""
MAIN_MODEL=""
if [ -f "$SETTINGS_FILE" ]; then
    ADVISOR_MODEL=$(python3 -c "
import json
try:
    d = json.load(open('$SETTINGS_FILE'))
    print(d.get('advisorModel', ''))
except: print('')
" 2>/dev/null)
    MAIN_MODEL=$(python3 -c "
import json
try:
    d = json.load(open('$SETTINGS_FILE'))
    print(d.get('model', 'sonnet'))
except: print('sonnet')
" 2>/dev/null)
fi
echo "" >&2
if [ -n "$ADVISOR_MODEL" ]; then
    echo -e "${MAGENTA}Advisor: ${BOLD}${ADVISOR_MODEL}${NC}${MAGENTA} (메인: ${MAIN_MODEL}) — 복잡·설계 작업 전 /advisor 호출 권장${NC}" >&2
    echo -e "${MAGENTA}  사용: 복잡한 구현 전 | Grade C/D 발생 시 | 아키텍처 결정 시${NC}" >&2
else
    echo -e "${YELLOW}Advisor: 미설정 — settings.json에 advisorModel 추가 권장${NC}" >&2
fi

# ========================================
# CLI Mesh — Register with NCO_NAME
# ========================================
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")

if [ -n "$NCO_HEALTH" ]; then
    MESH_RESULT=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$NCO_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"idle\",\"currentWork\":\"세션 시작\",\"branch\":\"$BRANCH\"}" 2>/dev/null)

    # Show active mesh sessions
    MESH_SESSIONS=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/mesh/sessions 2>/dev/null)
    MESH_COUNT=$(echo "$MESH_SESSIONS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "0")

    echo "" >&2
    echo -e "${MAGENTA}CLI Mesh: ${NCO_NAME} registered (${MESH_COUNT} online)${NC}" >&2

    if [ "$MESH_COUNT" -gt 1 ]; then
        echo "$MESH_SESSIONS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('sessions',[]):
    name = s.get('agentId','?')
    status = s.get('status','?')
    work = s.get('currentWork','') or 'idle'
    print(f'  • {name} ({status}): {work}')
" 2>/dev/null >&2
    fi
fi

echo "" >&2
echo -e "${GREEN}Session: ${NCO_NAME} (${NCO_SESSION_FILE})${NC}" >&2
echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2
