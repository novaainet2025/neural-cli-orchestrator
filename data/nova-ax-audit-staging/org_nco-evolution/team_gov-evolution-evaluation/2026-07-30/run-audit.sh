#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="/Users/nova-ai/project/nova-ax/evidence/audit-gov-evolution-evaluation-20260730"
mkdir -p "$EVIDENCE"

run() {
  echo ""
  echo "=== $1 ==="
  node "$HERE/$2" "${@:3}"
}

run "01-baseline" "01-baseline.mjs"
run "02-inventory" "02-inventory.mjs"
run "03-build-report" "03-build-report.mjs"
cp -f "$HERE/work-report.md" "$EVIDENCE/work-report.md"
run "06b-ui-classification" "06b-ui-classification.mjs"
bash "$HERE/integrity-attest.sh"
node "$HERE/run-test.mjs" "$HERE/claim-verifier.mjs" claim-verification
node "$HERE/run-test.mjs" "$HERE/negative-control.mjs" negative-control
run "04-metrics" "04-metrics.mjs"
run "05-regression-guard" "05-regression-guard.mjs"
run "06-goal-attestation" "06-goal-attestation.mjs"
run "07-submit" "07-submit.mjs"

if grep -q '"status": "approved"' "$HERE/verification-decision.json" 2>/dev/null; then
  run "08-bind-completion" "08-bind-completion.mjs"
else
  echo ""
  echo "=== remediation loop opened; attempting loop resolution ==="
  node "$HERE/10-remediate-loop.mjs" || true
fi

shopt -s nullglob
for f in "$HERE"/*; do
  base="$(basename "$f")"
  case "$base" in *.mjs|*.sh) continue ;; esac
  cp -f "$f" "$EVIDENCE/"
done

node -e "
const fs=require('fs'); const path=require('path');
const HERE='$HERE'; const EVIDENCE='$EVIDENCE';
const decision=JSON.parse(fs.readFileSync(path.join(HERE,'verification-decision.json'),'utf8'));
const report={generatedAt:new Date().toISOString(),taskId:'task_yRDfIvg60k_d6nbN',companyId:'org_nco-evolution',teamId:'team_gov-evolution-evaluation',actorId:'claude-code',runId:decision.runId??null,status:decision.status??null,passedInstitutions:decision.passedInstitutions??null,receiptId:decision.receiptId??null,institutions:decision.results??[],failures:(decision.results??[]).filter(r=>!r.passed),evidenceDir:EVIDENCE,stagingDir:HERE,remediationLoop:decision.remediationLoop??null};
const txt=JSON.stringify(report,null,2)+'\n';
fs.writeFileSync(path.join(EVIDENCE,'AUDIT-REPORT.json'),txt);
fs.writeFileSync(path.join(HERE,'AUDIT-REPORT.json'),txt);
console.log(JSON.stringify(report,null,2));
"
