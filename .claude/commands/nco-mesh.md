# CLI Mesh — 열린 CLI 세션 간 실시간 상태 공유 및 통신 시스템입니다.

# 사용법:
#   /nco-mesh                    — 활성 세션 목록 + 작업 요약
#   /nco-mesh done               — 현재 작업 완료 표시 (모니터에 완료로 표시됨)
#   /nco-mesh done <설명>        — 완료된 작업 설명 포함
#   /nco-mesh check <작업설명>   — 작업 시작 전 충돌/중복 검사 (필수 권장)
#   /nco-mesh check <작업설명> <파일1> [파일2…] — 파일 포함 충돌 검사
#   /nco-mesh send <메시지>      — 모든 활성 세션에 메시지 브로드캐스트
#   /nco-mesh send @<sessionId> <메시지> — 특정 세션에 다이렉트 메시지
#   /nco-mesh messages           — 내 메시지 기록 조회
#   /nco-mesh ping               — heartbeat 전송 (현재 상태 등록)

# $ARGUMENTS 파싱:

ACTION=$(echo "$ARGUMENTS" | cut -d' ' -f1)

# ── 세션 ID / 이름 결정 (등록된 값과 일치시킴) ──────────────────────
_CK=$$
for _i in 1 2 3 4 5; do
  _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
  [ -z "$_CK" ] && break
  _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
  if echo "$_CM" | grep -qE '^(claude|node)$'; then
    MY_SESSION_ID="$_CK"
    break
  fi
done
MY_SESSION_ID="${MY_SESSION_ID:-${NCO_SESSION_ID:-${PPID:-$$}}}"

# 이름 결정: NCO_NAME 환경변수를 pid 파일로 교차 검증, 불일치 시 pid 파일 우선
MY_NAME=""
if [ -n "$NCO_NAME" ]; then
  # env var의 pid 파일이 존재하고 내 SESSION_ID와 일치하는지 검증
  _env_pf="/tmp/nco-names/${NCO_NAME}.pid"
  if [ -f "$_env_pf" ]; then
    _env_pid=$(cat "$_env_pf" 2>/dev/null | tr -d '[:space:]')
    [ "$_env_pid" = "$MY_SESSION_ID" ] && MY_NAME="$NCO_NAME"
  fi
fi
# env var가 없거나 검증 실패 시 pid 파일에서 직접 조회
if [ -z "$MY_NAME" ]; then
  for _pf in /tmp/nco-names/claude-*.pid; do
    [ -f "$_pf" ] || continue
    _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
    if [ "$_rp" = "$MY_SESSION_ID" ]; then
      MY_NAME=$(basename "$_pf" .pid)
      break
    fi
  done
fi
MY_NAME="${MY_NAME:-claude-code}"

# ── heartbeat 헬퍼 함수 ──────────────────────────────
send_heartbeat() {
  local WORK_MODE="$1"   # solo | mesh | waiting | reviewing | blocked
  local STATUS="$2"      # coding | reviewing | discussing | idle | thinking
  local WORK_DESC="$3"
  local FILES="$4"       # JSON 배열 문자열

  curl -s -X POST http://localhost:6200/api/mesh/heartbeat \
    -H "Content-Type: application/json" \
    -d "{
      \"sessionId\": \"${MY_SESSION_ID}\",
      \"agentId\": \"${MY_NAME}\",
      \"pid\": ${MY_SESSION_ID},
      \"workMode\": \"${WORK_MODE}\",
      \"status\": \"${STATUS}\",
      \"currentWork\": ${WORK_DESC},
      \"currentFiles\": ${FILES},
      \"branch\": \"$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')\"
    }" 2>/dev/null
}

