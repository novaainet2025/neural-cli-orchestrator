#!/usr/bin/env bash

set -euo pipefail

VAULT_DIR="/Users/nova-ai/obsidian/mac-obsidian"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER="${SCRIPT_DIR}/obsidian-context-builder.sh"
LOG_FILE="/tmp/obsidian-watcher.log"
PID_FILE="/tmp/obsidian-watcher.pid"

if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(cat "${PID_FILE}")"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') watcher already running: ${existing_pid}" >> "${LOG_FILE}"
    exit 0
  fi
fi

echo "$$" > "${PID_FILE}"
trap 'rm -f "${PID_FILE}"' EXIT

if ! command -v fswatch >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') fswatch not found" >> "${LOG_FILE}"
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') watcher started" >> "${LOG_FILE}"

fswatch -0 "${VAULT_DIR}" | while IFS= read -r -d '' changed_path; do
  if [[ "${changed_path}" == *.md ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') changed: ${changed_path}" >> "${LOG_FILE}"
    if "${BUILDER}" >> "${LOG_FILE}" 2>&1; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') rebuild ok" >> "${LOG_FILE}"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') rebuild failed" >> "${LOG_FILE}"
    fi
  fi
done
