#!/usr/bin/env bash
# team-runner.sh — 조직/팀 자율 업무 디스패처
# charter(상시 임무)가 있는 모든 팀을 순회하며 일일 태스크를 자동 생성·팀 연결한다.
# 관리 주체: organizations.manager(두뇌 세션)가 charter를 정의, 이 러너가 대행 실행.
#
# ⚠ 로컬 LLM 순차 실행 규칙 (2026-07-07 사용자 지시, 통합 메모리 Mac):
#   mlx/ollama 등 로컬 모델의 동시 추론은 통합 메모리를 고갈시킨다.
#   - 팀별로 "순차" 실행: 이전 팀 태스크가 종료(completed/failed)한 후에만 다음 팀 진행
#   - /tmp/nova-local-llm.lock 파일락으로 다른 스크립트(daily-blog-promo 등)와도 직렬화
set -euo pipefail

NCO_DIR="/Users/nova-ai/project/nco"
API_BASE="http://localhost:6200/api"
LOG_FILE="${NCO_DIR}/logs/team-runner.log"
STATE_DIR="${NCO_DIR}/data/team-runner"
LOCK_FILE="/tmp/nova-local-llm.lock"
POLL_INTERVAL=10
MAX_POLLS=42   # 팀당 최대 7분
# 로컬 모델 우선 체인 (무료·로컬 우선 — 두뇌는 유료, 워커는 로컬 원칙)
# 2026-07-12: ollama가 현재 에이전트 레지스트리에 미등록(POST /api/task → "Unknown agent 'ollama'")이라
#   전 체인 실패의 원인이었다. 게이트 가용한 로컬 무료 워커 hermes로 교체. ollama 재등록 시 되돌릴 것.
AI_CHAIN="mlx hermes openrouter"

mkdir -p "${STATE_DIR}" "$(dirname "${LOG_FILE}")"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

log() { printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${*:2}" | tee -a "${LOG_FILE}"; }

# ── 로컬 LLM 직렬화 락 (통합 메모리 보호) — 최대 20분 대기 후 진행 ──
acquire_lock() {
  local waited=0
  while [ -e "${LOCK_FILE}" ] && [ ${waited} -lt 1200 ]; do
    # 죽은 소유자 정리 (pid 파일 내용 확인)
    local owner; owner=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
    if [ -n "${owner}" ] && ! kill -0 "${owner}" 2>/dev/null; then
      log WARN "죽은 락 소유자(pid=${owner}) 정리"
      rm -f "${LOCK_FILE}"
      break
    fi
    sleep 15; waited=$((waited + 15))
  done
  echo $$ > "${LOCK_FILE}"
}
release_lock() { [ "$(cat "${LOCK_FILE}" 2>/dev/null)" = "$$" ] && rm -f "${LOCK_FILE}"; }
trap 'release_lock; rm -rf "${TMP_DIR}"' EXIT

# ── charter 있는 팀 목록 ──
curl -fsS "${API_BASE}/teams" -o "${TMP_DIR}/teams.json"
python3 - "${TMP_DIR}" <<'PY'
import json, sys, os
tmp = sys.argv[1]
teams = json.load(open(os.path.join(tmp, "teams.json")))["teams"]
# charter가 '@전담러너'로 시작하는 팀은 별도 전용 스크립트(예: daily-blog-promo.sh)가
# 담당하므로 이 범용 러너에서는 제외한다 (중복 태스크 방지 규약).
runnable = [
    {"id": t["id"], "name": t["name"], "lead": t.get("lead") or "", "charter": t.get("charter") or ""}
    for t in teams
    if (t.get("charter") or "").strip() and not (t.get("charter") or "").strip().startswith("@전담러너")
]
json.dump(runnable, open(os.path.join(tmp, "runnable.json"), "w"), ensure_ascii=False)
print(len(runnable))
PY
N_TEAMS=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "${TMP_DIR}/runnable.json")
log INFO "charter 보유 팀: ${N_TEAMS}개"
[ "${N_TEAMS}" = "0" ] && { log INFO "실행할 팀 없음 — 종료"; exit 0; }

TODAY=$(date '+%Y-%m-%d')

# 현재 에이전트 레지스트리 (2026-07-12): lead/chain에 레지스트리에 없는 에이전트(예: 미등록 ollama)가
#   있으면 매 팀마다 헛된 400 '생성 거부'가 발생한다. 알려진 목록을 미리 받아 스킵한다.
KNOWN_AIS=$(curl -fsS "${API_BASE}/agents" 2>/dev/null \
  | python3 -c 'import json,sys; print(" ".join(a.get("id","") for a in json.load(sys.stdin).get("agents",[])))' 2>/dev/null || echo "")
[ -n "${KNOWN_AIS}" ] && log INFO "레지스트리 에이전트: ${KNOWN_AIS}"

