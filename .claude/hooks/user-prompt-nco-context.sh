#!/bin/bash
# UserPromptSubmit Hook: NCO context + CLI Mesh heartbeat (OPTIMIZED)
# Purpose: Report work, detect conflicts, receive messages from other CLIs
# Token opt: cache 30s, single combined call, compact output

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

# Simple TTL cache for health/state (30s)
NCO_CACHE_TTL=30
NCO_CACHE_DIR="/tmp/nco-hook-cache"
mkdir -p "$NCO_CACHE_DIR" 2>/dev/null

_cached_health() {
    local key="$1"
    local cache_file="$NCO_CACHE_DIR/$key.cache"
    local cache_age=0
    if [ -f "$cache_file" ]; then
        cache_age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0)))
    fi
    if [ "$cache_age" -lt "$NCO_CACHE_TTL" ] && [ -f "$cache_file" ]; then
        cat "$cache_file"
        return 0
    fi
    return 1
}

_write_cache() {
    local key="$1"
    local val="$2"
    echo "$val" > "$NCO_CACHE_DIR/$key.cache"
}

# Try cache first for health
NCO_HEALTH=""
if _cached_health "health"; then
    NCO_HEALTH="cached"
else
    NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)
    if [ -n "$NCO_HEALTH" ]; then
        _write_cache "health" "$NCO_HEALTH"
    fi
fi

if [ -n "$NCO_HEALTH" ] && [ "$NCO_HEALTH" != "cached" ]; then
    PROVIDER_COUNT=9
    NCO_SESSION_DIR="/tmp/nco-sessions"
    NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

    BRANCH=$(cd "$PROJECT_DIR" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
    CHANGED_LIST=$(cd "$PROJECT_DIR" 2>/dev/null && git diff --name-only 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,$//')
    FILES_JSON=$(echo "$CHANGED_LIST" | python3 -c "import sys; f=sys.stdin.read().strip(); print('['+','.join(['\"'+x+'\"' for x in f.split(',') if x])+']')" 2>/dev/null || echo "[]")
    PROMPT_PREVIEW=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userMessage','')[:50])" 2>/dev/null || echo "")

    MESH_HB=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"coding\",\"currentWork\":\"$(echo "$PROMPT_PREVIEW" | sed 's/"/\\"/g' | sed "s/'/\\\\'/g")\",\"currentFiles\":$FILES_JSON,\"branch\":\"$BRANCH\"}" 2>/dev/null)

    MESH_CONFLICTS=$(echo "$MESH_HB" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('conflicts',[]); print('; '.join(c)) if c else print('')" 2>/dev/null || echo "")

    MESH_MSG_TEXT=$(echo "$MESH_HB" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
if not msgs:
    print('')
else:
    lines=[]
    for m in msgs:
        t=m.get('type','info').upper()[:4]
        f=m.get('fromAgent','?')[:8]
        c=m.get('content','')[:30]
        lines.append(f'{t}:{f}:{c}')
    print('|'.join(lines))
" 2>/dev/null || echo "")

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

    # Compact orch hint (only if files changed >= 5)
    ORCH_HINT=""
    if [ "$TOTAL_CHANGED" -ge 5 ]; then
        PROMPT_TEXT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userMessage','').lower()[:100])" 2>/dev/null || echo "")
        if echo "$PROMPT_TEXT" | grep -qE '(구현|만들어|추가|implement|create|add|build|리팩토링|refactor|최적화|optimize)'; then
            ORCH_HINT="!nco_commander"
        elif echo "$PROMPT_TEXT" | grep -qE '(리뷰|검토|review|check|audit|보안|security)'; then
            ORCH_HINT="!cursor+vllm"
        fi
    fi

    # Compact NCO hint
    if [ "$TOTAL_CHANGED" -ge 5 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="MUST:${TOTAL_CHANGED}"
    elif [ "$TOTAL_CHANGED" -ge 3 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="SHOULD:${TOTAL_CHANGED}"
    elif [ "$NCO_USED" = "true" ]; then
        NCO_HINT="ACTIVE"
    else
        NCO_HINT="READY"
    fi

    # Compact context (key=value, key=value)
    CONTEXT="N=${MY_NAME}|A=${PROVIDER_COUNT}|F=${TOTAL_CHANGED}|H=${NCO_HINT}"
    [ -n "$ORCH_HINT" ] && CONTEXT="${CONTEXT}|O=${ORCH_HINT}"
    [ -n "$MESH_CONFLICTS" ] && CONTEXT="${CONTEXT}|C=${MESH_CONFLICTS}"
    [ -n "$MESH_MSG_TEXT" ] && CONTEXT="${CONTEXT}|M=${MESH_MSG_TEXT}"

    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[${CONTEXT}]"
  }
}
ENDJSON
else
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[N=${MY_NAME} OFFLINE]"
  }
}
ENDJSON
fi

exit 0
