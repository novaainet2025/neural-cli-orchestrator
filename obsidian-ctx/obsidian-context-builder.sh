#!/usr/bin/env bash

set -euo pipefail

VAULT_DIR="/Users/nova-ai/obsidian/mac-obsidian"
CACHE_FILE="${HOME}/.claude/obsidian-context-cache.md"
MASTER_CONTEXT="${VAULT_DIR}/00-SYSTEM/MASTER-CONTEXT.md"
AGENTS_DIR="${VAULT_DIR}/01-AGENTS"
PROJECTS_DIR="${VAULT_DIR}/04-CONTEXT/projects"
SESSIONS_DIR="${VAULT_DIR}/07-SESSIONS"

mkdir -p "$(dirname "${CACHE_FILE}")"

tmp_file="$(mktemp)"
trap 'rm -f "${tmp_file}"' EXIT

extract_field() {
  local file="$1"
  local pattern="$2"

  awk -F': *' -v pat="${pattern}" '
    BEGIN { IGNORECASE = 1 }
    $0 ~ "^#* *" pat ":" {
      sub("^#* *" pat ": *", "", $0)
      print
      exit
    }
  ' "${file}"
}

summarize_agent() {
  local file="$1"
  local name
  local specialty
  local invoke

  name="$(basename "${file}" .md)"
  specialty="$(extract_field "${file}" "전문영역")"
  invoke="$(extract_field "${file}" "호출방법")"

  if [[ -z "${specialty}" ]]; then
    specialty="$(grep -m1 -E '^(#|##) ' "${file}" | sed 's/^#\{1,2\} //')"
  fi
  if [[ -z "${invoke}" ]]; then
    invoke="$(grep -m1 -E '호출|invoke|usage|사용법' "${file}" || true)"
  fi

  printf -- "- 이름: %s\n" "${name}"
  printf -- "- 전문영역: %s\n" "${specialty:-미기재}"
  printf -- "- 호출방법: %s\n" "${invoke:-미기재}"
}

summarize_session() {
  local file="$1"
  local title
  local first_lines

  title="$(basename "${file}")"
  first_lines="$(sed -n '1,5p' "${file}" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"

  printf -- "- 파일: %s\n" "${title}"
  printf -- "- 요약: %s\n" "${first_lines:-내용 없음}"
}

{
  echo "# Obsidian Context Cache"
  echo
  echo "## MASTER CONTEXT"
  if [[ -f "${MASTER_CONTEXT}" ]]; then
    cat "${MASTER_CONTEXT}"
  else
    echo "파일 없음: ${MASTER_CONTEXT}"
  fi
  echo
  echo "## AGENTS SUMMARY"
  if [[ -d "${AGENTS_DIR}" ]]; then
    while IFS= read -r file; do
      echo
      summarize_agent "${file}"
    done < <(find "${AGENTS_DIR}" -type f -name '*.md' | sort)
  else
    echo "폴더 없음: ${AGENTS_DIR}"
  fi
  echo
  echo "## PROJECT CONTEXT"
  if [[ -d "${PROJECTS_DIR}" ]]; then
    while IFS= read -r file; do
      echo
      printf -- "### %s\n" "${file#${VAULT_DIR}/}"
      sed -n '1,10p' "${file}"
    done < <(find "${PROJECTS_DIR}" -type f | sort)
  else
    echo "폴더 없음: ${PROJECTS_DIR}"
  fi
  echo
  echo "## RECENT SESSIONS"
  if [[ -d "${SESSIONS_DIR}" ]]; then
    while IFS= read -r file; do
      echo
      summarize_session "${file}"
    done < <(python3 - "${SESSIONS_DIR}" <<'PY'
import os
import sys

root = sys.argv[1]
files = []
for base, _, names in os.walk(root):
    for name in names:
        if name.endswith(".md"):
            path = os.path.join(base, name)
            files.append((os.path.getmtime(path), path))

for _, path in sorted(files, reverse=True)[:5]:
    print(path)
PY
)
  else
    echo "폴더 없음: ${SESSIONS_DIR}"
  fi
  echo
  printf 'Generated at: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
} > "${tmp_file}"

mv "${tmp_file}" "${CACHE_FILE}"
