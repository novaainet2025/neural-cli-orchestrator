#!/usr/bin/env bash
# /nco-ollama 슬래시 명령 본체 (ARGUMENTS 환경변수 사용)

CTL="/home/nova/projects/neural-cli-orchestrator/cli-installs/ollama-ctl.sh"
PROXY_CTL="/home/nova/projects/neural-cli-orchestrator/cli-installs/vllm-proxy.sh"

PORT="${OLLAMA_PORT:-11434}"
HOST="${OLLAMA_HOST:-127.0.0.1}"
OLLAMA_API="http://${HOST}:${PORT}"
V1_API="${OLLAMA_API}/v1"
LOG="${OLLAMA_LOG:-/tmp/ollama-nco.log}"
NCO_API="${NCO_API:-http://localhost:6200}"
CONFIG_FILE="/home/nova/projects/neural-cli-orchestrator/config/ai-providers.json"

ACTION=$(echo "${ARGUMENTS:-}" | cut -d' ' -f1)
ARG2=$(echo "${ARGUMENTS:-}" | cut -d' ' -f2)
ARG3=$(echo "${ARGUMENTS:-}" | cut -d' ' -f3-)
REST=$(echo "${ARGUMENTS:-}" | cut -d' ' -f2-)

[ -z "$ACTION" ] && ACTION="status"

_api_ok() {
  curl -fsS -o /dev/null --max-time 3 "${OLLAMA_API}/api/tags" 2>/dev/null
}

case "$ACTION" in
  status)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Ollama 로컬 LLM (${OLLAMA_MODEL:-gemma4:26b})"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if _api_ok; then
      CODE=$(curl -s -o /dev/null -w "%{http_code}" "${OLLAMA_API}/api/tags" 2>/dev/null || echo 000)
      echo "  ● API     : 응답 OK (HTTP ${CODE})"
      ollama ps 2>/dev/null | sed 's/^/  /' || true
      nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s\n  GPU 사용률: %s\n  온도      : %s\n", $1,$2,$3,$4,$5}' || true
      if [ -f "/tmp/ollama-last-use" ]; then
        LAST=$(cat /tmp/ollama-last-use)
        NOW=$(date +%s)
        IDLE=$(( (NOW - LAST) / 60 ))
        echo "  마지막 NCO pull: ${IDLE}분 전 (대략)"
      fi
    else
      echo "  ○ Ollama API 응답 없음 (${OLLAMA_API})"
      nvidia-smi --query-gpu=name,memory.used,memory.total \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s\n", $1,$2,$3}' || true
    fi
    echo "  OpenAI 호환: ${V1_API}"
    echo "  참고 로그  : ${LOG}"
    if pgrep -f "vllm-proxy" >/dev/null 2>&1; then
      echo "  Anthropic프록시: ● (vllm-proxy 스크립트 이름 유지, 업스트림은 Ollama로 설정)"
    else
      echo "  Anthropic프록시: ○"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  start)
    echo "Ollama 모델 준비 중 (pull)..."
    bash "$CTL" start
    ;;

  stop)
    bash "$CTL" stop
    ;;

  restart)
    bash "$CTL" stop
    sleep 2
    bash "$CTL" start
    ;;

  ensure)
    bash "$CTL" ensure
    ;;

  logs)
    LINES=${ARG2:-50}
    echo "━━━ Ollama 관련 로그 (최근 ${LINES}줄, 파일이 있을 때만) ━━━"
    if [ -f "$LOG" ]; then
      tail -n "$LINES" "$LOG"
    else
      echo "로컬 파일 없음: $LOG"
      echo "Windows Ollama 로그는 사용자 AppData\\Local\\Ollama\\logs 등을 확인하세요."
    fi
    ;;

  models)
    echo "━━━ /v1/models (OpenAI 호환) ━━━"
    RESULT=$(curl -s "${V1_API}/models" 2>/dev/null)
    if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  • {m[\"id\"]}') for m in d.get('data',[])]" 2>/dev/null; then
      :
    else
      echo "  Ollama 미실행 또는 응답 없음"
      echo "  → ollama 앱/데몬 실행 후 /nco-ollama start"
    fi
    ;;

  test)
    echo "━━━ Ollama 추론 테스트 ━━━"
    MODEL=$(curl -s "${V1_API}/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
    if [ -z "$MODEL" ]; then
      echo "  ✗ API 미응답. ollama 실행 후 /nco-ollama start"
      exit 1
    fi
    echo "  모델: $MODEL"
    curl -s -X POST "${V1_API}/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [{\"role\": \"user\", \"content\": \"안녕하세요, 자기소개를 해주세요. 한 문장으로 답해주세요.\"}],
        \"max_tokens\": 100,
        \"temperature\": 0.7
      }" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'choices' in d:
    print('  응답:', d['choices'][0]['message']['content'].strip())
    usage = d.get('usage', {})
    print(f'  토큰: 입력 {usage.get(\"prompt_tokens\",0)} + 출력 {usage.get(\"completion_tokens\",0)} = 총 {usage.get(\"total_tokens\",0)}')
else:
    print('  오류:', json.dumps(d, ensure_ascii=False))
"
    ;;

  chat)
    PROMPT="$REST"
    if [ -z "$PROMPT" ]; then
      echo "사용법: /nco-ollama chat <프롬프트>"
      exit 1
    fi
    MODEL=$(curl -s "${V1_API}/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
    if [ -z "$MODEL" ]; then
      echo "  ✗ API 미응답."
      exit 1
    fi
    echo "━━━ Ollama 채팅 ━━━"
    echo "  모델: $MODEL"
    ESCAPED=$(echo "$PROMPT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
    curl -s -X POST "${V1_API}/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [{\"role\": \"user\", \"content\": $ESCAPED}],
        \"max_tokens\": 512,
        \"temperature\": 0.7
      }" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'choices' in d:
    print(d['choices'][0]['message']['content'].strip())
else:
    print('오류:', json.dumps(d, ensure_ascii=False))
"
    ;;

  config)
    echo "━━━ Ollama 프로바이더 (NCO) ━━━"
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'ollama':
        print(f'  ID        : {p[\"id\"]}')
        print(f'  이름      : {p[\"name\"]}')
        print(f'  활성화    : {\"예\" if p.get(\"enabled\") else \"아니오\"}')
        print(f'  역할      : {p[\"role\"]}')
        print(f'  엔드포인트: {p.get(\"endpoint\",\"-\")}')
        print(f'  모델      : {p.get(\"model\",\"-\")}')
        ms = p.get('modelSpec', {})
        for k in ('name','parameters','quantization','gpu','vram','maxModelLen'):
            if ms.get(k):
                print(f'    {k}: {ms.get(k)}')
