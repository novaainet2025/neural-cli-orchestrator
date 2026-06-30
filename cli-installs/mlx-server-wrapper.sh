#!/usr/bin/env bash
# mlx-server-wrapper.sh — signal-trapping wrapper for mlx_lm.server
# Logs exit code and signal to identify why server exits every 30s
set -uo pipefail

LOG="/tmp/mlx-exit.log"
BINARY="/Users/nova-ai/.local/bin/mlx_lm.server"
ARGS="--model /Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit --port 8000 --host 127.0.0.1 --prompt-cache-bytes 2147483648 --prompt-cache-size 4"

ts() { date '+%H:%M:%S'; }

echo "[$(ts)] wrapper start PID=$$" | tee -a "$LOG"

# Signal handler
_sig_exit() {
  echo "[$(ts)] wrapper received SIGTERM" | tee -a "$LOG"
  kill -TERM "$CHILD_PID" 2>/dev/null
}
_sig_int() {
  echo "[$(ts)] wrapper received SIGINT" | tee -a "$LOG"
  kill -INT "$CHILD_PID" 2>/dev/null
}
trap '_sig_exit' TERM
trap '_sig_int' INT

# Start server in background to capture PID
$BINARY $ARGS &
CHILD_PID=$!
echo "[$(ts)] mlx_lm.server started PID=$CHILD_PID" | tee -a "$LOG"

# Wait for child to exit
wait "$CHILD_PID"
EXIT_CODE=$?

echo "[$(ts)] mlx_lm.server EXITED PID=$CHILD_PID exit_code=$EXIT_CODE" | tee -a "$LOG"

# Decode signal
if [ $EXIT_CODE -gt 128 ]; then
  SIG=$((EXIT_CODE - 128))
  echo "[$(ts)] killed by signal $SIG ($(kill -l $SIG 2>/dev/null || echo unknown))" | tee -a "$LOG"
fi

exit $EXIT_CODE
