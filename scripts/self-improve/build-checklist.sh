#!/usr/bin/env bash
# build-checklist.sh — NCO 자가개선: "모든 요소" 기능 체크리스트 생성 (하루 1회+)
# 지상 진실(T1) 소스만 열거한다: config/ai-providers.json, /api/teams, 파일시스템, 소스 grep.
# 산출: data/self-improve/checklist-latest.json (+ dated copy) + checklist-latest.md
# 원칙: 지어내지 않는다. 소스가 없으면 해당 카테고리를 생략하고 그 사실을 기록한다.
set -euo pipefail

NCO_DIR="/Users/nova-ai/project/nco"
OUT_DIR="${NCO_DIR}/data/self-improve"
CLAUDE_HOME="${HOME}/.claude"
API_BASE="http://localhost:6200/api"
TODAY=$(date '+%Y-%m-%d')
TS=$(date '+%Y-%m-%dT%H:%M:%S%z')

mkdir -p "${OUT_DIR}"
TMP=$(mktemp -d); trap 'rm -rf "${TMP}"' EXIT

# 팀 스냅샷 (실패해도 꾸미지 않음 — 빈 소스로 처리)
curl -fsS --max-time 6 "${API_BASE}/teams" -o "${TMP}/teams.json" 2>/dev/null || echo '{"teams":[]}' > "${TMP}/teams.json"
# health 스냅샷
curl -fsS --max-time 6 "http://localhost:6200/health" -o "${TMP}/health.json" 2>/dev/null || echo '{}' > "${TMP}/health.json"

python3 - "$NCO_DIR" "$CLAUDE_HOME" "$TMP" "$OUT_DIR" "$TODAY" "$TS" <<'PY'
import json, os, sys, glob, subprocess

nco, home, tmp, out, today, ts = sys.argv[1:7]
items = []
sources = {}   # category -> where it came from
missing = []   # categories with no source (recorded, not fabricated)

def add(cat, iid, kind, ref, priority, extra=None):
    it = {"id": iid, "category": cat, "kind": kind, "ref": ref, "priority": priority}
    if extra: it.update(extra)
    items.append(it)

# 1) providers — ground truth: config/ai-providers.json + local overrides
prov_path = os.path.join(nco, "config", "ai-providers.json")
local_path = os.path.join(nco, "config", "ai-providers.local.json")
overrides = {}
if os.path.exists(local_path):
    try: overrides = (json.load(open(local_path)) or {}).get("overrides", {})
    except Exception: overrides = {}
if os.path.exists(prov_path):
    try:
        pd = json.load(open(prov_path))
        plist = pd.get("providers") if isinstance(pd, dict) else pd
        plist = plist or []
        n = 0
        for p in plist:
            pid = p.get("id")
            if not pid: continue
            ov = overrides.get(pid, {})
            enabled = ov.get("enabled", p.get("enabled", True))
            add("provider", f"provider:{pid}", "provider-live", pid, 4,
                {"enabled": bool(enabled)})
            n += 1
        sources["provider"] = f"config/ai-providers.json ({n})"
    except Exception as e:
        missing.append(f"provider (parse error: {e})")
else:
    missing.append("provider (config/ai-providers.json 부재)")

# 2) teams — ground truth: /api/teams
try:
    td = json.load(open(os.path.join(tmp, "teams.json")))
    teams = td.get("teams", []) or []
    for t in teams:
        tid = t.get("id") or t.get("slug") or t.get("name")
        if not tid: continue
        has_charter = bool((t.get("charter") or "").strip())
        add("team", f"team:{tid}", "team-charter", tid, 7,
            {"name": t.get("name"), "has_charter": has_charter,
             "slug": t.get("slug") or ""})
    sources["team"] = f"/api/teams ({len(teams)})"
    if not teams:
        missing.append("team (/api/teams 빈 응답 — NCO offline 가능)")
except Exception as e:
    missing.append(f"team (api error: {e})")

# 3) hooks — filesystem: project + global .claude/hooks/*.sh
hookfiles = sorted(set(
    glob.glob(os.path.join(nco, ".claude", "hooks", "*.sh")) +
    glob.glob(os.path.join(home, "hooks", "*.sh"))
))
for f in hookfiles:
    add("hook", f"hook:{os.path.basename(f)}", "bash-syntax", f, 2)
sources["hook"] = f".claude/hooks + ~/.claude/hooks ({len(hookfiles)})"

