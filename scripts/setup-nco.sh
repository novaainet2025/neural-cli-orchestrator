#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  NCO Backend Setup — npm install → build → PM2 → health check          ║
# ║                                                                          ║
# ║  Idempotent, non-interactive, preserves .env and user changes.           ║
# ║  Exits nonzero on first failure.                                         ║
# ║                                                                          ║
# ║  Usage:                                                                  ║
# ║    bash scripts/setup-nco.sh                                             ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

NCO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NCO_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
info() { echo -e "${CYAN}  ▶${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*" >&2; }

# ── Node.js ≥22 check ───────────────────────────────────────────────────────
info "Node.js $(node --version 2>/dev/null || echo 'missing')"
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  err "Node.js >=22 required — install via nvm or your package manager"
  err "  nvm install 22 && nvm use 22"
  exit 1
fi

# ── Step 1: Install dependencies ───────────────────────────────────────────
info "Installing dependencies (npm ci)..."
npm ci --omit=dev --no-fund --no-audit
ok "node_modules ready"

# ── Step 2: Build ──────────────────────────────────────────────────────────
if [[ -f dist/index.js ]]; then
  ok "dist/index.js exists — skipping build (remove dist/ to force rebuild)"
else
  info "Building TypeScript..."
  npm run build
  ok "Build complete"
fi

# ── Step 3: .env ───────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    info ".env created from .env.example — edit API keys before starting"
  else
    err ".env.example not found — create .env manually"
    exit 1
  fi
else
  ok ".env exists — preserved"
fi

# ── Step 4: PM2 start or reload ────────────────────────────────────────────
info "Starting via PM2..."
if command -v pm2 &>/dev/null; then
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save --force
  ok "PM2 started/reloaded"
else
  info "pm2 not found — installing..."
  npm install -g pm2 --no-fund --no-audit
  pm2 start ecosystem.config.cjs
  pm2 save
  ok "PM2 installed and started"
fi

# ── Step 5: Health check ───────────────────────────────────────────────────
info "Waiting for /health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:6200/health >/dev/null 2>&1; then
    ok "NCO healthy on :6200"
    curl -s http://localhost:6200/health
    echo ""
    exit 0
  fi
  sleep 1
done

err "NCO did not become healthy within 30s — check logs: pm2 logs nco-backend --lines 20"
exit 1
