vLLM 로컬 서버를 관리합니다 (시작/중지/상태/테스트/설정 등).

사용법:
  /nco-vllm                          — 현재 상태 확인 (기본)
  /nco-vllm status                   — 상세 상태 + VRAM 사용량
  /nco-vllm start                    — vLLM 서버 시작
  /nco-vllm stop                     — vLLM 서버 중지 (VRAM 해제)
  /nco-vllm restart                  — 재시작
  /nco-vllm ensure                   — 실행 중이면 유지, 아니면 자동 시작
  /nco-vllm logs [줄수]              — 서버 로그 출력 (기본 50줄)
  /nco-vllm models                   — 로드된 모델 목록
  /nco-vllm test                     — 추론 동작 테스트
  /nco-vllm chat <프롬프트>          — 직접 채팅 (단발성 추론)
  /nco-vllm config                   — 현재 vLLM 설정 출력
  /nco-vllm metrics                  — 성능 지표 (처리량, 지연 등)
  /nco-vllm proxy start [분]         — 자동 관리 프록시 시작 (기본 5분 미사용 시 종료)
  /nco-vllm proxy stop               — 프록시 종료
  /nco-vllm proxy status             — 프록시 실행 여부 확인
  /nco-vllm set-idle <분>            — 자동 종료 대기 시간 변경
  /nco-vllm enable                   — NCO 프로바이더 활성화
  /nco-vllm disable                  — NCO 프로바이더 비활성화

예:
  /nco-vllm start
  /nco-vllm chat "한국어로 안녕하세요를 영어로 번역해줘"
  /nco-vllm logs 100
  /nco-vllm proxy start 10

CTL="/home/nova/projects/neural-cli-orchestrator/cli-installs/vllm-ctl.sh"
PROXY_CTL="/home/nova/projects/neural-cli-orchestrator/cli-installs/vllm-proxy.sh"
PORT=8000
LOG="/tmp/vllm-server.log"
NCO_API="http://localhost:6200"
VLLM_API="http://localhost:${PORT}/v1"
CONFIG_FILE="/home/nova/projects/neural-cli-orchestrator/config/ai-providers.json"

ACTION=$(echo $ARGUMENTS | cut -d' ' -f1)
ARG2=$(echo $ARGUMENTS | cut -d' ' -f2)
ARG3=$(echo $ARGUMENTS | cut -d' ' -f3-)
REST=$(echo $ARGUMENTS | cut -d' ' -f2-)

# 기본값: 인수 없으면 status
[ -z "$ACTION" ] && ACTION="status"

