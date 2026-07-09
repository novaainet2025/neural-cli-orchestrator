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
AI_CHAIN="mlx ollama openrouter"

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

create_task() { # $1=ai $2=teamId(에서 charter/lead 로드) → taskId
  python3 - "$1" "$2" "${TMP_DIR}/runnable.json" <<'PY' > "${TMP_DIR}/body.json"
import json, sys, glob, os, re, datetime
ai, team_id, path = sys.argv[1], sys.argv[2], sys.argv[3]
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
오늘 날짜 기준으로 위 임무의 일일 산출물을 작성하라. 거짓 수치·과장 금지. 제공되지 않은 정보는 지어내지 말 것."""
print(json.dumps({"ai": ai, "callerAgentId": "team-runner", "prompt": prompt}, ensure_ascii=False))
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
        [ "$(wc -c < "${TMP_DIR}/response.md")" -lt 200 ] && { log WARN "$1 응답 품질 미달"; return 1; }
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
