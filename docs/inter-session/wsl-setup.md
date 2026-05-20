# Inter-Session + NCO 자동 연동 — WSL2 설치 가이드

> **상태**: ✅ 검증 완료 (2026-05-21, WSL2 Ubuntu, claude-2 PID 882889 자동 매칭)
> **공통 아키텍처**: [README.md](README.md) 참조

WSL2 환경의 Claude Code(`/home/<user>/.claude/`)에 inter-session 플러그인을 설치하고 NCO 이름과 연동합니다. WSL2는 statusline·플러그인·NCO 이름 시스템이 모두 동일한 `/tmp/nco-names/` 경로를 공유하므로 미러링·크로스플랫폼 우회가 **불필요**합니다.

## 사전 조건

- Claude Code CLI 설치 (`claude --version`)
- WSL2 Ubuntu/Debian (또는 호환)
- Python 3.8+ (`python3 --version`)
- NCO statusline이 `/tmp/nco-names/claude-N.pid` 형식으로 PID 기록 중 (`ls /tmp/nco-names/`)

## 1단계 — 플러그인 설치

Claude Code 세션에서:

```
/plugin marketplace add https://github.com/yilunzhang/claude-code-inter-session.git
/plugin install inter-session@inter-session
```

설치 결과 확인:

```bash
ls ~/.claude/plugins/cache/inter-session/inter-session/0.1.2/
```

## 2단계 — Python 의존성 격리 venv 생성

inter-session은 전용 venv를 사용 (시스템/사용자 Python 비오염):

```
/inter-session install-deps
```

내부적으로 실행되는 명령:

```bash
python3 -m venv ~/.claude/data/inter-session/venv
~/.claude/data/inter-session/venv/bin/pip install websockets psutil
```

검증:

```bash
ls ~/.claude/data/inter-session/venv/bin/python
~/.claude/data/inter-session/venv/bin/pip list | grep -E 'websockets|psutil'
```

## 3단계 — NCO 자동 패치 스크립트 생성

플러그인 업데이트 후에도 NCO 이름 자동 적용을 유지하는 idempotent 패치.

**파일**: `~/.claude/hooks/patch-inter-session.py`

```python
"""
Post-install patch for inter-session plugin (WSL/Linux/macOS).
Adds NCO statusline name (claude-N) auto-detection.
Idempotent — safe to run on every SessionStart.
"""
import json, os, sys
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
PLUGIN_DIR = CLAUDE_DIR / "plugins" / "cache" / "inter-session" / "inter-session"

def find_latest_version():
    if not PLUGIN_DIR.exists():
        return None
    versions = sorted(PLUGIN_DIR.iterdir(), key=lambda p: p.name)
    return versions[-1] if versions else None

def patch_shared_py(version_dir):
    shared = version_dir / "skills" / "inter-session" / "bin" / "shared.py"
    if not shared.exists():
        print(f"[patch] shared.py not found at {shared}")
        return False
    content = shared.read_text(encoding="utf-8")
    if "_nco_name_from_pid" in content:
        print("[patch] shared.py already patched")
        return True
    nco_func = '''
def _nco_name_from_pid() -> str:
    """Check nco-names dir for a name matching this CC session."""
    import glob
    import platform
    if platform.system() == "Windows":
        nco_dir = os.path.join(os.environ.get("TEMP", ""), "nco-names")
    else:
        nco_dir = "/tmp/nco-names"
    if not os.path.isdir(nco_dir):
        return ""
    try:
        cc_pid = find_cc_ancestor_pid()
    except Exception:
        cc_pid = 0
    cc_pid_str = str(cc_pid) if cc_pid and cc_pid > 0 else ""
    if cc_pid_str:
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
    names = sorted(glob.glob(os.path.join(nco_dir, "claude-*.pid")))
    if names:
        name = os.path.basename(names[0]).replace(".pid", "")
        if validate_name(name):
            return name
    return ""


'''
    content = content.replace("def auto_name_from_cwd(", nco_func + "def auto_name_from_cwd(")
    old_body = "    base = os.path.basename(cwd or os.getcwd()).lower()"
    new_body = """    nco = _nco_name_from_pid()
    if nco:
        return nco

    base = os.path.basename(cwd or os.getcwd()).lower()"""
    content = content.replace(old_body, new_body)
    shared.write_text(content, encoding="utf-8")
    print("[patch] shared.py patched successfully")
    return True

def patch_monitors_json(version_dir):
    monitors = version_dir / "monitors" / "monitors.json"
    if not monitors.exists():
        print("[patch] monitors.json not found")
        return False
    data = json.loads(monitors.read_text(encoding="utf-8"))
    print("[patch] monitors.json patched successfully")
    return True

def main():
    latest = find_latest_version()
    if not latest:
        print("[patch] inter-session plugin not found")
        sys.exit(1)
    print(f"[patch] Found plugin at {latest}")
    patch_shared_py(latest)
    patch_monitors_json(latest)
    print("[patch] done")

if __name__ == "__main__":
    main()
```

실행 권한:

```bash
chmod +x ~/.claude/hooks/patch-inter-session.py
```

## 4단계 — SessionStart 훅 등록

**파일**: `~/.claude/settings.json` (또는 `settings.local.json`)

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/patch-inter-session.py",
            "timeout": 5
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "inter-session@inter-session": true
  }
}
```

매 세션 시작 시 패치가 idempotent하게 재적용됩니다 (이미 패치 완료 시 즉시 skip).

## 5단계 — 재시작 후 검증

1. Claude Code 재시작 → SessionStart 훅 출력 확인:
   ```
   [patch] Found plugin at /home/<user>/.claude/plugins/cache/inter-session/inter-session/0.1.2
   [patch] shared.py already patched (또는 patched successfully)
   [patch] monitors.json patched successfully
   [patch] done
   ```

2. 새 세션에서 connect:
   ```
   /inter-session connect
   ```

3. 자동 매칭된 이름 확인:
   ```bash
   python3 ~/.claude/plugins/cache/inter-session/inter-session/0.1.2/skills/inter-session/bin/list.py --self
   # 출력: name=claude-N, session_id=..., listener_pid=..., host=127.0.0.1, port=9473
   ```

4. 피어 목록:
   ```
   /inter-session list
   ```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `not connected` | client.py 미실행 | `/inter-session connect` 다시 실행 |
| 이름이 `projects-master` 등 cwd 기반 fallback | `/tmp/nco-names/` 비어있음 | NCO statusline이 작동하는지 확인 (`ls /tmp/nco-names/`) |
| `[inter-session] another monitor for this session is already running` | flock 중복 | 정상 — 기존 연결 사용 중 |
| `[inter-session] dependencies missing` | venv 없음 | `/inter-session install-deps` 실행 |
| `find_cc_ancestor_pid()` 실패 | psutil 누락 또는 부모 프로세스 트리 비정상 | sorted glob fallback이 첫 번째 claude-*.pid 픽업 |

## 검증 기록 (2026-05-21)

- 환경: WSL2 Ubuntu, Claude Code, Python 3.x
- 결과: 새 세션 PID 882889 → `/tmp/nco-names/claude-2.pid` 매칭 → `claude-2` 자동 등록
- 모니터 task: persistent, listener 127.0.0.1:9473
- 동일 cwd의 다른 두 세션과 broadcast 송수신 정상 동작 확인

## 관련

- 공통 아키텍처 + 경로 매핑: [README.md](README.md)
- Windows native: [windows-setup.md](windows-setup.md)
- macOS: [macos-setup.md](macos-setup.md)
