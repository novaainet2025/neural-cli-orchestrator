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

# ── 자연어 감지: 다양한 한국어 패턴 → "send" 액션으로 변환 ──

# 1순위: "claude-N + 조사" 패턴 (claude-3과 인사해)
if echo "$ACTION" | grep -qE '^(claude-[0-9]+|opencode|gemini|codex|aider|cursor-agent|copilot|mlx|mlx)(과|에게|한테|에|와|,)'; then
  _NL_TARGET=$(echo "$ACTION" | sed -E 's/(과|에게|한테|에|와|,)$//')
  _NL_MSG=$(echo "$ARGUMENTS" | cut -d' ' -f2-)
  ARGUMENTS="send @${_NL_TARGET} ${_NL_MSG}"
  ACTION="send"

# 2순위: "@claude-N 메시지" 패턴
elif echo "$ARGUMENTS" | grep -qE '@(claude-[0-9]+|opencode|gemini|codex|aider|cursor-agent|copilot|mlx|mlx)' && [ "$ACTION" != "send" ]; then
  ARGUMENTS="send $ARGUMENTS"
  ACTION="send"

# 3순위: 자연어 통신 의도 감지 (통신/테스트/보내/전송 + claude/mesh/세션)
elif echo "$ARGUMENTS" | grep -qiE '(통신|테스트|보내|전송|메시지).*(claude|세션|mesh)|claude.*(통신|테스트|보내|메시지)|(mesh|메시).*(테스트|진행|시작|보내)'; then
  # 대상 추출: "claude-3에게" → claude-3, 없으면 * (브로드캐스트)
  _NL_TARGET=$(echo "$ARGUMENTS" | grep -oE 'claude-[0-9]+' | head -1)
  _NL_TARGET="${_NL_TARGET:-*}"
  _NL_MSG="[mesh-test] ${MY_NAME:-claude}에서 통신 테스트"
  if [ "$_NL_TARGET" = "*" ]; then
    ARGUMENTS="send ${_NL_MSG}"
  else
    ARGUMENTS="send @${_NL_TARGET} ${_NL_MSG}"
  fi
  ACTION="send"

# 4순위: "모든/전체/다른 클로드/세션" + 작업 지시 → 브로드캐스트 태스크
elif echo "$ARGUMENTS" | grep -qiE '(모든|전체|다른|모두|전부|모든세션|전체세션|모든클|전체클|클로드들|세션들).*(해|하|진행|실행|시작|검사|점검|분석|수정|확인|보고|작업)|(해|하|진행|실행|시작).*((모든|전체|다른|모두).*클|세션)'; then
  _NL_MSG="[TASK] $ARGUMENTS"
  ARGUMENTS="send ${_NL_MSG}"
  ACTION="send"

# 5순위: 명확한 작업 지시가 포함된 텍스트 (send 없이 직접 입력) → 브로드캐스트
elif echo "$ARGUMENTS" | grep -qiE '(해줘|해봐|하세요|해주세요|하라|한다|진행해|실행해|시작해|확인해|수정해|분석해|점검해|보고해|검사해|조회해|테스트해|만들어|구현해|최적화|리팩토링|배포)' && [ "$ACTION" != "done" ] && [ "$ACTION" != "check" ] && [ "$ACTION" != "send" ] && [ "$ACTION" != "messages" ] && [ "$ACTION" != "ping" ]; then
  _NL_TARGET=$(echo "$ARGUMENTS" | grep -oE 'claude-[0-9]+' | head -1)
  if [ -n "$_NL_TARGET" ]; then
    _NL_MSG="[TASK] $(echo "$ARGUMENTS" | sed "s/${_NL_TARGET}[^ ]* *//")"
    ARGUMENTS="send @${_NL_TARGET} ${_NL_MSG}"
  else
    _NL_MSG="[TASK] $ARGUMENTS"
    ARGUMENTS="send ${_NL_MSG}"
  fi
  ACTION="send"
fi

# ── 세션 ID / 이름 결정 ──────
# UUID 기반 세션 ID (PID 충돌 방지). 동일 셸 세션 내에서는 캐시됨.
MY_NAME=""
_CK=$$
for _i in 1 2 3 4 5 6 7 8; do
  _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
  [ -z "$_CK" ] || [ "$_CK" = "1" ] && break
  for _pf in /tmp/nco-names/claude-*.pid; do
    [ -f "$_pf" ] || continue
    _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
    if [ "$_rp" = "$_CK" ]; then
      MY_NAME=$(basename "$_pf" .pid)
      break 2
    fi
  done
