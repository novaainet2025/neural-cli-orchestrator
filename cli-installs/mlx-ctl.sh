#!/usr/bin/env bash
# mlx-ctl.sh — MLX 서버 제어 스크립트 (Apple Silicon / macOS 전용)
# 서브커맨드: start | stop | restart | ensure | status | logs | models | use | proxy
#
# 환경변수:
#   NCO_DIR          — NCO 프로젝트 루트 (미설정 시 스크립트 위치 기준 자동 탐지)
#   MLX_MODEL_PATH   — MLX 모델 디렉터리 경로 오버라이드
#
# 의존: pm2, python3, mlx_lm, curl

set -euo pipefail

# ── 경로 탐지 ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NCO_DIR="${NCO_DIR:-$(dirname "$SCRIPT_DIR")}"

# ── 설정 ──────────────────────────────────────────────────────────────────────
MLX_PM2_NAME="mlx-server"
MLX_PORT=8000
MLX_API="http://localhost:${MLX_PORT}/v1"
MLX_BIN="${HOME}/.local/bin/mlx_lm.server"
MODEL_PATH="${MLX_MODEL_PATH:-${HOME}/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit}"

PROXY_PORT=4100
PROXY_SCRIPT="${NCO_DIR}/cli-installs/anthropic-mlx-proxy.py"
PROXY_LOG="/tmp/anthropic-mlx-proxy.log"
PROXY_HEALTH="http://localhost:${PROXY_PORT}/health"

LAST_USE_FILE="/tmp/mlx-last-use"

# ── 헬퍼 함수 ─────────────────────────────────────────────────────────────────
_pm2_running() {
  pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  sys.exit(0 if any(a['name'] == '${MLX_PM2_NAME}' and a['pm2_env']['status'] == 'online' for a in apps) else 1)
except: sys.exit(1)" 2>/dev/null
}

_mlx_healthy() {
  curl -sf "${MLX_API}/models" >/dev/null 2>&1
}

_proxy_healthy() {
  curl -sf "${PROXY_HEALTH}" >/dev/null 2>&1
}

_pm2_start_mlx() {
  if pm2 describe "${MLX_PM2_NAME}" >/dev/null 2>&1; then
    pm2 start "${MLX_PM2_NAME}" 2>&1 | tail -3
  else
    pm2 start "${MLX_BIN}" \
      --name "${MLX_PM2_NAME}" \
      --interpreter none \
      --max-memory-restart 30G \
      -- --model "${MODEL_PATH}" --port "${MLX_PORT}" --host 127.0.0.1 2>&1 | tail -3
  fi
}

_wait_mlx_ready() {
  local max_tries=12 i
  for i in $(seq 1 "${max_tries}"); do
    sleep 5
    if _mlx_healthy; then
      echo "  ✓ MLX 서버 준비됨 ($((i * 5))s)"
      return 0
    fi
    echo "  ... 대기 중 ($((i * 5))s / $((max_tries * 5))s)"
  done
  echo "  ✗ 타임아웃 — MLX 서버 응답 없음"
  return 1
}

# ── 서브커맨드 파싱 ───────────────────────────────────────────────────────────
CMD="${1:-status}"
ARG2="${2:-}"

case "${CMD}" in

  start)
    echo "▶ MLX 서버 시작 중... (모델: ${MODEL_PATH})"
    _pm2_start_mlx
    _wait_mlx_ready
    ;;

  stop)
    echo "■ MLX 서버 중지 중..."
    pm2 stop "${MLX_PM2_NAME}" 2>&1 | tail -3
    ;;

  restart)
    echo "↺ MLX 서버 재시작 중..."
    pm2 restart "${MLX_PM2_NAME}" 2>&1 | tail -3
    _wait_mlx_ready
    ;;

  ensure)
    if _pm2_running && _mlx_healthy; then
      echo "✓ MLX 서버 정상 실행 중"
    else
      echo "▶ MLX 서버 비정상 — 시작 시도..."
      _pm2_start_mlx
      _wait_mlx_ready
    fi
    date +%s > "${LAST_USE_FILE}"
    ;;

  status)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  MLX 서버 상태"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    PM2_INFO=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for a in apps:
    if a['name'] == 'mlx-server':
      mem = a.get('monit', {}).get('memory', 0)
      pid = a.get('pid', '-')
      st  = a['pm2_env']['status']
      restarts = a['pm2_env'].get('restart_time', 0)
      print(f'{pid} {st} {mem} {restarts}')
      break
