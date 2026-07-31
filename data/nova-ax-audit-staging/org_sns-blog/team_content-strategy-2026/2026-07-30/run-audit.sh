#!/bin/bash
set -euo pipefail
STAGING="/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_sns-blog/team_content-strategy-2026/2026-07-30"
DEST="/Users/nova-ai/project/nova-ax/evidence/org_sns-blog/team_content-strategy-2026/2026-07-30"
NOVA_AX="/Users/nova-ai/project/nova-ax"

mkdir -p "$DEST"
cp "$STAGING/audit-artifact.json" "$STAGING/submit-audit.mjs" "$DEST/"

echo "=== building nova-ax ==="
(cd "$NOVA_AX" && npm run build)

echo "=== running test:verification ==="
(cd "$NOVA_AX" && npm run test:verification)

LOOP_ID="${1:-}"
cd "$DEST"
if [ -n "$LOOP_ID" ]; then
  node submit-audit.mjs "$LOOP_ID"
else
  node submit-audit.mjs
fi
cat audit-result.json
