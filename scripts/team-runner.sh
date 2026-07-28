#!/usr/bin/env bash
# team-runner.sh — 조직/팀 자율 업무 디스패처
# charter(상시 임무)가 있는 모든 팀을 순회하며 일일 태스크를 자동 생성·팀 연결한다.
# 관리 주체: organizations.manager(두뇌 세션)가 charter를 정의, 이 러너가 대행 실행.
#
# ⚠ 로컬 LLM 순차 실행 규칙 (2026-07-07 사용자 지시, 통합 메모리 Mac):
#   ollama 등 로컬 모델의 동시 추론은 통합 메모리를 고갈시킨다.
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
AI_CHAIN="ollama hermes openrouter"

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
# 멱등: 소유자 일치 시에만 삭제. 재호출·타소유자·파일없음 모두 exit 0
# (명시적 release 후 EXIT trap 재호출 시 [false]가 함수 종료코드 1이 되던 버그 방지)
release_lock() {
  [ "$(cat "${LOCK_FILE}" 2>/dev/null)" = "$$" ] && rm -f "${LOCK_FILE}" || true
  return 0
}
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
    {
        "id": t["id"], "name": t["name"], "slug": t.get("slug") or "",
        "lead": t.get("lead") or "", "charter": t.get("charter") or "",
        "members": t.get("members") or [], "workflow": t.get("workflow") or {},
    }
    for t in teams
    if (t.get("charter") or "").strip()
    and not (t.get("charter") or "").strip().startswith("@전담러너")
    and t.get("isActive", True) is True
]
json.dump(runnable, open(os.path.join(tmp, "runnable.json"), "w"), ensure_ascii=False)
print(len(runnable))
PY
N_TEAMS=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "${TMP_DIR}/runnable.json")
log INFO "charter 보유 팀: ${N_TEAMS}개"
[ "${N_TEAMS}" = "0" ] && { log INFO "실행할 팀 없음 — 종료"; exit 0; }

TODAY=$(date '+%Y-%m-%d')

# 프롬프트 근거로 쓸 API 스냅샷. 실패 시 빈 파일을 꾸미지 않고 해당 소스를 생략한다.
curl -fsS "${API_BASE}/agents" -o "${TMP_DIR}/agents.json" 2>/dev/null || true
curl -fsS "${API_BASE}/stats" -o "${TMP_DIR}/stats.json" 2>/dev/null || true

# 현재 에이전트 레지스트리 (2026-07-12): lead/chain에 레지스트리에 없는 에이전트(예: 미등록 ollama)가
#   있으면 매 팀마다 헛된 400 '생성 거부'가 발생한다. 알려진 목록을 미리 받아 스킵한다.
KNOWN_AIS=$(python3 - "${TMP_DIR}/agents.json" <<'PY' 2>/dev/null || echo ""
import json, os, sys
path = sys.argv[1]
data = json.load(open(path)) if os.path.exists(path) else {}
print(" ".join(a.get("id", "") for a in data.get("agents", [])))
PY
)
[ -n "${KNOWN_AIS}" ] && log INFO "레지스트리 에이전트: ${KNOWN_AIS}"

