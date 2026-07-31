#!/usr/bin/env bash
# orphan-process-monitor.sh — 재기동으로 부모를 잃은 에이전트 CLI 프로세스를 주기적으로 회수한다.
#
# 왜 필요한가 (2026-07-30 실측): NCO 재시작이 하루 23회 발생했고, 그때마다 spawn 된
# 에이전트 CLI(`opencode run` 등)가 detached 라 PM2 가 죽이지 못한 채 ppid=1 로 재부모화됐다.
# 최장 5시간 42분 생존한 12개를 수동 종료했더니 load average 48.34 → 28.91,
# NCO /health 가 000(5~15s) → 200(0.002~0.63s)로 회복됐다. 결과를 회수할 부모가 없으므로
# 이들은 CPU 만 태우는 순수 낭비다.
#
# ⚠ 안전 설계 — 이 스크립트가 잘못되면 다른 Claude Code 세션을 죽인다.
# 실제로 개발 중 넓은 정규식이 `mesh-heartbeat-daemon.sh`(claude-2·3·5), `mesh-autoresponder.sh`,
# 그리고 **다른 세션의 zsh(NCO_NAME=claude-5)와 자기 세션 자신**까지 대상으로 잡았다.
# zsh 가 인용 없는 변수를 단어분할하지 않아 우연히 kill 이 실패했을 뿐이다.
# 그래서 3중 조건을 모두 만족해야만 종료한다:
#   (1) ppid == 1            — 부모가 사라진 것만
#   (2) ALLOW 정확 매치       — argv[0]/argv[1] 조합이 허용목록에 있는 것만 (부분일치 금지)
#   (3) DENY 미포함           — 명령줄에 금지 토큰이 하나라도 있으면 제외
#   (4) 경과시간 >= MIN_AGE   — 방금 재부모화된 정상 프로세스 보호
#
# 사용:
#   orphan-process-monitor.sh            # dry-run (기본) — 대상만 보고
#   orphan-process-monitor.sh --apply    # 실제 종료 (SIGTERM → 유예 → SIGKILL)
#   orphan-process-monitor.sh --status   # 최근 회수 이력
#
# 환경변수:
#   NCO_ORPHAN_MIN_AGE_MIN   기본 30  — 이보다 오래된 것만 종료
#   NCO_ORPHAN_GRACE_SEC     기본 8   — SIGTERM 후 SIGKILL 까지 유예

set -u
LOG_DIR="${NCO_ORPHAN_LOG_DIR:-$HOME/.claude/.orphan-monitor}"
LOG="$LOG_DIR/monitor.log"
mkdir -p "$LOG_DIR"; [ -f "$LOG" ] || : > "$LOG"

MIN_AGE_MIN="${NCO_ORPHAN_MIN_AGE_MIN:-30}"
GRACE_SEC="${NCO_ORPHAN_GRACE_SEC:-8}"
APPLY=0
for a in "$@"; do
  [ "$a" = "--apply" ] && APPLY=1
  [ "$a" = "--status" ] && { tail -30 "$LOG"; exit 0; }
done

_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── ALLOW: "argv[0] argv[1]" 정확 매치만 종료 대상 ────────────────────────────
# NCO 가 Type B 프로바이더를 띄울 때 쓰는 실제 호출 형태만 넣는다.
# 새 프로바이더를 추가하려면 여기에 명시적으로 추가해야 한다(기본 거부).
ALLOW_PAIRS='opencode run
codex exec
aider --message'

# ── DENY: 명령줄에 하나라도 있으면 절대 종료하지 않는다 ────────────────────────
# claude = Claude Code 세션 본체. mesh/daemon/autoresponder = 세션 인프라.
# pm2/PM2 = 프로세스 감독자. zsh/bash/-c = 세션 셸.
DENY_TOKENS='claude
mesh-
-daemon
autoresponder
heartbeat
pm2
PM2
God
zsh
/bin/bash
inter-session
client.py
statusline'

_is_denied() {
  local cmdline="$1" tok
  while IFS= read -r tok; do
    [ -z "$tok" ] && continue
    case "$cmdline" in *"$tok"*) return 0 ;; esac
  done <<< "$DENY_TOKENS"
  return 1
}

_is_allowed_pair() {
  local a0="$1" a1="$2" pair
  while IFS= read -r pair; do
    [ -z "$pair" ] && continue
    [ "$a0 $a1" = "$pair" ] && return 0
  done <<< "$ALLOW_PAIRS"
  return 1
}

