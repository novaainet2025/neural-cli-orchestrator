#!/usr/bin/env bash
set -u

# Reproducible baseline harness for the cli-extensions -> nova-use browser-control
# port. The first repetition is "cold" (fresh process); later repetitions are
# "warm". Filesystem caches are deliberately not purged because that would
# require elevated privileges and would make the run unsafe to reproduce.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NCO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NOVA_USE_DIR="/Users/nova-ai/project/nova-use"
CLI_EXT_DIR="/Users/nova-ai/project/크롬확장프로그램/cli-extensions"
BENCH_REPETITIONS="${BENCH_REPETITIONS:-3}"
BENCH_OUTPUT_DIR="${BENCH_OUTPUT_DIR:-$NCO_DIR/docs/plans/browser-control-benchmark-$(date +%Y%m%dT%H%M%S)}"
RAW_FILE="$BENCH_OUTPUT_DIR/raw.tsv"
SUMMARY_FILE="$BENCH_OUTPUT_DIR/baseline-summary.md"
LOG_DIR="$BENCH_OUTPUT_DIR/logs"
RUNNER_BIN="$BENCH_OUTPUT_DIR/benchmark-runner"
NOVA_USE_RUN_DIR="$(mktemp -d /private/tmp/nova-use-browser-bench.XXXXXX)"
CLI_EXT_RUN_ROOT="$(mktemp -d /private/tmp/cli-extension-browser-bench.XXXXXX)"
CLI_EXT_RUN_DIR="$CLI_EXT_RUN_ROOT/extension"

if ! [[ "$BENCH_REPETITIONS" =~ ^[2-9][0-9]*$ ]]; then
  echo "BENCH_REPETITIONS must be an integer >= 2" >&2
  exit 2
fi

if [[ -e "$RAW_FILE" || -e "$SUMMARY_FILE" ]]; then
  echo "Refusing to overwrite an existing benchmark run: $BENCH_OUTPUT_DIR" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
cc -O2 -Wall -Wextra -o "$RUNNER_BIN" "$SCRIPT_DIR/benchmark-runner.c"

# electron-vite writes a transient bundled config beside its config file.
# The managed workspace is read-only for nova-use, so benchmark an isolated,
# source-equivalent mirror while sharing the already-installed dependencies.
for nova_file in \
  package.json \
  package-lock.json \
  electron.vite.config.ts \
  vitest.config.ts \
  tsconfig.json \
  tsconfig.node.json \
  tsconfig.web.json; do
  if [[ -f "$NOVA_USE_DIR/$nova_file" ]]; then
    cp "$NOVA_USE_DIR/$nova_file" "$NOVA_USE_RUN_DIR/$nova_file"
  fi
done
for nova_dir in src tests bin resources; do
  if [[ -d "$NOVA_USE_DIR/$nova_dir" ]]; then
    cp -R "$NOVA_USE_DIR/$nova_dir" "$NOVA_USE_RUN_DIR/$nova_dir"
  fi
done
ln -s "$NOVA_USE_DIR/node_modules" "$NOVA_USE_RUN_DIR/node_modules"

# The extension build replaces dist files, so it receives the same isolated
# treatment instead of mutating the source worktree.
mkdir -p "$CLI_EXT_RUN_DIR"
for extension_file in package.json package-lock.json tsconfig.json manifest.json; do
  cp "$CLI_EXT_DIR/extension/$extension_file" "$CLI_EXT_RUN_DIR/$extension_file"
done
for extension_dir in src scripts public; do
  cp -R "$CLI_EXT_DIR/extension/$extension_dir" "$CLI_EXT_RUN_DIR/$extension_dir"
done
cp -R "$CLI_EXT_DIR/shared" "$CLI_EXT_RUN_ROOT/shared"
cp "$CLI_EXT_DIR/THIRD_PARTY_NOTICES.md" "$CLI_EXT_RUN_ROOT/THIRD_PARTY_NOTICES.md"
ln -s "$CLI_EXT_DIR/extension/node_modules" "$CLI_EXT_RUN_DIR/node_modules"

printf 'project\tscenario\tphase\trepetition\texit_code\twall_s\tuser_s\tsys_s\tcpu_pct\tmax_rss_kb\tlog\n' > "$RAW_FILE"

