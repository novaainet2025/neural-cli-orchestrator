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
QUALITY_TEAM="team_content-quality"
QUALITY_LEAD="cursor-agent"
# config/ai-providers.json 활성 프로바이더만 사용: 무료 ollama 우선,
# 이어서 활성 CLI 폴백을 순회한다.
AI_CHAIN="ollama hermes codex opencode"
POLL_INTERVAL=10
MAX_POLLS=30
# 품질 FAIL 재생성 상한(유계): 초안 1 + 재생성 2 = 최대 3개 서로 다른 생성 agent
MAX_REGENERATIONS=2
# 품질 FAIL 후 재생성 시 이미 성공 생성에 쓴 agent는 재사용 금지(승급만 허용)
USED_GENERATORS=""

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
release_lock() {
  # 멱등·항상 exit 0: 락 없거나 타 PID 소유여도 trap/set -e에서 실패하지 않음
  if [ -f "${LOCK_FILE}" ] && [ "$(cat "${LOCK_FILE}" 2>/dev/null || true)" = "$$" ]; then
    rm -f "${LOCK_FILE}" || true
  fi
  return 0
}

# ── 1. RSS 최신 글 추출 (한 번의 python 호출, 필드는 개별 파일로) ──────────
log INFO "RSS 조회: ${BLOG_RSS}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsSL "${BLOG_RSS}" -o "${TMP_DIR}/rss.json"
python3 - "${TMP_DIR}" <<'PY'
import html
import json
import os
import re
import sys

tmp = sys.argv[1]
data = json.load(open(os.path.join(tmp, "rss.json")))
entry = data["feed"]["entry"][0]
url = next((l["href"] for l in entry.get("link", []) if l.get("rel") == "alternate"), "")
open(os.path.join(tmp, "title"), "w").write(entry["title"]["$t"])
open(os.path.join(tmp, "url"), "w").write(url)
open(os.path.join(tmp, "published"), "w").write(entry["published"]["$t"])

content = entry.get("content", {}).get("$t", "")
source_kind = "RSS full content"
if not content:
    content = entry.get("summary", {}).get("$t", "")
    source_kind = "RSS summary"
if content:
    content = re.sub(r"<script\b[^>]*>.*?</script>", " ", content, flags=re.I | re.S)
    content = re.sub(r"<style\b[^>]*>.*?</style>", " ", content, flags=re.I | re.S)
    content = re.sub(r"<[^>]+>", " ", content)
    content = html.unescape(content)
    content = re.sub(r"\s+", " ", content).strip()
else:
    source_kind = "unavailable"
