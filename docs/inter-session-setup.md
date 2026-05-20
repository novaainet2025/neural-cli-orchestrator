# Inter-Session 플러그인 설치 및 NCO 이름 연동 가이드

Claude Code 세션 간 실시간 양방향 메시지 통신 플러그인.
NCO statusline 이름(claude-N)을 자동으로 inter-session 이름으로 사용.

- 원본: https://github.com/yilunzhang/claude-code-inter-session
- 용도: 세션 간 작업 위임, 상태 공유, 브로드캐스트

---

## 공통 설치

```
/install-plugin inter-session https://github.com/yilunzhang/claude-code-inter-session.git
/inter-session install-deps
```

---

## macOS 설정

### 1. NCO 이름 조회 스크립트

**파일**: `~/.claude/hooks/inter-session-name.sh`

```bash
#!/bin/bash
MY_PID=""
_pid=$$
for _i in 1 2 3 4 5 6 7 8; do
  _ppid=$(ps -p "$_pid" -o ppid= 2>/dev/null | tr -d ' ')
  [ -z "$_ppid" ] && break
  _comm=$(ps -p "$_ppid" -o comm= 2>/dev/null | xargs basename 2>/dev/null)
  if [ "$_comm" = "claude" ] || [ "$_comm" = "node" ]; then
    MY_PID="$_ppid"
  fi
  _pid="$_ppid"
done

NCO_NAME=""
if [ -n "$MY_PID" ] && [ -d "/tmp/nco-names" ]; then
  for pf in /tmp/nco-names/claude-*.pid; do
    [ -f "$pf" ] || continue
    rp=$(cat "$pf" 2>/dev/null | tr -d '[:space:]')
    if [ "$rp" = "$MY_PID" ]; then
      NCO_NAME=$(basename "$pf" .pid)
      break
    fi
  done
fi
echo "${NCO_NAME}"
```

```bash
chmod +x ~/.claude/hooks/inter-session-name.sh
```

### 2. 자동 패치 스크립트

**파일**: `~/.claude/hooks/patch-inter-session.sh`

```bash
#!/bin/bash
PLUGIN_DIR="$HOME/.claude/plugins/cache/inter-session/inter-session"
LATEST=$(ls -d "$PLUGIN_DIR"/*/ 2>/dev/null | sort -V | tail -1)
[ -z "$LATEST" ] && echo "[patch] plugin not found" && exit 1

SHARED="$LATEST/skills/inter-session/bin/shared.py"
MONITORS="$LATEST/monitors/monitors.json"
[ ! -f "$SHARED" ] && echo "[patch] shared.py not found" && exit 1

# 1. shared.py 패치
if grep -q "_nco_name_from_pid" "$SHARED"; then
  echo "[patch] shared.py already patched"
else
  python3 << PYEOF
path = "$SHARED"
with open(path, "r") as f:
    content = f.read()
if "_nco_name_from_pid" in content:
    print("[patch] shared.py already patched (recheck)")
    exit(0)

nco_func = '''
def _nco_name_from_pid() -> str:
    """Check /tmp/nco-names/claude-*.pid for a name matching this CC session."""
    import glob
    nco_dir = "/tmp/nco-names"
    if not os.path.isdir(nco_dir):
        return ""
    cc_pid = find_cc_ancestor_pid()
    if cc_pid <= 0:
        return ""
    cc_pid_str = str(cc_pid)
    for pf in glob.glob(os.path.join(nco_dir, "claude-*.pid")):
        try:
            with open(pf) as f:
                stored_pid = f.read().strip()
            if stored_pid == cc_pid_str:
                name = os.path.basename(pf).replace(".pid", "")
                if validate_name(name):
                    return name
        except OSError:
            continue
    return ""


'''
content = content.replace("def auto_name_from_cwd(", nco_func + "def auto_name_from_cwd(")
old = "    base = os.path.basename(cwd or os.getcwd()).lower()"
new = """    # Try NCO statusline name first (e.g. claude-1, claude-2)
    nco = _nco_name_from_pid()
    if nco:
        return nco

    base = os.path.basename(cwd or os.getcwd()).lower()"""
content = content.replace(old, new)
with open(path, "w") as f:
    f.write(content)
print("[patch] shared.py patched successfully")
PYEOF
fi

# 2. monitors.json 패치
if grep -q "inter-session-name.sh" "$MONITORS"; then
  echo "[patch] monitors.json already patched"
else
  python3 << PYEOF
import json
path = "$MONITORS"
with open(path) as f:
    data = json.load(f)
for entry in data:
    if "client.py" in entry.get("command", ""):
        cmd = entry["command"]
        if "INTER_SESSION_NAME" not in cmd:
            entry["command"] = (
                'INTER_SESSION_NAME=$(/opt/homebrew/bin/bash '
                '/Users/nova-ai/.claude/hooks/inter-session-name.sh 2>/dev/null) '
                + cmd
            )
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("[patch] monitors.json patched successfully")
PYEOF
fi
echo "[patch] done"
```

### 3. settings.json 훅 등록

```jsonc
// SessionStart hooks에 추가
{
  "type": "command",
  "command": "/opt/homebrew/bin/bash /Users/nova-ai/.claude/hooks/patch-inter-session.sh",
  "timeout": 5,
  "statusMessage": "Patching inter-session plugin..."
}
```

