#!/bin/bash
cd "/Users/nova-ai/project/크롬확장프로그램/cli-extensions"
for t in tests/pty-kill-escalation.mjs tests/bridge-resume.mjs; do
  echo "=== $t ==="
  node "$t" && echo OK || echo FAIL
done
