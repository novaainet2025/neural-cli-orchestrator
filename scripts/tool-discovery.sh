#!/bin/bash

set -u

CONFIG_PATH="${CONFIG_PATH:-/Users/nova-ai/project/nco/config/ai-providers.json}"
RUNTIME_DOC="${RUNTIME_DOC:-/Users/nova-ai/obsidian/mac-obsidian/00-SYSTEM/PROVIDER-RUNTIME.md}"
KNOWN_PATHS=("/opt/homebrew/bin" "/Users/nova-ai/.local/bin")
TOOLS=(claude gemini codex opencode cursor-agent copilot hermes hermes-nco openclaw higgsfield aider)
PROVIDERS=(openrouter mlx nvidia gemini-deep)

for extra_path in "${KNOWN_PATHS[@]}"; do
  case ":$PATH:" in
    *":$extra_path:"*) ;;
    *) PATH="$extra_path:$PATH" ;;
  esac
done
export PATH

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config not found: $CONFIG_PATH" >&2
  exit 1
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

get_realpath() {
  local target="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target" 2>/dev/null || printf '%s\n' "$target"
  else
    python3 - "$target" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
  fi
}

get_version() {
  local bin_path="$1"
  local output
  local filtered
  output="$("$bin_path" --version 2>&1 | tr '\t' ' ')" || true
  filtered="$(printf '%s\n' "$output" | sed '/^[[:space:]]*$/d' | grep -viE 'warning|error updating PATH|notopensslwarning' | head -n 1 || true)"
  filtered="$(trim "$filtered")"
  if [[ -z "$filtered" ]]; then
    filtered="$(printf '%s\n' "$output" | sed '/^[[:space:]]*$/d' | head -n 1)"
    filtered="$(trim "$filtered")"
  fi
  if [[ -z "$filtered" ]]; then
    output="unknown"
  else
    output="$filtered"
  fi
  printf '%s\n' "$output"
}

format_path_display() {
  local resolved_path="$1"
  local real_path="$2"
  if [[ "$resolved_path" == "$real_path" ]]; then
    printf '%s\n' "$real_path"
  else
    printf '%s -> %s\n' "$resolved_path" "$real_path"
  fi
}

json_get_provider_field() {
  local provider_id="$1"
  local field="$2"
  python3 - "$CONFIG_PATH" "$provider_id" "$field" <<'PY'
import json
import sys

config_path, provider_id, field = sys.argv[1:4]
with open(config_path, encoding="utf-8") as fh:
    data = json.load(fh)

for provider in data.get("providers", []):
    if provider.get("id") == provider_id:
        value = provider
        for part in field.split("."):
            if isinstance(value, dict):
                value = value.get(part)
            else:
                value = None
                break
        if value is None:
            print("")
        else:
            print(value)
        break
else:
    print("")
PY
}

update_runtime_doc() {
  local tmp_table_file="$1"
  local timestamp="$2"
  local tmp_doc

  if [[ ! -f "$RUNTIME_DOC" ]]; then
    echo "Runtime doc not found, skipping update: $RUNTIME_DOC" >&2
    return 0
  fi

  if [[ ! -w "$RUNTIME_DOC" ]]; then
    echo "Runtime doc is not writable in this environment, skipping update: $RUNTIME_DOC" >&2
    return 0
  fi

  tmp_doc="$(mktemp)"

  python3 - "$RUNTIME_DOC" "$tmp_table_file" "$timestamp" "$tmp_doc" <<'PY'
import pathlib
import re
import sys

runtime_doc, table_file, timestamp, out_file = sys.argv[1:5]
content = pathlib.Path(runtime_doc).read_text(encoding="utf-8")
table = pathlib.Path(table_file).read_text(encoding="utf-8").rstrip()

replacement = (
    "## 바이너리 위치\n\n"
    f"> 마지막 자동 스캔: {timestamp}\n\n"
    f"{table}\n"
)

pattern = r"## 바이너리 위치\n.*?(?=\n## |\Z)"
updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)

if count != 1:
    raise SystemExit("Failed to locate '## 바이너리 위치' section in runtime document")

pathlib.Path(out_file).write_text(updated, encoding="utf-8")
PY

  mv "$tmp_doc" "$RUNTIME_DOC"
}

timestamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"
tool_rows=()
missing_tool_count=0

for tool in "${TOOLS[@]}"; do
  resolved_path="$(command -v "$tool" 2>/dev/null || true)"
  if [[ -n "$resolved_path" ]]; then
    real_path="$(get_realpath "$resolved_path")"
    path_display="$(format_path_display "$resolved_path" "$real_path")"
    version="$(get_version "$resolved_path")"
    tool_rows+=("$tool|$path_display|$version|ok")
  else
    tool_rows+=("$tool|-|-|missing")
    missing_tool_count=$((missing_tool_count + 1))
  fi
done

provider_rows=()
missing_provider_count=0

for provider in "${PROVIDERS[@]}"; do
  enabled="$(json_get_provider_field "$provider" "enabled")"
  health_url="$(json_get_provider_field "$provider" "healthCheck.url")"
  timeout_ms="$(json_get_provider_field "$provider" "healthCheck.timeout")"

  if [[ "$enabled" != "True" && "$enabled" != "true" ]]; then
    provider_rows+=("$provider|disabled|skipped")
    continue
  fi

  if [[ -z "$health_url" ]]; then
    provider_rows+=("$provider|-|missing")
    missing_provider_count=$((missing_provider_count + 1))
    continue
  fi

  if [[ -z "$timeout_ms" ]]; then
    timeout_s=5
  else
    timeout_s=$(( (timeout_ms + 999) / 1000 ))
  fi

  if curl -fsS --max-time "$timeout_s" "$health_url" >/dev/null 2>&1; then
    provider_rows+=("$provider|$health_url|ok")
  else
    provider_rows+=("$provider|$health_url|missing")
    missing_provider_count=$((missing_provider_count + 1))
  fi
done

printf 'TOOL | PATH | VERSION | STATUS\n'
printf '%s\n' '---|---|---|---'
for row in "${tool_rows[@]}"; do
  IFS='|' read -r tool path version status <<<"$row"
  printf '%s | %s | %s | %s\n' "$tool" "$path" "$version" "$status"
done

printf '\nPROVIDER | HEALTH URL | STATUS\n'
printf '%s\n' '---|---|---'
for row in "${provider_rows[@]}"; do
  IFS='|' read -r provider url status <<<"$row"
  printf '%s | %s | %s\n' "$provider" "$url" "$status"
done

table_file="$(mktemp)"
{
  printf '| 에이전트 | 바이너리 경로 | 버전 | 상태 |\n'
  printf '|---------|--------------|------|------|\n'
  for row in "${tool_rows[@]}"; do
    IFS='|' read -r tool path version status <<<"$row"
    printf '| `%s` | `%s` | `%s` | `%s` |\n' "$tool" "$path" "$version" "$status"
  done
} >"$table_file"

update_runtime_doc "$table_file" "$timestamp"
rm -f "$table_file"

if [[ "$missing_provider_count" -eq 0 ]]; then
  exit 0
fi

exit 1
