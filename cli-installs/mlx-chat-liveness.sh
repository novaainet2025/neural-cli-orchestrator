#!/bin/bash
# mlx-chat-liveness.sh — 로컬 mlx-server(:8000) 추론 웨지 자가치유 워치독
# (claude-5, 2026-07-09 / 2026-07-10 자해루프 근본수정 by claude-1)
#
# 문제(기존): 20s 타임아웃 chat 프로브 5회 실패 시 pm2 restart. 그러나 모델 로드 중
#   (재시작 직후 17GB 로딩)이나 실제 추론 부하 중에도 프로브가 타임아웃 → 재시작 →
#   또 로딩 → 또 타임아웃 → **무한 재시작 루프**. 2026-07-10 하루 35회 WEDGE 재시작
#   확인(T1: mlx-chat-liveness-out.log). 매 재시작마다 "Fetching 10 files"(캐시 재로드)가
#   사용자에겐 "다운로드"로 보였음.
#
# 수정: 2단계 프로브로 "서버 다운/로딩"과 "진짜 추론 웨지"를 구분한다.
#   1) /v1/models(즉답, 5s): 실패 = 서버 다운 또는 로딩 중 → 웨지로 세지 않고 대기
#      (프로세스 크래시는 pm2 autorestart가 복구. 워치독은 추론 웨지 전용).
#   2) 서버가 살아있을(1단계 통과) 때만 1-token chat 프로브(90s): 이게 실패해야 진짜 웨지.
#   THRESHOLD회 연속 '진짜 웨지'일 때만 pm2 restart, 이후 GRACE초 유예로 로드 완료 대기.
# 실행: pm2 start cli-installs/mlx-chat-liveness.sh --name mlx-chat-liveness --interpreter bash
MODEL="/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit"
BASE="http://127.0.0.1:8000"
HEALTH_URL="$BASE/v1/models"
CHAT_URL="$BASE/v1/chat/completions"
INTERVAL=30          # 프로브 주기(s)
HEALTH_TIMEOUT=5     # /v1/models 타임아웃(s) — 즉답이어야 정상
CHAT_TIMEOUT=90      # chat 프로브 타임아웃(s) — 부하 중 큐 대기 여유(기존 20s가 오탐 원인)
THRESHOLD=3          # '진짜 웨지'(서버는 살아있는데 추론 무응답) 연속 횟수
GRACE=120            # 재시작 후 모델 로드 유예(s)
STARTUP_GRACE=90     # 워치독 기동 직후 유예(s) — mlx도 방금 떴을 수 있음
FAILS=0

echo "[$(date '+%F %T')] mlx-chat-liveness start (interval=${INTERVAL}s chat_timeout=${CHAT_TIMEOUT}s threshold=${THRESHOLD} 2-stage)"
sleep "$STARTUP_GRACE"

while true; do
  # 1단계: 서버 생존 확인(즉답). 실패 = 다운/로딩 중 → 웨지 아님, pm2에 맡기고 대기.
  if ! curl -sf --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" -o /dev/null 2>/dev/null; then
    if [ "$FAILS" -gt 0 ]; then FAILS=0; fi
    echo "[$(date '+%F %T')] server down/loading (/v1/models 무응답) — 대기(pm2 복구), 웨지 아님"
    sleep "$INTERVAL"
    continue
  fi

  # 2단계: 서버는 살아있음 → 실제 추론이 도는지 chat 프로브(넉넉한 타임아웃).
  RESP=$(curl -s --max-time "$CHAT_TIMEOUT" "$CHAT_URL" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"temperature\":0}" \
    | head -c 50)
  if [ -n "$RESP" ]; then
    [ "$FAILS" -gt 0 ] && echo "[$(date '+%F %T')] probe recovered after $FAILS wedge signal(s)"
    FAILS=0
  else
    FAILS=$((FAILS+1))
    echo "[$(date '+%F %T')] TRUE inference wedge signal #$FAILS (서버 up, chat ${CHAT_TIMEOUT}s 무응답)"
    if [ "$FAILS" -ge "$THRESHOLD" ]; then
      echo "[$(date '+%F %T')] WEDGE confirmed — pm2 restart mlx-server (grace ${GRACE}s)"
      pm2 restart mlx-server >/dev/null 2>&1
      FAILS=0
      sleep "$GRACE"
    fi
  fi
  sleep "$INTERVAL"
done
