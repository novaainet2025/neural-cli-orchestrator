#!/usr/bin/env bash
# workflow-score.sh — NCO 전체 워크플로우 품질 점수 (0-100)
# 10개 차원: 문서화·계획·Task·병렬협업·워크플로우·교차검증·시각검증·갭분석·최종보고서·다음추천
# 사용: workflow-score.sh [프로젝트루트] [--plan path] [--output path] [--json] [--workflow-id id]

set -euo pipefail

ROOT="$(pwd)"
PLAN_FILE=""
OUTPUT_FILE=""
WORKFLOW_ID=""
JSON_OUT=0

if [[ $# -gt 0 && "${1:-}" != --* ]]; then
  ROOT="$(cd "$1" && pwd)" 2>/dev/null || ROOT="$(pwd)"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) PLAN_FILE="${2:-}"; shift 2 ;;
    --output) OUTPUT_FILE="${2:-}"; shift 2 ;;
    --workflow-id) WORKFLOW_ID="${2:-}"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: workflow-score.sh [project_root] [--plan plan.md] [--output agent-output.txt]
       [--workflow-id wf_xxx] [--json]

Dimensions (10pt each, total 100):
  1. docs        문서화 — plan.md, README, workflow 보고서
  2. plan        계획   — 체크리스트 완성도, 태스크 분해
  3. task        Task   — NCO 태스크 생성 활성도
  4. parallel    병렬협업 — parallel/discussion/consensus 사용
  5. workflow    워크플로우 — conductor 사용, 7단계 완성
  6. crossval    교차검증 — 다중 에이전트 리뷰
  7. visual      시각검증 — before/after 스냅샷, health 확인
  8. gap         갭분석 — gap rate, tsc 오류
  9. report      최종보고서 — 검증 영수증 포함 보고서
  10. next       다음추천 — nco-next 호출, 후속 작업 목록
EOF
      exit 0
      ;;
    *) shift ;;
  esac
done

cd "$ROOT"
NCO_API="${NCO_API:-http://localhost:6200}"
NCO_TOKEN="${NCO_TOKEN:-nco_secret_key_change_me_in_production}"
CUTOFF_MIN=60

# 공통 함수: NCO 태스크 데이터
_fetch_tasks() {
  curl -s --connect-timeout 2 --max-time 5 \
    -H "Authorization: Bearer $NCO_TOKEN" \
    "$NCO_API/api/tasks?limit=50" 2>/dev/null || true
}
TASK_DATA=$(_fetch_tasks)

