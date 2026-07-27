#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
mode="${1:-current}"
snapshot_path="${2:-${TMPDIR:-/tmp}/nco-gov-command-collaboration-before.json}"
team_id="team_gov-command-collaboration"

cd "${project_root}"

if [[ ! -f dist/core/team-scorer.js ]]; then
  echo "error: dist/core/team-scorer.js missing; run npm run build first" >&2
  exit 2
fi

measure_team_score() {
  local raw_output
  raw_output="$(
    LOG_LEVEL=silent NCO_SCORE_TEAM_ID="${team_id}" node --input-type=module <<'NODE'
import { computeTeamScores } from './dist/core/team-scorer.js';

const teamId = process.env.NCO_SCORE_TEAM_ID;
const row = computeTeamScores().find((item) => item.teamId === teamId);
if (!row) {
  console.error(`error: active team score not found: ${teamId}`);
  process.exit(3);
}
process.stdout.write(JSON.stringify(row));
NODE
  )"
  printf '%s\n' "${raw_output}" | tail -n 1
}

implementation_fingerprint() {
  {
    for path in \
      src/core/collaboration.ts \
      src/core/collaboration-engine.ts \
      src/core/cli-mesh.ts \
      src/core/company-orchestrator.ts
    do
      if [[ -f "${path}" ]]; then
        shasum -a 256 "${path}"
      else
        printf 'MISSING  %s\n' "${path}"
      fi
    done

    if [[ -d src/mesh ]]; then
      while IFS= read -r path; do
        shasum -a 256 "${path}"
      done < <(find src/mesh -type f -print | LC_ALL=C sort)
    else
      printf 'MISSING  src/mesh\n'
    fi
  } | shasum -a 256 | awk '{print $1}'
}

make_snapshot() {
  local measurement="$1"
  local score_json
  local fingerprint
  score_json="$(measure_team_score)"
  fingerprint="$(implementation_fingerprint)"

  NCO_SCORE_MEASUREMENT="${measurement}" \
  NCO_SCORE_JSON="${score_json}" \
  NCO_SCORE_FINGERPRINT="${fingerprint}" \
  node --input-type=module <<'NODE'
const snapshot = {
  measurement: process.env.NCO_SCORE_MEASUREMENT,
  observedAt: new Date().toISOString(),
  evidenceSource: 'computeTeamScores(dist/core/team-scorer.js) over db/nco.db',
  implementationFingerprint: process.env.NCO_SCORE_FINGERPRINT,
  teamScore: JSON.parse(process.env.NCO_SCORE_JSON),
};
process.stdout.write(JSON.stringify(snapshot));
NODE
}

case "${mode}" in
  current)
    make_snapshot current
    printf '\n'
    ;;
  before)
    if [[ -e "${snapshot_path}" ]]; then
      echo "error: refusing to overwrite existing before snapshot: ${snapshot_path}" >&2
      exit 5
    fi
    snapshot="$(make_snapshot before)"
    printf '%s\n' "${snapshot}" > "${snapshot_path}"
    printf '%s\n' "${snapshot}"
    ;;
  after)
    if [[ ! -f "${snapshot_path}" ]]; then
      echo "error: before snapshot missing: ${snapshot_path}" >&2
      exit 4
    fi
    current="$(make_snapshot after)"
    NCO_SCORE_BASELINE_PATH="${snapshot_path}" \
    NCO_SCORE_CURRENT="${current}" \
    node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const baseline = JSON.parse(readFileSync(process.env.NCO_SCORE_BASELINE_PATH, 'utf8'));
const current = JSON.parse(process.env.NCO_SCORE_CURRENT);
if (
  baseline?.measurement !== 'before'
  || baseline?.teamScore?.teamId !== current?.teamScore?.teamId
  || typeof baseline?.implementationFingerprint !== 'string'
) {
  console.error('error: incompatible before snapshot');
  process.exit(5);
}
const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;
const implementationChanged =
  baseline.implementationFingerprint !== current.implementationFingerprint;
const result = {
  measurement: 'before-after',
  baseline,
  current,
  comparison: {
    implementationChanged,
    attribution:
      'unattributed: the live DB sample window can change independently of this implementation',
  },
  delta: {
    score: round1(current.teamScore.score - baseline.teamScore.score),
    completion: round1(current.teamScore.completion - baseline.teamScore.completion),
    n: current.teamScore.n - baseline.teamScore.n,
    maxN: current.teamScore.maxN - baseline.teamScore.maxN,
  },
};
process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
    ;;
  *)
    echo "error: usage: $0 {current|before|after} [before-snapshot.json]" >&2
    exit 64
    ;;
esac
