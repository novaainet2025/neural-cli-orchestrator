# NCO 백엔드를 중지합니다.
PID=$(pgrep -f "neural-cli-orchestrator\|nco.*index" | head -1)
[ -n "$PID" ] && kill "$PID" && echo "NCO 종료 (PID: $PID)" || echo "NCO 실행 중이지 않음"