---

## Windows 설정

### 1. 자동 패치 스크립트 (Python — 크로스 플랫폼)

**파일**: `%USERPROFILE%\.claude\hooks\patch-inter-session.py`

```python
"""Post-install patch for inter-session plugin (cross-platform)."""
import json, os, sys, glob
from pathlib import Path

PLUGIN_DIR = Path.home() / ".claude" / "plugins" / "cache" / "inter-session" / "inter-session"

def find_latest():
    if not PLUGIN_DIR.exists(): return None
    versions = sorted(PLUGIN_DIR.iterdir(), key=lambda p: p.name)
    return versions[-1] if versions else None

def nco_dir():
    if sys.platform == "win32":
        return os.path.join(os.environ.get("TEMP", ""), "nco-names")
    return "/tmp/nco-names"

def patch_shared(vdir):
    shared = vdir / "skills" / "inter-session" / "bin" / "shared.py"
    if not shared.exists(): return print("[patch] shared.py not found")
    content = shared.read_text(encoding="utf-8")
    if "_nco_name_from_pid" in content:
        return print("[patch] shared.py already patched")

    nco_func = f'''
def _nco_name_from_pid() -> str:
    """Check nco-names dir for a name matching this CC session."""
    import glob as _glob
    nco_dir = {repr(nco_dir())} if __import__("sys").platform == "win32" else "/tmp/nco-names"
    # Cross-platform: check both paths
    import platform
    if platform.system() == "Windows":
        nco_dir = os.path.join(os.environ.get("TEMP", ""), "nco-names")
    else:
        nco_dir = "/tmp/nco-names"
    if not os.path.isdir(nco_dir):
        return ""
    cc_pid = find_cc_ancestor_pid()
    if cc_pid <= 0:
        return ""
    cc_pid_str = str(cc_pid)
    for pf in _glob.glob(os.path.join(nco_dir, "claude-*.pid")):
        try:
            with open(pf) as f:
                stored_pid = f.read().strip()
            if stored_pid == cc_pid_str:
                name = os.path.basename(pf).replace(".pid", "")
                if validate_name(name):
                    return name
        except OSError:
            continue
    return ""


'''
    content = content.replace("def auto_name_from_cwd(", nco_func + "def auto_name_from_cwd(")
    old = "    base = os.path.basename(cwd or os.getcwd()).lower()"
    new = """    # Try NCO statusline name first (e.g. claude-1, claude-2)
    nco = _nco_name_from_pid()
    if nco:
        return nco

    base = os.path.basename(cwd or os.getcwd()).lower()"""
    content = content.replace(old, new)
    shared.write_text(content, encoding="utf-8")
    print("[patch] shared.py patched successfully")

def main():
    latest = find_latest()
    if not latest: return print("[patch] plugin not found")
    print(f"[patch] Found: {latest}")
    patch_shared(latest)
    print("[patch] done")

if __name__ == "__main__":
    main()
```

### 2. settings.json 훅 등록

```jsonc
// SessionStart hooks에 추가
{
  "type": "command",
  "command": "python3 %USERPROFILE%\\.claude\\hooks\\patch-inter-session.py",
  "timeout": 5,
  "statusMessage": "Patching inter-session plugin..."
}
```

### 3. NCO 이름 경로

| 항목 | macOS | Windows |
|------|-------|---------|
| NCO 이름 저장소 | `/tmp/nco-names/claude-N.pid` | `%TEMP%\nco-names\claude-N.pid` |
| 플러그인 캐시 | `~/.claude/plugins/cache/` | `%USERPROFILE%\.claude\plugins\cache\` |
| inter-session venv | `~/.claude/data/inter-session/venv` | `%USERPROFILE%\.claude\data\inter-session\venv` |

NCO statusline 스크립트가 `%TEMP%\nco-names\claude-N.pid`에 Claude PID를 기록해야 함.

---

## 사용법

```
/inter-session connect          # 자동으로 claude-N 이름 사용
/inter-session list             # 연결된 세션 목록
/inter-session send claude-2 메시지   # 특정 세션에 메시지
/inter-session broadcast 전체메시지   # 전체 브로드캐스트
/inter-session disconnect       # 연결 해제
```

---

## 동작 원리

1. NCO statusline이 세션 시작 시 `/tmp/nco-names/claude-N.pid`에 CC PID 기록
2. SessionStart 훅이 `patch-inter-session` 실행 → 플러그인의 `shared.py` 패치
3. `/inter-session connect` 시 `auto_name_from_cwd()` → `_nco_name_from_pid()` 호출
4. `find_cc_ancestor_pid()`로 CC PID 찾기 → nco-names에서 매칭 → `claude-N` 반환
5. 매칭 실패 시 기존 cwd 기반 이름으로 fallback

---

## 트러블슈팅

- **이름이 project-main으로 나옴**: 패치 미적용. `patch-inter-session` 수동 실행 후 재연결
- **deps missing 에러**: `/inter-session install-deps` 실행
- **send.py "not connected"**: `INTER_SESSION_PPID_OVERRIDE=<PID>` 환경변수로 우회
- **플러그인 업데이트 후 패치 사라짐**: 세션 재시작하면 SessionStart 훅이 자동 재패치
