#!/usr/bin/env bash
# obsidian-second-brain-build.sh — vault의 공용 지식을 단일 SECOND-BRAIN.md로 집약한다.
# 모든 프로바이더가 이 한 파일을 세션 시작 컨텍스트로 읽는다(2번째 뇌 단일 진입점).
set -euo pipefail
VAULT="/Users/nova-ai/obsidian/mac-obsidian"
OUT="$VAULT/00-SYSTEM/SECOND-BRAIN.md"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# 집약 대상(canonical 공용 지식) — 존재하는 것만 포함
SOURCES=(
  "00-SYSTEM/MASTER-CONTEXT.md"
  "03-RULES/verification-receipt.md"
  "03-RULES/nco-workflow.md"
  "03-RULES/false-report-analysis.md"
  "00-SYSTEM/PROVIDER-RUNTIME.md"
  "00-SYSTEM/AGENTS.md"
)

{
  echo "# 🧠 SECOND BRAIN — 전 프로바이더 공용 지식"
  echo
  echo "> 자동 생성: $TS · 소스: Obsidian vault \`$VAULT\`"
  echo "> 이 파일은 codex·cursor·aider·ollama·opencode·gemini·claude-code 모든 프로바이더가"
  echo "> 세션 시작 시 컨텍스트로 읽는 **단일 공용 지식 진입점**이다. 편집은 vault 원본 섹션에서."
  echo
  for rel in "${SOURCES[@]}"; do
    f="$VAULT/$rel"
    [ -f "$f" ] || continue
    echo "---"
    echo
    echo "## 📄 $rel"
    echo
    cat "$f"
    echo
  done
} > "$OUT"

echo "[second-brain] 생성 완료: ${OUT#$VAULT/} ($(wc -c < "$OUT")B, $(wc -l < "$OUT") lines) @ $TS"
