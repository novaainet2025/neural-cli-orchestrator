#!/bin/bash
# mlx-chat-liveness.sh — 로컬 mlx-server(:8000) 추론 웨지 자가치유 워치독 (claude-5, 2026-07-09)
#
# 문제: mlx_lm.server는 임의 모델 경로 요청을 동적 로드하다 Metal 메모리 대기에 걸리면
#       추론 스레드가 조용히 웨지된다. 이때 /v1/models(메타데이터)는 계속 200을 반환하므로
#       기존 헬스체크(mlx-watchdog.sh 포함)로는 감지 불가 — 실제 chat 프로브가 필요하다.
# 대응: 1-token chat completion 프로브(45s 간격, 20s 타임아웃). 연속 3회 실패(~155s 블록)
#       → pm2 restart mlx-server. 프로브는 모델 웜 유지 부수효과도 있다.
# 실행: pm2 start cli-installs/mlx-chat-liveness.sh --name mlx-chat-liveness --interpreter bash
MODEL="/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit"
URL="http://127.0.0.1:8000/v1/chat/completions"
INTERVAL=20
THRESHOLD=5
FAILS=0

echo "[$(date '+%F %T')] mlx-chat-liveness start (interval=${INTERVAL}s threshold=${THRESHOLD})"
while true; do
  RESP=$(curl -s --max-time 20 "$URL" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"temperature\":0}" \
    | head -c 50)
  if [ -n "$RESP" ]; then
    [ "$FAILS" -gt 0 ] && echo "[$(date '+%F %T')] probe recovered after $FAILS fail(s)"
    FAILS=0
  else
    FAILS=$((FAILS+1))
    echo "[$(date '+%F %T')] chat probe fail #$FAILS"
    if [ "$FAILS" -ge "$THRESHOLD" ]; then
      echo "[$(date '+%F %T')] WEDGE detected — pm2 restart mlx-server"
      pm2 restart mlx-server >/dev/null 2>&1
      FAILS=0
      sleep 90
    fi
  fi
  sleep "$INTERVAL"
done
