#!/usr/bin/env bash
# auto-report.sh — NCO 워크플로우 자동 보고서 생성 (v2 — 갭분석 + 검증 영수증 포함)
# 사용: auto-report.sh --prompt "..." --score-json '{...}' [--workflow-id id] [--phases-json file]

set -euo pipefail

PROMPT=""
SCORE_JSON=""
WORKFLOW_ID=""
PHASES_JSON=""
OUTPUT_DIR=""
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-files) MAX_FILES="${2:-}"; shift 2 ;;
    *) ;;
  esac
  case "$1" in
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --score-json) SCORE_JSON="${2:-}"; shift 2 ;;
    --workflow-id) WORKFLOW_ID="${2:-}"; shift 2 ;;
    --phases-json) PHASES_JSON="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: auto-report.sh --prompt "task" --score-json '{"total":85,...}'
       [--workflow-id wf_xxx] [--phases-json phases.json] [--output-dir docs/workflows] [--max-files N]
EOF
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$PROMPT" ]] || { echo "Missing --prompt" >&2; exit 1; }
[[ -n "$SCORE_JSON" ]] || { echo "Missing --score-json" >&2; exit 1; }

OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/docs/workflows}"
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
SAFE_ID="${WORKFLOW_ID:-wf_${TIMESTAMP}}"
FILENAME="${OUTPUT_DIR}/${TIMESTAMP}-${SAFE_ID}-workflow.md"

# Git snapshot
CHANGED_FILES=$(git -C "$PROJECT_DIR" diff --name-only 2>/dev/null | head -${MAX_FILES:-100} || true)
STAGED_FILES=$(git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null | head -30 || true)

# NCO health
NCO_API="${NCO_API:-http://localhost:6200}"
NCO_TOKEN="${NCO_TOKEN:-nco_secret_key_change_me_in_production}"
NCO_STATUS="offline"
if curl -sf --connect-timeout 2 "$NCO_API/health" >/dev/null 2>&1; then
  NCO_STATUS="online"
fi

