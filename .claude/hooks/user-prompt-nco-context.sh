#!/bin/bash
# UserPromptSubmit Hook: NCO context injection (never blocks)
# Purpose: Provide NCO status + usage hints to Claude naturally
# Rule: Never exit 2

INPUT=$(cat)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"

# NCO health check (2s max)
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)

if [ -n "$NCO_HEALTH" ]; then
    PROVIDER_COUNT=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/ai-providers 2>/dev/null | grep -o '"id"' | wc -l 2>/dev/null || echo "?")

    # Read session state
    NCO_SESSION_DIR="/tmp/nco-sessions"
    NCO_SESSION_ID="${PPID:-$$}"
    NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

    TOTAL_CHANGED=0
    NCO_USED="false"
    if [ -f "$NCO_SESSION_FILE" ]; then
        TOTAL_CHANGED=$(grep -o '"changed_files": *[0-9]*' "$NCO_SESSION_FILE" 2>/dev/null | grep -o '[0-9]*' || echo "0")
        NCO_USED=$(grep -o '"nco_used": *[a-z]*' "$NCO_SESSION_FILE" 2>/dev/null | grep -o 'true\|false' || echo "false")
    else
        cd "$PROJECT_DIR" 2>/dev/null
        C1=$(git diff --name-only 2>/dev/null | wc -l || echo "0")
        C2=$(git diff --cached --name-only 2>/dev/null | wc -l || echo "0")
        TOTAL_CHANGED=$((C1 + C2))
    fi

    # Generate NCO usage hint
    if [ "$TOTAL_CHANGED" -ge 5 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="MUST_USE_NCO - ${TOTAL_CHANGED} files changed but NCO not yet used. Use MCP tools automatically. Priority: vllm > gemini > codex."
    elif [ "$TOTAL_CHANGED" -ge 3 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="SHOULD_USE_NCO - ${TOTAL_CHANGED} files changed. Use NCO MCP tools for review."
    elif [ "$NCO_USED" = "true" ]; then
        NCO_HINT="NCO_ACTIVE - NCO already used this session."
    else
        NCO_HINT="AVAILABLE - ${TOTAL_CHANGED} files changed. NCO ready."
    fi

    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[NCO] Online (${PROVIDER_COUNT} providers). Changed: ${TOTAL_CHANGED} files. ${NCO_HINT}"
  }
}
ENDJSON
else
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[NCO] Offline. Run /nco-start if needed."
  }
}
ENDJSON
fi

exit 0
