#!/bin/bash
# SessionStart Hook - NCO context auto-load + CLI Mesh registration
# Usage: NCO_NAME=nova claude   ← 이름으로 mesh에 자동 등록

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[35m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
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
    # Atomic name reservation using flock
    (
        flock -w 5 200 || exit 1

        # 1. Clean dead PID files
        for _pidfile in "$NCO_NAMES_DIR"/claude-*.pid; do
            [ -f "$_pidfile" ] || continue
            _rpid=$(cat "$_pidfile" 2>/dev/null | tr -d '[:space:]')
            if [ -z "$_rpid" ] || ! [ -d "/proc/$_rpid" ]; then
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
                exit 0
            fi
        done

        # 3. Find lowest available number
        _NUM=1
        while [ -f "$NCO_NAMES_DIR/claude-${_NUM}.pid" ]; do
            _NUM=$((_NUM + 1))
        done

        # 4. Reserve it atomically
        echo "$NCO_SESSION_ID" > "$NCO_NAMES_DIR/claude-${_NUM}.pid"
        echo "claude-${_NUM}" > "$NCO_NAMES_DIR/.last-assigned"

    ) 200>"$NCO_NAMES_DIR/.lock"

    NCO_NAME=$(cat "$NCO_NAMES_DIR/.last-assigned" 2>/dev/null)
    NCO_NAME="${NCO_NAME:-claude-1}"
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
# Header
# ========================================
echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2
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
# NCO + vLLM status
# ========================================
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)
if [ -n "$NCO_HEALTH" ]; then
    echo "" >&2
    echo -e "${GREEN}NCO Engine: Online${NC}" >&2
else
    echo "" >&2
    echo -e "${YELLOW}NCO Engine: Offline${NC}" >&2
fi

VLLM_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:8000/health 2>/dev/null)
if [ -n "$VLLM_HEALTH" ]; then
    echo -e "${GREEN}vLLM: Online${NC}" >&2
else
    echo -e "${YELLOW}vLLM: Offline${NC}" >&2
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
