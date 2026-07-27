#!/bin/bash
set +e
cd /Users/nova-ai/project/nco

echo "=== CMD1: tsc ==="
npx tsc --noEmit 2>&1
echo "EXIT_CODE_1:$?"

echo "=== CMD2: git diff --check ==="
git diff --check -- src/core/organization-design-audit.ts 2>&1
echo "EXIT_CODE_2:$?"

echo "=== CMD3: git diff --stat + status ==="
git diff --stat -- src/core/organization-design-audit.ts 2>&1
echo "---STATUS---"
git status --short -- src/core/organization-design-audit.ts 2>&1
echo "EXIT_CODE_3:$?"
