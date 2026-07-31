#!/usr/bin/env node
/**
 * Regression guard: baseline (team-runner output) vs current (oejeon work report).
 * Producer: optimization-monitor (independent of actor "ax-docs-agent").
 */
import { runChecks } from "./content-checks.mjs";

const base = runChecks(new URL("./work-output.md", import.meta.url).pathname);
const cur = runChecks(new URL("./ax-docs-work-report-20260730-am.md", import.meta.url).pathname);

const baseMap = new Map(base.checks.map(c => [c.id, c.pass]));
const regressions = cur.checks.filter(c => !c.pass && baseMap.get(c.id) === true).map(c => c.id);

const metrics = [
  { name: "content-quality-checks", baseline: base.passedChecks, current: cur.passedChecks, direction: "higher_is_better" },
  { name: "visible-characters", baseline: base.visibleCharacters, current: cur.visibleCharacters, direction: "higher_is_better" },
];
const deltas = metrics.map(m => ({ ...m, delta: m.current - m.baseline }));

const guard = {
  guard: "ax-docs-report-regression-guard",
  regressions,
  regressionGuardPassed: regressions.length === 0 && deltas.every(d => d.delta >= 0) && deltas.some(d => d.delta > 0),
  metrics: deltas,
};
process.stdout.write(JSON.stringify(guard, null, 2) + "\n");
process.exit(guard.regressionGuardPassed ? 0 : 1);
