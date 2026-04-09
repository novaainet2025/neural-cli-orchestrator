#!/bin/bash
# NCO AI Status Line for Claude Code
# Shows: API/WS status, each AI state (idle/working/error/offline), online count

GREEN='\033[32m'
CYAN='\033[36m'
RED='\033[31m'
YELLOW='\033[33m'
GRAY='\033[90m'
BLUE='\033[34m'
MAGENTA='\033[35m'
RESET='\033[0m'

INPUT=$(cat)

# Parse metrics
eval $(echo "$INPUT" | jq -r '
  "MODEL=\"\(.model.display_name // "?")\"",
  "INPUT_TOKENS=\(.context_window.total_input_tokens // 0)",
  "OUTPUT_TOKENS=\(.context_window.total_output_tokens // 0)",
  "CONTEXT_SIZE=\(.context_window.context_window_size // 200000)",
  "COST_RAW=\(.cost.total_cost_usd // 0)"
' 2>/dev/null)

COST=$(printf "%.2f" "$COST_RAW" 2>/dev/null || echo "0.00")
TOTAL_TOKENS=$(( ${INPUT_TOKENS:-0} + ${OUTPUT_TOKENS:-0} ))
CONTEXT_SIZE=${CONTEXT_SIZE:-200000}
[ "$CONTEXT_SIZE" -gt 0 ] 2>/dev/null && PCT=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE)) || PCT=0

# AI short names + order (9 providers, no gemini-api)
declare -A SHORT=(
  ["claude-code"]="Cla"
  ["opencode"]="Opn"
  ["gemini"]="Gem"
  ["codex"]="Cdx"
  ["aider"]="Aid"
  ["cursor-agent"]="Cur"
  ["copilot"]="Cop"
  ["openrouter"]="ORT"
  ["vllm"]="vLM"
)
ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "vllm")

# Quick port check
API="✗"; WS="✗"
if (echo > /dev/tcp/localhost/6200) 2>/dev/null; then
  API="✓"
  (echo > /dev/tcp/localhost/6201) 2>/dev/null && WS="✓"
else
  # Offline — all gray
  ALL_GRAY=""
  for ai in "${ORDER[@]}"; do ALL_GRAY="${ALL_GRAY}${GRAY}${SHORT[$ai]}${RESET} "; done
  echo -e "${CYAN}[${MODEL}]${RESET} API:${RED}${API}${RESET} WS:${RED}${WS}${RESET} [${ALL_GRAY}] 0/9 | Ctx:${PCT}% | \$${COST}"
  exit 0
fi

# Fetch daemons (has status + health per agent)
DAEMONS=$(curl -s -m 1 http://localhost:6200/api/daemons 2>/dev/null)

# Build status display
# Status colors:
#   ● green  = working (actively processing)
#   ● cyan   = idle (online, ready)
#   ● yellow = rate_limited / waiting
#   ● red    = error / isolated
#   ● gray   = offline
#   ● blue   = discussing
#   ● magenta= reviewing

AI_DISPLAY=""
ONLINE=0

for ai in "${ORDER[@]}"; do
  S="${SHORT[$ai]}"

  # Extract status from daemons response
  STATUS=$(echo "$DAEMONS" | jq -r ".daemons[]? | select(.id==\"${ai}\") | .status" 2>/dev/null)
  CIRCUIT=$(echo "$DAEMONS" | jq -r ".daemons[]? | select(.id==\"${ai}\") | .health.circuitState" 2>/dev/null)

  case "$STATUS" in
    working)
      AI_DISPLAY="${AI_DISPLAY}${GREEN}${S}${RESET} "
      ((ONLINE++))
      ;;
    idle)
      AI_DISPLAY="${AI_DISPLAY}${CYAN}${S}${RESET} "
      ((ONLINE++))
      ;;
    thinking)
      AI_DISPLAY="${AI_DISPLAY}${GREEN}${S}${RESET} "
      ((ONLINE++))
      ;;
    discussing)
      AI_DISPLAY="${AI_DISPLAY}${BLUE}${S}${RESET} "
      ((ONLINE++))
      ;;
    reviewing)
      AI_DISPLAY="${AI_DISPLAY}${MAGENTA}${S}${RESET} "
      ((ONLINE++))
      ;;
    waiting)
      AI_DISPLAY="${AI_DISPLAY}${YELLOW}${S}${RESET} "
      ((ONLINE++))
      ;;
    error|isolated)
      AI_DISPLAY="${AI_DISPLAY}${RED}${S}${RESET} "
      ;;
    *)
      # offline or unknown
      if [ "$CIRCUIT" = "open" ]; then
        AI_DISPLAY="${AI_DISPLAY}${RED}${S}${RESET} "
      else
        AI_DISPLAY="${AI_DISPLAY}${GRAY}${S}${RESET} "
      fi
      ;;
  esac
done

# Color API/WS indicators
[ "$API" = "✓" ] && API_C="${GREEN}${API}${RESET}" || API_C="${RED}${API}${RESET}"
[ "$WS" = "✓" ] && WS_C="${GREEN}${WS}${RESET}" || WS_C="${RED}${WS}${RESET}"

echo -e "${CYAN}[${MODEL}]${RESET} API:${API_C} WS:${WS_C} [${AI_DISPLAY}] ${ONLINE}/9 | Ctx:${PCT}% | \$${COST}"