# ── 1. 문서화 (10) ────────────────────────────────────────────────────────
DOCS_SCORE=0
DOCS_DETAIL=""
# plan 파일 존재?
PLAN_COUNT=$(find "$ROOT/docs/plans" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
[[ $PLAN_COUNT -ge 1 ]] && DOCS_SCORE=$((DOCS_SCORE+3)) && DOCS_DETAIL+="plan:$PLAN_COUNT "
# README 있음?
[[ -f "$ROOT/README.md" ]] && DOCS_SCORE=$((DOCS_SCORE+2)) && DOCS_DETAIL+="README "
# workflow 보고서 최근 생성?
REPORT_COUNT=$(find "$ROOT/docs/workflows" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
[[ $REPORT_COUNT -ge 1 ]] && DOCS_SCORE=$((DOCS_SCORE+3)) && DOCS_DETAIL+="reports:$REPORT_COUNT "
# nco-workflow-full 커맨드 존재?
[[ -f "$ROOT/.claude/commands/nco-workflow-full.md" ]] && DOCS_SCORE=$((DOCS_SCORE+2)) && DOCS_DETAIL+="workflow-cmd "
[[ $DOCS_SCORE -gt 10 ]] && DOCS_SCORE=10

# ── 2. 계획 (10) ─────────────────────────────────────────────────────────
PLAN_SCORE=0
PLAN_TOTAL=0
PLAN_DONE=0
PLAN_DETAIL=""
# 체크리스트 완성도
TARGET_PLAN="${PLAN_FILE:-}"
if [[ -z "$TARGET_PLAN" ]]; then
  TARGET_PLAN=$(find "$ROOT/docs/plans" -name "*.md" 2>/dev/null | head -1 || true)
fi
if [[ -n "$TARGET_PLAN" && -f "$TARGET_PLAN" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[-*]\ +\[[xX]\] ]]; then
      PLAN_TOTAL=$((PLAN_TOTAL+1)); PLAN_DONE=$((PLAN_DONE+1))
    elif [[ "$line" =~ ^[-*]\ +\[\ \] ]]; then
      PLAN_TOTAL=$((PLAN_TOTAL+1))
    fi
  done < "$TARGET_PLAN"
fi
if [[ $PLAN_TOTAL -gt 0 ]]; then
  PLAN_SCORE=$(( PLAN_DONE * 7 / PLAN_TOTAL ))
  PLAN_DETAIL="checklist:${PLAN_DONE}/${PLAN_TOTAL} "
else
  PLAN_SCORE=3  # 플랜 없어도 기본 부여
  PLAN_DETAIL="no-plan "
fi
# workflow-pipeline.ts 존재?
[[ -f "$ROOT/src/core/workflow-pipeline.ts" ]] && PLAN_SCORE=$((PLAN_SCORE+2)) && PLAN_DETAIL+="pipeline.ts "
# workflow-score.sh 존재?
[[ -f "$ROOT/scripts/workflow-score.sh" ]] && PLAN_SCORE=$((PLAN_SCORE+1)) && PLAN_DETAIL+="score.sh "
[[ $PLAN_SCORE -gt 10 ]] && PLAN_SCORE=10

# ── 3. Task 시스템 (10) ───────────────────────────────────────────────────
TASK_SCORE=0
TASK_CALLS=0
TASK_AGENTS=""
TASK_DETAIL=""
_TMPVARS=$(mktemp)
if [[ -n "$TASK_DATA" ]]; then
  python3 - <<PYEOF > "$_TMPVARS" 2>/dev/null
import json, datetime, sys
try:
    d = json.loads("""$TASK_DATA""")
    tasks = d.get('tasks', [])
    now = datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(minutes=$CUTOFF_MIN)
    recent = [t for t in tasks if datetime.datetime.strptime(t.get('created_at','2000-01-01')[:19],'%Y-%m-%d %H:%M:%S') >= cutoff]
    agents = sorted(set(t.get('assigned_to','') for t in recent if t.get('assigned_to')))
    print('TASK_CALLS=' + str(len(recent)))
    print('TASK_AGENTS=' + ','.join(agents))
except Exception as ex:
    print('TASK_CALLS=0')
    print('TASK_AGENTS=')
PYEOF
  TASK_CALLS=$(grep '^TASK_CALLS=' "$_TMPVARS" | cut -d= -f2 | tr -d '\n' || echo 0)
  TASK_AGENTS=$(grep '^TASK_AGENTS=' "$_TMPVARS" | cut -d= -f2 | tr -d '\n' || echo '')
  TASK_CALLS=${TASK_CALLS:-0}
  if [[ "$TASK_CALLS" -ge 5 ]]; then TASK_SCORE=10
  elif [[ "$TASK_CALLS" -ge 3 ]]; then TASK_SCORE=8
  elif [[ "$TASK_CALLS" -ge 1 ]]; then TASK_SCORE=5
  else TASK_SCORE=0; fi
  TASK_DETAIL="calls:${TASK_CALLS} agents:[${TASK_AGENTS}]"
fi
rm -f "$_TMPVARS"

# ── 4. 병렬·협업 (10) ────────────────────────────────────────────────────
PARALLEL_SCORE=0
PARALLEL_MODES=""
PARALLEL_COUNT=0
PARALLEL_DETAIL=""
_TMPVARS2=$(mktemp)
if [[ -n "$TASK_DATA" ]]; then
  python3 - <<PYEOF > "$_TMPVARS2" 2>/dev/null
import json, datetime
try:
    d = json.loads("""$TASK_DATA""")
    tasks = d.get('tasks', [])
    now = datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(minutes=$CUTOFF_MIN)
    recent = [t for t in tasks if datetime.datetime.strptime(t.get('created_at','2000-01-01')[:19],'%Y-%m-%d %H:%M:%S') >= cutoff]
    modes = set(t.get('mode','task') for t in recent)
    pmodes = sorted(modes & {'parallel','discussion','consensus','hive','company','full-pipeline'})
    print('PARALLEL_MODES=' + ','.join(pmodes))
    print('PARALLEL_COUNT=' + str(len(pmodes)))
except:
    print('PARALLEL_MODES=')
    print('PARALLEL_COUNT=0')
PYEOF
  PARALLEL_MODES=$(grep '^PARALLEL_MODES=' "$_TMPVARS2" | cut -d= -f2 | tr -d '\n' || echo '')
  PARALLEL_COUNT=$(grep '^PARALLEL_COUNT=' "$_TMPVARS2" | cut -d= -f2 | tr -d '\n' || echo 0)
  PARALLEL_COUNT=${PARALLEL_COUNT:-0}
  if [[ "$PARALLEL_COUNT" -ge 3 ]]; then PARALLEL_SCORE=10
  elif [[ "$PARALLEL_COUNT" -ge 2 ]]; then PARALLEL_SCORE=8
  elif [[ "$PARALLEL_COUNT" -ge 1 ]]; then PARALLEL_SCORE=6
  else PARALLEL_SCORE=2; fi
  PARALLEL_DETAIL="modes:[${PARALLEL_MODES}]"
fi
rm -f "$_TMPVARS2"
# inter-session 연결됨?
SESSION_FILE="${HOME}/.claude/data/inter-session/clients"
SESSION_COUNT=$(ls "$SESSION_FILE"/*.session 2>/dev/null | wc -l | tr -d ' ' || echo 0)
if [[ "${SESSION_COUNT:-0}" -ge 1 ]]; then
  [[ $PARALLEL_SCORE -lt 10 ]] && PARALLEL_SCORE=$((PARALLEL_SCORE+1))
  PARALLEL_DETAIL+=",inter-session:${SESSION_COUNT}"
fi

# ── 5. 워크플로우 (10) ───────────────────────────────────────────────────
WORKFLOW_SCORE=0
WORKFLOW_DETAIL=""
# conductor 사용?
if [[ -n "$TASK_DATA" ]]; then
  CONDUCTOR_USED=$(echo "$TASK_DATA" | python3 -c "
import sys, json, datetime
try:
    d = json.load(sys.stdin)
    tasks = d.get('tasks', [])
    now = datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(minutes=$CUTOFF_MIN)
    recent = [t for t in tasks if datetime.datetime.strptime(t.get('created_at','2000-01-01')[:19],'%Y-%m-%d %H:%M:%S') >= cutoff]
    modes = set(t.get('mode','task') for t in recent)
    print('1' if modes else '0')
except: print('0')
" 2>/dev/null || echo 0)
  [[ "$CONDUCTOR_USED" == "1" ]] && WORKFLOW_SCORE=$((WORKFLOW_SCORE+5)) && WORKFLOW_DETAIL+="conductor "
fi
# nco-workflow-full.md + workflow-pipeline.ts 존재?
[[ -f "$ROOT/.claude/commands/nco-workflow-full.md" ]] && WORKFLOW_SCORE=$((WORKFLOW_SCORE+3)) && WORKFLOW_DETAIL+="workflow-full "
[[ -f "$ROOT/scripts/auto-report.sh" ]] && WORKFLOW_SCORE=$((WORKFLOW_SCORE+2)) && WORKFLOW_DETAIL+="auto-report "
[[ $WORKFLOW_SCORE -gt 10 ]] && WORKFLOW_SCORE=10

# ── 6. 교차검증 (10) ─────────────────────────────────────────────────────
CROSSVAL_SCORE=0
CROSSVAL_DETAIL=""
if [[ -n "$TASK_DATA" ]]; then
  REVIEW_COUNT=$(echo "$TASK_DATA" | python3 -c "
import sys, json, datetime
try:
    d = json.load(sys.stdin)
    tasks = d.get('tasks', [])
    now = datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(minutes=$CUTOFF_MIN)
    recent = [t for t in tasks if datetime.datetime.strptime(t.get('created_at','2000-01-01')[:19],'%Y-%m-%d %H:%M:%S') >= cutoff]
    # cursor-agent 리뷰 태스크 카운트
    reviews = [t for t in recent if t.get('assigned_to') in ('cursor-agent','nvidia','gemini') and '검증' in (t.get('prompt','') or '') or '리뷰' in (t.get('prompt','') or '') or 'review' in (t.get('prompt','') or '').lower()]
    agents = set(t.get('assigned_to') for t in recent if t.get('assigned_to'))
    print(len(agents), len(reviews))
except: print('1 0')
" 2>/dev/null || echo "1 0")
  AGENT_COUNT=$(echo $REVIEW_COUNT | awk '{print $1}')
  REV_COUNT=$(echo $REVIEW_COUNT | awk '{print $2}')
  if [[ ${AGENT_COUNT:-0} -ge 3 ]]; then CROSSVAL_SCORE=$((CROSSVAL_SCORE+5)); fi
  if [[ ${REV_COUNT:-0} -ge 1 ]]; then CROSSVAL_SCORE=$((CROSSVAL_SCORE+5)); fi
  CROSSVAL_DETAIL="agents:${AGENT_COUNT} reviews:${REV_COUNT}"
fi
[[ $CROSSVAL_SCORE -gt 10 ]] && CROSSVAL_SCORE=10

# ── 7. 시각 검증 (10) ────────────────────────────────────────────────────
VISUAL_SCORE=0
VISUAL_DETAIL=""
# health check 가능?
HEALTH=$(curl -s --connect-timeout 2 --max-time 3 "$NCO_API/health" 2>/dev/null || true)
if [[ -n "$HEALTH" ]]; then
  VISUAL_SCORE=$((VISUAL_SCORE+5))
  AGENTS_ONLINE=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('runtime',{}).get('agentsOnline',0))" 2>/dev/null || echo 0)
  VISUAL_DETAIL+="health:ok agents:${AGENTS_ONLINE} "
fi
# before/after 스냅샷 존재?
SNAP_COUNT=$(find /tmp -name "before.json" -o -name "after.json" 2>/dev/null | wc -l | tr -d ' ')
[[ $SNAP_COUNT -ge 2 ]] && VISUAL_SCORE=$((VISUAL_SCORE+3)) && VISUAL_DETAIL+="snapshots:${SNAP_COUNT} "
# tsc --noEmit 오류 없음?
TSC_ERRS=0
if [[ -f "$ROOT/tsconfig.json" ]]; then
  LOG=$(mktemp)
  set +e; npx --yes tsc --noEmit >"$LOG" 2>&1; TSC_ST=$?; set -e
  if [[ $TSC_ST -eq 0 ]]; then
    VISUAL_SCORE=$((VISUAL_SCORE+2)) && VISUAL_DETAIL+="tsc:ok "
  else
    TSC_ERRS=$(grep -c "error TS" "$LOG" 2>/dev/null || echo 0)
    VISUAL_DETAIL+="tsc:${TSC_ERRS}err "
  fi
  rm -f "$LOG"
fi
[[ $VISUAL_SCORE -gt 10 ]] && VISUAL_SCORE=10

# ── 8. 갭 분석 (10) ──────────────────────────────────────────────────────
GAP_SCORE=0
GAP_DETAIL=""
# pending 태스크 비율
if [[ -n "$TASK_DATA" ]]; then
  GAP_RATE=$(echo "$TASK_DATA" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    tasks = d.get('tasks', [])
    total = len(tasks)
    pending = sum(1 for t in tasks if t.get('status') in ('pending','assigned'))
    completed = sum(1 for t in tasks if t.get('status') == 'completed')
    rate = round((completed / total * 100), 1) if total > 0 else 100
    print(rate)
except: print(50)
" 2>/dev/null || echo 50)
  if python3 -c "exit(0 if float('$GAP_RATE') >= 90 else 1)" 2>/dev/null; then
    GAP_SCORE=8; GAP_DETAIL+="completion:${GAP_RATE}% "
  elif python3 -c "exit(0 if float('$GAP_RATE') >= 70 else 1)" 2>/dev/null; then
    GAP_SCORE=5; GAP_DETAIL+="completion:${GAP_RATE}% "
  else
    GAP_SCORE=2; GAP_DETAIL+="completion:${GAP_RATE}% "
  fi
fi
# workflow-score.sh 자체가 실행됨 (현재 실행 중이면 +2)
GAP_SCORE=$((GAP_SCORE+2))
GAP_DETAIL+="score-ran:yes "
[[ $GAP_SCORE -gt 10 ]] && GAP_SCORE=10

# ── 9. 최종 보고서 (10) ──────────────────────────────────────────────────
REPORT_SCORE=0
REPORT_DETAIL=""
REPORT_DIR="$ROOT/docs/workflows"
if [[ -d "$REPORT_DIR" ]]; then
  LATEST_REPORT=$(ls -t "$REPORT_DIR"/*.md 2>/dev/null | head -1 || true)
  if [[ -n "$LATEST_REPORT" && -f "$LATEST_REPORT" ]]; then
    REPORT_SCORE=$((REPORT_SCORE+4))
    REPORT_DETAIL+="report:$(basename "$LATEST_REPORT") "
    # 검증 영수증 포함?
    if grep -q "검증 영수증\|verification receipt\|\[변경\]\|\[검증방법\]" "$LATEST_REPORT" 2>/dev/null; then
      REPORT_SCORE=$((REPORT_SCORE+4))
      REPORT_DETAIL+="receipt:ok "
    fi
    # 보고서 내용 길이?
    RLEN=$(wc -c < "$LATEST_REPORT" | tr -d ' ')
    [[ $RLEN -ge 1000 ]] && REPORT_SCORE=$((REPORT_SCORE+2)) && REPORT_DETAIL+="len:${RLEN}B "
  fi
fi
# auto-report.sh 존재?
[[ -f "$ROOT/scripts/auto-report.sh" ]] || { REPORT_SCORE=$((REPORT_SCORE+0)); REPORT_DETAIL+="no-auto-report "; }
[[ $REPORT_SCORE -gt 10 ]] && REPORT_SCORE=10

# ── 10. 다음 작업 추천 (10) ──────────────────────────────────────────────
NEXT_SCORE=0
NEXT_DETAIL=""
# nco-next 커맨드 존재?
[[ -f "$ROOT/.claude/commands/nco-next.md" ]] && NEXT_SCORE=$((NEXT_SCORE+3)) && NEXT_DETAIL+="nco-next:cmd "
[[ -f "$ROOT/.claude/commands/nco-next-parallel.md" ]] && NEXT_SCORE=$((NEXT_SCORE+2)) && NEXT_DETAIL+="nco-next-parallel "
# 최신 보고서에 다음 작업 섹션?
if [[ -n "${LATEST_REPORT:-}" && -f "${LATEST_REPORT:-}" ]]; then
  if grep -qiE "다음.*작업|next.*action|후속|recommend|추천" "$LATEST_REPORT" 2>/dev/null; then
    NEXT_SCORE=$((NEXT_SCORE+5))
    NEXT_DETAIL+="next-in-report "
  fi
fi
[[ $NEXT_SCORE -gt 10 ]] && NEXT_SCORE=10

TOTAL=$(( DOCS_SCORE + PLAN_SCORE + TASK_SCORE + PARALLEL_SCORE + WORKFLOW_SCORE + CROSSVAL_SCORE + VISUAL_SCORE + GAP_SCORE + REPORT_SCORE + NEXT_SCORE ))
PASSED=0
[[ $TOTAL -ge 95 ]] && PASSED=1
THRESHOLD=95

if [[ $JSON_OUT -eq 1 ]]; then
  python3 -c "
import json
print(json.dumps({
  'workflowId': '${WORKFLOW_ID}',
  'total': $TOTAL,
  'passed': bool($PASSED),
  'threshold': $THRESHOLD,
  'dimensions': {
    '1_docs':     {'score': $DOCS_SCORE,     'max': 10, 'detail': '${DOCS_DETAIL}'},
    '2_plan':     {'score': $PLAN_SCORE,     'max': 10, 'detail': '${PLAN_DETAIL}'},
    '3_task':     {'score': $TASK_SCORE,     'max': 10, 'detail': '${TASK_DETAIL}'},
    '4_parallel': {'score': $PARALLEL_SCORE, 'max': 10, 'detail': '${PARALLEL_DETAIL}'},
    '5_workflow': {'score': $WORKFLOW_SCORE, 'max': 10, 'detail': '${WORKFLOW_DETAIL}'},
    '6_crossval': {'score': $CROSSVAL_SCORE, 'max': 10, 'detail': '${CROSSVAL_DETAIL}'},
    '7_visual':   {'score': $VISUAL_SCORE,   'max': 10, 'detail': '${VISUAL_DETAIL}'},
    '8_gap':      {'score': $GAP_SCORE,      'max': 10, 'detail': '${GAP_DETAIL}'},
    '9_report':   {'score': $REPORT_SCORE,   'max': 10, 'detail': '${REPORT_DETAIL}'},
    '10_next':    {'score': $NEXT_SCORE,     'max': 10, 'detail': '${NEXT_DETAIL}'},
  },
}, ensure_ascii=False))
"
else
  cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 NCO Workflow Score: ${TOTAL}/100  $([[ $PASSED -eq 1 ]] && echo '✅ PASS (≥95)' || echo '❌ FAIL')
 Threshold: ${THRESHOLD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. 문서화    ${DOCS_SCORE}/10   ${DOCS_DETAIL}
  2. 계획      ${PLAN_SCORE}/10   ${PLAN_DETAIL}
  3. Task      ${TASK_SCORE}/10   ${TASK_DETAIL}
  4. 병렬협업  ${PARALLEL_SCORE}/10   ${PARALLEL_DETAIL}
  5. 워크플로우 ${WORKFLOW_SCORE}/10   ${WORKFLOW_DETAIL}
  6. 교차검증  ${CROSSVAL_SCORE}/10   ${CROSSVAL_DETAIL}
  7. 시각검증  ${VISUAL_SCORE}/10   ${VISUAL_DETAIL}
  8. 갭분석    ${GAP_SCORE}/10   ${GAP_DETAIL}
  9. 최종보고서 ${REPORT_SCORE}/10   ${REPORT_DETAIL}
 10. 다음추천  ${NEXT_SCORE}/10   ${NEXT_DETAIL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
fi
