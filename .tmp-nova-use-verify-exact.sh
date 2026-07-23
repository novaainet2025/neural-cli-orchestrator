#!/usr/bin/env bash
cd /Users/nova-ai/project/nova-use && npm run typecheck; echo TYPECHECK_EXIT:$?
cd /Users/nova-ai/project/nova-use && rg -n "from ['\"].*docs/document-core|from ['\"]\.\./\.\./\.\./\.\./docs/|from ['\"].*/src/docs" src/renderer/components/docs src/renderer/store/useDocsStore.ts || true
cd /Users/nova-ai/project/nova-use && rg -n "(window as any)|as unknown as" src/renderer/components/docs src/renderer/store/useDocsStore.ts || true
