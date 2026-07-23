#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: npm run triad:certify -- <paired-receipts.json>');
  process.exit(2);
}

const absoluteInput = resolve(inputPath);
const payload = JSON.parse(await readFile(absoluteInput, 'utf8'));
if (!Array.isArray(payload.baseline) || !Array.isArray(payload.candidate)) {
  console.error('receipt file must contain baseline[] and candidate[]');
  process.exit(2);
}

const moduleUrl = pathToFileURL(resolve('dist/core/triad-policy.js')).href;
const { certifyEfficiencyRuns } = await import(moduleUrl);
const certification = certifyEfficiencyRuns(payload.baseline, payload.candidate);

console.log(JSON.stringify({
  input: absoluteInput,
  claimPolicy: 'measure-not-promise',
  certification,
}, null, 2));

process.exit(certification.certified ? 0 : 1);
