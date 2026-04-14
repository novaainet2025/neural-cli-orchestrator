#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║          NCO (Neural CLI Orchestrator) — Universal Installer            ║
# ║                                                                          ║
# ║  지원 환경: macOS · Linux · WSL2                                          ║
# ║  Windows:  setup.ps1 사용 (WSL2 자동 설치 후 이 스크립트 실행)             ║
# ║                                                                          ║
# ║  사용법:                                                                  ║
# ║    bash setup.sh                          # 대화형 설치                  ║
# ║    bash setup.sh --no-interactive         # 자동 설치                    ║
# ║    bash setup.sh --skip-vllm             # vLLM 안내 스킵                ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
IFS=$'\n\t'

# ── 색상 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
info() { echo -e "${CYAN}  ▶${NC} $*"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*" >&2; }
hdr()  { echo -e "\n${BOLD}${CYAN}━━ $* ━━${NC}"; }
step() { echo -e "\n${BOLD}[${1}/${TOTAL}] ${2}${NC}"; }
TOTAL=12

# ── 인수 ──────────────────────────────────────────────────────────────────
INTERACTIVE=true; SKIP_VLLM=false; DEV_MODE=false
for arg in "${@:-}"; do
  case "$arg" in
    --no-interactive) INTERACTIVE=false ;;
    --skip-vllm)      SKIP_VLLM=true ;;
    --dev)            DEV_MODE=true ;;
  esac
done

# ── 경로 ──────────────────────────────────────────────────────────────────
NCO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
LOCAL_BIN="$HOME/.local/bin"
NCO_BIN="$NCO_DIR/.claude/bin"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
mkdir -p "$CLAUDE_DIR/commands" "$CLAUDE_DIR/hooks" "$LOCAL_BIN"

# ══════════════════════════════════════════════════════════════════════════
# 배너
# ══════════════════════════════════════════════════════════════════════════
print_banner() {
  echo -e "${BOLD}${CYAN}"
  echo "   ███╗   ██╗ ██████╗ ██████╗ "
  echo "   ████╗  ██║██╔════╝██╔═══██╗"
  echo "   ██╔██╗ ██║██║     ██║   ██║"
  echo "   ██║╚██╗██║██║     ██║   ██║"
  echo "   ██║ ╚████║╚██████╗╚██████╔╝"
  echo "   ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝"
  echo -e "${NC}"
  echo -e "  ${BOLD}Neural CLI Orchestrator — Universal Installer${NC}"
  echo -e "  v1.0 · $(date '+%Y-%m-%d') · ${CYAN}https://github.com/novaainet2025/projects${NC}"
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════
# 1. OS 감지
# ══════════════════════════════════════════════════════════════════════════
detect_os() {
  step 1 "환경 감지"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="mac"; SHELL_RC="$HOME/.zshrc"
    [[ -f "$HOME/.bashrc" ]] && SHELL_RC="$HOME/.bashrc"
    PKG_MGR="brew"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    OS="wsl"; SHELL_RC="$HOME/.bashrc"; PKG_MGR="apt"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"; SHELL_RC="$HOME/.bashrc"
    command -v dnf &>/dev/null && PKG_MGR="dnf" || PKG_MGR="apt"
  else
    err "지원하지 않는 OS: $OSTYPE"
    err "Windows는 setup.ps1을 사용하세요."
    exit 1
  fi
  ok "OS: ${BOLD}$OS${NC} | Shell RC: $SHELL_RC"
}

# ══════════════════════════════════════════════════════════════════════════
# 2. Node.js 22+ (nvm)
# ══════════════════════════════════════════════════════════════════════════
install_node() {
  step 2 "Node.js 22+ 설치 (nvm)"

  if [[ ! -d "$NVM_DIR" ]]; then
    info "nvm 설치 중..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

  CURRENT_NODE=$(node --version 2>/dev/null || echo "none")
  MAJOR="${CURRENT_NODE#v}"; MAJOR="${MAJOR%%.*}"

  if [[ "$CURRENT_NODE" == "none" ]] || [[ "${MAJOR:-0}" -lt 22 ]]; then
    info "Node.js 22 설치 중..."
    nvm install 22 && nvm use 22 && nvm alias default 22
  fi
  ok "Node.js $(node --version) | npm $(npm --version)"
}

# ══════════════════════════════════════════════════════════════════════════
# 3. Redis
# ══════════════════════════════════════════════════════════════════════════
install_redis() {
  step 3 "Redis 설치"

  if ! command -v redis-server &>/dev/null; then
    info "Redis 설치 중..."
    case "$PKG_MGR" in
      brew) brew install redis ;;
      apt)  sudo apt-get update -qq && sudo apt-get install -y redis-server ;;
      dnf)  sudo dnf install -y redis ;;
    esac
  fi

  # 시작
  if ! redis-cli ping &>/dev/null 2>&1; then
    case "$OS" in
      mac)   brew services start redis 2>/dev/null || redis-server --daemonize yes --loglevel warning ;;
      linux) sudo systemctl enable --now redis-server 2>/dev/null || redis-server --daemonize yes ;;
      wsl)   redis-server --daemonize yes --loglevel warning ;;
    esac
    sleep 1
  fi

  redis-cli ping &>/dev/null && ok "Redis 실행 중 (:6379)" || warn "Redis 오프라인 — NCO는 degraded mode로 작동"
}

