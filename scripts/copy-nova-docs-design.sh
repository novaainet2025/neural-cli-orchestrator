#!/usr/bin/env bash
set -euo pipefail
src="/Users/nova-ai/project/nco/docs/plans/nova-docs-design.md"
dst="/Users/nova-ai/project/nova-use/docs/plans/nova-docs-design.md"
mkdir -p "$(dirname "$dst")"
cp -f "$src" "$dst"
wc -l "$dst"
rg '^## ' "$dst"