create_task() { # $1=ai $2=teamId(에서 charter/lead 로드) → taskId
  python3 - "$1" "$2" "${TMP_DIR}/runnable.json" "${NCO_DIR}" <<'PY' > "${TMP_DIR}/body.json"
import json, sys, glob, os, re, datetime
ai, team_id, path = sys.argv[1], sys.argv[2], sys.argv[3]
project_dir = sys.argv[4] if len(sys.argv) > 4 else "/Users/nova-ai/project/nco"
team = next(t for t in json.load(open(path)) if t["id"] == team_id)
charter = team["charter"]

# charter placeholder 치환 규약:
#   {{today}}           → 오늘 날짜 (워커가 학습 시점 날짜를 쓰는 오류 방지)
#   {{latest:GLOB}}     → 글롭 매칭 최신 파일 내용 앞 4000자 삽입
#                         (API 모델은 파일시스템 접근 불가 → 러너가 내용을 주입해야
#                          할루시네이션 없이 실데이터 기반 작업 가능)
today = datetime.date.today().isoformat()
charter = charter.replace("{{today}}", today)
def inject_latest(m):
    files = sorted(glob.glob(m.group(1)), key=os.path.getmtime, reverse=True)
    if not files:
        return "(해당 파일 없음)"
    body = open(files[0], encoding="utf-8", errors="replace").read()[:4000]
    return f"[파일: {os.path.basename(files[0])}]\n{body}"
charter = re.sub(r"\{\{latest:([^}]+)\}\}", inject_latest, charter)

prompt = f"""[팀 상시 임무 — {team['name']}] (텍스트만 응답, 도구/커맨드 사용 금지)
오늘 날짜: {today}
{charter}
[엄수] 너는 파일을 수정하거나 명령(build/test/git/make/npm 등)을 실행할 수 없다 — 오직 텍스트만 생성한다.
그러므로 '변경 파일 목록', 'diff 요약', '빌드 성공', '테스트 통과', '커밋 완료' 등 실제로 수행하지 않은 작업을
했다고 절대 쓰지 마라. 존재하지 않는 파일 경로·버전·수치·완료 상태를 지어내면 산출물은 반려된다.
아래에 주입된 실데이터/파일 내용만 근거로 삼아 (1)오늘 관찰·분석 (2)현재 상태 (3)다음에 필요한 작업 제안을
작성하라. 근거가 없는 항목은 '미확인'으로 표기하라."""
# 2026-07-12: 백엔드가 metadata.projectDir을 필수로 요구(POST /api/task → 400 "invalid_project_dir").
#   미포함 시 전 팀 태스크 생성이 거부되어 팀이 산출물을 못 냈다. 러너 기준 디렉터리를 주입한다.
print(json.dumps({"ai": ai, "callerAgentId": "team-runner", "prompt": prompt,
                  "metadata": {"projectDir": project_dir}}, ensure_ascii=False))
PY
  # 백엔드 재시작 등 일시 장애 시 실패해도 러너가 죽지 않도록 (set -e/pipefail 보호)
  { curl -s -X POST "${API_BASE}/task" -H 'Content-Type: application/json' \
    --data @"${TMP_DIR}/body.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId",""))'; } 2>/dev/null || echo ""
}