case "$ACTION" in
  done)
    # 작업 완료 표시 — 모니터에 "완료"로 30초 표시 후 제거
    COMPLETED_WORK=$(echo "$ARGUMENTS" | cut -d' ' -f2-)
    if [ -z "$COMPLETED_WORK" ]; then
      # 현재 heartbeat에서 작업 내용 가져오기
      COMPLETED_WORK=$(curl -s http://localhost:6200/api/mesh/sessions | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('sessions',[]):
    if str(s.get('pid',''))==str('${MY_SESSION_ID}') or str(s.get('sessionId',''))==str('${MY_SESSION_ID}'):
        print(s.get('currentWork','작업 완료'))
        break
" 2>/dev/null || echo "작업 완료")
    fi
    curl -s -X POST http://localhost:6200/api/mesh/complete \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"${MY_SESSION_ID}\",\"completedWork\":\"$COMPLETED_WORK\"}" | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print('✓ 완료 표시됨:', '$COMPLETED_WORK' if d.get('completed') else '실패')"
    ;;

  check)
    # 작업 시작 전 충돌/중복 검사
    REST=$(echo "$ARGUMENTS" | cut -d' ' -f2-)
    # 첫 번째 토큰이 파일 경로처럼 보이면 분리, 아니면 전부 작업 설명
    WORK_DESC=$(echo "$REST" | sed 's/\s*[^ ]*\.[a-zA-Z]*\s*/ /g' | xargs)
    FILES_RAW=$(echo "$REST" | grep -oE '[^ ]+\.[a-zA-Z]+' | head -10)
    FILES_JSON=$(echo "$FILES_RAW" | python3 -c "import sys; lines=[l.strip() for l in sys.stdin if l.strip()]; print('['+','.join('\"'+l+'\"' for l in lines)+']')" 2>/dev/null || echo "[]")
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    echo "=== 작업 충돌 검사 중... ==="
    echo "작업: $REST"
    echo "브랜치: $BRANCH"
    echo ""
    curl -s -X POST http://localhost:6200/api/mesh/check \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"${MY_SESSION_ID}\",\"agentId\":\"${MY_NAME}\",\"plannedWork\":\"$REST\",\"plannedFiles\":$FILES_JSON,\"branch\":\"$BRANCH\"}" | \
    python3 -c "
import sys, json
d = json.load(sys.stdin)
safe = d.get('safe', True)
reports = d.get('conflictReports', [])
recs = d.get('recommendations', [])
if safe:
    print('✓ 안전 — 충돌 없음. 작업을 시작할 수 있습니다.')
else:
    print('⚠ 주의 — 충돌/중복이 감지되었습니다!')
print()
if reports:
    print('=== 감지된 충돌 ===')
    for r in reports:
        sev = {'high':'[위험]','medium':'[주의]','low':'[참고]'}.get(r['severity'], r['severity'])
        typ = {'file':'파일충돌','task':'작업중복','branch':'브랜치근접'}.get(r['type'], r['type'])
        print(f\"{sev} {typ}: {r['detail']}\")
    print()
print('=== 권장사항 ===')
for rec in recs:
    print(f'  • {rec}')
"
    ;;

  send)
    TARGET_OR_MSG=$(echo "$ARGUMENTS" | cut -d' ' -f2-)
    if echo "$TARGET_OR_MSG" | grep -q '^@'; then
      TO=$(echo "$TARGET_OR_MSG" | cut -d' ' -f1 | sed 's/@//')
      MSG=$(echo "$TARGET_OR_MSG" | cut -d' ' -f2-)
    else
      TO="*"
      MSG="$TARGET_OR_MSG"
    fi
    curl -s -X POST http://localhost:6200/api/mesh/send \
      -H "Content-Type: application/json" \
      -d "{\"fromSessionId\":\"${MY_SESSION_ID}\",\"fromAgent\":\"${MY_NAME}\",\"toSessionId\":\"$TO\",\"content\":\"$MSG\"}" | python3 -m json.tool
    ;;

  messages)
    curl -s "http://localhost:6200/api/mesh/messages/${MY_SESSION_ID}" | python3 -m json.tool
    ;;

  ping)
    # 현재 상태를 자동 감지하여 heartbeat 전송
    ACTIVE_SESSIONS=$(curl -s http://localhost:6200/api/mesh/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['count'])" 2>/dev/null || echo "0")
    if [ "$ACTIVE_SESSIONS" -gt 1 ] 2>/dev/null; then
      WM="mesh"
      ST="discussing"
    else
      WM="solo"
      ST="coding"
    fi
    send_heartbeat "$WM" "$ST" "\"Claude Code 작업 중\"" "[]" | python3 -m json.tool
    echo "heartbeat 전송 완료 (workMode: $WM, name: $MY_NAME, sessionId: $MY_SESSION_ID)"
    ;;

  *)
    echo "=== Active CLI Sessions ==="
    curl -s http://localhost:6200/api/mesh/sessions | python3 -c "
import sys, json
data = json.load(sys.stdin)
sessions = data.get('sessions', [])
if not sessions:
    print('  활성 세션 없음')
else:
    for s in sessions:
        wm = s.get('workMode', '?')
        st = s.get('status', '?')
        work = s.get('currentWork', '')
        collab = s.get('collaborators', [])
        collab_str = ' [with: '+','.join(collab)+']' if collab else ''
        print(f\"  [{wm.upper():10}] {s['agentId']:<15} {st:<12} {work[:40]}{collab_str}\")
print(f\"총 {data['count']}개 세션\")
"
    echo ""
    echo "=== Work Summary ==="
    curl -s http://localhost:6200/api/mesh/summary | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','No sessions'))" 2>/dev/null
    ;;
esac
