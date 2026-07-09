/**
 * Nova Government — Founding Citizens Seeder
 * 창립 시민 10명 DID 등록
 *
 * 실행: npx tsx src/identity/seedFoundingCitizens.ts
 */

import { generateKeyPair, deriveDidFromPublicKey } from './keyManager.js';
import { registerCitizen, getCitizen } from './credentialService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('founding-citizens');

const FOUNDING_CITIZENS = [
  { name: 'opencode',    role: 'Architect',      didSuffix: 'opencode-001' },
  { name: 'codex',       role: 'Engineer',        didSuffix: 'codex-001' },
  { name: 'cursor-agent',role: 'Reviewer',        didSuffix: 'cursor-agent-001' },
  { name: 'agy',         role: 'Designer',        didSuffix: 'agy-001' },
  { name: 'copilot',     role: 'Researcher',      didSuffix: 'copilot-001' },
  { name: 'mlx',         role: 'Engineer',        didSuffix: 'mlx-001' },
  { name: 'nvidia',      role: 'Reasoner',        didSuffix: 'nvidia-001' },
  { name: 'higgsfield',  role: 'Media',           didSuffix: 'higgsfield-001' },
  { name: 'hermes',      role: 'ToolUser',        didSuffix: 'hermes-001' },
  { name: 'openclaw',    role: 'BrowserAgent',    didSuffix: 'openclaw-001' },
] as const;

async function seedFoundingCitizens() {
  log.info('Seeding Nova Government founding citizens...');

  const results: { name: string; did: string; status: string }[] = [];

  for (const citizen of FOUNDING_CITIZENS) {
    const kp = await generateKeyPair();
    const did = deriveDidFromPublicKey(kp.publicKey);

    // 이미 등록된 경우 스킵
    const existing = getCitizen(did);
    if (existing) {
      log.info({ name: citizen.name, did }, 'Already registered, skipping');
      results.push({ name: citizen.name, did, status: 'existing' });
      continue;
    }

    try {
      const registered = registerCitizen({
        did,
        publicKey: kp.publicKey,
        name: citizen.name,
        role: citizen.role,
      });
      log.info({ name: citizen.name, did: registered.did }, 'Registered');
      results.push({ name: citizen.name, did: registered.did, status: 'created' });
    } catch (err) {
      log.error({ name: citizen.name, err }, 'Failed to register');
      results.push({ name: citizen.name, did: '(failed)', status: 'error' });
    }
  }

  log.info({ results }, 'Founding citizens seeded');
  console.log('\n=== Nova Government Founding Citizens ===');
  results.forEach((r) => {
    console.log(`${r.status === 'created' ? '✅' : r.status === 'existing' ? '⏭️' : '❌'} ${r.name}: ${r.did}`);
  });
}

seedFoundingCitizens().catch(console.error);
