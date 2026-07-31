#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║   NOVA 생태계 — Windows WSL2(Ubuntu) 통합 설치 스크립트                   ║
# ║                                                                          ║
# ║   대상: nco (Neural CLI Orchestrator) · nova-ax · nco-dashboard          ║
# ║                                                                          ║
# ║   사용법:                                                                 ║
# ║     bash install-wsl.sh                        # 대화형 (프로바이더 선택) ║
# ║     bash install-wsl.sh --yes                  # 무인 설치(프로바이더 기본)║
# ║     bash install-wsl.sh --providers=codex,opencode,cursor-agent          ║
# ║     bash install-wsl.sh --all-providers        # CLI 전체 설치           ║
# ║     bash install-wsl.sh --no-providers         # CLI 설치 안 함          ║
# ║     bash install-wsl.sh --only=nco             # 특정 프로젝트만          ║
# ║     bash install-wsl.sh --skip-pm2             # PM2 기동 생략            ║
# ║                                                                          ║
# ║   환경변수 오버라이드:                                                     ║
# ║     NOVA_ROOT      설치 루트           (기본 $HOME/nova)                  ║
# ║     NCO_BRANCH     nco 브랜치          (기본 main)                        ║
# ║     AX_BRANCH      nova-ax 브랜치      (기본 main)                        ║
# ║     DASH_BRANCH    dashboard 브랜치    (기본 main)                        ║
# ║                                                                          ║
# ║   불변식: .env 절대 덮어쓰지 않음 · 재실행 멱등 · 시크릿 하드코딩 없음      ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── 색상/로그 ──────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'
  CYN=$'\033[0;36m'; BLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; CYN=''; BLD=''; NC=''
fi
ok()   { echo "${GRN}  ✓${NC} $*"; }
info() { echo "${CYN}  ▶${NC} $*"; }
warn() { echo "${YLW}  ⚠${NC} $*"; }
err()  { echo "${RED}  ✗${NC} $*" >&2; }
skip() { echo "${YLW}  ⏭${NC} $* ${YLW}(이미 완료 — skip)${NC}"; }
hdr()  { echo; echo "${BLD}${CYN}━━━ $* ━━━${NC}"; }
die()  { err "$*"; exit 1; }

# ── 단계 실행 헬퍼 ────────────────────────────────────────────────────────
# 주의: `set -e` 는 `cmd && ok "..."` 형태에서 cmd 실패를 조용히 넘긴다
# (AND-OR 리스트는 errexit 대상이 아님 — 실측 확인). 그래서 빌드/마이그레이션이
# 깨져도 스크립트가 성공으로 끝나버린다. 반드시 실패로 잡아야 하는 단계는
# run_step 으로, 실패해도 계속할 단계는 run_soft 로 감싼다.
in_dir()  { local d="$1"; shift; ( cd "$d" && "$@" ); }
run_step() { local msg="$1"; shift; if "$@"; then ok "$msg"; else die "실패: $msg   (명령: $*)"; fi; }
run_soft() { local msg="$1"; shift; if "$@"; then ok "$msg"; else warn "실패(계속 진행): $msg"; fi; return 0; }
pm2_up()  { local name="$1" dir="$2"; ( cd "$dir" && { pm2 restart "$name" >/dev/null 2>&1 || pm2 start dist/index.js --name "$name"; } ); }

# ── 기본값 ────────────────────────────────────────────────────────────────
NOVA_ROOT="${NOVA_ROOT:-$HOME/nova}"
# 2026-07-31: 세 저장소의 agent 브랜치를 모두 main 으로 통합했고, NCO-Dashboard 의
# GitHub 기본 브랜치도 master → main 으로 변경했다. 이제 셋 다 main 하나면 된다.
# (--branch 는 계속 명시한다 — 기본 브랜치가 또 바뀌어도 설치 결과가 흔들리지 않게)
NCO_BRANCH="${NCO_BRANCH:-main}"
AX_BRANCH="${AX_BRANCH:-main}"
DASH_BRANCH="${DASH_BRANCH:-main}"

NCO_REPO="https://github.com/novaainet2025/neural-cli-orchestrator.git"
AX_REPO="https://github.com/novaainet2025/nova-ax.git"
DASH_REPO="https://github.com/novaainet2025/NCO-Dashboard.git"

NODE_MAJOR=22
NVM_VERSION="v0.40.3"

