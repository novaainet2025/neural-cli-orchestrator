#!/usr/bin/env bash
# codex-subagent.sh — codex 계열 서브에이전트 공통 디스패처 (gate-aware, do-not-retry)
#
# 목적: `.claude/agents/codex-*.md` 서브에이전트가 NCO codex 로 작업을 위임할 때
#       "이미 실패가 확정된 방법"을 재시도하지 않게 사전 차단하고, 결과를 원장에 기록한다.
#
# 실측 근거(2026-07-30, db/nco.db 14일): 전체 실패 5579건 중
#   42% = CB-cascade(게이트 닫힌 프로바이더로 계속 던진 파생 실패)
#    3% = queue_wait_timeout(같은 프로바이더 직렬 적재 30분 대기 후 사망)
#   → 이 둘은 "던지기 전에 게이트를 보면" 발생하지 않는다. 그래서 dispatch 전 precheck 가 필수.
#
# 사용:
#   codex-subagent.sh run <role> --prompt "<text>" [--ai codex] [--timeout 900]
#   codex-subagent.sh run <role> --prompt-file <path> [--ai codex] [--timeout 900]
#   codex-subagent.sh gate [<ai>]        # 게이트 상태만 조회
#   codex-subagent.sh stats [<days>]     # 성공/실패 원장 롤업
#
# exit code (재시도 정책이 코드에 박혀 있다):
#   0 완료          — 결과 신뢰. 단 "검증"은 별도(ollama/tsc)
#   3 NCO_OFFLINE   — 재시도 금지. 직접 처리 후 사용자에게 알린다
#   4 GATE_BLOCKED  — 재시도 금지. 대체 프로바이더 목록을 출력한다
#   5 REPEAT_BLOCKED— 재시도 금지. 동일 지문 2회+ 실패 이력. 접근법을 바꿔야 한다
#   6 TASK_FAILED   — 분류된 실패. 같은 프롬프트 재전송 금지(분류별 대응 출력)
#   7 POLL_TIMEOUT  — 재시도 금지. 작업을 쪼개서 다시 설계한다

set -u

NCO_URL="${NCO_API_URL:-http://localhost:6200}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_DIR="${NCO_SUBAGENT_LEDGER_DIR:-$REPO_DIR/data/subagent-ledger}"
LEDGER="$LEDGER_DIR/runs.jsonl"
LOOP_LESSON="$HOME/.claude/hooks/loop-lesson.sh"
# 게이트웨이가 metadata.projectDir 를 필수로 요구한다. 기본값은 이 저장소 루트.
PROJECT_DIR="${NCO_PROJECT_DIR:-$REPO_DIR}"
mkdir -p "$LEDGER_DIR"; [ -f "$LEDGER" ] || : > "$LEDGER"

# 조기 종료도 원장에 남긴다 — "성공/실패 기록"에 구멍을 만들지 않기 위해.
_ledger_append() {
  python3 - "$LEDGER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}" <<'PY'
import json, sys
ledger, ts, role, ai, outcome, fclass, err = sys.argv[1:8]
with open(ledger, "a", encoding="utf-8") as f:
    f.write(json.dumps({"ts": ts, "role": role, "ai": ai, "outcome": outcome,
                        "failure_class": fclass, "error": err[:400],
                        "fingerprint": None, "taskId": None, "response_len": 0},
                       ensure_ascii=False) + "\n")
PY
}

_die() { echo "$2" >&2; exit "$1"; }

# 조기 실패 종료: 원장 기록 + loop-lesson 기록 후 종료
_die_recorded() {
  local code="$1" fclass="$2" msg="$3"
  _ledger_append "${ROLE:-unknown}" "${AI:-unknown}" "failed" "$fclass" "$msg"
  [ -x "$LOOP_LESSON" ] && "$LOOP_LESSON" add "subagent-${AI:-unknown}-${fclass}" \
    "codex-subagent[${ROLE:-unknown}] $fclass — $(printf '%s' "$msg" | head -1)" >/dev/null 2>&1 || true
  echo "$msg" >&2
  echo "[ledger] outcome=failed class=$fclass role=${ROLE:-unknown} ai=${AI:-unknown} → $LEDGER" >&2
  exit "$code"
}

