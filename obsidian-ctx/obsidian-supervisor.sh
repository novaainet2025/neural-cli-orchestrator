#!/usr/bin/env bash

set -euo pipefail

TASKS_URL="http://localhost:6200/api/tasks"
TASK_URL="http://localhost:6200/api/task"
SESSIONS_DIR="/Users/nova-ai/obsidian/mac-obsidian/07-SESSIONS"
LOG_FILE="/tmp/obsidian-supervisor.log"
STUCK_SECONDS=600

mkdir -p "${SESSIONS_DIR}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "${LOG_FILE}"
}

tasks_json="$(curl -sS "${TASKS_URL}")"

actions_output="$(printf '%s' "${tasks_json}" | python3 - "${TASK_URL}" "${SESSIONS_DIR}" "${STUCK_SECONDS}" <<'PY'
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

task_url = sys.argv[1]
sessions_dir = sys.argv[2]
stuck_seconds = int(sys.argv[3])
raw = sys.stdin.read().strip()

if not raw:
    sys.exit(0)

data = json.loads(raw)
if isinstance(data, dict):
    if isinstance(data.get("tasks"), list):
        tasks = data["tasks"]
    elif isinstance(data.get("data"), list):
        tasks = data["data"]
    else:
        tasks = [data]
elif isinstance(data, list):
    tasks = data
else:
    tasks = []

def parse_time(value):
    if not value:
        return None
    normalized = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None

def task_id(task):
    return task.get("id") or task.get("taskId") or task.get("_id") or "unknown"

def task_prompt(task):
    return task.get("prompt") or task.get("input") or task.get("description") or ""

def task_result(task):
    return task.get("result") or task.get("output") or task.get("response") or ""

def safe_name(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "task"

now = datetime.now(timezone.utc)

for task in tasks:
    state = str(task.get("status") or task.get("state") or "").lower()
    created_at = parse_time(task.get("assignedAt") or task.get("updatedAt") or task.get("createdAt"))
    age = (now - created_at).total_seconds() if created_at else 0

    if state == "assigned" and age >= stuck_seconds:
        payload = json.dumps({
            "retryOf": task_id(task),
            "ai": task.get("ai") or task.get("agent") or "",
            "prompt": task_prompt(task),
        })
        subprocess.run(
            ["curl", "-sS", "-X", "POST", task_url, "-H", "Content-Type: application/json", "-d", payload],
            check=False,
        )
        print(f"RETRIED {task_id(task)}")

    if state in {"completed", "done", "success"}:
        filename = f"{safe_name(task_id(task))}.md"
        path = os.path.join(sessions_dir, filename)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(f"# Task {task_id(task)}\n\n")
                handle.write(f"- AI: {task.get('ai') or task.get('agent') or 'unknown'}\n")
                handle.write(f"- Status: {state}\n\n")
                handle.write("## Prompt\n")
                handle.write(f"{task_prompt(task)}\n\n")
                handle.write("## Result\n")
                handle.write(f"{task_result(task)}\n")
            print(f"SAVED {path}")
PY
)"

while IFS= read -r line; do
  [[ -n "${line}" ]] && log "${line}"
done <<< "${actions_output}"

while IFS= read -r line; do
  [[ -n "${line}" ]] && log "${line}"
done < <(printf '%s\n' "${tasks_json}" | python3 - <<'PY'
import json
import sys

try:
    data = json.loads(sys.stdin.read() or "null")
except Exception:
    data = None

if isinstance(data, list):
    print(f"fetched {len(data)} tasks")
elif isinstance(data, dict):
    if isinstance(data.get("tasks"), list):
        print(f"fetched {len(data['tasks'])} tasks")
    elif isinstance(data.get("data"), list):
        print(f"fetched {len(data['data'])} tasks")
    else:
        print("fetched 1 task object")
else:
    print("fetched 0 tasks")
PY
)
