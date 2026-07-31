#!/bin/bash
set -uo pipefail
ROOT="/Users/nova-ai/project/크롬확장프로그램/cli-extensions"

node /Users/nova-ai/project/nco/.tmp-cli-ext-patch2.mjs
cd "$ROOT"
npm install --package-lock-only --ignore-scripts >/dev/null 2>&1

echo "=== 1 node --check run-tests.mjs ==="
node --check scripts/run-tests.mjs; echo "EXIT=$?"

echo "=== 2 node --check run-browser-tests.mjs ==="
node --check scripts/run-browser-tests.mjs; echo "EXIT=$?"

echo "=== 3 node --check verify-build.mjs ==="
node --check scripts/verify-build.mjs; echo "EXIT=$?"

echo "=== 4 npm run typecheck ==="
npm run typecheck; echo "EXIT=$?"

echo "=== 5 npm test ==="
npm test; echo "EXIT=$?"

echo "=== 6 npm run build ==="
npm run build; echo "EXIT=$?"

echo "=== 7 npm run release:check ==="
npm run release:check; echo "EXIT=$?"
