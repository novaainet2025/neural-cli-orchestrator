#!/usr/bin/env bash
set -euo pipefail
BASE="/Users/nova-ai/project/nova-use"
mkdir -p "$BASE/src/renderer/components/docs/panels"
mkdir -p "$BASE/src/renderer/components/docs/viewers"

cat > "$BASE/src/renderer/components/docs/docsBridge.ts" << 'EOF'
import type { DocsBridge } from '../../../shared/docs-ipc'

/** Preload type guard: narrow to DocsBridge without any / double assertions. */
export function getDocsBridge(): DocsBridge | undefined {
  const nova = typeof window !== 'undefined' ? window.nova : undefined
  if (!nova || typeof nova !== 'object') return undefined
  const docs = nova.docs
  if (!docs || typeof docs !== 'object') return undefined
  if (typeof docs.commitPlan !== 'function' || typeof docs.getPreview !== 'function') {
    return undefined
  }
  return docs
}

export function isSaveAvailable(
  capabilities: { capabilities: Array<{ name: string; status: string }> },
): boolean {
  return capabilities.capabilities.some((c) => c.name === 'save' && c.status === 'available')
}
EOF

echo "WROTE docsBridge.ts"
