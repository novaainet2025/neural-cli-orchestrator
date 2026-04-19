#!/bin/bash
# NCO AI Status Line for Claude Code — Windows (WSL/Linux)
# 5줄 출력:
#  1. [이름] [모델] 📁 폴더
#  2. api✓ ws✓ [AI상태]N/9 [Mesh피어]
#  3. NCO ████░░░░ X% (NCO:N↑ 직접:M↓)
#  4. 1일 ████ X% · 주별 ████ Y% | Ctx:Z% | $cost
#  5. ↻ 1일 MM/DD HH:MM · 주별 MM/DD HH:MM

GREEN='\033[32m'; CYAN='\033[36m'; RED='\033[31m'
YELLOW='\033[33m'; GRAY='\033[90m'; BLUE='\033[34m'
MAGENTA='\033[35m'; BOLD='\033[1m'; RESET='\033[0m'

INPUT=$(cat)

# ── Claude Code 입력 파싱 ────────────────────────────────────────────────────
eval $(echo "$INPUT" | jq -r '
  "MODEL_RAW=\"\(.model.display_name // .model.id // "?")\"",
  "INPUT_TOKENS=\(.context_window.total_input_tokens // 0)",
  "OUTPUT_TOKENS=\(.context_window.total_output_tokens // 0)",
  "CONTEXT_SIZE=\(.context_window.context_window_size // 200000)",
  "COST_RAW=\(.cost.total_cost_usd // 0)",
  "PERM_MODE=\"\(.permission_mode // "default")\""
' 2>/dev/null) || true

COST=$(printf "%.2f" "${COST_RAW:-0}" 2>/dev/null || echo "0.00")
TOTAL_TOKENS=$(( ${INPUT_TOKENS:-0} + ${OUTPUT_TOKENS:-0} ))
CONTEXT_SIZE=${CONTEXT_SIZE:-200000}
[ "${CONTEXT_SIZE:-0}" -gt 0 ] 2>/dev/null && PCT=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE)) || PCT=0

# 프로젝트 폴더
PROJECT_DIR_RAW=$(echo "$INPUT" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
PROJECT_FOLDER=""
if [ -n "$PROJECT_DIR_RAW" ] && [ "$PROJECT_DIR_RAW" != "null" ]; then
  PROJECT_FOLDER=$(basename "${PROJECT_DIR_RAW//\\//}")
fi

MODEL="${MODEL_RAW:-?}"

# ── NCO 세션 이름 ────────────────────────────────────────────────────────────
_CLAUDE_PID=""
if [ -z "$NCO_NAME" ]; then
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
          NCO_NAME=$(basename "$_pf" .pid); break 2
        fi
      done
      if [ -z "$NCO_NAME" ] && [ -d "/tmp/nco-names" ]; then
        for _pf in /tmp/nco-names/claude-*.pid; do
          [ -f "$_pf" ] || continue
          _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
          [ -n "$_rp" ] && ! [ -d "/proc/$_rp" ] && rm -f "$_pf"
        done
        _N=1
        while [ -f "/tmp/nco-names/claude-${_N}.pid" ]; do _N=$((_N+1)); done
        echo "$_CK" > "/tmp/nco-names/claude-${_N}.pid"
        NCO_NAME="claude-${_N}"
      fi
      break
    fi
  done
fi
MY_NAME="${NCO_NAME:-cli}"

# ── NCO 세션 사용량 (nco-track 파일) ─────────────────────────────────────────
NCO_CALLS=0; DIRECT_EDITS=0
_TRACK_FILE=""
if [ -n "$_CLAUDE_PID" ]; then
  _TRACK_FILE="/tmp/nco-track-${_CLAUDE_PID}.json"
elif [ -n "$NCO_SESSION_ID" ]; then
  _TRACK_FILE="/tmp/nco-track-${NCO_SESSION_ID}.json"
fi
if [ -n "$_TRACK_FILE" ] && [ -f "$_TRACK_FILE" ]; then
  _nco_u=$(python3 -c "
import json
try:
  d=json.load(open('$_TRACK_FILE'))
  print(int(d.get('nco_calls',0) or 0), int(d.get('direct_edits',0) or 0))
except: print('0 0')
" 2>/dev/null)
  read -r NCO_CALLS DIRECT_EDITS <<< "$_nco_u"
fi
_TOTAL_ACTS=$(( NCO_CALLS + DIRECT_EDITS ))
[ "$_TOTAL_ACTS" -gt 0 ] && NCO_PCT=$(( NCO_CALLS * 100 / _TOTAL_ACTS )) || NCO_PCT=0

# ── Anthropic OAuth 사용량 (캐시 기반, 3분 TTL) ──────────────────────────────
USAGE_CACHE="${HOME}/.claude/usage-statusline-cache.json"
DAY_PCT=0; WEEK_PCT=0; DAY_RESET=""; WEEK_RESET=""
if [ -f "$USAGE_CACHE" ]; then
  _u=$(python3 -c "
import json, sys
try:
  d=json.load(open('$USAGE_CACHE'))
  fh=d.get('five_hour') or {}; sd=d.get('seven_day') or {}
  print(int(fh.get('utilization',0) or 0),
        int(sd.get('utilization',0) or 0),
        fh.get('resets_at','') or '',
        sd.get('resets_at','') or '')
except: print('0 0  ')
" 2>/dev/null)
  read -r DAY_PCT WEEK_PCT DAY_RESET WEEK_RESET <<< "$_u"
fi

# ── GNU date formatter (Linux/WSL) ───────────────────────────────────────────
fmt_reset() {
  local ts="$1"
  [ -z "$ts" ] && echo "--/-- --:--" && return
  if [[ "$ts" == *T* ]]; then
    date -d "$ts" "+%m/%d %H:%M" 2>/dev/null || echo "${ts:0:16}"
    return
  fi
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    date -d "@${ts}" "+%m/%d %H:%M" 2>/dev/null
    return
  fi
  echo "${ts:0:16}"
}

# ── 막대 그래프 ──────────────────────────────────────────────────────────────
make_bar() {
  local pct=${1:-0} w=8
  pct=${pct%.*}; [ "$pct" -gt 100 ] 2>/dev/null && pct=100
  local filled=$(( pct * w / 100 ))
  local empty=$(( w - filled ))
  local bar=""
  for ((i=0;i<filled;i++)); do bar+="█"; done
  for ((i=0;i<empty;i++));  do bar+="░"; done
  echo "$bar"
}

# ── NCO API/WS + AI 에이전트 상태 ───────────────────────────────────────────
API="✗"; WS="✗"
(echo > /dev/tcp/localhost/6200) 2>/dev/null && API="✓"
[ "$API" = "✓" ] && (echo > /dev/tcp/localhost/6201) 2>/dev/null && WS="✓"

declare -A SHORT=(
  ["claude-code"]="Cla" ["opencode"]="Opn" ["gemini"]="Gem"
  ["codex"]="Cdx"       ["aider"]="Aid"    ["cursor-agent"]="Cur"
  ["copilot"]="Cop"     ["openrouter"]="ORT" ["ollama"]="OlM"
)
ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "ollama")

DAEMONS=""; AI_DISPLAY=""; ONLINE=0
[ "$API" = "✓" ] && DAEMONS=$(curl -s -m 1 http://localhost:6200/api/daemons 2>/dev/null)

for ai in "${ORDER[@]}"; do
  S="${SHORT[$ai]}"
  STATUS=$(echo "$DAEMONS" | jq -r ".daemons[]? | select(.id==\"${ai}\") | .status" 2>/dev/null)
  case "$STATUS" in
    working|thinking) AI_DISPLAY+="${GREEN}${S}${RESET} "; ((ONLINE++)) ;;
    idle|offline)     AI_DISPLAY+="${CYAN}${S}${RESET} ";  ((ONLINE++)) ;;
    discussing)       AI_DISPLAY+="${BLUE}${S}${RESET} ";  ((ONLINE++)) ;;
    reviewing)        AI_DISPLAY+="${MAGENTA}${S}${RESET} "; ((ONLINE++)) ;;
    waiting)          AI_DISPLAY+="${YELLOW}${S}${RESET} "; ((ONLINE++)) ;;
    error|isolated)   AI_DISPLAY+="${RED}${S}${RESET} " ;;
    *)                AI_DISPLAY+="${GRAY}${S}${RESET} " ;;
  esac
