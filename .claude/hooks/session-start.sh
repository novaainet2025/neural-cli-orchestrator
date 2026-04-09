#!/bin/bash
# SessionStart Hook - NCO context auto-load
# Boris Cherny strategy: compound knowledge across sessions

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ========================================
# Session tracking system
# ========================================
NCO_SESSION_DIR="/tmp/nco-sessions"
mkdir -p "$NCO_SESSION_DIR" 2>/dev/null

NCO_SESSION_ID="${PPID:-$$}"
NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

# Clean sessions older than 24h
find "$NCO_SESSION_DIR" -name "*.json" -mmin +1440 -delete 2>/dev/null

# Create session state file
cat > "$NCO_SESSION_FILE" <<SESSIONJSON
{
  "session_id": "$NCO_SESSION_ID",
  "pid": $NCO_SESSION_ID,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nco_used": false,
  "nco_commands": [],
  "changed_files": 0,
  "last_activity": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
SESSIONJSON

echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2
echo -e "${CYAN}    NCO Session Context                ${NC}" >&2
echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2

# ========================================
# TIER1 rules - always loaded
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

# NCO system status
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)
if [ -n "$NCO_HEALTH" ]; then
    echo "" >&2
    echo -e "${GREEN}NCO Engine: Online${NC}" >&2
else
    echo "" >&2
    echo -e "${YELLOW}NCO Engine: Offline${NC}" >&2
fi

# vLLM status (replaces Ollama)
VLLM_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:8000/health 2>/dev/null)
if [ -n "$VLLM_HEALTH" ]; then
    echo -e "${GREEN}vLLM: Online${NC}" >&2
else
    echo -e "${YELLOW}vLLM: Offline${NC}" >&2
fi

echo "" >&2
echo -e "${GREEN}Session: $NCO_SESSION_FILE${NC}" >&2
echo -e "${CYAN}═══════════════════════════════════════${NC}" >&2
