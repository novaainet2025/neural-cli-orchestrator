# Inter-Session + NCO 자동 연동 — Windows native 설치 가이드

> **상태**: ⚠️ 미검증 (참고용)
> Windows native Claude Code(C:\Users\<user>\.claude\)에 직접 설치하는 시나리오.
> 실제로는 WSL2 Claude Code 사용 중이므로 본 가이드는 시작점 reference입니다.
> WSL2 사용자: [wsl-setup.md](wsl-setup.md) 참조.
> **공통 아키텍처**: [README.md](README.md) 참조

## 사전 조건

- Windows 10/11
- Claude Code Windows installer 설치 (`%LOCALAPPDATA%\Programs\claude\` 등)
- Python 3.8+ (system 또는 user-level)
- NCO statusline이 `%TEMP%\nco-names\claude-N.pid` 형식으로 PID 기록 중

## Windows 특이사항 (vs WSL/macOS)

1. **셸**: PowerShell 우선, Git Bash 폴백
2. **경로 구분자**: `\` (백슬래시) — JSON 내에서는 `\\` 이스케이프 필수
3. **NCO 이름 디렉토리**: `%TEMP%\nco-names\` (보통 `C:\Users\<user>\AppData\Local\Temp\nco-names\`)
4. **프로세스 트리 조회**: `Get-Process` + `Get-CimInstance Win32_Process` (ps 미사용)
5. **WSL과 공존 시 PID 미스매치**: WSL statusline이 WSL PID를 `/tmp/nco-names/`에 기록, Windows inter-session은 Windows PID로 매칭 시도 → 매칭 불가. 미러링 또는 sorted glob fallback 필요.

## 1단계 — 플러그인 설치

Windows Claude Code 세션에서:

```
/plugin marketplace add https://github.com/yilunzhang/claude-code-inter-session.git
/plugin install inter-session@inter-session
```

## 2단계 — venv 생성

```
/inter-session install-deps
```

내부 실행:

```powershell
python -m venv $env:USERPROFILE\.claude\data\inter-session\venv
& "$env:USERPROFILE\.claude\data\inter-session\venv\Scripts\pip.exe" install websockets psutil
```

## 3단계 — NCO 자동 패치 스크립트

**파일**: `%USERPROFILE%\.claude\hooks\patch-inter-session.py`

WSL 가이드의 [patch-inter-session.py](wsl-setup.md#3단계--nco-자동-패치-스크립트-생성)와 **동일**.
`_nco_name_from_pid()`의 `platform.system() == "Windows"` 분기가 자동으로 `%TEMP%\nco-names`를 사용합니다.

## 4단계 — SessionStart 훅 등록

**파일**: `%USERPROFILE%\.claude\settings.json`

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python %USERPROFILE%\\.claude\\hooks\\patch-inter-session.py",
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

**주의**: 백슬래시 이스케이프(`\\`) 필수. PowerShell 환경 변수(`%USERPROFILE%`) 사용.

## 5단계 — WSL 공존 시 PID 미스매치 우회 (선택)

WSL과 Windows Claude Code를 **동시에** 사용하는 환경에서, WSL의 NCO statusline이 `/tmp/nco-names/`에 PID를 기록하는데 Windows inter-session은 `%TEMP%\nco-names\`를 봅니다.

### 옵션 A — WSL → Windows 미러링

WSL의 `nco-statusline.sh`에 미러링 함수 추가:

```bash
_mirror_nco_names_to_windows() {
    local win_dir="/mnt/c/Users/<user>/AppData/Local/Temp/nco-names"
    [ -d "$win_dir" ] || mkdir -p "$win_dir"
    # stale 제거 후 cp
    find "$win_dir" -name 'claude-*.pid' -delete 2>/dev/null
    cp /tmp/nco-names/claude-*.pid "$win_dir/" 2>/dev/null
}
_mirror_nco_names_to_windows
```

### 옵션 B — sorted glob fallback (권장)

`patch-inter-session.py`의 `_nco_name_from_pid()`에 이미 포함된 fallback이 처리:

```python
# Fallback: pick the first claude-*.pid file
names = sorted(glob.glob(os.path.join(nco_dir, "claude-*.pid")))
if names:
    return os.path.basename(names[0]).replace(".pid", "")
```

PID 매칭 실패 시 첫 번째 `claude-*.pid` 파일명을 픽업하므로 PID가 달라도 이름은 통일됩니다. 단, 여러 세션이 동시 접속 시 모두 같은 이름을 받을 수 있으므로 미러링 또는 명시적 `--name` 인자가 더 안전합니다.

## 6단계 — 검증

```
/inter-session connect
```

PowerShell:

```powershell
python "$env:USERPROFILE\.claude\plugins\cache\inter-session\inter-session\0.1.2\skills\inter-session\bin\list.py" --self
```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| Python 경로 미발견 | system Python 미설치 | py launcher (`py -3`) 또는 Microsoft Store Python 설치 |
| `Get-CimInstance` 권한 거부 | UAC | PowerShell as Administrator로 statusline 갱신 |
| `%TEMP%\nco-names` 비어있음 | NCO statusline 미작동 | NCO 백엔드 별도 점검 |
| 백슬래시 파싱 오류 | settings.json 이스케이프 누락 | `\\` 사용 (`\\\\`까지 필요한 경우도 있음) |

## 관련

- 공통 아키텍처: [README.md](README.md)
- WSL2 검증 사례: [wsl-setup.md](wsl-setup.md)
- macOS: [macos-setup.md](macos-setup.md)
