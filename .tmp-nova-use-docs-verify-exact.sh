#!/usr/bin/env bash
set -euo pipefail
cd /Users/nova-ai/project/nova-use
echo "=== typecheck ==="
npm run typecheck
echo "TYPECHECK_EXIT:$?"
echo "=== hardcode scan ==="
rg -n "selected-block|demo-tx-id|demo-tx\b" src/renderer/components/docs || echo "NO_HARDCODED_BLOCKID_OR_DEMO_TX"
rg -n "\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]|Array\.from\(\s*\{\s*length:\s*5" src/renderer/components/docs || echo "NO_HARDCODED_SLIDE_LIST"
rg -n "\bas any\b|command:\s*any\b" src/renderer/components/docs/panels src/renderer/components/docs/DocsEditorShell.tsx src/renderer/components/docs/viewers/PptxViewerHost.tsx src/renderer/components/docs/docsBridge.ts src/renderer/components/docs/blockSelection.ts || echo "NO_ANY_IN_SCOPE"
