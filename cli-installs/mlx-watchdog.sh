#!/usr/bin/env bash
# mlx-watchdog.sh — Tailscale HTTP 직접 폴링으로 MLX 가용성 감지 → NCO provider 동적 ON/OFF
# WSL 노드에서 실행 (subnote, snt, kangnote)
# 사용법: bash mlx-watchdog.sh
#
# 구조: messages.log 의존 제거 — Tailscale HTTP 직접 폴링 방식
#   온라인 감지 → remote-mlx provider enabled=true → NCO 재로드
#   오프라인 감지 → remote-mlx provider enabled=false → NCO 재로드
#
# 환경변수:
#   MLX_WATCHDOG_CONFIG  — ai-providers.json 경로 (기본: ../config/ai-providers.json)
#   MLX_REMOTE_HOST      — MLX 서버 Tailscale IP (기본: 100.88.88.69)
#   MLX_REMOTE_PORT      — MLX 서버 포트 (기본: 8000)
#   MLX_POLL_INTERVAL    — 폴링 간격(초) (기본: 60)
#
# 실행 방법: pm2 start mlx-watchdog.sh --name mlx-watchdog --interpreter bash

set -euo pipefail

CONFIG="${MLX_WATCHDOG_CONFIG:-$(dirname "$(dirname "${BASH_SOURCE[0]}")")/config/ai-providers.json}"
MLX_HOST="${MLX_REMOTE_HOST:-100.88.88.69}"
MLX_PORT="${MLX_REMOTE_PORT:-8000}"
POLL_INTERVAL="${MLX_POLL_INTERVAL:-60}"
MLX_URL="http://${MLX_HOST}:${MLX_PORT}"
CURRENT_STATE="unknown"  # "online" | "offline" | "unknown"

log() { echo "[mlx-watchdog] $(date '+%H:%M:%S') $*"; }

# MLX 서버 헬스 체크 — /v1/models 응답 여부
_mlx_healthy() {
  curl -sf --max-time 5 "${MLX_URL}/v1/models" >/dev/null 2>&1
}

# MLX 모델명 조회
_get_model() {
  curl -s --max-time 5 "${MLX_URL}/v1/models" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null \
    || echo "unknown"
}

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

log "시작됨 — config: $CONFIG"
log "MLX 대상: ${MLX_URL} (폴링 간격: ${POLL_INTERVAL}초)"
log "직접 HTTP 폴링 모드 (messages.log 의존 없음)"

# 메인 폴링 루프
while true; do
  if _mlx_healthy; then
    if [ "$CURRENT_STATE" != "online" ]; then
      MODEL=$(_get_model)
      log "MLX 온라인 감지! url=${MLX_URL} model=${MODEL}"
      _set_provider "true" "$MLX_URL" "$MODEL" && log "remote-mlx ENABLED"
      _reload_nco
      CURRENT_STATE="online"
    fi
  else
    if [ "$CURRENT_STATE" != "offline" ]; then
      log "MLX 오프라인 감지 (${MLX_URL} 응답 없음)"
      _set_provider "false" "keep" "keep" && log "remote-mlx DISABLED"
      _reload_nco
      CURRENT_STATE="offline"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
