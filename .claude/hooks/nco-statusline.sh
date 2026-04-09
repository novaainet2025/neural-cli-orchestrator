#!/bin/bash
# NCO AI Status Line for Claude Code (Optimized for speed)
# Target: < 1s execution time

GREEN='\033[32m'
CYAN='\033[36m'
RED='\033[31m'
YELLOW='\033[33m'
GRAY='\033[90m'
RESET='\033[0m'

INPUT=$(cat)

# Parse all metrics in a single jq call
eval $(echo "$INPUT" | jq -r '
  "MODEL=\"\(.model.display_name // "?")\"",
  "PROJECT_DIR=\"\(.workspace.project_dir // ".")\"",
  "INPUT_TOKENS=\(.context_window.total_input_tokens // 0)",
  "OUTPUT_TOKENS=\(.context_window.total_output_tokens // 0)",
  "CONTEXT_SIZE=\(.context_window.context_window_size // 200000)",
  "COST_RAW=\(.cost.total_cost_usd // 0)"
' 2>/dev/null)

PROJECT_NAME=${PROJECT_DIR##*/}
COST=$(printf "%.2f" "$COST_RAW" 2>/dev/null || echo "0.00")
INPUT_TOKENS=${INPUT_TOKENS:-0}
OUTPUT_TOKENS=${OUTPUT_TOKENS:-0}
CONTEXT_SIZE=${CONTEXT_SIZE:-200000}
TOTAL_TOKENS=$((INPUT_TOKENS + OUTPUT_TOKENS))
[ "$CONTEXT_SIZE" -gt 0 ] 2>/dev/null && PERCENT_USED=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE)) || PERCENT_USED=0

# Quick port check
if ! (echo > /dev/tcp/localhost/6200) 2>/dev/null; then
    echo -e "${CYAN}[${MODEL}]${RESET} API:${GRAY}✗${RESET} WS:${GRAY}✗${RESET} [${GRAY}Cla Gem GmA Cdx vLM Cop Cur Aid Opn${RESET}] | Ctx:${PERCENT_USED}% | ${PROJECT_NAME} | \$${COST}"
    exit 0
fi

# Parallel curl fetches using temp files
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

curl -s -m 1 http://localhost:6200/health >"$TMP/health" 2>/dev/null &
curl -s -m 1 http://localhost:6201 >"$TMP/ws" 2>/dev/null &
curl -s -m 1 http://localhost:6200/api/ai-providers >"$TMP/providers" 2>/dev/null &
curl -s -m 1 http://localhost:6200/api/daemons >"$TMP/daemons" 2>/dev/null &
curl -s -m 1 http://localhost:6200/api/tasks >"$TMP/tasks" 2>/dev/null &
wait

API_STATUS="✗"
grep -q '"status".*"healthy"' "$TMP/health" 2>/dev/null && API_STATUS="✓"

WS_STATUS="✗"
[ -s "$TMP/ws" ] && WS_STATUS="✓"

PROVIDERS=$(cat "$TMP/providers" 2>/dev/null)
NCO_DAEMONS=$(cat "$TMP/daemons" 2>/dev/null)
NCO_TASKS=$(cat "$TMP/tasks" 2>/dev/null)

# Redis check
REDIS_CONNECTED="false"
timeout 1 redis-cli ping 2>/dev/null | grep -q "PONG" && REDIS_CONNECTED="true"

# vLLM check (replaces Ollama VRAM check)
VLLM_ONLINE="false"
curl -s -m 1 http://localhost:8000/health 2>/dev/null | grep -q "ok" && VLLM_ONLINE="true"

if [ -z "$PROVIDERS" ] || echo "$PROVIDERS" | grep -q '"error"'; then
    echo -e "${CYAN}[${MODEL}]${RESET} API:${GRAY}${API_STATUS}${RESET} WS:${GRAY}${WS_STATUS}${RESET} [${GRAY}Cla Gem GmA Cdx vLM Cop Cur Aid Opn${RESET}] | Ctx:${PERCENT_USED}% | ${PROJECT_NAME} | \$${COST}"
    exit 0
fi

# Build AI status - single jq call to extract all provider data at once
PROVIDER_DATA=$(echo "$PROVIDERS" | jq -r '.providers[]? | "\(.id):\(.status):\(.enabled)"' 2>/dev/null)
DAEMON_DATA=$(echo "$NCO_DAEMONS" | jq -r '.daemons[]? | "\(.id):\(.tasks.active // 0)"' 2>/dev/null)

declare -A AI_NAMES=(["claude-code"]="Cla" ["gemini"]="Gem" ["gemini-api"]="GmA" ["codex"]="Cdx" ["vllm"]="vLM" ["copilot"]="Cop" ["cursor-agent"]="Cur" ["aider"]="Aid" ["opencode"]="Opn")
AI_ORDER=("claude-code" "gemini" "gemini-api" "codex" "vllm" "copilot" "cursor-agent" "aider" "opencode")

AI_STATUS=""
ONLINE_COUNT=0

for ai in "${AI_ORDER[@]}"; do
    SHORT="${AI_NAMES[$ai]}"
    P_LINE=$(echo "$PROVIDER_DATA" | grep "^${ai}:")
    P_STATUS=$(echo "$P_LINE" | cut -d: -f2)
    P_ENABLED=$(echo "$P_LINE" | cut -d: -f3)

    VERIFIED_WORKING="false"

    # Check daemons
    D_ACTIVE=$(echo "$DAEMON_DATA" | grep "^${ai}:" | cut -d: -f2)
    [ "$D_ACTIVE" -gt 0 ] 2>/dev/null && VERIFIED_WORKING="true"

    # Check BullMQ
    if [ "$VERIFIED_WORKING" = "false" ] && [ "$REDIS_CONNECTED" = "true" ]; then
        ACTIVE_JOBS=$(timeout 1 redis-cli LLEN "bull:nco-${ai}:active" 2>/dev/null || echo "0")
        [ "$ACTIVE_JOBS" -gt 0 ] 2>/dev/null && VERIFIED_WORKING="true"
    fi

    # vLLM health check (replaces Ollama VRAM check)
    if [ "$ai" = "vllm" ] && [ "$VLLM_ONLINE" = "true" ]; then
        VERIFIED_WORKING="true"
    fi

    if [ "$P_STATUS" = "online" ] && [ "$P_ENABLED" = "true" ]; then
        ((ONLINE_COUNT++))
        if [ "$VERIFIED_WORKING" = "true" ]; then
            AI_STATUS="${AI_STATUS}${GREEN}${SHORT}${RESET} "
        else
            AI_STATUS="${AI_STATUS}${CYAN}${SHORT}${RESET} "
        fi
    elif [ "$P_STATUS" = "rate_limited" ]; then
        AI_STATUS="${AI_STATUS}${YELLOW}${SHORT}${RESET} "
    else
        AI_STATUS="${AI_STATUS}${GRAY}${SHORT}${RESET} "
    fi
done

echo -e "${CYAN}[${MODEL}]${RESET} API:${GREEN}${API_STATUS}${RESET} WS:${GREEN}${WS_STATUS}${RESET} [${AI_STATUS}] ${ONLINE_COUNT}/9 | Ctx:${PERCENT_USED}% | ${PROJECT_NAME} | \$${COST}"
