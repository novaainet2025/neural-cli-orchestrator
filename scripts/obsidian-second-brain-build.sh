#!/usr/bin/env bash
# obsidian-second-brain-build.sh — vault 공용 지식을 단일 SECOND-BRAIN.md로 집약(캡+시크릿스크럽).
# 모든 프로바이더가 세션 컨텍스트로 읽음. 3rd-party 클라우드로 나가므로 시크릿 스크럽 필수.
set -euo pipefail
export VAULT="/Users/nova-ai/obsidian/mac-obsidian"
python3 - <<'PY'
import os,re,datetime
vault=os.environ["VAULT"]
out=os.path.join(vault,"00-SYSTEM/SECOND-BRAIN.md")
ts=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
cap=90  # 섹션당 최대 라인
sources=[
 "00-SYSTEM/MASTER-CONTEXT.md",
 "03-RULES/verification-receipt.md",
 "03-RULES/nco-workflow.md",
 "00-SYSTEM/PROVIDER-RUNTIME.md",
]
secret=re.compile(r'sk-[a-z0-9]{16}|ghp_[a-z0-9]{16}|gho_|(access|refresh|client)[_-]?(token|secret)|bearer\s+[a-z0-9]{12}|-----BEGIN|api[_-]?key["\' :=]+[a-z0-9]{12}|oauth', re.I)
parts=[f"# 🧠 SECOND BRAIN — 전 프로바이더 공용 지식 (2번째 뇌)\n",
       f"> 자동 생성: {ts} · 소스: Obsidian vault (섹션당 ≤{cap}행, 시크릿 스크럽됨)",
       "> codex·cursor·aider·ollama·opencode·gemini·claude-code 공용 단일 진입점. 편집은 vault 원본에서.\n"]
for rel in sources:
    f=os.path.join(vault,rel)
    if not os.path.isfile(f): continue
    lines=open(f,encoding="utf-8",errors="ignore").read().splitlines()[:cap]
    kept=[l for l in lines if not secret.search(l)]
    parts.append("---\n\n## 📄 "+rel+"\n\n"+"\n".join(kept)+"\n")
open(out,"w",encoding="utf-8").write("\n".join(parts))
print(f"[second-brain] 생성: 00-SYSTEM/SECOND-BRAIN.md ({os.path.getsize(out)}B) @ {ts}")
PY