# ── 게이트 조회 ────────────────────────────────────────────────────────────────
_gate_json() {
  curl -s -m 8 "$NCO_URL/api/agents" 2>/dev/null
}

cmd_gate() {
  local want="${1:-}"
  _gate_json | python3 -c '
import sys, json
want = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    d = json.load(sys.stdin)
except Exception:
    print("NCO 응답 파싱 실패 (오프라인?)", file=sys.stderr); sys.exit(3)
rows = d.get("agents", [])
for a in rows:
    if want and a.get("id") != want:
        continue
    g = a.get("gate") or {}
    h = a.get("health") or {}
    print("%-14s gate=%-10s available=%-5s circuit=%-10s cooldownUntil=%s" % (
        a.get("id"), g.get("status"), g.get("available"),
        h.get("circuitState"), g.get("cooldownUntil") or "-"))
' "$want"
}

# ── 실행 ──────────────────────────────────────────────────────────────────────
cmd_run() {
  local role="${1:-}"; shift || true
  [ -z "$role" ] && _die 2 "usage: codex-subagent.sh run <role> --prompt <text>|--prompt-file <path> [--ai codex] [--timeout 900]"

  local ai="codex" timeout=900 prompt="" prompt_file=""
  ROLE="$role"; AI="$ai"
  while [ $# -gt 0 ]; do
    case "$1" in
      --ai)          ai="${2:-codex}"; shift 2 ;;
      --timeout)     timeout="${2:-900}"; shift 2 ;;
      --prompt)      prompt="${2:-}"; shift 2 ;;
      --prompt-file) prompt_file="${2:-}"; shift 2 ;;
      *) _die 2 "알 수 없는 옵션: $1" ;;
    esac
  done
  AI="$ai"

  # F13 회피: 프롬프트는 argv/파일로만 받는다. stdin 으로 codex 를 호출하면
  # "Reading additional input from stdin..." 가 출력에 섞여 실패로 오분류된다(실측 23건).
  if [ -n "$prompt_file" ]; then
    [ -r "$prompt_file" ] || _die 2 "프롬프트 파일 읽기 실패: $prompt_file"
    prompt="$(cat "$prompt_file")"
  fi
  [ -z "$prompt" ] && _die 2 "프롬프트가 비어 있다 (--prompt 또는 --prompt-file 필요)"

  # 1) NCO 생존 확인 — F16: 동기 SQLite 핫쿼리로 이벤트루프가 순간 지연되면
  #    짧은 단발 프로브가 "오프라인"으로 오판된다(실측 발생). 3회/10s 로 확인해야 진짜 오프라인이다.
  local health="" alive=0 i
  for i in 1 2 3; do
    health="$(curl -s -m 10 "$NCO_URL/health" 2>/dev/null)"
    case "$health" in
      *'"status":"healthy"'*) alive=1; break ;;
    esac
    [ "$i" -lt 3 ] && sleep 3
  done
  [ "$alive" -eq 1 ] || _die_recorded 3 "F16_NCO_OFFLINE" \
    "[NCO_OFFLINE] $NCO_URL/health 3회 연속 무응답/비정상. 위임 불가 — 직접 처리하고 사용자에게 알릴 것. (재시도 금지)"

  # 2) 게이트 precheck — CB-cascade(실패 1위, 42%)와 queue_wait_timeout 을 원천 차단
  local gate_out
  gate_out="$(_gate_json | python3 -c '
import sys, json
ai = sys.argv[1]
d = json.load(sys.stdin)
rows = d.get("agents", [])
me = next((a for a in rows if a.get("id") == ai), None)
if me is None:
    print("MISSING"); sys.exit(0)
g = me.get("gate") or {}
if g.get("available") is True:
    print("OK"); sys.exit(0)
alts = [a.get("id") for a in rows
        if a.get("id") != ai and ((a.get("gate") or {}).get("available") is True)]
