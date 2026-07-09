#!/usr/bin/env bash
# daily-blog-promo.sh — Nova Money Hub 일일 홍보 패키지 자동 생성
# 매일 최신 글 1건 → NCO 워커에게 홍보 패키지(Pinterest/Medium/SNS/SEO) 생성 위임
# → team_sns 워크플로우 연결 → data/blog-promo/YYYY-MM-DD.md 저장.
# 게시(발행)는 하지 않는다 — 산출물은 사람이 검토 후 게시 (홍보 스팸 금지 원칙).
# 기반: openrouter 초안(task_Dxf7vino7VwGB-aU) + claude-1 버그 수정
#   (read 멀티라인 파싱/heredoc stdin 충돌/set -e ((attempt++)) 즉사/JSON 개행 인젝션)

set -euo pipefail

BLOG_RSS="https://nova-money-hub.blogspot.com/feeds/posts/default?alt=json&max-results=3"
NCO_DIR="/Users/nova-ai/project/nco"
DATA_DIR="${NCO_DIR}/data/blog-promo"
LOG_FILE="${NCO_DIR}/logs/blog-promo.log"
LAST_POST_FILE="${DATA_DIR}/.last-post"
API_BASE="http://localhost:6200/api"
TEAM="team_sns"
# 무료 모델 우선 체인 (2026-07-07 사용자 지시): 로컬 무료(mlx/hermes/ollama) 먼저,
# 다음 무료 크레딧(openrouter), 마지막 유료(opencode). 미등록/비활성 프로바이더는
# 태스크 생성이 즉시 거부되므로 자동으로 다음 후보로 넘어간다.
AI_CHAIN="mlx hermes ollama openrouter opencode"
POLL_INTERVAL=10
MAX_POLLS=30

mkdir -p "${DATA_DIR}" "$(dirname "${LOG_FILE}")"

log() {
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${*:2}" | tee -a "${LOG_FILE}"
}

# ── 로컬 LLM 직렬화 락 (통합 메모리 보호 — team-runner.sh와 동일 규칙) ──
LOCK_FILE="/tmp/nova-local-llm.lock"
acquire_lock() {
  local waited=0
  while [ -e "${LOCK_FILE}" ] && [ ${waited} -lt 1200 ]; do
    local owner; owner=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
    if [ -n "${owner}" ] && ! kill -0 "${owner}" 2>/dev/null; then rm -f "${LOCK_FILE}"; break; fi
    sleep 15; waited=$((waited + 15))
  done
  echo $$ > "${LOCK_FILE}"
}
release_lock() { [ "$(cat "${LOCK_FILE}" 2>/dev/null)" = "$$" ] && rm -f "${LOCK_FILE}"; }

# ── 1. RSS 최신 글 추출 (한 번의 python 호출, 필드는 개별 파일로) ──────────
log INFO "RSS 조회: ${BLOG_RSS}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsSL "${BLOG_RSS}" -o "${TMP_DIR}/rss.json"
python3 - "${TMP_DIR}" <<'PY'
import json, sys, os
tmp = sys.argv[1]
data = json.load(open(os.path.join(tmp, "rss.json")))
entry = data["feed"]["entry"][0]
url = next((l["href"] for l in entry.get("link", []) if l.get("rel") == "alternate"), "")
open(os.path.join(tmp, "title"), "w").write(entry["title"]["$t"])
open(os.path.join(tmp, "url"), "w").write(url)
open(os.path.join(tmp, "published"), "w").write(entry["published"]["$t"])
PY
POST_TITLE=$(cat "${TMP_DIR}/title")
POST_URL=$(cat "${TMP_DIR}/url")
POST_PUB=$(cat "${TMP_DIR}/published")

if [ -z "${POST_URL}" ]; then
  log FAIL "RSS에서 글 URL 추출 실패"
  exit 1
fi
log INFO "최신 글: '${POST_TITLE}' (${POST_URL}) published ${POST_PUB}"

# ── 2. 중복 방지 ──────────────────────────────────────────────────────────
if [ -f "${LAST_POST_FILE}" ] && [ "$(cat "${LAST_POST_FILE}")" = "${POST_URL}" ]; then
  log INFO "이미 처리된 글 — 종료 (${POST_URL})"
  exit 0
