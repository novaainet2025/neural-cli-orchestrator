#!/usr/bin/env python3
"""Scan hook for quote balance / non-ascii quotes; reproduce bash -n via subprocess."""
import subprocess
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/nova-ai/.claude/hooks/nova-voice-tts-progress.sh")
raw = path.read_bytes()
text = raw.decode("utf-8")
print(f"file={path}")
print(f"bytes={len(raw)} lines={text.count(chr(10))+ (0 if text.endswith(chr(10)) else 1)}")
print(f"endswith_newline={text.endswith(chr(10))}")

weird = []
for i, ch in enumerate(text):
    o = ord(ch)
    if o in (0x2018, 0x2019, 0x201C, 0x201D, 0x00B4, 0x02BC, 0xFF07) or ch == "`":
        line = text.count("\n", 0, i) + 1
        col = i - text.rfind("\n", 0, i)
        weird.append((line, col, f"U+{o:04X}", repr(ch)))
print(f"weird_quotes={len(weird)}")
for w in weird[:40]:
    print(" ", w)

# which bash
for bash in ("bash", "/bin/bash", "/opt/homebrew/bin/bash"):
    try:
        r = subprocess.run([bash, "-n", str(path)], capture_output=True, text=True)
        ver = subprocess.run([bash, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
        print(f"bash={bash!r} rc={r.returncode} ver={ver!r}")
        if r.returncode != 0:
            print(" STDERR:", (r.stderr or r.stdout)[:500])
    except FileNotFoundError:
        print(f"bash={bash!r} NOT FOUND")

# Also check PATH bash
which = subprocess.run(["which", "-a", "bash"], capture_output=True, text=True)
print("which -a bash:")
print(which.stdout)
