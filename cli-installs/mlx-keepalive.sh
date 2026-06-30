#!/usr/bin/env bash
# mlx-keepalive.sh — mlx_lm.server 아이들 종료 방지 keepalive
# 25초마다 /v1/chat/completions에 실제 추론 요청을 보내 모델을 메모리에 유지
# PM2로 관리: pm2 start ecosystem.config.cjs --only mlx-keepalive

set -euo pipefail

MLX_URL="http://127.0.0.1:8000/v1/chat/completions"
INTERVAL=25   # mlx 아이들 타임아웃(~30s)보다 짧게
MAX_WAIT=120  # 서버 부팅 대기 최대 시간

log() { echo "[mlx-keepalive] $(date '+%H:%M:%S') $*"; }

# 서버 부팅 대기
log "waiting for mlx-server to come up..."
waited=0
while ! curl -sf "http://127.0.0.1:8000/v1/models" >/dev/null 2>&1; do
  sleep 5
  waited=$((waited + 5))
  if [[ $waited -ge $MAX_WAIT ]]; then
    log "WARN: mlx-server not up after ${MAX_WAIT}s, retrying in 30s..."
    sleep 30
    waited=0
  fi
done
log "mlx-server up — starting keepalive loop (interval=${INTERVAL}s)"

# keepalive 루프
while true; do
  resp=$(curl -sf -X POST "$MLX_URL" \
    -H "Content-Type: application/json" \
    -d '{"model":"/Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}' \
    --max-time 30 2>&1) && {
    log "OK — model warm"
  } || {
    log "WARN: keepalive request failed (server restarting?): $resp"
    # 서버 재시작 대기
    sleep 15
    waited=0
    while ! curl -sf "http://127.0.0.1:8000/v1/models" >/dev/null 2>&1; do
      sleep 5
      waited=$((waited + 5))
      [[ $waited -ge $MAX_WAIT ]] && { log "WARN: still not up, waiting..."; waited=0; }
    done
    log "mlx-server back up — resuming keepalive"
  }
  sleep "$INTERVAL"
done
