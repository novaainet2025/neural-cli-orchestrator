#!/usr/bin/env bash
# NCO Provider 플랫폼 표준 패치 (WSL/Linux용)
# 실행: bash config/platform-patch.wsl.sh [--gpu]
# --gpu 옵션: Ollama 활성화 (GPU 노드 전용)
set -euo pipefail

GPU=${1:-}
CONFIG="$(dirname "$0")/ai-providers.json"

python3 - "$CONFIG" "$GPU" << 'PY'
import json, sys

cfg_path = sys.argv[1]
gpu_mode = sys.argv[2] == "--gpu"

with open(cfg_path) as f:
    data = json.load(f)

# 플랫폼 정책 (WSL 기준)
ENABLE  = {"opencode","agy","codex","cursor-agent","copilot",
           "higgsfield","hermes","openclaw","nvidia","claude-code","openrouter"}
DISABLE = {"mlx"}  # Mac 전용
# Ollama: GPU 노드만 활성화
if gpu_mode:
    ENABLE.add("ollama")
else:
    DISABLE.add("ollama")

changed = []
for p in data["providers"]:
    pid = p.get("id","")
    name = p.get("name","")
    before = p.get("enabled", True)

    if pid in ENABLE or any(k in pid for k in ["opencode","codex","cursor","copilot","higgsfield","hermes","openclaw","nvidia","openrouter"]):
        p["enabled"] = True
    if pid in DISABLE or "mlx" in pid.lower():
        p["enabled"] = False
    if pid == "claude-code":
        p["enabled"] = True   # WSL: claude sub-agent OK
    if pid == "ollama":
        p["enabled"] = gpu_mode

    after = p.get("enabled", True)
    if before != after:
        changed.append(f"  {'ON ' if after else 'OFF'} ← {name}")

with open(cfg_path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"WSL 패치 완료 ({'GPU모드' if gpu_mode else '저사양모드'})")
for c in changed:
    print(c)
if not changed:
    print("  변경 없음 (이미 표준)")
PY
