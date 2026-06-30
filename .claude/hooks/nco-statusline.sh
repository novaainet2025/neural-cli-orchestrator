#!/bin/bash
# NCO AI Status Line for Claude Code — macOS Apple Silicon
# 6줄 출력:
#  1. [이름] [백엔드:모델] 📁 폴더
#  2. api✓ ws✓ [AI상태]N/9
#  3. NCO ████ X% (NCO:Y↑ 직접:Z↓)
#  4. Hig plan · online · N cr · 오늘 -M
#  5. 1일 ████ X% · 주별 ████ Y% | Ctx:Z% | $cost
#  6. ↻ 1일 MM/DD HH:MM · 주별 MM/DD HH:MM

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

# ── 에이전트 라벨 사전 (등록되지 않은 ID는 자동 슬러그 처리) ──
declare -A SHORT=(
  ["claude-code"]="Cla" ["opencode"]="Opn" ["gemini"]="Gem"
  ["codex"]="Cdx"       ["cursor-agent"]="Cur"
  ["copilot"]="Cop"     ["openrouter"]="ORT" ["nvidia"]="NIM"
  ["mlx"]="MLX" ["ollama"]="OlM" ["higgsfield"]="Hig"
)

DAEMONS=""; AI_DISPLAY=""; ONLINE=0
[ "$API" = "✓" ] && DAEMONS=$(curl -s -m 0.5 http://localhost:6200/api/daemons 2>/dev/null)

# ── ORDER 동적 구성 (NCO 실시간 싱크) ─────────────────────────
# 우선순위:
#   1. 라이브 /api/daemons — enabled=true 만, evicted_providers 제외
#   2. health.json — nco-health-monitor.sh 캐시 (백엔드 다운 시)
#   3. 하드코딩 폴백 (aider 퇴출 반영, 2026-05-14)
_CAPS_FILE="${HOME}/.claude/nco-perf/capabilities.json"
_HEALTH_FILE="${HOME}/.claude/nco-perf/health.json"
ORDER=()
while IFS= read -r _line; do
  [ -n "$_line" ] && ORDER+=("$_line")
done < <(
  CAPS_FILE="$_CAPS_FILE" HEALTH_FILE="$_HEALTH_FILE" DAEMONS_RAW="$DAEMONS" \
  python3 - <<'PYEOF' 2>/dev/null
import json, os
caps_path = os.environ.get("CAPS_FILE","")
health_path = os.environ.get("HEALTH_FILE","")
daemons_raw = os.environ.get("DAEMONS_RAW","")

evicted = set()
try:
    caps = json.load(open(caps_path))
    evicted = set((caps.get("evicted_providers") or {}).keys())
except Exception:
    pass

ids = []
try:
    if daemons_raw.strip():
        d = json.loads(daemons_raw)
        for it in d.get("daemons", []):
            pid = it.get("id")
            if not pid or pid in evicted:
                continue
            if it.get("enabled") is False:
                continue
            ids.append(pid)
except Exception:
    ids = []

if not ids:
    try:
        h = json.load(open(health_path))
        for pid, p in (h.get("providers") or {}).items():
            if pid in evicted: continue
            if p.get("enabled") is False: continue
            ids.append(pid)
    except Exception:
        pass

if not ids:
    fallback = ["claude-code","opencode","gemini","codex","cursor-agent","copilot","openrouter","mlx","ollama","higgsfield"]
    ids = [x for x in fallback if x not in evicted]

print("\n".join(ids))
PYEOF
)
if [ "${#ORDER[@]}" -eq 0 ]; then
  ORDER=("claude-code" "opencode" "gemini" "codex" "cursor-agent" "copilot" "openrouter" "mlx" "ollama" "higgsfield")
fi

# ── 에이전트 상태 표시 ─────────────────────────────────────────
for ai in "${ORDER[@]}"; do
  S="${SHORT[$ai]}"
  # 미등록 ID는 첫3글자(첫글자 대문자)로 슬러그 라벨 생성 (bash 3.2 / BSD 호환)
  if [ -z "$S" ]; then
    _raw=$(echo "$ai" | tr -cd 'a-zA-Z0-9' | cut -c1-3)
    if [ -n "$_raw" ]; then
      _first=$(printf '%s' "$_raw" | cut -c1 | tr 'a-z' 'A-Z')
      _rest=$(printf '%s' "$_raw" | cut -c2-)
      S="${_first}${_rest}"
    else
      S="?"
    fi
  fi
  # NCO CLI 프로바이더는 stateless lazy spawn — 위임 시 subprocess spawn → 종료
  # offline = 휴면 상태(정상). enabled && available 이면 "위임 가능"으로 활성 카운트
  INFO=$(echo "$DAEMONS" | jq -r ".daemons[]? | select(.id==\"${ai}\") | \"\(.status) \(.enabled) \(.available)\"" 2>/dev/null)
  read -r STATUS ENABLED AVAILABLE <<< "$INFO"
  case "$STATUS" in
    working|thinking) AI_DISPLAY+="${GREEN}${S}${RESET} "; ((ONLINE++)) ;;
    idle)             AI_DISPLAY+="${CYAN}${S}${RESET} ";  ((ONLINE++)) ;;
    discussing)       AI_DISPLAY+="${BLUE}${S}${RESET} ";  ((ONLINE++)) ;;
    reviewing)        AI_DISPLAY+="${MAGENTA}${S}${RESET} "; ((ONLINE++)) ;;
    waiting)          AI_DISPLAY+="${YELLOW}${S}${RESET} "; ((ONLINE++)) ;;
    error|isolated)   AI_DISPLAY+="${RED}${S}${RESET} " ;;
    offline)
      if [ "$ENABLED" = "true" ] && [ "$AVAILABLE" = "true" ]; then
        AI_DISPLAY+="${GRAY}${CYAN}${S}${RESET} "; ((ONLINE++))
      else
        AI_DISPLAY+="${GRAY}${S}${RESET} "
      fi
      ;;
    *)                AI_DISPLAY+="${GRAY}${S}${RESET} " ;;
  esac
