#!/usr/bin/env bash
# vLLM 서버 제어 (start/stop/status/use/models/download)

PORT=8000
LOG="/tmp/vllm-server.log"
LAST_USE_FILE="/tmp/vllm-last-use"
CURRENT_MODEL_FILE="/tmp/vllm-current-model"

MODEL_GEMMA_PATH="/mnt/d/llm-models/vllm/gemma-4-26B-A4B-it-NVFP4"
MODEL_QWEN35_PATH="/mnt/d/llm-models/vllm/Qwen3.5-9B"

# ──────────────────────────────────────────────
# 헬퍼 함수
# ──────────────────────────────────────────────
_current_model() { cat "$CURRENT_MODEL_FILE" 2>/dev/null || echo "gemma"; }

_start_gemma() {
  VLLM_NVFP4_GEMM_BACKEND=marlin nohup python -m vllm.entrypoints.openai.api_server \
    --model "$MODEL_GEMMA_PATH" \
    --quantization modelopt \
    --dtype auto \
    --kv-cache-dtype fp8 \
    --gpu-memory-utilization 0.90 \
    --max-model-len 16384 \
    --max-num-seqs 4 \
    --trust-remote-code \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    --port $PORT \
    --host 127.0.0.1 \
    > "$LOG" 2>&1 &
  echo "gemma" > "$CURRENT_MODEL_FILE"
  echo "▶ Gemma 4 26B 시작 (PID: $!, 로딩 ~3분)"
}

_start_qwen35() {
  source ~/vllm-env/bin/activate
  nohup python -m vllm.entrypoints.openai.api_server \
    --model "$MODEL_QWEN35_PATH" \
    --dtype auto \
    --gpu-memory-utilization 0.90 \
    --max-model-len 24000 \
    --max-num-seqs 4 \
    --trust-remote-code \
    --enforce-eager \
    --enable-auto-tool-choice \
    --tool-call-parser qwen3_coder \
    --port $PORT \
    --host 127.0.0.1 \
    > "$LOG" 2>&1 &
  echo "qwen35" > "$CURRENT_MODEL_FILE"
  echo "▶ Qwen3.5-9B 시작 (PID: $!, 로딩 ~2분)"
}

_start_proxy() {
  pkill -f "anthropic-vllm-proxy" 2>/dev/null
  sleep 1
  nohup python3 /home/nova/projects/security-kb/anthropic-vllm-proxy.py > /tmp/anthropic-proxy.log 2>&1 &
  echo "변환 프록시 시작 (PID: $!, 포트 4100)"
}

_wait_ready() {
  echo "서버 준비 대기 중..."
  for i in $(seq 1 36); do
    sleep 5
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null | grep -q "200"; then
      echo "✓ 준비 완료 ($((i*5))초)"
      return 0
    fi
  done
  echo "✗ 타임아웃 (180초)"
  return 1
}

