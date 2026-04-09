#!/usr/bin/env bash
# vLLM 서버 제어 (start/stop/status)

MODEL="/mnt/d/llm-models/vllm/gemma-4-26B-A4B-it-NVFP4"
PORT=8000
LOG="/tmp/vllm-server.log"

LAST_USE_FILE="/tmp/vllm-last-use"

case "${1:-status}" in
  start)
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      echo "이미 실행 중 (PID: $(pgrep -f 'vllm.entrypoints'))"
      exit 0
    fi
    source ~/vllm-env/bin/activate
    export HF_TOKEN=$(grep '^HF_TOKEN=' /home/nova/projects/neural-cli-orchestrator/.env 2>/dev/null | cut -d= -f2)
    VLLM_NVFP4_GEMM_BACKEND=marlin nohup python -m vllm.entrypoints.openai.api_server \
      --model "$MODEL" \
      --quantization modelopt \
      --dtype auto \
      --kv-cache-dtype fp8 \
      --gpu-memory-utilization 0.85 \
      --max-model-len 8192 \
      --max-num-seqs 4 \
      --trust-remote-code \
      --port $PORT \
      --host 127.0.0.1 \
      > "$LOG" 2>&1 &
    date +%s > "$LAST_USE_FILE"
    echo "vLLM 시작 (PID: $!, 로딩 ~3분)"
    ;;
  ensure)
    # NCO에서 호출 — 실행 중이면 타임스탬프만 갱신, 아니면 시작
    date +%s > "$LAST_USE_FILE"
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        exit 0  # 이미 준비됨
      fi
    fi
    # 시작 필요
    $0 start
    echo "서버 준비 대기 중..."
    for i in $(seq 1 36); do
      sleep 5
      if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null | grep -q "200"; then
        echo "✓ 준비 완료 ($((i*5))초)"
        exit 0
      fi
    done
    echo "✗ 타임아웃"
    exit 1
    ;;
  stop)
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      pkill -f "vllm.entrypoints"
      sleep 2
      pkill -9 -f "vllm" 2>/dev/null
      echo "vLLM 중지 → VRAM 해제됨"
    else
      echo "실행 중인 vLLM 없음"
    fi
    ;;
  status)
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      PID=$(pgrep -f "vllm.entrypoints" | head -1)
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null)
      echo "● vLLM 실행 중 (PID: $PID, HTTP: $HEALTH)"
      nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  VRAM: %s / %s\n", $1, $2}'
    else
      echo "○ vLLM 중지됨 (VRAM 미사용)"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status}"
    ;;
esac
