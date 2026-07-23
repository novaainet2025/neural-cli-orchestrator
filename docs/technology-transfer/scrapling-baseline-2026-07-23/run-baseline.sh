#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT="/Users/nova-ai/project/nco"
SCRIPT_DIR="${REPO_ROOT}/docs/technology-transfer/scrapling-baseline-2026-07-23"
OUTPUT_DIR="${1:-}"
REPETITIONS="${BENCH_REPETITIONS:-5}"
ITERATIONS="${BENCH_ITERATIONS:-500}"

if [[ -z "${OUTPUT_DIR}" ]]; then
  echo "usage: $0 <new-output-directory>" >&2
  exit 64
fi
if [[ -e "${OUTPUT_DIR}" ]]; then
  echo "refusing to overwrite existing output directory: ${OUTPUT_DIR}" >&2
  exit 73
fi
if ! [[ "${REPETITIONS}" =~ ^[1-9][0-9]*$ ]] || ! [[ "${ITERATIONS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BENCH_REPETITIONS and BENCH_ITERATIONS must be positive integers" >&2
  exit 64
fi

mkdir -p "${OUTPUT_DIR}/logs"
cd "${REPO_ROOT}"

snapshot() {
  shasum -a 256 \
    integrations/scrapling/pyproject.toml \
    integrations/scrapling/uv.lock \
    integrations/scrapling/nco_scrapling/__init__.py \
    integrations/scrapling/nco_scrapling/cli.py \
    integrations/scrapling/nco_scrapling/policy.py \
    integrations/scrapling/nco_scrapling/runner.py \
    integrations/scrapling/tests/test_policy.py \
    integrations/scrapling/tests/test_runner.py \
    src/services/webScrapingService.ts \
    src/server/routes/web-scraping.ts \
    src/server/routes/web-scraping.test.ts \
    src/core/company-orchestrator.ts \
    src/core/company-orchestrator.test.ts \
    db/migrations/080_technology_porting_company.sql \
    db/migrations/081_web_scraping_company.sql
}

snapshot > "${OUTPUT_DIR}/snapshot-before.sha256"

{
  date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
  date '+local=%Y-%m-%dT%H:%M:%S%z'
  printf 'repo=%s\n' "${REPO_ROOT}"
  printf 'git_head=%s\n' "$(git rev-parse HEAD)"
  printf 'git_branch=%s\n' "$(git branch --show-current)"
  printf 'git_dirty_entries=%s\n' "$(git status --porcelain | wc -l | tr -d ' ')"
  printf 'architecture=%s\n' "$(uname -m)"
  sw_vers
  node --version
  npx tsc --version
  uv --version
  integrations/scrapling/.venv/bin/python --version
  printf 'repetitions=%s\n' "${REPETITIONS}"
  printf 'route_iterations_per_outcome=%s\n' "${ITERATIONS}"
} > "${OUTPUT_DIR}/environment.txt"

{
  printf '%s\n' "integrations/scrapling/.venv/bin/python -m unittest discover -s integrations/scrapling/tests -v"
  printf '%s\n' "npx vitest run src/core/company-orchestrator.test.ts src/server/routes/web-scraping.test.ts"
  printf '%s\n' "npx tsc --noEmit"
  printf '%s\n' "DOTENV_CONFIG_QUIET=true BENCH_REPETITIONS=${REPETITIONS} BENCH_ITERATIONS=${ITERATIONS} node --import tsx ${SCRIPT_DIR}/route-benchmark.ts"
  printf '%s\n' "BENCH_REPETITIONS=${REPETITIONS} BENCH_ITERATIONS=${ITERATIONS} ${SCRIPT_DIR}/run-baseline.sh <new-output-directory>"
} > "${OUTPUT_DIR}/commands.txt"

printf 'scenario\tsample\trepetition\texit_code\treal_seconds\tuser_seconds\tsystem_seconds\tmax_rss_raw\tlog\n' \
  > "${OUTPUT_DIR}/command-raw.tsv"

run_timed() {
  local scenario="$1"
  local sample="$2"
  local repetition="$3"
  shift 3
  local log="${OUTPUT_DIR}/logs/${scenario}-${sample}-${repetition}.log"
  /usr/bin/time -lp "$@" > "${log}" 2>&1
  local exit_code=$?
  local real_seconds
  local user_seconds
  local system_seconds
  local max_rss_raw
  real_seconds="$(awk '$1 == "real" { print $2; exit }' "${log}")"
  user_seconds="$(awk '$1 == "user" { print $2; exit }' "${log}")"
  system_seconds="$(awk '$1 == "sys" { print $2; exit }' "${log}")"
  max_rss_raw="$(awk '$2 == "maximum" && $3 == "resident" { print $1; exit }' "${log}")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${scenario}" "${sample}" "${repetition}" "${exit_code}" \
    "${real_seconds:-unknown}" "${user_seconds:-unknown}" "${system_seconds:-unknown}" \
    "${max_rss_raw:-unknown}" "${log#${REPO_ROOT}/}" >> "${OUTPUT_DIR}/command-raw.tsv"
}

for repetition in $(seq 1 "${REPETITIONS}"); do
  sample="warm"
  if [[ "${repetition}" == "1" ]]; then
    sample="cold"
  fi
  run_timed python-unit "${sample}" "${repetition}" \
    integrations/scrapling/.venv/bin/python -m unittest discover \
    -s integrations/scrapling/tests -v
  run_timed targeted-vitest "${sample}" "${repetition}" \
    npx vitest run \
    src/core/company-orchestrator.test.ts \
    src/server/routes/web-scraping.test.ts
  run_timed typescript-typecheck "${sample}" "${repetition}" \
    npx tsc --noEmit
done

/usr/bin/time -lp env \
  "DOTENV_CONFIG_QUIET=true" \
  "BENCH_REPETITIONS=${REPETITIONS}" \
  "BENCH_ITERATIONS=${ITERATIONS}" \
  node --import tsx "${SCRIPT_DIR}/route-benchmark.ts" \
  > "${OUTPUT_DIR}/scenario-raw.jsonl" \
  2> "${OUTPUT_DIR}/logs/scenario-benchmark.log"
scenario_exit_code=$?
printf 'scenario-benchmark\tcombined\t1\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "${scenario_exit_code}" \
  "$(awk '$1 == "real" { print $2; exit }' "${OUTPUT_DIR}/logs/scenario-benchmark.log")" \
  "$(awk '$1 == "user" { print $2; exit }' "${OUTPUT_DIR}/logs/scenario-benchmark.log")" \
  "$(awk '$1 == "sys" { print $2; exit }' "${OUTPUT_DIR}/logs/scenario-benchmark.log")" \
  "$(awk '$2 == "maximum" && $3 == "resident" { print $1; exit }' "${OUTPUT_DIR}/logs/scenario-benchmark.log")" \
  "${OUTPUT_DIR#${REPO_ROOT}/}/logs/scenario-benchmark.log" >> "${OUTPUT_DIR}/command-raw.tsv"

snapshot > "${OUTPUT_DIR}/snapshot-after.sha256"
if ! cmp -s "${OUTPUT_DIR}/snapshot-before.sha256" "${OUTPUT_DIR}/snapshot-after.sha256"; then
  diff -u "${OUTPUT_DIR}/snapshot-before.sha256" "${OUTPUT_DIR}/snapshot-after.sha256" \
    > "${OUTPUT_DIR}/snapshot-drift.diff"
  echo "scoped source changed during benchmark; results are invalid" >&2
  exit 3
fi

failure_count="$(awk -F '\t' 'NR > 1 && $4 != 0 { failures += 1 } END { print failures + 0 }' \
  "${OUTPUT_DIR}/command-raw.tsv")"
if [[ "${failure_count}" != "0" ]]; then
  echo "${failure_count} benchmark command(s) failed; inspect raw logs" >&2
  exit 1
fi

printf 'BASELINE_RUN_COMPLETE output=%s\n' "${OUTPUT_DIR}"
