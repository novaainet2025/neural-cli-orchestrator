import { describe, expect, it } from 'vitest';
import { buildScraplingEnvironment } from './webScrapingService.js';

describe('buildScraplingEnvironment', () => {
  it('passes runtime necessities and strips server credentials', () => {
    const environment = buildScraplingEnvironment({
      PATH: '/usr/bin',
      HOME: '/tmp/operator',
      NCO_SCRAPLING_ENABLE_STEALTH: '1',
      NCO_API_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
    });

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/operator',
      PYTHONUNBUFFERED: '1',
      NCO_SCRAPLING_ENABLE_STEALTH: '1',
    });
    expect(environment).not.toHaveProperty('NCO_API_TOKEN');
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

