# Inter-Session + NCO 이름 자동 연동 — 플랫폼별 설치 가이드

inter-session 플러그인(https://github.com/yilunzhang/claude-code-inter-session)을 Claude Code에 설치하고, NCO statusline 이름(`claude-1`, `claude-2`, …)과 자동 연동하는 가이드.

## 플랫폼별 가이드

| 플랫폼 | 가이드 | 검증 상태 |
|---|---|---|
| **WSL2** (Ubuntu/Debian on Windows) | [wsl-setup.md](wsl-setup.md) | ✅ 검증 완료 (2026-05-21, claude-2 자동 연결) |
| **Windows** (native Claude Code) | [windows-setup.md](windows-setup.md) | ⚠️ 미검증 (참고용, Windows Claude Code 사용 시) |
| **macOS** (Apple Silicon / Intel) | [macos-setup.md](macos-setup.md) | ⚠️ 미검증 (참고용, 경로 매핑만 검증) |

## 공통 아키텍처

세 플랫폼 모두 다음과 동일한 메커니즘으로 동작:

1. **NCO statusline**이 매 호출마다 `<nco-names-dir>/claude-N.pid` 파일에 현재 Claude Code 세션 PID를 기록
2. **inter-session client**가 부팅 시 자신의 PID(또는 부모 Claude Code 프로세스 PID)를 nco-names의 `.pid` 값과 비교
3. 매칭된 `claude-N` 파일명을 자기 이름으로 사용 → 모든 inter-session 메시지가 NCO 이름으로 라우팅

플랫폼 간 차이는 (1) `nco-names` 디렉토리 경로 (2) Python/셸 실행 환경 (3) PID 매칭 로직뿐.

## 플랫폼별 경로 매핑

| 항목 | WSL2 | Windows | macOS |
|---|---|---|---|
| Claude 설정 | `~/.claude/` | `%USERPROFILE%\.claude\` | `~/.claude/` |
| 훅 디렉토리 | `~/.claude/hooks/` | `%USERPROFILE%\.claude\hooks\` | `~/.claude/hooks/` |
| NCO 이름 저장소 | `/tmp/nco-names/` | `%TEMP%\nco-names\` | `/tmp/nco-names/` |
| 플러그인 캐시 | `~/.claude/plugins/cache/` | `%USERPROFILE%\.claude\plugins\cache\` | `~/.claude/plugins/cache/` |
| inter-session venv | `~/.claude/data/inter-session/venv` | `%USERPROFILE%\.claude\data\inter-session\venv` | `~/.claude/data/inter-session/venv` |
| 실행 셸 | bash | PowerShell / Git Bash | bash / zsh |

## 핵심 패치: shared.py의 `_nco_name_from_pid()`

세 플랫폼 모두 동일한 Python 패치를 사용 (플러그인 업데이트 시 재적용):

```python
def _nco_name_from_pid() -> str:
    import glob, platform
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
    # 1) PID match
    if cc_pid_str:
        for pf in glob.glob(os.path.join(nco_dir, "claude-*.pid")):
            try:
                with open(pf) as f:
                    if f.read().strip() == cc_pid_str:
                        name = os.path.basename(pf).replace(".pid", "")
                        if validate_name(name):
                            return name
            except OSError:
                continue
    # 2) Fallback: first claude-*.pid (handles cross-env PID mismatch)
    names = sorted(glob.glob(os.path.join(nco_dir, "claude-*.pid")))
    if names:
        name = os.path.basename(names[0]).replace(".pid", "")
        if validate_name(name):
            return name
    return ""
```

이 함수가 `auto_name_from_cwd()` 진입부에서 가장 먼저 호출되도록 패치.

## 검증 명령

설치 완료 후 모든 플랫폼에서 동일하게 동작 확인:

```
/inter-session connect          # claude-N 이름으로 자동 등록
/inter-session list             # 연결된 피어 목록
/inter-session broadcast hi     # 모든 피어에게 인사
```

## 관련 문서

- [opus-commander-spec.md](../opus-commander-spec.md) — Commander 모드 spec
- [RULES.md](../RULES.md) — 멀티세션 협업 규칙
