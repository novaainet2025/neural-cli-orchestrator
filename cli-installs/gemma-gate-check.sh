#!/usr/bin/env bash
# Gemma/claude-gemma 파이프라인용 수치 게이트 — LLM 장문 대신 스크립트로 토큰 절약
# 사용: gemma-gate-check.sh [프로젝트루트] [--plan path/to/plan.md] [--json]

set -euo pipefail

ROOT="$(pwd)"
if [[ $# -gt 0 && "${1:-}" != --* ]]; then
  ROOT="$(cd "$1" && pwd)"
  shift
fi

PLAN_FILE=""
JSON_OUT=0
NO_PLAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) PLAN_FILE="${2:-}"; shift 2 ;;
    --no-plan) NO_PLAN=1; shift ;;
    --json) JSON_OUT=1; shift ;;
    *) shift ;;
  esac
done

cd "$ROOT"

BUILD_SCORE=100
BUILD_ERRS=0
if [[ -f package.json ]] && grep -q '"build"' package.json 2>/dev/null; then
  LOG=$(mktemp)
  set +e
  npm run -s build >"$LOG" 2>&1
  ST=$?
  set -e
  if [[ $ST -ne 0 ]]; then
    BUILD_ERRS=$(grep -c "error TS" "$LOG" 2>/dev/null || echo 0)
    BUILD_ERRS=${BUILD_ERRS//[^0-9]/}
    BUILD_ERRS=${BUILD_ERRS:-0}
    PEN=$(( BUILD_ERRS * 4 ))
    [[ $PEN -gt 60 ]] && PEN=60
    BUILD_SCORE=$(( 100 - PEN ))
    [[ $BUILD_SCORE -lt 0 ]] && BUILD_SCORE=0
  fi
  rm -f "$LOG"
elif [[ -f tsconfig.json ]]; then
  LOG=$(mktemp)
  set +e
  npx --yes tsc --noEmit >"$LOG" 2>&1
  ST=$?
  set -e
  if [[ $ST -ne 0 ]]; then
    BUILD_ERRS=$(grep -c "error TS" "$LOG" 2>/dev/null || echo 0)
    BUILD_ERRS=${BUILD_ERRS//[^0-9]/}
    BUILD_ERRS=${BUILD_ERRS:-0}
    PEN=$(( BUILD_ERRS * 5 ))
    [[ $PEN -gt 70 ]] && PEN=70
    BUILD_SCORE=$(( 100 - PEN ))
    [[ $BUILD_SCORE -lt 0 ]] && BUILD_SCORE=0
  fi
  rm -f "$LOG"
fi

PLAN_SCORE=100
TOTAL=0
DONE=0

_plan_stats() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^-\ +\[[xX]\] ]]; then
      TOTAL=$((TOTAL + 1))
      DONE=$((DONE + 1))
    elif [[ "$line" =~ ^-\ +\[\ \] ]]; then
      TOTAL=$((TOTAL + 1))
    fi
  done < "$f"
}

if [[ $NO_PLAN -eq 1 ]]; then
  TOTAL=0
  DONE=0
  PLAN_SCORE=100
elif [[ -n "$PLAN_FILE" ]]; then
  if [[ -f "$ROOT/$PLAN_FILE" ]]; then
    _plan_stats "$ROOT/$PLAN_FILE"
  elif [[ -f "$PLAN_FILE" ]]; then
    _plan_stats "$PLAN_FILE"
  fi
elif [[ -d "$ROOT/docs/plans" ]]; then
  for f in "$ROOT/docs/plans"/*.md; do
    [[ -f "$f" ]] || continue
    _plan_stats "$f"
  done
fi

if [[ $NO_PLAN -eq 1 ]]; then
  PLAN_SCORE=100
elif [[ $TOTAL -gt 0 ]]; then
  PLAN_SCORE=$(( DONE * 100 / TOTAL ))
else
  PLAN_SCORE=100
fi

GATE_PCT=$(( (BUILD_SCORE * 55 + PLAN_SCORE * 45) / 100 ))
PASS_95=0
[[ $GATE_PCT -ge 95 ]] && PASS_95=1

if [[ $JSON_OUT -eq 1 ]]; then
  python3 -c "import json; print(json.dumps({'root':'''$ROOT''','build_score':$BUILD_SCORE,'build_ts_errors':$BUILD_ERRS,'plan_score':$PLAN_SCORE,'plan_items_done':$DONE,'plan_items_total':$TOTAL,'gate_pct':$GATE_PCT,'pass_95':bool($PASS_95)},ensure_ascii=False))"
  exit 0
fi

echo "=== gemma-gate-check ==="
echo "ROOT=$ROOT"
echo "BUILD_SCORE=$BUILD_SCORE"
echo "PLAN_SCORE=$PLAN_SCORE (${DONE}/${TOTAL} 체크박스)"
echo "GATE_PCT=$GATE_PCT"
echo "PASS_95=$PASS_95"
echo "========================"