done

# ── Mesh 피어 표시 ───────────────────────────────────────────────────────────
MESH_DISPLAY=""
if [ "$API" = "✓" ]; then
  MESH=$(curl -s -m 1 http://localhost:6200/api/mesh/sessions 2>/dev/null)
  MESH_COUNT=$(echo "$MESH" | jq '.count // 0' 2>/dev/null || echo "0")
  if [ "$MESH_COUNT" -gt 1 ]; then
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
    [ -n "$PEERS" ] && MESH_DISPLAY=" ${BLUE}Mesh:${PEERS}${RESET}"
  fi
fi

[ "$API" = "✓" ] && API_C="api${GREEN}✓${RESET}" || API_C="api${RED}✗${RESET}"
[ "$WS"  = "✓" ] && WS_C="ws${GREEN}✓${RESET}"  || WS_C="ws${RED}✗${RESET}"

# ── 출력 (5줄) ───────────────────────────────────────────────────────────────
PROJ_PART=""
[ -n "$PROJECT_FOLDER" ] && PROJ_PART=" ${GRAY}📁 ${PROJECT_FOLDER}${RESET}"

# 줄 1: 이름 · 모델 · 폴더
echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${CYAN}[${MODEL}]${RESET}${PROJ_PART}"

# 줄 2: API · WS · AI 에이전트 [Mesh]
echo -e " ${API_C} ${WS_C} [${AI_DISPLAY}]${ONLINE}/${#ORDER[@]}${MESH_DISPLAY}"

# 줄 3: NCO 사용량 막대
NCO_BAR=$(make_bar "$NCO_PCT")
echo -e " ${CYAN}NCO${RESET} ${GREEN}${NCO_BAR}${RESET} ${NCO_PCT}% ${GRAY}(NCO:${NCO_CALLS}↑ 직접:${DIRECT_EDITS}↓)${RESET}"

# 줄 4: Anthropic 사용량 막대 | Ctx | $비용
DAY_BAR=$(make_bar "$DAY_PCT")
WEEK_BAR=$(make_bar "$WEEK_PCT")
echo -e " ${GRAY}1일${RESET} ${GREEN}${DAY_BAR}${RESET} ${DAY_PCT}% ${GRAY}·${RESET} ${GRAY}주별${RESET} ${BLUE}${WEEK_BAR}${RESET} ${WEEK_PCT}% | Ctx:${PCT}% | \$${COST}"

# 줄 5: 리셋 시각
DAY_RESET_FMT=$(fmt_reset "$DAY_RESET")
WEEK_RESET_FMT=$(fmt_reset "$WEEK_RESET")
echo -e " ${GRAY}↻ 1일 ${DAY_RESET_FMT} · 주별 ${WEEK_RESET_FMT}${RESET}"
