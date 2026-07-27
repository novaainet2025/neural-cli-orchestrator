#!/bin/bash
# NCO 매일 10시 자가 분석·리뷰·개선 루틴
# 설치: crontab -e → 3 10 * * * /Users/nova-ai/project/nco/scripts/nco-daily-self-review.sh

set -euo pipefail
LOG="/tmp/nco-self-review-$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] NCO 자가 분석 시작" | tee "$LOG"

# 1) NCO health check
NCO_HEALTH=$(curl -s http://localhost:6200/health 2>/dev/null | python3 -c "import json,sys; d=sys.stdin.read().strip(); h=json.loads(d) if d else {}; print(h.get('status','unknown'))" 2>/dev/null || echo "offline")
echo "NCO: $NCO_HEALTH" | tee -a "$LOG"

if [ "$NCO_HEALTH" != "healthy" ]; then
  echo "[SKIP] NCO offline — 자가 분석 건너뜀" | tee -a "$LOG"
  exit 0
fi

# 2) conductor 자가 분석 dispatch
TASK=$(curl -s -X POST http://localhost:6200/api/conductor \
  -H "Content-Type: application/json" \
  -d '{"prompt":"매일 자가 분석 루틴: NCO 프로바이더 상태 점검, hook 동작 검증, mesh/inter-session 연결 확인, Obsidian 문서 최신화 여부 확인, 개선 필요 항목 리스트업하여 /tmp/nco-review-report.md에 저장"}' \
  2>/dev/null | python3 -c "import json,sys; d=sys.stdin.read().strip(); data=json.loads(d) if d else {}; print(data.get('taskId',''))" 2>/dev/null || echo "")

echo "conductor task: $TASK" | tee -a "$LOG"

if [ -z "$TASK" ] || [ "$TASK" = "failed" ] || [ "$TASK" = "null" ]; then
  echo "[ERROR] conductor taskId 발급 실패" | tee -a "$LOG"
  exit 1
fi

# 3) provider 상태 스냅샷 (/api/agents로 변경)
curl -s http://localhost:6200/api/agents 2>/dev/null | python3 -c "
import json,sys
try:
    d=sys.stdin.read().strip()
    data=json.loads(d) if d else {}
    agents = data.get('agents', [])
    available=[p.get('id', p.get('name', 'unknown')) for p in agents if p.get('status') in ['idle','working']]
    unavailable=[p.get('id', p.get('name', 'unknown')) for p in agents if p.get('status') not in ['idle','working']]
    print(f'Online (Available): {available}')
    print(f'Offline (Unavailable): {unavailable}')
except Exception as e:
    print(f'Agent snapshot error: {e}')
" 2>/dev/null | tee -a "$LOG"

# 4) Obsidian 문서 동기화
if [ -f "$HOME/obsidian/mac-obsidian/obsidian-sync.sh" ]; then
  bash "$HOME/obsidian/mac-obsidian/obsidian-sync.sh" >> "$LOG" 2>&1 && echo "Obsidian sync: OK" | tee -a "$LOG"
else
  echo "Obsidian sync: script not found (skipped)" | tee -a "$LOG"
fi

# 5) Task completion polling (Bounded polling)
# Env override: MAX_POLLS (default 60), POLL_INTERVAL (default 10). Non-numeric → safe defaults.
MAX_POLLS="${MAX_POLLS:-60}"
case "$MAX_POLLS" in
  ''|*[!0-9]*) MAX_POLLS=60 ;;
esac
if [ "$MAX_POLLS" -eq 0 ]; then MAX_POLLS=60; fi

POLL_INTERVAL="${POLL_INTERVAL:-10}"
case "$POLL_INTERVAL" in
  ''|*[!0-9]*) POLL_INTERVAL=10 ;;
esac

POLL_COUNT=0
REPORT_FILE="/tmp/nco-review-report.md"

while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]; do
  TASK_RES=$(curl -s http://localhost:6200/api/tasks/"$TASK" 2>/dev/null || echo "{}")
  # Prefer {"task":{...}} wrapper; fall back to legacy top-level status/response/result
  TASK_STATUS=$(echo "$TASK_RES" | python3 -c "
import json,sys
try:
    d=sys.stdin.read().strip()
    data=json.loads(d) if d else {}
    t=data.get('task') if isinstance(data.get('task'), dict) else data
    print(t.get('status') or data.get('status') or 'unknown')
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown")

  if [ "$TASK_STATUS" = "completed" ]; then
    # if-파이프는 set -e 아래에서도 실패 시 else로 진입 (죽은 오류 로그 방지)
    if echo "$TASK_RES" | REPORT_FILE="$REPORT_FILE" python3 -c "
import json, os, sys, tempfile
try:
    d = sys.stdin.read().strip()
    data = json.loads(d) if d else {}
    t = data.get('task') if isinstance(data.get('task'), dict) else data
    res = t.get('response')
    if res is None or (isinstance(res, str) and not res.strip()):
        res = t.get('result')
    if res is None or (isinstance(res, str) and not res.strip()):
        res = data.get('response')
    if res is None or (isinstance(res, str) and not res.strip()):
        res = data.get('result')
    if res is None:
        sys.exit(1)
    if isinstance(res, str):
        text = res
    else:
        text = json.dumps(res, ensure_ascii=False)
    if not text.strip():
        sys.exit(1)
    report = os.environ.get('REPORT_FILE', '/tmp/nco-review-report.md')
    dirn = os.path.dirname(report) or '/tmp'
    fd, tmp = tempfile.mkstemp(prefix='nco-review-', suffix='.tmp', dir=dirn)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
        os.replace(tmp, report)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
except Exception:
    sys.exit(1)
" 2>/dev/null; then
      echo "[$TIMESTAMP] 자가 분석 완료 → $REPORT_FILE" | tee -a "$LOG"
      exit 0
    else
      echo "[ERROR] Task completed but response is empty." | tee -a "$LOG"
      exit 1
    fi
  else
    case "$TASK_STATUS" in
      failed|timed_out|cancelled)
        echo "[ERROR] Task ended with status: $TASK_STATUS" | tee -a "$LOG"
        exit 1
        ;;
    esac
  fi

  # Wait and retry
  sleep "$POLL_INTERVAL"
  POLL_COUNT=$((POLL_COUNT + 1))
done

echo "[ERROR] Task polling timed out (max $MAX_POLLS tries)." | tee -a "$LOG"
exit 1
