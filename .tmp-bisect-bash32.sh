#!/usr/bin/env bash
# Bisect which line range breaks /bin/bash 3.2 -n
set -u
SRC=/Users/nova-ai/.claude/hooks/nova-voice-tts-progress.sh
TMP=$(mktemp)
total=$(wc -l < "$SRC" | tr -d ' ')
echo "total_lines=$total"
# binary-ish: test prefixes
for n in 50 100 150 200 250 300 310 320 330 340 350 355 360 363 365 367 368 370 375; do
  if [ "$n" -gt "$total" ]; then continue; fi
  head -n "$n" "$SRC" > "$TMP"
  # ensure file ends reasonably; if truncated mid-construct, expect fail
  if /bin/bash -n "$TMP" 2>/tmp/bisect.err; then
    echo "PASS prefix=$n"
  else
    err=$(tr '\n' ' ' </tmp/bisect.err)
    echo "FAIL prefix=$n :: $err"
  fi
done
# also test removing specific regions: keep 1-316 + 375 only (skip TTS playback)
{
  head -n 316 "$SRC"
  echo 'exit 0'
} > "$TMP"
if /bin/bash -n "$TMP" 2>/tmp/bisect.err; then echo "PASS without TTS block (1-316+exit)"; else echo "FAIL without TTS: $(cat /tmp/bisect.err)"; fi

# keep through all_tts only (cut at line 352 exit 0 path) — replace from elif onward
{
  head -n 352 "$SRC"
  echo ')'
  echo 'exit 0'
} > "$TMP"
if /bin/bash -n "$TMP" 2>/tmp/bisect.err; then echo "PASS cut-after-all_tts"; else echo "FAIL cut-after-all_tts: $(cat /tmp/bisect.err)"; fi

rm -f "$TMP"
