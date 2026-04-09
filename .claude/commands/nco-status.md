NCO 시스템 상태를 확인합니다.
curl -s http://localhost:6200/health | python3 -m json.tool
curl -s http://localhost:6200/api/ai-providers/status | python3 -m json.tool
