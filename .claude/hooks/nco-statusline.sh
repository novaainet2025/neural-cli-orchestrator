#!/bin/bash
# NCO AI Status Line for Claude Code — Multi-line
# Claude Code statusline 스펙: https://code.claude.com/docs/en/statusline
#  - rate_limits.five_hour / seven_day: used_percentage, resets_at (Unix epoch 초)
#  - model.id / model.display_name
#
# 백엔드 접두어: NCO_STATUSLINE_BACKEND=MLX | Ollama | (비우면 모델 슬러그만)
# 예: export NCO_STATUSLINE_BACKEND=MLX  → [MLX:gemma-4-26b-a4b-it-q4_K_M]

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

_PARSED=$(echo "$INPUT" | python3 -c "
import os, sys, json, math

def slug_mid(mid: str) -> str:
    if not mid:
        return '?'
    return mid.replace('/', '-').replace(':', '-')

try:
    d = json.load(sys.stdin)
    m = d.get('model') or {}
    cw = d.get('context_window') or {}
    cost = d.get('cost') or {}
    rl = d.get('rate_limits')  # Pro/Max 등 — 첫 API 응답 이후 채워질 수 있음 (문서)
    fh = (rl or {}).get('five_hour') or {}
    sd = (rl or {}).get('seven_day') or {}
    ws = d.get('workspace') or {}

    mid = str(m.get('id') or '').strip()
    mname = str(m.get('display_name') or '').strip()
    slug = slug_mid(mid) if mid else slug_mid(mname)

    backend = (os.environ.get('NCO_STATUSLINE_BACKEND') or os.environ.get('STATUSLINE_INFERENCE_BACKEND') or '').strip()
    if backend:
        bracket = backend + ':' + slug
    else:
        bracket = slug

    ctx_pct = cw.get('used_percentage')
    if ctx_pct is None:
        ctx_pct = 0
    cost_usd = cost.get('total_cost_usd')
    if cost_usd is None:
        cost_usd = 0.0

    # 공식 스키마: resets_at (epoch 초). 레거시 reset_at(문자열) 병행 지원
    def pct_floor(x):
        if x is None:
            return -1
        try:
            return int(math.floor(float(x)))
        except (TypeError, ValueError):
            return -1

    day_pct = pct_floor(fh.get('used_percentage'))
    week_pct = pct_floor(sd.get('used_percentage'))

    def reset_token(block):
        if not block:
            return ''
        t = block.get('resets_at')
        if t is not None:
            try:
                return str(int(t))
            except (TypeError, ValueError):
                pass
        legacy = block.get('reset_at')
        return str(legacy or '')

    day_reset = reset_token(fh)
    week_reset = reset_token(sd)

    no_cloud_quota = (
        rl is None
        or (
            day_pct < 0 and week_pct < 0
            and not str(day_reset).strip() and not str(week_reset).strip()
        )
    )

    perm = d.get('permission_mode', 'default')
    project_dir = ws.get('project_dir', '.')

    ctx_pct = int(math.floor(float(ctx_pct)))

    print('BRACKET=' + bracket)
    print(f'CTX_PCT={ctx_pct}')
    print(f'COST={cost_usd:.2f}')
    print(f'RATE_DAY={day_pct}')
    print(f'RATE_WEEK={week_pct}')
    print(f'DAY_RESET={day_reset}')
    print(f'WEEK_RESET={week_reset}')
    print(f'PERM_MODE={perm}')
    print(f'PROJECT_DIR={project_dir}')
    print(f'NO_CLOUD_QUOTA={1 if no_cloud_quota else 0}')
except Exception:
    print('BRACKET=?')
    print('CTX_PCT=0')
    print('COST=0.00')
    print('RATE_DAY=-1')
    print('RATE_WEEK=-1')
    print('DAY_RESET=')
    print('WEEK_RESET=')
    print('PERM_MODE=default')
    print('PROJECT_DIR=.')
    print('NO_CLOUD_QUOTA=1')
" 2>/dev/null)

while IFS='=' read -r key val; do
  case "$key" in
    BRACKET)        BRACKET="$val" ;;
    CTX_PCT)        CTX_PCT="$val" ;;
    COST)           COST="$val" ;;
    RATE_DAY)       RATE_DAY="$val" ;;
    RATE_WEEK)      RATE_WEEK="$val" ;;
    DAY_RESET)      DAY_RESET="$val" ;;
    WEEK_RESET)     WEEK_RESET="$val" ;;
    PERM_MODE)      PERM_MODE="$val" ;;
    PROJECT_DIR)    PROJECT_DIR="$val" ;;
    NO_CLOUD_QUOTA) NO_CLOUD_QUOTA="$val" ;;
  esac
done <<< "$_PARSED"

BRACKET="${BRACKET:-?}"
CTX_PCT="${CTX_PCT:-0}"
COST="${COST:-0.00}"
NO_CLOUD_QUOTA="${NO_CLOUD_QUOTA:-0}"
PROJECT_NAME=$(basename "${PROJECT_DIR:-.}")

make_bar() {
  local pct=${1:-0}
  [ "$pct" -lt 0 ] 2>/dev/null && pct=0
  local filled=$(( pct * 8 / 100 ))
  local bar=""
  for ((i=0; i<8; i++)); do
    [ $i -lt $filled ] && bar="${bar}█" || bar="${bar}░"
  done
  echo "$bar"
}

