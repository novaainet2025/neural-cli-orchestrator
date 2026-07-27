#!/bin/bash
set -euo pipefail
echo "== bash -n =="
bash -n /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh
echo "bash -n: OK"

echo "== mock schema =="
python3 - <<'PY'
import json

def parse_agents(payload):
    data = json.loads(payload)
    agents = data.get('agents') or []
    available = [a.get('id') for a in agents if a.get('status') in ('idle','working')]
    unavailable = [a.get('id') for a in agents if a.get('status') not in ('idle','working')]
    return available, unavailable

sample = {
  "agents": [
    {"id":"codex","status":"idle"},
    {"id":"opencode","status":"working"},
    {"id":"ollama","status":"error"},
    {"id":"gemini","status":"online"},
  ]
}
av, un = parse_agents(json.dumps(sample))
assert av == ["codex","opencode"], av
assert un == ["ollama","gemini"], un
print("agents parse: PASS", av, un)

av2, un2 = parse_agents(json.dumps({"agents":[]}))
assert av2 == [] and un2 == []
print("empty agents: PASS")

def parse_task(raw):
    d=json.loads(raw)
    t=d.get('task') if isinstance(d.get('task'), dict) else d
    st=t.get('status') or ''
    resp=t.get('response')
    if resp is None: resp=t.get('result')
    err=t.get('error')
    return st, resp or '', err or ''

st,resp,err = parse_task(json.dumps({"task":{"id":"t1","status":"completed","response":"hello report","error":None}}))
assert st=="completed" and resp=="hello report"
st2,resp2,_ = parse_task(json.dumps({"taskId":"t1","status":"failed","result":"","error":"boom"}))
assert st2=="failed" and resp2==""
print("task parse: PASS")

def extract_tid(raw):
    d=json.loads(raw)
    tid=d.get('taskId')
    return tid if isinstance(tid,str) and tid.strip() else ''
assert extract_tid('{"taskId":"task_abc","status":"dispatched"}')=="task_abc"
assert extract_tid('{"error":"x"}')==""
assert extract_tid('{"taskId":""}')==""
print("taskId validate: PASS")
print("ALL MOCK SCHEMA TESTS PASS")
PY

echo "== live read-only =="
python3 - <<'PY'
import json, urllib.request
base='http://127.0.0.1:6200'
try:
  with urllib.request.urlopen(base+'/health', timeout=3) as r:
    h=json.loads(r.read().decode())
  print('live health:', h.get('status'))
  with urllib.request.urlopen(base+'/api/agents', timeout=5) as r:
    d=json.loads(r.read().decode())
  agents=d.get('agents') or []
  av=[a['id'] for a in agents if a.get('status') in ('idle','working')]
  un=[a['id'] for a in agents if a.get('status') not in ('idle','working')]
  print(f'live agents n={len(agents)}')
  print('Available:', av)
  print('Unavailable:', un)
  print('status set:', sorted({a.get('status') for a in agents}))
  with urllib.request.urlopen(base+'/api/providers', timeout=3) as r:
    p=json.loads(r.read().decode())
  print('providers:', {k:p.get(k) for k in list(p)[:4]})
except Exception as e:
  print('live probe skipped:', type(e).__name__, e)
PY

echo "== mock curl e2e =="
TMP=$(mktemp -d)
cat > "$TMP/curl" <<'EOF'
#!/bin/bash
args=("$@")
url=""
method=GET
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    -X) method="${args[$((i+1))]}" ;;
    http*) url="${args[$i]}" ;;
  esac
done
if [[ "$url" == */health ]]; then
  echo '{"status":"healthy"}'
elif [[ "$url" == */api/agents ]]; then
  echo '{"agents":[{"id":"codex","status":"idle"},{"id":"opencode","status":"working"},{"id":"ollama","status":"error"}]}'
elif [[ "$url" == */api/conductor && "$method" == "POST" ]]; then
  echo '{"taskId":"task_mock_self_review","status":"dispatched","mode":"task","providers":["codex"]}'
