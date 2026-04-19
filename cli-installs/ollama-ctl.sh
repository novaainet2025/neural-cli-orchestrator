#!/usr/bin/env bash
# Ollama 로컬 API 제어 (OpenAI 호환: http://HOST:11434/v1)
set -euo pipefail

PORT="${OLLAMA_PORT:-11434}"
HOST="${OLLAMA_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
MODEL="${OLLAMA_MODEL:-gemma4:26b}"
LAST_USE_FILE="/tmp/ollama-last-use"

case "${1:-status}" in
  start)
    command -v ollama >/dev/null 2>&1 || {
      echo "ollama CLI 없음 — https://ollama.com 에서 설치 후 PATH에 추가하세요."
      exit 1
    }
    if ! curl -fsS -o /dev/null --max-time 3 "${BASE}/api/tags" 2>/dev/null; then
      echo "Ollama API (${BASE}) 응답 없음."
      echo "  Windows: Ollama 앱 실행 · WSL에서 Windows 호스트를 쓰는 경우 OLLAMA_HOST 설정을 검토하세요."
      echo "  Linux:  ollama serve"
      exit 1
    fi
    echo "모델 pull: ${MODEL}"
    ollama pull "$MODEL"
    date +%s >"$LAST_USE_FILE"
    echo "✓ 준비됨 — OpenAI 베이스 URL: ${BASE}/v1  모델: ${MODEL}"
    ;;

  ensure)
    if curl -fsS -o /dev/null --max-time 3 "${BASE}/api/tags" 2>/dev/null; then
      ollama pull "$MODEL" 2>/dev/null || true
      date +%s >"$LAST_USE_FILE"
      exit 0
    fi
    echo "Ollama 미응답 — ${BASE} . start 전에 데몬/앱을 띄우세요."
    exit 1
    ;;

  stop)
    echo "Ollama는 보통 백그라운드 서비스로 동작합니다."
    echo "  Windows: 시스템 트레이에서 종료 또는 작업 관리자."
    echo "  Linux:   sudo systemctl stop ollama  또는  pkill ollama"
    ;;

  status)
    if curl -fsS --max-time 3 "${BASE}/api/tags" >/dev/null 2>&1; then
      echo "OK ${BASE}"
      ollama list 2>/dev/null || true
    else
      echo "offline (no response from ${BASE})"
      exit 1
    fi
    ;;

  *)
    echo "usage: $0 {start|stop|status|ensure}"
    exit 2
    ;;
esac
