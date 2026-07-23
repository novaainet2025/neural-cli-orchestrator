#!/usr/bin/env bash
set -euo pipefail
cd /Users/nova-ai/project/nova-use
npm run typecheck
echo TYPECHECK_EXIT:$?
rg -n "from ['\"].*docs/document-core|from ['\"].*/src/docs" src/renderer/components/docs src/renderer/store/useDocsStore.ts || echo NO_SRC_DOCS_IMPORTS
rg -n "(window as any)|as unknown as" src/renderer/components/docs src/renderer/store/useDocsStore.ts || echo NO_ANY_ASSERTIONS
rg -n "demo-tx" src/renderer/components/docs || echo NO_DEMO_TX
