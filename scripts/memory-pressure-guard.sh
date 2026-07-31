#!/usr/bin/env bash
# memory-pressure-guard.sh — 호스트 메모리 고갈을 조기에 잡아 NCO 굶음을 예방한다.
#
# 왜 필요한가 (2026-07-31 T1 대조 실험):
#   고갈 시  wired 40.9GB · free 0.0GB · 여유율 5%  · 스왑 21.3/22.5GB → NCO /health 000, 7.8~25초
#   회복 후  wired  7.9GB · free 7.8GB · 여유율 75% · 스왑 13.5GB      → NCO /health 200, 0.0013~0.047초
#   **코드를 한 줄도 바꾸지 않고 5,000배 이상 차이가 났다.**
#
# 기전: better-sqlite3 는 동기 API다. 호스트 메모리가 고갈되면 SQLite 페이지가 스왑으로 밀려나고,
#       pread 가 스왑 디스크 I/O 를 타는 동안 Node 이벤트루프 전체가 멈춘다. 그래서 가장 가벼운
#       /health 가 무거운 엔드포인트보다 더 느려지는 역전이 생긴다(이것이 진단의 결정적 단서다).
#
# 이 스크립트는 **관측과 경보만** 한다. 프로세스를 죽이지 않는다 —
#   메모리를 잡고 있는 것이 사용자의 작업일 수 있고, 잘못 죽이면 피해가 더 크다.
#   회수 판단은 사람이 한다. 대신 "무엇이 잡고 있는지"를 즉시 알 수 있게 상위 소비자를 남긴다.
#
# 사용:
#   memory-pressure-guard.sh            # 1회 점검 (임계 초과 시에만 경보)
#   memory-pressure-guard.sh --verbose  # 항상 현재 상태 출력
#   memory-pressure-guard.sh --status   # 최근 경보 이력
#
# 환경변수:
#   NCO_MEM_WARN_FREE_PCT   기본 25 — 여유율이 이 아래면 경고
#   NCO_MEM_CRIT_FREE_PCT   기본 10 — 이 아래면 위험(NCO 굶음이 임박했거나 이미 진행 중)
#   NCO_MEM_SWAP_WARN_PCT   기본 80 — 스왑 사용률 경고선

set -u
LOG_DIR="${NCO_MEM_GUARD_LOG_DIR:-$HOME/.claude/.memory-guard}"
LOG="$LOG_DIR/guard.log"
mkdir -p "$LOG_DIR"; [ -f "$LOG" ] || : > "$LOG"

WARN_FREE="${NCO_MEM_WARN_FREE_PCT:-25}"
CRIT_FREE="${NCO_MEM_CRIT_FREE_PCT:-10}"
SWAP_WARN="${NCO_MEM_SWAP_WARN_PCT:-80}"

VERBOSE=0
for a in "$@"; do
  [ "$a" = "--verbose" ] && VERBOSE=1
  [ "$a" = "--status" ] && { tail -40 "$LOG"; exit 0; }
done

_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── 측정 ──────────────────────────────────────────────────────────────────────
# 여유율은 macOS 의 `memory_pressure` 를 1차 소스로 쓴다. vm_stat 페이지를 직접 합산하면
# inactive/speculative/purgeable 회수 가능분 처리에서 OS 와 어긋난다(실측: 자체계산 49% vs OS 79%).
# vm_stat 은 wired/compressed 같은 내역 표시용으로만 쓴다.
OS_FREE_PCT="$(memory_pressure 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p' | tail -1)"