measure() {
  local project_label="$1"
  local scenario="$2"
  local repetition="$3"
  local workdir="$4"
  local command="$5"
  local phase="warm"
  local safe_scenario
  local log_file
  local time_file
  local exit_code
  local wall_s
  local user_s
  local sys_s
  local cpu_pct
  local max_rss_kb

  if [[ "$repetition" -eq 1 ]]; then
    phase="cold"
  fi

  safe_scenario="${scenario//[^a-zA-Z0-9_-]/_}"
  log_file="$LOG_DIR/${project_label}-${safe_scenario}-${phase}-${repetition}.log"
  time_file="$LOG_DIR/${project_label}-${safe_scenario}-${phase}-${repetition}.time"

  (
    cd "$workdir" || exit 125
    "$RUNNER_BIN" /bin/zsh -fc "$command"
  ) > "$log_file" 2> "$time_file"
  exit_code=$?

  wall_s="$(awk '$1=="bench_wall_s" {print $2; exit}' "$time_file")"
  user_s="$(awk '$1=="bench_user_s" {print $2; exit}' "$time_file")"
  sys_s="$(awk '$1=="bench_sys_s" {print $2; exit}' "$time_file")"
  max_rss_kb="$(awk '$1=="bench_max_rss_kb" {print $2; exit}' "$time_file")"
  wall_s="${wall_s:-0}"
  user_s="${user_s:-0}"
  sys_s="${sys_s:-0}"
  max_rss_kb="${max_rss_kb:-0}"
  cpu_pct="$(awk -v u="$user_s" -v s="$sys_s" -v w="$wall_s" 'BEGIN {if (w>0) printf "%.1f", ((u+s)/w)*100; else print "0.0"}')"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$project_label" "$scenario" "$phase" "$repetition" "$exit_code" \
    "$wall_s" "$user_s" "$sys_s" "$cpu_pct" "$max_rss_kb" \
    "${log_file#$NCO_DIR/}" >> "$RAW_FILE"

  printf '%-14s %-24s %-4s/%-4s exit=%-3s wall=%7ss rss=%8sKB\n' \
    "$project_label" "$scenario" "$repetition" "$BENCH_REPETITIONS" \
    "$exit_code" "$wall_s" "$max_rss_kb"
}

run_scenario() {
  local project_label="$1"
  local scenario="$2"
  local workdir="$3"
  local command="$4"
  local repetition

  for repetition in $(seq 1 "$BENCH_REPETITIONS"); do
    measure "$project_label" "$scenario" "$repetition" "$workdir" "$command"
  done
}

run_scenario \
  "nco" \
  "build-typecheck" \
  "$NCO_DIR" \
  "npm run build"
run_scenario \
  "nco" \
  "representative-tests" \
  "$NCO_DIR" \
  "npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts"

run_scenario \
  "nova-use" \
  "build" \
  "$NOVA_USE_RUN_DIR" \
  "npm run build"
run_scenario \
  "nova-use" \
  "browser-port-tests" \
  "$NOVA_USE_RUN_DIR" \
  "npx vitest run --configLoader runner tests/agent-browser-adapter.spec.ts tests/browser.spec.ts tests/browser-consent.spec.ts tests/agent-control.spec.ts"

run_scenario \
  "cli-extensions" \
  "extension-build" \
  "$CLI_EXT_RUN_DIR" \
  "npm run build"
run_scenario \
  "cli-extensions" \
  "browser-contracts" \
  "$CLI_EXT_DIR" \
  "node tests/performance-contract.mjs && node tests/enhanced-snapshot-contract.mjs && node tests/action-surface.mjs && node tests/repeat-guard.mjs && node tests/shared-learning.mjs"

{
  echo "# Browser-control port benchmark baseline"
  echo
  echo "- Measured at: $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "- Host: $(uname -m), $(uname -sr)"
  echo "- Node: $(node --version); npm: $(npm --version)"
  echo "- Repetitions: $BENCH_REPETITIONS (first=fresh-process cold; remaining=warm)"
  echo "- Cache policy: dependency and OS caches retained; no privileged cache purge"
  echo "- Statistics: warm arithmetic mean/min/max; throughput=warm runs / warm wall seconds"
  echo "- Raw units: wall/user/sys seconds, CPU percent=(user+sys)/wall, max RSS KiB"
  echo "- nova-use execution: isolated source mirror at \`$NOVA_USE_RUN_DIR\` with read-only dependency symlink"
  echo "- cli-extensions build: isolated source mirror at \`$CLI_EXT_RUN_DIR\` with read-only dependency symlink"
  echo
  echo "## Source revisions"
  echo
  echo "| Project | Commit SHA | Dirty tracked | Untracked |"
  echo "|---|---|---:|---:|"
  for project_entry in \
    "nco|$NCO_DIR" \
    "nova-use|$NOVA_USE_DIR" \
    "cli-extensions|$CLI_EXT_DIR"; do
    project_label="${project_entry%%|*}"
    project_dir="${project_entry#*|}"
    commit_sha="$(git -C "$project_dir" rev-parse HEAD)"
    tracked_count="$(git -C "$project_dir" status --porcelain=v1 | awk 'substr($0,1,2)!="??"{n++} END{print n+0}')"
    untracked_count="$(git -C "$project_dir" status --porcelain=v1 | awk 'substr($0,1,2)=="??"{n++} END{print n+0}')"
    echo "| $project_label | \`$commit_sha\` | $tracked_count | $untracked_count |"
  done
  echo
  echo "Dirty counts are captured to prevent confusing this working-tree baseline with a clean-commit result."
  echo
  echo "## Scenario commands"
  echo
  echo "| Project | Scenario | Command | Regression-sensitive signal |"
  echo "|---|---|---|---|"
  echo '| nco | build-typecheck | `npm run build` | TypeScript errors, build latency, `dist/` size |'
  echo '| nco | representative-tests | `npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts` | orchestration safety/response-quality pass rate |'
  echo '| nova-use | build | `npm run build` | Electron main/preload/renderer build latency and `out/` size |'
  echo '| nova-use | browser-port-tests | `npx vitest run --configLoader runner tests/agent-browser-adapter.spec.ts tests/browser.spec.ts tests/browser-consent.spec.ts tests/agent-control.spec.ts` | browser adapter, FORCE/CDP, consent, autonomous-control regressions |'
  echo '| cli-extensions | extension-build | `(cd extension && npm run build)` | Chrome extension type/build regressions and `extension/dist/` size |'
  echo '| cli-extensions | browser-contracts | `node tests/performance-contract.mjs && node tests/enhanced-snapshot-contract.mjs && node tests/action-surface.mjs && node tests/repeat-guard.mjs && node tests/shared-learning.mjs` | source capability, enhanced snapshot, repeat guard and learning contracts |'
  echo
  echo "## Results"
  echo
  echo "| Project | Scenario | Cold s | Warm mean s | Warm min/max s | Throughput runs/s | Success | Error | Mean CPU % | Peak RSS KiB |"
  echo "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  tail -n +2 "$RAW_FILE" | awk -F '\t' '
    {
      key=$1 SUBSEP $2
      project[key]=$1
      scenario[key]=$2
      total[key]++
      if ($5==0) passed[key]++
      if ($3=="cold") cold[key]=$6
      if ($3=="warm") {
        warm_n[key]++
        warm_sum[key]+=$6
        cpu_sum[key]+=$9
        if (!(key in warm_min) || $6<warm_min[key]) warm_min[key]=$6
        if (!(key in warm_max) || $6>warm_max[key]) warm_max[key]=$6
      }
      if ($10>rss_peak[key]) rss_peak[key]=$10
      order[++order_n]=key
    }
    END {
      for (i=1; i<=order_n; i++) {
        key=order[i]
        if (seen[key]++) continue
        wn=warm_n[key]
        ws=warm_sum[key]
        mean=(wn ? ws/wn : 0)
        throughput=(ws ? wn/ws : 0)
        success=(total[key] ? 100*passed[key]/total[key] : 0)
        error=100-success
        cpu=(wn ? cpu_sum[key]/wn : 0)
        printf "| %s | %s | %.3f | %.3f | %.3f/%.3f | %.3f | %.1f%% | %.1f%% | %.1f | %.0f |\n", project[key], scenario[key], cold[key], mean, warm_min[key], warm_max[key], throughput, success, error, cpu, rss_peak[key]
      }
    }'
  echo
  echo "### Build artifact sizes"
  echo
  echo "| Project | Artifact | KiB |"
  echo "|---|---|---:|"
  for size_entry in \
    "nco|dist|$NCO_DIR/dist" \
    "nova-use|out|$NOVA_USE_RUN_DIR/out" \
    "cli-extensions|extension/dist|$CLI_EXT_RUN_DIR/dist"; do
    project_label="${size_entry%%|*}"
    size_rest="${size_entry#*|}"
    artifact_label="${size_rest%%|*}"
    artifact_dir="${size_rest#*|}"
    if [[ -d "$artifact_dir" ]]; then
      artifact_kib="$(du -sk "$artifact_dir" | awk '{print $1}')"
      echo "| $project_label | \`$artifact_label/\` | $artifact_kib |"
    else
      echo "| $project_label | \`$artifact_label/\` | missing |"
    fi
  done
  echo
  echo "## Interpretation and gates"
  echo
  echo "- This run is a working-tree baseline, not a release benchmark; compare only against runs from the same host and protocol."
  echo "- Any non-zero exit, increased error rate, or missing build artifact is a hard regression."
  echo "- Latency/RSS alert threshold: >20% above this baseline on two consecutive same-protocol runs."
  echo "- Browser-port acceptance remains governed by the specification's full T1 suite; these focused scenarios are an early regression signal, not a substitute."
  echo
  echo "## Raw evidence"
  echo
  echo "- Machine-readable measurements: \`raw.tsv\`"
  echo "- Per-run stdout: \`logs/*.log\`"
  echo "- Per-run timing/RSS and stderr: \`logs/*.time\`"
  echo "- Reproduction: \`BENCH_REPETITIONS=$BENCH_REPETITIONS BENCH_OUTPUT_DIR=<new-empty-path> scripts/run-benchmark.sh\`"
} > "$SUMMARY_FILE"

echo "Summary: $SUMMARY_FILE"
echo "Raw data: $RAW_FILE"

if awk -F '\t' 'NR>1 && $5!=0 {bad=1} END{exit bad}' "$RAW_FILE"; then
  exit 0
fi

echo "One or more benchmark commands failed; see raw.tsv and logs." >&2
exit 1
