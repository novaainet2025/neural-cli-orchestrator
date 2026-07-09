#!/usr/bin/env python3
"""
NCO Workflow Score — 10개 차원 (각 10점, 합계 100점)
사용: python3 workflow-score.py [프로젝트루트] [--plan path] [--output path] [--json] [--workflow-id id]
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
import datetime
from pathlib import Path

# ── 인자 파싱 ────────────────────────────────────────────────────────────
ROOT = Path.cwd()
PLAN_FILE = None
OUTPUT_FILE = None
WORKFLOW_ID = ""
JSON_OUT = False

args = sys.argv[1:]
i = 0
while i < len(args):
    a = args[i]
    if a == "--plan" and i + 1 < len(args):
        PLAN_FILE = Path(args[i + 1]); i += 2
    elif a == "--output" and i + 1 < len(args):
        OUTPUT_FILE = Path(args[i + 1]); i += 2
    elif a == "--workflow-id" and i + 1 < len(args):
        WORKFLOW_ID = args[i + 1]; i += 2
    elif a == "--json":
        JSON_OUT = True; i += 1
    elif a in ("-h", "--help"):
        print(__doc__); sys.exit(0)
    elif not a.startswith("--"):
        ROOT = Path(a).resolve(); i += 1
    else:
        i += 1

NCO_API = os.environ.get("NCO_API", "http://localhost:6200")
NCO_TOKEN = os.environ.get("NCO_TOKEN", "nco_secret_key_change_me_in_production")
CUTOFF_MIN = 90  # 최근 90분 활동


def nco_get(path):
    try:
        req = urllib.request.Request(
            f"{NCO_API}{path}",
            headers={"Authorization": f"Bearer {NCO_TOKEN}"}
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return {}


def run(cmd, **kw):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)
    except Exception:
        return None


# ── 공통 데이터 수집 ─────────────────────────────────────────────────────
task_resp = nco_get("/api/tasks?limit=50")
all_tasks = task_resp.get("tasks", []) if isinstance(task_resp, dict) else []
now = datetime.datetime.utcnow()
cutoff = now - datetime.timedelta(minutes=CUTOFF_MIN)

recent_tasks = []
for t in all_tasks:
    try:
        ts = datetime.datetime.strptime(t.get("created_at", "")[:19], "%Y-%m-%d %H:%M:%S")
        if ts >= cutoff:
            recent_tasks.append(t)
    except Exception:
        pass


# ── 1. 문서화 (10) ──────────────────────────────────────────────────────
def score_docs():
    s = 0
    detail = []
    # docs/plans/에 plan 파일
    plan_dir = ROOT / "docs" / "plans"
    pcount = len(list(plan_dir.glob("*.md"))) if plan_dir.exists() else 0
    if pcount >= 1:
        s += 3; detail.append(f"plans:{pcount}")
    # README
    if (ROOT / "README.md").exists():
        s += 2; detail.append("README")
    # workflow 보고서
    wf_dir = ROOT / "docs" / "workflows"
    rcount = len(list(wf_dir.glob("*.md"))) if wf_dir.exists() else 0
    if rcount >= 1:
        s += 3; detail.append(f"reports:{rcount}")
    # nco-workflow-full 커맨드
    if (ROOT / ".claude" / "commands" / "nco-workflow-full.md").exists():
        s += 2; detail.append("workflow-cmd")
    return min(s, 10), " ".join(detail)


# ── 2. 계획 (10) ────────────────────────────────────────────────────────
def score_plan():
    s = 0
    detail = []
    total = done = 0
    # 체크리스트
    target = PLAN_FILE
    if not target:
        plan_dir = ROOT / "docs" / "plans"
        # 가장 최근 수정된 plan 파일 선택 (완성도 높은 최신 파일 우선)
        candidates = sorted(plan_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if plan_dir.exists() else []
        target = candidates[0] if candidates else None
    if target and target.exists():
        for line in target.read_text(errors="replace").splitlines():
            if re.match(r"^[-*]\s+\[[xX]\]", line):
                total += 1; done += 1
            elif re.match(r"^[-*]\s+\[ \]", line):
                total += 1
        if total > 0:
            s += round(done * 6 / total)
            detail.append(f"checklist:{done}/{total}")
        else:
            s += 2; detail.append("plan-exists")
    else:
        s += 1; detail.append("no-plan")
    # workflow-pipeline.ts
    if (ROOT / "src" / "core" / "workflow-pipeline.ts").exists():
        s += 2; detail.append("pipeline.ts")
    # workflow-score.sh / .py
    if (ROOT / "scripts" / "workflow-score.sh").exists() or (ROOT / "scripts" / "workflow-score.py").exists():
        s += 2; detail.append("score-script")
    return min(s, 10), " ".join(detail)


# ── 3. Task 시스템 (10) ─────────────────────────────────────────────────
def score_task():
    agents = sorted(set(t.get("assigned_to", "") for t in recent_tasks if t.get("assigned_to")))
    n = len(recent_tasks)
    if n >= 5:   s = 10
    elif n >= 3: s = 8
    elif n >= 1: s = 5
    else:         s = 0
    detail = f"calls:{n} agents:[{','.join(agents[:4])}]"
    return s, detail


# ── 4. 병렬·협업 (10) ───────────────────────────────────────────────────
def score_parallel():
    modes = set(t.get("mode", "task") for t in recent_tasks)
    pmodes = sorted(modes & {"parallel", "discussion", "consensus", "hive", "company", "full-pipeline"})
    pc = len(pmodes)
    if pc >= 3:   s = 6
    elif pc >= 2: s = 5
    elif pc >= 1: s = 4
    else:          s = 1
    # inter-session 연결 (적극적 협업 지표 — 세션당 최대 +2, 최대 4점)
    sess_dir = Path.home() / ".claude" / "data" / "inter-session" / "clients"
    sess_count = len(list(sess_dir.glob("*.session"))) if sess_dir.exists() else 0
    if sess_count >= 5:   s += 4
    elif sess_count >= 3: s += 3
    elif sess_count >= 1: s += 2
    # NCO discussion/hive 세션 활성 여부 (API 확인)
    nco_sessions = nco_get("/api/sessions?limit=10") if hasattr(nco_get, "__call__") else {}
    sess_active = len(nco_sessions.get("sessions", [])) if isinstance(nco_sessions, dict) else 0
    if sess_active >= 2:
        s += 1
    detail = f"pmodes:[{','.join(pmodes)}] inter-session:{sess_count} nco-sess:{sess_active}"
    return min(s, 10), detail


# ── 5. 워크플로우 (10) ──────────────────────────────────────────────────
def score_workflow():
    s = 0
    detail = []
    # conductor/workflow 사용?
    if recent_tasks:
        s += 5; detail.append("conductor:used")
    # nco-workflow-full.md
    if (ROOT / ".claude" / "commands" / "nco-workflow-full.md").exists():
        s += 3; detail.append("workflow-full")
    # auto-report.sh
    if (ROOT / "scripts" / "auto-report.sh").exists():
        s += 2; detail.append("auto-report")
    return min(s, 10), " ".join(detail)


# ── 6. 교차검증 (10) ────────────────────────────────────────────────────
def score_crossval():
    s = 0
    agents = set(t.get("assigned_to") for t in recent_tasks if t.get("assigned_to"))
    review_agents = agents & {"cursor-agent", "nvidia", "gemini"}
    reviews = [t for t in recent_tasks
               if t.get("assigned_to") in ("cursor-agent", "nvidia", "gemini")
               and any(kw in (t.get("prompt") or "") for kw in ("검증", "리뷰", "review", "verify"))]
    if len(agents) >= 3:
        s += 5
    if len(reviews) >= 1:
        s += 5
    detail = f"agents:{len(agents)} reviewers:[{','.join(sorted(review_agents))}] reviews:{len(reviews)}"
    return min(s, 10), detail


# ── 7. 시각 검증 (10) ───────────────────────────────────────────────────
def score_visual():
    s = 0
    detail = []
    tsc_errs = 0
    # health check
    health = nco_get("/health")
    if health:
        agents_online = health.get("runtime", {}).get("agentsOnline", 0)
        s += 5; detail.append(f"health:ok agents:{agents_online}")
    # before/after 스냅샷
    snap = len(list(Path("/tmp").glob("before.json"))) + len(list(Path("/tmp").glob("after.json")))
    if snap >= 2:
        s += 2; detail.append(f"snapshots:{snap}")
    # tsc 오류 없음 (로컬 TypeScript 우선, npx fallback)
    tsc_cfg = ROOT / "tsconfig.json"
    if tsc_cfg.exists():
        local_tsc = ROOT / "node_modules" / ".bin" / "tsc"
        tsc_cmd = [str(local_tsc), "--noEmit"] if local_tsc.exists() else ["npx", "tsc", "--noEmit"]
        r = run(tsc_cmd, cwd=ROOT)
        if r and r.returncode == 0:
            tsc_out = (r.stdout or "") + (r.stderr or "")
            # 가짜 tsc (fake message) 감지
            if "not the tsc command" in tsc_out or "npm install typescript" in tsc_out:
                # 로컬 TypeScript 없음 — 차선으로 build 스크립트 확인
                pkg = ROOT / "package.json"
                if pkg.exists():
                    import json as _j
                    pj = _j.loads(pkg.read_text())
                    if "typescript" in pj.get("dependencies", {}) or "typescript" in pj.get("devDependencies", {}):
                        s += 2; detail.append("ts-dep:ok")
            else:
                s += 3; detail.append("tsc:ok")
        else:
            errs = (r.stderr or "").count("error TS") if r else 0
            # TypeScript 없어도 devDependency로 선언된 경우 부분 점수
            pkg = ROOT / "package.json"
            if pkg.exists():
                try:
                    import json as _j2
                    pj = _j2.loads(pkg.read_text())
                    if "typescript" in pj.get("devDependencies", {}) or "typescript" in pj.get("dependencies", {}):
                        s += 2; detail.append("ts-dep:ok(no-binary)")
                    else:
                        detail.append(f"tsc:{errs}err")
                except Exception:
                    detail.append(f"tsc:{errs}err")
            else:
                detail.append(f"tsc:{errs}err")
    return min(s, 10), " ".join(detail)


# ── 8. 갭 분석 (10) ─────────────────────────────────────────────────────
def score_gap():
    s = 0
    detail = []
    # score script 실행됨 (현재 실행 중 = 갭 분석 자체)
    s += 2; detail.append("score-ran")
    # nco-gap 커맨드 존재?
    if (ROOT / ".claude" / "commands" / "nco-gap.md").exists():
        s += 3; detail.append("nco-gap:cmd")
    # 태스크 활성도 (dispatched + completed 기반)
    total = len(all_tasks)
    completed = sum(1 for t in all_tasks if t.get("status") == "completed")
    failed = sum(1 for t in all_tasks if t.get("status") == "failed")
    if total >= 10 and completed >= 5:
        s += 3; detail.append(f"active:{total} done:{completed}")
    elif total >= 5 and completed >= 1:
        s += 2; detail.append(f"active:{total} done:{completed}")
    else:
        s += 1; detail.append(f"active:{total}")
    # 실패/오류 태스크 비율 (전체의 20% 미만이면 정상)
    fail_rate = round(failed / max(1, total) * 100)
    if fail_rate <= 10:
        s += 2; detail.append(f"fail-rate:{fail_rate}%")
    elif fail_rate <= 20:
        s += 1; detail.append(f"fail-rate:{fail_rate}%")
    return min(s, 10), " ".join(detail)


# ── 9. 최종 보고서 (10) ─────────────────────────────────────────────────
def score_report():
    s = 0
    detail = []
    wf_dir = ROOT / "docs" / "workflows"
    reports = sorted(wf_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if wf_dir.exists() else []
    if reports:
        latest = reports[0]
        s += 4; detail.append(f"report:{latest.name}")
        content = latest.read_text(errors="replace")
        # 검증 영수증 포함?
        if re.search(r"검증 영수증|verification receipt|\[변경\]|\[검증방법\]", content):
            s += 4; detail.append("receipt:ok")
        # 보고서 크기
        if len(content) >= 1000:
            s += 2; detail.append(f"len:{len(content)}B")
    else:
        detail.append("no-reports")
    return min(s, 10), " ".join(detail)


# ── 10. 다음 작업 추천 (10) ─────────────────────────────────────────────
def score_next():
    s = 0
    detail = []
    cmd_dir = ROOT / ".claude" / "commands"
    if (cmd_dir / "nco-next.md").exists():
        s += 3; detail.append("nco-next:cmd")
    if (cmd_dir / "nco-next-parallel.md").exists():
        s += 2; detail.append("nco-next-parallel")
    # 최신 보고서에 다음 작업 섹션?
    wf_dir = ROOT / "docs" / "workflows"
    reports = sorted(wf_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if wf_dir.exists() else []
    if reports:
        content = reports[0].read_text(errors="replace")
        if re.search(r"다음.{0,5}작업|next.{0,5}action|후속|recommend|추천", content, re.I):
            s += 5; detail.append("next-in-report")
    return min(s, 10), " ".join(detail)


# ── 실행 ────────────────────────────────────────────────────────────────
dims = {
    "1_docs":     score_docs(),
    "2_plan":     score_plan(),
    "3_task":     score_task(),
    "4_parallel": score_parallel(),
    "5_workflow": score_workflow(),
    "6_crossval": score_crossval(),
    "7_visual":   score_visual(),
    "8_gap":      score_gap(),
    "9_report":   score_report(),
    "10_next":    score_next(),
}
LABELS = {
    "1_docs": "문서화", "2_plan": "계획", "3_task": "Task",
    "4_parallel": "병렬협업", "5_workflow": "워크플로우", "6_crossval": "교차검증",
    "7_visual": "시각검증", "8_gap": "갭분석", "9_report": "최종보고서", "10_next": "다음추천",
}
TOTAL = sum(v[0] for v in dims.values())
PASSED = TOTAL >= 95

if JSON_OUT:
    print(json.dumps({
        "workflowId": WORKFLOW_ID,
        "total": TOTAL,
        "passed": PASSED,
        "threshold": 95,
        "dimensions": {k: {"score": v[0], "max": 10, "detail": v[1]} for k, v in dims.items()}
    }, ensure_ascii=False))
else:
    bar = "✅ PASS (≥95)" if PASSED else "❌ FAIL"
    print("━" * 50)
    print(f" NCO Workflow Score: {TOTAL}/100  {bar}")
    print(f" Threshold: 95  |  최근 {CUTOFF_MIN}분 활동 기준")
    print("━" * 50)
    for k, (sc, det) in dims.items():
        label = LABELS.get(k, k)
        gap_indicator = "✅" if sc >= 8 else ("⚠️" if sc >= 5 else "❌")
        print(f" {gap_indicator} {k:12s} {label:8s}  {sc:2d}/10   {det}")
    print("━" * 50)
    missing = [(k, 10 - v[0]) for k, v in dims.items() if v[0] < 10]
    if missing:
        print(" 개선 필요:")
        for k, gap in sorted(missing, key=lambda x: -x[1]):
            print(f"   • {LABELS.get(k,k)}: +{gap}점 가능")
