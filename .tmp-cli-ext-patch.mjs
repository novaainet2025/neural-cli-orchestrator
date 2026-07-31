import { readFileSync, writeFileSync } from 'node:fs';

const root = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions';

const pkg = {
  name: 'nco-cli-extensions',
  version: '0.1.0',
  private: true,
  type: 'module',
  engines: { node: '>=20' },
  packageManager: 'npm@11.12.1',
  scripts: {
    typecheck: 'npm --prefix extension exec -- tsc -p extension/tsconfig.json --noEmit',
    test: 'node scripts/run-tests.mjs',
    'test:browser': 'node scripts/run-browser-tests.mjs',
    build: 'npm --prefix extension run build && node scripts/verify-build.mjs',
    'release:check': 'npm run typecheck && npm test && npm run build',
  },
  devDependencies: { playwright: '1.61.1' },
};
writeFileSync(`${root}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

const runTests = `import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const maxAttempts = Math.max(1, Number(process.env.NCO_TEST_MAX_ATTEMPTS || 3) || 3);
const retryDelayMs = Math.max(0, Number(process.env.NCO_TEST_RETRY_DELAY_MS || 1000) || 1000);

// Keep this list explicit: live-provider, benchmark, and GUI tests must never
// enter the deterministic release gate by being accidentally discovered.
const cases = [
  ['tests/action-surface.mjs'],
  ['tests/bridge-auth.mjs'],
  ['tests/bridge-engine-lifecycle.mjs'],
  ['tests/bridge-pending-timeout.mjs'],
  ['tests/bridge-recovery.mjs'],
  ['tests/bridge-resume.mjs'],
  ['tests/capture-overlay-contract.mjs'],
  ['tests/cli-bridge-close.mjs'],
  ['tests/cli-timeout-policy.mjs'],
  ['tests/collaboration-orchestration-bridge.mjs'],
  ['tests/command-profile-contract.mjs'],
  ['tests/control-contract.mjs'],
  ['tests/enhanced-snapshot-contract.mjs'],
  ['tests/enhanced-snapshot-controller.mjs'],
  ['tests/install-daemon-plist.mjs'],
  ['tests/learning-integration-contract.mjs'],
  ['tests/mcp-runtime-contract.mjs'],
  ['tests/nco-browser-page-contract.mjs'],
  ['tests/nco-client-performance.mjs'],
  ['tests/orchestration-contract.mjs'],
  ['tests/performance-contract.mjs'],
  ['tests/playwright-loader.mjs'],
  ['tests/power-management-contract.mjs'],
  ['tests/pty-inter-session-env.mjs'],
  ['tests/pty-kill-escalation.mjs'],
  ['tests/repeat-guard.mjs'],
  ['tests/request-limits.mjs'],
  ['tests/shared-learning-bridge.mjs'],
  ['tests/shared-learning.mjs'],
  ['tests/sidepanel-goal-policy.mjs'],
  ['tests/sidepanel-input-safety.mjs'],
  ['tests/sidepanel-recovery-contract.mjs'],
  ['tests/task-result-correlation.mjs'],
  ['tests/work-reports-bridge.mjs'],
  ['tests/work-reports-panel.mjs'],
  ['tests/work-reports-performance.mjs'],
  ['tests/work-reports.mjs'],
];

const runOnce = (argv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, argv, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(\`\${argv[0]} failed (\${signal || \`exit \${String(code)}\`})\`));
  });
});

const run = async (argv, index) => {
  process.stdout.write(\`\\n[deterministic \${index + 1}/\${cases.length}] node \${argv.join(' ')}\\n\`);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      process.stdout.write(\`[retry \${attempt}/\${maxAttempts}] \${argv[0]}\\n\`);
      await delay(retryDelayMs);
    }
    try {
      await runOnce(argv);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

for (const [index, argv] of cases.entries()) {
  await run(argv, index);
}

console.log(\`\\nDeterministic release tests passed: \${cases.length}/\${cases.length}\`);
`;

const runBrowserTests = `import { spawn } from 'node:child_process';
import process from 'node:process';

const root = new URL('../', import.meta.url);
const cases = [
  'tests/browser-analysis.cjs',
  'tests/procurement-application-dry-run.cjs',
  'tests/sidepanel-token-mismatch.cjs',
  'tests/sidepanel-token-rotation-active.cjs',
  'tests/multiwindow.cjs',
  'tests/browser-control-hardest.cjs',
  'tests/sidepanel-controls.cjs',
  'tests/product-manual-screenshots.cjs',
];

const run = (script, index) => new Promise((resolve, reject) => {
  process.stdout.write(\`\\n[browser \${index + 1}/\${cases.length}] node \${script}\\n\`);
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      NCO_PROCUREMENT_HEADED: process.env.NCO_PROCUREMENT_HEADED || '0',
    },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(\`\${script} failed (\${signal || \`exit \${String(code)}\`})\`));
  });
});

for (const [index, script] of cases.entries()) {
  await run(script, index);
}

console.log(\`\\nBrowser release tests passed: \${cases.length}/\${cases.length}\`);
`;

writeFileSync(`${root}/scripts/run-tests.mjs`, runTests);
writeFileSync(`${root}/scripts/run-browser-tests.mjs`, runBrowserTests);
console.log('patched');
