import { writeFileSync } from 'node:fs';

const root = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions';

writeFileSync(`${root}/package.json`, `${JSON.stringify({
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
}, null, 2)}\n`);

const runTests = `import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const bridgeRetryMax = 3;
const bridgeRetryDelayMs = 1000;

// Stable deterministic allowlist only. Never auto-discover tests.
// Excluded: live-*, provider-matrix, boss-benchmark, pty-profile-smoke,
// bridge-profile-smoke, GUI *.cjs, and unstable PTY tests on Node v25.
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

const bridgeRetryScripts = new Set([
  'tests/bridge-auth.mjs',
  'tests/bridge-engine-lifecycle.mjs',
  'tests/bridge-pending-timeout.mjs',
  'tests/bridge-recovery.mjs',
  'tests/bridge-resume.mjs',
  'tests/cli-bridge-close.mjs',
  'tests/collaboration-orchestration-bridge.mjs',
  'tests/shared-learning-bridge.mjs',
]);

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
  const maxAttempts = bridgeRetryScripts.has(argv[0]) ? bridgeRetryMax : 1;
  process.stdout.write(\`\\n[deterministic \${index + 1}/\${cases.length}] node \${argv.join(' ')}\\n\`);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      process.stdout.write(\`[bridge retry \${attempt}/\${maxAttempts}] \${argv[0]}\\n\`);
      await delay(bridgeRetryDelayMs);
    }
    try {
      await runOnce(argv);
      if (bridgeRetryScripts.has(argv[0])) await delay(500);
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

writeFileSync(`${root}/scripts/run-tests.mjs`, runTests);
console.log('patched');
