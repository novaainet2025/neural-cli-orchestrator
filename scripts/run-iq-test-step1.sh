#!/bin/bash
set -uo pipefail
LOG="/tmp/iq-test-browser-run.log"
: > "$LOG"
ROOT="/Users/nova-ai/project/nova-use"
cd "$ROOT"

log() { echo "$@" | tee -a "$LOG"; }

# Start nova-use if bridge not accepting panel
start_nova_use() {
  log "=== Starting nova-use (electron-vite preview) ==="
  nohup npm run start >> /tmp/nova-use-iq-preview.log 2>&1 &
  echo $! > /tmp/nova-use-iq-preview.pid
  log "nova-use pid=$(cat /tmp/nova-use-iq-preview.pid)"
}

wait_bridge() {
  local url="$1" token="$2" max=60
  for i in $(seq 1 $max); do
    if NCO_BRIDGE_URL="$url" NCO_BRIDGE_TOKEN="$token" node bin/nco-browser.mjs status 2>/tmp/iq-bridge-try.err; then
      log "Bridge OK on attempt $i"
      return 0
    fi
    sleep 2
  done
  log "Bridge wait failed: $(cat /tmp/iq-bridge-try.err 2>/dev/null)"
  return 1
}

run_cmd() {
  log "=== $* ==="
  node bin/nco-browser.mjs "$@" 2>&1 | tee -a "$LOG"
  log "EXIT_CODE=${PIPESTATUS[0]}"
}

# Try user bridge first, then default
BRIDGE_URL="ws://127.0.0.1:64092"
BRIDGE_TOKEN="nPiGkY1Inn-t-9iAi2V1Qdzm_MlFjiAN"
export NCO_BRIDGE_URL="$BRIDGE_URL"
export NCO_BRIDGE_TOKEN="$BRIDGE_TOKEN"

log "=== status (user bridge 64092) ==="
if ! node bin/nco-browser.mjs status 2>&1 | tee -a "$LOG"; then
  BRIDGE_URL="ws://127.0.0.1:8791"
  BRIDGE_TOKEN="$(cat /Users/nova-ai/.nco-cli-ext/bridge-token)"
  export NCO_BRIDGE_URL="$BRIDGE_URL"
  export NCO_BRIDGE_TOKEN="$BRIDGE_TOKEN"
  log "=== fallback status (8791) ==="
  if ! node bin/nco-browser.mjs status 2>&1 | tee -a "$LOG"; then
    start_nova_use
    if ! wait_bridge "$BRIDGE_URL" "$BRIDGE_TOKEN"; then
      exit 1
    fi
  fi
fi

run_cmd navigate "https://iq-test.us/"
sleep 4
run_cmd analyze
run_cmd page
