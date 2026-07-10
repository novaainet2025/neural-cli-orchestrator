#!/usr/bin/env bash
# MLX 서버 제어 (start/stop/status/logs/use/models)
# macOS Apple Silicon 전용 — pm2 기반
#
# Usage:
#   ./mlx-ctl.sh start              — MLX 서버 시작
#   ./mlx-ctl.sh stop               — MLX 서버 중지 (VRAM 해제)
#   ./mlx-ctl.sh restart            — 재시작
#   ./mlx-ctl.sh ensure             — 실행 중이면 유지, 아니면 자동 시작
#   ./mlx-ctl.sh status             — 상태 + 헬스 확인
#   ./mlx-ctl.sh logs [줄수]        — 최근 로그 출력
#   ./mlx-ctl.sh models             — 로드된 모델 목록
#   ./mlx-ctl.sh use                — 마지막 사용 시간 갱신 (auto-idle 용)
#   ./mlx-ctl.sh proxy start|stop|status  — Anthropic 프록시 제어

set -euo pipefail

PM2_NAME="mlx-server"
PORT=8000
MLX_API="http://localhost:${PORT}/v1"
LAST_USE_FILE="/tmp/mlx-last-use"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NCO_DIR="${NCO_DIR:-$(dirname "$SCRIPT_DIR")}"
MODEL_PATH_RAW="${MLX_MODEL_PATH:-$HOME/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit}"
MLX_BIN="${HOME}/.local/bin/mlx_lm.server"
PROXY_SCRIPT="${NCO_DIR}/cli-installs/anthropic-mlx-proxy.py"
PROXY_PORT=4100
PROXY_LOG="/tmp/anthropic-mlx-proxy.log"

_resolve_model_path() {
  local key
  key="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$key" in
    qwen3|qwen3-30b|qwen3-instruct|qwen3-30b-instruct)
      echo "$HOME/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit"
      ;;
    qwen3-coder|qwen3-coder-30b)
      echo "$HOME/project/LM-models/mlx/Qwen3-Coder-30B-A3B-Instruct-4bit"
      ;;
    glm-5)
      echo "$HOME/project/LM-models/mlx/GLM-5-4bit"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

MODEL_PATH="$(_resolve_model_path "$MODEL_PATH_RAW")"

_is_running() { pm2 jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""; }
_is_healthy()  { curl -sf "${MLX_API}/models" >/dev/null 2>&1; }
_pm2_start() {
  pm2 describe "$PM2_NAME" >/dev/null 2>&1 \
    && pm2 start "$PM2_NAME" 2>&1 | tail -3 \
    || pm2 start "$MLX_BIN" --name "$PM2_NAME" --interpreter none --max-memory-restart 30G \
         -- --model "$MODEL_PATH" --port $PORT --host 0.0.0.0 2>&1 | tail -3
}

CMD="${1:-status}"
ARG2="${2:-}"

case "$CMD" in
  start)
    echo "▶ MLX 서버 시작 중..."
    _pm2_start
    echo "  모델 로딩 대기 (최대 60초)..."
    for i in $(seq 1 12); do
      sleep 5
      _is_healthy && echo "✓ MLX 서버 준비됨 (${MLX_API})" && exit 0
      echo "  ...${i}번째 확인 ($((i*5))s)"
    done
    echo "✗ 타임아웃 — 로그 확인: pm2 logs $PM2_NAME"
    exit 1
    ;;
  stop)
    echo "■ MLX 서버 중지 중..."
    pm2 stop "$PM2_NAME" 2>&1 | tail -3 && echo "  VRAM 해제됨"
    ;;
  restart)
    echo "↺ MLX 서버 재시작 중..."
    pm2 restart "$PM2_NAME" 2>&1 | tail -3
    ;;
  ensure)
    if _is_running && _is_healthy; then
      echo "✓ MLX 서버 정상 실행 중"
    else
      echo "MLX 서버 시작 중..."; _pm2_start
    fi
    ;;
  status)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  MLX 서버 상태"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    PM2_INFO=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
  apps=json.load(sys.stdin)
  for a in apps:
    if a['name']=='mlx-server':
      print(a['pid'],a['pm2_env']['status'],a['monit']['memory']); break
