#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/tests/work-reports.mjs';
let text = readFileSync(path, 'utf8');
text = text.replace(
  /assert\.equal\(serialized\.includes\(secret\), false, \\`\\$\{secret\} must be redacted from JSON, Markdown, and index\\`\);/,
  'assert.equal(serialized.includes(secret), false, `${secret} must be redacted from JSON, Markdown, and index`);',
);
text = text.replace(
  'assert.equal((await stat(indexed.path)).mode & 0o600);',
  'assert.equal((await stat(indexed.path)).mode & 0o777, 0o600);',
);
writeFileSync(path, text);
console.log('fixed remaining test issues');