print("BLOCKED\t%s\t%s\t%s" % (g.get("status"), g.get("cooldownUntil") or "-", ",".join(alts)))
' "$ai" 2>/dev/null)"

  case "$gate_out" in
    OK) : ;;
    MISSING)
      _die_recorded 4 "F10_CONFIG_DRIFT" \
        "[GATE_BLOCKED] 프로바이더 '$ai' 가 /api/agents 에 없다 — 퇴출/개명 가능성. id 하드코딩 말고 provider-registry 경유로 재확인. (재시도 금지)" ;;
    BLOCKED*)
      local st cd alts
      st="$(printf '%s' "$gate_out"  | cut -f2)"
      cd="$(printf '%s' "$gate_out"  | cut -f3)"
      alts="$(printf '%s' "$gate_out" | cut -f4)"
      _die_recorded 4 "F1_CB_CASCADE" \
        "[GATE_BLOCKED] $ai gate=$st cooldownUntil=$cd — 지금 던지면 'Circuit breaker open' 파생 실패가 된다.
대응: (a) cooldown 이후 재시도, 또는 (b) 가용 대체 프로바이더로 라우팅 → ${alts:-없음}
같은 프로바이더 즉시 재시도는 금지 (실측 CB-cascade 2346건의 발생 경로)." ;;
    *)
      _die_recorded 3 "F16_NCO_OFFLINE" "[NCO_OFFLINE] 게이트 조회 실패 — /api/agents 응답 이상. (재시도 금지)" ;;
  esac

  # 3) 반복 실패 지문 차단 — 같은 (role, prompt) 가 2회+ 실패했으면 접근법을 바꾸게 만든다
  local fp
  fp="$(printf '%s\n%s' "$role" "$prompt" | shasum -a 256 | cut -c1-16)"
  local prev_fail
  prev_fail="$(python3 - "$LEDGER" "$fp" <<'PY'
import json, sys
ledger, fp = sys.argv[1], sys.argv[2]
n, last = 0, ""
try:
    for line in open(ledger, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("fingerprint") == fp and r.get("outcome") == "failed":
            n += 1
            last = r.get("failure_class") or r.get("error") or ""
except FileNotFoundError:
    pass
print("%d\t%s" % (n, last))
PY
)"
  local fail_n fail_last
  fail_n="$(printf '%s' "$prev_fail" | cut -f1)"
  fail_last="$(printf '%s' "$prev_fail" | cut -f2)"
  if [ "${fail_n:-0}" -ge 2 ] && [ "${NCO_SUBAGENT_FORCE:-0}" != "1" ]; then
    _die_recorded 5 "F0_REPEAT_BLOCKED" "[REPEAT_BLOCKED] 동일 지문($fp) 이 ${fail_n}회 실패했다. 최근 분류: ${fail_last:-unknown}
같은 프롬프트 재전송 금지 — 작업을 쪼개거나 프로바이더/접근법을 바꿀 것.
강제 실행이 정말 필요하면 NCO_SUBAGENT_FORCE=1."
  fi

  # 4) dispatch + poll
  local out
  out="$(python3 - "$NCO_URL" "$ai" "$prompt" "$timeout" "$PROJECT_DIR" <<'PY'
import json, sys, time, urllib.request, urllib.error

nco, ai, prompt, timeout, project_dir = (
    sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5])

