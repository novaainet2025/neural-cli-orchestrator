#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/tests/work-reports.mjs';
let text = readFileSync(path, 'utf8');
text = text.replace(
  `'captures', 'coreKnowledge', 'domain', 'duration', 'error', 'goal', 'id', 'kind', 'path',`,
  `'captures', 'coreKnowledge', 'domain', 'duration', 'error', 'goal', 'id', 'kind', 'obsidianPath', 'path',`,
);
writeFileSync(path, text);
console.log('added obsidianPath to expected keys');
