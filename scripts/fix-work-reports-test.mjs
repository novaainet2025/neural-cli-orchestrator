#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/tests/work-reports.mjs';
let text = readFileSync(path, 'utf8');
text = text.replace(
  String.raw`  const serialized = \`\${JSON.stringify(persisted)}\\n\${markdown}\\n\${JSON.stringify(index)}\`;`,
  '  const serialized = `${JSON.stringify(persisted)}\\n${markdown}\\n${JSON.stringify(index)}`;',
);
text = text.replace(
  String.raw`    assert.equal(serialized.includes(secret), false, \`\${secret} must be redacted from JSON, Markdown, and index\`);`,
  "    assert.equal(serialized.includes(secret), false, `${secret} must be redacted from JSON, Markdown, and index`);",
);
writeFileSync(path, text);
console.log('fixed work-reports.mjs escapes');
