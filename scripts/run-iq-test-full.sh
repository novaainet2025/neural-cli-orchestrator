#!/bin/bash
set -uo pipefail
LOG="/tmp/iq-test-browser-run.log"
LIVE="/tmp/iq-test-live.log"
: > "$LOG"
: > "$LIVE"
ROOT="/Users/nova-ai/project/nova-use"
STORE="/Users/nova-ai/.nco-cli-ext"
CDP_PORT="${NOVA_IQ_CDP_PORT:-9272}"
IQ_URL="${IQ_TEST_URL:-https://iq-test.us/}"
USER_DATA="/tmp/nova-iq-test-$$"

log() { echo "$@" | tee -a "$LOG" | tee -a "$LIVE"; }

run_browser() {
  local label="$1"
  shift
  log "=== $label: nco-browser $* ==="
  (
    cd "$ROOT"
    export NCO_BRIDGE_URL="$BRIDGE_URL"
    export NCO_BRIDGE_TOKEN="$BRIDGE_TOKEN"
    export NCO_BRIDGE_TIMEOUT_MS=90000
    export NCO_BROWSER_ONLY=1
    node bin/nco-browser.mjs "$@"
  ) 2>&1 | tee -a "$LOG" | tee -a "$LIVE"
  local ec=${PIPESTATUS[0]}
  log "EXIT_CODE=$ec"
  return $ec
}

read_bridge() {
  BRIDGE_URL="$(tr -d '[:space:]' < "$STORE/bridge-url")"
  BRIDGE_TOKEN="$(tr -d '[:space:]' < "$STORE/bridge-token")"
}

BEFORE_URL="$(tr -d '[:space:]' < "$STORE/bridge-url")"
log "=== IQ Test Browser Automation ==="
log "Before bridge: $BEFORE_URL"
log "Target: $IQ_URL"

# Start electron directly (like acceptance test)
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  ELECTRON_BIN="$(node -p "require('electron')" 2>/dev/null || true)"
fi
log "Electron: $ELECTRON_BIN"
nohup "$ELECTRON_BIN" "$ROOT" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$USER_DATA" \
  >> /tmp/nova-iq-electron.log 2>&1 &
ELECTRON_PID=$!
log "Electron pid=$ELECTRON_PID userData=$USER_DATA"

# Wait for bridge-url to update (nova-use writes on boot)
for i in $(seq 1 120); do
  read_bridge
  if run_browser "status-wait-$i" status; then
    log "Bridge ready on attempt $i: $BRIDGE_URL"
    break
  fi
  sleep 2
  if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
    log "Electron died: $(tail -5 /tmp/nova-iq-electron.log)"
    exit 1
  fi
done

if ! run_browser "status" status; then
  log "FATAL: bridge never became ready"
  kill "$ELECTRON_PID" 2>/dev/null || true
  exit 1
fi

# Navigate
if ! run_browser "navigate" navigate "$IQ_URL"; then
  log "Trying iqtest.kr fallback"
  run_browser "navigate-iqtest.kr" navigate "https://www.iqtest.kr/" || true
fi
sleep 5

QUESTIONS=0
for round in $(seq 0 14); do
  run_browser "analyze-$round" analyze || true
  run_browser "page-$round" page || true

  PAGE_JSON="$(node -e "
    const fs=require('fs');
    try { const j=JSON.parse(fs.readFileSync('$STORE/page-context.json','utf8'));
      console.log(JSON.stringify({title:j.title,url:j.url,purpose:j.purpose,cta:j.comprehension?.primaryCta}));
    } catch(e) { console.log('{}'); }
  " 2>/dev/null || echo '{}')"
  log "PAGE_META: $PAGE_JSON"

  if echo "$PAGE_JSON" | grep -qiE 'result|score|your iq|결과|점수'; then
    log "=== RESULT PAGE ==="
    break
  fi

  # Extract first @e selector from page-context for start/answer
  SELECTOR="$(node -e "
    const fs=require('fs');
    const j=JSON.parse(fs.readFileSync('$STORE/page-context.json','utf8'));
    const startRe=/start|begin|시작|test|continue|next|다음/i;
    const cta=j.comprehension?.primaryCta;
    if (cta?.selector && startRe.test(cta.text||'')) { console.log(cta.selector); process.exit(0); }
    for (const f of (j.fields||[])) {
      const t=(f.label||f.text||'');
      if (f.selector && startRe.test(t)) { console.log(f.selector); process.exit(0); }
    }
    for (const f of (j.fields||[])) {
      if (f.selector && /button|radio|option/i.test(f.type||'')) { console.log(f.selector); process.exit(0); }
    }
    if (j.comprehension?.primaryCta?.selector) { console.log(j.comprehension.primaryCta.selector); process.exit(0); }
    process.exit(1);
  " 2>/dev/null || true)"

  if [[ -z "$SELECTOR" ]]; then
    log "No selector round $round"
    run_browser "screenshot-$round" screenshot "iq-round-$round" || true
    break
  fi
  log "CLICK: $SELECTOR"
  if run_browser "click-$round" click "$SELECTOR"; then
  else
    run_browser "force-$round" force "$SELECTOR" || true
  fi
  QUESTIONS=$((QUESTIONS+1))
  sleep 2
  if [[ "$QUESTIONS" -ge 12 ]]; then break; fi
done

run_browser "final-status" status || true
run_browser "final-analyze" analyze || true
run_browser "final-page" page || true
run_browser "final-screenshot" screenshot "iq-final" || true

FINAL="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$STORE/page-context.json','utf8'));console.log('URL:',j.url);console.log('Title:',j.title);const s=JSON.stringify(j);const m=s.match(/IQ[^0-9]{0,20}(\d{2,3})/i);if(m)console.log('Score:',m[0]);" 2>/dev/null || true)"
log "=== FINAL ==="
log "$FINAL"

kill "$ELECTRON_PID" 2>/dev/null || true
rm -rf "$USER_DATA" 2>/dev/null || true
log "DONE"
