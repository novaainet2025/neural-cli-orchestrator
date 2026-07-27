#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  NCO one-line bootstrap — clone/update then non-interactive setup         ║
# ║                                                                          ║
# ║  macOS / Linux / WSL:                                                     ║
# ║    curl -fsSL https://raw.githubusercontent.com/novaainet2025/neural-cli-orchestrator/main/scripts/bootstrap.sh | bash
# ║                                                                          ║
# ║  Custom install dir:                                                      ║
# ║    curl -fsSL .../bootstrap.sh | bash -s -- "$HOME/src/nco"               ║
# ║    NCO_INSTALL_DIR=/opt/nco bash bootstrap.sh                             ║
# ║                                                                          ║
# ║  Safety: refuses root by default; never uses legacy-peer-deps;            ║
# ║  preserves existing .env and local edits on update.                       ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
IFS=$'\n\t'

REPO_URL="${NCO_REPO_URL:-https://github.com/novaainet2025/neural-cli-orchestrator.git}"
REPO_BRANCH="${NCO_REPO_BRANCH:-main}"
INSTALL_DIR="${1:-${NCO_INSTALL_DIR:-$HOME/projects/neural-cli-orchestrator}}"
HEALTH_URL="${NCO_HEALTH_URL:-http://127.0.0.1:6200/health}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
info() { echo -e "${CYAN}  ▶${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*" >&2; }

die() {
  err "$*"
  exit 1
}

refuse_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]] && [[ "${NCO_ALLOW_ROOT:-0}" != "1" ]]; then
    die "Refusing to run as root. Re-run as a normal user, or set NCO_ALLOW_ROOT=1."
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

clone_or_update() {
  need_cmd git
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing clone at $INSTALL_DIR — fetching $REPO_BRANCH"
    (
      cd "$INSTALL_DIR"
      # Preserve .env and untracked local files; only update tracked tree.
      git fetch --prune origin "$REPO_BRANCH"
      local current
      current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
      if [[ "$current" != "$REPO_BRANCH" ]]; then
        info "Checking out $REPO_BRANCH (was $current)"
        git checkout "$REPO_BRANCH"
      fi
      # Fast-forward only — never rewrite user commits / force-reset.
      if ! git merge --ff-only "origin/$REPO_BRANCH"; then
        die "Cannot fast-forward $INSTALL_DIR to origin/$REPO_BRANCH. Resolve local commits, then re-run."
      fi
    )
    ok "Updated $INSTALL_DIR"
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "Path exists but is not a git clone: $INSTALL_DIR"
  else
    info "Cloning $REPO_URL ($REPO_BRANCH) → $INSTALL_DIR"
    git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
    ok "Cloned $INSTALL_DIR"
  fi

  [[ -f "$INSTALL_DIR/setup.sh" ]] || die "setup.sh missing after clone/update: $INSTALL_DIR"
  [[ -f "$INSTALL_DIR/.env" ]] && ok "Preserved existing .env" || info "No .env yet (setup will create from .env.example)"
}

run_setup() {
  info "Running non-interactive setup (npm ci → build → PM2 → /health)"
  # Force non-interactive; skip optional agent installs for a fast service bring-up.
  # Caller can re-run setup.sh without --skip-agents later.
  bash "$INSTALL_DIR/setup.sh" --no-interactive --skip-ollama --skip-agents
}

print_done() {
  echo ""
  echo -e "${BOLD}${GREEN}NCO bootstrap finished${NC}"
  echo -e "  Install dir: ${CYAN}$INSTALL_DIR${NC}"
  echo -e "  Health:      ${CYAN}$HEALTH_URL${NC}"
  echo -e "  Re-run is idempotent; .env is never overwritten."
  echo ""
}

main() {
  refuse_root
  need_cmd curl
  need_cmd bash
  clone_or_update
  run_setup
  print_done
}

main "$@"
