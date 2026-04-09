#!/bin/bash
# Stop Hook - NCO session state recording (lightweight)
# Purpose: Record NCO usage + changed file count for next prompt injection
# Rule: Never blocks (no exit 2), finishes in < 5s

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# Count changed files
CHANGED_COUNT=$(git diff --name-only 2>/dev/null | wc -l || echo "0")
STAGED_COUNT=$(git diff --cached --name-only 2>/dev/null | wc -l || echo "0")
TOTAL=$((CHANGED_COUNT + STAGED_COUNT))

# Update NCO session state
NCO_SESSION_DIR="/tmp/nco-sessions"
NCO_SESSION_ID="${PPID:-$$}"
NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"
mkdir -p "$NCO_SESSION_DIR" 2>/dev/null

# Preserve NCO usage flag from existing session
NCO_USED="false"
if [ -f "$NCO_SESSION_FILE" ]; then
    NCO_USED=$(grep -o '"nco_used": *[a-z]*' "$NCO_SESSION_FILE" 2>/dev/null | grep -o 'true\|false' || echo "false")
fi

# Write updated state
cat > "$NCO_SESSION_FILE" <<EOF
{
  "session_id": "$NCO_SESSION_ID",
  "changed_files": $TOTAL,
  "nco_used": $NCO_USED,
  "last_check": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

exit 0
