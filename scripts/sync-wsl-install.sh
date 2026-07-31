#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  wsl-install 사본 동기화 — nco(정본) → gentop-ai(배포 사본)               ║
# ║                                                                          ║
# ║  같은 설치 스크립트가 두 저장소에 있다:                                     ║
# ║    정본 : neural-cli-orchestrator/wsl-install/                            ║
# ║    사본 : gentop-ai/            (설치 파일 배포용)                         ║
# ║  손으로 맞추면 반드시 갈라지므로, 드리프트 탐지와 반영을 이걸로 한다.        ║
# ║                                                                          ║
# ║  사용법:                                                                  ║
# ║    bash scripts/sync-wsl-install.sh            # 드리프트 검사만(기본)     ║
# ║    bash scripts/sync-wsl-install.sh --apply    # 정본 → 사본 복사          ║
# ║    bash scripts/sync-wsl-install.sh --push     # 복사 + 커밋 + push        ║
# ║    bash scripts/sync-wsl-install.sh --diff     # 검사 + 차이 내용 출력     ║
# ║                                                                          ║
# ║  환경변수:                                                                ║
# ║    GENTOP_DIR   사본 체크아웃 경로                                         ║
# ║                 (기본 $HOME/project/@@gentop/nova-use-install)             ║
# ║                                                                          ║
# ║  종료코드: 0=동일 · 1=드리프트 있음(검사 모드) · 2=사용 오류/환경 문제      ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; BLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; BLD=''; NC=''
fi
ok()   { echo "${GRN}  ✓${NC} $*"; }
warn() { echo "${YLW}  ⚠${NC} $*"; }
err()  { echo "${RED}  ✗${NC} $*" >&2; }
die()  { err "$*"; exit 2; }

MODE="check"
for a in "$@"; do
  case "$a" in
    --apply) MODE="apply" ;;
    --push)  MODE="push" ;;
    --diff)  MODE="diff" ;;
    --check) MODE="check" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "알 수 없는 옵션: $a" ;;
  esac
done

# 정본은 이 스크립트 위치 기준으로 찾는다 (어디서 실행하든 동작하게)
NCO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$NCO_DIR/wsl-install"
DST="${GENTOP_DIR:-$HOME/project/@@gentop/nova-use-install}"

[[ -d "$SRC" ]] || die "정본 없음: $SRC"
[[ -d "$DST" ]] || die "사본 체크아웃 없음: $DST  (GENTOP_DIR 로 지정하세요)"

# 동기화 대상 — 정본에만 있는 파일 목록을 고정한다.
# gentop-ai 에는 README.md(배포 안내)·.gitignore·latest*.yml 처럼 사본 전용 파일이
# 따로 있으므로, 디렉터리 통째 복사가 아니라 이 목록만 다룬다.
FILES=(
  install-wsl.sh
  verify-wsl.sh
  README-WSL.md
  env-templates/nco.env.template
  env-templates/nova-ax.env.template
)

echo "${BLD}wsl-install 사본 동기화${NC}"
echo "  정본: $SRC"
echo "  사본: $DST"
echo

# bash 3.2(macOS 기본)는 set -u 에서 빈 배열의 "${arr[@]}" 확장을 unbound 로 본다.
# Ubuntu 의 bash 5 는 통과하지만, 양쪽에서 도는 스크립트라 ${arr[@]+"${arr[@]}"} 로 감싼다.
DRIFT=(); MISSING=()
for f in "${FILES[@]}"; do
  if [[ ! -f "$SRC/$f" ]]; then err "정본에 없음: $f"; exit 2; fi
  if [[ ! -f "$DST/$f" ]]; then MISSING+=("$f"); continue; fi
  cmp -s "$SRC/$f" "$DST/$f" || DRIFT+=("$f")
done

for f in ${MISSING[@]+"${MISSING[@]}"}; do warn "사본에 없음: $f"; done
for f in ${DRIFT[@]+"${DRIFT[@]}"};  do warn "내용 다름:   $f"; done

if [[ "$MODE" == "diff" ]]; then
  for f in ${DRIFT[@]+"${DRIFT[@]}"}; do
    echo
    echo "${BLD}── diff $f  (좌=정본 nco, 우=사본 gentop-ai)${NC}"
    diff -u "$SRC/$f" "$DST/$f" | head -60
  done
fi

TOTAL=$(( ${#DRIFT[@]} + ${#MISSING[@]} ))
if [[ "$TOTAL" -eq 0 ]]; then
  ok "동일 — 드리프트 없음 (${#FILES[@]}개 파일)"
  exit 0
fi

if [[ "$MODE" == "check" || "$MODE" == "diff" ]]; then
  err "드리프트 ${TOTAL}건 — 반영하려면 --apply, 커밋·push 까지 하려면 --push"
  exit 1
fi

# ── 반영 ──────────────────────────────────────────────────────────────────
for f in ${DRIFT[@]+"${DRIFT[@]}"} ${MISSING[@]+"${MISSING[@]}"}; do
  mkdir -p "$(dirname "$DST/$f")"
  cp "$SRC/$f" "$DST/$f" || die "복사 실패: $f"
  [[ "$f" == *.sh ]] && chmod +x "$DST/$f"
  ok "반영: $f"
done

# 복사가 실제로 맞았는지 재대조 (cp 성공 메시지를 믿지 않는다)
for f in ${DRIFT[@]+"${DRIFT[@]}"} ${MISSING[@]+"${MISSING[@]}"}; do
  cmp -s "$SRC/$f" "$DST/$f" || die "반영 후에도 다름: $f"
done
ok "반영 후 재대조 통과 (${TOTAL}개 파일)"

[[ "$MODE" != "push" ]] && { echo; ok "완료 — 커밋은 직접 하거나 --push 를 쓰세요"; exit 0; }

# ── 커밋 + push ───────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git 없음"
git -C "$DST" rev-parse --git-dir >/dev/null 2>&1 || die "사본이 git 저장소가 아님: $DST"

# 정본 커밋을 메시지에 남겨 어느 시점을 반영한 것인지 추적 가능하게 한다
SRC_SHA="$(git -C "$NCO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# 명시 열거 add — add -A 금지(사본 전용 파일·빌드 산출물을 쓸어담지 않게)
CHANGED=(${DRIFT[@]+"${DRIFT[@]}"} ${MISSING[@]+"${MISSING[@]}"})
git -C "$DST" add -- "${CHANGED[@]}" || die "git add 실패"
if git -C "$DST" diff --cached --quiet; then
  ok "스테이징 변경 없음 — 커밋 생략"
  exit 0
fi
git -C "$DST" commit -q -m "sync(wsl-install): 정본 nco@${SRC_SHA} 반영

$(printf '  - %s\n' "${CHANGED[@]}")

정본: neural-cli-orchestrator/wsl-install/
생성: scripts/sync-wsl-install.sh --push" || die "커밋 실패"
ok "커밋: $(git -C "$DST" log -1 --format='%h %s' | head -c 70)"

git -C "$DST" push origin HEAD || die "push 실패 — 수동으로 push 하세요"
ok "push 완료"
