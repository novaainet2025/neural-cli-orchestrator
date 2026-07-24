import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const lifecycle = JSON.parse(readFileSync('.tmp-lifecycle-verify.json', 'utf8'));
const ev = lifecycle.events.find((e) => e.id === 'tle_Ka6JnpUXkSxhQ1Y8');
console.log('=== LIFECYCLE tle_Ka6JnpUXkSxhQ1Y8 ===');
console.log(JSON.stringify(ev, null, 2));

const cmds = [
  ['tsc', 'npx tsc --noEmit'],
  ['vitest', 'npx vitest run src/core/team-scorer.test.ts'],
  ['build', 'npm run build'],
];
for (const [name, cmd] of cmds) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`=== ${name.toUpperCase()} exit:0 ===`);
    console.log(out.split('\n').slice(-8).join('\n'));
  } catch (e) {
    console.log(`=== ${name.toUpperCase()} exit:${e.status} ===`);
    console.log((e.stdout || '').split('\n').slice(-8).join('\n'));
    console.log((e.stderr || '').split('\n').slice(-8).join('\n'));
  }
}
