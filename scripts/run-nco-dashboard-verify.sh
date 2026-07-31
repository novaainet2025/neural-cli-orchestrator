#!/bin/bash
set -euo pipefail
cd /Users/nova-ai/project/nco-dashboard

echo "===== npm run build ====="
npm run build 2>&1
BUILD_EXIT=$?
echo "BUILD_EXIT=$BUILD_EXIT"

echo ""
echo "===== npm run test:communication ====="
npm run test:communication 2>&1
TEST_EXIT=$?
echo "TEST_EXIT=$TEST_EXIT"

echo ""
echo "===== git diff --check ====="
git diff --check 2>&1
DIFF_CHECK_EXIT=$?
echo "DIFF_CHECK_EXIT=$DIFF_CHECK_EXIT"

echo ""
echo "===== node scripts/viewport-check-temp.mjs ====="
node scripts/viewport-check-temp.mjs 2>&1
VIEWPORT_EXIT=$?
echo "VIEWPORT_EXIT=$VIEWPORT_EXIT"

echo ""
echo "===== node scripts/ui-audit.mjs (tail -20) ====="
node scripts/ui-audit.mjs --out output/playwright/audit --tag post-fix --url http://127.0.0.1:5173/ 2>&1 | tail -20
AUDIT_EXIT=${PIPESTATUS[0]}
echo "AUDIT_EXIT=$AUDIT_EXIT"

echo ""
echo "===== SUMMARY ====="
echo "BUILD_EXIT=$BUILD_EXIT"
echo "TEST_EXIT=$TEST_EXIT"
echo "DIFF_CHECK_EXIT=$DIFF_CHECK_EXIT"
echo "VIEWPORT_EXIT=$VIEWPORT_EXIT"
echo "AUDIT_EXIT=$AUDIT_EXIT"

exit 0
