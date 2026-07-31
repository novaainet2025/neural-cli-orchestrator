#!/bin/bash
set -euo pipefail
REPO="/Users/nova-ai/project/크롬확장프로그램/cli-extensions"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

cp "$PATCH_DIR/debugger-controller.ts" "$REPO/extension/src/control/debugger-controller.ts"
cp "$PATCH_DIR/control-contract.mjs" "$REPO/tests/control-contract.mjs"
cp "$PATCH_DIR/enhanced-snapshot-controller.mjs" "$REPO/tests/enhanced-snapshot-controller.mjs"

if ! grep -q 'CDP_EXECUTE.*명시 허용된 읽기 전용' "$REPO/docs/security-model.md" 2>/dev/null; then
  perl -i -pe 's/(## 실행 중 강제되는 보안 게이트 \(검증됨\))/$1\n- `debugger-controller` public `CDP_EXECUTE`: prefix allowlist 없음, 명시적 읽기 전용 allowset만 허용(fail-closed). `NCO_CDP_ALLOW_UNSAFE=1` 빌드 시에만 우회./' "$REPO/docs/security-model.md"
fi

cd "$REPO"
npm --prefix extension exec -- tsc --noEmit
node tests/control-contract.mjs
node tests/enhanced-snapshot-controller.mjs
npm --prefix extension run build
echo "All verification passed"
