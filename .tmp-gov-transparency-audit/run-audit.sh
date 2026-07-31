#!/bin/bash
set -euo pipefail
EVIDENCE_DIR="/Users/nova-ai/project/nova-ax/evidence/gov-government-transparency/2026-07-30"
TMP_DIR="/Users/nova-ai/project/nco/.tmp-gov-transparency-audit"
mkdir -p "$EVIDENCE_DIR"
cp "$TMP_DIR/audit-artifact.json" "$EVIDENCE_DIR/"
cp "$TMP_DIR/submit-audit.mjs" "$EVIDENCE_DIR/"
cd "$EVIDENCE_DIR"
node submit-audit.mjs
echo "EXIT_CODE=$?"
