#!/bin/bash
# NCO AI Status Line for Claude Code
# Shows: [NCO_NAME] API/WS, each AI state, mesh peers, context%, cost

GREEN='\033[32m'
CYAN='\033[36m'
RED='\033[31m'
YELLOW='\033[33m'
GRAY='\033[90m'
BLUE='\033[34m'
MAGENTA='\033[35m'
BOLD='\033[1m'
RESET='\033[0m'

INPUT=$(cat)

# Parse metrics from Claude Code
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

# ─── NCO_NAME (from env > PID-file reservation > auto-register) ───
_CLAUDE_PID=""
if [ -z "$NCO_NAME" ]; then
  # Walk process tree to find Claude PID
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      _CLAUDE_PID="$_CK"
      for _pf in /tmp/nco-names/claude-*.pid; do
        [ -f "$_pf" ] || continue
        _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
        if [ "$_rp" = "$_CK" ]; then
          NCO_NAME=$(basename "$_pf" .pid)
          break 2
        fi
      done
      # Not found — auto-register (session-start may not have run yet)
      if [ -z "$NCO_NAME" ] && [ -d "/tmp/nco-names" ]; then
        # Clean dead PIDs first
        for _pf in /tmp/nco-names/claude-*.pid; do
          [ -f "$_pf" ] || continue
          _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
          [ -n "$_rp" ] && ! ps -p "$_rp" >/dev/null 2>&1 && rm -f "$_pf"
        done
        # Find lowest available
        _N=1
        while [ -f "/tmp/nco-names/claude-${_N}.pid" ]; do _N=$((_N + 1)); done
        echo "$_CK" > "/tmp/nco-names/claude-${_N}.pid"
        NCO_NAME="claude-${_N}"
      fi
      break
    fi
  done
fi
MY_NAME="${NCO_NAME:-cli}"

# ─── AI short names ───
declare -A SHORT=(
  ["claude-code"]="Cla" ["opencode"]="Opn" ["gemini"]="Gem"
  ["codex"]="Cdx" ["aider"]="Aid" ["cursor-agent"]="Cur"
  ["copilot"]="Cop" ["openrouter"]="ORT" ["vllm"]="vLM"
)
ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "vllm")

# ─── Quick port check ───
API="✗"; WS="✗"
if (echo > /dev/tcp/localhost/6200) 2>/dev/null; then
  API="✓"
  (echo > /dev/tcp/localhost/6201) 2>/dev/null && WS="✓"
else
  echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${CYAN}[${MODEL}]${RESET} api${RED}✗${RESET} ws${RED}✗${RESET} | Ctx:${PCT}% | \$${COST}"
  exit 0
fi

# ─── Fetch daemons + mesh in parallel ───
DAEMONS=$(curl -s -m 1 http://localhost:6200/api/daemons 2>/dev/null)
MESH=$(curl -s -m 1 http://localhost:6200/api/mesh/sessions 2>/dev/null)

# ─── Build AI status display ───
AI_DISPLAY=""
ONLINE=0

for ai in "${ORDER[@]}"; do
  S="${SHORT[$ai]}"
  STATUS=$(echo "$DAEMONS" | jq -r ".daemons[]? | select(.id==\"${ai}\") | .status" 2>/dev/null)

  case "$STATUS" in
    working|thinking) AI_DISPLAY="${AI_DISPLAY}${GREEN}${S}${RESET} "; ((ONLINE++)) ;;
    idle|offline)     AI_DISPLAY="${AI_DISPLAY}${CYAN}${S}${RESET} ";  ((ONLINE++)) ;;
    discussing)       AI_DISPLAY="${AI_DISPLAY}${BLUE}${S}${RESET} ";  ((ONLINE++)) ;;
    reviewing)        AI_DISPLAY="${AI_DISPLAY}${MAGENTA}${S}${RESET} "; ((ONLINE++)) ;;
    waiting)          AI_DISPLAY="${AI_DISPLAY}${YELLOW}${S}${RESET} "; ((ONLINE++)) ;;
    error|isolated)   AI_DISPLAY="${AI_DISPLAY}${RED}${S}${RESET} " ;;
    *)                AI_DISPLAY="${AI_DISPLAY}${GRAY}${S}${RESET} " ;;
  esac
done

# ─── Build mesh peer display ───
MESH_DISPLAY=""
MESH_COUNT=$(echo "$MESH" | jq '.count // 0' 2>/dev/null || echo "0")

if [ "$MESH_COUNT" -gt 1 ]; then
    # Show other sessions (not me)
    PEERS=$(echo "$MESH" | python3 -c "
import sys,json
d=json.load(sys.stdin)
peers=[]
for s in d.get('sessions',[]):
    sid=s.get('sessionId','')
    if sid == '${NCO_SESSION_ID}': continue
    name=s.get('agentId','?')[:6]
    st=s.get('status','?')
    icon='●' if st=='coding' else '◌' if st=='idle' else '◆' if st=='reviewing' else '○'
    peers.append(f'{icon}{name}')
print(' '.join(peers))
" 2>/dev/null)
    if [ -n "$PEERS" ]; then
        MESH_DISPLAY=" ${BLUE}Mesh:${PEERS}${RESET}"
    fi
fi

# ─── Color API/WS ───
[ "$API" = "✓" ] && API_C="api${GREEN}✓${RESET}" || API_C="api${RED}✗${RESET}"
[ "$WS" = "✓" ] && WS_C="ws${GREEN}✓${RESET}" || WS_C="ws${RED}✗${RESET}"

# ─── NCO_NAME: fallback to mesh session ───
if [ "$MY_NAME" = "cli" ] && [ "$API" = "✓" ] && [ -n "$MESH" ]; then
  # Try matching by PID in mesh sessions
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      SERVER_NAME=$(echo "$MESH" | jq -r ".sessions[]? | select(.sessionId==\"${_CK}\") | .agentId // empty" 2>/dev/null)
      [ -n "$SERVER_NAME" ] && MY_NAME="$SERVER_NAME"
      break
    fi
  done
fi

# ─── Final output ───
echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${CYAN}[${MODEL}]${RESET} ${API_C} ${WS_C} [${AI_DISPLAY}]${ONLINE}/9${MESH_DISPLAY} | Ctx:${PCT}% | \$${COST}"