except: pass" 2>/dev/null)
    if [ -n "$PM2_INFO" ]; then
      PID=$(echo "$PM2_INFO"|awk '{print $1}')
      ST=$(echo "$PM2_INFO"|awk '{print $2}')
      MEM=$(echo "$PM2_INFO"|awk '{print $3}')
      MEM_GB=$(awk "BEGIN{printf \"%.2f\",$MEM/1073741824}" 2>/dev/null||echo "?")
      HC=$(curl -s -o /dev/null -w "%{http_code}" "${MLX_API}/models" 2>/dev/null)
      echo "  ● PM2 상태  : $ST (PID: $PID)"
      echo "  ✓ 헬스      : HTTP $HC"
      echo "  메모리      : ${MEM_GB} GB (unified)"
      curl -s "${MLX_API}/models" 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  for m in d.get('data',[]): print('  모델        :',m['id'])
except: pass" 2>/dev/null
    else
      echo "  ○ 상태      : 중지됨"
    fi
    curl -sf "http://localhost:${PROXY_PORT}/health" >/dev/null 2>&1 \
      && echo "  ● 프록시    : 실행 중 (port ${PROXY_PORT})" \
      || echo "  ○ 프록시    : 중지됨 (port ${PROXY_PORT})"
    SYS_MEM=$(vm_stat 2>/dev/null | awk '/Pages free/{f=$3}/Pages active/{a=$3}/Pages wired/{w=$4}END{printf"%.1f GB free / %.1f GB total",f*4096/1073741824,(f+a+w)*4096/1073741824}')
    echo "  시스템 메모리: $SYS_MEM"
    echo "  엔드포인트  : ${MLX_API}"
    echo "  모델 경로   : $MODEL_PATH"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;
  logs)
    LINES="${ARG2:-50}"
    echo "━━━ MLX 로그 (최근 ${LINES}줄) ━━━"
    pm2 logs "$PM2_NAME" --lines "$LINES" --nostream 2>&1 | tail -n $((LINES+5))
    ;;
  models)
    curl -s "${MLX_API}/models" 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  for m in d.get('data',[]): print(f'  • {m[\"id\"]}')
except: print('  MLX 서버 미실행. ./mlx-ctl.sh start')"
    ;;
  use)
    date +%s > "$LAST_USE_FILE"
    ;;
  proxy)
    SUB="${ARG2:-status}"
    case "$SUB" in
      start)
        if curl -sf "http://localhost:${PROXY_PORT}/health" >/dev/null 2>&1; then
          echo "✓ 프록시 이미 실행 중 (port ${PROXY_PORT})"
        else
          nohup python3 "$PROXY_SCRIPT" $PROXY_PORT >> "$PROXY_LOG" 2>&1 &
          sleep 2
          curl -sf "http://localhost:${PROXY_PORT}/health" >/dev/null 2>&1 \
            && echo "✓ 프록시 시작됨 (port ${PROXY_PORT})" \
            || echo "✗ 프록시 시작 실패 (로그: $PROXY_LOG)"
        fi
        echo "  claude-mlx  →  ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} ANTHROPIC_API_KEY=dummy claude"
        ;;
      stop)
        pkill -f "anthropic-mlx-proxy.py" 2>/dev/null && echo "✓ 프록시 중지됨" || echo "실행 중인 프록시 없음"
        ;;
      status|"")
        curl -sf "http://localhost:${PROXY_PORT}/health" >/dev/null 2>&1 \
          && echo "● 프록시 실행 중 (port ${PROXY_PORT})" \
          || { echo "○ 프록시 중지됨"; echo "  시작: $0 proxy start"; }
        ;;
      *)
        echo "사용법: $0 proxy {start|stop|status}" ;;
    esac
    ;;
  *)
    echo "사용법: $(basename "$0") {start|stop|restart|ensure|status|logs [N]|models|use|proxy {start|stop|status}}"
    exit 1
    ;;
esac
