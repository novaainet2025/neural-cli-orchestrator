# Inter-Session + NCO 자동 연동 — macOS 설치 가이드

> **상태**: ⚠️ 미검증 (참고용, 경로 매핑만 검증)
> macOS Claude Code(`~/.claude/`)에 직접 설치하는 시나리오.
> **공통 아키텍처**: [README.md](README.md) 참조

macOS와 WSL2는 Unix 셸 환경과 `/tmp/nco-names/` 경로를 공유하므로 절차가 거의 동일합니다. 차이는 (1) bash 위치 (Apple Silicon은 `/opt/homebrew/bin/bash`, Intel은 `/usr/local/bin/bash`) (2) PEP 668 외부관리 환경 (Homebrew Python) 회피 (3) launchd 환경 변수입니다.

## 사전 조건

- macOS 12+ (Apple Silicon 또는 Intel)
- Homebrew 설치 (`brew --version`)
- Python 3.8+ — Homebrew Python 또는 system Python
- Claude Code CLI 설치
- NCO statusline 작동 중 (`ls /tmp/nco-names/`)

## 1단계 — 플러그인 설치

```
/plugin marketplace add https://github.com/yilunzhang/claude-code-inter-session.git
/plugin install inter-session@inter-session
```

## 2단계 — venv 생성 (PEP 668 회피)

Homebrew Python은 외부관리 환경으로 표시되어 `pip install` 직접 호출이 차단됩니다. inter-session의 격리 venv는 이를 자동 회피:

```
/inter-session install-deps
```

내부 실행:

```bash
python3 -m venv ~/.claude/data/inter-session/venv
~/.claude/data/inter-session/venv/bin/pip install websockets psutil
```

`uv` 사용 시 (선택):

```bash
brew install uv
uv venv ~/.claude/data/inter-session/venv
uv pip install -p ~/.claude/data/inter-session/venv websockets psutil
```

## 3단계 — NCO 자동 패치 스크립트

**파일**: `~/.claude/hooks/patch-inter-session.py`

WSL 가이드의 [patch-inter-session.py](wsl-setup.md#3단계--nco-자동-패치-스크립트-생성)와 **완전 동일**. 동일한 `_nco_name_from_pid()`가 macOS의 `/tmp/nco-names/`도 자동 처리.

```bash
chmod +x ~/.claude/hooks/patch-inter-session.py
```

## 4단계 — SessionStart 훅 등록

**파일**: `~/.claude/settings.json`

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

WSL과 100% 동일. macOS 특수 경로 처리 불필요.

## 5단계 — 검증

```
/inter-session connect
```

```bash
python3 ~/.claude/plugins/cache/inter-session/inter-session/0.1.2/skills/inter-session/bin/list.py --self
```

## macOS 특이사항

### Apple Silicon vs Intel

| 항목 | Apple Silicon | Intel |
|---|---|---|
| Homebrew prefix | `/opt/homebrew/` | `/usr/local/` |
| bash 경로 | `/opt/homebrew/bin/bash` | `/usr/local/bin/bash` |
| Python 경로 | `/opt/homebrew/bin/python3` | `/usr/local/bin/python3` |

### launchd / GUI 세션 환경 변수

Claude Code를 Spotlight나 Dock에서 실행할 경우, 셸 rc 파일의 PATH가 상속되지 않을 수 있습니다. NCO statusline 스크립트가 `/opt/homebrew/bin`을 못 찾으면 `nco-names`가 비어 inter-session 자동 매칭이 실패합니다.

해결:

```bash
launchctl setenv PATH "/opt/homebrew/bin:/usr/local/bin:$PATH"
```

또는 settings.json의 `env` 필드로 명시:

```jsonc
{
  "env": {
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  }
}
```

### 권한 (TCC / Privacy)

`Get-Process` 대응인 `ps`/`psutil`은 macOS의 권한 관리(TCC) 영향을 받지 않으므로 별도 권한 부여 불필요. 단 NCO statusline이 `/tmp/`에 쓰려면 시스템 보호 디렉토리 제한이 없는지 확인.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `externally-managed-environment` | PEP 668 (Homebrew Python) | venv 사용 (자동) 또는 `--break-system-packages` (비권장) |
| `/tmp/nco-names` 빈 디렉토리 | launchd 환경 변수 미상속 | `launchctl setenv` 또는 settings.json `env` 명시 |
| `find_cc_ancestor_pid()` 부정확 | macOS process tree 깊이 | sorted glob fallback이 첫 번째 picks up |

## 관련

- 공통 아키텍처: [README.md](README.md)
- WSL2 (검증 완료): [wsl-setup.md](wsl-setup.md)
- Windows: [windows-setup.md](windows-setup.md)
