#!/bin/bash
set -uo pipefail
cd "/Users/nova-ai/project/크롬확장프로그램/cli-extensions"

echo "=== 1. node --check scripts/run-tests.mjs ==="
node --check scripts/run-tests.mjs
echo "EXIT_1=$?"

echo "=== 2. node --check scripts/run-browser-tests.mjs ==="
node --check scripts/run-browser-tests.mjs
echo "EXIT_2=$?"

echo "=== 3. node --check scripts/verify-build.mjs ==="
node --check scripts/verify-build.mjs
echo "EXIT_3=$?"

echo "=== 4. npm run typecheck ==="
npm run typecheck
echo "EXIT_4=$?"

echo "=== 5. npm test ==="
npm test
TEST_EXIT=$?
echo "EXIT_5=$TEST_EXIT"

echo "=== 6. npm run build ==="
npm run build
echo "EXIT_6=$?"

echo "=== 7. npm run release:check ==="
npm run release:check
echo "EXIT_7=$?"

# If test failed, run each test from allowlist individually
if [ "$TEST_EXIT" -ne 0 ]; then
  echo "=== INDIVIDUAL TEST RUNS ==="
  grep -oE "'tests/[^']+\.mjs'" scripts/run-tests.mjs | tr -d "'" | while read -r t; do
    echo "--- $t ---"
    node "$t"
    echo "INDIVIDUAL_EXIT_${t//\//_}=$?"
  done
fi
