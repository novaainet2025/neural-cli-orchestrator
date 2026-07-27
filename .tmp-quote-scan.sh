#!/usr/bin/env bash
# Quote/hex scan + multi-bash -n for nova-voice-tts-progress.sh
set -u
F="${1:-/Users/nova-ai/.claude/hooks/nova-voice-tts-progress.sh}"
echo "file=$F"
wc -c -l "$F"
echo "--- lines 357-368 with cat -A ---"
sed -n '357,368p' "$F" | cat -A
echo "--- tail od ---"
tail -c 1800 "$F" | od -An -tx1 | tail -40
echo "--- bash -n matrix ---"
for b in bash /bin/bash /opt/homebrew/bin/bash; do
  if [ -x "$b" ] || command -v "$b" >/dev/null 2>&1; then
    ver=$("$b" --version 2>/dev/null | head -1 || echo "?")
    errf=$(mktemp)
    if "$b" -n "$F" 2>"$errf"; then
      echo "OK   $b | $ver"
    else
      echo "FAIL $b rc=$? | $ver"
      cat "$errf"
    fi
    rm -f "$errf"
  else
    echo "MISS $b"
  fi
done
echo "--- which -a ---"
which -a bash || true