case "$ACTION" in
  status)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  vLLM 서버 상태"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
      PID=$(pgrep -f "vllm.entrypoints" | head -1)
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        echo "  ● 상태    : 실행 중 (PID: $PID)"
        echo "  ✓ 헬스    : 정상 (HTTP $HEALTH)"
      else
        echo "  ◑ 상태    : 시작 중 (PID: $PID, HTTP: $HEALTH)"
      fi
      nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s\n  GPU 사용률: %s\n  온도      : %s\n", $1,$2,$3,$4,$5}'
      UPTIME=$(ps -o etime= -p $PID 2>/dev/null | xargs)
      [ -n "$UPTIME" ] && echo "  업타임    : $UPTIME"
      if [ -f "/tmp/vllm-last-use" ]; then
        LAST=$(cat /tmp/vllm-last-use)
        NOW=$(date +%s)
        IDLE=$(( (NOW - LAST) / 60 ))
        echo "  마지막 사용: ${IDLE}분 전"
      fi
    else
      echo "  ○ 상태    : 중지됨"
      nvidia-smi --query-gpu=name,memory.used,memory.total \
        --format=csv,noheader 2>/dev/null | \
        awk -F', ' '{printf "  GPU       : %s\n  VRAM      : %s / %s (미사용)\n", $1,$2,$3}'
    fi
    echo "  엔드포인트: http://localhost:${PORT}/v1"
    echo "  로그 파일  : $LOG"
    if pgrep -f "vllm-proxy" > /dev/null 2>&1; then
      echo "  프록시    : ● 실행 중 (자동 관리)"
    else
      echo "  프록시    : ○ 중지됨"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  start)
    echo "vLLM 서버 시작 중..."
    bash "$CTL" start
    ;;

  stop)
    echo "vLLM 서버 중지 중..."
    bash "$CTL" stop
    ;;

  restart)
    echo "vLLM 서버 재시작 중..."
    bash "$CTL" stop
    sleep 3
    bash "$CTL" start
    ;;

  ensure)
    bash "$CTL" ensure
    ;;

  logs)
    LINES=${ARG2:-50}
    echo "━━━ vLLM 로그 (최근 ${LINES}줄) ━━━"
    if [ -f "$LOG" ]; then
      tail -n "$LINES" "$LOG"
    else
      echo "로그 파일 없음: $LOG"
    fi
    ;;

  models)
    echo "━━━ 로드된 모델 목록 ━━━"
    RESULT=$(curl -s "${VLLM_API}/models" 2>/dev/null)
    if [ $? -eq 0 ] && echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  • {m[\"id\"]}') for m in d.get('data',[])]" 2>/dev/null; then
      :
    else
      echo "  vLLM 서버 미실행 또는 응답 없음"
      echo "  → /nco-vllm start 으로 시작하세요"
    fi
    ;;

  test)
    echo "━━━ vLLM 추론 테스트 ━━━"
    MODEL=$(curl -s "${VLLM_API}/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
    if [ -z "$MODEL" ]; then
      echo "  ✗ 서버 미실행. /nco-vllm start 후 다시 시도하세요."
      exit 1
    fi
    echo "  모델: $MODEL"
    echo "  프롬프트: '안녕하세요, 자기소개를 해주세요.' (한 문장)"
    echo ""
    curl -s -X POST "${VLLM_API}/chat/completions" \
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
      echo "사용법: /nco-vllm chat <프롬프트>"
      exit 1
    fi
    MODEL=$(curl -s "${VLLM_API}/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
    if [ -z "$MODEL" ]; then
      echo "  ✗ 서버 미실행. /nco-vllm start 후 다시 시도하세요."
      exit 1
    fi
    echo "━━━ vLLM 채팅 ━━━"
    echo "  모델: $MODEL"
    echo "  프롬프트: $PROMPT"
    echo ""
    ESCAPED=$(echo "$PROMPT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))")
    curl -s -X POST "${VLLM_API}/chat/completions" \
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
    print()
    usage = d.get('usage', {})
    print(f'[토큰: 입력 {usage.get(\"prompt_tokens\",0)} + 출력 {usage.get(\"completion_tokens\",0)}]')
else:
    print('오류:', json.dumps(d, ensure_ascii=False))
"
    ;;

  config)
    echo "━━━ vLLM 설정 ━━━"
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'vllm':
        print(f'  ID        : {p[\"id\"]}')
        print(f'  이름      : {p[\"name\"]}')
        print(f'  활성화    : {\"예\" if p.get(\"enabled\") else \"아니오\"}')
        print(f'  역할      : {p[\"role\"]}')
        print(f'  점수      : {p[\"score\"]}점')
        print(f'  비용      : {p[\"cost\"]}')
        print(f'  엔드포인트: {p[\"endpoint\"]}')
        print(f'  모델      : {p[\"model\"]}')
        ms = p.get('modelSpec', {})
        print(f'  모델 스펙  :')
        print(f'    이름    : {ms.get(\"name\",\"-\")}')
        print(f'    파라미터: {ms.get(\"parameters\",\"-\")}')
        print(f'    양자화  : {ms.get(\"quantization\",\"-\")}')
        print(f'    GPU     : {ms.get(\"gpu\",\"-\")}')
        print(f'    VRAM    : {ms.get(\"vram\",\"-\")}')
        print(f'    최대길이: {ms.get(\"maxModelLen\",\"-\")} 토큰')
        print(f'  동시 요청 : {p.get(\"concurrency\",1)}')
        print(f'  RPM 한도  : {p.get(\"rateLimitRpm\",5)}')
        caps = p.get('capabilities', [])
        print(f'  기능      : {\" | \".join(caps)}')
" 2>/dev/null || echo "  설정 파일을 읽을 수 없습니다: $CONFIG_FILE"
    ;;

  metrics)
    echo "━━━ vLLM 성능 지표 ━━━"
    METRICS=$(curl -s "http://localhost:${PORT}/metrics" 2>/dev/null)
    if [ -z "$METRICS" ]; then
      echo "  vLLM 서버 미실행 또는 /metrics 엔드포인트 미지원"
    else
      echo "$METRICS" | grep -E "^(vllm|#)" | grep -v "^# HELP" | head -40 | \
        sed 's/vllm://g' | \
        awk '{printf "  %-50s %s\n", $1, $2}'
    fi
    echo ""
    echo "  VRAM 현황:"
    nvidia-smi --query-gpu=memory.used,memory.free,memory.total,utilization.gpu \
      --format=csv,noheader 2>/dev/null | \
      awk -F', ' '{printf "    사용: %s | 여유: %s | 전체: %s | GPU: %s\n", $1,$2,$3,$4}'
    ;;

  proxy)
    SUB=$ARG2
    case "$SUB" in
      start)
        IDLE=${ARG3:-5}
        if pgrep -f "vllm-proxy" > /dev/null 2>&1; then
          echo "프록시 이미 실행 중 (PID: $(pgrep -f vllm-proxy))"
        else
          nohup bash "$PROXY_CTL" "$IDLE" > /tmp/vllm-proxy.log 2>&1 &
          echo "vLLM 자동 관리 프록시 시작 (${IDLE}분 미사용 시 자동 종료, PID: $!)"
        fi
        ;;
      stop)
        if pgrep -f "vllm-proxy" > /dev/null 2>&1; then
          pkill -f "vllm-proxy"
          echo "프록시 종료됨"
        else
          echo "실행 중인 프록시 없음"
        fi
        ;;
      status|"")
        if pgrep -f "vllm-proxy" > /dev/null 2>&1; then
          PID=$(pgrep -f "vllm-proxy" | head -1)
          echo "● 프록시 실행 중 (PID: $PID)"
          if [ -f "/tmp/vllm-proxy.log" ]; then
            echo "  최근 로그:"
            tail -5 /tmp/vllm-proxy.log | sed 's/^/    /'
          fi
        else
          echo "○ 프록시 중지됨"
          echo "  → /nco-vllm proxy start [분] 으로 시작하세요"
        fi
        ;;
      *)
        echo "사용법: /nco-vllm proxy {start [분]|stop|status}"
        ;;
    esac
    ;;

  set-idle)
    MINUTES=$ARG2
    if [ -z "$MINUTES" ] || ! echo "$MINUTES" | grep -qE '^[0-9]+$'; then
      echo "사용법: /nco-vllm set-idle <분>"
      echo "예: /nco-vllm set-idle 10"
      exit 1
    fi
    if pgrep -f "vllm-proxy" > /dev/null 2>&1; then
      pkill -f "vllm-proxy"
      sleep 1
      nohup bash "$PROXY_CTL" "$MINUTES" > /tmp/vllm-proxy.log 2>&1 &
      echo "프록시 재시작: 미사용 자동 종료 시간 → ${MINUTES}분 (PID: $!)"
    else
      echo "프록시가 실행 중이지 않습니다. /nco-vllm proxy start $MINUTES 로 시작하세요."
    fi
    ;;

  enable)
    python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'vllm':
        p['enabled'] = True
with open('$CONFIG_FILE', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('✓ vLLM 프로바이더 활성화됨')
print('  NCO 서버 재시작 필요: /nco-start')
" 2>/dev/null || echo "설정 파일 변경 실패"
    ;;

  disable)
    python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    d = json.load(f)
for p in d.get('providers', []):
    if p['id'] == 'vllm':
        p['enabled'] = False
with open('$CONFIG_FILE', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('○ vLLM 프로바이더 비활성화됨')
print('  NCO 서버 재시작 필요: /nco-start')
" 2>/dev/null || echo "설정 파일 변경 실패"
    ;;

  *)
    echo "알 수 없는 명령: $ACTION"
    echo ""
    echo "사용 가능한 명령:"
    echo "  status, start, stop, restart, ensure"
    echo "  logs [줄수], models, test, chat <프롬프트>"
    echo "  config, metrics"
    echo "  proxy {start [분]|stop|status}"
    echo "  set-idle <분>, enable, disable"
    ;;
esac
