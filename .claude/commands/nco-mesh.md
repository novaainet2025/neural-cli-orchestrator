CLI Mesh — 열린 CLI 세션 간 실시간 상태 공유 및 통신 시스템입니다.

사용법:
  /nco-mesh                    — 활성 세션 목록 + 작업 요약
  /nco-mesh send <메시지>      — 모든 활성 세션에 메시지 브로드캐스트
  /nco-mesh send @<sessionId> <메시지> — 특정 세션에 다이렉트 메시지
  /nco-mesh messages           — 내 메시지 기록 조회

$ARGUMENTS 파싱:

ACTION=$(echo "$ARGUMENTS" | cut -d' ' -f1)
case "$ACTION" in
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
  *)
    echo "=== Active CLI Sessions ==="
    curl -s http://localhost:6200/api/mesh/sessions | python3 -m json.tool
    echo ""
    echo "=== Work Summary ==="
    curl -s http://localhost:6200/api/mesh/summary | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','No sessions'))" 2>/dev/null
    ;;
esac
