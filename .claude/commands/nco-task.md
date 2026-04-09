단일 AI에 작업을 위임합니다.
$ARGUMENTS를 파싱하여 NCO 서버에 작업을 전달합니다.
형식: /nco-task <AI이름> <작업내용>
예: /nco-task codex "auth 모듈에 JWT 검증 추가"

curl -s -X POST http://localhost:6200/api/task \
  -H "Content-Type: application/json" \
  -d "{\"ai\":\"$(echo $ARGUMENTS | cut -d' ' -f1)\",\"prompt\":\"$(echo $ARGUMENTS | cut -d' ' -f2-)\"}" | python3 -m json.tool