# ══════════════════════════════════════════════════════════════════════════
# 4. Claude Code CLI
# ══════════════════════════════════════════════════════════════════════════
install_claude_code() {
  step 4 "Claude Code CLI 설치"

  if command -v claude &>/dev/null; then
    ok "Claude Code 이미 설치됨"
    return
  fi
  info "Claude Code 설치 중..."
  npm install -g @anthropic-ai/claude-code
  ok "Claude Code 설치 완료"
}

# ══════════════════════════════════════════════════════════════════════════
# 5. NCO 백엔드 빌드
# ══════════════════════════════════════════════════════════════════════════
build_nco() {
  step 5 "NCO 백엔드 빌드"
  cd "$NCO_DIR"
  info "npm install..."
  npm install --silent
  info "TypeScript 빌드..."
  npm run build
  ok "NCO 빌드 완료 → dist/"
}

# ══════════════════════════════════════════════════════════════════════════
# 6. .env 설정
# ══════════════════════════════════════════════════════════════════════════
setup_env() {
  step 6 ".env 설정"
  cd "$NCO_DIR"

  if [[ -f ".env" ]]; then
    ok ".env 이미 존재 — 덮어쓰지 않음"
    return
  fi

  cp .env.example .env

  if [[ "$INTERACTIVE" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}API 키 입력 (Enter 스킵 — 나중에 .env에서 직접 편집 가능)${NC}"
    echo ""
    read -rp "    ANTHROPIC_API_KEY [sk-ant-...]: " ANT
    [[ -n "$ANT" ]] && sed -i.bak "s|ANTHROPIC_API_KEY=sk-ant-xxx|ANTHROPIC_API_KEY=$ANT|" .env
    read -rp "    OPENAI_API_KEY [sk-...]: " OAI
    [[ -n "$OAI" ]] && sed -i.bak "s|OPENAI_API_KEY=sk-xxx|OPENAI_API_KEY=$OAI|" .env
    read -rp "    GEMINI_API_KEYS [AIzaSy..., 콤마 구분]: " GEM
    [[ -n "$GEM" ]] && sed -i.bak "s|GEMINI_API_KEYS=AIzaSyXXX.*|GEMINI_API_KEYS=$GEM|" .env
    read -rp "    OPENROUTER_API_KEYS [sk-or-v1-..., 콤마 구분]: " OR
    [[ -n "$OR" ]] && sed -i.bak "s|OPENROUTER_API_KEYS=sk-or-v1-XXX.*|OPENROUTER_API_KEYS=$OR|" .env
    rm -f .env.bak
  fi

  ok ".env 생성 완료"
  warn "나중에 $NCO_DIR/.env 에서 API 키를 추가/수정하세요"
}

# ══════════════════════════════════════════════════════════════════════════
# 7. 슬래시 커맨드 설치
# ══════════════════════════════════════════════════════════════════════════
setup_commands() {
  step 7 "슬래시 커맨드 설치"

  CMD_SRC="$NCO_DIR/commands"   # 프로젝트 내 commands 디렉토리 (배포 시 포함)
  CMD_DST="$CLAUDE_DIR/commands"

  # 이미 설치된 경우 (현재 머신이 소스)
  EXISTING=$(ls "$CMD_DST"/nco-*.md 2>/dev/null | wc -l || echo 0)
  if [[ "$EXISTING" -gt 50 ]]; then
    ok "${EXISTING}개 커맨드 이미 설치됨"
    return
  fi

  # 프로젝트 commands/ 디렉토리에서 복사
  if ls "$CMD_SRC"/nco-*.md &>/dev/null 2>/dev/null; then
    COUNT=$(ls "$CMD_SRC"/nco-*.md | wc -l)
    cp "$CMD_SRC"/nco-*.md "$CMD_DST/"
    ok "${COUNT}개 커맨드 설치 완료"
    return
  fi

  # 폴백: 핵심 커맨드만 생성
  warn "commands/ 디렉토리 없음 — 핵심 커맨드만 생성"
  _create_core_commands "$CMD_DST"
}

_create_core_commands() {
  local D="$1"
  cat > "$D/nco-start.md" << 'CMD'
# NCO 백엔드를 시작합니다.
if curl -sf http://localhost:6200/health > /dev/null 2>&1; then
  echo "NCO already running on :6200"
  curl -s http://localhost:6200/health | python3 -m json.tool
  exit 0
fi
cd "$HOME/projects/neural-cli-orchestrator" 2>/dev/null || { echo "NCO 디렉토리 없음"; exit 1; }
node dist/index.js &
echo "NCO 시작 중... (PID: $!)"
sleep 3
curl -s http://localhost:6200/health | python3 -m json.tool
CMD

  cat > "$D/nco-status.md" << 'CMD'
# NCO 시스템 상태를 확인합니다.
echo "=== NCO 상태 ==="
if curl -sf http://localhost:6200/health > /dev/null 2>&1; then
  echo "✓ NCO 온라인"
  curl -s http://localhost:6200/health | python3 -m json.tool
else
  echo "✗ NCO 오프라인 — /nco-start 로 시작하세요"
fi
CMD

  cat > "$D/nco-stop.md" << 'CMD'
# NCO 백엔드를 중지합니다.
PID=$(pgrep -f "neural-cli-orchestrator\|nco.*index" | head -1)
[ -n "$PID" ] && kill "$PID" && echo "NCO 종료 (PID: $PID)" || echo "NCO 실행 중이지 않음"
CMD

  ok "핵심 커맨드 3개 생성"
}

# ══════════════════════════════════════════════════════════════════════════
# 8. 훅 설치
# ══════════════════════════════════════════════════════════════════════════
setup_hooks() {
  step 8 "훅 설치"

  HOOKS_SRC="$NCO_DIR/hooks"
  HOOKS_DST="$CLAUDE_DIR/hooks"

  EXISTING=$(ls "$HOOKS_DST"/*.sh 2>/dev/null | wc -l || echo 0)
  if [[ "$EXISTING" -gt 5 ]]; then
    ok "${EXISTING}개 훅 이미 설치됨"
    return
  fi

  if ls "$HOOKS_SRC"/*.sh &>/dev/null 2>/dev/null; then
    cp "$HOOKS_SRC"/*.sh "$HOOKS_DST/"
    chmod +x "$HOOKS_DST"/*.sh
    ok "훅 설치 완료"
  else
    warn "훅 파일 없음 — ~/.claude/hooks/ 에 수동으로 복사하세요"
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# 9. settings.json (훅 등록)
# ══════════════════════════════════════════════════════════════════════════
setup_settings() {
  step 9 "Claude Code 훅 설정"
  local SETTINGS="$CLAUDE_DIR/settings.json"

  if [[ -f "$SETTINGS" ]] && grep -q "mesh-register" "$SETTINGS" 2>/dev/null; then
    ok "settings.json 이미 구성됨"
    return
  fi

  [[ -f "$SETTINGS" ]] && cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"

  python3 - "$CLAUDE_DIR" << 'PYEOF'
import json, sys, os
claude_dir = sys.argv[1]
hooks_dir = claude_dir + "/hooks"
cfg = {
  "hooks": {
    "SessionStart": {"hooks": [
      {"type":"command","command":f"bash {hooks_dir}/mesh-register.sh","timeout":8,"statusMessage":"Registering CLI session..."},
      {"type":"command","command":f"bash {hooks_dir}/mesh-autoresponder.sh","timeout":6,"statusMessage":"Starting mesh auto-responder..."}
    ]},
    "UserPromptSubmit": {"hooks": [
      {"type":"command","command":f"bash {hooks_dir}/nco-task-classifier.sh","timeout":5},
      {"type":"command","command":f"bash {hooks_dir}/mesh-precheck.sh","timeout":5},
      {"type":"command","command":f"bash {hooks_dir}/nco-rules-inject.sh","timeout":3}
    ]},
    "PreToolUse": {"hooks": [
      {"type":"command","command":f"bash {hooks_dir}/nco-agent-enforce.sh","timeout":5}
    ]},
    "Stop": {"hooks": [
      {"type":"command","command":f"bash {hooks_dir}/nco-stop-global.sh","timeout":10}
    ]},
    "PostToolUse": {"hooks": [
      {"type":"command","command":f"bash {hooks_dir}/nco-track-agent-use.sh","timeout":5}
    ]}
  }
}
out = claude_dir + "/settings.json"
with open(out, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print(f"  settings.json 작성: {out}")
PYEOF
  ok "settings.json 생성 완료"
}

# ══════════════════════════════════════════════════════════════════════════
# 10. MCP 등록 (claude_desktop_config.json)
# ══════════════════════════════════════════════════════════════════════════
setup_mcp() {
  step 10 "MCP 서버 등록"
  local CONFIG="$CLAUDE_DIR/claude_desktop_config.json"

  # nco-mcp-server.mjs 경로 탐색
  local MCP_SERVER=""
  for p in "$NCO_BIN/nco-mcp-server.mjs" "$NCO_DIR/.claude/bin/nco-mcp-server.mjs" "$NCO_DIR/cli-installs/nco-mcp-server.mjs"; do
    [[ -f "$p" ]] && MCP_SERVER="$p" && break
  done

  if [[ -z "$MCP_SERVER" ]]; then
    warn "nco-mcp-server.mjs 없음 — MCP 등록 스킵"
    return
  fi

  # 이미 등록된 경우
  if [[ -f "$CONFIG" ]] && python3 -c "import json; d=json.load(open('$CONFIG')); exit(0 if 'nco-commands' in d.get('mcpServers',{}) else 1)" 2>/dev/null; then
    ok "nco-commands MCP 이미 등록됨"
    return
  fi

  python3 - "$CONFIG" "$MCP_SERVER" << 'PYEOF'
import json, sys, os
config_path, mcp_path = sys.argv[1], sys.argv[2]
d = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        d = json.load(f)
d.setdefault("mcpServers", {})["nco-commands"] = {
    "command": "node",
    "args": [mcp_path],
    "disabled": False
}
with open(config_path, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print(f"  nco-commands 등록 완료: {config_path}")
PYEOF
  ok "MCP nco-commands 등록 완료"
}

# ══════════════════════════════════════════════════════════════════════════
# 11. 실행 스크립트 설치
# ══════════════════════════════════════════════════════════════════════════
setup_bin_scripts() {
  step 11 "실행 스크립트 설치"

  if [[ -d "$NCO_BIN" ]]; then
    INSTALLED=0
    for script in claude-vllm claude-vllm-gemma claude-vllm-qwen vllm-gemma vllm-qwen25 claude-vllm-proxyctl; do
      SRC="$NCO_BIN/$script"
      if [[ -f "$SRC" ]]; then
        cp "$SRC" "$LOCAL_BIN/$script"
        chmod +x "$LOCAL_BIN/$script"
        INSTALLED=$((INSTALLED+1))
      fi
    done
    ok "${INSTALLED}개 실행 스크립트 → $LOCAL_BIN"
  else
    warn "bin 스크립트 없음 ($NCO_BIN) — 수동 설치 필요"
  fi

  # nco 직접 실행 래퍼
  cat > "$LOCAL_BIN/nco" << WRAP
#!/usr/bin/env bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
cd "$NCO_DIR" && node dist/index.js "\$@"
WRAP
  chmod +x "$LOCAL_BIN/nco"
  ok "nco 래퍼 생성 완료"
}

# ══════════════════════════════════════════════════════════════════════════
# 12. Shell RC 설정
# ══════════════════════════════════════════════════════════════════════════
setup_shell_rc() {
  step 12 "Shell 설정 업데이트"

  if grep -q "NCO_DIR\|NCO end" "$SHELL_RC" 2>/dev/null; then
    ok "Shell RC 이미 구성됨"
    return
  fi

  cat >> "$SHELL_RC" << RCEOF

# ── NCO (Neural CLI Orchestrator) ──────────────────────────────────────────
export NCO_DIR="$NCO_DIR"
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH"

# vLLM 자동 기동 (주석 해제 시 활성화)
# pgrep -f 'vllm serve' >/dev/null 2>&1 || nohup vllm-gemma start >> /tmp/vllm-gemma.log 2>&1 &

# Claude vLLM alias
alias claude-gemma='claude-vllm-gemma --dangerously-skip-permissions'
alias claude-qwen='claude-vllm-qwen --dangerously-skip-permissions'
# ── NCO end ────────────────────────────────────────────────────────────────
RCEOF
  ok "Shell RC 업데이트 완료 ($SHELL_RC)"
}

# ══════════════════════════════════════════════════════════════════════════
# AI 에이전트 설치 (선택)
# ══════════════════════════════════════════════════════════════════════════
setup_agents() {
  echo ""
  hdr "AI 에이전트 설치 (선택)"
  echo "  codex · gemini-cli · aider · opencode 등 NCO에서 사용하는 에이전트"
  echo ""

  if [[ "$INTERACTIVE" == "true" ]]; then
    read -rp "  AI 에이전트들도 설치할까요? [y/N]: " INSTALL_AGENTS
    if [[ "$INSTALL_AGENTS" =~ ^[Yy]$ ]]; then
      bash "$NCO_DIR/cli-installs/install-all.sh"
    else
      info "나중에 실행: bash $NCO_DIR/cli-installs/install-all.sh"
    fi
  else
    info "에이전트 설치 스킵 (non-interactive)"
    info "나중에 실행: bash $NCO_DIR/cli-installs/install-all.sh"
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# vLLM 안내
# ══════════════════════════════════════════════════════════════════════════
vllm_notice() {
  [[ "$SKIP_VLLM" == "true" ]] && return
  echo ""
  hdr "vLLM 로컬 AI (선택 — GPU 필요)"
  echo "  RTX 3090+ 권장. 없어도 NCO는 정상 작동합니다."
  echo ""
  echo "  설치:"
  echo "    python3 -m venv ~/vllm-env && source ~/vllm-env/bin/activate"
  echo "    pip install 'vllm[modelopt]' torch transformers"
  echo ""
  echo "  사용:"
  echo "    vllm-gemma start    # Gemma 4 26B 기동 (약 3분)"
  echo "    claude-gemma        # Gemma로 Claude Code 실행"
}

# ══════════════════════════════════════════════════════════════════════════
# 검증
# ══════════════════════════════════════════════════════════════════════════
verify() {
  hdr "설치 검증"
  echo ""

  _check() {
    local label="$1" cmd="$2" pass="$3"
    printf "  %-32s" "$label"
    if eval "$cmd" &>/dev/null 2>&1; then
      ok "$pass"
    else
      warn "확인 필요"
    fi
  }

  _check "Node.js 22+"      "node --version | grep -E 'v2[2-9]|v[3-9]'"  "$(node --version 2>/dev/null)"
  _check "npm"              "npm --version"                                "$(npm --version 2>/dev/null)"
  _check "NCO dist/"        "[ -f '$NCO_DIR/dist/index.js' ]"             "빌드 완료"
  _check ".env"             "[ -f '$NCO_DIR/.env' ]"                      "존재"
  _check "Redis"            "redis-cli ping"                               "PONG"
  _check "Claude Code"      "command -v claude"                            "$(claude --version 2>/dev/null | head -1)"
  _check "슬래시 커맨드"    "ls '$CLAUDE_DIR/commands/nco-start.md'"       "$(ls "$CLAUDE_DIR/commands/nco-*.md" 2>/dev/null | wc -l)개"
  _check "settings.json"   "grep -q mesh-register '$CLAUDE_DIR/settings.json'" "훅 등록됨"
  _check "MCP nco-commands" "python3 -c \"import json; d=json.load(open('$CLAUDE_DIR/claude_desktop_config.json')); exit(0 if 'nco-commands' in d.get('mcpServers',{}) else 1)\"" "등록됨"
  _check "nco 래퍼"         "[ -x '$LOCAL_BIN/nco' ]"                     "$LOCAL_BIN/nco"
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════
# 완료 메시지
# ══════════════════════════════════════════════════════════════════════════
print_done() {
  echo ""
  echo -e "${BOLD}${GREEN}══════════════════════════════════════${NC}"
  echo -e "${BOLD}${GREEN}  NCO 설치 완료!${NC}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BOLD}다음 단계:${NC}"
  echo -e "  ${CYAN}1.${NC} source $SHELL_RC"
  echo -e "  ${CYAN}2.${NC} claude  (Claude Code 실행)"
  echo -e "  ${CYAN}3.${NC} /nco-start  (NCO 백엔드 시작)"
  echo -e "  ${CYAN}4.${NC} /nco-status (상태 확인)"
  echo ""
  echo -e "  ${BOLD}vLLM 사용 시:${NC}"
  echo -e "  ${CYAN}5.${NC} vllm-gemma start   (약 3분 대기)"
  echo -e "  ${CYAN}6.${NC} claude-gemma       (로컬 AI 사용)"
  echo ""
  echo -e "  API 키 설정: ${CYAN}$NCO_DIR/.env${NC}"
  echo -e "  에이전트 설치: ${CYAN}bash $NCO_DIR/cli-installs/install-all.sh${NC}"
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════
# 메인
# ══════════════════════════════════════════════════════════════════════════
main() {
  print_banner
  detect_os
  install_node
  install_redis
  install_claude_code
  build_nco
  setup_env
  setup_commands
  setup_hooks
  setup_settings
  setup_mcp
  setup_bin_scripts
  setup_shell_rc
  setup_agents
  vllm_notice
  verify
  print_done
}

main "$@"
