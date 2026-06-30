#!/usr/bin/env bash
# mlx-watchdog.sh — inter-session에서 MLX heartbeat 수신 → NCO provider 동적 ON/OFF
# WSL 노드에서 실행 (subnote, snt, kangnote)
# 사용법: bash mlx-watchdog.sh [--nco-config /path/to/ai-providers.json]
#
# mlx_up 수신  → remote-mlx provider enabled=true → NCO 재로드
# mlx_down 수신 → remote-mlx provider enabled=false → NCO 재로드
# 3분간 heartbeat 없음 → 자동 오프라인 처리 (타임아웃)
#
# 실행 방법: pm2 start mlx-watchdog.sh --name mlx-watchdog --interpreter bash

set -euo pipefail

CONFIG="${MLX_WATCHDOG_CONFIG:-$(dirname "$(dirname "${BASH_SOURCE[0]}")")/config/ai-providers.json}"
HEARTBEAT_TIMEOUT=180    # 3분간 heartbeat 없으면 오프라인 처리
INBOX_LOG="$HOME/.claude/data/inter-session/messages.log"
LAST_HEARTBEAT=0
CURRENT_STATE="unknown"  # "online" | "offline" | "unknown"

log() { echo "[mlx-watchdog] $(date '+%H:%M:%S') $*"; }

# remote-mlx provider enabled 상태 변경
_set_provider() {
  local ENABLED="$1"   # true | false
  local URL="$2"
  local MODEL="${3:-unknown}"

  if [ ! -f "$CONFIG" ]; then
    log "ERROR: config 없음: $CONFIG"
    return 1
  fi

  python3 - "$CONFIG" "$ENABLED" "$URL" "$MODEL" << 'PY'
import json, sys
cfg_path, enabled_str, url, model = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
enabled = enabled_str == "true"

with open(cfg_path) as f:
    data = json.load(f)

found = False
for p in data["providers"]:
    if p.get("id") == "remote-mlx":
        p["enabled"] = enabled
        if enabled and url != "keep":
            p["baseUrl"] = url + "/v1"
            p["model"] = model
        found = True
        break

if not found and enabled:
    # 신규 추가
    data["providers"].insert(0, {
        "id": "remote-mlx",
        "name": "Mac MLX (Tailscale)",
        "enabled": True,
        "type": "api",
        "role": "Local LLM",
        "score": 80,
        "model": model,
        "baseUrl": url + "/v1",
        "concurrency": 1,
        "rateLimitRpm": 10,
        "cost": "free",
        "capabilities": ["code", "analysis", "reasoning"],
        "note": "Mac MLX via Tailscale — auto-managed by mlx-watchdog.sh"
    })

with open(cfg_path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

action = "ON" if enabled else "OFF"
print(f"remote-mlx {action} (url={url} model={model})")
PY
}

# NCO 재로드 (provider 변경 반영)
_reload_nco() {
  if pm2 restart nco-backend 2>/dev/null; then
    log "NCO restarted via PM2"
  elif fuser -k 6200/tcp 2>/dev/null; then
    sleep 1
    NCO_MEM0_NO_EMBED=1 nohup tsx src/index.ts > /tmp/nco.log 2>&1 &
    log "NCO restarted via fuser"
  else
    log "NCO restart 불가 (수동 재시작 필요)"
  fi
}

_parse_heartbeat() {
  # "mlx_up: url=http://100.88.88.69:8000 proxy=... model=... host=..."
  local TEXT="$1"
  MLX_URL=$(echo "$TEXT" | grep -oP 'url=\K[^\s]+' || echo "")
  MLX_MODEL=$(echo "$TEXT" | grep -oP 'model=\K[^\s]+' || echo "unknown")
  echo "$MLX_URL|$MLX_MODEL"
}

log "시작됨 — config: $CONFIG"
log "inter-session 메시지 모니터링 중..."

# inter-session messages.log tail 방식으로 실시간 감지
tail -F "$INBOX_LOG" 2>/dev/null | while IFS= read -r LINE; do
  # JSON 파싱
  TEXT=$(echo "$LINE" | python3 -c "
import json,sys
try:
  d=json.loads(sys.stdin.read())
  t=d.get('text','')
  if 'mlx_up:' in t or 'mlx_down:' in t:
    print(t)
except: pass
" 2>/dev/null)

  [ -z "$TEXT" ] && continue

  NOW=$(date +%s)

  if echo "$TEXT" | grep -q "mlx_up:"; then
    PARSED=$(_parse_heartbeat "$TEXT")
    URL="${PARSED%|*}"
    MODEL="${PARSED#*|}"

    if [ "$CURRENT_STATE" != "online" ]; then
      log "MLX 온라인 감지! url=$URL model=$MODEL"
      _set_provider "true" "$URL" "$MODEL" && log "remote-mlx ENABLED"
      _reload_nco
      CURRENT_STATE="online"
    fi
    LAST_HEARTBEAT=$NOW

  elif echo "$TEXT" | grep -q "mlx_down:"; then
    if [ "$CURRENT_STATE" != "offline" ]; then
      log "MLX 다운 신호 수신"
      _set_provider "false" "keep" "keep" && log "remote-mlx DISABLED"
      _reload_nco
      CURRENT_STATE="offline"
    fi
  fi

  # 타임아웃 체크 (마지막 heartbeat로부터 3분 이상)
  if [ "$CURRENT_STATE" = "online" ] && [ "$LAST_HEARTBEAT" -gt 0 ]; then
    ELAPSED=$(( NOW - LAST_HEARTBEAT ))
    if [ "$ELAPSED" -gt "$HEARTBEAT_TIMEOUT" ]; then
      log "Heartbeat 타임아웃 (${ELAPSED}초) — 오프라인 처리"
      _set_provider "false" "keep" "keep" && log "remote-mlx DISABLED (timeout)"
      _reload_nco
      CURRENT_STATE="offline"
      LAST_HEARTBEAT=0
    fi
  fi

done