fi

# ── 3. NCO 태스크 생성 (JSON은 python으로 안전 직렬화 — 개행/따옴표 인젝션 방지) ──
build_body() { # $1=ai
  python3 - "$1" "${POST_TITLE}" "${POST_URL}" <<'PY'
import json, sys
ai, title, url = sys.argv[1], sys.argv[2], sys.argv[3]
prompt = f"""블로그 홍보 패키지 작성 (영문 텍스트만 응답, 도구/커맨드 사용 금지, 웹 접근 불필요 — 제목에서 유추해 작성. 게시는 사람이 검토 후 진행):
대상 글: {title} {url}
1) Pinterest 핀 3종: 각각 제목(<100자)+설명(<400자, 해시태그 5개)+이미지 컨셉 1줄
2) Medium repost용 요약 인트로 200단어 + 원문 링크 문장(canonical 안내)
3) X/SNS 홍보 문구 2종 (<280자, 이모지·해시태그 포함)
4) SEO: 이 글이 노려야 할 검색 키워드 5개 + 내부링크 제안 2개
거짓 수치·과장 금지. 원문 내용 기반."""
print(json.dumps({"ai": ai, "callerAgentId": "team-sns-cron", "prompt": prompt}, ensure_ascii=False))
PY
}

create_task() { # $1=ai → stdout: taskId (실패 시 빈 문자열)
  build_body "$1" > "${TMP_DIR}/body.json"
  curl -s -X POST "${API_BASE}/task" -H 'Content-Type: application/json' \
    --data @"${TMP_DIR}/body.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId",""))'
}

poll_task() { # $1=taskId $2=종류(package|review) → 성공 시 response를 ${TMP_DIR}/response.md 저장, return 0
  local attempt=0 status="" kind="${2:-package}"
  while [ "${attempt}" -lt "${MAX_POLLS}" ]; do
    attempt=$((attempt + 1))
    status=$(curl -s "${API_BASE}/task/$1" -o "${TMP_DIR}/task.json" \
      && python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"]["status"])' "${TMP_DIR}/task.json")
    case "${status}" in
      completed)
        python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["task"].get("response") or "")' \
          "${TMP_DIR}/task.json" > "${TMP_DIR}/response.md"
        # 품질 게이트: mlx 툴콜 루프 등 쓰레기 응답이 completed로 저장되는 것 방지
        # package: 500자+Pinterest 섹션 필수 / review: 200자만
        if [ "${kind}" = "package" ]; then
          if [ "$(wc -c < "${TMP_DIR}/response.md")" -lt 500 ] \
             || ! grep -qi "pinterest" "${TMP_DIR}/response.md"; then
            log WARN "태스크 $1 응답 품질 미달 (짧음/형식 불일치) — 실패 취급"
            return 1
          fi
        else
          if [ "$(wc -c < "${TMP_DIR}/response.md")" -lt 200 ]; then
            log WARN "태스크 $1 리뷰 응답 품질 미달 — 실패 취급"
            return 1
          fi
        fi
        return 0 ;;
      failed|timed_out|error)
        log WARN "태스크 $1 종료 상태: ${status}"
        return 1 ;;
    esac
    sleep "${POLL_INTERVAL}"
  done
  log WARN "태스크 $1 폴링 타임아웃 (${MAX_POLLS}회)"
  return 1
}

link_to_team() { # $1=taskId
  curl -s -X POST "${API_BASE}/teams/${TEAM}/tasks" -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"$1\"}" > /dev/null || log WARN "팀 연결 실패: $1"
}

