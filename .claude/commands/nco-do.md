Plan을 실행합니다. 칸반 태스크를 순차/병렬로 에이전트에게 위임합니다.
$ARGUMENTS를 Plan ID로 사용합니다.
형식: /nco-do <planId> [sequential|parallel|auto]

curl -s -X POST http://localhost:6200/api/plan/execute \
  -H "Content-Type: application/json" \
  -d "{\"planId\":\"$(echo $ARGUMENTS | cut -d' ' -f1)\",\"strategy\":\"$(echo $ARGUMENTS | cut -d' ' -f2-)\"}" | python3 -m json.tool