open(os.path.join(tmp, "source.txt"), "w").write(content[:20000])
open(os.path.join(tmp, "source-kind"), "w").write(source_kind)
PY
POST_TITLE=$(cat "${TMP_DIR}/title")
POST_URL=$(cat "${TMP_DIR}/url")
POST_PUB=$(cat "${TMP_DIR}/published")
SOURCE_KIND=$(cat "${TMP_DIR}/source-kind")

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
build_body() { # $1=ai $2=generation_round
  python3 - "$1" "$2" "${POST_TITLE}" "${POST_URL}" "${SOURCE_KIND}" \
    "${TMP_DIR}/source.txt" "${TMP_DIR}/improvements.txt" "${NCO_DIR}" "${TEAM}" <<'PY'
import json, sys
ai, round_text, title, url, source_kind, source_path, improvements_path, project_dir, team_id = sys.argv[1:]
source = open(source_path).read()
improvements = open(improvements_path).read().strip()
source_block = source if source else (
    "[원문 내용이 RSS에 제공되지 않음. 제목만으로 내용을 추정하거나 사실·수치·사례를 만들지 말고, "
    "모든 채널 문안에서 확인 가능한 정보의 한계를 정직하게 밝힐 것.]"
)
revision = f"\n이전 품질 게이트의 구체 개선 지시:\n{improvements}\n모든 지시를 반영하라." if improvements else ""
prompt = f"""블로그 홍보 패키지를 영문으로 작성하라. 도구/웹 접근 없이 아래에 제공된 원문 근거만 사용하며, 게시는 사람 검토 후에만 진행된다.

[원문 식별]
- 제목: {title}
- URL: {url}
- 제공 근거: {source_kind}

[원문 내용]
{source_block}

[품질 원칙]
1. 원문 URL과 위 원문 내용을 사실 근거로 삼아 핵심 주장·수치·사례를 정확히 전달하라. 근거에 없는 내용은 제목에서 유추하거나 지어내지 말고 "not verified in the source"처럼 한계를 명시하라.
2. 단순 홍보 문구 나열 대신 독자의 구체적 문제를 정의하고, 원문이 주는 해결 절차·판단 기준·주의점과 차별화된 오리지널 관점을 충분히 설명하라.
3. 구체 데이터와 실사례는 원문에 실제로 있을 때만 사용하고 맥락을 보존하라. 없다면 만들어 채우지 말고 부재를 명시하라.
4. E-E-A-T 신호를 포함하라: 원문에서 확인되는 경험·전문성, 근거와 출처 범위, 독자가 직접 검증할 방법, 적용 한계와 리스크를 분명히 하라. 확인되지 않은 경력·권위는 주장하지 마라.
5. AI-spam 패턴을 금지한다: 과도한 해시태그/이모지, 키워드 스터핑, 얇은 반복, 일반론, 과장된 클릭베이트, 같은 문장의 채널 간 복제를 사용하지 마라.
6. Pinterest/Medium/X 각각의 독자와 형식에 맞추되, 모든 문안이 원문의 실제 가치와 한계를 정확히 전달해야 한다.

[출력]
1) Pinterest 핀 3종: 각각 제목(<100자), 설명(<400자, 관련 해시태그 최대 2개), 이미지 컨셉 1줄. 세 핀은 서로 다른 독자 문제/원문 관점을 다룬다.
2) Medium repost용 인트로 약 200단어: 독자 문제, 원문의 구체 가치, 근거/한계, 원문 링크와 canonical 안내를 포함한다.
3) X 문구 2종: 각각 반드시 280자 미만. 관련 해시태그는 최대 2개이며, 원문에 없는 주장 없이 서로 다른 실용 포인트를 전달한다.
4) SEO: 원문과 실제로 일치하는 검색 키워드 5개, 검색의도, 내부링크 제안 2개. 확인할 수 없는 내부 글 URL은 만들지 말고 주제 수준으로 제안한다.
{revision}
생성 라운드: {round_text} (0=초안, 1+=품질 지시 반영 재생성·직전 생성 agent 제외 승급)."""
print(json.dumps({
    "ai": ai,
    "callerAgentId": "team-sns-cron",
    "prompt": prompt,
    "metadata": {"projectDir": project_dir, "teamId": team_id},
}, ensure_ascii=False))
PY
}

