# 칸반 보드를 조회합니다.
# $ARGUMENTS가 있으면 해당 Plan ID의 보드를, 없으면 전체 보드를 표시합니다.
# 형식: /nco-kanban [planId]

curl -s "http://localhost:6200/api/kanban$([ -n '$ARGUMENTS' ] && echo '?planId=$ARGUMENTS')" | python3 -m json.tool