# etime(예: 05:42:40 / 1-02:03:04 / 12:34)을 분으로 변환
_etime_min() {
  python3 - "$1" <<'PY'
import sys, re
v = sys.argv[1].strip()
d = 0
if '-' in v:
    dpart, v = v.split('-', 1); d = int(dpart)
parts = [int(x) for x in v.split(':')]
if len(parts) == 3: h, m, s = parts
elif len(parts) == 2: h, m, s = 0, parts[0], parts[1]
else: h, m, s = 0, 0, parts[0]
print(d * 1440 + h * 60 + m + (1 if s >= 30 else 0))
PY
}

# ── 스캔 ──────────────────────────────────────────────────────────────────────
# 성능 주의: macOS 에는 ppid=1 프로세스가 수백 개(시스템 데몬)다. PID 마다 ps 를 다시
# 호출하면 2분을 넘긴다(실측). 단일 `ps -eo` 출력의 args 를 그대로 쓰고, awk 로 1차
# 필터(ppid==1 AND argv[0]/argv[1] 이 ALLOW 후보)를 걸어 후보를 수십 개 이하로 줄인다.
ALLOW_A0="$(printf '%s' "$ALLOW_PAIRS" | awk '{print $1}' | sort -u | paste -sd'|' -)"

# awk 가 선행 공백을 제거하고 `pid\tetime\targs...` 로 정규화해 넘긴다.
# (ps 출력은 우측정렬 패딩이 있어 ${line%% *} 로 자르면 빈 문자열이 된다 — 실측 버그)
CANDIDATES=""
while IFS=$'\t' read -r pid et cmdline; do
  [ -n "$pid" ] || continue
  a0="${cmdline%% *}"; a1_rest="${cmdline#* }"; a1="${a1_rest%% *}"
  _is_denied "$cmdline" && continue
  _is_allowed_pair "$a0" "$a1" || continue
  age="$(_etime_min "$et" 2>/dev/null || echo 0)"
  [ "${age:-0}" -ge "$MIN_AGE_MIN" ] || continue
  CANDIDATES="$CANDIDATES$pid|$age|$a0 $a1"$'\n'
done < <(ps -eo pid=,ppid=,etime=,args= 2>/dev/null \
  | awk -v pat="^($ALLOW_A0)$" '$2==1 && $4 ~ pat {
      args=$4; for (i=5; i<=NF; i++) args = args " " $i;
      printf "%s\t%s\t%s\n", $1, $3, args }')

N="$(printf '%s' "$CANDIDATES" | grep -c '|' || true)"
if [ "${N:-0}" -eq 0 ]; then
  echo "[$(_ts)] scan: 고아 0건 (ppid=1 · ALLOW 매치 · ${MIN_AGE_MIN}분+ 조건)" | tee -a "$LOG"
  exit 0
fi

echo "[$(_ts)] scan: 고아 ${N}건 발견 (조건: ppid=1 · ALLOW · ${MIN_AGE_MIN}분+)" | tee -a "$LOG"
printf '%s' "$CANDIDATES" | while IFS='|' read -r pid age cmd; do
  [ -z "$pid" ] && continue
  echo "  pid=$pid age=${age}분 cmd=$cmd" | tee -a "$LOG"
done

if [ "$APPLY" -ne 1 ]; then
  echo "  (dry-run — 종료하지 않음. --apply 로 실행)" | tee -a "$LOG"
  exit 0
fi

# ── 종료: SIGTERM → 유예 → 잔존만 SIGKILL ────────────────────────────────────
PIDLIST="$(printf '%s' "$CANDIDATES" | awk -F'|' 'NF>1 {print $1}')"
printf '%s\n' "$PIDLIST" | xargs -n1 -I{} sh -c 'kill -TERM {} 2>/dev/null && echo "  TERM {}" || echo "  TERM-fail {}"' | tee -a "$LOG"
sleep "$GRACE_SEC"
SURV="$(printf '%s\n' "$PIDLIST" | xargs -n1 -I{} sh -c 'ps -p {} >/dev/null 2>&1 && echo {}' 2>/dev/null)"
if [ -n "$SURV" ]; then
  printf '%s\n' "$SURV" | xargs -n1 -I{} sh -c 'kill -KILL {} 2>/dev/null && echo "  KILL {}"' | tee -a "$LOG"
fi
REMAIN="$(printf '%s\n' "$PIDLIST" | xargs -n1 -I{} sh -c 'ps -p {} >/dev/null 2>&1 && echo {}' 2>/dev/null | grep -c . || true)"
echo "[$(_ts)] done: 요청 ${N}건 · 잔존 ${REMAIN:-0}건" | tee -a "$LOG"
