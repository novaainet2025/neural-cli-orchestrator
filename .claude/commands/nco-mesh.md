CLI Mesh — 열린 CLI 세션 간 실시간 상태 공유 및 통신 시스템입니다.

사용법:
  /nco-mesh                    — 활성 세션 목록 + 작업 요약
  /nco-mesh check <작업설명>   — 작업 시작 전 충돌/중복 검사 (필수 권장)
  /nco-mesh check <작업설명> <파일1> [파일2…] — 파일 포함 충돌 검사
  /nco-mesh send <메시지>      — 모든 활성 세션에 메시지 브로드캐스트
  /nco-mesh send @<sessionId> <메시지> — 특정 세션에 다이렉트 메시지
  /nco-mesh messages           — 내 메시지 기록 조회
  /nco-mesh ping               — heartbeat 전송 (현재 상태 등록)

$ARGUMENTS 파싱:

ACTION=$(echo "$ARGUMENTS" | cut -d' ' -f1)

# ── heartbeat 헬퍼 함수 ──────────────────────────────
send_heartbeat() {
  local WORK_MODE="$1"   # solo | mesh | waiting | reviewing | blocked
  local STATUS="$2"      # coding | reviewing | discussing | idle | thinking
  local WORK_DESC="$3"
  local FILES="$4"       # JSON 배열 문자열

  curl -s -X POST http://localhost:6200/api/mesh/heartbeat \
    -H "Content-Type: application/json" \
    -d "{
      \"sessionId\": \"${PPID}\",
      \"agentId\": \"claude-code\",
      \"pid\": ${PPID},
      \"workMode\": \"${WORK_MODE}\",
      \"status\": \"${STATUS}\",
      \"currentWork\": ${WORK_DESC},
      \"currentFiles\": ${FILES},
      \"branch\": \"$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')\"
    }" 2>/dev/null
}

case "$ACTION" in
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
      -d "{\"sessionId\":\"${PPID}\",\"agentId\":\"claude-code\",\"plannedWork\":\"$REST\",\"plannedFiles\":$FILES_JSON,\"branch\":\"$BRANCH\"}" | \
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
      -d "{\"fromSessionId\":\"${PPID}\",\"fromAgent\":\"claude-code\",\"toSessionId\":\"$TO\",\"content\":\"$MSG\"}" | python3 -m json.tool
    ;;

  messages)
    curl -s "http://localhost:6200/api/mesh/messages/${PPID}" | python3 -m json.tool
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
    echo "heartbeat 전송 완료 (workMode: $WM)"
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
