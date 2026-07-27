#!/usr/bin/env bash
# NCO one-line bootstrap for macOS, Linux, and WSL2.
# curl -fsSL https://raw.githubusercontent.com/novaainet2025/neural-cli-orchestrator/main/bootstrap.sh | bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly DEFAULT_REPO_URL="https://github.com/novaainet2025/neural-cli-orchestrator.git"
readonly REPO_URL="${NCO_REPO_URL:-$DEFAULT_REPO_URL}"
readonly REPO_BRANCH="${NCO_REPO_BRANCH:-main}"
readonly INSTALL_DIR="${NCO_INSTALL_DIR:-$HOME/nco}"

fail() {
  printf 'NCO install error: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git이 필요합니다."
command -v bash >/dev/null 2>&1 || fail "bash가 필요합니다."
command -v curl >/dev/null 2>&1 || fail "curl이 필요합니다."

if [[ -e "$INSTALL_DIR" ]] && [[ ! -d "$INSTALL_DIR/.git" ]]; then
  fail "설치 경로가 비어 있지 않고 Git 저장소도 아닙니다: $INSTALL_DIR"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  current_origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$current_origin" == "$REPO_URL" ]] \
    || fail "기존 저장소 origin이 다릅니다: $current_origin"
  current_branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
  [[ "$current_branch" == "$REPO_BRANCH" ]] \
    || fail "기존 저장소 브랜치가 $REPO_BRANCH 이 아닙니다: ${current_branch:-detached}"

  # Runtime data or user edits may make the checkout dirty. Never stash/reset them.
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null)" ]]; then
    printf 'NCO: 로컬 변경을 보존하기 위해 Git 업데이트를 건너뜁니다: %s\n' "$INSTALL_DIR"
  else
    printf 'NCO: %s 브랜치를 fast-forward 갱신합니다.\n' "$REPO_BRANCH"
    git -C "$INSTALL_DIR" fetch origin "$REPO_BRANCH"
    git -C "$INSTALL_DIR" merge-base --is-ancestor HEAD FETCH_HEAD \
      || fail "로컬 커밋을 보존하기 위해 업데이트를 중단합니다: $INSTALL_DIR"
    git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD
  fi
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  printf 'NCO: %s 에 저장소를 설치합니다.\n' "$INSTALL_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

[[ -f "$INSTALL_DIR/setup.sh" ]] \
  || fail "setup.sh를 찾을 수 없습니다: $INSTALL_DIR"

# Fast backend deployment by default. Set NCO_INSTALL_AGENTS=1 for all AI CLIs.
setup_args=(--no-interactive --skip-ollama)
if [[ "${NCO_INSTALL_AGENTS:-0}" != "1" ]]; then
  setup_args+=(--skip-agents)
fi

exec bash "$INSTALL_DIR/setup.sh" "${setup_args[@]}" "$@"
