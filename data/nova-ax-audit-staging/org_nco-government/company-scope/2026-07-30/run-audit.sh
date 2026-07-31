#!/bin/bash
set -euo pipefail
DIR="/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_nco-government/company-scope/2026-07-30"
cd "$DIR"
echo "=== query-state ==="
node query-state.mjs
echo "=== collect-evidence ==="
node collect-evidence.mjs
echo "=== submit-audit ==="
node submit-audit.mjs