def post(path, payload):
    req = urllib.request.Request(nco + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

def get(path):
    with urllib.request.urlopen(nco + path, timeout=10) as r:
        return json.loads(r.read())

try:
    # metadata.projectDir 는 게이트웨이 필수 필드다 (없으면 400 invalid_project_dir).
    task = post("/api/task", {"ai": ai, "prompt": prompt,
                              "metadata": {"projectDir": project_dir}})
except urllib.error.HTTPError as e:
    # 오류 본문을 삼키면 원인 파악이 불가능해진다 — 반드시 함께 남긴다.
    try:
        body = e.read().decode("utf-8", "replace")[:400]
    except Exception:
        body = ""
    print(json.dumps({"outcome": "failed", "failure_class": "DISPATCH_ERROR",
                      "error": "HTTP %s %s — %s" % (e.code, e.reason, body)}, ensure_ascii=False))
    sys.exit(0)
except Exception as e:
    print(json.dumps({"outcome": "failed", "failure_class": "DISPATCH_ERROR", "error": str(e)}))
    sys.exit(0)

task_id = task.get("taskId") or task.get("id") or ""
if not task_id:
    print(json.dumps({"outcome": "failed", "failure_class": "DISPATCH_ERROR",
                      "error": "taskId 없음: %s" % json.dumps(task)[:200]}))
    sys.exit(0)

print(json.dumps({"event": "dispatched", "taskId": task_id}), file=sys.stderr)

deadline = time.time() + timeout
while time.time() < deadline:
    time.sleep(5)
    try:
        raw = get("/api/tasks/%s" % task_id)
    except Exception:
        continue
    t = raw.get("task", raw)
    st = t.get("status", "")
    if st == "completed":
        print(json.dumps({"outcome": "completed", "taskId": task_id,
                          "response": t.get("response") or t.get("result") or ""}))
        sys.exit(0)
    if st in ("failed", "error", "cancelled", "timed_out", "lease_expired"):
        print(json.dumps({"outcome": "failed", "taskId": task_id, "status": st,
                          "error": (t.get("error") or "")[:600]}))
        sys.exit(0)

print(json.dumps({"outcome": "poll_timeout", "taskId": task_id, "waited_s": timeout}))
PY
)"

  # 5) 실패 분류 + 원장 기록
  # 주의: `python3 - <<'PY'` 는 stdin 을 스크립트로 소비한다. 데이터를 stdin 으로 파이프하면
  #       sys.stdin.read() 가 빈 문자열이 된다(실측 버그). 데이터는 반드시 argv 로 넘긴다.
  local classified
  classified="$(python3 - "$role" "$ai" "$fp" "$out" <<'PY'
import json, re, sys
role, ai, fp = sys.argv[1], sys.argv[2], sys.argv[3]
raw = (sys.argv[4] if len(sys.argv) > 4 else "").strip()
try:
    r = json.loads(raw)
except Exception:
    r = {"outcome": "failed", "failure_class": "UNPARSEABLE", "error": raw[:300]}

