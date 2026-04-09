#!/bin/bash
# UserPromptSubmit Hook: NCO context + CLI Mesh heartbeat
# Purpose: Report work, detect conflicts, receive messages from other CLIs
# Rule: Never exit 2

INPUT=$(cat)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/nova/projects/neural-cli-orchestrator}"
# Resolve NCO_SESSION_ID: env var > process tree walk
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

# Resolve NCO_NAME: env var > PID-file reservation
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

# NCO health check (2s max)
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)

if [ -n "$NCO_HEALTH" ]; then
    PROVIDER_COUNT=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/ai-providers 2>/dev/null | grep -o '"id"' | wc -l 2>/dev/null || echo "?")

    # Session state
    NCO_SESSION_DIR="/tmp/nco-sessions"
    NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

    # ─── Mesh Heartbeat ───────────────────────────
    BRANCH=$(cd "$PROJECT_DIR" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
    CHANGED_LIST=$(cd "$PROJECT_DIR" 2>/dev/null && git diff --name-only 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,$//')
    FILES_JSON=$(echo "$CHANGED_LIST" | python3 -c "import sys; f=sys.stdin.read().strip(); print('['+','.join(['\"'+x+'\"' for x in f.split(',') if x])+']')" 2>/dev/null || echo "[]")
    PROMPT_PREVIEW=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userMessage','')[:80])" 2>/dev/null || echo "")

    MESH_HB=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"coding\",\"currentWork\":\"$(echo "$PROMPT_PREVIEW" | sed 's/"/\\"/g' | sed "s/'/\\\\'/g")\",\"currentFiles\":$FILES_JSON,\"branch\":\"$BRANCH\"}" 2>/dev/null)

    # Extract conflicts
    MESH_CONFLICTS=$(echo "$MESH_HB" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('conflicts',[]); print('; '.join(c)) if c else print('')" 2>/dev/null || echo "")

    # Extract pending messages (full content for Claude to read)
    MESH_MSG_TEXT=$(echo "$MESH_HB" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
if not msgs:
    print('')
else:
    lines=[]
    for m in msgs:
        t=m.get('type','info').upper()
        f=m.get('fromAgent','?')
        c=m.get('content','')
        lines.append(f'[{t}] {f}: {c}')
    print(' | '.join(lines))
" 2>/dev/null || echo "")

    # ─── Session state ────────────────────────────
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

    # NCO usage hint
    if [ "$TOTAL_CHANGED" -ge 5 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="MUST_USE_NCO - ${TOTAL_CHANGED} files changed but NCO not yet used. Use MCP tools automatically. Priority: vllm > gemini > codex."
    elif [ "$TOTAL_CHANGED" -ge 3 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="SHOULD_USE_NCO - ${TOTAL_CHANGED} files changed. Use NCO MCP tools for review."
    elif [ "$NCO_USED" = "true" ]; then
        NCO_HINT="NCO_ACTIVE - NCO already used this session."
    else
        NCO_HINT="AVAILABLE - ${TOTAL_CHANGED} files changed. NCO ready."
    fi

    # ─── Build context string ─────────────────────
    CONTEXT="[NCO:${MY_NAME}] Online (${PROVIDER_COUNT} providers). Changed: ${TOTAL_CHANGED} files. ${NCO_HINT}"

    # Append mesh info
    if [ -n "$MESH_CONFLICTS" ]; then
        CONTEXT="${CONTEXT} CONFLICT: ${MESH_CONFLICTS}."
    fi
    if [ -n "$MESH_MSG_TEXT" ]; then
        CONTEXT="${CONTEXT} MESH_MSG: ${MESH_MSG_TEXT}"
    fi

    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "$( echo "$CONTEXT" | sed 's/"/\\"/g' | tr '\n' ' ' )"
  }
}
ENDJSON
else
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[NCO:${MY_NAME}] Offline. Run /nco-start if needed."
  }
}
ENDJSON
fi

exit 0
