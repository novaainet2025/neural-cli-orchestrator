#!/usr/bin/env bash
set +e
cd /Users/nova-ai/project/nova-use

echo "=== officecli ==="
command -v officecli
officecli --version
echo "OFFICECLI_WHICH_EXIT:$?"

echo "=== typecheck ==="
npm run typecheck
echo "TYPECHECK_EXIT:$?"

echo "=== vitest tests/docs ==="
npx vitest run tests/docs/
echo "VITEST_EXIT:$?"

echo "=== git status (owned paths) ==="
git status --short -- src/docs/adapters tests/docs/adapters.spec.ts
git diff --stat -- src/docs/adapters tests/docs/adapters.spec.ts
