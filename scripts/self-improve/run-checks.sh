#!/usr/bin/env bash
# run-checks.sh — NCO 자가개선: 체크리스트 항목을 객관 게이트로 점검 (매시간)
# 각 항목의 kind별 실제 게이트(bash -n / tsc / http / grep / fs)를 실행해 PASS/FAIL 산출.
# 기준 미달 항목 → queue.jsonl 적재 + (propose 모드) 우선순위 1건을 NCO conductor에 진단·개선 위임.
# 원칙(안전): 코드 자동 커밋 금지. 위임은 "diff 제안·미커밋"으로 지시. 지어내지 않는다.
set -euo pipefail

NCO_DIR="/Users/nova-ai/project/nco"
OUT_DIR="${NCO_DIR}/data/self-improve"
CFG="${OUT_DIR}/config.json"
CHECKLIST="${OUT_DIR}/checklist-latest.json"
LOG="${OUT_DIR}/check.log"
LOCK_FILE="/tmp/nova-local-llm.lock"
TS=$(date '+%Y-%m-%dT%H:%M:%S%z')

log(){ printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "${LOG}" >&2; }

[ -f "${CHECKLIST}" ] || { log "체크리스트 없음 — build-checklist.sh 먼저 실행"; exit 0; }
[ -f "${CFG}" ] || { log "config.json 없음"; exit 1; }

# 팀 charter 라이브 재조회 (실패해도 꾸미지 않음)
TMP=$(mktemp -d); trap 'rm -rf "${TMP}"' EXIT
curl -fsS --max-time 6 "http://localhost:6200/api/teams" -o "${TMP}/teams.json" 2>/dev/null || echo '{"teams":[]}' > "${TMP}/teams.json"
curl -fsS --max-time 6 "http://localhost:6200/health" -o "${TMP}/health.json" 2>/dev/null || echo '{}' > "${TMP}/health.json"

# 로컬 LLM 락 상태 (dispatch가 로컬모델 쓸 수 있어 team-runner와 충돌 회피, 비차단)
LOCK_BUSY=0
if [ -e "${LOCK_FILE}" ]; then
  owner=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
  if [ -n "${owner}" ] && kill -0 "${owner}" 2>/dev/null; then LOCK_BUSY=1; fi
fi

python3 - "$NCO_DIR" "$OUT_DIR" "$TMP" "$TS" "$LOCK_BUSY" <<'PY'
import json, os, sys, glob, subprocess, time, urllib.request

nco, out, tmp, ts, lock_busy = sys.argv[1:6]
lock_busy = (lock_busy == "1")
cfg = json.load(open(os.path.join(out, "config.json")))
checklist = json.load(open(os.path.join(out, "checklist-latest.json")))
mode = cfg.get("mode", "propose")
thresholds = cfg.get("thresholds", {})
disp = cfg.get("dispatch", {})
now = time.time()

# 라이브 스냅샷
try: teams = {(_t.get("id") or _t.get("slug") or _t.get("name")): _t
              for _t in json.load(open(os.path.join(tmp,"teams.json"))).get("teams",[])}
except Exception: teams = {}
try: health = json.load(open(os.path.join(tmp,"health.json")))
except Exception: health = {}
health_ok = health.get("status") == "healthy"
provider_count = health.get("providerCount")

# expensive check 스케줄 (tsc)
def is_due(name, every_hours):
    marker = os.path.join(out, f".last-{name}")
    if not os.path.exists(marker): return True
    try: last = float(open(marker).read().strip())
    except Exception: return True
    return (now - last) >= every_hours*3600
def stamp(name):
    open(os.path.join(out, f".last-{name}"), "w").write(str(now))

def run(cmd, cwd=None, timeout=180):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except Exception as e:
        return 1, str(e)