# 실측 실패 분류표 (data source: db/nco.db tasks.error + learning_events.pattern, 14일)
RULES = [
    ("F1_CB_CASCADE",    r"Circuit breaker open|provider_unavailable|Circuit Breaker denied"),
    ("F2_ORPHAN_POISON", r"^orphaned"),
    ("F3_OUTPUT_ECHO",   r"failure pattern in output|failure-pattern|Reading additional input from stdin"),
    ("F4_QUEUE_WAIT",    r"queue_wait_timeout"),
    ("F5_SILENT_EMPTY",  r"silent-failure|empty completion|EMPTY_OR_SHORT|future-intent"),
    ("F6_TIMEOUT",       r"timeout\(hardcap\)|timeout\(idle\)|aborted due to timeout|timeout waiting for response"),
    ("F7_RATE_LIMIT",    r"hit your (weekly|session) limit|rate.?limit"),
    ("F8_QUALITY",       r"FORMAT_MISMATCH|quality_rejected"),
    ("F9_VERIFIER_TSC",  r"verifier failed"),
    ("F10_CONFIG_DRIFT", r"invalid model selection|Unknown model|not recognized as a known model"),
    ("F11_UPSTREAM",     r"NonRetriableError|ENOTFOUND|Connection error|Connection closed|fetch failed|Provider Error"),
    ("F12_NO_PROPOSALS", r"discussion_(no|insufficient)_valid_proposals"),
    ("F14_SINGLE_TOOL",  r"single tool-calls at once"),
    ("F15_SIGINT",       r"exit=130|SIGINT|Aborting operation"),
    ("F17_PROTOCOL_RECONVERSION", r"protocol_reconversion_blocked"),
    ("F18_MISSING_PROJECT_DIR",   r"invalid_project_dir|projectDir is required"),
    ("F19_PAYLOAD_REJECTED",      r"delegation_payload_rejected|Invalid input"),
]
ADVICE = {
    "F1_CB_CASCADE":   "게이트가 닫혔다. 같은 프로바이더 재시도 금지 — cooldown 대기 또는 가용 대체로 라우팅.",
    "F2_ORPHAN_POISON":"서버 재기동 고아. 수동 재큐 금지 — boot orphan recovery 에 맡기고, 외부 주입 태스크는 성과 집계에서 제외.",
    "F3_OUTPUT_ECHO":  "에이전트가 argv/시스템프롬프트/소스를 에코해 실패로 오판됐다. 프롬프트에 대용량 소스 인라인 금지(파일 경로로 전달), stdin 호출 금지.",
    "F4_QUEUE_WAIT":   "해당 프로바이더에 직렬 적재됨. 같은 큐에 재투입 금지 — nco_parallel 로 분산하거나 대체 워커.",
    "F5_SILENT_EMPTY": "빈 출력/의도선언만. 동일 프롬프트 재전송 금지 — 출력계약(첫 줄 done:/error:)을 명시하고 산출물 경로를 요구.",
    "F6_TIMEOUT":      "하드캡/유휴 타임아웃. 같은 크기로 재시도 금지 — 작업을 쪼갠다.",
    "F7_RATE_LIMIT":   "리밋 소진. 리셋 전 재시도 절대 금지 — 대체 워커로 우회하고 [미참여:<agent>=리밋] 명시.",
    "F8_QUALITY":      "포맷/품질 게이트. 다수는 오탐(text-only·read-only 산출물). 산출물 조작 금지 — surface & hold.",
    "F9_VERIFIER_TSC": "tsc 검증 실패. junk .ts 산출물(Improvement cycle=N/3)·팬텀 모듈 확인 후 git rm. 가짜 모듈 생성 금지.",
    "F10_CONFIG_DRIFT":"모델/프로바이더 id 불일치. id 하드코딩 금지 — provider-registry resolvePreference 경유.",
    "F11_UPSTREAM":    "업스트림/네트워크 장애. 1회까지만 재시도, 그 이상은 프로바이더 변경.",
    "F12_NO_PROPOSALS":"참가자 다수가 게이트 차단됨. 토론 전에 가용 프로바이더로 참가자 필터.",
    "F14_SINGLE_TOOL": "로컬 모델이 병렬 tool_use 미지원. 순차 툴콜 1개씩으로 재설계.",
    "F15_SIGINT":      "외부 인터럽트(SIGINT). 정당한 취소일 수 있다 — 실패로 집계하기 전 원인 확인.",
    "F16_NCO_OFFLINE": "NCO 무응답. 단발 프로브가 이벤트루프 지연에 걸린 오탐일 수 있다 — 3회 확인 후에도 실패면 진짜 오프라인이니 직접 처리.",
    "F17_PROTOCOL_RECONVERSION": "done:/status:/error:/question: 로 시작하는 프로토콜 응답을 새 태스크로 던졌다(409). 에이전트 응답을 그대로 재투입하지 말고 현재 단계 지시문으로 다시 쓸 것.",
    "F18_MISSING_PROJECT_DIR": "metadata.projectDir 누락(400). 게이트웨이 필수 필드다 — 디스패처를 우회해 직접 curl 하지 말 것.",
    "F19_PAYLOAD_REJECTED": "위임 payload 거부. ai 가 런타임 미등록이거나 스키마 불일치 — /api/agents 로 실제 등록 id 확인(하드코딩 금지).",
    "F20_CANCELLED_NO_ERROR": "에러 없이 cancelled. 실패로 단정하기 전에 산출물을 직접 확인할 것 — 작업이 끝난 뒤 취소 마킹된 사례가 있다(git diff / tsc / grep 로 지상진실 확인).",
    "DISPATCH_ERROR":  "태스크 생성 자체 실패. 응답 본문의 error 필드를 보고 원인을 특정한다.",
    "POLL_TIMEOUT":    "폴링 한도 초과. 같은 작업 재시도 금지 — 분할하거나 백그라운드 태스크로 추적.",
    "UNPARSEABLE":     "디스패처 출력 파싱 실패. 스크립트/응답 형식 확인.",
}

if r.get("outcome") == "poll_timeout":
    r["failure_class"] = "POLL_TIMEOUT"
elif r.get("outcome") == "failed" and not r.get("failure_class"):
    err = r.get("error") or ""
    if not err.strip() and r.get("status") == "cancelled":
        # F20: 에러 없이 cancelled — 작업이 끝난 뒤 취소로 마킹되는 경우가 있다(실측).
        # 상태만 보고 "실패"로 단정하면 이미 반영된 산출물을 놓친다.
        r["failure_class"] = "F20_CANCELLED_NO_ERROR"
    else:
        r["failure_class"] = next((k for k, pat in RULES if re.search(pat, err, re.I)), "UNCLASSIFIED")

