# 단일 AI에 작업을 위임합니다.
# $ARGUMENTS를 파싱하여 NCO 서버에 작업을 전달합니다.
# 형식: /nco-task <AI이름> <작업내용>
# 예: /nco-task codex auth 모듈에 JWT 검증 추가
#
# [Ollama 모드 포함 모든 환경에서 동작]
# NCO API에 직접 curl로 태스크를 생성합니다.

_ARGS="$ARGUMENTS"
AI=$(echo "$_ARGS" | cut -d' ' -f1)
PROMPT=$(echo "$_ARGS" | cut -d' ' -f2-)
NCO_URL="http://localhost:6200"

if [ -z "$AI" ] || [ -z "$PROMPT" ]; then
    echo "사용법: /nco-task <AI이름> <작업내용>"
    echo "예: /nco-task codex JWT 검증 추가"
    echo "AI 목록: opencode codex aider cursor-agent gemini copilot"
    exit 1
fi

echo "[nco-task] AI: $AI | 작업: $PROMPT"

# NCO API로 태스크 생성 및 완료 대기
RESULT=$(python3 -c "
import json, urllib.request, time, sys
ai = sys.argv[1]
prompt = sys.argv[2]
nco_url = '$NCO_URL'

# 태스크 생성
payload = json.dumps({'ai': ai, 'prompt': prompt}).encode()
req = urllib.request.Request(
    f'{nco_url}/api/task',
    data=payload,
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        task = json.loads(r.read())
    task_id = task.get('taskId') or task.get('id', '')
    if not task_id:
        print(json.dumps({'error': '태스크 ID 없음', 'response': task}))
        sys.exit(1)
    print(f'태스크 생성: {task_id}', file=sys.stderr)
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)

# 완료 대기 (최대 5분)
for _ in range(60):
    time.sleep(5)
    try:
        with urllib.request.urlopen(f'{nco_url}/api/tasks/{task_id}', timeout=5) as r:
            raw = json.loads(r.read())
        t = raw.get('task', raw)  # unwrap {"task":{...}} or use as-is
        status = t.get('status', '')
        if status == 'completed':
            print(json.dumps({'status': 'completed', 'response': t.get('response', t.get('result', ''))}))
            sys.exit(0)
        elif status in ('failed', 'error', 'cancelled'):
            print(json.dumps({'status': status, 'error': t.get('error', '')}))
            sys.exit(1)
    except Exception:
        pass
print(json.dumps({'error': '타임아웃 (5분)'}))
" "$AI" "$PROMPT" 2>/dev/null)

echo "[nco-task] 완료"
echo "$RESULT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if 'error' in d:
        print('[오류]', d['error'])
    else:
        resp = d.get('response', '')
        print(resp[:1000] if resp else '(응답 없음)')
except:
    print(sys.stdin.read()[:500])
" 2>/dev/null || echo "$RESULT" | head -c 500
