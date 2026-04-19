#!/usr/bin/env bash
# Mesh GC — 좀비 Mesh 세션 자동 청소 (cron용)
# crontab: */5 * * * * $HOME/project/neural-cli-orchestrator/scripts/mesh-gc.sh >> /tmp/nco-mesh-gc.log 2>&1
# macOS Apple Silicon 전용 (platform/mac)

NCO_API="${NCO_API:-http://localhost:6200}"
MESH_TTL_SECONDS="${MESH_TTL_SECONDS:-300}"  # 5분 이상 heartbeat 없으면 좀비

TS=$(date '+%Y-%m-%d %H:%M:%S')

# NCO 백엔드 alive 체크
if ! curl -s --max-time 3 "${NCO_API}/health" | grep -q '"status":"healthy"'; then
  echo "[${TS}] NCO offline — skip GC"
  exit 0
fi

# Mesh 세션 목록 조회
SESSIONS=$(curl -s --max-time 5 "${NCO_API}/api/mesh/sessions" 2>/dev/null)
if [ -z "$SESSIONS" ] || [ "$SESSIONS" = "null" ]; then
  echo "[${TS}] Mesh sessions: 없음"
  exit 0
fi

NOW=$(date +%s)
CLEANED=0

# 만료 세션 삭제
echo "$SESSIONS" | python3 -c "
import json, sys, subprocess, time

try:
    sessions = json.load(sys.stdin)
    if isinstance(sessions, dict):
        sessions = sessions.get('sessions', [])
except:
    sessions = []

now = $NOW
ttl = $MESH_TTL_SECONDS
api = '${NCO_API}'

for s in sessions:
    sid = s.get('id','')
    last_seen = s.get('last_seen', 0)
    if isinstance(last_seen, str):
        try:
            from datetime import datetime
            last_seen = int(datetime.fromisoformat(last_seen.replace('Z','+00:00')).timestamp())
        except:
            last_seen = 0
    age = now - last_seen
    if age > ttl:
        r = subprocess.run(['curl','-s','-X','DELETE',f'{api}/api/mesh/sessions/{sid}'], capture_output=True, timeout=5)
        print(f'CLEANED session={sid} age={age}s')
" 2>/dev/null

echo "[${TS}] Mesh GC done"
