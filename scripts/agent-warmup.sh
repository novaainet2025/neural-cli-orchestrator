#!/usr/bin/env bash
# Agent Warmup — 에이전트 상태 조회 (선택적 cron용, 조회만 수행)
# macOS Apple Silicon 전용 (platform/mac)
# ⚠️ cron 등록은 선택사항 — NCO 백엔드가 이미 heartbeat 관리 중

NCO_API="${NCO_API:-http://localhost:6200}"
TS=$(date '+%Y-%m-%d %H:%M:%S')

if ! curl -s --max-time 3 "${NCO_API}/health" | grep -q '"status":"healthy"'; then
  echo "[${TS}] NCO offline"
  exit 0
fi

echo "[${TS}] Agent 상태:"
curl -s --max-time 5 "${NCO_API}/api/daemons" 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    daemons = d.get('daemons', [])
    for a in daemons:
        print(f'  {a[\"id\"]:20s} {a[\"status\"]}')
    online = sum(1 for a in daemons if a['status'] not in ['offline','error'])
    print(f'  총 online: {online}/{len(daemons)}')
except Exception as e:
    print(f'  조회 실패: {e}')
" 2>/dev/null