create_task() { # $1=ai $2=generation_round → stdout: taskId (실패 시 빈 문자열)
  build_body "$1" "$2" > "${TMP_DIR}/body.json"
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
        # 품질 게이트: 로컬 LLM 툴콜 루프 등 쓰레기 응답이 completed로 저장되는 것 방지
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

link_to_team() { # $1=taskId $2=teamId
  curl -s -X POST "${API_BASE}/teams/$2/tasks" -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"$1\"}" > /dev/null || log WARN "팀 연결 실패: $1"
}

# ── 4. 고품질 검수 태스크 — content-quality 팀, 생성 모델과 교차 검수 ────────
build_review_body() { # $1=ai
  python3 - "$1" "${POST_TITLE}" "${POST_URL}" "${SOURCE_KIND}" \
    "${TMP_DIR}/source.txt" "${TMP_DIR}/package.md" "${NCO_DIR}" "${QUALITY_TEAM}" <<'PY'
import json
import sys

ai, title, url, source_kind, source_path, pkg_path, project_dir, team_id = sys.argv[1:]
source = open(source_path).read()[:20000]
pkg = open(pkg_path).read()[:20000]
source_block = source if source else "[원문 내용 미제공 — 패키지가 이 한계를 밝히고 추측을 피했는지 검증할 것]"
prompt = f"""너는 content-quality 팀의 독립 품질 검수자다. 생성에 참여하지 않았으며, 아래 원문 근거와 홍보 패키지를 직접 대조해 엄격히 채점하라. 도구/웹 접근은 사용하지 않는다.

[원문]
- 제목: {title}
- URL: {url}
- 제공 근거: {source_kind}
{source_block}

[검수 대상 패키지]
{pkg}

[rubric — 각 0~100]
- originality: 채널별 관점이 구별되고 템플릿 문구·얇은 반복·단순 재진술이 아닌가
- depth: 독자 문제, 해결 절차/판단 기준, 원문에 있는 구체 데이터·실사례·주의점이 충분한가
- eeat: 원문에서 확인되는 경험/전문성/근거, 검증 방법, 적용 한계·리스크를 정직하게 드러내는가
- helpfulness: 클릭 유도보다 독자가 실제 판단·행동하는 데 도움이 되는가
- factual_accuracy: 모든 주장·수치·사례가 원문과 일치하며, 원문이 없거나 불충분할 때 추측 대신 한계를 명시하는가
- readability: 명료한 구조와 자연스러운 문장인가. 키워드 스터핑, 과도한 해시태그/이모지, 스팸성 표현이 없고 Pinterest/Medium 형식 및 각 X 문구 280자 미만을 지키는가

overall은 여섯 점수의 단순 산술평균이다. 판정: overall >= 85 AND originality >= 75 AND depth >= 75 이면 PASS, 아니면 FAIL. (Google 정책상 복사·저노력·저원본성 콘텐츠는 최하등급이므로 원본성·깊이는 하드게이트다.)
FAIL이면 재생성에 바로 사용할 수 있도록 위치/문제/수정 방향이 포함된 구체 개선 지시를 1개 이상 작성하라.
응답은 설명이나 Markdown 코드펜스 없이 다음 키를 가진 JSON 객체 하나만 출력하라:
{{"scores":{{"originality":0,"depth":0,"eeat":0,"helpfulness":0,"factual_accuracy":0,"readability":0}},"overall":0,"verdict":"FAIL","findings":{{"originality":"근거","depth":"근거","eeat":"근거","helpfulness":"근거","factual_accuracy":"근거","readability":"근거"}},"improvements":["구체 개선 지시"]}}"""
print(json.dumps({
    "ai": ai,
    "callerAgentId": "team-content-quality-gate",
    "prompt": prompt,
    "metadata": {"projectDir": project_dir, "teamId": team_id},
}, ensure_ascii=False))
PY
}

parse_gate_response() {
  python3 - "${TMP_DIR}/response.md" "${TMP_DIR}/gate.json" "${TMP_DIR}/improvements.txt" <<'PY'
import json
import sys

response_path, gate_path, improvements_path = sys.argv[1:]
raw = open(response_path).read().strip()
start, end = raw.find("{"), raw.rfind("}")
if start < 0 or end < start:
    raise SystemExit("quality gate response has no JSON object")
data = json.loads(raw[start:end + 1])
keys = ["originality", "depth", "eeat", "helpfulness", "factual_accuracy", "readability"]
scores = data.get("scores")
findings = data.get("findings")
if not isinstance(scores, dict) or not isinstance(findings, dict):
    raise SystemExit("quality gate scores/findings missing")
for key in keys:
    value = scores.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100:
        raise SystemExit(f"invalid score: {key}")
    if not isinstance(findings.get(key), str) or not findings[key].strip():
        raise SystemExit(f"missing finding: {key}")
improvements = data.get("improvements", [])
if not isinstance(improvements, list) or any(not isinstance(item, str) or not item.strip() for item in improvements):
    raise SystemExit("invalid improvements")
overall = round(sum(float(scores[key]) for key in keys) / len(keys), 2)
# 확정 rubric(리서치 기반): 종합 >= 85 AND 원본성/깊이 하드게이트(각 >= 75).
# Google 정책상 복사·저노력·저원본성은 Lowest이므로 원본성·깊이는 임계 미달 시 즉시 FAIL.
verdict = "PASS" if (overall >= 85 and float(scores["originality"]) >= 75 and float(scores["depth"]) >= 75) else "FAIL"
if verdict == "FAIL" and not improvements:
    raise SystemExit("FAIL requires concrete improvements")
normalized = {
    "scores": {key: scores[key] for key in keys},
    "overall": overall,
    "verdict": verdict,
    "findings": {key: findings[key].strip() for key in keys},
    "improvements": [item.strip() for item in improvements],
}
open(gate_path, "w").write(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
# 매 라운드 improvements를 누적해 다음 재생성 프롬프트에 계속 전달
new_block = "\n".join(f"- {item}" for item in normalized["improvements"])
if new_block:
    try:
        existing = open(improvements_path).read().strip()
    except OSError:
        existing = ""
    open(improvements_path, "w").write(
        (existing + "\n" + new_block if existing else new_block) + "\n"
    )
print(verdict)
PY
}

append_gate_audit() { # $1=round $2=reviewer $3=taskId
  python3 - "$1" "$2" "$3" "${TMP_DIR}/gate.json" >> "${TMP_DIR}/quality-audit.md" <<'PY'
import json
import sys

round_text, reviewer, task_id, gate_path = sys.argv[1:]
gate = json.load(open(gate_path))
print(f"### 라운드 {round_text} — {gate['verdict']} (reviewer={reviewer}, taskId={task_id})")
print()
print(f"- 종합: {gate['overall']}")
for key, score in gate["scores"].items():
    print(f"- {key}: {score} — {gate['findings'][key]}")
if gate["improvements"]:
    print("- 개선 지시:")
    for item in gate["improvements"]:
        print(f"  - {item}")
print()
PY
}

generate_package() { # $1=generation_round
  local generation_round="$1" ai
  TASK_ID=""
  DONE_AI=""
  for ai in ${AI_CHAIN}; do
    # 품질 FAIL 재생성: 직전/이미 성공 생성에 쓴 agent는 건너뛰고 AI_CHAIN 다음으로 승급
    case " ${USED_GENERATORS} " in
      *" ${ai} "*)
        log INFO "ai=${ai} 이미 생성 성공에 사용됨 — 동일 저품질 모델 반복 차단, 승급"
        continue
        ;;
    esac
    log INFO "홍보 패키지 태스크 생성 시도 (round=${generation_round}, ai=${ai})"
    TASK_ID=$( { create_task "${ai}" "${generation_round}"; } 2>/dev/null || echo "")
    if [ -z "${TASK_ID}" ]; then
      log WARN "태스크 생성 거부 (ai=${ai} 미등록/비활성 추정) — 다음 후보"
      continue
    fi
    log INFO "taskId=${TASK_ID} (ai=${ai}) → ${TEAM} 연결"
    link_to_team "${TASK_ID}" "${TEAM}"
    if poll_task "${TASK_ID}" package; then
      cp "${TMP_DIR}/response.md" "${TMP_DIR}/package.md"
      DONE_AI="${ai}"
      USED_GENERATORS="${USED_GENERATORS}${USED_GENERATORS:+ }${ai}"
      return 0
    fi
    log WARN "ai=${ai} 실행 실패 — 다음 후보"
    TASK_ID=""
  done
  return 1
}

run_quality_gate() { # $1=generation_round
  local generation_round="$1" ai tried=""
  REVIEW_DONE=""
  RV_ID=""
  GATE_VERDICT=""
  for ai in ${QUALITY_LEAD} ${AI_CHAIN}; do
    [ "${ai}" = "${DONE_AI}" ] && continue
    case " ${tried} " in *" ${ai} "*) continue ;; esac
    tried="${tried} ${ai}"
    build_review_body "${ai}" > "${TMP_DIR}/body.json"
    RV_ID=$( { curl -s -X POST "${API_BASE}/task" -H 'Content-Type: application/json' \
      --data @"${TMP_DIR}/body.json" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId",""))'; } 2>/dev/null || echo "")
    [ -z "${RV_ID}" ] && continue
    log INFO "고품질 검수 태스크 ${RV_ID} (ai=${ai}) → ${QUALITY_TEAM} 연결"
    link_to_team "${RV_ID}" "${QUALITY_TEAM}"
    if poll_task "${RV_ID}" review; then
      if GATE_VERDICT=$(parse_gate_response 2>> "${LOG_FILE}"); then
        REVIEW_DONE="${ai}"
        cp "${TMP_DIR}/gate.json" "${TMP_DIR}/gate-${generation_round}.json"
        append_gate_audit "${generation_round}" "${ai}" "${RV_ID}"
        return 0
      fi
      log WARN "고품질 검수 태스크 ${RV_ID}의 rubric JSON이 유효하지 않음 — 다음 검수자"
    fi
  done
  return 1
}

write_failed_audit() {
  local rejected_dir="${DATA_DIR}/rejected"
  local failed_file="${rejected_dir}/$(date '+%Y-%m-%d').quality-failed.md"
  mkdir -p "${rejected_dir}"
  {
    echo "# 고품질 검수 실패: ${POST_TITLE}"
    echo ""
    echo "- 원문: ${POST_URL}"
    echo "- 상태: 최종 패키지 미확정, 게시 금지"
    echo "- 재생성 상한: ${MAX_REGENERATIONS}회"
    echo ""
    echo "## 품질 게이트 이력"
    echo ""
    cat "${TMP_DIR}/quality-audit.md"
  } > "${failed_file}"
  log FAIL "품질 게이트 미통과 — 후보 폐기, 감사 기록만 저장: ${failed_file}"
}

# ── 5. 생성 → 품질 게이트 → FAIL 시 최대 2회 재생성(서로 다른 agent 승급) ──
acquire_lock
trap 'release_lock; rm -rf "${TMP_DIR}"' EXIT
log INFO "로컬 LLM 락 획득 (pid=$$)"
: > "${TMP_DIR}/improvements.txt"
: > "${TMP_DIR}/quality-audit.md"
USED_GENERATORS=""

GENERATION_ROUND=0
while [ "${GENERATION_ROUND}" -le "${MAX_REGENERATIONS}" ]; do
  if ! generate_package "${GENERATION_ROUND}"; then
    log FAIL "체인 전체(${AI_CHAIN}) 실패 또는 사용 가능 생성 agent 소진 (used=[${USED_GENERATORS}]) — 오늘 패키지 생성 불가"
    exit 1
  fi
  log INFO "생성 성공 (round=${GENERATION_ROUND}, ai=${DONE_AI}, used=[${USED_GENERATORS}])"

  if ! run_quality_gate "${GENERATION_ROUND}"; then
    write_failed_audit
    log FAIL "content-quality 검수자 체인에서 유효한 rubric을 받지 못함"
    exit 1
  fi

  if [ "${GATE_VERDICT}" = "PASS" ]; then
    log INFO "고품질 게이트 PASS (round=${GENERATION_ROUND}, reviewer=${REVIEW_DONE})"
    break
  fi

  if [ "${GENERATION_ROUND}" -ge "${MAX_REGENERATIONS}" ]; then
    write_failed_audit
    exit 1
  fi
  log WARN "고품질 게이트 FAIL — 개선 지시 누적 반영, 직전 생성 agent(${DONE_AI}) 제외 후 다음 agent로 승급 재생성 ($((GENERATION_ROUND + 1))/${MAX_REGENERATIONS})"
  GENERATION_ROUND=$((GENERATION_ROUND + 1))
done

# ── 6. PASS 산출물만 최종 확정; 게시 자체는 수행하지 않는다 ────────────────
OUT_FILE="${DATA_DIR}/$(date '+%Y-%m-%d').md"
{
  echo "# 홍보 패키지: ${POST_TITLE}"
  echo ""
  echo "- 원문: ${POST_URL}"
  echo "- 원문 근거: ${SOURCE_KIND}"
  echo "- 발행: ${POST_PUB}"
  echo "- 생성: $(date '+%Y-%m-%d %H:%M:%S') (taskId=${TASK_ID}, ai=${DONE_AI}, regeneration=${GENERATION_ROUND})"
  echo "- 고품질 검수: PASS (team=${QUALITY_TEAM}, reviewer=${REVIEW_DONE}, taskId=${RV_ID})"
  echo "- ⚠ 게시는 사람 검토 후 수동 진행 (자동 게시 금지)"
  echo ""
  echo "---"
  echo ""
  cat "${TMP_DIR}/package.md"
  echo ""
  echo "---"
  echo ""
  echo "## 고품질 검수 이력"
  echo ""
  cat "${TMP_DIR}/quality-audit.md"
} > "${OUT_FILE}"
echo "${POST_URL}" > "${LAST_POST_FILE}"
log INFO "완료 — PASS 패키지 저장: ${OUT_FILE} (생성=${DONE_AI}, 검수=${REVIEW_DONE})"