ASSUME_YES=false
SKIP_PM2=false
PROVIDER_MODE="ask"        # ask | list | all | none
PROVIDER_LIST=""
ONLY=""                    # 빈값=전체, 아니면 nco|nova-ax|nco-dashboard 콤마목록

# ── 인수 파싱 ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    -y|--yes)            ASSUME_YES=true ;;
    --skip-pm2)          SKIP_PM2=true ;;
    --all-providers)     PROVIDER_MODE="all" ;;
    --no-providers)      PROVIDER_MODE="none" ;;
    --providers=*)       PROVIDER_MODE="list"; PROVIDER_LIST="${arg#*=}" ;;
    --only=*)            ONLY="${arg#*=}" ;;
    -h|--help)           sed -n '2,25p' "$0"; exit 0 ;;
    *)                   die "알 수 없는 옵션: $arg  (--help 참고)" ;;
  esac
done
# --yes 이고 프로바이더 지정이 없으면 기본 세트로 무인 설치
if [[ "$ASSUME_YES" == "true" && "$PROVIDER_MODE" == "ask" ]]; then
  PROVIDER_MODE="list"
  PROVIDER_LIST="claude-code,opencode,codex,cursor-agent"
fi
# 대화형 메뉴에서 엔터만 쳤을 때 쓰는 기본 세트 (아래 select_… 에서 참조)

want() {  # want <project> → 설치 대상인지
  [[ -z "$ONLY" ]] && return 0
  [[ ",$ONLY," == *",$1,"* ]]
}

# ══════════════════════════════════════════════════════════════════════════
# 0. 환경 점검
# ══════════════════════════════════════════════════════════════════════════
hdr "0. 환경 점검"

if grep -qi microsoft /proc/version 2>/dev/null; then
  ok "WSL2 감지됨 — $(grep -o 'Ubuntu[^ ]*' /etc/os-release 2>/dev/null | head -1 || echo Linux)"
else
  warn "WSL이 아닌 것 같습니다. 이 스크립트는 WSL2/Ubuntu 기준입니다."
  if [[ "$ASSUME_YES" != "true" ]]; then
    if [[ -t 0 ]]; then
      c=""; read -rp "  그래도 계속할까요? [y/N]: " c || true
      [[ "$c" =~ ^[Yy]$ ]] || exit 0
    else
      die "비대화형 실행인데 WSL이 아닙니다. 의도한 것이면 --yes 를 주세요."
    fi
  fi
fi

