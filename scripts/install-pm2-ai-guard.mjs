#!/usr/bin/env node

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'NCO_PM2_AI_GUARD';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const guardPath = resolve(scriptDir, 'pm2-ai-mutation-guard.cjs');
const pm2Entry = resolve(process.env.NCO_PM2_ENTRY || '/opt/homebrew/lib/node_modules/pm2/bin/pm2');
const mode = process.argv[2] || 'install';

function guardLine() {
  return `require(${JSON.stringify(guardPath)}).enforce(process.argv.slice(2)); // ${MARKER}`;
}

async function readEntry() {
  const content = await readFile(pm2Entry, 'utf8');
  if (!content.startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`unexpected PM2 entry format: ${pm2Entry}`);
  }
  return content;
}

async function replaceAtomically(content) {
  const metadata = await stat(pm2Entry);
  const temporary = `${pm2Entry}.nco-guard-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: metadata.mode });
  await chmod(temporary, metadata.mode);
  await rename(temporary, pm2Entry);
}

async function install() {
  const content = await readEntry();
  if (content.includes(MARKER)) {
    console.log(`PM2 AI guard already installed: ${pm2Entry}`);
    return;
  }
  const newline = content.indexOf('\n');
  const updated = `${content.slice(0, newline + 1)}\n${guardLine()}\n${content.slice(newline + 1)}`;
  await replaceAtomically(updated);
  console.log(`PM2 AI guard installed: ${pm2Entry}`);
}

async function remove() {
  const content = await readEntry();
  const lines = content.split('\n').filter(line => !line.includes(MARKER));
  await replaceAtomically(lines.join('\n'));
  console.log(`PM2 AI guard removed: ${pm2Entry}`);
}

async function check() {
  const content = await readEntry();
  if (!content.includes(guardLine())) {
    throw new Error(`PM2 AI guard missing or stale: ${pm2Entry}`);
  }
  await readFile(guardPath, 'utf8');
  console.log(`PM2 AI guard verified: ${pm2Entry}`);
}

if (mode === 'install') await install();
else if (mode === 'remove') await remove();
else if (mode === 'check') await check();
else throw new Error(`unknown mode: ${mode} (expected install|remove|check)`);
