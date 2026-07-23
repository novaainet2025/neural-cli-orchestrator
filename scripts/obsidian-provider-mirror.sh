#!/usr/bin/env bash
# obsidian-provider-mirror.sh — 모든 프로바이더의 설정/프롬프트/에이전트/MCP/스킬/컨텍스트를
# Obsidian vault(공용 2번째 뇌)로 미러링한다. 시크릿(auth/token/oauth 등)은 강제 제외.
# 사용: bash scripts/obsidian-provider-mirror.sh [--dry-run]
set -euo pipefail

VAULT="/Users/nova-ai/obsidian/mac-obsidian"
DEST_BASE="$VAULT/01-AGENTS/_provider-configs"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
DRY="${1:-}"
RSYNC_OPTS=(-a --prune-empty-dirs --no-perms --no-owner --no-group)
[ "$DRY" = "--dry-run" ] && RSYNC_OPTS+=(--dry-run -v)

# 시크릿·노이즈 강제 제외 (git 커밋되는 vault에 자격증명 유출 방지)
# 시크릿 + 대용량/벤더드/바이너리/DB 스크래치를 프룬 → 텍스트 config·지식만 남긴다.
EXCLUDES=(
  # 시크릿
  --exclude '*auth*' --exclude '*token*' --exclude '*credential*'
  --exclude 'oauth_creds*' --exclude 'google_accounts*' --exclude 'installation_id'
  --exclude '*.key' --exclude '*.pem' --exclude '*secret*' --exclude '.env*' --exclude '*cookie*'
  --exclude '.credentials*'
  # 벤더드/스크래치/빌드 (대용량 노이즈)
  --exclude 'scratch/' --exclude 'antigravity-cli/' --exclude 'node_modules/'
  --exclude 'generated_images/' --exclude 'vendor/' --exclude 'dist/' --exclude 'build/'
  --exclude '.venv/' --exclude '__pycache__/' --exclude '.next/' --exclude 'target/'
  # 바이너리/DB/스냅샷/로그
  --exclude '*.sqlite' --exclude '*.sqlite-shm' --exclude '*.sqlite-wal'
  --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal'
  --exclude '*.png' --exclude '*.jpg' --exclude '*.jpeg' --exclude '*.gif' --exclude '*.webp'
  --exclude '*.pdf' --exclude '*.zip' --exclude '*.tar*' --exclude '*.wasm' --exclude '*.node'
  --exclude 'shell_snapshots/' --exclude 'shell-snapshots/'
  --exclude '*.tmp' --exclude '*.bak' --exclude '*.log' --exclude '*.count'
  # LLM 모델 가중치 (ollama blobs 등 — 수 GB, config 아님)
  --exclude 'models/' --exclude 'blobs/' --exclude '.sha256-*'
  --exclude '*.gguf' --exclude '*.bin' --exclude '*.safetensors' --exclude '*.onnx'
  # 캐시/휘발/세션
  --exclude '.git/' --exclude 'cache/' --exclude 'caches/' --exclude 'models_cache*'
  --exclude 'plugins/' --exclude 'projects/' --exclude 'projects.json*' --exclude 'statsig/'
  --exclude 'history*' --exclude 'todos/' --exclude 'sessions/' --exclude 'logs/'
  --exclude '_fleet-backup-*/'
  # 대화/상태/캐시 벌크 (config·지식이 아님 — 2번째 뇌 오염 방지)
  --exclude 'chats/' --exclude 'ai-tracking/' --exclude 'extensions/'
  --exclude '*-cache.json' --exclude 'statsig-cache*' --exclude 'workspaceStorage/'
  --exclude 'globalStorage/' --exclude 'User/' --exclude 'CachedData/' --exclude 'Cache/'
  --exclude 'blob_storage/' --exclude 'GPUCache/' --exclude 'Code Cache/' --exclude 'Dawn*Cache/'
)

# provider → source(dir 또는 특정 파일 세트). claude는 방대해 선별.
declare -a JOBS=(
  "codex|$HOME/.codex"
  "cursor|$HOME/.cursor"
  "aider|$HOME/.aider"
  "ollama|$HOME/.ollama"
  "opencode|$HOME/.config/opencode"
  "gemini|$HOME/.gemini"
)

mirror_dir() {
  local name="$1" src="$2" dest="$3"
  [ -e "$src" ] || { echo "  skip $name (no $src)"; return; }
  mkdir -p "$dest"
  rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" "$src/" "$dest/"
  echo "  ✓ $name → ${dest#$VAULT/}"
}

echo "[provider-mirror] 시작 $TS ${DRY}"
for job in "${JOBS[@]}"; do
  IFS='|' read -r name src <<< "$job"
  mirror_dir "$name" "$src" "$DEST_BASE/$name"
done

# claude-code: 선별 미러(지식/설정만, 시크릿·거대디렉터리 제외)
CLAUDE_DEST="$DEST_BASE/claude-code"
if [ "$DRY" != "--dry-run" ]; then mkdir -p "$CLAUDE_DEST"; fi
for item in settings.json settings.local.json CLAUDE.md CLAUDE-reference.md mcp.json hooks commands skills agents memory; do
  s="$HOME/.claude/$item"
  [ -e "$s" ] || continue
  if [ -d "$s" ]; then
    [ "$DRY" != "--dry-run" ] && mkdir -p "$CLAUDE_DEST/$item"
    rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" "$s/" "$CLAUDE_DEST/$item/"
  else
    rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" "$s" "$CLAUDE_DEST/"
  fi
done
echo "  ✓ claude-code → ${CLAUDE_DEST#$VAULT/}"

# NCO 프로젝트 프로바이더 정의(공용 지식)
[ -f "config/ai-providers.json" ] && rsync "${RSYNC_OPTS[@]}" "config/ai-providers.json" "$DEST_BASE/_nco-ai-providers.json" 2>/dev/null || true

if [ "$DRY" != "--dry-run" ]; then
  cat > "$DEST_BASE/INDEX.md" <<EOF
# Provider Configs — 공용 2번째 뇌 (자동 미러)

> 마지막 동기화: $TS
> 소스: 각 프로바이더 로컬 설정 디렉터리 → 이 vault (Obsidian = 모든 프로바이더 공통 지식)
> ⚠️ 시크릿(auth/token/oauth/credential/key/env) 강제 제외 — vault는 git 커밋되므로 자격증명 미러 금지.

미러 대상: codex(~/.codex), cursor(~/.cursor), aider(~/.aider), ollama(~/.ollama), opencode(~/.config/opencode), gemini(~/.gemini), claude-code(~/.claude 선별: settings·CLAUDE.md·mcp·hooks·commands·skills·agents·memory).

각 프로바이더의 설정·프롬프트·에이전트·MCP·스킬·컨텍스트가 이 폴더에 동기화된다.
EOF
  echo "  ✓ INDEX.md"
fi
# 미러 후 공용 지식(SECOND-BRAIN.md) 재생성 → 프로바이더 컨텍스트 배선
SB="$(dirname "$0")/obsidian-second-brain-build.sh"
[ -x "$SB" ] && bash "$SB" || true
PW="$(dirname "$0")/obsidian-provider-context-wire.sh"
[ -x "$PW" ] && bash "$PW" || true
echo "[provider-mirror] 완료 $(date '+%H:%M:%S')"