# WSL에서 Windows 파일시스템(/mnt/c)에 설치하면 npm/네이티브 빌드가 극도로 느리고
# 심볼릭링크·권한 문제가 발생한다. 반드시 WSL 네이티브 FS에 설치할 것.
# (환경 비의존 검사이므로 apt/sudo 확인보다 먼저 — 빨리 실패시킨다)
case "$NOVA_ROOT" in
  /mnt/*) die "NOVA_ROOT가 Windows 드라이브($NOVA_ROOT)입니다. WSL 네이티브 경로(\$HOME 하위)를 쓰세요." ;;
esac

command -v apt-get >/dev/null 2>&1 || die "apt-get이 없습니다. Ubuntu/Debian 계열 WSL이 필요합니다."
command -v sudo    >/dev/null 2>&1 || die "sudo가 필요합니다."

ok "설치 루트: $NOVA_ROOT"
mkdir -p "$NOVA_ROOT"

# ══════════════════════════════════════════════════════════════════════════
# 1. 시스템 패키지 (네이티브 모듈 빌드 도구)
# ══════════════════════════════════════════════════════════════════════════
hdr "1. 시스템 패키지"
# better-sqlite3 · hnswlib-node 는 node-gyp로 C++ 컴파일된다 → 빌드 도구 필수
APT_PKGS=(build-essential python3 python3-venv pkg-config curl git ca-certificates lsof jq)
MISSING=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [[ ${#MISSING[@]} -eq 0 ]]; then
  skip "빌드 도구 (${APT_PKGS[*]})"
else
  info "설치 중: ${MISSING[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${MISSING[@]}"
  ok "빌드 도구 설치 완료"
fi

# ══════════════════════════════════════════════════════════════════════════
# 2. Node.js 22+ (nvm — nco/setup.sh와 동일 방식)
# ══════════════════════════════════════════════════════════════════════════
hdr "2. Node.js ${NODE_MAJOR}+"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() { [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"; }

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

load_nvm || true
if [[ "$(node_major)" -ge "$NODE_MAJOR" ]]; then
  skip "Node $(node -v)"
else
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    info "nvm 설치 중..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    load_nvm
  fi
  load_nvm
  info "Node ${NODE_MAJOR} 설치 중..."
  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
  [[ "$(node_major)" -ge "$NODE_MAJOR" ]] || die "Node ${NODE_MAJOR}+ 설치 실패"
  ok "Node $(node -v) / npm $(npm -v)"
fi

# ══════════════════════════════════════════════════════════════════════════
# 3. Redis (nco의 bullmq/ioredis가 필수로 요구)
# ══════════════════════════════════════════════════════════════════════════
hdr "3. Redis"
if ! command -v redis-server >/dev/null 2>&1; then
  info "redis-server 설치 중..."
  sudo apt-get install -y redis-server
else
  skip "redis-server 설치됨"
fi

start_redis() {
  redis-cli ping >/dev/null 2>&1 && return 0
  # WSL은 systemd가 꺼져 있는 경우가 많다 → service → 직접 실행 순으로 폴백
  sudo systemctl enable --now redis-server >/dev/null 2>&1 && sleep 1
  redis-cli ping >/dev/null 2>&1 && return 0
  sudo service redis-server start >/dev/null 2>&1 && sleep 1
  redis-cli ping >/dev/null 2>&1 && return 0
  redis-server --daemonize yes --loglevel warning >/dev/null 2>&1 && sleep 1
  redis-cli ping >/dev/null 2>&1
}
if start_redis; then
  ok "Redis 응답 확인 (redis-cli ping → PONG)"
else
  die "Redis를 기동하지 못했습니다. 'sudo service redis-server start' 후 재실행하세요."
fi

# ══════════════════════════════════════════════════════════════════════════
# 4. 저장소 클론 / 갱신
# ══════════════════════════════════════════════════════════════════════════
clone_or_update() {  # clone_or_update <dir> <repo> <branch>
  local dir="$1" repo="$2" br="$3"
  if [[ -d "$dir/.git" ]]; then
    info "$(basename "$dir"): 기존 checkout 발견 — 갱신 시도"
    if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
      warn "$(basename "$dir"): 로컬 변경이 있어 git 갱신을 건너뜁니다 (현재 코드 유지)"
    else
      git -C "$dir" fetch --depth=1 origin "$br"
      git -C "$dir" checkout -q -B "$br" "origin/$br"
      ok "$(basename "$dir") → $br @ $(git -C "$dir" rev-parse --short HEAD)"
    fi
  else
    info "$(basename "$dir"): clone ($br)"
    # --branch 를 계속 명시한다: 기본 브랜치 설정이 바뀌어도 설치 결과가 흔들리지 않게
    git clone --branch "$br" --single-branch "$repo" "$dir"
    ok "$(basename "$dir") → $br @ $(git -C "$dir" rev-parse --short HEAD)"
  fi
}

hdr "4. 저장소 클론"
want nco           && clone_or_update "$NOVA_ROOT/nco"           "$NCO_REPO"  "$NCO_BRANCH"
want nova-ax       && clone_or_update "$NOVA_ROOT/nova-ax"       "$AX_REPO"   "$AX_BRANCH"
want nco-dashboard && clone_or_update "$NOVA_ROOT/nco-dashboard" "$DASH_REPO" "$DASH_BRANCH"

# ══════════════════════════════════════════════════════════════════════════
# 5. .env 준비 (존재하면 절대 덮어쓰지 않음)
# ══════════════════════════════════════════════════════════════════════════
hdr "5. 환경변수(.env) 준비"
TPL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env-templates"

place_env() {  # place_env <project_dir> <template_file>
  local proj="$1" tpl="$2"
  [[ -d "$proj" ]] || return 0
  if [[ -f "$proj/.env" ]]; then
    skip "$(basename "$proj")/.env 존재 — 보존"
    return 0
  fi
  if [[ -f "$proj/.env.example" ]]; then
    cp "$proj/.env.example" "$proj/.env"
    ok "$(basename "$proj")/.env 생성 (.env.example 기반)"
  elif [[ -f "$tpl" ]]; then
    cp "$tpl" "$proj/.env"
    ok "$(basename "$proj")/.env 생성 (템플릿 기반)"
  else
    warn "$(basename "$proj"): .env 템플릿을 찾지 못했습니다 — 수동 생성 필요"
    return 0
  fi
  # WSL 경로로 보정 (macOS 경로가 박혀 있을 수 있음)
  sed -i "s#^PROJECT_DIR=.*#PROJECT_DIR=$NOVA_ROOT#" "$proj/.env" 2>/dev/null || true
  ENV_NEEDS_KEYS=true
}
ENV_NEEDS_KEYS=false
want nco     && place_env "$NOVA_ROOT/nco"     "$TPL_DIR/nco.env.template"
want nova-ax && place_env "$NOVA_ROOT/nova-ax" "$TPL_DIR/nova-ax.env.template"
# nco-dashboard는 .env를 읽지 않는다 (vite proxy + 소스 하드코딩) → 생성 안 함

# ══════════════════════════════════════════════════════════════════════════
# 6. AI 프로바이더 CLI 선택 설치
# ══════════════════════════════════════════════════════════════════════════
# nco의 cli-installs/install-all.sh 가 개별 tool 인자를 지원한다:
#   bash install-all.sh <tool>
# 아래 목록은 그 스크립트가 실제로 지원하는 이름과 1:1 대응한다.
PROVIDERS_AVAIL=(claude-code opencode codex cursor-agent copilot gemini-cli aider ollama gemini-api)
provider_desc() {
  case "$1" in
    claude-code)  echo "Claude Code CLI      — NCO 기본 두뇌" ;;
    opencode)     echo "OpenCode             — 설계·아키텍처" ;;
    codex)        echo "Codex CLI            — 구현·버그 (hermes 프로바이더도 이 CLI를 공유)" ;;
    cursor-agent) echo "Cursor Agent         — 코드 리뷰·보안" ;;
    copilot)      echo "GitHub Copilot CLI   — 리서치·문서" ;;
    gemini-cli)   echo "Gemini CLI           — 범용" ;;
    aider)        echo "Aider                — 페어 프로그래밍" ;;
    ollama)       echo "Ollama               — 로컬 LLM (GPU 없으면 매우 느림)" ;;
    gemini-api)   echo "google-genai SDK     — Python SDK만 (CLI 아님)" ;;
    *)            echo "" ;;
  esac
}

PROVIDER_DEFAULT="claude-code opencode codex cursor-agent"

select_providers_interactive() {
  # stdin이 TTY가 아니면(예: curl ... | bash, CI) 메뉴를 띄울 수 없다.
  # read가 EOF로 실패하면 set -e에 걸려 설치 전체가 죽으므로 기본값으로 진행한다.
  if [[ ! -t 0 ]]; then
    warn "비대화형 입력 — 프로바이더 기본 세트로 진행: $PROVIDER_DEFAULT"
    warn "다르게 하려면 --providers=... / --all-providers / --no-providers 를 쓰세요."
    PROVIDER_LIST="$PROVIDER_DEFAULT"
    return 0
  fi
  echo
  echo "  ${BLD}설치할 AI 프로바이더 CLI를 고르세요${NC}"
  echo "  (번호를 공백/콤마로 구분해 입력 · 'a'=전체 · 엔터=기본 1 2 3 4 · 'n'=설치 안 함)"
  echo
  local i=1
  for p in "${PROVIDERS_AVAIL[@]}"; do
    printf "    %2d) %-14s %s\n" "$i" "$p" "$(provider_desc "$p")"
    i=$((i+1))
  done
  echo
  local reply=""
  read -rp "  선택: " reply || reply=""
  reply="${reply//,/ }"
  if [[ -z "${reply// /}" ]]; then
    PROVIDER_LIST="$PROVIDER_DEFAULT"
  elif [[ "$reply" == "a" || "$reply" == "A" ]]; then
    PROVIDER_LIST="${PROVIDERS_AVAIL[*]}"
  elif [[ "$reply" == "n" || "$reply" == "N" ]]; then
    PROVIDER_LIST=""
  else
    local sel=""
    for tok in $reply; do
      if [[ "$tok" =~ ^[0-9]+$ ]] && (( tok >= 1 && tok <= ${#PROVIDERS_AVAIL[@]} )); then
        sel+="${PROVIDERS_AVAIL[$((tok-1))]} "
      else
        warn "무시된 입력: $tok"
      fi
    done
    PROVIDER_LIST="$sel"
  fi
}

hdr "6. AI 프로바이더 CLI"
INSTALLER="$NOVA_ROOT/nco/cli-installs/install-all.sh"
if ! want nco || [[ ! -f "$INSTALLER" ]]; then
  warn "nco/cli-installs/install-all.sh 없음 — 프로바이더 설치 건너뜀"
  PROVIDER_LIST=""
else
  case "$PROVIDER_MODE" in
    none) info "프로바이더 설치 안 함 (--no-providers)"; PROVIDER_LIST="" ;;
    all)  PROVIDER_LIST="${PROVIDERS_AVAIL[*]}" ;;
    list) PROVIDER_LIST="${PROVIDER_LIST//,/ }" ;;
    ask)  select_providers_interactive ;;
  esac

  INSTALLED_OK=(); INSTALLED_FAIL=()
  for p in $PROVIDER_LIST; do
    # 지원 목록 검증 — 오타로 install-all.sh의 usage만 찍고 끝나는 것 방지
    found=false
    for a in "${PROVIDERS_AVAIL[@]}"; do [[ "$a" == "$p" ]] && found=true && break; done
    if [[ "$found" != "true" ]]; then
      warn "지원하지 않는 프로바이더: $p (건너뜀)"
      INSTALLED_FAIL+=("$p:unsupported")
      continue
    fi
    info "설치: $p"
    if bash "$INSTALLER" "$p"; then
      INSTALLED_OK+=("$p")
    else
      # 리밋/네트워크/인증 실패가 전체 설치를 죽이지 않게 한다
      warn "$p 설치 실패 — 계속 진행 (나중에: bash $INSTALLER $p)"
      INSTALLED_FAIL+=("$p:failed")
    fi
  done
  [[ ${#INSTALLED_OK[@]}   -gt 0 ]] && ok   "설치 성공: ${INSTALLED_OK[*]}"
  [[ ${#INSTALLED_FAIL[@]} -gt 0 ]] && warn "설치 실패/제외: ${INSTALLED_FAIL[*]}"
fi

# ══════════════════════════════════════════════════════════════════════════
# 7. nco 빌드 & 마이그레이션
# ══════════════════════════════════════════════════════════════════════════
npm_install() {  # npm_install <dir>
  local d="$1"
  if [[ -f "$d/package-lock.json" ]]; then
    # nco의 불변식: npm ci 사용, --legacy-peer-deps 금지
    ( cd "$d" && npm ci )
  else
    ( cd "$d" && npm install )
  fi
}

if want nco && [[ -d "$NOVA_ROOT/nco" ]]; then
  hdr "7. nco 설치"
  info "의존성 설치 (better-sqlite3 · hnswlib-node 네이티브 빌드 포함, 수 분 소요)"
  npm_install "$NOVA_ROOT/nco"
  ok "npm 의존성 설치 완료"

  # WSL 프로바이더 정책 패치 (Mac 전용 설정을 WSL 기준으로 정정)
  if [[ -f "$NOVA_ROOT/nco/config/platform-patch.wsl.sh" ]]; then
    info "WSL 프로바이더 정책 패치 적용"
    # GPU가 있고 ollama를 설치했다면 --gpu 로 ollama까지 활성화
    if [[ " $PROVIDER_LIST " == *" ollama "* ]] && command -v nvidia-smi >/dev/null 2>&1; then
      run_soft "platform-patch (GPU 모드: ollama 활성)" bash "$NOVA_ROOT/nco/config/platform-patch.wsl.sh" --gpu
    else
      run_soft "platform-patch (CPU 모드: ollama 비활성)" bash "$NOVA_ROOT/nco/config/platform-patch.wsl.sh"
    fi
  fi

  info "TypeScript 빌드"
  run_step "nco 빌드 완료" in_dir "$NOVA_ROOT/nco" npm run build
  info "DB 마이그레이션"
  run_step "nco 마이그레이션 완료" in_dir "$NOVA_ROOT/nco" npm run migrate
fi

# ══════════════════════════════════════════════════════════════════════════
# 8. nova-ax 설치
# ══════════════════════════════════════════════════════════════════════════
if want nova-ax && [[ -d "$NOVA_ROOT/nova-ax" ]]; then
  hdr "8. nova-ax 설치"
  npm_install "$NOVA_ROOT/nova-ax"
  run_step "nova-ax 빌드 완료" in_dir "$NOVA_ROOT/nova-ax" npm run build
fi

# ══════════════════════════════════════════════════════════════════════════
# 9. nco-dashboard 설치
# ══════════════════════════════════════════════════════════════════════════
if want nco-dashboard && [[ -d "$NOVA_ROOT/nco-dashboard" ]]; then
  hdr "9. nco-dashboard 설치"
  npm_install "$NOVA_ROOT/nco-dashboard"
  run_step "dashboard 빌드 완료" in_dir "$NOVA_ROOT/nco-dashboard" npm run build
  # vite.config.ts의 /local/mac-memory 미들웨어는 macOS 전용 명령(sysctl/vm_stat/
  # memory_pressure)을 쓴다. try/catch 안이라 dev 서버 기동은 되지만 해당 엔드포인트만
  # WSL에서 실패한다 → 대시보드의 메모리 위젯이 빈 값으로 보인다.
  warn "dashboard: /local/mac-memory 엔드포인트는 macOS 전용 — WSL에서 메모리 위젯만 동작하지 않습니다 (나머지 정상)"
fi

# ══════════════════════════════════════════════════════════════════════════
# 10. PM2 기동
# ══════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_PM2" == "false" ]] && want nco && [[ -d "$NOVA_ROOT/nco" ]]; then
  hdr "10. 서비스 기동 (PM2)"
  command -v pm2 >/dev/null 2>&1 || { info "PM2 설치 중..."; npm install --global pm2@^6.0.0; }
  run_step "nco 기동" pm2_up nco "$NOVA_ROOT/nco"
  if want nova-ax && [[ -d "$NOVA_ROOT/nova-ax/dist" ]]; then
    run_step "nova-ax 기동" pm2_up nova-ax "$NOVA_ROOT/nova-ax"
  fi
  pm2 save >/dev/null 2>&1 || true
fi

# ══════════════════════════════════════════════════════════════════════════
# 11. 헬스체크 (실패 시 비0 종료)
# ══════════════════════════════════════════════════════════════════════════
hdr "11. 헬스체크"
FAILED=0
check_http() {  # check_http <이름> <url> <최대대기초>
  local name="$1" url="$2" max="${3:-60}" i=0
  while (( i < max )); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "$name → $url 응답 OK"
      return 0
    fi
    sleep 2; i=$((i+2))
  done
  err "$name → $url 무응답 (${max}s)"
  FAILED=$((FAILED+1)); return 1
}

redis-cli ping >/dev/null 2>&1 && ok "redis → PONG" || { err "redis 무응답"; FAILED=$((FAILED+1)); }
if [[ "$SKIP_PM2" == "false" ]]; then
  want nco     && check_http "nco"     "http://127.0.0.1:6200/health" 90 || true
  want nova-ax && [[ -d "$NOVA_ROOT/nova-ax/dist" ]] && check_http "nova-ax" "http://127.0.0.1:6300/health" 45 || true
fi

# ══════════════════════════════════════════════════════════════════════════
# 마무리
# ══════════════════════════════════════════════════════════════════════════
hdr "완료 요약"
echo "  설치 루트 : $NOVA_ROOT"
want nco           && echo "  nco            : $NCO_BRANCH        (API :6200 · WS :6201)"
want nova-ax       && echo "  nova-ax        : $AX_BRANCH   (:6300)"
want nco-dashboard && echo "  nco-dashboard  : $DASH_BRANCH (:5173)"
[[ -n "${PROVIDER_LIST// /}" ]] && echo "  프로바이더 CLI : ${PROVIDER_LIST}"
echo
echo "  대시보드 실행:"
echo "    cd $NOVA_ROOT/nco-dashboard && npm run dev -- --host"
echo "    → Windows 브라우저에서 http://localhost:5173"
echo
if [[ "$ENV_NEEDS_KEYS" == "true" ]]; then
  warn "새로 만든 .env에 API 키가 비어 있습니다. 아래 파일을 열어 값을 채우세요:"
  want nco     && echo "    $NOVA_ROOT/nco/.env      (ANTHROPIC_API_KEY · OPENAI_API_KEY · NCO_API_TOKEN …)"
  want nova-ax && echo "    $NOVA_ROOT/nova-ax/.env  (AX_API_TOKEN · AX_NCO_SECRET)"
  echo "    수정 후: pm2 restart nco nova-ax"
fi
echo
if (( FAILED > 0 )); then
  err "헬스체크 실패 ${FAILED}건 — 위 로그를 확인하세요 (README-WSL.md 트러블슈팅 참고)"
  exit 1
fi
ok "모든 헬스체크 통과"