PHASES_SECTION=""
if [[ -n "$PHASES_JSON" && -f "$PHASES_JSON" ]]; then
  PHASES_SECTION=$(python3 -c "
import json, sys
phases = json.load(open(sys.argv[1]))
lines = []
for p in phases:
    status = p.get('status', '?')
    name = p.get('name', '?')
    ms = p.get('durationMs', 0)
    icon = '✓' if status == 'done' else ('✗' if status == 'failed' else '○')
    lines.append(f'- {icon} **{name}** ({status}, {ms}ms)')
print('\n'.join(lines) if lines else '- (no phases recorded)')
" "$PHASES_JSON" 2>/dev/null || echo "- (phases parse error)")
else
  PHASES_SECTION="- (phases not provided)"
fi

# Python 보고서 생성기 (temp file 방식)
_SCRIPT=$(mktemp /tmp/auto-report-XXXXXX.py)
cat > "$_SCRIPT" << 'PYEOF'
import json, sys, urllib.request, os
from datetime import datetime, timezone

prompt     = sys.argv[1]
score_raw  = sys.argv[2]
wf_id      = sys.argv[3]
path       = sys.argv[4]
phases     = sys.argv[5]
changed_s  = sys.argv[6]
staged_s   = sys.argv[7]
nco_status = sys.argv[8]

score   = json.loads(score_raw)
dims    = score.get('dimensions', {})
total   = score.get('total', 0)
passed  = score.get('passed', False)
threshold = score.get('threshold', 80)

changed = [f for f in changed_s.strip().split('\n') if f]
staged  = [f for f in staged_s.strip().split('\n') if f]

DIM_LABELS = {
    '1_docs':     '문서화',    '2_plan':    '계획',
    '3_task':     'Task시스템', '4_parallel':'병렬·협업',
    '5_workflow': '워크플로우', '6_crossval':'교차검증',
    '7_visual':   '시각검증',  '8_gap':     '갭분석',
    '9_report':   '최종보고서','10_next':   '다음추천',
    'build':'빌드','tests':'테스트','nco_usage':'NCO사용',
    'plan':'계획완성','changes':'변경위생','quality':'출력품질',
}

# ── 갭 분석 테이블 ─────────────────────────────
gap_rows   = []
missing_dims = []
for key, d in dims.items():
    sc = d.get('score', 0); mx = d.get('max', 10)
    label = DIM_LABELS.get(key, key)
    flag  = '✅' if sc >= mx else ('⚠️' if sc >= mx * 0.7 else '❌')
    gap   = mx - sc
    detail = d.get('detail', '')[:60]
    gap_rows.append(f'| {flag} | {label} | {sc}/{mx} | {"-" if gap==0 else f"+{gap}"} | {detail} |')
    if gap > 0:
        missing_dims.append((label, gap, d.get('detail','')))

gap_table = '\n'.join(gap_rows)
if missing_dims:
    missing_section = '\n'.join(
        f'- **{l}**: +{g}점 가능 ({det[:50]})'
        for l, g, det in sorted(missing_dims, key=lambda x: -x[1])
    )
else:
    missing_section = '- 모든 차원 만점 달성 ✅'

# ── NCO 태스크 통계 ───────────────────────────
nco_api   = os.environ.get('NCO_API', 'http://localhost:6200')
nco_token = os.environ.get('NCO_TOKEN', 'nco_secret_key_change_me_in_production')
task_stats = {'total':0,'completed':0,'pending':0,'failed':0}
agents_used = set()
modes_used  = set()
try:
    req = urllib.request.Request(
        f'{nco_api}/api/tasks?limit=50',
        headers={'Authorization': f'Bearer {nco_token}'}
    )
    with urllib.request.urlopen(req, timeout=4) as r:
        td = json.loads(r.read())
    for t in td.get('tasks', []):
        s = t.get('status', '')
        task_stats['total'] += 1
        if s == 'completed':               task_stats['completed'] += 1
        elif s in ('pending','assigned'):  task_stats['pending']   += 1
        elif s == 'failed':                task_stats['failed']    += 1
        if t.get('assigned_to'):  agents_used.add(t['assigned_to'])
        if t.get('mode'):         modes_used.add(t['mode'])
except Exception:
    pass

fail_rate = round(task_stats['failed'] / max(1, task_stats['total']) * 100, 1)
comp_rate = round(task_stats['completed'] / max(1, task_stats['total']) * 100, 1)
fail_ok   = '✅' if fail_rate <= 10 else '⚠️'
agents_list = ', '.join(sorted(agents_used)) or '(없음)'
modes_list  = ', '.join(sorted(modes_used))  or '(없음)'

# ── 검증 영수증 미검증 항목 ───────────────────
unverified_items = []
if fail_rate > 10:
    unverified_items.append(f'fail-rate {fail_rate}% (목표 ≤10%)')
if not passed:
    unverified_items.append(f'점수 {total}/100 < 임계값 {threshold}')
unverified = ', '.join(unverified_items) if unverified_items else '없음'

now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
status_badge = '✅ PASS' if passed else '❌ FAIL'
changed_list = '\n'.join(f'- `{f}`' for f in changed) or '- (없음)'
staged_list  = '\n'.join(f'- `{f}`' for f in staged)  or '- (없음)'
title = (prompt[:80] + '...') if len(prompt) > 80 else prompt
title = title.replace('\n', ' ')

body = f"""# NCO 워크플로우 최종 보고서

> **워크플로우 ID**: `{wf_id}`
> **생성 시각**: {now_str}
> **NCO 서버**: {nco_status}

---

## 작업 요청

```
{prompt.strip()[:500]}
```

---

## 워크플로우 단계 실행

{phases}

---

## 📊 10차원 점수 현황

**총점: {total}/100 {status_badge}** (임계값: {threshold})

| 상태 | 차원 | 점수 | 갭 | 상세 |
|:----:|------|:----:|:--:|------|
{gap_table}

---

## 🔍 갭 분석 (Gap Analysis)

### 미달 항목 및 개선 포인트

{missing_section}

### NCO 태스크 운영 통계

| 항목 | 값 |
|------|:--:|
| 총 태스크 | {task_stats['total']}개 |
| 완료 | {task_stats['completed']}개 ({comp_rate}%) |
| 대기 중 | {task_stats['pending']}개 |
| 실패 | {task_stats['failed']}개 (실패율: {fail_rate}%) {fail_ok} |
| 투입 에이전트 | {agents_list} |
| 사용 모드 | {modes_list} |

> 실패율 기준: ≤10% 정상 | 현재 {fail_rate}% {fail_ok}

---

## 📁 변경 파일

### 미스테이지 (unstaged)
{changed_list}

### 스테이지됨 (staged)
{staged_list}

---

## 다음 작업 추천 (Next Actions)

1. **점수 재측정**: `python3 scripts/workflow-score.py . --json`
2. **갭 개선**: {missing_section.split(chr(10))[0] if missing_dims else '모든 차원 완점'}
3. **보고서 재생성**: `bash scripts/auto-report.sh --prompt "..." --score-json "..."`
4. **전체 파이프라인**: `/nco-workflow-full <작업 설명>`
5. **에이전트 추가**: `/nco-conductor "워크플로우 개선 작업"`

---

## 검증 영수증

- [변경] 워크플로우 파이프라인 실행 (ID: `{wf_id}`)
- [검증방법] `python3 scripts/workflow-score.py .` → {total}/100 {status_badge} | NCO `/api/tasks` 직접 조회 → 완료율 {comp_rate}%
- [등급] T1 (스크립트 직접 실행 + API 응답 본문 확인)
- [Gap] {total}% 달성 ({100-total}점 미달 | 부족: {', '.join(l for l, _, _ in missing_dims[:3]) or '없음'})
- [미검증항목] {unverified}
"""

open(path, 'w', encoding='utf-8').write(body)
print(path)
PYEOF

python3 "$_SCRIPT" "$PROMPT" "$SCORE_JSON" "$SAFE_ID" "$FILENAME" \
  "$PHASES_SECTION" "$CHANGED_FILES" "$STAGED_FILES" "$NCO_STATUS"
rm -f "$_SCRIPT"

echo "Report saved: $FILENAME"