poll_done() { # $1=taskId → completed면 response 저장 후 0
  local attempt=0 status=""
  while [ "${attempt}" -lt "${MAX_POLLS}" ]; do
    attempt=$((attempt + 1))
    # 백엔드 재시작 등 일시 장애 시 curl/파싱 실패해도 러너가 죽지 않도록 (set -e 보호)
    status=$( { curl -s "${API_BASE}/task/$1" -o "${TMP_DIR}/task.json" \
      && python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"]["status"])' "${TMP_DIR}/task.json"; } 2>/dev/null || echo "")
    case "${status}" in
      completed)
        python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"].get("response") or "")' \
          "${TMP_DIR}/task.json" > "${TMP_DIR}/response.md"
        [ "$(wc -c < "${TMP_DIR}/response.md")" -lt 200 ] && { log WARN "$1 응답 품질 미달(글자수)"; return 1; }
        # 환각 방지(2026-07-12): 텍스트 전용 워커는 파일 수정 불가. 응답이 '변경했다'고 주장한
        #   절대경로 파일이 실제로 존재하지 않으면 조작 산출물 → 반려. 상대경로/미확인 표기는 통과.
        local ghost; ghost=$(grep -oE "/Users/[^ \`\"'\''()]+\.(ts|tsx|js|jsx|py|vue|yaml|yml|json|sh|md)" "${TMP_DIR}/response.md" \
          | sort -u | while IFS= read -r p; do [ -e "$p" ] || printf '%s ' "$p"; done)
        if [ -n "${ghost}" ]; then
          log WARN "$1 환각 반려 — 존재하지 않는 파일 변경 주장: ${ghost}"
          return 1
        fi
        # 텍스트 전용인데 빌드/테스트 '성공'을 실행했다고 주장하면 조작 → 반려
        if grep -qE "(make|npm|yarn|pnpm)[[:space:]_-]*(run[[:space:]]+)?(build|test).{0,20}(성공|통과|passed|success)|모든[[:space:]]*타겟[[:space:]]*성공|빌드[[:space:]]*성공" "${TMP_DIR}/response.md"; then
          log WARN "$1 환각 반려 — 실행 불가한 빌드/테스트 성공 주장"
          return 1
        fi
        # 텍스트 전용인데 git 커밋/push/배포/PR을 실행했다고 주장하면 조작 → 반려 (2026-07-12 claude-2)
        if grep -qiE "(커밋|commit)[[:space:]]*(완료|했|됨|hash|해시|:[[:space:]]*[0-9a-f]{7,})|(git[[:space:]]+)?(push|pushed)[[:space:]]*(완료|했|됨|성공)|(배포|deploy(ed)?)[[:space:]]*(완료|성공|done)|(PR|풀[[:space:]]*리퀘스트|pull[[:space:]]*request)[[:space:]]*(생성|열|merged|머지|완료)" "${TMP_DIR}/response.md"; then
          log WARN "$1 환각 반려 — 실행 불가한 커밋/push/배포/PR 완료 주장"
          return 1
        fi
        return 0 ;;
      failed|timed_out|error) return 1 ;;
    esac
    sleep "${POLL_INTERVAL}"
  done
  return 1
}

# ── 팀 순차 실행 (동시 로컬 LLM 금지) ──
acquire_lock
log INFO "로컬 LLM 락 획득 (pid=$$)"

IDX=0
while [ "${IDX}" -lt "${N_TEAMS}" ]; do
  TEAM_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["id"])' "${TMP_DIR}/runnable.json" "${IDX}")
  TEAM_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["name"])' "${TMP_DIR}/runnable.json" "${IDX}")
  TEAM_LEAD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["lead"])' "${TMP_DIR}/runnable.json" "${IDX}")
  IDX=$((IDX + 1))

  # 일일 중복 방지
  MARKER="${STATE_DIR}/${TEAM_ID}.last"
  if [ -f "${MARKER}" ] && [ "$(cat "${MARKER}")" = "${TODAY}" ]; then
    log INFO "${TEAM_NAME}: 오늘 이미 실행됨 — skip"
    continue
  fi

  # 체인: 팀 lead를 최우선, 이후 AI_CHAIN 순서 (중복 제거)
  CHAIN="${TEAM_LEAD} ${AI_CHAIN}"
  DONE_AI=""
  for ai in ${CHAIN}; do
    [ -z "${ai}" ] && continue
    case " ${TRIED:-} " in *" ${ai} "*) continue;; esac
    TRIED="${TRIED:-} ${ai}"
    # 레지스트리에 없는 에이전트(미등록 ollama 등)는 헛된 400 방지 위해 스킵
    if [ -n "${KNOWN_AIS}" ]; then
      case " ${KNOWN_AIS} " in *" ${ai} "*) : ;; *) log INFO "${TEAM_NAME}: ai=${ai} 미등록 — 스킵"; continue;; esac
    fi
    TID=$(create_task "${ai}" "${TEAM_ID}")
    [ -z "${TID}" ] && { log WARN "${TEAM_NAME}: ai=${ai} 생성 거부"; continue; }
    curl -s -X POST "${API_BASE}/teams/${TEAM_ID}/tasks" -H 'Content-Type: application/json' \
      -d "{\"taskId\":\"${TID}\"}" > /dev/null || true
    log INFO "${TEAM_NAME}: taskId=${TID} (ai=${ai}) 실행 — 완료까지 대기(순차)"
    if poll_done "${TID}"; then
      OUT="${STATE_DIR}/${TEAM_ID}-${TODAY}.md"
      { echo "# ${TEAM_NAME} — 일일 산출물 (${TODAY}, ai=${ai}, taskId=${TID})"; echo; cat "${TMP_DIR}/response.md"; } > "${OUT}"
      echo "${TODAY}" > "${MARKER}"
      log INFO "${TEAM_NAME}: 완료 → ${OUT}"
      DONE_AI="${ai}"
      break
    fi
    log WARN "${TEAM_NAME}: ai=${ai} 실패 — 다음 후보"
  done
  TRIED=""
  [ -z "${DONE_AI}" ] && log FAIL "${TEAM_NAME}: 전 체인 실패"
done

release_lock
log INFO "team-runner 종료 (락 해제)"
