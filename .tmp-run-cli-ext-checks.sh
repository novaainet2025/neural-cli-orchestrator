#!/bin/bash
set -uo pipefail
ROOT="/Users/nova-ai/project/크롬확장프로그램/cli-extensions"

apply_patch() {
  node /Users/nova-ai/project/nco/.tmp-cli-ext-patch.mjs
}

apply_patch
cd "$ROOT"
npm install --package-lock-only --ignore-scripts >/dev/null 2>&1 || true

echo "=== node --check ==="
node --check scripts/run-tests.mjs scripts/run-browser-tests.mjs scripts/verify-build.mjs
echo "CHECK=$?"

apply_patch
echo "=== typecheck ==="
npm run typecheck
echo "TYPECHECK=$?"

apply_patch
echo "=== test ==="
NCO_TEST_MAX_ATTEMPTS=5 npm test
echo "TEST=$?"

apply_patch
echo "=== build ==="
npm run build
echo "BUILD=$?"

apply_patch
echo "=== release:check ==="
grep release:check package.json
NCO_TEST_MAX_ATTEMPTS=5 npm run release:check
echo "RELEASE=$?"
