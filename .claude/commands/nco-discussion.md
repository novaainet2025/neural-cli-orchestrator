멀티 AI 토론을 시작합니다.
$ARGUMENTS를 토론 주제로 사용합니다.
형식: /nco-discussion <토론 주제>

curl -s -X POST http://localhost:6200/api/realtime/discussion \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"$ARGUMENTS\",\"mode\":\"discussion\"}" | python3 -m json.tool