# ──────────────────────────────────────────────
case "${1:-status}" in
  start)
    # ─── 동시 시작 방지 락 ───
    LOCK_FILE="/tmp/vllm-start.lock"
    if [ -f "$LOCK_FILE" ]; then
      LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
      LOCK_MODEL=$(sed -n '2p' "$LOCK_FILE" 2>/dev/null)
      echo "⚠ 다른 세션이 vLLM 시작 중: 모델=$LOCK_MODEL (PID=$LOCK_PID)"
      echo "  충돌 방지: 현재 시작 요청 취소됨"
      exit 1
    fi
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      echo "이미 실행 중 (PID: $(pgrep -f 'vllm.entrypoints' | head -1), 모델: $(_current_model))"
      exit 0
    fi
    source ~/vllm-env/bin/activate
    export HF_TOKEN=$(grep '^HF_TOKEN=' /home/nova/projects/neural-cli-orchestrator/.env 2>/dev/null | cut -d= -f2)
    TARGET="${2:-$(_current_model)}"
    case "$TARGET" in
      qwen|qwen35|qwen3.5|27b)
        if [ ! -d "$MODEL_QWEN35_PATH" ]; then
          echo "✗ Qwen3.5-27B 모델 없음: $MODEL_QWEN35_PATH"
          exit 1
        fi
        _start_qwen35 ;;
      *) _start_gemma ;;
    esac
    date +%s > "$LAST_USE_FILE"
    # 락 파일 생성 (시작 완료 or 실패 시 자동 삭제)
    echo "$$" > "$LOCK_FILE"; echo "${TARGET:-gemma}" >> "$LOCK_FILE"
    trap 'rm -f "$LOCK_FILE"' EXIT
    _start_proxy
    ;;

  use)
    TARGET="${2:-}"
    if [ -z "$TARGET" ]; then
      echo "Usage: $0 use {gemma|omni}"
      echo "현재 모델: $(_current_model)"
      exit 1
    fi
    CURRENT=$(_current_model)
    if [ "$CURRENT" = "$TARGET" ] && pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      echo "이미 $TARGET 실행 중"
      exit 0
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  모델 전환: $CURRENT → $TARGET"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      echo "현재 서버 종료 중..."
      pkill -f "vllm.entrypoints"
      sleep 3
      pkill -9 -f "vllm" 2>/dev/null
      sleep 2
      echo "VRAM 해제됨"
    fi
    source ~/vllm-env/bin/activate
    export HF_TOKEN=$(grep '^HF_TOKEN=' /home/nova/projects/neural-cli-orchestrator/.env 2>/dev/null | cut -d= -f2)
    case "$TARGET" in
      qwen|qwen35|qwen3.5|27b) _start_qwen35 ;;
      gemma|gemma4|26b) _start_gemma ;;
      *) echo "✗ 알 수 없는 모델: $TARGET (gemma|qwen35)"; exit 1 ;;
    esac
    date +%s > "$LAST_USE_FILE"
    _start_proxy
    _wait_ready
    ;;

  ensure)
    date +%s > "$LAST_USE_FILE"
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        if ! pgrep -f "anthropic-vllm-proxy" > /dev/null 2>&1; then
          nohup python3 /home/nova/projects/security-kb/anthropic-vllm-proxy.py > /tmp/anthropic-proxy.log 2>&1 &
          echo "프록시 재시작 (PID: $!, 포트 4100)"
        fi
        exit 0
      fi
    fi
    $0 start
    _wait_ready
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

  models)
    echo "사용 가능한 모델:"
    [ -d "$MODEL_GEMMA_PATH" ] \
      && echo "  ✓ gemma  — Gemma 4 26B A4B (이미지+텍스트, NVFP4, 16K ctx)" \
      || echo "  ✗ gemma  — 미설치"
    [ -d "$MODEL_QWEN35_PATH" ] \
      && echo "  ✓ qwen35 — Qwen3.5-27B-GPTQ-Int4 (텍스트, 32K ctx)" \
      || echo "  ✗ qwen35 — 미설치"
    echo ""
    echo "현재 활성: $(_current_model)"
    echo "전환 명령: vllm-ctl.sh use {gemma|qwen35}"
    ;;

  download)
    TARGET="${2:-qwen35}"
    source ~/vllm-env/bin/activate
    export HF_TOKEN=$(grep '^HF_TOKEN=' /home/nova/projects/neural-cli-orchestrator/.env 2>/dev/null | cut -d= -f2)
    case "$TARGET" in
      qwen|qwen35|qwen3.5|27b)
        if [ -d "$MODEL_QWEN35_PATH" ] && [ -f "$MODEL_QWEN35_PATH/config.json" ]; then
          echo "이미 존재: $MODEL_QWEN35_PATH"
          exit 0
        fi
        echo "Qwen3.5-27B-GPTQ-Int4 다운로드 시작..."
        echo "경로: $MODEL_QWEN35_PATH (~29GB, 시간 소요)"
        hf download Qwen/Qwen3.5-27B-GPTQ-Int4 --local-dir "$MODEL_QWEN35_PATH"
        ;;
      *)
        echo "Usage: $0 download {qwen35}"
        ;;
    esac
    ;;

  status)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  vLLM 서버 상태"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      PID=$(pgrep -f "vllm.entrypoints" | head -1)
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null)
      echo "  ● 상태    : 실행 중 (PID: $PID)"
      echo "  모델      : $(_current_model)"
      [ "$HEALTH" = "200" ] && echo "  헬스      : 정상 (HTTP $HEALTH)" || echo "  헬스      : 대기 중 (HTTP $HEALTH)"
      nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s\n  GPU 사용률: %s\n  온도      : %s\n", $1,$2,$3,$4,$5}'
      UPTIME=$(ps -o etime= -p $PID 2>/dev/null | xargs)
      [ -n "$UPTIME" ] && echo "  업타임    : $UPTIME"
    else
      echo "  ○ 상태    : 중지됨"
      echo "  모델      : $(_current_model) (마지막 사용)"
      nvidia-smi --query-gpu=name,memory.used,memory.total \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s (미사용)\n", $1,$2,$3}'
    fi
    echo ""
    echo "  사용 가능한 모델:"
    [ -d "$MODEL_GEMMA_PATH" ] && echo "  ✓ gemma  — Gemma 4 26B (16K ctx)" || echo "  ✗ gemma  — 없음"
    [ -d "$MODEL_QWEN35_PATH" ] && echo "  ✓ qwen35 — Qwen3.5-27B-GPTQ-Int4 (32K ctx)" || echo "  ✗ qwen35 — 없음"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  *)
    echo "Usage: $0 {start [gemma|qwen35] | stop | status | use {gemma|qwen35} | models | download {qwen35} | ensure}"
    ;;
esac
