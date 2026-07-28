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

        managed_group = {
            "hooks": [
                {
                    key: value
                    for key, value in definition.items()
                    if key != "script"
                }
                for definition in definitions
            ],
        }
        # Convert the internal "script" field to Claude's "command" field.
        for hook, definition in zip(managed_group["hooks"], definitions, strict=True):
            hook["command"] = f"bash {hooks_dir / definition['script']}"
        hooks[event] = [*retained, managed_group]

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
