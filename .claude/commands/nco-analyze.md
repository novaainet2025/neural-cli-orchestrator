# NCO Deep Analyze — Multi-agent Analysis Loop
# Goal: Analyze -> Parallel -> Discussion -> Verify -> Loop
# $ARGUMENTS: Analysis topic

## STEP 1: INITIAL ANALYZE
```bash
curl -s http://localhost:6200/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'NCO:{d.get(\"status\")} Agents:{d.get(\"runtime\",{}).get(\"agentsOnline\")}')"
```
Determine Type: Code|Security|Perf|UI|Research.
Select 3 Agents: (e.g., opencode, mlx, openrouter).

## STEP 2: PARALLEL ANALYSIS
```bash
curl -s -X POST http://localhost:6200/api/realtime/parallel -H "Content-Type: application/json" -d "{\"prompt\":\"Deep analyze: $ARGUMENTS\",\"providers\":[\"opencode\",\"mlx\",\"openrouter\"]}"
```

## STEP 3: CRITICAL DISCUSSION & SYNTHESIS
```bash
curl -s -X POST http://localhost:6200/api/realtime/discussion -H "Content-Type: application/json" -d "{\"prompt\":\"Review analysis results for: $ARGUMENTS\",\"mode\":\"discussion\"}"
```

## STEP 4: VERIFY & GAP ANALYSIS (100% Loop)
Score: Completeness(30) + Accuracy(25) + Depth(25) + Actionability(20).
Gap Rate = Total / 100 * 100.
If Gap < 100% and loop < 3: Return to STEP 2 with gaps.

## STEP 5: FINAL REPORT
```bash
mkdir -p docs/analysis
FILE="docs/analysis/$(date +%Y%m%d-%H%M)-analysis.md"
cat > "$FILE" << EOF
# Analysis: $ARGUMENTS
Gap Rate: XX% | Loop: N
## Findings
...
## Next Actions
...
EOF
```
