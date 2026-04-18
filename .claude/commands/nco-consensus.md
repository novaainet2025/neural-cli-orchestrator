# NCO 그룹 지성 협업 세션을 관리합니다 (생성, 참여, 기여, 투표, 종료).

BASE="http://localhost:6200"
ACTION="${1:-list}"

case "$ACTION" in
  create)
    # nco-collab create <title> [type]
    TITLE="${2:-협업 세션}"
    TYPE="${3:-brainstorm}"
    SESSION_ID="${NCO_SESSION_ID:-$(hostname)-$$}"
    curl -s -X POST "$BASE/api/collab/create" \
      -H "Content-Type: application/json" \
      -d "{\"creatorSessionId\":\"$SESSION_ID\",\"creatorAgentId\":\"claude-code\",\"title\":\"$TITLE\",\"type\":\"$TYPE\"}" \
      | python3 -m json.tool
    ;;
  join)
    # nco-collab join <collab-id>
    COLLAB_ID="$2"
    SESSION_ID="${NCO_SESSION_ID:-$(hostname)-$$}"
    curl -s -X POST "$BASE/api/collab/$COLLAB_ID/join" \
      -H "Content-Type: application/json" \
      -d "{\"sessionId