done

[ "$API" = "✓" ] && API_C="api${GREEN}✓${RESET}" || API_C="api${RED}✗${RESET}"
[ "$WS"  = "✓" ] && WS_C="ws${GREEN}✓${RESET}"  || WS_C="ws${RED}✗${RESET}"

# ── Higgsfield 크레딧 + 당일 사용량 (캐시 기반, 3분 TTL) ────────────────────
HIG_CACHE="${HOME}/.claude/hig-statusline-cache.json"
HIG_CACHE_MAX_AGE=180

_refresh_hig_cache() {
  local now age
  if [ -f "$HIG_CACHE" ]; then
    now=$(date +%s)
    age=$((now - $(stat -f %m "$HIG_CACHE" 2>/dev/null || stat -c %Y "$HIG_CACHE" 2>/dev/null || echo 0)))
    [ "$age" -lt "$HIG_CACHE_MAX_AGE" ] && return 0
  fi
  (
    _status=$(higgsfield account status --json 2>/dev/null) || exit 1
    _txns=$(higgsfield account transactions --size 100 --json 2>/dev/null) || _txns="[]"
    printf '%s\n---SEP---\n%s' "$_status" "$_txns" | python3 -c "
import json, sys
from datetime import datetime
raw = sys.stdin.read()
parts = raw.split('\n---SEP---\n', 1)
st = json.loads(parts[0])
txns = json.loads(parts[1]) if len(parts) > 1 else []
today_local = datetime.now().strftime('%Y-%m-%d')
today_spend = 0
for t in txns:
    if t.get('action') != 'spend': continue
    ca = t.get('created_at','')
    try:
        dt = datetime.fromisoformat(ca.replace('Z','+00:00')).astimezone()
        if dt.strftime('%Y-%m-%d') == today_local:
            today_spend += abs(t.get('credits',0))
    except: pass
out = {'credits': st.get('credits',0), 'plan': st.get('subscription_plan_type','?'), 'today_spend': today_spend}
json.dump(out, open('$HIG_CACHE','w'))
" 2>/dev/null
  ) &
}
_refresh_hig_cache