done
MY_NAME="${MY_NAME:-claude-code}"

# Session ID: agent name + 8-char random. Cached per shell/PPID under /tmp/nco-names.
_SID_FILE="/tmp/nco-names/${MY_NAME}-${PPID:-$$}.sid"
mkdir -p /tmp/nco-names 2>/dev/null
if [ -f "$_SID_FILE" ] && [ -n "${NCO_SESSION_ID:-}" ]; then
  MY_SESSION_ID="${NCO_SESSION_ID}"
elif [ -f "$_SID_FILE" ]; then
  MY_SESSION_ID=$(cat "$_SID_FILE" 2>/dev/null)
fi
if [ -z "${MY_SESSION_ID:-}" ]; then
  MY_SESSION_ID="${MY_NAME}-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:8])' 2>/dev/null || echo "$(date +%s)$$")"
  echo "$MY_SESSION_ID" > "$_SID_FILE" 2>/dev/null
fi
MY_PID="${PPID:-$$}"

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
      \"pid\": ${MY_PID},
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
    # JSON 이스케이프: 백슬래시(\)와 큰따옴표(")를 안전하게 처리
    MSG_ESCAPED=$(printf '%s' "$MSG" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read(),ensure_ascii=False)[1:-1])" 2>/dev/null || printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
    SEND_RESULT=$(curl -s -X POST http://localhost:6200/api/mesh/send \
      -H "Content-Type: application/json" \
      -d "{\"fromSessionId\":\"${MY_SESSION_ID}\",\"fromAgent\":\"${MY_NAME}\",\"toSessionId\":\"$TO\",\"content\":\"$MSG_ESCAPED\"}")
    DELIVERED=$(echo "$SEND_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('delivered',0))" 2>/dev/null || echo "0")
    if [ "$DELIVERED" = "0" ]; then
      echo "⚠ 메시지 전달 실패 (delivered: 0)"
      echo "  curl 응답: $SEND_RESULT"
      echo "  활성 세션: $(curl -s http://localhost:6200/api/mesh/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(s['agentId'] for s in d.get('sessions',[])))" 2>/dev/null)"
      echo "  (메시지는 DB에 저장됨 — /nco-mesh messages 로 확인 가능)"
    else
      echo "✓ 메시지 전송 완료 (${MY_NAME} → ${TO}, delivered: ${DELIVERED})"
      # ── 응답 대기: 내 pending queue 에서 응답 확인 ──
      echo ""
      echo "⏳ 응답 대기 중 (20초)..."
      _POLL_END=$(($(date +%s) + 20))
      _SHOWN=0
      while [ "$(date +%s)" -lt "$_POLL_END" ]; do
        _SHOWN=$(curl -s "http://localhost:6200/api/mesh/messages/${MY_SESSION_ID}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pending = data.get('pending', [])
    print(len(pending))
except: print(0)
" 2>/dev/null || echo "0")
        [ "$_SHOWN" -gt "0" ] && break
        sleep 1
      done
      echo ""
      echo "=== 수신 메시지 (pending: ${_SHOWN}) ==="
      curl -s "http://localhost:6200/api/mesh/messages/${MY_SESSION_ID}?drain=1" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pending = data.get('pending', [])
    shown = 0
    for m in pending:
        fr = m.get('fromAgent', m.get('from', '?'))
        content = m.get('content', '')
        print(f'  {fr}: {content[:200]}')
        shown += 1
        if shown >= 10: break
    if shown == 0:
        print('  (아직 응답 없음)')
except Exception as e:
    print(f'  조회 실패: {e}')
" 2>/dev/null
    fi
    ;;

  messages)
    curl -s "http://localhost:6200/api/mesh/messages/${MY_SESSION_ID}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
history = d.get('messages', [])
pending = d.get('pending', [])
print('=== Pending (real-time inbox) ===')
if pending:
    for m in pending:
        print(f\"  [{m.get('type','info')}] {m.get('fromAgent','?')}: {m.get('content','')[:200]}\")
else:
    print('  (없음)')
print()
print('=== History (DB, 최근 20개) ===')
if history:
    for m in history[:20]:
        print(f\"  [{m.get('created_at','?')[:19]}] {m.get('from_agent','?')} → {m.get('to_session','?')}: {(m.get('content') or '')[:150]}\")
else:
    print('  (없음)')
"
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
