#!/usr/bin/env bash
# vLLM 자동 관리 프록시
# - 요청 시 자동 시작
# - IDLE_TIMEOUT 동안 미사용 시 자동 종료 → VRAM 해제
#
# Usage: ./vllm-proxy.sh [idle_minutes]
# Default: 5분 미사용 시 종료

IDLE_TIMEOUT_MIN=${1:-5}
IDLE_TIMEOUT=$((IDLE_TIMEOUT_MIN * 60))
PORT=8000
LAST_USE_FILE="/tmp/vllm-last-use"
CTL="/home/nova/projects/neural-cli-orchestrator/cli-installs/vllm-ctl.sh"

echo "vLLM 자동 관리 시작 (${IDLE_TIMEOUT_MIN}분 미사용 시 종료)"

while true; do
  if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
    # 실행 중 — 마지막 사용 시간 체크
    if [ -f "$LAST_USE_FILE" ]; then
      LAST=$(cat "$LAST_USE_FILE")
      NOW=$(date +%s)
      DIFF=$((NOW - LAST))
      if [ $DIFF -gt $IDLE_TIMEOUT ]; then
        echo "[$(date '+%H:%M:%S')] ${IDLE_TIMEOUT_MIN}분 미사용 → vLLM 종료 (VRAM 해제)"
        bash "$CTL" stop
      fi
    fi
  fi
  sleep 30
done
