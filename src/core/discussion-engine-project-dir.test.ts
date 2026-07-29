import { describe, expect, it } from 'vitest';

import { resolveDiscussionProjectDir } from './discussion-engine.js';
import { env } from '../utils/config.js';

describe('discussion project directory propagation', () => {
  it('prefers the caller task project directory over the NCO process directory', () => {
    expect(resolveDiscussionProjectDir({ projectDir: ' /workspace/nova-cli ' }))
      .toBe('/workspace/nova-cli');
  });

  it('falls back to the configured NCO project directory only when absent', () => {
    expect(resolveDiscussionProjectDir({})).toBe(env.PROJECT_DIR);
  });
});
