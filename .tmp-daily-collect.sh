#!/bin/bash
set -euo pipefail

echo "=== 8. inter-session/messages (first 4000 bytes) ==="
curl -sS --max-time 5 http://127.0.0.1:6200/api/inter-session/messages | head -c 4000
echo ""
echo ""
echo "=== 12. tail messages.log (last 2000 bytes) ==="
tail -c 2000 /Users/nova-ai/.claude/data/inter-session/messages.log 2>/dev/null || true
echo ""
echo ""
echo "=== 14. find Obsidian* obsidian* maxdepth 2 ==="
find /Users/nova-ai/project/nco -maxdepth 2 \( -name 'Obsidian*' -o -name 'obsidian*' \) 2>/dev/null | head -40
echo ""
echo "=== 15. improvement_notes ==="
ls -lt /Users/nova-ai/project/nco/obsidian_vault/improvement_notes/ 2>/dev/null | head -15 || echo "directory not found"
echo ""
echo "=== 16. obsidian logs ==="
ls -lt /Users/nova-ai/project/nco/logs/obsidian* 2>/dev/null | head -10 || echo "no obsidian logs"
echo ""
echo "=== 17. date; uname -a ==="
date
uname -a