# ── 항목별 게이트 ──
def check_item(it):
    kind, ref = it["kind"], it.get("ref","")
    # returns (status, detail)  status ∈ pass|fail|skip|defer
    if kind == "bash-syntax":
        if not os.path.exists(ref): return "fail", "파일 없음"
        rc, o = run(["bash","-n",ref], timeout=30)
        return ("pass","") if rc==0 else ("fail", o.strip()[:400])
    if kind == "file-nonempty":
        return ("pass","") if os.path.exists(ref) and os.path.getsize(ref)>0 else ("fail","없거나 빈 파일")
    if kind == "dir-exists":
        return ("pass","") if os.path.isdir(ref) else ("fail","디렉터리 없음")
    if kind == "skill-valid":
        if not os.path.exists(ref): return "fail","SKILL.md 없음"
        head = open(ref, encoding="utf-8", errors="ignore").read(200).lstrip()
        return ("pass","") if head.startswith("---") else ("fail","frontmatter(---) 없음")
    if kind == "team-charter":
        t = teams.get(ref)
        if t is None:
            # 라이브 조회 실패 시 체크리스트 스냅샷값으로 판정(오탐 방지)
            return ("pass","") if it.get("has_charter") else ("fail","charter 없음(스냅샷)")
        return ("pass","") if (t.get("charter") or "").strip() else ("fail","charter 비어있음")
    if kind == "provider-live":
        if not it.get("enabled", True):
            return "skip","의도적 비활성(local override)"
        # 개별 런타임 게이트는 HTTP 미노출 → NCO healthy면 등록 가정, 아니면 fail
        return ("pass","") if health_ok else ("fail","NCO offline — 등록 확인 불가")
    if kind == "mcp-count":
        exp = it.get("expected_min", 0)
        rc, o = run(["grep","-rhoE", r"name: ['\"]nco_[a-z_]+['\"]", os.path.join(nco,"src","mcp")])
        cur = len(set(l for l in o.splitlines() if l.strip()))
        return ("pass",f"{cur}") if cur>=exp else ("fail",f"현재 {cur} < 기대 {exp}")
    if kind == "tsc-noemit":
        if not is_due("tsc", cfg.get("expensive_checks",{}).get("build",{}).get("every_hours",6)):
            return "defer","6h 주기 미도래"
        rc, o = run(["npx","tsc","--noEmit"], cwd=nco, timeout=300)
        stamp("tsc")
        if rc==0: return "pass",""
        errs = [l for l in o.splitlines() if "error TS" in l]
        return "fail", f"tsc 오류 {len(errs)}건: " + " | ".join(errs[:3])
    if kind == "http-health":
        try:
            with urllib.request.urlopen(ref, timeout=6) as r:
                h = json.loads(r.read().decode())
            return ("pass","") if h.get("status")=="healthy" else ("fail", f"status={h.get('status')}")
        except Exception as e:
            return "fail", f"health 실패: {e}"
    return "skip", f"미지원 kind={kind}"

results = []
for it in checklist["items"]:
    st, detail = check_item(it)
    results.append({**it, "status": st, "detail": detail})

# 카테고리별 점수
cats = {}
for r in results:
    c = r["category"]; cats.setdefault(c, {"pass":0,"fail":0,"skip":0,"defer":0})
    cats[c][r["status"]] += 1
cat_summary = {}
for c, v in cats.items():
    denom = v["pass"] + v["fail"]
    rate = (v["pass"]/denom) if denom else 1.0
    thr = thresholds.get(c, 1.0)
    cat_summary[c] = {**v, "pass_rate": round(rate,4), "threshold": thr,
                      "meets": rate >= thr}

# provider registry 이상(런타임 파손) — 별도 앵커 소견
enabled_providers = [r for r in results if r["category"]=="provider" and r.get("enabled",True)]
prov_anomaly = None
if provider_count is not None and len(enabled_providers) and provider_count < len(enabled_providers):
    prov_anomaly = f"health.providerCount={provider_count} < enabled={len(enabled_providers)} (일부 프로바이더 미등록 의심)"

failures = [r for r in results if r["status"]=="fail"]
failures.sort(key=lambda r: (r.get("priority",99), r["category"], r["id"]))

status_obj = {
    "checked_at": ts, "mode": mode,
    "total": len(results),
    "pass": sum(1 for r in results if r["status"]=="pass"),
    "fail": len(failures),
    "skip": sum(1 for r in results if r["status"]=="skip"),
    "defer": sum(1 for r in results if r["status"]=="defer"),
    "categories": cat_summary,
    "provider_anomaly": prov_anomaly,
    "failures": [{"id":f["id"],"category":f["category"],"kind":f["kind"],
                  "ref":f.get("ref",""),"priority":f.get("priority",99),
                  "detail":f["detail"]} for f in failures],
}
json.dump(status_obj, open(os.path.join(out,"status-latest.json"),"w"),
          ensure_ascii=False, indent=2)