if [ -z "$NCO_NAME" ]; then
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      mkdir -p /tmp/nco-names
      for _pf in /tmp/nco-names/claude-*.pid; do
        [ -f "$_pf" ] || continue
        _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
        if [ "$_rp" = "$_CK" ]; then NCO_NAME=$(basename "$_pf" .pid); break 2; fi
      done
      if [ -z "$NCO_NAME" ] && [ -d "/tmp/nco-names" ]; then
        for _pf in /tmp/nco-names/claude-*.pid; do
          [ -f "$_pf" ] || continue
          _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
          [ -n "$_rp" ] && ! [ -d "/proc/$_rp" ] && rm -f "$_pf"
        done
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

declare -A SHORT=(
  ["claude-code"]="Cla" ["opencode"]="Opn" ["gemini"]="Gem"
  ["codex"]="Cdx" ["aider"]="Aid" ["cursor-agent"]="Cur"
  ["copilot"]="Cop" ["openrouter"]="ORT" ["ollama"]="OlM" ["mlx"]="MLX"
)
# 로컬 추론 슬롯: MLX Mac 과 Ollama/WSL 은 보통 동시에 쓰지 않음 → 9칸 유지 (예: 9/9)
if [ "${NCO_STATUSLINE_BACKEND:-}" = "MLX" ]; then
  ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "mlx")
else
  ORDER=("claude-code" "opencode" "gemini" "codex" "aider" "cursor-agent" "copilot" "openrouter" "ollama")
fi
N_AGENTS=${#ORDER[@]}

API="✗"; WS="✗"
(echo > /dev/tcp/localhost/6200) 2>/dev/null && API="✓"
[ "$API" = "✓" ] && (echo > /dev/tcp/localhost/6201) 2>/dev/null && WS="✓"

DAEMONS=""
[ "$API" = "✓" ] && DAEMONS=$(curl -s -m 1 http://localhost:6200/api/daemons 2>/dev/null)

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

[ "$API" = "✓" ] && API_C="api${GREEN}✓${RESET}" || API_C="api${RED}✗${RESET}"
[ "$WS" = "✓" ] && WS_C="ws${GREEN}✓${RESET}" || WS_C="ws${RED}✗${RESET}"

DAY_D="${RATE_DAY:-0}"; [ "$DAY_D" -lt 0 ] 2>/dev/null && DAY_D=0
WEEK_D="${RATE_WEEK:-0}"; [ "$WEEK_D" -lt 0 ] 2>/dev/null && WEEK_D=0
DAY_BAR=$(make_bar "$DAY_D")
WEEK_BAR=$(make_bar "$WEEK_D")

# resets_at: Unix epoch 초(문서) 또는 레거시 ISO 문자열 — GNU date(-d) / BSD date(-r)
fmt_reset() {
  local ts="$1"
  [ -z "$ts" ] && echo "--/-- --:--" && return
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    date -d "@${ts}" "+%m/%d %H:%M" 2>/dev/null && return
    date -r "$ts" "+%m/%d %H:%M" 2>/dev/null && return
  fi
  date -d "$ts" "+%m/%d %H:%M" 2>/dev/null || echo "${ts:0:16}"
}
DAY_RESET_FMT=$(fmt_reset "$DAY_RESET")
WEEK_RESET_FMT=$(fmt_reset "$WEEK_RESET")

case "$PERM_MODE" in
  bypass*|bypassPermissions|bypass_permissions)
    PERM_LINE="⏵⏵ bypass permissions on (shift+tab to cycle)" ;;
  auto*|autoEdit|auto_edit)
    PERM_LINE="⏵ auto-edit on (shift+tab to cycle)" ;;
  *)
    PERM_LINE="⏸ default mode (shift+tab to cycle)" ;;
esac

if [ "$MY_NAME" = "cli" ] && [ "$API" = "✓" ]; then
  MESH=$(curl -s -m 1 http://localhost:6200/api/mesh/sessions 2>/dev/null)
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      _SN=$(echo "$MESH" | jq -r ".sessions[]? | select(.sessionId==\"${_CK}\") | .agentId // empty" 2>/dev/null)
      [ -n "$_SN" ] && MY_NAME="$_SN"
      break
    fi
  done
fi

echo -e "${YELLOW}${BOLD}${MY_NAME}${RESET} ${CYAN}[${BRACKET}]${RESET} 📁 ${PROJECT_NAME}"
echo -e " ${API_C} ${WS_C} [${AI_DISPLAY}]${ONLINE}/${N_AGENTS}"

if [ "$NO_CLOUD_QUOTA" = "1" ]; then
  echo -e " ${CYAN}Ctx ${CTX_PCT}%${RESET} · ${YELLOW}로컬/프록시${RESET}: Anthropic ${GRAY}rate_limits·cost${RESET} 미수신 — ${GRAY}docs: code.claude.com/docs/en/statusline${RESET}"
else
  echo -e " 1일 ${CYAN}${DAY_BAR}${RESET} ${DAY_D}% · 주별 ${BLUE}${WEEK_BAR}${RESET} ${WEEK_D}% | Ctx:${CTX_PCT}% | \$${COST}"
  echo -e " ${GRAY}↻ 1일 ${DAY_RESET_FMT} · 주별 ${WEEK_RESET_FMT}${RESET}"
fi
echo -e " ${GRAY}${PERM_LINE}${RESET}"
