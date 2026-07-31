#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  NOVA 생태계 — WSL2 설치 검증 스크립트                                     ║
# ║                                                                          ║
# ║  install-wsl.sh 실행 후 "정말 동작하는가"를 지상진실로 확인한다.            ║
# ║  프로세스 존재(T2)가 아니라 HTTP 응답 본문·파일 실재(T1)까지 확인.          ║
# ║                                                                          ║
# ║  사용법:  bash verify-wsl.sh                                              ║
# ║  종료코드: 0=전체통과 · 1=실패항목 있음                                    ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -uo pipefail   # -e 미사용: 개별 검사 실패해도 끝까지 돌려 전체 그림을 본다

NOVA_ROOT="${NOVA_ROOT:-$HOME/nova}"

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; BLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; BLD=''; NC=''
fi

PASS=0; FAIL=0; WARN=0
pass() { echo "${GRN}  PASS${NC}  $*"; PASS=$((PASS+1)); }
fail() { echo "${RED}  FAIL${NC}  $*"; FAIL=$((FAIL+1)); }
warn() { echo "${YLW}  WARN${NC}  $*"; WARN=$((WARN+1)); }
sec()  { echo; echo "${BLD}── $* ──${NC}"; }

sec "1. 런타임 전제조건"
if grep -qi microsoft /proc/version 2>/dev/null; then pass "WSL2 환경"; else warn "WSL이 아님"; fi

NODE_MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [[ "$NODE_MAJ" -ge 22 ]]; then pass "Node $(node -v) (>=22 요구 충족)"
else fail "Node 버전 부족: $(node -v 2>/dev/null || echo 없음) — nco engines는 >=22"; fi

if redis-cli ping 2>/dev/null | grep -q PONG; then pass "Redis 응답 PONG"
else fail "Redis 무응답 — 'sudo service redis-server start'"; fi

sec "2. 저장소 체크아웃"
check_repo() {  # check_repo <이름> <경로> <기대브랜치>
  local n="$1" d="$2" want="$3"
  if [[ ! -d "$d/.git" ]]; then fail "$n: $d 없음"; return; fi
  local br; br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  local sha; sha=$(git -C "$d" rev-parse --short HEAD 2>/dev/null)
  if [[ "$br" == "$want" ]]; then pass "$n: $br @ $sha"
  else warn "$n: 브랜치가 $br (기대: $want) @ $sha"; fi
  local dirty; dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [[ "$dirty" == "0" ]] || warn "$n: 로컬 변경 ${dirty}건 (런타임이 기록 중이면 정상)"
}
check_repo nco           "$NOVA_ROOT/nco"           "${NCO_BRANCH:-main}"
check_repo nova-ax       "$NOVA_ROOT/nova-ax"       "${AX_BRANCH:-main}"
check_repo nco-dashboard "$NOVA_ROOT/nco-dashboard" "${DASH_BRANCH:-main}"

sec "3. 네이티브 모듈 (실제 로드까지 확인)"
# 파일 존재(T2)가 아니라 require 성공(T1)을 본다 — 아키텍처 불일치는 로드 시점에만 드러남
for pair in "nco:better-sqlite3" "nco:hnswlib-node" "nova-ax:better-sqlite3"; do
  proj="${pair%%:*}"; mod="${pair##*:}"
  d="$NOVA_ROOT/$proj"
  [[ -d "$d/node_modules/$mod" ]] || { fail "$proj: $mod 미설치"; continue; }
  if ( cd "$d" && node -e "require('$mod')" >/dev/null 2>&1 ); then
    pass "$proj: $mod require() 성공"
  else
    fail "$proj: $mod 로드 실패 — 네이티브 재빌드 필요 (npm rebuild $mod)"
  fi
done

sec "4. 빌드 산출물"
[[ -f "$NOVA_ROOT/nco/dist/index.js" ]]           && pass "nco/dist/index.js 존재"           || fail "nco 빌드 안 됨 (npm run build)"
[[ -f "$NOVA_ROOT/nova-ax/dist/index.js" ]]       && pass "nova-ax/dist/index.js 존재"       || fail "nova-ax 빌드 안 됨"
[[ -d "$NOVA_ROOT/nco-dashboard/dist" ]]          && pass "nco-dashboard/dist 존재"          || warn "dashboard 빌드 안 됨 (dev 모드만 쓸 거면 무시)"