read -r FREE_PCT WIRED_GB FREE_GB COMPRESSED_GB <<EOF
$(vm_stat 2>/dev/null | python3 -c '
import sys, re, subprocess
d = {}
for line in sys.stdin:
    m = re.match(r"(.+?):\s+(\d+)", line)
    if m: d[m.group(1).strip()] = int(m.group(2))
    m2 = re.search(r"page size of (\d+)", line)
    if m2: d["ps"] = int(m2.group(1))
ps = d.get("ps", 16384)
gb = lambda k: d.get(k, 0) * ps / 1073741824
wired, free, comp = gb("Pages wired down"), gb("Pages free"), gb("Pages occupied by compressor")
try:
    total = int(subprocess.check_output(["sysctl","-n","hw.memsize"]).strip()) / 1073741824
except Exception:
    total = wired + free + comp + gb("Pages active") + gb("Pages inactive")
# macOS 의 "가용" 은 free 만이 아니다. inactive/speculative 는 즉시 회수 가능하므로 포함한다.
# free 만 쓰면 정상 상태를 crit 으로 오보한다(실측: free 8% 인데 memory_pressure 는 75% 여유).
avail = free + gb("Pages inactive") + gb("Pages speculative") + gb("Pages purgeable")
pct = (avail / total * 100) if total else 0
print("%.0f %.1f %.1f %.1f" % (pct, wired, avail, comp))
')
EOF

SWAP_PCT=$(sysctl vm.swapusage 2>/dev/null | python3 -c '
import sys, re
t = sys.stdin.read()
u = re.search(r"used\s*=\s*([\d.]+)M", t); a = re.search(r"total\s*=\s*([\d.]+)M", t)
print("%.0f" % (float(u.group(1))/float(a.group(1))*100) if u and a and float(a.group(1)) else "0")
')

# OS 지표를 신뢰하고, 못 읽었을 때만 vm_stat 추정치로 폴백한다.
case "${OS_FREE_PCT:-}" in
  ''|*[!0-9]*) : ;;                 # 비었거나 숫자가 아니면 폴백 유지
  *) FREE_PCT="$OS_FREE_PCT" ;;
esac

LEVEL="ok"
[ "${FREE_PCT:-100}" -lt "$WARN_FREE" ] && LEVEL="warn"
[ "${FREE_PCT:-100}" -lt "$CRIT_FREE" ] && LEVEL="crit"
[ "${SWAP_PCT:-0}" -ge "$SWAP_WARN" ] && [ "$LEVEL" = "ok" ] && LEVEL="warn"

LINE="[$(_ts)] level=$LEVEL free=${FREE_PCT}% wired=${WIRED_GB}GB free=${FREE_GB}GB compressed=${COMPRESSED_GB}GB swap=${SWAP_PCT}%"

if [ "$LEVEL" = "ok" ] && [ "$VERBOSE" -ne 1 ]; then
  exit 0
fi

echo "$LINE" | tee -a "$LOG"

if [ "$LEVEL" != "ok" ]; then
  # 무엇이 잡고 있는지 — 이름별 RSS 합계 상위. 회수 판단의 입력이 된다.
  echo "  상위 메모리 소비자(RSS 합계):" | tee -a "$LOG"
  ps -eo rss=,comm= 2>/dev/null | awk '
    { rss=$1; $1=""; name=$0; sub(/^ +/,"",name);
      n=split(name,p,"/"); short=p[n]; sum[short]+=rss }
    END { for (k in sum) printf "    %7.2f GB  %s\n", sum[k]/1048576, k }' \
    | sort -rn | head -8 | tee -a "$LOG"

  # ollama 는 모델을 올리면 통합메모리를 크게 잡는다. 로드 여부를 명시적으로 남긴다.
  if command -v ollama >/dev/null 2>&1; then
    LOADED="$(ollama ps 2>/dev/null | tail -n +2 | grep -c . | tr -d ' \n')"
    echo "  ollama 로드 모델: ${LOADED:-0}개" | tee -a "$LOG"
  fi

  # NCO 가 실제로 굶고 있는지 — 이것이 경보를 행동으로 바꾸는 판단 근거다.
  HT="$(curl -s -m 12 -o /dev/null -w '%{time_total}|%{http_code}' http://localhost:6200/health 2>/dev/null || echo 'n/a|000')"
  echo "  NCO /health: t=${HT%%|*}s http=${HT##*|}" | tee -a "$LOG"
fi

if [ "$LEVEL" = "crit" ]; then
  cat <<EOF | tee -a "$LOG"
  ⚠ 위험: 여유 메모리 ${FREE_PCT}% — NCO 이벤트루프 굶음이 임박했거나 진행 중이다.
    확인: 위 상위 소비자 목록에서 회수 가능한 것을 고른다.
    주의: Claude Code 세션 자신·세션 인프라(mesh-*, *-daemon, inter-session)는 절대 종료하지 말 것.
    참고: ollama 가 모델을 올려두면 통합메모리를 크게 잡는다 — 'ollama stop <model>' 로 회수 가능.
    고아 프로세스 회수: scripts/orphan-process-monitor.sh --apply
EOF
fi
