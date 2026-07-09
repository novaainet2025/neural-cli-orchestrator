#!/usr/bin/env bash

set -euo pipefail

CACHE_FILE="${HOME}/.claude/obsidian-context-cache.md"
API_URL="http://localhost:6200/api/task"

if [[ $# -lt 2 ]]; then
  echo "Usage: $(basename "$0") <ai> \"<prompt>\"" >&2
  exit 1
fi

ai_name="$1"
prompt="$2"

if [[ ! -f "${CACHE_FILE}" ]]; then
  echo "Missing cache file: ${CACHE_FILE}" >&2
  exit 1
fi

relevant_section="$(awk -v ai="${ai_name}" '
  BEGIN { IGNORECASE = 1 }
  /^## / {
    if (capture) { exit }
    capture = 0
  }
  $0 ~ ai { capture = 1 }
  capture { print }
' "${CACHE_FILE}")"

if [[ -z "${relevant_section}" ]]; then
  relevant_section="$(sed -n '1,120p' "${CACHE_FILE}")"
fi

full_prompt=$(cat <<EOF
[Obsidian Context]
${relevant_section}

[User Prompt]
${prompt}
EOF
)

payload="$(printf '%s' "${full_prompt}" | python3 -c 'import json,sys; print(json.dumps({"ai": sys.argv[1], "prompt": sys.stdin.read()}))' "${ai_name}")"

curl -sS -X POST "${API_URL}" \
  -H "Content-Type: application/json" \
  -d "${payload}"
