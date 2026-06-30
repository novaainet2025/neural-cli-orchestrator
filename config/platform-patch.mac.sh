#!/usr/bin/env bash
# NCO Provider 플랫폼 표준 패치 (Mac/Apple Silicon용)
# 실행: bash config/platform-patch.mac.sh
set -euo pipefail

CONFIG="$(dirname "$0")/ai-providers.json"

python3 - "$CONFIG" << 'PY'
import json, sys

cfg_path = sys.argv[1]
with open(cfg_path) as f:
    data = json.load(f)

ENABLE  = {"opencode","agy","codex","cursor-agent","copilot",
           "higgsfield","hermes","openclaw","nvidia","mlx","claude-code"}
DISABLE = {"openrouter","ollama"}  # Mac: MLX 로컬 우선, openrouter 불필요

changed = []
for p in data["providers"]:
    pid = p.get("id","")
    name = p.get("name","")
    before = p.get("enabled", True)

    if pid in ENABLE or "mlx" in pid.lower():
        p["enabled"] = True
    if pid in DISABLE:
        p["enabled"] = False

    after = p.get("enabled", True)
    if before != after:
        changed.append(f"  {'ON ' if after else 'OFF'} ← {name}")

with open(cfg_path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"Mac 패치 완료 (claude-code ON — NCO_HOOK_DISABLED=1로 재귀 차단됨)")
for c in changed:
    print(c)
if not changed:
    print("  변경 없음 (이미 표준)")
PY