# queue.jsonl 적재 (신규 실패)
qpath = os.path.join(out, "queue.jsonl")
with open(qpath, "a") as q:
    for f in failures:
        q.write(json.dumps({"ts":ts,"id":f["id"],"category":f["category"],
            "kind":f["kind"],"ref":f.get("ref",""),"priority":f.get("priority",99),
            "detail":f["detail"]}, ensure_ascii=False)+"\n")
    if prov_anomaly:
        q.write(json.dumps({"ts":ts,"id":"provider:registry","category":"provider",
            "kind":"registry-anomaly","ref":"/health","priority":4,
            "detail":prov_anomaly}, ensure_ascii=False)+"\n")

# ── dispatch (propose 모드): 우선순위 1건, cooldown, 락 회피 ──
dispatched = None
dlog_path = os.path.join(out, "dispatch-log.json")
try: dlog = json.load(open(dlog_path))
except Exception: dlog = {}

def can_dispatch(fid):
    last = dlog.get(fid)
    if not last: return True
    return (now - last) >= disp.get("cooldown_hours",6)*3600

candidates = failures[:]
if prov_anomaly: candidates = candidates + [{"id":"provider:registry","category":"provider",
    "kind":"registry-anomaly","ref":"/health","priority":4,"detail":prov_anomaly}]
candidates.sort(key=lambda r: (r.get("priority",99), r["id"]))

reason_skip = None
if mode == "report":
    reason_skip = "mode=report (디스패치 안 함)"
elif not disp.get("enabled", True):
    reason_skip = "dispatch.enabled=false"
elif lock_busy:
    reason_skip = "nova-local-llm.lock 사용 중 (team-runner 등) — 이번 회차 디스패치 보류, 점검은 완료"
elif mode == "auto":
    reason_skip = "mode=auto는 이 빌드에서 자동커밋 미구현 — propose로 처리 권장(안전). 커밋 없이 진단만 위임"

if reason_skip is None and mode in ("propose","auto"):
    target = next((c for c in candidates if can_dispatch(c["id"])), None)
    if target is None:
        reason_skip = "디스패치 후보 없음(모두 cooldown 내) 또는 실패 0"
    else:
        prompt = (
            f"[NCO 자가개선 — 진단·개선 제안(커밋 금지)]\n"
            f"요소: {target['id']} (카테고리 {target['category']}, 게이트 {target['kind']})\n"
            f"대상 경로/참조: {target.get('ref','')}\n"
            f"게이트 실패 상세: {target['detail']}\n\n"
            f"지시:\n"
            f"1) 이 요소와 그 의존성(관련 코드/설정 파일)을 모두 파악한다.\n"
            f"2) 실패의 근본원인을 규명한다(성능저하/충돌/에러/기능부족 중 무엇인지 분류).\n"
            f"3) 수정 diff를 제안한다. 단 main 브랜치에 커밋하지 말 것 — diff와 근거만 출력.\n"
            f"4) 리서치가 필요하면 research 팀/copilot을 호출해 근거를 보강한다.\n"
            f"5) 검증 방법(재현 명령/기대 결과)을 함께 제시한다.\n"
            f"출력: 근본원인 → 제안 diff → 검증방법 → 미검증항목."
        )
        try:
            req = urllib.request.Request(disp.get("endpoint","http://localhost:6200/api/conductor"),
                data=json.dumps({"prompt":prompt}).encode(),
                headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                resp = json.loads(r.read().decode())
            task_id = resp.get("taskId") or resp.get("id") or "unknown"
            dlog[target["id"]] = now
            json.dump(dlog, open(dlog_path,"w"))
            dispatched = {"id":target["id"], "taskId":task_id}
        except Exception as e:
            reason_skip = f"디스패치 실패(NCO): {e}"

# dispatch 기록을 status에 반영
status_obj["dispatch"] = {"mode":mode, "dispatched":dispatched, "skipped_reason":reason_skip}
json.dump(status_obj, open(os.path.join(out,"status-latest.json"),"w"),
          ensure_ascii=False, indent=2)

print(f"CHECK mode={mode} total={status_obj['total']} pass={status_obj['pass']} "
      f"fail={status_obj['fail']} skip={status_obj['skip']} defer={status_obj['defer']}")
print("categories_failing:", [c for c,v in cat_summary.items() if not v["meets"]])
if prov_anomaly: print("provider_anomaly:", prov_anomaly)
print("dispatch:", json.dumps(status_obj["dispatch"], ensure_ascii=False))
PY
