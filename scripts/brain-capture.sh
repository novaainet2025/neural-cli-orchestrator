#!/usr/bin/env bash
# Wrapper for gbrain capture integration.
set -euo pipefail

if command -v gbrain >/dev/null 2>&1; then
  # Pass all arguments to gbrain capture
  gbrain capture "$@"
else
  echo "gbrain not installed; cannot capture" >&2
  exit 1
fi
