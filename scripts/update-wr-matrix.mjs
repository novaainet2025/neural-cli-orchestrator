#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/docs/feature-verification-matrix.md';
let text = readFileSync(path, 'utf8');

const new10 = '| WR-10 | Obsidian vault mirror + skills best-effort | PASS | `node tests/work-reports.mjs` | temp vaultPath only; real vault never written |';
const new11 = '| WR-11 | structured recall + portable queryWorkReports | PASS | `node tests/work-reports.mjs`, `node tests/shared-learning.mjs` | empty tokens → empty buckets; work_report_recall isolation |';

if (text.includes(new10) && text.includes(new11)) {
  console.log('WR-10/WR-11 already at requested text');
  process.exit(0);
}

const replacements = [
  ['| WR-10 | Obsidian 날짜별 미러·portable frontmatter | PASS | `node tests/work-reports.mjs` | 임시 vault의 `Nova Memory/browser/<date>`와 `nco.work-report.v1` 확인 |', new10],
  ['| WR-11 | NCO Browser Skills 성공·실패 지식과 idempotency | PASS | `node tests/work-reports.mjs` | domain 기술 문서, preflight, 검증 strategy, report marker 중복 방지 |', new11],
];

let changed = false;
for (const [oldRow, newRow] of replacements) {
  if (text.includes(oldRow)) {
    text = text.replace(oldRow, newRow);
    changed = true;
  }
}

if (!changed && !text.includes('| WR-10 | Obsidian vault mirror')) {
  const anchor = '| WR-09 |';
  const idx = text.indexOf('| WR-12 |');
  if (text.includes(anchor) && idx !== -1) {
    text = text.slice(0, idx) + new10 + '\n' + new11 + '\n' + text.slice(idx);
    changed = true;
  }
}

if (changed) {
  writeFileSync(path, text);
  console.log('updated WR-10 and WR-11');
} else {
  console.log('no doc changes needed');
}