except: pass" 2>/dev/null || true)

    if [ -n "${PM2_INFO}" ]; then
      read -r _pid _st _mem _restarts <<< "${PM2_INFO}"
      _mem_gb=$(python3 -c "print(f'{int(${_mem})/1073741824:.2f}')" 2>/dev/null || echo "?")
      if _mlx_healthy; then
        _health_str="✓ 정상"
      else
        _health_str="⚠ 응답 없음"
      fi
      echo "  ● PM2       : ${_st} (PID ${_pid})"
      echo "  메모리      : ${_mem_gb} GB"
      echo "  재시작      : ${_restarts}회"
      echo "  API 헬스    : ${_health_str}"
    else
      echo "  ○ PM2       : 중지됨 / 미등록"
    fi

    echo ""

    if _proxy_healthy; then
      echo "  ● 프록시    : 실행 중 (port ${PROXY_PORT})"
    else
      echo "  ○ 프록시    : 중지됨"
    fi

    echo ""
    echo "  모델 경로   : ${MODEL_PATH}"
    [ -d "${MODEL_PATH}" ] \
      && echo "  모델 존재   : ✓" \
      || echo "  모델 존재   : ✗ (경로 없음)"

    if [ -f "${LAST_USE_FILE}" ]; then
      _last=$(cat "${LAST_USE_FILE}" 2>/dev/null || echo "")
      if [ -n "${_last}" ]; then
        _last_fmt=$(python3 -c "import datetime; print(datetime.datetime.fromtimestamp(${_last}).strftime('%Y-%m-%d %H:%M:%S'))" 2>/dev/null || echo "${_last}")
        echo "  마지막 사용 : ${_last_fmt}"
      fi
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  logs)
    LINES="${ARG2:-50}"
    pm2 logs "${MLX_PM2_NAME}" --lines "${LINES}" --nostream 2>&1 | tail -n $(( LINES + 5 ))
    ;;

  models)
    echo "현재 로드된 모델 (MLX API):"
    curl -s "${MLX_API}/models" 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  models = d.get('data', [])
  if not models:
    print('  (모델 없음 또는 서버 미실행)')
  for m in models:
    print(f\"  • {m['id']}\")
except Exception as e:
  print(f'  MLX 서버 미실행 또는 응답 없음: {e}')" 2>/dev/null || true

    echo ""
    echo "NCO_DIR       : ${NCO_DIR}"
    echo "MLX_MODEL_PATH: ${MODEL_PATH}"
    [ -d "${MODEL_PATH}" ] \
      && echo "모델 디렉터리 : ✓ 존재" \
      || echo "모델 디렉터리 : ✗ 없음 — MLX_MODEL_PATH 환경변수 확인"
    ;;

  use)
    date +%s > "${LAST_USE_FILE}"
    echo "✓ 마지막 사용 시각 갱신됨"
    ;;

  proxy)
    SUB="${ARG2:-status}"
    case "${SUB}" in
      start)
        if _proxy_healthy; then
          echo "✓ 프록시 이미 실행 중 (port ${PROXY_PORT})"
        else
          if [ ! -f "${PROXY_SCRIPT}" ]; then
            echo "✗ 프록시 스크립트 없음: ${PROXY_SCRIPT}"
            exit 1
          fi
          echo "▶ 프록시 시작 중... (port ${PROXY_PORT})"
          nohup python3 "${PROXY_SCRIPT}" "${PROXY_PORT}" >> "${PROXY_LOG}" 2>&1 &
          PROXY_PID=$!
          sleep 2
          if _proxy_healthy; then
            echo "✓ 프록시 시작됨 (PID ${PROXY_PID}, port ${PROXY_PORT})"
          else
            echo "✗ 프록시 시작 실패 — 로그: ${PROXY_LOG}"
            exit 1
          fi
        fi
        ;;
      stop)
        if pkill -f "anthropic-mlx-proxy.py" 2>/dev/null; then
          echo "✓ 프록시 중지됨"
        else
          echo "프록시 프로세스 없음"
        fi
        ;;
      restart)
        pkill -f "anthropic-mlx-proxy.py" 2>/dev/null || true
        sleep 1
        if [ ! -f "${PROXY_SCRIPT}" ]; then
          echo "✗ 프록시 스크립트 없음: ${PROXY_SCRIPT}"
          exit 1
        fi
        nohup python3 "${PROXY_SCRIPT}" "${PROXY_PORT}" >> "${PROXY_LOG}" 2>&1 &
        PROXY_PID=$!
        sleep 2
        _proxy_healthy \
          && echo "✓ 프록시 재시작됨 (PID ${PROXY_PID}, port ${PROXY_PORT})" \
          || { echo "✗ 프록시 재시작 실패 — 로그: ${PROXY_LOG}"; exit 1; }
        ;;
      logs)
        LINES="${3:-50}"
        tail -n "${LINES}" "${PROXY_LOG}" 2>/dev/null || echo "(로그 파일 없음: ${PROXY_LOG})"
        ;;
      status|"")
        if _proxy_healthy; then
          PROXY_PID=$(pgrep -f "anthropic-mlx-proxy.py" | head -1 || echo "-")
          echo "● 프록시 실행 중 (PID ${PROXY_PID}, port ${PROXY_PORT})"
        else
          echo "○ 프록시 중지됨"
        fi
        ;;
      *)
        echo "사용법: $(basename "$0") proxy {start|stop|restart|logs [N]|status}"
        exit 1
        ;;
    esac
    ;;

  help|--help|-h)
    cat <<'EOF'
사용법: mlx-ctl.sh <서브커맨드> [옵션]

서브커맨드:
  start              MLX 서버 시작 (pm2)
  stop               MLX 서버 중지
  restart            MLX 서버 재시작
  ensure             서버 비정상 시 자동 시작 (멱등)
  status             서버 + 프록시 상태 요약
  logs [N]           PM2 로그 마지막 N행 출력 (기본 50)
  models             현재 로드된 모델 목록
  use                마지막 사용 시각 갱신 (자동 슬립 타이머용)
  proxy <sub>        프록시 제어:
    proxy start        anthropic-mlx-proxy.py 시작 (port 4100)
    proxy stop         프록시 중지
    proxy restart      프록시 재시작
    proxy logs [N]     프록시 로그 출력
    proxy status       프록시 실행 여부 확인

환경변수:
  NCO_DIR            NCO 프로젝트 루트 (기본: 스크립트 위치 기준 상위 디렉터리)
  MLX_MODEL_PATH     MLX 모델 경로 오버라이드
                     (기본: ~/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit)

예시:
  mlx-ctl.sh start
  mlx-ctl.sh proxy start
  mlx-ctl.sh status
  MLX_MODEL_PATH=/path/to/model mlx-ctl.sh start
EOF
    ;;

  *)
    echo "알 수 없는 서브커맨드: ${CMD}" >&2
    echo "사용법: $(basename "$0") {start|stop|restart|ensure|status|logs [N]|models|use|proxy {start|stop|restart|logs|status}}" >&2
    exit 1
    ;;
esac
