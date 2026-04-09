에이전트 세션을 관리합니다.
$ARGUMENTS로 동작을 지정합니다.

사용법:
  /nco-agent start <provider> <프롬프트>  — 세션 시작
  /nco-agent list                        — 활성 세션 목록
  /nco-agent abort <sessionId>           — 세션 중단
  /nco-agent approve <sessionId>         — 도구 호출 승인
  /nco-agent reject <sessionId>          — 도구 호출 거부

예: /nco-agent start codex "테스트 코드 작성"

ACTION=$(echo $ARGUMENTS | cut -d' ' -f1)
case "$ACTION" in
  start)
    PROVIDER=$(echo $ARGUMENTS | cut -d' ' -f2)
    PROMPT=$(echo $ARGUMENTS | cut -d' ' -f3-)
    curl -s -X POST http://localhost:6200/api/agent/start \
      -H "Content-Type: application/json" \
      -d "{\"provider\":\"$PROVIDER\",\"prompt\":\"$PROMPT\"}" | python3 -m json.tool
    ;;
  list)
    curl -s http://localhost:6200/api/agent/sessions | python3 -m json.tool
    ;;
  abort|approve|reject)
    SID=$(echo $ARGUMENTS | cut -d' ' -f2)
    curl -s -X POST "http://localhost:6200/api/agent/$SID/$ACTION" \
      -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
    ;;
  *)
    echo "Unknown action: $ACTION. Use: start, list, abort, approve, reject"
    ;;
esac
