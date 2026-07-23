#!/bin/bash
set -euo pipefail
cd /Users/nova-ai/project/nova-use
npm run typecheck
echo "TYPECHECK_EXIT:$?"
npx vitest run tests/docs/
echo "VITEST_EXIT:$?"