" 2>/dev/null || echo "  설정 파일을 읽을 수 없습니다: $CONFIG_FILE"
    ;;

  metrics)
    echo "━━━ GPU / VRAM (Ollama는 Prometheus /metrics 미제공) ━━━"
    nvidia-smi --query-gpu=name,memory.used,memory.free,memory.total,utilization.gpu \
      --format=csv,noheader 2>/dev/null | \
      awk -F', ' '{printf "  %s | used %s | free %s | total %s | util %s\n", $1,$2,$3,$4,$5}'
    ollama ps 2>/dev/null || true
    ;;

  proxy)
    SUB=$ARG2
    case "$SUB" in
      start)
        IDLE=${ARG3:-5}
        if pgrep -f "vllm-proxy" >/dev/null 2>&1; then
          echo "프록시 이미 실행 중 (PID: $(pgrep -f vllm-proxy | head -1))"
        else
          nohup bash "$PROXY_CTL" "$IDLE" >/tmp/vllm-proxy.log 2>&1 &
          echo "프록시 시작 (PID: $!) — 업스트림은 VLLM_BASE_URL=http://127.0.0.1:11434 로 설정하세요."
        fi
        ;;
      stop)
        if pgrep -f "vllm-proxy" >/dev/null 2>&1; then
          pkill -f "vllm-proxy"
          echo "프록시 종료됨"
        else
          echo "실행 중인 프록시 없음"
        fi
        ;;
      status|"")
        if pgrep -f "vllm-proxy" >/dev/null 2>&1; then
          echo "● 프록시 실행 중 (PID: $(pgrep -f vllm-proxy | head -1))"
        else
          echo "○ 프록시 중지됨"
        fi
        ;;
      *)
        echo "사용법: /nco-ollama proxy {start [분]|stop|status}"
        ;;
    esac
    ;;

  set-idle)
    MINUTES=$ARG2
    if [ -z "$MINUTES" ] || ! echo "$MINUTES" | grep -qE '^[0-9]+$'; then
      echo "사용법: /nco-ollama set-idle <분>"
      exit 1
    fi
    if pgrep -f "vllm-proxy" >/dev/null 2>&1; then
      pkill -f "vllm-proxy"
      sleep 1
      nohup bash "$PROXY_CTL" "$MINUTES" >/tmp/vllm-proxy.log 2>&1 &
      echo "프록시 재시작: 유휴 ${MINUTES}분"
    else
      echo "프록시 미실행 — /nco-ollama proxy start $MINUTES"
    fi
    ;;

  enable)
    python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'ollama':
        p['enabled'] = True
with open('$CONFIG_FILE', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('✓ ollama 프로바이더 활성화 — NCO 재시작 권장')
"
    ;;

  disable)
    python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'ollama':
        p['enabled'] = False
with open('$CONFIG_FILE', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('○ ollama 프로바이더 비활성화 — NCO 재시작 권장')
"
    ;;

  *)
    echo "알 수 없는 명령: $ACTION"
    echo "  status, start, stop, restart, ensure, logs, models, test, chat, config, metrics"
    echo "  proxy {start|stop|status}, set-idle, enable, disable"
    ;;
esac
