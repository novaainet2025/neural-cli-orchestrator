#!/usr/bin/env bash
#
# AI CLI Tools Installer & Updater (no sudo required)
# All tools installed to ~/.local (user-local)
#
# Installs: gemini-cli, codex, cursor-agent, aider, copilot, vllm,
#           claude-code, opencode, gemini-api (google-genai)
#
# Usage:
#   ./install-all.sh          # Install all tools
#   ./install-all.sh update   # Update all tools
#   ./install-all.sh status   # Show installed status
#   ./install-all.sh <tool>   # Install/update specific tool
#
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[-]${NC} $*"; }
info() { echo -e "${CYAN}[>]${NC} $*"; }

LOCAL="$HOME/.local"
mkdir -p "$LOCAL/bin" "$LOCAL/lib" "$LOCAL/share"

# NVM-managed node lives here
export NVM_DIR="$HOME/.nvm"
# Ensure local paths take priority
export PATH="$LOCAL/bin:$PATH"

# ─── Prerequisites (all user-local, no sudo) ────────────────────────────────

install_prereqs() {
    info "Checking prerequisites..."

    # ── Node.js via nvm (user-local) ──
    if ! command -v node &>/dev/null; then
        info "Installing nvm + Node.js LTS..."
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        # Load nvm into current shell
        [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
        nvm install --lts
        nvm use --lts
        log "Node.js $(node --version) installed via nvm"
    else
        # Make sure nvm is loaded if it exists
        [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true
        log "Node.js $(node --version) already installed"
    fi

    # ── uv (fast Python installer, user-local) - install FIRST ──
    if ! command -v uv &>/dev/null; then
        info "Installing uv (Python package manager)..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        export PATH="$HOME/.cargo/bin:$PATH"
        log "uv installed"
    else
        log "uv already installed"
    fi

    # ── pip (bootstrap via uv or get-pip with --break-system-packages) ──
    if ! python3 -m pip --version &>/dev/null; then
        info "Bootstrapping pip..."
        curl -fsSL https://bootstrap.pypa.io/get-pip.py | python3 - --user --break-system-packages
        log "pip installed"
    else
        log "pip already installed"
    fi

    # ── pipx (via uv or pip) ──
    if ! command -v pipx &>/dev/null; then
        info "Installing pipx..."
        uv tool install pipx 2>/dev/null || \
        python3 -m pip install --user --break-system-packages pipx
        python3 -m pipx ensurepath 2>/dev/null || true
        export PATH="$LOCAL/bin:$PATH"
        log "pipx installed"
    else
        log "pipx already installed"
    fi

    # ── gh CLI (binary download, no apt) ──
    if ! command -v gh &>/dev/null; then
        info "Installing GitHub CLI..."
        local gh_ver="2.74.0"
        local arch
        arch=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
        local gh_tar="gh_${gh_ver}_linux_${arch}.tar.gz"
        curl -fsSL "https://github.com/cli/cli/releases/download/v${gh_ver}/${gh_tar}" -o "/tmp/${gh_tar}"
        tar -xzf "/tmp/${gh_tar}" -C /tmp
        cp "/tmp/gh_${gh_ver}_linux_${arch}/bin/gh" "$LOCAL/bin/gh"
        chmod +x "$LOCAL/bin/gh"
        rm -rf "/tmp/${gh_tar}" "/tmp/gh_${gh_ver}_linux_${arch}"
        log "GitHub CLI installed"
    else
        log "GitHub CLI already installed"
    fi

    log "All prerequisites ready"
}

# ─── Infrastructure ──────────────────────────────────────────────────────────

install_redis() {
    info "Installing Redis..."
    if command -v redis-server &>/dev/null; then
        log "Redis already installed: $(redis-server --version | head -1)"
        return 0
    fi

    # Try apt (needs sudo)
    if sudo -n apt-get update -qq 2>/dev/null && sudo -n apt-get install -y redis-server 2>/dev/null; then
        log "Redis installed via apt"
        return 0
    fi

    # Fallback: build from source (user-local, no sudo)
    info "Building Redis from source (user-local)..."
    local redis_ver="7.4.4"
    curl -fsSL "https://github.com/redis/redis/archive/refs/tags/${redis_ver}.tar.gz" -o /tmp/redis.tar.gz
    cd /tmp && tar xzf redis.tar.gz && cd "redis-${redis_ver}"
    make -j"$(nproc)" PREFIX="$LOCAL" install
    cd - >/dev/null
    rm -rf /tmp/redis.tar.gz "/tmp/redis-${redis_ver}"
    log "Redis installed to $LOCAL/bin"
}

# ─── Tool Installers (all user-local) ────────────────────────────────────────

install_gemini_cli() {
    info "Installing Gemini CLI..."
    npm install -g @google/gemini-cli@latest
    log "Gemini CLI installed"
}

install_codex() {
    info "Installing Codex CLI (OpenAI)..."
    npm install -g @openai/codex@latest
    log "Codex CLI installed"
}

install_cursor_agent() {
    info "Installing Cursor Agent..."
    # Cursor Agent uses Windows PowerShell installer (WSL2 environment)
    powershell.exe -NoProfile -Command "irm 'https://cursor.com/install?win32=true' | iex" 2>/dev/null || \
    warn "Cursor Agent install failed - requires PowerShell (WSL2/Windows)"
    log "Cursor Agent installed"
}

install_aider() {
    info "Installing Aider..."
    uv tool install --force aider-chat 2>/dev/null || \
    pipx install aider-chat --force 2>/dev/null || \
    python3 -m pip install --user --break-system-packages aider-chat
    log "Aider installed"
}

install_copilot() {
    info "Installing GitHub Copilot CLI..."
    npm install -g @githubnext/github-copilot-cli@latest 2>/dev/null || \
    err "Copilot CLI npm install failed"
    # Also try gh extension as secondary method
    if command -v gh &>/dev/null; then
        gh extension install github/gh-copilot --force 2>/dev/null || true
    fi
    log "GitHub Copilot CLI installed"
}

install_vllm() {
    info "Installing vLLM (replaces ollama)..."
    uv tool install --force vllm 2>/dev/null || \
    pipx install vllm --force 2>/dev/null || \
    python3 -m pip install --user --break-system-packages vllm 2>/dev/null || {
        warn "vLLM GPU install failed, trying CPU-only..."
        python3 -m pip install --user --break-system-packages vllm \
            --extra-index-url https://download.pytorch.org/whl/cpu 2>/dev/null || \
        err "vLLM install failed - may need CUDA drivers or more RAM"
    }
    log "vLLM install attempted"
}

install_claude_code() {
    info "Installing Claude Code..."

    # Check if already installed via standalone binary (official installer)
    if [ -x "$LOCAL/bin/claude" ] && [ -d "$LOCAL/share/claude" ]; then
        local cur_ver
        cur_ver=$(claude --version 2>/dev/null || echo "unknown")
        log "Claude Code already installed via standalone binary (${cur_ver})"
        info "Updating via official method..."
        claude update 2>/dev/null || \
        curl -fsSL https://claude.ai/install.sh | sh 2>/dev/null || \
        warn "Auto-update failed, current version: ${cur_ver}"
        return 0
    fi

    # Check if installed via npm globally
    if npm list -g @anthropic-ai/claude-code &>/dev/null 2>&1; then
        info "Updating Claude Code via npm..."
        npm install -g @anthropic-ai/claude-code@latest
    else
        # Fresh install - prefer standalone binary to avoid conflicts
        info "Installing via official standalone installer..."
        curl -fsSL https://claude.ai/install.sh | sh 2>/dev/null || {
            info "Standalone failed, falling back to npm..."
            npm install -g @anthropic-ai/claude-code@latest
        }
    fi
    log "Claude Code installed"
}

install_opencode() {
    info "Installing OpenCode..."
    npm install -g opencode-ai@latest 2>/dev/null || \
    curl -fsSL https://opencode.ai/install | bash 2>/dev/null || \
    warn "OpenCode install failed"
    log "OpenCode install attempted"
}

install_gemini_api() {
    info "Installing Google GenAI SDK (Gemini API)..."
    uv tool install --force google-genai 2>/dev/null || \
    pipx install google-genai --force 2>/dev/null || \
    python3 -m pip install --user --break-system-packages -U google-genai
    log "Google GenAI SDK installed"
}

# ─── Update ──────────────────────────────────────────────────────────────────

update_all() {
    info "Updating all AI CLI tools..."

    # Load nvm
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true

    # npm global updates
    info "Updating npm packages..."
    npm update -g @google/gemini-cli @openai/codex @anthropic-ai/claude-code opencode-ai @githubnext/github-copilot-cli 2>/dev/null || true

    # uv/pipx updates
    info "Updating Python tools..."
    if command -v uv &>/dev/null; then
        uv tool upgrade aider-chat 2>/dev/null || true
        uv tool upgrade google-genai 2>/dev/null || true
        uv tool upgrade vllm 2>/dev/null || true
    else
        pipx upgrade aider-chat 2>/dev/null || true
        pipx upgrade google-genai 2>/dev/null || true
        pipx upgrade vllm 2>/dev/null || true
    fi

    # cursor
    install_cursor_agent 2>/dev/null || true

    # Node.js itself
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        info "Checking Node.js updates..."
        source "$NVM_DIR/nvm.sh"
        nvm install --lts --reinstall-packages-from=current 2>/dev/null || true
    fi

    log "All tools updated!"
}

# ─── Status ──────────────────────────────────────────────────────────────────

show_status() {
    # Load nvm for status check
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true

    echo ""
    echo -e "${CYAN}═══════════════════════════════════════${NC}"
    echo -e "${CYAN}       AI CLI Tools Status             ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════${NC}"
    echo ""

    check_tool() {
        local name="$1" cmd="$2"
        if command -v "$cmd" &>/dev/null 2>&1; then
            local ver
            ver=$("$cmd" --version 2>/dev/null | head -1 || echo "installed")
            printf "  ${GREEN}●${NC} %-18s %s\n" "$name" "$ver"
        else
            printf "  ${RED}○${NC} %-18s %s\n" "$name" "(not found)"
        fi
    }

    check_tool "Node.js"        node
    check_tool "Gemini CLI"     gemini
    check_tool "Codex CLI"      codex
    check_tool "Cursor Agent"   cursor-agent
    # cursor-agent fallback check if not in PATH
    if ! command -v cursor-agent &>/dev/null 2>&1; then
        local ca_path="$HOME/.local/share/cursor-agent/versions"
        if [ -d "$ca_path" ]; then
            local ca_ver=$(ls "$ca_path" 2>/dev/null | tail -1)
            if [ -n "$ca_ver" ] && [ -x "$ca_path/$ca_ver/cursor-agent" ]; then
                printf "  ${GREEN}●${NC} %-18s %s\n" "  (found at)" "$ca_path/$ca_ver/"
            fi
        fi
    fi
    check_tool "Aider"          aider

    check_tool "Copilot CLI"    github-copilot-cli

    check_tool "vLLM"           vllm
    check_tool "Claude Code"    claude
    check_tool "OpenCode"       opencode

    if python3 -c "import google.genai" 2>/dev/null; then
        printf "  ${GREEN}●${NC} %-18s %s\n" "GenAI SDK" "installed"
    else
        printf "  ${RED}○${NC} %-18s %s\n" "GenAI SDK" "(not found)"
    fi

    check_tool "Redis"          redis-server
    check_tool "PM2"            pm2
    check_tool "GitHub CLI"     gh
    check_tool "uv"             uv
    check_tool "pipx"           pipx

    echo ""
}

# ─── Shell Config (add paths to .bashrc) ─────────────────────────────────────

ensure_shell_paths() {
    local rc="$HOME/.bashrc"
    local marker="# AI-CLI-TOOLS-PATH"

    if ! grep -q "$marker" "$rc" 2>/dev/null; then
        info "Adding paths to ~/.bashrc..."
        cat >> "$rc" << 'PATHS'

# AI-CLI-TOOLS-PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
PATHS
        log "Shell paths added to ~/.bashrc"
    fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   AI CLI Tools Installer / Updater       ║${NC}"
    echo -e "${CYAN}║   (no sudo required)                     ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    local action="${1:-install}"

    case "$action" in
        update)
            [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true
            update_all
            show_status
            ;;
        status)
            show_status
            ;;
        redis)          install_redis ;;
        gemini-cli)     install_prereqs; install_gemini_cli ;;
        codex)          install_prereqs; install_codex ;;
        cursor-agent)   install_prereqs; install_cursor_agent ;;
        aider)          install_prereqs; install_aider ;;
        copilot)        install_prereqs; install_copilot ;;
        vllm)           install_prereqs; install_vllm ;;
        claude-code)    install_prereqs; install_claude_code ;;
        opencode)       install_prereqs; install_opencode ;;
        gemini-api)     install_prereqs; install_gemini_api ;;
        install)
            install_prereqs
            ensure_shell_paths

            echo ""
            info "Installing all AI CLI tools..."
            echo ""

            install_redis        || err "Redis failed"
            install_gemini_cli   || err "Gemini CLI failed"
            install_codex        || err "Codex CLI failed"
            install_cursor_agent || err "Cursor Agent failed"
            install_aider        || err "Aider failed"
            install_copilot      || err "Copilot CLI failed"
            install_vllm         || err "vLLM failed"
            install_claude_code  || err "Claude Code failed"
            install_opencode     || err "OpenCode failed"
            install_gemini_api   || err "GenAI SDK failed"

            show_status

            echo -e "${GREEN}Done! Run 'source ~/.bashrc' or open a new terminal.${NC}"
            ;;
        *)
            echo "Usage: $0 {install|update|status|<tool-name>}"
            echo ""
            echo "Tools: redis, gemini-cli, codex, cursor-agent, aider, copilot,"
            echo "       vllm, claude-code, opencode, gemini-api"
            exit 1
            ;;
    esac
}

main "$@"
