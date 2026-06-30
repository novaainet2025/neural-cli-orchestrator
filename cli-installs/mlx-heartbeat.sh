#!/usr/bin/env bash
# mlx-heartbeat.sh — Mac MLX 가용성을 inter-session으로 브로드캐스트
# pm2로 상시 실행: pm2 start mlx-heartbeat --name mlx-heartbeat --interpreter bash
#
# 온라인: 60초마다 "mlx_up: url=... model=..." 브로드캐스트
# 오프라인 감지 시: "mlx_down: nova-macstudio" 1회 전송 후 대기
# WSL 노드의 mlx-watchdog.sh가 이 메시지를 받아 provider ON/OFF 처리

set -euo pipefail

MLX_PORT=8000
PROXY_PORT=4100
INTERVAL=60          # 온라인 heartbeat 간격 (초)
OFFLINE_WAIT=30      # 오프라인 상태 재확인 간격 (초)

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTER_SESSION_BIN="$HOME/.claude/plugins/cache/inter-session/inter-session/0.1.2/skills/inter-session/bin"

# Tailscale IP 동적 조회 (없으면 LAN IP 폴백)
_get_ip() {
  TS_IP=$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip 2>/dev/null | head -1)
  if [ -n "$TS_IP" ]; then
    echo "$TS_IP"
  else
    ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1"
  fi
}

_mlx_healthy() {
  curl -sf "http://localhost:${MLX_PORT}/v1/models" >/dev/null 2>&1
}

_broadcast() {
  python3 "$INTER_SESSION_BIN/send.py" --all --text "$1" 2>/dev/null || true
}

WAS_ONLINE=false
echo "[mlx-heartbeat] 시작됨 (간격: ${INTERVAL}초)"

while true; do
  IP=$(_get_ip)
  MLX_URL="http://${IP}:${MLX_PORT}"
  PROXY_URL="http://${IP}:${PROXY_PORT}"
  MODEL=$(curl -s "http://localhost:${MLX_PORT}/v1/models" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null \
    || echo "unknown")

  if _mlx_healthy; then
    MSG="mlx_up: url=${MLX_URL} proxy=${PROXY_URL} model=${MODEL} host=nova-macstudio ts=$(date +%s)"
    echo "[mlx-heartbeat] 브로드캐스트: $MSG"
    _broadcast "$MSG"
    WAS_ONLINE=true
    sleep "$INTERVAL"
  else
    if [ "$WAS_ONLINE" = "true" ]; then
      echo "[mlx-heartbeat] MLX 오프라인 감지 — 다운 알림 전송"
      _broadcast "mlx_down: host=nova-macstudio ts=$(date +%s)"
      WAS_ONLINE=false
    fi
    echo "[mlx-heartbeat] MLX 오프라인 대기 중..."
    sleep "$OFFLINE_WAIT"
  fi
done
