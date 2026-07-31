#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORE = join(homedir(), '.nco-cli-ext');
const bridgeUrl = process.env.NCO_BRIDGE_URL || (await readFile(join(STORE, 'bridge-url'), 'utf8')).trim();
const bridgeToken = process.env.NCO_BRIDGE_TOKEN || (await readFile(join(STORE, 'bridge-token'), 'utf8')).trim();
const cli = '/Users/nova-ai/project/nova-use/bin/nco-browser.mjs';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, NCO_BRIDGE_URL: bridgeUrl, NCO_BRIDGE_TOKEN: bridgeToken },
      cwd: '/Users/nova-ai/project/nova-use',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, args }));
    child.on('error', reject);
  });
}

const steps = [
  ['status'],
  ['navigate', 'https://iq-test.us/'],
  ['analyze'],
];

for (const args of steps) {
  console.log(`\n=== node nco-browser.mjs ${args.join(' ')} ===`);
  const result = await run(args);
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.log(`EXIT_CODE=${result.code}`);
  if (result.code !== 0) process.exit(result.code);
}
