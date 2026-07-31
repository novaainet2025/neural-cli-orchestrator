#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ART="$HERE/work-report.md"
A=$(shasum -a 256 "$ART" | awk '{print $1}')
B=$(openssl dgst -sha256 "$ART" | awk '{print $NF}')
SIZE=$(stat -f%z "$ART")
MTIME=$(stat -f%Sm -t "%Y-%m-%dT%H:%M:%SZ" "$ART")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ "$A" != "$B" ]; then echo "ATTESTATION FAILED" >&2; exit 1; fi
cat > "$HERE/integrity-attestation.json" <<JSON
{
  "attestor": "shasum-openssl-cross-attestor",
  "artifactPath": "$ART",
  "observedSha256": "$A",
  "shasumSha256": "$A",
  "opensslSha256": "$B",
  "toolsAgree": true,
  "byteSize": $SIZE,
  "artifactModifiedAt": "$MTIME",
  "observedAt": "$NOW"
}
JSON
echo "OK $A ($SIZE bytes)"