create_task() { # $1=ai $2=teamId(에서 charter/lead 로드) → taskId
  python3 - "$1" "$2" "${TMP_DIR}/runnable.json" "${NCO_DIR}" "${TMP_DIR}" <<'PY' > "${TMP_DIR}/body.json"
import json, sys, glob, os, re, datetime, sqlite3, subprocess
ai, team_id, path = sys.argv[1], sys.argv[2], sys.argv[3]
project_dir = sys.argv[4] if len(sys.argv) > 4 else "/Users/nova-ai/project/nco"
tmp_dir = sys.argv[5]
team = next(t for t in json.load(open(path)) if t["id"] == team_id)
charter = team["charter"]
is_self_improvement = team.get("slug") == "self-improvement" or team_id == "team_self-improvement"

# 2026-07-28 (team_gov-evolution-learning 개선 사이클 3/3): 지속학습팀 charter는 "태스크 결과·실패·
#   검증 영수증에서 재사용 가능한 교훈을 추출"인데, 이 러너가 주입하는 [실데이터]는 집계 카운트뿐이라
#   근거가 될 태스크 id·error·learning_events가 하나도 없었다(실측: 이 팀 태스크 10건 전부 프롬프트에
#   '[learning_task_evidence]' 0회). 프롬프트는 동시에 "위 값과 주입된 파일 내용만 사실로 사용한다"를
#   강제하므로, 팀은 구조적으로 자기 charter를 수행할 수 없었다. src/core/work-report-scheduler.ts의
#   buildTeamDataContext()는 2026-07-27에 같은 근거 블록을 이미 갖췄으나(work-report 경로),
#   team-runner 경로(spawned_by_cli='team-runner')는 빠져 있었다 — 그 경로 미러링이 이 블록이다.
# 롤백: NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT=off (재배포·재빌드 불필요, 프롬프트 바이트 동일 복원).
EVOLUTION_LEARNING_TEAM_SLUG = "gov-evolution-learning"
is_evolution_learning = team.get("slug") == EVOLUTION_LEARNING_TEAM_SLUG

def evolution_learning_context_enabled():
    configured = os.environ.get("NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT", "").strip().lower()
    return configured not in ("0", "false", "off")

def compact_text(value, limit):
    compacted = " ".join(str(value).split())
    return compacted if len(compacted) <= limit else compacted[:limit] + "…"

def compact_nullable(value, limit):
    if value is None:
        return "없음"
    return compact_text(value, limit) or "공백"

def load_json(name):
    source = os.path.join(tmp_dir, name)
    if not os.path.exists(source):
        return {}
    try:
        return json.load(open(source))
    except (OSError, ValueError):
        return {}

def build_team_data_context():
    lines = []
    db = None
    db_path = os.path.join(project_dir, "db", "nco.db")

    # 기존 SQLite의 팀별 최근 태스크/보고 실측치. API 스냅샷이 비어도 이 소스는 독립적으로 읽는다.
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        summary = db.execute(
            "SELECT COUNT(*), "
            "COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0), "
            "COALESCE(SUM(CASE WHEN status IN ('failed','timed_out','lease_expired','cancelled') THEN 1 ELSE 0 END),0), "
            "COALESCE(SUM(CASE WHEN status IN ('pending','queued','assigned','running','streaming','reviewing') THEN 1 ELSE 0 END),0) "
            "FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')",
            (team_id,),
        ).fetchone()
        if summary[0]:
            rate = summary[1] / summary[0] * 100
            lines.append(
                f"[tasks] 최근 7일: 전체={summary[0]}, 완료={summary[1]}, 실패성={summary[2]}, "
                f"진행={summary[3]}, 완료율={rate:.1f}%"
            )
        report_rows = db.execute(
            "SELECT status, COUNT(*) FROM work_reports "
            "WHERE team_id=? AND report_date >= date('now','-7 days') AND status<>'pending' "
            "GROUP BY status ORDER BY status",
            (team_id,),
        ).fetchall()
        if report_rows:
            lines.append(
                "[work_reports] 최근 7일: " + ", ".join(f"{status}={count}" for status, count in report_rows)
            )
    except (OSError, sqlite3.Error):
        pass

    # /api/teams가 반환한 해당 팀의 실제 task workflow 집계.
    workflow = team.get("workflow") or {}
    states = {"pending": 0, "running": 0, "completed": 0, "failed": 0}
    for bucket in workflow.values():
        if not isinstance(bucket, dict):
            continue
        for state in states:
            value = bucket.get(state, 0)
            if isinstance(value, (int, float)):
                states[state] += int(value)
    workflow_total = sum(states.values())
    if workflow_total:
        rate = states["completed"] / workflow_total * 100
        lines.append(
            f"[/api/teams] 팀 태스크 누계: 전체={workflow_total}, 완료={states['completed']}, "
            f"실패={states['failed']}, 진행={states['running']}, 대기={states['pending']}, 완료율={rate:.1f}%"
        )

    # /api/agents의 lead/provider-member 통계만 선택한다.
    agents = load_json("agents.json").get("agents", [])
    relevant = {team.get("lead") or ""}
    relevant.update(
        member.get("ref", "") for member in team.get("members", [])
        if isinstance(member, dict) and member.get("type") == "provider"
    )
    for agent in agents:
        if not isinstance(agent, dict) or agent.get("id") not in relevant:
            continue
        lines.append(
            f"[/api/agents] {agent.get('id')}: 상태={agent.get('status')}, "
            f"태스크={agent.get('taskCount')}, 성공률={agent.get('successRate')}%, "
            f"24시간실패={agent.get('failedLast24h')}"
        )

    # analytics 승계팀에는 회사 전체의 현재 API 집계를 추가한다.
    if team.get("slug") in ("analytics-lead", "ax-business-operations"):
        stats = load_json("stats.json")
        required = ("totalTasks", "completedTasks", "totalDiscussions")
        if all(isinstance(stats.get(key), (int, float)) for key in required):
            rate = stats["completedTasks"] / stats["totalTasks"] * 100 if stats["totalTasks"] else 0
            lines.append(
                f"[/api/stats] 전체태스크={stats['totalTasks']}, 완료={stats['completedTasks']}, "
                f"완료율={rate:.1f}%, 토론={stats['totalDiscussions']}"
            )

    # CFO 승계팀: 기존 SQLite 경제 테이블을 읽기 전용으로 집계한다.
    if team.get("slug") in ("cfo", "ax-business-operations") and db is not None:
        try:
            wallets = db.execute(
                "SELECT COUNT(*), COALESCE(SUM(balance),0), COALESCE(SUM(locked),0) FROM nova_wallets"
            ).fetchone()
            lines.append(f"[nova_wallets] 지갑={wallets[0]}, 총잔액={wallets[1]}, 잠금={wallets[2]}")
            transactions = db.execute(
                "SELECT status, COUNT(*), COALESCE(SUM(amount),0), COALESCE(SUM(fee),0) "
                "FROM nova_transactions WHERE created_at >= strftime('%s','now','-7 days') "
                "GROUP BY status ORDER BY status"
            ).fetchall()
            if transactions:
                for status, count, amount, fee in transactions:
                    lines.append(
                        f"[nova_transactions] 최근 7일/{status}: 건수={count}, 금액={amount}, 수수료={fee}"
                    )
            else:
                lines.append("[nova_transactions] 최근 7일 거래=0")
        except (OSError, sqlite3.Error):
            pass

    # self-improvement 전용: 개선 대상을 고를 수 있도록 NCO 전체의 최근 실패/병목 실측치를 제공한다.
    if is_self_improvement and db is not None:
        try:
            status_rows = db.execute(
                "SELECT status, COUNT(*) FROM tasks "
                "WHERE created_at >= datetime('now','-7 days') GROUP BY status ORDER BY status"
            ).fetchall()
            if status_rows:
                lines.append(
                    "[nco tasks] 최근 7일 상태: "
                    + ", ".join(f"{status}={count}" for status, count in status_rows)
                )
            duration = db.execute(
                "SELECT COUNT(*), ROUND(AVG((julianday(completed_at)-julianday(created_at))*86400),1), "
                "ROUND(MAX((julianday(completed_at)-julianday(created_at))*86400),1) "
                "FROM tasks WHERE status='completed' AND completed_at IS NOT NULL "
                "AND created_at >= datetime('now','-7 days')"
            ).fetchone()
            if duration and duration[0]:
                lines.append(
                    f"[nco tasks] 최근 7일 완료 소요시간: 표본={duration[0]}, "
                    f"평균초={duration[1]}, 최대초={duration[2]}"
                )
            failure_rows = db.execute(
                "SELECT COALESCE(NULLIF(TRIM(error),''),'오류 문자열 없음') AS reason, COUNT(*) "
                "FROM tasks WHERE status IN ('failed','timed_out','lease_expired','cancelled') "
                "AND created_at >= datetime('now','-7 days') "
                "GROUP BY reason ORDER BY COUNT(*) DESC, reason LIMIT 5"
            ).fetchall()
            for reason, count in failure_rows:
                one_line_reason = " ".join(str(reason).split())[:300]
                lines.append(f"[nco tasks] 최근 실패 원인 빈도={count}: {one_line_reason}")
            note_count = db.execute("SELECT COUNT(*) FROM improvement_notes").fetchone()[0]
            lines.append(f"[improvement_notes] 현재 기록={note_count}")
        except (OSError, sqlite3.Error):
            pass

    # gov-evolution-learning 전용: 교훈 추출의 원재료(태스크 근거 + 연결된 learning_events)를 넣는다.
    #   src/core/work-report-scheduler.ts의 동일 블록과 같은 쿼리·같은 라벨·같은 상한을 쓴다.
    if is_evolution_learning and db is not None and evolution_learning_context_enabled():
        try:
            evidence_rows = db.execute(
                "SELECT id, status, created_at, completed_at, prompt, response, error, result_json, "
                "evidence_json, "
                "CASE WHEN json_valid(metadata_json) "
                "THEN json_extract(metadata_json,'$.workReportId') ELSE NULL END AS work_report_id "
                "FROM tasks WHERE team_id=? "
                "AND status IN ('completed','failed','timed_out','lease_expired','cancelled') "
                "AND created_at >= datetime('now','-48 hours') "
                "ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC, id DESC LIMIT 5",
                (team_id,),
            ).fetchall()
            for row in evidence_rows:
                lines.append(", ".join([
                    "[learning_task_evidence] source_tier=T1(SQLite tasks row)",
                    f"id={compact_text(row[0], 100)}",
                    f"상태={compact_text(row[1], 50)}",
                    f"생성={compact_text(row[2], 50)}",
                    f"완료={compact_nullable(row[3], 50)}",
                    f"오류={compact_nullable(row[6], 240)}",
                    f"지시={compact_text(row[4], 240)}",
                    f"응답(T4-natural-language)={compact_nullable(row[5], 400)}",
                    f"result_json={compact_nullable(row[7], 300)}",
                    f"evidence_json={compact_nullable(row[8], 300)}",
                    f"workReportId={compact_nullable(row[9], 100)}",
                ]))
            source_task_ids = [row[0] for row in evidence_rows]
            if source_task_ids:
                placeholders = ",".join("?" for _ in source_task_ids)
                event_rows = db.execute(
                    "SELECT id, agent_id, event_type, pattern, context, auto_applied, created_at "
                    "FROM learning_events WHERE created_at >= datetime('now','-48 hours') "
                    "AND json_valid(context) AND ("
                    f"json_extract(context,'$.taskId') IN ({placeholders}) "
                    f"OR json_extract(context,'$.sourceTaskId') IN ({placeholders})) "
                    "ORDER BY created_at DESC, id DESC LIMIT 10",
                    tuple(source_task_ids) * 2,
                ).fetchall()
                for row in event_rows:
                    lines.append(", ".join([
                        "[learning_event_evidence] source_tier=T1(SQLite learning_events row)",
                        f"id={row[0]}",
                        f"agent={compact_text(row[1], 100)}",
                        f"event={compact_nullable(row[2], 100)}",
                        f"created={compact_text(row[6], 50)}",
                        f"auto_applied={'1' if row[5] == 1 else '0'}",
                        f"pattern={compact_nullable(row[3], 240)}",
                        f"context={compact_text(row[4], 400)}",
                    ]))
        except (OSError, sqlite3.Error):
            pass

    if db is not None:
        db.close()

    # ax-docs 전용: 현재 저장소가 직접 반환한 커밋/추적 파일 변경만 넣는다.
    if team.get("slug") == "ax-docs":
        try:
            commits = subprocess.run(
                ["git", "-C", project_dir, "log", "-5", "--date=iso-strict", "--pretty=format:%h|%ad|%s"],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            if commits:
                lines.append("[git] 최근 커밋:\n" + "\n".join(commits.splitlines()[:5]))
            status = subprocess.run(
                ["git", "-C", project_dir, "status", "--short", "--untracked-files=no"],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            if status:
                changed = status.splitlines()
                lines.append(f"[git] 추적 파일 변경 {len(changed)}건:\n" + "\n".join(changed[:20]))
        except (OSError, subprocess.SubprocessError):
            pass

    if not lines:
        return "데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고."
    return "\n".join(lines)

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
data_context = build_team_data_context()

if is_self_improvement:
    prompt = f"""[자가개선팀 상시 임무 — {team['name']}]
오늘 날짜: {today}
{charter}
[실데이터]
{data_context}
[목표] NCO 코드베이스에서 구체적이고 검증 가능한 개선 1건을 실제로 완료한다.
[절차]
1. 위 [실데이터]의 최근 실패/병목 통계와 실제 코드 분석을 함께 사용해 작고 안전한 개선 대상을 1건 선정한다.
2. 도구를 사용해 실제 파일을 수정한다.
3. 변경 후 `npx tsc --noEmit`의 종료 코드 0과 관련 Vitest의 통과를 실제 출력으로 확인한다.
4. 응답에 개선 요약, 정확한 file:line, diff 요약, 실행한 검증 명령과 실제 결과를 포함한다.
[안전 제약]
- git commit/push, 배포, pm2 또는 서버 재시작, rm, 대규모 리팩터는 금지한다.
- 한 번에 1~3개 파일만 수정하는 소범위 변경으로 제한한다.
- tsc 종료 코드 0과 관련 테스트 통과를 모두 확인하지 못하면 변경을 되돌리고 사유를 보고한다.
- 실행하지 않은 명령, 보지 않은 출력, 존재하지 않는 경로·수치·완료 상태를 지어내지 않는다.
[응답 규약] 성공한 경우 `done:`으로 시작한다. 변경을 되돌렸거나 완료하지 못한 경우 `error:`로 시작하고
되돌린 범위와 실제 실패 출력을 적는다."""
    verifier = {"type": "run", "command": "npm run build"}
else:
    prompt = f"""[팀 상시 임무 — {team['name']}] (텍스트만 응답, 도구/커맨드 사용 금지)
오늘 날짜: {today}
{charter}
[실데이터]
{data_context}
[실데이터 사용 규칙] 위 값과 주입된 파일 내용만 사실로 사용한다. 데이터가 없더라도 침묵하지 말고
데이터 가용성, 확인 불가 항목, 다음 수집 액션을 구체적으로 보고한다.
[엄수] 너는 파일을 수정하거나 명령(build/test/git/make/npm 등)을 실행할 수 없다 — 오직 텍스트만 생성한다.
그러므로 '변경 파일 목록', 'diff 요약', '빌드 성공', '테스트 통과', '커밋 완료' 등 실제로 수행하지 않은 작업을
했다고 절대 쓰지 마라. 존재하지 않는 파일 경로·버전·수치·완료 상태를 지어내면 산출물은 반려된다.
아래에 주입된 실데이터/파일 내용만 근거로 삼아 (1)오늘 관찰·분석 (2)현재 상태 (3)다음에 필요한 작업 제안을
작성하라. 근거가 없는 항목은 '미확인'으로 표기하라."""
    verifier = None
# 2026-07-12: 백엔드가 metadata.projectDir을 필수로 요구(POST /api/task → 400 "invalid_project_dir").
#   미포함 시 전 팀 태스크 생성이 거부되어 팀이 산출물을 못 냈다. 러너 기준 디렉터리를 주입한다.
body = {"ai": ai, "callerAgentId": "team-runner", "prompt": prompt,
        "metadata": {"projectDir": project_dir}}
if verifier is not None:
    body["verifier"] = verifier
print(json.dumps(body, ensure_ascii=False))
PY
  # 백엔드 재시작 등 일시 장애 시 실패해도 러너가 죽지 않도록 (set -e/pipefail 보호)
  { curl -s -X POST "${API_BASE}/task" -H 'Content-Type: application/json' \
    --data @"${TMP_DIR}/body.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId",""))'; } 2>/dev/null || echo ""
}

poll_done() { # $1=taskId $2=teamId $3=teamSlug → completed면 response 저장 후 0
  local attempt=0 status=""
  local self_improvement=false
  if [ "$2" = "team_self-improvement" ] || [ "$3" = "self-improvement" ]; then
    self_improvement=true
  fi
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
        if [ "${self_improvement}" = false ]; then
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
        fi
        return 0 ;;
      failed|timed_out|error) return 1 ;;
    esac
    sleep "${POLL_INTERVAL}"
  done
  return 1
}

