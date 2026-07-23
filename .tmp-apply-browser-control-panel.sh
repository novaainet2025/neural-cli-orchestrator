#!/usr/bin/env bash
# Apply BrowserControlPanel v2 cockpit rewrite into nova-use.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/.tmp-BrowserControlPanel-v2.tsx"
DST="/Users/nova-ai/project/nova-use/src/renderer/components/browser/BrowserControlPanel.tsx"
if [[ ! -f "$SRC" ]]; then
  echo "missing source: $SRC" >&2
  exit 1
fi
cp "$SRC" "$DST"
echo "applied -> $DST"
cd /Users/nova-ai/project/nova-use
npm run typecheck