r["role"], r["ai"], r["fingerprint"] = role, ai, fp
if r.get("failure_class"):
    r["advice"] = ADVICE.get(r["failure_class"], "분류 미등록 — 새 실패 요인일 수 있다. 원장에 남기고 카탈로그에 추가할 것.")
print(json.dumps(r, ensure_ascii=False))
PY
)"

  # 원장 append (T1 근거: 파일에 실제로 남는다)
  python3 - "$LEDGER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$classified" <<'PY'
import json, sys
ledger, ts = sys.argv[1], sys.argv[2]
r = json.loads(sys.argv[3])
row = {
    "ts": ts,
    "role": r.get("role"),
    "ai": r.get("ai"),
    "fingerprint": r.get("fingerprint"),
    "taskId": r.get("taskId"),
    "outcome": r.get("outcome"),
    "failure_class": r.get("failure_class"),
    "error": (r.get("error") or "")[:400],
    "response_len": len(r.get("response") or ""),
}
with open(ledger, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY

  local outcome fclass advice resp
  outcome="$(printf '%s' "$classified" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("outcome",""))')"
  fclass="$(printf '%s' "$classified" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("failure_class") or "")')"
  advice="$(printf '%s' "$classified" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("advice") or "")')"

  # 실패는 loop-lesson 원장에도 남긴다 (UserPromptSubmit 훅이 다음 턴에 주입 → 반복 방지)
  if [ "$outcome" != "completed" ] && [ -x "$LOOP_LESSON" ]; then
    "$LOOP_LESSON" add "subagent-${ai}-${fclass}" "codex-subagent[$role] $fclass — $advice" >/dev/null 2>&1 || true
  fi

  if [ "$outcome" = "completed" ]; then
    printf '%s' "$classified" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("response",""))'
    echo
    echo "[ledger] outcome=completed role=$role ai=$ai → $LEDGER"
    return 0
  fi

  echo "[$fclass] $advice" >&2
  printf '%s' "$classified" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("error:", (d.get("error") or "")[:400], file=sys.stderr)'
  echo "[ledger] outcome=$outcome role=$role ai=$ai → $LEDGER" >&2
  [ "$outcome" = "poll_timeout" ] && return 7
  return 6
}

# ── 원장 롤업 ─────────────────────────────────────────────────────────────────
cmd_stats() {
  local days="${1:-14}"
  python3 - "$LEDGER" "$days" <<'PY'
import json, sys
from collections import Counter
ledger, days = sys.argv[1], int(sys.argv[2])
rows = []
try:
    for line in open(ledger, encoding="utf-8"):
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
except FileNotFoundError:
    pass
if not rows:
    print("원장 비어 있음: %s" % ledger); sys.exit(0)
ok = sum(1 for r in rows if r.get("outcome") == "completed")
print("총 %d건 · 성공 %d · 실패 %d · 성공률 %.1f%%" % (len(rows), ok, len(rows) - ok, 100.0 * ok / len(rows)))
print("\n[실패 분류]")
for k, c in Counter(r.get("failure_class") for r in rows if r.get("outcome") != "completed").most_common():
    print("  %-18s %d" % (k, c))
print("\n[role 별]")
for role in sorted({r.get("role") for r in rows}):
    sub = [r for r in rows if r.get("role") == role]
    o = sum(1 for r in sub if r.get("outcome") == "completed")
    print("  %-22s %d/%d (%.0f%%)" % (role, o, len(sub), 100.0 * o / len(sub)))
PY
}

case "${1:-}" in
  run)   shift; cmd_run "$@" ;;
  gate)  shift; cmd_gate "${1:-}" ;;
  stats) shift; cmd_stats "${1:-14}" ;;
  *) cat >&2 <<EOF
usage:
  codex-subagent.sh run <role> --prompt "<text>" [--ai codex] [--timeout 900]
  codex-subagent.sh run <role> --prompt-file <path> [--ai codex] [--timeout 900]
  codex-subagent.sh gate [<ai>]
  codex-subagent.sh stats [<days>]
EOF
    exit 2 ;;
esac