sec "5. 서비스 HTTP 응답 (본문까지 확인 = T1)"
body=$(curl -fsS --max-time 5 http://127.0.0.1:6200/health 2>/dev/null)
if echo "$body" | grep -q '"status"'; then
  pass "nco /health → $(echo "$body" | head -c 120)"
else
  fail "nco /health 무응답 또는 형식 이상 — pm2 logs nco"
fi

body=$(curl -fsS --max-time 5 http://127.0.0.1:6300/health 2>/dev/null)
if [[ -n "$body" ]]; then pass "nova-ax /health → $(echo "$body" | head -c 120)"
else warn "nova-ax /health 무응답 (nova-ax를 안 띄웠으면 정상)"; fi

sec "6. .env 설정 완성도"
check_env() {  # check_env <파일> <필수키...>
  local f="$1"; shift
  [[ -f "$f" ]] || { fail "$f 없음"; return; }
  local missing=()
  for k in "$@"; do
    local v; v=$(grep -E "^${k}=" "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    # 비어 있거나 <플레이스홀더> 그대로면 미설정으로 본다
    if [[ -z "$v" || "$v" == \<*\> ]]; then missing+=("$k"); fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then pass "$(basename "$(dirname "$f")")/.env 필수키 채워짐"
  else warn "$(basename "$(dirname "$f")")/.env 미설정: ${missing[*]}"; fi
}
check_env "$NOVA_ROOT/nco/.env"     PORT REDIS_URL NCO_API_TOKEN
check_env "$NOVA_ROOT/nova-ax/.env" AX_PORT AX_API_TOKEN AX_NCO_SECRET

sec "7. 프로바이더 CLI"
FOUND=(); ABSENT=()
for c in claude opencode codex cursor-agent copilot gemini aider ollama; do
  if command -v "$c" >/dev/null 2>&1; then FOUND+=("$c"); else ABSENT+=("$c"); fi
done
[[ ${#FOUND[@]}  -gt 0 ]] && pass "설치됨: ${FOUND[*]}"  || warn "설치된 프로바이더 CLI 없음"
[[ ${#ABSENT[@]} -gt 0 ]] && echo "        미설치: ${ABSENT[*]}"
# NCO가 실제로 어떤 프로바이더를 온라인으로 보는지 = 지상진실
online=$(curl -fsS --max-time 5 http://127.0.0.1:6200/api/agents 2>/dev/null \
  | jq -r '.agents[]? | "\(.id):\(.status)"' 2>/dev/null | tr '\n' ' ')
[[ -n "$online" ]] && pass "NCO가 인식한 에이전트: $online" || warn "NCO /api/agents 조회 실패"

sec "8. Claude Code 설정 (설정·상태바·훅·커맨드)"
SET="$HOME/.claude/settings.json"
if [[ ! -f "$SET" ]]; then
  warn "~/.claude/settings.json 없음 — Claude 설정 미적용 (install-wsl.sh --claude-config)"
else
  if command -v jq >/dev/null 2>&1 && jq empty "$SET" >/dev/null 2>&1; then
    pass "settings.json 유효한 JSON"
    sl=$(jq -r '.statusLine.command // empty' "$SET")
    if [[ -n "$sl" ]]; then
      # 설정만 있고 스크립트가 없으면 상태바는 빈 줄로 뜬다 → 파일 실재까지 확인
      slp=$(awk '{for(i=1;i<=NF;i++) if($i ~ /statusline.*\.sh$/) print $i}' <<<"$sl" | head -1)
      if [[ -n "$slp" && -f "$slp" ]]; then pass "statusLine → $slp (스크립트 실재)"
      else fail "statusLine 이 없는 스크립트를 가리킴: ${slp:-<파싱실패>}"; fi
    else
      warn "statusLine 미설정 — 상태바가 표시되지 않습니다"
    fi
    n=$(jq '[.hooks // {} | .[][]? | .hooks[]?] | length' "$SET" 2>/dev/null || echo 0)
    [[ "$n" -gt 0 ]] && pass "settings.json 등록 훅 ${n}개" || warn "settings.json 에 훅 미등록"
    # 등록된 훅이 실제 파일로 존재하는지 (경로만 남고 파일이 없는 상태를 잡는다)
    miss=0
    while IFS= read -r c; do
      f=$(awk '{for(i=1;i<=NF;i++) if($i ~ /\.sh$/) print $i}' <<<"$c" | head -1)
      f="${f/#\~/$HOME}"
      [[ -n "$f" && ! -f "$f" ]] && miss=$((miss+1))
    done < <(jq -r '[.hooks // {} | .[][]? | .hooks[]?.command // empty] | .[]' "$SET" 2>/dev/null)
    [[ "$miss" -eq 0 ]] && pass "등록 훅의 스크립트 파일 전부 실재" || fail "등록됐지만 파일이 없는 훅 ${miss}건"
  else
    fail "settings.json 파싱 실패 (jq 없음 또는 JSON 오류)"
  fi
fi
nh=$(find "$HOME/.claude/hooks"    -maxdepth 1 -name '*.sh' 2>/dev/null | wc -l | tr -d ' ')
nc=$(find "$HOME/.claude/commands" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
ns=$(find "$HOME/.claude/skills"   -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
[[ "$nh" -gt 0 ]] && pass "훅 파일 ${nh}개"         || warn "~/.claude/hooks 비어 있음"
[[ "$nc" -gt 0 ]] && pass "슬래시 커맨드 ${nc}개"   || warn "~/.claude/commands 비어 있음"
[[ "$ns" -gt 0 ]] && pass "스킬 ${ns}개"            || warn "~/.claude/skills 비어 있음"
command -v claude >/dev/null 2>&1 && pass "claude CLI 설치됨" \
  || warn "claude CLI 미설치 — 설정은 깔렸지만 쓸 CLI 가 없습니다"

sec "결과"
echo "  PASS=$PASS  FAIL=$FAIL  WARN=$WARN"
if (( FAIL > 0 )); then
  echo "${RED}  검증 실패 — README-WSL.md 트러블슈팅을 참고하세요.${NC}"
  exit 1
fi
echo "${GRN}  전체 통과${NC}"
