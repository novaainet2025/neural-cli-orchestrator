# Opus Commander — Strategic Orchestrator
# Goal: Analyze -> Plan -> Dispatch -> Monitor -> Verify -> Loop
# $ARGUMENTS: Task request

## PHASE 1: ANALYZE
```bash
# Check NCO & Mesh
curl -s http://localhost:6200/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'NCO:{d.get(\"status\")} Agents:{d.get(\"runtime\",{}).get(\"agentsOnline\")}')"
curl -s http://localhost:6200/api/mesh/sessions | python3 -c "import sys,json; s=json.load(sys.stdin); print(f'Active Mesh Sessions: {len([x for x in s if x.get(\"status\") not in (\"done\",\"offline\")])}')"
```
Determine: Complexity (1-10), Scope, Mode (task|parallel|commander|hive).

## PHASE 2: DESIGN & MAPPING
Map tasks to agents. Cost rule: mlx -> openrouter -> aider -> others.
- Architect: opencode | Engineer: codex, aider | Validator: mlx, cursor-agent | Research: copilot

## PHASE 3: PLAN
```bash
mkdir -p docs/plans
PLAN="docs/plans/$(date +%Y%m%d-%H%M)-plan.md"
cat > "$PLAN" << EOF
# Plan: $ARGUMENTS
- [ ] T1: Task -> Agent (seq:1)
- [ ] T2: Task -> Agent (par:2)
EOF
```

## PHASE 4: DISPATCH
```bash
# Mesh Send (if sessions exist)
curl -s -X POST http://localhost:6200/api/mesh/send -H "Content-Type: application/json" -d "{\"from\":\"opus\",\"to\":\"*\",\"message\":\"[TASK] T1...\"}"
# NCO Task
curl -s -X POST http://localhost:6200/api/task -H "Content-Type: application/json" -d "{\"ai\":\"codex\",\"prompt\":\"T1...\"}"
```

## PHASE 5: MONITOR & RE-ASSIGN
Check `GET /api/tasks?limit=10`. If failure: re-assign using fallback map.
Fallback: codex <-> aider | opencode -> gemini+copilot | mlx -> openrouter.

## PHASE 6: VERIFY (GAP ANALYSIS)
```bash
# E2E Check
npx tsc --noEmit
npm test
```
Calculate Gap Rate (Goal: 100%):
- Logic/Feature: 25% | Quality (TSC/Lint): 20% | Test: 20% | Security: 15% | Perf: 10% | Doc: 10%

## PHASE 7: LOOP or REPORT
If Gap < 100%: Loop to P2. If Gap >= 100%: Write report to `docs/opus-reports/`.
```bash
python3 ~/projects/nco-progress.py --once
```