elif [[ "$url" == */api/tasks/task_mock_self_review/status ]]; then
  echo '{"taskId":"task_mock_self_review","status":"completed","result":"# mock self review\n- agents ok\n"}'
elif [[ "$url" == */api/tasks/task_mock_self_review ]]; then
  C="${MOCK_CURL_STATE:-/tmp/mock-curl-state}"
  n=$(cat "$C" 2>/dev/null || echo 0)
  n=$((n+1)); echo $n > "$C"
  if [ "$n" -lt 2 ]; then
    echo '{"task":{"id":"task_mock_self_review","status":"assigned","response":null,"error":null}}'
  else
    echo '{"task":{"id":"task_mock_self_review","status":"completed","response":"# mock self review\n- agents ok\n","error":null}}'
  fi
else
  echo "{\"error\":\"unexpected url $url\"}" >&2
  exit 1
fi
EOF
chmod +x "$TMP/curl"
export PATH="$TMP:$PATH"
export POLL_INTERVAL_SEC=0
export POLL_MAX_ATTEMPTS=5
export MOCK_CURL_STATE="$TMP/state"
# Isolate HOME so Obsidian sync is skipped
export HOME="$TMP/home"
mkdir -p "$HOME"
rm -f /tmp/nco-review-report.md
set +e
OUT=$(bash /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh 2>&1)
RC=$?
set -e
echo "--- mock full run exit=$RC ---"
echo "$OUT"
echo "--- report ---"
cat /tmp/nco-review-report.md 2>/dev/null || echo "(no report)"
test "$RC" -eq 0
grep -q "Available (idle/working):" <<<"$OUT"
grep -q "codex" <<<"$OUT"
grep -q "mock self review" /tmp/nco-review-report.md
grep -q "자가 분석 완료" <<<"$OUT"
echo "mock end-to-end: PASS"

echo "== mock fail path (empty response) =="
cat > "$TMP/curl" <<'EOF'
#!/bin/bash
args=("$@")
url=""; method=GET
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    -X) method="${args[$((i+1))]}" ;;
    http*) url="${args[$i]}" ;;
  esac
done
if [[ "$url" == */health ]]; then echo '{"status":"healthy"}'
elif [[ "$url" == */api/agents ]]; then echo '{"agents":[{"id":"codex","status":"idle"}]}'
elif [[ "$url" == */api/conductor ]]; then echo '{"taskId":"task_empty","status":"dispatched"}'
elif [[ "$url" == */api/tasks/task_empty* ]]; then
  echo '{"task":{"id":"task_empty","status":"completed","response":"","error":null}}'
else echo '{"error":"bad"}'; exit 1; fi
EOF
chmod +x "$TMP/curl"
export MOCK_CURL_STATE="$TMP/state2"
set +e
OUT2=$(bash /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh 2>&1)
RC2=$?
set -e
echo "empty-response exit=$RC2"
echo "$OUT2" | tail -8
test "$RC2" -eq 1
grep -q "response empty" <<<"$OUT2"
echo "empty-response fail path: PASS"

echo "== mock missing taskId =="
cat > "$TMP/curl" <<'EOF'
#!/bin/bash
args=("$@"); url=""
for a in "${args[@]}"; do [[ "$a" == http* ]] && url=$a; done
if [[ "$url" == */health ]]; then echo '{"status":"healthy"}'
elif [[ "$url" == */api/conductor ]]; then echo '{"error":"insufficient_available_providers"}'
else echo '{}'; fi
EOF
chmod +x "$TMP/curl"
set +e
OUT3=$(bash /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh 2>&1)
RC3=$?
set -e
echo "missing-taskId exit=$RC3"
echo "$OUT3" | tail -6
test "$RC3" -eq 1
grep -q "taskId missing" <<<"$OUT3"
echo "missing-taskId fail path: PASS"

echo "== ALL VERIFY PASS =="
