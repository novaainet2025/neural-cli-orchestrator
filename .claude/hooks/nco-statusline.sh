#!/bin/bash
# NCO AI Status Line for Claude Code — macOS Apple Silicon
# 5줄 출력:
#  1. [이름] [백엔드:모델] 📁 폴더
#  2. api✓ ws✓ [AI상태]N/9
#  3. MLX · Apple Silicon · localhost:8000 · proxy:4100   (MLX 모드일 때)
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

# ── 백엔드 / 모델 표시 ────────────────────────────────────────────────────────
BACKEND="${NCO_STATUSLINE_BACKEND:-}"
if [ -n "$NCO_MLX_MODE" ] && [ -z "$BACKEND" ]; then BACKEND="MLX"; fi

MODEL="${NCO_MLX_MODEL:-${MODEL_RAW:-?}}"
if [ -n "$BACKEND" ]; then
  BRACKET="${BACKEND}:${MODEL}"
  BRACKET_COLOR="$MAGENTA"
else
  BRACKET="$MODEL"
  BRACKET_COLOR="$CYAN"
fi

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
          [ -n "$_rp" ] && ! ps -p "$_rp" >/dev/null 2>&1 && rm -f "$_pf"
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
import json, sys
try:
  d=json.load(open('$_TRACK_FILE'))
  print(int(d.get('nco_calls',0) or 0), int(d.get('direct_edits',0) or 0))
except: print('0 0')
" 2>/dev/null)
  read -r NCO_CALLS DIRECT_EDITS <<< "$_nco_u"
fi
_TOTAL_ACTS=$(( NCO_CALLS + DIRECT_EDITS ))
[ "$_TOTAL_ACTS" -gt 0 ] && NCO_PCT=$(( NCO_CALLS * 100 / _TOTAL_ACTS )) || NCO_PCT=0

# ── Anthropic OAuth 사용량 (캐시 기반, 3분 TTL, 자동 갱신) ──────────────────
USAGE_CACHE="${HOME}/.claude/usage-statusline-cache.json"
USAGE_CACHE_MAX_AGE=180

# 캐시 만료 시 백그라운드로 갱신
_refresh_usage_cache() {
  local now age
  if [ -f "$USAGE_CACHE" ]; then
    now=$(date +%s)
    age=$((now - $(stat -f %m "$USAGE_CACHE" 2>/dev/null || stat -c %Y "$USAGE_CACHE" 2>/dev/null || echo 0)))
    [ "$age" -lt "$USAGE_CACHE_MAX_AGE" ] && return 0
  fi
  # source 가능하면 inc.sh 사용, 아니면 직접 fetch
  local INC_SH="${HOME}/.claude/hooks/anthropic-usage-bars.inc.sh"
  if [ -f "$INC_SH" ]; then
    ( source "$INC_SH"; _anthropic_usage_fetch ) &>/dev/null &
  else
    # inline fetch
    local creds token resp
    if [ -f "${HOME}/.claude/.credentials.json" ]; then
      creds=$(<"${HOME}/.claude/.credentials.json")
    fi
    if [ -z "$creds" ] && command -v security >/dev/null 2>&1; then
      creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
    fi
    token=$(printf '%s' "$creds" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    [ -n "$token" ] || return 1
    resp=$(curl -sS --max-time 4 \
      "https://api.anthropic.com/api/oauth/usage" \
      -H "Authorization: Bearer ${token}" \
      -H "anthropic-beta: oauth-2025-04-20" \
      -H "Content-Type: application/json" 2>/dev/null) || return 1
    echo "$resp" | jq -e '.five_hour.utilization' >/dev/null 2>&1 && printf '%s\n' "$resp" >"$USAGE_CACHE"
  fi
}
_refresh_usage_cache

DAY_PCT=0; WEEK_PCT=0; DAY_RESET=""; WEEK_RESET=""
if [ -f "$USAGE_CACHE" ]; then
  _u=$(python3 -c "
import json, sys
try:
  d=json.load(open('$USAGE_CACHE'))
  fh=d.get('five_hour') or {}; sd=d.get('seven_day') or {}
  print(int(round(fh.get('utilization',0) or 0)),
        int(round(sd.get('utilization',0) or 0)),
        fh.get('resets_at','') or '',
        sd.get('resets_at','') or '')
except: print('0 0  ')
" 2>/dev/null)
  read -r DAY_PCT WEEK_PCT DAY_RESET WEEK_RESET <<< "$_u"
fi

# ── BSD-safe date formatter (macOS: date -j -f; Linux: date -d) ──────────────
fmt_reset() {
  local ts="$1"
  [ -z "$ts" ] && echo "--/-- --:--" && return
  # ISO 8601 문자열
  if [[ "$ts" == *T* ]]; then
    # BSD(macOS): date -j -f "%Y-%m-%dT%H:%M:%S"
    date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%+*}" "+%m/%d %H:%M" 2>/dev/null \
      || date -d "$ts" "+%m/%d %H:%M" 2>/dev/null \
      || echo "${ts:0:16}"
    return
  fi
  # Unix epoch
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    date -r "$ts" "+%m/%d %H:%M" 2>/dev/null \
      || date -d "@${ts}" "+%m/%d %H:%M" 2>/dev/null
    return
  fi
  echo "${ts:0:16}"
}

# ── 막대 그래프 ──────────────────────────────────────────────────────────────
make_bar() {
  local pct=${1:-0} w=8
  pct=${pct%.*}; [ "$pct" -lt 0 ] 2>/dev/null && pct=0
  [ "$pct" -gt 100 ] 2>/dev/null && pct=100
  local filled=$(( (pct * w + 99) / 100 ))  # 올림: 1%라도 최소 1칸
  [ "$filled" -gt "$w" ] && filled=$w
  local empty=$(( w - filled ))
  local bar=""
  for ((i=0;i<filled;i++)); do bar+="█"; done
  for ((i=0;i<empty;i++));  do bar+="░"; done
  echo "$bar"
}

# 퍼센트에 따른 색상 (0-49: 초록, 50-79: 노랑, 80+: 빨강)
color_for_pct() {
  local pct=${1:-0}
  pct=${pct%.*}
  [ "$pct" -lt 50 ] 2>/dev/null && echo "$GREEN" && return
  [ "$pct" -lt 80 ] 2>/dev/null && echo "$YELLOW" && return
  echo "$RED"
}

# ── NCO API/WS + AI 에이전트 상태 ───────────────────────────────────────────
API="✗"; WS="✗"
(echo > /dev/tcp/localhost/6200) 2>/dev/null && API="✓"
[ "$API" = "✓" ] && (echo > /dev/tcp/localhost/6201) 2>/dev/null && WS="✓"

declare -A SHORT=(
  ["claude-code"]="Cla" ["opencode"]="Opn" ["gemini"]="Gem"
  ["codex"]="Cdx"       ["aider"]="Aid"    ["cursor-agent"]="Cur"
  ["copilot"]="Cop"     ["openrouter"]="ORT" ["mlx"]="MLX" ["ollama"]="OlM"
)
ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "mlx")

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

