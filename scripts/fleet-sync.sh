#!/usr/bin/env bash
# Fleet sync script: updates repo and imports docs into gbrain.
set -euo pipefail

# Ensure we are at repo root
dirname=$(dirname "${BASH_SOURCE[0]}")
cd "$dirname/.."

# Pull latest changes
if command -v git >/dev/null 2>&1; then
  echo "Running git pull..."
  git pull --ff-only
else
  echo "git not available" >&2
  exit 1
fi

# Import repository into gbrain without embedding (fast)
if command -v gbrain >/dev/null 2>&1; then
  echo "Importing repository into gbrain (no embed)..."
  gbrain import --no-embed .
else
  echo "gbrain not installed; skipping import" >&2
fi
