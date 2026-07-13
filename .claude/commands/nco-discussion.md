# 멀티 AI 토론을 시작합니다.
# $ARGUMENTS를 토론 주제로 사용합니다.
# 형식: /nco-discussion <토론 주제>
#
# 2026-07-09 수정(claude-1 발견): 과거 nco-discussion (미완성 스텁) 이슈 수정.
# nco-team.md의 검증된 curl 패턴을 적용해 실제 POST /api/discussion 으로 전송.
# 서버 스키마(DiscussionRouteBodySchema)에 맞춰 prompt 대신 topic 필드 사용.

TOPIC="$ARGUMENTS"

if [ -z "$TOPIC" ]; then
  echo "[오류] 형식: /nco-discussion <토론 주제>  예: /nco-discussion API 설계 REST vs GraphQL"
else
  jq -n --arg topic "$TOPIC" '{"topic":$topic}' \
    | curl -s -X POST http://localhost:6200/api/discussion \
        -H "Content-Type: application/json" \
        --data-binary @- \
    | python3 -m json.tool 2>/dev/null || echo "[오류] NCO 서버 응답 없음 — /nco-start 로 NCO를 먼저 시작하세요."
fi