[ "$API" = "✓" ] && API_C="api${GREEN}✓${RESET}" || API_C="api${RED}✗${RESET}"
[ "$WS"  = "✓" ] && WS_C="ws${GREEN}✓${RESET}"  || WS_C="ws${RED}✗${RESET}"

# ── 출력 (5줄) ───────────────────────────────────────────────────────────────
PROJ_PART=""
[ -n "$PROJECT_FOLDER" ] && PROJ_PART=" ${GRAY}📁 ${PROJECT_FOLDER}${RESET}"

# 줄 1: 이름 · 모델 · 폴더
echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${BRACKET_COLOR}[${BRACKET}]${RESET}${PROJ_PART}"

# 줄 2: API · WS · AI 에이전트
echo -e " ${API_C} ${WS_C} [${AI_DISPLAY}]${ONLINE}/${#ORDER[@]}"

# 줄 3: NCO 사용량 막대
NCO_BAR=$(make_bar "$NCO_PCT")
echo -e " ${CYAN}NCO${RESET} ${GREEN}${NCO_BAR}${RESET} ${NCO_PCT}% ${GRAY}(NCO:${NCO_CALLS}↑ 직접:${DIRECT_EDITS}↓)${RESET}"

# 줄 4: Anthropic 사용량 막대 | Ctx | $비용
DAY_BAR=$(make_bar "$DAY_PCT")
WEEK_BAR=$(make_bar "$WEEK_PCT")
DAY_COLOR=$(color_for_pct "$DAY_PCT")
WEEK_COLOR=$(color_for_pct "$WEEK_PCT")
echo -e " ${GRAY}1일${RESET} ${DAY_COLOR}${DAY_BAR}${RESET} ${DAY_PCT}% ${GRAY}·${RESET} ${GRAY}주별${RESET} ${WEEK_COLOR}${WEEK_BAR}${RESET} ${WEEK_PCT}% | Ctx:${PCT}% | \$${COST}"

# 줄 5: 리셋 시각
DAY_RESET_FMT=$(fmt_reset "$DAY_RESET")
WEEK_RESET_FMT=$(fmt_reset "$WEEK_RESET")
echo -e " ${GRAY}↻ 1일 ${DAY_RESET_FMT} · 주별 ${WEEK_RESET_FMT}${RESET}"