# 무료 우선 체인 순회 — 성공한 프로바이더에서 멈춘다
acquire_lock
trap 'release_lock; rm -rf "${TMP_DIR}"' EXIT
log INFO "로컬 LLM 락 획득 (pid=$$)"
TASK_ID=""
DONE_AI=""
for ai in ${AI_CHAIN}; do
  log INFO "홍보 패키지 태스크 생성 시도 (ai=${ai})"
  TASK_ID=$(create_task "${ai}")
  if [ -z "${TASK_ID}" ]; then
    log WARN "태스크 생성 거부 (ai=${ai} 미등록/비활성 추정) — 다음 후보"
    continue
  fi
  log INFO "taskId=${TASK_ID} (ai=${ai}) → ${TEAM} 연결"
  link_to_team "${TASK_ID}"
  if poll_task "${TASK_ID}"; then
    DONE_AI="${ai}"
    break
  fi
  log WARN "ai=${ai} 실행 실패 — 다음 후보"
  TASK_ID=""
done

if [ -z "${DONE_AI}" ]; then
  log FAIL "체인 전체(${AI_CHAIN}) 실패 — 오늘 패키지 생성 불가"
  exit 1
fi
log INFO "생성 성공 (ai=${DONE_AI})"

# ── 4. 산출물 저장 ────────────────────────────────────────────────────────
OUT_FILE="${DATA_DIR}/$(date '+%Y-%m-%d').md"
cp "${TMP_DIR}/response.md" "${TMP_DIR}/package.md"
{
  echo "# 홍보 패키지: ${POST_TITLE}"
  echo ""
  echo "- 원문: ${POST_URL}"
  echo "- 발행: ${POST_PUB}"
  echo "- 생성: $(date '+%Y-%m-%d %H:%M:%S') (taskId=${TASK_ID}, ai=${DONE_AI})"
  echo "- ⚠ 게시는 검토 후 수동 진행 (스팸 금지 원칙)"
  echo ""
  echo "---"
  echo ""
  cat "${TMP_DIR}/package.md"
} > "${OUT_FILE}"
echo "${POST_URL}" > "${LAST_POST_FILE}"
log INFO "패키지 저장: ${OUT_FILE}"

# ── 5. 리뷰 단계 (팀 워크플로우 review 채움) — 생성 모델과 다른 모델이 검수 ──
build_review_body() { # $1=ai
  python3 - "$1" "${POST_TITLE}" "${TMP_DIR}/package.md" <<'PY'
import json, sys
ai, title, pkg_path = sys.argv[1], sys.argv[2], sys.argv[3]
pkg = open(pkg_path).read()[:6000]
prompt = f"""리뷰: 아래 블로그 홍보 패키지를 검수하라 (텍스트만 응답, 도구 사용 금지).
대상 글: {title}
검수 관점: (1) 과장/거짓 수치 여부 (2) 해시태그 적절성 (3) 문구 길이 제한 준수(X<280자) (4) 스팸으로 보일 표현
출력: 항목별 PASS/FIX + FIX인 항목은 수정 제안. 마지막 줄에 총평 1줄.

--- 패키지 ---
{pkg}"""
print(json.dumps({"ai": ai, "callerAgentId": "team-sns-cron", "prompt": prompt}, ensure_ascii=False))
PY
}

REVIEW_DONE=""
for ai in ${AI_CHAIN}; do
  [ "${ai}" = "${DONE_AI}" ] && continue  # 생성 모델 제외 — 교차 검수
  build_review_body "${ai}" > "${TMP_DIR}/body.json"
  RV_ID=$(curl -s -X POST "${API_BASE}/task" -H 'Content-Type: application/json' \
    --data @"${TMP_DIR}/body.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId",""))')
  [ -z "${RV_ID}" ] && continue
  log INFO "리뷰 태스크 ${RV_ID} (ai=${ai}) → ${TEAM} 연결"
  link_to_team "${RV_ID}"
  if poll_task "${RV_ID}" review; then
    {
      echo ""
      echo "---"
      echo ""
      echo "## 교차 리뷰 (ai=${ai}, taskId=${RV_ID})"
      echo ""
      cat "${TMP_DIR}/response.md"
    } >> "${OUT_FILE}"
    REVIEW_DONE="${ai}"
    break
  fi
done
if [ -n "${REVIEW_DONE}" ]; then
  log INFO "완료 — 패키지+리뷰 저장: ${OUT_FILE} (생성=${DONE_AI}, 리뷰=${REVIEW_DONE})"
else
  log WARN "리뷰 단계 실패 — 패키지만 저장됨 (게시 전 수동 검토 필수)"
fi
