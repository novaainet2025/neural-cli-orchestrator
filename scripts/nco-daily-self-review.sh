#!/bin/bash
# NCO 매일 10시 자가 분석·리뷰·개선 루틴
# 설치: crontab -e → 3 10 * * * /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh

set -euo pipefail
LOG="/tmp/nco-self-review-$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] NCO 자가 분석 시작" | tee "$LOG"

# 1) NCO health check
NCO_HEALTH=$(curl -s http://localhost:6200/health 2>/dev/null | python3 -c "import json,sys; h=json.load(sys.stdin); print(h.get('status','unknown'))" 2>/dev/null || echo "offline")
echo "NCO: $NCO_HEALTH" | tee -a "$LOG"

if [ "$NCO_HEALTH" != "healthy" ]; then
  echo "[SKIP] NCO offline — 자가 분석 건너뜀" | tee -a "$LOG"
  exit 0
fi

# 2) conductor 자가 분석 dispatch
TASK=$(curl -s -X POST http://localhost:6200/api/conductor \
  -H "Content-Type: application/json" \
  -d '{"prompt":"매일 자가 분석 루틴: NCO 프로바이더 상태 점검, hook 동작 검증, mesh/inter-session 연결 확인, Obsidian 문서 최신화 여부 확인, 개선 필요 항목 리스트업하여 /tmp/nco-review-report.md에 저장"}' \
  2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('taskId','failed'))" 2>/dev/null)
echo "conductor task: $TASK" | tee -a "$LOG"

# 3) provider 상태 스냅샷
curl -s http://localhost:6200/api/providers 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
online=[p['id'] for p in data.get('providers',[]) if p.get('status') in ['idle','online']]
offline=[p['id'] for p in data.get('providers',[]) if p.get('status') not in ['idle','online']]
print(f'Online: {online}')
print(f'Offline: {offline}')
" 2>/dev/null | tee -a "$LOG"

# 4) Obsidian 문서 동기화
if [ -f "$HOME/obsidian/mac-obsidian/obsidian-sync.sh" ]; then
  bash "$HOME/obsidian/mac-obsidian/obsidian-sync.sh" >> "$LOG" 2>&1 && echo "Obsidian sync: OK" | tee -a "$LOG"
else
  echo "Obsidian sync: script not found (skipped)" | tee -a "$LOG"
fi

echo "[$TIMESTAMP] 자가 분석 완료 → $LOG" | tee -a "$LOG"
