# CLI Mesh — Multi-agent state & sync
# /nco-mesh [done|check|send|messages|ping]

# Identity
MY_NAME="claude-code"
# Try to find current agent name from PID
for f in /tmp/nco-names/*.pid; do
  [ "$(cat $f 2>/dev/null)" = "$PPID" ] && MY_NAME=$(basename $f .pid) && break
done
# Persistent Session ID
_SID_FILE="/tmp/nco-names/$MY_NAME-$PPID.sid"
mkdir -p /tmp/nco-names
[ -f "$_SID_FILE" ] || python3 -c "import uuid; print('$MY_NAME-'+uuid.uuid4().hex[:8])" > "$_SID_FILE"
MY_SESSION_ID=$(cat "$_SID_FILE")

case "$1" in
  done)
    curl -s -X POST http://localhost:6200/api/mesh/complete -H "Content-Type: application/json" -d "{\"sessionId\":\"$MY_SESSION_ID\",\"completedWork\":\"${2:-Done}\"}" | python3 -c "import sys,json; print('✓ Done:', sys.stdin.read())"
    ;;
  check)
    curl -s -X POST http://localhost:6200/api/mesh/check -H "Content-Type: application/json" -d "{\"sessionId\":\"$MY_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"plannedWork\":\"$2\",\"plannedFiles\":[],\"branch\":\"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Safe:', d.get('safe')); [print(r['detail']) for r in d.get('conflictReports',[])]"
    ;;
  send)
    TO="*"; MSG="$2"; [[ "$2" == @* ]] && TO="${2#@}" && TO="${TO%% *}" && MSG="${2#* }"
    # 1. API로 메시지 큐 + inbox 전송
    curl -s -X POST http://localhost:6200/api/mesh/send -H "Content-Type: application/json" -d "{\"fromSessionId\":\"$MY_SESSION_ID\",\"fromAgent\":\"$MY_NAME\",\"toSessionId\":\"$TO\",\"content\":\"$MSG\"}" | python3 -c "import sys,json; print('Sent:', json.load(sys.stdin).get('delivered'))"
    # 2. Warp 패널 직접 주입 — 개별 osascript + bash sleep + keystroke 직접 타이핑
    _SAFE_MSG=$(echo "[MESH:$MY_NAME] $MSG" | tr -d '"' | head -c 300)
    _PANE_COUNT=3
    [ -f /tmp/nco-warp-tabs.json ] && _PANE_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/nco-warp-tabs.json')))-1)" 2>/dev/null || echo 3)
    if [ "$TO" = "*" ]; then
      for _i in $(seq 1 ${_PANE_COUNT:-3}); do
        osascript -e 'tell application "System Events" to tell process "Warp" to click menu item "Activate Next Pane" of menu "Tab" of menu bar 1' 2>/dev/null
        sleep 2
        osascript -e "tell application \"System Events\" to keystroke \"$_SAFE_MSG\"" 2>/dev/null
        sleep 1
        osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
        sleep 3
      done
      osascript -e 'tell application "System Events" to tell process "Warp" to click menu item "Activate Next Pane" of menu "Tab" of menu bar 1' 2>/dev/null
      echo "→ Warp ${_PANE_COUNT}패널 주입 완료"
    else
      _OFFSETS=$(python3 -c "
import json
try:
  m=json.load(open('/tmp/nco-warp-tabs.json'))
  my=m.get('$MY_NAME',{}).get('tab',0)
  tgt=m.get('$TO',{}).get('tab',0)
  if my>0 and tgt>0: print(tgt-my if tgt>my else tgt-my+len(m))
except: print(1)
" 2>/dev/null)
      for _i in $(seq 1 ${_OFFSETS:-1}); do
        osascript -e 'tell application "System Events" to tell process "Warp" to click menu item "Activate Next Pane" of menu "Tab" of menu bar 1' 2>/dev/null
        sleep 1.5
      done
      sleep 1
      osascript -e "tell application \"System Events\" to keystroke \"$_SAFE_MSG\"" 2>/dev/null
      sleep 1
      osascript -e 'tell application "System Events" to key code 36' 2>/dev/null
      sleep 2
      for _i in $(seq 1 ${_OFFSETS:-1}); do
        osascript -e 'tell application "System Events" to tell process "Warp" to click menu item "Activate Previous Pane" of menu "Tab" of menu bar 1' 2>/dev/null
        sleep 0.5
      done
      echo "→ Warp 패널 주입 완료 ($TO)"
    fi
    ;;
  messages)
    curl -s "http://localhost:6200/api/mesh/messages/$MY_SESSION_ID?drain=1" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'[{m.get(\"fromAgent\")}] {m.get(\"content\")}') for m in d.get('pending',[])+d.get('messages',[])[:5]]"
    ;;
  ping)
    _TMUX_SOCK=$(tmux display-message -p '#{socket_path}' 2>/dev/null || echo "")
    _TMUX_PANE=""
    if [ -n "$_TMUX_SOCK" ]; then
      _MY_TTY=$(ps -o tty= -p $PPID 2>/dev/null | tr -d ' ')
      [ -n "$_MY_TTY" ] && [ "$_MY_TTY" != "??" ] && \
        _TMUX_PANE=$(tmux -S "$_TMUX_SOCK" list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null | awk -v tty="/dev/$_MY_TTY" '$2==tty {print $1; exit}')
    fi
    curl -s -X POST http://localhost:6200/api/mesh/heartbeat -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$MY_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$PPID,\"status\":\"idle\",\"currentWork\":\"Active\",\"tmuxPane\":\"$_TMUX_PANE\",\"tmuxSocket\":\"$_TMUX_SOCK\"}" | python3 -m json.tool
    ;;
  *)
    curl -s http://localhost:6200/api/mesh/sessions | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('sessions',[]):
  pane = s.get('tmuxPane','')
  pane_tag = f' [tmux:{pane}]' if pane else ''
  print(f\"[{s.get('agentId')}]{pane_tag} {s.get('status')} {s.get('currentWork','')}\")
"
    ;;
esac