record_improvement_note() { # $1=taskId $2=agent $3=responsePath
  python3 - "$NCO_DIR/db/nco.db" "$1" "$2" "$3" <<'PY'
import json, sqlite3, sys

db_path, task_id, agent, response_path = sys.argv[1:5]
response = open(response_path, encoding="utf-8", errors="replace").read()
db = sqlite3.connect(db_path, timeout=5)
try:
    columns = {row[1] for row in db.execute("PRAGMA table_info(improvement_notes)")}
    required = {"id", "timestamp", "category", "problem", "root_cause", "fix",
                "verified_at", "agent", "severity", "tags"}
    missing = sorted(required - columns)
    if missing:
        raise RuntimeError("improvement_notes 스키마 누락: " + ", ".join(missing))
    db.execute(
        "INSERT INTO improvement_notes "
        "(id, category, problem, root_cause, fix, verified_at, agent, severity, tags) "
        "VALUES (?, 'tooling', ?, '', ?, CURRENT_TIMESTAMP, ?, 'medium', ?)",
        (
            f"team-runner:{task_id}",
            f"자가개선팀 검증 완료 산출물 (taskId={task_id})",
            response,
            agent,
            json.dumps(["self-improvement", "team-runner", f"task:{task_id}"], ensure_ascii=False),
        ),
    )
    db.commit()
finally:
    db.close()
PY
}

# ── 팀 순차 실행 (동시 로컬 LLM 금지) ──
acquire_lock
log INFO "로컬 LLM 락 획득 (pid=$$)"

IDX=0
while [ "${IDX}" -lt "${N_TEAMS}" ]; do
  TEAM_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["id"])' "${TMP_DIR}/runnable.json" "${IDX}")
  TEAM_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["name"])' "${TMP_DIR}/runnable.json" "${IDX}")
  TEAM_SLUG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["slug"])' "${TMP_DIR}/runnable.json" "${IDX}")
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
    if poll_done "${TID}" "${TEAM_ID}" "${TEAM_SLUG}"; then
      if [ "${TEAM_ID}" = "team_self-improvement" ] || [ "${TEAM_SLUG}" = "self-improvement" ]; then
        if ! record_improvement_note "${TID}" "${ai}" "${TMP_DIR}/response.md"; then
          log FAIL "${TEAM_NAME}: improvement_notes 기록 실패"
          break
        fi
      fi
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