HIG_CREDITS=0; HIG_PLAN="?"; HIG_TODAY=0
if [ -f "$HIG_CACHE" ]; then
  eval $(python3 -c "
import json
try:
  d=json.load(open('$HIG_CACHE'))
  cr=d.get('credits',0)
  cr=int(cr) if isinstance(cr,float) and cr==int(cr) else cr
  print(f'HIG_CREDITS={cr}')
  print(f'HIG_PLAN=\"{d.get(\"plan\",\"?\")}\"')
  ts=d.get('today_spend',0)
  ts=int(ts) if isinstance(ts,float) and ts==int(ts) else ts
  print(f'HIG_TODAY={ts}')
except: print('HIG_CREDITS=0\nHIG_PLAN=\"?\"\nHIG_TODAY=0')
" 2>/dev/null)
fi

# ── 출력 (6줄) ───────────────────────────────────────────────────────────────
PROJ_PART=""
[ -n "$PROJECT_FOLDER" ] && PROJ_PART=" ${GRAY}📁 ${PROJECT_FOLDER}${RESET}"

# 줄 1: 이름 · 모델 · 폴더
echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${BRACKET_COLOR}[${BRACKET}]${RESET}${PROJ_PART}"

# 줄 2: API · WS · AI 에이전트
echo -e " ${API_C} ${WS_C} [${AI_DISPLAY}]${ONLINE}/${#ORDER[@]}"

# 줄 3: NCO 사용량 막대
NCO_BAR=$(make_bar "$NCO_PCT")
echo -e " ${CYAN}NCO${RESET} ${GREEN}${NCO_BAR}${RESET} ${NCO_PCT}% ${GRAY}(NCO:${NCO_CALLS}↑ 직접:${DIRECT_EDITS}↓)${RESET}"

# 줄 4: Higgsfield 크레딧 + 당일 사용량
# Hig 상태: NCO daemons에서 가져옴
HIG_STATUS_RAW=$(echo "$DAEMONS" | jq -r '.daemons[]? | select(.id=="higgsfield") | .status' 2>/dev/null)
case "$HIG_STATUS_RAW" in
  working|thinking|idle|discussing|reviewing) HIG_ONLINE="${GREEN}online${RESET}" ;;
  offline)
    _hig_en=$(echo "$DAEMONS" | jq -r '.daemons[]? | select(.id=="higgsfield") | .enabled' 2>/dev/null)
    _hig_av=$(echo "$DAEMONS" | jq -r '.daemons[]? | select(.id=="higgsfield") | .available' 2>/dev/null)
    [ "$_hig_en" = "true" ] && [ "$_hig_av" = "true" ] && HIG_ONLINE="${CYAN}ready${RESET}" || HIG_ONLINE="${GRAY}offline${RESET}"
    ;;
  *) HIG_ONLINE="${GRAY}offline${RESET}" ;;
esac
echo -e " ${MAGENTA}Hig${RESET} ${HIG_PLAN} · ${HIG_ONLINE} · ${CYAN}${HIG_CREDITS}${RESET} cr · 오늘 ${YELLOW}-${HIG_TODAY}${RESET}"

# 줄 5: Anthropic 사용량 막대 | Ctx | $비용 (was 줄 4)
DAY_BAR=$(make_bar "$DAY_PCT")
WEEK_BAR=$(make_bar "$WEEK_PCT")
DAY_COLOR=$(color_for_pct "$DAY_PCT")
WEEK_COLOR=$(color_for_pct "$WEEK_PCT")
echo -e " ${GRAY}1일${RESET} ${DAY_COLOR}${DAY_BAR}${RESET} ${DAY_PCT}% ${GRAY}·${RESET} ${GRAY}주별${RESET} ${WEEK_COLOR}${WEEK_BAR}${RESET} ${WEEK_PCT}% | Ctx:${PCT}% | \$${COST}"

# 줄 6: 리셋 시각
DAY_RESET_FMT=$(fmt_reset "$DAY_RESET")
WEEK_RESET_FMT=$(fmt_reset "$WEEK_RESET")
echo -e " ${GRAY}↻ 1일 ${DAY_RESET_FMT} · 주별 ${WEEK_RESET_FMT}${RESET}"
