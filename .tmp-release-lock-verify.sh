#!/usr/bin/env bash
set -euo pipefail
LOCK_FILE="/Users/nova-ai/project/nco/.tmp-release-lock-verify.lock"
release_lock() {
  [ "$(cat "${LOCK_FILE}" 2>/dev/null)" = "$$" ] && rm -f "${LOCK_FILE}" || true
  return 0
}
echo $$ > "${LOCK_FILE}"
release_lock
echo "after_1st exists=$([ -e "${LOCK_FILE}" ] && echo yes || echo no)"
release_lock
rc=$?
echo "after_2nd exists=$([ -e "${LOCK_FILE}" ] && echo yes || echo no) rc=${rc}"
rm -f "${LOCK_FILE}"
exit "${rc}"
