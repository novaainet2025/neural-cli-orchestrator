NCO 백엔드를 시작합니다.
cd /home/nova/projects/neural-cli-orchestrator && npx tsx src/index.ts &
echo "NCO Backend starting on :6200 + :6201"
sleep 3
curl -s http://localhost:6200/health | python3 -m json.tool