# 4) scripts — filesystem: project scripts/*.sh (+ self-improve)
scriptfiles = sorted(set(
    glob.glob(os.path.join(nco, "scripts", "*.sh")) +
    glob.glob(os.path.join(nco, "scripts", "self-improve", "*.sh"))
))
for f in scriptfiles:
    add("script", f"script:{os.path.relpath(f, nco)}", "bash-syntax", f, 3)
sources["script"] = f"scripts/*.sh ({len(scriptfiles)})"

# 5) commands — filesystem: .claude/commands/*.md
cmdfiles = sorted(glob.glob(os.path.join(nco, ".claude", "commands", "*.md")))
for f in cmdfiles:
    add("command", f"command:{os.path.basename(f)}", "file-nonempty", f, 8)
sources["command"] = f".claude/commands/*.md ({len(cmdfiles)})"

# 6) skills — filesystem: ~/.claude/skills/*/SKILL.md (+ project if any)
skilldirs = sorted(set(
    glob.glob(os.path.join(home, "skills", "*", "SKILL.md")) +
    glob.glob(os.path.join(nco, ".claude", "skills", "*", "SKILL.md"))
))
for f in skilldirs:
    name = os.path.basename(os.path.dirname(f))
    add("skill", f"skill:{name}", "skill-valid", f, 9)
sources["skill"] = f"~/.claude/skills/*/SKILL.md ({len(skilldirs)})"

# 7) plugins — filesystem: ~/.claude/plugins/cache/*/
plugdirs = sorted(glob.glob(os.path.join(home, "plugins", "cache", "*")))
plugdirs = [d for d in plugdirs if os.path.isdir(d)]
for d in plugdirs:
    add("plugin", f"plugin:{os.path.basename(d)}", "dir-exists", d, 10)
sources["plugin"] = f"~/.claude/plugins/cache/* ({len(plugdirs)})"

# 8) mcp — source grep tool count (harness itself)
mcp_dir = os.path.join(nco, "src", "mcp")
mcp_expected = 0
if os.path.isdir(mcp_dir):
    try:
        r = subprocess.run(
            ["grep", "-rhoE", r"name: ['\"]nco_[a-z_]+['\"]", mcp_dir],
            capture_output=True, text=True)
        mcp_expected = len(set(l for l in r.stdout.splitlines() if l.strip()))
    except Exception:
        mcp_expected = 0
    add("mcp", "mcp:tools", "mcp-count", mcp_dir, 6, {"expected_min": mcp_expected})
    sources["mcp"] = f"src/mcp grep (expected≥{mcp_expected})"
else:
    missing.append("mcp (src/mcp 부재)")

# 9) build — harness typecheck
if os.path.exists(os.path.join(nco, "tsconfig.json")):
    add("build", "build:tsc", "tsc-noemit", nco, 1)
    sources["build"] = "npx tsc --noEmit"

# 10) health — runtime liveness
add("health", "health:nco", "http-health", "http://localhost:6200/health", 5)
sources["health"] = "/health"

checklist = {
    "generated_at": ts,
    "date": today,
    "total_items": len(items),
    "by_category": {c: sum(1 for i in items if i["category"] == c)
                    for c in sorted(set(i["category"] for i in items))},
    "sources": sources,
    "missing_sources": missing,
    "items": items,
}

latest = os.path.join(out, "checklist-latest.json")
dated  = os.path.join(out, f"checklist-{today}.json")
json.dump(checklist, open(latest, "w"), ensure_ascii=False, indent=2)
json.dump(checklist, open(dated, "w"), ensure_ascii=False, indent=2)

# markdown 요약
md = [f"# NCO 기능 체크리스트 — {today}", "",
      f"- 생성: {ts}", f"- 총 항목: **{len(items)}**", ""]
md.append("## 카테고리별 항목 수")
md.append("| 카테고리 | 개수 | 소스 |")
md.append("|---|---|---|")
for c in sorted(checklist["by_category"]):
    md.append(f"| {c} | {checklist['by_category'][c]} | {sources.get(c,'')} |")
if missing:
    md += ["", "## 소스 없음(생략, 지어내지 않음)"] + [f"- {m}" for m in missing]
open(os.path.join(out, "checklist-latest.md"), "w").write("\n".join(md) + "\n")

print(f"OK items={len(items)} categories={len(checklist['by_category'])} missing={len(missing)}")
print("by_category:", json.dumps(checklist["by_category"], ensure_ascii=False))
PY
