#!/usr/bin/env python3
"""Merge NCO-managed Claude hooks without replacing user settings."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


MANAGED_HOOKS: dict[str, list[dict[str, Any]]] = {
    "SessionStart": [
        {
            "type": "command",
            "script": "mesh-register.sh",
            "timeout": 8,
            "statusMessage": "Registering CLI session...",
        },
        {
            "type": "command",
            "script": "mesh-autoresponder.sh",
            "timeout": 6,
            "statusMessage": "Starting mesh auto-responder...",
        },
    ],
    "UserPromptSubmit": [
        {"type": "command", "script": "nco-task-classifier.sh", "timeout": 5},
        {"type": "command", "script": "mesh-precheck.sh", "timeout": 5},
        {"type": "command", "script": "nco-rules-inject.sh", "timeout": 3},
    ],
    "PreToolUse": [
        {"type": "command", "script": "nco-agent-enforce.sh", "timeout": 5},
    ],
    "Stop": [
        {"type": "command", "script": "nco-stop-global.sh", "timeout": 10},
    ],
    "PostToolUse": [
        {"type": "command", "script": "nco-track-agent-use.sh", "timeout": 5},
    ],
}
MANAGED_SCRIPTS = {
    hook["script"]
    for hooks in MANAGED_HOOKS.values()
    for hook in hooks
}


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"NCO settings merge error: {message}")


def load_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{path} is not valid readable JSON: {exc}")
    if not isinstance(loaded, dict):
        fail(f"{path} top level must be a JSON object")
    return loaded


def is_managed_hook(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    command = value.get("command")
    if not isinstance(command, str):
        return False
    return any(
        command == script
        or command.endswith(f"/{script}")
        or command.endswith(f" {script}")
        for script in MANAGED_SCRIPTS
    )


def normalized_groups(value: Any, event: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        fail(f"hooks.{event} must be an array of hook groups")
    return [dict(item) for item in value]


def merge_settings(settings: dict[str, Any], hooks_dir: Path) -> dict[str, Any]:
    existing_hooks = settings.get("hooks")
    if existing_hooks is None:
        hooks: dict[str, Any] = {}
        settings["hooks"] = hooks
    elif isinstance(existing_hooks, dict):
        hooks = existing_hooks
    else:
        fail("hooks must be a JSON object")

    for event, definitions in MANAGED_HOOKS.items():
        retained: list[dict[str, Any]] = []
        for group in normalized_groups(hooks.get(event), event):
            group_hooks = group.get("hooks")
            if not isinstance(group_hooks, list):
                retained.append(group)
                continue
            filtered = [hook for hook in group_hooks if not is_managed_hook(hook)]
            if filtered:
                group["hooks"] = filtered
                retained.append(group)
            elif any(key != "hooks" for key in group):
                group["hooks"] = []
                retained.append(group)

        # 스크립트 파일이 실제로 있는 훅만 등록한다.
        # MANAGED_HOOKS 8종은 전부 nova-fleet-config 가 배포하는 훅이라, nco 저장소만
        # 가지고 setup.sh 를 돌린 머신에는 존재하지 않는다. 그대로 등록하면 settings.json
        # 이 없는 파일을 가리키게 되고, Claude Code 는 매 이벤트마다 실패한 훅을 실행한다.
        present = [d for d in definitions if (hooks_dir / d["script"]).is_file()]
        missing = [d["script"] for d in definitions if d not in present]
        if missing:
            print(
                f"[merge-claude-settings] {event}: 스크립트 없음 → 등록 생략: "
                + ", ".join(sorted(missing)),
                file=sys.stderr,
            )

        managed_group = {
            "hooks": [
                {
                    key: value
                    for key, value in definition.items()
                    if key != "script"
                }
                for definition in present
            ],
        }
        # Convert the internal "script" field to Claude's "command" field.
        # zip(..., strict=True) 은 Python 3.10+ 전용이라 Ubuntu 20.04(3.8)·macOS 기본
        # python3(3.9) 에서 TypeError 로 병합기 전체가 죽었다. 두 리스트는 같은
        # `present` 에서 만들어져 길이가 항상 같으므로 strict 없이도 안전하다.
        assert len(managed_group["hooks"]) == len(present)
        for hook, definition in zip(managed_group["hooks"], present):
            hook["command"] = f"bash {hooks_dir / definition['script']}"
        # 등록할 훅이 하나도 없으면 빈 그룹을 남기지 않는다.
        hooks[event] = [*retained, managed_group] if managed_group["hooks"] else retained

    return settings


def atomic_write(path: Path, settings: dict[str, Any]) -> bool:
    rendered = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == rendered:
        return False

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(f"{path.name}.bak.{int(time.time())}")
        shutil.copy2(path, backup)

    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: merge-claude-settings.py SETTINGS_JSON HOOKS_DIR")
    path = Path(sys.argv[1]).expanduser()
    hooks_dir = Path(sys.argv[2]).expanduser()
    settings = merge_settings(load_settings(path), hooks_dir)
    changed = atomic_write(path, settings)
    print(f"NCO settings {'updated' if changed else 'already up to date'}: {path}")


if __name__ == "__main__":
    main()
